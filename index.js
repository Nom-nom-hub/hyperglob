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

/**
 * hyperglobSync(patterns, options) -> Entry[]
 * Synchronous batch API (PRD §5.2).
 * With `pathsOnly: true`, returns relative path strings instead of entries
 * (the fast path — comparable to fast-glob's default string output).
 */
function hyperglobSync(patterns, options) {
  if (options && options.pathsOnly) {
    const opts = normalizeOptions(options);
    return native.scanPathsSync(toPatterns(patterns), opts ? JSON.stringify(opts) : null);
  }
  return scanRawSync(patterns, options).map((e) => toEntry(e, options));
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
      const paths = native.scanPathsSync(this._patterns, opts ? JSON.stringify(opts) : null);
      for (const p of paths) yield p;
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

module.exports = {
  hyperglob,
  hyperglobSync,
  HyperglobStream,
  parseQuery,
  version: () => native.version(),
  native,
};
module.exports.default = hyperglob;
