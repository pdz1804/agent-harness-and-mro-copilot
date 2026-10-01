"""Activity feed: one time-ordered list built from the events the ops database
already records (alert lifecycle events, work orders, copilot runs and their
resolved approvals, drift snapshots). Nothing here is synthesised; every item
points at a real row.

Bursts are collapsed: consecutive items (newest first) that share the same
``group`` key become one item with a ``count`` -- a fleet scan opens many
alerts within a second, and every visit to Monitoring records a drift
snapshot, so without this the feed would be one event type repeated.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.engine import Connection

from src.ops.db import alert_events, alerts, copilot_pending, copilot_runs, drift_snapshots, work_orders

DRIFT_WORD = {"ok": "Stable", "warn": "Watch", "alert": "Drift"}
ALERT_ACTION_WORD = {
    "opened": "opened",
    "acknowledge": "acknowledged",
    "dismiss": "dismissed",
    "close": "closed",
    "reopen": "reopened",
    "wo_raised": "moved to WO raised",
}
# Per-source cap before merging; the feed only ever shows the newest few.
_SOURCE_CAP = 200


def _item(at: str, kind: str, title: str, detail: str, actor: Optional[str], href: Optional[str], group: str) -> dict[str, Any]:
    return {"at": at, "kind": kind, "title": title, "detail": detail, "actor": actor, "href": href, "group": group, "count": 1}


def _alert_items(conn: Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        select(alert_events.c.at, alert_events.c.actor, alert_events.c.action, alert_events.c.alert_id, alerts.c.component_id)
        .select_from(alert_events.join(alerts, alerts.c.id == alert_events.c.alert_id))
        .order_by(alert_events.c.at.desc())
        .limit(_SOURCE_CAP)
    ).mappings().all()
    out = []
    for r in rows:
        word = ALERT_ACTION_WORD.get(r["action"], r["action"].replace("_", " "))
        out.append(
            _item(
                r["at"], "alert", f"Alert #{r['alert_id']} {word}", r["component_id"], r["actor"],
                f"ops/alerts/{r['alert_id']}", f"alert:{r['action']}:{r['actor']}",
            )
        )
    return out


def _work_order_items(conn: Connection) -> list[dict[str, Any]]:
    rows = conn.execute(select(work_orders).order_by(work_orders.c.created_at.desc()).limit(_SOURCE_CAP)).mappings().all()
    out = []
    for w in rows:
        out.append(
            _item(
                w["created_at"], "work_order", f"{w['id']} created",
                f"{w['component_id']} · {w['created_by']}, approved by {w['approved_by']}", w["approved_by"],
                f"ops/work-orders/{w['id']}", f"wo:{w['id']}:created",
            )
        )
        if w["closed_at"]:
            outcome = (w["outcome"] or "no outcome").replace("_", " ")
            out.append(
                _item(
                    w["closed_at"], "work_order", f"{w['id']} closed", f"{w['component_id']} · {outcome}", None,
                    f"ops/work-orders/{w['id']}", f"wo:{w['id']}:closed",
                )
            )
    return out


def _copilot_items(conn: Connection) -> list[dict[str, Any]]:
    out = []
    runs = conn.execute(select(copilot_runs).order_by(copilot_runs.c.created_at.desc()).limit(_SOURCE_CAP)).mappings().all()
    for r in runs:
        prompt = (r["user_prompt"] or "").strip().splitlines()
        first = prompt[0] if prompt else f"{r['trigger']} run"
        out.append(
            _item(
                r["created_at"], "copilot", "Copilot run started" if r["trigger"] == "user" else f"Copilot {r['trigger']} run started",
                first[:120], None, "ops/copilot", f"run:{r['id']}",
            )
        )
    resolved = conn.execute(
        select(copilot_pending)
        .where(copilot_pending.c.resolved_at.is_not(None), copilot_pending.c.kind == "approval")
        .order_by(copilot_pending.c.resolved_at.desc())
        .limit(_SOURCE_CAP)
    ).mappings().all()
    for p in resolved:
        decision = "resolved"
        try:
            decision = {"approve": "approved", "deny": "denied", "stale_cancelled": "cancelled"}.get(json.loads(p["resolution_json"] or "{}").get("decision"), "resolved")
        except (ValueError, AttributeError):
            pass
        out.append(
            _item(
                p["resolved_at"], "approval", f"{p['tool_name'] or 'Tool call'} {decision}", f"by {p['resolved_by'] or 'unknown'}",
                p["resolved_by"], "ops/copilot", f"pending:{p['id']}",
            )
        )
    return out


def _drift_items(conn: Connection) -> list[dict[str, Any]]:
    rows = conn.execute(select(drift_snapshots).order_by(drift_snapshots.c.at.desc()).limit(_SOURCE_CAP)).mappings().all()
    out = []
    for d in rows:
        word = DRIFT_WORD.get(d["overall"], d["overall"])
        psi = f"score PSI {d['score_psi']:.4f}" if d["score_psi"] is not None else "score PSI n/a"
        source = "fleet scan" if d["trigger"] == "fleet_scan" else "drift check"
        out.append(
            _item(
                d["at"], "drift", f"{source.capitalize()}: {word}", f"{psi} · {d['n_current']} predictions", None,
                "model/monitoring", f"drift:{d['trigger']}:{d['overall']}",
            )
        )
    return out


def collapse(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge consecutive items with the same ``group`` (input newest first);
    the merged item keeps the newest timestamp and counts the burst."""
    out: list[dict[str, Any]] = []
    for it in items:
        if out and out[-1]["group"] == it["group"]:
            out[-1]["count"] += 1
            continue
        out.append(dict(it))
    return out


def activity_feed(conn: Connection, limit: int = 20) -> list[dict[str, Any]]:
    merged = _alert_items(conn) + _work_order_items(conn) + _copilot_items(conn) + _drift_items(conn)
    merged.sort(key=lambda i: i["at"], reverse=True)
    feed = collapse(merged)[:limit]
    for it in feed:
        if it["count"] > 1 and it["kind"] == "alert":
            # "Alert #15 opened" x15 reads as "15 alerts opened".
            word = it["title"].split(" ", 2)[2]
            it["title"] = f"{it['count']} alerts {word}"
            it["href"] = "ops/alerts"
            it["detail"] = f"latest {it['detail']}"
    return feed
