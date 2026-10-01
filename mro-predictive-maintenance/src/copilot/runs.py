"""Async run execution + SSE event fan-out for the copilot API.

Builds directly on ``src.copilot.hitl``'s primitives -- guardrail input
check, message-history persistence, pending-record creation, restart-safe
resume -- rather than duplicating them (``hitl.py``'s own docstring
reserves the async/streaming execution path for this phase: "phase 06 owns
the async/streaming (SSE) surface (``agent.iter`` + ``node.stream()``) and
will call into a thin async sibling").

Real per-token streaming
-------------------------
``agent.iter()`` + ``node.stream()`` gives real character-by-character
deltas for **both** backends. A real, reproducible bug used to live in the
offline-scripted backend's ``src/copilot/models.py::_stream_route``: it
yielded a raw ``ToolCallPart`` object for tool-call turns instead of the
``DeltaToolCalls`` mapping Pydantic AI's ``FunctionModel.request_stream``
contract requires, which made ``node.stream()`` raise
``UnexpectedModelBehavior`` (exceeded output retries) for ANY offline turn
that started with a tool call -- i.e. almost every real HITL scenario.
Fixed in ``models.py`` (``_stream_route`` now yields proper
``{0: DeltaToolCall(...)}`` mappings) and verified via a standalone
``node.stream()`` spike against the offline router's tool-call turns
before this workaround was removed -- so both backends now go through the
identical ``node.stream()`` path below; no offline-only branch remains.

One active turn per run: ``RunManager`` tracks in-flight run ids in
memory; ``resolve``/``start_run`` on a run already running raises
``RunBusyError`` (-> 409 at the API layer). On process start,
``recover_interrupted`` marks any run stuck in ``status="running"`` (a
crash mid-turn) as ``failed`` -- ``awaiting_input`` runs are left alone,
never auto-resolved.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from pydantic_ai import Agent
from pydantic_ai.messages import PartDeltaEvent, TextPartDelta
from pydantic_ai.tools import DeferredToolRequests, DeferredToolResults, ToolApproved, ToolDenied
from sqlalchemy import select, update
from sqlalchemy.engine import Engine

from src.copilot import guardrails, models as copilot_models, tracing
from src.copilot.agent import build_agent
from src.copilot.hitl import (
    ALLOWED_OVERRIDE_KEYS,
    MAX_REPEATED_APPROVALS_PER_RUN,
    ApprovalNotAllowedError,
    PendingResolutionError,
    Resolution,
    RunNotFound,
    _count_prior_identical_approvals,
    _get_run,
    _load_history,
    _log_guardrail_event,
    _now,
    _pending_record,
    _persist_history,
    is_stale,
    pending_args,
    pending_question,
)
from src.copilot.identity import can_approve
from src.copilot.tables import copilot_events
from src.copilot.tools import CopilotDeps
from src.ops.db import copilot_pending, copilot_runs


class RunBusyError(Exception):
    """Raised when resolve()/start_run() targets a run that already has an
    active turn in flight (one active turn per run, per phase spec)."""


@dataclass
class _RunHandle:
    queues: list[asyncio.Queue] = field(default_factory=list)


class RunManager:
    def __init__(self, engine: Engine, kb_index, model_store):
        self.engine = engine
        self.kb_index = kb_index
        self.model_store = model_store
        self._handles: dict[str, _RunHandle] = {}
        self._running: set[str] = set()

    # -- bookkeeping ----------------------------------------------------

    def recover_interrupted(self) -> int:
        """Mark any run left ``status='running'`` by a crashed process as
        ``failed`` -- ``awaiting_input`` runs are untouched (phase risk
        table: "background tasks die on --reload")."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(copilot_runs.c.id).where(copilot_runs.c.status == "running")
            ).scalars().all()
            for run_id in rows:
                conn.execute(update(copilot_runs).where(copilot_runs.c.id == run_id).values(
                    status="failed", final_answer="interrupted: process restarted while a turn was in flight",
                ))
            conn.commit()
        return len(rows)

    def is_running(self, run_id: str) -> bool:
        return run_id in self._running

    def _handle(self, run_id: str) -> _RunHandle:
        return self._handles.setdefault(run_id, _RunHandle())

    def subscribe(self, run_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._handle(run_id).queues.append(q)
        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue) -> None:
        handle = self._handles.get(run_id)
        if handle and q in handle.queues:
            handle.queues.remove(q)

    def events_since(self, run_id: str, last_event_id: int) -> list[dict]:
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(copilot_events).where(
                    copilot_events.c.run_id == run_id, copilot_events.c.id > last_event_id,
                ).order_by(copilot_events.c.id)
            ).mappings().all()
        return [
            {"id": r["id"], "type": r["type"], "payload": json.loads(r["payload_json"] or "null")}
            for r in rows
        ]

    def _emit(self, run_id: str, event_type: str, payload: dict) -> Optional[int]:
        event_id = None
        if event_type != "token":
            with self.engine.connect() as conn:
                result = conn.execute(copilot_events.insert().values(
                    run_id=run_id, seq=0, type=event_type,
                    payload_json=json.dumps(payload), at=_now(),
                ))
                conn.commit()
                event_id = result.inserted_primary_key[0]
                conn.execute(update(copilot_events).where(copilot_events.c.id == event_id).values(seq=event_id))
                conn.commit()
        handle = self._handles.get(run_id)
        if handle:
            for q in list(handle.queues):
                q.put_nowait({"id": event_id, "type": event_type, "payload": payload})
        return event_id

    # -- run lifecycle ----------------------------------------------------

    def start_run(self, prompt: str, *, trigger: str = "user", alert_id: Optional[int] = None,
                   actor: str = "engineer.demo") -> str:
        from src.copilot import hitl

        run_id = hitl.create_run(self.engine, prompt=prompt, trigger=trigger, alert_id=alert_id)
        self._schedule(run_id, actor=actor, prompt=prompt, deferred_results=None)
        return run_id

    def resolve(self, run_id: str, resolutions: list[Resolution], actor: str) -> None:
        if self.is_running(run_id):
            raise RunBusyError(f"run {run_id!r} already has a turn in flight")
        deferred_results = self._build_deferred_results(run_id, resolutions, actor)
        self._schedule(run_id, actor=actor, prompt=None, deferred_results=deferred_results)

    def _build_deferred_results(self, run_id: str, resolutions: list[Resolution], actor: str) -> DeferredToolResults:
        """Validate + apply resolutions against ``copilot_pending`` and build
        the ``DeferredToolResults`` Pydantic AI needs to resume. Mirrors
        ``hitl.resolve``'s validation loop (that function inlines a
        synchronous, blocking ``run_turn`` call so it cannot be reused
        directly from an async context without blocking the event loop) --
        the DB update statements themselves are identical, not reinvented."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(copilot_pending).where(
                    copilot_pending.c.run_id == run_id, copilot_pending.c.status == "pending",
                )
            ).mappings().all()
        pending_by_id = {r["id"]: dict(r) for r in rows}
        still_open_ids = set(pending_by_id.keys())

        resolved_ids = {r.pending_id for r in resolutions}
        missing = still_open_ids - resolved_ids
        if missing:
            raise PendingResolutionError(
                f"run {run_id!r} has unresolved pending items not covered by this resolve() call: {sorted(missing)}"
            )
        unknown = resolved_ids - still_open_ids
        if unknown:
            raise PendingResolutionError(f"resolutions reference unknown/non-pending ids: {sorted(unknown)}")

        approvals: dict[str, object] = {}
        calls: dict[str, object] = {}
        now = _now()

        with self.engine.connect() as conn:
            for res in resolutions:
                row = pending_by_id[res.pending_id]
                if is_stale(row) and row["kind"] == "approval" and res.decision == "approve":
                    raise PendingResolutionError(
                        f"pending item {res.pending_id!r} is stale and can never be approved/executed; "
                        "deny it explicitly or start a new run."
                    )
                tool_call_id = row["tool_call_id"]
                if row["kind"] == "approval":
                    if not can_approve(actor):
                        raise ApprovalNotAllowedError(
                            f"user {actor!r} is not permitted to resolve approval-gated pending item "
                            f"{res.pending_id!r} (tool {row['tool_name']!r}); this role can view but not "
                            "approve/deny write-tool actions."
                        )
                    if res.decision == "approve":
                        if res.override_args:
                            allowed = ALLOWED_OVERRIDE_KEYS.get(row["tool_name"] or "", set())
                            disallowed = set(res.override_args) - allowed
                            if disallowed:
                                raise PendingResolutionError(
                                    f"override_args for pending item {res.pending_id!r} (tool "
                                    f"{row['tool_name']!r}) contains unknown/disallowed keys: "
                                    f"{sorted(disallowed)}; allowed keys are {sorted(allowed)}."
                                )
                        # See `hitl.resolve`'s identical comment: ToolApproved.override_args
                        # REPLACES the tool's args wholesale, so a partial override must be
                        # merged over the original full args here, never sent as-is.
                        merged_args = {**(pending_args(row) or {}), **res.override_args} if res.override_args else None
                        approvals[tool_call_id] = ToolApproved(override_args=merged_args) if merged_args else ToolApproved()
                    elif res.decision == "deny":
                        approvals[tool_call_id] = ToolDenied(f"User denied: {res.answer_text or 'no reason given'}")
                    else:
                        raise ValueError(f"approval pending items must be approve/deny, got {res.decision!r}")
                elif row["kind"] == "ask_user":
                    answer = res.answer_text if res.answer_text is not None else res.option_id
                    if answer is None:
                        raise ValueError("ask_user pending items require answer_text or option_id")
                    calls[tool_call_id] = answer
                else:
                    raise ValueError(f"unknown pending kind {row['kind']!r}")

                conn.execute(update(copilot_pending).where(copilot_pending.c.id == res.pending_id).values(
                    status="resolved", resolution_json=json.dumps({
                        "decision": res.decision, "answer_text": res.answer_text, "option_id": res.option_id,
                    }), resolved_by=actor, resolved_at=now,
                ))
            conn.commit()

        return DeferredToolResults(approvals=approvals, calls=calls)

    def _schedule(self, run_id: str, *, actor: str, prompt: Optional[str],
                  deferred_results: Optional[DeferredToolResults]) -> None:
        self._running.add(run_id)
        self._emit(run_id, "run_started", {"run_id": run_id})

        async def _task():
            try:
                await self._execute_turn(run_id, actor=actor, prompt=prompt, deferred_results=deferred_results)
            except Exception as exc:  # pragma: no cover -- defensive; surfaced as an error event
                self._emit(run_id, "error", {"message": str(exc)})
                with self.engine.connect() as conn:
                    conn.execute(update(copilot_runs).where(copilot_runs.c.id == run_id).values(
                        status="failed", final_answer=f"error: {exc}",
                    ))
                    conn.commit()
            finally:
                self._running.discard(run_id)

        asyncio.create_task(_task())

    async def _execute_turn(self, run_id: str, *, actor: str, prompt: Optional[str],
                             deferred_results: Optional[DeferredToolResults]) -> None:
        run = _get_run(self.engine, run_id)
        history = _load_history(run)
        effective_prompt = prompt if prompt is not None else (run["user_prompt"] if history is None else None)

        model, mode = copilot_models.resolve_model()

        if effective_prompt is not None:
            input_check = guardrails.check_input(effective_prompt)
            if input_check.injection_detected:
                _log_guardrail_event(self.engine, run_id, "injection_detected", effective_prompt[:500])
            if input_check.blocked:
                _log_guardrail_event(self.engine, run_id, "input_blocked", input_check.reason or "")
                _persist_history(self.engine, run_id, history or [], "completed", input_check.reason)
                self._emit(run_id, "final_answer", {"text": input_check.reason})
                self._emit(run_id, "run_status", {"status": "completed"})
                return

        agent = build_agent(model)
        deps = CopilotDeps(
            ops_conn_factory=self.engine.connect, model_store=self.model_store, kb_index=self.kb_index,
            actor=actor, run_id=run_id,
        )

        tracing.init_tracing()
        final_text: Optional[str] = None
        output: object = None
        with tracing.span("copilot_run_turn", span_type="AGENT", attributes={"run_id": run_id, "model": mode}) as sp:
            sp.set_inputs({"prompt": effective_prompt, "has_deferred_results": deferred_results is not None})
            async with agent.iter(
                effective_prompt, message_history=history, deferred_tool_results=deferred_results,
                deps=deps, model=model,
            ) as agent_run:
                async for node in agent_run:
                    if Agent.is_model_request_node(node):
                        async with node.stream(agent_run.ctx) as request_stream:
                            async for event in request_stream:
                                if isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                                    delta_text = event.delta.content_delta
                                    if delta_text:
                                        self._emit(run_id, "token", {"text": delta_text})
                    elif Agent.is_call_tools_node(node):
                        for part in getattr(node.model_response, "parts", []):
                            if getattr(part, "part_kind", None) == "tool-call":
                                self._emit(run_id, "tool_call", {
                                    "tool_name": part.tool_name, "tool_call_id": part.tool_call_id,
                                })
                output = agent_run.result.output
            sp.set_outputs({"output_type": type(output).__name__})
        tracing.flush()

        new_history = agent_run.result.all_messages()

        if isinstance(output, DeferredToolRequests):
            pendings = []
            guard_messages: list[str] = []
            for call in output.calls:
                metadata = (output.metadata or {}).get(call.tool_call_id, {})
                # `args_as_dict()` is the fix for the args-normalization
                # bug: `ToolCallPart.args` arrives as a JSON `str` from real
                # model backends, and used to get wrapped as `{"raw": <str>}`
                # -- which the dashboard would render as editable fields
                # (incl. internal keys) and echo back as invalid
                # `override_args`, causing the model to retry forever. See
                # `hitl.run_turn` (mirrored here for the async path).
                pendings.append(_pending_record(run_id, call.tool_call_id, "ask_user", call.tool_name,
                                                  call.args_as_dict(), metadata))
            for call in output.approvals:
                args_dict = call.args_as_dict()
                prior = _count_prior_identical_approvals(self.engine, run_id, call.tool_name, args_dict)
                if prior >= MAX_REPEATED_APPROVALS_PER_RUN:
                    _log_guardrail_event(
                        self.engine, run_id, "tool_call_loop_guard",
                        f"{call.tool_name} was called with identical args {prior} time(s) already in "
                        "this run; suppressing a further approval card to prevent an infinite loop.",
                    )
                    guard_messages.append(
                        f"The copilot tried to call {call.tool_name} with the same arguments "
                        f"{prior} times in this run without a human decision changing the outcome. "
                        "To prevent an infinite approval loop, no further card was created for this "
                        "call -- please review the run's history and start a new run if the action is "
                        "still needed."
                    )
                    continue
                pendings.append(_pending_record(run_id, call.tool_call_id, "approval", call.tool_name, args_dict, None))

            if not pendings:
                final_text = " ".join(guard_messages) or "The run could not make further progress."
                _persist_history(self.engine, run_id, new_history, "completed", final_text)
                self._emit(run_id, "final_answer", {"text": final_text})
                self._emit(run_id, "run_status", {"status": "completed"})
                return

            with self.engine.connect() as conn:
                for p in pendings:
                    conn.execute(copilot_pending.insert().values(**p))
                conn.commit()
            _persist_history(self.engine, run_id, new_history, "awaiting_input", None)
            self._emit(run_id, "awaiting_input", {"pending": [
                {"id": p["id"], "kind": p["kind"], "tool_name": p["tool_name"],
                 "args": pending_args(p), "question": pending_question(p)}
                for p in pendings
            ]})
            self._emit(run_id, "run_status", {"status": "awaiting_input"})
            return

        final_text = output
        _persist_history(self.engine, run_id, new_history, "completed", final_text)
        with self.engine.connect() as conn:
            conn.execute(update(copilot_runs).where(copilot_runs.c.id == run_id).values(model_name=mode))
            conn.commit()
        self._emit(run_id, "final_answer", {"text": final_text})
        self._emit(run_id, "run_status", {"status": "completed"})


__all__ = [
    "RunManager", "RunBusyError", "RunNotFound", "PendingResolutionError", "ApprovalNotAllowedError", "Resolution",
]
