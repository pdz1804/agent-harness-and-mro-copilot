"""Long-term memory routes: list, add, edit and delete the facts an agent keeps
about a user across conversations.

Memories are private to their owner. A normal caller only ever sees and
changes their own; an admin may list everyone's (`scope=all`) for oversight and
may edit or delete any. The agent tools (`remember` / `recall`) are bound to the
run owner, so an agent never reads another user's memories whatever the role.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from agent_harness import rbac
from agent_harness.deps import CurrentUser, current_user
from agent_harness.rbac import Resource
from agent_harness.repos import memories as memories_repo
from agent_harness.repos import users as users_repo

router = APIRouter()


class MemoryView(BaseModel):
    id: str
    owner_id: str
    owner_name: str = ""
    fact: str
    tags: list[str]
    source_run_id: Optional[str] = Field(default=None, description="The run that stored it; null for one typed by hand.")
    created_at: str
    updated_at: str
    last_used_at: Optional[str] = None
    use_count: int = 0


class _FactMixin(BaseModel):
    @field_validator("fact", check_fields=False)
    @classmethod
    def _clean_fact(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        value = value.strip()
        if len(value) < 3:
            raise ValueError("fact must have at least 3 characters")
        return value


class CreateMemoryRequest(_FactMixin):
    fact: str = Field(max_length=memories_repo.MAX_FACT_CHARS)
    tags: list[str] = Field(default_factory=list, max_length=memories_repo.MAX_TAGS)


class UpdateMemoryRequest(_FactMixin):
    fact: Optional[str] = Field(default=None, max_length=memories_repo.MAX_FACT_CHARS)
    tags: Optional[list[str]] = Field(default=None, max_length=memories_repo.MAX_TAGS)


def _view(row: dict[str, Any], names: dict[str, str]) -> MemoryView:
    return MemoryView(
        owner_name=names.get(row["owner_id"], row["owner_id"]),
        **{k: row[k] for k in MemoryView.model_fields if k in row and k != "owner_name"},
    )


def _names() -> dict[str, str]:
    return {u["id"]: u["display_name"] for u in users_repo.list_users()}


def _get_manageable_or_404(memory_id: str, user: CurrentUser) -> dict[str, Any]:
    row = memories_repo.get_memory(memory_id)
    if row is None or not rbac.can_manage(user.id, user.role, Resource(owner_id=row["owner_id"])):
        raise HTTPException(status_code=404, detail=f"unknown memory '{memory_id}'")
    return row


@router.get("/memories", response_model=list[MemoryView])
def list_memories(
    q: Optional[str] = Query(default=None, max_length=200),
    scope: Literal["mine", "all"] = "mine",
    user: CurrentUser = Depends(current_user),
) -> list[MemoryView]:
    """The caller's own memories, newest first (optionally filtered by `q` on the
    fact or a tag). `scope=all` lists every user's, admin only."""
    if scope == "all" and user.role != "admin":
        raise HTTPException(status_code=403, detail="only an admin may list every user's memories")
    rows = memories_repo.list_memories(owner_id=None if scope == "all" else user.id, q=q)
    names = _names()
    return [_view(r, names) for r in rows]


@router.post("/memories", response_model=MemoryView, status_code=201)
def create_memory(request: CreateMemoryRequest, user: CurrentUser = Depends(current_user)) -> MemoryView:
    """Add a fact by hand, as the caller. Saving a fact the caller already has
    returns it with the tags merged (200-style idempotence, still 201)."""
    try:
        row, _created = memories_repo.create_memory(user.id, request.fact, request.tags)
    except memories_repo.MemoryLimitError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _view(row, _names())


@router.patch("/memories/{memory_id}", response_model=MemoryView)
def update_memory(
    memory_id: str, request: UpdateMemoryRequest, user: CurrentUser = Depends(current_user)
) -> MemoryView:
    _get_manageable_or_404(memory_id, user)
    if request.fact is None and request.tags is None:
        raise HTTPException(status_code=422, detail="send a fact and/or tags")
    row = memories_repo.update_memory(memory_id, fact=request.fact, tags=request.tags)
    if row is None:
        raise HTTPException(status_code=404, detail=f"unknown memory '{memory_id}'")
    return _view(row, _names())


@router.delete("/memories/{memory_id}", status_code=204)
def delete_memory(memory_id: str, user: CurrentUser = Depends(current_user)) -> None:
    _get_manageable_or_404(memory_id, user)
    memories_repo.delete_memory(memory_id)
