import { describe, expect, it } from "vitest";
import { parseDocBlocks } from "./doc-blocks";

describe("parseDocBlocks", () => {
  it("parses headings, paragraphs, quotes and lists", () => {
    const blocks = parseDocBlocks(
      ["# Title", "", "> **Warning**", "> second line", "", "Para one", "continues", "", "- a", "- b", "", "1. x", "2. y"].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "quote", text: "**Warning** second line" },
      { kind: "paragraph", text: "Para one continues" },
      { kind: "list", ordered: false, items: ["a", "b"] },
      { kind: "list", ordered: true, items: ["x", "y"] },
    ]);
  });

  it("keeps code fences verbatim and never treats their content as markup", () => {
    const blocks = parseDocBlocks("```\n<script>alert(1)</script>\n# not a heading\n```");
    expect(blocks).toEqual([{ kind: "code", text: "<script>alert(1)</script>\n# not a heading" }]);
  });

  it("parses a table", () => {
    const blocks = parseDocBlocks("| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |");
    expect(blocks).toEqual([{ kind: "table", header: ["A", "B"], rows: [["1", "2"], ["3", "4"]] }]);
  });

  it("clamps deep headings and always terminates on odd input", () => {
    expect(parseDocBlocks("##### deep")[0]).toEqual({ kind: "heading", level: 3, text: "deep" });
    expect(parseDocBlocks("|\n\n>\n").length).toBeGreaterThan(0);
  });
});
