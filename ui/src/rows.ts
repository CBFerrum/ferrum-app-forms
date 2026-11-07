// The builder's questions as plain data, and what can be done to them: add, copy, move, rename,
// change the type, find what reads an answer, and see what is wrong before the server says so.
// The server checks the whole definition on every save (src/model.rs, src/form.rs) and is the
// judge; this is the same checking early, on the card the mistake is on. Pure, so it is tested.

import { answerKeys, compile } from "./cel";
import { answerable, gradable, hasOptions, type Kind, KINDS, LIKERT_DEFAULT, type Layout, type PForm, type PQuestion } from "./model";
import { t } from "@ferrum/client";

/** A question row of the Form (`FormQuestion`), as the builder holds it. */
export interface QRow {
  /** This row on this screen (React's key, a drag's handle); the server's `id` once saved. */
  uid: string;
  id?: string;
  key: string;
  /** The key follows the label until the question is saved (a new question named by its label). */
  keyAuto: boolean;
  label: string;
  question_type: Kind;
  required: boolean;
  help_text: string;
  options: string[];
  matrix_rows: string[];
  allow_other: boolean;
  min_value: string;
  max_value: string;
  min_length: number | null;
  max_length: number | null;
  pattern: string;
  pattern_message: string;
  default_value: unknown;
  visible_if: string;
  allow_prefill: boolean;
  accept: string;
  max_file_mb: number | null;
  points: string;
  correct_answer: unknown;
}

export const uid = (): string => (typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `u${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);

// ───────────────────────────── keys ─────────────────────────────

/** `Your e-mail address` → `your_e_mail_address`, unique among `used` (src/form.rs `derive_key`). */
export function deriveKey(label: string, position: number, used: string[]): string {
  let base = "";
  for (const c of label.toLowerCase()) {
    if (/[a-z0-9]/.test(c)) base += c;
    else if (!base.endsWith("_") && base !== "") base += "_";
  }
  base = base.replace(/^_+|_+$/g, "").slice(0, 34).replace(/_+$/, "");
  if (base === "") base = `q${position + 1}`;
  else if (!/^[a-z]/.test(base)) base = `q_${base}`;
  let key = base;
  for (let n = 2; used.includes(key); n++) key = `${base}_${n}`;
  return key;
}

export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** `answers.old` → `answers.new` in a condition. */
export function renameInCondition(condition: string, from: string, to: string): string {
  return condition.replace(new RegExp(`answers\\.${from}(?![A-Za-z0-9_])`, "g"), `answers.${to}`).replace(new RegExp(`answers\\[(['"])${from}\\1\\]`, "g"), `answers['${to}']`);
}

/** A question's key changed (a new question named by its label): what reads it follows. */
export function renameKey(rows: QRow[], from: string, to: string): QRow[] {
  if (from === to || !from) return rows;
  return rows.map((r) => (r.key === from ? { ...r, key: to } : r.visible_if.includes(from) ? { ...r, visible_if: renameInCondition(r.visible_if, from, to) } : r));
}

/** A new question takes its key from its label, whenever the label is written, until it is
 *  saved; after that the key stays, because answers, conditions and exports are named by it. */
export function nameFromLabel(rows: QRow[], index: number): QRow[] {
  const r = rows[index];
  if (!r || r.id || !r.keyAuto || !answerable(r.question_type) || !r.label.trim()) return rows;
  const wanted = deriveKey(r.label, index, rows.filter((_, i) => i !== index).map((x) => x.key));
  if (r.key === wanted) return rows;
  return renameKey(rows, r.key, wanted);
}

// ───────────────────────────── rows ─────────────────────────────

const OPTION_STARTERS = ["Option 1", "Option 2", "Option 3"];

/** What a new question of a type starts with. */
export function starter(kind: Kind): Partial<QRow> {
  switch (kind) {
    case "select":
    case "multi_select":
    case "dropdown":
    case "ranking":
      return { options: [...OPTION_STARTERS] };
    case "matrix":
      return { options: ["Poor", "Fair", "Good", "Excellent"], matrix_rows: ["Statement 1", "Statement 2"] };
    case "rating":
      return { max_value: "5" };
    case "file":
      return { max_file_mb: 10, max_value: "1" };
    default:
      return {};
  }
}

export function blankRow(kind: Kind, rows: QRow[], label = ""): QRow {
  const position = rows.length;
  return {
    uid: uid(),
    key: answerable(kind) ? deriveKey(label, position, rows.map((r) => r.key)) : deriveKey(kind === "page_break" ? "page" : "text", position, rows.map((r) => r.key)),
    keyAuto: answerable(kind),
    label,
    question_type: kind,
    required: false,
    help_text: "",
    options: [],
    matrix_rows: [],
    allow_other: false,
    min_value: "",
    max_value: "",
    min_length: null,
    max_length: null,
    pattern: "",
    pattern_message: "",
    default_value: null,
    visible_if: "",
    allow_prefill: false,
    accept: "",
    max_file_mb: null,
    points: "",
    correct_answer: null,
    ...starter(kind),
  };
}

/** The list of texts a row holds, whether the server sent a list or lines. */
export function listOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return lines(v);
  return [];
}

export const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

export function rowFromDoc(r: Record<string, unknown>): QRow {
  const kind = KINDS.some((k) => k.kind === r.question_type) ? (r.question_type as Kind) : "short_text";
  return {
    uid: typeof r.id === "string" ? r.id : uid(),
    id: typeof r.id === "string" ? r.id : undefined,
    key: str(r.key),
    keyAuto: false,
    label: str(r.label),
    question_type: kind,
    required: r.required === true,
    help_text: str(r.help_text),
    options: listOf(r.options),
    matrix_rows: listOf(r.matrix_rows),
    allow_other: r.allow_other === true,
    min_value: str(r.min_value),
    max_value: str(r.max_value),
    min_length: intOrNull(r.min_length),
    max_length: intOrNull(r.max_length),
    pattern: str(r.pattern),
    pattern_message: str(r.pattern_message),
    default_value: r.default_value ?? null,
    visible_if: str(r.visible_if),
    allow_prefill: r.allow_prefill === true,
    accept: str(r.accept),
    max_file_mb: intOrNull(r.max_file_mb),
    points: str(r.points),
    correct_answer: r.correct_answer ?? null,
  };
}

const nul = <T>(v: T | "" | null | undefined): T | null => (v === "" || v === undefined ? null : v);

/** The row as the server takes it. Every field is sent, so one that was cleared is cleared. */
export function rowToDoc(r: QRow): Record<string, unknown> {
  const kind = r.question_type;
  return {
    ...(r.id ? { id: r.id } : {}),
    key: r.key,
    label: r.label,
    question_type: kind,
    required: answerable(kind) && r.required,
    help_text: nul(r.help_text),
    options: hasOptions(kind) ? r.options : null,
    matrix_rows: kind === "matrix" ? r.matrix_rows : null,
    allow_other: r.allow_other,
    min_value: nul(r.min_value),
    max_value: nul(r.max_value),
    min_length: r.min_length,
    max_length: r.max_length,
    pattern: nul(r.pattern),
    pattern_message: nul(r.pattern_message),
    default_value: r.default_value,
    visible_if: nul(r.visible_if.trim()),
    allow_prefill: r.allow_prefill,
    accept: nul(r.accept),
    max_file_mb: r.max_file_mb,
    points: nul(r.points),
    correct_answer: r.correct_answer,
  };
}

/** Changing a question's type keeps what still means something and drops the rest. */
export function changeKind(r: QRow, kind: Kind): QRow {
  const from = r.question_type;
  const fresh = starter(kind);
  return {
    ...r,
    question_type: kind,
    required: answerable(kind) ? r.required : false,
    options: hasOptions(kind) ? (hasOptions(from) && r.options.length ? r.options : (fresh.options ?? [])) : [],
    matrix_rows: kind === "matrix" ? (r.matrix_rows.length ? r.matrix_rows : (fresh.matrix_rows ?? [])) : [],
    allow_other: ["select", "dropdown", "multi_select"].includes(kind) ? r.allow_other : false,
    min_value: "",
    max_value: fresh.max_value ?? "",
    min_length: null,
    max_length: null,
    pattern: "",
    pattern_message: "",
    default_value: null,
    accept: "",
    max_file_mb: fresh.max_file_mb ?? null,
    allow_prefill: answerable(kind) && !["file", "matrix", "ranking"].includes(kind) ? r.allow_prefill : false,
    points: gradable(kind) ? r.points : "",
    correct_answer: null,
  };
}

export function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** A copy of a question to edit: new on the screen and to the server, with a key of its own. */
export function copyRow(rows: QRow[], index: number): QRow {
  const r = rows[index];
  const key = deriveKey(r.key, index, rows.map((x) => x.key));
  return { ...r, uid: uid(), id: undefined, keyAuto: false, key: answerable(r.question_type) ? key : r.key };
}

// ───────────────────────────── what reads what ─────────────────────────────

/** Questions a row's condition reads (empty when it does not parse here). */
export function reads(r: QRow): string[] {
  const p = r.visible_if.trim() ? compile(r.visible_if) : null;
  return p ? answerKeys(p) : [];
}

/** Rows (by index) whose condition reads the answer to `key`. */
export function readers(rows: QRow[], key: string): number[] {
  return rows.flatMap((r, i) => (reads(r).includes(key) ? [i] : []));
}

/** The questions a row's condition may read: answerable ones before it. */
export function earlier(rows: QRow[], index: number): QRow[] {
  return rows.slice(0, index).filter((r) => answerable(r.question_type));
}

/** Whether every respondent gets the question: no condition of its own, none on its page
 *  (src/form.rs `always_shown`), which the email question of a form must be. */
export function alwaysShown(rows: QRow[], key: string): boolean {
  let page = false;
  for (const r of rows) {
    if (r.question_type === "page_break") page = r.visible_if.trim() !== "";
    if (r.key === key && answerable(r.question_type)) return r.visible_if.trim() === "" && !page;
  }
  return false;
}

/** The page a question is on: the page break before it (null on the first page). */
export function pageOf(rows: QRow[], index: number): QRow | null {
  for (let i = index; i >= 0; i--) if (rows[i].question_type === "page_break") return rows[i];
  return null;
}

// ───────────────────────────── what is wrong ─────────────────────────────

export interface Problem {
  field: string;
  message: string;
}

const MAX_OPTIONS = 200;
const OPTION_CHARS = 200;
export const FILE_TYPES = ["pdf", "png", "jpg", "jpeg", "gif", "webp", "txt", "csv", "docx", "xlsx", "pptx", "odt", "ods", "doc", "xls", "ppt", "zip"];

function duplicate(list: string[]): string | null {
  const seen = new Set<string>();
  for (const s of list) {
    if (seen.has(s)) return s;
    seen.add(s);
  }
  return null;
}

const whole = (s: string) => /^[+-]?\d+$/.test(s.trim());

/** What is wrong with each question, as the server will say it. */
export function problems(rows: QRow[]): Problem[][] {
  const keys = rows.map((r) => r.key);
  const answerableKeys = new Set(rows.filter((r) => answerable(r.question_type)).map((r) => r.key));
  return rows.map((r, i) => {
    const out: Problem[] = [];
    const add = (field: string, message: string) => out.push({ field, message });
    const kind = r.question_type;
    if (answerable(kind) && !r.label.trim()) add("label", "Write the question.");
    if (kind === "statement" && !r.label.trim() && !r.help_text.trim()) add("label", "Write the text.");
    if (!KEY_PATTERN.test(r.key)) add("key", "Use 1 to 40 of a to z, 0 to 9 and _, starting with a letter.");
    else if (keys.indexOf(r.key) !== i) add("key", `Another question uses the ID "${r.key}".`);
    if (hasOptions(kind)) {
      const fewest = ["select", "dropdown", "multi_select"].includes(kind) ? 1 : kind === "likert" ? 0 : 2;
      if (r.options.length < fewest) add("options", fewest === 1 ? "Add at least one option." : `Add at least ${fewest} ${kind === "matrix" ? "columns" : "options"}.`);
      if (r.options.length > MAX_OPTIONS) add("options", `Use at most ${MAX_OPTIONS}.`);
      const twice = duplicate(r.options);
      if (twice) add("options", `"${twice}" is listed twice.`);
      if (r.options.some((o) => [...o].length > OPTION_CHARS)) add("options", `Keep each to ${OPTION_CHARS} characters.`);
    }
    if (kind === "matrix") {
      if (!r.matrix_rows.length) add("matrix_rows", "Add at least one statement.");
      const twice = duplicate(r.matrix_rows);
      if (twice) add("matrix_rows", `"${twice}" is listed twice.`);
    }
    if (kind === "number") {
      if (r.min_value && !whole(r.min_value)) add("min_value", "Use a whole number.");
      if (r.max_value && !whole(r.max_value)) add("max_value", "Use a whole number.");
      if (whole(r.min_value) && whole(r.max_value) && Number(r.min_value) > Number(r.max_value)) add("min_value", "The smallest cannot be more than the largest.");
    }
    if (kind === "decimal") {
      const [lo, hi] = [Number(r.min_value), Number(r.max_value)];
      if (r.min_value && !Number.isFinite(lo)) add("min_value", "Use a number.");
      if (r.max_value && !Number.isFinite(hi)) add("max_value", "Use a number.");
      if (r.min_value && r.max_value && lo > hi) add("min_value", "The smallest cannot be more than the largest.");
    }
    if (kind === "date" || kind === "time") {
      if (r.min_value && r.max_value && r.min_value > r.max_value) add("min_value", "The earliest cannot be after the latest.");
    }
    if (kind === "multi_select") {
      const [lo, hi] = [Number(r.min_value || 0), Number(r.max_value || Infinity)];
      if ((r.min_value && !whole(r.min_value)) || (r.max_value && !whole(r.max_value))) add("min_value", "Use whole numbers.");
      else if (lo > hi) add("min_value", "The fewest cannot be more than the most.");
      else if (lo > r.options.length + (r.allow_other ? 1 : 0) && r.options.length) add("min_value", `There are only ${r.options.length + (r.allow_other ? 1 : 0)} options to choose.`);
    }
    if (kind === "rating" && r.max_value && !(whole(r.max_value) && Number(r.max_value) >= 3 && Number(r.max_value) <= 10)) add("max_value", "A rating goes up to 3 to 10.");
    if (kind === "short_text" || kind === "long_text") {
      const cap = kind === "short_text" ? 2000 : 50000;
      if (r.max_length !== null && (r.max_length < 1 || r.max_length > cap)) add("max_length", `Use 1 to ${cap}.`);
      if (r.min_length !== null && r.max_length !== null && r.min_length > r.max_length) add("min_length", "The shortest cannot be longer than the longest.");
    }
    if (kind === "file") {
      const accepted = r.accept.split(/[\s,;]+/).map((e) => e.replace(/^\./, "").toLowerCase()).filter(Boolean);
      const bad = accepted.find((e) => !FILE_TYPES.includes(e));
      if (bad) add("accept", `Files of type "${bad}" cannot be accepted.`);
      if (r.max_value && !(whole(r.max_value) && Number(r.max_value) >= 1 && Number(r.max_value) <= 10)) add("max_value", "Allow 1 to 10 files.");
      if (r.max_file_mb !== null && (r.max_file_mb < 1 || r.max_file_mb > 20)) add("max_file_mb", "Use 1 to 20 MB.");
    }
    if (r.visible_if.trim()) {
      const p = compile(r.visible_if);
      if (p) {
        for (const k of answerKeys(p)) {
          const at = keys.indexOf(k);
          if (!answerableKeys.has(k)) add("visible_if", `There is no question "${k}".`);
          else if (at >= i) add("visible_if", `The condition reads "${k}", which is not before this question.`);
        }
      }
    }
    return out;
  });
}

// ───────────────────────────── a preview of the form ─────────────────────────────

/** The top-level fields the preview and the share panel read. */
export interface Basics {
  title: string;
  description: string;
  kind: "Form" | "Survey" | "Quiz";
  access: "Public" | "Internal";
  anonymous: boolean;
  closes_at: string | null;
  accent_color: string | null;
  logo: string | null;
  layout: "Pages" | "One question at a time";
}

const textLength = (q: QRow, dflt: number) => q.max_length ?? dflt;

/** A question as respondents get it (src/model.rs `Question::public`). */
export function toPublicQuestion(r: QRow): PQuestion {
  const kind = r.question_type;
  const q: PQuestion = { key: r.key, type: kind, label: r.label };
  if (answerable(kind)) q.required = r.required;
  if (r.help_text.trim()) q.help_text = r.help_text.trim();
  const options = kind === "likert" && !r.options.length ? LIKERT_DEFAULT : r.options;
  if (hasOptions(kind) && options.length) q[kind === "matrix" ? "columns" : "options"] = options;
  if (kind === "matrix" && r.matrix_rows.length) q.rows = r.matrix_rows;
  if (["select", "dropdown", "multi_select"].includes(kind) && r.allow_other) q.allow_other = true;
  if (kind === "rating") q.scale = whole(r.max_value) ? Math.min(10, Math.max(3, Number(r.max_value))) : 5;
  if (kind === "nps") q.scale = 10;
  if (kind === "short_text" || kind === "long_text") {
    if (r.min_length) q.min_length = r.min_length;
    q.max_length = textLength(r, kind === "short_text" ? 500 : 10000);
    if (r.pattern) {
      q.pattern = r.pattern;
      if (r.pattern_message) q.pattern_message = r.pattern_message;
    }
  }
  if (kind === "file") {
    const accepted = r.accept.split(/[\s,;]+/).map((e) => e.replace(/^\./, "").toLowerCase()).filter(Boolean);
    q.accept = accepted.length ? accepted : FILE_TYPES.filter((e) => e !== "zip");
    q.max_file_mb = r.max_file_mb ?? 10;
    q.max_files = whole(r.max_value) ? Math.min(10, Math.max(1, Number(r.max_value))) : 1;
  }
  if (["number", "decimal", "date", "time", "datetime", "multi_select"].includes(kind)) {
    if (r.min_value) q.min = r.min_value;
    if (r.max_value) q.max = r.max_value;
  }
  if (r.default_value !== null && r.default_value !== undefined && r.default_value !== "") q.default = r.default_value;
  if (r.visible_if.trim()) q.visible_if = r.visible_if.trim();
  if (r.allow_prefill) q.allow_prefill = true;
  return q;
}

export function toPublic(b: Basics, rows: QRow[]): PForm {
  const layout: Layout = b.layout === "One question at a time" ? "single" : "pages";
  return {
    slug: "preview",
    title: b.title || t("Untitled form"),
    description: b.description.trim() || null,
    kind: b.kind,
    access: b.access,
    anonymous: b.anonymous,
    closes_at: b.closes_at,
    theme: { accent_color: b.accent_color, logo: b.logo },
    layout,
    questions: rows.map(toPublicQuestion),
  };
}

// ───────────────────────────── filling a record from a question ─────────────────────────────

/** Whether a question's answer can fill a field of another record (src/mapping.rs `compatible`). */
export function fits(field: { type: string; options?: string[]; max_length?: number }, q: QRow): boolean {
  const k = q.question_type;
  if (!answerable(k)) return false;
  switch (field.type) {
    case "data":
      return k !== "matrix" && k !== "file" && k !== "long_text" && !(k === "short_text" && (q.max_length ?? 500) > (field.max_length ?? 1000));
    case "text":
    case "markdown":
    case "code":
      return k !== "matrix" && k !== "file";
    case "email":
      return k === "email";
    case "phone":
      return k === "phone";
    case "url":
      return k === "short_text";
    case "int":
      return k === "number" || k === "rating" || k === "nps";
    case "decimal":
    case "currency":
    case "percent":
      return k === "number" || k === "decimal" || k === "rating" || k === "nps";
    case "date":
      return k === "date";
    case "datetime":
      return k === "datetime";
    case "check":
      return k === "checkbox";
    case "select": {
      const labels = k === "likert" && !q.options.length ? LIKERT_DEFAULT : q.options;
      return (k === "select" || k === "dropdown" || k === "likert") && !q.allow_other && labels.every((o) => field.options?.includes(o));
    }
    case "attach":
      return k === "file";
    case "json":
      return true;
    default:
      return false;
  }
}
