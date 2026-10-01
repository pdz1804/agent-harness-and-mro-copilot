import { describe, expect, it } from "vitest";
import { derivedEntries, searchPalette } from "./palette";

describe("palette", () => {
  it("lists actions before pages when empty", () => {
    const r = searchPalette("");
    expect(r[0].kind).toBe("action");
    expect(r.some((e) => e.path === "ops/alerts")).toBe(true);
  });
  it("opens ids typed directly", () => {
    expect(derivedEntries("12")[0].path).toBe("ops/alerts/12");
    expect(derivedEntries("#7")[0].path).toBe("ops/alerts/7");
    expect(derivedEntries("wo-2026-0007")[0].path).toBe("ops/work-orders/WO-2026-0007");
    expect(derivedEntries("ac-005-hyd_pump")[0].path).toBe("ops/component/AC-005-HYD_PUMP");
    expect(derivedEntries("AC-113")[0].path).toBe("ops/aircraft/AC-113");
  });
  it("offers ask-copilot for free text", () => {
    expect(derivedEntries("why is ac-005 risky").some((e) => e.action === "ask")).toBe(true);
    expect(derivedEntries("ab")).toEqual([]);
  });
  it("finds actions by keyword", () => {
    expect(searchPalette("scan")[0].action).toBe("scan");
  });
});
