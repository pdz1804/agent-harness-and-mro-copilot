import { describe, expect, it } from "vitest";
import { AREAS, hrefFor, resolveRoute } from "./routes";

describe("information architecture", () => {
  it("has a small primary nav and no long flat list", () => {
    expect(AREAS.map((a) => a.label)).toEqual(["Overview", "Operate", "Model", "About"]);
    for (const area of AREAS) expect(area.pages.length).toBeLessThanOrEqual(5);
  });

  it("every area home resolves to a page inside that area", () => {
    for (const area of AREAS) {
      const r = resolveRoute(area.home.split("/"));
      expect(r.area.id).toBe(area.id);
      expect(r.page.id).toBe(area.home);
    }
  });

  it("only the copilot is a fill-viewport cockpit page", () => {
    const fills = AREAS.flatMap((a) => a.pages).filter((p) => p.fill);
    expect(fills.map((p) => p.id)).toEqual(["ops/copilot"]);
  });
});

describe("resolveRoute", () => {
  it("lands on the overview for an empty hash", () => {
    const r = resolveRoute([]);
    expect(r.page.id).toBe("overview");
    expect(r.known).toBe(true);
  });

  it("keeps the legacy about/overview link alive", () => {
    expect(resolveRoute(["about", "overview"]).page.id).toBe("overview");
  });

  it("falls back to the overview for unknown paths and flags them", () => {
    const r = resolveRoute(["nope", "nothing"]);
    expect(r.page.id).toBe("overview");
    expect(r.known).toBe(false);
  });

  it("passes trailing segments as params (alert deep link)", () => {
    const r = resolveRoute(["ops", "alerts", "12"]);
    expect(r.page.id).toBe("ops/alerts");
    expect(r.params).toEqual(["12"]);
  });

  it("resolves component and aircraft detail pages under Operate", () => {
    const c = resolveRoute(["ops", "component", "AC-113-HYD_PUMP"]);
    expect(c.detail).toBe("component");
    expect(c.area.id).toBe("ops");
    expect(c.params).toEqual(["AC-113-HYD_PUMP"]);
    const a = resolveRoute(["ops", "aircraft", "AC-113"]);
    expect(a.detail).toBe("aircraft");
  });

  it("decodes encoded segments and round-trips through hrefFor", () => {
    expect(hrefFor("ops/component/AC-1 2")).toBe("#/ops/component/AC-1%202");
    expect(resolveRoute(["ops", "component", "AC-1%202"]).params).toEqual(["AC-1 2"]);
  });

  it("keeps the aircraft index inside Fleet so the sub-nav stays at five", () => {
    const r = resolveRoute(["ops", "fleet", "aircraft"]);
    expect(r.page.id).toBe("ops/fleet");
    expect(r.params).toEqual(["aircraft"]);
    expect(r.detail).toBeNull();
  });
});
