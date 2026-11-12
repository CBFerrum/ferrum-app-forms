//! The forms' HTTP endpoints. Respondents use `/api/site/{tenant}/forms/...` (the public) or
//! `/api/app/forms/...` (signed in; Internal forms only answer there). Owners read analytics,
//! text answers and CSV exports of their forms, signed in. Every respondent request acts with the
//! engine's context after validating its input and returns only what respondents may see; a
//! draft, an Internal form asked for publicly and a wrong slug all answer "not found".
//! See packages/forms/README.md.

use crate::analytics::{self, Span};
use crate::answers::{self, zone};
use crate::engine;
use crate::form::FormView;
use crate::model::Kind;
use crate::response::{self, Incoming, Respondent, Source};
use crate::token::{self, Session, SessionError};
use async_trait::async_trait;
use chrono::Utc;
use ferrum_domain::reports::read_tx;
use ferrum_kernel::{Ctx, Error, Kernel, Result, Site, SiteRequest, SiteResponse, Tx};
use serde_json::{Map, Value, json};
use uuid::Uuid;

/// Answers without files.
const MAX_JSON: usize = 256 * 1024;
/// Answers with files (base64 inflates them by a third).
const MAX_WITH_FILES: usize = 28 << 20;

pub struct FormsSite;

fn query<'a>(req: &'a SiteRequest, k: &str) -> Option<&'a str> {
    req.query.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
}

fn body(req: &SiteRequest, max: usize) -> Result<Map<String, Value>> {
    if req.body.len() > max {
        return Err(Error::invalid(format!("request body larger than {} KB", max / 1024)));
    }
    match serde_json::from_slice::<Value>(&req.body) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(Error::invalid("the request body must be a JSON object")),
    }
}

fn json_response(status: u16, v: &Value) -> SiteResponse {
    let mut r = SiteResponse::json(status, v);
    r.headers.push(("cache-control".into(), "no-store".into()));
    r
}

fn uuid(seg: &str, what: &str) -> Result<Uuid> {
    seg.parse().map_err(|_| Error::NotFound(what.into()))
}

/// A published (or closed) form by slug, as this caller may see it.
async fn by_slug(k: &Kernel, sys: &Ctx, tx: &mut Tx, slug: &str, signed_in: bool) -> Result<FormView> {
    let not_found = || Error::NotFound("form".into());
    if slug.len() > 80 {
        return Err(not_found());
    }
    let found: Option<Uuid> = sqlx::query_scalar("select id from e_form where tenant_id = $1 and slug = $2")
        .bind(sys.tenant)
        .bind(slug.to_lowercase())
        .fetch_optional(&mut **tx)
        .await?;
    let doc = k.get_tx(sys, tx, "Form", found.ok_or_else(not_found)?, false).await?;
    let view = FormView::from_doc(doc, zone(&sys.schema.timezone))?;
    if view.status == "Draft" || (view.internal && !signed_in) {
        return Err(not_found());
    }
    Ok(view)
}

/// `GET /f/{slug}`: the form to fill, a session token, prefilled answers.
async fn definition(k: &Kernel, sys: &Ctx, req: &SiteRequest, slug: &str) -> Result<Value> {
    let mut tx = k.db.tenant_tx(sys.tenant).await?;
    let form = by_slug(k, sys, &mut tx, slug, req.user.is_some()).await?;
    let now = Utc::now();
    form.accepting(now)?;
    if let Some(limit) = form.response_limit {
        let n: i64 = sqlx::query_scalar("select count(*) from e_form_response where tenant_id = $1 and form = $2 and status <> 'Spam'")
            .bind(sys.tenant)
            .bind(form.id)
            .fetch_one(&mut *tx)
            .await?;
        if n >= limit {
            return Err(Error::Conflict(form.text("closed_message").unwrap_or("This form has reached its response limit.").to_string()));
        }
    }
    let tz = zone(&sys.schema.timezone);
    let key = token::key(&mut tx, sys.tenant).await?;
    // Hidden fields from the link's query (only the form's own), then a signed link's values over them.
    let hidden_keys = form.hidden_keys();
    let mut hidden = crate::form::hidden_values(&hidden_keys, &req.query);
    let signed = query(req, "prefill").and_then(|t| token::read_prefill(&key, form.id, t, now.timestamp()));
    let mut prefill = Map::new();
    for q in form.def.questions.iter().filter(|q| q.allow_prefill) {
        let Some(raw) = query(req, &q.key) else { continue };
        let v = match q.kind {
            Kind::MultiSelect => Value::Array(raw.split(',').map(str::trim).filter(|x| !x.is_empty()).map(|x| json!(x)).collect()),
            _ => json!(raw),
        };
        if let Ok(Some((v, _))) = answers::normalize(q, &v, tz) {
            prefill.insert(q.key.clone(), v);
        }
    }
    if let Some(p) = &signed {
        for (k, v) in &p.answers {
            if let Some(q) = form.def.question(k)
                && let Ok(Some((v, _))) = answers::normalize(q, v, tz)
            {
                prefill.insert(k.clone(), v);
            }
        }
        hidden.extend(crate::form::hidden_values(&hidden_keys, &p.hidden));
    }
    let session = Session { issued: now.timestamp(), nonce: token::nonce() };
    sqlx::query(
        "insert into forms_view (tenant_id, form_id, day, views) values ($1, $2, $3, 1) \
         on conflict (tenant_id, form_id, day) do update set views = forms_view.views + 1",
    )
    .bind(sys.tenant)
    .bind(form.id)
    .bind(sys.today())
    .execute(&mut *tx)
    .await?;
    let work = if form.flag("proof_of_work") { Some(json!({"bits": settings_int(&mut tx, sys, "proof_of_work_bits", 18).await?})) } else { None };
    tx.commit().await?;
    Ok(json!({"form": form.public(), "token": token::session_token(&key, form.id, session), "prefill": prefill, "hidden": hidden,
              "prefill_token": signed.as_ref().and(query(req, "prefill")), "proof_of_work": work}))
}

/// `POST /f/{slug}/responses` `{token, answers, honeypot?}`.
async fn submit(k: &Kernel, sys: &Ctx, req: &SiteRequest, slug: &str) -> Result<(u16, Value)> {
    let (form, key) = {
        let mut tx = k.db.tenant_tx(sys.tenant).await?;
        let form = by_slug(k, sys, &mut tx, slug, req.user.is_some()).await?;
        let key = token::key(&mut tx, sys.tenant).await?;
        tx.commit().await?;
        (form, key)
    };
    let has_files = form.def.questions.iter().any(|q| q.kind == Kind::File);
    let b = body(req, if has_files { MAX_WITH_FILES } else { MAX_JSON })?;
    let raw_token = b.get("token").and_then(Value::as_str).unwrap_or_default();
    let session = match token::read_session(&key, form.id, raw_token, Utc::now().timestamp()) {
        Ok(s) => s,
        Err(SessionError::Expired) => return Err(Error::field("token", "this page was open too long: reload the form (your answers stay) and send again")),
        Err(SessionError::Invalid) => return Err(Error::field("token", "reload the form: send the token you received with it")),
    };
    let answers = match b.get("answers") {
        Some(Value::Object(m)) => m.clone(),
        None | Some(Value::Null) => Map::new(),
        Some(_) => return Err(Error::field("answers", "send the answers as an object of question key → answer")),
    };
    if answers.len() > crate::model::MAX_QUESTIONS {
        return Err(Error::field("answers", "too many answers"));
    }
    let honeypot = b.get("honeypot").is_some_and(|v| !answers_blank(v));
    // The form's hidden fields as the page sent them, a signed link's over them.
    let hidden_keys = form.hidden_keys();
    let mut hidden = match b.get("hidden") {
        Some(Value::Object(m)) => crate::form::hidden_values(&hidden_keys, m),
        _ => Map::new(),
    };
    if let Some(p) = b.get("prefill_token").and_then(Value::as_str).and_then(|t| token::read_prefill(&key, form.id, t, Utc::now().timestamp())) {
        hidden.extend(crate::form::hidden_values(&hidden_keys, &p.hidden));
    }
    if req.user.is_none() {
        guard(k, sys, &form, &key, req, &b, raw_token).await?;
    }
    let respondent = match &req.user {
        Some(u) => Respondent { user: Some(u.user), email: Some(u.email.to_lowercase()), name: Some(u.full_name.clone()).filter(|n| !n.is_empty()) },
        None => Respondent::default(),
    };
    let inc = Incoming {
        source: if req.user.is_some() { Source::SignedIn } else { Source::Public },
        answers: &answers,
        respondent,
        session: Some(session),
        honeypot,
        client_ip: Some(req.client_ip.as_str()),
        hidden,
    };
    let (resp, replayed) = response::submit(k, sys, &form, inc).await?;
    Ok((if replayed { 200 } else { 201 }, response::receipt(&form, resp.as_ref(), replayed, &key)))
}

/// A whole-number setting of Forms Settings, its default until the record is saved.
async fn settings_int(tx: &mut Tx, sys: &Ctx, field: &str, default: i64) -> Result<i64> {
    let sql = format!("select {field}::bigint from e_forms_settings where tenant_id = $1 limit 1");
    Ok(sqlx::query_scalar::<_, Option<i64>>(sqlx::AssertSqlSafe(sql)).bind(sys.tenant).fetch_optional(&mut **tx).await?.flatten().unwrap_or(default))
}

/// What a public response passes before it is read: the proof of work the form asks for, the check it names, and at
/// most Forms Settings' responses per address and hour to this form (counted in `forms_rate` by an upsert, so
/// concurrent sends from one address are all counted and none gets past the limit).
async fn guard(k: &Kernel, sys: &Ctx, form: &FormView, key: &token::Key, req: &SiteRequest, b: &Map<String, Value>, raw_token: &str) -> Result<()> {
    let mut tx = k.db.tenant_tx(sys.tenant).await?;
    if form.flag("proof_of_work") {
        let bits = settings_int(&mut tx, sys, "proof_of_work_bits", 18).await?.clamp(8, 26) as u32;
        let work = b.get("work").and_then(Value::as_str).unwrap_or_default();
        if !token::work_done(raw_token, work, bits) {
            return Err(Error::field("work", "your browser did not finish the check that keeps robots out: reload the form and send again"));
        }
    }
    if let Some(name) = form.text("extra_check") {
        let check =
            crate::guard::find(name).ok_or_else(|| Error::Unavailable(format!("this form asks for the check {name}, which this server does not have")))?;
        let p = crate::guard::Presented { tenant: sys.tenant, form: form.id, proof: b.get("check").and_then(Value::as_str), client_ip: &req.client_ip };
        if !check.verify(k, &p).await? {
            return Err(Error::field("check", "the check that keeps robots out failed: try again"));
        }
    }
    let limit = settings_int(&mut tx, sys, "responses_per_hour", 30).await?;
    if limit > 0 {
        let sent: i32 = sqlx::query_scalar(
            "insert into forms_rate (tenant_id, form_id, ip_hash, hour, sent) values ($1, $2, $3, date_trunc('hour', now()), 1) \
             on conflict (tenant_id, form_id, ip_hash, hour) do update set sent = forms_rate.sent + 1 returning sent",
        )
        .bind(sys.tenant)
        .bind(form.id)
        .bind(token::ip_hash(key, &req.client_ip))
        .fetch_one(&mut *tx)
        .await?;
        if i64::from(sent) > limit {
            tx.commit().await?;
            return Err(Error::TooManyRequests("too many responses to this form from your network: try again in an hour".into()));
        }
    }
    tx.commit().await?;
    Ok(())
}

fn answers_blank(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Bool(b) => !b,
        _ => false,
    }
}

/// `GET /results/{token}`: a quiz response's result, while its link is valid.
async fn result(k: &Kernel, sys: &Ctx, raw: &str) -> Result<Value> {
    let not_found = || Error::NotFound("result".into());
    let mut tx = k.db.tenant_tx(sys.tenant).await?;
    let key = token::key(&mut tx, sys.tenant).await?;
    let rid = token::read_result(&key, raw, Utc::now().timestamp()).ok_or_else(not_found)?;
    let resp = k.get_tx(sys, &mut tx, "FormResponse", rid, false).await.map_err(|_| not_found())?;
    let form_id = ferrum_domain::util::id(&resp, "form").ok_or_else(not_found)?;
    let form = FormView::from_doc(k.get_tx(sys, &mut tx, "Form", form_id, false).await?, zone(&sys.schema.timezone))?;
    tx.commit().await?;
    if !form.quiz {
        return Err(not_found());
    }
    Ok(json!({"form": {"title": form.title, "slug": form.slug}, "number": resp.get("number"), "result": response::result_view(&form, &resp)}))
}

/// Owner endpoints: analytics of one form for a signed-in caller who may read its responses.
async fn owner(k: &Kernel, user: &Ctx, req: &SiteRequest, form: Uuid, rest: &[&str]) -> Result<SiteResponse> {
    let span = Span::parse(query(req, "from"), query(req, "to"))?;
    let mut tx = read_tx(k, user).await?;
    let out = match rest {
        ["summary"] => json_response(200, &analytics::summary(k, user, &mut tx, form, span).await?),
        ["answers", key] => {
            let limit = match query(req, "limit") {
                None => 50,
                Some(v) => v.parse::<i64>().ok().filter(|n| (1..=200).contains(n)).ok_or_else(|| Error::field("limit", "use 1 to 200"))?,
            };
            json_response(200, &analytics::answers_page(k, user, &mut tx, form, key, limit, query(req, "cursor")).await?)
        }
        ["export.csv"] => {
            let (csv, truncated) = analytics::export_csv(k, user, &mut tx, form, span, query(req, "status")).await?;
            let mut r = SiteResponse::text(200, "text/csv; charset=utf-8", csv);
            r.headers.push(("content-disposition".into(), format!("attachment; filename=\"form-responses-{form}.csv\"")));
            r.headers.push(("cache-control".into(), "no-store".into()));
            r.headers.push(("x-content-type-options".into(), "nosniff".into()));
            if truncated {
                r.headers.push(("x-ferrum-truncated".into(), analytics::MAX_EXPORT.to_string()));
            }
            r
        }
        _ => return Err(Error::NotFound("endpoint".into())),
    };
    tx.rollback().await?;
    Ok(out)
}

#[async_trait]
impl Site for FormsSite {
    fn max_body(&self) -> usize {
        MAX_WITH_FILES
    }

    async fn handle(&self, k: &Kernel, req: SiteRequest) -> Result<SiteResponse> {
        let schema = match &req.user {
            Some(u) => u.schema.clone(),
            None => k.registry.schema(req.tenant).await?,
        };
        let sys = engine(req.tenant, schema);
        let path: Vec<&str> = req.path.split('/').filter(|p| !p.is_empty()).collect();
        match (req.method.as_str(), path.as_slice()) {
            ("GET", ["f", slug]) => Ok(json_response(200, &definition(k, &sys, &req, slug).await?)),
            ("POST", ["f", slug, "responses"]) => {
                let (status, v) = submit(k, &sys, &req, slug).await?;
                Ok(json_response(status, &v))
            }
            ("GET", ["results", token]) => Ok(json_response(200, &result(k, &sys, token).await?)),
            ("GET", ["forms", form, rest @ ..]) => match &req.user {
                Some(user) => owner(k, user, &req, uuid(form, "form")?, rest).await,
                None => Err(Error::NotFound("endpoint".into())),
            },
            _ => Err(Error::NotFound("endpoint".into())),
        }
    }
}
