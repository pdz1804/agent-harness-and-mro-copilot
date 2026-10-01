"""Background-thread orchestration for `POST /eval-runs` (phase 07 part B).

Mirrors `RunRegistry`'s pattern (`run_registry.py`): a synchronous
pre-resolution step (figure out exactly which runs will be scored + create
the `eval_runs` row so its id is known immediately) followed by a daemon
`threading.Thread` that does the slow part (LLM judge calls via
`eval.scoring.score_runs`) and updates that same row's progress as it goes.
`GET /eval-runs/{id}` (routers/evals.py) polls the row this module creates.

Also logs the aggregate outcome to MLflow (one run per scoring job, in the
`"{MLFLOW_EXPERIMENT_NAME}-online-eval"` experiment) when MLflow tracing is
configured — kept entirely separate from the existing offline
`mlflow.genai.evaluate()` suite's `"{name}-eval"` experiment (`GET /evals`),
so the UI's "Offline suite" section keeps showing exactly what it showed
before this phase."""

from __future__ import annotations

import threading
from typing import Any, Optional

from pydantic_ai.models import Model

from agent_harness import db, settings
from agent_harness.eval import judge as judge_module
from agent_harness.eval.scoring import score_runs
from agent_harness.repos import evals as evals_repo
from agent_harness.repos import prompts as prompts_repo


def _resolve_target_run_ids(
    *, owner_id: Optional[str], since: Optional[str], limit: Optional[int], dsn: Optional[str] = None
) -> list[str]:
    """`owner_id=None` means every run in the system ("all" scope, admin
    only — enforced by the router, not here). `since` is an ISO-8601
    timestamp lower bound on `started_at`; `limit` caps the count, most
    recently started first (the phase file's `since?`/`limit<=200`)."""
    runs = db.list_runs(dsn)
    if owner_id is not None:
        runs = [r for r in runs if r.get("owner_id") == owner_id]
    if since is not None:
        runs = [r for r in runs if (r.get("started_at") or "") >= since]
    runs = sorted(runs, key=lambda r: r.get("started_at") or "", reverse=True)
    if limit is not None:
        runs = runs[:limit]
    return [r["run_id"] for r in runs]


def start_scoring_job(
    *,
    owner_id: Optional[str],
    triggered_by: str,
    scope: str,
    model: Optional[Model],
    judge_model_name: str,
    since: Optional[str] = None,
    limit: Optional[int] = None,
    force: bool = False,
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    """Resolve the target run set, create the `eval_runs` row synchronously
    (so its id + total are accurate and known immediately), start scoring on
    a background thread, and return the freshly created row (`status`
    `queued`, `done=0`). Never blocks on the actual judge calls."""
    run_ids = _resolve_target_run_ids(owner_id=owner_id, since=since, limit=limit, dsn=dsn)

    _, prompt_version_id = prompts_repo.get_active_content("eval-judge", dsn)
    judge_version = judge_module.compute_judge_version(prompt_version_id, judge_model_name)

    target_ids = run_ids
    if not force:
        already_scored = evals_repo.already_scored_run_ids(run_ids, judge_version, dsn)
        target_ids = [rid for rid in run_ids if rid not in already_scored]

    eval_run = evals_repo.create_eval_run(
        triggered_by=triggered_by,
        scope=scope,
        judge_version=judge_version,
        judge_model=judge_model_name,
        total=len(target_ids),
        dsn=dsn,
    )

    def _worker() -> None:
        try:
            summary = score_runs(
                run_ids=run_ids,
                triggered_by=triggered_by,
                scope=scope,
                model=model,
                judge_model_name=judge_model_name,
                force=force,
                dsn=dsn,
                precreated_eval_run_id=eval_run["id"],
            )
        except Exception as exc:  # noqa: BLE001 - background thread must never die silently
            evals_repo.finish_eval_run(eval_run["id"], status="failed", error=str(exc), dsn=dsn)
            return
        _log_to_mlflow(eval_run["id"], summary, dsn=dsn)

    thread = threading.Thread(target=_worker, name=f"eval-run-{eval_run['id']}", daemon=True)
    thread.start()
    return eval_run


def _log_to_mlflow(eval_run_id: str, summary: dict[str, Any], *, dsn: Optional[str]) -> None:
    """Log this scoring job's aggregate metrics to the configured MLflow
    tracking server, in a dedicated `"{name}-online-eval"` experiment so it
    never collides with the existing offline `mlflow.genai.evaluate()` suite
    (`"{name}-eval"`, still shown as-is in `GET /evals`). Best-effort: a
    failure here (including a genuinely unreachable server — the phase 07a
    hang fix bounds that to seconds, not minutes) must never leave an
    otherwise-successful scoring job stuck non-terminal or raise out of the
    background thread."""
    if not settings.mlflow_configured():
        return
    try:
        import mlflow

        experiment_name = f"{settings.MLFLOW_EXPERIMENT_NAME}-online-eval"
        mlflow.set_tracking_uri(settings.MLFLOW_TRACKING_URI)
        mlflow.set_experiment(experiment_name)
        results = evals_repo.list_results_for_eval_run(eval_run_id, dsn=dsn)
        means: dict[str, list[float]] = {}
        for row in results:
            if row.get("score") is not None:
                means.setdefault(row["metric"], []).append(row["score"])
        with mlflow.start_run(run_name=f"eval-run-{eval_run_id}") as run:
            mlflow.log_param("eval_run_id", eval_run_id)
            mlflow.log_param("judge_version", summary.get("judge_version"))
            mlflow.log_param("scope", summary.get("status"))
            mlflow.log_metric("scored", summary.get("scored", 0))
            mlflow.log_metric("skipped_already_scored", summary.get("skipped_already_scored", 0))
            mlflow.log_metric("errors", len(summary.get("errors") or []))
            for metric, values in means.items():
                mlflow.log_metric(f"{metric}_mean", sum(values) / len(values))
            mlflow_run_id = run.info.run_id
        evals_repo.finish_eval_run(
            eval_run_id,
            status="completed" if summary.get("status") == "completed" else "failed",
            summary=summary,
            mlflow_run_id=mlflow_run_id,
            error=None,
        )
    except Exception as exc:  # noqa: BLE001 - MLflow logging must never break a completed scoring job
        # The scoring job itself already reached a terminal status inside
        # `score_runs`; re-finish it here only to attach the error note
        # (status/summary are preserved, not overwritten to something worse).
        current = evals_repo.get_eval_run(eval_run_id, dsn=dsn)
        status = current["status"] if current else "completed"
        evals_repo.finish_eval_run(
            eval_run_id,
            status=status,
            summary=summary,
            error=f"mlflow logging failed: {exc}",
        )


__all__ = ["start_scoring_job"]
