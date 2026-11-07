// Putting the form in front of people: its link, who the link is for, when it works, and the
// link that fills some answers in. The address of a published form is not changed without asking:
// every link already sent would stop working.

import { Copy, ExternalLink, Globe, Lock } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { bootstrap, formatDateTime, t as tr, isolate } from "@ferrum/client";
import { confirmDialog, Field, toast } from "@ferrum/kit";
import type { QRow } from "./rows";
import type { Fields, Status } from "./formdoc";
import { formPath } from "./site";

/** The whole address of a form. */
export function linkOf(slug: string): string {
  const tenant = bootstrap()?.workspace.slug ?? "";
  return `${window.location.origin}${formPath(tenant, slug)}`;
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(tr("Link copied"));
  } catch {
    toast(text, "info");
  }
}

const moment = (iso: string | null) => (iso ? formatDateTime(iso) : null);

export interface ShareProps {
  fields: Fields;
  set: (p: Partial<Fields>) => void;
  rows: QRow[];
  status: Status;
  /** The address this form has on the server (the draft's may be changed, not yet saved). */
  savedSlug: string;
  errors: Record<string, string>;
  dirty: boolean;
  onPublish: () => void;
  onSettings: () => void;
  publishing: boolean;
}

export function Share({ fields: f, set, rows, status, savedSlug, errors, dirty, onPublish, onSettings, publishing }: ShareProps) {
  const id = useId();
  const [pick, setPick] = useState("");
  const live = status === "Published";
  const url = savedSlug ? linkOf(savedSlug) : "";
  const prefills = rows.filter((r) => r.allow_prefill && r.question_type !== "page_break");
  const chosen = prefills.find((r) => r.key === pick) ?? prefills[0];
  const facts = [
    f.access === "Public" ? "Anyone with the link can answer." : "Only people signed in to this workspace can answer.",
    f.anonymous ? "Answers are anonymous." : null,
    f.opens_at && new Date(f.opens_at) > new Date() ? `Opens ${moment(f.opens_at)}.` : null,
    f.closes_at ? `Closes ${moment(f.closes_at)}.` : null,
    f.response_limit ? `Closes after ${f.response_limit} responses.` : null,
    f.one_response_per === "Email" ? "One response per email address." : f.one_response_per === "User" ? "One response per person." : null,
  ].filter(Boolean);

  // The address is typed, and set when the field is left: a live form asks first.
  const [typed, setTyped] = useState(f.slug);
  useEffect(() => setTyped(f.slug), [f.slug]);
  const leave = async () => {
    const next = typed.trim().toLowerCase();
    if (next === f.slug) return;
    if (live && savedSlug && next !== savedSlug) {
      const ok = await confirmDialog({ title: tr("Change the address?"), message: tr("Links already sent to {savedSlug} will stop working once you save.", { savedSlug }), confirmLabel: tr("Change it"), danger: true });
      if (!ok) {
        setTyped(f.slug);
        return;
      }
    }
    set({ slug: next });
  };

  return (
    <div className="fm-share">
      {!live && (
        <div className="fm-callout">
          <div>
            <strong>{status === "Closed" ? tr("This form is closed.") : tr("This form is a draft.")}</strong>
            <p className="muted">{status === "Closed" ? tr("Its link tells people it is closed. Reopen it to take responses again.") : tr("Its link does not work yet. Publish it to take responses.")}</p>
          </div>
          <button type="button" className="btn btn-primary btn-md" disabled={publishing} onClick={onPublish}>
            {status === "Closed" ? tr("Reopen") : tr("Publish")}
            {dirty ? tr(" and save") : ""}
          </button>
        </div>
      )}

      <section className="fm-section">
        <h2 className="fm-section-title">{tr("The link")}</h2>
        {url ? (
          <>
            <div className="fm-link" data-live={live ? "" : undefined}>
              <input className="input" readOnly aria-label={tr("The link to this form")} value={url} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn btn-primary btn-md" onClick={() => void copy(url)}>
                <Copy size={16} aria-hidden="true" /> {tr("Copy")}
              </button>
              <a className="btn btn-default btn-md" href={url} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={16} aria-hidden="true" /> {tr("Open")}
              </a>
            </div>
            {!live && <p className="field-hint">{tr("Not working yet.")}</p>}
          </>
        ) : (
          <p className="muted">{tr("The link appears when the form is saved.")}</p>
        )}
        <ul className="fm-facts">
          <li>
            {f.access === "Public" ? <Globe size={15} aria-hidden="true" /> : <Lock size={15} aria-hidden="true" />}
            {isolate(facts[0] ?? "")}
          </li>
          {facts.slice(1).map((t) => (
            <li key={t as string}>{isolate(t ?? "")}</li>
          ))}
        </ul>
        <button type="button" className="link-btn" onClick={onSettings}>
          {tr("Change who can answer and when")}
        </button>
      </section>

      <section className="fm-section">
        <h2 className="fm-section-title">{tr("Its address")}</h2>
        <Field label={tr("The last part of the link")} htmlFor={`${id}-slug`} hint={tr("Lower-case letters, numbers and hyphens.")} error={errors.slug}>
          <input id={`${id}-slug`} className="input" value={typed} spellCheck={false} autoCapitalize="off" onChange={(e) => setTyped(e.target.value.toLowerCase().replace(/\s+/g, "-"))} onBlur={() => void leave()} />
        </Field>
      </section>

      {prefills.length > 0 && savedSlug && (
        <section className="fm-section">
          <h2 className="fm-section-title">{tr("A link that fills in an answer")}</h2>
          <p className="muted">{tr("Add")} <code>?{isolate(chosen.key)}=…</code> {tr("to the link to start with an answer filled in, for example in an email to one person.")}</p>
          <div className="fm-link">
            <select className="select" aria-label={tr("Question to fill in")} value={chosen.key} onChange={(e) => setPick(e.target.value)}>
              {prefills.map((r) => (
                <option key={r.uid} value={r.key}>
                  {r.label.trim() || r.key}
                </option>
              ))}
            </select>
            <input className="input" readOnly aria-label={tr("The link with an answer filled in")} value={`${url}?${chosen.key}=`} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn btn-default btn-md" onClick={() => void copy(`${url}?${chosen.key}=`)}>
              <Copy size={16} aria-hidden="true" /> {tr("Copy")}
            </button>
          </div>
          <p className="field-hint">{tr("Type the answer after the equals sign. Several choices are separated by commas.")}</p>
        </section>
      )}
    </div>
  );
}
