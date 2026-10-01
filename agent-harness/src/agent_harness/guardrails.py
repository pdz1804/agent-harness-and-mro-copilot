"""Guardrail evaluation logic, shared by the agent loop (real enforcement) and the
Guardrails test sandbox, so what the sandbox reports is exactly what a run would do.

Two rule kinds:

* `objective_pattern_block` - `config = {"patterns": [str, ...]}`; an enabled rule
  blocks a run whose objective contains any pattern (case-insensitive substring).
* `severity_upgrade_block` - an enabled rule caps a proposed `critical` incident to
  `high` unless the run's latest `get_service_status` result showed `down`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from agent_harness import db


def match_objective_patterns(objective: str, patterns: list[Any]) -> Optional[str]:
    """The first banned pattern contained in `objective` (case-insensitive), or None."""
    lowered = objective.lower()
    for pattern in patterns:
        if isinstance(pattern, str) and pattern.strip() and pattern.strip().lower() in lowered:
            return pattern
    return None


@dataclass(frozen=True)
class SeverityVerdict:
    """Outcome of the severity cap for one proposed incident severity."""

    fires: bool
    reason: str


def severity_verdict(severity: Optional[str], evidence_status: Optional[str]) -> SeverityVerdict:
    """Would the severity cap downgrade `severity` given the latest observed
    service status (`None` = the run has not checked any service yet)?"""
    if severity != "critical":
        return SeverityVerdict(False, f"severity '{severity}' is not 'critical', so the cap does not apply")
    if evidence_status == "down":
        return SeverityVerdict(False, "critical is allowed: the last service status checked was 'down'")
    if evidence_status is None:
        return SeverityVerdict(
            True, "critical requires a get_service_status result showing 'down'; none was found in the run"
        )
    return SeverityVerdict(
        True, f"critical requires the last get_service_status result to show 'down', but it showed '{evidence_status}'"
    )


@dataclass
class RuleCheck:
    guardrail_id: str
    name: str
    kind: str
    enabled: bool
    fired: bool
    reason: str
    matched_pattern: Optional[str] = None


def evaluate_input(
    objective: str, severity: Optional[str] = None, evidence_status: Optional[str] = None
) -> list[RuleCheck]:
    """Run every configured rule (enabled or not) against a typed input. A
    disabled rule never fires but reports what it would have done, so an author
    can see the effect of turning it on. `severity` / `evidence_status` feed the
    severity cap; without a severity that rule is reported as not applicable."""
    checks: list[RuleCheck] = []
    for rule in db.list_guardrails():
        base = {"guardrail_id": rule["id"], "name": rule["name"], "kind": rule["kind"], "enabled": rule["enabled"]}
        if rule["kind"] == "objective_pattern_block":
            patterns = (rule.get("config") or {}).get("patterns") or []
            hit = match_objective_patterns(objective, patterns)
            if hit is None:
                reason = (
                    "no banned pattern appears in the text"
                    if patterns
                    else "the rule has no patterns configured, so it can never match"
                )
                checks.append(RuleCheck(**base, fired=False, reason=reason))
            elif rule["enabled"]:
                checks.append(
                    RuleCheck(
                        **base, fired=True, matched_pattern=hit,
                        reason=f"the text contains the banned pattern '{hit}': the run would be blocked before it starts",
                    )
                )
            else:
                checks.append(
                    RuleCheck(
                        **base, fired=False, matched_pattern=hit,
                        reason=f"the text contains '{hit}', but the rule is disabled, so nothing is blocked",
                    )
                )
        elif rule["kind"] == "severity_upgrade_block":
            if severity is None:
                checks.append(
                    RuleCheck(**base, fired=False, reason="not applicable: no incident severity was provided to check")
                )
                continue
            verdict = severity_verdict(severity, evidence_status)
            fires = verdict.fires and rule["enabled"]
            reason = verdict.reason if rule["enabled"] or not verdict.fires else (
                verdict.reason + " (the rule is disabled, so the severity is left as proposed)"
            )
            checks.append(RuleCheck(**base, fired=fires, reason=reason))
    return checks
