// A form's settings: who may answer and how often, when, what happens after, who is told, how it
// looks, how a quiz is marked, and the record each response can create. Whatever the server
// refuses on save shows under the setting it is about.

import { Plus, Trash2, Upload, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { api, errorMessage, t as tr, isolate } from "@ferrum/client";
import { Field, toast } from "@ferrum/kit";
import { useEntityMeta, useMetaIndex } from "@ferrum/records";
import { alwaysShown, fits, lines, type QRow } from "./rows";
import type { Fields, MapRow } from "./formdoc";
import { hexOf } from "./accent";

const zone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return tr("your time zone");
  }
})();

/** An instant as the local value a date-time input holds, and back. */
const toInput = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromInput = (v: string): string | null => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="fm-section">
      <h2 className="fm-section-title">{isolate(title)}</h2>
      {hint && <p className="muted fm-section-hint">{hint}</p>}
      <div className="fm-section-body">{children}</div>
    </section>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {isolate(text)}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────────── the record a response creates ─────────────────────────────

const OWN = ["Form", "FormResponse", "FormsSettings"];
/** A line of the mapping that takes a fixed value: it has neither a question nor, yet, a value
 *  (a blank is sent as nothing, so the line only waits to be filled in). */
const FIXED = "\u0001fixed";

function Mapping({ fields, set, rows, error }: { fields: Fields; set: (p: Partial<Fields>) => void; rows: QRow[]; error?: string }) {
  const index = useMetaIndex().data;
  const entity = useEntityMeta(fields.target_entity || undefined).data;
  const id = useId();
  const targets = (index?.entities ?? []).filter((e) => (e.kind === "master" || e.kind === "document") && e.permissions.create !== "none" && !OWN.includes(e.name));
  const writable = (entity?.fields ?? []).filter((f) => !f.read_only && !f.computed && f.can_write !== false && f.type !== "table" && f.type !== "secret" && !f.hidden);
  const questions = rows.filter((r) => r.question_type !== "page_break" && r.question_type !== "statement");
  const map = fields.field_map;
  const setRow = (i: number, p: Partial<MapRow>) => set({ field_map: map.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const missing = writable.filter((f) => f.required && !f.default && !f.default_expr && !map.some((m) => m.target_field === f.name));
  return (
    <div className="fm-stack">
      <Field label={tr("Create a record from each response")} htmlFor={`${id}-entity`} hint={tr("Each response can become, for example, a lead or a ticket.")} error={error}>
        <select id={`${id}-entity`} className="select" value={fields.target_entity} onChange={(e) => set({ target_entity: e.target.value, field_map: e.target.value === fields.target_entity ? map : [] })}>
          <option value="">{tr("No record")}</option>
          {fields.target_entity && !targets.some((t) => t.name === fields.target_entity) && <option value={fields.target_entity}>{isolate(fields.target_entity)}</option>}
          {targets.map((t) => (
            <option key={t.name} value={t.name}>
              {isolate(t.label)}
            </option>
          ))}
        </select>
      </Field>
      {fields.target_entity && (
        <>
          {!entity ? (
            <p className="muted">{tr("Loading the fields…")}</p>
          ) : (
            <>
              <table className="fm-map">
                <thead>
                  <tr>
                    <th scope="col">{tr("Field of the")} {isolate(entity.label.toLowerCase())}</th>
                    <th scope="col">{tr("Filled from")}</th>
                    <th scope="col">
                      <span className="sr-only">{tr("Remove")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {map.map((m, i) => {
                    const f = writable.find((x) => x.name === m.target_field);
                    return (
                      <tr key={i}>
                        <td>
                          <select className="select" aria-label={tr("Field")} value={m.target_field} onChange={(e) => setRow(i, { target_field: e.target.value })}>
                            <option value="">{tr("Choose a field…")}</option>
                            {m.target_field && !writable.some((f) => f.name === m.target_field) && <option value={m.target_field}>{isolate(m.target_field)}</option>}
                            {writable.map((f) => (
                              <option key={f.name} value={f.name}>
                                {isolate(f.label)}
                                {f.required ? " *" : ""}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <div className="fm-from">
                            <select className="select" aria-label={tr("Filled from")} value={m.question || (m.value ? FIXED : "")} onChange={(e) => setRow(i, e.target.value === FIXED ? { question: "", value: m.value || " " } : { question: e.target.value, value: "" })}>
                              <option value="">{tr("Choose…")}</option>
                              <option value={FIXED}>{tr("A fixed value")}</option>
                              {questions
                                .filter((q) => q.key === m.question || !f || fits(f, q))
                                .map((q) => (
                                  <option key={q.uid} value={q.key}>
                                    {q.label.trim() || q.key}
                                  </option>
                                ))}
                            </select>
                            {!m.question && m.value !== "" && <input className="input" aria-label={tr("Fixed value")} value={m.value.trim() === "" ? "" : m.value} onChange={(e) => setRow(i, { value: e.target.value || " " })} placeholder={tr("The value")} />}
                          </div>
                        </td>
                        <td>
                          <button type="button" className="icon-btn" aria-label={tr("Remove this line")} onClick={() => set({ field_map: map.filter((_, j) => j !== i) })}>
                            <Trash2 size={16} aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="row">
                <button type="button" className="btn btn-default btn-sm" onClick={() => set({ field_map: [...map, { target_field: "", question: "", value: "" }] })}>
                  <Plus size={14} aria-hidden="true" /> {tr("Fill another field")}
                </button>
              </div>
              {missing.length > 0 && <p className="field-hint">{tr("Still needed by the")} {isolate(entity.label.toLowerCase())}: {isolate(missing.map((f) => f.label).join(", "))}.</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ───────────────────────────── the settings ─────────────────────────────

export interface SettingsProps {
  fields: Fields;
  set: (patch: Partial<Fields>) => void;
  rows: QRow[];
  formId: string;
  /** What the server refused, by setting. */
  errors: Record<string, string>;
}

export function Settings({ fields: f, set, rows, formId, errors }: SettingsProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const emails = rows.filter((r) => r.question_type === "email");
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast(tr("Choose a picture: PNG, JPG, GIF or WebP."), "error");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("public", "true");
      fd.append("entity", "Form");
      fd.append("record_id", formId);
      const made = await api.post<{ id: string }>("/api/files", fd);
      set({ logo: `/files/public/${made.id}` });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fm-settings">
      <Section title={tr("About this form")}>
        <Field label={tr("Description")} htmlFor={`${id}-description`} hint={tr("Shown under the title, before the first question.")} error={errors.description}>
          <textarea id={`${id}-description`} className="textarea" rows={3} maxLength={5000} value={f.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <div className="fm-grid">
          <Field label={tr("It is a")} error={errors.kind}>
            <Seg label={tr("Kind")} value={f.kind} options={[["Form", "Form"], ["Survey", "Survey"], ["Quiz", "Quiz"]]} onChange={(kind) => set({ kind })} />
          </Field>
          <Field label={tr("People go through it")} error={errors.layout}>
            <Seg label={tr("Layout")} value={f.layout} options={[["Pages", tr("Page by page")], ["One question at a time", tr("One question at a time")]]} onChange={(layout) => set({ layout })} />
          </Field>
        </div>
        <p className="field-hint">{tr("Page by page: page breaks end a page, and a form without any is one page.")}</p>
      </Section>

      <Section title={tr("Who can answer")}>
        <Field label={tr("Access")} error={errors.access}>
          <Seg label={tr("Access")} value={f.access} options={[["Public", tr("Anyone with the link")], ["Internal", tr("People signed in to this workspace")]]} onChange={(access) => set({ access, one_response_per: access === "Public" && f.one_response_per === "User" ? "" : f.one_response_per })} />
        </Field>
        <label className="check-field">
          <input type="checkbox" checked={f.anonymous} onChange={(e) => set({ anonymous: e.target.checked, ...(e.target.checked && f.one_response_per === "Email" ? { one_response_per: "" as const } : {}) })} />
          <span>{tr("Anonymous: keep no email, name or address with the answers")}</span>
        </label>
        {errors.anonymous && <p className="field-error">{isolate(errors.anonymous)}</p>}
        <Field label={tr("Limit each person to one response")} htmlFor={`${id}-one`} error={errors.one_response_per}>
          <select id={`${id}-one`} className="select" value={f.one_response_per} onChange={(e) => set({ one_response_per: e.target.value as Fields["one_response_per"] })}>
            <option value="">{tr("No limit")}</option>
            {!f.anonymous && <option value="Email">{tr("One per email address")}</option>}
            {f.access === "Internal" && <option value="User">{tr("One per signed-in person")}</option>}
          </select>
        </Field>
        {(f.one_response_per === "Email" || f.autoresponder) && !f.anonymous && (
          <Field
            label={tr("Which question holds their email")}
            htmlFor={`${id}-email`}
            hint={emails.length ? tr("It has to be required and shown to everyone.") : tr("Add an Email question first.")}
            error={errors.email_question}
          >
            <select id={`${id}-email`} className="select" value={f.email_question} onChange={(e) => set({ email_question: e.target.value })}>
              <option value="">{f.access === "Internal" && f.one_response_per === "Email" ? tr("The signed-in person's email") : tr("Choose a question…")}</option>
              {emails.map((q) => (
                <option key={q.uid} value={q.key} disabled={!q.required || !alwaysShown(rows, q.key)}>
                  {q.label.trim() || q.key}
                  {!q.required ? tr(" (not required)") : !alwaysShown(rows, q.key) ? tr(" (not always shown)") : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
      </Section>

      <Section title={tr("When")} hint={tr("Times are in your time zone ({zone}).", { zone: zone.replace(/_/g, " ") })}>
        <div className="fm-grid">
          <Field label={tr("Opens")} htmlFor={`${id}-opens`} hint={tr("Blank: as soon as it is published.")} error={errors.opens_at}>
            <input id={`${id}-opens`} className="input" type="datetime-local" value={toInput(f.opens_at)} onChange={(e) => set({ opens_at: fromInput(e.target.value) })} />
          </Field>
          <Field label={tr("Closes")} htmlFor={`${id}-closes`} hint={tr("Blank: it stays open.")} error={errors.closes_at}>
            <input id={`${id}-closes`} className="input" type="datetime-local" value={toInput(f.closes_at)} onChange={(e) => set({ closes_at: fromInput(e.target.value) })} />
          </Field>
          <Field label={tr("Closes after")} htmlFor={`${id}-limit`} hint={tr("Responses. Blank: no limit.")} error={errors.response_limit}>
            <input id={`${id}-limit`} className="input num" type="number" min={1} inputMode="numeric" value={f.response_limit ?? ""} onChange={(e) => set({ response_limit: e.target.value === "" ? null : Number(e.target.value) })} />
          </Field>
        </div>
        <details className="fm-more">
          <summary>{tr("Spam protection")}</summary>
          <Field label={tr("Seconds a person needs to fill it in")} htmlFor={`${id}-fill`} hint={tr("Responses sent sooner are kept apart as spam. 0 turns it off.")} error={errors.min_fill_seconds}>
            <input id={`${id}-fill`} className="input num" type="number" min={0} max={3600} inputMode="numeric" value={f.min_fill_seconds ?? ""} onChange={(e) => set({ min_fill_seconds: e.target.value === "" ? null : Number(e.target.value) })} />
          </Field>
        </details>
      </Section>

      <Section title={tr("After someone answers")}>
        <Field label={tr("Thank-you message")} htmlFor={`${id}-thanks`} hint={tr("Blank: “Thank you! Your response was recorded.”")} error={errors.confirmation_message}>
          <textarea id={`${id}-thanks`} className="textarea" rows={3} maxLength={2000} value={f.confirmation_message} onChange={(e) => set({ confirmation_message: e.target.value })} />
        </Field>
        <Field label={tr("Then send them to")} htmlFor={`${id}-redirect`} hint={tr("A web address, such as your website. Blank: they stay on the thank-you.")} error={errors.redirect_url}>
          <input id={`${id}-redirect`} className="input" type="url" inputMode="url" placeholder="https://" value={f.redirect_url} onChange={(e) => set({ redirect_url: e.target.value })} />
        </Field>
        <Field label={tr("When it is closed, say")} htmlFor={`${id}-closed`} hint={tr("Shown to anyone who opens the link after it has closed or filled up.")} error={errors.closed_message}>
          <textarea id={`${id}-closed`} className="textarea" rows={2} maxLength={2000} value={f.closed_message} onChange={(e) => set({ closed_message: e.target.value })} />
        </Field>
      </Section>

      <Section title={tr("Who is told")}>
        <label className="check-field">
          <input type="checkbox" checked={f.notify_on_response} onChange={(e) => set({ notify_on_response: e.target.checked })} />
          <span>{tr("Tell the owner of the form about each response")}</span>
        </label>
        <Field label={tr("Also tell")} htmlFor={`${id}-notify`} hint={tr("Email addresses of people in this workspace, one per line. They need to be able to read the responses.")} error={errors.notify_users}>
          <textarea id={`${id}-notify`} className="textarea" rows={2} defaultValue={f.notify_users.join("\n")} onChange={(e) => set({ notify_users: lines(e.target.value) })} />
        </Field>
        <label className="check-field">
          <input type="checkbox" checked={f.autoresponder} onChange={(e) => set({ autoresponder: e.target.checked })} />
          <span>{tr("Send each person an email thanking them")}</span>
        </label>
        {errors.autoresponder && <p className="field-error">{isolate(errors.autoresponder)}</p>}
        {f.autoresponder && (
          <>
            <Field label={tr("Subject")} htmlFor={`${id}-subject`} error={errors.autoresponder_subject}>
              <input id={`${id}-subject`} className="input" maxLength={200} value={f.autoresponder_subject} onChange={(e) => set({ autoresponder_subject: e.target.value })} />
            </Field>
            <Field label={tr("Message")} htmlFor={`${id}-message`} hint={tr("Plain text. It goes to the address in their email answer, at most once a day.")} error={errors.autoresponder_message}>
              <textarea id={`${id}-message`} className="textarea" rows={4} maxLength={5000} value={f.autoresponder_message} onChange={(e) => set({ autoresponder_message: e.target.value })} />
            </Field>
          </>
        )}
      </Section>

      <Section title={tr("Look")}>
        <div className="fm-grid">
          <Field label={tr("Colour")} htmlFor={`${id}-colour`} hint={tr("For buttons and progress. Any colour stays readable.")} error={errors.accent_color}>
            <div className="row">
              <input id={`${id}-colour`} type="color" value={hexOf(f.accent_color) ?? "#2f5bea"} onChange={(e) => set({ accent_color: e.target.value })} aria-label={tr("Colour")} />
              {f.accent_color && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ accent_color: null })}>
                  {tr("Use the default")}
                </button>
              )}
            </div>
          </Field>
          <Field label={tr("Logo")} htmlFor={`${id}-logo`} hint={tr("A picture shown above the title.")} error={errors.logo}>
            <div className="fm-logo">
              {f.logo && <img src={f.logo} alt="" />}
              <label className="btn btn-default btn-sm">
                <Upload size={14} aria-hidden="true" />
                {busy ? tr("Uploading…") : f.logo ? tr("Change") : tr("Upload")}
                <input id={`${id}-logo`} type="file" accept="image/*" className="sr-only" disabled={busy} onChange={(e) => (void upload(e.target.files?.[0]), (e.target.value = ""))} />
              </label>
              {f.logo && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ logo: null })}>
                  <X size={14} aria-hidden="true" /> {tr("Remove")}
                </button>
              )}
            </div>
          </Field>
        </div>
      </Section>

      {f.kind === "Quiz" && (
        <Section title={tr("Marking")} hint={tr("Mark the right answer on each question, then set what counts as a pass.")}>
          <Field label={tr("Pass mark (%)")} htmlFor={`${id}-pass`} hint={tr("Blank: no pass or fail, just the score.")} error={errors.passing_score}>
            <input id={`${id}-pass`} className="input num" type="number" min={0} max={100} inputMode="decimal" value={f.passing_score} onChange={(e) => set({ passing_score: e.target.value })} />
          </Field>
          <label className="check-field">
            <input type="checkbox" checked={f.reveal_answers} onChange={(e) => set({ reveal_answers: e.target.checked })} />
            <span>{tr("Show people the right answers with their result")}</span>
          </label>
        </Section>
      )}

      <Section title={tr("Records")} hint={tr("Turn each response into a record somewhere else in Ferrum.")}>
        <Mapping fields={f} set={set} rows={rows} error={errors.target_entity ?? errors.field_map ?? errors.target_field} />
      </Section>
    </div>
  );
}
