---
id: REL-program
doc_type: reliability
ata_chapter: ""
component_types: [HYD_PUMP, APU_STARTER, LG_ACTUATOR, BLEED_VALVE, AVIONICS_FAN, CABIN_PRESS_CTRL]
fault_codes: []
title: Reliability Program — Alert Levels and MTBUR
---

> **FICTIONAL — not for real maintenance.** This reliability program description is
> synthetic, written for a software coding exercise, and does not represent any real
> operator's reliability program.

## MTBUR

Mean Time Between Unscheduled Removals, computed per component type as:

```
MTBUR = total fleet flight hours on that component type / unscheduled removals in the period
```

Reported monthly per ATA chapter / component type alongside removals per 1,000
flight hours.

## Alert levels (fictional)

Each component type has a fictional Upper Control Limit (UCL) set at the prior
12-period mean removal rate plus `k = 2` standard deviations. A period's removal
rate breaching the UCL triggers a **reliability program alert level breach**,
distinct from an individual-component PdM risk alert:

- **Component-level alert** (from the PdM model): "this specific component looks
  likely to fail soon" — see `POL-alerting`.
- **Fleet-level alert** (from the reliability program): "this component type is
  failing more often across the fleet than its historical baseline" — triggers a
  reliability review, potential root-cause investigation, or a service bulletin
  proposal in a real program.

## Use in this system

The dashboard reliability panel reports MTBUR and UCL-breach flags per component
type; the copilot may cite this document when asked about fleet-level trends
(distinct from a single tail's risk score).

## Related

- `POL-alerting`, `POL-model-card-usage`
