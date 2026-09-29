"""End-to-end training/evaluation entry point.

Usage (from the project root, with the venv active):
    python -m src.pipeline

Requires ``data/generate_dataset.py`` to have been run first so the raw
CSVs exist under ``data/raw/``. Builds the model table if it is missing
or stale, fits both models on a leakage-safe train split, sweeps
thresholds on validation, applies the selected threshold to test, and
writes:
    reports/metrics_table.md              comparison table (this run)
    reports/threshold_sweep_<model>.csv   full sweep per model
    reports/feature_importance_<model>.csv
    reports/high_risk_examples.md         local explanations, top test rows
    models/<model>.joblib                 fitted pipelines
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src import config, evaluation, explainability, features, modeling, splitting  # noqa: E402


def load_or_build_model_table() -> pd.DataFrame:
    if config.MODEL_TABLE_CSV.exists():
        return pd.read_csv(config.MODEL_TABLE_CSV, parse_dates=["snapshot_date", "delivery_date"])

    if not config.CYCLE_SNAPSHOTS_CSV.exists():
        raise FileNotFoundError(
            "No raw data found. Run `python data/generate_dataset.py` first "
            f"(expected {config.CYCLE_SNAPSHOTS_CSV})."
        )

    aircraft, components, snapshots, faults, maint = features.load_raw_tables()
    table = features.build_model_table(aircraft, components, snapshots, faults, maint)
    config.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    table.to_csv(config.MODEL_TABLE_CSV, index=False)
    return table


def run(seed: int = config.DEFAULT_SEED) -> dict:
    config.REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    config.MODELS_DIR.mkdir(parents=True, exist_ok=True)

    table = load_or_build_model_table()
    print(f"Model table: {len(table)} rows, {table['label'].mean() * 100:.3f}% positive")

    train_df, val_df, test_df, boundaries = splitting.time_group_split(table)
    splitting.assert_no_leakage(train_df, val_df, test_df)
    print(
        f"Split -> train {len(train_df)} rows / {boundaries['n_train_groups']} aircraft, "
        f"val {len(val_df)} rows / {boundaries['n_val_groups']} aircraft, "
        f"test {len(test_df)} rows / {boundaries['n_test_groups']} aircraft"
    )
    print(
        f"  train delivery max={boundaries['train_delivery_max'].date()}  "
        f"val delivery range=[{boundaries['val_delivery_min'].date()}, "
        f"{boundaries['val_delivery_max'].date()}]  "
        f"test delivery min={boundaries['test_delivery_min'].date()}"
    )
    print(
        f"  positive rows -> train {int(train_df['label'].sum())}, "
        f"val {int(val_df['label'].sum())}, test {int(test_df['label'].sum())}"
    )

    models = modeling.build_models(seed=seed)
    results = {}

    for name, pipeline in models.items():
        print(f"\n=== {name} ===")
        modeling.fit_model(pipeline, train_df)

        val_scores = modeling.predict_scores(pipeline, val_df)
        test_scores = modeling.predict_scores(pipeline, test_df)

        val_summary = evaluation.summary_metrics(val_df["label"].to_numpy(), val_scores)
        test_summary = evaluation.summary_metrics(test_df["label"].to_numpy(), test_scores)

        sweep = evaluation.threshold_sweep(val_df["label"].to_numpy(), val_scores)
        sweep.to_csv(config.REPORTS_DIR / f"threshold_sweep_{name}.csv", index=False)

        chosen = evaluation.select_operating_threshold(sweep)
        test_at_threshold = evaluation.apply_threshold(
            test_df["label"].to_numpy(), test_scores, chosen["threshold"]
        )

        joblib.dump(pipeline, config.MODELS_DIR / f"{name}.joblib")

        results[name] = {
            "pipeline": pipeline,
            "val_summary": val_summary,
            "test_summary": test_summary,
            "chosen_threshold": chosen,
            "test_at_threshold": test_at_threshold,
            "val_scores": val_scores,
            "test_scores": test_scores,
        }

        print(f"  val  ROC-AUC={val_summary['roc_auc']:.4f}  PR-AUC={val_summary['pr_auc']:.4f}")
        print(f"  test ROC-AUC={test_summary['roc_auc']:.4f}  PR-AUC={test_summary['pr_auc']:.4f}")
        print(
            f"  chosen threshold (selected on val)={chosen['threshold']:.4f} "
            f"[{chosen['status']}]"
        )
        print(
            f"  TEST at that threshold: recall={test_at_threshold['recall']:.4f}  "
            f"precision={test_at_threshold['precision']:.4f}  "
            f"alerts/100={test_at_threshold['alerts_per_100']:.2f}  "
            f"(target: recall>={config.TARGET_RECALL}, alerts/100<={config.TARGET_ALERTS_PER_100})"
        )

    # Comparison table.
    rows = []
    for name, r in results.items():
        rows.append({
            "model": name,
            "val_roc_auc": r["val_summary"]["roc_auc"],
            "val_pr_auc": r["val_summary"]["pr_auc"],
            "test_roc_auc": r["test_summary"]["roc_auc"],
            "test_pr_auc": r["test_summary"]["pr_auc"],
            "chosen_threshold": r["chosen_threshold"]["threshold"],
            "threshold_status": r["chosen_threshold"]["status"],
            "test_recall": r["test_at_threshold"]["recall"],
            "test_precision": r["test_at_threshold"]["precision"],
            "test_alerts_per_100": r["test_at_threshold"]["alerts_per_100"],
            "test_n_alerts": r["test_at_threshold"]["n_alerts"],
            "test_n_positive": int(test_df["label"].sum()),
        })
    comparison = pd.DataFrame(rows)
    print("\n=== Model comparison (test split) ===")
    print(comparison.to_string(index=False))

    with open(config.REPORTS_DIR / "metrics_table.md", "w", encoding="utf-8") as fh:
        fh.write("# Model comparison (this run)\n\n")
        fh.write(f"Test split: {len(test_df)} rows, {int(test_df['label'].sum())} positive "
                  f"({100 * test_df['label'].mean():.3f}%)\n\n")
        fh.write(comparison.to_markdown(index=False))
        fh.write("\n")

    # Pick the primary model for explainability artifacts: prefer
    # config.PRIMARY_MODEL_ID (the model actually deployed by src/service/)
    # if it meets both constraints; else any model meeting both constraints;
    # else the one with the higher val PR-AUC. Keeping this in sync with
    # PRIMARY_MODEL_ID avoids reports/high_risk_examples.md explaining a
    # different model than the one src/service/ actually serves.
    both_met = [n for n, r in results.items() if r["chosen_threshold"]["status"] == "both_constraints_met"]
    if config.PRIMARY_MODEL_ID in both_met:
        primary_name = config.PRIMARY_MODEL_ID
    elif both_met:
        primary_name = both_met[0]
    else:
        primary_name = max(results, key=lambda n: results[n]["val_summary"]["pr_auc"])
    print(f"\nPrimary model for explainability artifacts: {primary_name}")

    for name, r in results.items():
        perm_imp = explainability.permutation_importance_table(r["pipeline"], val_df, val_df["label"])
        perm_imp.to_csv(config.REPORTS_DIR / f"feature_importance_{name}.csv", index=False)
        native = explainability.native_tree_importance(r["pipeline"])
        if native is not None:
            native.to_csv(config.REPORTS_DIR / f"native_feature_importance_{name}.csv", index=False)

    primary = results[primary_name]
    high_risk = explainability.explain_high_risk_rows(
        primary["pipeline"], primary_name, train_df, test_df, primary["test_scores"], top_n=5,
    )
    _write_high_risk_report(high_risk, primary_name, config.REPORTS_DIR / "high_risk_examples.md")

    _write_model_card(results, primary_name, seed, config.MODEL_CARD_JSON)

    print(f"\nWrote reports to {config.REPORTS_DIR}")
    return {"results": results, "comparison": comparison, "primary_model": primary_name,
            "train_df": train_df, "val_df": val_df, "test_df": test_df}


def _write_model_card(results: dict, primary_name: str, seed: int, out_path: Path) -> None:
    """Persist the serving contract for src/service/: which model, at what
    threshold, with what metrics. Read verbatim by GET /model-card and used
    by POST /score to decide the alert flag -- so the service always serves
    exactly what this training run produced, and a retrain + service restart
    is the only way those numbers change (see README "Retraining").
    """
    primary = results[primary_name]
    model_path = config.MODELS_DIR / f"{primary_name}.joblib"
    trained_at = (
        datetime.fromtimestamp(model_path.stat().st_mtime, tz=timezone.utc).isoformat()
        if model_path.exists()
        else datetime.now(tz=timezone.utc).isoformat()
    )
    card = {
        "model_id": primary_name,
        "seed": seed,
        "trained_at": trained_at,
        "threshold": float(primary["chosen_threshold"]["threshold"]),
        "threshold_status": primary["chosen_threshold"]["status"],
        "target": {
            "min_recall": config.TARGET_RECALL,
            "max_alerts_per_100": config.TARGET_ALERTS_PER_100,
        },
        "val_metrics": primary["val_summary"],
        "test_metrics": primary["test_summary"],
        "test_at_threshold": {
            k: v for k, v in primary["test_at_threshold"].items()
        },
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train/evaluate the MRO predictive-maintenance models end to end. "
        "Also usable as the retrain CLI: `python -m src.pipeline --retrain` regenerates "
        "models/*.joblib, reports/*, and reports/model_card.json in place; restart the "
        "scoring service (src/service/app.py) afterward to pick up the new artifacts."
    )
    parser.add_argument(
        "--retrain", action="store_true",
        help="Explicit alias for a normal run -- documents intent when invoked to refresh "
        "a previously-deployed model. Behavior is identical to running with no flags.",
    )
    parser.add_argument("--seed", type=int, default=config.DEFAULT_SEED, help="Random seed.")
    return parser.parse_args()


def _write_high_risk_report(explanations: list[dict], model_name: str, out_path: Path) -> None:
    lines = [f"# High-risk example predictions ({model_name})\n"]
    lines.append(
        "Top-scoring components on the held-out TEST split, with the local "
        "factors driving each score.\n"
    )
    for e in explanations:
        lines.append(f"## {e['component_id']}  (cycle {e['cycle']}, {e['snapshot_date']})\n")
        lines.append(f"- risk_score: **{e['risk_score']:.4f}**")
        lines.append(f"- true label: {e['true_label']} ({'unscheduled removal within 30 cycles' if e['true_label'] else 'no unscheduled removal in window'})")
        lines.append(f"- component_type: {e['component_type']}")
        lines.append(f"- explanation method: {e['method']}")
        if e.get("fallback_reason"):
            lines.append(f"- note: {e['fallback_reason']}")
        lines.append("- top contributing features:")
        for f in e["top_features"]:
            if "shap_value" in f:
                lines.append(f"  - `{f['feature']}`: SHAP contribution {f['shap_value']:+.4f}")
            else:
                lines.append(f"  - `{f['feature']}` = {f['value']:.3f} (z={f['z_score']:+.2f} vs. train population)")
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    _args = _parse_args()
    run(seed=_args.seed)
