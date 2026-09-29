# Runbook: database connection pool exhaustion

**Applies to:** any service backed by a shared Postgres cluster

Connection pool exhaustion presents as rising p95/p99 latency followed by a
wave of request timeouts, often mistaken for a database outage when the
database itself is healthy.

## Steps

1. Check the connection pool utilization metric for the affected service.
   Sustained utilization above 90% for more than 2 minutes is the signature
   of this failure mode.
2. Identify whether a recent deploy increased per-instance connection
   limits or pool size — misconfigured pool sizing after a scale-up event
   is the most common trigger.
3. Temporarily raise the max-connections limit on the Postgres cluster if
   headroom exists; this is a safe, fast mitigation while a permanent pool
   size fix is prepared.
4. If raising the limit does not stabilize latency within 5 minutes, look
   for a connection leak (long-running or abandoned transactions) rather
   than continuing to raise limits.
5. Database connection issues are rarely a single-service problem — check
   whether other services sharing the same cluster are also degraded
   before filing separate incidents for each.
