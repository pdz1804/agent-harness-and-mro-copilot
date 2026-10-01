import { getModelCard } from "../lib/api";
import { useAsync } from "../hooks/useAsync";
import { formatDecimal, formatPct } from "../lib/format";
import { PageHead, Panel } from "./ui/primitives";
import { DocLayout, DocSection } from "./ui/doc-layout";
import { LoadingRows, ServiceStatusBanner } from "./ui/states";

const ENDPOINTS: { method: string; path: string; desc: string }[] = [
  { method: "GET", path: "/health", desc: "liveness, loaded model and version" },
  { method: "GET", path: "/model-card", desc: "threshold, val/test metrics, feature list (shown live above)" },
  { method: "POST", path: "/score", desc: "score one component payload, with SHAP top factors" },
  { method: "GET", path: "/fleet/top-risk", desc: "live-scores the held-out test split, ranked" },
  { method: "POST", path: "/ops/fleet-scan", desc: "score the fleet, log predictions, raise alerts" },
  { method: "GET", path: "/ops/alerts", desc: "alert inbox, with lifecycle transitions" },
  { method: "POST", path: "/ops/work-orders/{id}/close", desc: "close with an outcome; feeds live precision" },
  { method: "GET", path: "/fleet/components/{id}", desc: "one scored component with its features" },
  { method: "GET", path: "/ops/components/{id}/history", desc: "per-scan risk history and maintenance events" },
  { method: "GET", path: "/ops/aircraft", desc: "aircraft index: status, open work, highest risk" },
  { method: "GET", path: "/monitoring/drift", desc: "PSI per feature and on the score; ?simulate=shift" },
  { method: "GET", path: "/monitoring/drift/history", desc: "drift snapshots recorded per fleet scan" },
  { method: "GET", path: "/models/{version}/metrics", desc: "recorded test metrics for one registry version" },
  { method: "POST", path: "/models/retrain", desc: "lead engineer only; poll GET /models/retrain/{run_id}" },
  { method: "GET", path: "/monitoring/performance", desc: "live precision and NFF from closed work orders" },
  { method: "POST", path: "/copilot/runs", desc: "start a copilot run; events stream over SSE" },
  { method: "POST", path: "/kb/search", desc: "hybrid retrieval over AMM and MEL documents" },
];

const TOC = [
  { id: "serving-state", label: "Live serving state" },
  { id: "endpoints", label: "Service endpoints" },
  { id: "retraining", label: "Retraining" },
  { id: "cold-start", label: "Cold start" },
  { id: "missing-data", label: "Missing data" },
  { id: "drift", label: "Model and data drift" },
];

/** Production design: promotes docs/design-report.md section 6 and 6.1 into
 * a readable document, backed by a live GET /model-card so the served
 * threshold and metrics are never stale copies. */
export function ProductionDesignSection() {
  const card = useAsync(() => getModelCard(), []);
  const c = card.data;

  return (
    <div className="page">
      <PageHead title="Production design" description="Deployment, retraining, cold start, missing data and drift handling." />
      <div>
        <DocLayout toc={TOC}>
          <DocSection id="serving-state" title="Live serving state">
            <p className="prose">
              Fetched live from <code>GET /model-card</code> on this page load, not a copy of{" "}
              <code>reports/model_card.json</code>.
            </p>
            {card.loading && !c && <LoadingRows rows={5} height={28} />}
            {card.error && <ServiceStatusBanner message={card.error} onRetry={card.reload} />}
            {c && (
              <Panel>
                <dl className="kv">
                  <dt>model_id</dt>
<dd className="mono">{c.model_id}</dd>
                    <dt>trained_at</dt>
<dd className="mono">{c.trained_at}</dd>
                    <dt>seed</dt>
<dd className="mono">{c.seed}</dd>
                    <dt>operating threshold</dt>
<dd className="mono">
                        {formatDecimal(c.threshold, 4)} ({c.threshold_status})
                      </dd>
                    <dt>target</dt>
<dd className="mono">
                        recall &ge; {formatPct(c.target.min_recall, 0)}, alerts/100 &le; {formatDecimal(c.target.max_alerts_per_100, 1)}
                      </dd>
                    <dt>test at threshold</dt>
<dd className="mono">
                        recall {formatPct(Number(c.test_at_threshold.recall))} &middot; precision{" "}
                        {formatPct(Number(c.test_at_threshold.precision))} &middot;{" "}
                        {formatDecimal(Number(c.test_at_threshold.alerts_per_100))} alerts/100 (
                        {String(c.test_at_threshold.n_alerts)} alerts / {String(c.test_at_threshold.n_rows)} rows)
                      </dd>
                    <dt>numeric features</dt>
<dd className="mono">
                        {c.numeric_features.join(", ")}
                      </dd>
                    <dt>categorical features</dt>
<dd className="mono">
                        {c.categorical_features.join(", ")}
                      </dd>
                                  </dl>
              </Panel>
            )}
          </DocSection>

          <DocSection id="endpoints" title="Service endpoints">
            <p className="prose">
              FastAPI and uvicorn on <code>:8100</code>, pydantic validation, and the same fitted scikit-learn{" "}
              <code>Pipeline</code> objects trained offline (no re-implementation of preprocessing at serving
              time). Reached over CORS (<code>SERVICE_CORS_ORIGINS</code> on the service,{" "}
              <code>VITE_SERVICE_BASE_URL</code> here), not a dev proxy, so the same client works for dev, preview
              and a static production build.
            </p>
            <Panel flush>
              <div className="rows">
                {ENDPOINTS.map((e) => (
                  <div className="endpoint" key={`${e.method}${e.path}`}>
                    <span className="endpoint-method">{e.method}</span>
                    <span className="endpoint-path">{e.path}</span>
                    <span className="endpoint-desc">{e.desc}</span>
                  </div>
                ))}
              </div>
            </Panel>
          </DocSection>

          <DocSection id="retraining" title="Retraining">
            <div className="prose">
              <p>
                <code>python -m src.pipeline --retrain</code> regenerates every artifact (models, reports, model
                card) in place. The service loads artifacts once at startup, so a retrain needs a restart of the{" "}
                <code>uvicorn</code> process: a deliberate simplicity trade-off for a POC, with one process and one
                model version at a time.
              </p>
              <p>
                <strong>Built:</strong> a champion/challenger retrain gate.
              </p>
              <ul>
                <li>
                  <code>POST /models/retrain</code> (lead engineer only) trains a challenger on the realistic profile
                  as a background job; the Monitoring page polls it and shows the gate decision and the job&apos;s
                  note.
                </li>
                <li>
                  The gate compares challenger metrics with a recorded champion baseline. No baseline is recorded
                  yet, so the gate reports that a promotion is not possible instead of promoting.
                </li>
                <li>
                  A retrain never hot-swaps the served model. Even an eligible challenger would need a service restart
                  to be served.
                </li>
              </ul>
              <p>
                <strong>Future work, not built:</strong> what live traffic would add.
              </p>
              <ul>
                <li>
                  a model registry so <code>ModelStore</code> picks a version by explicit id, not whatever is on
                  disk;
                </li>
                <li>a blue/green or canary rollout instead of restart-in-place;</li>
                <li>recording a champion baseline and acting on a gate pass without a manual restart.</li>
              </ul>
            </div>
          </DocSection>

          <DocSection id="cold-start" title="Cold start: new components and aircraft">
            <p className="prose">
              The deployed model&apos;s own validation and test splits <em>are</em> a cold-start scenario: those
              aircraft were never seen in training. For a genuinely new component type, or a component with too
              little history to compute rolling fault and check features (fewer than about 1 to 2 checks), the
              signal is thin and it should be routed to standard scheduled-maintenance policy rather than scored
              confidently, until history accrues.
            </p>
          </DocSection>

          <DocSection id="missing-data" title="Missing data">
            <p className="prose">
              Sensor columns are NaN both structurally (a sensor not applicable to that component type) and
              randomly (2% simulated dropout). Logistic regression imputes with the training-fold median;
              histogram gradient boosting handles NaN natively per feature. A spike in a feature&apos;s
              missing-rate should itself be monitored in production: it often signals a sensor or data-pipeline
              fault, not benign missingness. The Monitoring page already reports the missing-rate delta per
              feature.
            </p>
          </DocSection>

          <DocSection id="drift" title="Model and data drift">
            <div className="prose">
              <ul>
                <li>Covariate drift: PSI per input feature against the training reference (live on Monitoring).</li>
                <li>Prediction drift: PSI on the output score and the alert rate over time; a jump needs investigation.</li>
                <li>
                  Performance decay: live precision and NFF rate from work orders closed with an outcome (live on
                  Work orders and Monitoring); re-sweep the threshold if it degrades.
                </li>
                <li>Label drift: retrain on a rolling window once enough confirmed outcomes accrue.</li>
              </ul>
              <p className="muted">
                Full detail, including limitations and future work, is in <code>docs/design-report.md</code> &sect;6
                and &sect;7.
              </p>
            </div>
          </DocSection>
        </DocLayout>
      </div>
    </div>
  );
}
