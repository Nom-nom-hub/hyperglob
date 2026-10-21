'use strict';
// Tests for the hyperglob CLI (cli.js).
//
// The CLI is driven in-process: cli.js exports `main(argv, io)` with an
// injectable stdout/stderr, so no child process is needed (the test sandbox
// denies spawn()).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../cli.js');

const FIXTURE = { dir: null };

/**
 * A private fixture directory per test file. The test runner may share one
 * process across files, so a module-level `root` could be clobbered by
 * another file's setup — keep it inside an object owned by this module.
 */
function mkFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-cli-test-'));
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'deep', 'nested.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(dir, 'src', 'other.ts'), 'export const c = 3;\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}\n');
  FIXTURE.dir = dir;
  return dir;
}

/** The fixture root of *this* file. */
function root() {
  return FIXTURE.dir;
}

test.before(() => {
  mkFixture();
});

test.after(() => {
  fs.rmSync(FIXTURE.dir, { recursive: true, force: true });
});

/** Run the CLI with captured output. Returns { code, out, err }. */
function run(...args) {
  const out = [];
  const err = [];
  const code = cli.main(
    ['node', 'cli.js', ...args],
    {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    }
  );
  return { code, out, err, outText: out.join('\n'), errText: err.join('\n') };
}

// ---------------------------------------------------------------------------
// item 6: numeric flag validation
// ---------------------------------------------------------------------------

test('--max-depth rejects non-numeric values with a usage error', () => {
  const r = run('src/**/*.ts', '--cwd', root(), '--max-depth', 'abc');
  assert.equal(r.code, 2, 'must be a usage error');
  assert.match(r.errText, /--max-depth/);
  assert.match(r.errText, /non-negative integer/);
  assert.equal(r.out.length, 0, 'nothing on stdout');
});

test('--max-depth rejects negative values', () => {
  const r = run('src/**/*.ts', '--cwd', root(), '--max-depth', '-1');
  assert.equal(r.code, 2);
  assert.match(r.errText, /--max-depth/);
});

test('--max-depth rejects a missing value', () => {
  const r = run('src/**/*.ts', '--cwd', root(), '--max-depth');
  assert.equal(r.code, 2);
  assert.match(r.errText, /--max-depth requires a value/);
});

test('--threads rejects non-numeric values with a usage error', () => {
  const r = run('src/**/*.ts', '--cwd', root(), '--threads', 'abc');
  assert.equal(r.code, 2);
  assert.match(r.errText, /--threads/);
});

test('--max-depth accepts a valid integer and actually limits the traversal', () => {
  const deep = run('src/**/*.ts', '--cwd', root());
  assert.equal(deep.code, 0);
  assert.ok(deep.outText.includes('src/deep/nested.ts'), 'unlimited depth finds nested files');

  const shallow = run('src/**/*.ts', '--cwd', root(), '--max-depth', '1');
  assert.equal(shallow.code, 0);
  assert.ok(shallow.outText.includes('src/index.ts'));
  assert.ok(!shallow.outText.includes('src/deep/nested.ts'), 'depth 1 must not reach src/deep');
});

test('--max-depth 0 is accepted (root() only) and does not silently widen', () => {
  const r = run('src/**/*.ts', '--cwd', root(), '--max-depth', '0');
  assert.equal(r.code, 0);
  assert.ok(!r.outText.includes('src/index.ts'));
});

test('--threads accepts a valid integer', () => {
  const r = run('src/**/*.ts', '--cwd', root(), '--threads', '2');
  assert.equal(r.code, 0);
  assert.ok(r.outText.includes('src/index.ts'));
});

test('parseNonNegativeInt rejects malformed input', () => {
  assert.throws(() => cli.parseNonNegativeInt('abc', '--x'), cli.UsageError);
  assert.throws(() => cli.parseNonNegativeInt('-1', '--x'), cli.UsageError);
  assert.throws(() => cli.parseNonNegativeInt('1.5', '--x'), cli.UsageError);
  assert.throws(() => cli.parseNonNegativeInt('', '--x'), cli.UsageError);
  assert.throws(() => cli.parseNonNegativeInt(undefined, '--x'), cli.UsageError);
  assert.equal(cli.parseNonNegativeInt('0', '--x'), 0);
  assert.equal(cli.parseNonNegativeInt('7', '--x'), 7);
});

// ---------------------------------------------------------------------------
// item 7: new flags
// ---------------------------------------------------------------------------

test('--paths-only prints one relative path per line', () => {
  const r = run('src/**/*.ts', '--cwd', root(), '--paths-only');
  assert.equal(r.code, 0);
  const lines = r.out.filter((l) => l.length > 0);
  assert.ok(lines.includes('src/index.ts'));
  assert.ok(lines.includes('src/deep/nested.ts'));
  assert.ok(lines.every((l) => !path.isAbsolute(l)), 'paths must be relative');
  assert.ok(lines.every((l) => !l.includes('\n')));
});

test('--absolute prints absolute paths', () => {
  const r = run('src/**/*.ts', '--cwd', root(), '--absolute');
  assert.equal(r.code, 0);
  const lines = r.out.filter((l) => l.length > 0);
  assert.ok(lines.every((l) => path.isAbsolute(l)), 'paths must be absolute');
  assert.ok(lines.some((l) => l.endsWith(path.join('src', 'index.ts'))));
});

test('--ignore excludes matching paths and is repeatable', () => {
  const r = run('src/**/*.ts', '--cwd', root(), '--ignore', '**/deep/**', '--ignore', '**/other.ts');
  assert.equal(r.code, 0);
  assert.ok(r.outText.includes('src/index.ts'));
  assert.ok(!r.outText.includes('src/deep/nested.ts'));
  assert.ok(!r.outText.includes('src/other.ts'));
});

test('--include-dirs includes directories in the results', () => {
  const without = run('src/**', '--cwd', root());
  assert.ok(!without.outText.split('\n').some((l) => l === 'src/deep'));

  const withDirs = run('src/**', '--cwd', root(), '--include-dirs');
  assert.equal(withDirs.code, 0);
  const lines = withDirs.out.filter((l) => l.length > 0);
  // `src/**` matches the children of src, so src/deep is the directory entry.
  assert.ok(lines.includes('src/deep'), `expected src/deep in ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('src/index.ts'));
});

test('--only-files excludes directories', () => {
  const r = run('src/**', '--cwd', root(), '--include-dirs', '--only-files');
  assert.equal(r.code, 0);
  const lines = r.out.filter((l) => l.length > 0);
  assert.ok(!lines.includes('src/deep'));
  assert.ok(lines.includes('src/index.ts'));
});

test('--follow-symlinks is accepted', () => {
  const r = run('src/**/*.ts', '--cwd', root(), '--follow-symlinks');
  assert.equal(r.code, 0);
  assert.ok(r.outText.includes('src/index.ts'));
});

test('--dot includes dotfiles', () => {
  fs.writeFileSync(path.join(root(), 'src', '.hidden.ts'), 'export const h = 1;\n');
  try {
    const without = run('src/**', '--cwd', root());
    assert.ok(!without.outText.includes('.hidden.ts'));
    const withDot = run('src/**', '--cwd', root(), '--dot');
    assert.ok(withDot.outText.includes('.hidden.ts'));
  } finally {
    fs.rmSync(path.join(root(), 'src', '.hidden.ts'), { force: true });
  }
});

test('--no-gitignore disables gitignore handling', () => {
  fs.writeFileSync(path.join(root(), '.gitignore'), 'src/other.ts\n');
  try {
    const obeyed = run('src/**/*.ts', '--cwd', root());
    assert.ok(!obeyed.outText.includes('src/other.ts'));
    const ignored = run('src/**/*.ts', '--cwd', root(), '--no-gitignore');
    assert.ok(ignored.outText.includes('src/other.ts'));
  } finally {
    fs.rmSync(path.join(root(), '.gitignore'), { force: true });
  }
});

// ---------------------------------------------------------------------------
// item 8: --dependents error handling
// ---------------------------------------------------------------------------

test('--dependents with a missing target prints a clean error and exits 1', () => {
  const r = run('--dependents', 'nope.ts', '--cwd', root());
  assert.equal(r.code, 1, 'must exit 1 on a runtime error');
  assert.equal(r.out.length, 0, 'nothing on stdout');
  assert.match(r.errText, /target not found/i);
  assert.ok(!/at .*\.js:\d+/.test(r.errText), 'must not leak a stack trace');
});

test('--dependents with a missing --dependents value is a usage error', () => {
  const r = run('--dependents');
  assert.equal(r.code, 2);
  assert.match(r.errText, /--dependents requires a value/);
});

test('--dependents reports dependents as relative paths', () => {
  const depRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-cli-deps-'));
  try {
    fs.mkdirSync(path.join(depRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(depRoot, 'src', 'target.ts'), 'export const t = 1;\n');
    fs.writeFileSync(path.join(depRoot, 'src', 'mid.ts'), "import './target';\nexport const m = 1;\n");
    fs.writeFileSync(path.join(depRoot, 'src', 'leaf.ts'), "import './mid';\nexport const l = 1;\n");
    const r = run('--dependents', 'src/target.ts', '--cwd', depRoot);
    assert.equal(r.code, 0);
    assert.ok(r.outText.includes('src/mid.ts'), r.outText);
    assert.ok(r.outText.includes('src/leaf.ts'), r.outText);
  } finally {
    fs.rmSync(depRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// item 9: exit codes
// ---------------------------------------------------------------------------

test('a successful query exits 0', () => {
  const r = run('src/**/*.ts', '--cwd', root());
  assert.equal(r.code, 0);
  assert.equal(r.err.length, 0);
});

test('an unknown flag exits 2', () => {
  const r = run('--definitely-not-a-flag');
  assert.equal(r.code, 2);
  assert.match(r.errText, /unknown flag/);
});

test('a missing pattern exits 2', () => {
  const r = run();
  assert.equal(r.code, 2);
  assert.match(r.errText, /no pattern/);
});

test('an invalid pattern exits 1 with a clean message (not a stack trace)', () => {
  const r = run('src/[[[', '--cwd', root());
  assert.equal(r.code, 1, 'runtime error => exit 1');
  assert.match(r.errText, /glob/i);
  assert.ok(!/at .*\.js:\d+/.test(r.errText), 'must not leak a stack trace');
});

test('a missing --cwd value is a usage error', () => {
  const r = run('src/**/*.ts', '--cwd');
  assert.equal(r.code, 2);
  assert.match(r.errText, /--cwd requires a value/);
});

test('--help exits 0 and prints usage', () => {
  const r = run('--help');
  assert.equal(r.code, 0);
  assert.match(r.outText, /usage: hyperglob/);
});

test('--version exits 0 and prints a version', () => {
  const r = run('--version');
  assert.equal(r.code, 0);
  assert.match(r.outText, /\d+\.\d+\.\d+/);
});

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

test('--json emits a JSON array with the entry fields', () => {
  const r = run('src/**/*.ts', '--cwd', root(), '--json');
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.outText);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 3);
  const e = parsed.find((x) => x.relativePath === 'src/index.ts');
  assert.ok(e);
  assert.equal(e.isFile, true);
  assert.equal(e.isDir, false);
  assert.equal(typeof e.path, 'string');
  assert.equal(typeof e.size, 'number');
  assert.equal(typeof e.modified, 'string');
  assert.ok(!('isDirectory' in e), 'must not use the wrong isDirectory key');
});

test('--json --paths-only emits a JSON array of strings', () => {
  const r = run('src/**/*.ts', '--cwd', root(), '--json', '--paths-only');
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.outText);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.every((p) => typeof p === 'string'));
  assert.ok(parsed.includes('src/index.ts'));
});

test('--json --content includes file contents', () => {
  const r = run('src/index.ts', '--cwd', root(), '--json', '--content');
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.outText);
  assert.ok(parsed.length >= 1);
  assert.ok(parsed[0].content.includes('export const a'));
});

// ---------------------------------------------------------------------------
// module hygiene
// ---------------------------------------------------------------------------

test('requiring cli.js does not execute a scan', () => {
  // `main` must not have run on import: importing must be side-effect free
  // apart from loading the native addon.
  const src = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');
  assert.match(src, /require\.main === module/);
  assert.ok(
    !/^\s*main\(process\.argv\)/m.test(src),
    'cli.js must not call main() unconditionally'
  );
});

test('the CLI module exposes its main entry point', () => {
  assert.equal(typeof cli.main, 'function');
  assert.equal(typeof cli.parseArgs, 'function');
  assert.equal(cli.EXIT_OK, 0);
  assert.equal(cli.EXIT_ERROR, 1);
  assert.equal(cli.EXIT_USAGE, 2);
});
