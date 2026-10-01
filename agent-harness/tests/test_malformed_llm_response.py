"""Malformed LLM responses: the underlying model can produce output Pydantic
AI itself cannot turn into a valid decision (simulated here via a
`FunctionModel` callback that raises). The harness must catch this, retry
up to `max_llm_retries`, recover if a later attempt is valid, and abort
cleanly with a terminal state if retries are exhausted."""

from __future__ import annotations

from agent_harness.config import HarnessConfig
from agent_harness.llm_client import build_raising_then_scripted_model
from agent_harness.loop import AgentLoop


def test_malformed_response_then_recovery(tools, runs_dir, fast_config):
    model = build_raising_then_scripted_model(
        fail_times=2,
        then_script=[{"action": "final_answer", "final_answer": "Recovered after 2 malformed attempts."}],
    )
    loop = AgentLoop(model=model, tools=tools, config=fast_config, runs_dir=runs_dir)

    result = loop.run("Trigger malformed LLM output then recover")

    assert result.status == "completed"
    assert result.final_answer == "Recovered after 2 malformed attempts."

    malformed_events = [e for e in result.history if e.event_type == "llm_malformed_response"]
    assert len(malformed_events) == 2
    assert malformed_events[0].data["attempt"] == 1
    assert malformed_events[1].data["attempt"] == 2
    assert "llm_retry_exhausted" not in [e.event_type for e in result.history]


def test_malformed_response_retries_exhausted_aborts_cleanly(tools, runs_dir):
    config = HarnessConfig(
        max_steps=5,
        max_wall_clock_seconds=10.0,
        tool_timeout_seconds=2.0,
        max_tool_retries=0,
        tool_retry_backoff_seconds=0.0,
        max_llm_retries=1,
    )
    # Always raises: fail_times greater than any attempt budget the harness
    # will ever spend before giving up.
    model = build_raising_then_scripted_model(
        fail_times=999,
        then_script=[{"action": "final_answer", "final_answer": "never reached"}],
    )
    loop = AgentLoop(model=model, tools=tools, config=config, runs_dir=runs_dir)

    result = loop.run("Always return malformed decisions")

    assert result.status == "llm_error_exceeded"
    assert result.final_answer is None
    event_types = [e.event_type for e in result.history]
    assert event_types.count("llm_malformed_response") == config.max_llm_retries + 1
    assert "llm_retry_exhausted" in event_types
