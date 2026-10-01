"""Reset the ops store to its freshly seeded demo state.

Keeps what the fleet scan and the model produced -- the alert rows (same ids,
scores and ``opened_at``), their ``opened`` events, predictions, drift
snapshots and the default automation -- and removes everything a user or the
copilot did afterwards:

* every alert goes back to ``open``; all non-``opened`` alert events go;
* all work orders and aircraft-status overrides go;
* copilot runs, their pending items, stream events, guardrail events and
  automation-run records go (they reference work orders that no longer
  exist). ``--keep-copilot-runs`` skips this step.

Safe to run while the API is up (SQLite WAL); the dashboard picks up the
clean state on its next poll.

Usage (from the repo root, with the project virtualenv's python)::

    python scripts/reset_demo_data.py [--database-url URL] [--keep-copilot-runs]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sqlalchemy import Engine, delete, func, select, update

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.copilot import tables as copilot_tables  # noqa: E402 -- registers copilot tables on the metadata
from src.ops import db as ops_db  # noqa: E402


def reset_demo_data(engine: Engine, keep_copilot_runs: bool = False) -> dict[str, int]:
    """Reset ``engine``'s ops store in one transaction; returns rows touched per table."""
    ops_db.init_db(engine)
    counts: dict[str, int] = {}
    with engine.begin() as conn:
        counts["alerts_reopened"] = conn.execute(
            update(ops_db.alerts).where(ops_db.alerts.c.status != "open").values(status="open")
        ).rowcount
        counts["alert_events"] = conn.execute(
            delete(ops_db.alert_events).where(ops_db.alert_events.c.action != "opened")
        ).rowcount
        counts["work_orders"] = conn.execute(delete(ops_db.work_orders)).rowcount
        counts["aircraft_status"] = conn.execute(delete(ops_db.aircraft_status)).rowcount
        if not keep_copilot_runs:
            for table in (
                copilot_tables.copilot_events,
                copilot_tables.copilot_guardrail_events,
                copilot_tables.copilot_automation_runs,
                ops_db.copilot_pending,
                ops_db.copilot_runs,
            ):
                counts[table.name] = conn.execute(delete(table)).rowcount
        counts["alerts_total"] = conn.execute(select(func.count()).select_from(ops_db.alerts)).scalar_one()
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Reset the ops store to its freshly seeded demo state.")
    parser.add_argument("--database-url", default=None, help="defaults to DATABASE_URL or sqlite:///data/ops.db")
    parser.add_argument("--keep-copilot-runs", action="store_true", help="leave copilot run history in place")
    args = parser.parse_args(argv)
    engine = ops_db.make_engine(args.database_url)
    counts = reset_demo_data(engine, keep_copilot_runs=args.keep_copilot_runs)
    for name, n in counts.items():
        print(f"{name}: {n}")
    if counts["alerts_total"] == 0:
        print("note: no alerts in the store; run POST /ops/fleet-scan to seed them")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
