"""Pluggable LLM client interface.

The harness never depends on a specific LLM provider. `LLMClient.raw_decide`
returns an *unvalidated* dict shaped like an `LLMDecision` — intentionally,
because real LLM output is just text/JSON that can be malformed, and the
harness's job is to validate it and recover gracefully. Implementations may
additionally set a `"_llm_meta"` key (model, token usage, latency_ms) —
`AgentLoop._decide` pops it before validating the decision and folds it
into the `llm_decision` trace event's `data.llm_meta`.

Implementations:
- `ScriptedLLMClient` — deterministic, test-facing. Plays back a fixed list
  of raw responses. This is the source of truth used by the pytest suite.
- `HeuristicMockLLMClient` — deterministic, rule-based "fake LLM". Stays
  ONLY as a CI test double now that a real backend exists — never the
  default in the CLI/API demo path (see `cli.py` / `api.py`).
- `OpenAIChatLLMClient` — the real runtime backend. Uses the `openai` SDK's
  native tool-calling (Chat Completions `tools=`), with tool JSON schemas
  generated from the existing pydantic `Tool.input_model`s. Gated on
  `OPENAI_API_KEY` (see `agent_harness.settings`). Never exercised by the
  non-live pytest suite — see `tests/test_openai_client.py` (fake SDK
  response objects, no network) and the single opt-in
  `tests/test_live_openai.py::test_live_...` (`pytest -m live`).
"""

from __future__ import annotations

import json
import time
from abc import ABC, abstractmethod
from typing import Any, Optional

from agent_harness import settings
from agent_harness.tools.base import Tool
from agent_harness.tools.registry import ToolRegistry, build_default_registry


class ProviderError(RuntimeError):
    """Raised when the LLM provider call itself fails (auth, quota, rate
    limit, network) — as opposed to a malformed/unexpected response shape.
    Carries the real provider message (e.g. "OpenAI: insufficient_quota —
    add credits") so it can be surfaced verbatim in the UI instead of a
    generic failure banner. `agent_harness.settings.record_llm_error` is
    called whenever one of these is raised, so `GET /health` can report
    "configured but last call failed" distinctly from "not configured"."""


class LLMClient(ABC):
    """Abstract interface every LLM backend (real or fake) must implement."""

    @abstractmethod
    def raw_decide(self, objective: str, history: list[dict[str, Any]]) -> dict[str, Any]:
        """Return a raw (unvalidated) decision dict for the current state.

        `history` is the serialized list of AgentEvent dicts so far.
        Implementations may raise any Exception to signal a transport/LLM
        failure; the harness treats that the same as a malformed response.
        """
        raise NotImplementedError


class ScriptedLLMClient(LLMClient):
    """Deterministic client that replays a fixed script of raw decisions.

    Used by the test suite to make every scenario (success, malformed
    response + recovery, infinite tool-calling for limit tests) fully
    reproducible without any real model.
    """

    def __init__(self, script: list[dict[str, Any]], think_time_seconds: float = 0.0) -> None:
        if not script:
            raise ValueError("ScriptedLLMClient requires a non-empty script")
        self._script = list(script)
        self._index = 0
        self._think_time_seconds = think_time_seconds

    def raw_decide(self, objective: str, history: list[dict[str, Any]]) -> dict[str, Any]:
        if self._think_time_seconds:
            time.sleep(self._think_time_seconds)
        if self._index >= len(self._script):
            # Script exhausted: repeat the last entry rather than crash, so
            # limit tests (which never intend to reach a final_answer) keep
            # producing tool_call decisions until the loop aborts on its own.
            return dict(self._script[-1])
        item = self._script[self._index]
        self._index += 1
        return dict(item)


class HeuristicMockLLMClient(LLMClient):
    """Small rule-based fake "LLM". Stays ONLY as the deterministic CI test
    double now that a real OpenAI backend exists (see module docstring) —
    it is no longer the CLI/API's default runtime backend.

    Not meant to be clever — it exists so the full tool-calling loop can be
    exercised in tests without any API key.
    """

    _KNOWN_SERVICES = ("auth-service", "payments-api", "search-index")

    def raw_decide(self, objective: str, history: list[dict[str, Any]]) -> dict[str, Any]:
        lower = objective.lower()
        if not history:
            return self._initial_decision(objective, lower)

        # React to whatever happened most recently, including non-happy-path
        # outcomes (approval denied, retries exhausted, bad args) so the
        # heuristic never loops forever proposing the same rejected action.
        last = history[-1]
        event_type = last.get("event_type")
        data = last.get("data", {})

        if event_type == "approval_denied":
            return {
                "action": "final_answer",
                "final_answer": f"{data.get('tool_name', 'the action')} was denied by the approver; "
                "no changes were made.",
            }

        if event_type == "tool_call_retries_exhausted":
            return {
                "action": "final_answer",
                "final_answer": f"Could not complete {data.get('tool_name', 'the tool call')} "
                "after retries; escalate manually.",
            }

        if event_type == "tool_validation_error":
            return {
                "action": "final_answer",
                "final_answer": "Could not proceed: the last tool call had invalid arguments.",
            }

        if event_type == "tool_call_error" and "attempt" not in data:
            # No 'attempt' key means this came from the unknown-tool-name path
            # (a single non-retried error), not a mid-retry attempt.
            return {"action": "final_answer", "final_answer": "That tool does not exist."}

        if event_type == "tool_call_result":
            return self._decide_after_tool_result(objective, lower, data)

        return {"action": "final_answer", "final_answer": "Done."}

    def _initial_decision(self, objective: str, lower: str) -> dict[str, Any]:
        for svc in self._KNOWN_SERVICES:
            if svc in lower:
                return {
                    "action": "tool_call",
                    "tool_name": "get_service_status",
                    "tool_args": {"service_name": svc},
                    "rationale": f"Objective references service '{svc}'.",
                }
        return {
            "action": "tool_call",
            "tool_name": "search_knowledge_base",
            "tool_args": {"query": objective},
            "rationale": "Default first step: search internal docs.",
        }

    def _decide_after_tool_result(
        self, objective: str, lower: str, last_result: dict[str, Any]
    ) -> dict[str, Any]:
        last_tool = last_result.get("tool_name")
        output = last_result.get("output") or {}

        if last_tool == "get_service_status":
            status = output.get("status")
            if status in ("down", "degraded") and any(
                k in lower for k in ("incident", "outage", "create", "report")
            ):
                return {
                    "action": "tool_call",
                    "tool_name": "create_incident",
                    "tool_args": {
                        "title": f"Service impacted: {output.get('service_name', 'unknown')}",
                        "description": f"Automated check found status='{status}' for objective: {objective}",
                        "severity": "high" if status == "down" else "medium",
                    },
                    "rationale": "Service is unhealthy; escalate via incident.",
                }
            return {"action": "final_answer", "final_answer": f"Service status: {status}."}

        if last_tool == "search_knowledge_base":
            if any(k in lower for k in ("incident", "outage", "create", "report")):
                return {
                    "action": "tool_call",
                    "tool_name": "create_incident",
                    "tool_args": {
                        "title": objective[:80],
                        "description": f"Auto-drafted from objective: {objective}",
                        "severity": "medium",
                    },
                    "rationale": "Knowledge base search did not resolve the issue; escalate.",
                }
            results = output.get("results", [])
            summary = results[0]["title"] if results else "no matching articles"
            return {
                "action": "final_answer",
                "final_answer": f"Searched knowledge base; top result: {summary}.",
            }

        if last_tool == "create_incident":
            return {
                "action": "final_answer",
                "final_answer": f"Incident {output.get('incident_id', '(unknown)')} created.",
            }

        return {"action": "final_answer", "final_answer": "Done."}


def _tool_to_openai_schema(tool: Tool) -> dict[str, Any]:
    """Build an OpenAI Chat Completions `tools=[...]` entry directly from a
    tool's existing pydantic `input_model` — no separate schema to maintain."""
    schema = tool.input_model.model_json_schema()
    schema.pop("title", None)
    for prop in schema.get("properties", {}).values():
        prop.pop("title", None)
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": schema,
        },
    }


# Terminal event types after which a tool_call's assistant/tool message pair
# must be "closed" with a tool-role response, even though the tool never
# produced a `tool_call_result` (validation failure, unknown tool, denied
# approval, or retries exhausted). Every OpenAI tool_call the model emits
# requires a matching tool message before the next assistant turn.
_TOOL_CALL_TERMINAL_WITHOUT_RESULT = {
    "tool_validation_error",
    "tool_call_retries_exhausted",
    "approval_denied",
}


class OpenAIChatLLMClient(LLMClient):
    """Real runtime backend: OpenAI Chat Completions with native tool
    calling. Gated entirely on `OPENAI_API_KEY` (via `agent_harness.settings`
    / `.env`). Reconstructs the conversation as proper assistant `tool_calls`
    + `tool` role messages from the harness's AgentEvent history, so the
    model sees a real multi-turn tool-calling transcript rather than a
    flattened JSON blob."""

    _SYSTEM_PROMPT = (
        "You are an ops-assistant agent for an internal engineering team. "
        "Use the available tools to investigate before answering: call "
        "get_service_status to check a service's current status before "
        "escalating anything, call search_knowledge_base to find the "
        "relevant runbook, and only call create_incident when the evidence "
        "(service status and/or knowledge base findings) supports opening "
        "one. Choose severity from that evidence: critical/high for a "
        "confirmed outage or major customer impact, medium for a degraded "
        "service with impact still present after a remediation attempt, low "
        "for minor/cosmetic impact. get_service_status reports error_rate_pct "
        "as a percentage already (e.g. 4.1 means 4.1% of requests errored) — "
        "do not divide it further or call it a fraction. create_incident always requires a "
        "separate human approval step before it takes effect — you do not "
        "need to ask for approval yourself in your reply text, just call "
        "the tool when the evidence justifies it. Once you have enough "
        "information, reply with a plain-text final answer instead of "
        "calling another tool."
    )

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        tools: Optional[ToolRegistry] = None,
        timeout_seconds: float = 30.0,
        max_retries: int = 2,
        client: Any = None,
    ) -> None:
        key = api_key or settings.OPENAI_API_KEY
        if not key and client is None:
            raise RuntimeError(
                "OpenAIChatLLMClient requires OPENAI_API_KEY. Copy .env.example to "
                ".env in the agent-harness/ root and set your key, or pass "
                "api_key= explicitly."
            )
        self._model = model or settings.OPENAI_MODEL
        self._tools: ToolRegistry = tools if tools is not None else build_default_registry()
        self._tool_schemas = [_tool_to_openai_schema(t) for t in self._tools.values()]
        if client is not None:
            # Test seam: inject a fake SDK client (see test_openai_client.py)
            # instead of constructing a real `openai.OpenAI(...)`.
            self._client = client
        else:
            from openai import OpenAI  # local import: openai is an optional runtime dep

            self._client = OpenAI(api_key=key, timeout=timeout_seconds, max_retries=max_retries)

    def raw_decide(self, objective: str, history: list[dict[str, Any]]) -> dict[str, Any]:
        messages = self._build_messages(objective, history)
        t0 = time.monotonic()
        try:
            response = self._client.chat.completions.create(
                model=self._model,
                messages=messages,
                tools=self._tool_schemas,
                tool_choice="auto",
                temperature=0,
            )
        except Exception as exc:  # noqa: BLE001 - re-raised as ProviderError below
            message = self._describe_provider_error(exc)
            settings.record_llm_error(message)
            raise ProviderError(message) from exc
        settings.clear_llm_error()
        latency_ms = (time.monotonic() - t0) * 1000

        message = response.choices[0].message
        usage = getattr(response, "usage", None)
        meta = {
            "model": getattr(response, "model", self._model),
            "latency_ms": round(latency_ms, 1),
            "prompt_tokens": getattr(usage, "prompt_tokens", None) if usage else None,
            "completion_tokens": getattr(usage, "completion_tokens", None) if usage else None,
            "total_tokens": getattr(usage, "total_tokens", None) if usage else None,
        }

        tool_calls = getattr(message, "tool_calls", None)
        if tool_calls:
            call = tool_calls[0]
            # A malformed `arguments` string (invalid JSON) intentionally
            # propagates as a raised exception here: AgentLoop._decide
            # catches any Exception from raw_decide() and records it as
            # `llm_malformed_response`, then retries per max_llm_retries.
            tool_args = json.loads(call.function.arguments or "{}")
            decision: dict[str, Any] = {
                "action": "tool_call",
                "tool_name": call.function.name,
                "tool_args": tool_args,
                "rationale": message.content or None,
            }
        else:
            content = (message.content or "").strip()
            decision = {
                "action": "final_answer",
                "final_answer": content or "(model returned no content)",
            }

        decision["_llm_meta"] = meta
        return decision

    @staticmethod
    def _describe_provider_error(exc: Exception) -> str:
        """Turn an `openai` SDK exception into an unambiguous, real message
        (e.g. "OpenAI: insufficient_quota — add credits") instead of a
        generic "failed" string. Falls back to `str(exc)` for error shapes
        the SDK doesn't expose a structured code/body for."""
        code = None
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
        return f"OpenAI: {exc.__class__.__name__} — {exc}"

    def _build_messages(self, objective: str, history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self._SYSTEM_PROMPT},
            {"role": "user", "content": objective},
        ]
        pending_call_id: Optional[str] = None

        for event in history:
            event_type = event.get("event_type")
            data = event.get("data") or {}
            step = event.get("step")

            if event_type == "llm_decision" and data.get("action") == "tool_call":
                call_id = f"call_{step}"
                messages.append(
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": call_id,
                                "type": "function",
                                "function": {
                                    "name": data.get("tool_name"),
                                    "arguments": json.dumps(data.get("tool_args") or {}),
                                },
                            }
                        ],
                    }
                )
                pending_call_id = call_id
                continue

            if pending_call_id is None:
                continue

            if event_type == "tool_call_result":
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": pending_call_id,
                        "content": json.dumps(data.get("output", {})),
                    }
                )
                pending_call_id = None
            elif event_type == "tool_call_error" and "attempt" not in data:
                # Unknown-tool-name path: a single terminal error, no retries.
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": pending_call_id,
                        "content": json.dumps({"error": data.get("error", "unknown tool")}),
                    }
                )
                pending_call_id = None
            elif event_type in _TOOL_CALL_TERMINAL_WITHOUT_RESULT:
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": pending_call_id,
                        "content": json.dumps(
                            {"error": data.get("error", event_type)}
                        ),
                    }
                )
                pending_call_id = None
            # Any other event (tool_call_started, tool_call_retry,
            # tool_call_timeout, approval_requested, approval_granted,
            # llm_malformed_response, llm_retry_exhausted) is either a
            # mid-flight retry we don't need to replay, or precedes the
            # eventual terminal event handled above — skip it.

        return messages
