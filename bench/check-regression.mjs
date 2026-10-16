// Perf-regression gate: runs the interleaved benchmark and fails if any
// tracked hyperglob median regresses beyond the baseline tolerance.
//   node bench/check-regression.mjs           # check
//   node bench/check-regression.mjs --write   # regenerate bench/baseline.json
// Machine-specific by design (baselines are per-hardware); CI was excluded
// by the maintainer, so this runs locally before a release.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

// The bench builds large fixture trees under TMPDIR; on small tmpfs mounts
// that fills up, so default TMPDIR to a repo-local scratch dir.
const scratch = process.env.TMPDIR || path.join(here, '..', '.bench-tmp');
fs.mkdirSync(scratch, { recursive: true });
const out = execFileSync('node', [path.join(here, 'run.mjs')], {
  encoding: 'utf8',
  maxBuffer: 1 << 26,
  env: { ...process.env, TMPDIR: scratch },
});
const medians = {};
for (const line of out.split('\n')) {
  const m = line.match(/^(.+?)\s+med\s+([\d.]+) ms/);
  if (m) medians[m[1].trim()] = parseFloat(m[2]);
}

if (process.argv.includes('--write')) {
  const next = { ...baseline, medians: {} };
  for (const key of Object.keys(baseline.medians)) {
    if (medians[key] !== undefined) next.medians[key] = medians[key];
  }
  fs.writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  console.log('baseline regenerated:', next.medians);
  process.exit(0);
}

let failed = 0;
for (const [key, base] of Object.entries(baseline.medians)) {
  const cur = medians[key];
  if (cur === undefined) {
    console.log(`MISSING  ${key}: not in bench output`);
    failed++;
    continue;
  }
  const limit = base * baseline.tolerance;
  const status = cur <= limit ? 'ok      ' : 'REGRESSED';
  if (cur > limit) failed++;
  console.log(`${status} ${key}: baseline ${base} ms, now ${cur} ms (limit ${limit.toFixed(1)})`);
}
process.exit(failed ? 1 : 0);
