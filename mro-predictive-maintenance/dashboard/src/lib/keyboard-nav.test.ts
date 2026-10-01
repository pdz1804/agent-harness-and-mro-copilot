import { describe, expect, it } from "vitest";
import { isTypingTarget, matchShortcut, neighborId, positionOf } from "./keyboard-nav";

const el = (tagName: string, attrs: Record<string, string> = {}, editable = false) => ({
  tagName,
  isContentEditable: editable,
  getAttribute: (n: string) => attrs[n] ?? null,
});

describe("keyboard-nav", () => {
  it("steps through ids without wrapping", () => {
    expect(neighborId([1, 2, 3], 2, 1)).toBe(3);
    expect(neighborId([1, 2, 3], 2, -1)).toBe(1);
    expect(neighborId([1, 2, 3], 3, 1)).toBeNull();
    expect(neighborId([1, 2, 3], 1, -1)).toBeNull();
    expect(neighborId([1, 2, 3], 9, 1)).toBeNull();
    expect(neighborId([1, 2, 3], null, 1)).toBeNull();
  });
  it("reports position", () => {
    expect(positionOf(["a", "b"], "b")).toEqual({ index: 2, total: 2 });
    expect(positionOf(["a"], "z")).toBeNull();
  });
  it("detects typing targets", () => {
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTypingTarget(el("INPUT", { type: "range" }))).toBe(false);
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("DIV", {}, true))).toBe(true);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
  it("maps shortcuts", () => {
    expect(matchShortcut({ key: "k", ctrlKey: true }, el("INPUT"))).toBe("palette");
    expect(matchShortcut({ key: "K", metaKey: true }, null)).toBe("palette");
    expect(matchShortcut({ key: "?" }, el("BODY"))).toBe("help");
    expect(matchShortcut({ key: "?" }, el("INPUT"))).toBeNull();
    expect(matchShortcut({ key: "ArrowRight" }, el("BODY"))).toBe("next");
    expect(matchShortcut({ key: "ArrowLeft" }, el("TEXTAREA"))).toBeNull();
    expect(matchShortcut({ key: "j" }, null)).toBe("next");
    expect(matchShortcut({ key: "Escape" }, el("INPUT"))).toBe("close");
    expect(matchShortcut({ key: "a", altKey: true }, null)).toBeNull();
  });
});
