"""SQLite persistence: created incidents are readable back, the
create_incident idempotency guard works, and runs/events survive a fresh
`RunRegistry` instance pointed at the same DB (simulating a process
restart, since `RunRegistry` itself is in-memory-only by design)."""

from __future__ import annotations

from agent_harness import db
from agent_harness.llm_client import build_scripted_model
from agent_harness.run_registry import RunRegistry


def test_created_incident_is_readable_back(tools):
    from agent_harness.tools.create_incident import CreateIncidentInput

    tool = tools["create_incident"]
    tool.bind_context(run_id="run-abc")
    output = tool.run(
        CreateIncidentInput(title="search-index is down", description="desc", severity="high")
    )

    rows = db.list_incidents()
    assert any(r["id"] == output.incident_id for r in rows)
    row = next(r for r in rows if r["id"] == output.incident_id)
    assert row["title"] == "search-index is down"
    assert row["run_id"] == "run-abc"


def test_create_incident_idempotent_within_same_run(tools):
    from agent_harness.tools.create_incident import CreateIncidentInput

    tool = tools["create_incident"]
    tool.bind_context(run_id="run-xyz")
    args = CreateIncidentInput(title="dup title", description="d", severity="medium")

    first = tool.run(args)
    second = tool.run(args)

    assert first.incident_id == second.incident_id
    rows = [r for r in db.list_incidents() if r["run_id"] == "run-xyz" and r["title"] == "dup title"]
    assert len(rows) == 1


def test_create_incident_not_idempotent_across_different_runs(tools):
    from agent_harness.tools.create_incident import CreateIncidentInput

    tool = tools["create_incident"]
    args = CreateIncidentInput(title="same title", description="d", severity="low")

    tool.bind_context(run_id="run-1")
    first = tool.run(args)
    tool.bind_context(run_id="run-2")
    second = tool.run(args)

    assert first.incident_id != second.incident_id


def test_service_status_flip_is_persisted():
    from datetime import datetime, timezone

    updated = db.set_service_status("payments-api", "down", datetime.now(timezone.utc).isoformat())
    assert updated is not None
    assert updated["status"] == "down"

    row = db.get_service("payments-api")
    assert row["status"] == "down"


def test_set_service_status_unknown_service_returns_none():
    from datetime import datetime, timezone

    assert db.set_service_status("does-not-exist", "down", datetime.now(timezone.utc).isoformat()) is None


def test_runs_survive_registry_reinstantiation(runs_dir):
    """Start and complete a run on one RunRegistry, then read it back via a
    brand-new RunRegistry (simulating an API process restart) using only
    the persisted SQLite rows, not any in-memory state."""
    script = [
        {
            "action": "tool_call",
            "tool_name": "get_service_status",
            "tool_args": {"service_name": "auth-service"},
        },
        {"action": "final_answer", "final_answer": "auth-service is operational."},
    ]

    registry_before_restart = RunRegistry(default_runs_dir=str(runs_dir))
    record = registry_before_restart.start_run(
        objective="What is the status of auth-service?",
        model=build_scripted_model(script),
    )
    run_id = record.run_id

    import time

    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        snap = registry_before_restart.snapshot(run_id)
        if snap and snap["status"] not in ("running", "pending_approval"):
            break
        time.sleep(0.02)
    else:
        raise AssertionError("run did not leave running/pending_approval within 20s")

    # Simulate a restart: a fresh RunRegistry has no in-memory knowledge of
    # this run at all.
    registry_after_restart = RunRegistry(default_runs_dir=str(runs_dir))
    assert registry_after_restart.get(run_id) is None

    persisted = db.get_run(run_id)
    assert persisted is not None
    assert persisted["status"] == "completed"
    assert persisted["final_answer"] == "auth-service is operational."
    assert len(persisted["history"]) > 0
    event_types = [e["event_type"] for e in persisted["history"]]
    assert "tool_call_result" in event_types
    assert "final_answer" in event_types


def test_list_runs_includes_persisted_run_after_completion(runs_dir):
    script = [{"action": "final_answer", "final_answer": "Done."}]
    registry = RunRegistry(default_runs_dir=str(runs_dir))
    record = registry.start_run(
        objective="Trivial objective", model=build_scripted_model(script)
    )

    import time

    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        snap = registry.snapshot(record.run_id)
        if snap and snap["status"] not in ("running", "pending_approval"):
            break
        time.sleep(0.02)
    else:
        raise AssertionError("run did not leave running/pending_approval within 20s")

    rows = db.list_runs()
    assert any(r["run_id"] == record.run_id for r in rows)
