"""Typed configuration for dashboard widgets (phase 06).

Each widget stores a `kind` (`stat|line|bar|area|pie|table|list`) plus a
`config` JSON blob describing how to map its SQL query's result columns onto
that visual — e.g. a `stat` widget's `value_col` names which column of the
(exactly one) result row holds the number to display. `validate_config` is
called on every widget create/update (422 on a bad shape before anything is
persisted); `check_result_shape` is called after every *execution* (refresh)
to catch a query whose live column names/row count no longer match what the
config promised — a mismatch here becomes that one widget's `last_error`,
never a 500, and never blocks the rest of the dashboard from rendering (see
`agent_harness.repos.dashboards.refresh_widget`).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter, ValidationError

WidgetKind = Literal["stat", "line", "bar", "area", "pie", "table", "list"]

ALL_WIDGET_KINDS: tuple[WidgetKind, ...] = ("stat", "line", "bar", "area", "pie", "table", "list")


class WidgetConfigError(ValueError):
    """Raised by `validate_config` (bad config shape, 422) and by
    `check_result_shape` (a live query result that doesn't match the
    widget's configured columns/row count — caught per-widget, never fatal
    to the rest of the dashboard)."""


class StatConfig(BaseModel):
    kind: Literal["stat"] = "stat"
    value_col: str = Field(min_length=1)
    format: Literal["number", "percent", "duration_ms", "currency"] = "number"
    delta_col: str | None = None
    suffix: str | None = None


class _SeriesConfigBase(BaseModel):
    x_col: str = Field(min_length=1)
    y_cols: list[str] = Field(min_length=1)
    stacked: bool = False


class LineConfig(_SeriesConfigBase):
    kind: Literal["line"] = "line"


class BarConfig(_SeriesConfigBase):
    kind: Literal["bar"] = "bar"


class AreaConfig(_SeriesConfigBase):
    kind: Literal["area"] = "area"


class PieConfig(BaseModel):
    kind: Literal["pie"] = "pie"
    label_col: str = Field(min_length=1)
    value_col: str = Field(min_length=1)


class TableConfig(BaseModel):
    kind: Literal["table"] = "table"
    columns: list[str] | None = None
    page_size: int = Field(default=20, ge=1, le=500)


class ListConfig(BaseModel):
    kind: Literal["list"] = "list"
    title_col: str = Field(min_length=1)
    subtitle_col: str | None = None
    badge_col: str | None = None


WidgetConfig = Union[StatConfig, LineConfig, BarConfig, AreaConfig, PieConfig, TableConfig, ListConfig]

_ADAPTER: TypeAdapter[Any] = TypeAdapter(
    Annotated[WidgetConfig, Field(discriminator="kind")]
)

_CONFIG_MODEL_BY_KIND: dict[str, type[BaseModel]] = {
    "stat": StatConfig,
    "line": LineConfig,
    "bar": BarConfig,
    "area": AreaConfig,
    "pie": PieConfig,
    "table": TableConfig,
    "list": ListConfig,
}


def validate_config(kind: str, config: dict[str, Any]) -> dict[str, Any]:
    """Validate `config` against the shape required by `kind`. Returns the
    normalized (defaults-filled) config dict on success. Raises
    `WidgetConfigError` with a human-readable message on any mismatch
    (unknown kind, missing required field, wrong type)."""
    if kind not in _CONFIG_MODEL_BY_KIND:
        raise WidgetConfigError(f"unknown widget kind '{kind}' (must be one of {ALL_WIDGET_KINDS})")
    payload = dict(config)
    payload["kind"] = kind
    try:
        model = _ADAPTER.validate_python(payload)
    except ValidationError as exc:
        raise WidgetConfigError(f"invalid config for kind '{kind}': {exc}") from exc
    return model.model_dump()


def check_result_shape(kind: str, config: dict[str, Any], columns: list[str], row_count: int) -> None:
    """Raise `WidgetConfigError` if a query's live result (`columns`,
    `row_count`) does not satisfy what `kind`/`config` promised — e.g. a
    `stat` widget whose query returned 2 rows, or a `line` widget whose
    `x_col` is no longer a column the query returns. Called after every
    widget execution; the caller (repos.dashboards) catches this and stores
    it as that widget's `last_error` instead of failing the whole refresh."""
    column_set = set(columns)

    def _require_columns(*names: str) -> None:
        missing = [n for n in names if n and n not in column_set]
        if missing:
            raise WidgetConfigError(
                f"query result is missing column(s) {missing} required by this widget's config "
                f"(query returned: {columns})"
            )

    if kind == "stat":
        _require_columns(config["value_col"], config.get("delta_col") or "")
        if row_count != 1:
            raise WidgetConfigError(f"stat widget requires the query to return exactly 1 row, got {row_count}")
    elif kind in ("line", "bar", "area"):
        _require_columns(config["x_col"], *config["y_cols"])
    elif kind == "pie":
        _require_columns(config["label_col"], config["value_col"])
    elif kind == "list":
        _require_columns(config["title_col"], config.get("subtitle_col") or "", config.get("badge_col") or "")
    elif kind == "table":
        if config.get("columns"):
            _require_columns(*config["columns"])
    else:
        raise WidgetConfigError(f"unknown widget kind '{kind}'")
