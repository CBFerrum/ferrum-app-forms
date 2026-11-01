import { describe, expect, it } from "vitest";
import { ApiError } from "@ferrum/client";
import { blankRow, rowToDoc } from "./rows";
import { dirty, draftOf, type FormDoc, patchOf, refusal, refused } from "./formdoc";

const doc: FormDoc = {
  id: "f1",
  version: 4,
  status: "Draft",
  title: "Spring survey",
  kind: "Survey",
  slug: "spring",
  access: "Public",
  response_limit: 100,
  closes_at: "2026-12-01T10:00:00.000Z",
  notify_users: [{ id: "n1", email: "a@x.test" }],
  field_map: [{ id: "m1", target_field: "lead_name", question: "name", value: null }],
  questions: [
    { id: "q1", key: "name", label: "Name", question_type: "short_text", required: true, max_length: 80 },
    { id: "q2", key: "pick", label: "Pick", question_type: "select", options: ["A", "B"] },
  ],
};

describe("the form the builder edits", () => {
  it("starts as the saved form, and is not dirty", () => {
    const d = draftOf(doc);
    expect(d.fields).toMatchObject({ title: "Spring survey", kind: "Survey", layout: "Pages", response_limit: 100, notify_users: ["a@x.test"], field_map: [{ target_field: "lead_name", question: "name", value: "" }] });
    expect(d.rows.map((r) => [r.uid, r.key, r.id])).toEqual([["q1", "name", "q1"], ["q2", "pick", "q2"]]);
    expect(dirty(d, draftOf(doc))).toBe(false);
    expect(patchOf(d, draftOf(doc))).toEqual({});
  });

  it("sends only what changed", () => {
    const saved = draftOf(doc);
    const now = draftOf(doc);
    now.fields.title = "Spring survey 2";
    now.fields.description = "";
    now.fields.closes_at = null;
    now.fields.response_limit = null;
    now.fields.notify_users = ["a@x.test", "b@x.test"];
    expect(patchOf(saved, now)).toEqual({ title: "Spring survey 2", closes_at: null, response_limit: null, notify_users: [{ email: "a@x.test" }, { email: "b@x.test" }] });
    const rows = draftOf(doc);
    rows.rows[1] = { ...rows.rows[1], label: "Pick one" };
    const patch = patchOf(saved, rows);
    expect(Object.keys(patch)).toEqual(["questions"]);
    expect((patch.questions as { id?: string; label: string }[]).map((q) => [q.id, q.label])).toEqual([["q1", "Name"], ["q2", "Pick one"]]);
  });

  it("sends new questions without an id, in their place", () => {
    const saved = draftOf(doc);
    const now = draftOf(doc);
    now.rows.splice(1, 0, { ...blankRow("email", now.rows), label: "Email" });
    const q = (patchOf(saved, now).questions as { id?: string; question_type: string }[]).map((r) => [r.id, r.question_type]);
    expect(q).toEqual([["q1", "short_text"], [undefined, "email"], ["q2", "select"]]);
    expect(rowToDoc(now.rows[1]).id).toBeUndefined();
  });

  it("keeps the cards the same after a save", () => {
    const before = draftOf(doc);
    const after = draftOf({ ...doc, version: 5, questions: [...(doc.questions ?? []), { id: "q3", key: "x", label: "X", question_type: "short_text" }] }, [...before.rows, blankRow("short_text", before.rows)]);
    expect(after.rows[0].uid).toBe("q1");
    expect(after.rows).toHaveLength(3);
  });
});

describe("what the server refused", () => {
  it("puts each reason on its setting or its card", () => {
    const d = draftOf(doc);
    const e = new ApiError(422, "validation_failed", "Please check your input.", [
      { field: "options", message: "add at least one option", row: ["questions", 1] },
      { field: "slug", message: "is the address of another form" },
      { field: "email", message: "is not an active user of this workspace", row: ["notify_users", 0] },
      { field: "label", message: "is required", row: ["questions", 9] },
    ]);
    const r = refusal(e, d.rows);
    expect(r.cards.q2).toEqual([{ field: "options", message: "Add at least one option." }]);
    expect(r.fields.slug).toBe("Is the address of another form.");
    expect(r.fields.notify_users).toBe("Is not an active user of this workspace.");
    expect(r.other).toEqual(["This question needs an answer."]);
    expect(refused(r)).toBe(4);
  });
});
