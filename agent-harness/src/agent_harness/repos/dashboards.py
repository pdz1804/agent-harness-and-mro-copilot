"""Persistence + execution for dashboards/widgets (phase 06).

A dashboard is a named, owned, visibility-scoped collection of widgets.
Each widget stores a read-only SQL query plus a typed `config`
(`agent_harness.widget_config`) describing how to render its result as a
stat/chart/table/list. Refreshing a widget always re-executes its query
live (`agent_harness.db.run_read_only_query`, the same two-layer-enforced +
timeout/row-capped execution path every Artifacts tile used) — nothing here
ever serves a cached value as if it were fresh; the last successful result
is only kept as `last_result` so a freshly opened dashboard has something to
show before the first refresh completes.

If one widget's query fails (bad SQL, a shape mismatch, a timeout) that
failure is stored on *that widget's* `last_error` and every other widget in
the same refresh still executes — implemented by `refresh_widget` never
raising for a query-execution problem, only for truly unexpected bugs.
"""

from __future__ import annotations

import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import psycopg

from agent_harness import db
from agent_harness.dashboard_templates import get_template
from agent_harness.repos.base import require_row
from agent_harness.sql_guard import ReadOnlySqlViolation, validate_read_only_sql
from agent_harness.widget_config import WidgetConfigError, check_result_shape, validate_config


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_dashboard_id() -> str:
    return f"dash-{uuid.uuid4().hex[:12]}"


def _new_widget_id() -> str:
    return f"wgt-{uuid.uuid4().hex[:12]}"


def _row_to_dashboard(row: dict[str, Any]) -> dict[str, Any]:
    return dict(row)


def _row_to_widget(row: dict[str, Any]) -> dict[str, Any]:
    row = dict(row)
    row["config"] = json.loads(row["config"]) if row.get("config") else {}
    row["last_result"] = json.loads(row["last_result"]) if row.get("last_result") else None
    return row


# --- dashboards --------------------------------------------------------


def list_dashboards(dsn: Optional[str] = None) -> list[dict[str, Any]]:
    with db.connect(dsn) as conn:
        rows = conn.execute("SELECT * FROM dashboards WHERE deleted_at IS NULL ORDER BY updated_at DESC").fetchall()
        return [_row_to_dashboard(r) for r in rows]


def get_dashboard(
    dashboard_id: str, dsn: Optional[str] = None, *, include_deleted: bool = False
) -> Optional[dict[str, Any]]:
    suffix = "" if include_deleted else " AND deleted_at IS NULL"
    with db.connect(dsn) as conn:
        row = conn.execute("SELECT * FROM dashboards WHERE id = %s" + suffix, (dashboard_id,)).fetchone()
        return _row_to_dashboard(row) if row else None


def create_dashboard(
    *,
    name: str,
    description: str,
    template_key: str,
    owner_id: str,
    visibility: str,
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    """Create a dashboard and, if `template_key` names a non-blank
    template, copy its widget definitions in as real, independently
    editable `dashboard_widgets` rows (the template is never referenced
    again after this)."""
    template = get_template(template_key)  # raises KeyError (-> 422) if unknown
    now = _now()
    dashboard_id = _new_dashboard_id()
    with db.connect(dsn) as conn:
        conn.execute(
            "INSERT INTO dashboards "
            "(id, name, description, template_key, owner_id, visibility, layout_cols, created_at, updated_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, 12, %s, %s)",
            (dashboard_id, name, description, template_key, owner_id, visibility, now, now),
        )
        for position, widget in enumerate(template.widgets):
            validate_read_only_sql(widget.sql_query)  # catches a template-authoring bug, not user input
            conn.execute(
                "INSERT INTO dashboard_widgets "
                "(id, dashboard_id, kind, title, sql_query, config, position, col_span) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    _new_widget_id(),
                    dashboard_id,
                    widget.kind,
                    widget.title,
                    widget.sql_query,
                    json.dumps(validate_config(widget.kind, widget.config)),
                    position,
                    widget.col_span,
                ),
            )
    return get_dashboard(dashboard_id, dsn)  # type: ignore[return-value]


def create_dashboard_with_widgets(
    *,
    name: str,
    description: str,
    owner_id: str,
    visibility: str,
    widgets: list[dict[str, Any]],
    created_by_run_id: Optional[str] = None,
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    """Create a dashboard and all of `widgets` (dicts with `kind`/`title`/
    `sql_query`/`config`/`col_span`) in ONE transaction, so an agent-authored
    dashboard is either fully created or not at all. Every widget goes
    through the same two gates the REST widget route uses — the text-level
    `validate_read_only_sql` and the typed `validate_config` — before
    anything is written (raises `ReadOnlySqlViolation`/`WidgetConfigError`);
    the READ ONLY transaction layer applies later, on every execution."""
    prepared: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for widget in widgets:
        validate_read_only_sql(widget["sql_query"])
        prepared.append((widget, validate_config(widget["kind"], widget.get("config") or {})))
    now = _now()
    dashboard_id = _new_dashboard_id()
    with db.connect(dsn) as conn:
        conn.execute(
            "INSERT INTO dashboards "
            "(id, name, description, template_key, owner_id, visibility, layout_cols, "
            " created_at, updated_at, created_by_run_id) "
            "VALUES (%s, %s, %s, 'blank', %s, %s, 12, %s, %s, %s)",
            (dashboard_id, name, description, owner_id, visibility, now, now, created_by_run_id),
        )
        for position, (widget, config) in enumerate(prepared):
            conn.execute(
                "INSERT INTO dashboard_widgets "
                "(id, dashboard_id, kind, title, sql_query, config, position, col_span) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    _new_widget_id(),
                    dashboard_id,
                    widget["kind"],
                    widget["title"],
                    widget["sql_query"],
                    json.dumps(config),
                    position,
                    widget.get("col_span", 6),
                ),
            )
    return get_dashboard(dashboard_id, dsn)  # type: ignore[return-value]


def find_dashboard_by_run(
    run_id: str, name: str, dsn: Optional[str] = None
) -> Optional[dict[str, Any]]:
    """The dashboard an agent run already created under `name` — the
    idempotency guard so a re-proposed `create_dashboard` in the same run
    returns the existing row instead of duplicating it."""
    if not run_id:
        return None
    with db.connect(dsn) as conn:
        row = conn.execute(
            "SELECT * FROM dashboards WHERE created_by_run_id = %s AND name = %s AND deleted_at IS NULL",
            (run_id, name),
        ).fetchone()
        return _row_to_dashboard(row) if row else None


def duplicate_dashboard(
    dashboard_id: str, *, owner_id: str, name: Optional[str] = None, dsn: Optional[str] = None
) -> Optional[dict[str, Any]]:
    """Copy a dashboard and all of its widgets (query + config + layout, not
    the cached last result) into a new private dashboard owned by
    `owner_id`. `None` if `dashboard_id` is unknown."""
    source = get_dashboard(dashboard_id, dsn)
    if source is None:
        return None
    widgets = list_widgets(dashboard_id, dsn)
    copy = create_dashboard_with_widgets(
        name=name or f"{source['name']} (copy)",
        description=source["description"],
        owner_id=owner_id,
        visibility="private",
        widgets=[
            {
                "kind": w["kind"],
                "title": w["title"],
                "sql_query": w["sql_query"],
                "config": w["config"],
                "col_span": w["col_span"],
            }
            for w in widgets
        ],
        dsn=dsn,
    )
    update_dashboard(copy["id"], auto_refresh_seconds=source.get("auto_refresh_seconds"), dsn=dsn)
    return get_dashboard(copy["id"], dsn)


def update_dashboard(
    dashboard_id: str,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    visibility: Optional[str] = None,
    auto_refresh_seconds: Optional[int] = None,
    clear_auto_refresh: bool = False,
    dsn: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    fields: list[str] = []
    values: list[Any] = []
    if auto_refresh_seconds is not None:
        fields.append("auto_refresh_seconds = %s")
        values.append(auto_refresh_seconds)
    elif clear_auto_refresh:
        fields.append("auto_refresh_seconds = NULL")
    if name is not None:
        fields.append("name = %s")
        values.append(name)
    if description is not None:
        fields.append("description = %s")
        values.append(description)
    if visibility is not None:
        fields.append("visibility = %s")
        values.append(visibility)
    if not fields:
        return get_dashboard(dashboard_id, dsn)
    fields.append("updated_at = %s")
    values.append(_now())
    values.append(dashboard_id)
    with db.connect(dsn) as conn:
        cur = conn.execute(f"UPDATE dashboards SET {', '.join(fields)} WHERE id = %s", tuple(values))
        if cur.rowcount == 0:
            return None
    return get_dashboard(dashboard_id, dsn)


def delete_dashboard(dashboard_id: str, dsn: Optional[str] = None) -> bool:
    """Soft-delete (widgets stay, so a restore brings everything back).
    False if unknown or already deleted."""
    with db.connect(dsn) as conn:
        cur = conn.execute(
            "UPDATE dashboards SET deleted_at = %s WHERE id = %s AND deleted_at IS NULL", (_now(), dashboard_id)
        )
        return cur.rowcount > 0


def restore_dashboard(dashboard_id: str, dsn: Optional[str] = None) -> bool:
    """Undo `delete_dashboard`. False if the id is unknown or not deleted."""
    with db.connect(dsn) as conn:
        cur = conn.execute(
            "UPDATE dashboards SET deleted_at = NULL WHERE id = %s AND deleted_at IS NOT NULL", (dashboard_id,)
        )
        return cur.rowcount > 0


# --- widgets -------------------------------------------------------------


def list_widgets(dashboard_id: str, dsn: Optional[str] = None) -> list[dict[str, Any]]:
    with db.connect(dsn) as conn:
        rows = conn.execute(
            "SELECT * FROM dashboard_widgets WHERE dashboard_id = %s ORDER BY position, id",
            (dashboard_id,),
        ).fetchall()
        return [_row_to_widget(r) for r in rows]


def get_widget(dashboard_id: str, widget_id: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with db.connect(dsn) as conn:
        row = conn.execute(
            "SELECT * FROM dashboard_widgets WHERE dashboard_id = %s AND id = %s",
            (dashboard_id, widget_id),
        ).fetchone()
        return _row_to_widget(row) if row else None


def create_widget(
    dashboard_id: str,
    *,
    kind: str,
    title: str,
    sql_query: str,
    config: dict[str, Any],
    col_span: int,
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    """Validates the query is read-only and the config matches `kind`
    *before* saving (raises `ReadOnlySqlViolation`/`WidgetConfigError`, both
    translated to 422 by the router)."""
    validate_read_only_sql(sql_query)
    normalized_config = validate_config(kind, config)
    with db.connect(dsn) as conn:
        position_row = require_row(conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM dashboard_widgets "
            "WHERE dashboard_id = %s",
            (dashboard_id,),
        ).fetchone())
        position = position_row["next_position"]
        widget_id = _new_widget_id()
        conn.execute(
            "INSERT INTO dashboard_widgets "
            "(id, dashboard_id, kind, title, sql_query, config, position, col_span) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (widget_id, dashboard_id, kind, title, sql_query, json.dumps(normalized_config), position, col_span),
        )
        conn.execute("UPDATE dashboards SET updated_at = %s WHERE id = %s", (_now(), dashboard_id))
    return get_widget(dashboard_id, widget_id, dsn)  # type: ignore[return-value]


def update_widget(
    dashboard_id: str,
    widget_id: str,
    *,
    title: Optional[str] = None,
    sql_query: Optional[str] = None,
    config: Optional[dict[str, Any]] = None,
    col_span: Optional[int] = None,
    dsn: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    existing = get_widget(dashboard_id, widget_id, dsn)
    if existing is None:
        return None
    if sql_query is not None:
        validate_read_only_sql(sql_query)
    normalized_config = None
    if config is not None:
        normalized_config = validate_config(existing["kind"], config)

    fields: list[str] = []
    values: list[Any] = []
    if title is not None:
        fields.append("title = %s")
        values.append(title)
    if sql_query is not None:
        fields.append("sql_query = %s")
        values.append(sql_query)
    if normalized_config is not None:
        fields.append("config = %s")
        values.append(json.dumps(normalized_config))
    if col_span is not None:
        fields.append("col_span = %s")
        values.append(col_span)
    if not fields:
        return existing
    values.append(dashboard_id)
    values.append(widget_id)
    with db.connect(dsn) as conn:
        conn.execute(
            f"UPDATE dashboard_widgets SET {', '.join(fields)} WHERE dashboard_id = %s AND id = %s",
            tuple(values),
        )
        conn.execute("UPDATE dashboards SET updated_at = %s WHERE id = %s", (_now(), dashboard_id))
    return get_widget(dashboard_id, widget_id, dsn)


def delete_widget(dashboard_id: str, widget_id: str, dsn: Optional[str] = None) -> bool:
    with db.connect(dsn) as conn:
        cur = conn.execute(
            "DELETE FROM dashboard_widgets WHERE dashboard_id = %s AND id = %s", (dashboard_id, widget_id)
        )
        return cur.rowcount > 0


def reorder_widgets(dashboard_id: str, widget_ids: list[str], dsn: Optional[str] = None) -> None:
    with db.connect(dsn) as conn:
        for position, widget_id in enumerate(widget_ids):
            conn.execute(
                "UPDATE dashboard_widgets SET position = %s WHERE dashboard_id = %s AND id = %s",
                (position, dashboard_id, widget_id),
            )


# --- execution -------------------------------------------------------------


def refresh_widget(dashboard_id: str, widget_id: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    """Re-run one widget's stored query live and persist the outcome as its
    new snapshot (`last_result`/`last_error`/`last_run_ms`/`refreshed_at`).
    Never raises for a query-execution problem (bad SQL at the DB level, a
    config/result shape mismatch, a timeout) — those are captured as
    `last_error` so a caller refreshing an entire dashboard can keep going
    through every other widget. Returns the updated widget row, or `None`
    if `widget_id` doesn't exist under `dashboard_id`."""
    widget = get_widget(dashboard_id, widget_id, dsn)
    if widget is None:
        return None
    dashboard = get_dashboard(dashboard_id, dsn)
    # Queries always execute with the DASHBOARD OWNER's data scope, not the
    # refreshing viewer's: the stored `last_result` snapshot is shared with
    # everyone who can read the dashboard, so it must reflect exactly what the
    # owner is entitled to see (an admin-owned dashboard is fleet-wide; an
    # editor's dashboard only ever contains that editor's own rows).
    scope = db.scope_for_user(dashboard["owner_id"], dsn) if dashboard else db.QueryScope()

    started = time.monotonic()
    result_payload: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None
    try:
        validate_read_only_sql(widget["sql_query"])
        result = db.run_read_only_query(widget["sql_query"], dsn, scope=scope)
        check_result_shape(widget["kind"], widget["config"], result["columns"], len(result["rows"]))
        result_payload = result
    except ReadOnlySqlViolation as exc:
        error_message = str(exc)
    except WidgetConfigError as exc:
        error_message = str(exc)
    except psycopg.Error as exc:
        error_message = db.describe_query_error(exc)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    now = _now()

    with db.connect(dsn) as conn:
        conn.execute(
            "UPDATE dashboard_widgets SET last_result = %s, last_error = %s, last_run_ms = %s, "
            "refreshed_at = %s WHERE dashboard_id = %s AND id = %s",
            (
                json.dumps(result_payload, default=str) if result_payload is not None else None,
                error_message,
                elapsed_ms,
                now,
                dashboard_id,
                widget_id,
            ),
        )
    return get_widget(dashboard_id, widget_id, dsn)


def refresh_dashboard(dashboard_id: str, dsn: Optional[str] = None) -> list[dict[str, Any]]:
    """Refresh every widget on the dashboard, one at a time (sequential —
    fine at this scale; see phase file). A failing widget never stops the
    rest. Also bumps the dashboard's `last_refreshed_at`."""
    widgets = list_widgets(dashboard_id, dsn)
    refreshed = []
    for widget in widgets:
        updated = refresh_widget(dashboard_id, widget["id"], dsn)
        if updated is not None:
            refreshed.append(updated)
    with db.connect(dsn) as conn:
        conn.execute("UPDATE dashboards SET last_refreshed_at = %s WHERE id = %s", (_now(), dashboard_id))
    return refreshed


def preview_query(
    *,
    sql_query: str,
    kind: str,
    config: dict[str, Any],
    scope: db.QueryScope,
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    """Validate + execute a query without persisting anything — backs
    `POST /queries/preview`, used by the widget editor's "Test" button.
    `scope` is the caller's own data scope (what they would see)."""
    validate_read_only_sql(sql_query)
    normalized_config = validate_config(kind, config)
    result = db.run_read_only_query(sql_query, dsn, scope=scope)
    check_result_shape(kind, normalized_config, result["columns"], len(result["rows"]))
    return result
