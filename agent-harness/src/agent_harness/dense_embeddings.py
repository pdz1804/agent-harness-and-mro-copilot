"""Local dense embeddings for hybrid KB retrieval (BM25 + dense fused via
Reciprocal Rank Fusion in `agent_harness.retrieval`).

Uses a local `sentence-transformers` model (default `BAAI/bge-small-en-v1.5`,
CPU-only) so paraphrased queries retrieve semantically — no OpenAI embeddings
API call, no external cost (the OpenAI account for this project has no
credits; see docs/design-report.md). The model is lazy-loaded: importing
this module never touches disk/network, only the first `embed_texts`/
`embed_query` call does. Embeddings are cached to disk keyed by a SHA-256
hash of the chunk text, so unchanged KB content is never re-embedded across
process restarts.

If `sentence-transformers` (or the model download) is unavailable,
`EmbeddingModelUnavailable` is raised and `retrieval.KnowledgeBaseIndex`
degrades hybrid search to BM25-only rather than failing the request — see
that module's `search()`.
"""

from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from typing import Any, Literal

import numpy as np

from agent_harness import settings

_model_lock = threading.Lock()
_model: Any = None

# Warmup/health state, tracked separately from `_model_lock` so `get_status()`
# (polled by `GET /health` and by callers deciding whether to wait) never
# blocks behind a slow `SentenceTransformer(...)` load. `_ready_event` fires
# once loading finishes either way (ready or unavailable), so a caller can
# wait with a bounded timeout instead of polling.
_status: Literal["idle", "loading", "ready", "unavailable"] = "idle"
_status_lock = threading.Lock()
_load_error: str | None = None
_ready_event = threading.Event()


class EmbeddingModelUnavailable(RuntimeError):
    """Raised when the local embedding model/dependency cannot be loaded
    (not installed, no network on first download, corrupt cache, ...)."""


def _set_status(new_status: Literal["idle", "loading", "ready", "unavailable"]) -> None:
    global _status
    with _status_lock:
        _status = new_status


def get_status() -> Literal["idle", "loading", "ready", "unavailable"]:
    """Current warmup state, for `GET /health` and for callers deciding
    whether to wait for the model before falling back to BM25-only."""
    with _status_lock:
        return _status


def last_load_error() -> str | None:
    return _load_error


def _get_model() -> Any:
    global _model, _load_error
    with _model_lock:
        if _model is not None:
            return _model
        _set_status("loading")
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:
            _load_error = (
                "sentence-transformers is not installed; set "
                "AGENT_HARNESS_RETRIEVAL_MODE=bm25 to run without it."
            )
            _set_status("unavailable")
            _ready_event.set()
            raise EmbeddingModelUnavailable(_load_error) from exc
        try:
            _model = SentenceTransformer(settings.EMBEDDING_MODEL_NAME)
        except Exception as exc:  # noqa: BLE001 - offline first-download, corrupt cache, etc.
            _load_error = f"could not load embedding model '{settings.EMBEDDING_MODEL_NAME}': {exc}"
            _set_status("unavailable")
            _ready_event.set()
            raise EmbeddingModelUnavailable(_load_error) from exc
        _set_status("ready")
        _ready_event.set()
        return _model


def start_warmup() -> None:
    """Kick off model loading on a background daemon thread if it hasn't
    started already (idempotent — safe to call more than once). Intended to
    be called once from the FastAPI startup event so the ~30s first-load
    cost of `SentenceTransformer(...)` happens before the first real request
    instead of blocking (and potentially timing out) it."""
    with _status_lock:
        global _status
        if _status != "idle":
            return
        _status = "loading"

    def _run() -> None:
        try:
            _get_model()
        except EmbeddingModelUnavailable:
            pass  # state already recorded by _get_model; nothing more to do

    threading.Thread(target=_run, name="embedding-warmup", daemon=True).start()


def wait_until_ready(timeout: float) -> bool:
    """Block up to `timeout` seconds for warmup to finish. Returns True once
    the model is ready (or definitively unavailable), False if it's still
    loading when the timeout elapses. Used by `agent_harness.retrieval` to
    give an in-flight warmup a short grace period before degrading a single
    `search_knowledge_base` call to BM25-only rather than risking the tool's
    own (longer) timeout."""
    return _ready_event.wait(timeout=timeout)


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _cache_path() -> Path:
    model_slug = settings.EMBEDDING_MODEL_NAME.replace("/", "__")
    return settings.EMBEDDING_CACHE_DIR / f"{model_slug}.json"


def _load_cache() -> dict[str, list[float]]:
    path = _cache_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_cache(cache: dict[str, list[float]]) -> None:
    path = _cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache), encoding="utf-8")


def embed_texts(texts: list[str]) -> np.ndarray:
    """Embed `texts`, unit-normalized so a dot product is cosine similarity.

    Reuses cached vectors for content already embedded (keyed by content
    hash, independent of position/doc) and only calls the model for genuinely
    new text, persisting any newly-computed vectors back to the cache.
    """
    if not texts:
        return np.zeros((0, 0), dtype=np.float32)
    cache = _load_cache()
    hashes = [_content_hash(t) for t in texts]
    missing = [(i, t) for i, (t, h) in enumerate(zip(texts, hashes, strict=True)) if h not in cache]
    if missing:
        model = _get_model()
        vectors = model.encode(
            [t for _, t in missing], normalize_embeddings=True, show_progress_bar=False
        )
        for (i, _), vec in zip(missing, vectors, strict=True):
            cache[hashes[i]] = np.asarray(vec, dtype=np.float32).tolist()
        _save_cache(cache)
    return np.array([cache[h] for h in hashes], dtype=np.float32)


def embed_query(query: str) -> np.ndarray:
    """Embed a single query string (never cached — queries are one-off)."""
    model = _get_model()
    vec = model.encode([query], normalize_embeddings=True, show_progress_bar=False)[0]
    return np.asarray(vec, dtype=np.float32)
