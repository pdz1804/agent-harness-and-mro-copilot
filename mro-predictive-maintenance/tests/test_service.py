"""Tests for the src/service/ FastAPI scoring service.

Exercises the real trained artifacts already committed under models/ and
reports/ (no mocking of the model or its outputs) -- these tests require
`python -m src.pipeline` to have been run at least once so
`reports/model_card.json` and `models/logistic_regression.joblib` exist,
which is true in this repo and enforced by CI running the pipeline first.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from src import config  # noqa: E402
from src.modeling import ALL_FEATURES, predict_scores  # noqa: E402
from src.service.app import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    if not config.MODEL_CARD_JSON.exists():
        pytest.skip("reports/model_card.json missing -- run `python -m src.pipeline` first")
    with TestClient(app) as c:
        yield c


def test_health_reports_model_loaded(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["model_loaded"] is True
    assert body["model_id"] == config.PRIMARY_MODEL_ID


def test_model_card_matches_disk_artifact(client):
    resp = client.get("/model-card")
    assert resp.status_code == 200
    body = resp.json()
    assert body["model_id"] == config.PRIMARY_MODEL_ID
    assert 0.0 <= body["threshold"] <= 1.0
    assert set(body["numeric_features"] + body["categorical_features"]) == set(ALL_FEATURES)
    # Vocabulary depends on which profile trained the artifacts currently on
    # disk: "v1" (parity mode, src/pipeline.py._run_v1) reuses the original
    # min_alerts enum; "realistic" (src/pipeline.py._run_realistic, phase-01
    # threshold-policy redesign) reports target_met/target_missed against
    # the served max_recall_within_budget policy instead. Both are valid.
    assert body["threshold_status"] in {
        "both_constraints_met", "alert_rate_met_recall_shortfall", "neither_constraint_met",
        "target_met", "target_missed",
    }


def _sample_fleet_item(client, n: int = 5) -> dict:
    resp = client.get(f"/fleet/top-risk?n={n}")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert len(items) >= 1
    return items[0]


def test_fleet_top_risk_is_ranked_and_alert_consistent_with_threshold(client):
    resp = client.get("/fleet/top-risk?n=15")
    assert resp.status_code == 200
    body = resp.json()
    assert body["model_id"] == config.PRIMARY_MODEL_ID
    items = body["items"]
    assert len(items) == min(15, body["n_scored"])

    scores = [it["risk_score"] for it in items]
    assert scores == sorted(scores, reverse=True)

    for it in items:
        assert 0.0 <= it["risk_score"] <= 1.0
        assert it["alert"] == (it["risk_score"] >= body["threshold"])
        assert set(it["features"].keys()) == set(ALL_FEATURES)


def test_fleet_top_risk_rejects_non_positive_n(client):
    resp = client.get("/fleet/top-risk?n=0")
    assert resp.status_code == 422


def test_score_valid_payload_returns_probability_and_shap_factors(client):
    item = _sample_fleet_item(client)
    payload = dict(item["features"])
    payload["component_id"] = item["component_id"]

    resp = client.post("/score", json=payload)
    assert resp.status_code == 200
    body = resp.json()

    assert 0.0 <= body["risk_score"] <= 1.0
    assert body["alert"] == (body["risk_score"] >= body["threshold"])
    assert body["explanation_method"] == "shap"
    assert 1 <= len(body["top_factors"]) <= 5
    for factor in body["top_factors"]:
        assert isinstance(factor["feature"], str)
        assert isinstance(factor["shap_value"], float)


def test_score_missing_categorical_field_is_422(client):
    resp = client.post("/score", json={"aircraft_type": "ATR72"})
    assert resp.status_code == 422


def test_score_rejects_unknown_field(client):
    item = _sample_fleet_item(client)
    payload = dict(item["features"])
    payload["not_a_real_feature"] = 1.0
    resp = client.post("/score", json=payload)
    assert resp.status_code == 422


def test_score_parity_with_offline_pipeline(client):
    """The service's score for a fleet row must equal the offline pipeline's
    predict_proba for the exact same feature row -- same fitted pipeline,
    same feature order, no drift between training-time and serving-time
    scoring logic.
    """
    item = _sample_fleet_item(client)
    payload = dict(item["features"])

    resp = client.post("/score", json=payload)
    assert resp.status_code == 200
    service_score = resp.json()["risk_score"]

    import pandas as pd

    offline_pipeline = __import__("joblib").load(
        config.MODELS_DIR / f"{config.PRIMARY_MODEL_ID}.joblib"
    )
    row_df = pd.DataFrame([{f: payload.get(f) for f in ALL_FEATURES}])
    offline_score = float(predict_scores(offline_pipeline, row_df)[0])

    assert service_score == pytest.approx(offline_score, abs=1e-9)


def test_fleet_components_pages_through_the_whole_scored_fleet(client):
    first = client.get("/fleet/components?limit=50").json()
    assert first["total"] == first["n_scored"]
    assert sum(first["counts"].values()) == first["n_scored"]
    seen: list[str] = []
    offset = 0
    while offset < first["total"]:
        page = client.get(f"/fleet/components?offset={offset}&limit=50").json()
        seen += [i["component_id"] for i in page["items"]]
        offset += 50
    assert len(seen) == len(set(seen)) == first["n_scored"]
    ranks = [i["rank"] for i in first["items"]]
    assert ranks == list(range(1, len(ranks) + 1))
    # Same ranking as /fleet/top-risk.
    top = client.get("/fleet/top-risk?n=50").json()["items"]
    assert [i["component_id"] for i in top] == [i["component_id"] for i in first["items"]]


def test_fleet_components_bands_match_threshold_and_watch_floor(client):
    body = client.get("/fleet/components?limit=1000").json()
    for it in body["items"]:
        if it["risk_score"] >= body["threshold"]:
            expected = "alert"
        elif it["risk_score"] >= body["watch_floor"]:
            expected = "watch"
        else:
            expected = "normal"
        assert it["band"] == expected
        assert it["alert"] == (it["band"] == "alert")
    for band in ("alert", "watch", "normal"):
        page = client.get(f"/fleet/components?band={band}&limit=1000").json()
        assert page["total"] == body["counts"][band]
        assert all(i["band"] == band for i in page["items"])


def test_fleet_components_filters_and_sorts(client):
    body = client.get("/fleet/components?limit=1000").json()
    ctype = body["component_types"][0]
    typed = client.get(f"/fleet/components?component_type={ctype}&limit=1000").json()
    assert typed["total"] > 0 and all(i["component_type"] == ctype for i in typed["items"])
    needle = body["items"][0]["aircraft_id"]
    hits = client.get(f"/fleet/components?q={needle.lower()}&limit=1000").json()["items"]
    assert hits and all(needle in i["component_id"] for i in hits)
    by_cycle = client.get("/fleet/components?sort=cycle&dir=asc&limit=1000").json()["items"]
    cycles = [i["cycle"] for i in by_cycle]
    assert cycles == sorted(cycles)
    lowest = client.get("/fleet/components?dir=asc&limit=1").json()["items"][0]
    assert lowest["rank"] == body["n_scored"]


def test_fleet_components_filters_by_aircraft_type(client):
    body = client.get("/fleet/components?limit=1000").json()
    ac_types = body["aircraft_types"]
    assert ac_types and ac_types == sorted({i["aircraft_type"] for i in body["items"] if i["aircraft_type"]})
    totals = 0
    for ac_type in ac_types:
        page = client.get(f"/fleet/components?aircraft_type={ac_type}&limit=1000").json()
        assert page["total"] > 0 and all(i["aircraft_type"] == ac_type for i in page["items"])
        totals += page["total"]
    assert totals == body["n_scored"]
    assert client.get("/fleet/components?aircraft_type=B747").json()["total"] == 0


@pytest.mark.parametrize(
    "qs", ["offset=-1", "limit=0", "limit=1001", "band=red", "sort=features", "dir=up"],
)
def test_fleet_components_rejects_bad_params(client, qs):
    assert client.get(f"/fleet/components?{qs}").status_code == 422
