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

/** Stress-test comparison profile (`--profile realistic`) -- a harder
 * synthetic dataset used to pressure-test the model, never the primary
 * reported result (see `dataset.models`/v1 `model_card` for that). Present
 * only if the offline report included it; optional/nullable by design. */
export interface RealisticProfileReport {
  model_card: {
    profile: string;
    model_id: string;
    threshold: number;
    threshold_status: string;
    test_metrics: Record<string, number>;
    test_at_threshold: Record<string, number>;
    served_policy: string;
  };
  threshold_policies?: Record<
    string,
    {
      threshold: number;
      recall: number;
      precision: number;
      alerts_per_100: number;
      n_alerts: number;
      fp: number;
      status: string;
    }
  > | null;
  [key: string]: unknown;
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
  realistic?: RealisticProfileReport | null;
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
  scoring_mode?: string;
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
  model_version?: string | null;
}

// ---------------------------------------------------------------------------
// Ops domain: alerts, work orders, aircraft, reliability (src/ops, /ops/*).
// ---------------------------------------------------------------------------

export interface Alert {
  id: number;
  component_id: string;
  aircraft_id: string;
  status: string;
  risk_score: number;
  threshold: number;
  opened_at: string;
  closed_at: string | null;
  note?: string | null;
  component_type?: string;
  window_key?: string;
  source?: string;
  /** SHAP factors persisted at the moment the alert was raised (JSON string). */
  top_factors_json?: string | null;
  events?: AlertEvent[];
  work_orders?: WorkOrder[];
}

export interface AlertEvent {
  id: number;
  alert_id: number;
  action: string;
  actor: string;
  note: string | null;
  at: string;
}

export interface WorkOrder {
  id: string;
  aircraft_id: string;
  component_id: string;
  alert_id: number | null;
  task_ref: string | null;
  priority: string;
  status: string;
  created_by: string;
  approved_by: string;
  created_at: string;
  closed_at: string | null;
  outcome: string | null;
  notes: string | null;
}

export interface AircraftStatusRow {
  aircraft_id: string;
  status: string;
  mel_item: string | null;
  updated_at: string | null;
  updated_by: string | null;
  reason: string | null;
}

export interface AircraftOverview {
  aircraft_id: string;
  status: AircraftStatusRow;
  components: Record<string, unknown>[];
  open_alerts: Alert[];
  open_work_orders: WorkOrder[];
}

export interface ReliabilityKpis {
  [key: string]: unknown;
}

export interface FleetScanResult {
  scored: number;
  new_alerts: number[];
  existing: number;
}

// ---------------------------------------------------------------------------
// Monitoring / MLflow registry (/monitoring/*, /models).
// ---------------------------------------------------------------------------

export interface FeatureDrift {
  feature: string;
  psi: number;
  status: "ok" | "warn" | "alert" | string;
}

export interface DriftReport {
  overall_status: "ok" | "warn" | "alert" | string;
  score_status?: "ok" | "warn" | "alert" | string;
  score_psi?: number | null;
  feature_drift: FeatureDrift[];
  current_source: string;
  simulated_shift_applied: boolean;
  [key: string]: unknown;
}

export interface PerformanceReport {
  available: boolean;
  reason: string | null;
  live_outcomes: Record<string, unknown> | null;
}

export interface RegistryVersion {
  /** The registry returns numbers; older payloads used strings. */
  version: string | number;
  run_id: string;
  status: string;
  aliases: string[];
}

export interface RegistryStatus {
  tracking_enabled: boolean;
  registered_model: string;
  versions: RegistryVersion[];
  note?: string;
}

// ---------------------------------------------------------------------------
// Copilot (/copilot/*, /kb).
// ---------------------------------------------------------------------------

export interface CopilotRunSummary {
  id: string;
  status: string;
  trigger: string;
  alert_id: number | null;
  model_name: string;
  created_at: string;
  /** The prompt that started the run; the list endpoint returns it. */
  user_prompt?: string | null;
  final_answer: string | null;
}

export interface CopilotPendingItem {
  id: string;
  kind: "approval" | "ask_user" | string;
  tool_name: string | null;
  args: Record<string, unknown> | null;
  question: { question: string; options?: { id: string; label: string; description?: string }[] } | null;
  is_stale: boolean;
  /** Which run this pending item belongs to -- present on every row from
   * `GET /copilot/pending` and `GET /copilot/runs/{id}` (`_pending_view`'s
   * passthrough of the DB row). Used client-side to tell a genuinely
   * actionable run apart from one whose only pending row was auto-cancelled
   * by the legacy cleanup (see `RunList`'s "stale -- cancelled" label). */
  run_id?: string;
  tool_call_id?: string;
  /** Present (and not "pending") only for a pre-fix legacy row auto-
   * cancelled by the one-shot `cleanup_legacy_pending` startup migration --
   * rendered as a read-only "stale -- cancelled" card, never an editable
   * approval/option card. Absent/"pending" for every normal, actionable item. */
  status?: string;
  resolution_reason?: string | null;
}

export interface CopilotMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result";
  content?: string;
  tool_name?: string;
  args?: Record<string, unknown>;
  /** Pairs a call with its result and its resolved pending item. */
  tool_call_id?: string;
}

/** A pending item a human already resolved (`GET /copilot/runs/{id}` -> `resolved`). */
export interface CopilotResolvedItem {
  id: string;
  tool_call_id: string | null;
  kind: string;
  tool_name: string | null;
  decision: "approve" | "deny" | "answer" | string | null;
  note: string | null;
  option_id: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}

export interface CopilotRunDetail {
  run_id: string;
  status: string;
  trigger: string;
  alert_id: number | null;
  model_name: string;
  created_at: string;
  final_answer: string | null;
  messages: CopilotMessage[];
  pending: CopilotPendingItem[];
  /** Absent on servers older than the resolved-items field. */
  resolved?: CopilotResolvedItem[];
}

export interface CopilotMeta {
  mode: "openai" | "offline" | string;
  prompt_version: string;
  tools: string[];
  approval_gated_tools: string[];
  deferred_tools: string[];
  seeded_users: { id: string; label: string; role: string }[];
}

export interface CopilotAutomation {
  id: number;
  name: string;
  trigger: string;
  condition: Record<string, unknown>;
  prompt_template: string;
  enabled: boolean;
}

export interface CopilotStreamEvent {
  id: number | null;
  type: string;
  payload: Record<string, unknown>;
}

export interface KbSearchHit {
  doc_id: string;
  title: string;
  doc_type: string;
  score: number;
  snippet: string;
}

/** `GET /kb` and `GET /kb/{doc_id}` return the full document record. */
export interface KbDocSummary {
  id?: string;
  doc_id?: string;
  title: string;
  doc_type: string;
  ata_chapter?: string;
  component_types?: string[];
  fault_codes?: string[];
  body?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Endpoints added for the redesign (component history, aircraft index, drift
// timeline, per-version metrics, retrain gate).
// ---------------------------------------------------------------------------

export interface PredictionPoint {
  scored_at: string;
  snapshot_date: string;
  cycle: number;
  risk_score: number;
  threshold: number;
  alert: boolean;
  model_version: string | number | null;
}

export interface MaintenanceEvent {
  date: string;
  cycle: number;
  event_type: string;
  note: string | null;
}

/** `GET /ops/components/{id}/history`. */
export interface ComponentHistory {
  component_id: string;
  predictions: PredictionPoint[];
  maintenance_events: MaintenanceEvent[];
}

export interface DriftHistoryPoint {
  at: string;
  overall: string;
  score_psi: number | null;
  features: Record<string, number | null>;
  trigger: string;
  n_current: number;
}

/** `GET /monitoring/drift/history`, oldest first. */
export interface DriftHistory {
  points: DriftHistoryPoint[];
}

/** `GET /models/{version}/metrics`. Metric keys differ between versions. */
export interface ModelVersionMetrics {
  version: string | number;
  aliases: string[];
  test_metrics: Record<string, number>;
  threshold: number | null;
  trained_at: string | null;
  run_id: string;
}

/** `GET /ops/aircraft` row. `max_risk` is null before any fleet scan. */
export interface AircraftIndexRow {
  aircraft_id: string;
  status: string;
  n_open_alerts: number;
  n_open_wos: number;
  max_risk: number | null;
}

export type RetrainStatus = "queued" | "running" | "succeeded" | "failed" | string;

export interface RetrainGate {
  promote: boolean;
  reasons: string[];
}

export interface RetrainResult {
  gate?: RetrainGate;
  challenger_metrics?: Record<string, number | null>;
  champion_metrics?: Record<string, number | null> | null;
  targets?: Record<string, number>;
  promoted?: boolean;
  model_version?: string | number | null;
  served_model_changed?: boolean;
  note?: string | null;
  v1_model_card_unchanged?: boolean;
}

/** `POST /models/retrain` returns `{run_id, status}`; the poll adds the rest. */
export interface RetrainJob {
  run_id: string;
  status: RetrainStatus;
  requested_by?: string;
  profile?: string;
  baseline_available?: boolean;
  promote_allowed?: boolean;
  result?: RetrainResult | null;
  error?: string | null;
}
