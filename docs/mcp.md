> The hyperglob MCP server: three tools, their full parameter schemas, response shapes, timeouts, and how to register it with an agent.

# MCP server

`mcp.js` exposes hyperglob as an MCP tool server over stdio, speaking JSON-RPC
2.0 with newline-delimited messages. Any MCP-speaking agent can run discovery
queries — with the full selector language, the native ignore stack and the
import graph — without writing a line of Node.

```bash
node node_modules/@blazeinstall/hyperglob/mcp.js
# or, once installed:
npx hyperglob-mcp
```

## Registering with an agent

### Generic MCP client

```json
{
  "mcpServers": {
    "hyperglob": { "command": "node", "args": ["/path/to/hyperglob/mcp.js"] }
  }
}
```

### Claude Code

```bash
claude mcp add hyperglob -- node /path/to/hyperglob/mcp.js
```

### Cursor (`.cursor/mcp.json`), Cline, Windsurf, Gemini CLI, Codex, Zed, Continue, OpenCode

All of them take the same `command` / `args` shape. The one that differs is
VS Code, whose project config uses a `servers` key:

```json
{
  "servers": {
    "hyperglob": { "type": "stdio", "command": "node", "args": ["/path/to/hyperglob/mcp.js"] }
  }
}
```

### Auto-registration is opt-in

The `postinstall` script can add a `hyperglob` entry to the MCP configs of
common agents — Claude Code, Cursor, Gemini CLI, Codex, Zed, Cline, Roo Code,
Continue, Windsurf, Kilo Code, OpenCode, Kiro, Amp, Factory Droid, Crush.

**It is disabled by default**, because installing a library must not silently
rewrite your global agent configuration. Enable it explicitly:

```bash
HYPERGLOB_REGISTER_MCP=1 npm install
```

Registration is idempotent: an existing `hyperglob` entry is never
duplicated. It also fails closed — a config file that cannot be parsed is left
completely untouched rather than overwritten, and unrelated top-level keys are
preserved. Project-scoped writes land in the directory you ran `npm install`
from, not in the package directory.

---

## Tools

Three tools, all sharing the same core:

| Tool | Returns | Use when |
| --- | --- | --- |
| `hyperglob_query` | JSON with full entries | You need metadata (size, mtime) or file content. |
| `hyperglob_paths` | Newline-separated relative paths | You only need the paths. Much cheaper for the model's context. |
| `hyperglob_dependents` | Newline-separated relative paths | You need the blast radius of a file. |

### `hyperglob_query`

Full entries, paged, as JSON.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | `string` | yes | Glob pattern, optionally followed by selectors. |
| `cwd` | `string` | no | Root directory to search from. Default: the server's cwd. |
| `maxDepth` | `number` | no | Maximum traversal depth. Minimum `0`. |
| `threads` | `number` | no | Walker threads. `0` = auto. Minimum `0`. |
| `dot` | `boolean` | no | Include dotfiles / dot-directories. Default `false`. |
| `gitignore` | `boolean` | no | Obey `.gitignore` / `.git/info/exclude` / global gitignore. Default `true`. |
| `ignoreFiles` | `boolean` | no | Obey `.ignore` and `.agentignore`. Default `true`. |
| `ignore` | `string[]` | no | Extra glob patterns to exclude, e.g. `["**/dist/**", "**/*.min.js"]`. |
| `onlyFiles` | `boolean` | no | Only return files. Default `true`; `false` includes directories. |
| `followSymlinks` | `boolean` | no | Follow symlinked directories. Default `false`. |
| `stats` | `boolean` | no | Populate size / modified. Default `true`. |
| `content` | `boolean` | no | Include file contents in entries. Default `false`. |
| `index` | `boolean` | no | Use the warm index snapshot at `<cwd>/.hyperglob/`. Default `false`. |
| `limit` | `number` | no | Maximum entries to return. `1` – `10000`, default `500`. |
| `offset` | `number` | no | Skip this many matches before collecting. Minimum `0`. |
| `timeoutMs` | `number` | no | Wall-clock budget for this call. `1000` – `600000`, default `60000`. |

**Response**

The tool result is a single text blob containing JSON:

```json
{
  "count": 3,
  "total": 3,
  "offset": 0,
  "limit": 500,
  "truncated": false,
  "entries": [
    {
      "path": "/repo/src/app.ts",
      "relativePath": "src/app.ts",
      "name": "app.ts",
      "extension": "ts",
      "size": 1240,
      "isFile": true,
      "isDir": false,
      "modified": "2026-10-14T09:31:00.000Z",
      "modifiedMs": 1791361860000
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `count` | `number` | Entries in this page. |
| `total` | `number` | Total matches found. |
| `offset` | `number` | The offset this page started at. |
| `limit` | `number` | The limit that was applied. |
| `truncated` | `boolean` | `true` when more matched than were returned. |
| `entries` | `object[]` | The page. |

Each entry carries `path`, `relativePath`, `name`, `extension`, `size`,
`isFile`, `isDir`, `modified` (ISO string) and `modifiedMs`. `size` and
`modifiedMs` are `null` when `stats: false`; `modified` is `null` when there
is no date. `content` is present (a string, or `null`) only when
`content: true`.

**Paging.** A tool result lands in the model's context, so the result is
capped. When `truncated` is `true`, raise `limit` or page with `offset`:

```json
{ "pattern": "src/**/*.ts", "limit": 100, "offset": 0 }
{ "pattern": "src/**/*.ts", "limit": 100, "offset": 100 }
```

### `hyperglob_paths`

The fast path. Same pattern and selector syntax, same options, but the result
is just relative paths, one per line, so it costs a fraction of the tokens.

**Parameters**

Identical to `hyperglob_query`, including `pattern` (required), `cwd`,
`maxDepth`, `threads`, `dot`, `gitignore`, `ignoreFiles`, `ignore`,
`onlyFiles`, `followSymlinks`, `stats`, `content`, `index`, `limit`, `offset`
and `timeoutMs`.

**Response**

A newline-separated list of relative paths:

```
src/app.ts
src/hooks/useServer.ts
src/hooks/useServer.test.ts
```

Empty output (an empty string) when nothing matched.

### `hyperglob_dependents`

The import graph. Lists every JS/TS file that imports the target, directly or
transitively.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | `string` | yes | Cwd-relative path of the file, e.g. `src/hooks.ts`. |
| `cwd` | `string` | no | Root directory. Default: the server's cwd. |
| `maxDepth` | `number` | no | Maximum traversal depth. Minimum `0`. |
| `dot` | `boolean` | no | Include dotfiles / dot-directories. Default `false`. |
| `gitignore` | `boolean` | no | Obey `.gitignore`. Default `true`. |
| `ignoreFiles` | `boolean` | no | Obey `.ignore` and `.agentignore`. Default `true`. |
| `ignore` | `string[]` | no | Extra glob patterns to exclude. |
| `limit` | `number` | no | Maximum dependents to return. `1` – `10000`, default `500`. |
| `timeoutMs` | `number` | no | Wall-clock budget for this call. `1000` – `600000`, default `60000`. |

**Response**

Newline-separated relative paths, sorted:

```
src/app.ts
src/routes/dashboard.ts
```

An empty string when nothing imports the target. A target that does not exist
under `cwd` is an error.

---

## Errors

Tool failures come back as a normal MCP tool result with `isError: true` and a
text message — not as a JSON-RPC error — so the agent can read what went wrong
and retry:

```json
{
  "content": [{ "type": "text", "text": "hyperglob error: unknown selector :bogus" }],
  "isError": true
}
```

Bad *arguments* are rejected earlier, as JSON-RPC `invalid params`
(`-32602`):

| Condition | Message |
| --- | --- |
| Missing `pattern` | `pattern (string) is required` |
| Missing `target` | `target (string) is required` |
| Unknown tool name | `unknown tool: hyperglob_nope` |
| `maxDepth` negative | `maxDepth must be a non-negative integer, got -1` |
| `threads` negative | `threads must be a non-negative integer, got -1` |
| `limit` below 1 | `limit must be a positive integer, got 0` |
| `offset` negative | `offset must be a non-negative integer, got -1` |
| `timeoutMs` below 1000 | `timeoutMs must be an integer >= 1000, got 100` |
| `ignore` not strings | `ignore must be a glob pattern string or an array of strings, got ...` |
| A boolean option that is not a boolean | `dot must be a boolean, got "yes"` |

---

## Timeouts

Every tool call runs under a **wall-clock budget, default 60 s**. The budget
is set per call with the `timeoutMs` argument, or for the whole server with
`--timeout-ms <ms>` or `HYPERGLOB_MCP_TIMEOUT_MS=<ms>`; a per-call value
always wins.

```bash
# Server-wide, 5 minutes
HYPERGLOB_MCP_TIMEOUT_MS=300000 node mcp.js
node mcp.js --timeout-ms 300000
```

```json
{ "pattern": "**/*.ts", "timeoutMs": 300000 }
```

The value is clamped to `1000` – `600000` ms. A call that exceeds the budget
returns `isError: true` with `query timed out after <n>ms` instead of hanging
the server.

---

## Isolation and stdout hygiene

Tool calls run inside a **worker thread**. That gives the server three
properties that matter in production:

- **A hard timeout.** A native call that never returns can no longer wedge the
  protocol loop; the worker is terminated and replaced.
- **Crash isolation.** A native segfault kills the worker, not the server.
- **Responsiveness.** The event loop stays free while a scan runs, so
  notifications are still processed and concurrent calls run in parallel.

The JSON-RPC stream owns stdout. A guard redirects any foreign stdout write
to stderr — at the JS level *and* at the file-descriptor level, so a child
process spawned with `stdio: 'inherit'` cannot corrupt the protocol either.
Worker stdout and stderr are piped to the server's stderr.

### The worker pool

The runner keeps a **pool** of workers, not a single one. The native scan is
synchronous, so one worker can only run one query at a time; concurrent tool
calls are dispatched to separate workers and run in parallel (the pool holds
up to 4). A worker that finishes a job is terminated when nothing is queued,
because an idle worker's `MessagePort` would otherwise keep the process alive.
A worker that times out or crashes is replaced.

Set `HYPERGLOB_MCP_WORKER=0` to run jobs in-process instead of in a worker
thread — useful when debugging, at the cost of the timeout and crash
isolation guarantees.

---

## Protocol details

| Method | Response |
| --- | --- |
| `initialize` | `protocolVersion`, `capabilities: { tools: {} }`, `serverInfo: { name: 'hyperglob', version }`. |
| `ping` | `{}`. |
| `tools/list` | The three tools with their full `inputSchema`. |
| `tools/call` | The tool result. |
| `notifications/*` | Never answered. |

Supported protocol versions: `2024-11-05`, `2025-03-26`, `2025-06-18`. The
server echoes back a version it knows; anything else gets the default
`2024-11-05`.

A malformed JSON line is answered with a parse error (`-32700`). An unknown
method with an id gets method-not-found (`-32601`).

---

## Using the module directly

`mcp.js` exports everything the stdio loop uses, so the server can be driven
in-process. The package's `exports` map exposes it as a subpath:

```js
const { handle, TOOLS, ToolRunner } = require('@blazeinstall/hyperglob/mcp.js');

const runner = new ToolRunner({ timeoutMs: 20000 });

const res = await handle(
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'hyperglob_paths',
      arguments: { pattern: 'src/**/*.ts', cwd: process.cwd() },
    },
  },
  { runner }
);

console.log(res.result.content[0].text);
runner.close();
```

| Export | Purpose |
| --- | --- |
| `handle(msg, deps?)` | Handle one JSON-RPC message. Returns the response, or `null` for a notification. |
| `serve(opts?)` | Run the newline-delimited stdio loop. |
| `TOOLS` | The three tool definitions. |
| `ToolRunner` | The worker-pool job runner. |
| `runJob(job)` | Execute one job in-process. |
| `buildOptions(args, pathsOnly)` | Translate MCP arguments into hyperglob options. |
| `validateArgs(args)` | Validate arguments; throws a `UsageError` on bad input. |
| `formatToolText(op, payload)` | Render a payload as the tool's text. |
| `setProtocolSink(sink)` | Redirect the protocol stream (used by tests). |

Requiring `mcp.js` has no side effects — the stdio loop only starts when the
file is the process entry point.

---

## See also

- [Selectors](selectors.md) — the query language the `pattern` argument uses.
- [API](api.md) — the same options from Node.
- [CLI](cli.md) — the same engine from a shell.
