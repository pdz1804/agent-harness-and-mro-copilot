"""Tests for `agent_harness.llm_client.build_openai_model`.

Phase 11b-v2 replaced the hand-rolled `OpenAIChatLLMClient` (which manually
accumulated raw OpenAI SDK streaming chunks into a decision dict) with
`pydantic_ai.models.openai.OpenAIChatModel` — response streaming, tool-call
argument parsing, and message-history reconstruction are now entirely
Pydantic AI's responsibility, verified by Pydantic AI's own test suite
against the real OpenAI wire format (see the phase-11b spike report's part
C for a real, live-captured demonstration of this exact parsing). This
file therefore only covers what `agent_harness` code still owns: the
`OPENAI_API_KEY` gating contract `build_openai_model` must preserve
unchanged from the old `OpenAIChatLLMClient` constructor, and that the
returned object really is wired up to talk to OpenAI's Chat Completions
API when a key is present. End-to-end tool-calling/streaming/malformed-
response behavior against this model is covered live by
`tests/test_live_openai.py` (opt-in, real API) and, for the harness's own
control-flow logic, deterministically by `build_scripted_model`/
`build_raising_then_scripted_model` in the rest of the suite.
"""

from __future__ import annotations

import pytest

from agent_harness.llm_client import build_openai_model, describe_provider_error


def test_constructor_requires_api_key(monkeypatch):
    from agent_harness import settings

    monkeypatch.setattr(settings, "OPENAI_API_KEY", None)
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        build_openai_model()


def test_build_openai_model_succeeds_with_explicit_api_key():
    from pydantic_ai.models.openai import OpenAIChatModel

    model = build_openai_model(api_key="sk-test-not-real", model="gpt-4o-mini")
    assert isinstance(model, OpenAIChatModel)
    assert model.model_name == "gpt-4o-mini"


def test_build_openai_model_defaults_to_configured_model_name(monkeypatch):
    from agent_harness import settings

    monkeypatch.setattr(settings, "OPENAI_MODEL", "gpt-4.1-mini")
    model = build_openai_model(api_key="sk-test-not-real")
    assert model.model_name == "gpt-4.1-mini"


def test_describe_provider_error_extracts_structured_openai_error():
    class _FakeExc(Exception):
        body = {"error": {"code": "insufficient_quota", "message": "add credits"}}

    message = describe_provider_error(_FakeExc("raw"))
    assert message == "OpenAI: insufficient_quota — add credits"


def test_describe_provider_error_maps_401_status():
    class _FakeExc(Exception):
        status_code = 401

    message = describe_provider_error(_FakeExc("raw"))
    assert "invalid_api_key" in message
