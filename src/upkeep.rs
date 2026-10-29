//! Every-minute upkeep, per workspace with Forms: close forms whose closing time passed, delete
//! spam older than the retention, forget autoresponse throttles older than two days. Each step
//! is bounded and idempotent; a failing workspace or step does not stop the others.

use crate::engine;
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result};
use serde_json::json;
use uuid::Uuid;

/// Spam responses deleted per workspace and round.
const SPAM_BATCH: i64 = 200;
const DEFAULT_SPAM_DAYS: i64 = 30;

pub async fn run(k: &Kernel) -> Result<()> {
    let mut tx = k.db.system_tx().await?;
    let tenants: Vec<Uuid> = sqlx::query_scalar("select id from tenant where status = 'active' order by id").fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let mut first_error: Option<Error> = None;
    for tenant in tenants {
        let schema = match k.registry.schema(tenant).await {
            Ok(s) if s.packages.iter().any(|p| p == crate::PACKAGE) => s,
            Ok(_) => continue,
            Err(e) => {
                first_error.get_or_insert(e);
                continue;
            }
        };
        let sys = engine(tenant, schema);
        let steps = [("closing", close_due(k, &sys).await), ("spam", purge_spam(k, &sys).await), ("autoresponses", forget_throttles(k, &sys).await)];
        for (step, outcome) in steps {
            match outcome {
                Ok(n) if n > 0 => tracing::info!(%tenant, step, n, "forms maintenance"),
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(%tenant, step, "forms maintenance failed: {e}");
                    first_error.get_or_insert(e);
                }
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Published forms past their closing time show as Closed.
async fn close_due(k: &Kernel, sys: &Ctx) -> Result<u64> {
    let mut tx = k.db.tenant_tx(sys.tenant).await?;
    let due: Vec<Uuid> = sqlx::query_scalar(
        "select id from e_form where tenant_id = $1 and status = 'Published' and closes_at <= now() order by id limit 500 for update skip locked",
    )
    .bind(sys.tenant)
    .fetch_all(&mut *tx)
    .await?;
    for form in &due {
        let mut v = Doc::new();
        v.insert("status".into(), json!("Closed"));
        k.set_values_tx(sys, &mut tx, "Form", *form, v).await?;
    }
    tx.commit().await?;
    Ok(due.len() as u64)
}

async fn purge_spam(k: &Kernel, sys: &Ctx) -> Result<u64> {
    let mut tx = k.db.tenant_tx(sys.tenant).await?;
    let days: Option<i64> = sqlx::query_scalar("select spam_retention_days from e_forms_settings where tenant_id = $1 limit 1")
        .bind(sys.tenant)
        .fetch_optional(&mut *tx)
        .await?
        .flatten();
    let old: Vec<Uuid> = sqlx::query_scalar(
        "select id from e_form_response where tenant_id = $1 and status = 'Spam' and created_at < now() - make_interval(days => $2::int) \
         order by created_at limit $3",
    )
    .bind(sys.tenant)
    .bind(days.unwrap_or(DEFAULT_SPAM_DAYS).clamp(1, 3650))
    .bind(SPAM_BATCH)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut deleted = 0;
    for rid in old {
        match k.delete(sys, "FormResponse", rid, None).await {
            Ok(()) => deleted += 1,
            // Deleted meanwhile (by its owner or another replica's round).
            Err(Error::NotFound(_)) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(deleted)
}

async fn forget_throttles(k: &Kernel, sys: &Ctx) -> Result<u64> {
    let mut tx = k.db.tenant_tx(sys.tenant).await?;
    let n = sqlx::query("delete from forms_autoresponse where tenant_id = $1 and sent_at < now() - interval '2 days'")
        .bind(sys.tenant)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;
    Ok(n)
}
