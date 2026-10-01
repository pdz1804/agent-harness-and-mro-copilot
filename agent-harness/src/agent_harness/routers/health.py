"""Health and identity routes: `/health`, `/me`, `/users`."""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from agent_harness import dense_embeddings, rbac, settings
from agent_harness.api_models import MeView, UserView
from agent_harness.deps import CurrentUser, current_user
from agent_harness.repos import users as users_repo

router = APIRouter()


class HealthResponse(BaseModel):
    status: str
    llm_configured: bool
    llm_model: Optional[str] = None
    llm_last_error: Optional[str] = Field(
        default=None,
        description="Real provider error message from the most recent failed LLM call "
        "(e.g. 'OpenAI: insufficient_quota — add credits'), or null if configured and "
        "the last call (if any) succeeded. Distinct from llm_configured=false ('no API "
        "key set at all').",
    )
    embedding_model_status: Literal["disabled", "loading", "ready", "unavailable"] = Field(
        description="Warmup state of the local dense-embedding model used by hybrid KB "
        "retrieval. 'disabled' when AGENT_HARNESS_RETRIEVAL_MODE=bm25 (never loaded); "
        "'loading' while the background startup warmup is still in progress — a KB "
        "search landing now will wait briefly then degrade to BM25-only rather than "
        "time out; 'ready' once warm; 'unavailable' if loading failed (see "
        "embedding_model_error).",
    )
    embedding_model_error: Optional[str] = Field(
        default=None, description="Error from the embedding model load, if embedding_model_status is 'unavailable'."
    )


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    embedding_status: Literal["disabled", "loading", "ready", "unavailable"] = (
        "disabled" if settings.RETRIEVAL_MODE == "bm25" else dense_embeddings.get_status()  # type: ignore[assignment]
    )
    # dense_embeddings.get_status() never returns "idle" once warmup has been
    # kicked off at startup (see the lifespan hook in api.py); "idle" only shows
    # up if warmup somehow never started, which we treat the same as "loading" —
    # a request landing right now still gets the grace-period fallback.
    if embedding_status == "idle":
        embedding_status = "loading"
    return HealthResponse(
        status="ok",
        llm_configured=settings.llm_configured(),
        llm_model=settings.OPENAI_MODEL if settings.llm_configured() else None,
        llm_last_error=settings.last_llm_error(),
        embedding_model_status=embedding_status,
        embedding_model_error=dense_embeddings.last_load_error(),
    )


@router.get("/me", response_model=MeView)
def get_me(user: CurrentUser = Depends(current_user)) -> MeView:
    """The resolved caller identity plus the set of global actions their
    role permits — backs the header's role badge and the UI's
    cosmetic hide-the-button-you-can't-use affordance (server-side
    enforcement is what actually matters; see `require()`)."""
    return MeView(
        id=user.id,
        display_name=user.display_name,
        role=user.role,
        permissions=sorted(rbac.PERMISSIONS.get(user.role, set())),
    )


@router.get("/users", response_model=list[UserView])
def list_users(user: CurrentUser = Depends(current_user)) -> list[UserView]:
    """Every seeded identity, for the header's user switcher. Any
    authenticated role may list them (needed to switch identity at all)."""
    return [UserView(**row) for row in users_repo.list_users()]
