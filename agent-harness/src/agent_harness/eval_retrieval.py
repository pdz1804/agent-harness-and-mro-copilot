"""Retrieval quality eval: recall@1, recall@3, MRR for bm25 vs dense vs
hybrid over `data/kb_eval/queries.jsonl` (paraphrased ops queries with
labeled relevant doc ids).

Run:  python -m agent_harness.eval_retrieval
"""

from __future__ import annotations

import json
from pathlib import Path

from agent_harness import retrieval, settings

QUERIES_PATH = settings.PROJECT_ROOT / "data" / "kb_eval" / "queries.jsonl"


def _load_queries(path: Path = QUERIES_PATH) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def _evaluate(mode: str, queries: list[dict], top_k: int = 3) -> dict[str, float]:
    index = retrieval.get_index()
    hits_at_1 = 0
    hits_at_3 = 0
    reciprocal_ranks: list[float] = []
    for q in queries:
        results = index.search(q["query"], top_k=top_k, mode=mode)
        result_ids = [r["id"] for r in results]
        relevant = set(q["relevant_doc_ids"])
        rank = next((i + 1 for i, rid in enumerate(result_ids) if rid in relevant), None)
        if rank == 1:
            hits_at_1 += 1
        if rank is not None and rank <= 3:
            hits_at_3 += 1
        reciprocal_ranks.append(1.0 / rank if rank is not None else 0.0)
    n = len(queries) or 1
    return {
        "recall@1": hits_at_1 / n,
        "recall@3": hits_at_3 / n,
        "mrr": sum(reciprocal_ranks) / n,
    }


def run(queries_path: Path = QUERIES_PATH) -> dict[str, dict[str, float]]:
    queries = _load_queries(queries_path)
    results: dict[str, dict[str, float]] = {}
    for mode in ("bm25", "dense", "hybrid"):
        try:
            results[mode] = _evaluate(mode, queries)
        except retrieval.dense_embeddings.EmbeddingModelUnavailable as exc:  # type: ignore[attr-defined]
            results[mode] = {"error": str(exc)}
    return results


def format_markdown_table(results: dict[str, dict[str, float]]) -> str:
    lines = ["| mode | recall@1 | recall@3 | MRR |", "| --- | --- | --- | --- |"]
    for mode in ("bm25", "dense", "hybrid"):
        r = results.get(mode, {})
        if "error" in r:
            lines.append(f"| {mode} | error: {r['error']} | | |")
            continue
        lines.append(f"| {mode} | {r['recall@1']:.2f} | {r['recall@3']:.2f} | {r['mrr']:.2f} |")
    return "\n".join(lines)


def main() -> None:
    queries = _load_queries()
    results = run()
    print(f"Evaluated {len(queries)} queries from {QUERIES_PATH}\n")
    print(format_markdown_table(results))


if __name__ == "__main__":
    main()
