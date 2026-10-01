"""Hybrid (BM25 + TF-IDF, fused by Reciprocal Rank Fusion) retrieval over the
fictional maintenance knowledge base in `kb/`.

Pattern reference (no import, adapted independently for this app's venv):
`agent-harness/src/agent_harness/retrieval.py`. Dense embeddings are intentionally
NOT used here to avoid pulling `sentence-transformers`/torch into the MRO venv
(decision D6, `reports/research-and-gap-analysis.md`).

Usage as a library::

    from src.copilot.retrieval import KBIndex
    index = KBIndex.build(Path("kb"))
    hits = index.search("hydraulic pump low pressure", k=5)

Usage as a CLI eval::

    python -m src.copilot.retrieval --eval
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import yaml
from rank_bm25 import BM25Okapi
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_FRONT_MATTER_RE = re.compile(r"^---\s*\n(.*?\n)---\s*\n(.*)$", re.DOTALL)
_HEADING_RE = re.compile(r"^##\s+(.*)$")

_RRF_K = 60
DEFAULT_KB_DIR = Path(__file__).resolve().parents[2] / "kb"


def _tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


@dataclass(frozen=True)
class Hit:
    doc_id: str
    chunk_id: str
    title: str
    score: float
    text: str
    doc_type: str


@dataclass
class _Doc:
    doc_id: str
    doc_type: str
    ata_chapter: str
    component_types: list[str]
    fault_codes: list[str]
    title: str
    test_fixture: bool
    body: str
    path: Path


@dataclass
class _Chunk:
    doc_id: str
    chunk_id: str
    heading: str
    text: str
    tokens: list[str] = field(default_factory=list)


def _parse_file(path: Path) -> _Doc:
    raw = path.read_text(encoding="utf-8")
    match = _FRONT_MATTER_RE.match(raw)
    if not match:
        raise ValueError(f"KB doc missing YAML front matter: {path}")
    meta = yaml.safe_load(match.group(1)) or {}
    body = match.group(2)
    required = ["id", "doc_type", "title"]
    missing = [f for f in required if f not in meta]
    if missing:
        raise ValueError(f"KB doc {path} missing front-matter fields: {missing}")
    return _Doc(
        doc_id=str(meta["id"]),
        doc_type=str(meta["doc_type"]),
        ata_chapter=str(meta.get("ata_chapter", "") or ""),
        component_types=list(meta.get("component_types") or []),
        fault_codes=list(meta.get("fault_codes") or []),
        title=str(meta["title"]),
        test_fixture=bool(meta.get("test_fixture", False)),
        body=body,
        path=path,
    )


def _chunk_doc(doc: _Doc) -> list[_Chunk]:
    """Split a doc body by `##` headings into ~120-250 word chunks.

    The preamble before the first heading (banner + applicability) becomes its
    own chunk when non-trivial. Every chunk is prefixed with the doc title so
    short chunks still carry enough lexical signal for BM25/TF-IDF.
    """
    lines = doc.body.splitlines()
    sections: list[tuple[str, list[str]]] = []
    current_heading = "preamble"
    current_lines: list[str] = []
    for line in lines:
        heading_match = _HEADING_RE.match(line.strip())
        if heading_match:
            if current_lines:
                sections.append((current_heading, current_lines))
            current_heading = heading_match.group(1).strip()
            current_lines = []
        else:
            current_lines.append(line)
    if current_lines:
        sections.append((current_heading, current_lines))

    chunks: list[_Chunk] = []
    for idx, (heading, section_lines) in enumerate(sections):
        text = "\n".join(section_lines).strip()
        if len(text.split()) < 3:
            continue
        chunk_id = f"{doc.doc_id}::{idx}::{heading[:40]}"
        header = f"{doc.doc_id} {doc.title} — {heading}" if heading != "preamble" else f"{doc.doc_id} {doc.title}"
        full_text = f"{header}\n{text}"
        chunks.append(_Chunk(doc_id=doc.doc_id, chunk_id=chunk_id, heading=heading, text=full_text))
    if not chunks:
        # Degenerate doc with no headings at all: index the whole body as one chunk.
        chunks.append(
            _Chunk(
                doc_id=doc.doc_id,
                chunk_id=f"{doc.doc_id}::0::body",
                heading="body",
                text=f"{doc.doc_id} {doc.title}\n{doc.body.strip()}",
            )
        )
    return chunks


class KBIndex:
    """In-process hybrid BM25 + TF-IDF search index over `kb/*.md`."""

    def __init__(self, kb_dir: Path, docs: dict[str, _Doc], chunks: list[_Chunk]):
        self.kb_dir = kb_dir
        self._docs = docs
        self._chunks = chunks
        self._tokenized = [_tokenize(c.text) for c in chunks]
        self._bm25 = BM25Okapi(self._tokenized) if chunks else None
        self._tfidf_vectorizer = TfidfVectorizer(tokenizer=_tokenize, lowercase=False) if chunks else None
        self._tfidf_matrix = self._tfidf_vectorizer.fit_transform([c.text for c in chunks]) if chunks else None

    @classmethod
    def build(cls, kb_dir: Path | str = DEFAULT_KB_DIR) -> "KBIndex":
        kb_dir = Path(kb_dir)
        docs: dict[str, _Doc] = {}
        chunks: list[_Chunk] = []
        for path in sorted(kb_dir.glob("*.md")):
            doc = _parse_file(path)
            if doc.doc_id in docs:
                raise ValueError(f"Duplicate KB doc id {doc.doc_id!r} ({path})")
            docs[doc.doc_id] = doc
            chunks.extend(_chunk_doc(doc))
        return cls(kb_dir=kb_dir, docs=docs, chunks=chunks)

    # -- lookups -----------------------------------------------------------------
    def exists(self, doc_id: str) -> bool:
        return doc_id in self._docs

    def get_doc(self, doc_id: str) -> dict | None:
        doc = self._docs.get(doc_id)
        if doc is None:
            return None
        return {
            "id": doc.doc_id,
            "doc_type": doc.doc_type,
            "ata_chapter": doc.ata_chapter,
            "component_types": doc.component_types,
            "fault_codes": doc.fault_codes,
            "title": doc.title,
            "test_fixture": doc.test_fixture,
            "body": doc.body,
        }

    def list_docs(self, include_test_fixtures: bool = False) -> list[dict]:
        return [
            self.get_doc(doc_id)
            for doc_id, doc in sorted(self._docs.items())
            if include_test_fixtures or not doc.test_fixture
        ]

    # -- ranking -------------------------------------------------------------
    def _bm25_ranked_indices(self, query: str) -> list[int]:
        if self._bm25 is None:
            return []
        scores = self._bm25.get_scores(_tokenize(query))
        return sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)

    def _tfidf_ranked_indices(self, query: str) -> list[int]:
        if self._tfidf_vectorizer is None:
            return []
        query_vec = self._tfidf_vectorizer.transform([query])
        sims = cosine_similarity(query_vec, self._tfidf_matrix)[0]
        return sorted(range(len(sims)), key=lambda i: sims[i], reverse=True)

    def _rrf_ranked_indices(self, query: str) -> list[tuple[int, float]]:
        bm25_rank = self._bm25_ranked_indices(query)
        tfidf_rank = self._tfidf_ranked_indices(query)
        rrf_scores: dict[int, float] = {}
        for rank_list in (bm25_rank, tfidf_rank):
            for rank, idx in enumerate(rank_list):
                rrf_scores[idx] = rrf_scores.get(idx, 0.0) + 1.0 / (_RRF_K + rank + 1)
        return sorted(rrf_scores.items(), key=lambda kv: kv[1], reverse=True)

    def _passes_filters(self, doc: _Doc, filters: dict) -> bool:
        if not filters:
            return True
        component_type = filters.get("component_type")
        if component_type and component_type not in doc.component_types:
            return False
        doc_type = filters.get("doc_type")
        if doc_type and doc_type != doc.doc_type:
            return False
        fault_code = filters.get("fault_code")
        if fault_code and fault_code not in doc.fault_codes:
            return False
        return True

    def search(
        self,
        query: str,
        k: int = 5,
        filters: dict | None = None,
        method: str = "hybrid",
        include_test_fixtures: bool = True,
    ) -> list[Hit]:
        """Search the index. `method` is one of `hybrid` (default), `bm25`, `tfidf`."""
        if not self._chunks:
            return []
        filters = filters or {}
        if method == "hybrid":
            ranked = self._rrf_ranked_indices(query)
        elif method == "bm25":
            ranked = [(i, 1.0 / (r + 1)) for r, i in enumerate(self._bm25_ranked_indices(query))]
        elif method == "tfidf":
            ranked = [(i, 1.0 / (r + 1)) for r, i in enumerate(self._tfidf_ranked_indices(query))]
        else:
            raise ValueError(f"Unknown retrieval method: {method}")

        seen_doc_ids: set[str] = set()
        hits: list[Hit] = []
        for idx, score in ranked:
            chunk = self._chunks[idx]
            doc = self._docs[chunk.doc_id]
            if not include_test_fixtures and doc.test_fixture:
                continue
            if not self._passes_filters(doc, filters):
                continue
            if chunk.doc_id in seen_doc_ids:
                continue  # one hit per doc so ranked results aren't dominated by one doc's chunks
            seen_doc_ids.add(chunk.doc_id)
            hits.append(
                Hit(
                    doc_id=chunk.doc_id,
                    chunk_id=chunk.chunk_id,
                    title=doc.title,
                    score=float(score),
                    text=chunk.text,
                    doc_type=doc.doc_type,
                )
            )
            if len(hits) >= k:
                break
        return hits


# --- eval -------------------------------------------------------------------


def _load_queries(path: Path) -> list[dict]:
    queries = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                queries.append(json.loads(line))
    return queries


def _recall_and_mrr_at_k(index: KBIndex, queries: list[dict], method: str, k: int = 3) -> dict:
    """Compute recall@1, recall@k, and MRR@k in one pass over the query set."""
    hits_at_1 = 0
    hits_at_k = 0
    reciprocal_ranks = []
    for q in queries:
        expected = q["expected_doc_id"]
        results = index.search(q["query"], k=k, method=method, include_test_fixtures=False)
        doc_ids = [h.doc_id for h in results]
        if doc_ids[:1] == [expected]:
            hits_at_1 += 1
        if expected in doc_ids:
            hits_at_k += 1
            reciprocal_ranks.append(1.0 / (doc_ids.index(expected) + 1))
        else:
            reciprocal_ranks.append(0.0)
    n = len(queries)
    return {
        "recall_at_1": hits_at_1 / n if n else 0.0,
        "recall_at_k": hits_at_k / n if n else 0.0,
        "mrr": sum(reciprocal_ranks) / n if n else 0.0,
        "k": k,
        "n_queries": n,
    }


def _methods_slice(index: KBIndex, queries: list[dict]) -> dict:
    return {method: _recall_and_mrr_at_k(index, queries, method, k=3) for method in ("bm25", "tfidf", "hybrid")}


def run_eval(kb_dir: Path = DEFAULT_KB_DIR, queries_path: Path | None = None, out_path: Path | None = None) -> dict:
    """Run the retrieval eval, slicing by the `difficulty` field on each query.

    Queries without an explicit `difficulty` default to "easy" (keeps the original
    25 title-vocabulary queries as the easy baseline). The pass/fail gate is
    computed on the easy slice only (`gate_threshold=0.85`); the hard slice is
    measured and reported honestly, with no pass/fail gate — see
    `reports/kb-eval-hardening-report.md` for the real numbers and why no gate is
    claimed there.
    """
    queries_path = queries_path or (Path(__file__).resolve().parents[2] / "kb_eval" / "queries.jsonl")
    out_path = out_path or (Path(__file__).resolve().parents[2] / "reports" / "retrieval_eval.json")
    index = KBIndex.build(kb_dir)
    queries = _load_queries(queries_path)
    easy_queries = [q for q in queries if q.get("difficulty", "easy") == "easy"]
    hard_queries = [q for q in queries if q.get("difficulty", "easy") == "hard"]

    results = _methods_slice(index, queries)
    slices = {
        "easy": _methods_slice(index, easy_queries) if easy_queries else {},
        "hard": _methods_slice(index, hard_queries) if hard_queries else {},
    }
    gate = {
        "hybrid_recall_at_3": slices["easy"].get("hybrid", {}).get("recall_at_k", 0.0),
        "gate_threshold": 0.85,
        "hybrid_meets_gate": slices["easy"].get("hybrid", {}).get("recall_at_k", 0.0) >= 0.85,
        "hybrid_at_least_bm25": slices["easy"].get("hybrid", {}).get("recall_at_k", 0.0)
        >= slices["easy"].get("bm25", {}).get("recall_at_k", 0.0),
        "slice": "easy",
        "note": "Hard slice is measured and reported in `slices.hard` but is NOT gated pass/fail; "
        "see reports/kb-eval-hardening-report.md for interpretation.",
    }
    report = {
        "results": results,
        "slices": slices,
        "gate": gate,
        "n_docs": len(index._docs),
        "n_chunks": len(index._chunks),
        "n_queries_total": len(queries),
        "n_queries_easy": len(easy_queries),
        "n_queries_hard": len(hard_queries),
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def _main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="KB retrieval eval / CLI utilities")
    parser.add_argument("--eval", action="store_true", help="Run the retrieval eval and write reports/retrieval_eval.json")
    parser.add_argument("--kb-dir", default=str(DEFAULT_KB_DIR))
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.eval:
        report = run_eval(kb_dir=Path(args.kb_dir))
        print(json.dumps(report, indent=2))
        return 0 if report["gate"]["hybrid_meets_gate"] and report["gate"]["hybrid_at_least_bm25"] else 1

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
