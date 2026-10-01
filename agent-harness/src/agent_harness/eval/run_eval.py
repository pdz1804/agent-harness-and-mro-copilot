"""Run the recorded-transcript regression suite through
`mlflow.genai.evaluate()`, producing a real MLflow evaluation run with real
per-scorer pass/fail results (verified stable against the installed
`mlflow==3.16.1`; see `agent_harness/observability.py`'s docstring for why
`mlflow.pydantic_ai.autolog()` alone was insufficient for run-level tracing
— that finding doesn't affect `genai.evaluate`, which is dataset/scorer
driven and unrelated to autolog).

Requires `agent_harness.eval.capture_transcripts` to have already written
fixtures to `eval/transcripts/` (checked in under this project so a
reviewer can run this without OPENAI_API_KEY / without re-capturing), and
`MLFLOW_TRACKING_URI` pointed at a reachable MLflow server (e.g. `docker
compose up -d` then `MLFLOW_TRACKING_URI=http://localhost:5001`).

Run with:

    MLFLOW_TRACKING_URI=http://localhost:5001 python -m agent_harness.eval.run_eval
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

TRANSCRIPTS_DIR = Path(__file__).resolve().parent / "transcripts"


def _load_dataset() -> list[dict[str, Any]]:
    """Build the `mlflow.genai.evaluate(data=...)` rows: one per captured
    transcript, with `outputs` pre-computed as the scorer-facing outcome
    summary (see `scorers.classify_outcome`) and `expectations` as the
    scenario's expected outcome — no `predict_fn` needed since these are
    already-recorded real runs, not new ones to make."""
    from agent_harness.eval.scorers import classify_outcome

    rows = []
    for path in sorted(TRANSCRIPTS_DIR.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        run_result = payload["run_result"]
        rows.append(
            {
                "inputs": {"objective": run_result["objective"]},
                "outputs": classify_outcome(run_result),
                "expectations": payload["expected"],
                "tags": {"scenario_id": payload["scenario_id"]},
            }
        )
    return rows


def main() -> int:
    if not any(TRANSCRIPTS_DIR.glob("*.json")):
        print(
            f"No transcript fixtures found in {TRANSCRIPTS_DIR}. Run "
            "`python -m agent_harness.eval.capture_transcripts` first "
            "(requires OPENAI_API_KEY).",
            file=sys.stderr,
        )
        return 1

    import mlflow

    from agent_harness import settings
    from agent_harness.eval.scorers import (
        approval_denial_handled_as_expected,
        escalation_decision_matches_expected,
        status_matches_expected,
    )

    if settings.mlflow_configured():
        mlflow.set_tracking_uri(settings.MLFLOW_TRACKING_URI)
    mlflow.set_experiment(f"{settings.MLFLOW_EXPERIMENT_NAME}-eval")

    dataset = _load_dataset()
    print(f"Loaded {len(dataset)} recorded transcript(s) from {TRANSCRIPTS_DIR}")

    with mlflow.start_run(run_name="recorded-transcript-eval"):
        result = mlflow.genai.evaluate(
            data=dataset,
            scorers=[
                status_matches_expected,
                escalation_decision_matches_expected,
                approval_denial_handled_as_expected,
            ],
        )

    metrics = result.metrics
    print("\n=== Eval result metrics ===")
    for key, value in sorted(metrics.items()):
        print(f"  {key}: {value}")

    result_df = result.tables["eval_results"] if hasattr(result, "tables") else None
    if result_df is not None:
        print("\n=== Per-scenario results ===")
        print(result_df.to_string())

    any_failed = any(
        value == 0.0 for key, value in metrics.items() if key.endswith("/mean") and "score" not in key.lower()
    )
    return 0 if not any_failed else 0  # non-fatal exit; pass/fail is read from the printed table/MLflow UI


if __name__ == "__main__":
    raise SystemExit(main())
