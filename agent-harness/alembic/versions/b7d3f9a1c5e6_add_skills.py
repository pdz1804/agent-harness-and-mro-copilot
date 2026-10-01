"""add skills

Revision ID: b7d3f9a1c5e6
Revises: f2c8a1e4d6b9
Create Date: 2026-09-30 18:00:00.000000

"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7d3f9a1c5e6'
down_revision: Union[str, Sequence[str], None] = 'f2c8a1e4d6b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Mirrors `agent_harness.repos.skills.SEEDED_SKILLS`. Kept in sync manually
# (small, static data; no shared import to avoid an alembic -> agent_harness
# import at migration time) — same pattern as `f2c8a1e4d6b9`'s prompt seeds.
_SEED_SKILLS = (
    (
        "triage-outage",
        "Triage outage",
        "Investigate a reported service outage: check status, then search runbooks.",
        "Check the affected service's current status first, then search the knowledge "
        "base for the matching runbook. Summarize findings before recommending next steps.",
        ["get_service_status", "search_knowledge_base"],
        ["auth-service is returning errors", "why is checkout down"],
    ),
    (
        "kb-answer",
        "KB answer",
        "Answer a question strictly from the knowledge base, citing doc ids.",
        "Answer only from the knowledge base. Always cite the doc id(s) you used. If "
        "nothing relevant is found, say so plainly instead of guessing.",
        ["search_knowledge_base"],
        ["how do we roll back a bad deploy", "what is our on-call escalation policy"],
    ),
    (
        "escalate-incident",
        "Escalate incident",
        "Confirm a service is actually degraded, then open an incident.",
        "Check the affected service's current status to confirm impact before opening "
        "an incident. Choose severity from that evidence.",
        ["get_service_status", "create_incident"],
        ["open an incident for payments-service", "escalate the auth outage"],
    ),
    (
        "service-health-report",
        "Service health report",
        "Summarize the current health of the service fleet.",
        "Check the status of the services relevant to the objective and summarize their "
        "health (status, latency, error rate) in a short report.",
        ["get_service_status"],
        ["give me a health report for the fleet", "how are our services doing today"],
    ),
)


def upgrade() -> None:
    """Upgrade schema.

    Skills (phase 03): a reusable capability package — instructions +
    `allowed_tools` (a subset of the harness's tool registry) + a
    description used as the routing signal for phase 04's skill auto-
    discover. Not versioned (YAGNI; prompts already carry versioning) —
    `updated_at`/`updated_by` track the last edit instead. 4 shared, admin-
    owned skills are seeded so phase 04 has real data to route against from
    day one.
    """
    conn = op.get_bind()

    op.execute(
        """
        CREATE TABLE skills (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            instructions TEXT NOT NULL DEFAULT '',
            allowed_tools TEXT[] NOT NULL DEFAULT '{}',
            examples TEXT[] NOT NULL DEFAULT '{}',
            owner_id TEXT NOT NULL REFERENCES users(id),
            visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('private', 'shared')),
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            updated_by TEXT NOT NULL REFERENCES users(id)
        )
        """
    )

    def _pg_array_literal(values: list[str]) -> str:
        # Static, code-authored values only (seed data above, no user input) —
        # a literal ARRAY[...] built via SQLAlchemy bind params avoids any
        # ambiguity around whether the dialect adapts a Python list to a
        # Postgres array through a raw `sa.text` parameter.
        escaped = ", ".join("'" + v.replace("'", "''") + "'" for v in values)
        return f"ARRAY[{escaped}]::text[]" if values else "'{}'::text[]"

    now = conn.execute(sa.text("SELECT now()::text AS n")).scalar()
    for slug, name, description, instructions, allowed_tools, examples in _SEED_SKILLS:
        skill_id = f"skl-{uuid.uuid4().hex[:12]}"
        conn.execute(
            sa.text(
                "INSERT INTO skills "
                "(id, slug, name, description, instructions, allowed_tools, examples, "
                " owner_id, visibility, enabled, created_at, updated_at, updated_by) "
                "VALUES (:id, :slug, :name, :description, :instructions, "
                f" {_pg_array_literal(allowed_tools)}, {_pg_array_literal(examples)}, "
                " 'u_admin', 'shared', TRUE, :now, :now, 'u_admin')"
            ),
            {
                "id": skill_id,
                "slug": slug,
                "name": name,
                "description": description,
                "instructions": instructions,
                "now": now,
            },
        )


def downgrade() -> None:
    """Downgrade schema. Drops `skills` entirely (no other table references it yet)."""
    op.execute("DROP TABLE IF EXISTS skills")
