---
id: AMM-21-26-00-AVIONICS-FAN
doc_type: amm_task
ata_chapter: "21"
component_types: [AVIONICS_FAN]
fault_codes: [F011, F012]
title: Avionics Cooling Fan — Removal, Installation, Operational Test
---

> **FICTIONAL — not for real maintenance.** All task numbers, limits, and procedures in this
> knowledge base are synthetic, generated for a software coding exercise. They do not
> correspond to any real aircraft maintenance manual (AMM), and must never be used to
> service, dispatch, or maintain an actual aircraft or component.

## Applicability

Avionics bay cooling fan (fictional part family "ACF-90"), System 21/26 (Air
Conditioning / Equipment Cooling). Applies to component type `AVIONICS_FAN`.

## 1. Removal (Task AMM-21-26-00-401, fictional)

1. Confirm avionics bay ventilation system is depowered.
2. Disconnect the fan's electrical connector and the `vibration_mm_s` /
   `airflow_cfm` sensor leads.
3. Remove the duct clamp and the four mounting screws; withdraw the fan.

## 2. Installation (Task AMM-21-26-00-402, fictional)

1. Inspect the impeller for blade damage or debris ingestion before installing.
2. Mount the fan, torque mounting screws to the fictional value of 1.0–1.5 N·m.
3. Reconnect duct clamp, electrical connector, and sensor leads.

## 3. Operational test (Task AMM-21-26-00-501, fictional)

1. Power the ventilation system; confirm `airflow_cfm` telemetry reaches the
   fictional nominal band (85–110 cfm) within 30 seconds of power-on.
2. Confirm `vibration_mm_s` is within the fleet baseline; a rising trend with
   stable airflow suggests bearing wear (see `TSM-21-AVIONICS`).
3. Close the work order per `POL-work-order`.

## Related

- Fault isolation: `TSM-21-AVIONICS`
- Component type: `AVIONICS_FAN`
- No dedicated MEL item exists for this component in this fictional KB; see
  `POL-alerting` for advisory-only handling.
