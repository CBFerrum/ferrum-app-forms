// Smoke tests of the builder's and the results' screens: each draws, for every kind of question,
// without throwing. (Behaviour is in rows.test.ts, rules and formdoc.test.ts; this catches a control
// that fails to draw.)

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionCard, Trend } from "./Charts";
import { Questions, TypeList } from "./Cards";
import { Logic } from "./Logic";
import { Settings } from "./Settings";
import { Share } from "./Share";
import { blankRow, type QRow } from "./rows";
import { fieldsOf } from "./formdoc";
import { KINDS, type Kind } from "./model";
import type { QSummary } from "./stats";

afterEach(() => vi.unstubAllGlobals());

const row = (kind: Kind, more: Partial<QRow> = {}): QRow => ({ ...blankRow(kind, []), label: `A ${kind}`, ...more });
const all = KINDS.map((k, i) => ({ ...row(k.kind, { key: `q${i}` }) }));
const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>{node}</MemoryRouter>
  </QueryClientProvider>
);

describe("the builder", () => {
  it("draws every card, closed and open", () => {
    const html = (open: string | null, rows = all) => renderToStaticMarkup(wrap(<Questions rows={rows} onChange={() => {}} quiz={false} open={open} onOpen={() => {}} server={{}} showProblems usedElsewhere={() => []} />));
    const closed = html(null);
    expect(closed).toContain("A short_text");
    expect(closed).toContain("Page 2");
    for (const r of all) expect(html(r.uid), r.question_type).toContain(`A ${r.question_type}`);
    const of = (k: Kind) => all.find((r) => r.question_type === k) as QRow;
    expect(html(of("select").uid)).toContain("Options");
    expect(html(of("page_break").uid)).toContain("Title of page 2");
  });

  it("draws a quiz question's right answer for every type that can be marked", () => {
    for (const k of ["select", "multi_select", "short_text", "number", "checkbox", "ranking", "date", "likert", "dropdown", "decimal"] as Kind[]) {
      const r = row(k, { options: ["A", "B"], correct_answer: null });
      const out = renderToStaticMarkup(wrap(<Questions rows={[r]} onChange={() => {}} quiz open={r.uid} onOpen={() => {}} server={{}} showProblems={false} usedElsewhere={() => []} />));
      expect(out, k).toContain("The right answer");
    }
  });

  it("draws the empty form with the list of types, and the problems the server found", () => {
    const empty = renderToStaticMarkup(wrap(<Questions rows={[]} onChange={() => {}} quiz={false} open={null} onOpen={() => {}} server={{}} showProblems={false} usedElsewhere={() => []} />));
    expect(empty).toContain("What do you want to ask?");
    expect(renderToStaticMarkup(<TypeList onPick={() => {}} />)).toContain("File upload");
    const r = row("select", { options: [] });
    const out = renderToStaticMarkup(wrap(<Questions rows={[r]} onChange={() => {}} quiz={false} open={r.uid} onOpen={() => {}} server={{ [r.uid]: [{ field: "options", message: "Add at least one option." }] }} showProblems usedElsewhere={() => []} />));
    expect(out).toContain("Add at least one option.");
  });

  it("draws the rules of a condition, and the CEL of one rules cannot say", () => {
    const rows = [row("number", { key: "age", label: "Age" }), row("select", { key: "pick", label: "Pick", options: ["A", "B"] }), row("short_text", { key: "why", label: "Why", visible_if: "answers.age >= 18 && answers.pick == 'A'" })];
    const rules = renderToStaticMarkup(<Logic rows={rows} index={2} onChange={() => {}} />);
    expect(rules).toContain("all of these");
    expect(rules).toContain("Add a rule");
    expect(rules).toContain("Age is at least");
    const cel = renderToStaticMarkup(<Logic rows={[rows[0], { ...rows[2], visible_if: "size(answers.age) > 1" }]} index={1} onChange={() => {}} />);
    expect(cel).toContain("Condition in CEL");
    expect(renderToStaticMarkup(<Logic rows={[rows[0]]} index={0} onChange={() => {}} />)).toContain("Needs a question before it.");
  });

  it("draws the settings and the share panel", () => {
    vi.stubGlobal("window", { location: { origin: "https://acme.test" } });
    const fields = fieldsOf({ id: "f", version: 1, title: "T", kind: "Quiz", slug: "t", access: "Internal", closes_at: "2026-12-01T10:00:00.000Z", response_limit: 5, field_map: [{ target_field: "x", question: "", value: "v" }], target_entity: "Lead" });
    const settings = renderToStaticMarkup(wrap(<Settings fields={fields} set={() => {}} rows={all} formId="f" errors={{ closes_at: "Must be after the opening time." }} />));
    for (const text of ["Who can answer", "After someone answers", "Marking", "Must be after the opening time."]) expect(settings, text).toContain(text);
    const rows = [row("short_text", { key: "name", allow_prefill: true })];
    const share = renderToStaticMarkup(<Share fields={fields} set={() => {}} rows={rows} status="Published" savedSlug="t" errors={{}} dirty={false} onPublish={() => {}} onSettings={() => {}} publishing={false} />);
    expect(share).toContain("https://acme.test/forms/f//t");
    expect(share).toContain("?name=");
    const draft = renderToStaticMarkup(<Share fields={fields} set={() => {}} rows={rows} status="Draft" savedSlug="t" errors={{}} dirty onPublish={() => {}} onSettings={() => {}} publishing={false} />);
    expect(draft).toContain("Publish and save");
  });
});

describe("the results", () => {
  const dist = (n: number, lo = 0) => Array.from({ length: n }, (_, i) => ({ value: lo + i, count: i, percent: String(i * 10) }));
  const q = (type: Kind, more: Partial<QSummary>): QSummary => ({ key: "k", label: `About ${type}`, type, answered: 7, skipped: 1, ...more });

  it("draws a card for every kind of answer", () => {
    const cards: QSummary[] = [
      q("select", { options: [{ option: "A", count: 4, percent: "57.14" }, { option: "B", count: 3, percent: "42.86" }], other: { count: 1, percent: "12.5" } }),
      q("likert", { options: [{ option: "Agree", count: 4, percent: "100" }], average: "4" }),
      q("checkbox", { yes: { count: 5, percent: "71.43" }, no: { count: 2, percent: "28.57" } }),
      q("rating", { distribution: dist(5, 1), average: "3.4" }),
      q("nps", { distribution: dist(11), average: "7.67", promoters: { count: 3, percent: "50" }, passives: { count: 2, percent: "33.33" }, detractors: { count: 1, percent: "16.67" }, nps: "33.33" }),
      q("number", { average: "6.25", min: "2", max: "10.5", sum: "12.5" }),
      q("matrix", { rows: [{ row: "Speed", answered: 3, columns: [{ column: "Bad", count: 1, percent: "33.33" }, { column: "Good", count: 2, percent: "66.67" }] }] }),
      q("ranking", { items: [{ item: "X", average_rank: "1.33", first_place: 2 }] }),
      q("file", { files: 3 }),
      q("long_text", {}),
      q("short_text", { answered: 0 }),
    ];
    for (const c of cards) {
      const out = renderToStaticMarkup(wrap(<QuestionCard q={c} formId="f" n={1} />));
      expect(out, c.type).toContain(`About ${c.type}`);
    }
    const nps = renderToStaticMarkup(wrap(<QuestionCard q={cards[4]} formId="f" n={1} />));
    expect(nps).toContain("+33.33");
    expect(nps).toContain("Promoters");
    expect(renderToStaticMarkup(wrap(<QuestionCard q={cards[10]} formId="f" n={1} />))).toContain("Nobody has answered this yet.");
  });

  it("draws the days", () => {
    const out = renderToStaticMarkup(<Trend trend={[{ date: "2026-11-01", responses: 1 }, { date: "2026-11-02", responses: 5 }, { date: "2026-11-03", responses: 0 }]} />);
    expect(out).toContain("6 in 3 days");
    expect(out).toContain("<path");
    expect(renderToStaticMarkup(<Trend trend={[]} />)).toBe("");
  });
});
