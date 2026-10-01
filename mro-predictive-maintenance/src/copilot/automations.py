"""Fleet-scan-triggered automation rules.

``src.ops.service`` (phase 03, not owned by this phase and not edited here)
exposes no callback hook a later phase can register into -- so instead of
inventing one inside a file this phase cannot touch, automations are wired
at the one call site this phase *does* own: ``run_fleet_scan_with_automations``
below calls the real, unmodified ``src.ops.service.fleet_scan`` (no second
copy of scan/alert logic) and then evaluates enabled ``alert_opened`` rules
against every genuinely-new alert it returned. The ``/copilot/fleet-scan``
endpoint (this phase's router) is the equivalent of the existing
``/ops/fleet-scan`` endpoint plus automation dispatch; the plain
``/ops/fleet-scan`` endpoint (phase 03's) is unaffected and still exists for
scans that should never trigger the copilot.

Automation runs always end in ``awaiting_input`` (a work-order approval
card) -- the underlying agent tools are unconditionally approval-gated
(``src/copilot/tools.py``), so nothing here can create a work order without
a human, satisfying acceptance criterion 11 by construction, not by a
special case in this module.

Loop guard: the copilot's own tools (``src/copilot/tools.py``) never expose
a fleet-scan/rescan tool, so an automation-triggered run cannot recursively
trigger another fleet-scan.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.engine import Engine

from src.copilot.runs import RunManager
from src.copilot.tables import copilot_automation_runs, copilot_automations
from src.ops import service as ops_service
from src.ops.db import alerts

DEFAULT_PROMPT_TEMPLATE = (
    "Triage alert {alert_id} for {component_id} on {aircraft_id} (risk {risk:.2f}). "
    "Retrieve procedures, assess, propose a work order."
)
AUTOMATION_MAX_RUNS_PER_SCAN = 5


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def seed_default_automation(engine: Engine) -> None:
    """Seed one enabled default rule if the table is empty -- idempotent,
    safe to call on every service startup."""
    with engine.connect() as conn:
        existing = conn.execute(select(copilot_automations.c.id)).first()
        if existing is not None:
            return
        conn.execute(copilot_automations.insert().values(
            name="Auto-triage new alerts", enabled=True, trigger="alert_opened",
            condition_json=json.dumps({"min_risk": 0.0, "component_types": []}),
            prompt_template=DEFAULT_PROMPT_TEMPLATE, created_at=_now(),
        ))
        conn.commit()


def list_automations(engine: Engine) -> list[dict]:
    with engine.connect() as conn:
        rows = conn.execute(select(copilot_automations)).mappings().all()
    return [dict(r) for r in rows]


def create_automation(engine: Engine, *, name: str, trigger: str, condition: dict,
                       prompt_template: str, enabled: bool = True) -> dict:
    with engine.connect() as conn:
        result = conn.execute(copilot_automations.insert().values(
            name=name, enabled=enabled, trigger=trigger,
            condition_json=json.dumps(condition or {}), prompt_template=prompt_template,
            created_at=_now(),
        ))
        conn.commit()
        automation_id = result.inserted_primary_key[0]
        row = conn.execute(select(copilot_automations).where(copilot_automations.c.id == automation_id)).mappings().first()
    return dict(row)


def set_enabled(engine: Engine, automation_id: int, enabled: bool) -> dict:
    from sqlalchemy import update

    with engine.connect() as conn:
        row = conn.execute(select(copilot_automations).where(copilot_automations.c.id == automation_id)).mappings().first()
        if row is None:
            raise KeyError(f"automation {automation_id} not found")
        conn.execute(update(copilot_automations).where(copilot_automations.c.id == automation_id).values(enabled=enabled))
        conn.commit()
        row = conn.execute(select(copilot_automations).where(copilot_automations.c.id == automation_id)).mappings().first()
    return dict(row)


def _condition_matches(condition: dict, alert_row: dict) -> bool:
    min_risk = condition.get("min_risk", 0.0) or 0.0
    if alert_row["risk_score"] < min_risk:
        return False
    types = condition.get("component_types") or []
    if types and alert_row["component_type"] not in types:
        return False
    return True


def run_fleet_scan_with_automations(engine: Engine, store, run_manager: RunManager,
                                     window_days: int = 30, actor: str = "system:fleet-scan") -> dict:
    with engine.connect() as conn:
        result = ops_service.fleet_scan(conn, store, window_days=window_days)

    started: list[dict] = []
    if result.new_alerts:
        with engine.connect() as conn:
            rules = conn.execute(
                select(copilot_automations).where(copilot_automations.c.enabled.is_(True))
            ).mappings().all()
        rules = [r for r in rules if r["trigger"] == "alert_opened"]

        count = 0
        for alert_id in result.new_alerts:
            if count >= AUTOMATION_MAX_RUNS_PER_SCAN:
                break
            with engine.connect() as conn:
                alert_row = conn.execute(select(alerts).where(alerts.c.id == alert_id)).mappings().first()
            if alert_row is None:
                continue
            for rule in rules:
                condition = json.loads(rule["condition_json"] or "{}")
                if not _condition_matches(condition, dict(alert_row)):
                    continue
                with engine.connect() as conn:
                    dup = conn.execute(select(copilot_automation_runs.c.id).where(
                        copilot_automation_runs.c.automation_id == rule["id"],
                        copilot_automation_runs.c.alert_id == alert_id,
                    )).first()
                if dup is not None:
                    continue
                prompt = rule["prompt_template"].format(
                    alert_id=alert_id, component_id=alert_row["component_id"],
                    aircraft_id=alert_row["aircraft_id"], risk=alert_row["risk_score"],
                )
                run_id = run_manager.start_run(
                    prompt, trigger=f"automation:{rule['id']}", alert_id=alert_id, actor=actor,
                )
                with engine.connect() as conn:
                    conn.execute(copilot_automation_runs.insert().values(
                        automation_id=rule["id"], alert_id=alert_id, run_id=run_id, created_at=_now(),
                    ))
                    conn.commit()
                started.append({"automation_id": rule["id"], "alert_id": alert_id, "run_id": run_id})
                count += 1
                break  # one automation run per alert even if multiple rules match
    return {**result.as_dict(), "automation_runs": started}
