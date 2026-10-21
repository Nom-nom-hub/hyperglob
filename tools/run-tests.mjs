#!/usr/bin/env node
// Run the Node test suite in a way that works on every supported Node version.
//
// The suite needs `--experimental-test-isolation=none`: two of the tests
// spawn the MCP server as a child process and talk to it over stdio, and
// Node's default per-file process isolation would tear the child down
// before the handshake completes.
//
// That flag only exists on Node 22.8 and newer. On Node 18 and 20 -- both
// of which this package claims to support -- passing it makes node exit
// with "bad option" and the whole suite fails before a single test runs.
//
// So: probe for the flag and use it only when it is accepted. On older
// Node the suite still runs, in separate processes per file, which is
// exactly the default behaviour the flag was asking for.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEST_DIR = path.join(ROOT, 'tests');

/**
 * Collect the test files.
 *
 * Node 22+ expands a glob pattern passed to `--test`; Node 18 and 20 do
 * not, and fail with "Could not find '.../tests/*.test.js'". So the file
 * list is always built here, and the runner is given explicit paths.
 */
function testFiles() {
  if (!fs.existsSync(TEST_DIR)) {
    console.error(`[run-tests] no tests directory at ${TEST_DIR}`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join(TEST_DIR, f));
  if (!files.length) {
    console.error('[run-tests] no test files found');
    process.exit(1);
  }
  return files;
}

function hasFlag(flag) {
  // allowedNodeEnvironmentFlags is a Set on every Node version that has it
  // (10+), listing every flag the current binary accepts.
  const allowed = process.allowedNodeEnvironmentFlags;
  if (!allowed) return false;
  if (typeof allowed.has === 'function') return allowed.has(flag);
  if (Array.isArray(allowed)) return allowed.includes(flag);
  return false;
}

const ISOLATION_FLAG = '--experimental-test-isolation=none';
const useIsolation = hasFlag(ISOLATION_FLAG);

const args = ['--test'];
if (useIsolation) args.push(ISOLATION_FLAG);
args.push(...testFiles());

if (!useIsolation) {
  console.log(
    `[run-tests] Node ${process.version} does not accept ${ISOLATION_FLAG}; ` +
      'running each test file in its own process (the default).'
  );
}

const child = spawn(process.execPath, args, {
  cwd: ROOT,
  stdio: 'inherit',
  shell: false,
});

child.on('error', (err) => {
  console.error('[run-tests] could not start node:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[run-tests] the test runner was killed by ${signal}`);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});
