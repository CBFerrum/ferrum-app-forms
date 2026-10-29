//! Secrets of the forms. A per-workspace key, kept in `forms_secret` outside every entity (so no
//! API, export or audit trail can reveal it), signs form sessions and quiz-result links with
//! HMAC-SHA256 — checked in constant time — and keys the hashes of IP addresses and autoresponse
//! addresses, so they cannot be reversed by trying every address without it.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ferrum_kernel::{Error, Result, Tx};
use hmac::{Hmac, Mac};
use rand::Rng;
use sha2::Sha256;
use uuid::Uuid;

/// A form session (the page a respondent opened) is accepted for a day.
pub const SESSION_TTL_SECS: i64 = 24 * 3600;
/// A quiz-result link works for 30 days.
pub const RESULT_TTL_SECS: i64 = 30 * 24 * 3600;
/// Clock skew tolerated between replicas.
const SKEW_SECS: i64 = 300;

pub type Key = [u8; 32];

/// The workspace's key, created on first use.
pub async fn key(tx: &mut Tx, tenant: Uuid) -> Result<Key> {
    let read = |v: Vec<u8>| -> Result<Key> { v.try_into().map_err(|_| Error::internal("forms key has the wrong length")) };
    let existing: Option<Vec<u8>> = sqlx::query_scalar("select secret from forms_secret where tenant_id = $1").bind(tenant).fetch_optional(&mut **tx).await?;
    if let Some(k) = existing {
        return read(k);
    }
    let mut fresh = [0u8; 32];
    rand::rng().fill(&mut fresh);
    sqlx::query("insert into forms_secret (tenant_id, secret) values ($1, $2) on conflict do nothing").bind(tenant).bind(&fresh[..]).execute(&mut **tx).await?;
    read(sqlx::query_scalar("select secret from forms_secret where tenant_id = $1").bind(tenant).fetch_one(&mut **tx).await?)
}

fn mac(key: &Key, domain: &[u8], parts: &[&[u8]]) -> Hmac<Sha256> {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes keys of any length");
    m.update(domain);
    for p in parts {
        m.update(p);
    }
    m
}

pub fn nonce() -> [u8; 16] {
    let mut n = [0u8; 16];
    rand::rng().fill(&mut n);
    n
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Session {
    /// Unix seconds when the form was opened.
    pub issued: i64,
    pub nonce: [u8; 16],
}

impl Session {
    /// Stored with the response: a second submit of the same session is a replay.
    pub fn id(&self) -> String {
        hex::encode(self.nonce)
    }
}

/// The session token a respondent gets with the form and sends back with the answers.
pub fn session_token(key: &Key, form: Uuid, s: Session) -> String {
    let issued = s.issued.to_be_bytes();
    let tag = mac(key, b"ferrum-forms-session:", &[form.as_bytes(), &issued, &s.nonce]).finalize().into_bytes();
    let mut out = Vec::with_capacity(56);
    out.extend_from_slice(&issued);
    out.extend_from_slice(&s.nonce);
    out.extend_from_slice(&tag);
    URL_SAFE_NO_PAD.encode(out)
}

#[derive(Debug, PartialEq, Eq)]
pub enum SessionError {
    Invalid,
    Expired,
}

/// Reads a session token of `form`; `now` in Unix seconds.
pub fn read_session(key: &Key, form: Uuid, token: &str, now: i64) -> std::result::Result<Session, SessionError> {
    let raw = URL_SAFE_NO_PAD.decode(token.trim()).map_err(|_| SessionError::Invalid)?;
    if raw.len() != 56 {
        return Err(SessionError::Invalid);
    }
    let issued_bytes: [u8; 8] = raw[..8].try_into().map_err(|_| SessionError::Invalid)?;
    let nonce: [u8; 16] = raw[8..24].try_into().map_err(|_| SessionError::Invalid)?;
    mac(key, b"ferrum-forms-session:", &[form.as_bytes(), &issued_bytes, &nonce]).verify_slice(&raw[24..]).map_err(|_| SessionError::Invalid)?;
    let issued = i64::from_be_bytes(issued_bytes);
    if issued > now + SKEW_SECS {
        return Err(SessionError::Invalid);
    }
    if now - issued > SESSION_TTL_SECS {
        return Err(SessionError::Expired);
    }
    Ok(Session { issued, nonce })
}

/// A link to a quiz response's result.
pub fn result_token(key: &Key, response: Uuid, issued: i64) -> String {
    let issued = issued.to_be_bytes();
    let tag = mac(key, b"ferrum-forms-result:", &[response.as_bytes(), &issued]).finalize().into_bytes();
    let mut out = Vec::with_capacity(56);
    out.extend_from_slice(response.as_bytes());
    out.extend_from_slice(&issued);
    out.extend_from_slice(&tag);
    URL_SAFE_NO_PAD.encode(out)
}

/// The response a result link points at, while it is valid.
pub fn read_result(key: &Key, token: &str, now: i64) -> Option<Uuid> {
    let raw = URL_SAFE_NO_PAD.decode(token.trim()).ok()?;
    if raw.len() != 56 {
        return None;
    }
    let response = Uuid::from_slice(&raw[..16]).ok()?;
    let issued_bytes: [u8; 8] = raw[16..24].try_into().ok()?;
    mac(key, b"ferrum-forms-result:", &[response.as_bytes(), &issued_bytes]).verify_slice(&raw[24..]).ok()?;
    let issued = i64::from_be_bytes(issued_bytes);
    (issued <= now + SKEW_SECS && now - issued <= RESULT_TTL_SECS).then_some(response)
}

/// A keyed hash of the sender's IP address (128 bits, hex): equal addresses match, none is stored.
pub fn ip_hash(key: &Key, ip: &str) -> String {
    hex::encode(&mac(key, b"ferrum-forms-ip:", &[ip.trim().as_bytes()]).finalize().into_bytes()[..16])
}

/// A keyed hash of an email address for one form (autoresponse limits).
pub fn address_hash(key: &Key, form: Uuid, email: &str) -> String {
    hex::encode(&mac(key, b"ferrum-forms-address:", &[form.as_bytes(), email.trim().to_lowercase().as_bytes()]).finalize().into_bytes()[..16])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_bind_key_form_and_time() {
        let (k1, k2) = ([1u8; 32], [2u8; 32]);
        let (f1, f2) = (Uuid::now_v7(), Uuid::now_v7());
        let s = Session { issued: 1_000_000, nonce: nonce() };
        let t = session_token(&k1, f1, s);
        assert_eq!(read_session(&k1, f1, &t, 1_000_010), Ok(s));
        assert_eq!(read_session(&k1, f2, &t, 1_000_010), Err(SessionError::Invalid), "another form");
        assert_eq!(read_session(&k2, f1, &t, 1_000_010), Err(SessionError::Invalid), "another workspace's key");
        assert_eq!(read_session(&k1, f1, &t, 1_000_000 + SESSION_TTL_SECS + 1), Err(SessionError::Expired));
        assert_eq!(read_session(&k1, f1, &t, 1_000_000 - SKEW_SECS - 1), Err(SessionError::Invalid), "issued in the future");
        let mut tampered = URL_SAFE_NO_PAD.decode(&t).unwrap();
        tampered[0] ^= 1;
        assert_eq!(read_session(&k1, f1, &URL_SAFE_NO_PAD.encode(tampered), 1_000_010), Err(SessionError::Invalid), "a changed time");
        assert_eq!(read_session(&k1, f1, "short", 1_000_010), Err(SessionError::Invalid));
        assert_ne!(nonce(), nonce());
    }

    #[test]
    fn result_links_expire_and_cannot_be_forged() {
        let k = [3u8; 32];
        let r = Uuid::now_v7();
        let t = result_token(&k, r, 5_000);
        assert_eq!(read_result(&k, &t, 5_100), Some(r));
        assert_eq!(read_result(&k, &t, 5_000 + RESULT_TTL_SECS + 1), None);
        assert_eq!(read_result(&[4u8; 32], &t, 5_100), None);
        let mut other = URL_SAFE_NO_PAD.decode(&t).unwrap();
        other[..16].copy_from_slice(Uuid::now_v7().as_bytes());
        assert_eq!(read_result(&k, &URL_SAFE_NO_PAD.encode(other), 5_100), None, "pointing a link at another response");
    }

    #[test]
    fn hashes_are_keyed_and_stable() {
        let (k1, k2) = ([5u8; 32], [6u8; 32]);
        assert_eq!(ip_hash(&k1, "203.0.113.7"), ip_hash(&k1, " 203.0.113.7 "));
        assert_ne!(ip_hash(&k1, "203.0.113.7"), ip_hash(&k2, "203.0.113.7"));
        assert_eq!(ip_hash(&k1, "203.0.113.7").len(), 32);
        let f = Uuid::now_v7();
        assert_eq!(address_hash(&k1, f, "A@x.test"), address_hash(&k1, f, "a@x.test"));
        assert_ne!(address_hash(&k1, f, "a@x.test"), address_hash(&k1, Uuid::now_v7(), "a@x.test"));
    }
}
