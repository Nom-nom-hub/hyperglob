'use strict';
// Tests for the test runner shim (tools/run-tests.mjs).
//
// The suite needs --experimental-test-isolation=none, but that flag only
// exists on Node 22.8+. On Node 18 and 20 -- both supported -- passing it
// makes node exit with "bad option" and the whole suite fails before a
// single test runs.
//
// These tests pin the detection logic, because a regression here is
// invisible until CI breaks on an older Node.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const runner = fs.readFileSync(path.join(ROOT, 'tools', 'run-tests.mjs'), 'utf8');

test('the runner exists and is wired into the test script', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'run-tests.mjs')));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(
    pkg.scripts.test.includes('run-tests.mjs'),
    'the test script should call the runner, not node --test directly'
  );
});

test('the runner does not hard-code the isolation flag', () => {
  // It must never be passed unconditionally.
  const unconditional = /args\.push\(\s*ISOLATION_FLAG\s*\)/.test(runner);
  assert.ok(
    !unconditional ||
      /if \(useIsolation\)\s*args\.push\(ISOLATION_FLAG\)/.test(runner),
    'the isolation flag must only be passed when the runtime supports it'
  );
  assert.ok(
    /useIsolation/.test(runner),
    'the runner must gate the flag on a capability check'
  );
});

test('the flag detection handles both a Set and an Array', () => {
  // process.allowedNodeEnvironmentFlags is a Set on every Node version
  // that has it. An implementation that only handled Array would silently
  // never find the flag, and the suite would fall back to per-file
  // isolation on every Node -- including the ones that support it.
  assert.ok(/allowed\.has\(flag\)/.test(runner), 'must use .has() for the Set case');
  assert.ok(/Array\.isArray\(allowed\)/.test(runner), 'must also handle the Array case');
});

test('the detection agrees with the running Node', () => {
  // The runner's own logic, applied to this process, must match reality:
  // if this Node accepts the flag, the check must say so.
  const allowed = process.allowedNodeEnvironmentFlags;
  const has = (flag) => {
    if (!allowed) return false;
    if (typeof allowed.has === 'function') return allowed.has(flag);
    if (Array.isArray(allowed)) return allowed.includes(flag);
    return false;
  };
  const claimed = has('--experimental-test-isolation=none');
  const real = process.allowedNodeEnvironmentFlags
    ? process.allowedNodeEnvironmentFlags.has('--experimental-test-isolation=none')
    : false;
  assert.equal(claimed, real);
});

test('the runner collects test files itself', () => {
  // Node 18 and 20 do not expand a glob passed to `--test` and fail with
  // "Could not find '.../tests/*.test.js'". The runner must therefore
  // enumerate the files and pass explicit paths.
  assert.ok(
    /\.test\.js/.test(runner),
    'the runner must select .test.js files'
  );
  assert.ok(
    /readdirSync/.test(runner),
    'the runner must enumerate the tests directory itself'
  );
  assert.ok(
    !/args\.push\(['"]tests\/\*\.test\.js['"]\)/.test(runner),
    'the runner must not pass a glob pattern to node --test'
  );
});

test('the MCP stdio tests live in their own file', () => {
  // They are the only tests that spawn a *long-lived* child process and
  // talk to it. Where spawn() is forbidden, a blocked spawn aborts the
  // whole test file, so they must be isolated from the other assertions.
  assert.ok(
    fs.existsSync(path.join(ROOT, 'tests', 'mcp-stdio.test.js')),
    'tests/mcp-stdio.test.js should exist'
  );
  const stdio = fs.readFileSync(path.join(ROOT, 'tests', 'mcp-stdio.test.js'), 'utf8');
  assert.ok(/spawn\(/.test(stdio), 'the stdio file should spawn the server');

  // No other test file may spawn a long-lived child it then talks to.
  // (A spy that replaces execFileSync, or a one-shot execFileSync call,
  // is fine -- those fail on their own without taking the file down.)
  const others = fs
    .readdirSync(path.join(ROOT, 'tests'))
    .filter((f) => f.endsWith('.test.js') && f !== 'mcp-stdio.test.js');
  for (const f of others) {
    const text = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8');
    const realSpawn = /(?<![.\w])spawn\s*\(\s*process\.execPath/.test(text);
    assert.ok(!realSpawn, `${f} should not spawn a long-lived child process`);
  }
});
