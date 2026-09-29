# Agent Harness

An LLM <-> tool execution harness for an ops assistant, built for the
STEMS VN AI Engineer take-home test. It runs an objective through a
decide -> validate -> (approve) -> execute -> record loop, with schema
validation, retries/timeouts, a human-approval gate on `create_incident`,
step/wall-clock limits, and a structured JSONL trace per run — exposed via
a CLI, a FastAPI backend with a real pause/resume approval flow, and a
web console (`web/`) for watching a run live and approving/denying from
the browser.

**Everything is real except input data.** The LLM is a real OpenAI model
with native tool calling; `search_knowledge_base` is real BM25 retrieval
over a mock runbook corpus; `get_service_status`/`create_incident`/run
history are backed by a real SQLite database. Only the *content* is
mock: the 18 runbook docs in `data/kb/`, the seed services in
`data/seed/services.json`. See `docs/design-report.md` for the full
design and `docs/demo-evidence.md` for real captured transcripts.

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
        +-- llm_client.py    LLMClient interface + ScriptedLLMClient (tests),
        |                    HeuristicMockLLMClient (CI-only test double),
        |                    OpenAIChatLLMClient (real default; native
        |                    tools= tool calling; requires OPENAI_API_KEY)
        +-- tools/           3 tools (input/output schemas are pydantic;
        |                      the tool schemas OpenAI sees are generated
        |                      directly from them):
        |                      search_knowledge_base (real BM25, retrieval.py)
        |                      get_service_status (real SQLite, db.py)
        |                      create_incident (real SQLite insert,
        |                        requires_approval = True, idempotent per run)
        +-- retrieval.py     BM25Okapi index over data/kb/*.md
        +-- db.py            SQLite persistence: services, incidents, runs, events
        +-- settings.py      .env-driven config (OPENAI_API_KEY/MODEL, DB/KB paths)
        +-- approval.py      ApprovalCallback seam (CLI prompt / fixed / custom)
        +-- run_registry.py  Async run store: one background thread per run,
        |                      Event-based approval callback for POST /runs,
        |                      write-through to SQLite so GET /runs survives restart
        +-- trace_logger.py  JSONL writer: one line per event, runs/<run_id>.jsonl;
        |                      optional on_event hook streams live progress to
        |                      run_registry without a second history format
        +-- schemas.py       LLMDecision, AgentEvent, RunResult (pydantic)
        +-- config.py        HarnessConfig: step/time limits, retries, timeouts
```

Each loop iteration ("step") does:
1. Check wall-clock and step limits; abort cleanly if exceeded.
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

## Requirements

- Python 3.10+
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

Expected: 52 tests pass, 0 failures, **no API key required** — the
default `pytest` run excludes the one opt-in live test via the `live`
marker. The suite exercises `ScriptedLLMClient`/`HeuristicMockLLMClient`
exclusively for LLM decisions; `OpenAIChatLLMClient`'s request/response
parsing is separately tested against fake-but-structurally-real SDK
objects (`tests/test_openai_client.py`), still with zero network calls.
`tests/conftest.py` forces `AGENT_HARNESS_RETRIEVAL_MODE=bm25` for the
whole suite so it never needs to download the local embedding model —
hybrid retrieval quality is instead measured by the eval script below.

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
API key, no network) — retrieval and SQLite persistence are still fully
real, only the decision policy is the small rule set:

```powershell
python cli.py --mock --auto-approve "search-index is down, please create an incident"
```

## Run the app (backend + web console)

**Documented/graded run mode: one process.** Build the web console once,
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

`api.py` mounts `web/dist` at `/` only if that directory exists (guarded,
so `uvicorn api:app` and the test suite both still work before you've run
`npm run build` — you'll just get 404 on `/` and the API endpoints keep
working). The web app uses hash-based routing (`/#/runs/<id>`) on purpose:
since the backend serves the build as plain static files, only the
literal `/` resolves to `index.html` server-side; hash routes never hit
the server's router, so refreshing or deep-linking into a run always
works without a SPA-fallback catch-all route.

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
only — the single-process build above is the one that's actually graded/
verified end to end.

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
  once the run finishes. `curl -N http://127.0.0.1:8000/runs/<id>/events`
  to watch a run live.
- **`GET /runs/{run_id}/export`** — full run + trace as one JSON document
  (used by the web console's Logs page "Export" button, and for attaching
  real evidence to a submission).

A ready-to-import Postman collection covering the health check, happy
path, both `POST /run` approval outcomes, and a validation-error case is
at `postman/agent-harness.postman_collection.json`.

## Tools (real behavior, mock input data)

| Tool | Approval required | Notes |
|---|---|---|
| `search_knowledge_base(query)` | No | Real BM25 ranking (`rank-bm25`) over `data/kb/*.md` — 18 mock ops runbooks, chunked and indexed at process start. |
| `get_service_status(service_name)` | No | Real SQLite read from `data/harness.db`, seeded once from `data/seed/services.json` (`auth-service`, `payments-api`, `search-index`, plus 2 more). Unknown names raise a simulated failure, exercising the retry path. Flip a status live via the web console's Services page or `POST /services/{name}/status`. |
| `create_incident(title, description, severity)` | **Yes** | Real SQLite insert; idempotent per run (same `run_id` + `title` returns the existing row instead of duplicating). Still no external incident system is contacted. |

## New API surface (phase 6)

| Endpoint | Purpose |
|---|---|
| `GET /health` | `{status, llm_configured, llm_model, llm_last_error}` — the UI's health banner distinguishes "not configured" (`llm_configured=false`) from "configured but the last real call failed" (`llm_last_error` set to the real provider message). |
| `GET /services` / `POST /services/{name}/status` | List / flip mock service statuses. |
| `GET /incidents` | Real incidents created by approved `create_incident` calls. |
| `GET /kb` | List all indexed KB docs. |
| `POST /kb/search` | Same BM25 ranking function the `search_knowledge_base` tool uses. |

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
`step_limit_exceeded`, `time_limit_exceeded`.

## Project layout

```
agent-harness/
  src/agent_harness/       harness package (see architecture summary above)
  data/kb/                 18 mock ops runbooks (*.md), BM25-indexed
  data/seed/services.json  mock service seed data
  data/harness.db          SQLite DB (gitignored, created on first boot)
  tests/                   pytest suite (52 tests + 1 opt-in live test)
  cli.py                   CLI entrypoint
  api.py                   FastAPI entrypoint (sync + async run flows,
                              /services, /incidents, /kb; serves web/dist
                              as static files once built)
  web/                     React/TypeScript ops console (Vite + Tailwind)
  postman/                 Postman collection for the API
  docs/design-report.md    submission write-up (architecture diagram,
                              env vars, limitations, future work)
  docs/demo-evidence.md    real captured transcripts
  .env.example             copy to .env and fill in OPENAI_API_KEY
  runs/                    JSONL trace files (written at run time)
```

## Known limitations

See `docs/design-report.md` sections 6-9 for the full list; the short
version: `POST /run` is still request-level pre-authorization (kept for
non-UI callers); the real pause/resume flow is `POST /runs` + friends,
used by the web console; SQLite persistence covers the async API run flow
(`GET /runs`/`/incidents` survive a restart, including the new Logs page
and `GET /runs/{id}/export`) but not CLI-originated runs, which still only
write the JSONL trace; `HeuristicMockLLMClient` is a small rule set kept
only as a CI test double, not the runtime default; retrieval is hybrid
(BM25 + local dense embeddings, see the eval above) but the embedding
model's first-use load can take several seconds (see design-report.md §8
"cold-start embedding latency"); the SSE stream (`GET /runs/{id}/events`)
pushes structured `AgentEvent`s in real time but does not stream
individual LLM tokens (see design-report.md §8's scope note).

## Traces and logs persist across restarts

Every run's full event history is written twice: append-only to
`runs/<run_id>.jsonl` as it happens (survives even a hard crash mid-run),
and to the `runs`/`events` tables in `data/harness.db` (SQLite) once each
event is recorded. Both survive a process restart — `GET /runs`, the
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
genuinely wired end to end. Live UI screenshots are not included here —
the app is meant to be opened and driven directly.

---
Author: Phu Nguyen — HCMC, VN
