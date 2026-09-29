"""FastAPI wrapper around AgentLoop: a synchronous convenience endpoint plus
a real async pause/resume run flow backed by `RunRegistry`.

Run with:  uvicorn api:app --reload   (or, after `npm run build` in web/,
just `uvicorn api:app` — the built frontend is served as static files from
the same process; see README.md "Run the app").

Two run flows are exposed:

1. `POST /run` (kept for the Postman collection / non-UI callers): fully
   synchronous, request/response. Approval for `create_incident` is
   pre-authorized via the `auto_approve` boolean in the request body,
   decided *before* the run starts. This is NOT a real pause/resume flow —
   it is a request-level pre-authorization, documented as such.

2. `POST /runs` + `GET /runs/{run_id}` + `POST /runs/{run_id}/approve`
   (used by the web UI): the real pause/resume flow. `POST /runs` starts
   `AgentLoop.run(...)` on a background thread and returns immediately.
   When the loop reaches an approval-gated tool, `RunRegistry`'s callback
   records the pending tool call, flips the run's status to
   `pending_approval`, and blocks that background thread on a
   `threading.Event` (bounded by the run's own `max_wall_clock_seconds`, so
   a forgotten approval cannot hang forever). `GET /runs/{run_id}` returns
   a live snapshot (status + history-so-far, streamed from the same
   `TraceLogger`/`RunResult.history` shape the CLI already uses).
   `POST /runs/{run_id}/approve` resolves the pending approval and
   unblocks the thread. `GET /runs` lists recent runs for a history view.

See `docs/design-report.md` section 6 for the design this replaced and why.
"""

from __future__ import annotations

import asyncio
import json
import queue
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles as _CachedStaticFilesBase
from pydantic import BaseModel, Field

from contextlib import asynccontextmanager

from agent_harness import db, dense_embeddings, retrieval, settings
from agent_harness.approval import fixed_decision_approval
from agent_harness.config import HarnessConfig
from agent_harness.llm_client import LLMClient, OpenAIChatLLMClient
from agent_harness.loop import AgentLoop
from agent_harness.run_registry import AsyncRunStatus, RunRegistry, persisted_snapshot, persisted_summary
from agent_harness.schemas import AgentEvent, RunResult


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Warm the local embedding model on a background thread at startup
    # instead of lazily on the first `search_knowledge_base` call — the
    # first `SentenceTransformer(...)` load takes ~30s (model
    # download/decompress + weight load), which otherwise blows past the
    # tool's 10s timeout on the very first KB search of a fresh process. Not
    # awaited: startup returns immediately, `GET /health` reports
    # "loading" until it finishes (see `health()` below), and
    # `retrieval.KnowledgeBaseIndex._dense_ranked` gives an in-flight
    # warmup a short grace period before degrading a single call to
    # BM25-only. Skipped entirely in "bm25" mode, where the embedding model
    # is never used.
    if settings.RETRIEVAL_MODE != "bm25":
        dense_embeddings.start_warmup()
    yield


app = FastAPI(
    title="Agent Harness API",
    description="LLM<->tool execution harness for an ops assistant.",
    version="0.3.0",
    lifespan=_lifespan,
)

# Create tables + seed mock services on first boot. Idempotent — safe on
# every restart, including test collection (see tests/conftest.py, which
# points settings.DB_PATH at an isolated tmp path before each test).
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

_registry = RunRegistry(default_runs_dir="runs")


def _default_llm_client() -> LLMClient:
    """Real demo path: requires OPENAI_API_KEY, no silent fallback to the
    heuristic mock (see phase-06 spec). Tests monkeypatch
    `api._llm_client_factory` to inject `HeuristicMockLLMClient` instead,
    keeping the pytest suite fully deterministic and network-free."""
    if not settings.OPENAI_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="LLM not configured: set OPENAI_API_KEY in agent-harness/.env "
            "(copy .env.example) and restart the server.",
        )
    return OpenAIChatLLMClient()


_llm_client_factory: Callable[[], LLMClient] = _default_llm_client


class RunRequest(BaseModel):
    objective: str = Field(min_length=1, description="The task for the agent to pursue.")
    auto_approve: bool = Field(
        default=False,
        description="If true, create_incident (and any other approval-gated tool) is "
        "pre-authorized for this run. If false, any approval-gated tool call is denied. "
        "This is request-level pre-authorization, not a pause/resume flow — see /runs "
        "for the real approval flow used by the web UI.",
    )
    max_steps: Optional[int] = Field(default=None, gt=0)
    max_wall_clock_seconds: Optional[float] = Field(default=None, gt=0)


class StartRunRequest(BaseModel):
    objective: str = Field(min_length=1, description="The task for the agent to pursue.")
    max_steps: Optional[int] = Field(default=None, gt=0)
    max_wall_clock_seconds: Optional[float] = Field(default=None, gt=0)


class StartRunResponse(BaseModel):
    run_id: str
    status: AsyncRunStatus


class PendingApprovalView(BaseModel):
    tool_name: str
    tool_args: dict[str, Any]


class RunSnapshot(BaseModel):
    run_id: str
    objective: str
    status: AsyncRunStatus
    started_at: float
    steps_taken: int
    final_answer: Optional[str] = None
    pending_approval: Optional[PendingApprovalView] = None
    history: list[AgentEvent]
    trace_path: Optional[str] = None
    error: Optional[str] = None


class RunSummary(BaseModel):
    run_id: str
    objective: str
    status: AsyncRunStatus
    started_at: float


class ApproveRequest(BaseModel):
    approved: bool = Field(description="True to approve the pending tool call, false to deny it.")


class ServiceView(BaseModel):
    name: str
    status: Literal["operational", "degraded", "down"]
    latency_ms: Optional[float] = None
    error_rate: Optional[float] = None
    last_deploy: Optional[str] = None
    owner: Optional[str] = None
    last_checked: Optional[str] = None


class SetServiceStatusRequest(BaseModel):
    status: Literal["operational", "degraded", "down"]


class IncidentView(BaseModel):
    id: str
    title: str
    description: str
    severity: Literal["low", "medium", "high", "critical"]
    status: str
    created_at: str
    run_id: Optional[str] = None


class KBDocView(BaseModel):
    id: str
    title: str


class KBSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=3, gt=0, le=10)


class KBSearchResult(BaseModel):
    id: str
    title: str
    snippet: str
    score: float


class HealthResponse(BaseModel):
    status: str
    llm_configured: bool
    llm_model: Optional[str] = None
    llm_last_error: Optional[str] = Field(
        default=None,
        description="Real provider error message from the most recent failed LLM call "
        "(e.g. 'OpenAI: insufficient_quota — add credits'), or null if configured and "
        "the last call (if any) succeeded. Distinct from llm_configured=false ('no API "
        "key set at all').",
    )
    embedding_model_status: Literal["disabled", "loading", "ready", "unavailable"] = Field(
        description="Warmup state of the local dense-embedding model used by hybrid KB "
        "retrieval. 'disabled' when AGENT_HARNESS_RETRIEVAL_MODE=bm25 (never loaded); "
        "'loading' while the background startup warmup is still in progress — a KB "
        "search landing now will wait briefly then degrade to BM25-only rather than "
        "time out; 'ready' once warm; 'unavailable' if loading failed (see "
        "embedding_model_error).",
    )
    embedding_model_error: Optional[str] = Field(
        default=None, description="Error from the embedding model load, if embedding_model_status is 'unavailable'."
    )


def _build_config(max_steps: Optional[int], max_wall_clock_seconds: Optional[float]) -> HarnessConfig:
    config_kwargs: dict[str, float | int] = {}
    if max_steps is not None:
        config_kwargs["max_steps"] = max_steps
    if max_wall_clock_seconds is not None:
        config_kwargs["max_wall_clock_seconds"] = max_wall_clock_seconds
    return HarnessConfig(**config_kwargs)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    embedding_status: Literal["disabled", "loading", "ready", "unavailable"] = (
        "disabled" if settings.RETRIEVAL_MODE == "bm25" else dense_embeddings.get_status()  # type: ignore[assignment]
    )
    # dense_embeddings.get_status() never returns "idle" once warmup has been
    # kicked off at startup (see _lifespan above); "idle" only shows up if
    # warmup somehow never started, which we treat the same as "loading" —
    # a request landing right now still gets the grace-period fallback.
    if embedding_status == "idle":  # type: ignore[comparison-overlap]
        embedding_status = "loading"
    return HealthResponse(
        status="ok",
        llm_configured=settings.llm_configured(),
        llm_model=settings.OPENAI_MODEL if settings.llm_configured() else None,
        llm_last_error=settings.last_llm_error(),
        embedding_model_status=embedding_status,
        embedding_model_error=dense_embeddings.last_load_error(),
    )


@app.post("/run", response_model=RunResult)
def run(request: RunRequest) -> RunResult:
    """Synchronous convenience endpoint. See module docstring: this
    pre-authorizes approval via `auto_approve` rather than pausing."""
    if not request.objective.strip():
        raise HTTPException(status_code=422, detail="objective must not be blank")

    config = _build_config(request.max_steps, request.max_wall_clock_seconds)
    loop = AgentLoop(
        llm_client=_llm_client_factory(),
        config=config,
        approval_callback=fixed_decision_approval(request.auto_approve),
    )
    return loop.run(request.objective)


@app.post("/runs", response_model=StartRunResponse, status_code=202)
def start_run(request: StartRunRequest) -> StartRunResponse:
    """Start a run in the background and return immediately. Poll
    `GET /runs/{run_id}` for progress and approve/deny via
    `POST /runs/{run_id}/approve` when status is `pending_approval`."""
    if not request.objective.strip():
        raise HTTPException(status_code=422, detail="objective must not be blank")

    config = _build_config(request.max_steps, request.max_wall_clock_seconds)
    record = _registry.start_run(
        objective=request.objective,
        llm_client=_llm_client_factory(),
        config=config,
    )
    return StartRunResponse(run_id=record.run_id, status=record.status)


@app.get("/runs", response_model=list[RunSummary])
def list_runs() -> list[RunSummary]:
    """Live (in-memory) runs from this process, merged with runs persisted
    to SQLite by a previous process — this is what makes `GET /runs`
    survive a restart. Live entries win on id collision (they're the
    up-to-date source of truth while the run is still in flight)."""
    live = [RunSummary(**_registry.summary(record)) for record in _registry.list_runs()]
    live_ids = {r.run_id for r in live}
    persisted = [
        RunSummary(**persisted_summary(row)) for row in db.list_runs() if row["run_id"] not in live_ids
    ]
    return sorted(live + persisted, key=lambda r: r.started_at, reverse=True)


@app.get("/runs/{run_id}", response_model=RunSnapshot)
def get_run(run_id: str) -> RunSnapshot:
    snapshot = _registry.snapshot(run_id)
    if snapshot is not None:
        return RunSnapshot(**snapshot)
    row = db.get_run(run_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"unknown run_id '{run_id}'")
    return RunSnapshot(**persisted_snapshot(row))


@app.post("/runs/{run_id}/approve", response_model=RunSnapshot)
def approve_run(run_id: str, request: ApproveRequest) -> RunSnapshot:
    try:
        _registry.resolve_approval(run_id, request.approved)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        # No pending approval right now (already resolved, timed out, or the
        # run never reached one) — a conflict, not a missing resource.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    snapshot = _registry.snapshot(run_id)
    assert snapshot is not None  # resolve_approval above already validated run_id exists
    return RunSnapshot(**snapshot)


def _sse_pack(event_type: str, payload: dict[str, Any]) -> str:
    return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"


@app.get("/runs/{run_id}/events")
async def stream_run_events(run_id: str, request: Request) -> StreamingResponse:
    """Server-Sent Events stream of every `AgentEvent` recorded for `run_id`
    from the moment of subscription onward (not a replay of history — the
    frontend does one `GET /runs/{id}` snapshot fetch first, then opens this
    stream; see RunPage). Reuses `TraceLogger`'s `on_event` observer hook via
    a per-connection queue registered on `RunRegistry`, so events are pushed
    the instant they're recorded rather than polled.

    Closes (ends the SSE stream, not an error) once the run reaches a
    terminal status, or the run is unknown / already persisted-only (a
    previous process's completed run) — in the latter case a single
    `run_snapshot` event carrying the full persisted history is sent instead
    of an empty hang, then the stream closes.
    """
    q = _registry.subscribe(run_id)
    if q is None:
        row = db.get_run(run_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"unknown run_id '{run_id}'")

        async def _persisted_only() -> AsyncIterator[str]:
            yield _sse_pack("run_snapshot", persisted_snapshot(row))
            yield _sse_pack("stream_end", {"run_id": run_id})

        return StreamingResponse(_persisted_only(), media_type="text/event-stream")

    async def _live_stream() -> AsyncIterator[str]:
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.get_event_loop().run_in_executor(
                        None, q.get, True, 15.0
                    )
                except queue.Empty:
                    yield ": keep-alive\n\n"
                    continue
                if event is None:
                    yield _sse_pack("stream_end", {"run_id": run_id})
                    break
                yield _sse_pack(event.event_type, event.model_dump())
        finally:
            _registry.unsubscribe(run_id, q)

    return StreamingResponse(_live_stream(), media_type="text/event-stream")


@app.get("/runs/{run_id}/export")
def export_run(run_id: str) -> dict[str, Any]:
    """Full trace export for a single run — every persisted event plus run
    metadata, as one JSON document. Used by the Logs page's download button
    (attach evidence to a submission) and is a legitimate observability
    feature in its own right: the audit log a real ops team would want.
    Prefers the SQLite-persisted copy (authoritative once a run finishes and
    survives restarts); falls back to the live in-memory snapshot for a run
    still in flight in this process."""
    row = db.get_run(run_id)
    if row is not None:
        return persisted_snapshot(row)
    snapshot = _registry.snapshot(run_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail=f"unknown run_id '{run_id}'")
    return snapshot


@app.get("/services", response_model=list[ServiceView])
def list_services() -> list[ServiceView]:
    return [ServiceView(**row) for row in db.list_services()]


@app.post("/services/{service_name}/status", response_model=ServiceView)
def set_service_status(service_name: str, request: SetServiceStatusRequest) -> ServiceView:
    """Flip a mock service's status so a reviewer can create real
    degraded/down scenarios for the agent to investigate."""
    row = db.set_service_status(
        service_name, request.status, datetime.now(timezone.utc).isoformat()
    )
    if row is None:
        raise HTTPException(status_code=404, detail=f"unknown service '{service_name}'")
    return ServiceView(**row)


@app.get("/incidents", response_model=list[IncidentView])
def list_incidents() -> list[IncidentView]:
    return [IncidentView(**row) for row in db.list_incidents()]


@app.get("/kb", response_model=list[KBDocView])
def list_kb_docs() -> list[KBDocView]:
    return [KBDocView(**doc) for doc in retrieval.get_index().list_docs()]


@app.post("/kb/search", response_model=list[KBSearchResult])
def search_kb(request: KBSearchRequest) -> list[KBSearchResult]:
    """Hits the same BM25 retrieval function the `search_knowledge_base`
    tool uses, exposed directly so the web UI's Knowledge base page can let
    a reviewer try queries without starting a full agent run."""
    results = retrieval.get_index().search(request.query, top_k=request.top_k)
    return [KBSearchResult(**r) for r in results]


class _CachedStaticFiles(_CachedStaticFilesBase):
    """Static file serving with cache headers suited to a Vite build:
    hashed `assets/*` filenames (e.g. `index-Ab12Cd.js`) are safe to cache
    forever — a content change always produces a new filename — while
    `index.html` (and any other non-hashed top-level file) must always be
    revalidated so a deployed rebuild is picked up on next load instead of
    being served stale from a browser cache."""

    async def get_response(self, path: str, scope: Any) -> Any:  # noqa: ANN401 - starlette's own signature
        response = await super().get_response(path, scope)
        if path.startswith("assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


# Serve the built web console as static files from this same process, so
# the graded/documented run mode is a single process with no CORS involved
# (see README.md "Run the app"). Mounted at "/" and registered LAST so it
# only ever catches requests that don't match one of the API routes above.
# Guarded on the directory existing so `uvicorn api:app` (and importing
# `api` from the test suite, which never builds the frontend) still works
# before `npm run build` has been run in web/.
_WEB_DIST = Path(__file__).resolve().parent / "web" / "dist"
if _WEB_DIST.is_dir():
    app.mount("/", _CachedStaticFiles(directory=str(_WEB_DIST), html=True), name="web")
