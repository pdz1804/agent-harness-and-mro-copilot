---
id: POL-work-order
doc_type: policy
ata_chapter: ""
component_types: []
fault_codes: []
title: Policy — Work Order Lifecycle and Approval
---

> **FICTIONAL — not for real maintenance.** This policy is synthetic, written for a
> software coding exercise, and does not represent any real operator's maintenance
> policy.

## Work order states

`open -> planned -> in_work -> closed`, with a `finding` recorded at closure:
`confirmed_failure | nff | not_inspected`.

## Priorities (fictional)

- **P1 (urgent)**: no-relief MEL item, or repeated alert within 48 hours.
- **P2 (routine)**: MEL relief available (category B/C) or first-time alert on a
  non-flight-critical component.
- **P3 (deferred)**: advisory-only component with no MEL item (e.g., avionics
  cooling fan trend) and low immediate risk.

## Approval

1. A work order may be **drafted** automatically by the PdM copilot from an alert,
   but it moves from `draft` to `open` only after a human maintenance planner or
   controller approves it. No automated path creates an approved, actionable work
   order without this step.
2. Priority downgrades/upgrades require a controller signature (recorded actor +
   timestamp).
3. Closure requires a finding; `confirmed_failure` findings feed the reliability
   program (`REL-program`) and model retraining; `nff` findings feed the NFF-rate
   KPI.

## Related

- `POL-alerting`, `POL-grounding`, `REL-program`
