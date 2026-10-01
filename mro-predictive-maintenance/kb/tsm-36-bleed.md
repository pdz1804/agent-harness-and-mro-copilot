---
id: TSM-36-BLEED
doc_type: tsm
ata_chapter: "36"
component_types: [BLEED_VALVE]
fault_codes: [F007, F008]
title: TSM Fault Isolation — Engine Bleed Valve (F007, F008)
---

> **FICTIONAL — not for real maintenance.** This troubleshooting manual (TSM) entry is
> synthetic, generated for a software coding exercise, and does not correspond to any
> real aircraft troubleshooting manual. Do not use it for actual fault isolation.

## F007 — Bleed valve temperature deviation

**Symptom**: `temperature_delta_c` telemetry deviates from the commanded schedule
during engine operation.

1. Confirm the upstream duct and pre-cooler are not the source of the deviation
   (a pre-cooler fault can present identically to a valve fault at the sensor level).
2. Check valve actuator response to a manual command input; sluggish or absent
   response points to actuator wear.
3. If actuator response is confirmed faulty, remove and replace per
   `AMM-36-11-00-BLEED-VALVE`.

## F008 — Bleed valve pressure deviation

**Symptom**: `pressure_delta_psi` telemetry deviates from the commanded schedule,
often paired with an audible surge on engine spool-up.

1. Check for duct leakage downstream of the valve — a leak can cause a pressure
   deviation that looks like a valve fault.
2. If ducts are sound, inspect the valve poppet/seat for wear or FOD.
3. If confirmed, remove and replace per `AMM-36-11-00-BLEED-VALVE`.
4. Log outcome (confirmed vs. NFF) per `POL-alerting`.

## Related

- Removal/installation: `AMM-36-11-00-BLEED-VALVE`
- Dispatch relief: `MEL-36-01`
