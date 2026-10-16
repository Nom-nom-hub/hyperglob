//! Import-graph queries: who depends on a given file?
//!
//! Builds the relative-import graph over all JS/TS files under cwd (one
//! parallel AST pass), then walks it backwards from the target: the answer
//! is every file that imports the target directly or transitively — the
//! "what breaks if I change this file" set an agent actually needs.

use crate::engine::{Engine, Options};
use crate::selectors::ast_module_info;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};

const JS_EXTS: [&str; 8] = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"];
const RESOLVE_EXTS: [&str; 9] = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs", "json"];

/// Import-source extraction for files the AST can't parse (notably
/// Flow-typed sources, which oxc rejects): same fallback the :imports
/// selector uses, in capture form.
fn fallback_import_sources(bytes: &[u8]) -> Vec<String> {
    static RE: std::sync::LazyLock<regex::bytes::Regex> = std::sync::LazyLock::new(|| {
        regex::bytes::Regex::new(r#"(?:from\s+|import\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]"#)
            .unwrap()
    });
    let mut out = Vec::new();
    for cap in RE.captures_iter(bytes) {
        if let Some(m) = cap.get(1) {
            out.push(String::from_utf8_lossy(m.as_bytes()).into_owned());
        }
    }
    out
}

fn ext_of(rel: &str) -> &str {
    rel.rsplit('.').next().unwrap_or("")
}

fn is_js(rel: &str) -> bool {
    JS_EXTS.contains(&ext_of(rel))
}

/// Lexically normalize a posix relative path (`.` / `..` segments).
fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

fn stem_of(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rfind('.') {
        Some(d) if d > 0 => name[..d].to_string(),
        _ => name.to_string(),
    }
}

/// Resolve a bare (non-relative) specifier like 'shared/ReactSymbols'
/// against repo files by path-suffix match — the monorepo/haste style.
/// Ambiguity (two files with the same tail) is broken by the longest
/// directory prefix shared with the importer, then by shortest path.
fn resolve_bare(
    importer_rel: &str,
    source: &str,
    by_stem: &HashMap<String, Vec<String>>,
) -> Option<String> {
    let stem = stem_of(source);
    let cands = by_stem.get(&stem)?;
    let src_noext = {
        let s = stem_of(source);
        match source.rfind('/') {
            Some(i) => format!("{}/{}", &source[..i], s),
            None => s,
        }
    };
    let importer_dir: Vec<&str> = importer_rel.split('/').collect();
    let mut best: Option<(usize, usize, &String)> = None; // (prefix score, -len, rel)
    for cand in cands {
        let cand_noext = {
            let s = stem_of(cand);
            match cand.rfind('/') {
                Some(i) => format!("{}/{}", &cand[..i], s),
                None => s,
            }
        };
        if cand_noext != src_noext && !cand_noext.ends_with(&format!("/{src_noext}")) {
            continue;
        }
        let cand_segs: Vec<&str> = cand.split('/').collect();
        let mut score = 0;
        while score < cand_segs.len()
            && score < importer_dir.len()
            && cand_segs[score] == importer_dir[score]
        {
            score += 1;
        }
        let entry = (score, usize::MAX - cand.len(), cand);
        if best.map_or(true, |b| entry.0 > b.0 || (entry.0 == b.0 && entry.1 > b.1)) {
            best = Some(entry);
        }
    }
    best.map(|(_, _, rel)| rel.clone())
}

fn resolve(importer_rel: &str, source: &str, files: &HashSet<String>) -> Option<String> {
    let dir = match importer_rel.rfind('/') {
        Some(i) => &importer_rel[..i],
        None => "",
    };
    let joined = normalize(&format!("{dir}/{source}"));
    if files.contains(&joined) {
        return Some(joined);
    }
    // TS ESM convention: './b.js' on disk is often './b.ts'.
    if let Some(dot) = joined.rfind('.') {
        let stem = &joined[..dot];
        let cur_ext = &joined[dot + 1..];
        if ["js", "jsx", "mjs", "cjs"].contains(&cur_ext) {
            for ext in RESOLVE_EXTS {
                let cand = format!("{stem}.{ext}");
                if files.contains(&cand) {
                    return Some(cand);
                }
            }
        }
    }
    for ext in RESOLVE_EXTS {
        let cand = format!("{joined}.{ext}");
        if files.contains(&cand) {
            return Some(cand);
        }
    }
    for ext in RESOLVE_EXTS {
        let cand = format!("{joined}/index.{ext}");
        if files.contains(&cand) {
            return Some(cand);
        }
    }
    None
}

/// Every file under cwd (per the given options) that imports `target_rel`
/// directly or transitively, sorted. The target itself is excluded.
pub fn dependents_of(options: Options, target_rel: &str) -> Result<Vec<String>, String> {
    let target = normalize(target_rel.trim_start_matches("./"));
    let scan = Engine::new(&["**".to_string()], {
        let mut o = options;
        o.only_files = true;
        o.index = false;
        o
    })?;
    let all = scan.collect_paths();
    let files: HashSet<String> = all.iter().cloned().collect();
    if !files.contains(&target) {
        return Err(format!("target not found under cwd: {target_rel}"));
    }
    let cwd = scan.cwd.clone();
    // Stem index for bare-specifier (monorepo module path) resolution.
    let mut by_stem: HashMap<String, Vec<String>> = HashMap::new();
    for rel in &all {
        by_stem.entry(stem_of(rel)).or_default().push(rel.clone());
    }
    let by_stem = std::sync::Arc::new(by_stem);
    // Reverse edges: resolved target -> its importers, built in parallel.
    let edges: Vec<(String, String)> = all
        .par_iter()
        .filter(|rel| is_js(rel))
        .flat_map(|rel| {
            let mut out: Vec<(String, String)> = Vec::new();
            if let Ok(bytes) = std::fs::read(cwd.join(rel)) {
                let imports = match ast_module_info(&bytes, ext_of(rel)) {
                    Some((_, imports)) => imports.into_iter().collect::<Vec<_>>(),
                    None => fallback_import_sources(&bytes),
                };
                {
                    for src in &imports {
                        let resolved = if src.starts_with('.') {
                            resolve(rel, src, &files)
                        } else {
                            resolve_bare(rel, src, &by_stem)
                        };
                        if let Some(resolved) = resolved {
                            if resolved != *rel {
                                out.push((resolved, rel.clone()));
                            }
                        }
                    }
                }
            }
            out
        })
        .collect();
    let mut importers: HashMap<String, Vec<String>> = HashMap::new();
    for (resolved, importer) in edges {
        importers.entry(resolved).or_default().push(importer);
    }
    // BFS backwards from the target.
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    seen.insert(target.clone());
    queue.push_back(target);
    while let Some(cur) = queue.pop_front() {
        if let Some(list) = importers.get(&cur) {
            for imp in list {
                if seen.insert(imp.clone()) {
                    queue.push_back(imp.clone());
                }
            }
        }
    }
    seen.remove(&normalize(target_rel.trim_start_matches("./")));
    let mut out: Vec<String> = seen.into_iter().collect();
    out.sort();
    Ok(out)
}
