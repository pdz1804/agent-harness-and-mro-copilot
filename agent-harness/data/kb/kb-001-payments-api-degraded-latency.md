# Runbook: payments-api degraded latency

**Applies to:** payments-api
**Severity guidance:** medium (degraded), high (down)

When payments-api reports `degraded` status, the most common root cause is
the downstream card-processor webhook queue backing up. Check the queue
depth dashboard first before escalating to the payments team.

## Steps

1. Check `get_service_status` for `payments-api` to confirm current status
   and last-checked timestamp.
2. Inspect the card-processor webhook queue depth. Depths above 5,000
   pending messages reliably correlate with the p95 latency spike seen in
   this failure mode.
3. If the queue is draining on its own (depth decreasing over 2-3 minutes),
   monitor rather than escalate — this is usually a transient upstream
   burst from the card processor, not an internal fault.
4. If the queue is not draining after 5 minutes, restart the
   `payments-webhook-consumer` deployment; this clears stuck consumer
   connections without touching in-flight payment state.
5. Only create an incident if latency remains degraded after the consumer
   restart, or if payments-api transitions to `down`.
