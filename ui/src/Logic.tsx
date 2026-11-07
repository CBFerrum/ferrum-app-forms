// "Show only if…" on a question or a page: rules a person can write (a question, what to compare,
// a value), or the CEL itself for anything rules cannot say. Whatever is written is the
// question's `visible_if`; the server reads it again when it is saved, and when anyone answers.

import { GitBranch, Plus, X } from "lucide-react";
import { useState } from "react";
import { earlier, type QRow } from "./rows";
import { LIKERT_DEFAULT, type Kind } from "./model";
import { type Condition, describe, fromCel, needsValue, opLabel, opsFor, ordered, type Rule, toCel } from "./rules";
import { t, isolate } from "@ferrum/client";

const CHOICES: Kind[] = ["select", "dropdown", "likert", "multi_select", "ranking"];

function Value({ rule, question, onChange }: { rule: Rule; question: QRow | undefined; onChange: (r: Rule) => void }) {
  const kind = question?.question_type ?? "short_text";
  if (!needsValue(rule.op)) return null;
  if (rule.op === "cell") {
    return (
      <>
        <select className="select" aria-label={t("Statement")} value={rule.row ?? ""} onChange={(e) => onChange({ ...rule, row: e.target.value })}>
          <option value="">{t("Statement…")}</option>
          {question?.matrix_rows.map((r) => (
            <option key={r}>{isolate(r)}</option>
          ))}
        </select>
        <select className="select" aria-label={t("Answer")} value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })}>
          <option value="">{t("Answer…")}</option>
          {question?.options.map((o) => (
            <option key={o}>{isolate(o)}</option>
          ))}
        </select>
      </>
    );
  }
  if (CHOICES.includes(kind)) {
    const options = kind === "likert" && !question?.options.length ? LIKERT_DEFAULT : (question?.options ?? []);
    return (
      <select className="select" aria-label={t("Value")} value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })}>
        <option value="">{t("Choose…")}</option>
        {rule.value && !options.includes(rule.value) && <option>{isolate(rule.value)}</option>}
        {options.map((o) => (
          <option key={o}>{isolate(o)}</option>
        ))}
      </select>
    );
  }
  const type = kind === "date" ? "date" : kind === "time" ? "time" : ordered(kind) ? "number" : "text";
  return <input className="input" aria-label={t("Value")} type={type} step={kind === "decimal" ? "any" : undefined} value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })} />;
}

export function Logic({ rows, index, onChange }: { rows: QRow[]; index: number; onChange: (cel: string) => void }) {
  const row = rows[index];
  const page = row.question_type === "page_break";
  const parsed = fromCel(row.visible_if, rows);
  const [cond, setCond] = useState<Condition>(parsed ?? { join: "all", rules: [] });
  const [asCel, setAsCel] = useState(parsed === null);
  const before = earlier(rows, index);
  const kindOf = (key: string) => rows.find((r) => r.key === key)?.question_type ?? "short_text";

  const set = (next: Condition) => {
    setCond(next);
    onChange(toCel(next, rows));
  };
  const setRule = (i: number, rule: Rule) => set({ ...cond, rules: cond.rules.map((r, j) => (j === i ? rule : r)) });
  const subject = page ? "page" : "question";

  if (asCel) {
    return (
      <div className="fm-logic">
        <p className="fm-logic-head">
          <GitBranch size={15} aria-hidden="true" /> {t("Show this {subject} only if (CEL)", { subject })}
        </p>
        <textarea
          className="textarea mono"
          rows={3}
          aria-label={t("Condition in CEL")}
          spellCheck={false}
          value={row.visible_if}
          onChange={(e) => onChange(e.target.value)}
          placeholder="answers.country == 'IN' && answers.age >= 18"
        />
        <p className="field-hint">
          {t("Read an earlier answer as")} <code>answers.&lt;ID&gt;</code>{t(", today as")} <code>{t("today")}</code>{t(". An answer left empty is")} <code>{t("null")}</code>.
        </p>
        <div className="row">
          <button
            type="button"
            className="btn btn-default btn-sm"
            disabled={fromCel(row.visible_if, rows) === null}
            title={fromCel(row.visible_if, rows) === null ? t("This condition says more than rules can") : undefined}
            onClick={() => {
              setCond(fromCel(row.visible_if, rows) ?? { join: "all", rules: [] });
              setAsCel(false);
            }}
          >
            {t("Use rules")}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => (onChange(""), setCond({ join: "all", rules: [] }), setAsCel(false))}>
            {t("Always show it")}
          </button>
        </div>
      </div>
    );
  }

  if (!cond.rules.length) {
    return (
      <div className="fm-logic">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!before.length}
          title={before.length ? undefined : t("A condition reads the answers before it: add a question above first")}
          onClick={() => setCond({ join: "all", rules: [{ key: before[before.length - 1]?.key ?? "", op: opsFor(before[before.length - 1]?.question_type ?? "short_text")[0], value: "" }] })}
        >
          <GitBranch size={15} aria-hidden="true" /> {t("Show this {subject} only if…", { subject })}
        </button>
        {!before.length && <span className="faint fm-logic-note">{t("Needs a question before it.")}</span>}
      </div>
    );
  }

  return (
    <div className="fm-logic">
      <p className="fm-logic-head">
        <GitBranch size={15} aria-hidden="true" /> {t("Show this {subject} if", { subject })}
        {cond.rules.length > 1 ? (
          <select className="select fm-join" aria-label={t("Match")} value={cond.join} onChange={(e) => set({ ...cond, join: e.target.value as "all" | "any" })}>
            <option value="all">{t("all of these")}</option>
            <option value="any">{t("any of these")}</option>
          </select>
        ) : (
          t(" this")
        )}
        :
      </p>
      <ul className="fm-rules">
        {cond.rules.map((r, i) => {
          const kind = kindOf(r.key);
          const known = before.some((b) => b.key === r.key);
          return (
            <li key={i} className="fm-rule" data-bad={r.key && !known ? "" : undefined}>
              <select
                className="select"
                aria-label={t("Question")}
                value={r.key}
                onChange={(e) => {
                  const q = rows.find((x) => x.key === e.target.value);
                  const ops = opsFor(q?.question_type ?? "short_text");
                  setRule(i, { key: e.target.value, op: ops.includes(r.op) && kindOf(r.key) === q?.question_type ? r.op : ops[0], value: kindOf(r.key) === q?.question_type ? r.value : "", row: undefined });
                }}
              >
                <option value="">{t("Question…")}</option>
                {r.key && !known && <option value={r.key}>{t("{key} (not before this one)", { key: r.key })}</option>}
                {before.map((b) => (
                  <option key={b.uid} value={b.key}>
                    {b.label.trim() || b.key}
                  </option>
                ))}
              </select>
              <select className="select" aria-label={t("Condition")} value={r.op} onChange={(e) => setRule(i, { ...r, op: e.target.value as Rule["op"] })}>
                {opsFor(kind).map((op) => (
                  <option key={op} value={op}>
                    {isolate(opLabel(op, kind))}
                  </option>
                ))}
              </select>
              <Value rule={r} question={rows.find((x) => x.key === r.key)} onChange={(next) => setRule(i, next)} />
              <button type="button" className="icon-btn" aria-label={t("Remove this rule")} onClick={() => set({ ...cond, rules: cond.rules.filter((_, j) => j !== i) })}>
                <X size={16} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="row">
        <button
          type="button"
          className="btn btn-default btn-sm"
          onClick={() => set({ ...cond, rules: [...cond.rules, { key: before[before.length - 1]?.key ?? "", op: opsFor(before[before.length - 1]?.question_type ?? "short_text")[0], value: "" }] })}
        >
          <Plus size={14} aria-hidden="true" /> {t("Add a rule")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsCel(true)}>
          {t("Edit as CEL")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ ...cond, rules: [] })}>
          {t("Remove the condition")}
        </button>
      </div>
      {row.visible_if && <p className="faint fm-logic-sum">{isolate(describe(cond, rows))}</p>}
    </div>
  );
}
