# hyperglob

**A multi-threaded, AST-aware, zero-copy file discovery engine designed to replace legacy globbing for AI agents, monorepos, and high-performance developer tooling.**

Traditional globbing libraries (fast-glob, glob, fdir) operate purely on string paths. Modern agentic workflows and large monorepos waste significant compute reading path strings, filtering out ignored files, and performing separate file-reading/AST-parsing passes.

hyperglob combines a Rust core (parallel lock-free directory traversal) with Node.js N-API bindings, native `.gitignore` awareness, in-flight AST/metadata filtering, and streaming delivery. One pass to discover, filter, and inspect files.

```
src/**/*.ts :contains("export const") :modified(>2026-10-01) :size(<100kb)
```

## Install

```
npm install @blazeinstall/hyperglob   # postinstall fetches the prebuilt .node for your platform
# (source build still available: npm run build  — cargo + Node 18+)
```

Prebuilt binaries for Linux/macOS/Windows are attached to each GitHub release (`v*` tags) and downloaded automatically on `npm install`.

**Documentation:** <https://nom-nom-hub.github.io/hyperglob/> — a full guide, API reference, selector reference, and MCP setup. The pages are in [`docs/`](docs/) as Markdown; the site is rendered from them with no build tooling.<|end|>

## For agents

hyperglob is built for agentic workflows: one pass to discover, filter, and inspect files — no separate `glob` + `readFile` + parse passes. Agents use it to find the exact files to edit (`:exports`, `:imports`, `:contains`), check blast radius (`hyperglobDependents`), and respect `.gitignore` automatically. Exposed as MCP tools (`hyperglob_query`, `hyperglob_paths`, `hyperglob_dependents`) so any MCP-speaking agent can use it with zero code.

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
| `src/**/*.ts :contains("export const")` | Only files whose content contains the literal (evaluated in Rust during the crawl). `:contains(/regex/)` and `:matches("regex")` run a regex byte search, with optional flags in the `:contains(/regex/i)` form. |
| `src/**/*.ts :exports("useServerHook")` | **AST check** (oxc parser): the module really exports that name — any form: declarations, `export { a as b }`, re-exports, default exports. Export-shaped text inside comments or string literals does **not** match. (A file that fails to parse, or has a non-JS/TS extension, falls back to a regex over a comment- and string-masked copy of the source — the traps still do not match.) |
| `src/**/*.ts :imports("react")` | AST check: the module depends on `react` (exact source or a subpath like `react/jsx-runtime`); `require()`, dynamic `import()`, and re-export (`export … from`) sources count too. |
| `src/**/*.json :has-key("dependencies.react")` | Evaluates JSON structure in-flight during traversal (dotted path, array indices work). |
| `src/**/* :size(<100kb)` | Files smaller than 100KB, filtered at the OS stat step. Ops: `< <= > >= =`; units `b kb mb gb kib mib gib` — note that `kb` and `kib` are the same multiplier (1024), as are `mb`/`mib` and `gb`/`gib`; there are no decimal (1000-based) units. |
| `src/**/* :modified(>2026-10-01)` | Filters on filesystem mtime (UTC). Accepts `YYYY-MM-DD` and full ISO datetimes. |

Selectors compose with AND semantics and stack with plain patterns and `!` negations in the same query or across an array of queries.

Two edge cases worth knowing: `:contains("")` matches **nothing** (an empty needle is rejected rather than matching every file), and the `ignore` option is a separate, explicit exclusion list applied to matched results — it sits on top of the native ignore stack (`.gitignore` and friends), it does not replace it.

## MCP server (for agents)

`mcp.js` exposes hyperglob as an MCP tool server over stdio — any MCP-speaking agent can run discovery queries without Node bindings. Tools: `hyperglob_query` (full entries as JSON), `hyperglob_paths` (paths-only fast path), and `hyperglob_dependents` (transitive importers of a file). Query tools take `pattern` (with selectors) plus the usual options (`cwd`, `maxDepth`, `dot`, `gitignore`, `ignoreFiles`, `ignore`, `onlyFiles`, `followSymlinks`, `stats`, `content`, `index`) and paging controls (`limit`, `offset`); `hyperglob_query` also accepts `content: true`.

Tool calls run in a worker thread with a wall-clock budget (default 60 s). The budget is set per call with the `timeoutMs` argument, or for the whole server with `--timeout-ms <ms>` or `HYPERGLOB_MCP_TIMEOUT_MS=<ms>`; a per-call value always wins. A call that exceeds the budget returns an error instead of wedging the server, and the worker is replaced so a crashed native call cannot take the protocol loop down with it.

**Auto-registration is opt-in.** The `postinstall` script can add a `hyperglob` entry to the MCP configs of common agents (Claude Code, Cursor, Gemini, Codex, and others). It is **disabled by default** because it edits your global agent configuration. Enable it explicitly:

```bash
HYPERGLOB_REGISTER_MCP=1 npm install
```

Registration is idempotent (an existing `hyperglob` entry is never duplicated) and never overwrites a config it cannot parse.

**Claude Code**
```bash
claude mcp add hyperglob -- node /path/to/hyperglob/mcp.js
```

**Cursor** (`.cursor/mcp.json`) / **Cline** (MCP settings) / generic MCP clients
```json
{ "mcpServers": { "hyperglob": { "command": "node", "args": ["/path/to/hyperglob/mcp.js"] } } }
```

### DeepSeek Harness

hyperglob also ships as a [DeepSeek Harness](https://github.com/deepseek-ai) bundle. Installing it registers three tools with the Harness, so every session in that profile can find files without leaving the conversation:

| Tool | What it does |
| --- | --- |
| `mcp__hyperglob__hyperglob_query` | Find files by glob + selector, with sizes and timestamps. |
| `mcp__hyperglob__hyperglob_paths` | The same discovery, paths only — the fastest form. |
| `mcp__hyperglob__hyperglob_dependents` | The import-graph dependents of a file. |

```bash
cd ~/.dsh/profiles/desktop
pnpm add @blazeinstall/hyperglob
```

Then add `"@blazeinstall/hyperglob"` to the profile's `package.json` → `dsh.profile.bundles` and restart the Harness. The bundle resolves the MCP server from its own installed location, so it works from a linked checkout too (`pnpm add link:/path/to/hyperglob`).

See [docs/dsh.md](docs/dsh.md) for the bundle internals, configuration, and how to verify the install.

## Warm index

Pass `index: true` (CLI: `--index`) to maintain a snapshot of the tree at `<cwd>/.hyperglob/index.json`. Repeat queries validate the snapshot by stat-ing directories and ignore files (structural changes bump a parent directory's mtime, so validated path answers are exact), then answer in memory — at 110k files a warm `pathsOnly` query measured **39 ms vs 83 ms** for a full walk, and warm entries+stats ~**322 vs 452 ms**. Metadata for matched entries is refreshed with a stat and content selectors always read fresh bytes, so answers stay exact; the snapshot rebuilds automatically on any validation mismatch. (One known edge: filesystems with 1-second mtime granularity can miss a structural change made in the same second as the snapshot build.)

## Import graph: dependents

`hyperglobDependents('packages/shared/ReactSymbols.js', { cwd })` (CLI: `hyperglob --dependents <path>`, MCP: `hyperglob_dependents`) returns every JS/TS file that imports the target directly or transitively — the "what breaks if I change this file" set. Resolution covers relative paths (with TS ESM extension mapping, `./b.js` → `./b.ts`), `index.*` files, and bare monorepo specifiers (`shared/ReactSymbols`) via suffix matching with longest-prefix disambiguation. On the real React repo, dependents of `packages/shared/ReactSymbols.js` = **831 files in ~285 ms**.

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
| `maxDepth` | — | Depth below the patterns' static base (fast-glob `deep` semantics). Must be a non-negative integer. |
| `threads` | `0` (auto) | Walker threads. Must be a non-negative integer. |
| `stats` | `true` | Populate `size` / `modified`. `false` skips a stat per file (and `entry.modified` is then `undefined`). |
| `onlyFiles` | `true` | Files only. `false` also reports directories. |
| `followSymlinks` | `false` | Symlinked directories are not descended into. Cycles are always broken, so a link back to an ancestor terminates. |
| `content` | `false` | Attach `content` (string) + `buffer` to entries. |
| `ignore` | `[]` | Extra glob patterns to exclude. |
| `pathsOnly` | `false` | Return path strings (fast path). |
| `index` | `false` | Use the warm index snapshot at `<cwd>/.hyperglob/` (sync APIs; see Warm index). |

### Pattern semantics

- A pattern may not escape the working directory. `../*.ts` is rejected with
  `pattern escapes the working directory: ../*.ts` rather than returning
  files above `cwd`.
- A magic-free pattern that names a **directory** (`src`) matches that
  directory *and* everything under it; with `onlyFiles: false` the directory
  itself is reported. A magic-free pattern that names a **file** (`top.ts`)
  matches just that file.
- `src/**` matches the contents of `src` but not `src` itself.
- The index's own cache directory (`.hyperglob/`) is never included in
  results, so a live scan and a warm-index scan of the same tree always
  return the same set.

## Development

```bash
npm run build     # cargo build --release + stage .node
npm test          # builds the native module, then runs the Node suite (153 tests)
cargo test        # Rust unit tests (9 tests)
npm run example   # the PRD's §4/§5 examples, live
npm run bench     # benchmark suite (synthetic trees, interleaved vs fast-glob/glob/fdir/tinyglobby)
npm run bench:parity   # result-parity vs fast-glob on seeded random trees
node bench/real-repo.mjs /path/to/repo   # bench + parity on a real checkout
npm run bench:check    # perf-regression gate against bench/baseline.json
```

CI (`.github/workflows/ci.yml`) runs on every push and pull request:
`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test`, the Node suite, a version-parity check (package.json vs
Cargo.toml), a platform-table drift check, and a tarball smoke test.
Releases are built by `.github/workflows/release.yml`, which publishes a
`checksums.txt` alongside the binaries.

Node 18+, stable Rust. License: MIT.
