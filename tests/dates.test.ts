import { describe, expect, it } from "vitest";
import { addDays, fromPartitionKey, toIsoDate, toPartitionKey } from "../src/util/dates.js";

describe("dates", () => {
  it("accepts YYYY-MM-DD and a Date's local day", () => {
    expect(toIsoDate("2026-02-28")).toBe("2026-02-28");
    expect(toIsoDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it.each(["2026-13-01", "2026-02-30", "2026-2-1", "yesterday"])("rejects %s", (value) => {
    expect(() => toIsoDate(value)).toThrow(/Invalid date/);
  });

  it("converts to and from partition keys", () => {
    expect(toPartitionKey("2026-09-08")).toBe("20260908");
    expect(fromPartitionKey(20260908)).toBe("2026-09-08");
    expect(fromPartitionKey(null)).toBe("");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});
