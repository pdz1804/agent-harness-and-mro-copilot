/** Block-level markdown parser for knowledge-base documents. Produces a
 * plain data structure (no HTML); the renderer turns each block into React
 * elements and runs inline formatting through the safe inline tokenizer, so
 * nothing in a document can inject markup. Supported: headings, paragraphs,
 * block quotes, bullet/numbered lists, fenced code, tables (as text rows). */

export type DocBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function parseDocBlocks(source: string): DocBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: heading[2].trim() });
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") rows.push(splitRow(lines[i++]));
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ""));
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6}\s|>|```)/.test(lines[i]) &&
      !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])
    ) {
      para.push(lines[i++].trim());
    }
    if (para.length === 0) {
      // Unclassifiable line: consume it so the loop always advances.
      para.push(lines[i++].trim());
    }
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }

  return blocks;
}
