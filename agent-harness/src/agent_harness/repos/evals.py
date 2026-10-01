"""Persistence for the eval agent (phase 07): `eval_runs` (one row per
`POST /eval-runs` scoring job) + `eval_results` (one row per run x metric x
judge_version). See the `add_eval_runs` migration's docstring for why
results are insert-only (never overwritten in place).

This module owns SQL only — no judge/LLM calls, no metric computation.
`eval.metrics`/`eval.judge` produce the rows this module persists;
`eval.online_runner` (phase 07 part B) orchestrates the background job."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from agent_harness import db
from agent_harness.repos.base import require_row


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _row_to_eval_run(row: dict[str, Any]) -> dict[str, Any]:
    row = dict(row)
    if row.get("summary"):
        row["summary"] = json.loads(row["summary"])
    return row


# --- eval_runs ---------------------------------------------------------

# `eval_runs` plus the per-run aggregates the UI shows next to each job: the
# mean of its non-null scores and how many results failed their threshold.
_EVAL_RUN_SELECT = (
    "SELECT er.*, "
    "(SELECT AVG(score) FROM eval_results r WHERE r.eval_run_id = er.id AND r.score IS NOT NULL) AS avg_score, "
    "(SELECT COUNT(*) FROM eval_results r WHERE r.eval_run_id = er.id AND r.passed = FALSE) AS failed_count "
    "FROM eval_runs er"
)


def create_eval_run(
    *,
    triggered_by: str,
    scope: str,
    judge_version: str,
    judge_model: str,
    total: int = 0,
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    """Insert a new `eval_runs` row in `queued` status. The caller
    (`eval.online_runner`, part B) is responsible for transitioning it
    through `running` -> `completed`/`failed` as the background job
    progresses."""
    eval_run_id = _new_id("evr")
    now = _now()
    with db.connect(dsn) as conn:
        conn.execute(
            "INSERT INTO eval_runs "
            "(id, triggered_by, scope, judge_version, judge_model, status, total, done, created_at) "
            "VALUES (%s, %s, %s, %s, %s, 'queued', %s, 0, %s)",
            (eval_run_id, triggered_by, scope, judge_version, judge_model, total, now),
        )
    return get_eval_run(eval_run_id, dsn)  # type: ignore[return-value]


def get_eval_run(eval_run_id: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with db.connect(dsn) as conn:
        row = conn.execute(_EVAL_RUN_SELECT + " WHERE er.id = %s", (eval_run_id,)).fetchone()
        return _row_to_eval_run(row) if row else None


def list_eval_runs(
    *, triggered_by: Optional[str] = None, dsn: Optional[str] = None
) -> list[dict[str, Any]]:
    """Every eval run, most recent first. `triggered_by` narrows to one
    user's own runs (used by a non-admin caller to list "mine")."""
    with db.connect(dsn) as conn:
        if triggered_by is not None:
            rows = conn.execute(
                _EVAL_RUN_SELECT + " WHERE er.triggered_by = %s ORDER BY er.created_at DESC",
                (triggered_by,),
            ).fetchall()
        else:
            rows = conn.execute(_EVAL_RUN_SELECT + " ORDER BY er.created_at DESC").fetchall()
        return [_row_to_eval_run(r) for r in rows]


def update_eval_run_progress(
    eval_run_id: str, *, done: int, status: Optional[str] = None, dsn: Optional[str] = None
) -> None:
    with db.connect(dsn) as conn:
        if status is not None:
            conn.execute(
                "UPDATE eval_runs SET done = %s, status = %s WHERE id = %s",
                (done, status, eval_run_id),
            )
        else:
            conn.execute("UPDATE eval_runs SET done = %s WHERE id = %s", (done, eval_run_id))


def finish_eval_run(
    eval_run_id: str,
    *,
    status: str,
    summary: Optional[dict[str, Any]] = None,
    mlflow_run_id: Optional[str] = None,
    error: Optional[str] = None,
    dsn: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Mark an eval run `completed`/`failed` with its terminal summary.
    `status` must be one of those two (queued/running are transient states
    set via `update_eval_run_progress`/`mark_stale_running_as_failed`)."""
    now = _now()
    with db.connect(dsn) as conn:
        cur = conn.execute(
            "UPDATE eval_runs SET status = %s, finished_at = %s, summary = %s, "
            "mlflow_run_id = %s, error = %s WHERE id = %s",
            (
                status,
                now,
                json.dumps(summary, default=str) if summary is not None else None,
                mlflow_run_id,
                error,
                eval_run_id,
            ),
        )
        if cur.rowcount == 0:
            return None
    return get_eval_run(eval_run_id, dsn)


def mark_stale_running_as_failed(dsn: Optional[str] = None) -> int:
    """Any `eval_runs` row still `running` (a background thread that never
    reached a terminal status, e.g. the server restarted mid-job) is marked
    `failed` — called once at startup, matching the phase file's risk
    mitigation. Returns the number of rows updated."""
    now = _now()
    with db.connect(dsn) as conn:
        cur = conn.execute(
            "UPDATE eval_runs SET status = 'failed', finished_at = %s, "
            "error = COALESCE(error, 'interrupted by server restart') "
            "WHERE status = 'running'",
            (now,),
        )
        return cur.rowcount


# --- eval_results --------------------------------------------------------


def insert_results(
    eval_run_id: str,
    rows: list[dict[str, Any]],
    dsn: Optional[str] = None,
) -> int:
    """Bulk-insert scored metric rows for one eval run. Each `row` must have
    `run_id`, `metric`, `score` (float|None), `passed` (bool|None),
    `rationale` (str|None), `judge_version`; `session_id`/`agent_id` are
    optional denormalized context copied from the scored run, so
    `GET /eval-metrics/overview` can group/filter without a join back to
    `runs` every time. `ON CONFLICT DO NOTHING` on the
    `(run_id, metric, judge_version)` unique constraint makes a re-insert of
    an already-scored (run, metric, judge_version) triple a no-op — the
    idempotency backstop behind `score_runs(force=False)`'s own skip logic.
    Returns the number of rows actually inserted (excludes conflicts)."""
    if not rows:
        return 0
    now = _now()
    inserted = 0
    with db.connect(dsn) as conn:
        for row in rows:
            cur = conn.execute(
                "INSERT INTO eval_results "
                "(id, eval_run_id, run_id, session_id, agent_id, metric, score, passed, "
                " rationale, judge_version, created_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (run_id, metric, judge_version) DO NOTHING",
                (
                    _new_id("evres"),
                    eval_run_id,
                    row["run_id"],
                    row.get("session_id"),
                    row.get("agent_id"),
                    row["metric"],
                    row.get("score"),
                    row.get("passed"),
                    row.get("rationale"),
                    row["judge_version"],
                    now,
                ),
            )
            inserted += cur.rowcount
    return inserted


def already_scored_run_ids(run_ids: list[str], judge_version: str, dsn: Optional[str] = None) -> set[str]:
    """The subset of `run_ids` that already have at least one `eval_results`
    row under `judge_version` — what `score_runs(force=False)` uses to skip
    runs incrementally (a run scored under an older judge_version is treated
    as not-yet-scored under the current one)."""
    if not run_ids:
        return set()
    with db.connect(dsn) as conn:
        rows = conn.execute(
            "SELECT DISTINCT run_id FROM eval_results WHERE run_id = ANY(%s) AND judge_version = %s",
            (run_ids, judge_version),
        ).fetchall()
        return {r["run_id"] for r in rows}


def list_results_for_run(run_id: str, dsn: Optional[str] = None) -> list[dict[str, Any]]:
    """Every metric row ever recorded for one run, newest judge_version
    first — used by a run-detail view to show score history across
    judge_version changes."""
    with db.connect(dsn) as conn:
        rows = conn.execute(
            "SELECT * FROM eval_results WHERE run_id = %s ORDER BY created_at DESC",
            (run_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def list_results_for_eval_run(
    eval_run_id: str,
    *,
    metric: Optional[str] = None,
    agent_id: Optional[str] = None,
    failed_only: bool = False,
    dsn: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Paged-by-caller result rows for one `eval_runs` job, optionally
    filtered by `metric`/`agent_id`/`failed_only` (passed == False) — backs
    `GET /eval-runs/{id}` results pagination (part B)."""
    query = "SELECT * FROM eval_results WHERE eval_run_id = %s"
    params: list[Any] = [eval_run_id]
    if metric is not None:
        query += " AND metric = %s"
        params.append(metric)
    if agent_id is not None:
        query += " AND agent_id = %s"
        params.append(agent_id)
    if failed_only:
        query += " AND passed = FALSE"
    query += " ORDER BY created_at ASC"
    with db.connect(dsn) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
        return [dict(r) for r in rows]


# --- overview (phase 07 part B) ------------------------------------------
#
# All three helpers below join `eval_results` -> `runs` so a non-admin
# caller's view can be restricted to runs they own (`owner_id`), matching
# the same RBAC shape as everywhere else in this codebase ("mine" vs "all").
# Only the *latest* `judge_version` for each `(run_id, metric)` pair is
# considered — an older re-score kept for history (insert-only) must not
# double-count in an aggregate.


def _latest_results_cte() -> str:
    """Common-table-expression selecting one row per `(run_id, metric)`:
    the most-recently-created `eval_results` row, i.e. the current
    judge_version's score for that run x metric (a run scored under an
    older judge_version and never re-scored still shows its latest
    available score; this is a display aggregate, not a lineage view)."""
    return """
        WITH latest AS (
            SELECT DISTINCT ON (er.run_id, er.metric)
                er.run_id, er.metric, er.score, er.passed, er.rationale,
                er.judge_version, er.created_at, er.agent_id, er.session_id
            FROM eval_results er
            ORDER BY er.run_id, er.metric, er.created_at DESC
        )
    """


def overview_series(
    *, owner_id: Optional[str], since_days: int, agent_id: Optional[str] = None, dsn: Optional[str] = None
) -> list[dict[str, Any]]:
    """Daily `(date, metric, mean, n)` rows over the last `since_days` days,
    scoped to `owner_id`'s own runs when given (admin callers pass `None`
    for "all"). Only numeric-scored rows (`score IS NOT NULL`) count."""
    query = (
        _latest_results_cte()
        + """
        SELECT date(latest.created_at::timestamptz) AS date, latest.metric,
               AVG(latest.score) AS mean, COUNT(*) AS n
        FROM latest
        JOIN runs r ON r.run_id = latest.run_id
        WHERE latest.score IS NOT NULL
          AND latest.created_at::timestamptz >= (now() - (%s || ' days')::interval)
        """
    )
    params: list[Any] = [since_days]
    if owner_id is not None:
        query += " AND r.owner_id = %s"
        params.append(owner_id)
    if agent_id is not None:
        query += " AND latest.agent_id = %s"
        params.append(agent_id)
    query += " GROUP BY 1, 2 ORDER BY 1, 2"
    with db.connect(dsn) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
        return [dict(r) for r in rows]


def overview_by_agent(
    *, owner_id: Optional[str], since_days: int, dsn: Optional[str] = None
) -> list[dict[str, Any]]:
    """Per-agent `(agent_id, metric, mean, n)` rows over the window."""
    query = (
        _latest_results_cte()
        + """
        SELECT latest.agent_id, latest.metric, AVG(latest.score) AS mean, COUNT(*) AS n
        FROM latest
        JOIN runs r ON r.run_id = latest.run_id
        WHERE latest.score IS NOT NULL
          AND latest.created_at::timestamptz >= (now() - (%s || ' days')::interval)
        """
    )
    params: list[Any] = [since_days]
    if owner_id is not None:
        query += " AND r.owner_id = %s"
        params.append(owner_id)
    query += " GROUP BY 1, 2 ORDER BY 1, 2"
    with db.connect(dsn) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
        return [dict(r) for r in rows]


def overview_worst_runs(
    *,
    owner_id: Optional[str],
    since_days: int,
    metric: str = "task_success",
    limit: int = 10,
    agent_id: Optional[str] = None,
    dsn: Optional[str] = None,
) -> list[dict[str, Any]]:
    """The `limit` lowest-scoring runs on `metric` over the window — backs
    the overview's "worst runs" list, linking to the run inspector."""
    query = (
        _latest_results_cte()
        + """
        SELECT latest.run_id, latest.session_id, latest.agent_id, latest.score,
               latest.rationale, latest.created_at
        FROM latest
        JOIN runs r ON r.run_id = latest.run_id
        WHERE latest.metric = %s AND latest.score IS NOT NULL
          AND latest.created_at::timestamptz >= (now() - (%s || ' days')::interval)
        """
    )
    params: list[Any] = [metric, since_days]
    if owner_id is not None:
        query += " AND r.owner_id = %s"
        params.append(owner_id)
    if agent_id is not None:
        query += " AND latest.agent_id = %s"
        params.append(agent_id)
    query += " ORDER BY latest.score ASC, latest.created_at DESC LIMIT %s"
    params.append(limit)
    with db.connect(dsn) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
        return [dict(r) for r in rows]


def agent_success_rate(
    agent_id: str, *, owner_id: Optional[str] = None, dsn: Optional[str] = None
) -> dict[str, Any]:
    """The judge's `task_success` pass rate over this agent's scored runs
    (latest judge row per run; restricted to `owner_id`'s runs when given):
    `{scored, passed, success_rate}`. `success_rate` is None until a run of
    the agent has been scored."""
    query = (
        _latest_results_cte()
        + """
        SELECT COUNT(*) AS scored,
               COUNT(*) FILTER (WHERE COALESCE(latest.passed, latest.score >= 0.5)) AS passed
        FROM latest JOIN runs r ON r.run_id = latest.run_id
        WHERE latest.metric = 'task_success' AND latest.agent_id = %s
          AND (latest.passed IS NOT NULL OR latest.score IS NOT NULL)
        """
    )
    params: list[Any] = [agent_id]
    if owner_id is not None:
        query += " AND r.owner_id = %s"
        params.append(owner_id)
    with db.connect(dsn) as conn:
        row = require_row(conn.execute(query, tuple(params)).fetchone())
    scored = int(row["scored"] or 0)
    passed = int(row["passed"] or 0)
    return {"scored": scored, "passed": passed, "success_rate": passed / scored if scored else None}
