// What a form has gathered: the numbers (how many, how many finished, how long it took, a card per
// question), and every response to read. The days to look at and the filters live in the address,
// so a view can be sent as a link; the export takes the same days and filter.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Download, Pencil } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { api, bootstrap, docPath, download, errorMessage, t } from "@ferrum/client";
import { Badge, Button, EmptyState, ErrorState, PageLoading, TabPanel, Tabs, toast, useLiveEntity, useShellTitle } from "@ferrum/kit";
import { can, useEntityMeta } from "@ferrum/records";
import { QuestionCard, Trend } from "./Charts";
import { zonedNow } from "./flow";
import { type FormDoc, STATUS_LABEL, STATUS_TONE, type Status } from "./formdoc";
import { type Asked, askedOf, Responses } from "./Responses";
import { duration, percent, PRESETS, presetOf, presetRange, type Summary } from "./stats";
import { copy, linkOf } from "./Share";

const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

function Tile({ label, value, hint, to }: { label: string; value: string | number; hint?: string; to?: string }) {
  const inner = (
    <>
      <span className="fm-tile-n">{value}</span>
      <span className="fm-tile-l">{label}</span>
      {hint && <span className="faint fm-tile-h">{hint}</span>}
    </>
  );
  return to ? (
    <Link className="fm-tile" to={to}>
      {inner}
    </Link>
  ) : (
    <div className="fm-tile">{inner}</div>
  );
}

export function ResultsRoute() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const view = sp.get("view") === "responses" || sp.get("open") ? "responses" : "summary";
  const status = sp.get("status") ?? "";
  const from = day(sp.get("from"));
  const to = day(sp.get("to"));
  const open = sp.get("open");
  const cols = sp.get("cols") ? (sp.get("cols") as string).split(",").filter(Boolean) : null;
  const zone = bootstrap()?.locale.timezone ?? "UTC";
  const today = zonedNow(zone).today;
  const meta = useEntityMeta("FormResponse").data;

  const doc = useQuery({ queryKey: ["forms", "doc", id], queryFn: ({ signal }) => api.get<FormDoc>(docPath("Form", id), undefined, signal) });
  const summary = useQuery({
    queryKey: ["forms", "summary", id, from, to],
    queryFn: ({ signal }) => api.get<Summary>(`/api/app/forms/forms/${id}/summary`, { from, to }, signal),
  });
  useShellTitle(doc.data ? `Results: ${String(doc.data.title ?? "")}` : "Results");

  // New responses arrive while this is open: refresh, but not for each one of a burst.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useLiveEntity(
    "FormResponse",
    useCallback(() => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["forms", "summary", id] });
        void qc.invalidateQueries({ queryKey: ["forms", "responses", id] });
      }, 800);
    }, [qc, id]),
  );

  const set = (p: Record<string, string | null>) =>
    setSp(
      (cur) => {
        const next = new URLSearchParams(cur);
        for (const [k, v] of Object.entries(p)) v ? next.set(k, v) : next.delete(k);
        return next;
      },
      { replace: true },
    );

  if (doc.error) return <ErrorState error={doc.error} onRetry={() => void doc.refetch()} title={t("Could not open this form")} />;
  if (!doc.data) return <PageLoading label={t("Opening the results…")} />;
  const form = doc.data;
  const asked: Asked[] = askedOf(form);
  const live = form.status === "Published";
  const slug = typeof form.slug === "string" ? form.slug : "";
  const s = summary.data;
  const preset = presetOf(from, to, today);
  const exportCsv = async () => {
    try {
      await download(`/api/app/forms/forms/${id}/export.csv`, "responses.csv", { from, to, status: status || undefined });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <div className="fm-page fm-results">
      <header className="fm-head">
        <div className="fm-head-top">
          <Link className="fm-back" to="/" aria-label={t("All forms")}>
            <ArrowLeft size={16} aria-hidden="true" /> {t("Forms")}
          </Link>
        </div>
        <div className="fm-head-main">
          <div className="fm-title-wrap">
            <h1 className="page-title">{String(form.title ?? "Untitled form")}</h1>
            <p className="page-sub">{t("Results")}</p>
          </div>
          <div className="fm-actions">
            <Badge tone={STATUS_TONE[(form.status ?? "Draft") as Status]}>{STATUS_LABEL[(form.status ?? "Draft") as Status]}</Badge>
            {slug && live && (
              <Button onClick={() => void copy(linkOf(slug))}>
                <Copy size={16} aria-hidden="true" />
                {t("Copy the link")}
              </Button>
            )}
            {can(meta?.permissions, "export") && (
              <Button onClick={() => void exportCsv()}>
                <Download size={16} aria-hidden="true" />
                {t("Export")}
              </Button>
            )}
            <Link className="btn btn-default btn-md" to={`/b/${id}`}>
              <Pencil size={16} aria-hidden="true" />
              {t("Edit")}
            </Link>
          </div>
        </div>
        <div className="fm-tabs">
          <Tabs
            id="results"
            value={view}
            onChange={(v) => set({ view: v === "responses" ? "responses" : null, open: null })}
            tabs={[
              { id: "summary", label: "Summary" },
              { id: "responses", label: <>{t("Responses")}{s ? <span className="fm-count">{s.responses}</span> : null}</> },
            ]}
          />
        </div>
      </header>

      <div className="fm-filters" role="group" aria-label={t("Days to look at")}>
        <div className="chips">
          {PRESETS.map(([p, label]) => (
            <button key={p} type="button" className="chip" aria-pressed={preset === p} onClick={() => { const [a, b] = presetRange(p, today); set({ from: a, to: b }); }}>
              {label}
            </button>
          ))}
        </div>
        <label className="fm-date">
          <span className="faint">{t("From")}</span>
          <input className="input" type="date" max={to ?? undefined} value={from ?? ""} onChange={(e) => set({ from: e.target.value || null })} />
        </label>
        <label className="fm-date">
          <span className="faint">{t("To")}</span>
          <input className="input" type="date" min={from ?? undefined} value={to ?? ""} onChange={(e) => set({ to: e.target.value || null })} />
        </label>
      </div>

      <TabPanel id="results" tab={view}>
        {view === "summary" ? (
          summary.error ? (
            <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
          ) : !s ? (
            <div className="fm-tiles" aria-busy="true" aria-label={t("Loading the numbers")}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="fm-tile">
                  <span className="skeleton" style={{ width: "50%", height: 24 }} />
                </div>
              ))}
            </div>
          ) : s.responses === 0 && !s.spam ? (
            <EmptyState title={from || to ? "No responses in these days" : "No responses yet"} icon="doc">
              {from || to ? (
                <Button onClick={() => set({ from: null, to: null })}>{t("Look at all time")}</Button>
              ) : live && slug ? (
                <>
                  <p className="muted">{t("Share the link and the answers collect here.")}</p>
                  <Button variant="primary" onClick={() => void copy(linkOf(slug))}>
                    <Copy size={16} aria-hidden="true" /> {t("Copy the link")}
                  </Button>
                </>
              ) : (
                <>
                  <p className="muted">{form.status === "Closed" ? "It was closed before anyone answered." : "Publish the form to start taking responses."}</p>
                  <Link className="btn btn-primary btn-md" to={`/b/${id}?tab=share`}>
                    {form.status === "Closed" ? "Reopen it" : "Publish it"}
                  </Link>
                </>
              )}
            </EmptyState>
          ) : (
            <>
              <div className="fm-tiles">
                <Tile label={s.responses === 1 ? "response" : "responses"} value={s.responses} />
                <Tile label={t("opened it")} value={s.views} hint={t("people who opened the link")} />
                <Tile label="finished" value={percent(s.completion_rate)} hint={t("of those who opened it")} />
                <Tile label={t("typical time")} value={duration(s.completion_time.median_seconds)} />
                {s.quiz && <Tile label={t("average score")} value={percent(s.quiz.average_percent)} hint={`${s.quiz.graded} marked`} />}
                {s.quiz && s.quiz.passed + s.quiz.failed > 0 && <Tile label="passed" value={percent(s.quiz.pass_rate)} hint={`${s.quiz.passed} of ${s.quiz.passed + s.quiz.failed}`} />}
                {s.spam > 0 && <Tile label={t("kept as spam")} value={s.spam} to={`?view=responses&status=Spam`} />}
              </div>
              <Trend trend={s.trend} />
              <div className="fm-qcards">
                {s.questions.map((q, i) => (
                  <QuestionCard key={q.key} q={q} formId={id} n={i + 1} />
                ))}
              </div>
            </>
          )
        ) : (
          <Responses
            formId={id}
            asked={asked}
            zone={zone}
            status={status}
            from={from}
            to={to}
            open={open}
            canRecord={typeof form.target_entity === "string" && form.target_entity !== ""}
            cols={cols}
            onCols={(keys) => set({ cols: keys && keys.length ? keys.join(",") : null })}
            onStatus={(v) => set({ status: v || null })}
            onOpen={(rid) => set({ open: rid, view: "responses" })}
          />
        )}
      </TabPanel>
    </div>
  );
}

/** /response/{id}: a link to one response (a notification, the bar's search) opens it in its form's results. */
export function ResponseRoute() {
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["forms", "response-form", id], queryFn: ({ signal }) => api.get<{ form?: string }>(docPath("FormResponse", id), { fields: "form" }, signal) });
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title={t("Could not open this response")} />;
  if (!q.data) return <PageLoading />;
  return <Navigate to={q.data.form ? `/b/${q.data.form}/results?view=responses&open=${id}` : "/"} replace />;
}
