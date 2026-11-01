// "Show this question only if…" as rules a person can write: a question, what to compare, a value.
// The server keeps the condition as CEL (`visible_if`); rules are the plain way to write the
// common ones, and read back from CEL when a condition is exactly what rules would write. Any
// other condition stays CEL text, and is still run, shown and edited as it is.

import { Dbl, compile, quote, type Node } from "./cel";
import type { QRow } from "./rows";
import type { Kind } from "./model";

export type Op =
  | "is"
  | "is_not"
  | "contains"
  | "includes"
  | "excludes"
  | "first"
  | "cell"
  | "answered"
  | "empty"
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "checked"
  | "unchecked";

export interface Rule {
  key: string;
  op: Op;
  /** What to compare with: an option, a text, a number or a date; a grid's column. */
  value: string;
  /** A grid's statement. */
  row?: string;
}

export interface Condition {
  join: "all" | "any";
  rules: Rule[];
}

const NUMBERS: Kind[] = ["number", "decimal", "rating", "nps"];
const DAYS: Kind[] = ["date", "time"];

/** Compared by size (numbers) or by order (dates and times). */
export const ordered = (k: Kind): boolean => NUMBERS.includes(k) || DAYS.includes(k);

/** What a rule about a question of this type can say. */
export function opsFor(kind: Kind): Op[] {
  if (ordered(kind)) return ["eq", "ne", "gt", "gte", "lt", "lte", "answered", "empty"];
  switch (kind) {
    case "select":
    case "dropdown":
    case "likert":
      return ["is", "is_not", "answered", "empty"];
    case "multi_select":
      return ["includes", "excludes", "answered", "empty"];
    case "checkbox":
      return ["checked", "unchecked"];
    case "matrix":
      return ["cell", "answered", "empty"];
    case "ranking":
      return ["first", "answered", "empty"];
    case "file":
      return ["answered", "empty"];
    case "datetime":
      return ["answered", "empty"];
    default:
      return ["is", "is_not", "contains", "answered", "empty"];
  }
}

export function opLabel(op: Op, kind: Kind): string {
  if (DAYS.includes(kind)) {
    const days: Partial<Record<Op, string>> = { eq: "is", ne: "is not", gt: "is after", gte: "is on or after", lt: "is before", lte: "is on or before" };
    if (days[op]) return days[op] as string;
  }
  const labels: Record<Op, string> = {
    is: "is",
    is_not: "is not",
    contains: "contains",
    includes: "includes",
    excludes: "does not include",
    first: "is ranked first",
    cell: "is",
    answered: "is answered",
    empty: "is not answered",
    eq: "is equal to",
    ne: "is not equal to",
    gt: "is more than",
    gte: "is at least",
    lt: "is less than",
    lte: "is at most",
    checked: "is ticked",
    unchecked: "is not ticked",
  };
  return labels[op];
}

export const needsValue = (op: Op): boolean => !["answered", "empty", "checked", "unchecked"].includes(op);

const NUMBER = /^-?\d+(\.\d+)?$/;
const SYMBOL: Partial<Record<Op, string>> = { eq: "==", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };

/** Whether a rule says everything it needs to. */
export function complete(r: Rule, kind: Kind | undefined): boolean {
  if (!r.key) return false;
  if (!needsValue(r.op)) return true;
  if (r.value === "") return false;
  if (r.op === "cell" && !r.row) return false;
  if (kind && NUMBERS.includes(kind) && !NUMBER.test(r.value.trim())) return false;
  return true;
}

function expression(r: Rule, kind: Kind | undefined): string {
  const a = /^[a-z][a-z0-9_]*$/.test(r.key) ? `answers.${r.key}` : `answers[${quote(r.key)}]`;
  switch (r.op) {
    case "is":
      return `${a} == ${quote(r.value)}`;
    case "is_not":
      return `${a} != ${quote(r.value)}`;
    case "contains":
      return `${a}.contains(${quote(r.value)})`;
    case "includes":
      return `${quote(r.value)} in ${a}`;
    case "excludes":
      return `(${a} == null || !(${quote(r.value)} in ${a}))`;
    case "first":
      return `${a}[0] == ${quote(r.value)}`;
    case "cell":
      return `${a}[${quote(r.row ?? "")}] == ${quote(r.value)}`;
    case "answered":
      return `${a} != null`;
    case "empty":
      return `${a} == null`;
    case "checked":
      return `${a} == true`;
    case "unchecked":
      return `${a} != true`;
    default: {
      const value = kind && NUMBERS.includes(kind) ? r.value.trim() : quote(r.value);
      return `${a} ${SYMBOL[r.op]} ${value}`;
    }
  }
}

/** The CEL for a condition; rules that are not finished are left out. */
export function toCel(c: Condition, rows: QRow[]): string {
  const kinds = new Map(rows.map((r) => [r.key, r.question_type]));
  const parts = c.rules.filter((r) => complete(r, kinds.get(r.key))).map((r) => expression(r, kinds.get(r.key)));
  return parts.join(c.join === "all" ? " && " : " || ");
}

// ───────────────────────────── reading CEL back ─────────────────────────────

/** `answers.key` or `answers['key']`. */
function answersKey(n: Node): string | null {
  if (n.t === "sel" && !n.test && n.obj.t === "id" && n.obj.name === "answers") return n.field;
  if (n.t === "idx" && n.obj.t === "id" && n.obj.name === "answers" && n.index.t === "lit" && typeof n.index.v === "string") return n.index.v;
  return null;
}

const literal = (n: Node): string | number | boolean | null | undefined => {
  if (n.t === "lit") {
    const v = n.v;
    if (v instanceof Dbl) return v.v;
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null ? v : undefined;
  }
  if (n.t === "neg" && n.e.t === "lit" && (typeof n.e.v === "number" || n.e.v instanceof Dbl)) return -(n.e.v instanceof Dbl ? n.e.v.v : (n.e.v as number));
  return undefined;
};

const SYMBOLS: Record<string, Op> = { ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };

function oneRule(n: Node, kinds: Map<string, Kind>): Rule | null {
  if (n.t === "call" && n.fn === "contains" && n.target && n.args.length === 1) {
    const key = answersKey(n.target);
    const v = literal(n.args[0]);
    return key && typeof v === "string" ? { key, op: "contains", value: v } : null;
  }
  // (answers.k == null || !('v' in answers.k))
  if (n.t === "bin" && n.op === "||" && n.l.t === "bin" && n.l.op === "==" && n.r.t === "not" && n.r.e.t === "bin" && n.r.e.op === "in") {
    const key = answersKey(n.l.l);
    const inner = n.r.e;
    const v = literal(inner.l);
    if (key && literal(n.l.r) === null && typeof v === "string" && answersKey(inner.r) === key) return { key, op: "excludes", value: v };
    return null;
  }
  if (n.t !== "bin") return null;
  if (n.op === "in") {
    const key = answersKey(n.r);
    const v = literal(n.l);
    return key && typeof v === "string" ? { key, op: "includes", value: v } : null;
  }
  if (n.op === "==" || n.op === "!=") {
    // answers.k['Row'] == 'Col' and answers.k[0] == 'v'
    if (n.l.t === "idx" && n.op === "==") {
      const key = answersKey(n.l.obj);
      const at = literal(n.l.index);
      const v = literal(n.r);
      if (key && typeof v === "string" && typeof at === "string") return { key, op: "cell", value: v, row: at };
      if (key && typeof v === "string" && at === 0) return { key, op: "first", value: v };
      return null;
    }
    const key = answersKey(n.l);
    const v = literal(n.r);
    if (!key || v === undefined) return null;
    const equals = n.op === "==";
    if (v === null) return { key, op: equals ? "empty" : "answered", value: "" };
    if (v === true) return { key, op: equals ? "checked" : "unchecked", value: "" };
    const kind = kinds.get(key);
    if (typeof v === "number") return { key, op: equals ? "eq" : "ne", value: String(v) };
    if (typeof v === "string") return { key, op: kind && ordered(kind) ? (equals ? "eq" : "ne") : equals ? "is" : "is_not", value: v };
    return null;
  }
  const op = SYMBOLS[n.op];
  if (op) {
    const key = answersKey(n.l);
    const v = literal(n.r);
    return key && (typeof v === "number" || typeof v === "string") ? { key, op, value: String(v) } : null;
  }
  return null;
}

/** The rules a condition is, when it is exactly what rules write (all joined by && or all by ||);
 *  null for any other. An empty condition is no rules. */
export function fromCel(src: string, rows: QRow[]): Condition | null {
  if (!src.trim()) return { join: "all", rules: [] };
  const program = compile(src);
  if (!program) return null;
  const kinds = new Map(rows.map((r) => [r.key, r.question_type]));
  const single = oneRule(program.ast, kinds);
  if (single) return { join: "all", rules: [single] };
  const top = program.ast;
  if (top.t !== "bin" || (top.op !== "&&" && top.op !== "||")) return null;
  const items: Node[] = [];
  const flatten = (n: Node): void => {
    if (n.t === "bin" && n.op === top.op && !oneRule(n, kinds)) {
      flatten(n.l);
      flatten(n.r);
    } else items.push(n);
  };
  flatten(top);
  const rules: Rule[] = [];
  for (const item of items) {
    const r = oneRule(item, kinds);
    if (!r) return null;
    rules.push(r);
  }
  return { join: top.op === "&&" ? "all" : "any", rules };
}

// ───────────────────────────── in words ─────────────────────────────

/** A condition as a sentence: "Country is “IN” and Age is at least “18”". */
export function describe(c: Condition, rows: QRow[]): string {
  const by = new Map(rows.map((r) => [r.key, r]));
  const parts = c.rules
    .filter((r) => r.key)
    .map((r) => {
      const q = by.get(r.key);
      const name = q?.label.trim() || r.key;
      const op = opLabel(r.op, q?.question_type ?? "short_text");
      if (r.op === "cell") return `${name}: “${r.row ?? ""}” ${op} “${r.value}”`;
      return needsValue(r.op) ? `${name} ${op} “${r.value}”` : `${name} ${op}`;
    });
  return parts.join(c.join === "all" ? " and " : " or ");
}
