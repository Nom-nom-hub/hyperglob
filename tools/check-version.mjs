#!/usr/bin/env node
// Fail the build if the npm package version and the crate version diverge.
//
// The npm package version (package.json) is the single source of truth for the
// version reported by the native `version()` function. Cargo.toml is kept in
// sync so that a plain `cargo build` (without the npm build script, which
// injects HYPERGLOB_VERSION) also reports the same version.
//
// See docs/PACKAGING_AUDIT.md F8. Exits non-zero on mismatch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const pkg = JSON.parse(read('package.json'));
const cargoToml = read('Cargo.toml');

const m = cargoToml.match(/^\s*version\s*=\s*"([^"]+)"/m);
if (!m) {
  console.error('check-version: could not find a version in Cargo.toml');
  process.exit(1);
}
const cargoVersion = m[1];

if (pkg.version !== cargoVersion) {
  console.error(
    'check-version: version mismatch -- package.json says ' + pkg.version +
    ', Cargo.toml says ' + cargoVersion + '.'
  );
  console.error('  The npm package version is the source of truth; update Cargo.toml.');
  process.exit(1);
}

console.log('check-version: OK -- package.json and Cargo.toml both say ' + pkg.version);
