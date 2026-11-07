import { t } from "@ferrum/client";
// What the interface knows of a form: the question types, the definition a respondent gets
// (`GET /f/{slug}`, src/model.rs `Question::public`) and what comes back after sending.

export type Kind =
  | "short_text"
  | "long_text"
  | "email"
  | "phone"
  | "number"
  | "decimal"
  | "date"
  | "time"
  | "datetime"
  | "select"
  | "multi_select"
  | "checkbox"
  | "dropdown"
  | "rating"
  | "nps"
  | "likert"
  | "matrix"
  | "ranking"
  | "file"
  | "page_break"
  | "statement";

export interface KindInfo {
  kind: Kind;
  /** What a builder calls it. */
  label: string;
  /** One line under the name in the list of types. */
  hint: string;
  group: "Text" | "Choice" | "Scale" | "Date" | "More";
}

/** The 21 types, in the order the list of types shows them. */
export const KINDS: KindInfo[] = [
  { kind: "short_text", get label() { return t("Short answer"); }, get hint() { return t("A name, a title, a few words"); }, group: "Text" },
  { kind: "long_text", get label() { return t("Long answer"); }, get hint() { return t("A paragraph of their own words"); }, group: "Text" },
  { kind: "email", get label() { return t("Email"); }, get hint() { return t("An address, checked as they type"); }, group: "Text" },
  { kind: "phone", get label() { return t("Phone number"); }, get hint() { return t("Digits, spaces and a leading +"); }, group: "Text" },
  { kind: "number", get label() { return t("Whole number"); }, get hint() { return t("An age, a quantity"); }, group: "Text" },
  { kind: "decimal", get label() { return t("Number with decimals"); }, get hint() { return t("An amount, a measurement"); }, group: "Text" },
  { kind: "select", get label() { return t("Single choice"); }, get hint() { return t("Pick one of a few"); }, group: "Choice" },
  { kind: "multi_select", get label() { return t("Multiple choice"); }, get hint() { return t("Pick any that apply"); }, group: "Choice" },
  { kind: "dropdown", get label() { return t("Dropdown"); }, get hint() { return t("Pick one from a long list"); }, group: "Choice" },
  { kind: "checkbox", get label() { return t("Checkbox"); }, get hint() { return t("Yes or no, or “I agree”"); }, group: "Choice" },
  { kind: "ranking", get label() { return t("Ranking"); }, get hint() { return t("Put the options in order"); }, group: "Choice" },
  { kind: "rating", get label() { return t("Rating"); }, get hint() { return t("Stars, from 3 to 10"); }, group: "Scale" },
  { kind: "nps", get label() { return t("Net promoter score"); }, get hint() { return t("0 to 10, how likely to recommend"); }, group: "Scale" },
  { kind: "likert", get label() { return t("Agreement scale"); }, get hint() { return t("Strongly disagree to strongly agree"); }, group: "Scale" },
  { kind: "matrix", get label() { return t("Grid"); }, get hint() { return t("Several statements, one scale"); }, group: "Scale" },
  { kind: "date", get label() { return t("Date"); }, get hint() { return t("A day from a calendar"); }, group: "Date" },
  { kind: "time", get label() { return t("Time"); }, get hint() { return t("A time of day"); }, group: "Date" },
  { kind: "datetime", get label() { return t("Date and time"); }, get hint() { return t("A day and a time"); }, group: "Date" },
  { kind: "file", get label() { return t("File upload"); }, get hint() { return t("A document or a picture"); }, group: "More" },
  { kind: "statement", get label() { return t("Text block"); }, get hint() { return t("Words to read, no answer"); }, group: "More" },
  { kind: "page_break", get label() { return t("Page break"); }, get hint() { return t("Start a new page"); }, group: "More" },
];

export const GROUPS: KindInfo["group"][] = ["Text", "Choice", "Scale", "Date", "More"];

const BY_KIND = new Map(KINDS.map((k) => [k.kind, k]));

export const kindLabel = (k: string): string => BY_KIND.get(k as Kind)?.label ?? k;

/** Respondents answer it (page breaks and text blocks only structure the form). */
export const answerable = (k: Kind): boolean => k !== "page_break" && k !== "statement";

/** One choice among the options (src/model.rs `single_choice`). */
export const singleChoice = (k: Kind): boolean => k === "select" || k === "dropdown" || k === "likert";

/** Types that list options. */
export const hasOptions = (k: Kind): boolean => ["select", "dropdown", "multi_select", "likert", "matrix", "ranking"].includes(k);

/** A quiz can mark these right or wrong (src/model.rs `gradable`). */
export const gradable = (k: Kind): boolean =>
  ["short_text", "number", "decimal", "date", "select", "dropdown", "multi_select", "checkbox", "likert", "ranking"].includes(k);

/** The agreement scale of a Likert question without labels of its own. */
export const LIKERT_DEFAULT = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"];

// ───────────────────────────── what respondents get ─────────────────────────────

/** A question as respondents get it. */
export interface PQuestion {
  key: string;
  type: Kind;
  label: string;
  required?: boolean;
  help_text?: string;
  /** Choices, Likert labels or ranking items. */
  options?: string[];
  /** A grid's columns, and its statements in `rows`. */
  columns?: string[];
  rows?: string[];
  allow_other?: boolean;
  /** Rating: stars; NPS: always 10. */
  scale?: number;
  min_length?: number;
  max_length?: number;
  pattern?: string;
  pattern_message?: string;
  /** Bounds as the owner wrote them (a whole number for choices, a date for dates). */
  min?: string;
  max?: string;
  accept?: string[];
  max_file_mb?: number;
  max_files?: number;
  default?: unknown;
  visible_if?: string;
  allow_prefill?: boolean;
}

export type Layout = "pages" | "single";

export interface PForm {
  slug: string;
  title: string;
  description?: string | null;
  kind: "Form" | "Survey" | "Quiz";
  access: "Public" | "Internal";
  anonymous: boolean;
  closes_at?: string | null;
  theme: { accent_color?: string | null; logo?: string | null };
  /** One page at a time (page breaks end a page), or one question at a time. */
  layout?: Layout;
  questions: PQuestion[];
}

export interface Opened {
  form: PForm;
  token: string;
  prefill: Record<string, unknown>;
}

/** A quiz response's result (src/response.rs `result_view`). */
export interface QuizResult {
  score: string;
  max_score: string;
  percent: string | null;
  /** Null when the quiz has no passing score. */
  passed: boolean | null;
  questions: { key: string; label: string | null; points: string; earned: string; correct: boolean; correct_answer?: unknown }[];
}

export interface Receipt {
  status: "received";
  message: string;
  redirect_url: string | null;
  replayed: boolean;
  number?: string | null;
  result?: QuizResult;
  result_token?: string;
}
