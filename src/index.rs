//! Warm index: a persistent snapshot of the tree under `<cwd>/.hyperglob/`
//! that lets repeat queries skip the traversal entirely.
//!
//! Design (correctness first):
//! - The snapshot records every non-ignored entry (rel path, is_file, size,
//!   mtime), every visited directory's mtime, and a fingerprint of every
//!   ignore file (.gitignore / .ignore / .agentignore / .git/info/exclude)
//!   plus the global gitignore's standard XDG location.
//! - Validation stats every recorded directory and ignore file. Creating,
//!   deleting or renaming anything bumps its parent directory's mtime, so a
//!   fully-matching validation means the tree *structure* is unchanged and
//!   pathsOnly answers are exact.
//! - File *content* edits do not bump directory mtimes, so for entries and
//!   metadata-selector queries the matched candidates are re-stat'ed (and
//!   content selectors always read fresh bytes) — metadata answers stay
//!   exact too; the cost is proportional to the match set, not the tree.
//! - Any validation failure rebuilds the snapshot with a full scan and
//!   answers the current query from the fresh snapshot.
//!
//! Known edge: filesystems with coarse (1s) mtime granularity can miss a
//! structural change made inside the same second as the snapshot build.

use crate::engine::{set_matches, Engine, Entry};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize)]
struct SnapEntry {
    r: String,
    f: bool, // is_file
    s: u64,
    m: i64,
}

#[derive(Serialize, Deserialize)]
struct SnapDir {
    r: String,
    m: i64,
}

#[derive(Serialize, Deserialize)]
struct SnapIgnore {
    r: String,
    m: i64,
    s: u64,
}

struct Snapshot {
    fingerprint: String,
    entries: Vec<SnapEntry>,
    dirs: Vec<SnapDir>,
    ignore_files: Vec<SnapIgnore>,
}

/// On-disk header (the only JSON in the file). Layout after the header line:
/// [paths blob: NUL-joined rel paths][flags: 1 byte/entry][numbers: 16
/// bytes/entry, LE f64 size + mtime_ms]. Columnar, like the N-API
/// transport — parsing a 110k-entry JSON snapshot cost tens of ms per
/// query; splitting a joined blob costs ~2 ms.
#[derive(Serialize, Deserialize)]
struct SnapHeader {
    version: u32,
    fingerprint: String,
    count: usize,
    paths_bytes: usize,
    dirs: Vec<SnapDir>,
    ignore_files: Vec<SnapIgnore>,
}

const SNAP_VERSION: u32 = 2;
const IGNORE_NAMES: [&str; 3] = [".gitignore", ".ignore", ".agentignore"];

fn fingerprint(opts: &crate::engine::Options) -> String {
    format!(
        "g{}i{}d{}s{}",
        opts.gitignore as u8, opts.ignore_files as u8, opts.dot as u8, opts.follow_symlinks as u8
    )
}

fn index_path(cwd: &Path) -> PathBuf {
    cwd.join(".hyperglob").join("index.json")
}

fn stat_of(path: &Path) -> Option<(u64, i64)> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some((md.len(), mtime))
}

fn build_snapshot(engine: &Engine) -> Option<Snapshot> {
    let mut opts = engine.options.clone();
    opts.only_files = false;
    opts.stats = true;
    opts.with_content = false;
    opts.index = false;
    // Record the full tree: the caller's options.ignore patterns are result
    // filters (re-applied from the snapshot at answer time), so the build
    // scan must not prune by them — only our own index dir is excluded.
    opts.ignore = vec![".hyperglob".to_string(), ".hyperglob/**".to_string()];
    let scan = Engine::new(&["**".to_string()], opts).ok()?;
    let entries = scan.collect_entries_raw(false);
    let mut snap_entries: Vec<SnapEntry> = Vec::with_capacity(entries.len());
    let mut dirs: Vec<SnapDir> = Vec::new();
    for e in &entries {
        snap_entries.push(SnapEntry {
            r: e.relative_path.clone(),
            f: e.is_file,
            s: e.size,
            m: e.modified_ms,
        });
        if e.is_dir {
            dirs.push(SnapDir {
                r: e.relative_path.clone(),
                m: e.modified_ms,
            });
        }
    }
    // Root directory itself.
    if let Some((_, m)) = stat_of(&engine.cwd) {
        dirs.push(SnapDir {
            r: String::new(),
            m,
        });
    }
    // Ignore-file fingerprints for every visited directory + root plumbing.
    let mut ignore_files: Vec<SnapIgnore> = Vec::new();
    let mut dir_rels: Vec<&str> = dirs.iter().map(|d| d.r.as_str()).collect();
    dir_rels.sort_unstable();
    dir_rels.dedup();
    for d in dir_rels {
        for name in IGNORE_NAMES {
            let rel = if d.is_empty() {
                name.to_string()
            } else {
                format!("{d}/{name}")
            };
            if let Some((s, m)) = stat_of(&engine.cwd.join(&rel)) {
                ignore_files.push(SnapIgnore { r: rel, m, s });
            }
        }
    }
    if let Some((s, m)) = stat_of(&engine.cwd.join(".git/info/exclude")) {
        ignore_files.push(SnapIgnore {
            r: ".git/info/exclude".to_string(),
            m,
            s,
        });
    }
    if let Some(home) = std::env::var_os("HOME") {
        let global = PathBuf::from(home).join(".config/git/ignore");
        if let Some((s, m)) = stat_of(&global) {
            ignore_files.push(SnapIgnore {
                r: "global:git/ignore".to_string(),
                m,
                s,
            });
        }
    }
    Some(Snapshot {
        fingerprint: fingerprint(&engine.options),
        entries: snap_entries,
        dirs,
        ignore_files,
    })
}

fn write_snapshot(cwd: &Path, snap: &Snapshot) {
    let dir = cwd.join(".hyperglob");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut paths = String::new();
    let mut flags: Vec<u8> = Vec::with_capacity(snap.entries.len());
    let mut numbers: Vec<u8> = Vec::with_capacity(snap.entries.len() * 16);
    for (i, e) in snap.entries.iter().enumerate() {
        if i > 0 {
            paths.push('\0');
        }
        paths.push_str(&e.r);
        flags.push(e.f as u8);
        numbers.extend_from_slice(&(e.s as f64).to_le_bytes());
        numbers.extend_from_slice(&(e.m as f64).to_le_bytes());
    }
    let header = SnapHeader {
        version: SNAP_VERSION,
        fingerprint: snap.fingerprint.clone(),
        count: snap.entries.len(),
        paths_bytes: paths.len(),
        dirs: Vec::new(),
        ignore_files: Vec::new(),
    };
    let header_json = match serde_json::to_string(&SnapHeader {
        dirs: snap
            .dirs
            .iter()
            .map(|d| SnapDir {
                r: d.r.clone(),
                m: d.m,
            })
            .collect(),
        ignore_files: snap
            .ignore_files
            .iter()
            .map(|f| SnapIgnore {
                r: f.r.clone(),
                m: f.m,
                s: f.s,
            })
            .collect(),
        ..header
    }) {
        Ok(j) => j,
        Err(_) => return,
    };
    let mut buf: Vec<u8> = Vec::with_capacity(header_json.len() + 1 + paths.len() + flags.len() + numbers.len());
    buf.extend_from_slice(header_json.as_bytes());
    buf.push(b'\n');
    buf.extend_from_slice(paths.as_bytes());
    buf.extend_from_slice(&flags);
    buf.extend_from_slice(&numbers);
    let tmp = dir.join("index.json.tmp");
    if std::fs::write(&tmp, buf).is_ok() {
        let _ = std::fs::rename(&tmp, index_path(cwd));
    }
}

fn load_snapshot(cwd: &Path) -> Option<Snapshot> {
    let raw = std::fs::read(index_path(cwd)).ok()?;
    let nl = memchr::memchr(b'\n', &raw)?;
    let header: SnapHeader = serde_json::from_slice(&raw[..nl]).ok()?;
    if header.version != SNAP_VERSION {
        return None;
    }
    let body = &raw[nl + 1..];
    if body.len() < header.paths_bytes + header.count + header.count * 16 {
        return None;
    }
    let paths_blob = &body[..header.paths_bytes];
    let flags = &body[header.paths_bytes..header.paths_bytes + header.count];
    let numbers = &body[header.paths_bytes + header.count..];
    let mut entries: Vec<SnapEntry> = Vec::with_capacity(header.count);
    let mut start = 0usize;
    for i in 0..header.count {
        let end = if i + 1 == header.count {
            paths_blob.len()
        } else {
            memchr::memchr(b'\0', &paths_blob[start..]).map(|p| start + p)?
        };
        let rel = String::from_utf8_lossy(&paths_blob[start..end]).into_owned();
        let size = f64::from_le_bytes(numbers[i * 16..i * 16 + 8].try_into().ok()?) as u64;
        let mtime = f64::from_le_bytes(numbers[i * 16 + 8..i * 16 + 16].try_into().ok()?) as i64;
        entries.push(SnapEntry {
            r: rel,
            f: flags[i] != 0,
            s: size,
            m: mtime,
        });
        start = end + 1;
    }
    Some(Snapshot {
        fingerprint: header.fingerprint,
        entries,
        dirs: header.dirs,
        ignore_files: header.ignore_files,
    })
}

fn validate(engine: &Engine, snap: &Snapshot) -> bool {
    if snap.fingerprint != fingerprint(&engine.options) {
        return false;
    }
    let cwd = &engine.cwd;
    let dirs_ok = snap.dirs.par_iter().all(|d| {
        let p = if d.r.is_empty() {
            cwd.clone()
        } else {
            cwd.join(&d.r)
        };
        stat_of(&p).map(|(_, m)| m == d.m).unwrap_or(false)
    });
    if !dirs_ok {
        return false;
    }
    snap.ignore_files.iter().all(|f| {
        let p = if f.r == "global:git/ignore" {
            match std::env::var_os("HOME") {
                Some(h) => PathBuf::from(h).join(".config/git/ignore"),
                None => return true,
            }
        } else {
            cwd.join(&f.r)
        };
        stat_of(&p).map(|(s, m)| s == f.s && m == f.m).unwrap_or(false)
    })
}

fn depth_of(rel: &str) -> usize {
    if rel.is_empty() {
        0
    } else {
        rel.split('/').count()
    }
}

fn answer(engine: &Engine, snap: &Snapshot, light: bool) -> Vec<Entry> {
    let opts = &engine.options;
    let need_stats = engine.has_meta_selectors || (!light && engine.stats_requested);
    snap.entries
        .par_iter()
        .filter_map(|se| {
            let rel = &se.r;
            let is_file = se.f;
            let is_dir = !is_file;
            if is_dir && opts.only_files {
                return None;
            }
            if let Some(md) = opts.max_depth {
                // Depth is walk-root-relative, like the live walker.
                if depth_of(rel).saturating_sub(engine.root_depth) > md {
                    return None;
                }
            }
            if !set_matches(&engine.positive_set, rel)
                || set_matches(&engine.negative_set, rel)
                || set_matches(&engine.ignore_set, rel)
            {
                return None;
            }
            let path = engine.cwd.join(rel);
            let (size, modified_ms) = if need_stats {
                match stat_of(&path) {
                    Some((s, m)) => (s, m),
                    None => return None, // raced deletion
                }
            } else if light || !engine.stats_requested {
                (0, 0)
            } else {
                (se.s, se.m)
            };
            for sel in &engine.query.selectors {
                if !sel.eval_metadata(size, modified_ms) {
                    return None;
                }
            }
            let mut content: Option<String> = None;
            if is_file && (engine.needs_content || opts.with_content) {
                let bytes = std::fs::read(&path).ok()?;
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_string();
                for sel in &engine.query.selectors {
                    if sel.needs_content() && !sel.eval_content_ext(&bytes, &ext) {
                        return None;
                    }
                }
                if opts.with_content && !light {
                    content = Some(String::from_utf8_lossy(&bytes).into_owned());
                }
            } else if engine.needs_content && !is_file {
                return None;
            }
            if light {
                return Some(Entry {
                    path: String::new(),
                    relative_path: rel.clone(),
                    name: String::new(),
                    extension: String::new(),
                    size,
                    modified_ms,
                    is_file,
                    is_dir,
                    content: None,
                });
            }
            let name = Path::new(rel)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let extension = Path::new(rel)
                .extension()
                .map(|e| e.to_string_lossy().into_owned())
                .unwrap_or_default();
            Some(Entry {
                path: path.to_string_lossy().into_owned(),
                relative_path: rel.clone(),
                name,
                extension,
                size,
                modified_ms,
                is_file,
                is_dir,
                content,
            })
        })
        .collect()
}

/// Entry point used by Engine::collect / collect_paths when options.index
/// is set. Valid snapshot → answered in memory; anything else → rebuild.
pub fn collect_indexed(engine: &Engine, light: bool) -> Vec<Entry> {
    if let Some(snap) = load_snapshot(&engine.cwd) {
        if validate(engine, &snap) {
            return answer(engine, &snap, light);
        }
    }
    match build_snapshot(engine) {
        Some(snap) => {
            write_snapshot(&engine.cwd, &snap);
            answer(engine, &snap, light)
        }
        None => engine.collect_entries_raw(light),
    }
}
