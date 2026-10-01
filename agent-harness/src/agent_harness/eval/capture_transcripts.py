"""Capture real recorded transcripts by running real objectives against the
real OpenAI API (requires `OPENAI_API_KEY`), one per required scenario:

1. `escalates-with-evidence` — a genuinely down service; expects the agent
   to investigate then successfully escalate via `create_incident`.
2. `declines-healthy-service` — a genuinely operational service; expects
   the agent to report status without escalating.
3. `recovers-from-unknown-service` — an objective referencing a service
   name that isn't in the registry, so `get_service_status` raises
   `ToolExecutionError` (real tool-failure path); expects the agent to
   recover and still produce a final answer without escalating.
4. `approval-gate-denied` — a genuinely down service with an
   escalation-worthy objective, but the approval callback always denies;
   expects the run to complete without `create_incident` ever executing.
5. `step-limit-exceeded` — the same escalation-worthy objective as (1), but
   `HarnessConfig.max_steps=1` so the real run cannot finish investigating
   before the harness's own step limit aborts it.

Run with (requires Postgres up via `docker compose up -d postgres` and a
real `OPENAI_API_KEY` in `.env`):

    python -m agent_harness.eval.capture_transcripts

Writes one `<scenario-id>.json` file per scenario to
`agent_harness/eval/transcripts/`, each holding the real `RunResult` (from
`agent_harness.schemas.RunResult.model_dump()`) plus the scenario's
`expected` outcome dict (see `scorers.classify_outcome`'s shape). Never
prints or logs the API key.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent_harness.approval import ApprovalCallback, always_approve, always_deny
from agent_harness.config import HarnessConfig
from agent_harness.llm_client import build_openai_model
from agent_harness.loop import AgentLoop
from agent_harness.tools.registry import build_default_registry

TRANSCRIPTS_DIR = Path(__file__).resolve().parent / "transcripts"


@dataclass
class Scenario:
    scenario_id: str
    objective: str
    expected: dict[str, Any]
    config: HarnessConfig
    approval_callback: ApprovalCallback


SCENARIOS: list[Scenario] = [
    Scenario(
        scenario_id="escalates-with-evidence",
        objective=(
            "search-index has been reporting errors. Check its status and "
            "create an incident if the evidence supports it."
        ),
        expected={"status": "completed", "escalated": True, "approval_denied": False},
        config=HarnessConfig(max_steps=8, max_wall_clock_seconds=60),
        approval_callback=always_approve,
    ),
    Scenario(
        scenario_id="declines-healthy-service",
        objective="Check the status of auth-service and let me know if anything needs escalation.",
        expected={"status": "completed", "escalated": False, "approval_denied": False},
        config=HarnessConfig(max_steps=8, max_wall_clock_seconds=60),
        approval_callback=always_approve,
    ),
    Scenario(
        scenario_id="recovers-from-unknown-service",
        objective="Check the status of the fraud-detector service and create an incident if it's down.",
        expected={"status": "completed", "escalated": False, "approval_denied": False},
        config=HarnessConfig(max_steps=8, max_wall_clock_seconds=60),
        approval_callback=always_approve,
    ),
    Scenario(
        scenario_id="approval-gate-denied",
        objective=(
            "search-index has been reporting errors. Check its status and "
            "create an incident if the evidence supports it."
        ),
        expected={"status": "completed", "escalated": False, "approval_denied": True},
        config=HarnessConfig(max_steps=8, max_wall_clock_seconds=60),
        approval_callback=always_deny,
    ),
    Scenario(
        scenario_id="step-limit-exceeded",
        objective=(
            "search-index has been reporting errors. Check its status and "
            "create an incident if the evidence supports it."
        ),
        expected={"status": "step_limit_exceeded", "escalated": False, "approval_denied": False},
        config=HarnessConfig(max_steps=1, max_wall_clock_seconds=60),
        approval_callback=always_approve,
    ),
]


def capture_all() -> list[Path]:
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for scenario in SCENARIOS:
        model = build_openai_model()
        tools = build_default_registry()
        loop = AgentLoop(
            model=model,
            tools=tools,
            config=scenario.config,
            approval_callback=scenario.approval_callback,
            runs_dir=Path("runs"),
        )
        result = loop.run(scenario.objective)
        payload = {
            "scenario_id": scenario.scenario_id,
            "expected": scenario.expected,
            "run_result": json.loads(result.model_dump_json()),
        }
        out_path = TRANSCRIPTS_DIR / f"{scenario.scenario_id}.json"
        out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        written.append(out_path)
        print(f"captured {scenario.scenario_id}: status={result.status} steps={result.steps_taken}")
    return written


if __name__ == "__main__":
    capture_all()
