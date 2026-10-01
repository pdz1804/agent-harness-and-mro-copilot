"""Phase 04 — `agent_harness.agent_runtime.resolve_run_plan`: skill
routing/assignment/slash-invocation logic, fully network-free (the `auto`
router uses `llm_client.build_router_model`/`build_raising_router_model`
FunctionModel doubles, never a real network call).

Uses the suite's real seeded skills/prompts (`tests/conftest.py`'s
`_isolated_data_dir` runs `db.ensure_ready()` against a truncated-then-
reseeded isolated Postgres before every test) rather than an in-memory
double, since `resolve_run_plan` reads skills/prompts straight from
`agent_harness.repos.skills`/`agent_harness.repos.prompts`.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_harness import agent_runtime
from agent_harness.agent_runtime import SlashCommandError, resolve_run_plan
from agent_harness.llm_client import build_raising_router_model, build_router_model
from agent_harness.repos import prompts as prompts_repo
from agent_harness.repos import skills as skills_repo

_ALL_TOOLS = {"search_knowledge_base", "get_service_status", "create_incident"}


def _skill_id(slug: str) -> str:
    return skills_repo.get_skill_by_slug(slug)["id"]


def _base_agent(**overrides: Any) -> dict[str, Any]:
    prompt = prompts_repo.get_prompt_by_slug("ops-system")
    agent = {
        "id": "agt-test",
        "prompt_id": prompt["id"],
        "prompt_version_id": None,
        "skill_mode": "none",
        "skill_ids": [],
        "base_tools": sorted(_ALL_TOOLS),
    }
    agent.update(overrides)
    return agent


# --- assigned mode -----------------------------------------------------------


def test_assigned_mode_tool_set_is_union_of_assigned_skills_intersected_with_enabled():
    agent = _base_agent(
        skill_mode="assigned",
        skill_ids=[_skill_id("kb-answer"), _skill_id("escalate-incident")],
        base_tools=[],
    )
    plan = resolve_run_plan(
        agent=agent,
        objective="what's our escalation policy",
        user_id="u_admin",
        user_role="admin",
        enabled_tool_names=_ALL_TOOLS,
    )
    # kb-answer -> search_knowledge_base; escalate-incident -> get_service_status, create_incident
    assert plan.tool_names == {"search_knowledge_base", "get_service_status", "create_incident"}
    assert set(plan.active_skill_slugs) == {"kb-answer", "escalate-incident"}
    event_types = [e.event_type for e in plan.events]
    assert "skills_assigned" in event_types
    assert "skill_routed" not in event_types


def test_assigned_mode_disabled_integration_removes_tool():
    agent = _base_agent(skill_mode="assigned", skill_ids=[_skill_id("escalate-incident")], base_tools=[])
    plan = resolve_run_plan(
        agent=agent,
        objective="escalate now",
        user_id="u_admin",
        user_role="admin",
        enabled_tool_names={"get_service_status"},  # create_incident disabled
    )
    assert plan.tool_names == {"get_service_status"}


def test_assigned_mode_empty_intersection_emits_no_tools_available():
    agent = _base_agent(skill_mode="assigned", skill_ids=[_skill_id("kb-answer")], base_tools=[])
    plan = resolve_run_plan(
        agent=agent,
        objective="anything",
        user_id="u_admin",
        user_role="admin",
        enabled_tool_names=set(),  # everything disabled
    )
    assert plan.tool_names == set()
    assert "no_tools_available" in [e.event_type for e in plan.events]


def test_system_prompt_contains_skill_instructions():
    agent = _base_agent(skill_mode="assigned", skill_ids=[_skill_id("kb-answer")], base_tools=[])
    plan = resolve_run_plan(
        agent=agent,
        objective="what's the rollback procedure",
        user_id="u_admin",
        user_role="admin",
        enabled_tool_names=_ALL_TOOLS,
    )
    kb_skill = skills_repo.get_skill_by_slug("kb-answer")
    assert kb_skill["instructions"] in plan.system_prompt
    assert "/kb-answer" in plan.system_prompt


# --- auto mode ----------------------------------------------------------------


def test_auto_mode_router_selects_kb_answer_only():
    agent = _base_agent(skill_mode="auto", base_tools=[])
    router_model = build_router_model({"skills": ["kb-answer"], "rationale": "matches KB lookup", "confidence": 0.9})
    plan = resolve_run_plan(
        agent=agent,
        objective="how do we roll back a bad deploy",
        user_id="u_admin",
        user_role="admin",
        enabled_tool_names=_ALL_TOOLS,
        router_model=router_model,
    )
    assert plan.active_skill_slugs == ["kb-answer"]
    assert plan.tool_names == {"search_knowledge_base"}
    routed = next(e for e in plan.events if e.event_type == "skill_routed")
    assert routed.data["selected"] == ["kb-answer"]
    assert routed.data["confidence"] == 0.9


def test_auto_mode_low_confidence_falls_back_to_base_tools():
    agent = _base_agent(skill_mode="auto", base_tools=sorted(_ALL_TOOLS))
    router_model = build_router_model({"skills": ["kb-answer"], "rationale": "weak match", "confidence": 0.2})
    plan = resolve_run_plan(
        agent=agent,
        objective="something vague",
        user_id="u_admin",
        user_role="admin",
        enabled_tool_names=_ALL_TOOLS,
        router_model=router_model,
    )
    assert plan.active_skill_slugs == []
    assert plan.tool_names == _ALL_TOOLS
    routed = next(e for e in plan.events if e.event_type == "skill_routed")
    assert routed.data["selected"] == []


def test_auto_mode_router_failure_degrades_to_base_tools_without_raising():
    agent = _base_agent(skill_mode="auto", base_tools=sorted(_ALL_TOOLS))
    plan = resolve_run_plan(
        agent=agent,
        objective="anything",
        user_id="u_admin",
        user_role="admin",
        enabled_tool_names=_ALL_TOOLS,
        router_model=build_raising_router_model(),
    )
    assert plan.active_skill_slugs == []
    assert plan.tool_names == _ALL_TOOLS
    event_types = [e.event_type for e in plan.events]
    assert "skill_routing_failed" in event_types
    assert "skill_routed" not in event_types


def test_auto_mode_unknown_slug_from_router_is_filtered_out():
    agent = _base_agent(skill_mode="auto", base_tools=[])
    router_model = build_router_model(
        {"skills": ["not-a-real-skill", "kb-answer"], "rationale": "r", "confidence": 0.95}
    )
    plan = resolve_run_plan(
        agent=agent,
        objective="how do we roll back a bad deploy",
        user_id="u_admin",
        user_role="admin",
        enabled_tool_names=_ALL_TOOLS,
        router_model=router_model,
    )
    assert plan.active_skill_slugs == ["kb-answer"]


def test_auto_mode_candidate_allow_list_narrows_catalog():
    agent = _base_agent(skill_mode="auto", skill_ids=[_skill_id("kb-answer")], base_tools=[])
    router_model = build_router_model({"skills": ["kb-answer"], "rationale": "r", "confidence": 0.9})
    plan = resolve_run_plan(
        agent=agent,
        objective="anything",
        user_id="u_admin",
        user_role="admin",
        enabled_tool_names=_ALL_TOOLS,
        router_model=router_model,
    )
    routed = next(e for e in plan.events if e.event_type == "skill_routed")
    assert routed.data["candidates"] == ["kb-answer"]


# --- slash commands ------------------------------------------------------


def test_slash_parse_forces_the_named_skill():
    kb_skill = skills_repo.get_skill_by_slug("kb-answer")
    agent = _base_agent(skill_mode="none", base_tools=[])
    plan = resolve_run_plan(
        agent=agent,
        objective="/kb-answer what is our on-call policy",
        user_id="u_admin",
        user_role="admin",
        enabled_tool_names=_ALL_TOOLS,
    )
    assert plan.active_skill_slugs == ["kb-answer"]
    assert plan.objective == "what is our on-call policy"
    invoked = next(e for e in plan.events if e.event_type == "skill_invoked")
    assert invoked.data == {"slug": "kb-answer", "skill_id": kb_skill["id"], "source": "slash"}


def test_slash_unknown_command_raises_slash_command_error():
    agent = _base_agent()
    with pytest.raises(SlashCommandError):
        resolve_run_plan(
            agent=agent,
            objective="/not-a-real-skill do something",
            user_id="u_admin",
            user_role="admin",
            enabled_tool_names=_ALL_TOOLS,
        )


def test_slash_with_no_text_after_it_raises_slash_command_error():
    agent = _base_agent()
    with pytest.raises(SlashCommandError):
        resolve_run_plan(
            agent=agent,
            objective="/kb-answer",
            user_id="u_admin",
            user_role="admin",
            enabled_tool_names=_ALL_TOOLS,
        )
    with pytest.raises(SlashCommandError):
        resolve_run_plan(
            agent=agent,
            objective="/kb-answer   ",
            user_id="u_admin",
            user_role="admin",
            enabled_tool_names=_ALL_TOOLS,
        )


def test_text_containing_a_slash_mid_string_is_not_treated_as_a_command():
    assert agent_runtime.parse_slash("what is the status of auth/service") is None
    assert agent_runtime.parse_slash("check payments-api / auth-service") is None


def test_slash_command_for_disabled_skill_is_unknown():
    skills_repo.update_skill(_skill_id("kb-answer"), enabled=False, updated_by="u_admin")
    agent = _base_agent()
    with pytest.raises(SlashCommandError):
        resolve_run_plan(
            agent=agent,
            objective="/kb-answer anything",
            user_id="u_admin",
            user_role="admin",
            enabled_tool_names=_ALL_TOOLS,
        )


def test_slash_command_for_private_skill_not_owned_by_caller_is_unknown():
    private = skills_repo.create_skill(
        slug="private-thing",
        name="Private thing",
        description="x",
        instructions="x",
        allowed_tools=["get_service_status"],
        examples=[],
        owner_id="u_editor",
        visibility="private",
        enabled=True,
        updated_by="u_editor",
    )
    agent = _base_agent()
    with pytest.raises(SlashCommandError):
        resolve_run_plan(
            agent=agent,
            objective="/private-thing anything",
            user_id="u_editor2",
            user_role="editor",
            enabled_tool_names=_ALL_TOOLS,
        )
    # ...but the owner can invoke it fine.
    plan = resolve_run_plan(
        agent=agent,
        objective="/private-thing anything",
        user_id="u_editor",
        user_role="editor",
        enabled_tool_names=_ALL_TOOLS,
    )
    assert plan.active_skill_slugs == ["private-thing"]
    assert private["slug"] == "private-thing"
