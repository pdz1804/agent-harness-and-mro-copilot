---
id: TSM-32-LG
doc_type: tsm
ata_chapter: "32"
component_types: [LG_ACTUATOR]
fault_codes: [F005, F006]
title: TSM Fault Isolation — Landing Gear Actuator (F005, F006)
---

> **FICTIONAL — not for real maintenance.** This troubleshooting manual (TSM) entry is
> synthetic, generated for a software coding exercise, and does not correspond to any
> real aircraft troubleshooting manual. Do not use it for actual fault isolation.

## F005 — Landing gear actuator slow stroke time

**Symptom**: `stroke_time_s` telemetry trending above the fleet baseline during
retraction/extension cycles.

1. Confirm hydraulic system supply pressure is within normal limits at the time of
   the slow cycle (a system-level pressure issue can present as an actuator fault).
2. Check for internal actuator seal leakage (bypass) via the case drain check in the
   (fictional) system test task.
3. If seal bypass is confirmed, remove and replace per `AMM-32-31-00-LG-ACTUATOR`.

## F006 — Landing gear actuator excess vibration

**Symptom**: `vibration_mm_s` telemetry trending above baseline during gear cycling,
independent of stroke time.

1. Check attachment pin and bushing wear — worn bushings are the most common root
   cause and are a simple fix versus actuator replacement.
2. If bushings are within limits, suspect internal piston or rod-end wear; remove
   and replace per `AMM-32-31-00-LG-ACTUATOR`.
3. Because this is a flight-control-adjacent system, any grounding or dispatch
   decision requires certifying staff sign-off per `POL-grounding` — the PdM system
   and copilot may only recommend, never decide.

## Related

- Removal/installation: `AMM-32-31-00-LG-ACTUATOR`
- Dispatch relief: `MEL-32-01`
