# Demo Evidence -- Real Captured Output

This file exists so the deliverable can be reviewed **without running
anything**: every block below is pasted verbatim from an actual execution
of this repo's scripts (seed 42, this environment, 2026-09-29, **post
target-leakage fix** -- see `docs/design-report.md` section 7.1, "Leakage
found and fixed", for the before/after story and root cause). Nothing here
is hand-written or estimated. To reproduce, run the three commands from
`README.md` -- "Run it", steps 1-3 -- and `pytest tests/ -v` for the test
block.

## 1. Dataset generation (`python data/generate_dataset.py --seed 42`)

```
Aircraft:              260
Components:            1560
  unscheduled removals: 538
  scheduled removals:   432
  survived (censored):  590
Cycle snapshots:       26565
Fault code events:     11201
Maintenance events:    27535
Positive rate:         777/26565 = 2.925%
Wrote CSVs to <repo>\mro-predictive-maintenance\data\raw
```

**What this shows:** 260 synthetic aircraft x 6 component types = 1,560
components were generated. Of those, 538 experienced an unscheduled
removal (the event of interest), 432 were caught early by scheduled
maintenance (hard negatives -- same wear signal, different outcome), and
590 simply outlived the observation window. Across all 26,565 individual
inspection-point rows, 777 are positive-labeled ("removal within 30
cycles") -- a 2.925% positive rate, matching the brief's "~2%" severe-
imbalance requirement. The label distribution is unchanged by the leakage
fix (only how maintenance-history *features* are computed changed, not
which rows are positive). This run is deterministic: re-running with the
same `--seed 42` reproduces byte-identical CSVs (verified by
`tests/test_dataset_generation.py`).

`maintenance_events.csv` now distinguishes `event_type="scheduled_check"`
(routine ~300-cycle-grid checks) from `event_type="unscheduled_check"`
(symptom-triggered "final inspection" checks injected inside the 30-cycle
label window before an unscheduled removal) -- 12,219 vs. 343 events in
this run. Only `scheduled_check` events feed `src/features.py`'s
maintenance-recency features; see section 2 below.

## 2. Training/eval pipeline (`python -m src.pipeline`)

```
Model table: 26565 rows, 2.925% positive
Split -> train 18967 rows / 156 aircraft, val 5083 rows / 52 aircraft, test 2515 rows / 52 aircraft
  train delivery max=2022-03-14  val delivery range=[2022-03-19, 2024-01-29]  test delivery min=2024-02-12
  positive rows -> train 643, val 106, test 28

=== logistic_regression ===
  val  ROC-AUC=0.9944  PR-AUC=0.9256
  test ROC-AUC=0.9957  PR-AUC=0.8821
  chosen threshold (selected on val)=0.9801 [both_constraints_met]
  TEST at that threshold: recall=0.7143  precision=1.0000  alerts/100=0.80  (target: recall>=0.8, alerts/100<=5.0)

=== hist_gradient_boosting ===
  val  ROC-AUC=0.9986  PR-AUC=0.9682
  test ROC-AUC=0.9996  PR-AUC=0.9733
  chosen threshold (selected on val)=0.9405 [both_constraints_met]
  TEST at that threshold: recall=0.8214  precision=1.0000  alerts/100=0.91  (target: recall>=0.8, alerts/100<=5.0)

=== Model comparison (test split) ===
                 model  val_roc_auc  val_pr_auc  test_roc_auc  test_pr_auc  chosen_threshold     threshold_status  test_recall  test_precision  test_alerts_per_100  test_n_alerts  test_n_positive
   logistic_regression     0.994416    0.925634      0.995692     0.882064            0.9801 both_constraints_met     0.714286             1.0             0.795229             20               28
hist_gradient_boosting     0.998592    0.968171      0.999598     0.973269            0.9405 both_constraints_met     0.821429             1.0             0.914513             23               28

Primary model for explainability artifacts: hist_gradient_boosting

Wrote reports to <repo>\mro-predictive-maintenance\reports
```

**What this shows, in plain terms:** the fleet was split so that 156
aircraft (early-delivered) trained the models, 52 aircraft (next cohort)
picked the alert threshold, and a completely different 52 aircraft
(most-recently-delivered, never seen before) were the final exam. **The
honest, post-fix headline result: `hist_gradient_boosting` caught 23 of 28
real unscheduled removals in that final exam (82.1% recall) while raising
only 0.91 false alerts per 100 components -- both inside the brief's
target of >=80% recall and <=5 alerts per 100.** `logistic_regression`
looked strong on validation but fell just short on the actual held-out
test aircraft (71.4% recall) -- reported as-is rather than re-picking a
more lenient threshold after the fact, which is why `hist_gradient_boosting`
is the model actually deployed by `src/service/` (`config.PRIMARY_MODEL_ID`;
full reasoning in `docs/design-report.md`, section 4). Both numbers are
materially different from the pre-fix run (which reported 82.1%/67.9%
recall with `cycles_since_last_check` doing nearly all the work) -- see
section 7.1 of the design report for the full before/after comparison.

## 3. Example high-risk predictions with real SHAP explanations

Pasted verbatim from `reports/high_risk_examples.md` (generated by the run
above; the hist_gradient_boosting model, applied to the test split):

```markdown
## AC-249-AVIONICS_FAN  (cycle 2889.9, 2026-04-21 00:00:00)

- risk_score: **0.9953**
- true label: 1 (unscheduled removal within 30 cycles)
- component_type: AVIONICS_FAN
- explanation method: shap
- top contributing features:
  - `num__check_count_last_1500cyc`: SHAP contribution +8.9077
  - `num__vibration_mm_s`: SHAP contribution +1.1295
  - `num__airflow_cfm`: SHAP contribution -0.2857
  - `num__fault_count_last_1500cyc`: SHAP contribution +0.2700
  - `num__pressure_delta_psi`: SHAP contribution +0.2015

## AC-242-HYD_PUMP  (cycle 3343.5, 2026-03-05 00:00:00)

- risk_score: **0.9953**
- true label: 1 (unscheduled removal within 30 cycles)
- component_type: HYD_PUMP
- explanation method: shap
- top contributing features:
  - `num__check_count_last_1500cyc`: SHAP contribution +7.2965
  - `num__pressure_delta_psi`: SHAP contribution +1.4043
  - `num__vibration_mm_s`: SHAP contribution +1.1778
  - `num__temperature_delta_c`: SHAP contribution +0.2590
  - `num__fault_count_last_1500cyc`: SHAP contribution +0.1592

## AC-242-HYD_PUMP  (cycle 3343.9, 2026-03-05 00:00:00)

- risk_score: **0.9953**
- true label: 1 (unscheduled removal within 30 cycles)
- component_type: HYD_PUMP
- explanation method: shap
- top contributing features:
  - `num__check_count_last_1500cyc`: SHAP contribution +7.7361
  - `num__vibration_mm_s`: SHAP contribution +1.0300
  - `num__pressure_delta_psi`: SHAP contribution +0.9460
  - `num__fault_count_last_1500cyc`: SHAP contribution +0.3328
  - `num__temperature_delta_c`: SHAP contribution +0.2567

## AC-215-AVIONICS_FAN  (cycle 2773.9, 2026-07-10 00:00:00)

- risk_score: **0.9953**
- true label: 1 (unscheduled removal within 30 cycles)
- component_type: AVIONICS_FAN
- explanation method: shap
- top contributing features:
  - `num__check_count_last_1500cyc`: SHAP contribution +9.1627
  - `num__vibration_mm_s`: SHAP contribution +1.0017
  - `num__fault_count_last_1500cyc`: SHAP contribution +0.2525
  - `num__airflow_cfm`: SHAP contribution -0.2501
  - `num__pressure_delta_psi`: SHAP contribution +0.2045

## AC-144-APU_STARTER  (cycle 2177.1, 2026-05-03 00:00:00)

- risk_score: **0.9953**
- true label: 1 (unscheduled removal within 30 cycles)
- component_type: APU_STARTER
- explanation method: shap
- top contributing features:
  - `num__check_count_last_1500cyc`: SHAP contribution +8.4786
  - `num__current_draw_amp`: SHAP contribution +0.9487
  - `num__temperature_delta_c`: SHAP contribution +0.5286
  - `num__fault_count_last_1500cyc`: SHAP contribution +0.2355
  - `num__pressure_delta_psi`: SHAP contribution +0.1038
```

**What this shows:** all five example components were, in reality,
unscheduled-removed within 30 cycles of the shown snapshot (`true label:
1`), and the model scored all five at essentially maximum risk (0.9953).
Note what changed from the pre-fix version of this report: `cycles_since_
last_check` **no longer appears in any explanation** (it was removed from
being computable off a label-caused row placement -- see design report
7.1). The now-dominant driver, `check_count_last_1500cyc`, is a legitimate
component-maturity proxy (older components have accumulated more routine
checks in a trailing window, and this synthetic fleet's Weibull hazard
genuinely increases with age), backed up by the expected physical sensor
readings for each component type (vibration for the avionics fan/hydraulic
pump, pressure/temperature for the hydraulic pump, current draw for the
APU starter).

## 4. The reported leak, reproduced live against the running service

This is the exact scenario from the bug report: for a component, changing
only `cycles_since_last_check` (holding every other feature fixed) used to
move the risk score from 1.000 to 0.000. Captured against the real running
service (`uvicorn src.service.app:app --port 8100`), `POST /score` twice
with `cycles_since_last_check` set to 7 and then 400, all other fields
identical (a CABIN_PRESS_CTRL payload):

```
cycles_since_last_check=7:   risk_score=0.0053  alert=False
cycles_since_last_check=400: risk_score=0.0053  alert=False
top_factors (identical for both): pressure_delta_psi, fault_count_last_1500cyc,
  temperature_delta_c, check_count_last_1500cyc, vibration_mm_s
  -- cycles_since_last_check does not appear at all.
```

**What this shows:** the risk score and every SHAP factor are now bit-for-
bit identical regardless of `cycles_since_last_check`'s value -- the exact
reported bug (a >0.9 collapse from changing this one field) no longer
reproduces. This scenario is also covered by
`tests/test_no_target_leakage.py::test_cycles_since_last_scheduled_check_never_decreases_risk_monotonically`.

## 5. Live scoring service (`uvicorn src.service.app:app --port 8100`)

Real `curl` output against the running service, loaded from the exact
artifacts shown in sections 2-3 above (`models/hist_gradient_boosting.joblib`,
`reports/model_card.json`, `data/processed/model_table.csv`).

```
== GET /health ==
{"status":"ok","model_id":"hist_gradient_boosting","model_loaded":true}

== GET /model-card ==
{"model_id":"hist_gradient_boosting","trained_at":"2026-09-29T08:31:15.994808+00:00","seed":42,
 "threshold":0.9405,"threshold_status":"both_constraints_met",
 "target":{"min_recall":0.8,"max_alerts_per_100":5.0},
 "val_metrics":{"n_rows":5083,"n_positive":106,"roc_auc":0.9985916347272928,"pr_auc":0.9681713400548697},
 "test_metrics":{"n_rows":2515,"n_positive":28,"roc_auc":0.9995979091274628,"pr_auc":0.9732694046690771},
 "test_at_threshold":{"threshold":0.9405,"tp":23,"fp":0,"fn":5,"tn":2487,"recall":0.8214285714285714,
 "precision":1.0,"alerts_per_100":0.9145129224652088,"n_alerts":23,"n_rows":2515},
 "numeric_features":["vibration_mm_s","temperature_delta_c","pressure_delta_psi","current_draw_amp",
 "stroke_time_s","airflow_cfm","fault_count_last_500cyc","fault_count_last_1500cyc",
 "max_severity_last_500cyc","cycles_since_last_check","check_count_last_1500cyc",
 "component_age_cycles","cumulative_flight_hours","aircraft_age_years","cycles_per_day",
 "avg_flight_hours_per_cycle"],"categorical_features":["aircraft_type","component_type","region"]}

== GET /fleet/top-risk?n=3 ==  (live-scored, real held-out test-split rows, ranked)
{"model_id":"hist_gradient_boosting","threshold":0.9405,"split":"test","n_scored":312,"n_returned":3,
 "items":[
   {"component_id":"AC-070-LG_ACTUATOR","aircraft_id":"AC-070","component_type":"LG_ACTUATOR",
    "cycle":2259.2,"snapshot_date":"2026-07-29 00:00:00","risk_score":0.9953069458906584,"alert":true,
    "true_label":1, "...":"..."},
   {"component_id":"AC-088-BLEED_VALVE","aircraft_id":"AC-088","component_type":"BLEED_VALVE",
    "cycle":2568.4,"snapshot_date":"2026-01-17 00:00:00","risk_score":0.9953069458906584,"alert":true,
    "true_label":1, "...":"..."},
   {"component_id":"AC-033-BLEED_VALVE","aircraft_id":"AC-033","component_type":"BLEED_VALVE",
    "cycle":3760.0,"snapshot_date":"2025-11-02 00:00:00","risk_score":0.9953069458906584,"alert":true,
    "true_label":1, "...":"..."}
 ]}

== POST /score  (feature payload for AC-070-LG_ACTUATOR, the row above) ==
{"model_id":"hist_gradient_boosting","component_id":"AC-070-LG_ACTUATOR","risk_score":0.9953069458906584,
 "threshold":0.9405,"alert":true,"explanation_method":"shap",
 "top_factors":[
   {"feature":"num__check_count_last_1500cyc","shap_value":8.797149297595023},
   {"feature":"num__vibration_mm_s","shap_value":1.1203383940458298},
   {"feature":"num__fault_count_last_1500cyc","shap_value":0.2773081888630986},
   {"feature":"num__pressure_delta_psi","shap_value":0.22495735079050064},
   {"feature":"num__cycles_per_day","shap_value":-0.21479993286542595}
 ]}
-- risk_score 0.9953069458906584 here matches the fleet row's score exactly: same
   fitted pipeline, same feature payload, one scoring code path (proven by
   tests/test_service.py::test_score_parity_with_offline_pipeline).

== POST /score with a payload missing required categorical fields ==
HTTP/1.1 422 Unprocessable Entity
{"detail":[{"type":"missing","loc":["body","aircraft_type"],"msg":"Field required", ...},
           {"type":"missing","loc":["body","component_type"],"msg":"Field required", ...},
           {"type":"missing","loc":["body","region"],"msg":"Field required", ...}]}
```

**What this shows:** the service loads the real artifacts at startup
(`/health`), serves the exact threshold/metrics `src/pipeline.py` wrote
(`/model-card`), live-scores the real held-out test split ranked by risk
(`/fleet/top-risk`), and scores an arbitrary feature payload with live SHAP
factors (`/score`) -- the returned score for a fleet row matches what
`/fleet/top-risk` already reported for that same row, and pydantic rejects
an incomplete payload with a 422 rather than silently imputing/guessing.

## 6. Full test suite (`pytest tests/ -v`)

```
============================= test session starts =============================
platform win32 -- Python 3.11.9, pytest-9.1.1, pluggy-1.6.0
collected 26 items

tests/test_dataset_generation.py::test_generation_is_deterministic_for_fixed_seed PASSED [  3%]
tests/test_dataset_generation.py::test_different_seeds_produce_different_data PASSED [  7%]
tests/test_dataset_generation.py::test_positive_rate_is_in_severe_imbalance_range PASSED [ 11%]
tests/test_dataset_generation.py::test_snapshot_scores_have_no_nan_labels_and_valid_cycles PASSED [ 15%]
tests/test_dataset_generation.py::test_components_removal_type_values_are_valid PASSED [ 19%]
tests/test_model_smoke.py::test_model_trains_and_scores_are_valid_probabilities[logistic_regression] PASSED [ 23%]
tests/test_model_smoke.py::test_model_trains_and_scores_are_valid_probabilities[hist_gradient_boosting] PASSED [ 26%]
tests/test_model_smoke.py::test_evaluation_helpers_run_end_to_end PASSED [ 30%]
tests/test_no_target_leakage.py::test_no_feature_is_computed_from_events_inside_the_label_window PASSED [ 34%]
tests/test_no_target_leakage.py::test_cycles_since_last_scheduled_check_never_decreases_risk_monotonically PASSED [ 38%]
tests/test_no_target_leakage.py::test_cycles_since_last_check_does_not_dominate_permutation_importance PASSED [ 42%]
tests/test_no_target_leakage.py::test_maintenance_events_csv_distinguishes_scheduled_from_symptom_triggered PASSED [ 46%]
tests/test_service.py::test_health_reports_model_loaded PASSED           [ 50%]
tests/test_service.py::test_model_card_matches_disk_artifact PASSED      [ 53%]
tests/test_service.py::test_fleet_top_risk_is_ranked_and_alert_consistent_with_threshold PASSED [ 57%]
tests/test_service.py::test_fleet_top_risk_rejects_non_positive_n PASSED [ 61%]
tests/test_service.py::test_score_valid_payload_returns_probability_and_shap_factors PASSED [ 65%]
tests/test_service.py::test_score_missing_categorical_field_is_422 PASSED [ 69%]
tests/test_service.py::test_score_rejects_unknown_field PASSED           [ 73%]
tests/test_service.py::test_score_parity_with_offline_pipeline PASSED    [ 76%]
tests/test_splitting_leakage.py::test_no_aircraft_or_component_overlap_across_splits PASSED [ 80%]
tests/test_splitting_leakage.py::test_delivery_dates_are_chronologically_ordered_across_splits PASSED [ 84%]
tests/test_splitting_leakage.py::test_assert_no_leakage_passes_on_a_real_split PASSED [ 88%]
tests/test_splitting_leakage.py::test_assert_no_leakage_catches_injected_group_overlap PASSED [ 92%]
tests/test_splitting_leakage.py::test_assert_no_leakage_catches_injected_time_order_violation PASSED [ 96%]
tests/test_splitting_leakage.py::test_split_fractions_are_respected PASSED [100%]

======================= 26 passed, 4 warnings in 12.25s =======================
```

**What this shows:** all 26 tests pass -- the original 22 plus 4 new
leakage-regression tests in `tests/test_no_target_leakage.py` (the
scheduled-vs-symptom-triggered event tagging, the monotonicity sanity
check reproducing the exact reported bug, a permutation-importance guard,
and an event-type sanity check), which would have failed against the
pre-fix generator/features code.

## 7. Results dashboard

`dashboard/` is a static Vite/React UI built on top of the artifacts above
-- overview stats, model comparison with the validation threshold-sweep
curve, feature-importance charts, and the high-risk leaderboard. It does
not compute anything itself: `dashboard/scripts/build_dashboard_data.py`
reads `reports/metrics_table.md`, `reports/threshold_sweep_*.csv`,
`reports/feature_importance_*.csv`, `reports/high_risk_examples.md`, and
the dataset/split summary verbatim from this file (sections 1-2 above), and
writes `dashboard/src/data/dashboard_data.json`. Every number the UI shows
traces back to one of those files; see the script's docstring for the
exact mapping. Run instructions are in `README.md`, "Dashboard" section.

---
Author: Phu Nguyen — HCMC, VN
