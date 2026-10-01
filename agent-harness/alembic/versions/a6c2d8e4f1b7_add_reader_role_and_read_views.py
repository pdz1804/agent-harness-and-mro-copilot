"""add least-privilege reader role and curated read-only views

Revision ID: a6c2d8e4f1b7
Revises: d9e3b6f1a4c7
Create Date: 2026-10-01 12:00:00.000000

Dashboard widget SQL (hand-written by editors, and now by the agent) used to
run as the application role, which is a Postgres SUPERUSER: a READ ONLY
transaction stops writes but not reads, so `pg_read_file`, `pg_ls_dir`, other
users' rows and the `users` table were all reachable. This migration builds
the database-level boundary the query path now relies on:

* `harness_reader` - NOLOGIN, NOSUPERUSER, no inheritance, no privileges on
  any base table. Widget queries run under `SET LOCAL ROLE harness_reader`.
* schema `harness_ro` - curated, column-limited, owner-scoped VIEWS over the
  operational tables (services, incidents, runs, events, sessions,
  eval_runs, eval_results, token_usage). `harness_reader` gets USAGE on the
  schema and SELECT on those views only. Every owner-scoped view filters on
  the transaction-local settings `app.user_id` / `app.is_admin`, which the
  query runner sets (as the app role) before dropping privileges; views are
  `security_barrier` so a user-supplied predicate can never be evaluated
  ahead of the scope filter.
* `set_config` is revoked from PUBLIC: it is the only function that could
  change `role` / `app.*` from inside a SELECT, so the reader cannot lift
  its own scope or switch back to the application role. The application
  role is granted it explicitly (it already bypasses ACLs as a superuser).

Role creation is cluster-wide while grants/views are per-database, hence the
idempotent `IF NOT EXISTS` role creation and plain per-database DDL.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'a6c2d8e4f1b7'
down_revision: Union[str, Sequence[str], None] = 'd9e3b6f1a4c7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCOPE = (
    "(COALESCE(current_setting('app.is_admin', true), 'off') = 'on' "
    "OR {col} = current_setting('app.user_id', true))"
)


def _scope(col: str) -> str:
    return _SCOPE.format(col=col)


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_reader') THEN
                CREATE ROLE harness_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
                    NOINHERIT NOREPLICATION NOBYPASSRLS;
            END IF;
        END
        $$
        """
    )
    # Lets a non-superuser app role `SET ROLE harness_reader` too (a superuser
    # needs no membership; for it this is a harmless no-op).
    op.execute(
        """
        DO $$
        BEGIN
            EXECUTE format('GRANT harness_reader TO %I', current_user);
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END
        $$
        """
    )

    op.execute("CREATE SCHEMA IF NOT EXISTS harness_ro")

    op.execute(
        """
        CREATE OR REPLACE VIEW harness_ro.services WITH (security_barrier = true) AS
        SELECT name, status, latency_ms, error_rate, last_deploy, owner, last_checked
        FROM public.services
        """
    )
    op.execute(
        f"""
        CREATE OR REPLACE VIEW harness_ro.runs WITH (security_barrier = true) AS
        SELECT run_id, objective, status, started_at, finished_at, final_answer, steps_taken,
               session_id, prompt_version_id, agent_id, owner_id
        FROM public.runs
        WHERE {_scope('owner_id')}
        """
    )
    op.execute(
        f"""
        CREATE OR REPLACE VIEW harness_ro.events WITH (security_barrier = true) AS
        SELECT e.id, e.run_id, e.step, e.event_type, e."timestamp", e.latency_ms, e.data
        FROM public.events e
        WHERE EXISTS (
            SELECT 1 FROM public.runs r WHERE r.run_id = e.run_id AND {_scope('r.owner_id')}
        )
        """
    )
    op.execute(
        """
        CREATE OR REPLACE VIEW harness_ro.incidents WITH (security_barrier = true) AS
        SELECT i.id, i.title, i.description, i.severity, i.status, i.created_at, i.run_id
        FROM public.incidents i
        WHERE COALESCE(current_setting('app.is_admin', true), 'off') = 'on'
           OR EXISTS (
               SELECT 1 FROM public.runs r
               WHERE r.run_id = i.run_id AND r.owner_id = current_setting('app.user_id', true)
           )
        """
    )
    op.execute(
        f"""
        CREATE OR REPLACE VIEW harness_ro.sessions WITH (security_barrier = true) AS
        SELECT id, title, created_at, last_active_at, status, agent_id, owner_id
        FROM public.chat_sessions
        WHERE {_scope('owner_id')}
        """
    )
    op.execute(
        f"""
        CREATE OR REPLACE VIEW harness_ro.eval_runs WITH (security_barrier = true) AS
        SELECT id, triggered_by, scope, judge_version, judge_model, status, total, done,
               started_at, finished_at, created_at
        FROM public.eval_runs
        WHERE {_scope('triggered_by')}
        """
    )
    op.execute(
        f"""
        CREATE OR REPLACE VIEW harness_ro.eval_results WITH (security_barrier = true) AS
        SELECT er.id, er.eval_run_id, er.run_id, er.session_id, er.agent_id, er.metric,
               er.score, er.passed, er.rationale, er.judge_version, er.created_at
        FROM public.eval_results er
        WHERE EXISTS (
            SELECT 1 FROM public.runs r WHERE r.run_id = er.run_id AND {_scope('r.owner_id')}
        )
        """
    )
    op.execute(
        f"""
        CREATE OR REPLACE VIEW harness_ro.token_usage WITH (security_barrier = true) AS
        SELECT e.run_id, e."timestamp",
               NULLIF(e.data::jsonb -> 'llm_meta' ->> 'prompt_tokens', '')::bigint AS prompt_tokens,
               NULLIF(e.data::jsonb -> 'llm_meta' ->> 'completion_tokens', '')::bigint AS completion_tokens,
               NULLIF(e.data::jsonb -> 'llm_meta' ->> 'total_tokens', '')::bigint AS total_tokens
        FROM public.events e
        WHERE e.event_type = 'llm_decision'
          AND EXISTS (
              SELECT 1 FROM public.runs r WHERE r.run_id = e.run_id AND {_scope('r.owner_id')}
          )
        """
    )

    op.execute("REVOKE ALL ON SCHEMA harness_ro FROM PUBLIC")
    op.execute("GRANT USAGE ON SCHEMA harness_ro TO harness_reader")
    op.execute("GRANT SELECT ON ALL TABLES IN SCHEMA harness_ro TO harness_reader")

    # The reader must not be able to change its own scope or role from inside
    # a SELECT (`set_config('role', ...)`, `set_config('app.user_id', ...)`).
    op.execute("REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC")
    op.execute(
        """
        DO $$
        BEGIN
            EXECUTE format(
                'GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO %I',
                current_user
            );
        END
        $$
        """
    )


def downgrade() -> None:
    op.execute("GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO PUBLIC")
    op.execute("DROP SCHEMA IF EXISTS harness_ro CASCADE")
    # The role itself is cluster-wide and may still hold grants in other
    # databases of the same cluster; drop it only when nothing depends on it.
    op.execute(
        """
        DO $$
        BEGIN
            DROP ROLE IF EXISTS harness_reader;
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END
        $$
        """
    )
