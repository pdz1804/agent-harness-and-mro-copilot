"""Chat sessions: create, list (search + filters), inspect, rename, archive, delete.

Sessions are private to their owner (admin sees all). Renaming, archiving and
deleting follow `rbac.can_manage`: the owner (any role, a viewer included — it
is their own chat) or an admin; anyone who cannot read the session gets a 404.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from agent_harness import db, rbac, state
from agent_harness.api_models import (
    CreateSessionRequest,
    RunSummary,
    SessionDetail,
    SessionView,
    UpdateSessionRequest,
)
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.rbac import Resource
from agent_harness.repos import agents as agents_repo
from agent_harness.repos import sessions as sessions_repo
from agent_harness.run_registry import persisted_summary

router = APIRouter()


def new_session_title(objective: str) -> str:
    title = objective.strip().splitlines()[0]
    return title[:60] + ("…" if len(title) > 60 else "")


def resolve_session_agent_id(requested_agent_id: Optional[str]) -> Optional[str]:
    """Default to the harness's default agent when omitted; 404 if an
    explicitly requested agent_id doesn't exist (never silently ignored)."""
    if requested_agent_id is not None:
        if agents_repo.get_agent(requested_agent_id) is None:
            raise HTTPException(status_code=404, detail=f"unknown agent_id '{requested_agent_id}'")
        return requested_agent_id
    default_agent = agents_repo.get_default_agent()
    return default_agent["id"] if default_agent is not None else None


def session_live_status(session_id: str, last_run_status: Optional[str]) -> str:
    """The in-memory RunRegistry is authoritative over Postgres for whichever
    run is still live in this process (its terminal row isn't written until
    it finishes) — see `RunRegistry.latest_live_run_for_session`."""
    live_record = state.registry.latest_live_run_for_session(session_id)
    if live_record is not None:
        return state.registry.summary(live_record)["status"]
    return last_run_status or "idle"


def _session_view(row: dict) -> SessionView:
    return SessionView(
        id=row["id"],
        title=row["title"],
        created_at=row["created_at"],
        last_active_at=row["last_active_at"],
        status=session_live_status(row["id"], row["last_run_status"]),  # type: ignore[arg-type]
        last_run_id=row["last_run_id"],
        owner_id=row.get("owner_id", "u_admin"),
        agent_id=row.get("agent_id"),
        archived_at=row.get("archived_at"),
    )


def _get_manageable_or_404(session_id: str, user: CurrentUser) -> dict:
    """The session row for a rename/archive/delete: 404 when the caller cannot
    see it (do not confirm the id exists), 403 when they can see but not manage it."""
    row = db.get_session_with_latest_run(session_id)
    resource = Resource(owner_id=row.get("owner_id")) if row else None
    if row is None or resource is None or not rbac.can_read(user.id, user.role, resource):
        raise HTTPException(status_code=404, detail=f"unknown session_id '{session_id}'")
    if not rbac.can_manage(user.id, user.role, resource):
        raise HTTPException(status_code=403, detail="only the session's owner or an admin may change it")
    return row


@router.post("/sessions", response_model=SessionView, status_code=201)
def create_session(request: CreateSessionRequest, user: CurrentUser = Depends(require("chat"))) -> SessionView:
    """Explicit session creation, used by '+ New chat'. `POST /runs` also
    auto-creates one when `session_id` is omitted, so this endpoint mainly
    exists for a UI that wants to create an empty session before typing the
    first objective. Owned by the caller (phase 01 RBAC)."""
    session_id = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()
    title = request.title.strip() if request.title and request.title.strip() else "New chat"
    agent_id = resolve_session_agent_id(request.agent_id)
    row = db.create_session(session_id, title, now, owner_id=user.id, agent_id=agent_id)
    return SessionView(**row, last_run_id=None)


@router.get("/sessions", response_model=list[SessionView])
def list_sessions(
    q: Optional[str] = Query(default=None, max_length=200, description="Matches the title or any run's objective."),
    status: Optional[str] = Query(default=None, description="Live status, e.g. running, completed, idle."),
    agent_id: Optional[str] = None,
    since: Optional[str] = Query(default=None, description="ISO date/time: last active on or after."),
    until: Optional[str] = Query(default=None, description="ISO date/time: last active on or before."),
    archived: Literal["exclude", "include", "only"] = "exclude",
    user: CurrentUser = Depends(current_user),
) -> list[SessionView]:
    """Every Sessions-sidebar entry visible to the caller (own sessions, or
    every session for admin — sessions have no 'shared' concept, only
    owner/admin visibility) with its *live* status: this is the endpoint the
    sidebar polls so every session (not just whichever one is open) reflects
    whether it's actually still running/pending_approval, surviving a page
    reload or a second tab. Archived sessions are hidden unless
    `archived=include|only`."""
    rows = db.list_sessions(q=q, agent_id=agent_id, since=since, until=until, archived=archived)
    visible = [row for row in rows if rbac.can_read(user.id, user.role, Resource(owner_id=row.get("owner_id")))]
    views = [_session_view(row) for row in visible]
    if status:
        views = [v for v in views if v.status == status]
    return views


@router.get("/sessions/{session_id}", response_model=SessionDetail)
def get_session(session_id: str, user: CurrentUser = Depends(current_user)) -> SessionDetail:
    """Session metadata + every run it has started, most recent first — the
    real read/inspect data the Memory view surfaces (no new storage; this
    just shapes the existing `runs`/`chat_sessions` rows). Unreadable
    (another user's private session, non-admin caller) -> 404, not 403 —
    don't confirm the id exists."""
    row = db.get_session_with_latest_run(session_id)
    if row is None or not rbac.can_read(user.id, user.role, Resource(owner_id=row.get("owner_id"))):
        raise HTTPException(status_code=404, detail=f"unknown session_id '{session_id}'")

    live_records = [r for r in state.registry.list_runs() if r.session_id == session_id]
    live_ids = {r.run_id for r in live_records}
    live_runs = [RunSummary(**state.registry.summary(r)) for r in live_records]
    persisted_runs = [
        RunSummary(**persisted_summary(r)) for r in db.list_runs_for_session(session_id) if r["run_id"] not in live_ids
    ]
    runs = sorted(live_runs + persisted_runs, key=lambda r: r.started_at, reverse=True)
    return SessionDetail(**_session_view(row).model_dump(), runs=runs)


@router.patch("/sessions/{session_id}", response_model=SessionView)
def update_session(
    session_id: str, request: UpdateSessionRequest, user: CurrentUser = Depends(current_user)
) -> SessionView:
    """Rename and/or archive/restore a session (owner or admin)."""
    _get_manageable_or_404(session_id, user)
    if request.title is None and request.archived is None:
        raise HTTPException(status_code=422, detail="send a title and/or archived")
    if request.title is not None:
        title = request.title.strip()
        if not title:
            raise HTTPException(status_code=422, detail="title must not be blank")
        sessions_repo.rename_session(session_id, title)
    if request.archived is not None:
        sessions_repo.set_session_archived(
            session_id, datetime.now(timezone.utc).isoformat() if request.archived else None
        )
    updated = db.get_session_with_latest_run(session_id)
    assert updated is not None
    return _session_view(updated)


@router.delete("/sessions/{session_id}", status_code=204)
def delete_session(session_id: str, user: CurrentUser = Depends(current_user)) -> None:
    """Permanently delete a session with its runs, traces and feedback (owner or
    admin). Refused with 409 while one of its runs is still in flight."""
    _get_manageable_or_404(session_id, user)
    if not state.registry.forget_session(session_id):
        raise HTTPException(status_code=409, detail="a run in this session is still in progress: stop it first")
    sessions_repo.delete_session(session_id)
