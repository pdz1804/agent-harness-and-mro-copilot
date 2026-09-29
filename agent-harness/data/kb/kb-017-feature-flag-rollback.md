# Runbook: feature flag rollback

**Applies to:** any service using the shared feature-flag platform

If a regression started immediately after a feature-flag rollout
percentage change (not a code deploy), a flag rollback is almost always
faster and safer than a code-level fix under time pressure.

## Steps

1. Check the feature-flag platform's change log for any rollout percentage
   or targeting change in the last 30 minutes, correlated with when the
   regression started.
2. If a match is found, roll the flag back to its previous value (or 0%)
   immediately — flag changes take effect within seconds and require no
   deploy, making this the fastest mitigation available.
3. Confirm the regression clears within 1-2 minutes of the rollback,
   matching the flag platform's propagation time.
4. If rolling back the flag does not clear the regression, the flag was
   not the cause — resume investigating as a normal deploy/config issue.
5. Only create an incident if the flag rollback fails to mitigate, or if
   the exposure window before rollback caused confirmed customer impact
   worth tracking.
