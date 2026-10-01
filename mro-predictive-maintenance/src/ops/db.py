"""SQLAlchemy Core engine + schema for the ops domain layer.

Tables map 1:1 to the schema in ``phase-03-ops-domain-store.md``. Two tables
(``copilot_runs``, ``copilot_pending``) are declared here (empty until
phases 05/06 land) so the whole ops domain shares one ``metadata.create_all``
call -- avoids a second migration surface for two closely related tables.
"""

from __future__ import annotations

import os

from sqlalchemy import (
    Boolean,
    Column,
    Engine,
    Float,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    create_engine,
    event,
)

DEFAULT_DATABASE_URL = "sqlite:///data/ops.db"

metadata = MetaData()

predictions = Table(
    "predictions",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("scored_at", String, nullable=False),
    Column("component_id", String, nullable=False, index=True),
    Column("aircraft_id", String, nullable=False, index=True),
    Column("snapshot_date", String, nullable=False),
    Column("cycle", Float, nullable=False),
    Column("model_id", String, nullable=False),
    Column("model_version", String, nullable=True),
    Column("risk_score", Float, nullable=False),
    Column("threshold", Float, nullable=False),
    Column("alert", Boolean, nullable=False),
    Column("features_json", Text, nullable=False),
)

alerts = Table(
    "alerts",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("component_id", String, nullable=False, index=True),
    Column("aircraft_id", String, nullable=False, index=True),
    Column("component_type", String, nullable=False),
    Column("opened_at", String, nullable=False),
    Column("window_key", String, nullable=False),
    Column("risk_score", Float, nullable=False),
    Column("threshold", Float, nullable=False),
    Column("status", String, nullable=False, default="open"),
    Column("top_factors_json", Text, nullable=True),
    Column("source", String, nullable=False, default="fleet_scan"),
    # Idempotency guard: fleet-scan must never open a second alert for the
    # same component within the same decision window.
    UniqueConstraint("component_id", "window_key", name="uq_alerts_component_window"),
)

alert_events = Table(
    "alert_events",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("alert_id", Integer, nullable=False, index=True),
    Column("at", String, nullable=False),
    Column("actor", String, nullable=False),
    Column("action", String, nullable=False),
    Column("note", Text, nullable=True),
    Column("payload_json", Text, nullable=True),
)

work_orders = Table(
    "work_orders",
    metadata,
    Column("id", String, primary_key=True),
    Column("alert_id", Integer, nullable=True, index=True),
    Column("aircraft_id", String, nullable=False),
    Column("component_id", String, nullable=False),
    Column("task_ref", String, nullable=True),
    Column("priority", String, nullable=False, default="routine"),
    Column("status", String, nullable=False, default="open"),
    Column("created_by", String, nullable=False),
    Column("approved_by", String, nullable=False),
    Column("created_at", String, nullable=False),
    Column("closed_at", String, nullable=True),
    Column("outcome", String, nullable=True),
    Column("notes", Text, nullable=True),
)

aircraft_status = Table(
    "aircraft_status",
    metadata,
    Column("aircraft_id", String, primary_key=True),
    Column("status", String, nullable=False, default="serviceable"),
    Column("mel_item", String, nullable=True),
    Column("updated_at", String, nullable=False),
    Column("updated_by", String, nullable=False),
    Column("reason", Text, nullable=True),
)

# One row per real PSI computation (a drift call or a fleet scan). Simulated
# shifts are never persisted, so the history is only ever measured data.
drift_snapshots = Table(
    "drift_snapshots",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("at", String, nullable=False, index=True),
    Column("trigger", String, nullable=False),  # "drift_call" | "fleet_scan"
    Column("overall", String, nullable=False),
    Column("score_psi", Float, nullable=True),
    Column("n_current", Integer, nullable=False),
    Column("current_source", String, nullable=True),
    Column("features_json", Text, nullable=False),  # {feature: psi | null}
)

# Declared now, populated by phases 05/06 -- kept in this module so the ops
# domain has exactly one `metadata.create_all` surface.
copilot_runs = Table(
    "copilot_runs",
    metadata,
    Column("id", String, primary_key=True),
    Column("created_at", String, nullable=False),
    Column("status", String, nullable=False, default="running"),
    Column("trigger", String, nullable=False, default="user"),
    Column("alert_id", Integer, nullable=True),
    Column("user_prompt", Text, nullable=True),
    Column("message_history_json", Text, nullable=True),
    Column("final_answer", Text, nullable=True),
    Column("mlflow_trace_id", String, nullable=True),
    Column("model_name", String, nullable=True),
)

copilot_pending = Table(
    "copilot_pending",
    metadata,
    Column("id", String, primary_key=True),
    Column("run_id", String, nullable=False, index=True),
    Column("tool_call_id", String, nullable=False),
    Column("kind", String, nullable=False),
    Column("tool_name", String, nullable=True),
    Column("args_json", Text, nullable=True),
    Column("question_json", Text, nullable=True),
    Column("status", String, nullable=False, default="pending"),
    Column("resolution_json", Text, nullable=True),
    Column("resolved_by", String, nullable=True),
    Column("resolved_at", String, nullable=True),
)


def _database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL)


def _ensure_sqlite_dir(url: str) -> None:
    if not url.startswith("sqlite:///") or url.endswith(":memory:"):
        return
    path = url[len("sqlite:///"):]
    if not path:
        return
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)


def make_engine(database_url: str | None = None) -> Engine:
    """Create an engine with WAL mode + a single-worker-safe sqlite config.

    ``check_same_thread=False`` is required because FastAPI's TestClient and
    a real uvicorn worker both call in from threads other than the one that
    created the connection; WAL + short transactions keep this safe for the
    single-worker deployment this app targets (see phase-03 Risks).
    """
    url = database_url or _database_url()
    _ensure_sqlite_dir(url)
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    engine = create_engine(url, connect_args=connect_args, future=True)

    if url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _set_sqlite_pragma(dbapi_connection, _connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine


def init_db(engine: Engine) -> None:
    """Idempotent schema creation -- safe to call on every service startup."""
    metadata.create_all(engine)
