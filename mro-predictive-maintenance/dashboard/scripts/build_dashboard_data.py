"""Builds dashboard/src/data/dashboard_data.json from the REAL pipeline artifacts.

This script does not compute, estimate, or hand-type any metric. It only
reads and reshapes files that already exist on disk under reports/ and
docs/ (produced by `python -m src.pipeline`, see README.md). Re-run this
script any time the pipeline is re-run, to refresh the dashboard's data.

Inputs (all read-only, never modified):
  - reports/metrics_table.md
  - reports/threshold_sweep_logistic_regression.csv
  - reports/threshold_sweep_hist_gradient_boosting.csv
  - reports/feature_importance_logistic_regression.csv
  - reports/feature_importance_hist_gradient_boosting.csv
  - reports/high_risk_examples.md
  - docs/demo-evidence.md   (dataset generation + split summary, verbatim console output)
  - docs/design-report.md   (recall/alert-rate operating target)

Output:
  - dashboard/src/data/dashboard_data.json

Usage:
  python dashboard/scripts/build_dashboard_data.py
(run from the mro-predictive-maintenance/ project root, or anywhere --
paths are resolved relative to this script's location, not the cwd)
"""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
DASHBOARD_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = DASHBOARD_DIR.parent
REPORTS_DIR = PROJECT_ROOT / "reports"
DOCS_DIR = PROJECT_ROOT / "docs"
# --profile realistic (stress-test mode) writes its own parallel tree under
# reports/realistic/ so it never overwrites the v1 canonical artifacts above
# (see src/pipeline.py, src/config.py). Read-only here, purely for display --
# v1 stays the headline, this is surfaced as a secondary "realistic" section.
REALISTIC_REPORTS_DIR = REPORTS_DIR / "realistic"
OUTPUT_PATH = DASHBOARD_DIR / "src" / "data" / "dashboard_data.json"

MODEL_LABELS = {
    "logistic_regression": "Logistic Regression",
    "hist_gradient_boosting": "HistGradientBoosting",
}


class ArtifactError(RuntimeError):
    """Raised when a required source artifact is missing or malformed."""


def _read(path: Path) -> str:
    if not path.exists():
        raise ArtifactError(f"missing required artifact: {path}")
    return path.read_text(encoding="utf-8")


def _to_number(raw: str) -> float | int:
    raw = raw.strip()
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    return float(raw)


def parse_metrics_table(path: Path) -> list[dict[str, Any]]:
    """Parses the pipe-delimited markdown table in reports/metrics_table.md."""
    text = _read(path)
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip().startswith("|")]
    if len(lines) < 3:
        raise ArtifactError(f"{path} does not look like a markdown table")
    header = [c.strip() for c in lines[0].strip("|").split("|")]
    rows: list[dict[str, Any]] = []
    for line in lines[2:]:  # skip header + '---' separator row
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) != len(header):
            continue
        row: dict[str, Any] = {}
        for key, val in zip(header, cells):
            if key == "model" or key == "threshold_status":
                row[key] = val
            else:
                try:
                    row[key] = _to_number(val)
                except ValueError:
                    row[key] = val
        rows.append(row)
    if not rows:
        raise ArtifactError(f"no data rows parsed from {path}")
    return rows


def parse_threshold_sweep(path: Path) -> list[dict[str, Any]]:
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        rows = []
        for r in reader:
            rows.append(
                {
                    "threshold": float(r["threshold"]),
                    "recall": float(r["recall"]),
                    "precision": float(r["precision"]),
                    "alerts_per_100": float(r["alerts_per_100"]),
                    "n_alerts": int(r["n_alerts"]),
                    "tp": int(r["tp"]),
                    "fp": int(r["fp"]),
                    "fn": int(r["fn"]),
                }
            )
    if not rows:
        raise ArtifactError(f"no rows parsed from {path}")
    return rows


def parse_feature_importance(path: Path) -> list[dict[str, Any]]:
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        rows = [
            {
                "feature": r["feature"],
                "importance_mean": float(r["importance_mean"]),
                "importance_std": float(r["importance_std"]),
            }
            for r in reader
        ]
    if not rows:
        raise ArtifactError(f"no rows parsed from {path}")
    rows.sort(key=lambda r: r["importance_mean"], reverse=True)
    return rows


def parse_high_risk_examples(path: Path) -> list[dict[str, Any]]:
    text = _read(path)
    blocks = re.split(r"^## ", text, flags=re.MULTILINE)[1:]
    examples: list[dict[str, Any]] = []
    header_re = re.compile(r"^(?P<id>\S+)\s+\(cycle (?P<cycle>[\d.]+), (?P<date>[^)]+)\)")
    feature_re = re.compile(
        r"- `(?P<feature>[^`]+)`: SHAP contribution (?P<contribution>[+-][\d.]+)"
    )
    for block in blocks:
        head_match = header_re.search(block)
        if not head_match:
            continue
        risk_match = re.search(r"risk_score:\s*\*\*([\d.]+)\*\*", block)
        label_match = re.search(r"true label:\s*(\d)", block)
        type_match = re.search(r"component_type:\s*(\S+)", block)
        method_match = re.search(r"explanation method:\s*(\S+)", block)
        features = [
            {"feature": m.group("feature"), "contribution": float(m.group("contribution"))}
            for m in feature_re.finditer(block)
        ]
        if not (risk_match and label_match and type_match and method_match):
            raise ArtifactError(f"malformed high-risk example block in {path}: {block[:80]!r}")
        examples.append(
            {
                "component_id": head_match.group("id"),
                "cycle": float(head_match.group("cycle")),
                "date": head_match.group("date").strip(),
                "risk_score": float(risk_match.group(1)),
                "true_label": int(label_match.group(1)),
                "component_type": type_match.group(1),
                "explanation_method": method_match.group(1),
                "top_features": features,
            }
        )
    if not examples:
        raise ArtifactError(f"no examples parsed from {path}")
    return examples


def parse_dataset_summary(demo_evidence_path: Path) -> dict[str, Any]:
    text = _read(demo_evidence_path)

    def find_int(pattern: str, flags: int = 0) -> int:
        m = re.search(pattern, text, flags)
        if not m:
            raise ArtifactError(f"pattern not found in {demo_evidence_path}: {pattern}")
        return int(m.group(1).replace(",", ""))

    seed_match = re.search(r"seed (\d+), this environment, (\d{4}-\d{2}-\d{2})", text)
    if not seed_match:
        raise ArtifactError(f"could not find seed/date line in {demo_evidence_path}")

    positive_rate_match = re.search(
        r"Positive rate:\s*(\d+)/(\d+)\s*=\s*([\d.]+)%", text
    )
    if not positive_rate_match:
        raise ArtifactError(f"could not find positive-rate line in {demo_evidence_path}")

    split_match = re.search(
        r"Split -> train (\d+) rows / (\d+) aircraft, "
        r"val (\d+) rows / (\d+) aircraft, "
        r"test (\d+) rows / (\d+) aircraft",
        text,
    )
    if not split_match:
        raise ArtifactError(f"could not find split summary line in {demo_evidence_path}")

    positives_match = re.search(
        r"positive rows -> train (\d+), val (\d+), test (\d+)", text
    )
    if not positives_match:
        raise ArtifactError(f"could not find split positive-rows line in {demo_evidence_path}")

    primary_model_match = re.search(
        r"Primary model for explainability artifacts:\s*(\S+)", text
    )
    if not primary_model_match:
        raise ArtifactError(f"could not find primary-model line in {demo_evidence_path}")

    (train_rows, train_ac, val_rows, val_ac, test_rows, test_ac) = split_match.groups()
    (train_pos, val_pos, test_pos) = positives_match.groups()

    return {
        "seed": int(seed_match.group(1)),
        "run_date": seed_match.group(2),
        "aircraft": find_int(r"Aircraft:\s*(\d+)"),
        "components_total": find_int(r"Components:\s*(\d+)"),
        "components_unscheduled": find_int(r"^\s*unscheduled removals:\s*(\d+)", re.MULTILINE),
        # anchored to line-start so this does not also match "unscheduled removals:"
        # (that line contains "scheduled removals:" as a substring with no word
        # boundary between "un" and "scheduled" for \b to catch).
        "components_scheduled": find_int(r"^\s{2}scheduled removals:\s*(\d+)", re.MULTILINE),
        "components_survived": find_int(r"survived \(censored\):\s*(\d+)"),
        "cycle_snapshots": find_int(r"Cycle snapshots:\s*(\d+)"),
        "fault_code_events": find_int(r"Fault code events:\s*(\d+)"),
        "maintenance_events": find_int(r"Maintenance events:\s*(\d+)"),
        "positive_count": int(positive_rate_match.group(1)),
        "positive_rate_denominator": int(positive_rate_match.group(2)),
        "positive_rate_pct": float(positive_rate_match.group(3)),
        "primary_model_id": primary_model_match.group(1),
        "splits": {
            "train": {"rows": int(train_rows), "aircraft": int(train_ac), "positives": int(train_pos)},
            "val": {"rows": int(val_rows), "aircraft": int(val_ac), "positives": int(val_pos)},
            "test": {"rows": int(test_rows), "aircraft": int(test_ac), "positives": int(test_pos)},
        },
    }


def parse_model_card(path: Path) -> dict[str, Any] | None:
    """Optional: reports/model_card.json (written by src/pipeline.py). Not
    an ArtifactError if missing -- older/partial runs may not have it yet --
    but every phase-01 v2 field (calibration, threshold_policies, ci,
    baselines, alert_rate) is sourced from here, verbatim, when present.
    """
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def parse_multi_seed(path: Path) -> list[dict[str, Any]] | None:
    """Optional: reports/multi_seed.csv, written by `python -m src.pipeline
    --seeds N`. Absent unless a multi-seed run was performed."""
    if not path.exists():
        return None
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def parse_target(design_report_path: Path) -> dict[str, float]:
    text = _read(design_report_path)
    m = re.search(r"Target:\s*recall\s*>=\s*(\d+\.\d+),\s*alerts/100\s*<=\s*(\d+\.\d+)", text)
    if not m:
        raise ArtifactError(f"could not find operating target line in {design_report_path}")
    return {"min_recall": float(m.group(1)), "max_alerts_per_100": float(m.group(2))}


def find_sweep_row_at_threshold(sweep: list[dict[str, Any]], threshold: float) -> dict[str, Any]:
    for row in sweep:
        if abs(row["threshold"] - threshold) < 1e-9:
            return row
    raise ArtifactError(
        f"chosen threshold {threshold} not found as an exact grid point in the threshold sweep"
    )


def build() -> dict[str, Any]:
    dataset = parse_dataset_summary(DOCS_DIR / "demo-evidence.md")
    target = parse_target(DOCS_DIR / "design-report.md")
    metrics_rows = parse_metrics_table(REPORTS_DIR / "metrics_table.md")

    threshold_sweeps = {
        model_id: parse_threshold_sweep(REPORTS_DIR / f"threshold_sweep_{model_id}.csv")
        for model_id in MODEL_LABELS
    }
    feature_importance = {
        model_id: parse_feature_importance(REPORTS_DIR / f"feature_importance_{model_id}.csv")
        for model_id in MODEL_LABELS
    }
    high_risk_examples = parse_high_risk_examples(REPORTS_DIR / "high_risk_examples.md")
    model_card = parse_model_card(REPORTS_DIR / "model_card.json")
    multi_seed = parse_multi_seed(REPORTS_DIR / "multi_seed.csv")

    # Optional secondary section: the realistic-profile stress test, read from
    # its own parallel tree (reports/realistic/). Never required -- v1 above
    # remains the headline result even if a realistic run has never happened.
    realistic_model_card = parse_model_card(REALISTIC_REPORTS_DIR / "model_card.json")
    realistic_metrics_path = REALISTIC_REPORTS_DIR / "metrics_table.md"
    realistic_metrics_rows = (
        parse_metrics_table(realistic_metrics_path) if realistic_metrics_path.exists() else None
    )
    realistic_multi_seed = parse_multi_seed(REALISTIC_REPORTS_DIR / "multi_seed.csv")

    # metrics_table.md may also contain baseline rule rows (src/baselines.py,
    # phase-01 requirement #2) appended by src/pipeline.py's realistic-profile
    # run -- those are reported via model_card["baselines"] (parse_model_card
    # above, surfaced as "baselines_report") instead, since they have no
    # per-threshold sweep CSV of their own (not a trained model). Only the
    # two ML models get the full per-threshold sweep treatment here.
    models: list[dict[str, Any]] = []
    for row in metrics_rows:
        model_id = row["model"]
        if model_id not in MODEL_LABELS:
            continue
        sweep = threshold_sweeps[model_id]
        chosen_threshold = float(row["chosen_threshold"])
        val_row = find_sweep_row_at_threshold(sweep, chosen_threshold)
        test_recall = float(row["test_recall"])
        test_alerts_per_100 = float(row["test_alerts_per_100"])
        target_met = (
            test_recall >= target["min_recall"]
            and test_alerts_per_100 <= target["max_alerts_per_100"]
        )
        models.append(
            {
                "id": model_id,
                "label": MODEL_LABELS[model_id],
                "is_primary": model_id == dataset["primary_model_id"],
                "val_roc_auc": float(row["val_roc_auc"]),
                "val_pr_auc": float(row["val_pr_auc"]),
                "test_roc_auc": float(row["test_roc_auc"]),
                "test_pr_auc": float(row["test_pr_auc"]),
                "chosen_threshold": chosen_threshold,
                "threshold_status": row["threshold_status"],
                "test_recall": test_recall,
                "test_precision": float(row["test_precision"]),
                "test_alerts_per_100": test_alerts_per_100,
                "test_n_alerts": int(row["test_n_alerts"]),
                "test_n_positive": int(row["test_n_positive"]),
                "target_met": target_met,
                "val_at_chosen_threshold": {
                    "recall": val_row["recall"],
                    "precision": val_row["precision"],
                    "alerts_per_100": val_row["alerts_per_100"],
                    "n_alerts": val_row["n_alerts"],
                    "tp": val_row["tp"],
                    "fp": val_row["fp"],
                    "fn": val_row["fn"],
                },
            }
        )

    return {
        "$schema_note": (
            "Every field in this file is derived from reports/*.csv, reports/*.md, "
            "and docs/*.md already on disk in this repo -- see "
            "dashboard/scripts/build_dashboard_data.py. Nothing here is hand-typed."
        ),
        "dataset": dataset,
        "target": target,
        "models": models,
        "primary_model_id": dataset["primary_model_id"],
        "threshold_sweeps": threshold_sweeps,
        "threshold_sweep_split": "validation",
        "feature_importance": feature_importance,
        "high_risk_examples": high_risk_examples,
        # phase-01 v2 additions -- None when reports/model_card.json / multi_seed.csv
        # are absent (older or partial runs), never fabricated.
        "model_card": model_card,
        "calibration": (model_card or {}).get("calibration"),
        "threshold_policies": (model_card or {}).get("threshold_policies"),
        "served_policy": (model_card or {}).get("served_policy"),
        "ci": (model_card or {}).get("ci"),
        "alert_rate": (model_card or {}).get("alert_rate"),
        "alert_rate_definition": (model_card or {}).get("alert_rate_definition"),
        "baselines_report": (model_card or {}).get("baselines"),
        "multi_seed": multi_seed,
        # Secondary, optional: realistic-profile stress test (coordinator
        # decision -- v1 above stays the headline/served result). None of
        # this is present until `python -m src.pipeline --profile realistic`
        # has been run at least once.
        "realistic": {
            "model_card": realistic_model_card,
            "metrics_table": realistic_metrics_rows,
            "multi_seed": realistic_multi_seed,
        }
        if realistic_model_card is not None
        else None,
    }


def main() -> int:
    try:
        data = build()
    except ArtifactError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size:,} bytes)")
    print(f"  dataset.aircraft={data['dataset']['aircraft']}  "
          f"positive_rate={data['dataset']['positive_rate_pct']}%")
    for m in data["models"]:
        print(
            f"  model={m['id']:<24} test_recall={m['test_recall']:.4f}  "
            f"test_alerts_per_100={m['test_alerts_per_100']:.4f}  "
            f"target_met={m['target_met']}"
        )
    print(f"  high_risk_examples={len(data['high_risk_examples'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
