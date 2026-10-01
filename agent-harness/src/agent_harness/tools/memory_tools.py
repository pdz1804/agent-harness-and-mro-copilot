"""Long-term memory tools: `remember(fact, tags)` and `recall(query)`.

Memories are rows in `memories` (see `repos.memories`), strictly scoped to the
run's owner: the registry binds the owner's identity into each tool
(`bind_context`), and every query filters on it, so one user's agent can never
read or write another user's facts. `recall` ranks the owner's facts with the
same hybrid BM25 + dense retriever the knowledge base uses
(`retrieval.HybridIndex`), and bumps `use_count` / `last_used_at` for what it
returns. Which memories a run used is simply the `recall` results in its trace
(`GET /runs/{id}/memories` reads them back).
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator

from agent_harness.exceptions import ToolExecutionError
from agent_harness.repos import memories as memories_repo
from agent_harness.retrieval import HybridIndex, KBChunk, PositiveIdfBM25
from agent_harness.tools.base import Tool

# Memory tools exist for every role that may chat; the CLI (no signed-in user)
# excludes them because `required_action` is set.
_REQUIRED_ACTION = "chat"

_RECALL_DEFAULT_LIMIT = 5


class MemoryIndex(HybridIndex):
    """A throwaway hybrid index over one owner's facts (one chunk per fact;
    the fact text plus its tags is what gets ranked). Built per `recall`
    call: an owner has at most `MAX_MEMORIES_PER_OWNER` short facts and the
    dense embeddings are cached by text, so rebuilding is cheap and always
    fresh."""

    # A handful of short facts is a tiny corpus: use the positive-IDF scorer.
    _bm25_factory = PositiveIdfBM25

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        super().__init__()
        self.rows = {r["id"]: r for r in rows}
        for row in rows:
            tags = " ".join(row["tags"])
            self.chunks.append(KBChunk(doc_id=row["id"], title=tags, chunk_index=0, text=f"{row['fact']} {tags}".strip()))
        self._build_bm25()

    def search(self, query: str, limit: int, mode: Optional[str] = None) -> list[tuple[dict[str, Any], float]]:
        return [(self.rows[chunk.doc_id], score) for chunk, score in self.ranked_chunks(query, mode)[:limit]]


class RememberInput(BaseModel):
    fact: str = Field(
        min_length=3,
        max_length=memories_repo.MAX_FACT_CHARS,
        description="One self-contained fact worth keeping across conversations (a preference, an "
        "owner, a decision), written as a complete sentence.",
    )
    tags: list[str] = Field(
        default_factory=list,
        max_length=memories_repo.MAX_TAGS,
        description="Up to 8 short lowercase tags (e.g. a service name or a topic) to make it easy to find.",
    )

    @field_validator("fact")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("fact must not be blank")
        return value.strip()


class RememberOutput(BaseModel):
    memory_id: str
    status: str = Field(description="'saved' for a new memory, 'already_known' if the same fact was stored before.")
    fact: str
    tags: list[str]


class RecallInput(BaseModel):
    query: str = Field(min_length=1, description="What to look up in long-term memory, in plain words.")
    limit: int = Field(default=_RECALL_DEFAULT_LIMIT, ge=1, le=10)


class RecalledMemory(BaseModel):
    id: str
    fact: str
    tags: list[str]
    score: float
    saved_at: str


class RecallOutput(BaseModel):
    query: str
    matched: bool = Field(description="False when nothing matched and the most recent memories are returned instead.")
    memories: list[RecalledMemory]


class _OwnedMemoryTool:
    """Shared owner/run context handling for the two tools."""

    _owner_id: Optional[str] = None
    _run_id: str = ""

    def bind_context(self, **context: Any) -> None:
        owner_id = context.get("owner_id")
        if owner_id:
            self._owner_id = str(owner_id)
        run_id = context.get("run_id")
        if run_id:
            self._run_id = str(run_id)

    def _require_owner(self) -> str:
        if not self._owner_id:
            raise ToolExecutionError("memory needs a signed-in owner; no owner is bound to this run")
        return self._owner_id


class RememberTool(_OwnedMemoryTool, Tool[RememberInput, RememberOutput]):
    name = "remember"
    description = (
        "Save a durable fact to the user's long-term memory so it is available in future conversations. "
        "Use it when the user asks you to remember something or states a lasting preference or decision. "
        "Do not store secrets, passwords or one-off details."
    )
    input_model = RememberInput
    output_model = RememberOutput
    requires_approval = False
    required_action = _REQUIRED_ACTION

    def run(self, args: RememberInput) -> RememberOutput:
        owner_id = self._require_owner()
        try:
            row, created = memories_repo.create_memory(
                owner_id, args.fact, args.tags, source_run_id=self._run_id or None
            )
        except memories_repo.MemoryLimitError as exc:
            raise ToolExecutionError(str(exc)) from exc
        return RememberOutput(
            memory_id=row["id"], status="saved" if created else "already_known", fact=row["fact"], tags=list(row["tags"])
        )


class RecallTool(_OwnedMemoryTool, Tool[RecallInput, RecallOutput]):
    name = "recall"
    description = (
        "Look up the user's long-term memory for facts saved in earlier conversations (preferences, owners, "
        "past decisions). Call it when the request may depend on something the user told you before."
    )
    input_model = RecallInput
    output_model = RecallOutput
    requires_approval = False
    required_action = _REQUIRED_ACTION

    def run(self, args: RecallInput) -> RecallOutput:
        owner_id = self._require_owner()
        rows = memories_repo.list_memories(owner_id=owner_id)
        hits = MemoryIndex(rows).search(args.query, args.limit)
        matched = bool(hits)
        if not matched:
            hits = [(row, 0.0) for row in rows[: args.limit]]
        memories_repo.mark_used([row["id"] for row, _ in hits])
        return RecallOutput(
            query=args.query,
            matched=matched,
            memories=[
                RecalledMemory(id=row["id"], fact=row["fact"], tags=list(row["tags"]), score=float(score), saved_at=row["created_at"])
                for row, score in hits
            ],
        )
