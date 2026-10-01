# Product

<!-- impeccable:product-schema 1 -->

> Labelled assumptions: no interactive interview was possible in this run (subagent, no question tool). Every fact below is taken from the repo, the coordinator's brief, or the earlier UX report. Anything inferred is marked **(inferred)**.

## Platform

web

## Stack

React 18 + Vite + TypeScript, Recharts for charts, hand-written CSS with design tokens (no UI kit). Hash router. Talks to a FastAPI service on `:8100` over CORS. Self-hosted Inter and JetBrains Mono (`@fontsource-variable`), so the demo works offline.

## Users

- **Reliability engineer.** On shift, scanning a ranked fleet. Needs to know which component to inspect first, why it scores high, and to act on the alert. Reads fast, trusts numbers, hates decoration.
- **Maintenance planner.** Turns alerts into work orders, closes each with an outcome (confirmed fault, no fault found, not inspected), changes aircraft serviceability, looks up AMM/MEL procedures.
- **Reviewer / interviewer (inferred: STEMS VN AI-engineer assessment).** Opens the app cold. Wants to see in one minute: is the target met, is there leakage, can I probe it (explain, what-if, drift, retrain gate), is there a production story. Judges craft as well as function.

## Product Purpose

Predictive maintenance for an aircraft fleet. A leakage-safe model scores every component for the chance it needs an unscheduled removal within 30 flight cycles. The product turns scores into alerts, work orders and an approval-gated copilot, and feeds every inspection outcome back as a live precision measure.

Success: recall at least 80% at no more than 5 alerts per 100 components on a held-out test split (deployed model meets it), plus a UI an engineer can operate without training.

## Positioning

The loop is closed inside the product: score, explain, alert, human-approved work order, outcome, live precision, drift, gated retrain. A generic BI dashboard cannot claim the approval-gated copilot or the outcome loop.

## Operating Context

- The API is the source of truth. Offline pages read `src/data/dashboard_data.json`, built from real `reports/*`.
- Identities are seeded (`lead.engineer`, `planner`, `viewer`) and sent as `X-User`. Viewer is read-only; only `lead.engineer` may start a retrain.
- Data is synthetic (no real fleet was supplied). The footer says so on every page.
- The copilot runs in OpenAI mode or in an offline scripted mode (the UI must call that mode "scripted", not "offline").

## Capabilities and Constraints

- Pages: Overview; Operate (Fleet, Aircraft index, Alerts, Work orders, Copilot, Knowledge); Model (Performance, Explainability, What-if, Monitoring); About (Architecture, How it works, Production design). Detail pages: component, aircraft.
- Live endpoints used: health, model card, fleet top-risk, fleet component, score, ops alerts / work orders / aircraft / history, monitoring drift + drift history + performance, models + model metrics, retrain (POST + poll), copilot (REST + SSE), KB.
- Behaviour that must never regress: SSE with `last_event_id`; identity picker and viewer-disabled approvals; typed approval cards sending only changed `override_args`; ask_user option / free-text cards; batch submit bar; drift `?simulate=shift`; fleet scan; KB search and viewer; safe markdown (no raw HTML); what-if; alert and work-order lifecycles.
- Honest-label rules: unshifted drift reads "no alert" or "warn", never "quiet". The realistic profile's served threshold of 0.01 is fragile and is flagged as such. Retrain never hot-swaps the served model; the UI shows the gate decision and the job's `note`.
- No promotion baseline exists (`reports/champion_metrics.json` absent), so a retrain cannot promote; the UI says so instead of hiding it.

## Brand Commitments

Author credit "Phu Nguyen — HCMC, VN" appears in the footer of every page. No logo exists; the mark is a plain aircraft glyph.

## Evidence on Hand

- Held-out test: recall 82.1%, precision 100%, 0.91 alerts per 100, 23 of 28 removals caught (HistGradientBoosting v13, threshold 0.9405).
- Stress profile ("realistic", v12/v14): recall 92%, precision 23.7%, 3.73 alerts per 100, threshold 0.01. A stress test, not the reported result.
- Screenshots in `docs/test-evidence/`; endpoint contracts in the plan's `mro-backend-endpoints-report.md`.
- Absent: real fleet data, real users, usage analytics. Do not fabricate testimonials or adoption numbers.

## Product Principles

1. **The tool disappears into the task.** Familiar patterns, dense but calm, no decoration without a job.
2. **Say what the model actually did.** Thresholds, ties, fragile settings, scripted modes, empty histories: stated plainly with the number next to the claim.
3. **Never colour alone.** Every state carries an icon and a word.
4. **One path per job.** Reaching a component from the fleet, an alert, an aircraft or the copilot always lands on the same page.
5. **Humans approve consequences.** Anything that changes the world (work order, aircraft status, retrain) is attributed, gated and reversible in the UI's language.

## Accessibility & Inclusion

WCAG 2.2 AA target: contrast 4.5:1 text and 3:1 controls, visible `:focus-visible` rings, 44px touch targets under 768px, `prefers-reduced-motion` honoured, charts have a table alternative, status never colour-only. Layouts verified at 375, 768 and 1280.
