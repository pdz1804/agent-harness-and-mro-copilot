"""Request/response models shared by several API routers (identity, runs, sessions)."""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from agent_harness.rbac import Action, Role
from agent_harness.run_registry import AsyncRunStatus
from agent_harness.schemas import AgentEvent


class UserView(BaseModel):
    id: str
    display_name: str
    role: Role


class MeView(UserView):
    permissions: list[Action]


class RunRequest(BaseModel):
    objective: str = Field(min_length=1, description="The task for the agent to pursue.")
    auto_approve: bool = Field(
        default=False,
        description="If true, create_incident (and any other approval-gated tool) is "
        "pre-authorized for this run. If false, any approval-gated tool call is denied. "
        "This is request-level pre-authorization, not a pause/resume flow — see /runs "
        "for the real approval flow used by the web UI.",
    )
    max_steps: Optional[int] = Field(default=None, gt=0)
    max_wall_clock_seconds: Optional[float] = Field(default=None, gt=0)


class PlaygroundSpec(BaseModel):
    """Prompt Playground run: replace the agent's system prompt with an exact
    text - an unsaved draft, or a saved prompt version's content. Editor+."""

    system_prompt: Optional[str] = Field(
        default=None, description="Draft system prompt text (used verbatim, placeholders rendered)."
    )
    prompt_id: Optional[str] = None
    prompt_version_id: Optional[str] = Field(
        default=None, description="Use this saved version's content (needs prompt_id too)."
    )


class StartRunRequest(BaseModel):
    objective: str = Field(min_length=1, description="The task for the agent to pursue.")
    max_steps: Optional[int] = Field(default=None, gt=0)
    max_wall_clock_seconds: Optional[float] = Field(default=None, gt=0)
    session_id: Optional[str] = Field(
        default=None,
        description="Existing Sessions id to attach this run to (404s if unknown). If omitted, "
        "a new session is created automatically, titled from the objective — this is what "
        "'+ New chat' does.",
    )
    agent_id: Optional[str] = Field(
        default=None,
        description="Which agent (phase 04) drives this run's system prompt/tools/skill "
        "routing. Ignored if session_id is given (the session's own agent_id — fixed at "
        "session creation — wins, so an agent can't be swapped mid-session); defaults to the "
        "harness's default agent if omitted entirely.",
    )
    playground: Optional[PlaygroundSpec] = Field(
        default=None,
        description="Run with an explicit system prompt (Prompt Playground) instead of an agent's. "
        "Requires the mutate_prompts permission.",
    )
    agent_test: bool = Field(
        default=False,
        description="Mark the new session as an agent test chat (titled '[Test] ...'). The run is "
        "otherwise an ordinary run of `agent_id`: same prompt, skills, tools, approval gate.",
    )


class StartRunResponse(BaseModel):
    run_id: str
    status: AsyncRunStatus
    session_id: str


class PendingApprovalView(BaseModel):
    tool_name: str
    tool_args: dict[str, Any]
    preview: Optional[dict[str, Any]] = Field(
        default=None,
        description="Dry-run preview the tool attached to the approval request (e.g. a dashboard's "
        "widgets, their SQL and live row counts); null for tools without one.",
    )


class RunSnapshot(BaseModel):
    run_id: str
    objective: str
    status: AsyncRunStatus
    started_at: float
    steps_taken: int
    final_answer: Optional[str] = None
    pending_approval: Optional[PendingApprovalView] = None
    history: list[AgentEvent]
    trace_path: Optional[str] = None
    error: Optional[str] = None
    session_id: Optional[str] = None
    prompt_version_id: Optional[str] = Field(
        default=None,
        description="Which prompt_versions row's content was used as this run's system prompt "
        "(the version active at the moment the run started; later activations do not "
        "retroactively change it).",
    )
    triggered_by_automation_id: Optional[str] = Field(
        default=None,
        description="The automations row id that started this run (12d), or null if it was "
        "started manually (POST /run or a UI 'New run'/'+ New chat' submission).",
    )
    owner_id: str = Field(description="The user id this run belongs to (phase 01 RBAC).")
    agent_id: Optional[str] = Field(default=None, description="Which agent (phase 04) drove this run.")
    skill_ids: list[str] = Field(
        default_factory=list, description="Which skill(s) (phase 04), if any, were active for this run."
    )


class RunSummary(BaseModel):
    run_id: str
    objective: str
    status: AsyncRunStatus
    started_at: float
    session_id: Optional[str] = None
    prompt_version_id: Optional[str] = None
    triggered_by_automation_id: Optional[str] = None
    owner_id: str = "u_admin"
    agent_id: Optional[str] = None
    skill_ids: list[str] = Field(default_factory=list)


class SessionView(BaseModel):
    id: str
    title: str
    created_at: str
    last_active_at: Optional[str] = None
    status: AsyncRunStatus | Literal["idle"] = Field(
        description="Live status derived from the session's most recent run: the in-memory "
        "RunRegistry status if that run is still live in this process, else its last "
        "persisted status, else 'idle' for a session with no run yet."
    )
    last_run_id: Optional[str] = None
    owner_id: str = Field(default="u_admin", description="The user id this session belongs to.")
    agent_id: Optional[str] = Field(
        default=None, description="The agent (phase 04) this session is fixed to for its lifetime."
    )
    archived_at: Optional[str] = Field(default=None, description="When the session was archived, if it was.")


class CreateSessionRequest(BaseModel):
    title: Optional[str] = Field(default=None, description="Defaults to 'New chat' if omitted.")
    agent_id: Optional[str] = Field(
        default=None, description="Defaults to the harness's default agent if omitted."
    )


class UpdateSessionRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    archived: Optional[bool] = Field(default=None, description="True archives the session, false restores it.")


class SessionDetail(SessionView):
    runs: list[RunSummary] = Field(description="Every run started in this session, most recent first.")


class ApproveRequest(BaseModel):
    approved: bool = Field(description="True to approve the pending tool call, false to deny it.")


class PendingApprovalItem(BaseModel):
    run_id: str
    objective: str
    session_id: Optional[str] = None
    owner_id: str
    tool_name: str
    started_at: float
