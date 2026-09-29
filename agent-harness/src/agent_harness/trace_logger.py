"""Structured JSON-lines trace logger: one line per AgentEvent, written
immediately (not buffered) so a trace is inspectable even if a run hangs
or crashes mid-execution."""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional

from agent_harness.schemas import AgentEvent


class TraceLogger:
    """Appends each AgentEvent as one JSON line to `runs/<run_id>.jsonl`.

    `on_event`, if given, is invoked synchronously with every event right
    after it is persisted to disk. This is the observer seam the async API
    run registry (`run_registry.py`) uses to mirror live progress into an
    in-memory snapshot for `GET /runs/{run_id}` polling, without inventing a
    second history format. It is optional and unused by the CLI/sync API
    path, so existing behavior is unchanged when omitted.
    """

    def __init__(
        self,
        run_id: str,
        runs_dir: Optional[Path] = None,
        on_event: Optional[Callable[[AgentEvent], None]] = None,
    ) -> None:
        self.run_id = run_id
        self.runs_dir = Path(runs_dir) if runs_dir is not None else Path("runs")
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.runs_dir / f"{run_id}.jsonl"
        self._history: list[AgentEvent] = []
        self._on_event = on_event

    def log(self, event: AgentEvent) -> None:
        self._history.append(event)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(event.model_dump_json())
            fh.write("\n")
        if self._on_event is not None:
            try:
                self._on_event(event)
            except Exception:  # noqa: BLE001 - an observer bug must never break the run
                pass

    @property
    def history(self) -> list[AgentEvent]:
        return list(self._history)
