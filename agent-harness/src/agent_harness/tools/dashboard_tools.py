"""Agent-authored dashboards: `create_dashboard` and `add_widget`.

Both tools are approval-gated. The agent writes real read-only SQL widgets;
before the human is asked, `precheck` runs every widget's query through the
exact same safety stack the REST widget routes use — `validate_read_only_sql`
(layer 1, text check), `validate_config` (typed widget config), then a live
dry run through `db.run_read_only_query` (layer 2: `READ ONLY` transaction +
statement timeout + row cap) and `check_result_shape` — and attaches a
preview (name, widgets, the SQL, columns, row counts, sample rows) to the
`approval_requested` event. A widget that cannot work is rejected back to the
LLM *before* the approval card appears, so the human only ever approves
something that will render. Approving persists a real dashboard via
`repos.dashboards` (same repo, same validation again at write time), owned by
the run's owner and linked to the run that created it.

RBAC: the run's owner needs `mutate_artifacts` (viewers never even see these
tools — `registry.build_default_registry` drops them — and `precheck`
re-checks in depth); `add_widget` additionally needs write access to the
target dashboard (`rbac.can_write`).
"""

from __future__ import annotations

from typing import Any, Literal, Optional

import psycopg
from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator

from agent_harness import db, rbac
from agent_harness.exceptions import ToolPrecheckError
from agent_harness.rbac import Resource
from agent_harness.repos import dashboards as dashboards_repo
from agent_harness.sql_guard import ReadOnlySqlViolation, validate_read_only_sql
from agent_harness.tools.base import Tool
from agent_harness.widget_config import WidgetConfigError, check_result_shape, validate_config

WidgetKindName = Literal["stat", "line", "bar", "area", "pie", "table", "list"]

_PREVIEW_SAMPLE_ROWS = 3
_PREVIEW_STATEMENT_TIMEOUT_MS = 4000

_SCHEMA_HINT = (
    "Queryable Postgres tables (read-only SELECT only): "
    "incidents(id, title, description, severity in low|medium|high|critical, status, "
    "created_at TEXT iso timestamp, run_id); "
    "services(name, status in operational|degraded|down, latency_ms, error_rate, last_deploy, owner, last_checked); "
    "runs(run_id, objective, status, started_at epoch-seconds float, finished_at, steps_taken, agent_id, owner_id); "
    "events(run_id, step, event_type, timestamp epoch-seconds float, latency_ms, data TEXT json - cast data::jsonb). "
    "Bucket incidents by day with substring(created_at,1,10); bucket runs with "
    "to_char(to_timestamp(started_at),'YYYY-MM-DD'). "
    "Widget config per kind: stat {value_col} (query must return exactly 1 row); "
    "line|bar|area {x_col, y_cols[]} (one column per series, so pivot a category into columns with "
    "count(*) FILTER (WHERE ...) AS name); pie {label_col, value_col}; table {} or {columns[]}; "
    "list {title_col, subtitle_col?, badge_col?}. Every column named in config must be returned by the query."
)


# A minimal valid config per kind that needs one (table needs none).
_CONFIG_EXAMPLE: dict[str, str] = {
    "stat": '{"value_col": "<count column>"}',
    "line": '{"x_col": "<x column>", "y_cols": ["<series column>"]}',
    "bar": '{"x_col": "<category column>", "y_cols": ["<value column>"]}',
    "area": '{"x_col": "<x column>", "y_cols": ["<series column>"]}',
    "pie": '{"label_col": "<label column>", "value_col": "<value column>"}',
    "list": '{"title_col": "<title column>"}',
}


class WidgetSpec(BaseModel):
    kind: WidgetKindName
    title: str = Field(min_length=1, max_length=120)
    sql_query: str = Field(
        min_length=1,
        description="A single read-only SELECT. Every column named in `config` must be returned by it.",
    )
    config: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Required for every kind except table: maps result columns onto the visual. "
            'stat {"value_col": "n"}; line|bar|area {"x_col": "day", "y_cols": ["open", "resolved"]}; '
            'pie {"label_col": "severity", "value_col": "n"}; list {"title_col": "title"}; table {}. '
            "Use the column names (aliases) your query returns."
        ),
    )
    col_span: Literal[3, 4, 6, 12] = Field(default=6, description="Width out of a 12-column grid.")

    @model_validator(mode="after")
    def _check_widget(self) -> WidgetSpec:
        # Same two static gates the REST route applies; a failure surfaces to
        # the LLM as a tool_validation_error so it can fix the widget and
        # retry — before any approval is requested.
        if not self.config and self.kind in _CONFIG_EXAMPLE:
            # The common LLM slip: no config at all. Say exactly what to add
            # instead of relaying a nested pydantic union error.
            raise ValueError(
                f"widget '{self.title}': a '{self.kind}' widget needs a config naming the query's columns, "
                f"e.g. config={_CONFIG_EXAMPLE[self.kind]}"
            )
        try:
            validate_read_only_sql(self.sql_query)
            validate_config(self.kind, self.config)
        except (ReadOnlySqlViolation, WidgetConfigError) as exc:
            raise ValueError(f"widget '{self.title}': {exc}") from exc
        return self


class CreateDashboardInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    widgets: list[WidgetSpec] = Field(min_length=1, max_length=8)
    visibility: Literal["private", "shared"] = "private"

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str, _info: ValidationInfo) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name must not be blank")
        return value


class CreateDashboardOutput(BaseModel):
    dashboard_id: str
    name: str
    widget_count: int
    location: str = Field(
        description="Where the user finds it. Describe it this way; there is no URL to share."
    )
    status: Literal["created"] = "created"


class AddWidgetInput(BaseModel):
    dashboard_id: str = Field(min_length=1)
    widget: WidgetSpec


class AddWidgetOutput(BaseModel):
    dashboard_id: str
    widget_id: str
    title: str
    status: Literal["added"] = "added"


def _location(name: str) -> str:
    return f"Open the Dashboards page in the sidebar and select '{name}'."


def _dry_run_widget(widget: WidgetSpec, scope: db.QueryScope) -> dict[str, Any]:
    """Execute one widget's query through the real read-only path and
    summarize it for the approval preview. Never raises; failures are
    reported in `error` so `precheck` can decide to reject."""
    entry: dict[str, Any] = {
        "kind": widget.kind,
        "title": widget.title,
        "sql_query": widget.sql_query,
        "config": widget.config,
        "col_span": widget.col_span,
        "columns": [],
        "row_count": 0,
        "sample_rows": [],
        "error": None,
    }
    try:
        result = db.run_read_only_query(
            widget.sql_query, statement_timeout_ms=_PREVIEW_STATEMENT_TIMEOUT_MS, scope=scope
        )
        normalized = validate_config(widget.kind, widget.config)
        check_result_shape(widget.kind, normalized, result["columns"], len(result["rows"]))
        entry["columns"] = result["columns"]
        entry["row_count"] = len(result["rows"])
        entry["sample_rows"] = [
            {k: (v if isinstance(v, (int, float, str, bool, type(None))) else str(v)) for k, v in row.items()}
            for row in result["rows"][:_PREVIEW_SAMPLE_ROWS]
        ]
    except (ReadOnlySqlViolation, WidgetConfigError) as exc:
        entry["error"] = str(exc)
    except psycopg.Error as exc:
        entry["error"] = db.describe_query_error(exc)
    return entry


class _OwnedTool:
    """Per-run identity binding shared by both dashboard tools."""

    def _init_owner(self) -> None:
        self._run_id: str = ""
        self._owner_id: Optional[str] = None
        self._owner_role: Optional[rbac.Role] = None

    def bind_context(self, **context: Any) -> None:
        if context.get("run_id"):
            self._run_id = str(context["run_id"])
        if context.get("owner_id"):
            self._owner_id = str(context["owner_id"])
        if context.get("owner_role"):
            self._owner_role = context["owner_role"]

    def _require_owner(self) -> tuple[str, rbac.Role]:
        if self._owner_id is None or self._owner_role is None:
            raise ToolPrecheckError(
                "dashboard tools need an authenticated run owner; this run has no owner context"
            )
        if not rbac.can(self._owner_role, "mutate_artifacts"):
            raise ToolPrecheckError(
                f"role '{self._owner_role}' is not permitted to create or edit dashboards"
            )
        return self._owner_id, self._owner_role


class CreateDashboardTool(_OwnedTool, Tool[CreateDashboardInput, CreateDashboardOutput]):
    name = "create_dashboard"
    description = (
        "Create a new dashboard made of read-only SQL widgets (stat, line, bar, area, pie, table, "
        "list). Requires human approval: the approver sees the dashboard name, each widget and its "
        "SQL, plus a live dry-run of every query. Use it when the user asks you to build/make a "
        "dashboard, chart or view of data. " + _SCHEMA_HINT
    )
    input_model = CreateDashboardInput
    output_model = CreateDashboardOutput
    requires_approval = True
    required_action = "mutate_artifacts"

    def __init__(self) -> None:
        self._init_owner()

    def precheck(self, args: CreateDashboardInput) -> dict[str, Any]:
        owner_id, role = self._require_owner()
        scope = db.QueryScope(user_id=owner_id, is_admin=role == "admin")
        widgets = [_dry_run_widget(w, scope) for w in args.widgets]
        failed = [w for w in widgets if w["error"]]
        if failed:
            details = "; ".join(f"widget '{w['title']}': {w['error']}" for w in failed)
            raise ToolPrecheckError(
                f"{len(failed)} widget(s) failed the read-only dry run, nothing was created: {details}. "
                "Fix the SQL/config and call create_dashboard again."
            )
        return {
            "kind": "dashboard",
            "name": args.name,
            "description": args.description,
            "visibility": args.visibility,
            "widgets": widgets,
        }

    def run(self, args: CreateDashboardInput) -> CreateDashboardOutput:
        owner_id, _role = self._require_owner()
        existing = dashboards_repo.find_dashboard_by_run(self._run_id, args.name)
        if existing is not None:
            widget_count = len(dashboards_repo.list_widgets(existing["id"]))
            return CreateDashboardOutput(
                dashboard_id=existing["id"],
                name=existing["name"],
                widget_count=widget_count,
                location=_location(existing["name"]),
            )
        dashboard = dashboards_repo.create_dashboard_with_widgets(
            name=args.name,
            description=args.description,
            owner_id=owner_id,
            visibility=args.visibility,
            widgets=[w.model_dump() for w in args.widgets],
            created_by_run_id=self._run_id or None,
        )
        # Populate every widget's snapshot so the dashboard opens with data.
        dashboards_repo.refresh_dashboard(dashboard["id"])
        return CreateDashboardOutput(
            dashboard_id=dashboard["id"],
            name=dashboard["name"],
            widget_count=len(args.widgets),
            location=_location(dashboard["name"]),
        )


class AddWidgetTool(_OwnedTool, Tool[AddWidgetInput, AddWidgetOutput]):
    name = "add_widget"
    description = (
        "Add one read-only SQL widget to an EXISTING dashboard the user can edit (pass its "
        "dashboard_id). Requires human approval with a preview and live dry-run of the query. "
        + _SCHEMA_HINT
    )
    input_model = AddWidgetInput
    output_model = AddWidgetOutput
    requires_approval = True
    required_action = "mutate_artifacts"

    def __init__(self) -> None:
        self._init_owner()

    def _writable_dashboard(self, dashboard_id: str) -> dict[str, Any]:
        owner_id, role = self._require_owner()
        dashboard = dashboards_repo.get_dashboard(dashboard_id)
        resource = (
            Resource(owner_id=dashboard["owner_id"], visibility=dashboard["visibility"])
            if dashboard
            else None
        )
        if dashboard is None or not rbac.can_read(owner_id, role, resource):  # type: ignore[arg-type]
            raise ToolPrecheckError(f"unknown dashboard '{dashboard_id}'")
        if not rbac.can_write(owner_id, role, resource):  # type: ignore[arg-type]
            raise ToolPrecheckError(f"you may not modify dashboard '{dashboard_id}'")
        return dashboard

    def precheck(self, args: AddWidgetInput) -> dict[str, Any]:
        dashboard = self._writable_dashboard(args.dashboard_id)
        owner_id, role = self._require_owner()
        entry = _dry_run_widget(args.widget, db.QueryScope(user_id=owner_id, is_admin=role == "admin"))
        if entry["error"]:
            raise ToolPrecheckError(
                f"widget '{entry['title']}' failed the read-only dry run, nothing was added: "
                f"{entry['error']}. Fix the SQL/config and call add_widget again."
            )
        return {
            "kind": "widget",
            "dashboard_id": dashboard["id"],
            "name": dashboard["name"],
            "widgets": [entry],
        }

    def run(self, args: AddWidgetInput) -> AddWidgetOutput:
        self._writable_dashboard(args.dashboard_id)
        spec = args.widget
        widget = dashboards_repo.create_widget(
            args.dashboard_id,
            kind=spec.kind,
            title=spec.title,
            sql_query=spec.sql_query,
            config=spec.config,
            col_span=spec.col_span,
        )
        dashboards_repo.refresh_widget(args.dashboard_id, widget["id"])
        return AddWidgetOutput(dashboard_id=args.dashboard_id, widget_id=widget["id"], title=widget["title"])
