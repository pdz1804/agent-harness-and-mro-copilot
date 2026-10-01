"""Context autocompaction (11d): once a long run's accumulated message
history crosses a small test-only token budget, the loop must fold older
turns into one summary message (via one real extra LLM call against the
same `FunctionModel`) before the next LLM call, record a `context_compacted`
event with real before/after token counts, and demonstrably shrink what the
next call would send."""

from __future__ import annotations

from typing import Any

from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from agent_harness.config import HarnessConfig
from agent_harness.llm_client import decision_to_model_response
from agent_harness.loop import AgentLoop

_SUMMARY_MARKER = "Summarize the earlier part"
_SUMMARY_TEXT = (
    "auth-service has been checked repeatedly and remains degraded; no "
    "incident has been created yet."
)
_TOOL_CALLS_BEFORE_FINAL = 10


def _build_long_run_model() -> FunctionModel:
    """Content-driven double (not `build_scripted_model`'s index-based
    replay, which would misfire against the extra summarization call this
    test intentionally triggers): calls `get_service_status` repeatedly to
    grow real history, answers the harness's summarization prompt on
    request, then gives a final answer."""
    state = {"decisions": 0}

    def _fn(messages: list[Any], info: AgentInfo) -> ModelResponse:
        first_part = messages[0].parts[0] if messages and messages[0].parts else None
        first_content = (
            first_part.content
            if first_part is not None and getattr(first_part, "part_kind", None) == "user-prompt"
            else None
        )
        if isinstance(first_content, str) and first_content.startswith(_SUMMARY_MARKER):
            return ModelResponse(parts=[TextPart(content=_SUMMARY_TEXT)])

        state["decisions"] += 1
        if state["decisions"] <= _TOOL_CALLS_BEFORE_FINAL:
            return decision_to_model_response(
                {
                    "action": "tool_call",
                    "tool_name": "get_service_status",
                    "tool_args": {"service_name": "auth-service"},
                }
            )
        return decision_to_model_response(
            {"action": "final_answer", "final_answer": "auth-service remains degraded; see summary."}
        )

    return FunctionModel(_fn, model_name="long-run-autocompact")


def test_autocompact_fires_with_real_before_after_token_counts(tools, runs_dir):
    llm = _build_long_run_model()
    config = HarnessConfig(
        max_steps=50,
        max_wall_clock_seconds=30.0,
        tool_timeout_seconds=2.0,
        max_tool_retries=0,
        tool_retry_backoff_seconds=0.0,
        max_llm_retries=0,
        # Small enough that repeated get_service_status tool-call/tool-return
        # pairs cross it well before the run's own final_answer, without
        # requiring an unreasonably long script.
        autocompact_token_budget=200,
        autocompact_keep_recent_messages=4,
    )
    loop = AgentLoop(model=llm, tools=tools, config=config, runs_dir=runs_dir)

    result = loop.run("Investigate auth-service and report status")

    assert result.status == "completed"
    assert result.final_answer is not None

    compaction_events = [e for e in result.history if e.event_type == "context_compacted"]
    assert compaction_events, "expected at least one context_compacted event on a long run"

    event = compaction_events[0]
    tokens_before = event.data["tokens_before"]
    tokens_after = event.data["tokens_after"]
    assert isinstance(tokens_before, int) and tokens_before > 0
    assert isinstance(tokens_after, int) and tokens_after > 0
    # Real evidence the compaction actually shrank what the next call sends,
    # not just that the event fired.
    assert tokens_after < tokens_before
    assert tokens_before >= config.autocompact_token_budget
    assert event.data["token_budget"] == config.autocompact_token_budget
    assert event.data["messages_summarized"] > 0
    assert event.data["summary"] == _SUMMARY_TEXT

    # The summarization call itself is a real extra LLM call, on top of the
    # ordinary per-step llm_decision events — confirm both kinds are present.
    assert any(e.event_type == "llm_decision" for e in result.history)
