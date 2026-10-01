---
id: AMM-49-21-00-APU-STARTER
doc_type: amm_task
ata_chapter: "49"
component_types: [APU_STARTER]
fault_codes: [F003, F004]
title: APU Starter Motor — Removal, Installation, Operational Test
---

> **FICTIONAL — not for real maintenance.** All task numbers, limits, and procedures in this
> knowledge base are synthetic, generated for a software coding exercise. They do not
> correspond to any real aircraft maintenance manual (AMM), and must never be used to
> service, dispatch, or maintain an actual aircraft or component.

## Applicability

Auxiliary Power Unit (APU) starter motor (fictional part family "AS-1200"), System 49
(APU). Applies to component type `APU_STARTER`.

## 1. Removal (Task AMM-49-21-00-401, fictional)

1. Confirm APU master switch OFF and battery bus isolated per standard electrical
   safety procedure.
2. Disconnect the starter motor power feeder and the `current_draw_amp` /
   `temperature_delta_c` sensor leads used by the PdM telemetry pipeline.
3. Remove the drive-shaft coupling bolts and the three case mounting bolts.
4. Withdraw the starter motor from the APU gearbox housing; cap the gearbox opening.

## 2. Installation (Task AMM-49-21-00-402, fictional)

1. Inspect the drive coupling spline and gearbox seal; replace seal on every
   installation.
2. Mount the starter, torque case bolts to the fictional value of 18–22 N·m.
3. Reconnect the power feeder and sensor leads; verify sensor continuity before
   closing panels.

## 3. Operational test (Task AMM-49-21-00-501, fictional)

1. Perform an APU start per the normal start sequence. Monitor `current_draw_amp`
   during the start cycle; the fictional nominal peak is 180–210 A with decay to
   idle draw within 12 seconds.
2. Confirm `temperature_delta_c` returns to baseline within the fictional post-start
   cooldown window; sustained elevated delta indicates a possible bearing or brush
   fault (see `TSM-49-APU`).
3. Log start count and time to stabilize; close the work order per `POL-work-order`.

## Related

- Fault isolation: `TSM-49-APU`
- Dispatch relief: `MEL-49-01`
- Component type: `APU_STARTER`
