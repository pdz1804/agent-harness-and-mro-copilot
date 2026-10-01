"""Zombie runs (persisted `running` with no live worker) and the SPA history
fallback / `/api/v1` route map."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.routing import Mount

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import db  # noqa: E402
from api import _CachedStaticFiles, app  # noqa: E402

client = TestClient(app)
ADMIN = {"X-User-Id": "u_admin"}
EDITOR = {"X-User-Id": "u_editor"}
OTHER = {"X-User-Id": "u_editor2"}


def _zombie(run_id: str, status: str = "running", owner_id: str = "u_editor") -> None:
    db.upsert_run(
        {
            "run_id": run_id,
            "objective": "make a dashboard",
            "status": status,
            "started_at": time.time() - 600,
            "finished_at": None,
            "final_answer": None,
            "steps_taken": 2,
            "trace_path": f"runs/{run_id}.jsonl",
            "error": None,
            "owner_id": owner_id,
        }
    )


def test_cancel_works_for_a_persisted_run_with_no_live_worker() -> None:
    _zombie("zombie000001")
    assert client.get("/api/v1/runs/zombie000001", headers=EDITOR).json()["status"] == "running"
    response = client.post("/api/v1/runs/zombie000001/cancel", headers=EDITOR)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"
    assert client.get("/api/v1/runs/zombie000001", headers=EDITOR).json()["status"] == "cancelled"
    # Now terminal: a second stop is a conflict, not a 404.
    assert client.post("/api/v1/runs/zombie000001/cancel", headers=EDITOR).status_code == 409


def test_cancel_a_persisted_pending_approval_run_and_respect_ownership() -> None:
    _zombie("zombie000002", status="pending_approval")
    assert client.post("/api/v1/runs/zombie000002/cancel", headers=OTHER).status_code in (403, 404)
    assert client.post("/api/v1/runs/zombie000002/cancel", headers=ADMIN).json()["status"] == "cancelled"


def test_cancel_unknown_run_is_404() -> None:
    assert client.post("/api/v1/runs/nope/cancel", headers=ADMIN).status_code == 404


def test_approve_on_a_persisted_run_with_no_worker_is_a_conflict() -> None:
    _zombie("zombie000003", status="pending_approval")
    response = client.post("/api/v1/runs/zombie000003/approve", json={"approved": True}, headers=EDITOR)
    assert response.status_code == 409


def test_startup_sweep_marks_orphaned_runs_failed_with_a_reason() -> None:
    _zombie("zombie000004")
    _zombie("zombie000005", status="pending_approval")
    _zombie("zombie000006", status="completed")
    assert db.mark_orphaned_runs() == 2
    for run_id in ("zombie000004", "zombie000005"):
        body = client.get(f"/api/v1/runs/{run_id}", headers=EDITOR).json()
        assert body["status"] == "failed"
        assert "no live worker" in body["error"]
    assert client.get("/api/v1/runs/zombie000006", headers=EDITOR).json()["status"] == "completed"


def test_lifespan_startup_sweeps_orphans() -> None:
    _zombie("zombie000007")
    with TestClient(app):
        pass
    row = db.get_run("zombie000007")
    assert row is not None and row["status"] == "failed"


# --- route map -------------------------------------------------------------


def test_every_api_route_is_under_the_api_prefix_except_health() -> None:
    paths = set(app.openapi()["paths"])
    assert "/api/v1/runs/{run_id}" in paths and "/api/v1/health" in paths
    assert {p for p in paths if not p.startswith("/api/v1/")} == {"/health"}


def test_health_is_served_at_both_paths() -> None:
    assert client.get("/health").json()["status"] == "ok"
    assert client.get("/api/v1/health").json()["status"] == "ok"


def test_docs_and_openapi_live_under_the_prefix() -> None:
    assert client.get("/api/v1/openapi.json").status_code == 200
    assert client.get("/api/v1/docs").status_code == 200


# --- SPA history fallback ----------------------------------------------------


@pytest.fixture
def spa(tmp_path: Path) -> TestClient:
    build = tmp_path / "build"
    (build / "assets").mkdir(parents=True)
    (build / "index.html").write_text("<html>spa</html>", encoding="utf-8")
    (build / "assets" / "index-abc.js").write_text("console.log(1)", encoding="utf-8")
    (build / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    web = Starlette(routes=[Mount("/", _CachedStaticFiles(directory=str(build), html=True))])
    return TestClient(web)


@pytest.mark.parametrize("path", ["/", "/sessions/abc123", "/dashboards/dash-1", "/evals", "/runs/xyz/trace"])
def test_clean_ui_paths_serve_index_html_uncached(spa: TestClient, path: str) -> None:
    response = spa.get(path)
    assert response.status_code == 200
    assert "spa" in response.text
    assert response.headers["Cache-Control"] == "no-cache"


def test_real_files_are_served_and_missing_assets_still_404(spa: TestClient) -> None:
    assert spa.get("/favicon.svg").text == "<svg/>"
    assert spa.get("/assets/index-abc.js").headers["Cache-Control"] == "public, max-age=31536000, immutable"
    assert spa.get("/assets/missing-123.js").status_code == 404


def test_unknown_api_paths_are_a_real_404_not_the_spa(spa: TestClient) -> None:
    assert spa.get("/api/v1/does-not-exist").status_code == 404
    assert spa.get("/api").status_code == 404
