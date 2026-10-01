"""Server-side RBAC: role -> action permission matrix plus ownership/
visibility checks for individual resources (sessions, runs).

Identity is a local, header-based "identity switcher" (`X-User-Id`,
`?as_user=` for SSE), not real authentication — trivially spoofable by
design, documented honestly in the README and the UI. What is real is the
enforcement path below: every mutating route in `api.py` resolves a
`CurrentUser` via `current_user()` and then checks `can()`/`can_read()`/
`can_write()` before touching data. A real IdP would only need to replace
`current_user()`'s header lookup — the matrix and checks stay the same.

Three roles:
- `admin`: everything, sees every resource regardless of ownership/visibility.
- `editor`: create/edit resources they own; use (read) shared resources;
  cannot mutate another user's private resource or global safety config
  (integrations/guardrails).
- `viewer`: read shared + own resources, may chat (create sessions/runs,
  approve their own run's pending approval), cannot mutate any config.

Unreadable resources 404 (don't leak existence via a 403 that would confirm
a private resource id is real); readable-but-unwritable resources 403.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

Role = Literal["admin", "editor", "viewer"]

# Global (non-resource-scoped) actions. Resource-scoped read/write/approve
# checks go through `can_read`/`can_write` below instead.
Action = Literal[
    "chat",
    "mutate_integrations",
    "mutate_guardrails",
    "mutate_prompts",
    "mutate_skills",
    "mutate_agents",
    "mutate_automations",
    "mutate_artifacts",
    "mutate_services",
    "mutate_kb",
    "mutate_incidents",
    "run_evals",
]

# `chat` (create sessions/runs; the product viewers are meant to use) is
# available to every role. Config mutation is editor+ except the two
# safety-posture tables (integrations, guardrails), which are admin-only.
PERMISSIONS: dict[Role, set[Action]] = {
    "admin": {
        "chat",
        "mutate_integrations",
        "mutate_guardrails",
        "mutate_prompts",
        "mutate_skills",
        "mutate_agents",
        "mutate_automations",
        "mutate_artifacts",
        "mutate_services",
        "mutate_kb",
        "mutate_incidents",
        "run_evals",
    },
    "editor": {
        "chat",
        "mutate_prompts",
        "mutate_skills",
        "mutate_agents",
        "mutate_automations",
        "mutate_artifacts",
        "mutate_services",
        "mutate_kb",
        "mutate_incidents",
        "run_evals",
    },
    "viewer": {"chat"},
}


def can(role: Role, action: Action) -> bool:
    return action in PERMISSIONS.get(role, set())


@dataclass(frozen=True)
class Resource:
    """The two facts needed to decide read/write access to an owned
    resource: who owns it, and whether it is visible beyond its owner."""

    owner_id: Optional[str]
    visibility: Literal["private", "shared"] = "private"


def can_read(user_id: str, role: Role, resource: Resource) -> bool:
    if role == "admin":
        return True
    if resource.visibility == "shared":
        return True
    return resource.owner_id == user_id


def can_write(user_id: str, role: Role, resource: Resource) -> bool:
    if role == "admin":
        return True
    if role == "viewer":
        return False
    return resource.owner_id == user_id


def can_manage(user_id: str, role: Role, resource: Resource) -> bool:
    """Who may rename, archive or delete something that belongs to a user (a
    chat session): the owner whatever their role (a viewer manages their own
    chats) or an admin."""
    if role == "admin":
        return True
    return resource.owner_id == user_id


def can_approve(user_id: str, role: Role, resource: Resource) -> bool:
    """Who may resolve a pending approval on a run: the owner (it is their
    chat — including a viewer's own run) or an admin."""
    if role == "admin":
        return True
    return resource.owner_id == user_id
