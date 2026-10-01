"""`GET /evals`: results of the offline MLflow eval suite, read in-app."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from agent_harness import settings
from agent_harness.deps import CurrentUser, current_user

router = APIRouter()


class EvalScorerResult(BaseModel):
    name: str
    mean_score: float = Field(description="Mean pass rate (0.0-1.0) across every scenario for this scorer.")


class EvalRunView(BaseModel):
    run_id: str
    run_name: str
    status: str
    start_time: Optional[str] = None
    scorers: list[EvalScorerResult]
    mlflow_url: Optional[str] = Field(
        default=None, description="Deep link to this run in the full MLflow UI for deeper inspection."
    )


@router.get("/evals", response_model=list[EvalRunView])
def list_evals(user: CurrentUser = Depends(current_user)) -> list[EvalRunView]:
    """Real MLflow eval run results — reads the phase 11c eval suite's
    `mlflow.genai.evaluate()` runs (experiment
    f"{MLFLOW_EXPERIMENT_NAME}-eval") via `MlflowClient`, so a reviewer can
    see scorer pass rates in-app instead of opening the external MLflow UI.
    Returns an empty list (not an error) if MLflow tracing isn't configured
    for this process or the eval suite hasn't produced any runs yet in that
    experiment — a genuinely unreachable configured MLflow server raises a
    502 instead, since that is a real failure rather than 'nothing to show
    yet'."""
    if not settings.mlflow_configured():
        return []

    from mlflow.tracking import MlflowClient

    client = MlflowClient(tracking_uri=settings.MLFLOW_TRACKING_URI)
    experiment_name = f"{settings.MLFLOW_EXPERIMENT_NAME}-eval"
    try:
        experiment = client.get_experiment_by_name(experiment_name)
    except Exception as exc:  # noqa: BLE001 - a genuinely unreachable MLflow server is a real 502
        raise HTTPException(status_code=502, detail="MLflow is unreachable") from exc
    if experiment is None:
        return []

    try:
        runs = client.search_runs(
            experiment_ids=[experiment.experiment_id],
            order_by=["attributes.start_time DESC"],
            max_results=25,
        )
    except Exception as exc:  # noqa: BLE001 - a genuinely unreachable MLflow server is a real 502
        raise HTTPException(status_code=502, detail="MLflow is unreachable") from exc

    base_url = settings.MLFLOW_TRACKING_URI.rstrip("/")
    out: list[EvalRunView] = []
    for run in runs:
        scorers = sorted(
            (
                EvalScorerResult(name=key.rsplit("/", 1)[0], mean_score=value)
                for key, value in run.data.metrics.items()
                if key.endswith("/mean")
            ),
            key=lambda s: s.name,
        )
        start_time = (
            datetime.fromtimestamp(run.info.start_time / 1000, tz=timezone.utc).isoformat()
            if run.info.start_time
            else None
        )
        run_name = run.data.tags.get("mlflow.runName") or run.info.run_id
        out.append(
            EvalRunView(
                run_id=run.info.run_id,
                run_name=run_name,
                status=run.info.status,
                start_time=start_time,
                scorers=scorers,
                mlflow_url=f"{base_url}/#/experiments/{experiment.experiment_id}/runs/{run.info.run_id}",
            )
        )
    return out
