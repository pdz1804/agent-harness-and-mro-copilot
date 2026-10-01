import { describe, expect, it } from "vitest";
import { tokenizeInline } from "./SafeMarkdown";

describe("tokenizeInline", () => {
  it("parses bold segments", () => {
    expect(tokenizeInline("this is **bold** text")).toEqual([
      { kind: "text", value: "this is " },
      { kind: "bold", value: "bold" },
      { kind: "text", value: " text" },
    ]);
  });

  it("parses italic segments with * and _", () => {
    expect(tokenizeInline("*a* and _b_")).toEqual([
      { kind: "italic", value: "a" },
      { kind: "text", value: " and " },
      { kind: "italic", value: "b" },
    ]);
  });

  it("parses inline code without treating ** inside it as bold", () => {
    expect(tokenizeInline("run `** not bold **` now")).toEqual([
      { kind: "text", value: "run " },
      { kind: "code", value: "** not bold **" },
      { kind: "text", value: " now" },
    ]);
  });

  it("linkifies only http/https URLs", () => {
    expect(tokenizeInline("[docs](https://example.com/a)")).toEqual([
      { kind: "link", text: "docs", href: "https://example.com/a" },
    ]);
  });

  it("does not linkify javascript: URLs -- they fall through as plain text", () => {
    const tokens = tokenizeInline("[click](javascript:alert(1))");
    expect(tokens.some((t) => t.kind === "link")).toBe(false);
  });

  it("never produces raw HTML tokens for injected markup", () => {
    const tokens = tokenizeInline("<img src=x onerror=alert(1)> and <script>alert(2)</script>");
    // Everything is plain text tokens -- no token kind interprets `<...>` as
    // markup, so a renderer using React children (never dangerouslySetInnerHTML)
    // is safe by construction.
    expect(tokens.every((t) => t.kind === "text")).toBe(true);
    expect(tokens.map((t) => (t as { value: string }).value).join("")).toContain("<script>");
  });
});
