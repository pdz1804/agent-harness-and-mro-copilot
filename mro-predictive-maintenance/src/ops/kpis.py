"""Fleet reliability KPIs (MTBUR, removals/1000FH, UCL breach, live precision).

Mirrors the real reliability-program practice cited in
``reports/research-and-gap-analysis.md`` §4: track unscheduled-removal rate
per component type per quarter, flag a breach when the current quarter
exceeds mean + 2*sigma of the prior 4 quarters (Shewhart-style control
limit), and separately track the *outcome* of raised work orders (live
precision, NFF rate) -- this is the feedback loop that closes W10/W12 from
the gap analysis.

Pure functions over dataframes/rows so the "hand-computed on a tiny
fixture" test in phase-03 can call these directly with no database.
"""

from __future__ import annotations

import pandas as pd
from sqlalchemy import select
from sqlalchemy.engine import Connection

from src.ops.db import work_orders

QUARTERS_FOR_UCL = 4
UCL_SIGMA_MULTIPLIER = 2.0


def _quarter_key(dt: pd.Timestamp) -> str:
    return f"{dt.year}Q{dt.quarter}"


def component_type_quarterly_reliability(
    components_df: pd.DataFrame, aircraft_df: pd.DataFrame,
) -> pd.DataFrame:
    """Per (component_type, quarter): unscheduled removals, exposure FH,
    removals-per-1000FH, MTBUR, and whether the quarter breaches the UCL
    computed from its own prior 4 quarters.

    Exposure FH for a quarter = sum, over components of that type installed
    before quarter end and not yet removed before quarter start, of
    ``days_active_in_quarter * cycles_per_day * avg_flight_hours_per_cycle``
    -- i.e. actual fleet flight-hour exposure in that quarter, the
    denominator a real reliability program uses (MTBUR = fleet FH /
    unscheduled removals).
    """
    components = components_df.copy()
    components["install_date"] = pd.to_datetime(components["install_date"])
    components["removal_date"] = pd.to_datetime(components["removal_date"])

    aircraft = aircraft_df.set_index("aircraft_id")[["cycles_per_day", "avg_flight_hours_per_cycle"]]
    components = components.join(aircraft, on="aircraft_id")

    all_dates = pd.concat([
        components["install_date"], components["removal_date"].dropna(),
    ])
    if all_dates.empty:
        return pd.DataFrame(columns=[
            "component_type", "quarter", "unscheduled_removals", "exposure_fh",
            "removals_per_1000fh", "mtbur_fh", "ucl_removals_per_1000fh", "alert_level_breached",
        ])

    quarters = pd.period_range(all_dates.min(), all_dates.max(), freq="Q")

    records = []
    for component_type, group in components.groupby("component_type"):
        rows_by_quarter = []
        for period in quarters:
            q_start = period.start_time
            q_end = period.end_time
            days_in_quarter = (q_end - q_start).days + 1

            active_start = group["install_date"].clip(lower=q_start)
            removal_or_end = group["removal_date"].fillna(pd.Timestamp.max)
            active_end = removal_or_end.clip(upper=q_end)
            days_active = (active_end - active_start).dt.days + 1
            days_active = days_active.clip(lower=0)
            is_active = (group["install_date"] <= q_end) & (removal_or_end >= q_start)
            days_active = days_active.where(is_active, 0)

            daily_fh = group["cycles_per_day"] * group["avg_flight_hours_per_cycle"]
            exposure_fh = float((days_active * daily_fh).sum())

            unscheduled = group[
                (group["removal_type"] == "unscheduled")
                & (group["removal_date"] >= q_start)
                & (group["removal_date"] <= q_end)
            ]
            removals = int(len(unscheduled))
            removals_per_1000fh = (removals / exposure_fh * 1000.0) if exposure_fh > 0 else 0.0
            # None (not float("inf")) when there were no removals -- infinity
            # is not JSON-serializable and "no removals yet" is a distinct,
            # meaningful state from "very high MTBUR".
            mtbur_fh = (exposure_fh / removals) if removals > 0 else None

            rows_by_quarter.append({
                "component_type": component_type,
                "quarter": _quarter_key(q_start),
                "unscheduled_removals": removals,
                "exposure_fh": exposure_fh,
                "removals_per_1000fh": removals_per_1000fh,
                "mtbur_fh": mtbur_fh,
            })

        series = pd.Series([r["removals_per_1000fh"] for r in rows_by_quarter])
        for i, row in enumerate(rows_by_quarter):
            prior = series.iloc[max(0, i - QUARTERS_FOR_UCL):i]
            if len(prior) >= 2:
                ucl = float(prior.mean() + UCL_SIGMA_MULTIPLIER * prior.std(ddof=0))
            else:
                ucl = None
            row["ucl_removals_per_1000fh"] = ucl
            row["alert_level_breached"] = bool(ucl is not None and row["removals_per_1000fh"] > ucl)
            records.append(row)

    return pd.DataFrame.from_records(records)


def live_precision_and_nff(conn: Connection) -> dict:
    """Live precision (confirmed_failure / closed-with-outcome) and NFF rate,
    computed from actual work-order outcomes recorded in the ops store --
    the feedback loop W10 in the gap analysis (predicted removal -> WO ->
    finding -> KPI), not a static offline metric.
    """
    rows = conn.execute(
        select(work_orders.c.outcome).where(work_orders.c.outcome.is_not(None))
    ).scalars().all()
    total = len(rows)
    if total == 0:
        return {
            "closed_with_outcome": 0, "confirmed_failure": 0, "nff": 0, "not_inspected": 0,
            "live_precision": None, "nff_rate": None,
        }
    confirmed = sum(1 for o in rows if o == "confirmed_failure")
    nff = sum(1 for o in rows if o == "nff")
    not_inspected = sum(1 for o in rows if o == "not_inspected")
    inspected = confirmed + nff
    return {
        "closed_with_outcome": total,
        "confirmed_failure": confirmed,
        "nff": nff,
        "not_inspected": not_inspected,
        "live_precision": (confirmed / inspected) if inspected > 0 else None,
        "nff_rate": (nff / inspected) if inspected > 0 else None,
    }


def reliability_kpis(conn: Connection, components_df: pd.DataFrame, aircraft_df: pd.DataFrame) -> dict:
    quarterly = component_type_quarterly_reliability(components_df, aircraft_df)
    # NaN/Infinity are not JSON-serializable (FastAPI's default JSON encoder
    # rejects them outright) -- normalize to None, which is a meaningful
    # "not computable for this quarter" signal anyway (e.g. zero exposure).
    quarterly = quarterly.replace([float("inf"), float("-inf")], None)
    records = quarterly.to_dict(orient="records")
    for record in records:
        for key, value in record.items():
            if isinstance(value, float) and pd.isna(value):
                record[key] = None
    return {
        "quarterly": records,
        "live_outcomes": live_precision_and_nff(conn),
    }
