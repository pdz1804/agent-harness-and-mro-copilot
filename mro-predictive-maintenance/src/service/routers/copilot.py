"""``/copilot`` FastAPI router: runs, SSE streaming, resume, automations.

Follows the same module-state + dependency-override pattern as
``src/service/routers/ops.py`` (``init_engine``/``get_engine``) so tests can
point this router at a tmp-file engine without ever touching the real
``data/ops.db``.
"""

from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Engine, select

from src.copilot import automations as copilot_automations_mod
from src.copilot import hitl
from src.copilot import models as copilot_models
from src.copilot.agent import PROMPT_VERSION
from src.copilot.identity import can_write, seeded_users
from src.copilot.runs import ApprovalNotAllowedError, RunBusyError, RunManager, Resolution
from src.ops.db import copilot_pending, copilot_runs

router = APIRouter(prefix="/copilot", tags=["copilot"])

HEARTBEAT_SECONDS = 15

_module_state: dict[str, object] = {"manager": None}


def init_manager(manager: RunManager) -> None:
    _module_state["manager"] = manager


def get_manager() -> RunManager:
    manager = _module_state.get("manager")
    if manager is None:
        raise HTTPException(status_code=503, detail="copilot run manager not initialized")
    return manager


def get_engine(manager: RunManager = Depends(get_manager)) -> Engine:
    return manager.engine


class StartRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str
    alert_id: Optional[int] = None


class FollowUpRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str


class ResolutionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pending_id: str
    decision: str  # "approve" | "deny" | "answer"
    override_args: Optional[dict] = None
    answer_text: Optional[str] = None
    option_id: Optional[str] = None


class ResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resolutions: list[ResolutionItem]


class AutomationCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    trigger: str = "alert_opened"
    condition: dict = {}
    prompt_template: str
    enabled: bool = True


class AutomationPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


class FleetScanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    window_days: int = 30


def _require_writer(x_user: str) -> None:
    if not can_write(x_user):
        raise HTTPException(status_code=403, detail=f"'{x_user}' is a read-only viewer and cannot change operational data")


def _run_or_404(engine: Engine, run_id: str) -> dict:
    with engine.connect() as conn:
        row = conn.execute(select(copilot_runs).where(copilot_runs.c.id == run_id)).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail=f"run {run_id} not found")
    return dict(row)


def _summarize_history(run: dict) -> list[dict]:
    """Lightweight role/content view of the persisted ``ModelMessage``
    history for the run-snapshot API -- never re-derives run status or
    guardrail behavior, purely a display projection."""
    history = hitl._load_history(run)  # noqa: SLF001 -- same-package reuse, not a public re-export
    if not history:
        return []
    out: list[dict] = []
    for message in history:
        for part in getattr(message, "parts", []):
            kind = getattr(part, "part_kind", None)
            if kind == "user-prompt" and isinstance(part.content, str):
                out.append({"role": "user", "content": part.content})
            elif kind == "text":
                out.append({"role": "assistant", "content": part.content})
            elif kind == "tool-call":
                out.append({"role": "tool_call", "tool_name": part.tool_name, "args": part.args,
                            "tool_call_id": part.tool_call_id})
            elif kind == "tool-return":
                out.append({"role": "tool_result", "tool_name": part.tool_name, "content": part.content,
                            "tool_call_id": part.tool_call_id})
    return out


@router.post("/runs", status_code=202)
async def start_run(body: StartRunRequest, manager: RunManager = Depends(get_manager),
                      x_user: str = Header(default="engineer.demo")):
    # Native coroutine (not a sync `def`) so this runs directly on the
    # app's asyncio event loop rather than FastAPI's worker threadpool --
    # RunManager schedules the turn via `asyncio.create_task`, which
    # requires a running loop in the calling thread.
    run_id = manager.start_run(body.prompt, trigger="user", alert_id=body.alert_id, actor=x_user)
    return {"run_id": run_id}


@router.get("/runs")
def list_runs(status: Optional[str] = None, engine: Engine = Depends(get_engine)):
    stmt = select(copilot_runs)
    if status is not None:
        stmt = stmt.where(copilot_runs.c.status == status)
    with engine.connect() as conn:
        rows = conn.execute(stmt.order_by(copilot_runs.c.created_at.desc())).mappings().all()
    return [dict(r) for r in rows]


def _question_view(question: Optional[dict]) -> Optional[dict]:
    """Normalize `ask_user`'s free-form `options` (a `list[str]` as passed by
    the tool) into the typed `{id, label}` shape the dashboard's OptionCard
    renders -- accepts either shape so already-typed options pass through."""
    if not question:
        return question
    options = question.get("options")
    if isinstance(options, list):
        question = {
            **question,
            "options": [
                opt if isinstance(opt, dict) else {"id": opt, "label": opt}
                for opt in options
            ],
        }
    return question


def _pending_view(p: dict) -> dict:
    # Keep every original column (``run_id``, ``tool_call_id``, ``status``,
    # ``resolved_by``, ...) and only replace ``args``/``question`` with the
    # unwrapped, parsed view -- `hitl.pending_args`/`pending_question` are
    # the ONLY accessors for a pending item's args/question; they return
    # the real tool args, never the internal `_opened_at` bookkeeping key
    # (the fix for the bug where that key used to leak into `args` and get
    # rendered/echoed back by the UI as an invalid override).
    view = {k: v for k, v in p.items() if k not in ("args_json", "question_json")}
    view["args"] = hitl.pending_args(p)
    view["question"] = _question_view(hitl.pending_question(p))
    view["is_stale"] = p["is_stale"]
    return view


def _legacy_view(p: dict) -> dict:
    """Read-only projection of a `cleanup_legacy_pending`-cancelled row --
    rendered by the dashboard as "stale -- cancelled", never as an editable
    approval/option card (see `hitl.LEGACY_STALE_STATUS`'s docstring)."""
    resolution = json.loads(p["resolution_json"]) if p["resolution_json"] else {}
    return {
        "id": p["id"], "run_id": p["run_id"], "tool_call_id": p["tool_call_id"],
        "kind": p["kind"], "tool_name": p["tool_name"],
        "args": hitl.pending_args(p), "question": _question_view(hitl.pending_question(p)),
        "status": p["status"], "is_stale": True,
        "resolved_by": p["resolved_by"], "resolved_at": p["resolved_at"],
        "resolution_reason": resolution.get("answer_text"),
    }


@router.get("/runs/{run_id}")
def get_run(run_id: str, engine: Engine = Depends(get_engine)):
    run = _run_or_404(engine, run_id)
    pending = hitl.list_pending(engine, run_id)
    legacy = hitl.list_legacy_cancelled(engine, run_id)
    return {
        "run_id": run["id"],
        "status": run["status"],
        "trigger": run["trigger"],
        "alert_id": run["alert_id"],
        "model_name": run["model_name"],
        "created_at": run["created_at"],
        "final_answer": run["final_answer"],
        "messages": _summarize_history(run),
        "pending": [_pending_view(p) for p in pending] + [_legacy_view(p) for p in legacy],
        "resolved": _resolved_views(engine, run_id),
    }


def _resolved_views(engine: Engine, run_id: str) -> list[dict]:
    """Resolved pending items (decision, actor, time, note) so the UI can keep
    "Approved by X" attribution for every gated tool after a reload."""
    with engine.connect() as conn:
        rows = conn.execute(
            select(copilot_pending).where(
                copilot_pending.c.run_id == run_id, copilot_pending.c.status == "resolved",
            )
        ).mappings().all()
    out = []
    for r in rows:
        res = json.loads(r["resolution_json"]) if r["resolution_json"] else {}
        out.append({
            "id": r["id"], "tool_call_id": r["tool_call_id"], "kind": r["kind"],
            "tool_name": r["tool_name"], "decision": res.get("decision"),
            "note": res.get("answer_text"), "option_id": res.get("option_id"),
            "resolved_by": r["resolved_by"], "resolved_at": r["resolved_at"],
        })
    return out


@router.get("/runs/{run_id}/events")
async def run_events(run_id: str, request: Request, manager: RunManager = Depends(get_manager),
                       last_event_id: Optional[int] = None):
    _run_or_404(manager.engine, run_id)
    header_last_id = request.headers.get("last-event-id")
    if header_last_id is not None:
        try:
            last_event_id = int(header_last_id)
        except ValueError:
            last_event_id = None

    async def _generate():
        # Subscribing BEFORE the replay DB query closes the race where a
        # turn finishes between "query missed events" and "start listening
        # live" -- any event committed after subscribe() is guaranteed to
        # land in the queue even if it also shows up in the replay query
        # (deduped by id below).
        queue = manager.subscribe(run_id)
        try:
            replay = manager.events_since(run_id, last_event_id or 0)
            replayed_ids = {evt["id"] for evt in replay}
            for evt in replay:
                yield _sse_format(evt)

            if not manager.is_running(run_id):
                # Nothing is in flight: drain whatever raced into the queue
                # (deduped against what replay already sent) and stop --
                # the stream is bounded to "catch up to the current state",
                # never an indefinite heartbeat-only wait on a run that
                # isn't doing anything (see module docstring in
                # src/copilot/runs.py for why the offline/HTTP-test path
                # needs a stream that terminates deterministically).
                while not queue.empty():
                    evt = queue.get_nowait()
                    if evt["id"] is not None and evt["id"] in replayed_ids:
                        continue
                    yield _sse_format(evt)
                return

            while True:
                if await request.is_disconnected():
                    break
                try:
                    evt = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                if evt["id"] is not None and evt["id"] in replayed_ids:
                    continue
                yield _sse_format(evt)
                if evt["type"] in ("run_status", "error"):
                    return
        finally:
            manager.unsubscribe(run_id, queue)

    return StreamingResponse(
        _generate(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


def _sse_format(evt: dict) -> str:
    lines = []
    if evt.get("id") is not None:
        lines.append(f"id: {evt['id']}")
    lines.append(f"event: {evt['type']}")
    lines.append(f"data: {json.dumps(evt['payload'])}")
    return "\n".join(lines) + "\n\n"


@router.post("/runs/{run_id}/messages", status_code=202)
async def follow_up(run_id: str, body: FollowUpRequest, manager: RunManager = Depends(get_manager),
                      x_user: str = Header(default="engineer.demo")):
    run = _run_or_404(manager.engine, run_id)
    if run["status"] != "completed":
        raise HTTPException(
            status_code=409,
            detail=f"run is {run['status']!r}; follow-up messages are only accepted on a completed run "
                   "(an awaiting_input run must be resolved via POST /resolve first).",
        )
    if manager.is_running(run_id):
        raise HTTPException(status_code=409, detail="run already has a turn in flight")
    manager._schedule(run_id, actor=x_user, prompt=body.prompt, deferred_results=None)  # noqa: SLF001
    return {"run_id": run_id}


@router.post("/runs/{run_id}/resolve", status_code=202)
async def resolve_run(run_id: str, body: ResolveRequest, manager: RunManager = Depends(get_manager),
                        x_user: str = Header(default="engineer.demo")):
    run = _run_or_404(manager.engine, run_id)
    if run["status"] != "awaiting_input":
        raise HTTPException(status_code=409, detail=f"run is {run['status']!r}, not awaiting_input")
    resolutions = [Resolution(**item.model_dump()) for item in body.resolutions]
    try:
        manager.resolve(run_id, resolutions, actor=x_user)
    except RunBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except hitl.PendingResolutionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ApprovalNotAllowedError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return {"run_id": run_id}


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str, engine: Engine = Depends(get_engine), x_user: str = Header(default="engineer.demo")):
    run = _run_or_404(engine, run_id)
    if run["status"] != "awaiting_input":
        raise HTTPException(status_code=409, detail=f"run is {run['status']!r}, not awaiting_input")
    from sqlalchemy import update

    now_ts = hitl._now()  # noqa: SLF001
    with engine.connect() as conn:
        pending_rows = conn.execute(
            select(copilot_pending).where(
                copilot_pending.c.run_id == run_id, copilot_pending.c.status == "pending",
            )
        ).mappings().all()
        for p in pending_rows:
            conn.execute(update(copilot_pending).where(copilot_pending.c.id == p["id"]).values(
                status="resolved",
                resolution_json=json.dumps({"decision": "cancelled", "answer_text": None, "option_id": None}),
                resolved_by=x_user, resolved_at=now_ts,
            ))
        conn.execute(update(copilot_runs).where(copilot_runs.c.id == run_id).values(
            status="completed", final_answer="Run cancelled by user before resolution.",
        ))
        conn.commit()
    return {"run_id": run_id, "status": "completed"}


@router.get("/pending")
def global_pending(engine: Engine = Depends(get_engine)):
    with engine.connect() as conn:
        rows = conn.execute(
            select(copilot_pending).where(copilot_pending.c.status == "pending")
        ).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["is_stale"] = hitl.is_stale(d)
        out.append(_pending_view(d))
    return out


@router.get("/meta")
def meta(engine: Engine = Depends(get_engine)):
    model, mode = copilot_models.resolve_model()
    return {
        "mode": mode,
        "prompt_version": PROMPT_VERSION,
        "tools": [
            "fleet_risk", "score_component", "explain_component", "aircraft_overview",
            "reliability_kpis", "search_manuals", "list_alerts", "ask_user",
            "create_work_order", "recommend_aircraft_status", "acknowledge_alert",
        ],
        "approval_gated_tools": ["create_work_order", "recommend_aircraft_status", "acknowledge_alert"],
        "deferred_tools": ["ask_user"],
        "seeded_users": [{"id": u.id, "label": u.label, "role": u.role} for u in seeded_users()],
    }


@router.get("/automations")
def get_automations(engine: Engine = Depends(get_engine)):
    return copilot_automations_mod.list_automations(engine)


@router.post("/automations")
def post_automation(body: AutomationCreateRequest, engine: Engine = Depends(get_engine)):
    return copilot_automations_mod.create_automation(
        engine, name=body.name, trigger=body.trigger, condition=body.condition,
        prompt_template=body.prompt_template, enabled=body.enabled,
    )


@router.patch("/automations/{automation_id}")
def patch_automation(automation_id: int, body: AutomationPatchRequest, engine: Engine = Depends(get_engine),
                     x_user: str = Header(default="engineer.demo")):
    _require_writer(x_user)
    try:
        return copilot_automations_mod.set_enabled(engine, automation_id, body.enabled)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/fleet-scan")
async def fleet_scan(body: FleetScanRequest = FleetScanRequest(), manager: RunManager = Depends(get_manager),
                     x_user: str = Header(default="engineer.demo")):
    """Real fleet-scan (``src.ops.service.fleet_scan``, unmodified) plus
    automation dispatch -- see ``src/copilot/automations.py`` module
    docstring for why this lives here rather than inside the phase-03-owned
    ``/ops/fleet-scan`` endpoint."""
    _require_writer(x_user)
    from src.service.model_store import store

    if not store.loaded:
        raise HTTPException(status_code=503, detail="model not loaded; cannot fleet-scan")
    return copilot_automations_mod.run_fleet_scan_with_automations(
        manager.engine, store, manager, window_days=body.window_days,
    )
