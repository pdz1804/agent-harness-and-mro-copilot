# Runbook: search-index rebuild procedure

**Applies to:** search-index
**Severity guidance:** high (down), low (degraded/stale)

A `down` status on search-index typically means the nightly index rebuild
job failed partway through, leaving the index in an inconsistent or
unloadable state — it is very rarely a live-traffic capacity problem.

## Steps

1. Confirm status via `get_service_status` for `search-index`.
2. Check the rebuild pipeline's last run in the job scheduler. A `failed`
   or `stuck` status there confirms the rebuild-failure root cause.
3. Re-trigger the rebuild pipeline manually (`search-index-rebuild --full`)
   and monitor for 15 minutes; a full rebuild typically completes in
   8-12 minutes.
4. If the rebuild completes successfully but the service does not return to
   `operational`, restart the search-index query nodes to force them to
   pick up the new index generation.
5. Create an incident if the rebuild itself fails twice in a row, or if
   search-index remains `down` more than 20 minutes after a rebuild attempt
   — this indicates a data problem in the source corpus, not a transient
   pipeline issue, and needs the search-platform team.
