"""Postgres persistence facade.

The SQL lives in focused modules under `agent_harness.repos` (one per
table group); this module re-exports their public functions so the long-
standing `db.<function>` call sites (the API routers, the run registry, the
tools, the tests) keep working unchanged:

- `repos.base`           connection helper (`connect`, `get_dsn`)
- `repos.seeds`          schema check + idempotent default rows (`ensure_ready`)
- `repos.services`       the service registry
- `repos.incidents`      incident rows and their lifecycle
- `repos.runs`           runs, trace events, token aggregations
- `repos.sessions`       chat sessions joined with their latest run
- `repos.integrations`   per-tool enabled flag and timeout/retry settings
- `repos.guardrails`     guardrail rules and trigger history
- `repos.automations`    automation rules and the runs they started
- `repos.readonly_query` least-privilege SELECT execution for widgets

Schema management lives in Alembic (`alembic upgrade head`), not here.
"""

from __future__ import annotations

from agent_harness.repos.automations import (  # noqa: F401
    create_automation,
    list_automation_triggered_runs,
    list_automations,
    list_matching_enabled_automations,
    set_automation_enabled,
)
from agent_harness.repos.base import connect, get_dsn  # noqa: F401
from agent_harness.repos.guardrails import (  # noqa: F401
    create_guardrail,
    list_enabled_guardrails,
    list_guardrail_triggers,
    list_guardrails,
    set_guardrail_enabled,
)
from agent_harness.repos.incidents import find_incident, insert_incident, list_incidents  # noqa: F401
from agent_harness.repos.integrations import (  # noqa: F401
    list_enabled_tool_names,
    list_integrations,
    set_integration_enabled,
)
from agent_harness.repos.readonly_query import (  # noqa: F401
    READER_ROLE,
    READER_SCHEMA,
    QueryScope,
    describe_query_error,
    run_read_only_query,
    scope_for_user,
)
from agent_harness.repos.runs import (  # noqa: F401
    _TOKEN_TOTALS_SELECT,
    aggregate_run_tokens,
    aggregate_usage_today,
    append_event,
    cancel_orphaned_run,
    get_run,
    list_runs,
    list_runs_for_session,
    mark_orphaned_runs,
    upsert_run,
)
from agent_harness.repos.seeds import (  # noqa: F401
    ensure_ready,
    init_db,
    seed_agents,
    seed_guardrails,
    seed_integrations,
    seed_prompt_library,
    seed_services,
    seed_skills,
    seed_users,
)
from agent_harness.repos.services import get_service, list_services, set_service_status  # noqa: F401
from agent_harness.repos.sessions import (  # noqa: F401
    create_session,
    get_session,
    get_session_with_latest_run,
    list_sessions,
    touch_session,
)
