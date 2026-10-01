"""add prompt library

Revision ID: f2c8a1e4d6b9
Revises: e1a9c6f4b2d8
Create Date: 2026-09-30 17:00:00.000000

"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f2c8a1e4d6b9'
down_revision: Union[str, Sequence[str], None] = 'e1a9c6f4b2d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Mirrors `agent_harness.db._DEFAULT_SKILL_ROUTER_PROMPT`/
# `_DEFAULT_EVAL_JUDGE_PROMPT` — drafted now (phase 02), wired into the loop
# in phases 04/07. Kept in sync manually (small, static strings; no shared
# import to avoid an alembic -> agent_harness.db import at migration time).
_SKILL_ROUTER_PROMPT = (
    "You route an incoming objective to exactly one skill. You will be given "
    "the objective and a list of available skills (each with a name and "
    "description). Choose the single best-matching skill by name. If none "
    "clearly matches, choose the most general/default skill available."
)
_EVAL_JUDGE_PROMPT = (
    "You are an LLM-as-judge evaluating one completed agent run. You will be "
    "given the run's objective, its full tool-call/decision trace, and its "
    "final answer. Judge whether the final answer is correct and "
    "well-supported by the trace, whether tool calls were necessary and "
    "used correctly, and whether the run followed its system prompt's "
    "policy (e.g. evidence-based severity, required investigation steps "
    "before escalating). Return a structured verdict."
)


def upgrade() -> None:
    """Upgrade schema.

    Prompt library (phase 02): `prompts` is a named, versioned library entry
    (slug/kind/owner/visibility/tags); `prompt_versions` becomes its child
    (`prompt_id` + a per-prompt `version` integer) instead of one flat,
    globally-active table. Every existing `prompt_versions` row (seeded by
    `252e2db564a0`, possibly added to since) is backfilled into a new
    `ops-system` prompt, numbered v1..vN by `created_at`; whichever row was
    `is_active` stays the active version of that new prompt. `skill-router`
    and `eval-judge` are seeded fresh (phases 04/07 read them later; the
    "library of ALL prompts" is real from day one, not just `ops-system`).
    """
    conn = op.get_bind()

    op.execute(
        """
        CREATE TABLE prompts (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT,
            kind TEXT NOT NULL CHECK (kind IN ('system', 'skill_router', 'judge')),
            owner_id TEXT NOT NULL REFERENCES users(id),
            visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('private', 'shared')),
            tags TEXT[] NOT NULL DEFAULT '{}',
            active_version_id TEXT,
            archived_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    op.execute("ALTER TABLE prompt_versions ADD COLUMN prompt_id TEXT")
    op.execute("ALTER TABLE prompt_versions ADD COLUMN version INTEGER")
    op.execute("ALTER TABLE prompt_versions ADD COLUMN change_note TEXT")
    op.execute("ALTER TABLE prompt_versions ADD COLUMN created_by TEXT REFERENCES users(id)")

    now = conn.execute(sa.text("SELECT now()::text AS n")).scalar()

    # --- backfill existing prompt_versions rows into an 'ops-system' prompt
    ops_system_id = f"prm-{uuid.uuid4().hex[:12]}"
    existing_rows = conn.execute(
        sa.text("SELECT id, is_active FROM prompt_versions ORDER BY created_at ASC")
    ).fetchall()

    if existing_rows:
        conn.execute(
            sa.text(
                "INSERT INTO prompts "
                "(id, slug, name, description, kind, owner_id, visibility, tags, "
                " active_version_id, archived_at, created_at, updated_at) "
                "VALUES (:id, 'ops-system', 'Ops assistant system prompt', NULL, 'system', "
                " 'u_admin', 'shared', '{}', NULL, NULL, :now, :now)"
            ),
            {"id": ops_system_id, "now": now},
        )
        active_version_id = None
        for i, row in enumerate(existing_rows, start=1):
            conn.execute(
                sa.text(
                    "UPDATE prompt_versions SET prompt_id = :prompt_id, version = :version, "
                    "created_by = 'u_admin' WHERE id = :id"
                ),
                {"prompt_id": ops_system_id, "version": i, "id": row.id},
            )
            if row.is_active:
                active_version_id = row.id
        if active_version_id is None:
            # Defensive: no row was flagged active (should not happen after
            # `252e2db564a0`) — fall back to the most recent backfilled version.
            active_version_id = existing_rows[-1].id
        conn.execute(
            sa.text("UPDATE prompts SET active_version_id = :vid WHERE id = :id"),
            {"vid": active_version_id, "id": ops_system_id},
        )
    else:
        # No pre-existing prompt_versions rows at all (fresh, never-seeded
        # DB) — seed ops-system from scratch with the same default content
        # `agent_harness.db._DEFAULT_SYSTEM_PROMPT`/`seed_prompt_library`
        # would insert, so `ensure_ready()` sees it already present.
        from agent_harness.db import _DEFAULT_SYSTEM_PROMPT

        version_id = f"pv-{uuid.uuid4().hex[:12]}"
        conn.execute(
            sa.text(
                "INSERT INTO prompts "
                "(id, slug, name, description, kind, owner_id, visibility, tags, "
                " active_version_id, archived_at, created_at, updated_at) "
                "VALUES (:id, 'ops-system', 'Ops assistant system prompt', NULL, 'system', "
                " 'u_admin', 'shared', '{}', NULL, NULL, :now, :now)"
            ),
            {"id": ops_system_id, "now": now},
        )
        conn.execute(
            sa.text(
                "INSERT INTO prompt_versions "
                "(id, prompt_id, version, content, change_note, created_by, is_active, created_at) "
                "VALUES (:vid, :pid, 1, :content, 'Initial version', 'u_admin', TRUE, :now)"
            ),
            {"vid": version_id, "pid": ops_system_id, "content": _DEFAULT_SYSTEM_PROMPT, "now": now},
        )
        conn.execute(
            sa.text("UPDATE prompts SET active_version_id = :vid WHERE id = :id"),
            {"vid": version_id, "id": ops_system_id},
        )

    # --- seed the other 2 library prompts (skill-router, eval-judge)
    for slug, name, kind, content in (
        ("skill-router", "Skill router", "skill_router", _SKILL_ROUTER_PROMPT),
        ("eval-judge", "Eval judge", "judge", _EVAL_JUDGE_PROMPT),
    ):
        prompt_id = f"prm-{uuid.uuid4().hex[:12]}"
        version_id = f"pv-{uuid.uuid4().hex[:12]}"
        conn.execute(
            sa.text(
                "INSERT INTO prompts "
                "(id, slug, name, description, kind, owner_id, visibility, tags, "
                " active_version_id, archived_at, created_at, updated_at) "
                "VALUES (:id, :slug, :name, NULL, :kind, 'u_admin', 'shared', '{}', "
                " NULL, NULL, :now, :now)"
            ),
            {"id": prompt_id, "slug": slug, "name": name, "kind": kind, "now": now},
        )
        conn.execute(
            sa.text(
                "INSERT INTO prompt_versions "
                "(id, prompt_id, version, content, change_note, created_by, is_active, created_at) "
                "VALUES (:vid, :pid, 1, :content, 'Initial version', 'u_admin', FALSE, :now)"
            ),
            {"vid": version_id, "pid": prompt_id, "content": content, "now": now},
        )
        conn.execute(
            sa.text("UPDATE prompts SET active_version_id = :vid WHERE id = :id"),
            {"vid": version_id, "id": prompt_id},
        )

    # --- lock down the now-fully-backfilled columns + constraints
    op.execute("ALTER TABLE prompt_versions ALTER COLUMN prompt_id SET NOT NULL")
    op.execute("ALTER TABLE prompt_versions ALTER COLUMN version SET NOT NULL")
    op.execute(
        "ALTER TABLE prompt_versions ADD CONSTRAINT fk_prompt_versions_prompt_id "
        "FOREIGN KEY (prompt_id) REFERENCES prompts(id)"
    )
    op.execute(
        "ALTER TABLE prompt_versions ADD CONSTRAINT uq_prompt_versions_prompt_version "
        "UNIQUE (prompt_id, version)"
    )
    op.execute(
        "ALTER TABLE prompts ADD CONSTRAINT fk_prompts_active_version_id "
        "FOREIGN KEY (active_version_id) REFERENCES prompt_versions(id)"
    )


def downgrade() -> None:
    """Downgrade schema.

    Drops back to the flat `prompt_versions` shape: only `ops-system`'s
    versions survive (with their original `is_active` flag, untouched by
    `upgrade()`); `skill-router`/`eval-judge` and their versions are removed
    entirely since they didn't exist pre-phase-02.
    """
    op.execute("ALTER TABLE prompts DROP CONSTRAINT IF EXISTS fk_prompts_active_version_id")
    op.execute(
        "ALTER TABLE prompt_versions DROP CONSTRAINT IF EXISTS uq_prompt_versions_prompt_version"
    )
    op.execute("ALTER TABLE prompt_versions DROP CONSTRAINT IF EXISTS fk_prompt_versions_prompt_id")
    op.execute(
        "DELETE FROM prompt_versions USING prompts "
        "WHERE prompt_versions.prompt_id = prompts.id AND prompts.slug != 'ops-system'"
    )
    op.execute("ALTER TABLE prompt_versions DROP COLUMN IF EXISTS created_by")
    op.execute("ALTER TABLE prompt_versions DROP COLUMN IF EXISTS change_note")
    op.execute("ALTER TABLE prompt_versions DROP COLUMN IF EXISTS version")
    op.execute("ALTER TABLE prompt_versions DROP COLUMN IF EXISTS prompt_id")
    op.execute("DROP TABLE IF EXISTS prompts")
