import { useState } from "react";
import { formatDecimal, formatPct } from "../lib/format";
import { gateVerdict, retrainMetricRows, RETRAIN_USER } from "../lib/retrain";
import type { RetrainState } from "../hooks/useRetrainJob";
import { Button, Chip, Panel } from "./ui/primitives";
import { Notice, ServiceStatusBanner } from "./ui/states";

function fmtMetric(v: number | null, kind: "pct" | "dec"): string {
  if (v === null) return "none recorded";
  return kind === "pct" ? formatPct(v, 1) : formatDecimal(v, 3);
}

/** Retrain gate. Only lead.engineer may start a run (the service enforces it;
 * the button explains why it is disabled for everyone else). The job is
 * polled until it ends and then read honestly: gate decision, what was and
 * was not promoted, the job's own note, and that the served model is
 * unchanged. A retrain rewrites reports/realistic, so it needs a confirm.
 * The job state lives in `useRetrainJob` so the page header can start and
 * follow the same run. */
export function RetrainPanel({ retrain }: { retrain: RetrainState }) {
  const { user, allowed, job, error, starting, running, elapsed } = retrain;
  const [promote, setPromote] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const start = () => {
    setConfirming(false);
    void retrain.start(promote);
  };

  const verdict = job ? gateVerdict(job) : null;
  const rows = job ? retrainMetricRows(job) : [];
  const result = job?.result;

  return (
    <Panel
      title="Retrain gate"
      sub="Retrain the realistic profile and check the challenger against the champion."
      actions={
        confirming ? null : (
          <Button
            variant="primary"
            size="sm"
            disabled={!allowed || running}
            loading={starting}
            title={!allowed ? `Only ${RETRAIN_USER} can start a retrain` : undefined}
            onClick={() => setConfirming(true)}
          >
            {running ? "Retraining…" : "Run retrain"}
          </Button>
        )
      }
    >
      <div className="stack">
        {!allowed && (
          <Notice tone="plain">
            Only <span className="mono">{RETRAIN_USER}</span> can start a retrain. You are acting as <span className="mono">{user}</span>. Switch identity in the top bar.
          </Notice>
        )}

        <label className="check">
          <input type="checkbox" checked={promote} disabled={running || !allowed} onChange={(e) => setPromote(e.target.checked)} />
          Promote the challenger if the gate passes
        </label>

        {confirming && (
          <Notice tone="warn" role="alert" actions={
            <>
              <Button size="sm" variant="primary" onClick={start}>
                Yes, run retrain
              </Button>
              <Button size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          }>
            This retrains the realistic profile and rewrites <code>reports/realistic</code>. The served model never changes until the service restarts.
          </Notice>
        )}

        {error && <ServiceStatusBanner message={error} />}

        {job && verdict && (
          <div className="stack" aria-live="polite">
            <div className="row row-between">
              <span className="row">
                <Chip tone={verdict.tone === "warn" ? "warn" : verdict.tone === "good" ? "good" : verdict.tone === "bad" ? "bad" : "neutral"}>{verdict.label}</Chip>
                <span className="muted mono">run {job.run_id}</span>
              </span>
              {running && <span className="muted">{elapsed}s elapsed</span>}
            </div>
            <p>{verdict.detail}</p>

            {rows.length > 0 && (
              <div className="table-scroll">
                <table className="dt" aria-label="Challenger against champion">
                  <thead>
                    <tr>
                      <th scope="col">Metric</th>
                      <th scope="col" className="num">Challenger</th>
                      <th scope="col" className="num">Champion</th>
                      <th scope="col" className="num">Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td>{r.label}</td>
                        <td className="num">{fmtMetric(r.challenger, r.kind)}</td>
                        <td className="num">{fmtMetric(r.champion, r.kind)}</td>
                        <td className="num">{r.target === null ? "n/a" : `${r.passes === "lower" ? "≤" : "≥"} ${fmtMetric(r.target, r.kind)}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result?.gate && result.gate.reasons.length > 0 && (
              <div>
                <h3 className="form-section-title">Gate reasons</h3>
                <ul className="prose" style={{ listStyle: "disc", paddingLeft: 20 }}>
                  {result.gate.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {result?.note && (
              <Notice tone="warn">
                <strong>Job note.</strong> {result.note}
              </Notice>
            )}

            {result && (
              <div className="row">
                <Chip tone={result.promoted ? "good" : "neutral"} icon={null}>
                  {result.promoted ? "promoted" : "not promoted"}
                </Chip>
                <Chip tone="neutral" icon={null}>
                  {result.served_model_changed ? "served model changed" : "served model unchanged (restart required)"}
                </Chip>
                {result.v1_model_card_unchanged !== undefined && (
                  <Chip tone={result.v1_model_card_unchanged ? "good" : "bad"}>{result.v1_model_card_unchanged ? "v1 model card unchanged" : "v1 model card changed"}</Chip>
                )}
                {job.baseline_available === false && <Chip tone="warn">no champion baseline recorded</Chip>}
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
