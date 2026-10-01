---
id: POL-alerting
doc_type: policy
ata_chapter: ""
component_types: []
fault_codes: []
title: Policy — Acting on a Predictive Maintenance Alert
---

> **FICTIONAL — not for real maintenance.** This policy is synthetic, written for a
> software coding exercise, and does not represent any real operator's maintenance
> policy.

## Purpose

Defines how maintenance control and line staff should respond when the predictive
maintenance (PdM) system raises a risk alert on a component.

## Procedure

1. **Acknowledge within 24 hours.** Every alert must be acknowledged by a
   maintenance controller within 24 hours of being raised, even if no immediate
   action is taken.
2. **Inspect before removal.** Do not remove a healthy-appearing component on an
   alert alone. Cross-reference the alert with the relevant TSM fault-isolation
   entry (see `component_type` → TSM mapping) and perform the indicated inspection
   or operational check first.
3. **Log the outcome.** Every alert that leads to an inspection or removal must be
   closed with an outcome: `confirmed_failure`, `nff` (no fault found), or
   `not_inspected` (with a reason). This feeds the live precision and NFF-rate KPIs
   and future model retraining.
4. **Escalate high-confidence, high-consequence alerts.** Alerts on components with
   no MEL dispatch relief (e.g., landing gear actuator) should be escalated to
   certifying staff promptly, even before the 24-hour acknowledgement window
   closes.
5. **The PdM system and any copilot built on it are advisory only.** They may
   recommend an inspection or draft a work order for human approval; they never
   remove, install, ground, or release equipment themselves. See `POL-grounding`.

## Related

- `POL-work-order`, `POL-grounding`, `POL-model-card-usage`
