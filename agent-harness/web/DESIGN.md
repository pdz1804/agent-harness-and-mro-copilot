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
| Radii | One scale: **6 / 10 / 14 / 20 / pill**. Controls 10, cards and tables 14, overlays (nav panel, sheet, toast, popover, palette, composer, approval bar) 20. Every Tailwind `rounded-*` utility is remapped onto it in `index.css` |
| Shadows | xs (cards) · sm · lift (hover/composer) · lg (popovers) · xl (dialogs). Layered, offset, soft |
| Motion | 150 / 200 / 280ms. Springs: `--ease-spring-snappy` (controls, fold chevron, switch; slight overshoot) and `--ease-spring-smooth` (sheets, toasts, popovers). Animations: pop, toast-in/out, sheet-in, flash, rise, fade, shimmer, caret, live pulse (only while a run streams). Transform/opacity only. `prefers-reduced-motion` turns motion off |
| Glass | `.ui-glass`: `blur(20px) saturate(180%)`, fill `rgb(252 252 253 / .72)`, 1px white edge, inset top highlight, soft shadow. **Chrome only**: nav panel, palette, toasts, popovers/menus, composer, approval bar, Jump pill, bulk bar, scrolled sticky header. `.ui-glass-solid` (~92% fill) for reading surfaces: sheets, dialogs. Content (cards, tables, tool-call cards) stays solid. `prefers-reduced-transparency` and no-backdrop-filter browsers get a solid fill. Backdrop: 1px dot grid |
| Scroll | Overlay scrollbar everywhere: 6px pill thumb on a transparent track, shown on hover or while scrolling (`data-scrolling`, `lib/scroll-activity.ts`), 8px while dragged. One scroll container per panel (nav, main, side panel, sheet body); the page itself never scrolls. Long lists fade 28px at the edges (`.ui-fade-edges`) |

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
- **ToolCallCard:** the single tool-call component, with the lifecycle running → needs approval (amber ring, expanded preview; the decision is on the docked ApprovalBar) → approved/denied → succeeded/failed. It also carries the artifact chip.
- **Workspace:** a right panel with live artifact cards (dashboards with Refresh/Open, incidents, memories, prompt versions).

## Component set (v2): `src/components/ui`
Pages compose **only** these, imported from `components/ui` (the barrel). A page-local button, chip, sheet, toast, empty state or confirm is a regression.

| Component | Use it for |
|---|---|
| `Button`, `LinkButton`, `AnchorButton` | Every action. `variant` primary (one per view) / secondary / ghost / danger / danger-solid / success / link; `size` sm 28 / md 32 / lg 44; `icon`, `iconOnly` (+ `aria-label`), `loading` (spinner + `aria-busy`), `kbd` hint |
| `Input`, `Textarea`, `Select`, `SearchInput`, `Field`, `Switch`, `Segmented` | Every form control. `Field` wires label, hint and error; `Segmented` is the tab control |
| `Chip`, `CopyId`, `StatusBadge` | Status, tags, versions, counts; IDs in mono that copy on click |
| `Card`, `CardHeader` | Solid content surfaces (14px), never nested, never glass |
| `Table`, `Row`, `SortHeader`, `SelectBox` | Tables in the rounded container: whole-row click opens the sheet (`onOpen`), sortable headers (`lib/table-sort.ts`, sort in the URL), multi-select |
| `Sheet`, `SheetSection`, `FactList` | Detail views. Header anatomy: eyebrow, title, status chip, facts row, ⋯ menu, prev/next, close. Deep link with `?open=<id>` (`useUrlState('open')`). Esc closes, ←/→ step |
| `RowActions` | The ⋯ menu on rows and sheet headers; destructive items confirm in place |
| `ConfirmPopover` | Any destructive button outside a menu. Never `window.confirm` |
| `useToast` | Feedback for every mutation, with `action: { label: 'Undo', run }` where reversible. Undo uses the restore/reopen endpoints, or `lib/deferred-action.ts` when the API has no reverse transition (incident acknowledge) |
| `BulkBar` | Glass multi-select action bar (`lib/bulk.ts` for partial-failure summaries) |
| `EmptyState`, `FilteredEmpty`, `ErrorState`, `ErrorBanner` | Truly empty (explain + one action + example) vs filtered-empty ("No results for 'x' · Clear filters") vs failed load (message + Retry) |
| `Skeleton`, `TableSkeleton`, `CardGridSkeleton`, `ListSkeleton`, `SheetSkeleton`, `TimelineSkeleton` | Loading shaped like the final layout |
| `PageHeader` | Sticky page header that frosts once scrolled; `toolbar` holds tabs, search and filters |
| `RelativeTime` | "5m ago" with the absolute time on hover |
| `NavGroup` | Foldable sidebar group. Fold state persists per browser under `nav.groups.<label>`; the group holding the current page is always open |
| `ShortcutsDialog` | The `?` shortcut sheet |

Chat-specific shared components live in `components/chat`: `ToolCallCard` (approval is a state of the card: amber ring + preview), `ApprovalBar` (the decision, docked in glass above the composer: "Waiting for approval · elapsed", A / D keys, disabled with the reason for viewers; there is no expiry countdown because the API exposes no deadline), `Composer` (glass). The thread follows new tokens while the reader is within 72px of the bottom; otherwise a glass "Jump to latest · n new steps" pill appears. The Workspace panel is per session (live dashboard previews, incidents, memories) with "Open in Dashboards".

Phu Nguyen — HCMC, VN
