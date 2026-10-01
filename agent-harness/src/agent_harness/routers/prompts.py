"""Prompt library routes (phase 02): a named, versioned library of system
prompts — `ops-system` (used by every run today), plus `skill-router` and
`eval-judge` (seeded now, wired into the loop in phases 04/07 — see
`agent_harness.repos.prompts` module docstring). RBAC: readable prompts are
`shared` ones plus the caller's own private ones (admin sees all); write
requires the `mutate_prompts` action *and* resource-level ownership (or
admin) — see `agent_harness.rbac`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from pydantic_ai.models import Model

from agent_harness import prompt_verification, rbac, settings
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.llm_client import build_openai_model
from agent_harness.rbac import Resource
from agent_harness.repos import prompts as prompts_repo

router = APIRouter()


def _default_review_model_factory() -> Optional[Model]:
    """Real demo path: `None` (honest "review unavailable") without an
    `OPENAI_API_KEY`, never a silent fake. Tests monkeypatch
    `routers.prompts._review_model_factory` with a deterministic double."""
    if not settings.llm_configured():
        return None
    return build_openai_model()


_review_model_factory: Callable[[], Optional[Model]] = _default_review_model_factory

PromptKind = Literal["system", "skill_router", "judge"]
Visibility = Literal["private", "shared"]


class PromptVersionSummary(BaseModel):
    id: str
    version: int
    created_at: str


class PromptVersionView(PromptVersionSummary):
    content: str
    change_note: Optional[str] = None
    created_by: str
    verification: Optional[dict[str, Any]] = Field(
        default=None,
        description="Persisted lint + optional LLM review result; a version can only be activated "
        "when its lint did not fail.",
    )
    run_count: int = Field(default=0, description="Runs that were built with exactly this version.")
    pinned_agents: int = Field(default=0, description="Agents pinned to exactly this version.")


class CreatedVersionView(PromptVersionView):
    activated: bool = Field(description="True only if activation was requested AND lint did not fail.")
    activation_blocked: Optional[str] = Field(
        default=None, description="Why activation was requested but not performed."
    )


class PromptSummary(BaseModel):
    id: str
    slug: str
    name: str
    description: Optional[str] = None
    kind: PromptKind
    owner_id: str
    visibility: Visibility
    tags: list[str]
    required_placeholders: list[str] = Field(
        default_factory=list,
        description="{{placeholders}} every version of this prompt must contain (lint rule).",
    )
    active_version: Optional[PromptVersionSummary] = None
    version_count: int
    used_by_agents: int = Field(
        default=0,
        description="Number of agents (phase 04) currently bound to this prompt. Always 0 "
        "until agents exist.",
    )
    created_at: str
    updated_at: str


class PromptDetail(PromptSummary):
    versions: list[PromptVersionView]


class CreatePromptRequest(BaseModel):
    slug: str = Field(min_length=1, pattern=r"^[a-z0-9][a-z0-9-]*$")
    name: str = Field(min_length=1)
    description: Optional[str] = None
    kind: PromptKind
    visibility: Visibility = "private"
    tags: list[str] = Field(default_factory=list)
    required_placeholders: list[str] = Field(default_factory=list)
    content: str = Field(min_length=1, description="Full text of the initial (v1, active) version.")
    llm_review: bool = Field(default=False, description="Also run the advisory LLM review.")


class UpdatePromptRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    visibility: Optional[Visibility] = None
    tags: Optional[list[str]] = None
    required_placeholders: Optional[list[str]] = None


class CreateVersionRequest(BaseModel):
    content: str = Field(min_length=1)
    change_note: Optional[str] = None
    activate: bool = False
    llm_review: bool = Field(default=False, description="Also run the advisory LLM review.")


class VerifyRequest(BaseModel):
    llm_review: bool = False


class VerifyDraftRequest(BaseModel):
    content: str
    kind: PromptKind = "system"
    required_placeholders: list[str] = Field(default_factory=list)
    llm_review: bool = False


def _resource_of(prompt: dict[str, Any]) -> Resource:
    return Resource(owner_id=prompt["owner_id"], visibility=prompt["visibility"])


def _used_by_agents_count(prompt_id: str) -> int:
    """Phase 04 fills in the count `used_by_agents` was seeded with a 0
    placeholder for (phase 02's own note: "Always 0 until agents exist")."""
    from agent_harness.repos import agents as agents_repo

    return agents_repo.count_agents_bound_to_prompt(prompt_id)


def _to_summary(prompt: dict[str, Any]) -> PromptSummary:
    return PromptSummary(
        id=prompt["id"],
        slug=prompt["slug"],
        name=prompt["name"],
        description=prompt.get("description"),
        kind=prompt["kind"],
        owner_id=prompt["owner_id"],
        visibility=prompt["visibility"],
        tags=prompt["tags"],
        required_placeholders=list(prompt.get("required_placeholders") or []),
        active_version=PromptVersionSummary(**prompt["active_version"])
        if prompt.get("active_version")
        else None,
        version_count=prompt["version_count"],
        used_by_agents=_used_by_agents_count(prompt["id"]),
        created_at=prompt["created_at"],
        updated_at=prompt["updated_at"],
    )


def _to_detail(prompt: dict[str, Any]) -> PromptDetail:
    active_version_id = prompt.get("active_version_id")
    versions = prompt["versions"]
    active_version = None
    for v in versions:
        if v["id"] == active_version_id:
            active_version = {"id": v["id"], "version": v["version"], "created_at": v["created_at"]}
            break
    version_count = len(versions)
    return PromptDetail(
        id=prompt["id"],
        slug=prompt["slug"],
        name=prompt["name"],
        description=prompt.get("description"),
        kind=prompt["kind"],
        owner_id=prompt["owner_id"],
        visibility=prompt["visibility"],
        tags=prompt["tags"],
        required_placeholders=list(prompt.get("required_placeholders") or []),
        active_version=PromptVersionSummary(**active_version) if active_version else None,
        version_count=version_count,
        used_by_agents=_used_by_agents_count(prompt["id"]),
        created_at=prompt["created_at"],
        updated_at=prompt["updated_at"],
        versions=[PromptVersionView(**v) for v in versions],
    )


def _get_readable_or_404(prompt_id: str, user: CurrentUser, *, include_deleted: bool = False) -> dict[str, Any]:
    prompt = prompts_repo.get_prompt(prompt_id, include_deleted=include_deleted)
    if prompt is None or (prompt.get("archived_at") is not None and not include_deleted):
        raise HTTPException(status_code=404, detail=f"unknown prompt '{prompt_id}'")
    if not rbac.can_read(user.id, user.role, _resource_of(prompt)):
        raise HTTPException(status_code=404, detail=f"unknown prompt '{prompt_id}'")
    return prompt


def _require_writable(prompt: dict[str, Any], user: CurrentUser) -> None:
    """Per-resource ownership check. The route-level `require("mutate_prompts")`
    dependency already gated the caller's *role* (403 for viewer fires there,
    before any resource lookup — see the sweep in `tests/test_rbac.py`); this
    only rejects an editor writing another user's private prompt."""
    if not rbac.can_write(user.id, user.role, _resource_of(prompt)):
        raise HTTPException(
            status_code=403, detail=f"role '{user.role}' may not modify prompt '{prompt['id']}'"
        )


@router.get("/prompts", response_model=list[PromptSummary])
def list_prompts(
    kind: Optional[PromptKind] = Query(default=None),
    q: Optional[str] = Query(default=None),
    user: CurrentUser = Depends(current_user),
) -> list[PromptSummary]:
    """Every prompt readable by the caller (shared prompts + the caller's
    own private ones; admin sees all), most recently updated first."""
    prompts = prompts_repo.list_prompts(kind=kind, q=q)
    readable = [p for p in prompts if rbac.can_read(user.id, user.role, _resource_of(p))]
    return [_to_summary(p) for p in readable]


@router.post("/prompts", response_model=PromptDetail, status_code=201)
def create_prompt(
    request: CreatePromptRequest, user: CurrentUser = Depends(require("mutate_prompts"))
) -> PromptDetail:
    """Create a new library entry with an initial active version (v1),
    owned by the caller."""
    existing = prompts_repo.get_prompt_by_slug(request.slug)
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"slug '{request.slug}' already exists")
    _check_placeholder_names(request.required_placeholders)
    verification = prompt_verification.verify(
        request.content,
        kind=request.kind,
        required_placeholders=request.required_placeholders,
        with_llm_review=request.llm_review,
        model_factory=_review_model_factory,
    )
    if verification.lint.status == "fail":
        # A new prompt's first version is active immediately, so a failing
        # lint rejects the whole creation (nothing is saved).
        raise HTTPException(
            status_code=422,
            detail={"message": "prompt failed verification", "verification": verification.model_dump()},
        )
    prompt = prompts_repo.create_prompt(
        slug=request.slug,
        name=request.name,
        description=request.description,
        kind=request.kind,
        owner_id=user.id,
        visibility=request.visibility,
        tags=request.tags,
        content=request.content,
        created_by=user.id,
        required_placeholders=request.required_placeholders,
        verification=verification.model_dump(),
    )
    return _to_detail(prompt)


@router.get("/prompts/{prompt_id}", response_model=PromptDetail)
def get_prompt(prompt_id: str, user: CurrentUser = Depends(current_user)) -> PromptDetail:
    prompt = _get_readable_or_404(prompt_id, user)
    return _to_detail(prompt)


@router.patch("/prompts/{prompt_id}", response_model=PromptDetail)
def update_prompt(
    prompt_id: str, request: UpdatePromptRequest, user: CurrentUser = Depends(require("mutate_prompts"))
) -> PromptDetail:
    prompt = _get_readable_or_404(prompt_id, user)
    _require_writable(prompt, user)
    if request.required_placeholders is not None:
        _check_placeholder_names(request.required_placeholders)
    updated = prompts_repo.update_prompt_metadata(
        prompt_id,
        name=request.name,
        description=request.description,
        visibility=request.visibility,
        tags=request.tags,
        required_placeholders=request.required_placeholders,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail=f"unknown prompt '{prompt_id}'")
    return _to_detail(updated)


@router.delete("/prompts/{prompt_id}", status_code=204)
def delete_prompt(prompt_id: str, user: CurrentUser = Depends(require("mutate_prompts"))) -> None:
    """Soft-delete (archive). 409 if `prompt_id` is one of the 3 library
    prompts the harness itself reads at runtime (`ops-system`,
    `skill-router`, `eval-judge`) — those can be edited (new versions) but
    never removed."""
    prompt = _get_readable_or_404(prompt_id, user)
    _require_writable(prompt, user)
    if prompt["slug"] in prompts_repo.SEEDED_SLUGS:
        raise HTTPException(
            status_code=409,
            detail=f"'{prompt['slug']}' is a built-in library prompt used by the harness at "
            "runtime and cannot be deleted.",
        )
    prompts_repo.archive_prompt(prompt_id)


@router.post("/prompts/{prompt_id}/restore", response_model=PromptDetail)
def restore_prompt(prompt_id: str, user: CurrentUser = Depends(require("mutate_prompts"))) -> PromptDetail:
    """Undo a delete. 404 if the id is unknown or not deleted."""
    prompt = _get_readable_or_404(prompt_id, user, include_deleted=True)
    _require_writable(prompt, user)
    if prompt.get("deleted_at") is None or not prompts_repo.restore_prompt(prompt_id):
        raise HTTPException(status_code=404, detail=f"prompt '{prompt_id}' is not deleted")
    restored = prompts_repo.get_prompt(prompt_id)
    assert restored is not None
    return _to_detail(restored)


@router.post("/prompts/verify", response_model=prompt_verification.Verification)
def verify_draft(
    request: VerifyDraftRequest, user: CurrentUser = Depends(require("mutate_prompts"))
) -> prompt_verification.Verification:
    """Verify an UNSAVED draft (lint always; the advisory LLM review on
    request). Nothing is persisted - this backs the editor's live "Verify"
    button and the Playground's draft mode."""
    _check_placeholder_names(request.required_placeholders)
    return prompt_verification.verify(
        request.content,
        kind=request.kind,
        required_placeholders=request.required_placeholders,
        with_llm_review=request.llm_review,
        model_factory=_review_model_factory,
    )


def _check_placeholder_names(names: list[str]) -> None:
    bad = [n for n in names if n not in prompt_verification.SUPPORTED_PLACEHOLDERS]
    if bad:
        raise HTTPException(
            status_code=422,
            detail=f"unsupported required placeholder(s) {bad}; supported: "
            f"{sorted(prompt_verification.SUPPORTED_PLACEHOLDERS)}",
        )


@router.post("/prompts/{prompt_id}/versions", response_model=CreatedVersionView, status_code=201)
def create_prompt_version(
    prompt_id: str, request: CreateVersionRequest, user: CurrentUser = Depends(require("mutate_prompts"))
) -> CreatedVersionView:
    """Create the next version. Verification (lint, plus the optional LLM
    review) always runs and is persisted on the version. The version is
    always saved, but it is only activated if `activate` was requested AND
    lint did not fail - otherwise `activated=false` with the reason."""
    prompt = _get_readable_or_404(prompt_id, user)
    _require_writable(prompt, user)
    verification = prompt_verification.verify(
        request.content,
        kind=prompt["kind"],
        required_placeholders=list(prompt.get("required_placeholders") or []),
        with_llm_review=request.llm_review,
        model_factory=_review_model_factory,
    )
    can_activate = verification.lint.status != "fail"
    row = prompts_repo.create_version(
        prompt_id,
        content=request.content,
        change_note=request.change_note,
        created_by=user.id,
        activate=request.activate and can_activate,
        verification=verification.model_dump(),
    )
    if row is None:
        raise HTTPException(status_code=404, detail=f"unknown prompt '{prompt_id}'")
    blocked = None
    if request.activate and not can_activate:
        blocked = "lint failed - fix the errors, then activate from the version list"
    return CreatedVersionView(**row, activated=request.activate and can_activate, activation_blocked=blocked)


@router.post(
    "/prompts/{prompt_id}/versions/{version_id}/verify", response_model=PromptVersionView
)
def verify_prompt_version(
    prompt_id: str,
    version_id: str,
    request: VerifyRequest,
    user: CurrentUser = Depends(require("mutate_prompts")),
) -> PromptVersionView:
    """Re-run verification on a saved version and persist the new result
    (e.g. add the LLM review to a version that only has lint, or re-lint
    after changing the prompt's required placeholders)."""
    prompt = _get_readable_or_404(prompt_id, user)
    _require_writable(prompt, user)
    version = prompts_repo.get_version(prompt_id, version_id)
    if version is None:
        raise HTTPException(status_code=404, detail=f"unknown version '{version_id}' for prompt '{prompt_id}'")
    verification = prompt_verification.verify(
        version["content"],
        kind=prompt["kind"],
        required_placeholders=list(prompt.get("required_placeholders") or []),
        with_llm_review=request.llm_review,
        model_factory=_review_model_factory,
    )
    updated = prompts_repo.set_verification(prompt_id, version_id, verification.model_dump())
    return PromptVersionView(**updated)  # type: ignore[arg-type]


@router.post("/prompts/{prompt_id}/versions/{version_id}/activate", response_model=PromptDetail)
def activate_prompt_version(
    prompt_id: str, version_id: str, user: CurrentUser = Depends(require("mutate_prompts"))
) -> PromptDetail:
    """Activate (or roll back to) a version. Gated on verification: the
    version's lint is re-run now against the prompt's current required
    placeholders and persisted; a failing lint is a 409 and nothing moves."""
    prompt = _get_readable_or_404(prompt_id, user)
    _require_writable(prompt, user)
    version = prompts_repo.get_version(prompt_id, version_id)
    if version is None:
        raise HTTPException(
            status_code=404, detail=f"unknown version '{version_id}' for prompt '{prompt_id}'"
        )
    lint = prompt_verification.lint_prompt(
        version["content"], required_placeholders=list(prompt.get("required_placeholders") or [])
    )
    existing = dict(version.get("verification") or {})
    existing["lint"] = lint.model_dump()
    existing["verified_at"] = lint.checked_at
    prompts_repo.set_verification(prompt_id, version_id, existing)
    if lint.status == "fail":
        raise HTTPException(
            status_code=409,
            detail={
                "message": "this version failed verification and cannot be activated",
                "verification": existing,
            },
        )
    updated = prompts_repo.activate_version(prompt_id, version_id)
    if updated is None:
        raise HTTPException(
            status_code=404, detail=f"unknown version '{version_id}' for prompt '{prompt_id}'"
        )
    return _to_detail(updated)
