# Runbook: secrets rotation breakage

**Applies to:** any service consuming a rotated credential

A service that suddenly starts failing auth against one specific downstream
dependency, with no code deploy involved, should immediately raise
suspicion of a secrets rotation that this service was not updated for.

## Steps

1. Check the secrets-manager audit log for any rotation events in the last
   30 minutes affecting credentials this service uses.
2. Confirm whether the service's runtime environment (env vars / mounted
   secret volume) has picked up the new secret value — some deployment
   platforms require a pod restart to pick up a rotated secret even though
   the secret store itself updated instantly.
3. If the service has not picked up the new value, trigger a rolling
   restart of the affected deployment to force a fresh secret mount.
4. If the service already has the new value and is still failing, the
   rotation itself may have been incomplete (e.g. the downstream service
   was not updated with the new credential) — coordinate with the
   downstream service owner rather than repeatedly restarting.
