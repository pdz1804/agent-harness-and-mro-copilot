"""Human-approval gate.

`ApprovalCallback` is the injectable seam: interactive CLI use plugs in
`cli_prompt_approval` (blocks on stdin), API/test use plugs in any callable
matching the signature, e.g. a fixed decision or a queue-driven fake.
"""

from __future__ import annotations

from typing import Any, Callable, Protocol


class ApprovalCallback(Protocol):
    def __call__(self, tool_name: str, tool_args: dict[str, Any]) -> bool: ...


def cli_prompt_approval(tool_name: str, tool_args: dict[str, Any]) -> bool:
    """Blocking interactive approval prompt for the CLI."""
    print(f"\n[APPROVAL REQUIRED] Agent wants to call '{tool_name}' with args:")
    for key, value in tool_args.items():
        print(f"    {key}: {value}")
    while True:
        answer = input("Approve? [y/N]: ").strip().lower()
        if answer in ("y", "yes"):
            return True
        if answer in ("", "n", "no"):
            return False
        print("Please answer 'y' or 'n'.")


def always_approve(tool_name: str, tool_args: dict[str, Any]) -> bool:
    """Convenience callback for tests/non-interactive automation."""
    return True


def always_deny(tool_name: str, tool_args: dict[str, Any]) -> bool:
    """Convenience callback for tests/non-interactive automation."""
    return False


def fixed_decision_approval(decision: bool) -> Callable[[str, dict[str, Any]], bool]:
    """Build a callback that always returns `decision` (used by the API layer
    to turn a single request-level `auto_approve` flag into a callback)."""

    def _callback(tool_name: str, tool_args: dict[str, Any]) -> bool:
        return decision

    return _callback
