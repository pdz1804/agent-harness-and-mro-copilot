"""prompt verification, uploaded KB documents, agent-made dashboards

Revision ID: b8e4a1c7d3f9
Revises: a6c2d8e4f1b7
Create Date: 2026-10-01 14:00:00.000000

* `prompt_versions.verification` (JSONB): the persisted lint + optional LLM
  review result for each version; activation is gated on it.
* `prompts.required_placeholders` (TEXT[]): `{{name}}` template variables a
  version's content must contain to pass lint.
* `dashboards.created_by_run_id` / `auto_refresh_seconds`: link an
  agent-created dashboard back to its run (also the idempotency key for
  `create_dashboard`), and the per-dashboard auto-refresh interval.
* `kb_documents`: documents added through the UI/API. The 18 seed runbooks
  stay files under `data/kb/`; these rows are chunked and indexed alongside
  them by `agent_harness.retrieval`.
* Backfill for databases created before this revision: the `create_dashboard`
  / `add_widget` Integrations rows, the seeded `build-dashboard` skill, and
  the two tools on the default `ops-assistant` agent's base tool set.
"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b8e4a1c7d3f9'
down_revision: Union[str, Sequence[str], None] = 'a6c2d8e4f1b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Mirrors the `build-dashboard` entry in `agent_harness.db._SEED_SKILLS`
# (kept inline so a migration never imports application code).
_BUILD_DASHBOARD_INSTRUCTIONS = (
    "Turn the request into a small dashboard (2-6 widgets). Query only the harness tables "
    "(incidents, services, runs, events) with read-only SELECTs. Pick the widget kind that fits "
    "the data: stat for one number, bar/pie for a category breakdown, line/area for a series over "
    "time, table/list for rows. For 'X by category over time' pivot the category into columns "
    "(count(*) FILTER (WHERE severity = 'high') AS high) and bucket time with "
    "substring(created_at, 1, 10) for incidents. Call create_dashboard once with every widget; "
    "a human approves it first, and a widget whose query fails the dry run is rejected back to "
    "you, so fix the SQL and call again. After it is created, tell the user the dashboard name "
    "and where to find it (Dashboards page). Use add_widget only to extend an existing dashboard."
)


def upgrade() -> None:
    op.execute("ALTER TABLE prompt_versions ADD COLUMN IF NOT EXISTS verification JSONB")
    op.execute("ALTER TABLE prompts ADD COLUMN IF NOT EXISTS required_placeholders TEXT[] NOT NULL DEFAULT '{}'")
    op.execute("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS created_by_run_id TEXT")
    op.execute("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS auto_refresh_seconds INTEGER")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_dashboards_created_by_run ON dashboards(created_by_run_id, name)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS kb_documents (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'upload',
            created_by TEXT REFERENCES users(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )

    conn = op.get_bind()
    now = conn.execute(sa.text("SELECT now()::text AS n")).scalar()
    for tool_name in ("create_dashboard", "add_widget"):
        conn.execute(
            sa.text(
                "INSERT INTO integrations (tool_name, enabled, updated_at) "
                "VALUES (:name, TRUE, :now) ON CONFLICT (tool_name) DO NOTHING"
            ),
            {"name": tool_name, "now": now},
        )
    conn.execute(
        sa.text(
            "INSERT INTO skills (id, slug, name, description, instructions, allowed_tools, examples, "
            " owner_id, visibility, enabled, created_at, updated_at, updated_by) "
            "VALUES (:id, 'build-dashboard', 'Build dashboard', :description, :instructions, "
            " ARRAY['create_dashboard','add_widget'], :examples, 'u_admin', 'shared', TRUE, "
            " :now, :now, 'u_admin') ON CONFLICT (slug) DO NOTHING"
        ),
        {
            "id": f"skl-{uuid.uuid4().hex[:12]}",
            "description": "Design and create a live dashboard of read-only SQL widgets from a "
            "plain-language request.",
            "instructions": _BUILD_DASHBOARD_INSTRUCTIONS,
            "examples": [
                "build me a dashboard of incidents by severity over time",
                "make a dashboard showing service health and open incidents",
            ],
            "now": now,
        },
    )
    for tool_name in ("create_dashboard", "add_widget"):
        conn.execute(
            sa.text(
                "UPDATE agents SET base_tools = array_append(base_tools, :name) "
                "WHERE slug = 'ops-assistant' AND base_tools IS NOT NULL "
                "AND NOT (:name = ANY(base_tools))"
            ),
            {"name": tool_name},
        )


def downgrade() -> None:
    op.execute("DELETE FROM skills WHERE slug = 'build-dashboard'")
    op.execute("DELETE FROM integrations WHERE tool_name IN ('create_dashboard', 'add_widget')")
    op.execute(
        "UPDATE agents SET base_tools = array_remove(array_remove(base_tools, 'create_dashboard'), 'add_widget') "
        "WHERE base_tools IS NOT NULL"
    )
    op.execute("DROP TABLE IF EXISTS kb_documents")
    op.execute("DROP INDEX IF EXISTS idx_dashboards_created_by_run")
    op.execute("ALTER TABLE dashboards DROP COLUMN IF EXISTS auto_refresh_seconds")
    op.execute("ALTER TABLE dashboards DROP COLUMN IF EXISTS created_by_run_id")
    op.execute("ALTER TABLE prompts DROP COLUMN IF EXISTS required_placeholders")
    op.execute("ALTER TABLE prompt_versions DROP COLUMN IF EXISTS verification")
