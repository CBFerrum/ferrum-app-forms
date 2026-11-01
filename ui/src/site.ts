// Where the respondent endpoints are and how their answers read: the public ones
// (`/api/site/{workspace}/forms`), the signed-in ones for forms the workspace's people answer
// (`/api/app/forms`), a closed form's reasons, and the addresses that lead to a form.

import { routeBase } from "@ferrum/client";

export const siteBase = (tenant: string) => `/api/site/${encodeURIComponent(tenant)}/forms`;
export const APP_BASE = "/api/app/forms";

/** The address of a form's page: /forms/f/{workspace}/{form}. */
export function formPath(tenant: string, slug: string): string {
  return `${routeBase("forms")}f/${encodeURIComponent(tenant)}/${encodeURIComponent(slug)}`;
}

/** The address of a quiz result a respondent can come back to. */
export function resultPath(tenant: string, slug: string, token: string): string {
  return `${formPath(tenant, slug)}/result/${encodeURIComponent(token)}`;
}

export const loginPath = (next: string) => `/login?next=${encodeURIComponent(next)}`;

/** Where to send people after they answer: a web address only. */
export function safeRedirect(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export interface Closed {
  title: string;
  body: string | null;
  /** When a form that is not open yet opens. */
  opensAt: Date | null;
}

const DEFAULT_CLOSED = "This form is not accepting responses.";
const DEFAULT_FULL = "This form has reached its response limit.";

/** What a 409 on opening a form says (src/form.rs `accepting`, src/site.rs): not open yet, full,
 *  closed, or the words its owner wrote for it. */
export function closedState(message: string): Closed {
  const m = message.trim();
  const opens = /^This form opens at (\S+?)\.?$/.exec(m);
  if (opens) {
    const at = new Date(opens[1]);
    if (!Number.isNaN(at.getTime())) return { title: "This form is not open yet", body: `It opens on ${at.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}.`, opensAt: at };
  }
  if (m === DEFAULT_FULL) return { title: "This form is full", body: "It has all the responses it was set up to take.", opensAt: null };
  if (!m || m === DEFAULT_CLOSED) return { title: "This form is closed", body: "It is not taking responses any more.", opensAt: null };
  return { title: "This form is closed", body: m, opensAt: null };
}

export const ALREADY = "A response was already received from you for this form.";

/** The session of the page ran out (it was open for a day) and was renewed: the answers stay, and
 *  sending them again is all that is left. */
export class Refreshed extends Error {}
