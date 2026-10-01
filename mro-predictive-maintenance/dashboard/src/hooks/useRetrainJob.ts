import { useCallback, useEffect, useRef, useState } from "react";
import { getRetrainJob, startRetrain } from "../lib/api";
import { IDENTITY_CHANGE_EVENT, getCurrentUser } from "../lib/identity";
import { canStartRetrain, extractRunId, gateVerdict, isTerminal, nextPollDelay, RETRAIN_USER } from "../lib/retrain";
import { useToast } from "../components/ui/feedback";
import type { RetrainJob } from "../types";

export interface RetrainState {
  user: string;
  allowed: boolean;
  job: RetrainJob | null;
  error: string | null;
  starting: boolean;
  running: boolean;
  elapsed: number;
  start: (promote: boolean) => Promise<void>;
}

/** One retrain job shared by every control on the page (the Monitoring
 * header button and the Retrain gate panel): starts `POST /models/retrain`,
 * polls `GET /models/retrain/{id}` until it ends, ticks an elapsed counter,
 * and toasts the start and the gate decision. */
export function useRetrainJob(): RetrainState {
  const toast = useToast();
  const [user, setUser] = useState(getCurrentUser());
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
            return;
          }
          const v = gateVerdict(next);
          toast.show({
            tone: next.status === "failed" ? "error" : v.tone === "good" ? "good" : v.tone === "bad" ? "warn" : "info",
            message: `Retrain finished: ${v.label}`,
            detail: v.detail,
            link: { label: "See the gate", href: "#/model/monitoring" },
            durationMs: 9000,
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }, nextPollDelay(attemptRef.current));
    },
    [stopPolling, toast],
  );

  useEffect(() => stopPolling, [stopPolling]);

  const running = !!job && !isTerminal(job.status);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const start = useCallback(
    async (promote: boolean) => {
      setStarting(true);
      setError(null);
      setElapsed(0);
      attemptRef.current = 0;
      try {
        const j = await startRetrain({ promote_if_better: promote });
        setJob(j);
        toast.show({ tone: "info", message: "Retrain started", detail: `run ${j.run_id} · polling for the gate decision`, durationMs: 4000 });
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
          toast.show({ tone: "error", message: "Retrain could not start.", detail: msg });
        }
      } finally {
        setStarting(false);
      }
    },
    [poll, toast],
  );

  return { user, allowed: canStartRetrain(user), job, error, starting, running, elapsed, start };
}
