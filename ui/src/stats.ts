// The numbers a form has gathered, as the screens show them: the shapes the server answers with
// (src/analytics.rs), dates in the workspace's days, and the small calculations a chart needs.
// Pure, so it is tested without a browser.

import type { Kind } from "./model";
import { t as tr } from "@ferrum/client";

export interface Share {
  count: number;
  percent: string | null;
}

export interface QSummary {
  key: string;
  label: string;
  type: Kind;
  answered: number;
  skipped: number;
  options?: { option: string; count: number; percent: string | null }[];
  other?: Share;
  yes?: Share;
  no?: Share;
  distribution?: { value: number; count: number; percent: string | null }[];
  average?: string | null;
  promoters?: Share;
  passives?: Share;
  detractors?: Share;
  nps?: string | null;
  sum?: string;
  min?: string | null;
  max?: string | null;
  rows?: { row: string; answered: number; columns: { column: string; count: number; percent: string | null }[] }[];
  items?: { item: string; average_rank: string | null; first_place: number }[];
  files?: number;
}

export interface Summary {
  form: { id: string; title: string; kind: string | null; status: string; slug: string };
  from: string | null;
  to: string | null;
  responses: number;
  spam: number;
  views: number;
  completion_rate: string | null;
  completion_time: { average_seconds: string | null; median_seconds: string | null };
  quiz: null | { graded: number; average_score: string | null; average_percent: string | null; passed: number; failed: number; pass_rate: string | null };
  trend: { date: string; responses: number }[];
  questions: QSummary[];
}

export interface AnswersPage {
  question: { key: string; label: string; type: Kind };
  answers: { response: string; number: string | null; submitted_at: string; text: string; answer: unknown }[];
  next_cursor: string | null;
}

/** A share the server rounded ("66.67") as a number for drawing; nothing is 0. */
export const num = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** 125 → "2 min 5 s"; null → "–". */
export function duration(seconds: string | number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds === "") return "–";
  const s = Math.round(num(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 ? tr("{n} min {value} s", { n: Math.floor(s / 60), value: s % 60 }) : tr("{n} min", { n: Math.floor(s / 60) });
  const m = Math.round((s % 3600) / 60);
  return m ? tr("{n} h {m} min", { n: Math.floor(s / 3600), m }) : `${Math.floor(s / 3600)} h`;
}

/** A percentage the server rounded, without a trailing ".00" ("33.33" stays, "50" stays). */
export const percent = (v: string | null | undefined): string => (v === null || v === undefined ? "–" : `${num(v)}%`);

// ───────────────────────────── days ─────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** A day a number of days later (or earlier). */
export function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export type Preset = "7" | "30" | "month" | "all";

/** The periods a person picks, each with its name in the page's language. */
export const presets = (): [Preset, string][] => [
  ["7", tr("Last 7 days")],
  ["30", tr("Last 30 days")],
  ["month", tr("This month")],
  ["all", tr("All time")],
];

/** The days a preset covers, ending today: [from, to] (null: open). */
export function presetRange(p: Preset, today: string): [string | null, string | null] {
  if (p === "all") return [null, null];
  if (p === "month") return [`${today.slice(0, 8)}01`, today];
  return [shiftDay(today, -(Number(p) - 1)), today];
}

/** Which preset the dates are, if any. */
export function presetOf(from: string | null, to: string | null, today: string): Preset | null {
  if (!from && !to) return "all";
  return presets().map(([p]) => p).find((p) => {
    const [a, b] = presetRange(p, today);
    return a === from && b === to;
  }) ?? null;
}

/** The instant a local day starts in a time zone (RFC 3339, UTC): the filter of a list that
 *  holds instants, for the days the workspace counts. */
export function dayStart(date: string, zone: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d);
  const offsetAt = (t: number) => {
    let tz = zone;
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
    } catch {
      tz = "UTC";
    }
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
  };
  // Twice, because the offset is the one at the answer, not at the guess.
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t).toISOString();
}

// ───────────────────────────── charts ─────────────────────────────

/** NPS groups: 0 to 6 detractors, 7 and 8 passives, 9 and 10 promoters. */
export const npsGroup = (value: number): "detractor" | "passive" | "promoter" => (value >= 9 ? "promoter" : value >= 7 ? "passive" : "detractor");

export interface Line {
  line: string;
  area: string;
  max: number;
  dots: { x: number; y: number; date: string; responses: number }[];
}

/** The daily responses as a line in a box of `w` by `h`, with room at the bottom and top. */
export function trendLine(trend: { date: string; responses: number }[], w: number, h: number, pad = 8): Line {
  const max = Math.max(1, ...trend.map((t) => t.responses));
  const step = trend.length > 1 ? (w - pad * 2) / (trend.length - 1) : 0;
  const dots = trend.map((t, i) => ({ x: pad + (trend.length > 1 ? i * step : (w - pad * 2) / 2), y: h - pad - (t.responses / max) * (h - pad * 2), date: t.date, responses: t.responses }));
  const line = dots.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = dots.length ? `${line} L${dots[dots.length - 1].x.toFixed(1)} ${h - pad} L${dots[0].x.toFixed(1)} ${h - pad} Z` : "";
  return { line, area, max, dots };
}

// ───────────────────────────── answers ─────────────────────────────

export interface Asked {
  key: string;
  label: string;
  type: Kind;
  rows?: string[];
}

/** An answer as a line of words (src/answers.rs `display`). */
export function answerText(type: Kind, v: unknown, rows: string[] = []): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (type === "ranking" && Array.isArray(v)) return v.map(String).join(" › ");
  if (type === "file" && Array.isArray(v)) return v.map((f) => (f as { file_name?: string }).file_name ?? "").filter(Boolean).join(", ");
  if (type === "matrix" && typeof v === "object" && !Array.isArray(v)) {
    const m = v as Record<string, unknown>;
    return rows.filter((r) => typeof m[r] === "string").map((r) => `${r}: ${m[r]}`).join("; ");
  }
  if (Array.isArray(v)) return v.map(String).join(", ");
  return String(v);
}
