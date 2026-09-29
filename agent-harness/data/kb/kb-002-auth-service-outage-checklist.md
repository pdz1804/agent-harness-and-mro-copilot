# Runbook: auth-service outage checklist

**Applies to:** auth-service
**Severity guidance:** critical (down), medium (degraded)

auth-service outages are almost always caused by session-store connection
exhaustion, not the auth-service application code itself.

## Steps

1. Confirm status via `get_service_status` for `auth-service`.
2. Check the session-store (Redis) connection pool utilization. If it is
   pinned at 100% and login/token requests are failing, this is the
   session-store exhaustion pattern.
3. Restart the auth-service connection pool (`auth-pool-reset` job) before
   filing an incident — this resolves the exhaustion pattern in the vast
   majority of cases within 60 seconds and does not require a full service
   restart.
4. If the pool reset does not restore `operational` status within 5
   minutes, or if auth-service is `down` (not merely `degraded`), create an
   incident immediately: authentication outages block every downstream
   service that depends on user sessions.
5. Severity: use `critical` if `down` (total login outage), `medium` if
   `degraded` and the pool reset has already been attempted without full
   recovery.
