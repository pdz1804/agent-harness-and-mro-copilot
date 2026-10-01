"""End-to-end tests for the /copilot FastAPI router (runs, resolve, cancel,
pending inbox, meta, automations CRUD) -- driven through the real ASGI app
with a tmp-file sqlite database. Work-order scenarios drive the default
offline-scripted router (``src.copilot.models._route``) with a prompt that
names the real, compound component/aircraft ids returned by
``/fleet/top-risk`` (e.g. ``AC-003-APU_STARTER`` on ``AC-003``) rather than
a hand-scripted ``FunctionModel`` -- the router's id-extraction regex
handles this dataset's compound component ids correctly. Streaming/SSE-
specific tests live in ``tests/test_sse_stream.py``; fleet-scan automation
dispatch tests live in ``tests/test_automations.py``.
"""

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
    db_url = f"sqlite:///{tmp_path / 'ops.db'}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    with TestClient(app) as c:
        yield c


def _wait_for_status(client, run_id, statuses, timeout=15.0):
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


def test_start_run_completes_with_offline_model(client):
    resp = client.post("/copilot/runs", json={"prompt": "show me the top risk components"})
    assert resp.status_code == 202
    run_id = resp.json()["run_id"]

    snapshot = _wait_for_status(client, run_id, {"completed"})
    assert snapshot["final_answer"]
    assert snapshot["model_name"] == "offline-scripted"
    assert any(m["role"] == "user" for m in snapshot["messages"])


def _wo_scenario(client):
    """Return a real fleet row and the prompt that drives the default
    offline-scripted router (``_route``) straight to ``create_work_order``
    for it: the prompt must name the real compound component id (e.g.
    ``AC-003-APU_STARTER``) and its aircraft id (``AC-003``) plus a
    "work order" trigger phrase -- ``_route`` extracts both ids from the
    prompt text itself, it does not need a hand-scripted model."""
    row = client.get("/fleet/top-risk?n=1").json()["items"][0]
    prompt = (
        f"The component {row['component_id']} on aircraft {row['aircraft_id']} looks "
        "risky, please raise a work order for it."
    )
    return row, prompt


def test_approval_flow_end_to_end_and_double_resolve_is_409(client):
    row, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]

    snapshot = _wait_for_status(client, run_id, {"awaiting_input"})
    assert len(snapshot["pending"]) == 1
    pending = snapshot["pending"][0]
    assert pending["kind"] == "approval"
    assert pending["tool_name"] == "create_work_order"

    resolve_body = {"resolutions": [{"pending_id": pending["id"], "decision": "approve"}]}
    resp = client.post(
        f"/copilot/runs/{run_id}/resolve", json=resolve_body, headers={"X-User": "lead.engineer"},
    )
    assert resp.status_code == 202

    final = _wait_for_status(client, run_id, {"completed"})
    assert final["final_answer"]

    # second resolve: nothing is left pending, so it's rejected either as a
    # 409 (run no longer awaiting_input) or 422 (unknown/non-pending id).
    resp2 = client.post(f"/copilot/runs/{run_id}/resolve", json=resolve_body)
    assert resp2.status_code in (409, 422)

    wos = client.get("/ops/work-orders").json()
    matching = [w for w in wos if w["component_id"] == row["component_id"] and w["approved_by"] == "lead.engineer"]
    assert matching, f"expected an approved work order for {row['component_id']}, got {wos}"


def test_pending_args_is_never_the_raw_wrapped_shape(client):
    """Regression test for the real bug: ``pending.args`` used to arrive as
    ``{"raw": "<json string>", "_opened_at": "..."}`` (``ToolCallPart.args``
    is a JSON ``str`` from real model backends and was wrapped instead of
    parsed with ``args_as_dict()``). ``args`` must always be the real,
    parsed tool-args dict with none of the internal bookkeeping keys."""
    row, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]
    snapshot = _wait_for_status(client, run_id, {"awaiting_input"})
    pending = snapshot["pending"][0]

    assert pending["tool_name"] == "create_work_order"
    assert "raw" not in pending["args"]
    assert "_opened_at" not in pending["args"]
    assert pending["args"]["aircraft_id"] == row["aircraft_id"]
    assert pending["args"]["component_id"] == row["component_id"]
    assert pending["args"]["priority"] in {"routine", "urgent", "aog"}


def test_ui_shaped_resolve_plain_approve_sends_no_override_args_and_creates_exactly_one_wo(client):
    """Exactly what the fixed dashboard sends for a plain Approve with no
    edits: no ``override_args`` key at all. Must create exactly one work
    order and must NOT loop into a second approval card."""
    row, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]
    snapshot = _wait_for_status(client, run_id, {"awaiting_input"})
    pending = snapshot["pending"][0]

    resp = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{"pending_id": pending["id"], "decision": "approve"}]},
        headers={"X-User": "lead.engineer"},
    )
    assert resp.status_code == 202

    final = _wait_for_status(client, run_id, {"completed"})
    assert final["final_answer"]
    assert final["pending"] == []  # no second card -- proves the loop is fixed

    wos = client.get("/ops/work-orders").json()
    matching = [w for w in wos if w["component_id"] == row["component_id"]]
    assert len(matching) == 1, f"expected exactly one work order, got {matching}"
    assert matching[0]["approved_by"] == "lead.engineer"


def test_ui_shaped_resolve_with_edited_priority_overrides_only_that_field(client):
    """Exactly what the fixed dashboard sends when the human edits the
    priority select before approving: ``override_args`` contains ONLY the
    changed field."""
    row, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]
    snapshot = _wait_for_status(client, run_id, {"awaiting_input"})
    pending = snapshot["pending"][0]
    new_priority = "aog" if pending["args"]["priority"] != "aog" else "urgent"

    resp = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{
            "pending_id": pending["id"], "decision": "approve",
            "override_args": {"priority": new_priority},
        }]},
        headers={"X-User": "lead.engineer"},
    )
    assert resp.status_code == 202

    _wait_for_status(client, run_id, {"completed"})
    wos = client.get("/ops/work-orders").json()
    matching = [w for w in wos if w["component_id"] == row["component_id"]]
    assert len(matching) == 1
    assert matching[0]["priority"] == new_priority


def test_stale_bookkeeping_keys_in_override_args_are_rejected_422(client):
    """A client that still echoes back the reserved ``_opened_at`` key (the
    exact shape the old buggy dashboard used to send) must be rejected with
    a 422, never silently accepted or passed to the tool."""
    _, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]
    snapshot = _wait_for_status(client, run_id, {"awaiting_input"})
    pending = snapshot["pending"][0]

    resp = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{
            "pending_id": pending["id"], "decision": "approve",
            "override_args": {"_opened_at": "2026-01-01T00:00:00+00:00", "priority": "aog"},
        }]},
    )
    assert resp.status_code == 422

    # the run must still be resolvable/awaiting_input afterwards -- a
    # rejected resolve() call must not corrupt the pending item.
    snapshot2 = client.get(f"/copilot/runs/{run_id}").json()
    assert snapshot2["status"] == "awaiting_input"


def test_unknown_override_args_key_is_rejected_422(client):
    _, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]
    snapshot = _wait_for_status(client, run_id, {"awaiting_input"})
    pending = snapshot["pending"][0]

    resp = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{
            "pending_id": pending["id"], "decision": "approve",
            "override_args": {"not_a_real_param": "x"},
        }]},
    )
    assert resp.status_code == 422


def test_resolve_with_missing_pending_ids_is_422(client):
    _, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]
    _wait_for_status(client, run_id, {"awaiting_input"})

    resp = client.post(f"/copilot/runs/{run_id}/resolve", json={"resolutions": []})
    assert resp.status_code == 422


def test_ask_user_option_and_free_text_resolution(client):
    run_id = client.post("/copilot/runs", json={"prompt": "check the pump"}).json()["run_id"]
    snapshot = _wait_for_status(client, run_id, {"awaiting_input"})
    pending = snapshot["pending"][0]
    assert pending["kind"] == "ask_user"
    assert len(pending["question"]["options"]) >= 2

    resp = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{"pending_id": pending["id"], "decision": "answer",
                                 "option_id": pending["question"]["options"][0]["id"]}]},
    )
    assert resp.status_code == 202
    final = _wait_for_status(client, run_id, {"completed"})
    assert final["final_answer"]


def test_ask_user_resolved_by_free_text(client):
    run_id = client.post("/copilot/runs", json={"prompt": "check the pump"}).json()["run_id"]
    snapshot = _wait_for_status(client, run_id, {"awaiting_input"})
    pending = snapshot["pending"][0]
    assert pending["kind"] == "ask_user"

    resp = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{"pending_id": pending["id"], "decision": "answer",
                                 "answer_text": "I mean the HYD_PUMP on AC-001"}]},
    )
    assert resp.status_code == 202
    final = _wait_for_status(client, run_id, {"completed"})
    assert final["final_answer"]


def test_cancel_pending_run_denies_and_completes(client):
    row, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]
    _wait_for_status(client, run_id, {"awaiting_input"})

    resp = client.post(f"/copilot/runs/{run_id}/cancel")
    assert resp.status_code == 200
    assert resp.json()["status"] == "completed"

    wos = client.get("/ops/work-orders").json()
    assert not any(w["component_id"] == row["component_id"] for w in wos)


def test_pending_inbox_and_meta(client):
    _, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]
    _wait_for_status(client, run_id, {"awaiting_input"})

    inbox = client.get("/copilot/pending").json()
    assert any(p["run_id"] == run_id for p in inbox)

    meta = client.get("/copilot/meta").json()
    assert meta["mode"] == "offline-scripted"
    assert "create_work_order" in meta["approval_gated_tools"]
    assert len(meta["tools"]) >= 6


def test_automations_crud(client):
    resp = client.get("/copilot/automations")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1  # seeded default rule

    created = client.post("/copilot/automations", json={
        "name": "test rule", "trigger": "alert_opened", "condition": {"min_risk": 0.9},
        "prompt_template": "Triage {alert_id}", "enabled": True,
    }).json()
    assert created["enabled"] is True

    patched = client.patch(f"/copilot/automations/{created['id']}", json={"enabled": False}).json()
    assert patched["enabled"] is False


# --------------------------------------------------------------------------
# Identity / roles (task item #2): a seeded "viewer" user must not be able
# to resolve an approval-gated pending item; the response is a real 403,
# never a silent no-op or a 200 that quietly ignores the decision.
# --------------------------------------------------------------------------


def test_meta_exposes_seeded_users_for_the_dashboards_identity_picker(client):
    meta = client.get("/copilot/meta").json()
    ids = {u["id"] for u in meta["seeded_users"]}
    assert {"lead.engineer", "planner", "viewer"} <= ids
    viewer = next(u for u in meta["seeded_users"] if u["id"] == "viewer")
    assert viewer["role"] == "viewer"


def test_viewer_cannot_approve_gets_403_and_pending_item_is_untouched(client):
    _, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]
    snapshot = _wait_for_status(client, run_id, {"awaiting_input"})
    pending = snapshot["pending"][0]

    resp = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{"pending_id": pending["id"], "decision": "approve"}]},
        headers={"X-User": "viewer"},
    )
    assert resp.status_code == 403

    # the pending item must still be there, resolvable by an allowed user --
    # a rejected resolve() must never partially consume/mark it resolved.
    snapshot2 = client.get(f"/copilot/runs/{run_id}").json()
    assert snapshot2["status"] == "awaiting_input"
    assert len(snapshot2["pending"]) == 1
    assert snapshot2["pending"][0]["id"] == pending["id"]

    ok_resp = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{"pending_id": pending["id"], "decision": "approve"}]},
        headers={"X-User": "lead.engineer"},
    )
    assert ok_resp.status_code == 202
    _wait_for_status(client, run_id, {"completed"})


def test_viewer_cannot_deny_either(client):
    """The 403 gate covers any resolution of an approval-kind pending item,
    not just 'approve' -- denying is also an operational decision."""
    _, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]
    snapshot = _wait_for_status(client, run_id, {"awaiting_input"})
    pending = snapshot["pending"][0]

    resp = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{"pending_id": pending["id"], "decision": "deny"}]},
        headers={"X-User": "viewer"},
    )
    assert resp.status_code == 403


def test_viewer_can_still_answer_ask_user_questions(client):
    """Only approval-kind items are role-gated -- a viewer may still answer
    a clarifying question (no write action happens on that path)."""
    run_id = client.post("/copilot/runs", json={"prompt": "check the pump"}).json()["run_id"]
    snapshot = _wait_for_status(client, run_id, {"awaiting_input"})
    pending = snapshot["pending"][0]
    assert pending["kind"] == "ask_user"

    resp = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{"pending_id": pending["id"], "decision": "answer",
                                 "answer_text": "the HYD_PUMP on AC-001"}]},
        headers={"X-User": "viewer"},
    )
    assert resp.status_code == 202


# --------------------------------------------------------------------------
# Legacy pending cleanup (task item #4): pre-fix pending rows whose
# args_json predates the normalization fix (the {"raw": <json string>}
# shape) must be auto-cancelled, visible as "stale -- cancelled", and never
# resolvable/executable -- audit rows themselves are never deleted.
# --------------------------------------------------------------------------


def test_cleanup_legacy_pending_cancels_raw_shaped_rows_idempotently(client):
    from src.copilot import hitl
    from src.service.routers import copilot as copilot_router_mod

    engine = copilot_router_mod._module_state["manager"].engine  # noqa: SLF001
    run_id = client.post("/copilot/runs", json={"prompt": "show me the top risk components"}).json()["run_id"]
    _wait_for_status(client, run_id, {"completed"})

    # Simulate a pre-fix row: the historical {"raw": <json string>} shape,
    # inserted directly (this predates any code path that could produce it
    # today -- that's the bug this cleanup targets).
    import json as json_mod

    from src.ops.db import copilot_pending

    with engine.connect() as conn:
        conn.execute(copilot_pending.insert().values(
            id="pend-legacy-test-1", run_id=run_id, tool_call_id="call-legacy-1",
            kind="approval", tool_name="create_work_order",
            args_json=json_mod.dumps({"raw": '{"aircraft_id": "AC-001"}'}),
            question_json=None, status="pending", resolution_json=None,
            resolved_by=None, resolved_at=None,
        ))
        conn.commit()

    cleaned = hitl.cleanup_legacy_pending(engine)
    assert cleaned >= 1

    snapshot = client.get(f"/copilot/runs/{run_id}").json()
    legacy_items = [p for p in snapshot["pending"] if p["id"] == "pend-legacy-test-1"]
    assert len(legacy_items) == 1
    assert legacy_items[0]["status"] == hitl.LEGACY_STALE_STATUS
    assert legacy_items[0]["is_stale"] is True

    # never resolvable -- it's not in the "pending" global inbox anymore...
    inbox = client.get("/copilot/pending").json()
    assert not any(p["id"] == "pend-legacy-test-1" for p in inbox)

    # ...and the audit row itself still exists (never deleted).
    with engine.connect() as conn:
        row = conn.execute(
            copilot_pending.select().where(copilot_pending.c.id == "pend-legacy-test-1")
        ).mappings().first()
    assert row is not None
    assert row["status"] == hitl.LEGACY_STALE_STATUS

    # idempotent: a second run finds nothing left to clean for this row.
    second_pass = hitl.cleanup_legacy_pending(engine)
    with engine.connect() as conn:
        still = conn.execute(
            copilot_pending.select().where(copilot_pending.c.id == "pend-legacy-test-1")
        ).mappings().first()
    assert still["resolved_at"] == row["resolved_at"]  # untouched by the second pass
    assert second_pass == 0


def test_resume_turn_marks_run_running_on_the_server_while_in_flight(client, monkeypatch):
    """A second tab must see ``running`` (not ``awaiting_input``) during a resume."""
    import asyncio
    import threading

    from src.copilot.runs import RunManager

    _, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]
    pending = _wait_for_status(client, run_id, {"awaiting_input"})["pending"][0]

    release = threading.Event()

    async def _blocked_turn(self, run_id, **_kwargs):
        while not release.is_set():
            await asyncio.sleep(0.02)

    monkeypatch.setattr(RunManager, "_execute_turn", _blocked_turn)
    try:
        resp = client.post(
            f"/copilot/runs/{run_id}/resolve", headers={"X-User": "lead.engineer"},
            json={"resolutions": [{"pending_id": pending["id"], "decision": "approve"}]},
        )
        assert resp.status_code == 202
        assert client.get(f"/copilot/runs/{run_id}").json()["status"] == "running"
        listed = {r["id"]: r for r in client.get("/copilot/runs").json()}
        if run_id in listed:
            assert listed[run_id]["status"] == "running"
    finally:
        release.set()


def test_run_snapshot_exposes_resolved_items_with_actor_time_and_note(client):
    _, prompt = _wo_scenario(client)
    run_id = client.post("/copilot/runs", json={"prompt": prompt}).json()["run_id"]
    pending = _wait_for_status(client, run_id, {"awaiting_input"})["pending"][0]
    client.post(
        f"/copilot/runs/{run_id}/resolve", headers={"X-User": "lead.engineer"},
        json={"resolutions": [{"pending_id": pending["id"], "decision": "deny",
                               "answer_text": "defer to next A-check"}]},
    )
    final = _wait_for_status(client, run_id, {"completed"})
    resolved = [r for r in final["resolved"] if r["id"] == pending["id"]]
    assert len(resolved) == 1
    r = resolved[0]
    assert r["tool_call_id"] == pending["tool_call_id"]
    assert r["tool_name"] == "create_work_order"
    assert r["decision"] == "deny"
    assert r["resolved_by"] == "lead.engineer"
    assert r["resolved_at"]
    assert r["note"] == "defer to next A-check"
    # the snapshot's tool_call carries the same id, so the UI can attach the decision to its block
    call_ids = {m.get("tool_call_id") for m in final["messages"] if m["role"] == "tool_call"}
    assert pending["tool_call_id"] in call_ids
