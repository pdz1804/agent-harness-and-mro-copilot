"""Scoring service (phase 07, part A): the synchronous core of
`POST /eval-runs` — given a set of run ids (or "every run owned by this
user"), scores each one exactly once per `judge_version` and persists the
result rows. This module owns *what* gets scored and *whether* re-scoring
is needed; it is deliberately unaware of background threads, HTTP, RBAC, or
MLflow online logging — those are the API/runner layer's job (part B),
which is expected to call `score_runs` from inside a background thread and
poll the `eval_runs` row this function creates/updates for progress.

Incremental-by-default: a run already scored under the *current*
`judge_version` is skipped unless `force=True` — `judge_version` itself
already encodes "the judge prompt version, model, and rubric code version
haven't changed" (see `eval.judge.compute_judge_version`), so this is
exactly the phase file's "re-scores only when judge_version changed or
force=True" requirement."""

from __future__ import annotations

from typing import Any, Optional

from pydantic_ai.models import Model

from agent_harness import db
from agent_harness.eval import judge as judge_module
from agent_harness.eval import metrics as metrics_module
from agent_harness.repos import evals as evals_repo
from agent_harness.repos import prompts as prompts_repo


def score_runs(
    *,
    run_ids: Optional[list[str]] = None,
    owner_id: Optional[str] = None,
    triggered_by: str,
    scope: str = "mine",
    model: Optional[Model],
    judge_model_name: str,
    force: bool = False,
    dsn: Optional[str] = None,
    precreated_eval_run_id: Optional[str] = None,
) -> dict[str, Any]:
    """Score every run in `run_ids`, or (if `run_ids` is `None`) every run
    owned by `owner_id`. Exactly one of the two must be given. Creates one
    `eval_runs` row up front (status `running`) and leaves it `completed`/
    `failed` on exit — never leaves it stuck `running`, even if an
    individual run's scoring raises (that run's error is recorded in the
    summary and scoring continues with the next run).

    `precreated_eval_run_id` (part B addition): when given, reuses that
    already-`queued` `eval_runs` row (created synchronously by the caller,
    e.g. `eval.online_runner`, so an HTTP handler can return the id
    immediately and the caller can poll it for progress) instead of creating
    a new one — the row must already exist with `status='queued'`.

    Returns a summary dict: `{eval_run_id, status, judge_version, requested,
    scored, skipped_already_scored, errors}`."""
    if run_ids is None and owner_id is None:
        raise ValueError("score_runs requires either run_ids or owner_id")

    if run_ids is None:
        runs = [r for r in db.list_runs(dsn) if r.get("owner_id") == owner_id]
        run_ids = [r["run_id"] for r in runs]

    _, prompt_version_id = prompts_repo.get_active_content("eval-judge", dsn)
    judge_version = judge_module.compute_judge_version(prompt_version_id, judge_model_name)

    target_ids = list(run_ids)
    if not force:
        already_scored = evals_repo.already_scored_run_ids(target_ids, judge_version, dsn)
        target_ids = [rid for rid in target_ids if rid not in already_scored]
    skipped_already_scored = len(run_ids) - len(target_ids)

    if precreated_eval_run_id is not None:
        eval_run = evals_repo.get_eval_run(precreated_eval_run_id, dsn)
        if eval_run is None:
            raise ValueError(f"unknown precreated_eval_run_id '{precreated_eval_run_id}'")
        evals_repo.update_eval_run_progress(eval_run["id"], done=0, dsn=dsn)
    else:
        eval_run = evals_repo.create_eval_run(
            triggered_by=triggered_by,
            scope=scope,
            judge_version=judge_version,
            judge_model=judge_model_name,
            total=len(target_ids),
            dsn=dsn,
        )
    evals_repo.update_eval_run_progress(eval_run["id"], done=0, status="running", dsn=dsn)

    scored_count = 0
    errors: list[str] = []
    for i, run_id in enumerate(target_ids):
        try:
            _score_one_run(
                eval_run_id=eval_run["id"],
                run_id=run_id,
                model=model,
                judge_version=judge_version,
                dsn=dsn,
            )
            scored_count += 1
        except Exception as exc:  # noqa: BLE001 - one bad run must not abort the batch
            errors.append(f"{run_id}: {exc}")
        finally:
            evals_repo.update_eval_run_progress(eval_run["id"], done=i + 1, dsn=dsn)

    summary = {
        "judge_version": judge_version,
        "requested": len(run_ids),
        "scored": scored_count,
        "skipped_already_scored": skipped_already_scored,
        "errors": errors,
    }
    status = "failed" if target_ids and scored_count == 0 else "completed"
    evals_repo.finish_eval_run(eval_run["id"], status=status, summary=summary, dsn=dsn)
    return {**summary, "eval_run_id": eval_run["id"], "status": status}


def _score_one_run(
    *, eval_run_id: str, run_id: str, model: Optional[Model], judge_version: str, dsn: Optional[str]
) -> None:
    run = db.get_run(run_id, dsn)
    if run is None:
        raise ValueError(f"unknown run_id '{run_id}'")

    trace_metrics = metrics_module.deterministic_metrics(run.get("history") or [])
    verdict, judge_rows = judge_module.run_judge(run, model=model, judge_version=judge_version)
    rows = judge_module.merge_metric_rows(trace_metrics, verdict, judge_rows, judge_version)

    payload = [
        {
            "run_id": run_id,
            "session_id": run.get("session_id"),
            "agent_id": run.get("agent_id"),
            "metric": row.metric,
            "score": row.score,
            "passed": row.passed,
            "rationale": row.rationale,
            "judge_version": row.judge_version,
        }
        for row in rows
    ]
    evals_repo.insert_results(eval_run_id, payload, dsn)


__all__ = ["score_runs"]
