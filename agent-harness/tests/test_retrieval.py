"""Real BM25 retrieval ranking over the (test-fixture) KB corpus. Verifies
that a query about a specific service surfaces that service's runbook in
the top-3 results, and that the `search_knowledge_base` tool wraps the same
ranking function."""

from __future__ import annotations

from agent_harness import retrieval
from agent_harness.tools.search_knowledge_base import SearchKnowledgeBaseInput, SearchKnowledgeBaseTool


def test_known_query_surfaces_expected_doc_in_top_3():
    index = retrieval.get_index()
    results = index.search("auth-service outage session store", top_k=3, mode="bm25")

    assert results, "expected at least one BM25 hit"
    assert len(results) <= 3
    doc_ids = [r["id"] for r in results]
    assert "kb-002-auth-service-outage-checklist" in doc_ids


def test_search_scores_are_descending_and_positive():
    index = retrieval.get_index()
    results = index.search("payments-api degraded latency webhook queue", top_k=3, mode="bm25")

    assert results
    scores = [r["score"] for r in results]
    assert all(s > 0 for s in scores)
    assert scores == sorted(scores, reverse=True)


def test_unrelated_query_returns_no_false_positive_hits():
    index = retrieval.get_index()
    results = index.search("zzz_nonexistent_term_qqq", top_k=3, mode="bm25")
    assert results == []


def test_search_knowledge_base_tool_uses_real_retrieval():
    tool = SearchKnowledgeBaseTool()
    output = tool.run(SearchKnowledgeBaseInput(query="search-index rebuild job failed"))

    assert output.query == "search-index rebuild job failed"
    assert output.results
    assert output.results[0].id == "kb-003-search-index-rebuild-procedure"
    assert output.results[0].score > 0
