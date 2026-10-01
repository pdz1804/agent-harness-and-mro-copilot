---
name: MRO Predictive Maintenance
description: "Flight Deck Clarity": a calm, light, layered ops console. Cool tinted canvas, white cards with soft multi-layer elevation and alpha hairlines, one cobalt accent, risk always drawn against its threshold.
colors:
  canvas: "#F6F7F9"
  surface: "#FFFFFF"
  surface-subtle: "#FAFBFC"
  sunken: "#F0F2F5"
  border: "rgba(15,23,42,0.08)"
  border-strong: "rgba(15,23,42,0.14)"
  text: "#0B1220"
  text-2: "#384152"
  muted: "#5C6576"
  accent: "#3451D1"
  accent-hover: "#2C45B9"
  accent-press: "#243A9E"
  accent-tint: "#EEF1FD"
  accent-border: "#C8D1F6"
  accent-ink: "#2338A6"
  good: "#0F7A4A"
  good-tint: "#EAF7F0"
  warn: "#985800"
  warn-tint: "#FFF4DE"
  bad: "#C4291F"
  bad-tint: "#FEEFED"
  neutral: "#4A5466"
  series-accent: "#3451D1"
  series-baseline: "#98A1B3"
  series-warn: "#D48A06"
  series-bad: "#DC4436"
typography:
  display:
    fontFamily: "Geist Variable, Inter Variable, system-ui, sans-serif"
    weights: [600, 650]
    tracking: "-0.022em"
  ui:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "0.8125rem"
    weights: [400, 500, 600]
    lineHeight: 1.5
  data:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "0.75rem"
    weight: 500
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "20px"
  full: "999px"
spacing: [4, 8, 12, 16, 20, 24, 32, 40, 48]
elevation:
  card: "0 0 0 1px rgba(15,23,42,.06), 0 1px 2px rgba(15,23,42,.04), 0 2px 8px -2px rgba(15,23,42,.05)"
  raised: "0 0 0 1px rgba(15,23,42,.07), 0 2px 4px rgba(15,23,42,.05), 0 8px 20px -6px rgba(15,23,42,.10)"
  float: "0 0 0 1px rgba(15,23,42,.08), 0 8px 16px -4px rgba(15,23,42,.10), 0 24px 48px -12px rgba(15,23,42,.18)"
motion:
  fast: "140ms"
  base: "200ms"
  ease: "cubic-bezier(0.16, 1, 0.3, 1)"
---

# Design System: MRO Predictive Maintenance

## North Star: "Flight Deck Clarity"

A modern glass cockpit stays calm until something matters. The console is light, quiet and layered: a cool tinted canvas, white cards on soft multi-layer shadows with alpha hairlines, and one cobalt accent for action and selection. Colour is spent on a single idea, *risk against its alert threshold*, and it's drawn the same way everywhere: a rounded bar with a threshold notch, or a gradient line over a shaded threshold band.

Operate register. The bar is Linear / Vercel / Stripe: crisp type with real weight contrast, generous but disciplined density, purposeful motion, nothing default-looking. The brand lives in precise details: Geist Mono tail numbers, the threshold notch, honest labels ("scripted", "no alert").

## Replaced (anti-reference)

The previous "Maintenance Control Desk" look is retired. That look had an ink top bar, grey flat boxes, 1px solid borders on every edge, rectangular bordered chips and stock Recharts. Do not reintroduce dark chrome bars, solid grey card borders, heavy outlined chips, flat full-width rule tables or unicode glyph arrows.

## Colour

Cool slate neutrals with a faint blue cast, so the cobalt reads as native.

- **Cobalt** `#3451D1` (6.6:1 on white): primary buttons, current selection, links, focus ring, the deployed-model series. Hover `#2C45B9`, press `#243A9E`, tint `#EEF1FD`, ink `#2338A6`.
- **Canvas** `#F6F7F9`. **Surface** white. **Subtle** `#FAFBFC` for table headers and hover. **Sunken** `#F0F2F5` for tracks, skeletons and the segmented trough.
- **Hairlines** are alpha: `rgba(15,23,42,.08)` for dividers, `.14` for inputs. They tint correctly on any surface.
- **Text** `#0B1220`, **Text-2** `#384152`, **Muted** `#5C6576` (5.4:1 on canvas).
- **Semantic** (status only, always icon + word): good `#0F7A4A`/`#EAF7F0`, warn `#985800`/`#FFF4DE`, bad `#C4291F`/`#FEEFED`, neutral `#4A5466`/`#F0F2F5`. Chips are borderless soft tints with a 1px inset alpha ring in their own hue.
- **Charts**: cobalt `#3451D1` (primary), slate `#98A1B3` (baseline / comparison), amber `#D48A06` (warn), coral-red `#DC4436` (risk). Lines get a 2px stroke and a vertical gradient fill that fades from 18% to 0%. Bands sit at 6–8% alpha.

Rules:
- **One Voice**: cobalt marks the next action or the current selection, never decoration.
- **Threshold**: below 60% of threshold the bar is slate, 60–100% amber, at or above red. Low risk is not green.
- **Not Colour Alone**: every status carries an icon shape and a word.

## Typography

- **Display: Geist** (600–650, tracking −0.022em): page titles 24px, KPI values 26px, empty-state titles. Self-hosted via `@fontsource-variable/geist`.
- **UI: Inter** (400/500/600, `cv11` `ss01` `ss03`): everything else. 13px body, 14px panel titles (600), 12px labels (500), 11px captions.
- **Data: Geist Mono** (500): IDs, tail numbers, timestamps, thresholds, code. Tabular numerals on every number (`tnum`).
- **Scale** (fixed rem, ~1.15): 11 / 12 / 13 / 14 / 16 / 20 / 24 / 26. Weight contrast does the hierarchy work: 650 display against 400 body.
- No eyebrows or kickers. Column headers are sentence case, 12px/500 muted.

## Layout

The shell has one scroller, `#app-main`. The chrome floats over it, and `#app-main` pads itself by `--chrome-top`/`--chrome-bottom`, so content scrolls beneath the glass:
- **1024px and up**: a left nav (236px) with one group per area. Each group has a small fold chevron. Fold state is persisted per acting user in `localStorage` (`mro.nav.collapsed.<user>`). The active group always stays open. Next to it sits the floating top bar (56px).
- **Below 1024px**: the floating top bar with the primary areas, plus the sub-nav row (44px, segmented tabs with a sliding indicator).
- **Below 768px**: the primary areas move to a floating bottom tab bar.

Sticky children (table headers, bulk bar, doc TOC) use `top: 0`. The sticky view rectangle already excludes the scroller's padding, so they stop just under the chrome.

The page column is max 1280px, with 28px top padding and 24px sides (16px on phones). Section gap is 20px; spacing inside cards is 12–16px.

Responsive behaviour is structural: tables hide low-priority columns below 768px, side panels become bottom sheets under 1100px, and the primary nav becomes a bottom tab bar under 768px.

## Elevation & Shape

- **Cards** (panels, KPI cards, cockpit columns): white, 12px radius, `elevation.card`. No solid border; the first shadow layer *is* the hairline.
- **Interactive cards** (KPI links, starters, choices, lanes) lift to `elevation.raised` and translateY(−1px) on hover.
- **Floating** surfaces (sheets, palette, tooltips, jump pill) use `elevation.float`.
- **Radii** use one scale, and nothing is a sharp rectangle: 6 (kbd, code, tiny chips) · 10 (buttons, inputs, nav items) · 14 (cards, panels, toasts) · 20 (sheets, palette, dialogs) · pill. The only square corners are on edges that touch the viewport, such as the top of a bottom sheet.

## Material and motion (`styles/material.css`)

- **Glass is for floating layers only**: the top bar, sub-nav, bottom tab bar, palette, toasts (dark glass), composer and approval batch bar. Sheets use a near-solid variant (95%). Cards and tables never get glass.
- Under `prefers-reduced-transparency: reduce`, or where `backdrop-filter` is not supported, every glass layer becomes solid.
- **Sticky headers frost**. Table headers are translucent and blurred. The top bar strengthens its glass and gains a hairline once `#app-main` has scrolled more than 4px (`data-scrolled` on `.shell`).
- **Scrollbars** are thin (10px gutter, 4px rounded thumb) and stay transparent until their panel is hovered or focused. The track is always transparent, so no scrollbar line runs down the page.
- **Spring motion**: `--ease-spring` is a `linear()` curve with about 3% overshoot over 380ms. It drives sheets, the palette, dialogs, toasts, the tab indicator, the nav fold (grid-rows 0fr→1fr) and the chevrons. Without `linear()` support it falls back to ease-out.

## Components

- **Buttons**: primary is cobalt with a 1px inner top highlight and a soft drop; secondary is white with an alpha ring and an xs shadow; ghost is text-only; plus danger. Sizes: sm 30px, md 36px, lg 40px. Focus: a 3px cobalt ring at 30% alpha plus 1px solid.
- **Role-locked buttons**: a control disabled because of the acting identity (its title is a role reason such as "Viewer is read-only…" or "Only lead.engineer…") shows a lucide lock in place of its own icon. A control disabled by state (nothing selected, nothing to export) keeps its icon, so "not allowed" never looks like "not available".
- **Bulk bar** (`BulkBar`): one selection toolbar for Alerts and Fleet. Count on the left, actions, Clear (Esc), and a hint on the right. Fleet selection survives paging.
- **Chips**: 22px, 6px radius, soft tint, inset alpha ring, 12px lucide icon, 12px/500 text.
- **KPI card**:
  - label: 12px muted, with an icon;
  - value: Geist 26px, counts up on load;
  - sub-line or delta chip;
  - optional sparkline, only from a real series (never a fabricated one).
- **Data table**: 40px rows (44px on phones), sticky subtle header, alpha row dividers, hover tint, link cursor on rows, mono IDs in cobalt-ink. Long lists page on the server (Fleet: 20 per page, `page` in the URL). Below 768px the Fleet table becomes cards: id, band chip, aircraft type and cycle, and a full-width risk bar.
- **Risk bands**: Alert (at/over the threshold, red), Watch (at/over 50%, amber), Normal (green). The band comes from the API (`band`), never recomputed with a different cut in the UI.
- **Risk bar** (signature): 6px rounded track, rounded fill, 2px ink notch at the threshold, tabular value.
- **Navigation**:
  - brand mark: an ink square with the lucide plane;
  - area tabs: quiet pills;
  - sub-nav: segmented tabs with a sliding white indicator;
  - command button: "Jump to…" (Ctrl/⌘ K) opens a page palette;
  - health pill with a live dot, then the identity select;
  - approvals pill: turns amber when something is pending.
- **Copilot**:
  - agent messages carry a small avatar, and consecutive turns are grouped;
  - user messages are right-aligned cobalt-tint bubbles;
  - every tool call is ONE inline block (`ToolCallBlock`) whose state carries the lifecycle: running (spinner, cobalt ring) → needs approval / needs your answer (amber, expanded in place with the typed fields and Approve/Deny, or the options) → approved / denied → succeeded / failed. Approval is never a separate pop-up card;
  - the block body shows Arguments and Result once the call has finished;
  - pending decisions are summarised in a slim sticky footer (drafted/total count, summary, Submit, Cancel run), not in a card;
  - the composer is a single rounded field with an inline send button.
- **States**:
  - loading: skeletons shimmer, shaped like the content they replace;
  - empty: a tinted icon tile, a title and a next step;
  - error: a designed notice with retry.

## Motion

Durations are 140–200ms on `cubic-bezier(.16,1,.3,1)`, animating transform and opacity (plus shadow on hover lift). The moments:
- the tab indicator slides;
- chevrons rotate;
- KPI numbers tick up once on load (500ms);
- skeletons shimmer;
- sheets slide in.

Under `prefers-reduced-motion` everything becomes instant, and numbers render their final value immediately.

## Do / Don't

- Do draw every risk value against its threshold and print the number.
- Do give loading, empty, error and permission states a designed treatment.
- Do keep the chrome opaque and one scroll container per page.
- Don't use gradient text, glass, coloured side-stripes thicker than 2px, eyebrows, nested cards, or `transition: all`.
- Don't use emoji or unicode glyphs as icons. Use lucide only, at 1.75 stroke.
