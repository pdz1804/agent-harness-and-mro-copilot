"""Shared FastAPI dependencies for identity/RBAC (phase 01), extracted out of
`api.py` so new routers (`agent_harness.routers.*`, starting with prompts in
phase 02) can depend on `current_user`/`require()` without importing `api`
itself (which would create an import cycle: `api.py` -> `routers.prompts` ->
`api.py`).

See `agent_harness.rbac`'s module docstring for the honest "identity
switcher, not authentication" framing — this module is the one place a real
IdP integration would replace."""

from __future__ import annotations

from collections.abc import Callable
from typing import Optional

from fastapi import Depends, Header, HTTPException
from pydantic import BaseModel

from agent_harness import rbac
from agent_harness.rbac import Action, Role
from agent_harness.repos import users as users_repo


class CurrentUser(BaseModel):
    """The resolved identity for this request."""

    id: str
    display_name: str
    role: Role


def current_user(
    x_user_id: Optional[str] = Header(default=None, alias="X-User-Id"),
    as_user: Optional[str] = None,
) -> CurrentUser:
    """Resolve the calling identity from the `X-User-Id` header (used by the
    fetch-based `web/src/lib/api.ts`) or the `as_user` query param (used by
    `EventSource`/SSE, which cannot set custom headers). Missing or unknown
    -> 401, never a silent fallback to some default user."""
    user_id = x_user_id or as_user
    if not user_id:
        raise HTTPException(
            status_code=401,
            detail="missing identity: send an 'X-User-Id' header (or '?as_user=' for the SSE "
            "endpoint) naming a known user id — see GET /users.",
        )
    row = users_repo.get_user(user_id)
    if row is None:
        raise HTTPException(status_code=401, detail=f"unknown user id '{user_id}'")
    return CurrentUser(id=row["id"], display_name=row["display_name"], role=row["role"])


def require(action: Action) -> Callable[..., CurrentUser]:
    """Dependency factory: resolve the caller, then 403 unless their role
    permits `action` (see `agent_harness.rbac.PERMISSIONS`). Use directly on
    a route (`user: CurrentUser = Depends(require("mutate_prompts"))`) for
    actions that are not scoped to a specific owned resource."""

    def _dependency(user: CurrentUser = Depends(current_user)) -> CurrentUser:
        if not rbac.can(user.role, action):
            raise HTTPException(
                status_code=403,
                detail=f"role '{user.role}' is not permitted to perform '{action}'",
            )
        return user

    return _dependency
