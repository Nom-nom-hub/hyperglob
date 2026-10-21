#!/usr/bin/env node
// Fail the build if the platform/arch -> asset-name tables drift apart.
//
// Four places must agree on which platform/arch pairs are supported:
//   1. .github/workflows/release.yml   (what is actually built)
//   2. scripts/install.js              (SUPPORTED_PLATFORMS)
//   3. scripts/build-native.mjs        (TARGET_ASSETS / TRIPLE_TARGETS)
//   4. index.js                        (nativeFilename)
//
// A mismatch means a platform is claimed but never published, or published but
// never claimed -- either way a user gets a broken install with no error.
//
// This was the root cause of the darwin-x64 gap (see docs/PACKAGING_AUDIT.md
// F5). Exits non-zero on any mismatch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const problems = [];

// --- 1. release.yml matrix -------------------------------------------------
const releaseYml = read('.github/workflows/release.yml');
const matrixStart = releaseYml.indexOf('matrix:');
const matrixEnd = releaseYml.indexOf('steps:');
const matrixBlock = releaseYml.slice(matrixStart, matrixEnd);
const releaseTargets = new Set();
for (const m of matrixBlock.matchAll(/^\s*target:\s*([a-z0-9-]+)\s*$/gm)) {
  releaseTargets.add(m[1]);
}

// --- 2. install.js SUPPORTED_PLATFORMS -------------------------------------
const installJs = read('scripts/install.js');
const installTargets = new Set();
const spStart = installJs.indexOf('const SUPPORTED_PLATFORMS = {');
const spEnd = installJs.indexOf('};', spStart);
if (spStart >= 0 && spEnd > spStart) {
  for (const m of installJs.slice(spStart, spEnd).matchAll(/^\s*'([a-z0-9-]+)':\s*\{/gm)) {
    installTargets.add(m[1]);
  }
}

// --- 3. build-native.mjs TARGET_ASSETS -------------------------------------
const buildNative = read('scripts/build-native.mjs');
const buildTargets = new Set();
const taStart = buildNative.indexOf('const TARGET_ASSETS = {');
const taEnd = buildNative.indexOf('};', taStart);
if (taStart >= 0 && taEnd > taStart) {
  for (const m of buildNative.slice(taStart, taEnd).matchAll(/^\s*'([a-z0-9-]+)':/gm)) {
    buildTargets.add(m[1]);
  }
}

// --- 4. index.js nativeFilename --------------------------------------------
// index.js only knows the *canonical* (runtime) file names, so it is compared
// against the `canonical` field of SUPPORTED_PLATFORMS, not the target names.
const indexJs = read('index.js');
const indexAssets = new Set();
const ifStart = indexJs.indexOf('function nativeFilename()');
if (ifStart >= 0) {
  const ifEnd = indexJs.indexOf('\n}', ifStart);
  for (const m of indexJs.slice(ifStart, ifEnd).matchAll(/'(hyperglob\.[a-z0-9.-]+\.node)'/g)) {
    indexAssets.add(m[1]);
  }
}

const installCanonicals = new Set();
if (spStart >= 0 && spEnd > spStart) {
  for (const m of installJs.slice(spStart, spEnd).matchAll(/canonical:\s*'(hyperglob\.[a-z0-9.-]+\.node)'/g)) {
    installCanonicals.add(m[1]);
  }
}

// --- cross-checks ----------------------------------------------------------
const tables = {
  'scripts/install.js SUPPORTED_PLATFORMS': installTargets,
  'scripts/build-native.mjs TARGET_ASSETS': buildTargets,
};

for (const [label, set] of Object.entries(tables)) {
  for (const target of releaseTargets) {
    if (!set.has(target)) {
      problems.push(
        '.github/workflows/release.yml builds "' + target + '" but ' + label +
        ' does not know about it.'
      );
    }
  }
  for (const target of set) {
    if (!releaseTargets.has(target)) {
      problems.push(
        label + ' knows about "' + target + '" but .github/workflows/release.yml does not build it.'
      );
    }
  }
}

for (const asset of indexAssets) {
  if (!installCanonicals.has(asset)) {
    problems.push(
      'index.js loads "' + asset + '" but scripts/install.js does not install it.'
    );
  }
}
for (const asset of installCanonicals) {
  if (!indexAssets.has(asset)) {
    problems.push(
      'scripts/install.js installs "' + asset + '" but index.js does not load it.'
    );
  }
}

// Every target must map to a distinct release asset name, otherwise the
// release upload would silently overwrite one binary with another.
const releaseAssets = new Map();
if (spStart >= 0 && spEnd > spStart) {
  const block = installJs.slice(spStart, spEnd);
  for (const m of block.matchAll(/'([a-z0-9-]+)':\s*\{[^}]*release:\s*'(hyperglob\.[a-z0-9.-]+\.node)'/gs)) {
    releaseAssets.set(m[1], m[2]);
  }
}
const seenAssets = new Map();
for (const [target, asset] of releaseAssets) {
  if (seenAssets.has(asset)) {
    problems.push(
      'targets "' + seenAssets.get(asset) + '" and "' + target + '" both publish "' + asset + '".'
    );
  }
  seenAssets.set(asset, target);
}

// --- report ---------------------------------------------------------------
if (problems.length) {
  console.error('check-platforms: platform tables are out of sync:');
  for (const p of problems) console.error('  - ' + p);
  console.error('\nrelease.yml matrix: ' + [...releaseTargets].sort().join(', '));
  console.error('install.js:       ' + [...installTargets].sort().join(', '));
  console.error('build-native.mjs: ' + [...buildTargets].sort().join(', '));
  console.error('index.js assets:  ' + [...indexAssets].sort().join(', '));
  process.exit(1);
}

console.log(
  'check-platforms: OK -- ' + releaseTargets.size + ' platform target(s) consistent across ' +
  'release.yml, install.js, build-native.mjs and index.js: ' +
  [...releaseTargets].sort().join(', ')
);
