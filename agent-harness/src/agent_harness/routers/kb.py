"""Knowledge-base routes: the document list and quick search, a
document viewer (full content, the chunks the retriever indexes, metadata,
query-term matches), adding/deleting documents, reindexing, and a
chunk-level retrieval playground that exposes BM25 / vector / fused scores.

The 18 seed runbooks are read-only files under `data/kb/`; documents added
here are rows in `kb_documents` (real Postgres), chunked with the same
`retrieval._chunk` and indexed by the same BM25 + dense (RRF-fused)
pipeline as the seed corpus, so the agent's `search_knowledge_base` tool finds
them immediately. RBAC: reading is open to every role; adding, deleting and
reindexing require `mutate_kb` (admin/editor), and an editor can only delete
documents they uploaded themselves (admin: any upload).
"""

from __future__ import annotations

import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from agent_harness import db, dense_embeddings, retrieval, settings
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.repos import trash

router = APIRouter()

MAX_DOC_CHARS = 200_000
MIN_DOC_CHARS = 20


class KBChunkView(BaseModel):
    index: int
    text: str
    chars: int
    char_start: Optional[int] = Field(default=None, description="Approximate offset of the chunk in the document.")
    matched_terms: list[str] = Field(default_factory=list)
    bm25_score: Optional[float] = Field(default=None, description="BM25 score against `q`, when given.")


class KBDocDetail(BaseModel):
    id: str
    title: str
    source: Literal["seed", "upload"]
    filename: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[str] = None
    chars: int
    words: int
    chunk_count: int
    content: str
    chunks: list[KBChunkView]
    query: Optional[str] = None
    matched_terms: list[str] = Field(default_factory=list)


class CreateKBDocRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    content: str = Field(description="Markdown or plain text.")


class ReindexResult(BaseModel):
    documents: int
    chunks: int
    dense_ready: bool
    took_ms: int


class RetrieveRequest(BaseModel):
    query: str = Field(min_length=1)
    mode: Literal["bm25", "dense", "hybrid"] = "hybrid"
    top_k: int = Field(default=10, ge=1, le=30)


class RetrievedChunk(BaseModel):
    doc_id: str
    title: str
    chunk_index: int
    text: str
    bm25_score: Optional[float] = None
    bm25_rank: Optional[int] = None
    dense_score: Optional[float] = None
    dense_rank: Optional[int] = None
    fused_score: Optional[float] = None
    would_return: bool = Field(description="True if the agent's search tool would hand this chunk back.")


class RetrieveResult(BaseModel):
    mode: str
    effective_mode: str
    dense_available: bool
    hits: list[RetrievedChunk]
    latency_ms: float = Field(default=0.0, description="Server-side ranking time for this query, in milliseconds.")
    indexed_chunks: int = Field(default=0, description="Chunks in the index the query was ranked against.")


def _title_from(content: str, fallback: str = "Untitled document") -> str:
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            title = stripped.lstrip("#").strip()
            if title:
                return title[:200]
    first = next((ln.strip() for ln in content.splitlines() if ln.strip()), "")
    return (first[:80] or fallback)


@router.get("/kb/{doc_id}", response_model=KBDocDetail)
def get_kb_doc(
    doc_id: str,
    q: Optional[str] = Query(default=None, description="Optional search query: marks matching terms/chunks."),
    user: CurrentUser = Depends(current_user),
) -> KBDocDetail:
    """One document in full: the raw content, the chunks the retriever
    actually indexes (what a search can return), and metadata. With `q`,
    each chunk also reports which query terms it contains and its BM25 score
    for that query, so the viewer can highlight hits."""
    index = retrieval.get_index()
    doc = index.get_doc(doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail=f"unknown document '{doc_id}'")

    chunks = index.chunks_of(doc_id)
    scores: dict[int, float] = {}
    if q and q.strip():
        tokens = retrieval._tokenize(q)
        for chunk, score in index._bm25_ranked(tokens):
            if chunk.doc_id == doc_id:
                scores[chunk.chunk_index] = float(score)

    cursor = 0
    chunk_views: list[KBChunkView] = []
    for chunk in chunks:
        probe = chunk.text[:60]
        found = doc.text.find(probe, cursor) if probe else -1
        if found >= 0:
            cursor = found
        chunk_views.append(
            KBChunkView(
                index=chunk.chunk_index,
                text=chunk.text,
                chars=len(chunk.text),
                char_start=found if found >= 0 else None,
                matched_terms=retrieval.matched_terms(q, chunk.text) if q else [],
                bm25_score=scores.get(chunk.chunk_index) if q else None,
            )
        )
    return KBDocDetail(
        id=doc.doc_id,
        title=doc.title,
        source=doc.source,  # type: ignore[arg-type]
        filename=doc.path.name if doc.path is not None else None,
        created_by=doc.created_by,
        created_at=doc.created_at,
        chars=len(doc.text),
        words=len(doc.text.split()),
        chunk_count=len(chunk_views),
        content=doc.text,
        chunks=chunk_views,
        query=q,
        matched_terms=retrieval.matched_terms(q, doc.text) if q else [],
    )


@router.post("/kb", response_model=KBDocDetail, status_code=201)
def create_kb_doc(request: CreateKBDocRequest, user: CurrentUser = Depends(require("mutate_kb"))) -> KBDocDetail:
    """Add a document. It is stored in Postgres, chunked, and indexed right
    away - the agent's `search_knowledge_base` tool can return it on the very
    next call."""
    content = request.content.replace("\r\n", "\n").strip()
    if len(content) < MIN_DOC_CHARS:
        raise HTTPException(status_code=422, detail=f"content must be at least {MIN_DOC_CHARS} characters")
    if len(content) > MAX_DOC_CHARS:
        raise HTTPException(status_code=422, detail=f"content exceeds the {MAX_DOC_CHARS}-character limit")
    title = (request.title or "").strip() or _title_from(content)
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "doc"
    doc_id = f"upl-{slug}-{uuid.uuid4().hex[:6]}"
    now = datetime.now(timezone.utc).isoformat()
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO kb_documents (id, title, content, source, created_by, created_at, updated_at) "
            "VALUES (%s, %s, %s, 'upload', %s, %s, %s)",
            (doc_id, title, content, user.id, now, now),
        )
    retrieval.reset_index()
    return get_kb_doc(doc_id, None, user)


@router.delete("/kb/{doc_id}", status_code=204)
def delete_kb_doc(doc_id: str, user: CurrentUser = Depends(require("mutate_kb"))) -> None:
    """Soft-delete an UPLOADED document (seed runbooks are read-only files): it
    leaves search at once and is purged after the retention window unless
    restored. An editor may delete only what they uploaded; an admin any upload."""
    with db.connect() as conn:
        row = conn.execute(
            "SELECT created_by FROM kb_documents WHERE id = %s AND deleted_at IS NULL", (doc_id,)
        ).fetchone()
        if row is None:
            if retrieval.get_index().get_doc(doc_id) is not None:
                raise HTTPException(status_code=403, detail="seed runbooks are read-only and cannot be deleted")
            raise HTTPException(status_code=404, detail=f"unknown document '{doc_id}'")
        if user.role != "admin" and row["created_by"] != user.id:
            raise HTTPException(status_code=403, detail="you may only delete documents you uploaded")
        conn.execute("UPDATE kb_documents SET deleted_at = %s WHERE id = %s", (trash.now_iso(), doc_id))
    retrieval.reset_index()


@router.post("/kb/{doc_id}/restore", response_model=KBDocDetail)
def restore_kb_doc(doc_id: str, user: CurrentUser = Depends(require("mutate_kb"))) -> KBDocDetail:
    """Undo a delete; the document is searchable again immediately. Same
    ownership rule as delete. 404 if unknown or not deleted."""
    with db.connect() as conn:
        row = conn.execute(
            "SELECT created_by FROM kb_documents WHERE id = %s AND deleted_at IS NOT NULL", (doc_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"document '{doc_id}' is not deleted")
        if user.role != "admin" and row["created_by"] != user.id:
            raise HTTPException(status_code=403, detail="you may only restore documents you uploaded")
        conn.execute("UPDATE kb_documents SET deleted_at = NULL WHERE id = %s", (doc_id,))
    retrieval.reset_index()
    return get_kb_doc(doc_id, None, user)


@router.post("/kb/reindex", response_model=ReindexResult)
def reindex_kb(user: CurrentUser = Depends(require("mutate_kb"))) -> ReindexResult:
    """Rebuild the whole index from disk + `kb_documents` and (unless
    retrieval is BM25-only) re-embed every chunk now, so the next search is
    not the one that pays for it."""
    started = time.monotonic()
    retrieval.reset_index()
    index = retrieval.get_index()
    dense_ready = False
    if settings.RETRIEVAL_MODE != "bm25" and index.chunks:
        try:
            index._dense_ranked("warmup")
            dense_ready = True
        except dense_embeddings.EmbeddingModelUnavailable:
            dense_ready = False
    return ReindexResult(
        documents=len(index.docs),
        chunks=len(index.chunks),
        dense_ready=dense_ready,
        took_ms=int((time.monotonic() - started) * 1000),
    )


@router.post("/kb/retrieve", response_model=RetrieveResult)
def retrieve_chunks(request: RetrieveRequest, user: CurrentUser = Depends(current_user)) -> RetrieveResult:
    """Retrieval playground: run a query and see every ranked chunk with its
    BM25, vector and fused (RRF) scores, plus which chunks the agent's search
    tool would actually return."""
    index = retrieval.get_index()
    started = time.perf_counter()
    result: dict[str, Any] = index.rank_chunks(request.query, mode=request.mode, top_k=request.top_k)
    latency_ms = round((time.perf_counter() - started) * 1000, 1)
    return RetrieveResult(**result, latency_ms=latency_ms, indexed_chunks=len(index.chunks))


class KBDocView(BaseModel):
    id: str
    title: str
    source: Literal["seed", "upload"] = "seed"
    chars: int = 0
    chunk_count: int = 0


class KBSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=3, gt=0, le=10)


class KBSearchResult(BaseModel):
    id: str
    title: str
    snippet: str
    score: float


@router.get("/kb", response_model=list[KBDocView])
def list_kb_docs(user: CurrentUser = Depends(current_user)) -> list[KBDocView]:
    return [KBDocView(**doc) for doc in retrieval.get_index().list_docs()]


@router.post("/kb/search", response_model=list[KBSearchResult])
def search_kb(request: KBSearchRequest, user: CurrentUser = Depends(current_user)) -> list[KBSearchResult]:
    """Hits the same retrieval function the `search_knowledge_base` tool uses,
    exposed directly so the web UI's Knowledge base page can let a reviewer try
    queries without starting a full agent run."""
    results = retrieval.get_index().search(request.query, top_k=request.top_k)
    return [KBSearchResult(**r) for r in results]
