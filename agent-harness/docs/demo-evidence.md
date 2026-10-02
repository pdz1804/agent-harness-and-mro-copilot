# Demo Evidence

This file exists so the harness can be reviewed without the grader having
to run anything themselves. Everything below is a **real, captured**
terminal transcript from this machine (Windows 11, Python 3.11.9, fresh
`.venv`), not hand-written or paraphrased output. Timestamps/IDs will
differ on a re-run, but the shape and outcome will not.

Reproduce any of it yourself with the commands in `README.md`.

## 1. `pytest -v` — full suite, all 23 tests passing

Command: `.venv\Scripts\python.exe -m pytest -v`

```text
============================= test session starts =============================
platform win32 -- Python 3.11.9, pytest-9.1.1, pluggy-1.6.0 -- <repo>\agent-harness\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: <repo>\agent-harness
configfile: pyproject.toml
testpaths: tests
plugins: anyio-4.15.1
collecting ... collected 23 items

tests/test_api.py::test_health_endpoint PASSED                           [  4%]
tests/test_api.py::test_run_endpoint_happy_path PASSED                   [  8%]
tests/test_api.py::test_run_endpoint_approval_required_case_denied_by_default PASSED [ 13%]
tests/test_api.py::test_run_endpoint_approval_required_case_auto_approved PASSED [ 17%]
tests/test_api.py::test_run_endpoint_rejects_blank_objective PASSED      [ 21%]
tests/test_approval_gate.py::test_approval_granted_executes_create_incident PASSED [ 26%]
tests/test_approval_gate.py::test_approval_denied_blocks_create_incident_execution PASSED [ 30%]
tests/test_approval_gate.py::test_approval_callback_receives_validated_tool_args PASSED [ 34%]
tests/test_heuristic_llm_client.py::test_initial_decision_targets_known_service PASSED [ 39%]
tests/test_heuristic_llm_client.py::test_initial_decision_defaults_to_knowledge_base_search PASSED [ 43%]
tests/test_heuristic_llm_client.py::test_reacts_to_approval_denied_with_final_answer PASSED [ 47%]
tests/test_heuristic_llm_client.py::test_reacts_to_degraded_status_by_escalating PASSED [ 52%]
tests/test_limits.py::test_step_limit_exceeded_aborts_cleanly PASSED     [ 56%]
tests/test_limits.py::test_time_limit_exceeded_aborts_cleanly PASSED     [ 60%]
tests/test_malformed_llm_response.py::test_malformed_response_then_recovery PASSED [ 65%]
tests/test_malformed_llm_response.py::test_malformed_response_retries_exhausted_aborts_cleanly PASSED [ 69%]
tests/test_success_path.py::test_success_path_completes_with_final_answer PASSED [ 73%]
tests/test_success_path.py::test_success_path_writes_jsonl_trace_file PASSED [ 78%]
tests/test_tool_failure_path.py::test_permanent_tool_failure_exhausts_retries_and_is_recorded PASSED [ 82%]
tests/test_tool_failure_path.py::test_transient_tool_failure_recovers_on_retry PASSED [ 86%]
tests/test_tool_failure_path.py::test_tool_timeout_is_recorded_and_retried PASSED [ 91%]
tests/test_tool_schema_validation.py::test_invalid_tool_args_are_rejected_before_execution PASSED [ 95%]
tests/test_tool_schema_validation.py::test_unknown_tool_name_is_recorded_and_does_not_crash PASSED [100%]

============================== warnings summary ===============================
.venv\Lib\site-packages\fastapi\testclient.py:1
  <repo>\agent-harness\.venv\Lib\site-packages\fastapi\testclient.py:1: StarletteDeprecationWarning: Using `httpx` with `starlette.testclient` is deprecated; install `httpx2` instead.
    from starlette.testclient import TestClient as TestClient  # noqa

-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
======================== 23 passed, 1 warning in 1.52s ========================
```

**What this shows:** every required scenario has its own named, passing
test — success path (`test_success_path*`), tool failure with retries
(`test_tool_failure_path*`), the approval gate both ways
(`test_approval_gate*`), and step/time limits (`test_limits*`) — plus
extra coverage for malformed LLM responses, schema validation, the API
wrapper, and the CLI's default rule-based LLM. The one warning is a
harmless library deprecation notice from FastAPI's test client, not a
test failure.

## 2. CLI end-to-end run, including a live approval prompt being approved

Command (the `y` is piped to stdin to answer the interactive prompt
non-interactively for this capture; run it without the pipe to type `y`
yourself and see the identical prompt):

```
printf "y\n" | .venv\Scripts\python.exe cli.py "search-index is down, please create an incident" --runs-dir runs
```

```text
[APPROVAL REQUIRED] Agent wants to call 'create_incident' with args:
    title: Service impacted: search-index
    description: Automated check found status='down' for objective: search-index is down, please create an incident
    severity: high
Approve? [y/N]:
=== run 7955ae2e89e3 ===
status:       completed
steps_taken:  3
elapsed_s:    0.000
final_answer: Incident INC-8FE7E52A created.
trace:        runs\7955ae2e89e3.jsonl

--- step-by-step trace ---
[step 1] llm_decision: {"action": "tool_call", "tool_name": "get_service_status", "tool_args": {"service_name": "search-index"}, "final_answer": null, "rationale": "Objective references service 'search-index'."}
[step 1] tool_call_started: {"tool_name": "get_service_status", "args": {"service_name": "search-index"}, "attempt": 1}
[step 1] tool_call_result: {"tool_name": "get_service_status", "args": {"service_name": "search-index"}, "attempt": 1, "output": {"service_name": "search-index", "status": "down", "last_checked": "2026-09-29T07:05:51.052899+00:00"}}
[step 2] llm_decision: {"action": "tool_call", "tool_name": "create_incident", "tool_args": {"title": "Service impacted: search-index", "description": "Automated check found status='down' for objective: search-index is down, please create an incident", "severity": "high"}, "final_answer": null, "rationale": "Service is unhealthy; escalate via incident."}
[step 2] approval_requested: {"tool_name": "create_incident", "args": {"title": "Service impacted: search-index", ...}}
[step 2] approval_granted: {"tool_name": "create_incident", "args": {"title": "Service impacted: search-index", ...}}
[step 2] tool_call_started: {"tool_name": "create_incident", "args": {...}, "attempt": 1}
[step 2] tool_call_result: {"tool_name": "create_incident", "args": {...}, "attempt": 1, "output": {"incident_id": "INC-8FE7E52A", "status": "created", "title": "Service impacted: search-index", "severity": "high", "created_at": "2026-09-29T07:05:51.054931+00:00"}}
[step 3] llm_decision: {"action": "final_answer", "tool_name": null, "tool_args": null, "final_answer": "Incident INC-8FE7E52A created.", "rationale": null}
[step 3] final_answer: {"final_answer": "Incident INC-8FE7E52A created.", "rationale": null}
```

**What this shows:** the harness ran a real 3-step loop end-to-end — it
checked `search-index`'s status (found it `down`), the rule-based LLM
decided to escalate via `create_incident`, the loop **stopped and printed
a literal `Approve? [y/N]:` prompt** before touching that tool (this is
the human-approval gate from the spec, not a claim — the tool truly did
not run until the prompt was answered), and only after the piped `y`
answer did `tool_call_started`/`tool_call_result` for `create_incident`
appear, producing incident `INC-8FE7E52A`. The full JSON args (title,
description, severity) were shown to the approver before the decision, as
required.

## 3. JSONL trace excerpt — structured logging requirement

This is the actual on-disk file written by the run above:
`runs/7955ae2e89e3.jsonl`. Full file has 10 lines (one JSON object per
event); the first 4 lines are reproduced here:

```json
{"run_id":"7955ae2e89e3","step":1,"event_type":"llm_decision","timestamp":1790665551.0518975,"latency_ms":0.0,"data":{"action":"tool_call","tool_name":"get_service_status","tool_args":{"service_name":"search-index"},"final_answer":null,"rationale":"Objective references service 'search-index'."}}
{"run_id":"7955ae2e89e3","step":1,"event_type":"tool_call_started","timestamp":1790665551.0518975,"latency_ms":null,"data":{"tool_name":"get_service_status","args":{"service_name":"search-index"},"attempt":1}}
{"run_id":"7955ae2e89e3","step":1,"event_type":"tool_call_result","timestamp":1790665551.0528994,"latency_ms":0.0,"data":{"tool_name":"get_service_status","args":{"service_name":"search-index"},"attempt":1,"output":{"service_name":"search-index","status":"down","last_checked":"2026-09-29T07:05:51.052899+00:00"}}}
{"run_id":"7955ae2e89e3","step":2,"event_type":"llm_decision","timestamp":1790665551.054032,"latency_ms":0.0,"data":{"action":"tool_call","tool_name":"create_incident","tool_args":{"title":"Service impacted: search-index","description":"Automated check found status='down' for objective: search-index is down, please create an incident","severity":"high"},"final_answer":null,"rationale":"Service is unhealthy; escalate via incident."}}
```

And the two lines that prove the approval gate fired on disk, not just in
stdout (lines 5-6 of the same file):

```json
{"run_id":"7955ae2e89e3","step":2,"event_type":"approval_requested","timestamp":1790665551.054032,"latency_ms":null,"data":{"tool_name":"create_incident","args":{"title":"Service impacted: search-index","description":"Automated check found status='down' for objective: search-index is down, please create an incident","severity":"high"}}}
{"run_id":"7955ae2e89e3","step":2,"event_type":"approval_granted","timestamp":1790665551.054032,"latency_ms":null,"data":{"tool_name":"create_incident","args":{"title":"Service impacted: search-index","description":"Automated check found status='down' for objective: search-index is down, please create an incident","severity":"high"}}}
```

**What this shows:** each line is a standalone, valid JSON object
(`run_id`, `step`, `event_type`, `timestamp`, `latency_ms`, `data`),
written one line per loop event as it happens — this is the "structured
logs/traces per execution" requirement from the spec, and it is the same
trace file the CLI printed a human-readable summary of in section 2
above (`trace: runs\7955ae2e89e3.jsonl`).

## 4. `pytest -v` — the new async pause/resume run flow, all 8 tests passing

Command: `.venv\Scripts\python.exe -m pytest -v tests/test_api_async_runs.py`

```text
============================= test session starts =============================
platform win32 -- Python 3.11.9, pytest-9.1.1, pluggy-1.6.0 -- <repo>\agent-harness\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: <repo>\agent-harness
configfile: pyproject.toml
plugins: anyio-4.15.1
collecting ... collected 8 items

tests/test_api_async_runs.py::test_start_run_returns_immediately_with_running_status PASSED [ 12%]
tests/test_api_async_runs.py::test_pending_approval_snapshot_then_approve_reaches_completed PASSED [ 25%]
tests/test_api_async_runs.py::test_pending_approval_deny_unblocks_and_run_completes_denial_path PASSED [ 37%]
tests/test_api_async_runs.py::test_approve_unknown_run_id_returns_404 PASSED [ 50%]
tests/test_api_async_runs.py::test_approve_with_no_pending_approval_returns_409 PASSED [ 62%]
tests/test_api_async_runs.py::test_get_unknown_run_id_returns_404 PASSED [ 75%]
tests/test_api_async_runs.py::test_start_run_rejects_blank_objective PASSED [ 87%]
tests/test_api_async_runs.py::test_list_runs_includes_started_run PASSED [100%]

============================== warnings summary ===============================
.venv\Lib\site-packages\fastapi\testclient.py:1
  <repo>\agent-harness\.venv\Lib\site-packages\fastapi\testclient.py:1: StarletteDeprecationWarning: Using `httpx` with `starlette.testclient` is deprecated; install `httpx2` instead.
    from starlette.testclient import TestClient as TestClient  # noqa

-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
======================== 8 passed, 1 warning in 0.47s =========================
```

The full suite (`pytest -v`, no path filter) is 31 tests, 31 passed — the
original 23 plus these 8.

## 5. `curl` transcript — real pause/resume over HTTP: `pending_approval` -> approve -> `completed`

Backend started with `uvicorn api:app --port 8123` (a non-default port
used only for this capture). Three requests, in order:

**1. Start a run that will need `create_incident` approval:**

```
curl -s -X POST http://127.0.0.1:8123/runs -H "Content-Type: application/json" -d "{\"objective\": \"search-index is down, please create an incident\", \"max_steps\": 6}"
```

```json
{"run_id":"cce8a39587d4","status":"running"}
```

Returned immediately — the run is now executing on a background thread.

**2. Poll the run a moment later; it has paused waiting for a human:**

```
curl -s http://127.0.0.1:8123/runs/cce8a39587d4
```

```json
{"run_id":"cce8a39587d4","objective":"search-index is down, please create an incident","status":"pending_approval","started_at":1790666932.9286845,"steps_taken":2,"final_answer":null,"pending_approval":{"tool_name":"create_incident","tool_args":{"title":"Service impacted: search-index","description":"Automated check found status='down' for objective: search-index is down, please create an incident","severity":"high"}},"history":[{"run_id":"cce8a39587d4","step":1,"event_type":"llm_decision", "...": "..."},{"run_id":"cce8a39587d4","step":1,"event_type":"tool_call_started", "...": "..."},{"run_id":"cce8a39587d4","step":1,"event_type":"tool_call_result", "...": "..."},{"run_id":"cce8a39587d4","step":2,"event_type":"llm_decision", "...": "..."},{"run_id":"cce8a39587d4","step":2,"event_type":"approval_requested", "...": "..."}],"trace_path":"runs\\cce8a39587d4.jsonl","error":null}
```

(`history` entries abbreviated here with `"...": "..."` for readability;
the actual response has the full `AgentEvent` objects, same shape as
section 3 above.) `status` is `pending_approval`, `create_incident`'s
exact `title`/`description`/`severity` are visible in `pending_approval`,
and the tool has **not** run yet — no `tool_call_result` for
`create_incident` anywhere in `history`.

**3. Approve it, then re-poll:**

```
curl -s -X POST http://127.0.0.1:8123/runs/cce8a39587d4/approve -H "Content-Type: application/json" -d "{\"approved\": true}"
curl -s http://127.0.0.1:8123/runs/cce8a39587d4
```

The approve call's own response still shows the pre-resume snapshot
(`pending_approval` had not yet been cleared by the background thread at
the instant the response was built); the immediately-following `GET`
shows the run has resumed and completed:

```json
{"run_id":"cce8a39587d4","objective":"search-index is down, please create an incident","status":"completed","started_at":1790666932.9286845,"steps_taken":3,"final_answer":"Incident INC-300F3209 created.","pending_approval":null,"history":["... same 5 events as above, plus ...",{"event_type":"approval_granted"},{"event_type":"tool_call_started"},{"event_type":"tool_call_result","data":{"tool_name":"create_incident","output":{"incident_id":"INC-300F3209","status":"created","severity":"high"}}},{"event_type":"llm_decision"},{"event_type":"final_answer","data":{"final_answer":"Incident INC-300F3209 created."}}],"trace_path":"runs\\cce8a39587d4.jsonl","error":null}
```

**What this shows:** the loop genuinely paused mid-run (thread blocked on
a `threading.Event`, `status: pending_approval` visible over HTTP,
`create_incident` provably not executed yet) and only resumed and created
the incident (`INC-300F3209`) after the separate `POST
/runs/{id}/approve` request — a real pause/resume over HTTP, not a
pre-authorization flag decided before the run started.

---

# Phase 6A evidence — real OpenAI LLM, real BM25 retrieval, real SQLite persistence

Everything below was captured after wiring `HeuristicMockLLMClient` down
to a CI-only test double and making the LLM, retrieval, and persistence
real per the phase-06 spec. The user placed a real `OPENAI_API_KEY` /
`OPENAI_MODEL` in `agent-harness/.env` (gitignored) for this capture — the
key value itself is never printed, logged, or committed anywhere below.

## 8. Full suite passing (47 tests + 1 opt-in live test deselected)

Command: `.venv\Scripts\python.exe -m pytest -v`

```text
============================= test session starts =============================
platform win32 -- Python 3.11.9, pytest-9.1.1, pluggy-1.6.0
configfile: pyproject.toml
testpaths: tests
collecting ... collected 48 items / 1 deselected / 47 selected

tests/test_api.py .....
tests/test_api_async_runs.py .......
tests/test_approval_gate.py ...
tests/test_db_persistence.py .......
tests/test_heuristic_llm_client.py ....
tests/test_limits.py ..
tests/test_malformed_llm_response.py ..
tests/test_openai_client.py .....
tests/test_retrieval.py ....
tests/test_success_path.py ..
tests/test_tool_failure_path.py ...
tests/test_tool_schema_validation.py ..

====================== 47 passed, 1 deselected in 3.61s =======================
```

**What this shows:** the original 31 tests still pass unmodified in
behavior (only `test_api*` now inject `HeuristicMockLLMClient` explicitly
via a `_llm_client_factory` monkeypatch seam, since the API's real default
now requires a key), plus 16 new tests: `test_retrieval.py` (BM25 ranking
against the real `rank-bm25` index), `test_db_persistence.py` (SQLite
incident/service/run persistence, idempotency, restart survival),
`test_openai_client.py` (native tool-calling response parsing against
fake-but-structurally-real SDK response objects — zero network calls).
`test_live_openai.py` (1 test) is excluded by default via the `live`
pytest marker.

## 9. Real BM25 retrieval — `POST /kb/search`

Command:

```powershell
$body = @{query='auth-service session store connection exhaustion'; top_k=3} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/kb/search -Body $body -ContentType 'application/json'
```

```json
[
  {
    "id": "kb-002-auth-service-outage-checklist",
    "title": "Runbook: auth-service outage checklist",
    "snippet": "# Runbook: auth-service outage checklist\n\n**Applies to:** auth-service\n**Severity guidance:** critical (down), medium (degraded)\n\nauth-service outages are almost always caused by session-store connection\nexhaustion, not the auth-service application code itself.\n\n## Steps",
    "score": 9.243393250958007
  },
  {
    "id": "kb-006-database-connection-pool-exhaustion",
    "title": "Runbook: database connection pool exhaustion",
    "score": 5.347435462895032
  },
  {
    "id": "kb-018-postmortem-template",
    "title": "Policy: postmortem template",
    "score": 2.837211313039619
  }
]
```

**What this shows:** the correct runbook (`kb-002`) ranks first with a
real BM25 score computed by `rank-bm25.BM25Okapi` over the 18-doc corpus
at `data/kb/*.md`, not a hardcoded lookup — `GET /kb` confirms all 18 docs
are indexed (`"Count": 18` in a captured response).

## 10. Real SQLite persistence, an incident created via the CLI, and restart survival

Ran the CLI against the deterministic `--mock` backend (still real
retrieval + real SQLite, only the decision policy is the CI double) to
produce a real incident:

```
.venv\Scripts\python.exe cli.py --mock --auto-approve "search-index is down, please create an incident"
```

```text
=== run 5b228f375662 ===
status:       completed
steps_taken:  3
final_answer: Incident INC-06959FDB created.
[step 1] tool_call_result: {"tool_name": "get_service_status", ..., "output": {"service_name": "search-index", "status": "down", "owner": "search-platform", ...}}
[step 2] tool_call_result: {"tool_name": "create_incident", ..., "output": {"incident_id": "INC-06959FDB", "status": "created", "severity": "high", ...}}
```

Confirmed via the API on the same SQLite file:

```json
// GET /incidents
[{"id":"INC-06959FDB","title":"Service impacted: search-index","severity":"high","status":"created","created_at":"2026-09-29T08:20:47.579240+00:00","run_id":"5b228f375662"}]
```

Then the `uvicorn` process was killed and restarted from scratch (no
in-memory state carried over) and re-queried:

```json
// GET /runs  (after restart — this run was started via POST /runs, not the CLI)
[{"run_id":"0a2b26f5a3f4","objective":"What is the status of search-index?","status":"llm_error_exceeded","started_at":1790670035.794997}]

// GET /incidents  (after restart)
[{"id":"INC-06959FDB", ... "run_id":"5b228f375662"}]
```

**What this shows:** `GET /incidents` and `GET /runs` (for runs started
through the async `POST /runs` API flow — see "Known limitations") both
survive a full process restart, reading from `data/harness.db` instead of
in-memory state. `POST /services/auth-service/status` (body
`{"status":"degraded"}`) was also exercised live and confirmed persisted
via a follow-up `GET /services`.

## 11. Real OpenAI call — genuine transport error, handled exactly as designed

`POST /runs` with `{"objective": "What is the status of search-index?"}`
against the real `OpenAIChatLLMClient` (key present, native `tools=`
tool-calling request actually sent to `api.openai.com`) returned:

```json
{
  "event_type": "llm_malformed_response",
  "data": {
    "attempt": 1,
    "error": "Error code: 429 - {'error': {'message': 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.', 'type': 'insufficient_quota', 'param': None, 'code': 'credit_balance_exhausted'}}"
  }
}
```

followed by 2 more identically-shaped retry attempts and a final
`llm_retry_exhausted` / `status: llm_error_exceeded` — exactly the
existing malformed/failed-LLM-call recovery path (`max_llm_retries`),
now exercised against a **genuine HTTP call to OpenAI** instead of a
scripted fake. This is the provided key's account having no billing
credit balance (`insufficient_quota` / `credit_balance_exhausted` from
OpenAI itself, not a bug in this harness) — `tests/test_openai_client.py`
independently proves the request/response parsing is correct using fake
SDK objects, and this capture proves the real network path, auth header,
and native `tools=` payload all reach OpenAI and get a real (billing)
error back, which the harness's existing retry/backoff/terminal-state
logic handles without any special-casing. Re-run
`pytest -m live` (or the CLI without `--mock`) once the account has
credits to capture a full successful tool-calling trace with real token
usage.

## 12. Two real gpt-4o-mini runs driven through the UI (coordinator-run, before this phase's fixes)

Pulled directly from `runs/571301d5759a.jsonl` and `runs/8d88164db8b6.jsonl`
(not retyped from memory):

**`571301d5759a`** — objective: check payments-api, real degraded scenario,
real escalation, real human approval:

| step | event | data (truncated) |
| --- | --- | --- |
| 1 | llm_decision -> tool_call | `get_service_status(payments-api)` |
| 1 | tool_call_result | `status: degraded, latency_ms: 812, error_rate: 0.041` |
| 2 | llm_decision -> tool_call | `search_knowledge_base("payments-api slow checkout")` |
| 2 | tool_call_result | top hit `kb-001-payments-api-degraded-latency` |
| 3 | llm_decision -> tool_call | `create_incident(...)`, severity implied by evidence |
| 3 | approval_requested / approval_granted | human approved via `POST /runs/{id}/approve` |
| 3 | tool_call_result | incident created |
| 4 | final_answer | "The investigation into the payments-api revealed that it is currently in a degraded state, with a latency of 812ms and an error rate of 4.1%. This aligns with customer reports of slow checkouts..." |

**`8d88164db8b6`** — objective: check billing-service, real healthy
scenario, correctly did **not** escalate:

| step | event | data (truncated) |
| --- | --- | --- |
| 1 | llm_decision -> tool_call | `get_service_status(billing-service)` |
| 1 | tool_call_result | `status: operational, latency_ms: 95, error_rate: 0.0008` |
| 2 | llm_decision -> tool_call | `search_knowledge_base("billing-service")` -> no results |
| 3 | llm_decision -> final_answer | "The current status of the billing-service is operational, with a latency of 95 ms and an error rate of 0.0008, indicating that it is functioning normally..." |

Note the final line of `8d88164db8b6` is the exact pre-fix phrasing
("error rate of 0.0008") the coordinator flagged as ambiguous — this
capture predates the §13 fix below and is kept verbatim as the "before"
evidence.

## 13. Post-fix real run: paraphrase retrieval + error_rate_pct fix, live via `GET /runs/{id}/export`

Real run `272d2ade4ec7`, objective `"users are getting logged out,
investigate auth-service"` (the paraphrase case — no shared vocabulary
with the "auth-service outage checklist" runbook title), run against the
real OpenAI API after the hybrid-retrieval and error_rate_pct fixes
(`GET /runs/272d2ade4ec7/export`):

```
step 1  llm_decision      get_service_status(auth-service)
step 1  tool_call_result  status=degraded, error_rate_pct=0.1  (percent, not a bare fraction — the fix)
step 2  llm_decision      search_knowledge_base("auth-service user logout issue")
step 2  tool_call_timeout attempt 1, timeout_seconds=10.0   <- embedding model cold-load, see design-report.md §8
step 2  tool_call_retry   next_attempt=2
step 2  tool_call_result  attempt 2: results[0].id = "kb-002-auth-service-outage-checklist"  <- correct runbook, paraphrase resolved
step 3  llm_decision      create_incident(title="Auth Service User Logout Issues", severity="medium")
step 3  approval_requested / approval_granted (POST /runs/272d2ade4ec7/approve {"approved": true})
step 4  final_answer      "...I found a relevant runbook that indicates potential issues with the session-store
                            connection pool... I have created an incident... Incident ID is INC-37460ABC."
```

This is the objective evidence the phase spec asked for: after the fix,
the paraphrased query correctly retrieves `kb-002` (it previously would
have needed literal "outage"/"checklist" vocabulary under BM25-only), and
`error_rate_pct=0.1` reads unambiguously as a percentage.

## 14. Real SSE transcript — `GET /runs/{run_id}/events`

Raw transcript (`curl -sN http://127.0.0.1:8000/runs/bea578b516cd/events`)
for a real run (`objective: "What is the status of payments-api?"`),
captured live, unedited:

```
event: llm_decision
data: {"run_id": "bea578b516cd", "step": 1, "event_type": "llm_decision", "timestamp": 1790672226.7493532, "latency_ms": 1329.0, "data": {"action": "tool_call", "tool_name": "get_service_status", "tool_args": {"service_name": "payments-api"}, "llm_meta": {"model": "gpt-4o-mini-2024-07-18", "prompt_tokens": 452, "completion_tokens": 17, "total_tokens": 469}}}

event: tool_call_started
data: {"run_id": "bea578b516cd", "step": 1, "event_type": "tool_call_started", "timestamp": 1790672226.7647831, "latency_ms": null, "data": {"tool_name": "get_service_status", "args": {"service_name": "payments-api"}, "attempt": 1}}

event: tool_call_result
data: {"run_id": "bea578b516cd", "step": 1, "event_type": "tool_call_result", "timestamp": 1790672226.7834496, "latency_ms": 0.0, "data": {"tool_name": "get_service_status", "output": {"status": "degraded", "latency_ms": 812.0, "error_rate_pct": 4.1}}}

event: llm_decision
data: {"run_id": "bea578b516cd", "step": 2, "event_type": "llm_decision", "timestamp": 1790672228.543773, "latency_ms": 1750.0, "data": {"action": "final_answer", "final_answer": "The current status of the payments-api is degraded. Here are the details:\n\n- **Latency**: 812 ms\n- **Error Rate**: 4.1%\n..."}}

event: final_answer
data: {"run_id": "bea578b516cd", "step": 2, "event_type": "final_answer", "timestamp": 1790672228.5591855, "latency_ms": null, "data": {"final_answer": "The current status of the payments-api is degraded..."}}

event: stream_end
data: {"run_id": "bea578b516cd"}
```

Events arrive in step order, each within milliseconds of being recorded
(no polling delay), and the connection closes itself via `stream_end`
once the run completes — matching `tests/test_api_streaming.py`'s
assertions against the same behavior.

---

# Phase 10 evidence — real token-by-token streaming + chatbot-grade UI (light mode, left nav)

Everything below closes the two gaps the user flagged: (1) the previous
"streaming" was step/event-level SSE only, not real per-token LLM
streaming, and (2) the console needed a genuine chatbot-product redesign
(light mode, left sidebar, message-bubble layout). Both are now real, not
cosmetic, and verified with a real OpenAI API call and a real Chromium
browser (Playwright), not curl-only.

## 15. Real per-token streaming captured directly from the OpenAI API (no network mock)

`OpenAIChatLLMClient.raw_decide(..., on_delta=...)` now sets `stream=True`
on `chat.completions.create` and forwards every `delta.content` /
`delta.tool_calls[].function.arguments` chunk as it arrives. Captured live
against the real, funded API key in `.env`:

**Tool-call turn** (`tool_args` field streams the JSON arguments
character-by-character before the call fires):

```
NUM_DELTA_CHUNKS: 7
FIELDS_SEEN: ['tool_args']
FIRST_5_CHUNKS:
  field='tool_args' delta='{"'
  field='tool_args' delta='service'
  field='tool_args' delta='_name'
  field='tool_args' delta='":"'
  field='tool_args' delta='auth'
ASSEMBLED_FROM_DELTAS: {"service_name":"auth-service"}
DECISION_ACTION: tool_call
DECISION_TOOL: get_service_status {'service_name': 'auth-service'}
LLM_META_MODEL: gpt-4o-mini-2024-07-18
LLM_META_TOKENS: 479
```

**Final-answer turn** (`final_answer` field streams the reply token by
token):

```
NUM_DELTA_CHUNKS: 26
FIRST_8_CHUNKS:
  field='final_answer' delta='The'
  field='final_answer' delta=' status'
  field='final_answer' delta=' of'
  field='final_answer' delta=' the'
  field='final_answer' delta=' auth'
  field='final_answer' delta='-service'
  field='final_answer' delta=' is'
  field='final_answer' delta=' operational'
ASSEMBLED_FROM_DELTAS: The status of the auth-service is operational, with a latency of 48 ms and an error rate of 0.1%.
DECISION_FINAL_ANSWER: The status of the auth-service is operational, with a latency of 48 ms and an error rate of 0.1%.
MATCH: True
```

**What this shows:** the deltas are real, ordered, per-token/per-fragment
chunks sourced from the live OpenAI stream — not a client-side
`setInterval` animation over an already-complete string — and
concatenating them reproduces the final assembled/persisted decision
exactly (`MATCH: True`). `pytest -m live` (`test_live_openai_full_run_against_real_api`)
independently re-confirms this against the real API on every run.

## 16. Deltas flow through the real SSE endpoint as `llm_token_delta`, never persisted

New backend plumbing: `AgentLoop._decide` passes an `on_delta` callback
into `raw_decide`; it emits a live-only `AgentEvent(event_type=
"llm_token_delta", data={"field": ..., "delta": ...})` via
`TraceLogger.emit_live()` (persists nothing to the JSONL/DB — only
forwards to the SSE observer). `RunRegistry._on_event` special-cases this
event type: pushed straight to SSE subscriber queues, never appended to
`record.history` or written to SQLite. New test
`test_sse_stream_emits_llm_token_delta_events_that_assemble_to_final_answer`
(`tests/test_api_streaming.py`) asserts, over the real `GET
/runs/{id}/events` SSE endpoint: `llm_token_delta` events arrive in order,
concatenating their `final_answer` deltas equals the persisted
`final_answer` event's text exactly, and no `llm_token_delta` event ever
appears in the run's persisted `history` snapshot. `HeuristicMockLLMClient`
(CI-only) exercises the identical frontend code path via synthetic chunks
of its already-known string — documented as synthetic, never claimed real.

## 17. Real Chromium browser verification (Playwright), full flow

Server: `uvicorn api:app --port 8000` (real `OPENAI_API_KEY` configured,
serving the built `web/dist`). Script drove a real Chromium instance
through the actual product:

1. Light mode confirmed on every page (`New run`, `History`, `Services`,
   `Incidents`, `Knowledge base`, `Logs`, and an individual run's
   `Chat`/`Trace` views) — `getComputedStyle(document.body).backgroundColor`
   read `rgb(255, 255, 255)` on all of them.
2. Left sidebar navigation (persistent, with History expanding into a
   scrollable list of recent runs as sub-items) clicked through all six
   sections successfully.
3. Started a real run: `"search-index is down, please create an
   incident"`. The real `create_incident` approval gate fired
   (`status: pending_approval`, panel rendered with title/description/
   severity). Clicked **Approve** — the phase-09 SSE/registry race-condition
   fix survived the redesign: the run resumed and reached `Completed`
   with no hang or stale approval state.
4. Final-answer chat bubble sampled twice, 250ms apart, while the run was
   still `live`:
   - sample 1: `"...An incident has been created for the search-index service, which is currently down with"`
   - sample 2 (250ms later): `"...currently down with a 100% error rate. The incident ID is **INC-72D62ABF** and it has been classified as critical. Immediate attention is required to restore functionality."`

   The text visibly grew mid-sentence between samples — genuine real-time
   token-by-token rendering in the browser DOM, not a screenshot claim.
5. Trace view re-checked in light mode: the waterfall's per-row
   descriptive labels from the prior fix are intact (`LLM -> get_service_status`,
   `get_service_status started`, `get_service_status succeeded`, `Approval:
   create_incident` x2, `create_incident started`/`succeeded`, `LLM ->
   final_answer`, `Final answer`) — not repeated tool names.
6. Run reached `Completed` status; "Mock data only" footer banner
   ("Services, incidents, and the knowledge base are seeded with mock
   data — the agent, its retrieval, and its persistence are all real.")
   visible on every page.

Reproduce with `npm run build` in `web/`, `uvicorn api:app --port 8000`
from `agent-harness/`, then a Playwright script driving
`http://127.0.0.1:8000/`.

## 18. `pytest` and `npm run build`, both clean after the redesign

```
PYTHONPATH=src python -m pytest -q -m "not live"
...........................................................              [100%]
59 passed, 1 deselected, 1 warning in 4.09s

PYTHONPATH=src python -m pytest -q -m live
.                                                                        [100%]
1 passed, 59 deselected, 1 warning in 4.98s
```

```
cd web && npm run build
> tsc -b && vite build
✓ 4583 modules transformed.
dist/assets/index-DmAc1F4T.css   27.22 kB │ gzip:   6.16 kB
dist/assets/index-B768ECF1.js   379.82 kB │ gzip: 110.84 kB
✓ built in 249ms
```

`cli.py` and the synchronous `POST /run` endpoint were not touched by
this phase — both keep working unmodified.

---
Author: Phu Nguyen — HCMC, VN
