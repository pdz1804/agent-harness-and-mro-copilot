"""Long-term memory: the `remember` / `recall` agent tools (real persistence and
hybrid retrieval), owner scoping, the Memory page's REST routes, and which
memories a run used. Network-free (scripted models)."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import state  # noqa: E402
from agent_harness.exceptions import ToolExecutionError  # noqa: E402
from agent_harness.llm_client import build_scripted_model  # noqa: E402
from agent_harness.repos import memories as memories_repo  # noqa: E402
from agent_harness.tools.memory_tools import RecallInput, RecallTool, RememberInput, RememberTool  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

ADMIN = {"X-User-Id": "u_admin"}
EDITOR = {"X-User-Id": "u_editor"}
EDITOR2 = {"X-User-Id": "u_editor2"}
VIEWER = {"X-User-Id": "u_viewer"}

FACT = "The on-call engineer for payments-api is Sam Rivera."


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


def _wait(run_id: str, headers: dict, timeout: float = 8.0) -> dict:
    deadline = time.monotonic() + timeout
    body: dict = {}
    while time.monotonic() < deadline:
        body = client.get(f"/api/v1/runs/{run_id}", headers=headers).json()
        if body["status"] == "completed":
            return body
        time.sleep(0.02)
    raise AssertionError(f"run never completed: {body}")


def _run_script(monkeypatch, script: list[dict], headers: dict, objective: str = "do it", **extra) -> dict:
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_scripted_model(script))
    started = client.post("/api/v1/runs", json={"objective": objective, **extra}, headers=headers)
    assert started.status_code == 202, started.text
    return _wait(started.json()["run_id"], headers)


def _remember(owner: str, fact: str = FACT, tags: list[str] | None = None) -> dict:
    tool = RememberTool()
    tool.bind_context(owner_id=owner, owner_role="editor")
    out = tool.run(RememberInput(fact=fact, tags=tags or ["payments-api", "oncall"]))
    return out.model_dump()


def _recall(owner: str, query: str) -> dict:
    tool = RecallTool()
    tool.bind_context(owner_id=owner, owner_role="editor")
    return tool.run(RecallInput(query=query)).model_dump()


# --- tools ---------------------------------------------------------------------


def test_remember_persists_and_recall_finds_it_by_text_and_by_tag() -> None:
    saved = _remember("u_editor")
    assert saved["status"] == "saved" and saved["tags"] == ["payments-api", "oncall"]
    by_text = _recall("u_editor", "who is on call for payments")
    assert by_text["matched"] and by_text["memories"][0]["fact"] == FACT
    by_tag = _recall("u_editor", "oncall")
    assert by_tag["matched"] and by_tag["memories"][0]["id"] == saved["memory_id"]


def test_remember_is_idempotent_and_merges_tags() -> None:
    first = _remember("u_editor", tags=["a"])
    again = _remember("u_editor", fact=FACT.upper(), tags=["b"])
    assert first["status"] == "saved" and again["status"] == "already_known"
    assert again["memory_id"] == first["memory_id"]
    assert set(again["tags"]) == {"a", "b"}
    assert len(memories_repo.list_memories(owner_id="u_editor")) == 1


def test_recall_with_no_match_returns_recent_memories_flagged_unmatched() -> None:
    _remember("u_editor")
    out = _recall("u_editor", "zeppelin gasket")
    assert out["matched"] is False
    assert [m["fact"] for m in out["memories"]] == [FACT]


def test_recall_bumps_use_count_and_last_used() -> None:
    saved = _remember("u_editor")
    _recall("u_editor", "payments-api on call")
    row = memories_repo.get_memory(saved["memory_id"])
    assert row is not None and row["use_count"] == 1 and row["last_used_at"]


def test_memories_are_strictly_owner_scoped_for_the_tools() -> None:
    _remember("u_editor")
    other = _recall("u_editor2", "payments-api on call")
    assert other["matched"] is False and other["memories"] == []
    # An admin's agent does not read other users' memories either.
    tool = RecallTool()
    tool.bind_context(owner_id="u_admin", owner_role="admin")
    assert tool.run(RecallInput(query="payments-api on call")).memories == []


def test_tools_refuse_to_run_without_an_owner() -> None:
    with pytest.raises(ToolExecutionError):
        RememberTool().run(RememberInput(fact="no owner bound here"))
    with pytest.raises(ToolExecutionError):
        RecallTool().run(RecallInput(query="anything"))


def test_memory_cap_is_enforced(monkeypatch) -> None:
    monkeypatch.setattr(memories_repo, "MAX_MEMORIES_PER_OWNER", 2)
    _remember("u_editor", fact="first fact about services")
    _remember("u_editor", fact="second fact about services")
    with pytest.raises(ToolExecutionError, match="memory is full"):
        _remember("u_editor", fact="third fact about services")


# --- runs: ambient availability, persistence across sessions, used-by-run ------------


def _tool_names_model(sink: list[list[str]]) -> FunctionModel:
    def _fn(messages: list[Any], info: Any) -> ModelResponse:
        sink.append(sorted(t.name for t in info.function_tools))
        return ModelResponse(parts=[TextPart(content="ok")])

    return FunctionModel(_fn, model_name="tool-names")


def _agent_id(slug: str) -> str:
    return next(a["id"] for a in client.get("/api/v1/agents", headers=ADMIN).json() if a["slug"] == slug)


def test_memory_tools_are_offered_to_a_normal_run_and_not_to_an_assigned_agent(monkeypatch) -> None:
    seen: list[list[str]] = []
    monkeypatch.setattr(state, "llm_client_factory", lambda: _tool_names_model(seen))
    started = client.post("/api/v1/runs", json={"objective": "hello", "agent_id": _agent_id("ops-assistant")}, headers=EDITOR)
    _wait(started.json()["run_id"], EDITOR)
    assert {"remember", "recall"} <= set(seen[-1])

    seen.clear()
    started = client.post("/api/v1/runs", json={"objective": "hello", "agent_id": _agent_id("kb-concierge")}, headers=EDITOR)
    _wait(started.json()["run_id"], EDITOR)
    assert seen and not ({"remember", "recall"} & set(seen[-1]))


def test_disabling_the_integration_removes_the_tool_from_new_runs(monkeypatch) -> None:
    assert client.patch("/api/v1/integrations/remember", json={"enabled": False}, headers=ADMIN).status_code == 200
    seen: list[list[str]] = []
    monkeypatch.setattr(state, "llm_client_factory", lambda: _tool_names_model(seen))
    started = client.post("/api/v1/runs", json={"objective": "hello", "agent_id": _agent_id("ops-assistant")}, headers=EDITOR)
    _wait(started.json()["run_id"], EDITOR)
    assert "remember" not in seen[-1] and "recall" in seen[-1]


def test_a_fact_saved_in_one_session_is_recalled_in_another_and_the_run_lists_it(monkeypatch) -> None:
    save = [
        {"action": "tool_call", "tool_name": "remember", "tool_args": {"fact": FACT, "tags": ["payments-api"]}},
        {"action": "final_answer", "final_answer": "Saved."},
    ]
    first = _run_script(monkeypatch, save, EDITOR, objective="Remember that Sam Rivera is on call for payments-api")
    saved_view = client.get(f"/api/v1/runs/{first['run_id']}/memories", headers=EDITOR).json()
    assert [m["fact"] for m in saved_view["saved"]] == [FACT] and saved_view["used"] == []

    ask = [
        {"action": "tool_call", "tool_name": "recall", "tool_args": {"query": "who is on call for payments-api"}},
        {"action": "final_answer", "final_answer": "Sam Rivera."},
    ]
    second = _run_script(monkeypatch, ask, EDITOR, objective="who is on call for payments-api?")
    assert second["session_id"] != first["session_id"]
    used = client.get(f"/api/v1/runs/{second['run_id']}/memories", headers=EDITOR).json()["used"]
    assert [m["fact"] for m in used] == [FACT] and used[0]["exists"] is True

    memory_id = used[0]["id"]
    listed = client.get("/api/v1/memories", headers=EDITOR).json()
    assert listed[0]["id"] == memory_id and listed[0]["use_count"] == 1
    assert listed[0]["source_run_id"] == first["run_id"]

    # The memory page can delete it; the run then reports it as gone.
    assert client.delete(f"/api/v1/memories/{memory_id}", headers=EDITOR).status_code == 204
    after = client.get(f"/api/v1/runs/{second['run_id']}/memories", headers=EDITOR).json()["used"]
    assert after[0]["exists"] is False


def test_another_users_run_cannot_read_run_memories(monkeypatch) -> None:
    run = _run_script(monkeypatch, [{"action": "final_answer", "final_answer": "hi"}], EDITOR)
    assert client.get(f"/api/v1/runs/{run['run_id']}/memories", headers=EDITOR2).status_code == 404


# --- REST: the Memory page ----------------------------------------------------------


def test_list_add_edit_delete_roundtrip_and_search() -> None:
    created = client.post("/api/v1/memories", json={"fact": "Prefers concise answers", "tags": ["Style", "style"]}, headers=VIEWER)
    assert created.status_code == 201
    body = created.json()
    assert body["owner_id"] == "u_viewer" and body["tags"] == ["style"] and body["source_run_id"] is None

    edited = client.patch(f"/api/v1/memories/{body['id']}", json={"fact": "Prefers very concise answers", "tags": ["tone"]}, headers=VIEWER)
    assert edited.status_code == 200 and edited.json()["fact"] == "Prefers very concise answers"
    assert edited.json()["tags"] == ["tone"]

    assert [m["id"] for m in client.get("/api/v1/memories?q=concise", headers=VIEWER).json()] == [body["id"]]
    assert client.get("/api/v1/memories?q=tone", headers=VIEWER).json()[0]["id"] == body["id"]
    assert client.get("/api/v1/memories?q=zzz", headers=VIEWER).json() == []

    assert client.delete(f"/api/v1/memories/{body['id']}", headers=VIEWER).status_code == 204
    assert client.get("/api/v1/memories", headers=VIEWER).json() == []


def test_rest_validation() -> None:
    assert client.post("/api/v1/memories", json={"fact": "x"}, headers=EDITOR).status_code == 422
    assert client.post("/api/v1/memories", json={"fact": "   "}, headers=EDITOR).status_code == 422
    assert client.post("/api/v1/memories", json={"fact": "valid fact", "tags": ["t"] * 9}, headers=EDITOR).status_code == 422
    mid = client.post("/api/v1/memories", json={"fact": "valid fact"}, headers=EDITOR).json()["id"]
    assert client.patch(f"/api/v1/memories/{mid}", json={}, headers=EDITOR).status_code == 422


def test_memories_are_private_to_the_owner_with_admin_oversight() -> None:
    mid = client.post("/api/v1/memories", json={"fact": "Evan's private note"}, headers=EDITOR).json()["id"]
    assert client.get("/api/v1/memories", headers=EDITOR2).json() == []
    assert client.patch(f"/api/v1/memories/{mid}", json={"fact": "hijacked fact"}, headers=EDITOR2).status_code == 404
    assert client.delete(f"/api/v1/memories/{mid}", headers=EDITOR2).status_code == 404
    # `scope=all` is admin only; the admin sees the owner's name and can edit/delete.
    assert client.get("/api/v1/memories?scope=all", headers=EDITOR2).status_code == 403
    everyone = client.get("/api/v1/memories?scope=all", headers=ADMIN).json()
    assert [m["owner_name"] for m in everyone] == ["Evan Editor"]
    assert client.get("/api/v1/memories", headers=ADMIN).json() == []  # default scope is the admin's own
    assert client.delete(f"/api/v1/memories/{mid}", headers=ADMIN).status_code == 204


def test_hybrid_ranking_is_reused_for_memory(monkeypatch) -> None:
    """With the embedding model unavailable, hybrid mode degrades to BM25 for
    memory exactly like it does for the knowledge base."""
    from agent_harness import dense_embeddings, settings

    monkeypatch.setattr(settings, "RETRIEVAL_MODE", "hybrid")

    def _unavailable(*_a: Any, **_k: Any) -> None:
        raise dense_embeddings.EmbeddingModelUnavailable("test: no model")

    monkeypatch.setattr(dense_embeddings, "get_status", lambda: "unavailable")
    monkeypatch.setattr(dense_embeddings, "embed_texts", _unavailable)
    _remember("u_editor")
    out = _recall("u_editor", "payments-api on call")
    assert out["matched"] and out["memories"][0]["fact"] == FACT
