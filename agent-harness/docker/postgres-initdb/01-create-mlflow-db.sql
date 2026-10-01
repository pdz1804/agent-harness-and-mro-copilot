-- Runs once, only on a first `docker compose up` against an empty
-- `agent_harness_pg_data` volume (see docker-compose.yml). Creates a
-- second database in the same Postgres instance for MLflow's own backend
-- store, kept separate from the `agent_harness` app database/schema so
-- neither phase-11a's Alembic migrations nor MLflow's own internal schema
-- ever collide.
CREATE DATABASE mlflow OWNER agent_harness;
