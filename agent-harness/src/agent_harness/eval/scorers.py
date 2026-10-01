"""Outcome extraction + `mlflow.genai` scorers for recorded transcripts.

`classify_outcome` turns a saved `RunResult` (as captured by
`capture_transcripts.py`) into a small, comparable outcome dict — the same
shape `expected` fixtures use — so scoring is a straightforward equality
check rather than re-parsing history event-by-event inside every scorer.
"""

from __future__ import annotations

from typing import Any

from mlflow.genai.scorers import scorer


def classify_outcome(run_result: dict[str, Any]) -> dict[str, Any]:
    """Derive {"status", "escalated", "approval_denied"} from one saved
    `RunResult.model_dump()`-shaped dict.

    - `status`: the loop's own terminal status (`completed`,
      `step_limit_exceeded`, `time_limit_exceeded`, `llm_error_exceeded`).
    - `escalated`: True iff `create_incident` actually executed
      (a `tool_call_result` event for it), not merely attempted.
    - `approval_denied`: True iff any `approval_denied` event occurred.
    """
    history = run_result.get("history", [])
    escalated = any(
        event.get("event_type") == "tool_call_result" and event.get("data", {}).get("tool_name") == "create_incident"
        for event in history
    )
    approval_denied = any(event.get("event_type") == "approval_denied" for event in history)
    return {
        "status": run_result.get("status"),
        "escalated": escalated,
        "approval_denied": approval_denied,
    }


@scorer(name="status_matches_expected")
def status_matches_expected(outputs: dict[str, Any], expectations: dict[str, Any]) -> bool:
    """Pass iff the run's terminal status matches the expected status
    (e.g. a scenario meant to hit the step limit actually did, rather than
    silently completing normally)."""
    return outputs.get("status") == expectations.get("status")


@scorer(name="escalation_decision_matches_expected")
def escalation_decision_matches_expected(outputs: dict[str, Any], expectations: dict[str, Any]) -> bool:
    """Pass iff whether the agent actually executed `create_incident`
    matches whether the scenario expected an escalation."""
    return outputs.get("escalated") == expectations.get("escalated")


@scorer(name="approval_denial_handled_as_expected")
def approval_denial_handled_as_expected(outputs: dict[str, Any], expectations: dict[str, Any]) -> bool:
    """Pass iff whether an approval was denied during the run matches the
    scenario's expectation. Most scenarios expect no denial at all
    (`False`); the approval-gate scenario expects `True`."""
    return outputs.get("approval_denied") == expectations.get("approval_denied")
