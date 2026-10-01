"""``/kb`` FastAPI router: browse + search the maintenance knowledge base
(``src.copilot.retrieval.KBIndex``, phase 04, imported not duplicated)."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

router = APIRouter(prefix="/kb", tags=["kb"])

_module_state: dict[str, object] = {"index": None}


def init_index(index) -> None:
    _module_state["index"] = index


def get_index():
    index = _module_state.get("index")
    if index is None:
        raise HTTPException(status_code=503, detail="KB index not initialized")
    return index


class KBSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str
    k: int = 5
    component_type: Optional[str] = None
    doc_type: Optional[str] = None


@router.get("")
def list_docs(index=Depends(get_index)):
    return index.list_docs(include_test_fixtures=False)


@router.post("/search")
def search(body: KBSearchRequest, index=Depends(get_index)):
    filters = {}
    if body.component_type:
        filters["component_type"] = body.component_type
    if body.doc_type:
        filters["doc_type"] = body.doc_type
    hits = index.search(body.query, k=body.k, filters=filters, include_test_fixtures=False)
    return [
        {"doc_id": h.doc_id, "title": h.title, "doc_type": h.doc_type, "score": h.score, "snippet": h.text[:300]}
        for h in hits
    ]


@router.get("/{doc_id}")
def get_doc(doc_id: str, index=Depends(get_index)):
    doc = index.get_doc(doc_id)
    if doc is None or doc.get("test_fixture"):
        raise HTTPException(status_code=404, detail=f"KB doc {doc_id!r} not found")
    return doc
