//! Parallel directory traversal + in-flight selector engine.
//!
//! Traversal is a custom rayon work-stealing walk over `std::fs::read_dir`
//! (the `ignore` crate's walker measured ~3x slower than raw readdir on our
//! benchmark VM). Ignore rules still come from the `ignore` crate — its
//! `Gitignore` matcher is the battle-tested part — applied as a per-directory
//! stack: each directory's .gitignore / .ignore / .agentignore is loaded when
//! the directory is entered, deeper matchers win, and an ignored directory
//! prunes its whole subtree (which is also what git itself does).
//!
//! Glob matching, metadata selectors and content selectors all run inside
//! the traversal tasks — files are filtered before they ever cross the
//! N-API boundary. Results leave through a crossbeam channel in batches.

use crate::selectors::{parse_queries, Query, Selector};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use rayon::prelude::*;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub cwd: Option<String>,
    pub gitignore: bool,
    pub ignore_files: bool,
    pub dot: bool,
    pub max_depth: Option<usize>,
    pub threads: usize,
    pub stats: bool,
    pub only_files: bool,
    pub follow_symlinks: bool,
    pub with_content: bool,
    pub ignore: Vec<String>,
    /// Use (and maintain) the warm index snapshot at <cwd>/.hyperglob/.
    pub index: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            cwd: None,
            gitignore: true,
            ignore_files: true,
            dot: false,
            max_depth: None,
            threads: 0,
            stats: true,
            only_files: true,
            follow_symlinks: false,
            with_content: false,
            ignore: Vec::new(),
            index: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub path: String,
    pub relative_path: String,
    pub name: String,
    pub extension: String,
    pub size: u64,
    pub modified_ms: i64,
    pub is_file: bool,
    pub is_dir: bool,
    pub content: Option<String>,
}

fn has_magic(seg: &str) -> bool {
    seg.contains('*') || seg.contains('?') || seg.contains('{') || seg.contains('[')
}

/// Static directory prefix of a glob pattern (segments before the first
/// segment containing glob magic). Used to narrow the walk root.
fn static_prefix(pattern: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for seg in pattern.split('/') {
        if has_magic(seg) {
            break;
        }
        if seg == "." || seg.is_empty() {
            continue;
        }
        out.push(seg);
    }
    out
}

fn common_ancestor(paths: &[PathBuf]) -> PathBuf {
    if paths.is_empty() {
        return PathBuf::new();
    }
    let mut prefix: Vec<std::ffi::OsString> = paths[0]
        .components()
        .map(|c| c.as_os_str().to_os_string())
        .collect();
    for p in &paths[1..] {
        let comps: Vec<std::ffi::OsString> = p
            .components()
            .map(|c| c.as_os_str().to_os_string())
            .collect();
        let mut n = 0;
        while n < prefix.len() && n < comps.len() && prefix[n] == comps[n] {
            n += 1;
        }
        prefix.truncate(n);
    }
    let mut out = PathBuf::new();
    for c in prefix {
        out.push(c);
    }
    out
}

/// Expand a glob pattern into the variant forms needed for conventional
/// zero-directory `/**/` semantics (`src/**/*.ts` also matches `src/a.ts`,
/// `**/*.ts` also matches `a.ts`), plus directory-prefix semantics for
/// magic-free patterns. The variants are compiled once into a GlobSet.
fn expand_pattern(pattern: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut work: Vec<String> = vec![pattern.to_string()];
    while let Some(p) = work.pop() {
        if out.contains(&p) {
            continue;
        }
        out.push(p.clone());
        if p.contains("/**/") {
            work.push(p.replace("/**/", "/"));
        }
        if let Some(rest) = p.strip_prefix("**/") {
            work.push(rest.to_string());
        }
        if let Some(prefix) = p.strip_suffix("/**") {
            work.push(prefix.to_string());
        }
    }
    if !pattern.chars().any(|c| "*?{[".contains(c)) {
        let trimmed = pattern.trim_end_matches('/');
        out.push(format!("{trimmed}/**"));
    }
    out
}

fn build_glob_set(patterns: &[String]) -> Result<globset::GlobSet, String> {
    let mut builder = globset::GlobSetBuilder::new();
    for p in patterns {
        for variant in expand_pattern(p) {
            let glob = globset::GlobBuilder::new(&variant)
                .literal_separator(true)
                .build()
                .map_err(|e| format!("invalid glob pattern {variant:?}: {e}"))?;
            builder.add(glob);
        }
    }
    builder.build().map_err(|e| format!("invalid glob patterns: {e}"))
}

pub(crate) fn set_matches(set: &globset::GlobSet, rel: &str) -> bool {
    !set.is_empty() && set.is_match(rel)
}

pub struct Engine {
    pub query: Query,
    pub options: Options,
    pub cwd: PathBuf,
    pub walk_root: PathBuf,
    /// depth of walk_root below cwd (for maxDepth accounting)
    pub root_depth: usize,
    /// posix relative path of walk_root below cwd ("" when walk_root == cwd)
    pub walk_root_rel: String,
    pub positive_set: globset::GlobSet,
    pub negative_set: globset::GlobSet,
    pub ignore_set: globset::GlobSet,
    /// options.stats — populate Entry size/modified (full entries only).
    pub stats_requested: bool,
    /// A :size / :modified selector is present (metadata needed in any mode).
    pub has_meta_selectors: bool,
    pub needs_content: bool,
}

impl Engine {
    pub fn new(pattern_inputs: &[String], options: Options) -> Result<Engine, String> {
        let query = parse_queries(pattern_inputs)?;
        let cwd = match &options.cwd {
            Some(c) => {
                let p = PathBuf::from(c);
                if p.is_absolute() {
                    p
                } else {
                    std::env::current_dir().map_err(|e| e.to_string())?.join(p)
                }
            }
            None => std::env::current_dir().map_err(|e| e.to_string())?,
        };
        let static_dirs: Vec<PathBuf> = query
            .patterns
            .iter()
            .map(|p| {
                let sp = static_prefix(p);
                let abs = cwd.join(&sp);
                if abs.is_file() {
                    sp.parent().map(|x| x.to_path_buf()).unwrap_or_default()
                } else {
                    sp
                }
            })
            .collect();
        let root_rel = common_ancestor(&static_dirs);
        let root_depth = root_rel.components().count();
        let walk_root_rel = root_rel.to_string_lossy().replace('\\', "/");
        let walk_root = if root_rel.as_os_str().is_empty() {
            cwd.clone()
        } else {
            cwd.join(&root_rel)
        };
        let positive_set = build_glob_set(&query.patterns)?;
        let negative_set = build_glob_set(&query.negatives)?;
        let mut ignore_patterns = options.ignore.clone();
        if options.index {
            // The index's own directory must never leak into indexed results.
            ignore_patterns.push(".hyperglob".to_string());
            ignore_patterns.push(".hyperglob/**".to_string());
        }
        let ignore_set = build_glob_set(&ignore_patterns)?;
        let stats_requested = options.stats;
        let has_meta_selectors = query
            .selectors
            .iter()
            .any(|s| matches!(s, Selector::Size(..) | Selector::Modified(..)));
        let needs_content = query.selectors.iter().any(|s| s.needs_content());
        Ok(Engine {
            query,
            options,
            cwd,
            walk_root,
            root_depth,
            walk_root_rel,
            positive_set,
            negative_set,
            ignore_set,
            stats_requested,
            has_meta_selectors,
            needs_content,
        })
    }

    // ---------- ignore stack ----------

    fn matcher_for_dir(&self, dir: &Path, is_cwd: bool) -> Option<Gitignore> {
        let mut builder = GitignoreBuilder::new(dir);
        let mut any = false;
        if self.options.gitignore {
            let gi = dir.join(".gitignore");
            if gi.is_file() {
                builder.add(&gi);
                any = true;
            }
            if is_cwd {
                let excl = dir.join(".git").join("info").join("exclude");
                if excl.is_file() {
                    builder.add(&excl);
                    any = true;
                }
            }
        }
        if self.options.ignore_files {
            for name in [".ignore", ".agentignore"] {
                let f = dir.join(name);
                if f.is_file() {
                    builder.add(&f);
                    any = true;
                }
            }
        }
        if !any {
            return None;
        }
        builder.build().ok()
    }

    fn global_matcher(&self) -> Option<Gitignore> {
        if !self.options.gitignore {
            return None;
        }
        // The global gitignore is a per-process constant in practice;
        // building it re-reads git config files on every scan otherwise.
        static GLOBAL: std::sync::OnceLock<Option<Gitignore>> = std::sync::OnceLock::new();
        GLOBAL
            .get_or_init(|| {
                let (gi, _err) = GitignoreBuilder::new("").build_global();
                if gi.is_empty() {
                    None
                } else {
                    Some(gi)
                }
            })
            .clone()
    }

    /// Stack of matchers applying at walk_root: cwd first, then each
    /// ancestor directory down to walk_root itself.
    fn initial_stack(&self) -> Vec<Gitignore> {
        let mut stack = Vec::new();
        if !self.options.gitignore && !self.options.ignore_files {
            return stack;
        }
        let mut dir = self.cwd.clone();
        if let Some(m) = self.matcher_for_dir(&dir, true) {
            stack.push(m);
        }
        if !self.walk_root_rel.is_empty() {
            for seg in self.walk_root_rel.split('/') {
                dir.push(seg);
                if let Some(m) = self.matcher_for_dir(&dir, false) {
                    stack.push(m);
                }
            }
        }
        stack
    }

    // ---------- candidate evaluation ----------

    fn eval_entry(
        &self,
        rel: String,
        path: &Path,
        dent: &std::fs::DirEntry,
        is_file: bool,
        is_dir: bool,
        light: bool,
    ) -> Option<Entry> {
        if !set_matches(&self.positive_set, &rel) {
            return None;
        }
        if set_matches(&self.negative_set, &rel) {
            return None;
        }
        if set_matches(&self.ignore_set, &rel) {
            return None;
        }

        let want_metadata = self.has_meta_selectors || (!light && self.stats_requested);
        let (size, modified_ms) = if want_metadata {
            match dent.metadata() {
                Ok(md) => {
                    let modified_ms = md
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    (md.len(), modified_ms)
                }
                Err(_) => (0, 0),
            }
        } else {
            (0, 0)
        };

        for sel in &self.query.selectors {
            if !sel.eval_metadata(size, modified_ms) {
                return None;
            }
        }

        let mut content: Option<String> = None;
        if is_file && (self.needs_content || self.options.with_content) {
            let bytes = std::fs::read(path).ok()?;
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_string();
            for sel in &self.query.selectors {
                if sel.needs_content() && !sel.eval_content_ext(&bytes, &ext) {
                    return None;
                }
            }
            if self.options.with_content && !light {
                content = Some(String::from_utf8_lossy(&bytes).into_owned());
            }
        } else if self.needs_content && !is_file {
            // Content selectors can only match files.
            return None;
        }

        if light {
            return Some(Entry {
                path: String::new(),
                relative_path: rel,
                name: String::new(),
                extension: String::new(),
                size,
                modified_ms,
                is_file,
                is_dir,
                content: None,
            });
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let extension = path
            .extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_default();
        Some(Entry {
            path: path.to_string_lossy().into_owned(),
            relative_path: rel,
            name,
            extension,
            size,
            modified_ms,
            is_file,
            is_dir,
            content,
        })
    }

    // ---------- traversal ----------

    /// Run the walk, sending batches of matching entries on `tx`.
    /// In light mode only `relative_path` is populated (pathsOnly fast path).
    pub fn run_batched(&self, tx: crossbeam_channel::Sender<Vec<Entry>>, light: bool) {
        let global = self.global_matcher().map(Arc::new);
        let stack = self.initial_stack();
        let walker = Walker {
            eng: self,
            global,
            tx,
            light,
        };
        let threads = self.options.threads;
        let run = || {
            rayon::scope(|scope| {
                // Depth is counted from the walk root (the patterns' static
                // base), matching fast-glob's `deep` semantics: with
                // `src/**/*.ts` + maxDepth 2, files in src/ and src/a/ match.
                walker.visit(
                    scope,
                    self.walk_root.clone(),
                    self.walk_root_rel.clone(),
                    0,
                    Arc::new(stack),
                );
            });
        };
        if threads > 0 {
            match rayon::ThreadPoolBuilder::new().num_threads(threads).build() {
                Ok(pool) => pool.install(run),
                Err(_) => run(),
            }
        } else {
            run();
        }
    }

    /// Raw batched collect (no index routing). `light` = pathsOnly mode.
    pub(crate) fn collect_entries_raw(&self, light: bool) -> Vec<Entry> {
        let (tx, rx) = crossbeam_channel::unbounded::<Vec<Entry>>();
        let drain = std::thread::spawn(move || {
            let mut out = Vec::new();
            while let Ok(mut batch) = rx.recv() {
                out.append(&mut batch);
            }
            out
        });
        self.run_batched(tx, light);
        drain.join().unwrap_or_default()
    }

    /// Collect every matching entry into a Vec.
    pub fn collect(&self) -> Vec<Entry> {
        if self.options.index {
            return crate::index::collect_indexed(self, false);
        }
        self.collect_entries_raw(false)
    }

    /// Collect matching relative paths only (fast path).
    pub fn collect_paths(&self) -> Vec<String> {
        if self.options.index {
            return crate::index::collect_indexed(self, true)
                .into_iter()
                .map(|e| e.relative_path)
                .collect();
        }
        self.collect_entries_raw(true)
            .into_iter()
            .map(|e| e.relative_path)
            .collect()
    }
}

struct Walker<'e> {
    eng: &'e Engine,
    global: Option<Arc<Gitignore>>,
    tx: crossbeam_channel::Sender<Vec<Entry>>,
    light: bool,
}

const BATCH: usize = 1024;
const PAR_FILE_THRESHOLD: usize = 512;

enum Classified {
    Skip,
    File(Entry),
    Dir {
        rel: String,
        path: PathBuf,
        dent: std::fs::DirEntry,
        depth: usize,
    },
}

impl<'e> Walker<'e> {
    fn excluded(&self, stack: &[Gitignore], path: &Path, is_dir: bool) -> bool {
        if !self.eng.options.gitignore && !self.eng.options.ignore_files {
            return false;
        }
        for m in stack.iter().rev() {
            let mt = m.matched(path, is_dir);
            if mt.is_ignore() {
                return true;
            }
            if mt.is_whitelist() {
                return false;
            }
        }
        if let Some(g) = &self.global {
            let mt = g.matched(path, is_dir);
            if mt.is_ignore() {
                return true;
            }
        }
        false
    }

    fn flush(&self, out: &mut Vec<Entry>) {
        if out.is_empty() {
            return;
        }
        let batch = std::mem::replace(out, Vec::with_capacity(BATCH));
        let _ = self.tx.send(batch);
    }

    /// One directory entry after the cheap serial pass: everything that
    /// needs real work is decided in the parallel pass.
    fn classify(
        &self,
        stack: &[Gitignore],
        rel_dir: &str,
        dir_depth: usize,
        dent: std::fs::DirEntry,
    ) -> Classified {
        let opts = &self.eng.options;
        let ft = match dent.file_type() {
            Ok(f) => f,
            Err(_) => return Classified::Skip,
        };
        let name = dent.file_name().to_string_lossy().into_owned();
        if name.is_empty() {
            return Classified::Skip;
        }
        let mut is_dir = ft.is_dir();
        let is_symlink = ft.is_symlink();
        let path = dent.path();
        if is_symlink && opts.follow_symlinks {
            if let Ok(md) = path.metadata() {
                is_dir = md.is_dir();
            }
        }
        let is_file = ft.is_file() || (is_symlink && !is_dir);

        if !opts.dot && name.starts_with('.') {
            return Classified::Skip;
        }
        if opts.dot && is_dir && name == ".git" && opts.gitignore {
            return Classified::Skip;
        }

        let child_rel = if rel_dir.is_empty() {
            name
        } else {
            format!("{rel_dir}/{name}")
        };
        let child_depth = dir_depth + 1;

        if self.excluded(stack, &path, is_dir) {
            return Classified::Skip;
        }

        if is_dir {
            Classified::Dir {
                rel: child_rel,
                path,
                dent,
                depth: child_depth,
            }
        } else if is_file {
            if let Some(md) = opts.max_depth {
                if child_depth > md {
                    return Classified::Skip;
                }
            }
            match self
                .eng
                .eval_entry(child_rel, &path, &dent, true, false, self.light)
            {
                Some(e) => Classified::File(e),
                None => Classified::Skip,
            }
        } else {
            Classified::Skip
        }
    }

    fn visit<'s>(
        &self,
        scope: &rayon::Scope<'s>,
        abs_dir: PathBuf,
        rel_dir: String,
        dir_depth: usize,
        stack: Arc<Vec<Gitignore>>,
    ) where
        'e: 's,
    {
        let rd = match std::fs::read_dir(&abs_dir) {
            Ok(r) => r,
            Err(_) => return,
        };
        let raw: Vec<std::fs::DirEntry> = rd.filter_map(|r| r.ok()).collect();
        let opts = &self.eng.options;

        // Parallel pass for wide directories: classification + matching +
        // selector evaluation are the per-file costs, so they fan out.
        // Files fold directly into entry vectors; directories (rare) are
        // side-channeled through a mutex for the serial spawn pass below.
        let mut out: Vec<Entry> = Vec::new();
        let classified: Vec<Classified> = if raw.len() > PAR_FILE_THRESHOLD {
            let dirs: std::sync::Mutex<Vec<Classified>> = std::sync::Mutex::new(Vec::new());
            let mut entries: Vec<Entry> = raw
                .into_par_iter()
                .fold(Vec::new, |mut acc, dent| {
                    match self.classify(&stack, &rel_dir, dir_depth, dent) {
                        Classified::File(e) => acc.push(e),
                        d @ Classified::Dir { .. } => {
                            dirs.lock().unwrap().push(d);
                        }
                        Classified::Skip => {}
                    }
                    acc
                })
                .reduce(Vec::new, |mut a, mut b| {
                    a.append(&mut b);
                    a
                });
            // Send this directory's file entries in batches right away.
            let mut rest = entries;
            while rest.len() > BATCH {
                let tail = rest.split_off(BATCH);
                let _ = self.tx.send(rest);
                rest = tail;
            }
            if !rest.is_empty() {
                let _ = self.tx.send(rest);
            }
            dirs.into_inner().unwrap_or_default()
        } else {
            raw.into_iter()
                .map(|dent| self.classify(&stack, &rel_dir, dir_depth, dent))
                .collect()
        };

        for item in classified {
            match item {
                Classified::Skip => {}
                Classified::File(e) => {
                    out.push(e);
                    if out.len() >= BATCH {
                        self.flush(&mut out);
                    }
                }
                Classified::Dir {
                    rel: child_rel,
                    path,
                    dent,
                    depth: child_depth,
                } => {
                    if !opts.only_files {
                        if let Some(e) = self.eng.eval_entry(
                            child_rel.clone(),
                            &path,
                            &dent,
                            false,
                            true,
                            self.light,
                        ) {
                            out.push(e);
                        }
                    }
                    let can_descend = opts.max_depth.map_or(true, |md| child_depth < md);
                    if can_descend {
                        let child_stack =
                            match self.eng.matcher_for_dir(&path, false) {
                                Some(m) => {
                                    let mut v = (*stack).clone();
                                    v.push(m);
                                    Arc::new(v)
                                }
                                None => stack.clone(),
                            };
                        let walker_tx = self.tx.clone();
                        let walker_global = self.global.clone();
                        let eng = self.eng;
                        let light = self.light;
                        scope.spawn(move |s| {
                            let child = Walker {
                                eng,
                                global: walker_global,
                                tx: walker_tx,
                                light,
                            };
                            child.visit(s, path, child_rel, child_depth, child_stack);
                        });
                    }
                }
            }
        }
        self.flush(&mut out);
    }
}

pub fn ensure_walk_root_exists(engine: &Engine) -> Result<(), String> {
    if engine.walk_root.exists() {
        Ok(())
    } else {
        Err(format!(
            "walk root does not exist: {}",
            engine.walk_root.display()
        ))
    }
}
