import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config, pool

from alembic import context

# Make `agent_harness.settings` importable regardless of the working
# directory `alembic` is invoked from (mirrors the `src/` layout in
# pyproject.toml's `[tool.setuptools.packages.find]`).
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from agent_harness import settings  # noqa: E402

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Only fall back to `settings.DATABASE_URL` if the caller hasn't already
# set `sqlalchemy.url` on this Config (e.g. `tests/conftest.py` sets it
# explicitly, in-process, to point at a per-session test Postgres — that
# must win over the app's real `DATABASE_URL`). `alembic.ini`'s own value
# is a placeholder, never a real DSN.
_configured_url = config.get_main_option("sqlalchemy.url")
if not _configured_url or _configured_url == "driver://user:pass@localhost/dbname":
    _db_url = settings.DATABASE_URL
    # `DATABASE_URL` (e.g. `postgresql://user:pass@host:5433/db`) uses the
    # psycopg2-style scheme; SQLAlchemy needs the psycopg3 driver spelled
    # out explicitly to use the `psycopg` package this project installs.
    if _db_url.startswith("postgresql://"):
        _db_url = _db_url.replace("postgresql://", "postgresql+psycopg://", 1)
    config.set_main_option("sqlalchemy.url", _db_url)

# No ORM models — migrations are plain SQL via `op.execute(...)`, so there
# is no metadata to autogenerate against.
target_metadata = None

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection, target_metadata=target_metadata
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
