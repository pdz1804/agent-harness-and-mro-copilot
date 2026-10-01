"""Pydantic AI model factories.

Phase 11b replaced the harness's hand-rolled `LLMClient` abstraction with
`pydantic_ai.models.Model` instances driven by `AgentLoop` via
`agent.iter()` (see `loop.py`). This module only builds/configures those
`Model` objects (or deterministic test doubles) — it no longer owns any
decide/parse/validate logic; that responsibility now lives partly in
Pydantic AI itself (tool-call arg parsing) and partly in `loop.py` (the
harness's own validation/approval/retry/limit logic, still 100% hand-built
per the phase-11b spec).

- `build_openai_model(...)` — the real runtime backend
  (`pydantic_ai.models.openai.OpenAIChatModel`), gated on `OPENAI_API_KEY`.
- `build_scripted_model(script, ...)` — deterministic, test-facing
  replacement for the old `ScriptedLLMClient`. Returns a `FunctionModel`
  that plays back a fixed list of `{"action": ..., ...}` decision dicts, in
  the exact same shape the old harness used, converted to a
  `pydantic_ai.messages.ModelResponse` under the hood.
- `build_test_model(...)` — thin wrapper around `pydantic_ai.models.test.
  TestModel`, for tests/CLI `--mock` use where "some tool call happens"
  is enough (replaces `HeuristicMockLLMClient`'s rule-based behavior; see
  phase-11b-v2 phase file, item 6).
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Literal, Optional

from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel

from agent_harness import settings

_KNOWN_SERVICES = ("auth-service", "payments-api", "search-index")


class ProviderError(RuntimeError):
    """Raised when constructing/configuring a real LLM provider model fails
    in a way the harness should surface verbatim (e.g. missing API key)."""


def decision_to_model_response(decision: dict[str, Any]) -> ModelResponse:
    """Convert a legacy-shaped decision dict (`{"action": "tool_call", ...}`
    or `{"action": "final_answer", ...}`) into a `ModelResponse`. Shared by
    `build_scripted_model` (test doubles) and available for any other
    dict-shaped scripted decision source."""
    action = decision.get("action")
    if action == "tool_call":
        return ModelResponse(
            parts=[
                ToolCallPart(
                    tool_name=decision.get("tool_name") or "",
                    args=decision.get("tool_args") or {},
                )
            ]
        )
    if action == "final_answer":
        return ModelResponse(parts=[TextPart(content=decision.get("final_answer") or "")])
    raise ValueError(f"decision dict must have action in ('tool_call', 'final_answer'), got: {decision!r}")


def build_scripted_model(script: list[dict[str, Any]], think_time_seconds: float = 0.0) -> FunctionModel:
    """Deterministic `FunctionModel` that replays a fixed script of raw
    decision dicts, one per model call — direct replacement for the old
    `ScriptedLLMClient`. Exhausted scripts repeat the last entry (matching
    the old client's behavior) so limit tests that never intend to reach a
    final_answer keep producing the same tool_call forever until the loop's
    own step/time limit aborts it.
    """
    if not script:
        raise ValueError("build_scripted_model requires a non-empty script")
    state = {"index": 0}

    def _fn(messages: list[Any], info: AgentInfo) -> ModelResponse:
        if think_time_seconds:
            time.sleep(think_time_seconds)
        idx = min(state["index"], len(script) - 1)
        state["index"] += 1
        return decision_to_model_response(script[idx])

    return FunctionModel(_fn, model_name="scripted")


def build_raising_then_scripted_model(
    fail_times: int,
    then_script: list[dict[str, Any]],
    fail_exc: type[Exception] = RuntimeError,
    fail_message: str = "simulated malformed/unparseable model output",
) -> FunctionModel:
    """`FunctionModel` that raises `fail_exc` on the first `fail_times`
    calls (simulating a provider response Pydantic AI itself cannot parse),
    then plays back `then_script` normally. Used by
    `tests/test_malformed_llm_response.py` to exercise `loop.py`'s own
    malformed-response retry path without a real network call.
    """
    state = {"n": 0}

    def _fn(messages: list[Any], info: AgentInfo) -> ModelResponse:
        state["n"] += 1
        if state["n"] <= fail_times:
            raise fail_exc(fail_message)
        idx = min(state["n"] - fail_times - 1, len(then_script) - 1)
        return decision_to_model_response(then_script[idx])

    return FunctionModel(_fn, model_name="raising-then-scripted")


def build_streaming_final_answer_model(final_answer: str, chunk_size: int = 6) -> FunctionModel:
    """`FunctionModel` with a real `stream_function`, so `node.stream()`
    genuinely streams the final answer in chunks — used where a test needs
    to exercise the `llm_token_delta` SSE path deterministically (plain
    `FunctionModel`/`TestModel` don't implement `node.stream()` at all; see
    `loop.py`'s `_supports_streaming` gate)."""

    def _fn(messages: list[Any], info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart(content=final_answer)])

    async def _stream_fn(messages: list[Any], info: AgentInfo):
        for i in range(0, len(final_answer), chunk_size):
            # A small per-chunk delay keeps this test double from completing
            # the whole run faster than an SSE subscriber can attach to it
            # (a real streaming call always has *some* network latency
            # between chunks; a zero-delay double doesn't, which otherwise
            # makes `tests/test_api_streaming.py`'s delta-order assertions
            # racy against how fast the test's own HTTP round-trip is).
            await asyncio.sleep(0.05)
            yield final_answer[i : i + chunk_size]

    return FunctionModel(_fn, stream_function=_stream_fn, model_name="streaming-final-answer")


def _first_user_prompt(messages: list[ModelMessage]) -> str:
    for message in messages:
        for part in getattr(message, "parts", []):
            if part.part_kind == "user-prompt" and isinstance(part.content, str):
                return part.content
    return ""


def _last_tool_return(messages: list[ModelMessage]) -> Optional[ToolReturnPart]:
    for message in reversed(messages):
        for part in reversed(getattr(message, "parts", [])):
            if part.part_kind == "tool-return":
                return part
    return None


def build_routing_model() -> FunctionModel:
    """Deterministic, content-aware `FunctionModel` double — a direct port
    of the pre-migration `HeuristicMockLLMClient`'s rule-based routing
    (objective text -> which tool to call first; a service's `down`/
    `degraded` status plus "incident"/"outage"/"create"/"report" in the
    objective -> escalate via `create_incident`) onto the new node-driving
    loop. Unlike `build_test_model()` (`TestModel`, which ignores prompt
    content and cycles through every registered tool once per run — too
    coarse for API tests that must NOT always trigger the approval-gated
    `create_incident` tool), this reads the actual objective text and tool
    results, so `tests/test_api_async_runs.py`/`test_api_streaming.py` can
    deterministically get either a plain completed run or a
    `pending_approval` one, matching the objective given, with no real
    network call.
    """

    def _fn(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        objective = _first_user_prompt(messages)
        lower = objective.lower()
        last_return = _last_tool_return(messages)

        if last_return is None:
            for svc in _KNOWN_SERVICES:
                if svc in lower:
                    return decision_to_model_response(
                        {
                            "action": "tool_call",
                            "tool_name": "get_service_status",
                            "tool_args": {"service_name": svc},
                        }
                    )
            return decision_to_model_response(
                {"action": "tool_call", "tool_name": "search_knowledge_base", "tool_args": {"query": objective}}
            )

        content = last_return.content if isinstance(last_return.content, dict) else {}
        if last_return.tool_name == "get_service_status":
            status = content.get("status")
            if status in ("down", "degraded") and any(
                k in lower for k in ("incident", "outage", "create", "report")
            ):
                return decision_to_model_response(
                    {
                        "action": "tool_call",
                        "tool_name": "create_incident",
                        "tool_args": {
                            "title": f"Service impacted: {content.get('service_name', 'unknown')}",
                            "description": f"Automated check found status='{status}' for objective: {objective}",
                            "severity": "high" if status == "down" else "medium",
                        },
                    }
                )
            return decision_to_model_response({"action": "final_answer", "final_answer": f"Service status: {status}."})

        if last_return.tool_name == "search_knowledge_base":
            if any(k in lower for k in ("incident", "outage", "create", "report")):
                return decision_to_model_response(
                    {
                        "action": "tool_call",
                        "tool_name": "create_incident",
                        "tool_args": {
                            "title": objective[:80],
                            "description": f"Auto-drafted from objective: {objective}",
                            "severity": "medium",
                        },
                    }
                )
            results = content.get("results", [])
            summary = results[0]["title"] if results else "no matching articles"
            return decision_to_model_response(
                {"action": "final_answer", "final_answer": f"Searched knowledge base; top result: {summary}."}
            )

        if last_return.tool_name == "create_incident":
            return decision_to_model_response(
                {"action": "final_answer", "final_answer": f"Incident {content.get('incident_id', '(unknown)')} created."}
            )

        return decision_to_model_response({"action": "final_answer", "final_answer": "Done."})

    return FunctionModel(_fn, model_name="routing")


def build_router_model(selection: dict[str, Any]) -> FunctionModel:
    """Deterministic `FunctionModel` double for `agent_runtime`'s auto-
    discover router agent (`output_type=agent_runtime.SkillSelection`).
    Pydantic AI structured output is achieved via a synthetic
    `final_result` tool call — `info.output_tools[0].name` is that tool's
    real name, so this returns a `ToolCallPart` for it with `selection` as
    the args, regardless of which `output_type` the caller's `Agent` used.
    `selection` should be a plain dict shaped like
    `{"skills": [...], "rationale": "...", "confidence": 0.0-1.0}`."""

    def _fn(messages: list[Any], info: AgentInfo) -> ModelResponse:
        output_tools = getattr(info, "output_tools", None) or []
        tool_name = output_tools[0].name if output_tools else "final_result"
        return ModelResponse(parts=[ToolCallPart(tool_name=tool_name, args=dict(selection))])

    return FunctionModel(_fn, model_name="router")


def build_raising_router_model(fail_message: str = "simulated router failure") -> FunctionModel:
    """`FunctionModel` double that always raises, for exercising
    `agent_runtime.resolve_run_plan`'s `skill_routing_failed` degrade path
    without a real network call."""

    def _fn(messages: list[Any], info: AgentInfo) -> ModelResponse:
        raise RuntimeError(fail_message)

    return FunctionModel(_fn, model_name="raising-router")


def build_test_model(call_tools: list[str] | Literal["all"] = "all") -> TestModel:
    """Thin wrapper around `pydantic_ai.models.test.TestModel` — auto-picks
    among the agent's registered tools (optionally constrained to
    `call_tools`) without any network call. Replaces
    `HeuristicMockLLMClient` for the CLI `--mock` flag and for tests where
    "some tool call happens" is sufficient (see phase-11b-v2 item 6)."""
    return TestModel(call_tools=call_tools)


def build_openai_model(api_key: Optional[str] = None, model: Optional[str] = None):
    """Real runtime backend: `pydantic_ai.models.openai.OpenAIChatModel`
    over the OpenAI Chat Completions API, gated on `OPENAI_API_KEY` (via
    `agent_harness.settings` / `.env`), matching the old
    `OpenAIChatLLMClient`'s gating behavior exactly (raises `RuntimeError`
    with the same guidance message if no key is configured)."""
    key = api_key or settings.OPENAI_API_KEY
    if not key:
        raise RuntimeError(
            "OpenAIChatLLMClient requires OPENAI_API_KEY. Copy .env.example to "
            ".env in the agent-harness/ root and set your key, or pass "
            "api_key= explicitly."
        )
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    model_name = model or settings.OPENAI_MODEL
    return OpenAIChatModel(model_name, provider=OpenAIProvider(api_key=key))


def describe_provider_error(exc: Exception) -> str:
    """Turn a Pydantic-AI / underlying `openai` SDK exception into an
    unambiguous message (e.g. "OpenAI: insufficient_quota — add credits"),
    matching the old `OpenAIChatLLMClient._describe_provider_error`."""
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            code = err.get("code") or err.get("type")
            message = err.get("message")
            if code and message:
                return f"OpenAI: {code} — {message}"
    status = getattr(exc, "status_code", None)
    if status == 401:
        return "OpenAI: invalid_api_key — check OPENAI_API_KEY in .env"
    if status == 429:
        return "OpenAI: rate_limit_or_quota — too many requests or insufficient_quota; add credits"
    return f"{exc.__class__.__name__}: {exc}"
