"""Opt-in live test: runs one real objective end-to-end against the real
OpenAI API. Skipped automatically whenever `OPENAI_API_KEY` is not set, and
excluded from the default `pytest` run via the `live` marker (see
`pyproject.toml`'s `addopts = "-m \"not live\""`). Run explicitly with:

    pytest -m live

Never prints the API key; only asserts on structural shape and logs
non-secret metadata (model name, token counts, final status) for
`docs/demo-evidence.md` capture.
"""

from __future__ import annotations

import pytest

from agent_harness.approval import always_approve
from agent_harness.llm_client import build_openai_model
from agent_harness.loop import AgentLoop
from agent_harness.settings import OPENAI_API_KEY

pytestmark = pytest.mark.live


@pytest.mark.skipif(not OPENAI_API_KEY, reason="OPENAI_API_KEY not set; live test skipped")
def test_live_openai_full_run_against_real_api(tools, runs_dir, fast_config):
    model = build_openai_model()
    loop = AgentLoop(
        model=model,
        tools=tools,
        config=fast_config,
        approval_callback=always_approve,
        runs_dir=runs_dir,
    )

    result = loop.run("What is the status of auth-service?")

    assert result.status == "completed"
    assert result.final_answer

    llm_decisions = [e for e in result.history if e.event_type == "llm_decision"]
    assert llm_decisions, "expected at least one real LLM decision event"
    meta = llm_decisions[0].data.get("llm_meta")
    assert meta is not None
    assert meta["model"]
    assert meta["total_tokens"] is None or meta["total_tokens"] > 0
