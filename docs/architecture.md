> How hyperglob works: the Rust core, the parallel traversal, the ignore stack, in-flight selector evaluation, the N-API transports and the warm index.

# Architecture

hyperglob is a Rust crate exposed to Node.js through N-API. The Rust side owns
the traversal, the matching, the ignore rules and the selector evaluation;
JavaScript only ever sees the results.

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
└────────────────────────────┬────────────────────────────────┘
                             ▼
                      OS File System
```

Source layout:

| File | Responsibility |
| --- | --- |
| `src/lib.rs` | The N-API surface: `scanSync`, `scanPathsSync`, `scanColumnsSync`, `Scanner`, `PathsScanner`, `dependentsOfSync`, `parseQueryJson`. |
| `src/engine.rs` | The traversal, the glob set, the ignore stack, per-entry evaluation. |
| `src/selectors.rs` | The selector grammar, the oxc AST checks, the JSON key walk. |
| `src/index.rs` | The warm index: snapshot build, validation, answering. |
| `src/graph.rs` | The import graph behind `hyperglobDependents`. |
| `index.js` | The public JS API: option normalization, validation, the columnar zip. |
| `cli.js` | The CLI. |
| `mcp.js` | The MCP server. |

---

## Query parsing

A query string is tokenized with quote- and paren-awareness, then split into
three buckets: positive patterns, `!`-negations and selectors. Each selector
is parsed once, up front, into a typed value — a literal byte needle, a
compiled regex, an export name, an import name, a key path, or a comparison
with its target already resolved.

```rust
enum Selector {
    ContainsLiteral(Vec<u8>),
    ContainsRegex(Regex),
    Exports(String),
    Imports(String),
    HasKey(Vec<String>),
    Size(CmpOp, u64),
    Modified(CmpOp, i64),   // epoch ms, UTC
}
```

Parse errors are raised before the walk starts, so a typo costs nothing.

### Compiled matching

All patterns — plus their `/**/` zero-directory variants — compile once into
a `globset::GlobSet`. Per-file matching is a set lookup, not a recursive
string comparison.

A magic-free pattern that names a *directory* also gets a `<dir>/**` variant
compiled in, which is how `hyperglob('src')` reports the directory and
everything under it. A magic-free pattern that names a *file* matches just
that file.

---

## The traversal

### A custom rayon walk

The walker is a custom rayon work-stealing traversal over `std::fs::read_dir`.
(v0.1.x used the `ignore` crate's walker; it measured roughly 3x slower than
raw `readdir` on the benchmark VM. The `ignore` crate's `Gitignore` *matcher*
still powers the ignore stack — it is the battle-tested part.)

```rust
scope.spawn(move |s| {
    child.visit(s, path, child_rel, child_depth, child_stack, child_ancestors);
});
```

Each directory is read once, and its entries are classified. In a directory
with more than 512 entries the classification, matching and selector
evaluation fan out across the rayon pool; smaller directories stay on the
serial path, where the overhead of spawning would dominate.

### Narrowed walk roots

The walk root is the common ancestor of the *static prefixes* of the positive
patterns. `src/**/*.ts` has the static prefix `src`, so the walk starts at
`src/` and never touches the rest of the tree. The patterns' static prefix is
also the base for `maxDepth` accounting, which is what makes hyperglob's depth
semantics match fast-glob's `deep`.

The walk root is itself a candidate: a pattern that names a directory (`src`)
reports that directory. The root is only a candidate when it is exactly the
path a pattern names, not when it is merely an ancestor of one.

### Depth

Depth is counted from the walk root, in path segments:

```rust
let can_descend = opts.max_depth.is_none_or(|md| child_depth < md);
```

With `src/**/*.ts` and `maxDepth: 2`, files in `src/` and `src/a/` match.

### Symlinks and cycles

Symlinked directories are not descended into by default. With
`followSymlinks: true`, each directory is identified by its canonicalized
path (plus the device/inode pair on Unix), and the walker keeps the chain of
strict ancestors. A link that resolves to one of its own ancestors stops the
descent, so a cycle terminates instead of looping forever.

### Containment

A pattern may not escape the working directory. The static prefix is
normalized, and a `..` that pops past the root — or an absolute path — is
rejected:

```
pattern escapes the working directory: ../*.ts
```

This is checked once, before the walk, and every offending pattern is listed.

---

## The ignore stack

Ignore rules come from the `ignore` crate — the engine behind ripgrep — and
are applied as a **per-directory stack**:

- When a directory is entered, its `.gitignore`, `.ignore` and `.agentignore`
  are loaded and pushed onto the stack.
- The cwd's `.git/info/exclude` and the global gitignore are added at the
  root.
- Deeper matchers win: the stack is consulted from the top down, and the
  first ignore match wins, unless a nearer matcher whitelists the path.
- An ignored directory prunes its whole subtree — which is what git itself
  does.

The global gitignore is built once per process (a `OnceLock`), because
building it re-reads git config files on every scan otherwise.

`gitignore: false` disables the git layer; `ignoreFiles: false` disables just
the `.ignore` / `.agentignore` layer.

---

## In-flight selector evaluation

The point of the whole design: a file is filtered **before** it ever crosses
the N-API boundary.

```rust
let want_metadata = self.has_meta_selectors || (!light && self.stats_requested);
```

- **Metadata selectors** (`:size`, `:modified`) evaluate at the `stat` step.
- **Content selectors** (`:contains`, `:matches`, `:exports`, `:imports`,
  `:has-key`) read the file and test it *inside the traversal task*.
- A file is only `stat`-ed when stats were requested or a metadata selector
  needs the values. With `stats: false` and no metadata selector, a large
  tree costs zero `stat` calls.
- A file that fails any selector is dropped immediately.

One `FileContext` is built per file and **memoizes the AST parse**, so a
query carrying both `:exports` and `:imports` parses each file at most once.

```rust
let mut ctx = FileContext::new(&bytes, &ext);
for sel in &self.query.selectors {
    if sel.needs_content() && !sel.eval_with(&mut ctx) {
        return None;
    }
}
```

### The AST checks

`:exports` and `:imports` are real AST checks, using the **oxc** parser.

Exported names are collected from the AST: function, class and variable
declarations, TS interfaces, type aliases, enums, `import =` and namespace
declarations, `export { a as b }` specifiers, re-export specifiers, and
`default` for default exports.

Import sources are collected from the AST *and* from oxc's token stream.
Working at the token level is what makes it exact: comments are lexed as
trivia and never appear in the token stream, and a string literal is a single
`Str` token rather than a sequence of source characters. A file that merely
*mentions* `require('react')` inside a comment or a string is correctly
reported as not importing react.

`require` and `import` are contextual keywords, so the token scan also checks
that the token is not preceded by `.` or `?.` — `obj.import(...)` is a member
access, not an import.

When a file cannot be parsed at all (a fatal syntax error, or a non-JS/TS
extension), both checks fall back to a regex over a **masked** copy of the
source in which comment and string-literal contents are blanked out. Export-
or import-shaped text that only lives inside a comment or a string still
cannot produce a false positive.

---

## The N-API transports

Two different shapes, because the two APIs have different needs.

### Columnar sync transport

`hyperglobSync` moves fields across the boundary as **parallel columns**
rather than as one object per match:

| Column | Encoding |
| --- | --- |
| `paths`, `relativePaths`, `names`, `extensions` | NUL-joined mega-strings. |
| `numbers` | A `Buffer` of little-endian `f64` pairs: `[size, modifiedMs]` per entry. |
| `flags` | A `Buffer` of bit flags per entry: bit 0 = `isFile`, bit 1 = `isDir`. |
| `contents` | An array of strings, with a parallel `hasContent` flag buffer. |

NUL cannot appear in a filesystem path, which is what makes the joined-string
trick safe. The numeric column is a `Buffer` rather than a `Vec<u8>` on
purpose: napi-rs marshals a `Vec<u8>` as a JS array of individual numbers,
which is catastrophically slow at scale.

The JS side zips the columns into `Entry` objects in a tight loop, reading
the numeric column through a `Float64Array` view:

```js
const nums = new Float64Array(numBuf.buffer, numBuf.byteOffset, n * 2);
entry.size = nums[i * 2];
entry.modifiedMs = nums[i * 2 + 1];
```

`modified` and `buffer` are **lazy prototype getters**, built on first
access, so 10k+ `Date` / `Buffer` objects are never created unless touched.
They are not own enumerable properties, so `Object.keys(entry)` does not list
them.

### Streaming batches

For the async API the walker runs on a background Rust thread and feeds a
crossbeam channel in batches. JavaScript pulls batches with
`Scanner::next_batch(256)`:

```rust
pub fn next_batch(&self, max: Option<u32>) -> NativeBatch
```

Results are allocated on the Rust side and cross the boundary in small
chunks instead of one giant array. `done: true` means the traversal has
finished and the channel is drained.

There is a second, paths-only scanner (`createPathsScanner`) whose batch
carries a single NUL-joined string. It exists so that `pathsOnly` streaming
is genuinely incremental — the earlier implementation ran a full
`scanPathsSync` and split the result, which meant the entire result set was
materialized in memory before the first `yield`, the opposite of what a
streaming API promises.

The JS `HyperglobStream` pulls batches of 256 and yields them one at a time,
yielding to the event loop when a batch comes back empty so a long scan never
blocks the process.

---

## The warm index

`index: true` maintains a persistent snapshot of the tree at
`<cwd>/.hyperglob/index.json`.

### What the snapshot records

| Record | Contents |
| --- | --- |
| Entries | Every non-ignored path, with `is_file`, size and mtime. |
| Dirs | Every visited directory and its mtime. |
| Ignore files | A fingerprint (size + mtime) of every `.gitignore` / `.ignore` / `.agentignore` / `.git/info/exclude`, plus the global gitignore's standard XDG location. |
| Fingerprint | A short string encoding `gitignore`, `ignoreFiles`, `dot` and `followSymlinks`. |

### On-disk format

The snapshot is columnar, like the N-API transport: a JSON header line,
then a NUL-joined paths blob, then a flag byte per entry, then 16 bytes per
entry of little-endian `f64` (size, mtime). Parsing a 110k-entry JSON
snapshot cost tens of ms per query; splitting a joined blob costs about 2 ms.

The file is written to `index.json.tmp` and renamed into place, so a partial
write can never be read as a valid snapshot.

### Validation

Creating, deleting or renaming anything bumps its parent directory's mtime,
so a fully-matching validation means the tree *structure* is unchanged and
`pathsOnly` answers are exact.

File *content* edits do not bump directory mtimes. For entry and
metadata-selector queries the matched candidates are re-`stat`ed, and content
selectors always read fresh bytes — so metadata answers stay exact too. The
cost is proportional to the match set, not to the tree.

Any validation failure — a changed directory mtime, a changed ignore file, a
different option fingerprint, a corrupt file, a version mismatch — rebuilds
the snapshot with a full scan and answers the current query from the fresh
snapshot.

Known edge: filesystems with coarse (1-second) mtime granularity can miss a
structural change made inside the same second as the snapshot build.

### The index never leaks

`.hyperglob/` and `.hyperglob/**` are excluded from results
**unconditionally** — not only when `index: true`. Otherwise the answer would
depend on whether the cache happened to be warm, and the cache's own
`index.json` would appear in one scan and not the other. A live scan and a
warm-index scan of the same tree always return the same set.

---

## The import graph

`hyperglobDependents(target)` builds the relative-import graph over all JS/TS
files under `cwd` in one parallel AST pass, then walks it backwards from the
target.

Resolution covers:

- Relative specifiers, with the TS ESM convention that `./b.js` on disk is
  often `./b.ts`.
- `index.*` files: `./hooks` resolves to `./hooks/index.ts`.
- Bare monorepo specifiers (`shared/ReactSymbols`) via path-suffix matching,
  with the longest shared directory prefix breaking ties, then the shortest
  path.

The answer is every file that imports the target directly or transitively —
the "what breaks if I change this file" set. On the real React repo,
dependents of `packages/shared/ReactSymbols.js` = **831 files in ~285 ms**.

---

## Benchmarks

Measured, not targeted. Reproduce with `npm run bench`. Methodology: synthetic
trees (22k and 110k files), 2 warmups, then 7 **interleaved** rounds per
head-to-head (engines alternate running order so transient load hits both),
reporting median and min. The numbers below are from a noisy shared 2-core
Linux VM with an overlay filesystem — absolute values will be far better on
real hardware; the *ratios* are the point.

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

Against the classic `glob` package (v13) it is not close either: 28.9 ms vs
138.1 ms (async) / 69.2 ms (sync) on `src/**/*.ts`, and 41.0 ms vs 718.3 ms
on the full scan with an ignore list — measured with the same interleaved
method.

hyperglob wins every head-to-head above on both median and min, including the
plain-path rows that v0.1.x lost. The fixes were:

- a **custom rayon traversal** (the `ignore` crate's walker was the
  bottleneck; its gitignore *matcher* is still used for rules),
- a **columnar N-API transport** (one NUL-joined string for paths,
  byte-packed numeric columns — per-object marshaling and `Vec<u8>`-as-array
  marshaling were both measured disasters),
- and **never stat-ing files whose stats nobody asked for**.

The PRD's aspirational targets (<45 ms cold crawl at 100k files) are still
not met on this hardware by hyperglob *or* the incumbents — treat them as
datacenter-hardware goals.

### Warm index numbers

At 110k files, a warm `pathsOnly` query measured **39 ms vs 83 ms** for a full
walk, and warm entries+stats ~**322 vs 452 ms**.

---

## See also

- [API](api.md) — the public surface.
- [Selectors](selectors.md) — the query language.
- [CLI](cli.md) and [MCP](mcp.md) — the same engine from a shell and from an
  agent.
