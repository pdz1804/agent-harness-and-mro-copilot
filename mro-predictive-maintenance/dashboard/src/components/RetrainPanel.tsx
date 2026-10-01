import { useCallback, useEffect, useRef, useState } from "react";
import { getRetrainJob, startRetrain } from "../lib/api";
import { IDENTITY_CHANGE_EVENT, getCurrentUser } from "../lib/identity";
import { formatDecimal, formatPct } from "../lib/format";
import { canStartRetrain, extractRunId, gateVerdict, isTerminal, nextPollDelay, retrainMetricRows, RETRAIN_USER } from "../lib/retrain";
import { Button, Chip, Panel } from "./ui/primitives";
import { Notice, ServiceStatusBanner } from "./ui/states";
import { LockIcon } from "./ui/icons";
import type { RetrainJob } from "../types";

function fmtMetric(v: number | null, kind: "pct" | "dec"): string {
  if (v === null) return "none recorded";
  return kind === "pct" ? formatPct(v, 1) : formatDecimal(v, 3);
}

/** Retrain gate. Only lead.engineer may start a run (the service enforces it;
 * the button explains why it is disabled for everyone else). The job is
 * polled until it ends and then read honestly: gate decision, what was and
 * was not promoted, the job's own note, and that the served model is
 * unchanged. A retrain rewrites reports/realistic, so it needs a confirm. */
export function RetrainPanel() {
  const [user, setUser] = useState(getCurrentUser());
  const [promote, setPromote] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [job, setJob] = useState<RetrainJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const pollRef = useRef<number | null>(null);
  const attemptRef = useRef(0);

  useEffect(() => {
    const on = () => setUser(getCurrentUser());
    window.addEventListener(IDENTITY_CHANGE_EVENT, on);
    return () => window.removeEventListener(IDENTITY_CHANGE_EVENT, on);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    pollRef.current = null;
  }, []);

  const poll = useCallback(
    (runId: string) => {
      stopPolling();
      pollRef.current = window.setTimeout(async () => {
        try {
          const next = await getRetrainJob(runId);
          setJob(next);
          if (!isTerminal(next.status)) {
            attemptRef.current += 1;
            poll(runId);
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }, nextPollDelay(attemptRef.current));
    },
    [stopPolling],
  );

  useEffect(() => stopPolling, [stopPolling]);

  const running = !!job && !isTerminal(job.status);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const start = async () => {
    setStarting(true);
    setError(null);
    setConfirming(false);
    setElapsed(0);
    attemptRef.current = 0;
    try {
      const j = await startRetrain({ promote_if_better: promote });
      setJob(j);
      poll(j.run_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/^409\b/.test(msg)) {
        const id = extractRunId(msg);
        if (id) {
          setJob({ run_id: id, status: "running" });
          setError("A retrain is already running. Following that run instead.");
          poll(id);
        } else {
          setError("A retrain is already running. Try again when it finishes.");
        }
      } else if (/^403\b/.test(msg)) {
        setError(`Only ${RETRAIN_USER} can start a retrain. You are acting as ${getCurrentUser()}.`);
      } else {
        setError(msg);
      }
    } finally {
      setStarting(false);
    }
  };

  const allowed = canStartRetrain(user);
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
            {!allowed && <LockIcon />}
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
