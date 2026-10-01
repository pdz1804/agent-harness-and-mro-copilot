"""Persistence for human feedback on runs (`run_feedback`) and the
judge-vs-human agreement computed from it."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from agent_harness.repos.base import connect, require_row

# The judge's pass/fail call on a run is its `task_success` verdict; a run
# whose `passed` flag is NULL falls back to "score >= this".
JUDGE_METRIC = "task_success"
JUDGE_PASS_SCORE = 0.5


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def upsert_feedback(run_id: str, user_id: str, rating: int, note: str, dsn: Optional[str] = None) -> dict[str, Any]:
    """One feedback row per (run, user); a second vote replaces the first."""
    now = _now()
    with connect(dsn) as conn:
        conn.execute(
            "INSERT INTO run_feedback (id, run_id, user_id, rating, note, created_at, updated_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (run_id, user_id) DO UPDATE SET rating = excluded.rating, "
            "note = excluded.note, updated_at = excluded.updated_at",
            (f"fb-{uuid.uuid4().hex[:12]}", run_id, user_id, rating, note, now, now),
        )
        row = require_row(conn.execute(
            "SELECT * FROM run_feedback WHERE run_id = %s AND user_id = %s", (run_id, user_id)
        ).fetchone())
        return dict(row)


def delete_feedback(run_id: str, user_id: str, dsn: Optional[str] = None) -> bool:
    with connect(dsn) as conn:
        return (
            conn.execute("DELETE FROM run_feedback WHERE run_id = %s AND user_id = %s", (run_id, user_id)).rowcount > 0
        )


def list_feedback_for_run(run_id: str, dsn: Optional[str] = None) -> list[dict[str, Any]]:
    with connect(dsn) as conn:
        rows = conn.execute(
            "SELECT f.*, u.display_name FROM run_feedback f JOIN users u ON u.id = f.user_id "
            "WHERE f.run_id = %s ORDER BY f.updated_at DESC",
            (run_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def latest_judge_verdicts(run_ids: list[str], dsn: Optional[str] = None) -> dict[str, dict[str, Any]]:
    """`{run_id: {score, passed, rationale}}` for the judge's most recent
    `task_success` row on each run."""
    if not run_ids:
        return {}
    with connect(dsn) as conn:
        rows = conn.execute(
            "SELECT DISTINCT ON (run_id) run_id, score, passed, rationale FROM eval_results "
            "WHERE run_id = ANY(%s) AND metric = %s ORDER BY run_id, created_at DESC",
            (run_ids, JUDGE_METRIC),
        ).fetchall()
        return {r["run_id"]: dict(r) for r in rows}


def judge_passed(verdict: dict[str, Any]) -> Optional[bool]:
    """The judge's pass/fail call, or None when it produced neither a flag nor a score."""
    if verdict.get("passed") is not None:
        return bool(verdict["passed"])
    if verdict.get("score") is not None:
        return float(verdict["score"]) >= JUDGE_PASS_SCORE
    return None


def agreement(owner_id: Optional[str] = None, dsn: Optional[str] = None) -> dict[str, Any]:
    """Judge-vs-human agreement over runs that have BOTH a human vote and a
    judge `task_success` verdict. A run with several human votes counts once,
    positive when the majority voted up (ties count as down). `owner_id`
    restricts to votes on that user's own runs (None = everyone's, admin)."""
    clauses, params = [], []
    if owner_id is not None:
        clauses.append("r.owner_id = %s")
        params.append(owner_id)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    with connect(dsn) as conn:
        rows = conn.execute(
            "SELECT f.run_id, SUM(f.rating) AS balance FROM run_feedback f "
            f"JOIN runs r ON r.run_id = f.run_id{where} GROUP BY f.run_id",
            tuple(params),
        ).fetchall()
    human = {r["run_id"]: int(r["balance"]) > 0 for r in rows}
    verdicts = latest_judge_verdicts(list(human))
    both_up = both_down = judge_up_human_down = judge_down_human_up = 0
    for run_id, human_up in human.items():
        verdict = verdicts.get(run_id)
        judge_up = judge_passed(verdict) if verdict else None
        if judge_up is None:
            continue
        if judge_up and human_up:
            both_up += 1
        elif not judge_up and not human_up:
            both_down += 1
        elif judge_up:
            judge_up_human_down += 1
        else:
            judge_down_human_up += 1
    compared = both_up + both_down + judge_up_human_down + judge_down_human_up
    return {
        "human_votes": len(human),
        "compared": compared,
        "agree": both_up + both_down,
        "agreement_rate": (both_up + both_down) / compared if compared else None,
        "both_up": both_up,
        "both_down": both_down,
        "judge_up_human_down": judge_up_human_down,
        "judge_down_human_up": judge_down_human_up,
    }
