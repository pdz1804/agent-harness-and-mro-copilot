---
id: TSM-29-HYD
doc_type: tsm
ata_chapter: "29"
component_types: [HYD_PUMP]
fault_codes: [F001, F002]
title: TSM Fault Isolation — Hydraulic Pump (F001, F002)
---

> **FICTIONAL — not for real maintenance.** This troubleshooting manual (TSM) entry is
> synthetic, generated for a software coding exercise, and does not correspond to any
> real aircraft troubleshooting manual. Do not use it for actual fault isolation.

## F001 — Hydraulic pump low output pressure

**Symptom**: `pressure_delta_psi` telemetry trending below the fleet baseline; crew or
PdM alert reports "low pressure" / "pump whining".

1. Confirm reservoir fluid level and no external leaks at pump case unions.
2. Check case drain flow — high case drain flow with low output pressure indicates
   internal wear (swash plate or piston wear in the fictional pump design).
3. If case drain flow is within limits, suspect a relief valve stuck open; refer to
   the (fictional) relief valve adjustment task.
4. If internal wear is confirmed, remove and replace the pump per `AMM-29-11-00-HYD-PUMP`.

## F002 — Hydraulic pump excess vibration

**Symptom**: `vibration_mm_s` telemetry trending above baseline with no corresponding
pressure fault; may sound like a whine or grinding noise on ground runs.

1. Check pump mounting bolt torque and bonding lead condition — loose mounting is the
   most common root cause of a false-positive vibration trend.
2. If mounting is confirmed tight, suspect bearing wear or cavitation from a partially
   blocked inlet screen; inspect and clean the inlet screen.
3. If vibration persists after inlet screen service, remove and replace the pump per
   `AMM-29-11-00-HYD-PUMP`.
4. Log findings (confirmed failure vs. NFF) per `POL-alerting` and `POL-work-order`.

## Related

- Removal/installation: `AMM-29-11-00-HYD-PUMP`
- Dispatch relief: `MEL-29-01`
