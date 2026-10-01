"""Copilot-owned schema extension: guardrail event log.

``copilot_runs`` and ``copilot_pending`` already live in ``src/ops/db.py``
(declared there in phase 03 specifically so the whole ops+copilot domain
shares one ``metadata.create_all`` call -- see that module's docstring).
This module adds exactly one more table, ``copilot_guardrail_events``, onto
that *same* ``MetaData`` object (imported, not edited) so
``src.ops.db.init_db()`` picks it up for free on the very next service
startup with no second migration surface. No line in ``src/ops/db.py`` is
modified by this file.

Phase 06 adds three more tables onto the same ``MetaData`` object, for the
same reason: ``copilot_events`` (persisted SSE event log so a client can
reconnect with ``Last-Event-ID`` and replay only missed structural events --
live-only ``token`` events are intentionally never written here, see
``src/copilot/runs.py``), ``copilot_automations`` (fleet-scan-triggered
triage rules), and ``copilot_automation_runs`` (dedup: one automation run
per ``(automation_id, alert_id)`` pair so a re-scan never double-triggers).
"""

from __future__ import annotations

from sqlalchemy import Boolean, Column, Integer, String, Table, Text, UniqueConstraint

from src.ops.db import metadata

copilot_guardrail_events = Table(
    "copilot_guardrail_events",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("run_id", String, nullable=False, index=True),
    Column("at", String, nullable=False),
    Column("kind", String, nullable=False),  # input_blocked | injection_detected | output_retry | output_warning_banner
    Column("detail", Text, nullable=True),
)

copilot_events = Table(
    "copilot_events",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("run_id", String, nullable=False, index=True),
    Column("seq", Integer, nullable=False),
    Column("type", String, nullable=False),
    Column("payload_json", Text, nullable=True),
    Column("at", String, nullable=False),
)

copilot_automations = Table(
    "copilot_automations",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("name", String, nullable=False),
    Column("enabled", Boolean, nullable=False, default=True),
    Column("trigger", String, nullable=False, default="alert_opened"),
    Column("condition_json", Text, nullable=True),
    Column("prompt_template", Text, nullable=False),
    Column("created_at", String, nullable=False),
)

copilot_automation_runs = Table(
    "copilot_automation_runs",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("automation_id", Integer, nullable=False, index=True),
    Column("alert_id", Integer, nullable=False, index=True),
    Column("run_id", String, nullable=False),
    Column("created_at", String, nullable=False),
    UniqueConstraint("automation_id", "alert_id", name="uq_automation_alert"),
)
