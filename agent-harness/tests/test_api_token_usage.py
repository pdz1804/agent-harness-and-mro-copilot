"""`GET /runs/{run_id}/tokens` and `GET /usage/today` (11d): real Postgres
`SUM`/`COUNT` aggregation over the persisted `events` table's `llm_decision`
rows, not client-side summing. Uses a `FunctionModel` double that reports
real, distinct `RequestUsage` token counts per call (unlike
`build_routing_model`, which never sets `usage` and would only ever
exercise the all-zero path) so the assertions verify actual arithmetic
against hand-computed expected totals."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.usage import RequestUsage

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import state  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

_POLL_TIMEOUT_SECONDS = 5.0
_POLL_INTERVAL_SECONDS = 0.02


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


def _fixed_usage_model(prompt_tokens: int, completion_tokens: int) -> FunctionModel:
    """One tool_call decision (get_service_status) with a known,
    hand-computed token usage, then a final_answer with the same usage per
    call — two llm_decision events per run, each carrying identical known
    `llm_meta`, so the expected aggregate total is exactly
    `2 * (prompt_tokens + completion_tokens)`."""
    state = {"n": 0}

    def _fn(messages: list[Any], info: AgentInfo) -> ModelResponse:
        state["n"] += 1
        usage = RequestUsage(input_tokens=prompt_tokens, output_tokens=completion_tokens)
        if state["n"] == 1:
            return ModelResponse(
                parts=[ToolCallPart(tool_name="get_service_status", args={"service_name": "auth-service"})],
                usage=usage,
            )
        return ModelResponse(parts=[TextPart(content="auth-service checked.")], usage=usage)

    return FunctionModel(_fn, model_name="fixed-usage")


def _wait_for_status(run_id: str, *targets: str) -> dict:
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    body: dict = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/runs/{run_id}")
        assert response.status_code == 200
        body = response.json()
        if body["status"] in targets:
            return body
        time.sleep(_POLL_INTERVAL_SECONDS)
    raise AssertionError(f"run {run_id} did not reach status in {targets} within timeout; last body: {body}")


def _start_run_with_fixed_usage(monkeypatch, prompt_tokens: int, completion_tokens: int) -> str:
    monkeypatch.setattr(state, "llm_client_factory", lambda: _fixed_usage_model(prompt_tokens, completion_tokens))
    response = client.post(
        "/api/v1/runs", json={"objective": "What is the status of auth-service?", "max_steps": 5}
    )
    assert response.status_code == 202
    run_id = response.json()["run_id"]
    _wait_for_status(run_id, "completed")
    return run_id


def test_run_tokens_aggregates_real_persisted_events(monkeypatch):
    run_id = _start_run_with_fixed_usage(monkeypatch, prompt_tokens=50, completion_tokens=10)

    response = client.get(f"/api/v1/runs/{run_id}/tokens")
    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == run_id
    # Exactly 2 llm_decision events (tool_call then final_answer), each with
    # the same known usage — hand-computed expected totals.
    assert body["llm_calls"] == 2
    assert body["prompt_tokens"] == 100
    assert body["completion_tokens"] == 20
    assert body["total_tokens"] == 120

    # Spot-check against the raw events table directly (not just re-trusting
    # the endpoint's own SQL).
    from agent_harness import db

    row = db.get_run(run_id)
    llm_events = [e for e in row["history"] if e["event_type"] == "llm_decision"]
    assert len(llm_events) == 2
    raw_total = sum(e["data"]["llm_meta"]["total_tokens"] for e in llm_events)
    assert raw_total == body["total_tokens"]


def test_run_tokens_unknown_run_id_returns_404():
    response = client.get("/api/v1/runs/does-not-exist/tokens")
    assert response.status_code == 404


def test_usage_today_aggregates_across_runs(monkeypatch):
    run_id_1 = _start_run_with_fixed_usage(monkeypatch, prompt_tokens=30, completion_tokens=5)
    run_id_2 = _start_run_with_fixed_usage(monkeypatch, prompt_tokens=40, completion_tokens=5)

    response = client.get("/api/v1/usage/today")
    assert response.status_code == 200
    body = response.json()

    # Other tests in the same session/db may also have persisted runs today
    # (each test truncates before it runs, not after — see conftest.py), so
    # assert the two runs just created are fully reflected, not an exact
    # process-wide total.
    from agent_harness import db

    tokens_run_1 = db.aggregate_run_tokens(run_id_1)
    tokens_run_2 = db.aggregate_run_tokens(run_id_2)
    expected_min_total = tokens_run_1["total_tokens"] + tokens_run_2["total_tokens"]
    expected_min_calls = tokens_run_1["llm_calls"] + tokens_run_2["llm_calls"]

    assert body["total_tokens"] >= expected_min_total
    assert body["llm_calls"] >= expected_min_calls
    assert body["run_count"] >= 2
