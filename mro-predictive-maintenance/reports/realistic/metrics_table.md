# Model comparison (this run, profile=realistic)

Test split: 2598 rows, 25 positive (0.962%). Served policy for ML models: max_recall_within_budget. Cost figures are illustrative (COST_MISSED_REMOVAL=$50,000, COST_FALSE_ALERT=$1,500), not calibrated to real MRO finance data.

| model                     |   val_roc_auc |   val_pr_auc |   test_roc_auc |   test_pr_auc |   chosen_threshold | threshold_status   |   test_recall |   test_precision |   test_alerts_per_100 |   test_n_alerts |   test_n_positive |
|:--------------------------|--------------:|-------------:|---------------:|--------------:|-------------------:|:-------------------|--------------:|-----------------:|----------------------:|----------------:|------------------:|
| logistic_regression       |      0.964833 |    0.733282  |       0.812079 |     0.499023  |             0.0149 | target_missed      |          0.68 |         0.17     |             3.84911   |             100 |                25 |
| hist_gradient_boosting    |      0.983627 |    0.687355  |       0.981345 |     0.202729  |             0.01   | target_met         |          0.92 |         0.237113 |             3.73364   |              97 |                25 |
| baseline_age_rule         |      0.734073 |    0.0510722 |       0.574038 |     0.0527273 |             0.8811 | target_missed      |          0.04 |         1        |             0.0384911 |               1 |                25 |
| baseline_fault_count_rule |      0.859578 |    0.298601  |       0.939845 |     0.236762  |             0.7376 | target_missed      |          0.48 |         0.230769 |             2.00154   |              52 |                25 |
