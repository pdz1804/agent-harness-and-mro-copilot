---
id: TSM-21-AVIONICS
doc_type: tsm
ata_chapter: "21"
component_types: [AVIONICS_FAN]
fault_codes: [F011, F012]
title: TSM Fault Isolation — Avionics Cooling Fan (F011, F012)
---

> **FICTIONAL — not for real maintenance.** This troubleshooting manual (TSM) entry is
> synthetic, generated for a software coding exercise, and does not correspond to any
> real aircraft troubleshooting manual. Do not use it for actual fault isolation.

## F011 — Avionics fan low airflow

**Symptom**: `airflow_cfm` telemetry trending below the fleet baseline; possible
avionics overheat advisory downstream.

1. Check inlet/outlet ducting for obstruction or debris — the most common root
   cause of a low-airflow trend.
2. If ducting is clear, suspect impeller damage or motor winding degradation.
3. If confirmed, remove and replace per `AMM-21-26-00-AVIONICS-FAN`.

## F012 — Avionics fan excess vibration

**Symptom**: `vibration_mm_s` telemetry trending above baseline with airflow still
within normal range.

1. Check mounting screws and duct clamp for looseness.
2. If mounting is confirmed tight, suspect bearing wear; monitor trend and plan
   replacement before airflow degrades (early trend intervention reduces NFF risk
   per `POL-alerting`).
3. If vibration is severe or airflow begins to degrade, remove and replace per
   `AMM-21-26-00-AVIONICS-FAN`.

## Related

- Removal/installation: `AMM-21-26-00-AVIONICS-FAN`
- No dedicated MEL item exists for this component in this fictional KB.
