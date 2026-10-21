> The hyperglob query language: glob patterns, negations, brace expansion, and every selector with its exact semantics and traps.

# Selectors

A query is a **glob pattern** followed by **zero or more selectors**, separated
by whitespace:

```
src/**/*.ts :contains("useServerHook") :size(<100kb) :modified(>2026-10-01)
```

Everything about a query happens in one pass: the pattern decides *which*
files, the selectors decide *whether*, and the answer is already filtered by
the time it reaches JavaScript.

## Anatomy of a query

```
src/**/*.ts            !src/**/*.test.ts     :contains("export const")
└──── pattern ────┘    └──── negation ────┘   └──── selector ────┘
```

| Part | Prefix | Meaning |
| --- | --- | --- |
| Pattern | none | A glob. A file must match at least one. |
| Negation | `!` | A glob. A file matching any negation is dropped. |
| Selector | `:` | A predicate. A file must satisfy every selector. |

### Tokenization

The query is split on whitespace, but the splitter is quote- and
paren-aware: text inside `"..."`, `'...'` or `(...)` never splits a token.

```js
// One token: 'src/**/*.ts', ':contains("export const")'
hyperglobSync('src/**/*.ts :contains("export const")');
```

A quoted argument keeps its spaces:

```js
hyperglobSync('src/**/*.ts :contains("export const useServer")');
```

### Several queries

Patterns, negations and selectors can also be passed as an array, where each
element is an independent query. The results are merged: patterns are unioned,
negations are unioned, and selectors are ANDed across the whole set.

```js
hyperglobSync(['src/**/*.ts', '!src/**/*.test.ts']);
```

Both forms are equivalent for a single negation:

```js
hyperglobSync('src/**/*.ts !src/**/*.test.ts');   // same
hyperglobSync(['src/**/*.ts', '!src/**/*.test.ts']); // same
```

---

## Patterns

Patterns are compiled once into a `GlobSet` and matched as a set lookup, not a
recursive string comparison. The usual glob syntax is supported:

| Syntax | Matches |
| --- | --- |
| `*` | Any run of characters within one path segment. |
| `?` | Exactly one character within one path segment. |
| `**` | Any number of path segments, including zero. |
| `[abc]`, `[a-z]`, `[!abc]` | One character from a class. |
| `{a,b}` | Any one of the alternatives (brace expansion). |
| `\` | Escapes the next character. |

`*` never crosses a `/`. `**` does.

### `**` matches zero directories

`src/**/*.ts` also matches `src/app.ts`, not just `src/deep/app.ts`. The
`/**/` variants are compiled alongside the literal pattern so zero-directory
matches are found.

```js
hyperglobSync('src/**/*.ts', { pathsOnly: true });
// -> ['src/app.ts', 'src/deep/nested.ts', ...]
```

`src/**` is different: it matches the *contents* of `src`, and not `src`
itself.

```js
hyperglobSync('src/**', { pathsOnly: true, onlyFiles: false });
// -> ['src/app.ts', 'src/deep', 'src/deep/nested.ts']   (no 'src')
```

### Brace expansion

```js
hyperglobSync('src/**/*.{ts,tsx}', { pathsOnly: true });
// -> ['src/app.ts', 'src/app.tsx', ...]
```

### A magic-free pattern is special

A pattern with no glob magic (`*`, `?`, `{`, `[`) names exactly one path, and
whether that path is a file or a directory changes what it matches.

**Naming a directory** (`src`) matches the directory *and* everything under
it:

```js
hyperglobSync('src', { pathsOnly: true, onlyFiles: false });
// -> ['src', 'src/app.ts', 'src/deep', 'src/deep/nested.ts']

hyperglobSync('src', { pathsOnly: true, onlyFiles: true });
// -> ['src/app.ts', 'src/deep/nested.ts']
```

**Naming a file** (`top.ts`) matches only that file:

```js
hyperglobSync('top.ts', { pathsOnly: true });
// -> ['top.ts']
```

### Patterns stay inside `cwd`

A pattern may not escape the working directory. `..` segments and absolute
paths are rejected:

```js
hyperglobSync('../*.ts', { cwd: '/repo/app' });
// Error: pattern escapes the working directory: ../*.ts
```

This is deliberate: a pattern that reaches outside `cwd` would return files the
caller never asked for, in a region their ignore rules do not cover.

### Negations

A `!`-prefixed pattern removes matches. Negations apply after the positive
patterns:

```js
const entries = hyperglobSync(['src/**/*.ts', '!src/**/*.test.ts']);
```

A negation can also name a directory, which removes that directory and
everything under it:

```js
hyperglobSync(['**/*', '!src/generated']);
```

---

## Selectors

Every selector in a query must pass — the semantics are AND. Selectors are
evaluated **in flight**, during the traversal:

- Metadata selectors (`:size`, `:modified`) are evaluated at `stat` time.
- Content selectors (`:contains`, `:matches`, `:exports`, `:imports`,
  `:has-key`) read the file inside the traversal task and test it there.

A file that fails is never returned and never costs another read.

### `:contains(text)`

Literal byte-substring search over the whole file (memchr's `memmem`).

```js
hyperglobSync('src/**/*.ts :contains("useServerHook")', { pathsOnly: true });
// -> ['src/app.ts', 'src/hooks/useServer.ts']
```

| Form | Behavior |
| --- | --- |
| `:contains("text")` | Literal substring. |
| `:contains('text')` | Same, single quotes. |
| `:contains(/regex/)` | Regex search. |
| `:contains("regex:...")` | Regex search, spelled with a prefix. |

The argument is unquoted before matching, so `\"` and `\'` inside a quoted
argument become literal quote characters.

An empty needle matches nothing.

**Correct:**

```js
hyperglobSync('src/**/*.ts :contains("export const")');
```

**Incorrect — the regex form needs slashes (or the `regex:` prefix); a plain
word is a literal substring:**

```js
hyperglobSync('src/**/*.ts :contains(useServerHook)');   // literal — matches
hyperglobSync('src/**/*.ts :contains(/use(Server|Client)Hook/)'); // regex
hyperglobSync('src/**/*.ts :contains(use(Server|Client)Hook)');    // literal — NO match
```

### `:matches(regex)`

Regex byte search over the whole file. Identical to `:contains(/regex/)`;
`:regex(...)` is accepted as an alias.

```js
hyperglobSync('src/**/*.ts :matches("use(Server|Client)Hook")', { pathsOnly: true });
```

`:matches` is a *text* search. It cannot tell an export from a comment — use
`:exports` for that.

**Correct:**

```js
hyperglobSync('src/**/*.ts :matches("export\\s+const")');
```

**Incorrect — a selector argument cannot contain unquoted whitespace, because
the query tokenizer splits on it:**

```js
// This is two tokens: ':matches(export' and 'const)' — a parse error.
hyperglobSync('src/**/*.ts :matches(export const)');
```

Quote the pattern (or use `\s` so there is no space to split on).

### `:exports(name)`

A **real AST check** (the oxc parser), not a regex. The module must actually
export that name, in any form:

```js
hyperglobSync('src/**/*.ts :exports("useServerHook")', { pathsOnly: true });
```

All of these match `:exports("useServerHook")`:

```js
export const useServerHook = () => {};
export function useServerHook() {}
export class useServerHook {}
export { useServerHook };
export { impl as useServerHook };
export { useServerHook } from './impl';
export default function useServerHook() {}
```

A default export is exported under the name `default`:

```js
hyperglobSync('src/**/*.ts :exports("default")');
```

**Export-shaped text inside a comment or a string does not match.** This is
the whole point of doing it in the AST:

```js
// src/comment.ts
// export const useServerHook = 1;      <- NOT an export
```

```js
// src/string.ts
const s = "export const useServerHook = 1";  <- NOT an export
```

```js
// src/block.ts
/* export function useServerHook() {} */  <- NOT an export
```

**Correct:**

```js
hyperglobSync('src/**/*.ts :exports("useServerHook")');
```

**Incorrect — a substring match on the source text:**

```js
// This would match comment.ts and string.ts too. Use :exports.
hyperglobSync('src/**/*.ts :contains("export const useServerHook")');
```

#### The unparseable-file fallback

If a file cannot be parsed at all (a fatal syntax error, or a non-JS/TS
extension), `:exports` falls back to a regex signature over a *masked* copy of
the source in which comment and string-literal contents are blanked out. So a
comment in a broken file still does not produce a false positive — but a
genuine `export const ghost = 1;` in that file does still match.

```js
// src/broken.ts  -- real export, but the file has a fatal syntax error
export const ghost = 1;
function broken( {
```

### `:imports(name)`

An AST check for module dependencies. The name matches an exact source **or a
subpath** of it.

```js
hyperglobSync('src/**/*.ts :imports("react")', { pathsOnly: true });
```

All of these count as importing `react`:

```js
import { useState } from 'react';
import React from 'react';
import 'react';                 // side-effect import
import 'react/jsx-runtime';     // subpath
const r = require('react');
const p = import('react');       // dynamic import
export { x } from 'react';      // re-export
```

**Import-shaped text inside a comment or a string does not count:**

```js
// import { x } from 'react';    <- not an import
const s = "import('react')";     <- not an import
```

**A member access is not an import.** `require` and `import` are contextual
keywords — used as a property name they are just identifiers:

```js
const o = { import: 1 };
const p = o.import;      // <- NOT an import
const q = o?.import;     // <- NOT an import
```

**Correct:**

```js
hyperglobSync('src/**/*.ts :imports("react")');
```

**Incorrect — the subpath only matches in the direction you wrote it:**

```js
hyperglobSync('src/**/*.ts :imports("react/jsx-runtime")');
// matches files importing exactly that subpath, NOT every react import
```

### `:has-key(path)`

Evaluates a JSON document and checks that a dotted key path exists. Array
indices work.

```js
hyperglobSync('pkg/**/*.json :has-key("dependencies.react")', { pathsOnly: true });
// -> ['pkg/app/package.json']
```

| Path | Checks |
| --- | --- |
| `dependencies.react` | `obj.dependencies.react` exists. |
| `scripts.build` | Nested objects. |
| `list.0.name` | Index into an array. |

The file must be valid JSON. A file that is not JSON never matches, and the
selector is safe to apply to a mixed tree.

**Correct:**

```js
hyperglobSync('pkg/**/*.json :has-key("dependencies.react")');
```

**Incorrect — `:has-key` is a JSON structure check, not a text search:**

```js
hyperglobSync('pkg/**/*.json :contains("react")');  // matches any text
```

### `:size(<op><value>)`

Filters on file size, evaluated at the `stat` step.

```js
hyperglobSync('src/**/* :size(<100kb)', { pathsOnly: true });
```

| Operator | Meaning |
| --- | --- |
| `<` | Strictly less than. |
| `<=` | Less than or equal. |
| `>` | Strictly greater than. |
| `>=` | Greater than or equal. |
| `=` / `==` | Equal to. |

| Unit | Multiplier |
| --- | --- |
| `b` | 1 |
| `kb`, `k` | 1024 |
| `mb`, `m` | 1024² |
| `gb`, `g` | 1024³ |
| `kib` | 1024 |
| `mib` | 1024² |
| `gib` | 1024³ |
| *(none)* | 1 (raw bytes) |

The unit is case-insensitive. `kb` and `kib` are the same multiplier; there
are no decimal (1000-based) units.

**Correct:**

```js
hyperglobSync('src/**/* :size(<100kb)');
hyperglobSync('src/**/* :size(<=1024)');
```

**Incorrect — the operator is mandatory:**

```js
hyperglobSync('src/**/* :size(100kb)');
// Error: selector comparison needs an operator (<, <=, >, >=, =): 100kb
```

### `:modified(<op><date>)`

Filters on the filesystem mtime, in UTC.

```js
hyperglobSync('src/**/*.ts :modified(>2026-10-01)', { pathsOnly: true });
```

| Date form | Meaning |
| --- | --- |
| `YYYY-MM-DD` | Midnight UTC on that day. |
| `YYYY-MM-DDTHH:MM:SS` | UTC, seconds precision. |
| `YYYY-MM-DD HH:MM:SS` | Same, with a space. |
| `...Z` suffix | Accepted and ignored. |

The same operators as `:size` apply: `<`, `<=`, `>`, `>=`, `=`.

`:mtime(...)` is accepted as an alias.

**Correct:**

```js
hyperglobSync('src/**/*.ts :modified(>2026-10-01)');
hyperglobSync('src/**/*.ts :modified(>=2026-10-01T12:30:00Z)');
```

**Incorrect — the operator is mandatory here too:**

```js
hyperglobSync('src/**/*.ts :modified(2026-10-01)');
// Error: selector comparison needs an operator (<, <=, >, >=, =): 2026-10-01
```

---

## Selector aliases

| Canonical | Accepted aliases |
| --- | --- |
| `:contains` | — |
| `:matches` | `:regex` |
| `:exports` | `:export` |
| `:imports` | `:import` |
| `:has-key` | `:haskey`, `:hasKey` |
| `:size` | — |
| `:modified` | `:mtime` |

---

## Composition

Selectors are ANDed, and they stack with patterns and negations freely:

```js
hyperglobSync(
  'src/**/*.ts :contains("export const") :modified(>2026-10-01) :size(<1kb)'
);
```

That query means: *TypeScript files under `src`, changed since 1 October 2026,
under 1 KB, that contain the literal text `export const`*. All four conditions
must hold.

Selectors also apply across an array of queries — they are ANDed globally:

```js
hyperglobSync([
  'src/**/*.ts',
  '!src/**/*.test.ts',
]); // no selectors here

hyperglobSync([
  'src/**/*.ts :size(<10kb)',
  '!src/vendor/**',
]); // the :size applies to both patterns
```

---

## What selectors cannot do

- **Directories never satisfy a content selector.** `:contains`, `:matches`,
  `:exports`, `:imports` and `:has-key` only match files. A directory matched
  during the walk is dropped when a content selector is present.
- **`:exports` and `:imports` are JS/TS concepts.** For other extensions the
  AST is unavailable and the masked-regex fallback is used.
- **`:has-key` needs valid JSON.** Anything else simply does not match.
- **`:size` and `:modified` need a `stat`.** They are evaluated even when
  `stats: false`, because the selector needs the values; only the *reporting*
  of `size` / `modified` on the entry is suppressed.

### One exception: the walk root

The directory a magic-free pattern names is the *walk root*, and the walk root
is reported even when a content selector is present — it is evaluated before
the walk starts, not during it:

```js
hyperglobSync('src :contains("export")', { pathsOnly: true, onlyFiles: false });
// -> ['src', 'src/a.ts']
```

Nested directories are not exempt: `src/** :contains("export")` reports the
files but not `src/sub`.

---

## Errors

A malformed selector throws at parse time, before any file is touched.

| Message | Cause |
| --- | --- |
| `unknown selector :bogus` | No such selector. |
| `selector needs closing ): :contains("x"` | Unbalanced parentheses. |
| `selector needs (...): :contains` | No parentheses at all. |
| `empty name in :exports` | `:exports()`. |
| `invalid key path in :has-key: a..b` | Empty segment in the dotted path. |
| `selector comparison needs an operator (<, <=, >, >=, =): 100kb` | Missing operator. |
| `invalid size value: abc` | Unparseable number. |
| `invalid date: not-a-date` | Unparseable date. |
| `bad regex in :contains: ...` | The regex did not compile. |
| `query has no glob pattern: :contains("x")` | No pattern and no negation. |

---

## See also

- [API](api.md) — the options that shape a scan.
- [Architecture](architecture.md) — how in-flight evaluation works.
