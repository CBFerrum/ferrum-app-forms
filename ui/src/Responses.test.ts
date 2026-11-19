import { formatDate, formatDateTime } from "@ferrum/client";
import { describe, expect, it } from "vitest";
import { sentOn } from "./Responses";

describe("when a response came", () => {
  const at = "2026-11-19T05:00:00.000Z";
  it("shows only the day for an anonymous form, which keeps no more", () => {
    expect(sentOn(at, true)).toBe(formatDate(at));
    expect(sentOn(at, true)).not.toBe(formatDateTime(at));
  });
  it("shows the moment otherwise", () => {
    expect(sentOn(at, false)).toBe(formatDateTime(at));
    expect(sentOn(null, true)).toBe("–");
  });
});
