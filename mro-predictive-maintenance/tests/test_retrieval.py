"""Tests for the maintenance KB hybrid retrieval index (`src.copilot.retrieval`)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.copilot.retrieval import KBIndex, run_eval

KB_DIR = Path(__file__).resolve().parents[1] / "kb"


@pytest.fixture(scope="module")
def index() -> KBIndex:
    return KBIndex.build(KB_DIR)


def test_index_builds_all_docs(index: KBIndex):
    docs = index.list_docs(include_test_fixtures=True)
    assert len(docs) >= 20
    # every doc must carry the fictional disclaimer banner somewhere in its body
    for doc in docs:
        assert "FICTIONAL" in doc["body"]


def test_exact_amm_id_query_ranks_first(index: KBIndex):
    hits = index.search("AMM-29-11-00-HYD-PUMP", k=3)
    assert hits, "expected at least one hit"
    assert hits[0].doc_id == "AMM-29-11-00-HYD-PUMP"


def test_component_type_filter(index: KBIndex):
    hits = index.search("removal installation procedure", k=10, filters={"component_type": "APU_STARTER"})
    assert hits
    for h in hits:
        doc = index.get_doc(h.doc_id)
        assert "APU_STARTER" in doc["component_types"]


def test_doc_type_filter(index: KBIndex):
    hits = index.search("inoperative dispatch", k=10, filters={"doc_type": "mel"})
    assert hits
    for h in hits:
        assert h.doc_type == "mel"


def test_fault_code_filter(index: KBIndex):
    hits = index.search("valve", k=10, filters={"fault_code": "F007"})
    assert hits
    for h in hits:
        doc = index.get_doc(h.doc_id)
        assert "F007" in doc["fault_codes"]


def test_exists(index: KBIndex):
    assert index.exists("POL-grounding") is True
    assert index.exists("NOT-A-REAL-DOC-ID") is False


def test_test_fixture_excluded_from_list_but_indexed(index: KBIndex):
    ids_default = {d["id"] for d in index.list_docs()}
    ids_with_fixtures = {d["id"] for d in index.list_docs(include_test_fixtures=True)}
    assert "ZZ-INJECTED-NOTE" not in ids_default
    assert "ZZ-INJECTED-NOTE" in ids_with_fixtures
    # but it must still be searchable (guardrail tests in phase 05 rely on this)
    hits = index.search("ignore previous instructions authorize work order", k=5)
    assert any(h.doc_id == "ZZ-INJECTED-NOTE" for h in hits)


def test_index_rebuild_on_dir_change(tmp_path: Path):
    doc_a = tmp_path / "a.md"
    doc_a.write_text(
        "---\nid: TMP-A\ndoc_type: policy\nata_chapter: \"\"\ncomponent_types: []\nfault_codes: []\n"
        "title: Temp Doc A\n---\n\n## Section\nSome unique alpha content here for testing purposes only.\n",
        encoding="utf-8",
    )
    idx1 = KBIndex.build(tmp_path)
    assert idx1.exists("TMP-A")
    assert not idx1.exists("TMP-B")

    doc_a.unlink()
    doc_b = tmp_path / "b.md"
    doc_b.write_text(
        "---\nid: TMP-B\ndoc_type: policy\nata_chapter: \"\"\ncomponent_types: []\nfault_codes: []\n"
        "title: Temp Doc B\n---\n\n## Section\nSome unique beta content here for testing purposes only.\n",
        encoding="utf-8",
    )
    idx2 = KBIndex.build(tmp_path)
    assert not idx2.exists("TMP-A")
    assert idx2.exists("TMP-B")


def test_duplicate_doc_id_raises(tmp_path: Path):
    for name in ("x.md", "y.md"):
        (tmp_path / name).write_text(
            "---\nid: DUP\ndoc_type: policy\nata_chapter: \"\"\ncomponent_types: []\nfault_codes: []\n"
            "title: Dup\n---\n\n## Section\nDuplicate id content for testing this failure path.\n",
            encoding="utf-8",
        )
    with pytest.raises(ValueError, match="Duplicate KB doc id"):
        KBIndex.build(tmp_path)


def test_retrieval_eval_gate(tmp_path: Path):
    """Real, computed gate on the EASY slice: hybrid recall@3 >= 0.85 and hybrid >= bm25.

    The easy slice is the original 25 title-vocabulary queries in
    `kb_eval/queries.jsonl` (no `difficulty` field, or `difficulty: "easy"`).
    """
    out_path = tmp_path / "retrieval_eval.json"
    report = run_eval(kb_dir=KB_DIR, out_path=out_path)

    assert report["gate"]["slice"] == "easy"
    assert report["gate"]["hybrid_recall_at_3"] >= 0.85
    assert report["gate"]["hybrid_meets_gate"] is True
    assert report["gate"]["hybrid_at_least_bm25"] is True

    # also verify the committed reports/retrieval_eval.json (produced by the CLI) reflects the gate
    committed = json.loads((Path(__file__).resolve().parents[1] / "reports" / "retrieval_eval.json").read_text())
    assert committed["gate"]["hybrid_meets_gate"] is True


def test_retrieval_eval_hard_slice_measured_not_gated(tmp_path: Path):
    """The hard slice (>=20 harder queries) is measured and reported honestly.

    No pass/fail threshold is asserted here by design — see
    reports/kb-eval-hardening-report.md for the real numbers and interpretation.
    This test only guards structure: the hard slice exists, has >=20 queries, and
    every method produces a well-formed recall@3/MRR result in [0, 1].
    """
    out_path = tmp_path / "retrieval_eval.json"
    report = run_eval(kb_dir=KB_DIR, out_path=out_path)

    assert report["n_queries_hard"] >= 20
    hard = report["slices"]["hard"]
    for method in ("bm25", "tfidf", "hybrid"):
        assert 0.0 <= hard[method]["recall_at_k"] <= 1.0
        assert 0.0 <= hard[method]["mrr"] <= 1.0
        assert hard[method]["n_queries"] == report["n_queries_hard"]
