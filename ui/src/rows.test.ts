import { describe, expect, it } from "vitest";
import { blankRow, changeKind, copyRow, deriveKey, earlier, alwaysShown, lines, move, nameFromLabel, problems, readers, renameKey, rowFromDoc, rowToDoc, toPublic, type QRow } from "./rows";
import { visibility } from "./flow";
import { complete, fromCel, needsValue, opsFor, toCel, type Condition, type Rule } from "./rules";
import type { Kind } from "./model";

const row = (key: string, kind: Kind, more: Partial<QRow> = {}): QRow => ({ ...blankRow(kind, []), key, label: key, keyAuto: false, ...more });
const env = { today: "2026-10-29", now: "2026-10-29T10:00:00+05:30" };

describe("a question's key", () => {
  it("is made from its label, as the server makes it (src/form.rs)", () => {
    expect(deriveKey("Your e-mail address", 0, [])).toBe("your_e_mail_address");
    expect(deriveKey("2026 budget", 3, [])).toBe("q_2026_budget");
    expect(deriveKey("", 3, [])).toBe("q4");
    expect(deriveKey("Name", 0, ["name", "name_2"])).toBe("name_3");
    expect(deriveKey("A".repeat(60), 0, []).length).toBeLessThanOrEqual(34);
  });

  it("follows the label of a new question until it is saved, and what reads it follows", () => {
    const first = blankRow("short_text", []);
    let rows = [first, blankRow("select", [first])];
    rows[0] = { ...rows[0], label: "Your name" };
    rows = nameFromLabel(rows, 0);
    expect(rows[0].key).toBe("your_name");
    rows[1] = { ...rows[1], label: "Pick one", visible_if: "answers.your_name != null", keyAuto: true };
    rows[0] = { ...rows[0], label: "Full name" };
    rows = nameFromLabel(rows, 0);
    expect(rows.map((r) => r.key)).toEqual(["full_name", rows[1].key]);
    expect(rows[1].visible_if).toBe("answers.full_name != null");
    const saved = { ...rows[0], id: "r1", label: "Something else" };
    expect(nameFromLabel([saved], 0)[0].key, "a saved question keeps its key").toBe("full_name");
  });

  it("is renamed in conditions that read it", () => {
    const rows = [row("a", "short_text"), row("b", "short_text", { visible_if: "answers.a == 'x' && answers['a'] != 'y' && answers.ab == 1" })];
    expect(renameKey(rows, "a", "z")[1].visible_if).toBe("answers.z == 'x' && answers['z'] != 'y' && answers.ab == 1");
  });
});

describe("the questions of a form", () => {
  it("start with something that works", () => {
    expect(blankRow("select", []).options).toHaveLength(3);
    expect(blankRow("matrix", []).matrix_rows.length).toBeGreaterThan(0);
    expect(blankRow("rating", []).max_value).toBe("5");
    expect(blankRow("page_break", [blankRow("short_text", [])]).key).toBe("page");
  });

  it("go to the server whole, and come back the same", () => {
    const r = row("colour", "multi_select", { options: ["Red", "Blue"], allow_other: true, min_value: "1", max_value: "2", help_text: "Any" });
    const doc = rowToDoc({ ...r, id: "abc" });
    expect(doc).toMatchObject({ id: "abc", key: "colour", question_type: "multi_select", options: ["Red", "Blue"], allow_other: true, min_value: "1", pattern: null, visible_if: null });
    expect(rowToDoc(rowFromDoc(doc))).toEqual(doc);
    expect(rowFromDoc({ key: "x", label: "X", question_type: "select", options: "A\nB\n", points: "2" }).options).toEqual(["A", "B"]);
    expect(rowToDoc(row("t", "short_text", { options: ["left over"] })).options, "only types with options send them").toBeNull();
  });

  it("move, copy and change type", () => {
    expect(move([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(move([1, 2, 3], 1, 1)).toEqual([1, 2, 3]);
    expect(move([1, 2, 3], 0, 5)).toEqual([1, 2, 3]);
    const rows = [row("name", "short_text", { id: "x1" })];
    const copy = copyRow(rows, 0);
    expect([copy.key, copy.id, copy.uid === rows[0].uid]).toEqual(["name_2", undefined, false]);
    const sel = row("pick", "select", { options: ["A", "B"], allow_other: true, required: true });
    expect(changeKind(sel, "dropdown")).toMatchObject({ options: ["A", "B"], allow_other: true, required: true });
    expect(changeKind(sel, "short_text")).toMatchObject({ options: [], allow_other: false, required: true });
    expect(changeKind(sel, "statement").required).toBe(false);
    expect(changeKind(row("t", "short_text"), "rating").max_value).toBe("5");
  });

  it("know what reads an answer, and what a question may read", () => {
    const rows = [row("a", "short_text"), row("b", "short_text", { visible_if: "answers.a == 'x'" }), row("p", "page_break", { visible_if: "answers.b != null" }), row("c", "short_text")];
    expect(readers(rows, "a")).toEqual([1]);
    expect(readers(rows, "b")).toEqual([2]);
    expect(earlier(rows, 3).map((r) => r.key)).toEqual(["a", "b"]);
    expect(alwaysShown(rows, "a")).toBe(true);
    expect(alwaysShown(rows, "b")).toBe(false);
    expect(alwaysShown(rows, "c"), "the page it is on is conditional").toBe(false);
  });
});

describe("what is wrong, said before the server says it", () => {
  const say = (rows: QRow[]) => problems(rows).map((p) => p.map((x) => x.field));

  it("finds every mistake on its own card (the cases of src/model.rs)", () => {
    const rows = [
      row("a", "select", { options: [], label: "" }),
      row("a", "short_text", { max_length: 5, min_length: 9 }),
      row("Bad Key", "number", { min_value: "10", max_value: "1" }),
      row("c", "matrix", { options: ["x", "x"], matrix_rows: [] }),
      row("d", "dropdown", { options: ["x"], visible_if: "answers.e == 1" }),
      row("e", "rating", { max_value: "11" }),
      row("f", "file", { accept: "exe", max_value: "11" }),
      row("g", "multi_select", { options: ["x"], min_value: "3" }),
    ];
    const found = say(rows);
    expect(found[0]).toEqual(["label", "options"]);
    expect(found[1]).toEqual(expect.arrayContaining(["key", "min_length"]));
    expect(found[2]).toEqual(expect.arrayContaining(["key", "min_value"]));
    expect(found[3]).toEqual(expect.arrayContaining(["options", "matrix_rows"]));
    expect(found[4]).toEqual(["visible_if"]);
    expect(found[5]).toEqual(["max_value"]);
    expect(found[6]).toEqual(expect.arrayContaining(["accept", "max_value"]));
    expect(found[7]).toEqual(["min_value"]);
  });

  it("is quiet about a form that is fine", () => {
    const rows = [row("a", "short_text"), row("b", "select", { options: ["x", "y"], visible_if: "answers.a == 'q'" }), row("p", "page_break"), row("t", "statement", { label: "", help_text: "Read" })];
    expect(say(rows)).toEqual([[], [], [], []]);
  });
});

describe("the preview is the form respondents get", () => {
  it("has what the server's public definition has", () => {
    const rows = [
      row("name", "short_text", { required: true, help_text: " Full name ", max_length: 80, pattern: "[A-Za-z ]+", pattern_message: "Letters." }),
      row("agree", "likert"),
      row("grid", "matrix", { options: ["Bad", "Good"], matrix_rows: ["Speed"] }),
      row("cv", "file", { accept: ".pdf, png", max_value: "2", max_file_mb: 5 }),
      row("stars", "rating", { max_value: "7" }),
      row("age", "number", { min_value: "18" }),
      row("note", "statement", { label: "Read", required: true }),
    ];
    const f = toPublic({ title: "T", description: " ", kind: "Survey", access: "Public", anonymous: false, closes_at: null, accent_color: "#112233", logo: null, layout: "One question at a time" }, rows);
    expect(f).toMatchObject({ title: "T", description: null, layout: "single", theme: { accent_color: "#112233" } });
    const [name, agree, grid, cv, stars, age, note] = f.questions;
    expect(name).toMatchObject({ required: true, help_text: "Full name", max_length: 80, pattern: "[A-Za-z ]+", pattern_message: "Letters." });
    expect(agree.options).toHaveLength(5);
    expect(grid).toMatchObject({ columns: ["Bad", "Good"], rows: ["Speed"] });
    expect(cv).toMatchObject({ accept: ["pdf", "png"], max_files: 2, max_file_mb: 5 });
    expect(stars.scale).toBe(7);
    expect(age.min).toBe("18");
    expect(note.required).toBeUndefined();
  });
});

describe("a condition written as rules", () => {
  const rows = [
    row("age", "number"),
    row("country", "select", { options: ["IN", "US"] }),
    row("colours", "multi_select", { options: ["red", "blue"] }),
    row("agree", "checkbox"),
    row("grid", "matrix", { options: ["Bad", "Good"], matrix_rows: ["Speed"] }),
    row("rank", "ranking", { options: ["X", "Y"] }),
    row("born", "date"),
    row("note", "long_text"),
  ];
  const rule = (key: string, op: Rule["op"], value = "", more: Partial<Rule> = {}): Rule => ({ key, op, value, ...more });
  const each: [Rule, string][] = [
    [rule("age", "gte", "18"), "answers.age >= 18"],
    [rule("age", "eq", "7"), "answers.age == 7"],
    [rule("country", "is", "IN"), "answers.country == 'IN'"],
    [rule("country", "is_not", "it's"), "answers.country != 'it\\'s'"],
    [rule("colours", "includes", "red"), "'red' in answers.colours"],
    [rule("colours", "excludes", "red"), "(answers.colours == null || !('red' in answers.colours))"],
    [rule("agree", "checked"), "answers.agree == true"],
    [rule("agree", "unchecked"), "answers.agree != true"],
    [rule("grid", "cell", "Bad", { row: "Speed" }), "answers.grid['Speed'] == 'Bad'"],
    [rule("rank", "first", "X"), "answers.rank[0] == 'X'"],
    [rule("born", "gt", "2000-01-01"), "answers.born > '2000-01-01'"],
    [rule("note", "contains", "urgent"), "answers.note.contains('urgent')"],
    [rule("note", "answered"), "answers.note != null"],
    [rule("note", "empty"), "answers.note == null"],
  ];

  it("writes CEL, and reads its own CEL back", () => {
    for (const [r, cel] of each) {
      expect(toCel({ join: "all", rules: [r] }, rows), cel).toBe(cel);
      expect(fromCel(cel, rows), cel).toEqual({ join: "all", rules: [r] });
    }
  });

  it("joins rules by all or any", () => {
    const all: Condition = { join: "all", rules: [rule("age", "gte", "18"), rule("country", "is", "IN"), rule("colours", "excludes", "red")] };
    expect(toCel(all, rows)).toBe("answers.age >= 18 && answers.country == 'IN' && (answers.colours == null || !('red' in answers.colours))");
    expect(fromCel(toCel(all, rows), rows)).toEqual(all);
    const any: Condition = { join: "any", rules: [rule("age", "lt", "18"), rule("colours", "excludes", "red")] };
    expect(fromCel(toCel(any, rows), rows)).toEqual(any);
    expect(toCel({ join: "all", rules: [] }, rows)).toBe("");
    expect(fromCel("", rows)).toEqual({ join: "all", rules: [] });
  });

  it("leaves other conditions as CEL", () => {
    expect(fromCel("answers.age >= 18 || answers.age < 5 && answers.country == 'IN'", rows)).toBeNull();
    expect(fromCel("size(answers.colours) > 1", rows)).toBeNull();
    expect(fromCel("answers.age +", rows)).toBeNull();
    expect(fromCel("answers.age > answers.age", rows)).toBeNull();
  });

  it("leaves out a rule that is not finished", () => {
    expect(complete(rule("age", "gte", ""), "number")).toBe(false);
    expect(complete(rule("age", "gte", "x"), "number")).toBe(false);
    expect(complete(rule("note", "answered"), "long_text")).toBe(true);
    expect(complete(rule("grid", "cell", "Bad"), "matrix")).toBe(false);
    expect(toCel({ join: "all", rules: [rule("age", "gte", ""), rule("country", "is", "IN")] }, rows)).toBe("answers.country == 'IN'");
    expect(needsValue("answered")).toBe(false);
    expect(opsFor("checkbox")).toEqual(["checked", "unchecked"]);
  });

  it("shows and hides questions the way the rules say", () => {
    const form = {
      slug: "f",
      title: "F",
      kind: "Form" as const,
      access: "Public" as const,
      anonymous: false,
      theme: {},
      questions: [
        ...toPublic({ title: "F", description: "", kind: "Form", access: "Public", anonymous: false, closes_at: null, accent_color: null, logo: null, layout: "Pages" }, rows).questions,
        { key: "shown", type: "statement" as const, label: "Shown", visible_if: toCel({ join: "all", rules: [rule("age", "gte", "18"), rule("colours", "excludes", "red"), rule("grid", "cell", "Bad", { row: "Speed" })] }, rows) },
      ],
    };
    const at = form.questions.length - 1;
    expect(visibility(form, { age: "20", colours: ["blue"], grid: { Speed: "Bad" } }, env)[at]).toBe(true);
    expect(visibility(form, { age: "20", colours: ["red"], grid: { Speed: "Bad" } }, env)[at]).toBe(false);
    expect(visibility(form, { age: "17", colours: [], grid: { Speed: "Bad" } }, env)[at]).toBe(false);
    expect(visibility(form, { age: "20" }, env)[at], "a grid nobody answered").toBe(false);
  });
});

describe("lines of text", () => {
  it("drops blanks and trims", () => {
    expect(lines(" a \r\n\n b\n")).toEqual(["a", "b"]);
  });
});

import { TEMPLATES } from "./templates";

describe("the starting points", () => {
  it("are finished forms: nothing in them for the server to refuse", () => {
    for (const t of TEMPLATES) {
      const rows = t.rows();
      expect(problems(rows).flat(), t.name).toEqual([]);
      expect(new Set(rows.map((r) => r.key)).size, t.name).toBe(rows.length);
    }
    expect(TEMPLATES.find((t) => t.id === "quiz")?.rows().every((r) => r.correct_answer !== null)).toBe(true);
  });
});
