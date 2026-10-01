"""Approval gate: create_incident must never execute without an explicit
approve signal from the injected callback. Covers both approve and deny."""

from __future__ import annotations

from agent_harness.approval import always_approve, always_deny
from agent_harness.llm_client import build_scripted_model
from agent_harness.loop import AgentLoop

_INCIDENT_SCRIPT = [
    {
        "action": "tool_call",
        "tool_name": "create_incident",
        "tool_args": {
            "title": "search-index is down",
            "description": "Nightly rebuild job failed; search-index reports down.",
            "severity": "high",
        },
    },
    {"action": "final_answer", "final_answer": "Incident handled."},
]


def test_approval_granted_executes_create_incident(tools, runs_dir, fast_config):
    llm = build_scripted_model(list(_INCIDENT_SCRIPT))
    loop = AgentLoop(
        model=llm, tools=tools, config=fast_config, approval_callback=always_approve, runs_dir=runs_dir
    )

    result = loop.run("search-index is down, please create an incident")

    event_types = [e.event_type for e in result.history]
    assert "approval_requested" in event_types
    assert "approval_granted" in event_types
    assert "approval_denied" not in event_types
    assert "tool_call_started" in event_types
    assert "tool_call_result" in event_types

    result_event = next(e for e in result.history if e.event_type == "tool_call_result")
    assert result_event.data["output"]["status"] == "created"
    assert result_event.data["output"]["incident_id"].startswith("INC-")
    assert result.status == "completed"


def test_approval_denied_blocks_create_incident_execution(tools, runs_dir, fast_config):
    llm = build_scripted_model(list(_INCIDENT_SCRIPT))
    loop = AgentLoop(
        model=llm, tools=tools, config=fast_config, approval_callback=always_deny, runs_dir=runs_dir
    )

    result = loop.run("search-index is down, please create an incident")

    event_types = [e.event_type for e in result.history]
    assert "approval_requested" in event_types
    assert "approval_denied" in event_types
    assert "approval_granted" not in event_types
    # The tool must never actually run when denied.
    assert "tool_call_started" not in event_types
    assert "tool_call_result" not in event_types
    # Loop continues past the denial to the scripted final_answer.
    assert result.status == "completed"
    assert result.final_answer == "Incident handled."


def test_approval_callback_receives_validated_tool_args(tools, runs_dir, fast_config):
    seen: list[tuple[str, dict]] = []

    def recording_callback(tool_name: str, tool_args: dict) -> bool:
        seen.append((tool_name, tool_args))
        return True

    llm = build_scripted_model(list(_INCIDENT_SCRIPT))
    loop = AgentLoop(
        model=llm, tools=tools, config=fast_config, approval_callback=recording_callback, runs_dir=runs_dir
    )
    loop.run("search-index is down, please create an incident")

    assert len(seen) == 1
    tool_name, args = seen[0]
    assert tool_name == "create_incident"
    assert args["title"] == "search-index is down"
    assert args["severity"] == "high"
