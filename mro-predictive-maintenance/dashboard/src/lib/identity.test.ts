import { describe, expect, it } from "vitest";
import { canWrite, isRoleLockReason, readOnlyReason } from "./identity";

describe("canWrite", () => {
  it("blocks the seeded viewer", () => {
    expect(canWrite("viewer")).toBe(false);
  });

  it("allows engineers and unknown actors (backend default role is engineer)", () => {
    expect(canWrite("lead.engineer")).toBe(true);
    expect(canWrite("planner")).toBe(true);
    expect(canWrite("someone.else")).toBe(true);
  });
});

describe("readOnlyReason", () => {
  it("names who can do the action", () => {
    expect(readOnlyReason("acknowledge")).toBe("Viewer is read-only. lead.engineer or planner can acknowledge.");
  });
});

describe("isRoleLockReason", () => {
  it("recognises role reasons so disabled buttons show a lock", () => {
    expect(isRoleLockReason(readOnlyReason("acknowledge"))).toBe(true);
    expect(isRoleLockReason("Only lead.engineer can start a retrain")).toBe(true);
  });
  it("ignores state reasons and missing titles", () => {
    expect(isRoleLockReason("Nothing to export in this view.")).toBe(false);
    expect(isRoleLockReason(undefined)).toBe(false);
  });
});
