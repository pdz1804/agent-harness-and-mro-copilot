# Agent Harness

An LLM <-> tool execution harness for an ops assistant, grown into a small
internal platform: real RBAC, a prompt library, named agents with skill
routing, live dashboards, a chat inspector, and an LLM-as-judge eval agent,
all on top of the core decide -> validate -> (approve) -> execute -> record
loop (schema validation, retries/timeouts, a human-approval gate on
`create_incident`, step/wall-clock limits, a structured trace per run).
It is exposed through a CLI, a FastAPI backend with a real pause/resume
approval flow, and a React/TypeScript web console (`web/`) for watching a
run live, approving or denying from the browser, managing agents, skills
and prompts, and scoring run quality.

![A run paused for approval](docs/images/chat-approval-1440.png)

**Everything is real except input data.** The LLM is a real OpenAI model
with native tool calling; `search_knowledge_base` is real BM25/hybrid
retrieval over a mock runbook corpus; every entity (services, incidents,
runs, events, prompts, skills, agents, dashboards, eval results, users) is
backed by a real Postgres database (via `docker-compose.yml` + Alembic
migrations). Only the *content* is mock: the 18 runbook docs in
`data/kb/`, the seed services in `data/seed/services.json`, and the 4
seeded users' identities (see "RBAC" below: real enforcement, not real
authentication). See `docs/design-report.md` for the full design
(including the sections on RBAC, skill routing, dashboard safety
layers, and eval-judge methodology) and `docs/product/PRD.md` for the
product scope and status. The repository-level overview, requirements
coverage and run guide are in the [root README](../README.md).

## Quickstart (one command, after setup)

```powershell
docker compose up -d                 # Postgres :5433 + MLflow :5001
alembic upgrade head                 # create/upgrade schema, seed data
copy .env.example .env                # then set OPENAI_API_KEY
cd web; npm install; npm run build; cd ..
uvicorn api:app
```

Open **http://127.0.0.1:8000/**. That one process serves the API and the
built web console together — there's nothing else to start. See "Setup"
below for first-time details (Python venv, Node version, etc.).

macOS / Linux: use `cp .env.example .env` instead of `copy`, and
`(cd web && npm install && npm run build)` for the web step.

## Architecture

```mermaid
flowchart TB
    subgraph Browser
        UI["React/TS web console\n(web/, path-based routing)"]
    end
    subgraph API["api.py — FastAPI (one uvicorn process)"]
        Routers["routers/: agents, skills, prompts, dashboards, evals"]
        Core["POST /run, /runs (+approve/events/export),\n/services, /incidents, /kb, /me"]
    end
    subgraph Harness["src/agent_harness/"]
        Loop["loop.py — AgentLoop\n(Pydantic AI Agent.iter(), state machine)"]
        Runtime["agent_runtime.py — resolves agent ->\nprompt + skill mode + tool set"]
        RBAC["rbac.py — role x action matrix\n+ ownership/visibility"]
        Tools["tools/ — search_knowledge_base,\nget_service_status, create_incident"]
        Retrieval["retrieval.py — BM25 + optional\ndense embeddings (hybrid)"]
        EvalAgent["eval/ — judge.py (LLM-as-judge)\n+ metrics.py (deterministic)"]
        DB["db.py / repos/ — psycopg over Postgres"]
    end
    subgraph Infra["Docker"]
        PG[("Postgres :5433\nservices, incidents, runs, events,\nprompts, skills, agents, dashboards,\neval_runs, eval_results, users")]
        MLflow["MLflow :5001\ntraces + eval runs"]
        OpenAI(["OpenAI API\ngpt-4o-mini, native tool calling"])
    end

    UI -->|X-User-Id header| API
    Routers --> RBAC
    Core --> Runtime --> Loop
    Loop --> Tools
    Tools --> DB
    Tools --> Retrieval
    Loop -->|trace| DB
    Loop -->|trace| MLflow
    Loop <--> OpenAI
    EvalAgent --> DB
    EvalAgent --> MLflow
    EvalAgent <--> OpenAI
    DB --> PG
```

## Architecture summary

```
cli.py                     CLI entrypoint (sync, interactive y/N approval)
api.py                     FastAPI entrypoint: sync /run + async /runs +
                              /services, /incidents, /kb
web/                       React/TypeScript ops console (built -> served
                              as static files by api.py; see "Run the app")
        |
src/agent_harness/loop.py  AgentLoop: the state machine / execution loop
        |
        +-- llm_client.py    pydantic_ai.models.Model factories:
        |                    build_openai_model() (real default; native
        |                    tool calling; requires OPENAI_API_KEY),
        |                    build_scripted_model()/build_router_model()/
        |                    build_test_model() (deterministic test doubles,
        |                    zero network calls)
        +-- tools/           3 tools (input/output schemas are pydantic;
        |                      the tool schemas OpenAI sees are generated
        |                      directly from them):
        |                      search_knowledge_base (real BM25, retrieval.py)
        |                      get_service_status (real Postgres, db.py)
        |                      create_incident (real Postgres insert,
        |                        requires_approval = True, idempotent per run)
        +-- retrieval.py     BM25Okapi index over data/kb/*.md
        +-- db.py            Postgres persistence (psycopg): services, incidents, runs, events
        +-- settings.py      .env-driven config (OPENAI_API_KEY/MODEL, DATABASE_URL, KB paths)
        +-- approval.py      ApprovalCallback seam (CLI prompt / fixed / custom)
        +-- run_registry.py  Async run store: one background thread per run,
        |                      Event-based approval callback for POST /runs,
        |                      write-through to Postgres so GET /runs survives restart
        +-- trace_logger.py  JSONL writer: one line per event, runs/<run_id>.jsonl;
        |                      optional on_event hook streams live progress to
        |                      run_registry without a second history format
        +-- schemas.py       LLMDecision, AgentEvent, RunResult (pydantic)
        +-- config.py        HarnessConfig: step/time limits, retries, timeouts
```

Each loop iteration ("step") does:
1. Check wall-clock and step limits; abort cleanly if exceeded. The wall
   clock measures agent compute only: time spent waiting on a human approval
   has its own budget (`APPROVAL_TIMEOUT_SECONDS`, default 15 min). An
   approval nobody answers ends the run as `cancelled` with an
   `approval_timed_out` event, never as a silent denial.
2. Ask the LLM client for a decision (`raw_decide`), validate it as an
   `LLMDecision` (pydantic). Malformed output is retried up to
   `max_llm_retries`; if `final_answer`, the run completes.
3. If it's a `tool_call`: validate `tool_args` against the tool's
   `input_model`. If the tool requires approval (`create_incident`), block
   on the injected `approval_callback` before touching the tool.
4. Execute the tool in a worker thread with a hard timeout
   (`tool_timeout_seconds`); retry on timeout/execution error up to
   `max_tool_retries` with linear backoff.
5. Record every sub-step as a structured `AgentEvent`, both in-memory
   (`RunResult.history`) and streamed to `runs/<run_id>.jsonl`.

## RBAC: seeded users and the identity switcher

**Honesty note: this is a local identity switcher, not authentication.**
There is no login form, password, or session token — the web console's
user switcher (top of the sidebar) just sets an `X-User-Id` header (SSE
connections pass `?as_user=` instead) that the server resolves to one of 4
seeded users. Anyone with `curl` can set that header to any user id and
act as them; this is a deliberate, documented scope cut for a local-only
local-only app, not an oversight.

What **is** real: `agent_harness/rbac.py` enforces a role -> action
permission matrix, and a per-resource ownership+visibility check
(`owner_id` + `private`/`shared`), on every single mutating route — a
viewer gets a real 403 from the server if they try to mutate anything past
chat, regardless of what the UI shows; a parametrized test
(`tests/test_rbac.py`) walks every `POST`/`PATCH`/`DELETE` route
registered on the FastAPI app and asserts exactly this.

| User id | Display name | Role | Can do |
|---|---|---|---|
| `u_admin` | Alice Admin | `admin` | Everything, including admin-only Integrations/Guardrails, and sees every private resource regardless of owner. |
| `u_editor` | Evan Editor | `editor` | Create/edit prompts, skills, agents, automations, dashboards, own service-status changes, and start eval scoring runs — but only on resources they own (or shared ones, read-only); cannot touch Integrations/Guardrails. |
| `u_editor2` | Erin Editor | `editor` | A second editor identity, seeded specifically so RBAC tests/demos can show editor-vs-other-editor's-private-resource denial (404, not 403 — existence isn't leaked). |
| `u_viewer` | Vera Viewer | `viewer` | Chat (create sessions/runs, approve their own run's pending approval) and read shared/own resources; cannot mutate any config. |

## Feature tour (every sidebar tab)

| Tab | What's real |
|---|---|
| **New chat** (`/`) | Objective composer; `/slug` slash-command autocomplete for any enabled skill. |
| **Sessions** | Every chat session persisted in Postgres, resumable; a session mid-run stays "live" (polls/reconnects to the real run state) even after a refresh or a new tab. |
| **Run page** (opened from Sessions/New chat) | Live SSE trace, approve/deny panel, token usage, and the **chat inspector** (`Ctrl+.`): Timeline/Tools/Reasoning/Context/Raw tabs over the run's real persisted events, down to 375px wide. |
| **Memory** | Per-session conversation memory surfaced explicitly: every run's full trace, oldest first, read back from the same persisted `runs`/`events` rows. |
| **Services** | Real Postgres-backed mock service registry; flip a status (RBAC: `mutate_services`) to create a real scenario for the agent to investigate. |
| **Incidents** | Real incidents created by approved `create_incident` tool calls, linked back to the originating run. |
| **Knowledge base** | Open any document (rendered, as the indexed chunks, or raw) with search hits highlighted and metadata; add/upload and delete documents (really chunked and indexed); reindex; a retrieval playground with BM25 / vector / fused scores per chunk. Hybrid BM25 + dense search over the mock runbook corpus plus whatever you add. |
| **Integrations** | Admin-only on/off toggles per tool — disabling one really removes it from the LLM's available tool list for new runs. |
| **Prompts** | Versioned system-prompt registry: every version is verified (lint rules + optional LLM review, stored per version) before it can be activated; roll back; diff; per-version usage counts; a **Playground** chats with a real agent using any version or an unsaved draft (real tools, real approval gate) or compares two versions side by side. A run records the exact prompt version it used; an agent can pin one. |
| **Guardrails** | Admin-only, real input/output checks (blocked objective patterns, severity-downgrade rules), applied before/after LLM calls, traced when triggered. |
| **Automations** | Editor+ rule engine (e.g. "if a service flips to `down`, auto-start an investigation run"). |
| **Agents** | Named entity binding a prompt (+ optional pinned version), a skill-routing mode (`none`/`assigned`/`auto`), and a base tool set; one is marked default. |
| **Skills** | Reusable capability: instructions + `allowed_tools` subset + description (the routing signal for `auto` mode). |
| **Dashboards** | 4 templates (blank/ops-overview/agent-performance/incident-analytics) **or ask the agent** ("build me a dashboard of incidents by severity over time" — the `create_dashboard` tool pauses on an approval card showing the widgets, their SQL and a live dry run); duplicate; saved auto-refresh interval. Every widget stores a real SQL query, executed on Refresh under a least-privilege Postgres role over owner-scoped views (parse allowlist + `harness_reader` + READ ONLY + timeout/row cap — `docs/design-report.md` §11c). |
| **Evals** | LLM-as-judge scoring ("Score my sessions") + a metrics overview (per-metric KPIs, 30-day trend, worst runs, per-agent breakdown) — see `docs/design-report.md` §11d for the judge methodology and its limitations, and the wall-clock-vs-agent-only latency split. |
| **Logs** | Persisted run list, filterable, per-run JSON export. |

## Requirements

- Python 3.10+ (developed and tested on 3.11)
- Node.js 20.19+ or 22.12+ for the web console (Vite 8)
- Docker (for the Postgres persistence layer — `docker-compose.yml` at the
  project root). Running the test suite does **not** require a manual
  `docker compose up`: it uses `testcontainers` to spin up (and tear down)
  a throwaway Postgres automatically. Running the CLI/API for real does.
- No API key needed to run the tests (they use `ScriptedLLMClient`/
  `HeuristicMockLLMClient` exclusively — zero network calls).
- A real `OPENAI_API_KEY` **is** needed to run real objectives through the
  CLI/API/web console (the actual demo path) — see "Configure your API
  key" below. Without it, the CLI exits with a clear error and the API/UI
  stay up but show a clear "LLM not configured" state; there is no silent
  fallback to a fake model.

## Setup

```powershell
cd agent-harness
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
```

(bash/macOS/Linux equivalent: `python3 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"`)

### Database (Postgres + Alembic)

Start Postgres (a named Docker volume persists data across restarts; host
port 5433 to avoid clashing with any other local Postgres):

```powershell
docker compose up -d postgres
```

Apply migrations (creates `services`, `incidents`, `runs`, `events`,
`chat_sessions`, `users`, `prompts`/`prompt_versions`, `skills`, `agents`,
`dashboards`/`dashboard_widgets`, `eval_runs`/`eval_results`, seeding the 4
RBAC users and the default prompt/skill/agent library):

```powershell
alembic upgrade head
```

Both the CLI and API call `db.ensure_ready()` on startup, which verifies
the schema is present (failing fast with a clear message if you skipped
`alembic upgrade head`) and seeds `services` from
`data/seed/services.json` if the table is empty. Connection string is
`DATABASE_URL` in `.env` (see `.env.example`); defaults to
`postgresql://agent_harness:agent_harness@localhost:5433/agent_harness`,
matching `docker-compose.yml`.

## Configure your API key

```powershell
copy .env.example .env
```

Edit `.env` and set `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`,
default `gpt-4o-mini`). `.env` is gitignored and loaded via
`python-dotenv`; the key is never printed or logged anywhere in this
codebase. See `.env.example` for every variable this harness reads.

## Run the tests

```powershell
pytest
```

Expected: 669 tests pass, 0 failures (about 11 minutes), **no API key required, no manual
`docker compose up` required** — the default `pytest` run excludes the 2
opt-in `live` tests via the `live` marker (`-m "not live"`, set in
`pyproject.toml`'s `addopts`). `tests/conftest.py` spins up a throwaway
Postgres via `testcontainers` once per session (runs `alembic upgrade
head` against it), truncates every table before each test, and tears the
container down at session end. To run against an already-running Postgres
instead (e.g. offline, or when Docker-in-Docker isn't available), set
`AGENT_HARNESS_TEST_DATABASE_URL` — e.g. after `docker compose up -d
postgres`:

```powershell
$env:AGENT_HARNESS_TEST_DATABASE_URL = "postgresql://agent_harness:agent_harness@localhost:5433/agent_harness"
pytest
```

The suite exercises `agent_harness.llm_client`'s deterministic test
doubles (`build_scripted_model`/`build_router_model`/`build_test_model`)
exclusively for LLM decisions; `build_openai_model()`'s request/response
handling is separately tested against fake-but-structurally-real SDK
objects (`tests/test_openai_client.py`), still with zero network calls.
`tests/conftest.py` forces `AGENT_HARNESS_RETRIEVAL_MODE=bm25` for the
whole suite so it never needs to download the local embedding model —
hybrid retrieval quality is instead measured by the eval script below.

### End-to-end smoke test

`tests/test_e2e_smoke.py` (marked `e2e`, runs as part of the default suite
above — not excluded like `live`) drives the real HTTP API through one full
journey: login-as an editor -> create a skill -> create an agent (auto
mode) -> run via `/slug` and auto-discover modes -> approve a sensitive
tool call -> refresh a dashboard from a template -> score sessions (eval
agent) -> read the metrics overview (including the `agent_latency_ms` vs
`latency_ms` split). By default every LLM call is a deterministic double
(network-free); pass `--live` to run the exact same journey against the
real OpenAI API instead:

```powershell
pytest tests/test_e2e_smoke.py -v            # deterministic doubles
pytest tests/test_e2e_smoke.py -v --live     # real OpenAI API (needs OPENAI_API_KEY)
```

## Retrieval quality eval (BM25 vs dense vs hybrid)

```powershell
python -m agent_harness.eval_retrieval
```

Runs `data/kb_eval/queries.jsonl` (37 paraphrased ops queries with labeled
relevant doc ids) against all three retrieval modes and prints a
recall@1/recall@3/MRR table. Requires `sentence-transformers` (a real
dependency now, not optional) and downloads `BAAI/bge-small-en-v1.5` on
first run. See `docs/design-report.md` section 8 for the captured
results table.

Run the one real end-to-end test against OpenAI (requires a configured
key; skipped automatically otherwise):

```powershell
pytest -m live
```

## MLflow observability (tracing + recorded-transcript eval)

Bring up the `mlflow` service alongside Postgres (reuses the same
container, a separate `mlflow` database — see `docker-compose.yml`):

```powershell
docker compose up -d
```

Open the MLflow UI at **http://localhost:5001**. Point the app at it by
setting `MLFLOW_TRACKING_URI=http://localhost:5001` in `.env` (see
`.env.example`) — unset/empty disables tracing entirely, which is the
default for `pytest` so the suite never depends on the server running.

Every real run then produces a real, nested MLflow trace: one `agent_run`
span per objective, with `llm_request`/`llm_decision`/`tool_call:<name>`
spans nested inside it (manual `@mlflow`-style spans via
`agent_harness/observability.py`, since `mlflow.pydantic_ai.autolog()`'s
own documented compatibility range is pydantic-ai 0.2.19-1.94.0 — this
project pins `pydantic-ai==2.51.0`, outside it; autolog is still enabled
underneath and does add extra granular `OpenAIChatModel.request`/tool
spans when reachable via the real provider, they just don't group into one
trace per run on their own — see that module's docstring for the verified
findings). Trigger one real trace with:

```powershell
python cli.py --auto-approve "What is the status of auth-service?"
```

then open http://localhost:5001, select the `agent-harness` experiment,
and open the newest trace.

Recorded-transcript regression eval — capture real transcripts against the
real API (already checked in under `src/agent_harness/eval/transcripts/`,
so this step is optional unless you want to refresh them):

```powershell
python -m agent_harness.eval.capture_transcripts
```

Score them and produce a real MLflow eval run:

```powershell
$env:MLFLOW_TRACKING_URI = "http://localhost:5001"
python -m agent_harness.eval.run_eval
```

Prints each scorer's pass rate and a per-scenario table, and creates a real
run under the `agent-harness-eval` experiment in the MLflow UI. See
`docs/design-report.md`'s observability section for a captured example of
this output.

## Run the CLI

Requires a configured `OPENAI_API_KEY` by default (see above):

```powershell
python cli.py "What is the status of auth-service?"
```

Anything that leads the agent to propose `create_incident` pauses for an
interactive `y/N` approval prompt:

```powershell
python cli.py "search-index is down, please create an incident"
```

Skip the prompt for scripted/CI use with `--auto-approve`:

```powershell
python cli.py --auto-approve "search-index is down, please create an incident"
```

Every run writes a structured trace to `runs/<run_id>.jsonl` and prints a
step-by-step summary to stdout. Useful flags: `--max-steps`,
`--max-wall-clock-seconds`, `--runs-dir`, `--mock` (offline demo — see
below).

### Offline/CI demo backend: `--mock`

`HeuristicMockLLMClient` is now a CI-only test double, not the CLI's
default. Pass `--mock` to explicitly opt into it for an offline demo (no
API key, no network) — retrieval and Postgres persistence are still fully
real, only the decision policy is the small rule set:

```powershell
python cli.py --mock --auto-approve "search-index is down, please create an incident"
```

## Run the app (backend + web console)

**Recommended run mode: one process.** Build the web console once,
then start the FastAPI backend — it serves both the API and the built
frontend from the same `uvicorn` process on one port, so there is no CORS
involved on this path at all.

```powershell
cd web
npm install
npm run build
cd ..
uvicorn api:app
```

Open **http://127.0.0.1:8000/** in a browser. That's the whole app: submit
an objective, watch the live trace, approve/deny `create_incident` when it
pauses, browse run history.

`api.py` mounts `web/dist` (override with `AGENT_HARNESS_WEB_DIST=<dir>` to serve a side-by-side build, e.g. `npm run build -- --outDir dist-v4`) at `/` only if that directory exists (guarded,
so `uvicorn api:app` and the test suite both still work before you've run
`npm run build` — you'll just get 404 on `/` and the API endpoints keep
working).

**URL layout.** Every API route lives under **`/api/v1`** (interactive docs at
`/api/v1/docs`, schema at `/api/v1/openapi.json`); `/health` is also served
unprefixed for probes and scripts. Any other non-API `GET` is the web console:
a real file from the build if one exists, otherwise `index.html` (SPA history
fallback), so clean UI paths such as `/sessions/<id>`, `/dashboards/<id>` and
`/evals` survive a refresh or a deep link. Unknown `/api/...` paths are a real
404 and a missing `*.js`/`*.css` asset is a 404, never HTML. The route names
quoted below (`/runs`, `/incidents`, ...) are relative to `/api/v1`.

**Optional: frontend-only dev loop** (hot reload while iterating on the
UI). Two terminals — backend on 8000, Vite's own dev server on 5173:

```powershell
uvicorn api:app --reload
```

```powershell
cd web
npm run dev
```

Open **http://localhost:5173/**. `api.py` enables CORS for
`localhost:5173`/`127.0.0.1:5173` specifically to support this loop; the
frontend defaults its API base URL to `http://127.0.0.1:8000` when running
under `npm run dev` (see `web/src/lib/api.ts`). This mode is a convenience
only — the single-process build above is the one that is verified end to end.

### Two run flows on the backend

- **`POST /run`** — synchronous, request/response, kept for the Postman
  collection and other non-UI callers. `auto_approve` (default `false`)
  pre-authorizes (or pre-denies) every approval-gated tool call for that
  one run *before* the loop starts — this is request-level
  pre-authorization, not a real pause/resume flow.
  ```json
  {
    "objective": "search-index is down, please create an incident",
    "auto_approve": true,
    "max_steps": 6
  }
  ```
- **`POST /runs` -> `GET /runs/{run_id}` -> `POST /runs/{run_id}/approve`**
  — the real pause/resume flow the web console uses. `POST /runs` starts
  the run on a background thread and returns `{run_id, status}`
  immediately; `GET /runs/{run_id}` returns a live snapshot (`status` is
  `running` / `pending_approval` / `completed` / `step_limit_exceeded` /
  `time_limit_exceeded` / `llm_error_exceeded`, plus the pending
  `create_incident` args when `pending_approval`, plus the history so
  far); `POST /runs/{run_id}/approve` (`{"approved": true|false}`)
  resolves the pending approval and unblocks the run. `GET /runs` lists
  recent runs for a history view. See `docs/design-report.md` section 6
  for the background-thread + `threading.Event` design.
- **`GET /runs/{run_id}/events`** — Server-Sent Events stream of the same
  `AgentEvent`s, pushed the instant each is recorded (no polling); the web
  console's run page uses this for live updates, falling back to one
  `GET /runs/{run_id}` snapshot on load. Closes with a `stream_end` event
  once the run finishes. `curl -N http://127.0.0.1:8000/api/v1/runs/<id>/events`
  to watch a run live.
- **`GET /runs/{run_id}/export`** — full run + trace as one JSON document
  (used by the web console's Logs page "Export" button, and for attaching
  real evidence to a bug report).

A ready-to-import Postman collection covering the health check, happy
path, both `POST /run` approval outcomes, and a validation-error case is
at `postman/agent-harness.postman_collection.json`.

## Tools (real behavior, mock input data)

| Tool | Approval required | Notes |
|---|---|---|
| `search_knowledge_base(query)` | No | Real BM25 ranking (`rank-bm25`) over `data/kb/*.md` — 18 mock ops runbooks, chunked and indexed at process start. |
| `get_service_status(service_name)` | No | Real Postgres read from `services`, seeded once from `data/seed/services.json` (`auth-service`, `payments-api`, `search-index`, plus 2 more). Unknown names raise a simulated failure, exercising the retry path. Flip a status live via the web console's Services page (RBAC: `mutate_services`) or `POST /services/{name}/status`. |
| `create_incident(title, description, severity)` | **Yes** | Real Postgres insert; idempotent per run (same `run_id` + `title` returns the existing row instead of duplicating). Still no external incident system is contacted. |
| `create_dashboard(name, widgets[])` / `add_widget(dashboard_id, widget)` | **Yes** | Real dashboards of read-only SQL widgets. A dry run of every widget (same read-only path as production) happens before the approval card, which shows name, widgets, SQL and live row counts. Editors/admins only (RBAC removes the tools for viewers); both are Integrations toggles. |

## API surface

The full route list (agents/skills/prompts/dashboards/evals routers plus
the core endpoints) is easiest to read straight from FastAPI's own docs —
run the app and open **http://127.0.0.1:8000/docs**. The endpoints most
worth knowing about beyond the run flow below:

| Endpoint | Purpose |
|---|---|
| `GET /health` | `{status, llm_configured, llm_model, llm_last_error}` — the UI's health banner distinguishes "not configured" (`llm_configured=false`) from "configured but the last real call failed" (`llm_last_error` set to the real provider message). |
| `GET /me` | Resolves the caller's `X-User-Id` header to `{id, name, role, permissions}` — what the RBAC-aware UI controls key off of. |
| `GET /services` / `POST /services/{name}/status` | List / flip mock service statuses. |
| `GET /incidents` | Real incidents created by approved `create_incident` calls. |
| `GET /kb`, `GET /kb/{id}?q=`, `POST /kb`, `DELETE /kb/{id}`, `POST /kb/reindex`, `POST /kb/retrieve`, `POST /kb/search` | List / read a document with chunks and matches / add / delete / reindex / chunk-level scores / the doc-level search the tool uses. |
| `GET/POST /agents`, `/skills`, `/prompts` | CRUD for the 3 entities an agent binds together; see `docs/design-report.md` §11b. |
| `GET/POST /dashboards`, `.../refresh`, `POST /queries/preview` | Dashboard CRUD + live widget SQL execution; see §11c. |
| `POST /prompts/verify`, `POST /prompts/{id}/versions/{vid}/verify`, `POST /runs` with `playground`, `POST /runs/{id}/cancel` | Verify a draft or a saved version; run with an explicit system prompt; stop a run. |
| `POST /eval-runs`, `GET /eval-metrics/overview` | Start/poll an eval-judge scoring run; read the metrics overview; see §11d. |

## Trace format

Each line in `runs/<run_id>.jsonl` is one JSON object:

```json
{"run_id":"81f4fb285b74","step":2,"event_type":"tool_call_result","timestamp":1780000000.0,"latency_ms":0.4,"data":{"tool_name":"create_incident","args":{...},"attempt":1,"output":{...}}}
```

`event_type` values: `llm_decision`, `llm_malformed_response`,
`llm_retry_exhausted`, `tool_validation_error`, `tool_call_started`,
`tool_call_result`, `tool_call_error`, `tool_call_timeout`,
`tool_call_retry`, `tool_call_retries_exhausted`, `approval_requested`,
`approval_granted`, `approval_denied`, `final_answer`,
`step_limit_exceeded`, `time_limit_exceeded`, plus v3's routing/safety
events: `skill_routed` (auto-mode router decision), `skill_invoked`
(`/slug` forced a skill), `skills_assigned` (assigned-mode tool scoping),
`guardrail_blocked`, `guardrail_severity_downgraded`.

## Project layout

```
agent-harness/
  docker-compose.yml       postgres:16 service (host port 5433)
  alembic.ini, alembic/    schema migrations (`alembic upgrade head`)
  src/agent_harness/       harness package (see architecture summary above)
  data/kb/                 18 mock ops runbooks (*.md), BM25-indexed
  data/seed/services.json  mock service seed data
  tests/                   pytest suite (669 tests + 2 opt-in `live` tests
                              + test_e2e_smoke.py, marked `e2e`, default-on)
  cli.py                   CLI entrypoint
  api.py                   FastAPI entrypoint (sync + async run flows,
                              /services, /incidents, /kb, /me; includes
                              routers/{agents,skills,prompts,dashboards,evals};
                              serves web/dist as static files once built)
  web/                     React/TypeScript ops console (Vite + Tailwind,
                              see "Feature tour" above; vitest suite of 332 tests)
  postman/                 Postman collection for the API
  docs/design-report.md    design write-up (architecture, env vars,
                              limitations, future work, v3 RBAC/skills/
                              dashboards/eval-judge design in §11)
  docs/product/PRD.md      product requirements + v3 status table (§8)
  docs/demo-evidence.md    real captured transcripts
  .env.example             copy to .env and fill in OPENAI_API_KEY
  runs/                    JSONL trace files (written at run time)
```

## Known limitations

See `docs/design-report.md` §6 (original) and §11 (v3) for the full list;
the short version:

- **The identity switcher is not authentication.** `X-User-Id` is a plain,
  trivially-spoofable header; there is no login, password, or session.
  RBAC enforcement (the role/ownership/visibility checks) is real, but
  "who you are" is not verified. Fine for a local, single-operator/demo
  tool; not something to expose past localhost as-is.
- `POST /run` is still request-level pre-authorization (kept for non-UI
  callers); the real pause/resume flow is `POST /runs` + friends, used by
  the web console.
- Postgres persistence covers the async API run flow (`GET /runs`/
  `/incidents` survive a restart, including the Logs page and `GET
  /runs/{id}/export`) but not CLI-originated runs, which still only write
  the JSONL trace.
- Retrieval is hybrid (BM25 + local dense embeddings) but the embedding
  model's first-use load can take several seconds (design-report.md §8
  "cold-start embedding latency").
- The SSE stream (`GET /runs/{id}/events`) first replays the run's history
  so far (a client that connects late still sees a pending approval), then
  pushes each `AgentEvent` and live `llm_token_delta` as it is recorded. The
  run page also re-reads `GET /runs/{id}` every 3 s while a run is in flight,
  so status and approvals converge even if a proxy or the browser's
  per-host connection limit holds the stream back.
- The eval judge scores one transcript at a time with no calibration
  step against human review, and scoring runs are manually triggered only
  (no scheduled/recurring evals) — design-report.md §11d.
- Dashboard widget SQL is read-only-enforced several ways (parser + `READ
  ONLY` transaction + statement timeout/row cap, executed as the
  restricted `harness_reader` role over owner-scoped views — §11c). It is
  a local single-user design and does not stop expensive reads.
- RBAC is a 3-role matrix + ownership/visibility, not per-object ACLs —
  sufficient for this app's resource shapes, not a general permission
  system.

## Traces and logs persist across restarts

Every run's full event history is written twice: append-only to
`runs/<run_id>.jsonl` as it happens (survives even a hard crash mid-run),
and to the `runs`/`events` tables in Postgres once each event is recorded.
Both survive a process restart — `GET /runs`, the
**Logs** page (filterable by status/incident/date, with a per-run JSON
export button), and `GET /runs/{id}/export` all read from this same
persisted store. This is the audit log a real ops team would want: every
tool call, LLM decision, and approval decision, permanently attributable
to the run that produced it.

## Evidence this actually runs

`docs/demo-evidence.md` has real captured terminal transcripts: a full
`pytest -v` run, a CLI run that hits and approves the `create_incident`
approval prompt, a curl transcript of the async pause/resume flow going
`POST /runs` -> `pending_approval` -> `POST /runs/{id}/approve` ->
`completed`, real BM25 `POST /kb/search` output, a real incident created
and read back through `GET /incidents` before and after a full process
restart, and a real (billing-error) response from an actual `POST` to
`api.openai.com` proving the native tool-calling request/auth path is
genuinely wired end to end. UI screenshots and short videos are in
`docs/images/`, indexed in `docs/ui-evidence-and-demo-reset.md`, and shown
below.

## Screenshots and flows

All captured from the live app (1440 px desktop, 390 px phone).

| Approval bar | Session thread | Inspector |
|---|---|---|
| ![Approval](docs/images/chat-approval-1440.png) | ![Thread](docs/images/session-thread-1440.png) | ![Inspector](docs/images/chat-inspector-1440.png) |
| **Workspace panel** | **Retrieval playground** | **Guardrails sandbox** |
| ![Workspace](docs/images/chat-workspace-1440.png) | ![Playground](docs/images/kb-playground-1440.png) | ![Sandbox](docs/images/guardrails-sandbox-1440.png) |
| **Agents** | **Skill routing tester** | **Eval run detail** |
| ![Agents](docs/images/agents-1440.png) | ![Routing](docs/images/skills-routing-tester-1440.png) | ![Evals](docs/images/evals-run-detail-1440.png) |

| Phone: new run | Phone: sessions | Phone: approval |
|---|---|---|
| ![New run 390](docs/images/chat-new-390.png) | ![Sessions 390](docs/images/sessions-390.png) | ![Approval 390](docs/images/chat-approval-390.png) |

Flow videos (WebM; GitHub does not play WebM inline in a README, so these
are links):

- [Run, approval, workspace panel](docs/images/video-run-approval-to-workspace.webm)
- [Sessions: bulk archive and Undo](docs/images/video-sessions-bulk-archive-undo.webm)
- [Knowledge base: document sheet and playground](docs/images/video-kb-doc-sheet-and-playground.webm)

The web console's own checks: `cd web; npm run lint; npm run typecheck; npm test; npm run build`.
To reset the demo data between runs, see [`docs/ui-evidence-and-demo-reset.md`](docs/ui-evidence-and-demo-reset.md).

---
Author: Phu Nguyen — HCMC, VN
