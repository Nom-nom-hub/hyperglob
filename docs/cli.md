> The hyperglob CLI: every flag, every exit code, and worked examples for shell pipelines and agents.

# CLI

```
usage: hyperglob <pattern...> [options]
       hyperglob --dependents <path> [options]
```

The CLI is built for agents and shell pipelines: relative paths by default,
one per line, and a stable exit-code contract.

```bash
npx hyperglob 'src/**/*.ts :exports("useServerHook")'
npx hyperglob 'src/**/*.ts' --json --paths-only
npx hyperglob --dependents src/hooks.ts
```

---

## Options

| Flag | Argument | Default | Effect |
| --- | --- | --- | --- |
| `--cwd <dir>` | directory | `process.cwd()` | Root directory to search from. |
| `--json` | — | off | Emit JSON instead of plain paths. |
| `--content` | — | off | Include file contents in the output. |
| `--paths-only` | — | off | Print relative paths only, one per line. |
| `--absolute` | — | off | Print absolute paths instead of relative ones. |
| `--ignore <glob>` | glob | — | Exclude paths matching the glob. Repeatable. |
| `--include-dirs` | — | off | Include directories in the results (default: files only). |
| `--only-files` | — | on | Only files in the results. Opposite of `--include-dirs`; wins over it. |
| `--dot` | — | off | Include dotfiles and dot-directories. |
| `--no-gitignore` | — | off | Do not obey `.gitignore` / `.git/info/exclude`. |
| `--no-ignore-files` | — | off | Do not obey `.ignore` / `.agentignore`. |
| `--follow-symlinks` | — | off | Follow symlinked directories. |
| `--max-depth <n>` | integer | unlimited | Maximum traversal depth. Must be a non-negative integer. |
| `--threads <n>` | integer | `0` (auto) | Walker threads. Must be a non-negative integer. |
| `--index` | — | off | Use the warm index snapshot at `<cwd>/.hyperglob/`. |
| `--no-stats` | — | off | Omit size / modified metadata. |
| `--dependents <path>` | path | — | List every file that imports `<path>`, directly or transitively. |
| `-h`, `--help` | — | — | Print usage and exit `0`. |
| `-v`, `--version` | — | — | Print the version and exit `0`. |

### Flag syntax

Flags take their value as the **next argument**, separated by a space:

```bash
hyperglob 'src/**/*.ts' --cwd packages/app --max-depth 4
```

`--flag=value` is not supported and is reported as an unknown flag.

Anything that is not a flag is a pattern, so multiple patterns are allowed:

```bash
hyperglob 'src/**/*.ts' 'packages/**/*.ts'
```

---

## Output modes

### Default: relative paths, one per line

```bash
$ hyperglob 'src/**/*.ts' --cwd examples/fixture
src/hook.test.ts
src/hook.ts
src/other.ts
```

### `--absolute`

```bash
$ hyperglob 'src/**/*.ts' --cwd examples/fixture --absolute
/repo/examples/fixture/src/hook.test.ts
/repo/examples/fixture/src/hook.ts
/repo/examples/fixture/src/other.ts
```

### `--paths-only`

A presentation mode: the default output already is relative paths one per
line, so `--paths-only` changes nothing about the text. It is kept as a
distinct flag so scripts can be explicit, and so `--json --paths-only` emits a
bare string array instead of objects.

```bash
$ hyperglob 'src/**/*.ts' --cwd examples/fixture --paths-only
src/hook.test.ts
src/hook.ts
src/other.ts
```

### `--json`

```bash
$ hyperglob 'src/**/*.ts' --cwd examples/fixture --json
[
  {
    "path": "/repo/examples/fixture/src/hook.test.ts",
    "relativePath": "src/hook.test.ts",
    "name": "hook.test.ts",
    "extension": "ts",
    "size": 44,
    "isFile": true,
    "isDir": false,
    "modified": "2026-10-16T18:55:41.291Z",
    "modifiedMs": 1792176941291
  }
]
```

| Field | Type | Notes |
| --- | --- | --- |
| `path` | `string` | Absolute path. |
| `relativePath` | `string` | Relative to `cwd`, posix separators. |
| `name` | `string` | File name. |
| `extension` | `string` | Extension without the dot. |
| `size` | `number \| null` | `null` with `--no-stats`. |
| `isFile` | `boolean` | |
| `isDir` | `boolean` | |
| `modified` | `string \| null` | ISO 8601. `null` with `--no-stats`. |
| `modifiedMs` | `number \| null` | Epoch milliseconds. `null` with `--no-stats`. |
| `content` | `string` | Only with `--content`. |

`--json --paths-only` emits a plain array of strings:

```bash
$ hyperglob 'src/**/*.ts' --cwd examples/fixture --json --paths-only
[
  "src/hook.test.ts",
  "src/hook.ts",
  "src/other.ts"
]
```

### `--content`

Adds the file contents to `--json` output:

```bash
hyperglob 'src/hook.ts' --cwd examples/fixture --json --content
```

---

## Directories

By default only files are reported. `--include-dirs` adds directories; an
explicit `--only-files` overrides it.

```bash
$ hyperglob 'src/**' --cwd examples/fixture --include-dirs
src/data.json
src/hook.test.ts
src/hook.ts
src/other.ts

$ hyperglob 'src/**' --cwd examples/fixture --include-dirs --only-files
src/data.json
src/hook.test.ts
src/hook.ts
src/other.ts
```

A directory shows up when the pattern names its *contents* — `src/**` matches
the children of `src`, so `src/deep` would appear here if it existed, but `src`
itself never does.

---

## The ignore stack

`.gitignore`, `.ignore`, `.agentignore`, `.git/info/exclude` and the global
gitignore are obeyed natively.

```bash
# What git would ignore:
hyperglob '**/*.ts'

# What is actually on disk:
hyperglob '**/*.ts' --no-gitignore

# Without the .ignore / .agentignore layer:
hyperglob '**/*.ts' --no-ignore-files
```

`--ignore` adds your own exclusions on top:

```bash
hyperglob '**/*.ts' --ignore '**/generated/**' --ignore '**/*.d.ts'
```

---

## Depth and threads

`--max-depth` is counted from the pattern's static base, matching fast-glob's
`deep` semantics:

```bash
# src/index.ts is 1 below src/, src/deep/nested.ts is 2.
hyperglob 'src/**/*.ts' --max-depth 1   # finds src/index.ts
hyperglob 'src/**/*.ts' --max-depth 2   # also finds src/deep/nested.ts
```

`--max-depth 0` is valid and means "the walk root only" — it does not
silently widen to unlimited.

`--threads` sets the walker thread count. `0` (the default) lets the rayon
pool decide; use it only when you are tuning for a specific machine:

```bash
hyperglob '**/*.ts' --threads 8
```

Both flags validate their value. A non-integer, a fraction or a negative
number is a **usage error** (exit `2`), not a silently-truncated value:

```bash
$ hyperglob 'src/**/*.ts' --max-depth abc
hyperglob: --max-depth expects a non-negative integer, got "abc"
# ...usage text...
```

---

## The warm index

`--index` maintains a snapshot at `<cwd>/.hyperglob/index.json` and answers
repeat queries from it.

```bash
hyperglob 'src/**/*.ts' --index      # first call: builds the snapshot
hyperglob 'src/**/*.ts' --index      # subsequent calls: validated, in-memory
```

The `.hyperglob/` directory never appears in results, so a scan with `--index`
and a scan without it always return the same set.

---

## Import graph: `--dependents`

```bash
$ hyperglob --dependents src/hooks.ts --cwd /repo
src/app.ts
src/routes/dashboard.ts
```

Lists every JS/TS file that imports the target, **directly or transitively**.
The target must be a cwd-relative path that exists under `cwd`; otherwise the
command exits `1` with `target not found under cwd: <path>`.

`--dependents` takes precedence over patterns: if you pass both, the
dependency query wins.

```bash
# JSON output works here too.
hyperglob --dependents src/hooks.ts --cwd /repo --json
```

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Runtime error: bad pattern, missing target, native failure. |
| `2` | Usage error: unknown flag, missing argument, invalid number, no pattern given. |

The distinction is deliberate: a `2` means *your command line is wrong* and
should not be retried, a `1` means *the query itself failed*.

### Examples

```bash
$ hyperglob 'src/**/*.ts' --cwd /repo
$ echo $?
0

$ hyperglob 'src/[[[' --cwd /repo
hyperglob: invalid glob pattern "src/[[[": error parsing glob 'src/[[[': unclosed character class; missing ']'
$ echo $?
1

$ hyperglob --definitely-not-a-flag
hyperglob: unknown flag --definitely-not-a-flag
# ...usage text...
$ echo $?
2

$ hyperglob
hyperglob: no pattern given
# ...usage text...
$ echo $?
2
```

Errors are printed to stderr as a single clean line — never a stack trace.
Usage errors also print the usage text.

---

## Shell recipes

Count the files in a package:

```bash
hyperglob 'src/**/*.ts' --cwd packages/app | wc -l
```

Feed the paths to another tool:

```bash
hyperglob 'src/**/*.ts' --cwd packages/app | xargs rg -l 'useServer'
```

Find the biggest files:

```bash
hyperglob 'src/**/*' --json | jq -r '.[] | "\(.size)\t\(.relativePath)"' | sort -rn | head -20
```

List every file that exports a symbol:

```bash
hyperglob 'src/**/*.ts :exports("useServerHook")' --cwd packages/app
```

Check for files that import a package:

```bash
hyperglob 'src/**/*.ts :imports("react")' --cwd packages/app --paths-only
```

---

## Driving the CLI from a script

`cli.js` exports `main(argv, io)` with injectable output writers, so it can
be driven in-process with no child process. The package's `exports` map
exposes it as a subpath:

```js
const cli = require('@blazeinstall/hyperglob/cli.js');

const out = [];
const err = [];
const code = cli.main(['node', 'cli.js', 'src/**/*.ts', '--cwd', '/repo'], {
  out: (text) => out.push(text),
  err: (text) => err.push(text),
});

console.log(code);      // 0
console.log(out.join('\n'));
```

| Export | Purpose |
| --- | --- |
| `main(argv, io?)` | Run the CLI. Returns the exit code. |
| `parseArgs(argv)` | Parse argv into `{ patterns, options, flags, dependentsOf }`. Throws `UsageError`. |
| `parseNonNegativeInt(raw, flag)` | Validate a numeric flag value. |
| `renderPlain(entries, flags)` | Render entries as plain lines. |
| `renderJson(entries, flags)` | Render entries as JSON. |
| `USAGE` | The usage text. |
| `EXIT_OK` / `EXIT_ERROR` / `EXIT_USAGE` | `0` / `1` / `2`. |
| `UsageError` | Error carrying `exitCode: 2`. |

Requiring `cli.js` does not run a scan.

---

## See also

- [Selectors](selectors.md) — the query language in the pattern argument.
- [API](api.md) — the same options from Node.
- [MCP](mcp.md) — the same engine as agent tools.
- [DeepSeek Harness](dsh.md) — the bundle that wires this into the Harness.
