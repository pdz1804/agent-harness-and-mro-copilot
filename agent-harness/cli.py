#!/usr/bin/env python3
"""CLI entrypoint for the Agent Harness.

Usage:
    python cli.py "Check the status of auth-service"
    python cli.py --auto-approve "search-index is down, file an incident"
    python cli.py --mock "..."   # offline/CI convenience, no API key needed

By default this uses the real OpenAI backend (`OpenAIChatLLMClient`), which
requires `OPENAI_API_KEY` — copy `.env.example` to `.env` in the
agent-harness/ root and set your key. If the key is missing, the CLI exits
immediately with a clear error; it never silently falls back to the
deterministic mock. Pass `--mock` to explicitly opt into the
`HeuristicMockLLMClient` test double instead (useful for offline demos; the
pytest suite exercises it directly, not through this CLI flag).

The `create_incident` tool always pauses for an interactive y/N approval
prompt unless `--auto-approve` is passed (useful for scripted demos/CI).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from agent_harness import db
from agent_harness.approval import always_approve, cli_prompt_approval
from agent_harness.config import HarnessConfig
from agent_harness.llm_client import HeuristicMockLLMClient
from agent_harness.loop import AgentLoop
from agent_harness.settings import OPENAI_API_KEY


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run an objective through the Agent Harness.")
    parser.add_argument("objective", help="The task/objective for the agent to pursue.")
    parser.add_argument(
        "--auto-approve",
        action="store_true",
        help="Skip the interactive approval prompt and auto-approve create_incident calls.",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Use the deterministic HeuristicMockLLMClient instead of real OpenAI "
        "(offline/demo convenience; no API key needed).",
    )
    parser.add_argument("--max-steps", type=int, default=12)
    parser.add_argument("--max-wall-clock-seconds", type=float, default=60.0)
    parser.add_argument("--runs-dir", default="runs", help="Directory for the JSONL trace file.")
    args = parser.parse_args(argv)

    db.ensure_ready()

    if args.mock:
        llm_client = HeuristicMockLLMClient()
    else:
        if not OPENAI_API_KEY:
            print(
                "error: OPENAI_API_KEY is not set. Copy .env.example to .env in the "
                "agent-harness/ root and add your key, or pass --mock to use the "
                "deterministic offline demo backend instead.",
                file=sys.stderr,
            )
            return 2
        from agent_harness.llm_client import OpenAIChatLLMClient

        try:
            llm_client = OpenAIChatLLMClient()
        except RuntimeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    approval_callback = always_approve if args.auto_approve else cli_prompt_approval
    config = HarnessConfig(max_steps=args.max_steps, max_wall_clock_seconds=args.max_wall_clock_seconds)
    loop = AgentLoop(
        llm_client=llm_client,
        config=config,
        approval_callback=approval_callback,
        runs_dir=Path(args.runs_dir),
    )

    result = loop.run(args.objective)

    print(f"\n=== run {result.run_id} ===")
    print(f"status:       {result.status}")
    print(f"steps_taken:  {result.steps_taken}")
    print(f"elapsed_s:    {result.elapsed_seconds:.3f}")
    print(f"final_answer: {result.final_answer}")
    print(f"trace:        {result.trace_path}")
    print("\n--- step-by-step trace ---")
    for event in result.history:
        summary = json.dumps(event.data, default=str)
        print(f"[step {event.step}] {event.event_type}: {summary}")

    return 0 if result.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
