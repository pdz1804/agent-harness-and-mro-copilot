# STEMS VN — AI Engineer Test Submission

**Candidate:** Nguyen Quang Phu ([quangphunguyen1804@gmail.com](mailto:quangphunguyen1804@gmail.com)) — HCMC, VN
**Test:** AI Engineer Test (Agent Harness required; ML for Aircraft MRO, senior track)

This repository contains both deliverables for the STEMS VN AI Engineer take-home
test. Everything is real and runnable except the *input data*: the agent's tools
operate on a mock service registry and a mock knowledge base, and the ML model
trains on a synthetic (seeded, documented) aircraft-maintenance dataset. The
agent reasoning is a real OpenAI model with native tool calling, not a scripted
demo; the ML pipeline is real scikit-learn training and evaluation, not
hand-typed numbers.

```
stems-vn-ai-engineer-test/
├── agent-harness/              Part 1 (required) — LLM<->tool execution harness
│   ├── src/agent_harness/      Core loop, tools, retrieval, persistence
│   ├── web/                    React/TS ops console (chat-style run view,
│   │                           Services / Incidents / Knowledge base / Logs)
│   ├── tests/                  pytest suite (offline + one live OpenAI test)
│   ├── data/kb/                Mock runbook corpus (retrieval input data)
│   ├── docs/                   design-report.md, demo-evidence.md
│   └── postman/                Postman collection for the HTTP API
│
└── mro-predictive-maintenance/ Part 2 (senior track) — unscheduled-removal risk
    ├── src/                    Data prep, splitting, modeling, explainability
    ├── src/service/            FastAPI live-scoring service
    ├── dashboard/               React/TS results + live-scoring dashboard
    ├── data/generate_dataset.py Synthetic dataset generator (seeded, documented)
    ├── tests/                  pytest suite incl. leakage/parity regression tests
    └── docs/                   design-report.md, demo-evidence.md
```

## Quick links

| | Agent Harness | MRO POC |
|---|---|---|
| Run instructions | [agent-harness/README.md](agent-harness/README.md) | [mro-predictive-maintenance/README.md](mro-predictive-maintenance/README.md) |
| Architecture & design decisions | [agent-harness/docs/design-report.md](agent-harness/docs/design-report.md) | [mro-predictive-maintenance/docs/design-report.md](mro-predictive-maintenance/docs/design-report.md) |
| Captured real evidence (no need to run anything to review) | [agent-harness/docs/demo-evidence.md](agent-harness/docs/demo-evidence.md) | [mro-predictive-maintenance/docs/demo-evidence.md](mro-predictive-maintenance/docs/demo-evidence.md) |

## Headline results (honestly reported)

- **Agent Harness:** real OpenAI (gpt-4o-mini) tool-calling loop with state,
  retries/timeouts, malformed-response handling, step/wall-clock limits, a
  genuine pause/resume human-approval gate before `create_incident`, hybrid
  (BM25 + local embeddings) retrieval over a mock runbook corpus, and
  SQLite-backed persistence that survives a restart. See the design report's
  "Limitations" section for what's explicitly out of scope for a take-home.
- **MRO POC:** an initial 82% recall result was found to rest on a **target
  leakage bug** in the synthetic-data generator (symptom-triggered inspections
  leaking the label) — caught during live testing, fixed, and retrained. The
  honest post-fix result and full before/after comparison are in
  `mro-predictive-maintenance/docs/design-report.md` §7.1. This kind of catch
  is exactly what the leakage-prevention criterion in the test is checking for.

## Notes for the reviewer

- Both projects are independent Python/TypeScript stacks with their own
  virtualenv and `npm` project — see each README for exact setup.
- Every number in either `docs/demo-evidence.md` was captured from a real run
  (terminal transcript, curl output, or a live browser session), not
  hand-typed.
- Synthetic/mock data only; no production system, credentials, or real
  incident-management platform is touched by either project.

---
Phu Nguyen — HCMC, VN
