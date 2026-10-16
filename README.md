# hyperglob

**A multi-threaded, AST-aware, zero-copy file discovery engine designed to replace legacy globbing for AI agents, monorepos, and high-performance developer tooling.**

Traditional globbing libraries (fast-glob, glob, fdir) operate purely on string paths. Modern agentic workflows and large monorepos waste significant compute reading path strings, filtering out ignored files, and performing separate file-reading/AST-parsing passes.

hyperglob combines a Rust core (parallel lock-free directory traversal) with Node.js N-API bindings, native `.gitignore` awareness, in-flight AST/metadata filtering, and streaming delivery. One pass to discover, filter, and inspect files.

```
src/**/*.ts :contains("export const") :modified(>2026-10-01) :size(<100kb)
```

## Install

```bash
npm install hyperglob   # (source build: cargo + Node 18+)
npm run build           # compiles the Rust core and stages the .node addon
```

Prebuilt binaries are a roadmap item; current releases build from source with a stable Rust toolchain.

## API

### Streaming (async iterable, also awaitable)

```ts
import { hyperglob } from 'hyperglob';

// Stream files matching paths AND content selectors
for await (const entry of hyperglob('src/**/*.ts :contains("useServerHook")', {
  cwd: process.cwd(),
  gitignore: true, // Default: true
  stats: true,
})) {
  console.log(entry.path);       // Absolute path
  console.log(entry.relativePath);
  console.log(entry.size);       // Number
  console.log(entry.modified);   // Date
}

// Awaiting the stream collects it into an array:
const entries = await hyperglob('src/**/*.ts');
```

`entry.content` / `entry.buffer` are populated when `content: true` is passed. With a `:contains(...)` query the file was already read in-flight inside Rust, so this costs zero extra `fs.readFile` calls on the JS side.

### Batch (sync)

```ts
import { hyperglobSync } from 'hyperglob';

const entries = hyperglobSync([
  'src/**/*.ts',
  '!src/**/*.test.ts'
], {
  maxDepth: 5,
  threads: 8
});
```

### Fast path: `pathsOnly`

When you only need paths, `pathsOnly: true` returns relative path strings and skips entry-object construction entirely — the mode comparable to fast-glob's default output, and hyperglob's fastest:

```ts
const paths = hyperglobSync('src/**/*.ts', { pathsOnly: true }); // string[]
```

### CLI

```bash
npx hyperglob 'src/**/*.ts :exports("useServerHook")' --json
```

## Query syntax

| Syntax | Behavior |
| --- | --- |
| `src/**/*.ts` | Standard fast multi-threaded glob. |
| `src/**/*.ts :contains("export const")` | Only files whose content contains the literal (evaluated in Rust during the crawl). `:contains(/regex/)` and `:matches("regex")` run a regex byte search. |
| `src/**/*.ts :exports("useServerHook")` | Light AST inspection: a real `export const/let/var/function/class/interface/type/enum` signature (or `export { ... }` list) for that name — a string literal containing the text does **not** match. |
| `src/**/*.json :has-key("dependencies.react")` | Evaluates JSON structure in-flight during traversal (dotted path, array indices work). |
| `src/**/* :size(<100kb)` | Files smaller than 100KB, filtered at the OS stat step. Ops: `< <= > >= =`; units `b kb mb gb kib mib gib`. |
| `src/**/* :modified(>2026-10-01)` | Filters on filesystem mtime (UTC). Accepts `YYYY-MM-DD` and full ISO datetimes. |

Selectors compose with AND semantics and stack with plain patterns and `!` negations in the same query or across an array of queries.

## Ignore stack

Native, no manual exclusion rules: `.gitignore`, `.ignore`, `.git/info/exclude`, the global gitignore, and **`.agentignore`** are obeyed down the tree (via the `ignore` crate — the engine behind ripgrep). Disable wholesale with `gitignore: false`, or just the `.ignore`/`.agentignore` layer with `ignoreFiles: false`.

## Architecture

```
┌──────────────────────────────┐
│      Node.js / TS Consumer   │
└──────────────┬───────────────┘
               │ N-API
               ▼
┌─────────────────────────────────────────────────────────────┐
│                      hyperglob Crate                        │
│  ┌──────────────────┐ ┌──────────────────┐ ┌─────────────┐  │
│  │ Pattern &        │ │ Parallel         │ │ In-Flight   │  │
│  │ Selector Parser  │ │ Directory Walker │ │ Selector    │  │
│  │ - GlobSet match  │ │ - ignore crate   │ │ Engine      │  │
│  │ - Selector exprs │ │ - .gitignore     │ │ - memchr    │  │
│  │                  │ │   stack + rayon- │ │ - regex     │  │
│  │                  │ │   style fan-out  │ │ - JSON walk │  │
│  └──────────────────┘ └──────────────────┘ └─────────────┘  │
└─────────────────────────────┬───────────────────────────────┘
                              ▼
                       OS File System
```

- **Parallel walk** — a custom rayon work-stealing traversal over `read_dir` (`threads` option, 0 = auto); per-entry classification, ignore checks, matching and selector evaluation fan out across threads for wide directories. Walk roots are narrowed to each pattern's static prefix, so `src/**/*.ts` never touches the rest of the tree. (v0.1.x used the `ignore` crate's walker; it measured ~3x slower than raw readdir. The `ignore` crate's `Gitignore` matcher still powers the ignore stack.)
- **In-flight selectors** — metadata selectors evaluate at stat time; content selectors read and test the file *inside the traversal tasks*. Files are filtered before they ever cross the N-API boundary. Files are only stat-ed when stats were requested or a metadata selector needs the values.
- **Streaming delivery** — for the async API the walker runs on a background Rust thread and feeds a crossbeam channel in batches; JavaScript pulls batches of entries (`Scanner::next_batch`), so results are allocated on the Rust side and cross the boundary in small chunks instead of one giant array.
- **Columnar sync transport** — `hyperglobSync` moves fields across the boundary as parallel columns (NUL-joined strings, byte-packed `Float64` columns, flag bytes) and zips them into `Entry` objects in JS; `modified`/`buffer` are lazy prototype getters so 10k+ `Date`/`Buffer` objects are never built unless touched.
- **Compiled matching** — all patterns (plus their `/**/` zero-directory variants) compile once into a `GlobSet`; per-file matching is a set lookup, not a recursive string match.

## Benchmarks

Measured, not targeted. Reproduce with `npm run bench`. Methodology: synthetic trees (22k and 110k files), 2 warmups, then 7 **interleaved** rounds per head-to-head (engines alternate running order so transient load hits both), reporting median and min. Numbers below are from a noisy shared 2-core Linux VM with an overlay filesystem — absolute values will be far better on real hardware; the *ratios* are the point.

**22k-file tree, `src/**/*.ts` (13,336 matches), medians:**

| Scenario | hyperglob | fast-glob | |
| --- | --- | --- | --- |
| `pathsOnly` vs paths | **33.9 ms** | 52.1 ms | |
| entries + stats (like-for-like) | **103.9 ms** | 345.5 ms | |
| entries, `stats: false` | 50.8 ms | (paths: 52.1 ms) | |
| Full scan `**/*.ts` w/ gitignore, `pathsOnly` | **33.4 ms** | 52.4 ms (manual ignore list) | |
| Path + content `:contains` vs glob + `readFile` + `includes` | **253.9 ms** | 3,296.6 ms | **13x** |

**110k-file tree, `src/**/*.ts` (66,668 matches), medians:**

| Scenario | hyperglob | fast-glob | |
| --- | --- | --- | --- |
| `pathsOnly` vs paths | **237.4 ms** | 324.9 ms | |
| entries + stats | **451.5 ms** | 1,263.0 ms | |
| `:contains` single pass vs glob + read | **1,266.1 ms** | 15,518.3 ms | **12x** |

Against the classic `glob` package (v13) it is not close either: 28.9 ms vs 138.1 ms (async) / 69.2 ms (sync) on `src/**/*.ts`, and 41.0 ms vs 718.3 ms on the full scan with an ignore list — measured with the same interleaved method. hyperglob wins every head-to-head above on both median and min, including the plain-path rows that v0.1.x lost — the fixes were a custom rayon traversal (the `ignore` crate's walker was the bottleneck; its gitignore *matcher* is still used for rules), a columnar N-API transport (one NUL-joined string for paths, byte-packed numeric columns — per-object marshaling and `Vec<u8>`-as-array marshaling were both measured disasters), and never stat-ing files whose stats nobody asked for. The PRD's aspirational targets (<45 ms cold crawl at 100k files) are still not met on this hardware by hyperglob *or* the incumbents — treat them as datacenter-hardware goals.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `cwd` | `process.cwd()` | Base directory. |
| `gitignore` | `true` | `.gitignore` + global + `.git/info/exclude`. |
| `ignoreFiles` | `true` | `.ignore` + `.agentignore`. |
| `dot` | `false` | Include dotfiles/dot-directories. |
| `maxDepth` | — | Depth relative to `cwd`. |
| `threads` | `0` (auto) | Walker threads. |
| `stats` | `true` | Populate `size` / `modified`. `false` skips a stat per file. |
| `onlyFiles` | `true` | Files only. |
| `followSymlinks` | `false` |  |
| `content` | `false` | Attach `content` (string) + `buffer` to entries. |
| `ignore` | `[]` | Extra glob patterns to exclude. |
| `pathsOnly` | `false` | Return path strings (fast path). |

## Roadmap (from the PRD)

- [x] Phase 1: Rust core — parallel traversal (`ignore` + fan-out), glob engine (GlobSet)
- [x] Phase 2: N-API bindings — `hyperglob` / `hyperglobSync`, pull-based AsyncIterable streaming
- [x] Phase 3: Selector parser — `:contains`, `:matches`, `:exports`, `:has-key`, `:size`, `:modified`; memchr byte search in Rust
- [x] Phase 4: Benchmark suite — fast-glob / fdir / tinyglobby comparisons (`npm run bench`)
- [ ] Full AST parsing via `oxc_parser` (`:exports` is currently a light signature inspection, not a full parse)
- [ ] True zero-copy buffers for `content` (currently Rust-allocated, streamed in batches; content strings are copied once across the boundary)
- [ ] Prebuilt binaries for Linux/macOS/Windows (napi-rs CI matrix) — blocked locally on GitHub `workflow` token scope
- [x] Plain-path performance pass (v0.2.0: custom rayon traversal + columnar transport — hyperglob now wins the plain-glob rows too, see Benchmarks)

## Development

```bash
npm run build     # cargo build --release + stage .node
npm test          # Rust unit tests are run via `cargo test`; npm test runs the Node suite (20 tests)
cargo test        # selector parser unit tests
npm run example   # the PRD's §4/§5 examples, live
npm run bench     # benchmark suite
```

Node 18+, stable Rust. License: MIT.
