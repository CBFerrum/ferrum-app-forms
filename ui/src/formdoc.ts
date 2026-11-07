// The Form record as the builder edits it: the settings in one place, the questions in another,
// what changed since the last save (the server takes a patch), and what the server's refusals
// mean on the screen (a field, or a card).

import type { ApiError } from "@ferrum/client";
import { t as tr } from "@ferrum/client";
import type { Tone } from "@ferrum/kit";
import { type Problem, type QRow, rowFromDoc, rowToDoc } from "./rows";
import { sentence } from "./flow";

export interface MapRow {
  target_field: string;
  question: string;
  value: string;
}

/** The settings of a form (everything but its questions, status and history). */
export interface Fields {
  title: string;
  kind: "Form" | "Survey" | "Quiz";
  description: string;
  slug: string;
  access: "Public" | "Internal";
  layout: "Pages" | "One question at a time";
  anonymous: boolean;
  opens_at: string | null;
  closes_at: string | null;
  response_limit: number | null;
  one_response_per: "" | "Email" | "User";
  email_question: string;
  min_fill_seconds: number | null;
  confirmation_message: string;
  redirect_url: string;
  closed_message: string;
  notify_on_response: boolean;
  notify_users: string[];
  autoresponder: boolean;
  autoresponder_subject: string;
  autoresponder_message: string;
  accent_color: string | null;
  logo: string | null;
  passing_score: string;
  reveal_answers: boolean;
  target_entity: string;
  field_map: MapRow[];
}

export interface Draft {
  fields: Fields;
  rows: QRow[];
}

export type Status = "Draft" | "Published" | "Closed";

/** How a form's status is drawn, and what it is called (Published reads "Open"). */
export const STATUS_TONE: Record<Status, Tone> = { Draft: "neutral", Published: "green", Closed: "amber" };
export const STATUS_LABEL: Record<Status, string> = { Draft: "Draft", Published: "Open", Closed: "Closed" };

/** A Form as the API sends it. */
export interface FormDoc extends Record<string, unknown> {
  id: string;
  version: number;
  status?: Status;
  published_at?: string | null;
  questions?: Record<string, unknown>[];
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

export function fieldsOf(d: FormDoc): Fields {
  const pick = <T extends string>(v: unknown, ok: readonly T[], dflt: T): T => (ok.includes(v as T) ? (v as T) : dflt);
  return {
    title: s(d.title),
    kind: pick(d.kind, ["Form", "Survey", "Quiz"], "Form"),
    description: s(d.description),
    slug: s(d.slug),
    access: pick(d.access, ["Public", "Internal"], "Public"),
    layout: pick(d.layout, ["Pages", "One question at a time"], "Pages"),
    anonymous: d.anonymous === true,
    opens_at: s(d.opens_at) || null,
    closes_at: s(d.closes_at) || null,
    response_limit: n(d.response_limit),
    one_response_per: pick(d.one_response_per, ["Email", "User"], "" as "" | "Email" | "User"),
    email_question: s(d.email_question),
    min_fill_seconds: n(d.min_fill_seconds),
    confirmation_message: s(d.confirmation_message),
    redirect_url: s(d.redirect_url),
    closed_message: s(d.closed_message),
    notify_on_response: d.notify_on_response === true,
    notify_users: list(d.notify_users).map((r) => s(r.email)).filter(Boolean),
    autoresponder: d.autoresponder === true,
    autoresponder_subject: s(d.autoresponder_subject),
    autoresponder_message: s(d.autoresponder_message),
    accent_color: s(d.accent_color) || null,
    logo: s(d.logo) || null,
    passing_score: s(d.passing_score),
    reveal_answers: d.reveal_answers === true,
    target_entity: s(d.target_entity),
    field_map: list(d.field_map).map((r) => ({ target_field: s(r.target_field), question: s(r.question), value: s(r.value) })),
  };
}

/** The draft a saved form starts as. `previous` keeps the rows' identities on the screen. */
export function draftOf(d: FormDoc, previous: QRow[] = []): Draft {
  return { fields: fieldsOf(d), rows: list(d.questions).map((r, i) => ({ ...rowFromDoc(r), uid: previous[i]?.uid ?? (typeof r.id === "string" ? r.id : rowFromDoc(r).uid) })) };
}

const nul = (v: string): string | null => (v.trim() === "" ? null : v);

/** One setting as the server takes it. */
function out(key: keyof Fields, v: Fields[keyof Fields]): unknown {
  switch (key) {
    case "title":
    case "kind":
    case "access":
    case "layout":
    case "anonymous":
    case "notify_on_response":
    case "autoresponder":
    case "reveal_answers":
      return v;
    case "notify_users":
      return (v as string[]).map((email) => ({ email }));
    case "field_map":
      return (v as MapRow[]).map((r) => ({ target_field: r.target_field, question: nul(r.question), value: nul(r.value) }));
    default:
      return typeof v === "string" ? nul(v) : v;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What changed since `saved`, as a patch. */
export function patchOf(saved: Draft, now: Draft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(now.fields) as (keyof Fields)[]) if (!same(saved.fields[key], now.fields[key])) patch[key] = out(key, now.fields[key]);
  if (!same(saved.rows.map(rowToDoc), now.rows.map(rowToDoc))) patch.questions = now.rows.map(rowToDoc);
  return patch;
}

export const dirty = (saved: Draft, now: Draft): boolean => Object.keys(patchOf(saved, now)).length > 0;

// ───────────────────────────── the server's refusals ─────────────────────────────

export interface Refusal {
  /** By setting. */
  fields: Record<string, string>;
  /** By question (its uid on the screen). */
  cards: Record<string, Problem[]>;
  /** Anything that belongs to neither. */
  other: string[];
}

/** Which setting or card each of the server's field errors is about (`row: ["questions", n]`). */
export function refusal(e: Pick<ApiError, "fields" | "message">, rows: QRow[]): Refusal {
  const r: Refusal = { fields: {}, cards: {}, other: [] };
  for (const f of e.fields) {
    if (f.row?.[0] === "questions") {
      const card = rows[f.row[1]];
      if (card) (r.cards[card.uid] ??= []).push({ field: f.field, message: sentence(f.message) });
      else r.other.push(sentence(f.message));
    } else if (f.row) {
      r.fields[f.row[0]] ??= `${f.row[0] === "notify_users" ? "" : tr("Row {value}: ", { value: f.row[1] + 1 })}${sentence(f.message)}`;
    } else r.fields[f.field] ??= sentence(f.message);
  }
  return r;
}

export const refused = (r: Refusal): number => Object.keys(r.fields).length + Object.values(r.cards).reduce((t, p) => t + p.length, 0) + r.other.length;
