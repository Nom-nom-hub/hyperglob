#!/usr/bin/env node
'use strict';

// hyperglob MCP server (stdio, JSON-RPC 2.0, newline-delimited).
//
// Lets any MCP-speaking agent use hyperglob without Node bindings:
//   { "mcpServers": { "hyperglob": { "command": "node", "args": ["<path>/mcp.js"] } } }
//
// Tools:
//   hyperglob_query — full entries for a pattern (+ selectors), JSON out
//   hyperglob_paths — paths-only fast path, one path per line

const readline = require('readline');
const { hyperglobSync, hyperglobDependents, version } = require('./index.js');

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'hyperglob_query',
    description:
      'Find files with glob patterns plus in-flight selectors evaluated during traversal: ' +
      ':contains("text") / :contains(/regex/), :exports(name) (real AST check), ' +
      ':imports(name), :has-key("dependencies.react"), :size(<100kb), :modified(>2026-10-01). ' +
      'Respects .gitignore/.ignore/.agentignore natively. Returns full entries (path, size, modified, extension).',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, optionally followed by selectors, e.g. src/**/*.ts :exports("useServerHook")' },
        cwd: { type: 'string', description: 'Root directory to search from (default: server cwd)' },
        maxDepth: { type: 'number', description: 'Maximum traversal depth' },
        content: { type: 'boolean', description: 'Include file contents in entries (default false)' },
        index: { type: 'boolean', description: 'Use the warm index snapshot at <cwd>/.hyperglob/ for repeat queries (default false)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'hyperglob_dependents',
    description:
      'Import-graph query: list every JS/TS file that imports the given file (a cwd-relative path like src/hooks.ts) directly or transitively — the "what breaks if I change this file" set.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Cwd-relative path of the file whose dependents to find' },
        cwd: { type: 'string', description: 'Root directory (default: server cwd)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'hyperglob_paths',
    description:
      'Fast paths-only file discovery: same pattern/selector syntax as hyperglob_query, returns just relative paths.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, optionally followed by selectors' },
        cwd: { type: 'string', description: 'Root directory to search from (default: server cwd)' },
        maxDepth: { type: 'number', description: 'Maximum traversal depth' },
        index: { type: 'boolean', description: 'Use the warm index snapshot at <cwd>/.hyperglob/ for repeat queries (default false)' },
      },
      required: ['pattern'],
    },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function runQuery(args, pathsOnly) {
  const opts = { pathsOnly };
  if (args.cwd) opts.cwd = args.cwd;
  if (typeof args.maxDepth === 'number') opts.maxDepth = args.maxDepth;
  if (args.content) opts.content = true;
  if (args.index) opts.index = true;
  const entries = hyperglobSync(args.pattern, opts);
  if (pathsOnly) return entries.join('\n');
  return JSON.stringify(
    entries.map((e) => ({
      path: e.path,
      relativePath: e.relativePath,
      name: e.name,
      extension: e.extension,
      size: e.size,
      isFile: e.isFile,
      isDirectory: e.isDirectory,
      modified: e.modified ? e.modified.toISOString() : null,
      ...(args.content ? { content: e.content } : {}),
    })),
    null,
    0
  );
}

function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'hyperglob', version: version() },
      });
      break;
    case 'ping':
      result(id, {});
      break;
    case 'tools/list':
      result(id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        error(id, -32602, `unknown tool: ${name}`);
        break;
      }
      if (name === 'hyperglob_dependents') {
        if (typeof args.target !== 'string' || args.target.length === 0) {
          error(id, -32602, 'target (string) is required');
          break;
        }
        try {
          const opts = {};
          if (args.cwd) opts.cwd = args.cwd;
          const deps = hyperglobDependents(args.target, opts);
          result(id, { content: [{ type: 'text', text: deps.join('\n') }] });
        } catch (e) {
          result(id, { content: [{ type: 'text', text: `hyperglob error: ${e.message}` }], isError: true });
        }
        break;
      }
      if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
        error(id, -32602, 'pattern (string) is required');
        break;
      }
      try {
        const text = runQuery(args, name === 'hyperglob_paths');
        result(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        result(id, { content: [{ type: 'text', text: `hyperglob error: ${e.message}` }], isError: true });
      }
      break;
    }
    default:
      if (id !== undefined && !method.startsWith('notifications/')) {
        error(id, -32601, `method not found: ${method}`);
      }
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // not JSON — ignore
  }
  try {
    handle(msg);
  } catch (e) {
    if (msg && msg.id !== undefined) error(msg.id, -32603, `internal error: ${e.message}`);
  }
});
