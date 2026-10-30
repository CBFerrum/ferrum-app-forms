//! Forms and Surveys end to end against a real PostgreSQL (`FERRUM_FORMS_TEST_DATABASE_URL`,
//! default `postgres://ferrum:ferrum@localhost:5432/ferrum_forms_test`; the database is reset
//! first), with the Mail app installed and the workspace in New York (DST is tested).
//!
//! Respondents use the package's `Site` exactly as browsers would — public and signed in. Owners
//! use the generic API, document actions, reports and the analytics endpoints. Every important
//! number, status and refusal is asserted: each question type's checks, conditional logic, the
//! records created from responses, quiz scores, closed forms, limits and duplicates under
//! concurrency, exact NPS and distributions, spam, anonymity, notifications and permissions.

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ferrum_kernel::outbox::Event;
use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Ctx, Db, DbConfig, Doc, Error, HookRegistry, Kernel, KernelSettings, ListQuery, Site, SiteRequest, SiteResponse};
use ferrum_meta::Catalog;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

fn obj(v: Value) -> Doc {
    v.as_object().cloned().unwrap()
}

fn uid(doc: &Doc) -> Uuid {
    doc["id"].as_str().unwrap().parse().unwrap()
}

fn b64(data: &[u8]) -> String {
    STANDARD.encode(data)
}

/// Field errors as `field` or `table[row].field`.
fn fields(e: &Error) -> Vec<String> {
    match e {
        Error::Validation(list) => list.iter().map(|f| f.row.as_ref().map_or(f.field.clone(), |(t, i)| format!("{t}[{i}].{}", f.field))).collect(),
        other => panic!("expected a validation error, got {other:?}"),
    }
}

/// The server's mailer: what the Mail app hands over when no account is set up.
#[derive(Default)]
struct TestMailer(Mutex<Vec<(String, String, String)>>);

#[async_trait]
impl ferrum_kernel::Mailer for TestMailer {
    async fn send(&self, to: &str, subject: &str, html: &str) -> ferrum_kernel::Result<()> {
        self.0.lock().unwrap().push((to.to_string(), subject.to_string(), html.to_string()));
        Ok(())
    }
}

/// The platform's object storage, in memory.
#[derive(Default)]
struct MemStore(Mutex<HashMap<String, Vec<u8>>>);

#[async_trait]
impl ferrum_kernel::files::FileStore for MemStore {
    async fn put(&self, key: &str, data: &[u8]) -> ferrum_kernel::Result<()> {
        self.0.lock().unwrap().insert(key.to_string(), data.to_vec());
        Ok(())
    }
    async fn get(&self, key: &str) -> ferrum_kernel::Result<Vec<u8>> {
        self.0.lock().unwrap().get(key).cloned().ok_or_else(|| Error::NotFound("object".into()))
    }
    async fn delete(&self, key: &str) -> ferrum_kernel::Result<()> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

#[derive(Clone)]
struct T {
    k: Arc<Kernel>,
    site: Arc<dyn Site>,
    tenant: Uuid,
    admin: Ctx,
    owner: Ctx,
    other: Ctx,
    manager: Ctx,
    staff: Ctx,
    staff2: Ctx,
    mail: Arc<TestMailer>,
}

type Res = ferrum_kernel::Result<(u16, Value)>;

impl T {
    async fn raw(&self, user: Option<&Ctx>, method: &str, path: &str, body: Option<Value>) -> ferrum_kernel::Result<SiteResponse> {
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        let query: Map<String, Value> = query.split('&').filter_map(|p| p.split_once('=')).map(|(k, v)| (k.to_string(), json!(v))).collect();
        let req = SiteRequest {
            tenant: self.tenant,
            user: user.cloned(),
            method: method.into(),
            path: path.into(),
            query,
            headers: Map::new(),
            body: body.map(|b| b.to_string().into_bytes()).unwrap_or_default(),
            client_ip: "203.0.113.7".into(),
        };
        self.site.handle(&self.k, req).await
    }
    async fn call(&self, user: Option<&Ctx>, method: &str, path: &str, body: Option<Value>) -> Res {
        let r = self.raw(user, method, path, body).await?;
        assert_eq!(r.content_type, "application/json");
        assert!(r.headers.iter().any(|(k, v)| k == "cache-control" && v == "no-store"));
        Ok((r.status, serde_json::from_slice(&r.body).expect("json body")))
    }
    /// Opens a form like a browser: its definition and session token.
    async fn open(&self, user: Option<&Ctx>, slug: &str) -> (Value, String) {
        let (status, v) = self.call(user, "GET", &format!("/f/{slug}"), None).await.unwrap_or_else(|e| panic!("open {slug}: {e:?}"));
        assert_eq!(status, 200);
        let token = v["token"].as_str().unwrap().to_string();
        (v, token)
    }
    async fn send(&self, user: Option<&Ctx>, slug: &str, token: &str, answers: Value) -> Res {
        self.call(user, "POST", &format!("/f/{slug}/responses"), Some(json!({"token": token, "answers": answers}))).await
    }
    /// Opens and sends; the response must be accepted.
    async fn respond(&self, user: Option<&Ctx>, slug: &str, answers: Value) -> Value {
        let (_, token) = self.open(user, slug).await;
        let (status, v) = self.send(user, slug, &token, answers).await.unwrap_or_else(|e| panic!("respond to {slug}: {e:?}"));
        assert_eq!(status, 201, "{v}");
        v
    }
    async fn insert(&self, ctx: &Ctx, entity: &str, v: Value) -> Doc {
        self.k.insert(ctx, entity, obj(v)).await.unwrap_or_else(|e| panic!("insert {entity}: {e:?}"))
    }
    async fn get(&self, entity: &str, id: Uuid) -> Doc {
        self.k.get(&self.admin, entity, id, false).await.unwrap_or_else(|e| panic!("get {entity}: {e:?}"))
    }
    async fn action(&self, ctx: &Ctx, entity: &str, id: Uuid, name: &str, params: Value) -> Value {
        self.k.run_action(ctx, entity, id, name, params).await.unwrap_or_else(|e| panic!("{entity}.{name}: {e:?}"))
    }
    /// A form created by `ctx` and published.
    async fn published(&self, ctx: &Ctx, v: Value) -> Doc {
        let f = self.insert(ctx, "Form", v).await;
        let out = self.action(ctx, "Form", uid(&f), "publish", json!({})).await;
        assert_eq!(out["status"], json!("Published"));
        self.get("Form", uid(&f)).await
    }
    /// The response a receipt names.
    async fn response(&self, receipt: &Value) -> Doc {
        self.find_one("FormResponse", json!({"number": receipt["number"]})).await
    }
    async fn find_one(&self, entity: &str, filters: Value) -> Doc {
        let page = self.list(&self.admin, entity, filters.clone()).await;
        assert_eq!(page.len(), 1, "{entity} {filters}");
        // Lists carry no child tables: read the record itself.
        self.get(entity, uid(&page[0])).await
    }
    async fn list(&self, ctx: &Ctx, entity: &str, filters: Value) -> Vec<Doc> {
        let q = ListQuery { filters: ferrum_kernel::query::parse_filters(&filters).unwrap(), limit: Some(500), ..Default::default() };
        self.k.list(ctx, entity, &q).await.unwrap_or_else(|e| panic!("list {entity}: {e:?}")).rows
    }
    async fn count(&self, sql: &str, id: Uuid) -> i64 {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string())).bind(self.tenant).bind(id).fetch_one(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        n
    }
    async fn text(&self, sql: &str, id: Uuid) -> String {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        let s: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string())).bind(self.tenant).bind(id).fetch_one(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        s.unwrap_or_default()
    }
    async fn exec(&self, sql: &str, id: Uuid) {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).bind(self.tenant).bind(id).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
    }
    /// Runs the outbox until it is empty (follow-ups, then the Mail app's deliveries).
    async fn drain(&self) {
        for _ in 0..50 {
            if self.k.dispatch_outbox_once().await.expect("outbox") == 0 {
                return;
            }
        }
        panic!("the outbox does not drain");
    }
    async fn notifications(&self, user: &Ctx, record: Uuid) -> i64 {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        let n: i64 = sqlx::query_scalar("select count(*) from notification where tenant_id = $1 and user_id = $2 and record_id = $3")
            .bind(self.tenant)
            .bind(user.user)
            .bind(record)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        n
    }
    async fn report(&self, ctx: &Ctx, name: &str, params: &[(&str, String)]) -> Value {
        let p: HashMap<String, String> = params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        ferrum_domain::reports::run(&self.k, ctx, name, &p).await.unwrap_or_else(|e| panic!("report {name}: {e:?}"))
    }
}

async fn user(k: &Kernel, admin: &Ctx, tenant: Uuid, email: &str, name: &str, roles: &[&str]) -> Ctx {
    let roles: Vec<String> = roles.iter().map(|r| r.to_string()).collect();
    let id = k.create_user(admin, email, name, Some("Correct-Horse-9"), &roles, false).await.expect("user");
    k.load_ctx(tenant, id, None, "it".into()).await.expect("ctx")
}

async fn setup() -> T {
    let url = std::env::var("FERRUM_FORMS_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_forms_test".into());
    let db = Db::connect(DbConfig { url, max_connections: 20, ..Default::default() }).await.expect("connect");
    sqlx::raw_sql("drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_forms::packages().expect("app packages"));
    packages.extend(ferrum_app_comms::packages().expect("mail packages"));
    let catalog = Catalog::from_packages(packages).expect("catalog");
    let mut hooks = HookRegistry::default();
    ferrum_domain::register(&mut hooks);
    ferrum_app_forms::register(&mut hooks);
    ferrum_app_comms::register(&mut hooks);
    for source in ferrum_app_forms::reports() {
        ferrum_domain::reports::add_source(source);
    }
    let mail = Arc::new(TestMailer::default());
    let settings = KernelSettings { secret_key: Some(ferrum_kernel::secret::SecretKey::new([7u8; 32])), ..Default::default() };
    let k = Kernel::boot(db, catalog, hooks, settings, Some(mail.clone())).await.expect("boot");
    k.set_file_store(Arc::new(MemStore::default()));
    ferrum_domain::maintenance(&k).await.expect("partitions");
    let tenant = k
        .create_tenant(NewTenant {
            slug: "acme".into(),
            name: "Acme".into(),
            admin_email: "admin@acme.test".into(),
            admin_password: "Correct-Horse-9".into(),
            admin_name: None,
            // Selling: forms here make customers (the platform's parties) and touch their credit limit
            // (selling's), and the owner is a Sales User.
            packages: vec!["forms".into(), "comms".into(), "selling".into()],
            settings: Some(json!({"timezone": "America/New_York"})),
        })
        .await
        .expect("tenant");
    let session = k.login("acme", "admin@acme.test", "Correct-Horse-9").await.expect("login");
    let admin = k.load_ctx(tenant, session.user, Some(session.token_version), "it".into()).await.expect("ctx");
    let owner = user(&k, &admin, tenant, "owner@acme.test", "Olivia Owner", &["Forms User", "Sales User"]).await;
    let other = user(&k, &admin, tenant, "other@acme.test", "Oscar Other", &["Forms User"]).await;
    let manager = user(&k, &admin, tenant, "manager@acme.test", "Maya Manager", &["Forms Manager"]).await;
    let staff = user(&k, &admin, tenant, "staff@acme.test", "Staff Member", &[]).await;
    let staff2 = user(&k, &admin, tenant, "staff2@acme.test", "Second Staff", &[]).await;
    let site = k.hooks.site("forms").expect("the forms site").clone();
    T { k, site, tenant, admin, owner, other, manager, staff, staff2, mail }
}

#[test]
fn forms_end_to_end() {
    // Same runtime shape as the server: unoptimized async hook chains need more than 2 MiB.
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

async fn scenario() {
    let t = setup().await;
    definitions_are_checked(&t).await;
    let every = every_question_type(&t).await;
    conditional_logic(&t).await;
    records_from_responses(&t).await;
    quizzes(&t).await;
    limits_and_duplicates(&t).await;
    anonymity(&t).await;
    spam(&t).await;
    notifications_and_mail(&t).await;
    analytics_and_exports(&t).await;
    permissions(&t, &every).await;
    manual_entry_and_edits(&t, &every).await;
    maintenance(&t).await;
}

// ───────────────────────────── definitions ─────────────────────────────

async fn definitions_are_checked(t: &T) {
    let o = &t.owner;
    let e =
        t.k.insert(
            o,
            "Form",
            obj(json!({"title": "Broken", "one_response_per": "User", "email_question": "mail", "questions": [
                {"key": "pick", "label": "Pick", "question_type": "select"},
                {"key": "pick", "label": "Again", "question_type": "short_text", "pattern": "(x"},
                {"label": "Cond", "question_type": "number", "visible_if": "answers.later > 1"},
                {"key": "later", "label": "Later", "question_type": "rating", "max_value": "12"},
                {"key": "mail", "label": "Mail", "question_type": "email"}
            ]})),
        )
        .await
        .unwrap_err();
    let f = fields(&e);
    for want in [
        "questions[0].options",
        "questions[1].key",
        "questions[1].pattern",
        "questions[2].visible_if",
        "questions[3].max_value",
        "one_response_per",
        "email_question",
    ] {
        assert!(f.contains(&want.to_string()), "{want} missing from {f:?}");
    }
    let bad = |v: Value| {
        let k = t.k.clone();
        let o = o.clone();
        async move { fields(&k.insert(&o, "Form", obj(v)).await.unwrap_err()) }
    };
    assert_eq!(bad(json!({"title": "R", "redirect_url": "javascript:alert(1)"})).await, ["redirect_url"], "redirects are http(s) only");
    assert_eq!(bad(json!({"title": "L", "logo": format!("/files/{}", Uuid::now_v7())})).await, ["logo"], "a logo must be a public image");
    assert_eq!(bad(json!({"title": "N", "notify_users": [{"email": "nobody@acme.test"}]})).await, ["notify_users[0].email"]);
    assert_eq!(bad(json!({"title": "T", "target_entity": "Nope"})).await, ["target_entity"]);
    assert_eq!(bad(json!({"title": "T", "target_entity": "FormResponse"})).await, ["target_entity"], "a form cannot create responses");
    let f = bad(json!({"title": "Map", "target_entity": "Customer",
        "questions": [{"key": "name", "label": "Name", "question_type": "short_text"}, {"key": "size", "label": "Size", "question_type": "dropdown", "options": ["Small", "Large"]}],
        "field_map": [
            {"target_field": "nonexistent", "question": "name"},
            {"target_field": "email", "question": "name"},
            {"target_field": "customer_type", "question": "size"},
            {"target_field": "payment_terms_days", "value": "soon"},
            {"target_field": "tax_id"}
        ]}))
    .await;
    assert_eq!(
        f,
        ["field_map[0].target_field", "field_map[1].question", "field_map[2].question", "field_map[3].value", "field_map[4].question", "field_map"],
        "unknown field, a text answer for an email, options the select lacks, a bad fixed value, nothing mapped, the required name unmapped"
    );
    // Records are created with the engine's rights: owners may only map to what they may write.
    let leads = json!({"title": "Leads", "target_entity": "Customer", "questions": [{"key": "name", "label": "Name", "question_type": "short_text", "required": true}],
        "field_map": [{"target_field": "customer_name", "question": "name"}]});
    let e = t.k.insert(&t.other, "Form", obj(leads.clone())).await.unwrap_err();
    assert!(matches!(&e, Error::Validation(v) if v[0].field == "target_entity" && v[0].message.contains("not permitted")), "{e:?}");
    let mut credit = leads.clone();
    credit["questions"].as_array_mut().unwrap().push(json!({"key": "limit", "label": "Limit", "question_type": "decimal"}));
    credit["field_map"].as_array_mut().unwrap().push(json!({"target_field": "credit_limit", "question": "limit"}));
    let e = t.k.insert(o, "Form", obj(credit)).await.unwrap_err();
    assert_eq!(fields(&e), ["field_map[1].target_field"], "the owner cannot write Customer credit limits themselves");

    // Keys and the address are derived; the owner is the creator.
    let f = t
        .insert(o, "Form", json!({"title": "Customer Survey 2026!", "questions": [{"label": "Your e-mail", "question_type": "email"}, {"label": "Your e-mail", "question_type": "short_text"}]}))
        .await;
    assert_eq!((f["slug"].clone(), f["status"].clone(), f["owner"].clone()), (json!("customer-survey-2026"), json!("Draft"), json!("owner@acme.test")));
    let keys: Vec<&str> = f["questions"].as_array().unwrap().iter().map(|q| q["key"].as_str().unwrap()).collect();
    assert_eq!(keys, ["your_e_mail", "your_e_mail_2"]);
    let again = t.insert(o, "Form", json!({"title": "Customer Survey 2026!"})).await;
    assert_eq!(again["slug"], json!("customer-survey-2026-2"));
    let taken = t.k.insert(o, "Form", obj(json!({"title": "X", "slug": "customer-survey-2026"}))).await.unwrap_err();
    assert_eq!(fields(&taken), ["slug"], "addresses are unique");
    let empty = t.k.run_action(o, "Form", uid(&again), "publish", json!({})).await.unwrap_err();
    assert_eq!(fields(&empty), ["questions"], "nothing to answer");
}

// ───────────────────────────── every question type ─────────────────────────────

fn every_answers() -> Value {
    json!({"name": "  Asha Rao ", "bio": "Line one\r\nLine two", "mail": "Asha@Example.COM", "phone": "+1 (212) 555-0100", "age": "42",
           "budget": "1,250.50", "start": "2026-11-02", "slot": "09:30:00", "meet": "2026-03-08T03:30", "plan": "Enterprise",
           "colors": ["Blue", "Red"], "agree": "yes", "size": "M", "stars": 9, "nps": 10, "likert": "Agree",
           "grid": {"Speed": "Good", "Price": "Ok"}, "rank": ["Z", "X", "Y"]})
}

async fn every_question_type(t: &T) -> Doc {
    let o = &t.owner;
    let form = t
        .published(
            o,
            json!({"title": "Every Type", "kind": "Survey", "email_question": "mail", "min_fill_seconds": 0, "questions": [
                {"key": "name", "label": "Name", "question_type": "short_text", "required": true, "max_length": 80, "allow_prefill": true},
                {"key": "bio", "label": "Bio", "question_type": "long_text"},
                {"key": "mail", "label": "Email", "question_type": "email", "required": true},
                {"key": "phone", "label": "Phone", "question_type": "phone"},
                {"key": "age", "label": "Age", "question_type": "number", "min_value": "18", "max_value": "120"},
                {"key": "budget", "label": "Budget", "question_type": "decimal", "min_value": "0"},
                {"key": "start", "label": "Start", "question_type": "date", "min_value": "2026-01-01"},
                {"key": "slot", "label": "Slot", "question_type": "time", "min_value": "09:00", "max_value": "17:00"},
                {"key": "meet", "label": "Meeting", "question_type": "datetime"},
                {"key": "plan", "label": "Plan", "question_type": "select", "options": ["Basic", "Pro"], "allow_other": true},
                {"key": "colors", "label": "Colours", "question_type": "multi_select", "options": ["Red", "Green", "Blue"], "max_value": "2", "allow_prefill": true},
                {"key": "agree", "label": "I agree", "question_type": "checkbox", "required": true},
                {"key": "size", "label": "Size", "question_type": "dropdown", "options": ["S", "M", "L"]},
                {"key": "stars", "label": "Stars", "question_type": "rating", "max_value": "10"},
                {"key": "nps", "label": "Recommend", "question_type": "nps"},
                {"key": "likert", "label": "Easy to use", "question_type": "likert"},
                {"key": "grid", "label": "Grid", "question_type": "matrix", "options": ["Bad", "Ok", "Good"], "matrix_rows": ["Speed", "Price"], "required": true},
                {"key": "rank", "label": "Rank", "question_type": "ranking", "options": ["X", "Y", "Z"]},
                {"key": "cv", "label": "CV", "question_type": "file", "accept": "pdf"},
                {"key": "p2", "label": "Thanks", "question_type": "page_break"},
                {"key": "note", "label": "That's all", "question_type": "statement"}
            ]}),
        )
        .await;
    assert_eq!(form["slug"], json!("every-type"));
    let (def, token) = t.open(None, "every-type?name=Asha&colors=Red,Blue&age=30").await;
    assert_eq!(def["form"]["questions"].as_array().unwrap().len(), 21);
    assert_eq!(def["prefill"], json!({"name": "Asha", "colors": ["Red", "Blue"]}), "only questions that allow it are prefilled");
    let text = def.to_string();
    assert!(!text.contains("owner@acme.test") && !text.contains("field_map") && !text.contains("notify"), "{text}");

    // Every wrong answer names its question; the session stays usable until a response is written.
    let base = every_answers();
    let exe = json!([{"file_name": "run.exe", "content_base64": b64(b"MZ\x90\x00")}]);
    let fake_pdf = json!([{"file_name": "cv.pdf", "content_base64": b64(b"MZ\x90\x00 renamed")}]);
    let cases: Vec<(&str, Value)> = vec![
        ("mail", json!("not-an-email")),
        ("phone", json!("call me")),
        ("age", json!(17)),
        ("budget", json!("-1")),
        ("start", json!("2025-12-31")),
        ("slot", json!("18:00")),
        ("meet", json!("2026-03-08T02:30")),
        ("size", json!("XL")),
        ("colors", json!(["Red", "Green", "Blue"])),
        ("agree", json!(false)),
        ("stars", json!(11)),
        ("nps", json!(-1)),
        ("likert", json!("Meh")),
        ("grid", json!({"Speed": "Good"})),
        ("rank", json!(["X", "Y"])),
        ("cv", exe),
        ("cv", fake_pdf),
        ("bogus", json!(1)),
    ];
    for (key, value) in cases {
        let mut a = base.clone();
        a[key] = value.clone();
        let e = t.send(None, "every-type", &token, a).await.unwrap_err();
        assert_eq!(fields(&e), [key], "{key} = {value}");
    }
    let mut missing = base.clone();
    missing.as_object_mut().unwrap().remove("name");
    let e = t.send(None, "every-type", &token, missing).await.unwrap_err();
    assert!(matches!(&e, Error::Validation(v) if v[0].field == "name" && v[0].message == "is required"), "{e:?}");
    let forged = t.send(None, "every-type", "not-a-token", base.clone()).await.unwrap_err();
    assert_eq!(fields(&forged), ["token"]);

    // A valid response, normalized on the server.
    let mut a = base.clone();
    a["cv"] = json!([{"file_name": "cv.pdf", "content_base64": b64(b"%PDF-1.4 test")}]);
    let (status, receipt) = t.send(None, "every-type", &token, a.clone()).await.unwrap();
    assert_eq!(status, 201);
    assert_eq!((receipt["status"].clone(), receipt["replayed"].clone()), (json!("received"), json!(false)));
    assert!(receipt["number"].as_str().unwrap().starts_with("RESP-"));
    let resp = t.response(&receipt).await;
    let mut answers = resp["answers"].clone();
    let cv = answers.as_object_mut().unwrap().remove("cv").unwrap();
    assert_eq!(
        answers,
        json!({"name": "Asha Rao", "bio": "Line one\nLine two", "mail": "asha@example.com", "phone": "+1 (212) 555-0100", "age": 42,
               "budget": "1250.5", "start": "2026-11-02", "slot": "09:30", "meet": "2026-03-08T07:30:00.000Z", "plan": "Enterprise",
               "colors": ["Red", "Blue"], "agree": true, "size": "M", "stars": 9, "nps": 10, "likert": "Agree",
               "grid": {"Speed": "Good", "Price": "Ok"}, "rank": ["Z", "X", "Y"]}),
        "03:30 on the morning New York springs forward is 07:30 UTC (EDT)"
    );
    assert_eq!((cv[0]["file_name"].clone(), cv[0]["content_type"].clone(), cv[0]["size"].clone()), (json!("cv.pdf"), json!("application/pdf"), json!(13)));
    let file: Uuid = cv[0]["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(cv[0]["url"], json!(format!("/files/{file}")));
    let (name, ctype, data) = t.k.read_file(&t.owner, file).await.expect("the owner downloads the upload");
    assert_eq!((name.as_str(), ctype.as_str(), data.as_slice()), ("cv.pdf", "application/pdf", b"%PDF-1.4 test".as_slice()));
    assert!(t.k.read_file(&t.other, file).await.is_err(), "uploads follow the response's access");
    assert_eq!(
        (resp["respondent_email"].clone(), resp["source"].clone(), resp["status"].clone()),
        (json!("asha@example.com"), json!("Public Link"), json!("New"))
    );
    let ip_hash = resp["ip_hash"].as_str().unwrap();
    assert!(ip_hash.len() == 32 && ip_hash.chars().all(|c| c.is_ascii_hexdigit()), "a keyed hash, never the address: {ip_hash}");
    assert!(resp["completion_seconds"].as_i64().is_some_and(|s| (0..60).contains(&s)));
    assert!(resp["created_by"].is_null(), "written by the engine");

    // A retried submit returns the first result.
    let (status, replay) = t.send(None, "every-type", &token, a).await.unwrap();
    assert_eq!((status, replay["number"].clone(), replay["replayed"].clone()), (200, receipt["number"].clone(), json!(true)));
    assert_eq!(t.count("select count(*) from e_form_response where tenant_id = $1 and form = $2", uid(&form)).await, 1);
    form
}

async fn conditional_logic(t: &T) {
    t.published(
        &t.owner,
        json!({"title": "Membership", "min_fill_seconds": 0, "questions": [
            {"key": "member", "label": "Are you a member?", "question_type": "checkbox"},
            {"key": "member_id", "label": "Member id", "question_type": "short_text", "required": true, "visible_if": "answers.member == true"},
            {"key": "why", "label": "Why not?", "question_type": "page_break", "visible_if": "answers.member != true"},
            {"key": "reason", "label": "Reason", "question_type": "long_text", "required": true},
            {"key": "end", "label": "Last page", "question_type": "page_break"},
            {"key": "rating", "label": "Rating", "question_type": "rating", "required": true}
        ]}),
    )
    .await;
    let r = t.respond(None, "membership", json!({"member": true, "member_id": "M-7", "reason": "ignored", "rating": 4})).await;
    assert_eq!(t.response(&r).await["answers"], json!({"member": true, "member_id": "M-7", "rating": 4}), "members skip the 'why not' page");
    let (_, token) = t.open(None, "membership").await;
    let e = t.send(None, "membership", &token, json!({"member": false, "rating": 3})).await.unwrap_err();
    assert_eq!(fields(&e), ["reason"], "the hidden member id is not required; the shown reason is");
    let r = t.send(None, "membership", &token, json!({"member": false, "member_id": "forged", "reason": "Too pricey", "rating": 2})).await.unwrap().1;
    assert_eq!(t.response(&r).await["answers"], json!({"member": false, "reason": "Too pricey", "rating": 2}), "answers to hidden questions are dropped");
}

// ───────────────────────────── records ─────────────────────────────

async fn records_from_responses(t: &T) {
    let commercial = t.find_one("CustomerGroup", json!({"group_name": "Commercial"})).await;
    t.published(
        &t.owner,
        json!({"title": "Contact Us", "min_fill_seconds": 0, "target_entity": "Customer", "questions": [
            {"key": "company", "label": "Company", "question_type": "short_text"},
            {"key": "kind", "label": "Kind", "question_type": "dropdown", "options": ["Company", "Individual"], "required": true},
            {"key": "mail", "label": "Email", "question_type": "email", "required": true},
            {"key": "phone", "label": "Phone", "question_type": "phone"},
            {"key": "terms", "label": "Payment days", "question_type": "number"},
            {"key": "address", "label": "Address", "question_type": "long_text"},
            {"key": "inactive", "label": "Not active yet", "question_type": "checkbox"}
        ], "field_map": [
            {"target_field": "customer_name", "question": "company"},
            {"target_field": "customer_type", "question": "kind"},
            {"target_field": "email", "question": "mail"},
            {"target_field": "phone", "question": "phone"},
            {"target_field": "payment_terms_days", "question": "terms"},
            {"target_field": "billing_address", "question": "address"},
            {"target_field": "customer_group", "value": commercial["id"]},
            {"target_field": "disabled", "question": "inactive"}
        ]}),
    )
    .await;
    let r = t
        .respond(
            None,
            "contact-us",
            json!({"company": "Globex Ltd", "kind": "Company", "mail": "Ops@Globex.test", "terms": 45, "address": "1 Main St\nSpringfield", "inactive": false}),
        )
        .await;
    let before = t.response(&r).await;
    assert!(before["record_id"].is_null(), "records are created after the response commits");
    t.drain().await;
    let resp = t.response(&r).await;
    assert_eq!((resp["record_entity"].clone(), resp["record_error"].clone()), (json!("Customer"), Value::Null));
    let customer = t.get("Customer", resp["record_id"].as_str().unwrap().parse().unwrap()).await;
    assert_eq!(customer["customer_name"], json!("Globex Ltd"));
    assert_eq!(customer["customer_type"], json!("Company"));
    assert_eq!(customer["email"], json!("ops@globex.test"));
    assert_eq!(customer["payment_terms_days"], json!(45));
    assert_eq!(customer["billing_address"], json!("1 Main St\nSpringfield"));
    assert_eq!(customer["customer_group"], commercial["id"]);
    assert_eq!(customer["disabled"], json!(false));
    assert!(customer["phone"].is_null() && customer["tax_id"].is_null(), "only mapped, answered fields are set");
    assert!(customer["number"].as_str().unwrap().starts_with("CUST-") && customer["created_by"].is_null());
    let again = t.k.run_action(&t.owner, "FormResponse", uid(&resp), "create_record", json!({})).await.unwrap_err();
    assert!(matches!(again, Error::Invalid(_)), "a record is created once: {again:?}");
    // A response the target refuses keeps the reason; the owner can retry after fixing the cause.
    let r = t.respond(None, "contact-us", json!({"kind": "Individual", "mail": "x@y.test"})).await;
    t.drain().await;
    let failed = t.response(&r).await;
    assert!(failed["record_id"].is_null());
    assert!(failed["record_error"].as_str().unwrap().contains("Customer Name is required"), "{}", failed["record_error"]);
    let retry = t.k.run_action(&t.owner, "FormResponse", uid(&failed), "create_record", json!({})).await.unwrap_err();
    assert!(matches!(retry, Error::Invalid(ref m) if m.contains("could not be created")), "{retry:?}");
    assert_eq!(t.list(&t.admin, "Customer", json!({"email": "x@y.test"})).await.len(), 0);
}

// ───────────────────────────── quizzes ─────────────────────────────

async fn quizzes(t: &T) {
    t.published(
        &t.owner,
        json!({"title": "Geography Quiz", "kind": "Quiz", "passing_score": "60", "reveal_answers": true, "min_fill_seconds": 0, "questions": [
            {"key": "capital", "label": "Capital of France?", "question_type": "short_text", "correct_answer": ["Paris"], "points": "2"},
            {"key": "sum", "label": "2 + 2", "question_type": "number", "correct_answer": 4},
            {"key": "primes", "label": "Primes", "question_type": "multi_select", "options": ["2", "3", "4"], "correct_answer": ["2", "3"], "points": "1.5"},
            {"key": "essay", "label": "Why?", "question_type": "long_text"}
        ]}),
    )
    .await;
    let (def, _) = t.open(None, "geography-quiz").await;
    let text = def.to_string();
    assert!(!text.contains("correct") && !text.contains("points") && !text.contains("passing") && !text.contains("Paris"), "{text}");
    let r = t.respond(None, "geography-quiz", json!({"capital": "  paris ", "sum": 4, "primes": ["2"], "essay": "Because"})).await;
    let result = &r["result"];
    assert_eq!(
        (result["score"].clone(), result["max_score"].clone(), result["percent"].clone(), result["passed"].clone()),
        (json!("3"), json!("4.5"), json!("66.67"), json!(true))
    );
    let marks: Vec<(Value, Value, Value)> =
        result["questions"].as_array().unwrap().iter().map(|q| (q["key"].clone(), q["correct"].clone(), q["earned"].clone())).collect();
    assert_eq!(marks, [(json!("capital"), json!(true), json!("2")), (json!("sum"), json!(true), json!("1")), (json!("primes"), json!(false), json!("0"))]);
    assert_eq!(result["questions"][2]["correct_answer"], json!(["2", "3"]), "revealed after submitting");
    let stored = t.response(&r).await;
    assert_eq!((stored["score"].clone(), stored["max_score"].clone(), stored["quiz_result"].clone()), (json!("3"), json!("4.5"), json!("Passed")));
    let token = r["result_token"].as_str().unwrap();
    let (_, later) = t.call(None, "GET", &format!("/results/{token}"), None).await.unwrap();
    assert_eq!(&later["result"], result, "the result link shows the same result");
    let mut forged = token.to_string();
    forged.replace_range(5..6, if &forged[5..6] == "A" { "B" } else { "A" });
    assert!(matches!(t.call(None, "GET", &format!("/results/{forged}"), None).await, Err(Error::NotFound(_))));
    let r = t.respond(None, "geography-quiz", json!({"capital": "Lyon", "sum": 5, "primes": ["2", "3"]})).await;
    assert_eq!((r["result"]["score"].clone(), r["result"]["percent"].clone(), r["result"]["passed"].clone()), (json!("1.5"), json!("33.33"), json!(false)));
    assert_eq!(t.response(&r).await["quiz_result"], json!("Failed"));
}

// ───────────────────────────── limits and duplicates ─────────────────────────────

async fn limits_and_duplicates(t: &T) {
    let mail_form = |title: &str, extra: Value| {
        let mut v = json!({"title": title, "email_question": "mail", "min_fill_seconds": 0, "closed_message": "Registration is full",
            "questions": [{"key": "mail", "label": "Email", "question_type": "email", "required": true}]});
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    };
    // Three seats, eight people at once: exactly three get in, and the form closes.
    let workshop = t.published(&t.owner, mail_form("Workshop", json!({"response_limit": 3, "one_response_per": "Email"}))).await;
    let mut tokens = Vec::new();
    for _ in 0..8 {
        tokens.push(t.open(None, "workshop").await.1);
    }
    let mut tasks = Vec::new();
    for (i, token) in tokens.into_iter().enumerate() {
        let t = t.clone();
        tasks.push(tokio::spawn(async move { t.send(None, "workshop", &token, json!({"mail": format!("p{i}@x.test")})).await }));
    }
    let mut outcomes = Vec::new();
    for task in tasks {
        outcomes.push(match task.await.unwrap() {
            Ok((s, _)) => s,
            Err(Error::Conflict(m)) => {
                assert_eq!(m, "Registration is full");
                409
            }
            Err(e) => panic!("{e:?}"),
        });
    }
    assert_eq!((outcomes.iter().filter(|s| **s == 201).count(), outcomes.iter().filter(|s| **s == 409).count()), (3, 5), "{outcomes:?}");
    assert_eq!(t.count("select count(*) from e_form_response where tenant_id = $1 and form = $2", uid(&workshop)).await, 3);
    assert_eq!(t.get("Form", uid(&workshop)).await["status"], json!("Closed"), "the limit closes the form");
    assert!(matches!(t.call(None, "GET", "/f/workshop", None).await, Err(Error::Conflict(m)) if m == "Registration is full"));

    // One response per email, six attempts at once.
    let once = t.published(&t.owner, mail_form("Survey Once", json!({"one_response_per": "Email"}))).await;
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let token = t.open(None, "survey-once").await.1;
        let t = t.clone();
        tasks.push(tokio::spawn(async move { t.send(None, "survey-once", &token, json!({"mail": "same@x.test"})).await }));
    }
    let mut won = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok((201, _)) => won += 1,
            Err(Error::Conflict(m)) => assert!(m.contains("already"), "{m}"),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(won, 1);
    let token = t.open(None, "survey-once").await.1;
    assert!(matches!(t.send(None, "survey-once", &token, json!({"mail": "SAME@X.test"})).await, Err(Error::Conflict(_))), "emails compare in lower case");
    assert_eq!(t.count("select count(*) from forms_claim where tenant_id = $1 and form_id = $2", uid(&once)).await, 1);

    // The same session sent three times at once is one response.
    let ping = t
        .published(&t.owner, json!({"title": "Ping", "min_fill_seconds": 0, "questions": [{"key": "msg", "label": "Message", "question_type": "short_text"}]}))
        .await;
    let token = t.open(None, "ping").await.1;
    let mut tasks = Vec::new();
    for _ in 0..3 {
        let (t, token) = (t.clone(), token.clone());
        tasks.push(tokio::spawn(async move { t.send(None, "ping", &token, json!({"msg": "hello"})).await.unwrap() }));
    }
    let mut statuses: Vec<u16> = Vec::new();
    let mut numbers = Vec::new();
    for task in tasks {
        let (s, v) = task.await.unwrap();
        statuses.push(s);
        numbers.push(v["number"].clone());
    }
    statuses.sort_unstable();
    assert_eq!(statuses, [200, 200, 201]);
    assert!(numbers.iter().all(|n| *n == numbers[0]));
    assert_eq!(t.count("select count(*) from e_form_response where tenant_id = $1 and form = $2", uid(&ping)).await, 1);

    // Opening hours.
    let yesterday = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339();
    let tomorrow = (chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339();
    t.published(
        &t.owner,
        mail_form(
            "Past",
            json!({"opens_at": (chrono::Utc::now() - chrono::Duration::days(2)).to_rfc3339(), "closes_at": yesterday, "closed_message": "We are closed"}),
        ),
    )
    .await;
    assert!(matches!(t.call(None, "GET", "/f/past", None).await, Err(Error::Conflict(m)) if m == "We are closed"));
    t.published(&t.owner, mail_form("Future", json!({"opens_at": tomorrow}))).await;
    assert!(matches!(t.call(None, "GET", "/f/future", None).await, Err(Error::Conflict(m)) if m.starts_with("This form opens at")));
    t.insert(&t.owner, "Form", mail_form("Secret Draft", json!({}))).await;
    assert!(matches!(t.call(None, "GET", "/f/secret-draft", None).await, Err(Error::NotFound(_))), "drafts do not exist for respondents");
    assert!(matches!(t.call(None, "GET", "/f/no-such-form", None).await, Err(Error::NotFound(_))));

    // Internal forms: signed-in users only, once each.
    t.published(
        &t.owner,
        json!({"title": "Staff Only", "access": "Internal", "one_response_per": "User", "min_fill_seconds": 0,
        "questions": [{"key": "lunch", "label": "Lunch?", "question_type": "select", "options": ["Veg", "Non-veg"], "required": true}]}),
    )
    .await;
    assert!(matches!(t.call(None, "GET", "/f/staff-only", None).await, Err(Error::NotFound(_))), "the same answer as a wrong address");
    let r = t.respond(Some(&t.staff), "staff-only", json!({"lunch": "Veg"})).await;
    let resp = t.response(&r).await;
    assert_eq!(
        (resp["respondent_email"].clone(), resp["respondent_name"].clone(), resp["respondent_user"].clone(), resp["source"].clone()),
        (json!("staff@acme.test"), json!("Staff Member"), json!(t.staff.user.to_string()), json!("Signed In"))
    );
    let token = t.open(Some(&t.staff), "staff-only").await.1;
    assert!(matches!(t.send(Some(&t.staff), "staff-only", &token, json!({"lunch": "Non-veg"})).await, Err(Error::Conflict(_))));
    t.respond(Some(&t.staff2), "staff-only", json!({"lunch": "Non-veg"})).await;
}

// ───────────────────────────── anonymity ─────────────────────────────

async fn anonymity(t: &T) {
    let form = t
        .published(
            &t.owner,
            json!({"title": "Engagement", "kind": "Survey", "access": "Internal", "anonymous": true, "one_response_per": "User", "min_fill_seconds": 0,
                   "questions": [{"key": "mood", "label": "Mood", "question_type": "rating", "required": true}, {"key": "comment", "label": "Comment", "question_type": "long_text"}]}),
        )
        .await;
    let r = t.respond(Some(&t.staff), "engagement", json!({"mood": 4, "comment": "Fine"})).await;
    let resp = t.response(&r).await;
    for k in ["respondent_email", "respondent_name", "respondent_user", "ip_hash", "created_by", "updated_by"] {
        assert!(resp[k].is_null(), "{k} must not be kept: {}", resp[k]);
    }
    let rid = uid(&resp);
    let staff_id = t.staff.user.to_string();
    let traces = [
        t.text("select to_jsonb(r)::text from e_form_response r where tenant_id = $1 and id = $2", rid).await,
        t.text("select string_agg(coalesce(actor::text, '') || ' ' || coalesce(diff::text, '') || ' ' || coalesce(request_id, ''), ' ') from audit_event where tenant_id = $1 and record_id = $2", rid).await,
        t.text("select string_agg(payload::text, ' ') from outbox where tenant_id = $1 and record_id = $2", rid).await,
    ];
    for trace in &traces {
        assert!(!trace.is_empty());
        for identifying in [staff_id.as_str(), "staff@acme.test", "Staff Member", "203.0.113.7"] {
            assert!(!trace.contains(identifying), "{identifying} found in {trace}");
        }
    }
    // Who took part is known (to refuse a second response), never which answers were theirs.
    let token = t.open(Some(&t.staff), "engagement").await.1;
    assert!(matches!(t.send(Some(&t.staff), "engagement", &token, json!({"mood": 1})).await, Err(Error::Conflict(_))));
    assert_eq!(t.text("select string_agg(claim, ',') from forms_claim where tenant_id = $1 and form_id = $2", uid(&form)).await, format!("user:{staff_id}"));
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let token = t.open(Some(&t.staff2), "engagement").await.1;
        let t = t.clone();
        tasks.push(tokio::spawn(async move { t.send(Some(&t.staff2), "engagement", &token, json!({"mood": 5})).await }));
    }
    let mut ok = 0;
    for task in tasks {
        if task.await.unwrap().is_ok() {
            ok += 1;
        }
    }
    assert_eq!(ok, 1, "one response per person, even at once");
    let e = t.k.insert(&t.owner, "Form", obj(json!({"title": "Anon mail", "anonymous": true, "one_response_per": "Email"}))).await.unwrap_err();
    assert!(fields(&e).contains(&"one_response_per".to_string()));
}

// ───────────────────────────── spam ─────────────────────────────

async fn spam(t: &T) {
    let form = t
        .published(
            &t.owner,
            json!({"title": "Spammy", "min_fill_seconds": 2, "response_limit": 1, "target_entity": "Customer",
                   "questions": [{"key": "name", "label": "Name", "question_type": "short_text", "required": true}],
                   "field_map": [{"target_field": "customer_name", "question": "name"}]}),
        )
        .await;
    let fid = uid(&form);
    let (_, token) = t.open(None, "spammy").await;
    let (status, bot) = t
        .call(None, "POST", "/f/spammy/responses", Some(json!({"token": token, "answers": {"name": "Bot"}, "honeypot": "http://spam.example"})))
        .await
        .unwrap();
    assert_eq!((status, bot["status"].clone()), (201, json!("received")), "bots learn nothing");
    let (_, token) = t.open(None, "spammy").await;
    let fast = t.send(None, "spammy", &token, json!({"name": "Speedy"})).await.unwrap().1;
    let (bot, fast) = (t.response(&bot).await, t.response(&fast).await);
    assert_eq!((bot["status"].clone(), fast["status"].clone()), (json!("Spam"), json!("Spam")));
    assert!(bot["spam_reason"].as_str().unwrap().contains("honeypot") && fast["spam_reason"].as_str().unwrap().contains("faster"));
    t.drain().await;
    assert_eq!(t.notifications(&t.owner, uid(&bot)).await + t.notifications(&t.owner, uid(&fast)).await, 0, "spam notifies nobody");
    assert!(t.get("FormResponse", uid(&bot)).await["record_id"].is_null(), "and creates nothing");
    assert_eq!(t.get("Form", fid).await["status"], json!("Published"), "spam does not use up the limit");
    let (_, token) = t.open(None, "spammy").await;
    tokio::time::sleep(std::time::Duration::from_millis(2100)).await;
    let real = t.send(None, "spammy", &token, json!({"name": "Patient Person"})).await.unwrap().1;
    let real = t.response(&real).await;
    assert_eq!(real["status"], json!("New"));
    assert!(real["completion_seconds"].as_i64().unwrap() >= 2);
    assert_eq!(t.get("Form", fid).await["status"], json!("Closed"));
    t.drain().await;
    assert_eq!(t.notifications(&t.owner, uid(&real)).await, 1);
    let summary = t.call(Some(&t.owner), "GET", &format!("/forms/{fid}/summary"), None).await.unwrap().1;
    assert_eq!((summary["responses"].clone(), summary["spam"].clone()), (json!(1), json!(2)));
    // A false positive is released: the record and the notification it missed follow.
    let out = t.action(&t.owner, "FormResponse", uid(&bot), "not_spam", json!({})).await;
    assert_eq!(out["status"], json!("New"));
    let bot = t.get("FormResponse", uid(&bot)).await;
    let customer = t.get("Customer", bot["record_id"].as_str().unwrap().parse().unwrap()).await;
    assert_eq!(customer["customer_name"], json!("Bot"));
    assert_eq!(t.notifications(&t.owner, uid(&bot)).await, 1);
    t.action(&t.owner, "FormResponse", uid(&real), "mark_spam", json!({})).await;
    assert_eq!(t.get("FormResponse", uid(&real)).await["status"], json!("Spam"));
    t.action(&t.owner, "FormResponse", uid(&bot), "mark_reviewed", json!({})).await;
    assert_eq!(t.get("FormResponse", uid(&bot)).await["status"], json!("Reviewed"));
}

// ───────────────────────────── notifications and mail ─────────────────────────────

async fn notifications_and_mail(t: &T) {
    t.published(
        &t.owner,
        json!({"title": "Feedback", "email_question": "mail", "min_fill_seconds": 0, "notify_users": [{"email": "manager@acme.test"}, {"email": "staff@acme.test"}],
               "autoresponder": true, "autoresponder_subject": "Thanks for your feedback", "autoresponder_message": "Thanks & see you <soon>\nThe team",
               "questions": [{"key": "mail", "label": "Email", "question_type": "email", "required": true}, {"key": "text", "label": "Feedback", "question_type": "long_text"}]}),
    )
    .await;
    // Mail queued by earlier scenarios (the released spam's notification) goes out first.
    t.drain().await;
    t.mail.0.lock().unwrap().clear();
    let r = t.respond(None, "feedback", json!({"mail": "Fan@Example.test", "text": "<b>Great</b>"})).await;
    t.drain().await;
    let resp = t.response(&r).await;
    let rid = uid(&resp);
    assert_eq!((t.notifications(&t.owner, rid).await, t.notifications(&t.manager, rid).await), (1, 1));
    assert_eq!(t.notifications(&t.staff, rid).await, 0, "listed, but not allowed to read responses");
    assert_eq!(t.notifications(&t.other, rid).await, 0);
    let mails = t.mail.0.lock().unwrap().clone();
    let to = |who: &str| mails.iter().filter(|m| m.0 == who).cloned().collect::<Vec<_>>();
    let number = resp["number"].as_str().unwrap();
    for owner in ["owner@acme.test", "manager@acme.test"] {
        let got = to(owner);
        assert_eq!(got.len(), 1, "{owner}: {mails:?}");
        assert_eq!(got[0].1, format!("New response to Feedback ({number})"));
        assert!(got[0].2.contains("&lt;b&gt;Great&lt;/b&gt;") && got[0].2.contains("fan@example.test"), "answers are escaped: {}", got[0].2);
    }
    let fan = to("fan@example.test");
    assert_eq!(fan.len(), 1);
    assert_eq!(fan[0].1, "Thanks for your feedback");
    assert!(fan[0].2.contains("Thanks &amp; see you &lt;soon&gt;<br>The team"), "{}", fan[0].2);
    assert!(to("staff@acme.test").is_empty());
    // At-least-once delivery: a redelivered event changes nothing.
    let ev = Event {
        id: 0,
        tenant_id: t.tenant,
        topic: "FormResponse.created".into(),
        entity: Some("FormResponse".into()),
        record_id: Some(rid),
        payload: json!({}),
        attempts: 1,
    };
    for sink in t.k.hooks.event_sinks() {
        sink.on_event(&t.k, &ev).await.expect("redelivery");
    }
    t.drain().await;
    assert_eq!((t.notifications(&t.owner, rid).await, t.mail.0.lock().unwrap().len()), (1, mails.len()));
    // The same address again the same day: owners hear of it, the respondent is not mailed twice.
    let r2 = t.respond(None, "feedback", json!({"mail": "fan@example.test", "text": "Again"})).await;
    t.drain().await;
    let rid2 = uid(&t.response(&r2).await);
    assert_eq!(t.notifications(&t.owner, rid2).await, 1);
    assert_eq!(t.mail.0.lock().unwrap().iter().filter(|m| m.0 == "fan@example.test").count(), 1, "one autoresponse per address and day");
    let comms = t.count("select count(*) from e_communication where tenant_id = $1 and reference_id = $2::text", rid).await;
    assert_eq!(comms, 2, "the owners' email and the autoresponse sit on the response's timeline");
}

// ───────────────────────────── analytics ─────────────────────────────

async fn analytics_and_exports(t: &T) {
    let form = t
        .published(
            &t.owner,
            json!({"title": "NPS Survey", "kind": "Survey", "min_fill_seconds": 0, "questions": [
                {"key": "nps", "label": "Recommend?", "question_type": "nps"},
                {"key": "stars", "label": "Stars", "question_type": "rating"},
                {"key": "agree", "label": "Easy", "question_type": "likert"},
                {"key": "grid", "label": "Grid", "question_type": "matrix", "options": ["Bad", "Ok", "Good"], "matrix_rows": ["Speed", "Price"]},
                {"key": "pick", "label": "Pick", "question_type": "multi_select", "options": ["A", "B", "C"]},
                {"key": "rank", "label": "Rank", "question_type": "ranking", "options": ["X", "Y", "Z"]},
                {"key": "amount", "label": "Amount", "question_type": "decimal"},
                {"key": "ok", "label": "Ok", "question_type": "checkbox"},
                {"key": "comment", "label": "Comment", "question_type": "short_text"}
            ]}),
        )
        .await;
    let fid = uid(&form);
    let answers = [
        json!({"nps": 10, "stars": 5, "agree": "Agree", "grid": {"Speed": "Good", "Price": "Bad"}, "pick": ["A", "B"], "rank": ["X", "Y", "Z"], "amount": "10.5", "ok": true, "comment": "Fast"}),
        json!({"nps": 9, "stars": 4, "agree": "Strongly agree", "grid": {"Speed": "Good"}, "pick": ["A"], "rank": ["Y", "X", "Z"], "amount": "2", "ok": false, "comment": "=HYPERLINK(\"http://evil\")"}),
        json!({"nps": 9, "stars": 4, "agree": "Agree", "grid": {"Speed": "Ok", "Price": "Good"}, "pick": ["C"], "rank": ["X", "Z", "Y"], "comment": "Slow, but ok"}),
        json!({"nps": 8, "stars": 3, "agree": "Disagree"}),
        json!({"nps": 7}),
        json!({"nps": 3, "stars": 1}),
    ];
    let mut numbers = Vec::new();
    for a in &answers {
        numbers.push(t.respond(None, "nps-survey", a.clone()).await["number"].as_str().unwrap().to_string());
    }
    let s = t.call(Some(&t.owner), "GET", &format!("/forms/{fid}/summary"), None).await.unwrap().1;
    assert_eq!((s["responses"].clone(), s["spam"].clone(), s["views"].clone(), s["completion_rate"].clone()), (json!(6), json!(0), json!(6), json!("100")));
    let q = &s["questions"];
    assert_eq!(q[0]["nps"], json!("33.33"), "3 promoters, 2 passives, 1 detractor: 50% − 16.67% computed exactly");
    assert_eq!((q[0]["promoters"]["count"].clone(), q[0]["passives"]["count"].clone(), q[0]["detractors"]["count"].clone()), (json!(3), json!(2), json!(1)));
    assert_eq!(q[0]["average"], json!("7.67"));
    assert_eq!((q[1]["answered"].clone(), q[1]["skipped"].clone(), q[1]["average"].clone()), (json!(5), json!(1), json!("3.4")));
    assert_eq!(q[1]["distribution"][3], json!({"value": 4, "count": 2, "percent": "40"}));
    assert_eq!(q[2]["options"][3], json!({"option": "Agree", "count": 2, "percent": "50"}));
    assert_eq!(q[2]["average"], json!("3.75"));
    assert_eq!(q[3]["rows"][0]["columns"][2], json!({"column": "Good", "count": 2, "percent": "66.67"}));
    assert_eq!(q[3]["rows"][1]["answered"], json!(2));
    assert_eq!(q[4]["options"][0], json!({"option": "A", "count": 2, "percent": "66.67"}));
    assert_eq!(q[5]["items"][0], json!({"item": "X", "average_rank": "1.33", "first_place": 2}));
    assert_eq!((q[6]["sum"].clone(), q[6]["average"].clone()), (json!("12.5"), json!("6.25")));
    assert_eq!((q[7]["yes"]["count"].clone(), q[7]["no"]["count"].clone()), (json!(1), json!(1)));
    assert_eq!(q[8]["answered"], json!(3));
    let today = s["trend"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(today["responses"], json!(6), "{today}");

    // Text answers, newest first, a page at a time.
    let p1 = t.call(Some(&t.owner), "GET", &format!("/forms/{fid}/answers/comment?limit=2"), None).await.unwrap().1;
    assert_eq!(
        p1["answers"].as_array().unwrap().iter().map(|a| a["text"].clone()).collect::<Vec<_>>(),
        [json!("Slow, but ok"), json!("=HYPERLINK(\"http://evil\")")]
    );
    let cursor = p1["next_cursor"].as_str().unwrap();
    let p2 = t.call(Some(&t.owner), "GET", &format!("/forms/{fid}/answers/comment?limit=2&cursor={cursor}"), None).await.unwrap().1;
    assert_eq!(p2["answers"].as_array().unwrap().iter().map(|a| a["text"].clone()).collect::<Vec<_>>(), [json!("Fast")]);
    assert!(p2["next_cursor"].is_null());

    // CSV flattened by question key; formulas are defused.
    let csv = t.raw(Some(&t.owner), "GET", &format!("/forms/{fid}/export.csv"), None).await.unwrap();
    assert_eq!(csv.content_type, "text/csv; charset=utf-8");
    let body = String::from_utf8(csv.body).unwrap();
    let lines: Vec<&str> = body.trim_end().split("\r\n").collect();
    assert_eq!(lines.len(), 7);
    assert_eq!(
        lines[0],
        "\u{feff}number,submitted_at,status,source,respondent_email,respondent_name,completion_seconds,nps,stars,agree,grid[Speed],grid[Price],pick,rank,amount,ok,comment"
    );
    assert!(lines[1].starts_with(&numbers[0]) && lines[1].ends_with(",10,5,Agree,Good,Bad,\"A, B\",X > Y > Z,10.5,Yes,Fast"), "{}", lines[1]);
    assert!(lines[2].ends_with(",\"'=HYPERLINK(\"\"http://evil\"\")\""), "{}", lines[2]);
    assert!(lines[3].ends_with(",\"Slow, but ok\""), "{}", lines[3]);

    // The same numbers as reports.
    let p = [("form", fid.to_string())];
    let rows = t.report(&t.owner, "form_question_summary", &p).await;
    let nps_row = rows["rows"].as_array().unwrap().iter().find(|r| r["answer"] == json!("NPS")).cloned().unwrap();
    assert_eq!(nps_row["value"], json!("33.33"));
    assert_eq!(t.report(&t.owner, "form_response_trend", &p).await["totals"]["responses"], json!(6));
    let overview = t.report(&t.owner, "forms_overview", &[]).await;
    let mine = overview["rows"].as_array().unwrap().iter().find(|r| r["title"] == json!("NPS Survey")).cloned().unwrap();
    assert_eq!((mine["responses"].clone(), mine["views"].clone(), mine["completion_rate"].clone()), (json!(6), json!(6), json!("100")));

    // Days are the workspace's: New York, across the spring clock change.
    let ids: Vec<Uuid> = t.list(&t.admin, "FormResponse", json!({"form": fid.to_string()})).await.iter().map(uid).collect();
    for (rid, at) in ids.iter().zip(["2026-03-08T04:30:00Z", "2026-03-08T05:30:00Z", "2026-03-09T03:30:00Z", "2026-03-09T04:30:00Z"]) {
        t.exec(&format!("update e_form_response set submitted_at = '{at}' where tenant_id = $1 and id = $2"), *rid).await;
    }
    let trend =
        t.report(&t.owner, "form_response_trend", &[("form", fid.to_string()), ("from_date", "2026-03-07".into()), ("to_date", "2026-03-09".into())]).await;
    let per_day: Vec<(Value, Value)> = trend["rows"].as_array().unwrap().iter().map(|r| (r["date"].clone(), r["responses"].clone())).collect();
    assert_eq!(
        per_day,
        [(json!("2026-03-07"), json!(1)), (json!("2026-03-08"), json!(2)), (json!("2026-03-09"), json!(1))],
        "23:30 EST, 00:30 EST, 23:30 EDT, 00:30 EDT"
    );
    let day = t.call(Some(&t.owner), "GET", &format!("/forms/{fid}/summary?from=2026-03-08&to=2026-03-08"), None).await.unwrap().1;
    assert_eq!(day["responses"], json!(2), "the 23-hour day holds exactly its two responses");
}

// ───────────────────────────── permissions ─────────────────────────────

async fn permissions(t: &T, every: &Doc) {
    let fid = uid(every);
    assert!(matches!(t.k.get(&t.other, "Form", fid, false).await, Err(Error::NotFound(_))), "another Forms User does not see the form");
    assert!(t.list(&t.other, "FormResponse", json!({})).await.is_empty(), "nor any response of it");
    assert!(matches!(t.call(Some(&t.other), "GET", &format!("/forms/{fid}/summary"), None).await, Err(Error::NotFound(_))));
    assert!(t.raw(Some(&t.other), "GET", &format!("/forms/{fid}/export.csv"), None).await.is_err());
    assert!(matches!(t.k.list(&t.staff, "FormResponse", &ListQuery::default()).await, Err(Error::Forbidden(_))), "employees read no responses");
    assert!(t.call(Some(&t.staff), "GET", &format!("/forms/{fid}/summary"), None).await.is_err());
    let all = t.count("select count(*) from e_form_response where tenant_id = $1 and $2::uuid is not null", fid).await;
    let owners = t.count("select count(*) from e_form_response where tenant_id = $1 and form_owner = 'owner@acme.test' and $2::uuid is not null", fid).await;
    assert_eq!(t.list(&t.manager, "FormResponse", json!({})).await.len() as i64, all, "managers see every response");
    assert_eq!(t.list(&t.owner, "FormResponse", json!({})).await.len() as i64, owners, "owners see their forms' responses");
    assert!(t.call(Some(&t.manager), "GET", &format!("/forms/{fid}/summary"), None).await.is_ok());

    // Responses are never typed in: not by owners, not by automations running as the system.
    let forged = json!({"form": fid.to_string(), "answers": {"name": "Forged"}});
    assert!(matches!(t.k.insert(&t.owner, "FormResponse", obj(forged.clone())).await, Err(Error::Forbidden(_))));
    let system = Ctx::system(t.tenant, t.k.registry.schema(t.tenant).await.unwrap());
    assert!(matches!(t.k.insert(&system, "FormResponse", obj(forged)).await, Err(Error::Forbidden(m)) if m.contains("created by the form")));

    // Ownership moves with the form; only managers move it.
    let handover = t
        .published(&t.owner, json!({"title": "Handover", "min_fill_seconds": 0, "questions": [{"key": "q", "label": "Q", "question_type": "short_text"}]}))
        .await;
    let hid = uid(&handover);
    let r = t.respond(None, "handover", json!({"q": "hello"})).await;
    let rid = uid(&t.response(&r).await);
    let e = t.k.update(&t.owner, "Form", hid, obj(json!({"owner": "other@acme.test"})), None).await.unwrap_err();
    assert!(matches!(&e, Error::Validation(v) if v[0].field == "owner"), "{e:?}");
    let e = t.k.update(&t.manager, "Form", hid, obj(json!({"owner": "nobody@acme.test"})), None).await.unwrap_err();
    assert_eq!(fields(&e), ["owner"], "forms go to active users only");
    t.k.update(&t.manager, "Form", hid, obj(json!({"owner": "other@acme.test"})), None).await.expect("a manager hands the form over");
    assert!(t.k.get(&t.other, "FormResponse", rid, false).await.is_ok(), "the new owner reads its responses");
    assert!(t.k.get(&t.owner, "FormResponse", rid, false).await.is_err(), "the creator no longer does");
    assert!(t.k.get(&t.owner, "Form", hid, false).await.is_ok(), "but still sees the form they made");
}

// ───────────────────────────── manual entry and edits ─────────────────────────────

async fn manual_entry_and_edits(t: &T, every: &Doc) {
    let fid = uid(every);
    let mut a = every_answers();
    a["mail"] = json!("caller@x.test");
    let out =
        t.action(&t.owner, "Form", fid, "record_response", json!({"answers": a, "respondent_email": "Caller@X.test", "respondent_name": "Phone Caller"})).await;
    assert_eq!(out["entity"], json!("FormResponse"));
    let resp = t.get("FormResponse", out["id"].as_str().unwrap().parse().unwrap()).await;
    assert_eq!(
        (resp["source"].clone(), resp["respondent_email"].clone(), resp["respondent_name"].clone(), resp["created_by"].clone()),
        (json!("Manual Entry"), json!("caller@x.test"), json!("Phone Caller"), json!(t.owner.user.to_string())),
        "the audit names who typed it in"
    );
    let mut bad = every_answers();
    bad["age"] = json!(7);
    let e = t.k.run_action(&t.owner, "Form", fid, "record_response", json!({"answers": bad})).await.unwrap_err();
    assert_eq!(fields(&e), ["age"]);

    // Answered questions keep their type; forms with responses are closed, not deleted.
    let mut doc = t.get("Form", fid).await;
    let questions = doc.get_mut("questions").unwrap().as_array_mut().unwrap();
    questions[13]["question_type"] = json!("nps");
    let patch = obj(json!({"questions": questions.clone()}));
    let e = t.k.update(&t.owner, "Form", fid, patch, None).await.unwrap_err();
    assert_eq!(fields(&e), ["questions[13].question_type"]);
    assert!(matches!(t.k.delete(&t.owner, "Form", fid, None).await, Err(Error::Conflict(m)) if m.contains("has responses")));
    let copy = t.action(&t.owner, "Form", fid, "duplicate", json!({})).await;
    let copy = t.get("Form", copy["id"].as_str().unwrap().parse().unwrap()).await;
    assert_eq!((copy["title"].clone(), copy["status"].clone(), copy["slug"].clone()), (json!("Every Type (copy)"), json!("Draft"), json!("every-type-copy")));
    assert_eq!(copy["questions"].as_array().unwrap().len(), 21);
    t.action(&t.owner, "Form", fid, "close", json!({})).await;
    assert!(matches!(t.call(None, "GET", "/f/every-type", None).await, Err(Error::Conflict(_))));
    t.action(&t.owner, "Form", fid, "publish", json!({})).await;
    t.open(None, "every-type").await;
}

// ───────────────────────────── maintenance ─────────────────────────────

async fn maintenance(t: &T) {
    let form = t
        .published(&t.owner, json!({"title": "Ends Soon", "min_fill_seconds": 0, "questions": [{"key": "q", "label": "Q", "question_type": "short_text"}]}))
        .await;
    t.exec("update e_form set closes_at = now() - interval '1 minute' where tenant_id = $1 and id = $2", uid(&form)).await;
    let spam_before = t.count("select count(*) from e_form_response where tenant_id = $1 and status = 'Spam' and $2::uuid is not null", uid(&form)).await;
    assert!(spam_before >= 2);
    t.exec("update e_form_response set created_at = now() - interval '40 days' where tenant_id = $1 and status = 'Spam' and $2::uuid is not null", uid(&form))
        .await;
    t.exec("update forms_autoresponse set sent_at = now() - interval '3 days' where tenant_id = $1 and $2::uuid is not null", uid(&form)).await;
    ferrum_app_forms::maintenance(&t.k).await.expect("maintenance");
    ferrum_app_forms::maintenance(&t.k).await.expect("maintenance is idempotent");
    assert_eq!(t.get("Form", uid(&form)).await["status"], json!("Closed"));
    assert_eq!(t.count("select count(*) from e_form_response where tenant_id = $1 and status = 'Spam' and $2::uuid is not null", uid(&form)).await, 0);
    assert_eq!(t.count("select count(*) from forms_autoresponse where tenant_id = $1 and $2::uuid is not null", uid(&form)).await, 0);
}
