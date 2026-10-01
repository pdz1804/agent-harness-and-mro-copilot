"""In-process background runner for the champion/challenger retrain gate.

Wraps the real ``src.retrain.run_retrain`` (never a re-implementation of the
gate) in one background thread at a time and keeps a small in-memory job
table for status polling. Job state is lost on service restart; the durable
record of the last gate decision is ``reports/retrain_decision.json``,
written by ``run_retrain`` itself.

Safety invariants for the served (v1) champion:
* ``run_retrain`` only trains the ``realistic`` profile, which writes under
  ``reports/realistic`` / ``models/realistic`` -- never the v1 canonical files.
* Promotion (registry alias change) is opt-in per request AND requires a
  recorded champion baseline (``reports/champion_metrics.json``). Without a
  baseline the gate's "no champion -> promote unconditionally" branch is not
  a real comparison, so promotion is withheld and the job says so.
* Even a real promotion does not hot-swap the in-process model; the service
  serves the new champion only after a restart.
* Each job records whether ``reports/model_card.json`` is byte-identical
  before and after.
"""

from __future__ import annotations

import hashlib
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from src import config, retrain


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _file_digest(path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


class RetrainBusyError(RuntimeError):
    def __init__(self, run_id: str):
        super().__init__(f"a retrain job is already running: {run_id}")
        self.run_id = run_id


class RetrainJobs:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._active: str | None = None

    def start(
        self, requested_by: str, promote_if_better: bool = False, seed: int | None = None,
        runner: Callable[..., dict] | None = None, background: bool = True,
    ) -> dict:
        with self._lock:
            if self._active is not None:
                raise RetrainBusyError(self._active)
            run_id = uuid.uuid4().hex[:12]
            baseline = retrain._load_champion_metrics()
            job: dict[str, Any] = {
                "run_id": run_id,
                "status": "queued",
                "requested_by": requested_by,
                "queued_at": _now(),
                "started_at": None,
                "finished_at": None,
                "profile": "realistic",
                "seed": config.DEFAULT_SEED if seed is None else seed,
                "promote_requested": promote_if_better,
                "baseline_available": baseline is not None,
                "promote_allowed": promote_if_better and baseline is not None,
                "result": None,
                "error": None,
            }
            self._jobs[run_id] = job
            self._active = run_id

        thread = threading.Thread(
            target=self._run, args=(run_id, runner), name=f"retrain-{run_id}", daemon=True,
        )
        if background:
            thread.start()
        else:  # tests: deterministic, no thread
            thread.run()
        return self.get(run_id)  # type: ignore[return-value]

    def get(self, run_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(run_id)
            return None if job is None else dict(job)

    def _update(self, run_id: str, **fields: Any) -> None:
        with self._lock:
            self._jobs[run_id].update(fields)

    def _run(self, run_id: str, runner: Callable[..., dict] | None) -> None:
        self._update(run_id, status="running", started_at=_now())
        card_before = _file_digest(config.MODEL_CARD_JSON)
        try:
            job = self.get(run_id)
            run = runner or retrain.run_retrain
            decision = run(
                profile="realistic", seed=job["seed"], promote_if_better=job["promote_allowed"],
            )
            gate = decision["gate"]
            promoted = bool(decision.get("promoted"))
            note = None
            if not job["baseline_available"]:
                note = (
                    "no recorded champion baseline (reports/champion_metrics.json): the gate "
                    "had nothing to compare against, so nothing was promoted"
                )
            elif job["promote_requested"] and not gate["promote"]:
                note = "gate rejected the challenger; champion unchanged"
            elif decision.get("reasons_extra"):
                note = decision["reasons_extra"]
            elif not job["promote_requested"]:
                note = "dry run (promote_if_better not requested); champion unchanged"
            result = {
                "gate": gate,
                "challenger_metrics": decision["challenger_metrics"],
                "champion_metrics": decision.get("champion_metrics"),
                "targets": {
                    "recall_ci_low_slack": retrain.RECALL_CI_LOW_SLACK,
                    "max_alerts_per_100": retrain.MAX_ALERTS_PER_100,
                    "brier_slack": retrain.BRIER_SLACK,
                },
                "promoted": promoted,
                "model_version": decision.get("model_version"),
                "served_model_changed": False,  # takes effect only after a service restart
                "note": note,
                "v1_model_card_unchanged": _file_digest(config.MODEL_CARD_JSON) == card_before,
            }
            self._update(run_id, status="succeeded", result=result, finished_at=_now())
        except Exception as exc:  # noqa: BLE001 - surfaced to the poller, not swallowed
            self._update(
                run_id, status="failed", finished_at=_now(),
                error=f"{type(exc).__name__}: {exc}",
                result={"v1_model_card_unchanged": _file_digest(config.MODEL_CARD_JSON) == card_before},
            )
        finally:
            with self._lock:
                self._active = None


jobs = RetrainJobs()
