# Runbook: message queue backlog

**Applies to:** any service with an asynchronous worker queue

A growing queue backlog is a leading indicator, not yet an outage — the
producing service is usually still `operational` while the backlog builds,
which can create a false sense that nothing is wrong.

## Steps

1. Check the consumer group's processing rate versus the producer's publish
   rate. A backlog grows whenever consumption falls behind production, even
   if consumers are running.
2. Check for a recent consumer deploy or config change that reduced worker
   concurrency — this is the most common cause of a sudden backlog growth
   rate change.
3. Scale out consumer workers if the queue supports horizontal consumption
   and the bottleneck is throughput, not a stuck/poison message.
4. Check for a poison message (one message repeatedly failing and blocking
   the partition/queue) if the backlog is not draining at all despite
   healthy-looking consumers.
5. Escalate to an incident once the backlog's projected drain time exceeds
   your service's freshness SLA, not merely because the backlog number is
   non-zero.
