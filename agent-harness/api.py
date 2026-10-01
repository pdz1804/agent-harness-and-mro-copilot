"""FastAPI app for the Agent Harness: wires the routers together, runs the
startup hooks and serves the built web console.

Run with:  uvicorn api:app --reload   (or, after `npm run build` in web/,
just `uvicorn api:app` — the built frontend is served as static files from
the same process; see README.md "Run the app").

Every API route lives under `/api/v1` (OpenAPI docs: `/api/v1/docs`, schema:
`/api/v1/openapi.json`); `/health` is also served unprefixed for probes and
scripts. Any other non-API GET is the web console: a real file from the built
frontend if one exists, else `index.html` (SPA history fallback), so clean UI
paths such as `/sessions/<id>` survive a refresh or a deep link.

The endpoints live in `agent_harness.routers.*`, one module per area:

- `health`        /health, /me, /users
- `runs`          /run (sync), /runs (async pause/resume flow), SSE, export, tokens,
                  run memories, run feedback, /approvals/pending, /usage/today
- `sessions`      /sessions (search/filter, rename, archive, delete)
- `services`      /services
- `incidents`     /incidents (lifecycle: open -> acknowledged -> resolved)
- `memories`      /memories (long-term agent memory)
- `integrations`  /integrations (tool detail, stats, per-tool timeout/retry)
- `guardrails`    /guardrails (+ test sandbox, trigger history)
- `automations`   /automations
- `kb`, `prompts`, `agents` (+ skill routing tester), `skills`, `dashboards`,
  `evals` (+ judge-vs-human agreement), `mlflow_evals` (/evals)

Process-wide state (the in-memory `RunRegistry`, the LLM client factory) is in
`agent_harness.state`. See `docs/design-report.md` section 6 for the run flow.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles as _CachedStaticFilesBase
from starlette.exceptions import HTTPException

from agent_harness import db, dense_embeddings, settings
from agent_harness.deps import current_user  # noqa: F401 - re-exported: tests call `api.current_user`
from agent_harness.repos import evals as evals_repo
from agent_harness.routers import (
    agents,
    automations,
    dashboards,
    evals,
    guardrails,
    health,
    incidents,
    integrations,
    kb,
    memories,
    mlflow_evals,
    prompts,
    runs,
    services,
    sessions,
    skills,
)

API_PREFIX = "/api/v1"


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Warm the local embedding model on a background thread at startup
    # instead of lazily on the first `search_knowledge_base` call — the
    # first `SentenceTransformer(...)` load takes ~30s (model
    # download/decompress + weight load), which otherwise blows past the
    # tool's 10s timeout on the very first KB search of a fresh process. Not
    # awaited: startup returns immediately, `GET /health` reports
    # "loading" until it finishes, and `retrieval.HybridIndex._dense_ranked`
    # gives an in-flight warmup a short grace period before degrading a single
    # call to BM25-only. Skipped entirely in "bm25" mode, where the embedding
    # model is never used.
    if settings.RETRIEVAL_MODE != "bm25":
        dense_embeddings.start_warmup()
    # Any eval_runs row left `running` by a previous process (e.g. the server
    # was restarted mid-scoring-job, so its background thread never got to flip
    # it terminal) is marked `failed` on every fresh startup.
    evals_repo.mark_stale_running_as_failed()
    # Same for chat runs: this process has no live worker yet, so any run row
    # still `running`/`pending_approval` was orphaned by a previous process.
    db.mark_orphaned_runs()
    yield


app = FastAPI(
    title="Agent Harness API",
    description="LLM<->tool execution harness for an ops assistant.",
    version="0.4.0",
    lifespan=_lifespan,
    docs_url="/api/v1/docs",
    redoc_url="/api/v1/redoc",
    openapi_url="/api/v1/openapi.json",
    swagger_ui_oauth2_redirect_url="/api/v1/docs/oauth2-redirect",
)

# Verify the Alembic-managed schema and seed default rows on first boot.
# Idempotent — safe on every restart, including test collection (see
# tests/conftest.py, which points settings.DATABASE_URL at an isolated database).
db.ensure_ready()

# Permissive localhost CORS so `npm run dev` (Vite's dev server on its own
# port, e.g. 5173) can call this API during frontend-only iteration. The
# documented/graded run mode does not need this at all (see README.md):
# the built frontend is served by this same FastAPI process, same origin,
# so no browser CORS preflight ever happens on that path.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

api_v1 = APIRouter(prefix=API_PREFIX)
for _router in (
    health.router,
    runs.router,
    sessions.router,
    services.router,
    incidents.router,
    memories.router,
    kb.router,
    integrations.router,
    guardrails.router,
    automations.router,
    prompts.router,
    # `agents.router` owns the static "/skills/commands" and "/skills/route-test"
    # paths; it is included before `skills.router`, whose "/skills/{skill_id}" is
    # otherwise a dynamic route that would match "commands" as a skill_id first
    # (FastAPI matches routes in registration order).
    agents.router,
    skills.router,
    dashboards.router,
    evals.router,
    mlflow_evals.router,
):
    api_v1.include_router(_router)
app.include_router(api_v1)

# Liveness probe at the unprefixed path too (scripts/docker healthchecks use it).
app.add_api_route("/health", health.health, methods=["GET"], response_model=health.HealthResponse, tags=["health"])


class _CachedStaticFiles(_CachedStaticFilesBase):
    """Static file serving with cache headers suited to a Vite build, plus the
    SPA history fallback.

    Hashed `assets/*` filenames (e.g. `index-Ab12Cd.js`) are safe to cache
    forever — a content change always produces a new filename — while
    `index.html` (and any other non-hashed top-level file) must always be
    revalidated so a deployed rebuild is picked up on next load instead of
    being served stale from a browser cache.

    A path that matches no file is a client-side route (`/sessions/<id>`,
    `/dashboards/<id>`, `/evals`, ...) and gets `index.html`, except: anything
    under `api/` (an unknown API route stays a real 404) and anything whose
    last segment has a file extension (a missing asset must 404, not return
    HTML that the browser then fails to parse as JS/CSS)."""

    async def get_response(self, path: str, scope: Any) -> Any:  # noqa: ANN401 - starlette's own signature
        # Starlette hands over an OS-normalised path (backslashes on Windows).
        path = path.replace("\\", "/")
        try:
            response = await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code != 404 or not self._is_spa_route(path):
                raise
            path = "index.html"
            response = await super().get_response(path, scope)
        if path.startswith("assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response

    @staticmethod
    def _is_spa_route(path: str) -> bool:
        stripped = path.strip("/")
        if stripped == "api" or stripped.startswith("api/"):
            return False
        return "." not in stripped.rsplit("/", 1)[-1]


# Serve the built web console as static files from this same process, so
# the graded/documented run mode is a single process with no CORS involved
# (see README.md "Run the app"). Mounted at "/" and registered LAST so it
# only ever catches requests that don't match one of the API routes above.
# Guarded on the directory existing so `uvicorn api:app` (and importing
# `api` from the test suite, which never builds the frontend) still works
# before `npm run build` has been run in web/.
# `AGENT_HARNESS_WEB_DIST` points the server at another build directory (e.g.
# a side-by-side build for verification) without touching `web/dist`.
_WEB_DIST = Path(os.environ.get("AGENT_HARNESS_WEB_DIST") or Path(__file__).resolve().parent / "web" / "dist")
if _WEB_DIST.is_dir():
    app.mount("/", _CachedStaticFiles(directory=str(_WEB_DIST), html=True), name="web")
