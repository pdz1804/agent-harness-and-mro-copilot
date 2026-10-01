"""Unit tests for `agent_harness.eval.metrics` — pure functions over
crafted, real-shaped event lists (no DB, no network). Each event mirrors
exactly the shape `db.get_run(...)["history"]` produces: `event_type`,
`step`, `timestamp` (epoch seconds), `latency_ms`, `data`."""

from __future__ import annotations

from agent_harness.eval.metrics import (
    TraceMetrics,
    deterministic_metrics,
    safety_rule_score,
    tool_use_correctness_rule_score,
)


def _event(event_type: str, step: int, timestamp: float, data: dict | None = None) -> dict:
    return {
        "event_type": event_type,
        "step": step,
        "timestamp": timestamp,
        "latency_ms": None,
        "data": data or {},
    }


def test_empty_history_returns_all_zero_metrics():
    metrics = deterministic_metrics([])
    assert metrics == TraceMetrics()
    assert metrics.approval_outcome is None
    assert metrics.terminal_event_type is None


def test_latency_is_span_between_first_and_last_event_timestamp():
    history = [
        _event("llm_decision", 0, 100.0),
        _event("tool_call_started", 0, 100.5),
        _event("tool_call_result", 0, 101.2),
        _event("final_answer", 1, 102.75),
    ]
    metrics = deterministic_metrics(history)
    assert metrics.latency_ms == (102.75 - 100.0) * 1000.0


def test_agent_latency_equals_wall_clock_when_no_approval_gate():
    history = [
        _event("llm_decision", 0, 100.0),
        _event("tool_call_started", 0, 100.5),
        _event("final_answer", 1, 101.0),
    ]
    metrics = deterministic_metrics(history)
    assert metrics.agent_latency_ms == metrics.latency_ms == 1000.0


def test_agent_latency_excludes_approval_wait_span():
    history = [
        _event("llm_decision", 0, 100.0),
        _event("approval_requested", 0, 100.5),
        _event("approval_granted", 0, 105.5),  # 5s human wait
        _event("tool_call_result", 0, 105.6),
        _event("final_answer", 1, 106.0),
    ]
    metrics = deterministic_metrics(history)
    assert metrics.latency_ms == (106.0 - 100.0) * 1000.0
    assert metrics.agent_latency_ms == metrics.latency_ms - 5000.0


def test_agent_latency_excludes_multiple_approval_wait_spans_and_floors_at_zero():
    history = [
        _event("approval_requested", 0, 0.0),
        _event("approval_denied", 0, 10.0),
        _event("approval_requested", 1, 10.0),
        _event("approval_granted", 1, 20.0),
    ]
    metrics = deterministic_metrics(history)
    assert metrics.latency_ms == 20000.0
    assert metrics.agent_latency_ms == 0.0


def test_tokens_summed_only_from_llm_decision_events_with_llm_meta():
    history = [
        _event("llm_decision", 0, 1.0, {"llm_meta": {"total_tokens": 120}}),
        _event("tool_call_started", 0, 1.1),
        _event("llm_decision", 1, 1.2, {"llm_meta": {"total_tokens": 80}}),
        _event("llm_decision", 2, 1.3, {}),  # no llm_meta (e.g. scripted test double)
        _event("final_answer", 2, 1.4),
    ]
    metrics = deterministic_metrics(history)
    assert metrics.total_tokens == 200


def test_steps_counts_distinct_step_values_not_event_count():
    history = [
        _event("llm_decision", 0, 1.0),
        _event("tool_call_started", 0, 1.1),
        _event("tool_call_result", 0, 1.2),
        _event("llm_decision", 1, 1.3),
        _event("final_answer", 1, 1.4),
    ]
    metrics = deterministic_metrics(history)
    assert metrics.steps == 2


def test_tool_errors_counts_error_timeout_validation_and_retries_exhausted():
    history = [
        _event("tool_call_started", 0, 1.0),
        _event("tool_call_error", 0, 1.1),
        _event("tool_call_started", 1, 1.2),
        _event("tool_call_timeout", 1, 1.3),
        _event("tool_validation_error", 2, 1.4),
        _event("tool_call_retries_exhausted", 3, 1.5),
        # A bare retry (not yet exhausted) is not itself a failure.
        _event("tool_call_retry", 4, 1.6),
        _event("final_answer", 5, 1.7),
    ]
    metrics = deterministic_metrics(history)
    assert metrics.tool_errors == 4
    assert metrics.tool_calls == 2  # only 2 tool_call_started events


def test_guardrail_triggers_counts_blocked_and_downgraded():
    history = [
        _event("guardrail_blocked", 0, 1.0),
        _event("guardrail_severity_downgraded", 1, 1.1),
        _event("final_answer", 2, 1.2),
    ]
    metrics = deterministic_metrics(history)
    assert metrics.guardrail_triggers == 2


def test_approval_outcome_none_when_never_requested():
    history = [_event("tool_call_started", 0, 1.0), _event("final_answer", 1, 1.1)]
    assert deterministic_metrics(history).approval_outcome is None


def test_approval_outcome_granted_overrides_requested():
    history = [
        _event("approval_requested", 0, 1.0),
        _event("approval_granted", 0, 1.1),
        _event("tool_call_result", 0, 1.2),
        _event("final_answer", 1, 1.3),
    ]
    assert deterministic_metrics(history).approval_outcome == "granted"


def test_approval_outcome_denied():
    history = [
        _event("approval_requested", 0, 1.0),
        _event("approval_denied", 0, 1.1),
    ]
    assert deterministic_metrics(history).approval_outcome == "denied"


def test_terminal_event_type_is_last_terminal_event_seen():
    history = [
        _event("llm_decision", 0, 1.0),
        _event("step_limit_exceeded", 5, 1.5),
    ]
    assert deterministic_metrics(history).terminal_event_type == "step_limit_exceeded"


def test_non_int_step_values_are_ignored_defensively():
    history = [
        {"event_type": "llm_decision", "step": None, "timestamp": 1.0, "latency_ms": None, "data": {}},
        _event("final_answer", 0, 1.1),
    ]
    metrics = deterministic_metrics(history)
    assert metrics.steps == 1


# --- hybrid rule-score halves -------------------------------------------


def test_tool_use_correctness_na_when_no_tool_calls():
    metrics = TraceMetrics(tool_calls=0, tool_errors=0)
    assert tool_use_correctness_rule_score(metrics) is None


def test_tool_use_correctness_perfect_with_zero_errors():
    metrics = TraceMetrics(tool_calls=3, tool_errors=0)
    assert tool_use_correctness_rule_score(metrics) == 1.0


def test_tool_use_correctness_degrades_per_error_floored_at_zero():
    metrics = TraceMetrics(tool_calls=3, tool_errors=2)
    assert tool_use_correctness_rule_score(metrics) == 0.5
    metrics_many_errors = TraceMetrics(tool_calls=3, tool_errors=10)
    assert tool_use_correctness_rule_score(metrics_many_errors) == 0.0


def test_safety_rule_score_perfect_with_zero_guardrail_triggers():
    assert safety_rule_score(TraceMetrics(guardrail_triggers=0)) == 1.0


def test_safety_rule_score_degrades_per_trigger_floored_at_zero():
    assert safety_rule_score(TraceMetrics(guardrail_triggers=1)) == 0.75
    assert safety_rule_score(TraceMetrics(guardrail_triggers=10)) == 0.0


def test_deterministic_metrics_is_pure_same_input_same_output():
    history = [
        _event("llm_decision", 0, 1.0, {"llm_meta": {"total_tokens": 50}}),
        _event("tool_call_started", 0, 1.1),
        _event("tool_call_result", 0, 1.2),
        _event("final_answer", 1, 1.3),
    ]
    assert deterministic_metrics(history) == deterministic_metrics(history)
