#!/usr/bin/env node
'use strict';

// hyperglob MCP server (stdio, JSON-RPC 2.0, newline-delimited).
//
// Lets any MCP-speaking agent use hyperglob without Node bindings:
//   { "mcpServers": { "hyperglob": { "command": "node", "args": ["<path>/mcp.js"] } } }
//
// Tools:
//   hyperglob_query     — full entries for a pattern (+ selectors), JSON out
//   hyperglob_paths     — paths-only fast path, one path per line
//   hyperglob_dependents — transitive importers of a file
//
// Design notes (production readiness):
//   * stdout belongs to the JSON-RPC stream. A guard redirects any foreign
//     stdout write (e.g. index.js's auto-install fallback, which runs
//     scripts/install.js with stdio:'inherit') to stderr so the protocol
//     stream can never be corrupted.
//   * Tool calls run inside a worker thread. That gives the server (a) a
//     hard timeout — a native call that never returns can no longer wedge
//     the server, (b) crash isolation — a native segfault kills the worker,
//     not the protocol loop, and (c) responsiveness — the event loop stays
//     free while a scan runs, so notifications are still processed.
//   * Every module is importable without side effects: `handle`, `TOOLS` and
//     the job runner are exported, and the stdio loop only starts when this
//     file is the process entry point.

const readline = require('readline');
const path = require('path');
const { Worker } = require('worker_threads');

// ---------------------------------------------------------------------------
// stdout guard
// ---------------------------------------------------------------------------
// The JSON-RPC stream owns stdout. Anything else that writes to stdout would
// corrupt it, so the real writer is captured and every foreign write is
// redirected to stderr.
const rawStdoutWrite = process.stdout.write.bind(process.stdout);
let emittingProtocol = false;
// Overridable sink for the protocol stream (tests capture it).
let protocolSink = (text) => rawStdoutWrite(text);

function installStdoutGuard() {
  process.stdout.write = function guardedWrite(chunk, encoding, cb) {
    if (emittingProtocol) return rawStdoutWrite(chunk, encoding, cb);
    try {
      return process.stderr.write(chunk, encoding, cb);
    } catch (_) {
      return false;
    }
  };
}

/**
 * Guard the file-descriptor level, not just the JS write() call.
 *
 * index.js falls back to `execFileSync(node, [scripts/install.js],
 * { stdio: 'inherit' })` when the native binding is missing. 'inherit' hands
 * the child the parent's fd 1 directly, so the child's `console.log` would
 * land in the middle of the JSON-RPC stream and a JS-level write() override
 * could not stop it. Rewrite 'inherit' to a piped stdout that we forward to
 * stderr, so nothing can ever write to the protocol stream but us.
 */
function installChildProcessGuard() {
  const cp = require('child_process');
  const NAMES = ['execFileSync', 'execFile', 'spawnSync', 'spawn'];
  for (const name of NAMES) {
    const orig = cp[name];
    if (typeof orig !== 'function') continue;
    cp[name] = function guardedChildProcess(...args) {
      // execFile*/spawn* all take (file|command, args, options) — options is
      // the third parameter.
      const options = args[2];
      if (options && options.stdio === 'inherit') {
        const patched = Object.assign({}, options, { stdio: ['ignore', 'pipe', 'inherit'] });
        args[2] = patched;
        const result = orig.apply(this, args);
        // Forward the piped stdout to stderr so the child cannot corrupt the
        // protocol stream and cannot block on a full pipe.
        if (name === 'spawn' || name === 'execFile') {
          const stream = result && result.stdout;
          if (stream && typeof stream.on === 'function') {
            stream.on('data', (d) => { try { process.stderr.write(d); } catch (_) {} });
          }
        } else {
          // execFileSync / spawnSync: stdout is a Buffer on the result.
          const buf = result && result.stdout;
          if (buf && buf.length) {
            try { process.stderr.write(buf); } catch (_) {}
          }
        }
        return result;
      }
      return orig.apply(this, args);
    };
  }
}

function emitProtocol(text) {
  emittingProtocol = true;
  try {
    return protocolSink(text);
  } finally {
    emittingProtocol = false;
  }
}

/** Redirect the protocol stream (used by tests). Returns a restore function. */
function setProtocolSink(sink) {
  const prev = protocolSink;
  protocolSink = typeof sink === 'function' ? sink : (text) => rawStdoutWrite(text);
  return () => {
    protocolSink = prev;
  };
}

const IS_MAIN = require.main === module;
if (IS_MAIN) {
  installStdoutGuard();
  installChildProcessGuard();
}

const { hyperglobSync, hyperglobDependents, version } = require('./index.js');

// ---------------------------------------------------------------------------
// protocol constants
// ---------------------------------------------------------------------------

// The MCP spec requires the server to answer with a protocol version it
// supports. When the client asks for a version we know, we echo it back;
// otherwise we answer with the version this server is validated against.
const PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

// Default wall-clock budget for one tool call. Overridable per call
// (`timeoutMs`), per process (`HYPERGLOB_MCP_TIMEOUT_MS`) and per launch
// (`--timeout-ms`).
const DEFAULT_TIMEOUT_MS = 60000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;

// Result page size. An MCP tool result is a single text blob that ends up in
// the model's context, so a cap is mandatory: 500 full entries is already
// ~75k tokens. The response always carries `total` + `truncated` so an agent
// can page (`offset`) or raise `limit`.
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10000;

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const QUERY_PROPERTIES = {
  pattern: {
    type: 'string',
    description:
      'Glob pattern, optionally followed by selectors, e.g. src/**/*.ts :exports("useServerHook")',
  },
  cwd: { type: 'string', description: 'Root directory to search from (default: server cwd)' },
  maxDepth: { type: 'number', minimum: 0, description: 'Maximum traversal depth' },
  threads: { type: 'number', minimum: 0, description: 'Walker threads (0 = auto)' },
  dot: { type: 'boolean', description: 'Include dotfiles / dot-directories (default false)' },
  gitignore: {
    type: 'boolean',
    description: 'Obey .gitignore / .git/info/exclude / global gitignore (default true)',
  },
  ignoreFiles: {
    type: 'boolean',
    description: 'Obey .ignore and .agentignore files (default true)',
  },
  ignore: {
    type: 'array',
    items: { type: 'string' },
    description: 'Extra glob patterns to exclude, e.g. ["**/dist/**", "**/*.min.js"]',
  },
  onlyFiles: { type: 'boolean', description: 'Only return files (default true); false includes directories' },
  followSymlinks: { type: 'boolean', description: 'Follow symlinked directories (default false)' },
  stats: { type: 'boolean', description: 'Populate size / modified on entries (default true)' },
  content: { type: 'boolean', description: 'Include file contents in entries (default false)' },
  index: {
    type: 'boolean',
    description: 'Use the warm index snapshot at <cwd>/.hyperglob/ for repeat queries (default false)',
  },
  limit: {
    type: 'number',
    minimum: 1,
    maximum: MAX_LIMIT,
    description: `Maximum number of entries to return (default ${DEFAULT_LIMIT})`,
  },
  offset: { type: 'number', minimum: 0, description: 'Skip this many matches before collecting (paging)' },
  timeoutMs: {
    type: 'number',
    minimum: MIN_TIMEOUT_MS,
    maximum: MAX_TIMEOUT_MS,
    description: `Wall-clock budget for this call in ms (default ${DEFAULT_TIMEOUT_MS})`,
  },
};

const TOOLS = [
  {
    name: 'hyperglob_query',
    description:
      'Find files with glob patterns plus in-flight selectors evaluated during traversal: ' +
      ':contains("text") / :contains(/regex/), :exports(name) (real AST check), ' +
      ':imports(name), :has-key("dependencies.react"), :size(<100kb), :modified(>2026-10-01). ' +
      'Respects .gitignore/.ignore/.agentignore natively. Returns JSON of the shape ' +
      '{ count, total, offset, limit, truncated, entries[] } where each entry has ' +
      'path, relativePath, name, extension, size, isFile, isDir, modified. ' +
      '`total` is the number of matches found; `truncated` is true when more matched than were returned — ' +
      'raise `limit` or use `offset` to page through the rest.',
    inputSchema: {
      type: 'object',
      properties: { ...QUERY_PROPERTIES },
      required: ['pattern'],
    },
  },
  {
    name: 'hyperglob_dependents',
    description:
      'Import-graph query: list every JS/TS file that imports the given file (a cwd-relative path like src/hooks.ts) ' +
      'directly or transitively — the "what breaks if I change this file" set. ' +
      'Returns one relative path per line.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Cwd-relative path of the file whose dependents to find' },
        cwd: { type: 'string', description: 'Root directory (default: server cwd)' },
        maxDepth: { type: 'number', minimum: 0, description: 'Maximum traversal depth' },
        dot: { type: 'boolean', description: 'Include dotfiles / dot-directories (default false)' },
        gitignore: { type: 'boolean', description: 'Obey .gitignore (default true)' },
        ignoreFiles: { type: 'boolean', description: 'Obey .ignore and .agentignore files (default true)' },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra glob patterns to exclude',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum number of dependents to return (default ${DEFAULT_LIMIT})`,
        },
        timeoutMs: {
          type: 'number',
          minimum: MIN_TIMEOUT_MS,
          maximum: MAX_TIMEOUT_MS,
          description: `Wall-clock budget for this call in ms (default ${DEFAULT_TIMEOUT_MS})`,
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'hyperglob_paths',
    description:
      'Fast paths-only file discovery: same pattern/selector syntax as hyperglob_query, returns just relative paths ' +
      '(one per line, empty output when nothing matched). Use this instead of hyperglob_query when you only need paths.',
    inputSchema: {
      type: 'object',
      properties: { ...QUERY_PROPERTIES },
      required: ['pattern'],
    },
  },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Error carrying a JSON-RPC "invalid params" code (-32602). */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = -32602;
  }
}

/** Normalize anything thrown into a readable message. */
function describeError(e) {
  if (e === null || e === undefined) return 'unknown error';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || e.name;
  try {
    return JSON.stringify(e);
  } catch (_) {
    return String(e);
  }
}

/** ISO timestamp or null. Guards the Invalid Date that index.js can produce. */
function isoOrNull(value) {
  if (!(value instanceof Date)) return null;
  const t = value.getTime();
  return Number.isFinite(t) ? value.toISOString() : null;
}

function isPlainString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Validate the tool arguments before anything is dispatched. */
function validateArgs(args) {
  if (args.maxDepth !== undefined && args.maxDepth !== null) {
    if (typeof args.maxDepth !== 'number' || !Number.isFinite(args.maxDepth) || args.maxDepth < 0) {
      throw new UsageError(`maxDepth must be a non-negative integer, got ${JSON.stringify(args.maxDepth)}`);
    }
  }
  if (args.threads !== undefined && args.threads !== null) {
    if (typeof args.threads !== 'number' || !Number.isFinite(args.threads) || args.threads < 0) {
      throw new UsageError(`threads must be a non-negative integer, got ${JSON.stringify(args.threads)}`);
    }
  }
  if (args.limit !== undefined && args.limit !== null) {
    if (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || args.limit < 1) {
      throw new UsageError(`limit must be a positive integer, got ${JSON.stringify(args.limit)}`);
    }
  }
  if (args.offset !== undefined && args.offset !== null) {
    if (typeof args.offset !== 'number' || !Number.isFinite(args.offset) || args.offset < 0) {
      throw new UsageError(`offset must be a non-negative integer, got ${JSON.stringify(args.offset)}`);
    }
  }
  if (args.timeoutMs !== undefined && args.timeoutMs !== null) {
    if (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs < MIN_TIMEOUT_MS) {
      throw new UsageError(`timeoutMs must be an integer >= ${MIN_TIMEOUT_MS}, got ${JSON.stringify(args.timeoutMs)}`);
    }
  }
  if (args.ignore !== undefined && args.ignore !== null) {
    const list = Array.isArray(args.ignore) ? args.ignore : [args.ignore];
    for (const g of list) {
      if (typeof g !== 'string') {
        throw new UsageError(`ignore must be a glob pattern string or an array of strings, got ${JSON.stringify(g)}`);
      }
    }
  }
  for (const key of ['dot', 'gitignore', 'ignoreFiles', 'onlyFiles', 'followSymlinks', 'stats', 'content', 'index']) {
    const v = args[key];
    if (v !== undefined && v !== null && typeof v !== 'boolean') {
      throw new UsageError(`${key} must be a boolean, got ${JSON.stringify(v)}`);
    }
  }
  if (args.cwd !== undefined && args.cwd !== null && typeof args.cwd !== 'string') {
    throw new UsageError(`cwd must be a string, got ${JSON.stringify(args.cwd)}`);
  }
}

function resolveLimit(raw) {
  if (raw === undefined || raw === null) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

function resolveOffset(raw) {
  if (raw === undefined || raw === null) return 0;
  return Math.max(0, Math.floor(raw));
}

function resolveTimeoutMs(raw, fallback) {
  // A per-call timeoutMs always wins. When the caller did not supply one,
  // fall back to the runner's configured default -- which is what
  // --timeout-ms and HYPERGLOB_MCP_TIMEOUT_MS set. Falling back to the
  // hard-coded 60s constant here silently ignored both, so a server
  // started with a longer budget still timed out at 60s.
  if (raw === undefined || raw === null) {
    const base = Number.isFinite(fallback) ? fallback : DEFAULT_TIMEOUT_MS;
    return Math.min(Math.max(Math.floor(base), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  }
  return Math.min(Math.max(Math.floor(raw), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/** Translate MCP tool arguments into hyperglob options. */
function buildOptions(args, pathsOnly) {
  const opts = { pathsOnly };
  if (args.cwd) opts.cwd = args.cwd;
  if (typeof args.maxDepth === 'number') opts.maxDepth = Math.floor(args.maxDepth);
  if (typeof args.threads === 'number') opts.threads = Math.floor(args.threads);
  if (typeof args.content === 'boolean') opts.content = args.content;
  if (typeof args.index === 'boolean') opts.index = args.index;
  if (typeof args.dot === 'boolean') opts.dot = args.dot;
  if (typeof args.gitignore === 'boolean') opts.gitignore = args.gitignore;
  if (typeof args.ignoreFiles === 'boolean') opts.ignoreFiles = args.ignoreFiles;
  if (typeof args.onlyFiles === 'boolean') opts.onlyFiles = args.onlyFiles;
  if (typeof args.followSymlinks === 'boolean') opts.followSymlinks = args.followSymlinks;
  if (typeof args.stats === 'boolean') opts.stats = args.stats;
  if (args.ignore !== undefined && args.ignore !== null) {
    opts.ignore = Array.isArray(args.ignore) ? args.ignore.slice() : [args.ignore];
  }
  return opts;
}

/** Plain, structured-clone-safe projection of a hyperglob entry. */
function toPlainEntry(e, includeContent) {
  const out = {
    path: e.path,
    relativePath: e.relativePath,
    name: e.name,
    extension: e.extension,
    size: typeof e.size === 'number' ? e.size : null,
    isFile: !!e.isFile,
    isDir: !!e.isDir,
    modified: isoOrNull(e.modified),
    modifiedMs: typeof e.modifiedMs === 'number' ? e.modifiedMs : null,
  };
  if (includeContent) out.content = e.content === undefined ? null : e.content;
  return out;
}

// ---------------------------------------------------------------------------
// jobs (executed in-process or inside the worker)
// ---------------------------------------------------------------------------

/** hyperglob_query: full entries, paged. */
function buildQueryPayload(args) {
  const entries = hyperglobSync(args.pattern, buildOptions(args, false));
  const total = entries.length;
  const limit = resolveLimit(args.limit);
  const offset = resolveOffset(args.offset);
  const page = entries.slice(offset, offset + limit);
  return {
    count: page.length,
    total,
    offset,
    limit,
    truncated: offset + page.length < total,
    entries: page.map((e) => toPlainEntry(e, !!args.content)),
  };
}

/** hyperglob_paths: relative paths only (newline separated in the response). */
function buildPathsPayload(args) {
  const paths = hyperglobSync(args.pattern, buildOptions(args, true));
  const total = paths.length;
  const limit = resolveLimit(args.limit);
  const offset = resolveOffset(args.offset);
  const page = paths.slice(offset, offset + limit);
  return {
    count: page.length,
    total,
    offset,
    limit,
    truncated: offset + page.length < total,
    paths: page,
  };
}

/** hyperglob_dependents: transitive importers. */
function buildDependentsPayload(args) {
  const opts = buildOptions(args, false);
  delete opts.pathsOnly;
  const deps = hyperglobDependents(args.target, opts);
  const total = deps.length;
  const limit = resolveLimit(args.limit);
  const offset = resolveOffset(args.offset);
  const page = deps.slice(offset, offset + limit);
  return {
    count: page.length,
    total,
    offset,
    limit,
    truncated: offset + page.length < total,
    dependents: page,
  };
}

/**
 * Execute one job. Returns a plain, structured-clone-safe payload.
 * Throws on failure — the caller turns that into an `isError` result.
 */
function runJob(job) {
  if (!job || typeof job !== 'object') throw new Error('invalid job');
  switch (job.op) {
    case 'query':
      return buildQueryPayload(job.args || {});
    case 'paths':
      return buildPathsPayload(job.args || {});
    case 'dependents':
      return buildDependentsPayload(job.args || {});
    default:
      throw new Error(`unknown job op: ${job.op}`);
  }
}

/** Render a payload as the tool's text payload. */
function formatToolText(op, payload) {
  if (op === 'paths') return payload.paths.join('\n');
  if (op === 'dependents') return payload.dependents.join('\n');
  return JSON.stringify(payload);
}

// ---------------------------------------------------------------------------
// worker runner
// ---------------------------------------------------------------------------

const WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
let core = null;
try {
  core = require(workerData.corePath);
} catch (e) {
  parentPort.postMessage({
    id: null,
    fatal: true,
    error: 'failed to load hyperglob core in worker: ' + ((e && e.message) || String(e)),
  });
}
if (core) {
  // The worker inherits this process' stdout, which is the JSON-RPC stream.
  // Anything the worker (or the native layer it loads) writes there would
  // corrupt the protocol, so redirect it to stderr.
  try {
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (chunk, encoding, cb) {
      try { return process.stderr.write(chunk, encoding, cb); } catch (_) { return false; }
    };
    void realWrite;
  } catch (_) {}
  // The same file-descriptor level guard: a child spawned with
  // stdio:'inherit' would write straight to the protocol stream.
  try {
    const cp = require('child_process');
    for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn']) {
      const orig = cp[name];
      if (typeof orig !== 'function') continue;
      cp[name] = function (/* ...args */) {
        const options = arguments[2];
        if (options && options.stdio === 'inherit') {
          arguments[2] = Object.assign({}, options, { stdio: ['ignore', 'pipe', 'inherit'] });
          const r = orig.apply(this, arguments);
          const stream = r && r.stdout;
          if (stream && typeof stream.on === 'function') {
            stream.on('data', function (d) { try { process.stderr.write(d); } catch (_) {} });
          } else if (stream && stream.length) {
            try { process.stderr.write(stream); } catch (_) {}
          }
          return r;
        }
        return orig.apply(this, arguments);
      };
    }
  } catch (_) {}
  parentPort.on('message', function (msg) {
    try {
      const payload = core.runJob(msg);
      parentPort.postMessage({ id: msg.id, ok: true, payload });
    } catch (e) {
      parentPort.postMessage({ id: msg.id, ok: false, error: core.describeError(e) });
    }
  });
}
`;

/**
 * Runs hyperglob jobs in worker threads so that a slow or crashing native
 * call cannot take the protocol loop down with it.
 *
 * A pool is used (not a single worker): the native scan is synchronous, so
 * one worker can only run one query at a time. Concurrent tool calls are
 * dispatched to separate workers so they run in parallel.
 */
class ToolRunner {
  constructor(opts = {}) {
    this.corePath = opts.corePath || path.join(__dirname, 'mcp.js');
    this.useWorker = opts.useWorker !== false;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxWorkers = Math.max(1, opts.maxWorkers || 4);
    /**
     * Keep idle workers alive between calls (faster round-trips). Disabled
     * by default because an idle worker's MessagePort keeps the process
     * alive; the server sets closeWhenIdle() when its input ends.
     */
    this.persistent = opts.persistent === true;
    this._closeWhenIdle = false;
    this._workers = []; // { worker, jobId }
    this._idle = []; // worker entries ready for a job
    this._queue = []; // { job, timeoutMs, resolve }
    this._pending = new Map(); // jobId -> { resolve, timer }
    this._nextId = 1;
    this._closed = false;
  }

  _spawnWorker() {
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { corePath: this.corePath },
      // Piped (not inherited): a worker that writes to stdout must never be
      // able to corrupt the protocol stream.
      stdout: true,
      stderr: true,
    });
    const entry = { worker: w, jobId: null };
    if (w.stdout) w.stdout.on('data', (d) => { try { process.stderr.write(d); } catch (_) {} });
    if (w.stderr) w.stderr.on('data', (d) => { try { process.stderr.write(d); } catch (_) {} });
    w.on('message', (m) => {
      if (!m) return;
      if (m.fatal) {
        this._failWorker(entry, new Error(m.error));
        return;
      }
      this._completeWorker(entry, m);
    });
    w.on('error', (e) => { this._failWorker(entry, e); });
    w.on('exit', (code) => {
      this._removeWorker(entry);
      if (entry.jobId !== null) {
        this._failWorker(entry, new Error(`hyperglob worker exited unexpectedly (code ${code})`));
      }
    });
    // An idle worker must not keep the process alive; a busy one must.
    if (typeof w.unref === 'function') w.unref();
    this._workers.push(entry);
    return entry;
  }

  _removeWorker(entry) {
    const i = this._workers.indexOf(entry);
    if (i >= 0) this._workers.splice(i, 1);
    const j = this._idle.indexOf(entry);
    if (j >= 0) this._idle.splice(j, 1);
  }

  _failWorker(entry, err) {
    if (entry.jobId === null) return;
    const jobId = entry.jobId;
    entry.jobId = null;
    this._removeWorker(entry);
    const pending = this._pending.get(jobId);
    if (pending) {
      this._pending.delete(jobId);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: describeError(err) });
    }
    try { entry.worker.terminate(); } catch (_) {}
    this._drain();
  }

  _completeWorker(entry, message) {
    if (entry.jobId === null) return;
    const jobId = entry.jobId;
    entry.jobId = null;
    const pending = this._pending.get(jobId);
    if (pending) {
      this._pending.delete(jobId);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
    if (this._closed) {
      this._removeWorker(entry);
      try { entry.worker.terminate(); } catch (_) {}
      return;
    }
    if (this._queue.length === 0 && !this.persistent) {
      // Idle and nothing queued: a worker's MessagePort keeps the process
      // alive even after worker.unref(), so terminate it outright. The next
      // call spawns a fresh one.
      this._removeWorker(entry);
      try { entry.worker.terminate(); } catch (_) {}
    } else {
      this._idle.push(entry);
    }
    this._maybeCloseWhenIdle();
    this._drain();
  }

  /**
   * Close as soon as no job is running. Used when the input stream ends:
   * the server must not keep the process alive after the client is gone.
   */
  closeWhenIdle() {
    this._closeWhenIdle = true;
    this._maybeCloseWhenIdle();
  }

  _maybeCloseWhenIdle() {
    if (!this._closeWhenIdle) return;
    if (this._pending.size > 0 || this._queue.length > 0) return;
    this.close();
  }

  /** Assign queued jobs to idle workers / free workers. */
  _drain() {
    while (this._queue.length > 0) {
      let entry = this._idle.pop();
      if (!entry) {
        if (this._workers.length >= this.maxWorkers) return; // all busy: wait
        entry = this._spawnWorker();
      }
      const item = this._queue.shift();
      const id = this._nextId++;
      entry.jobId = id;
      // A busy worker must keep the process alive until the job settles.
      if (typeof entry.worker.ref === 'function') entry.worker.ref();
      const timer = setTimeout(() => {
        this._pending.delete(id);
        item.resolve({ ok: false, error: `query timed out after ${item.timeoutMs}ms` });
        // The worker is stuck inside native code — replace it.
        this._removeWorker(entry);
        try { entry.worker.terminate(); } catch (_) {}
        this._drain();
      }, item.timeoutMs);
      this._pending.set(id, { resolve: item.resolve, timer });
      try {
        entry.worker.postMessage(Object.assign({ id }, item.job));
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        item.resolve({ ok: false, error: describeError(e) });
        entry.jobId = null;
        this._removeWorker(entry);
      }
    }
  }

  /** Run a job; resolves to { ok: true, payload } or { ok: false, error }. */
  run(job, timeoutMs) {
    const budget = Math.min(
      Math.max(Number(timeoutMs) > 0 ? Math.floor(Number(timeoutMs)) : this.timeoutMs, MIN_TIMEOUT_MS),
      MAX_TIMEOUT_MS
    );
    if (!this.useWorker) {
      try {
        return Promise.resolve({ ok: true, payload: runJob(job) });
      } catch (e) {
        return Promise.resolve({ ok: false, error: describeError(e) });
      }
    }
    if (this._closed) {
      return Promise.resolve({ ok: false, error: 'hyperglob runner is closed' });
    }
    return new Promise((resolve) => {
      this._queue.push({ job, timeoutMs: budget, resolve });
      this._drain();
    });
  }

  close() {
    this._closed = true;
    for (const entry of this._workers.slice()) {
      try { entry.worker.terminate(); } catch (_) {}
    }
    this._workers = [];
    this._idle = [];
    this._queue = [];
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'hyperglob runner closed' });
    }
    this._pending.clear();
  }
}

let defaultRunner = null;
let defaultRunnerExitHookInstalled = false;
function getRunner() {
  if (!defaultRunner) {
    const envTimeout = Number(process.env.HYPERGLOB_MCP_TIMEOUT_MS);
    defaultRunner = new ToolRunner({
      useWorker: process.env.HYPERGLOB_MCP_WORKER !== '0',
      timeoutMs: Number.isFinite(envTimeout) && envTimeout >= MIN_TIMEOUT_MS ? envTimeout : DEFAULT_TIMEOUT_MS,
    });
    if (!defaultRunnerExitHookInstalled) {
      defaultRunnerExitHookInstalled = true;
      // Worker threads keep the event loop alive; without this a script that
      // merely required mcp.js would hang instead of exiting.
      process.on('exit', () => {
        try { defaultRunner.close(); } catch (_) {}
      });
    }
  }
  return defaultRunner;
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

function makeResult(id, value) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result: value };
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function toolError(id, message) {
  return makeResult(id, {
    content: [{ type: 'text', text: `hyperglob error: ${message}` }],
    isError: true,
  });
}

function pickProtocolVersion(requested) {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return PROTOCOL_VERSION;
}

/**
 * Handle one JSON-RPC message.
 * Returns the response object, or null for notifications (which must never
 * be answered).
 */
async function handle(msg, deps = {}) {
  const runner = deps.runner || getRunner();

  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return makeError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = msg;
  if (msg.jsonrpc !== '2.0' || typeof method !== 'string') {
    return makeError(id, -32600, 'Invalid Request');
  }

  switch (method) {
    case 'initialize':
      return makeResult(id, {
        protocolVersion: pickProtocolVersion(params && params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: 'hyperglob', version: version() },
      });
    case 'ping':
      return makeResult(id, {});
    case 'tools/list':
      return makeResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return makeError(id, -32602, `unknown tool: ${name}`);
      }
      if (name === 'hyperglob_dependents') {
        if (!isPlainString(args.target)) {
          return makeError(id, -32602, 'target (string) is required');
        }
      } else if (!isPlainString(args.pattern)) {
        return makeError(id, -32602, 'pattern (string) is required');
      }
      try {
        validateArgs(args);
      } catch (e) {
        return makeError(id, -32602, describeError(e));
      }
      const op = name === 'hyperglob_dependents' ? 'dependents' : name === 'hyperglob_paths' ? 'paths' : 'query';
      const timeoutMs = resolveTimeoutMs(args.timeoutMs, runner.timeoutMs);
      const res = await runner.run({ op, args }, timeoutMs);
      if (!res || res.ok !== true) {
        return toolError(id, (res && res.error) || 'unknown error');
      }
      return makeResult(id, { content: [{ type: 'text', text: formatToolText(op, res.payload) }] });
    }
    // Notifications: never answered.
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
    case 'notifications/roots/list_changed':
      return null;
    default:
      if (id !== undefined && !method.startsWith('notifications/')) {
        return makeError(id, -32601, `method not found: ${method}`);
      }
      return null;
  }
}

/** Read newline-delimited JSON-RPC from `input`, emit responses via `emit`. */
function serve(opts = {}) {
  const input = opts.input || process.stdin;
  const emit = opts.emit || ((obj) => emitProtocol(JSON.stringify(obj) + '\n'));
  const runner = opts.runner || getRunner();
  const rl = readline.createInterface({ input, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      emit(makeError(null, -32700, 'Parse error'));
      return;
    }
    Promise.resolve()
      .then(() => handle(msg, { runner }))
      .then((res) => {
        if (res) emit(res);
      })
      .catch((e) => {
        if (msg && msg.id !== undefined) {
          emit(makeError(msg.id, -32603, `internal error: ${describeError(e)}`));
        }
      });
  });
  // When the client closes its end of the pipe, finish the in-flight calls
  // and then let the process exit (the workers must not hold it open).
  rl.on('close', () => {
    if (runner && typeof runner.closeWhenIdle === 'function') runner.closeWhenIdle();
  });
  return rl;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function main() {
  const argTimeout = (() => {
    const i = process.argv.indexOf('--timeout-ms');
    if (i >= 0) {
      const v = Number(process.argv[i + 1]);
      if (Number.isFinite(v) && v >= MIN_TIMEOUT_MS) return v;
    }
    const env = Number(process.env.HYPERGLOB_MCP_TIMEOUT_MS);
    if (Number.isFinite(env) && env >= MIN_TIMEOUT_MS) return env;
    return DEFAULT_TIMEOUT_MS;
  })();

  const runner = new ToolRunner({
    useWorker: process.env.HYPERGLOB_MCP_WORKER !== '0',
    timeoutMs: argTimeout,
  });
  defaultRunner = runner;

  // Never leave worker threads dangling: they keep the event loop alive and
  // would prevent the process from exiting.
  const shutdown = () => {
    try { runner.close(); } catch (_) {}
  };
  process.on('exit', shutdown);
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });
  // NOTE: do NOT exit when stdin ends. A client that pipes a batch of
  // requests and closes stdin still expects the answers to be written; the
  // process exits naturally once the workers go idle (they are unref'd).

  serve({ runner });
}

if (IS_MAIN) {
  main();
}

module.exports = {
  handle,
  serve,
  main,
  TOOLS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  ToolRunner,
  runJob,
  describeError,
  buildOptions,
  validateArgs,
  formatToolText,
  buildQueryPayload,
  buildPathsPayload,
  buildDependentsPayload,
  toPlainEntry,
  isoOrNull,
  emitProtocol,
  setProtocolSink,
  installStdoutGuard,
  installChildProcessGuard,
  pickProtocolVersion,
  makeResult,
  makeError,
  toolError,
  resolveTimeoutMs,
  resolveLimit,
  resolveOffset,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
};
