//! Records from responses: a form maps answers (or fixed values) to the fields of any installed
//! entity — a Lead (CRM), a Ticket (Helpdesk), a Customer. The mapping is checked against the
//! live schema whenever the form is saved: the entity exists, the fields exist and are writable,
//! the types fit and every required field is filled. Each record is created with the system
//! context, setting only the mapped fields, and normalized by the kernel like any other input.

use crate::answers::display;
use crate::model::{Definition, Kind, Question};
use ferrum_kernel::{Doc, FieldError};
use ferrum_meta::{EffEntity, EntityKind, FieldDef, FieldType, Schema};
use serde_json::{Map, Value, json};

/// Entities a form may not create (its own records).
const OWN: &[&str] = &["Form", "FormResponse", "FormsSettings"];

#[derive(Debug, Clone, PartialEq)]
pub struct MapRow {
    pub field: String,
    pub question: Option<String>,
    pub value: Option<String>,
}

pub fn rows(doc: &Doc) -> Vec<MapRow> {
    let text = |r: &Map<String, Value>, k: &str| r.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    doc.get("field_map")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_object)
                .map(|r| MapRow { field: text(r, "target_field").unwrap_or_default(), question: text(r, "question"), value: text(r, "value") })
                .collect()
        })
        .unwrap_or_default()
}

/// Whether answers of `q` can fill `f`.
fn compatible(q: &Question, f: &FieldDef) -> Result<(), String> {
    use FieldType as F;
    let ok = match f.ftype {
        F::Data | F::Text | F::Markdown | F::Code => {
            let single = f.ftype == F::Data;
            let long = q.kind == Kind::LongText || (q.kind == Kind::ShortText && q.max_length > f.max_length.map(|m| m as usize).unwrap_or(1000));
            !(matches!(q.kind, Kind::Matrix | Kind::File) || (single && long))
        }
        F::Email => q.kind == Kind::Email,
        F::Phone => q.kind == Kind::Phone,
        F::Url => q.kind == Kind::ShortText,
        F::Int => matches!(q.kind, Kind::Number | Kind::Rating | Kind::Nps),
        F::Decimal | F::Currency | F::Percent => matches!(q.kind, Kind::Number | Kind::Decimal | Kind::Rating | Kind::Nps),
        F::Date => q.kind == Kind::Date,
        F::Datetime => q.kind == Kind::Datetime,
        F::Check => q.kind == Kind::Checkbox,
        F::Select => {
            if !q.kind.single_choice() || q.allow_other {
                false
            } else if let Some(missing) = q.options.iter().find(|o| !f.options.contains(o)) {
                return Err(format!("'{missing}' is not one of the field's options ({})", f.options.join(", ")));
            } else {
                true
            }
        }
        F::Json => true,
        F::Attach => q.kind == Kind::File,
        F::Link | F::Table | F::Secret | F::Color => false,
    };
    if ok {
        Ok(())
    } else if matches!(f.ftype, F::Link) {
        Err("a link takes a fixed record id, not an answer".into())
    } else {
        let ty = serde_json::to_value(f.ftype).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
        Err(format!("{} answers cannot fill a field of type {ty}", q.kind.name()))
    }
}

/// A target field the mapping may write.
fn writable(f: &FieldDef) -> Result<(), &'static str> {
    if matches!(f.ftype, FieldType::Table | FieldType::Secret) {
        return Err("tables and secrets cannot be mapped");
    }
    if f.computed.is_some() || f.read_only {
        return Err("is read-only");
    }
    Ok(())
}

/// Checks a form's mapping against the schema. Errors name `target_entity` or rows of `field_map`.
pub fn check(schema: &Schema, def: &Definition, target: Option<&str>, rows: &[MapRow]) -> Vec<FieldError> {
    let mut errors = Vec::new();
    let Some(target) = target else {
        if !rows.is_empty() {
            errors.push(FieldError::new("target_entity", "choose the entity the mapping creates"));
        }
        return errors;
    };
    let Some(ent) = schema.entity(target) else {
        errors.push(FieldError::new("target_entity", format!("{target} is not an installed entity")));
        return errors;
    };
    if OWN.contains(&target) || !matches!(ent.def.kind, EntityKind::Master | EntityKind::Document) {
        errors.push(FieldError::new("target_entity", format!("records of {} cannot be created from responses", ent.def.label)));
        return errors;
    }
    let mut seen: Vec<&str> = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        let mut err = |field: &str, msg: String| errors.push(FieldError::new(field, msg).in_row("field_map", i));
        let Some(f) = ent.field(&r.field) else {
            err("target_field", format!("{} has no field '{}'", ent.def.label, r.field));
            continue;
        };
        if let Err(m) = writable(f) {
            err("target_field", m.into());
            continue;
        }
        if seen.contains(&r.field.as_str()) {
            err("target_field", "is mapped twice".into());
            continue;
        }
        seen.push(&r.field);
        match (&r.question, &r.value) {
            (Some(_), Some(_)) | (None, None) => err("question", "map a question or a fixed value (one of them)".into()),
            (Some(key), None) => match def.question(key) {
                None => err("question", format!("there is no question '{key}'")),
                Some(q) => {
                    if let Err(m) = compatible(q, f) {
                        err("question", m);
                    }
                }
            },
            (None, Some(v)) => {
                if let Err(m) = ferrum_kernel::value::normalize(f, &json!(v)) {
                    err("value", m);
                }
            }
        }
    }
    for f in ent.value_fields() {
        let filled_by_kernel = f.default.is_some() || f.default_expr.is_some() || f.computed.is_some() || f.fetch_from.is_some() || f.read_only;
        if f.required && !filled_by_kernel && f.ftype != FieldType::Check && !rows.iter().any(|r| r.field == f.name) {
            errors.push(FieldError::new("field_map", format!("map the required field {} of {}", f.label(), ent.def.label)));
        }
    }
    errors
}

/// Link fields filled with fixed values: (entity, record id) the saving user must be able to read.
pub fn fixed_links(ent: &EffEntity, rows: &[MapRow]) -> Vec<(String, uuid::Uuid)> {
    rows.iter()
        .filter_map(|r| {
            let f = ent.field(&r.field)?;
            let to = f.to.clone().filter(|_| f.ftype == FieldType::Link)?;
            Some((to, r.value.as_deref()?.parse().ok()?))
        })
        .collect()
}

/// The new record's input: mapped fields that have a value in this response.
pub fn input(def: &Definition, ent: &EffEntity, rows: &[MapRow], answers: &Map<String, Value>) -> Doc {
    let mut out = Doc::new();
    for r in rows {
        let Some(f) = ent.field(&r.field) else { continue };
        let v = match (&r.question, &r.value) {
            (Some(key), _) => {
                let (Some(q), Some(a)) = (def.question(key), answers.get(key)) else { continue };
                convert(q, a, f)
            }
            (None, Some(v)) => json!(v),
            (None, None) => continue,
        };
        if !v.is_null() {
            out.insert(r.field.clone(), v);
        }
    }
    out
}

/// An answer in the shape the target field takes (the kernel normalizes it after).
fn convert(q: &Question, a: &Value, f: &FieldDef) -> Value {
    use FieldType as F;
    match f.ftype {
        F::Json => a.clone(),
        F::Attach => a.as_array().and_then(|files| files.first()).map(|file| file["url"].clone()).unwrap_or(Value::Null),
        F::Int | F::Decimal | F::Currency | F::Percent | F::Date | F::Datetime | F::Check => a.clone(),
        _ => json!(display(q, a)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def() -> Definition {
        let rows: Vec<Map<String, Value>> = json!([
            {"key": "name", "label": "Name", "question_type": "short_text", "max_length": 100},
            {"key": "bio", "label": "Bio", "question_type": "long_text"},
            {"key": "mail", "label": "Mail", "question_type": "email"},
            {"key": "kind", "label": "Kind", "question_type": "dropdown", "options": ["Company", "Individual"]},
            {"key": "size", "label": "Size", "question_type": "select", "options": ["Small", "Huge"]},
            {"key": "days", "label": "Days", "question_type": "number"},
            {"key": "tags", "label": "Tags", "question_type": "multi_select", "options": ["A", "B"]},
            {"key": "cv", "label": "CV", "question_type": "file"}
        ])
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_object().unwrap().clone())
        .collect();
        let (d, e) = Definition::parse(&rows, chrono_tz::UTC, false);
        assert!(e.is_empty(), "{e:?}");
        d
    }

    fn f(v: Value) -> FieldDef {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn types_must_fit() {
        let d = def();
        let q = |k: &str| d.question(k).unwrap();
        let data = f(json!({"name": "x", "type": "data"}));
        assert!(compatible(q("name"), &data).is_ok());
        assert!(compatible(q("bio"), &data).is_err(), "long text does not fit a one-line field");
        assert!(compatible(q("bio"), &f(json!({"name": "x", "type": "text"}))).is_ok());
        assert!(compatible(q("tags"), &data).is_ok(), "choices join into text");
        assert!(compatible(q("cv"), &data).is_err());
        assert!(compatible(q("mail"), &f(json!({"name": "x", "type": "email"}))).is_ok());
        assert!(compatible(q("name"), &f(json!({"name": "x", "type": "email"}))).is_err());
        let select = f(json!({"name": "x", "type": "select", "options": ["Company", "Individual"]}));
        assert!(compatible(q("kind"), &select).is_ok());
        assert!(compatible(q("size"), &select).unwrap_err().contains("'Small'"));
        assert!(compatible(q("days"), &f(json!({"name": "x", "type": "int"}))).is_ok());
        assert!(compatible(q("days"), &f(json!({"name": "x", "type": "currency"}))).is_ok());
        assert!(compatible(q("name"), &f(json!({"name": "x", "type": "int"}))).is_err());
        assert!(compatible(q("cv"), &f(json!({"name": "x", "type": "attach"}))).is_ok());
        assert!(compatible(q("kind"), &f(json!({"name": "x", "type": "link", "to": "Customer"}))).unwrap_err().contains("fixed record id"));
    }

    #[test]
    fn inputs_carry_only_answered_fields() {
        let d = def();
        let ent_def: ferrum_meta::EntityDef = serde_json::from_value(json!({"name": "Thing", "label": "Thing", "kind": "master", "fields": [
            {"name": "title", "type": "data"}, {"name": "days", "type": "int"}, {"name": "tags", "type": "text"}, {"name": "cv", "type": "attach"}, {"name": "source", "type": "data"}
        ]}))
        .unwrap();
        let ent = EffEntity {
            def: ent_def,
            package: "x".into(),
            table: "e_thing".into(),
            custom: false,
            storage: Default::default(),
            children: Default::default(),
            exprs: Default::default(),
            workflow: None,
            print_template: None,
        };
        let map = vec![
            MapRow { field: "title".into(), question: Some("name".into()), value: None },
            MapRow { field: "days".into(), question: Some("days".into()), value: None },
            MapRow { field: "tags".into(), question: Some("tags".into()), value: None },
            MapRow { field: "cv".into(), question: Some("cv".into()), value: None },
            MapRow { field: "source".into(), question: None, value: Some("Web form".into()) },
        ];
        let answers = json!({"name": "Asha", "days": 30, "tags": ["A", "B"], "cv": [{"id": "x", "url": "/files/x", "file_name": "cv.pdf"}]});
        let input = input(&d, &ent, &map, answers.as_object().unwrap());
        assert_eq!(Value::Object(input), json!({"title": "Asha", "days": 30, "tags": "A, B", "cv": "/files/x", "source": "Web form"}));
        let partial = super::input(&d, &ent, &map, json!({"name": "Ravi"}).as_object().unwrap());
        assert_eq!(Value::Object(partial), json!({"title": "Ravi", "source": "Web form"}), "unanswered questions set nothing");
    }
}
