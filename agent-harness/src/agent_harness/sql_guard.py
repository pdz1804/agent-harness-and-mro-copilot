"""Read-only SQL validation for user- and agent-authored dashboard queries.

Dashboard widget SQL is hand-written by editors and, since agents can create
dashboards, by an LLM - so it is treated as untrusted input. Defense in depth,
three independent layers (the first two live here, the third in the database):

1. **Parse-based allowlist** (`_validate_parsed`, primary static layer): the
   query is parsed with `sqlglot` (Postgres dialect) and must be exactly ONE
   `SELECT` / `WITH ... SELECT` / set-operation statement. Every node is
   inspected: data-modifying or utility nodes (INSERT/UPDATE/DELETE/DDL/
   COPY/SET/`SELECT ... INTO`/`FOR UPDATE`) are rejected even when nested in
   a CTE; every table must be one of `ALLOWED_RELATIONS` (the curated
   `harness_ro` views) or a CTE defined in the query - schema-qualified
   names (`pg_catalog.*`, `information_schema.*`) and base tables such as
   `users` are rejected; every function must be a known SQL function or one
   of the explicitly allowlisted Postgres ones (`generate_series`,
   `jsonb_array_length`, ...), so `pg_read_file`, `pg_ls_dir`, `lo_*`,
   `dblink`, `set_config`, `current_setting`, `query_to_xml`, ... are all
   rejected by name. Anything the parser cannot understand fails closed.

2. **Keyword blocklist** (`validate_read_only_sql`, secondary layer, kept from
   the original implementation): case-insensitive whole-word match on write/
   DDL/DCL keywords plus a single-statement check. It has false positives
   (a keyword inside a string literal) but never lets the obvious cases
   through, and covers a parser blind spot should one ever be found.

3. **Database boundary** (`agent_harness.db.run_read_only_query`, the real
   guarantee): the query runs under `SET LOCAL ROLE harness_reader`, a
   NOLOGIN, non-superuser role whose only privilege is SELECT on owner-scoped
   views in the `harness_ro` schema (created by the `a6c2d8e4f1b7`
   migration), inside a READ ONLY, always-rolled-back transaction with a
   statement timeout and row cap. Even a query that slipped past layers 1
   and 2 cannot read server files, call privileged functions, touch base
   tables such as `users`, or see another user's rows.

This module gives friendly errors early and an allowlist; it does not claim
to be injection-proof on its own - layer 3 is the guarantee.
"""

from __future__ import annotations

import re

import sqlglot
from sqlglot import exp
from sqlglot.errors import SqlglotError

# The curated, owner-scoped views `harness_reader` may SELECT (schema
# `harness_ro`, created by migration `a6c2d8e4f1b7`). Single source of truth
# for the parse allowlist; `tests/test_sql_guard.py` asserts it matches the
# views actually present in the database.
ALLOWED_RELATIONS: frozenset[str] = frozenset(
    {
        "services",
        "incidents",
        "runs",
        "events",
        "sessions",
        "eval_runs",
        "eval_results",
        "token_usage",
    }
)

# Postgres functions sqlglot does not model as typed expressions that are
# nevertheless safe, pure and useful for dashboards. Any other untyped
# ("anonymous") call is rejected by name.
_ALLOWED_ANONYMOUS_FUNCTIONS: frozenset[str] = frozenset(
    {
        "generate_series",
        "jsonb_array_length",
        "json_array_length",
        "jsonb_extract_path_text",
        "json_extract_path_text",
        "jsonb_typeof",
        "split_part",
        "regexp_replace",
        "regexp_match",
        "to_date",
        "date_part",
        "age",
        "now",
        "clock_timestamp",
        "statement_timestamp",
        "make_interval",
        "array_length",
        "cardinality",
        "unnest",
        "initcap",
        "btrim",
        "ltrim",
        "rtrim",
        "lpad",
        "rpad",
        "repeat",
        "reverse",
        "md5",
        "sign",
        "trunc",
        "power",
        "sqrt",
        "mod",
        "div",
        "width_bucket",
        "bool_and",
        "bool_or",
        "every",
        "stddev",
        "stddev_pop",
        "stddev_samp",
        "variance",
        "var_pop",
        "var_samp",
        "mode",
        "percentile_disc",
        "percentile_cont",
        "row_number",
        "rank",
        "dense_rank",
        "ntile",
        "lag",
        "lead",
        "first_value",
        "last_value",
        "nth_value",
        "cume_dist",
        "percent_rank",
        "string_agg",
        "array_agg",
        "jsonb_agg",
        "json_agg",
        "jsonb_build_object",
        "json_build_object",
        "to_number",
        "to_char",
        "to_timestamp",
        "date_trunc",
    }
)

# Typed sqlglot functions that must never be accepted even though they are
# "known" (engine-specific file readers sqlglot models generically).
_BLOCKED_TYPED_FUNCTIONS: frozenset[str] = frozenset({"READ_CSV", "READ_PARQUET"})

# Node types that mean "not a plain read": mutation, DDL, utility commands,
# row locking, SELECT ... INTO.
_FORBIDDEN_NODE_NAMES = (
    "Insert",
    "Update",
    "Delete",
    "Merge",
    "Create",
    "Drop",
    "Alter",
    "AlterColumn",
    "Command",
    "Into",
    "Lock",
    "Set",
    "Copy",
    "Transaction",
    "Commit",
    "Rollback",
    "Grant",
    "Revoke",
    "TruncateTable",
    "Analyze",
    "Describe",
    "Use",
    "Pragma",
    "Declare",
    "Refresh",
    "Comment",
    "Execute",
    "Kill",
    "LoadData",
    "Attach",
    "Detach",
    "Show",
    "Cache",
    "Uncache",
    "Summarize",
)
_FORBIDDEN_NODES: tuple[type[exp.Expression], ...] = tuple(
    getattr(exp, name) for name in _FORBIDDEN_NODE_NAMES if hasattr(exp, name)
)

# Table-valued expressions that may appear in FROM (their contents are still
# walked: function calls inside are checked like any other).
_ALLOWED_TABLE_SOURCE_NAMES = ("Unnest", "Values", "Subquery", "GenerateSeries", "ExplodingGenerateSeries", "Anonymous")
_ALLOWED_TABLE_SOURCES: tuple[type[exp.Expression], ...] = tuple(
    getattr(exp, name) for name in _ALLOWED_TABLE_SOURCE_NAMES if hasattr(exp, name)
)

_ROOT_NODES: tuple[type[exp.Expression], ...] = tuple(
    getattr(exp, name) for name in ("Select", "SetOperation", "Union", "Subquery") if hasattr(exp, name)
)

_BANNED_KEYWORDS = (
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "ALTER",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "CREATE",
    "MERGE",
    "CALL",
    "EXECUTE",
    "REPLACE",
    "COPY",
    "VACUUM",
    "LOCK",
)

_KEYWORD_PATTERN = re.compile(r"\b(" + "|".join(_BANNED_KEYWORDS) + r")\b", re.IGNORECASE)


class ReadOnlySqlViolation(ValueError):
    """Raised by `validate_read_only_sql` when a query fails the read-only
    checks - a write/DDL keyword, more than one statement, a non-SELECT
    statement, a table outside `ALLOWED_RELATIONS`, or a function that is
    not allowlisted."""


def validate_read_only_sql(sql_query: str) -> None:
    """Raise `ReadOnlySqlViolation` with a clear, specific message unless
    `sql_query` is a single read-only SELECT over the allowlisted views
    using only allowlisted functions. Returns `None` (does not modify or
    normalize the query) if every static check passes - see this module's
    docstring for what is and is not guaranteed at this layer."""
    stripped = sql_query.strip()
    if not stripped:
        raise ReadOnlySqlViolation("sql_query must not be blank")

    match = _KEYWORD_PATTERN.search(stripped)
    if match:
        raise ReadOnlySqlViolation(
            f"query contains a disallowed write/DDL keyword: {match.group(1).upper()} "
            "- only read-only SELECT queries are allowed"
        )

    # Reject multiple statements: a semicolon anywhere except optionally
    # one trailing semicolon at the very end of the trimmed query.
    body = stripped[:-1] if stripped.endswith(";") else stripped
    if ";" in body:
        raise ReadOnlySqlViolation(
            "only a single SQL statement is allowed (remove any semicolon "
            "other than one optional trailing semicolon)"
        )

    _validate_parsed(stripped)


def _validate_parsed(sql_query: str) -> None:
    """Parse-based allowlist (see module docstring, layer 1)."""
    try:
        statements = [s for s in sqlglot.parse(sql_query, read="postgres") if s is not None]
    except SqlglotError as exc:
        raise ReadOnlySqlViolation(f"query could not be parsed as a single SELECT statement: {exc}") from exc
    if len(statements) != 1:
        raise ReadOnlySqlViolation("only a single SQL statement is allowed")
    tree = statements[0]
    if not isinstance(tree, _ROOT_NODES):
        raise ReadOnlySqlViolation("only SELECT queries are allowed")

    cte_names = {cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE) if cte.alias_or_name}

    for node in tree.walk():
        if isinstance(node, _FORBIDDEN_NODES):
            raise ReadOnlySqlViolation(
                f"query contains a disallowed construct ({type(node).__name__.upper()}) "
                "- only read-only SELECT queries are allowed"
            )
        if isinstance(node, exp.Table):
            _check_table(node, cte_names)
        elif isinstance(node, exp.Anonymous):
            name = str(node.this).lower()
            if name not in _ALLOWED_ANONYMOUS_FUNCTIONS:
                raise ReadOnlySqlViolation(f"function '{name}' is not allowed in dashboard queries")
        elif isinstance(node, exp.Func):
            if node.sql_name().upper() in _BLOCKED_TYPED_FUNCTIONS:
                raise ReadOnlySqlViolation(f"function '{node.sql_name().lower()}' is not allowed")


def _check_table(table: exp.Table, cte_names: set[str]) -> None:
    source = table.this
    if not isinstance(source, exp.Identifier):
        # `FROM generate_series(...)`, `FROM unnest(...)`, `FROM (VALUES ...)`:
        # the function itself is checked when the walk reaches it.
        if isinstance(source, _ALLOWED_TABLE_SOURCES):
            return
        raise ReadOnlySqlViolation("this FROM source is not allowed in dashboard queries")
    name = table.name.lower()
    if table.db or table.catalog:
        raise ReadOnlySqlViolation(
            f"schema-qualified table '{table.db}.{name}' is not allowed - query the curated views "
            f"directly: {', '.join(sorted(ALLOWED_RELATIONS))}"
        )
    if name in cte_names:
        return
    if name not in ALLOWED_RELATIONS:
        raise ReadOnlySqlViolation(
            f"table '{name}' is not available - queryable views: {', '.join(sorted(ALLOWED_RELATIONS))}"
        )
