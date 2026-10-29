//! The Form document. Its whole definition is checked on every save — field-level errors on the
//! question, recipient and mapping rows — and its actions publish, close and duplicate it and
//! enter responses by hand (phone surveys, paper forms, AI agents).

use crate::answers::{self, zone};
use crate::mapping;
use crate::model::{Definition, Kind, valid_key};
use crate::{mail_installed, response};
use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use chrono_tz::Tz;
use ferrum_domain::util::{b, elevated, id, rows, s};
use ferrum_kernel::{Action, Doc, DocHook, Error, FieldError, HookCtx, Result};
use regex::Regex;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::sync::LazyLock;
use uuid::Uuid;

static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$").expect("slug pattern"));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnePer {
    Email,
    User,
}

fn instant(doc: &Doc, k: &str) -> Option<DateTime<Utc>> {
    s(doc, k).and_then(|v| DateTime::parse_from_rfc3339(v).ok()).map(|d| d.with_timezone(&Utc))
}

/// A form as the response pipeline reads it.
#[derive(Debug, Clone)]
pub struct FormView {
    pub id: Uuid,
    pub doc: Doc,
    pub title: String,
    pub slug: String,
    pub status: String,
    pub owner: Option<String>,
    pub internal: bool,
    pub anonymous: bool,
    pub quiz: bool,
    pub opens_at: Option<DateTime<Utc>>,
    pub closes_at: Option<DateTime<Utc>>,
    pub response_limit: Option<i64>,
    pub one_per: Option<OnePer>,
    pub email_question: Option<String>,
    pub min_fill_seconds: i64,
    pub passing_score: Option<Decimal>,
    pub def: Definition,
    /// Problems of the stored definition (none unless the platform changed under it).
    pub def_errors: Vec<FieldError>,
}

impl FormView {
    pub fn from_doc(doc: Doc, tz: Tz) -> Result<FormView> {
        let id = id(&doc, "id").ok_or_else(|| Error::internal("form without id"))?;
        let quiz = s(&doc, "kind") == Some("Quiz");
        let (def, def_errors) = Definition::parse(&rows(&doc, "questions"), tz, quiz);
        Ok(FormView {
            id,
            title: s(&doc, "title").unwrap_or_default().to_string(),
            slug: s(&doc, "slug").unwrap_or_default().to_string(),
            status: s(&doc, "status").unwrap_or("Draft").to_string(),
            owner: s(&doc, "owner").map(str::to_lowercase),
            internal: s(&doc, "access") == Some("Internal"),
            anonymous: b(&doc, "anonymous"),
            quiz,
            opens_at: instant(&doc, "opens_at"),
            closes_at: instant(&doc, "closes_at"),
            response_limit: doc.get("response_limit").and_then(Value::as_i64),
            one_per: match s(&doc, "one_response_per") {
                Some("Email") => Some(OnePer::Email),
                Some("User") => Some(OnePer::User),
                _ => None,
            },
            email_question: s(&doc, "email_question").map(str::to_string),
            min_fill_seconds: doc.get("min_fill_seconds").and_then(Value::as_i64).unwrap_or(0).max(0),
            passing_score: s(&doc, "passing_score").and_then(|v| v.parse().ok()),
            def,
            def_errors,
            doc,
        })
    }

    pub fn text(&self, k: &str) -> Option<&str> {
        s(&self.doc, k)
    }

    pub fn flag(&self, k: &str) -> bool {
        b(&self.doc, k)
    }

    /// Whether responses are accepted now (the response limit is checked when writing).
    pub fn accepting(&self, now: DateTime<Utc>) -> Result<()> {
        let closed = || Error::Conflict(self.text("closed_message").unwrap_or("This form is not accepting responses.").to_string());
        if self.status != "Published" {
            return Err(closed());
        }
        if let Some(t) = self.opens_at
            && now < t
        {
            return Err(Error::Conflict(format!("This form opens at {}.", t.to_rfc3339_opts(SecondsFormat::Secs, true))));
        }
        if self.closes_at.is_some_and(|t| now >= t) {
            return Err(closed());
        }
        Ok(())
    }

    /// The definition respondents get: questions with their rules, never quiz points, correct
    /// answers, owners, recipients or mappings.
    pub fn public(&self) -> Value {
        json!({
            "slug": self.slug,
            "title": self.title,
            "description": self.text("description"),
            "kind": self.text("kind").unwrap_or("Form"),
            "access": if self.internal { "Internal" } else { "Public" },
            "anonymous": self.anonymous,
            "closes_at": self.closes_at.map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true)),
            "theme": {"accent_color": self.text("accent_color"), "logo": self.text("logo")},
            "questions": self.def.questions.iter().map(|q| q.public()).collect::<Vec<_>>(),
        })
    }
}

/// Whether question `key` is shown to everyone: no condition of its own or on its page.
fn always_shown(def: &Definition, key: &str) -> bool {
    let mut page_conditional = false;
    for q in &def.questions {
        if q.kind == Kind::PageBreak {
            page_conditional = q.visible_if.is_some();
        }
        if q.key == key && q.kind.answerable() {
            return q.visible_if.is_none() && !page_conditional;
        }
    }
    false
}

/// Settings that must agree with each other and with the questions.
fn settings_errors(v: &FormView) -> Vec<FieldError> {
    let mut e = Vec::new();
    let mut err = |f: &str, m: &str| e.push(FieldError::new(f, m));
    if !SLUG.is_match(&v.slug) {
        err("slug", "use lower-case letters, digits and hyphens (at most 80), starting and ending with a letter or digit");
    }
    if let (Some(a), Some(c)) = (v.opens_at, v.closes_at)
        && a >= c
    {
        err("closes_at", "must be after the opening time");
    }
    if let Some(k) = &v.email_question {
        match v.def.question(k) {
            None => err("email_question", "is not a question of this form"),
            Some(q) if q.kind != Kind::Email => err("email_question", "must be an email question"),
            Some(q) if !q.required || !always_shown(&v.def, k) => err("email_question", "the email question must be required and always shown"),
            _ => {}
        }
        if v.anonymous {
            err("email_question", "anonymous forms keep no respondent email");
        }
    }
    match v.one_per {
        Some(OnePer::Email) if v.anonymous => err("one_response_per", "anonymous forms keep no email: limit them per user (Internal forms) or not at all"),
        Some(OnePer::Email) if !v.internal && v.email_question.is_none() => err("email_question", "choose the email question that identifies respondents"),
        Some(OnePer::User) if !v.internal => err("one_response_per", "only Internal forms know who responds: limit public forms per email"),
        _ => {}
    }
    if v.flag("autoresponder") {
        if v.anonymous {
            err("autoresponder", "anonymous forms keep no address to answer");
        } else if v.email_question.is_none() {
            err("email_question", "the autoresponse goes to the answer of an email question: choose it");
        }
        if v.text("autoresponder_subject").is_none() {
            err("autoresponder_subject", "is required for the autoresponse");
        }
        if v.text("autoresponder_message").is_none() {
            err("autoresponder_message", "is required for the autoresponse");
        }
    }
    if v.status == "Published" {
        if v.def.answerable().next().is_none() {
            err("questions", "add at least one question before publishing");
        }
        if v.quiz && !v.def.questions.iter().any(|q| q.correct.is_some()) {
            err("questions", "mark the correct answer of at least one question of the quiz");
        }
    }
    e
}

/// `My Survey 2026!` → `my-survey-2026`.
fn slugify(title: &str) -> String {
    let mut out = String::new();
    for c in title.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(60).collect();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "form".into() } else { out }
}

/// `Your e-mail address` → `your_e_mail_address`, unique among `used`.
fn derive_key(label: &str, position: usize, used: &[String]) -> String {
    let mut base = String::new();
    for c in label.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            base.push(c);
        } else if !base.ends_with('_') && !base.is_empty() {
            base.push('_');
        }
    }
    let mut base: String = base.trim_matches('_').chars().take(34).collect();
    base = base.trim_end_matches('_').to_string();
    if base.is_empty() {
        base = format!("q{}", position + 1);
    } else if !base.starts_with(|c: char| c.is_ascii_lowercase()) {
        base = format!("q_{base}");
    }
    let mut key = base.clone();
    let mut n = 2;
    while used.contains(&key) {
        key = format!("{base}_{n}");
        n += 1;
    }
    key
}

async fn unique_slug(hc: &mut HookCtx<'_>, title: &str, me: Option<Uuid>) -> Result<String> {
    let base = slugify(title);
    for n in 1..=50 {
        let candidate = if n == 1 { base.clone() } else { format!("{base}-{n}") };
        let taken: bool = sqlx::query_scalar("select exists (select 1 from e_form where tenant_id = $1 and slug = $2 and id is distinct from $3)")
            .bind(hc.ctx.tenant)
            .bind(&candidate)
            .bind(me)
            .fetch_one(&mut **hc.tx)
            .await?;
        if !taken {
            return Ok(candidate);
        }
    }
    Ok(format!("{base}-{}", &Uuid::now_v7().simple().to_string()[20..]))
}

pub struct FormHook;

#[async_trait]
impl DocHook for FormHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let slug = s(doc, "slug").map(str::to_lowercase);
        let slug = match slug {
            Some(v) => v,
            None => unique_slug(hc, s(doc, "title").unwrap_or_default(), id(doc, "id")).await?,
        };
        doc.insert("slug".into(), json!(slug));
        if let Some(Value::Array(questions)) = doc.get_mut("questions") {
            let mut used: Vec<String> =
                questions.iter().filter_map(|r| r.get("key").and_then(Value::as_str)).map(str::trim).filter(|k| !k.is_empty()).map(str::to_string).collect();
            for (i, r) in questions.iter_mut().enumerate() {
                let Some(r) = r.as_object_mut() else { continue };
                let key = r.get("key").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
                let key = if key.is_empty() {
                    let k = derive_key(r.get("label").and_then(Value::as_str).unwrap_or_default(), i, &used);
                    used.push(k.clone());
                    k
                } else {
                    key
                };
                r.insert("key".into(), json!(key));
                // Lists may be written one entry per line; they are stored as lists.
                for list in ["options", "matrix_rows"] {
                    if let Some(Value::String(t)) = r.get(list) {
                        let lines: Vec<Value> = t.lines().map(str::trim).filter(|l| !l.is_empty()).map(|l| json!(l)).collect();
                        r.insert(list.into(), Value::Array(lines));
                    }
                }
            }
        }
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let view = FormView::from_doc(doc.clone(), zone(&hc.ctx.schema.timezone))?;
        let mut errors = view.def_errors.clone();
        errors.extend(settings_errors(&view));
        errors.extend(mapping::check(&hc.ctx.schema, &view.def, s(doc, "target_entity"), &mapping::rows(doc)));
        if let Some(slug) = s(doc, "slug") {
            // The unique index decides under concurrency; this names the field for the editor.
            let taken: bool = sqlx::query_scalar("select exists (select 1 from e_form where tenant_id = $1 and slug = $2 and id is distinct from $3)")
                .bind(hc.ctx.tenant)
                .bind(slug)
                .bind(id(doc, "id"))
                .fetch_one(&mut **hc.tx)
                .await?;
            if taken {
                errors.push(FieldError::new("slug", "is the address of another form"));
            }
        }
        if let Some(rest) = s(doc, "logo").and_then(|l| l.strip_prefix("/files/")) {
            let public_image = match rest.strip_prefix("public/").and_then(|x| x.parse::<Uuid>().ok()) {
                Some(file) => {
                    sqlx::query_scalar::<_, bool>(
                        "select exists (select 1 from file_object where tenant_id = $1 and id = $2 and is_public and content_type like 'image/%')",
                    )
                    .bind(hc.ctx.tenant)
                    .bind(file)
                    .fetch_one(&mut **hc.tx)
                    .await?
                }
                None => false,
            };
            if !public_image {
                errors.push(FieldError::new("logo", "use a public image: upload it with public=true and set its /files/public/<id> address"));
            }
        }
        let recipients: Vec<String> = rows(doc, "notify_users").iter().map(|r| s(r, "email").unwrap_or_default().to_lowercase()).collect();
        if !recipients.is_empty() {
            let active: Vec<String> =
                sqlx::query_scalar("select lower(email::text) from app_user where tenant_id = $1 and lower(email::text) = any($2) and is_active")
                    .bind(hc.ctx.tenant)
                    .bind(&recipients)
                    .fetch_all(&mut **hc.tx)
                    .await?;
            for (i, e) in recipients.iter().enumerate() {
                if recipients[..i].contains(e) {
                    errors.push(FieldError::new("email", "is listed twice").in_row("notify_users", i));
                } else if !active.contains(e) {
                    errors.push(FieldError::new("email", "is not an active user of this workspace").in_row("notify_users", i));
                }
            }
        }
        if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
    }

    async fn after_save(&self, hc: &mut HookCtx<'_>, doc: &Doc, old: Option<&Doc>) -> Result<()> {
        let form = id(doc, "id").ok_or_else(|| Error::internal("form without id"))?;
        let tenant = hc.ctx.tenant;
        let target = s(doc, "target_entity");
        let mapping_changed = old.is_none_or(|o| s(o, "target_entity") != target || mapping::rows(o) != mapping::rows(doc));
        if let Some(t) = target
            && mapping_changed
            && !hc.ctx.is_system
        {
            // Records are created with the engine's rights: the owner may only map to what they may create.
            if hc.ctx.require(t, Action::Create).is_err() {
                return Err(Error::field("target_entity", format!("you are not permitted to create {t} records")));
            }
            if let Some(ent) = hc.ctx.schema.entity(t).cloned() {
                for (i, r) in mapping::rows(doc).iter().enumerate() {
                    if let Some(f) = ent.field(&r.field)
                        && !hc.ctx.perms.can_write_field(t, f)
                    {
                        return Err(Error::Validation(vec![
                            FieldError::new("target_field", format!("you are not permitted to write {}", f.label())).in_row("field_map", i),
                        ]));
                    }
                }
                for (to, rec) in mapping::fixed_links(&ent, &mapping::rows(doc)) {
                    if hc.ctx.schema.entity(&to).is_none() || hc.kernel.get_tx(hc.ctx, hc.tx, &to, rec, false).await.is_err() {
                        return Err(Error::field("field_map", format!("the {to} {rec} does not exist or you cannot see it")));
                    }
                }
            }
        }
        if b(doc, "autoresponder") && !old.is_some_and(|o| b(o, "autoresponder")) && !mail_installed(hc.ctx) {
            return Err(Error::field("autoresponder", "install the Mail app to email respondents"));
        }
        let Some(old) = old else { return Ok(()) };
        if old.get("owner") != doc.get("owner")
            && let Some(owner) = s(doc, "owner")
        {
            let active: bool =
                sqlx::query_scalar("select exists (select 1 from app_user where tenant_id = $1 and lower(email::text) = lower($2) and is_active)")
                    .bind(tenant)
                    .bind(owner)
                    .fetch_one(&mut **hc.tx)
                    .await?;
            if !active {
                return Err(Error::field("owner", "is not an active user of this workspace"));
            }
        }
        if old.get("owner") != doc.get("owner") || old.get("title") != doc.get("title") {
            sqlx::query("update e_form_response set form_owner = $3, form_title = $4 where tenant_id = $1 and form = $2")
                .bind(tenant)
                .bind(form)
                .bind(s(doc, "owner").map(str::to_lowercase))
                .bind(s(doc, "title"))
                .execute(&mut **hc.tx)
                .await?;
        }
        // Answers stay valid: a question that has answers keeps its type.
        let old_types: Vec<(String, String)> = rows(old, "questions")
            .iter()
            .map(|r| (s(r, "key").unwrap_or_default().to_string(), s(r, "question_type").unwrap_or_default().to_string()))
            .collect();
        for (i, r) in rows(doc, "questions").iter().enumerate() {
            let key = s(r, "key").unwrap_or_default();
            let changed = old_types.iter().any(|(k, t)| k == key && Some(t.as_str()) != s(r, "question_type"));
            if changed && valid_key(key) {
                let answered: bool = sqlx::query_scalar("select exists (select 1 from e_form_response where tenant_id = $1 and form = $2 and answers ? $3)")
                    .bind(tenant)
                    .bind(form)
                    .bind(key)
                    .fetch_one(&mut **hc.tx)
                    .await?;
                if answered {
                    return Err(Error::Validation(vec![
                        FieldError::new("question_type", format!("'{key}' already has answers: add a new question instead of changing its type"))
                            .in_row("questions", i),
                    ]));
                }
            }
        }
        // Turning on "one response per ..." claims the respondents who already answered.
        let rule = s(doc, "one_response_per");
        if rule.is_some() && rule != s(old, "one_response_per") && !b(doc, "anonymous") {
            let (prefix, column) = if rule == Some("Email") { ("email:", "respondent_email") } else { ("user:", "respondent_user") };
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "insert into forms_claim (tenant_id, form_id, claim) \
                 select distinct $1, $2, $3 || lower({column}) from e_form_response \
                 where tenant_id = $1 and form = $2 and status <> 'Spam' and {column} is not null on conflict do nothing"
            )))
            .bind(tenant)
            .bind(form)
            .bind(prefix)
            .execute(&mut **hc.tx)
            .await?;
        }
        Ok(())
    }

    async fn before_delete(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let has_responses: bool = sqlx::query_scalar("select exists (select 1 from e_form_response where tenant_id = $1 and form = $2)")
            .bind(hc.ctx.tenant)
            .bind(id(doc, "id"))
            .fetch_one(&mut **hc.tx)
            .await?;
        if has_responses {
            return Err(Error::Conflict("this form has responses: close it instead, or delete its responses first".into()));
        }
        Ok(())
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        let form = id(doc, "id").ok_or_else(|| Error::internal("form without id"))?;
        match name {
            "publish" | "close" => {
                let mut patch = Doc::new();
                if name == "publish" {
                    patch.insert("status".into(), json!("Published"));
                    patch.insert("published_at".into(), json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)));
                } else {
                    patch.insert("status".into(), json!("Closed"));
                }
                let saved = hc.kernel.update_tx(&elevated(hc.ctx), hc.tx, "Form", form, patch, None).await?;
                Ok(Some(json!({"status": saved.get("status"), "slug": saved.get("slug")})))
            }
            "duplicate" => {
                let ent = hc.kernel.entity(hc.ctx, "Form")?;
                let mut copy = ferrum_kernel::doc::copy_for_new(&ent, &hc.ctx.schema, doc);
                // The copy belongs to whoever makes it.
                copy.remove("owner");
                let title: String = format!("{} (copy)", s(doc, "title").unwrap_or("Form")).chars().take(200).collect();
                copy.insert("title".into(), json!(title));
                let created = hc.kernel.insert_tx(hc.ctx, hc.tx, "Form", copy).await?;
                Ok(Some(json!({"entity": "Form", "id": created.get("id"), "slug": created.get("slug")})))
            }
            "record_response" => {
                let p = params.as_object().ok_or_else(|| Error::field("answers", "send {\"answers\": {question key: answer}}"))?;
                let Some(Value::Object(answers)) = p.get("answers") else {
                    return Err(Error::field("answers", "send the answers as an object of question key → answer"));
                };
                let email = match p.get("respondent_email") {
                    None | Some(Value::Null) => None,
                    Some(v) => match answers::email(v) {
                        Ok(e) => e,
                        Err(m) => return Err(Error::field("respondent_email", m)),
                    },
                };
                let name = p.get("respondent_name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).map(|n| n.chars().take(200).collect());
                let view = FormView::from_doc(doc.clone(), zone(&hc.ctx.schema.timezone))?;
                let resp = response::enter(hc.kernel, hc.ctx, hc.tx, &view, answers, email, name).await?;
                Ok(Some(json!({"entity": "FormResponse", "id": resp.get("id"), "number": resp.get("number")})))
            }
            _ => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(v: Value) -> FormView {
        let mut doc = json!({"id": Uuid::now_v7().to_string(), "title": "T", "slug": "t", "status": "Draft", "access": "Public", "kind": "Form"});
        for (k, x) in v.as_object().unwrap() {
            doc[k] = x.clone();
        }
        FormView::from_doc(doc.as_object().unwrap().clone(), chrono_tz::UTC).unwrap()
    }

    fn fields(v: &FormView) -> Vec<String> {
        settings_errors(v).into_iter().map(|e| e.field).collect()
    }

    #[test]
    fn names_are_derived() {
        assert_eq!(slugify("  Customer Survey — 2026! "), "customer-survey-2026");
        assert_eq!(slugify("???"), "form");
        assert_eq!(derive_key("Your e-mail address", 0, &[]), "your_e_mail_address");
        assert_eq!(derive_key("2026 budget", 3, &[]), "q_2026_budget");
        assert_eq!(derive_key("", 3, &[]), "q4");
        assert_eq!(derive_key("Name", 0, &["name".into(), "name_2".into()]), "name_3");
    }

    #[test]
    fn settings_must_agree() {
        let email_q = json!([{"key": "mail", "label": "Mail", "question_type": "email", "required": true}]);
        assert!(fields(&view(json!({"questions": email_q, "one_response_per": "Email", "email_question": "mail"}))).is_empty());
        assert_eq!(fields(&view(json!({"questions": email_q, "one_response_per": "Email"}))), ["email_question"]);
        assert_eq!(fields(&view(json!({"one_response_per": "User"}))), ["one_response_per"], "public forms cannot limit per user");
        assert!(fields(&view(json!({"one_response_per": "User", "access": "Internal", "anonymous": true}))).is_empty(), "anonymous participation");
        assert_eq!(fields(&view(json!({"one_response_per": "Email", "access": "Internal", "anonymous": true}))), ["one_response_per"]);
        assert_eq!(fields(&view(json!({"questions": email_q, "email_question": "mail", "anonymous": true}))), ["email_question"]);
        let hidden = json!([{"key": "x", "label": "X", "question_type": "checkbox"}, {"key": "mail", "label": "Mail", "question_type": "email", "required": true, "visible_if": "answers.x"}]);
        assert_eq!(fields(&view(json!({"questions": hidden, "email_question": "mail"}))), ["email_question"]);
        assert_eq!(fields(&view(json!({"questions": email_q, "autoresponder": true}))), ["email_question", "autoresponder_subject", "autoresponder_message"]);
        assert_eq!(fields(&view(json!({"status": "Published"}))), ["questions"]);
        assert_eq!(fields(&view(json!({"slug": "Bad Slug"}))), ["slug"]);
        assert_eq!(fields(&view(json!({"opens_at": "2026-02-01T00:00:00Z", "closes_at": "2026-01-01T00:00:00Z"}))), ["closes_at"]);
        let quiz = json!([{"key": "a", "label": "A", "question_type": "short_text"}]);
        assert_eq!(fields(&view(json!({"status": "Published", "kind": "Quiz", "questions": quiz}))), ["questions"], "a quiz needs a correct answer");
    }

    #[test]
    fn the_public_definition_hides_grading() {
        let v = view(json!({"kind": "Quiz", "passing_score": "50", "questions": [
            {"key": "a", "label": "A", "question_type": "select", "options": ["x", "y"], "correct_answer": "x", "points": 2}
        ]}));
        let text = v.public().to_string();
        assert!(!text.contains("correct") && !text.contains("points") && !text.contains("passing"), "{text}");
    }

    #[test]
    fn availability_follows_status_and_window() {
        let now = Utc::now();
        let open = view(json!({"status": "Published"}));
        assert!(open.accepting(now).is_ok());
        let soon = view(json!({"status": "Published", "opens_at": (now + chrono::Duration::hours(1)).to_rfc3339()}));
        assert!(matches!(soon.accepting(now), Err(Error::Conflict(m)) if m.starts_with("This form opens at")));
        let over = view(json!({"status": "Published", "closes_at": (now - chrono::Duration::hours(1)).to_rfc3339(), "closed_message": "See you next year"}));
        assert!(matches!(over.accepting(now), Err(Error::Conflict(m)) if m == "See you next year"));
        assert!(view(json!({"status": "Closed"})).accepting(now).is_err());
    }
}
