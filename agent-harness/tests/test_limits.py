"""Step limit and wall-clock time limit: the loop must abort cleanly with a
terminal state instead of looping forever, and that state must be recorded
in history."""

from __future__ import annotations

from agent_harness.config import HarnessConfig
from agent_harness.llm_client import build_scripted_model
from agent_harness.loop import AgentLoop


def test_step_limit_exceeded_aborts_cleanly(tools, runs_dir):
    # Script never produces a final_answer -> would loop forever without the guard.
    script = [
        {
            "action": "tool_call",
            "tool_name": "search_knowledge_base",
            "tool_args": {"query": "status"},
        }
    ]
    llm = build_scripted_model(script)
    config = HarnessConfig(
        max_steps=3,
        max_wall_clock_seconds=30.0,
        tool_timeout_seconds=2.0,
        max_tool_retries=0,
        tool_retry_backoff_seconds=0.0,
        max_llm_retries=0,
    )
    loop = AgentLoop(model=llm, tools=tools, config=config, runs_dir=runs_dir)

    result = loop.run("Never-ending investigation")

    assert result.status == "step_limit_exceeded"
    assert result.steps_taken == 3
    assert result.final_answer is None
    assert result.history[-1].event_type == "step_limit_exceeded"


def test_time_limit_exceeded_aborts_cleanly(tools, runs_dir):
    # Simulated LLM "thinking time" per call exceeds the wall-clock budget.
    script = [
        {
            "action": "tool_call",
            "tool_name": "search_knowledge_base",
            "tool_args": {"query": "status"},
        }
    ]
    llm = build_scripted_model(script, think_time_seconds=0.05)
    config = HarnessConfig(
        max_steps=1000,
        max_wall_clock_seconds=0.08,
        tool_timeout_seconds=2.0,
        max_tool_retries=0,
        tool_retry_backoff_seconds=0.0,
        max_llm_retries=0,
    )
    loop = AgentLoop(model=llm, tools=tools, config=config, runs_dir=runs_dir)

    result = loop.run("Slow-thinking investigation")

    assert result.status == "time_limit_exceeded"
    assert result.final_answer is None
    assert result.history[-1].event_type == "time_limit_exceeded"
    assert result.elapsed_seconds >= config.max_wall_clock_seconds
