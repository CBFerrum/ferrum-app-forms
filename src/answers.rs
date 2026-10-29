//! Answers: every value a respondent sends is checked and normalized on the server against the
//! form's definition — the client is never trusted. Questions hidden by conditional logic are not
//! required and their answers are dropped. Quiz grading works on the normalized answers.

use crate::files;
use crate::logic::Vars;
use crate::model::{Definition, Kind, OPTION_MAX_CHARS, Question, Range};
use chrono::offset::LocalResult;
use chrono::{DateTime, NaiveDateTime, NaiveTime, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use ferrum_kernel::FieldError;
use ferrum_kernel::value::{decimal_value, normalize as normalize_field, parse_date, parse_decimal};
use ferrum_meta::FieldDef;
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use serde_json::{Map, Value, json};
use std::str::FromStr;
use std::sync::LazyLock;

/// A file of an answer, checked and waiting to be stored.
#[derive(Debug, Clone)]
pub struct Upload {
    pub key: String,
    pub file_name: String,
    pub content_type: String,
    pub data: Vec<u8>,
}

/// A response's answers after checking: only visible, answered questions.
#[derive(Debug, Clone, Default)]
pub struct Submission {
    pub answers: Map<String, Value>,
    pub uploads: Vec<Upload>,
    /// Per question (in order): shown to this respondent.
    pub visible: Vec<bool>,
}

/// Where the answers are read: the workspace's zone (for date-times without an offset) and the
/// `today` / `now` conditions see.
pub struct Env {
    pub tz: Tz,
    pub today: String,
    pub now: String,
}

impl Env {
    pub fn new(tz: Tz) -> Env {
        let now = Utc::now().with_timezone(&tz);
        Env { tz, today: now.format("%Y-%m-%d").to_string(), now: now.to_rfc3339() }
    }
}

/// The workspace's zone; an unknown one reads as UTC.
pub fn zone(name: &str) -> Tz {
    name.parse().unwrap_or(chrono_tz::UTC)
}

fn field(ftype: &str) -> FieldDef {
    serde_json::from_value(json!({"name": "answer", "type": ftype, "max_length": 254})).expect("field definition")
}

static EMAIL: LazyLock<FieldDef> = LazyLock::new(|| field("email"));
static PHONE: LazyLock<FieldDef> = LazyLock::new(|| field("phone"));

/// An email address as the platform stores them (trimmed, lower-case), `None` when empty.
pub fn email(v: &Value) -> Result<Option<String>, String> {
    match normalize_field(&EMAIL, &json!(text_of(v)?))? {
        Value::String(s) => Ok(Some(s)),
        _ => Ok(None),
    }
}

pub fn parse_time(s: &str) -> Result<NaiveTime, String> {
    let t = s.trim();
    NaiveTime::parse_from_str(t, "%H:%M:%S").or_else(|_| NaiveTime::parse_from_str(t, "%H:%M")).map_err(|_| format!("'{t}' is not a time (HH:MM)"))
}

fn time_value(t: NaiveTime) -> String {
    if chrono::Timelike::second(&t) == 0 { t.format("%H:%M").to_string() } else { t.format("%H:%M:%S").to_string() }
}

/// An instant: RFC 3339 with an offset, or a local date-time read in `tz` — a time the clocks
/// skip is refused, a repeated one is the earlier of the two.
pub fn parse_instant(s: &str, tz: Tz) -> Result<DateTime<Utc>, String> {
    let t = s.trim();
    let checked = |d: DateTime<Utc>| {
        if (1900..=9999).contains(&chrono::Datelike::year(&d)) { Ok(d) } else { Err("date out of range".to_string()) }
    };
    if let Ok(d) = DateTime::parse_from_rfc3339(t) {
        return checked(d.with_timezone(&Utc));
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M"] {
        if let Ok(local) = NaiveDateTime::parse_from_str(t, fmt) {
            return match tz.from_local_datetime(&local) {
                LocalResult::Single(d) => checked(d.with_timezone(&Utc)),
                LocalResult::Ambiguous(earlier, _) => checked(earlier.with_timezone(&Utc)),
                LocalResult::None => Err(format!("{t} does not exist in {tz}: the clocks change then")),
            };
        }
    }
    Err(format!("'{t}' is not a date and time (YYYY-MM-DDTHH:MM)"))
}

pub fn instant_value(d: DateTime<Utc>) -> String {
    d.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Short-text quiz answers compare case-insensitively with single spaces.
pub fn fold(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn text_of(v: &Value) -> Result<String, String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err("must be text".into()),
    }
}

fn int_of(v: &Value) -> Result<i64, String> {
    match v {
        Value::Number(n) => n.as_i64().ok_or_else(|| "must be a whole number".to_string()),
        Value::String(s) => s.trim().parse::<i64>().map_err(|_| "must be a whole number".to_string()),
        _ => Err("must be a whole number".into()),
    }
}

fn single_line(s: &str) -> Result<(), String> {
    if s.chars().any(char::is_control) { Err("must be a single line of text".into()) } else { Ok(()) }
}

fn is_blank(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(m) => m.is_empty(),
        _ => false,
    }
}

fn bound<T: PartialOrd + std::fmt::Display>(v: &T, lo: &Option<T>, hi: &Option<T>, show: impl Fn(&T) -> String) -> Result<(), String> {
    if let Some(lo) = lo
        && v < lo
    {
        return Err(format!("must be at least {}", show(lo)));
    }
    if let Some(hi) = hi
        && v > hi
    {
        return Err(format!("must be at most {}", show(hi)));
    }
    Ok(())
}

/// Checks one answer and returns it normalized (`None` when left empty), with the files it
/// carries.
pub fn normalize(q: &Question, v: &Value, tz: Tz) -> Result<Option<(Value, Vec<Upload>)>, String> {
    if is_blank(v) {
        return Ok(None);
    }
    let plain = |x: Value| Ok(Some((x, Vec::new())));
    match q.kind {
        Kind::ShortText | Kind::LongText => {
            let raw = text_of(v)?;
            let s = if q.kind == Kind::ShortText {
                let s = raw.trim().to_string();
                single_line(&s)?;
                s
            } else {
                let s = raw.replace("\r\n", "\n").replace('\r', "\n").trim().to_string();
                if s.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
                    return Err("contains control characters".into());
                }
                s
            };
            let n = s.chars().count();
            if n < q.min_length {
                return Err(format!("must be at least {} characters", q.min_length));
            }
            if n > q.max_length {
                return Err(format!("must be at most {} characters", q.max_length));
            }
            if let Some(re) = &q.pattern
                && !re.is_match(&s)
            {
                return Err(q.pattern_message.clone().unwrap_or_else(|| "is not in the expected format".into()));
            }
            plain(json!(s))
        }
        Kind::Email => plain(normalize_field(&EMAIL, &json!(text_of(v)?))?),
        Kind::Phone => plain(normalize_field(&PHONE, &json!(text_of(v)?))?),
        Kind::Number => {
            let i = int_of(v)?;
            if let Range::Int(lo, hi) = &q.range {
                bound(&i, lo, hi, |x| x.to_string())?;
            }
            plain(json!(i))
        }
        Kind::Decimal => {
            let d = parse_decimal(v).map_err(|_| "must be a number".to_string())?;
            if let Range::Dec(lo, hi) = &q.range {
                bound(&d, lo, hi, |x| x.normalize().to_string())?;
            }
            plain(decimal_value(d))
        }
        Kind::Date => {
            let d = parse_date(&text_of(v)?)?;
            if let Range::Date(lo, hi) = &q.range {
                bound(&d, lo, hi, |x| x.to_string())?;
            }
            plain(json!(d.format("%Y-%m-%d").to_string()))
        }
        Kind::Time => {
            let t = parse_time(&text_of(v)?)?;
            if let Range::Time(lo, hi) = &q.range {
                bound(&t, lo, hi, |x| time_value(*x))?;
            }
            plain(json!(time_value(t)))
        }
        Kind::Datetime => {
            let d = parse_instant(&text_of(v)?, tz)?;
            if let Range::At(lo, hi) = &q.range {
                bound(&d, lo, hi, |x| instant_value(*x))?;
            }
            plain(json!(instant_value(d)))
        }
        Kind::Select | Kind::Dropdown | Kind::Likert => {
            let s = text_of(v)?.trim().to_string();
            if q.options.contains(&s) {
                return plain(json!(s));
            }
            if q.allow_other {
                single_line(&s)?;
                if s.chars().count() > OPTION_MAX_CHARS {
                    return Err(format!("must be at most {OPTION_MAX_CHARS} characters"));
                }
                return plain(json!(s));
            }
            Err("must be one of the options".into())
        }
        Kind::MultiSelect => {
            let list = v.as_array().ok_or("must be a list of options")?;
            let mut chosen: Vec<&str> = Vec::new();
            let mut other: Option<String> = None;
            for x in list {
                let s = x.as_str().map(str::trim).ok_or("must be a list of options")?;
                if s.is_empty() {
                    return Err("options cannot be empty".into());
                }
                if chosen.contains(&s) || other.as_deref() == Some(s) {
                    return Err(format!("'{s}' is chosen twice"));
                }
                if let Some(o) = q.options.iter().find(|o| o.as_str() == s) {
                    chosen.push(o);
                } else if q.allow_other && other.is_none() {
                    single_line(s)?;
                    if s.chars().count() > OPTION_MAX_CHARS {
                        return Err(format!("must be at most {OPTION_MAX_CHARS} characters"));
                    }
                    other = Some(s.to_string());
                } else {
                    return Err(format!("'{s}' is not an option"));
                }
            }
            let n = chosen.len() + usize::from(other.is_some());
            if let Range::Count(lo, hi) = q.range {
                if n < lo {
                    return Err(format!("choose at least {lo}"));
                }
                if n > hi {
                    return Err(format!("choose at most {hi}"));
                }
            }
            let mut out: Vec<Value> = q.options.iter().filter(|o| chosen.contains(&o.as_str())).map(|o| json!(o)).collect();
            out.extend(other.map(Value::String));
            plain(Value::Array(out))
        }
        Kind::Checkbox => {
            let b = match v {
                Value::Bool(b) => *b,
                Value::Number(n) if n.as_i64() == Some(1) => true,
                Value::Number(n) if n.as_i64() == Some(0) => false,
                Value::String(s) => match s.trim().to_lowercase().as_str() {
                    "true" | "yes" | "1" | "on" => true,
                    "false" | "no" | "0" | "off" => false,
                    _ => return Err("must be checked or not".into()),
                },
                _ => return Err("must be checked or not".into()),
            };
            plain(json!(b))
        }
        Kind::Rating | Kind::Nps => {
            let i = int_of(v)?;
            let (lo, hi) = if q.kind == Kind::Nps { (0, 10) } else { (1, q.scale) };
            if !(lo..=hi).contains(&i) {
                return Err(format!("must be from {lo} to {hi}"));
            }
            plain(json!(i))
        }
        Kind::Matrix => {
            let m = v.as_object().ok_or("must give a column for each row")?;
            let mut out = Map::new();
            for (row, col) in m {
                if !q.rows.contains(row) {
                    return Err(format!("'{row}' is not a row"));
                }
                if col.is_null() {
                    continue;
                }
                let c = col.as_str().map(str::trim).ok_or("each row's answer is a column")?;
                if !q.options.iter().any(|o| o == c) {
                    return Err(format!("'{c}' is not a column (row '{row}')"));
                }
                out.insert(row.clone(), json!(c));
            }
            if out.is_empty() {
                return Ok(None);
            }
            if q.required && out.len() < q.rows.len() {
                return Err("answer every row".into());
            }
            plain(Value::Object(out))
        }
        Kind::Ranking => {
            let list = v.as_array().ok_or("must be the options in your order")?;
            let ranked: Vec<&str> = list.iter().map(|x| x.as_str().map(str::trim).unwrap_or_default()).collect();
            let complete = ranked.len() == q.options.len() && q.options.iter().all(|o| ranked.iter().filter(|r| **r == o.as_str()).count() == 1);
            if !complete {
                return Err("rank every option exactly once".into());
            }
            plain(json!(ranked))
        }
        Kind::File => {
            let list = v.as_array().ok_or("must be a list of files")?;
            if list.len() > q.max_files {
                return Err(if q.max_files == 1 { "attach one file".into() } else { format!("attach at most {} files", q.max_files) });
            }
            let mut uploads = Vec::new();
            let mut shown = Vec::new();
            for f in list {
                let (name, data) = files::decode(f, q.max_file_bytes)?;
                let ty = files::extension(&name)
                    .and_then(|e| q.accept.iter().find(|t| t.ext == e).copied())
                    .ok_or_else(|| format!("{name}: accepted types are {}", q.accept.iter().map(|t| t.ext).collect::<Vec<_>>().join(", ")))?;
                if !files::content_matches(ty, &data) {
                    return Err(format!("{name} is not really a .{} file", ty.ext));
                }
                shown.push(json!({"file_name": name, "content_type": ty.mime, "size": data.len()}));
                uploads.push(Upload { key: q.key.clone(), file_name: name, content_type: ty.mime.to_string(), data });
            }
            Ok(Some((Value::Array(shown), uploads)))
        }
        Kind::PageBreak | Kind::Statement => Ok(None),
    }
}

/// How an answer looks to a condition: numbers as numbers, files as their names.
fn cel_value(q: &Question, v: &Value) -> Value {
    match q.kind {
        Kind::Decimal => v.as_str().and_then(|s| Decimal::from_str(s).ok()).and_then(|d| d.to_f64()).map_or(Value::Null, |f| json!(f)),
        Kind::File => Value::Array(v.as_array().map(|a| a.iter().map(|f| f["file_name"].clone()).collect()).unwrap_or_default()),
        _ => v.clone(),
    }
}

/// Checks a response's answers against the definition. Unknown keys are refused; hidden
/// questions are skipped and their answers dropped; every error names its question key.
pub fn evaluate(def: &Definition, raw: &Map<String, Value>, env: &Env) -> Result<Submission, Vec<FieldError>> {
    let mut errors: Vec<FieldError> = raw.keys().filter(|k| def.question(k).is_none()).map(|k| FieldError::new(k, "is not a question of this form")).collect();
    let mut view = Value::Object(def.answerable().map(|q| (q.key.clone(), Value::Null)).collect());
    let mut out = Submission::default();
    let mut page_shown = true;
    for q in &def.questions {
        let shown = q.visible_if.as_ref().is_none_or(|c| c.holds(&Vars { answers: &view, today: &env.today, now: &env.now }));
        match q.kind {
            Kind::PageBreak => {
                page_shown = shown;
                out.visible.push(shown);
                continue;
            }
            Kind::Statement => {
                out.visible.push(page_shown && shown);
                continue;
            }
            _ => {}
        }
        let visible = page_shown && shown;
        out.visible.push(visible);
        if !visible {
            continue;
        }
        match normalize(q, raw.get(&q.key).unwrap_or(&Value::Null), env.tz) {
            Err(m) => errors.push(FieldError::new(&q.key, m)),
            Ok(None) if q.required => errors.push(FieldError::new(&q.key, "is required")),
            Ok(None) => {}
            Ok(Some((v, uploads))) => {
                if q.kind == Kind::Checkbox && q.required && v == json!(false) {
                    errors.push(FieldError::new(&q.key, "must be checked"));
                    continue;
                }
                view[q.key.as_str()] = cel_value(q, &v);
                out.answers.insert(q.key.clone(), v);
                out.uploads.extend(uploads);
            }
        }
    }
    if errors.is_empty() { Ok(out) } else { Err(errors) }
}

#[derive(Debug, Clone)]
pub struct Graded {
    pub key: String,
    pub points: Decimal,
    pub earned: Decimal,
    pub correct: bool,
}

#[derive(Debug, Clone)]
pub struct Grade {
    pub score: Decimal,
    pub max: Decimal,
    /// None without a passing score or gradable questions.
    pub passed: Option<bool>,
    pub items: Vec<Graded>,
}

fn is_correct(q: &Question, answer: Option<&Value>, correct: &Value) -> bool {
    let Some(a) = answer else { return false };
    match q.kind {
        Kind::ShortText => a.as_str().map(fold).is_some_and(|s| correct.as_array().is_some_and(|alts| alts.iter().any(|c| c.as_str() == Some(s.as_str())))),
        _ => a == correct,
    }
}

/// Scores a quiz response: each visible question with a correct answer is worth its points,
/// all or nothing. Passing compares exactly: score × 100 ≥ passing % × maximum.
pub fn grade(def: &Definition, sub: &Submission, passing: Option<Decimal>) -> Grade {
    let mut g = Grade { score: Decimal::ZERO, max: Decimal::ZERO, passed: None, items: vec![] };
    for (i, q) in def.questions.iter().enumerate() {
        let Some(correct) = &q.correct else { continue };
        if !sub.visible.get(i).copied().unwrap_or(false) {
            continue;
        }
        let ok = is_correct(q, sub.answers.get(&q.key), correct);
        let earned = if ok { q.points } else { Decimal::ZERO };
        g.max += q.points;
        g.score += earned;
        g.items.push(Graded { key: q.key.clone(), points: q.points, earned, correct: ok });
    }
    if g.max > Decimal::ZERO {
        g.passed = passing.map(|p| g.score * Decimal::ONE_HUNDRED >= p * g.max);
    }
    g
}

/// An answer as text, for emails, CSV and record fields.
pub fn display(q: &Question, v: &Value) -> String {
    match (q.kind, v) {
        (_, Value::Null) => String::new(),
        (Kind::Checkbox, Value::Bool(b)) => (if *b { "Yes" } else { "No" }).to_string(),
        (Kind::Ranking, Value::Array(a)) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" > "),
        (Kind::File, Value::Array(a)) => a.iter().filter_map(|f| f["file_name"].as_str()).collect::<Vec<_>>().join(", "),
        (Kind::Matrix, Value::Object(m)) => {
            q.rows.iter().filter_map(|r| m.get(r).and_then(Value::as_str).map(|c| format!("{r}: {c}"))).collect::<Vec<_>>().join("; ")
        }
        (_, Value::Array(a)) => a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect::<Vec<_>>().join(", "),
        (_, Value::String(s)) => s.clone(),
        (_, other) => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    fn def(v: Value) -> Definition {
        let rows: Vec<Map<String, Value>> = v.as_array().unwrap().iter().map(|r| r.as_object().unwrap().clone()).collect();
        let (d, errors) = Definition::parse(&rows, chrono_tz::UTC, true);
        assert!(errors.is_empty(), "{errors:?}");
        d
    }

    fn one(q: Value, answer: Value) -> Result<Option<Value>, String> {
        let d = def(json!([q]));
        normalize(&d.questions[0], &answer, chrono_tz::UTC).map(|n| n.map(|(v, _)| v))
    }

    #[test]
    fn every_type_normalizes_or_refuses() {
        let st = json!({"key": "a", "label": "A", "question_type": "short_text", "min_length": 2, "max_length": 5, "pattern": "[a-z]+", "pattern_message": "letters only"});
        assert_eq!(one(st.clone(), json!("  abc ")), Ok(Some(json!("abc"))));
        assert_eq!(one(st.clone(), json!("a")), Err("must be at least 2 characters".into()));
        assert_eq!(one(st.clone(), json!("abcdef")), Err("must be at most 5 characters".into()));
        assert_eq!(one(st.clone(), json!("ab1")), Err("letters only".into()));
        assert_eq!(one(st.clone(), json!("a\nb")), Err("must be a single line of text".into()));
        assert_eq!(one(st, json!("   ")), Ok(None));
        let lt = json!({"key": "a", "label": "A", "question_type": "long_text"});
        assert_eq!(one(lt.clone(), json!("line 1\r\nline 2 ")), Ok(Some(json!("line 1\nline 2"))));
        assert!(one(lt, json!("bell\u{7}")).is_err());
        let em = json!({"key": "a", "label": "A", "question_type": "email"});
        assert_eq!(one(em.clone(), json!(" Asha@Example.COM ")), Ok(Some(json!("asha@example.com"))));
        assert!(one(em, json!("not-an-email")).is_err());
        let ph = json!({"key": "a", "label": "A", "question_type": "phone"});
        assert_eq!(one(ph.clone(), json!("+91 98450 12345")), Ok(Some(json!("+91 98450 12345"))));
        assert!(one(ph, json!("call me")).is_err());
        let num = json!({"key": "a", "label": "A", "question_type": "number", "min_value": "1", "max_value": "120"});
        assert_eq!(one(num.clone(), json!("42")), Ok(Some(json!(42))));
        assert_eq!(one(num.clone(), json!(0)), Err("must be at least 1".into()));
        assert!(one(num, json!(4.5)).is_err());
        let dec = json!({"key": "a", "label": "A", "question_type": "decimal", "min_value": "0.5", "max_value": "99.99"});
        assert_eq!(one(dec.clone(), json!("12.50")), Ok(Some(json!("12.5"))));
        assert_eq!(one(dec.clone(), json!(0.1)), Err("must be at least 0.5".into()));
        assert_eq!(one(dec, json!("100")), Err("must be at most 99.99".into()));
        let date = json!({"key": "a", "label": "A", "question_type": "date", "min_value": "2026-01-01"});
        assert_eq!(one(date.clone(), json!("2026-10-29")), Ok(Some(json!("2026-10-29"))));
        assert!(one(date.clone(), json!("2025-12-31")).is_err());
        assert!(one(date, json!("29/10/2026")).is_err());
        let time = json!({"key": "a", "label": "A", "question_type": "time", "min_value": "09:00", "max_value": "17:30"});
        assert_eq!(one(time.clone(), json!("09:30:00")), Ok(Some(json!("09:30"))));
        assert_eq!(one(time.clone(), json!("17:30:15")), Err("must be at most 17:30".into()));
        assert!(one(time, json!("25:00")).is_err());
        let dt = json!({"key": "a", "label": "A", "question_type": "datetime"});
        assert_eq!(one(dt.clone(), json!("2026-10-29T10:00:00+05:30")), Ok(Some(json!("2026-10-29T04:30:00.000Z"))));
        assert_eq!(one(dt, json!("2026-10-29T10:00")), Ok(Some(json!("2026-10-29T10:00:00.000Z"))), "local times read in the zone (UTC here)");
        let sel = json!({"key": "a", "label": "A", "question_type": "select", "options": ["Yes", "No"]});
        assert_eq!(one(sel.clone(), json!("No")), Ok(Some(json!("No"))));
        assert_eq!(one(sel, json!("Maybe")), Err("must be one of the options".into()));
        let other = json!({"key": "a", "label": "A", "question_type": "dropdown", "options": ["Web"], "allow_other": true});
        assert_eq!(one(other, json!("A friend")), Ok(Some(json!("A friend"))));
        let multi = json!({"key": "a", "label": "A", "question_type": "multi_select", "options": ["A", "B", "C"], "min_value": "1", "max_value": "2", "allow_other": true});
        assert_eq!(one(multi.clone(), json!(["C", "A"])), Ok(Some(json!(["A", "C"]))), "stored in option order");
        assert_eq!(one(multi.clone(), json!(["B", "Zed"])), Ok(Some(json!(["B", "Zed"]))), "one other answer, last");
        assert_eq!(one(multi.clone(), json!(["A", "B", "C"])), Err("choose at most 2".into()));
        assert_eq!(one(multi.clone(), json!(["A", "A"])), Err("'A' is chosen twice".into()));
        assert_eq!(one(multi, json!(["X", "Y"])), Err("'Y' is not an option".into()));
        let cb = json!({"key": "a", "label": "A", "question_type": "checkbox"});
        assert_eq!(one(cb.clone(), json!("yes")), Ok(Some(json!(true))));
        assert_eq!(one(cb.clone(), json!(false)), Ok(Some(json!(false))));
        assert!(one(cb, json!("perhaps")).is_err());
        let rating = json!({"key": "a", "label": "A", "question_type": "rating"});
        assert_eq!(one(rating.clone(), json!(5)), Ok(Some(json!(5))));
        assert_eq!(one(rating.clone(), json!(6)), Err("must be from 1 to 5".into()));
        assert_eq!(one(rating, json!(0)), Err("must be from 1 to 5".into()));
        let nps = json!({"key": "a", "label": "A", "question_type": "nps"});
        assert_eq!(one(nps.clone(), json!(0)), Ok(Some(json!(0))));
        assert_eq!(one(nps, json!(11)), Err("must be from 0 to 10".into()));
        let likert = json!({"key": "a", "label": "A", "question_type": "likert"});
        assert_eq!(one(likert.clone(), json!("Agree")), Ok(Some(json!("Agree"))));
        assert!(one(likert, json!("Meh")).is_err());
        let matrix =
            json!({"key": "a", "label": "A", "question_type": "matrix", "options": ["Bad", "Good"], "matrix_rows": ["Speed", "Price"], "required": true});
        assert_eq!(one(matrix.clone(), json!({"Speed": "Good", "Price": "Bad"})), Ok(Some(json!({"Speed": "Good", "Price": "Bad"}))));
        assert_eq!(one(matrix.clone(), json!({"Speed": "Good"})), Err("answer every row".into()));
        assert_eq!(one(matrix.clone(), json!({"Colour": "Good"})), Err("'Colour' is not a row".into()));
        assert!(one(matrix, json!({"Speed": "Great", "Price": "Bad"})).is_err());
        let rank = json!({"key": "a", "label": "A", "question_type": "ranking", "options": ["X", "Y", "Z"]});
        assert_eq!(one(rank.clone(), json!(["Z", "X", "Y"])), Ok(Some(json!(["Z", "X", "Y"]))));
        assert_eq!(one(rank.clone(), json!(["Z", "X"])), Err("rank every option exactly once".into()));
        assert_eq!(one(rank, json!(["Z", "Z", "X"])), Err("rank every option exactly once".into()));
        let file = json!({"key": "a", "label": "A", "question_type": "file", "accept": "pdf", "max_value": "1"});
        let pdf = json!({"file_name": "cv.pdf", "content_base64": STANDARD.encode(b"%PDF-1.4 body")});
        assert_eq!(one(file.clone(), json!([pdf.clone()])), Ok(Some(json!([{"file_name": "cv.pdf", "content_type": "application/pdf", "size": 13}]))));
        assert!(one(file.clone(), json!([pdf.clone(), pdf])).unwrap_err().contains("one file"));
        let fake = json!({"file_name": "cv.pdf", "content_base64": STANDARD.encode(b"MZ\x90\x00")});
        assert!(one(file.clone(), json!([fake])).unwrap_err().contains("not really"));
        let exe = json!({"file_name": "run.exe", "content_base64": STANDARD.encode(b"MZ")});
        assert!(one(file, json!([exe])).unwrap_err().contains("accepted types"));
    }

    #[test]
    fn local_times_follow_the_zone_across_clock_changes() {
        let ny: Tz = "America/New_York".parse().unwrap();
        assert!(parse_instant("2026-03-08T02:30", ny).unwrap_err().contains("does not exist"), "skipped by the spring change");
        assert_eq!(instant_value(parse_instant("2026-03-08T03:30", ny).unwrap()), "2026-03-08T07:30:00.000Z", "EDT after the change");
        assert_eq!(instant_value(parse_instant("2026-11-01T01:30", ny).unwrap()), "2026-11-01T05:30:00.000Z", "the earlier of the repeated hour (EDT)");
        assert_eq!(instant_value(parse_instant("2026-11-01T02:30", ny).unwrap()), "2026-11-01T07:30:00.000Z", "EST after the change");
    }

    #[test]
    fn hidden_questions_are_not_required_and_their_answers_are_dropped() {
        let d = def(json!([
            {"key": "member", "label": "Member?", "question_type": "checkbox"},
            {"key": "member_id", "label": "Member id", "question_type": "short_text", "required": true, "visible_if": "answers.member == true"},
            {"key": "p2", "label": "Page 2", "question_type": "page_break", "visible_if": "answers.member != true"},
            {"key": "why", "label": "Why not?", "question_type": "long_text", "required": true},
            {"key": "p3", "label": "Page 3", "question_type": "page_break"},
            {"key": "rating", "label": "Rating", "question_type": "rating", "required": true}
        ]));
        let env = Env::new(chrono_tz::UTC);
        let raw = |v: Value| v.as_object().unwrap().clone();
        let member = evaluate(&d, &raw(json!({"member": true, "member_id": "M-1", "why": "dropped", "rating": 4})), &env).unwrap();
        assert_eq!(Value::Object(member.answers.clone()), json!({"member": true, "member_id": "M-1", "rating": 4}), "page 2 is skipped for members");
        assert_eq!(member.visible, vec![true, true, false, false, true, true]);
        let other = evaluate(&d, &raw(json!({"member": false, "member_id": "ignored", "why": "price", "rating": 2})), &env).unwrap();
        assert_eq!(Value::Object(other.answers), json!({"member": false, "why": "price", "rating": 2}));
        let missing = evaluate(&d, &raw(json!({"member": false, "extra": 1})), &env).unwrap_err();
        let fields: Vec<&str> = missing.iter().map(|e| e.field.as_str()).collect();
        assert_eq!(fields, ["extra", "why", "rating"], "{missing:?}");
    }

    #[test]
    fn quizzes_grade_all_or_nothing_and_pass_exactly() {
        let d = def(json!([
            {"key": "capital", "label": "Capital", "question_type": "short_text", "correct_answer": ["Paris"], "points": "2"},
            {"key": "sum", "label": "2+2", "question_type": "number", "correct_answer": 4},
            {"key": "primes", "label": "Primes", "question_type": "multi_select", "options": ["2", "3", "4"], "correct_answer": ["2", "3"], "points": "1.5"},
            {"key": "bonus", "label": "Bonus", "question_type": "select", "options": ["a", "b"], "correct_answer": "a", "visible_if": "answers.sum == 5"}
        ]));
        let env = Env::new(chrono_tz::UTC);
        let sub = evaluate(&d, json!({"capital": "  paris ", "sum": 4, "primes": ["2"]}).as_object().unwrap(), &env).unwrap();
        let g = grade(&d, &sub, Some(Decimal::from(60)));
        assert_eq!((g.score, g.max), (Decimal::from(3), Decimal::from_str("4.5").unwrap()), "the hidden bonus does not count");
        assert_eq!(g.passed, Some(true), "3 / 4.5 = 66.7% ≥ 60%");
        assert_eq!(grade(&d, &sub, Some(Decimal::from_str("66.67").unwrap())).passed, Some(false), "exact: 66.666… < 66.67");
        assert_eq!(g.items.iter().map(|i| i.correct).collect::<Vec<_>>(), [true, true, false]);
        assert_eq!(grade(&d, &sub, None).passed, None);
    }

    #[test]
    fn answers_display_as_text() {
        let d = def(json!([
            {"key": "m", "label": "M", "question_type": "matrix", "options": ["Bad", "Good"], "matrix_rows": ["Speed", "Price"]},
            {"key": "r", "label": "R", "question_type": "ranking", "options": ["X", "Y"]},
            {"key": "c", "label": "C", "question_type": "checkbox"},
            {"key": "s", "label": "S", "question_type": "multi_select", "options": ["A", "B"]}
        ]));
        assert_eq!(display(&d.questions[0], &json!({"Price": "Bad", "Speed": "Good"})), "Speed: Good; Price: Bad");
        assert_eq!(display(&d.questions[1], &json!(["Y", "X"])), "Y > X");
        assert_eq!(display(&d.questions[2], &json!(true)), "Yes");
        assert_eq!(display(&d.questions[3], &json!(["A", "B"])), "A, B");
    }
}
