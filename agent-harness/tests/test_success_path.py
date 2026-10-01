"""Full success path: LLM searches the KB then gives a final answer, no
tool errors, no approval required."""

from __future__ import annotations

from agent_harness.approval import always_deny
from agent_harness.llm_client import build_scripted_model
from agent_harness.loop import AgentLoop


def test_success_path_completes_with_final_answer(tools, runs_dir, fast_config):
    script = [
        {
            "action": "tool_call",
            "tool_name": "search_knowledge_base",
            "tool_args": {"query": "auth-service outage"},
        },
        {"action": "final_answer", "final_answer": "Found the runbook; issue resolved."},
    ]
    llm = build_scripted_model(script)
    # approval callback should never be invoked on this path; always_deny
    # proves that (a denial here would abort the run if it were ever called).
    loop = AgentLoop(
        model=llm, tools=tools, config=fast_config, approval_callback=always_deny, runs_dir=runs_dir
    )

    result = loop.run("Investigate auth-service outage")

    assert result.status == "completed"
    assert result.final_answer == "Found the runbook; issue resolved."
    assert result.steps_taken == 2

    event_types = [e.event_type for e in result.history]
    assert "llm_decision" in event_types
    assert "tool_call_started" in event_types
    assert "tool_call_result" in event_types
    assert "final_answer" in event_types
    # No approval events: search_knowledge_base does not require approval.
    assert "approval_requested" not in event_types


def test_success_path_writes_jsonl_trace_file(tools, runs_dir, fast_config):
    script = [
        {
            "action": "tool_call",
            "tool_name": "get_service_status",
            "tool_args": {"service_name": "auth-service"},
        },
        {"action": "final_answer", "final_answer": "auth-service is operational."},
    ]
    llm = build_scripted_model(script)
    loop = AgentLoop(model=llm, tools=tools, config=fast_config, runs_dir=runs_dir)

    result = loop.run("What is the status of auth-service?")

    assert result.trace_path is not None
    trace_file = runs_dir / f"{result.run_id}.jsonl"
    assert trace_file.exists()
    lines = trace_file.read_text(encoding="utf-8").strip().splitlines()
    # One JSON line per recorded event, matching in-memory history length.
    assert len(lines) == len(result.history)
    import json

    first = json.loads(lines[0])
    assert first["run_id"] == result.run_id
    assert "event_type" in first
