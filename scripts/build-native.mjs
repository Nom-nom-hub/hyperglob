#!/usr/bin/env node
// Build the Rust core with cargo and stage the cdylib as a .node addon.
//
// The npm package version (package.json) is the single source of truth for the
// version reported by the native `version()` function. It is passed to cargo
// as HYPERGLOB_VERSION; build.rs re-exports it to the crate as a compile-time
// constant. See docs/PACKAGING_AUDIT.md (F8).
//
// Usage:
//   node scripts/build-native.mjs [--debug] [--target <cargo-triple>] [--release-name]
//
// With --target the build is cross-compiled for that triple (e.g.
// x86_64-apple-darwin -> hyperglob.darwin-x64.node). Without --target the
// host platform is used.
//
// By default the binary is staged under its *canonical* name, which is what
// index.js loads at runtime. With --release-name it is staged under the
// GitHub release asset name instead -- the two differ for the musl targets,
// whose release asset is "...-musl.node" but whose canonical runtime name is
// still "...-gnu.node". The release workflow uses this flag.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const debug = argv.includes('--debug');
const profile = debug ? 'debug' : 'release';

const targetIndex = argv.indexOf('--target');
const triple = targetIndex >= 0 ? argv[targetIndex + 1] : null;
const releaseName = argv.includes('--release-name');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const cargoHome = path.join(os.homedir(), '.cargo', 'bin');
const cargo = fs.existsSync(path.join(cargoHome, 'cargo'))
  ? path.join(cargoHome, 'cargo')
  : 'cargo';

const args = ['build', '--lib'];
if (!debug) args.push('--release');
if (triple) args.push('--target', triple);
execFileSync(cargo, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, HYPERGLOB_VERSION: version },
});

// cargo triple -> release-matrix target name.
// MUST stay in sync with the release matrix in .github/workflows/release.yml
// and with SUPPORTED_PLATFORMS in scripts/install.js and index.js.
// `tools/check-platforms.mjs` (run by ci.yml) fails the build if they drift.
const TRIPLE_TARGETS = {
  'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
  'aarch64-unknown-linux-gnu': 'linux-arm64-gnu',
  'x86_64-unknown-linux-musl': 'linux-x64-musl',
  'aarch64-unknown-linux-musl': 'linux-arm64-musl',
  'x86_64-apple-darwin': 'darwin-x64',
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-pc-windows-msvc': 'win32-x64-msvc',
};

// Release-matrix target name -> the file name the binary is staged under.
//
//   canonical -- what index.js loads at runtime
//   release   -- the GitHub release asset name
//
// They differ for the musl targets: the release asset is "...-musl.node",
// while the canonical runtime name stays "...-gnu.node" because index.js
// (owned by another agent) looks the addon up by a fixed name.
const TARGET_ASSETS = {
  'linux-x64-gnu': {
    canonical: 'hyperglob.linux-x64-gnu.node',
    release: 'hyperglob.linux-x64-gnu.node',
  },
  'linux-arm64-gnu': {
    canonical: 'hyperglob.linux-arm64-gnu.node',
    release: 'hyperglob.linux-arm64-gnu.node',
  },
  'linux-x64-musl': {
    canonical: 'hyperglob.linux-x64-gnu.node',
    release: 'hyperglob.linux-x64-musl.node',
  },
  'linux-arm64-musl': {
    canonical: 'hyperglob.linux-arm64-gnu.node',
    release: 'hyperglob.linux-arm64-musl.node',
  },
  'darwin-x64': {
    canonical: 'hyperglob.darwin-x64.node',
    release: 'hyperglob.darwin-x64.node',
  },
  'darwin-arm64': {
    canonical: 'hyperglob.darwin-arm64.node',
    release: 'hyperglob.darwin-arm64.node',
  },
  'win32-x64-msvc': {
    canonical: 'hyperglob.win32-x64-msvc.node',
    release: 'hyperglob.win32-x64-msvc.node',
  },
};

// Platform/arch -> release-matrix target name for the *host* build.
const HOST_TARGETS = {
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'win32-x64-msvc',
};

function artifactName() {
  if (process.platform === 'win32') return 'hyperglob.dll';
  if (process.platform === 'darwin') return 'libhyperglob.dylib';
  return 'libhyperglob.so';
}

function targetName() {
  if (triple) {
    const target = TRIPLE_TARGETS[triple];
    if (!target) {
      throw new Error(
        'unsupported cargo target ' + triple + '. ' +
        'Supported: ' + Object.keys(TRIPLE_TARGETS).join(', ')
      );
    }
    return releaseName ? TARGET_ASSETS[target].release : TARGET_ASSETS[target].canonical;
  }
  const { platform, arch } = process;
  const target = HOST_TARGETS[platform + '-' + arch];
  if (!target) {
    throw new Error(
      `unsupported platform ${platform}-${arch}. ` +
      `Supported: ${Object.keys(HOST_TARGETS).join(', ')}.`
    );
  }
  return releaseName ? TARGET_ASSETS[target].release : TARGET_ASSETS[target].canonical;
}

// With --target cargo writes into target/<triple>/<profile>/, otherwise
// target/<profile>/.
const outDir = triple ? path.join(root, 'target', triple, profile) : path.join(root, 'target', profile);
const src = path.join(outDir, artifactName());
const dest = path.join(root, targetName());

if (!fs.existsSync(src)) {
  throw new Error('cargo did not produce ' + src);
}
try {
  fs.copyFileSync(src, dest);
} catch (error) {
  // On Windows a loaded native module cannot be overwritten. The usual
  // culprit is a running hyperglob MCP server, which holds the binding
  // open for its whole lifetime. Say so plainly instead of surfacing a
  // bare EBUSY.
  if (error.code === 'EBUSY' || error.code === 'EPERM') {
    throw new Error(
      `could not replace ${path.basename(dest)}: the file is in use.\n` +
        'A running hyperglob MCP server keeps the native binding open, so it\n' +
        'has to be stopped before the binding can be replaced. Stop the agent\n' +
        '(or the MCP server) and run this command again.'
    );
  }
  throw error;
}
console.log(
  `hyperglob: staged ${path.basename(dest)}` +
  (triple ? ` (cross-compiled for ${triple})` : '') +
  ` (version ${version})`
);
