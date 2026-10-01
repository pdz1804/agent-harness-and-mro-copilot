"""Minimal identity/role model for the copilot's HITL resolve endpoint.

No real auth exists in this app (``X-User`` is a free-text header the client
sends, trusted at face value -- see ``src/service/routers/ops.py``'s module
docstring). This module adds the smallest thing that makes an
``approved_by``/``resolved_by`` audit trail meaningful: a seeded list of
demo users the dashboard's identity picker offers, and a role per user that
gates who may resolve an ``approval``-kind pending item.

Unknown/unseeded users (e.g. ``engineer.demo``, used throughout the existing
test suite and automation triggers) default to the ``engineer`` role so
this stays backward compatible -- only the seeded ``viewer`` user is
deliberately locked out of approving/denying. This is a real, if minimal,
allow-list (``APPROVER_ROLES``), not a deny-list of one hardcoded name: a
future user added to ``ROLES`` with a non-approver role is blocked the same
way ``viewer`` is.
"""

from __future__ import annotations

from dataclasses import dataclass

# Seeded identities the dashboard's header picker offers. Order is the
# display order.
SEEDED_USERS: tuple[str, ...] = ("lead.engineer", "planner", "viewer")

# Role per seeded user. Any user not listed here (including every actor
# string used by existing tests/automations, e.g. "engineer.demo") is
# treated as "engineer" -- the default, permissive role -- so this addition
# never breaks an existing caller that predates identity.
ROLES: dict[str, str] = {
    "lead.engineer": "engineer",
    "planner": "engineer",
    "viewer": "viewer",
}

DEFAULT_ROLE = "engineer"

# Roles allowed to approve/deny an `approval`-kind pending item. Read tools
# and `ask_user` answers are never gated by this -- only the three
# approval-gated write tools (create_work_order, recommend_aircraft_status,
# acknowledge_alert) go through `resolve()`'s "approval" kind.
APPROVER_ROLES: frozenset[str] = frozenset({"engineer"})


@dataclass(frozen=True)
class SeededUser:
    id: str
    label: str
    role: str


def role_for(user: str) -> str:
    return ROLES.get(user, DEFAULT_ROLE)


def can_approve(user: str) -> bool:
    """Whether ``user`` may resolve an ``approval``-kind pending item
    (approve or deny) -- a viewer may still answer ``ask_user`` questions,
    just never act on a write-tool approval card."""
    return role_for(user) in APPROVER_ROLES


# Identities allowed to trigger a model retrain. An explicit allow-list (not a
# role): "engineer" is also the default role of every unknown actor string and
# of `planner`, none of whom may start a retrain.
RETRAIN_USERS: frozenset[str] = frozenset({"lead.engineer"})


def can_retrain(user: str | None) -> bool:
    return user in RETRAIN_USERS


def seeded_users() -> list[SeededUser]:
    return [SeededUser(id=u, label=u, role=ROLES[u]) for u in SEEDED_USERS]


__all__ = ["SEEDED_USERS", "ROLES", "DEFAULT_ROLE", "APPROVER_ROLES", "SeededUser", "role_for", "can_approve", "RETRAIN_USERS", "can_retrain", "seeded_users"]
