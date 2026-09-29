"""SQLite persistence: services, incidents, runs, and run events.

A short-lived connection is opened per call (`connect()` context manager)
rather than held open for the process lifetime. This keeps the module
trivially thread-safe for the harness's threading model (each async run
executes on its own `threading.Thread` — see `run_registry.py`) without
needing a connection pool for what is a low-throughput demo backend.

All paths default to `agent_harness.settings` but accept an explicit
`db_path`/`seed_path` override so tests can point at an isolated tmp
database without monkeypatching global state everywhere.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

from agent_harness import settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS services (
    name TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    latency_ms REAL,
    error_rate REAL,
    last_deploy TEXT,
    owner TEXT,
    last_checked TEXT
);

CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_run_title ON incidents(run_id, title);

CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at REAL NOT NULL,
    finished_at REAL,
    final_answer TEXT,
    steps_taken INTEGER DEFAULT 0,
    trace_path TEXT,
    error TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    step INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    timestamp REAL NOT NULL,
    latency_ms REAL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
"""


def get_db_path() -> Path:
    return settings.DB_PATH


@contextmanager
def connect(db_path: Optional[Path] = None) -> Iterator[sqlite3.Connection]:
    path = Path(db_path) if db_path is not None else get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10.0)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(db_path: Optional[Path] = None) -> None:
    with connect(db_path) as conn:
        conn.executescript(_SCHEMA)


def seed_services(db_path: Optional[Path] = None, seed_path: Optional[Path] = None) -> int:
    """Seed `services` from the seed JSON file, only if the table is empty.

    Returns the number of rows inserted (0 if already seeded or the seed
    file is missing).
    """
    seed_file = Path(seed_path) if seed_path is not None else settings.SEED_SERVICES_PATH
    with connect(db_path) as conn:
        count = conn.execute("SELECT COUNT(*) FROM services").fetchone()[0]
        if count > 0 or not seed_file.exists():
            return 0
        services = json.loads(seed_file.read_text(encoding="utf-8"))
        for svc in services:
            conn.execute(
                "INSERT INTO services "
                "(name, status, latency_ms, error_rate, last_deploy, owner, last_checked) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    svc["name"],
                    svc["status"],
                    svc.get("latency_ms"),
                    svc.get("error_rate"),
                    svc.get("last_deploy"),
                    svc.get("owner"),
                    svc.get("last_checked"),
                ),
            )
        return len(services)


def ensure_ready(db_path: Optional[Path] = None, seed_path: Optional[Path] = None) -> None:
    """Create tables if missing and seed services if the table is empty.
    Idempotent — safe to call on every process start."""
    init_db(db_path)
    seed_services(db_path, seed_path)


# --- services -----------------------------------------------------------


def get_service(name: str, db_path: Optional[Path] = None) -> Optional[dict[str, Any]]:
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM services WHERE name = ?", (name,)).fetchone()
        return dict(row) if row else None


def list_services(db_path: Optional[Path] = None) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute("SELECT * FROM services ORDER BY name").fetchall()
        return [dict(r) for r in rows]


def set_service_status(
    name: str, status: str, checked_at: str, db_path: Optional[Path] = None
) -> Optional[dict[str, Any]]:
    """Flip a service's status (used by the demo 'Services' UI page so a
    reviewer can create real degraded/down scenarios). Returns the updated
    row, or None if `name` is not a known service."""
    with connect(db_path) as conn:
        cur = conn.execute(
            "UPDATE services SET status = ?, last_checked = ? WHERE name = ?",
            (status, checked_at, name),
        )
        if cur.rowcount == 0:
            return None
        row = conn.execute("SELECT * FROM services WHERE name = ?", (name,)).fetchone()
        return dict(row)


# --- incidents ------------------------------------------------------------


def find_incident(run_id: str, title: str, db_path: Optional[Path] = None) -> Optional[dict[str, Any]]:
    """Idempotency lookup: has this exact run already created an incident
    with this title? Empty/blank `run_id` never matches (no idempotency
    scope outside a run)."""
    if not run_id:
        return None
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM incidents WHERE run_id = ? AND title = ?", (run_id, title)
        ).fetchone()
        return dict(row) if row else None


def insert_incident(
    incident_id: str,
    title: str,
    description: str,
    severity: str,
    status: str,
    created_at: str,
    run_id: str,
    db_path: Optional[Path] = None,
) -> dict[str, Any]:
    with connect(db_path) as conn:
        conn.execute(
            "INSERT INTO incidents (id, title, description, severity, status, created_at, run_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (incident_id, title, description, severity, status, created_at, run_id),
        )
    return {
        "id": incident_id,
        "title": title,
        "description": description,
        "severity": severity,
        "status": status,
        "created_at": created_at,
        "run_id": run_id,
    }


def list_incidents(db_path: Optional[Path] = None) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute("SELECT * FROM incidents ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]


# --- runs / events ----------------------------------------------------------


def upsert_run(record: dict[str, Any], db_path: Optional[Path] = None) -> None:
    with connect(db_path) as conn:
        conn.execute(
            "INSERT INTO runs (run_id, objective, status, started_at, finished_at, "
            "final_answer, steps_taken, trace_path, error) "
            "VALUES (:run_id, :objective, :status, :started_at, :finished_at, "
            ":final_answer, :steps_taken, :trace_path, :error) "
            "ON CONFLICT(run_id) DO UPDATE SET "
            "status=excluded.status, finished_at=excluded.finished_at, "
            "final_answer=excluded.final_answer, steps_taken=excluded.steps_taken, "
            "error=excluded.error",
            record,
        )


def append_event(
    run_id: str,
    step: int,
    event_type: str,
    timestamp: float,
    latency_ms: Optional[float],
    data: dict[str, Any],
    db_path: Optional[Path] = None,
) -> None:
    with connect(db_path) as conn:
        conn.execute(
            "INSERT INTO events (run_id, step, event_type, timestamp, latency_ms, data) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (run_id, step, event_type, timestamp, latency_ms, json.dumps(data, default=str)),
        )


def list_runs(db_path: Optional[Path] = None) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute("SELECT * FROM runs ORDER BY started_at DESC").fetchall()
        return [dict(r) for r in rows]


def get_run(run_id: str, db_path: Optional[Path] = None) -> Optional[dict[str, Any]]:
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            return None
        run = dict(row)
        events = conn.execute(
            "SELECT step, event_type, timestamp, latency_ms, data FROM events "
            "WHERE run_id = ? ORDER BY id",
            (run_id,),
        ).fetchall()
        run["history"] = [
            {
                "run_id": run_id,
                "step": e["step"],
                "event_type": e["event_type"],
                "timestamp": e["timestamp"],
                "latency_ms": e["latency_ms"],
                "data": json.loads(e["data"]),
            }
            for e in events
        ]
        return run
