"""Skills routes (phase 03): a reusable capability package — instructions +
`allowed_tools` (a subset of the harness's tool registry) + a description
used as the routing signal for phase 04's skill auto-discover/slash
commands. RBAC follows the same ownership+visibility pattern as
`routers.prompts`: readable skills are `shared` ones plus the caller's own
private ones (admin sees all); write requires `mutate_skills` *and*
resource-level ownership (or admin).
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from agent_harness import rbac
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.rbac import Resource
from agent_harness.repos import skills as skills_repo
from agent_harness.repos.skills import SkillValidationError
from agent_harness.tools.registry import build_default_registry

router = APIRouter()

Visibility = Literal["private", "shared"]


class SkillView(BaseModel):
    id: str
    slug: str
    name: str
    description: str
    instructions: str
    allowed_tools: list[str]
    examples: list[str]
    owner_id: str
    visibility: Visibility
    enabled: bool
    created_at: str
    updated_at: str
    updated_by: str


class CreateSkillRequest(BaseModel):
    slug: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    instructions: str = ""
    allowed_tools: list[str] = Field(default_factory=list)
    examples: list[str] = Field(default_factory=list)
    visibility: Visibility = "private"
    enabled: bool = True


class UpdateSkillRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = Field(default=None, min_length=1)
    instructions: Optional[str] = None
    allowed_tools: Optional[list[str]] = None
    examples: Optional[list[str]] = None
    visibility: Optional[Visibility] = None
    enabled: Optional[bool] = None


class ToolCatalogEntry(BaseModel):
    name: str
    description: str
    requires_approval: bool
    enabled: bool


def _resource_of(skill: dict[str, Any]) -> Resource:
    return Resource(owner_id=skill["owner_id"], visibility=skill["visibility"])


def _get_readable_or_404(skill_id: str, user: CurrentUser) -> dict[str, Any]:
    skill = skills_repo.get_skill(skill_id)
    if skill is None:
        raise HTTPException(status_code=404, detail=f"unknown skill '{skill_id}'")
    if not rbac.can_read(user.id, user.role, _resource_of(skill)):
        raise HTTPException(status_code=404, detail=f"unknown skill '{skill_id}'")
    return skill


def _require_writable(skill: dict[str, Any], user: CurrentUser) -> None:
    """Per-resource ownership check. The route-level `require("mutate_skills")`
    dependency already gated the caller's *role* (403 for viewer fires there,
    before any resource lookup — keeps the mutating-route 403 sweep in
    `tests/test_rbac.py` uniform); this only rejects an editor writing
    another user's private skill."""
    if not rbac.can_write(user.id, user.role, _resource_of(skill)):
        raise HTTPException(
            status_code=403, detail=f"role '{user.role}' may not modify skill '{skill['id']}'"
        )


@router.get("/skills", response_model=list[SkillView])
def list_skills(
    q: Optional[str] = Query(default=None),
    enabled: Optional[bool] = Query(default=None),
    user: CurrentUser = Depends(current_user),
) -> list[SkillView]:
    """Every skill readable by the caller (shared + the caller's own private
    ones; admin sees all), most recently updated first."""
    skills = skills_repo.list_skills(q=q, enabled=enabled)
    readable = [s for s in skills if rbac.can_read(user.id, user.role, _resource_of(s))]
    return [SkillView(**s) for s in readable]


@router.get("/tools", response_model=list[ToolCatalogEntry])
def list_tool_catalog(user: CurrentUser = Depends(current_user)) -> list[ToolCatalogEntry]:
    """The harness's tool registry, each annotated with its current
    enabled/disabled state (reusing the same `integrations` table the
    Integrations tab reads) — backs the Skills page's tool picker so an
    author only sees tools that actually exist."""
    from agent_harness import db

    registry = build_default_registry()
    enabled_by_name = {row["tool_name"]: row["enabled"] for row in db.list_integrations()}
    return [
        ToolCatalogEntry(
            name=tool.name,
            description=tool.description,
            requires_approval=tool.requires_approval,
            enabled=enabled_by_name.get(tool.name, True),
        )
        for tool in registry.values()
    ]


@router.post("/skills", response_model=SkillView, status_code=201)
def create_skill(
    request: CreateSkillRequest, user: CurrentUser = Depends(require("mutate_skills"))
) -> SkillView:
    existing = skills_repo.get_skill_by_slug(request.slug)
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"slug '{request.slug}' already exists")
    try:
        skill = skills_repo.create_skill(
            slug=request.slug,
            name=request.name,
            description=request.description,
            instructions=request.instructions,
            allowed_tools=request.allowed_tools,
            examples=request.examples,
            owner_id=user.id,
            visibility=request.visibility,
            enabled=request.enabled,
            updated_by=user.id,
        )
    except SkillValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return SkillView(**skill)


@router.get("/skills/{skill_id}", response_model=SkillView)
def get_skill(skill_id: str, user: CurrentUser = Depends(current_user)) -> SkillView:
    skill = _get_readable_or_404(skill_id, user)
    return SkillView(**skill)


@router.patch("/skills/{skill_id}", response_model=SkillView)
def update_skill(
    skill_id: str, request: UpdateSkillRequest, user: CurrentUser = Depends(require("mutate_skills"))
) -> SkillView:
    skill = _get_readable_or_404(skill_id, user)
    _require_writable(skill, user)
    try:
        updated = skills_repo.update_skill(
            skill_id,
            name=request.name,
            description=request.description,
            instructions=request.instructions,
            allowed_tools=request.allowed_tools,
            examples=request.examples,
            visibility=request.visibility,
            enabled=request.enabled,
            updated_by=user.id,
        )
    except SkillValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail=f"unknown skill '{skill_id}'")
    return SkillView(**updated)


@router.delete("/skills/{skill_id}", status_code=204)
def delete_skill(skill_id: str, user: CurrentUser = Depends(require("mutate_skills"))) -> None:
    """409 if any agent is currently bound to this skill (phase 04 fills in
    `skills_repo.is_bound_to_agent`; always False until then)."""
    skill = _get_readable_or_404(skill_id, user)
    _require_writable(skill, user)
    if skills_repo.is_bound_to_agent(skill_id):
        raise HTTPException(
            status_code=409, detail=f"skill '{skill_id}' is bound to an agent and cannot be deleted"
        )
    skills_repo.delete_skill(skill_id)
