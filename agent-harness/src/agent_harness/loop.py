"""The agent execution loop: Pydantic AI's `agent.iter()` drives LLM<->tool
turns; the harness intercepts every node to apply its own hand-built safety
controls (step/wall-clock limits, malformed-response retries, tool-arg
validation, human approval gate, tool execution retries/timeout/backoff) and
to record every sub-step as an `AgentEvent`, until a final answer or a limit
is hit.

Phase 11b migrated this from a hand-parsed `LLMClient.raw_decide()` loop to
driving `pydantic_ai.Agent.iter()` node-by-node (see
the Pydantic AI spike report for the verified API patterns this
follows). Every existing safety property is preserved by design, just
re-anchored to Pydantic AI's node types:

- `ModelRequestNode`: real token-by-token streaming via `node.stream()`,
  emitting the same `llm_token_delta` live-only SSE event as before.
- `CallToolsNode`: the just-completed `ModelResponse` is available here
  (`node.model_response.parts`) — this is where the harness logs its own
  `llm_decision` event (assembled from the completed response, not a raw
  provider payload) and increments the step counter. If any tool calls are
  pending (`if tool_names:` — an empty `CallToolsNode` occurs on the final,
  text-only turn per the spike's finding), letting the loop continue lets
  Pydantic AI's graph invoke the harness's own registered tool wrapper
  functions (see `_build_agent`/`_make_tool_fn` below).
- Tool wrapper functions (registered via `Tool.from_schema`, which skips
  Pydantic AI's own structural arg validation so the harness stays in full
  control): this is where validation (`tool.input_model(**kwargs)`),
  approval, and the existing `ThreadPoolExecutor`-based
  retry/timeout/backoff loop actually run — ported unchanged from the
  pre-migration `_execute_with_retries`/`_request_approval`. Any of these
  failing raises `pydantic_ai.ToolFailed`, which Pydantic AI records as a
  failed tool result and feeds back to the model *within the same run* —
  no restart/history-stitching needed for these cases, since `ToolFailed`
  does not consume Pydantic AI's own retry budget (see the phase-11b-v2
  report's design-decision notes).
- `pydantic_graph.End`: final answer -> existing `final_answer` `AgentEvent`.
- Anything else raised while advancing the node iterator (a genuinely
  unparseable model response Pydantic AI's own tool-arg validation can't
  recover from, a provider transport error, etc.) is the harness's own
  `llm_malformed_response`/`llm_retry_exhausted` retry path: the run is
  resumed via a fresh `agent.iter(message_history=..., ...)` call seeded
  from the last successfully snapshotted message history, up to
  `max_llm_retries` times.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from pathlib import Path
from typing import Any, Optional

from pydantic import ValidationError
from pydantic_ai import Agent, ToolFailed
from pydantic_ai.messages import (
    FinalResultEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    ModelMessage,
    ModelRequest,
    PartDeltaEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    ToolCallPartDelta,
    UserPromptPart,
)
from pydantic_ai.models import Model, ModelRequestParameters
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.settings import ModelSettings
from pydantic_ai.tools import Tool as PydanticTool
from pydantic_graph import End

from agent_harness import db, observability, token_utils
from agent_harness.approval import ApprovalCallback, cli_prompt_approval
from agent_harness.config import HarnessConfig
from agent_harness.exceptions import ApprovalTimeout, ToolPrecheckError
from agent_harness.guardrails import match_objective_patterns, severity_verdict
from agent_harness.schemas import AgentEvent, RunResult, RunStatus, new_run_id
from agent_harness.tools.base import Tool
from agent_harness.tools.registry import ToolRegistry, build_default_registry
from agent_harness.trace_logger import TraceLogger

# Marks an approval-gated call the approver already denied within a step.
_DENIED = object()

SYSTEM_PROMPT = (
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


def check_input_guardrail(objective: str) -> Optional[dict[str, Any]]:
    """Input guardrail (12c), module-level so both `AgentLoop` (the loop's
    own step-0 check) and `run_registry.py` (phase 04 — checked *before*
    resolving an agent's skill routing, so a blocked objective never wastes
    an auto-mode router LLM call) share one implementation. Returns the
    matched guardrail's id/name/pattern, or None if nothing matched
    (including when none are configured/enabled). A DB lookup failure fails
    open — a guardrail-lookup bug must never itself prevent a run that
    should otherwise proceed."""
    try:
        guardrails = db.list_enabled_guardrails(kind="objective_pattern_block")
    except Exception:  # noqa: BLE001
        return None

    for guardrail in guardrails:
        pattern = match_objective_patterns(objective, (guardrail.get("config") or {}).get("patterns") or [])
        if pattern is not None:
            return {
                "guardrail_id": guardrail["id"],
                "guardrail_name": guardrail["name"],
                "matched_pattern": pattern,
            }
    return None


class AgentLoop:
    """Runs one objective through the Pydantic-AI-driven LLM<->tool loop to
    completion or a limit."""

    def __init__(
        self,
        model: Model | str,
        tools: Optional[ToolRegistry] = None,
        config: Optional[HarnessConfig] = None,
        approval_callback: ApprovalCallback = cli_prompt_approval,
        runs_dir: Optional[Path] = None,
        on_event: Optional[Callable[[AgentEvent], None]] = None,
        system_prompt: Optional[str] = None,
        preamble_events: Optional[list[AgentEvent]] = None,
        should_cancel: Optional[Callable[[], bool]] = None,
        tool_settings: Optional[dict[str, dict[str, Any]]] = None,
    ) -> None:
        self.model = model
        # Per-tool overrides of the global timeout/retry limits, keyed by tool
        # name: `{"timeout_seconds": float | None, "max_retries": int | None}`
        # (from the Integrations page). A missing tool, or a `None` value, falls
        # back to `HarnessConfig`.
        self.tool_settings = tool_settings or {}
        # Cooperative cancellation (Stop button): polled at every node
        # boundary, before each tool call, and while streaming. A request
        # already in flight at the provider finishes (it cannot be aborted
        # mid-response), but nothing after it runs: no further LLM turns, no
        # tool execution, and live token deltas stop immediately.
        self.should_cancel = should_cancel
        self.tools: ToolRegistry = tools if tools is not None else build_default_registry()
        self.config = config or HarnessConfig()
        self.approval_callback = approval_callback
        self.runs_dir = runs_dir
        # Phase 12b: the caller (api.py/run_registry.py) looks up whichever
        # `prompt_versions` row is currently active and passes its content
        # here so a new run's agent is genuinely built with it, instead of
        # this hardcoded constant. Falls back to `SYSTEM_PROMPT` (unchanged
        # default) so every existing direct-construction caller (the CLI,
        # every pre-12b test) keeps behaving exactly as before.
        self.system_prompt = system_prompt if system_prompt is not None else SYSTEM_PROMPT
        # `node.stream()` requires real provider-level streaming support.
        # `TestModel` doesn't implement it at all, and `FunctionModel` only
        # does when constructed with a `stream_function` (none of the
        # harness's scripted test doubles need one) — calling `.stream()`
        # against either leaves Pydantic AI's internal per-node stream state
        # stuck "started but never finished" even if the resulting exception
        # is caught, which then breaks the *next* node. Skip streaming
        # entirely up front for these, instead of trying and swallowing.
        self._supports_streaming = not isinstance(model, (TestModel, FunctionModel)) or (
            isinstance(model, FunctionModel) and getattr(model, "stream_function", None) is not None
        )
        # Optional live-event observer (used by the async API run registry to
        # stream progress for GET /runs/{run_id}); unused by the CLI/sync API.
        self.on_event = on_event
        # Phase 04: events resolved by `agent_runtime.resolve_run_plan` (skill
        # routing/assignment/slash-invocation decisions) before this run's
        # agent was even built — logged at step 0, before anything else, so
        # they land first in the run's trace/SSE/inspector, exactly like any
        # other step-0 event. `None`/`[]` for every caller that doesn't use
        # agents at all (every pre-04 direct-construction call site, the CLI,
        # every pre-04 test) — this is the only change this phase makes to
        # `loop.py`; skill/agent resolution itself lives entirely outside it.
        self.preamble_events = list(preamble_events) if preamble_events else []
        # Idempotent no-op unless MLFLOW_TRACKING_URI is set (see
        # observability.py); every `_span(...)` call below then becomes a
        # real nested MLflow span instead of a no-op stand-in.
        observability.init_mlflow()
        # Human approval wait accounting: seconds spent blocked on
        # `approval_callback` are excluded from the agent's wall-clock budget,
        # and an approval that times out ends the run (see `_request_approval`).
        self._approval_wait_seconds = 0.0
        self._approval_timed_out = False

    def _is_cancelled(self) -> bool:
        if self._approval_timed_out:
            return True
        if self.should_cancel is None:
            return False
        try:
            return bool(self.should_cancel())
        except Exception:  # noqa: BLE001 - a broken cancel probe must never kill a run
            return False

    def run(self, objective: str, run_id: Optional[str] = None) -> RunResult:
        """Run one objective to completion or a limit (sync entry point,
        unchanged external contract). Internally drives the async
        Pydantic-AI loop via `asyncio.run` — safe to call from a background
        thread (as `run_registry.py` does), since each call gets its own
        fresh event loop."""
        if not objective or not objective.strip():
            raise ValueError("objective must be a non-empty string")
        return asyncio.run(self._run_async(objective, run_id))

    # -- internals -----------------------------------------------------

    def _build_agent(self) -> Agent:
        # Additive-only construction point (phase 12b): `self.tools` may
        # already be a caller-filtered subset of the full default registry
        # (see `run_registry.py::start_run` filtering on `integrations`), and
        # `self.system_prompt` may be a DB-backed active `prompt_versions`
        # row's content instead of the hardcoded constant. Either way, only
        # tools present in `self.tools` are ever registered on the
        # `pydantic_ai.Agent` below — a disabled tool never enters
        # `pydantic_tools` at all, so it is genuinely unavailable to the LLM,
        # not merely hidden in the UI. No other control flow here changed.
        pydantic_tools = [self._build_pydantic_tool(tool) for tool in self.tools.values()]
        # Approval-gated tools must be proposed one at a time: with parallel
        # tool calls a model can emit the same gated call twice in one
        # response and the human would be asked twice (and the two waits would
        # fight over the run's single pending-approval slot). Providers that
        # don't support the setting ignore it.
        model_settings: Optional[ModelSettings] = (
            ModelSettings(parallel_tool_calls=False) if any(t.requires_approval for t in self.tools.values()) else None
        )
        return Agent(system_prompt=self.system_prompt, tools=pydantic_tools, model_settings=model_settings)

    def _build_pydantic_tool(self, tool: Tool) -> PydanticTool:
        schema = tool.input_model.model_json_schema()
        schema.pop("title", None)
        for prop in schema.get("properties", {}).values():
            prop.pop("title", None)

        async def _fn(**kwargs: Any) -> dict[str, Any]:
            return await self._call_tool(tool, kwargs)

        return PydanticTool.from_schema(
            function=_fn,
            name=tool.name,
            description=tool.description,
            json_schema=schema,
            takes_ctx=False,
        )

    async def _call_tool(self, tool: Tool, raw_args: dict[str, Any]) -> dict[str, Any]:
        """The single hand-built hook Pydantic AI invokes to "execute" a
        tool. Owns validation, approval, and retry/timeout — ported
        unchanged in substance from the pre-migration
        `AgentLoop._request_approval`/`_execute_with_retries`. Raises
        `ToolFailed` (never lets a plain exception propagate) so Pydantic
        AI records a failed tool result and feeds it back to the model
        within the same run, exactly like a `tool_validation_error` /
        `approval_denied` / `tool_call_retries_exhausted` outcome used to
        let the old loop simply `continue` to the next LLM decision."""
        ctx = self._ctx
        step = ctx["step"]

        if self._is_cancelled():
            raise ToolFailed(f"'{tool.name}' was not run: the run was cancelled by the user.")

        try:
            validated_args = tool.input_model(**raw_args)
        except ValidationError as exc:
            ctx["trace"].log(
                AgentEvent(
                    run_id=ctx["run_id"],
                    step=step,
                    event_type="tool_validation_error",
                    data={"tool_name": tool.name, "args": raw_args, "error": str(exc)},
                )
            )
            raise ToolFailed(str(exc)) from exc

        # Output guardrail (12c): sits immediately before the approval gate,
        # never after it — the approver must always see the (possibly
        # already-corrected) severity that will actually be persisted, not
        # the raw LLM proposal. Does not touch `_request_approval` itself.
        validated_args = self._apply_severity_guardrail(ctx, tool, validated_args)

        # Dry-run/permission hook, before the approval gate: a call that
        # cannot succeed (permission denied, a widget query that fails its
        # read-only dry run) is bounced straight back to the LLM instead of
        # asking a human to approve it; otherwise its preview rides along on
        # the approval request so the approver sees exactly what will happen.
        preview: Optional[dict[str, Any]] = None
        try:
            tool.bind_context(run_id=ctx["run_id"])
            preview = tool.precheck(validated_args)
        except ToolPrecheckError as exc:
            ctx["trace"].log(
                AgentEvent(
                    run_id=ctx["run_id"],
                    step=step,
                    event_type="tool_validation_error",
                    data={"tool_name": tool.name, "args": raw_args, "error": str(exc), "stage": "precheck"},
                )
            )
            raise ToolFailed(str(exc)) from exc

        if not tool.requires_approval:
            return self._run_tool(ctx, tool, validated_args)

        # Approval-gated: one call at a time per run (a single pending-approval
        # slot exists per run), and an identical call already decided within
        # this step is answered from its recorded outcome instead of asking
        # the human a second time.
        async with self._approval_lock:
            key = (step, tool.name, json.dumps(validated_args.model_dump(mode="json"), sort_keys=True, default=str))
            prior = self._decided_calls.get(key)
            if prior is not None:
                if prior is _DENIED:
                    raise ToolFailed(f"'{tool.name}' was denied by the approver; no changes were made.")
                raise ToolFailed(
                    f"'{tool.name}' was already run with identical arguments in this step; "
                    f"do not repeat it. Earlier result: {json.dumps(prior, default=str)}"
                )
            approved = self._request_approval(ctx, tool, validated_args, preview)
            if not approved:
                self._decided_calls[key] = _DENIED
                raise ToolFailed(f"'{tool.name}' was denied by the approver; no changes were made.")
            result = self._run_tool(ctx, tool, validated_args)
            self._decided_calls[key] = result
            return result

    def _run_tool(self, ctx: dict[str, Any], tool: Tool, validated_args: Any) -> dict[str, Any]:
        tool.bind_context(run_id=ctx["run_id"])
        output = self._execute_with_retries(ctx, tool, validated_args)
        if output is None:
            raise ToolFailed(f"'{tool.name}' failed after {self._tool_limits(tool.name)[1] + 1} attempts.")
        return output.model_dump()

    def _apply_severity_guardrail(self, ctx: dict[str, Any], tool: Tool, validated_args: Any) -> Any:
        """Output guardrail (12c): if any `severity_upgrade_block` guardrail
        is enabled, a proposed `create_incident(severity="critical")` must be
        backed by this run's own history actually showing a `down` service
        (the last `get_service_status` tool result) — otherwise the harness
        downgrades it to `high` itself and records a `guardrail_
        severity_downgraded` trace event, rather than passing an
        unsupported severity through unchecked. No-op for every other tool
        and for any severity other than `critical`; a DB lookup failure
        fails open (never blocks a run that should otherwise proceed)."""
        if tool.name != "create_incident":
            return validated_args
        severity = getattr(validated_args, "severity", None)
        if severity != "critical":
            return validated_args

        try:
            guardrails = db.list_enabled_guardrails(kind="severity_upgrade_block")
        except Exception:  # noqa: BLE001 - a guardrail-lookup bug must never break a run
            return validated_args
        if not guardrails:
            return validated_args

        last_status: Optional[str] = None
        for event in reversed(ctx["trace"].history):
            if event.event_type == "tool_call_result" and event.data.get("tool_name") == "get_service_status":
                last_status = (event.data.get("output") or {}).get("status")
                break

        verdict = severity_verdict(severity, last_status)
        if not verdict.fires:
            return validated_args

        downgraded = validated_args.model_copy(update={"severity": "high"})
        ctx["trace"].log(
            AgentEvent(
                run_id=ctx["run_id"],
                step=ctx["step"],
                event_type="guardrail_severity_downgraded",
                data={
                    "guardrail_id": guardrails[0]["id"],
                    "guardrail_name": guardrails[0]["name"],
                    "tool_name": tool.name,
                    "title": getattr(validated_args, "title", None),
                    "proposed_severity": "critical",
                    "downgraded_to": "high",
                    "evidence_status": last_status,
                    "reason": verdict.reason,
                },
            )
        )
        return downgraded

    def _check_input_guardrail(self, objective: str) -> Optional[dict[str, Any]]:
        """Input guardrail (12c): before the loop ever starts, block an
        objective that matches any enabled `objective_pattern_block`
        guardrail. Thin wrapper around the module-level `check_input_
        guardrail` (phase 04 extracted this so `run_registry.py` can run the
        exact same check *before* resolving an agent's skill routing —
        never wastes an auto-mode router call on an objective that would be
        blocked anyway, and never lets a blocked run's trace show a
        `skill_routed`/`skills_assigned`/etc. preamble event ahead of
        `guardrail_blocked`)."""
        return check_input_guardrail(objective)

    def _request_approval(
        self, ctx: dict[str, Any], tool: Tool, validated_args: Any, preview: Optional[dict[str, Any]] = None
    ) -> bool:
        args_dict = validated_args.model_dump()
        trace: TraceLogger = ctx["trace"]
        requested_data: dict[str, Any] = {"tool_name": tool.name, "args": args_dict}
        if preview is not None:
            requested_data["preview"] = preview
        trace.log(
            AgentEvent(
                run_id=ctx["run_id"],
                step=ctx["step"],
                event_type="approval_requested",
                data=requested_data,
            )
        )
        wait_started = time.monotonic()
        try:
            approved = bool(self.approval_callback(tool.name, args_dict))
        except ApprovalTimeout as exc:
            self._approval_wait_seconds += time.monotonic() - wait_started
            self._approval_timed_out = True
            trace.log(
                AgentEvent(
                    run_id=ctx["run_id"],
                    step=ctx["step"],
                    event_type="approval_timed_out",
                    data={
                        "tool_name": tool.name,
                        "args": args_dict,
                        "waited_seconds": round(exc.waited_seconds, 3),
                        "timeout_seconds": exc.timeout_seconds,
                        "reason": f"No approval decision for '{tool.name}' within {exc.timeout_seconds:g}s.",
                    },
                )
            )
            raise ToolFailed(f"'{tool.name}' was not run: the approval request timed out.") from exc
        self._approval_wait_seconds += time.monotonic() - wait_started
        trace.log(
            AgentEvent(
                run_id=ctx["run_id"],
                step=ctx["step"],
                event_type="approval_granted" if approved else "approval_denied",
                data={"tool_name": tool.name, "args": args_dict},
            )
        )
        return approved

    def _tool_limits(self, tool_name: str) -> tuple[float, int]:
        """`(timeout_seconds, max_retries)` that apply to `tool_name`: its own
        Integrations override where set, else the global `HarnessConfig` value."""
        override = self.tool_settings.get(tool_name) or {}
        timeout = override.get("timeout_seconds")
        retries = override.get("max_retries")
        return (
            float(timeout) if timeout is not None else self.config.tool_timeout_seconds,
            int(retries) if retries is not None else self.config.max_tool_retries,
        )

    def _execute_with_retries(self, ctx: dict[str, Any], tool: Tool, validated_args: Any):
        with observability.span(
            f"tool_call:{tool.name}", span_type="TOOL", attributes={"run_id": ctx["run_id"], "step": ctx["step"]}
        ) as mlf_span:
            mlf_span.set_inputs(validated_args.model_dump())
            output = self._execute_with_retries_inner(ctx, tool, validated_args)
            mlf_span.set_outputs(
                {"result": output.model_dump() if output is not None else None, "succeeded": output is not None}
            )
            return output

    def _execute_with_retries_inner(self, ctx: dict[str, Any], tool: Tool, validated_args: Any):
        trace: TraceLogger = ctx["trace"]
        run_id, step = ctx["run_id"], ctx["step"]
        args_dict = validated_args.model_dump()
        attempt = 0
        timeout_seconds, max_retries = self._tool_limits(tool.name)
        max_attempts = max_retries + 1

        while attempt < max_attempts:
            attempt += 1
            trace.log(
                AgentEvent(
                    run_id=run_id,
                    step=step,
                    event_type="tool_call_started",
                    data={"tool_name": tool.name, "args": args_dict, "attempt": attempt},
                )
            )
            t0 = time.monotonic()
            try:
                with ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(tool.run, validated_args)
                    output = future.result(timeout=timeout_seconds)
            except FutureTimeoutError:
                latency_ms = (time.monotonic() - t0) * 1000
                trace.log(
                    AgentEvent(
                        run_id=run_id,
                        step=step,
                        event_type="tool_call_timeout",
                        latency_ms=latency_ms,
                        data={
                            "tool_name": tool.name,
                            "args": args_dict,
                            "attempt": attempt,
                            "timeout_seconds": timeout_seconds,
                        },
                    )
                )
            except Exception as exc:  # noqa: BLE001 - ToolExecutionError or unexpected bug
                latency_ms = (time.monotonic() - t0) * 1000
                trace.log(
                    AgentEvent(
                        run_id=run_id,
                        step=step,
                        event_type="tool_call_error",
                        latency_ms=latency_ms,
                        data={
                            "tool_name": tool.name,
                            "args": args_dict,
                            "attempt": attempt,
                            "error": str(exc),
                        },
                    )
                )
            else:
                latency_ms = (time.monotonic() - t0) * 1000
                trace.log(
                    AgentEvent(
                        run_id=run_id,
                        step=step,
                        event_type="tool_call_result",
                        latency_ms=latency_ms,
                        data={
                            "tool_name": tool.name,
                            "args": args_dict,
                            "attempt": attempt,
                            "output": output.model_dump(),
                        },
                    )
                )
                return output

            if attempt < max_attempts:
                trace.log(
                    AgentEvent(
                        run_id=run_id,
                        step=step,
                        event_type="tool_call_retry",
                        data={"tool_name": tool.name, "next_attempt": attempt + 1},
                    )
                )
                time.sleep(self.config.tool_retry_backoff_seconds)

        trace.log(
            AgentEvent(
                run_id=run_id,
                step=step,
                event_type="tool_call_retries_exhausted",
                data={"tool_name": tool.name, "attempts": attempt},
            )
        )
        return None

    async def _run_async(self, objective: str, run_id: Optional[str]) -> RunResult:
        run_id = run_id or new_run_id()
        try:
            with observability.span(
                "agent_run", span_type="AGENT", attributes={"run_id": run_id}
            ) as mlf_span:
                mlf_span.set_inputs({"objective": objective})
                result = await self._run_async_inner(objective, run_id)
                mlf_span.set_outputs(
                    {
                        "status": result.status,
                        "final_answer": result.final_answer,
                        "steps_taken": result.steps_taken,
                        "elapsed_seconds": result.elapsed_seconds,
                    }
                )
                return result
        finally:
            # `mlflow.start_span()`'s context manager above already calls
            # `end_span()` on both the success and exception paths (this
            # `finally` runs after that `with` block has fully exited
            # either way), so the root `agent_run` span is always closed
            # locally. What is missing without this call is getting that
            # closed span actually *sent* to the tracking server before a
            # short-lived process (the CLI, or this run's background
            # worker thread) exits — see `observability.flush()`'s
            # docstring for the root cause (MLflow's async trace-logging
            # queue). Runs that end via approval-denied or
            # step-limit-exceeded still return a normal `RunResult` here
            # (not an exception), so this single `finally` covers every
            # terminal path: success, denied-approval, step-limit, and
            # unhandled exception alike.
            observability.flush()

    async def _run_async_inner(self, objective: str, run_id: str) -> RunResult:
        trace = TraceLogger(run_id=run_id, runs_dir=self.runs_dir, on_event=self.on_event)
        start = time.monotonic()

        # Phase 04 preamble events (skill_routed/skills_assigned/
        # skill_invoked/skill_routing_failed/no_tools_available), always
        # logged first — before the input guardrail check, before the agent
        # is built — so they are genuinely step-0, first-in-trace events,
        # not merely displayed first.
        for event in self.preamble_events:
            trace.log(event.model_copy(update={"run_id": run_id}))

        # Input guardrail (12c): checked before the agent/loop is built at
        # all — a match ends the run immediately, genuinely never invoking
        # the LLM or any tool, not just cosmetically stopping early.
        blocked = self._check_input_guardrail(objective)
        if blocked is not None:
            trace.log(
                AgentEvent(
                    run_id=run_id,
                    step=0,
                    event_type="guardrail_blocked",
                    data={"objective": objective, **blocked},
                )
            )
            return RunResult(
                run_id=run_id,
                objective=objective,
                status="guardrail_blocked",
                final_answer=(
                    f"Blocked by guardrail '{blocked['guardrail_name']}': objective matched "
                    f"banned pattern '{blocked['matched_pattern']}'."
                ),
                steps_taken=0,
                elapsed_seconds=time.monotonic() - start,
                history=trace.history,
                trace_path=str(trace.path),
            )

        step_index = 0
        status: RunStatus = "running"
        final_answer: Optional[str] = None
        llm_attempt = 0
        message_history: list[Any] = []
        agent = self._build_agent()
        # `_ctx` is the harness-internal handle the tool wrapper functions
        # (`_call_tool` and friends) read `run_id`/`step`/`trace` from —
        # Pydantic AI calls those functions with only the model-chosen
        # tool args, so this sidesteps needing a custom `deps_type` just to
        # thread three read-mostly values through.
        self._ctx: dict[str, Any] = {"run_id": run_id, "step": 0, "trace": trace}
        self._approval_lock = asyncio.Lock()
        self._decided_calls: dict[tuple[int, str, str], Any] = {}
        self._approval_wait_seconds = 0.0
        self._approval_timed_out = False

        def _agent_elapsed() -> float:
            # Agent compute time only: a human deciding on an approval is
            # budgeted separately (`approval_timeout_seconds`).
            return time.monotonic() - start - self._approval_wait_seconds

        def _time_exceeded() -> bool:
            return _agent_elapsed() >= self.config.max_wall_clock_seconds

        def _log_cancelled() -> None:
            data: dict[str, Any] = {
                "elapsed_seconds": time.monotonic() - start,
                "reason": "approval_timeout" if self._approval_timed_out else "user",
            }
            trace.log(AgentEvent(run_id=run_id, step=step_index, event_type="run_cancelled", data=data))

        while True:
            if self._is_cancelled():
                _log_cancelled()
                status = "cancelled"
                break
            if _time_exceeded():
                elapsed = _agent_elapsed()
                trace.log(
                    AgentEvent(
                        run_id=run_id,
                        step=step_index,
                        event_type="time_limit_exceeded",
                        data={"elapsed_seconds": elapsed, "limit_seconds": self.config.max_wall_clock_seconds},
                    )
                )
                status = "time_limit_exceeded"
                break

            try:
                async with agent.iter(
                    None if message_history else objective,
                    message_history=message_history or None,
                    model=self.model,
                ) as run:
                    done = False
                    async for node in run:
                        if self._is_cancelled():
                            _log_cancelled()
                            status = "cancelled"
                            done = True
                            break
                        if _time_exceeded():
                            elapsed = _agent_elapsed()
                            trace.log(
                                AgentEvent(
                                    run_id=run_id,
                                    step=step_index,
                                    event_type="time_limit_exceeded",
                                    data={
                                        "elapsed_seconds": elapsed,
                                        "limit_seconds": self.config.max_wall_clock_seconds,
                                    },
                                )
                            )
                            status = "time_limit_exceeded"
                            done = True
                            break

                        if Agent.is_model_request_node(node):
                            await self._stream_model_request(node, run, run_id, step_index, trace)
                            continue

                        if Agent.is_call_tools_node(node):
                            if step_index >= self.config.max_steps:
                                trace.log(
                                    AgentEvent(
                                        run_id=run_id,
                                        step=step_index,
                                        event_type="step_limit_exceeded",
                                        data={"steps_taken": step_index, "limit": self.config.max_steps},
                                    )
                                )
                                status = "step_limit_exceeded"
                                done = True
                                break
                            step_index += 1
                            self._ctx["step"] = step_index
                            self._log_llm_decision(node, run_id, step_index, trace)
                            await self._maybe_autocompact(run, run_id, step_index, trace)
                            message_history = run.all_messages()
                            continue

                        if isinstance(node, End):
                            final_answer = node.data.output
                            trace.log(
                                AgentEvent(
                                    run_id=run_id,
                                    step=step_index,
                                    event_type="final_answer",
                                    data={"final_answer": final_answer, "rationale": None},
                                )
                            )
                            status = "completed"
                            done = True
                            break

                    if done:
                        break
            except Exception as exc:  # noqa: BLE001 - any unrecoverable node/provider failure is "malformed"
                llm_attempt += 1
                trace.log(
                    AgentEvent(
                        run_id=run_id,
                        step=step_index,
                        event_type="llm_malformed_response",
                        data={"attempt": llm_attempt, "error": str(exc)},
                    )
                )
                if llm_attempt > self.config.max_llm_retries:
                    trace.log(
                        AgentEvent(
                            run_id=run_id,
                            step=step_index,
                            event_type="llm_retry_exhausted",
                            data={"attempts": llm_attempt},
                        )
                    )
                    status = "llm_error_exceeded"
                    break
                continue
            else:
                break

        elapsed_total = time.monotonic() - start
        return RunResult(
            run_id=run_id,
            objective=objective,
            status=status,
            final_answer=final_answer,
            steps_taken=step_index,
            elapsed_seconds=elapsed_total,
            history=trace.history,
            trace_path=str(trace.path),
        )

    async def _stream_model_request(self, node, run, run_id: str, step: int, trace: TraceLogger) -> None:
        if not self._supports_streaming:
            return
        with observability.span(
            "llm_request", span_type="LLM", attributes={"run_id": run_id, "step": step}
        ):
            async with node.stream(run.ctx) as request_stream:
                await self._consume_stream(request_stream, run_id, step, trace)

    async def _consume_stream(self, request_stream, run_id: str, step: int, trace: TraceLogger) -> None:
        async for event in request_stream:
                if self._is_cancelled():
                    # Keep draining the provider stream (Pydantic AI needs
                    # it consumed to finish the node cleanly) but stop
                    # pushing tokens to the UI.
                    continue
                if isinstance(event, PartStartEvent):
                    part = event.part
                    if part.part_kind == "text" and part.content:
                        trace.emit_live(
                            AgentEvent(
                                run_id=run_id,
                                step=step,
                                event_type="llm_token_delta",
                                data={"field": "final_answer", "delta": part.content},
                            )
                        )
                    elif part.part_kind == "tool-call" and part.args:
                        args = part.args if isinstance(part.args, str) else str(part.args)
                        trace.emit_live(
                            AgentEvent(
                                run_id=run_id,
                                step=step,
                                event_type="llm_token_delta",
                                data={"field": "tool_args", "delta": args},
                            )
                        )
                elif isinstance(event, PartDeltaEvent):
                    delta = event.delta
                    if isinstance(delta, TextPartDelta) and delta.content_delta:
                        trace.emit_live(
                            AgentEvent(
                                run_id=run_id,
                                step=step,
                                event_type="llm_token_delta",
                                data={"field": "final_answer", "delta": delta.content_delta},
                            )
                        )
                    elif isinstance(delta, ToolCallPartDelta) and delta.args_delta:
                        args_delta = delta.args_delta
                        if not isinstance(args_delta, str):
                            args_delta = str(args_delta)
                        trace.emit_live(
                            AgentEvent(
                                run_id=run_id,
                                step=step,
                                event_type="llm_token_delta",
                                data={"field": "tool_args", "delta": args_delta},
                            )
                        )
                elif isinstance(event, (FinalResultEvent, FunctionToolCallEvent, FunctionToolResultEvent)):
                    continue

    def _log_llm_decision(self, node, run_id: str, step: int, trace: TraceLogger) -> None:
        response = node.model_response
        tool_calls = [p for p in response.parts if p.part_kind == "tool-call"]
        text_parts = [p.content for p in response.parts if p.part_kind == "text" and p.content]
        rationale = "".join(text_parts) or None

        if tool_calls:
            first = tool_calls[0]
            data: dict[str, Any] = {
                "action": "tool_call",
                "tool_name": first.tool_name,
                "tool_args": first.args_as_dict(),
                "rationale": rationale,
            }
            for call in tool_calls:
                if call.tool_name not in self.tools:
                    # Pydantic AI itself will auto-retry-prompt the model
                    # for an unregistered tool name (its own recoverable-
                    # mistake handling) — record the harness's own
                    # visibility event too, matching the pre-migration
                    # behavior of surfacing every unknown-tool attempt.
                    trace.log(
                        AgentEvent(
                            run_id=run_id,
                            step=step,
                            event_type="tool_call_error",
                            data={
                                "tool_name": call.tool_name,
                                "error": f"Unknown tool '{call.tool_name}'; not in registry.",
                            },
                        )
                    )
        else:
            data = {
                "action": "final_answer",
                "final_answer": rationale or "",
                "rationale": None,
            }

        usage = getattr(response, "usage", None)
        if usage is not None:
            data["llm_meta"] = {
                "model": getattr(response, "model_name", None),
                "prompt_tokens": getattr(usage, "input_tokens", None),
                "completion_tokens": getattr(usage, "output_tokens", None),
                "total_tokens": (
                    (getattr(usage, "input_tokens", 0) or 0) + (getattr(usage, "output_tokens", 0) or 0)
                )
                or None,
            }

        with observability.span(
            "llm_decision", span_type="LLM", attributes={"run_id": run_id, "step": step}
        ) as mlf_span:
            mlf_span.set_outputs(data)

        trace.log(AgentEvent(run_id=run_id, step=step, event_type="llm_decision", data=data))

    async def _maybe_autocompact(self, run, run_id: str, step: int, trace: TraceLogger) -> None:
        """Autocompaction (11d): if the run's accumulated message history has
        grown past `HarnessConfig.autocompact_token_budget` (real tiktoken
        count, not a heuristic — see `token_utils`), fold everything except
        the most recent `autocompact_keep_recent_messages` messages into one
        summary message via a real extra LLM call, and mutate the running
        graph's own message-history state in place so every subsequent LLM
        call in *this same run* actually sends the shorter history.

        `run.ctx.state.message_history` (not the `message_history` local
        variable the outer loop reassigns from `run.all_messages()`) is the
        list Pydantic AI's graph itself reads from for the next
        `ModelRequestNode` within an in-flight `agent.iter()` context — see
        `pydantic_ai.run.AgentRun.ctx` / `_agent_graph.GraphAgentState`.
        Mutating it in place (`[:] = ...`) is required: replacing the
        attribute with a new list would not be visible to the graph run
        already holding a reference to the old one.
        """
        state = run.ctx.state
        history = state.message_history
        keep_recent = self.config.autocompact_keep_recent_messages
        if len(history) <= keep_recent:
            return

        tokens_before = token_utils.count_message_tokens(history)
        if tokens_before < self.config.autocompact_token_budget:
            return

        older = list(history[:-keep_recent])
        recent = list(history[-keep_recent:])
        if not older:
            return

        with observability.span(
            "context_compaction", span_type="LLM", attributes={"run_id": run_id, "step": step}
        ) as mlf_span:
            mlf_span.set_inputs({"messages_summarized": len(older), "tokens_before": tokens_before})
            summary_text = await self._summarize_messages(older)
            mlf_span.set_outputs({"summary": summary_text})

        compacted: list[Any] = [
            ModelRequest(
                parts=[
                    UserPromptPart(
                        content=f"[Summary of {len(older)} earlier conversation message(s)]\n{summary_text}"
                    )
                ]
            )
        ] + recent
        tokens_after = token_utils.count_message_tokens(compacted)
        state.message_history[:] = compacted

        trace.log(
            AgentEvent(
                run_id=run_id,
                step=step,
                event_type="context_compacted",
                data={
                    "messages_summarized": len(older),
                    "messages_kept_verbatim": len(recent),
                    "tokens_before": tokens_before,
                    "tokens_after": tokens_after,
                    "token_budget": self.config.autocompact_token_budget,
                    "summary": summary_text,
                },
            )
        )

    async def _summarize_messages(self, older_messages: list[Any]) -> str:
        """The one real extra LLM call autocompaction makes: summarize
        `older_messages` via `self.model` directly (bypassing `agent.iter()`
        entirely — this is a plain text-in/text-out request, no tools, no
        graph state of its own to manage)."""
        rendered = token_utils.render_messages(older_messages)
        prompt = (
            "Summarize the earlier part of this ops-assistant agent's conversation so "
            "far, in a few concise sentences. Preserve concrete facts: service names, "
            "statuses, error rates, tool results, and any decisions already made. Do "
            "not invent new information or add instructions — output only the summary "
            "text itself.\n\n---\n" + rendered
        )
        if isinstance(self.model, str):
            raise RuntimeError("autocompaction needs a resolved model instance, not a model name")
        request_messages: list[ModelMessage] = [ModelRequest(parts=[UserPromptPart(content=prompt)])]
        response = await self.model.request(request_messages, None, ModelRequestParameters())
        text_parts = [part.content for part in response.parts if isinstance(part, TextPart) and part.content]
        return "".join(text_parts).strip() or "(no summary produced)"
