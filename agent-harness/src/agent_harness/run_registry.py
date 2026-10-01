"""In-memory run registry + Event-based approval callback adapter for the
async HTTP run flow (`POST /runs` -> `GET /runs/{id}` -> `POST
/runs/{id}/approve`).

This backs the API's real pause/resume approval gate (see `api.py`'s
module docstring and `docs/design-report.md` section 6 for the design
this replaces). Each run gets one background `threading.Thread` running
`AgentLoop.run(...)` to completion; when the loop hits an approval-gated
tool, the callback built here records the pending tool call against the
run and blocks the background thread on a `threading.Event` until
`resolve_approval` is called (or the run's own wall-clock budget runs
out, at which point a forgotten approval is treated as denied so the
thread cannot hang forever).

This is deliberately a single-process, in-memory store (`dict` + locks),
not Celery/Redis/a database — appropriate for a single demo backend
driving one UI, not a production job queue. See "Known limitations" in
`docs/design-report.md`.
"""

from __future__ import annotations

import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Optional, Protocol

from pydantic_ai.models import Model

from agent_harness import agent_runtime, db, prompt_verification
from agent_harness.config import HarnessConfig
from agent_harness.exceptions import ApprovalTimeout
from agent_harness.loop import SYSTEM_PROMPT, AgentLoop, check_input_guardrail
from agent_harness.rbac import Role
from agent_harness.repos import agents as agents_repo
from agent_harness.repos import integrations as integrations_repo
from agent_harness.repos import prompts as prompts_repo
from agent_harness.repos import users as users_repo
from agent_harness.schemas import AgentEvent, RunResult
from agent_harness.tools.registry import ToolRegistry, build_default_registry

# Mirrors `agent_harness.schemas.RunStatus` plus two states that only ever
# exist in this in-memory registry (never in a persisted `RunResult`):
# `pending_approval` (mid-run, waiting on a human) and `failed` (the
# background thread raised an unexpected exception — a defensive state so a
# bug here surfaces as a visible run status instead of hanging silently).
AsyncRunStatus = Literal[
    "running",
    "pending_approval",
    "completed",
    "step_limit_exceeded",
    "time_limit_exceeded",
    "llm_error_exceeded",
    "failed",
    "guardrail_blocked",
    "cancelled",
]


class EventSink(Protocol):
    """Anything a run can push live events into: a `queue.Queue` or the SSE
    endpoint's asyncio bridge. `None` is the end-of-stream sentinel. May
    raise `queue.Full`; a slow consumer never blocks the run."""

    def put_nowait(self, item: Optional[AgentEvent]) -> None: ...


@dataclass
class PendingApproval:
    """One in-flight approval request, waiting for a human decision."""

    tool_name: str
    tool_args: dict[str, Any]
    # What the tool's dry run says will happen if approved (e.g. a dashboard's
    # widgets with their SQL and live row counts); `None` for tools without one.
    preview: Optional[dict[str, Any]] = None
    event: threading.Event = field(default_factory=threading.Event)
    decision: Optional[bool] = None


@dataclass
class RunRecord:
    """Live state for one async run, mutated by the background thread and
    read by the API's GET handlers. All reads/writes go through `lock`."""

    run_id: str
    objective: str
    started_at: float
    trace_path: str
    session_id: Optional[str] = None
    prompt_version_id: Optional[str] = None
    triggered_by_automation_id: Optional[str] = None
    owner_id: str = "u_admin"
    agent_id: Optional[str] = None
    skill_ids: list[str] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    status: AsyncRunStatus = "running"
    # Set by `cancel_run` (the Stop button); polled by `AgentLoop` via its
    # `should_cancel` hook.
    cancel_requested: bool = False
    history: list[AgentEvent] = field(default_factory=list)
    pending_approval: Optional[PendingApproval] = None
    result: Optional[RunResult] = None
    error: Optional[str] = None
    # Per-connection SSE subscriber queues (see RunRegistry.subscribe). Each
    # queue receives every AgentEvent recorded after subscription, plus a
    # `None` sentinel once the run reaches a terminal status so the SSE
    # endpoint can close the connection instead of hanging forever.
    subscribers: list[EventSink] = field(default_factory=list)


class RunRegistry:
    """Owns background-thread run execution and exposes live snapshots."""

    def __init__(self, default_runs_dir: Path | str = "runs") -> None:
        self._runs: dict[str, RunRecord] = {}
        self._lock = threading.Lock()
        self._default_runs_dir = Path(default_runs_dir)

    def start_run(
        self,
        objective: str,
        model: Model | str,
        config: Optional[HarnessConfig] = None,
        runs_dir: Optional[Path] = None,
        session_id: Optional[str] = None,
        triggered_by_automation_id: Optional[str] = None,
        owner_id: str = "u_admin",
        owner_role: Role = "admin",
        agent_id: Optional[str] = None,
        router_model: Optional[Model] = None,
        system_prompt_override: Optional[str] = None,
        prompt_version_id_override: Optional[str] = None,
        conversation_context: Optional[str] = None,
    ) -> RunRecord:
        """Create a run record and start it executing on a background
        thread. Returns immediately with the initial (running) record.

        Phase 12b: before building this run's agent, look up the *current*
        `integrations` enabled/disabled state and the *current* active
        `prompt_versions` row — both real DB reads made fresh for every run,
        never cached — so a toggle flipped or a prompt activated moments ago
        is genuinely reflected in this run's tool list / system prompt, not
        just in the UI. See `_build_enabled_tool_registry`/
        `_active_prompt` below.

        Phase 12d: `triggered_by_automation_id`, when set, tags this run as
        having been started by `api.py::_trigger_automations` off a real
        service-status flip rather than a manual "New run" submission — this
        is the exact same code path (no duplicated run-creation logic), just
        called with one extra id to persist on the `runs` row.

        Phase 04: `agent_id` (default agent if omitted) resolves this run's
        system prompt/tool set/active skill(s) via
        `agent_runtime.resolve_run_plan` instead of the phase-02 fixed
        "`ops-system`'s active content" path — see `_resolve_agent_plan`.
        Raises `agent_runtime.SlashCommandError` for a malformed/
        inaccessible `/slug` objective, synchronously, before any record is
        created or thread started (the caller — `api.py` — translates that
        into a 422).
        """
        run_id = uuid.uuid4().hex[:12]
        cfg = config or HarnessConfig()
        effective_runs_dir = Path(runs_dir) if runs_dir is not None else self._default_runs_dir
        trace_path = str(effective_runs_dir / f"{run_id}.jsonl")

        (
            objective,
            tools,
            system_prompt,
            prompt_version_id,
            active_skill_ids,
            preamble_events,
        ) = self._resolve_agent_plan(
            objective=objective,
            owner_id=owner_id,
            owner_role=owner_role,
            agent_id=agent_id,
            system_prompt_override=system_prompt_override,
            prompt_version_id_override=prompt_version_id_override,
            # Deliberately NOT defaulted to `model`: a caller (e.g. a direct
            # `start_run(model=some_stateful_test_double)` call with no
            # `router_model`) must never have its main-loop model's script/
            # call-count state silently consumed by an extra router call it
            # never asked for. `None` here degrades cleanly to
            # `skill_routing_failed` (see agent_runtime.resolve_run_plan) —
            # no call is made at all, nothing is corrupted. Real callers
            # that want genuine auto-routing (api.py) always pass an
            # explicit, independent `router_model`.
            router_model=router_model,
        )

        if conversation_context:
            # Earlier turns of this chat session, so a follow-up ("now open
            # an incident for it") is answered with the conversation in view.
            system_prompt = (
                (system_prompt if system_prompt is not None else SYSTEM_PROMPT)
                + "\n\n## Conversation so far (earlier turns of this chat)\n"
                + conversation_context
            )

        record = RunRecord(
            run_id=run_id,
            objective=objective,
            started_at=time.time(),
            trace_path=trace_path,
            session_id=session_id,
            prompt_version_id=prompt_version_id,
            triggered_by_automation_id=triggered_by_automation_id,
            owner_id=owner_id,
            agent_id=agent_id,
            skill_ids=active_skill_ids,
        )
        with self._lock:
            self._runs[run_id] = record

        # Persist immediately so `GET /runs` reflects this run (as
        # `running`) even before any event has streamed in, and so a crash
        # mid-run still leaves a recoverable `running` row rather than no
        # row at all.
        self._persist_run(record)

        approval_callback = self._make_approval_callback(record, cfg)

        def _on_event(event: AgentEvent) -> None:
            if event.event_type == "llm_token_delta":
                # Live-only overlay: push straight to SSE subscribers, never
                # append to record.history or persist to Postgres/JSONL (the
                # assembled llm_decision/final_answer event that follows is
                # the source of truth — see loop.py::_decide / trace_logger).
                with record.lock:
                    subscribers = list(record.subscribers)
                for q in subscribers:
                    try:
                        q.put_nowait(event)
                    except queue.Full:  # noqa: BLE001 - a slow/stuck SSE client must never block a run
                        pass
                return
            with record.lock:
                record.history.append(event)
                # `TraceLogger.log` invokes this synchronously *before*
                # `_request_approval` (loop.py) goes on to call
                # `approval_callback` below. Without this, the
                # `approval_requested` SSE event reaches the frontend (and
                # triggers its one-shot re-fetch of `GET /runs/{id}`)
                # while `record.status` is still "running" — a race the
                # frontend has no way to recover from, since it only
                # re-fetches once per `approval_requested` event. Flip the
                # status here, synchronously, before the event is ever
                # pushed to a subscriber, so any snapshot fetched in
                # reaction to this event is already authoritative. The
                # approval callback below reuses this same `PendingApproval`
                # (same `threading.Event`) rather than creating a second
                # one, so `resolve_approval` still unblocks the right wait.
                if event.event_type == "approval_requested":
                    data = event.data or {}
                    record.pending_approval = PendingApproval(
                        tool_name=data.get("tool_name", ""),
                        tool_args=data.get("args", {}),
                        preview=data.get("preview"),
                    )
                    record.status = "pending_approval"
                subscribers = list(record.subscribers)
            for q in subscribers:
                try:
                    q.put_nowait(event)
                except queue.Full:  # noqa: BLE001 - a slow/stuck SSE client must never block a run
                    pass
            try:
                db.append_event(
                    run_id=run_id,
                    step=event.step,
                    event_type=event.event_type,
                    timestamp=event.timestamp,
                    latency_ms=event.latency_ms,
                    data=event.data,
                )
            except Exception:  # noqa: BLE001 - a persistence bug must never break a live run
                pass

        loop = AgentLoop(
            model=model,
            tools=tools,
            config=cfg,
            approval_callback=approval_callback,
            runs_dir=effective_runs_dir,
            on_event=_on_event,
            system_prompt=system_prompt,
            preamble_events=preamble_events,
            should_cancel=lambda: record.cancel_requested,
            tool_settings=self._tool_settings(),
        )

        def _worker() -> None:
            try:
                result = loop.run(objective, run_id=run_id)
            except Exception as exc:  # noqa: BLE001 - background thread must never die silently
                error = str(exc)
                # Persist the terminal row to Postgres *before* flipping the
                # in-memory status below. `snapshot()` (in-memory) is what
                # `GET /runs/{id}` polls in a tight loop to notice a run has
                # finished; if we flipped `record.status` first and persisted
                # after, a caller could observe a terminal in-memory status
                # while `db.get_run()` still returns the previous ("running")
                # row — the DB write/commit for the terminal status would
                # lag behind the in-memory flip. Writing to Postgres first
                # (and committing, via `db.connect`'s context manager) closes
                # that gap: by the time `record.status` becomes terminal,
                # the Postgres row already agrees.
                self._persist_terminal(record, status="failed", result=None, error=error)
                with record.lock:
                    record.status = "failed"
                    record.error = error
                self._close_subscribers(record)
                return
            self._persist_terminal(record, status=result.status, result=result, error=None)
            with record.lock:
                record.result = result
                record.status = result.status
                record.pending_approval = None
            self._close_subscribers(record)

        thread = threading.Thread(target=_worker, name=f"agent-run-{run_id}", daemon=True)
        thread.start()
        return record

    def _resolve_agent_plan(
        self,
        *,
        objective: str,
        owner_id: str,
        owner_role: Role,
        agent_id: Optional[str],
        router_model: Optional[Model],
        system_prompt_override: Optional[str] = None,
        prompt_version_id_override: Optional[str] = None,
    ) -> tuple[str, ToolRegistry, Optional[str], Optional[str], list[str], list[AgentEvent]]:
        """Resolve `agent_id` (falling back to the default agent, and — if
        no `agents` row exists at all, e.g. a downgraded/pre-04 database —
        the phase-02 fixed `ops-system` path) into everything `start_run`
        needs: the (possibly slash-stripped) objective, the tool registry,
        the composed system prompt, which prompt version was used, which
        skill(s) (by id) are active, and the preamble trace events."""
        if system_prompt_override is not None:
            # Prompt Playground: the caller supplies the exact system prompt
            # (a saved version's text or an unsaved draft). Tools are the
            # real, enabled, RBAC-allowed set, and the approval gate and
            # guardrails apply exactly as in any other run.
            tools = self._build_enabled_tool_registry(owner_id, owner_role)
            return (
                objective,
                tools,
                self._render_prompt(system_prompt_override, owner_id, owner_role),
                prompt_version_id_override,
                [],
                [],
            )

        agent = agents_repo.get_agent(agent_id) if agent_id else agents_repo.get_default_agent()
        if agent is None:
            tools = self._build_enabled_tool_registry(owner_id, owner_role)
            system_prompt, prompt_version_id = self._active_prompt()
            if system_prompt is not None:
                system_prompt = self._render_prompt(system_prompt, owner_id, owner_role)
            return objective, tools, system_prompt, prompt_version_id, [], []

        # Check the input guardrail *before* any skill routing: a blocked
        # objective must never trigger an auto-mode router LLM call, and a
        # blocked run's trace must show only `guardrail_blocked` — nothing
        # from agent_runtime ahead of it. `AgentLoop._run_async_inner` runs
        # this exact same check again (its own step-0 gate, independent of
        # this one) and is what actually ends the run; this early check here
        # only decides whether to skip resolving a skill/tool plan at all.
        if check_input_guardrail(objective) is not None:
            system_prompt, prompt_version_id = agent_runtime.resolve_agent_prompt(agent)
            return objective, {}, system_prompt, prompt_version_id, [], []

        # RBAC at tool-offer time: the owner's role decides which tools can
        # even be considered (a viewer never gets create_dashboard), so a
        # skill that wants a tool the owner may not use degrades to the same
        # `no_tools_available` path as a disabled integration.
        full_registry = build_default_registry(owner_id, owner_role)
        enabled_names = db.list_enabled_tool_names() & set(full_registry)
        plan = agent_runtime.resolve_run_plan(
            agent=agent,
            objective=objective,
            user_id=owner_id,
            user_role=owner_role,
            enabled_tool_names=enabled_names,
            router_model=router_model,
        )
        tools = {name: tool for name, tool in full_registry.items() if name in plan.tool_names}
        return (
            plan.objective,
            tools,
            self._render_prompt(plan.system_prompt, owner_id, owner_role),
            plan.prompt_version_id,
            plan.active_skill_ids,
            plan.events,
        )

    @staticmethod
    def _tool_settings() -> dict[str, dict[str, Any]]:
        """Per-tool timeout/retry overrides from Integrations, read fresh for each
        run. A lookup failure falls back to the global limits rather than
        failing the run."""
        try:
            return integrations_repo.tool_settings()
        except Exception:  # noqa: BLE001 - settings are an override layer, never a reason to fail a run
            return {}

    @staticmethod
    def _render_prompt(system_prompt: str, owner_id: str, owner_role: Role) -> str:
        """Fill `{{today}}` / `{{user_name}}` / `{{user_role}}` (the only
        placeholders prompt lint accepts) for this run's owner."""
        user = users_repo.get_user(owner_id)
        return prompt_verification.render_placeholders(
            system_prompt,
            user_name=user["display_name"] if user else owner_id,
            user_role=owner_role,
        )

    def _build_enabled_tool_registry(
        self, owner_id: Optional[str] = None, owner_role: Optional[Role] = None
    ) -> ToolRegistry:
        """The real enforcement point for Integrations toggles: build the
        full default registry, then drop every tool whose `integrations` row
        is `enabled=false` — so a disabled tool is never even constructed
        into a `pydantic_ai.Tool`/passed to `AgentLoop`, let alone offered to
        the LLM (see `loop.py::AgentLoop._build_agent`). A tool with no
        `integrations` row at all (should not happen once `ensure_ready` has
        run) fails safe as *disabled* rather than silently staying available."""
        enabled_names = db.list_enabled_tool_names()
        full_registry = build_default_registry(owner_id, owner_role)
        return {name: tool for name, tool in full_registry.items() if name in enabled_names}

    def _active_prompt(self) -> tuple[Optional[str], Optional[str]]:
        """(content, id) of the `ops-system` library prompt's currently
        active version (phase 02 prompt library) — "the default agent's
        prompt" until phase 04 lands per-agent prompt binding. `(None,
        None)` only if that library prompt or its active version is
        missing (falls back to `AgentLoop`'s own hardcoded `SYSTEM_PROMPT`
        default; should not happen once `ensure_ready` has seeded it)."""
        return prompts_repo.get_active_content("ops-system")

    def _close_subscribers(self, record: RunRecord) -> None:
        """Push the terminal sentinel to every live SSE subscriber queue so
        `GET /runs/{id}/events` connections close instead of hanging."""
        with record.lock:
            subscribers = list(record.subscribers)
            record.subscribers.clear()
        for q in subscribers:
            try:
                q.put_nowait(None)
            except queue.Full:  # noqa: BLE001
                pass

    def subscribe(
        self, run_id: str, sink: Optional[EventSink] = None
    ) -> Optional[tuple[EventSink, list[AgentEvent]]]:
        """Register an SSE subscriber for `run_id` and return it together with
        the run's history so far. Returns None if the run is unknown.

        History snapshot and registration happen under the same `record.lock`
        that `_on_event` holds while appending to history and copying the
        subscriber list, so every persisted event lands in exactly one of
        the two: the replay list or the sink. A client that connects late
        (after `approval_requested`, say) therefore still sees it, instead
        of waiting on a stream that will never mention it again.

        `sink` defaults to a bounded `queue.Queue`; the SSE endpoint passes an
        asyncio-loop bridge so delivery needs no worker thread. If the run is
        already terminal, the sink immediately gets the closing sentinel."""
        record = self.get(run_id)
        if record is None:
            return None
        target: EventSink = sink if sink is not None else queue.Queue(maxsize=1000)
        with record.lock:
            replay = list(record.history)
            terminal = record.status not in ("running", "pending_approval")
            if not terminal:
                record.subscribers.append(target)
        if terminal:
            target.put_nowait(None)
        return target, replay

    def unsubscribe(self, run_id: str, q: EventSink) -> None:
        record = self.get(run_id)
        if record is None:
            return
        with record.lock:
            if q in record.subscribers:
                record.subscribers.remove(q)

    def _persist_run(self, record: RunRecord) -> None:
        with record.lock:
            status = record.status
            result = record.result
            error = record.error
        try:
            db.upsert_run(
                {
                    "run_id": record.run_id,
                    "objective": record.objective,
                    "status": status,
                    "started_at": record.started_at,
                    "finished_at": time.time() if result is not None or error is not None else None,
                    "final_answer": result.final_answer if result is not None else None,
                    "steps_taken": result.steps_taken if result is not None else 0,
                    "trace_path": record.trace_path,
                    "error": error,
                    "session_id": record.session_id,
                    "prompt_version_id": record.prompt_version_id,
                    "triggered_by_automation_id": record.triggered_by_automation_id,
                    "owner_id": record.owner_id,
                    "agent_id": record.agent_id,
                    "skill_ids": record.skill_ids,
                }
            )
        except Exception:  # noqa: BLE001 - a persistence bug must never break a live run
            pass

    def _persist_terminal(
        self,
        record: RunRecord,
        status: AsyncRunStatus,
        result: Optional[RunResult],
        error: Optional[str],
    ) -> None:
        """Persist a run's terminal row to Postgres using explicit
        status/result/error rather than reading them off `record` (which is
        not yet mutated at the call sites — see `_worker` above). Must be
        called, and must return, before `record.status`/`record.result` are
        flipped in memory, so `db.get_run()` and `RunRegistry.snapshot()`
        can never disagree about whether a run has finished."""
        try:
            db.upsert_run(
                {
                    "run_id": record.run_id,
                    "objective": record.objective,
                    "status": status,
                    "started_at": record.started_at,
                    "finished_at": time.time(),
                    "final_answer": result.final_answer if result is not None else None,
                    "steps_taken": result.steps_taken if result is not None else 0,
                    "trace_path": record.trace_path,
                    "error": error,
                    "session_id": record.session_id,
                    "prompt_version_id": record.prompt_version_id,
                    "triggered_by_automation_id": record.triggered_by_automation_id,
                    "owner_id": record.owner_id,
                    "agent_id": record.agent_id,
                    "skill_ids": record.skill_ids,
                }
            )
        except Exception:  # noqa: BLE001 - a persistence bug must never break a live run
            pass

    def _make_approval_callback(self, record: RunRecord, config: HarnessConfig):
        def _callback(tool_name: str, tool_args: dict[str, Any]) -> bool:
            # `_on_event` (above) already set `record.pending_approval` and
            # flipped `record.status` to "pending_approval" synchronously
            # when the `approval_requested` trace event was logged, one
            # call earlier in `_request_approval` (loop.py). Reuse that
            # same object (and its `threading.Event`) so `resolve_approval`
            # — which reads/mutates `record.pending_approval` — resolves
            # the wait this thread is about to block on, instead of a
            # second, disconnected `PendingApproval`. Fall back to
            # constructing one here only if that didn't happen (e.g. a
            # future caller invokes this callback without going through
            # the trace logger first).
            with record.lock:
                pending = record.pending_approval
                if pending is None or pending.tool_name != tool_name:
                    pending = PendingApproval(tool_name=tool_name, tool_args=tool_args)
                    record.pending_approval = pending
                record.status = "pending_approval"
                if record.cancel_requested:
                    pending.decision = False
                    pending.event.set()

            # The human gets their own budget (`approval_timeout_seconds`,
            # 15 min by default), independent of the agent's wall-clock
            # budget: the loop excludes this wait from `max_wall_clock_seconds`.
            # A forgotten approval still cannot hang the thread forever.
            wait_started = time.monotonic()
            resolved_in_time = pending.event.wait(timeout=config.approval_timeout_seconds)

            with record.lock:
                record.pending_approval = None
                record.status = "running"

            if not resolved_in_time:
                # Not a denial: the loop ends the run as `cancelled` with an
                # explicit `approval_timed_out` event.
                raise ApprovalTimeout(time.monotonic() - wait_started, config.approval_timeout_seconds)
            return bool(pending.decision)

        return _callback

    def resolve_approval(self, run_id: str, approved: bool) -> None:
        """Resolve the pending approval for `run_id`, unblocking its
        background thread. Raises KeyError if the run is unknown and
        ValueError if it has no pending approval right now."""
        record = self.get(run_id)
        if record is None:
            raise KeyError(f"unknown run_id '{run_id}'")
        with record.lock:
            pending = record.pending_approval
        if pending is None:
            raise ValueError(f"run '{run_id}' has no pending approval")
        pending.decision = approved
        pending.event.set()

    def cancel_run(self, run_id: str) -> bool:
        """Request cooperative cancellation of a live run (the Stop button).
        Returns False if the run is unknown or already finished. A pending
        approval is resolved as *denied* so the paused thread wakes up; the
        loop then stops at its next checkpoint with status `cancelled`. An
        LLM request already in flight at the provider completes first (it
        cannot be aborted mid-response), but nothing after it runs."""
        record = self.get(run_id)
        if record is None:
            return False
        with record.lock:
            if record.status not in ("running", "pending_approval"):
                return False
            record.cancel_requested = True
            pending = record.pending_approval
        if pending is not None:
            pending.decision = False
            pending.event.set()
        return True

    def get(self, run_id: str) -> Optional[RunRecord]:
        with self._lock:
            return self._runs.get(run_id)

    def pending_approvals(self) -> list[dict[str, Any]]:
        """Runs in this process currently paused on an approval, oldest first:
        `{run_id, objective, session_id, owner_id, tool_name, started_at}`."""
        with self._lock:
            records = list(self._runs.values())
        waiting = []
        for record in records:
            with record.lock:
                pending = record.pending_approval
                status = record.status
            if pending is not None and status == "pending_approval":
                waiting.append(
                    {
                        "run_id": record.run_id,
                        "objective": record.objective,
                        "session_id": record.session_id,
                        "owner_id": record.owner_id,
                        "tool_name": pending.tool_name,
                        "started_at": record.started_at,
                    }
                )
        return sorted(waiting, key=lambda r: r["started_at"])

    def forget_session(self, session_id: str) -> bool:
        """Drop every in-memory run of `session_id` (the session is being
        deleted). Returns False, and drops nothing, if one of them is still
        running or waiting on an approval."""
        with self._lock:
            records = [r for r in self._runs.values() if r.session_id == session_id]
            for record in records:
                with record.lock:
                    if record.status in ("running", "pending_approval"):
                        return False
            for record in records:
                del self._runs[record.run_id]
        return True

    def list_runs(self) -> list[RunRecord]:
        """Most-recently-started first."""
        with self._lock:
            records = list(self._runs.values())
        return sorted(records, key=lambda r: r.started_at, reverse=True)

    def latest_live_run_for_session(self, session_id: str) -> Optional[RunRecord]:
        """Most-recently-started in-memory run tied to `session_id`, or None.
        Backs `GET /sessions`'s live-status overlay: a session's in-flight
        run has no terminal Postgres row yet, so its true current status
        only exists here, in this process's memory."""
        with self._lock:
            candidates = [r for r in self._runs.values() if r.session_id == session_id]
        if not candidates:
            return None
        return max(candidates, key=lambda r: r.started_at)

    def snapshot(self, run_id: str) -> Optional[dict[str, Any]]:
        """Plain-dict snapshot of a run's current state, safe to hand to a
        pydantic response model. Returns None if `run_id` is unknown."""
        record = self.get(run_id)
        if record is None:
            return None
        with record.lock:
            history = list(record.history)
            pending = record.pending_approval
            status = record.status
            result = record.result
            error = record.error
        steps_taken = result.steps_taken if result is not None else (history[-1].step if history else 0)
        final_answer = result.final_answer if result is not None else None
        return {
            "run_id": record.run_id,
            "objective": record.objective,
            "status": status,
            "started_at": record.started_at,
            "steps_taken": steps_taken,
            "final_answer": final_answer,
            "pending_approval": (
                {
                    "tool_name": pending.tool_name,
                    "tool_args": pending.tool_args,
                    "preview": pending.preview,
                }
                if pending is not None
                else None
            ),
            "history": history,
            "trace_path": record.trace_path,
            "error": error,
            "session_id": record.session_id,
            "prompt_version_id": record.prompt_version_id,
            "triggered_by_automation_id": record.triggered_by_automation_id,
            "owner_id": record.owner_id,
            "agent_id": record.agent_id,
            "skill_ids": record.skill_ids,
        }

    def summary(self, record: RunRecord) -> dict[str, Any]:
        """Lightweight dict for the run-history list endpoint."""
        with record.lock:
            status = record.status
        return {
            "run_id": record.run_id,
            "objective": record.objective,
            "status": status,
            "started_at": record.started_at,
            "session_id": record.session_id,
            "prompt_version_id": record.prompt_version_id,
            "triggered_by_automation_id": record.triggered_by_automation_id,
            "owner_id": record.owner_id,
            "agent_id": record.agent_id,
            "skill_ids": record.skill_ids,
        }


def persisted_summary(row: dict[str, Any]) -> dict[str, Any]:
    """Shape a `db.list_runs()` row into the same dict shape as
    `RunRegistry.summary()`, for runs from a previous process (restart
    survival) that are no longer held in memory."""
    return {
        "run_id": row["run_id"],
        "objective": row["objective"],
        "status": row["status"],
        "started_at": row["started_at"],
        "session_id": row.get("session_id"),
        "prompt_version_id": row.get("prompt_version_id"),
        "triggered_by_automation_id": row.get("triggered_by_automation_id"),
        "owner_id": row.get("owner_id", "u_admin"),
        "agent_id": row.get("agent_id"),
        "skill_ids": list(row.get("skill_ids") or []),
    }


def persisted_snapshot(row: dict[str, Any]) -> dict[str, Any]:
    """Shape a `db.get_run()` row (run + its events) into the same dict
    shape as `RunRegistry.snapshot()`."""
    return {
        "run_id": row["run_id"],
        "objective": row["objective"],
        "status": row["status"],
        "started_at": row["started_at"],
        "steps_taken": row["steps_taken"] or 0,
        "final_answer": row["final_answer"],
        "pending_approval": None,
        "history": row["history"],
        "trace_path": row["trace_path"],
        "error": row["error"],
        "session_id": row.get("session_id"),
        "prompt_version_id": row.get("prompt_version_id"),
        "triggered_by_automation_id": row.get("triggered_by_automation_id"),
        "owner_id": row.get("owner_id", "u_admin"),
        "agent_id": row.get("agent_id"),
        "skill_ids": list(row.get("skill_ids") or []),
    }
