"""Scripted end-to-end scenario test (phase 08): drives the real HTTP API
(FastAPI ``TestClient``, no mocks) through the full v3 story in one pass --

    fleet-scan -> alert -> automation triage run -> ask_user resolution
    -> approval (viewer 403, then lead) -> exactly one work order
    -> drift (unshifted no-alert, simulate=shift alert) -> KB search

Offline scripted model by default (``test_e2e_full_scenario_offline``);
the same scenario against a real OpenAI backend is
``test_e2e_full_scenario_live`` (``@pytest.mark.live``, requires
``OPENAI_API_KEY`` and skips automatically otherwise -- same pattern as
``tests/test_copilot_hitl.py``). Every assertion drives/reads the real
router code paths; nothing here is hand-mocked.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from src import config  # noqa: E402
from src.service.app import app  # noqa: E402

pytestmark = pytest.mark.e2e


def _client_factory(tmp_path, monkeypatch):
    if not config.MODEL_CARD_JSON.exists():
        pytest.skip("reports/model_card.json missing -- run `python -m src.pipeline` first")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'ops.db'}")
    return TestClient(app)


def _wait_for_status(client, run_id, statuses, timeout=30.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        resp = client.get(f"/copilot/runs/{run_id}")
        assert resp.status_code == 200
        last = resp.json()
        if last["status"] in statuses:
            return last
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} did not reach {statuses} within {timeout}s (last={last})")


def _run_full_scenario(client: TestClient, *, strict_ask_user: bool = True) -> None:
    # 1. fleet-scan -> alert(s) -> automation triage run(s) started, never an
    #    auto-created work order (acceptance criterion 11).
    scan = client.post("/copilot/fleet-scan", json={"window_days": 30})
    assert scan.status_code == 200
    scan_body = scan.json()
    assert scan_body["scored"] > 0
    assert scan_body["new_alerts"], "expected fleet-scan to open at least one alert on a fresh db"
    assert scan_body["automation_runs"], "expected at least one automation-triggered triage run"

    alerts = client.get("/ops/alerts").json()
    assert len(alerts) == len(scan_body["new_alerts"])

    wos_before = client.get("/ops/work-orders").json()
    assert wos_before == [], "no work order may exist before a human approves anything"

    automation_entry = scan_body["automation_runs"][0]
    triage_snapshot = _wait_for_status(client, automation_entry["run_id"], {"awaiting_input"})
    approval = next(p for p in triage_snapshot["pending"] if p["kind"] == "approval")
    assert approval["tool_name"] == "create_work_order"

    # 2. ask_user resolution -- a separate, deliberately ambiguous run, free
    #    text answer resumes it to completion. The offline scripted router
    #    always defers to ask_user for this prompt; the real LLM sometimes
    #    answers directly in one turn (see tests/test_copilot_hitl.py's
    #    ``test_live_openai_ambiguous_request_pauses_for_ask_user``) -- in
    #    that case the ask_user resolution step is skipped but the run must
    #    still have produced a final answer either way.
    ask_run_id = client.post("/copilot/runs", json={"prompt": "check the pump"}).json()["run_id"]
    ask_snapshot = _wait_for_status(client, ask_run_id, {"awaiting_input", "completed"})
    if ask_snapshot["status"] == "awaiting_input":
        ask_pending = ask_snapshot["pending"][0]
        assert ask_pending["kind"] == "ask_user"
        if strict_ask_user:
            assert len(ask_pending["question"]["options"]) >= 2

        resp = client.post(
            f"/copilot/runs/{ask_run_id}/resolve",
            json={"resolutions": [{
                "pending_id": ask_pending["id"], "decision": "answer",
                "answer_text": "I mean the HYD_PUMP on AC-001",
            }]},
        )
        assert resp.status_code == 202
        ask_final = _wait_for_status(client, ask_run_id, {"completed"})
        assert ask_final["final_answer"]
    else:
        assert ask_snapshot["final_answer"]

    # 3. approval: viewer gets a real 403 and the pending card is untouched;
    #    lead.engineer's approval creates exactly one work order.
    run_id = automation_entry["run_id"]
    denied = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{"pending_id": approval["id"], "decision": "approve"}]},
        headers={"X-User": "viewer"},
    )
    assert denied.status_code == 403

    still_pending = client.get(f"/copilot/runs/{run_id}").json()
    assert still_pending["status"] == "awaiting_input"
    assert len(still_pending["pending"]) == 1
    assert still_pending["pending"][0]["id"] == approval["id"]

    approved = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{"pending_id": approval["id"], "decision": "approve"}]},
        headers={"X-User": "lead.engineer"},
    )
    assert approved.status_code == 202
    final = _wait_for_status(client, run_id, {"completed"})
    assert final["final_answer"]
    assert final["pending"] == []  # no re-deferral loop

    wos_after = client.get("/ops/work-orders").json()
    assert len(wos_after) == 1, f"expected exactly one work order, got {wos_after}"
    assert wos_after[0]["approved_by"] == "lead.engineer"

    # 4. drift: unshifted current window is no-alert (warn at worst); the
    #    simulated shift is an alert -- see phase-02 coordinator verification
    #    (temperature_delta_c/airflow_cfm PSI moderate -> warn unshifted;
    #    vibration PSI ~1.2 -> alert when simulate=shift).
    unshifted = client.get("/monitoring/drift", params={"window_days": 30}).json()
    assert unshifted["status"] != "alert"

    shifted = client.get("/monitoring/drift", params={"window_days": 30, "simulate": "shift"}).json()
    assert shifted["status"] == "alert"
    assert shifted["simulated_shift_applied"] is True

    # 5. KB search: hybrid retrieval returns a real, existing doc id.
    kb_hits = client.post("/kb/search", json={"query": "hydraulic pump maintenance procedure", "k": 3}).json()
    assert kb_hits, "expected at least one KB hit"
    top_doc_id = kb_hits[0]["doc_id"]
    doc = client.get(f"/kb/{top_doc_id}")
    assert doc.status_code == 200


def test_e2e_full_scenario_offline(tmp_path, monkeypatch):
    """Full scenario against the deterministic offline-scripted router --
    no network, no API key, runs in every CI/dev environment."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with _client_factory(tmp_path, monkeypatch) as client:
        meta = client.get("/copilot/meta").json()
        assert meta["mode"] == "offline-scripted"
        _run_full_scenario(client)


@pytest.mark.live
def test_e2e_full_scenario_live(tmp_path, monkeypatch):
    """Same scenario against the real OpenAI backend (gpt-4o-mini). Opt-in:
    skips automatically when ``OPENAI_API_KEY`` is absent, matching the
    existing ``tests/test_copilot_hitl.py`` live-test convention. Run with:

        $env:OPENAI_API_KEY = <key>
        .\\.venv\\Scripts\\python.exe -m pytest tests/test_e2e_scenario.py -m live -v
    """
    if not os.environ.get("OPENAI_API_KEY"):
        pytest.skip("OPENAI_API_KEY not set -- opt-in live test")
    with _client_factory(tmp_path, monkeypatch) as client:
        meta = client.get("/copilot/meta").json()
        assert meta["mode"] == "openai"
        _run_full_scenario(client, strict_ask_user=False)
