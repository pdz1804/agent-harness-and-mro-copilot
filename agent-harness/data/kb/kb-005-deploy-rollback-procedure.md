# Runbook: deploy rollback procedure

**Applies to:** any service that just received a deploy

If a service's status degrades within 15 minutes of a deploy (`last_deploy`
close to `last_checked`), treat the deploy as the prime suspect before
investigating anything else.

## Steps

1. Compare `last_deploy` and `last_checked` timestamps for the affected
   service. A gap under 15 minutes strongly suggests deploy-induced
   regression.
2. Check the deploy's change list for schema migrations, config changes, or
   dependency version bumps — these cause the large majority of
   deploy-triggered incidents.
3. Roll back to the previous known-good release using the standard
   `deploy-rollback <service> <previous-version>` procedure. Rollback is
   preferred over a forward-fix under time pressure because it is faster
   and better understood.
4. After rollback, re-check status after 3-5 minutes to confirm recovery
   before closing out.
5. If status does not recover after rollback, the deploy was not the root
   cause — escalate through the normal incident-creation policy instead of
   attempting a second rollback.
