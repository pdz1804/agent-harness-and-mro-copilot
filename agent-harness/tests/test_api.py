"""Smoke tests for the FastAPI wrapper (POST /run). Uses the real
HeuristicMockLLMClient the API wires up by default, so assertions stay at
the level of "did the run complete / respect auto_approve" rather than
asserting on exact heuristic phrasing."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# api.py lives at the project root (sibling of tests/), not under src/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import api  # noqa: E402
from agent_harness.llm_client import HeuristicMockLLMClient  # noqa: E402
from api import app  # noqa: E402


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    """api.py's AgentLoop uses the default cwd-relative `runs/` dir; chdir
    into a tmp dir so these tests never write into the project's real
    runs/ directory."""
    monkeypatch.chdir(tmp_path)


@pytest.fixture(autouse=True)
def _use_heuristic_llm(monkeypatch):
    """The API's default LLM backend requires OPENAI_API_KEY (see
    api._default_llm_client). Tests inject the deterministic
    HeuristicMockLLMClient instead, exactly as the phase-06 spec requires:
    'HeuristicMockLLMClient stays ONLY as a deterministic test double for CI'."""
    monkeypatch.setattr(api, "_llm_client_factory", lambda: HeuristicMockLLMClient())


client = TestClient(app)


def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "llm_configured" in body


def test_run_endpoint_happy_path():
    response = client.post(
        "/run",
        json={"objective": "What is the status of auth-service?", "max_steps": 5},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "completed"
    assert body["final_answer"] is not None
    assert isinstance(body["history"], list)
    assert len(body["history"]) > 0


def test_run_endpoint_approval_required_case_denied_by_default():
    response = client.post(
        "/run",
        json={
            "objective": "search-index is down, please create an incident",
            "max_steps": 6,
        },
    )
    assert response.status_code == 200
    body = response.json()
    event_types = [e["event_type"] for e in body["history"]]
    assert "approval_requested" in event_types
    assert "approval_denied" in event_types
    assert "tool_call_started" not in [
        e["event_type"] for e in body["history"] if e["data"].get("tool_name") == "create_incident"
    ]


def test_run_endpoint_approval_required_case_auto_approved():
    response = client.post(
        "/run",
        json={
            "objective": "search-index is down, please create an incident",
            "auto_approve": True,
            "max_steps": 6,
        },
    )
    assert response.status_code == 200
    body = response.json()
    event_types = [e["event_type"] for e in body["history"]]
    assert "approval_granted" in event_types
    incident_results = [
        e for e in body["history"]
        if e["event_type"] == "tool_call_result" and e["data"].get("tool_name") == "create_incident"
    ]
    assert len(incident_results) == 1
    assert incident_results[0]["data"]["output"]["status"] == "created"


def test_run_endpoint_rejects_blank_objective():
    response = client.post("/run", json={"objective": "   "})
    assert response.status_code == 422
