"""Unit tests for `agent_harness.sql_guard.validate_read_only_sql` (12e):
the text-based first layer of the Artifacts read-only enforcement. See
`agent_harness.db.run_read_only_query` (exercised by
`tests/test_api_artifacts.py`) for the second layer (a Postgres `READ
ONLY` transaction that is always rolled back)."""

from __future__ import annotations

import pytest

from agent_harness.sql_guard import ReadOnlySqlViolation, validate_read_only_sql


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT status, count(*) FROM runs GROUP BY status",
        "select * from services",
        "  SELECT 1  ",
        "SELECT 1;",
    ],
)
def test_accepts_real_read_only_queries(sql: str) -> None:
    validate_read_only_sql(sql)  # must not raise


@pytest.mark.parametrize(
    "sql,expected_keyword",
    [
        ("DELETE FROM runs", "DELETE"),
        ("delete from runs", "DELETE"),
        ("INSERT INTO services (name) VALUES ('x')", "INSERT"),
        ("UPDATE services SET status = 'down'", "UPDATE"),
        ("DROP TABLE runs", "DROP"),
        ("ALTER TABLE runs ADD COLUMN x TEXT", "ALTER"),
        ("TRUNCATE TABLE runs", "TRUNCATE"),
        ("GRANT ALL ON runs TO PUBLIC", "GRANT"),
        ("CREATE TABLE evil (id TEXT)", "CREATE"),
        ("CALL some_procedure()", "CALL"),
    ],
)
def test_rejects_write_and_ddl_keywords(sql: str, expected_keyword: str) -> None:
    with pytest.raises(ReadOnlySqlViolation) as exc_info:
        validate_read_only_sql(sql)
    assert expected_keyword in str(exc_info.value)


def test_rejects_multiple_statements() -> None:
    with pytest.raises(ReadOnlySqlViolation):
        validate_read_only_sql("SELECT 1; SELECT 2")


def test_rejects_stacked_query_smuggling_a_write_after_a_select() -> None:
    """The classic SQL-injection shape this app must reject: a legitimate
    leading SELECT followed by a semicolon-separated destructive
    statement."""
    with pytest.raises(ReadOnlySqlViolation):
        validate_read_only_sql("SELECT 1; DELETE FROM runs")


def test_rejects_blank_query() -> None:
    with pytest.raises(ReadOnlySqlViolation):
        validate_read_only_sql("   ")


def test_does_not_falsely_reject_column_names_containing_keyword_substrings() -> None:
    """Word-boundary matching: a column/table name that merely contains a
    banned keyword as a substring (not as a standalone SQL keyword) must
    not be rejected."""
    validate_read_only_sql("SELECT created_at FROM incidents")  # 'create' is not a standalone word here


# --- parse-based allowlist (primary static layer) ----------------------------


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT pg_read_file('/etc/passwd')",
        "SELECT substr(pg_read_file('postgresql.conf'), 1, 40)",
        "SELECT pg_ls_dir('.')",
        "SELECT * FROM pg_ls_dir('.')",
        "SELECT lo_import('/etc/passwd')",
        "SELECT set_config('role', 'x', true)",
        "SELECT current_setting('app.user_id')",
        "SELECT query_to_xml('select 1', true, true, '')",
        "SELECT * FROM dblink('x', 'select 1') AS t(a int)",
        "SELECT * FROM users",
        "SELECT * FROM pg_catalog.pg_roles",
        "SELECT * FROM information_schema.tables",
        "SELECT * FROM public.runs",
        "SELECT (SELECT count(*) FROM users)",
        "SELECT * FROM services s, users u",
        "SELECT * INTO leaked FROM services",
        "SET ROLE postgres",
        "EXPLAIN SELECT 1",
        "WITH d AS (DELETE FROM services RETURNING *) SELECT * FROM d",
    ],
)
def test_parse_allowlist_rejects_privileged_functions_tables_and_statements(sql: str) -> None:
    with pytest.raises(ReadOnlySqlViolation):
        validate_read_only_sql(sql)


@pytest.mark.parametrize(
    "sql",
    [
        "WITH a AS (SELECT 1 AS x) SELECT * FROM a",
        "SELECT g FROM generate_series(1, 3) g",
        "SELECT count(*) FILTER (WHERE severity = 'high') AS high, substring(created_at, 1, 10) AS day "
        "FROM incidents GROUP BY day",
        "SELECT a.name FROM services a JOIN incidents b ON true",
        "SELECT * FROM (SELECT 1 AS x) q",
        "SELECT 1 UNION SELECT 2",
        "SELECT data::jsonb ->> 'tool_name' AS tool FROM events",
        "SELECT to_char(to_timestamp(started_at), 'YYYY-MM-DD') AS d FROM runs",
    ],
)
def test_parse_allowlist_accepts_legitimate_dashboard_queries(sql: str) -> None:
    validate_read_only_sql(sql)


def test_every_dashboard_template_query_passes_the_guard() -> None:
    from agent_harness.dashboard_templates import TEMPLATES

    for template in TEMPLATES.values():
        for widget in template.widgets:
            validate_read_only_sql(widget.sql_query)


def test_a_cte_may_shadow_a_name_but_cannot_reach_a_base_table_through_it() -> None:
    validate_read_only_sql("WITH users AS (SELECT 1 AS x) SELECT * FROM users")
    with pytest.raises(ReadOnlySqlViolation):
        validate_read_only_sql("WITH runs AS (SELECT * FROM users) SELECT * FROM runs")


def test_unparseable_input_fails_closed() -> None:
    with pytest.raises(ReadOnlySqlViolation):
        validate_read_only_sql("SELECT FROM WHERE ((")
