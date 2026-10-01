"""Unit tests for `agent_harness.widget_config` (phase 06): config
validation (422-worthy shape errors) and post-execution result-shape
checking (per-widget `last_error`, never a 500)."""

from __future__ import annotations

import pytest

from agent_harness.widget_config import (
    WidgetConfigError,
    check_result_shape,
    validate_config,
)


def test_validate_config_accepts_stat():
    config = validate_config("stat", {"value_col": "value"})
    assert config["kind"] == "stat"
    assert config["format"] == "number"


def test_validate_config_rejects_unknown_kind():
    with pytest.raises(WidgetConfigError):
        validate_config("pyramid", {"value_col": "value"})


def test_validate_config_rejects_missing_required_field():
    with pytest.raises(WidgetConfigError):
        validate_config("stat", {})


def test_validate_config_rejects_empty_y_cols():
    with pytest.raises(WidgetConfigError):
        validate_config("line", {"x_col": "day", "y_cols": []})


@pytest.mark.parametrize("kind", ["line", "bar", "area"])
def test_validate_config_accepts_series_kinds(kind):
    config = validate_config(kind, {"x_col": "day", "y_cols": ["n"]})
    assert config["kind"] == kind


def test_validate_config_accepts_pie():
    config = validate_config("pie", {"label_col": "label", "value_col": "n"})
    assert config["kind"] == "pie"


def test_validate_config_accepts_table_with_defaults():
    config = validate_config("table", {})
    assert config["page_size"] == 20
    assert config["columns"] is None


def test_validate_config_accepts_list():
    config = validate_config("list", {"title_col": "title"})
    assert config["subtitle_col"] is None


def test_check_result_shape_stat_ok():
    check_result_shape("stat", {"value_col": "value", "delta_col": None}, ["value"], row_count=1)


def test_check_result_shape_stat_wrong_row_count():
    with pytest.raises(WidgetConfigError, match="exactly 1 row"):
        check_result_shape("stat", {"value_col": "value", "delta_col": None}, ["value"], row_count=2)


def test_check_result_shape_stat_missing_column():
    with pytest.raises(WidgetConfigError, match="missing column"):
        check_result_shape("stat", {"value_col": "value", "delta_col": None}, ["other"], row_count=1)


def test_check_result_shape_series_missing_y_col():
    with pytest.raises(WidgetConfigError, match="missing column"):
        check_result_shape("bar", {"x_col": "day", "y_cols": ["n", "missing"]}, ["day", "n"], row_count=3)


def test_check_result_shape_pie_ok():
    check_result_shape("pie", {"label_col": "label", "value_col": "n"}, ["label", "n"], row_count=5)


def test_check_result_shape_list_ok_with_optional_columns_absent():
    check_result_shape(
        "list", {"title_col": "title", "subtitle_col": None, "badge_col": None}, ["title"], row_count=3
    )


def test_check_result_shape_table_with_required_columns_missing():
    with pytest.raises(WidgetConfigError):
        check_result_shape("table", {"columns": ["name", "status"]}, ["name"], row_count=1)


def test_check_result_shape_table_with_no_column_restriction_always_ok():
    check_result_shape("table", {"columns": None}, ["anything"], row_count=100)
