"""Fleet-scan-triggered automation dispatch (``src/copilot/automations.py``
+ ``POST /copilot/fleet-scan``). Verifies acceptance criterion 11: a
threshold crossing during fleet-scan starts a triage run that ends in
``awaiting_input`` -- never an auto-created work order."""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from src import config  # noqa: E402
from src.service.app import app  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    if not config.MODEL_CARD_JSON.exists():
        pytest.skip("reports/model_card.json missing -- run `python -m src.pipeline` first")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'ops.db'}")
    with TestClient(app) as c:
        yield c


def _wait_for_status(client, run_id, statuses, timeout=15.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = client.get(f"/copilot/runs/{run_id}").json()
        if last["status"] in statuses:
            return last
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} did not reach {statuses} within {timeout}s (last={last})")


def test_fleet_scan_starts_automation_run_per_new_alert(client):
    resp = client.post("/copilot/fleet-scan", json={"window_days": 30})
    assert resp.status_code == 200
    body = resp.json()
    assert body["scored"] > 0
    assert len(body["automation_runs"]) == min(len(body["new_alerts"]), 5)

    for entry in body["automation_runs"]:
        # The offline-scripted router's id-extraction regex now handles this
        # dataset's compound component ids (e.g. "AC-003-APU_STARTER")
        # correctly, and the auto-generated triage prompt (see
        # ``DEFAULT_PROMPT_TEMPLATE``) always contains a real component id +
        # aircraft id + "work order" trigger phrase, so every automation run
        # deterministically reaches ``create_work_order`` -> a real approval
        # card. What acceptance criterion 11 actually requires (never
        # auto-creates a work order) is still asserted unconditionally below.
        snapshot = _wait_for_status(client, entry["run_id"], {"awaiting_input"}, timeout=20.0)
        assert any(p["kind"] == "approval" for p in snapshot["pending"])

    wos = client.get("/ops/work-orders").json()
    assert wos == [], "no work order may exist before a human approves an automation-triggered run"


def test_fleet_scan_twice_does_not_double_trigger_automations(client):
    first = client.post("/copilot/fleet-scan", json={"window_days": 30}).json()
    for entry in first["automation_runs"]:
        _wait_for_status(client, entry["run_id"], {"awaiting_input", "completed", "failed"}, timeout=20.0)

    second = client.post("/copilot/fleet-scan", json={"window_days": 30}).json()
    assert second["new_alerts"] == []
    assert second["automation_runs"] == []


def test_automation_run_awaiting_input_approval_creates_work_order_only_after_approval(client):
    body = client.post("/copilot/fleet-scan", json={"window_days": 30}).json()
    assert body["automation_runs"], "expected at least one automation run for a fresh scan"

    # The default triage prompt template always names a real, correctly-
    # parsed component id + aircraft id, so the first automation run
    # deterministically reaches an approval card -- no self-skip needed.
    entry = body["automation_runs"][0]
    snapshot = _wait_for_status(client, entry["run_id"], {"awaiting_input"}, timeout=20.0)

    run_id = snapshot["run_id"]
    approval = next(p for p in snapshot["pending"] if p["kind"] == "approval")
    resp = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{"pending_id": approval["id"], "decision": "approve"}]},
        headers={"X-User": "lead.engineer"},
    )
    assert resp.status_code == 202
    final = _wait_for_status(client, run_id, {"completed"}, timeout=15.0)
    assert final["final_answer"]

    wos = client.get("/ops/work-orders").json()
    assert any(w["approved_by"] == "lead.engineer" for w in wos)
