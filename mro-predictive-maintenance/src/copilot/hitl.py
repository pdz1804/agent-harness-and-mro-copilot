"""HITL (human-in-the-loop) run/resume core.

Design decision D2 (research report): restart-safe deferred tools +
persisted ``message_history`` instead of a thread blocked on an event. A
run's entire state is: the ``copilot_runs`` row (status + serialized
``ModelMessage`` history) plus its ``copilot_pending`` rows. Nothing lives
only in process memory, so killing the process between "paused" and
"resolved" and starting a fresh engine + fresh ``Agent`` instance still
resumes correctly (``tests/test_copilot_hitl.py``'s restart-safety test
proves this).

``run_turn`` is deliberately synchronous (``agent.run_sync``) -- phase 06
owns the async/streaming (SSE) surface (``agent.iter`` + ``node.stream()``)
and will call into a thin async sibling; this module only needs to prove
the pause/resume state machine works, which does not require streaming.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from pydantic_ai.messages import ModelMessagesTypeAdapter
from pydantic_ai.tools import DeferredToolRequests, DeferredToolResults, ToolApproved, ToolDenied
from sqlalchemy import select, update
from sqlalchemy.engine import Engine

from src.copilot import guardrails, models as copilot_models, tracing
from src.copilot.agent import build_agent
from src.copilot.identity import can_approve
from src.copilot.tables import copilot_guardrail_events
from src.copilot.tools import CopilotDeps
from src.ops.db import copilot_pending, copilot_runs

STALE_PENDING_HOURS = 24

# A run must never generate an unbounded number of approval cards for the
# exact same tool+args (e.g. a UI bug that sends back invalid override_args,
# causing the model to retry and re-defer the identical call forever -- the
# real bug this guard defends against, found live). 3 was chosen because it
# comfortably covers legitimate re-asks (e.g. the model tries again after a
# deny with a clarifying note) while still bounding worst-case UI/DB noise
# to a small constant -- a wall-clock/time-based heuristic was rejected
# because it can't distinguish "looping" from "human is slow to respond".
MAX_REPEATED_APPROVALS_PER_RUN = 3

# Known write-tool parameter names -- the only keys a resolve() call's
# ``override_args`` may ever contain. Anything else (unknown keys, or the
# reserved ``_opened_at``/``raw`` bookkeeping keys a buggy client might echo
# back) is rejected with a 422 rather than silently passed to the tool.
ALLOWED_OVERRIDE_KEYS: dict[str, set[str]] = {
    "create_work_order": {"aircraft_id", "component_id", "task_ref", "priority", "justification"},
    "recommend_aircraft_status": {"aircraft_id", "status", "mel_item", "reason"},
    "acknowledge_alert": {"alert_id", "note"},
}


class RunNotFound(Exception):
    pass


class PendingResolutionError(Exception):
    """Raised when a resolve() call doesn't cover every still-pending item
    for a run -- Pydantic AI requires all deferred/approval requests from a
    single turn to be resolved together."""


class ApprovalNotAllowedError(Exception):
    """Raised when ``actor`` is not permitted to resolve an ``approval``-kind
    pending item (see ``src.copilot.identity.can_approve``) -- mapped to a
    403 at the API layer, never silently downgraded to a no-op."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class TurnResult:
    run_id: str
    status: str  # "completed" | "awaiting_input"
    final_answer: Optional[str] = None
    pending: list[dict] = field(default_factory=list)


def create_run(engine: Engine, *, prompt: Optional[str] = None, trigger: str = "user",
                alert_id: Optional[int] = None, model_name: Optional[str] = None) -> str:
    run_id = f"run-{uuid.uuid4().hex[:16]}"
    with engine.connect() as conn:
        conn.execute(copilot_runs.insert().values(
            id=run_id, created_at=_now(), status="running", trigger=trigger,
            alert_id=alert_id, user_prompt=prompt, message_history_json=None,
            final_answer=None, mlflow_trace_id=None, model_name=model_name,
        ))
        conn.commit()
    return run_id


def _get_run(engine: Engine, run_id: str) -> dict:
    with engine.connect() as conn:
        row = conn.execute(select(copilot_runs).where(copilot_runs.c.id == run_id)).mappings().first()
    if row is None:
        raise RunNotFound(f"copilot run {run_id!r} not found")
    return dict(row)


def _load_history(run: dict):
    if not run.get("message_history_json"):
        return None
    return ModelMessagesTypeAdapter.validate_json(run["message_history_json"])


def _persist_history(engine: Engine, run_id: str, history, status: str, final_answer: Optional[str]) -> None:
    history_json = ModelMessagesTypeAdapter.dump_json(history).decode("utf-8")
    with engine.connect() as conn:
        conn.execute(update(copilot_runs).where(copilot_runs.c.id == run_id).values(
            message_history_json=history_json, status=status, final_answer=final_answer,
        ))
        conn.commit()


def _log_guardrail_event(engine: Engine, run_id: str, kind: str, detail: str) -> None:
    with engine.connect() as conn:
        conn.execute(copilot_guardrail_events.insert().values(
            run_id=run_id, at=_now(), kind=kind, detail=detail,
        ))
        conn.commit()


def _pending_record(run_id: str, tool_call_id: str, kind: str, tool_name: Optional[str],
                     args: Optional[dict], question: Optional[dict]) -> dict:
    # `copilot_pending` (declared in src/ops/db.py, phase 03) has no
    # created-at column of its own -- rather than touching that
    # phase-03-owned file, the "opened_at" timestamp needed for the 24h
    # staleness check is nested inside args_json/question_json as a
    # reserved `_opened_at` sibling key, one level up from the real tool
    # args/question -- `args_json` is ALWAYS ``{"args": <real tool args
    # dict>, "_opened_at": ...}``, never the raw tool args merged with
    # `_opened_at` (the bug this replaces: a client that renders every key
    # of `args` as an editable field would otherwise see -- and echo back
    # as `override_args` -- this internal bookkeeping key). Callers must
    # pass ``args``/``question`` already parsed to real dicts (e.g. via
    # ``ToolCallPart.args_as_dict()``), never a raw JSON string.
    opened_at = _now()
    args_payload = json.dumps({"args": args or {}, "_opened_at": opened_at})
    question_payload = json.dumps({"question": question or {}, "_opened_at": opened_at}) if kind == "ask_user" else None
    return {
        "id": f"pend-{uuid.uuid4().hex[:16]}",
        "run_id": run_id,
        "tool_call_id": tool_call_id,
        "kind": kind,
        "tool_name": tool_name,
        "args_json": args_payload,
        "question_json": question_payload,
        "status": "pending",
        "resolution_json": None,
        "resolved_by": None,
        "resolved_at": None,
    }


def pending_args(row: dict) -> Optional[dict]:
    """The real, parsed tool args for a pending row (never the ``_opened_at``
    bookkeeping key) -- the fix for the args-normalization bug: this is the
    ONLY accessor the API/dashboard should use to read a pending item's
    args, so `_opened_at` can never leak into an editable UI field again."""
    if not row.get("args_json"):
        return None
    parsed = json.loads(row["args_json"])
    return parsed.get("args", {})


def pending_question(row: dict) -> Optional[dict]:
    if not row.get("question_json"):
        return None
    parsed = json.loads(row["question_json"])
    return parsed.get("question", {})


def _fingerprint_args(args: Optional[dict]) -> str:
    return json.dumps(args or {}, sort_keys=True, default=str)


def _count_prior_identical_approvals(engine: Engine, run_id: str, tool_name: str, args: dict) -> int:
    """How many prior `approval` pending rows in this run already had the
    identical tool_name+args -- used by the loop guard below."""
    target = _fingerprint_args(args)
    with engine.connect() as conn:
        rows = conn.execute(
            select(copilot_pending.c.tool_name, copilot_pending.c.args_json).where(
                copilot_pending.c.run_id == run_id, copilot_pending.c.kind == "approval",
            )
        ).all()
    count = 0
    for tool, args_json in rows:
        if tool != tool_name or not args_json:
            continue
        try:
            parsed_args = json.loads(args_json).get("args", {})
        except (TypeError, ValueError):
            continue
        if _fingerprint_args(parsed_args) == target:
            count += 1
    return count


def _opened_at(row: dict) -> Optional[str]:
    for col in ("question_json", "args_json"):
        raw = row.get(col)
        if raw:
            try:
                return json.loads(raw).get("_opened_at")
            except (TypeError, ValueError):
                continue
    return None


def is_stale(row: dict) -> bool:
    opened = _opened_at(row)
    if not opened:
        return False
    try:
        opened_dt = datetime.fromisoformat(opened)
    except ValueError:
        return False
    age_hours = (datetime.now(timezone.utc) - opened_dt).total_seconds() / 3600
    return age_hours > STALE_PENDING_HOURS


# Status used by `cleanup_legacy_pending` for pre-fix pending rows whose
# `args_json` predates the `{"args": ..., "_opened_at": ...}` wrapper (the
# bug this task's item #4 cleans up: those rows' args were the raw
# `{"raw": <json string>}` shape or otherwise not a dict with an "args"
# key). Deliberately distinct from both "pending" (never auto-approved,
# per the phase spec) and "resolved" (would otherwise look like a human
# actually decided something) so the UI can render it as its own state.
LEGACY_STALE_STATUS = "stale_legacy_cancelled"
LEGACY_CLEANUP_ACTOR = "system:cleanup"


def _is_legacy_raw_args(args_json: Optional[str]) -> bool:
    """True if a pending row's raw ``args_json`` predates the normalization
    fix -- i.e. it is not the ``{"args": <dict>, "_opened_at": ...}``
    wrapper (missing the ``args`` key entirely, or -- the actual historical
    bug -- wrapped as ``{"raw": <json string>}``)."""
    if not args_json:
        return False
    try:
        parsed = json.loads(args_json)
    except (TypeError, ValueError):
        return True  # unparseable is itself a legacy/corrupt shape
    if not isinstance(parsed, dict):
        return True
    return "args" not in parsed


def cleanup_legacy_pending(engine: Engine) -> int:
    """One-shot, idempotent cleanup for pre-fix pending cards (task item #4):
    finds every still-``pending`` row whose ``args_json`` is the legacy raw
    shape and marks it ``LEGACY_STALE_STATUS`` with an explanatory
    ``resolution_json`` reason -- never executed, never auto-approved, and
    the row itself (an audit record) is never deleted. Idempotent: once a
    row is marked, it no longer has ``status == "pending"`` so a second call
    finds nothing left to do and returns 0. Safe to call on every process
    startup (see ``src/service/app.py``'s lifespan)."""
    with engine.connect() as conn:
        rows = conn.execute(
            select(copilot_pending).where(copilot_pending.c.status == "pending")
        ).mappings().all()
    legacy_ids = [r["id"] for r in rows if _is_legacy_raw_args(r["args_json"])]
    if not legacy_ids:
        return 0
    now = _now()
    with engine.connect() as conn:
        for pending_id in legacy_ids:
            conn.execute(update(copilot_pending).where(copilot_pending.c.id == pending_id).values(
                status=LEGACY_STALE_STATUS,
                resolution_json=json.dumps({
                    "decision": "stale_cancelled",
                    "answer_text": (
                        "Auto-cancelled by a one-shot startup cleanup: this pending card predates the "
                        "args-normalization fix and stored unparseable raw args, so it can never be "
                        "safely approved or answered."
                    ),
                    "option_id": None,
                }),
                resolved_by=LEGACY_CLEANUP_ACTOR, resolved_at=now,
            ))
        conn.commit()
    return len(legacy_ids)


def list_legacy_cancelled(engine: Engine, run_id: str) -> list[dict]:
    """Legacy pending rows cleaned up by ``cleanup_legacy_pending`` for one
    run -- surfaced read-only in the run snapshot so a human can still see
    "stale -- cancelled" in the UI instead of the card silently vanishing."""
    with engine.connect() as conn:
        rows = conn.execute(
            select(copilot_pending).where(
                copilot_pending.c.run_id == run_id, copilot_pending.c.status == LEGACY_STALE_STATUS,
            )
        ).mappings().all()
    return [dict(r) for r in rows]


def list_pending(engine: Engine, run_id: str) -> list[dict]:
    """All still-``pending`` items for a run, each annotated with
    ``is_stale`` -- stale items are shown to the human but never
    auto-resolved/auto-executed (phase spec: "pending never auto-approves;
    stale >24h shown as stale, never executed")."""
    with engine.connect() as conn:
        rows = conn.execute(
            select(copilot_pending).where(
                copilot_pending.c.run_id == run_id, copilot_pending.c.status == "pending",
            )
        ).mappings().all()
    out = []
    for row in rows:
        d = dict(row)
        d["is_stale"] = is_stale(d)
        out.append(d)
    return out


def run_turn(
    engine: Engine, kb_index, model_store, run_id: str, *,
    prompt: Optional[str] = None, deferred_results: Optional[DeferredToolResults] = None,
    actor: str = "engineer.demo", model=None,
) -> TurnResult:
    """Run (or resume) one turn of ``run_id``.

    - First call for a run: pass ``prompt`` (or the run's stored
      ``user_prompt`` if omitted), ``deferred_results=None``.
    - Resume call: pass ``deferred_results`` built from the human's
      resolutions (see ``resolve``); ``prompt`` is typically ``None``.
    """
    run = _get_run(engine, run_id)
    history = _load_history(run)
    effective_prompt = prompt if prompt is not None else (run["user_prompt"] if history is None else None)

    if model is None:
        model, mode = copilot_models.resolve_model()
    else:
        mode = getattr(model, "model_name", None) or "custom"

    if effective_prompt is not None:
        input_check = guardrails.check_input(effective_prompt)
        if input_check.injection_detected:
            _log_guardrail_event(engine, run_id, "injection_detected", effective_prompt[:500])
        if input_check.blocked:
            _log_guardrail_event(engine, run_id, "input_blocked", input_check.reason or "")
            _persist_history(engine, run_id, history or [], "completed", input_check.reason)
            return TurnResult(run_id=run_id, status="completed", final_answer=input_check.reason)

    agent = build_agent(model)
    deps = CopilotDeps(
        ops_conn_factory=engine.connect, model_store=model_store, kb_index=kb_index,
        actor=actor, run_id=run_id, alert_id=run.get("alert_id"),
    )

    tracing.init_tracing()
    with tracing.span("copilot_run_turn", span_type="AGENT", attributes={"run_id": run_id, "model": mode}) as sp:
        sp.set_inputs({"prompt": effective_prompt, "has_deferred_results": deferred_results is not None})
        result = agent.run_sync(
            effective_prompt, message_history=history, deferred_tool_results=deferred_results,
            deps=deps, model=model,
        )
        sp.set_outputs({"output_type": type(result.output).__name__})
    tracing.flush()

    new_history = result.all_messages()

    if isinstance(result.output, DeferredToolRequests):
        pendings = []
        guard_messages: list[str] = []
        for call in result.output.calls:
            metadata = (result.output.metadata or {}).get(call.tool_call_id, {})
            # `ToolCallPart.args` arrives as a JSON `str` from real model
            # backends (OpenAI) -- `args_as_dict()` is the fix for the bug
            # where the raw string used to get wrapped as `{"raw": <str>}`
            # and rendered/echoed back by the UI as invalid override_args.
            pendings.append(_pending_record(run_id, call.tool_call_id, "ask_user", call.tool_name,
                                              call.args_as_dict(), metadata))
        for call in result.output.approvals:
            args_dict = call.args_as_dict()
            prior = _count_prior_identical_approvals(engine, run_id, call.tool_name, args_dict)
            if prior >= MAX_REPEATED_APPROVALS_PER_RUN:
                _log_guardrail_event(
                    engine, run_id, "tool_call_loop_guard",
                    f"{call.tool_name} was called with identical args {prior} time(s) already in this "
                    "run; suppressing a further approval card to prevent an infinite loop.",
                )
                guard_messages.append(
                    f"The copilot tried to call {call.tool_name} with the same arguments "
                    f"{prior} times in this run without a human decision changing the outcome. To "
                    "prevent an infinite approval loop, no further card was created for this call -- "
                    "please review the run's history and start a new run if the action is still needed."
                )
                continue
            pendings.append(_pending_record(run_id, call.tool_call_id, "approval", call.tool_name, args_dict, None))

        if not pendings:
            # Every deferred/approval call this turn hit the loop guard --
            # there is nothing left to show a human, so the run must
            # terminate here rather than sit in `awaiting_input` forever
            # with zero pending items.
            final_answer = " ".join(guard_messages) or "The run could not make further progress."
            _persist_history(engine, run_id, new_history, "completed", final_answer)
            return TurnResult(run_id=run_id, status="completed", final_answer=final_answer)

        with engine.connect() as conn:
            for p in pendings:
                conn.execute(copilot_pending.insert().values(**p))
            conn.commit()
        _persist_history(engine, run_id, new_history, "awaiting_input", None)
        return TurnResult(run_id=run_id, status="awaiting_input", pending=pendings)

    final_answer = result.output
    _persist_history(engine, run_id, new_history, "completed", final_answer)
    with engine.connect() as conn:
        conn.execute(update(copilot_runs).where(copilot_runs.c.id == run_id).values(model_name=mode))
        conn.commit()
    return TurnResult(run_id=run_id, status="completed", final_answer=final_answer)


@dataclass
class Resolution:
    pending_id: str
    decision: str  # "approve" | "deny" | "answer"
    override_args: Optional[dict] = None
    answer_text: Optional[str] = None
    option_id: Optional[str] = None


def resolve(engine: Engine, kb_index, model_store, run_id: str, resolutions: list[Resolution],
            actor: str, model=None) -> TurnResult:
    """Resolve every still-``pending`` item for ``run_id`` in one call
    (Pydantic AI requires all deferred/approval requests from a turn to be
    resolved together) and resume the run. Stale (>24h) pending items are
    marked ``stale`` and never executed, matching the phase spec."""
    with engine.connect() as conn:
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

    with engine.connect() as conn:
        for res in resolutions:
            row = pending_by_id[res.pending_id]
            if is_stale(row) and row["kind"] == "approval" and res.decision == "approve":
                raise PendingResolutionError(
                    f"pending item {res.pending_id!r} is stale (>{STALE_PENDING_HOURS}h) and can never be "
                    "approved/executed; deny it explicitly or start a new run."
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
                    # `ToolApproved.override_args` REPLACES the tool's args
                    # wholesale (Pydantic AI does not merge it) -- so a
                    # partial `{"priority": "aog"}` from the client must be
                    # merged over the ORIGINAL full args here, never sent
                    # as-is, or the re-invocation is missing every unedited
                    # required param. Found while writing this fix's own
                    # tests: it silently re-triggered the exact approval
                    # loop this task exists to close.
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

    deferred_results = DeferredToolResults(approvals=approvals, calls=calls)
    return run_turn(engine, kb_index, model_store, run_id, prompt=None,
                     deferred_results=deferred_results, actor=actor, model=model)
