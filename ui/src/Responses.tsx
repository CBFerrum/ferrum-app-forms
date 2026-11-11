// The responses to a form: a table to scan (a card each on a phone), and a drawer to read one
// whole, with what can be done to it (review it, mark it as spam, make its record) and the way to
// the next and the one before.

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Columns3, ExternalLink, Paperclip } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { api, docPath, errorMessage, formatDateTime, formatMoment, shell, t as tr, isolate } from "@ferrum/client";
import { Badge, Button, ListSkeleton, StatePanel, type Tone, toast, placed } from "@ferrum/kit";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@ferrum/kit/primitives";
import { listOf } from "./rows";
import { answerable, type Kind } from "./model";
import { answerText, dayStart, duration, shiftDay } from "./stats";

export interface Asked {
  key: string;
  label: string;
  type: Kind;
  rows: string[];
}

export interface Resp {
  id: string;
  number?: string | null;
  status?: string | null;
  source?: string | null;
  submitted_at?: string | null;
  respondent_email?: string | null;
  respondent_name?: string | null;
  answers?: Record<string, unknown> | null;
  score?: string | null;
  max_score?: string | null;
  quiz_result?: string | null;
  quiz_detail?: { key: string; points: string; earned: string; correct: boolean }[] | null;
  completion_seconds?: number | null;
  spam_reason?: string | null;
  record_entity?: string | null;
  record_id?: string | null;
  record_error?: string | null;
}

/** The questions of a form, from its record. */
export function askedOf(doc: Record<string, unknown> | undefined): Asked[] {
  const rows = Array.isArray(doc?.questions) ? (doc?.questions as Record<string, unknown>[]) : [];
  return rows
    .filter((r) => r.question_type !== "page_break" && r.question_type !== "statement")
    .map((r) => ({ key: String(r.key ?? ""), label: String(r.label ?? ""), type: r.question_type as Kind, rows: listOf(r.matrix_rows) }))
    .filter((a) => answerable(a.type));
}

const FIELDS = "number,status,source,submitted_at,respondent_email,respondent_name,answers,score,max_score,quiz_result,completion_seconds";
const TONE: Record<string, Tone> = { New: "blue", Reviewed: "green", Spam: "red" };
const who = (r: Resp) => r.respondent_name || r.respondent_email || tr("Anonymous");
const when = (iso?: string | null) => formatMoment(iso, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

// ───────────────────────────── one answer, whole ─────────────────────────────

function Answer({ a, v }: { a: Asked; v: unknown }) {
  if (v === undefined || v === null || (Array.isArray(v) && !v.length)) return <span className="faint">{tr("No answer")}</span>;
  switch (a.type) {
    case "file":
      return (
        <ul className="fm-attach">
          {(v as { file_name?: string; url?: string; size?: number }[]).map((f, i) => (
            <li key={i}>
              <Paperclip size={14} aria-hidden="true" />
              {f.url && /^(\/files\/|https?:\/\/)/.test(f.url) ? (
                <a href={f.url} target="_blank" rel="noopener noreferrer">
                  {isolate(f.file_name ?? "")}
                </a>
              ) : (
                f.file_name
              )}
            </li>
          ))}
        </ul>
      );
    case "matrix":
      return (
        <dl className="fm-grid-answer">
          {a.rows.map((r) => (
            <div key={r}>
              <dt className="faint">{isolate(r)}</dt>
              <dd>{(v as Record<string, string>)[r] ?? <span className="faint">{tr("No answer")}</span>}</dd>
            </div>
          ))}
        </dl>
      );
    case "ranking":
      return (
        <ol className="fm-ranked">
          {(v as string[]).map((x) => (
            <li key={x}>{isolate(x)}</li>
          ))}
        </ol>
      );
    case "multi_select":
      return (
        <div className="chips">
          {(v as string[]).map((x) => (
            <span key={x} className="fm-pill">
              {isolate(x)}
            </span>
          ))}
        </div>
      );
    case "long_text":
      return <p className="fm-longtext">{isolate(String(v))}</p>;
    default:
      return <>{isolate(answerText(a.type, v, a.rows))}</>;
  }
}

// ───────────────────────────── the drawer ─────────────────────────────

function Detail({ id, asked, canRecord, ids, onGo, onChanged }: { id: string; asked: Asked[]; canRecord: boolean; ids: string[]; onGo: (id: string) => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["forms", "response", id], queryFn: ({ signal }) => api.get<Resp>(docPath("FormResponse", id), undefined, signal) });
  const r = q.data;
  const at = ids.indexOf(id);

  const run = async (name: "mark_reviewed" | "mark_spam" | "not_spam" | "create_record", done: string) => {
    try {
      await api.post(docPath("FormResponse", id, "actions", name), {});
      toast(done);
      void qc.invalidateQueries({ queryKey: ["forms", "response", id] });
      onChanged();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "ArrowLeft" && at > 0) onGo(ids[at - 1]);
      if (e.key === "ArrowRight" && at >= 0 && at < ids.length - 1) onGo(ids[at + 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, ids, onGo]);

  if (q.error) return <StatePanel kind="failed" error={q.error} onRetry={() => void q.refetch()} />;
  if (!r) return <ListSkeleton rows={2} />;
  const detail = new Map((r.quiz_detail ?? []).map((d) => [d.key, d]));
  const spam = r.status === "Spam";
  return (
    <div className="fm-detail">
      <div className="fm-detail-actions">
        {r.status === "New" && <Button onClick={() => void run("mark_reviewed", tr("Marked as reviewed"))}>{tr("Mark reviewed")}</Button>}
        {spam ? <Button onClick={() => void run("not_spam", tr("Not spam"))}>{tr("This is not spam")}</Button> : <Button onClick={() => void run("mark_spam", tr("Marked as spam"))}>{tr("Mark as spam")}</Button>}
        {canRecord && !r.record_id && !spam && (
          <Button variant="primary" onClick={() => void run("create_record", tr("The record was made"))}>
            {tr("Make the record")}
          </Button>
        )}
        {r.record_id && r.record_entity && (
          <Button onClick={() => shell().navigate({ entity: r.record_entity as string, id: r.record_id as string })}>
            <ExternalLink size={14} aria-hidden="true" /> {tr("Open the record")}
          </Button>
        )}
      </div>
      {r.record_error && <p className="field-error">{tr("The record could not be made: {record_error}", { record_error: r.record_error })}</p>}
      {spam && r.spam_reason && <p className="muted">{tr("Kept as spam because {spam_reason}.", { spam_reason: r.spam_reason })}</p>}
      <dl className="fm-meta">
        <div>
          <dt className="faint">{tr("From")}</dt>
          <dd>{isolate(who(r))}</dd>
        </div>
        <div>
          <dt className="faint">{tr("Sent")}</dt>
          <dd>{r.submitted_at ? formatDateTime(r.submitted_at) : "–"}</dd>
        </div>
        <div>
          <dt className="faint">{tr("Took")}</dt>
          <dd>{isolate(duration(r.completion_seconds))}</dd>
        </div>
        <div>
          <dt className="faint">{tr("Through")}</dt>
          <dd>{isolate(r.source ?? "")}</dd>
        </div>
      </dl>
      {r.max_score && Number(r.max_score) > 0 && (
        <p className="fm-score-line">
          {placed(tr("Score {p1} of {max_score} {p2}"), { p1: <strong>{isolate(r.score ?? "")}</strong>, max_score: r.max_score, p2: r.quiz_result && <Badge tone={r.quiz_result === "Passed" ? "green" : "red"}>{isolate(r.quiz_result)}</Badge> })}
        </p>
      )}
      <ol className="fm-answers">
        {asked.map((a) => {
          const d = detail.get(a.key);
          return (
            <li key={a.key}>
              <p className="fm-answer-q">
                {isolate(a.label)}
                {d && <span className={d.correct ? "fm-right" : "fm-wrong"}> {d.correct ? tr("Right") : tr("Wrong")} · {isolate(d.earned)}/{isolate(d.points)}</span>}
              </p>
              <div className="fm-answer-a">
                <Answer a={a} v={r.answers?.[a.key]} />
              </div>
            </li>
          );
        })}
      </ol>
      <div className="fm-detail-nav">
        <Button disabled={at <= 0} onClick={() => onGo(ids[at - 1])}>
          <ChevronLeft size={16} aria-hidden="true" /> {tr("Newer")}
        </Button>
        <Button disabled={at < 0 || at >= ids.length - 1} onClick={() => onGo(ids[at + 1])}>
          {tr("Older")} <ChevronRight size={16} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────────── the list ─────────────────────────────

const STATUS: [string, string][] = [
  ["", "Answers"],
  ["New", "New"],
  ["Reviewed", "Reviewed"],
  ["Spam", "Spam"],
];

export interface ResponsesProps {
  formId: string;
  asked: Asked[];
  zone: string;
  status: string;
  from: string | null;
  to: string | null;
  open: string | null;
  canRecord: boolean;
  /** The questions shown as columns (null: the first few). */
  cols: string[] | null;
  onCols: (keys: string[] | null) => void;
  onStatus: (s: string) => void;
  onOpen: (id: string | null) => void;
}

export function Responses({ formId, asked, zone, status, from, to, open, canRecord, cols, onCols, onStatus, onOpen }: ResponsesProps) {
  const qc = useQueryClient();
  const filters: unknown[] = [["form", "=", formId], status ? ["status", "=", status] : ["status", "!=", "Spam"]];
  if (from) filters.push(["submitted_at", ">=", dayStart(from, zone)]);
  if (to) filters.push(["submitted_at", "<", dayStart(shiftDay(to, 1), zone)]);
  const list = useInfiniteQuery({
    queryKey: ["forms", "responses", formId, status, from, to],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api.get<{ rows: Resp[]; next_cursor?: string | null }>("/api/v1/FormResponse", { filters: JSON.stringify(filters), fields: FIELDS, sort: "created_at desc", limit: 50, cursor: pageParam || undefined }, signal),
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.rows) ?? [];
  // The questions that read well in a cell come first; a person can choose others.
  const handy = asked.filter((a) => ["short_text", "email", "phone", "number", "decimal", "date", "select", "dropdown", "likert", "rating", "nps", "checkbox", "multi_select"].includes(a.type));
  const columns = cols ? asked.filter((a) => cols.includes(a.key)) : handy.slice(0, 3);
  const changed = () => {
    void qc.invalidateQueries({ queryKey: ["forms", "responses", formId] });
    void qc.invalidateQueries({ queryKey: ["forms", "summary", formId] });
  };

  let body: ReactNode;
  if (list.error) body = <StatePanel kind="failed" error={list.error} onRetry={() => void list.refetch()} />;
  else if (!list.data) {
    body = (
      <ListSkeleton rows={4} />
    );
  } else if (!rows.length) {
    body = (
<StatePanel kind={status || from || to ? "no-matches" : "empty"} title={status === "Spam" ? tr("No spam") : status ? tr("No {status} responses", { status: status.toLowerCase() }) : from || to ? tr("No responses in these days") : tr("No responses yet")}>
        {status || from || to ? tr("Try other days, or another filter.") : tr("They appear here as soon as someone sends the form.")}
      </StatePanel>
    );
  } else {
    body = (
      <>
        <div className="fm-table-wrap">
          <table className="fm-table">
            <thead>
              <tr>
                <th scope="col">{tr("Response")}</th>
                <th scope="col">{tr("From")}</th>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className="fm-col-q">
                    {isolate(c.label)}
                  </th>
                ))}
                <th scope="col">{tr("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-open={open === r.id ? "" : undefined}>
                  <td>
                    <button type="button" className="fm-row-open" onClick={() => onOpen(r.id)}>
                      <strong>{isolate(r.number ?? "")}</strong>
                      <span className="faint">{isolate(when(r.submitted_at))}</span>
                    </button>
                  </td>
                  <td>{isolate(who(r))}</td>
                  {columns.map((c) => (
                    <td key={c.key} className="fm-col-q">
                      <span className="fm-clip">{isolate(answerText(c.type, r.answers?.[c.key], c.rows))}</span>
                    </td>
                  ))}
                  <td>
                    <Badge tone={TONE[r.status ?? ""] ?? "neutral"}>{isolate(r.status ?? "")}</Badge>
                    {r.max_score && Number(r.max_score) > 0 ? <span className="faint"> {isolate(r.score ?? "")}/{isolate(r.max_score)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.hasNextPage && (
          <div className="fm-more-row">
            <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {tr("Show older responses")}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="fm-responses">
      <div className="fm-tools">
        <div className="chips" role="group" aria-label={tr("Show")}>
          {STATUS.map(([v, label]) => (
            <button key={v} type="button" className="fm-pill" aria-pressed={status === v} onClick={() => onStatus(v)}>
              {isolate(label)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {asked.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                <Columns3 size={16} aria-hidden="true" />
                {tr("Columns")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="fm-columns-menu">
              {asked.map((a) => (
                <DropdownMenuCheckboxItem
                  key={a.key}
                  checked={columns.some((c) => c.key === a.key)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(on) => {
                    const keys = columns.map((c) => c.key);
                    onCols((on ? asked.filter((x) => keys.includes(x.key) || x.key === a.key) : asked.filter((x) => keys.includes(x.key) && x.key !== a.key)).map((x) => x.key));
                  }}
                >
                  {a.label || a.key}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {body}
      <Sheet open={!!open} onOpenChange={(o) => !o && onOpen(null)}>
        <SheetContent className="fm-sheet">
          <SheetHeader>
            <SheetTitle>{rows.find((r) => r.id === open)?.number ?? tr("Response")}</SheetTitle>
            <SheetDescription>{rows.find((r) => r.id === open) ? who(rows.find((r) => r.id === open) as Resp) : tr("One response, whole")}</SheetDescription>
          </SheetHeader>
          <div className="fm-sheet-body">{open && <Detail key={open} id={open} asked={asked} canRecord={canRecord} ids={rows.map((r) => r.id)} onGo={onOpen} onChanged={changed} />}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
