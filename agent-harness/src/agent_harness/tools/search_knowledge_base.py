"""`search_knowledge_base` tool: real BM25 retrieval over the mock ops
runbook corpus at `data/kb/*.md` (see `agent_harness.retrieval`)."""

from __future__ import annotations

from pydantic import BaseModel, Field

from agent_harness import retrieval
from agent_harness.tools.base import Tool


class SearchKnowledgeBaseInput(BaseModel):
    query: str = Field(min_length=1, description="Free-text search query.")


class KnowledgeBaseResult(BaseModel):
    id: str
    title: str
    snippet: str
    score: float


class SearchKnowledgeBaseOutput(BaseModel):
    query: str
    results: list[KnowledgeBaseResult]


class SearchKnowledgeBaseTool(Tool[SearchKnowledgeBaseInput, SearchKnowledgeBaseOutput]):
    name = "search_knowledge_base"
    description = (
        "Search internal ops docs/runbooks for relevant articles. Returns up "
        "to 3 ranked results with id, title, snippet, and relevance score."
    )
    input_model = SearchKnowledgeBaseInput
    output_model = SearchKnowledgeBaseOutput
    requires_approval = False

    def run(self, args: SearchKnowledgeBaseInput) -> SearchKnowledgeBaseOutput:
        index = retrieval.get_index()
        results = [KnowledgeBaseResult(**r) for r in index.search(args.query, top_k=3)]
        return SearchKnowledgeBaseOutput(query=args.query, results=results)
