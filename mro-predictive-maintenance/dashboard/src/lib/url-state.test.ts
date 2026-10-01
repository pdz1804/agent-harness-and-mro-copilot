import { describe, expect, it } from "vitest";
import { buildHash, buildQuery, formatSort, parseHash, parseSort, patchQuery, withPath } from "./url-state";

describe("url-state", () => {
  it("splits path and query", () => {
    expect(parseHash("#/ops/alerts/12?stage=open&q=pump")).toEqual({
      path: "ops/alerts/12",
      segments: ["ops", "alerts", "12"],
      query: { stage: "open", q: "pump" },
    });
  });
  it("handles an empty hash and a bare query", () => {
    expect(parseHash("")).toEqual({ path: "", segments: [], query: {} });
    expect(parseHash("#/ops/alerts?").query).toEqual({});
  });
  it("drops empty and default values and sorts keys", () => {
    expect(buildQuery({ stage: "all", q: "", z: "1", a: "2" }, { stage: "all" })).toBe("?a=2&z=1");
    expect(buildQuery({ stage: null })).toBe("");
  });
  it("encodes values round-trip", () => {
    const h = buildHash("ops/alerts", { q: "hyd pump & co" });
    expect(parseHash(h).query.q).toBe("hyd pump & co");
  });
  it("keeps list state when opening a sheet", () => {
    expect(withPath("#/ops/alerts?stage=open", "ops/alerts/7")).toBe("#/ops/alerts/7?stage=open");
  });
  it("patches the query", () => {
    expect(patchQuery("#/ops/work-orders?status=open&q=x", { q: null, sort: "age:desc" })).toBe(
      "#/ops/work-orders?sort=age%3Adesc&status=open",
    );
    expect(patchQuery("#/ops/alerts?stage=open", { stage: "all" }, { stage: "all" })).toBe("#/ops/alerts");
  });
  it("parses and formats sort", () => {
    expect(parseSort("risk:desc")).toEqual({ key: "risk", dir: "desc" });
    expect(parseSort("risk")).toBeNull();
    expect(parseSort("risk:up")).toBeNull();
    expect(formatSort({ key: "age", dir: "asc" })).toBe("age:asc");
    expect(formatSort(null)).toBeNull();
  });
});
