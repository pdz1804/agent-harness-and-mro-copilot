"""RBAC foundation (phase 01): `agent_harness.rbac`'s permission matrix,
`current_user`'s identity resolution (401 on missing/unknown), and
server-side enforcement across every mutating route plus per-resource
ownership (404 for unreadable, 403 for readable-but-unwritable/unapprovable).

`conftest.py`'s `_default_test_client_identity` fixture injects
`X-User-Id: u_admin` on every request that doesn't already carry one, so a
bare `client.get(...)` elsewhere in the suite keeps working; here we mostly
override it via `client_as()`/explicit headers to exercise other roles."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from conftest import client_as  # noqa: E402

import api  # noqa: E402
from agent_harness import (
    rbac,  # noqa: E402
    state,  # noqa: E402
)
from agent_harness.llm_client import build_test_model  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


@pytest.fixture(autouse=True)
def _use_test_model(monkeypatch):
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_test_model(call_tools="none"))


# --- permission matrix (pure unit tests, no HTTP) --------------------------


def test_admin_can_do_everything():
    for action in rbac.PERMISSIONS["admin"]:
        assert rbac.can("admin", action)


@pytest.mark.parametrize(
    "action",
    ["mutate_integrations", "mutate_guardrails"],
)
def test_editor_cannot_mutate_safety_posture_config(action):
    assert not rbac.can("editor", action)


@pytest.mark.parametrize(
    "action",
    ["mutate_prompts", "mutate_skills", "mutate_agents", "mutate_automations", "mutate_artifacts", "mutate_services"],
)
def test_editor_can_mutate_non_safety_config(action):
    assert rbac.can("editor", action)


@pytest.mark.parametrize(
    "action",
    [
        "mutate_integrations",
        "mutate_guardrails",
        "mutate_prompts",
        "mutate_skills",
        "mutate_agents",
        "mutate_automations",
        "mutate_artifacts",
        "mutate_services",
    ],
)
def test_viewer_cannot_mutate_any_config(action):
    assert not rbac.can("viewer", action)


def test_every_role_can_chat():
    for role in ("admin", "editor", "viewer"):
        assert rbac.can(role, "chat")


def test_can_read_private_resource_owner_vs_stranger():
    resource = rbac.Resource(owner_id="u_editor", visibility="private")
    assert rbac.can_read("u_editor", "editor", resource)
    assert not rbac.can_read("u_editor2", "editor", resource)
    assert rbac.can_read("u_admin", "admin", resource)


def test_can_write_viewer_never_even_own_resource():
    resource = rbac.Resource(owner_id="u_viewer", visibility="private")
    assert not rbac.can_write("u_viewer", "viewer", resource)


def test_can_approve_owner_or_admin_only():
    resource = rbac.Resource(owner_id="u_viewer", visibility="private")
    assert rbac.can_approve("u_viewer", "viewer", resource)
    assert rbac.can_approve("u_admin", "admin", resource)
    assert not rbac.can_approve("u_editor", "editor", resource)


# --- identity resolution ----------------------------------------------------


def test_missing_identity_returns_401():
    """Unit-level (not via HTTP): `conftest.py`'s autouse fixture always
    injects a default `X-User-Id` header for HTTP requests in this suite
    (so the rest of the pre-RBAC tests keep passing unmodified), so the
    "truly no identity at all" case is exercised by calling the dependency
    function directly instead."""
    import fastapi

    with pytest.raises(fastapi.HTTPException) as exc_info:
        api.current_user(x_user_id=None, as_user=None)
    assert exc_info.value.status_code == 401


def test_unknown_user_id_returns_401():
    response = client.get("/api/v1/me", headers={"X-User-Id": "u_does_not_exist"})
    assert response.status_code == 401


def test_known_user_returns_role_and_permissions():
    response = client.get("/api/v1/me", headers={"X-User-Id": "u_viewer"})
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "u_viewer"
    assert body["role"] == "viewer"
    assert "mutate_integrations" not in body["permissions"]
    assert "chat" in body["permissions"]


def test_list_users_returns_all_four_seeded_identities():
    response = client.get("/api/v1/users", headers={"X-User-Id": "u_viewer"})
    assert response.status_code == 200
    ids = {row["id"] for row in response.json()}
    assert ids == {"u_admin", "u_editor", "u_viewer", "u_editor2"}


# --- viewer 403 on every mutating route -------------------------------------

# Routes that are intentionally NOT admin/editor-gated config mutation:
# chatting (create sessions/runs) is available to every role, and approval
# is owner-or-admin, not role-gated — both are asserted separately below,
# not swept into the generic "viewer gets 403" parametrization.
_CHAT_EXEMPT_PATHS = {
    "/api/v1/run",
    "/api/v1/sessions",
    "/api/v1/runs",
    "/api/v1/runs/{run_id}/approve",
    # Stopping a run is owner-or-admin like approving it, not role-gated; a
    # viewer can stop their own run (asserted in test_cancel_run.py).
    "/api/v1/runs/{run_id}/cancel",
    # POST but read-only (a query against the existing KB, no mutation),
    # available to every role like any other GET.
    "/api/v1/kb/search",
    "/api/v1/kb/retrieve",
    # POST but a dry-run with no persistence (phase 04's router preview),
    # available to every role like any other GET.
    "/api/v1/agents/{agent_id}/preview-route",
    # POST but read-only SQL re-execution against an already-readable
    # dashboard (phase 06) — refreshing only updates the cached snapshot,
    # never the dashboard's saved content, so it is available to any role
    # that can read the dashboard (including a viewer on a shared one),
    # like any other GET.
    "/api/v1/dashboards/{dashboard_id}/refresh",
    "/api/v1/dashboards/{dashboard_id}/widgets/{widget_id}/refresh",
    # Owner-managed, not role-gated: a viewer renames/archives/deletes their own
    # chats, votes on runs they can read and keeps their own memories (the
    # ownership rules are asserted in test_sessions_manage / test_memories /
    # test_run_feedback).
    "/api/v1/sessions/{session_id}",
    "/api/v1/runs/{run_id}/feedback",
    "/api/v1/memories",
    "/api/v1/memories/{memory_id}",
    # POST but read-only sandboxes (no run, nothing persisted), like any GET.
    "/api/v1/guardrails/test",
    "/api/v1/skills/route-test",
}


def _mutating_routes() -> list[tuple[str, str]]:
    """Every mutating (method, full path template) pair, read from the app's
    OpenAPI schema so it reflects the real `/api/v1` prefix regardless of how
    this FastAPI version nests included routers."""
    out: list[tuple[str, str]] = []
    for path, operations in app.openapi()["paths"].items():
        if path in _CHAT_EXEMPT_PATHS:
            continue
        for method in operations:
            if method.upper() in ("POST", "PATCH", "PUT", "DELETE"):
                out.append((method.upper(), path))
    return out


# A representative concrete URL + minimal valid body for each mutating
# route's path template, so the parametrized sweep below can actually issue
# the request rather than 422 on a placeholder path/body mismatch. The 403
# check must fire *before* any body validation or "does it exist" lookup —
# asserted implicitly by these bodies being well-formed.
_ROUTE_FIXTURES: dict[tuple[str, str], tuple[str, dict]] = {
    ("PATCH", "/api/v1/integrations/{tool_name}"): ("/api/v1/integrations/search_knowledge_base", {"enabled": False}),
    ("POST", "/api/v1/prompts"): (
        "/api/v1/prompts",
        {"slug": "irrelevant", "name": "irrelevant", "kind": "system", "content": "irrelevant"},
    ),
    ("PATCH", "/api/v1/prompts/{prompt_id}"): ("/api/v1/prompts/does-not-matter", {"name": "x"}),
    ("DELETE", "/api/v1/prompts/{prompt_id}"): ("/api/v1/prompts/does-not-matter", {}),
    ("POST", "/api/v1/prompts/{prompt_id}/versions"): (
        "/api/v1/prompts/does-not-matter/versions",
        {"content": "irrelevant"},
    ),
    ("POST", "/api/v1/prompts/{prompt_id}/versions/{version_id}/activate"): (
        "/api/v1/prompts/does-not-matter/versions/does-not-matter/activate",
        {},
    ),
    ("POST", "/api/v1/guardrails"): (
        "/api/v1/guardrails",
        {"name": "x", "kind": "severity_upgrade_block", "config": {}, "enabled": True},
    ),
    ("PATCH", "/api/v1/guardrails/{guardrail_id}"): ("/api/v1/guardrails/does-not-matter", {"enabled": False}),
    ("POST", "/api/v1/automations"): (
        "/api/v1/automations",
        {
            "name": "x",
            "trigger_service_name": "any",
            "trigger_status": "down",
            "objective_template": "x",
        },
    ),
    ("PATCH", "/api/v1/automations/{automation_id}"): ("/api/v1/automations/does-not-matter", {"enabled": False}),
    ("POST", "/api/v1/dashboards"): ("/api/v1/dashboards", {"name": "x", "template_key": "blank"}),
    ("PATCH", "/api/v1/dashboards/{dashboard_id}"): ("/api/v1/dashboards/does-not-matter", {"name": "x"}),
    ("DELETE", "/api/v1/dashboards/{dashboard_id}"): ("/api/v1/dashboards/does-not-matter", {}),
    ("POST", "/api/v1/dashboards/{dashboard_id}/widgets"): (
        "/api/v1/dashboards/does-not-matter/widgets",
        {"kind": "stat", "title": "x", "sql_query": "SELECT 1 AS value", "config": {"value_col": "value"}},
    ),
    ("PATCH", "/api/v1/dashboards/{dashboard_id}/widgets/{widget_id}"): (
        "/api/v1/dashboards/does-not-matter/widgets/does-not-matter",
        {"title": "x"},
    ),
    ("DELETE", "/api/v1/dashboards/{dashboard_id}/widgets/{widget_id}"): (
        "/api/v1/dashboards/does-not-matter/widgets/does-not-matter",
        {},
    ),
    ("POST", "/api/v1/dashboards/{dashboard_id}/widgets/reorder"): (
        "/api/v1/dashboards/does-not-matter/widgets/reorder",
        {"ids": ["does-not-matter"]},
    ),
    ("POST", "/api/v1/queries/preview"): (
        "/api/v1/queries/preview",
        {"sql_query": "SELECT 1 AS value", "kind": "stat", "config": {"value_col": "value"}},
    ),
    ("POST", "/api/v1/skills"): (
        "/api/v1/skills",
        {
            "slug": "irrelevant",
            "name": "irrelevant",
            "description": "irrelevant",
            "allowed_tools": ["get_service_status"],
        },
    ),
    ("PATCH", "/api/v1/skills/{skill_id}"): ("/api/v1/skills/does-not-matter", {"name": "x"}),
    ("DELETE", "/api/v1/skills/{skill_id}"): ("/api/v1/skills/does-not-matter", {}),
    ("POST", "/api/v1/agents"): (
        "/api/v1/agents",
        {"slug": "irrelevant", "name": "irrelevant", "prompt_id": "does-not-matter", "base_tools": []},
    ),
    ("PATCH", "/api/v1/agents/{agent_id}"): ("/api/v1/agents/does-not-matter", {"name": "x"}),
    ("DELETE", "/api/v1/agents/{agent_id}"): ("/api/v1/agents/does-not-matter", {}),
    ("POST", "/api/v1/services/{service_name}/status"): ("/api/v1/services/auth-service/status", {"status": "down"}),
    ("POST", "/api/v1/eval-runs"): ("/api/v1/eval-runs", {"scope": "mine"}),
    ("POST", "/api/v1/prompts/verify"): ("/api/v1/prompts/verify", {"content": "irrelevant", "kind": "system"}),
    ("POST", "/api/v1/prompts/{prompt_id}/versions/{version_id}/verify"): (
        "/api/v1/prompts/does-not-matter/versions/does-not-matter/verify",
        {"llm_review": False},
    ),
    ("POST", "/api/v1/dashboards/{dashboard_id}/duplicate"): ("/api/v1/dashboards/does-not-matter/duplicate", {}),
    ("POST", "/api/v1/kb"): ("/api/v1/kb", {"title": "x", "content": "irrelevant content that is long enough"}),
    ("DELETE", "/api/v1/kb/{doc_id}"): ("/api/v1/kb/does-not-matter", {}),
    ("POST", "/api/v1/kb/reindex"): ("/api/v1/kb/reindex", {}),
    ("POST", "/api/v1/agents/{agent_id}/clone"): ("/api/v1/agents/does-not-matter/clone", {}),
    ("POST", "/api/v1/incidents/{incident_id}/acknowledge"): ("/api/v1/incidents/does-not-matter/acknowledge", {}),
    ("POST", "/api/v1/incidents/{incident_id}/resolve"): ("/api/v1/incidents/does-not-matter/resolve", {"note": "x"}),
}


@pytest.mark.parametrize("method,path", _mutating_routes())
def test_viewer_gets_403_on_every_mutating_config_route(method, path):
    url, body = _ROUTE_FIXTURES[(method, path)]
    response = client.request(method, url, json=body, headers={"X-User-Id": "u_viewer"})
    assert response.status_code == 403, f"{method} {url} -> {response.status_code}: {response.text}"


def test_every_mutating_route_is_covered_by_the_fixture_table():
    """Guards against a future new mutating route silently skipping the 403
    sweep above because nobody added it to `_ROUTE_FIXTURES`."""
    routes = set(_mutating_routes())
    assert routes == set(_ROUTE_FIXTURES.keys())


def test_viewer_can_chat_create_session_and_run():
    session = client.post("/api/v1/sessions", json={"title": "viewer chat"}, headers={"X-User-Id": "u_viewer"})
    assert session.status_code == 201
    run = client.post(
        "/api/v1/runs",
        json={"objective": "Investigate auth-service.", "session_id": session.json()["id"]},
        headers={"X-User-Id": "u_viewer"},
    )
    assert run.status_code == 202


# --- editor cannot mutate another user's private resource -------------------


def test_editor_can_version_and_activate_their_own_private_prompt():
    """Prompts are per-owner + visibility-scoped (phase 02) — an editor may
    freely mutate a prompt they own."""
    created = client.post(
        "/api/v1/prompts",
        json={
            "slug": "editor-owned-prompt",
            "name": "Editor prompt",
            "kind": "system",
            "visibility": "private",
            "content": "editor prompt v1",
        },
        headers={"X-User-Id": "u_editor"},
    )
    assert created.status_code == 201
    prompt_id = created.json()["id"]

    version = client.post(
        f"/api/v1/prompts/{prompt_id}/versions",
        json={"content": "editor prompt v2"},
        headers={"X-User-Id": "u_editor"},
    )
    assert version.status_code == 201
    activate = client.post(
        f"/api/v1/prompts/{prompt_id}/versions/{version.json()['id']}/activate",
        headers={"X-User-Id": "u_editor"},
    )
    assert activate.status_code == 200


def test_editor_cannot_write_another_editors_private_prompt_and_cannot_see_it():
    created = client.post(
        "/api/v1/prompts",
        json={
            "slug": "editor-private-prompt",
            "name": "Editor private prompt",
            "kind": "system",
            "visibility": "private",
            "content": "v1",
        },
        headers={"X-User-Id": "u_editor"},
    )
    prompt_id = created.json()["id"]

    stranger_read = client.get(f"/api/v1/prompts/{prompt_id}", headers={"X-User-Id": "u_editor2"})
    assert stranger_read.status_code == 404

    stranger_write = client.patch(
        f"/api/v1/prompts/{prompt_id}", json={"name": "hijacked"}, headers={"X-User-Id": "u_editor2"}
    )
    assert stranger_write.status_code == 404

    admin_read = client.get(f"/api/v1/prompts/{prompt_id}", headers={"X-User-Id": "u_admin"})
    assert admin_read.status_code == 200


# --- session/run ownership: 404 for unreadable, visible to admin ------------


def test_session_owned_by_editor_is_404_to_editor2_but_visible_to_admin():
    created = client.post(
        "/api/v1/sessions", json={"title": "editor's private chat"}, headers={"X-User-Id": "u_editor"}
    )
    assert created.status_code == 201
    session_id = created.json()["id"]

    stranger = client.get(f"/api/v1/sessions/{session_id}", headers={"X-User-Id": "u_editor2"})
    assert stranger.status_code == 404

    owner = client.get(f"/api/v1/sessions/{session_id}", headers={"X-User-Id": "u_editor"})
    assert owner.status_code == 200

    admin = client.get(f"/api/v1/sessions/{session_id}", headers={"X-User-Id": "u_admin"})
    assert admin.status_code == 200


def test_session_list_filters_by_owner_except_for_admin():
    client.post("/api/v1/sessions", json={"title": "editor2 chat"}, headers={"X-User-Id": "u_editor2"})

    as_editor2 = client_as(client, "u_editor2")
    editor2_titles = {s["title"] for s in as_editor2.get("/api/v1/sessions").json()}
    assert "editor2 chat" in editor2_titles

    as_admin = client_as(client, "u_admin")
    admin_titles = {s["title"] for s in as_admin.get("/api/v1/sessions").json()}
    assert "editor2 chat" in admin_titles


def test_run_owned_by_one_user_404s_for_another_non_admin_user():
    created = client.post(
        "/api/v1/runs",
        json={"objective": "Investigate auth-service."},
        headers={"X-User-Id": "u_editor"},
    )
    assert created.status_code == 202
    run_id = created.json()["run_id"]

    stranger = client.get(f"/api/v1/runs/{run_id}", headers={"X-User-Id": "u_editor2"})
    assert stranger.status_code == 404

    owner = client.get(f"/api/v1/runs/{run_id}", headers={"X-User-Id": "u_editor"})
    assert owner.status_code == 200


# --- SSE identity via ?as_user= ---------------------------------------------


def test_sse_stream_requires_as_user_query_param_for_a_private_run():
    created = client.post(
        "/api/v1/runs",
        json={"objective": "Investigate auth-service."},
        headers={"X-User-Id": "u_editor"},
    )
    run_id = created.json()["run_id"]

    # No identity at all on the SSE request (EventSource can't set headers).
    # Explicit empty X-User-Id opts out of conftest's default-identity
    # injection (see `_default_test_client_identity`), simulating a request
    # with genuinely no usable identity.
    no_identity = client.get(f"/api/v1/runs/{run_id}/events", headers={"X-User-Id": ""})
    assert no_identity.status_code == 401

    # `headers={"X-User-Id": ""}` opts out of conftest's default-identity
    # injection (an absent `headers` kwarg would otherwise get `u_admin`
    # injected, which — being admin — can read everything, defeating this
    # test); `current_user` treats an empty header value as absent and
    # falls back to `as_user`, exactly the real `EventSource` case.
    stranger = client.get(
        f"/api/v1/runs/{run_id}/events", params={"as_user": "u_editor2"}, headers={"X-User-Id": ""}
    )
    assert stranger.status_code == 404

    owner = client.get(
        f"/api/v1/runs/{run_id}/events", params={"as_user": "u_editor"}, headers={"X-User-Id": ""}
    )
    assert owner.status_code == 200
