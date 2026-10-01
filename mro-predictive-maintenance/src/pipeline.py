"""End-to-end training/evaluation entry point.

Usage (from the project root, with the venv active):
    python -m src.pipeline                    # --profile realistic (default, v3 headline)
    python -m src.pipeline --profile v1        # reproduces the originally-submitted numbers
    python -m src.pipeline --seeds 5           # multi-seed realistic run -> reports/multi_seed.csv

Always regenerates the dataset in-memory for the requested profile (rather
than trusting a possibly-stale on-disk model_table.csv cache -- switching
--profile must never silently reuse the other profile's cached table).
Raw CSVs and the model-ready table are still written to disk for other
tools (dashboard, manual inspection), under a profile-specific path so both
profiles can coexist WITHOUT overwriting each other:
`data/raw/[realistic/]`, `data/processed/[realistic/]`.

`--profile v1` is the reproducible headline result AND the model actually
served by src/service/ -- it owns every canonical path unchanged. `--profile
realistic` is an honest stress test (coordinator decision) and writes every
artifact under a parallel `realistic/` subtree instead, so a realistic run
can NEVER clobber the v1 canonical artifacts the service depends on.

Writes (profile == "v1", canonical/served):
    reports/metrics_table.md               comparison table
    reports/threshold_sweep_<model>.csv     full val sweep per model
    reports/feature_importance_<model>.csv
    reports/high_risk_examples.md           local explanations, top test rows
    reports/model_card.json                 served by src/service/model_store.py
    models/<model>.joblib                   raw fitted pipelines
    data/raw/*.csv, data/processed/model_table.csv

Writes (profile == "realistic", stress-test mode -- same filenames, under
reports/realistic/, models/realistic/, data/raw/realistic/,
data/processed/realistic/):
    reports/realistic/metrics_table.md      comparison table incl. baselines
    reports/realistic/threshold_sweep_<model>.csv
    reports/realistic/feature_importance_<model>.csv
    reports/realistic/high_risk_examples.md
    reports/realistic/model_card.json       v2 schema (see module docstring below)
    reports/realistic/multi_seed.csv        only with --seeds > 1
    models/realistic/<model>.joblib
    models/realistic/<model>_calibrated.joblib  isotonic/sigmoid-calibrated pipelines
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from data.generate_dataset import N_AIRCRAFT, generate  # noqa: E402
from src import baselines, calibration, config, evaluation, explainability, features, modeling, monitoring, splitting, tracking  # noqa: E402

BASELINE_MODEL_IDS = list(baselines.BASELINE_SCORERS)


def _build_table(seed: int, profile: str, n_aircraft: int) -> pd.DataFrame:
    aircraft, components, snapshots, faults, maint = generate(
        seed=seed, n_aircraft=n_aircraft, profile=profile
    )
    table = features.build_model_table(aircraft, components, snapshots, faults, maint)

    raw_dir = config.RAW_DIR if profile == "v1" else config.REALISTIC_RAW_DIR
    processed_dir = config.PROCESSED_DIR if profile == "v1" else config.REALISTIC_PROCESSED_DIR
    raw_dir.mkdir(parents=True, exist_ok=True)
    processed_dir.mkdir(parents=True, exist_ok=True)
    aircraft.to_csv(raw_dir / "aircraft.csv", index=False)
    components.to_csv(raw_dir / "components.csv", index=False)
    snapshots.to_csv(raw_dir / "cycle_snapshots.csv", index=False)
    faults.to_csv(raw_dir / "fault_codes.csv", index=False)
    maint.to_csv(raw_dir / "maintenance_events.csv", index=False)
    table.to_csv(processed_dir / "model_table.csv", index=False)
    return table


def _models_dir(profile: str) -> Path:
    d = config.MODELS_DIR if profile == "v1" else config.REALISTIC_MODELS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def _reports_dir(profile: str) -> Path:
    d = config.REPORTS_DIR if profile == "v1" else config.REALISTIC_REPORTS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def _model_card_path(profile: str) -> Path:
    return config.MODEL_CARD_JSON if profile == "v1" else config.REALISTIC_MODEL_CARD_JSON


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


# --------------------------------------------------------------------------
# Profile: v1 (parity/regression mode -- reproduces the submitted numbers)
# --------------------------------------------------------------------------

def _run_v1(seed: int, n_aircraft: int) -> dict:
    reports_dir = _reports_dir("v1")
    model_card_path = _model_card_path("v1")
    models_dir = _models_dir("v1")

    table = _build_table(seed, "v1", n_aircraft)
    print(f"[v1] Model table: {len(table)} rows, {table['label'].mean() * 100:.3f}% positive")

    train_df, val_df, test_df, boundaries = splitting.time_group_split(table)
    splitting.assert_no_leakage(train_df, val_df, test_df)

    models = modeling.build_models(seed=seed)
    results = {}
    for name, pipeline in models.items():
        modeling.fit_model(pipeline, train_df)
        val_scores = modeling.predict_scores(pipeline, val_df)
        test_scores = modeling.predict_scores(pipeline, test_df)

        val_summary = evaluation.summary_metrics(val_df["label"].to_numpy(), val_scores)
        test_summary = evaluation.summary_metrics(test_df["label"].to_numpy(), test_scores)

        sweep = evaluation.threshold_sweep(val_df["label"].to_numpy(), val_scores)
        sweep.to_csv(reports_dir / f"threshold_sweep_{name}.csv", index=False)

        chosen = evaluation.select_operating_threshold(sweep)
        test_at_threshold = evaluation.apply_threshold(
            test_df["label"].to_numpy(), test_scores, chosen["threshold"]
        )
        joblib.dump(pipeline, models_dir / f"{name}.joblib")

        results[name] = {
            "pipeline": pipeline, "val_summary": val_summary, "test_summary": test_summary,
            "chosen_threshold": chosen, "test_at_threshold": test_at_threshold,
            "val_scores": val_scores, "test_scores": test_scores,
        }
        print(
            f"[v1] {name}: chosen threshold={chosen['threshold']:.4f} [{chosen['status']}] "
            f"test recall={test_at_threshold['recall']:.4f} "
            f"alerts/100={test_at_threshold['alerts_per_100']:.2f}"
        )

    rows = [{
        "model": name,
        "val_roc_auc": r["val_summary"]["roc_auc"], "val_pr_auc": r["val_summary"]["pr_auc"],
        "test_roc_auc": r["test_summary"]["roc_auc"], "test_pr_auc": r["test_summary"]["pr_auc"],
        "chosen_threshold": r["chosen_threshold"]["threshold"],
        "threshold_status": r["chosen_threshold"]["status"],
        "test_recall": r["test_at_threshold"]["recall"],
        "test_precision": r["test_at_threshold"]["precision"],
        "test_alerts_per_100": r["test_at_threshold"]["alerts_per_100"],
        "test_n_alerts": r["test_at_threshold"]["n_alerts"],
        "test_n_positive": int(test_df["label"].sum()),
    } for name, r in results.items()]
    comparison = pd.DataFrame(rows)
    with open(reports_dir / "metrics_table.md", "w", encoding="utf-8") as fh:
        fh.write("# Model comparison (this run, profile=v1)\n\n")
        fh.write(f"Test split: {len(test_df)} rows, {int(test_df['label'].sum())} positive "
                  f"({100 * test_df['label'].mean():.3f}%)\n\n")
        fh.write(comparison.to_markdown(index=False))
        fh.write("\n")

    both_met = [n for n, r in results.items() if r["chosen_threshold"]["status"] == "both_constraints_met"]
    primary_name = (
        config.PRIMARY_MODEL_ID if config.PRIMARY_MODEL_ID in both_met
        else (both_met[0] if both_met else max(results, key=lambda n: results[n]["val_summary"]["pr_auc"]))
    )

    for name, r in results.items():
        perm_imp = explainability.permutation_importance_table(r["pipeline"], val_df, val_df["label"])
        perm_imp.to_csv(reports_dir / f"feature_importance_{name}.csv", index=False)

    primary = results[primary_name]
    high_risk = explainability.explain_high_risk_rows(
        primary["pipeline"], primary_name, train_df, test_df, primary["test_scores"], top_n=5,
    )
    _write_high_risk_report(high_risk, primary_name, reports_dir / "high_risk_examples.md")

    model_path = models_dir / f"{primary_name}.joblib"
    trained_at = datetime.fromtimestamp(model_path.stat().st_mtime, tz=timezone.utc).isoformat()
    card = {
        "profile": "v1",
        "model_id": primary_name,
        "seed": seed,
        "trained_at": trained_at,
        "threshold": float(primary["chosen_threshold"]["threshold"]),
        "threshold_status": primary["chosen_threshold"]["status"],
        "val_status": primary["chosen_threshold"]["status"],
        "test_status": (
            "target_met"
            if primary["test_at_threshold"]["recall"] >= config.TARGET_RECALL
            and primary["test_at_threshold"]["alerts_per_100"] <= config.TARGET_ALERTS_PER_100
            else "target_missed"
        ),
        "target": {"min_recall": config.TARGET_RECALL, "max_alerts_per_100": config.TARGET_ALERTS_PER_100},
        "val_metrics": primary["val_summary"],
        "test_metrics": primary["test_summary"],
        "test_at_threshold": primary["test_at_threshold"],
        "served_policy": "min_alerts",
        "calibration": None,
        "threshold_policies": None,
        "ci": None,
        "alert_rate_definition": "row_based (v1 parity mode)",
        "baselines": None,
    }
    model_card_path.write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")
    print(f"[v1] Wrote {model_card_path} (model_id={primary_name}, "
          f"threshold={card['threshold']:.4f}, test_recall={primary['test_at_threshold']['recall']:.4f})")

    # MLflow: v1 is the served champion (registry alias `champion` follows
    # whatever /score actually serves) -- also snapshots the training-split
    # reference profile drift is measured against (src/monitoring.py).
    monitoring.save_reference_profile(test_df)
    tracking.init_tracking()
    tracking.log_training_run(
        profile="v1", seed=seed, served_policy=card["served_policy"],
        params={"model_id": primary_name, "threshold": card["threshold"]},
        metrics={"test_recall": primary["test_at_threshold"]["recall"],
                 "test_precision": primary["test_at_threshold"]["precision"],
                 "test_alerts_per_100": primary["test_at_threshold"]["alerts_per_100"]},
        artifact_paths=[model_card_path, reports_dir / "metrics_table.md"],
        sklearn_pipeline=primary["pipeline"], input_example=train_df[modeling.ALL_FEATURES].head(3),
        alias="champion",
    )

    return {"results": results, "comparison": comparison, "primary_model": primary_name,
            "train_df": train_df, "val_df": val_df, "test_df": test_df, "card": card}


# --------------------------------------------------------------------------
# Profile: realistic (v3 headline -- calibration, policies, CIs, baselines)
# --------------------------------------------------------------------------

def _run_realistic(seed: int, n_aircraft: int) -> dict:
    reports_dir = _reports_dir("realistic")
    model_card_path = _model_card_path("realistic")
    models_dir = _models_dir("realistic")

    table = _build_table(seed, "realistic", n_aircraft)
    print(f"[realistic] Model table: {len(table)} rows, {table['label'].mean() * 100:.3f}% positive")

    train_df, val_df, test_df, boundaries = splitting.time_group_split(table)
    splitting.assert_no_leakage(train_df, val_df, test_df)
    val_cal_df, val_thr_df = calibration.split_val_cal_thr(val_df, seed=seed)
    print(f"[realistic] val split -> val_cal {len(val_cal_df)} rows, val_thr {len(val_thr_df)} rows")

    models = modeling.build_models(seed=seed)
    model_results = {}
    for name, pipeline in models.items():
        modeling.fit_model(pipeline, train_df)
        raw_val_thr_scores = modeling.predict_scores(pipeline, val_thr_df)
        raw_test_scores = modeling.predict_scores(pipeline, test_df)

        calibrated_model, cal_meta = calibration.fit_calibrated_model(
            pipeline, val_cal_df, modeling.ALL_FEATURES
        )
        cal_val_thr_scores = calibration.predict_calibrated_scores(
            calibrated_model, val_thr_df, modeling.ALL_FEATURES
        )
        cal_test_scores = calibration.predict_calibrated_scores(
            calibrated_model, test_df, modeling.ALL_FEATURES
        )
        cal_report = calibration.calibration_report(
            val_thr_df["label"].to_numpy(), raw_val_thr_scores, cal_val_thr_scores
        )
        cal_report.update(cal_meta)

        val_summary = evaluation.summary_metrics(val_thr_df["label"].to_numpy(), cal_val_thr_scores)
        test_summary = evaluation.summary_metrics(test_df["label"].to_numpy(), cal_test_scores)
        sweep = evaluation.threshold_sweep(val_thr_df["label"].to_numpy(), cal_val_thr_scores)
        sweep.to_csv(reports_dir / f"threshold_sweep_{name}.csv", index=False)

        policies = {
            "min_alerts": evaluation.select_operating_threshold(sweep),
            "max_recall_within_budget": evaluation.select_threshold_max_recall_within_budget(sweep),
            "min_expected_cost": evaluation.select_threshold_min_expected_cost(sweep),
        }
        served_policy = "max_recall_within_budget"
        served_threshold = float(policies[served_policy]["threshold"])
        test_at_threshold = evaluation.apply_threshold(
            test_df["label"].to_numpy(), cal_test_scores, served_threshold
        )
        alert_rate = evaluation.alerts_per_100_components(test_df, cal_test_scores, served_threshold)
        ci = evaluation.bootstrap_ci(
            test_df, test_df["label"].to_numpy(), cal_test_scores, served_threshold, seed=seed,
        )

        joblib.dump(pipeline, models_dir / f"{name}.joblib")
        joblib.dump(calibrated_model, models_dir / f"{name}_calibrated.joblib")

        val_status = (
            "target_met" if policies[served_policy]["recall"] >= config.TARGET_RECALL
            and policies[served_policy]["alerts_per_100"] <= config.TARGET_ALERTS_PER_100
            else "target_missed"
        )
        test_status = (
            "target_met" if test_at_threshold["recall"] >= config.TARGET_RECALL
            and test_at_threshold["alerts_per_100"] <= config.TARGET_ALERTS_PER_100
            else "target_missed"
        )

        model_results[name] = {
            "pipeline": pipeline, "calibrated_model": calibrated_model,
            "val_summary": val_summary, "test_summary": test_summary,
            "policies": policies, "served_policy": served_policy, "served_threshold": served_threshold,
            "test_at_threshold": test_at_threshold, "alert_rate": alert_rate, "ci": ci,
            "calibration": cal_report, "val_status": val_status, "test_status": test_status,
            "test_scores": cal_test_scores,
        }
        print(
            f"[realistic] {name}: served_threshold={served_threshold:.4f} "
            f"test recall={test_at_threshold['recall']:.4f} "
            f"alerts/100(component-window)={alert_rate['component_window_alerts_per_100']:.2f} "
            f"[{test_status}]"
        )

    # Baselines through the identical eval/threshold code path.
    baseline_results = {}
    for baseline_id, scorer in baselines.BASELINE_SCORERS.items():
        val_thr_scores = scorer(val_thr_df)
        test_scores = scorer(test_df)
        sweep = evaluation.threshold_sweep(val_thr_df["label"].to_numpy(), val_thr_scores)
        chosen = evaluation.select_threshold_max_recall_within_budget(sweep)
        threshold = float(chosen["threshold"])
        test_at_threshold = evaluation.apply_threshold(test_df["label"].to_numpy(), test_scores, threshold)
        ci = evaluation.bootstrap_ci(test_df, test_df["label"].to_numpy(), test_scores, threshold, seed=seed)
        baseline_results[baseline_id] = {
            "served_threshold": threshold, "test_at_threshold": test_at_threshold, "ci": ci,
            "val_summary": evaluation.summary_metrics(val_thr_df["label"].to_numpy(), val_thr_scores),
            "test_summary": evaluation.summary_metrics(test_df["label"].to_numpy(), test_scores),
        }
        print(
            f"[realistic] {baseline_id}: threshold={threshold:.4f} "
            f"test recall={test_at_threshold['recall']:.4f} "
            f"precision={test_at_threshold['precision']:.4f}"
        )

    rows = []
    for name, r in model_results.items():
        rows.append({
            "model": name, "val_roc_auc": r["val_summary"]["roc_auc"], "val_pr_auc": r["val_summary"]["pr_auc"],
            "test_roc_auc": r["test_summary"]["roc_auc"], "test_pr_auc": r["test_summary"]["pr_auc"],
            "chosen_threshold": r["served_threshold"], "threshold_status": r["test_status"],
            "test_recall": r["test_at_threshold"]["recall"], "test_precision": r["test_at_threshold"]["precision"],
            "test_alerts_per_100": r["test_at_threshold"]["alerts_per_100"],
            "test_n_alerts": r["test_at_threshold"]["n_alerts"], "test_n_positive": int(test_df["label"].sum()),
        })
    for name, r in baseline_results.items():
        rows.append({
            "model": name, "val_roc_auc": r["val_summary"]["roc_auc"], "val_pr_auc": r["val_summary"]["pr_auc"],
            "test_roc_auc": r["test_summary"]["roc_auc"], "test_pr_auc": r["test_summary"]["pr_auc"],
            "chosen_threshold": r["served_threshold"],
            "threshold_status": (
                "target_met" if r["test_at_threshold"]["recall"] >= config.TARGET_RECALL
                and r["test_at_threshold"]["alerts_per_100"] <= config.TARGET_ALERTS_PER_100
                else "target_missed"
            ),
            "test_recall": r["test_at_threshold"]["recall"], "test_precision": r["test_at_threshold"]["precision"],
            "test_alerts_per_100": r["test_at_threshold"]["alerts_per_100"],
            "test_n_alerts": r["test_at_threshold"]["n_alerts"], "test_n_positive": int(test_df["label"].sum()),
        })
    comparison = pd.DataFrame(rows)
    with open(reports_dir / "metrics_table.md", "w", encoding="utf-8") as fh:
        fh.write("# Model comparison (this run, profile=realistic)\n\n")
        fh.write(
            f"Test split: {len(test_df)} rows, {int(test_df['label'].sum())} positive "
            f"({100 * test_df['label'].mean():.3f}%). Served policy for ML models: "
            "max_recall_within_budget. Cost figures are illustrative "
            f"(COST_MISSED_REMOVAL=${config.COST_MISSED_REMOVAL:,.0f}, "
            f"COST_FALSE_ALERT=${config.COST_FALSE_ALERT:,.0f}), not calibrated to real MRO finance data.\n\n"
        )
        fh.write(comparison.to_markdown(index=False))
        fh.write("\n")

    primary_name = config.PRIMARY_MODEL_ID
    primary = model_results[primary_name]
    for name, r in model_results.items():
        perm_imp = explainability.permutation_importance_table(r["pipeline"], val_thr_df, val_thr_df["label"])
        perm_imp.to_csv(reports_dir / f"feature_importance_{name}.csv", index=False)

    high_risk = explainability.explain_high_risk_rows(
        primary["pipeline"], primary_name, train_df, test_df, primary["test_scores"], top_n=5,
    )
    _write_high_risk_report(high_risk, primary_name, reports_dir / "high_risk_examples.md")

    model_path = models_dir / f"{primary_name}.joblib"
    trained_at = datetime.fromtimestamp(model_path.stat().st_mtime, tz=timezone.utc).isoformat()
    card = {
        "profile": "realistic",
        "model_id": primary_name,
        "seed": seed,
        "trained_at": trained_at,
        "threshold": primary["served_threshold"],
        "threshold_status": primary["test_status"],
        "val_status": primary["val_status"],
        "test_status": primary["test_status"],
        "target": {"min_recall": config.TARGET_RECALL, "max_alerts_per_100": config.TARGET_ALERTS_PER_100},
        "val_metrics": primary["val_summary"],
        "test_metrics": primary["test_summary"],
        "test_at_threshold": primary["test_at_threshold"],
        "served_policy": primary["served_policy"],
        "threshold_policies": {
            policy_name: {k: v for k, v in p.items() if k != "pipeline"}
            for policy_name, p in primary["policies"].items()
        },
        "calibration": primary["calibration"],
        "ci": primary["ci"],
        "alert_rate_definition": (
            "component_window: per 30-day window, latest snapshot per active "
            "component, share alerting, averaged over windows -- see "
            "src/evaluation.alerts_per_100_components"
        ),
        "alert_rate": primary["alert_rate"],
        "baselines": {
            name: {
                "threshold": r["served_threshold"],
                "test_at_threshold": r["test_at_threshold"],
                "ci": r["ci"],
            }
            for name, r in baseline_results.items()
        },
    }
    model_card_path.write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")
    print(f"[realistic] Wrote {model_card_path} (model_id={primary_name}, "
          f"served_threshold={card['threshold']:.4f}, test_status={card['test_status']})")

    # MLflow: log the challenger run too (never served by default, never
    # aliased `champion` here -- src/retrain.py decides that via the gate).
    tracking.init_tracking()
    tracking.log_training_run(
        profile="realistic", seed=seed, served_policy=primary["served_policy"],
        params={"model_id": primary_name, "threshold": primary["served_threshold"],
                "calibration_method": primary["calibration"].get("method")},
        metrics={"test_recall": primary["test_at_threshold"]["recall"],
                 "test_precision": primary["test_at_threshold"]["precision"],
                 "test_alerts_per_100": primary["test_at_threshold"]["alerts_per_100"],
                 "brier_post": primary["calibration"].get("brier_post")},
        artifact_paths=[model_card_path, reports_dir / "metrics_table.md"],
        sklearn_pipeline=primary["calibrated_model"], input_example=train_df[modeling.ALL_FEATURES].head(3),
        alias=None,
    )

    return {
        "model_results": model_results, "baseline_results": baseline_results, "comparison": comparison,
        "primary_model": primary_name, "train_df": train_df, "val_df": val_df,
        "val_cal_df": val_cal_df, "val_thr_df": val_thr_df, "test_df": test_df, "card": card,
    }


def run_multi_seed(seeds: int, base_seed: int, n_aircraft: int) -> pd.DataFrame:
    """Repeat the realistic pipeline across `seeds` RNG seeds and report
    mean+-sd of test recall/precision/alerts-per-100 for the primary model --
    a cheaper, complementary signal to the single-seed bootstrap CI (this
    varies the WHOLE dataset draw, not just which aircraft get resampled).
    """
    rows = []
    for i in range(seeds):
        seed = base_seed + i
        result = _run_realistic(seed, n_aircraft)
        primary = result["model_results"][result["primary_model"]]
        rows.append({
            "seed": seed,
            "test_recall": primary["test_at_threshold"]["recall"],
            "test_precision": primary["test_at_threshold"]["precision"],
            "test_alerts_per_100": primary["test_at_threshold"]["alerts_per_100"],
        })
    df = pd.DataFrame(rows)
    summary = pd.DataFrame([{
        "seed": "mean±sd",
        "test_recall": f"{df['test_recall'].mean():.4f}±{df['test_recall'].std():.4f}",
        "test_precision": f"{df['test_precision'].mean():.4f}±{df['test_precision'].std():.4f}",
        "test_alerts_per_100": f"{df['test_alerts_per_100'].mean():.4f}±{df['test_alerts_per_100'].std():.4f}",
    }])
    out = pd.concat([df, summary], ignore_index=True)
    multi_seed_path = _reports_dir("realistic") / "multi_seed.csv"
    out.to_csv(multi_seed_path, index=False)
    print(f"Wrote {multi_seed_path}")
    return out


def run(seed: int = config.DEFAULT_SEED, profile: str = config.DEFAULT_PROFILE,
        n_aircraft: int = N_AIRCRAFT) -> dict:
    if profile == "v1":
        return _run_v1(seed, n_aircraft)
    if profile == "realistic":
        return _run_realistic(seed, n_aircraft)
    raise ValueError(f"unknown profile {profile!r}; expected 'v1' or 'realistic'")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train/evaluate the MRO predictive-maintenance models end to end. "
        "Also usable as the retrain CLI: restart the scoring service (src/service/app.py) "
        "afterward to pick up new artifacts."
    )
    parser.add_argument(
        "--retrain", action="store_true",
        help="Explicit alias for a normal run -- documents intent. Behavior is identical.",
    )
    parser.add_argument("--seed", type=int, default=config.DEFAULT_SEED, help="Random seed.")
    parser.add_argument(
        "--profile", choices=["v1", "realistic"], default=config.DEFAULT_PROFILE,
        help="'v1' reproduces the originally-submitted numbers exactly; 'realistic' "
        "(default) is the v3 headline stress-test profile.",
    )
    parser.add_argument(
        "--seeds", type=int, default=1,
        help="If > 1, run the realistic profile across this many consecutive seeds "
        "(starting at --seed) and write reports/multi_seed.csv (mean±sd).",
    )
    parser.add_argument("--n-aircraft", type=int, default=N_AIRCRAFT)
    return parser.parse_args()


if __name__ == "__main__":
    _args = _parse_args()
    if _args.seeds > 1:
        if _args.profile != "realistic":
            raise SystemExit("--seeds > 1 is only supported for --profile realistic")
        run_multi_seed(_args.seeds, _args.seed, _args.n_aircraft)
    else:
        run(seed=_args.seed, profile=_args.profile, n_aircraft=_args.n_aircraft)
