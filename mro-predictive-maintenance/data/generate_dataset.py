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

Realism profile (v3, ``--profile realistic``)
    ``--profile v1`` (default when called explicitly) reproduces the
    originally-submitted dataset byte-for-byte -- no code path below runs,
    and no extra RNG draws happen, when ``profile == "v1"``, so the existing
    determinism/parity tests keep passing untouched. ``--profile realistic``
    (the pipeline's new headline profile, see src/config.DEFAULT_PROFILE)
    layers six physically-motivated realism knobs on top of the same
    Weibull wear model, each added ONLY inside an ``if profile ==
    "realistic":`` branch so v1's RNG stream is bit-identical to before:

    1. NFF (no-fault-found) unscheduled removals: ~15% of unscheduled
       removals are "signal-free" -- the component IS pulled unscheduled
       (still label=1, it really is an unscheduled removal) but its sensor
       drift is capped at a low wear fraction throughout its life, so the
       model has nothing to key on. Mirrors real avionics/mechanical NFF
       rates (20-50%, see reports/research-and-gap-analysis.md domain
       research) and caps achievable recall honestly instead of hiding it.
    2. Stuck/faulty sensor episodes: ~1% chance per snapshot that one
       sensor reads a stuck (frozen-at-bias) or spiked value, independent
       of true wear -- models transducer/wiring faults, not component health.
    3. Missing-not-at-random (MNAR) sensor dropout: missingness probability
       rises with wear fraction ``u`` (degraded components get skipped or
       fail to transmit more often) on top of the base MCAR dropout.
    4. Component replacement ("second life"): after a removal, if enough
       study-window runway remains, a new physical unit is installed in
       the same aircraft/component-type slot 50% of the time -- distinct
       ``component_id`` suffix + ``component_serial``/``install_cycle``
       audit columns (src/config.NON_FEATURE_COLUMNS), age (``cycle``)
       resets to 0. ``aircraft_id`` stays the group key, so splitting.py's
       leakage guarantees are unaffected.
    5. Label noise: 3% of scheduled-caught ("hard negative") components
       have their would-be pre-removal window mislabeled positive --
       models maintenance-records-quality noise (a scheduled removal
       misrecorded as unscheduled), not a physical effect.
    6. Operator/climate effect: ``region`` modulates the Weibull scale by
       +-15% (domestic ops assumed harsher duty cycle -> faster wear) --
       a deterministic multiplier, no extra RNG draw.
    7. Anti-sampling-leakage balancer: 30% of components that survive the
       whole study window (never removed) also get one extra "spot check"
       inspection near the end of their observed history, so an extra
       inspection near a component's last rows is no longer a
       removal-only signature (design-report.md section 7.1 flagged
       ``cycles_since_last_check``/inspection-density as an artifact of
       ONLY injecting extra checks for soon-to-be-removed components).

    None of this changes the label definition (still "unscheduled removal
    within PREDICTION_HORIZON cycles") or the leakage guards in
    src/features.py -- it only makes the underlying signal noisier and more
    representative of a real fleet, which is expected to (and, per the
    coordinator decision recorded in plan.md, is REPORTED honestly rather
    than tuned away) reduce ROC-AUC/precision and push recall below 0.80 in
    some seeds. See tests/test_realism_profile.py.
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


NFF_SHARE_OF_UNSCHEDULED = 0.15  # p(NFF | unscheduled removal), realistic profile only
NFF_MAX_SIGNAL_U = 0.35  # NFF components never show wear-fraction signal above this
STUCK_SENSOR_RATE = 0.01  # p(stuck/spike fault) per sensor per snapshot, realistic only
MNAR_DROPOUT_SLOPE = 0.06  # extra dropout probability at u=1 (added to SENSOR_MCAR_DROPOUT)
SECOND_LIFE_PROBABILITY = 0.5  # p(component replaced) after a removal, if runway remains
LABEL_NOISE_RATE = 0.03  # share of scheduled-caught components mislabeled as unscheduled
REGION_WEAR_MODULATION = {"domestic": 1.15, "international": 0.85}  # +-15% Weibull scale
SURVIVOR_SPOT_CHECK_PROBABILITY = 0.30  # anti-sampling-leakage balancer, realistic only


def _simulate_one_component(
    rng, aircraft_row, component_type, profile: str = "v1",
    cycle_offset: float = 0.0, serial: int = 1,
):
    label, shape, scale, sensors = COMPONENT_TYPES[component_type]
    suffix = "" if serial == 1 else f"-S{serial}"
    component_id = f"{aircraft_row.aircraft_id}-{component_type}{suffix}"

    total_study_cycles_full = int(
        (STUDY_END_DATE - aircraft_row.delivery_date).days * aircraft_row.cycles_per_day
    )
    total_study_cycles_full = max(
        total_study_cycles_full, ROUTINE_CHECK_INTERVAL_CYCLES + PREDICTION_HORIZON
    )
    total_study_cycles = total_study_cycles_full - cycle_offset
    if total_study_cycles < ROUTINE_CHECK_INTERVAL_CYCLES + PREDICTION_HORIZON:
        return None  # not enough runway left in the study window for this life

    scale_eff = scale
    if profile == "realistic":
        # Operator/climate effect: region modulates wear rate +-15%. A
        # deterministic multiplier -- no extra RNG draw, so it never touches
        # v1's RNG stream (this branch never runs for profile == "v1").
        scale_eff = scale * REGION_WEAR_MODULATION.get(aircraft_row.region, 1.0)

    true_failure_cycle = float(rng.weibull(shape) * scale_eff)
    reaches_failure_zone = true_failure_cycle <= total_study_cycles

    is_nff = False
    if reaches_failure_zone:
        is_unscheduled = rng.random() < P_UNSCHEDULED
        if is_unscheduled:
            removal_cycle = true_failure_cycle
            removal_type = "unscheduled"
            if profile == "realistic":
                is_nff = rng.random() < NFF_SHARE_OF_UNSCHEDULED
        else:
            lead_time = rng.uniform(80, 300)
            removal_cycle = max(30.0, true_failure_cycle - lead_time)
            removal_type = "scheduled"
        observed_end_cycle = removal_cycle
    else:
        removal_type = None
        removal_cycle = None
        observed_end_cycle = float(total_study_cycles)

    label_noise_flip = False
    if profile == "realistic" and removal_type == "scheduled":
        # Records-quality noise: some scheduled-caught removals are actually
        # misrecorded as unscheduled in the maintenance system, not a
        # physical effect -- see module docstring point 5.
        label_noise_flip = rng.random() < LABEL_NOISE_RATE

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
    elif profile == "realistic" and not reaches_failure_zone:
        # Anti-sampling-leakage balancer (module docstring point 7): give a
        # random 30% of NEVER-removed components an extra "spot check" too,
        # so an extra inspection is not, by construction, only ever seen on
        # soon-to-be-removed components.
        if rng.random() < SURVIVOR_SPOT_CHECK_PROBABILITY and observed_end_cycle > PREDICTION_HORIZON + 2:
            extra_cycle = rng.uniform(
                max(1.0, observed_end_cycle - PREDICTION_HORIZON + 2), observed_end_cycle - 1
            )
            extra_check_cycles = np.array([extra_cycle])
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
        u_signal = min(u, NFF_MAX_SIGNAL_U) if is_nff else u
        global_cycle = cycle_offset + cycle
        snapshot_date = aircraft_row.delivery_date + pd.to_timedelta(
            global_cycle / aircraft_row.cycles_per_day, unit="D"
        )

        label_val = 0
        if removal_type == "unscheduled" and 0 < (removal_cycle - cycle) <= PREDICTION_HORIZON:
            label_val = 1
        elif label_noise_flip and 0 < (removal_cycle - cycle) <= PREDICTION_HORIZON:
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
            "component_serial": serial,
            "install_cycle": round(float(cycle_offset), 1),
            "is_nff": bool(is_nff),
        }
        for s in sensors:
            val = (
                SENSOR_BASELINE[s]
                + SENSOR_AMPLITUDE[s] * (u_signal ** 2)
                + per_component_bias[s]
                + rng.normal(0, SENSOR_NOISE_SIGMA[s])
            )
            if profile == "realistic":
                if rng.random() < STUCK_SENSOR_RATE:
                    # Stuck (frozen at this component's baseline bias) or a
                    # spike fault -- a transducer/wiring fault independent of
                    # true wear, not a health symptom (module docstring pt 2).
                    if rng.random() < 0.5:
                        val = per_component_bias[s]
                    else:
                        val = val + rng.normal(0, 8 * SENSOR_NOISE_SIGMA[s])
                dropout_p = SENSOR_MCAR_DROPOUT + MNAR_DROPOUT_SLOPE * u_signal
                if rng.random() < dropout_p:
                    val = np.nan
            else:
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

        n_faults = rng.poisson(FAULT_BASE_RATE_PER_CHECK * (1 + 6 * u_signal ** 3))
        for _ in range(n_faults):
            fault_cycle = cycle - rng.uniform(0, min(ROUTINE_CHECK_INTERVAL_CYCLES, cycle))
            fault_date = aircraft_row.delivery_date + pd.to_timedelta(
                (cycle_offset + fault_cycle) / aircraft_row.cycles_per_day, unit="D"
            )
            severity = int(np.clip(rng.integers(1, 4) + (1 if u_signal > 0.7 else 0), 1, 3))
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
        "install_date": (
            aircraft_row.delivery_date
            if cycle_offset == 0
            else aircraft_row.delivery_date + pd.to_timedelta(
                cycle_offset / aircraft_row.cycles_per_day, unit="D"
            )
        ),
        "removal_type": removal_type if removal_type else "none",
        "removal_cycle": round(removal_cycle, 1) if removal_cycle is not None else np.nan,
        "removal_date": (
            (aircraft_row.delivery_date + pd.to_timedelta(
                global_cycle_removal(cycle_offset, removal_cycle) / aircraft_row.cycles_per_day,
                unit="D")).normalize()
            if removal_cycle is not None else pd.NaT
        ),
        "component_serial": serial,
        "install_cycle": round(float(cycle_offset), 1),
        "is_nff": bool(is_nff),
    }
    if removal_type:
        maint_rows.append({
            "component_id": component_id,
            "cycle_at_event": round(removal_cycle, 1),
            "event_date": component_row["removal_date"],
            "event_type": f"{removal_type}_removal",
        })

    next_life = None
    if profile == "realistic" and removal_type is not None:
        if rng.random() < SECOND_LIFE_PROBABILITY:
            next_life = (cycle_offset + removal_cycle, serial + 1)

    return component_row, snapshot_rows, fault_rows, maint_rows, next_life


def global_cycle_removal(cycle_offset: float, removal_cycle: float | None) -> float:
    return cycle_offset + removal_cycle if removal_cycle is not None else cycle_offset


def generate(seed: int = config.DEFAULT_SEED, n_aircraft: int = N_AIRCRAFT, profile: str = "v1"):
    if profile not in {"v1", "realistic"}:
        raise ValueError(f"unknown profile {profile!r}; expected 'v1' or 'realistic'")

    rng = np.random.default_rng(seed)

    aircraft_df = make_aircraft(rng, n_aircraft)

    components, snapshots, faults, maint = [], [], [], []
    for aircraft_row in aircraft_df.itertuples(index=False):
        for component_type in COMPONENT_TYPES:
            cycle_offset, serial = 0.0, 1
            # Component-replacement chain (realistic profile only, module
            # docstring point 4): at most a handful of lives per slot -- a
            # hard cap keeps this YAGNI-bounded even in a pathological seed.
            for _ in range(4):
                result = _simulate_one_component(
                    rng, aircraft_row, component_type, profile=profile,
                    cycle_offset=cycle_offset, serial=serial,
                )
                if result is None:
                    break
                comp_row, snap_rows, fault_rows, maint_rows, next_life = result
                components.append(comp_row)
                snapshots.extend(snap_rows)
                faults.extend(fault_rows)
                maint.extend(maint_rows)
                if next_life is None:
                    break
                cycle_offset, serial = next_life

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
    parser.add_argument(
        "--profile", choices=["v1", "realistic"], default=config.DEFAULT_PROFILE,
        help="'v1' reproduces the originally-submitted dataset byte-for-byte; "
        "'realistic' (default) layers NFF removals, sensor faults, component "
        "replacement, label noise, and operator effects on top -- see this "
        "module's docstring.",
    )
    parser.add_argument(
        "--out-dir", type=Path, default=None,
        help="Defaults to data/raw/ for --profile v1 (canonical) and "
        "data/raw/realistic/ for --profile realistic, so both profiles' raw "
        "CSVs can coexist on disk without the stress-test run ever "
        "overwriting the v1 canonical files.",
    )
    args = parser.parse_args()

    out_dir = args.out_dir
    if out_dir is None:
        out_dir = config.RAW_DIR if args.profile == "v1" else config.REALISTIC_RAW_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    args.out_dir = out_dir

    aircraft_df, components_df, snapshots_df, faults_df, maint_df = generate(
        seed=args.seed, n_aircraft=args.n_aircraft, profile=args.profile
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
