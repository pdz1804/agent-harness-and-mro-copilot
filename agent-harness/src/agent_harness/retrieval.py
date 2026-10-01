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

import math
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
    path: Optional[Path]
    text: str = ""
    # "seed" = a file under the KB directory (read-only); "upload" = a row in
    # `kb_documents` added through the API/UI (deletable).
    source: str = "seed"
    created_by: Optional[str] = None
    created_at: Optional[str] = None


class PositiveIdfBM25(BM25Okapi):
    """`BM25Okapi` with the always-positive (Lucene-style) IDF.

    The classic Okapi IDF goes negative for a term that appears in more than
    half the documents, so on a tiny corpus (one or two stored memories) every
    score is <= 0 and nothing ever "matches". This variant keeps scores >= 0
    and exactly 0 for a document that shares no query term."""

    def _calc_idf(self, nd: dict[str, int]) -> None:
        for word, freq in nd.items():
            self.idf[word] = math.log(1 + (self.corpus_size - freq + 0.5) / (freq + 0.5))


class HybridIndex:
    """BM25 + dense (embedding) ranking over a list of `KBChunk`s, fused with
    Reciprocal Rank Fusion. Subclasses fill `self.chunks` and call
    `_build_bm25()`; the knowledge base indexes documents, long-term memory
    indexes one chunk per stored fact."""

    # Lexical scorer; subclasses indexing tiny corpora override it (see PositiveIdfBM25).
    _bm25_factory: type[BM25Okapi] = BM25Okapi

    def __init__(self) -> None:
        self.chunks: list[KBChunk] = []
        self._bm25: Optional[BM25Okapi] = None
        self._dense_matrix: Optional[np.ndarray] = None

    def _build_bm25(self) -> None:
        if self.chunks:
            self._bm25 = self._bm25_factory([_tokenize(c.text) for c in self.chunks])

    def _bm25_ranked(self, query_tokens: list[str]) -> list[tuple[KBChunk, float]]:
        if not self.chunks or self._bm25 is None:
            return []
        scores = self._bm25.get_scores(query_tokens)
        return sorted(zip(self.chunks, scores, strict=True), key=lambda pair: pair[1], reverse=True)

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
        return sorted(zip(self.chunks, sims.tolist(), strict=True), key=lambda pair: pair[1], reverse=True)

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

    def ranked_chunks(self, query: str, mode: Optional[str] = None) -> list[tuple[KBChunk, float]]:
        """Chunks best-first with their scores, using `mode` (bm25 | dense |
        hybrid; default `settings.RETRIEVAL_MODE`). BM25-only results drop
        zero-score chunks; hybrid degrades to BM25 when the embedding model is
        unavailable. Empty for an empty index or a query with no tokens."""
        if not self.chunks:
            return []
        query_tokens = _tokenize(query)
        if not query_tokens:
            return []
        effective_mode = (mode or settings.RETRIEVAL_MODE).lower()

        if effective_mode == "dense":
            return self._dense_ranked(query)

        bm25_ranked = self._bm25_ranked(query_tokens)
        bm25_positive = [(c, s) for c, s in bm25_ranked if s > 0]

        if effective_mode == "bm25":
            return bm25_positive

        if effective_mode != "hybrid":
            raise ValueError(f"unknown retrieval mode '{effective_mode}'")

        try:
            dense_ranked = self._dense_ranked(query)
        except dense_embeddings.EmbeddingModelUnavailable:
            return bm25_positive
        return self._rrf_fuse([c for c, _ in bm25_positive], [c for c, _ in dense_ranked])


class KnowledgeBaseIndex(HybridIndex):
    """One BM25 index over every chunk of every `*.md` file in `kb_dir`."""

    def __init__(self, kb_dir: Path) -> None:
        super().__init__()
        self.kb_dir = Path(kb_dir)
        self.docs: list[KBDoc] = []
        self._load()

    def _load(self) -> None:
        for path in sorted(self.kb_dir.glob("*.md")):
            text = path.read_text(encoding="utf-8")
            self._add_doc(
                KBDoc(doc_id=path.stem, title=_extract_title(text, path.stem), path=path, text=text)
            )
        for row in _load_uploaded_docs():
            self._add_doc(
                KBDoc(
                    doc_id=row["id"],
                    title=row["title"],
                    path=None,
                    text=row["content"],
                    source="upload",
                    created_by=row.get("created_by"),
                    created_at=row.get("created_at"),
                )
            )
        self._build_bm25()

    def _add_doc(self, doc: KBDoc) -> None:
        self.docs.append(doc)
        for i, chunk_text in enumerate(_chunk(doc.text)):
            self.chunks.append(KBChunk(doc_id=doc.doc_id, title=doc.title, chunk_index=i, text=chunk_text))

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
        return self._to_doc_results(self.ranked_chunks(query, mode), top_k)

    def list_docs(self) -> list[dict]:
        counts: dict[str, int] = {}
        for chunk in self.chunks:
            counts[chunk.doc_id] = counts.get(chunk.doc_id, 0) + 1
        return [
            {
                "id": d.doc_id,
                "title": d.title,
                "source": d.source,
                "chars": len(d.text),
                "chunk_count": counts.get(d.doc_id, 0),
            }
            for d in self.docs
        ]

    def get_doc(self, doc_id: str) -> Optional[KBDoc]:
        return next((d for d in self.docs if d.doc_id == doc_id), None)

    def chunks_of(self, doc_id: str) -> list[KBChunk]:
        return [c for c in self.chunks if c.doc_id == doc_id]

    def rank_chunks(self, query: str, mode: Optional[str] = None, top_k: int = 10) -> dict:
        """Chunk-level ranking with every score exposed - the retrieval
        playground's data. Each hit carries its BM25 score/rank, its dense
        (embedding cosine) score/rank when the embedding model is available,
        and the Reciprocal Rank Fusion score (the same fusion `search`
        uses). `would_return` marks the chunks `search` itself would hand
        the agent (best chunk per doc, top 3). `mode` is bm25|dense|hybrid;
        `effective_mode` reports what actually ran (hybrid degrades to
        bm25 if the embedding model is unavailable)."""
        requested = (mode or settings.RETRIEVAL_MODE).lower()
        if requested not in ("bm25", "dense", "hybrid"):
            raise ValueError(f"unknown retrieval mode '{requested}'")
        query_tokens = _tokenize(query)
        if not self.chunks or not query_tokens:
            return {"mode": requested, "effective_mode": requested, "dense_available": False, "hits": []}

        bm25_ranked = self._bm25_ranked(query_tokens)
        bm25_score = {(c.doc_id, c.chunk_index): float(s) for c, s in bm25_ranked}
        bm25_rank = {(c.doc_id, c.chunk_index): r for r, (c, _) in enumerate(bm25_ranked, start=1)}

        dense_score: dict[tuple[str, int], float] = {}
        dense_rank: dict[tuple[str, int], int] = {}
        dense_available = False
        if requested in ("dense", "hybrid"):
            try:
                dense_ranked = self._dense_ranked(query)
                dense_available = True
                dense_score = {(c.doc_id, c.chunk_index): float(s) for c, s in dense_ranked}
                dense_rank = {(c.doc_id, c.chunk_index): r for r, (c, _) in enumerate(dense_ranked, start=1)}
            except dense_embeddings.EmbeddingModelUnavailable:
                dense_available = False
        effective = requested if (requested == "bm25" or dense_available) else "bm25"

        bm25_positive = [c for c, s in bm25_ranked if s > 0]
        fused = {}
        if effective == "hybrid":
            fused = {
                (c.doc_id, c.chunk_index): score
                for c, score in self._rrf_fuse(bm25_positive, [c for c, _ in dense_ranked])
            }
        elif effective == "bm25":
            fused = {(c.doc_id, c.chunk_index): 1.0 / (_RRF_K + bm25_rank[(c.doc_id, c.chunk_index)]) for c in bm25_positive}
        else:
            fused = {(c.doc_id, c.chunk_index): 1.0 / (_RRF_K + r) for (c, _), r in zip(dense_ranked, range(1, len(dense_ranked) + 1), strict=True)}

        score_key = {"bm25": bm25_score, "dense": dense_score, "hybrid": fused}[effective]
        by_key = {(c.doc_id, c.chunk_index): c for c in self.chunks}
        ordered = sorted(
            (k for k in by_key if (effective != "bm25" or bm25_score.get(k, 0.0) > 0)),
            key=lambda k: score_key.get(k, float("-inf")),
            reverse=True,
        )
        returned_docs = {r["id"]: None for r in self.search(query, top_k=3, mode=effective)}
        hits = []
        seen_docs: set[str] = set()
        for key in ordered[:top_k]:
            chunk = by_key[key]
            would_return = chunk.doc_id in returned_docs and chunk.doc_id not in seen_docs
            if chunk.doc_id in returned_docs:
                seen_docs.add(chunk.doc_id)
            hits.append(
                {
                    "doc_id": chunk.doc_id,
                    "title": chunk.title,
                    "chunk_index": chunk.chunk_index,
                    "text": chunk.text,
                    "bm25_score": bm25_score.get(key),
                    "bm25_rank": bm25_rank.get(key),
                    "dense_score": dense_score.get(key),
                    "dense_rank": dense_rank.get(key),
                    "fused_score": fused.get(key),
                    "would_return": would_return,
                }
            )
        return {
            "mode": requested,
            "effective_mode": effective,
            "dense_available": dense_available,
            "hits": hits,
        }


def _load_uploaded_docs() -> list[dict]:
    """Rows of `kb_documents` (documents added through the API/UI). A DB
    failure degrades to "seed files only" rather than breaking retrieval."""
    try:
        from agent_harness import db

        with db.connect() as conn:
            return [dict(r) for r in conn.execute("SELECT * FROM kb_documents WHERE deleted_at IS NULL ORDER BY created_at, id").fetchall()]
    except Exception:  # noqa: BLE001 - retrieval must keep working without the DB table
        return []


def matched_terms(query: str, text: str) -> list[str]:
    """The query's tokens that actually occur in `text` (what the viewer
    highlights)."""
    haystack = set(_tokenize(text))
    return [t for t in dict.fromkeys(_tokenize(query)) if t in haystack]


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
