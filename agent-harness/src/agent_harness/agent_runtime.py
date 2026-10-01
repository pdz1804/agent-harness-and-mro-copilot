"""Run-time resolution of "which system prompt / tools / skill(s) does this
run actually get" (phase 04) — the pure logic sitting between an `agents`
row and `AgentLoop`'s `system_prompt`/`tools` constructor args. Deliberately
kept out of `loop.py` (see plan.md's "loop.py change (minimal)"): this
module only ever produces a `RunPlan`; nothing here drives the LLM<->tool
loop itself.

Resolution order (`resolve_run_plan`):
1. A leading `/slug` slash command in the objective forces that skill
   (`skill_invoked`), regardless of the agent's own `skill_mode`.
2. `assigned` mode: every skill in `agent.skill_ids` (`skills_assigned`).
3. `auto` mode: a separate, cheap router `pydantic_ai.Agent` call
   (`output_type=SkillSelection`) over the agent's readable+enabled
   candidate skills picks 0-2 (`skill_routed`); a low-confidence or empty
   selection degrades to no skill; a router failure degrades to no skill
   too (`skill_routing_failed`) and never fails the run.
4. `none` mode (or no active skill resolved above): the agent's own
   `base_tools`.

Every branch's tool set is intersected with `enabled_tool_names` (the
caller's already-computed Integrations enabled/disabled state) — an empty
result after that intersection still lets the run proceed, answer-only,
flagged by a `no_tools_available` event.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from pydantic import BaseModel, Field
from pydantic_ai import Agent as PydanticAgent
from pydantic_ai.models import Model

from agent_harness import observability, rbac
from agent_harness.rbac import Resource, Role
from agent_harness.repos import prompts as prompts_repo
from agent_harness.repos import skills as skills_repo
from agent_harness.schemas import AgentEvent

# Matches a leading slash command: `/slug rest of objective`. Slug charset
# mirrors `skills_repo._SLUG_RE` (lowercase kebab-case). Only matches at the
# very start of the (stripped) objective — a `/` occurring mid-string is
# never treated as a command.
_SLASH_RE = re.compile(r"^/([a-z0-9][a-z0-9-]{0,40})[ \t]*(.*)$", re.DOTALL)

# Confidence below this threshold degrades an `auto`-mode router selection
# to "no skill" — a low-confidence guess is worse than the agent's own base
# tools, per the phase file's design.
AUTO_CONFIDENCE_THRESHOLD = 0.5

# Long-term memory is ambient: unlike a skill's task tools, `remember`/`recall`
# are offered to every run whose agent is not locked to assigned skills (an
# `assigned` agent such as the KB concierge is deliberately limited to its
# skill's tools), whichever skill the router picked. The integrations toggle
# still removes them.
AMBIENT_TOOLS = frozenset({"remember", "recall"})

MEMORY_GUIDE = (
    "\n\n## Long-term memory\n"
    "You have a persistent memory for this user that survives across conversations. When a request may "
    "depend on something the user told you earlier (preferences, owners, past decisions), call recall "
    "first. When the user asks you to remember something, or states a lasting preference, call remember "
    "with one self-contained sentence and a few short tags. Never store secrets. Mention briefly when you "
    "used or saved a memory."
)


class SkillSelection(BaseModel):
    """Structured output of the auto-discover router agent."""

    skills: list[str] = Field(default_factory=list, description="0-2 candidate skill slugs, best first.")
    rationale: str = Field(default="", description="One or two sentences explaining the choice.")
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class SlashCommandError(ValueError):
    """422-worthy: an unknown/inaccessible `/slug` command, or one with no
    request text after it. The router (`routers/agents.py`/`api.py`)
    translates this into an HTTP 422 with `str(exc)` as the detail."""


@dataclass
class RunPlan:
    """Everything `run_registry.start_run` needs to build this run's
    `AgentLoop`: the fully-composed system prompt, the resolved tool name
    set, which skill(s) (if any) ended up active, which prompt version was
    used, and the preamble trace events to log at step 0."""

    system_prompt: str
    objective: str
    tool_names: set[str]
    active_skill_slugs: list[str]
    active_skill_ids: list[str]
    prompt_version_id: Optional[str]
    events: list[AgentEvent] = field(default_factory=list)


def parse_slash(objective: str) -> Optional[tuple[str, str]]:
    """`(slug, remainder)` if `objective` (after stripping) starts with a
    `/slug` slash command, else `None`. Does not validate that the slug
    names a real/accessible skill — that's `resolve_run_plan`'s job."""
    match = _SLASH_RE.match(objective.strip())
    if match is None:
        return None
    return match.group(1), match.group(2).strip()


def validate_slash_command(objective: str, user_id: str, user_role: Role) -> None:
    """Pre-flight check for the API layer: raise `SlashCommandError` for a
    malformed/inaccessible `/slug` objective *before* any session/run row is
    created, so an invalid slash command never leaves behind an orphaned
    empty session. No-op if `objective` isn't a slash command at all."""
    slash = parse_slash(objective)
    if slash is None:
        return
    slug, remainder = slash
    if _readable_enabled_skill_by_slug(slug, user_id, user_role) is None:
        raise SlashCommandError(
            f"unknown or inaccessible skill command '/{slug}' — see GET /skills/commands"
        )
    if not remainder:
        raise SlashCommandError(f"add a request after the command, e.g. '/{slug} <your question>'")


def _resource_of(skill: dict[str, Any]) -> Resource:
    return Resource(owner_id=skill.get("owner_id"), visibility=skill.get("visibility", "shared"))


def _readable_enabled_skill_by_slug(
    slug: str, user_id: str, user_role: Role
) -> Optional[dict[str, Any]]:
    skill = skills_repo.get_skill_by_slug(slug)
    if skill is None or not skill.get("enabled", True):
        return None
    if not rbac.can_read(user_id, user_role, _resource_of(skill)):
        return None
    return skill


def _candidate_skills(agent: dict[str, Any], user_id: str, user_role: Role) -> list[dict[str, Any]]:
    """Every enabled skill readable by the caller, optionally narrowed to
    `agent.skill_ids` when that list is non-empty (an explicit candidate
    allow-list for `auto` mode; empty means "every readable enabled
    skill")."""
    all_enabled = skills_repo.list_skills(enabled=True)
    readable = [s for s in all_enabled if rbac.can_read(user_id, user_role, _resource_of(s))]
    allow_list = set(agent.get("skill_ids") or [])
    if allow_list:
        readable = [s for s in readable if s["id"] in allow_list]
    return readable


def _render_catalog(candidates: list[dict[str, Any]]) -> str:
    lines = []
    for c in candidates:
        examples = list(c.get("examples") or [])
        example_txt = f" (example objectives: {'; '.join(examples)})" if examples else ""
        lines.append(f"- {c['slug']}: {c['description']}{example_txt}")
    return "\n".join(lines)


def run_router(
    candidates: list[dict[str, Any]], objective: str, router_model: Model
) -> tuple[SkillSelection, float, Optional[int]]:
    router_prompt, _ = prompts_repo.get_active_content("skill-router")
    system_prompt = router_prompt or (
        "Select the 0-2 best-matching skill(s) for the objective from the candidate list, or "
        "none if nothing fits well. Respond with your selection, a short rationale, and a "
        "confidence between 0 and 1."
    )
    router_agent = PydanticAgent(system_prompt=system_prompt, output_type=SkillSelection)
    user_prompt = f"Objective: {objective}\n\nCandidate skills:\n{_render_catalog(candidates)}"

    t0 = time.monotonic()
    with observability.span("skill_router", span_type="AGENT") as mlf_span:
        mlf_span.set_inputs({"objective": objective, "candidates": [c["slug"] for c in candidates]})
        result = router_agent.run_sync(user_prompt, model=router_model)
        latency_ms = (time.monotonic() - t0) * 1000
        usage = getattr(result, "usage", None)
        usage = usage() if callable(usage) else usage
        tokens = None
        if usage is not None:
            input_tokens = getattr(usage, "input_tokens", None) or 0
            output_tokens = getattr(usage, "output_tokens", None) or 0
            tokens = input_tokens + output_tokens or None
        mlf_span.set_outputs(
            {
                "skills": result.output.skills,
                "rationale": result.output.rationale,
                "confidence": result.output.confidence,
            }
        )
    return result.output, latency_ms, tokens


def resolve_agent_prompt(agent: dict[str, Any]) -> tuple[str, Optional[str]]:
    """The agent's bound prompt content: a pinned `prompt_version_id` wins
    if set, otherwise the prompt's currently-active version (follows future
    activations)."""
    if agent.get("prompt_version_id"):
        content, version_id = prompts_repo.get_pinned_content(
            agent["prompt_id"], agent["prompt_version_id"]
        )
        if content is not None:
            return content, version_id
    prompt = prompts_repo.get_prompt(agent["prompt_id"])
    if prompt is None:
        return "", None
    content, version_id = prompts_repo.get_active_content(prompt["slug"])
    return content or "", version_id


def resolve_run_plan(
    *,
    agent: dict[str, Any],
    objective: str,
    user_id: str,
    user_role: Role,
    enabled_tool_names: set[str],
    router_model: Optional[Model] = None,
) -> RunPlan:
    """The single entry point `run_registry.start_run` (and the API's slash
    pre-validation) calls. Raises `SlashCommandError` for a malformed/
    inaccessible `/slug` command — the caller should surface that as a 422
    *before* starting any run/session (never inside a background thread)."""
    events: list[AgentEvent] = []
    active_skills: list[dict[str, Any]] = []
    effective_objective = objective

    slash = parse_slash(objective)
    if slash is not None:
        slug, remainder = slash
        skill = _readable_enabled_skill_by_slug(slug, user_id, user_role)
        if skill is None:
            raise SlashCommandError(
                f"unknown or inaccessible skill command '/{slug}' — see GET /skills/commands"
            )
        if not remainder:
            raise SlashCommandError(
                f"add a request after the command, e.g. '/{slug} <your question>'"
            )
        effective_objective = remainder
        active_skills = [skill]
        events.append(
            AgentEvent(
                run_id="",
                step=0,
                event_type="skill_invoked",
                data={"slug": slug, "skill_id": skill["id"], "source": "slash"},
            )
        )
    elif agent.get("skill_mode") == "assigned":
        assigned: list[dict[str, Any]] = []
        for skill_id in agent.get("skill_ids") or []:
            skill = skills_repo.get_skill(skill_id)
            if skill is not None and skill.get("enabled", True):
                assigned.append(skill)
        active_skills = assigned
        events.append(
            AgentEvent(
                run_id="",
                step=0,
                event_type="skills_assigned",
                data={
                    "skill_ids": [s["id"] for s in assigned],
                    "slugs": [s["slug"] for s in assigned],
                },
            )
        )
    elif agent.get("skill_mode") == "auto":
        candidates = _candidate_skills(agent, user_id, user_role)
        if candidates and router_model is not None:
            try:
                selection, latency_ms, tokens = run_router(candidates, objective, router_model)
                candidate_slugs = {c["slug"]: c for c in candidates}
                selected_slugs = [s for s in selection.skills if s in candidate_slugs][:2]
                if selection.confidence < AUTO_CONFIDENCE_THRESHOLD or not selected_slugs:
                    selected_slugs = []
                active_skills = [candidate_slugs[s] for s in selected_slugs]
                events.append(
                    AgentEvent(
                        run_id="",
                        step=0,
                        event_type="skill_routed",
                        latency_ms=latency_ms,
                        data={
                            "candidates": sorted(candidate_slugs.keys()),
                            "selected": selected_slugs,
                            "rationale": selection.rationale,
                            "confidence": selection.confidence,
                            "tokens": tokens,
                        },
                    )
                )
            except Exception as exc:  # noqa: BLE001 - a router bug must never fail the run
                events.append(
                    AgentEvent(
                        run_id="",
                        step=0,
                        event_type="skill_routing_failed",
                        data={"error": str(exc)},
                    )
                )
        elif candidates and router_model is None:
            # No router model configured (e.g. a caller that never wired one
            # up) — degrade the same way a router failure would, rather than
            # silently skipping the event.
            events.append(
                AgentEvent(
                    run_id="",
                    step=0,
                    event_type="skill_routing_failed",
                    data={"error": "no router model configured"},
                )
            )
    # `skill_mode == "none"` (or "auto" with zero candidates): no skill,
    # nothing to log — base_tools alone is the normal, unflagged case.

    if active_skills:
        tool_names = set()
        for skill in active_skills:
            tool_names |= set(skill.get("allowed_tools") or [])
    else:
        tool_names = set(agent.get("base_tools") or [])
    tool_names &= enabled_tool_names

    if not tool_names:
        events.append(AgentEvent(run_id="", step=0, event_type="no_tools_available", data={}))
    memory_tools = (AMBIENT_TOOLS & enabled_tool_names) if agent.get("skill_mode") != "assigned" else set()
    tool_names |= memory_tools

    content, prompt_version_id = resolve_agent_prompt(agent)
    system_prompt = content
    if active_skills:
        parts = [system_prompt, "\n\n## Active skills"]
        for skill in active_skills:
            parts.append(f"\n### {skill['name']} (/{skill['slug']})\n{skill['instructions']}")
        system_prompt = "".join(parts)
    if memory_tools:
        system_prompt += MEMORY_GUIDE

    return RunPlan(
        system_prompt=system_prompt,
        objective=effective_objective,
        tool_names=tool_names,
        active_skill_slugs=[s["slug"] for s in active_skills],
        active_skill_ids=[s["id"] for s in active_skills],
        prompt_version_id=prompt_version_id,
        events=events,
    )


__all__ = [
    "AMBIENT_TOOLS",
    "AUTO_CONFIDENCE_THRESHOLD",
    "run_router",
    "MEMORY_GUIDE",
    "RunPlan",
    "SkillSelection",
    "SlashCommandError",
    "parse_slash",
    "resolve_run_plan",
]
