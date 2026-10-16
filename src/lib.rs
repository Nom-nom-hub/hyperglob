//! hyperglob — multi-threaded, AST-aware, zero-copy file discovery.
//!
//! Rust core (parallel walker + in-flight selectors) exposed to Node.js
//! through N-API. The streaming API is pull-based: a background thread runs
//! the parallel walker and feeds a lock-free-ish channel; JavaScript pulls
//! batches via `Scanner::next_batch`, so results cross the N-API boundary
//! in small chunks allocated on the Rust side instead of one giant array.

mod engine;
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

fn parse_options(options_json: Option<String>) -> Result<Options> {
    match options_json {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Options>(&s)
            .map_err(|e| Error::from_reason(format!("invalid options JSON: {e}"))),
        _ => Ok(Options::default()),
    }
}

fn build_engine(patterns: Vec<String>, options_json: Option<String>) -> Result<Engine> {
    let options = parse_options(options_json)?;
    let eng = Engine::new(&patterns, options)
        .map_err(|e| Error::from_reason(e))?;
    engine::ensure_walk_root_exists(&eng).map_err(|e| Error::from_reason(e))?;
    Ok(eng)
}

/// Synchronous full scan. Returns every matching entry at once.
#[napi]
pub fn scan_sync(patterns: Vec<String>, options_json: Option<String>) -> Result<Vec<NativeEntry>> {
    let eng = build_engine(patterns, options_json)?;
    Ok(eng.collect().into_iter().map(NativeEntry::from).collect())
}

/// Fast path: matching relative paths as plain strings, no entry objects.
#[napi]
pub fn scan_paths_sync(patterns: Vec<String>, options_json: Option<String>) -> Result<Vec<String>> {
    let eng = build_engine(patterns, options_json)?;
    Ok(eng.collect_paths())
}

/// Streaming scanner. The parallel walker runs on a background Rust thread;
/// `next_batch` pulls up to `max` entries at a time from its channel.
#[napi]
pub struct Scanner {
    rx: Arc<Mutex<Option<std::sync::mpsc::Receiver<engine::Entry>>>>,
    finished: Arc<AtomicBool>,
}

#[napi]
impl Scanner {
    /// Pull the next batch. `done: true` (with whatever entries remain)
    /// means the traversal has finished and the channel is drained.
    #[napi]
    pub fn next_batch(&self, max: Option<u32>) -> NativeBatch {
        let max = max.unwrap_or(128).max(1) as usize;
        if self.finished.load(Ordering::SeqCst) {
            return NativeBatch {
                entries: Vec::new(),
                done: true,
            };
        }
        let mut entries: Vec<NativeEntry> = Vec::with_capacity(max);
        let mut done = false;
        {
            let guard = self.rx.lock().unwrap();
            if let Some(rx) = guard.as_ref() {
                for i in 0..max {
                    let timeout = if i == 0 {
                        std::time::Duration::from_millis(50)
                    } else {
                        std::time::Duration::from_millis(2)
                    };
                    match rx.recv_timeout(timeout) {
                        Ok(e) => entries.push(NativeEntry::from(e)),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            done = true;
                            break;
                        }
                    }
                }
            } else {
                done = true;
            }
        }
        if done {
            self.finished.store(true, Ordering::SeqCst);
        }
        NativeBatch { entries, done }
    }

    /// Stop the scan early. Dropping the receiver makes walker visitors quit.
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
    let (tx, rx) = std::sync::mpsc::channel::<engine::Entry>();
    std::thread::spawn(move || {
        eng.run(tx);
    });
    Ok(Scanner {
        rx: Arc::new(Mutex::new(Some(rx))),
        finished: Arc::new(AtomicBool::new(false)),
    })
}

/// Debug/introspection helper: parse a query and return its structure as JSON.
#[napi]
pub fn parse_query_json(input: String) -> Result<String> {
    let q = selectors::parse_query(&input).map_err(|e| Error::from_reason(e))?;
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
    env!("CARGO_PKG_VERSION").to_string()
}
