# Agent Harness web console

React 19 + TypeScript + Vite + Tailwind CSS 4 console for the Agent Harness backend (`../api.py`). Routing is path-based (`react-router-dom`); the pages are listed in `src/App.tsx`. Design notes: [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md). Screenshots and videos: [`../docs/images/`](../docs/images/), indexed in [`../docs/ui-evidence-and-demo-reset.md`](../docs/ui-evidence-and-demo-reset.md).

Requires Node.js 20.19+ or 22.12+ (Vite 8).

| Command | What it does |
|---|---|
| `npm install` | Install dependencies. |
| `npm run build` | `tsc -b` then `vite build` into `dist/`. `uvicorn api:app` serves that folder at `/`. |
| `npm run dev` | Vite dev server on http://localhost:5173/ (the backend must be running on :8000; it allows this origin through CORS). |
| `npm run lint` | `oxlint src tests`. |
| `npm run typecheck` | `tsc -b`. |
| `npm test` | `vitest run` (47 files, 332 tests at the time of writing). |

Normal use needs no dev server: build once and open the backend on http://127.0.0.1:8000/. See the [Agent Harness README](../README.md) for the full setup.

---
Phu Nguyen — HCMC, VN
