# Design system: "Graphite & Iris" (light)

The source of truth is `src/index.css`. The Tailwind `zinc` ramp is **remapped** to graphite and `sky` to iris, so every existing utility class inherits the system.

## Tokens
| Role | Value |
|---|---|
| Canvas (sidebar/app bg) | `oklch(0.968 0.004 272)` |
| Sheet (main inset panel) | `oklch(0.993 0.0015 272)`, radius 12, hairline ring |
| Surface (cards) | `#fff` |
| Hairline / strong | `oklch(0.25 0.02 272 / .09)` / `/ .15` |
| Text | zinc-950 `oklch(.148 .011 272)` · body zinc-900 · muted zinc-500 `oklch(.552 .017 272)` (≥4.5:1 on white) |
| Accent (iris) | sky-600 `oklch(.535 .207 279)`, used for primary actions, focus, selection and live state only |
| Status | emerald success · amber attention · rose danger · orange limits · fuchsia guardrail. Statuses render as **dot + text**; severity keeps a soft pill |
| Chart palette | `#5b54e8 #0f9f8f #e0901a #e5484d #a35ee8 #1b98c7 #7c8a2b`. Status categories are coloured by meaning (`statusColor`) |
| Radii | sm 5 · md 8 (controls) · lg 10 (cards) · xl 12 (panels) · 2xl 16 / 20 (composer, approval) |
| Shadows | xs (cards) · sm · lift (hover/composer) · lg (popovers) · xl (dialogs). Layered, offset, soft |
| Motion | 120–250ms, `cubic-bezier(.16,1,.3,1)`. Animations: rise, fade, drawer, shimmer, caret. Transform/opacity only. Reduced-motion is honoured |

## Type
- **Fonts:** Inter Variable for UI (`cv11`), Geist Variable for h1–h3 and KPI numerals, Geist Mono Variable for IDs, tool names, code and token counts. All three are self-hosted via `@fontsource-variable`.
- **Scale:** 11 / 12 / 13 (UI) / 14 (body) / 15 (chat prose, composer) / 26 (page title, −0.025em) / 28–32 (KPI).
- **Numbers:** `tabular-nums` on tables, KPIs and metrics. No global `tnum`, because it spaces hyphens.

## Components (`.ui-*`)
- **Buttons:** `btn` with primary / secondary / ghost / danger / danger-solid / link variants, 32px (`-sm` 28px). Press scale is .97. Disabled primary is neutral grey.
- **Form controls:** `input`, plus native `select` restyled globally with a chevron.
- **Surfaces:**
  - `card` uses a hairline and an xs shadow; a nested card loses its chrome.
  - `table` has a sticky blurred header, 40px rows, hairline dividers and an iris hover tint.
  - `chip`, `kbd`, `skeleton` (shimmer), `segmented` and `prose` (chat markdown).

## Signature patterns
- **Shell:**
  - Canvas sidebar: fill-only active pill with an iris icon, 5 recent sessions, and user / API / tokens docked at the bottom. It collapses to a 52px rail.
  - 48px breadcrumb bar holding the approval badge and the ⌘K search.
  - Inset sheet for the main content.
- **Chat:**
  - 760px column. User message in a soft bubble; the assistant is unboxed under "Worked for Xs".
  - Markdown blocks with code copy, and a 2px iris streaming caret.
  - Floating composer with an agent chip, a `/` button and an arrow-up send button that becomes Stop.
- **ToolCallBlock:** the single tool-call component, with the lifecycle running → needs approval (amber, expanded, Approve/Deny inside) → approved/denied → succeeded/failed. It also carries the artifact chip.
- **Workspace:** a right panel with live artifact cards (dashboards with Refresh/Open, incidents, memories, prompt versions).

Phu Nguyen — HCMC, VN
