# Policy: postmortem template

**Applies to:** any incident that reached `high` or `critical` severity

Every incident created at `high` or `critical` severity gets a postmortem
within 2 business days of resolution, written by the incident's primary
responder with input from anyone who took a remediation action.

## Required sections

1. **Summary** — one paragraph: what broke, user-facing impact, duration.
2. **Timeline** — timestamped sequence of detection, remediation attempts,
   and resolution, in the order they actually happened (not idealized).
3. **Root cause** — the actual underlying cause, distinct from the
   triggering event (e.g. "connection pool exhaustion after a traffic
   increase", not just "latency spiked").
4. **What went well / what went poorly** — honest assessment of detection
   time, runbook usefulness, and escalation speed.
5. **Follow-up actions** — concrete, owned, dated action items; a
   postmortem with no follow-up actions is considered incomplete.

Postmortems are blameless: the goal is fixing systems and processes, not
identifying an individual to blame for the incident.
