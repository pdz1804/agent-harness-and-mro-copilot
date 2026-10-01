"""incident lifecycle, archived sessions, per-tool timeout/retry settings

Revision ID: d7b3f1a8c6e2
Revises: c5a2e9f7b1d4
Create Date: 2026-10-01 18:30:00.000000

* `incidents`: `service_name` (what the incident is about, used to warn the
  agent about duplicates), who/when acknowledged and resolved, a resolution
  note, and `created_by` (the run owner at creation time). Legacy rows with
  status `created` become `open`. The read-only `harness_ro.incidents` view
  gains `service_name`, `acknowledged_at` and `resolved_at` (appended, so
  existing dashboards keep working).
* `chat_sessions.archived_at`: soft-archive marker; archived sessions are
  hidden from the default list.
* `integrations.timeout_seconds` / `max_retries`: optional per-tool overrides
  of the loop's global limits (NULL = use the global default).
"""
from typing import Sequence, Union

from alembic import op

revision: str = "d7b3f1a8c6e2"
down_revision: Union[str, Sequence[str], None] = "c5a2e9f7b1d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_VIEW_BODY_OLD = """
    SELECT i.id, i.title, i.description, i.severity, i.status, i.created_at, i.run_id
    FROM public.incidents i
    WHERE COALESCE(current_setting('app.is_admin', true), 'off') = 'on'
       OR EXISTS (
           SELECT 1 FROM public.runs r
           WHERE r.run_id = i.run_id AND r.owner_id = current_setting('app.user_id', true)
       )
"""

_VIEW_BODY_NEW = """
    SELECT i.id, i.title, i.description, i.severity, i.status, i.created_at, i.run_id,
           i.service_name, i.acknowledged_at, i.resolved_at
    FROM public.incidents i
    WHERE COALESCE(current_setting('app.is_admin', true), 'off') = 'on'
       OR EXISTS (
           SELECT 1 FROM public.runs r
           WHERE r.run_id = i.run_id AND r.owner_id = current_setting('app.user_id', true)
       )
"""


def upgrade() -> None:
    op.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS service_name TEXT")
    op.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id)")
    op.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS acknowledged_by TEXT REFERENCES users(id)")
    op.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS acknowledged_at TEXT")
    op.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolved_by TEXT REFERENCES users(id)")
    op.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolved_at TEXT")
    op.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolution_note TEXT")
    op.execute("UPDATE incidents SET status = 'open' WHERE status = 'created'")
    op.execute("CREATE INDEX IF NOT EXISTS idx_incidents_service_status ON incidents(service_name, status)")
    op.execute(
        "UPDATE incidents i SET created_by = r.owner_id FROM runs r "
        "WHERE r.run_id = i.run_id AND i.created_by IS NULL"
    )
    op.execute("CREATE OR REPLACE VIEW harness_ro.incidents WITH (security_barrier = true) AS" + _VIEW_BODY_NEW)

    op.execute("ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS archived_at TEXT")

    op.execute("ALTER TABLE integrations ADD COLUMN IF NOT EXISTS timeout_seconds DOUBLE PRECISION")
    op.execute("ALTER TABLE integrations ADD COLUMN IF NOT EXISTS max_retries INTEGER")


def downgrade() -> None:
    op.execute("ALTER TABLE integrations DROP COLUMN IF EXISTS max_retries")
    op.execute("ALTER TABLE integrations DROP COLUMN IF EXISTS timeout_seconds")
    op.execute("ALTER TABLE chat_sessions DROP COLUMN IF EXISTS archived_at")
    op.execute("DROP VIEW IF EXISTS harness_ro.incidents")
    op.execute("CREATE VIEW harness_ro.incidents WITH (security_barrier = true) AS" + _VIEW_BODY_OLD)
    op.execute("GRANT SELECT ON harness_ro.incidents TO harness_reader")
    op.execute("DROP INDEX IF EXISTS idx_incidents_service_status")
    op.execute("UPDATE incidents SET status = 'created' WHERE status = 'open'")
    for column in (
        "resolution_note",
        "resolved_at",
        "resolved_by",
        "acknowledged_at",
        "acknowledged_by",
        "created_by",
        "service_name",
    ):
        op.execute(f"ALTER TABLE incidents DROP COLUMN IF EXISTS {column}")
