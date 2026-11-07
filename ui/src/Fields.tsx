// The control for each question type, as a respondent meets it. Every control is a real form
// element (radio, checkbox, select, input), so keyboards, screen readers and phones work without
// help; the look is in styles.css. Answers are held as `Raw` (flow.ts).

import { ArrowDown, ArrowUp, Paperclip, Star, X } from "lucide-react";
import { type DragEvent, type ReactNode, useId, useRef, useState } from "react";
import { extension, type Raw, UPLOAD_LIMIT } from "./flow";
import type { PQuestion } from "./model";
import { t as tr } from "@ferrum/client";

export interface FieldProps {
  q: PQuestion;
  /** The element id of the question (its wrapper): errors and help hang on it. */
  id: string;
  value: Raw;
  error?: string;
  onChange: (v: Raw) => void;
  /** Leaving a typed answer: the page checks it now. */
  onCommit?: () => void;
  /** A single choice was made: one question at a time moves on. */
  onPick?: () => void;
  zone: string;
}

const text = (v: Raw): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export const size = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** What the question's label and help look like, around whatever it asks. */
function Wrap({ q, id, error, group, children }: { q: PQuestion; id: string; error?: string; group: boolean; children: ReactNode }) {
  const label = (
    <>
      {q.label}
      {q.required && (
        <span className="req" aria-hidden="true">
          {" "}
          *
        </span>
      )}
    </>
  );
  const help = q.help_text ? (
    <p className="fr-help" id={`${id}-help`}>
      {q.help_text}
    </p>
  ) : null;
  const err = error ? (
    <p className="fr-error" id={`${id}-error`}>
      {error}
    </p>
  ) : null;
  return group ? (
    <fieldset className="fr-q" id={id} data-invalid={error ? "" : undefined} aria-describedby={[q.help_text ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined}>
      <legend className="fr-label">{label}</legend>
      {help}
      {children}
      {err}
    </fieldset>
  ) : (
    <div className="fr-q" id={id} data-invalid={error ? "" : undefined}>
      <label className="fr-label" htmlFor={`${id}-input`}>
        {label}
      </label>
      {help}
      {children}
      {err}
    </div>
  );
}

/** What a typed control says about itself to assistive technology. */
const described = (q: PQuestion, id: string, error?: string) => ({
  "aria-invalid": error ? true : undefined,
  "aria-required": q.required || undefined,
  "aria-describedby": [q.help_text ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined,
});

// ───────────────────────────── choices ─────────────────────────────

function Choice({ type, name, checked, onChange, children }: { type: "radio" | "checkbox"; name: string; checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className="fr-choice">
      <input type={type} name={name} checked={checked} onChange={onChange} />
      <span>{children}</span>
    </label>
  );
}

/** "Other": a choice that is a text of the person's own. What they type is kept apart from the
 *  options, so typing a word that is also an option does not switch it. */
function useOther(v: string, options: string[], onChange: (v: string) => void) {
  const typed = v !== "" && !options.includes(v);
  const [on, setOn] = useState(typed);
  const [text, setText] = useState(typed ? v : "");
  const box = useRef<HTMLInputElement>(null);
  return {
    on,
    text,
    box,
    choose: () => {
      setOn(true);
      onChange(text);
      setTimeout(() => box.current?.focus(), 0);
    },
    leave: () => setOn(false),
    type: (t: string) => {
      setText(t);
      onChange(t);
    },
  };
}

function Single({ q, id, value, error, onChange, onPick }: FieldProps) {
  const options = q.options ?? [];
  const v = text(value);
  const other = useOther(v, options, onChange);
  return (
    <Wrap q={q} id={id} error={error} group>
      <div className={q.type === "likert" ? "fr-choices fr-likert" : "fr-choices"}>
        {options.map((o) => (
          <Choice
            key={o}
            type="radio"
            name={id}
            checked={!other.on && v === o}
            onChange={() => {
              other.leave();
              onChange(o);
              onPick?.();
            }}
          >
            {o}
          </Choice>
        ))}
        {q.allow_other && (
          <div className="fr-other">
            <Choice type="radio" name={id} checked={other.on} onChange={other.choose}>
              {tr("Other")}
            </Choice>
            {other.on && <input ref={other.box} className="input" aria-label={`${q.label}: your own answer`} maxLength={200} value={other.text} onChange={(e) => other.type(e.target.value)} />}
          </div>
        )}
      </div>
    </Wrap>
  );
}

function Dropdown({ q, id, value, error, onChange, onPick }: FieldProps) {
  const options = q.options ?? [];
  const v = text(value);
  const other = useOther(v, options, onChange);
  return (
    <Wrap q={q} id={id} error={error} group={false}>
      <select
        id={`${id}-input`}
        className="select"
        {...described(q, id, error)}
        value={other.on ? "__other__" : v}
        onChange={(e) => {
          if (e.target.value === "__other__") other.choose();
          else {
            other.leave();
            onChange(e.target.value);
            if (e.target.value) onPick?.();
          }
        }}
      >
        <option value="">{tr("Choose…")}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {q.allow_other && <option value="__other__">{tr("Other…")}</option>}
      </select>
      {other.on && <input ref={other.box} className="input fr-other-text" aria-label={`${q.label}: your own answer`} maxLength={200} value={other.text} onChange={(e) => other.type(e.target.value)} />}
    </Wrap>
  );
}

function Multi({ q, id, value, error, onChange }: FieldProps) {
  const options = q.options ?? [];
  const chosen = Array.isArray(value) ? (value as string[]) : [];
  const picked = chosen.filter((x) => options.includes(x));
  const typed = chosen.find((x) => !options.includes(x)) ?? "";
  const [other, setOther] = useState(typed !== "");
  const [otherText, setOtherText] = useState(typed);
  const box = useRef<HTMLInputElement>(null);
  const emit = (list: string[], on: boolean, t: string) => onChange([...list, ...(on && t !== "" ? [t] : [])]);
  const lo = q.min ? Number(q.min) : 0;
  const hi = q.max ? Number(q.max) : 0;
  const hint = lo && hi ? (lo === hi ? `Choose ${lo}.` : `Choose ${lo} to ${hi}.`) : lo ? `Choose at least ${lo}.` : hi ? `Choose up to ${hi}.` : "Choose any that apply.";
  return (
    <Wrap q={q} id={id} error={error} group>
      <p className="fr-hint">{hint}</p>
      <div className="fr-choices">
        {options.map((o) => (
          <Choice key={o} type="checkbox" name={id} checked={picked.includes(o)} onChange={() => emit(picked.includes(o) ? picked.filter((x) => x !== o) : [...picked, o], other, otherText)}>
            {o}
          </Choice>
        ))}
        {q.allow_other && (
          <div className="fr-other">
            <Choice
              type="checkbox"
              name={id}
              checked={other}
              onChange={() => {
                setOther(!other);
                emit(picked, !other, otherText);
                if (!other) setTimeout(() => box.current?.focus(), 0);
              }}
            >
              {tr("Other")}
            </Choice>
            {other && (
              <input
                ref={box}
                className="input"
                aria-label={`${q.label}: your own answer`}
                maxLength={200}
                value={otherText}
                onChange={(e) => (setOtherText(e.target.value), emit(picked, true, e.target.value))}
              />
            )}
          </div>
        )}
      </div>
    </Wrap>
  );
}

function Tick({ q, id, value, error, onChange }: FieldProps) {
  return (
    <div className="fr-q" id={id} data-invalid={error ? "" : undefined}>
      <label className="fr-choice fr-tick">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} {...described(q, id, error)} />
        <span>
          {q.label}
          {q.required && (
            <span className="req" aria-hidden="true">
              {" "}
              *
            </span>
          )}
        </span>
      </label>
      {q.help_text && (
        <p className="fr-help" id={`${id}-help`}>
          {q.help_text}
        </p>
      )}
      {error && (
        <p className="fr-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

// ───────────────────────────── scales ─────────────────────────────

function Stars({ q, id, value, error, onChange, onPick }: FieldProps) {
  const scale = q.scale ?? 5;
  const v = Number(value) || 0;
  return (
    <Wrap q={q} id={id} error={error} group>
      <div className="fr-stars">
        {Array.from({ length: scale }, (_, i) => i + 1).map((n) => (
          <label key={n} className="fr-star" data-on={n <= v ? "" : undefined} title={`${n} of ${scale}`}>
            <input
              type="radio"
              name={id}
              className="sr-only"
              checked={v === n}
              onChange={() => {
                onChange(n);
                onPick?.();
              }}
            />
            <Star size={30} aria-hidden="true" />
            <span className="sr-only">
              {n} of {scale}
            </span>
          </label>
        ))}
      </div>
    </Wrap>
  );
}

function Nps({ q, id, value, error, onChange, onPick }: FieldProps) {
  const v = value === undefined || value === null || value === "" ? null : Number(value);
  return (
    <Wrap q={q} id={id} error={error} group>
      <div className="fr-nps">
        {Array.from({ length: 11 }, (_, n) => n).map((n) => (
          <label key={n} className="fr-num">
            <input
              type="radio"
              name={id}
              className="sr-only"
              checked={v === n}
              onChange={() => {
                onChange(n);
                onPick?.();
              }}
            />
            <span>{n}</span>
          </label>
        ))}
      </div>
    </Wrap>
  );
}

function Grid({ q, id, value, error, onChange }: FieldProps) {
  const answers = (typeof value === "object" && value && !Array.isArray(value) ? value : {}) as Record<string, string>;
  return (
    <Wrap q={q} id={id} error={error} group>
      <div className="fr-grid">
        {(q.rows ?? []).map((row, r) => (
          <fieldset key={row} className="fr-row">
            <legend>{row}</legend>
            <div className="fr-cols">
              {(q.columns ?? []).map((col) => (
                <label key={col} className="fr-col">
                  <input type="radio" name={`${id}-${r}`} checked={answers[row] === col} onChange={() => onChange({ ...answers, [row]: col })} />
                  <span>{col}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </Wrap>
  );
}

function Ranking({ q, id, value, error, onChange }: FieldProps) {
  const options = q.options ?? [];
  const ranked = Array.isArray(value) && value.length === options.length;
  const order = ranked ? (value as string[]) : options;
  const move = (i: number, by: -1 | 1) => {
    const next = [...order];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  return (
    <Wrap q={q} id={id} error={error} group>
      <p className="fr-hint">{ranked ? "Your first choice is at the top." : "Use the arrows to put these in your order, first choice at the top."}</p>
      <ol className="fr-rank" data-ranked={ranked ? "" : undefined}>
        {order.map((o, i) => (
          <li key={o}>
            <span className="fr-rank-n" aria-hidden="true">
              {i + 1}
            </span>
            <span className="fr-rank-label">{o}</span>
            <button type="button" className="icon-btn" aria-label={`Move ${o} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={16} aria-hidden="true" />
            </button>
            <button type="button" className="icon-btn" aria-label={`Move ${o} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
      {!ranked && (
        <button type="button" className="btn btn-default btn-sm fr-keep" onClick={() => onChange([...options])}>
          {tr("Keep this order")}
        </button>
      )}
    </Wrap>
  );
}

// ───────────────────────────── files ─────────────────────────────

function Upload({ q, id, value, error, onChange }: FieldProps) {
  const files = Array.isArray(value) ? (value as File[]) : [];
  const max = q.max_files ?? 1;
  const [over, setOver] = useState(false);
  const accept = (q.accept ?? []).map((e) => `.${e}`).join(",");
  const add = (list: FileList | File[]) => {
    const fresh = [...list].filter((f) => !files.some((x) => x.name === f.name && x.size === f.size));
    if (!fresh.length) return;
    // One file replaces the last choice; several add up to the limit (the page says if it is too many).
    onChange(max === 1 ? fresh.slice(0, 1) : [...files, ...fresh]);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    add(e.dataTransfer.files);
  };
  const total = files.reduce((n, f) => n + f.size, 0);
  const rules = [
    q.accept?.length ? q.accept.join(", ").toUpperCase() : null,
    `up to ${q.max_file_mb ?? 10} MB${max > 1 ? " each" : ""}`,
    max > 1 ? `up to ${max} files` : null,
  ].filter(Boolean);
  return (
    <Wrap q={q} id={id} error={error} group>
      <div className="fr-drop" data-over={over ? "" : undefined} onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={drop}>
        <label className="btn btn-default btn-md">
          <Paperclip size={16} aria-hidden="true" />
          {max > 1 ? "Choose files" : files.length ? "Choose another file" : "Choose a file"}
          <input
            id={`${id}-input`}
            type="file"
            className="sr-only"
            multiple={max > 1}
            accept={accept || undefined}
            onChange={(e) => {
              if (e.target.files) add(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <span className="fr-hint">{tr("or drop")} {max > 1 ? "them" : "it"} here</span>
      </div>
      <p className="fr-hint">{rules.join(" · ")}</p>
      {files.length > 0 && (
        <ul className="fr-files">
          {files.map((f) => (
            <li key={`${f.name}-${f.size}`} data-bad={q.accept?.length && !q.accept.includes(extension(f.name)) ? "" : undefined}>
              <Paperclip size={14} aria-hidden="true" />
              <span className="fr-file-name">{f.name}</span>
              <span className="faint">{size(f.size)}</span>
              <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove ${f.name}`} onClick={() => onChange(files.filter((x) => x !== f))}>
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {total > UPLOAD_LIMIT && <p className="fr-error">{tr("These files are too large to send together. The limit is")} {size(UPLOAD_LIMIT)} {tr("for the whole form.")}</p>}
    </Wrap>
  );
}

// ───────────────────────────── typed answers ─────────────────────────────

const INPUT: Partial<Record<PQuestion["type"], { type: string; inputMode?: "numeric" | "decimal" | "email" | "tel"; autoComplete?: string }>> = {
  short_text: { type: "text" },
  email: { type: "email", inputMode: "email", autoComplete: "email" },
  phone: { type: "tel", inputMode: "tel", autoComplete: "tel" },
  number: { type: "text", inputMode: "numeric" },
  decimal: { type: "text", inputMode: "decimal" },
  date: { type: "date" },
  time: { type: "time" },
  datetime: { type: "datetime-local" },
};

function Typed({ q, id, value, error, onChange, onCommit, zone }: FieldProps) {
  const v = text(value);
  const common = { id: `${id}-input`, value: v, onBlur: onCommit, ...described(q, id, error) };
  if (q.type === "long_text") {
    const max = q.max_length ?? 10_000;
    const n = [...v].length;
    return (
      <Wrap q={q} id={id} error={error} group={false}>
        <textarea {...common} className="textarea" rows={4} onChange={(e) => onChange(e.target.value)} />
        {n > max * 0.8 && (
          <p className="fr-hint fr-count" data-over={n > max ? "" : undefined}>
            {n} of {max} characters
          </p>
        )}
      </Wrap>
    );
  }
  const base = INPUT[q.type] ?? { type: "text" };
  // The numeric keypads of phones have no minus sign: a number that can be negative gets the full keyboard.
  const spec = (q.type === "number" || q.type === "decimal") && !(q.min !== undefined && q.min !== "" && Number(q.min) >= 0) ? { ...base, inputMode: undefined } : base;
  return (
    <Wrap q={q} id={id} error={error} group={false}>
      <input
        {...common}
        className="input"
        type={spec.type}
        inputMode={spec.inputMode}
        autoComplete={spec.autoComplete}
        min={q.type === "date" || q.type === "time" ? q.min : undefined}
        max={q.type === "date" || q.type === "time" ? q.max : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {q.type === "datetime" && <p className="fr-hint">{tr("Times are in")} {zone.replace(/_/g, " ")}.</p>}
    </Wrap>
  );
}

// ───────────────────────────── one question ─────────────────────────────

/** A text block: words to read, nothing to answer. */
function Statement({ q }: { q: PQuestion }) {
  return (
    <div className="fr-statement">
      {q.label && <h3>{q.label}</h3>}
      {q.help_text && <p>{q.help_text}</p>}
    </div>
  );
}

export function Field(props: FieldProps) {
  switch (props.q.type) {
    case "statement":
      return <Statement q={props.q} />;
    case "page_break":
      return null;
    case "select":
    case "likert":
      return <Single {...props} />;
    case "dropdown":
      return <Dropdown {...props} />;
    case "multi_select":
      return <Multi {...props} />;
    case "checkbox":
      return <Tick {...props} />;
    case "rating":
      return <Stars {...props} />;
    case "nps":
      return <Nps {...props} />;
    case "matrix":
      return <Grid {...props} />;
    case "ranking":
      return <Ranking {...props} />;
    case "file":
      return <Upload {...props} />;
    default:
      return <Typed {...props} />;
  }
}

/** A stable id base for a runner's controls. */
export function useBase(): string {
  return `fr${useId().replace(/:/g, "")}`;
}
