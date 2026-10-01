"""Prompt library (phase 02): `prompts` (named, versioned library entries)
plus `prompt_versions` (immutable content, children of a prompt). Covers
CRUD, version increment/activation, RBAC (ownership + visibility), the
backfill migration's shape, and the critical real requirement — a *new*
run's agent is genuinely built with `ops-system`'s active version, recorded
on the run as `prompt_version_id`."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from conftest import client_as  # noqa: E402

from agent_harness import state  # noqa: E402
from agent_harness.llm_client import build_test_model  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

_POLL_TIMEOUT_SECONDS = 10.0
_POLL_INTERVAL_SECONDS = 0.02


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


@pytest.fixture(autouse=True)
def _use_test_model(monkeypatch):
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_test_model(call_tools="all"))


def _wait_for_run_terminal(run_id: str) -> dict:
    # `create_incident` is approval-gated; TestModel(call_tools="all") calls
    # it too, so auto-approve any pending approval rather than treating it
    # as a failure (see test_api_integrations.py).
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    body: dict = {}
    approved = False
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/runs/{run_id}")
        assert response.status_code == 200
        body = response.json()
        if body["status"] == "pending_approval" and not approved:
            approve = client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": True})
            assert approve.status_code == 200
            approved = True
        elif body["status"] not in ("running", "pending_approval"):
            return body
        time.sleep(_POLL_INTERVAL_SECONDS)
    raise AssertionError(f"run {run_id} never reached a terminal status; last body: {body}")


def _create_prompt(**overrides) -> dict:
    payload = {
        "slug": "test-prompt",
        "name": "Test prompt",
        "kind": "system",
        "visibility": "shared",
        "content": "Test prompt v1 content.",
    }
    payload.update(overrides)
    response = client.post("/api/v1/prompts", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# --- seeded library ----------------------------------------------------------


def test_the_3_library_prompts_are_seeded_on_a_fresh_database():
    response = client.get("/api/v1/prompts")
    assert response.status_code == 200
    body = response.json()
    slugs = {p["slug"] for p in body}
    assert slugs == {"ops-system", "skill-router", "eval-judge"}
    ops_system = next(p for p in body if p["slug"] == "ops-system")
    assert ops_system["active_version"] is not None
    assert ops_system["version_count"] == 1
    assert ops_system["kind"] == "system"
    # Phase 04 fills in this count (was always 0 before agents existed) —
    # both seeded default agents (ops-assistant, kb-concierge) bind ops-system.
    assert ops_system["used_by_agents"] == 2


def test_kind_filter():
    response = client.get("/api/v1/prompts", params={"kind": "judge"})
    assert response.status_code == 200
    body = response.json()
    assert [p["slug"] for p in body] == ["eval-judge"]


def test_q_filter_matches_name_or_slug_case_insensitively():
    response = client.get("/api/v1/prompts", params={"q": "ROUTER"})
    assert response.status_code == 200
    assert [p["slug"] for p in response.json()] == ["skill-router"]


# --- CRUD + versioning --------------------------------------------------------


def test_create_prompt_creates_an_active_v1():
    created = _create_prompt()
    assert created["version_count"] == 1
    assert created["active_version"]["version"] == 1
    assert created["versions"][0]["content"] == "Test prompt v1 content."


def test_create_prompt_rejects_duplicate_slug():
    _create_prompt(slug="dup-slug")
    response = client.post(
        "/api/v1/prompts",
        json={"slug": "dup-slug", "name": "Second", "kind": "system", "content": "x"},
    )
    assert response.status_code == 409


def test_new_version_increments_and_does_not_auto_activate():
    created = _create_prompt(slug="versioned-prompt")
    prompt_id = created["id"]

    version = client.post(
        f"/api/v1/prompts/{prompt_id}/versions", json={"content": "v2 content", "change_note": "tweak"}
    )
    assert version.status_code == 201
    assert version.json()["version"] == 2

    detail = client.get(f"/api/v1/prompts/{prompt_id}").json()
    assert detail["version_count"] == 2
    assert detail["active_version"]["version"] == 1  # unchanged


def test_new_version_with_activate_true_moves_the_active_pointer():
    created = _create_prompt(slug="auto-activate-prompt")
    prompt_id = created["id"]

    version = client.post(
        f"/api/v1/prompts/{prompt_id}/versions", json={"content": "v2 content", "activate": True}
    )
    assert version.status_code == 201

    detail = client.get(f"/api/v1/prompts/{prompt_id}").json()
    assert detail["active_version"]["id"] == version.json()["id"]
    assert detail["active_version"]["version"] == 2


def test_activate_specific_version_moves_the_pointer_and_back():
    created = _create_prompt(slug="activate-prompt")
    prompt_id = created["id"]
    v1_id = created["active_version"]["id"]
    v2 = client.post(f"/api/v1/prompts/{prompt_id}/versions", json={"content": "v2"}).json()

    activate_v2 = client.post(f"/api/v1/prompts/{prompt_id}/versions/{v2['id']}/activate")
    assert activate_v2.status_code == 200
    assert activate_v2.json()["active_version"]["id"] == v2["id"]

    activate_v1 = client.post(f"/api/v1/prompts/{prompt_id}/versions/{v1_id}/activate")
    assert activate_v1.status_code == 200
    assert activate_v1.json()["active_version"]["id"] == v1_id


def test_activate_unknown_version_returns_404():
    created = _create_prompt(slug="activate-404-prompt")
    response = client.post(f"/api/v1/prompts/{created['id']}/versions/does-not-exist/activate")
    assert response.status_code == 404


def test_versions_are_immutable_no_update_route():
    created = _create_prompt(slug="immutable-prompt")
    version_id = created["active_version"]["id"]
    # No route accepts PATCH/PUT on a version directly — the built frontend's
    # catch-all static mount at "/" matches the path but not the method, so
    # this 405s rather than 404s; either way, nothing updates version content.
    response = client.patch(f"/api/v1/prompt_versions/{version_id}", json={"content": "hacked"})
    assert response.status_code == 405


def test_patch_updates_metadata_not_content():
    created = _create_prompt(slug="metadata-prompt", description="before")
    response = client.patch(
        f"/api/v1/prompts/{created['id']}", json={"description": "after", "tags": ["ops", "demo"]}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["description"] == "after"
    assert body["tags"] == ["ops", "demo"]


def test_delete_archives_a_normal_prompt():
    created = _create_prompt(slug="deletable-prompt")
    response = client.delete(f"/api/v1/prompts/{created['id']}")
    assert response.status_code == 204
    assert client.get(f"/api/v1/prompts/{created['id']}").status_code == 404
    assert created["slug"] not in {p["slug"] for p in client.get("/api/v1/prompts").json()}


def test_delete_seeded_library_prompt_is_rejected():
    ops_system = next(p for p in client.get("/api/v1/prompts").json() if p["slug"] == "ops-system")
    response = client.delete(f"/api/v1/prompts/{ops_system['id']}")
    assert response.status_code == 409


# --- RBAC: ownership + visibility --------------------------------------------


def test_viewer_can_read_shared_prompts_but_not_mutate():
    created = _create_prompt(slug="viewer-read-prompt", visibility="shared")
    as_viewer = client_as(client, "u_viewer")
    read = as_viewer.get(f"/api/v1/prompts/{created['id']}")
    assert read.status_code == 200
    write = as_viewer.patch(f"/api/v1/prompts/{created['id']}", json={"name": "hijacked"})
    assert write.status_code == 403


def test_editor_cannot_add_version_to_another_editors_private_prompt():
    created = client_as(client, "u_editor").post(
        "/api/v1/prompts",
        json={
            "slug": "editor-private",
            "name": "Editor private",
            "kind": "system",
            "visibility": "private",
            "content": "v1",
        },
    ).json()

    as_editor2 = client_as(client, "u_editor2")
    stranger_read = as_editor2.get(f"/api/v1/prompts/{created['id']}")
    assert stranger_read.status_code == 404

    stranger_version = as_editor2.post(
        f"/api/v1/prompts/{created['id']}/versions", json={"content": "hijack v2"}
    )
    assert stranger_version.status_code == 404  # unreadable, not just unwritable


def test_viewer_gets_403_creating_a_prompt():
    response = client_as(client, "u_viewer").post(
        "/api/v1/prompts", json={"slug": "x", "name": "x", "kind": "system", "content": "x"}
    )
    assert response.status_code == 403


# --- a new run genuinely uses the active ops-system content ------------------


def test_new_run_records_the_active_ops_system_prompt_version_id():
    ops_system = next(p for p in client.get("/api/v1/prompts").json() if p["slug"] == "ops-system")
    version = client.post(
        f"/api/v1/prompts/{ops_system['id']}/versions",
        json={"content": "Distinctive test-only system prompt v2.", "activate": True},
    ).json()

    start = client.post("/api/v1/runs", json={"objective": "Investigate auth-service."})
    assert start.status_code == 202
    run_id = start.json()["run_id"]

    snapshot = _wait_for_run_terminal(run_id)
    assert snapshot["status"] == "completed"
    assert snapshot["prompt_version_id"] == version["id"]

    summaries = client.get("/api/v1/runs").json()
    match = next(r for r in summaries if r["run_id"] == run_id)
    assert match["prompt_version_id"] == version["id"]


def test_activating_a_new_version_after_a_run_does_not_change_the_old_runs_recorded_version():
    first_start = client.post("/api/v1/runs", json={"objective": "Investigate auth-service."})
    first_run_id = first_start.json()["run_id"]
    first_snapshot = _wait_for_run_terminal(first_run_id)
    original_version_id = first_snapshot["prompt_version_id"]
    assert original_version_id is not None

    ops_system = next(p for p in client.get("/api/v1/prompts").json() if p["slug"] == "ops-system")
    new_version = client.post(
        f"/api/v1/prompts/{ops_system['id']}/versions",
        json={"content": "Yet another version.", "activate": True},
    ).json()

    refetched = client.get(f"/api/v1/runs/{first_run_id}").json()
    assert refetched["prompt_version_id"] == original_version_id
    assert refetched["prompt_version_id"] != new_version["id"]
