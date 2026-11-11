// The questions of a form as cards: add one from the list of types, open it to write it, move it
// (drag its grip, press Alt+Up or Alt+Down on its title, or use its menu), copy it, delete it. A
// card says what is wrong with it in words, before the server does.

import { type Announcements, closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, type UniqueIdentifier, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, ChevronDown, Copy, Ellipsis, GitBranch, GripVertical, Plus, Trash2, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { confirmDialog } from "@ferrum/kit";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@ferrum/kit/primitives";
import { blankRow, changeKind, copyRow, FILE_TYPES, lines, move, nameFromLabel, type Problem, problems, type QRow, readers } from "./rows";
import { KindIcon } from "./kinds";
import { Logic } from "./Logic";
import { answerable, gradable, GROUPS, type Kind, KINDS, kindLabel, LIKERT_DEFAULT } from "./model";
import { t as tr, isolate } from "@ferrum/client";

// ───────────────────────────── small controls ─────────────────────────────

function Err({ list }: { list: Problem[] }) {
  return list.length ? <p className="field-error">{isolate(list[0].message)}</p> : null;
}

/** A box of one entry per line: what is typed stays as typed, and the list follows it. */
function LinesBox({ id, value, onChange, rows = 4, placeholder }: { id: string; value: string[]; onChange: (v: string[]) => void; rows?: number; placeholder?: string }) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <textarea
      id={id}
      className="textarea"
      rows={rows}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(lines(e.target.value));
      }}
    />
  );
}

function Lines({ id, value, onChange, rows = 4, placeholder, label, hint }: { id: string; value: string[]; onChange: (v: string[]) => void; rows?: number; placeholder?: string; label: string; hint?: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {isolate(label)}
      </label>
      <LinesBox id={id} value={value} onChange={onChange} rows={rows} placeholder={placeholder} />
      <p className="field-hint">
        {value.length} {(value.length === 1 ? tr("entry. One per line.") : tr("entries. One per line."))} {hint}
      </p>
    </div>
  );
}

function Num({ id, label, value, onChange, min, max, hint }: { id: string; label: string; value: number | null; onChange: (v: number | null) => void; min?: number; max?: number; hint?: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {isolate(label)}
      </label>
      <input id={id} className="input num" type="number" inputMode="numeric" min={min} max={max} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
      {hint && <p className="field-hint">{isolate(hint)}</p>}
    </div>
  );
}

function Text({ id, label, value, onChange, type = "text", hint, placeholder }: { id: string; label: string; value: string; onChange: (v: string) => void; type?: string; hint?: string; placeholder?: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {isolate(label)}
      </label>
      <input id={id} className="input" type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="field-hint">{isolate(hint)}</p>}
    </div>
  );
}

// ───────────────────────────── the answer that is right ─────────────────────────────

/** A quiz question's right answer, written the way the question is answered. */
function Correct({ row, update }: { row: QRow; update: (p: Partial<QRow>) => void }) {
  const id = useId();
  const kind = row.question_type;
  const value = row.correct_answer;
  const options = kind === "likert" && !row.options.length ? LIKERT_DEFAULT : row.options;
  const set = (v: unknown) => update({ correct_answer: v });
  let control: ReactNode;
  if (kind === "select" || kind === "dropdown" || kind === "likert") {
    control = (
      <select id={id} className="select" value={typeof value === "string" ? value : ""} onChange={(e) => set(e.target.value || null)}>
        <option value="">{tr("Choose the right option…")}</option>
        {options.map((o) => (
          <option key={o}>{isolate(o)}</option>
        ))}
      </select>
    );
  } else if (kind === "multi_select") {
    const chosen = Array.isArray(value) ? (value as string[]) : [];
    control = (
      <div className="fm-checks" id={id}>
        {options.map((o) => (
          <label key={o} className="check-field">
            <input type="checkbox" checked={chosen.includes(o)} onChange={() => set(chosen.includes(o) ? chosen.filter((x) => x !== o) : [...chosen, o])} />
            <span>{isolate(o)}</span>
          </label>
        ))}
      </div>
    );
  } else if (kind === "checkbox") {
    control = (
      <select id={id} className="select" value={value === true ? "yes" : value === false ? "no" : ""} onChange={(e) => set(e.target.value === "" ? null : e.target.value === "yes")}>
        <option value="">{tr("Choose…")}</option>
        <option value="yes">{tr("Ticked")}</option>
        <option value="no">{tr("Not ticked")}</option>
      </select>
    );
  } else if (kind === "short_text") {
    control = <LinesBox id={id} rows={2} value={Array.isArray(value) ? (value as string[]) : typeof value === "string" ? [value] : []} onChange={(list) => set(list.length ? list : null)} />;
  } else if (kind === "ranking") {
    const order = Array.isArray(value) && value.length === options.length ? (value as string[]) : options;
    control = (
      <ol className="fm-order" id={id}>
        {order.map((o, i) => (
          <li key={o}>
            <span>{isolate(o)}</span>
            <button type="button" className="icon-btn icon-btn-sm" aria-label={tr("Move {o} up", { o })} disabled={i === 0} onClick={() => set(move(order, i, i - 1))}>
              <ArrowUp size={14} aria-hidden="true" />
            </button>
            <button type="button" className="icon-btn icon-btn-sm" aria-label={tr("Move {o} down", { o })} disabled={i === order.length - 1} onClick={() => set(move(order, i, i + 1))}>
              <ArrowDown size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
    );
  } else {
    control = <input id={id} className="input" type={kind === "date" ? "date" : "text"} inputMode={kind === "number" ? "numeric" : kind === "decimal" ? "decimal" : undefined} value={value === null || value === undefined ? "" : String(value)} onChange={(e) => set(e.target.value === "" ? null : e.target.value)} />;
  }
  return (
    <div className="fm-quiz">
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {tr("The right answer")}
        </label>
        {control}
        {kind === "short_text" && <p className="field-hint">{tr("One accepted answer per line. Capital letters and extra spaces do not matter.")}</p>}
        {kind === "ranking" && <p className="field-hint">{tr("The order is the right answer: first at the top.")}</p>}
      </div>
      <Text id={`${id}-points`} label={tr("Points")} type="number" value={row.points} onChange={(v) => update({ points: v })} hint={tr("Blank: 1 point.")} />
    </div>
  );
}

// ───────────────────────────── what each type asks ─────────────────────────────

function Specifics({ row, update, list }: { row: QRow; update: (p: Partial<QRow>) => void; list: (f: string) => Problem[] }) {
  const id = useId();
  const kind = row.question_type;
  switch (kind) {
    case "short_text":
    case "long_text":
      return (
        <details className="fm-more">
          <summary>{tr("Length and format")}</summary>
          <div className="fm-grid">
            <Num id={`${id}-minl`} label={tr("Fewest characters")} value={row.min_length} onChange={(v) => update({ min_length: v })} min={0} />
            <Num id={`${id}-maxl`} label={tr("Most characters")} value={row.max_length} onChange={(v) => update({ max_length: v })} min={1} hint={kind === "short_text" ? tr("Blank: 500. At most 2,000.") : tr("Blank: 10,000. At most 50,000.")} />
          </div>
          <Err list={[...list("min_length"), ...list("max_length")]} />
          <Text id={`${id}-pat`} label={tr("Must match a pattern")} value={row.pattern} onChange={(v) => update({ pattern: v })} hint="A regular expression the whole answer must match, such as [A-Z]{3}[0-9]{4}." />
          <Err list={list("pattern")} />
          {row.pattern && <Text id={`${id}-patm`} label={tr("Say so when it does not")} value={row.pattern_message} onChange={(v) => update({ pattern_message: v })} placeholder={tr("Use three letters and four digits.")} />}
        </details>
      );
    case "number":
    case "decimal":
      return (
        <div className="fm-grid">
          <Text id={`${id}-min`} label={tr("Smallest")} type="number" value={row.min_value} onChange={(v) => update({ min_value: v })} />
          <Text id={`${id}-max`} label={tr("Largest")} type="number" value={row.max_value} onChange={(v) => update({ max_value: v })} />
          <Err list={[...list("min_value"), ...list("max_value")]} />
        </div>
      );
    case "date":
    case "time":
      return (
        <div className="fm-grid">
          <Text id={`${id}-min`} label={kind === "date" ? tr("Earliest") : tr("From")} type={kind} value={row.min_value} onChange={(v) => update({ min_value: v })} />
          <Text id={`${id}-max`} label={kind === "date" ? tr("Latest") : tr("Until")} type={kind} value={row.max_value} onChange={(v) => update({ max_value: v })} />
          <Err list={list("min_value")} />
        </div>
      );
    case "select":
    case "dropdown":
    case "multi_select":
      return (
        <>
          <Lines id={`${id}-options`} label={tr("Options")} value={row.options} onChange={(v) => update({ options: v })} placeholder={tr("Red\nBlue\nGreen")} />
          <Err list={list("options")} />
          <label className="check-field">
            <input type="checkbox" checked={row.allow_other} onChange={(e) => update({ allow_other: e.target.checked })} />
            <span>{tr("Let people write their own answer (“Other”)")}</span>
          </label>
          {kind === "multi_select" && (
            <div className="fm-grid">
              <Text id={`${id}-min`} label={tr("Fewest to choose")} type="number" value={row.min_value} onChange={(v) => update({ min_value: v })} />
              <Text id={`${id}-max`} label={tr("Most to choose")} type="number" value={row.max_value} onChange={(v) => update({ max_value: v })} />
              <Err list={list("min_value")} />
            </div>
          )}
        </>
      );
    case "ranking":
      return (
        <>
          <Lines id={`${id}-options`} label={tr("Things to put in order")} value={row.options} onChange={(v) => update({ options: v })} placeholder={tr("Price\nQuality\nSpeed")} />
          <Err list={list("options")} />
        </>
      );
    case "likert":
      return (
        <>
          <Lines id={`${id}-options`} label={tr("Scale")} rows={5} value={row.options} onChange={(v) => update({ options: v })} placeholder={LIKERT_DEFAULT.join("\n")} hint={tr("Leave empty for Strongly disagree to Strongly agree.")} />
          <Err list={list("options")} />
        </>
      );
    case "matrix":
      return (
        <>
          <Lines id={`${id}-rows`} label={tr("Statements (rows)")} value={row.matrix_rows} onChange={(v) => update({ matrix_rows: v })} placeholder={tr("Speed\nPrice")} />
          <Err list={list("matrix_rows")} />
          <Lines id={`${id}-options`} label={tr("Answers (columns)")} value={row.options} onChange={(v) => update({ options: v })} placeholder={tr("Poor\nGood\nExcellent")} />
          <Err list={list("options")} />
        </>
      );
    case "rating":
      return (
        <div className="field">
          <label className="field-label" htmlFor={`${id}-scale`}>
            {tr("Stars")}
          </label>
          <select id={`${id}-scale`} className="select" value={row.max_value || "5"} onChange={(e) => update({ max_value: e.target.value })}>
            {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>
                {tr("{n} stars", { n })}
              </option>
            ))}
          </select>
        </div>
      );
    case "nps":
      return <p className="field-hint">{tr("People choose from 0 to 10. The results sort them into promoters (9 to 10), passives (7 to 8) and detractors (0 to 6).")}</p>;
    case "file": {
      const chosen = row.accept.split(/[\s,;]+/).map((e) => e.replace(/^\./, "").toLowerCase()).filter(Boolean);
      const toggle = (t: string) => update({ accept: (chosen.includes(t) ? chosen.filter((x) => x !== t) : [...chosen, t]).join(", ") });
      return (
        <>
          <fieldset className="field fm-types">
            <legend className="field-label">{tr("Accepted files")}</legend>
            <div className="chips">
              {FILE_TYPES.map((t) => (
                <button key={t} type="button" className="fm-pill" aria-pressed={chosen.includes(t)} onClick={() => toggle(t)}>
                  {isolate(t)}
                </button>
              ))}
            </div>
            <p className="field-hint">{(chosen.length ? tr("Only these types. Each is checked by its contents, not just its name.") : tr("Documents, pictures and spreadsheets (not zip files). Each is checked by its contents, not just its name."))}</p>
          </fieldset>
          <Err list={list("accept")} />
          <div className="fm-grid">
            <Num id={`${id}-mb`} label={tr("Largest file (MB)")} value={row.max_file_mb} onChange={(v) => update({ max_file_mb: v })} min={1} max={20} hint={tr("Blank: 10.")} />
            <Text id={`${id}-files`} label={tr("Most files")} type="number" value={row.max_value} onChange={(v) => update({ max_value: v })} hint={tr("Blank: 1. At most 10.")} />
          </div>
          <Err list={[...list("max_file_mb"), ...list("max_value")]} />
        </>
      );
    }
    default:
      return null;
  }
}

// ───────────────────────────── the palette of types ─────────────────────────────

/** Every type to add, in groups. */
export function TypeList({ onPick }: { onPick: (k: Kind) => void }) {
  return (
    <div className="fm-types-list">
      {GROUPS.map((g) => (
        <section key={g} aria-label={g}>
          <h3 className="fm-group">{isolate(g)}</h3>
          <ul>
            {KINDS.filter((k) => k.group === g).map((k) => (
              <li key={k.kind}>
                <button type="button" className="fm-type" onClick={() => onPick(k.kind)}>
                  <span className="fm-kind">
                    <KindIcon kind={k.kind} />
                  </span>
                  <span className="fm-type-text">
                    <span>{isolate(k.label)}</span>
                    <span className="faint">{isolate(k.hint)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AddButton({ onPick, children = tr("Add a question"), variant = "default" }: { onPick: (k: Kind) => void; children?: ReactNode; variant?: "default" | "primary" }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={`btn btn-${variant} btn-md`}>
          <Plus size={16} aria-hidden="true" />
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="fm-popover">
        <TypeList
          onPick={(k) => {
            setOpen(false);
            onPick(k);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

// ───────────────────────────── one card ─────────────────────────────

interface CardProps {
  row: QRow;
  index: number;
  rows: QRow[];
  quiz: boolean;
  open: boolean;
  fresh: boolean;
  /** What else in the form uses the question's answer: "the email question". */
  usedElsewhere: (key: string) => string[];
  showProblems: boolean;
  /** What is wrong with it, found here, and what the server said. */
  local: Problem[];
  serverProblems: Problem[];
  onToggle: () => void;
  onChange: (rows: QRow[]) => void;
  onAdd: (kind: Kind, at: number) => void;
  onOpen: (uid: string) => void;
}

function Card({ row, index, rows, quiz, open, fresh, usedElsewhere, showProblems, local, serverProblems, onToggle, onChange, onAdd, onOpen }: CardProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: row.uid });
  const body = useId();
  const kind = row.question_type;
  const page = kind === "page_break";
  const flagged = [...serverProblems, ...local];
  const list = (field: string) => (showProblems || serverProblems.length ? flagged.filter((p) => p.field === field) : []);
  const number = answerable(kind) ? rows.slice(0, index + 1).filter((r) => answerable(r.question_type)).length : 0;
  const pageNo = page ? rows.slice(0, index + 1).filter((r) => r.question_type === "page_break").length + 1 : 0;
  const title = row.label.trim() || (kind === "statement" && row.help_text.trim()) || "";
  const label = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (fresh) {
      card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      label.current?.focus({ preventScroll: true });
    }
  }, [fresh]);

  const update = (patch: Partial<QRow>) => onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const at = (to: number) => onChange(move(rows, index, to));
  const copy = () => {
    const next = [...rows];
    const c = copyRow(rows, index);
    next.splice(index + 1, 0, c);
    onChange(next);
    onOpen(c.uid);
  };
  const remove = async () => {
    const uses = [...readers(rows, row.key).map((i) => tr("shown only if this is answered: “{value}”", { value: rows[i].label.trim() || rows[i].key })), ...usedElsewhere(row.key)];
    if (uses.length || row.id) {
      const ok = await confirmDialog({
        title: tr("Delete “{value}”?", { value: title || tr("this question") }),
        message: uses.length ? (
          <>
            <p>{tr("Other things depend on it:")}</p>
            <ul>
              {uses.map((u) => (
                <li key={u}>{isolate(u)}</li>
              ))}
            </ul>
            <p>{tr("They will need attention before the form can be saved.")}</p>
          </>
        ) : (
          tr("Answers already given to it stay in the responses and exports. It leaves the form when you save.")
        ),
        confirmLabel: tr("Delete it"),
        danger: true,
      });
      if (!ok) return;
    }
    onChange(rows.filter((_, i) => i !== index));
  };

  const key = (e: KeyboardEvent) => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      at(index + (e.key === "ArrowUp" ? -1 : 1));
    }
  };

  const typeSelect = (
    <div className="field fm-type-pick">
      <label className="field-label" htmlFor={`${body}-type`}>
        {tr("Type")}
      </label>
      <select id={`${body}-type`} className="select" value={kind} onChange={(e) => onChange(rows.map((r, i) => (i === index ? changeKind(r, e.target.value as Kind) : r)))}>
        {GROUPS.map((g) => (
          <optgroup key={g} label={g}>
            {KINDS.filter((k) => k.group === g).map((k) => (
              <option key={k.kind} value={k.kind}>
                {isolate(k.label)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );

  return (
    <li
      ref={(el) => {
        setNodeRef(el);
        card.current = el;
      }}
      className="fm-card"
      data-open={open ? "" : undefined}
      data-page={page ? "" : undefined}
      data-dragging={isDragging ? "" : undefined}
      data-flagged={flagged.length ? "" : undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div className="fm-card-head">
        <button type="button" className="fm-grip" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={tr("Reorder {value}", { value: title ? `“${title}”` : page ? tr("this page break") : tr("this question") })}>
          <GripVertical size={16} aria-hidden="true" />
        </button>
        <button type="button" className="fm-card-toggle" aria-expanded={open} aria-controls={body} onClick={onToggle} onKeyDown={key}>
          <span className="fm-kind" title={kindLabel(kind)}>
            <KindIcon kind={kind} />
          </span>
          <span className="fm-card-title">
            {page ? <strong>{tr("Page {pageNo}", { pageNo })}</strong> : number ? <span className="fm-num">{number}.</span> : null}
            <span className={title || page ? undefined : "faint"}>{title || (page ? "" : kind === "statement" ? tr("Write the text") : tr("Write the question"))}</span>
          </span>
          <span className="fm-card-tags">
            {row.required && answerable(kind) && (
              <span className="fm-tag" title={kind === "checkbox" ? tr("Must be ticked") : tr("Required")}>
                {tr("Required")}
              </span>
            )}
            {row.visible_if.trim() && (
              <span className="fm-tag" title={tr("Shown only if…")}>
                <GitBranch size={12} aria-hidden="true" /> {tr("Conditional")}
              </span>
            )}
            {flagged.length > 0 && (
              <span className="fm-warn" title={flagged[0].message}>
                <TriangleAlert size={15} aria-label={tr("Needs attention: {message}", { message: flagged[0].message })} />
              </span>
            )}
          </span>
          <ChevronDown className="fm-chevron" size={16} aria-hidden="true" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="icon-btn" aria-label={tr("More for {value}", { value: title ? `“${title}”` : tr("this question") })}>
              <Ellipsis size={16} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={index === 0} onSelect={() => at(index - 1)}>
              <ArrowUp size={14} aria-hidden="true" /> {tr("Move up")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={index === rows.length - 1} onSelect={() => at(index + 1)}>
              <ArrowDown size={14} aria-hidden="true" /> {tr("Move down")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onAdd("short_text", index + 1)}>
              <Plus size={14} aria-hidden="true" /> {tr("Add a question below")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={copy}>
              <Copy size={14} aria-hidden="true" /> {tr("Duplicate")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
              <Trash2 size={14} aria-hidden="true" /> {tr("Delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <div className="fm-card-body" id={body}>
          {page ? (
            <>
              <div className="field">
                <label className="field-label" htmlFor={`${body}-label`}>
                  {tr("Title of page {pageNo}", { pageNo })}
                </label>
                <input id={`${body}-label`} ref={label} className="input" value={row.label} placeholder={tr("Optional")} onChange={(e) => update({ label: e.target.value })} />
              </div>
              <Logic key={row.uid} rows={rows} index={index} onChange={(cel) => update({ visible_if: cel })} />
              <Err list={list("visible_if")} />
            </>
          ) : (
            <>
              <div className="field">
                <label className="field-label" htmlFor={`${body}-label`}>
                  {kind === "statement" ? tr("Heading") : tr("Question")}
                </label>
                <input
                  id={`${body}-label`}
                  ref={label}
                  className="input"
                  value={row.label}
                  maxLength={500}
                  placeholder={kind === "statement" ? tr("A heading (optional)") : tr("What would you like to ask?")}
                  onChange={(e) => update({ label: e.target.value })}
                  onBlur={() => onChange(nameFromLabel(rows, index))}
                />
                <Err list={list("label")} />
              </div>
              <div className="field">
                <label className="field-label" htmlFor={`${body}-help`}>
                  {kind === "statement" ? tr("Text") : tr("Help text")}
                </label>
                <textarea id={`${body}-help`} className="textarea" rows={2} maxLength={2000} value={row.help_text} placeholder={kind === "statement" ? tr("The words to read") : tr("Optional: say how to answer")} onChange={(e) => update({ help_text: e.target.value })} />
              </div>
              <Specifics key={`${row.uid}-${kind}`} row={row} update={update} list={list} />
              {answerable(kind) && (
                <div className="fm-switches">
                  <label className="check-field">
                    <input type="checkbox" checked={row.required} onChange={(e) => update({ required: e.target.checked })} />
                    <span>{kind === "checkbox" ? tr("Must be ticked") : tr("Required")}</span>
                  </label>
                  {!["file", "matrix", "ranking"].includes(kind) && (
                    <label className="check-field" title={tr("A link can fill this in: …/form?answer-id=value")}>
                      <input type="checkbox" checked={row.allow_prefill} onChange={(e) => update({ allow_prefill: e.target.checked })} />
                      <span>{tr("A link can fill it in")}</span>
                    </label>
                  )}
                </div>
              )}
              <Logic key={`logic-${row.uid}`} rows={rows} index={index} onChange={(cel) => update({ visible_if: cel })} />
              <Err list={list("visible_if")} />
              {quiz && gradable(kind) && <Correct row={row} update={update} />}
              {quiz && gradable(kind) && <Err list={[...list("correct_answer"), ...list("points")]} />}
            </>
          )}
          <div className="fm-card-foot">
            {!page && typeSelect}
            <p className="faint fm-key">
              {answerable(kind) ? (
                <>
                  {tr("Answer ID")} <code>{isolate(row.key)}</code>
                  {row.id ? tr(" (fixed once saved)") : ""}
                </>
              ) : null}
              <Err list={list("key")} />
            </p>
          </div>
        </div>
      )}
    </li>
  );
}

// ───────────────────────────── the list ─────────────────────────────

export interface QuestionsProps {
  rows: QRow[];
  onChange: (rows: QRow[]) => void;
  quiz: boolean;
  open: string | null;
  onOpen: (uid: string | null) => void;
  /** What the server said about each question, by row. */
  server: Record<string, Problem[]>;
  showProblems: boolean;
  usedElsewhere: (key: string) => string[];
}

export function Questions({ rows, onChange, quiz, open, onOpen, server, showProblems, usedElsewhere }: QuestionsProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [fresh, setFresh] = useState<string | null>(null);
  const found = useMemo(() => problems(rows), [rows]);

  const add = (kind: Kind, at = rows.length) => {
    const row = blankRow(kind, rows);
    const next = [...rows];
    next.splice(at, 0, row);
    onChange(next);
    onOpen(row.uid);
    setFresh(row.uid);
  };
  // What a screen reader says while a card is moved: its words, not its identifier.
  const name = (id: UniqueIdentifier) => {
    const r = rows.find((x) => x.uid === id);
    return r ? `“${r.label.trim() || kindLabel(r.question_type)}”` : tr("the question");
  };
  const place = (id: UniqueIdentifier | undefined) => tr("position {value} of {length}", { value: rows.findIndex((r) => r.uid === id) + 1, length: rows.length });
  const announcements: Announcements = {
    onDragStart: ({ active }) => tr("Picked up {value}. Use the arrow keys to move it, space to drop it, escape to cancel.", { value: name(active.id) }),
    onDragOver: ({ active, over }) => (over ? tr("{value} is over {value2}.", { value: name(active.id), value2: place(over.id) }) : undefined),
    onDragEnd: ({ active, over }) => (over ? tr("Dropped {value} at {value2}.", { value: name(active.id), value2: place(over.id) }) : tr("{value} was put back.", { value: name(active.id) })),
    onDragCancel: ({ active }) => tr("Moving {value} was cancelled.", { value: name(active.id) }),
  };
  const end = (e: DragEndEvent) => {
    const from = rows.findIndex((r) => r.uid === e.active.id);
    const to = rows.findIndex((r) => r.uid === e.over?.id);
    if (from >= 0 && to >= 0) onChange(move(rows, from, to));
  };

  if (!rows.length) {
    return (
      <section className="fm-empty" aria-label={tr("Add your first question")}>
        <h2 className="fm-empty-title">{tr("What do you want to ask?")}</h2>
        <p className="muted">{tr("Pick a type to start. You can change it later, and reorder everything.")}</p>
        <TypeList onPick={(k) => add(k)} />
      </section>
    );
  }

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={end} accessibility={{ announcements }}>
        <SortableContext items={rows.map((r) => r.uid)} strategy={verticalListSortingStrategy}>
          <ol className="fm-cards" aria-label={tr("Questions")}>
            {rows.map((r, i) => (
              <Card
                key={r.uid}
                row={r}
                index={i}
                rows={rows}
                quiz={quiz}
                open={open === r.uid}
                fresh={fresh === r.uid}
                usedElsewhere={usedElsewhere}
                showProblems={showProblems}
                local={found[i]}
                serverProblems={server[r.uid] ?? []}
                onToggle={() => onOpen(open === r.uid ? null : r.uid)}
                onChange={onChange}
                onAdd={(k, at) => add(k, at)}
                onOpen={(uid) => onOpen(uid)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <div className="fm-add">
        <AddButton variant="primary" onPick={(k) => add(k)} />
        <button type="button" className="btn btn-default btn-md" onClick={() => add("page_break")}>
          <Plus size={16} aria-hidden="true" />
          {tr("Add a page break")}
        </button>
      </div>
    </>
  );
}

