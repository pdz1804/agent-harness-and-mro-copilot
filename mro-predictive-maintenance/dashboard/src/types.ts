// Mirrors the JSON shape written by dashboard/scripts/build_dashboard_data.py.
// Keep in sync with that script -- if a field is added/removed there, update here.

export interface SplitSummary {
  rows: number;
  aircraft: number;
  positives: number;
}

export interface DatasetSummary {
  seed: number;
  run_date: string;
  aircraft: number;
  components_total: number;
  components_unscheduled: number;
  components_scheduled: number;
  components_survived: number;
  cycle_snapshots: number;
  fault_code_events: number;
  maintenance_events: number;
  positive_count: number;
  positive_rate_denominator: number;
  positive_rate_pct: number;
  primary_model_id: string;
  splits: {
    train: SplitSummary;
    val: SplitSummary;
    test: SplitSummary;
  };
}

export interface OperatingTarget {
  min_recall: number;
  max_alerts_per_100: number;
}

export interface ValAtChosenThreshold {
  recall: number;
  precision: number;
  alerts_per_100: number;
  n_alerts: number;
  tp: number;
  fp: number;
  fn: number;
}

export interface ModelResult {
  id: string;
  label: string;
  is_primary: boolean;
  val_roc_auc: number;
  val_pr_auc: number;
  test_roc_auc: number;
  test_pr_auc: number;
  chosen_threshold: number;
  threshold_status: string;
  test_recall: number;
  test_precision: number;
  test_alerts_per_100: number;
  test_n_alerts: number;
  test_n_positive: number;
  target_met: boolean;
  val_at_chosen_threshold: ValAtChosenThreshold;
}

export interface ThresholdSweepRow {
  threshold: number;
  recall: number;
  precision: number;
  alerts_per_100: number;
  n_alerts: number;
  tp: number;
  fp: number;
  fn: number;
}

export interface FeatureImportanceRow {
  feature: string;
  importance_mean: number;
  importance_std: number;
}

export interface HighRiskFeature {
  feature: string;
  contribution: number;
}

export interface HighRiskExample {
  component_id: string;
  cycle: number;
  date: string;
  risk_score: number;
  true_label: number;
  component_type: string;
  explanation_method: string;
  top_features: HighRiskFeature[];
}

export interface DashboardData {
  $schema_note: string;
  dataset: DatasetSummary;
  target: OperatingTarget;
  models: ModelResult[];
  primary_model_id: string;
  threshold_sweeps: Record<string, ThresholdSweepRow[]>;
  threshold_sweep_split: string;
  feature_importance: Record<string, FeatureImportanceRow[]>;
  high_risk_examples: HighRiskExample[];
}

// ---------------------------------------------------------------------------
// Live scoring service (src/service/app.py). Mirrors src/service/schemas.py.
// ---------------------------------------------------------------------------

/** Model-ready feature payload for one component snapshot -- keys match
 * src.modeling.NUMERIC_FEATURES / CATEGORICAL_FEATURES exactly. */
export type ComponentFeatures = Record<string, number | string | null>;

export interface ShapFactor {
  feature: string;
  shap_value: number;
}

export interface ScoreResponse {
  model_id: string;
  component_id: string | null;
  risk_score: number;
  threshold: number;
  alert: boolean;
  explanation_method: string;
  top_factors: ShapFactor[];
}

export interface ModelCardResponse {
  model_id: string;
  trained_at: string;
  seed: number;
  threshold: number;
  threshold_status: string;
  target: { min_recall: number; max_alerts_per_100: number };
  val_metrics: Record<string, number>;
  test_metrics: Record<string, number>;
  test_at_threshold: Record<string, number>;
  numeric_features: string[];
  categorical_features: string[];
}

export interface FleetRiskItem {
  component_id: string;
  aircraft_id: string;
  component_type: string;
  cycle: number;
  snapshot_date: string;
  risk_score: number;
  alert: boolean;
  true_label: number;
  features: ComponentFeatures;
}

export interface FleetRiskResponse {
  model_id: string;
  threshold: number;
  split: string;
  n_scored: number;
  n_returned: number;
  items: FleetRiskItem[];
}

export interface HealthResponse {
  status: string;
  model_id: string | null;
  model_loaded: boolean;
}
