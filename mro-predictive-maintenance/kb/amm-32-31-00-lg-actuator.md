---
id: AMM-32-31-00-LG-ACTUATOR
doc_type: amm_task
ata_chapter: "32"
component_types: [LG_ACTUATOR]
fault_codes: [F005, F006]
title: Landing Gear Actuator — Removal, Installation, Operational Test
---

> **FICTIONAL — not for real maintenance.** All task numbers, limits, and procedures in this
> knowledge base are synthetic, generated for a software coding exercise. They do not
> correspond to any real aircraft maintenance manual (AMM), and must never be used to
> service, dispatch, or maintain an actual aircraft or component.

## Applicability

Main landing gear retraction actuator (fictional part family "LGA-770"), System 32
(Landing Gear). Applies to component type `LG_ACTUATOR`.

## 1. Removal (Task AMM-32-31-00-401, fictional)

1. Install the ground safety pin/lock on the affected gear and relieve hydraulic
   pressure to the actuator per the local isolation procedure.
2. Disconnect the actuator's upper and lower attachment pins after supporting the
   gear leg.
3. Disconnect the `vibration_mm_s` and `stroke_time_s` telemetry sensor leads.
4. Remove the actuator; cap open hydraulic ports immediately.

## 2. Installation (Task AMM-32-31-00-402, fictional)

1. Inspect attachment bushings and pins for wear; replace if outside the fictional
   wear limit of 0.15 mm radial clearance.
2. Install the actuator, torque attachment pins to the fictional value of 60–70 N·m,
   and safety-wire per standard practice.
3. Reconnect hydraulic lines and sensor leads; bleed air from the actuator circuit.

## 3. Operational test (Task AMM-32-31-00-501, fictional)

1. Perform a gear retraction/extension cycle test with the aircraft on jacks.
   Fictional nominal `stroke_time_s` is 6.5–8.0 seconds full travel.
2. Confirm no abnormal `vibration_mm_s` signature during travel versus fleet
   baseline; investigate per `TSM-32-LG` if stroke time or vibration is out of band.
3. Remove ground locks/pins, close the work order per `POL-work-order`.

## Related

- Fault isolation: `TSM-32-LG`
- Dispatch relief: `MEL-32-01`
- Component type: `LG_ACTUATOR`
