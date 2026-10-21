> Install hyperglob, run your first query, and pick the right surface for the job.

# Getting started

hyperglob is a multi-threaded, AST-aware file discovery engine. It replaces the
`glob` + `readFile` + parse pipeline that most agent tooling runs today with a
single traversal that filters on path, content, metadata and real AST structure
while it walks.

```
src/**/*.ts :contains("export const") :modified(>2026-10-01) :size(<100kb)
```

## Install

```bash
npm install @blazeinstall/hyperglob
```

The `postinstall` script downloads the prebuilt native binary for your platform
(Linux x64/arm64 glibc and musl, macOS x64/arm64, Windows x64) and verifies it
against the published `checksums.txt`. A source build is also available if you
need a custom target:

```bash
npm run build     # cargo build --release + stage the .node file
```

Node 18+ is required.

## First query

The fastest useful thing you can do is find files by path and content at once:

```js
const { hyperglobSync } = require('@blazeinstall/hyperglob');

const entries = hyperglobSync('src/**/*.ts :contains("useServerHook")', {
  cwd: process.cwd(),
});

for (const entry of entries) {
  console.log(entry.relativePath, entry.size, entry.modified);
}
```

Two things just happened in one pass. The glob matched `src/**/*.ts`, and the
file was read and searched for `useServerHook` *inside the traversal*, before
the entry ever crossed the N-API boundary. There is no second `readFile` pass.

If you only need paths, ask for them:

```js
const paths = hyperglobSync('src/**/*.ts', { pathsOnly: true });
// -> ['src/app.ts', 'src/hooks/useServer.ts', ...]
```

## The three surfaces

hyperglob is one engine with three front ends. Same query language, same
semantics, same results.

### Node API

Use it when the code is yours — a build script, a dev tool, a test helper.

```js
const { hyperglob, hyperglobSync, hyperglobDependents } = require('@blazeinstall/hyperglob');

// Streaming: pull entries as the walk produces them.
for await (const entry of hyperglob('src/**/*.ts')) {
  console.log(entry.path);
}

// Batch: everything at once.
const entries = hyperglobSync(['src/**/*.ts', '!src/**/*.test.ts']);

// Blast radius: who imports this file, directly or transitively?
const dependents = hyperglobDependents('src/hooks.ts', { cwd: process.cwd() });
```

The streaming API is genuinely incremental — the first entry is available
before the walk has finished, and abandoning the loop early stops the work.
Full reference: [API](api.md).

### CLI

Use it from a shell, a CI step, or an agent that shells out.

```bash
npx hyperglob 'src/**/*.ts :exports("useServerHook")'
npx hyperglob 'src/**/*.ts' --json --paths-only
npx hyperglob --dependents src/hooks.ts
```

Exit codes are an agent-friendly contract: `0` success, `1` runtime error,
`2` usage error. Full reference: [CLI](cli.md).

### MCP

Use it when an agent should drive discovery without writing any code. The
server speaks JSON-RPC 2.0 over stdio and exposes three tools:
`hyperglob_query`, `hyperglob_paths` and `hyperglob_dependents`.

```json
{
  "mcpServers": {
    "hyperglob": { "command": "node", "args": ["/path/to/hyperglob/mcp.js"] }
  }
}
```

Auto-registration into agent configs is **opt-in** and off by default:

```bash
HYPERGLOB_REGISTER_MCP=1 npm install
```

Full reference: [MCP](mcp.md).

## Core concepts

### Queries are one string

A query is a glob pattern followed by zero or more selectors, all separated by
spaces:

```
src/**/*.ts :contains("useServerHook") :size(<100kb)
```

The query is tokenized with quote- and paren-awareness, so
`:contains("export const")` is one token, not two. Patterns, negations and
selectors can also be passed as an array of separate strings, which is how you
express a negation that spans several tokens.

### Selectors are ANDed

Every selector in a query must pass. Selectors stack with plain patterns and
`!` negations, and they are evaluated in flight — a file that fails
`:contains` is dropped inside the traversal, so it is never marshalled and
never returned.

| Selector | Question it answers |
| --- | --- |
| `:contains("text")` | Does the file contain this literal? |
| `:matches("regex")` | Does the file match this regex? |
| `:exports("name")` | Does the module really export this name? |
| `:imports("name")` | Does the module depend on this package? |
| `:has-key("a.b.c")` | Does this JSON have that key path? |
| `:size(<100kb)` | Is the file smaller than 100 KB? |
| `:modified(>2026-10-01)` | Was the file modified after that date? |

Details, semantics and traps: [Selectors](selectors.md).

### The ignore stack is native

`.gitignore`, `.ignore`, `.agentignore`, `.git/info/exclude` and the global
gitignore are obeyed as the walk descends — no manual exclusion lists, no
`ignore` option pointing at `node_modules`. An ignored directory prunes its
whole subtree, which is what git itself does.

Turn the git layer off with `gitignore: false`, or just the `.ignore` /
`.agentignore` layer with `ignoreFiles: false`.

### Patterns stay inside the working directory

A pattern that reaches above `cwd` is rejected rather than silently followed:

```js
hyperglobSync('../*.ts', { cwd: '/repo/app' });
// Error: pattern escapes the working directory: ../*.ts
```

## When to use what

| Situation | Reach for |
| --- | --- |
| Find files by path only | `hyperglobSync(..., { pathsOnly: true })` — the fastest mode. |
| Find files by path *and* content | `hyperglobSync('**/*.ts :contains("x")')` — one pass, no read-back. |
| Find a module by its real exports | `:exports("name")` — a real AST check, not a regex. |
| Assess the blast radius of an edit | `hyperglobDependents('src/hooks.ts')`. |
| Consume results as they arrive | `for await (const e of hyperglob(...))`. |
| Run the same query repeatedly | `index: true` — the warm index snapshot. |
| Let an agent drive discovery | The [MCP server](mcp.md). |
| Script it in a shell | The [CLI](cli.md). |

## The warm index

Passing `index: true` maintains a snapshot of the tree at
`<cwd>/.hyperglob/index.json`. Repeat queries validate the snapshot by
stat-ing directories and ignore files, then answer from memory. Creating,
deleting or renaming a file bumps its parent directory's mtime, so a
validated path answer is exact; matched entries are re-stat'ed and content
selectors always read fresh bytes, so metadata answers stay exact too.

At 110k files a warm `pathsOnly` query measured **39 ms vs 83 ms** for a full
walk, and warm entries+stats ~**322 vs 452 ms**.

The index directory is never included in results, so a live scan and a
warm-index scan of the same tree always return the same set.

## What's next

- [API reference](api.md) — every export, every option, the `Entry` shape.
- [Selector reference](selectors.md) — the query language in full.
- [CLI reference](cli.md) — every flag and exit code.
- [MCP reference](mcp.md) — tool schemas and response shapes.
- [DeepSeek Harness](dsh.md) — install as a Harness bundle.
- [Architecture](architecture.md) — how the Rust core, traversal, ignore stack
  and transports work.
