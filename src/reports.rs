//! Reports over forms and their responses, for the reports page and AI agents (MCP). Every query
//! carries the caller's read scopes: Forms Users see their own forms' numbers.

use crate::analytics::{self, Span};
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use ferrum_domain::reports::{Params, ReportSource, col, read_tx};
use ferrum_kernel::value::decimal_value;
use ferrum_kernel::{Action, Ctx, Error, Kernel, Result, Tx, row_scope};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder};
use std::collections::HashMap;
use uuid::Uuid;

pub struct FormsReports;

fn date_param(name: &str, label: &str) -> Value {
    json!({"name": name, "label": label, "type": "date"})
}

fn form_param() -> Value {
    json!({"name": "form", "label": "Form", "type": "link", "to": "Form", "required": true})
}

fn span(p: &Params<'_>) -> Result<Option<Span>> {
    Span::parse(p.str("from_date"), p.str("to_date"))
}

fn form_of(p: &Params<'_>) -> Result<Uuid> {
    p.uuid("form")?.ok_or_else(|| Error::field("form", "is required"))
}

/// One row per form the caller can read: responses, spam, views, completion.
async fn overview(ctx: &Ctx, p: &Params<'_>, tx: &mut Tx) -> Result<Value> {
    let span = span(p)?;
    let tz = crate::answers::zone(&ctx.schema.timezone);
    let forms = ctx.schema.entity("Form").ok_or_else(|| Error::NotFound("Form".into()))?;
    let form_scope = row_scope(ctx, forms, Action::Read)?;
    // Counting responses needs reading them: without that right the counts stay empty.
    let response_scope = ctx.schema.entity("FormResponse").and_then(|e| row_scope(ctx, e, Action::Read).ok());
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("select f.id, f.title, f.kind, f.status, ");
    match &response_scope {
        Some(scope) => {
            qb.push(
                "(select json_build_object('responses', count(*) filter (where a.status <> 'Spam'), 'spam', count(*) filter (where a.status = 'Spam'), \
                 'last', max(a.submitted_at) filter (where a.status <> 'Spam'), 'seconds', avg(a.completion_seconds) filter (where a.status <> 'Spam')) \
                 from e_form_response a where a.tenant_id = f.tenant_id and a.form = f.id",
            );
            scope.push_sql(&mut qb, "a");
            if let Some(s) = span {
                let (start, end) = s.bounds(tz);
                qb.push(" and a.submitted_at >= ").push_bind(start).push(" and a.submitted_at < ").push_bind(end);
            }
            qb.push(")");
        }
        None => {
            qb.push("null::json");
        }
    }
    qb.push(", (select coalesce(sum(v.views), 0)::bigint from forms_view v where v.tenant_id = f.tenant_id and v.form_id = f.id");
    if let Some(s) = span {
        qb.push(" and v.day between ").push_bind(s.from).push(" and ").push_bind(s.to);
    }
    qb.push(") from e_form f where f.tenant_id = ").push_bind(ctx.tenant);
    form_scope.push_sql(&mut qb, "f");
    qb.push(" order by f.title, f.id limit 10000");
    let data: Vec<(Uuid, String, Option<String>, Option<String>, Option<Value>, i64)> = qb.build_query_as().fetch_all(&mut **tx).await?;
    let (mut total_responses, mut total_spam, mut total_views) = (0i64, 0i64, 0i64);
    let rows: Vec<Value> = data
        .into_iter()
        .map(|(id, title, kind, status, counts, views)| {
            let counts = counts.unwrap_or(Value::Null);
            let responses = counts["responses"].as_i64();
            let spam = counts["spam"].as_i64();
            total_responses += responses.unwrap_or(0);
            total_spam += spam.unwrap_or(0);
            total_views += views;
            let rate = match responses {
                Some(r) if views > 0 => decimal_value(analytics::r2(Decimal::from(r.min(views)) * Decimal::ONE_HUNDRED / Decimal::from(views))),
                _ => Value::Null,
            };
            let seconds = counts["seconds"].as_f64().and_then(|s| Decimal::try_from(s).ok()).map(|d| decimal_value(analytics::r2(d)));
            let last = counts["last"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc).to_rfc3339());
            json!({"form": id, "title": title, "kind": kind, "status": status, "responses": responses, "spam": spam, "views": views,
                   "completion_rate": rate, "average_seconds": seconds, "last_response_at": last})
        })
        .collect();
    Ok(json!({
        "columns": [col("title", "Form", "data"), col("kind", "Kind", "data"), col("status", "Status", "data"), col("responses", "Responses", "int"),
            col("spam", "Spam", "int"), col("views", "Views", "int"), col("completion_rate", "Completion %", "percent"),
            col("average_seconds", "Avg. Time (s)", "decimal"), col("last_response_at", "Last Response", "datetime")],
        "rows": rows,
        "totals": {"responses": total_responses, "spam": total_spam, "views": total_views},
        "meta": {"from_date": span.map(|s| s.from), "to_date": span.map(|s| s.to)},
    }))
}

fn row(question: &str, kind: &str, answer: &str, count: Value, percent: Value, value: Value, bold: bool) -> Value {
    let mut r = json!({"question": question, "type": kind, "answer": answer, "count": count, "percent": percent, "value": value});
    if bold {
        r["_bold"] = json!(true);
    }
    r
}

/// The analytics of one form as rows: each question, then its options, values or statistics.
async fn questions(k: &Kernel, ctx: &Ctx, p: &Params<'_>, tx: &mut Tx) -> Result<Value> {
    let summary = analytics::summary(k, ctx, tx, form_of(p)?, span(p)?).await?;
    let responses = summary["responses"].as_i64().unwrap_or(0);
    let mut rows = Vec::new();
    for q in summary["questions"].as_array().cloned().unwrap_or_default() {
        let label = q["label"].as_str().unwrap_or_default().to_string();
        let kind = q["type"].as_str().unwrap_or_default().to_string();
        let answered = q["answered"].as_i64().unwrap_or(0);
        let pct =
            if responses == 0 { Value::Null } else { decimal_value(analytics::r2(Decimal::from(answered) * Decimal::ONE_HUNDRED / Decimal::from(responses))) };
        rows.push(row(&label, &kind, "Answered", json!(answered), pct, Value::Null, true));
        let sub =
            |rows: &mut Vec<Value>, answer: &str, x: &Value| rows.push(row("", &kind, answer, x["count"].clone(), x["percent"].clone(), Value::Null, false));
        for o in q["options"].as_array().into_iter().flatten() {
            sub(&mut rows, o["option"].as_str().unwrap_or_default(), o);
        }
        if q.get("other").is_some() {
            sub(&mut rows, "Other", &q["other"]);
        }
        for yn in ["yes", "no"] {
            if let Some(x) = q.get(yn) {
                sub(&mut rows, if yn == "yes" { "Yes" } else { "No" }, x);
            }
        }
        for d in q["distribution"].as_array().into_iter().flatten() {
            sub(&mut rows, &d["value"].to_string(), d);
        }
        for part in ["promoters", "passives", "detractors"] {
            if let Some(x) = q.get(part) {
                let mut name = part.to_string();
                name[..1].make_ascii_uppercase();
                sub(&mut rows, &name, x);
            }
        }
        for r in q["rows"].as_array().into_iter().flatten() {
            for c in r["columns"].as_array().into_iter().flatten() {
                sub(&mut rows, &format!("{}: {}", r["row"].as_str().unwrap_or_default(), c["column"].as_str().unwrap_or_default()), c);
            }
        }
        for item in q["items"].as_array().into_iter().flatten() {
            rows.push(row(
                "",
                &kind,
                &format!("{} (average rank)", item["item"].as_str().unwrap_or_default()),
                item["first_place"].clone(),
                Value::Null,
                item["average_rank"].clone(),
                false,
            ));
        }
        for stat in ["nps", "average", "min", "max", "sum"] {
            if let Some(v) = q.get(stat).filter(|v| !v.is_null()) {
                let name = if stat == "nps" { "NPS".to_string() } else { format!("{}{}", stat[..1].to_uppercase(), &stat[1..]) };
                rows.push(row("", &kind, &name, Value::Null, Value::Null, v.clone(), false));
            }
        }
        if let Some(files) = q.get("files") {
            rows.push(row("", &kind, "Files", files.clone(), Value::Null, Value::Null, false));
        }
    }
    Ok(json!({
        "columns": [col("question", "Question", "data"), col("type", "Type", "data"), col("answer", "Answer", "data"), col("count", "Count", "int"),
            col("percent", "%", "percent"), col("value", "Value", "decimal")],
        "rows": rows,
        "totals": {"responses": responses},
        "meta": {"form": summary["form"], "views": summary["views"], "completion_rate": summary["completion_rate"],
                 "completion_time": summary["completion_time"], "quiz": summary["quiz"], "spam": summary["spam"]},
    }))
}

/// Responses per day (workspace dates; the last 30 days by default).
async fn trend(k: &Kernel, ctx: &Ctx, p: &Params<'_>, tx: &mut Tx) -> Result<Value> {
    let form = analytics::readable_form(k, ctx, tx, form_of(p)?).await?;
    let today = ferrum_domain::reports::today();
    let to = p.date("to_date")?.unwrap_or(today);
    let from = p.date("from_date")?.unwrap_or(to - Duration::days(29));
    if from > to {
        return Err(Error::field("from_date", "must not be after the to date"));
    }
    let days = analytics::trend(ctx, tx, form.id, Span { from, to }).await?;
    let total: i64 = days.iter().filter_map(|d| d["responses"].as_i64()).sum();
    Ok(json!({
        "columns": [col("date", "Date", "date"), col("responses", "Responses", "int")],
        "rows": days,
        "totals": {"responses": total},
        "meta": {"form": {"id": form.id, "title": form.title}, "from_date": from, "to_date": to},
    }))
}

#[async_trait]
impl ReportSource for FormsReports {
    fn catalog(&self) -> Vec<Value> {
        let span = || vec![date_param("from_date", "From Date"), date_param("to_date", "To Date")];
        let with_form = || [vec![form_param()], span()].concat();
        vec![
            json!({"name": "forms_overview", "label": "Forms Overview", "module": "forms", "entity": "Form", "params": span()}),
            json!({"name": "form_question_summary", "label": "Form Question Summary", "module": "forms", "entity": "FormResponse",
                   "params": with_form()}),
            json!({"name": "form_response_trend", "label": "Form Responses by Day", "module": "forms", "entity": "FormResponse",
                   "params": with_form()}),
        ]
    }

    async fn run(&self, k: &Kernel, ctx: &Ctx, name: &str, params: &HashMap<String, String>) -> Result<Value> {
        let p = Params { raw: params };
        let mut tx = read_tx(k, ctx).await?;
        let out = match name {
            "forms_overview" => overview(ctx, &p, &mut tx).await,
            "form_question_summary" => questions(k, ctx, &p, &mut tx).await,
            "form_response_trend" => trend(k, ctx, &p, &mut tx).await,
            _ => Err(Error::NotFound(format!("report {name}"))),
        };
        tx.rollback().await?;
        out
    }
}
