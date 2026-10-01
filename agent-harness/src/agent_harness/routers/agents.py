"""Agents routes (phase 04): a named, ownable entity binding a prompt (+
optional pinned version), a skill-routing mode, and a base tool set. RBAC
follows the same ownership+visibility pattern as `routers.prompts`/
`routers.skills`: readable agents are `shared` ones plus the caller's own
private ones (admin sees all); write requires `mutate_agents` *and*
resource-level ownership (or admin)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from pydantic_ai.models import Model

from agent_harness import agent_runtime, db, rbac
from agent_harness.agent_runtime import resolve_run_plan
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.llm_client import build_openai_model
from agent_harness.rbac import Resource
from agent_harness.repos import agents as agents_repo
from agent_harness.repos import evals as evals_repo
from agent_harness.repos import prompts as prompts_repo
from agent_harness.repos import runs as runs_repo
from agent_harness.repos import skills as skills_repo
from agent_harness.repos.agents import AgentValidationError
from agent_harness.settings import llm_configured
from agent_harness.tools.registry import build_default_registry

router = APIRouter()

# Overridable at test time (mirrors `api.py`'s `_llm_client_factory` pattern)
# so `POST /agents/{id}/preview-route` can be exercised with a deterministic
# `llm_client.build_router_model(...)` double instead of a real OpenAI call.
_router_model_factory: Callable[[], Model] = build_openai_model

Visibility = Literal["private", "shared"]
SkillMode = Literal["none", "assigned", "auto"]


class AgentView(BaseModel):
    id: str
    slug: str
    name: str
    description: str
    avatar_color: str
    prompt_id: str
    prompt_version_id: Optional[str] = None
    skill_mode: SkillMode
    skill_ids: list[str]
    base_tools: list[str]
    max_steps: Optional[int] = None
    owner_id: str
    visibility: Visibility
    is_default: bool
    created_at: str
    updated_at: str


class CreateAgentRequest(BaseModel):
    slug: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""
    avatar_color: str = "#6366f1"
    prompt_id: str
    prompt_version_id: Optional[str] = None
    skill_mode: SkillMode = "none"
    skill_ids: list[str] = Field(default_factory=list)
    base_tools: list[str] = Field(default_factory=list)
    max_steps: Optional[int] = Field(default=None, gt=0)
    visibility: Visibility = "private"


class UpdateAgentRequest(BaseModel):
    """Only fields explicitly present in the request body are changed
    (checked via `model_fields_set`, not "is it None") — this lets
    `prompt_version_id`/`max_steps` be explicitly cleared to null (unpin the
    version / drop the step override) by sending `null`, while omitting the
    field entirely leaves it unchanged. Same convention as
    `agents_repo.update_agent`'s `"__unset__"` sentinel."""

    name: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    avatar_color: Optional[str] = None
    prompt_id: Optional[str] = None
    prompt_version_id: Optional[str] = None
    skill_mode: Optional[SkillMode] = None
    skill_ids: Optional[list[str]] = None
    base_tools: Optional[list[str]] = None
    max_steps: Optional[int] = Field(default=None, gt=0)
    visibility: Optional[Visibility] = None


class PreviewRouteRequest(BaseModel):
    objective: str = Field(min_length=1)


class PreviewRouteResponse(BaseModel):
    selected: list[str]
    rationale: str
    confidence: float
    candidates: list[str]


def _resource_of(agent: dict[str, Any]) -> Resource:
    return Resource(owner_id=agent["owner_id"], visibility=agent["visibility"])


def _get_readable_or_404(agent_id: str, user: CurrentUser) -> dict[str, Any]:
    agent = agents_repo.get_agent(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"unknown agent '{agent_id}'")
    if not rbac.can_read(user.id, user.role, _resource_of(agent)):
        raise HTTPException(status_code=404, detail=f"unknown agent '{agent_id}'")
    return agent


def _require_writable(agent: dict[str, Any], user: CurrentUser) -> None:
    if not rbac.can_write(user.id, user.role, _resource_of(agent)):
        raise HTTPException(
            status_code=403, detail=f"role '{user.role}' may not modify agent '{agent['id']}'"
        )


def _validate_prompt_binding(prompt_id: str, prompt_version_id: Optional[str]) -> None:
    prompt = prompts_repo.get_prompt(prompt_id)
    if prompt is None or prompt.get("archived_at") is not None:
        raise HTTPException(status_code=422, detail=f"unknown prompt '{prompt_id}'")
    if prompt_version_id is not None:
        version_ids = {v["id"] for v in prompt.get("versions", [])}
        if prompt_version_id not in version_ids:
            raise HTTPException(
                status_code=422,
                detail=f"version '{prompt_version_id}' does not belong to prompt '{prompt_id}'",
            )


@router.get("/agents", response_model=list[AgentView])
def list_agents(user: CurrentUser = Depends(current_user)) -> list[AgentView]:
    """Every agent readable by the caller (shared + the caller's own private
    ones; admin sees all), default agent first."""
    agents = agents_repo.list_agents()
    readable = [a for a in agents if rbac.can_read(user.id, user.role, _resource_of(a))]
    return [AgentView(**a) for a in readable]


@router.get("/skills/commands")
def list_skill_commands(user: CurrentUser = Depends(current_user)) -> list[dict[str, Any]]:
    """Every readable+enabled skill's slash-command shape (`slug`/`name`/
    `description`/`examples`) — backs the chat composer's `/` autocomplete
    (phase 05) and lets a caller discover valid slash commands up front."""
    skills = skills_repo.list_skills(enabled=True)

    def _resource(s: dict[str, Any]) -> Resource:
        return Resource(owner_id=s["owner_id"], visibility=s["visibility"])

    readable = [s for s in skills if rbac.can_read(user.id, user.role, _resource(s))]
    return [
        {
            "slug": s["slug"],
            "name": s["name"],
            "description": s["description"],
            "examples": s["examples"],
        }
        for s in readable
    ]


@router.post("/agents", response_model=AgentView, status_code=201)
def create_agent(
    request: CreateAgentRequest, user: CurrentUser = Depends(require("mutate_agents"))
) -> AgentView:
    existing = agents_repo.get_agent_by_slug(request.slug)
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"slug '{request.slug}' already exists")
    _validate_prompt_binding(request.prompt_id, request.prompt_version_id)
    try:
        agent = agents_repo.create_agent(
            slug=request.slug,
            name=request.name,
            description=request.description,
            avatar_color=request.avatar_color,
            prompt_id=request.prompt_id,
            prompt_version_id=request.prompt_version_id,
            skill_mode=request.skill_mode,
            skill_ids=request.skill_ids,
            base_tools=request.base_tools,
            max_steps=request.max_steps,
            owner_id=user.id,
            visibility=request.visibility,
        )
    except AgentValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return AgentView(**agent)


class StarterPrompt(BaseModel):
    text: str
    skill_slug: str


@router.get("/agents/{agent_id}/starters", response_model=list[StarterPrompt])
def agent_starter_prompts(agent_id: str, user: CurrentUser = Depends(current_user)) -> list[StarterPrompt]:
    """Starter prompts for the chat empty state: the `examples` of the skills
    this agent can actually use for the caller - the assigned skills
    (`assigned`), or every readable enabled skill within the agent's
    candidate list (`auto`) - restricted to skills with at least one tool the
    caller's role may use and that is enabled in Integrations (a viewer is
    not offered 'build me a dashboard'). Interleaved across skills for
    variety, at most 6."""
    agent = _get_readable_or_404(agent_id, user)
    if agent["skill_mode"] == "none":
        return []
    usable_tools = db.list_enabled_tool_names() & set(build_default_registry(user.id, user.role))
    if agent["skill_mode"] == "assigned":
        skills = [s for s in (skills_repo.get_skill(i) for i in agent.get("skill_ids") or []) if s]
    else:
        skills = skills_repo.list_skills(enabled=True)
        allow = set(agent.get("skill_ids") or [])
        if allow:
            skills = [s for s in skills if s["id"] in allow]
    skills = [
        s
        for s in skills
        if s.get("enabled", True)
        and rbac.can_read(user.id, user.role, Resource(owner_id=s.get("owner_id"), visibility=s.get("visibility", "shared")))
        and (set(s.get("allowed_tools") or []) & usable_tools)
    ]
    queues = [[StarterPrompt(text=e, skill_slug=s["slug"]) for e in (s.get("examples") or [])] for s in skills]
    out: list[StarterPrompt] = []
    depth = 0
    while len(out) < 6 and any(depth < len(q) for q in queues):
        for q in queues:
            if depth < len(q) and len(out) < 6:
                out.append(q[depth])
        depth += 1
    return out


@router.get("/agents/{agent_id}", response_model=AgentView)
def get_agent(agent_id: str, user: CurrentUser = Depends(current_user)) -> AgentView:
    agent = _get_readable_or_404(agent_id, user)
    return AgentView(**agent)


@router.patch("/agents/{agent_id}", response_model=AgentView)
def update_agent(
    agent_id: str, request: UpdateAgentRequest, user: CurrentUser = Depends(require("mutate_agents"))
) -> AgentView:
    agent = _get_readable_or_404(agent_id, user)
    _require_writable(agent, user)
    fields_set = request.model_fields_set
    new_prompt_version_id = request.prompt_version_id if "prompt_version_id" in fields_set else "__unset__"
    new_max_steps = request.max_steps if "max_steps" in fields_set else "__unset__"
    if request.prompt_id is not None or new_prompt_version_id != "__unset__":
        _validate_prompt_binding(
            request.prompt_id or agent["prompt_id"],
            new_prompt_version_id if new_prompt_version_id != "__unset__" else agent.get("prompt_version_id"),
        )
    try:
        updated = agents_repo.update_agent(
            agent_id,
            name=request.name,
            description=request.description,
            avatar_color=request.avatar_color,
            prompt_id=request.prompt_id,
            prompt_version_id=new_prompt_version_id,
            skill_mode=request.skill_mode,
            skill_ids=request.skill_ids,
            base_tools=request.base_tools,
            max_steps=new_max_steps,
            visibility=request.visibility,
        )
    except AgentValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail=f"unknown agent '{agent_id}'")
    return AgentView(**updated)


@router.delete("/agents/{agent_id}", status_code=204)
def delete_agent(agent_id: str, user: CurrentUser = Depends(require("mutate_agents"))) -> None:
    agent = _get_readable_or_404(agent_id, user)
    _require_writable(agent, user)
    if agent["is_default"]:
        raise HTTPException(status_code=409, detail="the default agent cannot be deleted")
    agents_repo.delete_agent(agent_id)


@router.post("/agents/{agent_id}/preview-route", response_model=PreviewRouteResponse)
def preview_route(
    agent_id: str, request: PreviewRouteRequest, user: CurrentUser = Depends(current_user)
) -> PreviewRouteResponse:
    """Dry-run the `auto`-mode router for this agent against `objective`,
    with no run/session created — lets an author test their skill
    candidate list before saving. Viewer allowed (read-only, no
    persistence); 404 if the agent isn't readable; 422 if the agent isn't in
    `auto` mode."""
    agent = _get_readable_or_404(agent_id, user)
    if agent["skill_mode"] != "auto":
        raise HTTPException(status_code=422, detail="preview-route only applies to skill_mode='auto' agents")
    if _router_model_factory is build_openai_model and not llm_configured():
        raise HTTPException(status_code=422, detail="OPENAI_API_KEY is not configured")

    enabled_names = db.list_enabled_tool_names()
    plan = resolve_run_plan(
        agent=agent,
        objective=request.objective,
        user_id=user.id,
        user_role=user.role,
        enabled_tool_names=enabled_names,
        router_model=_router_model_factory(),
    )
    routed = next((e for e in plan.events if e.event_type == "skill_routed"), None)
    if routed is None:
        return PreviewRouteResponse(selected=[], rationale="", confidence=0.0, candidates=[])
    data = routed.data
    return PreviewRouteResponse(
        selected=data.get("selected", []),
        rationale=data.get("rationale", ""),
        confidence=data.get("confidence", 0.0),
        candidates=data.get("candidates", []),
    )


class AgentStats(BaseModel):
    runs: int
    by_status: dict[str, int]
    avg_steps: Optional[float] = None
    scored_runs: int = Field(description="Runs of this agent the LLM judge has scored (task_success).")
    success_rate: Optional[float] = Field(default=None, description="Share of scored runs the judge passed; null until one is scored.")


@router.get("/agents/{agent_id}/stats", response_model=AgentStats)
def agent_stats(agent_id: str, user: CurrentUser = Depends(current_user)) -> AgentStats:
    """Usage of one agent: how many runs, how they ended, and the judge's
    success rate over the scored ones. Counts the caller's own runs (every run
    for an admin)."""
    _get_readable_or_404(agent_id, user)
    scope = None if user.role == "admin" else user.id
    usage = runs_repo.agent_run_stats(agent_id, owner_id=scope)
    success = evals_repo.agent_success_rate(agent_id, owner_id=scope)
    return AgentStats(**usage, scored_runs=success["scored"], success_rate=success["success_rate"])


@router.post("/agents/{agent_id}/clone", response_model=AgentView, status_code=201)
def clone_agent(agent_id: str, user: CurrentUser = Depends(require("mutate_agents"))) -> AgentView:
    """Copy an agent the caller can read into a new private agent they own:
    same prompt binding, skill mode, skills, tools and step limit, with a free
    `<slug>-copy[-N]` slug and a "(copy)" name. Never the default agent."""
    source = _get_readable_or_404(agent_id, user)
    base_slug = f"{source['slug']}-copy"
    slug, n = base_slug, 1
    while agents_repo.get_agent_by_slug(slug) is not None:
        n += 1
        slug = f"{base_slug}-{n}"
    try:
        agent = agents_repo.create_agent(
            slug=slug,
            name=f"{source['name']} (copy)",
            description=source["description"],
            avatar_color=source["avatar_color"],
            prompt_id=source["prompt_id"],
            prompt_version_id=source.get("prompt_version_id"),
            skill_mode=source["skill_mode"],
            skill_ids=list(source.get("skill_ids") or []),
            base_tools=list(source.get("base_tools") or []),
            max_steps=source.get("max_steps"),
            owner_id=user.id,
            visibility="private",
        )
    except AgentValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return AgentView(**agent)


class RouteTestRequest(BaseModel):
    objective: str = Field(min_length=1, max_length=2000)
    agent_id: Optional[str] = Field(
        default=None, description="Restrict the candidates to this agent's skill list (default: every readable skill)."
    )


class RouteCandidate(BaseModel):
    slug: str
    name: str
    description: str
    selected: bool


class RouteTestResult(BaseModel):
    mode: Literal["slash", "router"]
    selected: list[str] = Field(description="Skill slugs that would be activated (empty = none, base tools only).")
    confidence: float
    threshold: float = Field(description="Confidence below this degrades the router's pick to no skill.")
    rationale: str
    raw_picks: list[str] = Field(description="What the router proposed before the confidence threshold was applied.")
    candidates: list[RouteCandidate]
    latency_ms: Optional[float] = None


@router.post("/skills/route-test", response_model=RouteTestResult)
def skill_route_test(request: RouteTestRequest, user: CurrentUser = Depends(current_user)) -> RouteTestResult:
    """Which skill would the router pick for this text? Runs the REAL auto-mode
    router (the same prompt, candidate list and confidence threshold a run uses)
    over the skills the caller can read, without creating a run or session, and
    returns the pick with its rationale and confidence. A leading `/slug` is
    reported as a forced slash invocation, as in a real run."""
    candidates = skills_repo.list_skills(enabled=True)
    candidates = [
        s for s in candidates
        if rbac.can_read(user.id, user.role, Resource(owner_id=s["owner_id"], visibility=s["visibility"]))
    ]
    if request.agent_id is not None:
        agent = _get_readable_or_404(request.agent_id, user)
        allow = set(agent.get("skill_ids") or [])
        if allow:
            candidates = [s for s in candidates if s["id"] in allow]

    def _rows(selected: list[str]) -> list[RouteCandidate]:
        return [
            RouteCandidate(slug=s["slug"], name=s["name"], description=s["description"], selected=s["slug"] in selected)
            for s in candidates
        ]

    slash = agent_runtime.parse_slash(request.objective)
    if slash is not None:
        slug, remainder = slash
        if not any(s["slug"] == slug for s in candidates):
            raise HTTPException(status_code=422, detail=f"unknown or inaccessible skill command '/{slug}'")
        if not remainder:
            raise HTTPException(status_code=422, detail=f"add a request after the command, e.g. '/{slug} <your question>'")
        return RouteTestResult(
            mode="slash", selected=[slug], confidence=1.0, threshold=agent_runtime.AUTO_CONFIDENCE_THRESHOLD,
            rationale=f"The text starts with the slash command /{slug}, which forces that skill without asking the router.",
            raw_picks=[slug], candidates=_rows([slug]),
        )
    if not candidates:
        raise HTTPException(status_code=422, detail="there are no enabled skills to route between")
    if _router_model_factory is build_openai_model and not llm_configured():
        raise HTTPException(status_code=422, detail="OPENAI_API_KEY is not configured")
    try:
        selection, latency_ms, _tokens = agent_runtime.run_router(candidates, request.objective, _router_model_factory())
    except Exception as exc:  # noqa: BLE001 - provider/network failure: report it, do not 500
        raise HTTPException(status_code=502, detail=f"the router model call failed: {type(exc).__name__}") from exc
    by_slug = {s["slug"] for s in candidates}
    picks = [slug for slug in selection.skills if slug in by_slug][:2]
    applied = picks if selection.confidence >= agent_runtime.AUTO_CONFIDENCE_THRESHOLD else []
    return RouteTestResult(
        mode="router", selected=applied, confidence=selection.confidence,
        threshold=agent_runtime.AUTO_CONFIDENCE_THRESHOLD, rationale=selection.rationale, raw_picks=picks,
        candidates=_rows(applied), latency_ms=latency_ms,
    )
