"""Ops domain layer: persistent alerts/work-orders/reliability store.

SQLite via SQLAlchemy Core (Decision D1 in
``plans/260930-1401-mro-v3-senior-copilot/reports/research-and-gap-analysis.md``):
zero infra, single-writer demo workload, WAL mode, ``DATABASE_URL`` env
override keeps a future Postgres migration path open (no dialect-specific
SQL used anywhere in this package). No Alembic -- YAGNI for a demo schema;
``metadata.create_all`` runs idempotently at service startup.
"""
