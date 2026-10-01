"""Tool-failure path: a tool call fails, the harness retries per config, and
(a) retries can recover a transient failure, or (b) exhausted retries are
recorded and the loop keeps going (LLM sees the failure and still reaches a
final answer instead of crashing)."""

from __future__ import annotations

from pydantic import BaseModel

from agent_harness.exceptions import ToolExecutionError
from agent_harness.llm_client import build_scripted_model
from agent_harness.loop import AgentLoop
from agent_harness.tools.base import Tool


def test_permanent_tool_failure_exhausts_retries_and_is_recorded(tools, runs_dir, fast_config):
    # "does-not-exist" is not in the mock service registry -> always raises
    # ToolExecutionError, deterministically, on every attempt.
    script = [
        {
            "action": "tool_call",
            "tool_name": "get_service_status",
            "tool_args": {"service_name": "does-not-exist"},
        },
        {"action": "final_answer", "final_answer": "Could not determine status; escalate manually."},
    ]
    llm = build_scripted_model(script)
    loop = AgentLoop(model=llm, tools=tools, config=fast_config, runs_dir=runs_dir)

    result = loop.run("Check status of does-not-exist service")

    assert result.status == "completed"  # loop recovers gracefully, doesn't crash
    assert result.final_answer == "Could not determine status; escalate manually."

    error_events = [e for e in result.history if e.event_type == "tool_call_error"]
    retry_events = [e for e in result.history if e.event_type == "tool_call_retry"]
    exhausted_events = [e for e in result.history if e.event_type == "tool_call_retries_exhausted"]

    # max_tool_retries=2 -> 3 total attempts -> 3 errors, 2 retries logged, 1 exhausted event.
    assert len(error_events) == fast_config.max_tool_retries + 1
    assert len(retry_events) == fast_config.max_tool_retries
    assert len(exhausted_events) == 1
    assert "Unknown service" in error_events[0].data["error"]
    # The error names the real services so the model can correct the call.
    assert "Registered services: " in error_events[0].data["error"]
    assert "payments-api" in error_events[0].data["error"]


class _FlakyInput(BaseModel):
    value: str


class _FlakyOutput(BaseModel):
    value: str
    attempt: int


class _FlakyTool(Tool[_FlakyInput, _FlakyOutput]):
    """Test double: fails on the first call, succeeds on the second."""

    name = "flaky_tool"
    description = "Fails once then succeeds, to exercise retry-then-recover."
    input_model = _FlakyInput
    output_model = _FlakyOutput
    requires_approval = False

    def __init__(self) -> None:
        self.calls = 0

    def run(self, args: _FlakyInput) -> _FlakyOutput:
        self.calls += 1
        if self.calls == 1:
            raise ToolExecutionError("simulated transient failure")
        return _FlakyOutput(value=args.value, attempt=self.calls)


def test_transient_tool_failure_recovers_on_retry(runs_dir, fast_config):
    flaky = _FlakyTool()
    registry = {"flaky_tool": flaky}
    script = [
        {"action": "tool_call", "tool_name": "flaky_tool", "tool_args": {"value": "x"}},
        {"action": "final_answer", "final_answer": "Recovered after retry."},
    ]
    llm = build_scripted_model(script)
    loop = AgentLoop(model=llm, tools=registry, config=fast_config, runs_dir=runs_dir)

    result = loop.run("Exercise the flaky tool")

    assert result.status == "completed"
    assert flaky.calls == 2

    event_types = [e.event_type for e in result.history]
    assert event_types.count("tool_call_error") == 1
    assert event_types.count("tool_call_retry") == 1
    assert event_types.count("tool_call_result") == 1
    assert "tool_call_retries_exhausted" not in event_types


def test_tool_timeout_is_recorded_and_retried(runs_dir):
    import time

    class _SlowInput(BaseModel):
        pass

    class _SlowOutput(BaseModel):
        ok: bool

    class _SlowTool(Tool[_SlowInput, _SlowOutput]):
        name = "slow_tool"
        description = "Always exceeds the configured timeout."
        input_model = _SlowInput
        output_model = _SlowOutput
        requires_approval = False

        def run(self, args: _SlowInput) -> _SlowOutput:
            time.sleep(0.5)
            return _SlowOutput(ok=True)

    from agent_harness.config import HarnessConfig

    config = HarnessConfig(
        max_steps=5,
        max_wall_clock_seconds=10.0,
        tool_timeout_seconds=0.05,
        max_tool_retries=1,
        tool_retry_backoff_seconds=0.001,
        max_llm_retries=1,
    )
    script = [
        {"action": "tool_call", "tool_name": "slow_tool", "tool_args": {}},
        {"action": "final_answer", "final_answer": "Gave up waiting on slow_tool."},
    ]
    llm = build_scripted_model(script)
    loop = AgentLoop(model=llm, tools={"slow_tool": _SlowTool()}, config=config, runs_dir=runs_dir)

    result = loop.run("Call the slow tool")

    assert result.status == "completed"
    timeout_events = [e for e in result.history if e.event_type == "tool_call_timeout"]
    assert len(timeout_events) == config.max_tool_retries + 1
