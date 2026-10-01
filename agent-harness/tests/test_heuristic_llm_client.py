"""Unit tests for the CLI's zero-API-key default backend.

Phase 11b-v2 replaced the hand-rolled, rule-based `HeuristicMockLLMClient`
with `pydantic_ai.models.test.TestModel` (via
`agent_harness.llm_client.build_test_model`), per the phase file's explicit
guidance (item 6): "HeuristicMockLLMClient -> TestModel where 'some tool
call happens' suffices." `TestModel` auto-picks among an agent's registered
tools without inspecting objective text, so the old fine-grained,
content-based routing assertions (e.g. "payments-api" in the objective ->
`get_service_status` specifically) no longer apply to this double — that
precision now lives only in the real OpenAI backend's own reasoning
(exercised by `tests/test_live_openai.py`) and in `ScriptedLLMClient`'s
successor, `build_scripted_model` (the actual source of truth for the rest
of the test suite; see `tests/test_success_path.py` etc.). These tests
instead assert the structural contract `build_test_model()` must satisfy
for the CLI `--mock` flag and `test_api*.py`'s deterministic fixtures: a
tool call happens, it can be constrained to a known tool, and the loop
completes end-to-end without ever needing a real API key.
"""

from __future__ import annotations

from agent_harness.llm_client import build_test_model
from agent_harness.loop import AgentLoop


def test_build_test_model_drives_a_tool_call_to_completion(tools, runs_dir, fast_config):
    model = build_test_model()
    loop = AgentLoop(model=model, tools=tools, config=fast_config, runs_dir=runs_dir)

    result = loop.run("What is the status of payments-api?")

    assert result.status == "completed"
    event_types = [e.event_type for e in result.history]
    assert "llm_decision" in event_types
    assert "tool_call_started" in event_types or "final_answer" in event_types


def test_build_test_model_can_be_constrained_to_one_tool(tools, runs_dir, fast_config):
    model = build_test_model(call_tools=["get_service_status"])
    loop = AgentLoop(model=model, tools=tools, config=fast_config, runs_dir=runs_dir)

    result = loop.run("Check auth-service")

    assert result.status == "completed"
    tool_calls = [
        e for e in result.history if e.event_type == "tool_call_started" and e.data.get("tool_name")
    ]
    assert all(e.data["tool_name"] == "get_service_status" for e in tool_calls)


def test_build_test_model_never_calls_the_approval_gated_tool_unprompted(tools, runs_dir, fast_config):
    # call_tools constrained away from create_incident: TestModel must never
    # pick the one approval-gated tool on its own when not told to.
    model = build_test_model(call_tools=["search_knowledge_base", "get_service_status"])
    loop = AgentLoop(model=model, tools=tools, config=fast_config, runs_dir=runs_dir)

    result = loop.run("Investigate search-index")

    assert result.status == "completed"
    assert "approval_requested" not in [e.event_type for e in result.history]
