"""Run routes: a synchronous convenience endpoint plus the real async pause/resume flow.

1. `POST /run` (kept for the Postman collection / non-UI callers): fully
   synchronous, request/response. Approval for `create_incident` is
   pre-authorized via the `auto_approve` boolean in the request body, decided
   *before* the run starts. This is NOT a real pause/resume flow — it is a
   request-level pre-authorization, documented as such.

2. `POST /runs` + `GET /runs/{run_id}` + `POST /runs/{run_id}/approve` (used by
   the web UI): the real pause/resume flow. `POST /runs` starts
   `AgentLoop.run(...)` on a background thread and returns immediately. When the
   loop reaches an approval-gated tool, `RunRegistry`'s callback records the
   pending tool call, flips the run's status to `pending_approval`, and blocks
   that background thread on a `threading.Event` (bounded by its own
   `approval_timeout_seconds`, 15 min by default and excluded from the agent's
   wall-clock budget, so a forgotten approval cannot hang forever).
   `GET /runs/{run_id}` returns a live snapshot; `POST /runs/{run_id}/approve`
   resolves the pending approval and unblocks the thread; `GET /runs` lists
   recent runs; `GET /approvals/pending` lists the runs waiting on the caller.

See `docs/design-report.md` section 6 for the design this replaced and why.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from agent_harness import agent_runtime, db, prompt_verification, rbac, state
from agent_harness.agent_runtime import SlashCommandError
from agent_harness.api_models import (
    ApproveRequest,
    PendingApprovalItem,
    PlaygroundSpec,
    RunRequest,
    RunSnapshot,
    RunSummary,
    StartRunRequest,
    StartRunResponse,
)
from agent_harness.approval import fixed_decision_approval
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.loop import AgentLoop
from agent_harness.rbac import Resource
from agent_harness.repos import feedback as feedback_repo
from agent_harness.repos import memories as memories_repo
from agent_harness.repos import prompts as prompts_repo
from agent_harness.routers.sessions import new_session_title, resolve_session_agent_id
from agent_harness.run_registry import persisted_snapshot, persisted_summary
from agent_harness.schemas import AgentEvent, RunResult
from agent_harness.tools.registry import build_default_registry

router = APIRouter()

_CONTEXT_MAX_TURNS = 6
_CONTEXT_ANSWER_CHARS = 700


class RunTokenTotals(BaseModel):
    run_id: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    llm_calls: int = Field(description="Number of llm_decision events (LLM calls) this run made.")


class UsageToday(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    llm_calls: int
    run_count: int = Field(description="Distinct runs with at least one LLM call today.")


class UsedMemory(BaseModel):
    id: str
    fact: str
    tags: list[str]
    exists: bool = Field(description="False when the memory has been deleted since this run used it.")


class RunMemories(BaseModel):
    used: list[UsedMemory] = Field(description="Memories `recall` returned during this run.")
    saved: list[UsedMemory] = Field(description="Facts this run stored with `remember`.")


class FeedbackRequest(BaseModel):
    rating: Literal["up", "down"]
    note: str = Field(default="", max_length=1000)


class FeedbackView(BaseModel):
    run_id: str
    user_id: str
    user_name: str = ""
    rating: Literal["up", "down"]
    note: str
    updated_at: str


class RunFeedback(BaseModel):
    mine: Optional[FeedbackView] = None
    others: list[FeedbackView] = Field(default_factory=list, description="Other users' votes; visible to the run owner/admin.")
    judge_score: Optional[float] = Field(default=None, description="The LLM judge's latest task_success score, 0-1.")
    judge_passed: Optional[bool] = None
    judge_rationale: Optional[str] = None


def owner_scope(user: CurrentUser) -> Optional[str]:
    """`None` (no filter) for admin, otherwise the caller's own id: the
    aggregate/list endpoints only ever reflect a non-admin's own runs."""
    return None if user.role == "admin" else user.id


def _unknown_run(run_id: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"unknown run_id '{run_id}'")


def _readable_run_owner(run_id: str, user: CurrentUser) -> str:
    """The run's owner id if the caller may read it; 404 for an unknown run or
    one the caller cannot see (never confirm existence)."""
    live = state.registry.get(run_id)
    owner_id = live.owner_id if live is not None else None
    if owner_id is None:
        row = db.get_run(run_id)
        if row is None:
            raise _unknown_run(run_id)
        owner_id = row.get("owner_id")
    if not rbac.can_read(user.id, user.role, Resource(owner_id=owner_id)):
        raise _unknown_run(run_id)
    return owner_id or ""


@router.post("/run", response_model=RunResult)
def run(request: RunRequest, user: CurrentUser = Depends(require("chat"))) -> RunResult:
    """Synchronous convenience endpoint. See module docstring: this
    pre-authorizes approval via `auto_approve` rather than pausing."""
    if not request.objective.strip():
        raise HTTPException(status_code=422, detail="objective must not be blank")

    config = state.build_config(request.max_steps, request.max_wall_clock_seconds)
    enabled_names = db.list_enabled_tool_names()
    tools = {
        name: tool for name, tool in build_default_registry(user.id, user.role).items() if name in enabled_names
    }
    active_content, _active_id = prompts_repo.get_active_content("ops-system")
    loop = AgentLoop(
        model=state.new_llm_client(),
        tools=tools,
        config=config,
        approval_callback=fixed_decision_approval(request.auto_approve),
        system_prompt=active_content,
    )
    return loop.run(request.objective)


def _conversation_context(session_id: str) -> Optional[str]:
    """The finished earlier turns of a chat session as plain text (oldest
    first, last few only, answers truncated), appended to the next run's
    system prompt so follow-ups have the conversation in view."""
    turns = [
        r
        for r in reversed(db.list_runs_for_session(session_id))
        if r.get("final_answer") and r.get("status") == "completed"
    ][-_CONTEXT_MAX_TURNS:]
    if not turns:
        return None
    lines = []
    for turn in turns:
        answer = str(turn["final_answer"]).strip()
        if len(answer) > _CONTEXT_ANSWER_CHARS:
            answer = answer[:_CONTEXT_ANSWER_CHARS] + "..."
        lines.append(f"User: {turn['objective']}\nAssistant: {answer}")
    return "\n\n".join(lines)


def _resolve_playground_prompt(spec: PlaygroundSpec, user: CurrentUser) -> tuple[str, Optional[str]]:
    """(system prompt text, version id) for a Playground run. Needs the
    `mutate_prompts` permission (it runs arbitrary prompt text against real
    tools and real LLM cost) and, for a saved version, read access to its
    prompt. A draft is linted first: an `error`-severity draft is refused."""
    if not rbac.can(user.role, "mutate_prompts"):
        raise HTTPException(status_code=403, detail=f"role '{user.role}' may not use the prompt playground")
    if spec.prompt_version_id:
        if not spec.prompt_id:
            raise HTTPException(status_code=422, detail="prompt_id is required with prompt_version_id")
        prompt = prompts_repo.get_prompt(spec.prompt_id)
        if (
            prompt is None
            or prompt.get("archived_at") is not None
            or not rbac.can_read(
                user.id, user.role, Resource(owner_id=prompt["owner_id"], visibility=prompt["visibility"])
            )
        ):
            raise HTTPException(status_code=404, detail=f"unknown prompt '{spec.prompt_id}'")
        content, version_id = prompts_repo.get_pinned_content(spec.prompt_id, spec.prompt_version_id)
        if content is None:
            raise HTTPException(status_code=404, detail=f"unknown version '{spec.prompt_version_id}'")
        return content, version_id
    if spec.system_prompt is None:
        raise HTTPException(status_code=422, detail="playground needs a system_prompt or a prompt_version_id")
    lint = prompt_verification.lint_prompt(spec.system_prompt)
    errors = [i.message for i in lint.issues if i.severity == "error"]
    if errors:
        raise HTTPException(status_code=422, detail="draft prompt failed lint: " + "; ".join(errors))
    return spec.system_prompt, None


@router.post("/runs/{run_id}/cancel", response_model=RunSnapshot)
def cancel_run(run_id: str, user: CurrentUser = Depends(current_user)) -> RunSnapshot:
    """Stop a running (or approval-paused) run. Same ownership rule as
    approving: the run's owner or an admin; unreadable -> 404, readable but
    not yours -> 403; an already-finished run -> 409. Takes effect at the
    loop's next checkpoint (an LLM request already in flight finishes
    first); a pending approval is denied so the paused thread wakes up."""
    record = state.registry.get(run_id)
    owner_id: Optional[str]
    if record is not None:
        owner_id = record.owner_id
    else:
        # Not live in this process: a row left by a previous process (restart/
        # crash) can still read "running". Stopping it is a DB-only update.
        row = db.get_run(run_id)
        if row is None:
            raise _unknown_run(run_id)
        owner_id = row.get("owner_id")
    resource = Resource(owner_id=owner_id)
    if not rbac.can_read(user.id, user.role, resource):
        raise _unknown_run(run_id)
    if not rbac.can_approve(user.id, user.role, resource):
        raise HTTPException(status_code=403, detail="only the run's owner or an admin may stop it")
    if record is not None:
        if not state.registry.cancel_run(run_id):
            raise HTTPException(status_code=409, detail=f"run '{run_id}' is not running")
        snapshot = state.registry.snapshot(run_id)
        assert snapshot is not None
        return RunSnapshot(**snapshot)
    if not db.cancel_orphaned_run(run_id):
        raise HTTPException(status_code=409, detail=f"run '{run_id}' is not running")
    persisted = db.get_run(run_id)
    assert persisted is not None
    return RunSnapshot(**persisted_snapshot(persisted))


@router.post("/runs", response_model=StartRunResponse, status_code=202)
def start_run(request: StartRunRequest, user: CurrentUser = Depends(require("chat"))) -> StartRunResponse:
    """Start a run in the background and return immediately. Poll
    `GET /runs/{run_id}` for progress and approve/deny via
    `POST /runs/{run_id}/approve` when status is `pending_approval`. Every
    run belongs to a Sessions entry: pass an existing `session_id`, or omit
    it to auto-create one from the objective (what '+ New chat' does). An
    existing `session_id` owned by someone else (and not visible to the
    caller) 404s — the same "don't leak existence" rule as `GET
    /sessions/{id}`."""
    if not request.objective.strip():
        raise HTTPException(status_code=422, detail="objective must not be blank")
    try:
        agent_runtime.validate_slash_command(request.objective, user.id, user.role)
    except SlashCommandError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    override_prompt: Optional[str] = None
    override_version_id: Optional[str] = None
    if request.playground is not None:
        override_prompt, override_version_id = _resolve_playground_prompt(request.playground, user)

    now = datetime.now(timezone.utc).isoformat()
    context_text: Optional[str] = None
    if request.session_id is not None:
        existing = db.get_session(request.session_id)
        if existing is None or not rbac.can_read(user.id, user.role, Resource(owner_id=existing.get("owner_id"))):
            raise HTTPException(status_code=404, detail=f"unknown session_id '{request.session_id}'")
        session_id = request.session_id
        # A session's agent is fixed for its lifetime (set at creation) —
        # an `agent_id` on this request is ignored once a session_id is
        # given, per StartRunRequest.agent_id's documented precedence.
        agent_id = existing.get("agent_id")
        context_text = _conversation_context(session_id)
    else:
        session_id = uuid.uuid4().hex[:12]
        agent_id = resolve_session_agent_id(request.agent_id)
        title = new_session_title(request.objective)
        if request.playground is not None:
            title = f"[Playground] {title}"
        elif request.agent_test:
            title = f"[Test] {title}"
        db.create_session(session_id, title, now, owner_id=user.id, agent_id=agent_id)

    config = state.build_config(request.max_steps, request.max_wall_clock_seconds)
    try:
        record = state.registry.start_run(
            objective=request.objective,
            model=state.new_llm_client(),
            config=config,
            session_id=session_id,
            owner_id=user.id,
            owner_role=user.role,
            agent_id=agent_id,
            # A separate model instance from the main loop's (never the same
            # object) — the auto-mode router agent has its own output_type/
            # tool shape entirely distinct from the main run's agent, so it
            # must never share a stateful test double's call-count/script
            # position with the main loop. See agent_runtime.resolve_run_plan.
            router_model=state.new_llm_client(),
            system_prompt_override=override_prompt,
            prompt_version_id_override=override_version_id,
            conversation_context=context_text,
        )
    except SlashCommandError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    db.touch_session(session_id, now, "running")
    return StartRunResponse(run_id=record.run_id, status=record.status, session_id=session_id)


@router.get("/runs", response_model=list[RunSummary])
def list_runs(user: CurrentUser = Depends(current_user)) -> list[RunSummary]:
    """Live (in-memory) runs from this process, merged with runs persisted
    to Postgres by a previous process — this is what makes `GET /runs`
    survive a restart. Live entries win on id collision (they're the
    up-to-date source of truth while the run is still in flight). Filtered
    to runs the caller owns, or every run for admin."""
    live = [RunSummary(**state.registry.summary(record)) for record in state.registry.list_runs()]
    live_ids = {r.run_id for r in live}
    persisted = [
        RunSummary(**persisted_summary(row)) for row in db.list_runs() if row["run_id"] not in live_ids
    ]
    combined = sorted(live + persisted, key=lambda r: r.started_at, reverse=True)
    return [r for r in combined if rbac.can_read(user.id, user.role, Resource(owner_id=r.owner_id))]


@router.get("/approvals/pending", response_model=list[PendingApprovalItem])
def list_pending_approvals(user: CurrentUser = Depends(current_user)) -> list[PendingApprovalItem]:
    """Runs currently paused on a human approval that the caller may resolve
    (their own runs; every run for an admin), oldest first — backs the
    header's live pending-approval badge."""
    return [
        PendingApprovalItem(**item)
        for item in state.registry.pending_approvals()
        if rbac.can_approve(user.id, user.role, Resource(owner_id=item["owner_id"]))
    ]


@router.get("/runs/{run_id}", response_model=RunSnapshot)
def get_run(run_id: str, user: CurrentUser = Depends(current_user)) -> RunSnapshot:
    snapshot = state.registry.snapshot(run_id)
    if snapshot is not None:
        if not rbac.can_read(user.id, user.role, Resource(owner_id=snapshot.get("owner_id"))):
            raise _unknown_run(run_id)
        return RunSnapshot(**snapshot)
    row = db.get_run(run_id)
    if row is None or not rbac.can_read(user.id, user.role, Resource(owner_id=row.get("owner_id"))):
        raise _unknown_run(run_id)
    return RunSnapshot(**persisted_snapshot(row))


@router.post("/runs/{run_id}/approve", response_model=RunSnapshot)
def approve_run(run_id: str, request: ApproveRequest, user: CurrentUser = Depends(current_user)) -> RunSnapshot:
    """Resolve a pending approval. Only the run's owner (it is their chat —
    including a viewer's own run) or an admin may approve/deny; anyone else
    readable-but-unwritable -> 403, unreadable -> 404 (same rule as every
    other owned resource)."""
    record = state.registry.get(run_id)
    if record is None:
        row = db.get_run(run_id)
        if row is None or not rbac.can_read(user.id, user.role, Resource(owner_id=row.get("owner_id"))):
            raise _unknown_run(run_id)
        # Persisted but not live here: nothing is waiting on this approval.
        raise HTTPException(status_code=409, detail=f"run '{run_id}' has no live worker to approve")
    resource = Resource(owner_id=record.owner_id)
    if not rbac.can_read(user.id, user.role, resource):
        raise _unknown_run(run_id)
    if not rbac.can_approve(user.id, user.role, resource):
        raise HTTPException(status_code=403, detail="only the run's owner or an admin may approve it")
    try:
        state.registry.resolve_approval(run_id, request.approved)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        # No pending approval right now (already resolved, timed out, or the
        # run never reached one) — a conflict, not a missing resource.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    snapshot = state.registry.snapshot(run_id)
    assert snapshot is not None  # resolve_approval above already validated run_id exists
    return RunSnapshot(**snapshot)


_KEEPALIVE_SECONDS = 15.0
# Bound per-connection memory: token deltas are dropped (never persisted
# events or the end sentinel) once a stuck client has this many queued.
_SINK_MAX_DELTAS = 1000


class _LoopSink:
    """Thread-safe bridge from the run's worker thread into this connection's
    asyncio queue. `put_nowait` is called on the worker thread and hops onto
    the server event loop with `call_soon_threadsafe`, so the stream needs no
    executor thread per connection (a blocking `queue.get` in the default
    executor ties up one thread per open stream and can starve delivery)."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self.queue: asyncio.Queue[Optional[AgentEvent]] = asyncio.Queue()

    def put_nowait(self, item: Optional[AgentEvent]) -> None:
        try:
            self._loop.call_soon_threadsafe(self._offer, item)
        except RuntimeError:  # event loop already closed (server shutting down)
            pass

    def _offer(self, item: Optional[AgentEvent]) -> None:
        if item is not None and item.event_type == "llm_token_delta" and self.queue.qsize() >= _SINK_MAX_DELTAS:
            return
        self.queue.put_nowait(item)


def _sse_response(body: AsyncIterator[str]) -> StreamingResponse:
    # `no-cache` / `X-Accel-Buffering: no` keep intermediaries (reverse
    # proxies, dev proxies) from holding events back until the stream ends.
    return StreamingResponse(
        body,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


def _sse_pack(event_type: str, payload: dict[str, Any]) -> str:
    return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"


@router.get("/runs/{run_id}/events")
async def stream_run_events(
    run_id: str, user: CurrentUser = Depends(current_user)
) -> StreamingResponse:
    """Server-Sent Events stream of every `AgentEvent` recorded for `run_id`
    for a run: first the run's history so far (recorded before this
    connection subscribed), then every new event the instant it is recorded,
    pushed from the run's worker thread onto this event loop. The replay
    closes the gap between the frontend's `GET /runs/{id}` snapshot and the
    subscription: without it an event recorded in between (for example
    `approval_requested`) was never delivered, and the UI waited on a stream
    that would not mention it again. Clients dedupe the replay against their
    snapshot by step+event_type+timestamp.

    Identity here comes from `?as_user=` (see `current_user`'s docstring):
    `EventSource` cannot set the `X-User-Id` header the rest of the API uses.

    Closes (ends the SSE stream, not an error) once the run reaches a
    terminal status, or the run is unknown / already persisted-only (a
    previous process's completed run) — in the latter case a single
    `run_snapshot` event carrying the full persisted history is sent instead
    of an empty hang, then the stream closes.
    """
    live_record = state.registry.get(run_id)
    if live_record is not None and not rbac.can_read(
        user.id, user.role, Resource(owner_id=live_record.owner_id)
    ):
        raise _unknown_run(run_id)

    sink = _LoopSink(asyncio.get_running_loop())
    subscription = state.registry.subscribe(run_id, sink)
    if subscription is None:
        row = db.get_run(run_id)
        if row is None or not rbac.can_read(user.id, user.role, Resource(owner_id=row.get("owner_id"))):
            raise _unknown_run(run_id)

        async def _persisted_only() -> AsyncIterator[str]:
            yield _sse_pack("run_snapshot", persisted_snapshot(row))
            yield _sse_pack("stream_end", {"run_id": run_id})

        return _sse_response(_persisted_only())
    _, replay = subscription

    async def _live_stream() -> AsyncIterator[str]:
        try:
            # History recorded before this connection subscribed (the client
            # dedupes against its snapshot by step+type+timestamp), then live.
            for past in replay:
                yield _sse_pack(past.event_type, past.model_dump())
            while True:
                try:
                    event = await asyncio.wait_for(sink.queue.get(), timeout=_KEEPALIVE_SECONDS)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if event is None:
                    yield _sse_pack("stream_end", {"run_id": run_id})
                    break
                yield _sse_pack(event.event_type, event.model_dump())
        finally:
            state.registry.unsubscribe(run_id, sink)

    return _sse_response(_live_stream())


@router.get("/runs/{run_id}/export")
def export_run(run_id: str, user: CurrentUser = Depends(current_user)) -> dict[str, Any]:
    """Full trace export for a single run — every persisted event plus run
    metadata, as one JSON document. Used by the Logs page's download button
    (attach evidence to a submission) and is a legitimate observability
    feature in its own right: the audit log a real ops team would want.
    Prefers the Postgres-persisted copy (authoritative once a run finishes and
    survives restarts); falls back to the live in-memory snapshot for a run
    still in flight in this process."""
    row = db.get_run(run_id)
    if row is not None:
        if not rbac.can_read(user.id, user.role, Resource(owner_id=row.get("owner_id"))):
            raise _unknown_run(run_id)
        return persisted_snapshot(row)
    snapshot = state.registry.snapshot(run_id)
    if snapshot is None or not rbac.can_read(user.id, user.role, Resource(owner_id=snapshot.get("owner_id"))):
        raise _unknown_run(run_id)
    return snapshot


@router.get("/runs/{run_id}/tokens", response_model=RunTokenTotals)
def get_run_tokens(run_id: str, user: CurrentUser = Depends(current_user)) -> RunTokenTotals:
    """Real Postgres aggregation (`SUM`/`COUNT` over the persisted `events`
    table, see `db.aggregate_run_tokens`) of this run's prompt/completion/
    total token usage across every `llm_decision` event — not a client-side
    sum over `GET /runs/{run_id}`'s history. 404s only if `run_id` is
    entirely unknown (never started, or not visible to the caller); a
    known run with zero LLM calls so far returns all-zero totals."""
    _readable_run_owner(run_id, user)
    return RunTokenTotals(run_id=run_id, **db.aggregate_run_tokens(run_id))


def _tool_outputs(history: list[Any], tool_name: str) -> list[dict[str, Any]]:
    """The `output` payloads of every successful call of `tool_name` in a trace."""
    outputs = []
    for event in history:
        event_type = event["event_type"] if isinstance(event, dict) else event.event_type
        data = event["data"] if isinstance(event, dict) else event.data
        if event_type == "tool_call_result" and data.get("tool_name") == tool_name:
            outputs.append(data.get("output") or {})
    return outputs


@router.get("/runs/{run_id}/memories", response_model=RunMemories)
def get_run_memories(run_id: str, user: CurrentUser = Depends(current_user)) -> RunMemories:
    """Which long-term memories this run used (`recall` results) and which it
    stored (`remember`), read back from its own trace, and whether each still exists."""
    _readable_run_owner(run_id, user)
    snapshot = state.registry.snapshot(run_id)
    history: list[Any]
    if snapshot is not None:
        history = list(snapshot["history"])
    else:
        row = db.get_run(run_id)
        history = row["history"] if row else []

    used: dict[str, dict[str, Any]] = {}
    for output in _tool_outputs(history, "recall"):
        if output.get("matched") is False:
            continue  # nothing matched: the fallback "recent memories" were not evidence the run relied on
        for memory in output.get("memories") or []:
            used.setdefault(memory["id"], memory)
    saved: dict[str, dict[str, Any]] = {}
    for output in _tool_outputs(history, "remember"):
        if output.get("memory_id"):
            saved.setdefault(output["memory_id"], {"id": output["memory_id"], "fact": output.get("fact", ""), "tags": output.get("tags") or []})

    alive = {m["id"] for m in memories_repo.get_many(list({*used, *saved}))}

    def _view(m: dict[str, Any]) -> UsedMemory:
        return UsedMemory(id=m["id"], fact=m.get("fact", ""), tags=list(m.get("tags") or []), exists=m["id"] in alive)

    return RunMemories(used=[_view(m) for m in used.values()], saved=[_view(m) for m in saved.values()])


def _feedback_view(row: dict[str, Any]) -> FeedbackView:
    return FeedbackView(
        run_id=row["run_id"],
        user_id=row["user_id"],
        user_name=row.get("display_name") or row["user_id"],
        rating="up" if row["rating"] > 0 else "down",
        note=row["note"],
        updated_at=row["updated_at"],
    )


@router.get("/runs/{run_id}/feedback", response_model=RunFeedback)
def get_run_feedback(run_id: str, user: CurrentUser = Depends(current_user)) -> RunFeedback:
    """The caller's own thumbs-up/down on this run, other people's votes (shown
    to the run owner and admin only), and the LLM judge's score next to them."""
    owner_id = _readable_run_owner(run_id, user)
    rows = feedback_repo.list_feedback_for_run(run_id)
    mine = next((r for r in rows if r["user_id"] == user.id), None)
    can_see_all = user.role == "admin" or owner_id == user.id
    others = [_feedback_view(r) for r in rows if r["user_id"] != user.id] if can_see_all else []
    verdict = feedback_repo.latest_judge_verdicts([run_id]).get(run_id)
    return RunFeedback(
        mine=_feedback_view(mine) if mine else None,
        others=others,
        judge_score=verdict["score"] if verdict else None,
        judge_passed=feedback_repo.judge_passed(verdict) if verdict else None,
        judge_rationale=verdict["rationale"] if verdict else None,
    )


@router.put("/runs/{run_id}/feedback", response_model=RunFeedback)
def put_run_feedback(run_id: str, request: FeedbackRequest, user: CurrentUser = Depends(current_user)) -> RunFeedback:
    """Record (or replace) the caller's thumbs-up/down and note on a run they can read."""
    _readable_run_owner(run_id, user)
    if db.get_run(run_id) is None:
        raise HTTPException(status_code=409, detail="the run has not been saved yet: give feedback once it has started")
    feedback_repo.upsert_feedback(run_id, user.id, 1 if request.rating == "up" else -1, request.note.strip())
    return get_run_feedback(run_id, user)


@router.delete("/runs/{run_id}/feedback", response_model=RunFeedback)
def delete_run_feedback(run_id: str, user: CurrentUser = Depends(current_user)) -> RunFeedback:
    _readable_run_owner(run_id, user)
    feedback_repo.delete_feedback(run_id, user.id)
    return get_run_feedback(run_id, user)


@router.get("/usage/today", response_model=UsageToday)
def get_usage_today(user: CurrentUser = Depends(current_user)) -> UsageToday:
    """Real Postgres aggregation of token usage across every run's
    `llm_decision` events recorded today (server-local calendar day; see
    `db.aggregate_usage_today`) — a single SQL query, not client-side
    summing across `GET /runs`."""
    return UsageToday(**db.aggregate_usage_today(owner_id=owner_scope(user)))
