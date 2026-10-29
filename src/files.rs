//! What respondents may upload: a closed list of document and image types, recognized by the
//! file name's extension and confirmed by the file's first bytes, so a renamed executable or
//! script is refused. The stored content type comes from this list, never from the client.

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use serde_json::Value;

/// Largest single file, in MB.
pub const MAX_FILE_MB: usize = 20;

#[derive(Debug)]
enum Magic {
    Prefix(&'static [u8]),
    /// RIFF....WEBP
    Webp,
    /// A ZIP container (Office Open XML, OpenDocument, zip).
    Zip,
    /// An OLE2 compound file (legacy Office).
    Ole,
    /// UTF-8 text without NUL bytes.
    Text,
}

#[derive(Debug)]
pub struct FileType {
    pub ext: &'static str,
    pub mime: &'static str,
    magic: Magic,
    /// Accepted when a question does not list its own types.
    default: bool,
}

const fn t(ext: &'static str, mime: &'static str, magic: Magic, default: bool) -> FileType {
    FileType { ext, mime, magic, default }
}

const ZIP: &[u8] = b"PK\x03\x04";
const OLE: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

pub static TYPES: [FileType; 17] = [
    t("pdf", "application/pdf", Magic::Prefix(b"%PDF-"), true),
    t("png", "image/png", Magic::Prefix(b"\x89PNG\r\n\x1a\n"), true),
    t("jpg", "image/jpeg", Magic::Prefix(&[0xFF, 0xD8, 0xFF]), true),
    t("jpeg", "image/jpeg", Magic::Prefix(&[0xFF, 0xD8, 0xFF]), true),
    t("gif", "image/gif", Magic::Prefix(b"GIF8"), true),
    t("webp", "image/webp", Magic::Webp, true),
    t("txt", "text/plain", Magic::Text, true),
    t("csv", "text/csv", Magic::Text, true),
    t("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Magic::Zip, true),
    t("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Magic::Zip, true),
    t("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", Magic::Zip, true),
    t("odt", "application/vnd.oasis.opendocument.text", Magic::Zip, true),
    t("ods", "application/vnd.oasis.opendocument.spreadsheet", Magic::Zip, true),
    t("doc", "application/msword", Magic::Ole, true),
    t("xls", "application/vnd.ms-excel", Magic::Ole, true),
    t("ppt", "application/vnd.ms-powerpoint", Magic::Ole, true),
    // Archives can carry anything: only when a question asks for them.
    t("zip", "application/zip", Magic::Zip, false),
];

pub fn by_ext(ext: &str) -> Option<&'static FileType> {
    TYPES.iter().find(|t| t.ext == ext)
}

/// A question's accepted types from "pdf, .png jpg" (empty: the default list).
pub fn parse_accept(s: &str) -> Result<Vec<&'static FileType>, String> {
    let mut out: Vec<&'static FileType> = Vec::new();
    for part in s.split(|c: char| c == ',' || c == ';' || c.is_whitespace()).map(|p| p.trim().trim_start_matches('.').to_lowercase()) {
        if part.is_empty() {
            continue;
        }
        let ty = by_ext(&part)
            .ok_or_else(|| format!("'{part}' files cannot be accepted; choose from {}", TYPES.iter().map(|t| t.ext).collect::<Vec<_>>().join(", ")))?;
        if !out.iter().any(|x| x.ext == ty.ext) {
            out.push(ty);
        }
    }
    if out.is_empty() {
        out = TYPES.iter().filter(|t| t.default).collect();
    }
    Ok(out)
}

/// The file name as stored: no control characters or path separators, at most 200 characters.
pub fn clean_name(name: &str) -> String {
    let n: String = name.chars().filter(|c| !c.is_control() && *c != '/' && *c != '\\').take(200).collect();
    n.trim().to_string()
}

pub fn extension(name: &str) -> Option<String> {
    name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).filter(|e| !e.is_empty() && e.len() <= 10)
}

/// Whether `data` really is a file of type `t`.
pub fn content_matches(t: &FileType, data: &[u8]) -> bool {
    match &t.magic {
        Magic::Prefix(p) => data.starts_with(p),
        Magic::Webp => data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP",
        Magic::Zip => data.starts_with(ZIP),
        Magic::Ole => data.starts_with(OLE),
        Magic::Text => !data.contains(&0) && std::str::from_utf8(data.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(data)).is_ok(),
    }
}

/// One uploaded file of an answer: `{file_name, content_base64}` (a `data:` URL is accepted too).
/// Size is checked before decoding.
pub fn decode(v: &Value, max_bytes: usize) -> Result<(String, Vec<u8>), String> {
    let m = v.as_object().ok_or("each file is an object with file_name and content_base64")?;
    let name = clean_name(m.get("file_name").and_then(Value::as_str).unwrap_or_default());
    if name.is_empty() {
        return Err("each file needs its file_name".into());
    }
    let raw = m.get("content_base64").and_then(Value::as_str).ok_or("each file needs its content_base64")?;
    let raw = match raw.strip_prefix("data:") {
        Some(rest) => rest.split_once(";base64,").map(|(_, d)| d).ok_or("a data URL must be base64-encoded")?,
        None => raw,
    };
    // Four base64 characters carry three bytes: refuse oversized files without decoding them.
    let approx = raw.len() / 4 * 3;
    if approx > max_bytes + 3 {
        return Err(format!("{name} is larger than {} MB", max_bytes >> 20));
    }
    let compact: String = raw.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let data =
        STANDARD.decode(&compact).or_else(|_| STANDARD_NO_PAD.decode(compact.trim_end_matches('='))).map_err(|_| format!("{name} is not valid base64"))?;
    if data.is_empty() {
        return Err(format!("{name} is empty"));
    }
    if data.len() > max_bytes {
        return Err(format!("{name} is larger than {} MB", max_bytes >> 20));
    }
    Ok((name, data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn types_are_recognized_by_name_and_content() {
        let pdf = by_ext("pdf").unwrap();
        assert!(content_matches(pdf, b"%PDF-1.7 ..."));
        assert!(!content_matches(pdf, b"MZ\x90\x00 an executable"), "a renamed executable is not a PDF");
        assert!(content_matches(by_ext("webp").unwrap(), b"RIFF\x10\x00\x00\x00WEBPVP8 "));
        assert!(content_matches(by_ext("docx").unwrap(), b"PK\x03\x04rest"));
        assert!(content_matches(by_ext("csv").unwrap(), "\u{feff}a,b\n1,2".as_bytes()));
        assert!(!content_matches(by_ext("txt").unwrap(), b"a\x00b"));
        assert_eq!(extension("Report.Final.PDF").as_deref(), Some("pdf"));
        assert_eq!(extension("README"), None);
        assert_eq!(clean_name("../../etc/pa\u{0}sswd"), "....etcpasswd");
    }

    #[test]
    fn accept_lists() {
        let list = parse_accept(".PDF, png;jpg").unwrap();
        assert_eq!(list.iter().map(|t| t.ext).collect::<Vec<_>>(), ["pdf", "png", "jpg"]);
        assert!(parse_accept("exe").unwrap_err().contains("'exe'"));
        let defaults = parse_accept("").unwrap();
        assert!(defaults.iter().any(|t| t.ext == "pdf") && !defaults.iter().any(|t| t.ext == "zip"));
    }

    #[test]
    fn decoding_checks_size_before_and_after() {
        let ok = json!({"file_name": "a.txt", "content_base64": STANDARD.encode(b"hello")});
        assert_eq!(decode(&ok, 1024).unwrap(), ("a.txt".to_string(), b"hello".to_vec()));
        let url = json!({"file_name": "a.txt", "content_base64": format!("data:text/plain;base64,{}", STANDARD.encode(b"hi"))});
        assert_eq!(decode(&url, 1024).unwrap().1, b"hi");
        let big = json!({"file_name": "big.txt", "content_base64": STANDARD.encode(vec![b'a'; 2048])});
        assert!(decode(&big, 1024).unwrap_err().contains("larger than"));
        assert!(decode(&json!({"file_name": "x.txt", "content_base64": "!!!"}), 1024).unwrap_err().contains("base64"));
        assert!(decode(&json!({"content_base64": "aGk="}), 1024).unwrap_err().contains("file_name"));
    }
}
