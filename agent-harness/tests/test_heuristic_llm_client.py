"""Unit tests for the CLI's zero-API-key default backend, HeuristicMockLLMClient.
Exercises the raw_decide() rule set directly (no AgentLoop involved) so these
stay fast and pinpoint exactly which branch is wrong on failure."""

from __future__ import annotations

from agent_harness.llm_client import HeuristicMockLLMClient
from agent_harness.schemas import LLMDecision


def test_initial_decision_targets_known_service():
    llm = HeuristicMockLLMClient()
    raw = llm.raw_decide("What is the status of payments-api?", [])
    decision = LLMDecision.model_validate(raw)
    assert decision.action == "tool_call"
    assert decision.tool_name == "get_service_status"
    assert decision.tool_args == {"service_name": "payments-api"}


def test_initial_decision_defaults_to_knowledge_base_search():
    llm = HeuristicMockLLMClient()
    raw = llm.raw_decide("Help me understand our escalation policy", [])
    decision = LLMDecision.model_validate(raw)
    assert decision.action == "tool_call"
    assert decision.tool_name == "search_knowledge_base"


def test_reacts_to_approval_denied_with_final_answer():
    llm = HeuristicMockLLMClient()
    history = [
        {
            "event_type": "approval_denied",
            "data": {"tool_name": "create_incident", "args": {}},
        }
    ]
    raw = llm.raw_decide("search-index is down, create an incident", history)
    decision = LLMDecision.model_validate(raw)
    assert decision.action == "final_answer"
    assert "denied" in decision.final_answer.lower()


def test_reacts_to_degraded_status_by_escalating():
    llm = HeuristicMockLLMClient()
    history = [
        {
            "event_type": "tool_call_result",
            "data": {
                "tool_name": "get_service_status",
                "output": {"service_name": "search-index", "status": "down"},
            },
        }
    ]
    raw = llm.raw_decide("search-index is down, please file an incident", history)
    decision = LLMDecision.model_validate(raw)
    assert decision.action == "tool_call"
    assert decision.tool_name == "create_incident"
    assert decision.tool_args["severity"] == "high"
