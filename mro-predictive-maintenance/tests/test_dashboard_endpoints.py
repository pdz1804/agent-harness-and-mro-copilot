"""Endpoints added for the dashboard redesign: component history, single fleet
component, drift history, registry metrics, role-gated retrain, aircraft
index, and the full-alert transition response.

Runs against the real ASGI app + real artifacts with a tmp-file ops database.
The retrain job runner is replaced only where a real training run would be
slow; the gate itself (``src.retrain.evaluate_gate``) is exercised for real.
"""

from __future__ import annotations

import hashlib
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from src import config, monitoring, retrain  # noqa: E402
from src.ops import drift_history  # noqa: E402
from src.service.app import app  # noqa: E402
from src.service.retrain_jobs import RetrainJobs  # noqa: E402
from src.service.routers import monitoring as monitoring_router  # noqa: E402

LEAD = {"X-User": "lead.engineer"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    if not config.MODEL_CARD_JSON.exists():
        pytest.skip("reports/model_card.json missing -- run `python -m src.pipeline` first")
    if not monitoring.REFERENCE_PROFILE_CSV.exists():
        pytest.skip("reports/reference_profile.csv missing -- run `python -m src.pipeline --profile v1` first")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'ops.db'}")
    monkeypatch.setattr(monitoring_router, "retrain_jobs", RetrainJobs())
    with TestClient(app) as c:
        yield c


def _scan(client):
    resp = client.post("/ops/fleet-scan", json={"window_days": 30})
    assert resp.status_code == 200
    return resp.json()


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---- GET /ops/components/{id}/history ------------------------------------

def test_component_history_has_predictions_and_events(client):
    _scan(client)
    _scan(client)
    top = client.get("/fleet/top-risk?n=1").json()["items"][0]
    cid = top["component_id"]

    resp = client.get(f"/ops/components/{cid}/history")
    assert resp.status_code == 200
    body = resp.json()
    assert body["component_id"] == cid
    assert len(body["predictions"]) == 2  # one row per fleet scan, real log
    pred = body["predictions"][0]
    assert set(pred) == {"scored_at", "snapshot_date", "cycle", "risk_score", "threshold", "alert", "model_version"}
    assert pred["risk_score"] == pytest.approx(top["risk_score"])
    assert pred["alert"] is True
    assert body["predictions"][0]["scored_at"] <= body["predictions"][1]["scored_at"]
    for ev in body["maintenance_events"]:
        assert set(ev) == {"date", "cycle", "event_type", "note"}
    if body["maintenance_events"]:
        dates = [e["date"] for e in body["maintenance_events"]]
        assert dates == sorted(dates)


def test_component_history_known_but_never_scored_is_empty_predictions(client):
    cid = client.get("/fleet/top-risk?n=1").json()["items"][0]["component_id"]
    body = client.get(f"/ops/components/{cid}/history").json()
    assert body["predictions"] == []


def test_component_history_unknown_is_404(client):
    assert client.get("/ops/components/NOPE-123/history").status_code == 404


# ---- GET /fleet/components/{id} -------------------------------------------

def test_fleet_component_matches_top_risk_item(client):
    top = client.get("/fleet/top-risk?n=1").json()["items"][0]
    resp = client.get(f"/fleet/components/{top['component_id']}")
    assert resp.status_code == 200
    assert resp.json() == top
    assert resp.json()["features"]


def test_fleet_component_unknown_is_404(client):
    assert client.get("/fleet/components/NOPE-123").status_code == 404


# ---- GET /monitoring/drift/history ----------------------------------------

def test_drift_history_starts_empty(client):
    assert client.get("/monitoring/drift/history").json() == {"points": []}


def test_drift_call_persists_snapshot_and_throttles(client):
    live = client.get("/monitoring/drift").json()
    client.get("/monitoring/drift")  # inside the throttle window: not a second point
    points = client.get("/monitoring/drift/history").json()["points"]
    assert len(points) == 1
    point = points[0]
    assert point["overall"] == live["status"]
    assert point["score_psi"] == pytest.approx(live["score_psi"])
    assert point["features"]["vibration_mm_s"] == pytest.approx(live["features"]["vibration_mm_s"]["psi"])
    datetime.fromisoformat(point["at"])


def test_simulated_shift_is_never_persisted(client):
    client.get("/monitoring/drift?simulate=shift")
    assert client.get("/monitoring/drift/history").json()["points"] == []


def test_fleet_scan_persists_snapshot_even_inside_throttle_window(client):
    client.get("/monitoring/drift")
    _scan(client)
    points = client.get("/monitoring/drift/history").json()["points"]
    assert [p["trigger"] for p in points] == ["drift_call", "fleet_scan"]
    assert points[0]["at"] <= points[1]["at"]
    assert points[1]["n_current"] > 0


def test_drift_history_points_and_window_filters(client):
    for _ in range(3):
        _scan(client)
    assert len(client.get("/monitoring/drift/history?points=2").json()["points"]) == 2
    assert len(client.get("/monitoring/drift/history?window_days=1").json()["points"]) == 3
    assert client.get("/monitoring/drift/history?points=0").status_code == 422
    assert client.get("/monitoring/drift/history?window_days=0").status_code == 422


def test_record_snapshot_throttle_expires_and_sanitises_nan(tmp_path):
    from src.ops import db as ops_db

    engine = ops_db.make_engine(f"sqlite:///{tmp_path / 'd.db'}")
    ops_db.init_db(engine)
    report = {
        "status": "ok", "n_current": 40, "score_psi": float("nan"), "current_source": "test",
        "features": {"a": {"psi": 0.05}, "b": {"psi": float("nan")}},
    }
    t0 = datetime.now(timezone.utc)
    with engine.connect() as conn:
        assert drift_history.record_snapshot(conn, report, "drift_call", now=t0) is not None
        assert drift_history.record_snapshot(conn, report, "drift_call", now=t0 + timedelta(seconds=5)) is None
        later = t0 + timedelta(seconds=drift_history.MIN_DRIFT_CALL_INTERVAL_S + 1)
        assert drift_history.record_snapshot(conn, report, "drift_call", now=later) is not None
        points = drift_history.list_snapshots(conn, window_days=1, points=10)
    assert len(points) == 2
    assert points[0]["features"] == {"a": 0.05, "b": None}
    assert points[0]["score_psi"] is None


# ---- GET /models/{version}/metrics ----------------------------------------

def test_model_metrics_503_when_tracking_disabled(client):
    resp = client.get("/models/1/metrics")
    assert resp.status_code == 503


@pytest.fixture
def mlflow_registry(tmp_path, monkeypatch):
    pytest.importorskip("mlflow")
    import mlflow
    import pandas as pd
    from sklearn.linear_model import LogisticRegression

    from src import tracking

    monkeypatch.setenv("MLFLOW_TRACKING_URI", f"sqlite:///{(tmp_path / 'mlflow.db').as_posix()}")
    # Pin the experiment's artifact root inside tmp_path so nothing lands in the real mlruns/.
    mlflow.set_tracking_uri(f"sqlite:///{(tmp_path / 'mlflow.db').as_posix()}")
    mlflow.create_experiment(tracking.EXPERIMENT_NAME, artifact_location=(tmp_path / "artifacts").as_uri())
    tracking.init_tracking(force=True)
    try:
        x = pd.DataFrame({"f": [0.0, 1.0, 2.0, 3.0]})
        model = LogisticRegression().fit(x, [0, 0, 1, 1])
        result = tracking.log_training_run(
            profile="realistic", seed=1, served_policy="max_recall",
            params={"model_id": "m", "threshold": 0.9405},
            metrics={"test_recall": 0.8214285714285714, "test_precision": 0.5},
            artifact_paths=[], sklearn_pipeline=model, input_example=x.head(2),
            alias="champion",
        )
        assert result and result["model_version"]
        yield result["model_version"]
    finally:
        tracking.reset_for_testing()


def test_model_metrics_from_registry(client, mlflow_registry):
    resp = client.get(f"/models/{mlflow_registry}/metrics")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] == mlflow_registry
    assert body["aliases"] == ["champion"]
    assert body["threshold"] == pytest.approx(0.9405)
    assert body["test_metrics"]["test_recall"] == pytest.approx(0.8214285714285714)
    datetime.fromisoformat(body["trained_at"])


def test_model_metrics_unknown_version_is_404(client, mlflow_registry):
    assert client.get("/models/999/metrics").status_code == 404


# ---- POST /models/retrain + polling ---------------------------------------

def _wait_done(client, run_id, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/models/retrain/{run_id}").json()
        if job["status"] in {"succeeded", "failed"}:
            return job
        time.sleep(0.02)
    raise AssertionError("retrain job did not finish")


@pytest.mark.parametrize("headers", [{}, {"X-User": "planner"}, {"X-User": "viewer"}, {"X-User": "engineer.demo"}])
def test_retrain_forbidden_for_everyone_but_lead_engineer(client, monkeypatch, headers):
    called = []
    monkeypatch.setattr(retrain, "run_retrain", lambda **kw: called.append(kw))
    resp = client.post("/models/retrain", json={}, headers=headers)
    assert resp.status_code == 403
    assert called == []


def test_retrain_unknown_run_is_404(client):
    assert client.get("/models/retrain/doesnotexist").status_code == 404


def test_retrain_runs_real_gate_and_keeps_champion(client, monkeypatch, tmp_path):
    """Real run_retrain + real evaluate_gate; only the (slow) training is stubbed."""
    card = {
        "ci": {"recall_ci": [0.40, 0.90]},
        "alert_rate": {"component_window_alerts_per_100": 2.0},
        "calibration": {"brier_post": 0.01},
    }
    monkeypatch.setattr(retrain.pipeline, "run", lambda **kw: {"card": card})
    monkeypatch.setattr(retrain, "RETRAIN_DECISION_JSON", tmp_path / "decision.json")
    # A strong recorded champion: the weak challenger must be rejected.
    monkeypatch.setattr(
        retrain, "_load_champion_metrics",
        lambda *a, **k: {"recall_ci_low": 0.70, "component_window_alerts_per_100": 3.0, "brier": 0.02,
                         "model_version": "1"},
    )
    card_path = config.MODEL_CARD_JSON
    before = _digest(card_path)
    threshold_before = client.get("/model-card").json()["threshold"]
    assert threshold_before == 0.9405

    resp = client.post("/models/retrain", json={"promote_if_better": True}, headers=LEAD)
    assert resp.status_code == 202
    run_id = resp.json()["run_id"]
    assert resp.json()["status"] in {"queued", "running", "succeeded"}

    job = _wait_done(client, run_id)
    assert job["status"] == "succeeded", job
    result = job["result"]
    assert result["gate"]["promote"] is False
    assert any("recall_ci_low" in r and "FAIL" in r for r in result["gate"]["reasons"])
    assert result["promoted"] is False
    assert result["model_version"] is None
    assert result["served_model_changed"] is False
    assert result["v1_model_card_unchanged"] is True
    assert result["targets"]["max_alerts_per_100"] == retrain.MAX_ALERTS_PER_100

    assert _digest(card_path) == before
    after_card = client.get("/model-card").json()
    assert after_card["threshold"] == 0.9405
    assert after_card["test_at_threshold"]["recall"] == pytest.approx(0.8214285714285714)


def test_retrain_without_baseline_never_promotes(client, monkeypatch):
    seen = {}

    def fake_run(**kw):
        seen.update(kw)
        return {
            "gate": {"promote": True, "reasons": ["no existing champion metrics found; promoting unconditionally"]},
            "challenger_metrics": {"recall_ci_low": 0.5},
            "champion_metrics": None, "promoted": False, "model_version": None,
        }

    monkeypatch.setattr(retrain, "run_retrain", fake_run)
    monkeypatch.setattr(retrain, "_load_champion_metrics", lambda *a, **k: None)
    run_id = client.post("/models/retrain", json={"promote_if_better": True}, headers=LEAD).json()["run_id"]
    job = _wait_done(client, run_id)
    assert seen["promote_if_better"] is False  # promotion withheld without a baseline
    assert seen["profile"] == "realistic"
    assert job["baseline_available"] is False
    assert job["result"]["promoted"] is False
    assert "no recorded champion baseline" in job["result"]["note"]


def test_retrain_promotion_passed_through_when_baseline_exists(client, monkeypatch):
    seen = {}

    def fake_run(**kw):
        seen.update(kw)
        return {
            "gate": {"promote": True, "reasons": ["all PASS"]},
            "challenger_metrics": {}, "champion_metrics": {"model_version": "1"},
            "promoted": True, "model_version": "2",
        }

    monkeypatch.setattr(retrain, "run_retrain", fake_run)
    monkeypatch.setattr(retrain, "_load_champion_metrics", lambda *a, **k: {"model_version": "1"})
    run_id = client.post("/models/retrain", json={"promote_if_better": True}, headers=LEAD).json()["run_id"]
    job = _wait_done(client, run_id)
    assert seen["promote_if_better"] is True
    assert job["result"]["promoted"] is True
    assert job["result"]["model_version"] == "2"
    # Served model only changes after a restart; the live headline stays put.
    assert job["result"]["served_model_changed"] is False
    assert client.get("/model-card").json()["threshold"] == 0.9405


def test_retrain_failure_is_reported_not_swallowed(client, monkeypatch):
    def boom(**kw):
        raise RuntimeError("training exploded")

    monkeypatch.setattr(retrain, "run_retrain", boom)
    run_id = client.post("/models/retrain", json={}, headers=LEAD).json()["run_id"]
    job = _wait_done(client, run_id)
    assert job["status"] == "failed"
    assert "training exploded" in job["error"]
    assert job["result"]["v1_model_card_unchanged"] is True


def test_retrain_second_request_while_running_is_409(client, monkeypatch):
    import threading

    release = threading.Event()

    def slow(**kw):
        release.wait(5)
        return {"gate": {"promote": False, "reasons": []}, "challenger_metrics": {},
                "champion_metrics": None, "promoted": False, "model_version": None}

    monkeypatch.setattr(retrain, "run_retrain", slow)
    first = client.post("/models/retrain", json={}, headers=LEAD)
    assert first.status_code == 202
    second = client.post("/models/retrain", json={}, headers=LEAD)
    assert second.status_code == 409
    assert second.json()["detail"]["run_id"] == first.json()["run_id"]
    release.set()
    assert _wait_done(client, first.json()["run_id"])["status"] == "succeeded"


def test_retrain_rejects_unknown_body_fields(client):
    assert client.post("/models/retrain", json={"profile": "v1"}, headers=LEAD).status_code == 422


# ---- GET /ops/aircraft -----------------------------------------------------

def test_aircraft_index_before_and_after_scan(client):
    before = client.get("/ops/aircraft").json()
    assert len(before) > 0
    assert all(a["max_risk"] is None and a["n_open_alerts"] == 0 and a["status"] == "serviceable" for a in before)
    assert [a["aircraft_id"] for a in before] == sorted(a["aircraft_id"] for a in before)

    _scan(client)
    alerts = client.get("/ops/alerts").json()
    after = {a["aircraft_id"]: a for a in client.get("/ops/aircraft").json()}
    assert set(after) == {a["aircraft_id"] for a in before}
    assert all(a["max_risk"] is not None for a in after.values())
    for ac, row in after.items():
        assert row["n_open_alerts"] == sum(1 for al in alerts if al["aircraft_id"] == ac)
    top = client.get("/fleet/top-risk?n=1").json()["items"][0]
    assert after[top["aircraft_id"]]["max_risk"] == pytest.approx(top["risk_score"])


def test_aircraft_index_reflects_status_and_work_orders(client):
    _scan(client)
    alert = client.get("/ops/alerts").json()[0]
    ac = alert["aircraft_id"]
    assert client.post(
        f"/ops/aircraft/{ac}/status", json={"status": "restricted", "reason": "test"}, headers=LEAD,
    ).status_code == 200
    client.post("/ops/work-orders", json={
        "aircraft_id": ac, "component_id": alert["component_id"], "approved_by": "lead.engineer",
        "alert_id": alert["id"],
    }, headers=LEAD)
    row = next(a for a in client.get("/ops/aircraft").json() if a["aircraft_id"] == ac)
    assert row["status"] == "restricted"
    assert row["n_open_wos"] == 1


# ---- POST /ops/alerts/{id}/transition returns the full alert ---------------

def test_transition_returns_full_alert(client):
    _scan(client)
    alert_id = client.get("/ops/alerts").json()[0]["id"]
    resp = client.post(
        f"/ops/alerts/{alert_id}/transition", json={"action": "acknowledge", "note": "on it"}, headers=LEAD,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body == client.get(f"/ops/alerts/{alert_id}").json()
    assert body["status"] == "acknowledged"
    assert [e["action"] for e in body["events"]] == ["opened", "acknowledge"]
    assert body["events"][-1]["actor"] == "lead.engineer"
    assert body["work_orders"] == []
    assert body["component_id"] and body["risk_score"] > 0


def test_transition_errors_unchanged(client):
    _scan(client)
    alert_id = client.get("/ops/alerts").json()[0]["id"]
    assert client.post(f"/ops/alerts/{alert_id}/transition", json={"action": "reopen"}).status_code == 409
    assert client.post("/ops/alerts/999999/transition", json={"action": "acknowledge"}).status_code == 404
