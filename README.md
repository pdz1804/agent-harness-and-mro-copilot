# Agent Harness and Aircraft MRO Predictive Maintenance

This repository contains two systems that share one idea: put a strong control layer around a model, then make that layer visible in a real UI. **Agent Harness** is an LLM-to-tool execution loop for an operations assistant, with a human-approval gate, hard limits, structured traces and a full web console. **MRO Predictive Maintenance** predicts which aircraft components will need an unscheduled removal within 30 flight cycles, serves the model live, and adds an alert and work-order desk with a human-in-the-loop copilot. Everything is real and runnable except the *input data*: the agent works on a mock service registry and a mock runbook corpus, and the ML model trains on a seeded synthetic dataset. The LLM is a real OpenAI model with native tool calling, and the ML pipeline is real scikit-learn training and evaluation.

| Agent Harness (`agent-harness/`) | MRO Predictive Maintenance (`mro-predictive-maintenance/`) |
|---|---|
| ![Agent Harness: a run paused for approval](agent-harness/docs/images/chat-approval-1440.png) | ![MRO dashboard: control desk overview](mro-predictive-maintenance/docs/images/overview-1440.png) |
| A `create_dashboard` call waits for Approve or Deny. | The control desk: alerts, approvals and activity. |

**Video:** a 4:12 captioned [MRO product walkthrough](mro-predictive-maintenance/docs/videos/mro-walkthrough.mp4) covers every dashboard feature ([chapters](#video-walkthrough)).

**Contents**
[What was required](#what-was-required) ·
[Coverage](#coverage) ·
[Agent Harness](#agent-harness) ·
[MRO Predictive Maintenance](#mro-predictive-maintenance) ·
[How to run](#how-to-run) ·
[Known limitations](#known-limitations) ·
[Repo map and docs](#repo-map-and-docs)

---

## What was required

The original brief had two parts. Each requirement is numbered here so the coverage table below can refer to it.

**Part 1 - Agent Harness (required)**

| # | Requirement |
|---|---|
| R1 | Accept a user objective through an API or a CLI. |
| R2 | Run an LLM-to-tool loop in which the LLM chooses the next tool call or a final answer. |
| R3 | Provide three mock tools: `search_knowledge_base(query)`, `get_service_status(service_name)`, `create_incident(title, description, severity)`. |
| R4 | Validate tool inputs and outputs at schema level, not only with `try/except`. |
| R5 | Maintain agent state and a full execution history. |
| R6 | Handle tool errors, timeouts, retries and malformed LLM responses gracefully. |
| R7 | Prevent infinite loops with both a step limit and a wall-clock limit. |
| R8 | Require explicit human approval before any `create_incident` call executes. |
| R9 | Produce a structured log or trace for every run. |
| R10 | Include automated tests for the success path, the tool-failure path, the approval gate (approve and deny) and the step/time limits. |
| R11 | Document it: run instructions, design write-up (stack, flow), Postman collection, environment variables, limitations, future work. |

**Part 2 - Aircraft MRO unscheduled-removal prediction (senior track)**

| # | Requirement |
|---|---|
| R12 | Build a documented synthetic dataset: aircraft info, component usage, sensor readings, fault codes, maintenance history, removal labels, about 2% positives. |
| R13 | Compare at least two ML models. |
| R14 | Produce a risk score (probability) for each component observation. |
| R15 | Use a split that is both time-based and group-based, with no leakage. |
| R16 | Explain the main factors behind high-risk predictions. |
| R17 | Hit the operating point: detect at least 80% of removals while raising at most 5 alerts per 100 active components, with the threshold chosen on validation data. |
| R18 | Describe how the system handles new components (cold start), missing data and drift. |
| R19 | Write a report covering data prep, modeling, evaluation, deployment and monitoring, and limitations, backed by tests for determinism and leakage. |

---

## Coverage

Status values: **Done** (met as stated), **Partial** (met with a concrete shortfall, named in the table), **Not done**.

| # | Requirement | Status | Where | Evidence |
|---|---|---|---|---|
| R1 | Objective via API or CLI | Done | [`cli.py`](agent-harness/cli.py), [`api.py`](agent-harness/api.py) (`POST /run`, `POST /runs`) | [`tests/test_api.py`](agent-harness/tests/test_api.py), [CLI transcript](agent-harness/docs/demo-evidence.md) |
| R2 | LLM-to-tool loop | Done | [`src/agent_harness/loop.py`](agent-harness/src/agent_harness/loop.py) | [`tests/test_success_path.py`](agent-harness/tests/test_success_path.py), [run screenshot](agent-harness/docs/images/chat-completed-1440.png) |
| R3 | Three mock tools | Done | [`src/agent_harness/tools/`](agent-harness/src/agent_harness/tools) | [`tests/test_tool_failure_path.py`](agent-harness/tests/test_tool_failure_path.py), [services](agent-harness/docs/images/services-1440.png) and [incidents](agent-harness/docs/images/incidents-1440.png) pages |
| R4 | Schema validation of tool I/O | Done | pydantic `input_model` / `output_model` per tool ([`tools/base.py`](agent-harness/src/agent_harness/tools/base.py)) | [`tests/test_tool_schema_validation.py`](agent-harness/tests/test_tool_schema_validation.py) |
| R5 | State and full history | Done | `RunResult.history`, Postgres `runs` / `events` tables | [`tests/test_db_persistence.py`](agent-harness/tests/test_db_persistence.py), [session thread](agent-harness/docs/images/session-thread-1440.png) |
| R6 | Errors, timeouts, retries, malformed output | Done | [`loop.py`](agent-harness/src/agent_harness/loop.py), [`config.py`](agent-harness/src/agent_harness/config.py) | [`test_tool_failure_path.py`](agent-harness/tests/test_tool_failure_path.py), [`test_malformed_llm_response.py`](agent-harness/tests/test_malformed_llm_response.py) |
| R7 | Step limit and wall-clock limit | Done | `HarnessConfig` (`max_steps`, wall-clock budget) | [`tests/test_limits.py`](agent-harness/tests/test_limits.py), [timeout screenshot](agent-harness/docs/images/chat-timeout-1440.png) |
| R8 | Approval before `create_incident` | Done | `approval.py`, `run_registry.py`, approval bar in the web console | [`tests/test_approval_gate.py`](agent-harness/tests/test_approval_gate.py), [approval screenshot](agent-harness/docs/images/chat-approval-1440.png), [video](agent-harness/docs/images/video-run-approval-to-workspace.webm) |
| R9 | Structured trace per run | Done | `runs/<run_id>.jsonl`, Postgres `events`, MLflow spans | [trace format](agent-harness/README.md#trace-format), [inspector](agent-harness/docs/images/chat-inspector-1440.png) |
| R10 | Automated tests for the four scenarios | Done | [`agent-harness/tests/`](agent-harness/tests) | 669 backend tests pass, see [How to run](#run-the-tests) |
| R11 | Run instructions, design doc, Postman, env vars, limitations, future work | Done | [README](agent-harness/README.md), [design report](agent-harness/docs/design-report.md) (sections 4, 5, 6, 7), [Postman collection](agent-harness/postman/agent-harness.postman_collection.json), [`.env.example`](agent-harness/.env.example) | the files themselves |
| R12 | Synthetic dataset, ~2% positives | **Partial** | [`data/generate_dataset.py`](mro-predictive-maintenance/data/generate_dataset.py), [`data/raw/`](mro-predictive-maintenance/data/raw) | [`tests/test_dataset_generation.py`](mro-predictive-maintenance/tests/test_dataset_generation.py). All required tables exist and generation is seeded and deterministic. The label rate is **2.9%** of observation rows (777 positives), above the ~2% target. |
| R13 | At least two models | Done | `src/modeling.py`: logistic regression and gradient boosting | [metrics table](mro-predictive-maintenance/reports/metrics_table.md), [performance page](mro-predictive-maintenance/docs/images/model-performance-1440.png) |
| R14 | Risk score per observation | Done | `POST /score` in [`src/service/app.py`](mro-predictive-maintenance/src/service/app.py) | [`tests/test_service.py`](mro-predictive-maintenance/tests/test_service.py), [what-if page](mro-predictive-maintenance/docs/images/what-if-scenario-1440.png) |
| R15 | Time and group split, no leakage | Done | [`src/splitting.py`](mro-predictive-maintenance/src/splitting.py) | [`test_splitting_leakage.py`](mro-predictive-maintenance/tests/test_splitting_leakage.py), [`test_no_target_leakage.py`](mro-predictive-maintenance/tests/test_no_target_leakage.py) |
| R16 | Explain high-risk predictions | Done | permutation importance and SHAP in [`src/explainability.py`](mro-predictive-maintenance/src/explainability.py) | [explainability page](mro-predictive-maintenance/docs/images/model-explainability-1440.png), [`reports/high_risk_examples.md`](mro-predictive-maintenance/reports/high_risk_examples.md) |
| R17 | Recall >= 80% at <= 5 alerts per 100 | Done | threshold chosen on validation, [`src/evaluation.py`](mro-predictive-maintenance/src/evaluation.py) | [`reports/model_card.json`](mro-predictive-maintenance/reports/model_card.json): test recall 82.1% (23 of 28), 0.91 alerts per 100 rows, 0 false positives. The live fleet scan raises 15 alerts over 312 components (4.8 per 100). The 28 test positives make the recall estimate wide (95% interval about 0.64 to 0.92). |
| R18 | Cold start, missing data, drift | Done | [design report section 6.1](mro-predictive-maintenance/docs/design-report.md); drift monitor in `src/monitoring.py` | [`tests/test_monitoring.py`](mro-predictive-maintenance/tests/test_monitoring.py), [drift page](mro-predictive-maintenance/docs/images/monitoring-drift-1440.png) |
| R19 | Report and tests | Done | [design report](mro-predictive-maintenance/docs/design-report.md) | [captured run output](mro-predictive-maintenance/docs/demo-evidence.md), 232 backend tests pass |

**Overall coverage: 18.5 of 19 = 97%.** Each requirement has weight 1. Done counts 1, Partial counts 0.5, Not done counts 0. There are 18 Done rows and 1 Partial row (R12): 18 x 1 + 1 x 0.5 = 18.5, and 18.5 / 19 = 97.4%. The figure measures the numbered requirements above. It is not a measure of product polish, so the design-match scores and the open gaps are listed separately under [Known limitations](#known-limitations).

### Beyond the brief

These were built because they make the two systems usable as products. None of them is counted in the percentage above.

| Area | Extra | Evidence |
|---|---|---|
| Agent Harness | Postgres persistence with Alembic migrations, resumable sessions, Server-Sent Events streaming | [sessions](agent-harness/docs/images/sessions-1440.png) |
| Agent Harness | Role-based access (admin, editor, viewer) enforced on every mutating route | [`tests/test_rbac.py`](agent-harness/tests/test_rbac.py), [viewer view](agent-harness/docs/images/viewer-agents-1440.png) |
| Agent Harness | Named agents, reusable skills, automatic skill routing with a routing tester | [routing tester](agent-harness/docs/images/skills-routing-tester-1440.png) |
| Agent Harness | Versioned prompt library with verification, diff and a playground | [prompt diff](agent-harness/docs/images/prompt-version-diff-1440.png) |
| Agent Harness | Guardrails (input patterns, severity downgrade) with a sandbox | [guardrails sandbox](agent-harness/docs/images/guardrails-sandbox-1440.png) |
| Agent Harness | Dashboards of read-only SQL widgets, created by hand or by the agent behind an approval card | [dashboard](agent-harness/docs/images/dashboard-detail-1440.png) |
| Agent Harness | LLM-as-judge eval agent, MLflow tracing, recorded-transcript regression eval | [evals](agent-harness/docs/images/evals-run-detail-1440.png) |
| Agent Harness | Hybrid retrieval (BM25 plus dense embeddings), knowledge-base management, retrieval playground | [playground](agent-harness/docs/images/kb-playground-1440.png) |
| Agent Harness | Event-driven automations, memory page, chat inspector, workspace panel | [workspace](agent-harness/docs/images/chat-workspace-1440.png) |
| MRO | Live scoring service and a dashboard (overview, fleet, component and alert pages, work orders, copilot, model, monitoring, what-if, about) | [overview](mro-predictive-maintenance/docs/images/overview-1440.png) |
| MRO | Alert and work-order lifecycle with Undo, bulk actions and CSV export | [alert lifecycle](mro-predictive-maintenance/docs/images/alert-wo-raised-lifecycle-1440.png) |
| MRO | Human-in-the-loop maintenance copilot: write actions pause for approval | [approved tool call](mro-predictive-maintenance/docs/images/copilot-approved-tool-call-1440.png), [video](mro-predictive-maintenance/docs/images/flow-copilot-raise-work-order-approval.webm) |
| MRO | A harder "realistic" profile, calibration, rule baselines, drift monitor, retrain gate with MLflow registry | [design report section 8](mro-predictive-maintenance/docs/design-report.md) |
| MRO | What-if sandbox with shareable scenario links | [what-if](mro-predictive-maintenance/docs/images/what-if-scenario-1440.png) |
| MRO | Read-only viewer role enforced by the API (403) and mirrored in the UI | [`tests/test_ops_api.py`](mro-predictive-maintenance/tests/test_ops_api.py), [viewer view](mro-predictive-maintenance/docs/images/viewer-read-only-alert-1440.png) |

---

## Agent Harness

**What it is.** A harness around an LLM that drives three tools (`search_knowledge_base`, `get_service_status`, `create_incident`) through a validated, limited, fully traced loop, and pauses for a human whenever a sensitive tool is proposed. It grew into a small internal platform: a FastAPI backend and a React/TypeScript console with sessions, agents, skills, prompts, guardrails, dashboards and evals.

**Architecture**

```mermaid
flowchart TB
    UI["React + TypeScript console (web/)"] -->|"X-User-Id header, REST + SSE"| API["FastAPI api.py (/api/v1)"]
    API --> RBAC["rbac.py: role x action + ownership"]
    API --> RT["agent_runtime.py: agent -> prompt, skills, tools"]
    RT --> LOOP["loop.py: Pydantic AI Agent.iter() state machine"]
    LOOP -->|validated args| TOOLS["tools/: search_knowledge_base, get_service_status,<br/>create_incident, dashboard and memory tools"]
    LOOP -->|"approval gate"| APPR["approval.py + run_registry.py<br/>pause and resume"]
    TOOLS --> RET["retrieval.py: BM25 + dense (hybrid)"]
    TOOLS --> PG[("Postgres :5433")]
    LOOP -->|events| PG
    LOOP -->|spans| ML["MLflow :5001"]
    LOOP <--> LLM(["OpenAI, native tool calling"])
    EVAL["eval/: LLM judge + metrics"] --> PG
    EVAL --> ML
```

**Key features**

| Run paused for approval | Completed session | Inspector timeline |
|---|---|---|
| ![Approval bar](agent-harness/docs/images/chat-approval-1440.png) | ![Session thread](agent-harness/docs/images/session-thread-1440.png) | ![Inspector](agent-harness/docs/images/chat-inspector-1440.png) |
| Approve or Deny (keys A / D); the run resumes from the same state. | Answer, feedback, token and latency metrics. | Per-step events with filters. |

| Workspace panel | Retrieval playground | Guardrails sandbox |
|---|---|---|
| ![Workspace](agent-harness/docs/images/chat-workspace-1440.png) | ![KB playground](agent-harness/docs/images/kb-playground-1440.png) | ![Guardrails sandbox](agent-harness/docs/images/guardrails-sandbox-1440.png) |
| A dashboard the agent built, previewed live. | BM25, vector and fused scores per chunk. | Shows which rule fires on a test input. |

| Skill routing tester | Eval run detail | Phone (390 px) |
|---|---|---|
| ![Routing tester](agent-harness/docs/images/skills-routing-tester-1440.png) | ![Eval run](agent-harness/docs/images/evals-run-detail-1440.png) | ![Phone approval](agent-harness/docs/images/chat-approval-390.png) |
| Which skill the router would pick, and why. | LLM-judge scores per run. | The approval bar uses full-width buttons. |

Other pages: [Sessions](agent-harness/docs/images/sessions-1440.png), [Memory](agent-harness/docs/images/memory-1440.png), [Services](agent-harness/docs/images/services-1440.png), [Incidents](agent-harness/docs/images/incidents-1440.png), [Knowledge base](agent-harness/docs/images/knowledge-1440.png), [Integrations](agent-harness/docs/images/integrations-1440.png), [Automations](agent-harness/docs/images/automations-1440.png), [Agents](agent-harness/docs/images/agents-1440.png), [Skills](agent-harness/docs/images/skills-1440.png), [Prompts](agent-harness/docs/images/prompts-1440.png), [Dashboards](agent-harness/docs/images/dashboards-1440.png), [Evals](agent-harness/docs/images/evals-1440.png), [Logs](agent-harness/docs/images/logs-1440.png). The full image index is in [`ui-evidence-and-demo-reset.md`](agent-harness/docs/ui-evidence-and-demo-reset.md).

**Flow videos** (WebM, under 4 MB each). GitHub does not play WebM inside a README, so these are links: open one to download or view it.

- [Run, approval, workspace panel](agent-harness/docs/images/video-run-approval-to-workspace.webm): a `create_dashboard` call stops for approval, is approved, and the dashboard appears in the session workspace.
- [Sessions: bulk archive and Undo](agent-harness/docs/images/video-sessions-bulk-archive-undo.webm)
- [Knowledge base: document sheet and playground](agent-harness/docs/images/video-kb-doc-sheet-and-playground.webm)

More detail: [agent-harness/README.md](agent-harness/README.md).

---

## MRO Predictive Maintenance

**What it is.** A proof of concept that predicts whether an aircraft component will need an unscheduled removal within the next 30 flight cycles. It started as a leakage-safe training pipeline and grew into a live scoring service plus a dashboard where engineers triage alerts, raise work orders through an approval-gated copilot, probe the model with what-if inputs, and watch drift.

### Video walkthrough

[![MRO Predictive Maintenance: product walkthrough (click to play)](mro-predictive-maintenance/docs/videos/mro-walkthrough-poster.png)](mro-predictive-maintenance/docs/videos/mro-walkthrough.mp4)

A 4:12 silent, captioned walkthrough recorded on the running app (real API, real model, real LLM copilot runs; long LLM waits are sped up, never faked). File: [`docs/videos/mro-walkthrough.mp4`](mro-predictive-maintenance/docs/videos/mro-walkthrough.mp4) (1440x900, H.264). GitHub does not inline-play MP4 files stored in a repo: click the poster to open the file view, then play it there or use **Download raw file**.

![Teaser: the copilot proposes a work order and a human approves it](mro-predictive-maintenance/docs/videos/mro-walkthrough-teaser.gif)

| Time | # | Chapter |
|---|---|---|
| 0:11 | 1 | The control desk |
| 0:30 | 2 | Acknowledge with undo |
| 0:39 | 3 | The whole fleet, ranked |
| 0:58 | 4 | Bulk triage and export |
| 1:12 | 5 | One component, explained |
| 1:33 | 6 | Alerts inbox and sheet |
| 1:47 | 7 | Ask the copilot |
| 2:01 | 8 | Approve, and a work order exists |
| 2:10 | 9 | Deny and search |
| 2:29 | 10 | Close the loop |
| 2:59 | 11 | Is the model any good? |
| 3:14 | 12 | Why, and what if |
| 3:32 | 13 | Drift and retrain |
| 3:43 | 14 | Roles, knowledge, navigation |

**Architecture**

```mermaid
flowchart LR
    GEN["data/generate_dataset.py<br/>seeded synthetic data"] --> FEAT["src/features.py"]
    FEAT --> SPLIT["src/splitting.py<br/>group + time split"]
    SPLIT --> TRAIN["src/modeling.py + calibration.py<br/>logistic regression, gradient boosting"]
    TRAIN --> EVAL["src/evaluation.py<br/>threshold on validation"]
    EVAL --> CARD["reports/model_card.json + models/"]
    CARD --> SVC["FastAPI service :8100<br/>/score /fleet /ops /copilot /monitoring"]
    SVC --> OPS[("SQLite data/ops.db<br/>alerts, work orders, runs")]
    SVC --> KB["kb/*.md hybrid retrieval"]
    SVC --> COP["copilot: tools + guardrails<br/>approval pauses writes"]
    SVC --> DASH["React dashboard :5173 / :4173"]
    SVC --> MLF["MLflow registry + drift (local file store)"]
```

**Key features**

| Overview (control desk) | Fleet with bulk select | Component detail |
|---|---|---|
| ![Overview](mro-predictive-maintenance/docs/images/overview-1440.png) | ![Fleet](mro-predictive-maintenance/docs/images/fleet-components-1440.png) | ![Component](mro-predictive-maintenance/docs/images/component-detail-1440.png) |
| Needs-attention list with inline Acknowledge and Undo, pending approvals, activity feed. | All 312 components, paged on the server, Alert / Watch / Normal bands. | Risk history, SHAP factors, inline copilot. |

| Alert sheet | Copilot, approved tool call | What-if |
|---|---|---|
| ![Alert sheet](mro-predictive-maintenance/docs/images/alert-detail-sheet-1440.png) | ![Copilot](mro-predictive-maintenance/docs/images/copilot-approved-tool-call-1440.png) | ![What-if](mro-predictive-maintenance/docs/images/what-if-scenario-1440.png) |
| Top SHAP factor, related procedures, lifecycle actions. | `create_work_order` after a human approves. | Edit inputs, see live score and SHAP deltas. |

| Model performance | Drift monitoring | Viewer (read-only) |
|---|---|---|
| ![Performance](mro-predictive-maintenance/docs/images/model-performance-1440.png) | ![Drift](mro-predictive-maintenance/docs/images/monitoring-drift-1440.png) | ![Viewer](mro-predictive-maintenance/docs/images/viewer-read-only-alert-1440.png) |
| Threshold, confusion matrix, calibration. | Real PSI snapshots, drift check, retrain gate. | Write actions are disabled with the reason. |

| Phone: overview | Phone: fleet | Phone: alert sheet |
|---|---|---|
| ![Overview 390](mro-predictive-maintenance/docs/images/overview-390.png) | ![Fleet 390](mro-predictive-maintenance/docs/images/fleet-components-390.png) | ![Alert 390](mro-predictive-maintenance/docs/images/alert-detail-sheet-390.png) |

**Flow videos** (WebM, 1280 x 800, under 2 MB each). GitHub does not play WebM inside a README, so these are links.

- [Fleet, component, alert: acknowledge, then Undo](mro-predictive-maintenance/docs/images/flow-fleet-alert-acknowledge-undo.webm)
- [Acknowledge, raise a work order through the copilot, approve it](mro-predictive-maintenance/docs/images/flow-copilot-raise-work-order-approval.webm)
- [What-if: change one input and watch the score and SHAP factors move](mro-predictive-maintenance/docs/images/flow-what-if-scoring.webm)

More detail: [mro-predictive-maintenance/README.md](mro-predictive-maintenance/README.md).

---

## How to run

### Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Python | 3.10 or newer (developed and tested on 3.11) | both apps |
| Node.js | 20.19 or newer, or 22.12 or newer (Vite 8 in `agent-harness/web`); the MRO dashboard only needs 18 or newer. Developed on Node 24. | both web UIs |
| Docker with Compose | any recent version | Agent Harness only: Postgres and MLflow, and the backend test suite (it starts a throwaway Postgres through `testcontainers`) |
| OpenAI API key | optional | real LLM runs; see below |

Ports used:

| Port | Service |
|---|---|
| 8000 | Agent Harness API and built web console |
| 5433 | Agent Harness Postgres (host port; the container listens on 5432) |
| 5001 | MLflow UI for Agent Harness |
| 5173 | Vite dev server (either web app; run only one at a time) |
| 8100 | MRO scoring service |
| 4173 | MRO dashboard preview build |

### Environment variables

| Variable | App | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | both | unset | Real LLM. Agent Harness reads it from `agent-harness/.env`; the MRO service reads it from the process environment. |
| `OPENAI_MODEL` | both | `gpt-4o-mini` | Chat model with tool calling. |
| `DATABASE_URL` | Agent Harness | `postgresql://agent_harness:agent_harness@localhost:5433/agent_harness` | Matches `docker-compose.yml`. |
| `MLFLOW_TRACKING_URI` | Agent Harness | `http://localhost:5001` in `.env.example` | Empty disables tracing. |
| `APPROVAL_TIMEOUT_SECONDS` | Agent Harness | `900` | How long a run waits for a human decision. |
| `DATABASE_URL` | MRO | `sqlite:///data/ops.db` | Ops store (alerts, work orders, copilot runs). |
| `SERVICE_CORS_ORIGINS` | MRO | dev and preview ports | CORS allow-list for the dashboard. |
| `VITE_SERVICE_BASE_URL` | MRO dashboard | `http://localhost:8100` | Dashboard to service base URL. |

Copy `agent-harness/.env.example` to `agent-harness/.env` and edit it; `.env` is gitignored.

**Without an API key.**
- Agent Harness: the tests need no key. `python cli.py --mock "..."` runs an offline heuristic backend. The API and web console still start, but starting a run shows an "LLM not configured" state; there is no silent fake fallback.
- MRO: the copilot runs in a deterministic offline-scripted mode by default (`GET /copilot/meta` reports `offline-scripted`). Setting `OPENAI_API_KEY` before starting the service switches it to OpenAI.

### Agent Harness

Windows PowerShell:

```powershell
cd agent-harness
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
docker compose up -d                  # Postgres :5433 and MLflow :5001
alembic upgrade head                  # schema plus seed users, services, skills, agents, prompts
Copy-Item .env.example .env           # then set OPENAI_API_KEY in .env
cd web; npm install; npm run build; cd ..
uvicorn api:app                       # API and console on http://127.0.0.1:8000
```

macOS / Linux:

```bash
cd agent-harness
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
docker compose up -d
alembic upgrade head
cp .env.example .env                  # then set OPENAI_API_KEY in .env
(cd web && npm install && npm run build)
uvicorn api:app
```

Open http://127.0.0.1:8000/ . API docs are at http://127.0.0.1:8000/api/v1/docs. The first run with hybrid retrieval downloads the `BAAI/bge-small-en-v1.5` embedding model.

Optional frontend hot-reload loop: keep `uvicorn api:app --reload` running, then `cd web; npm run dev` and open http://localhost:5173/ .

### MRO Predictive Maintenance

The trained models, reports, dataset CSVs and the dashboard data file are committed, so you can run the service without retraining.

Windows PowerShell:

```powershell
cd mro-predictive-maintenance
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn src.service.app:app --port 8100      # terminal 1
```

```powershell
cd mro-predictive-maintenance\dashboard                # terminal 2
npm install
npm run dev                                            # http://localhost:5173/
# or a production build: npm run build; npm run preview -- --port 4173
```

macOS / Linux:

```bash
cd mro-predictive-maintenance
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn src.service.app:app --port 8100      # terminal 1

cd dashboard && npm install && npm run dev             # terminal 2
```

To rebuild the data and models from scratch (deterministic, seed 42):

```bash
python data/generate_dataset.py --seed 42
python -m src.pipeline                      # v1 profile: the served model
python -m src.pipeline --profile realistic  # harder stress-test profile
python dashboard/scripts/build_dashboard_data.py
```

Restart the service after retraining; it loads the artifacts once at startup.

### Seed and reset

| App | State | Command |
|---|---|---|
| Agent Harness | Users, services, skills, agents and prompts are seeded by `alembic upgrade head` (and services again at startup if the table is empty). Everything else accumulates as you use the app. | There is no seed-reset command. Snapshot and restore Postgres as described in [`ui-evidence-and-demo-reset.md`](agent-harness/docs/ui-evidence-and-demo-reset.md). To wipe everything: `docker compose down -v`, then `docker compose up -d` and `alembic upgrade head`. |
| MRO | `data/ops.db` is created on first start with no alerts. On the Fleet page click **Scan fleet now**, or run the request below. | `python scripts/reset_demo_data.py` returns alerts to `open` and clears work orders, status overrides and copilot runs (`--keep-copilot-runs` keeps run history). Safe while the service is up. |

Create the first alerts without the UI:

```powershell
Invoke-RestMethod -Method Post http://localhost:8100/ops/fleet-scan      # PowerShell
```

```bash
curl -X POST http://localhost:8100/ops/fleet-scan                        # macOS / Linux
```

The dashboards have an identity switcher (Agent Harness: Alice Admin, Evan Editor, Erin Editor, Vera Viewer; MRO: `lead.engineer`, `planner`, `viewer`). It is a demo header, not authentication.

### Run the tests

Run each command from the folder shown, with the Python venv active.

| Suite | Command | Current result |
|---|---|---|
| Agent Harness backend | `cd agent-harness; pytest` | 669 passed (about 11 minutes; needs Docker; the 2 `live` tests are excluded by default) |
| Agent Harness web | `cd agent-harness/web; npm test` | 47 files, 332 tests passed |
| Agent Harness web, static checks | `npm run lint; npm run typecheck` | clean |
| MRO backend | `cd mro-predictive-maintenance; python -m pytest -q` | 232 passed (3 `live` tests excluded) |
| MRO dashboard | `cd mro-predictive-maintenance/dashboard; npm test` | 31 files, 213 tests passed |
| MRO dashboard, build | `npm run build` | passes (type check plus Vite build) |

The `live` tests call OpenAI and are opt-in: `pytest -m live` in either app, with `OPENAI_API_KEY` set. To run the Agent Harness suite against an already-running Postgres instead of `testcontainers`, set `AGENT_HARNESS_TEST_DATABASE_URL`.

---

## Known limitations

Stated as found by the final QA passes against the design boards and the original brief.

**Both systems**
- There is no real authentication. The identity switcher sets a plain header (`X-User-Id` or `X-User`) that anyone can spoof. Role checks on the server are real, but who you are is not verified, so neither app should be exposed beyond localhost.
- All data is mock or synthetic: the runbook corpus, the service registry, the aircraft dataset and the maintenance knowledge base. No real incident system or real fleet is touched.

**Agent Harness** (design-board match about 85%, weighted)
- Logs lists runs, not an event-level live tail.
- Automations are event-triggered only; there are no cron schedules.
- No "Retrieval evals" tab in the knowledge base (that suite runs from the CLI and Evals), and no "New incident" button (incidents are created only through an approved agent call, by design).
- Prompts and Integrations use a full page or a table plus sheet, not a master-detail layout.
- The Incidents table is squashed on a 390 px phone (no card list); the "Chat stalled" state exists in code but was not exercised.
- A viewer can read Guardrails (the page is read-only), so a "forbidden" state does not apply.
- A success rate computed from a single scored run reads "0%"; a tooltip explains it.
- The eval judge scores one transcript at a time and has no calibration against human review. Dashboard SQL is read-only through a parser, a `READ ONLY` transaction and a restricted Postgres role, but it is a local single-user design.
- CLI-originated runs write only the JSONL trace, not Postgres.

**MRO Predictive Maintenance** (design-board matches 82% to 93% per screen after the second QA round; no single weighted figure was recorded)
- The headline metrics come from synthetic data in which `cycles_since_last_check` is a very strong signal, so real-fleet recall would likely be lower. The 28 test positives make the 82.1% recall estimate statistically loose (95% interval about 0.64 to 0.92).
- The stress-test profile is much harder: test PR-AUC 0.203 and a served threshold of 0.01, which is fragile. It is reported, not tuned away.
- The ops store is SQLite (single writer); production would need Postgres.
- The knowledge base is fictional and is not real maintenance-manual content.
- Offline copilot mode is a scripted router, not a language model.
- Not built: an aircraft-type filter on Fleet, a row overflow menu, a "New work order" form (raising stays approval-gated through the copilot), "Alerts by component type" on Overview, run-status filter chips on Copilot, and a "More" tab on phones.
- The retrain button was not exercised live during QA because it rewrites tracked report artifacts.

Details and the full accounting are in each app's design report.

---

## Repo map and docs

```
.
├── README.md                          this file
├── agent-harness/
│   ├── README.md                      setup, tour, API surface, trace format
│   ├── api.py, cli.py                 FastAPI and CLI entrypoints
│   ├── src/agent_harness/             loop, tools, retrieval, RBAC, repos, routers, eval
│   ├── alembic/                       database migrations
│   ├── docker-compose.yml             Postgres :5433 and MLflow :5001
│   ├── data/                          mock runbooks (kb/), seed services, retrieval eval queries
│   ├── tests/                         pytest suite (669 tests)
│   ├── web/                           React + TypeScript console (PRODUCT.md, DESIGN.md)
│   ├── postman/                       Postman collection
│   └── docs/                          design-report.md, product/PRD.md, demo-evidence.md,
│                                      ui-evidence-and-demo-reset.md, images/ (screenshots, WebM)
└── mro-predictive-maintenance/
    ├── README.md                      setup, endpoints, dashboard tour, roles, reset
    ├── data/                          generate_dataset.py, raw/ and processed/ CSVs
    ├── src/                           features, splitting, modeling, evaluation, explainability,
    │                                  service/ (FastAPI), ops/, copilot/, monitoring
    ├── models/, reports/              trained artifacts and generated reports
    ├── kb/                            fictional maintenance procedures
    ├── scripts/reset_demo_data.py     return demo data to the seeded state
    ├── tests/                         pytest suite (232 tests)
    ├── dashboard/                     React + TypeScript dashboard (PRODUCT.md, DESIGN.md)
    └── docs/                          design-report.md, product/PRD.md, demo-evidence.md, images/
```

| | Agent Harness | MRO Predictive Maintenance |
|---|---|---|
| Product requirements (PRD) | [agent-harness/docs/product/PRD.md](agent-harness/docs/product/PRD.md) | [mro-predictive-maintenance/docs/product/PRD.md](mro-predictive-maintenance/docs/product/PRD.md) |
| Architecture and design decisions | [agent-harness/docs/design-report.md](agent-harness/docs/design-report.md) | [mro-predictive-maintenance/docs/design-report.md](mro-predictive-maintenance/docs/design-report.md) |
| Captured real output | [agent-harness/docs/demo-evidence.md](agent-harness/docs/demo-evidence.md) | [mro-predictive-maintenance/docs/demo-evidence.md](mro-predictive-maintenance/docs/demo-evidence.md) |
| UI product and design notes | [web/PRODUCT.md](agent-harness/web/PRODUCT.md), [web/DESIGN.md](agent-harness/web/DESIGN.md) | [dashboard/PRODUCT.md](mro-predictive-maintenance/dashboard/PRODUCT.md), [dashboard/DESIGN.md](mro-predictive-maintenance/dashboard/DESIGN.md) |

---
Phu Nguyen — HCMC, VN
