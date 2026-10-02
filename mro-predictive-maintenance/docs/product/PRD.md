# MRO Predictive Maintenance — Product Requirements Document (v2)

**Author:** Nguyen Quang Phu — HCMC, VN
**Status:** Approved for build (2026-09-29)
**Context:** Part 2 of the original brief (senior track). v1
(real sklearn pipeline, leakage found+fixed, FastAPI scoring service, results
dashboard) is built, tested (26/26), and verified live. This PRD applies the
same product-thinking pass used for the Agent Harness: the app should read
as a product a senior engineer designed for an MRO ops team, not a script
with a chart bolted on. Only the dataset is mock; the pipeline, service, and
UI are real.

## 1. Problem & goal

An MRO engineer needs to (a) understand why they should trust this model at
all, (b) see current fleet risk, (c) score an individual component live, and
(d) understand what happens next in production (deployment/monitoring/
retraining). v1 covers (b) and (c) well; v2 makes the "why trust it" and
"what's next" stories first-class in the UI itself, not buried in a markdown
file the user has to go find.

## 2. Users

- **Primary:** an MRO reliability engineer deciding whether to schedule an
  unscheduled inspection based on the model's output.
- **Secondary:** a reviewer, evaluating data prep, leakage
  prevention, modeling, evaluation, explainability, and production design —
  the original brief's stated rubric.

## 3. Baseline requirements (verbatim from the test — must never regress)

- Compare ≥2 ML models.
- Risk score per component.
- Time-based or group-based split preventing leakage.
- Explain main factors behind high-risk predictions.
- ≥80% recall at ≤5 alerts/100 active components.
- Describe handling of new components, missing data, model drift.

## 4. v2 scope: the UI tells the whole story, tab by tab

Left-nav, mirroring the Agent Harness's structure for consistency across the
submission:

| Tab | Content |
|---|---|
| **Overview** | What this predicts, why it matters for MRO, the headline result and whether the target was met — today's dashboard content, kept. |
| **Architecture** | A real diagram (data generator → feature pipeline → leakage-safe split → training → evaluation → serving) with the actual module each stage maps to, so a reviewer can trace code without reading the design report first. |
| **How it works (step-by-step)** | The pipeline narrated as steps a reviewer can follow in order: 1) synthetic data generation & why, 2) the leakage bug found and fixed (real incident, told as a mini case study), 3) splitting strategy, 4) model comparison, 5) threshold selection, 6) explainability, 7) serving. |
| **Model comparison** | Existing content (metrics, threshold-sweep charts), kept. |
| **Feature importance** | Existing content, kept. |
| **High-risk leaderboard** | Existing content, kept. |
| **Live scoring** | Existing content (calls the real FastAPI service), kept. |
| **Fleet risk** | Existing content (real live ranking), kept. |
| **Production design** | Deployment/monitoring/retraining/cold-start/drift-handling — promoted from a markdown section to a real UI tab with the actual serving architecture (FastAPI service, model card, retrain CLI) shown, not just described. |

## 5. Non-goals

- Real fleet data or a real airline customer.
- A real MLOps deployment (Kubernetes, CI/CD for the model) — described,
  not built, since there is no real infrastructure to deploy to for a mock
  dataset.
- Multi-seed statistical robustness study (documented as future work, per
  v1's design report).

## 6. Success criteria

- Every v1 baseline requirement still holds (tests + live verification).
- A reviewer can open the app cold and understand the whole story — problem,
  data, leakage catch, models, results, production plan — via tabs alone,
  without needing to open the markdown design report first (the report still
  exists as the detailed backup, linked from the UI).
- No fabricated numbers anywhere; every UI number traces to a real artifact
  or a live service call, exactly as v1 already guarantees.

## 7. v3 scope — ops layer + HITL maintenance copilot

**Status:** built, tested (182/182 offline + opt-in live suite green),
live-verified against a real OpenAI backend (`gpt-4o-mini`). See
`docs/design-report.md` §8 for the full results writeup and
`reports/phase-08-docs-e2e-report.md` for the final regression-gate
evidence.

### 7.1 Problem & goal

v2 made the model's story legible in the UI. v3 makes the **operational
loop** real: an MRO lead should be able to run a fleet scan, see the
alerts it opens, ask a copilot to triage one, and have the copilot either
ask a clarifying question or draft a work order for a human to approve —
never act unilaterally on anything that changes ops state.

### 7.2 Users (extends §2)

- **MRO reliability engineer / lead** — approves or denies the copilot's
  proposed work orders; the only role that can execute a write action.
- **Planner** — same approval rights as lead, different demo persona.
- **Viewer** — read-only; can converse with the copilot and answer
  clarifying questions, but every approval/deny attempt is rejected with a
  real `403`.

### 7.3 In scope (built)

- Ops domain: SQLite-backed alerts, work orders, predictions log,
  reliability KPIs (`src/ops/*`, `/ops/*` routes).
- MLOps: MLflow training runs, model registry with a `champion` alias,
  PSI-based drift monitor, champion/challenger retrain gate
  (`src/tracking.py`, `src/monitoring.py`, `src/retrain.py`).
- Maintenance knowledge base + hybrid (BM25 + TF-IDF) retrieval, evaluated
  on an easy/hard query split (`kb/*.md`, `src/copilot/retrieval.py`,
  `reports/retrieval_eval.json`).
- Copilot agent core (Pydantic AI): ≥6 tools, two categories of deferred
  tool call (`create_work_order` = approval-gated, `ask_user` =
  clarification, never gated), guardrails (grounding-by-citation,
  prompt-injection resistance), MLflow tracing
  (`src/copilot/{agent,tools,guardrails,hitl,tracing,models}.py`).
  runs API with SSE streaming, resume-after-restart, and fleet-scan-
  triggered automations that always land in `awaiting_input`, never an
  auto-created work order (`src/copilot/{runs,automations}.py`).
- Dashboard v3: task-first IA (Operations / Model / About), role-aware
  approval cards, ask-user option/free-text cards, identity picker,
  monitoring and knowledge-base pages, markdown-safe chat rendering
  (`dashboard/src/**`).

### 7.4 Non-goals (extends §5)

- Real authentication (session/password) — a demo identity header only.
- A non-fictional knowledge base corpus.
- Multi-tenant / multi-fleet data model.
- Automatic retraining on a schedule (the retrain gate exists; triggering
  it on a cron/cadence is described, not built).

### 7.5 Success criteria

- v1's baseline requirement set (§3) and v2's UI-tour requirement (§6)
  both still hold unmodified.
- Every write action the copilot can take (`create_work_order`) requires
  an explicit, role-checked human approval — proven by a test that a
  viewer's approval attempt is rejected and by the end-to-end scenario
  test (`tests/test_e2e_scenario.py`) driving the real HTTP API through
  fleet-scan → alert → automation triage → ask_user → approval (viewer
  403, then lead) → exactly one work order → drift → KB search, both
  offline-scripted and against the real OpenAI backend.
- `pytest -q` green twice in a row; `npm run build` and `npm test` clean.

---
Phu Nguyen — HCMC, VN
