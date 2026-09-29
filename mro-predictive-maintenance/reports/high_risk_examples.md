# High-risk example predictions (hist_gradient_boosting)

Top-scoring components on the held-out TEST split, with the local factors driving each score.

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
