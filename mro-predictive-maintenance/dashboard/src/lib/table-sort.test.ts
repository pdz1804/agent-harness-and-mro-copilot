import { describe, expect, it } from "vitest";
import { ariaSort, nextSort, shouldIgnoreRowClick, sortRows } from "./table-sort";

const rows = [
  { id: "b", n: 2 },
  { id: "a", n: 10 },
  { id: "c", n: null as number | null },
  { id: "d", n: 2 },
];

describe("sortRows", () => {
  it("sorts numbers ascending and descending", () => {
    expect(sortRows(rows, (r) => r.n, "asc").map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
    expect(sortRows(rows, (r) => r.n, "desc").map((r) => r.id)).toEqual(["a", "b", "d", "c"]);
  });

  it("keeps missing values last in both directions", () => {
    const asc = sortRows(rows, (r) => r.n, "asc");
    expect(asc[asc.length - 1].id).toBe("c");
    const desc = sortRows(rows, (r) => r.n, "desc");
    expect(desc[desc.length - 1].id).toBe("c");
  });

  it("is stable for equal keys", () => {
    expect(sortRows(rows, (r) => r.n, "asc").slice(0, 2).map((r) => r.id)).toEqual(["b", "d"]);
  });

  it("sorts ids naturally (AC-9 before AC-10)", () => {
    const ids = [{ id: "AC-10" }, { id: "AC-9" }, { id: "AC-100" }];
    expect(sortRows(ids, (r) => r.id, "asc").map((r) => r.id)).toEqual(["AC-9", "AC-10", "AC-100"]);
  });

  it("does not mutate the input", () => {
    const copy = [...rows];
    sortRows(rows, (r) => r.n, "desc");
    expect(rows).toEqual(copy);
  });
});

describe("nextSort / ariaSort", () => {
  it("starts a new column at its default direction", () => {
    expect(nextSort(null, "risk", "desc")).toEqual({ key: "risk", dir: "desc" });
    expect(nextSort({ key: "id", dir: "asc" }, "risk", "desc")).toEqual({ key: "risk", dir: "desc" });
  });
  it("flips the active column", () => {
    expect(nextSort({ key: "risk", dir: "desc" }, "risk", "desc")).toEqual({ key: "risk", dir: "asc" });
  });
  it("reports aria-sort", () => {
    expect(ariaSort({ key: "risk", dir: "desc" }, "risk")).toBe("descending");
    expect(ariaSort({ key: "risk", dir: "asc" }, "risk")).toBe("ascending");
    expect(ariaSort({ key: "risk", dir: "asc" }, "id")).toBe("none");
    expect(ariaSort(null, "id")).toBe("none");
  });
});

describe("shouldIgnoreRowClick", () => {
  const inside = (hit: boolean) => ({ closest: () => (hit ? {} : null) });
  it("ignores clicks that land on a control", () => {
    expect(shouldIgnoreRowClick(inside(true), "")).toBe(true);
  });
  it("lets a plain cell click through", () => {
    expect(shouldIgnoreRowClick(inside(false), "")).toBe(false);
    expect(shouldIgnoreRowClick(null, "")).toBe(false);
  });
  it("ignores a click that ended a text selection", () => {
    expect(shouldIgnoreRowClick(inside(false), "AC-113")).toBe(true);
  });
});
