#!/usr/bin/env node
// Verify that a staged .node binary is a plausible native addon for the
// platform it claims to target.
//
// Usage:
//   node tools/verify-native.mjs [file...]
//
// With no arguments it verifies every hyperglob.*.node in the repo root.
// Exits non-zero if any file fails validation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { assertValidNativeBinary } = require(path.join(root, 'scripts', 'native-integrity.js'));

// Asset name -> the platform whose magic bytes it must carry.
const ASSET_PLATFORM = {
  'hyperglob.win32-x64-msvc.node': 'win32',
  'hyperglob.linux-x64-gnu.node': 'linux',
  'hyperglob.linux-arm64-gnu.node': 'linux',
  'hyperglob.linux-x64-musl.node': 'linux',
  'hyperglob.linux-arm64-musl.node': 'linux',
  'hyperglob.darwin-x64.node': 'darwin',
  'hyperglob.darwin-arm64.node': 'darwin',
};

let files = process.argv.slice(2);
if (files.length === 0) {
  files = fs
    .readdirSync(root)
    .filter((f) => /^hyperglob\..*\.node$/.test(f))
    .map((f) => path.join(root, f));
}

if (files.length === 0) {
  console.error('verify-native: no .node files to verify');
  process.exit(1);
}

let failed = false;
for (const file of files) {
  const base = path.basename(file);
  const platform = ASSET_PLATFORM[base] || process.platform;
  const result = assertValidNativeBinary(file, { platform });
  if (result.ok) {
    console.log('verify-native: OK  ' + base + ' (' + platform + ', ' + fs.statSync(file).size + ' bytes)');
  } else {
    failed = true;
    console.error('verify-native: FAIL ' + base + ' (' + platform + '): ' + result.reason);
  }
}

process.exit(failed ? 1 : 0);
