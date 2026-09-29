"""Synthetic dataset generator for the aircraft component predictive-
maintenance proof of concept.

No real MRO dataset was provided for this take-home test, so this script
builds a plausible, fully-documented synthetic one. It is deterministic:
running it twice with the same ``--seed`` produces byte-identical CSVs
(verified by ``tests/test_dataset_generation.py``).

-------------------------------------------------------------------------
Generative model (all assumptions below are deliberate design choices,
documented here and in docs/design-report.md so a reader can audit them)
-------------------------------------------------------------------------

Entities
    aircraft            One row per tail number: type, delivery date,
                         region, utilization rate (cycles/day).
    components          One row per (aircraft, component_type) slot.
                         Each aircraft carries exactly one instance of
                         each of the 6 modeled component types for the
                         whole study window (component replacement /
                         "second life" is out of scope -- see
                         docs/design-report.md, Limitations).
    cycle_snapshots      Point-in-time telemetry rows: one row per
                         component per scheduled check. This is the
                         table src/features.py turns into the model
                         table -- it is intentionally "raw" (has
                         structural + random missingness, no rolling
                         features yet).
    fault_codes          Event log: one row per fault code raised
                         between checks.
    maintenance_events   Event log: one row per scheduled check plus,
                         if applicable, the terminal removal event.

Degradation & failure process
    Every component is assigned a hidden intrinsic wear-out cycle ``F``
    drawn from a Weibull distribution (shape > 1 => increasing hazard,
    i.e. wear-out failure, not random/electronic-style constant hazard).
    Sensor drift for that component is driven by ``u = clip(cycle / F,
    0, 1)`` -- a 0->1 "fraction of life used" index -- regardless of
    whether the component is eventually removed on an unscheduled basis,
    caught early by scheduled maintenance, or simply outlives the study
    window. This is what makes the classification problem non-trivial:
    scheduled-caught components show *the same underlying wear signal*
    as unscheduled removals, just interrupted earlier by an inspection
    finding, so sensors/fault-codes alone cannot perfectly separate the
    classes.

    If ``F`` falls within the aircraft's observed cycle range:
      - with probability ``P_UNSCHEDULED`` the component fails
        unscheduled at cycle ``F`` (the positive class), else
      - scheduled maintenance intercepts it ``lead_time`` cycles early
        (a "hard negative": visibly degrading, but not a positive label).
    Otherwise the component survives the whole study window (right
    censored, negative).

Label
    ``label = 1`` iff the component's terminal event is an unscheduled
    removal AND the snapshot's cycle is within
    ``config.PREDICTION_HORIZON_CYCLES`` (30) cycles of that removal.
    All other rows (including hard-negative scheduled-caught ones and
    all pre-window rows of eventual positives) are ``label = 0``.

Check cadence (why positive rate lands near ~2%, not lower)
    Components are inspected on a routine grid (~every
    ``ROUTINE_CHECK_INTERVAL_CYCLES`` cycles). A full "every cycle"
    history would dilute the 30-cycle positive window to a tiny
    fraction of a percent, which is unrealistic for a maintenance
    program that only records detailed condition data at scheduled
    checks. We additionally inject 1-2 extra "final inspection" checks
    inside the last 30 cycles before an unscheduled removal for
    components that would not otherwise have a routine check land
    there -- modeling the realistic behavior that inspection frequency
    increases once a component is flagged as degrading. The resulting
    empirical positive rate is computed and printed at the end of a
    run rather than hard-coded; see docs/design-report.md for the
    actual number.

Scheduled vs. symptom-triggered inspections (label-leakage guard)
    The routine ~300-cycle-grid checks are recorded in
    ``maintenance_events`` as ``event_type="scheduled_check"`` -- these are
    on a fixed program interval known in advance, independent of whether
    the component is about to fail, so their recency/count is a legitimate
    predictive feature. The extra "final inspection" checks above are a
    *consequence* of the impending unscheduled removal (by construction
    they only exist because a removal is <=30 cycles away), so they are
    recorded as a distinct ``event_type="unscheduled_check"`` and are
    deliberately excluded from ``src/features.py``'s maintenance-history
    features (which only look at ``event_type == "scheduled_check"`` rows).
    Counting them would let a model learn "an inspection just happened" ->
    "removal is imminent", which is the label leaking into a feature
    through the generator's own inspection-injection mechanism rather than
    the underlying physics. See docs/design-report.md section 7.1
    ("Leakage found and fixed").
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src import config  # noqa: E402

STUDY_END_DATE = pd.Timestamp("2026-09-29")  # fixed, NOT datetime.now(): determinism.
PREDICTION_HORIZON = config.PREDICTION_HORIZON_CYCLES  # 30 cycles

N_AIRCRAFT = 260
ROUTINE_CHECK_INTERVAL_CYCLES = config.ROUTINE_CHECK_INTERVAL_CYCLES
P_UNSCHEDULED = 0.55  # of components that reach their wear-out cycle in-window
FAULT_BASE_RATE_PER_CHECK = 0.18  # Poisson lambda at u=0, scaled up as u -> 1
SENSOR_MCAR_DROPOUT = 0.02  # random missingness on top of structural NA

AIRCRAFT_TYPES = [
    ("A320", 0.30), ("A321", 0.15), ("B737", 0.30), ("ATR72", 0.15), ("E190", 0.10),
]
FLIGHT_HOURS_PER_CYCLE = {"A320": 2.1, "A321": 2.3, "B737": 2.0, "ATR72": 1.1, "E190": 1.6}
REGIONS = [("domestic", 0.55), ("international", 0.45)]

SENSOR_COLUMNS = [
    "vibration_mm_s", "temperature_delta_c", "pressure_delta_psi",
    "current_draw_amp", "stroke_time_s", "airflow_cfm",
]

# component_type -> (display name, Weibull shape k, Weibull scale (cycles), applicable sensors)
COMPONENT_TYPES = {
    "HYD_PUMP":         ("Hydraulic Pump",            2.6, 7000, ["vibration_mm_s", "pressure_delta_psi"]),
    "APU_STARTER":      ("APU Starter Motor",          2.3, 8500, ["current_draw_amp", "temperature_delta_c"]),
    "LG_ACTUATOR":      ("Landing Gear Actuator",      2.8, 6500, ["vibration_mm_s", "stroke_time_s"]),
    "BLEED_VALVE":      ("Engine Bleed Valve",         2.4, 6000, ["temperature_delta_c", "pressure_delta_psi"]),
    "AVIONICS_FAN":     ("Avionics Cooling Fan",       2.2, 9000, ["vibration_mm_s", "airflow_cfm"]),
    "CABIN_PRESS_CTRL": ("Cabin Pressure Controller",  2.5, 7500, ["pressure_delta_psi", "temperature_delta_c"]),
}
FAULT_CODE_CATALOG = [f"F{n:03d}" for n in range(1, 13)]

SENSOR_BASELINE = {s: 0.0 for s in SENSOR_COLUMNS}
SENSOR_AMPLITUDE = {  # how far the sensor drifts as u: 0 -> 1
    "vibration_mm_s": 4.5, "temperature_delta_c": 22.0, "pressure_delta_psi": -18.0,
    "current_draw_amp": 6.0, "stroke_time_s": 0.9, "airflow_cfm": -14.0,
}
SENSOR_NOISE_SIGMA = {
    "vibration_mm_s": 0.35, "temperature_delta_c": 1.8, "pressure_delta_psi": 1.5,
    "current_draw_amp": 0.45, "stroke_time_s": 0.06, "airflow_cfm": 1.2,
}


def _weighted_choice(rng: np.random.Generator, options_with_weights, size):
    options = [o for o, _ in options_with_weights]
    weights = np.array([w for _, w in options_with_weights])
    idx = rng.choice(len(options), size=size, p=weights / weights.sum())
    return np.array(options)[idx]


def make_aircraft(rng: np.random.Generator, n_aircraft: int) -> pd.DataFrame:
    aircraft_id = [f"AC-{i:03d}" for i in range(1, n_aircraft + 1)]
    aircraft_type = _weighted_choice(rng, AIRCRAFT_TYPES, n_aircraft)
    region = _weighted_choice(rng, REGIONS, n_aircraft)
    delivery_days_ago = rng.uniform(365 * 1, 365 * 10, size=n_aircraft)
    delivery_date = STUDY_END_DATE - pd.to_timedelta(delivery_days_ago, unit="D")
    cycles_per_day = rng.uniform(2.5, 6.0, size=n_aircraft)
    return pd.DataFrame({
        "aircraft_id": aircraft_id,
        "aircraft_type": aircraft_type,
        "region": region,
        "delivery_date": delivery_date.normalize(),
        "cycles_per_day": cycles_per_day.round(3),
        "avg_flight_hours_per_cycle": [FLIGHT_HOURS_PER_CYCLE[t] for t in aircraft_type],
    })


def _simulate_one_component(rng, aircraft_row, component_type):
    label, shape, scale, sensors = COMPONENT_TYPES[component_type]
    component_id = f"{aircraft_row.aircraft_id}-{component_type}"

    total_study_cycles = int(
        (STUDY_END_DATE - aircraft_row.delivery_date).days * aircraft_row.cycles_per_day
    )
    total_study_cycles = max(total_study_cycles, ROUTINE_CHECK_INTERVAL_CYCLES + PREDICTION_HORIZON)

    true_failure_cycle = float(rng.weibull(shape) * scale)
    reaches_failure_zone = true_failure_cycle <= total_study_cycles

    if reaches_failure_zone:
        is_unscheduled = rng.random() < P_UNSCHEDULED
        if is_unscheduled:
            removal_cycle = true_failure_cycle
            removal_type = "unscheduled"
        else:
            lead_time = rng.uniform(80, 300)
            removal_cycle = max(30.0, true_failure_cycle - lead_time)
            removal_type = "scheduled"
        observed_end_cycle = removal_cycle
    else:
        removal_type = None
        removal_cycle = None
        observed_end_cycle = float(total_study_cycles)

    # Routine check grid.
    n_checks = max(1, int(observed_end_cycle // ROUTINE_CHECK_INTERVAL_CYCLES))
    check_cycles = np.array(
        [ROUTINE_CHECK_INTERVAL_CYCLES * (i + 1) for i in range(n_checks)], dtype=float
    )
    check_cycles = check_cycles[check_cycles <= observed_end_cycle]

    # Inject extra "final inspection" checks for unscheduled removals so the
    # 30-cycle positive window is actually represented (see module docstring).
    # These are symptom-triggered -- a consequence of the impending removal,
    # not a cause -- so they are tracked separately (extra_check_cycles) and
    # tagged event_type="unscheduled_check" below, instead of being merged
    # into the routine "scheduled_check" grid. src/features.py's
    # maintenance-history features only count "scheduled_check" events, so
    # these symptom-triggered checks never leak into cycles_since_last_check
    # / check_count_last_1500cyc (see module docstring, leakage guard).
    extra_check_cycles = np.array([], dtype=float)
    if reaches_failure_zone and removal_type == "unscheduled":
        already_covered = np.any(
            (check_cycles > removal_cycle - PREDICTION_HORIZON) & (check_cycles < removal_cycle)
        )
        n_extra = 0 if already_covered else int(rng.integers(1, 3))
        if n_extra > 0:
            extra_check_cycles = rng.uniform(
                max(1.0, removal_cycle - PREDICTION_HORIZON + 2), removal_cycle - 1, size=n_extra
            )
            check_cycles = np.sort(np.concatenate([check_cycles, extra_check_cycles]))

    if check_cycles.size == 0:
        check_cycles = np.array([min(observed_end_cycle, ROUTINE_CHECK_INTERVAL_CYCLES)])
    extra_check_set = set(np.round(extra_check_cycles, 1))

    per_component_bias = {s: rng.normal(0, 0.4) for s in SENSOR_COLUMNS}

    snapshot_rows = []
    fault_rows = []
    maint_rows = []
    for cycle in check_cycles:
        u = float(np.clip(cycle / true_failure_cycle, 0.0, 1.0))
        snapshot_date = aircraft_row.delivery_date + pd.to_timedelta(
            cycle / aircraft_row.cycles_per_day, unit="D"
        )

        label_val = 0
        if removal_type == "unscheduled" and 0 < (removal_cycle - cycle) <= PREDICTION_HORIZON:
            label_val = 1

        is_symptom_triggered = round(float(cycle), 1) in extra_check_set
        check_event_type = "unscheduled_check" if is_symptom_triggered else "scheduled_check"

        row = {
            "component_id": component_id,
            "aircraft_id": aircraft_row.aircraft_id,
            "component_type": component_type,
            "cycle": round(float(cycle), 1),
            "snapshot_date": snapshot_date.normalize(),
            # Audit-only column: which inspection triggered this snapshot.
            # NOT a model feature (src/config.NON_FEATURE_COLUMNS) -- using it
            # directly would trivially leak the label (see module docstring).
            "check_type": check_event_type,
            "label": label_val,
        }
        for s in sensors:
            val = (
                SENSOR_BASELINE[s]
                + SENSOR_AMPLITUDE[s] * (u ** 2)
                + per_component_bias[s]
                + rng.normal(0, SENSOR_NOISE_SIGMA[s])
            )
            if rng.random() < SENSOR_MCAR_DROPOUT:
                val = np.nan
            row[s] = val
        for s in SENSOR_COLUMNS:
            if s not in sensors:
                row[s] = np.nan
        snapshot_rows.append(row)

        maint_rows.append({
            "component_id": component_id,
            "cycle_at_event": round(float(cycle), 1),
            "event_date": snapshot_date.normalize(),
            "event_type": check_event_type,
        })

        n_faults = rng.poisson(FAULT_BASE_RATE_PER_CHECK * (1 + 6 * u ** 3))
        for _ in range(n_faults):
            fault_cycle = cycle - rng.uniform(0, min(ROUTINE_CHECK_INTERVAL_CYCLES, cycle))
            fault_date = aircraft_row.delivery_date + pd.to_timedelta(
                fault_cycle / aircraft_row.cycles_per_day, unit="D"
            )
            severity = int(np.clip(rng.integers(1, 4) + (1 if u > 0.7 else 0), 1, 3))
            fault_rows.append({
                "component_id": component_id,
                "cycle_at_fault": round(float(fault_cycle), 1),
                "fault_date": fault_date.normalize(),
                "fault_code": rng.choice(FAULT_CODE_CATALOG),
                "severity": severity,
            })

    component_row = {
        "component_id": component_id,
        "aircraft_id": aircraft_row.aircraft_id,
        "component_type": component_type,
        "install_date": aircraft_row.delivery_date,
        "removal_type": removal_type if removal_type else "none",
        "removal_cycle": round(removal_cycle, 1) if removal_cycle is not None else np.nan,
        "removal_date": (
            (aircraft_row.delivery_date + pd.to_timedelta(
                removal_cycle / aircraft_row.cycles_per_day, unit="D")).normalize()
            if removal_cycle is not None else pd.NaT
        ),
    }
    if removal_type:
        maint_rows.append({
            "component_id": component_id,
            "cycle_at_event": round(removal_cycle, 1),
            "event_date": component_row["removal_date"],
            "event_type": f"{removal_type}_removal",
        })

    return component_row, snapshot_rows, fault_rows, maint_rows


def generate(seed: int = config.DEFAULT_SEED, n_aircraft: int = N_AIRCRAFT):
    rng = np.random.default_rng(seed)

    aircraft_df = make_aircraft(rng, n_aircraft)

    components, snapshots, faults, maint = [], [], [], []
    for aircraft_row in aircraft_df.itertuples(index=False):
        for component_type in COMPONENT_TYPES:
            comp_row, snap_rows, fault_rows, maint_rows = _simulate_one_component(
                rng, aircraft_row, component_type
            )
            components.append(comp_row)
            snapshots.extend(snap_rows)
            faults.extend(fault_rows)
            maint.extend(maint_rows)

    components_df = pd.DataFrame(components)
    snapshots_df = pd.DataFrame(snapshots).sort_values(
        ["component_id", "cycle"]
    ).reset_index(drop=True)
    faults_df = pd.DataFrame(faults).sort_values(
        ["component_id", "cycle_at_fault"]
    ).reset_index(drop=True)
    maint_df = pd.DataFrame(maint).sort_values(
        ["component_id", "cycle_at_event"]
    ).reset_index(drop=True)

    return aircraft_df, components_df, snapshots_df, faults_df, maint_df


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=config.DEFAULT_SEED)
    parser.add_argument("--n-aircraft", type=int, default=N_AIRCRAFT)
    parser.add_argument("--out-dir", type=Path, default=config.RAW_DIR)
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)

    aircraft_df, components_df, snapshots_df, faults_df, maint_df = generate(
        seed=args.seed, n_aircraft=args.n_aircraft
    )

    aircraft_df.to_csv(args.out_dir / "aircraft.csv", index=False)
    components_df.to_csv(args.out_dir / "components.csv", index=False)
    snapshots_df.to_csv(args.out_dir / "cycle_snapshots.csv", index=False)
    faults_df.to_csv(args.out_dir / "fault_codes.csv", index=False)
    maint_df.to_csv(args.out_dir / "maintenance_events.csv", index=False)

    n_pos = int(snapshots_df["label"].sum())
    n_total = len(snapshots_df)
    print(f"Aircraft:              {len(aircraft_df)}")
    print(f"Components:            {len(components_df)}")
    print(f"  unscheduled removals: {(components_df['removal_type'] == 'unscheduled').sum()}")
    print(f"  scheduled removals:   {(components_df['removal_type'] == 'scheduled').sum()}")
    print(f"  survived (censored):  {(components_df['removal_type'] == 'none').sum()}")
    print(f"Cycle snapshots:       {n_total}")
    print(f"Fault code events:     {len(faults_df)}")
    print(f"Maintenance events:    {len(maint_df)}")
    print(f"Positive rate:         {n_pos}/{n_total} = {100 * n_pos / n_total:.3f}%")
    print(f"Wrote CSVs to {args.out_dir}")


if __name__ == "__main__":
    main()
