"""Persistence for `runs` and their `events` (trace), plus the token aggregations over events."""

from __future__ import annotations

import json
import time
from typing import Any, Optional

from agent_harness.repos.base import connect, require_row


def upsert_run(record: dict[str, Any], dsn: Optional[str] = None) -> None:
    # `session_id`/`prompt_version_id`/`triggered_by_automation_id` default to
    # None so every existing caller (e.g. `POST /run`'s synchronous flow,
    # which never sets any of them) keeps working unchanged — only the
    # async `POST /runs` flow (`RunRegistry`) passes real values, and only a
    # run started by `api.py::_trigger_automations` (12d) ever sets the
    # automation id. `owner_id` (phase 01) defaults to the fixed `u_admin`
    # seed identity so `POST /run`'s synchronous flow (which has no concept
    # of a caller identity) and any pre-RBAC caller keep working — the async
    # `POST /runs` flow always passes the real authenticated caller's id.
    record = {
        "session_id": None,
        "prompt_version_id": None,
        "triggered_by_automation_id": None,
        "owner_id": "u_admin",
        "agent_id": None,
        "skill_ids": [],
        **record,
    }
    with connect(dsn) as conn:
        conn.execute(
            "INSERT INTO runs (run_id, objective, status, started_at, finished_at, "
            "final_answer, steps_taken, trace_path, error, session_id, prompt_version_id, "
            "triggered_by_automation_id, owner_id, agent_id, skill_ids) "
            "VALUES (%(run_id)s, %(objective)s, %(status)s, %(started_at)s, %(finished_at)s, "
            "%(final_answer)s, %(steps_taken)s, %(trace_path)s, %(error)s, %(session_id)s, "
            "%(prompt_version_id)s, %(triggered_by_automation_id)s, %(owner_id)s, "
            "%(agent_id)s, %(skill_ids)s) "
            "ON CONFLICT (run_id) DO UPDATE SET "
            "status=excluded.status, finished_at=excluded.finished_at, "
            "final_answer=excluded.final_answer, steps_taken=excluded.steps_taken, "
            "error=excluded.error, "
            "session_id=COALESCE(runs.session_id, excluded.session_id), "
            "prompt_version_id=COALESCE(runs.prompt_version_id, excluded.prompt_version_id), "
            "triggered_by_automation_id=COALESCE(runs.triggered_by_automation_id, "
            "excluded.triggered_by_automation_id), "
            "owner_id=COALESCE(runs.owner_id, excluded.owner_id), "
            "agent_id=COALESCE(runs.agent_id, excluded.agent_id), "
            "skill_ids=COALESCE(runs.skill_ids, excluded.skill_ids)",
            record,
        )


def append_event(
    run_id: str,
    step: int,
    event_type: str,
    timestamp: float,
    latency_ms: Optional[float],
    data: dict[str, Any],
    dsn: Optional[str] = None,
) -> None:
    with connect(dsn) as conn:
        conn.execute(
            "INSERT INTO events (run_id, step, event_type, timestamp, latency_ms, data) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (run_id, step, event_type, timestamp, latency_ms, json.dumps(data, default=str)),
        )


def list_runs(dsn: Optional[str] = None) -> list[dict[str, Any]]:
    with connect(dsn) as conn:
        rows = conn.execute("SELECT * FROM runs ORDER BY started_at DESC").fetchall()
        return [dict(r) for r in rows]


def list_runs_for_session(session_id: str, dsn: Optional[str] = None) -> list[dict[str, Any]]:
    """Every run started under `session_id`, most recent first — backs the
    Memory view (a session can have more than one run, e.g. after a page
    reload starts a fresh objective in the same chat)."""
    with connect(dsn) as conn:
        rows = conn.execute(
            "SELECT * FROM runs WHERE session_id = %s ORDER BY started_at DESC", (session_id,)
        ).fetchall()
        return [dict(r) for r in rows]


# Shared by `aggregate_run_tokens`/`aggregate_usage_today` below. `data` is
# stored as TEXT (`json.dumps(...)`, see `append_event`), so every
# aggregation casts it to `jsonb` inline rather than requiring a schema
# migration to a jsonb column. Only `llm_decision` events ever carry
# `llm_meta` (see `loop.py::_log_llm_decision`), and only when the model
# response had a non-null `usage` — real provider calls always do; some
# scripted test doubles don't set token counts, in which case the
# individual `->>'...'` lookups below yield SQL NULL, which `SUM`/`COALESCE`
# treat as "contributes 0", not an error.
_TOKEN_TOTALS_SELECT = """
    SELECT
        COALESCE(SUM((data::jsonb -> 'llm_meta' ->> 'prompt_tokens')::bigint), 0) AS prompt_tokens,
        COALESCE(SUM((data::jsonb -> 'llm_meta' ->> 'completion_tokens')::bigint), 0) AS completion_tokens,
        COALESCE(SUM((data::jsonb -> 'llm_meta' ->> 'total_tokens')::bigint), 0) AS total_tokens,
        COUNT(*) AS llm_calls
"""


def aggregate_run_tokens(run_id: str, dsn: Optional[str] = None) -> dict[str, Any]:
    """Real SQL aggregation of prompt/completion/total token usage across
    every `llm_decision` event persisted for `run_id` — backs
    `GET /runs/{run_id}/tokens`. Returns all-zero totals (not None/404) for
    a run with no `llm_decision` events yet; the caller decides whether the
    run itself exists."""
    with connect(dsn) as conn:
        row = require_row(conn.execute(
            _TOKEN_TOTALS_SELECT
            + " FROM events WHERE run_id = %s AND event_type = 'llm_decision' "
            "AND data::jsonb ? 'llm_meta'",
            (run_id,),
        ).fetchone())
        return {
            "prompt_tokens": int(row["prompt_tokens"] or 0),
            "completion_tokens": int(row["completion_tokens"] or 0),
            "total_tokens": int(row["total_tokens"] or 0),
            "llm_calls": int(row["llm_calls"] or 0),
        }


def aggregate_usage_today(dsn: Optional[str] = None, owner_id: Optional[str] = None) -> dict[str, Any]:
    """Real SQL aggregation of token usage across every run's
    `llm_decision` events whose `timestamp` (epoch seconds) falls on the
    current server-local calendar day — backs `GET /usage/today`. Not a
    client-side sum: this is a single query against the persisted `events`
    table, same shape as `aggregate_run_tokens`. `owner_id` limits it to that
    user's own runs (None = everyone's, for admin)."""
    owner_clause = " AND run_id IN (SELECT run_id FROM runs WHERE owner_id = %s)" if owner_id else ""
    with connect(dsn) as conn:
        row = require_row(conn.execute(
            _TOKEN_TOTALS_SELECT
            + ", COUNT(DISTINCT run_id) AS run_count "
            "FROM events WHERE event_type = 'llm_decision' AND data::jsonb ? 'llm_meta' "
            "AND to_timestamp(timestamp) >= date_trunc('day', now())" + owner_clause,
            (owner_id,) if owner_id else (),
        ).fetchone())
        return {
            "prompt_tokens": int(row["prompt_tokens"] or 0),
            "completion_tokens": int(row["completion_tokens"] or 0),
            "total_tokens": int(row["total_tokens"] or 0),
            "llm_calls": int(row["llm_calls"] or 0),
            "run_count": int(row["run_count"] or 0),
        }


_ACTIVE_STATUSES = ("running", "pending_approval")
ORPHAN_REASON = "interrupted: the server restarted while this run was in progress (no live worker)"


def mark_orphaned_runs(dsn: Optional[str] = None) -> int:
    """Mark every run still `running`/`pending_approval` as `failed` with a clear
    reason. Called once at startup, when this process holds no live worker, so
    any such row was left behind by a previous process (restart/crash) and
    would otherwise read "running" forever. Returns the number of rows updated."""
    with connect(dsn) as conn:
        cur = conn.execute(
            "UPDATE runs SET status = 'failed', finished_at = %s, error = COALESCE(error, %s) "
            "WHERE status = ANY(%s)",
            (time.time(), ORPHAN_REASON, list(_ACTIVE_STATUSES)),
        )
        return cur.rowcount


def cancel_orphaned_run(run_id: str, dsn: Optional[str] = None) -> bool:
    """Stop a run that exists only in the database (no live worker in this
    process): flip a non-terminal row to `cancelled`. Returns False if the row
    is missing or already terminal."""
    with connect(dsn) as conn:
        cur = conn.execute(
            "UPDATE runs SET status = 'cancelled', finished_at = %s, "
            "error = COALESCE(error, 'cancelled: the run had no live worker in this server') "
            "WHERE run_id = %s AND status = ANY(%s)",
            (time.time(), run_id, list(_ACTIVE_STATUSES)),
        )
        return cur.rowcount > 0


def get_run(run_id: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with connect(dsn) as conn:
        row = conn.execute("SELECT * FROM runs WHERE run_id = %s", (run_id,)).fetchone()
        if row is None:
            return None
        run = dict(row)
        events = conn.execute(
            "SELECT step, event_type, timestamp, latency_ms, data FROM events "
            "WHERE run_id = %s ORDER BY id",
            (run_id,),
        ).fetchall()
        run["history"] = [
            {
                "run_id": run_id,
                "step": e["step"],
                "event_type": e["event_type"],
                "timestamp": e["timestamp"],
                "latency_ms": e["latency_ms"],
                "data": json.loads(e["data"]),
            }
            for e in events
        ]
        return run


# --- per-tool call history (Integrations detail) -------------------------------
#
# A tool "call" is every `tool_call_result` / `tool_call_error` /
# `tool_call_timeout` event: each attempt is one row, so a call that failed once
# and then succeeded on retry counts as one error and one success.

_TOOL_ATTEMPT_EVENTS = ("tool_call_result", "tool_call_error", "tool_call_timeout")


def tool_call_stats(tool_name: str, owner_id: Optional[str] = None, dsn: Optional[str] = None) -> dict[str, Any]:
    """`{calls, errors, error_rate, avg_latency_ms}` over every persisted
    attempt of `tool_name` (restricted to `owner_id`'s runs when given)."""
    owner_clause = " AND run_id IN (SELECT run_id FROM runs WHERE owner_id = %s)" if owner_id else ""
    with connect(dsn) as conn:
        row = require_row(conn.execute(
            "SELECT COUNT(*) AS calls, "
            "COUNT(*) FILTER (WHERE event_type <> 'tool_call_result') AS errors, "
            "AVG(latency_ms) AS avg_latency_ms "
            "FROM events WHERE event_type = ANY(%s) AND data::jsonb ->> 'tool_name' = %s" + owner_clause,
            (list(_TOOL_ATTEMPT_EVENTS), tool_name) + ((owner_id,) if owner_id else ()),
        ).fetchone())
    calls = int(row["calls"] or 0)
    errors = int(row["errors"] or 0)
    return {
        "calls": calls,
        "errors": errors,
        "error_rate": errors / calls if calls else None,
        "avg_latency_ms": float(row["avg_latency_ms"]) if row["avg_latency_ms"] is not None else None,
    }


def recent_tool_calls(
    tool_name: str, limit: int = 15, owner_id: Optional[str] = None, dsn: Optional[str] = None
) -> list[dict[str, Any]]:
    owner_clause = " AND run_id IN (SELECT run_id FROM runs WHERE owner_id = %s)" if owner_id else ""
    with connect(dsn) as conn:
        rows = conn.execute(
            "SELECT run_id, step, event_type, timestamp, latency_ms, data FROM events "
            "WHERE event_type = ANY(%s) AND data::jsonb ->> 'tool_name' = %s" + owner_clause
            + " ORDER BY id DESC LIMIT %s",
            (list(_TOOL_ATTEMPT_EVENTS), tool_name) + ((owner_id,) if owner_id else ()) + (limit,),
        ).fetchall()
    out = []
    for r in rows:
        data = json.loads(r["data"])
        out.append(
            {
                "run_id": r["run_id"],
                "step": r["step"],
                "outcome": "ok" if r["event_type"] == "tool_call_result" else (
                    "timeout" if r["event_type"] == "tool_call_timeout" else "error"
                ),
                "timestamp": r["timestamp"],
                "latency_ms": r["latency_ms"],
                "attempt": data.get("attempt"),
                "args": data.get("args"),
                "error": data.get("error"),
            }
        )
    return out


def agent_run_stats(agent_id: str, owner_id: Optional[str] = None, dsn: Optional[str] = None) -> dict[str, Any]:
    """`{runs, by_status, avg_steps}` for one agent (restricted to `owner_id`'s
    runs when given)."""
    owner_clause = " AND owner_id = %s" if owner_id else ""
    params = (agent_id,) + ((owner_id,) if owner_id else ())
    with connect(dsn) as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) AS n, AVG(steps_taken) AS steps FROM runs WHERE agent_id = %s"
            + owner_clause + " GROUP BY status",
            params,
        ).fetchall()
    total = sum(int(r["n"]) for r in rows)
    weighted = sum(float(r["steps"] or 0) * int(r["n"]) for r in rows)
    return {
        "runs": total,
        "by_status": {r["status"]: int(r["n"]) for r in rows},
        "avg_steps": weighted / total if total else None,
    }
