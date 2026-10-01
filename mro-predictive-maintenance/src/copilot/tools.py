"""Copilot tools: read tools execute directly; write tools are deferred
(``ask_user``) or approval-gated (``create_work_order``,
``recommend_aircraft_status``, ``acknowledge_alert``).

Every tool takes ``ctx: RunContext[CopilotDeps]`` as its first argument.
Read tools reuse the exact same functions the ``/ops`` and ``/score`` REST
endpoints use (``src.ops.service``, ``src.ops.kpis``, ``src.modeling``,
``src.explainability``) -- there is no second copy of scoring/SHAP/KPI
logic for the copilot to drift out of sync with the API.

Arg validation happens *before* any deferral/approval is raised, per the
phase spec: unknown aircraft/component ids return a structured "not found"
result (the agent's system prompt instructs it to then call ``ask_user``);
an invalid ``task_ref`` (doesn't exist in the KB, or doesn't match the
component's type) raises ``ModelRetry`` so the model re-plans -- it never
reaches a pending approval with a bogus reference.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, ContextManager, Optional

import pandas as pd
from pydantic_ai import ModelRetry, RunContext
from pydantic_ai.exceptions import ApprovalRequired, CallDeferred
from sqlalchemy import select
from sqlalchemy.engine import Connection

from src.explainability import shap_contributions_for_rows
from src.modeling import ALL_FEATURES, predict_scores
from src.ops import kpis as ops_kpis
from src.ops import service as ops_service
from src.ops.db import alerts, work_orders

# Plain-language sensor/feature meaning map for `explain_component`. Kept
# here (not in src/modeling.py, which is owned by another phase) since it's
# copilot-facing presentation, not modeling logic.
_FEATURE_MEANINGS = {
    "cycles_since_last_check": "flight cycles since the last scheduled inspection",
    "cycles_since_install": "flight cycles accumulated since this component was installed",
    "fault_count_last_30d": "count of fault codes logged against this component in the last 30 days",
    "sensor_vibration": "vibration sensor reading",
    "sensor_temperature": "temperature sensor reading",
    "sensor_pressure": "pressure sensor reading",
    "sensor_current_draw": "electrical current draw sensor reading",
    "sensor_flow_rate": "flow-rate sensor reading",
    "sensor_leak_rate": "leak-rate sensor reading",
}


@dataclass
class CopilotDeps:
    """Per-run dependencies injected into every tool call.

    ``ops_conn_factory`` returns a context manager yielding a SQLAlchemy
    ``Connection`` (typically ``lambda: engine.connect()``) -- tools never
    hold a connection open across the whole run, matching ``src.ops``'s
    "every function takes an already-open Connection" convention.

    ``cited_doc_ids``/``numbers_seen``/``retry_count`` are guardrail
    bookkeeping for this run's current turn, read by the
    ``@agent.output_validator`` in ``agent.py``.
    """

    ops_conn_factory: Callable[[], ContextManager[Connection]]
    model_store: object
    kb_index: object
    actor: str
    run_id: str
    cited_doc_ids: set[str] = field(default_factory=set)
    numbers_seen: set[str] = field(default_factory=set)
    retry_count: int = 0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _record_number(deps: CopilotDeps, value: float) -> str:
    """Format a fraction as a percent string and remember it so the output
    validator accepts the model stating this exact figure."""
    text = f"{value * 100:.1f}%" if value != int(value * 100) / 100 else f"{value * 100:.0f}%"
    deps.numbers_seen.add(text)
    return text


# --------------------------------------------------------------------------
# Read tools
# --------------------------------------------------------------------------


def fleet_risk(ctx: RunContext[CopilotDeps], top_n: int = 10,
                component_type: Optional[str] = None, aircraft_id: Optional[str] = None) -> dict:
    """Ranked list of the fleet's highest-risk components right now."""
    store = ctx.deps.model_store
    if not store.loaded:
        raise ModelRetry("Model artifacts are not loaded; cannot score the fleet right now.")
    df = store.test_latest_df
    if component_type:
        df = df[df["component_type"] == component_type]
    if aircraft_id:
        df = df[df["aircraft_id"] == aircraft_id]
    if df.empty:
        return {"results": [], "threshold": float(store.threshold), "model_version": store.model_id}

    scores = predict_scores(store.pipeline, df)
    threshold = float(store.threshold)
    ranked = sorted(zip(df.itertuples(), scores), key=lambda t: -t[1])[:top_n]
    results = []
    for row, score in ranked:
        _record_number(ctx.deps, float(score))
        results.append({
            "component_id": row.component_id,
            "aircraft_id": row.aircraft_id,
            "component_type": row.component_type,
            "risk_score": round(float(score), 4),
            "alert": bool(score >= threshold),
        })
    return {"results": results, "threshold": threshold, "model_version": store.model_id}


def score_component(ctx: RunContext[CopilotDeps], component_id: str) -> dict:
    """Current risk score + alert status + top-5 SHAP factors for one component."""
    store = ctx.deps.model_store
    if not store.loaded:
        raise ModelRetry("Model artifacts are not loaded; cannot score right now.")
    df = store.test_latest_df
    match = df[df["component_id"] == component_id]
    if match.empty:
        return {"found": False, "component_id": component_id, "message": "Unknown component_id."}

    score = float(predict_scores(store.pipeline, match)[0])
    threshold = float(store.threshold)
    _record_number(ctx.deps, score)
    try:
        top_factors = shap_contributions_for_rows(
            store.pipeline, store.model_id, store.background_df, match, top_k_features=5,
        )[0]
    except Exception as exc:  # documented fallback, never a silent swallow
        top_factors = [{"feature": "unavailable", "shap_value": 0.0, "note": f"SHAP failed: {exc}"}]

    return {
        "found": True,
        "component_id": component_id,
        "risk_score": round(score, 4),
        "threshold": threshold,
        "alert": bool(score >= threshold),
        "model_version": store.model_id,
        "top_factors": top_factors,
    }


def explain_component(ctx: RunContext[CopilotDeps], component_id: str) -> dict:
    """SHAP factors for a component with a plain-language sensor mapping."""
    scored = score_component(ctx, component_id)
    if not scored.get("found"):
        return scored
    explained = []
    for factor in scored["top_factors"]:
        feature = factor.get("feature", "")
        explained.append({
            **factor,
            "meaning": _FEATURE_MEANINGS.get(feature, "no plain-language mapping available for this feature"),
        })
    scored["top_factors"] = explained
    return scored


def aircraft_overview(ctx: RunContext[CopilotDeps], aircraft_id: str) -> dict:
    """Components, status, and open alerts/work orders for one aircraft."""
    with ctx.deps.ops_conn_factory() as conn:
        from src.ops.db import aircraft_status, predictions

        status_row = conn.execute(
            select(aircraft_status).where(aircraft_status.c.aircraft_id == aircraft_id)
        ).mappings().first()
        pred_rows = conn.execute(
            select(predictions).where(predictions.c.aircraft_id == aircraft_id)
            .order_by(predictions.c.component_id, predictions.c.scored_at.desc())
        ).mappings().all()
        latest_by_component: dict[str, dict] = {}
        for row in pred_rows:
            latest_by_component.setdefault(row["component_id"], dict(row))

        open_alerts = conn.execute(
            select(alerts).where(
                alerts.c.aircraft_id == aircraft_id,
                alerts.c.status.in_(["open", "acknowledged", "wo_raised"]),
            )
        ).mappings().all()
        open_wos = conn.execute(
            select(work_orders).where(
                work_orders.c.aircraft_id == aircraft_id, work_orders.c.status != "closed",
            )
        ).mappings().all()

    if status_row is None and not latest_by_component and not open_alerts:
        return {"found": False, "aircraft_id": aircraft_id, "message": "Unknown aircraft_id."}

    return {
        "found": True,
        "aircraft_id": aircraft_id,
        "status": dict(status_row) if status_row is not None else {"status": "serviceable"},
        "components": list(latest_by_component.values()),
        "open_alerts": [dict(a) for a in open_alerts],
        "open_work_orders": [dict(w) for w in open_wos],
    }


def reliability_kpis(ctx: RunContext[CopilotDeps], component_type: Optional[str] = None) -> dict:
    """MTBUR / removals-per-1000FH / UCL breach per component type + live precision/NFF."""
    from src import config

    if not config.COMPONENTS_CSV.exists() or not config.AIRCRAFT_CSV.exists():
        raise ModelRetry("Fleet reference tables not found; cannot compute reliability KPIs.")
    components_df = pd.read_csv(config.COMPONENTS_CSV)
    aircraft_df = pd.read_csv(config.AIRCRAFT_CSV)
    with ctx.deps.ops_conn_factory() as conn:
        result = ops_kpis.reliability_kpis(conn, components_df, aircraft_df)
    if component_type:
        result["quarterly"] = [r for r in result["quarterly"] if r["component_type"] == component_type]
    for row in result["quarterly"]:
        if row.get("removals_per_1000fh") is not None:
            _record_number(ctx.deps, row["removals_per_1000fh"] / 1000.0)
    return result


def search_manuals(ctx: RunContext[CopilotDeps], query: str,
                    component_type: Optional[str] = None, doc_type: Optional[str] = None) -> dict:
    """Search the maintenance KB; returns hits with doc ids to cite."""
    filters = {}
    if component_type:
        filters["component_type"] = component_type
    if doc_type:
        filters["doc_type"] = doc_type
    hits = ctx.deps.kb_index.search(query, k=5, filters=filters, include_test_fixtures=False)
    for hit in hits:
        ctx.deps.cited_doc_ids.add(hit.doc_id)
    return {
        "hits": [
            {"doc_id": h.doc_id, "title": h.title, "doc_type": h.doc_type, "snippet": h.text[:300]}
            for h in hits
        ],
    }


def list_alerts(ctx: RunContext[CopilotDeps], status: Optional[str] = None) -> dict:
    stmt = select(alerts)
    if status:
        stmt = stmt.where(alerts.c.status == status)
    with ctx.deps.ops_conn_factory() as conn:
        rows = conn.execute(stmt.order_by(alerts.c.opened_at.desc())).mappings().all()
    return {"alerts": [dict(r) for r in rows]}


# --------------------------------------------------------------------------
# Deferred tool (clarification)
# --------------------------------------------------------------------------


_MIN_ASK_USER_OPTIONS = 2
_MAX_ASK_USER_OPTIONS = 5
# Phrases that mean "this isn't a real choice, it's an instruction to the
# user" -- the exact live bug this guards against: an ask_user options list
# of one item, "Please specify the aircraft ID." (not a pickable value).
_NON_OPTION_PHRASES = ("please specify", "please provide", "please clarify", "please tell me", "specify the")


def _validate_ask_user_options(options: list[str]) -> None:
    """Server-side validation for ask_user's options list (task item #3):
    either omitted (free text only) or 2-5 concrete, distinct, pickable
    choices -- never a single non-option like "Please specify the aircraft
    ID." Raises ``ModelRetry`` so the model re-plans a real options list
    instead of a pending card reaching the human with a useless option."""
    if not options:
        return
    if not (_MIN_ASK_USER_OPTIONS <= len(options) <= _MAX_ASK_USER_OPTIONS):
        raise ModelRetry(
            f"ask_user's options list must be either omitted (rely on free text only) or contain "
            f"{_MIN_ASK_USER_OPTIONS}-{_MAX_ASK_USER_OPTIONS} concrete choices; got {len(options)}. "
            "Either drop the options list or give real, distinct values the user can pick (e.g. "
            "specific aircraft/component ids)."
        )
    normalized = [o.strip().lower() for o in options]
    if len(set(normalized)) != len(normalized):
        raise ModelRetry("ask_user's options must be distinct; the same choice was listed more than once.")
    for opt in options:
        stripped = opt.strip()
        lowered = stripped.lower()
        if not stripped or any(lowered.startswith(p) for p in _NON_OPTION_PHRASES):
            raise ModelRetry(
                f"ask_user option {opt!r} is not a concrete, pickable choice (it reads like an "
                "instruction to the user, not an option). Give a real value instead, e.g. a specific "
                "aircraft id, component id, or other concrete answer."
            )


def ask_user(ctx: RunContext[CopilotDeps], question: str, options: list[str],
             allow_free_text: bool = True) -> str:
    """Ask the human a clarifying question. Always deferred -- the run
    pauses in ``awaiting_input`` until a human answers via the resume API
    (``hitl.resolve``); the return value here is only reached on resume,
    where Pydantic AI substitutes it with the human's answer.

    ``options`` is validated *before* deferral (see
    ``_validate_ask_user_options``): an empty list (free text only) is
    fine, but a non-empty list must be 2-5 concrete, distinct choices --
    never the single non-option a live run once produced ("Please specify
    the aircraft ID."). An invalid list raises ``ModelRetry`` so the model
    re-plans instead of a bad card ever reaching the pending-approval UI.
    """
    options = list(options or [])
    _validate_ask_user_options(options)
    raise CallDeferred(metadata={
        "kind": "ask_user",
        "question": question,
        "options": options,
        "allow_free_text": allow_free_text,
    })


# --------------------------------------------------------------------------
# Approval-gated write tools
# --------------------------------------------------------------------------


def _require_component_and_aircraft(ctx: RunContext[CopilotDeps], aircraft_id: str, component_id: str) -> None:
    store = ctx.deps.model_store
    if store.loaded:
        known = store.test_latest_df
        if not ((known["component_id"] == component_id) & (known["aircraft_id"] == aircraft_id)).any():
            raise ModelRetry(
                f"component_id={component_id!r} on aircraft_id={aircraft_id!r} was not found in the "
                "current fleet snapshot. Verify the ids (use fleet_risk/aircraft_overview) or ask_user."
            )


def create_work_order(ctx: RunContext[CopilotDeps], aircraft_id: str, component_id: str,
                       task_ref: Optional[str], priority: str, justification: str) -> dict:
    """Create a work order. ALWAYS requires human approval.

    Args:
        aircraft_id: The aircraft the component is installed on.
        component_id: The component to raise a work order against.
        task_ref: An AMM/TSM KB doc id to follow (or None if not applicable).
        priority: Exactly one of "routine", "urgent", or "aog" -- no other value is valid.
        justification: Why this work order is being raised.

    Registering this tool with the declarative ``requires_approval=True``
    flag would defer it *before* Pydantic AI ever calls this function body
    (it only checks JSON-schema arg validity first) -- so unknown
    ids/invalid ``task_ref`` would reach a pending-approval card instead of
    being rejected outright, which is exactly what the phase spec says must
    NOT happen ("Invalid task_ref -> ModelRetry, never pending"). Instead
    this tool is registered plain and validates arguments on *every* call
    (both the pre-approval and the post-approval re-invocation Pydantic AI
    performs), then explicitly ``raise ApprovalRequired(...)`` only once
    validation passes and ``ctx.tool_call_approved`` is still False -- the
    approval gate is enforced here, not delegated to tool registration.
    ``src.ops.service.create_work_order``'s own ``ApprovalRequiredError``
    (a non-empty ``approved_by``) is a second, independent enforcement
    point at the storage layer, so no code path can ever insert a work
    order without both gates agreeing.
    """
    if priority not in {"routine", "urgent", "aog"}:
        raise ModelRetry(f"invalid priority {priority!r}; must be one of routine/urgent/aog.")
    _require_component_and_aircraft(ctx, aircraft_id, component_id)
    if task_ref is not None:
        doc = ctx.deps.kb_index.get_doc(task_ref)
        if doc is None:
            raise ModelRetry(f"task_ref {task_ref!r} does not exist in the knowledge base.")
        component_type = None
        store = ctx.deps.model_store
        if store.loaded:
            row = store.test_latest_df[store.test_latest_df["component_id"] == component_id]
            if not row.empty:
                component_type = row.iloc[0]["component_type"]
        if component_type and doc["component_types"] and component_type not in doc["component_types"]:
            raise ModelRetry(
                f"task_ref {task_ref!r} is for component types {doc['component_types']}, not {component_type!r}."
            )
        ctx.deps.cited_doc_ids.add(task_ref)

    if not ctx.tool_call_approved:
        raise ApprovalRequired(metadata={
            "preview": {
                "aircraft_id": aircraft_id, "component_id": component_id,
                "task_ref": task_ref, "priority": priority, "justification": justification,
            },
        })

    with ctx.deps.ops_conn_factory() as conn:
        result = ops_service.create_work_order(
            conn, aircraft_id=aircraft_id, component_id=component_id,
            task_ref=task_ref, priority=priority, created_by="copilot",
            approved_by=ctx.deps.actor, notes=justification,
        )
    return result


def recommend_aircraft_status(ctx: RunContext[CopilotDeps], aircraft_id: str, status: str,
                               mel_item: Optional[str], reason: str) -> dict:
    """Recommend an aircraft status change (advisory). ALWAYS requires
    human approval -- the copilot never grounds/releases an aircraft on its
    own; ``approved_by`` is always the human who approved the resolution,
    recorded via ``src.ops.service.set_aircraft_status``'s approval gate.
    See ``create_work_order``'s docstring for why this raises
    ``ApprovalRequired`` manually instead of using ``requires_approval=True``."""
    if status not in {"serviceable", "restricted", "aog"}:
        raise ModelRetry(f"invalid status {status!r}; must be one of serviceable/restricted/aog.")

    if not ctx.tool_call_approved:
        raise ApprovalRequired(metadata={
            "preview": {"aircraft_id": aircraft_id, "status": status, "mel_item": mel_item, "reason": reason},
        })

    with ctx.deps.ops_conn_factory() as conn:
        result = ops_service.set_aircraft_status(
            conn, aircraft_id, status, updated_by=ctx.deps.actor, mel_item=mel_item,
            reason=f"[copilot advisory, approved_by={ctx.deps.actor}] {reason}",
        )
    result["advisory"] = True
    result["approved_by"] = ctx.deps.actor
    return result


def acknowledge_alert(ctx: RunContext[CopilotDeps], alert_id: int, note: str) -> dict:
    """Acknowledge an open alert. ALWAYS requires human approval. See
    ``create_work_order``'s docstring for why this raises
    ``ApprovalRequired`` manually instead of using ``requires_approval=True``."""
    with ctx.deps.ops_conn_factory() as conn:
        row = conn.execute(select(alerts.c.status).where(alerts.c.id == alert_id)).first()
    if row is None:
        raise ModelRetry(f"alert {alert_id} not found.")
    if row[0] not in {"open"}:
        raise ModelRetry(f"alert {alert_id} is in status {row[0]!r}; only an 'open' alert can be acknowledged.")

    if not ctx.tool_call_approved:
        raise ApprovalRequired(metadata={"preview": {"alert_id": alert_id, "note": note}})

    with ctx.deps.ops_conn_factory() as conn:
        try:
            result = ops_service.transition_alert(conn, alert_id, "acknowledge", actor=ctx.deps.actor, note=note)
        except ops_service.InvalidTransition as exc:
            raise ModelRetry(str(exc)) from exc
    return result
