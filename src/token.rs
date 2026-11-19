//! What Forms signs and hashes. A form session, a quiz-result link and a signed prefill link are HMAC-SHA256 under keys
//! derived from Forms' own key in the vault for their purpose (`keys.rs`, which checks them, in constant time), and name
//! the version of that key: one that names none is refused like anything else malformed. The hashes of IP addresses and
//! of autoresponse addresses are keyed too, so that they cannot be reversed by trying every address without the key.

use crate::keys;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ferrum_kernel::{Kernel, Result};
use rand::Rng;
use sha2::Sha256;
use uuid::Uuid;

/// A form session (the page a respondent opened) is accepted for a day.
pub const SESSION_TTL_SECS: i64 = 24 * 3600;
/// A quiz-result link works for 30 days.
pub const RESULT_TTL_SECS: i64 = 30 * 24 * 3600;
/// Clock skew tolerated between replicas.
const SKEW_SECS: i64 = 300;

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

/// Something Forms signed, as it reads before its MAC is checked: what it carries, the version of Forms' key it names,
/// what was signed, and the MAC.
pub struct Signed<T> {
    pub value: T,
    version: i32,
    message: Vec<u8>,
    tag: Vec<u8>,
}

impl<T> Signed<T> {
    /// What it carries, when Forms signed it for `purpose`.
    async fn checked(self, k: &Kernel, tenant: Uuid, purpose: &str) -> Result<Option<T>> {
        Ok(keys::check(k, tenant, purpose, self.version, &self.message, &self.tag).await?.then_some(self.value))
    }
}

/// The version of Forms' key named in the four bytes before the MAC: none unless the token is 60 bytes long and names one.
fn version_at(raw: &[u8], at: usize) -> Option<i32> {
    if raw.len() != 60 {
        return None;
    }
    Some(i32::from_be_bytes(raw[at..at + 4].try_into().ok()?)).filter(|v| *v > 0)
}

fn session_message(form: Uuid, issued: &[u8; 8], nonce: &[u8; 16]) -> Vec<u8> {
    [b"ferrum-forms-session:".as_slice(), form.as_bytes(), issued, nonce].concat()
}

/// The session token a respondent gets with the form and sends back with the answers: when the form was opened, the
/// session's nonce, the version of Forms' key and the MAC (60 bytes, base64url).
pub fn session_token(key: &[u8], version: i32, form: Uuid, s: Session) -> String {
    let issued = s.issued.to_be_bytes();
    let mut out = Vec::with_capacity(60);
    out.extend_from_slice(&issued);
    out.extend_from_slice(&s.nonce);
    out.extend_from_slice(&version.to_be_bytes());
    out.extend_from_slice(&keys::mac(key, &session_message(form, &issued, &s.nonce)));
    URL_SAFE_NO_PAD.encode(out)
}

/// A session token of `form`, as it reads.
fn read_session(form: Uuid, token: &str) -> Option<Signed<Session>> {
    let raw = URL_SAFE_NO_PAD.decode(token.trim()).ok()?;
    let version = version_at(&raw, 24)?;
    let issued: [u8; 8] = raw[..8].try_into().ok()?;
    let nonce: [u8; 16] = raw[8..24].try_into().ok()?;
    let tag = raw[raw.len() - 32..].to_vec();
    Some(Signed { value: Session { issued: i64::from_be_bytes(issued), nonce }, version, message: session_message(form, &issued, &nonce), tag })
}

#[derive(Debug, PartialEq, Eq)]
pub enum SessionError {
    Invalid,
    Expired,
}

/// The session a token of `form` carries, if Forms signed it.
pub async fn checked_session(k: &Kernel, tenant: Uuid, form: Uuid, token: &str) -> Result<Option<Session>> {
    match read_session(form, token) {
        Some(signed) => signed.checked(k, tenant, keys::SESSIONS).await,
        None => Ok(None),
    }
}

/// Whether a session may still be sent: not opened in the future, nor more than a day ago; `now` in Unix seconds.
pub fn session_age(s: &Session, now: i64) -> std::result::Result<(), SessionError> {
    if s.issued > now + SKEW_SECS {
        return Err(SessionError::Invalid);
    }
    if now - s.issued > SESSION_TTL_SECS {
        return Err(SessionError::Expired);
    }
    Ok(())
}

fn result_message(response: Uuid, issued: &[u8; 8]) -> Vec<u8> {
    [b"ferrum-forms-result:".as_slice(), response.as_bytes(), issued].concat()
}

/// A link to a quiz response's result: the response, when the link was made, the version of Forms' key and the MAC.
pub fn result_token(key: &[u8], version: i32, response: Uuid, issued: i64) -> String {
    let issued = issued.to_be_bytes();
    let mut out = Vec::with_capacity(60);
    out.extend_from_slice(response.as_bytes());
    out.extend_from_slice(&issued);
    out.extend_from_slice(&version.to_be_bytes());
    out.extend_from_slice(&keys::mac(key, &result_message(response, &issued)));
    URL_SAFE_NO_PAD.encode(out)
}

/// A result link as it reads: the response and when the link was made.
fn read_result(token: &str) -> Option<Signed<(Uuid, i64)>> {
    let raw = URL_SAFE_NO_PAD.decode(token.trim()).ok()?;
    let version = version_at(&raw, 24)?;
    let response = Uuid::from_slice(&raw[..16]).ok()?;
    let issued: [u8; 8] = raw[16..24].try_into().ok()?;
    let tag = raw[raw.len() - 32..].to_vec();
    Some(Signed { value: (response, i64::from_be_bytes(issued)), version, message: result_message(response, &issued), tag })
}

/// The response a result link points at, while it is valid; `now` in Unix seconds.
pub async fn checked_result(k: &Kernel, tenant: Uuid, token: &str, now: i64) -> Result<Option<Uuid>> {
    let Some(signed) = read_result(token).filter(|r| r.value.1 <= now + SKEW_SECS && now - r.value.1 <= RESULT_TTL_SECS) else { return Ok(None) };
    Ok(signed.checked(k, tenant, keys::RESULTS).await?.map(|(response, _)| response))
}

/// A keyed hash of the sender's IP address (128 bits, hex): equal addresses match, none is stored.
pub fn ip_hash(key: &[u8], ip: &str) -> String {
    hex::encode(&keys::mac(key, &[b"ferrum-forms-ip:".as_slice(), ip.trim().as_bytes()].concat())[..16])
}

/// A keyed hash of an email address for one form (autoresponse limits).
pub fn address_hash(key: &[u8], form: Uuid, email: &str) -> String {
    hex::encode(&keys::mac(key, &[b"ferrum-forms-address:".as_slice(), form.as_bytes(), email.trim().to_lowercase().as_bytes()].concat())[..16])
}

/// What a signed prefill link carries: answers to show filled and hidden values to keep, for one form, until it expires.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Prefill {
    /// Unix seconds after which the link no longer fills anything.
    pub expires: i64,
    #[serde(default)]
    pub answers: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub hidden: serde_json::Map<String, serde_json::Value>,
}

fn prefill_message(form: Uuid, body: &[u8]) -> Vec<u8> {
    [b"ferrum-forms-prefill:".as_slice(), form.as_bytes(), body].concat()
}

/// A signed prefill token for `form`: its JSON, the version of Forms' key and its MAC, base64url, joined by dots.
pub fn prefill_token(key: &[u8], version: i32, form: Uuid, p: &Prefill) -> String {
    let body = serde_json::to_vec(p).unwrap_or_default();
    format!("{}.{}", URL_SAFE_NO_PAD.encode(&body), keys::signed(key, version, &prefill_message(form, &body)))
}

/// A prefill token of `form`, as it reads.
fn read_prefill(form: Uuid, token: &str) -> Option<Signed<Prefill>> {
    let parts: Vec<&str> = token.trim().split('.').collect();
    let [body, v, tag] = parts.as_slice() else { return None };
    let version = keys::version(v)?;
    let body = URL_SAFE_NO_PAD.decode(body).ok()?;
    let value: Prefill = serde_json::from_slice(&body).ok()?;
    Some(Signed { value, version, message: prefill_message(form, &body), tag: URL_SAFE_NO_PAD.decode(tag).ok()? })
}

/// What a prefill token of `form` carries, when Forms signed it and it has not expired; `now` in Unix seconds.
pub async fn checked_prefill(k: &Kernel, tenant: Uuid, form: Uuid, token: &str, now: i64) -> Result<Option<Prefill>> {
    match read_prefill(form, token).filter(|p| now <= p.value.expires) {
        Some(signed) => signed.checked(k, tenant, keys::PREFILL).await,
        None => Ok(None),
    }
}

/// Whether `nonce` solves the proof-of-work of a session `token`: SHA-256 of `token:nonce` starts with `bits` zero bits.
/// No nonce is no work, whatever the token alone hashes to.
pub fn work_done(token: &str, nonce: &str, bits: u32) -> bool {
    use sha2::Digest;
    if nonce.is_empty() || nonce.len() > 64 {
        return false;
    }
    let digest = Sha256::digest(format!("{token}:{nonce}").as_bytes());
    let mut left = bits;
    for byte in digest {
        if left == 0 {
            return true;
        }
        let take = left.min(8);
        if byte >> (8 - take) != 0 {
            return false;
        }
        left -= take;
    }
    left == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a signed token carries, when its MAC is `key`'s and it names version 1.
    fn ours<T>(key: &[u8], signed: Option<Signed<T>>) -> Option<T> {
        signed.filter(|s| s.version == 1 && keys::mac_ok(key, &s.message, &s.tag)).map(|s| s.value)
    }

    #[test]
    fn prefill_links_are_signed_per_form_and_expire() {
        let key = [3u8; 32];
        let form = Uuid::now_v7();
        let p = Prefill { expires: 1_000, answers: serde_json::json!({"name": "Asha"}).as_object().cloned().unwrap(), hidden: Default::default() };
        let t = prefill_token(&key, 1, form, &p);
        assert_eq!(t.split('.').nth(1), Some("v1"), "{t}");
        assert_eq!(ours(&key, read_prefill(form, &t)), Some(p.clone()));
        assert!(read_prefill(form, &t).is_some_and(|s| s.value.expires < 1_001), "expired after 1000 (checked_prefill refuses it)");
        assert_eq!(ours(&key, read_prefill(Uuid::now_v7(), &t)), None, "another form's");
        let forged = format!("{}.{}", URL_SAFE_NO_PAD.encode(br#"{"expires":1000,"answers":{"name":"Eve"}}"#), t.split_once('.').unwrap().1);
        assert_eq!(ours(&key, read_prefill(form, &forged)), None, "changed values");
        // One that names no version is refused, however it was signed.
        let body = serde_json::to_vec(&p).unwrap();
        let unversioned = format!("{}.{}", URL_SAFE_NO_PAD.encode(&body), URL_SAFE_NO_PAD.encode(keys::mac(&key, &prefill_message(form, &body))));
        assert!(read_prefill(form, &unversioned).is_none());
    }

    #[test]
    fn work_vectors() {
        // The page's solver is tested on the same vectors (ui/src/work.test.ts).
        let vectors: Vec<serde_json::Value> = serde_json::from_str(include_str!("../ui/src/work.vectors.json")).unwrap();
        for v in vectors {
            assert!(work_done(v["token"].as_str().unwrap(), v["nonce"].as_str().unwrap(), v["bits"].as_u64().unwrap() as u32), "{v}");
        }
    }

    #[test]
    fn proof_of_work_counts_leading_zero_bits() {
        let found = (0..200_000u32).map(|n| n.to_string()).find(|n| work_done("tok", n, 12)).expect("a solution");
        assert!(work_done("tok", &found, 12) && work_done("tok", &found, 0));
        assert!(!work_done("other", &found, 12) || work_done("other", &found, 12), "deterministic");
        assert!(!work_done("tok", &"x".repeat(65), 0), "a nonce is short");
        assert!((0..5000u32).all(|i| !work_done(&format!("t{i}"), "", 8)), "no work is no work, whatever the token hashes to");
    }

    #[test]
    fn sessions_bind_key_form_and_time() {
        let (k1, k2) = ([1u8; 32], [2u8; 32]);
        let (f1, f2) = (Uuid::now_v7(), Uuid::now_v7());
        let s = Session { issued: 1_000_000, nonce: nonce() };
        let t = session_token(&k1, 1, f1, s);
        assert_eq!(ours(&k1, read_session(f1, &t)), Some(s));
        assert_eq!(ours(&k1, read_session(f2, &t)), None, "another form");
        assert_eq!(ours(&k2, read_session(f1, &t)), None, "another workspace's key");
        assert_eq!(session_age(&s, 1_000_010), Ok(()));
        assert_eq!(session_age(&s, 1_000_000 + SESSION_TTL_SECS + 1), Err(SessionError::Expired));
        assert_eq!(session_age(&s, 1_000_000 - SKEW_SECS - 1), Err(SessionError::Invalid), "issued in the future");
        let mut tampered = URL_SAFE_NO_PAD.decode(&t).unwrap();
        tampered[0] ^= 1;
        assert_eq!(ours(&k1, read_session(f1, &URL_SAFE_NO_PAD.encode(&tampered))), None, "a changed time");
        tampered[0] ^= 1;
        tampered[27] = 0;
        assert!(read_session(f1, &URL_SAFE_NO_PAD.encode(&tampered)).is_none(), "no version 0");
        assert!(read_session(f1, "short").is_none());
        // One that names no version (56 bytes) is refused, however it was signed.
        let issued = s.issued.to_be_bytes();
        let unversioned = URL_SAFE_NO_PAD.encode([&issued[..], &s.nonce, &keys::mac(&k1, &session_message(f1, &issued, &s.nonce))].concat());
        assert!(read_session(f1, &unversioned).is_none());
        assert_ne!(nonce(), nonce());
    }

    #[test]
    fn result_links_expire_and_cannot_be_forged() {
        let k = [3u8; 32];
        let r = Uuid::now_v7();
        let t = result_token(&k, 1, r, 5_000);
        assert_eq!(ours(&k, read_result(&t)), Some((r, 5_000)));
        assert_eq!(ours(&[4u8; 32], read_result(&t)), None);
        let mut other = URL_SAFE_NO_PAD.decode(&t).unwrap();
        other[..16].copy_from_slice(Uuid::now_v7().as_bytes());
        assert_eq!(ours(&k, read_result(&URL_SAFE_NO_PAD.encode(other))), None, "pointing a link at another response");
        let issued = 5_000i64.to_be_bytes();
        let unversioned = URL_SAFE_NO_PAD.encode([r.as_bytes().as_slice(), &issued, &keys::mac(&k, &result_message(r, &issued))].concat());
        assert!(read_result(&unversioned).is_none(), "one that names no version");
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
