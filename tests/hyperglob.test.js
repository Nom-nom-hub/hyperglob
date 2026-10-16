'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { hyperglob, hyperglobSync, hyperglobDependents, parseQuery, version } = require('../index.js');

let root;

function write(rel, content, mtime) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}

const OLD = new Date('2026-09-15T12:00:00Z');
const NEW = new Date('2026-10-10T12:00:00Z');

test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-test-'));
  write('.gitignore', 'dist/\n*.log\n');
  write('.agentignore', 'secret.ts\n');
  write('src/index.ts', 'export const useServerHook = () => 1;\n', NEW);
  write('src/other.ts', 'export const somethingElse = 2;\n', OLD);
  write('src/deep/nested.ts', 'const plain = "export const in a string";\n', NEW);
  write('src/app.test.ts', 'export const useServerHook = () => 3;\n', NEW);
  write('src/secret.ts', 'export const useServerHook = () => 4;\n', NEW);
  write('src/big.ts', 'x'.repeat(2048), NEW);
  write('src/small.ts', 'tiny', OLD);
  // Boundary probe: Sep 28 is after a wrong Sep-26 threshold but before the
  // real Oct-1 threshold — pins :modified date parsing to the exact day.
  write('src/boundary.ts', 'boundary\n', new Date('2026-09-28T12:00:00Z'));
  write('src/dist/bundle.ts', 'export const useServerHook = () => 5;\n', NEW);
  write('src/ignored.log', 'export const useServerHook\n', NEW);
  write('pkg/package.json', JSON.stringify({
    name: 'pkg',
    dependencies: { react: '19.0.0' },
    devDependencies: { vitest: '2.0.0' },
  }), NEW);
  write('pkg/other.json', JSON.stringify({ name: 'other', dependencies: { vue: '3.0.0' } }), NEW);
  write('README.md', '# hi\n', OLD);
});

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const rels = (entries) => entries.map((e) => e.relativePath).sort();

test('version is exposed', () => {
  assert.equal(version(), '0.4.0');
});

test('parseQuery parses PRD syntax', () => {
  const q = parseQuery('src/**/*.ts :contains("useServerHook")');
  assert.deepEqual(q.patterns, ['src/**/*.ts']);
  assert.equal(q.selectors.length, 1);
});

test('standard glob (PRD §4) respects .gitignore and .agentignore', () => {
  const out = rels(hyperglobSync('src/**/*.ts', { cwd: root }));
  assert.deepEqual(out, [
    'src/app.test.ts',
    'src/big.ts',
    'src/boundary.ts',
    'src/deep/nested.ts',
    'src/index.ts',
    'src/other.ts',
    'src/small.ts',
  ]);
});

test('gitignore: false surfaces gitignored files; .agentignore is governed by ignoreFiles', () => {
  const out = rels(hyperglobSync('src/**/*.ts', { cwd: root, gitignore: false }));
  assert.ok(out.includes('src/dist/bundle.ts'), out.join(','));
  assert.ok(!out.includes('src/secret.ts'), '.agentignore should still apply: ' + out.join(','));
  const out2 = rels(hyperglobSync('src/**/*.ts', { cwd: root, gitignore: false, ignoreFiles: false }));
  assert.ok(out2.includes('src/secret.ts'), out2.join(','));
});

test(':contains filters by content in-flight (PRD §4)', () => {
  const out = rels(hyperglobSync('src/**/*.ts :contains("useServerHook")', { cwd: root }));
  assert.deepEqual(out, ['src/app.test.ts', 'src/index.ts']);
});

test(':contains with regex', () => {
  const out = rels(hyperglobSync('src/**/*.ts :contains(/use(Server|Client)Hook/)', { cwd: root }));
  assert.deepEqual(out, ['src/app.test.ts', 'src/index.ts']);
});

test(':exports matches real export signatures, not strings', () => {
  const out = rels(hyperglobSync('src/**/*.ts :exports("useServerHook")', { cwd: root }));
  assert.deepEqual(out, ['src/app.test.ts', 'src/index.ts']);
  assert.ok(!out.includes('src/deep/nested.ts'));
});

test(':has-key evaluates JSON structure (PRD §4)', () => {
  const out = rels(hyperglobSync('pkg/**/*.json :has-key("dependencies.react")', { cwd: root }));
  assert.deepEqual(out, ['pkg/package.json']);
});

test(':size filters at stat time (PRD §4)', () => {
  const small = rels(hyperglobSync('src/**/* :size(<100kb)', { cwd: root }));
  assert.ok(small.includes('src/small.ts'));
  const big = rels(hyperglobSync('src/**/* :size(>1kb)', { cwd: root }));
  assert.deepEqual(big, ['src/big.ts']);
});

test(':modified filters by mtime (PRD §4)', () => {
  const out = rels(hyperglobSync('src/**/*.ts :modified(>2026-10-01)', { cwd: root }));
  assert.ok(out.includes('src/index.ts'));
  assert.ok(!out.includes('src/other.ts'));
  assert.ok(!out.includes('src/small.ts'));
  assert.ok(!out.includes('src/boundary.ts'), 'Sep 28 file must not pass a >2026-10-01 filter');
});

test('negation patterns + sync batch API (PRD §5.2)', () => {
  const out = rels(hyperglobSync(['src/**/*.ts', '!src/**/*.test.ts'], { cwd: root }));
  assert.ok(!out.includes('src/app.test.ts'));
  assert.ok(out.includes('src/index.ts'));
});

test('maxDepth limits traversal (PRD §5.2)', () => {
  // Depth is counted from the pattern's static base (fast-glob `deep`
  // semantics): src/index.ts is 1 below src/, src/deep/nested.ts is 2.
  // (Before v0.4.0 hyperglob counted from cwd and diverged from fast-glob;
  // bench/parity.mjs caught it.)
  const out2 = rels(hyperglobSync('src/**/*.ts', { cwd: root, maxDepth: 2 }));
  assert.ok(out2.includes('src/index.ts'));
  assert.ok(out2.includes('src/deep/nested.ts'));
  const out1 = rels(hyperglobSync('src/**/*.ts', { cwd: root, maxDepth: 1 }));
  assert.ok(out1.includes('src/index.ts'));
  assert.ok(!out1.includes('src/deep/nested.ts'));
});

test('stats are populated by default', () => {
  const [entry] = hyperglobSync('src/index.ts', { cwd: root });
  assert.equal(typeof entry.size, 'number');
  assert.ok(entry.size > 0);
  assert.ok(entry.modified instanceof Date);
  assert.equal(entry.name, 'index.ts');
  assert.equal(entry.extension, 'ts');
  assert.ok(path.isAbsolute(entry.path));
});

test('content option returns content with no extra read', () => {
  const [entry] = hyperglobSync('src/small.ts', { cwd: root, content: true });
  assert.equal(entry.content, 'tiny');
  assert.ok(Buffer.isBuffer(entry.buffer));
  assert.equal(entry.buffer.toString('utf8'), 'tiny');
});

test('async streaming API (PRD §5.1) yields the same set as sync', async () => {
  const streamed = [];
  for await (const entry of hyperglob('src/**/*.ts :contains("useServerHook")', { cwd: root })) {
    streamed.push(entry.relativePath);
  }
  assert.deepEqual(streamed.sort(), ['src/app.test.ts', 'src/index.ts']);
});

test('awaiting the stream collects all entries', async () => {
  const entries = await hyperglob('pkg/**/*.json', { cwd: root });
  assert.equal(entries.length, 2);
});

test('selector combos stack (AND semantics)', () => {
  // Note: deep/nested.ts contains the literal text "export const" (inside a
  // string), so :contains matches it — only :exports distinguishes that case.
  const out = rels(hyperglobSync('src/**/*.ts :contains("export const") :modified(>2026-10-01) :size(<1kb)', { cwd: root }));
  assert.deepEqual(out, ['src/app.test.ts', 'src/deep/nested.ts', 'src/index.ts']);
});

test('threads option is accepted', () => {
  const out = hyperglobSync('src/**/*.ts', { cwd: root, threads: 8 });
  assert.ok(out.length >= 6);
});

test('pathsOnly returns relative path strings', () => {
  const out = hyperglobSync('src/**/*.ts :contains("useServerHook")', { cwd: root, pathsOnly: true }).sort();
  assert.deepEqual(out, ['src/app.test.ts', 'src/index.ts']);
  assert.equal(typeof out[0], 'string');
});

test('unknown selector errors loudly', () => {
  assert.throws(() => hyperglobSync('src/**/*.ts :bogus(1)', { cwd: root }), /unknown selector/);
});

test(':exports is a real AST check (aliases, re-exports, defaults; no comment/string traps)', () => {
  write('src/ast/comment-trap.ts', '// export const phantomHook = 1;\nconst real = 1;\n', NEW);
  write('src/ast/alias.ts', 'const impl = () => 2;\nexport { impl as phantomHook };\n', NEW);
  write('src/ast/reexport.ts', 'export { impl as phantomHook } from "./alias";\n', NEW);
  write('src/ast/def.ts', 'export default function phantomHook() {}\n', NEW);
  const out = rels(hyperglobSync('src/ast/*.ts :exports("phantomHook")', { cwd: root }));
  assert.deepEqual(out, ['src/ast/alias.ts', 'src/ast/def.ts', 'src/ast/reexport.ts']);
  const def = rels(hyperglobSync('src/ast/*.ts :exports("default")', { cwd: root }));
  assert.deepEqual(def, ['src/ast/def.ts']);
});

test(':imports matches import declarations, subpaths, and require()', () => {
  write('src/imp/a.ts', "import { useState } from 'react';\nexport const a = useState;\n", NEW);
  write('src/imp/b.ts', "import 'react/jsx-runtime';\n", NEW);
  write('src/imp/c.ts', "const p = require('react');\nmodule.exports = p;\n", NEW);
  write('src/imp/d.ts', "import { x } from 'preact';\nexport const d = x;\n", NEW);
  write('src/imp/e.ts', "// import { y } from 'react';\nconst e = 1;\n", NEW);
  const out = rels(hyperglobSync('src/imp/*.ts :imports("react")', { cwd: root }));
  assert.deepEqual(out, ['src/imp/a.ts', 'src/imp/b.ts', 'src/imp/c.ts']);
});

test('hyperglobDependents returns direct + transitive importers', () => {
  write('graph/c.ts', 'export const c = 1;\n', NEW);
  write('graph/b.ts', "import { c } from './c';\nexport const b = c;\n", NEW);
  write('graph/a.ts', "import { b } from './b.js';\nexport const a = b;\n", NEW);
  write('graph/d.ts', "import { a } from './a';\nexport const d = a;\n", NEW);
  write('graph/e.ts', "import { c } from './c';\nimport React from 'react';\nexport const e = c;\n", NEW);
  write('graph/z.ts', 'export const z = 0;\n', NEW);
  const deps = hyperglobDependents('graph/c.ts', { cwd: root });
  assert.deepEqual(deps, ['graph/a.ts', 'graph/b.ts', 'graph/d.ts', 'graph/e.ts']);
  assert.deepEqual(hyperglobDependents('graph/a.ts', { cwd: root }), ['graph/d.ts']);
  assert.throws(() => hyperglobDependents('graph/nope.ts', { cwd: root }), /not found/);
});

test('warm index: builds, answers, detects structural + content changes', () => {
  const iroot = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-index-'));
  try {
    fs.mkdirSync(path.join(iroot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(iroot, '.gitignore'), 'dist/\n');
    fs.writeFileSync(path.join(iroot, 'src', 'one.ts'), 'export const one = 1;\n');
    fs.writeFileSync(path.join(iroot, 'src', 'two.ts'), 'export const two = 2;\n');
    const q = (opts) => hyperglobSync('src/**/*.ts', { cwd: iroot, pathsOnly: true, ...opts }).sort();
    // Cold: builds the snapshot.
    assert.deepEqual(q({ index: true }), ['src/one.ts', 'src/two.ts']);
    assert.ok(fs.existsSync(path.join(iroot, '.hyperglob', 'index.json')));
    // Warm: same answer, and .hyperglob itself never leaks into results.
    assert.deepEqual(q({ index: true }), ['src/one.ts', 'src/two.ts']);
    assert.deepEqual(hyperglobSync('**/*.json', { cwd: iroot, pathsOnly: true, index: true }), []);
    // Content edit (no directory change): selector answers stay exact,
    // because matched entries are re-stat'ed / read fresh.
    fs.writeFileSync(path.join(iroot, 'src', 'one.ts'), 'export const one = 1;\n// padded\n'.padEnd(500, 'x'));
    const big = hyperglobSync('src/**/*.ts :size(>100b)', { cwd: iroot, pathsOnly: true, index: true });
    assert.deepEqual(big, ['src/one.ts']);
    // Structural change: new file appears after the parent dir is touched
    // (explicit utimes bump defeats coarse mtime granularity in tests).
    fs.writeFileSync(path.join(iroot, 'src', 'three.ts'), 'export const three = 3;\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(iroot, 'src'), future, future);
    assert.deepEqual(q({ index: true }), ['src/one.ts', 'src/three.ts', 'src/two.ts']);
    // Corrupt snapshot: falls back to a rebuild, still correct.
    fs.writeFileSync(path.join(iroot, '.hyperglob', 'index.json'), '{broken');
    assert.deepEqual(q({ index: true }), ['src/one.ts', 'src/three.ts', 'src/two.ts']);
  } finally {
    fs.rmSync(iroot, { recursive: true, force: true });
  }
});

test('MCP server answers initialize, tools/list, tools/call over stdio', async () => {
  const { spawn } = require('child_process');
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'mcp.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const byId = new Map();
  const waiters = new Map();
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      byId.set(msg.id, msg);
      if (waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  const call = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout waiting for ${method}`)), 15000);
      waiters.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  try {
    const init = await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'hyperglob');
    const list = await call(2, 'tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['hyperglob_dependents', 'hyperglob_paths', 'hyperglob_query']);
    const res = await call(3, 'tools/call', {
      name: 'hyperglob_paths',
      arguments: { pattern: 'src/**/*.ts :exports("useServerHook")', cwd: root },
    });
    const text = res.result.content[0].text;
    assert.ok(text.includes('src/index.ts'));
    assert.ok(text.includes('src/app.test.ts'));
    const q = await call(4, 'tools/call', {
      name: 'hyperglob_query',
      arguments: { pattern: 'src/**/*.ts :imports("react")', cwd: root },
    });
    assert.ok(!q.result.isError);
  } finally {
    proc.kill();
  }
});
