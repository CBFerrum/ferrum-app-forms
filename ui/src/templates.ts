// Starting points for a new form: a few forms people ask for, as questions to change.

import { blankRow, type QRow } from "./rows";
import type { Fields } from "./formdoc";
import type { Kind } from "./model";

export interface Template {
  id: string;
  name: string;
  hint: string;
  kind: Fields["kind"];
  /** Settings the template sets besides the title and kind. */
  settings?: Partial<Pick<Fields, "confirmation_message" | "passing_score" | "reveal_answers" | "layout">>;
  rows: () => QRow[];
}

type Spec = [Kind, string, Partial<QRow>?];

function build(specs: Spec[]): QRow[] {
  const rows: QRow[] = [];
  for (const [kind, label, more] of specs) rows.push({ ...blankRow(kind, rows, label), ...more, keyAuto: false });
  return rows;
}

export const TEMPLATES: Template[] = [
  { id: "blank", name: "Blank form", hint: "Start from nothing.", kind: "Form", rows: () => [] },
  {
    id: "contact",
    name: "Contact form",
    hint: "A name, an email and a message.",
    kind: "Form",
    settings: { confirmation_message: "Thanks for getting in touch. We will reply soon." },
    rows: () =>
      build([
        ["short_text", "Your name", { required: true }],
        ["email", "Your email", { required: true }],
        ["phone", "Phone number"],
        ["long_text", "How can we help?", { required: true }],
      ]),
  },
  {
    id: "event",
    name: "Event registration",
    hint: "Who is coming, with how many, and what they need.",
    kind: "Form",
    settings: { confirmation_message: "You are registered. We look forward to seeing you." },
    rows: () =>
      build([
        ["short_text", "Your name", { required: true }],
        ["email", "Your email", { required: true }],
        ["number", "How many people are coming?", { required: true, min_value: "1", max_value: "10" }],
        ["multi_select", "Anything we should know about food?", { options: ["Vegetarian", "Vegan", "Gluten-free", "Nut allergy"], allow_other: true }],
        ["long_text", "Anything else?"],
      ]),
  },
  {
    id: "feedback",
    name: "Customer feedback",
    hint: "A score, a rating and what to improve.",
    kind: "Survey",
    settings: { confirmation_message: "Thank you for your feedback. It helps us a lot." },
    rows: () =>
      build([
        ["nps", "How likely are you to recommend us to a friend or colleague?", { required: true }],
        ["rating", "How would you rate your last experience?", { required: true, max_value: "5" }],
        ["long_text", "What is one thing we could do better?"],
        ["checkbox", "You may contact me about my feedback"],
      ]),
  },
  {
    id: "quiz",
    name: "Short quiz",
    hint: "Questions with right answers, marked for you.",
    kind: "Quiz",
    settings: { passing_score: "60", reveal_answers: true, layout: "One question at a time" },
    rows: () =>
      build([
        ["select", "What is the capital of France?", { required: true, options: ["Paris", "Lyon", "Marseille"], correct_answer: "Paris", points: "1" }],
        ["multi_select", "Which of these are prime numbers?", { required: true, options: ["2", "3", "4", "9"], correct_answer: ["2", "3"], points: "2" }],
        ["short_text", "What is 6 times 7?", { required: true, correct_answer: ["42", "forty-two"], points: "1" }],
      ]),
  },
];
