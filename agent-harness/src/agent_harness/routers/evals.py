"""Eval agent routes (phase 07 part B): start/poll scoring runs, inspect
per-run metric results, and a metrics overview with trends/worst-runs/
per-agent breakdown.

RBAC: starting a scoring run (`POST /eval-runs`) requires the `run_evals`
action (admin/editor only — a viewer may read their own results but not
trigger a job, even one scoped to only their own sessions: this mirrors
`mutate_artifacts`-style gating, not resource ownership, since the action
itself consumes real LLM cost). Listing/reading eval runs and the overview
is available to every role, but non-admin callers are always restricted to
their own runs/sessions (`scope=mine` is forced server-side for them,
regardless of what the client asks for) — never trust a client-supplied
`scope=all` from a non-admin."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from pydantic_ai.models import Model

from agent_harness import settings
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.eval.online_runner import start_scoring_job
from agent_harness.llm_client import build_openai_model
from agent_harness.repos import evals as evals_repo
from agent_harness.repos import feedback as feedback_repo

router = APIRouter()

Scope = Literal["mine", "all"]


def _default_judge_model_factory() -> Optional[Model]:
    """Real demo path: `None` (honest "judge unavailable") with no
    `OPENAI_API_KEY`, never a silent fallback. Mirrors `api.py`'s
    `_llm_client_factory` pattern exactly so tests can monkeypatch
    `routers.evals._judge_model_factory` to a deterministic double instead
    of ever making a real network call."""
    if not settings.llm_configured():
        return None
    return build_openai_model()


_judge_model_factory: Callable[[], Optional[Model]] = _default_judge_model_factory


class StartEvalRunRequest(BaseModel):
    scope: Scope = "mine"
    since: Optional[str] = Field(default=None, description="ISO-8601 lower bound on run started_at.")
    limit: int = Field(default=200, ge=1, le=200)
    force: bool = False


class EvalRunSummaryView(BaseModel):
    id: str
    triggered_by: str
    scope: str
    judge_version: str
    judge_model: str
    status: str
    total: int
    done: int
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    summary: Optional[dict[str, Any]] = None
    mlflow_run_id: Optional[str] = None
    mlflow_url: Optional[str] = None
    error: Optional[str] = None
    created_at: str


class EvalResultView(BaseModel):
    id: str
    eval_run_id: str
    run_id: str
    session_id: Optional[str] = None
    agent_id: Optional[str] = None
    metric: str
    score: Optional[float] = None
    passed: Optional[bool] = None
    rationale: Optional[str] = None
    judge_version: str
    created_at: str


class EvalRunDetailView(EvalRunSummaryView):
    results: list[EvalResultView] = Field(default_factory=list)


class MetricOverviewRow(BaseModel):
    metric: str
    latest_mean: Optional[float] = None
    prev_mean: Optional[float] = None
    delta: Optional[float] = None
    n: int = 0


class SeriesPoint(BaseModel):
    date: str
    metric: str
    mean: float
    n: int


class WorstRunRow(BaseModel):
    run_id: str
    session_id: Optional[str] = None
    agent_id: Optional[str] = None
    score: float
    rationale: Optional[str] = None
    created_at: str


class AgentBreakdownRow(BaseModel):
    agent_id: Optional[str] = None
    metric: str
    mean: float
    n: int


class EvalOverviewView(BaseModel):
    days: int
    judge_available: bool
    metrics: list[MetricOverviewRow]
    series: list[SeriesPoint]
    worst_runs: list[WorstRunRow]
    by_agent: list[AgentBreakdownRow]


def _mlflow_url(mlflow_run_id: Optional[str]) -> Optional[str]:
    if not mlflow_run_id or not settings.mlflow_configured():
        return None
    base_url = settings.MLFLOW_TRACKING_URI.rstrip("/")
    return f"{base_url}/#/experiments/0/runs/{mlflow_run_id}"


def _to_summary_view(row: dict[str, Any]) -> EvalRunSummaryView:
    return EvalRunSummaryView(**row, mlflow_url=_mlflow_url(row.get("mlflow_run_id")))


def _get_visible_or_404(eval_run_id: str, user: CurrentUser) -> dict[str, Any]:
    row = evals_repo.get_eval_run(eval_run_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"unknown eval_run '{eval_run_id}'")
    if user.role != "admin" and row["triggered_by"] != user.id:
        raise HTTPException(status_code=404, detail=f"unknown eval_run '{eval_run_id}'")
    return row


@router.post("/eval-runs", response_model=EvalRunSummaryView, status_code=202)
def start_eval_run(
    request: StartEvalRunRequest, user: CurrentUser = Depends(require("run_evals"))
) -> EvalRunSummaryView:
    """Kick off a scoring job on a background thread; returns immediately
    with the `eval_runs` row (status `queued`/`running`, `done=0`) — poll
    `GET /eval-runs/{id}` for progress. `scope='all'` requires admin (a
    non-admin caller is silently narrowed to `mine`, their own sessions,
    rather than 403'd for a scope they didn't actually ask to escalate to —
    matching the phase file's "viewer may run evals on own sessions" intent,
    extended here to editor as well since both roles can trigger scoring)."""
    scope = request.scope
    if scope == "all" and user.role != "admin":
        scope = "mine"
    owner_id = None if scope == "all" else user.id

    model = _judge_model_factory()
    judge_model_name = settings.OPENAI_MODEL if model is not None else "unavailable"

    eval_run = start_scoring_job(
        owner_id=owner_id,
        triggered_by=user.id,
        scope=scope,
        model=model,
        judge_model_name=judge_model_name,
        since=request.since,
        limit=request.limit,
        force=request.force,
    )
    return _to_summary_view(eval_run)


@router.get("/eval-runs", response_model=list[EvalRunSummaryView])
def list_eval_runs(user: CurrentUser = Depends(current_user)) -> list[EvalRunSummaryView]:
    """Every eval run, most recent first — admin sees all, everyone else
    sees only jobs they triggered themselves."""
    triggered_by = None if user.role == "admin" else user.id
    rows = evals_repo.list_eval_runs(triggered_by=triggered_by)
    return [_to_summary_view(r) for r in rows]


@router.get("/eval-runs/{eval_run_id}", response_model=EvalRunDetailView)
def get_eval_run(
    eval_run_id: str,
    metric: Optional[str] = None,
    agent_id: Optional[str] = None,
    failed_only: bool = False,
    user: CurrentUser = Depends(current_user),
) -> EvalRunDetailView:
    """Progress (`done`/`total`/`status`) plus every scored metric row for
    this job, optionally filtered by `metric`/`agent_id`/`failed_only` — the
    per-run drill-down with judge rationale."""
    row = _get_visible_or_404(eval_run_id, user)
    results = evals_repo.list_results_for_eval_run(
        eval_run_id, metric=metric, agent_id=agent_id, failed_only=failed_only
    )
    return EvalRunDetailView(
        **row,
        mlflow_url=_mlflow_url(row.get("mlflow_run_id")),
        results=[EvalResultView(**r) for r in results],
    )


@router.get("/eval-metrics/overview", response_model=EvalOverviewView)
def eval_metrics_overview(
    days: int = 30, agent_id: Optional[str] = None, user: CurrentUser = Depends(current_user)
) -> EvalOverviewView:
    """Trend/aggregate view over the last `days` days: current-vs-previous
    period mean per metric, a daily time series per metric, a per-agent
    table, and the worst-scoring runs (by `task_success`) — scoped to the
    caller's own runs unless admin. Honest `judge_available=false` (no
    silent zeros) when `OPENAI_API_KEY` isn't configured for this process,
    so the UI can show an explicit "judge unavailable" state instead of an
    empty chart that looks like a bug."""
    owner_id = None if user.role == "admin" else user.id

    current_series = evals_repo.overview_series(owner_id=owner_id, since_days=days, agent_id=agent_id)
    prev_series = evals_repo.overview_series(owner_id=owner_id, since_days=days * 2, agent_id=agent_id)
    # `prev_series` covers [now-2*days, now]; subtract the current window's
    # dates to get the strictly-previous period for the delta comparison.
    current_dates = {(p["date"], p["metric"]) for p in current_series}
    prev_only = [p for p in prev_series if (p["date"], p["metric"]) not in current_dates]

    def _weighted_mean(points: list[dict[str, Any]], metric: str) -> tuple[Optional[float], int]:
        rows = [p for p in points if p["metric"] == metric]
        n = sum(int(p["n"]) for p in rows)
        if n == 0:
            return None, 0
        total = sum(float(p["mean"]) * int(p["n"]) for p in rows)
        return total / n, n

    all_metrics = sorted({p["metric"] for p in current_series} | {p["metric"] for p in prev_only})
    metrics_view: list[MetricOverviewRow] = []
    for metric in all_metrics:
        latest_mean, n = _weighted_mean(current_series, metric)
        prev_mean, _ = _weighted_mean(prev_only, metric)
        delta = (latest_mean - prev_mean) if (latest_mean is not None and prev_mean is not None) else None
        metrics_view.append(
            MetricOverviewRow(metric=metric, latest_mean=latest_mean, prev_mean=prev_mean, delta=delta, n=n)
        )

    by_agent = evals_repo.overview_by_agent(owner_id=owner_id, since_days=days)
    worst_runs = evals_repo.overview_worst_runs(
        owner_id=owner_id, since_days=days, metric="task_success", limit=10, agent_id=agent_id
    )

    return EvalOverviewView(
        days=days,
        judge_available=settings.llm_configured(),
        metrics=metrics_view,
        series=[SeriesPoint(date=str(p["date"]), metric=p["metric"], mean=p["mean"], n=p["n"]) for p in current_series],
        worst_runs=[
            WorstRunRow(
                run_id=r["run_id"],
                session_id=r.get("session_id"),
                agent_id=r.get("agent_id"),
                score=r["score"],
                rationale=r.get("rationale"),
                created_at=str(r["created_at"]),
            )
            for r in worst_runs
        ],
        by_agent=[AgentBreakdownRow(agent_id=r.get("agent_id"), metric=r["metric"], mean=r["mean"], n=r["n"]) for r in by_agent],
    )


class AgreementView(BaseModel):
    human_votes: int = Field(description="Runs with at least one human thumbs-up/down.")
    compared: int = Field(description="Of those, runs the judge also scored (task_success).")
    agree: int
    agreement_rate: Optional[float] = Field(default=None, description="agree / compared, or null with nothing to compare.")
    both_up: int
    both_down: int
    judge_up_human_down: int = Field(description="Judge passed it, the human gave a thumbs-down.")
    judge_down_human_up: int = Field(description="Judge failed it, the human gave a thumbs-up.")


@router.get("/eval-metrics/agreement", response_model=AgreementView)
def judge_human_agreement(user: CurrentUser = Depends(current_user)) -> AgreementView:
    """How often the LLM judge's pass/fail on a run matches the human
    thumbs-up/down, over runs that have both (scoped to the caller's own runs
    unless admin). The number that says whether the judge can be trusted."""
    owner_id = None if user.role == "admin" else user.id
    return AgreementView(**feedback_repo.agreement(owner_id=owner_id))
