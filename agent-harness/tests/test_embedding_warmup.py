"""Embedding model warmup: background startup loading (not lazy on first
`search_knowledge_base` call) and graceful BM25-only degradation for a
request that lands while warmup is still in flight.

Covers the fix for the cold-start problem where the local
`sentence-transformers` model's first load (~30s) exceeded the tool's 10s
timeout on the very first KB search of a fresh process. See
`agent_harness.dense_embeddings.start_warmup`/`get_status`/`wait_until_ready`
and `api.py`'s startup event."""

from __future__ import annotations

import threading
import time

import pytest

from agent_harness import dense_embeddings, retrieval


@pytest.fixture(autouse=True)
def _reset_warmup_state(monkeypatch: pytest.MonkeyPatch):
    """Each test gets a fresh module-level warmup state, since it's a
    process-wide singleton in the real app (one model per process)."""
    monkeypatch.setattr(dense_embeddings, "_model", None)
    monkeypatch.setattr(dense_embeddings, "_status", "idle")
    monkeypatch.setattr(dense_embeddings, "_load_error", None)
    ready_event = threading.Event()
    monkeypatch.setattr(dense_embeddings, "_ready_event", ready_event)
    yield


def test_start_warmup_transitions_idle_to_loading_to_ready(monkeypatch: pytest.MonkeyPatch):
    """`start_warmup()` runs the load on a background thread; status is
    'loading' immediately, then 'ready' once the (here, fake/fast) model
    finishes loading — proving the caller never blocks on it."""
    release = threading.Event()

    def fake_get_model():
        release.wait(timeout=5)
        dense_embeddings._model = object()
        dense_embeddings._set_status("ready")
        dense_embeddings._ready_event.set()
        return dense_embeddings._model

    monkeypatch.setattr(dense_embeddings, "_get_model", fake_get_model)

    dense_embeddings.start_warmup()
    assert dense_embeddings.get_status() == "loading"

    release.set()
    assert dense_embeddings.wait_until_ready(timeout=5) is True
    assert dense_embeddings.get_status() == "ready"


def test_start_warmup_is_idempotent(monkeypatch: pytest.MonkeyPatch):
    """Calling start_warmup() twice must not spawn a second load thread."""
    calls = []

    def fake_get_model():
        calls.append(1)
        dense_embeddings._set_status("ready")
        dense_embeddings._ready_event.set()
        return object()

    monkeypatch.setattr(dense_embeddings, "_get_model", fake_get_model)

    dense_embeddings.start_warmup()
    dense_embeddings.start_warmup()
    assert dense_embeddings.wait_until_ready(timeout=5) is True
    assert len(calls) == 1


def test_wait_until_ready_times_out_while_still_loading(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(dense_embeddings, "_status", "loading")
    assert dense_embeddings.wait_until_ready(timeout=0.05) is False


def test_hybrid_search_degrades_to_bm25_when_warmup_not_ready(monkeypatch: pytest.MonkeyPatch):
    """A `search_knowledge_base` call landing while the embedding model is
    still warming up must NOT block for the full load time or raise — it
    should wait the short grace period, then fall back to BM25-only
    results, same shape as a normal hybrid response."""
    monkeypatch.setattr(retrieval, "_WARMUP_GRACE_SECONDS", 0.05)
    monkeypatch.setattr(dense_embeddings, "_status", "loading")

    index = retrieval.get_index()
    started = time.monotonic()
    results = index.search("auth-service outage session store", top_k=3, mode="hybrid")
    elapsed = time.monotonic() - started

    assert elapsed < 1.0, "must not block anywhere near the ~30s full model load"
    assert results, "expected BM25-only fallback results, not an empty/failed response"
    doc_ids = [r["id"] for r in results]
    assert "kb-002-auth-service-outage-checklist" in doc_ids


def test_hybrid_search_uses_dense_once_ready(monkeypatch: pytest.MonkeyPatch):
    """Once warmup has completed, hybrid search fuses dense results too
    (verified indirectly: it must not raise EmbeddingModelUnavailable, and
    must call the embedding helpers instead of skipping them)."""
    dense_embeddings._set_status("ready")
    dense_embeddings._ready_event.set()

    calls = {"embed_texts": 0, "embed_query": 0}

    def fake_embed_texts(texts):
        calls["embed_texts"] += 1
        import numpy as np

        return np.ones((len(texts), 4), dtype="float32")

    def fake_embed_query(query):
        calls["embed_query"] += 1
        import numpy as np

        return np.ones(4, dtype="float32")

    monkeypatch.setattr(dense_embeddings, "embed_texts", fake_embed_texts)
    monkeypatch.setattr(dense_embeddings, "embed_query", fake_embed_query)

    index = retrieval.get_index()
    index._dense_matrix = None  # force recompute against the fakes above
    results = index.search("auth-service outage session store", top_k=3, mode="hybrid")

    assert results
    assert calls["embed_texts"] == 1
    assert calls["embed_query"] == 1
