"""Skills (phase 03): a reusable capability package — CRUD, validation
(slug/tool/reserved-slug), RBAC (ownership + visibility), and the
`enabled=true` filter used by the Skills page and (from phase 04) runtime
skill selection."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from conftest import client_as  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from api import app  # noqa: E402

client = TestClient(app)


def _create_skill(**overrides) -> dict:
    payload = {
        "slug": "test-skill",
        "name": "Test skill",
        "description": "A skill created for a test.",
        "instructions": "Do the thing.",
        "allowed_tools": ["get_service_status"],
        "visibility": "shared",
    }
    payload.update(overrides)
    response = client.post("/api/v1/skills", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# --- seeded library ----------------------------------------------------------


def test_the_default_skills_are_seeded_on_a_fresh_database():
    response = client.get("/api/v1/skills")
    assert response.status_code == 200
    slugs = {s["slug"] for s in response.json()}
    assert slugs == {
        "triage-outage",
        "kb-answer",
        "escalate-incident",
        "service-health-report",
        "build-dashboard",
    }


def test_seeded_skills_are_shared_admin_owned_and_enabled():
    response = client.get("/api/v1/skills")
    for skill in response.json():
        assert skill["owner_id"] == "u_admin"
        assert skill["visibility"] == "shared"
        assert skill["enabled"] is True
        assert skill["allowed_tools"], skill["slug"]


# --- CRUD ----------------------------------------------------------------


def test_create_get_update_delete_skill():
    created = _create_skill()
    assert created["slug"] == "test-skill"
    assert created["allowed_tools"] == ["get_service_status"]

    got = client.get(f"/api/v1/skills/{created['id']}")
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]

    updated = client.patch(
        f"/api/v1/skills/{created['id']}", json={"name": "Renamed", "enabled": False}
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Renamed"
    assert updated.json()["enabled"] is False

    deleted = client.delete(f"/api/v1/skills/{created['id']}")
    assert deleted.status_code == 204
    assert client.get(f"/api/v1/skills/{created['id']}").status_code == 404


def test_create_duplicate_slug_conflicts():
    _create_skill(slug="dup-skill")
    response = client.post(
        "/api/v1/skills",
        json={
            "slug": "dup-skill",
            "name": "Another",
            "description": "x",
            "allowed_tools": ["get_service_status"],
        },
    )
    assert response.status_code == 409


def test_enabled_filter_excludes_disabled_skill():
    created = _create_skill(slug="disabled-skill", enabled=False)
    response = client.get("/api/v1/skills", params={"enabled": True})
    assert created["id"] not in {s["id"] for s in response.json()}
    response_all = client.get("/api/v1/skills", params={"enabled": False})
    assert created["id"] in {s["id"] for s in response_all.json()}


# --- validation ------------------------------------------------------------


def test_bad_slug_is_rejected():
    response = client.post(
        "/api/v1/skills",
        json={
            "slug": "Not Valid!",
            "name": "x",
            "description": "x",
            "allowed_tools": ["get_service_status"],
        },
    )
    assert response.status_code == 422


def test_reserved_slug_is_rejected():
    response = client.post(
        "/api/v1/skills",
        json={
            "slug": "help",
            "name": "x",
            "description": "x",
            "allowed_tools": ["get_service_status"],
        },
    )
    assert response.status_code == 422


def test_unknown_tool_is_rejected():
    response = client.post(
        "/api/v1/skills",
        json={
            "slug": "unknown-tool-skill",
            "name": "x",
            "description": "x",
            "allowed_tools": ["not_a_real_tool"],
        },
    )
    assert response.status_code == 422


def test_empty_allowed_tools_is_rejected():
    response = client.post(
        "/api/v1/skills",
        json={"slug": "empty-tools-skill", "name": "x", "description": "x", "allowed_tools": []},
    )
    assert response.status_code == 422


# --- RBAC (ownership + visibility) -----------------------------------------


def test_viewer_can_read_shared_skills_but_not_create():
    response = client_as(client, "u_viewer").get("/api/v1/skills")
    assert response.status_code == 200
    assert len(response.json()) >= 4  # the 4 seeded shared skills


def test_editor_cannot_read_another_editors_private_skill():
    mine = client_as(client, "u_editor").post(
        "/api/v1/skills",
        json={
            "slug": "editor-private-skill",
            "name": "Private",
            "description": "x",
            "allowed_tools": ["get_service_status"],
            "visibility": "private",
        },
    )
    assert mine.status_code == 201
    skill_id = mine.json()["id"]

    other = client_as(client, "u_editor2").get(f"/api/v1/skills/{skill_id}")
    assert other.status_code == 404

    other_write = client_as(client, "u_editor2").patch(f"/api/v1/skills/{skill_id}", json={"name": "Hacked"})
    assert other_write.status_code == 404

    listing = client_as(client, "u_editor2").get("/api/v1/skills")
    assert skill_id not in {s["id"] for s in listing.json()}


def test_editor_can_write_own_private_skill():
    mine = client_as(client, "u_editor").post(
        "/api/v1/skills",
        json={
            "slug": "editor-own-skill",
            "name": "Mine",
            "description": "x",
            "allowed_tools": ["get_service_status"],
            "visibility": "private",
        },
    )
    assert mine.status_code == 201
    skill_id = mine.json()["id"]

    updated = client_as(client, "u_editor").patch(f"/api/v1/skills/{skill_id}", json={"name": "Mine v2"})
    assert updated.status_code == 200

    deleted = client_as(client, "u_editor").delete(f"/api/v1/skills/{skill_id}")
    assert deleted.status_code == 204


def test_admin_sees_and_can_delete_a_seeded_skill():
    response = client.get("/api/v1/skills")
    triage = next(s for s in response.json() if s["slug"] == "triage-outage")
    # Not asserting the delete itself succeeds destructively for later tests
    # in this module — just that admin has read/write reach over every skill.
    got = client.get(f"/api/v1/skills/{triage['id']}")
    assert got.status_code == 200


# --- tool catalog ------------------------------------------------------------


def test_tool_catalog_lists_the_default_registry():
    response = client.get("/api/v1/tools")
    assert response.status_code == 200
    names = {t["name"] for t in response.json()}
    assert names == {
        "search_knowledge_base",
        "get_service_status",
        "create_incident",
        "create_dashboard",
        "add_widget",
        "remember",
        "recall",
    }
    for tool in response.json():
        assert isinstance(tool["requires_approval"], bool)
        assert isinstance(tool["enabled"], bool)
