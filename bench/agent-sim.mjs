// Agent-task simulation: five discovery tasks an AI coding agent actually
// runs, hyperglob vs ripgrep vs find vs fast-glob pipelines, on a synthetic
// 13,336-file monorepo with realistic traps planted (comments saying code
// "moved", doc strings, commented-out imports, react in devDependencies).
// Metrics that matter to an agent: wall time, number of calls, FALSE
// POSITIVES (each one is context the agent must burn disambiguating), and
// result payload size (bytes ~ tokens/4).
// Run: node bench/agent-sim.mjs   (requires ripgrep + find on PATH)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-agent-sim-'));
const base = fixtureDir;
fs.rmSync(base, {recursive:true, force:true});
fs.mkdirSync(base, {recursive:true});
fs.writeFileSync(path.join(base,'.gitignore'), 'dist/\n*.log\n');
const NEW = new Date('2026-10-10T12:00:00Z'), OLD = new Date('2026-09-15T12:00:00Z');
for (const d of ['src','src/a','src/b','src/c','dist']) fs.mkdirSync(path.join(base,d),{recursive:true});
let idx = 0;
for (const d of ['src','src/a','src/b','src/c']) for (let j=0;j<3334;j++, idx++) {
  const p = path.join(base,d,`file${j}.ts`);
  let content;
  if (idx % 500 === 0) content = "import { useState } from 'react';\nexport const useServerHook = () => useState;\n";
  else {
    content = "import fs from 'node:fs';\nexport const v = 1;\n// export const useServerHook = () => {} (old location, moved)\nconst doc = 'useServerHook is defined in the hooks package';\n";
    if (idx % 7 === 0) content += "// example: import { y } from 'react';\n";
  }
  fs.writeFileSync(p, content);
  fs.utimesSync(p, idx % 2 === 0 ? NEW : OLD, idx % 2 === 0 ? NEW : OLD);
}
for (let j=0;j<2000;j++) fs.writeFileSync(path.join(base,'dist',`b${j}.ts`), "import { useState } from 'react';\nexport const useServerHook = () => useState;\n");
for (let k=0;k<200;k++) {
  const dir = path.join(base,'packages',`pkg${k}`); fs.mkdirSync(dir,{recursive:true});
  const pkg = { name: `pkg${k}`, version: '1.0.0' };
  if (k % 5 === 0) pkg.dependencies = { react: '19.0.0', lodash: '4.0.0' };
  else if (k % 5 === 1) pkg.devDependencies = { react: '19.0.0', vitest: '2.0.0' };
  else pkg.dependencies = { lodash: '4.0.0' };
  fs.writeFileSync(path.join(dir,'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}
// built:  13,336 src .ts (28 real useServerHook defs, traps in the rest), 200 package.json (40 real react deps, 40 devDep traps), dist ignored');

import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire('/home/hatch/workspace/hyperglob/package.json');
const { hyperglobSync } = require('/home/hatch/workspace/hyperglob/index.js');
const fg = require('fast-glob');
const root = fixtureDir;
const RUNS = 5;
function med(a){ return a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)]; }
async function timeit(fn){ const ts=[]; let raw; for(let i=0;i<RUNS;i++){ const t0=performance.now(); raw=await fn(); ts.push(performance.now()-t0);} const count = Array.isArray(raw) ? raw.length : raw; const payload = Array.isArray(raw) ? P(raw.join('\n')) : 200; return {ms: med(ts), out: count, payload}; }
function sh(cmd, args){ return execFileSync(cmd, args, {cwd: root, encoding:'utf8', maxBuffer: 64*1024*1024}); }
function row(task, who, calls, r, truth){
  const fp = Math.max(0, r.out - truth);
  console.log(`${task} | ${who} | calls=${calls} | ${r.ms.toFixed(0)}ms | results=${r.out} | false+${fp} | payload ~${r.payload}B (~${Math.round(r.payload/4)} tok)`);
}
const P = (s) => Buffer.byteLength(s);

// T1: where is useServerHook DEFINED? truth = 28
{
  const hg = await timeit(() => hyperglobSync('src/**/*.ts :exports("useServerHook")', {cwd:root, pathsOnly:true}));
  row('T1 defined?', 'hyperglob :exports', 1, hg, 27);
  const rg = await timeit(() => sh('rg', ['-l', 'export (const|function|class) useServerHook', 'src']).trim().split('\n').filter(Boolean));
  row('T1 defined?', 'ripgrep -l regex', 1, rg, 27);
  const fgp = await timeit(async () => { const files = await fg('src/**/*.ts', {cwd:root}); let n=0; const re = /export\s+(?:const|function|class)\s+useServerHook\b/; for (const f of files) { if (re.test(await fsp.readFile(`${root}/${f}`,'utf8'))) n++; } return n; });
  row('T1 defined?', 'fast-glob + read all + regex', '1 script / 13,336 reads', fgp, 28, 200);
}
// T2: files that MENTION useServerHook. truth = 13,336 (every src file mentions it)
{
  const hg = await timeit(() => hyperglobSync('src/**/*.ts :contains("useServerHook")', {cwd:root, pathsOnly:true}));
  row('T2 mentions?', 'hyperglob :contains', 1, hg, 13336);
  const rg = await timeit(() => sh('rg', ['-l', 'useServerHook', 'src']).trim().split('\n').filter(Boolean));
  row('T2 mentions?', 'ripgrep -l', 1, rg, 13336);
}
// T3: files that IMPORT react. truth = 28 real + every-7th comment trap must NOT count (~1,905 traps)
{
  const hg = await timeit(() => hyperglobSync('src/**/*.ts :imports("react")', {cwd:root, pathsOnly:true}));
  row('T3 imports react?', 'hyperglob :imports (AST)', 1, hg, 27);
  const rg = await timeit(() => sh('rg', ['-l', "from 'react'|require\\('react'\\)", 'src']).trim().split('\n').filter(Boolean));
  row('T3 imports react?', 'ripgrep -l regex', 1, rg, 27);
}
// T4: packages that DEPEND on react (dependencies only). truth = 40 (40 more have it in devDependencies)
{
  const hg = await timeit(() => hyperglobSync('packages/*/package.json :has-key("dependencies.react")', {cwd:root, pathsOnly:true}));
  row('T4 react dependents?', 'hyperglob :has-key', 1, hg, 40);
  const rg = await timeit(() => sh('rg', ['-l', '"react":', 'packages']).trim().split('\n').filter(Boolean));
  row('T4 react dependents?', 'ripgrep -l "\\"react\\":"', 1, rg, 40);
  const fgp = await timeit(async () => { const files = await fg('packages/*/package.json', {cwd:root}); let n=0; for (const f of files) { const j = JSON.parse(await fsp.readFile(`${root}/${f}`,'utf8')); if (j.dependencies && j.dependencies.react) n++; } return n; });
  row('T4 react dependents?', 'fast-glob + read + JSON.parse', '1 script / 200 reads', fgp, 40);
}
// T5: .ts files modified after 2026-10-01. truth = 6,668
{
  const hg = await timeit(() => hyperglobSync('src/**/*.ts :modified(>2026-10-01)', {cwd:root, pathsOnly:true}));
  row('T5 changed since Oct 1?', 'hyperglob :modified', 1, hg, 6668);
  const fd = await timeit(() => sh('find', ['src', '-name', '*.ts', '-newermt', '2026-10-01']).trim().split('\n').filter(Boolean));
  row('T5 changed since Oct 1?', 'find -newermt', 1, fd, 6668);
  const fgp = await timeit(async () => { const files = await fg('src/**/*.ts', {cwd:root}); let n=0; const cut = Date.parse('2026-10-01'); for (const f of files) { const s = await fsp.stat(`${root}/${f}`); if (s.mtimeMs > cut) n++; } return n; });
  row('T5 changed since Oct 1?', 'fast-glob + stat all', '1 script / 13,336 stats', fgp, 6668, 200);
}

fs.rmSync(fixtureDir, { recursive: true, force: true });
