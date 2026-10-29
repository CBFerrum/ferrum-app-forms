//! Forms and Surveys: one engine for forms, surveys and quizzes.
//!
//! * `Form` holds the definition — questions of 21 types with validations, CEL conditional logic
//!   over `answers`, page skips — and the response rules: when it is open, who may respond and
//!   how often, spam traps, notifications, an autoresponse, quiz grading and a record created
//!   from each response (a Lead, a Ticket, any entity) through a checked field mapping.
//! * `FormResponse` is one response, checked and normalized on the server. Respondents reach the
//!   forms through a `Site` (`/api/site/{tenant}/forms/...` and `/api/app/forms/...`); owners
//!   and AI agents use the generic API, the documents' actions, the reports and the analytics
//!   endpoints — see `packages/forms/README.md`.
//! * After a response commits, an outbox sink creates its record and sends the notifications
//!   once; `maintenance` closes forms past their closing time and purges old spam.

mod analytics;
mod answers;
mod files;
mod form;
mod logic;
mod mapping;
mod model;
mod reports;
mod response;
mod site;
mod token;
mod upkeep;

use ferrum_domain::reports::ReportSource;
use ferrum_kernel::{Ctx, HookRegistry, Kernel, Result};
use ferrum_meta::Schema;
use std::sync::Arc;
use uuid::Uuid;

pub(crate) const PACKAGE: &str = "forms";

/// Request ids of the engine's own work. Responses can only be written under one.
pub(crate) const ENGINE_PREFIX: &str = "forms-";

/// The engine context of a workspace: full rights, its request id marking forms' own writes.
pub(crate) fn engine(tenant: Uuid, schema: Arc<Schema>) -> Ctx {
    let mut c = Ctx::system(tenant, schema);
    c.request_id = format!("{ENGINE_PREFIX}{}", Uuid::now_v7());
    c
}

pub(crate) fn engine_of(ctx: &Ctx) -> Ctx {
    let mut c = engine(ctx.tenant, ctx.schema.clone());
    c.fy_start_month = ctx.fy_start_month;
    c
}

/// Whether the workspace has the Mail app (emails are `Communication` records it sends).
pub(crate) fn mail_installed(ctx: &Ctx) -> bool {
    ctx.schema.packages.iter().any(|p| p == "comms") && ctx.schema.entity("Communication").is_some()
}

/// Whether this workspace can send email: through the Mail app, or the server's own mailer.
pub(crate) fn can_email(k: &ferrum_kernel::Kernel, ctx: &Ctx) -> bool {
    mail_installed(ctx) || k.mailer.is_some()
}

include!(concat!(env!("OUT_DIR"), "/packages.rs"));

/// This app's manifest (`app.yaml`).
pub const MANIFEST: &str = include_str!("../app.yaml");

/// This app's metadata packages, embedded at build time.
pub fn packages() -> std::result::Result<Vec<ferrum_meta::Package>, ferrum_meta::MetaError> {
    ferrum_meta::catalog::load_embedded(EMBEDDED)
}

/// Registers this app's document hooks, its outbox sink and its web endpoints.
pub fn register(hooks: &mut HookRegistry) {
    hooks
        .register("Form", Arc::new(form::FormHook))
        .register("FormResponse", Arc::new(response::ResponseHook))
        .add_event_sink(Arc::new(response::FormsSink))
        .add_site(PACKAGE, Arc::new(site::FormsSite));
}

/// This app's reports.
pub fn reports() -> Vec<Arc<dyn ReportSource>> {
    vec![Arc::new(reports::FormsReports)]
}

/// Periodic upkeep: every minute, on one replica at a time (advisory lock); must be idempotent and cheap.
pub async fn maintenance(k: &Kernel) -> Result<()> {
    upkeep::run(k).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn packages_are_valid() {
        let mut all = ferrum_domain::packages().expect("platform packages");
        all.extend(super::packages().expect("app packages"));
        let catalog = ferrum_meta::Catalog::from_packages(all).unwrap_or_else(|e| panic!("{e}"));
        let schema = ferrum_meta::effective::build(&catalog, &["forms".to_string()], &[], 1).unwrap_or_else(|e| panic!("{e}"));
        assert!(schema.warnings.is_empty(), "{:?}", schema.warnings);
        let form = schema.entity("Form").expect("Form");
        assert_eq!(form.def.actions.len(), 4);
        assert!(schema.entity("FormResponse").is_some_and(|e| e.def.owner_fields == ["form_owner"]));
        assert!(super::MANIFEST.contains("packages: [forms]"));
    }
}
