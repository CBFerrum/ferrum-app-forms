//! Checks a public response must pass besides the form's own traps (the honeypot, the minimum fill time, the signed
//! session token that expires, the rate per address and the optional proof of work). A workspace's captcha provider
//! is added as one of these: an implementation the server registers at start-up (calling the provider through a
//! connection), named by a form's `extra_check`. None ships, and no outside service is called unless a form names one.

use ferrum_kernel::{Kernel, Result};
use std::sync::{Arc, LazyLock, RwLock};
use uuid::Uuid;

/// What a check is given: the form, the proof the respondent's page sent (`check` in the body, a captcha's answer),
/// and the address it came from.
pub struct Presented<'a> {
    pub tenant: Uuid,
    pub form: Uuid,
    pub proof: Option<&'a str>,
    pub client_ip: &'a str,
}

#[async_trait::async_trait]
pub trait Check: Send + Sync {
    /// The name a form's `extra_check` gives.
    fn name(&self) -> &str;
    /// Whether the response may be kept. A provider that cannot be reached answers an error, which refuses it.
    async fn verify(&self, k: &Kernel, p: &Presented<'_>) -> Result<bool>;
}

static CHECKS: LazyLock<RwLock<Vec<Arc<dyn Check>>>> = LazyLock::new(Default::default);

/// Makes a check available to forms on this server (a later one of the same name replaces it).
pub fn register(check: Arc<dyn Check>) {
    if let Ok(mut all) = CHECKS.write() {
        all.retain(|c| c.name() != check.name());
        all.push(check);
    }
}

/// The check of that name, if the server has one.
pub fn find(name: &str) -> Option<Arc<dyn Check>> {
    CHECKS.read().ok()?.iter().find(|c| c.name() == name).cloned()
}
