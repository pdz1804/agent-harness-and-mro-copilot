"""Dashboards routes (phase 06): templates, widgets, stored queries, live
refresh. RBAC follows the same ownership+visibility pattern as
`routers.skills`/`routers.prompts`: readable dashboards are `shared` ones
plus the caller's own private ones (admin sees all); creating/editing/
deleting a dashboard or its widgets requires `mutate_artifacts` *and*
resource-level ownership (or admin). Refreshing (read-only SQL execution)
is allowed for anyone who can *read* the dashboard, including a viewer on a
shared one — a refresh only updates the cached snapshot, never the
dashboard's content.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from agent_harness import db, rbac
from agent_harness.dashboard_templates import list_templates
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.rbac import Resource
from agent_harness.repos import dashboards as dashboards_repo
from agent_harness.sql_guard import ReadOnlySqlViolation
from agent_harness.widget_config import WidgetConfigError

router = APIRouter()

Visibility = Literal["private", "shared"]
WidgetKind = Literal["stat", "line", "bar", "area", "pie", "table", "list"]
ColSpan = Literal[3, 4, 6, 12]


class DashboardTemplateView(BaseModel):
    key: str
    name: str
    description: str
    widget_kinds: list[str]


class WidgetView(BaseModel):
    id: str
    dashboard_id: str
    kind: WidgetKind
    title: str
    sql_query: str
    config: dict[str, Any]
    position: int
    col_span: int
    last_result: Optional[dict[str, Any]] = None
    last_error: Optional[str] = None
    last_run_ms: Optional[int] = None
    refreshed_at: Optional[str] = None


class DashboardView(BaseModel):
    id: str
    name: str
    description: str
    template_key: str
    owner_id: str
    visibility: Visibility
    layout_cols: int
    last_refreshed_at: Optional[str] = None
    created_by_run_id: Optional[str] = Field(
        default=None,
        description="Set when an approved agent `create_dashboard` call created this dashboard "
        "(links back to that run).",
    )
    auto_refresh_seconds: Optional[int] = Field(
        default=None, description="Client-side auto-refresh interval; null means manual only."
    )
    created_at: str
    updated_at: str
    widgets: list[WidgetView] = Field(default_factory=list)


class CreateDashboardRequest(BaseModel):
    name: str = Field(min_length=1)
    template_key: str = "blank"
    description: str = ""
    visibility: Visibility = "private"


AUTO_REFRESH_CHOICES = (0, 10, 30, 60, 300)


class UpdateDashboardRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    visibility: Optional[Visibility] = None
    auto_refresh_seconds: Optional[int] = Field(
        default=None,
        description=f"One of {AUTO_REFRESH_CHOICES}; 0 turns auto-refresh off.",
    )


class DuplicateDashboardRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1)


class CreateWidgetRequest(BaseModel):
    kind: WidgetKind
    title: str = Field(min_length=1)
    sql_query: str = Field(min_length=1)
    config: dict[str, Any] = Field(default_factory=dict)
    col_span: ColSpan = 6


class UpdateWidgetRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1)
    sql_query: Optional[str] = Field(default=None, min_length=1)
    config: Optional[dict[str, Any]] = None
    col_span: Optional[ColSpan] = None


class ReorderWidgetsRequest(BaseModel):
    ids: list[str] = Field(min_length=1)


class PreviewQueryRequest(BaseModel):
    sql_query: str = Field(min_length=1)
    kind: WidgetKind
    config: dict[str, Any] = Field(default_factory=dict)


class PreviewQueryResult(BaseModel):
    columns: list[str]
    rows: list[dict[str, Any]]
    truncated: bool


def _resource_of(dashboard: dict[str, Any]) -> Resource:
    return Resource(owner_id=dashboard["owner_id"], visibility=dashboard["visibility"])


def _to_view(dashboard: dict[str, Any], widgets: list[dict[str, Any]]) -> DashboardView:
    return DashboardView(**dashboard, widgets=[WidgetView(**w) for w in widgets])


def _get_readable_or_404(dashboard_id: str, user: CurrentUser) -> dict[str, Any]:
    dashboard = dashboards_repo.get_dashboard(dashboard_id)
    if dashboard is None:
        raise HTTPException(status_code=404, detail=f"unknown dashboard '{dashboard_id}'")
    if not rbac.can_read(user.id, user.role, _resource_of(dashboard)):
        raise HTTPException(status_code=404, detail=f"unknown dashboard '{dashboard_id}'")
    return dashboard


def _require_writable(dashboard: dict[str, Any], user: CurrentUser) -> None:
    if not rbac.can_write(user.id, user.role, _resource_of(dashboard)):
        raise HTTPException(
            status_code=403,
            detail=f"role '{user.role}' may not modify dashboard '{dashboard['id']}'",
        )


@router.get("/dashboard-templates", response_model=list[DashboardTemplateView])
def list_dashboard_templates(user: CurrentUser = Depends(current_user)) -> list[DashboardTemplateView]:
    return [
        DashboardTemplateView(
            key=t.key,
            name=t.name,
            description=t.description,
            widget_kinds=sorted({w.kind for w in t.widgets}),
        )
        for t in list_templates()
    ]


@router.get("/dashboards", response_model=list[DashboardView])
def list_dashboards(user: CurrentUser = Depends(current_user)) -> list[DashboardView]:
    dashboards = dashboards_repo.list_dashboards()
    readable = [d for d in dashboards if rbac.can_read(user.id, user.role, _resource_of(d))]
    return [_to_view(d, dashboards_repo.list_widgets(d["id"])) for d in readable]


@router.post("/dashboards", response_model=DashboardView, status_code=201)
def create_dashboard(
    request: CreateDashboardRequest, user: CurrentUser = Depends(require("mutate_artifacts"))
) -> DashboardView:
    try:
        dashboard = dashboards_repo.create_dashboard(
            name=request.name,
            description=request.description,
            template_key=request.template_key,
            owner_id=user.id,
            visibility=request.visibility,
        )
    except KeyError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _to_view(dashboard, dashboards_repo.list_widgets(dashboard["id"]))


@router.get("/dashboards/{dashboard_id}", response_model=DashboardView)
def get_dashboard(dashboard_id: str, user: CurrentUser = Depends(current_user)) -> DashboardView:
    dashboard = _get_readable_or_404(dashboard_id, user)
    return _to_view(dashboard, dashboards_repo.list_widgets(dashboard_id))


@router.patch("/dashboards/{dashboard_id}", response_model=DashboardView)
def update_dashboard(
    dashboard_id: str,
    request: UpdateDashboardRequest,
    user: CurrentUser = Depends(require("mutate_artifacts")),
) -> DashboardView:
    dashboard = _get_readable_or_404(dashboard_id, user)
    _require_writable(dashboard, user)
    if request.auto_refresh_seconds is not None and request.auto_refresh_seconds not in AUTO_REFRESH_CHOICES:
        raise HTTPException(
            status_code=422, detail=f"auto_refresh_seconds must be one of {list(AUTO_REFRESH_CHOICES)}"
        )
    updated = dashboards_repo.update_dashboard(
        dashboard_id,
        name=request.name,
        description=request.description,
        visibility=request.visibility,
        auto_refresh_seconds=request.auto_refresh_seconds or None,
        clear_auto_refresh=request.auto_refresh_seconds == 0,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail=f"unknown dashboard '{dashboard_id}'")
    return _to_view(updated, dashboards_repo.list_widgets(dashboard_id))


@router.post("/dashboards/{dashboard_id}/duplicate", response_model=DashboardView, status_code=201)
def duplicate_dashboard(
    dashboard_id: str,
    request: DuplicateDashboardRequest,
    user: CurrentUser = Depends(require("mutate_artifacts")),
) -> DashboardView:
    """Copy a readable dashboard (widgets, queries, configs, layout) into a
    new private dashboard owned by the caller — no ownership of the source
    needed, only read access."""
    _get_readable_or_404(dashboard_id, user)
    copy = dashboards_repo.duplicate_dashboard(dashboard_id, owner_id=user.id, name=request.name)
    if copy is None:
        raise HTTPException(status_code=404, detail=f"unknown dashboard '{dashboard_id}'")
    return _to_view(copy, dashboards_repo.list_widgets(copy["id"]))


@router.delete("/dashboards/{dashboard_id}", status_code=204)
def delete_dashboard(
    dashboard_id: str, user: CurrentUser = Depends(require("mutate_artifacts"))
) -> None:
    dashboard = _get_readable_or_404(dashboard_id, user)
    _require_writable(dashboard, user)
    dashboards_repo.delete_dashboard(dashboard_id)


@router.post("/dashboards/{dashboard_id}/widgets", response_model=WidgetView, status_code=201)
def create_widget(
    dashboard_id: str,
    request: CreateWidgetRequest,
    user: CurrentUser = Depends(require("mutate_artifacts")),
) -> WidgetView:
    dashboard = _get_readable_or_404(dashboard_id, user)
    _require_writable(dashboard, user)
    try:
        widget = dashboards_repo.create_widget(
            dashboard_id,
            kind=request.kind,
            title=request.title,
            sql_query=request.sql_query,
            config=request.config,
            col_span=request.col_span,
        )
    except (ReadOnlySqlViolation, WidgetConfigError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return WidgetView(**widget)


@router.patch("/dashboards/{dashboard_id}/widgets/{widget_id}", response_model=WidgetView)
def update_widget(
    dashboard_id: str,
    widget_id: str,
    request: UpdateWidgetRequest,
    user: CurrentUser = Depends(require("mutate_artifacts")),
) -> WidgetView:
    dashboard = _get_readable_or_404(dashboard_id, user)
    _require_writable(dashboard, user)
    try:
        updated = dashboards_repo.update_widget(
            dashboard_id,
            widget_id,
            title=request.title,
            sql_query=request.sql_query,
            config=request.config,
            col_span=request.col_span,
        )
    except (ReadOnlySqlViolation, WidgetConfigError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail=f"unknown widget '{widget_id}'")
    return WidgetView(**updated)


@router.delete("/dashboards/{dashboard_id}/widgets/{widget_id}", status_code=204)
def delete_widget(
    dashboard_id: str, widget_id: str, user: CurrentUser = Depends(require("mutate_artifacts"))
) -> None:
    dashboard = _get_readable_or_404(dashboard_id, user)
    _require_writable(dashboard, user)
    if not dashboards_repo.delete_widget(dashboard_id, widget_id):
        raise HTTPException(status_code=404, detail=f"unknown widget '{widget_id}'")


@router.post("/dashboards/{dashboard_id}/widgets/reorder", response_model=DashboardView)
def reorder_widgets(
    dashboard_id: str,
    request: ReorderWidgetsRequest,
    user: CurrentUser = Depends(require("mutate_artifacts")),
) -> DashboardView:
    dashboard = _get_readable_or_404(dashboard_id, user)
    _require_writable(dashboard, user)
    dashboards_repo.reorder_widgets(dashboard_id, request.ids)
    return _to_view(dashboard, dashboards_repo.list_widgets(dashboard_id))


@router.post("/dashboards/{dashboard_id}/refresh", response_model=DashboardView)
def refresh_dashboard(dashboard_id: str, user: CurrentUser = Depends(current_user)) -> DashboardView:
    """Re-execute every widget's query live. Readable by anyone who can read
    the dashboard (including a viewer on a shared one) — refreshing only
    updates the cached snapshot, it never changes the dashboard's saved
    content."""
    _get_readable_or_404(dashboard_id, user)
    widgets = dashboards_repo.refresh_dashboard(dashboard_id)
    # Re-fetch the dashboard row *after* refresh_dashboard() bumps
    # last_refreshed_at, not before — otherwise the response carries a
    # stale timestamp even though the widgets themselves are fresh.
    dashboard = _get_readable_or_404(dashboard_id, user)
    return _to_view(dashboard, widgets)


@router.post("/dashboards/{dashboard_id}/widgets/{widget_id}/refresh", response_model=WidgetView)
def refresh_widget(
    dashboard_id: str, widget_id: str, user: CurrentUser = Depends(current_user)
) -> WidgetView:
    _get_readable_or_404(dashboard_id, user)
    updated = dashboards_repo.refresh_widget(dashboard_id, widget_id)
    if updated is None:
        raise HTTPException(status_code=404, detail=f"unknown widget '{widget_id}'")
    return WidgetView(**updated)


@router.post("/queries/preview", response_model=PreviewQueryResult)
def preview_query(
    request: PreviewQueryRequest, user: CurrentUser = Depends(require("mutate_artifacts"))
) -> PreviewQueryResult:
    """Validate + run a candidate widget query without saving anything —
    backs the widget editor's "Test" button. Requires the same
    `mutate_artifacts` permission as actually saving a widget (a viewer has
    no reason to probe arbitrary SQL against the database)."""
    try:
        result = dashboards_repo.preview_query(
            sql_query=request.sql_query,
            kind=request.kind,
            config=request.config,
            scope=db.QueryScope(user_id=user.id, is_admin=user.role == "admin"),
        )
    except (ReadOnlySqlViolation, WidgetConfigError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except psycopg.Error as exc:
        # Client-safe description only; the raw exception can carry
        # connection/server details.
        raise HTTPException(status_code=400, detail=db.describe_query_error(exc)) from exc
    return PreviewQueryResult(**result)
