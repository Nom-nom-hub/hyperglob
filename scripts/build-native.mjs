#!/usr/bin/env node
// Build the Rust core with cargo and stage the cdylib as a .node addon.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const debug = process.argv.includes('--debug');
const profile = debug ? 'debug' : 'release';

const cargoHome = path.join(os.homedir(), '.cargo', 'bin');
const cargo = fs.existsSync(path.join(cargoHome, 'cargo'))
  ? path.join(cargoHome, 'cargo')
  : 'cargo';

const args = ['build', '--lib'];
if (!debug) args.push('--release');
execFileSync(cargo, args, { cwd: root, stdio: 'inherit' });

function artifactName() {
  if (process.platform === 'win32') return 'hyperglob.dll';
  if (process.platform === 'darwin') return 'libhyperglob.dylib';
  return 'libhyperglob.so';
}

function targetName() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return 'hyperglob.linux-x64-gnu.node';
  if (platform === 'linux' && arch === 'arm64') return 'hyperglob.linux-arm64-gnu.node';
  if (platform === 'darwin' && arch === 'x64') return 'hyperglob.darwin-x64.node';
  if (platform === 'darwin' && arch === 'arm64') return 'hyperglob.darwin-arm64.node';
  if (platform === 'win32' && arch === 'x64') return 'hyperglob.win32-x64-msvc.node';
  throw new Error(`unsupported platform ${platform}-${arch}`);
}

const src = path.join(root, 'target', profile, artifactName());
const dest = path.join(root, targetName());
fs.copyFileSync(src, dest);
console.log(`hyperglob: staged ${path.basename(dest)}`);
