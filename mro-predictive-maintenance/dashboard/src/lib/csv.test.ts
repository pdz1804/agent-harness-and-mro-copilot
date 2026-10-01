import { describe, expect, it } from "vitest";
import { csvCell, workOrdersCsv } from "./csv";
import type { WorkOrder } from "../types";

describe("csvCell", () => {
  it("quotes commas, quotes and newlines; blanks nulls", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(0)).toBe("0");
  });
});

describe("workOrdersCsv", () => {
  it("exports every work order with its outcome and approver", () => {
    const wo: WorkOrder = {
      id: "WO-2026-0001",
      aircraft_id: "AC-113",
      component_id: "AC-113-HYD_PUMP",
      alert_id: 8,
      task_ref: "AMM-29-11-00",
      priority: "urgent",
      status: "closed",
      created_by: "copilot",
      approved_by: "lead.engineer",
      created_at: "2026-10-01T10:00:00+00:00",
      closed_at: "2026-10-01T12:00:00+00:00",
      outcome: "confirmed_failure",
      notes: "Seal worn, replaced",
    };
    const lines = workOrdersCsv([wo]).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].split(",")[0]).toBe("id");
    expect(lines[1]).toContain("WO-2026-0001,closed,confirmed_failure,urgent");
    expect(lines[1]).toContain('"Seal worn, replaced"');
  });
});
