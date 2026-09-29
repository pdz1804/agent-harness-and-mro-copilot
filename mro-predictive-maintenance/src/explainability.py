"""Global and local explanations for the trained models.

Global: permutation importance (model-agnostic, computed on held-out
data so importances reflect generalization, not training-set fit) for
both models, plus the tree model's native ``feature_importances_`` for
cross-checking.

Local: SHAP per-row attributions for individual high-risk predictions.
SHAP installed cleanly in this environment (``pip install shap``, pure
pip, no GPU) so it is used directly -- ``TreeExplainer`` for the
HistGradientBoostingClassifier, ``LinearExplainer`` for the logistic
model. If SHAP fails at runtime for any reason (version mismatch,
unsupported estimator, etc.) this module falls back to a simple,
transparent local explanation: for each flagged row, the features whose
z-score (relative to the training population's mean/std) is most
extreme, signed by direction. That fallback is intentionally
documented here rather than silently swapped in.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.inspection import permutation_importance

from .modeling import ALL_FEATURES, CATEGORICAL_FEATURES, NUMERIC_FEATURES


def permutation_importance_table(pipeline, x_eval: pd.DataFrame, y_eval, seed: int = 42,
                                  n_repeats: int = 10) -> pd.DataFrame:
    result = permutation_importance(
        pipeline, x_eval[ALL_FEATURES], y_eval,
        n_repeats=n_repeats, random_state=seed, scoring="average_precision", n_jobs=-1,
    )
    return pd.DataFrame({
        "feature": ALL_FEATURES,
        "importance_mean": result.importances_mean,
        "importance_std": result.importances_std,
    }).sort_values("importance_mean", ascending=False).reset_index(drop=True)


def native_tree_importance(pipeline) -> pd.DataFrame | None:
    """HistGradientBoostingClassifier has no feature_importances_ attribute
    (unlike RandomForest/GradientBoosting) -- it does not expose split-gain
    importances directly. Return None so callers rely on permutation
    importance for this model instead; documented, not a silent gap.
    """
    classifier = pipeline.named_steps["classifier"]
    if hasattr(classifier, "feature_importances_"):
        feature_names = pipeline.named_steps["preprocessor"].get_feature_names_out()
        return pd.DataFrame({
            "feature": feature_names,
            "importance": classifier.feature_importances_,
        }).sort_values("importance", ascending=False).reset_index(drop=True)
    return None


def _zscore_fallback_explanation(train_df: pd.DataFrame, row: pd.Series, top_k: int = 5) -> list[dict]:
    stats = train_df[NUMERIC_FEATURES].agg(["mean", "std"])
    contributions = []
    for f in NUMERIC_FEATURES:
        mean, std = stats.loc["mean", f], stats.loc["std", f]
        if std == 0 or pd.isna(std) or pd.isna(row[f]):
            continue
        z = (row[f] - mean) / std
        contributions.append({"feature": f, "value": row[f], "z_score": z})
    contributions.sort(key=lambda d: abs(d["z_score"]), reverse=True)
    return contributions[:top_k]


def shap_contributions_for_rows(
    pipeline, model_name: str, background_df: pd.DataFrame, target_df: pd.DataFrame,
    top_k_features: int = 5, background_sample_size: int = 100, background_seed: int = 42,
) -> list[list[dict]]:
    """Compute per-row signed SHAP contributions for arbitrary rows.

    No ground-truth label is required, so this is the single code path
    shared by both the offline high-risk report (``explain_high_risk_rows``,
    called from ``src/pipeline.py``) and the live scoring service
    (``src/service/app.py``, one row at a time from ``POST /score``) --
    exactly one SHAP integration to keep in sync with the fitted pipelines.

    Returns one list of ``{"feature": ..., "shap_value": ...}`` dicts (top
    ``top_k_features`` by absolute magnitude) per row of ``target_df``, in
    row order. Raises on any SHAP failure -- callers decide whether/how to
    fall back (``explain_high_risk_rows`` falls back to z-scores; the live
    service surfaces a 5xx with the underlying error rather than silently
    fabricating an explanation).
    """
    import shap

    preprocessor = pipeline.named_steps["preprocessor"]
    classifier = pipeline.named_steps["classifier"]
    feature_names = list(preprocessor.get_feature_names_out())

    x_background = preprocessor.transform(background_df[ALL_FEATURES].sample(
        n=min(background_sample_size, len(background_df)), random_state=background_seed
    ))
    x_target = preprocessor.transform(target_df[ALL_FEATURES])
    if hasattr(x_target, "toarray"):
        x_target = x_target.toarray()
    if hasattr(x_background, "toarray"):
        x_background = x_background.toarray()

    if model_name == "hist_gradient_boosting":
        explainer = shap.Explainer(classifier, x_background, feature_names=feature_names)
    else:
        explainer = shap.LinearExplainer(classifier, x_background, feature_names=feature_names)

    shap_values = explainer(x_target)
    values = shap_values.values
    if values.ndim == 3:  # (n_samples, n_features, n_classes) -> take positive class
        values = values[:, :, -1]

    rows_out = []
    for i in range(len(target_df)):
        contribs = sorted(
            zip(feature_names, values[i]), key=lambda t: abs(t[1]), reverse=True
        )[:top_k_features]
        rows_out.append([{"feature": f, "shap_value": float(v)} for f, v in contribs])
    return rows_out


def explain_high_risk_rows(
    pipeline, model_name: str, train_df: pd.DataFrame, target_df: pd.DataFrame,
    scores: np.ndarray, top_n: int = 5, top_k_features: int = 5,
) -> list[dict]:
    """Return local explanations for the top_n highest-scoring rows in target_df."""
    order = np.argsort(-scores)[:top_n]
    explanations = []

    try:
        selected = target_df.iloc[order].reset_index(drop=True)
        per_row_contribs = shap_contributions_for_rows(
            pipeline, model_name, train_df, selected, top_k_features,
        )

        for i, (row, contribs) in enumerate(zip(selected.itertuples(), per_row_contribs)):
            explanations.append({
                "component_id": row.component_id,
                "component_type": row.component_type,
                "cycle": row.cycle,
                "snapshot_date": str(row.snapshot_date),
                "risk_score": float(scores[order[i]]),
                "true_label": int(row.label),
                "method": "shap",
                "top_features": contribs,
            })
        return explanations

    except Exception as exc:  # documented fallback, not a silent swallow
        fallback_note = f"SHAP explanation failed ({type(exc).__name__}: {exc}); using z-score fallback."
        for idx in order:
            row = target_df.iloc[idx]
            contribs = _zscore_fallback_explanation(train_df, row, top_k_features)
            explanations.append({
                "component_id": row["component_id"],
                "component_type": row["component_type"],
                "cycle": row["cycle"],
                "snapshot_date": str(row["snapshot_date"]),
                "risk_score": float(scores[idx]),
                "true_label": int(row["label"]),
                "method": "zscore_fallback",
                "fallback_reason": fallback_note,
                "top_features": [
                    {"feature": c["feature"], "value": float(c["value"]), "z_score": float(c["z_score"])}
                    for c in contribs
                ],
            })
        return explanations
