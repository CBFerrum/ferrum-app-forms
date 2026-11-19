//! Form templates: starting points kept as records (a contact form, an event registration, a feedback survey, a quiz,
//! the survey kinds), so a workspace can add its own and a person or an agent can list them and make a form from one.
//! Their questions are checked as a form's are; making a form copies them into a Draft the caller owns.

use crate::answers::zone;
use crate::model::Definition;
use async_trait::async_trait;
use ferrum_domain::util::{rows, s};
use ferrum_kernel::{Action, Doc, DocHook, Error, HookCtx, Result};
use serde_json::{Value, json};

/// What a template gives the form made from it, besides its questions.
const COPIED: [&str; 6] = ["kind", "description", "layout", "confirmation_message", "passing_score", "reveal_answers"];

pub struct TemplateHook;

#[async_trait]
impl DocHook for TemplateHook {
    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let quiz = s(doc, "kind") == Some("Quiz");
        let (_, errors) = Definition::parse(&rows(doc, "questions"), zone(&hc.ctx.schema.timezone), quiz);
        if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        if name != "use_template" {
            return Ok(None);
        }
        // The form is the caller's: made with their rights, owned by them.
        hc.ctx.require("Form", Action::Create)?;
        let ent = hc.kernel.entity(hc.ctx, "FormTemplate")?;
        let copy = ferrum_kernel::doc::copy_for_new(&ent, &hc.ctx.schema, doc);
        let title = params.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).or_else(|| s(doc, "template_name")).unwrap_or("Form");
        let mut form = Doc::new();
        form.insert("title".into(), json!(title.chars().take(200).collect::<String>()));
        for k in COPIED.iter().chain(["questions"].iter()) {
            if let Some(v) = copy.get(*k).filter(|v| !v.is_null()) {
                form.insert((*k).into(), v.clone());
            }
        }
        let made = hc.kernel.insert_tx(hc.ctx, hc.tx, "Form", form).await?;
        Ok(Some(json!({"entity": "Form", "id": made.get("id"), "slug": made.get("slug")})))
    }
}
