//! hyperglob — multi-threaded, AST-aware, zero-copy file discovery.
//!
//! Rust core (parallel walker + in-flight selectors) exposed to Node.js
//! through N-API. The streaming API is pull-based: a background thread runs
//! the parallel walker and feeds a lock-free-ish channel; JavaScript pulls
//! batches via `Scanner::next_batch`, so results cross the N-API boundary
//! in small chunks allocated on the Rust side instead of one giant array.

mod engine;
mod graph;
mod index;
mod selectors;

use engine::{Engine, Options};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[napi(object)]
pub struct NativeEntry {
    pub path: String,
    pub relative_path: String,
    pub name: String,
    pub extension: String,
    pub size: f64,
    pub modified_ms: f64,
    pub is_file: bool,
    pub is_dir: bool,
    pub content: Option<String>,
}

impl From<engine::Entry> for NativeEntry {
    fn from(e: engine::Entry) -> Self {
        NativeEntry {
            path: e.path,
            relative_path: e.relative_path,
            name: e.name,
            extension: e.extension,
            size: e.size as f64,
            modified_ms: e.modified_ms as f64,
            is_file: e.is_file,
            is_dir: e.is_dir,
            content: e.content,
        }
    }
}

#[napi(object)]
pub struct NativeBatch {
    pub entries: Vec<NativeEntry>,
    pub done: bool,
}

#[napi(object)]
pub struct NativePathBatch {
    /// Relative paths, NUL-joined into one string (the same columnar trick
    /// the sync path uses, so a batch crosses the N-API boundary once).
    pub paths: String,
    pub done: bool,
}

fn parse_options(options_json: Option<String>) -> Result<Options> {
    match options_json {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Options>(&s)
            // Surface the underlying message directly. The "invalid options
            // JSON" prefix added noise without helping: serde already says
            // which field was wrong, and our own deserializers produce a
            // complete sentence.
            .map_err(|e| Error::from_reason(e.to_string())),
        _ => Ok(Options::default()),
    }
}

fn build_engine(patterns: Vec<String>, options_json: Option<String>) -> Result<Engine> {
    let options = parse_options(options_json)?;
    let eng = Engine::new(&patterns, options).map_err(Error::from_reason)?;
    engine::ensure_walk_root_exists(&eng).map_err(Error::from_reason)?;
    Ok(eng)
}

/// Synchronous full scan. Returns every matching entry at once.
#[napi]
pub fn scan_sync(patterns: Vec<String>, options_json: Option<String>) -> Result<Vec<NativeEntry>> {
    let eng = build_engine(patterns, options_json)?;
    Ok(eng.collect().into_iter().map(NativeEntry::from).collect())
}

/// Fast path: matching relative paths as ONE NUL-joined string. A single
/// string crosses the N-API boundary (instead of one marshalled JS string
/// per path) and JS splits it — measurably the cheapest transport at 10k+
/// entries. NUL cannot appear in a filesystem path.
#[napi]
pub fn scan_paths_sync(patterns: Vec<String>, options_json: Option<String>) -> Result<String> {
    let eng = build_engine(patterns, options_json)?;
    Ok(eng.collect_paths().join("\0"))
}

/// Columnar transport: string fields cross as NUL-joined mega-strings,
/// numeric fields as little-endian f64 bytes (read back via Float64Array),
/// flags as bytes. The JS side zips columns into Entry objects in a tight
/// loop — far cheaper than per-object native marshaling.
#[napi(object)]
pub struct NativeColumns {
    pub count: u32,
    pub paths: String,
    pub relative_paths: String,
    pub names: String,
    pub extensions: String,
    /// Interleaved [size, modified_ms] f64 LE bytes, 2 per entry.
    /// (Buffer, not Vec<u8> — napi-rs would marshal Vec<u8> as a JS array
    /// of individual numbers, which is catastrophically slow at scale.)
    pub numbers: Buffer,
    pub flags: Buffer, // bit 0: is_file, bit 1: is_dir
    /// Per-entry contents (empty string when absent). Only populated when
    /// at least one entry has content; contents are NOT NUL-joined because
    /// file content may itself contain NUL bytes.
    pub contents: Vec<String>,
    pub has_content: Buffer,
}

fn join_into(buf: &mut String, s: &str, idx: usize) {
    if idx > 0 {
        buf.push('\0');
    }
    buf.push_str(s);
}

#[napi]
pub fn scan_columns_sync(
    patterns: Vec<String>,
    options_json: Option<String>,
) -> Result<NativeColumns> {
    let eng = build_engine(patterns, options_json)?;
    let entries = eng.collect();
    let n = entries.len();
    let mut cols = NativeColumns {
        count: n as u32,
        paths: String::new(),
        relative_paths: String::new(),
        names: String::new(),
        extensions: String::new(),
        numbers: Vec::with_capacity(n * 16).into(),
        flags: Vec::with_capacity(n).into(),
        contents: Vec::new(),
        has_content: Vec::new().into(),
    };
    let any_content = entries.iter().any(|e| e.content.is_some());
    let mut numbers: Vec<u8> = Vec::with_capacity(n * 16);
    let mut flags: Vec<u8> = Vec::with_capacity(n);
    let mut has_content: Vec<u8> = Vec::new();
    if any_content {
        has_content = Vec::with_capacity(n);
    }
    for (i, e) in entries.into_iter().enumerate() {
        join_into(&mut cols.paths, &e.path, i);
        join_into(&mut cols.relative_paths, &e.relative_path, i);
        join_into(&mut cols.names, &e.name, i);
        join_into(&mut cols.extensions, &e.extension, i);
        numbers.extend_from_slice(&(e.size as f64).to_le_bytes());
        numbers.extend_from_slice(&(e.modified_ms as f64).to_le_bytes());
        flags.push((e.is_file as u8) | ((e.is_dir as u8) << 1));
        if any_content {
            match e.content {
                Some(c) => {
                    cols.contents.push(c);
                    has_content.push(1);
                }
                None => {
                    cols.contents.push(String::new());
                    has_content.push(0);
                }
            }
        }
    }
    cols.numbers = numbers.into();
    cols.flags = flags.into();
    cols.has_content = has_content.into();
    Ok(cols)
}

/// Streaming scanner. The parallel walker runs on a background Rust thread
/// and sends batches over a crossbeam channel; `next_batch` pulls up to
/// `max` entries at a time from the local buffer.
#[napi]
pub struct Scanner {
    rx: Arc<Mutex<Option<crossbeam_channel::Receiver<Vec<engine::Entry>>>>>,
    buffer: Arc<Mutex<std::collections::VecDeque<engine::Entry>>>,
    finished: Arc<AtomicBool>,
}

#[napi]
impl Scanner {
    /// Pull the next batch. `done: true` (with whatever entries remain)
    /// means the traversal has finished and the channel is drained.
    #[napi]
    pub fn next_batch(&self, max: Option<u32>) -> NativeBatch {
        let max = max.unwrap_or(256).max(1) as usize;
        let mut entries: Vec<NativeEntry> = Vec::with_capacity(max);
        {
            let mut buffer = self.buffer.lock().unwrap();
            while entries.len() < max {
                if let Some(e) = buffer.pop_front() {
                    entries.push(NativeEntry::from(e));
                } else {
                    break;
                }
            }
        }
        let mut done = false;
        if entries.is_empty() && !self.finished.load(Ordering::SeqCst) {
            // Buffer empty: wait briefly for the next walker batch.
            let guard = self.rx.lock().unwrap();
            if let Some(rx) = guard.as_ref() {
                match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(batch) => {
                        let mut buffer = self.buffer.lock().unwrap();
                        for e in batch {
                            buffer.push_back(e);
                        }
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                        done = true;
                    }
                }
            } else {
                done = true;
            }
            // Drain whatever just arrived.
            let mut buffer = self.buffer.lock().unwrap();
            while entries.len() < max {
                match buffer.pop_front() {
                    Some(e) => entries.push(NativeEntry::from(e)),
                    None => break,
                }
            }
            if done && entries.is_empty() {
                self.finished.store(true, Ordering::SeqCst);
            }
        }
        if self.finished.load(Ordering::SeqCst) && entries.is_empty() {
            done = true;
        }
        NativeBatch { entries, done }
    }

    /// Stop the scan early. Dropping the receiver makes walker sends fail
    /// and the traversal winds down.
    #[napi]
    pub fn close(&self) {
        let mut guard = self.rx.lock().unwrap();
        *guard = None;
        self.finished.store(true, Ordering::SeqCst);
    }
}

/// Create a streaming scanner for the given pattern queries.
#[napi]
pub fn create_scanner(patterns: Vec<String>, options_json: Option<String>) -> Result<Scanner> {
    let eng = build_engine(patterns, options_json)?;
    let (tx, rx) = crossbeam_channel::unbounded::<Vec<engine::Entry>>();
    std::thread::spawn(move || {
        eng.run_batched(tx, false);
    });
    Ok(Scanner {
        rx: Arc::new(Mutex::new(Some(rx))),
        buffer: Arc::new(Mutex::new(std::collections::VecDeque::new())),
        finished: Arc::new(AtomicBool::new(false)),
    })
}

/// Streaming scanner that yields relative paths only.
///
/// This exists so that `pathsOnly` streaming is genuinely incremental. The
/// previous implementation ran a full `scanPathsSync` and then split the
/// result, which meant the entire result set was materialized in memory
/// before the first `yield` — the opposite of what a streaming API promises.
#[napi]
pub struct PathsScanner {
    rx: Arc<Mutex<Option<crossbeam_channel::Receiver<Vec<engine::Entry>>>>>,
    buffer: Arc<Mutex<std::collections::VecDeque<String>>>,
    finished: Arc<AtomicBool>,
}

#[napi]
impl PathsScanner {
    /// Pull the next batch of relative paths, NUL-joined.
    /// `done: true` (with whatever paths remain) means the traversal has
    /// finished and the channel is drained.
    #[napi]
    pub fn next_batch(&self, max: Option<u32>) -> NativePathBatch {
        let max = max.unwrap_or(256).max(1) as usize;
        let mut paths: Vec<String> = Vec::with_capacity(max);
        {
            let mut buffer = self.buffer.lock().unwrap();
            while paths.len() < max {
                if let Some(p) = buffer.pop_front() {
                    paths.push(p);
                } else {
                    break;
                }
            }
        }
        let mut done = false;
        if paths.is_empty() && !self.finished.load(Ordering::SeqCst) {
            let guard = self.rx.lock().unwrap();
            if let Some(rx) = guard.as_ref() {
                match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(batch) => {
                        let mut buffer = self.buffer.lock().unwrap();
                        for e in batch {
                            buffer.push_back(e.relative_path);
                        }
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                        done = true;
                    }
                }
            } else {
                done = true;
            }
            if done && paths.is_empty() {
                self.finished.store(true, Ordering::SeqCst);
            }
        }
        if self.finished.load(Ordering::SeqCst) && paths.is_empty() {
            done = true;
        }
        NativePathBatch {
            paths: paths.join("\0"),
            done,
        }
    }

    /// Stop the scan early. Dropping the receiver makes walker sends fail
    /// and the traversal winds down.
    #[napi]
    pub fn close(&self) {
        let mut guard = self.rx.lock().unwrap();
        *guard = None;
        self.finished.store(true, Ordering::SeqCst);
    }
}

/// Create a streaming paths-only scanner for the given pattern queries.
#[napi]
pub fn create_paths_scanner(
    patterns: Vec<String>,
    options_json: Option<String>,
) -> Result<PathsScanner> {
    let eng = build_engine(patterns, options_json)?;
    let (tx, rx) = crossbeam_channel::unbounded::<Vec<engine::Entry>>();
    std::thread::spawn(move || {
        // `light = true` skips per-file stat calls and content reads: only
        // the relative path is populated.
        eng.run_batched(tx, true);
    });
    Ok(PathsScanner {
        rx: Arc::new(Mutex::new(Some(rx))),
        buffer: Arc::new(Mutex::new(std::collections::VecDeque::new())),
        finished: Arc::new(AtomicBool::new(false)),
    })
}

/// Import-graph query: every JS/TS file under cwd that imports `target`
/// (a cwd-relative path) directly or transitively, as one NUL-joined
/// string of relative paths.
#[napi]
pub fn dependents_of_sync(target: String, options_json: Option<String>) -> Result<String> {
    let options = parse_options(options_json)?;
    let deps = graph::dependents_of(options, &target).map_err(Error::from_reason)?;
    Ok(deps.join("\0"))
}

/// Debug/introspection helper: parse a query and return its structure as JSON.
#[napi]
pub fn parse_query_json(input: String) -> Result<String> {
    let q = selectors::parse_query(&input).map_err(Error::from_reason)?;
    let selectors_dbg: Vec<String> = q.selectors.iter().map(|s| format!("{s:?}")).collect();
    let out = serde_json::json!({
        "patterns": q.patterns,
        "negatives": q.negatives,
        "selectors": selectors_dbg,
    });
    Ok(out.to_string())
}

#[napi]
pub fn version() -> String {
    // HYPERGLOB_VERSION is injected by build.rs from the npm package version
    // (package.json), which is the single source of truth. It falls back to the
    // crate version when the crate is built without the npm build script.
    option_env!("HYPERGLOB_VERSION")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_string()
}
