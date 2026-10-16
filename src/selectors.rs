//! Inline selector syntax: parsing + evaluation.
//!
//! A query is a glob pattern followed by zero or more selectors:
//!   src/**/*.ts :contains("export const") :size(<100kb) :modified(>2026-10-01)
//!
//! Supported selectors:
//!   :contains("literal")      byte substring search (memchr::memmem)
//!   :contains(/regex/)        regex byte search
//!   :matches("regex")         regex byte search
//!   :exports(name)            export-signature check (light AST inspection)
//!   :has-key("a.b.c")         dotted JSON key path exists
//!   :size(<100kb)             metadata filter, ops < <= > >= = ; units b/kb/mb/gb/kib/mib/gib
//!   :modified(>2026-10-01)    metadata filter on mtime (UTC), ops as above

use regex::bytes::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CmpOp {
    Lt,
    Lte,
    Gt,
    Gte,
    Eq,
}

impl CmpOp {
    pub fn apply_u64(&self, v: u64, target: u64) -> bool {
        match self {
            CmpOp::Lt => v < target,
            CmpOp::Lte => v <= target,
            CmpOp::Gt => v > target,
            CmpOp::Gte => v >= target,
            CmpOp::Eq => v == target,
        }
    }
    pub fn apply_i64(&self, v: i64, target: i64) -> bool {
        match self {
            CmpOp::Lt => v < target,
            CmpOp::Lte => v <= target,
            CmpOp::Gt => v > target,
            CmpOp::Gte => v >= target,
            CmpOp::Eq => v == target,
        }
    }
}

#[derive(Debug, Clone)]
pub enum Selector {
    ContainsLiteral(Vec<u8>),
    ContainsRegex(Regex),
    Exports(String, Regex),
    HasKey(Vec<String>),
    Size(CmpOp, u64),
    Modified(CmpOp, i64), // epoch milliseconds (UTC)
}

impl Selector {
    pub fn needs_content(&self) -> bool {
        matches!(
            self,
            Selector::ContainsLiteral(_)
                | Selector::ContainsRegex(_)
                | Selector::Exports(..)
                | Selector::HasKey(_)
        )
    }

    /// Evaluate a content selector against raw file bytes.
    pub fn eval_content(&self, bytes: &[u8]) -> bool {
        match self {
            Selector::ContainsLiteral(needle) => {
                !needle.is_empty() && memchr::memmem::find(bytes, needle).is_some()
            }
            Selector::ContainsRegex(re) => re.is_match(bytes),
            Selector::Exports(_, re) => re.is_match(bytes),
            Selector::HasKey(path) => eval_has_key(bytes, path),
            _ => true,
        }
    }

    pub fn eval_metadata(&self, size: u64, modified_ms: i64) -> bool {
        match self {
            Selector::Size(op, target) => op.apply_u64(size, *target),
            Selector::Modified(op, target) => op.apply_i64(modified_ms, *target),
            _ => true,
        }
    }
}

fn eval_has_key(bytes: &[u8], path: &[String]) -> bool {
    let value: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let mut cur = &value;
    for seg in path {
        match cur {
            serde_json::Value::Object(map) => match map.get(seg) {
                Some(v) => cur = v,
                None => return false,
            },
            serde_json::Value::Array(arr) => match seg.parse::<usize>() {
                Ok(i) => match arr.get(i) {
                    Some(v) => cur = v,
                    None => return false,
                },
                Err(_) => return false,
            },
            _ => return false,
        }
    }
    true
}

/// Split a query string into whitespace-separated tokens that are not
/// inside quotes or parentheses.
fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            cur.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                cur.push(c);
            }
            '(' => {
                depth += 1;
                cur.push(c);
            }
            ')' => {
                depth -= 1;
                cur.push(c);
            }
            c if c.is_whitespace() && depth <= 0 => {
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

/// Strip surrounding quotes (or /regex/ slashes) from a selector argument.
fn unquote(raw: &str) -> (String, bool) {
    let s = raw.trim();
    if s.len() >= 2 && s.starts_with('/') && s.ends_with('/') {
        return (s[1..s.len() - 1].to_string(), true);
    }
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')))
    {
        let inner = &s[1..s.len() - 1];
        let unescaped = inner.replace("\\\"", "\"").replace("\\'", "'").replace("\\\\", "\\");
        return (unescaped, false);
    }
    (s.to_string(), false)
}

fn parse_op(s: &str) -> Result<(CmpOp, &str), String> {
    if let Some(r) = s.strip_prefix("<=") {
        Ok((CmpOp::Lte, r))
    } else if let Some(r) = s.strip_prefix(">=") {
        Ok((CmpOp::Gte, r))
    } else if let Some(r) = s.strip_prefix('<') {
        Ok((CmpOp::Lt, r))
    } else if let Some(r) = s.strip_prefix('>') {
        Ok((CmpOp::Gt, r))
    } else if let Some(r) = s.strip_prefix("==") {
        Ok((CmpOp::Eq, r))
    } else if let Some(r) = s.strip_prefix('=') {
        Ok((CmpOp::Eq, r))
    } else {
        Err(format!("selector comparison needs an operator (<, <=, >, >=, =): {s}"))
    }
}

pub fn parse_size(raw: &str) -> Result<u64, String> {
    let s = raw.trim().to_ascii_lowercase();
    let (num_str, mult): (&str, f64) = if let Some(p) = s.strip_suffix("kib") {
        (p, 1024.0)
    } else if let Some(p) = s.strip_suffix("mib") {
        (p, 1024.0 * 1024.0)
    } else if let Some(p) = s.strip_suffix("gib") {
        (p, 1024.0 * 1024.0 * 1024.0)
    } else if let Some(p) = s.strip_suffix("kb") {
        (p, 1024.0)
    } else if let Some(p) = s.strip_suffix("mb") {
        (p, 1024.0 * 1024.0)
    } else if let Some(p) = s.strip_suffix("gb") {
        (p, 1024.0 * 1024.0 * 1024.0)
    } else if let Some(p) = s.strip_suffix('k') {
        (p, 1024.0)
    } else if let Some(p) = s.strip_suffix('m') {
        (p, 1024.0 * 1024.0)
    } else if let Some(p) = s.strip_suffix('g') {
        (p, 1024.0 * 1024.0 * 1024.0)
    } else if let Some(p) = s.strip_suffix('b') {
        (p, 1.0)
    } else {
        (s.as_str(), 1.0)
    };
    let n: f64 = num_str
        .trim()
        .parse()
        .map_err(|_| format!("invalid size value: {raw}"))?;
    Ok((n * mult) as u64)
}

/// Days from civil date (Howard Hinnant's algorithm), proleptic Gregorian.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y_adj = if m <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Parse `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS` (UTC) to epoch milliseconds.
pub fn parse_date_ms(raw: &str) -> Result<i64, String> {
    let s = raw.trim();
    let (date_part, time_part) = match s.split_once(['T', ' ']) {
        Some((d, t)) => (d, Some(t)),
        None => (s, None),
    };
    let mut it = date_part.split('-');
    let year: i64 = it
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("invalid date: {raw}"))?;
    let month: i64 = it
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("invalid date: {raw}"))?;
    let day: i64 = it
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("invalid date: {raw}"))?;
    let mut secs = days_from_civil(year, month, day) * 86_400;
    if let Some(t) = time_part {
        let t = t.trim_end_matches('Z');
        let mut tit = t.split(':');
        let hh: i64 = tit.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let mm: i64 = tit.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let ss: i64 = tit
            .next()
            .and_then(|v| v.parse::<f64>().ok())
            .map(|v| v as i64)
            .unwrap_or(0);
        secs += hh * 3600 + mm * 60 + ss;
    }
    Ok(secs * 1000)
}

fn build_exports_regex(name: &str) -> Result<Regex, String> {
    if name == "default" {
        return Regex::new(r"export\s+default\b").map_err(|e| e.to_string());
    }
    let esc = regex::escape(name);
    let pat = format!(
        r"export\s+(?:const|let|var|function|class|interface|type|enum|abstract\s+class)\s+\**{esc}\b|export\s*\{{[^}}]*\b{esc}\b[^}}]*\}}"
    );
    Regex::new(&pat).map_err(|e| e.to_string())
}

pub fn parse_selector(token: &str) -> Result<Selector, String> {
    let body = token
        .strip_prefix(':')
        .ok_or_else(|| format!("not a selector: {token}"))?;
    let open = body
        .find('(')
        .ok_or_else(|| format!("selector needs (...): {token}"))?;
    if !body.ends_with(')') {
        return Err(format!("selector needs closing ): {token}"));
    }
    let name = &body[..open];
    let arg_raw = &body[open + 1..body.len() - 1];
    match name {
        "contains" => {
            let (arg, is_slashes) = unquote(arg_raw);
            if is_slashes || arg.starts_with("regex:") {
                let pat = arg.strip_prefix("regex:").unwrap_or(&arg);
                let re = Regex::new(pat).map_err(|e| format!("bad regex in :contains: {e}"))?;
                Ok(Selector::ContainsRegex(re))
            } else {
                Ok(Selector::ContainsLiteral(arg.into_bytes()))
            }
        }
        "matches" | "regex" => {
            let (arg, _) = unquote(arg_raw);
            let re = Regex::new(&arg).map_err(|e| format!("bad regex in :{name}: {e}"))?;
            Ok(Selector::ContainsRegex(re))
        }
        "exports" | "export" => {
            let (arg, _) = unquote(arg_raw);
            let re = build_exports_regex(&arg)?;
            Ok(Selector::Exports(arg, re))
        }
        "has-key" | "haskey" | "hasKey" => {
            let (arg, _) = unquote(arg_raw);
            let path: Vec<String> = arg.split('.').map(|s| s.to_string()).collect();
            if path.iter().any(|s| s.is_empty()) {
                return Err(format!("invalid key path in :has-key: {arg}"));
            }
            Ok(Selector::HasKey(path))
        }
        "size" => {
            let (op, rest) = parse_op(arg_raw.trim())?;
            Ok(Selector::Size(op, parse_size(rest)?))
        }
        "modified" | "mtime" => {
            let (arg, _) = unquote(arg_raw);
            let (op, rest) = parse_op(arg.trim())?;
            Ok(Selector::Modified(op, parse_date_ms(rest)?))
        }
        other => Err(format!("unknown selector :{other}")),
    }
}

/// A parsed query: positive glob patterns, negative patterns, selectors.
#[derive(Debug, Clone)]
pub struct Query {
    pub patterns: Vec<String>,
    pub negatives: Vec<String>,
    pub selectors: Vec<Selector>,
}

pub fn parse_query(input: &str) -> Result<Query, String> {
    let mut patterns = Vec::new();
    let mut negatives = Vec::new();
    let mut selectors = Vec::new();
    for token in tokenize(input) {
        if let Some(sel) = token.strip_prefix(':') {
            let _ = sel;
            selectors.push(parse_selector(&token)?);
        } else if let Some(neg) = token.strip_prefix('!') {
            negatives.push(neg.to_string());
        } else {
            patterns.push(token);
        }
    }
    if patterns.is_empty() && negatives.is_empty() {
        return Err(format!("query has no glob pattern: {input}"));
    }
    Ok(Query {
        patterns,
        negatives,
        selectors,
    })
}

pub fn parse_queries(inputs: &[String]) -> Result<Query, String> {
    let mut merged = Query {
        patterns: Vec::new(),
        negatives: Vec::new(),
        selectors: Vec::new(),
    };
    for input in inputs {
        let q = parse_query(input)?;
        merged.patterns.extend(q.patterns);
        merged.negatives.extend(q.negatives);
        merged.selectors.extend(q.selectors);
    }
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_prd_query() {
        let q = parse_query(r#"src/**/*.ts :contains("useServerHook")"#).unwrap();
        assert_eq!(q.patterns, vec!["src/**/*.ts".to_string()]);
        assert_eq!(q.selectors.len(), 1);
        assert!(matches!(q.selectors[0], Selector::ContainsLiteral(_)));
    }

    #[test]
    fn parses_size() {
        let q = parse_query("src/**/* :size(<100kb)").unwrap();
        match &q.selectors[0] {
            Selector::Size(CmpOp::Lt, n) => assert_eq!(*n, 100 * 1024),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_modified() {
        let q = parse_query("src/**/* :modified(>2026-10-01)").unwrap();
        match &q.selectors[0] {
            Selector::Modified(CmpOp::Gt, ms) => {
                // 2026-10-01T00:00:00Z
                assert_eq!(*ms, 1_790_812_800_000);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_has_key_and_negatives() {
        let q = parse_query(r#"src/**/*.json :has-key("dependencies.react")"#).unwrap();
        assert!(matches!(q.selectors[0], Selector::HasKey(_)));
        let q2 = parse_queries(&[
            "src/**/*.ts".to_string(),
            "!src/**/*.test.ts".to_string(),
        ])
        .unwrap();
        assert_eq!(q2.negatives, vec!["src/**/*.test.ts".to_string()]);
    }

    #[test]
    fn exports_detection() {
        let q = parse_query(r#"src/**/*.ts :exports("useServerHook")"#).unwrap();
        let sel = &q.selectors[0];
        assert!(sel.eval_content(b"export const useServerHook = () => {}"));
        assert!(sel.eval_content(b"export function useServerHook() {}"));
        assert!(sel.eval_content(b"const x = 1;\nexport { useServerHook };\n"));
        assert!(!sel.eval_content(b"const useServerHook = () => {}"));
        assert!(!sel.eval_content(b"export const useServerHookExtra = 1"));
    }

    #[test]
    fn has_key_detection() {
        let q = parse_query(r#"x.json :has-key("dependencies.react")"#).unwrap();
        let sel = &q.selectors[0];
        assert!(sel.eval_content(br#"{"dependencies":{"react":"19"}}"#));
        assert!(!sel.eval_content(br#"{"dependencies":{"vue":"3"}}"#));
        assert!(!sel.eval_content(b"not json"));
    }

    #[test]
    fn date_epoch() {
        assert_eq!(parse_date_ms("1970-01-01").unwrap(), 0);
        assert_eq!(parse_date_ms("2026-10-01").unwrap(), 1_790_812_800_000);
    }
}
