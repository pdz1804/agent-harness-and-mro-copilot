"""Unit tests for src/copilot/tools.py -- each tool called directly against
a fake RunContext (tools only read `ctx.deps`, so a minimal stub is enough
and keeps these tests fast/independent of the full agent loop; the
agent-level pause/resume behavior is covered by test_copilot_hitl.py).

Uses the real trained model artifacts (models/, reports/model_card.json)
and the real KB (kb/) -- no mocking of scoring/SHAP/retrieval.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from pydantic_ai import ModelRetry  # noqa: E402
from pydantic_ai.exceptions import ApprovalRequired  # noqa: E402

from src import config  # noqa: E402
from src.copilot import tables  # noqa: E402  (registers copilot_guardrail_events on shared metadata)
from src.copilot import tools as copilot_tools  # noqa: E402
from src.copilot.retrieval import KBIndex  # noqa: E402
from src.copilot.tools import CopilotDeps  # noqa: E402
from src.ops import db as ops_db  # noqa: E402
from src.ops import service as ops_service  # noqa: E402
from src.service.model_store import ModelStore  # noqa: E402


@pytest.fixture
def engine(tmp_path):
    eng = ops_db.make_engine(f"sqlite:///{tmp_path / 'ops.db'}")
    ops_db.init_db(eng)
    yield eng
    eng.dispose()


@pytest.fixture(scope="module")
def loaded_store():
    if not config.MODEL_CARD_JSON.exists():
        pytest.skip("reports/model_card.json missing -- run `python -m src.pipeline` first")
    store = ModelStore()
    store.load()
    return store


@pytest.fixture(scope="module")
def kb_index():
    return KBIndex.build()


@pytest.fixture
def deps(engine, loaded_store, kb_index):
    return CopilotDeps(
        ops_conn_factory=engine.connect, model_store=loaded_store, kb_index=kb_index,
        actor="engineer.demo", run_id="run-test",
    )


def _ctx(deps, tool_call_approved: bool = True):
    return SimpleNamespace(deps=deps, tool_call_approved=tool_call_approved)


def test_fleet_risk_returns_ranked_results_with_alert_flags(deps):
    out = copilot_tools.fleet_risk(_ctx(deps), top_n=5)
    assert len(out["results"]) == 5
    scores = [r["risk_score"] for r in out["results"]]
    assert scores == sorted(scores, reverse=True)
    for r in out["results"]:
        assert r["alert"] == (r["risk_score"] >= out["threshold"])


def test_fleet_risk_component_type_filter(deps):
    out = copilot_tools.fleet_risk(_ctx(deps), top_n=50, component_type="HYD_PUMP")
    assert all(r["component_id"].endswith("HYD_PUMP") for r in out["results"])


def test_score_component_known_id(deps, loaded_store):
    component_id = loaded_store.test_latest_df.iloc[0]["component_id"]
    out = copilot_tools.score_component(_ctx(deps), component_id)
    assert out["found"] is True
    assert 0.0 <= out["risk_score"] <= 1.0
    assert len(out["top_factors"]) <= 5


def test_score_component_unknown_id_returns_not_found(deps):
    out = copilot_tools.score_component(_ctx(deps), "NOPE-999999")
    assert out["found"] is False


def test_explain_component_adds_plain_language_meaning(deps, loaded_store):
    component_id = loaded_store.test_latest_df.iloc[0]["component_id"]
    out = copilot_tools.explain_component(_ctx(deps), component_id)
    assert out["found"] is True
    assert all("meaning" in f for f in out["top_factors"])


def test_aircraft_overview_unknown_id(deps):
    out = copilot_tools.aircraft_overview(_ctx(deps), "AC-DOES-NOT-EXIST")
    assert out["found"] is False


def test_aircraft_overview_known_id_after_fleet_scan(deps, engine, loaded_store):
    with engine.connect() as conn:
        ops_service.fleet_scan(conn, loaded_store)
    aircraft_id = loaded_store.test_latest_df.iloc[0]["aircraft_id"]
    out = copilot_tools.aircraft_overview(_ctx(deps), aircraft_id)
    assert out["found"] is True
    assert len(out["components"]) > 0


def test_reliability_kpis_returns_quarterly_and_live_outcomes(deps):
    out = copilot_tools.reliability_kpis(_ctx(deps))
    assert "quarterly" in out
    assert "live_outcomes" in out


def test_search_manuals_returns_existing_doc_ids(deps):
    out = copilot_tools.search_manuals(_ctx(deps), "hydraulic pump removal procedure")
    assert out["hits"]
    for hit in out["hits"]:
        assert deps.kb_index.exists(hit["doc_id"])
    assert deps.cited_doc_ids  # search results are tracked for the output-validator guardrail


def test_list_alerts_after_fleet_scan(deps, engine, loaded_store):
    with engine.connect() as conn:
        ops_service.fleet_scan(conn, loaded_store)
    out = copilot_tools.list_alerts(_ctx(deps))
    assert isinstance(out["alerts"], list)


def test_ask_user_always_raises_call_deferred(deps):
    from pydantic_ai.exceptions import CallDeferred

    with pytest.raises(CallDeferred) as exc_info:
        copilot_tools.ask_user(_ctx(deps), "Which component?", ["A", "B"])
    assert exc_info.value.metadata["question"] == "Which component?"


def test_ask_user_allows_empty_options_for_free_text_only(deps):
    from pydantic_ai.exceptions import CallDeferred

    with pytest.raises(CallDeferred) as exc_info:
        copilot_tools.ask_user(_ctx(deps), "Which aircraft?", [])
    assert exc_info.value.metadata["options"] == []


def test_ask_user_rejects_single_non_option_with_model_retry(deps):
    # The real live bug this guards against: an ask_user options list of
    # exactly one item that is itself an instruction, not a pickable value.
    with pytest.raises(ModelRetry, match="concrete"):
        copilot_tools.ask_user(_ctx(deps), "What is the aircraft ID?", ["Please specify the aircraft ID."])


def test_ask_user_rejects_too_many_options_with_model_retry(deps):
    with pytest.raises(ModelRetry, match="2-5"):
        copilot_tools.ask_user(_ctx(deps), "Which component?", ["A", "B", "C", "D", "E", "F"])


def test_ask_user_rejects_duplicate_options_with_model_retry(deps):
    with pytest.raises(ModelRetry, match="distinct"):
        copilot_tools.ask_user(_ctx(deps), "Which component?", ["AC-003-APU_STARTER", "AC-003-APU_STARTER"])


def test_create_work_order_unknown_component_raises_model_retry(deps):
    with pytest.raises(ModelRetry):
        copilot_tools.create_work_order(
            _ctx(deps), aircraft_id="AC-DOES-NOT-EXIST", component_id="NOPE-1",
            task_ref=None, priority="routine", justification="test",
        )


def test_create_work_order_invalid_task_ref_raises_model_retry(deps, loaded_store):
    row = loaded_store.test_latest_df.iloc[0]
    with pytest.raises(ModelRetry):
        copilot_tools.create_work_order(
            _ctx(deps), aircraft_id=row["aircraft_id"], component_id=row["component_id"],
            task_ref="AMM-DOES-NOT-EXIST", priority="routine", justification="test",
        )


def test_create_work_order_mismatched_task_ref_component_type_raises_model_retry(deps):
    # AMM-29-11-00-HYD-PUMP is a HYD_PUMP-only task card; find a non-HYD_PUMP row.
    df = deps.model_store.test_latest_df
    row = df[df["component_type"] != "HYD_PUMP"].iloc[0]
    with pytest.raises(ModelRetry):
        copilot_tools.create_work_order(
            _ctx(deps), aircraft_id=row["aircraft_id"], component_id=row["component_id"],
            task_ref="AMM-29-11-00-HYD-PUMP", priority="routine", justification="test",
        )


def test_create_work_order_raises_approval_required_when_not_yet_approved(deps, loaded_store):
    row = loaded_store.test_latest_df[loaded_store.test_latest_df["component_type"] == "HYD_PUMP"].iloc[0]
    with pytest.raises(ApprovalRequired):
        copilot_tools.create_work_order(
            _ctx(deps, tool_call_approved=False), aircraft_id=row["aircraft_id"], component_id=row["component_id"],
            task_ref="AMM-29-11-00-HYD-PUMP", priority="routine", justification="risk elevated",
        )
    with deps.ops_conn_factory() as conn:
        assert conn.execute(ops_db.work_orders.select()).mappings().first() is None


def test_create_work_order_succeeds_with_valid_args_and_approver(deps, loaded_store):
    row = loaded_store.test_latest_df[loaded_store.test_latest_df["component_type"] == "HYD_PUMP"].iloc[0]
    result = copilot_tools.create_work_order(
        _ctx(deps, tool_call_approved=True), aircraft_id=row["aircraft_id"], component_id=row["component_id"],
        task_ref="AMM-29-11-00-HYD-PUMP", priority="routine", justification="risk elevated",
    )
    assert result["status"] == "open"
    with deps.ops_conn_factory() as conn:
        wo = conn.execute(ops_db.work_orders.select()).mappings().first()
    assert wo["approved_by"] == "engineer.demo"


def test_acknowledge_alert_invalid_transition_raises_model_retry(deps):
    with pytest.raises(ModelRetry):
        copilot_tools.acknowledge_alert(_ctx(deps), alert_id=999999, note="test")
