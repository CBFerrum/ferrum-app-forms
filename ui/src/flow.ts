// Answering a form, in the browser: what each answer must look like, which questions are shown,
// how the questions fall on pages, and what is sent. The server checks every answer again and is
// the judge (src/answers.rs); this is the same checking, early and in plain words, so people fix
// a mistake where they made it. Pure, so it is tested without a browser.

import { answerKeys, compile, Dbl, holds, toVal, type Val } from "./cel";
import { answerable, type Layout, type PForm, type PQuestion } from "./model";

/** What the screen holds for a question: text for typed answers, a list for several choices and
 *  rankings, true or false for a checkbox, a number for ratings, a row → column map for a grid,
 *  files for an upload. */
export type Raw = unknown;
export type Answers = Record<string, Raw>;

/** The workspace's local date and time, which conditions read as `today` and `now`. */
export interface Env {
  today: string;
  now: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `today` and `now` in a time zone (the workspace's; an unknown one reads as UTC, like the server). */
export function zonedNow(zone: string, at = new Date()): Env {
  let tz = zone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / 60000);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return { today, now: `${today}T${parts.hour}:${parts.minute}:${parts.second}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}` };
}

// ───────────────────────────── one answer ─────────────────────────────

export type Norm = { kind: "blank" } | { kind: "ok"; value: unknown } | { kind: "error"; message: string };

const BLANK: Norm = { kind: "blank" };
const ok = (value: unknown): Norm => ({ kind: "ok", value });
const bad = (message: string): Norm => ({ kind: "error", message });

export const REQUIRED = "This question needs an answer.";
export const TICK = "Please tick this box to continue.";

const EMAIL = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$/;
const PHONE = /^[+0-9 ()\-./]{3,40}$/;
const SHORT_DEFAULT = 500;
const LONG_DEFAULT = 10_000;
const OPTION_MAX = 200;

const isFile = (x: unknown): x is File => typeof File !== "undefined" && x instanceof File;

export function isBlank(raw: Raw): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === "string") return raw.trim() === "";
  if (Array.isArray(raw)) return raw.length === 0;
  if (typeof raw === "object" && !isFile(raw)) return Object.values(raw as object).every((v) => v === null || v === undefined || v === "");
  return false;
}

/** A pattern from the form, read the way the server reads it (the whole answer must match). */
function wholePattern(source: string): RegExp | null {
  for (const flags of ["u", ""]) {
    try {
      return new RegExp(`^(?:${source})$`, flags);
    } catch {
      /* try without the unicode flag, then give up: the server decides */
    }
  }
  return null;
}

const realDate = (s: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1900 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};

/** A day for reading in a message: 2026-11-03 → 3 Nov 2026. */
export function showDay(iso: string): string {
  return realDate(iso) ? new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)).toLocaleDateString(undefined, { dateStyle: "medium" }) : iso;
}

function bounded(n: number, lo: number | null, hi: number | null, noun: string): Norm | null {
  if (lo !== null && n < lo) return bad(`Enter ${noun} of at least ${lo}.`);
  if (hi !== null && n > hi) return bad(`Enter ${noun} of at most ${hi}.`);
  return null;
}

const wholeNumber = (s: string | undefined): number | null => (s !== undefined && /^[+-]?\d+$/.test(s.trim()) ? Number(s.trim()) : null);

export const extension = (name: string): string => (name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "");

/** Checks one answer and says what it comes to: nothing, a value (as the server will store it,
 *  close enough for conditions to read), or what is wrong with it. */
export function normalize(q: PQuestion, raw: Raw): Norm {
  const type = q.type;
  if (!answerable(type)) return BLANK;
  if (type === "checkbox") return ok(raw === true);
  if (isBlank(raw)) return BLANK;
  const text = () => (typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "");
  switch (type) {
    case "short_text":
    case "long_text": {
      const s = type === "short_text" ? text().trim() : text().replace(/\r\n?/g, "\n").trim();
      if (type === "short_text" && /[\u0000-\u001f\u007f]/.test(s)) return bad("Keep this to a single line.");
      const n = [...s].length;
      if (q.min_length && n < q.min_length) return bad(`Use at least ${q.min_length} characters.`);
      const max = q.max_length ?? (type === "short_text" ? SHORT_DEFAULT : LONG_DEFAULT);
      if (n > max) return bad(`Use at most ${max} characters. This is ${n}.`);
      const re = q.pattern ? wholePattern(q.pattern) : null;
      if (re && !re.test(s)) return bad(q.pattern_message || "That does not look right.");
      return ok(s);
    }
    case "email": {
      const s = text().trim();
      return EMAIL.test(s) && s.length <= 254 ? ok(s.toLowerCase()) : bad("Enter a valid email address, like name@example.com.");
    }
    case "phone": {
      const s = text().trim();
      return PHONE.test(s) ? ok(s) : bad("Enter a phone number with digits, spaces and a leading + if you need one.");
    }
    case "number": {
      const n = wholeNumber(text());
      if (n === null || !Number.isSafeInteger(n)) return bad("Enter a whole number.");
      return bounded(n, wholeNumber(q.min), wholeNumber(q.max), "a number") ?? ok(n);
    }
    case "decimal": {
      const s = text().replace(/,/g, "").trim();
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) || !Number.isFinite(Number(s))) return bad("Enter a number, like 12.50.");
      const lo = q.min !== undefined && q.min !== "" && Number.isFinite(Number(q.min)) ? Number(q.min) : null;
      const hi = q.max !== undefined && q.max !== "" && Number.isFinite(Number(q.max)) ? Number(q.max) : null;
      return bounded(Number(s), lo, hi, "a number") ?? ok(Number(s));
    }
    case "date": {
      const s = text().trim();
      if (!realDate(s)) return bad("Pick a date.");
      if (q.min && s < q.min) return bad(`Pick a date on or after ${showDay(q.min)}.`);
      if (q.max && s > q.max) return bad(`Pick a date on or before ${showDay(q.max)}.`);
      return ok(s);
    }
    case "time": {
      const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text().trim());
      if (!m || +m[1] > 23 || +m[2] > 59 || (m[3] !== undefined && +m[3] > 59)) return bad("Enter a time, like 14:30.");
      const s = `${pad(+m[1])}:${m[2]}${m[3] && m[3] !== "00" ? `:${m[3]}` : ""}`;
      if (q.min && s < q.min.padStart(5, "0")) return bad(`Pick a time at or after ${q.min}.`);
      if (q.max && s > q.max.padStart(5, "0")) return bad(`Pick a time at or before ${q.max}.`);
      return ok(s);
    }
    case "datetime": {
      // Bounds are instants; the server reads a local time in the workspace's zone and decides.
      const s = text().trim();
      return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(s) && realDate(s.slice(0, 10)) ? ok(s) : bad("Pick a date and a time.");
    }
    case "select":
    case "dropdown":
    case "likert": {
      const s = text().trim();
      if (q.options?.includes(s)) return ok(s);
      if (q.allow_other && s && [...s].length <= OPTION_MAX && !/[\u0000-\u001f\u007f]/.test(s)) return ok(s);
      return bad("Choose one of the options.");
    }
    case "multi_select": {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) return bad("Choose from the options.");
      const chosen = (raw as string[]).map((x) => x.trim()).filter(Boolean);
      const others = chosen.filter((x) => !q.options?.includes(x));
      if (others.length > 1 || (others.length === 1 && (!q.allow_other || [...others[0]].length > OPTION_MAX))) return bad("Choose from the options.");
      if (new Set(chosen).size !== chosen.length) return bad("Each option can be chosen once.");
      const lo = wholeNumber(q.min);
      const hi = wholeNumber(q.max);
      if (lo !== null && chosen.length < lo) return bad(`Choose at least ${lo}.`);
      if (hi !== null && chosen.length > hi) return bad(`Choose at most ${hi}.`);
      return ok([...(q.options ?? []).filter((o) => chosen.includes(o)), ...others]);
    }
    case "rating":
    case "nps": {
      const n = Number(raw);
      const [lo, hi] = type === "nps" ? [0, 10] : [1, q.scale ?? 5];
      return Number.isInteger(n) && n >= lo && n <= hi ? ok(n) : bad(`Choose a number from ${lo} to ${hi}.`);
    }
    case "matrix": {
      if (typeof raw !== "object" || Array.isArray(raw)) return bad("Answer each row.");
      const cells = Object.entries(raw as Record<string, unknown>).filter(([, c]) => c !== null && c !== undefined && c !== "");
      for (const [row, col] of cells) if (!q.rows?.includes(row) || typeof col !== "string" || !q.columns?.includes(col)) return bad("Choose one of the columns for each row.");
      if (!cells.length) return BLANK;
      if (q.required && cells.length < (q.rows?.length ?? 0)) return bad("Answer every row.");
      return ok(Object.fromEntries(cells));
    }
    case "ranking": {
      const list = Array.isArray(raw) ? (raw as unknown[]) : [];
      const options = q.options ?? [];
      const complete = list.length === options.length && options.every((o) => list.filter((x) => x === o).length === 1);
      return complete ? ok(list) : bad("Put every option in your order.");
    }
    case "file": {
      const files = Array.isArray(raw) ? (raw as File[]) : [];
      const max = q.max_files ?? 1;
      if (files.length > max) return bad(max === 1 ? "Attach one file." : `Attach at most ${max} files.`);
      const limit = (q.max_file_mb ?? 10) * 1024 * 1024;
      for (const f of files) {
        if (q.accept?.length && !q.accept.includes(extension(f.name))) return bad(`${f.name}: files of this kind are not accepted. Use ${q.accept.join(", ")}.`);
        if (f.size === 0) return bad(`${f.name} is empty.`);
        if (f.size > limit) return bad(`${f.name} is larger than ${q.max_file_mb ?? 10} MB.`);
      }
      return ok(files.map((f) => ({ file_name: f.name, size: f.size })));
    }
    default:
      return BLANK;
  }
}

/** How a condition sees an answer (src/answers.rs `cel_value`): decimals as doubles, uploads as
 *  their file names. */
function celValue(q: PQuestion, value: unknown): Val {
  if (q.type === "decimal") return new Dbl(Number(value));
  if (q.type === "file") return (value as { file_name: string }[]).map((f) => f.file_name);
  return toVal(value);
}

// ───────────────────────────── what is shown ─────────────────────────────

/** Per question (in order): whether this respondent sees it, decided as the server decides it
 *  (src/answers.rs `evaluate`): a question reads the answers before it, a page break shows or
 *  skips its whole page, and a hidden question's answer does not count. A condition this
 *  evaluator cannot run leaves its question shown. */
export function visibility(form: PForm, answers: Answers, env: Env): boolean[] {
  const view = new Map<string, Val>();
  for (const q of form.questions) if (answerable(q.type)) view.set(q.key, null);
  const vars = { answers: view as Val, today: env.today, now: env.now };
  let pageShown = true;
  const shown: boolean[] = [];
  for (const q of form.questions) {
    const program = q.visible_if ? compile(q.visible_if) : null;
    const holding = program ? holds(program, vars) : undefined;
    const passes = holding ?? true;
    if (q.type === "page_break") {
      pageShown = passes;
      shown.push(passes);
      continue;
    }
    const visible = pageShown && passes;
    shown.push(visible);
    if (!visible || !answerable(q.type)) continue;
    const n = normalize(q, answers[q.key]);
    if (n.kind === "ok") view.set(q.key, celValue(q, n.value));
  }
  return shown;
}

/** The questions a question's condition reads, which come from earlier in the form. */
export function reads(q: PQuestion): string[] {
  const program = q.visible_if ? compile(q.visible_if) : null;
  return program ? answerKeys(program) : [];
}

// ───────────────────────────── pages ─────────────────────────────

export interface Page {
  /** The page break that starts it (or the question, one at a time). */
  id: string;
  title: string | null;
  /** Indexes of the questions shown on it. */
  items: number[];
}

/** The pages a respondent goes through: the runs between page breaks, or one question each. A
 *  page with nothing to show is skipped. */
export function pagesOf(form: PForm, shown: boolean[], layout: Layout = "pages"): Page[] {
  const qs = form.questions;
  if (layout === "single") {
    return qs.flatMap((q, i) => (shown[i] && q.type !== "page_break" ? [{ id: q.key, title: null, items: [i] }] : []));
  }
  const pages: Page[] = [];
  let cur: Page = { id: "start", title: null, items: [] };
  qs.forEach((q, i) => {
    if (q.type === "page_break") {
      if (cur.items.length) pages.push(cur);
      cur = { id: q.key, title: q.label.trim() || null, items: [] };
    } else if (shown[i]) cur.items.push(i);
  });
  if (cur.items.length) pages.push(cur);
  return pages;
}

// ───────────────────────────── checking ─────────────────────────────

/** What is wrong on a set of questions (indexes into the form), by question key. */
export function check(form: PForm, items: number[], answers: Answers): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const i of items) {
    const q = form.questions[i];
    if (!answerable(q.type)) continue;
    const n = normalize(q, answers[q.key]);
    if (n.kind === "error") errors[q.key] = n.message;
    else if (n.kind === "blank" && q.required) errors[q.key] = REQUIRED;
    else if (n.kind === "ok" && q.type === "checkbox" && q.required && n.value === false) errors[q.key] = TICK;
  }
  return errors;
}

const KNOWN: [string, string][] = [
  ["is required", REQUIRED],
  ["must be checked", TICK],
  ["must be one of the options", "Choose one of the options."],
  ["answer every row", "Answer every row."],
  ["rank every option exactly once", "Put every option in your order."],
  ["is not in the expected format", "That does not look right."],
  ["must be a single line of text", "Keep this to a single line."],
  ["not a valid email address", "Enter a valid email address, like name@example.com."],
  ["not a valid phone number", "Enter a phone number with digits, spaces and a leading + if you need one."],
  ["must be a whole number", "Enter a whole number."],
  ["must be a number", "Enter a number, like 12.50."],
];

/** The server's reason, which reads after the question's name ("is required"), as a sentence. */
export function sentence(message: string): string {
  const m = message.trim();
  const known = KNOWN.find(([k]) => m === k);
  if (known) return known[1];
  const s = m.charAt(0).toUpperCase() + m.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

// ───────────────────────────── sending ─────────────────────────────

/** A file as a data URL, which the server takes as `content_base64`. */
export async function readFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // In slices: spreading a whole file into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

/** What is sent: the visible questions that have an answer (a checkbox is always an answer: yes or
 *  no), the values as checked, and uploads as data. */
export async function payload(form: PForm, shown: boolean[], answers: Answers): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [i, q] of form.questions.entries()) {
    if (!shown[i] || !answerable(q.type)) continue;
    const n = normalize(q, answers[q.key]);
    if (n.kind !== "ok") continue;
    if (q.type === "file") out[q.key] = await Promise.all((answers[q.key] as File[]).map(async (f) => ({ file_name: f.name, content_base64: await readFile(f) })));
    else out[q.key] = n.value;
  }
  return out;
}

/** The size of the upload, which the server limits (28 MB with files, base64 included). */
export function uploadBytes(form: PForm, shown: boolean[], answers: Answers): number {
  let total = 0;
  for (const [i, q] of form.questions.entries()) {
    if (shown[i] && q.type === "file" && Array.isArray(answers[q.key])) for (const f of answers[q.key] as File[]) total += f.size;
  }
  return total;
}

/** Roughly 20 MB of files fit in the 28 MB the server takes (base64 adds a third). */
export const UPLOAD_LIMIT = 20 * 1024 * 1024;

// ───────────────────────────── the start ─────────────────────────────

/** A day-and-time the server stored (an instant) as the local value a date-time input holds. */
export function localInput(iso: string, zone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let tz = zone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** A stored answer (a default, or what a link filled in) as the screen holds it. */
function rawOf(q: PQuestion, v: unknown, zone: string): Raw {
  switch (q.type) {
    case "multi_select":
    case "ranking":
      return Array.isArray(v) ? v.map(String) : [String(v)];
    case "checkbox":
      return v === true;
    case "rating":
    case "nps":
      return Number(v);
    case "matrix":
      return typeof v === "object" ? v : undefined;
    case "datetime":
      return typeof v === "string" ? localInput(v, zone) : undefined;
    default:
      return typeof v === "object" ? undefined : String(v);
  }
}

/** The answers a form starts with: what its questions pre-select and what the link filled in. */
export function initial(form: PForm, prefill: Record<string, unknown>, zone = "UTC"): Answers {
  const out: Answers = {};
  for (const q of form.questions) {
    if (!answerable(q.type) || q.type === "file") continue;
    const v = prefill[q.key] ?? q.default;
    if (v === undefined || v === null) continue;
    const raw = rawOf(q, v, zone);
    if (raw !== undefined) out[q.key] = raw;
  }
  return out;
}

// ───────────────────────────── kept in the browser ─────────────────────────────

const draftKey = (tenant: string, slug: string) => `ferrum.forms.draft.${tenant}.${slug}`;

export interface Draft {
  answers: Answers;
  /** The page the person was on (its id). */
  page: string | null;
}

/** Answers kept while the page is open (a tab's session), so a page that expired or was reloaded
 *  loses nothing the person typed. Uploads cannot be kept. */
export function saveDraft(tenant: string, slug: string, d: Draft): void {
  const answers = Object.fromEntries(Object.entries(d.answers).filter(([, v]) => !(Array.isArray(v) && v.some(isFile))));
  try {
    sessionStorage.setItem(draftKey(tenant, slug), JSON.stringify({ answers, page: d.page }));
  } catch {
    /* private mode or full: the answers stay on the page */
  }
}

export function loadDraft(tenant: string, slug: string): Draft | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(draftKey(tenant, slug)) ?? "null");
    return d && typeof d === "object" && d.answers && typeof d.answers === "object" ? { answers: d.answers, page: typeof d.page === "string" ? d.page : null } : null;
  } catch {
    return null;
  }
}

export function clearDraft(tenant: string, slug: string): void {
  try {
    sessionStorage.removeItem(draftKey(tenant, slug));
  } catch {
    /* nothing kept */
  }
}
