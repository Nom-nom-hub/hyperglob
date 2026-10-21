'use strict';

// Regression test: the MCP per-call timeout resolution must respect the
// server's configured default.
//
// Regression: resolveTimeoutMs(undefined) used to return the hard-coded
// 60s constant, so a server started with --timeout-ms 300000 (or
// HYPERGLOB_MCP_TIMEOUT_MS=300000) still timed every call out at 60s.
// The per-call argument worked; the process-level configuration did not.

const test = require('node:test');
const assert = require('node:assert/strict');

const mcp = require('../mcp.js');

test('resolveTimeoutMs uses the runner default when no per-call value is given', () => {
  const { resolveTimeoutMs, DEFAULT_TIMEOUT_MS } = mcp;
  // No argument at all: the built-in default.
  assert.equal(resolveTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs(null), DEFAULT_TIMEOUT_MS);

  // A configured default must be honoured.
  assert.equal(resolveTimeoutMs(undefined, 300000), 300000);
  assert.equal(resolveTimeoutMs(null, 300000), 300000);

  // A per-call value always wins over the default.
  assert.equal(resolveTimeoutMs(5000, 300000), 5000);
  assert.equal(resolveTimeoutMs(5000, DEFAULT_TIMEOUT_MS), 5000);
});

test('resolveTimeoutMs clamps to the supported range', () => {
  const { resolveTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS } = mcp;
  // Below the floor.
  assert.equal(resolveTimeoutMs(1), MIN_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs(-10000), MIN_TIMEOUT_MS);
  // Above the ceiling.
  assert.equal(resolveTimeoutMs(99999999), MAX_TIMEOUT_MS);
  // The default is clamped too.
  assert.equal(resolveTimeoutMs(undefined, 1), MIN_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs(undefined, 99999999), MAX_TIMEOUT_MS);
});

test('a runner configured with a longer timeout uses it for a bare call', async () => {
  const { ToolRunner } = mcp;
  const runner = new ToolRunner({
    useWorker: false,
    timeoutMs: 300000,
  });
  try {
    // The runner's own default is what a call with no timeoutMs should get.
    assert.equal(runner.timeoutMs, 300000);

    // And a real call succeeds under it.
    const res = await runner.run(
      { op: 'query', args: { pattern: '*.mjs' } },
      mcp.resolveTimeoutMs(undefined, runner.timeoutMs)
    );
    assert.equal(res.ok, true, res.error);
  } finally {
    try { runner.close(); } catch (_) { /* already closed */ }
  }
});
