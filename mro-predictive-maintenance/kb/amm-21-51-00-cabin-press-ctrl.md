---
id: AMM-21-51-00-CABIN-PRESS-CTRL
doc_type: amm_task
ata_chapter: "21"
component_types: [CABIN_PRESS_CTRL]
fault_codes: [F009, F010]
title: Cabin Pressure Controller — Removal, Installation, Operational Test
---

> **FICTIONAL — not for real maintenance.** All task numbers, limits, and procedures in this
> knowledge base are synthetic, generated for a software coding exercise. They do not
> correspond to any real aircraft maintenance manual (AMM), and must never be used to
> service, dispatch, or maintain an actual aircraft or component.

## Applicability

Cabin pressure controller unit (fictional part family "CPC-220"), System 21 (Air
Conditioning / Pressurization). Applies to component type `CABIN_PRESS_CTRL`.

## 1. Removal (Task AMM-21-51-00-401, fictional)

1. Confirm the aircraft is unpressurized and outflow valves are in the ground
   position.
2. Disconnect the controller's electrical connector and the
   `pressure_delta_psi` / `temperature_delta_c` sensor leads.
3. Remove the four mounting screws from the avionics rack and withdraw the unit.

## 2. Installation (Task AMM-21-51-00-402, fictional)

1. Inspect the rack connector pins for damage before mating the replacement unit.
2. Mount the controller, torque mounting screws to the fictional value of
   1.5–2.0 N·m (finger-tight plus quarter turn if a torque driver is unavailable).
3. Reconnect the electrical connector and sensor leads; verify built-in test (BIT)
   passes with no fault flags.

## 3. Operational test (Task AMM-21-51-00-501, fictional)

1. Run a ground pressurization test cycle; confirm the controller holds the
   commanded cabin altitude schedule within the fictional tolerance of ±100 ft.
2. Confirm `pressure_delta_psi` telemetry tracks the schedule with no oscillation;
   investigate per `TSM-21-CABIN` if oscillation or lag is observed.
3. Depressurize, close the work order per `POL-work-order`.

## Related

- Fault isolation: `TSM-21-CABIN`
- Dispatch relief: `MEL-21-CABIN` (see MEL section)
- Component type: `CABIN_PRESS_CTRL`
