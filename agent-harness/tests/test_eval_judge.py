"""`agent_harness.eval.judge` tests — `FunctionModel`/`TestModel` doubles
only (see `llm_client.py`'s doubles for the established pattern in this
repo); no network calls in the default suite. One `@pytest.mark.live` test
at the bottom exercises the real OpenAI key from `.env` (skipped unless
`OPENAI_API_KEY` is actually configured)."""

from __future__ import annotations

import pytest
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel

from agent_harness import settings
from agent_harness.eval import judge
from agent_harness.eval.metrics import TraceMetrics, deterministic_metrics


def _history(*events: dict) -> list[dict]:
    return list(events)


def _tool_call_run(with_error: bool = False) -> dict:
    history = [
        {"event_type": "llm_decision", "step": 0, "timestamp": 1.0, "latency_ms": None, "data": {"llm_meta": {"total_tokens": 40}}},
        {
            "event_type": "tool_call_started",
            "step": 0,
            "timestamp": 1.1,
            "latency_ms": None,
            "data": {"tool_name": "get_service_status", "tool_args": {"service_name": "auth-service"}},
        },
    ]
    if with_error:
        history.append(
            {"event_type": "tool_call_error", "step": 0, "timestamp": 1.2, "latency_ms": None, "data": {"tool_name": "get_service_status", "error": "boom"}}
        )
    else:
        history.append(
            {
                "event_type": "tool_call_result",
                "step": 0,
                "timestamp": 1.2,
                "latency_ms": None,
                "data": {"tool_name": "get_service_status", "output": {"status": "operational"}},
            }
        )
    history.append(
        {"event_type": "final_answer", "step": 1, "timestamp": 1.3, "latency_ms": None, "data": {"final_answer": "auth-service is operational."}}
    )
    return {
        "run_id": "run-1",
        "objective": "check auth-service status",
        "agent_id": "agent-1",
        "skill_ids": [],
        "history": history,
    }


# --- compute_judge_version ------------------------------------------------


def test_judge_version_changes_when_prompt_version_changes():
    v1 = judge.compute_judge_version("pv-1", "gpt-4o-mini")
    v2 = judge.compute_judge_version("pv-2", "gpt-4o-mini")
    assert v1 != v2


def test_judge_version_changes_when_model_changes():
    v1 = judge.compute_judge_version("pv-1", "gpt-4o-mini")
    v2 = judge.compute_judge_version("pv-1", "gpt-4o")
    assert v1 != v2


def test_judge_version_stable_for_same_inputs():
    assert judge.compute_judge_version("pv-1", "gpt-4o-mini") == judge.compute_judge_version("pv-1", "gpt-4o-mini")


# --- build_transcript ------------------------------------------------------


def test_build_transcript_includes_objective_tool_call_and_final_answer():
    transcript = judge.build_transcript(_tool_call_run())
    assert "check auth-service status" in transcript
    assert "get_service_status" in transcript
    assert "operational" in transcript
    assert "auth-service is operational." in transcript


def test_build_transcript_truncates_long_tool_results():
    run = _tool_call_run()
    run["history"][2]["data"]["output"] = {"blob": "x" * 5000}
    transcript = judge.build_transcript(run)
    assert "truncated" in transcript


def test_build_transcript_handles_a_validation_error_with_no_started_call():
    # Invalid tool arguments are rejected before the call starts, so the
    # step has a tool_validation_error but no tool_call_started; scoring such
    # a run used to raise KeyError('result').
    run = {
        "objective": "build me a dashboard",
        "history": [
            {"event_type": "tool_validation_error", "step": 1, "data": {"tool_name": "create_dashboard", "args": {"name": "x"}, "error": "config missing"}},
            {"event_type": "tool_call_started", "step": 2, "data": {"tool_name": "create_dashboard", "args": {"name": "x"}}},
            {"event_type": "tool_call_result", "step": 2, "data": {"tool_name": "create_dashboard", "output": {"status": "created"}}},
            {"event_type": "final_answer", "step": 3, "data": {"final_answer": "Created."}},
        ],
    }
    transcript = judge.build_transcript(run)
    assert "create_dashboard(args={'name': 'x'}) -> config missing" in transcript
    assert '"status": "created"' in transcript


def test_build_transcript_includes_skill_routing_when_present():
    run = _tool_call_run()
    run["history"].insert(
        0,
        {
            "event_type": "skill_routed",
            "step": 0,
            "timestamp": 0.5,
            "latency_ms": None,
            "data": {"candidates": ["ops-assistant"], "selected": ["ops-assistant"], "confidence": 0.9, "rationale": "matches"},
        },
    )
    transcript = judge.build_transcript(run)
    assert "Skill routing" in transcript
    assert "ops-assistant" in transcript


# --- run_judge: no model configured (honesty contract) --------------------


def test_run_judge_returns_unavailable_rows_with_no_model():
    verdict, rows = judge.run_judge(_tool_call_run(), model=None, judge_version="jv-test")
    assert verdict is None
    metrics_seen = {r.metric for r in rows}
    assert metrics_seen == {"task_success", "groundedness", "tool_choice"}
    for row in rows:
        assert row.status == "unavailable"
        assert row.score is None


def test_run_judge_includes_routing_fit_when_run_has_skill_routed_event_even_with_no_model():
    run = _tool_call_run()
    run["history"].insert(
        0, {"event_type": "skill_routed", "step": 0, "timestamp": 0.5, "latency_ms": None, "data": {"selected": ["x"]}}
    )
    verdict, rows = judge.run_judge(run, model=None, judge_version="jv-test")
    assert "routing_fit" in {r.metric for r in rows}


# --- run_judge: FunctionModel double (structured output) ------------------


def _verdict_function_model(verdict_kwargs: dict) -> FunctionModel:
    def _fn(messages, info: AgentInfo) -> ModelResponse:
        output_tools = getattr(info, "output_tools", None) or []
        tool_name = output_tools[0].name if output_tools else "final_result"
        return ModelResponse(parts=[ToolCallPart(tool_name=tool_name, args=dict(verdict_kwargs))])

    return FunctionModel(_fn, model_name="judge-double")


def test_run_judge_with_function_model_returns_scored_rows():
    model = _verdict_function_model(
        {
            "task_success": 5,
            "task_success_rationale": "fully resolved",
            "groundedness": 4,
            "groundedness_rationale": "supported by tool result",
            "tool_choice": 5,
            "tool_choice_rationale": "correct single call",
            "safety_ok": True,
            "safety_rationale": "no guardrail issues",
        }
    )
    verdict, rows = judge.run_judge(_tool_call_run(), model=model, judge_version="jv-test")
    assert verdict is not None
    by_metric = {r.metric: r for r in rows}
    assert by_metric["task_success"].score == 1.0
    assert by_metric["task_success"].status == "scored"
    assert by_metric["groundedness"].score == pytest.approx(0.75)  # (4-1)/4
    assert by_metric["tool_choice"].score == 1.0
    assert "routing_fit" not in by_metric  # no skill_routed event in this run


def test_run_judge_groundedness_none_from_verdict_is_marked_unavailable_not_fabricated():
    model = _verdict_function_model(
        {
            "task_success": 3,
            "task_success_rationale": "partially resolved",
            "groundedness": None,
            "tool_choice": 3,
            "tool_choice_rationale": "ok",
            "safety_ok": True,
            "safety_rationale": "fine",
        }
    )
    _, rows = judge.run_judge(_tool_call_run(), model=model, judge_version="jv-test")
    groundedness = next(r for r in rows if r.metric == "groundedness")
    assert groundedness.score is None
    assert groundedness.status == "unavailable"


def test_run_judge_malformed_output_returns_error_rows_run_continues():
    def _fn(messages, info: AgentInfo) -> ModelResponse:
        from pydantic_ai.messages import TextPart

        # Not a structured tool call at all -> pydantic-ai cannot coerce
        # this into JudgeVerdict, simulating a genuinely malformed response.
        return ModelResponse(parts=[TextPart(content="not a valid structured verdict")])

    model = FunctionModel(_fn, model_name="malformed-judge")
    verdict, rows = judge.run_judge(_tool_call_run(), model=model, judge_version="jv-test")
    assert verdict is None
    assert rows, "a malformed judge response must still produce rows, not raise"
    for row in rows:
        assert row.status == "error"
        assert row.score is None


def test_run_judge_test_model_smoke():
    """`TestModel` (auto-generates *some* structured output matching
    `JudgeVerdict`'s schema) as a cheap sanity check that the agent
    construction itself (system prompt + output_type) is wired correctly,
    independent of any specific scripted verdict."""
    verdict, rows = judge.run_judge(_tool_call_run(), model=TestModel(), judge_version="jv-test")
    assert verdict is not None
    assert any(r.metric == "task_success" for r in rows)


# --- merge_metric_rows ------------------------------------------------------


def test_merge_metric_rows_hybrid_tool_use_correctness_rule_only_when_no_judge():
    run = _tool_call_run(with_error=True)
    trace_metrics = deterministic_metrics(run["history"])
    _, judge_rows = judge.run_judge(run, model=None, judge_version="jv-test")
    rows = judge.merge_metric_rows(trace_metrics, None, judge_rows, "jv-test")
    tool_use = next(r for r in rows if r.metric == "tool_use_correctness")
    assert tool_use.score == pytest.approx(0.75)  # 1 error -> 1.0 - 0.25
    assert "rule-only" in tool_use.rationale


def test_merge_metric_rows_hybrid_tool_use_correctness_averages_rule_and_judge():
    run = _tool_call_run()  # zero tool errors -> rule score 1.0
    trace_metrics = deterministic_metrics(run["history"])
    model = _verdict_function_model(
        {
            "task_success": 5,
            "task_success_rationale": "x",
            "groundedness": 5,
            "groundedness_rationale": "x",
            "tool_choice": 3,  # judge score (3-1)/4 = 0.5
            "tool_choice_rationale": "so-so",
            "safety_ok": True,
            "safety_rationale": "x",
        }
    )
    verdict, judge_rows = judge.run_judge(run, model=model, judge_version="jv-test")
    rows = judge.merge_metric_rows(trace_metrics, verdict, judge_rows, "jv-test")
    tool_use = next(r for r in rows if r.metric == "tool_use_correctness")
    assert tool_use.score == pytest.approx((1.0 + 0.5) / 2.0)


def test_merge_metric_rows_includes_deterministic_raw_value_rows():
    run = _tool_call_run()
    trace_metrics = deterministic_metrics(run["history"])
    _, judge_rows = judge.run_judge(run, model=None, judge_version="jv-test")
    rows = judge.merge_metric_rows(trace_metrics, None, judge_rows, "jv-test")
    by_metric = {r.metric: r for r in rows}
    assert by_metric["total_tokens"].score == float(trace_metrics.total_tokens)
    assert by_metric["steps"].score == float(trace_metrics.steps)
    assert by_metric["tool_errors"].score == float(trace_metrics.tool_errors)
    assert by_metric["latency_ms"].score == trace_metrics.latency_ms
    assert by_metric["agent_latency_ms"].score == trace_metrics.agent_latency_ms


def test_merge_metric_rows_safety_hybrid_averages_with_judge_bool():
    run = _tool_call_run()
    trace_metrics = TraceMetrics(guardrail_triggers=1)  # rule score 0.75
    model = _verdict_function_model(
        {
            "task_success": 5,
            "task_success_rationale": "x",
            "groundedness": 5,
            "groundedness_rationale": "x",
            "tool_choice": 5,
            "tool_choice_rationale": "x",
            "safety_ok": False,  # judge score 0.0
            "safety_rationale": "flagged an issue",
        }
    )
    verdict, judge_rows = judge.run_judge(run, model=model, judge_version="jv-test")
    rows = judge.merge_metric_rows(trace_metrics, verdict, judge_rows, "jv-test")
    safety = next(r for r in rows if r.metric == "safety")
    assert safety.score == pytest.approx(0.375)  # (0.75 + 0.0) / 2


def test_merge_metric_rows_idempotent_same_inputs_same_outputs():
    run = _tool_call_run()
    trace_metrics = deterministic_metrics(run["history"])
    _, judge_rows = judge.run_judge(run, model=None, judge_version="jv-test")
    rows_a = judge.merge_metric_rows(trace_metrics, None, judge_rows, "jv-test")
    rows_b = judge.merge_metric_rows(trace_metrics, None, judge_rows, "jv-test")
    assert [r.model_dump() for r in rows_a] == [r.model_dump() for r in rows_b]


# --- live: real OpenAI key, no mocking --------------------------------------


@pytest.mark.live
def test_run_judge_live_against_real_openai_key():
    if not settings.llm_configured():
        pytest.skip("OPENAI_API_KEY not configured in this environment")

    from agent_harness.llm_client import build_openai_model

    model = build_openai_model()
    run = _tool_call_run()
    judge_version = judge.compute_judge_version(None, settings.OPENAI_MODEL)
    verdict, rows = judge.run_judge(run, model=model, judge_version=judge_version)
    assert verdict is not None
    assert 1 <= verdict.task_success <= 5
    assert isinstance(verdict.safety_ok, bool)
    by_metric = {r.metric: r for r in rows}
    assert by_metric["task_success"].status == "scored"
    assert by_metric["task_success"].score is not None
