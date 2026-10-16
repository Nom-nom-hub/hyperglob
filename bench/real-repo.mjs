// Real-world benchmark + parity check against a real repository checkout.
//
//   git clone --depth 1 https://github.com/facebook/react.git /tmp/react
//   node bench/real-repo.mjs /tmp/react
//
// Compares hyperglob vs fast-glob vs ripgrep on tasks an agent runs against
// a real codebase, and verifies hyperglob and fast-glob return the SAME
// path set for plain globs (result parity). Machine-dependent numbers.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hyperglobSync, hyperglobDependents } = require('../index.js');
const fg = require('fast-glob');

const root = process.argv[2] || process.env.HG_REAL_REPO;
if (!root) {
  console.error('usage: node bench/real-repo.mjs <path-to-repo-checkout>');
  process.exit(2);
}
const RUNS = 5;
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
async function timeit(label, fn) {
  const ts = [];
  let out;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    out = await fn();
    ts.push(performance.now() - t0);
  }
  const n = Array.isArray(out) ? out.length : out;
  console.log(`${label.padEnd(52)} med ${med(ts).toFixed(0).padStart(6)} ms   (n=${n})`);
  return out;
}
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });

console.log(`real repo: ${root}\n`);

// Plain glob parity + speed
const hgPaths = await timeit('hyperglob pathsOnly **/*.js', () => hyperglobSync('**/*.js', { cwd: root, pathsOnly: true }));
const fgPaths = await timeit('fast-glob **/*.js', async () => fg('**/*.js', { cwd: root }));
{
  const a = new Set(hgPaths);
  const b = new Set(fgPaths);
  const onlyHg = [...a].filter((x) => !b.has(x));
  const onlyFg = [...b].filter((x) => !a.has(x));
  console.log(`parity **/*.js: hyperglob-only=${onlyHg.length} fast-glob-only=${onlyFg.length}` +
    (onlyHg.length || onlyFg.length ? `  hg:${onlyHg.slice(0, 3)} fg:${onlyFg.slice(0, 3)}` : '  (sets identical)'));
}

// Content query
await timeit('hyperglob :contains("createElement")', () => hyperglobSync('**/*.js :contains("createElement")', { cwd: root, pathsOnly: true }));
await timeit('ripgrep -l createElement', () => sh('rg', ['-l', 'createElement', '-g', '*.js', '.']).trim().split('\n').filter(Boolean));
await timeit('fast-glob + readFile + includes', async () => {
  const files = await fg('**/*.js', { cwd: root });
  let n = 0;
  for (const f of files) {
    if ((await fs.readFile(path.join(root, f), 'utf8')).includes('createElement')) n++;
  }
  return n;
});

// Where-defined (AST vs regex): count ripgrep false positives against the
// AST answer as ground truth.
const truth = hyperglobSync('**/*.js :exports("createElement")', { cwd: root, pathsOnly: true });
await timeit('hyperglob :exports("createElement") (AST)', () =>
  hyperglobSync('**/*.js :exports("createElement")', { cwd: root, pathsOnly: true }));
const rgHits = sh('rg', ['-l', 'export (const|function|class) createElement', '-g', '*.js', '.'])
  .trim().split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, ''));
const rgSet = new Set(rgHits);
const falsePos = rgHits.filter((p) => !truth.includes(p)).length;
console.log(`${'ripgrep regex for createElement definition'.padEnd(52)} results=${rgHits.length} falsePositives=${falsePos} (truth=${truth.length})`);

// Import graph (unique to hyperglob)
await timeit('hyperglob dependents of packages/shared/ReactSymbols.js', () =>
  hyperglobDependents('packages/shared/ReactSymbols.js', { cwd: root }));
