# Runbook: rate-limiting and 429 spikes

**Applies to:** any externally-facing API

A sudden spike in `429 Too Many Requests` responses is not automatically a
service health problem — it may be the rate limiter correctly protecting
the service from an abusive or misbehaving client.

## Steps

1. Identify whether the 429s are concentrated on a small number of
   API keys/clients (likely a single misbehaving integration) or spread
   across many clients (likely the rate limit threshold itself is
   misconfigured too low after a traffic-pattern change).
2. For a single misbehaving client: contact the client owner and, if
   necessary, apply a temporary tighter per-key limit rather than changing
   the global threshold.
3. For a broad, evenly-distributed spike: check whether legitimate traffic
   has grown (e.g. a new feature launch) and the global limit needs a
   one-time increase.
4. Do not create an incident purely for elevated 429 rates if the
   underlying service's own status remains `operational` — 429s are the
   rate limiter working as intended, not a service outage.
