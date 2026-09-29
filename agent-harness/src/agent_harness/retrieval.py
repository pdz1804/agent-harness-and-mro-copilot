"""Hybrid (BM25 + local dense embeddings) retrieval over the mock
knowledge-base corpus (`data/kb/*.md`).

Docs are chunked into paragraph-sized windows. Each query is ranked two
ways — `rank-bm25` (`BM25Okapi`, lexical) and a local sentence-transformers
model (`agent_harness.dense_embeddings`, semantic) — and the two rankings
are fused with Reciprocal Rank Fusion (RRF) so a paraphrased query that
shares no vocabulary with the target runbook (e.g. "users logged out" vs.
"session-store connection exhaustion") can still surface it. The index is a
per-process singleton, lazily built on first use and rebuilt automatically
if the configured KB directory changes (so tests can point at an isolated
fixture directory via `agent_harness.settings.KB_DIR` without leaking state
between them).

`search(..., mode=...)` accepts "bm25" (lexical only), "dense" (embeddings
only, used by the eval script) or "hybrid" (the default, from
`settings.RETRIEVAL_MODE`). If the local embedding model can't be loaded,
"hybrid" degrades to "bm25" rather than failing the request — see
`agent_harness.dense_embeddings.EmbeddingModelUnavailable`.

Only the input *documents* are mock content (fabricated ops runbooks for
demo purposes); the ranking itself is real BM25 + real embeddings over real
text, not a canned lookup table.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
from rank_bm25 import BM25Okapi

from agent_harness import dense_embeddings, settings

_RRF_K = 60

# How long a single `search()` call will wait for an in-flight embedding
# model warmup before degrading to BM25-only for that call. Keeps a request
# that lands mid-warmup well under the tool's own 10s timeout (see
# `agent_harness.config.HarnessConfig.tool_timeout_seconds`) instead of
# blocking on the full ~30s first load.
_WARMUP_GRACE_SECONDS = 3.0

_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9_\-]*")
_MAX_CHUNK_CHARS = 800


def _tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


def _extract_title(text: str, fallback: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()
    return fallback


def _chunk(text: str, max_chars: int = _MAX_CHUNK_CHARS) -> list[str]:
    """Merge paragraphs into chunks up to `max_chars`, never splitting a
    paragraph mid-sentence. Short docs collapse to a single chunk."""
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        return [text.strip()] if text.strip() else []
    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        candidate = f"{current}\n\n{para}" if current else para
        if len(candidate) > max_chars and current:
            chunks.append(current)
            current = para
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


@dataclass
class KBChunk:
    doc_id: str
    title: str
    chunk_index: int
    text: str


@dataclass
class KBDoc:
    doc_id: str
    title: str
    path: Path


class KnowledgeBaseIndex:
    """One BM25 index over every chunk of every `*.md` file in `kb_dir`."""

    def __init__(self, kb_dir: Path) -> None:
        self.kb_dir = Path(kb_dir)
        self.docs: list[KBDoc] = []
        self.chunks: list[KBChunk] = []
        self._bm25: Optional[BM25Okapi] = None
        self._dense_matrix: Optional[np.ndarray] = None
        self._load()

    def _load(self) -> None:
        for path in sorted(self.kb_dir.glob("*.md")):
            text = path.read_text(encoding="utf-8")
            title = _extract_title(text, path.stem)
            doc_id = path.stem
            self.docs.append(KBDoc(doc_id=doc_id, title=title, path=path))
            for i, chunk_text in enumerate(_chunk(text)):
                self.chunks.append(
                    KBChunk(doc_id=doc_id, title=title, chunk_index=i, text=chunk_text)
                )
        if self.chunks:
            self._bm25 = BM25Okapi([_tokenize(c.text) for c in self.chunks])

    def _bm25_ranked(self, query_tokens: list[str]) -> list[tuple[KBChunk, float]]:
        if not self.chunks or self._bm25 is None:
            return []
        scores = self._bm25.get_scores(query_tokens)
        return sorted(zip(self.chunks, scores), key=lambda pair: pair[1], reverse=True)

    def _dense_ranked(self, query: str) -> list[tuple[KBChunk, float]]:
        """Raises `dense_embeddings.EmbeddingModelUnavailable` if the local
        embedding model can't be loaded, or isn't ready within a short grace
        period — callers (`search()`) decide how to degrade (BM25-only).

        The model is warmed up in the background at process startup (see
        `api.py`'s startup event), so in the common case it's already
        `"ready"` by the time a request arrives. If a request lands
        mid-warmup anyway (e.g. the very first search right after boot), we
        wait up to `_WARMUP_GRACE_SECONDS` rather than either blocking on the
        full load (risking the tool's own timeout) or failing outright.
        """
        if not self.chunks:
            return []
        if dense_embeddings.get_status() == "loading":
            dense_embeddings.wait_until_ready(_WARMUP_GRACE_SECONDS)
        if dense_embeddings.get_status() == "loading":
            raise dense_embeddings.EmbeddingModelUnavailable(
                "embedding model still warming up; degraded to BM25-only for this call"
            )
        if self._dense_matrix is None:
            self._dense_matrix = dense_embeddings.embed_texts([c.text for c in self.chunks])
        query_vec = dense_embeddings.embed_query(query)
        sims = self._dense_matrix @ query_vec
        return sorted(zip(self.chunks, sims.tolist()), key=lambda pair: pair[1], reverse=True)

    @staticmethod
    def _rrf_fuse(*ranked_chunk_lists: list[KBChunk], k: int = _RRF_K) -> list[tuple[KBChunk, float]]:
        """Reciprocal Rank Fusion: combine several rankings (best-first lists
        of chunks, no scores needed) into one, scoring each chunk by
        sum(1 / (k + rank)) across every list it appears in."""
        scores: dict[tuple[str, int], float] = {}
        by_key: dict[tuple[str, int], KBChunk] = {}
        for ranked in ranked_chunk_lists:
            for rank, chunk in enumerate(ranked, start=1):
                key = (chunk.doc_id, chunk.chunk_index)
                scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
                by_key[key] = chunk
        ordered_keys = sorted(scores, key=lambda key: scores[key], reverse=True)
        return [(by_key[key], scores[key]) for key in ordered_keys]

    @staticmethod
    def _to_doc_results(ranked: list[tuple[KBChunk, float]], top_k: int) -> list[dict]:
        """One best-matching chunk per document (diverse doc-level hits, not
        several chunks of the same file), highest score first."""
        results: list[dict] = []
        seen_docs: set[str] = set()
        for chunk, score in ranked:
            if chunk.doc_id in seen_docs:
                continue
            seen_docs.add(chunk.doc_id)
            results.append(
                {
                    "id": chunk.doc_id,
                    "title": chunk.title,
                    "snippet": chunk.text[:280].strip(),
                    "score": float(score),
                }
            )
            if len(results) >= top_k:
                break
        return results

    def search(self, query: str, top_k: int = 3, mode: Optional[str] = None) -> list[dict]:
        """Rank chunks and return one best-matching chunk per document.

        `mode`: "bm25", "dense", or "hybrid" (default: `settings.RETRIEVAL_MODE`,
        itself "hybrid" unless overridden). BM25-only results drop zero-score
        chunks rather than padding in irrelevant ones; "hybrid" fuses BM25 +
        dense via Reciprocal Rank Fusion and falls back to BM25-only if the
        local embedding model is unavailable.
        """
        if not self.chunks:
            return []
        query_tokens = _tokenize(query)
        if not query_tokens:
            return []
        effective_mode = (mode or settings.RETRIEVAL_MODE).lower()

        if effective_mode == "dense":
            return self._to_doc_results(self._dense_ranked(query), top_k)

        bm25_ranked = self._bm25_ranked(query_tokens)
        bm25_positive = [(c, s) for c, s in bm25_ranked if s > 0]

        if effective_mode == "bm25":
            return self._to_doc_results(bm25_positive, top_k)

        if effective_mode != "hybrid":
            raise ValueError(f"unknown retrieval mode '{effective_mode}'")

        try:
            dense_ranked = self._dense_ranked(query)
        except dense_embeddings.EmbeddingModelUnavailable:
            return self._to_doc_results(bm25_positive, top_k)
        fused = self._rrf_fuse([c for c, _ in bm25_positive], [c for c, _ in dense_ranked])
        return self._to_doc_results(fused, top_k)

    def list_docs(self) -> list[dict]:
        return [{"id": d.doc_id, "title": d.title} for d in self.docs]


_index_lock = threading.Lock()
_index: Optional[KnowledgeBaseIndex] = None


def get_index(kb_dir: Optional[Path] = None) -> KnowledgeBaseIndex:
    """Return the process-wide index, (re)building it if this is the first
    call or the configured KB directory has changed."""
    global _index
    target_dir = Path(kb_dir) if kb_dir is not None else settings.KB_DIR
    with _index_lock:
        if _index is None or _index.kb_dir != target_dir:
            _index = KnowledgeBaseIndex(target_dir)
        return _index


def reset_index() -> None:
    """Force the next `get_index()` call to rebuild from disk. Used by
    tests after mutating the KB fixture directory in place."""
    global _index
    with _index_lock:
        _index = None
