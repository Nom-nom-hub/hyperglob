> Complete reference for the hyperglob Node API: every export, every option, and the exact shape of the objects it returns.

# API reference

```js
const {
  hyperglob,
  hyperglobSync,
  hyperglobDependents,
  HyperglobStream,
  HyperEntry,
  parseQuery,
  version,
  native,
  loadNative,
  nativeFilename,
} = require('@blazeinstall/hyperglob');
```

ESM works too — `index.mjs` re-exports every member, including the default
export:

```js
import { hyperglobSync } from '@blazeinstall/hyperglob';
// or
import hyperglob from '@blazeinstall/hyperglob';
```

---

## `hyperglob(patterns, options?)`

Streaming API. Returns a `HyperglobStream`, which is an `AsyncIterable` of
entries and *also* awaitable (awaiting it collects the whole result into an
array).

```js
// Stream: entries arrive as the walk produces them.
for await (const entry of hyperglob('src/**/*.ts :contains("useServerHook")', {
  cwd: process.cwd(),
  gitignore: true,
  stats: true,
})) {
  console.log(entry.path);        // absolute
  console.log(entry.relativePath); // posix, relative to cwd
  console.log(entry.size);        // number
  console.log(entry.modified);    // Date
}

// Awaiting the stream collects it into an array.
const entries = await hyperglob('src/**/*.ts');
```

With `pathsOnly: true` the stream yields plain strings instead of `Entry`
objects, and the scan is genuinely incremental (a native paths-only scanner
feeds batches, so the first path is available before the walk completes):

```js
for await (const p of hyperglob('src/**/*.ts', { pathsOnly: true })) {
  console.log(typeof p); // 'string'
  console.log(p);        // 'src/app.ts'
}
```

| Parameter | Type | Notes |
| --- | --- | --- |
| `patterns` | `string \| string[]` | One or more query strings. See [Selectors](selectors.md). |
| `options` | `HyperglobOptions` | See [Options](#hypergloboptions). |

Throws synchronously on a bad pattern, a bad option value, or a pattern that
escapes `cwd`.

---

## `hyperglobSync(patterns, options?)`

Batch API. Returns the whole result set at once.

```js
const entries = hyperglobSync([
  'src/**/*.ts',
  '!src/**/*.test.ts',
], {
  maxDepth: 5,
  threads: 8,
});
```

With `pathsOnly: true` it returns `string[]` and skips entry-object
construction entirely — the fastest mode, comparable to fast-glob's default
string output.

```js
const paths = hyperglobSync('src/**/*.ts', { pathsOnly: true });
// -> ['src/app.ts', ...]
```

The sync path uses the columnar N-API transport (see
[Architecture](architecture.md)), so it is meaningfully faster than
materializing one JS object per match.

---

## `hyperglobDependents(target, options?)`

Import-graph query. Returns the relative paths of every JS/TS file under `cwd`
that imports `target` — **directly or transitively**. This is the "what breaks
if I change this file" set.

```js
const dependents = hyperglobDependents('src/hooks.ts', { cwd: '/repo' });
// -> ['src/app.ts', 'src/routes/dashboard.ts']
```

| Parameter | Type | Notes |
| --- | --- | --- |
| `target` | `string` | A **cwd-relative** path, e.g. `'src/hooks.ts'`. A leading `./` is accepted. |
| `options` | `HyperglobOptions` | `cwd` selects the tree; the rest of the options filter it. |

Resolution rules:

- Relative specifiers, with TS ESM extension mapping (`./b.js` resolves to
  `./b.ts` on disk).
- `index.*` files (`./hooks` resolves to `./hooks/index.ts`).
- Bare monorepo specifiers (`shared/ReactSymbols`) via path-suffix matching,
  with longest-shared-prefix disambiguation when two files share a tail.

The target itself is excluded from the result, and the list is sorted.

Throws when the target does not exist under `cwd`:

```js
hyperglobDependents('src/nope.ts', { cwd: '/repo' });
// Error: target not found under cwd: src/nope.ts
```

---

## `parseQuery(input)`

Parses a query string into its parts without running a scan. Useful for
validating a query before you hand it to an agent, or for rendering it.

```js
parseQuery('src/**/*.ts :contains("x") !src/**/*.test.ts');
// {
//   patterns:  ['src/**/*.ts'],
//   negatives: ['src/**/*.test.ts'],
//   selectors: ['ContainsLiteral([120])']
// }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `patterns` | `string[]` | Positive glob patterns. |
| `negatives` | `string[]` | Patterns introduced with `!`. |
| `selectors` | `string[]` | Debug rendering of each parsed selector. |

Throws on a malformed query — a selector with no parentheses, an unknown
selector name, a bad regex, a size with no comparison operator:

```js
parseQuery('src/**/*.ts :bogus(1)');
// Error: unknown selector :bogus
```

---

## `version()`

The version of the native addon, which is injected at build time from
`package.json` and therefore always matches the installed npm version.

```js
version(); // '1.0.7'
```

---

## `loadNative()`

Loads the native addon and returns it, throwing a descriptive error when it is
unavailable. Called automatically when `index.js` is required; you rarely need
it directly.

```js
const { loadNative } = require('@blazeinstall/hyperglob');
loadNative(); // -> the Native binding
```

Failure modes:

| Situation | Error |
| --- | --- |
| Unsupported platform | `hyperglob: unsupported platform freebsd-x64` |
| No binary present | `hyperglob: native binding not found (hyperglob.linux-x64-gnu.node). Run \`npm run build\` to compile the Rust core.` |
| Binary present but corrupt | `hyperglob: native binding at ... is corrupt (...). It has been removed; re-run \`npm install\` or \`npm run build\` to restore it.` |

A corrupt binary is *deleted* on load, so a later install can replace it
instead of skipping the download because the file is already there.

---

## `nativeFilename()`

The file name of the native addon that would be loaded for the current
platform.

```js
const { nativeFilename } = require('@blazeinstall/hyperglob');

nativeFilename();
// linux   -> 'hyperglob.linux-x64-gnu.node'
// darwin  -> 'hyperglob.darwin-arm64.node'
// win32   -> 'hyperglob.win32-x64-msvc.node'
```

Throws `hyperglob: unsupported platform <platform>-<arch>` for an
unsupported combination. On musl-based Linux the *installed* file is still
named `-gnu.node`; the installer downloads the `-musl` asset and renames it.

---

## `native`

The raw N-API binding. Advanced and unstable — the typed helpers above are the
supported surface.

| Member | Signature | Purpose |
| --- | --- | --- |
| `version()` | `() => string` | Native addon version. |
| `scanSync(patterns, optionsJson?)` | `(string[], string?) => NativeEntry[]` | One-shot scan, raw entries. |
| `scanPathsSync(patterns, optionsJson?)` | `(string[], string?) => string` | One-shot scan, NUL-joined relative paths. |
| `scanColumnsSync(patterns, optionsJson?)` | `(string[], string?) => NativeColumns` | One-shot scan, columnar payload. |
| `createScanner(patterns, optionsJson?)` | `(string[], string?) => Scanner` | Incremental entry scanner. |
| `createPathsScanner(patterns, optionsJson?)` | `(string[], string?) => PathsScanner` | Incremental paths-only scanner. |
| `dependentsOfSync(targetRel, optionsJson?)` | `(string, string?) => string` | Transitive importers, NUL-joined. |
| `parseQueryJson(input)` | `(string) => string` | Parse a query, return JSON. |
| `Scanner` | `new () => Scanner` | Constructor of the incremental scanner class. |
| `PathsScanner` | `new () => PathsScanner` | Constructor of the incremental paths-only scanner class. |

`optionsJson` is a JSON string of the camelCase option object, or `null` for
the defaults.

---

## The `Entry` shape

Every entry returned by `hyperglobSync` and the streaming API is an instance
of `HyperEntry`.

| Property | Type | Present | Description |
| --- | --- | --- | --- |
| `path` | `string` | always | Absolute path. |
| `relativePath` | `string` | always | Path relative to `cwd`, posix separators. |
| `name` | `string` | always | File name, e.g. `'useServer.ts'`. |
| `extension` | `string` | always | Extension without the dot, e.g. `'ts'`. |
| `isFile` | `boolean` | always | `true` for files. |
| `isDir` | `boolean` | always | `true` for directories. |
| `size` | `number` | when `stats` is not `false` | Size in bytes. |
| `modified` | `Date \| undefined` | when `stats` is not `false` | Last-modified time. |
| `modifiedMs` | `number` | when `stats` is not `false` | Epoch milliseconds. |
| `content` | `string` | when `content: true` | File content as a UTF-8 string. |
| `buffer` | `Buffer \| undefined` | when `content: true` | File content as a Buffer. |

### `stats: false` omits the metadata entirely

With `stats: false` the engine skips the `stat` call per file, so there is no
size and no date to report. Both properties are `undefined` — *not* `0`, and
*not* an `Invalid Date`:

```js
const [entry] = hyperglobSync('*.ts', { cwd: '/repo', stats: false });

entry.size;        // undefined
entry.modified;    // undefined
entry.modifiedMs;  // undefined
JSON.stringify(entry); // safe — no Invalid Date to throw on
```

The streaming API agrees with the sync API on this: `entry.modified` and
`entry.size` are `undefined` there too.

### `modified` and `buffer` are lazy getters

`modified` and `buffer` are prototype getters, built on first access. They are
not own enumerable properties, so `Object.keys(entry)` does not list them, and
10k+ `Date`/`Buffer` objects are never created unless you touch them.

`toJSON()` produces a plain, structured-clone-safe object: `modified` becomes
an ISO string, or `null` when there is no date.

---

## `HyperglobOptions`

Every option is optional. Unknown keys are ignored.

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `cwd` | `string` | `process.cwd()` | Base directory to search from. A relative path is resolved against the current working directory. |
| `gitignore` | `boolean` | `true` | Obey `.gitignore`, `.git/info/exclude` and the global gitignore. |
| `ignoreFiles` | `boolean` | `true` | Obey `.ignore` and `.agentignore`. |
| `dot` | `boolean` | `false` | Include dotfiles and dot-directories. With `dot: true`, `.git` is still skipped while `gitignore` is on. |
| `maxDepth` | `number` | unlimited | Maximum traversal depth **below the patterns' static base** — fast-glob's `deep` semantics. Must be a non-negative integer. |
| `threads` | `number` | `0` (auto) | Walker threads. `0` lets the rayon pool decide. Must be a non-negative integer. |
| `stats` | `boolean` | `true` | Populate `size` / `modified` / `modifiedMs`. `false` skips a `stat` per file. |
| `onlyFiles` | `boolean` | `true` | `true` returns files only; `false` also reports directories. |
| `followSymlinks` | `boolean` | `false` | Descend into symlinked directories. Cycles are always broken, so a link back to an ancestor terminates. |
| `content` | `boolean` | `false` | Read file contents and attach `entry.content` / `entry.buffer`. |
| `withContent` | `boolean` | `false` | Alias of `content`. If both are given, `withContent` wins. |
| `ignore` | `string \| string[]` | `[]` | Extra glob patterns to exclude, on top of the ignore stack. |
| `pathsOnly` | `boolean` | `false` | Return relative path strings instead of `Entry` objects. |
| `index` | `boolean` | `false` | Use (and maintain) the warm index snapshot at `<cwd>/.hyperglob/`. |

### `maxDepth` and `threads` are validated, not coerced

Both must be non-negative integers. A negative value, a fraction, a string, or
`NaN` throws — a silently-truncated value would turn a typo into a
wrong-but-plausible result set:

```js
hyperglobSync('*.ts', { maxDepth: -1 });
// TypeError: hyperglob: maxDepth must be a non-negative integer, got -1

hyperglobSync('*.ts', { threads: -1 });
// TypeError: hyperglob: threads must be a non-negative integer, got -1

hyperglobSync('*.ts', { maxDepth: 'abc' });
// TypeError: hyperglob: maxDepth must be a non-negative integer, got "abc"
```

`maxDepth: 0` is valid and means "the walk root only" — it does not silently
widen to unlimited.

`maxDepth` is counted from the pattern's static base, not from `cwd`:

```js
// src/index.ts is 1 below src/, src/deep/nested.ts is 2.
hyperglobSync('src/**/*.ts', { maxDepth: 1 }); // -> src/index.ts, not src/deep/nested.ts
```

### `cwd` and pattern containment

A pattern may not reach outside `cwd`:

```js
hyperglobSync('../*.ts', { cwd: '/repo/app' });
// Error: pattern escapes the working directory: ../*.ts
```

Absolute patterns and `..` segments are both rejected. The error lists every
offending pattern, comma-separated.

### `ignore` and the ignore stack are different things

`ignore` is an explicit exclusion list you provide. The ignore stack
(`.gitignore` and friends) is discovered from the tree. They are applied
together: the stack prunes directories during the walk, `ignore` filters
matched results.

```js
hyperglobSync('src/**/*.ts', { ignore: ['**/generated/**', '**/*.d.ts'] });
```

### `index` and the warm index

`index: true` maintains a snapshot at `<cwd>/.hyperglob/index.json`. Repeat
queries validate it by stat-ing every recorded directory and ignore file; a
mismatch rebuilds it. Matched entries are re-stat'ed and content selectors
always read fresh bytes, so answers stay exact.

The index is a **sync-API feature**. The streaming scanner does not consult
or maintain it.

The `.hyperglob/` directory is excluded from results unconditionally, so a
live scan and a warm-index scan of the same tree always agree.

---

## `HyperglobStream`

The object returned by `hyperglob()`.

```ts
class HyperglobStream<T = Entry> implements AsyncIterable<T>, PromiseLike<T[]> {
  constructor(patterns: string | string[], options?: HyperglobOptions);
  [Symbol.asyncIterator](): AsyncGenerator<T>;
  collect(): Promise<T[]>;
  then(...): Promise<T[]>;
  catch(...): Promise<T[]>;
  finally(...): Promise<T[]>;
}
```

| Member | Behavior |
| --- | --- |
| `[Symbol.asyncIterator]()` | Yields entries (or strings with `pathsOnly`) as the walk produces them. |
| `collect()` | Drains the stream into an array. Memoized — the scan runs once, and a second call resolves to the same array. |
| `then` / `catch` / `finally` | Makes the stream awaitable and thenable; awaits the collected array. |

Abandoning the loop early is safe and stops the work:

```js
const it = hyperglob('**/*.ts', { pathsOnly: true })[Symbol.asyncIterator]();
const first = await it.next();   // { done: false, value: 'src/app.ts' }
await it.return();                // stops the scan
```

---

## `HyperEntry`

The entry class. Constructed by the library; you normally consume it rather
than instantiate it.

```ts
class HyperEntry {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  isFile: boolean;
  isDir: boolean;
  size?: number;
  modifiedMs?: number;
  content?: string;
  readonly modified: Date | undefined;
  readonly buffer: Buffer | undefined;
  toJSON(): Record<string, unknown>;
}
```

---

## Errors

| Message | Cause |
| --- | --- |
| `hyperglob: patterns must be strings` | A non-string in the patterns array. |
| `hyperglob: patterns must be a string or an array of strings` | `patterns` was another type. |
| `hyperglob: maxDepth must be a non-negative integer, got -1` | Bad `maxDepth`. |
| `hyperglob: threads must be a non-negative integer, got -1` | Bad `threads`. |
| `pattern escapes the working directory: ../*.ts` | The pattern reaches above `cwd`. |
| `walk root does not exist: C:/does/not/exist` | The static base of the pattern does not exist. |
| `invalid glob pattern "src/[[[": error parsing glob ...` | Malformed glob. |
| `unknown selector :bogus` | Unknown selector name. |
| `query has no glob pattern: :contains("x")` | The query had no pattern and no negation. |
| `target not found under cwd: src/nope.ts` | `hyperglobDependents` target does not exist. |

---

## See also

- [Selectors](selectors.md) — the query language in full.
- [CLI](cli.md) — the same engine from a shell.
- [MCP](mcp.md) — the same engine as agent tools.
- [DeepSeek Harness](dsh.md) — the bundle that wires this into the Harness.
- [Architecture](architecture.md) — why it is fast.
