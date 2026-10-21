//! Inline selector syntax: parsing + evaluation.
//!
//! A query is a glob pattern followed by zero or more selectors:
//!   src/**/*.ts :contains("export const") :size(<100kb) :modified(>2026-10-01)
//!
//! Supported selectors:
//!   :contains("literal")      byte substring search (memchr::memmem)
//!   :contains(/regex/)        regex byte search
//!   :matches("regex")         regex byte search
//!   :exports(name)            full AST export check (oxc_parser) for JS/TS files,
//!                             regex signature fallback for other/unparseable files
//!   :imports(name)            AST import check (also matches subpaths: name/*)
//!   :has-key("a.b.c")         dotted JSON key path exists
//!   :size(<100kb)             metadata filter, ops < <= > >= = ; units b/kb/mb/gb/kib/mib/gib
//!   :modified(>2026-10-01)    metadata filter on mtime (UTC), ops as above

use regex::bytes::Regex;
use std::collections::HashSet;

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
    Exports(String),
    Imports(String),
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
                | Selector::Imports(..)
                | Selector::HasKey(_)
        )
    }

    /// Evaluate a content selector against raw file bytes (assumes a `.ts`
    /// source type for AST selectors; the engine passes the real extension).
    #[cfg(test)]
    pub fn eval_content(&self, bytes: &[u8]) -> bool {
        let mut ctx = FileContext::new(bytes, "ts");
        self.eval_with(&mut ctx)
    }

    /// Evaluate a content selector against an already-built file context.
    /// The context memoizes the AST parse, so a query carrying both
    /// `:exports` and `:imports` parses the file only once.
    pub fn eval_with(&self, ctx: &mut FileContext<'_>) -> bool {
        match self {
            Selector::ContainsLiteral(needle) => {
                !needle.is_empty() && memchr::memmem::find(ctx.bytes, needle).is_some()
            }
            Selector::ContainsRegex(re) => re.is_match(ctx.bytes),
            Selector::Exports(name) => match ctx.module_info() {
                Some((exports, _)) => exports.contains(name),
                // The file could not be parsed at all. Fall back to a regex
                // signature over a *masked* copy of the source in which
                // comment and string-literal contents are blanked out, so
                // export-shaped text that only exists inside a comment or a
                // string cannot produce a false positive.
                None => match build_exports_regex(name) {
                    Ok(re) => re.is_match(ctx.masked_source().as_bytes()),
                    Err(_) => false,
                },
            },
            Selector::Imports(name) => ctx
                .module_sources()
                .iter()
                .any(|src| src == name || src.starts_with(&format!("{name}/"))),
            Selector::HasKey(path) => eval_has_key(ctx.bytes, path),
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

/// Per-file evaluation context.
///
/// It memoizes the AST parse and the module-specifier set, so a query that
/// carries both `:exports` and `:imports` reads and parses each file at most
/// once.
pub struct FileContext<'a> {
    bytes: &'a [u8],
    ext: String,
    module: Option<Option<(HashSet<String>, HashSet<String>)>>,
    masked: Option<String>,
    sources: Option<Vec<String>>,
}

impl<'a> FileContext<'a> {
    pub fn new(bytes: &'a [u8], ext: &str) -> Self {
        FileContext {
            bytes,
            ext: ext.to_string(),
            module: None,
            masked: None,
            sources: None,
        }
    }

    /// The AST module info, or None when the file could not be parsed.
    fn module_info(&mut self) -> Option<&(HashSet<String>, HashSet<String>)> {
        if self.module.is_none() {
            self.module = Some(ast_module_info(self.bytes, &self.ext));
        }
        self.module.as_ref().and_then(|m| m.as_ref())
    }

    /// The source with comment and string-literal contents blanked out.
    fn masked_source(&mut self) -> &str {
        if self.masked.is_none() {
            self.masked = Some(scan_js(self.bytes).mask);
        }
        self.masked.as_deref().unwrap_or("")
    }

    /// Every module specifier the file depends on, sorted and de-duplicated.
    ///
    /// The authoritative source is the AST plus the token stream: comments
    /// and string literals cannot masquerade as import sites. Only when the
    /// file cannot be parsed *or* lexed at all do we fall back to a masked
    /// regex scan, which blanks out comments and strings first.
    fn module_sources(&mut self) -> &[String] {
        if self.sources.is_none() {
            let mut v: Vec<String> = Vec::new();
            if let Some((_, imports)) = self.module_info() {
                v.extend(imports.iter().cloned());
            } else {
                let mut calls = HashSet::new();
                if collect_call_sources(self.bytes, &self.ext, &mut calls) {
                    v.extend(calls);
                } else {
                    // Last resort: masked regex scan.
                    let masked = self.masked_source().to_string();
                    static RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
                        Regex::new(
                            r#"(?:from\s+|import\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]"#,
                        )
                        .unwrap()
                    });
                    v.extend(
                        RE.captures_iter(masked.as_bytes())
                            .filter_map(|cap| cap.get(1))
                            .map(|m| String::from_utf8_lossy(m.as_bytes()).into_owned()),
                    );
                }
            }
            v.sort();
            v.dedup();
            self.sources = Some(v);
        }
        self.sources.as_deref().unwrap_or(&[])
    }
}

/// Parse a JS/TS module with oxc and collect (exported names, import
/// sources). Exported names include "default" for default exports and the
/// declared names behind `export default function foo() {}` / re-export
/// specifiers (`export { a as b }` exports `b`).
///
/// Returns None when the extension is not JS/TS, the bytes are not UTF-8,
/// or the parser hit a *fatal* error (it could not produce a usable AST) Ã¢â‚¬â€
/// callers then fall back to a masked regex signature. Recoverable syntax
/// errors still yield a usable AST, so a single stray token does not
/// downgrade an entire file to the heuristic path.
pub fn ast_module_info(bytes: &[u8], ext: &str) -> Option<(HashSet<String>, HashSet<String>)> {
    use oxc_ast::ast::*;
    let dummy = format!("file.{ext}");
    let source_type = oxc_span::SourceType::from_path(std::path::Path::new(&dummy)).ok()?;
    let text = std::str::from_utf8(bytes).ok()?;
    let allocator = oxc_allocator::Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, text, source_type).parse();
    if parsed.fatal_error {
        return None;
    }

    fn exported_name(name: &ModuleExportName) -> String {
        match name {
            ModuleExportName::IdentifierName(id) => id.name.as_str().to_string(),
            ModuleExportName::IdentifierReference(id) => id.name.as_str().to_string(),
            ModuleExportName::StringLiteral(lit) => lit.value.as_str().to_string(),
        }
    }

    fn decl_names(decl: &Declaration, out: &mut HashSet<String>) {
        match decl {
            Declaration::FunctionDeclaration(f) => {
                if let Some(id) = &f.id {
                    out.insert(id.name.as_str().to_string());
                }
            }
            Declaration::ClassDeclaration(c) => {
                if let Some(id) = &c.id {
                    out.insert(id.name.as_str().to_string());
                }
            }
            Declaration::VariableDeclaration(v) => {
                for declarator in &v.declarations {
                    for id in declarator.id.get_binding_identifiers() {
                        out.insert(id.name.as_str().to_string());
                    }
                }
            }
            Declaration::TSInterfaceDeclaration(i) => {
                out.insert(i.id.name.as_str().to_string());
            }
            Declaration::TSTypeAliasDeclaration(t) => {
                out.insert(t.id.name.as_str().to_string());
            }
            Declaration::TSEnumDeclaration(e) => {
                out.insert(e.id.name.as_str().to_string());
            }
            Declaration::TSImportEqualsDeclaration(ie) => {
                out.insert(ie.id.name.as_str().to_string());
            }
            Declaration::TSNamespaceDeclaration(ns) => {
                out.insert(ns.id.name.as_str().to_string());
            }
            _ => {}
        }
    }

    let mut exports: HashSet<String> = HashSet::new();
    let mut imports: HashSet<String> = HashSet::new();
    for stmt in &parsed.program.body {
        match stmt {
            Statement::ImportDeclaration(decl) => {
                imports.insert(decl.source.value.as_str().to_string());
            }
            Statement::ExportDeclaration(decl) => {
                decl_names(&decl.declaration, &mut exports);
            }
            Statement::ExportNamedDeclaration(decl) => {
                for spec in &decl.specifiers {
                    exports.insert(exported_name(&spec.exported));
                }
            }
            Statement::ExportFromDeclaration(decl) => {
                for spec in &decl.specifiers {
                    exports.insert(exported_name(&spec.exported));
                }
                // A re-export is also a module dependency.
                imports.insert(decl.source.value.as_str().to_string());
            }
            Statement::ExportDefaultDeclaration(decl) => {
                exports.insert("default".to_string());
                match &decl.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                        if let Some(id) = &f.id {
                            exports.insert(id.name.as_str().to_string());
                        }
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(c) => {
                        if let Some(id) = &c.id {
                            exports.insert(id.name.as_str().to_string());
                        }
                    }
                    ExportDefaultDeclarationKind::TSInterfaceDeclaration(i) => {
                        exports.insert(i.id.name.as_str().to_string());
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    // Static `import`/`export ... from` specifiers are AST nodes; the
    // `require(...)` / `import(...)` call forms are collected from the token
    // stream below.
    let mut calls = HashSet::new();
    if collect_call_sources(bytes, ext, &mut calls) {
        imports.extend(calls);
    }
    Some((exports, imports))
}

/// Collect module specifiers from `require(...)` and dynamic `import(...)`
/// calls using oxc's *token* stream.
///
/// Working at the token level (rather than with a regex over raw bytes) is
/// what makes this exact: comments are lexed as trivia and therefore never
/// appear in the token stream, and a string literal is a single `Str` token
/// rather than a sequence of source characters. A file that merely *mentions*
/// `require('react')` inside a comment or a string is therefore correctly
/// reported as not importing react.
///
/// Returns false when the source cannot be lexed at all, in which case the
/// caller falls back to a masked regex signature.
fn collect_call_sources(bytes: &[u8], ext: &str, out: &mut HashSet<String>) -> bool {
    use oxc_parser::Kind;

    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let source_type =
        match oxc_span::SourceType::from_path(std::path::Path::new(&format!("file.{}", ext))) {
            Ok(s) => s,
            Err(_) => return false,
        };
    let allocator = oxc_allocator::Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, text, source_type)
        .with_config(oxc_parser::config::TokensParserConfig)
        .parse();

    // `tokens` is in source order and excludes trivia (comments).
    let tokens = &parsed.tokens;
    let n = tokens.len();
    let mut i = 0usize;
    while i < n {
        match tokens[i].kind() {
            // `import ... from 'x'` and `export ... from 'x'`: the module
            // specifier is the `Str` token right after `from`.
            Kind::From => {
                if !is_member_access(tokens, i) {
                    if let Some(src) = string_at(tokens, i + 1, text) {
                        out.insert(src);
                    }
                }
                i += 1;
            }
            // `import 'x'` (side-effect import) and dynamic `import('x')`.
            //
            // A `Str` token directly after `import` is a side-effect import
            // (`import 'x'`). A dynamic import is `import` followed by `(`,
            // so the specifier is the `Str` after the paren. Either way the
            // specifier is the next `Str` token, which we find by skipping
            // the paren.
            Kind::Import => {
                if !is_member_access(tokens, i) {
                    let mut j = i + 1;
                    if j < n && tokens[j].kind() == Kind::LParen {
                        j += 1;
                    }
                    if let Some(src) = string_at(tokens, j, text) {
                        out.insert(src);
                    }
                }
                i += 1;
            }
            // `require('x')`: a `Str` token right after `require` and `(`.
            //
            // `require` is a contextual keyword, so it is also lexed as a
            // plain identifier when used as a property name (`obj.require`).
            // We therefore require the `(` to follow, and require that the
            // `require` token is *not* preceded by `.` (a member access).
            Kind::Require => {
                if !is_member_access(tokens, i) {
                    let mut j = i + 1;
                    if j < n && tokens[j].kind() == Kind::LParen {
                        j += 1;
                        if let Some(src) = string_at(tokens, j, text) {
                            out.insert(src);
                        }
                    }
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    true
}

/// True when the token at `at` is a property name in a member access
/// (`obj.import`, `obj?.import`, `obj.from`). Such a token is a plain
/// identifier, not the `import`/`from` keyword, so it must not start a
/// module specifier.
fn is_member_access(tokens: &[oxc_parser::Token], at: usize) -> bool {
    if at == 0 {
        return false;
    }
    matches!(
        tokens[at - 1].kind(),
        oxc_parser::Kind::Dot | oxc_parser::Kind::QuestionDot
    )
}

/// The value of the string-literal token at index `at`, if that token is a
/// string literal. The token span covers the quotes, which are stripped.
fn string_at(tokens: &[oxc_parser::Token], at: usize, text: &str) -> Option<String> {
    let tok = tokens.get(at)?;
    if tok.kind() != oxc_parser::Kind::Str {
        return None;
    }
    let span = tok.span();
    let start = span.start as usize;
    let end = span.end as usize;
    let raw = text.get(start..end)?;
    // Strip the surrounding quotes.
    let trimmed = raw
        .strip_prefix('"')
        .or_else(|| raw.strip_prefix('\''))
        .and_then(|s| s.strip_suffix('"').or_else(|| s.strip_suffix('\'')));
    trimmed.map(|s| s.to_string())
}

/// A JavaScript-ish source with comment and string-literal contents blanked
/// out. Used by the regex fallback so that export/import-shaped text living
/// inside a comment or a string cannot produce a false positive.
struct MaskedSource {
    mask: String,
}

/// Blank out the contents of comments and string/template literals, keeping
/// the surrounding structure (and byte offsets) intact.
fn scan_js(bytes: &[u8]) -> MaskedSource {
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0usize;
    let n = bytes.len();
    while i < n {
        let c = bytes[i];
        match c {
            b'/' if i + 1 < n && bytes[i + 1] == b'/' => {
                // Line comment: blank to end of line.
                while i < n && bytes[i] != b'\n' {
                    out.push(' ');
                    i += 1;
                }
            }
            b'/' if i + 1 < n && bytes[i + 1] == b'*' => {
                // Block comment: blank to the closing */.
                out.push(' ');
                out.push(' ');
                i += 2;
                while i < n {
                    if bytes[i] == b'*' && i + 1 < n && bytes[i + 1] == b'/' {
                        out.push(' ');
                        out.push(' ');
                        i += 2;
                        break;
                    }
                    out.push(if bytes[i] == b'\n' { '\n' } else { ' ' });
                    i += 1;
                }
            }
            b'"' | b'\'' | b'`' => {
                // String / template literal: blank the contents but keep the
                // quotes so a regex looking for `require('x')` still needs a
                // real call site to match.
                let quote = c;
                out.push(quote as char);
                i += 1;
                while i < n {
                    let d = bytes[i];
                    if d == b'\\' && i + 1 < n {
                        out.push(' ');
                        out.push(' ');
                        i += 2;
                        continue;
                    }
                    if d == quote {
                        out.push(quote as char);
                        i += 1;
                        break;
                    }
                    out.push(if d == b'\n' { '\n' } else { ' ' });
                    i += 1;
                }
            }
            _ => {
                // Copy a whole UTF-8 char.
                let start = i;
                let len = utf8_len(c);
                i = (i + len).min(n);
                out.push_str(&String::from_utf8_lossy(&bytes[start..i]));
            }
        }
    }
    MaskedSource { mask: out }
}

fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else if b >> 3 == 0b11110 {
        4
    } else {
        1
    }
}

fn build_imports_regex(name: &str) -> Result<Regex, String> {
    let esc = regex::escape(name);
    let pat = format!(r#"(?:from\s+|import\s+|require\(\s*|import\(\s*)['"]{esc}(?:/[^'"]*)?['"]"#);
    Regex::new(&pat).map_err(|e| e.to_string())
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
        let unescaped = inner
            .replace("\\\"", "\"")
            .replace("\\'", "'")
            .replace("\\\\", "\\");
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
        Err(format!(
            "selector comparison needs an operator (<, <=, >, >=, =): {s}"
        ))
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
            if arg.is_empty() {
                return Err("empty name in :exports".to_string());
            }
            // Validate the fallback signature eagerly so a bad name is
            // reported at parse time rather than silently never matching.
            build_exports_regex(&arg)?;
            Ok(Selector::Exports(arg))
        }
        "imports" | "import" => {
            let (arg, _) = unquote(arg_raw);
            if arg.is_empty() {
                return Err("empty name in :imports".to_string());
            }
            build_imports_regex(&arg)?;
            Ok(Selector::Imports(arg))
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
        let q2 =
            parse_queries(&["src/**/*.ts".to_string(), "!src/**/*.test.ts".to_string()]).unwrap();
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
    fn exports_ast_no_false_positives() {
        // The v0.1/v0.2 regex matched export-shaped text inside comments and
        // strings; the AST must not.
        let q = parse_query(r#"src/**/*.ts :exports("ghost")"#).unwrap();
        let sel = &q.selectors[0];
        assert!(!sel.eval_content(b"// export const ghost = 1;\nconst x = 1;\n"));
        assert!(!sel.eval_content(b"const s = \"export const ghost = 1\";\n"));
        assert!(!sel.eval_content(b"/* export function ghost() {} */\n"));
        // Real forms the regex missed or handled fragilely:
        assert!(sel.eval_content(b"const g = 1;\nexport { g as ghost };\n"));
        assert!(sel.eval_content(b"export { g as ghost } from './impl';\n"));
        assert!(sel.eval_content(b"export default function ghost() {}\n"));
        let qd = parse_query(r#"src/**/*.ts :exports("default")"#).unwrap();
        assert!(qd.selectors[0].eval_content(b"export default function ghost() {}\n"));
        assert!(qd.selectors[0].eval_content(b"const g = 1;\nexport default g;\n"));
    }

    #[test]
    fn imports_detection() {
        let q = parse_query(r#"src/**/*.ts :imports("react")"#).unwrap();
        let sel = &q.selectors[0];
        assert!(sel.eval_content(b"import { useState } from 'react';\n"));
        assert!(sel.eval_content(b"import 'react/jsx-runtime';\n"));
        assert!(sel.eval_content(b"const r = require('react');\n"));
        assert!(!sel.eval_content(b"import { x } from 'preact';\n"));
        assert!(!sel.eval_content(b"// import { x } from 'react';\nconst y = 1;\n"));
        assert!(!sel.eval_content(b"const s = \"from 'react'\";\n"));
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
