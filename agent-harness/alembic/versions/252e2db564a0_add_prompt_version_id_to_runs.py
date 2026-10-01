"""add prompt_version_id to runs, seed default active prompt version

Revision ID: 252e2db564a0
Revises: 8645d2ee0fbf
Create Date: 2026-09-30 10:45:00.000000

"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '252e2db564a0'
down_revision: Union[str, Sequence[str], None] = '8645d2ee0fbf'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Mirrors the hardcoded SYSTEM_PROMPT constant in agent_harness.loop as of
# 11a-12a, seeded here as the first ("v1") prompt version so every database
# always has exactly one active prompt version from the moment this
# migration runs — the harness's agent-construction path (loop.py::AgentLoop)
# never has to fall back to a hardcoded string once phase 12b's DB-backed
# prompt wiring lands.
_DEFAULT_PROMPT = (
    "You are an ops-assistant agent for an internal engineering team. "
    "Use the available tools to investigate before answering: call "
    "get_service_status to check a service's current status before "
    "escalating anything, call search_knowledge_base to find the "
    "relevant runbook, and only call create_incident when the evidence "
    "(service status and/or knowledge base findings) supports opening "
    "one. Choose severity from that evidence: critical/high for a "
    "confirmed outage or major customer impact, medium for a degraded "
    "service with impact still present after a remediation attempt, low "
    "for minor/cosmetic impact. get_service_status reports error_rate_pct "
    "as a percentage already (e.g. 4.1 means 4.1% of requests errored) — "
    "do not divide it further or call it a fraction. create_incident always requires a "
    "separate human approval step before it takes effect — you do not "
    "need to ask for approval yourself in your reply text, just call "
    "the tool when the evidence justifies it. Once you have enough "
    "information, reply with a plain-text final answer instead of "
    "calling another tool."
)


def upgrade() -> None:
    """Upgrade schema."""
    op.execute("ALTER TABLE runs ADD COLUMN prompt_version_id TEXT REFERENCES prompt_versions(id)")

    default_id = f"pv-{uuid.uuid4().hex[:12]}"
    conn = op.get_bind()
    conn.execute(
        sa.text(
            "INSERT INTO prompt_versions (id, content, is_active, created_at) "
            "VALUES (:id, :content, TRUE, now()::text)"
        ),
        {"id": default_id, "content": _DEFAULT_PROMPT},
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS prompt_version_id")
    op.execute("DELETE FROM prompt_versions")
