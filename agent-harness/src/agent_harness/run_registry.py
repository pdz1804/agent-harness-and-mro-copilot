"""In-memory run registry + Event-based approval callback adapter for the
async HTTP run flow (`POST /runs` -> `GET /runs/{id}` -> `POST
/runs/{id}/approve`).

This backs the API's real pause/resume approval gate (see `api.py`'s
module docstring and `docs/design-report.md` section 6 for the design
this replaces). Each run gets one background `threading.Thread` running
`AgentLoop.run(...)` to completion; when the loop hits an approval-gated
tool, the callback built here records the pending tool call against the
run and blocks the background thread on a `threading.Event` until
`resolve_approval` is called (or the run's own wall-clock budget runs
out, at which point a forgotten approval is treated as denied so the
thread cannot hang forever).

This is deliberately a single-process, in-memory store (`dict` + locks),
not Celery/Redis/a database — appropriate for a single demo backend
driving one UI, not a production job queue. See "Known limitations" in
`docs/design-report.md`.
"""

from __future__ import annotations

import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Optional

from agent_harness import db
from agent_harness.config import HarnessConfig
from agent_harness.llm_client import LLMClient
from agent_harness.loop import AgentLoop
from agent_harness.schemas import AgentEvent, RunResult

# Mirrors `agent_harness.schemas.RunStatus` plus two states that only ever
# exist in this in-memory registry (never in a persisted `RunResult`):
# `pending_approval` (mid-run, waiting on a human) and `failed` (the
# background thread raised an unexpected exception — a defensive state so a
# bug here surfaces as a visible run status instead of hanging silently).
AsyncRunStatus = Literal[
    "running",
    "pending_approval",
    "completed",
    "step_limit_exceeded",
    "time_limit_exceeded",
    "llm_error_exceeded",
    "failed",
]


@dataclass
class PendingApproval:
    """One in-flight approval request, waiting for a human decision."""

    tool_name: str
    tool_args: dict[str, Any]
    event: threading.Event = field(default_factory=threading.Event)
    decision: Optional[bool] = None


@dataclass
class RunRecord:
    """Live state for one async run, mutated by the background thread and
    read by the API's GET handlers. All reads/writes go through `lock`."""

    run_id: str
    objective: str
    started_at: float
    trace_path: str
    lock: threading.Lock = field(default_factory=threading.Lock)
    status: AsyncRunStatus = "running"
    history: list[AgentEvent] = field(default_factory=list)
    pending_approval: Optional[PendingApproval] = None
    result: Optional[RunResult] = None
    error: Optional[str] = None
    # Per-connection SSE subscriber queues (see RunRegistry.subscribe). Each
    # queue receives every AgentEvent recorded after subscription, plus a
    # `None` sentinel once the run reaches a terminal status so the SSE
    # endpoint can close the connection instead of hanging forever.
    subscribers: list["queue.Queue[Optional[AgentEvent]]"] = field(default_factory=list)


class RunRegistry:
    """Owns background-thread run execution and exposes live snapshots."""

    def __init__(self, default_runs_dir: Path | str = "runs") -> None:
        self._runs: dict[str, RunRecord] = {}
        self._lock = threading.Lock()
        self._default_runs_dir = Path(default_runs_dir)

    def start_run(
        self,
        objective: str,
        llm_client: LLMClient,
        config: Optional[HarnessConfig] = None,
        runs_dir: Optional[Path] = None,
    ) -> RunRecord:
        """Create a run record and start it executing on a background
        thread. Returns immediately with the initial (running) record."""
        run_id = uuid.uuid4().hex[:12]
        cfg = config or HarnessConfig()
        effective_runs_dir = Path(runs_dir) if runs_dir is not None else self._default_runs_dir
        trace_path = str(effective_runs_dir / f"{run_id}.jsonl")

        record = RunRecord(
            run_id=run_id,
            objective=objective,
            started_at=time.time(),
            trace_path=trace_path,
        )
        with self._lock:
            self._runs[run_id] = record

        # Persist immediately so `GET /runs` reflects this run (as
        # `running`) even before any event has streamed in, and so a crash
        # mid-run still leaves a recoverable `running` row rather than no
        # row at all.
        self._persist_run(record)

        approval_callback = self._make_approval_callback(record, cfg)

        def _on_event(event: AgentEvent) -> None:
            with record.lock:
                record.history.append(event)
                # `TraceLogger.log` invokes this synchronously *before*
                # `_request_approval` (loop.py) goes on to call
                # `approval_callback` below. Without this, the
                # `approval_requested` SSE event reaches the frontend (and
                # triggers its one-shot re-fetch of `GET /runs/{id}`)
                # while `record.status` is still "running" — a race the
                # frontend has no way to recover from, since it only
                # re-fetches once per `approval_requested` event. Flip the
                # status here, synchronously, before the event is ever
                # pushed to a subscriber, so any snapshot fetched in
                # reaction to this event is already authoritative. The
                # approval callback below reuses this same `PendingApproval`
                # (same `threading.Event`) rather than creating a second
                # one, so `resolve_approval` still unblocks the right wait.
                if event.event_type == "approval_requested":
                    data = event.data or {}
                    record.pending_approval = PendingApproval(
                        tool_name=data.get("tool_name", ""),
                        tool_args=data.get("args", {}),
                    )
                    record.status = "pending_approval"
                subscribers = list(record.subscribers)
            for q in subscribers:
                try:
                    q.put_nowait(event)
                except queue.Full:  # noqa: BLE001 - a slow/stuck SSE client must never block a run
                    pass
            try:
                db.append_event(
                    run_id=run_id,
                    step=event.step,
                    event_type=event.event_type,
                    timestamp=event.timestamp,
                    latency_ms=event.latency_ms,
                    data=event.data,
                )
            except Exception:  # noqa: BLE001 - a persistence bug must never break a live run
                pass

        loop = AgentLoop(
            llm_client=llm_client,
            config=cfg,
            approval_callback=approval_callback,
            runs_dir=effective_runs_dir,
            on_event=_on_event,
        )

        def _worker() -> None:
            try:
                result = loop.run(objective, run_id=run_id)
            except Exception as exc:  # noqa: BLE001 - background thread must never die silently
                with record.lock:
                    record.status = "failed"
                    record.error = str(exc)
                self._persist_run(record)
                self._close_subscribers(record)
                return
            with record.lock:
                record.result = result
                record.status = result.status
                record.pending_approval = None
            self._persist_run(record)
            self._close_subscribers(record)

        thread = threading.Thread(target=_worker, name=f"agent-run-{run_id}", daemon=True)
        thread.start()
        return record

    def _close_subscribers(self, record: RunRecord) -> None:
        """Push the terminal sentinel to every live SSE subscriber queue so
        `GET /runs/{id}/events` connections close instead of hanging."""
        with record.lock:
            subscribers = list(record.subscribers)
            record.subscribers.clear()
        for q in subscribers:
            try:
                q.put_nowait(None)
            except queue.Full:  # noqa: BLE001
                pass

    def subscribe(self, run_id: str) -> Optional["queue.Queue[Optional[AgentEvent]]"]:
        """Register a new SSE subscriber queue for `run_id`. Returns None if
        the run is unknown. If the run has already reached a terminal
        status, the queue is immediately given the closing sentinel so the
        caller's stream ends right away instead of hanging."""
        record = self.get(run_id)
        if record is None:
            return None
        q: "queue.Queue[Optional[AgentEvent]]" = queue.Queue(maxsize=1000)
        with record.lock:
            terminal = record.status not in ("running", "pending_approval")
            if not terminal:
                record.subscribers.append(q)
        if terminal:
            q.put_nowait(None)
        return q

    def unsubscribe(self, run_id: str, q: "queue.Queue[Optional[AgentEvent]]") -> None:
        record = self.get(run_id)
        if record is None:
            return
        with record.lock:
            if q in record.subscribers:
                record.subscribers.remove(q)

    def _persist_run(self, record: RunRecord) -> None:
        with record.lock:
            status = record.status
            result = record.result
            error = record.error
        try:
            db.upsert_run(
                {
                    "run_id": record.run_id,
                    "objective": record.objective,
                    "status": status,
                    "started_at": record.started_at,
                    "finished_at": time.time() if result is not None or error is not None else None,
                    "final_answer": result.final_answer if result is not None else None,
                    "steps_taken": result.steps_taken if result is not None else 0,
                    "trace_path": record.trace_path,
                    "error": error,
                }
            )
        except Exception:  # noqa: BLE001 - a persistence bug must never break a live run
            pass

    def _make_approval_callback(self, record: RunRecord, config: HarnessConfig):
        def _callback(tool_name: str, tool_args: dict[str, Any]) -> bool:
            # `_on_event` (above) already set `record.pending_approval` and
            # flipped `record.status` to "pending_approval" synchronously
            # when the `approval_requested` trace event was logged, one
            # call earlier in `_request_approval` (loop.py). Reuse that
            # same object (and its `threading.Event`) so `resolve_approval`
            # — which reads/mutates `record.pending_approval` — resolves
            # the wait this thread is about to block on, instead of a
            # second, disconnected `PendingApproval`. Fall back to
            # constructing one here only if that didn't happen (e.g. a
            # future caller invokes this callback without going through
            # the trace logger first).
            with record.lock:
                pending = record.pending_approval
                if pending is None or pending.tool_name != tool_name:
                    pending = PendingApproval(tool_name=tool_name, tool_args=tool_args)
                    record.pending_approval = pending
                record.status = "pending_approval"

            # Bound the wait by the run's remaining wall-clock budget so a
            # forgotten approval click cannot hang the background thread
            # past `max_wall_clock_seconds` (the same limit the loop itself
            # already enforces for total run time).
            elapsed = time.time() - record.started_at
            remaining = max(0.0, config.max_wall_clock_seconds - elapsed)
            resolved_in_time = pending.event.wait(timeout=remaining)

            with record.lock:
                record.pending_approval = None
                record.status = "running"

            if not resolved_in_time:
                # Timed out: treat as a denial so the loop can converge to a
                # final_answer (or the wall-clock check on the next
                # iteration) instead of hanging forever.
                return False
            return bool(pending.decision)

        return _callback

    def resolve_approval(self, run_id: str, approved: bool) -> None:
        """Resolve the pending approval for `run_id`, unblocking its
        background thread. Raises KeyError if the run is unknown and
        ValueError if it has no pending approval right now."""
        record = self.get(run_id)
        if record is None:
            raise KeyError(f"unknown run_id '{run_id}'")
        with record.lock:
            pending = record.pending_approval
        if pending is None:
            raise ValueError(f"run '{run_id}' has no pending approval")
        pending.decision = approved
        pending.event.set()

    def get(self, run_id: str) -> Optional[RunRecord]:
        with self._lock:
            return self._runs.get(run_id)

    def list_runs(self) -> list[RunRecord]:
        """Most-recently-started first."""
        with self._lock:
            records = list(self._runs.values())
        return sorted(records, key=lambda r: r.started_at, reverse=True)

    def snapshot(self, run_id: str) -> Optional[dict[str, Any]]:
        """Plain-dict snapshot of a run's current state, safe to hand to a
        pydantic response model. Returns None if `run_id` is unknown."""
        record = self.get(run_id)
        if record is None:
            return None
        with record.lock:
            history = list(record.history)
            pending = record.pending_approval
            status = record.status
            result = record.result
            error = record.error
        steps_taken = result.steps_taken if result is not None else (history[-1].step if history else 0)
        final_answer = result.final_answer if result is not None else None
        return {
            "run_id": record.run_id,
            "objective": record.objective,
            "status": status,
            "started_at": record.started_at,
            "steps_taken": steps_taken,
            "final_answer": final_answer,
            "pending_approval": (
                {"tool_name": pending.tool_name, "tool_args": pending.tool_args}
                if pending is not None
                else None
            ),
            "history": history,
            "trace_path": record.trace_path,
            "error": error,
        }

    def summary(self, record: RunRecord) -> dict[str, Any]:
        """Lightweight dict for the run-history list endpoint."""
        with record.lock:
            status = record.status
        return {
            "run_id": record.run_id,
            "objective": record.objective,
            "status": status,
            "started_at": record.started_at,
        }


def persisted_summary(row: dict[str, Any]) -> dict[str, Any]:
    """Shape a `db.list_runs()` row into the same dict shape as
    `RunRegistry.summary()`, for runs from a previous process (restart
    survival) that are no longer held in memory."""
    return {
        "run_id": row["run_id"],
        "objective": row["objective"],
        "status": row["status"],
        "started_at": row["started_at"],
    }


def persisted_snapshot(row: dict[str, Any]) -> dict[str, Any]:
    """Shape a `db.get_run()` row (run + its events) into the same dict
    shape as `RunRegistry.snapshot()`."""
    return {
        "run_id": row["run_id"],
        "objective": row["objective"],
        "status": row["status"],
        "started_at": row["started_at"],
        "steps_taken": row["steps_taken"] or 0,
        "final_answer": row["final_answer"],
        "pending_approval": None,
        "history": row["history"],
        "trace_path": row["trace_path"],
        "error": row["error"],
    }
