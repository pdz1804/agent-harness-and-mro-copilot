"""Guardrails test sandbox: type an input, see which rule fires and why (the exact
logic the loop enforces), and the trigger history linked to runs."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import state  # noqa: E402
from agent_harness.llm_client import build_test_model  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

ADMIN = {"X-User-Id": "u_admin"}
EDITOR = {"X-User-Id": "u_editor"}
EDITOR2 = {"X-User-Id": "u_editor2"}
VIEWER = {"X-User-Id": "u_viewer"}


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


def _add_pattern_rule(patterns: list[str], enabled: bool = True, name: str = "No wipes") -> dict:
    response = client.post(
        "/api/v1/guardrails",
        json={"name": name, "kind": "objective_pattern_block", "config": {"patterns": patterns}, "enabled": enabled},
        headers=ADMIN,
    )
    assert response.status_code == 201
    return response.json()


def _test(text: str, **extra) -> dict:
    response = client.post("/api/v1/guardrails/test", json={"text": text, **extra}, headers=VIEWER)
    assert response.status_code == 200, response.text
    return response.json()


def _by_kind(result: dict, kind: str) -> list[dict]:
    return [c for c in result["checks"] if c["kind"] == kind]


def test_a_banned_pattern_fires_and_explains_which_one() -> None:
    rule = _add_pattern_rule(["drop table", "rm -rf"])
    result = _test("please DROP TABLE incidents right now")
    assert result["blocked"] is True
    check = next(c for c in _by_kind(result, "objective_pattern_block") if c["guardrail_id"] == rule["id"])
    assert check["fired"] is True and check["matched_pattern"] == "drop table"
    assert "drop table" in check["reason"] and "blocked" in check["reason"]


def test_clean_text_fires_nothing() -> None:
    _add_pattern_rule(["drop table"])
    result = _test("what is the status of auth-service?")
    assert result["blocked"] is False
    assert all(not c["fired"] for c in result["checks"])
    assert any("no banned pattern" in c["reason"] for c in _by_kind(result, "objective_pattern_block"))


def test_a_disabled_rule_reports_the_match_but_does_not_fire() -> None:
    rule = _add_pattern_rule(["secret-word"], enabled=False)
    result = _test("this has the secret-word inside")
    check = next(c for c in result["checks"] if c["guardrail_id"] == rule["id"])
    assert check["fired"] is False and check["matched_pattern"] == "secret-word" and "disabled" in check["reason"]
    assert result["blocked"] is False


def test_a_rule_without_patterns_says_it_can_never_match() -> None:
    _add_pattern_rule([], name="Empty rule")
    check = next(c for c in _test("anything at all")["checks"] if c["name"] == "Empty rule")
    assert check["fired"] is False and "no patterns" in check["reason"]


def test_severity_cap_is_not_applicable_without_a_severity() -> None:
    cap = _by_kind(_test("hello"), "severity_upgrade_block")[0]
    assert cap["fired"] is False and "not applicable" in cap["reason"]


@pytest.mark.parametrize(
    ("evidence", "fires"),
    [(None, True), ("operational", True), ("degraded", True), ("down", False)],
)
def test_severity_cap_matches_the_loops_rule(evidence, fires) -> None:
    extra = {"severity": "critical"}
    if evidence:
        extra["evidence_status"] = evidence
    result = _test("open an incident", **extra)
    cap = _by_kind(result, "severity_upgrade_block")[0]
    assert cap["fired"] is fires
    assert result["severity_downgraded_to"] == ("high" if fires else None)
    assert cap["reason"]


def test_non_critical_severity_is_left_alone() -> None:
    result = _test("open an incident", severity="high", evidence_status="operational")
    assert _by_kind(result, "severity_upgrade_block")[0]["fired"] is False
    assert result["severity_downgraded_to"] is None


def test_sandbox_validates_input_and_persists_nothing() -> None:
    assert client.post("/api/v1/guardrails/test", json={"text": ""}, headers=VIEWER).status_code == 422
    assert client.post("/api/v1/guardrails/test", json={"text": "x", "severity": "huge"}, headers=VIEWER).status_code == 422
    _add_pattern_rule(["boom"])
    _test("boom")
    assert client.get("/api/v1/guardrails/triggers", headers=ADMIN).json() == []
    assert client.get("/api/v1/sessions", headers=ADMIN).json() == []


def test_sandbox_and_a_real_run_agree(monkeypatch) -> None:
    _add_pattern_rule(["forbidden phrase"])
    text = "do the forbidden phrase thing"
    assert _test(text)["blocked"] is True
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_test_model(call_tools="all"))
    started = client.post("/api/v1/runs", json={"objective": text}, headers=EDITOR)
    run_id = started.json()["run_id"]
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        body = client.get(f"/api/v1/runs/{run_id}", headers=EDITOR).json()
        if body["status"] != "running":
            break
        time.sleep(0.02)
    assert body["status"] == "guardrail_blocked"


def test_trigger_history_links_to_the_run_and_is_owner_scoped(monkeypatch) -> None:
    _add_pattern_rule(["forbidden phrase"])
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_test_model(call_tools="all"))
    objective = "do the forbidden phrase thing"
    run_id = client.post("/api/v1/runs", json={"objective": objective}, headers=EDITOR).json()["run_id"]
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and not client.get("/api/v1/guardrails/triggers", headers=EDITOR).json():
        time.sleep(0.05)
    triggers = client.get("/api/v1/guardrails/triggers", headers=EDITOR).json()
    assert triggers[0]["run_id"] == run_id and triggers[0]["objective"] == objective
    assert triggers[0]["event_type"] == "guardrail_blocked"
    assert client.get("/api/v1/guardrails/triggers", headers=EDITOR2).json() == []
