"""long-term memories and human run feedback

Revision ID: c5a2e9f7b1d4
Revises: b8e4a1c7d3f9
Create Date: 2026-10-01 18:00:00.000000

* `memories`: facts an agent stored with `remember` (or a user typed on the
  Memory page). Strictly per owner; `use_count` / `last_used_at` are bumped
  every time `recall` returns one.
* `run_feedback`: a human thumbs-up/down plus a note on a run, one row per
  (run, user), shown next to the LLM judge's score.
* Backfill for existing databases: the `remember` / `recall` Integrations rows
  and the two tools on the default `ops-assistant` agent's base tool set.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c5a2e9f7b1d4"
down_revision: Union[str, Sequence[str], None] = "b8e4a1c7d3f9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_MEMORY_TOOLS = ("remember", "recall")


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL REFERENCES users(id),
            fact TEXT NOT NULL,
            tags TEXT[] NOT NULL DEFAULT '{}',
            source_run_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_used_at TEXT,
            use_count INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_memories_owner_created ON memories(owner_id, created_at DESC)")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS run_feedback (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id),
            rating SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (run_id, user_id)
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_run_feedback_run ON run_feedback(run_id)")

    conn = op.get_bind()
    now = conn.execute(sa.text("SELECT now()::text AS n")).scalar()
    for tool_name in _MEMORY_TOOLS:
        conn.execute(
            sa.text(
                "INSERT INTO integrations (tool_name, enabled, updated_at) "
                "VALUES (:name, TRUE, :now) ON CONFLICT (tool_name) DO NOTHING"
            ),
            {"name": tool_name, "now": now},
        )
        conn.execute(
            sa.text(
                "UPDATE agents SET base_tools = array_append(base_tools, :name) "
                "WHERE slug = 'ops-assistant' AND base_tools IS NOT NULL "
                "AND NOT (:name = ANY(base_tools))"
            ),
            {"name": tool_name},
        )


def downgrade() -> None:
    op.execute(
        "UPDATE agents SET base_tools = array_remove(array_remove(base_tools, 'remember'), 'recall') "
        "WHERE base_tools IS NOT NULL"
    )
    op.execute("DELETE FROM integrations WHERE tool_name IN ('remember', 'recall')")
    op.execute("DROP INDEX IF EXISTS idx_run_feedback_run")
    op.execute("DROP TABLE IF EXISTS run_feedback")
    op.execute("DROP INDEX IF EXISTS idx_memories_owner_created")
    op.execute("DROP TABLE IF EXISTS memories")
