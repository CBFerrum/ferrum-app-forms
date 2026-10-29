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
    let key = token::key(&mut tx, sys.tenant).await?;
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
    tx.commit().await?;
    Ok(json!({"form": form.public(), "token": token::session_token(&key, form.id, session), "prefill": prefill}))
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
    };
    let (resp, replayed) = response::submit(k, sys, &form, inc).await?;
    Ok((if replayed { 200 } else { 201 }, response::receipt(&form, resp.as_ref(), replayed, &key)))
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
