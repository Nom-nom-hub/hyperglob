'use strict';

const fs = require('fs');
const path = require('path');

function nativeFilename() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return 'hyperglob.linux-x64-gnu.node';
  if (platform === 'linux' && arch === 'arm64') return 'hyperglob.linux-arm64-gnu.node';
  if (platform === 'darwin' && arch === 'x64') return 'hyperglob.darwin-x64.node';
  if (platform === 'darwin' && arch === 'arm64') return 'hyperglob.darwin-arm64.node';
  if (platform === 'win32' && arch === 'x64') return 'hyperglob.win32-x64-msvc.node';
  throw new Error(`hyperglob: unsupported platform ${platform}-${arch}`);
}

function loadNative() {
  const file = nativeFilename();
  const candidates = [
    path.join(__dirname, file),
    path.join(__dirname, 'native', file),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error(
    `hyperglob: native binding not found (${file}). Run \`npm run build\` to compile the Rust core.`
  );
}

const native = loadNative();

function toPatterns(patterns) {
  if (typeof patterns === 'string') return [patterns];
  if (Array.isArray(patterns)) {
    for (const p of patterns) {
      if (typeof p !== 'string') throw new TypeError('hyperglob: patterns must be strings');
    }
    return patterns.slice();
  }
  throw new TypeError('hyperglob: patterns must be a string or an array of strings');
}

function normalizeOptions(options) {
  if (options == null) return null;
  const out = {};
  if (options.cwd !== undefined) out.cwd = String(options.cwd);
  if (options.gitignore !== undefined) out.gitignore = !!options.gitignore;
  if (options.ignoreFiles !== undefined) out.ignoreFiles = !!options.ignoreFiles;
  if (options.dot !== undefined) out.dot = !!options.dot;
  if (options.maxDepth !== undefined && options.maxDepth !== null) out.maxDepth = options.maxDepth | 0;
  if (options.threads !== undefined) out.threads = options.threads | 0;
  if (options.stats !== undefined) out.stats = !!options.stats;
  if (options.onlyFiles !== undefined) out.onlyFiles = !!options.onlyFiles;
  if (options.followSymlinks !== undefined) out.followSymlinks = !!options.followSymlinks;
  // PRD uses `stats` + entry.content; accept both `content` and `withContent`.
  const withContent = options.withContent !== undefined ? options.withContent : options.content;
  if (withContent !== undefined) out.withContent = !!withContent;
  if (options.ignore !== undefined) out.ignore = toPatterns(options.ignore);
  if (options.index !== undefined) out.index = !!options.index;
  return out;
}

function toEntry(raw, options) {
  const entry = {
    path: raw.path,
    relativePath: raw.relativePath,
    name: raw.name,
    extension: raw.extension,
    isFile: raw.isFile,
    isDir: raw.isDir,
  };
  if (!options || options.stats !== false) {
    entry.size = raw.size;
    entry.modified = new Date(raw.modifiedMs);
    entry.modifiedMs = raw.modifiedMs;
  }
  if (raw.content !== undefined && raw.content !== null) {
    entry.content = raw.content;
    entry.buffer = Buffer.from(raw.content, 'utf8');
  }
  return entry;
}

function scanRawSync(patterns, options) {
  const opts = normalizeOptions(options);
  return native.scanSync(toPatterns(patterns), opts ? JSON.stringify(opts) : null);
}

// Entry objects are instances of this class: `modified` (Date) and
// `buffer` are prototype getters, built lazily on first access — creating
// 10k+ Dates/Buffers eagerly is pure overhead when most consumers never
// touch them. `modifiedMs` is always present as a plain number.
class HyperEntry {
  get modified() {
    if (this._modified === undefined) {
      this._modified = new Date(this.modifiedMs);
    }
    return this._modified;
  }

  get buffer() {
    if (this.content === undefined) return undefined;
    if (this._buffer === undefined) {
      this._buffer = Buffer.from(this.content, 'utf8');
    }
    return this._buffer;
  }

  toJSON() {
    const out = {
      path: this.path,
      relativePath: this.relativePath,
      name: this.name,
      extension: this.extension,
      isFile: this.isFile,
      isDir: this.isDir,
    };
    if (this.size !== undefined) {
      out.size = this.size;
      out.modifiedMs = this.modifiedMs;
      out.modified = this.modified.toISOString();
    }
    if (this.content !== undefined) out.content = this.content;
    return out;
  }
}

function splitJoined(s, n) {
  if (n === 0) return [];
  if (s === '') return new Array(n).fill('');
  return s.split('\0');
}

// Zip the native columnar transport into Entry objects.
function columnsToEntries(cols, options) {
  const n = cols.count;
  const out = new Array(n);
  if (n === 0) return out;
  const paths = splitJoined(cols.paths, n);
  const rels = splitJoined(cols.relativePaths, n);
  const names = splitJoined(cols.names, n);
  const exts = splitJoined(cols.extensions, n);
  const flags = cols.flags;
  const withStats = !options || options.stats !== false;
  const numBuf = cols.numbers;
  let nums = null;
  if (withStats) {
    nums = numBuf.byteOffset % 8 === 0
      ? new Float64Array(numBuf.buffer, numBuf.byteOffset, n * 2)
      : new Float64Array(Uint8Array.from(numBuf).buffer);
  }
  const fullContents = cols.contents.length === n;
  for (let i = 0; i < n; i++) {
    const entry = new HyperEntry();
    entry.path = paths[i];
    entry.relativePath = rels[i];
    entry.name = names[i];
    entry.extension = exts[i];
    const f = flags[i];
    entry.isFile = (f & 1) !== 0;
    entry.isDir = (f & 2) !== 0;
    if (withStats) {
      entry.size = nums[i * 2];
      entry.modifiedMs = nums[i * 2 + 1];
    }
    if (fullContents && cols.hasContent[i]) {
      entry.content = cols.contents[i];
    }
    out[i] = entry;
  }
  return out;
}

function splitPaths(joined) {
  return joined === '' ? [] : joined.split('\0');
}

function scanColumnsSync(patterns, options) {
  const opts = normalizeOptions(options);
  return native.scanColumnsSync(toPatterns(patterns), opts ? JSON.stringify(opts) : null);
}

/**
 * hyperglobSync(patterns, options) -> Entry[]
 * Synchronous batch API (PRD §5.2).
 * With `pathsOnly: true`, returns relative path strings instead of entries
 * (the fast path — comparable to fast-glob's default string output).
 */
function hyperglobSync(patterns, options) {
  if (options && options.pathsOnly) {
    const opts = normalizeOptions(options);
    return splitPaths(native.scanPathsSync(toPatterns(patterns), opts ? JSON.stringify(opts) : null));
  }
  return columnsToEntries(scanColumnsSync(patterns, options), options);
}

class HyperglobStream {
  constructor(patterns, options) {
    this._patterns = toPatterns(patterns);
    this._options = options || {};
    this._scanner = null;
    this._collected = null;
  }

  _open() {
    if (!this._scanner) {
      const opts = normalizeOptions(this._options);
      this._scanner = native.createScanner(
        this._patterns,
        opts ? JSON.stringify(opts) : null
      );
    }
    return this._scanner;
  }

  async *[Symbol.asyncIterator]() {
    if (this._options && this._options.pathsOnly) {
      const opts = normalizeOptions(this._options);
      const joined = native.scanPathsSync(this._patterns, opts ? JSON.stringify(opts) : null);
      for (const p of splitPaths(joined)) yield p;
      return;
    }
    const scanner = this._open();
    try {
      for (;;) {
        const batch = scanner.nextBatch(256);
        for (const raw of batch.entries) yield toEntry(raw, this._options);
        if (batch.done) break;
        if (batch.entries.length === 0) {
          await new Promise((r) => setImmediate(r));
        }
      }
    } finally {
      try { scanner.close(); } catch (_) { /* already closed */ }
    }
  }

  /** Collect the whole stream into an array (also makes the stream awaitable). */
  async collect() {
    if (!this._collected) {
      this._collected = (async () => {
        const out = [];
        for await (const entry of this) out.push(entry);
        return out;
      })();
    }
    return this._collected;
  }

  then(onFulfilled, onRejected) {
    return this.collect().then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this.collect().catch(onRejected);
  }

  finally(onFinally) {
    return this.collect().finally(onFinally);
  }
}

/**
 * hyperglob(patterns, options) -> AsyncIterable<Entry> (also awaitable -> Entry[])
 * Streaming API (PRD §5.1).
 *
 *   for await (const entry of hyperglob('src/**' + '/*.ts :contains("useServerHook")')) { ... }
 *   const entries = await hyperglob('src/**' + '/*.ts');
 */
function hyperglob(patterns, options) {
  return new HyperglobStream(patterns, options);
}

function parseQuery(input) {
  return JSON.parse(native.parseQueryJson(String(input)));
}

/**
 * hyperglobDependents(target, options) -> string[]
 * Import-graph query: every JS/TS file under `cwd` that imports `target`
 * (a cwd-relative path like 'src/hooks.ts') directly or transitively —
 * the "what breaks if I change this file" set.
 */
function hyperglobDependents(target, options) {
  const opts = normalizeOptions(options);
  return splitPaths(native.dependentsOfSync(String(target), opts ? JSON.stringify(opts) : null));
}

module.exports = {
  hyperglob,
  hyperglobSync,
  hyperglobDependents,
  HyperglobStream,
  HyperEntry,
  parseQuery,
  version: () => native.version(),
  native,
};
module.exports.default = hyperglob;
