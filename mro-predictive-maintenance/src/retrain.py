"""Champion/challenger retrain CLI.

Usage (from the project root, with the venv active):
    python -m src.retrain                          # train a challenger, report gate result, do not promote
    python -m src.retrain --promote-if-better       # also set alias `champion` -> challenger if the gate passes

Scope (deliberate): this CLI only operates on ``--profile realistic``. The
``v1`` profile is the frozen, byte-for-byte reproducible headline result
(see ``reports/phase-01b-artifact-separation-report.md``) and must never be
touched by an automated retrain loop -- ``--profile v1`` is rejected with a
clear error rather than silently retrained.

Gate (phase-02 requirement #3): challenger promotes over the current
champion only if ALL of:
  1. challenger recall_ci_low >= champion recall_ci_low - 0.02
  2. challenger component-window alerts/100 <= 5
  3. challenger Brier (post-calibration) <= champion Brier + 0.005
  4. no leakage assertion failed while training the challenger (pipeline.run
     already asserts this internally via ``splitting.assert_no_leakage``;
     if that raises, this CLI reports a hard failure, not a gate rejection)

Champion metrics baseline: read from ``reports/champion_metrics.json``,
written by this module whenever alias ``champion`` is (re)assigned. If that
file does not exist yet (first-ever promotion), the challenger is promoted
unconditionally -- there is no champion to beat.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Optional

from src import config, pipeline, tracking

CHAMPION_METRICS_JSON = config.REPORTS_DIR / "champion_metrics.json"
RETRAIN_DECISION_JSON = config.REPORTS_DIR / "retrain_decision.json"

RECALL_CI_LOW_SLACK = 0.02
MAX_ALERTS_PER_100 = 5.0
BRIER_SLACK = 0.005


def extract_gate_metrics(card: dict) -> dict:
    """Pull the four gate inputs out of a realistic-profile model card."""
    ci = card.get("ci") or {}
    recall_ci = ci.get("recall_ci") or [float("nan"), float("nan")]
    alert_rate = card.get("alert_rate") or {}
    calibration = card.get("calibration") or {}
    return {
        "recall_ci_low": float(recall_ci[0]),
        "component_window_alerts_per_100": float(
            alert_rate.get("component_window_alerts_per_100", float("nan"))
        ),
        "brier": float(calibration.get("brier_post", float("nan"))),
    }


def evaluate_gate(champion_metrics: Optional[dict], challenger_metrics: dict) -> dict:
    """Pure function: no MLflow, no filesystem. ``champion_metrics is None``
    means "no existing champion" -- always promotes. Returns
    ``{"promote": bool, "reasons": [...]}`` with one reason string per gate
    check (pass or fail), so the decision is fully auditable.
    """
    if champion_metrics is None:
        return {
            "promote": True,
            "reasons": ["no existing champion metrics found; promoting unconditionally"],
        }

    reasons = []
    checks = []

    recall_floor = champion_metrics["recall_ci_low"] - RECALL_CI_LOW_SLACK
    recall_ok = challenger_metrics["recall_ci_low"] >= recall_floor
    checks.append(recall_ok)
    reasons.append(
        f"recall_ci_low: challenger={challenger_metrics['recall_ci_low']:.4f} "
        f"vs champion_floor={recall_floor:.4f} (champion={champion_metrics['recall_ci_low']:.4f} "
        f"- {RECALL_CI_LOW_SLACK}) -> {'PASS' if recall_ok else 'FAIL'}"
    )

    alerts_ok = challenger_metrics["component_window_alerts_per_100"] <= MAX_ALERTS_PER_100
    checks.append(alerts_ok)
    reasons.append(
        f"alerts_per_100: challenger={challenger_metrics['component_window_alerts_per_100']:.4f} "
        f"vs budget={MAX_ALERTS_PER_100} -> {'PASS' if alerts_ok else 'FAIL'}"
    )

    brier_ceiling = champion_metrics["brier"] + BRIER_SLACK
    brier_ok = challenger_metrics["brier"] <= brier_ceiling
    checks.append(brier_ok)
    reasons.append(
        f"brier: challenger={challenger_metrics['brier']:.4f} vs "
        f"champion_ceiling={brier_ceiling:.4f} (champion={champion_metrics['brier']:.4f} "
        f"+ {BRIER_SLACK}) -> {'PASS' if brier_ok else 'FAIL'}"
    )

    return {"promote": all(checks), "reasons": reasons}


def _load_champion_metrics(path: Path = CHAMPION_METRICS_JSON) -> Optional[dict]:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _save_champion_metrics(metrics: dict, path: Path = CHAMPION_METRICS_JSON) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")


def run_retrain(
    profile: str = "realistic", seed: int = config.DEFAULT_SEED,
    promote_if_better: bool = False,
) -> dict:
    if profile != "realistic":
        raise ValueError(
            "src.retrain only supports --profile realistic; v1 is the frozen, "
            "reproducible headline result and must never be auto-retrained."
        )

    result = pipeline.run(seed=seed, profile=profile)
    challenger_card = result["card"]
    challenger_metrics = extract_gate_metrics(challenger_card)

    champion_metrics = _load_champion_metrics()
    gate = evaluate_gate(champion_metrics, challenger_metrics)

    decision = {
        "profile": profile,
        "seed": seed,
        "challenger_metrics": challenger_metrics,
        "champion_metrics": champion_metrics,
        "gate": gate,
        "promoted": False,
        "promote_if_better": promote_if_better,
        "model_version": None,
    }

    if promote_if_better and gate["promote"]:
        primary_name = result["primary_model"]
        primary = result["model_results"][primary_name]
        tracking.init_tracking()
        log_result = tracking.log_training_run(
            profile=profile,
            seed=seed,
            served_policy=primary["served_policy"],
            params={
                "model_id": primary_name,
                "threshold": primary["served_threshold"],
                "calibration_method": primary["calibration"].get("method"),
            },
            metrics={
                "test_recall": primary["test_at_threshold"]["recall"],
                "test_precision": primary["test_at_threshold"]["precision"],
                "test_alerts_per_100": primary["test_at_threshold"]["alerts_per_100"],
                "component_window_alerts_per_100": challenger_metrics["component_window_alerts_per_100"],
                "brier_post": challenger_metrics["brier"],
                "recall_ci_low": challenger_metrics["recall_ci_low"],
            },
            artifact_paths=[
                config.REALISTIC_MODEL_CARD_JSON,
                config.REALISTIC_REPORTS_DIR / "metrics_table.md",
            ],
            sklearn_pipeline=primary["calibrated_model"],
            input_example=result["train_df"].head(3),
            register=True,
            alias=None,  # decide alias explicitly below, after we have a version
        )
        if log_result is not None and log_result.get("model_version"):
            version = log_result["model_version"]
            # Demote the outgoing champion to `previous` before promoting the
            # challenger, so there is always a one-step rollback target.
            tracking.set_alias(champion_metrics.get("model_version"), "previous") if (
                champion_metrics and champion_metrics.get("model_version")
            ) else None
            tracking.set_alias(version, "champion")
            decision["promoted"] = True
            decision["model_version"] = version
            _save_champion_metrics({**challenger_metrics, "model_version": version})
        else:
            decision["reasons_extra"] = "gate passed but MLflow registration unavailable; not promoted"

    RETRAIN_DECISION_JSON.parent.mkdir(parents=True, exist_ok=True)
    RETRAIN_DECISION_JSON.write_text(json.dumps(decision, indent=2) + "\n", encoding="utf-8")
    print(f"[retrain] gate promote={gate['promote']} promoted={decision['promoted']}")
    for reason in gate["reasons"]:
        print(f"[retrain]   {reason}")
    return decision


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=["realistic"], default="realistic")
    parser.add_argument("--seed", type=int, default=config.DEFAULT_SEED)
    parser.add_argument("--promote-if-better", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    _args = _parse_args()
    run_retrain(profile=_args.profile, seed=_args.seed, promote_if_better=_args.promote_if_better)
