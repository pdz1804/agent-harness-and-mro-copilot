"""Schema sanity check and idempotent seeding of the default rows (services, integrations, prompts, guardrail, users, skills, agents)."""

from __future__ import annotations

import json
from typing import Any, Optional

from agent_harness import settings
from agent_harness.repos.base import connect, require_row

# Tables Alembic is expected to have created. Used by `init_db` as a cheap
# sanity check (fail fast with a clear error rather than a confusing
# "relation does not exist" from the first query) — it does not create
# anything itself.
_EXPECTED_TABLES = (
    "services",
    "incidents",
    "runs",
    "events",
    "chat_sessions",
    "prompts",
    "prompt_versions",
    "integrations",
    "guardrails",
    "automations",
    "dashboard_tiles",
    "dashboards",
    "dashboard_widgets",
    "users",
    "skills",
    "agents",
    "eval_runs",
    "eval_results",
    "kb_documents",
    "memories",
    "run_feedback",
)

# Mirrors `agent_harness.tools.registry.build_default_registry`'s tool names.
# Kept here (rather than importing the registry module, which would create a
# db -> tools -> db import cycle risk) since this is only used to seed
# `integrations` defensively for a database whose migration ran before these
# tools existed.
_DEFAULT_TOOL_NAMES = (
    "search_knowledge_base",
    "get_service_status",
    "create_incident",
    "create_dashboard",
    "add_widget",
    "remember",
    "recall",
)


def init_db(dsn: Optional[str] = None) -> None:
    """Verify the Alembic-managed schema is present. Raises RuntimeError
    with a clear message (instead of a confusing DB error later) if
    `alembic upgrade head` has not been run against this database yet."""
    with connect(dsn) as conn:
        rows = conn.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = ANY(%s)",
            (list(_EXPECTED_TABLES),),
        ).fetchall()
        found = {r["table_name"] for r in rows}
        missing = set(_EXPECTED_TABLES) - found
        if missing:
            raise RuntimeError(
                "agent_harness.db: missing table(s) "
                f"{sorted(missing)} — run `alembic upgrade head` "
                "(see README) before starting the app."
            )


def seed_services(dsn: Optional[str] = None, seed_path: Optional[Any] = None) -> int:
    """Seed `services` from the seed JSON file, only if the table is empty.

    Returns the number of rows inserted (0 if already seeded or the seed
    file is missing).
    """
    from pathlib import Path

    seed_file = Path(seed_path) if seed_path is not None else settings.SEED_SERVICES_PATH
    with connect(dsn) as conn:
        count = require_row(conn.execute("SELECT COUNT(*) AS n FROM services").fetchone())["n"]
        if count > 0 or not seed_file.exists():
            return 0
        services = json.loads(seed_file.read_text(encoding="utf-8"))
        for svc in services:
            conn.execute(
                "INSERT INTO services "
                "(name, status, latency_ms, error_rate, last_deploy, owner, last_checked) "
                "VALUES (%(name)s, %(status)s, %(latency_ms)s, %(error_rate)s, "
                "%(last_deploy)s, %(owner)s, %(last_checked)s)",
                {
                    "name": svc["name"],
                    "status": svc["status"],
                    "latency_ms": svc.get("latency_ms"),
                    "error_rate": svc.get("error_rate"),
                    "last_deploy": svc.get("last_deploy"),
                    "owner": svc.get("owner"),
                    "last_checked": svc.get("last_checked"),
                },
            )
        return len(services)


def seed_integrations(dsn: Optional[str] = None) -> int:
    """Seed `integrations` with every default tool name (enabled=TRUE), only
    for tool names not already present. Returns the number of rows inserted.
    The `8645d2ee0fbf` migration already seeds a fresh database; this is the
    defensive/idempotent counterpart `ensure_ready` calls on every process
    start, the same pattern as `seed_services`."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    inserted = 0
    with connect(dsn) as conn:
        for tool_name in _DEFAULT_TOOL_NAMES:
            cur = conn.execute(
                "INSERT INTO integrations (tool_name, enabled, updated_at) "
                "VALUES (%s, TRUE, %s) ON CONFLICT (tool_name) DO NOTHING",
                (tool_name, now),
            )
            inserted += cur.rowcount
    return inserted


# Mirrors `agent_harness.loop.SYSTEM_PROMPT`. Duplicated here (rather than
# imported) to avoid an import cycle (`loop.py` -> `tools.registry` ->
# `db.py`). `_DEFAULT_SKILL_ROUTER_PROMPT`/`_DEFAULT_EVAL_JUDGE_PROMPT` are
# drafted now (phase 02) and wired into the loop in phases 04/07 — seeding
# them as real, editable library entries from the start means there is
# never a hardcoded fallback string once those phases land, only a seed.
_DEFAULT_SYSTEM_PROMPT = (
    "You are an ops-assistant agent for an internal engineering team. "
    "Use the available tools to investigate before answering: call "
    "get_service_status to check a service's current status before "
    "escalating anything, call search_knowledge_base to find the "
    "relevant runbook, and only call create_incident when the evidence "
    "(service status and/or knowledge base findings) supports opening "
    "one. Choose severity from that evidence: critical/high for a "
    "confirmed outage or major customer impact, medium for a degraded "
    "service with impact still present after a remediation attempt, low "
    "for minor/cosmetic impact. get_service_status reports error_rate_pct "
    "as a percentage already (e.g. 4.1 means 4.1% of requests errored) — "
    "do not divide it further or call it a fraction. create_incident always requires a "
    "separate human approval step before it takes effect — you do not "
    "need to ask for approval yourself in your reply text, just call "
    "the tool when the evidence justifies it. Once you have enough "
    "information, reply with a plain-text final answer instead of "
    "calling another tool."
)

_DEFAULT_SKILL_ROUTER_PROMPT = (
    "You route an incoming objective to exactly one skill. You will be given "
    "the objective and a list of available skills (each with a name and "
    "description). Choose the single best-matching skill by name. If none "
    "clearly matches, choose the most general/default skill available."
)

_DEFAULT_EVAL_JUDGE_PROMPT = (
    "You are an LLM-as-judge evaluating one completed agent run. You will be "
    "given the run's objective, its full tool-call/decision trace, and its "
    "final answer. Judge whether the final answer is correct and "
    "well-supported by the trace, whether tool calls were necessary and "
    "used correctly, and whether the run followed its system prompt's "
    "policy (e.g. evidence-based severity, required investigation steps "
    "before escalating). Return a structured verdict."
)

# The 3 library prompts every database has from the moment the
# `add_prompt_library` migration runs — mirrors `repos.prompts.SEEDED_SLUGS`.
# Kept as a plain tuple (not imported from `repos.prompts`) to avoid a
# `db` -> `repos.prompts` -> `db` import cycle.
_SEED_PROMPTS = (
    ("ops-system", "Ops assistant system prompt", "system", _DEFAULT_SYSTEM_PROMPT),
    ("skill-router", "Skill router", "skill_router", _DEFAULT_SKILL_ROUTER_PROMPT),
    ("eval-judge", "Eval judge", "judge", _DEFAULT_EVAL_JUDGE_PROMPT),
)


def seed_prompt_library(dsn: Optional[str] = None) -> int:
    """Seed the 3 library prompts (`ops-system`/`skill-router`/`eval-judge`)
    each with one active v1 version, for any slug not already present.
    Returns the number of prompts inserted. The `add_prompt_library`
    migration already seeds/backfills a fresh or pre-phase-02 database; this
    is the defensive/idempotent counterpart `ensure_ready` calls on every
    process start, same pattern as `seed_integrations`/`seed_guardrails`."""
    import uuid
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    inserted = 0
    with connect(dsn) as conn:
        for slug, name, kind, content in _SEED_PROMPTS:
            existing = conn.execute(
                "SELECT id FROM prompts WHERE slug = %s", (slug,)
            ).fetchone()
            if existing is not None:
                continue
            prompt_id = f"prm-{uuid.uuid4().hex[:12]}"
            version_id = f"pv-{uuid.uuid4().hex[:12]}"
            conn.execute(
                "INSERT INTO prompts "
                "(id, slug, name, description, kind, owner_id, visibility, tags, "
                " active_version_id, archived_at, created_at, updated_at) "
                "VALUES (%s, %s, %s, NULL, %s, 'u_admin', 'shared', '{}', NULL, NULL, %s, %s)",
                (prompt_id, slug, name, kind, now, now),
            )
            conn.execute(
                "INSERT INTO prompt_versions "
                "(id, prompt_id, version, content, change_note, created_by, is_active, created_at) "
                "VALUES (%s, %s, 1, %s, 'Initial version', 'u_admin', TRUE, %s)",
                (version_id, prompt_id, content, now),
            )
            conn.execute(
                "UPDATE prompts SET active_version_id = %s WHERE id = %s",
                (version_id, prompt_id),
            )
            inserted += 1
    return inserted


def seed_guardrails(dsn: Optional[str] = None) -> int:
    """Seed the default `severity_upgrade_block` guardrail (enabled), only if
    not already present. Returns the number of rows inserted. The
    `9b1e3f6c2a4d` migration already seeds a fresh database; this is the
    defensive/idempotent counterpart `ensure_ready` calls on every process
    start (and after a test truncates the table), same pattern as
    `seed_integrations`. Does not seed any `objective_pattern_block` row —
    there is nothing useful to seed without operator-provided patterns."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    with connect(dsn) as conn:
        cur = conn.execute(
            "INSERT INTO guardrails (id, name, kind, config, enabled, created_at) "
            "VALUES (%s, %s, %s, %s, TRUE, %s) ON CONFLICT (id) DO NOTHING",
            ("gr-severity-cap", "Severity evidence cap", "severity_upgrade_block", "{}", now),
        )
        return cur.rowcount


_SEED_USERS = (
    ("u_admin", "Alice Admin", "admin"),
    ("u_editor", "Evan Editor", "editor"),
    ("u_viewer", "Vera Viewer", "viewer"),
    ("u_editor2", "Erin Editor", "editor"),
)


def seed_users(dsn: Optional[str] = None) -> int:
    """Seed the fixed RBAC demo identities (phase 01), only for ids not
    already present. Returns the number of rows inserted. The
    `e1a9c6f4b2d8` migration already seeds a fresh database; this is the
    defensive/idempotent counterpart `ensure_ready` calls on every process
    start, same pattern as `seed_integrations`/`seed_guardrails`."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    inserted = 0
    with connect(dsn) as conn:
        for user_id, display_name, role in _SEED_USERS:
            cur = conn.execute(
                "INSERT INTO users (id, display_name, role, created_at) "
                "VALUES (%s, %s, %s, %s) ON CONFLICT (id) DO NOTHING",
                (user_id, display_name, role, now),
            )
            inserted += cur.rowcount
    return inserted


_SEED_SKILLS = (
    (
        "triage-outage",
        "Triage outage",
        "Investigate a reported service outage: check status, then search runbooks.",
        "Check the affected service's current status first, then search the knowledge "
        "base for the matching runbook. Summarize findings before recommending next steps.",
        ["get_service_status", "search_knowledge_base"],
        ["auth-service is returning errors", "why is checkout down"],
    ),
    (
        "kb-answer",
        "KB answer",
        "Answer a question strictly from the knowledge base, citing doc ids.",
        "Answer only from the knowledge base. Always cite the doc id(s) you used. If "
        "nothing relevant is found, say so plainly instead of guessing.",
        ["search_knowledge_base"],
        ["how do we roll back a bad deploy", "what is our on-call escalation policy"],
    ),
    (
        "escalate-incident",
        "Escalate incident",
        "Confirm a service is actually degraded, then open an incident.",
        "Check the affected service's current status to confirm impact before opening "
        "an incident. Choose severity from that evidence.",
        ["get_service_status", "create_incident"],
        ["open an incident for payments-service", "escalate the auth outage"],
    ),
    (
        "service-health-report",
        "Service health report",
        "Summarize the current health of the service fleet.",
        "Check the status of the services relevant to the objective and summarize their "
        "health (status, latency, error rate) in a short report.",
        ["get_service_status"],
        ["give me a health report for the fleet", "how are our services doing today"],
    ),
    (
        "build-dashboard",
        "Build dashboard",
        "Design and create a live dashboard of read-only SQL widgets from a plain-language request.",
        "Turn the request into a small dashboard (2-6 widgets). Query only the harness tables "
        "(incidents, services, runs, events) with read-only SELECTs. Pick the widget kind that fits "
        "the data: stat for one number, bar/pie for a category breakdown, line/area for a series over "
        "time, table/list for rows. For 'X by category over time' pivot the category into columns "
        "(count(*) FILTER (WHERE severity = 'high') AS high) and bucket time with "
        "substring(created_at, 1, 10) for incidents. Call create_dashboard once with every widget; "
        "a human approves it first, and a widget whose query fails the dry run is rejected back to "
        "you, so fix the SQL and call again. After it is created, tell the user the dashboard name "
        "and where to find it (Dashboards page). Use add_widget only to extend an existing dashboard.",
        ["create_dashboard", "add_widget"],
        [
            "build me a dashboard of incidents by severity over time",
            "make a dashboard showing service health and open incidents",
        ],
    ),
)


def seed_skills(dsn: Optional[str] = None) -> int:
    """Seed the 4 default skills (shared, admin-owned), only for slugs not
    already present. Returns the number of rows inserted. The `add_skills`
    migration already seeds a fresh database; this is the defensive/
    idempotent counterpart `ensure_ready` calls on every process start, same
    pattern as `seed_integrations`/`seed_guardrails`/`seed_prompt_library`."""
    import uuid
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    inserted = 0
    with connect(dsn) as conn:
        for slug, name, description, instructions, allowed_tools, examples in _SEED_SKILLS:
            skill_id = f"skl-{uuid.uuid4().hex[:12]}"
            # ON CONFLICT DO NOTHING (rather than a preceding SELECT-then-INSERT)
            # so two concurrent `ensure_ready()` calls (e.g. the module-level
            # call in `api.py` racing a test's per-test reseed) can never both
            # observe "not present" and then both try to insert the same slug.
            cur = conn.execute(
                "INSERT INTO skills "
                "(id, slug, name, description, instructions, allowed_tools, examples, "
                " owner_id, visibility, enabled, created_at, updated_at, updated_by) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, 'u_admin', 'shared', TRUE, %s, %s, 'u_admin') "
                "ON CONFLICT (slug) DO NOTHING",
                (skill_id, slug, name, description, instructions, allowed_tools, examples, now, now),
            )
            inserted += cur.rowcount
    return inserted


def seed_agents(dsn: Optional[str] = None) -> int:
    """Seed the 2 default agents (`ops-assistant` — the default, `auto`-mode
    agent — and `kb-concierge`, `assigned` to `kb-answer`), only if not
    already present by slug. The `add_agents` migration already seeds a
    fresh database; this is the defensive/idempotent counterpart
    `ensure_ready` calls on every process start, same pattern as
    `seed_skills`. No-ops (returns 0) if the `ops-system` prompt or
    `kb-answer` skill isn't seeded yet (should not happen once
    `seed_prompt_library`/`seed_skills` have run first — see `ensure_ready`'s
    call order)."""
    import uuid

    now_row_sql = "SELECT now()::text AS n"
    inserted = 0
    with connect(dsn) as conn:
        ops_system_id = conn.execute(
            "SELECT id FROM prompts WHERE slug = 'ops-system'"
        ).fetchone()
        if ops_system_id is None:
            return 0
        ops_system_id = ops_system_id["id"]
        now = require_row(conn.execute(now_row_sql).fetchone())["n"]

        all_tool_names = list(_DEFAULT_TOOL_NAMES)
        agent_id = f"agt-{uuid.uuid4().hex[:12]}"
        cur = conn.execute(
            "INSERT INTO agents "
            "(id, slug, name, description, avatar_color, prompt_id, prompt_version_id, "
            " skill_mode, skill_ids, base_tools, max_steps, owner_id, visibility, "
            " is_default, created_at, updated_at) "
            "VALUES (%s, 'ops-assistant', 'Ops Assistant', "
            " 'The default general-purpose ops agent: auto-discovers a skill per objective, "
            "falls back to its base tool set otherwise.', '#6366f1', %s, NULL, "
            " 'auto', '{}', %s, NULL, 'u_admin', 'shared', TRUE, %s, %s) "
            "ON CONFLICT (slug) DO NOTHING",
            (agent_id, ops_system_id, all_tool_names, now, now),
        )
        inserted += cur.rowcount

        kb_answer = conn.execute("SELECT id FROM skills WHERE slug = 'kb-answer'").fetchone()
        if kb_answer is not None:
            concierge_id = f"agt-{uuid.uuid4().hex[:12]}"
            cur = conn.execute(
                "INSERT INTO agents "
                "(id, slug, name, description, avatar_color, prompt_id, prompt_version_id, "
                " skill_mode, skill_ids, base_tools, max_steps, owner_id, visibility, "
                " is_default, created_at, updated_at) "
                "VALUES (%s, 'kb-concierge', 'KB Concierge', "
                " 'Answers strictly from the knowledge base — always routed to the kb-answer "
                "skill, never any other tool.', '#0ea5e9', %s, NULL, "
                " 'assigned', %s, '{}', NULL, 'u_admin', 'shared', FALSE, %s, %s) "
                "ON CONFLICT (slug) DO NOTHING",
                (concierge_id, ops_system_id, [kb_answer["id"]], now, now),
            )
            inserted += cur.rowcount
    return inserted


def ensure_ready(dsn: Optional[str] = None, seed_path: Optional[Any] = None) -> None:
    """Verify tables exist (via Alembic) and seed services/integrations/the
    default prompt version/default guardrail/the RBAC demo users/the default
    skills/the default agents if empty. Idempotent — safe to call on every
    process start."""
    init_db(dsn)
    seed_services(dsn, seed_path)
    seed_integrations(dsn)
    seed_prompt_library(dsn)
    seed_guardrails(dsn)
    seed_users(dsn)
    seed_skills(dsn)
    seed_agents(dsn)
