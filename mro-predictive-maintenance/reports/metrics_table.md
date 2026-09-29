# Model comparison (this run)

Test split: 2515 rows, 28 positive (1.113%)

| model                  |   val_roc_auc |   val_pr_auc |   test_roc_auc |   test_pr_auc |   chosen_threshold | threshold_status     |   test_recall |   test_precision |   test_alerts_per_100 |   test_n_alerts |   test_n_positive |
|:-----------------------|--------------:|-------------:|---------------:|--------------:|-------------------:|:---------------------|--------------:|-----------------:|----------------------:|----------------:|------------------:|
| logistic_regression    |      0.994416 |     0.925634 |       0.995692 |      0.882064 |             0.9801 | both_constraints_met |      0.714286 |                1 |              0.795229 |              20 |                28 |
| hist_gradient_boosting |      0.998592 |     0.968171 |       0.999598 |      0.973269 |             0.9405 | both_constraints_met |      0.821429 |                1 |              0.914513 |              23 |                28 |
