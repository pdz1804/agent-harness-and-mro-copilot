# Runbook: backup restore verification

**Applies to:** any service with scheduled datastore backups

A failed or skipped backup job is a silent risk, not an active outage — it
should be treated with urgency proportional to how long it has been since
the last *verified* good backup, not just the most recent failure.

## Steps

1. Check the backup job's last few runs, not just the most recent one — a
   single transient failure is very different from a multi-day streak.
2. Re-run the backup job manually once to rule out a transient failure
   before escalating.
3. If the manual re-run also fails, check disk space / snapshot quota on
   the target storage first — quota exhaustion is the most common
   root cause.
4. Periodically (not just after a failure) verify that the most recent
   backup is actually restorable via a test restore into an isolated
   environment; a backup that "succeeds" but produces an unrestorable
   artifact is worse than a visible failure because it hides the real risk.
5. Escalate to an incident if no verified-good backup exists within the
   service's recovery-point-objective window.
