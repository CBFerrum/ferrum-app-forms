// What a respondent sees after sending: thanks, where they go next, and for a quiz the result.

import { Check, CircleX, Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "@ferrum/kit";
import type { Kind, PForm, QuizResult, Receipt } from "./model";
import { safeRedirect } from "./site";

/** What the server says when its owner wrote nothing. */
const DEFAULT_THANKS = "Thank you! Your response was recorded.";

/** A correct answer as words (the server keeps accepted texts in lower case). */
function said(v: unknown, type?: Kind): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map(String).join(type === "short_text" ? " or " : type === "ranking" ? " › " : ", ");
  return String(v);
}

export function QuizResultView({ result, types }: { result: QuizResult; types?: Record<string, Kind> }) {
  const percent = result.percent === null ? null : Number(result.percent);
  return (
    <section className="fr-result" aria-label="Your result">
      <div className="fr-score">
        <p className="fr-score-n">
          {result.score}
          <span className="faint"> / {result.max_score}</span>
        </p>
        {percent !== null && (
          <div className="fr-meter" role="img" aria-label={`${percent}%`}>
            <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
          </div>
        )}
        <p className="fr-score-line">
          {percent !== null && <strong>{percent}%</strong>}
          {result.passed !== null && (
            <span className="badge" data-tone={result.passed ? "pass" : "fail"}>
              {result.passed ? "Passed" : "Not passed"}
            </span>
          )}
        </p>
      </div>
      <ul className="fr-marks">
        {result.questions.map((q) => (
          <li key={q.key} data-ok={q.correct ? "" : undefined}>
            {q.correct ? <Check size={16} aria-label="Right" /> : <CircleX size={16} aria-label="Wrong" />}
            <span className="fr-mark-body">
              <span>{q.label ?? q.key}</span>
              {!q.correct && q.correct_answer !== undefined && <span className="faint fr-mark-answer">Right answer: {said(q.correct_answer, types?.[q.key])}</span>}
            </span>
            <span className="faint fr-mark-points">
              {q.earned} / {q.points}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Thanks, the reference of the response, a quiz's result, and the redirect its owner asked for. */
export function Thanks({ receipt, form, preview, resultLink, onAgain }: { receipt: Receipt; form: PForm; preview?: boolean; resultLink?: string; onAgain?: () => void }) {
  const next = preview ? null : safeRedirect(receipt.redirect_url);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!next) return;
    const t = setTimeout(() => (setLeaving(true), window.location.assign(next)), 2200);
    return () => clearTimeout(t);
  }, [next]);
  const types = Object.fromEntries(form.questions.map((q) => [q.key, q.type]));
  const message = receipt.message === DEFAULT_THANKS ? "Your response was recorded." : receipt.message;
  return (
    <div className="fr-thanks" role="status">
      <span className="fr-tick-big" aria-hidden="true">
        <Check size={30} />
      </span>
      <h2 tabIndex={-1} className="fr-thanks-title">
        Thank you
      </h2>
      <p className="fr-thanks-message">{message}</p>
      {receipt.number && <p className="faint fr-ref">Reference {receipt.number}</p>}
      {next && (
        <p className="muted">
          {leaving ? "Taking you on…" : "Taking you on in a moment."} <a href={next}>Go now</a>
        </p>
      )}
      {receipt.result && <QuizResultView result={receipt.result} types={types} />}
      {resultLink && (
        <button
          type="button"
          className="btn btn-default btn-md"
          onClick={() => {
            const url = new URL(resultLink, window.location.origin).href;
            navigator.clipboard?.writeText(url).then(
              () => toast("Link to your result copied"),
              () => toast(url, "info"),
            );
          }}
        >
          <Copy size={16} aria-hidden="true" />
          Copy a link to this result
        </button>
      )}
      {preview && onAgain && (
        <button type="button" className="btn btn-default btn-md" onClick={onAgain}>
          Try the form again
        </button>
      )}
    </div>
  );
}

/** A whole-page message: the form is closed, not found, or needs signing in to. */
export function Notice({ icon, title, children, actions }: { icon: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fr-notice" role="status">
      <span className="fr-notice-icon" aria-hidden="true">
        {icon}
      </span>
      <h1 className="fr-notice-title" tabIndex={-1}>
        {title}
      </h1>
      {children && <div className="fr-notice-body">{children}</div>}
      {actions && <div className="fr-notice-actions">{actions}</div>}
    </div>
  );
}
