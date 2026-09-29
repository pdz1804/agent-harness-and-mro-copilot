"""The agent execution loop: LLM decides -> validate -> (approve) -> execute
-> record, until a final answer or a limit is hit.

State machine (RunStatus): running -> {completed, step_limit_exceeded,
time_limit_exceeded, llm_error_exceeded}. Every transition and every
sub-step (tool call, retry, approval decision, malformed response) is
recorded both in-memory (RunResult.history) and streamed to a JSONL trace
file (TraceLogger) as it happens.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from pathlib import Path
from typing import Any, Callable, Optional

from pydantic import ValidationError

from agent_harness.approval import ApprovalCallback, cli_prompt_approval
from agent_harness.config import HarnessConfig
from agent_harness.llm_client import LLMClient
from agent_harness.schemas import AgentEvent, LLMDecision, RunResult, new_run_id
from agent_harness.tools.base import Tool
from agent_harness.tools.registry import ToolRegistry, build_default_registry
from agent_harness.trace_logger import TraceLogger


class AgentLoop:
    """Runs one objective through the LLM<->tool loop to completion or a limit."""

    def __init__(
        self,
        llm_client: LLMClient,
        tools: Optional[ToolRegistry] = None,
        config: Optional[HarnessConfig] = None,
        approval_callback: ApprovalCallback = cli_prompt_approval,
        runs_dir: Optional[Path] = None,
        on_event: Optional[Callable[[AgentEvent], None]] = None,
    ) -> None:
        self.llm_client = llm_client
        self.tools: ToolRegistry = tools if tools is not None else build_default_registry()
        self.config = config or HarnessConfig()
        self.approval_callback = approval_callback
        self.runs_dir = runs_dir
        # Optional live-event observer (used by the async API run registry to
        # stream progress for GET /runs/{run_id}); unused by the CLI/sync API.
        self.on_event = on_event

    def run(self, objective: str, run_id: Optional[str] = None) -> RunResult:
        """Run one objective to completion or a limit.

        `run_id`, if given, is used instead of generating a fresh one — the
        async run registry pre-generates the id before starting the
        background thread so it can be used as the dict key immediately,
        before the loop itself has produced any events.
        """
        if not objective or not objective.strip():
            raise ValueError("objective must be a non-empty string")

        run_id = run_id or new_run_id()
        trace = TraceLogger(run_id=run_id, runs_dir=self.runs_dir, on_event=self.on_event)
        start = time.monotonic()
        step_index = 0
        status = "running"
        final_answer: Optional[str] = None

        while True:
            elapsed = time.monotonic() - start
            if elapsed >= self.config.max_wall_clock_seconds:
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
                break

            step_index += 1
            history_dicts = [e.model_dump(mode="json") for e in trace.history]

            decision = self._decide(run_id, step_index, objective, history_dicts, trace)
            if decision is None:
                status = "llm_error_exceeded"
                break

            if decision.action == "final_answer":
                final_answer = decision.final_answer
                trace.log(
                    AgentEvent(
                        run_id=run_id,
                        step=step_index,
                        event_type="final_answer",
                        data={"final_answer": final_answer, "rationale": decision.rationale},
                    )
                )
                status = "completed"
                break

            # action == "tool_call"
            tool = self.tools.get(decision.tool_name or "")
            if tool is None:
                trace.log(
                    AgentEvent(
                        run_id=run_id,
                        step=step_index,
                        event_type="tool_call_error",
                        data={
                            "tool_name": decision.tool_name,
                            "error": f"Unknown tool '{decision.tool_name}'; not in registry.",
                        },
                    )
                )
                continue

            try:
                validated_args = tool.input_model(**(decision.tool_args or {}))
            except ValidationError as exc:
                trace.log(
                    AgentEvent(
                        run_id=run_id,
                        step=step_index,
                        event_type="tool_validation_error",
                        data={
                            "tool_name": tool.name,
                            "args": decision.tool_args,
                            "error": str(exc),
                        },
                    )
                )
                continue

            if tool.requires_approval:
                approved = self._request_approval(run_id, step_index, tool, validated_args, trace)
                if not approved:
                    continue

            tool.bind_context(run_id=run_id)
            self._execute_with_retries(run_id, step_index, tool, validated_args, trace)

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

    def _decide(
        self,
        run_id: str,
        step: int,
        objective: str,
        history_dicts: list[dict[str, Any]],
        trace: TraceLogger,
    ) -> Optional[LLMDecision]:
        """Get a validated LLMDecision, retrying on malformed output.

        Returns None if retries are exhausted without a valid decision.
        """
        attempt = 0
        while True:
            t0 = time.monotonic()
            llm_meta: Optional[dict[str, Any]] = None
            try:
                raw = self.llm_client.raw_decide(objective, history_dicts)
                if isinstance(raw, dict):
                    llm_meta = raw.pop("_llm_meta", None)
                decision = LLMDecision.model_validate(raw)
            except Exception as exc:  # noqa: BLE001 - any LLM/parse failure is "malformed"
                attempt += 1
                latency_ms = (time.monotonic() - t0) * 1000
                trace.log(
                    AgentEvent(
                        run_id=run_id,
                        step=step,
                        event_type="llm_malformed_response",
                        latency_ms=latency_ms,
                        data={"attempt": attempt, "error": str(exc)},
                    )
                )
                if attempt > self.config.max_llm_retries:
                    trace.log(
                        AgentEvent(
                            run_id=run_id,
                            step=step,
                            event_type="llm_retry_exhausted",
                            data={"attempts": attempt},
                        )
                    )
                    return None
                continue

            latency_ms = (time.monotonic() - t0) * 1000
            event_data = decision.model_dump()
            if llm_meta:
                event_data["llm_meta"] = llm_meta
            trace.log(
                AgentEvent(
                    run_id=run_id,
                    step=step,
                    event_type="llm_decision",
                    latency_ms=latency_ms,
                    data=event_data,
                )
            )
            return decision

    def _request_approval(
        self,
        run_id: str,
        step: int,
        tool: Tool,
        validated_args: Any,
        trace: TraceLogger,
    ) -> bool:
        args_dict = validated_args.model_dump()
        trace.log(
            AgentEvent(
                run_id=run_id,
                step=step,
                event_type="approval_requested",
                data={"tool_name": tool.name, "args": args_dict},
            )
        )
        approved = bool(self.approval_callback(tool.name, args_dict))
        trace.log(
            AgentEvent(
                run_id=run_id,
                step=step,
                event_type="approval_granted" if approved else "approval_denied",
                data={"tool_name": tool.name, "args": args_dict},
            )
        )
        return approved

    def _execute_with_retries(
        self,
        run_id: str,
        step: int,
        tool: Tool,
        validated_args: Any,
        trace: TraceLogger,
    ) -> None:
        args_dict = validated_args.model_dump()
        attempt = 0
        max_attempts = self.config.max_tool_retries + 1

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
                    output = future.result(timeout=self.config.tool_timeout_seconds)
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
                            "timeout_seconds": self.config.tool_timeout_seconds,
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
                return

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
