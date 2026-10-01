"""Prompt verification: deterministic lint rules, the optional LLM review,
persisted per-version results, and the activation gate (HTTP level)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import prompt_verification as pv  # noqa: E402
from agent_harness.llm_client import build_raising_router_model, build_router_model  # noqa: E402
from agent_harness.routers import prompts as prompts_router  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

EDITOR = {"X-User-Id": "u_editor"}
EDITOR2 = {"X-User-Id": "u_editor2"}
VIEWER = {"X-User-Id": "u_viewer"}

GOOD = (
    "You are an ops assistant. Check service status before escalating, cite runbooks, "
    "and keep answers short and factual."
)


def _rules(result: pv.LintResult) -> set[str]:
    return {i.rule for i in result.issues}


# --- lint rules (pure) -------------------------------------------------------


def test_good_prompt_passes_clean() -> None:
    result = pv.lint_prompt(GOOD)
    assert result.status == "pass" and result.issues == []


@pytest.mark.parametrize("content", ["", "   \n\t  "])
def test_empty_prompt_fails(content: str) -> None:
    result = pv.lint_prompt(content)
    assert result.status == "fail" and _rules(result) == {"empty"}


def test_too_short_is_a_warning_not_a_failure() -> None:
    result = pv.lint_prompt("Be helpful.")
    assert result.status == "warn" and _rules(result) == {"too_short"}


def test_length_thresholds() -> None:
    warn = pv.lint_prompt("word " * 900)  # 4500 chars
    assert warn.status == "warn" and "too_long" in _rules(warn)
    fail = pv.lint_prompt("word " * 1700)  # 8500 chars
    assert fail.status == "fail"
    assert [i.severity for i in fail.issues if i.rule == "too_long"] == ["error"]


def test_unsupported_placeholder_fails_and_supported_ones_pass() -> None:
    bad = pv.lint_prompt(GOOD + " Hello {{customer_name}}.")
    assert bad.status == "fail" and _rules(bad) == {"unsupported_placeholder"}
    assert "customer_name" in bad.issues[0].message
    ok = pv.lint_prompt(GOOD + " Today is {{ today }}; you are helping {{user_name}} ({{user_role}}).")
    assert ok.status == "pass"


def test_missing_required_placeholder_fails() -> None:
    result = pv.lint_prompt(GOOD, required_placeholders=["today"])
    assert result.status == "fail" and _rules(result) == {"missing_placeholder"}
    assert pv.lint_prompt(GOOD + " Date: {{today}}", required_placeholders=["today"]).status == "pass"


def test_stray_braces_warn() -> None:
    result = pv.lint_prompt(GOOD + "\nUse the {{ format here.")
    assert result.status == "warn" and "malformed_placeholder" in _rules(result)


def test_contradictory_instructions_are_flagged_with_both_line_numbers() -> None:
    content = (
        "You are an ops assistant that investigates outages carefully.\n"
        "Always call create_incident when a service is down.\n"
        "Never call create_incident without approval from a human.\n"
    )
    result = pv.lint_prompt(content)
    assert result.status == "warn"
    issue = next(i for i in result.issues if i.rule == "contradiction")
    assert "line 2" in issue.message and "line 3" in issue.message


def test_unrelated_always_and_never_are_not_contradictions() -> None:
    content = GOOD + "\nAlways cite doc ids.\nNever guess a service name.\n"
    assert "contradiction" not in _rules(pv.lint_prompt(content))


def test_opposed_style_pairs_are_flagged() -> None:
    result = pv.lint_prompt(GOOD + " Be concise. Also be verbose when explaining.")
    assert "contradiction" in _rules(result)


def test_seeded_library_prompts_all_lint_without_errors() -> None:
    from agent_harness.repos import prompts as prompts_repo

    for slug in ("ops-system", "skill-router", "eval-judge"):
        content, _ = prompts_repo.get_active_content(slug)
        assert pv.lint_prompt(content or "").status != "fail", slug


def test_render_placeholders_fills_only_supported_names() -> None:
    out = pv.render_placeholders(
        "Hi {{user_name}} ({{user_role}}) on {{today}}; keep {{other}}.",
        user_name="Evan",
        user_role="editor",
        today="2026-10-01",
    )
    assert out == "Hi Evan (editor) on 2026-10-01; keep {{other}}."


# --- LLM review (advisory) ---------------------------------------------------


def test_llm_review_returns_the_models_issues() -> None:
    model = build_router_model(
        {
            "summary": "Mostly fine.",
            "issues": [{"severity": "warning", "message": "No tool guidance.", "suggestion": "Name the tools."}],
        }
    )
    result = pv.llm_review(GOOD, kind="system", model_factory=lambda: model)
    assert result.status == "ok"
    assert [i.message for i in result.issues] == ["No tool guidance."]


def test_llm_review_degrades_instead_of_raising() -> None:
    unavailable = pv.llm_review(GOOD, kind="system", model_factory=lambda: None)
    assert unavailable.status == "unavailable"
    failing = pv.llm_review(GOOD, kind="system", model_factory=lambda: build_raising_router_model("boom secret"))
    assert failing.status == "error" and "boom" not in (failing.error or "")


def test_verify_skips_the_llm_review_when_lint_fails() -> None:
    called: list[int] = []

    def factory():
        called.append(1)
        return build_router_model({"summary": "", "issues": []})

    result = pv.verify("", kind="system", with_llm_review=True, model_factory=factory)
    assert result.lint.status == "fail" and result.llm_review is None and called == []


# --- HTTP: persisted per version, activation gate ----------------------------


@pytest.fixture(autouse=True)
def _review_model(monkeypatch):
    model_dict = {
        "summary": "Looks reasonable.",
        "issues": [{"severity": "info", "message": "Could name the tools.", "suggestion": "List them."}],
    }
    monkeypatch.setattr(prompts_router, "_review_model_factory", lambda: build_router_model(model_dict))


def _new_prompt(headers=EDITOR, **extra) -> dict:
    body = {"slug": "my-prompt", "name": "Mine", "kind": "system", "content": GOOD, "visibility": "shared", **extra}
    response = client.post("/api/v1/prompts", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def test_new_prompt_persists_its_verification_on_v1() -> None:
    prompt = _new_prompt()
    v1 = prompt["versions"][0]
    assert v1["verification"]["lint"]["status"] == "pass"
    assert prompt["active_version"]["id"] == v1["id"]


def test_creating_a_prompt_that_fails_lint_is_rejected_and_not_saved() -> None:
    response = client.post(
        "/api/v1/prompts",
        json={"slug": "bad", "name": "Bad", "kind": "system", "content": GOOD + " {{nope}}"},
        headers=EDITOR,
    )
    assert response.status_code == 422
    assert response.json()["detail"]["verification"]["lint"]["status"] == "fail"
    assert all(p["slug"] != "bad" for p in client.get("/api/v1/prompts", headers=EDITOR).json())


def test_failing_version_is_saved_but_not_activated_and_cannot_be_activated() -> None:
    prompt = _new_prompt()
    created = client.post(
        f"/api/v1/prompts/{prompt['id']}/versions",
        json={"content": "", "activate": True},
        headers=EDITOR,
    )
    # Empty content is rejected by request validation; use a lint-failing one instead.
    assert created.status_code == 422
    created = client.post(
        f"/api/v1/prompts/{prompt['id']}/versions",
        json={"content": GOOD + " Hi {{unknown_var}}", "activate": True, "change_note": "broken"},
        headers=EDITOR,
    )
    assert created.status_code == 201
    body = created.json()
    assert body["activated"] is False and "lint failed" in body["activation_blocked"]
    assert body["verification"]["lint"]["status"] == "fail"

    detail = client.get(f"/api/v1/prompts/{prompt['id']}", headers=EDITOR).json()
    assert detail["active_version"]["version"] == 1, "the broken version must not become active"
    assert detail["versions"][0]["verification"]["lint"]["issues"][0]["rule"] == "unsupported_placeholder"

    blocked = client.post(f"/api/v1/prompts/{prompt['id']}/versions/{body['id']}/activate", headers=EDITOR)
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["verification"]["lint"]["status"] == "fail"
    assert client.get(f"/api/v1/prompts/{prompt['id']}", headers=EDITOR).json()["active_version"]["version"] == 1


def test_passing_version_activates_immediately_and_old_versions_can_be_rolled_back_to() -> None:
    prompt = _new_prompt()
    v1_id = prompt["versions"][0]["id"]
    created = client.post(
        f"/api/v1/prompts/{prompt['id']}/versions",
        json={"content": GOOD + " Prefer bullet points.", "activate": True},
        headers=EDITOR,
    ).json()
    assert created["activated"] is True and created["activation_blocked"] is None
    assert client.get(f"/api/v1/prompts/{prompt['id']}", headers=EDITOR).json()["active_version"]["version"] == 2

    rolled = client.post(f"/api/v1/prompts/{prompt['id']}/versions/{v1_id}/activate", headers=EDITOR)
    assert rolled.status_code == 200 and rolled.json()["active_version"]["version"] == 1


def test_llm_review_is_stored_when_requested_and_advisory_only() -> None:
    prompt = _new_prompt()
    created = client.post(
        f"/api/v1/prompts/{prompt['id']}/versions",
        json={"content": GOOD + " More.", "activate": True, "llm_review": True},
        headers=EDITOR,
    ).json()
    review = created["verification"]["llm_review"]
    assert review["status"] == "ok" and review["issues"][0]["message"] == "Could name the tools."
    assert created["activated"] is True  # an LLM remark never blocks activation


def test_reverify_adds_the_llm_review_to_an_existing_version() -> None:
    prompt = _new_prompt()
    v1 = prompt["versions"][0]
    assert v1["verification"]["llm_review"] is None
    response = client.post(
        f"/api/v1/prompts/{prompt['id']}/versions/{v1['id']}/verify", json={"llm_review": True}, headers=EDITOR
    )
    assert response.status_code == 200
    assert response.json()["verification"]["llm_review"]["status"] == "ok"
    persisted = client.get(f"/api/v1/prompts/{prompt['id']}", headers=EDITOR).json()["versions"][0]
    assert persisted["verification"]["llm_review"]["status"] == "ok"


def test_draft_verification_does_not_persist_anything() -> None:
    before = client.get("/api/v1/prompts", headers=EDITOR).json()
    response = client.post(
        "/api/v1/prompts/verify",
        json={"content": "Always call x_tool.\nNever call x_tool.", "kind": "system", "llm_review": True},
        headers=EDITOR,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["lint"]["status"] in ("warn", "fail")
    assert client.get("/api/v1/prompts", headers=EDITOR).json() == before


def test_required_placeholders_gate_new_versions_and_are_validated() -> None:
    prompt = _new_prompt(slug="dated", content=GOOD + " Today is {{today}}.", required_placeholders=["today"])
    assert prompt["required_placeholders"] == ["today"]
    created = client.post(
        f"/api/v1/prompts/{prompt['id']}/versions", json={"content": GOOD, "activate": True}, headers=EDITOR
    ).json()
    assert created["activated"] is False
    assert created["verification"]["lint"]["issues"][0]["rule"] == "missing_placeholder"
    bad = client.post(
        "/api/v1/prompts",
        json={"slug": "x", "name": "x", "kind": "system", "content": GOOD, "required_placeholders": ["bogus"]},
        headers=EDITOR,
    )
    assert bad.status_code == 422


def test_version_history_reports_usage_counts() -> None:
    from agent_harness import db

    prompt = _new_prompt(slug="counted")
    v1 = prompt["versions"][0]["id"]
    assert prompt["versions"][0]["run_count"] == 0 and prompt["versions"][0]["pinned_agents"] == 0
    with db.connect() as conn:
        for run_id in ("r-1", "r-2"):
            conn.execute(
                "INSERT INTO runs (run_id, objective, status, started_at, owner_id, prompt_version_id) "
                "VALUES (%s, 'o', 'completed', 1.0, 'u_editor', %s)",
                (run_id, v1),
            )
    agent = client.post(
        "/api/v1/agents",
        json={"slug": "pinned", "name": "Pinned", "prompt_id": prompt["id"], "prompt_version_id": v1, "base_tools": []},
        headers=EDITOR,
    )
    assert agent.status_code == 201, agent.text
    version = client.get(f"/api/v1/prompts/{prompt['id']}", headers=EDITOR).json()["versions"][0]
    assert version["run_count"] == 2 and version["pinned_agents"] == 1


def test_verification_endpoints_respect_rbac_and_ownership() -> None:
    prompt = _new_prompt(visibility="private")
    v1 = prompt["versions"][0]["id"]
    assert client.post("/api/v1/prompts/verify", json={"content": GOOD, "kind": "system"}, headers=VIEWER).status_code == 403
    assert (
        client.post(
            f"/api/v1/prompts/{prompt['id']}/versions/{v1}/verify", json={"llm_review": False}, headers=VIEWER
        ).status_code
        == 403
    )
    # Another editor cannot even see this private prompt.
    assert (
        client.post(
            f"/api/v1/prompts/{prompt['id']}/versions/{v1}/verify", json={"llm_review": False}, headers=EDITOR2
        ).status_code
        == 404
    )
