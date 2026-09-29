# Runbook: DNS resolution failures

**Applies to:** any service with external dependencies

Intermittent DNS resolution failures for an upstream dependency often look
identical to that dependency being down, but resolve completely differently.

## Steps

1. Distinguish "connection refused / timeout" (dependency likely down) from
   "could not resolve host" (DNS problem) in the error logs — the second
   pattern points here.
2. Check whether the failures are isolated to specific resolver instances
   or pods; a single bad resolver instance is common after a node
   replacement and clears itself with a resolver restart or DNS cache
   flush.
3. If failures are widespread, check for a recent DNS record change (TTL
   expiry after a cutover) rather than assuming the upstream dependency
   itself is unhealthy.
4. A short DNS TTL-driven blip (under 2 minutes, self-resolving) does not
   need an incident. Sustained resolution failures across multiple
   resolvers do.
