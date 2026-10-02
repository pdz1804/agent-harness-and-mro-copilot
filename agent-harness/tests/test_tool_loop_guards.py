"""Agent-quality guards: unknown service names reach the model with the valid
list (not retried), "all"/"fleet" returns the whole registry, and a model that
repeats an identical read is stopped and made to answer instead of looping to
the step limit."""

from __future__ import annotations

from pydantic import BaseModel
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel

from agent_harness.llm_client import build_scripted_model
from agent_harness.loop import AgentLoop
from agent_harness.tools.base import Tool
from agent_harness.tools.get_service_status import GetServiceStatusInput, GetServiceStatusTool


def _tool_returns(messages, tool_name):
    return [
        p
        for m in messages
        for p in getattr(m, "parts", [])
        if isinstance(p, ToolReturnPart) and p.tool_name == tool_name
    ]


def test_fleet_aliases_return_every_service():
    tool = GetServiceStatusTool()
    for alias in ("all", "fleet", "Fleet "):
        out = tool.run(GetServiceStatusInput(service_name=alias))
        names = {s.service_name for s in out.services}
        assert out.service_name == "all"
        assert {"payments-api", "search-index", "auth-service"} <= names
        statuses = {s.status for s in out.services}
        expected = "down" if "down" in statuses else "degraded" if "degraded" in statuses else "operational"
        assert out.status == expected


def test_unknown_service_message_reaches_the_model(tools, runs_dir, fast_config):
    seen: dict[str, str] = {}

    def _fn(messages, info):
        returns = _tool_returns(messages, "get_service_status")
        if not returns:
            return ModelResponse(parts=[ToolCallPart("get_service_status", {"service_name": "fleet-service-2"})])
        seen["content"] = str(returns[-1].content)
        return ModelResponse(parts=[TextPart("done")])

    loop = AgentLoop(model=FunctionModel(_fn), tools=tools, config=fast_config, runs_dir=runs_dir)
    result = loop.run("health of fleet-service-2")

    assert result.status == "completed"
    assert "Registered services:" in seen["content"]
    assert "'all'" in seen["content"]
    assert [e.event_type for e in result.history].count("tool_call_started") == 1


class _EchoInput(BaseModel):
    query: str


class _EchoOutput(BaseModel):
    items: list[str]


class _CountingRecall(Tool[_EchoInput, _EchoOutput]):
    name = "recall"
    description = "Returns nothing useful."
    input_model = _EchoInput
    output_model = _EchoOutput
    requires_approval = False

    def __init__(self) -> None:
        self.calls = 0

    def run(self, args: _EchoInput) -> _EchoOutput:
        self.calls += 1
        return _EchoOutput(items=[])


def test_repeated_identical_call_is_not_rerun_and_run_finishes(runs_dir, fast_config):
    tool = _CountingRecall()

    def _fn(messages, info):
        if not info.function_tools:  # the harness removed the tools: answer now
            return ModelResponse(parts=[TextPart("No memory about fleet health; nothing to report.")])
        # Otherwise this model would loop `recall` forever.
        return ModelResponse(parts=[ToolCallPart("recall", {"query": "fleet health"})])

    loop = AgentLoop(model=FunctionModel(_fn), tools={"recall": tool}, config=fast_config, runs_dir=runs_dir)
    result = loop.run("give me a health report for the fleet")

    assert result.status == "completed"
    assert result.final_answer.startswith("No memory about fleet health")
    assert tool.calls == 1  # repeats are answered from the first result, never re-run
    assert result.steps_taken < fast_config.max_steps


def test_model_that_listens_to_the_repeat_hint_answers_early(runs_dir, fast_config):
    tool = _CountingRecall()
    script = [
        {"action": "tool_call", "tool_name": "recall", "tool_args": {"query": "x"}},
        {"action": "tool_call", "tool_name": "recall", "tool_args": {"query": "x"}},
        {"action": "final_answer", "final_answer": "Nothing stored."},
    ]
    loop = AgentLoop(
        model=build_scripted_model(script), tools={"recall": tool}, config=fast_config, runs_dir=runs_dir
    )
    result = loop.run("what do you remember")

    assert result.status == "completed"
    assert result.final_answer == "Nothing stored."
    assert tool.calls == 1


def test_rephrased_recall_loop_is_capped_and_run_answers(runs_dir, fast_config):
    tool = _CountingRecall()
    n = {"i": 0}

    def _fn(messages, info):
        if not info.function_tools:
            return ModelResponse(parts=[TextPart("I have no service data; I could not build the report.")])
        n["i"] += 1  # a fresh rephrasing every time, so no two calls are identical
        return ModelResponse(parts=[ToolCallPart("recall", {"query": f"fleet health {n['i']}"})])

    loop = AgentLoop(model=FunctionModel(_fn), tools={"recall": tool}, config=fast_config, runs_dir=runs_dir)
    result = loop.run("give me a health report for the fleet")

    assert result.status == "completed"
    assert "could not" in result.final_answer
    assert tool.calls == 3
    assert result.steps_taken < fast_config.max_steps
