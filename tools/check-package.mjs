#!/usr/bin/env node
// Verify that the published npm tarball is actually usable.
//
// Runs `npm pack --dry-run --json` and asserts:
//   * every runtime file the package requires is in the tarball
//   * the tarball contains no self-dependency
//   * the `exports` map lists "types" first and both import/require resolve
//   * the Rust sources needed for the documented `npm run build` fallback ship
//
// See docs/PACKAGING_AUDIT.md F9. Exits non-zero on any failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const problems = [];

/**
 * Run `npm pack --dry-run --json` and return the parsed result.
 *
 * npm is invoked as `node <npm-cli.js>` rather than via the `npm`/`npm.cmd`
 * shim: a .cmd cannot be spawned directly on Windows without a shell, and
 * going through a shell breaks in sandboxes that forbid piped stdio.
 *
 * Both stdout and stderr are captured through temporary files rather than
 * pipes for the same reason.
 */
function npmPackJson() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-pack-'));
  const outFile = path.join(tmpDir, 'pack.json');
  const errFile = path.join(tmpDir, 'pack.err');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  try {
    const npmCli = findNpmCli();
    const res = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
      cwd: root,
      stdio: ['ignore', outFd, errFd],
      encoding: 'utf8',
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(
        'npm pack exited with ' + res.status + ': ' + fs.readFileSync(errFile, 'utf8')
      );
    }
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/** Locate npm's CLI entry point (npm/bin/npm-cli.js). */
function findNpmCli() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  // node.exe lives in <prefix>/; npm ships in <prefix>/node_modules/npm.
  const prefix = path.dirname(process.execPath);
  candidates.push(path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  // A global install: <prefix>/lib/node_modules/npm/bin/npm-cli.js
  candidates.push(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.push(path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // Fall back to whatever `npm` resolves to, converting npm.cmd -> npm-cli.js.
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['npm'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (!which.error && which.stdout) {
    for (const first of which.stdout.split(/\r?\n/).filter(Boolean)) {
      const guess = path.join(path.dirname(first), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (fs.existsSync(guess)) return guess;
    }
  }
  throw new Error('could not locate the npm CLI entry point');
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// --- 1. no self-dependency -------------------------------------------------
if (pkg.dependencies && pkg.dependencies[pkg.name]) {
  problems.push('package.json depends on itself: "' + pkg.name + '": "' + pkg.dependencies[pkg.name] + '"');
}
if (pkg.devDependencies && pkg.devDependencies[pkg.name]) {
  problems.push('package.json devDepends on itself: "' + pkg.name + '"');
}

// --- 2. exports map --------------------------------------------------------
const dot = pkg.exports && pkg.exports['.'];
if (!dot) {
  problems.push('package.json has no "exports" entry for "."');
} else {
  const keys = Object.keys(dot);
  if (keys[0] !== 'types') {
    problems.push('package.json "exports" must list "types" first (got: ' + keys.join(', ') + ')');
  }
  for (const required of ['types', 'import', 'require']) {
    if (!dot[required]) problems.push('package.json "exports" is missing the "' + required + '" condition');
  }
  for (const [cond, target] of Object.entries(dot)) {
    if (!fs.existsSync(path.join(root, target))) {
      problems.push('package.json "exports".' + cond + ' points at a missing file: ' + target);
    }
  }
}

// --- 3. tarball contents ---------------------------------------------------
let tarballFiles = [];
try {
  const parsed = npmPackJson();
  tarballFiles = parsed[0].files.map((f) => f.path);
} catch (e) {
  console.error('check-package: npm pack failed: ' + e.message);
  process.exit(1);
}

const requiredFiles = [
  'index.js',
  'index.mjs',
  'index.d.ts',
  'cli.js',
  'mcp.js',
  'scripts/install.js',
  'scripts/native-integrity.js',
  'Cargo.toml',
  'build.rs',
  'package.json',
  'README.md',
  'LICENSE',
];
for (const f of requiredFiles) {
  if (!tarballFiles.includes(f)) problems.push('tarball is missing ' + f);
}

// The Rust sources must ship so the documented `npm run build` fallback works
// for consumers who cannot get a prebuilt binary.
if (!tarballFiles.some((f) => f.startsWith('src/'))) {
  problems.push('tarball does not contain src/ -- the "npm run build" fallback would not work');
}

// The built binary for the current platform should be present, since `files`
// now includes hyperglob.*.node.
const hostAsset =
  process.platform === 'win32' ? 'hyperglob.win32-x64-msvc.node'
  : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'hyperglob.darwin-arm64.node' : 'hyperglob.darwin-x64.node')
  : (process.arch === 'arm64' ? 'hyperglob.linux-arm64-gnu.node' : 'hyperglob.linux-x64-gnu.node');
if (fs.existsSync(path.join(root, hostAsset)) && !tarballFiles.includes(hostAsset)) {
  problems.push('tarball is missing the built binary ' + hostAsset);
}

// --- 4. the tarball must not be empty ---------------------------------------
if (tarballFiles.length === 0) problems.push('tarball is empty');

// --- report ----------------------------------------------------------------
if (problems.length) {
  console.error('check-package: the published tarball has problems:');
  for (const p of problems) console.error('  - ' + p);
  console.error('\ntarball contents:\n  ' + tarballFiles.join('\n  '));
  process.exit(1);
}

console.log(
  'check-package: OK -- ' + tarballFiles.length + ' files in the tarball, ' +
  'no self-dependency, exports map well-formed.'
);
