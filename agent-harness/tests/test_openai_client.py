"""OpenAIChatLLMClient parsing tests using recorded/fake SDK response
objects — no network call is ever made. A fake `client` (matching the
`.chat.completions.create(...)` shape the real `openai.OpenAI` SDK exposes)
is injected via the `client=` constructor seam."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent_harness.llm_client import OpenAIChatLLMClient


def _fake_response(*, content=None, tool_calls=None, model="gpt-4o-mini", usage=(12, 8, 20)):
    prompt_tokens, completion_tokens, total_tokens = usage
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    return SimpleNamespace(
        choices=[SimpleNamespace(message=message)],
        model=model,
        usage=SimpleNamespace(
            prompt_tokens=prompt_tokens, completion_tokens=completion_tokens, total_tokens=total_tokens
        ),
    )


def _fake_tool_call(call_id: str, name: str, arguments: str):
    return SimpleNamespace(
        id=call_id, type="function", function=SimpleNamespace(name=name, arguments=arguments)
    )


class _RecordingFakeClient:
    """Records the last `messages`/`tools` it was called with, and returns
    a scripted response — the fake stands in for `openai.OpenAI(...)`."""

    def __init__(self, response):
        self._response = response
        self.last_kwargs: dict | None = None
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.last_kwargs = kwargs
        return self._response


def _build_client(response) -> tuple[OpenAIChatLLMClient, _RecordingFakeClient]:
    fake = _RecordingFakeClient(response)
    client = OpenAIChatLLMClient(model="gpt-4o-mini", client=fake)
    return client, fake


def test_parses_tool_call_response_into_tool_call_decision():
    response = _fake_response(
        tool_calls=[_fake_tool_call("call_1", "get_service_status", '{"service_name": "auth-service"}')]
    )
    client, fake = _build_client(response)

    decision = client.raw_decide("What is the status of auth-service?", [])

    assert decision["action"] == "tool_call"
    assert decision["tool_name"] == "get_service_status"
    assert decision["tool_args"] == {"service_name": "auth-service"}
    assert decision["_llm_meta"]["model"] == "gpt-4o-mini"
    assert decision["_llm_meta"]["prompt_tokens"] == 12
    assert decision["_llm_meta"]["completion_tokens"] == 8
    assert decision["_llm_meta"]["total_tokens"] == 20
    assert decision["_llm_meta"]["latency_ms"] >= 0

    # Native tool calling: tools=[...] with real JSON schemas were passed.
    assert fake.last_kwargs is not None
    assert fake.last_kwargs["tool_choice"] == "auto"
    tool_names = {t["function"]["name"] for t in fake.last_kwargs["tools"]}
    assert {"search_knowledge_base", "get_service_status", "create_incident"} <= tool_names


def test_parses_plain_text_response_into_final_answer_decision():
    response = _fake_response(content="auth-service is operational.", tool_calls=None)
    client, _ = _build_client(response)

    decision = client.raw_decide("What is the status of auth-service?", [])

    assert decision["action"] == "final_answer"
    assert decision["final_answer"] == "auth-service is operational."


def test_malformed_tool_call_arguments_raise_for_harness_retry_path():
    response = _fake_response(
        tool_calls=[_fake_tool_call("call_1", "get_service_status", "{not valid json")]
    )
    client, _ = _build_client(response)

    # raw_decide must raise (not swallow) so AgentLoop._decide's except
    # clause records `llm_malformed_response` and retries, per the harness's
    # existing safety contract.
    with pytest.raises(Exception):
        client.raw_decide("What is the status of auth-service?", [])


def test_build_messages_reconstructs_tool_call_and_result_as_native_messages():
    response = _fake_response(content="Done.")
    client, _ = _build_client(response)

    history = [
        {
            "step": 1,
            "event_type": "llm_decision",
            "data": {
                "action": "tool_call",
                "tool_name": "get_service_status",
                "tool_args": {"service_name": "auth-service"},
            },
        },
        {
            "step": 1,
            "event_type": "tool_call_result",
            "data": {
                "tool_name": "get_service_status",
                "output": {"service_name": "auth-service", "status": "operational"},
            },
        },
    ]
    messages = client._build_messages("What is the status of auth-service?", history)

    roles = [m["role"] for m in messages]
    assert roles == ["system", "user", "assistant", "tool"]
    assert messages[2]["tool_calls"][0]["function"]["name"] == "get_service_status"
    assert messages[3]["tool_call_id"] == messages[2]["tool_calls"][0]["id"]


def test_constructor_requires_api_key_without_injected_client(monkeypatch):
    from agent_harness import settings

    monkeypatch.setattr(settings, "OPENAI_API_KEY", None)
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        OpenAIChatLLMClient()
