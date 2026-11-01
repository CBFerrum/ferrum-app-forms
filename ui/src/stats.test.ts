import { describe, expect, it } from "vitest";
import { answerText, dayStart, duration, npsGroup, percent, presetOf, presetRange, shiftDay, trendLine } from "./stats";

describe("the numbers of a form", () => {
  it("says how long it took", () => {
    expect(duration(null)).toBe("–");
    expect(duration("45")).toBe("45 s");
    expect(duration("125.4")).toBe("2 min 5 s");
    expect(duration(600)).toBe("10 min");
    expect(duration(3900)).toBe("1 h 5 min");
    expect(percent("33.33")).toBe("33.33%");
    expect(percent("50")).toBe("50%");
    expect(percent(null)).toBe("–");
  });

  it("counts days", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(presetRange("7", "2026-11-10")).toEqual(["2026-11-04", "2026-11-10"]);
    expect(presetRange("month", "2026-11-10")).toEqual(["2026-11-01", "2026-11-10"]);
    expect(presetRange("all", "2026-11-10")).toEqual([null, null]);
    expect(presetOf("2026-11-04", "2026-11-10", "2026-11-10")).toBe("7");
    expect(presetOf("2026-10-01", "2026-11-10", "2026-11-10")).toBeNull();
  });

  it("finds where a day starts in the workspace's zone", () => {
    expect(dayStart("2026-11-10", "UTC")).toBe("2026-11-10T00:00:00.000Z");
    expect(dayStart("2026-11-10", "Asia/Kolkata")).toBe("2026-11-09T18:30:00.000Z");
    expect(dayStart("2026-03-08", "America/New_York"), "midnight EST, a day that is 23 hours long").toBe("2026-03-08T05:00:00.000Z");
    expect(dayStart("2026-03-09", "America/New_York"), "midnight EDT").toBe("2026-03-09T04:00:00.000Z");
    expect(dayStart("2026-11-10", "Nowhere/Land")).toBe("2026-11-10T00:00:00.000Z");
  });

  it("sorts scores into promoters, passives and detractors", () => {
    expect([0, 6, 7, 8, 9, 10].map(npsGroup)).toEqual(["detractor", "detractor", "passive", "passive", "promoter", "promoter"]);
  });

  it("draws the days as a line", () => {
    const t = trendLine([{ date: "a", responses: 0 }, { date: "b", responses: 4 }, { date: "c", responses: 2 }], 100, 50, 10);
    expect(t.max).toBe(4);
    expect(t.dots.map((d) => [d.x, d.y])).toEqual([[10, 40], [50, 10], [90, 25]]);
    expect(t.line).toBe("M10.0 40.0 L50.0 10.0 L90.0 25.0");
    expect(t.area.endsWith("Z")).toBe(true);
    expect(trendLine([], 100, 50).line).toBe("");
    expect(trendLine([{ date: "a", responses: 3 }], 100, 50, 10).dots[0].x).toBe(50);
  });

  it("writes an answer as words", () => {
    expect(answerText("checkbox", true)).toBe("Yes");
    expect(answerText("multi_select", ["A", "B"])).toBe("A, B");
    expect(answerText("ranking", ["Y", "X"])).toBe("Y › X");
    expect(answerText("matrix", { Price: "Bad", Speed: "Good" }, ["Speed", "Price"])).toBe("Speed: Good; Price: Bad");
    expect(answerText("file", [{ file_name: "cv.pdf" }])).toBe("cv.pdf");
    expect(answerText("number", 42)).toBe("42");
    expect(answerText("short_text", null)).toBe("");
  });
});
