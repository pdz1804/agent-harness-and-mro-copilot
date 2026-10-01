---
id: AMM-36-11-00-BLEED-VALVE
doc_type: amm_task
ata_chapter: "36"
component_types: [BLEED_VALVE]
fault_codes: [F007, F008]
title: Engine Bleed Valve — Removal, Installation, Operational Test
---

> **FICTIONAL — not for real maintenance.** All task numbers, limits, and procedures in this
> knowledge base are synthetic, generated for a software coding exercise. They do not
> correspond to any real aircraft maintenance manual (AMM), and must never be used to
> service, dispatch, or maintain an actual aircraft or component.

## Applicability

Engine bleed air regulating/shutoff valve (fictional part family "BV-540"), System 36
(Pneumatic). Applies to component type `BLEED_VALVE`.

## 1. Removal (Task AMM-36-11-00-401, fictional)

1. Confirm the engine bleed system is depressurized and cooled to ambient before
   starting work.
2. Disconnect the valve actuator electrical connector and the
   `temperature_delta_c` / `pressure_delta_psi` sensor leads.
3. Remove the duct clamps upstream and downstream of the valve.
4. Remove the valve mounting bolts and withdraw the valve; cap open ducts.

## 2. Installation (Task AMM-36-11-00-402, fictional)

1. Inspect duct flange gaskets; replace on every removal.
2. Install the valve, torque mounting bolts to the fictional value of 25–30 N·m.
3. Reconnect actuator connector and sensor leads; verify actuator continuity with a
   manual actuation check (valve open/close) before engine start.

## 3. Operational test (Task AMM-36-11-00-501, fictional)

1. With engine running at the fictional test power setting, confirm valve
   modulation follows commanded position within the fictional tolerance of ±5%.
2. Confirm `temperature_delta_c` and `pressure_delta_psi` telemetry track the
   commanded schedule with no sustained deviation; investigate per `TSM-36-BLEED`
   if out of band.
3. Close the work order per `POL-work-order`.

## Related

- Fault isolation: `TSM-36-BLEED`
- Dispatch relief: `MEL-36-01`
- Component type: `BLEED_VALVE`
