//! Conditional logic. `visible_if` is CEL, the language of every Ferrum rule, over `answers`
//! (question key → normalized answer, `null` when unanswered or hidden), `today` and `now` (the
//! workspace's local date and time). A condition may only read questions that come before it, so
//! evaluating in question order is deterministic and no cycle can exist.

use cel::common::ast::{EntryExpr, Expr, IdedExpr, LiteralValue};
use cel::{Context, Program};
use serde_json::Value;
use std::sync::Arc;

pub const MAX_LEN: usize = 1000;
const MAX_NESTING: usize = 16;
/// Loops (`all`, `exists`, `exists_one`, `map`, `filter`) per condition, never one inside another:
/// conditions run on every response, and nested loops over long answers would not be cheap.
const MAX_LOOPS: usize = 2;

#[derive(Clone)]
pub struct Condition {
    program: Arc<Program>,
}

impl std::fmt::Debug for Condition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Condition")
    }
}

/// The values a condition sees.
pub struct Vars<'a> {
    pub answers: &'a Value,
    pub today: &'a str,
    pub now: &'a str,
}

#[derive(Default)]
struct Refs {
    keys: Vec<String>,
    unknown: Vec<String>,
    loops: usize,
    depth: usize,
    deepest: usize,
}

impl Condition {
    /// Compiles `source`, which may read the answers to `earlier` (of all the form's keys, `all`).
    pub fn compile(source: &str, earlier: &[&str], all: &[&str]) -> Result<Condition, String> {
        let source = source.trim();
        if source.is_empty() {
            return Err("the condition is empty".into());
        }
        if source.len() > MAX_LEN {
            return Err(format!("the condition is longer than {MAX_LEN} characters"));
        }
        let mut depth = 0usize;
        for c in source.chars() {
            match c {
                '(' | '[' | '{' => {
                    depth += 1;
                    if depth > MAX_NESTING {
                        return Err(format!("the condition is nested deeper than {MAX_NESTING} levels"));
                    }
                }
                ')' | ']' | '}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
        let program = Program::compile(source).map_err(|e| format!("not a valid CEL expression: {e}"))?;
        let mut refs = Refs::default();
        walk(program.expression(), &mut Vec::new(), &mut refs);
        if let Some(name) = refs.unknown.first() {
            return Err(format!("unknown name '{name}': read answers as answers.<key>"));
        }
        if refs.deepest > 1 {
            return Err("a loop (all, exists, map, filter) cannot contain another loop".into());
        }
        if refs.loops > MAX_LOOPS {
            return Err(format!("at most {MAX_LOOPS} loops (all, exists, map, filter) per condition"));
        }
        for key in &refs.keys {
            if earlier.contains(&key.as_str()) {
                continue;
            }
            return Err(if all.contains(&key.as_str()) {
                format!("answers.{key} is not an earlier question: conditions may only read the answers before them")
            } else {
                format!("there is no question '{key}'")
            });
        }
        Ok(Condition { program: Arc::new(program) })
    }

    /// Whether the condition holds. An evaluation error (comparing an unanswered question, a type
    /// mismatch) counts as false: the question stays hidden until its condition can be met.
    pub fn holds(&self, vars: &Vars<'_>) -> bool {
        let Ok(answers) = cel::to_value(vars.answers) else { return false };
        let mut ctx = Context::default();
        ctx.add_variable_from_value("answers", answers);
        ctx.add_variable_from_value("today", vars.today.to_string());
        ctx.add_variable_from_value("now", vars.now.to_string());
        matches!(self.program.execute(&ctx), Ok(cel::Value::Bool(true)))
    }
}

/// Collects the `answers` keys an expression reads and any other free name it uses.
fn walk(e: &IdedExpr, bound: &mut Vec<String>, refs: &mut Refs) {
    let is_answers = |x: &IdedExpr| matches!(&x.expr, Expr::Ident(n) if n == "answers");
    match &e.expr {
        Expr::Ident(name) => {
            if !matches!(name.as_str(), "answers" | "today" | "now") && !bound.contains(name) {
                refs.unknown.push(name.clone());
            }
        }
        Expr::Select(s) => {
            if is_answers(&s.operand) {
                refs.keys.push(s.field.clone());
            } else {
                walk(&s.operand, bound, refs);
            }
        }
        Expr::Call(c) => {
            if c.func_name == "_[_]" && c.args.len() == 2 && is_answers(&c.args[0]) {
                if let Expr::Literal(LiteralValue::String(k)) = &c.args[1].expr {
                    refs.keys.push(k.inner().to_string());
                }
                walk(&c.args[1], bound, refs);
            } else {
                if let Some(t) = &c.target {
                    walk(t, bound, refs);
                }
                for a in &c.args {
                    walk(a, bound, refs);
                }
            }
        }
        Expr::Comprehension(c) => {
            walk(&c.iter_range, bound, refs);
            refs.loops += 1;
            refs.depth += 1;
            refs.deepest = refs.deepest.max(refs.depth);
            let depth = bound.len();
            bound.push(c.iter_var.clone());
            bound.extend(c.iter_var2.clone());
            bound.push(c.accu_var.clone());
            for x in [&c.accu_init, &c.loop_cond, &c.loop_step, &c.result] {
                walk(x, bound, refs);
            }
            bound.truncate(depth);
            refs.depth -= 1;
        }
        Expr::List(l) => {
            for x in &l.elements {
                walk(x, bound, refs);
            }
        }
        Expr::Map(m) => {
            for en in &m.entries {
                if let EntryExpr::MapEntry(me) = &en.expr {
                    walk(&me.key, bound, refs);
                    walk(&me.value, bound, refs);
                }
            }
        }
        Expr::Struct(s) => {
            for en in &s.entries {
                if let EntryExpr::StructField(f) = &en.expr {
                    walk(&f.value, bound, refs);
                }
            }
        }
        Expr::Literal(_) | Expr::Unspecified => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn holds(src: &str, earlier: &[&str], answers: Value) -> bool {
        let c = Condition::compile(src, earlier, earlier).unwrap_or_else(|e| panic!("{src}: {e}"));
        c.holds(&Vars { answers: &answers, today: "2026-10-29", now: "2026-10-29T10:00:00Z" })
    }

    #[test]
    fn evaluates_over_answers() {
        let a = json!({"country": "IN", "age": 20, "budget": 1500.5, "colors": ["red", "blue"], "agree": true, "grid": {"Speed": "Good"}, "name": null});
        let keys = ["country", "age", "budget", "colors", "agree", "grid", "name"];
        assert!(holds("answers.country == 'IN' && answers.age >= 18", &keys, a.clone()));
        assert!(!holds("answers.age < 18", &keys, a.clone()));
        assert!(holds("answers.budget > 1000.0", &keys, a.clone()));
        assert!(holds("'red' in answers.colors && size(answers.colors) == 2", &keys, a.clone()));
        assert!(holds("answers.colors.exists(c, c == 'blue')", &keys, a.clone()));
        assert!(holds("answers.agree", &keys, a.clone()));
        assert!(holds("answers.grid['Speed'] == 'Good'", &keys, a.clone()));
        assert!(holds("answers['country'] == 'IN'", &keys, a.clone()));
        assert!(holds("answers.name == null", &keys, a.clone()));
        assert!(!holds("answers.name > 3", &keys, a.clone()), "an error (null compared with a number) is false");
        assert!(holds("today == '2026-10-29'", &keys, a.clone()));
        assert!(!holds("answers.country", &keys, a), "a non-boolean result is false");
    }

    #[test]
    fn refuses_bad_or_forward_references() {
        let all = ["a", "b", "c"];
        let err = |src: &str, earlier: &[&str]| Condition::compile(src, earlier, &all).unwrap_err();
        assert!(err("answers.c == 1", &["a", "b"]).contains("not an earlier question"));
        assert!(err("answers.zzz == 1", &["a", "b"]).contains("no question 'zzz'"));
        assert!(err("answers['zzz'] == 1", &["a"]).contains("no question 'zzz'"));
        assert!(err("doc.a == 1", &["a"]).contains("unknown name 'doc'"));
        assert!(err("answers.a ==", &["a"]).contains("not a valid CEL"));
        assert!(err("  ", &["a"]).contains("empty"));
        assert!(err(&"(".repeat(20), &["a"]).contains("nested"));
        assert!(Condition::compile("[1, 2].all(x, x > 0) && has(answers.a)", &["a"], &all).is_ok(), "loop variables are bound");
        assert!(Condition::compile("answers.b.exists(x, x == answers.a)", &["a", "b"], &all).is_ok());
        assert!(err("answers.b.exists(x, answers.b.exists(y, x == y))", &["a", "b"]).contains("cannot contain another loop"));
        assert!(err("answers.b.exists(x, x == 1) && answers.b.all(x, x > 0) && answers.b.exists(x, x == 2)", &["a", "b"]).contains("at most 2 loops"));
    }
}
