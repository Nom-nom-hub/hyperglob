#!/usr/bin/env node
// Benchmark: hyperglob vs fast-glob / fdir / tinyglobby.
// Generates a synthetic tree (default 20,000 files), warms every engine up,
// then reports median AND min of 7 runs. This VM is noisy — min is the
// cleaner capability signal, median shows typical jitter. Both are printed
// so nobody has to trust a single number.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import fg from 'fast-glob';
import { fdir } from 'fdir';
import { glob as tinyglob } from 'tinyglobby';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hyperglobSync, hyperglob } = require('../index.js');

const FILE_COUNT = parseInt(process.env.BENCH_FILES || '20000', 10);
const RUNS = 7;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-bench-'));

function buildTree(base, total) {
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, '.gitignore'), 'dist/\n*.log\n');
  const dirs = ['src', 'src/a', 'src/b', 'src/c', 'lib', 'pkg', 'dist'];
  for (const d of dirs) fs.mkdirSync(path.join(base, d), { recursive: true });
  const per = Math.ceil(total / 6);
  let i = 0;
  for (const d of ['src', 'src/a', 'src/b', 'src/c', 'lib', 'pkg']) {
    for (let j = 0; j < per; j++) {
      const isHook = j % 500 === 0;
      fs.writeFileSync(
        path.join(base, d, `file${j}.ts`),
        isHook ? 'export const useServerHook = () => 1;\n' : `export const value${j} = ${j};\n// filler line\n`
      );
      i++;
    }
  }
  const distCount = Math.ceil(total / 10);
  for (let j = 0; j < distCount; j++) {
    fs.writeFileSync(path.join(base, 'dist', `bundle${j}.ts`), 'export const x = 1;\n');
  }
  return i + distCount;
}

async function bench(label, fn) {
  await fn();
  await fn(); // warmup (cache, JIT, thread pools)
  const times = [];
  let result;
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    result = await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)];
  const min = times[0];
  console.log(
    `${label.padEnd(46)} med ${med.toFixed(1).padStart(8)} ms   min ${min.toFixed(1).padStart(8)} ms   (n=${result})`
  );
  return { med, min };
}


// Interleaved head-to-head: engines alternate running order each round so
// transient VM load spikes hit both sides. Reports median + min per engine.
async function race(pairs) {
  for (let w = 0; w < 2; w++) {
    for (const [, fn] of pairs) await fn();
  }
  const times = new Map(pairs.map(([l]) => [l, []]));
  const results = {};
  for (let r = 0; r < RUNS; r++) {
    const order = r % 2 === 0 ? pairs : [...pairs].reverse();
    for (const [label, fn] of order) {
      const t0 = performance.now();
      results[label] = await fn();
      times.get(label).push(performance.now() - t0);
    }
  }
  for (const [label] of pairs) {
    const ts = times.get(label).slice().sort((a, b) => a - b);
    const med = ts[Math.floor(ts.length / 2)];
    console.log(
      `${label.padEnd(46)} med ${med.toFixed(1).padStart(8)} ms   min ${ts[0].toFixed(1).padStart(8)} ms   (n=${results[label]})`
    );
  }
}

async function main() {
  const total = buildTree(root, FILE_COUNT);
  console.log(`fixture: ${total} files under ${root}`);
  try {
    console.log('\n— Scenario 1: plain glob src/**/*.ts (gitignore respected) —');
    await race([
      ['hyperglob pathsOnly', () => hyperglobSync('src/**/*.ts', { cwd: root, pathsOnly: true }).length],
      ['fast-glob (paths)', async () => (await fg('src/**/*.ts', { cwd: root })).length],
    ]);
    await bench('hyperglob entries, stats: false', () => hyperglobSync('src/**/*.ts', { cwd: root, stats: false }).length);
    await race([
      ['hyperglob entries + stats', () => hyperglobSync('src/**/*.ts', { cwd: root }).length],
      ['fast-glob (entries + stats)', async () => (await fg('src/**/*.ts', { cwd: root, stats: true })).length],
    ]);
    await bench('tinyglobby (paths)', async () => (await tinyglob('src/**/*.ts', { cwd: root })).length);
    await bench('fdir (paths)', async () => new fdir().glob('**/*.ts').withRelativePaths().crawl(path.join(root, 'src')).withPromise().then((r) => r.length));

    console.log('\n— Scenario 2: path + content query "useServerHook" —');
    await race([
      ['hyperglob :contains (single pass)', () => hyperglobSync('src/**/*.ts :contains("useServerHook")', { cwd: root, pathsOnly: true }).length],
      ['fast-glob + readFile + includes', async () => {
      const files = await fg('src/**/*.ts', { cwd: root });
      let hits = 0;
      for (const f of files) {
        const buf = await fs.promises.readFile(path.join(root, f));
        if (buf.includes('useServerHook')) hits++;
      }
      return hits;
      }],
    ]);

    console.log('\n— Scenario 3: gitignore-filtered full scan **/*.ts —');
    await race([
      ['hyperglob pathsOnly (native gitignore)', () => hyperglobSync('**/*.ts', { cwd: root, pathsOnly: true }).length],
      ['fast-glob + manual ignore list', async () => (await fg('**/*.ts', { cwd: root, ignore: ['**/dist/**', '**/*.log'] })).length],
    ]);
    await bench('hyperglob entries + stats (native gitignore)', () => hyperglobSync('**/*.ts', { cwd: root }).length);

    console.log('\n— Scenario 4: streaming API collect (ergonomics check, not a race) —');
    await bench('hyperglob stream collect', async () => (await hyperglob('src/**/*.ts', { cwd: root }).collect()).length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 100k scenario with fast-glob actually measured alongside.
  const big = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-bench100k-'));
  const bigTotal = buildTree(big, 100000);
  console.log(`\n— Scenario 5: 100,000-file tree (${bigTotal} files) —`);
  try {
    await race([
      ['hyperglob pathsOnly', () => hyperglobSync('src/**/*.ts', { cwd: big, pathsOnly: true }).length],
      ['fast-glob (paths)', async () => (await fg('src/**/*.ts', { cwd: big })).length],
    ]);
    await race([
      ['hyperglob entries + stats', () => hyperglobSync('src/**/*.ts', { cwd: big }).length],
      ['fast-glob (entries + stats)', async () => (await fg('src/**/*.ts', { cwd: big, stats: true })).length],
    ]);
    await race([
      ['hyperglob :contains (single pass)', () => hyperglobSync('src/**/*.ts :contains("useServerHook")', { cwd: big, pathsOnly: true }).length],
      ['fast-glob + readFile + includes', async () => {
      const files = await fg('src/**/*.ts', { cwd: big });
      let hits = 0;
      for (const f of files) {
        const buf = await fs.promises.readFile(path.join(big, f));
        if (buf.includes('useServerHook')) hits++;
      }
      return hits;
      }],
    ]);
  } finally {
    fs.rmSync(big, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
