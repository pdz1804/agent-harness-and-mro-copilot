# Web console evidence and demo-data reset

Screenshots and short videos of the web console, captured on 2026-10-02 against the live app
(`http://127.0.0.1:8000`, real backend, real Postgres, real model calls). Everything is in
[`docs/images/`](images/).

## Videos (WebM, 1280 px wide)

| File | Flow |
|---|---|
| `video-run-approval-to-workspace.webm` | New run → the `create_dashboard` tool call stops for approval (docked approval bar with a live preview) → Approve → the run completes → the dashboard appears in the session Workspace panel → Inspector timeline. |
| `video-sessions-bulk-archive-undo.webm` | Sessions: select two rows → the bulk bar appears → Archive → toast → Undo puts both back (18 → 16 → 18 active). |
| `video-kb-doc-sheet-and-playground.webm` | Knowledge base: open a document in the side sheet (deep link `/knowledge/<id>`) → Esc → Retrieval playground → ranked chunks with BM25, vector and RRF scores and query stats. |

## Screenshots

Main screens at 1440 px: `chat-new`, `sessions`, `session-sheet`, `session-thread`, `memory`, `services`,
`incidents`, `incident-sheet`, `incident-detail`, `knowledge`, `integrations`, `guardrails`, `automations`,
`agents`, `agent-editor`, `agent-test-chat`, `skills`, `prompts`, `prompt-detail`, `dashboards`,
`dashboard-detail`, `evals`, `logs`. Phone (390 px): `chat-new`, `sessions`, `session-thread`, `incidents`,
`knowledge`, `dashboards`, `agents`, `chat-approval`, `chat-completed`. Viewer role: `viewer-skills`,
`viewer-agents`.

Flow states: `chat-streaming`, `chat-approval`, `chat-completed`, `chat-workspace`, `chat-inspector`,
`chat-feedback`, `chat-stopped`, `chat-timeout`, `sessions-bulk-bar`, `sessions-archived-toast`,
`agents-cloned-toast`, `agents-deleted-undo-toast`, `dashboards-duplicated-toast`,
`prompts-activated-undo-toast`, `prompt-version-diff`, `dashboard-widget-sheet`, `kb-doc-sheet`,
`kb-playground`, `evals-run-detail`, `guardrails-sandbox`, `skills-routing-tester`, `memory-saved`,
`automations-rule`, `logs-export`.

## Resetting the demo data

The app has no seed-reset command: Alembic seeds users, services, skills, agents and prompts once, and
everything else (runs, sessions, incidents, dashboards, memories, eval runs, automations) accumulates as
you use it. To return to a known state, snapshot the database before a demo and restore it afterwards.
The Postgres container is `agent-harness-postgres-1` from `docker-compose.yml`.

```powershell
# 1. Snapshot (once, while the data looks the way you want)
docker exec agent-harness-postgres-1 pg_dump -U agent_harness -d agent_harness -Fc -f /tmp/demo-baseline.dump
docker cp agent-harness-postgres-1:/tmp/demo-baseline.dump .\demo-baseline.dump

# 2. Restore: stop the backend first, because the run registry and KB index live in memory
Get-NetTCPConnection -LocalPort 8000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
docker cp .\demo-baseline.dump agent-harness-postgres-1:/tmp/demo-baseline.dump
docker exec agent-harness-postgres-1 pg_restore -U agent_harness -d agent_harness --clean --if-exists --single-transaction /tmp/demo-baseline.dump

# 3. Optional: delete the trace files of runs that are no longer in the database
#    (runs/<run_id>.jsonl; the Logs page reads Postgres, so leftovers are harmless)

# 4. Start the backend again
.\.venv\Scripts\python.exe -m uvicorn api:app --port 8000
```

From Git Bash, prefix the `docker exec` lines with `MSYS_NO_PATHCONV=1` so `/tmp/...` is not rewritten
into a Windows path. MLflow (`:5001`) keeps its own store; eval runs logged there are not removed by
the restore.

---
Phu Nguyen — HCMC, VN
