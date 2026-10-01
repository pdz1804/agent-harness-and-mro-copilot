---
id: AMM-29-11-00-HYD-PUMP
doc_type: amm_task
ata_chapter: "29"
component_types: [HYD_PUMP]
fault_codes: [F001, F002]
title: Hydraulic Pump — Removal, Installation, Operational Test
---

> **FICTIONAL — not for real maintenance.** All task numbers, limits, and procedures in this
> knowledge base are synthetic, generated for a software coding exercise. They do not
> correspond to any real aircraft maintenance manual (AMM), and must never be used to
> service, dispatch, or maintain an actual aircraft or component.

## Applicability

Engine-driven hydraulic pump (fictional part family "HP-3300"), System 29 (Hydraulic
Power). Applies to component type `HYD_PUMP` as tracked by the reliability program.

## 1. Removal (Task AMM-29-11-00-401, fictional)

1. Depressurize the affected hydraulic system per the (fictional) system
   depressurization task and confirm zero residual pressure on the local gauge.
2. Tag and cap all fluid lines at the pump case to prevent contamination.
3. Disconnect the electrical bonding lead and the pressure/temperature sensor harness
   (`vibration_mm_s`, `pressure_delta_psi` telemetry channels feed the PdM model — leave
   disconnected only for the duration of the removal).
4. Remove the four mounting nuts and withdraw the pump from the gearbox pad. Support the
   pump weight before the last nut is removed.
5. Fit a blanking cover to the gearbox drive pad.

## 2. Installation (Task AMM-29-11-00-402, fictional)

1. Inspect the drive pad splines and seal seat for damage; replace the pump seal.
2. Mount the replacement or repaired pump, torque mounting nuts to the fictional value
   of 45–50 N·m in a star pattern.
3. Reconnect fluid lines, bonding lead, and sensor harness. Verify harness continuity.
4. Re-pressurize the system per standard procedure and check for leaks at all unions for
   five minutes minimum.

## 3. Operational test (Task AMM-29-11-00-501, fictional)

1. Run the system per the ground operational test profile; confirm pump output pressure
   is within the fictional nominal band (2,950–3,100 psi) with `pressure_delta_psi`
   telemetry stable (no sustained deviation beyond the model's calibrated alert band).
2. Confirm case drain flow and pump case temperature are within limits; no abnormal
   vibration signature versus the fleet baseline for `vibration_mm_s`.
3. Record the operational test result and close the associated work order per
   `POL-work-order`.

## Related

- Fault isolation: `TSM-29-HYD`
- Dispatch relief: `MEL-29-01`
- Component type: `HYD_PUMP`
