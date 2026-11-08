// What the answers add up to, a card to a question: bars for choices, columns for a scale, a score
// for NPS, a table for a grid, a ranked list, and the words people wrote. The charts are made of
// the page's own elements and the theme's chart colours; each also exists as text for a screen
// reader, with every number the picture has.

import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { api, formatDateTime, t as tr, isolate } from "@ferrum/client";
import { Button, ErrorState, Spinner } from "@ferrum/kit";
import { kindLabel } from "./model";
import { type AnswersPage, npsGroup, num, percent, type QSummary, type Summary, trendLine } from "./stats";

// ───────────────────────────── the days ─────────────────────────────

const W = 640;
const H = 140;

/** Responses per day. */
export function Trend({ trend }: { trend: Summary["trend"] }) {
  const t = trendLine(trend, W, H, 10);
  const total = trend.reduce((n, d) => n + d.responses, 0);
  const best = trend.reduce((b, d) => (d.responses > b.responses ? d : b), trend[0] ?? { date: "", responses: 0 });
  const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const id = useId();
  if (!trend.length) return null;
  return (
    <figure className="fm-trend">
      <figcaption className="fm-trend-head">
        <strong>{tr("Responses a day")}</strong>
        <span className="faint">
          {(best.responses > 0 ? tr("{total} in {length} days, most on {value} ({responses})", { total, length: trend.length, value: day(best.date), responses: best.responses }) : tr("{total} in {length} days", { total, length: trend.length }))}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-labelledby={id} className="fm-trend-svg">
        <title id={id}>{tr("{total} responses in {length} days, from {value} to {value2}", { total, length: trend.length, value: day(trend[0].date), value2: day(trend[trend.length - 1].date) })}</title>
        <line x1="10" x2={W - 10} y1={H - 10} y2={H - 10} className="fm-axis" />
        <path d={t.area} className="fm-area" />
        <path d={t.line} className="fm-line" vectorEffect="non-scaling-stroke" />
        {trend.length <= 31 && t.dots.filter((d) => d.responses > 0).map((d) => <circle key={d.date} cx={d.x} cy={d.y} r="3" className="fm-dot-mark" vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div className="fm-trend-axis faint" aria-hidden="true">
        <span>{isolate(day(trend[0].date))}</span>
        <span>{tr("{max} a day at most", { max: t.max })}</span>
        <span>{isolate(day(trend[trend.length - 1].date))}</span>
      </div>
    </figure>
  );
}

// ───────────────────────────── pieces ─────────────────────────────

function Bars({ rows }: { rows: { label: string; count: number; percent: string | null }[] }) {
  return (
    <ul className="fm-bars">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="fm-bar-label">{isolate(r.label)}</span>
          <span className="fm-bar-track" aria-hidden="true">
            <span style={{ width: `${Math.min(100, num(r.percent))}%` }} />
          </span>
          <span className="fm-bar-value">
            {r.count} <span className="faint">({isolate(percent(r.percent))})</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Columns({ dist, nps }: { dist: NonNullable<QSummary["distribution"]>; nps?: boolean }) {
  const max = Math.max(1, ...dist.map((d) => d.count));
  return (
    <>
      <div className="fm-columns" aria-hidden="true" data-nps={nps ? "" : undefined}>
        {dist.map((d) => (
          <div key={d.value} className="fm-column" data-group={nps ? npsGroup(d.value) : undefined}>
            <span className="fm-column-n">{d.count || ""}</span>
            <span className="fm-column-bar" style={{ height: `${(d.count / max) * 100}%` }} />
            <span className="fm-column-label">{d.value}</span>
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>{tr("Answers by value")}</caption>
        <thead>
          <tr>
            <th>{tr("Value")}</th>
            <th>{tr("Answers")}</th>
            <th>{tr("Share")}</th>
          </tr>
        </thead>
        <tbody>
          {dist.map((d) => (
            <tr key={d.value}>
              <td>{d.value}</td>
              <td>{d.count}</td>
              <td>{isolate(percent(d.percent))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="fm-facts-grid">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="faint">{isolate(k)}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The words people wrote, newest first, a page at a time. */
function Words({ formId, q }: { formId: string; q: QSummary }) {
  const [open, setOpen] = useState(false);
  const pages = useInfiniteQuery({
    queryKey: ["forms", "answers", formId, q.key],
    enabled: open,
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) => api.get<AnswersPage>(`/api/app/forms/forms/${formId}/answers/${encodeURIComponent(q.key)}`, { limit: 10, cursor: pageParam || undefined }, signal),
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
  const answers = pages.data?.pages.flatMap((p) => p.answers) ?? [];
  if (!q.answered) return null;
  return (
    <div className="fm-words">
      {!open ? (
        <Button onClick={() => setOpen(true)}>
          <ChevronDown size={16} aria-hidden="true" /> {tr("Read the answers")}
        </Button>
      ) : pages.error ? (
        <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />
      ) : !pages.data ? (
        <Spinner label={tr("Loading the answers")} />
      ) : (
        <>
          <ul className="fm-quotes">
            {answers.map((a) => (
              <li key={a.response}>
                <p>{isolate(a.text)}</p>
                <p className="faint">
                  {isolate(a.number ?? "")} · {isolate(formatDateTime(a.submitted_at))}
                </p>
              </li>
            ))}
          </ul>
          {pages.hasNextPage && (
            <Button loading={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
              {tr("Show older answers")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

// ───────────────────────────── a question ─────────────────────────────

const signed = (v: string | null | undefined) => (v === null || v === undefined ? "–" : num(v) > 0 ? `+${num(v)}` : String(num(v)));

function Body({ q, formId }: { q: QSummary; formId: string }) {
  if (q.answered === 0 && q.type !== "checkbox") return <p className="muted">{tr("Nobody has answered this yet.")}</p>;
  switch (q.type) {
    case "select":
    case "dropdown":
    case "multi_select":
    case "likert": {
      const rows = (q.options ?? []).map((o) => ({ label: o.option, count: o.count, percent: o.percent }));
      if (q.other) rows.push({ label: tr("Other"), count: q.other.count, percent: q.other.percent });
      return (
        <>
          <Bars rows={rows} />
          {q.type === "likert" && q.average && <Facts items={[[tr("Average, from 1 to ") + (q.options?.length ?? 5), num(q.average)]]} />}
          {q.type === "multi_select" && <p className="field-hint">{tr("Shares are of the people who answered; each could choose more than one.")}</p>}
        </>
      );
    }
    case "checkbox":
      return <Bars rows={[{ label: tr("Ticked"), count: q.yes?.count ?? 0, percent: q.yes?.percent ?? null }, { label: tr("Not ticked"), count: q.no?.count ?? 0, percent: q.no?.percent ?? null }]} />;
    case "rating":
      return (
        <>
          <Columns dist={q.distribution ?? []} />
          <Facts items={[[tr("Average"), q.average ? num(q.average) : "–"]]} />
        </>
      );
    case "nps": {
      const parts: [string, string, typeof q.promoters][] = [[tr("Promoters"), "promoter", q.promoters], [tr("Passives"), "passive", q.passives], [tr("Detractors"), "detractor", q.detractors]];
      return (
        <>
          <div className="fm-nps-score">
            <p className="fm-nps-n">{isolate(signed(q.nps))}</p>
            <p className="faint">{tr("Net promoter score, from −100 to +100")}</p>
          </div>
          <div className="fm-stack-bar" aria-hidden="true">
            {parts.map(([, g, s]) => (
              <span key={g} data-group={g} style={{ width: `${num(s?.percent)}%` }} />
            ))}
          </div>
          <ul className="fm-legend">
            {parts.map(([name, g, s]) => (
              <li key={g} data-group={g}>
                <span className="fm-swatch" aria-hidden="true" />
                {isolate(name)} <strong>{s?.count ?? 0}</strong> <span className="faint">({isolate(percent(s?.percent))})</span>
              </li>
            ))}
          </ul>
          <Columns dist={q.distribution ?? []} nps />
          <Facts items={[[tr("Average"), q.average ? num(q.average) : "–"]]} />
        </>
      );
    }
    case "number":
    case "decimal":
      return <Facts items={[[tr("Average"), q.average ? num(q.average) : "–"], [tr("Smallest"), q.min ?? "–"], [tr("Largest"), q.max ?? "–"], ["Total", q.sum ?? "–"]]} />;
    case "matrix": {
      const columns = q.rows?.[0]?.columns.map((c) => c.column) ?? [];
      return (
        <div className="fm-heat-wrap">
          <table className="fm-heat">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">{tr("Statement")}</span>
                </th>
                {columns.map((c) => (
                  <th key={c} scope="col">
                    {isolate(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.rows?.map((r) => (
                <tr key={r.row}>
                  <th scope="row">
                    {isolate(r.row)}
                    <span className="faint"> {r.answered}</span>
                  </th>
                  {r.columns.map((c) => (
                    <td key={c.column} style={{ ["--p" as string]: `${Math.round(num(c.percent) * 0.7)}%` }} title={tr("{count} of {answered}", { count: c.count, answered: r.answered })}>
                      {isolate(percent(c.percent))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "ranking":
      return (
        <ol className="fm-ranking">
          {q.items?.map((it) => (
            <li key={it.item}>
              <span className="fm-rank-item">{isolate(it.item)}</span>
              <span className="faint">
                {tr("average place")} {it.average_rank ? num(it.average_rank) : "–"} {tr("· first for {first_place}", { first_place: it.first_place })}
              </span>
            </li>
          ))}
        </ol>
      );
    case "file":
      return <p>{q.files ?? 0} {(q.files === 1 ? tr("file uploaded. Open a response to see them.") : tr("files uploaded. Open a response to see them."))}</p>;
    default:
      return <Words formId={formId} q={q} />;
  }
}

export function QuestionCard({ q, formId, n }: { q: QSummary; formId: string; n: number }) {
  return (
    <article className="fm-qcard">
      <header className="fm-qcard-head">
        <h3>
          <span className="fm-num">{n}.</span> {isolate(q.label)}
        </h3>
        <p className="faint">
          {(q.skipped > 0 ? tr("{value} · {answered} answered, {skipped} skipped", { value: kindLabel(q.type), answered: q.answered, skipped: q.skipped }) : tr("{value} · {answered} answered", { value: kindLabel(q.type), answered: q.answered }))}
        </p>
      </header>
      <Body q={q} formId={formId} />
    </article>
  );
}
