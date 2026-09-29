# Runbook: TLS certificate expiry

**Applies to:** any externally-facing service

An expired TLS certificate presents as a hard failure for all external
clients (`SSL handshake failed`) while internal health checks that skip TLS
verification may still report the service as healthy — a classic "internal
dashboards look fine, customers are down" mismatch.

## Steps

1. If external users report total inability to connect but internal status
   checks show `operational`, suspect certificate expiry before anything
   else.
2. Check the certificate expiry date for the affected domain directly (not
   via a cached monitoring value, which can lag).
3. Rotate to a fresh certificate via the automated cert-manager pipeline;
   this is safe to run at any time and does not require a deploy.
4. Certificate rotation typically propagates within 1-2 minutes via the
   load balancer's TLS termination layer; verify with a direct external
   connection test, not just an internal one.
5. Always create an incident for certificate expiry (severity `high` or
   `critical` depending on traffic volume) even after rotation resolves it
   — expired-cert incidents should be tracked to fix the renewal alerting
   gap that let it expire in the first place.
