# Policy: when to create an incident

This policy applies to every service, not just the three tracked in the
`services` table.

## When to create an incident

Create an incident only after:

1. The relevant runbook (if one exists) has been checked and, where
   applicable, its first remediation step has been attempted, **and**
2. The service remains `degraded` or `down` for more than 5 minutes after
   that attempt, **or** the status is `down` and no remediation step
   exists / is safe to attempt without human judgement.

## When *not* to create an incident

- The service is `operational`.
- The service was `degraded` but a runbook remediation step was just
  applied and it is too soon to know whether it worked (wait and re-check
  status instead).
- You have not checked `get_service_status` at all — never file an
  incident on the objective text alone without confirming current status.

## Severity selection

- `critical`: full outage (`down`) of a service that gates other services
  (e.g. auth-service).
- `high`: `down` status on a service without that gating property, or a
  `degraded` status with confirmed customer-facing impact.
- `medium`: `degraded` status with a remediation already attempted and not
  yet fully resolved.
- `low`: `degraded` status with limited or cosmetic impact.

Every `create_incident` call requires a separate human approval step before
it takes effect, regardless of severity.
