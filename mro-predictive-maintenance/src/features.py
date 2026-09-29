"""Build the model-ready table from the raw synthetic tables.

Joins ``cycle_snapshots`` (the prediction points) with static aircraft/
component attributes and point-in-time-correct rolling aggregates from the
``fault_codes`` and ``maintenance_events`` event logs.

Leakage discipline: every rolling aggregate for a snapshot at cycle ``c`` on
component ``k`` only looks at events with ``event_cycle < c`` (strictly
before) for that same component. The terminal removal event in
``maintenance_events`` is excluded outright, and only rows with
``event_type == "scheduled_check"`` feed the maintenance-history features
(``cycles_since_last_check`` / ``check_count_last_1500cyc``) -- this also
excludes the generator's "unscheduled_check" rows (symptom-triggered final
inspections injected just before an unscheduled removal, see
data/generate_dataset.py). Those are a *consequence* of the impending
removal, not a cause, so counting them would leak the label through
inspection-frequency instead of through sensor physics (see
docs/design-report.md section 7.1, "Leakage found and fixed"). Sensor
missingness is left as NaN on purpose -- imputation happens inside the
modeling pipeline (fit on the training fold only) rather than here, so it
cannot leak test-set statistics into training.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from . import config

FAULT_WINDOWS = [500, 1500]
CHECK_WINDOW = 1500


def _rolling_fault_features(snapshots: pd.DataFrame, faults: pd.DataFrame) -> pd.DataFrame:
    out = {f"fault_count_last_{w}cyc": np.zeros(len(snapshots), dtype=int) for w in FAULT_WINDOWS}
    out["max_severity_last_500cyc"] = np.zeros(len(snapshots), dtype=int)

    faults_by_component = {
        cid: grp.sort_values("cycle_at_fault")
        for cid, grp in faults.groupby("component_id")
    }

    for pos, (cid, cycle) in enumerate(zip(snapshots["component_id"], snapshots["cycle"])):
        grp = faults_by_component.get(cid)
        if grp is None or len(grp) == 0:
            continue
        cycles = grp["cycle_at_fault"].to_numpy()
        sev = grp["severity"].to_numpy()
        for w in FAULT_WINDOWS:
            mask = (cycles <= cycle) & (cycles > cycle - w)
            out[f"fault_count_last_{w}cyc"][pos] = int(mask.sum())
            if w == 500 and mask.any():
                out["max_severity_last_500cyc"][pos] = int(sev[mask].max())
    return pd.DataFrame(out, index=snapshots.index)


def _rolling_maintenance_features(snapshots: pd.DataFrame, maint: pd.DataFrame) -> pd.DataFrame:
    checks = maint[maint["event_type"] == "scheduled_check"]
    checks_by_component = {
        cid: grp.sort_values("cycle_at_event")["cycle_at_event"].to_numpy()
        for cid, grp in checks.groupby("component_id")
    }

    n = len(snapshots)
    cycles_since_last_check = np.zeros(n)
    check_count_window = np.zeros(n, dtype=float)

    # A snapshot row's OWN check_type matters, not just which prior events feed
    # the aggregate: a row that only exists because it IS a symptom-triggered
    # ("unscheduled_check") inspection has a cycle position chosen BECAUSE a
    # removal is imminent (see data/generate_dataset.py). Even restricting the
    # rolling window to prior scheduled_check events (above), subtracting from
    # such a row's own (label-caused) cycle still reconstructs a "time since
    # last check" that is systematically smaller than normal purely because of
    # *when this row was sampled*, not because of any legitimately-observable
    # signal -- i.e. the row's own placement, not just the counted events,
    # leaks the label.
    #
    # cycles_since_last_check gets the population-typical routine value
    # (config.ROUTINE_CHECK_INTERVAL_CYCLES) instead of NaN for those rows:
    # NaN would still leak, because a NaN-native model (e.g.
    # HistGradientBoostingClassifier) can treat "missing" itself as its own
    # split direction, and "missing" would then correlate near-perfectly with
    # label=1 (verified: permutation importance for cycles_since_last_check
    # was 0.75 with NaN-on-missing, versus <0.02 with this constant-fill).
    # A fixed, class-independent default removes the information rather than
    # re-encoding it as a different flag.
    #
    # check_count_last_1500cyc does NOT need the same treatment: it counts
    # scheduled_check events inside a trailing window, and shifting the
    # window's right edge by up to ~28 cycles (the max a symptom-triggered
    # row's own cycle can differ from the nearest real schedule point) very
    # rarely changes which events fall inside a 1500-cycle window, so it is
    # computed the normal way for every row -- verified NOT to reproduce the
    # leak (a fixed constant here was tried first and DID leak: permutation
    # importance for check_count_last_1500cyc hit 0.75, because a hard-coded
    # constant is itself a giveaway that legitimate history counts rarely hit
    # exactly). See docs/design-report.md section 7.1, "Leakage found and
    # fixed", for the full before/after story.
    own_check_type = (
        snapshots["check_type"].to_numpy() if "check_type" in snapshots.columns
        else np.full(n, "scheduled_check", dtype=object)
    )

    for pos, (cid, cycle, ctype) in enumerate(
        zip(snapshots["component_id"], snapshots["cycle"], own_check_type)
    ):
        prior = checks_by_component.get(cid)
        if ctype == "unscheduled_check":
            cycles_since_last_check[pos] = float(config.ROUTINE_CHECK_INTERVAL_CYCLES)
        elif prior is None:
            cycles_since_last_check[pos] = cycle
        else:
            before = prior[prior < cycle]
            cycles_since_last_check[pos] = cycle - before.max() if before.size else cycle

        if prior is not None:
            check_count_window[pos] = int(((prior < cycle) & (prior > cycle - CHECK_WINDOW)).sum())

    return pd.DataFrame(
        {
            "cycles_since_last_check": cycles_since_last_check,
            "check_count_last_1500cyc": check_count_window,
        },
        index=snapshots.index,
    )


def build_model_table(
    aircraft: pd.DataFrame,
    components: pd.DataFrame,
    snapshots: pd.DataFrame,
    faults: pd.DataFrame,
    maint: pd.DataFrame,
) -> pd.DataFrame:
    snapshots = snapshots.copy()
    snapshots["snapshot_date"] = pd.to_datetime(snapshots["snapshot_date"])

    fault_feats = _rolling_fault_features(snapshots, faults)
    maint_feats = _rolling_maintenance_features(snapshots, maint)

    table = pd.concat([snapshots.reset_index(drop=True), fault_feats, maint_feats], axis=1)

    aircraft_slim = aircraft[
        ["aircraft_id", "aircraft_type", "region", "delivery_date", "cycles_per_day",
         "avg_flight_hours_per_cycle"]
    ].copy()
    aircraft_slim["delivery_date"] = pd.to_datetime(aircraft_slim["delivery_date"])
    table = table.merge(aircraft_slim, on="aircraft_id", how="left")

    # Component-provenance columns kept ONLY for label construction / auditing,
    # not as model features (see config.NON_FEATURE_COLUMNS + modeling.py).
    comp_slim = components[["component_id", "removal_type", "removal_cycle"]]
    table = table.merge(comp_slim, on="component_id", how="left")

    table["component_age_cycles"] = table["cycle"]
    table["cumulative_flight_hours"] = table["cycle"] * table["avg_flight_hours_per_cycle"]
    table["aircraft_age_years"] = (
        table["snapshot_date"] - table["delivery_date"]
    ).dt.days / 365.25

    table = table.sort_values(["component_id", "cycle"]).reset_index(drop=True)
    return table


def load_raw_tables(raw_dir: Path = config.RAW_DIR):
    aircraft = pd.read_csv(raw_dir / "aircraft.csv")
    components = pd.read_csv(raw_dir / "components.csv")
    snapshots = pd.read_csv(raw_dir / "cycle_snapshots.csv")
    faults = pd.read_csv(raw_dir / "fault_codes.csv")
    maint = pd.read_csv(raw_dir / "maintenance_events.csv")
    return aircraft, components, snapshots, faults, maint


def main():
    aircraft, components, snapshots, faults, maint = load_raw_tables()
    table = build_model_table(aircraft, components, snapshots, faults, maint)
    config.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    table.to_csv(config.MODEL_TABLE_CSV, index=False)
    print(f"Model table: {table.shape[0]} rows x {table.shape[1]} cols")
    print(f"Positive rate: {table['label'].mean() * 100:.3f}%")
    print(f"Wrote {config.MODEL_TABLE_CSV}")


if __name__ == "__main__":
    main()
