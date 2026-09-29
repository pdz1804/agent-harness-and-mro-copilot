# Runbook: Kubernetes pod CrashLoopBackOff

**Applies to:** any containerized service

A pod stuck in `CrashLoopBackOff` almost always has the actual root cause
in its own logs from the previous crashed attempt — check that before
touching the deployment.

## Steps

1. Check `kubectl logs <pod> --previous` (the crashed container's logs, not
   the new restarting one) for the actual exception/panic.
2. Common causes in order of frequency: missing/invalid config or secret
   after a rotation, a failing readiness/liveness probe with too aggressive
   a timeout, or an out-of-memory kill (`OOMKilled` in pod events).
3. For `OOMKilled`: check whether traffic or payload size increased
   recently before simply raising the memory limit — raising the limit
   without understanding the cause just delays the next OOM.
4. For a bad config/secret: roll back the config change rather than editing
   the running pod directly.
5. If only a subset of pods are crash-looping (not the whole deployment),
   suspect a specific bad node rather than the application itself.
