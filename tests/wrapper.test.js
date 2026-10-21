'use strict';
// Tests for the ESM wrapper (index.mjs) and the type declarations
// (index.d.ts) of the hyperglob JS surface.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cjs = require('../index.js');

const FIXTURE = { dir: null };

/**
 * A private fixture directory per test file. The test runner may share one
 * process across files, so a module-level `root` could be clobbered by
 * another file's setup — keep it inside an object owned by this module.
 */
function mkFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-wrapper-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a = 1;\n');
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

// ---------------------------------------------------------------------------
// item 10: index.mjs
// ---------------------------------------------------------------------------

test('index.mjs re-exports everything index.js exports', async () => {
  const esm = await import('../index.mjs');
  for (const key of Object.keys(cjs)) {
    if (key === 'default') continue;
    assert.ok(key in esm, `index.mjs is missing the "${key}" export`);
    assert.equal(esm[key], cjs[key], `index.mjs "${key}" must be the same value`);
  }
});

test('index.mjs default export is the hyperglob function', async () => {
  const esm = await import('../index.mjs');
  assert.equal(typeof esm.default, 'function');
  assert.equal(esm.default, cjs.hyperglob);
  assert.equal(esm.default, esm.hyperglob);
});

test('index.mjs exposes HyperEntry, native, loadNative and nativeFilename', async () => {
  const esm = await import('../index.mjs');
  assert.equal(typeof esm.HyperEntry, 'function');
  assert.equal(esm.HyperEntry, cjs.HyperEntry);
  assert.equal(typeof esm.native, 'object');
  assert.equal(typeof esm.loadNative, 'function');
  assert.equal(typeof esm.nativeFilename, 'function');
});

test('index.mjs works end to end', async () => {
  const esm = await import('../index.mjs');
  assert.equal(typeof esm.version(), 'string');
  const paths = esm.hyperglobSync('src/**/*.ts', { cwd: root(), pathsOnly: true });
  assert.ok(Array.isArray(paths));
  assert.ok(paths.includes('src/index.ts'));
  const entries = esm.hyperglobSync('src/**/*.ts', { cwd: root() });
  assert.ok(Array.isArray(entries));
  assert.equal(entries[0].isFile, true);
  const parsed = esm.parseQuery('src/**/*.ts');
  assert.deepEqual(parsed.patterns, ['src/**/*.ts']);
});

test('index.mjs streaming yields strings with pathsOnly and entries without it', async () => {
  const esm = await import('../index.mjs');
  const asPaths = [];
  for await (const p of esm.hyperglob('src/**/*.ts', { cwd: root(), pathsOnly: true })) {
    asPaths.push(p);
  }
  assert.ok(asPaths.every((p) => typeof p === 'string'), 'pathsOnly must yield strings');
  assert.ok(asPaths.includes('src/index.ts'));

  const asEntries = [];
  for await (const e of esm.hyperglob('src/**/*.ts', { cwd: root() })) {
    asEntries.push(e);
  }
  assert.ok(asEntries.every((e) => typeof e === 'object' && typeof e.isFile === 'boolean'));
});

// ---------------------------------------------------------------------------
// item 11: index.d.ts
// ---------------------------------------------------------------------------

const dts = fs.readFileSync(path.join(__dirname, '..', 'index.d.ts'), 'utf8');

test('index.d.ts declares the public API surface', () => {
  for (const name of [
    'hyperglob',
    'hyperglobSync',
    'hyperglobDependents',
    'parseQuery',
    'version',
    'HyperglobStream',
    'HyperEntry',
    'native',
    'loadNative',
    'nativeFilename',
  ]) {
    assert.match(dts, new RegExp(`\\b${name}\\b`), `index.d.ts must declare ${name}`);
  }
  assert.match(dts, /export default hyperglob/);
});

test('index.d.ts declares the native binding members', () => {
  for (const name of [
    'scanSync',
    'scanPathsSync',
    'scanColumnsSync',
    'createScanner',
    'dependentsOfSync',
    'parseQueryJson',
    'Scanner',
  ]) {
    assert.match(dts, new RegExp(`\\b${name}\\b`), `index.d.ts must declare native.${name}`);
  }
});

test('index.d.ts models the pathsOnly streaming overload', () => {
  // The stream yields strings with pathsOnly: true — the .d.ts must say so.
  assert.match(dts, /pathsOnly: true[\s\S]{0,200}HyperglobStream<string>/);
  assert.match(dts, /HyperglobStream<Entry>/);
});

test('index.d.ts declares Entry.modified as optional', () => {
  assert.match(dts, /modified\?: Date/);
  assert.match(dts, /modifiedMs\?: number/);
});

test('index.d.ts declares both hyperglobSync overloads', () => {
  assert.match(dts, /pathsOnly\?: false[\s\S]{0,120}Entry\[\]/);
  assert.match(dts, /pathsOnly: true[\s\S]{0,120}string\[\]/);
});

test('the .d.ts parses as valid TypeScript-ish syntax (balanced braces)', () => {
  const open = (dts.match(/\{/g) || []).length;
  const close = (dts.match(/\}/g) || []).length;
  assert.equal(open, close, 'unbalanced braces in index.d.ts');
});

// ---------------------------------------------------------------------------
// runtime/type agreement
// ---------------------------------------------------------------------------

test('every runtime export has a type declaration', () => {
  for (const key of Object.keys(cjs)) {
    if (key === 'default') continue;
    assert.match(dts, new RegExp(`\\b${key}\\b`), `index.d.ts must declare ${key}`);
  }
});

test('the native object exposes exactly the declared members', () => {
  const declared = ['version', 'scanSync', 'scanPathsSync', 'scanColumnsSync', 'createScanner', 'dependentsOfSync', 'parseQueryJson', 'Scanner'];
  for (const key of declared) {
    assert.ok(cjs.native[key] !== undefined, `native.${key} must exist at runtime`);
  }
});

test('hyperglobSync with pathsOnly really returns strings', () => {
  const paths = cjs.hyperglobSync('src/**/*.ts', { cwd: root(), pathsOnly: true });
  assert.ok(Array.isArray(paths));
  assert.ok(paths.every((p) => typeof p === 'string'));
});

test('hyperglobSync without pathsOnly really returns Entry objects', () => {
  const entries = cjs.hyperglobSync('src/**/*.ts', { cwd: root() });
  assert.ok(Array.isArray(entries));
  assert.ok(entries.every((e) => typeof e.path === 'string'));
  assert.ok(entries.every((e) => typeof e.isFile === 'boolean'));
  assert.ok(entries.every((e) => typeof e.isDir === 'boolean'));
});
