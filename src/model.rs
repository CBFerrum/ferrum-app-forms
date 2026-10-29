//! A form's definition as the engine reads it: the questions, parsed and checked the same way
//! when an owner saves the form (field-level errors on the question rows) and when a respondent
//! sends a response (where a definition that no longer parses is an internal error).

use crate::answers;
use crate::files::{self, FileType};
use crate::logic::Condition;
use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use chrono_tz::Tz;
use ferrum_kernel::FieldError;
use regex::{Regex, RegexBuilder};
use rust_decimal::Decimal;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::LazyLock;

pub const MAX_QUESTIONS: usize = 300;
pub const MAX_OPTIONS: usize = 200;
pub const MAX_ROWS: usize = 100;
pub const OPTION_MAX_CHARS: usize = 200;
const SHORT_TEXT_CAP: usize = 2_000;
const LONG_TEXT_CAP: usize = 50_000;
const SHORT_TEXT_DEFAULT: usize = 500;
const LONG_TEXT_DEFAULT: usize = 10_000;
pub const MAX_FILES: usize = 10;
const FILE_MB_DEFAULT: usize = 10;
const MAX_PATTERN_BYTES: usize = 256 * 1024;

/// The agreement scale of a Likert question without labels of its own.
pub const LIKERT_DEFAULT: [&str; 5] = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"];

static KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_]{0,39}$").expect("key pattern"));

pub fn valid_key(k: &str) -> bool {
    KEY.is_match(k)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    ShortText,
    LongText,
    Email,
    Phone,
    Number,
    Decimal,
    Date,
    Time,
    Datetime,
    Select,
    MultiSelect,
    Checkbox,
    Dropdown,
    Rating,
    Nps,
    Likert,
    Matrix,
    Ranking,
    File,
    PageBreak,
    Statement,
}

const KINDS: [(Kind, &str); 21] = [
    (Kind::ShortText, "short_text"),
    (Kind::LongText, "long_text"),
    (Kind::Email, "email"),
    (Kind::Phone, "phone"),
    (Kind::Number, "number"),
    (Kind::Decimal, "decimal"),
    (Kind::Date, "date"),
    (Kind::Time, "time"),
    (Kind::Datetime, "datetime"),
    (Kind::Select, "select"),
    (Kind::MultiSelect, "multi_select"),
    (Kind::Checkbox, "checkbox"),
    (Kind::Dropdown, "dropdown"),
    (Kind::Rating, "rating"),
    (Kind::Nps, "nps"),
    (Kind::Likert, "likert"),
    (Kind::Matrix, "matrix"),
    (Kind::Ranking, "ranking"),
    (Kind::File, "file"),
    (Kind::PageBreak, "page_break"),
    (Kind::Statement, "statement"),
];

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        KINDS.iter().find(|(_, n)| *n == s).map(|(k, _)| *k)
    }

    pub fn name(self) -> &'static str {
        KINDS.iter().find(|(k, _)| *k == self).map(|(_, n)| *n).unwrap_or("short_text")
    }

    /// Whether respondents answer it (page breaks and statements only structure the form).
    pub fn answerable(self) -> bool {
        !matches!(self, Kind::PageBreak | Kind::Statement)
    }

    /// Single choice among the options.
    pub fn single_choice(self) -> bool {
        matches!(self, Kind::Select | Kind::Dropdown | Kind::Likert)
    }

    /// A quiz can mark these right or wrong.
    pub fn gradable(self) -> bool {
        matches!(
            self,
            Kind::ShortText
                | Kind::Number
                | Kind::Decimal
                | Kind::Date
                | Kind::Select
                | Kind::Dropdown
                | Kind::MultiSelect
                | Kind::Checkbox
                | Kind::Likert
                | Kind::Ranking
        )
    }
}

/// Bounds of an answer, by question type.
#[derive(Debug, Clone, Default)]
pub enum Range {
    #[default]
    Any,
    Int(Option<i64>, Option<i64>),
    Dec(Option<Decimal>, Option<Decimal>),
    Date(Option<NaiveDate>, Option<NaiveDate>),
    Time(Option<NaiveTime>, Option<NaiveTime>),
    At(Option<DateTime<Utc>>, Option<DateTime<Utc>>),
    /// Selections of a multi-select.
    Count(usize, usize),
}

#[derive(Debug, Clone)]
pub struct Question {
    pub key: String,
    pub label: String,
    pub kind: Kind,
    pub required: bool,
    pub help_text: Option<String>,
    /// Choices, Likert labels, ranking items or matrix columns.
    pub options: Vec<String>,
    /// Matrix statements.
    pub rows: Vec<String>,
    pub allow_other: bool,
    pub range: Range,
    /// The bounds as the owner wrote them (sent to respondents).
    pub min_raw: Option<String>,
    pub max_raw: Option<String>,
    /// Rating scale: 1 to `scale`.
    pub scale: i64,
    pub min_length: usize,
    pub max_length: usize,
    pub pattern: Option<Regex>,
    pub pattern_source: Option<String>,
    pub pattern_message: Option<String>,
    pub default: Option<Value>,
    pub visible_if: Option<Condition>,
    pub visible_if_source: Option<String>,
    pub allow_prefill: bool,
    pub accept: Vec<&'static FileType>,
    pub max_file_bytes: usize,
    pub max_files: usize,
    pub points: Decimal,
    /// Normalized correct answer (short text: the accepted answers, lower-case).
    pub correct: Option<Value>,
}

impl Question {
    fn blank(key: String, kind: Kind) -> Question {
        Question {
            key,
            label: String::new(),
            kind,
            required: false,
            help_text: None,
            options: vec![],
            rows: vec![],
            allow_other: false,
            range: Range::Any,
            min_raw: None,
            max_raw: None,
            scale: 5,
            min_length: 0,
            max_length: 0,
            pattern: None,
            pattern_source: None,
            pattern_message: None,
            default: None,
            visible_if: None,
            visible_if_source: None,
            allow_prefill: false,
            accept: vec![],
            max_file_bytes: FILE_MB_DEFAULT << 20,
            max_files: 1,
            points: Decimal::ZERO,
            correct: None,
        }
    }

    /// What respondents see: everything needed to render and check an answer, never quiz
    /// points or correct answers.
    pub fn public(&self) -> Value {
        let mut q = Map::new();
        q.insert("key".into(), json!(self.key));
        q.insert("type".into(), json!(self.kind.name()));
        q.insert("label".into(), json!(self.label));
        if self.kind.answerable() {
            q.insert("required".into(), json!(self.required));
        }
        let mut put = |k: &str, v: Value| {
            if !v.is_null() {
                q.insert(k.to_string(), v);
            }
        };
        put("help_text", json!(self.help_text));
        if !self.options.is_empty() {
            put(if self.kind == Kind::Matrix { "columns" } else { "options" }, json!(self.options));
        }
        if !self.rows.is_empty() {
            put("rows", json!(self.rows));
        }
        if self.allow_other {
            put("allow_other", json!(true));
        }
        match self.kind {
            Kind::Rating => put("scale", json!(self.scale)),
            Kind::Nps => put("scale", json!(10)),
            Kind::ShortText | Kind::LongText => {
                put("min_length", if self.min_length > 0 { json!(self.min_length) } else { Value::Null });
                put("max_length", json!(self.max_length));
                put("pattern", json!(self.pattern_source));
                put("pattern_message", json!(self.pattern_message));
            }
            Kind::File => {
                put("accept", json!(self.accept.iter().map(|t| t.ext).collect::<Vec<_>>()));
                put("max_file_mb", json!(self.max_file_bytes >> 20));
                put("max_files", json!(self.max_files));
            }
            Kind::Number | Kind::Decimal | Kind::Date | Kind::Time | Kind::Datetime | Kind::MultiSelect => {
                put("min", json!(self.min_raw));
                put("max", json!(self.max_raw));
            }
            _ => {}
        }
        put("default", self.default.clone().unwrap_or(Value::Null));
        put("visible_if", json!(self.visible_if_source));
        if self.allow_prefill {
            put("allow_prefill", json!(true));
        }
        Value::Object(q)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Definition {
    pub questions: Vec<Question>,
}

impl Definition {
    pub fn question(&self, key: &str) -> Option<&Question> {
        self.questions.iter().find(|q| q.key == key && q.kind.answerable())
    }

    pub fn answerable(&self) -> impl Iterator<Item = &Question> {
        self.questions.iter().filter(|q| q.kind.answerable())
    }

    /// Parses the question rows of a form. `tz` reads date-time bounds and defaults written
    /// without an offset; `quiz` enables points and correct answers. Errors point at the rows.
    pub fn parse(rows: &[Map<String, Value>], tz: Tz, quiz: bool) -> (Definition, Vec<FieldError>) {
        let mut errors = Vec::new();
        if rows.len() > MAX_QUESTIONS {
            errors.push(FieldError::new("questions", format!("a form has at most {MAX_QUESTIONS} questions")));
        }
        let kinds: Vec<Kind> = rows.iter().map(|r| Kind::parse(text(r, "question_type")).unwrap_or(Kind::ShortText)).collect();
        let keys: Vec<&str> = rows.iter().map(|r| text(r, "key")).collect();
        let answerable: Vec<&str> = keys.iter().zip(&kinds).filter(|(_, k)| k.answerable()).map(|(k, _)| *k).collect();
        let mut seen = HashSet::new();
        let mut questions = Vec::with_capacity(rows.len());
        for (i, r) in rows.iter().enumerate() {
            let mut err = |field: &str, msg: String| errors.push(FieldError::new(field, msg).in_row("questions", i));
            let kind = match Kind::parse(text(r, "question_type")) {
                Some(k) => k,
                None => {
                    err("question_type", "is not a question type".into());
                    Kind::ShortText
                }
            };
            let key = keys[i].to_string();
            if !valid_key(&key) {
                err("key", "use 1-40 of a-z, 0-9 and _, starting with a letter".into());
            } else if !seen.insert(key.clone()) {
                err("key", format!("'{key}' is used by another question"));
            }
            let mut q = Question::blank(key, kind);
            q.label = text(r, "label").to_string();
            q.help_text = Some(text(r, "help_text").to_string()).filter(|s| !s.is_empty());
            q.required = kind.answerable() && r.get("required").and_then(Value::as_bool).unwrap_or(false);
            if kind.answerable() && q.label.is_empty() {
                err("label", "is required".into());
            }
            if kind == Kind::Statement && q.label.is_empty() && q.help_text.is_none() {
                err("label", "write the statement".into());
            }
            parse_choices(&mut q, r, &mut err);
            parse_bounds(&mut q, r, tz, &mut err);
            parse_text_rules(&mut q, r, &mut err);
            if kind == Kind::File {
                match files::parse_accept(text(r, "accept")) {
                    Ok(list) => q.accept = list,
                    Err(m) => err("accept", m),
                }
                let mb = r.get("max_file_mb").and_then(Value::as_i64).unwrap_or(FILE_MB_DEFAULT as i64);
                q.max_file_bytes = (mb.clamp(1, files::MAX_FILE_MB as i64) as usize) << 20;
            }
            q.allow_prefill = kind.answerable()
                && !matches!(kind, Kind::File | Kind::Matrix | Kind::Ranking)
                && r.get("allow_prefill").and_then(Value::as_bool).unwrap_or(false);
            if let Some(src) = Some(text(r, "visible_if")).filter(|s| !s.is_empty()) {
                let earlier: Vec<&str> = keys[..i].iter().zip(&kinds[..i]).filter(|(_, k)| k.answerable()).map(|(k, _)| *k).collect();
                match Condition::compile(src, &earlier, &answerable) {
                    Ok(c) => {
                        q.visible_if = Some(c);
                        q.visible_if_source = Some(src.to_string());
                    }
                    Err(m) => err("visible_if", m),
                }
            }
            match r.get("default_value") {
                None | Some(Value::Null) => {}
                Some(_) if !kind.answerable() || kind == Kind::File => err("default_value", "this question cannot have a default".into()),
                Some(v) => match answers::normalize(&q, v, tz) {
                    Ok(n) => q.default = n.map(|(v, _)| v),
                    Err(m) => err("default_value", m),
                },
            }
            if quiz {
                parse_grading(&mut q, r, tz, &mut err);
            }
            questions.push(q);
        }
        (Definition { questions }, errors)
    }
}

/// A trimmed text value of a row (empty when missing).
pub fn text<'a>(r: &'a Map<String, Value>, k: &str) -> &'a str {
    r.get(k).and_then(Value::as_str).map(str::trim).unwrap_or_default()
}

/// A list of distinct, non-empty single-line texts (options, matrix rows).
pub fn text_list(v: Option<&Value>, max: usize) -> Result<Vec<String>, String> {
    let items: Vec<String> = match v {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| match x {
                Value::String(s) => Ok(s.trim().to_string()),
                Value::Number(n) => Ok(n.to_string()),
                _ => Err("must be a list of texts".to_string()),
            })
            .collect::<Result<_, _>>()?,
        Some(Value::String(s)) => s.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect(),
        Some(_) => return Err("must be a list of texts".into()),
    };
    if items.len() > max {
        return Err(format!("at most {max} entries"));
    }
    let mut out: Vec<String> = Vec::with_capacity(items.len());
    for s in items {
        if s.is_empty() {
            return Err("entries cannot be empty".into());
        }
        if s.chars().count() > OPTION_MAX_CHARS {
            return Err(format!("entries have at most {OPTION_MAX_CHARS} characters"));
        }
        if s.chars().any(char::is_control) {
            return Err("entries are single lines of text".into());
        }
        if out.contains(&s) {
            return Err(format!("'{s}' is listed twice"));
        }
        out.push(s);
    }
    Ok(out)
}

fn parse_choices(q: &mut Question, r: &Map<String, Value>, err: &mut impl FnMut(&str, String)) {
    let kind = q.kind;
    if matches!(kind, Kind::Select | Kind::Dropdown | Kind::MultiSelect | Kind::Likert | Kind::Matrix | Kind::Ranking) {
        match text_list(r.get("options"), MAX_OPTIONS) {
            Err(m) => err("options", m),
            Ok(list) => {
                q.options = if kind == Kind::Likert && list.is_empty() { LIKERT_DEFAULT.iter().map(|s| s.to_string()).collect() } else { list };
                let fewest = if matches!(kind, Kind::Select | Kind::Dropdown | Kind::MultiSelect) { 1 } else { 2 };
                if q.options.len() < fewest {
                    err("options", if fewest == 1 { "add at least one option".into() } else { format!("add at least {fewest} options") });
                }
            }
        }
    }
    if kind == Kind::Matrix {
        match text_list(r.get("matrix_rows"), MAX_ROWS) {
            Ok(list) if list.is_empty() => err("matrix_rows", "add at least one row".into()),
            Ok(list) => q.rows = list,
            Err(m) => err("matrix_rows", m),
        }
    }
    q.allow_other = matches!(kind, Kind::Select | Kind::Dropdown | Kind::MultiSelect) && r.get("allow_other").and_then(Value::as_bool).unwrap_or(false);
}

fn parse_bounds(q: &mut Question, r: &Map<String, Value>, tz: Tz, err: &mut impl FnMut(&str, String)) {
    let (lo, hi) = (text(r, "min_value"), text(r, "max_value"));
    let opt = |s: &str| Some(s.to_string()).filter(|s| !s.is_empty());
    q.min_raw = opt(lo);
    q.max_raw = opt(hi);
    fn both<T: PartialOrd>(lo: &str, hi: &str, parse: impl Fn(&str) -> Result<T, String>, err: &mut impl FnMut(&str, String)) -> (Option<T>, Option<T>) {
        let mut one = |field: &str, s: &str| {
            if s.is_empty() {
                return None;
            }
            match parse(s) {
                Ok(v) => Some(v),
                Err(m) => {
                    err(field, m);
                    None
                }
            }
        };
        let (a, b) = (one("min_value", lo), one("max_value", hi));
        if let (Some(x), Some(y)) = (&a, &b)
            && x > y
        {
            err("min_value", "must not be more than the maximum".into());
        }
        (a, b)
    }
    let count = |s: &str| s.parse::<usize>().map_err(|_| "must be a whole number".to_string());
    q.range = match q.kind {
        Kind::Number => {
            let (a, b) = both(lo, hi, |s| s.parse::<i64>().map_err(|_| "must be a whole number".into()), err);
            Range::Int(a, b)
        }
        Kind::Decimal => {
            let (a, b) = both(lo, hi, |s| Decimal::from_str(s).map(|d| d.normalize()).map_err(|_| "must be a number".into()), err);
            Range::Dec(a, b)
        }
        Kind::Date => {
            let (a, b) = both(lo, hi, ferrum_kernel::value::parse_date, err);
            Range::Date(a, b)
        }
        Kind::Time => {
            let (a, b) = both(lo, hi, answers::parse_time, err);
            Range::Time(a, b)
        }
        Kind::Datetime => {
            let (a, b) = both(lo, hi, |s| answers::parse_instant(s, tz), err);
            Range::At(a, b)
        }
        Kind::MultiSelect => {
            let (a, b) = both(lo, hi, count, err);
            let available = q.options.len() + usize::from(q.allow_other);
            if a.is_some_and(|a| a > available.max(1)) {
                err("min_value", format!("there are only {available} options to choose"));
            }
            Range::Count(a.unwrap_or(0), b.unwrap_or(usize::MAX))
        }
        Kind::Rating => {
            match hi {
                "" => q.scale = 5,
                s => match s.parse::<i64>() {
                    Ok(n) if (3..=10).contains(&n) => q.scale = n,
                    _ => err("max_value", "a rating scale goes up to 3 to 10".into()),
                },
            }
            Range::Any
        }
        Kind::File => {
            match hi {
                "" => q.max_files = 1,
                s => match s.parse::<usize>() {
                    Ok(n) if (1..=MAX_FILES).contains(&n) => q.max_files = n,
                    _ => err("max_value", format!("allow 1 to {MAX_FILES} files")),
                },
            }
            Range::Any
        }
        _ => Range::Any,
    };
}

fn parse_text_rules(q: &mut Question, r: &Map<String, Value>, err: &mut impl FnMut(&str, String)) {
    let (cap, default) = match q.kind {
        Kind::ShortText => (SHORT_TEXT_CAP, SHORT_TEXT_DEFAULT),
        Kind::LongText => (LONG_TEXT_CAP, LONG_TEXT_DEFAULT),
        _ => return,
    };
    let int = |k: &str| r.get(k).and_then(Value::as_i64).map(|v| v.max(0) as usize);
    q.max_length = int("max_length").unwrap_or(default);
    if q.max_length > cap {
        err("max_length", format!("at most {cap} for this question type"));
        q.max_length = cap;
    }
    q.min_length = int("min_length").unwrap_or(0);
    if q.min_length > q.max_length {
        err("min_length", "must not be more than the maximum length".into());
    }
    let pattern = text(r, "pattern");
    if !pattern.is_empty() {
        match RegexBuilder::new(&format!("^(?:{pattern})$")).size_limit(MAX_PATTERN_BYTES).dfa_size_limit(MAX_PATTERN_BYTES).build() {
            Ok(re) => {
                q.pattern = Some(re);
                q.pattern_source = Some(pattern.to_string());
            }
            Err(e) => err("pattern", format!("not a valid pattern: {}", e.to_string().lines().last().unwrap_or_default().trim())),
        }
        q.pattern_message = Some(text(r, "pattern_message").to_string()).filter(|s| !s.is_empty());
    }
}

fn parse_grading(q: &mut Question, r: &Map<String, Value>, tz: Tz, err: &mut impl FnMut(&str, String)) {
    let points = match r.get("points") {
        None | Some(Value::Null) => None,
        Some(v) => match ferrum_kernel::value::parse_decimal(v) {
            Ok(d) if d >= Decimal::ZERO => Some(d),
            _ => {
                err("points", "must be zero or more".into());
                None
            }
        },
    };
    let correct = r.get("correct_answer").filter(|v| !v.is_null());
    let Some(correct) = correct else {
        if points.is_some_and(|p| p > Decimal::ZERO) {
            err("correct_answer", "set the correct answer of a question that gives points".into());
        }
        return;
    };
    if !q.kind.gradable() {
        err("correct_answer", "this question type cannot be marked right or wrong".into());
        return;
    }
    let normalized = if q.kind == Kind::ShortText {
        let alternatives: Vec<&Value> = match correct {
            Value::Array(a) => a.iter().collect(),
            other => vec![other],
        };
        let mut out = Vec::new();
        for a in alternatives {
            match a.as_str().map(answers::fold) {
                Some(s) if !s.is_empty() => out.push(Value::String(s)),
                _ => {
                    err("correct_answer", "list the accepted answers as texts".into());
                    return;
                }
            }
        }
        Ok(Some(Value::Array(out)))
    } else {
        answers::normalize(q, correct, tz).map(|n| n.map(|(v, _)| v))
    };
    match normalized {
        Ok(Some(v)) => {
            q.correct = Some(v);
            q.points = points.unwrap_or(Decimal::ONE);
        }
        Ok(None) => err("correct_answer", "set the correct answer".into()),
        Err(m) => err("correct_answer", m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(v: Value) -> Vec<Map<String, Value>> {
        v.as_array().unwrap().iter().map(|r| r.as_object().unwrap().clone()).collect()
    }

    fn errors_of(v: Value, quiz: bool) -> Vec<(String, usize, String)> {
        let (_, errors) = Definition::parse(&rows(v), chrono_tz::UTC, quiz);
        errors.into_iter().map(|e| (e.field, e.row.map(|r| r.1).unwrap_or(usize::MAX), e.message)).collect()
    }

    fn has(errors: &[(String, usize, String)], field: &str, row: usize) -> bool {
        errors.iter().any(|(f, r, _)| f == field && *r == row)
    }

    #[test]
    fn a_good_definition_parses() {
        let (def, errors) = Definition::parse(
            &rows(json!([
                {"key": "name", "label": "Name", "question_type": "short_text", "required": true, "max_length": 80, "pattern": "[A-Za-z ]+"},
                {"key": "page2", "label": "More", "question_type": "page_break", "visible_if": "answers.name != null"},
                {"key": "colour", "label": "Colour", "question_type": "multi_select", "options": ["Red", "Blue"], "allow_other": true, "max_value": "2"},
                {"key": "agree", "label": "Statement", "question_type": "likert"},
                {"key": "grid", "label": "Grid", "question_type": "matrix", "options": ["Bad", "Good"], "matrix_rows": "Speed\nPrice"},
                {"key": "stars", "label": "Stars", "question_type": "rating", "max_value": "10", "default_value": 7},
                {"key": "when", "label": "When", "question_type": "datetime", "min_value": "2026-01-01T00:00:00Z"},
                {"key": "cv", "label": "CV", "question_type": "file", "accept": ".pdf, png", "max_value": "2", "max_file_mb": 5}
            ])),
            chrono_tz::UTC,
            false,
        );
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(def.questions.len(), 8);
        assert_eq!(def.questions[3].options.len(), 5, "default Likert labels");
        assert_eq!(def.questions[4].rows, vec!["Speed", "Price"], "rows may be written one per line");
        assert_eq!(def.questions[5].scale, 10);
        assert_eq!(def.questions[5].default, Some(json!(7)));
        assert_eq!(def.questions[7].max_files, 2);
        assert_eq!(def.questions[7].max_file_bytes, 5 << 20);
        let public = def.questions[0].public();
        assert_eq!(public["max_length"], json!(80));
        assert!(public.get("points").is_none() && public.get("correct_answer").is_none());
    }

    #[test]
    fn every_mistake_is_reported_on_its_row() {
        let e = errors_of(
            json!([
                {"key": "a", "label": "A", "question_type": "select", "options": []},
                {"key": "a", "label": "Again", "question_type": "short_text", "pattern": "(unclosed"},
                {"key": "Bad Key", "label": "B", "question_type": "number", "min_value": "10", "max_value": "1"},
                {"key": "c", "label": "", "question_type": "matrix", "options": ["x", "x"]},
                {"key": "d", "label": "D", "question_type": "dropdown", "options": ["x"], "visible_if": "answers.e == 1"},
                {"key": "e", "label": "E", "question_type": "rating", "max_value": "11", "default_value": 4},
                {"key": "f", "label": "F", "question_type": "file", "accept": "exe"},
                {"key": "g", "label": "G", "question_type": "short_text", "min_length": 50, "max_length": 10, "default_value": "x"},
                {"key": "h", "label": "H", "question_type": "date", "default_value": "31/12/2026"}
            ]),
            false,
        );
        assert!(has(&e, "options", 0), "{e:?}");
        assert!(has(&e, "key", 1) && has(&e, "pattern", 1), "{e:?}");
        assert!(has(&e, "key", 2) && has(&e, "min_value", 2), "{e:?}");
        assert!(has(&e, "label", 3) && has(&e, "options", 3) && has(&e, "matrix_rows", 3), "{e:?}");
        assert!(has(&e, "visible_if", 4), "{e:?}");
        assert!(has(&e, "max_value", 5), "{e:?}");
        assert!(has(&e, "accept", 6), "{e:?}");
        assert!(has(&e, "min_length", 7), "{e:?}");
        assert!(has(&e, "default_value", 8), "{e:?}");
    }

    #[test]
    fn quiz_answers_are_checked_and_normalized() {
        let (def, errors) = Definition::parse(
            &rows(json!([
                {"key": "capital", "label": "Capital of France?", "question_type": "short_text", "correct_answer": [" Paris ", "PARIS, France"], "points": "2"},
                {"key": "sum", "label": "2+2", "question_type": "number", "correct_answer": "4"},
                {"key": "primes", "label": "Primes", "question_type": "multi_select", "options": ["2", "3", "4"], "correct_answer": ["3", "2"]}
            ])),
            chrono_tz::UTC,
            true,
        );
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(def.questions[0].correct, Some(json!(["paris", "paris, france"])));
        assert_eq!(def.questions[0].points, Decimal::TWO);
        assert_eq!(def.questions[1].correct, Some(json!(4)));
        assert_eq!(def.questions[1].points, Decimal::ONE, "a correct answer is worth 1 point by default");
        assert_eq!(def.questions[2].correct, Some(json!(["2", "3"])), "kept in option order");
        let e = errors_of(
            json!([
                {"key": "a", "label": "A", "question_type": "long_text", "correct_answer": "x"},
                {"key": "b", "label": "B", "question_type": "select", "options": ["x"], "correct_answer": "y"},
                {"key": "c", "label": "C", "question_type": "number", "points": 3}
            ]),
            true,
        );
        assert!(has(&e, "correct_answer", 0) && has(&e, "correct_answer", 1) && has(&e, "correct_answer", 2), "{e:?}");
    }
}
