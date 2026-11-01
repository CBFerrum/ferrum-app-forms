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
  { kind: "short_text", label: "Short answer", hint: "A name, a title, a few words", group: "Text" },
  { kind: "long_text", label: "Long answer", hint: "A paragraph of their own words", group: "Text" },
  { kind: "email", label: "Email", hint: "An address, checked as they type", group: "Text" },
  { kind: "phone", label: "Phone number", hint: "Digits, spaces and a leading +", group: "Text" },
  { kind: "number", label: "Whole number", hint: "An age, a quantity", group: "Text" },
  { kind: "decimal", label: "Number with decimals", hint: "An amount, a measurement", group: "Text" },
  { kind: "select", label: "Single choice", hint: "Pick one of a few", group: "Choice" },
  { kind: "multi_select", label: "Multiple choice", hint: "Pick any that apply", group: "Choice" },
  { kind: "dropdown", label: "Dropdown", hint: "Pick one from a long list", group: "Choice" },
  { kind: "checkbox", label: "Checkbox", hint: "Yes or no, or “I agree”", group: "Choice" },
  { kind: "ranking", label: "Ranking", hint: "Put the options in order", group: "Choice" },
  { kind: "rating", label: "Rating", hint: "Stars, from 3 to 10", group: "Scale" },
  { kind: "nps", label: "Net promoter score", hint: "0 to 10, how likely to recommend", group: "Scale" },
  { kind: "likert", label: "Agreement scale", hint: "Strongly disagree to strongly agree", group: "Scale" },
  { kind: "matrix", label: "Grid", hint: "Several statements, one scale", group: "Scale" },
  { kind: "date", label: "Date", hint: "A day from a calendar", group: "Date" },
  { kind: "time", label: "Time", hint: "A time of day", group: "Date" },
  { kind: "datetime", label: "Date and time", hint: "A day and a time", group: "Date" },
  { kind: "file", label: "File upload", hint: "A document or a picture", group: "More" },
  { kind: "statement", label: "Text block", hint: "Words to read, no answer", group: "More" },
  { kind: "page_break", label: "Page break", hint: "Start a new page", group: "More" },
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
