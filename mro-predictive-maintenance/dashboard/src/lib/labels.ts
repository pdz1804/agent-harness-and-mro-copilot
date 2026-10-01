import type { Tone } from "./risk";

/** Honest wording shared across pages. */

/** PSI bands in the design's words: Stable < warn <= Watch < alert <= Drift. */
export function driftLabel(status: string): string {
  if (status === "alert") return "Drift";
  if (status === "warn") return "Watch";
  if (status === "insufficient_data") return "Insufficient data";
  return "Stable";
}

export function driftTone(status: string): Tone {
  if (status === "alert") return "bad";
  if (status === "warn") return "warn";
  if (status === "ok") return "good";
  return "neutral";
}

/** The copilot's non-LLM mode is a script, not an absence of service. */
export function copilotModeLabel(mode: string): string {
  if (mode === "openai") return "OpenAI";
  if (mode === "offline") return "scripted";
  return mode;
}

export function copilotModeNote(mode: string): string {
  return mode === "offline"
    ? "Scripted replies for a fixed set of prompts. No language model is called."
    : "Replies come from a language model; tool calls still need approval.";
}
