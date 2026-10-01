"""Model backend selection for the copilot agent.

Two backends:

- **Real**: ``pydantic_ai.models.openai.OpenAIChatModel`` over the OpenAI
  Chat Completions API, gated on ``OPENAI_API_KEY``. Model name from
  ``OPENAI_MODEL`` (default ``gpt-4o-mini``).
- **Offline scripted**: a deterministic ``FunctionModel`` that routes on
  keyword/intent rules over the prompt + prior tool returns -- no network
  call, fully reproducible, used for the test suite and as a no-key
  fallback for local demos. Every surface that reports the active model
  name must show ``"offline-scripted"`` verbatim for this mode (never
  "gpt-4o-mini" or similar) so the UI/API/tests can never present it as a
  real LLM -- this is the "offline mode is seen as fake" mitigation from
  the phase risk table.

Pattern reference (no import, re-implemented for this app's venv):
``agent-harness/src/agent_harness/llm_client.py``.
"""

from __future__ import annotations

import os
import re
from typing import Any, Optional

from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, FunctionModel

OFFLINE_SCRIPTED_MODEL_NAME = "offline-scripted"


class ProviderError(RuntimeError):
    """Raised when a real OpenAI model is requested but not configured."""


def openai_configured() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY"))


def build_openai_model(api_key: Optional[str] = None, model: Optional[str] = None):
    key = api_key or os.environ.get("OPENAI_API_KEY")
    if not key:
        raise ProviderError(
            "OPENAI_API_KEY is not set. Export it (env var only -- never hard-code a "
            "key in this repo) to use the real LLM backend, or omit it to run the "
            "offline-scripted backend."
        )
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    model_name = model or os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    return OpenAIChatModel(model_name, provider=OpenAIProvider(api_key=key))


def _last_tool_return(messages: list[ModelMessage]) -> Optional[ToolReturnPart]:
    for message in reversed(messages):
        for part in reversed(getattr(message, "parts", [])):
            if part.part_kind == "tool-return":
                return part
    return None


def _first_user_prompt(messages: list[ModelMessage]) -> str:
    for message in messages:
        for part in getattr(message, "parts", []):
            if part.part_kind == "user-prompt" and isinstance(part.content, str):
                return part.content
    return ""


def _tool_call(tool_name: str, args: dict) -> ModelResponse:
    return ModelResponse(parts=[ToolCallPart(tool_name=tool_name, args=args)])


def _final(text: str) -> ModelResponse:
    return ModelResponse(parts=[TextPart(content=text)])


_AMBIGUOUS_RE = re.compile(r"\bcheck\b.*\b(pump|component|it|that|this)\b", re.IGNORECASE)
# Component ids in this dataset are compound: "<aircraft-id>-<COMPONENT_TYPE>"
# with an optional "-S<n>" reinstall suffix, e.g. "AC-003-APU_STARTER" or
# "AC-001-BLEED_VALVE-S2" (see data/raw/components.csv). A bare
# "[A-Z]{2,4}-\d{3,6}" only ever matches the leading aircraft-id segment of
# a compound id, never the full component id -- fixed by requiring the
# trailing "-<TYPE>" segment.
_COMPONENT_ID_RE = re.compile(r"\b([A-Z]{2,4}-\d{3,6}-[A-Z][A-Z0-9_]*(?:-S\d+)?)\b")
_AIRCRAFT_ID_RE = re.compile(r"\b(AC-?\d{3,6}|N\d{3,6}[A-Z]{0,2})\b", re.IGNORECASE)


def _route(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
    """Deterministic intent router used by the offline-scripted backend.

    Rules (documented, not hidden):
    1. First turn, prompt matches ``_AMBIGUOUS_RE`` and gives no explicit
       component/aircraft id -> ``ask_user`` with fleet-risk-derived options.
    2. First turn, prompt mentions "work order"/"create a wo"/"raise a wo"
       plus a component id -> ``create_work_order`` (always approval-gated
       by the tool itself regardless of this router).
    3. First turn, prompt mentions "ground"/"restrict"/"aircraft status" ->
       ``recommend_aircraft_status``.
    4. First turn, prompt mentions "acknowledge"/"ack" + an alert id ->
       ``acknowledge_alert``.
    5. First turn otherwise -> ``fleet_risk`` (safe default read tool) then,
       once a tool result exists, produce a final text answer citing a KB
       id only if a ``search_manuals`` result was returned earlier in this
       run (guardrail-safe: never invents a citation).
    6. After any deferred/approval tool call comes back with a denial or an
       approved result, produce a final textual answer acknowledging it.
    """
    prompt = _first_user_prompt(messages)
    lower = prompt.lower()
    last_return = _last_tool_return(messages)

    if last_return is not None:
        content = last_return.content
        if last_return.tool_name in ("create_work_order", "recommend_aircraft_status", "acknowledge_alert"):
            if isinstance(content, str) and content.lower().startswith("user denied"):
                return _final(f"Understood -- not proceeding. {content}")
            return _final(f"Done: {content}")
        if last_return.tool_name == "ask_user":
            return _final(f"Thanks -- using your answer: {content}")
        if last_return.tool_name == "search_manuals":
            hits = content.get("hits", []) if isinstance(content, dict) else []
            if hits:
                doc_id = hits[0]["doc_id"]
                return _final(
                    f"Based on {doc_id}, follow the referenced procedure before dispatch. [{doc_id}]"
                )
            return _final("No matching manual found for that query; escalate to engineering.")
        if last_return.tool_name in ("fleet_risk", "score_component"):
            return _final("Reviewed current risk scores; no further action needed unless you want a work order raised.")
        if last_return.tool_name == "aircraft_overview":
            return _final("Aircraft overview reviewed.")
        return _final(f"Tool result received: {content}")

    component_match = _COMPONENT_ID_RE.search(prompt)
    aircraft_match = _AIRCRAFT_ID_RE.search(prompt)

    if "work order" in lower or "raise a wo" in lower or "create a wo" in lower:
        if component_match and aircraft_match:
            return _tool_call("create_work_order", {
                "aircraft_id": aircraft_match.group(1),
                "component_id": component_match.group(1),
                "task_ref": None,
                "priority": "routine",
                "justification": prompt,
            })
        return _tool_call("ask_user", {
            "question": "Which aircraft and component should the work order be raised against?",
            "options": [],
            "allow_free_text": True,
        })

    if "ground" in lower or "restrict" in lower or "aircraft status" in lower:
        if aircraft_match:
            return _tool_call("recommend_aircraft_status", {
                "aircraft_id": aircraft_match.group(1),
                "status": "restricted",
                "mel_item": None,
                "reason": prompt,
            })
        return _tool_call("ask_user", {
            "question": "Which aircraft's status should change?", "options": [], "allow_free_text": True,
        })

    if ("acknowledge" in lower or lower.strip().startswith("ack")) and re.search(r"\d+", prompt):
        alert_id = int(re.search(r"\d+", prompt).group(0))
        return _tool_call("acknowledge_alert", {"alert_id": alert_id, "note": prompt})

    if _AMBIGUOUS_RE.search(lower) and not component_match:
        return _tool_call("ask_user", {
            "question": "Which component type do you mean? Multiple pumps are currently in the fleet.",
            "options": ["HYD_PUMP", "APU_STARTER", "BLEED_VALVE"],
            "allow_free_text": True,
        })

    if component_match:
        return _tool_call("score_component", {"component_id": component_match.group(1)})

    return _tool_call("fleet_risk", {"top_n": 5, "component_type": None, "aircraft_id": None})


def _wrap_as_stream_function(route_fn):
    """Adapt any synchronous ``(messages, info) -> ModelResponse`` routing
    function into the async ``stream_function`` ``FunctionModel.request_stream``
    requires, so ``node.stream()`` works for hand-scripted test models too,
    not just ``_route``.

    ``FunctionModel.request_stream``'s documented contract: every yielded
    item must be either a plain ``str`` (a text delta) or a ``DeltaToolCalls``
    mapping (``dict[int, DeltaToolCall]``) -- yielding a raw ``ToolCallPart``
    is not part of that contract and makes
    ``FunctionStreamedResponse._get_event_iterator`` hit its ``assert_never``
    branch, which ``node.stream()`` surfaces as ``UnexpectedModelBehavior:
    Exceeded maximum output retries`` for every offline-scripted turn that
    starts with a tool call. Fixed by building a proper ``DeltaToolCall``
    (name + tool_call_id first, then the full JSON args) for each tool-call
    part instead.
    """

    async def _stream(messages: list[ModelMessage], info: AgentInfo):
        response = route_fn(messages, info)
        for part in response.parts:
            if isinstance(part, TextPart):
                for i in range(0, len(part.content), 8):
                    yield part.content[i:i + 8]
            elif isinstance(part, ToolCallPart):
                yield {0: DeltaToolCall(name=part.tool_name, tool_call_id=part.tool_call_id)}
                yield {0: DeltaToolCall(json_args=part.args_as_json_str())}
            else:  # pragma: no cover -- routing functions never produce other part kinds
                raise TypeError(f"_wrap_as_stream_function: unsupported ModelResponse part kind {part.part_kind!r}")

    return _stream


_stream_route = _wrap_as_stream_function(_route)


def build_offline_router() -> FunctionModel:
    return FunctionModel(_route, stream_function=_stream_route, model_name=OFFLINE_SCRIPTED_MODEL_NAME)


def resolve_model(prefer_openai: bool = True) -> tuple[Any, str]:
    """Return ``(model, mode)`` where ``mode`` is ``"openai"`` or
    ``"offline-scripted"``. Never silently falls back on a configured-but-
    broken OpenAI setup -- callers that need a hard failure should call
    ``build_openai_model`` directly."""
    if prefer_openai and openai_configured():
        return build_openai_model(), "openai"
    return build_offline_router(), OFFLINE_SCRIPTED_MODEL_NAME


def build_scripted_model(fn) -> FunctionModel:
    """Test helper: wrap an arbitrary routing function as a labelled
    offline-scripted ``FunctionModel`` (used by ``tests/test_copilot_*``
    to script exact scenarios without depending on ``_route``'s heuristics).
    Also given a generic ``stream_function`` adapter (see
    ``_wrap_as_stream_function``) so ``node.stream()`` works for
    hand-scripted models too -- ``RunManager`` always calls ``node.stream()``
    regardless of backend."""
    return FunctionModel(fn, stream_function=_wrap_as_stream_function(fn), model_name=OFFLINE_SCRIPTED_MODEL_NAME)
