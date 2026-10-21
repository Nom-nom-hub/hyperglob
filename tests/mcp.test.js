'use strict';
// Tests for the hyperglob MCP server (mcp.js).
//
// The server is driven in-process: mcp.js exports `handle`, `TOOLS` and
// `ToolRunner`, so no child process is needed (the test sandbox denies
// spawn()).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mcp = require('../mcp.js');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const FIXTURE = { dir: null };

/**
 * A private fixture directory per test file. The test runner may share one
 * process across files, so a module-level `root` could be clobbered by
 * another file's setup — keep it inside an object owned by this module.
 */
function mkFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-mcp-test-'));
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'deep', 'nested.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(dir, 'src', 'other.ts'), 'export const c = 3;\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}\n');
  FIXTURE.dir = dir;
  return dir;
}

/** The fixture root of *this* file. */
function root() {
  return FIXTURE.dir;
}

test.before(() => { mkFixture(); });
test.after(() => { fs.rmSync(FIXTURE.dir, { recursive: true, force: true }); });

/** Call the server with a fresh (non-worker) runner so tests stay fast. */
async function call(method, params, id = 1) {
  const runner = new mcp.ToolRunner({ useWorker: false });
  try {
    return await mcp.handle({ jsonrpc: '2.0', id, method, params }, { runner });
  } finally {
    runner.close();
  }
}

/** Call a tool and return the raw result object. */
async function callTool(name, args) {
  const res = await call('tools/call', { name, arguments: args });
  assert.ok(res.result, `expected a tool result, got ${JSON.stringify(res)}`);
  return res.result;
}

function textOf(result) {
  return result.content[0].text;
}

// ---------------------------------------------------------------------------
// item 1: isDirectory -> isDir
// ---------------------------------------------------------------------------

test('query entries expose isDir (not isDirectory)', async () => {
  const result = await callTool('hyperglob_query', { pattern: 'src/**/*.ts', cwd: root() });
  assert.ok(!result.isError, `unexpected error: ${textOf(result)}`);
  const payload = JSON.parse(textOf(result));
  assert.ok(Array.isArray(payload.entries));
  assert.ok(payload.entries.length >= 3);
  for (const e of payload.entries) {
    assert.ok('isDir' in e, 'entry must have isDir');
    assert.ok(!('isDirectory' in e), 'entry must NOT have isDirectory');
    assert.equal(typeof e.isDir, 'boolean');
    assert.equal(typeof e.isFile, 'boolean');
  }
  // Sanity: the fixture files are files, not directories.
  const idx = payload.entries.find((e) => e.relativePath === 'src/index.ts');
  assert.ok(idx, 'src/index.ts should be present');
  assert.equal(idx.isFile, true);
  assert.equal(idx.isDir, false);
});

// ---------------------------------------------------------------------------
// item 2: JSON output shape + resilience
// ---------------------------------------------------------------------------

test('query returns a counted, paged payload shape', async () => {
  const result = await callTool('hyperglob_query', { pattern: 'src/**/*.ts', cwd: root() });
  const payload = JSON.parse(textOf(result));
  assert.equal(typeof payload.count, 'number');
  assert.equal(typeof payload.total, 'number');
  assert.equal(typeof payload.truncated, 'boolean');
  assert.equal(typeof payload.offset, 'number');
  assert.equal(typeof payload.limit, 'number');
  assert.equal(payload.count, payload.entries.length);
  assert.equal(payload.total, payload.count);
  assert.equal(payload.truncated, false);
});

test('query honors limit/offset paging and reports truncation', async () => {
  const all = JSON.parse(textOf(await callTool('hyperglob_query', { pattern: 'src/**/*.ts', cwd: root() })));
  const page1 = JSON.parse(
    textOf(await callTool('hyperglob_query', { pattern: 'src/**/*.ts', cwd: root(), limit: 1 }))
  );
  assert.equal(page1.count, 1);
  assert.equal(page1.total, all.total);
  assert.equal(page1.truncated, all.total > 1);
  assert.equal(page1.entries[0].relativePath, all.entries[0].relativePath);

  const page2 = JSON.parse(
    textOf(await callTool('hyperglob_query', { pattern: 'src/**/*.ts', cwd: root(), limit: 1, offset: 1 }))
  );
  assert.equal(page2.count, 1);
  assert.equal(page2.offset, 1);
  assert.equal(page2.entries[0].relativePath, all.entries[1].relativePath);
});

test('query returns an empty, well-formed payload when nothing matches', async () => {
  const payload = JSON.parse(
    textOf(await callTool('hyperglob_query', { pattern: 'src/**/*.zzz', cwd: root() }))
  );
  assert.deepEqual(payload.entries, []);
  assert.equal(payload.count, 0);
  assert.equal(payload.total, 0);
  assert.equal(payload.truncated, false);
});

// ---------------------------------------------------------------------------
// item 2: option plumbing (dot / gitignore / ignore / onlyFiles)
// ---------------------------------------------------------------------------

test('query honors onlyFiles:false to include directories', async () => {
  const payload = JSON.parse(
    textOf(await callTool('hyperglob_query', { pattern: 'src/**', cwd: root(), onlyFiles: false }))
  );
  const dirs = payload.entries.filter((e) => e.isDir);
  assert.ok(dirs.length > 0, 'expected directory entries');
  assert.ok(dirs.some((d) => d.relativePath === 'src' || d.relativePath === 'src/deep'));
});

test('query honors the ignore option', async () => {
  const payload = JSON.parse(
    textOf(await callTool('hyperglob_query', { pattern: 'src/**/*.ts', cwd: root(), ignore: ['**/deep/**'] }))
  );
  assert.ok(payload.entries.every((e) => !e.relativePath.startsWith('src/deep/')));
});

test('query honors the dot option', async () => {
  fs.writeFileSync(path.join(root(), 'src', '.hidden.ts'), 'export const h = 1;\n');
  try {
    const without = JSON.parse(
      textOf(await callTool('hyperglob_query', { pattern: 'src/**', cwd: root() }))
    );
    assert.ok(!without.entries.some((e) => e.relativePath.includes('.hidden')));
    const withDot = JSON.parse(
      textOf(await callTool('hyperglob_query', { pattern: 'src/**', cwd: root(), dot: true }))
    );
    assert.ok(withDot.entries.some((e) => e.relativePath.includes('.hidden')));
  } finally {
    fs.rmSync(path.join(root(), 'src', '.hidden.ts'), { force: true });
  }
});

test('query honors gitignore:false', async () => {
  fs.writeFileSync(path.join(root(), '.gitignore'), 'src/other.ts\n');
  try {
    const obeyed = JSON.parse(
      textOf(await callTool('hyperglob_query', { pattern: 'src/**/*.ts', cwd: root() }))
    );
    assert.ok(!obeyed.entries.some((e) => e.relativePath === 'src/other.ts'));
    const ignored = JSON.parse(
      textOf(await callTool('hyperglob_query', { pattern: 'src/**/*.ts', cwd: root(), gitignore: false }))
    );
    assert.ok(ignored.entries.some((e) => e.relativePath === 'src/other.ts'));
  } finally {
    fs.rmSync(path.join(root(), '.gitignore'), { force: true });
  }
});

test('tool schemas expose the documented options', () => {
  for (const tool of mcp.TOOLS) {
    assert.equal(tool.inputSchema.type, 'object');
    const props = tool.inputSchema.properties;
    assert.ok(props.cwd, `${tool.name} must expose cwd`);
    assert.ok(props.dot, `${tool.name} must expose dot`);
    assert.ok(props.gitignore, `${tool.name} must expose gitignore`);
    assert.ok(props.ignore, `${tool.name} must expose ignore`);
    assert.equal(props.ignore.type, 'array');
    assert.ok(props.limit, `${tool.name} must expose limit`);
    assert.ok(props.timeoutMs, `${tool.name} must expose timeoutMs`);
  }
  const query = mcp.TOOLS.find((t) => t.name === 'hyperglob_query');
  assert.ok(query.inputSchema.properties.pattern);
  assert.ok(query.inputSchema.properties.onlyFiles);
  assert.ok(query.inputSchema.properties.content);
  assert.ok(query.inputSchema.properties.index);
  const paths = mcp.TOOLS.find((t) => t.name === 'hyperglob_paths');
  assert.ok(paths.inputSchema.properties.pattern);
  const deps = mcp.TOOLS.find((t) => t.name === 'hyperglob_dependents');
  assert.ok(deps.inputSchema.properties.target);
  assert.ok(!deps.inputSchema.properties.pattern, 'dependents takes a target, not a pattern');
  assert.deepEqual(deps.inputSchema.required, ['target']);
  assert.deepEqual(query.inputSchema.required, ['pattern']);
});

// ---------------------------------------------------------------------------
// item 3: isError path for all three tools
// ---------------------------------------------------------------------------

test('invalid pattern yields isError, not a JSON-RPC error', async () => {
  const res = await call('tools/call', {
    name: 'hyperglob_query',
    arguments: { pattern: 'src/**/*.ts :bogus(1)', cwd: root() },
  });
  assert.ok(res.result, 'must be a tool result');
  assert.equal(res.result.isError, true);
  assert.match(textOf(res.result), /unknown selector/i);
  assert.ok(!res.error, 'must not be a JSON-RPC error');
});

test('malformed glob yields isError with a helpful message', async () => {
  const res = await call('tools/call', {
    name: 'hyperglob_query',
    arguments: { pattern: 'src/[[[', cwd: root() },
  });
  assert.equal(res.result.isError, true);
  assert.match(textOf(res.result), /glob/i);
});

test('missing walk root yields isError', async () => {
  const res = await call('tools/call', {
    name: 'hyperglob_query',
    arguments: { pattern: '**/*.ts', cwd: path.join(root(), 'does-not-exist') },
  });
  assert.equal(res.result.isError, true);
  assert.match(textOf(res.result), /does not exist|not found/i);
});

test('dependents with a missing target yields isError', async () => {
  const res = await call('tools/call', {
    name: 'hyperglob_dependents',
    arguments: { target: 'nope.ts', cwd: root() },
  });
  assert.equal(res.result.isError, true);
  assert.match(textOf(res.result), /not found/i);
});

test('paths tool with an invalid pattern yields isError', async () => {
  const res = await call('tools/call', {
    name: 'hyperglob_paths',
    arguments: { pattern: 'src/**/*.ts :bogus(1)', cwd: root() },
  });
  assert.equal(res.result.isError, true);
  assert.match(textOf(res.result), /unknown selector/i);
});

test('invalid arguments are rejected as invalid params (not a crash)', async () => {
  const noPattern = await call('tools/call', { name: 'hyperglob_query', arguments: {} });
  assert.equal(noPattern.error.code, -32602);
  assert.match(noPattern.error.message, /pattern/);

  const noTarget = await call('tools/call', { name: 'hyperglob_dependents', arguments: {} });
  assert.equal(noTarget.error.code, -32602);
  assert.match(noTarget.error.message, /target/);

  const badDepth = await call('tools/call', {
    name: 'hyperglob_query',
    arguments: { pattern: '**/*.ts', cwd: root(), maxDepth: -1 },
  });
  assert.equal(badDepth.error.code, -32602);

  const badLimit = await call('tools/call', {
    name: 'hyperglob_query',
    arguments: { pattern: '**/*.ts', cwd: root(), limit: 0 },
  });
  assert.equal(badLimit.error.code, -32602);

  const unknownTool = await call('tools/call', { name: 'hyperglob_nope', arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  assert.match(unknownTool.error.message, /unknown tool/);
});

// ---------------------------------------------------------------------------
// item 3: timeout
// ---------------------------------------------------------------------------

test('a tool call that exceeds its timeout returns an error instead of hanging', async () => {
  // A runner that never answers models a wedged native call.
  const runner = new mcp.ToolRunner({ useWorker: false });
  runner.run = (job, timeoutMs) =>
    new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, error: `query timed out after ${timeoutMs}ms` }), timeoutMs);
    });
  const started = Date.now();
  const res = await mcp.handle(
    {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: {
        name: 'hyperglob_query',
        arguments: { pattern: '**/*.ts', cwd: root(), timeoutMs: 1000 },
      },
    },
    { runner }
  );
  const elapsed = Date.now() - started;
  assert.ok(res.result, 'must produce a tool result');
  assert.equal(res.result.isError, true);
  assert.match(textOf(res.result), /timed out/i);
  assert.ok(elapsed < 5000, `should not hang, took ${elapsed}ms`);
  runner.close();
});

test('ToolRunner reports an error for an unknown job op', async () => {
  const runner = new mcp.ToolRunner({ useWorker: false });
  const res = await runner.run({ op: 'nope', args: {} }, 5000);
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown job op/);
  runner.close();
});

test('ToolRunner runs a real job successfully', async () => {
  const runner = new mcp.ToolRunner({ useWorker: false, timeoutMs: 5000 });
  const res = await runner.run({ op: 'query', args: { pattern: 'src/**/*.ts', cwd: root() } }, 5000);
  assert.equal(res.ok, true);
  assert.ok(res.payload.entries.length >= 3);
  runner.close();
});

// ---------------------------------------------------------------------------
// item 4: stdout hygiene
// ---------------------------------------------------------------------------

test('mcp.js contains no console.log and writes to stdout only via the protocol sink', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
  assert.ok(!/console\.log\s*\(/.test(src), 'mcp.js must not call console.log');
  // Every process.stdout.write must be inside a guard (the raw writer is
  // captured once, the guard redirects, the worker guards its own copy).
  const writes = src.match(/process\.stdout\.write/g) || [];
  assert.ok(writes.length <= 4, `unexpected stdout writes: ${writes.length}`);
  // The protocol stream must be written through the sink, never through a
  // bare process.stdout.write.
  assert.ok(!/emitProtocol[\s\S]{0,200}?process\.stdout\.write\(text\)/.test(src));
});

test('the stdout guard redirects foreign writes to stderr', () => {
  const original = process.stdout.write;
  const origErr = process.stderr.write;
  let errText = '';
  let protocolText = '';
  process.stderr.write = (chunk) => {
    errText += String(chunk);
    return true;
  };
  const restore = mcp.setProtocolSink((t) => {
    protocolText += String(t);
    return true;
  });
  try {
    mcp.installStdoutGuard();
    process.stdout.write('foreign noise\n');
    assert.match(errText, /foreign noise/, 'foreign stdout writes must go to stderr');
    // The protocol writer must still reach the protocol stream.
    mcp.emitProtocol('{"jsonrpc":"2.0"}\n');
    assert.equal(protocolText, '{"jsonrpc":"2.0"}\n');
    assert.ok(!errText.includes('{"jsonrpc"'), 'protocol output must not be redirected');
  } finally {
    restore();
    process.stdout.write = original;
    process.stderr.write = origErr;
  }
});

test('the child-process guard replaces stdio:"inherit" so a child cannot write to stdout', () => {
  const cp = require('node:child_process');
  const original = cp.execFileSync;
  const calls = [];
  cp.execFileSync = function spy(...args) {
    calls.push(args);
    return Buffer.from('');
  };
  try {
    mcp.installChildProcessGuard();
    cp.execFileSync(process.execPath, ['some-script.js'], { stdio: 'inherit' });
    assert.equal(calls.length, 1);
    const opts = calls[0][2];
    assert.notEqual(opts.stdio, 'inherit', 'inherit must be replaced');
    assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'inherit']);
  } finally {
    cp.execFileSync = original;
  }
});

test('the child-process guard leaves other invocations untouched', () => {
  const cp = require('node:child_process');
  const original = cp.execFileSync;
  const calls = [];
  cp.execFileSync = function spy(...args) {
    calls.push(args);
    return Buffer.from('');
  };
  try {
    mcp.installChildProcessGuard();
    cp.execFileSync(process.execPath, ['some-script.js'], { stdio: 'pipe' });
    cp.execFileSync(process.execPath, ['some-script.js']);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0][2], { stdio: 'pipe' });
    assert.equal(calls[1][2], undefined);
  } finally {
    cp.execFileSync = original;
  }
});

// ---------------------------------------------------------------------------
// item 5: protocol handling
// ---------------------------------------------------------------------------

test('initialize advertises a protocol version and server info', async () => {
  const res = await call('initialize', { protocolVersion: '2024-11-05' }, 7);
  assert.equal(res.result.protocolVersion, '2024-11-05');
  assert.equal(res.result.serverInfo.name, 'hyperglob');
  assert.ok(res.result.serverInfo.version);
  assert.ok(res.result.capabilities.tools);
});

test('initialize echoes a supported newer protocol version', async () => {
  const res = await call('initialize', { protocolVersion: '2025-06-18' }, 8);
  assert.equal(res.result.protocolVersion, '2025-06-18');
});

test('initialize falls back to the default version for unknown requests', async () => {
  const res = await call('initialize', { protocolVersion: '1999-01-01' }, 9);
  assert.equal(res.result.protocolVersion, mcp.PROTOCOL_VERSION);
});

test('notifications are never answered', async () => {
  for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/progress']) {
    const res = await mcp.handle({ jsonrpc: '2.0', method, params: { requestId: 1 } });
    assert.equal(res, null, `${method} must not produce a response`);
  }
});

test('resources/list and prompts/list answer method-not-found instead of crashing', async () => {
  for (const method of ['resources/list', 'prompts/list', 'resources/templates/list']) {
    const res = await call(method, {}, 10);
    assert.ok(res.error, `${method} must produce an error`);
    assert.equal(res.error.code, -32601);
    assert.match(res.error.message, /method not found/);
  }
});

test('unknown methods with an id answer method-not-found', async () => {
  const res = await call('does/not/exist', {}, 11);
  assert.equal(res.error.code, -32601);
});

test('an unknown notification method is silently ignored', async () => {
  const res = await mcp.handle({ jsonrpc: '2.0', method: 'notifications/something-new' });
  assert.equal(res, null);
});

test('malformed JSON-RPC envelopes are rejected with invalid request', async () => {
  const noMethod = await mcp.handle({ jsonrpc: '2.0', id: 1 });
  assert.equal(noMethod.error.code, -32600);
  const badVersion = await mcp.handle({ jsonrpc: '1.0', id: 1, method: 'ping' });
  assert.equal(badVersion.error.code, -32600);
  const notObject = await mcp.handle('nope');
  assert.equal(notObject.error.code, -32600);
});

test('ping is answered', async () => {
  const res = await call('ping', {}, 12);
  assert.deepEqual(res.result, {});
});

test('tools/list returns the three documented tools with schemas', async () => {
  const res = await call('tools/list', {}, 13);
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['hyperglob_dependents', 'hyperglob_paths', 'hyperglob_query']);
  for (const tool of res.result.tools) {
    assert.ok(tool.description, `${tool.name} needs a description`);
    assert.ok(tool.inputSchema);
  }
});

// ---------------------------------------------------------------------------
// paths tool output format (kept stable for existing consumers)
// ---------------------------------------------------------------------------

test('paths tool returns newline separated relative paths', async () => {
  const result = await callTool('hyperglob_paths', { pattern: 'src/**/*.ts', cwd: root() });
  assert.ok(!result.isError);
  const lines = textOf(result).split('\n').filter(Boolean);
  assert.ok(lines.includes('src/index.ts'));
  assert.ok(lines.every((l) => !path.isAbsolute(l)), 'paths must be relative');
});

test('paths tool returns an empty string when nothing matches', async () => {
  const result = await callTool('hyperglob_paths', { pattern: 'src/**/*.zzz', cwd: root() });
  assert.ok(!result.isError, `unexpected error: ${textOf(result)}`);
  assert.equal(textOf(result), '');
});

// ---------------------------------------------------------------------------
// worker isolation
// ---------------------------------------------------------------------------

test('tool calls work through the worker runner', async () => {
  const runner = new mcp.ToolRunner({ timeoutMs: 20000 });
  try {
    const res = await mcp.handle(
      {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'hyperglob_paths', arguments: { pattern: 'src/**/*.ts', cwd: root() } },
      },
      { runner }
    );
    assert.ok(!res.result.isError, JSON.stringify(res.result));
    assert.ok(textOf(res.result).includes('src/index.ts'));
  } finally {
    runner.close();
  }
});

test('concurrent tool calls through the worker runner all succeed', async () => {
  const runner = new mcp.ToolRunner({ timeoutMs: 20000 });
  try {
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        mcp.handle(
          {
            jsonrpc: '2.0',
            id: n,
            method: 'tools/call',
            params: { name: 'hyperglob_paths', arguments: { pattern: 'src/**/*.ts', cwd: root() } },
          },
          { runner }
        )
      )
    );
    for (const r of results) {
      assert.ok(!r.result.isError, JSON.stringify(r.result));
      assert.ok(textOf(r.result).includes('src/index.ts'));
    }
  } finally {
    runner.close();
  }
});

test('an invalid pattern through the worker runner surfaces isError', async () => {
  const runner = new mcp.ToolRunner({ timeoutMs: 20000 });
  try {
    const res = await mcp.handle(
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'hyperglob_query', arguments: { pattern: 'src/**/*.ts :bogus(1)', cwd: root() } },
      },
      { runner }
    );
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /unknown selector/i);
  } finally {
    runner.close();
  }
});

// ---------------------------------------------------------------------------
// the stdio serve loop
// ---------------------------------------------------------------------------

test('serve() processes a newline-delimited JSON-RPC stream', async () => {
  const { PassThrough } = require('node:stream');
  const input = new PassThrough();
  const emitted = [];
  const runner = new mcp.ToolRunner({ useWorker: false });
  mcp.serve({ input, emit: (o) => emitted.push(o), runner });

  const write = (o) => input.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
  write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  write({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hyperglob_paths', arguments: { pattern: 'src/**/*.ts', cwd: root() } } });
  write('{ this is not json }');
  write({ jsonrpc: '2.0', id: 4, method: 'ping' });

  await new Promise((r) => setTimeout(r, 800));
  runner.close();

  const byId = new Map(emitted.filter((m) => m.id !== null).map((m) => [m.id, m]));
  assert.ok(byId.has(1), 'initialize must be answered');
  assert.equal(byId.get(1).result.serverInfo.name, 'hyperglob');
  assert.ok(byId.has(2), 'tools/list must be answered');
  assert.ok(byId.has(3), 'tools/call must be answered');
  assert.ok(byId.get(3).result.content[0].text.includes('src/index.ts'));
  assert.ok(byId.has(4), 'ping must be answered');
  // The notification must not produce a response.
  assert.equal(emitted.filter((m) => m.id === null).length, 1, 'only the parse error may have a null id');
  assert.equal(emitted.find((m) => m.id === null).error.code, -32700);
});

test('serve() answers a parse error with -32700', async () => {
  const { PassThrough } = require('node:stream');
  const input = new PassThrough();
  const emitted = [];
  const runner = new mcp.ToolRunner({ useWorker: false });
  mcp.serve({ input, emit: (o) => emitted.push(o), runner });
  input.write('{ not json\n');
  await new Promise((r) => setTimeout(r, 400));
  runner.close();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].error.code, -32700);
  assert.match(emitted[0].error.message, /parse/i);
});
