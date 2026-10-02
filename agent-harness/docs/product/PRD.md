# Agent Harness — Product Requirements Document (v2)

**Author:** Nguyen Quang Phu — HCMC, VN
**Status:** Approved for build (2026-09-29)
**Context:** Part 1 of the original brief (required). v1 (custom
loop, OpenAI SDK direct, SQLite, SSE) is built, tested (59/59), and verified
live. This PRD defines v2: a real agent framework, real observability/eval
tooling, real relational persistence, and an operator platform UI around the
harness — everything except the input data (knowledge-base docs, service
seed data) stays real.

## 1. Problem & goal

The original brief asks for an "Agent Harness for an operations assistant": an
LLM-tool execution loop with state, validation, safety controls, and tests.
v1 satisfies that literally. v2's goal is to demonstrate how a senior AI
engineer would actually ship this as a small internal platform an ops team
could run day one — meaning the scaffolding around the agent (observability,
session continuity, prompt governance, guardrails) is treated as
first-class, not an afterthought, while staying honest that the underlying
data (KB corpus, service registry) is mock.

## 2. Users

- **Primary:** an on-call/ops engineer who types an objective and either
  watches the agent investigate, or gets asked to approve a risky action.
- **Secondary:** a reviewer, who needs to understand the design
  and verify it works without necessarily running it themselves.

## 3. Baseline requirements (verbatim from the test — must never regress)

- Accept a user objective via API or CLI.
- LLM-tool execution loop.
- Validate tool inputs and outputs.
- Maintain agent state and execution history.
- Handle tool errors, timeouts, retries, malformed LLM responses.
- Prevent infinite loops (step and time limits).
- Require user approval before `create_incident`.
- Produce logs/traces per execution.
- Tests for success, tool failure, approval, and limit-exceeded paths.

## 4. v2 scope

### 4.1 Agent framework: Pydantic AI

Decision (user-confirmed, tradeoff discussed): **Pydantic AI**, not
LangGraph/LangChain. Rationale: the codebase is already pydantic-first (tool
I/O schemas, event models) — Pydantic AI's `Agent`/tool-calling model is the
closest-fit migration, keeps the harness's own state machine visible and
ownable (a reviewer sees *this team's* design for the loop/approval/limits,
not a framework's), and Pydantic AI ships first-class streaming and
structured-output validation that map directly onto the existing event
model. The approval gate and step/time limits remain hand-built on top of
Pydantic AI's `Agent.iter()` (node-by-node graph iteration) — Pydantic AI
does not own the interrupt/resume the way LangGraph would, so that part of
the harness stays exactly as demonstrably "we designed this" as before.

### 4.2 Observability: MLflow Tracing + GenAI eval

- Every agent run emits an MLflow trace (`@mlflow.trace` / autolog on the
  Pydantic AI model calls): spans for each LLM call and tool call, with
  inputs/outputs/latency/token usage, viewable in the MLflow UI (run
  locally via Docker, no cloud).
- `mlflow.genai.evaluate()` (or scorer functions) used to build a small
  regression eval suite over recorded transcripts (e.g. "did the agent
  correctly decline to escalate a healthy service", "did it use the right
  runbook") — a repeatable agent-quality gate, not just unit tests of code
  paths.
- This is in addition to, not a replacement for, the existing per-run JSONL
  trace + Logs page (operator-facing); MLflow is the engineering/eval-facing
  observability layer.

### 4.3 Persistence: PostgreSQL in Docker

- Replace SQLite with Postgres (via `docker compose`) for services,
  incidents, runs, events, chat sessions. Rationale: matches "real
  relational persistence an operator platform would use," supports
  concurrent access properly, and is the standard choice this stack would
  use in production.
- `docker compose up` brings up Postgres + MLflow tracking server +
  (optionally) the API; documented clearly so a grader can run it or just
  read the code.

### 4.4 Chatbot platform UI (left-nav tabs)

Sidebar sections, each backed by real behavior (data is mock, everything
else real):

| Tab | Behavior |
|---|---|
| **New chat** | Explicit "+ New chat" action creates a session; objective input is the chat composer. |
| **Sessions** (was History) | Every chat session persisted (Postgres), resumable; a session mid-run stays "live" and correctly shows as running/pending-approval if you refresh the page or open it in a new tab — polls/reconnects to the real run state, doesn't just replay a stale snapshot. |
| **Knowledge base** | Unchanged from v1: real hybrid BM25+embedding search over the mock runbook corpus. |
| **Integrations** | On/off toggles for each mock tool (search_knowledge_base, get_service_status, create_incident) — disabling one removes it from the LLM's available tool list for new runs, in real time. This is a real capability (the LLM genuinely can't call a disabled tool), not a cosmetic switch. |
| **Prompts** | Versioned system-prompt registry (stored, not hardcoded): create a new version, mark one active, a run records which prompt version it used. Real versioning, editable from the UI. |
| **Memory** | Per-session conversation memory (already implicit in message history) surfaced explicitly: what the agent "remembers" from earlier in the session, visible and inspectable. |
| **Guardrails** | Real, enforced input/output checks (e.g. block objectives containing certain patterns; validate `create_incident` severity is never silently upgraded past what the evidence supports) — configurable list, applied before/after LLM calls, logged when triggered. |
| **Automations** | Scheduled or trigger-based runs (e.g. "if a service flips to `down`, auto-start an investigation run") — a real, if simple, rule engine, not a mock. |
| **Artifacts (dashboards)** | Save a SQL query against the Postgres run/event/incident tables as a named dashboard tile; "Refresh" re-runs the stored query live. Real stored queries, real live data, not a static chart. |
| **Evals** | Surfaces the MLflow eval results (pass/fail per scorer, trend over runs) inside the app, not just in the external MLflow UI. |
| **Logs** | Unchanged: persisted run list, JSON export. |

### 4.5 Token tracking

Already present per-LLM-call (model, prompt/completion/total tokens); v2
surfaces a running total per session and per day in the UI, backed by the
same MLflow/Postgres data.

### 4.6 "Autocompact"

Long sessions (many turns) get their older tool-call history summarized
(via an LLM-generated summary turn) once history exceeds a token budget,
so the context sent to the model on later turns stays bounded — a real
context-management feature, not just a UI truncation.

## 5. Non-goals (explicitly out of scope, documented not built)

- Real external identity/authentication — superseded by v3 (§8): a local,
  header-based identity switcher (`X-User-Id`, trivially spoofable by
  design, documented honestly in the UI) resolves one of 4 seeded users,
  each with a real role (`admin`/`editor`/`viewer`). What v3 does **not**
  build is a real IdP/password/session-cookie login flow; the RBAC
  enforcement itself (role -> action matrix + ownership/visibility checks,
  server-side, on every mutating route) is real, not a UI-only affordance.
- Multi-tenant isolation.
- Real incident-management system integration (the tool stays mocked by the
  test's own design).
- Horizontal scaling / multi-instance run registry.

## 6. Success criteria

- All v1 baseline requirements still pass (tests + live verification).
- Pydantic AI migration: same safety properties (retries, timeouts, step/
  time limits, approval gate) proven via tests + a live browser run.
- MLflow traces visible for a real run; at least one eval scorer runs
  against recorded transcripts with a real pass/fail result.
- Postgres persistence survives a container restart.
- Every listed tab is genuinely functional, not a static mock screen.
- `docker compose up` (documented) brings the whole stack up.

## 7. Risks

- Framework migration risk to already-working code — mitigated by keeping
  the existing test suite as the regression gate and re-verifying every
  safety property live before calling it done.
- Scope size vs. the test's 72h submission window — accepted, user-directed.

## 8. v3 status (RBAC, agents & skills, dashboards, eval agent)

v3 deepened the platform from "every tab is functional" (v2) into
first-class, ownable entities with server-enforced RBAC. Status vs. this
PRD's v2 scope (§4) and the v3 plan's acceptance criteria:

| Area | Status | Notes |
|---|---|---|
| RBAC (identity switcher + role matrix) | **Done** | 4 seeded users (`u_admin`/`u_editor`/`u_editor2`/`u_viewer`); every mutating route requires an action permission (`agent_harness.rbac.PERMISSIONS`) + resource ownership/visibility check; a parametrized test enumerates every `POST`/`PATCH`/`DELETE` route from `app.routes` and asserts a viewer gets 403. UI hides/disables controls the current role can't use (server stays the real guard either way). |
| Prompts | **Done** (v2 scope, unchanged) | Versioned, one active per slug, RBAC-gated writes. |
| Skills | **Done** (new in v3) | Reusable capability: instructions + `allowed_tools` subset + description (routing signal). No code-plugin mechanism — skills only scope the existing 3 tools. |
| Agents | **Done** (new in v3) | Named entity binding a prompt (+ optional pinned version), a skill-routing mode (`none`/`assigned`/`auto`), and a base tool set. `assigned` mode scopes tools to the union of its skills' `allowed_tools`; `auto` mode runs a separate Pydantic AI router (`output_type=SkillSelection`) before the main loop and traces `skill_routed`; `/slug` slash commands force a skill server-side and trace `skill_invoked`. |
| Chat inspector | **Done** (new in v3) | Timeline/Tools/Reasoning/Context/Raw tabs over the same persisted event history; usable at 375px. |
| Dashboards | **Done** (new in v3) | 4 templates (`blank`/`ops-overview`/`agent-performance`/`incident-analytics`); widgets store a real SQL query, executed read-only (`sql_guard` + `READ ONLY` transaction + statement timeout + row cap) on Refresh; DML rejected at both the parser and transaction layer. |
| Eval agent (LLM-as-judge) | **Done** (new in v3) | One Pydantic AI judge call per run (`task_success`/`groundedness`/`tool_choice`/`safety_ok`/`routing_fit`) merged with deterministic metrics (`latency_ms`, `agent_latency_ms`, `total_tokens`, `steps`, `tool_errors`) into hybrid `tool_use_correctness`/`safety` scores; `judge_version` invalidates stale scores on rubric/model/prompt change. `latency_ms` is wall-clock (including human approval wait); `agent_latency_ms` subtracts every approval-wait span, so the Evals UI shows both, clearly labeled. |
| MLflow | **Done** (v2 scope, unchanged) | Per-run trace + eval-run logging when `MLFLOW_TRACKING_URI` is set. |
| Multi-tenant isolation, real IdP login, per-object ACLs | **Not built (by decision)** | See §5 non-goals; role+ownership/visibility was judged sufficient for 3 roles. |

---
Phu Nguyen — HCMC, VN
