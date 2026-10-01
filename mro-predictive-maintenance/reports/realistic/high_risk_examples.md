# High-risk example predictions (hist_gradient_boosting)

Top-scoring components on the held-out TEST split, with the local factors driving each score.

## AC-208-AVIONICS_FAN  (cycle 1527.4, 2026-09-18 00:00:00)

- risk_score: **0.5850**
- true label: 0 (no unscheduled removal in window)
- component_type: AVIONICS_FAN
- explanation method: shap
- top contributing features:
  - `num__check_count_last_1500cyc`: SHAP contribution +7.9013
  - `num__aircraft_age_years`: SHAP contribution +0.3878
  - `num__vibration_mm_s`: SHAP contribution -0.1422
  - `num__temperature_delta_c`: SHAP contribution +0.0533
  - `num__component_age_cycles`: SHAP contribution -0.0264

## AC-100-AVIONICS_FAN  (cycle 2251.1, 2026-09-25 00:00:00)

- risk_score: **0.5850**
- true label: 0 (no unscheduled removal in window)
- component_type: AVIONICS_FAN
- explanation method: shap
- top contributing features:
  - `num__check_count_last_1500cyc`: SHAP contribution +7.9316
  - `num__aircraft_age_years`: SHAP contribution +0.3707
  - `num__vibration_mm_s`: SHAP contribution -0.1466
  - `num__temperature_delta_c`: SHAP contribution +0.0606
  - `num__component_age_cycles`: SHAP contribution -0.0363

## AC-203-AVIONICS_FAN  (cycle 2446.9, 2026-09-26 00:00:00)

- risk_score: **0.5850**
- true label: 0 (no unscheduled removal in window)
- component_type: AVIONICS_FAN
- explanation method: shap
- top contributing features:
  - `num__check_count_last_1500cyc`: SHAP contribution +7.9281
  - `num__aircraft_age_years`: SHAP contribution +0.3869
  - `num__vibration_mm_s`: SHAP contribution -0.1421
  - `num__temperature_delta_c`: SHAP contribution +0.0607
  - `num__component_age_cycles`: SHAP contribution -0.0355

## AC-198-HYD_PUMP  (cycle 2728.8, 2026-09-28 00:00:00)

- risk_score: **0.5850**
- true label: 0 (no unscheduled removal in window)
- component_type: HYD_PUMP
- explanation method: shap
- top contributing features:
  - `num__check_count_last_1500cyc`: SHAP contribution +7.8090
  - `num__aircraft_age_years`: SHAP contribution +0.3271
  - `num__pressure_delta_psi`: SHAP contribution +0.1606
  - `num__vibration_mm_s`: SHAP contribution -0.1515
  - `num__temperature_delta_c`: SHAP contribution +0.0901

## AC-063-LG_ACTUATOR  (cycle 3063.1, 2026-09-27 00:00:00)

- risk_score: **0.5850**
- true label: 0 (no unscheduled removal in window)
- component_type: LG_ACTUATOR
- explanation method: shap
- top contributing features:
  - `num__check_count_last_1500cyc`: SHAP contribution +7.9285
  - `num__aircraft_age_years`: SHAP contribution +0.3633
  - `num__vibration_mm_s`: SHAP contribution -0.1378
  - `num__temperature_delta_c`: SHAP contribution +0.0642
  - `num__component_age_cycles`: SHAP contribution -0.0401
