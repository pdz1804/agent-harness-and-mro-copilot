import { describe, expect, it } from "vitest";
import { driftLabel, driftTone } from "./labels";

describe("driftLabel", () => {
  it("uses the Stable / Watch / Drift band names", () => {
    expect(driftLabel("ok")).toBe("Stable");
    expect(driftLabel("warn")).toBe("Watch");
    expect(driftLabel("alert")).toBe("Drift");
    expect(driftLabel("insufficient_data")).toBe("Insufficient data");
    expect(driftTone("alert")).toBe("bad");
  });
});
