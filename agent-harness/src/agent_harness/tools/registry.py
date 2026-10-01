"""Tool registry: name -> Tool instance lookup used by the execution loop."""

from __future__ import annotations

from typing import Optional

from agent_harness import rbac
from agent_harness.tools.base import Tool
from agent_harness.tools.create_incident import CreateIncidentTool
from agent_harness.tools.dashboard_tools import AddWidgetTool, CreateDashboardTool
from agent_harness.tools.get_service_status import GetServiceStatusTool
from agent_harness.tools.memory_tools import RecallTool, RememberTool
from agent_harness.tools.search_knowledge_base import SearchKnowledgeBaseTool

ToolRegistry = dict[str, Tool]


def build_default_registry(
    owner_id: Optional[str] = None, owner_role: Optional[rbac.Role] = None
) -> ToolRegistry:
    """Return the standard tool registry (search, status, create_incident,
    create_dashboard, add_widget, remember, recall) with fresh tool instances.

    When `owner_role` is given the registry is built *for that run owner*:
    every tool is bound to the owner's identity (`bind_context`), and any
    tool whose `required_action` the role lacks is dropped — the LLM is
    never even offered a tool its user could not use (RBAC at tool-offer
    time, with `Tool.precheck` re-checking in depth)."""
    tools: list[Tool] = [
        SearchKnowledgeBaseTool(),
        GetServiceStatusTool(),
        CreateIncidentTool(),
        CreateDashboardTool(),
        AddWidgetTool(),
        RememberTool(),
        RecallTool(),
    ]
    registry: ToolRegistry = {}
    for tool in tools:
        if owner_role is not None and tool.required_action is not None:
            if not rbac.can(owner_role, tool.required_action):  # type: ignore[arg-type]
                continue
        if owner_id is not None and owner_role is not None:
            tool.bind_context(owner_id=owner_id, owner_role=owner_role)
        registry[tool.name] = tool
    return registry
