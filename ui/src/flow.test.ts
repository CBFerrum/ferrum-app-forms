import { describe, expect, it } from "vitest";
import { check, initial, normalize, pagesOf, payload, sentence, visibility, zonedNow, type Env } from "./flow";
import type { PForm, PQuestion } from "./model";

const env: Env = { today: "2026-10-29", now: "2026-10-29T10:00:00+05:30" };

function q(key: string, type: PQuestion["type"], more: Partial<PQuestion> = {}): PQuestion {
  return { key, type, label: key, ...more };
}

function form(questions: PQuestion[], more: Partial<PForm> = {}): PForm {
  return { slug: "f", title: "F", kind: "Form", access: "Public", anonymous: false, theme: {}, questions, ...more };
}

const value = (question: PQuestion, raw: unknown) => {
  const n = normalize(question, raw);
  return n.kind === "ok" ? n.value : n.kind === "error" ? `error: ${n.message}` : null;
};

describe("one answer, checked the way the server checks it", () => {
  it("trims text, counts characters and honours the pattern", () => {
    const t = q("a", "short_text", { min_length: 2, max_length: 5, pattern: "[a-z]+", pattern_message: "Letters only." });
    expect(value(t, "  abc ")).toBe("abc");
    expect(value(t, "a")).toMatch(/at least 2/);
    expect(value(t, "abcdef")).toMatch(/at most 5/);
    expect(value(t, "ab1")).toBe("error: Letters only.");
    expect(value(t, "   ")).toBeNull();
    expect(value(q("n", "short_text", { max_length: 3 }), "😀😀😀")).toBe("😀😀😀");
    expect(value(q("l", "long_text", { max_length: 100 }), "one\r\ntwo ")).toBe("one\ntwo");
  });

  it("reads addresses, phones and numbers", () => {
    expect(value(q("e", "email"), " Asha@Example.COM ")).toBe("asha@example.com");
    expect(value(q("e", "email"), "nope")).toMatch(/valid email/);
    expect(value(q("p", "phone"), "+91 98450 12345")).toBe("+91 98450 12345");
    expect(value(q("p", "phone"), "call me")).toMatch(/phone number/);
    const n = q("n", "number", { min: "1", max: "120" });
    expect(value(n, "42")).toBe(42);
    expect(value(n, "0")).toMatch(/at least 1/);
    expect(value(n, "4.5")).toMatch(/whole number/);
    const d = q("d", "decimal", { min: "0.5", max: "99.99" });
    expect(value(d, "12.50")).toBe(12.5);
    expect(value(d, "1,000")).toMatch(/at most 99.99/);
    expect(value(d, "abc")).toMatch(/Enter a number/);
  });

  it("reads dates and times", () => {
    const date = q("d", "date", { min: "2026-01-01" });
    expect(value(date, "2026-10-29")).toBe("2026-10-29");
    expect(value(date, "2025-12-31")).toMatch(/on or after/);
    expect(value(date, "2026-02-30")).toMatch(/Pick a date/);
    const time = q("t", "time", { min: "09:00", max: "17:30" });
    expect(value(time, "9:30")).toBe("09:30");
    expect(value(time, "17:31")).toMatch(/at or before/);
    expect(value(time, "25:00")).toMatch(/like 14:30/);
    expect(value(q("dt", "datetime"), "2026-10-29T10:00")).toBe("2026-10-29T10:00");
    expect(value(q("dt", "datetime"), "soon")).toMatch(/date and a time/);
  });

  it("reads choices", () => {
    const sel = q("s", "select", { options: ["Yes", "No"] });
    expect(value(sel, "No")).toBe("No");
    expect(value(sel, "Maybe")).toMatch(/Choose one/);
    expect(value(q("o", "dropdown", { options: ["Web"], allow_other: true }), "A friend")).toBe("A friend");
    const multi = q("m", "multi_select", { options: ["A", "B", "C"], min: "1", max: "2", allow_other: true });
    expect(value(multi, ["C", "A"])).toEqual(["A", "C"]);
    expect(value(multi, ["B", "Zed"])).toEqual(["B", "Zed"]);
    expect(value(multi, ["A", "B", "C"])).toMatch(/at most 2/);
    expect(value(multi, ["X", "Y"])).toMatch(/Choose from/);
    expect(value(q("c", "checkbox"), undefined)).toBe(false);
    expect(value(q("c", "checkbox"), true)).toBe(true);
    expect(value(q("r", "rating", { scale: 5 }), 6)).toMatch(/1 to 5/);
    expect(value(q("n", "nps"), "0")).toBe(0);
    expect(value(q("n", "nps"), 11)).toMatch(/0 to 10/);
  });

  it("reads grids, rankings and uploads", () => {
    const grid = q("g", "matrix", { columns: ["Bad", "Good"], rows: ["Speed", "Price"], required: true });
    expect(value(grid, { Speed: "Good", Price: "Bad" })).toEqual({ Speed: "Good", Price: "Bad" });
    expect(value(grid, { Speed: "Good" })).toMatch(/every row/);
    expect(value(grid, { Colour: "Good" })).toMatch(/columns/);
    expect(value(grid, { Speed: "" })).toBeNull();
    const rank = q("r", "ranking", { options: ["X", "Y", "Z"] });
    expect(value(rank, ["Z", "X", "Y"])).toEqual(["Z", "X", "Y"]);
    expect(value(rank, ["Z", "X"])).toMatch(/every option/);
    expect(value(rank, null)).toBeNull();
    const file = q("f", "file", { accept: ["pdf"], max_files: 1, max_file_mb: 1 });
    const pdf = new File(["%PDF-1.4"], "cv.pdf", { type: "application/pdf" });
    expect(value(file, [pdf])).toEqual([{ file_name: "cv.pdf", size: 8 }]);
    expect(value(file, [pdf, pdf])).toMatch(/one file/);
    expect(value(file, [new File(["MZ"], "run.exe")])).toMatch(/not accepted/);
    expect(value(file, [new File([new Uint8Array(2 * 1024 * 1024)], "big.pdf")])).toMatch(/larger than 1 MB/);
  });
});

describe("what is shown", () => {
  // The case of src/answers.rs `hidden_questions_are_not_required_and_their_answers_are_dropped`.
  const f = form([
    q("member", "checkbox"),
    q("member_id", "short_text", { required: true, max_length: 20, visible_if: "answers.member == true" }),
    q("p2", "page_break", { visible_if: "answers.member != true" }),
    q("why", "long_text", { required: true, max_length: 100 }),
    q("p3", "page_break"),
    q("rating", "rating", { required: true, scale: 5 }),
  ]);

  it("follows the order of the questions, a page break deciding its whole page", () => {
    expect(visibility(f, { member: true, member_id: "M-1" }, env)).toEqual([true, true, false, false, true, true]);
    expect(visibility(f, { member: false }, env)).toEqual([true, false, true, true, true, true]);
    expect(visibility(f, {}, env), "an unanswered checkbox is unchecked").toEqual([true, false, true, true, true, true]);
  });

  it("reads numbers as numbers and decimals as doubles", () => {
    const g = form([q("age", "number"), q("adult", "statement", { visible_if: "answers.age >= 18" }), q("amount", "decimal"), q("big", "statement", { visible_if: "answers.amount > 1000.0" })]);
    expect(visibility(g, { age: "20", amount: "1,500.5" }, env)).toEqual([true, true, true, true]);
    expect(visibility(g, { age: "17", amount: "999" }, env)).toEqual([true, false, true, false]);
    expect(visibility(g, {}, env), "an unanswered number is null: the comparison fails").toEqual([true, false, true, false]);
  });

  it("shows a question whose condition it cannot run, and one that does not read", () => {
    const g = form([q("a", "short_text", { max_length: 5 }), q("b", "statement", { visible_if: "timestamp(now) > timestamp('2020-01-01T00:00:00Z')" }), q("c", "statement", { visible_if: "answers.a ==" })]);
    expect(visibility(g, {}, env)).toEqual([true, true, true]);
  });

  it("does not let an invalid answer decide anything", () => {
    const g = form([q("age", "number", { min: "18" }), q("adult", "statement", { visible_if: "answers.age != null" })]);
    expect(visibility(g, { age: "12" }, env)).toEqual([true, false]);
  });

  it("falls on pages", () => {
    const shown = visibility(f, { member: false }, env);
    const pages = pagesOf(f, shown);
    expect(pages.map((p) => p.items)).toEqual([[0], [3], [5]]);
    expect(pages.map((p) => p.id)).toEqual(["start", "p2", "p3"]);
    const members = pagesOf(f, visibility(f, { member: true, member_id: "x" }, env));
    expect(members.map((p) => p.items), "page 2 is skipped for members").toEqual([[0, 1], [5]]);
  });

  it("can ask one question at a time", () => {
    const shown = visibility(f, { member: true }, env);
    expect(pagesOf(f, shown, "single").map((p) => p.items)).toEqual([[0], [1], [5]]);
    const titled = form([q("a", "short_text", { max_length: 5 }), q("p", "page_break", { label: "About you" }), q("b", "short_text", { max_length: 5 })]);
    expect(pagesOf(titled, [true, true, true]).map((p) => p.title)).toEqual([null, "About you"]);
  });

  it("checks a page: required, hidden and wrong answers", () => {
    const shown = visibility(f, { member: true }, env);
    const page = pagesOf(f, shown)[0];
    expect(check(f, page.items, { member: true })).toEqual({ member_id: "This question needs an answer." });
    expect(check(f, page.items, { member: true, member_id: "M-1" })).toEqual({});
    const must = form([q("agree", "checkbox", { required: true })]);
    expect(check(must, [0], {})).toEqual({ agree: "Please tick this box to continue." });
    expect(check(must, [0], { agree: true })).toEqual({});
  });
});

describe("what is sent", () => {
  it("sends the visible answers as checked, and uploads as data", async () => {
    const f = form([
      q("name", "short_text", { max_length: 20 }),
      q("skip", "short_text", { max_length: 20, visible_if: "answers.name == 'x'" }),
      q("agree", "checkbox"),
      q("n", "number"),
      q("cv", "file", { accept: ["txt"] }),
      q("notes", "long_text", { max_length: 10 }),
    ]);
    const shown = visibility(f, { name: "Asha", skip: "hidden" }, env);
    const sent = await payload(f, shown, { name: " Asha ", skip: "hidden", n: "42", cv: [new File(["hi"], "a.txt", { type: "text/plain" })] });
    expect(Object.keys(sent)).toEqual(["name", "agree", "n", "cv"]);
    expect(sent).toMatchObject({ name: "Asha", agree: false, n: 42 });
    const cv = (sent.cv as { file_name: string; content_base64: string }[])[0];
    expect(cv.file_name).toBe("a.txt");
    expect(cv.content_base64.startsWith("data:")).toBe(true);
    expect(cv.content_base64.endsWith("base64,aGk=")).toBe(true);
  });

  it("starts from defaults and what the link filled in", () => {
    const f = form([
      q("name", "short_text", { max_length: 5, default: "Guest" }),
      q("stars", "rating", { scale: 5, default: 4 }),
      q("pick", "multi_select", { options: ["A", "B"] }),
      q("when", "datetime", { default: "2026-10-29T04:30:00.000Z" }),
      q("yes", "checkbox", { default: true }),
    ]);
    const a = initial(f, { name: "Asha", pick: ["B"] }, "Asia/Kolkata");
    expect(a).toEqual({ name: "Asha", stars: 4, pick: ["B"], when: "2026-10-29T10:00", yes: true });
  });
});

describe("the server's words, as sentences", () => {
  it("turns reasons into sentences", () => {
    expect(sentence("is required")).toBe("This question needs an answer.");
    expect(sentence("must be at least 2 characters")).toBe("Must be at least 2 characters.");
    expect(sentence("Attach one file.")).toBe("Attach one file.");
  });
});

describe("the workspace's day", () => {
  it("reads today and now in a time zone", () => {
    const at = new Date("2026-10-29T20:00:00Z");
    expect(zonedNow("Asia/Kolkata", at)).toEqual({ today: "2026-10-30", now: "2026-10-30T01:30:00+05:30" });
    expect(zonedNow("America/New_York", at)).toEqual({ today: "2026-10-29", now: "2026-10-29T16:00:00-04:00" });
    expect(zonedNow("Nowhere/Land", at).today, "an unknown zone reads as UTC").toBe("2026-10-29");
  });
});
