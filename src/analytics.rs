//! Analytics of a form's responses — per-question summaries, the daily trend, completion rate and
//! time, quiz scores, text answers page by page — and the CSV export. Spam never counts, and every
//! query carries the caller's read scope on responses: owners see their forms' numbers, nobody
//! else's. Percentages and averages are exact decimals rounded half away from zero to 2 places.

use crate::answers::{display, zone};
use crate::form::FormView;
use crate::model::{Definition, Kind, Question};
use chrono::offset::LocalResult;
use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use ferrum_kernel::query::{decode_cursor, encode_cursor};
use ferrum_kernel::value::decimal_value;
use ferrum_kernel::{Action, Ctx, Error, Kernel, Result, Tx, row_scope};
use rust_decimal::{Decimal, RoundingStrategy};
use serde_json::{Map, Value, json};
use sqlx::{Postgres, QueryBuilder};
use std::str::FromStr;
use uuid::Uuid;

const BATCH: i64 = 1000;
/// Rows in one CSV export; narrow the dates for more.
pub const MAX_EXPORT: usize = 100_000;
/// Longest daily trend.
pub const MAX_TREND_DAYS: i64 = 400;

pub fn r2(d: Decimal) -> Decimal {
    d.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
}

fn pct(part: i64, whole: i64) -> Value {
    if whole == 0 { Value::Null } else { decimal_value(r2(Decimal::from(part) * Decimal::ONE_HUNDRED / Decimal::from(whole))) }
}

fn avg(sum: Decimal, n: i64) -> Value {
    if n == 0 { Value::Null } else { decimal_value(r2(sum / Decimal::from(n))) }
}

fn number(v: &Value) -> Option<Decimal> {
    match v {
        Value::Number(n) => Decimal::from_str(&n.to_string()).ok(),
        Value::String(s) => Decimal::from_str(s).ok(),
        _ => None,
    }
}

enum Acc {
    /// select, dropdown, likert: counts per option (+ answers that are not options).
    Choice {
        counts: Vec<i64>,
        other: i64,
    },
    Multi {
        counts: Vec<i64>,
        other: i64,
    },
    Check {
        yes: i64,
        no: i64,
    },
    /// rating (from 1) and NPS (from 0): counts per value.
    Scale {
        lo: i64,
        counts: Vec<i64>,
    },
    Numbers {
        sum: Decimal,
        min: Option<Decimal>,
        max: Option<Decimal>,
    },
    /// rows × columns, and answers per row.
    Matrix {
        counts: Vec<Vec<i64>>,
        answered: Vec<i64>,
    },
    /// Sum of ranks (1 = first) and first places per option.
    Ranking {
        sums: Vec<i64>,
        firsts: Vec<i64>,
    },
    Files {
        files: i64,
    },
    Text,
}

struct Stat {
    answered: i64,
    acc: Acc,
}

/// Running totals of a form's responses; fed one response at a time.
pub struct Summary {
    stats: Vec<Stat>,
    responses: i64,
    seconds: Vec<i64>,
    score_sum: Decimal,
    percent_sum: Decimal,
    graded: i64,
    passed: i64,
    failed: i64,
}

impl Summary {
    pub fn new(def: &Definition) -> Summary {
        let stats = def
            .answerable()
            .map(|q| {
                let n = q.options.len();
                let acc = match q.kind {
                    Kind::Select | Kind::Dropdown | Kind::Likert => Acc::Choice { counts: vec![0; n], other: 0 },
                    Kind::MultiSelect => Acc::Multi { counts: vec![0; n], other: 0 },
                    Kind::Checkbox => Acc::Check { yes: 0, no: 0 },
                    Kind::Rating => Acc::Scale { lo: 1, counts: vec![0; q.scale.max(1) as usize] },
                    Kind::Nps => Acc::Scale { lo: 0, counts: vec![0; 11] },
                    Kind::Number | Kind::Decimal => Acc::Numbers { sum: Decimal::ZERO, min: None, max: None },
                    Kind::Matrix => Acc::Matrix { counts: vec![vec![0; n]; q.rows.len()], answered: vec![0; q.rows.len()] },
                    Kind::Ranking => Acc::Ranking { sums: vec![0; n], firsts: vec![0; n] },
                    Kind::File => Acc::Files { files: 0 },
                    _ => Acc::Text,
                };
                Stat { answered: 0, acc }
            })
            .collect();
        Summary { stats, responses: 0, seconds: vec![], score_sum: Decimal::ZERO, percent_sum: Decimal::ZERO, graded: 0, passed: 0, failed: 0 }
    }

    /// Adds one response. Answers that no longer fit the question (its options changed) are
    /// skipped rather than miscounted.
    pub fn add(&mut self, def: &Definition, answers: &Map<String, Value>, seconds: Option<i64>, score: Option<(Decimal, Decimal)>, result: Option<&str>) {
        self.responses += 1;
        self.seconds.extend(seconds.filter(|s| *s >= 0));
        if let Some((score, max)) = score.filter(|(_, max)| *max > Decimal::ZERO) {
            self.graded += 1;
            self.score_sum += score;
            self.percent_sum += score * Decimal::ONE_HUNDRED / max;
        }
        match result {
            Some("Passed") => self.passed += 1,
            Some("Failed") => self.failed += 1,
            _ => {}
        }
        for (q, st) in def.answerable().zip(self.stats.iter_mut()) {
            let Some(v) = answers.get(&q.key) else { continue };
            let pos = |s: &str| q.options.iter().position(|o| o == s);
            let counted = match &mut st.acc {
                Acc::Choice { counts, other } => match v.as_str() {
                    Some(s) => {
                        match pos(s) {
                            Some(i) => counts[i] += 1,
                            None => *other += 1,
                        }
                        true
                    }
                    None => false,
                },
                Acc::Multi { counts, other } => match v.as_array() {
                    Some(a) if !a.is_empty() => {
                        for s in a.iter().filter_map(Value::as_str) {
                            match pos(s) {
                                Some(i) => counts[i] += 1,
                                None => *other += 1,
                            }
                        }
                        true
                    }
                    _ => false,
                },
                Acc::Check { yes, no } => match v.as_bool() {
                    Some(true) => {
                        *yes += 1;
                        true
                    }
                    Some(false) => {
                        *no += 1;
                        true
                    }
                    None => false,
                },
                Acc::Scale { lo, counts } => match v.as_i64() {
                    Some(x) if x >= *lo && ((x - *lo) as usize) < counts.len() => {
                        counts[(x - *lo) as usize] += 1;
                        true
                    }
                    _ => false,
                },
                Acc::Numbers { sum, min, max } => match number(v) {
                    Some(d) => {
                        *sum += d;
                        *min = Some(min.map_or(d, |m| m.min(d)));
                        *max = Some(max.map_or(d, |m| m.max(d)));
                        true
                    }
                    None => false,
                },
                Acc::Matrix { counts, answered } => match v.as_object() {
                    Some(m) => {
                        let mut any = false;
                        for (ri, row) in q.rows.iter().enumerate() {
                            if let Some(ci) = m.get(row).and_then(Value::as_str).and_then(pos) {
                                counts[ri][ci] += 1;
                                answered[ri] += 1;
                                any = true;
                            }
                        }
                        any
                    }
                    None => false,
                },
                Acc::Ranking { sums, firsts } => match v.as_array() {
                    Some(a) if a.len() == q.options.len() => {
                        for (rank, item) in a.iter().enumerate() {
                            if let Some(i) = item.as_str().and_then(pos) {
                                sums[i] += rank as i64 + 1;
                                if rank == 0 {
                                    firsts[i] += 1;
                                }
                            }
                        }
                        true
                    }
                    _ => false,
                },
                Acc::Files { files } => match v.as_array() {
                    Some(a) => {
                        *files += a.len() as i64;
                        true
                    }
                    None => false,
                },
                Acc::Text => !v.is_null(),
            };
            if counted {
                st.answered += 1;
            }
        }
    }

    pub fn responses(&self) -> i64 {
        self.responses
    }

    /// Completion time: average and median seconds from opening the form to sending it.
    pub fn completion_time(&self) -> Value {
        if self.seconds.is_empty() {
            return json!({"average_seconds": null, "median_seconds": null});
        }
        let mut s = self.seconds.clone();
        s.sort_unstable();
        let n = s.len();
        let median = if n % 2 == 1 { Decimal::from(s[n / 2]) } else { Decimal::from(s[n / 2 - 1] + s[n / 2]) / Decimal::TWO };
        json!({"average_seconds": avg(Decimal::from(s.iter().sum::<i64>()), n as i64), "median_seconds": decimal_value(r2(median))})
    }

    pub fn quiz(&self) -> Value {
        json!({
            "graded": self.graded,
            "average_score": avg(self.score_sum, self.graded),
            "average_percent": avg(self.percent_sum, self.graded),
            "passed": self.passed,
            "failed": self.failed,
            "pass_rate": pct(self.passed, self.passed + self.failed),
        })
    }

    /// Per-question summaries, in question order.
    pub fn questions(&self, def: &Definition) -> Vec<Value> {
        def.answerable().zip(&self.stats).map(|(q, st)| question_json(q, st, self.responses)).collect()
    }
}

fn question_json(q: &Question, st: &Stat, responses: i64) -> Value {
    let answered = st.answered;
    let mut v = json!({"key": q.key, "label": q.label, "type": q.kind.name(), "answered": answered, "skipped": responses - answered});
    let options = |counts: &[i64], whole: i64| -> Vec<Value> {
        q.options.iter().zip(counts).map(|(o, c)| json!({"option": o, "count": c, "percent": pct(*c, whole)})).collect()
    };
    match &st.acc {
        Acc::Choice { counts, other } => {
            v["options"] = json!(options(counts, answered));
            if q.allow_other {
                v["other"] = json!({"count": other, "percent": pct(*other, answered)});
            }
            if q.kind == Kind::Likert {
                // Scale position 1..n of each label.
                let total: i64 = counts.iter().sum();
                let sum: i64 = counts.iter().enumerate().map(|(i, c)| (i as i64 + 1) * c).sum();
                v["average"] = avg(Decimal::from(sum), total);
            }
        }
        Acc::Multi { counts, other } => {
            v["options"] = json!(options(counts, answered));
            if q.allow_other {
                v["other"] = json!({"count": other, "percent": pct(*other, answered)});
            }
        }
        Acc::Check { yes, no } => {
            v["yes"] = json!({"count": yes, "percent": pct(*yes, answered)});
            v["no"] = json!({"count": no, "percent": pct(*no, answered)});
        }
        Acc::Scale { lo, counts } => {
            v["distribution"] =
                json!(counts.iter().enumerate().map(|(i, c)| json!({"value": *lo + i as i64, "count": c, "percent": pct(*c, answered)})).collect::<Vec<_>>());
            let sum: i64 = counts.iter().enumerate().map(|(i, c)| (*lo + i as i64) * c).sum();
            v["average"] = avg(Decimal::from(sum), answered);
            if q.kind == Kind::Nps {
                let promoters = counts[9] + counts[10];
                let passives = counts[7] + counts[8];
                let detractors: i64 = counts[..7].iter().sum();
                v["promoters"] = json!({"count": promoters, "percent": pct(promoters, answered)});
                v["passives"] = json!({"count": passives, "percent": pct(passives, answered)});
                v["detractors"] = json!({"count": detractors, "percent": pct(detractors, answered)});
                // NPS = % promoters − % detractors, computed on the counts (no rounding in between).
                v["nps"] = pct(promoters - detractors, answered);
            }
        }
        Acc::Numbers { sum, min, max } => {
            v["sum"] = decimal_value(*sum);
            v["min"] = min.map_or(Value::Null, decimal_value);
            v["max"] = max.map_or(Value::Null, decimal_value);
            v["average"] = avg(*sum, answered);
        }
        Acc::Matrix { counts, answered: per_row } => {
            v["rows"] = json!(
                q.rows
                    .iter()
                    .enumerate()
                    .map(|(ri, row)| json!({"row": row, "answered": per_row[ri], "columns": q.options.iter().zip(&counts[ri])
                        .map(|(c, n)| json!({"column": c, "count": n, "percent": pct(*n, per_row[ri])})).collect::<Vec<_>>()}))
                    .collect::<Vec<_>>()
            );
        }
        Acc::Ranking { sums, firsts } => {
            let mut items: Vec<(Value, Decimal)> = q
                .options
                .iter()
                .enumerate()
                .map(|(i, o)| {
                    let mean = if answered == 0 { Decimal::ZERO } else { Decimal::from(sums[i]) / Decimal::from(answered) };
                    (json!({"item": o, "average_rank": avg(Decimal::from(sums[i]), answered), "first_place": firsts[i]}), mean)
                })
                .collect();
            items.sort_by_key(|a| a.1);
            v["items"] = json!(items.into_iter().map(|(x, _)| x).collect::<Vec<_>>());
        }
        Acc::Files { files } => v["files"] = json!(files),
        Acc::Text => {}
    }
    v
}

// ───────────────────────────── reading responses ─────────────────────────────

fn first_day() -> NaiveDate {
    NaiveDate::from_ymd_opt(1900, 1, 1).unwrap_or_default()
}

fn last_day() -> NaiveDate {
    NaiveDate::from_ymd_opt(9999, 12, 31).unwrap_or_default()
}

/// Local dates, both included.
#[derive(Debug, Clone, Copy)]
pub struct Span {
    pub from: NaiveDate,
    pub to: NaiveDate,
}

impl Span {
    /// From optional `from` / `to` (YYYY-MM-DD); missing ends are open.
    pub fn parse(from: Option<&str>, to: Option<&str>) -> Result<Option<Span>> {
        let date = |field: &str, v: Option<&str>| -> Result<Option<NaiveDate>> {
            v.map(str::trim).filter(|v| !v.is_empty()).map(|v| ferrum_kernel::value::parse_date(v).map_err(|m| Error::field(field, m))).transpose()
        };
        let (f, t) = (date("from", from)?, date("to", to)?);
        if f.is_none() && t.is_none() {
            return Ok(None);
        }
        let span = Span { from: f.unwrap_or_else(first_day), to: t.unwrap_or_else(last_day) };
        if span.from > span.to {
            return Err(Error::field("from", "must not be after the to date"));
        }
        Ok(Some(span))
    }

    /// The instants it covers in `tz`: [start of `from`, start of the day after `to`).
    pub fn bounds(&self, tz: Tz) -> (DateTime<Utc>, DateTime<Utc>) {
        (local_midnight(self.from, tz), local_midnight(self.to.succ_opt().unwrap_or(self.to), tz))
    }
}

/// The first instant of a local day (a day whose midnight the clocks skip starts at the first
/// existing minute).
pub fn local_midnight(d: NaiveDate, tz: Tz) -> DateTime<Utc> {
    let mut t = d.and_hms_opt(0, 0, 0).unwrap_or_default();
    for _ in 0..4 {
        match tz.from_local_datetime(&t) {
            LocalResult::Single(x) => return x.with_timezone(&Utc),
            LocalResult::Ambiguous(a, _) => return a.with_timezone(&Utc),
            LocalResult::None => t += Duration::hours(1),
        }
    }
    t.and_utc()
}

/// `select <columns> from` the caller's readable responses of one form (alias `a`).
fn responses_of(ctx: &Ctx, columns: &str, form: Uuid) -> Result<QueryBuilder<Postgres>> {
    let ent = ctx.schema.entity("FormResponse").ok_or_else(|| Error::NotFound("FormResponse".into()))?;
    let scope = row_scope(ctx, ent, Action::Read)?;
    let mut qb = QueryBuilder::new(format!("select {columns} from e_form_response a where a.tenant_id = "));
    qb.push_bind(ctx.tenant);
    scope.push_sql(&mut qb, "a");
    qb.push(" and a.form = ").push_bind(form);
    Ok(qb)
}

fn within(qb: &mut QueryBuilder<Postgres>, span: Option<Span>, tz: Tz) {
    if let Some(s) = span {
        let (start, end) = s.bounds(tz);
        qb.push(" and a.submitted_at >= ").push_bind(start).push(" and a.submitted_at < ").push_bind(end);
    }
}

/// The form, if the caller may read it.
pub async fn readable_form(k: &Kernel, ctx: &Ctx, tx: &mut Tx, form: Uuid) -> Result<FormView> {
    let doc = k.get_tx(ctx, tx, "Form", form, false).await?;
    FormView::from_doc(doc, zone(&ctx.schema.timezone))
}

type Row = (Uuid, DateTime<Utc>, Option<Value>, Option<i64>, Option<Decimal>, Option<Decimal>, Option<String>);

/// Feeds every readable, non-spam response of the form within `span` to `summary`, in batches.
async fn summarize(ctx: &Ctx, tx: &mut Tx, form: &FormView, span: Option<Span>, summary: &mut Summary) -> Result<()> {
    let tz = zone(&ctx.schema.timezone);
    let mut after: Option<(DateTime<Utc>, Uuid)> = None;
    loop {
        let mut qb = responses_of(ctx, "a.id, a.created_at, a.answers, a.completion_seconds, a.score, a.max_score, a.quiz_result", form.id)?;
        qb.push(" and a.status <> 'Spam'");
        within(&mut qb, span, tz);
        if let Some((ts, rid)) = after {
            qb.push(" and (a.created_at, a.id) > (").push_bind(ts).push(", ").push_bind(rid).push(")");
        }
        qb.push(" order by a.created_at, a.id limit ").push_bind(BATCH);
        let rows: Vec<Row> = qb.build_query_as().fetch_all(&mut **tx).await?;
        for (_, _, answers, seconds, score, max, result) in &rows {
            let empty = Map::new();
            let answers = answers.as_ref().and_then(Value::as_object).unwrap_or(&empty);
            summary.add(&form.def, answers, *seconds, score.zip(*max), result.as_deref());
        }
        match rows.last() {
            Some(last) if rows.len() as i64 == BATCH => after = Some((last.1, last.0)),
            _ => return Ok(()),
        }
    }
}

/// Responses per local day of the span (every day listed, zeros included).
pub async fn trend(ctx: &Ctx, tx: &mut Tx, form: Uuid, span: Span) -> Result<Vec<Value>> {
    let days = (span.to - span.from).num_days() + 1;
    if days > MAX_TREND_DAYS {
        return Err(Error::field("from", format!("a trend covers at most {MAX_TREND_DAYS} days")));
    }
    let tz = zone(&ctx.schema.timezone);
    let mut qb = trend_query(ctx, form, span, tz)?;
    let rows: Vec<(NaiveDate, i64)> = qb.build_query_as().fetch_all(&mut **tx).await?;
    let mut out = Vec::with_capacity(days as usize);
    let mut day = span.from;
    while day <= span.to {
        let n = rows.iter().find(|(d, _)| *d == day).map(|(_, n)| *n).unwrap_or(0);
        out.push(json!({"date": day.to_string(), "responses": n}));
        match day.succ_opt() {
            Some(next) => day = next,
            None => break,
        }
    }
    Ok(out)
}

fn trend_query(ctx: &Ctx, form: Uuid, span: Span, tz: Tz) -> Result<QueryBuilder<Postgres>> {
    let ent = ctx.schema.entity("FormResponse").ok_or_else(|| Error::NotFound("FormResponse".into()))?;
    let scope = row_scope(ctx, ent, Action::Read)?;
    let mut qb = QueryBuilder::new("select (a.submitted_at at time zone ");
    qb.push_bind(tz.name().to_string()).push(")::date as day, count(*) from e_form_response a where a.tenant_id = ").push_bind(ctx.tenant);
    scope.push_sql(&mut qb, "a");
    qb.push(" and a.form = ").push_bind(form).push(" and a.status <> 'Spam'");
    within(&mut qb, Some(span), tz);
    qb.push(" group by 1 order by 1");
    Ok(qb)
}

async fn spam_count(ctx: &Ctx, tx: &mut Tx, form: Uuid, span: Option<Span>) -> Result<i64> {
    let mut qb = responses_of(ctx, "count(*)", form)?;
    qb.push(" and a.status = 'Spam'");
    within(&mut qb, span, zone(&ctx.schema.timezone));
    Ok(qb.build_query_scalar().fetch_one(&mut **tx).await?)
}

async fn views(tx: &mut Tx, tenant: Uuid, form: Uuid, span: Option<Span>) -> Result<i64> {
    let (from, to) = span.map_or((first_day(), last_day()), |s| (s.from, s.to));
    Ok(sqlx::query_scalar("select coalesce(sum(views), 0)::bigint from forms_view where tenant_id = $1 and form_id = $2 and day between $3 and $4")
        .bind(tenant)
        .bind(form)
        .bind(from)
        .bind(to)
        .fetch_one(&mut **tx)
        .await?)
}

/// The whole analytics of a form for `span` (all time when None); the trend covers the span, or
/// the last 30 days when it is open.
pub async fn summary(k: &Kernel, ctx: &Ctx, tx: &mut Tx, form_id: Uuid, span: Option<Span>) -> Result<Value> {
    let form = readable_form(k, ctx, tx, form_id).await?;
    let mut sum = Summary::new(&form.def);
    summarize(ctx, tx, &form, span, &mut sum).await?;
    let today = ctx.today();
    let trend_span = match span {
        None => Span { from: today - Duration::days(29), to: today },
        Some(s) => {
            let to = s.to.min(today.max(s.from));
            Span { from: s.from.max(to - Duration::days(MAX_TREND_DAYS - 1)), to }
        }
    };
    let trend = trend(ctx, tx, form.id, trend_span).await?;
    let spam = spam_count(ctx, tx, form.id, span).await?;
    let views = views(tx, ctx.tenant, form.id, span).await?;
    let responses = sum.responses();
    Ok(json!({
        "form": {"id": form.id, "title": form.title, "kind": form.text("kind"), "status": form.status, "slug": form.slug},
        "from": span.map(|s| s.from.to_string()),
        "to": span.map(|s| s.to.to_string()),
        "responses": responses,
        "spam": spam,
        "views": views,
        // Responses per view of the form page (views are counted when the definition is fetched).
        "completion_rate": if views == 0 { Value::Null } else { pct(responses.min(views), views) },
        "completion_time": sum.completion_time(),
        "quiz": if form.quiz { sum.quiz() } else { Value::Null },
        "trend": trend,
        "questions": sum.questions(&form.def),
    }))
}

/// One question's answers, newest first, a page at a time (`cursor` from the previous page).
pub async fn answers_page(k: &Kernel, ctx: &Ctx, tx: &mut Tx, form_id: Uuid, key: &str, limit: i64, cursor: Option<&str>) -> Result<Value> {
    let form = readable_form(k, ctx, tx, form_id).await?;
    let q = form.def.question(key).ok_or_else(|| Error::NotFound(format!("question {key}")))?;
    let ent = ctx.schema.entity("FormResponse").ok_or_else(|| Error::NotFound("FormResponse".into()))?;
    let scope = row_scope(ctx, ent, Action::Read)?;
    let mut qb = QueryBuilder::new("select a.id, a.number, a.submitted_at, a.answers -> ");
    qb.push_bind(key.to_string()).push(" from e_form_response a where a.tenant_id = ").push_bind(ctx.tenant);
    scope.push_sql(&mut qb, "a");
    qb.push(" and a.form = ").push_bind(form.id).push(" and a.status <> 'Spam' and a.answers ? ").push_bind(key.to_string());
    if let Some(c) = cursor {
        let (ts, rid) = decode_cursor(c)?;
        let ts = DateTime::parse_from_rfc3339(&ts).map_err(|_| Error::field("cursor", "is not a cursor from this list"))?.with_timezone(&Utc);
        qb.push(" and (a.submitted_at, a.id) < (").push_bind(ts).push(", ").push_bind(rid).push(")");
    }
    qb.push(" order by a.submitted_at desc, a.id desc limit ").push_bind(limit + 1);
    let rows: Vec<(Uuid, Option<String>, DateTime<Utc>, Option<Value>)> = qb.build_query_as().fetch_all(&mut **tx).await?;
    let more = rows.len() as i64 > limit;
    let page: Vec<&(Uuid, Option<String>, DateTime<Utc>, Option<Value>)> = rows.iter().take(limit as usize).collect();
    let next = if more { page.last().map(|r| encode_cursor(&r.2.to_rfc3339_opts(SecondsFormat::Micros, true), &r.0.to_string())) } else { None };
    let answers: Vec<Value> = page
        .iter()
        .map(|(rid, number, at, v)| {
            let v = v.clone().unwrap_or(Value::Null);
            json!({"response": rid, "number": number, "submitted_at": at.to_rfc3339_opts(SecondsFormat::Millis, true), "text": display(q, &v), "answer": v})
        })
        .collect();
    Ok(json!({"question": {"key": q.key, "label": q.label, "type": q.kind.name()}, "answers": answers, "next_cursor": next}))
}

// ───────────────────────────── CSV ─────────────────────────────

/// One CSV cell (RFC 4180). Text a spreadsheet would run as a formula (= + - @ at the start) gets
/// a leading apostrophe; numbers stay numbers.
pub fn cell(s: &str) -> String {
    let guarded = if s.starts_with(['=', '+', '-', '@', '\t', '\r']) && Decimal::from_str(s).is_err() { format!("'{s}") } else { s.to_string() };
    if guarded.contains([',', '"', '\n', '\r']) || guarded.starts_with(' ') || guarded.ends_with(' ') {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

fn line(cells: &[String]) -> String {
    let mut l = cells.iter().map(|c| cell(c)).collect::<Vec<_>>().join(",");
    l.push_str("\r\n");
    l
}

type ExportRow = (
    Uuid,
    DateTime<Utc>,
    Option<String>,
    Option<DateTime<Utc>>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<Decimal>,
    Option<Decimal>,
    Option<String>,
    Option<Value>,
);

/// A form's responses as CSV, one column per question key (matrix rows as `key[row]`). Returns
/// the text and whether it stopped at [`MAX_EXPORT`] rows.
pub async fn export_csv(k: &Kernel, ctx: &Ctx, tx: &mut Tx, form_id: Uuid, span: Option<Span>, status: Option<&str>) -> Result<(String, bool)> {
    ctx.require("FormResponse", Action::Export)?;
    let form = readable_form(k, ctx, tx, form_id).await?;
    if let Some(st) = status
        && !["New", "Reviewed", "Spam"].contains(&st)
    {
        return Err(Error::field("status", "use New, Reviewed or Spam"));
    }
    let tz = zone(&ctx.schema.timezone);
    let mut header: Vec<String> = ["number", "submitted_at", "status", "source"].map(String::from).to_vec();
    if !form.anonymous {
        header.extend(["respondent_email", "respondent_name"].map(String::from));
    }
    header.push("completion_seconds".into());
    if form.quiz {
        header.extend(["score", "max_score", "quiz_result"].map(String::from));
    }
    for q in form.def.answerable() {
        if q.kind == Kind::Matrix {
            header.extend(q.rows.iter().map(|r| format!("{}[{r}]", q.key)));
        } else {
            header.push(q.key.clone());
        }
    }
    let mut out = String::from("\u{feff}");
    out.push_str(&line(&header));
    let mut written = 0usize;
    let mut after: Option<(DateTime<Utc>, Uuid)> = None;
    loop {
        let mut qb = responses_of(
            ctx,
            "a.id, a.created_at, a.number, a.submitted_at, a.status, a.source, a.respondent_email, a.respondent_name, \
             a.completion_seconds, a.score, a.max_score, a.quiz_result, a.answers",
            form.id,
        )?;
        match status {
            Some(st) => qb.push(" and a.status = ").push_bind(st.to_string()),
            None => qb.push(" and a.status <> 'Spam'"),
        };
        within(&mut qb, span, tz);
        if let Some((ts, rid)) = after {
            qb.push(" and (a.created_at, a.id) > (").push_bind(ts).push(", ").push_bind(rid).push(")");
        }
        qb.push(" order by a.created_at, a.id limit ").push_bind(BATCH);
        let rows: Vec<ExportRow> = qb.build_query_as().fetch_all(&mut **tx).await?;
        for r in &rows {
            if written == MAX_EXPORT {
                return Ok((out, true));
            }
            let opt = |v: &Option<String>| v.clone().unwrap_or_default();
            let mut cells = vec![opt(&r.2), r.3.map(|t| t.to_rfc3339_opts(SecondsFormat::Secs, true)).unwrap_or_default(), opt(&r.4), opt(&r.5)];
            if !form.anonymous {
                cells.extend([opt(&r.6), opt(&r.7)]);
            }
            cells.push(r.8.map(|v| v.to_string()).unwrap_or_default());
            if form.quiz {
                cells.extend([
                    r.9.map(|d| d.normalize().to_string()).unwrap_or_default(),
                    r.10.map(|d| d.normalize().to_string()).unwrap_or_default(),
                    opt(&r.11),
                ]);
            }
            let empty = Map::new();
            let answers = r.12.as_ref().and_then(Value::as_object).unwrap_or(&empty);
            for q in form.def.answerable() {
                let v = answers.get(&q.key).unwrap_or(&Value::Null);
                match q.kind {
                    Kind::Matrix => cells.extend(q.rows.iter().map(|row| v.get(row).and_then(Value::as_str).unwrap_or_default().to_string())),
                    Kind::File => cells.push(
                        v.as_array()
                            .map(|files| {
                                files
                                    .iter()
                                    .map(|f| {
                                        format!("{} {}", f["file_name"].as_str().unwrap_or_default(), f["url"].as_str().unwrap_or_default()).trim().to_string()
                                    })
                                    .collect::<Vec<_>>()
                                    .join("; ")
                            })
                            .unwrap_or_default(),
                    ),
                    _ => cells.push(display(q, v)),
                }
            }
            out.push_str(&line(&cells));
            written += 1;
        }
        match rows.last() {
            Some(last) if rows.len() as i64 == BATCH => after = Some((last.1, last.0)),
            _ => return Ok((out, false)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(v: Value) -> Definition {
        let rows: Vec<Map<String, Value>> = v.as_array().unwrap().iter().map(|r| r.as_object().unwrap().clone()).collect();
        let (d, e) = Definition::parse(&rows, chrono_tz::UTC, false);
        assert!(e.is_empty(), "{e:?}");
        d
    }

    #[test]
    fn nps_and_distributions_are_exact() {
        let d = def(json!([
            {"key": "nps", "label": "Recommend?", "question_type": "nps"},
            {"key": "stars", "label": "Stars", "question_type": "rating"},
            {"key": "agree", "label": "Agree", "question_type": "likert"},
            {"key": "grid", "label": "Grid", "question_type": "matrix", "options": ["Bad", "Ok", "Good"], "matrix_rows": ["Speed", "Price"]},
            {"key": "pick", "label": "Pick", "question_type": "multi_select", "options": ["A", "B", "C"]},
            {"key": "rank", "label": "Rank", "question_type": "ranking", "options": ["X", "Y", "Z"]},
            {"key": "amount", "label": "Amount", "question_type": "decimal"},
            {"key": "ok", "label": "Ok", "question_type": "checkbox"}
        ]));
        let mut s = Summary::new(&d);
        let answers = [
            json!({"nps": 10, "stars": 5, "agree": "Agree", "grid": {"Speed": "Good", "Price": "Bad"}, "pick": ["A", "B"], "rank": ["X", "Y", "Z"], "amount": "10.5", "ok": true}),
            json!({"nps": 9, "stars": 4, "agree": "Strongly agree", "grid": {"Speed": "Good"}, "pick": ["A"], "rank": ["Y", "X", "Z"], "amount": "2", "ok": false}),
            json!({"nps": 9, "stars": 4, "agree": "Agree", "grid": {"Speed": "Ok", "Price": "Good"}, "pick": ["C"], "rank": ["X", "Z", "Y"]}),
            json!({"nps": 8, "stars": 3, "agree": "Disagree"}),
            json!({"nps": 7}),
            json!({"nps": 3, "stars": 1}),
        ];
        for (i, a) in answers.iter().enumerate() {
            s.add(&d, a.as_object().unwrap(), Some(30 + i as i64 * 10), None, None);
        }
        let qs = s.questions(&d);
        // 3 promoters, 2 passives, 1 detractor of 6: (3 - 1) / 6 = 33.333…% → 33.33
        assert_eq!(qs[0]["nps"], json!("33.33"));
        assert_eq!(
            (qs[0]["promoters"]["count"].clone(), qs[0]["passives"]["count"].clone(), qs[0]["detractors"]["count"].clone()),
            (json!(3), json!(2), json!(1))
        );
        assert_eq!(qs[0]["promoters"]["percent"], json!("50"));
        assert_eq!(qs[0]["average"], json!("7.67"), "(10+9+9+8+7+3)/6 = 7.666…");
        assert_eq!(qs[1]["answered"], json!(5));
        assert_eq!(qs[1]["skipped"], json!(1));
        assert_eq!(qs[1]["average"], json!("3.4"), "(5+4+4+3+1)/5");
        assert_eq!(qs[1]["distribution"][3], json!({"value": 4, "count": 2, "percent": "40"}));
        assert_eq!(qs[2]["options"][3], json!({"option": "Agree", "count": 2, "percent": "50"}));
        assert_eq!(qs[2]["average"], json!("3.75"), "(4+5+4+2)/4 on the 1-5 scale");
        assert_eq!(qs[3]["rows"][0]["answered"], json!(3));
        assert_eq!(qs[3]["rows"][0]["columns"][2], json!({"column": "Good", "count": 2, "percent": "66.67"}));
        assert_eq!(qs[3]["rows"][1]["columns"][0], json!({"column": "Bad", "count": 1, "percent": "50"}));
        assert_eq!(qs[4]["options"][0], json!({"option": "A", "count": 2, "percent": "66.67"}), "of the 3 who answered");
        assert_eq!(qs[5]["items"][0], json!({"item": "X", "average_rank": "1.33", "first_place": 2}));
        assert_eq!(qs[5]["items"][2]["item"], json!("Z"));
        assert_eq!((qs[6]["sum"].clone(), qs[6]["average"].clone(), qs[6]["min"].clone()), (json!("12.5"), json!("6.25"), json!("2")));
        assert_eq!((qs[7]["yes"]["count"].clone(), qs[7]["no"]["percent"].clone()), (json!(1), json!("50")));
        assert_eq!(s.completion_time(), json!({"average_seconds": "55", "median_seconds": "55"}));
    }

    #[test]
    fn rounding_is_half_away_from_zero() {
        assert_eq!(pct(1, 8), json!("12.5"));
        assert_eq!(pct(1, 3), json!("33.33"));
        assert_eq!(pct(2, 3), json!("66.67"));
        assert_eq!(pct(-1, 6), json!("-16.67"));
        assert_eq!(r2(Decimal::from_str("0.125").unwrap()), Decimal::from_str("0.13").unwrap());
        assert_eq!(pct(1, 0), Value::Null);
    }

    #[test]
    fn csv_cells_are_quoted_and_defused() {
        assert_eq!(cell("plain"), "plain");
        assert_eq!(cell("a,b"), "\"a,b\"");
        assert_eq!(cell("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(cell("line\nbreak"), "\"line\nbreak\"");
        assert_eq!(cell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
        assert_eq!(cell("@SUM(A1)"), "'@SUM(A1)");
        assert_eq!(cell("-5"), "-5", "numbers stay numbers");
        assert_eq!(cell("-1+2"), "'-1+2");
    }

    #[test]
    fn spans_cover_local_days() {
        let ny: Tz = "America/New_York".parse().unwrap();
        let d = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let span = Span { from: d("2026-03-08"), to: d("2026-03-08") };
        let (start, end) = span.bounds(ny);
        assert_eq!(start.to_rfc3339(), "2026-03-08T05:00:00+00:00", "midnight EST");
        assert_eq!(end.to_rfc3339(), "2026-03-09T04:00:00+00:00", "next midnight is EDT: a 23-hour day");
        assert!(Span::parse(Some("2026-02-01"), Some("2026-01-01")).is_err());
        assert!(Span::parse(None, None).unwrap().is_none());
    }
}
