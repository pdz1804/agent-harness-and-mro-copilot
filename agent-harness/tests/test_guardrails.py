"""Guardrails (12c): a real, enforced input guardrail (banned objective
patterns) and a real, enforced output guardrail (severity-evidence cap on
`create_incident`) — both exercised directly against `AgentLoop`, the same
level `test_approval_gate.py`/`test_limits.py` operate at."""

from __future__ import annotations

from agent_harness import db
from agent_harness.approval import always_approve
from agent_harness.llm_client import build_scripted_model
from agent_harness.loop import AgentLoop


def _make_guardrail(kind: str, config: dict, enabled: bool = True, name: str = "test guardrail"):
    import uuid
    from datetime import datetime, timezone

    guardrail_id = f"gr-{uuid.uuid4().hex[:8]}"
    return db.create_guardrail(guardrail_id, name, kind, config, enabled, datetime.now(timezone.utc).isoformat())


def test_default_severity_guardrail_is_enabled_after_ensure_ready():
    """The migration/ensure_ready seed is what real runs rely on by default."""
    guardrails = db.list_enabled_guardrails(kind="severity_upgrade_block")
    assert any(g["id"] == "gr-severity-cap" for g in guardrails)


# -- input guardrail -------------------------------------------------------


def test_objective_matching_banned_pattern_blocks_the_run_before_any_llm_call(tools, runs_dir, fast_config):
    _make_guardrail("objective_pattern_block", {"patterns": ["delete all data"]})

    # A script that would produce a final_answer *other* than what this test
    # asserts on: if the guardrail failed to block genuinely early and the
    # LLM were actually driven, `result.status` would be "completed" with
    # this text instead of "guardrail_blocked" — a real signal, not just an
    # empty-script crash.
    llm = build_scripted_model([{"action": "final_answer", "final_answer": "should never be reached"}])
    loop = AgentLoop(model=llm, tools=tools, config=fast_config, approval_callback=always_approve, runs_dir=runs_dir)

    result = loop.run("please delete all data in the production database")

    assert result.status == "guardrail_blocked"
    assert result.steps_taken == 0
    event_types = [e.event_type for e in result.history]
    assert event_types == ["guardrail_blocked"]
    blocked_event = result.history[0]
    assert blocked_event.data["matched_pattern"] == "delete all data"
    assert "guardrail_id" in blocked_event.data


def test_objective_not_matching_any_pattern_proceeds_normally(tools, runs_dir, fast_config):
    _make_guardrail("objective_pattern_block", {"patterns": ["delete all data"]})

    llm = build_scripted_model([{"action": "final_answer", "final_answer": "All clear."}])
    loop = AgentLoop(model=llm, tools=tools, config=fast_config, approval_callback=always_approve, runs_dir=runs_dir)

    result = loop.run("investigate auth-service")

    assert result.status == "completed"
    assert "guardrail_blocked" not in [e.event_type for e in result.history]


def test_disabled_pattern_guardrail_does_not_block(tools, runs_dir, fast_config):
    _make_guardrail("objective_pattern_block", {"patterns": ["delete all data"]}, enabled=False)

    llm = build_scripted_model([{"action": "final_answer", "final_answer": "All clear."}])
    loop = AgentLoop(model=llm, tools=tools, config=fast_config, approval_callback=always_approve, runs_dir=runs_dir)

    result = loop.run("please delete all data in the production database")

    assert result.status == "completed"


# -- output guardrail (severity downgrade) ---------------------------------

_CRITICAL_WITHOUT_STATUS_CHECK_SCRIPT = [
    {
        "action": "tool_call",
        "tool_name": "create_incident",
        "tool_args": {
            "title": "payments-api severity escalation",
            "description": "Escalating without checking status first.",
            "severity": "critical",
        },
    },
    {"action": "final_answer", "final_answer": "Incident handled."},
]


def test_critical_severity_without_down_evidence_is_downgraded_to_high(tools, runs_dir, fast_config):
    llm = build_scripted_model(list(_CRITICAL_WITHOUT_STATUS_CHECK_SCRIPT))
    loop = AgentLoop(
        model=llm, tools=tools, config=fast_config, approval_callback=always_approve, runs_dir=runs_dir
    )

    result = loop.run("escalate payments-api immediately")

    event_types = [e.event_type for e in result.history]
    assert "guardrail_severity_downgraded" in event_types
    downgraded_event = next(e for e in result.history if e.event_type == "guardrail_severity_downgraded")
    assert downgraded_event.data["proposed_severity"] == "critical"
    assert downgraded_event.data["downgraded_to"] == "high"

    # The approval gate still fires correctly afterward for the (now
    # corrected) call — not disturbed by the guardrail.
    assert "approval_requested" in event_types
    assert "approval_granted" in event_types

    result_event = next(e for e in result.history if e.event_type == "tool_call_result")
    assert result_event.data["output"]["severity"] == "high"
    assert result.status == "completed"


_CRITICAL_WITH_DOWN_STATUS_SCRIPT = [
    {
        "action": "tool_call",
        "tool_name": "get_service_status",
        "tool_args": {"service_name": "search-index"},
    },
    {
        "action": "tool_call",
        "tool_name": "create_incident",
        "tool_args": {
            "title": "search-index outage",
            "description": "search-index confirmed down by get_service_status.",
            "severity": "critical",
        },
    },
    {"action": "final_answer", "final_answer": "Incident handled."},
]


def test_critical_severity_with_down_evidence_is_not_downgraded(tools, runs_dir, fast_config):
    """search-index is seeded as status=down (see conftest._SEED_SERVICES) —
    real evidence in the run's own history that justifies critical."""
    llm = build_scripted_model(list(_CRITICAL_WITH_DOWN_STATUS_SCRIPT))
    loop = AgentLoop(
        model=llm, tools=tools, config=fast_config, approval_callback=always_approve, runs_dir=runs_dir
    )

    result = loop.run("investigate and escalate search-index")

    event_types = [e.event_type for e in result.history]
    assert "guardrail_severity_downgraded" not in event_types

    result_event = next(
        e
        for e in result.history
        if e.event_type == "tool_call_result" and e.data.get("tool_name") == "create_incident"
    )
    assert result_event.data["output"]["severity"] == "critical"
    assert result.status == "completed"


def test_disabled_severity_guardrail_lets_unsupported_critical_through(tools, runs_dir, fast_config):
    db.set_guardrail_enabled("gr-severity-cap", False)

    llm = build_scripted_model(list(_CRITICAL_WITHOUT_STATUS_CHECK_SCRIPT))
    loop = AgentLoop(
        model=llm, tools=tools, config=fast_config, approval_callback=always_approve, runs_dir=runs_dir
    )

    result = loop.run("escalate payments-api immediately")

    event_types = [e.event_type for e in result.history]
    assert "guardrail_severity_downgraded" not in event_types
    result_event = next(e for e in result.history if e.event_type == "tool_call_result")
    assert result_event.data["output"]["severity"] == "critical"
