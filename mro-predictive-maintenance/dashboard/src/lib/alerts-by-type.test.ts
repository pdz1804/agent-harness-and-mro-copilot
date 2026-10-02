import { describe, expect, it } from "vitest";
import { alertsByType } from "./alerts-by-type";
import type { Alert } from "../types";

const alert = (id: number, component_id: string, status: string, component_type?: string) =>
  ({ id, component_id, status, component_type }) as unknown as Alert;

describe("alertsByType", () => {
  it("counts active alerts per type, skips closed, keeps zero-count known types", () => {
    const rows = alertsByType(
      [
        alert(1, "AC-001-HYD_PUMP", "open", "HYD_PUMP"),
        alert(2, "AC-002-HYD_PUMP", "acknowledged", "HYD_PUMP"),
        alert(3, "AC-003-BLEED_VALVE", "open"),
        alert(4, "AC-004-BLEED_VALVE", "closed", "BLEED_VALVE"),
      ],
      ["APU_STARTER", "BLEED_VALVE", "HYD_PUMP"],
    );
    expect(rows).toEqual([
      { type: "HYD_PUMP", count: 2 },
      { type: "BLEED_VALVE", count: 1 },
      { type: "APU_STARTER", count: 0 },
    ]);
  });

  it("returns an empty list with no alerts and no known types", () => {
    expect(alertsByType([])).toEqual([]);
  });
});
