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

Prebuilt binaries are a roadmap item; v0.1.0 builds from source with a stable Rust toolchain.

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

- **Parallel walk** — `ignore::WalkParallel` fans traversal across threads (`threads` option, 0 = auto). Walk roots are narrowed to each pattern's static prefix, so `src/**/*.ts` never touches the rest of the tree.
- **In-flight selectors** — metadata selectors evaluate at stat time; content selectors read and test the file *inside the walker thread*. Files are filtered before they ever cross the N-API boundary.
- **Streaming delivery** — for the async API the walker runs on a background Rust thread and feeds a channel; JavaScript pulls batches of entries (`Scanner::next_batch`), so results are allocated on the Rust side and cross the boundary in small chunks instead of one giant array.
- **Compiled matching** — all patterns (plus their `/**/` zero-directory variants) compile once into a `GlobSet`; per-file matching is a set lookup, not a recursive string match.

## Benchmarks

Measured, not targeted. Reproduce with `npm run bench` (22k-file synthetic tree, 5 runs, median) — numbers below are from a 2-core Linux VM with an overlay filesystem, warm cache; your hardware will differ.

| Scenario | hyperglob | fast-glob |
| --- | --- | --- |
| Path + content query (`:contains`, single pass) vs glob + `readFile` + `includes` | **~294 ms** | ~4,144 ms |
| Plain glob `src/**/*.ts`, entries + stats | ~322 ms | ~75 ms (paths only, no stats) |
| Plain glob `src/**/*.ts`, `pathsOnly` | ~156 ms | ~75 ms |
| Full scan `**/*.ts` with gitignore, `pathsOnly` | ~160 ms | ~56 ms (with a manual ignore list — fast-glob has no native `.gitignore`) |
| 100k files, `pathsOnly` (best of 3) | ~1.53 s | — |
| 100k files, `:contains` single pass (best of 3) | ~1.87 s | — |

**Honest read:** hyperglob's reason to exist is the combined query — path + content + metadata + ignores in one pass — where it measured **~14x faster** than the fast-glob + read-it-yourself pipeline on this machine. For pure path listing with no selectors, fast-glob/fdir are still faster on this VM; closing that gap is the top performance roadmap item. The PRD's aspirational targets (<45 ms cold crawl at 100k files) are not met on this hardware by hyperglob *or* the incumbents — treat them as datacenter-hardware goals, not v0.1.0 measurements.

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
- [ ] Full AST parsing via `oxc_parser` (v0.1.0's `:exports` is a light signature inspection, not a full parse)
- [ ] True zero-copy buffers for `content` (currently Rust-allocated, streamed in batches; content strings are copied once across the boundary)
- [ ] Prebuilt binaries for Linux/macOS/Windows (napi-rs CI matrix) — blocked locally on GitHub `workflow` token scope
- [ ] Plain-path scan performance pass (custom readdir pipeline vs the `ignore` walker)

## Development

```bash
npm run build     # cargo build --release + stage .node
npm test          # Rust unit tests are run via `cargo test`; npm test runs the Node suite (20 tests)
cargo test        # selector parser unit tests
npm run example   # the PRD's §4/§5 examples, live
npm run bench     # benchmark suite
```

Node 18+, stable Rust. License: MIT.
