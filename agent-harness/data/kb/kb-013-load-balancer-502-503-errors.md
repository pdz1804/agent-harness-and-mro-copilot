# Runbook: load balancer 502/503 errors

**Applies to:** any service behind the shared load balancer

`502 Bad Gateway` means the load balancer could not get a valid response
from any backend at all (backend crashed or unreachable). `503 Service
Unavailable` usually means backends are reachable but all marked unhealthy
or over capacity — these two point to different root causes.

## Steps

1. Check backend target health in the load balancer's own health-check
   view first; do not assume the application is broken until you've
   confirmed whether backends are even registered as healthy.
2. For `502`: check if backend instances are still running at all (crashed
   process, pod restart loop) — the load balancer literally has nothing to
   forward to.
3. For `503`: check backend capacity/concurrency limits; this is common
   during a traffic spike or after a rolling deploy briefly reduces
   available replica count below the minimum needed.
4. A rolling deploy that temporarily dips available capacity and
   self-recovers within 1-2 minutes does not need an incident. Sustained
   502/503s beyond a normal deploy window do.
