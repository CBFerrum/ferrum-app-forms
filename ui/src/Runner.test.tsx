// A smoke test: the form draws every question type on its first page, and the pages and states
// around it draw too. (Behaviour is tested in flow.test.ts; this catches a control that throws.)

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Thanks } from "./Done";
import { Runner } from "./Runner";
import type { PForm, PQuestion } from "./model";

const q = (key: string, type: PQuestion["type"], more: Partial<PQuestion> = {}): PQuestion => ({ key, type, label: `Label of ${key}`, ...more });

const form: PForm = {
  slug: "all",
  title: "Everything",
  description: "A form with every question type.",
  kind: "Survey",
  access: "Public",
  anonymous: true,
  closes_at: "2026-12-31T10:00:00.000Z",
  theme: { accent_color: "#30a67d", logo: "https://example.com/logo.png" },
  questions: [
    q("name", "short_text", { required: true, max_length: 80, help_text: "As on your passport." }),
    q("story", "long_text", { max_length: 1000 }),
    q("mail", "email", { required: true }),
    q("tel", "phone"),
    q("age", "number", { min: "1", max: "120" }),
    q("amount", "decimal"),
    q("born", "date", { min: "1900-01-01" }),
    q("at", "time"),
    q("when", "datetime"),
    q("pick", "select", { options: ["Red", "Blue"], allow_other: true }),
    q("many", "multi_select", { options: ["A", "B"], allow_other: true, min: "1", max: "2" }),
    q("agree", "checkbox", { required: true }),
    q("drop", "dropdown", { options: ["One", "Two"], allow_other: true }),
    q("stars", "rating", { scale: 5 }),
    q("nps", "nps"),
    q("likert", "likert", { options: ["No", "Yes"] }),
    q("grid", "matrix", { columns: ["Bad", "Good"], rows: ["Speed", "Price"] }),
    q("rank", "ranking", { options: ["X", "Y", "Z"] }),
    q("cv", "file", { accept: ["pdf"], max_files: 2, max_file_mb: 5 }),
    q("note", "statement", { help_text: "Read this." }),
    q("p2", "page_break", { label: "Second page" }),
    q("last", "short_text", { max_length: 10 }),
  ],
};

const send = async () => ({ status: "received" as const, message: "Thanks!", redirect_url: null, replayed: false });
const html = (f: PForm, over: Partial<Parameters<typeof Runner>[0]> = {}) => renderToStaticMarkup(<Runner form={f} zone="Asia/Kolkata" workspace="Acme" send={send} {...over} />);

describe("the form a respondent fills in", () => {
  it("draws its first page with every kind of question", () => {
    const out = html(form);
    expect(out).toContain("Everything");
    expect(out).toContain("Your response is anonymous.");
    expect(out).toContain("Page 1 of 2");
    expect(out).toContain("As on your passport.");
    for (const label of ["name", "story", "mail", "tel", "age", "born", "pick", "many", "agree", "drop", "stars", "nps", "likert", "grid", "rank", "cv"]) expect(out, label).toContain(`Label of ${label}`);
    expect(out).toContain("Collected for Acme.");
    expect(out).not.toContain("Label of last");
    expect(out).toContain(">Next<");
    expect(out).toContain("--primary");
  });

  it("asks one question at a time when the form says so", () => {
    const out = html({ ...form, layout: "single" });
    expect(out).toContain("Question 1 of");
    expect(out).toContain("Label of name");
    expect(out).not.toContain("Label of story");
  });

  it("previews without keeping or sending", () => {
    const out = html(form, { preview: true });
    expect(out).toContain("Nothing you answer here is sent or kept.");
    expect(out).not.toContain("Collected for Acme.");
  });

  it("draws a form that is only one page with a Send", () => {
    const out = html({ ...form, questions: form.questions.slice(0, 3) });
    expect(out).toContain(">Send<");
    expect(out).not.toContain("Page 1 of");
  });

  it("thanks them, with a quiz's result", () => {
    const out = renderToStaticMarkup(
      <Thanks
        form={form}
        resultLink="/forms/f/acme/all/result/abc"
        receipt={{
          status: "received",
          message: "Thank you! Your response was recorded.",
          redirect_url: null,
          replayed: false,
          number: "RESP-2026-000001",
          result: { score: "3", max_score: "4.5", percent: "66.67", passed: true, questions: [{ key: "a", label: "Capital of France?", points: "2", earned: "0", correct: false, correct_answer: ["paris"] }] },
          result_token: "abc",
        }}
      />,
    );
    expect(out).toContain("Your response was recorded.");
    expect(out).toContain("RESP-2026-000001");
    expect(out).toContain("66.67%");
    expect(out).toContain("Passed");
    expect(out).toContain("Right answer: paris");
    expect(out).toContain("Copy a link to this result");
  });
});
