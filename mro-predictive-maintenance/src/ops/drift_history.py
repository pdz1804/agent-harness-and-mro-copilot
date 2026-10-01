"""Persisted PSI snapshots: the data behind ``GET /monitoring/drift/history``.

A snapshot is written every time drift is genuinely computed (a
``/monitoring/drift`` call or a fleet scan). Simulated shifts are never
persisted, so every point on the timeline is a measured value.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.engine import Connection

from src.ops.db import drift_snapshots

# A polled dashboard must not flood the timeline: a "drift_call" snapshot is
# skipped when the newest snapshot is younger than this. Fleet-scan snapshots
# are always written.
MIN_DRIFT_CALL_INTERVAL_S = 30.0


def _clean(value) -> float | None:
    if value is None:
        return None
    value = float(value)
    return None if math.isnan(value) or math.isinf(value) else value


def record_snapshot(conn: Connection, report: dict, trigger: str, now: datetime | None = None) -> int | None:
    """Persist one drift report. Returns the new row id, or None if throttled."""
    now = now or datetime.now(timezone.utc)
    if trigger == "drift_call":
        last = conn.execute(
            select(drift_snapshots.c.at).order_by(drift_snapshots.c.id.desc()).limit(1)
        ).scalar()
        if last is not None:
            age = (now - datetime.fromisoformat(last)).total_seconds()
            if age < MIN_DRIFT_CALL_INTERVAL_S:
                return None

    features = {name: _clean(info.get("psi")) for name, info in report["features"].items()}
    result = conn.execute(drift_snapshots.insert().values(
        at=now.isoformat(),
        trigger=trigger,
        overall=report["status"],
        score_psi=_clean(report.get("score_psi")),
        n_current=int(report["n_current"]),
        current_source=report.get("current_source"),
        features_json=json.dumps(features),
    ))
    conn.commit()
    return int(result.inserted_primary_key[0])


def list_snapshots(conn: Connection, window_days: int, points: int) -> list[dict]:
    """Newest ``points`` snapshots within ``window_days``, oldest first."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=window_days)).isoformat()
    rows = conn.execute(
        select(drift_snapshots)
        .where(drift_snapshots.c.at >= cutoff)
        .order_by(drift_snapshots.c.id.desc())
        .limit(points)
    ).mappings().all()
    return [
        {
            "at": r["at"],
            "overall": r["overall"],
            "score_psi": r["score_psi"],
            "features": json.loads(r["features_json"]),
            "trigger": r["trigger"],
            "n_current": r["n_current"],
        }
        for r in reversed(rows)
    ]
