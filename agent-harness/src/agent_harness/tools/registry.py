"""Tool registry: name -> Tool instance lookup used by the execution loop."""

from __future__ import annotations

from agent_harness.tools.base import Tool
from agent_harness.tools.create_incident import CreateIncidentTool
from agent_harness.tools.get_service_status import GetServiceStatusTool
from agent_harness.tools.search_knowledge_base import SearchKnowledgeBaseTool

ToolRegistry = dict[str, Tool]


def build_default_registry() -> ToolRegistry:
    """Return the standard 3-tool registry (search, status, create_incident)."""
    tools: list[Tool] = [
        SearchKnowledgeBaseTool(),
        GetServiceStatusTool(),
        CreateIncidentTool(),
    ]
    return {tool.name: tool for tool in tools}
