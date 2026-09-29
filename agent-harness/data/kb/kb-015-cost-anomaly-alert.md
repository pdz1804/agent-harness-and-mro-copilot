# Runbook: cost anomaly alert

**Applies to:** any service with a cloud spend alert

A cost anomaly alert is not a service-health incident by itself, but it
frequently correlates with an operational problem (a retry storm, a stuck
autoscaler, or a runaway batch job) that *is* worth investigating.

## Steps

1. Identify which resource type is driving the anomaly (compute, storage,
   egress, or a specific managed service) from the cost breakdown.
2. For compute: check whether an autoscaler is stuck scaling up without
   scaling back down — often caused by a stuck health check keeping
   instances marked as busy.
3. For egress: check for a retry storm against an external API (failed
   requests retried aggressively multiply both cost and load on the
   downstream dependency).
4. If the anomaly traces back to a genuine operational fault affecting
   service health (not just spend), follow that service's own runbook and
   consider an incident on that basis — not on cost alone.
5. Pure cost anomalies with no service-health impact should go to the
   owning team as a cost-optimization follow-up, not an incident.
