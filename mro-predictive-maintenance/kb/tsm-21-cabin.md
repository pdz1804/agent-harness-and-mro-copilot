---
id: TSM-21-CABIN
doc_type: tsm
ata_chapter: "21"
component_types: [CABIN_PRESS_CTRL]
fault_codes: [F009, F010]
title: TSM Fault Isolation — Cabin Pressure Controller (F009, F010)
---

> **FICTIONAL — not for real maintenance.** This troubleshooting manual (TSM) entry is
> synthetic, generated for a software coding exercise, and does not correspond to any
> real aircraft troubleshooting manual. Do not use it for actual fault isolation.

## F009 — Cabin pressure schedule deviation

**Symptom**: `pressure_delta_psi` telemetry deviates from the commanded cabin altitude
schedule; possible crew report of ear discomfort or slow cabin climb.

1. Confirm the outflow valve is not mechanically restricted (a stuck outflow valve
   can mimic a controller fault).
2. Run the controller built-in test (BIT); a fault flag confirms an internal
   controller issue.
3. If BIT confirms a fault, remove and replace per `AMM-21-51-00-CABIN-PRESS-CTRL`.

## F010 — Cabin pressure oscillation

**Symptom**: `pressure_delta_psi` telemetry oscillates around the commanded schedule
rather than tracking smoothly ("hunting").

1. Check outflow valve actuator linkage for excess free play.
2. If linkage is within limits, suspect a controller gain/calibration fault.
3. If confirmed, remove and replace per `AMM-21-51-00-CABIN-PRESS-CTRL`.
4. Any dispatch decision involving pressurization equipment requires certifying
   staff sign-off per `POL-grounding`.

## Related

- Removal/installation: `AMM-21-51-00-CABIN-PRESS-CTRL`
- Dispatch relief: see MEL section (`MEL-21-CABIN`)
