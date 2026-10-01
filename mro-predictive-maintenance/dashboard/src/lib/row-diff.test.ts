import { describe, expect, it } from "vitest";
import { changedKeys, matchesQuery, signatureMap, withOverrides } from "./row-diff";

type R = { id: string; status: string };
const key = (r: R) => r.id;
const sig = (r: R) => r.status;

describe("row-diff", () => {
  it("flashes nothing on first load", () => {
    expect(changedKeys(null, [{ id: "a", status: "open" }], key, sig).size).toBe(0);
  });
  it("detects changed and new rows", () => {
    const prev = signatureMap<R>([{ id: "a", status: "open" }, { id: "b", status: "open" }], key, sig);
    const next: R[] = [{ id: "a", status: "acknowledged" }, { id: "b", status: "open" }, { id: "c", status: "open" }];
    expect([...changedKeys(prev, next, key, sig)].sort()).toEqual(["a", "c"]);
  });
  it("applies optimistic overrides immutably", () => {
    const rows: R[] = [{ id: "a", status: "open" }];
    const out = withOverrides(rows, key, new Map([["a", "acknowledged"]]));
    expect(out[0].status).toBe("acknowledged");
    expect(rows[0].status).toBe("open");
    expect(withOverrides(rows, key, new Map())).toBe(rows);
  });
  it("matches every word across fields", () => {
    expect(matchesQuery(["AC-005-HYD_PUMP", "AC-005", 12], "hyd 005")).toBe(true);
    expect(matchesQuery(["AC-005-HYD_PUMP"], "fan")).toBe(false);
    expect(matchesQuery(["x", null], "  ")).toBe(true);
  });
});
