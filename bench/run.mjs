#!/usr/bin/env node
// Benchmark: hyperglob vs fast-glob / fdir / tinyglobby.
// Generates a synthetic tree (default 20,000 files), runs each scenario
// several times and reports the median. Numbers are whatever this machine
// produces — no target is assumed.
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
const RUNS = 5;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-bench-'));

function buildTree() {
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n*.log\n');
  const dirs = ['src', 'src/a', 'src/b', 'src/c', 'lib', 'pkg', 'dist'];
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  const per = Math.ceil(FILE_COUNT / 6);
  let i = 0;
  for (const d of ['src', 'src/a', 'src/b', 'src/c', 'lib', 'pkg']) {
    for (let j = 0; j < per; j++) {
      const isHook = j % 500 === 0;
      fs.writeFileSync(
        path.join(root, d, `file${j}.ts`),
        isHook ? 'export const useServerHook = () => 1;\n' : `export const value${j} = ${j};\n// filler line\n`
      );
      i++;
    }
  }
  const distCount = Math.ceil(FILE_COUNT / 10);
  for (let j = 0; j < distCount; j++) {
    fs.writeFileSync(path.join(root, 'dist', `bundle${j}.ts`), 'export const x = 1;\n');
  }
  console.log(`fixture: ${i + distCount} files under ${root}`);
}

async function median(label, fn) {
  const times = [];
  let result;
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    result = await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)];
  console.log(`${label.padEnd(46)} ${med.toFixed(1).padStart(8)} ms   (n=${result})`);
  return med;
}

async function main() {
  buildTree();
  try {
    console.log('\n— Scenario 1: plain glob src/**/*.ts (gitignore respected) —');
    await median('hyperglob (sync, with stats)', () => hyperglobSync('src/**/*.ts', { cwd: root }).length);
    await median('hyperglob (sync, stats: false)', () => hyperglobSync('src/**/*.ts', { cwd: root, stats: false }).length);
    await median('hyperglob (pathsOnly)', () => hyperglobSync('src/**/*.ts', { cwd: root, pathsOnly: true }).length);
    await median('hyperglob (stream collect)', async () => (await hyperglob('src/**/*.ts', { cwd: root }).collect()).length);
    await median('fast-glob', async () => (await fg('src/**/*.ts', { cwd: root })).length);
    await median('tinyglobby', async () => (await tinyglob('src/**/*.ts', { cwd: root })).length);
    await median('fdir', async () => new fdir().glob('**/*.ts').withRelativePaths().crawl(path.join(root, 'src')).withPromise().then((r) => r.length));

    console.log('\n— Scenario 2: path + content query "useServerHook" —');
    await median('hyperglob :contains (single pass)', () => hyperglobSync('src/**/*.ts :contains("useServerHook")', { cwd: root }).length);
    await median('fast-glob + readFile + includes', async () => {
      const files = await fg('src/**/*.ts', { cwd: root });
      let hits = 0;
      for (const f of files) {
        const buf = await fs.promises.readFile(path.join(root, f));
        if (buf.includes('useServerHook')) hits++;
      }
      return hits;
    });

    console.log('\n— Scenario 3: gitignore-filtered full scan **/*.ts —');
    console.log('  (note: fast-glob does NOT read .gitignore — its raw count includes dist/;');
    console.log('   the "manual ignore" line is the apples-to-apples comparison from the PRD)');
    await median('hyperglob (sync, native gitignore)', () => hyperglobSync('**/*.ts', { cwd: root }).length);
    await median('hyperglob (pathsOnly, native gitignore)', () => hyperglobSync('**/*.ts', { cwd: root, pathsOnly: true }).length);
    await median('fast-glob (no gitignore support)', async () => (await fg('**/*.ts', { cwd: root })).length);
    await median('fast-glob + manual ignore list', async () => (await fg('**/*.ts', { cwd: root, ignore: ['**/dist/**', '**/*.log'] })).length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
