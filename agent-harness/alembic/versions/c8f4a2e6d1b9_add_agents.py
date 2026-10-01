"""add agents

Revision ID: c8f4a2e6d1b9
Revises: b7d3f9a1c5e6
Create Date: 2026-09-30 20:00:00.000000

"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c8f4a2e6d1b9'
down_revision: Union[str, Sequence[str], None] = 'b7d3f9a1c5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _pg_text_array_literal(values: list[str]) -> str:
    # Static, code-authored seed values only — same pattern as
    # `b7d3f9a1c5e6_add_skills.py`'s `_pg_array_literal`.
    escaped = ", ".join("'" + v.replace("'", "''") + "'" for v in values)
    return f"ARRAY[{escaped}]::text[]" if values else "'{}'::text[]"


def upgrade() -> None:
    """Upgrade schema.

    Agents (phase 04): a named, ownable entity binding a prompt (+ optional
    pinned version), a skill-routing mode (none/assigned/auto), and a base
    tool set. Two agents are seeded so phase 04 has real data from day one:
    `ops-assistant` (the harness's existing default behavior, now made
    explicit — `auto` mode, follows the active `ops-system` prompt, base
    tools = every registered tool) and `kb-concierge` (`assigned` mode,
    forced to the `kb-answer` skill).

    `runs.agent_id`/`runs.skill_ids` and `chat_sessions.agent_id` record
    which agent (and, for a run, which skill(s)) actually produced it —
    `agent_id` on `chat_sessions` is nullable (a session created before this
    migration, or one that never resolved an agent, keeps working) and a
    session's agent is fixed for its lifetime (switching agents starts a new
    session — see phase-04 phase file's "Unresolved").
    """
    conn = op.get_bind()

    op.execute(
        """
        CREATE TABLE agents (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            avatar_color TEXT NOT NULL DEFAULT '#6366f1',
            prompt_id TEXT NOT NULL REFERENCES prompts(id),
            prompt_version_id TEXT REFERENCES prompt_versions(id),
            skill_mode TEXT NOT NULL DEFAULT 'none' CHECK (skill_mode IN ('none', 'assigned', 'auto')),
            skill_ids TEXT[] NOT NULL DEFAULT '{}',
            base_tools TEXT[] NOT NULL DEFAULT '{}',
            max_steps INTEGER,
            owner_id TEXT NOT NULL REFERENCES users(id),
            visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('private', 'shared')),
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX idx_agents_single_default ON agents (is_default) WHERE is_default"
    )

    op.execute("ALTER TABLE runs ADD COLUMN agent_id TEXT REFERENCES agents(id)")
    op.execute("ALTER TABLE runs ADD COLUMN skill_ids TEXT[] NOT NULL DEFAULT '{}'")
    op.execute("ALTER TABLE chat_sessions ADD COLUMN agent_id TEXT REFERENCES agents(id)")

    ops_system_id = conn.execute(
        sa.text("SELECT id FROM prompts WHERE slug = 'ops-system'")
    ).scalar()
    now = conn.execute(sa.text("SELECT now()::text AS n")).scalar()

    all_tool_names = ["search_knowledge_base", "get_service_status", "create_incident"]
    kb_answer_id = conn.execute(
        sa.text("SELECT id FROM skills WHERE slug = 'kb-answer'")
    ).scalar()

    ops_assistant_id = f"agt-{uuid.uuid4().hex[:12]}"
    conn.execute(
        sa.text(
            "INSERT INTO agents "
            "(id, slug, name, description, avatar_color, prompt_id, prompt_version_id, "
            " skill_mode, skill_ids, base_tools, max_steps, owner_id, visibility, "
            " is_default, created_at, updated_at) "
            "VALUES (:id, 'ops-assistant', 'Ops Assistant', "
            " 'The default general-purpose ops agent: auto-discovers a skill per objective, "
            "falls back to its base tool set otherwise.', '#6366f1', :prompt_id, NULL, "
            f" 'auto', '{{}}', {_pg_text_array_literal(all_tool_names)}, NULL, "
            " 'u_admin', 'shared', TRUE, :now, :now)"
        ),
        {"id": ops_assistant_id, "prompt_id": ops_system_id, "now": now},
    )

    if kb_answer_id is not None:
        kb_concierge_id = f"agt-{uuid.uuid4().hex[:12]}"
        conn.execute(
            sa.text(
                "INSERT INTO agents "
                "(id, slug, name, description, avatar_color, prompt_id, prompt_version_id, "
                " skill_mode, skill_ids, base_tools, max_steps, owner_id, visibility, "
                " is_default, created_at, updated_at) "
                "VALUES (:id, 'kb-concierge', 'KB Concierge', "
                " 'Answers strictly from the knowledge base — always routed to the kb-answer "
                "skill, never any other tool.', '#0ea5e9', :prompt_id, NULL, "
                f" 'assigned', {_pg_text_array_literal([kb_answer_id])}, '{{}}', NULL, "
                " 'u_admin', 'shared', FALSE, :now, :now)"
            ),
            {"id": kb_concierge_id, "prompt_id": ops_system_id, "now": now},
        )


def downgrade() -> None:
    """Downgrade schema. Drops the new columns and the `agents` table."""
    op.execute("ALTER TABLE chat_sessions DROP COLUMN IF EXISTS agent_id")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS skill_ids")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS agent_id")
    op.execute("DROP TABLE IF EXISTS agents")
