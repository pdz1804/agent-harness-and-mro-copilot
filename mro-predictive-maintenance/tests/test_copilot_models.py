"""Regression tests for two real bugs found in ``src/copilot/models.py``
(offline-scripted backend), both documented in
``plans/260930-1401-mro-v3-senior-copilot/reports/phase-06-copilot-api-report.md``:

1. ``_stream_route`` used to yield a raw ``ToolCallPart`` instead of the
   ``DeltaToolCalls`` mapping ``FunctionModel.request_stream`` requires,
   which made ``node.stream()`` raise ``UnexpectedModelBehavior`` for any
   offline turn that started with a tool call.
2. ``_route``'s id-extraction regex only matched the leading
   ``<aircraft-id>`` segment of this dataset's compound component ids
   (e.g. ``AC-003-APU_STARTER``), never the full component id.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import asyncio  # noqa: E402

import pytest  # noqa: E402
from pydantic_ai import Agent, RunContext  # noqa: E402
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart  # noqa: E402
from pydantic_ai.models.function import AgentInfo, DeltaToolCall  # noqa: E402

from src.copilot.models import _COMPONENT_ID_RE, _route, _stream_route, build_offline_router  # noqa: E402


def _agent_info() -> AgentInfo:
    return AgentInfo(
        function_tools=[], allow_text_output=True, output_tools=[],
        model_settings=None, model_request_parameters=None, instructions=None,
    )


# -- bug 2: compound component-id extraction -------------------------------

@pytest.mark.parametrize(
    "text,expected",
    [
        ("The pump AC-003-APU_STARTER on aircraft AC-003 looks risky", "AC-003-APU_STARTER"),
        ("Please raise a work order for AC-070-LG_ACTUATOR on AC-070", "AC-070-LG_ACTUATOR"),
        ("check AC-001-BLEED_VALVE-S2 please", "AC-001-BLEED_VALVE-S2"),
        ("check AC-005-HYD_PUMP please", "AC-005-HYD_PUMP"),
    ],
)
def test_component_id_regex_captures_full_compound_id(text, expected):
    match = _COMPONENT_ID_RE.search(text)
    assert match is not None
    assert match.group(1) == expected


def test_route_extracts_full_component_id_for_work_order_prompt():
    prompt = (
        "The hydraulic pump AC-005-HYD_PUMP on aircraft AC-005 looks risky. "
        "Please raise a work order for it."
    )
    messages = [_user_message(prompt)]
    response = _route(messages, _agent_info())
    call = response.parts[0]
    assert call.part_kind == "tool-call"
    assert call.tool_name == "create_work_order"
    assert call.args["component_id"] == "AC-005-HYD_PUMP"
    assert call.args["aircraft_id"] == "AC-005"


def test_route_asks_user_when_compound_id_truly_absent():
    prompt = "Please raise a work order for this pump."
    messages = [_user_message(prompt)]
    response = _route(messages, _agent_info())
    call = response.parts[0]
    assert call.tool_name == "ask_user"


def _user_message(text: str):
    from pydantic_ai.messages import ModelRequest, UserPromptPart

    return ModelRequest(parts=[UserPromptPart(content=text)])


# -- bug 1: stream_function DeltaToolCalls contract ------------------------

def test_stream_route_yields_delta_tool_calls_not_raw_part():
    """``FunctionModel.request_stream``'s documented contract: every yielded
    item must be a ``str`` (text delta) or a ``DeltaToolCalls`` mapping
    (``dict[int, DeltaToolCall]``) -- never a raw ``ToolCallPart``."""
    messages = [_user_message("show me the top risk components")]
    info = _agent_info()

    async def _collect():
        items = []
        async for item in _stream_route(messages, info):
            items.append(item)
        return items

    items = asyncio.run(_collect())
    assert items, "expected at least one streamed item"
    for item in items:
        assert isinstance(item, str) or (
            isinstance(item, dict) and all(isinstance(v, DeltaToolCall) for v in item.values())
        ), f"illegal stream item for FunctionModel.request_stream contract: {item!r}"


def test_offline_router_node_stream_survives_tool_call_turn():
    """End-to-end regression: ``node.stream()`` used to raise
    ``UnexpectedModelBehavior: Exceeded maximum output retries`` for any
    offline-scripted turn that started with a tool call. Drive a real
    ``agent.iter()`` + ``node.stream()`` turn against the offline router and
    assert it completes instead of raising."""
    model = build_offline_router()
    agent = Agent(model, output_type=str)

    @agent.tool
    async def fleet_risk(ctx: RunContext, top_n: int = 5, component_type=None, aircraft_id=None):
        return {"top": []}

    async def _run():
        async with agent.iter("show me the top risk components") as run:
            async for node in run:
                if Agent.is_model_request_node(node):
                    async with node.stream(run.ctx) as stream:
                        async for _event in stream:
                            pass
        return run.result.output

    output = asyncio.run(_run())
    assert isinstance(output, str) and output
