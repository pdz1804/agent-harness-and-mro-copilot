---
name: MRO Predictive Maintenance
description: Maintenance-control instrument panel. Ink chrome, paper-grey workspace, one deep-teal accent, risk drawn against its alert threshold.
colors:
  chrome: "#0E1A24"
  chrome-raised: "#1B2B38"
  chrome-text: "#E8EEF2"
  chrome-muted: "#A3B3BF"
  canvas: "#F3F5F7"
  surface: "#FFFFFF"
  surface-subtle: "#F7F9FA"
  sunken: "#ECEFF2"
  border: "#DDE2E8"
  border-strong: "#C5CDD6"
  text: "#101820"
  text-2: "#3A4753"
  muted: "#5A6772"
  accent: "#0B6B8A"
  accent-hover: "#095872"
  accent-press: "#074A60"
  accent-tint: "#E4F1F5"
  accent-border: "#A9D2DE"
  good: "#17703F"
  good-tint: "#E5F4EB"
  warn: "#8A5200"
  warn-tint: "#FDF2DC"
  bad: "#B42318"
  bad-tint: "#FDECEA"
  neutral: "#46535F"
  neutral-tint: "#ECEFF2"
  series-baseline: "#7D8B98"
typography:
  body:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
  page-title:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.25
  data:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "4px"
  md: "6px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  6: "24px"
  8: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 14px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "36px"
  chip:
    rounded: "{rounded.sm}"
    height: "22px"
---

# Design System: MRO Predictive Maintenance

## Overview

**Creative North Star: "The Maintenance Control Desk"**

A reliability engineer at a line-maintenance control desk works from a dark instrument header over a bright, paper-grey workspace. The header is solid ink and never translucent: it frames the work and nothing bleeds through it. Below it, flat bordered panels carry dense, right-aligned, tabular numbers. The single teal accent marks action and selection and nothing else. Colour is spent on one idea: *risk against its alert threshold*, always drawn the same way (a bar with a threshold notch, a dashed line with a shaded band above it).

Operate register: scanability, consistency and native expectations outrank expression. The brand is in the details: mono tail-number IDs, the threshold notch, honest labels ("no alert", "scripted", "fragile").

**Key Characteristics:**
- Solid ink chrome, grey canvas, white flat panels with 1px borders. No nested cards, no resting shadows.
- One accent (deep teal). Semantic red / amber / green only for status, always with an icon and a word.
- Inter for everything, JetBrains Mono for IDs and measurements, tabular numerals on every number.
- 13px body, 32px dense rows, 4px spacing grid.
- One scroll container per page (`#app-main`); chrome never scrolls.

## Colors

Cool, slightly teal-tinted neutrals so the accent feels native, not pasted on.

### Primary
- **Instrument Teal** (#0B6B8A): primary buttons, current selection, links, focus ring, the deployed-model series in charts. Hover #095872, press #074A60.

### Neutral
- **Ink Chrome** (#0E1A24): top bar only. Text on it #E8EEF2, secondary #A3B3BF.
- **Paper Canvas** (#F3F5F7): the page behind panels. **Panel White** (#FFFFFF): panels, tables, inputs. **Subtle** (#F7F9FA): table hover, header rows. **Sunken** (#ECEFF2): tracks, skeletons.
- **Border** (#DDE2E8) for dividers, **Border Strong** (#C5CDD6) for inputs and emphasis.
- **Text** (#101820), **Text-2** (#3A4753), **Muted** (#5A6772, 5.3:1 on canvas).

### Semantic (status only)
- Good #17703F on #E5F4EB. Warn #8A5200 on #FDF2DC. Bad #B42318 on #FDECEA. Neutral #46535F on #ECEFF2. Info reuses the accent tint.

### Named Rules
**The One Voice Rule.** Teal marks the next action or the current selection. It is never decoration and never a status.
**The Threshold Rule.** Any risk number is drawn against its alert threshold. Below 60% of threshold the bar is slate (quiet), 60-100% amber, at or above red. Low risk is not green: 300 green rows would hide the 15 that matter.
**The Not-Colour-Alone Rule.** Every status chip carries an icon shape (check, triangle, octagon, info, ring) and a word.

## Typography

**Family:** Inter Variable (self-hosted), with system fallbacks. **Data:** JetBrains Mono Variable for IDs, thresholds, timestamps in tables.

**Character:** a single well-tuned sans carries headings, labels, body and data; mono is reserved for things an engineer might copy.

### Hierarchy (fixed rem scale, ratio about 1.15)
- **Page title** (600, 20px, 1.25): one h1 per page.
- **Panel title** (600, 14px, 1.3): panel headers.
- **Body** (400, 13px, 1.45): tables, forms, prose. Prose capped at 65ch.
- **Label** (500, 12px): column headers, field labels, chips. Column headers are sentence case, not uppercase tracked.
- **Caption** (400, 11-12px, muted): provenance, units, helper text.
- **Stat** (600, 20px, tabular): the number in a stat strip. Display 24px only on Overview.

### Named Rules
**The Tabular Rule.** `font-variant-numeric: tabular-nums` on every number so columns align and values do not jitter while polling.
**The No-Eyebrow Rule.** No kicker labels above headings. The heading carries itself.

## Layout

CSS grid shell: top bar (48px, ink) / sub-nav (40px, white, only when the area has more than one page) / `#app-main` (the only scroller) / bottom tab bar (phones). Pages are a max-1280px column with 24px padding (16px on phones). Spacing steps 4, 8, 12, 16, 24, 32, 48. Related things are 8-12px apart, sections 24px.

Structure is responsive, not fluid: tables hide low-priority columns below 768px rather than scrolling sideways; side panels become bottom sheets under 1100px; the primary nav becomes a bottom tab bar under 768px. Table headers are sticky to the top of `#app-main`.

## Elevation & Depth

Flat by default. Depth comes from the border and from tonal layering (white panels on grey canvas). A shadow exists only for things that float above the page: the right sheet and bottom sheet (`0 12px 32px rgba(16,24,32,.16)`) and popovers. No glass, no blur.

## Shapes

6px radius on buttons, inputs, panels and sheets; 4px on chips, tags and table-adjacent controls. Chips are rectangular, not pills, so they read as instrument labels rather than SaaS badges. Borders are always 1px.

## Components

### Buttons
Variants: **primary** (teal, one per view), **secondary** (white + border), **ghost** (text only), **danger** (red text on white, solid on confirm), **link**. Sizes: sm 28px, md 36px, lg 40px (touch). Icon-only buttons carry `aria-label` and a tooltip. States: hover darkens one step, `:focus-visible` shows a 2px teal ring with 2px offset, active presses one step, disabled drops to 45% with `not-allowed`, loading swaps the label for "Working…" and keeps width.

### Chips
22px, 4px radius, 1px border, tinted background, leading 12px icon, 12px/500 text. Tones good / warn / bad / info / neutral.

### Panels
White, 1px border, 6px radius, no shadow. Header row (title 14/600, optional sub, actions) with a bottom divider. Never nest a panel inside a panel; use dividers and spacing.

### Data table
32px dense rows, sticky header, 1px row dividers, right-aligned tabular numbers, `aria-sort` on sortable headers, whole-row click to the detail page (the ID cell is the real link for keyboard and middle-click), hover tint, truncation with `title`, skeleton / empty / error states in place.

### Stat strip
One bordered bar split into cells by dividers. Label 12px muted, value 20px/600 tabular, sub 12px muted. It replaces rows of separate KPI cards.

### Risk bar (signature)
6px track, fill coloured by the Threshold Rule, a 2px ink notch at the alert threshold, value printed to the right. Used in every table and detail page.

### Navigation
Top bar: brand, four areas as text tabs with a 2px accent underline, then service health, identity picker, approvals pill. Sub-nav: underline tabs with count badges. Phones: bottom tab bar with icon + label; sub-nav scrolls sideways.

### Sheet
Right-hand dialog (bottom on phones). Scrim and Esc close it, focus returns, `overscroll-behavior: contain`, the body scrolls inside it.

## Do's and Don'ts

### Do:
- **Do** draw every risk value next to its threshold and print the number.
- **Do** give every state (loading, empty, error, permission) a designed treatment with a next step.
- **Do** keep one scroll container per page and the chrome opaque.
- **Do** use `transform` and `opacity` for motion, 120-200ms ease-out, and drop it under `prefers-reduced-motion`.
- **Do** write labels honestly: "scripted", "no alert", "fragile threshold".

### Don't:
- **Don't** use gradients, glass, blur, coloured side-stripes, hero-metric cards or eyebrow kickers.
- **Don't** nest cards or give resting panels a shadow.
- **Don't** rely on colour alone to carry meaning.
- **Don't** use `transition: all`, and don't animate layout properties.
- **Don't** put a modal where an inline card or a sheet works.
