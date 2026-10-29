//! Responses. Every response goes through one pipeline — public link, signed-in user or manual
//! entry: answers checked against the definition, spam kept apart, duplicates and limits decided
//! under concurrency, files stored, the response written by the engine. After commit the follow-up
//! (the record created from it, notifications, the autoresponse) runs once from the outbox.

use crate::answers::{self, Submission, Upload, display, evaluate, grade, instant_value, zone};
use crate::form::{FormView, OnePer};
use crate::mapping;
use crate::token::{self, Key, Session};
use crate::{engine, engine_of, mail_installed};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use ferrum_domain::util::{elevated, id, rows, s};
use ferrum_kernel::outbox::Event;
use ferrum_kernel::value::decimal_value;
use ferrum_kernel::{Ctx, Doc, DocHook, Error, EventSink, HookCtx, Kernel, Result, Tx, notify, with_retry};
use rust_decimal::Decimal;
use serde_json::{Map, Value, json};
use uuid::Uuid;

/// Spam kept per form and day for review; beyond it bots' submissions are dropped unseen.
pub const SPAM_PER_DAY: i64 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Public,
    SignedIn,
    Manual,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Public => "Public Link",
            Source::SignedIn => "Signed In",
            Source::Manual => "Manual Entry",
        }
    }
}

/// Who responds, as far as known (kept with the response unless the form is anonymous).
#[derive(Debug, Clone, Default)]
pub struct Respondent {
    pub user: Option<Uuid>,
    pub email: Option<String>,
    pub name: Option<String>,
}

pub struct Incoming<'a> {
    pub source: Source,
    pub answers: &'a Map<String, Value>,
    pub respondent: Respondent,
    pub session: Option<Session>,
    pub honeypot: bool,
    pub client_ip: Option<&'a str>,
}

/// A checked response, ready to write.
struct Prepared {
    doc: Doc,
    uploads: Vec<Upload>,
    claim: Option<String>,
    spam: bool,
}

enum Written {
    Saved(Doc),
    Replay(Doc),
    DroppedSpam,
}

fn prepare(form: &FormView, inc: &Incoming<'_>, sub: Submission, key: &Key, now: DateTime<Utc>) -> Result<Prepared> {
    let answer_email = form.email_question.as_ref().and_then(|k| sub.answers.get(k)).and_then(Value::as_str).map(str::to_lowercase);
    let email = inc.respondent.email.clone().map(|e| e.to_lowercase()).or(answer_email);
    let spam_reason = match (inc.source, inc.session) {
        (Source::Manual, _) => None,
        _ if inc.honeypot => Some("the hidden honeypot field was filled"),
        (_, Some(sess)) if form.min_fill_seconds > 0 && now.timestamp() - sess.issued < form.min_fill_seconds => {
            Some("sent faster than a person fills the form")
        }
        _ => None,
    };
    let spam = spam_reason.is_some();
    let claim = match form.one_per {
        _ if spam => None,
        Some(OnePer::Email) => match &email {
            Some(e) => Some(format!("email:{e}")),
            None if inc.source == Source::Manual => None,
            None => return Err(Error::field(form.email_question.as_deref().unwrap_or("respondent_email"), "is required")),
        },
        Some(OnePer::User) => match inc.respondent.user {
            Some(u) => Some(format!("user:{u}")),
            None if inc.source == Source::Manual => None,
            None => return Err(Error::Unauthorized("sign in to respond to this form".into())),
        },
        None => None,
    };
    let keep = !form.anonymous;
    let g = form.quiz.then(|| grade(&form.def, &sub, form.passing_score));
    let mut doc = json!({
        "form": form.id.to_string(),
        "form_title": form.title,
        "form_owner": form.owner,
        "status": if spam { "Spam" } else { "New" },
        "source": inc.source.label(),
        "submitted_at": instant_value(now),
        "respondent_email": if keep { email } else { None },
        "respondent_name": if keep { inc.respondent.name.clone() } else { None },
        "respondent_user": if keep { inc.respondent.user.map(|u| u.to_string()) } else { None },
        "answers": Value::Object(sub.answers),
        "completion_seconds": inc.session.map(|sess| (now.timestamp() - sess.issued).max(0)),
        "ip_hash": inc.client_ip.filter(|_| keep).map(|ip| token::ip_hash(key, ip)),
        "spam_reason": spam_reason,
        "session": inc.session.map(|sess| sess.id()),
    });
    if let Some(g) = g {
        doc["score"] = decimal_value(g.score);
        doc["max_score"] = decimal_value(g.max);
        doc["quiz_result"] = json!(g.passed.map(|p| if p { "Passed" } else { "Failed" }));
        doc["quiz_detail"] = json!(
            g.items
                .iter()
                .map(|i| json!({"key": i.key, "points": decimal_value(i.points), "earned": decimal_value(i.earned), "correct": i.correct}))
                .collect::<Vec<_>>()
        );
    }
    let doc = doc.as_object().cloned().ok_or_else(|| Error::internal("response is not an object"))?;
    Ok(Prepared { doc, uploads: sub.uploads, claim, spam })
}

/// The response of a form session, if one was already written.
async fn by_session(tx: &mut Tx, tenant: Uuid, form: Uuid, session: &str) -> Result<Option<Uuid>> {
    Ok(sqlx::query_scalar("select id from e_form_response where tenant_id = $1 and form = $2 and session = $3")
        .bind(tenant)
        .bind(form)
        .bind(session)
        .fetch_optional(&mut **tx)
        .await?)
}

async fn counted(tx: &mut Tx, tenant: Uuid, form: Uuid) -> Result<i64> {
    Ok(sqlx::query_scalar("select count(*) from e_form_response where tenant_id = $1 and form = $2 and status <> 'Spam'")
        .bind(tenant)
        .bind(form)
        .fetch_one(&mut **tx)
        .await?)
}

fn limit_reached(form: &FormView) -> Error {
    Error::Conflict(form.text("closed_message").unwrap_or("This form has reached its response limit.").to_string())
}

fn already() -> Error {
    Error::Conflict("A response was already received from you for this form.".into())
}

/// Cheap checks before files are stored (decided for good when writing).
async fn precheck(k: &Kernel, tenant: Uuid, form: &FormView, p: &Prepared) -> Result<()> {
    if p.spam || (p.claim.is_none() && form.response_limit.is_none()) {
        return Ok(());
    }
    let mut tx = k.db.tenant_tx(tenant).await?;
    if let Some(claim) = &p.claim {
        let taken: bool = sqlx::query_scalar("select exists (select 1 from forms_claim where tenant_id = $1 and form_id = $2 and claim = $3)")
            .bind(tenant)
            .bind(form.id)
            .bind(claim)
            .fetch_one(&mut *tx)
            .await?;
        if taken {
            return Err(already());
        }
    }
    if let Some(limit) = form.response_limit
        && counted(&mut tx, tenant, form.id).await? >= limit
    {
        return Err(limit_reached(form));
    }
    tx.commit().await?;
    Ok(())
}

/// Stores the answers' files (before the response's transaction: storage uses connections of its
/// own) and returns them per question key.
async fn store_files(k: &Kernel, sys: &Ctx, uploads: &[Upload]) -> Result<Vec<(String, Value, Uuid)>> {
    let mut out = Vec::with_capacity(uploads.len());
    for u in uploads {
        let f = k.store_file(sys, None, &u.file_name, &u.content_type, &u.data).await?;
        let fid = f.get("id").and_then(Value::as_str).and_then(|x| x.parse().ok()).ok_or_else(|| Error::internal("stored file without id"))?;
        out.push((u.key.clone(), json!({"id": fid, "file_name": f["file_name"], "content_type": u.content_type, "size": f["size"], "url": f["url"]}), fid));
    }
    Ok(out)
}

/// Files stored for a response that was then refused: their records go (their bytes stay in
/// storage; the kernel offers apps no way to delete them).
async fn discard_files(k: &Kernel, sys: &Ctx, files: &[(String, Value, Uuid)]) {
    for (_, _, fid) in files {
        if let Err(e) = k.delete_file(sys, *fid).await {
            tracing::warn!(file = %fid, "forms: could not discard an upload: {e}");
        }
    }
}

/// Writes a checked response inside `tx`: replay, spam cap, the response limit (the form row
/// locked, so concurrent responses count one by one), the duplicate claim, the response itself
/// and its files.
async fn write(k: &Kernel, sys: &Ctx, tx: &mut Tx, form: &FormView, p: &Prepared, files: &[(String, Value, Uuid)]) -> Result<Written> {
    let tenant = sys.tenant;
    if let Some(sess) = s(&p.doc, "session")
        && let Some(existing) = by_session(tx, tenant, form.id, sess).await?
    {
        return Ok(Written::Replay(k.get_tx(sys, tx, "FormResponse", existing, false).await?));
    }
    let mut count = None;
    if p.spam {
        let recent: i64 = sqlx::query_scalar(
            "select count(*) from e_form_response where tenant_id = $1 and form = $2 and status = 'Spam' and created_at > now() - interval '1 day'",
        )
        .bind(tenant)
        .bind(form.id)
        .fetch_one(&mut **tx)
        .await?;
        if recent >= SPAM_PER_DAY {
            return Ok(Written::DroppedSpam);
        }
    } else {
        if let Some(limit) = form.response_limit {
            sqlx::query("select 1 from e_form where tenant_id = $1 and id = $2 for update").bind(tenant).bind(form.id).execute(&mut **tx).await?;
            let n = counted(tx, tenant, form.id).await?;
            if n >= limit {
                return Err(limit_reached(form));
            }
            count = Some((n, limit));
        }
        if let Some(claim) = &p.claim {
            let claimed = sqlx::query("insert into forms_claim (tenant_id, form_id, claim) values ($1, $2, $3) on conflict do nothing")
                .bind(tenant)
                .bind(form.id)
                .bind(claim)
                .execute(&mut **tx)
                .await?
                .rows_affected();
            if claimed == 0 {
                return Err(already());
            }
        }
    }
    let mut doc = p.doc.clone();
    if !files.is_empty()
        && let Some(Value::Object(answers)) = doc.get_mut("answers")
    {
        for (key, _, _) in files {
            answers.insert(key.clone(), Value::Array(files.iter().filter(|f| &f.0 == key).map(|f| f.1.clone()).collect()));
        }
    }
    let saved = k.insert_tx(sys, tx, "FormResponse", doc).await?;
    let rid = id(&saved, "id").ok_or_else(|| Error::internal("response without id"))?;
    if !files.is_empty() {
        let ids: Vec<Uuid> = files.iter().map(|f| f.2).collect();
        sqlx::query(
            "update file_object set entity = 'FormResponse', record_id = $3 where tenant_id = $1 and id = any($2) and entity is null and record_id is null",
        )
        .bind(tenant)
        .bind(&ids)
        .bind(rid)
        .execute(&mut **tx)
        .await?;
    }
    if let Some((n, limit)) = count
        && n + 1 >= limit
    {
        let mut v = Doc::new();
        v.insert("status".into(), json!("Closed"));
        k.set_values_tx(sys, tx, "Form", form.id, v).await?;
    }
    Ok(Written::Saved(saved))
}

/// A response from a form's link (public or signed in). Returns the stored response (None when
/// spam beyond the daily cap was dropped) and whether it was a replay of an earlier submit.
pub async fn submit(k: &Kernel, sys: &Ctx, form: &FormView, inc: Incoming<'_>) -> Result<(Option<Doc>, bool)> {
    if let Some(e) = form.def_errors.first() {
        return Err(Error::internal(format!("the stored definition of form {} is invalid: {} {}", form.id, e.field, e.message)));
    }
    let tenant = sys.tenant;
    let now = Utc::now();
    let key = {
        let mut tx = k.db.tenant_tx(tenant).await?;
        let key = token::key(&mut tx, tenant).await?;
        // A retried submit gets what the first one got, even if the form has closed since.
        if let Some(sess) = inc.session
            && let Some(existing) = by_session(&mut tx, tenant, form.id, &sess.id()).await?
        {
            let doc = k.get_tx(sys, &mut tx, "FormResponse", existing, false).await?;
            tx.commit().await?;
            return Ok((Some(doc), true));
        }
        tx.commit().await?;
        key
    };
    form.accepting(now)?;
    let session = inc.session;
    let sub = evaluate(&form.def, inc.answers, &answers::Env::new(zone(&sys.schema.timezone))).map_err(Error::Validation)?;
    let p = prepare(form, &inc, sub, &key, now)?;
    precheck(k, tenant, form, &p).await?;
    let files = if p.spam { vec![] } else { store_files(k, sys, &p.uploads).await? };
    let written = with_retry(|| async {
        let mut tx = k.db.tenant_tx(tenant).await?;
        let w = write(k, sys, &mut tx, form, &p, &files).await?;
        tx.commit().await?;
        Ok(w)
    })
    .await;
    match written {
        Ok(Written::Saved(doc)) => Ok((Some(doc), false)),
        Ok(Written::Replay(doc)) => {
            discard_files(k, sys, &files).await;
            Ok((Some(doc), true))
        }
        Ok(Written::DroppedSpam) => Ok((None, false)),
        Err(e) => {
            discard_files(k, sys, &files).await;
            // A concurrent submit of the same session won the race: answer like a replay.
            if matches!(e, Error::Conflict(_))
                && let Some(sess) = session
            {
                let mut tx = k.db.tenant_tx(tenant).await?;
                if let Some(existing) = by_session(&mut tx, tenant, form.id, &sess.id()).await? {
                    let doc = k.get_tx(sys, &mut tx, "FormResponse", existing, false).await?;
                    tx.commit().await?;
                    return Ok((Some(doc), true));
                }
            }
            Err(e)
        }
    }
}

/// A response entered by hand (the form's `record_response` action) inside the action's
/// transaction: the same checks except the opening hours and spam traps. The audit trail names
/// the person who entered it.
pub async fn enter(
    k: &Kernel,
    ctx: &Ctx,
    tx: &mut Tx,
    form: &FormView,
    answers: &Map<String, Value>,
    email: Option<String>,
    name: Option<String>,
) -> Result<Doc> {
    if let Some(e) = form.def_errors.first() {
        return Err(Error::internal(format!("the stored definition of form {} is invalid: {} {}", form.id, e.field, e.message)));
    }
    let mut sys = elevated(ctx);
    sys.request_id = engine_of(ctx).request_id;
    let key = token::key(tx, ctx.tenant).await?;
    let sub = evaluate(&form.def, answers, &answers::Env::new(zone(&ctx.schema.timezone))).map_err(Error::Validation)?;
    let inc = Incoming { source: Source::Manual, answers, respondent: Respondent { user: None, email, name }, session: None, honeypot: false, client_ip: None };
    let p = prepare(form, &inc, sub, &key, Utc::now())?;
    let files = store_files(k, &sys, &p.uploads).await?;
    match write(k, &sys, tx, form, &p, &files).await {
        Ok(Written::Saved(doc) | Written::Replay(doc)) => Ok(doc),
        Ok(Written::DroppedSpam) => Err(Error::internal("a manual entry is never spam")),
        Err(e) => {
            discard_files(k, &sys, &files).await;
            Err(e)
        }
    }
}

// ───────────────────────────── what respondents get back ─────────────────────────────

/// A quiz response's result: score, pass or fail, and per question whether it was right (with
/// the correct answers when the form reveals them).
pub fn result_view(form: &FormView, resp: &Doc) -> Value {
    let dec = |k: &str| s(resp, k).and_then(|v| v.parse::<Decimal>().ok());
    let (score, max) = (dec("score").unwrap_or_default(), dec("max_score").unwrap_or_default());
    let reveal = form.flag("reveal_answers");
    let questions: Vec<Value> = resp
        .get("quiz_detail")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|i| {
                    let key = i["key"].as_str().unwrap_or_default();
                    let q = form.def.question(key);
                    let mut v =
                        json!({"key": key, "label": q.map(|q| q.label.as_str()), "points": i["points"], "earned": i["earned"], "correct": i["correct"]});
                    if reveal {
                        v["correct_answer"] = q.and_then(|q| q.correct.clone()).unwrap_or(Value::Null);
                    }
                    v
                })
                .collect()
        })
        .unwrap_or_default();
    let percent = (max > Decimal::ZERO).then(|| decimal_value(crate::analytics::r2(score * Decimal::ONE_HUNDRED / max)));
    json!({
        "score": decimal_value(score),
        "max_score": decimal_value(max),
        "percent": percent,
        "passed": match s(resp, "quiz_result") { Some("Passed") => json!(true), Some("Failed") => json!(false), _ => Value::Null },
        "questions": questions,
    })
}

/// What a respondent gets after sending: the same for kept spam, so bots learn nothing.
pub fn receipt(form: &FormView, resp: Option<&Doc>, replayed: bool, key: &Key) -> Value {
    let mut out = json!({
        "status": "received",
        "message": form.text("confirmation_message").unwrap_or("Thank you! Your response was recorded."),
        "redirect_url": form.text("redirect_url"),
        "replayed": replayed,
    });
    if let Some(r) = resp {
        out["number"] = r.get("number").cloned().unwrap_or(Value::Null);
        if form.quiz
            && let Some(rid) = id(r, "id")
        {
            out["result"] = result_view(form, r);
            out["result_token"] = json!(token::result_token(key, rid, Utc::now().timestamp()));
        }
    }
    out
}

// ───────────────────────────── follow-up after commit ─────────────────────────────

/// Runs the follow-up of each new response once the response is committed.
pub struct FormsSink;

#[async_trait]
impl EventSink for FormsSink {
    async fn on_event(&self, k: &Kernel, ev: &Event) -> Result<()> {
        if ev.topic != "FormResponse.created" {
            return Ok(());
        }
        let Some(rid) = ev.record_id else { return Ok(()) };
        if ev.payload.get("doc").is_some_and(|d| d["status"] == json!("Spam")) {
            return Ok(());
        }
        let schema = k.registry.schema(ev.tenant_id).await?;
        if !schema.packages.iter().any(|p| p == crate::PACKAGE) {
            return Ok(());
        }
        let sys = engine(ev.tenant_id, schema);
        with_retry(|| async {
            let mut tx = k.db.tenant_tx(ev.tenant_id).await?;
            follow_up(k, &sys, &mut tx, rid).await?;
            tx.commit().await?;
            Ok(())
        })
        .await
    }
}

/// The follow-up of a response, idempotent: the record (once), then notifications and the
/// autoresponse (once, claimed by `notified_at` in the same transaction). Spam gets none.
pub async fn follow_up(k: &Kernel, sys: &Ctx, tx: &mut Tx, rid: Uuid) -> Result<()> {
    let row: Option<(String, Option<DateTime<Utc>>, Option<String>, Option<String>)> =
        sqlx::query_as("select status, notified_at, record_id, record_error from e_form_response where tenant_id = $1 and id = $2 for update")
            .bind(sys.tenant)
            .bind(rid)
            .fetch_optional(&mut **tx)
            .await?;
    let Some((status, notified, record, record_error)) = row else { return Ok(()) };
    if status == "Spam" {
        return Ok(());
    }
    let resp = k.get_tx(sys, tx, "FormResponse", rid, false).await?;
    let form_id = id(&resp, "form").ok_or_else(|| Error::internal("response without form"))?;
    let form = FormView::from_doc(k.get_tx(sys, tx, "Form", form_id, false).await?, zone(&sys.schema.timezone))?;
    if form.text("target_entity").is_some() && record.is_none() && record_error.is_none() {
        let outcome = create_record(k, sys, tx, &form, &resp).await?;
        record_outcome(k, sys, tx, rid, &form, outcome).await?;
    }
    if notified.is_none() {
        let mut v = Doc::new();
        v.insert("notified_at".into(), json!(instant_value(Utc::now())));
        k.set_values_tx(sys, tx, "FormResponse", rid, v).await?;
        notify_owners(k, sys, tx, &form, &resp).await?;
        autorespond(k, sys, tx, &form, &resp).await?;
    }
    Ok(())
}

async fn record_outcome(k: &Kernel, sys: &Ctx, tx: &mut Tx, rid: Uuid, form: &FormView, outcome: std::result::Result<Uuid, String>) -> Result<()> {
    let mut v = Doc::new();
    match outcome {
        Ok(rec) => {
            v.insert("record_entity".into(), json!(form.text("target_entity")));
            v.insert("record_id".into(), json!(rec.to_string()));
            v.insert("record_error".into(), Value::Null);
        }
        Err(m) => {
            v.insert("record_error".into(), json!(m.chars().take(2000).collect::<String>()));
        }
    }
    k.set_values_tx(sys, tx, "FormResponse", rid, v).await
}

fn describe(e: &Error) -> String {
    match e {
        Error::Validation(fields) => fields.iter().map(|f| format!("{}: {}", f.field, f.message)).collect::<Vec<_>>().join("; "),
        other => other.to_string(),
    }
}

/// Creates the form's record from a response with the engine's context, setting only the mapped
/// fields. A refusal (validation, a duplicate) is returned as text; transient errors propagate so
/// the whole follow-up is retried.
async fn create_record(k: &Kernel, sys: &Ctx, tx: &mut Tx, form: &FormView, resp: &Doc) -> Result<std::result::Result<Uuid, String>> {
    let target = form.text("target_entity").unwrap_or_default();
    let Some(ent) = sys.schema.entity(target).cloned() else { return Ok(Err(format!("{target} is not installed in this workspace"))) };
    let answers = resp.get("answers").and_then(Value::as_object).cloned().unwrap_or_default();
    let input = mapping::input(&form.def, &ent, &mapping::rows(&form.doc), &answers);
    sqlx::query("savepoint forms_record").execute(&mut **tx).await?;
    match k.insert_tx(sys, tx, target, input).await {
        Ok(doc) => {
            sqlx::query("release savepoint forms_record").execute(&mut **tx).await?;
            Ok(Ok(id(&doc, "id").ok_or_else(|| Error::internal("record without id"))?))
        }
        Err(e) if e.is_retryable() || matches!(e, Error::Unavailable(_)) => Err(e),
        Err(e) => {
            sqlx::query("rollback to savepoint forms_record").execute(&mut **tx).await?;
            Ok(Err(describe(&e)))
        }
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// Queues an email through the Mail app. A refusal is logged, not fatal: the response and its
/// in-app notifications stand.
async fn queue_mail(k: &Kernel, sys: &Ctx, tx: &mut Tx, to: &str, subject: &str, html: String, text: String, response: Uuid) -> Result<bool> {
    let mut c = Doc::new();
    for (key, v) in [
        ("channel", json!("Email")),
        ("direction", json!("Sent")),
        ("recipients", json!(to)),
        ("subject", json!(subject.chars().take(990).collect::<String>())),
        ("content", json!(html)),
        ("text_content", json!(text)),
        ("reference_entity", json!("FormResponse")),
        ("reference_id", json!(response.to_string())),
    ] {
        c.insert(key.into(), v);
    }
    sqlx::query("savepoint forms_mail").execute(&mut **tx).await?;
    match k.insert_tx(sys, tx, "Communication", c).await {
        Ok(_) => {
            sqlx::query("release savepoint forms_mail").execute(&mut **tx).await?;
            Ok(true)
        }
        Err(e) if e.is_retryable() => Err(e),
        Err(e) => {
            sqlx::query("rollback to savepoint forms_mail").execute(&mut **tx).await?;
            tracing::warn!(%response, "forms: mail not queued: {}", describe(&e));
            Ok(false)
        }
    }
}

/// The answers as an HTML table and as text lines (respondent input is escaped).
fn answers_table(form: &FormView, resp: &Doc) -> (String, String) {
    let answers = resp.get("answers").and_then(Value::as_object).cloned().unwrap_or_default();
    let (mut html, mut text) = (String::new(), String::new());
    for q in form.def.answerable() {
        let Some(v) = answers.get(&q.key) else { continue };
        let shown = display(q, v);
        html.push_str(&format!(
            "<tr><th align=\"left\" valign=\"top\" style=\"padding:4px 16px 4px 0\">{}</th><td style=\"padding:4px 0\">{}</td></tr>",
            esc(&q.label),
            esc(&shown).replace('\n', "<br>")
        ));
        text.push_str(&format!("{}: {}\n", q.label, shown));
    }
    (format!("<table cellpadding=\"0\" cellspacing=\"0\">{html}</table>"), text)
}

/// Tells the owner and the listed users — those who may read the response — in the app, and by
/// email when the Mail app is installed.
async fn notify_owners(k: &Kernel, sys: &Ctx, tx: &mut Tx, form: &FormView, resp: &Doc) -> Result<()> {
    if !form.flag("notify_on_response") {
        return Ok(());
    }
    let mut emails: Vec<String> = form.owner.iter().cloned().collect();
    for r in rows(&form.doc, "notify_users") {
        if let Some(e) = s(&r, "email").map(str::to_lowercase)
            && !emails.contains(&e)
        {
            emails.push(e);
        }
    }
    if emails.is_empty() {
        return Ok(());
    }
    let users: Vec<(Uuid, String)> =
        sqlx::query_as("select id, lower(email::text) from app_user where tenant_id = $1 and lower(email::text) = any($2) and is_active")
            .bind(sys.tenant)
            .bind(&emails)
            .fetch_all(&mut **tx)
            .await?;
    let rid = id(resp, "id").ok_or_else(|| Error::internal("response without id"))?;
    let number = s(resp, "number").unwrap_or_default().to_string();
    let title: String = format!("New response to {}", form.title).chars().take(200).collect();
    let from = s(resp, "respondent_email").map(|e| format!(" from {e}")).unwrap_or_default();
    let body = format!("{number}{from}");
    let mut readers = Vec::new();
    for (user, email) in users {
        let Ok(ctx) = k.load_ctx(sys.tenant, user, None, sys.request_id.clone()).await else { continue };
        if k.get_tx(&ctx, tx, "FormResponse", rid, false).await.is_err() {
            continue;
        }
        notify::send(tx, sys.tenant, user, &title, Some(&body), Some("FormResponse"), Some(rid)).await?;
        readers.push(email);
    }
    if readers.is_empty() || !mail_installed(sys) {
        return Ok(());
    }
    let (table, lines) = answers_table(form, resp);
    let subject = format!("New response to {} ({number})", form.title);
    let html = format!("<p>A new response to <b>{}</b> arrived ({}){}.</p>{table}", esc(&form.title), esc(&number), esc(&from));
    let text = format!("A new response to {} arrived ({number}){from}.\n\n{lines}", form.title);
    queue_mail(k, sys, tx, &readers.join(", "), &subject, html, text, rid).await?;
    Ok(())
}

/// Emails the respondent the form's fixed autoresponse — at most once a day per address and form,
/// so a public form cannot be used to flood a mailbox.
async fn autorespond(k: &Kernel, sys: &Ctx, tx: &mut Tx, form: &FormView, resp: &Doc) -> Result<()> {
    if !form.flag("autoresponder") || form.anonymous || !mail_installed(sys) {
        return Ok(());
    }
    let answers = resp.get("answers").and_then(Value::as_object);
    let Some(address) = form.email_question.as_ref().and_then(|q| answers?.get(q)).and_then(Value::as_str).map(str::to_string) else { return Ok(()) };
    let rid = id(resp, "id").ok_or_else(|| Error::internal("response without id"))?;
    let key = token::key(tx, sys.tenant).await?;
    sqlx::query("savepoint forms_autoresponse").execute(&mut **tx).await?;
    let fresh = sqlx::query(
        "insert into forms_autoresponse (tenant_id, form_id, address_hash) values ($1, $2, $3) \
         on conflict (tenant_id, form_id, address_hash) do update set sent_at = now() \
         where forms_autoresponse.sent_at < now() - interval '1 day'",
    )
    .bind(sys.tenant)
    .bind(form.id)
    .bind(token::address_hash(&key, form.id, &address))
    .execute(&mut **tx)
    .await?
    .rows_affected();
    let message = form.text("autoresponder_message").unwrap_or_default().to_string();
    let subject = form.text("autoresponder_subject").unwrap_or("Thank you for your response").to_string();
    let html = format!("<p>{}</p>", esc(&message).replace("\n\n", "</p><p>").replace('\n', "<br>"));
    let queued = fresh > 0 && queue_mail(k, sys, tx, &address, &subject, html, message, rid).await?;
    let end = if queued || fresh == 0 { "release savepoint forms_autoresponse" } else { "rollback to savepoint forms_autoresponse" };
    sqlx::query(end).execute(&mut **tx).await?;
    Ok(())
}

// ───────────────────────────── the FormResponse document ─────────────────────────────

/// "One response per …" claims of a response, released when it is deleted or marked as spam —
/// unless another (non-spam) response of the same respondent still holds them.
async fn release_claims(tx: &mut Tx, tenant: Uuid, doc: &Doc) -> Result<()> {
    let mut claims = Vec::new();
    if let Some(e) = s(doc, "respondent_email") {
        claims.push(format!("email:{}", e.to_lowercase()));
    }
    if let Some(u) = s(doc, "respondent_user") {
        claims.push(format!("user:{u}"));
    }
    if !claims.is_empty() {
        sqlx::query(
            "delete from forms_claim c where c.tenant_id = $1 and c.form_id = $2 and c.claim = any($3) \
             and not exists (select 1 from e_form_response r where r.tenant_id = $1 and r.form = $2 and r.id <> $4 and r.status <> 'Spam' \
             and ('email:' || lower(r.respondent_email) = c.claim or 'user:' || r.respondent_user = c.claim))",
        )
        .bind(tenant)
        .bind(id(doc, "form"))
        .bind(&claims)
        .bind(id(doc, "id"))
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn set_status(hc: &mut HookCtx<'_>, rid: Uuid, status: &str) -> Result<()> {
    let mut v = Doc::new();
    v.insert("status".into(), json!(status));
    hc.kernel.set_values_tx(hc.ctx, hc.tx, "FormResponse", rid, v).await
}

pub struct ResponseHook;

#[async_trait]
impl DocHook for ResponseHook {
    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        // Responses are written by the response pipeline only — never typed in, imported or made
        // by automations — so every one was checked against its form.
        if !doc.contains_key("created_at") && !hc.ctx.request_id.starts_with(crate::ENGINE_PREFIX) {
            return Err(Error::Forbidden("form responses are created by the form's links or its Enter a Response action".into()));
        }
        Ok(())
    }

    async fn before_delete(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        release_claims(hc.tx, hc.ctx.tenant, doc).await
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, _params: &Value) -> Result<Option<Value>> {
        let rid = id(doc, "id").ok_or_else(|| Error::internal("response without id"))?;
        let status = s(doc, "status").unwrap_or("New");
        match name {
            "mark_reviewed" => {
                if status != "New" {
                    return Err(Error::invalid("only new responses can be marked reviewed"));
                }
                set_status(hc, rid, "Reviewed").await?;
                Ok(Some(json!({"status": "Reviewed"})))
            }
            "mark_spam" => {
                set_status(hc, rid, "Spam").await?;
                release_claims(hc.tx, hc.ctx.tenant, doc).await?;
                Ok(Some(json!({"status": "Spam"})))
            }
            "not_spam" => {
                if status != "Spam" {
                    return Err(Error::invalid("this response is not marked as spam"));
                }
                set_status(hc, rid, "New").await?;
                // What spam never got: the record and the notifications.
                follow_up(hc.kernel, &engine_of(hc.ctx), hc.tx, rid).await?;
                Ok(Some(json!({"status": "New"})))
            }
            "create_record" => {
                if s(doc, "record_id").is_some() {
                    return Err(Error::invalid("a record was already created from this response"));
                }
                if status == "Spam" {
                    return Err(Error::invalid("spam creates no records: mark it as not spam first"));
                }
                let sys = engine_of(hc.ctx);
                let form_id = id(doc, "form").ok_or_else(|| Error::internal("response without form"))?;
                let form = FormView::from_doc(hc.kernel.get_tx(&sys, hc.tx, "Form", form_id, false).await?, zone(&hc.ctx.schema.timezone))?;
                let Some(target) = form.text("target_entity").map(str::to_string) else {
                    return Err(Error::invalid("the form creates no records: set its target entity and field mapping first"));
                };
                match create_record(hc.kernel, &sys, hc.tx, &form, doc).await? {
                    Ok(rec) => {
                        record_outcome(hc.kernel, &sys, hc.tx, rid, &form, Ok(rec)).await?;
                        Ok(Some(json!({"entity": target, "id": rec.to_string()})))
                    }
                    Err(m) => Err(Error::invalid(format!("the {target} could not be created: {m}"))),
                }
            }
            _ => Ok(None),
        }
    }
}
