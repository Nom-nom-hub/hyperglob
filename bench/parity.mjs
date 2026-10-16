// Result-parity suite: hyperglob and fast-glob must return identical path
// sets for plain globs across randomly generated trees (seeded PRNG, so
// failures reproduce). This guards the "drop-in replacement" claim —
// speed means nothing if the sets drift.
// Run: node bench/parity.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hyperglobSync } = require('../index.js');
const fg = require('fast-glob');

// mulberry32 seeded PRNG
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EXTS = ['ts', 'js', 'tsx', 'json', 'md'];
function buildTree(seed) {
  const rand = rng(seed);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hyperglob-parity-${seed}-`));
  const dirs = ['', 'src', 'src/a', 'src/deep/nest', 'lib', 'pkg/x', 'pkg/y', '.hidden', 'dist'];
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n*.log\nbuild/\n');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  const names = ['index', 'util', 'deep', 'a', 'b', 'test', 'spec'];
  for (const d of dirs) {
    const count = 4 + Math.floor(rand() * 14);
    for (let i = 0; i < count; i++) {
      const name = `${names[Math.floor(rand() * names.length)]}${i}.${EXTS[Math.floor(rand() * EXTS.length)]}`;
      fs.writeFileSync(path.join(root, d, name), 'export const x = 1;\n');
    }
  }
  fs.writeFileSync(path.join(root, 'src', 'skip.log'), 'ignored\n');
  fs.writeFileSync(path.join(root, 'build', 'out.ts'), 'export const built = 1;\n');
  fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'x\n');
  return root;
}

const CASES = [
  { pattern: '**/*.ts' },
  { pattern: 'src/**/*.ts' },
  { pattern: '**/*.{ts,js}' },
  { pattern: 'src/**/deep/*.ts' },
  { pattern: 'pkg/**/*.json' },
  { pattern: '**/*.ts', neg: ['**/a*.ts'] },
  { pattern: 'src/**/*.ts', maxDepth: 2 },
  { pattern: '**/*' },
];

let failures = 0;
for (const seed of [1, 7, 42]) {
  const root = buildTree(seed);
  try {
    for (const c of CASES) {
      const hgOpts = { cwd: root, pathsOnly: true };
      if (c.maxDepth) hgOpts.maxDepth = c.maxDepth;
      const query = c.neg ? `${c.pattern} ${c.neg.map((n) => '!' + n).join(' ')}` : c.pattern;
      const hg = hyperglobSync(query, hgOpts).slice().sort();
      const fgOpts = { cwd: root, dot: false };
      if (c.maxDepth) fgOpts.deep = c.maxDepth;
      if (c.neg) fgOpts.ignore = c.neg;
      // fast-glob has no native .gitignore: hand it the same rules.
      fgOpts.ignore = [...(fgOpts.ignore || []), '**/dist/**', '**/build/**', '**/*.log'];
      const fgOut = (await fg(c.pattern, fgOpts)).slice().sort();
      const same = JSON.stringify(hg) === JSON.stringify(fgOut);
      if (!same) {
        failures++;
        const onlyHg = hg.filter((x) => !fgOut.includes(x));
        const onlyFg = fgOut.filter((x) => !hg.includes(x));
        console.log(`MISMATCH seed=${seed} pattern=${c.pattern} maxDepth=${c.maxDepth || '-'} neg=${(c.neg || []).join(',')}`);
        console.log(`  hyperglob-only: ${onlyHg.slice(0, 5).join(', ')} (${onlyHg.length})`);
        console.log(`  fast-glob-only: ${onlyFg.slice(0, 5).join(', ')} (${onlyFg.length})`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (failures) {
  console.log(`parity: ${failures} mismatch(es)`);
  process.exit(1);
}
console.log(`parity: all ${3 * CASES.length} cases identical across 3 seeded trees`);
