"""Malformed LLM responses: the raw LLM client can emit invalid JSON shapes.
The harness must validate (not just try/except blindly), retry up to
`max_llm_retries`, recover if a later attempt is valid, and abort cleanly
with a terminal state if retries are exhausted."""

from __future__ import annotations

from agent_harness.config import HarnessConfig
from agent_harness.llm_client import ScriptedLLMClient
from agent_harness.loop import AgentLoop


def test_malformed_response_then_recovery(tools, runs_dir, fast_config):
    script = [
        {"action": "tool_call"},  # missing required tool_name/tool_args -> invalid
        {"not_a_valid_field": True},  # missing action entirely -> invalid
        {"action": "final_answer", "final_answer": "Recovered after 2 malformed attempts."},
    ]
    llm = ScriptedLLMClient(script)
    loop = AgentLoop(llm_client=llm, tools=tools, config=fast_config, runs_dir=runs_dir)

    result = loop.run("Trigger malformed LLM output then recover")

    assert result.status == "completed"
    assert result.final_answer == "Recovered after 2 malformed attempts."

    malformed_events = [e for e in result.history if e.event_type == "llm_malformed_response"]
    assert len(malformed_events) == 2
    assert malformed_events[0].data["attempt"] == 1
    assert malformed_events[1].data["attempt"] == 2
    assert "llm_retry_exhausted" not in [e.event_type for e in result.history]


def test_malformed_response_retries_exhausted_aborts_cleanly(tools, runs_dir):
    script = [
        {"action": "tool_call"},
        {"action": "tool_call"},
        {"action": "tool_call"},
        {"action": "tool_call"},
    ]
    llm = ScriptedLLMClient(script)
    config = HarnessConfig(
        max_steps=5,
        max_wall_clock_seconds=10.0,
        tool_timeout_seconds=2.0,
        max_tool_retries=0,
        tool_retry_backoff_seconds=0.0,
        max_llm_retries=1,
    )
    loop = AgentLoop(llm_client=llm, tools=tools, config=config, runs_dir=runs_dir)

    result = loop.run("Always return malformed decisions")

    assert result.status == "llm_error_exceeded"
    assert result.final_answer is None
    event_types = [e.event_type for e in result.history]
    assert event_types.count("llm_malformed_response") == config.max_llm_retries + 1
    assert "llm_retry_exhausted" in event_types
