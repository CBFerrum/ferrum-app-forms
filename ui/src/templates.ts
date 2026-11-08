// Starting points for a new form: a few forms people ask for, as questions to change.

import { blankRow, type QRow } from "./rows";
import type { Fields } from "./formdoc";
import type { Kind } from "./model";
import { t } from "@ferrum/client";

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
  { id: "blank", get name() { return t("Blank form"); }, get hint() { return t("Start from nothing."); }, kind: "Form", rows: () => [] },
  {
    id: "contact",
    get name() { return t("Contact form"); },
    get hint() { return t("A name, an email and a message."); },
    kind: "Form",
    settings: { confirmation_message: "Thanks for getting in touch. We will reply soon." },
    rows: () =>
      build([
        ["short_text", t("Your name"), { required: true }],
        ["email", t("Your email"), { required: true }],
        ["phone", t("Phone number")],
        ["long_text", t("How can we help?"), { required: true }],
      ]),
  },
  {
    id: "event",
    get name() { return t("Event registration"); },
    get hint() { return t("Who is coming, with how many, and what they need."); },
    kind: "Form",
    settings: { confirmation_message: "You are registered. We look forward to seeing you." },
    rows: () =>
      build([
        ["short_text", t("Your name"), { required: true }],
        ["email", t("Your email"), { required: true }],
        ["number", t("How many people are coming?"), { required: true, min_value: "1", max_value: "10" }],
        ["multi_select", t("Anything we should know about food?"), { options: ["Vegetarian", "Vegan", "Gluten-free", "Nut allergy"], allow_other: true }],
        ["long_text", t("Anything else?")],
      ]),
  },
  {
    id: "feedback",
    get name() { return t("Customer feedback"); },
    get hint() { return t("A score, a rating and what to improve."); },
    kind: "Survey",
    settings: { confirmation_message: "Thank you for your feedback. It helps us a lot." },
    rows: () =>
      build([
        ["nps", t("How likely are you to recommend us to a friend or colleague?"), { required: true }],
        ["rating", t("How would you rate your last experience?"), { required: true, max_value: "5" }],
        ["long_text", t("What is one thing we could do better?")],
        ["checkbox", t("You may contact me about my feedback")],
      ]),
  },
  {
    id: "quiz",
    get name() { return t("Short quiz"); },
    get hint() { return t("Questions with right answers, marked for you."); },
    kind: "Quiz",
    settings: { passing_score: "60", reveal_answers: true, layout: "One question at a time" },
    rows: () =>
      build([
        ["select", t("What is the capital of France?"), { required: true, options: ["Paris", "Lyon", "Marseille"], correct_answer: "Paris", points: "1" }],
        ["multi_select", t("Which of these are prime numbers?"), { required: true, options: ["2", "3", "4", "9"], correct_answer: ["2", "3"], points: "2" }],
        ["short_text", t("What is 6 times 7?"), { required: true, correct_answer: ["42", "forty-two"], points: "1" }],
      ]),
  },
];
