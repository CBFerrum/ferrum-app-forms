import { t as tr } from "@ferrum/client";
// The conditions of a form (`visible_if`) are CEL, the language of every Ferrum rule. Respondents'
// browsers run them as people answer, so questions and pages appear and go away at once; the
// server runs the same conditions again when a response arrives and is the judge (src/logic.rs).
// This is a small CEL with the server's meaning: comparing nothing with a number is an error, and
// an error makes a condition false. What it cannot run (timestamps, other functions) it says so:
// the caller then shows the question, because a question wrongly shown costs nothing (its answer
// is dropped) and one wrongly hidden could never be answered.

/** A CEL double, apart from the whole numbers (a decimal answer such as 10.0 stays a double). */
export class Dbl {
  constructor(readonly v: number) {}
}

/** What a failed step of a condition leaves (a missing key, comparing a text with a number). */
export class CelError {
  constructor(readonly message: string) {}
}

/** Something in the condition this evaluator does not know. */
export class Unsupported extends Error {}

export type Val = null | boolean | number | Dbl | string | Val[] | Map<string, Val>;
type R = Val | CelError;

// ───────────────────────────── syntax ─────────────────────────────

export type Node =
  | { t: "lit"; v: Val }
  | { t: "id"; name: string }
  | { t: "sel"; obj: Node; field: string; test: boolean }
  | { t: "idx"; obj: Node; index: Node }
  | { t: "call"; fn: string; target: Node | null; args: Node[] }
  | { t: "list"; items: Node[] }
  | { t: "map"; entries: [Node, Node][] }
  | { t: "not"; e: Node }
  | { t: "neg"; e: Node }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "cond"; c: Node; a: Node; b: Node };

type Tok = { k: "num" | "str" | "id" | "sym" | "end"; v: string; n?: Val };

const SYMBOLS = ["<=", ">=", "==", "!=", "&&", "||", "<", ">", "+", "-", "*", "/", "%", "!", "?", ":", ".", ",", "(", ")", "[", "]", "{", "}"];
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"', "`": "`", "?": "?", a: "\x07", b: "\b", f: "\f", v: "\v" };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    const rest = src.slice(i);
    // A string, optionally raw (r"…") or bytes (b"…", which no condition needs).
    const sm = /^([rRbB]?)('''|"""|'|")/.exec(rest);
    if (sm) {
      if (/b/i.test(sm[1])) throw new Unsupported("bytes");
      const raw = sm[1] !== "";
      const quote = sm[2];
      let j = i + sm[0].length;
      let s = "";
      for (;;) {
        if (j >= src.length) throw new SyntaxError("unterminated string");
        if (src.startsWith(quote, j)) break;
        const ch = src[j];
        if (quote.length === 1 && ch === "\n") throw new SyntaxError("unterminated string");
        if (ch === "\\" && !raw) {
          const e = src[j + 1];
          if (e === "x" || e === "X") {
            s += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16));
            j += 4;
          } else if (e === "u") {
            s += String.fromCodePoint(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
          } else if (e === "U") {
            s += String.fromCodePoint(parseInt(src.slice(j + 2, j + 10), 16));
            j += 10;
          } else if (e >= "0" && e <= "3") {
            s += String.fromCharCode(parseInt(src.slice(j + 1, j + 4), 8));
            j += 4;
          } else if (e in ESCAPES) {
            s += ESCAPES[e];
            j += 2;
          } else throw new SyntaxError("bad escape");
        } else {
          s += ch;
          j++;
        }
      }
      out.push({ k: "str", v: s, n: s });
      i = j + quote.length;
      continue;
    }
    const nm = /^(0[xX][0-9a-fA-F]+[uU]?|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[uU]?)/.exec(rest);
    if (nm && (c !== "." || /\d/.test(src[i + 1] ?? ""))) {
      const t = nm[0];
      const unsigned = /[uU]$/.test(t) ? t.slice(0, -1) : t;
      const isDouble = !/^0[xX]/.test(unsigned) && /[.eE]/.test(unsigned);
      out.push({ k: "num", v: t, n: isDouble ? new Dbl(Number(unsigned)) : Number(unsigned) });
      i += t.length;
      continue;
    }
    const im = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (im) {
      out.push({ k: "id", v: im[0] });
      i += im[0].length;
      continue;
    }
    const sym = SYMBOLS.find((s) => src.startsWith(s, i));
    if (!sym) throw new SyntaxError(`unexpected character '${c}'`);
    out.push({ k: "sym", v: sym });
    i += sym.length;
  }
  out.push({ k: "end", v: "" });
  return out;
}

const MAX_DEPTH = 64;

function parse(src: string): Node {
  const toks = lex(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isSym = (v: string) => toks[p].k === "sym" && toks[p].v === v;
  const eat = (v: string) => (isSym(v) ? (p++, true) : false);
  const expect = (v: string) => {
    if (!eat(v)) throw new SyntaxError(`expected '${v}'`);
  };
  const deeper = <T>(f: () => T): T => {
    if (++depth > MAX_DEPTH) throw new SyntaxError("nested too deeply");
    try {
      return f();
    } finally {
      depth--;
    }
  };

  const expr = (): Node =>
    deeper(() => {
      const c = or();
      if (!eat("?")) return c;
      const a = or();
      expect(":");
      return { t: "cond", c, a, b: expr() };
    });
  const or = (): Node => {
    let l = and();
    while (eat("||")) l = { t: "bin", op: "||", l, r: and() };
    return l;
  };
  const and = (): Node => {
    let l = relation();
    while (eat("&&")) l = { t: "bin", op: "&&", l, r: relation() };
    return l;
  };
  const relation = (): Node => {
    let l = addition();
    for (;;) {
      const t = peek();
      const op = t.k === "sym" && ["<", "<=", ">=", ">", "==", "!="].includes(t.v) ? t.v : t.k === "id" && t.v === "in" ? "in" : null;
      if (!op) return l;
      p++;
      l = { t: "bin", op, l, r: addition() };
    }
  };
  const addition = (): Node => {
    let l = multiplication();
    while (isSym("+") || isSym("-")) {
      const op = toks[p++].v;
      l = { t: "bin", op, l, r: multiplication() };
    }
    return l;
  };
  const multiplication = (): Node => {
    let l = unary();
    while (isSym("*") || isSym("/") || isSym("%")) {
      const op = toks[p++].v;
      l = { t: "bin", op, l, r: unary() };
    }
    return l;
  };
  const unary = (): Node =>
    deeper(() => {
      if (eat("!")) return { t: "not", e: unary() };
      if (eat("-")) return { t: "neg", e: unary() };
      return member();
    });
  const args = (close: string): Node[] => {
    const out: Node[] = [];
    if (eat(close)) return out;
    do out.push(expr());
    while (eat(","));
    expect(close);
    return out;
  };
  const member = (): Node => {
    let n = primary();
    for (;;) {
      if (eat(".")) {
        const t = toks[p++];
        if (t.k !== "id") throw new SyntaxError("expected a name after '.'");
        n = eat("(") ? { t: "call", fn: t.v, target: n, args: args(")") } : { t: "sel", obj: n, field: t.v, test: false };
      } else if (eat("[")) {
        const index = expr();
        expect("]");
        n = { t: "idx", obj: n, index };
      } else return n;
    }
  };
  const primary = (): Node => {
    const t = toks[p++];
    if (t.k === "num" || t.k === "str") return { t: "lit", v: t.n as Val };
    if (t.k === "id") {
      if (t.v === "true" || t.v === "false") return { t: "lit", v: t.v === "true" };
      if (t.v === "null") return { t: "lit", v: null };
      if (eat("(")) return { t: "call", fn: t.v, target: null, args: args(")") };
      return { t: "id", name: t.v };
    }
    if (t.k === "sym") {
      if (t.v === "(") {
        const e = expr();
        expect(")");
        return e;
      }
      if (t.v === "[") {
        const items: Node[] = [];
        if (!eat("]")) {
          do {
            if (isSym("]")) break;
            items.push(expr());
          } while (eat(","));
          expect("]");
        }
        return { t: "list", items };
      }
      if (t.v === "{") {
        const entries: [Node, Node][] = [];
        if (!eat("}")) {
          do {
            if (isSym("}")) break;
            const k = expr();
            expect(":");
            entries.push([k, expr()]);
          } while (eat(","));
          expect("}");
        }
        return { t: "map", entries };
      }
    }
    throw new SyntaxError(t.k === "end" ? "the condition ends too soon" : `unexpected '${t.v}'`);
  };

  const ast = expr();
  if (peek().k !== "end") throw new SyntaxError(`unexpected '${peek().v}'`);
  return ast;
}

// ───────────────────────────── values ─────────────────────────────

/** JSON (answers) as CEL values: whole numbers are ints, other numbers doubles. */
export function toVal(j: unknown): Val {
  if (j === null || j === undefined) return null;
  if (typeof j === "boolean" || typeof j === "string") return j;
  if (typeof j === "number") return Number.isInteger(j) ? j : new Dbl(j);
  if (j instanceof Dbl) return j;
  if (Array.isArray(j)) return j.map(toVal);
  if (j instanceof Map) return new Map([...j].map(([k, v]) => [String(k), toVal(v)]));
  if (typeof j === "object") return new Map(Object.entries(j as Record<string, unknown>).map(([k, v]) => [k, toVal(v)]));
  return null;
}

const isNum = (v: R): v is number | Dbl => typeof v === "number" || v instanceof Dbl;
const num = (v: number | Dbl) => (v instanceof Dbl ? v.v : v);
const fail = (m: string) => new CelError(m);

function equal(a: Val, b: Val): boolean {
  if (isNum(a) && isNum(b)) return num(a) === num(b);
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (a instanceof Map) return b instanceof Map && a.size === b.size && [...a].every(([k, v]) => b.has(k) && equal(v, b.get(k) as Val));
  return typeof a === typeof b && a === b;
}

/** -1, 0, 1, or an error when the two cannot be ordered. */
function order(a: Val, b: Val): number | CelError {
  if (isNum(a) && isNum(b)) {
    const [x, y] = [num(a), num(b)];
    return x < y ? -1 : x > y ? 1 : x === y ? 0 : fail("not comparable");
  }
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  if (a === null && b === null) return 0;
  return fail("no ordering between these values");
}

const chars = (s: string) => [...s].length;

// ───────────────────────────── evaluation ─────────────────────────────

export interface Vars {
  answers: Val;
  today: string;
  now: string;
}

type Scope = Map<string, Val>;

function pattern(re: string): RegExp {
  try {
    return new RegExp(re, "u");
  } catch {
    throw new Unsupported("pattern");
  }
}

function truthy(v: R): boolean | CelError {
  return typeof v === "boolean" ? v : v instanceof CelError ? v : fail("expected true or false");
}

function run(n: Node, vars: Vars, scope: Scope): R {
  switch (n.t) {
    case "lit":
      return n.v;
    case "id": {
      if (scope.has(n.name)) return scope.get(n.name) as Val;
      if (n.name === "answers") return vars.answers;
      if (n.name === "today") return vars.today;
      if (n.name === "now") return vars.now;
      return fail(tr("undeclared reference to '{name}'", { name: n.name }));
    }
    case "sel": {
      const o = run(n.obj, vars, scope);
      if (o instanceof CelError) return o;
      if (n.test) return o instanceof Map ? o.has(n.field) : fail("has() needs a map");
      if (!(o instanceof Map)) return fail(tr("cannot read '{field}' of this value", { field: n.field }));
      return o.has(n.field) ? (o.get(n.field) as Val) : fail(tr("no such key '{field}'", { field: n.field }));
    }
    case "idx": {
      const o = run(n.obj, vars, scope);
      const i = run(n.index, vars, scope);
      if (o instanceof CelError) return o;
      if (i instanceof CelError) return i;
      if (Array.isArray(o)) {
        if (typeof i !== "number" && !(i instanceof Dbl && Number.isInteger(i.v))) return fail("a list is indexed by a whole number");
        const k = num(i as number | Dbl);
        return k >= 0 && k < o.length ? o[k] : fail("index out of range");
      }
      if (o instanceof Map) return typeof i === "string" && o.has(i) ? (o.get(i) as Val) : fail("no such key");
      return fail("cannot index this value");
    }
    case "list": {
      const out: Val[] = [];
      for (const it of n.items) {
        const v = run(it, vars, scope);
        if (v instanceof CelError) return v;
        out.push(v);
      }
      return out;
    }
    case "map": {
      const out = new Map<string, Val>();
      for (const [kn, vn] of n.entries) {
        const k = run(kn, vars, scope);
        const v = run(vn, vars, scope);
        if (k instanceof CelError) return k;
        if (v instanceof CelError) return v;
        if (typeof k !== "string") throw new Unsupported("map keys that are not text");
        out.set(k, v);
      }
      return out;
    }
    case "not": {
      const v = run(n.e, vars, scope);
      return typeof v === "boolean" ? !v : v instanceof CelError ? v : fail("! needs true or false");
    }
    case "neg": {
      const v = run(n.e, vars, scope);
      if (v instanceof CelError) return v;
      return typeof v === "number" ? -v : v instanceof Dbl ? new Dbl(-v.v) : fail("cannot negate this value");
    }
    case "cond": {
      const c = truthy(run(n.c, vars, scope));
      if (c instanceof CelError) return c;
      return run(c ? n.a : n.b, vars, scope);
    }
    case "bin":
      return binary(n, vars, scope);
    case "call":
      return call(n, vars, scope);
  }
}

function binary(n: Extract<Node, { t: "bin" }>, vars: Vars, scope: Scope): R {
  // && and || take an error from one side when the other decides (false && error is false).
  if (n.op === "&&" || n.op === "||") {
    const want = n.op === "||";
    const l = truthy(run(n.l, vars, scope));
    if (l === want) return want;
    const r = truthy(run(n.r, vars, scope));
    if (r === want) return want;
    if (l instanceof CelError) return l;
    if (r instanceof CelError) return r;
    return !want;
  }
  const l = run(n.l, vars, scope);
  const r = run(n.r, vars, scope);
  if (l instanceof CelError) return l;
  if (r instanceof CelError) return r;
  switch (n.op) {
    case "==":
      return equal(l, r);
    case "!=":
      return !equal(l, r);
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const o = order(l, r);
      if (o instanceof CelError) return o;
      return n.op === "<" ? o < 0 : n.op === "<=" ? o <= 0 : n.op === ">" ? o > 0 : o >= 0;
    }
    case "in":
      if (Array.isArray(r)) return r.some((x) => equal(l, x));
      if (r instanceof Map) return typeof l === "string" ? r.has(l) : fail("a map is searched by text");
      return fail("in needs a list or a map");
    case "+":
      if (typeof l === "string" && typeof r === "string") return l + r;
      if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
      break;
  }
  if (isNum(l) && isNum(r)) {
    const dbl = l instanceof Dbl || r instanceof Dbl;
    const [x, y] = [num(l), num(r)];
    const wrap = (v: number) => (dbl ? new Dbl(v) : v);
    switch (n.op) {
      case "+":
        return wrap(x + y);
      case "-":
        return wrap(x - y);
      case "*":
        return wrap(x * y);
      case "/":
        return dbl ? new Dbl(x / y) : y === 0 ? fail("division by zero") : Math.trunc(x / y);
      case "%":
        return dbl ? fail("% needs whole numbers") : y === 0 ? fail("modulus by zero") : x % y;
    }
  }
  return fail(tr("{op} does not work on these values", { op: n.op }));
}

const MACROS = new Set(["exists", "all", "exists_one", "existsOne", "map", "filter"]);

function call(n: Extract<Node, { t: "call" }>, vars: Vars, scope: Scope): R {
  const { fn } = n;
  if (n.target && MACROS.has(fn)) return macro(n, vars, scope);
  if (!n.target && fn === "has") {
    const a = n.args[0];
    if (n.args.length === 1 && a.t === "sel") return run({ ...a, test: true }, vars, scope);
    throw new Unsupported("has");
  }
  const target = n.target ? run(n.target, vars, scope) : undefined;
  if (target instanceof CelError) return target;
  const args: Val[] = [];
  for (const a of n.args) {
    const v = run(a, vars, scope);
    if (v instanceof CelError) return v;
    args.push(v);
  }
  const all: Val[] = target === undefined ? args : [target, ...args];
  const [s, a1] = all;
  switch (fn) {
    case "size":
      if (all.length !== 1) break;
      return typeof s === "string" ? chars(s) : Array.isArray(s) ? s.length : s instanceof Map ? s.size : fail("size() needs text, a list or a map");
    case "contains":
    case "startsWith":
    case "endsWith":
      if (all.length !== 2 || !n.target) break;
      if (typeof s !== "string" || typeof a1 !== "string") return fail(tr("{fn}() needs text", { fn }));
      return fn === "contains" ? s.includes(a1) : fn === "startsWith" ? s.startsWith(a1) : s.endsWith(a1);
    case "matches":
      if (all.length !== 2) break;
      if (typeof s !== "string" || typeof a1 !== "string") return fail("matches() needs text");
      return pattern(a1).test(s);
    case "int":
      if (all.length !== 1 || n.target) break;
      if (typeof s === "number") return s;
      if (s instanceof Dbl) return Number.isFinite(s.v) ? Math.trunc(s.v) : fail("out of range");
      if (typeof s === "string" && /^[+-]?\d+$/.test(s.trim())) return Number(s.trim());
      return fail("int() cannot read this value");
    case "double":
      if (all.length !== 1 || n.target) break;
      if (isNum(s as R)) return new Dbl(num(s as number | Dbl));
      if (typeof s === "string" && s.trim() !== "" && Number.isFinite(Number(s))) return new Dbl(Number(s));
      return fail("double() cannot read this value");
    case "string":
      if (all.length !== 1 || n.target) break;
      if (typeof s === "string") return s;
      if (typeof s === "number") return String(s);
      if (s instanceof Dbl) return String(s.v);
      if (typeof s === "boolean") return String(s);
      return fail("string() cannot show this value");
  }
  throw new Unsupported(fn);
}

function macro(n: Extract<Node, { t: "call" }>, vars: Vars, scope: Scope): R {
  const range = run(n.target as Node, vars, scope);
  if (range instanceof CelError) return range;
  const [v, ...rest] = n.args;
  if (!v || v.t !== "id" || rest.length === 0 || rest.length > 2) throw new Unsupported(n.fn);
  const items = Array.isArray(range) ? range : range instanceof Map ? [...range.keys()] : null;
  if (!items) return fail(tr("{fn}() needs a list or a map", { fn: n.fn }));
  const inner = (item: Val) => new Map(scope).set(v.name, item);
  const test = (item: Val) => truthy(run(rest[rest.length - 1], vars, inner(item)));
  switch (n.fn) {
    case "exists":
    case "all": {
      const want = n.fn === "exists";
      let error: CelError | null = null;
      for (const it of items) {
        const r = test(it);
        if (r === want) return want;
        if (r instanceof CelError) error ??= r;
      }
      return error ?? !want;
    }
    case "exists_one":
    case "existsOne": {
      let count = 0;
      for (const it of items) {
        const r = test(it);
        if (r instanceof CelError) return r;
        if (r) count++;
      }
      return count === 1;
    }
    case "filter": {
      const out: Val[] = [];
      for (const it of items) {
        const r = test(it);
        if (r instanceof CelError) return r;
        if (r) out.push(it);
      }
      return out;
    }
    default: {
      // map(x, f) or map(x, filter, f)
      const out: Val[] = [];
      for (const it of items) {
        if (rest.length === 2) {
          const keep = truthy(run(rest[0], vars, inner(it)));
          if (keep instanceof CelError) return keep;
          if (!keep) continue;
        }
        const r = run(rest[rest.length - 1], vars, inner(it));
        if (r instanceof CelError) return r;
        out.push(r);
      }
      return out;
    }
  }
}

// ───────────────────────────── the public face ─────────────────────────────

export interface Program {
  source: string;
  ast: Node;
}

const compiled = new Map<string, Program | null>();

/** The condition read, or null when it is not CEL this evaluator reads (the server says whether
 *  it is CEL at all, on save). */
export function compile(source: string): Program | null {
  const src = source.trim();
  if (compiled.has(src)) return compiled.get(src) ?? null;
  let program: Program | null = null;
  try {
    program = { source: src, ast: parse(src) };
  } catch {
    program = null;
  }
  if (compiled.size > 2000) compiled.clear();
  compiled.set(src, program);
  return program;
}

/** The result of a condition: true or false as the server decides it (an error is false), or
 *  undefined when it uses something this evaluator does not run. */
export function holds(program: Program, vars: Vars): boolean | undefined {
  try {
    return run(program.ast, vars, new Map()) === true;
  } catch (e) {
    if (e instanceof Unsupported) return undefined;
    throw e;
  }
}

/** The questions a condition reads: `answers.key` and `answers['key']`, in order of appearance. */
export function answerKeys(program: Program): string[] {
  const keys: string[] = [];
  const isAnswers = (n: Node) => n.t === "id" && n.name === "answers";
  const walk = (n: Node): void => {
    switch (n.t) {
      case "sel":
        if (isAnswers(n.obj)) keys.push(n.field);
        else walk(n.obj);
        return;
      case "idx":
        if (isAnswers(n.obj) && n.index.t === "lit" && typeof n.index.v === "string") keys.push(n.index.v);
        else {
          walk(n.obj);
        }
        walk(n.index);
        return;
      case "call":
        if (n.target) walk(n.target);
        n.args.forEach(walk);
        return;
      case "list":
        n.items.forEach(walk);
        return;
      case "map":
        n.entries.forEach(([k, v]) => (walk(k), walk(v)));
        return;
      case "not":
      case "neg":
        walk(n.e);
        return;
      case "bin":
        walk(n.l);
        walk(n.r);
        return;
      case "cond":
        walk(n.c);
        walk(n.a);
        walk(n.b);
        return;
      default:
    }
  };
  walk(program.ast);
  return [...new Set(keys)];
}

/** A CEL text literal: 'Don\'t' → 'Don\'t'. */
export function quote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}'`;
}
