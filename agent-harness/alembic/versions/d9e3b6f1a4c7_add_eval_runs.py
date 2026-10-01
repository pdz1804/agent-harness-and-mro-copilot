"""add eval_runs and eval_results tables

Revision ID: d9e3b6f1a4c7
Revises: a1c4e8f2d6b3
Create Date: 2026-10-01 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'd9e3b6f1a4c7'
down_revision: Union[str, Sequence[str], None] = 'a1c4e8f2d6b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Eval agent (phase 07): `eval_runs` (one row per `POST /eval-runs`
    invocation — a background scoring job over a scope of persisted
    harness `runs`) + `eval_results` (one row per run x metric x
    judge_version, the actual scored value). Scores are never overwritten
    in place: a re-score under a new `judge_version` inserts new rows
    rather than mutating old ones, so historical trend charts keep
    reflecting exactly what judge_version produced each point. The unique
    constraint `(run_id, metric, judge_version)` is what makes
    `score_runs(force=False)` idempotent — re-running with the same
    judge_version against a run already scored under it is a no-op insert
    (caller checks first; the constraint is the backstop)."""
    op.execute(
        """
        CREATE TABLE eval_runs (
            id TEXT PRIMARY KEY,
            triggered_by TEXT NOT NULL REFERENCES users(id),
            scope TEXT NOT NULL CHECK (scope IN ('mine', 'all')),
            judge_version TEXT NOT NULL,
            judge_model TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'completed', 'failed')),
            total INTEGER NOT NULL DEFAULT 0,
            done INTEGER NOT NULL DEFAULT 0,
            started_at TEXT,
            finished_at TEXT,
            summary TEXT,
            mlflow_run_id TEXT,
            error TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE eval_results (
            id TEXT PRIMARY KEY,
            eval_run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
            session_id TEXT,
            agent_id TEXT,
            metric TEXT NOT NULL,
            score DOUBLE PRECISION,
            passed BOOLEAN,
            rationale TEXT,
            judge_version TEXT NOT NULL,
            created_at TEXT NOT NULL,
            CONSTRAINT uq_eval_results_run_metric_judge UNIQUE (run_id, metric, judge_version)
        )
        """
    )
    op.execute("CREATE INDEX idx_eval_results_metric_created_at ON eval_results(metric, created_at)")
    op.execute("CREATE INDEX idx_eval_results_eval_run_id ON eval_results(eval_run_id)")
    op.execute("CREATE INDEX idx_eval_results_run_id ON eval_results(run_id)")


def downgrade() -> None:
    """Downgrade schema. Drops both new tables (results first, for the FK)."""
    op.execute("DROP TABLE IF EXISTS eval_results")
    op.execute("DROP TABLE IF EXISTS eval_runs")
