import { describe, expect, it } from "vitest";
import { isGroupOpen, navStorageKey, parseCollapsed, serializeCollapsed, toggleGroup } from "./nav-groups";

describe("nav-groups", () => {
  it("keys storage per user", () => {
    expect(navStorageKey("planner")).not.toBe(navStorageKey("viewer"));
  });
  it("parses tolerant of junk", () => {
    expect([...parseCollapsed(null)]).toEqual([]);
    expect([...parseCollapsed("{bad")]).toEqual([]);
    expect([...parseCollapsed('{"a":1}')]).toEqual([]);
    expect([...parseCollapsed('["model",3,"about"]')]).toEqual(["model", "about"]);
  });
  it("round-trips sorted", () => {
    expect(serializeCollapsed(new Set(["model", "about"]))).toBe('["about","model"]');
  });
  it("keeps the active group open even if stored collapsed", () => {
    const c = new Set(["ops", "model"]);
    expect(isGroupOpen("ops", "ops", c)).toBe(true);
    expect(isGroupOpen("model", "ops", c)).toBe(false);
    expect(isGroupOpen("about", "ops", c)).toBe(true);
  });
  it("toggles but never folds the active group", () => {
    expect([...toggleGroup("model", "ops", new Set())]).toEqual(["model"]);
    expect([...toggleGroup("model", "ops", new Set(["model"]))]).toEqual([]);
    expect([...toggleGroup("ops", "ops", new Set())]).toEqual([]);
  });
});
