'use strict';
// The MCP server over a real stdio pipe.
//
// These live in their own file on purpose. They are the only tests that
// spawn a child process, and some environments (sandboxes, restricted CI
// runners) forbid spawn() outright. When the spawn fails, the whole test
// *file* is reported as failed -- so keeping these two alone means a
// blocked spawn costs two tests instead of taking down the thirty-odd
// unrelated assertions that live beside them in hyperglob.test.js.
//
// The MCP server's behaviour is also covered in-process by tests/mcp.test.js,
// which does not need a child process at all.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('child_process');

const MCP_JS = path.join(__dirname, '..', 'mcp.js');

// The fixture these tests query.
let root;

/** Spawn the MCP server and return a `call(id, method, params)` helper. */
function startServer() {
  const proc = spawn(process.execPath, [MCP_JS], { stdio: ['pipe', 'pipe', 'pipe'] });
  const byId = new Map();
  const waiters = new Map();
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      byId.set(msg.id, msg);
      if (waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  const call = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP timeout waiting for ${method}`)),
        15000
      );
      waiters.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { proc, call };
}

test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-mcp-stdio-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const useServerHook = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'app.test.ts'), 'export const useServerHook = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'plain.ts'), 'export const other = 3;\n');
  fs.writeFileSync(path.join(root, 'pkg', 'a.json'), '{"a":1}\n');
  fs.writeFileSync(path.join(root, 'pkg', 'b.json'), '{"b":2}\n');
});

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('MCP server answers initialize, tools/list, tools/call over stdio', async () => {
  const { proc, call } = startServer();
  try {
    const init = await call(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(init.result.serverInfo.name, 'hyperglob');

    const list = await call(2, 'tools/list', {});
    assert.deepEqual(
      list.result.tools.map((t) => t.name).sort(),
      ['hyperglob_dependents', 'hyperglob_paths', 'hyperglob_query']
    );

    const res = await call(3, 'tools/call', {
      name: 'hyperglob_paths',
      arguments: { pattern: 'src/**/*.ts :exports("useServerHook")', cwd: root },
    });
    const text = res.result.content[0].text;
    assert.ok(text.includes('src/index.ts'));
    assert.ok(text.includes('src/app.test.ts'));

    const q = await call(4, 'tools/call', {
      name: 'hyperglob_query',
      arguments: { pattern: 'src/**/*.ts :imports("react")', cwd: root },
    });
    assert.ok(!q.result.isError);
  } finally {
    proc.kill();
  }
});

test('MCP multi-agent: repeated initialize and concurrent queries', async () => {
  const { proc, call } = startServer();
  try {
    // Repeated initialization is idempotent.
    const init1 = await call(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'a', version: '1' },
    });
    const init2 = await call(2, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'b', version: '2' },
    });
    assert.equal(init1.result.serverInfo.name, 'hyperglob');
    assert.equal(init2.result.serverInfo.name, 'hyperglob');

    const list1 = await call(3, 'tools/list', {});
    const list2 = await call(4, 'tools/list', {});
    assert.deepEqual(
      list1.result.tools.map((t) => t.name).sort(),
      list2.result.tools.map((t) => t.name).sort()
    );

    // Concurrent content queries all return correct, independent results.
    const results = await Promise.all([
      call(5, 'tools/call', {
        name: 'hyperglob_paths',
        arguments: { pattern: 'src/**/*.ts :contains("export const")', cwd: root },
      }),
      call(6, 'tools/call', {
        name: 'hyperglob_paths',
        arguments: { pattern: 'src/**/*.ts :contains("useServerHook")', cwd: root },
      }),
      call(7, 'tools/call', {
        name: 'hyperglob_paths',
        arguments: { pattern: 'pkg/**/*.json', cwd: root },
      }),
    ]);
    for (const r of results) {
      assert.ok(!r.result.isError, `concurrent call errored: ${JSON.stringify(r.result)}`);
    }
    const exportConst = results[0].result.content[0].text.split('\n').filter(Boolean).sort();
    const useServerHook = results[1].result.content[0].text.split('\n').filter(Boolean).sort();
    assert.ok(exportConst.includes('src/index.ts') && exportConst.includes('src/app.test.ts'));
    assert.ok(useServerHook.includes('src/index.ts') && useServerHook.includes('src/app.test.ts'));
    const jsonCount = results[2].result.content[0].text.split('\n').filter(Boolean).length;
    assert.equal(jsonCount, 2);
  } finally {
    proc.kill();
  }
});
