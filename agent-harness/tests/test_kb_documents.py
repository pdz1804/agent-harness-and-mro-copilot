"""Knowledge-base document viewer, adding/deleting/reindexing documents, and
the chunk-level retrieval playground (BM25 / vector / fused scores)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import retrieval  # noqa: E402
from agent_harness.tools.search_knowledge_base import SearchKnowledgeBaseInput, SearchKnowledgeBaseTool  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

ADMIN = {"X-User-Id": "u_admin"}
EDITOR = {"X-User-Id": "u_editor"}
EDITOR2 = {"X-User-Id": "u_editor2"}
VIEWER = {"X-User-Id": "u_viewer"}

DOC = (
    "# Runbook: Zeppelin gasket replacement\n\n"
    "If the zeppelin gasket pressure drops below the safe threshold, isolate the affected envelope "
    "and notify the airship duty engineer before attempting any replacement.\n\n"
    "Replacement procedure: drain the helium cell, swap the gasket, and run the pressure soak test "
    "for thirty minutes. Record the soak result in the maintenance log.\n"
)


def _add(headers=EDITOR, title: str | None = None, content: str = DOC) -> dict:
    body: dict = {"content": content}
    if title is not None:
        body["title"] = title
    response = client.post("/api/v1/kb", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


# --- viewer ------------------------------------------------------------------


def test_list_includes_metadata_for_every_doc() -> None:
    docs = client.get("/api/v1/kb", headers=VIEWER).json()
    assert docs and all(d["source"] == "seed" and d["chunk_count"] >= 1 and d["chars"] > 0 for d in docs)


def test_open_a_seed_document_with_content_chunks_and_metadata() -> None:
    doc_id = client.get("/api/v1/kb", headers=VIEWER).json()[0]["id"]
    detail = client.get(f"/api/v1/kb/{doc_id}", headers=VIEWER).json()
    assert detail["id"] == doc_id and detail["source"] == "seed"
    assert detail["filename"].endswith(".md")
    assert detail["content"].startswith("#")
    assert detail["chars"] == len(detail["content"]) and detail["words"] > 5
    assert detail["chunk_count"] == len(detail["chunks"]) >= 1
    # The chunks are exactly what the retriever indexes.
    indexed = retrieval.get_index().chunks_of(doc_id)
    assert [c["text"] for c in detail["chunks"]] == [c.text for c in indexed]
    assert detail["query"] is None and detail["matched_terms"] == []


def test_query_marks_matching_terms_and_scores_chunks() -> None:
    doc = _add()
    detail = client.get(f"/api/v1/kb/{doc['id']}", params={"q": "gasket pressure soak"}, headers=VIEWER).json()
    assert detail["query"] == "gasket pressure soak"
    assert set(detail["matched_terms"]) == {"gasket", "pressure", "soak"}
    scored = [c for c in detail["chunks"] if c["bm25_score"] is not None]
    assert scored and all(c["matched_terms"] for c in detail["chunks"])
    no_hit = client.get(f"/api/v1/kb/{doc['id']}", params={"q": "kubernetes"}, headers=VIEWER).json()
    assert no_hit["matched_terms"] == []


def test_unknown_document_is_a_404() -> None:
    assert client.get("/api/v1/kb/nope", headers=VIEWER).status_code == 404


# --- add / delete / reindex --------------------------------------------------


def test_added_document_is_chunked_indexed_and_found_by_the_agents_search_tool() -> None:
    doc = _add(title="Zeppelin gaskets")
    assert doc["source"] == "upload" and doc["title"] == "Zeppelin gaskets"
    assert doc["id"].startswith("upl-zeppelin-gaskets-") and doc["created_by"] == "u_editor"
    assert doc["chunk_count"] >= 1
    assert any(d["id"] == doc["id"] for d in client.get("/api/v1/kb", headers=VIEWER).json())

    hits = client.post("/api/v1/kb/search", json={"query": "zeppelin gasket helium soak"}, headers=VIEWER).json()
    assert hits[0]["id"] == doc["id"]
    # The very same index serves the agent tool.
    tool_hits = SearchKnowledgeBaseTool().run(SearchKnowledgeBaseInput(query="zeppelin gasket helium")).results
    assert tool_hits[0].id == doc["id"]


def test_title_defaults_to_the_first_heading_then_first_line() -> None:
    assert _add()["title"] == "Runbook: Zeppelin gasket replacement"
    assert _add(content="Plain first line of a note without heading.\n\nMore text here for length.")["title"].startswith(
        "Plain first line"
    )


def test_long_documents_are_split_into_multiple_chunks() -> None:
    paragraphs = "\n\n".join(f"Paragraph {i} about subject {i}. " + "filler words " * 40 for i in range(12))
    doc = _add(title="Long", content=paragraphs)
    assert doc["chunk_count"] > 1
    assert doc["chunks"][0]["char_start"] == 0


@pytest.mark.parametrize("content", ["", "short", " " * 50])
def test_too_short_content_is_rejected(content: str) -> None:
    assert client.post("/api/v1/kb", json={"content": content}, headers=EDITOR).status_code == 422


def test_oversized_content_is_rejected() -> None:
    assert client.post("/api/v1/kb", json={"content": "x" * 200_001}, headers=EDITOR).status_code == 422


def test_delete_rules_owner_admin_and_seed_protection() -> None:
    doc = _add(headers=EDITOR)
    assert client.delete(f"/api/v1/kb/{doc['id']}", headers=EDITOR2).status_code == 403
    assert client.delete(f"/api/v1/kb/{doc['id']}", headers=VIEWER).status_code == 403
    assert client.delete(f"/api/v1/kb/{doc['id']}", headers=EDITOR).status_code == 204
    assert client.get(f"/api/v1/kb/{doc['id']}", headers=EDITOR).status_code == 404
    assert client.post("/api/v1/kb/search", json={"query": "zeppelin gasket"}, headers=EDITOR).json() == []

    other = _add(headers=EDITOR2)
    assert client.delete(f"/api/v1/kb/{other['id']}", headers=ADMIN).status_code == 204

    seed_id = next(d["id"] for d in client.get("/api/v1/kb", headers=EDITOR).json() if d["source"] == "seed")
    assert client.delete(f"/api/v1/kb/{seed_id}", headers=ADMIN).status_code == 403
    assert client.delete("/api/v1/kb/nope", headers=ADMIN).status_code == 404


def test_viewer_cannot_add_or_reindex() -> None:
    assert client.post("/api/v1/kb", json={"content": DOC}, headers=VIEWER).status_code == 403
    assert client.post("/api/v1/kb/reindex", headers=VIEWER).status_code == 403


def test_reindex_rebuilds_from_disk_and_database() -> None:
    _add()
    result = client.post("/api/v1/kb/reindex", headers=EDITOR).json()
    docs = client.get("/api/v1/kb", headers=EDITOR).json()
    assert result["documents"] == len(docs) == 5  # 4 fixture runbooks + 1 upload
    assert result["chunks"] >= result["documents"]
    assert result["dense_ready"] is False  # the suite runs BM25-only
    assert result["took_ms"] >= 0


# --- retrieval playground ----------------------------------------------------


def test_retrieve_returns_per_chunk_scores_and_marks_what_the_agent_would_get() -> None:
    doc = _add()
    result = client.post(
        "/api/v1/kb/retrieve", json={"query": "zeppelin gasket pressure", "mode": "bm25", "top_k": 5}, headers=VIEWER
    ).json()
    assert result["mode"] == "bm25" and result["effective_mode"] == "bm25"
    hits = result["hits"]
    assert hits[0]["doc_id"] == doc["id"]
    assert hits[0]["bm25_score"] > 0 and hits[0]["bm25_rank"] == 1
    assert hits[0]["fused_score"] > 0
    assert hits[0]["dense_score"] is None
    scores = [h["bm25_score"] for h in hits]
    assert scores == sorted(scores, reverse=True)
    assert hits[0]["would_return"] is True
    # The agent's tool returns the same top document.
    tool_ids = [r["id"] for r in client.post("/api/v1/kb/search", json={"query": "zeppelin gasket pressure"}, headers=VIEWER).json()]
    assert tool_ids[0] == hits[0]["doc_id"]


def test_retrieve_hybrid_degrades_to_bm25_when_embeddings_are_unavailable(monkeypatch) -> None:
    from agent_harness import dense_embeddings

    monkeypatch.setattr(
        retrieval.KnowledgeBaseIndex,
        "_dense_ranked",
        lambda self, query: (_ for _ in ()).throw(dense_embeddings.EmbeddingModelUnavailable("no model")),
    )
    result = client.post("/api/v1/kb/retrieve", json={"query": "auth-service outage", "mode": "hybrid"}, headers=VIEWER).json()
    assert result["mode"] == "hybrid" and result["effective_mode"] == "bm25" and result["dense_available"] is False
    assert result["hits"]


def test_retrieve_exposes_dense_and_fused_scores_when_embeddings_work(monkeypatch) -> None:
    import numpy as np

    index = retrieval.get_index()

    def fake_dense(self, query):
        chunks = list(self.chunks)
        sims = [1.0 / (i + 1) for i in range(len(chunks))]
        return sorted(zip(chunks, sims, strict=True), key=lambda p: p[1], reverse=True)

    monkeypatch.setattr(retrieval.KnowledgeBaseIndex, "_dense_ranked", fake_dense)
    assert np is not None and index.chunks
    result = client.post("/api/v1/kb/retrieve", json={"query": "auth-service outage", "mode": "hybrid", "top_k": 3}, headers=VIEWER).json()
    assert result["effective_mode"] == "hybrid" and result["dense_available"] is True
    top = result["hits"][0]
    assert top["dense_score"] is not None and top["dense_rank"] is not None and top["fused_score"] > 0


def test_retrieve_validates_input() -> None:
    assert client.post("/api/v1/kb/retrieve", json={"query": "", "mode": "bm25"}, headers=VIEWER).status_code == 422
    assert client.post("/api/v1/kb/retrieve", json={"query": "x", "mode": "magic"}, headers=VIEWER).status_code == 422
    empty = client.post("/api/v1/kb/retrieve", json={"query": "?!", "mode": "bm25"}, headers=VIEWER).json()
    assert empty["hits"] == []
