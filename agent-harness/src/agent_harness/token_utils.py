"""Real token counting over `pydantic_ai` message histories, shared by
`loop.py`'s autocompaction trigger and (indirectly, via the `llm_meta` it
already puts on every `llm_decision` event) the `/runs/{id}/tokens` and
`/usage/today` API endpoints.

Autocompaction needs a token count *before* the next real provider call
happens (that's the whole point — deciding whether to compact ahead of
time), so it cannot rely on a provider's own `usage.input_tokens`, which is
only known after a call completes. `tiktoken` gives a real, provider-grade
token count for the same text a request would carry (not a hand-rolled
heuristic like "words / 0.75"), so counts here are directly comparable to
`AUTOCOMPACT_TOKEN_BUDGET`. `cl100k_base` is used unconditionally (rather
than resolving per-model) since the harness only ever targets OpenAI chat
models, all of which tokenize close enough to this encoding for a budget
trigger — this is a threshold decision, not a billing calculation.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

import tiktoken
from pydantic_ai.messages import ModelMessage


@lru_cache(maxsize=1)
def _encoding() -> tiktoken.Encoding:
    return tiktoken.get_encoding("cl100k_base")


def count_text_tokens(text: str) -> int:
    """Real tiktoken count for `text`. Empty/falsy input is 0 tokens."""
    if not text:
        return 0
    return len(_encoding().encode(text))


def render_message_part(part: Any) -> str:
    """Flatten one `ModelRequestPart`/`ModelResponsePart` to plain text for
    token counting and for the autocompaction summarization prompt."""
    kind = getattr(part, "part_kind", None)
    content = getattr(part, "content", None)
    if kind in ("text", "user-prompt", "system-prompt"):
        return content if isinstance(content, str) else json.dumps(content, default=str)
    if kind == "tool-call":
        args = part.args_as_dict() if hasattr(part, "args_as_dict") else getattr(part, "args", {})
        return f"[tool_call {getattr(part, 'tool_name', '?')} args={json.dumps(args, default=str)}]"
    if kind == "tool-return":
        return f"[tool_return {getattr(part, 'tool_name', '?')}={json.dumps(content, default=str)}]"
    if kind == "retry-prompt":
        return f"[retry {json.dumps(content, default=str)}]"
    if content is not None:
        return content if isinstance(content, str) else json.dumps(content, default=str)
    return ""


def render_messages(messages: list[ModelMessage]) -> str:
    """Flatten a `pydantic_ai` message history into one text blob, in
    order, one rendered part per line."""
    lines: list[str] = []
    for message in messages:
        for part in getattr(message, "parts", []):
            text = render_message_part(part)
            if text:
                lines.append(text)
    return "\n".join(lines)


def count_message_tokens(messages: list[ModelMessage]) -> int:
    """Real tiktoken count over the flattened text of `messages` — what
    `_maybe_autocompact` compares against `HarnessConfig.autocompact_token_budget`."""
    return count_text_tokens(render_messages(messages))
