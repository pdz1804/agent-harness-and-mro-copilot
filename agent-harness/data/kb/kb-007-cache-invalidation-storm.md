# Runbook: cache invalidation storm

**Applies to:** any service with a shared read-through cache

A cache invalidation storm happens when a bulk write (backfill, migration,
or bug) invalidates a large fraction of cache keys at once, sending a burst
of traffic directly to the origin datastore.

## Steps

1. Check origin datastore load. A sudden multi-times spike in query volume
   with a matching drop in cache hit rate confirms an invalidation storm
   rather than a genuine traffic spike.
2. Identify the triggering write — check for recently completed backfill
   jobs, bulk admin actions, or a deploy that changed the cache key schema
   (which invalidates every existing key implicitly).
3. Enable request coalescing / origin rate limiting if available, so
   duplicate cache-miss requests for the same key don't each hit the
   origin independently.
4. Allow the cache to naturally repopulate; forcing a full cache warm
   during an active storm usually makes origin load worse, not better.
5. If origin load does not recede within 10 minutes or the origin
   datastore itself starts failing requests, that is now a datastore
   capacity incident, not a caching issue — escalate accordingly.
