"""Dashboard templates (phase 06): code-authored, version-controlled
starting points for a new dashboard. Instantiating a template
(`POST /dashboards {"template_key": ...}`) *copies* its widget definitions
into real `dashboard_widgets` rows owned by the new dashboard — the
template itself is never referenced again afterward, so the user is free to
edit/delete/add widgets on their copy without touching the template.

Every query here targets the harness's real dev-shaped schema (`services`,
`incidents`, `runs`, `events`) — no placeholder/mock data, no reference to
tables that don't exist. `events.data` is stored as `TEXT` (a JSON string),
so any query reaching into it casts `data::jsonb` first, matching the
pattern already used by `agent_harness.db._TOKEN_TOTALS_SELECT`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class WidgetTemplate:
    kind: str
    title: str
    sql_query: str
    config: dict[str, Any]
    col_span: int = 6


@dataclass(frozen=True)
class DashboardTemplate:
    key: str
    name: str
    description: str
    widgets: tuple[WidgetTemplate, ...] = field(default_factory=tuple)


TEMPLATES: dict[str, DashboardTemplate] = {
    "blank": DashboardTemplate(
        key="blank",
        name="Blank dashboard",
        description="Start empty and add your own widgets.",
        widgets=(),
    ),
    "ops-overview": DashboardTemplate(
        key="ops-overview",
        name="Ops overview",
        description="Fleet health at a glance: up/degraded/down counts, incidents by severity, "
        "recent incidents, and the full service table.",
        widgets=(
            WidgetTemplate(
                kind="stat",
                title="Services healthy",
                sql_query="SELECT count(*) AS value FROM services WHERE status = 'operational'",
                config={"value_col": "value", "format": "number"},
                col_span=3,
            ),
            WidgetTemplate(
                kind="stat",
                title="Services degraded",
                sql_query="SELECT count(*) AS value FROM services WHERE status = 'degraded'",
                config={"value_col": "value", "format": "number"},
                col_span=3,
            ),
            WidgetTemplate(
                kind="stat",
                title="Services down",
                sql_query="SELECT count(*) AS value FROM services WHERE status = 'down'",
                config={"value_col": "value", "format": "number"},
                col_span=3,
            ),
            WidgetTemplate(
                kind="stat",
                title="Open incidents",
                sql_query="SELECT count(*) AS value FROM incidents WHERE status <> 'resolved'",
                config={"value_col": "value", "format": "number"},
                col_span=3,
            ),
            WidgetTemplate(
                kind="bar",
                title="Incidents by severity",
                sql_query="SELECT severity AS severity, count(*) AS n FROM incidents "
                "GROUP BY severity ORDER BY severity",
                config={"x_col": "severity", "y_cols": ["n"]},
                col_span=6,
            ),
            WidgetTemplate(
                kind="list",
                title="Recent incidents",
                sql_query="SELECT title AS title, severity AS subtitle, status AS badge, created_at "
                "FROM incidents ORDER BY created_at DESC LIMIT 10",
                config={"title_col": "title", "subtitle_col": "subtitle", "badge_col": "badge"},
                col_span=6,
            ),
            WidgetTemplate(
                kind="table",
                title="Service fleet",
                sql_query="SELECT name, status, latency_ms, error_rate, owner, last_checked "
                "FROM services ORDER BY name",
                config={"page_size": 20},
                col_span=12,
            ),
        ),
    ),
    "agent-performance": DashboardTemplate(
        key="agent-performance",
        name="Agent performance",
        description="Run volume, status mix, tool-call latency, token spend, and the most-used "
        "tools over time.",
        widgets=(
            WidgetTemplate(
                kind="line",
                title="Runs per day",
                sql_query="SELECT to_char(to_timestamp(started_at), 'YYYY-MM-DD') AS day, "
                "count(*) AS runs FROM runs GROUP BY day ORDER BY day",
                config={"x_col": "day", "y_cols": ["runs"]},
                col_span=6,
            ),
            WidgetTemplate(
                kind="pie",
                title="Run status mix",
                sql_query="SELECT status AS label, count(*) AS n FROM runs GROUP BY status",
                config={"label_col": "label", "value_col": "n"},
                col_span=6,
            ),
            WidgetTemplate(
                kind="stat",
                title="Avg tool-call latency",
                sql_query="SELECT COALESCE(AVG(latency_ms), 0) AS value FROM events "
                "WHERE event_type = 'tool_call_result'",
                config={"value_col": "value", "format": "duration_ms"},
                col_span=3,
            ),
            WidgetTemplate(
                kind="area",
                title="Tokens per day",
                sql_query="SELECT to_char(to_timestamp(timestamp), 'YYYY-MM-DD') AS day, "
                "COALESCE(SUM((data::jsonb -> 'llm_meta' ->> 'total_tokens')::bigint), 0) AS tokens "
                "FROM events WHERE event_type = 'llm_decision' AND data::jsonb ? 'llm_meta' "
                "GROUP BY day ORDER BY day",
                config={"x_col": "day", "y_cols": ["tokens"]},
                col_span=12,
            ),
            WidgetTemplate(
                kind="bar",
                title="Top tools",
                sql_query="SELECT data::jsonb ->> 'tool_name' AS tool, count(*) AS n FROM events "
                "WHERE event_type = 'tool_call_started' GROUP BY tool ORDER BY n DESC LIMIT 10",
                config={"x_col": "tool", "y_cols": ["n"]},
                col_span=6,
            ),
            WidgetTemplate(
                kind="table",
                title="Recent runs",
                sql_query="SELECT run_id, objective, status, steps_taken FROM runs "
                "ORDER BY started_at DESC LIMIT 20",
                config={"page_size": 20},
                col_span=6,
            ),
        ),
    ),
    "incident-analytics": DashboardTemplate(
        key="incident-analytics",
        name="Incident analytics",
        description="Open/critical incident counts, severity breakdown, incident volume over time, "
        "and the latest incidents.",
        widgets=(
            WidgetTemplate(
                kind="stat",
                title="Open incidents",
                sql_query="SELECT count(*) AS value FROM incidents WHERE status <> 'resolved'",
                config={"value_col": "value", "format": "number"},
                col_span=4,
            ),
            WidgetTemplate(
                kind="stat",
                title="Critical incidents",
                sql_query="SELECT count(*) AS value FROM incidents WHERE severity = 'critical'",
                config={"value_col": "value", "format": "number"},
                col_span=4,
            ),
            WidgetTemplate(
                kind="bar",
                title="Incidents by severity",
                sql_query="SELECT severity AS severity, count(*) AS n FROM incidents "
                "GROUP BY severity ORDER BY severity",
                config={"x_col": "severity", "y_cols": ["n"]},
                col_span=4,
            ),
            WidgetTemplate(
                kind="line",
                title="Incidents over time",
                sql_query="SELECT substring(created_at, 1, 10) AS day, count(*) AS n FROM incidents "
                "GROUP BY day ORDER BY day",
                config={"x_col": "day", "y_cols": ["n"]},
                col_span=12,
            ),
            WidgetTemplate(
                kind="table",
                title="Latest incidents",
                sql_query="SELECT id, title, severity, status, created_at FROM incidents "
                "ORDER BY created_at DESC LIMIT 20",
                config={"page_size": 20},
                col_span=12,
            ),
        ),
    ),
}


def get_template(key: str) -> DashboardTemplate:
    if key not in TEMPLATES:
        raise KeyError(f"unknown dashboard template '{key}' (known: {sorted(TEMPLATES)})")
    return TEMPLATES[key]


def list_templates() -> list[DashboardTemplate]:
    return list(TEMPLATES.values())
