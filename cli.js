#!/usr/bin/env node
'use strict';
// hyperglob CLI — built for agents and shell pipelines.
//
//   hyperglob 'src/**/*.ts :contains("export const")' [--cwd dir] [--json] [--content]
//   hyperglob 'src/**/*.ts' --paths-only
//   hyperglob --dependents src/hooks.ts
//
// Exit codes (agent-friendly contract):
//   0  success
//   1  runtime error (bad pattern, missing target, native failure)
//   2  usage error (unknown flag, missing argument, invalid number)
//
// The module exports `main(argv, io)` so it can be driven in-process with an
// injected stdout/stderr — no child process needed.

const { hyperglobSync, hyperglobDependents } = require('./index.js');

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const USAGE = [
  'usage: hyperglob <pattern...> [options]',
  '       hyperglob --dependents <path> [options]',
  '',
  'options:',
  '  --cwd <dir>            root directory to search from (default: process cwd)',
  '  --json                 emit JSON instead of plain paths',
  '  --content              include file contents in the output',
  '  --paths-only           print relative paths only, one per line (shell-pipeline friendly)',
  '  --absolute             print absolute paths instead of relative ones',
  '  --ignore <glob>        exclude paths matching the glob (repeatable)',
  '  --include-dirs         include directories in the results (default: files only)',
  '  --only-files           only files in the results (default; opposite of --include-dirs)',
  '  --dot                  include dotfiles / dot-directories',
  '  --no-gitignore         do not obey .gitignore / .git/info/exclude',
  '  --no-ignore-files      do not obey .ignore / .agentignore',
  '  --follow-symlinks      follow symlinked directories',
  '  --max-depth <n>        maximum traversal depth (non-negative integer)',
  '  --threads <n>          walker threads, 0 = auto (non-negative integer)',
  '  --index                use the warm index snapshot at <cwd>/.hyperglob/',
  '  --no-stats             omit size / modified metadata',
  '  --dependents <path>    list every file that imports <path> (directly or transitively)',
  '  -h, --help             show this help',
  '  -v, --version          print the hyperglob version',
].join('\n');

/** Error carrying a specific process exit code. */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = EXIT_USAGE;
  }
}

/** Parse a non-negative integer CLI value. `parseInt('abc')` is NaN and
 *  NaN | 0 === 0, which silently turns "no depth limit" into "root only". */
function parseNonNegativeInt(raw, flag) {
  if (raw === undefined || raw === null) {
    throw new UsageError(`${flag} requires a value`);
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    throw new UsageError(`${flag} expects a non-negative integer, got "${raw}"`);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n)) {
    throw new UsageError(`${flag} value out of range: "${raw}"`);
  }
  return n;
}

/** Default stdout/stderr writers (real process streams). */
function defaultIo() {
  return {
    out: (text) => process.stdout.write(text + '\n'),
    err: (text) => process.stderr.write(text + '\n'),
  };
}

/**
 * Parse argv into { patterns, options, flags }.
 * Throws UsageError for anything malformed.
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const patterns = [];
  const options = {};
  const flags = {
    json: false,
    pathsOnly: false,
    absolute: false,
    content: false,
    includeDirs: false,
    onlyFiles: undefined,
    dot: false,
    followSymlinks: false,
    index: false,
    stats: undefined,
    help: false,
    version: false,
  };
  const ignore = [];
  let dependentsOf = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const needValue = (flag) => {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`${flag} requires a value`);
      return v;
    };
    switch (a) {
      case '--json': flags.json = true; break;
      case '--content': flags.content = true; break;
      case '--paths-only': flags.pathsOnly = true; break;
      case '--absolute': flags.absolute = true; break;
      case '--include-dirs': flags.includeDirs = true; break;
      case '--only-files': flags.onlyFiles = true; break;
      case '--dot': flags.dot = true; break;
      case '--follow-symlinks': flags.followSymlinks = true; break;
      case '--index': flags.index = true; break;
      case '--no-gitignore': options.gitignore = false; break;
      case '--no-ignore-files': options.ignoreFiles = false; break;
      case '--no-stats': flags.stats = false; break;
      case '--help':
      case '-h': flags.help = true; break;
      case '--version':
      case '-v': flags.version = true; break;
      case '--cwd': options.cwd = needValue('--cwd'); break;
      case '--ignore': ignore.push(needValue('--ignore')); break;
      case '--dependents': dependentsOf = needValue('--dependents'); break;
      case '--max-depth': options.maxDepth = parseNonNegativeInt(needValue('--max-depth'), '--max-depth'); break;
      case '--threads': options.threads = parseNonNegativeInt(needValue('--threads'), '--threads'); break;
      default:
        if (a.startsWith('--') && a.length > 2) {
          throw new UsageError(`unknown flag ${a}`);
        }
        if (a === '-') {
          patterns.push(a);
          break;
        }
        if (a.startsWith('-') && a.length > 1) {
          throw new UsageError(`unknown flag ${a}`);
        }
        patterns.push(a);
    }
  }

  if (ignore.length > 0) options.ignore = ignore;
  if (flags.dot) options.dot = true;
  if (flags.followSymlinks) options.followSymlinks = true;
  if (flags.index) options.index = true;
  if (flags.content) options.content = true;
  if (flags.stats !== undefined) options.stats = flags.stats;

  // Directory inclusion: --include-dirs wins over the default (files only),
  // but an explicit --only-files wins over --include-dirs.
  if (flags.onlyFiles === true) {
    options.onlyFiles = true;
  } else if (flags.includeDirs) {
    options.onlyFiles = false;
  }

  // --paths-only is a *presentation* mode in the CLI: it prints relative
  // paths one per line, which is what the default (non-JSON) output already
  // does. It is kept as a distinct flag so scripts can be explicit and so
  // the JSON output can switch to a bare string array.
  return { patterns, options, flags, dependentsOf };
}

/** Render entries for plain (non-JSON) output. */
function renderPlain(entries, flags) {
  const lines = [];
  for (const e of entries) {
    if (typeof e === 'string') lines.push(e);
    else lines.push(flags.absolute ? e.path : e.relativePath);
  }
  return lines;
}

/** Render entries for JSON output. */
function renderJson(entries, flags) {
  if (flags.pathsOnly) {
    return JSON.stringify(renderPlain(entries, flags), null, 2);
  }
  return JSON.stringify(
    entries.map((e) => {
      if (typeof e === 'string') return e;
      return {
        path: e.path,
        relativePath: e.relativePath,
        name: e.name,
        extension: e.extension,
        size: e.size === undefined ? null : e.size,
        isFile: !!e.isFile,
        isDir: !!e.isDir,
        modified: e.modified instanceof Date && !isNaN(e.modified.getTime())
          ? e.modified.toISOString()
          : null,
        modifiedMs: e.modifiedMs === undefined ? null : e.modifiedMs,
        ...(flags.content && e.content !== undefined ? { content: e.content } : {}),
      };
    }),
    null,
    2
  );
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv  full process argv (argv[0] = node, argv[1] = script)
 * @param {{out:Function, err:Function}} [io]  injectable output writers
 * @returns {number} the process exit code
 */
function main(argv, io) {
  const writers = io || defaultIo();
  const out = writers.out || defaultIo().out;
  const err = writers.err || defaultIo().err;

  let parsed;
  try {
    parsed = parseArgs(argv || []);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`hyperglob: ${e.message}`);
      err(USAGE);
      return e.exitCode;
    }
    err(`hyperglob: ${e && e.message ? e.message : String(e)}`);
    return EXIT_ERROR;
  }

  const { patterns, options, flags, dependentsOf } = parsed;

  if (flags.help) {
    out(USAGE);
    return EXIT_OK;
  }
  if (flags.version) {
    try {
      out(require('./index.js').version());
    } catch (e) {
      out('unknown');
    }
    return EXIT_OK;
  }

  if (dependentsOf !== null) {
    try {
      const deps = hyperglobDependents(dependentsOf, options);
      if (flags.json) {
        out(JSON.stringify(deps, null, 2));
      } else {
        for (const p of deps) out(p);
      }
      return EXIT_OK;
    } catch (e) {
      err(`hyperglob: ${e && e.message ? e.message : String(e)}`);
      return EXIT_ERROR;
    }
  }

  if (patterns.length === 0) {
    err('hyperglob: no pattern given');
    err(USAGE);
    return EXIT_USAGE;
  }

  let entries;
  try {
    entries = hyperglobSync(patterns, options);
  } catch (e) {
    err(`hyperglob: ${e && e.message ? e.message : String(e)}`);
    return EXIT_ERROR;
  }

  try {
    if (flags.json) {
      out(renderJson(entries, flags));
    } else {
      for (const line of renderPlain(entries, flags)) out(line);
    }
  } catch (e) {
    err(`hyperglob: ${e && e.message ? e.message : String(e)}`);
    return EXIT_ERROR;
  }
  return EXIT_OK;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = {
  main,
  parseArgs,
  parseNonNegativeInt,
  renderPlain,
  renderJson,
  USAGE,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_USAGE,
  UsageError,
};
