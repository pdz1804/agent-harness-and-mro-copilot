import { describe, expect, it } from "vitest";
import { approvalFields } from "./activity";

describe("approvalFields", () => {
  it("lists the key args in a fixed order and skips empties", () => {
    const f = approvalFields({ priority: "urgent", component_id: "AC-113-HYD_PUMP", task_ref: null, aircraft_id: "AC-113", notes: "x" });
    expect(f.map((x) => x.label)).toEqual(["Component", "Aircraft", "Priority"]);
    expect(f[0].value).toBe("AC-113-HYD_PUMP");
  });
  it("caps the list and tolerates missing args", () => {
    expect(approvalFields({ component_id: "a", aircraft_id: "b", task_ref: "c", priority: "d" }, 2)).toHaveLength(2);
    expect(approvalFields(null)).toEqual([]);
  });
});
