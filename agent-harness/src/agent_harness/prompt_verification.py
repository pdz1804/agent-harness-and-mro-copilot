"""Verification for prompt versions: deterministic lint rules plus an
optional LLM review.

A prompt version cannot be activated until it has passed lint (no
`error`-severity issue). The lint rules are deliberately simple and
explainable - each issue names its rule, says exactly what was found and
where - so an author can fix it without guessing:

| rule                    | severity | what it checks                                              |
|-------------------------|----------|-------------------------------------------------------------|
| `empty`                 | error    | content is blank                                            |
| `too_short`             | warning  | fewer than 40 characters - rarely enough to steer an agent  |
| `too_long`              | error/warning | over 8000 chars (error) / over 4000 chars (warning)    |
| `unsupported_placeholder` | error  | a `{{name}}` that the runtime does not fill in              |
| `missing_placeholder`   | error    | a placeholder the prompt is configured to require is absent |
| `malformed_placeholder` | warning  | a stray `{{` or `}}` that is not part of a `{{name}}`       |
| `contradiction`         | warning  | "always X" and "never X" in the same prompt                 |

Placeholders are real: `render_placeholders` substitutes `{{today}}`,
`{{user_name}}` and `{{user_role}}` when a run's system prompt is built (see
`agent_runtime`), and the Playground uses the same function.

The optional LLM review is advisory: it returns a list of issues from a real
model call and never blocks activation by itself (a model's opinion is not a
gate; the deterministic rules are).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

MAX_CHARS_ERROR = 8000
MAX_CHARS_WARNING = 4000
MIN_CHARS_WARNING = 40

SUPPORTED_PLACEHOLDERS: dict[str, str] = {
    "today": "today's date (YYYY-MM-DD, UTC) when the run starts",
    "user_name": "display name of the user who started the run",
    "user_role": "role (admin/editor/viewer) of the user who started the run",
}

_PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
_STRAY_BRACES_RE = re.compile(r"\{\{|\}\}")
_ARTICLES = frozenset({"the", "a", "an", "any", "your", "this", "that", "to", "all", "it", "them"})

_POSITIVE_RE = re.compile(
    r"\b(?:always|must|should|ensure that you|make sure (?:to|you))\s+(?!not\b|never\b)([a-z_]+)(?:\s+([a-z_]+))?(?:\s+([a-z_]+))?",
    re.IGNORECASE,
)
_NEGATIVE_RE = re.compile(
    r"\b(?:never|must not|should not|do not|don't|mustn't|shouldn't|avoid)\s+([a-z_]+)(?:\s+([a-z_]+))?(?:\s+([a-z_]+))?",
    re.IGNORECASE,
)

# Hand-picked directly opposed style instructions (phrase, opposite).
_OPPOSED_STYLE = (
    ("be concise", "be verbose"),
    ("be brief", "be exhaustive"),
    ("keep it short", "be as detailed as possible"),
    ("answer in english", "answer in vietnamese"),
)

Severity = Literal["error", "warning", "info"]
Status = Literal["pass", "warn", "fail"]


class Issue(BaseModel):
    rule: str
    severity: Severity
    message: str
    line: Optional[int] = Field(default=None, description="1-based line number the issue refers to, if any.")


class LintResult(BaseModel):
    status: Status
    issues: list[Issue]
    checked_at: str
    char_count: int


class LlmReviewIssue(BaseModel):
    severity: Severity = Field(description="error = would likely break the agent, warning = risky, info = nit.")
    message: str = Field(description="What is wrong or risky, quoting the offending text.")
    suggestion: str = Field(default="", description="A concrete rewrite or fix.")


class LlmReviewOutput(BaseModel):
    summary: str = Field(default="", description="One sentence overall verdict.")
    issues: list[LlmReviewIssue] = Field(default_factory=list)


class LlmReviewResult(BaseModel):
    status: Literal["ok", "unavailable", "error"]
    summary: str = ""
    issues: list[LlmReviewIssue] = Field(default_factory=list)
    model: Optional[str] = None
    reviewed_at: str
    error: Optional[str] = None


class Verification(BaseModel):
    """What is persisted per prompt version (`prompt_versions.verification`)."""

    lint: LintResult
    llm_review: Optional[LlmReviewResult] = None
    verified_at: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _key(words: tuple[Optional[str], ...]) -> tuple[str, str]:
    """(verb, object) of a captured instruction: the first word and the first
    following non-article word - 'call the create_incident' -> ('call',
    'create_incident')."""
    verb = (words[0] or "").lower()
    obj = ""
    for word in words[1:]:
        if word and word.lower() not in _ARTICLES:
            obj = word.lower()
            break
    return verb, obj


def _find_contradictions(content: str) -> list[Issue]:
    positives: dict[tuple[str, str], int] = {}
    negatives: dict[tuple[str, str], int] = {}
    for line_no, line in enumerate(content.splitlines(), start=1):
        for match in _POSITIVE_RE.finditer(line):
            key = _key(match.groups())
            if key[1]:
                positives.setdefault(key, line_no)
        for match in _NEGATIVE_RE.finditer(line):
            key = _key(match.groups())
            if key[1]:
                negatives.setdefault(key, line_no)
    issues: list[Issue] = []
    for key in sorted(set(positives) & set(negatives)):
        verb, obj = key
        issues.append(
            Issue(
                rule="contradiction",
                severity="warning",
                line=negatives[key],
                message=(
                    f"Contradictory instructions about '{verb} {obj}': line {positives[key]} "
                    f"requires it, line {negatives[key]} forbids it."
                ),
            )
        )
    lowered = content.lower()
    for phrase, opposite in _OPPOSED_STYLE:
        if phrase in lowered and opposite in lowered:
            issues.append(
                Issue(
                    rule="contradiction",
                    severity="warning",
                    message=f"Opposed style instructions: '{phrase}' vs '{opposite}'.",
                )
            )
    return issues


def lint_prompt(content: str, *, required_placeholders: Optional[list[str]] = None) -> LintResult:
    """Run every deterministic rule over `content`. Never raises."""
    issues: list[Issue] = []
    stripped = content.strip()
    char_count = len(content)

    if not stripped:
        issues.append(Issue(rule="empty", severity="error", message="The prompt is empty."))
    else:
        if len(stripped) < MIN_CHARS_WARNING:
            issues.append(
                Issue(
                    rule="too_short",
                    severity="warning",
                    message=f"Only {len(stripped)} characters - too short to give an agent real guidance "
                    f"(aim for at least {MIN_CHARS_WARNING}).",
                )
            )
        if char_count > MAX_CHARS_ERROR:
            issues.append(
                Issue(
                    rule="too_long",
                    severity="error",
                    message=f"{char_count} characters exceeds the {MAX_CHARS_ERROR}-character limit; it "
                    "eats the context window on every turn. Trim it or move detail into a skill.",
                )
            )
        elif char_count > MAX_CHARS_WARNING:
            issues.append(
                Issue(
                    rule="too_long",
                    severity="warning",
                    message=f"{char_count} characters is long (warning above {MAX_CHARS_WARNING}); consider "
                    "moving task detail into a skill.",
                )
            )

        found = {m.group(1) for m in _PLACEHOLDER_RE.finditer(content)}
        for name in sorted(found):
            if name not in SUPPORTED_PLACEHOLDERS:
                issues.append(
                    Issue(
                        rule="unsupported_placeholder",
                        severity="error",
                        message=f"Placeholder {{{{{name}}}}} is not filled in at run time, so the model would "
                        f"see it literally. Supported: {', '.join('{{' + k + '}}' for k in SUPPORTED_PLACEHOLDERS)}.",
                    )
                )
        for name in required_placeholders or []:
            if name not in found:
                issues.append(
                    Issue(
                        rule="missing_placeholder",
                        severity="error",
                        message=f"Required placeholder {{{{{name}}}}} is missing from this prompt.",
                    )
                )
        without_valid = _PLACEHOLDER_RE.sub("", content)
        for line_no, line in enumerate(without_valid.splitlines(), start=1):
            if _STRAY_BRACES_RE.search(line):
                issues.append(
                    Issue(
                        rule="malformed_placeholder",
                        severity="warning",
                        line=line_no,
                        message="Stray '{{' or '}}' that is not part of a {{name}} placeholder.",
                    )
                )
        issues.extend(_find_contradictions(content))

    if any(i.severity == "error" for i in issues):
        status: Status = "fail"
    elif any(i.severity == "warning" for i in issues):
        status = "warn"
    else:
        status = "pass"
    return LintResult(status=status, issues=issues, checked_at=_now(), char_count=char_count)


def render_placeholders(content: str, *, user_name: str, user_role: str, today: Optional[str] = None) -> str:
    """Fill the supported `{{placeholders}}`; anything else is left untouched
    (lint already rejects unsupported ones before a version can be active)."""
    values = {
        "today": today or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "user_name": user_name,
        "user_role": user_role,
    }

    def _sub(match: re.Match[str]) -> str:
        return values.get(match.group(1), match.group(0))

    return _PLACEHOLDER_RE.sub(_sub, content)


_REVIEW_SYSTEM_PROMPT = (
    "You review system prompts for an LLM ops-assistant agent that calls tools. Find concrete "
    "problems: ambiguous or contradictory instructions, missing guidance on when to use or avoid "
    "tools, unsafe instructions (e.g. bypassing human approval), instructions the model cannot "
    "follow, and wasteful verbosity. Report only real issues, each quoting the offending text and "
    "giving a concrete fix. If the prompt is sound, return an empty issue list."
)


def llm_review(
    content: str,
    *,
    kind: str,
    model_factory: Callable[[], Optional[Any]],
) -> LlmReviewResult:
    """Ask a real LLM to review `content`. Never raises: an unconfigured or
    failing model yields `status='unavailable'/'error'` with a client-safe
    message, so verification itself never breaks."""
    from pydantic_ai import Agent as PydanticAgent

    try:
        model = model_factory()
    except Exception:  # noqa: BLE001 - e.g. a 503 "LLM not configured" HTTPException
        return LlmReviewResult(
            status="unavailable",
            reviewed_at=_now(),
            error="LLM review unavailable: no model is configured (set OPENAI_API_KEY).",
        )
    if model is None:
        return LlmReviewResult(
            status="unavailable",
            reviewed_at=_now(),
            error="LLM review unavailable: no model is configured (set OPENAI_API_KEY).",
        )
    try:
        agent = PydanticAgent(system_prompt=_REVIEW_SYSTEM_PROMPT, output_type=LlmReviewOutput)
        result = agent.run_sync(f"Prompt kind: {kind}\n\n--- PROMPT START ---\n{content}\n--- PROMPT END ---", model=model)
        output: LlmReviewOutput = result.output
        return LlmReviewResult(
            status="ok",
            summary=output.summary,
            issues=output.issues,
            model=getattr(model, "model_name", None),
            reviewed_at=_now(),
        )
    except Exception:  # noqa: BLE001 - provider errors must not break verification
        return LlmReviewResult(
            status="error",
            reviewed_at=_now(),
            error="LLM review failed (the model call errored); lint results are still valid.",
        )


def verify(
    content: str,
    *,
    kind: str,
    required_placeholders: Optional[list[str]] = None,
    with_llm_review: bool = False,
    model_factory: Optional[Callable[[], Optional[Any]]] = None,
) -> Verification:
    lint = lint_prompt(content, required_placeholders=required_placeholders)
    review = None
    if with_llm_review and model_factory is not None and lint.status != "fail":
        review = llm_review(content, kind=kind, model_factory=model_factory)
    return Verification(lint=lint, llm_review=review, verified_at=_now())


def can_activate(verification: Optional[dict[str, Any]]) -> bool:
    """A version may be activated only if its persisted lint status is not
    `fail`. A version with no verification at all is never activatable."""
    if not verification:
        return False
    lint = verification.get("lint") or {}
    return lint.get("status") in ("pass", "warn")
