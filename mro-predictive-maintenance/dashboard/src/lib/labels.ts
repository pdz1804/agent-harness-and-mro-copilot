import type { Tone } from "./risk";

/** Honest wording shared across pages. */

/** Drift never reads "quiet": an unshifted, healthy detector says "no alert". */
export function driftLabel(status: string): string {
  if (status === "alert") return "alert";
  if (status === "warn") return "warn";
  if (status === "insufficient_data") return "insufficient data";
  return "no alert";
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
