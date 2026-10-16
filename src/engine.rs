//! Parallel directory walker + in-flight selector engine.
//!
//! Uses the `ignore` crate's parallel walker (which internally fans out over
//! a work-stealing thread pool) with a native ignore stack: .gitignore,
//! .ignore, .git/info/exclude, global gitignore, and .agentignore.
//! Glob matching, metadata selectors and content selectors all run inside
//! the walker visitor threads — files are filtered before they ever cross
//! the N-API boundary.

use crate::selectors::{parse_queries, Query};
use ignore::{WalkBuilder, WalkState};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
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
        if seg == "." {
            continue;
        }
        if seg.is_empty() {
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
    // A magic-free pattern that names a directory matches everything under it.
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

fn set_matches(set: &globset::GlobSet, rel: &str) -> bool {
    !set.is_empty() && set.is_match(rel)
}

pub struct Engine {
    pub query: Query,
    pub options: Options,
    pub cwd: PathBuf,
    pub walk_root: PathBuf,
    /// depth of walk_root below cwd (for maxDepth accounting)
    pub root_depth: usize,
    pub positive_set: globset::GlobSet,
    pub negative_set: globset::GlobSet,
    pub ignore_set: globset::GlobSet,
    pub needs_metadata: bool,
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
                    std::env::current_dir()
                        .map_err(|e| e.to_string())?
                        .join(p)
                }
            }
            None => std::env::current_dir().map_err(|e| e.to_string())?,
        };
        let static_dirs: Vec<PathBuf> = query
            .patterns
            .iter()
            .map(|p| {
                let sp = static_prefix(p);
                // If the static prefix names a file (no magic at all), walk its parent.
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
        let walk_root = if root_rel.as_os_str().is_empty() {
            cwd.clone()
        } else {
            cwd.join(&root_rel)
        };
        let positive_set = build_glob_set(&query.patterns)?;
        let negative_set = build_glob_set(&query.negatives)?;
        let ignore_set = build_glob_set(&options.ignore)?;
        let needs_metadata = options.stats
            || query
                .selectors
                .iter()
                .any(|s| !s.needs_content() && matches!(s, crate::selectors::Selector::Size(..) | crate::selectors::Selector::Modified(..)));
        Ok(Engine {
            query,
            options,
            cwd,
            walk_root,
            root_depth,
            positive_set,
            negative_set,
            ignore_set,
            needs_metadata,
        })
    }

    fn build_walker(&self) -> ignore::WalkParallel {
        let mut builder = WalkBuilder::new(&self.walk_root);
        builder
            .standard_filters(false)
            .hidden(!self.options.dot)
            .git_ignore(self.options.gitignore)
            .git_global(self.options.gitignore)
            .git_exclude(self.options.gitignore)
            .ignore(self.options.ignore_files)
            .parents(true)
            .require_git(false)
            .follow_links(self.options.follow_symlinks)
            .threads(self.options.threads);
        if self.options.ignore_files {
            builder.add_custom_ignore_filename(".agentignore");
        }
        if let Some(md) = self.options.max_depth {
            // maxDepth is expressed relative to cwd (a file at src/a.ts is
            // depth 2). The walker counts depth from walk_root, whose own
            // depth below cwd is root_depth, so subtract it.
            let adjusted = md.saturating_sub(self.root_depth);
            builder.max_depth(Some(adjusted));
        }
        builder.build_parallel()
    }

    /// Run the parallel walk, sending every matching entry on `tx`.
    /// Returns when traversal is complete and all visitors have dropped their senders.
    /// In light mode only `relative_path` is populated (pathsOnly fast path).
    pub fn run(&self, tx: Sender<Entry>) {
        self.run_mode(tx, false)
    }

    fn run_mode(&self, tx: Sender<Entry>, light: bool) {
        let walker = self.build_walker();
        let query = self.query.clone();
        let options = self.options.clone();
        let cwd = self.cwd.clone();
        let positive_set = self.positive_set.clone();
        let negative_set = self.negative_set.clone();
        let ignore_set = self.ignore_set.clone();
        let needs_metadata = self.needs_metadata;

        walker.run(|| {
            let tx = tx.clone();
            let query = query.clone();
            let options = options.clone();
            let cwd = cwd.clone();
            let positive_set = positive_set.clone();
            let negative_set = negative_set.clone();
            let ignore_set = ignore_set.clone();
            Box::new(move |result| {
                let dent = match result {
                    Ok(d) => d,
                    Err(_) => return WalkState::Continue,
                };
                let path = dent.path();
                let ft = match dent.file_type() {
                    Some(f) => f,
                    None => return WalkState::Continue,
                };
                let is_dir = ft.is_dir();
                let is_file = ft.is_file();

                // Always traverse directories; only yield them when requested.
                if is_dir {
                    if options.only_files {
                        return WalkState::Continue;
                    }
                } else if !is_file {
                    // symlinks to files etc.: treat non-file non-dir as skip unless following
                    if !options.follow_symlinks {
                        return WalkState::Continue;
                    }
                }

                let rel_path = match path.strip_prefix(&cwd) {
                    Ok(r) => r.to_path_buf(),
                    Err(_) => path.to_path_buf(),
                };
                #[cfg(windows)]
                let rel = rel_path.to_string_lossy().replace('\\', "/");
                #[cfg(not(windows))]
                let rel = rel_path.to_string_lossy().into_owned();
                if rel.is_empty() {
                    return WalkState::Continue;
                }

                if !set_matches(&positive_set, &rel) {
                    return WalkState::Continue;
                }
                if set_matches(&negative_set, &rel) {
                    return WalkState::Continue;
                }
                if set_matches(&ignore_set, &rel) {
                    return WalkState::Continue;
                }

                // Stat lazily: only when stats were requested or a metadata
                // selector needs the values.
                let (size, modified_ms) = if needs_metadata {
                    let metadata = dent.metadata().ok();
                    let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                    let modified_ms = metadata
                        .as_ref()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    (size, modified_ms)
                } else {
                    (0, 0)
                };

                // Metadata selectors run pre-read, at stat time.
                for sel in &query.selectors {
                    if !sel.eval_metadata(size, modified_ms) {
                        return WalkState::Continue;
                    }
                }

                // Content selectors run in-flight, inside the walker thread.
                let needs_content = query.selectors.iter().any(|s| s.needs_content());
                let mut content: Option<String> = None;
                if is_file && (needs_content || options.with_content) {
                    let bytes = match std::fs::read(path) {
                        Ok(b) => b,
                        Err(_) => return WalkState::Continue,
                    };
                    for sel in &query.selectors {
                        if sel.needs_content() && !sel.eval_content(&bytes) {
                            return WalkState::Continue;
                        }
                    }
                    if options.with_content {
                        content = Some(String::from_utf8_lossy(&bytes).into_owned());
                    }
                }

                let (entry_path, name, extension) = if light {
                    (String::new(), String::new(), String::new())
                } else {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let extension = path
                        .extension()
                        .map(|e| e.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let absolute = if path.is_absolute() {
                        path.to_path_buf()
                    } else {
                        cwd.join(path)
                    };
                    (absolute.to_string_lossy().into_owned(), name, extension)
                };
                let entry = Entry {
                    path: entry_path,
                    relative_path: rel,
                    name,
                    extension,
                    size,
                    modified_ms,
                    is_file,
                    is_dir,
                    content,
                };
                if tx.send(entry).is_err() {
                    return WalkState::Quit;
                }
                WalkState::Continue
            })
        });
    }

    /// Collect matching relative paths only. Skips Entry construction and
    /// (unless a selector needs them) stat calls — the fast path for pure
    /// path discovery, comparable to fast-glob's default string output.
    pub fn collect_paths(&self) -> Vec<String> {
        let (tx, rx) = std::sync::mpsc::channel::<Entry>();
        let out = Arc::new(Mutex::new(Vec::new()));
        let out_clone = out.clone();
        let drain = std::thread::spawn(move || {
            for e in rx {
                out_clone.lock().unwrap().push(e.relative_path);
            }
        });
        self.run_mode(tx, true);
        let _ = drain.join();
        let paths = out.lock().unwrap().clone();
        paths
    }

    /// Collect every matching entry into a Vec.
    pub fn collect(&self) -> Vec<Entry> {
        let (tx, rx) = std::sync::mpsc::channel::<Entry>();
        let out = Arc::new(Mutex::new(Vec::new()));
        let out_clone = out.clone();
        let drain = std::thread::spawn(move || {
            for e in rx {
                out_clone.lock().unwrap().push(e);
            }
        });
        self.run(tx);
        let _ = drain.join();
        let vec = out.lock().unwrap().clone();
        vec
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

pub fn _unused(_p: &Path) {}
