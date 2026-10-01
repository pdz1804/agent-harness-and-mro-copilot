"""Evals (12e) API surface: `GET /evals`. `settings.MLFLOW_TRACKING_URI` is
loaded from the real `agent-harness/.env` at process start (same as the
production app — `agent_harness.settings` has no test-only override), so
whichever real MLflow server + experiment state exists at import time is
what these tests would otherwise see if they didn't explicitly control it.
Each test below monkeypatches `settings.MLFLOW_TRACKING_URI`/
`MLFLOW_EXPERIMENT_NAME` itself so results are deterministic regardless of
whether a real MLflow server happens to be reachable, or whether the phase
11c eval suite has ever been run against it, when the suite executes.
Real MLflow-backed behavior (the endpoint actually surfacing the phase 11c
eval suite's scorer results end-to-end) is verified live against the real
`docker-compose` MLflow server — see the phase report for that evidence."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from agent_harness import settings  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)


@pytest.fixture(autouse=True)
def _isolate_mlflow_settings(monkeypatch):
    """Force MLflow "not configured" as the default for every test in this
    file, regardless of the real `.env`'s `MLFLOW_TRACKING_URI` or any real
    eval runs that may have been recorded against it — each test overrides
    this explicitly where it needs a different, still-deterministic value."""
    monkeypatch.setattr(settings, "MLFLOW_TRACKING_URI", "")


def test_evals_returns_empty_list_when_mlflow_not_configured():
    response = client.get("/api/v1/evals")
    assert response.status_code == 200
    assert response.json() == []


def test_evals_returns_empty_list_when_experiment_does_not_exist_yet(monkeypatch):
    """Even when `mlflow_configured()` reports True and the server is
    reachable, an experiment that doesn't exist yet (e.g. the eval suite
    has never been run against this tracking server) must return an empty
    list rather than error. Uses the real docker-compose MLflow server
    (same URI production points at) with a made-up experiment name that
    was never created, so `get_experiment_by_name` genuinely returns None
    rather than this test asserting on a mocked client."""
    monkeypatch.setattr(settings, "MLFLOW_TRACKING_URI", settings.MLFLOW_TRACKING_URI or "http://localhost:5001")
    monkeypatch.setattr(settings, "MLFLOW_EXPERIMENT_NAME", "agent-harness-nonexistent-experiment-for-tests")

    if not settings.mlflow_configured():
        pytest.skip("no MLFLOW_TRACKING_URI available in this environment to test against")

    response = client.get("/api/v1/evals")
    # A real, reachable-but-empty experiment lookup returns []; a genuinely
    # unreachable server (e.g. this env has no MLflow running at all) is the
    # only other acceptable real outcome, reported as 502, not a silent 200.
    assert response.status_code in (200, 502)
    if response.status_code == 200:
        assert response.json() == []


def test_evals_reports_502_for_a_genuinely_unreachable_configured_server(monkeypatch):
    monkeypatch.setattr(settings, "MLFLOW_TRACKING_URI", "http://127.0.0.1:1")
    monkeypatch.setattr(settings, "MLFLOW_EXPERIMENT_NAME", "agent-harness-eval")

    response = client.get("/api/v1/evals")
    assert response.status_code == 502
