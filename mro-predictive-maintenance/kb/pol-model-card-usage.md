---
id: POL-model-card-usage
doc_type: policy
ata_chapter: ""
component_types: []
fault_codes: []
title: Policy — Interpreting Calibrated Risk Scores and Model Limits
---

> **FICTIONAL — not for real maintenance.** This policy is synthetic, written for a
> software coding exercise, and does not represent any real operator's maintenance
> policy.

## What the risk score means

The PdM model outputs a **calibrated probability** that a component will require an
unscheduled removal within the next 30 flight cycles. "Calibrated" means that,
among components the model scores at (for example) 70%, roughly 70% are expected to
be removed within that window on held-out data — see the model card's reliability
curve and Brier/ECE metrics for the current model version.

## Limits

1. The score is a **30-flight-cycle classification**, not a remaining-useful-life
   estimate; it does not say *when* within that window a failure is more likely.
2. The model is trained on a synthetic fleet; real-world deployment would require
   revalidation against the operator's own fleet data before use as more than a
   research prototype.
3. Cold-start components (new tail, no history) receive wider uncertainty and
   should be weighted less heavily by human reviewers.
4. Model and data drift are monitored (`/monitoring/drift`); scores from a model
   flagged as drifted should be treated with reduced confidence until retrained.
5. A high score is **advisory input to a human decision**, not a maintenance action
   in itself — see `POL-grounding` and `POL-alerting`.

## Related

- `POL-alerting`, `POL-grounding`, `REL-program`
