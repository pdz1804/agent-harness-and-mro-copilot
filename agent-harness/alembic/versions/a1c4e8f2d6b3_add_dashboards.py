"""add dashboards and dashboard_widgets tables

Revision ID: a1c4e8f2d6b3
Revises: c8f4a2e6d1b9
Create Date: 2026-10-01 00:00:00.000000

"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1c4e8f2d6b3'
down_revision: Union[str, Sequence[str], None] = 'c8f4a2e6d1b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Dashboards (phase 06): replaces the single-table "Artifacts" concept
    (`dashboard_tiles`, 12e) with first-class `dashboards` (a named, owned,
    visibility-scoped collection) + `dashboard_widgets` (one stat/chart/
    table/list per row, each backed by a stored read-only SQL query plus a
    typed `config` describing how to render its result). Every existing
    `dashboard_tiles` row is migrated into one new dashboard, "Saved
    queries (migrated)", as a `table` widget — `dashboard_tiles` itself is
    left in place, untouched and unused (kept read-only per the phase
    spec; no other phase deletes it either).
    """
    conn = op.get_bind()

    op.execute(
        """
        CREATE TABLE dashboards (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            template_key TEXT NOT NULL DEFAULT 'blank',
            owner_id TEXT NOT NULL REFERENCES users(id),
            visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
            layout_cols INTEGER NOT NULL DEFAULT 12,
            last_refreshed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )

    op.execute(
        """
        CREATE TABLE dashboard_widgets (
            id TEXT PRIMARY KEY,
            dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('stat', 'line', 'bar', 'area', 'pie', 'table', 'list')),
            title TEXT NOT NULL,
            sql_query TEXT NOT NULL,
            config TEXT NOT NULL DEFAULT '{}',
            position INTEGER NOT NULL DEFAULT 0,
            col_span INTEGER NOT NULL DEFAULT 6 CHECK (col_span IN (3, 4, 6, 12)),
            last_result TEXT,
            last_error TEXT,
            last_run_ms INTEGER,
            refreshed_at TEXT
        )
        """
    )
    op.execute("CREATE INDEX idx_dashboard_widgets_dashboard_id ON dashboard_widgets(dashboard_id)")

    # --- migrate existing dashboard_tiles rows into one dashboard --------
    tiles = conn.execute(sa.text("SELECT id, name, sql_query, created_at FROM dashboard_tiles")).fetchall()
    if tiles:
        now = conn.execute(sa.text("SELECT now()::text AS n")).scalar()
        dashboard_id = f"dash-{uuid.uuid4().hex[:12]}"
        conn.execute(
            sa.text(
                "INSERT INTO dashboards "
                "(id, name, description, template_key, owner_id, visibility, layout_cols, created_at, updated_at) "
                "VALUES (:id, 'Saved queries (migrated)', "
                "'Widgets migrated from the old Artifacts tiles table.', 'blank', 'u_admin', 'shared', 12, :now, :now)"
            ),
            {"id": dashboard_id, "now": now},
        )
        for position, tile in enumerate(tiles):
            widget_id = f"wgt-{uuid.uuid4().hex[:12]}"
            conn.execute(
                sa.text(
                    "INSERT INTO dashboard_widgets "
                    "(id, dashboard_id, kind, title, sql_query, config, position, col_span) "
                    "VALUES (:id, :dashboard_id, 'table', :title, :sql_query, "
                    "'{\"page_size\": 20}', :position, 12)"
                ),
                {
                    "id": widget_id,
                    "dashboard_id": dashboard_id,
                    "title": tile.name,
                    "sql_query": tile.sql_query,
                    "position": position,
                },
            )


def downgrade() -> None:
    """Downgrade schema. Drops both new tables; `dashboard_tiles` (untouched
    by this migration) is left intact."""
    op.execute("DROP TABLE IF EXISTS dashboard_widgets")
    op.execute("DROP TABLE IF EXISTS dashboards")
