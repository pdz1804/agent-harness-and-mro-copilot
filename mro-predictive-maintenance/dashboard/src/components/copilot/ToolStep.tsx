import { useState } from "react";
import type { CopilotMessage } from "../../types";

interface ToolStepProps {
  message: CopilotMessage;
}

/** A tool_call/tool_result pair rendered as a collapsible step, per the
 * phase spec ("tool events rendered as collapsible steps"). */
export function ToolStep({ message }: ToolStepProps) {
  const [open, setOpen] = useState(false);
  const isCall = message.role === "tool_call";
  return (
    <div className="tool-row">
      <button type="button" className="tool-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tool-arrow" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="tool-verb">{isCall ? "Called" : "Result from"}</span>
        <span className="mono">{message.tool_name}</span>
      </button>
      {open && <pre className="tool-body">{JSON.stringify(isCall ? message.args : message.content, null, 2)}</pre>}
    </div>
  );
}
