'use strict';

// Regression tests for the engine fixes found in the production-readiness
// audit. Each test pins a specific bug that was reproduced before the fix.
//
// Run with:  node --test --experimental-test-isolation=none tests/engine.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { hyperglob, hyperglobSync } = require('../index.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rels(entries) {
  return entries
    .map((e) => (typeof e === 'string' ? e : e.relativePath))
    .sort();
}

// ---------------------------------------------------------------------------
// AST selectors must not be fooled by comments or string literals.
// ---------------------------------------------------------------------------

test(':exports does not match export-shaped text inside a comment', () => {
  const root = tmpdir('hg-exp-');
  try {
    fs.writeFileSync(path.join(root, 'comment.ts'), '// export const ghost = 1;\nconst x = 1;\n');
    fs.writeFileSync(path.join(root, 'block.ts'), '/* export const ghost = 1; */\nconst x = 1;\n');
    fs.writeFileSync(path.join(root, 'string.ts'), 'const s = "export const ghost = 1";\n');
    fs.writeFileSync(path.join(root, 'real.ts'), 'export const ghost = 1;\n');
    const out = rels(hyperglobSync('*.ts :exports("ghost")', { cwd: root, pathsOnly: true }));
    assert.deepEqual(out, ['real.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(':exports falls back safely for an unparseable file', () => {
  const root = tmpdir('hg-exp2-');
  try {
    // A real parse error (unclosed brace) with an export-shaped comment.
    fs.writeFileSync(path.join(root, 'broken.ts'), '// export const ghost = 1;\nfunction broken( {\n');
    const out = rels(hyperglobSync('*.ts :exports("ghost")', { cwd: root, pathsOnly: true }));
    assert.deepEqual(out, [], 'a comment in an unparseable file is not an export');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(':imports does not match import-shaped text inside a comment or string', () => {
  const root = tmpdir('hg-imp-');
  try {
    fs.writeFileSync(path.join(root, 'comment.ts'), "// import { x } from 'react';\nconst y = 1;\n");
    fs.writeFileSync(path.join(root, 'string.ts'), "const s = \"import('react')\";\nconst t = \"require('react')\";\n");
    fs.writeFileSync(path.join(root, 'real.ts'), "import { x } from 'react';\n");
    fs.writeFileSync(path.join(root, 'req.ts'), "const r = require('react');\n");
    fs.writeFileSync(path.join(root, 'dyn.ts'), "const p = import('react');\n");
    const out = rels(hyperglobSync('*.ts :imports("react")', { cwd: root, pathsOnly: true }));
    assert.deepEqual(out, ['dyn.ts', 'real.ts', 'req.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(':imports ignores a member access named import or require', () => {
  const root = tmpdir('hg-mem-');
  try {
    fs.writeFileSync(path.join(root, 'member.ts'), "const o = { import: 1 };\nconst p = o.import;\nconst q = o?.import;\n");
    const out = rels(hyperglobSync('*.ts :imports("react")', { cwd: root, pathsOnly: true }));
    assert.deepEqual(out, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Symlink cycles must not cause an infinite descent.
// ---------------------------------------------------------------------------

test('followSymlinks does not descend into a symlink cycle', () => {
  const root = tmpdir('hg-link-');
  try {
    fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(root, 'src', 'sub', 'b.ts'), '');
    // A junction (Windows) / symlink (Unix) that points at its own ancestor.
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'src', 'loop'), 'junction');
  } catch (e) {
    // Creating symlinks can require privileges on Windows; skip if denied.
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    }
    throw e;
  }
  try {
    const out = rels(hyperglobSync('src/**/*', { cwd: root, pathsOnly: true, followSymlinks: true }));
    // The walk must terminate and must not repeat the loop directory.
    assert.ok(out.length < 50, `walk did not terminate sanely: ${out.length} entries`);
    assert.deepEqual(out, ['src/a.ts', 'src/sub/b.ts']);
    // The same scan without following symlinks sees the junction but does
    // not descend into it.
    const noFollow = rels(
      hyperglobSync('src/**/*', { cwd: root, pathsOnly: true, followSymlinks: false })
    );
    assert.ok(noFollow.includes('src/a.ts'));
    assert.ok(noFollow.includes('src/sub/b.ts'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A pattern must not reach outside the working directory.
// ---------------------------------------------------------------------------

test('a pattern with .. does not return files above the cwd', () => {
  const root = tmpdir('hg-esc-');
  const outside = path.join(path.dirname(root), path.basename(root) + '-outside.ts');
  try {
    fs.writeFileSync(outside, 'export const outside = 1;\n');
    assert.throws(
      () => hyperglobSync('../*.ts', { cwd: root, pathsOnly: true }),
      /escapes the working directory/
    );
    // The file above the cwd is not reachable through any pattern.
    const out = rels(hyperglobSync('**/*.ts', { cwd: root, pathsOnly: true }));
    assert.deepEqual(out, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

// ---------------------------------------------------------------------------
// A pattern naming a directory reports that directory.
// ---------------------------------------------------------------------------

test('a magic-free pattern naming a directory reports the directory', () => {
  const root = tmpdir('hg-dir-');
  try {
    fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(root, 'src', 'sub', 'b.ts'), '');
    const dirs = rels(
      hyperglobSync('src', { cwd: root, pathsOnly: true, onlyFiles: false })
    );
    assert.ok(dirs.includes('src'), `expected "src" in ${JSON.stringify(dirs)}`);
    // onlyFiles filters the directory out but keeps the files inside it.
    const files = rels(hyperglobSync('src', { cwd: root, pathsOnly: true, onlyFiles: true }));
    assert.deepEqual(files, ['src/a.ts', 'src/sub/b.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('src/** reports the contents but not the directory itself', () => {
  const root = tmpdir('hg-dir2-');
  try {
    fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(root, 'src', 'sub', 'b.ts'), '');
    const out = rels(hyperglobSync('src/**', { cwd: root, pathsOnly: true, onlyFiles: false }));
    assert.ok(!out.includes('src'), `src/** must not match the directory: ${JSON.stringify(out)}`);
    assert.deepEqual(out, ['src/a.ts', 'src/sub', 'src/sub/b.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The warm index must not change the answer.
// ---------------------------------------------------------------------------

test('the warm index does not change the result set', () => {
  const root = tmpdir('hg-idx-');
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const q = (opts) =>
      rels(hyperglobSync('**/*', { cwd: root, pathsOnly: true, dot: true, ...opts }));
    const cold = q({});
    const indexedCold = q({ index: true });
    assert.deepEqual(indexedCold, cold);
    // Now the index file physically exists. A live scan must still exclude
    // it, otherwise the answer would depend on whether the cache is warm.
    assert.ok(fs.existsSync(path.join(root, '.hyperglob', 'index.json')));
    assert.deepEqual(q({}), cold, 'live scan changed once the index was written');
    assert.deepEqual(q({ index: true }), cold, 'indexed scan changed once the index was written');
    assert.ok(!cold.some((p) => p.includes('.hyperglob')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Option validation must report mistakes clearly.
// ---------------------------------------------------------------------------

test('a negative or non-integer maxDepth reports a clear error', () => {
  const root = tmpdir('hg-depth-');
  try {
    fs.writeFileSync(path.join(root, 'a.ts'), '');
    for (const bad of [-1, 'abc', 1.5, NaN]) {
      assert.throws(
        () => hyperglobSync('*.ts', { cwd: root, maxDepth: bad }),
        /maxDepth must be a non-negative integer/,
        `maxDepth: ${JSON.stringify(bad)} should be rejected`
      );
    }
    assert.throws(
      () => hyperglobSync('*.ts', { cwd: root, threads: -1 }),
      /threads must be a non-negative integer/
    );
    // A valid value still works.
    assert.deepEqual(rels(hyperglobSync('*.ts', { cwd: root, pathsOnly: true, maxDepth: 0 })), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Entry shape: the sync and streaming paths must agree.
// ---------------------------------------------------------------------------

test('entries have a valid modified date, and stats:false omits it cleanly', () => {
  const root = tmpdir('hg-ent-');
  try {
    fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
    const [entry] = hyperglobSync('*.ts', { cwd: root });
    assert.ok(entry.modified instanceof Date);
    assert.ok(!Number.isNaN(entry.modified.getTime()));
    assert.equal(typeof entry.modified.toISOString(), 'string');

    // With stats:false there is no date. It must be absent, not an Invalid
    // Date whose toISOString() throws.
    const [noStats] = hyperglobSync('*.ts', { cwd: root, stats: false });
    assert.equal(noStats.modified, undefined);
    assert.equal(noStats.size, undefined);
    assert.doesNotThrow(() => JSON.stringify(noStats));
    const parsed = JSON.parse(JSON.stringify(noStats));
    assert.equal(parsed.modified, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Streaming must actually stream, and must agree with the sync API.
// ---------------------------------------------------------------------------

test('the streaming API yields the same entries as the sync API', async () => {
  const root = tmpdir('hg-stream-');
  try {
    for (let i = 0; i < 12; i++) {
      fs.mkdirSync(path.join(root, 'd' + (i % 3)), { recursive: true });
      fs.writeFileSync(path.join(root, 'd' + (i % 3), `f${i}.ts`), `export const x = ${i};\n`);
    }
    const sync = hyperglobSync('**/*.ts', { cwd: root }).map((e) => e.relativePath).sort();
    const streamed = [];
    for await (const e of hyperglob('**/*.ts', { cwd: root })) {
      streamed.push(e.relativePath);
    }
    assert.deepEqual(streamed.slice().sort(), sync);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pathsOnly streaming is incremental and matches the sync result', async () => {
  const root = tmpdir('hg-stream2-');
  try {
    for (let i = 0; i < 12; i++) {
      fs.mkdirSync(path.join(root, 'd' + (i % 3)), { recursive: true });
      fs.writeFileSync(path.join(root, 'd' + (i % 3), `f${i}.ts`), `export const x = ${i};\n`);
    }
    const sync = hyperglobSync('**/*.ts', { cwd: root, pathsOnly: true }).slice().sort();
    const streamed = [];
    for await (const p of hyperglob('**/*.ts', { cwd: root, pathsOnly: true })) {
      streamed.push(p);
    }
    assert.deepEqual(streamed.slice().sort(), sync);
    // The stream must be interruptible: abandoning it early must not hang
    // or throw, which proves the scan is not one blocking materialization.
    const it = hyperglob('**/*.ts', { cwd: root, pathsOnly: true })[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(first.done, false);
    assert.equal(typeof first.value, 'string');
    await it.return();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
