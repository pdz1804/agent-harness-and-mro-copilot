---
id: TSM-49-APU
doc_type: tsm
ata_chapter: "49"
component_types: [APU_STARTER]
fault_codes: [F003, F004]
title: TSM Fault Isolation — APU Starter Motor (F003, F004)
---

> **FICTIONAL — not for real maintenance.** This troubleshooting manual (TSM) entry is
> synthetic, generated for a software coding exercise, and does not correspond to any
> real aircraft troubleshooting manual. Do not use it for actual fault isolation.

## F003 — APU starter excess current draw

**Symptom**: `current_draw_amp` telemetry trending above baseline during start;
starter takes longer than usual to bring the APU to idle.

1. Check starter electrical connector for corrosion or loose pins — a high-resistance
   connection can mimic a starter fault by causing voltage drop and compensatory
   current draw.
2. If the connector is serviceable, suspect brush wear or bearing drag inside the
   starter motor.
3. If confirmed, remove and replace the starter per `AMM-49-21-00-APU-STARTER`.

## F004 — APU starter slow spool / thermal soak

**Symptom**: `temperature_delta_c` telemetry fails to return to baseline after start
within the expected cooldown window ("APU starter running hot").

1. Confirm ambient bay temperature is not itself elevated (heat soak from adjacent
   equipment can produce a false trend).
2. Check for restricted cooling airflow to the starter/gearbox bay.
3. If thermal trend persists with normal ambient and airflow, suspect internal
   winding or bearing degradation; remove and replace per `AMM-49-21-00-APU-STARTER`.
4. Log outcome per `POL-alerting`.

## Related

- Removal/installation: `AMM-49-21-00-APU-STARTER`
- Dispatch relief: `MEL-49-01`
