"""Schema-level input validation: bad tool args must be rejected by the
pydantic input_model before the tool ever runs, not merely caught by a
generic try/except around tool.run()."""

from __future__ import annotations

from agent_harness.llm_client import build_scripted_model
from agent_harness.loop import AgentLoop


def test_invalid_tool_args_are_rejected_before_execution(tools, runs_dir, fast_config):
    script = [
        # severity is not one of the allowed literals, and title is empty.
        {
            "action": "tool_call",
            "tool_name": "create_incident",
            "tool_args": {"title": "", "description": "x", "severity": "catastrophic"},
        },
        {"action": "final_answer", "final_answer": "Could not create incident: invalid args."},
    ]
    llm = build_scripted_model(script)
    loop = AgentLoop(model=llm, tools=tools, config=fast_config, runs_dir=runs_dir)

    result = loop.run("Create an incident with bad args")

    event_types = [e.event_type for e in result.history]
    assert "tool_validation_error" in event_types
    # Rejected before any approval prompt or execution attempt.
    assert "approval_requested" not in event_types
    assert "tool_call_started" not in event_types
    assert result.status == "completed"
    assert result.final_answer == "Could not create incident: invalid args."


def test_unknown_tool_name_is_recorded_and_does_not_crash(tools, runs_dir, fast_config):
    script = [
        {"action": "tool_call", "tool_name": "delete_production_database", "tool_args": {}},
        {"action": "final_answer", "final_answer": "That tool does not exist."},
    ]
    llm = build_scripted_model(script)
    loop = AgentLoop(model=llm, tools=tools, config=fast_config, runs_dir=runs_dir)

    result = loop.run("Try to call a nonexistent tool")

    event_types = [e.event_type for e in result.history]
    assert "tool_call_error" in event_types
    assert result.status == "completed"
