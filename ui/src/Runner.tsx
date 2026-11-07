// A form being answered, page by page or one question at a time as the form says. Questions
// appear and go away with the answers before them (the server decides the same way, and is the
// judge); each page is checked when the person moves on, in plain words under the question;
// what they typed is kept in the tab, so a page that expired or was reloaded loses nothing; and
// sending is safe to repeat (the same session sends once). The builder previews a form here too.

import { ArrowLeft, ArrowRight, Lock, Send } from "lucide-react";
import { type CSSProperties, type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, errorMessage, t as tr } from "@ferrum/client";
import { Spinner } from "@ferrum/kit";
import { accentVars } from "./accent";
import { Notice, Thanks } from "./Done";
import { Field, useBase } from "./Fields";
import { type Answers, check, clearDraft, initial, loadDraft, normalize, pagesOf, payload, type Raw, refusedAnswers, saveDraft, uploadBytes, UPLOAD_LIMIT, visibility, zonedNow } from "./flow";
import { answerable, type PForm, type Receipt } from "./model";
import { ALREADY, closedState, loginPath, Refreshed } from "./site";

export interface RunnerProps {
  form: PForm;
  prefill?: Record<string, unknown>;
  /** The workspace's time zone: what `today` and `now` mean to the conditions, and date-times. */
  zone: string;
  workspace?: string;
  /** Sends the answers (and the hidden field's value, which people leave empty). */
  send: (answers: Record<string, unknown>, honeypot: string) => Promise<Receipt>;
  /** Where the answers are kept while the page is open. */
  keep?: { tenant: string; slug: string };
  /** The builder's view: nothing is kept or sent, and a quiz offers no link. */
  preview?: boolean;
  /** The address of a quiz result for its token, to come back to. */
  resultLink?: (token: string) => string;
}

type Phase = { kind: "filling" } | { kind: "sending" } | { kind: "done"; receipt: Receipt } | { kind: "ended"; already: boolean; message: string };

const hide = (e: { currentTarget: HTMLElement }) => (e.currentTarget.hidden = true);

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Runner({ form, prefill, zone, workspace, send, keep, preview, resultLink }: RunnerProps) {
  const base = useBase();
  const layout = form.layout ?? "pages";
  const kept = useMemo(() => (keep && !preview ? loadDraft(keep.tenant, keep.slug) : null), [keep, preview]);
  const [answers, setAnswers] = useState<Answers>(() => ({ ...initial(form, prefill ?? {}, zone), ...(kept?.answers ?? {}) }));
  const [pageId, setPageId] = useState<string | null>(kept?.page ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>({ kind: "filling" });
  const [banner, setBanner] = useState<{ tone: "error" | "info"; text: ReactNode } | null>(null);
  const [honeypot, setHoneypot] = useState("");
  const [restored, setRestored] = useState(() => !!kept && Object.keys(kept.answers).length > 0);
  const section = useRef<HTMLElement>(null);

  const shown = useMemo(() => visibility(form, answers, zonedNow(zone)), [form, answers, zone]);
  const pages = useMemo(() => pagesOf(form, shown, layout), [form, shown, layout]);
  const index = Math.max(0, pages.findIndex((p) => p.id === pageId));
  const page = pages[index] ?? { id: "end", title: null, items: [] };
  const last = index >= pages.length - 1;
  const many = pages.length > 1;
  const sending = phase.kind === "sending";

  const setAnswer = useCallback((key: string, v: Raw) => {
    setAnswers((a) => ({ ...a, [key]: v }));
    setErrors((e) => {
      if (!(key in e)) return e;
      const { [key]: _fixed, ...rest } = e;
      return rest;
    });
  }, []);

  // Leaving a typed answer: a mistake shows now, an empty answer waits for Next.
  const commit = (key: string) => {
    const q = form.questions.find((x) => x.key === key);
    const n = q ? normalize(q, answers[key]) : null;
    if (q && n?.kind === "error") setErrors((e) => ({ ...e, [key]: n.message }));
  };

  // What was typed stays in the tab (not in preview, and never an upload).
  useEffect(() => {
    if (!keep || preview || phase.kind === "done") return;
    const t = setTimeout(() => saveDraft(keep.tenant, keep.slug, { answers, page: page.id }), 300);
    return () => clearTimeout(t);
  }, [answers, page.id, keep, preview, phase.kind]);

  const focusQuestion = useCallback(
    (key: string) => {
      const el = document.getElementById(`${base}-${key}`);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      el.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea, button")?.focus({ preventScroll: true });
    },
    [base],
  );

  // The top: the page's, or in the builder's preview the phone's own scroll.
  const toTop = () => {
    const behavior = reducedMotion() ? "auto" : "smooth";
    const box = preview ? section.current?.closest<HTMLElement>("[data-scroll]") : null;
    if (box) box.scrollTo({ top: 0, behavior });
    else if (!preview) window.scrollTo({ top: 0, behavior });
  };

  // A new page starts at its top, with focus on it for keyboards and screen readers.
  const arrived = useRef(false);
  useEffect(() => {
    if (!arrived.current) {
      arrived.current = true;
      return;
    }
    toTop();
    section.current?.focus({ preventScroll: true });
    if (layout === "single" && typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches) {
      section.current?.querySelector<HTMLElement>("input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea, select")?.focus({ preventScroll: true });
    }
  }, [page.id, layout, preview]);

  const go = (i: number) => {
    const to = pages[i];
    if (!to) return;
    setBanner(null);
    setPageId(to.id);
  };

  const submit = async () => {
    setPhase({ kind: "sending" });
    setBanner(null);
    try {
      if (uploadBytes(form, shown, answers) > UPLOAD_LIMIT) throw new Error("The files are too large to send together. Remove one, or choose smaller files.");
      const receipt = await send(await payload(form, shown, answers), honeypot);
      if (keep && !preview) clearDraft(keep.tenant, keep.slug);
      setPhase({ kind: "done", receipt });
      if (!preview) window.scrollTo({ top: 0 });
    } catch (e) {
      setPhase({ kind: "filling" });
      fail(e);
    }
  };

  const fail = (e: unknown) => {
    if (e instanceof Refreshed) {
      setBanner({ tone: "info", text: "This page had been open for a long time, so it was refreshed. Your answers are still here: press Send once more." });
      return;
    }
    if (!(e instanceof ApiError)) {
      setBanner({ tone: "error", text: errorMessage(e) });
      return;
    }
    if (e.status === 422) {
      const refused = refusedAnswers(form, e.fields, pages);
      const n = Object.keys(refused.errors).length;
      if (refused.first) {
        setErrors(refused.errors);
        if (refused.pageId) setPageId(refused.pageId);
        setBanner({ tone: "error", text: `${n === 1 ? "One answer" : `${n} answers`} could not be accepted. Please look again.` });
        const first = refused.first;
        setTimeout(() => focusQuestion(first), 60);
      } else setBanner({ tone: "error", text: refused.rest[0] ?? e.message });
    } else if (e.status === 409) setPhase({ kind: "ended", already: e.message === ALREADY, message: e.message });
    else if (e.status === 401)
      setBanner({
        tone: "error",
        text: (
          <>
            {tr("You need to sign in to answer this form.")} <a href={loginPath(window.location.pathname + window.location.search)}>{tr("Sign in")}</a>
          </>
        ),
      });
    else if (e.status === 0) setBanner({ tone: "error", text: "We could not reach the server. Your answers are safe here: check your connection and press Send again." });
    else if (e.status === 429) setBanner({ tone: "error", text: "Too many tries just now. Wait a moment, then press Send again." });
    else setBanner({ tone: "error", text: e.message });
  };

  const advance = async () => {
    if (phase.kind !== "filling") return;
    const found = check(form, page.items, answers);
    const keys = Object.keys(found);
    if (keys.length) {
      setErrors(found);
      setBanner({ tone: "error", text: keys.length === 1 ? "One question needs another look." : `${keys.length} questions need another look.` });
      const first = page.items.map((i) => form.questions[i].key).find((k) => k in found);
      if (first) focusQuestion(first);
      return;
    }
    if (last) await submit();
    else go(index + 1);
  };

  // One question at a time: choosing an answer moves on (except from the last question, which
  // sends), after a beat so the choice is seen.
  const advancing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(advance);
  latest.current = advance;
  useEffect(() => () => clearTimeout(advancing.current), []);
  useEffect(() => clearTimeout(advancing.current), [page.id]);
  const picked = layout === "single" && !last ? () => (clearTimeout(advancing.current), (advancing.current = setTimeout(() => void latest.current(), reducedMotion() ? 120 : 320))) : undefined;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void advance();
  };

  const accent = accentVars(form.theme.accent_color) as CSSProperties | undefined;
  const footer = workspace ? (form.access === "Internal" ? `Only for people in ${workspace}.` : `Collected for ${workspace}.`) : undefined;

  if (phase.kind === "done") {
    return (
      <Frame accent={accent} footer={footer} preview={preview}>
        <Thanks
          receipt={phase.receipt}
          form={form}
          preview={preview}
          resultLink={phase.receipt.result_token && resultLink && !preview ? resultLink(phase.receipt.result_token) : undefined}
          onAgain={() => {
            setAnswers(initial(form, prefill ?? {}, zone));
            setPageId(null);
            setErrors({});
            setPhase({ kind: "filling" });
          }}
        />
      </Frame>
    );
  }
  if (phase.kind === "ended") {
    const closed = closedState(phase.message);
    return (
      <Frame accent={accent} footer={footer} preview={preview}>
        <Notice icon={<Lock size={26} />} title={phase.already ? "You have already responded" : closed.title}>
          <p>{phase.already ? "This form takes one response from each person, and yours was received. Thank you." : closed.body}</p>
        </Notice>
      </Frame>
    );
  }

  const firstPage = index === 0;
  const unit = layout === "single" ? "Question" : "Page";
  return (
    <Frame accent={accent} footer={footer} preview={preview}>
      <form className="fr-form" onSubmit={onSubmit} noValidate>
        {many && (
          <div className="fr-top">
            <div className="fr-progress" role="progressbar" aria-label={tr("Progress")} aria-valuemin={1} aria-valuemax={pages.length} aria-valuenow={index + 1} aria-valuetext={`${unit} ${index + 1} of ${pages.length}`}>
              <span style={{ width: `${((index + 1) / pages.length) * 100}%` }} />
            </div>
            <p className="fr-step faint">
              {unit} {index + 1} of {pages.length}
            </p>
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {many ? `${unit} ${index + 1} of ${pages.length}${page.title ? `: ${page.title}` : ""}` : ""}
        </p>
        {firstPage ? (
          <header className="fr-head">
            {form.theme.logo && <img className="fr-logo" src={form.theme.logo} alt={workspace ?? ""} onError={hide} />}
            <h1 className="fr-title">{form.title}</h1>
            {form.description && <p className="fr-desc">{form.description}</p>}
            {(form.anonymous || form.closes_at) && (
              <p className="fr-facts faint">
                {form.anonymous && (
                  <span>
                    <Lock size={13} aria-hidden="true" /> {tr("Your response is anonymous.")}
                  </span>
                )}
                {form.closes_at && <span>{tr("Open until")} {new Date(form.closes_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.</span>}
              </p>
            )}
          </header>
        ) : (
          <p className="fr-running faint">{form.title}</p>
        )}
        {restored && (
          <p className="fr-restored">
            {tr("We kept the answers you had typed.")}{" "}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setAnswers(initial(form, prefill ?? {}, zone));
                setPageId(null);
                setErrors({});
                setRestored(false);
                if (keep) clearDraft(keep.tenant, keep.slug);
              }}
            >
              {tr("Start again")}
            </button>
          </p>
        )}
        <section key={page.id} ref={section} className="fr-page" tabIndex={-1} aria-label={page.title ?? (many ? `${unit} ${index + 1}` : form.title)}>
          {page.title && <h2 className="fr-page-title">{page.title}</h2>}
          {page.items.some((i) => form.questions[i].required && form.questions[i].type !== "checkbox") && (
            <p className="fr-legend faint">
              <span className="req" aria-hidden="true">
                *
              </span>{" "}
              {tr("needs an answer")}
            </p>
          )}
          {!page.items.length && <p className="muted">{tr("Nothing more to ask. Press Send to finish.")}</p>}
          <div className="fr-questions">
            {page.items.map((i) => {
              const q = form.questions[i];
              return (
                <Field
                  key={q.key}
                  q={q}
                  id={`${base}-${q.key}`}
                  zone={zone}
                  value={answers[q.key]}
                  error={errors[q.key]}
                  onChange={(v) => setAnswer(q.key, v)}
                  onCommit={() => answerable(q.type) && commit(q.key)}
                  onPick={picked}
                />
              );
            })}
          </div>
        </section>
        {/* A field only bots fill in: people never see it, and the server keeps what it catches apart. */}
        <div className="fr-hp" aria-hidden="true">
          <label>
            {tr("Leave this field empty")}
            <input type="text" name="hp_site" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </label>
        </div>
        {banner && (
          <p className="fr-banner" data-tone={banner.tone} role={banner.tone === "error" ? "alert" : "status"}>
            {banner.text}
          </p>
        )}
        <div className="fr-bar">
          {index > 0 && (
            <button type="button" className="btn btn-default btn-md" disabled={sending} onClick={() => go(index - 1)}>
              <ArrowLeft size={16} aria-hidden="true" />
              {tr("Back")}
            </button>
          )}
          <span className="spacer" />
          <button type="submit" className="btn btn-primary btn-md" disabled={sending} aria-busy={sending || undefined}>
            {sending ? <Spinner small /> : last ? <Send size={16} aria-hidden="true" /> : null}
            {sending ? "Sending…" : last ? "Send" : "Next"}
            {!sending && !last && <ArrowRight size={16} aria-hidden="true" />}
          </button>
        </div>
      </form>
    </Frame>
  );
}

/** The page's sheet: the form's colour, a column that holds its width, who is asking. */
export function Frame({ accent, footer, preview, children }: { accent?: CSSProperties; footer?: string; preview?: boolean; children: ReactNode }) {
  const note = footer && !preview ? <p className="fr-foot faint">{footer}</p> : null;
  return (
    <div className="fr" style={accent} data-preview={preview ? "" : undefined}>
      {preview && <p className="fr-preview">{tr("Preview. Nothing you answer here is sent or kept.")}</p>}
      {/* The page's one main region; in the builder's preview it is inside the builder's. */}
      {preview ? (
        <div className="fr-sheet">{children}</div>
      ) : (
        <main className="fr-sheet" id="main">
          {children}
          {note}
        </main>
      )}
    </div>
  );
}
