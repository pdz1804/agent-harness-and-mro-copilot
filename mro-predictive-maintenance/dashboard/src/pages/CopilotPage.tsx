import { useEffect, useRef, useState } from "react";
import {
  cancelCopilotRun,
  getCopilotMeta,
  getCopilotRun,
  getGlobalPending,
  listCopilotRuns,
  resolveCopilotRun,
  sendCopilotFollowUp,
  startCopilotRun,
  type CopilotResolution,
} from "../lib/api";
import { useCopilotStream } from "../hooks/useCopilotStream";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { RunList } from "../components/copilot/RunList";
import { ToolStep } from "../components/copilot/ToolStep";
import { SafeMarkdown } from "../components/copilot/SafeMarkdown";
import { ApprovalCard } from "../components/copilot/ApprovalCard";
import { OptionCard } from "../components/copilot/OptionCard";
import { Button, Chip } from "../components/ui/primitives";
import { ServiceStatusBanner } from "../components/ui/states";
import { ArrowDownIcon, SendIcon, StopIcon } from "../components/ui/icons";
import { copilotModeLabel, copilotModeNote } from "../lib/labels";
import { humanizeError, type HumanError } from "../lib/errors";
import { IDENTITY_CHANGE_EVENT, canApprove } from "../lib/identity";
import { hrefFor } from "../lib/routes";
import type { CopilotMeta, CopilotPendingItem, CopilotRunDetail, CopilotRunSummary } from "../types";

/** Plain-language one-liner for a drafted decision, used by the batch bar so
 * "what happens when I click Submit" is never a guess. */
function summarizeDraft(res: CopilotResolution): string {
  if (res.decision === "deny") return "Deny";
  if (res.decision === "approve") return res.override_args ? "Approve (with edits)" : "Approve";
  if (res.option_id) return `Answer: ${res.option_id}`;
  return res.answer_text ? `Answer: "${res.answer_text}"` : "Answer";
}

const STARTERS = [
  "Which components are at highest risk right now, and what should I inspect first?",
  "Summarize the open alerts and tell me what to do about each.",
  "Search the knowledge base for hydraulic pump elevated vibration.",
  "Give me a status overview for the aircraft with the most alerts.",
];

type Sheet = null | "runs" | "context";

interface CopilotPageProps {
  prefillPrompt: string | null;
  onPrefillConsumed: () => void;
  onPendingCountChange: (count: number) => void;
}

/** Copilot cockpit: runs (left), conversation (center), run context (right;
 * both side panels become bottom sheets under 1100px). Streaming via
 * `EventSource` (`useCopilotStream`), direct setState per token, no rAF
 * batching. The conversation is the only thing that scrolls: it sticks to
 * the bottom while tokens stream, stops following when you scroll up, and
 * offers a "Jump to latest" pill. Approval and clarification cards render
 * inline, at the end of the conversation where the decision is needed. */
export function CopilotPage({ prefillPrompt, onPrefillConsumed, onPendingCountChange }: CopilotPageProps) {
  const [meta, setMeta] = useState<CopilotMeta | null>(null);
  const [runs, setRuns] = useState<CopilotRunSummary[]>([]);
  // Actionable pending items across ALL runs (`GET /copilot/pending`, which
  // already excludes legacy-cancelled rows). This -- not a run's raw
  // `status` field -- is the source of truth for "N awaiting approval": a
  // run can still carry `status === "awaiting_input"` in the DB after its
  // only pending row was auto-cancelled by the startup cleanup migration,
  // and counting that as "pending" was the header-pill bug.
  const [globalPending, setGlobalPending] = useState<CopilotPendingItem[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CopilotRunDetail | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<HumanError | null>(null);
  const [starting, setStarting] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, CopilotResolution | null>>({});
  const [submitting, setSubmitting] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  // Re-render when the acting identity changes so the Submit button's
  // viewer-disabled state (below) stays in sync without reselecting the
  // run -- mirrors `ApprovalCard`'s own identity-change listener.
  const [, forceIdentityTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bumped every time a NEW turn is scheduled on the active run (start,
  // resolve, follow-up) so `useCopilotStream` opens a fresh SSE connection
  // for that turn -- the server's stream is bounded to one turn and closes
  // at its first run_status event (awaiting_input OR completed), so
  // reusing the same connection across a resolve/follow-up would never see
  // the new turn's events (see the hook's docstring for the full story).
  const [streamEpoch, setStreamEpoch] = useState(0);

  const { streamingText, terminal } = useCopilotStream(activeRunId, streamEpoch);

  const reloadRuns = () => {
    listCopilotRuns()
      .then(setRuns)
      .catch((err: unknown) => setError(humanizeError(err)));
    getGlobalPending()
      .then(setGlobalPending)
      .catch(() => {
        /* the run list's own error banner already surfaces connectivity issues */
      });
  };

  useEffect(() => {
    getCopilotMeta()
      .then(setMeta)
      .catch((err: unknown) => setError(humanizeError(err)));
    reloadRuns();
    const poll = setInterval(reloadRuns, 10_000);
    return () => clearInterval(poll);
  }, []);

  useEffect(() => {
    if (prefillPrompt) {
      setPrompt(prefillPrompt);
      onPrefillConsumed();
      inputRef.current?.focus();
    }
  }, [prefillPrompt, onPrefillConsumed]);

  const refreshDetail = (runId: string) => {
    getCopilotRun(runId)
      .then((d) => {
        setDetail(d);
        setDrafts({});
      })
      .catch((err: unknown) => setError(humanizeError(err)));
  };

  useEffect(() => {
    setError(null);
    if (activeRunId) refreshDetail(activeRunId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId]);

  // Clear a stale error banner (e.g. a 403 raised under a previous identity)
  // the moment the acting identity changes -- a permission error shown
  // against someone who never attempted that action is just confusing.
  useEffect(() => {
    const onIdentityChange = () => {
      setError(null);
      forceIdentityTick((t) => t + 1);
    };
    window.addEventListener(IDENTITY_CHANGE_EVENT, onIdentityChange);
    return () => window.removeEventListener(IDENTITY_CHANGE_EVENT, onIdentityChange);
  }, []);

  // Once the streamed turn reaches a terminal event, re-fetch the
  // authoritative run snapshot (messages/pending) instead of trusting the
  // transient token buffer. A defensive second refresh ~1.5s later is a
  // backstop in case a fresh EventSource missed the terminal event (e.g. a
  // very fast offline-scripted turn completing before the connection
  // opens) -- cheap, idempotent, and the only way "Run context" status was
  // observed to stay on the pre-resolve value.
  useEffect(() => {
    if (terminal && activeRunId) {
      refreshDetail(activeRunId);
      reloadRuns();
      const backstop = setTimeout(() => {
        refreshDetail(activeRunId);
        reloadRuns();
      }, 1500);
      return () => clearTimeout(backstop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal]);

  useEffect(() => {
    onPendingCountChange(globalPending.filter((p) => !p.is_stale).length);
  }, [globalPending, onPendingCountChange]);

  const actionableRunIds = new Set(globalPending.map((p) => p.run_id).filter((id): id is string => Boolean(id)));

  // Legacy pre-fix pending rows the one-shot startup cleanup already
  // cancelled (`status` present and not "pending") -- read-only, never
  // actionable, rendered as an inert "stale -- cancelled" note rather than
  // an editable card.
  const legacyCancelled = detail?.pending.filter((p) => p.status && p.status !== "pending") ?? [];
  const pending = detail?.pending.filter((p) => !p.is_stale && (!p.status || p.status === "pending")) ?? [];
  const allDrafted = pending.length > 0 && pending.every((p) => drafts[p.id]);
  const draftedCount = pending.filter((p) => drafts[p.id]).length;
  const approvalAllowed = canApprove();

  // Stick-to-bottom: follow new messages and streamed tokens, stop when the
  // user scrolls up, resume via "Jump to latest" or by scrolling back down.
  const { ref: scrollRef, following, jumpToLatest } = useStickToBottom<HTMLDivElement>(
    [detail, streamingText, pending.length, legacyCancelled.length],
    activeRunId,
  );

  // The empty state reads top-down; only a real conversation pins to the bottom.
  useEffect(() => {
    if (!activeRunId) scrollRef.current?.scrollTo({ top: 0 });
  }, [activeRunId, scrollRef]);

  const doStart = async () => {
    if (!prompt.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const { run_id } = await startCopilotRun(prompt.trim());
      setPrompt("");
      reloadRuns();
      setActiveRunId(run_id);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setStarting(false);
    }
  };

  const doFollowUp = async () => {
    if (!prompt.trim() || !activeRunId) return;
    setStarting(true);
    try {
      await sendCopilotFollowUp(activeRunId, prompt.trim());
      setPrompt("");
      setStreamEpoch((e) => e + 1);
      jumpToLatest();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setStarting(false);
    }
  };

  const doCancel = async () => {
    if (!activeRunId) return;
    try {
      await cancelCopilotRun(activeRunId);
      refreshDetail(activeRunId);
      reloadRuns();
    } catch (err) {
      setError(humanizeError(err));
    }
  };

  const submitDecisions = async () => {
    if (!activeRunId || !allDrafted || !canApprove()) return;
    setSubmitting(true);
    try {
      await resolveCopilotRun(
        activeRunId,
        pending.map((p) => drafts[p.id] as CopilotResolution),
      );
      setStreamEpoch((e) => e + 1);
      refreshDetail(activeRunId);
      reloadRuns();
      jumpToLatest();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const newRun = () => {
    setActiveRunId(null);
    setDetail(null);
    setDrafts({});
    setError(null);
    setSheet(null);
    inputRef.current?.focus();
  };

  const selectRun = (id: string) => {
    setActiveRunId(id);
    setSheet(null);
  };

  const awaitingCount = globalPending.filter((p) => !p.is_stale).length;
  const activeSummary = runs.find((r) => r.id === activeRunId);
  const isStaleRun = !!detail && detail.status === "awaiting_input" && !actionableRunIds.has(detail.run_id);
  const working =
    !!activeRunId && !terminal && !streamingText && (detail?.status === "running" || starting);
  const canCancel = !!detail && (detail.status === "running" || (detail.status === "awaiting_input" && !isStaleRun));

  const statusChip = detail ? (
    <Chip
      tone={isStaleRun ? "neutral" : detail.status === "awaiting_input" ? "warn" : detail.status === "completed" ? "good" : detail.status === "failed" ? "bad" : "info"}
    >
      {isStaleRun ? "stale, cancelled" : detail.status.replace("_", " ")}
    </Chip>
  ) : null;

  return (
    <div className="page page--fill">
      <header className="cockpit-head">
        <h1 className="page-title">Copilot</h1>
        <span className="row" style={{ flexWrap: "nowrap" }}>
          {meta && (
            <span title={copilotModeNote(meta.mode)}>
              <Chip tone={meta.mode === "openai" ? "good" : "neutral"}>{copilotModeLabel(meta.mode)}</Chip>
            </span>
          )}
          {meta && <span className="muted hide-sm">prompt {meta.prompt_version}</span>}
        </span>
        <span className="topbar-spacer" />
        <Button size="sm" className="sheet-only" onClick={() => setSheet("runs")}>
          Runs ({runs.length})
        </Button>
        <Button size="sm" className="sheet-only" onClick={() => setSheet("context")}>
          Context
        </Button>
        <Button size="sm" variant="primary" onClick={newRun}>
          New run
        </Button>
      </header>

      {error && <ServiceStatusBanner message={error.message} detail={error.detail} />}
      {sheet && <div className="sheet-scrim" onClick={() => setSheet(null)} />}

      <div className="cockpit">
        <aside className={`cockpit-col cockpit-side${sheet === "runs" ? " is-open" : ""}`} aria-label="Runs">
          <div className="cockpit-colhead">
            <h2 className="panel-title">Runs</h2>
            <span className="row" style={{ flexWrap: "nowrap" }}>
              {awaitingCount > 0 && <Chip tone="warn">{awaitingCount} awaiting</Chip>}
              <Button size="sm" variant="ghost" className="sheet-only" onClick={() => setSheet(null)}>
                Close
              </Button>
            </span>
          </div>
          <div className="cockpit-scroll">
            <RunList runs={runs} activeRunId={activeRunId} onSelect={selectRun} actionableRunIds={actionableRunIds} />
          </div>
        </aside>

        <section className="cockpit-col cockpit-main" aria-label="Conversation">
          <div className="cockpit-colhead">
            <h2 className="panel-title trunc-line">{detail ? (activeSummary?.trigger ?? detail.trigger) : "New conversation"}</h2>
            <span className="row" style={{ flexWrap: "nowrap" }}>
              {statusChip}
              {canCancel && pending.length === 0 && (
                <Button size="sm" variant="ghost" onClick={doCancel}>
                  Cancel run
                </Button>
              )}
            </span>
          </div>

          <div className="chat">
            <div className="chat-scroll" ref={scrollRef} aria-live="polite" aria-label="Conversation messages" tabIndex={0}>
              {!activeRunId && (
                <div className="chat-empty">
                  <h2>What do you want to know?</h2>
                  <p className="muted">
                    The copilot can score components, read alerts, search the knowledge base and propose work. It asks you before it changes anything.
                  </p>
                  <div className="starters">
                    {STARTERS.map((st) => (
                      <button
                        key={st}
                        type="button"
                        className="starter"
                        onClick={() => {
                          setPrompt(st);
                          inputRef.current?.focus();
                        }}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {detail && (
                <div className="conversation">
                  {detail.messages.map((m, i) =>
                    m.role === "tool_call" || m.role === "tool_result" ? (
                      <ToolStep key={i} message={m} />
                    ) : m.role === "user" ? (
                      <div key={i} className="msg msg-user">
                        <div className="bubble">
                          <SafeMarkdown text={m.content ?? ""} />
                        </div>
                      </div>
                    ) : (
                      <div key={i} className="msg msg-agent">
                        <SafeMarkdown text={m.content ?? ""} />
                      </div>
                    ),
                  )}

                  {activeRunId && !terminal && streamingText && (
                    <div className="msg msg-agent is-streaming">
                      <SafeMarkdown text={streamingText} />
                    </div>
                  )}

                  {working && (
                    <div className="msg msg-agent" role="status" aria-label="Copilot is working">
                      <span className="typing" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="muted"> Working…</span>
                    </div>
                  )}

                  {legacyCancelled.map((p) => (
                    <div key={p.id} className="hitl hitl-stale">
                      <div className="hitl-head">
                        <Chip>stale, cancelled</Chip>
                        <strong>{p.tool_name ?? "pending action"}</strong>
                      </div>
                      <p className="muted">
                        {p.resolution_reason ?? "This pending card predates a fix and was auto-cancelled; it was never executed."}
                      </p>
                    </div>
                  ))}

                  {detail.status === "awaiting_input" &&
                    pending.map((p) =>
                      p.kind === "approval" ? (
                        <ApprovalCard key={p.id} item={p} onDraftChange={(id, res) => setDrafts((prev) => ({ ...prev, [id]: res }))} />
                      ) : (
                        <OptionCard key={p.id} item={p} onDraftChange={(id, res) => setDrafts((prev) => ({ ...prev, [id]: res }))} />
                      ),
                    )}

                  {pending.length > 0 && (
                    <div className="batch-bar">
                      <p className="batch-summary">
                        {allDrafted
                          ? pending.length === 1
                            ? `Ready to submit: ${summarizeDraft(drafts[pending[0].id] as CopilotResolution)}.`
                            : `Ready to submit ${pending.length} decisions: ` +
                              pending.map((p) => summarizeDraft(drafts[p.id] as CopilotResolution)).join("; ") +
                              "."
                          : `Decide on each item above first (${draftedCount} of ${pending.length} drafted).`}
                      </p>
                      <div className="row" style={{ flexWrap: "nowrap" }}>
                        <Button
                          variant="primary"
                          loading={submitting}
                          disabled={!approvalAllowed || !allDrafted}
                          title={
                            !approvalAllowed
                              ? "Read-only identity: switch to an engineer to approve"
                              : !allDrafted
                                ? "Decide on every item above before submitting"
                                : undefined
                          }
                          onClick={submitDecisions}
                        >
                          {submitting ? "Submitting…" : `Submit decision${pending.length > 1 ? "s" : ""}`}
                        </Button>
                        <Button onClick={doCancel}>Cancel run</Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {activeRunId && !following && (
              <button type="button" className="jump-pill" onClick={jumpToLatest}>
                <ArrowDownIcon />
                Jump to latest
              </button>
            )}
          </div>

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              if (activeRunId) void doFollowUp();
              else void doStart();
            }}
          >
            <input
              ref={inputRef}
              className="input"
              name="copilot-prompt"
              autoComplete="off"
              aria-label={activeRunId ? "Follow up on this run" : "Ask the copilot"}
              placeholder={activeRunId ? "Follow up on this run…" : "Ask the copilot something…"}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault();
              }}
            />
            {working || (detail?.status === "running" && !terminal) ? (
              <Button type="button" onClick={doCancel}>
                <StopIcon />
                Stop
              </Button>
            ) : null}
            <Button type="submit" variant="primary" loading={starting} disabled={!prompt.trim()}>
              <SendIcon />
              {starting ? "Sending…" : activeRunId ? "Send" : "Start run"}
            </Button>
          </form>
        </section>

        <aside className={`cockpit-col cockpit-side${sheet === "context" ? " is-open" : ""}`} aria-label="Run context">
          <div className="cockpit-colhead">
            <h2 className="panel-title">Run context</h2>
            <Button size="sm" variant="ghost" className="sheet-only" onClick={() => setSheet(null)}>
              Close
            </Button>
          </div>
          <div className="cockpit-scroll" style={{ padding: 16 }}>
            {detail ? (
              <dl className="kv is-compact">
                <dt>status</dt>
                <dd>
                  <strong>{detail.status}</strong>
                </dd>
                <dt>trigger</dt>
                <dd>{detail.trigger}</dd>
                {detail.alert_id != null && (
                  <>
                    <dt>alert</dt>
                    <dd>
                      <a href={hrefFor(`ops/alerts/${detail.alert_id}`)}>#{detail.alert_id}</a>
                    </dd>
                  </>
                )}
                <dt>model</dt>
                <dd className="mono">{detail.model_name}</dd>
              </dl>
            ) : (
              <p className="muted">No run selected.</p>
            )}
            {meta && (
              <>
                <h3 className="form-section-title" style={{ marginTop: 20 }}>
                  Tools ({meta.tools.length})
                </h3>
                <ul className="tool-list">
                  {meta.tools.map((t) => (
                    <li key={t}>
                      <span className="mono">{t}</span>
                      {meta.approval_gated_tools.includes(t) && <Chip tone="warn" plain>approval</Chip>}
                      {meta.deferred_tools.includes(t) && <Chip plain>deferred</Chip>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
