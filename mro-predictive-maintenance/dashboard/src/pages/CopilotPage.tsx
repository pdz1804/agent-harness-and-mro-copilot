import { useEffect, useMemo, useRef, useState } from "react";
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
import { RunList, filterRuns } from "../components/copilot/RunList";
import { useUrlQuery } from "../hooks/useHashRoute";
import { ToolCallBlock } from "../components/copilot/ToolCallBlock";
import { buildTranscript } from "../lib/transcript";
import { SafeMarkdown } from "../components/copilot/SafeMarkdown";
import { Button, Chip } from "../components/ui/primitives";
import { ServiceStatusBanner } from "../components/ui/states";
import { ArrowDownIcon, BellIcon, SearchIcon, BotIcon, CloseIcon, FileIcon, GaugeIcon, PlaneIcon, SendIcon, StopIcon } from "../components/ui/icons";
import { copilotModeLabel, copilotModeNote } from "../lib/labels";
import { humanizeError, type HumanError } from "../lib/errors";
import { IDENTITY_CHANGE_EVENT, canApprove, getCurrentUser } from "../lib/identity";
import { runTitle } from "../components/copilot/RunList";
import {
  actionablePending,
  effectiveStatus,
  isSettledAfterResume,
  isStaleRun as computeStaleRun,
  legacyCancelledPending,
  runStatusLabel,
  workOrderIdFromResult,
} from "../lib/run-status";
import { CopyId, useToast } from "../components/ui/feedback";
import { hrefFor } from "../lib/routes";
import { finalizeResolutions, resolutionFor } from "../lib/tool-view";
import type { CopilotMeta, CopilotPendingItem, CopilotRunDetail, CopilotRunSummary } from "../types";

/** Plain-language one-liner for a drafted decision, used by the batch bar so
 * "what happens when I click Submit" is never a guess. */
const STARTER_ICONS = [<GaugeIcon key="g" />, <BellIcon key="b" />, <FileIcon key="f" />, <PlaneIcon key="p" />];

function AgentAvatar() {
  return (
    <span className="msg-avatar" aria-hidden="true">
      <BotIcon />
    </span>
  );
}

/** Tools grouped by how the copilot may use them: read freely / needs your approval / asks you. */
function groupTools(meta: CopilotMeta): { title: string; tools: string[]; badge?: { label: string; tone: "warn" | "info" } }[] {
  const gated = new Set(meta.approval_gated_tools);
  const deferred = new Set(meta.deferred_tools.filter((t) => !gated.has(t)));
  return [
    { title: "Read", tools: meta.tools.filter((t) => !gated.has(t) && !deferred.has(t)) },
    { title: "Needs approval", tools: meta.tools.filter((t) => gated.has(t)), badge: { label: "approval", tone: "warn" } },
    { title: "Asks you", tools: meta.tools.filter((t) => deferred.has(t)), badge: { label: "question", tone: "info" } },
  ];
}

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

/** What "Ask copilot" hands over: the prompt, plus the alert the run is
 * about (sent as `alert_id`, so the run is linked to it) and a short label. */
export interface CopilotPrefill {
  prompt: string;
  alertId?: number;
  context?: string;
}

interface CopilotPageProps {
  prefillPrompt: CopilotPrefill | null;
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
  const [runSearch, setRunSearch] = useState("");
  // `#/ops/copilot?run=<id>` (e.g. "Review in copilot" on Overview) opens that run.
  const [routeQuery, setRouteQuery] = useUrlQuery({ run: "" });
  useEffect(() => {
    if (routeQuery.run) {
      setActiveRunId(routeQuery.run);
      setRouteQuery({ run: null });
    }
  }, [routeQuery.run, setRouteQuery]);
  const [detail, setDetail] = useState<CopilotRunDetail | null>(null);
  const [prompt, setPrompt] = useState("");
  const [ctx, setCtx] = useState<{ alertId?: number; context?: string } | null>(null);
  const toast = useToast();
  const seenWo = useRef<{ run: string | null; ids: Set<string> }>({ run: null, ids: new Set() });
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
  // True from a successful resolve/follow-up until a fetched snapshot shows the
  // resumed turn settled. The server keeps the DB status at "awaiting_input"
  // for the whole resumed turn, so without this the UI read that window as
  // "stale, cancelled" with a result-less tool call.
  const [resuming, setResuming] = useState(false);
  const resumingRef = useRef(false);
  resumingRef.current = resuming;
  // Decisions this session just submitted, keyed by tool name: labels the
  // call's block "Approved by (me) at (time)" while the resumed turn runs.
  // Live approval notes by pending id, merged into the resolutions at Submit.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [localDecisions, setLocalDecisions] = useState<Record<string, { action: "approve" | "deny" | "answer"; actor: string; at: string }>>({});

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
      // Context from another page always starts a fresh run about it.
      newRun();
      setPrompt(prefillPrompt.prompt);
      setCtx(prefillPrompt.alertId != null || prefillPrompt.context ? { alertId: prefillPrompt.alertId, context: prefillPrompt.context } : null);
      onPrefillConsumed();
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    }
  }, [prefillPrompt, onPrefillConsumed]);

  const refreshDetail = (runId: string) => {
    getCopilotRun(runId)
      .then((d) => {
        setDetail(d);
        setDrafts({});
        if (resumingRef.current && isSettledAfterResume(d)) setResuming(false);
      })
      .catch((err: unknown) => setError(humanizeError(err)));
  };

  useEffect(() => {
    setError(null);
    setResuming(false);
    setLocalDecisions({});
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

  // Backstop while a resumed turn is in flight: the SSE terminal event is the
  // fast path, but if that connection drops or misses it, the run must still
  // converge to its real state without a manual reselect.
  useEffect(() => {
    if (!resuming || !activeRunId) return;
    const poll = setInterval(() => {
      refreshDetail(activeRunId);
      reloadRuns();
    }, 2500);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resuming, activeRunId]);

  useEffect(() => {
    onPendingCountChange(globalPending.filter((p) => !p.is_stale).length);
  }, [globalPending, onPendingCountChange]);


  // Legacy pre-fix pending rows the one-shot startup cleanup already
  // cancelled (`status` present and not "pending") -- read-only, never
  // actionable, rendered as an inert "stale -- cancelled" note rather than
  // an editable card.
  const legacyCancelled = detail && !resuming ? legacyCancelledPending(detail.pending) : [];
  const pending = detail && !resuming ? actionablePending(detail.pending) : [];
  const shownStatus = detail ? effectiveStatus(detail.status, resuming) : "";
  const allDrafted = pending.length > 0 && pending.every((p) => drafts[p.id]);
  const draftedCount = pending.filter((p) => drafts[p.id]).length;
  const approvalAllowed = canApprove();
  const transcript = useMemo(
    () =>
      detail
        ? buildTranscript(detail.messages, shownStatus === "awaiting_input" ? pending : [], {
            running: shownStatus === "running",
            gatedTools: meta?.approval_gated_tools,
          })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail, meta, resuming],
  );

  // Stick-to-bottom: follow new messages and streamed tokens, stop when the
  // user scrolls up, resume via "Jump to latest" or by scrolling back down.
  const { ref: scrollRef, following, jumpToLatest } = useStickToBottom<HTMLDivElement>(
    [detail, streamingText, pending.length, legacyCancelled.length],
    activeRunId,
    // First load of a conversation: start with the latest prompt fully in view
    // (pinning a tall thread to the bottom clipped it at the top edge), unless
    // a decision is waiting -- then the decision wins and we pin to the bottom.
    (el) => {
      const prompts = el.querySelectorAll<HTMLElement>(".msg-user");
      if (prompts.length === 0) return undefined;
      if (el.querySelector(".batch-bar, .tcb.is-awaiting")) return null;
      const last = prompts[prompts.length - 1];
      return last.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16;
    },
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
      const { run_id } = await startCopilotRun(prompt.trim(), ctx?.alertId);
      setPrompt("");
      setCtx(null);
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
      setResuming(true);
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
      const resolutions = finalizeResolutions(pending.map((p) => p.id), drafts, notes);
      await resolveCopilotRun(activeRunId, resolutions);
      const actor = getCurrentUser();
      const at = new Date().toISOString();
      const decided: Record<string, { action: "approve" | "deny" | "answer"; actor: string; at: string }> = {};
      pending.forEach((p, i) => {
        decided[p.tool_name ?? p.kind] = { action: resolutions[i].decision, actor, at };
      });
      setLocalDecisions((prev) => ({ ...prev, ...decided }));
      setResuming(true);
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

  // A work order created by an approved tool call gets a toast with a link,
  // so the loop "approve -> WO exists -> go look at it" never needs a hunt.
  useEffect(() => {
    if (!detail) return;
    const ids = detail.messages
      .filter((m) => m.role === "tool_result" && m.tool_name === "create_work_order")
      .map((m) => workOrderIdFromResult(m))
      .filter((x): x is string => !!x);
    const seen = seenWo.current;
    if (seen.run !== detail.run_id) {
      seenWo.current = { run: detail.run_id, ids: new Set(ids) };
      return;
    }
    for (const id of ids) {
      if (seen.ids.has(id)) continue;
      seen.ids.add(id);
      toast.show({
        tone: "good",
        message: (
          <>
            Work order <span className="mono">{id}</span> created
          </>
        ),
        detail: "Approved through the copilot. It is now on the Work orders list.",
        link: { label: "View work order", href: hrefFor(`ops/work-orders/${id}`) },
        durationMs: 9000,
      });
    }
  }, [detail, toast]);

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
  // Stale comes ONLY from the server's legacy-cancelled marker on this run.
  const isStaleRun = computeStaleRun(detail, resuming);
  const staleRunIds = new Set(isStaleRun && detail ? [detail.run_id] : []);
  const shownRuns = filterRuns(resuming ? runs.map((r) => (r.id === activeRunId ? { ...r, status: "running" } : r)) : runs, runSearch);
  const conversationTitle = activeSummary ? runTitle(activeSummary) : detail ? runTitle({ user_prompt: detail.messages.find((m) => m.role === "user")?.content ?? null, trigger: detail.trigger }) : "";
  const working = !!activeRunId && !streamingText && ((!terminal && shownStatus === "running") || starting || (resuming && terminal));
  const canCancel = !!detail && !resuming && (detail.status === "running" || (detail.status === "awaiting_input" && !isStaleRun));

  const statusChip = detail ? (
    <Chip
      tone={isStaleRun ? "neutral" : shownStatus === "awaiting_input" ? "warn" : shownStatus === "completed" ? "good" : shownStatus === "failed" ? "bad" : "info"}
    >
      {isStaleRun ? "Stale, cancelled" : runStatusLabel(shownStatus)}
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
          <div className="run-search">
            <label className="search-field">
              <SearchIcon />
              <input
                className="input input-sm"
                type="search"
                name="run-search"
                placeholder="Search runs…"
                aria-label="Search copilot runs"
                autoComplete="off"
                value={runSearch}
                onChange={(e) => setRunSearch(e.target.value)}
              />
            </label>
          </div>
          <div className="cockpit-scroll">
            <RunList runs={shownRuns} activeRunId={activeRunId} onSelect={selectRun} staleRunIds={staleRunIds} filtered={runSearch.trim() !== ""} />
          </div>
        </aside>

        <section className="cockpit-col cockpit-main" aria-label="Conversation">
          <div className="cockpit-colhead">
            <h2 className="panel-title trunc-line" title={detail ? conversationTitle : undefined}>{detail ? conversationTitle : "New conversation"}</h2>
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
                  <span className="chat-empty-mark" aria-hidden="true">
                    <BotIcon />
                  </span>
                  <h2>What do you want to know?</h2>
                  <p className="muted">
                    The copilot can score components, read alerts, search the knowledge base and propose work. It asks you before it changes anything.
                  </p>
                  <div className="starters">
                    {STARTERS.map((st, si) => (
                      <button
                        key={st}
                        type="button"
                        className="starter"
                        onClick={() => {
                          setPrompt(st);
                          inputRef.current?.focus();
                        }}
                      >
                        <span className="starter-ico" aria-hidden="true">
                          {STARTER_ICONS[si % STARTER_ICONS.length]}
                        </span>
                        {st}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {detail && (
                <div className="conversation">
                  {transcript.map((t, ti) => {
                    if (t.kind === "tool") {
                      return (
                        <ToolCallBlock
                          key={t.key}
                          item={t}
                          drafted={!!(t.pending && drafts[t.pending.id])}
                          localDecision={t.state === "awaiting" ? null : (localDecisions[t.toolName] ?? null)}
                          onDraftChange={(id, res) => setDrafts((prev) => ({ ...prev, [id]: res }))}
                          onNoteChange={(id, note) => setNotes((prev) => ({ ...prev, [id]: note }))}
                          resolution={resolutionFor(t.call, t.toolName, detail.resolved)}
                        />
                      );
                    }
                    const m = t.message;
                    if (m.role === "user") {
                      return (
                        <div key={t.index} className="msg msg-user">
                          <div className="bubble">
                            <SafeMarkdown text={m.content ?? ""} />
                          </div>
                        </div>
                      );
                    }
                    const prev = transcript[ti - 1];
                    const startsGroup = !prev || (prev.kind === "message" && prev.message.role === "user");
                    return (
                      <div key={t.index} className={`msg msg-agent${startsGroup ? "" : " is-grouped"}`}>
                        <AgentAvatar />
                        {startsGroup && <span className="msg-author">Copilot</span>}
                        <SafeMarkdown text={m.content ?? ""} />
                      </div>
                    );
                  })}

                  {activeRunId && !terminal && streamingText && (
                    <div className="msg msg-agent is-streaming is-grouped">
                      <AgentAvatar />
                      <SafeMarkdown text={streamingText} />
                    </div>
                  )}

                  {working && (
                    <div className="msg msg-agent is-grouped" role="status" aria-label="Copilot is working">
                      <AgentAvatar />
                      <span className="typing" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="muted"> Working…</span>
                    </div>
                  )}

                  {legacyCancelled.map((p) => (
                    <div key={p.id} className="tcb is-incomplete">
                      <div className="tcb-head is-static">
                        <span className="tcb-ico" aria-hidden="true">
                          <CloseIcon />
                        </span>
                        <span className="tcb-title">
                          <span className="tcb-name">{p.tool_name ?? "pending action"}</span>
                        </span>
                        <span className="tcb-status">Stale, cancelled</span>
                      </div>
                      <div className="tcb-body">
                        <p className="muted">
                          {p.resolution_reason ?? "This pending card predates a fix and was auto-cancelled; it was never executed."}
                        </p>
                      </div>
                    </div>
                  ))}

                  {pending.length > 0 && (
                    <div className="batch-bar" role="region" aria-label="Pending decisions">
                      <span className={`batch-count${allDrafted ? " is-ready" : ""}`} aria-hidden="true">
                        {draftedCount}/{pending.length}
                      </span>
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
                          size="sm"
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
                        <Button size="sm" variant="ghost" onClick={doCancel}>
                          Cancel run
                        </Button>
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
            {ctx && !activeRunId && (
              <span className="composer-ctx" title="This run will be linked to that alert">
                <span className="muted">About</span>
                <strong>{ctx.context ?? `alert #${ctx.alertId}`}</strong>
                <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Remove context" onClick={() => setCtx(null)}>
                  <CloseIcon />
                </button>
              </span>
            )}
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
                  <strong>{runStatusLabel(shownStatus)}</strong>
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
                {meta && (
                  <>
                    <dt>prompt</dt>
                    <dd className="mono">{meta.prompt_version}</dd>
                  </>
                )}
                <dt>run</dt>
                <dd>
                  <CopyId value={detail.run_id} />
                </dd>
                <dt>pending</dt>
                <dd className="tnum">{pending.length}</dd>
              </dl>
            ) : (
              <p className="muted">No run selected.</p>
            )}
            {meta && (
              <>
                <h3 className="form-section-title" style={{ marginTop: 20 }}>
                  Tools ({meta.tools.length})
                </h3>
                {groupTools(meta).map((g) =>
                  g.tools.length === 0 ? null : (
                    <div key={g.title} className="tool-group">
                      <p className="tool-group-title">
                        {g.title}
                        <span className="tool-group-count">{g.tools.length}</span>
                      </p>
                      <ul className="tool-list">
                        {g.tools.map((t) => (
                          <li key={t}>
                            <span className="mono tool-list-name" title={t}>
                              {t}
                            </span>
                            {g.badge && (
                              <Chip tone={g.badge.tone} plain>
                                {g.badge.label}
                              </Chip>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ),
                )}
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
