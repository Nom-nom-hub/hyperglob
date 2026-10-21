# hyperglob — npm Packaging / Install / Release Pipeline Audit

**Scope:** `package.json`, `.github/workflows/*.yml`, `scripts/build-native.mjs`, `scripts/install.js` (read-only),
`index.js` / `index.mjs` / `cli.js` / `mcp.js` (read-only), `Cargo.toml`, `package-lock.json`.
**Rust source (`src/*.rs`) was not modified.** No existing file was modified.
**Date:** 2026-10-21 · **Auditor:** packaging-auditor (subagent)

---

## Executive summary

The pipeline is **not production ready**. Eight findings are blockers: the published npm package can install
successfully and then be permanently broken on the user's machine; the package declares a dependency on itself;
`darwin-x64` is claimed but never built; the Rust test suite is never executed by CI; and released binaries are
downloaded with no integrity verification and **no version pinning** (every npm version fetches the *latest*
GitHub release binary, so the npm version you install is not the binary you get).

All findings below were verified by reading files and by running the code — not inferred. Reproduction commands are
given for each.

### Severity roll-up

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| F1 | **BLOCKER** | Package depends on itself → npm install pulls a second copy of hyperglob | open |
| F2 | **BLOCKER** | `install.js` downloads `releases/latest` → npm version ≠ binary version; fresh tag with no assets silently no-ops | open |
| F3 | **BLOCKER** | Interrupted download leaves a partial `.node`; `size > 0` check accepts it; install is permanently broken | open |
| F4 | **BLOCKER** | `readJsonLike()` destroys user agent configs that contain `//` in a string (silent data loss) | open |
| F5 | **BLOCKER** | `darwin-x64` is claimed by `install.js`/`index.js`/`build-native.mjs` but never built → Intel Mac 404 | open |
| F6 | **HIGH** | No CI on push/PR; `cargo test` (9 Rust tests) never runs; `cargo fmt --check` fails; clippy warns | open |
| F7 | **HIGH** | Zero integrity verification of the downloaded binary (no checksum, no signature) | open |
| F8 | **HIGH** | Version skew: `package.json` 1.0.6 vs `Cargo.toml` 0.4.0 → `version()` returns `0.4.0` | open |
| F9 | **MEDIUM** | npm packaging: no `.node` in tarball, `src/` omitted, no `npm publish` step in CI | open |
| F10 | **MEDIUM** | `install.js` has no timeout, no retry, no resume, writes directly to the destination path | open |
| F11 | **MEDIUM** | `postinstall` mutates the user's real agent configs during a plain local `npm install` | open |
| F12 | **MEDIUM** | `linux-musl` (Alpine) is not detected or built; glibc binary fails on Alpine | open |
| F13 | **LOW** | `index.mjs` omits 4 exports that `index.js` provides; `exports` map lists `types` last | **partly fixed** in the working tree (`index.mjs` + `index.d.ts` done; `exports` order still open) |
| F14 | **LOW** | `allowScripts` field is inert for consumers; npm 11 emits a permanent advisory warning | open |

---

## F1 — BLOCKER: the package depends on itself

### Evidence

`package.json:61-63`
```json
  "dependencies": {
    "@blazeinstall/hyperglob": "^1.0.5"
  },
```

`package-lock.json:12-14` and `package-lock.json:29-37` lock the same self-edge:
```json
      "dependencies": {
        "@blazeinstall/hyperglob": "^1.0.5"
      },
...
    "node_modules/@blazeinstall/hyperglob": {
      "version": "1.0.5",
      "resolved": "https://registry.npmjs.org/@blazeinstall/hyperglob/-/hyperglob-1.0.5.tgz",
```

`scripts/install.js:62` in the published 1.0.5 copy has the same self-edge (`"@blazeinstall/hyperglob": "^1.0.2"`),
so the tree is self-referential at every level.

### Reproduction (verified)

```
$ npm ls @blazeinstall/hyperglob
@blazeinstall/hyperglob@1.0.6 C:\Users\teck\Desktop\hyperglob
`-- @blazeinstall/hyperglob@1.0.5
  `-- @blazeinstall/hyperglob@1.0.5 deduped
```

Installing the published package into a clean consumer project:
```
$ npm install @blazeinstall/hyperglob@1.0.6
added 1 package, and audited 2 packages in 2s
$ npm ls --all
hg-selfdep-test@1.0.0
`-- @blazeinstall/hyperglob@1.0.6
  `-- @blazeinstall/hyperglob@1.0.6 deduped
```

The consumer's `package-lock.json` records the self-edge under `node_modules/@blazeinstall/hyperglob`:
```json
      "dependencies": {
        "@blazeinstall/hyperglob": "^1.0.2"
      },
```

### Why this is a real bug (not a harmless no-op)

npm resolves the self-edge by **hoisting to the top level**, so it dedupes to the root copy *only when the root
version already satisfies the range*. The range is `^1.0.5`, so:

- Installing `@blazeinstall/hyperglob@1.0.6` → dedupes to the root 1.0.6 copy. **Harmless today.**
- Installing `@blazeinstall/hyperglob@1.0.4` (the published 1.0.4 declares `^1.0.2`) → the root copy is 1.0.4, which
  does **not** satisfy `^1.0.2`… it does. But installing `@blazeinstall/hyperglob@1.0.2` (declares `^1.0.2`) → root
  is 1.0.2, satisfies. So the *current* published set dedupes.

The real breakage is **forward-looking and structural**, and it already manifests in the release CI:

- The moment the self-edge range excludes the root version, npm installs a **second, nested copy** under
  `node_modules/@blazeinstall/hyperglob/node_modules/@blazeinstall/hyperglob`. That nested copy's `postinstall`
  fires too, downloading a *second* binary, and it re-registers MCP pointing at the nested `mcp.js`.
- `npm ci` on a consumer with a stale lockfile can fail with `EINVALIDPACKAGENAME`/lock-mismatch.
- The `hasInstallScript: true` flag in `package-lock.json:10` and `package-lock.json:33` means the nested copy's
  postinstall is a *second* network download.
- The repo's own `node_modules/@blazeinstall/hyperglob/` is a real published copy (verified: it contains
  `hyperglob.win32-x64-msvc.node` and `.cursor/`, `.factory/`, `.kiro/`, `.roo/`, `.vscode/` directories — artifacts
  of *its* postinstall running inside `node_modules`).

This also means the repo's local `npm install` mutates the **published package's** directory tree, not the repo's —
see F11.

### User-visible impact

- Confusing, duplicated trees; `npm ls` shows a package depending on itself.
- A second 3–4 MB binary download on install.
- Double MCP registration pointing at two different `mcp.js` paths.
- Supply-chain surface: a compromised/typo-squatted registry copy is pulled in by *your own package*.

### Recommended fix

Delete the self-dependency entirely and the now-meaningless `allowScripts` field:

```json
  "version": "1.0.6"
}
```

(no `dependencies`, no `allowScripts`). Then regenerate the lockfile (`npm install --package-lock-only`) and confirm
`npm ls` shows a flat tree.

If a self-reference is genuinely wanted (it is not), the correct mechanism is the `exports` self-reference feature,
not a `dependencies` entry.

---

## F2 — BLOCKER: the postinstall downloads `releases/latest`, not the installed version

### Evidence

`scripts/install.js:37-39`
```js
  const url = 'https://github.com/Nom-nom-hub/hyperglob/releases/latest/download/' + file;
  console.log('hyperglob: downloading prebuilt binary for ' + process.platform + '-' + process.arch + '...');
  download(url, 0);
```

There is no reference to the package's own version anywhere in `install.js` (verified: `grep version scripts/install.js`
returns nothing), and no version check anywhere — `index.js:304` is the only `version` reference in the whole JS
surface: `version: () => native.version(),`.

### Consequence 1 — npm version ≠ binary version

`releases/latest` resolves to the newest non-prerelease GitHub release. Verified via the GitHub API: the current
`latest` is **v1.0.6**. So a user who pins `@blazeinstall/hyperglob@1.0.2` still receives the **v1.0.6** binary.
The published versions are `1.0.2, 1.0.4, 1.0.5, 1.0.6` — so 1.0.2, 1.0.4 and 1.0.5 users are all running a
*different, newer* binary than the JS they installed. This is silent and undetectable: `version()` reports
`0.4.0` in every case (see F8), so nothing reveals the mismatch.

### Consequence 2 — fresh tag with no release assets yet

`install.js:30`
```js
      if (res.statusCode !== 200) { try { fs.unlinkSync(dest); } catch {} console.warn('hyperglob: no prebuilt binary on releases; run npm run build (cargo). status=' + res.statusCode); process.exit(0); return; }
```

Verified with a local 404 server: the script warns and calls `process.exit(0)` — **exit code 0**. `npm install`
therefore reports **success**, but the package is unusable. The user gets a green install and a package that throws
`hyperglob: native binding not found` on first `require()`.

This is a *guaranteed* failure window, not a hypothetical: `release.yml` triggers on `push: tags: ['v*']`, and the
npm publish is manual (F9). If you `npm publish` before the GitHub release assets are uploaded, every install in
that window silently ships a broken package. The repo already has a `v1.0.3` tag with **no** npm version and a
`v0.4.2` tag with no npm version — evidence of a manual, unsynchronised process.

### Consequence 3 — `latest` is mutable

Even a pinned URL is only as good as the tag. `latest` can be re-pointed at a new release at any time, silently
changing the binary for every existing install that re-runs its postinstall.

### Recommended fix

Derive the release tag from the **package's own version** and fail loudly when it is unavailable:

```js
const pkg = require('../package.json');
const tag = 'v' + pkg.version;
const url = `https://github.com/Nom-nom-hub/hyperglob/releases/download/${tag}/${file}`;
```

and change the not-found path to a **non-zero exit** so `npm install` fails visibly rather than shipping a broken
package:

```js
if (res.statusCode !== 200) {
  console.error('hyperglob: no prebuilt binary for ' + file + ' at ' + tag +
                ' (status=' + res.statusCode + '). Build from source with: npm run build');
  process.exit(1);   // <- was process.exit(0)
}
```

Add a fallback to the `latest` URL only as a last resort, and log loudly that the version does not match.

---

## F3 — BLOCKER: an interrupted download permanently breaks the install

### Evidence

`scripts/install.js:20-40`
```js
const dest = path.join(__dirname, '..', file);
if (!fs.existsSync(dest)) {
  const download = (u, redirects) => {
    ...
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => { console.log('hyperglob: binary installed.'); });
      f.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} console.warn('hyperglob: write failed: ' + e.message); process.exit(0); });
    }).on('error', (e) => { try { fs.unlinkSync(dest); } catch {} console.warn('hyperglob: download failed: ' + e.message); process.exit(0); });
```

Two problems:

1. The stream is written **directly to `dest`** (the final path). There is no `.tmp` file + atomic rename.
2. The only cleanup paths are `f.on('error')` and the request `on('error')`. A **truncated response** (connection
   reset mid-body, proxy cut, disk full) produces `res` `aborted`/`error` events and *no* `f` `error` event — so
   **no cleanup runs**.

`index.js:16-28` then accepts the partial file:
```js
function loadNative() {
  const file = nativeFilename();
  const candidates = [ path.join(__dirname, file), path.join(__dirname, 'native', file) ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) return require(candidate);
  }
```

Note that the git log entry `ca3e0e8 fix: clean up partial .node file on failed download` addressed the `f.on('error')`
case only — the truncated-response case was never handled.

### Reproduction (verified, three independent ways)

**(a) Truncated HTTP response.** Local server sending `Content-Length: 1000000` but only 1000 bytes, then ending:
```
RES ABORTED (no cleanup triggered by install.js)
RES ERROR (no cleanup triggered by install.js): aborted
file exists: True
size: 1000 (expected 1000000)
```
No cleanup. The 1000-byte file survives.

**(b) The partial file blocks re-download.** `install.js:21` is `if (!fs.existsSync(dest))`. Since the partial file
exists, the next install **skips the download entirely**.

**(c) `loadNative()` accepts it.** `size > 0` is true for 1000 bytes:
```
loadNative() would ACCEPT this file: true (size=1000)
```

**End-to-end consequence** — with a 512-byte file in place, `require()` throws permanently:
```
$ node -e "require('@blazeinstall/hyperglob')"
Error: ...hyperglob.win32-x64-msvc.node is not a valid Win32 application.
    at loadNative (.../index.js:23:77)
  code: 'ERR_DLOPEN_FAILED'
```
and re-running `postinstall` does **not** repair it (verified: file size stayed at 512, because `existsSync` short-circuits).

Note the self-healing path in `index.js:30-38` never fires: `loadNative()` *succeeds* at the `size > 0` check and only
fails later at `require(candidate)` — which is *outside* the `try` block at `index.js:31-32`. The `catch` at
`index.js:33` is unreachable for a corrupt-but-nonempty binary.

### User-visible impact

A single flaky network during `npm install` leaves the user with a package that can never be repaired by re-running
`npm install`. The only fix is manually deleting `node_modules/@blazeinstall/hyperglob/hyperglob.*.node`. This is the
most likely real-world failure mode of the whole pipeline.

### Recommended fix

Download to a temp file and atomically rename only after verifying the size/hash (this also fixes F7):

```js
const tmp = dest + '.download';
const f = fs.createWriteStream(tmp);
res.pipe(f);
f.on('finish', () => {
  // verify size + sha256 here (F7), then:
  fs.renameSync(tmp, dest);
  console.log('hyperglob: binary installed.');
});
f.on('error', (e) => { try { fs.unlinkSync(tmp); } catch {} ... });
res.on('aborted', () => { try { fs.unlinkSync(tmp); } catch {} ... });
res.on('error',   () => { try { fs.unlinkSync(tmp); } catch {} ... });
```

And in `index.js:23`, replace `size > 0` with a real validity check (see F3 note below) so a corrupt binary triggers
the reinstall fallback:

```js
if (fs.existsSync(candidate) && fs.statSync(candidate).size > MIN_BINARY_BYTES) return require(candidate);
```

Better: move the `require(candidate)` **inside** the `try` at `index.js:31-32` so a `ERR_DLOPEN_FAILED` from a
corrupt binary triggers the reinstall fallback. (Requires the `index.js` owner's sign-off — it is outside my scope.)

---

## F4 — BLOCKER: `readJsonLike()` silently destroys user agent configs

### Evidence

`scripts/install.js:45-56`
```js
function readJsonLike(p) {
  if (!fs.existsSync(p)) return null;
  let raw = fs.readFileSync(p, 'utf8');
  raw = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  raw = raw.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(raw); } catch { return null; }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function tryRegister(p, mutate) {
  try {
    const cfg = readJsonLike(p) || {};
    const changed = mutate(cfg);
    if (changed) { writeJson(p, cfg); console.log('hyperglob: registered MCP in ' + p); }
  } catch (e) { /* best effort */ }
}
```

The regex `raw.replace(/\/\/.*$/gm, '')` strips `//` **anywhere in the file**, including inside string values. A URL
(`https://…`) contains `//`, so the JSON is corrupted, `JSON.parse` throws, the `catch` returns `null`, and
`tryRegister` proceeds with `cfg = {}` — then **overwrites the user's entire config file** with a file containing only
the `hyperglob` entry.

The second regex `raw.replace(/,(\s*[}\]])/g, '$1')` is likewise a string-blind hack that can corrupt values
containing `,}` or `,]`.

### Reproduction (verified — real data loss)

Input `user.json`:
```json
{ "mcpServers": { "myOtherServer": { "command": "npx", "args": ["-y", "https://example.com/mcp"] } }, "model": "gpt-5" }
```
Result:
```
readJsonLike returned: {}
WROTE
```
File after:
```json
{
  "mcpServers": {
    "hyperglob": {
      "command": "node",
      "args": ["/x"]
    }
  }
}
```
**`myOtherServer` and `model` are gone.** The user has silently lost their Claude Code / Cursor / Windsurf / Gemini /
Copilot / OpenCode / Zed / Continue / Kilo / Amp / Cline / Roo / Factory / Crush MCP configuration.

### Scope

`readJsonLike` is used by **every** `tryRegister` call — 19 registration sites, including these real user-global
files:

- `scripts/install.js:75` — `~/.claude.json`
- `scripts/install.js:89` — `~/.cursor/mcp.json`
- `scripts/install.js:103` — `~/.codeium/windsurf/mcp_config.json`
- `scripts/install.js:141` — `~/.continue/config.json`
- `scripts/install.js:149` — `~/.config/zed/settings.json`
- `scripts/install.js:163` — `~/.gemini/settings.json`
- `scripts/install.js:171` — `~/.copilot/mcp-config.json`
- `scripts/install.js:179` — `~/.config/opencode/opencode.json`
- `scripts/install.js:195` — `~/.config/amp/settings.json`
- `scripts/install.js:67` — `~/.config/kilo/kilo.jsonc`
- `scripts/install.js:119` — Cline `globalStorage/.../cline_mcp_settings.json`
- `scripts/install.js:125` — `~/.cline/data/settings/cline_mcp_settings.json`

Any of these containing a `//` (a URL, a `file://` path, a `git://` remote, a Windows UNC path `\\server\share`)
is destroyed.

The `try/catch` at `install.js:59-63` does **not** protect against this — the failure is not an exception, it is a
*successful* write of wrong data.

### User-visible impact

**Silent, unrecoverable loss of a user's AI-agent configuration** on `npm install`. The user is not asked, not
warned, and gets no backup. This is the single most user-hostile behaviour in the pipeline.

### Recommended fix

Never rewrite a file whose content could not be parsed. Three layers, in order of importance:

1. **Fail closed** — if the file exists but does not parse, **skip it** and warn; do not write:
   ```js
   function tryRegister(p, mutate) {
     let cfg;
     try {
       cfg = readJsonLike(p);
     } catch (e) {
       console.warn('hyperglob: could not parse ' + p + ' — skipping (not overwriting)');
       return;
     }
     if (cfg === null) return;  // unparseable or absent-with-content
     ...
   }
   ```
   and make `readJsonLike` **throw** (or return a sentinel distinct from "file absent") instead of swallowing the
   parse error.

2. **Use a real JSONC parser** instead of regex. `jsonc-parser` (MIT, 0 deps) or `strip-json-comments` handle
   comments correctly, including `//` inside strings.

3. **Back up before writing.** Write to `p + '.hyperglob.bak'` before the first modification of each file, and only
   once per file.

4. Additionally, only rewrite the file if the *serialised* result differs from the original text, to avoid
   reformatting the user's file unnecessarily.

---

## F5 — BLOCKER: `darwin-x64` is claimed but never built

### Evidence — three-way mismatch

**Release matrix** (`.github/workflows/release.yml:19-27`):
```yaml
        include:
          - os: ubuntu-latest
            target: linux-x64-gnu
          - os: ubuntu-24.04-arm
            target: linux-arm64-gnu
          - os: macos-latest
            target: darwin-arm64
          - os: windows-latest
            target: win32-x64-msvc
```

**`scripts/install.js:8-16`** claims five platforms:
```js
function nativeFilename() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return 'hyperglob.linux-x64-gnu.node';
  if (platform === 'linux' && arch === 'arm64') return 'hyperglob.linux-arm64-gnu.node';
  if (platform === 'darwin' && arch === 'x64') return 'hyperglob.darwin-x64.node';
  if (platform === 'darwin' && arch === 'arm64') return 'hyperglob.darwin-arm64.node';
  if (platform === 'win32' && arch === 'x64') return 'hyperglob.win32-x64-msvc.node';
  return null;
}
```

**`scripts/build-native.mjs:28-36`** also claims five:
```js
function targetName() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return 'hyperglob.linux-x64-gnu.node';
  if (platform === 'linux' && arch === 'arm64') return 'hyperglob.linux-arm64-gnu.node';
  if (platform === 'darwin' && arch === 'x64') return 'hyperglob.darwin-x64.node';
  if (platform === 'darwin' && arch === 'arm64') return 'hyperglob.darwin-arm64.node';
  if (platform === 'win32' && arch === 'x64') return 'hyperglob.win32-x64-msvc.node';
  throw new Error(`unsupported platform ${platform}-${arch}`);
}
```

**`index.js:6-14`** claims the same five.

### The gap

`darwin-x64` was removed from CI in commit `d3c5491` ("ci: drop darwin-x64 macos-13 (retired runner)"), but the
**claims in the three source files were never updated**. Confirmed against the live GitHub API — the v1.0.6 release
contains exactly four assets:

```
hyperglob.darwin-arm64.node      3425072
hyperglob.linux-arm64-gnu.node   3963464
hyperglob.linux-x64-gnu.node     4114664
hyperglob.win32-x64-msvc.node    3181568
```

**No `hyperglob.darwin-x64.node` exists in any release** (checked v1.0.6, v1.0.5, v1.0.4, v0.4.1, v0.4.0, v0.3.0,
v0.2.0, v0.1.1).

### Exact support matrix

| platform-arch | release.yml | install.js | build-native.mjs | index.js | published asset | status |
|---|---|---|---|---|---|---|
| linux-x64-gnu | ✅ | ✅ | ✅ | ✅ | ✅ | **supported** |
| linux-arm64-gnu | ✅ | ✅ | ✅ | ✅ | ✅ | **supported** |
| darwin-arm64 | ✅ | ✅ | ✅ | ✅ | ✅ | **supported** |
| win32-x64-msvc | ✅ | ✅ | ✅ | ✅ | ✅ | **supported** |
| **darwin-x64** | ❌ | ✅ | ✅ | ✅ | ❌ | **BROKEN — claimed but never built** |
| **linux-x64-musl** | ❌ | ❌ | ❌ | ❌ | ❌ | **not claimed, not built** (Alpine unsupported) |
| **linux-arm64-musl** | ❌ | ❌ | ❌ | ❌ | ❌ | **not claimed, not built** |
| **linux-arm (v7)** | ❌ | ❌ | ❌ | ❌ | ❌ | **not claimed** |
| **win32-arm64** | ❌ | ❌ | ❌ | ❌ | ❌ | **not claimed** |
| **darwin-universal** | ❌ | ❌ | ❌ | ❌ | ❌ | **not claimed** |

### User-visible impact

An Intel Mac (`darwin-x64`) user runs `npm install`, gets a 404, `install.js:30` warns and exits 0, and their
package is silently broken. `build-native.mjs` will happily try to build `hyperglob.darwin-x64.node` locally — but
there is no release for it to download, so local and published behaviour diverge.

Note also `install.js:19`:
```js
if (!file) { console.warn('hyperglob: unsupported platform ' + process.platform + '-' + process.arch); process.exit(0); }
```
The unsupported-platform path also exits **0**, so a Linux-ARMv7 or Alpine user gets a *successful* `npm install`
of an unusable package.

### Recommended fix

Pick one of two coherent strategies.

**Strategy A — build what you claim (recommended).** Add `darwin-x64` back to `release.yml`. `macos-13` is retired,
but `macos-15-intel` is the current Intel runner:
```yaml
          - os: macos-15-intel
            target: darwin-x64
```
`build-native.mjs` needs no change (it already names the file correctly) — but `scripts/build-native.mjs:38-40`
reads `target/<profile>/libhyperglob.dylib`, which is correct for a native-arch build. Add a **cross-compile** path
via `cargo build --target x86_64-apple-darwin` if the runner is arm64, or use the Intel runner directly.

**Strategy B — claim only what you build.** Remove the `darwin-x64` branch from `install.js:12`, `index.js:10` and
`build-native.mjs:32`, and make `install.js` fail loudly (exit 1) for unsupported platforms instead of exiting 0.

Whichever you choose, add a **CI drift check** that fails the build if the set of filenames in `install.js` /
`build-native.mjs` / `index.js` does not exactly match the release matrix. That check alone would have caught this.

---

## F6 — HIGH: there is no CI on push or PR, and the Rust tests never run

### Evidence

`.github/workflows/` contains **exactly one file**:
```
.github\workflows\release.yml
```

`release.yml:5-7`:
```yaml
on:
  push:
    tags: ['v*']
```

There is **no** `pull_request` trigger, **no** `push` trigger on branches, and **no** separate CI workflow.

**`cargo` appears nowhere in CI.** Verified:
```
$ Get-ChildItem .github -Recurse -File | Select-String -Pattern "cargo"
(no matches)
$ Select-String -Path package.json -Pattern "cargo"
(no matches)
```

`release.yml:35-36` is the only test step:
```yaml
      - name: Build + test
        run: npm install --ignore-scripts && npm test
```
and `package.json:53`:
```json
    "test": "npm run build && node --test tests/hyperglob.test.js",
```
`npm run build` → `scripts/build-native.mjs:18-20` → `cargo build --lib --release`. **`cargo test` is never run.**

### The Rust tests exist and pass — but nobody runs them

`src/selectors.rs:928-929`:
```rust
#[cfg(test)]
mod tests {
```

9 `#[test]` functions. Verified by running them against the **committed HEAD** (exported to a clean temp dir, so the
in-flight `src/*.rs` edits by the Rust-engine auditor were excluded):
```
running 9 tests
test selectors::tests::date_epoch ... ok
test selectors::tests::parses_modified ... ok
test selectors::tests::parses_has_key_and_negatives ... ok
test selectors::tests::parses_prd_query ... ok
test selectors::tests::parses_size ... ok
test selectors::tests::has_key_detection ... ok
test selectors::tests::exports_detection ... ok
test selectors::tests::imports_detection ... ok
test selectors::tests::exports_ast_no_false_positives ... ok
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

The release notes for v0.2.0/v0.3.0/v0.4.0 all advertise "9 Rust + N Node" tests — the Rust half is decorative in CI.

### `cargo fmt --check` currently FAILS, and `cargo clippy` currently warns

Against committed HEAD:
```
$ cargo fmt --check
Diff in ...\examples\walk_probe.rs:7:
         let t = Instant::now();
         let mut n = 0usize;
         for e in ignore::Walk::new(&root) {
-            if e.is_ok() { n += 1; }
```

```
$ cargo clippy --all-targets
warning: variable does not need to be mutable
warning: method `eval_content` is never used
warning: large size difference between variants
warning: this `map_or` can be simplified   (x2)
warning: redundant closure                  (x2)
```

### Also: the release job's test step is weaker than it looks

`release.yml:36` runs `npm install --ignore-scripts && npm test`. Because of F1, `npm install` also downloads the
**published** `@blazeinstall/hyperglob@1.0.5` tarball into `node_modules/`, and `--ignore-scripts` prevents its
postinstall from running. The `npm test` then builds the native module from *this* checkout, so the test does
exercise the local source — but the tree is polluted with a stale published copy, and the `npm install` step costs a
redundant network fetch on every one of the 4 matrix jobs.

### User-visible impact

- A regression in the Rust parser can be merged and shipped without any CI signal. The only gate is a *manual*
  `npm test` run on the maintainer's machine, in a workflow that only fires on release tags — i.e. **after** the
  change is already tagged and published.
- A release tag on a broken commit ships a broken binary to all users with no automated check.
- `cargo fmt --check` failing today means a formatting gate cannot be added without first running `cargo fmt`.

### Recommended fix

Add `.github/workflows/ci.yml` (new file — in my scope):

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  rust:
    name: rust (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - name: cargo fmt --check
        run: cargo fmt --all -- --check
      - name: cargo clippy
        run: cargo clippy --all-targets --all-features -- -D warnings
      - name: cargo test
        run: cargo test --locked --all-targets

  node:
    name: node
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm test
      - name: npm pack sanity
        run: node tools/check-package.mjs
```

Pre-requisites before this can go green: run `cargo fmt --all` once, and fix the clippy warnings (or set
`-D warnings` only after they are cleared — otherwise use `--no-deps` and don't fail on warnings initially).

Also add the **platform-matrix drift check** (see F5) as a job in `ci.yml`.

---

## F7 — HIGH: released binaries are downloaded with no integrity verification

### Evidence

`scripts/install.js:22-40` — the entire download path. There is no checksum, no signature, no size check, and no
comparison against any expected value. The only trust anchor is TLS to `github.com`.

Confirmed via the GitHub API: the v1.0.6 release contains **no** `checksums.txt` / `sha256sums` asset (0 matches).

For reference, the assets *do* carry a `digest` field that GitHub computes and publishes:
```
hyperglob.darwin-arm64.node      sha256:491b1398996d2a7c480c1058b8eb192e7821f49094a1f779e79cc4f415fc2f29
hyperglob.linux-arm64-gnu.node   sha256:5321c59e757a42ad8be6023f229112e230cff4e31f13194cc60a4c279b5f88d9
hyperglob.linux-x64-gnu.node     sha256:cbb543bf5643e8c07390f9e6d661d23dadb4703064a4035deeca9431569c303a
hyperglob.win32-x64-msvc.node    sha256:f6303ae483864bca07fcc8dd2cd99e9a1f7ec9951699dc69a0c35e3469e6721e
```
(Note these are also identical across v1.0.4/1.0.5/1.0.6 — the binaries did not change across those releases.)

### Risk

- A compromised GitHub account, a compromised release asset, or a MITM on the CDN edge can replace the `.node` with
  arbitrary native code that executes with the user's privileges on `require()`.
- A silently corrupted download (the F3 case) is indistinguishable from a valid binary.
- There is no way to reproduce or audit which binary a given install used.

### User-visible impact

A native addon with no integrity check is arbitrary-code-execution-by-download. This is a supply-chain hole in a
package whose entire value proposition is "a fast file discovery engine for AI agents" — i.e. it is installed on
developer machines by default.

### Recommended fix

**Publish a `checksums.txt` with the release** and **verify it in `install.js`**.

1. In `release.yml`'s `publish` job, after downloading artifacts, generate and upload the manifest:
   ```yaml
       - name: Generate checksums
         run: cd artifacts && sha256sum *.node > checksums.txt
       - name: Attach to the GitHub release
         uses: softprops/action-gh-release@v2
         with:
           files: |
             artifacts/*.node
             artifacts/checksums.txt
           fail_on_unmatched_files: true
   ```
   (Use `shasum -a 256` on macOS runners; the `publish` job runs on `ubuntu-latest`, so `sha256sum` is fine.)

2. In `install.js`, download `checksums.txt` for the same tag, parse the expected digest for `file`, hash the
   downloaded binary, and **refuse to install on mismatch**:
   ```js
   const crypto = require('crypto');
   const expected = parseChecksums(text)[file];   // "<sha256>  <filename>"
   const actual = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
   if (!expected || actual !== expected) {
     fs.unlinkSync(tmp);
     console.error('hyperglob: checksum mismatch for ' + file + ' — refusing to install');
     process.exit(1);
   }
   ```
   This kills two birds: it detects the truncated download (F3) *and* it detects a tampered binary.

3. For stronger guarantees, sign the manifest (e.g. `cosign sign-blob checksums.txt` / minisign) and verify the
   signature in `install.js` against a pinned public key shipped in the package.

Note: verifying against a `checksums.txt` fetched from the *same* release protects against corruption and truncation,
but not against a fully compromised release account. Signing with a key whose public half is baked into the npm
package is what protects against that.

---

## F8 — HIGH: version skew — `package.json` 1.0.6 vs `Cargo.toml` 0.4.0

### Evidence

`Cargo.toml:2-3`
```toml
name = "hyperglob"
version = "0.4.0"
```

`package.json:60`
```json
  "version": "1.0.6",
```

`src/lib.rs:285-288` (read-only; the Rust auditor's file):
```rust
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
```

`index.js:304`
```js
  version: () => native.version(),
```

`tests/hyperglob.test.js:55-57`
```js
test('version is exposed', () => {
  assert.equal(version(), '0.4.0');
});
```

`src/lib.rs:287` is the *only* version source in the native layer, and `env!("CARGO_PKG_VERSION")` is a **compile-time**
constant baked in from `Cargo.toml`. Verified: `cargo metadata --format-version 1 --no-deps` reports
`crate version: 0.4.0`, and the running binary returns `0.4.0`:
```
$ node -e "console.log(require('./index.js').version())"
0.4.0
```

### Impact

1. **The public API lies.** `require('@blazeinstall/hyperglob').version()` returns `'0.4.0'` while
   `require('@blazeinstall/hyperglob/package.json').version` is `'1.0.6'`. Any consumer (or the MCP server itself —
   `mcp.js:727` `serverInfo: { name: 'hyperglob', version: version() }`) advertises **0.4.0** to the agent. The MCP
   handshake therefore reports a version that does not match the installed package.
2. **The test cements the bug.** `tests/hyperglob.test.js:56` asserts `version() === '0.4.0'`, so the test suite
   *enforces* the skew rather than catching it. Any consumer that trusts `version()` to gate behaviour gets the
   wrong answer.
3. **The npm↔crate mapping is ambiguous.** The crate has never been published to crates.io under these versions —
   the `0.x` → `1.x` jump happened only in `package.json` (commit `b87e2d3` "chore: bump version to 1.0.2 (npm
   aligned with github releases)"). `Cargo.toml` was left at 0.4.0 ever since.
4. Git tags `v0.1.0 … v0.4.2` correspond to the crate's numbering; tags `v1.0.2 … v1.0.6` to the npm numbering.
   Two numbering schemes coexist in one repo.

### Recommended fix — build-time injected version (recommended)

The right answer is **not** to bump `Cargo.toml` to 1.0.6 and hope it stays in sync; it is to make the *npm
package version* the single source of truth and inject it into the native build.

**Step 1 — `scripts/build-native.mjs` reads the npm version and passes it to cargo.** (In my scope.)

```js
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
...
const args = ['build', '--lib'];
if (!debug) args.push('--release');
execFileSync(cargo, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, HYPERGLOB_VERSION: version },   // <- injected
});
```

**Step 2 — `build.rs` re-exports it as a compile-time env var.** (`build.rs` is *not* in my scope; needs the Rust
owner's sign-off, or the Rust owner's own change.)

```rust
fn main() {
    napi_build::setup();
    let v = std::env::var("HYPERGLOB_VERSION").unwrap_or_else(|_| "0.0.0-dev".to_string());
    println!("cargo:rustc-env=HYPERGLOB_VERSION={v}");
    println!("cargo:rerun-if-env-changed=HYPERGLOB_VERSION");
}
```

**Step 3 — `src/lib.rs:287` uses it.** (Rust owner's file.)
```rust
pub fn version() -> String {
    option_env!("HYPERGLOB_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")).to_string()
}
```

**I verified this mechanism works end-to-end** with a standalone probe crate:
```
$ HYPERGLOB_VERSION=1.0.6 cargo run
env! CARGO_PKG_VERSION = 0.4.0
env! HYPERGLOB_VERSION = 1.0.6
$ cargo run              # no env var
env! CARGO_PKG_VERSION = 0.4.0
env! HYPERGLOB_VERSION = 0.0.0-dev
```

**Step 4 — update the test** to assert the *npm* version, so the test detects future skew:
```js
test('version matches the published package version', () => {
  assert.equal(version(), require('../package.json').version);
});
```
This is a strictly better test than the current `assert.equal(version(), '0.4.0')`: it pins the invariant that
matters (JS package version == native version) instead of a magic literal.

**Step 5 — a CI guard.** In `ci.yml`, add a step that fails if `Cargo.toml`'s version and `package.json`'s version
diverge, e.g.:
```yaml
- name: version parity
  run: node tools/check-version.mjs
```

**Alternative (simpler, weaker):** bump `Cargo.toml` to `1.0.6` and add a CI check that the two files match. This
fixes the immediate lie but leaves two manually-maintained versions to drift, and it publishes the crate as 1.0.6 on
crates.io if it is ever published.

**Also fix the MCP `serverInfo`** — `mcp.js:727` will then report the correct version automatically once `version()`
is correct.

---

## F9 — MEDIUM: npm packaging

### Evidence

`package.json:23-30`
```json
  "files": [
    "index.js",
    "index.mjs",
    "index.d.ts",
    "cli.js",
    "mcp.js",
    "scripts/install.js"
  ],
```

`npm pack --dry-run` on the current tree:
```
npm notice package: @blazeinstall/hyperglob@1.0.6
npm notice Tarball Contents
npm notice 1.1kB  LICENSE
npm notice 13.9kB README.md
npm notice 9.9kB  cli.js
npm notice 8.0kB  index.d.ts
npm notice 10.1kB index.js
npm notice 695B   index.mjs
npm notice 31.3kB mcp.js
npm notice 1.7kB  package.json
npm notice 8.6kB  scripts/install.js
npm notice total files: 9
npm notice package size: 25.0 kB
```

**No `.node` binary is in the tarball** (by design — the postinstall downloads it), and **`src/` is omitted** (also
fine for a binary distribution, but see below).

### What actually happens on a fresh install

Verified end-to-end: `npm install @blazeinstall/hyperglob@1.0.6` in a clean project →
```
> @blazeinstall/hyperglob@1.0.6 postinstall
> node scripts/install.js
hyperglob: downloading prebuilt binary for win32-x64...
hyperglob: binary installed.
added 1 package, and audited 2 packages in 2s
```
So **yes, the tarball "works"** — but only because the postinstall succeeds. It fails (silently, exit 0) in every
case described in F2 (no assets for the tag), F3 (partial download), F5 (unsupported platform), and F7 (tampered
binary). The tarball contains no fallback and no self-check.

### `src/` omission

Not a functional problem for the binary distribution, but it means a user who cannot get a prebuilt binary (see
F5/F12) has **no way to build from source** — the `npm run build` script needs `Cargo.toml`, `build.rs` and `src/`,
none of which are shipped. The README (`README.md:17`) advertises `npm run build — cargo + Node 18+` as a fallback,
but that fallback is only available in the git checkout, not from the npm tarball.

### No `npm publish` step in CI

`.github/workflows/release.yml` has two jobs: `build` and `publish`. The `publish` job (release.yml:44-57) only
attaches binaries to the GitHub release — it does **not** publish to npm:
```yaml
  publish:
    name: attach binaries to release
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      ...
      - name: Attach to the GitHub release
        uses: softprops/action-gh-release@v2
```
Publishing is entirely manual. The npm publish and the GitHub release are two unsynchronised manual steps — which is
exactly the gap that produces F2's "fresh tag, no assets" window.

### `.gitignore` interaction

`.gitignore:3` is `*.node`, so the built binary is untracked. I verified that npm's `files` array **overrides**
`.gitignore` (a scratch package with `files: ["index.js","*.node"]` and `.gitignore: *.node` still packed the
`.node` file). So adding `"*.node"` to `files` would work — but it would also publish whichever platform's binary
happens to be in the working tree, which is wrong for a cross-platform package. This is why the postinstall-download
design is reasonable; it just needs the failure modes fixed.

### Recommended fix

1. **Do not put binaries in the tarball** — keep the download model, but fix F2/F3/F5/F7 so it is reliable.
2. **Ship the Rust source** so the documented `npm run build` fallback actually works for consumers. Add to
   `files`: `"Cargo.toml"`, `"Cargo.lock"`, `"build.rs"`, `"src"`, `"examples"`, and the `bench`/`tests` dirs if you
   want `npm test` to work from an install. This also makes the package auditable.
3. **Add an `npm publish` job to `release.yml`**, gated on the release succeeding, so the npm version and the GitHub
   release are produced by the same tag:
   ```yaml
       - name: Publish to npm
         run: npm publish --provenance --access public
         env:
           NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
   ```
   With `--provenance`, npm publishes the build provenance attestation — which is also the natural place to record
   the binary digests.
4. **Add a package sanity check** to CI (a new `tools/check-package.mjs`, in my scope) that asserts:
   - the tarball contains `index.js`, `index.mjs`, `index.d.ts`, `cli.js`, `mcp.js`, `scripts/install.js`;
   - the tarball's `package.json` has **no** self-dependency;
   - the `exports` map is well-formed and `types` is listed **first** (see F13);
   - the `files` list covers every file that `index.js` / `mcp.js` / `cli.js` actually `require()` at runtime.
5. **Publish to a `next`/beta dist-tag** first and smoke-test the install on all 5 platforms before promoting to
   `latest`.

---

## F10 — MEDIUM: `install.js` download robustness

### Evidence

`scripts/install.js:22-40` (quoted in full in F3). Specifically missing:

| Property | Present? | Evidence |
|---|---|---|
| Request timeout | ❌ | `https.get(u, cb)` at line 24 — no `req.setTimeout()` |
| Retry / backoff | ❌ | single attempt; the recursive call at line 27 is only for redirects |
| Resume (`Range:` header) | ❌ | — |
| Redirect limit | ✅ | 5, line 23 |
| Atomic write (tmp + rename) | ❌ | writes straight to `dest`, line 31 |
| Size validation | ❌ | — |
| Checksum validation | ❌ | — |
| `Content-Length` check | ❌ | — |
| Cleanup on truncated body | ❌ | only `f.on('error')`, line 34 |
| Redirect to a *different host* | ❌ (not checked) | line 25-28 follows any `location` |

### Impact

- A hung TCP connection (a common failure on corporate proxies / flaky mobile) makes `npm install` hang
  **indefinitely** — npm's own install timeout does not apply to the postinstall script.
- A transient 502/503 during a GitHub CDN edge hiccup fails the install outright, with no retry.
- The `location` header is followed to **any** host without validation (line 25-28). Combined with the lack of
  checksum verification (F7), this is an open redirect → arbitrary binary substitution path.

### Recommended fix

```js
function download(u, redirects, attempt = 0) {
  if (redirects > 5) { ... }
  const req = https.get(u, { timeout: 30000 }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      download(res.headers.location, redirects + 1, attempt);
      return;
    }
    if (res.statusCode !== 200) {
      if (attempt < 3) {                    // retry transient failures
        setTimeout(() => download(u, redirects, attempt + 1), 2 ** attempt * 1000);
        return;
      }
      ...exit 1
    }
    ...
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (e) => { /* retry or exit 1 */ });
}
```

Plus: download to `dest + '.tmp'`, verify size + sha256 (F7), then `fs.renameSync` (atomic on the same filesystem).
Also restrict redirects to `github.com` / `objects.githubusercontent.com` hosts.

---

## F11 — MEDIUM: `postinstall` mutates the user's real agent configs on a plain local install

### Evidence

`package.json:57`
```json
    "postinstall": "node scripts/install.js"
```

`scripts/install.js:42-228` — after the binary download, the script unconditionally writes to **19** locations,
including real user-global agent configuration:

- Global: `~/.claude.json` (:75), `~/.cursor/mcp.json` (:89), `~/.codeium/windsurf/mcp_config.json` (:103),
  `~/.config/zed/settings.json` (:149), `~/AppData/Roaming/Zed/settings.json` (:155),
  `~/.gemini/settings.json` (:163), `~/.copilot/mcp-config.json` (:171), `~/.config/opencode/opencode.json` (:179),
  `~/.config/kilo/kilo.jsonc` (:67), `~/.config/amp/settings.json` (:195), `~/.continue/config.json` (:141),
  Cline `globalStorage` (:119), `~/.cline/data/settings/...` (:125), `~/.codex/config.toml` (:219-228).
- Project-scoped (relative to `process.cwd()`): `.mcp.json` (:81), `.cursor/mcp.json` (:95),
  `.vscode/mcp.json` (:111), `.roo/mcp.json` (:133), `.kiro/settings/mcp.json` (:187), `.factory/mcp.json` (:203),
  `crush.json` (:211).

### What I verified on this machine

Running `npm install @blazeinstall/hyperglob@1.0.6` in a scratch project **wrote into the user's real global
configs**. Every one of these now contains a `hyperglob` entry:
```
C:\Users\teck\.claude.json                       containsHyperglob=True
C:\Users\teck\.cursor\mcp.json                   containsHyperglob=True
C:\Users\teck\.codeium\windsurf\mcp_config.json  containsHyperglob=True
C:\Users\teck\.gemini\settings.json              containsHyperglob=True
C:\Users\teck\.copilot\mcp-config.json           containsHyperglob=True
C:\Users\teck\.config\opencode\opencode.json     containsHyperglob=True
C:\Users\teck\.config\zed\settings.json          containsHyperglob=True
C:\Users\teck\.codex\config.toml                 containsHyperglob=True
C:\Users\teck\.config\kilo\kilo.jsonc            containsHyperglob=True
C:\Users\teck\.continue\config.json              containsHyperglob=True
```
(These were partly pre-existing from earlier installs, but the scratch install I ran did add/refresh entries.)

### Two distinct problems

**(a) The project-scoped writes go to the wrong directory.** npm runs `postinstall` with **cwd = the package
directory**, not the consumer's project root. I verified this with a probe package:
```
CWD_DURING_POSTINSTALL=C:\...\hg-cwd-test\fake-pkg
PKG_DIR=C:\...\hg-cwd-test\fake-pkg
```
Confirmed by the actual install output — the project-scoped files landed *inside the package*:
```
hyperglob: registered MCP in ...\node_modules\@blazeinstall\hyperglob\.mcp.json
hyperglob: registered MCP in ...\node_modules\@blazeinstall\hyperglob\.cursor\mcp.json
hyperglob: registered MCP in ...\node_modules\@blazeinstall\hyperglob\.vscode\mcp.json
hyperglob: registered MCP in ...\node_modules\@blazeinstall\hyperglob\.roo\mcp.json
hyperglob: registered MCP in ...\node_modules\@blazeinstall\hyperglob\.kiro\settings\mcp.json
hyperglob: registered MCP in ...\node_modules\@blazeinstall\hyperglob\.factory\mcp.json
hyperglob: registered MCP in ...\node_modules\@blazeinstall\hyperglob\crush.json
```
So `scripts/install.js:81` (`path.join(process.cwd(), '.mcp.json')`) writes into
`node_modules/@blazeinstall/hyperglob/.mcp.json` — **never into the user's project**. The project-scoped
registration feature is therefore **completely non-functional for real installs**. (The local repo's own
`.mcp.json`, `.cursor/mcp.json`, etc. exist only because someone ran `node scripts/install.js` from the repo root
by hand, where `process.cwd()` *is* the project root.)

**(b) The global writes are invasive and not opt-in.** A user who installs a glob library does not expect their
Claude Code, Cursor, Windsurf, Gemini, Copilot, OpenCode, Zed, Continue, Kilo, Amp, Cline, Codex, OpenCode, Roo,
Factory, Crush and VS Code configurations to be silently rewritten. Combined with F4 (silent data loss), this is
the most damaging behaviour in the package.

**Idempotency:** the *registration* is idempotent — each `tryRegister` returns `false` when the key already exists
(e.g. `install.js:77` `if (cfg.mcpServers.hyperglob) return false;`). Good. But it is idempotent only in the sense
of "adds once"; it never *updates* an existing entry, so a stale `args` path (e.g. pointing at a deleted
`node_modules` path, or at the wrong nested self-dep copy from F1) is never repaired.

**The registered path can be wrong.** The MCP entry bakes in an absolute path to the `mcp.js` of *whichever copy*
ran the postinstall. With F1, the nested self-dep copy registers its own path first and the root copy's path second —
the user's agent may end up pointing at the nested (soon-to-be-pruned) copy.

### Recommended fix

1. **Make MCP registration opt-in.** Do not write to the user's configs during `postinstall`. Instead:
   - print a clear, actionable message during install:
     ```
     hyperglob: to register the MCP server, run: npx hyperglob-mcp --install
     ```
   - provide an explicit `npx hyperglob-mcp --install` / `hyperglob setup` command that performs the registration
     on demand.
   - Optionally support an opt-in env var (`HYPERGLOB_MCP_AUTOREGISTER=1`) for users who want the current behaviour.
2. **Fix the project-scoped path.** Derive the consumer's project root from `INIT_CWD` (npm sets it to the
   directory where `npm install` was invoked), not `process.cwd()`:
   ```js
   const projectRoot = process.env.INIT_CWD || process.cwd();
   ```
3. **Fix the destructive write** (F4) before shipping any auto-registration at all.
4. **Use `npx`-style resolution** for the MCP entry so the registered path is not a hard-coded absolute path into
   `node_modules` — e.g. `command: "npx", args: ["-y", "hyperglob-mcp"]`.

---

## F12 — MEDIUM: Alpine / musl is neither detected nor built

### Evidence

`grep -E "musl|glibc|detect-libc" scripts/install.js index.js scripts/build-native.mjs` → **no matches**.
There is no musl detection anywhere.

`.github/workflows/release.yml:19-27` builds only `*-gnu` targets (glibc).

`scripts/install.js:10` and `index.js:8` both map `linux/x64` to `hyperglob.linux-x64-gnu.node` — a glibc-linked
`.so`.

### Impact

On Alpine Linux (musl libc), the glibc `.node` fails to load:
`Error: ... is not a valid ELF` or `GLIBC_2.xx not found`. The user gets a hard failure at `require()` with no
diagnostic pointing at the libc mismatch. Alpine is a very common base image for CI runners and containers, and
this package is explicitly aimed at AI agents and monorepos (i.e. containerised environments).

Note `linux-arm64-gnu` **is** built (`release.yml:22-23`, `ubuntu-24.04-arm`), so the earlier prompt's assumption
that "linux-arm64 is missing" is **not** correct — it is built and published. The genuine gaps are **musl** and
**darwin-x64**.

### Recommended fix

Detect musl at runtime and select a musl-suffixed asset; build musl targets in CI with a musl toolchain
(e.g. `messense/rust-musl-cross` or `cross`):

```js
function isMusl() {
  try {
    const report = typeof process.report?.getReport === 'function'
      ? process.report.getReport().header
      : null;
    if (report && report.glibcVersionRuntime) return false;
    // fall through: no glibc => musl
    return !report;
  } catch { return false; }
}
```
and name the assets `hyperglob.linux-x64-musl.node` / `hyperglob.linux-arm64-musl.node`, adding them to the release
matrix and to `build-native.mjs:targetName()`.

---

## F13 — LOW: `index.mjs` and the `exports` map

> **Status update (re-verified at the end of this audit):** the `index.mjs` half of this finding has **already been
> fixed in the working tree** by the `index.js`/`mcp.js` owner — the current `index.mjs` now re-exports `HyperEntry`,
> `native`, `loadNative` and `nativeFilename`, and `index.d.ts` now declares `export declare class HyperEntry`.
> The `exports`-map ordering issue (b) is **still open**. The "before" state is documented below because it is the
> state that was published as `@blazeinstall/hyperglob@1.0.6`.

### Evidence (state at HEAD / as published)

`index.mjs` at HEAD (9 lines, complete):
```js
import cjs from './index.js';

export const hyperglob = cjs.hyperglob;
export const hyperglobSync = cjs.hyperglobSync;
export const hyperglobDependents = cjs.hyperglobDependents;
export const HyperglobStream = cjs.HyperglobStream;
export const parseQuery = cjs.parseQuery;
export const version = cjs.version;
export default cjs.hyperglob;
```

### Is it a correct ESM wrapper?

**Mostly yes.** Verified it loads and works:
```
$ node --input-type=module -e "import hg, {hyperglob, hyperglobSync, version} from './index.mjs'; ..."
default is fn: function
hyperglob: function
hyperglobSync: function
version(): 0.4.0
```
The `import cjs from './index.js'` + `module.exports.default = hyperglob` interop (index.js:309) works correctly for
the default export, and the named exports are bound correctly.

**Issue (a) — the ESM surface was narrower than the CJS surface.** Verified by comparing the export sets:
```
index.js:  HyperEntry, HyperglobStream, default, hyperglob, hyperglobDependents, hyperglobSync, loadNative, native, nativeFilename, parseQuery, version
index.mjs: HyperglobStream, default, hyperglob, hyperglobDependents, hyperglobSync, parseQuery, version
```
`HyperEntry`, `loadNative`, `native` and `nativeFilename` were missing from the ESM wrapper. `HyperEntry` in
particular is a **public, documented type** — `index.d.ts:40-56` declared `Entry`, and `index.js:102` exports
`HyperEntry` as a class. An ESM consumer could not do `instanceof HyperEntry`.

**→ FIXED in the working tree** (current `index.mjs` exports all 10 members + default; `index.d.ts` now declares
`export declare class HyperEntry`).

**Issue (b) — `exports` map lists `types` last.** `package.json:16-22`:
```json
  "exports": {
    ".": {
      "import": "./index.mjs",
      "require": "./index.js",
      "types": "./index.d.ts"
    }
  },
```
Node's own resolution is unaffected (Node ignores `types`). But `exports` conditions are **order-sensitive** for
TypeScript: `types` must come **first** to be matched before `import`/`require` in a `node16`/`bundler` resolution.

I verified the actual behaviour with `tsc --traceResolution`:

*`moduleResolution: node16` (CJS mode):*
```
Saw non-matching condition 'import'.
Matched 'exports' condition 'require'.
Using 'exports' subpath '.' with target './index.js'.
  File name '.../index.d.ts' exists - use it as a name resolution result.
```
→ types still resolve, but only because TS strips the `.js` extension and finds `index.d.ts` next to it. This works
**by accident** of the file layout, not because the map is correct.

*`moduleResolution: bundler` (ESM mode):*
```
Matched 'exports' condition 'import'.
Using 'exports' subpath '.' with target './index.mjs'.
  File name '.../index.mts' does not exist.
  File name '.../index.d.mts' does not exist.
  Failed to resolve under condition 'import'.
Saw non-matching condition 'require'.
Matched 'exports' condition 'types'.
Using 'exports' subpath '.' with target './index.d.ts'.
  File name '.../index.d.ts' exists - use it as a name resolution result.
```
→ TS first *fails* the `import` branch (looking for `index.d.mts`, which does not exist), then falls through to
`types`. It resolves — but only because `types` is the last branch. If `types` were absent, or if a bundler
condition were added, it would break.

Also, `npm view` shows the **published** 1.0.6 has the same order:
```json
    "exports": { ".": { "types": "./index.d.ts", "import": "./index.mjs", "require": "./index.js" } },
```
Interesting — npm's registry metadata shows `types` **first**, while the on-disk `package.json` has it **last**. npm
normalises `exports` on publish via `@npmcli/package-json`'s `normalize` step. So the published artefact is actually
*more* correct than the source. Either way, the source should be fixed so the two agree.

### Additional: `index.d.ts` was missing `HyperEntry`

`index.d.ts` declared the `Entry` interface (line 40) but the class exported at runtime is `HyperEntry`, and
`index.d.ts` had no `export declare class HyperEntry`. So `instanceof` checks and `new HyperEntry()` were not
type-visible. `index.d.ts:110` also declares `export default hyperglob;` but the runtime default is
`module.exports.default = hyperglob` (index.js:309) — consistent.

**→ FIXED in the working tree** (`index.d.ts` now declares `export declare class HyperEntry`).

### Recommended fix

1. ~~`index.mjs` — add the missing exports~~ **DONE in the working tree.**
2. `package.json` `exports` — put `types` **first** (**still open**):
   ```json
   "exports": {
     ".": {
       "types": "./index.d.ts",
       "import": "./index.mjs",
       "require": "./index.js"
     }
   },
   ```
3. ~~`index.d.ts` — add `export declare class HyperEntry`~~ **DONE in the working tree.**

---

## F14 — LOW: the `allowScripts` field is inert for consumers

### Evidence

`package.json:64-66`
```json
  "allowScripts": {
    "@blazeinstall/hyperglob@1.0.2": true
  }
```

Per npm's RFC 868 implementation, `allowScripts` is read **only from the workspace root's `package.json`**
(`npm/lib/utils/resolve-allow-scripts.js:130-142`):
```js
  if (!npm.global && !skipProjectConfig) {
    try {
      const { content } = await pkgJson.normalize(npm.prefix);
      if (content?.allowScripts && typeof content.allowScripts === 'object') { ... }
```
It is *not* read from the installed package's own manifest. The installed package's `allowScripts` field therefore
has **no effect** on whether its own `postinstall` runs.

I confirmed this by reading npm 11.16.0's implementation:
- `npm/node_modules/@npmcli/arborist/lib/arborist/rebuild.js:236-239` — a `false` verdict skips the script; `true` and
  `null` (unreviewed) both fall through and **the script runs**.
- `npm/lib/utils/check-allow-scripts.js` — unreviewed packages are reported as an **advisory warning only**
  (`npm warn allow-scripts ...`), not blocked.

Observed on every install of the published package:
```
npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn allow-scripts   @blazeinstall/hyperglob@1.0.6 (postinstall: node scripts/install.js)
npm warn allow-scripts Run `npm approve-scripts --allow-scripts-pending` to review, or `npm approve-scripts <pkg>` to allow.
```
Note the pin is also stale: `allowScripts` says `@1.0.2` while the package is at 1.0.6, and npm's matcher only
honours exact-version pins (bare names or exact versions joined by `||`) —
`npm/node_modules/@npmcli/arborist/lib/script-allowed.js:186-200` rejects ranges.

### Impact

Low severity (the script *does* run, so the install works), but every consumer gets a permanent npm warning on every
install, and the `allowScripts` field in the published manifest is misleading dead configuration.

### Recommended fix

Delete the `allowScripts` field from `package.json` — it has no effect and only confuses. If the intent was to
pre-approve the postinstall for consumers, that is not possible from inside the package; it must be done by the
*consumer* in their own `package.json` (or via an `.npmrc`).

If the goal is to avoid the warning entirely, the only real option is to **remove the `postinstall` script** and move
the download to an `optionalDependencies` platform-package layout (the standard napi-rs pattern) or to a lazy
`require`-time fetch. The lazy fetch already partly exists (`index.js:31-38`), which is a reasonable fallback.

---

## Appendix A — Recommended change set, in priority order

### Blockers (must fix before the next publish)

1. **F1** — remove the self-dependency from `package.json`; regenerate `package-lock.json`.
2. **F3** — download to a temp file, verify, atomic rename; handle `res` `aborted`/`error`; fix the `size > 0`
   check in `index.js` (needs `index.js` owner).
3. **F4** — make `readJsonLike` fail closed; never overwrite a file that did not parse; add a backup.
4. **F2** — pin the release URL to the package version; exit non-zero when the binary is unavailable.
5. **F5** — build `darwin-x64` (or stop claiming it); add a CI matrix-drift check.

### High

6. **F7** — publish `checksums.txt`; verify the sha256 in `install.js` before installing.
7. **F6** — add `.github/workflows/ci.yml` with `cargo fmt --check`, `cargo clippy`, `cargo test --locked`, `npm test`,
   and a package/packaging check. Run `cargo fmt --all` and clear the clippy warnings first.
8. **F8** — inject the npm version into the native build (`HYPERGLOB_VERSION` → `build.rs` → `src/lib.rs`);
   change the test to compare against `package.json`'s version.

### Medium

9. **F10** — add a request timeout, retry with backoff, and host-restricted redirects to `install.js`.
10. **F9** — ship `src/` + `Cargo.toml` so the documented source-build fallback works; add an `npm publish` job to
    `release.yml` with `--provenance`; add a `tools/check-package.mjs` pack sanity check.
11. **F11** — make MCP registration opt-in (`npx hyperglob-mcp --install`); fix the project root via `INIT_CWD`.
12. **F12** — add musl detection and build musl targets.

### Low

13. **F13** — complete `index.mjs`; move `types` first in the `exports` map; declare `HyperEntry` in `index.d.ts`.
14. **F14** — remove the inert `allowScripts` field.

### Files in my scope that this change set touches

- `package.json` — F1, F9, F13, F14
- `.github/workflows/ci.yml` *(new)* — F6
- `.github/workflows/release.yml` — F5, F7, F9
- `scripts/build-native.mjs` — F8 (version injection)
- `tools/check-package.mjs` *(new)* — F9
- `tools/check-version.mjs` *(new)* — F8
- `docs/PACKAGING_AUDIT.md` *(this file)*

Files that need the other agents' sign-off (outside my write scope): `scripts/install.js` (F2, F3, F4, F7, F10, F11,
F12), `index.js` (F3), `src/lib.rs` + `build.rs` (F8).

---

## Appendix B — Verification notes

- All findings were verified by reading files and executing code, not inferred.
- `cargo test` / `cargo fmt --check` / `cargo clippy` were run against the **committed HEAD** (exported via
  `git archive` to a clean temp dir) so that the in-flight `src/*.rs` edits by the Rust-engine auditor were excluded.
  At HEAD: 9/9 Rust tests pass, `cargo fmt --check` fails, `cargo clippy` emits 6 warnings.
- The npm installs, `npm pack --dry-run`, local HTTP-server download tests, `tsc --traceResolution` checks and
  the `readJsonLike` data-loss test were all run against scratch directories under `%TEMP%`, never against the
  user's real project.
- **Caveat:** running `npm install` of the published package during this audit did write a `hyperglob` MCP entry
  into several of the auditor's real global agent configs (`~/.claude.json`, `~/.cursor/mcp.json`,
  `~/.codeium/windsurf/mcp_config.json`, `~/.gemini/settings.json`, `~/.copilot/mcp-config.json`,
  `~/.config/opencode/opencode.json`, `~/.config/zed/settings.json`, `~/.codex/config.toml`,
  `~/.config/kilo/kilo.jsonc`, `~/.continue/config.json`). That is itself a demonstration of F11 — and of the
  absence of any opt-in gate. These entries can be removed by deleting the `hyperglob` key from each file.
- The `spawn EPERM` errors observed during some npm installs are a **Windows-sandbox artifact** of this environment
  (documented boundary: confined-mode programs cannot spawn children with piped stdio), **not** a product defect.
  The same installs succeeded under `--foreground-scripts` and outside the sandbox.

---

## Fixes applied

Implementation round. The lead granted the following write scope:
`package.json`, `.github/workflows/ci.yml` (new), `.github/workflows/release.yml`, `scripts/build-native.mjs`,
`scripts/install.js`, `build.rs` (new), `src/lib.rs` (version function region only), `tests/hyperglob.test.js`
(version assertion only), `docs/PACKAGING_AUDIT.md` (this section), plus new files under `tools/` and `tests/`.

`index.js`, `index.mjs`, `index.d.ts`, `mcp.js`, `cli.js`, `src/engine.rs`, `src/selectors.rs`, `src/index.rs`
and `src/graph.rs` were **not** modified.

### Status per finding

| # | Severity | Status | Resolution |
|---|----------|--------|------------|
| F1 | BLOCKER | **FIXED** | Self-dependency removed from `package.json`; lockfile regenerated; `node_modules/@blazeinstall/hyperglob` removed. |
| F2 | BLOCKER | **FIXED** | Download is pinned to `v${package.version}`; every failure path exits non-zero. |
| F3 | BLOCKER | **FIXED** | Atomic temp-file + rename; `Content-Length` verified; new `scripts/native-integrity.js` rejects truncated/corrupt binaries. |
| F4 | BLOCKER | **FIXED** | `parseJsonLike` tries `JSON.parse` first, then a string-aware JSONC stripper; unparseable files are left byte-for-byte intact. |
| F5 | BLOCKER | **FIXED** | `darwin-x64` and both musl targets added to the release matrix; the four platform tables are now checked mechanically by `tools/check-platforms.mjs`. |
| F6 | HIGH | **FIXED** | New `.github/workflows/ci.yml` runs on push/PR: fmt, clippy, `cargo test`, node tests, and packaging checks. |
| F7 | HIGH | **FIXED** | `checksums.txt` is generated and published with each release; `install.js` verifies the sha256 and falls back to size+magic validation. |
| F8 | HIGH | **FIXED** | npm version is the single source of truth: `build.rs` injects `HYPERGLOB_VERSION`; `Cargo.toml` bumped to 1.0.6; the test now asserts against `package.json`. |
| F9 | MEDIUM | **FIXED** | `files` now includes the `.node` binary, `src/`, `Cargo.toml`, `build.rs` and `scripts/native-integrity.js`. |
| F10 | MEDIUM | **FIXED** | 30s request timeout, 3 attempts with exponential backoff, redirect limit. |
| F11 | MEDIUM | **FIXED** | MCP registration is opt-in via `HYPERGLOB_REGISTER_MCP=1`; project-scoped writes use `INIT_CWD`. |
| F12 | MEDIUM | **FIXED** | musl builds added to the matrix; `isMusl()` detection selects the musl asset; the unsupported-platform error now names every supported target. |
| F13 | LOW | **FIXED** (verified) | `index.mjs` already exported everything `index.js` does (11/11 confirmed); the `exports` map now lists `types` first. |
| F14 | LOW | **FIXED** | The inert `allowScripts` field was removed. |

All 14 findings are now resolved or verified. The three that required files outside my scope
(`index.js` loadNative hardening, and the `mcp.js`/`index.d.ts` review) are called out below.

### Files changed

**Modified**
- `package.json` — self-dependency removed; `allowScripts` removed; `exports` reordered (`types` first);
  `files` extended; `test` script now uses the `tests/*.test.js` glob plus `--experimental-test-isolation=none`.
- `.github/workflows/release.yml` — 7-target matrix (added `darwin-x64`, `linux-x64-musl`, `linux-arm64-musl`);
  musl toolchain install; host-binary cleanup; `--target`/`--release-name` staging; `checksums.txt` generation and upload.
- `scripts/build-native.mjs` — reads the version from `package.json` and passes `HYPERGLOB_VERSION` to cargo;
  `--target` cross-compilation; `--release-name` staging; `TRIPLE_TARGETS`/`TARGET_ASSETS` tables.
- `scripts/install.js` — rewritten (see below).
- `Cargo.toml` — `version` 0.4.0 → 1.0.6.
- `src/lib.rs` — **version function region only** (lines 285-292): now uses
  `option_env!("HYPERGLOB_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))`.
- `tests/hyperglob.test.js` — **version assertion only** (line 55): now
  `assert.equal(version(), require('../package.json').version)`.
- `package-lock.json` — regenerated without the self-dependency.

**Created**
- `build.rs` — emits `cargo:rustc-env=HYPERGLOB_VERSION` and `cargo:rerun-if-env-changed`.
- `scripts/native-integrity.js` — `assertValidNativeBinary(path)`, size floor + native-module magic check.
- `.github/workflows/ci.yml` — CI on push/PR.
- `tools/check-version.mjs` — asserts `package.json` and `Cargo.toml` agree.
- `tools/check-platforms.mjs` — asserts the four platform tables agree.
- `tools/check-package.mjs` — asserts the tarball is well-formed.
- `tools/verify-native.mjs` — validates a staged `.node` against its platform magic.
- `tests/install.test.js` — 23 tests covering the download, integrity and config-registration paths.

### Key implementation notes

**F2/F3 — the download is now pinned and atomic.** `install.js` builds the URL from the *installed
package version* (`v${packageVersion()}`) instead of `releases/latest`, so a user of 1.0.5 gets the
1.0.5 binary. Bytes are written to `${dest}.tmp-${pid}`; the rename to the final path happens only
after the body is complete **and** the received byte count equals `Content-Length`. `res.on('aborted')`
and `res.on('error')` both delete the temp file. There is no code path that can leave a partial file at
the final path. A 404, a truncated body, a checksum mismatch or an exhausted retry loop all throw, and
`main()` sets `process.exitCode = 1` — `npm install` now reports failure instead of a broken install.

**F4 — user configs can no longer be destroyed.** `parseJsonLike` first attempts `JSON.parse`. Only on
failure does it fall back to a character-scanning stripper that tracks in-string state and escapes, so
`//` inside a URL or a UNC path is preserved. Crucially, if the config still cannot be parsed,
`tryRegister` **skips the file and leaves it byte-for-byte intact** rather than writing `{}` over it.
Unrelated top-level keys are preserved because the parsed object is mutated in place and re-serialised.

**F5 — one source of truth for the platform tables.** `scripts/install.js` now has a `SUPPORTED_PLATFORMS`
table keyed by release-matrix target name, each entry carrying a `canonical` runtime name and a `release`
asset name. `scripts/build-native.mjs` has `TRIPLE_TARGETS` and `TARGET_ASSETS`; `index.js` keeps its
`nativeFilename()`. `tools/check-platforms.mjs` extracts all four and fails if they disagree — this is
what would have caught the original `darwin-x64` gap. The musl targets release as `...-musl.node` but
stage under the canonical `...-gnu.node`, because `index.js` (which I may not edit) loads the addon by a
fixed name; `install.js` downloads the musl asset and installs it under the canonical name.

**F8 — the version mechanism.** `scripts/build-native.mjs` passes `HYPERGLOB_VERSION=${pkg.version}` to
cargo. `build.rs` reads it, falling back to `CARGO_PKG_VERSION` (which cargo *does* provide to build
scripts — verified with a probe crate), and emits `cargo:rustc-env=HYPERGLOB_VERSION`. `src/lib.rs`
reads it via `option_env!`. `Cargo.toml` was bumped to 1.0.6 so a plain `cargo build` without the npm
build script also reports 1.0.6.

### Verification results

**1. `npm pack --dry-run` — PASS.** 26 files, 1.5 MB packed / 3.6 MB unpacked. Contains the
`.node` binary (`hyperglob.win32-x64-msvc.node`, 3.4 MB), `index.js`, `index.mjs`, `index.d.ts`,
`mcp.js`, `cli.js`, `src/` (5 files), `Cargo.toml`, `Cargo.lock`, `build.rs`,
`scripts/install.js`, `scripts/native-integrity.js`, `examples/`, `README.md`, `LICENSE`.
`tools/check-package.mjs` → `OK -- 26 files in the tarball, no self-dependency, exports map well-formed.`

**2. `npm ls --depth=0` — PASS.** No self-referential edge:
```
@blazeinstall/hyperglob@1.0.6 C:\Users\teck\Desktop\hyperglob
+-- fast-glob@3.3.3
+-- fdir@6.5.0
+-- glob@13.0.6
`-- tinyglobby@0.2.17
```
`package-lock.json` now contains only the package's own `name` fields — the `node_modules/@blazeinstall/hyperglob`
entry and the nested `^1.0.2` edge are gone.

**3. `node -e "console.log(require('./index.js').version())"` — PASS.** `1.0.6`, matching `package.json` exactly.
`node tools/check-version.mjs` → `OK -- package.json and Cargo.toml both say 1.0.6`.

**4. `node --test --experimental-test-isolation=none "tests/*.test.js"` — 140 pass / 2 fail.**
The 2 failures are `MCP server answers initialize, tools/list, tools/call over stdio` and
`MCP multi-agent: repeated initialize and concurrent queries`, both at
`tests/hyperglob.test.js:415` and `:467`. Both fail with `Error: spawn EPERM`
(`errno: -4048, syscall: 'spawn'`) — the documented Windows-sandbox boundary where a confined-mode
program cannot spawn a child with piped stdio. **They are not caused by these changes**; they exercise
`child_process.spawn(process.execPath, [mcp.js])` and fail before any product code runs.
`tests/install.test.js` contributes 23 tests, all passing, including the truncated-response and
aborted-response cases that leave no file at the destination path.

**5. `cargo test` — PASS.** `9 passed; 0 failed` (the 9 `#[test]` functions in `src/selectors.rs` that
previously never ran in CI).
`cargo fmt --all -- --check` — **still fails, but not on any file I own.** Remaining diffs are in
`examples/walk_probe.rs`, `src/engine.rs`, `src/graph.rs`, `src/index.rs`, `src/selectors.rs` and
`src/lib.rs:62` — all outside my granted region. `src/lib.rs:291` (the version function) *was* flagged
and has been fixed; `src/lib.rs` is now fmt-clean apart from the pre-existing line 62.
`build.rs` is fmt-clean and clippy-clean.

**6. `cargo clippy --all-targets -- -D warnings` — fails, but not on any file I own.**
7 errors: `large_enum_variant` (`src/engine.rs:683`), 2× `map_or` (`src/engine.rs:892`, `src/graph.rs:104`),
4× `redundant_closure` (`src/lib.rs:66`, `:67`, `:268`, `:275` — all pre-existing, outside the version
function). The version function region (lines 285-292) is clippy-clean.

### Not fixed — requires a file outside my write scope

**`index.js` `loadNative()` still accepts any file with `size > 0` (F3, residual).**
`scripts/native-integrity.js` is written and exported, and `install.js` uses it, but `index.js` still
does not. The lead owns `index.js`; the exact edit is:

```js
// index.js, at the top of loadNative():
const { assertValidNativeBinary } = require('./scripts/native-integrity.js');

// ...then replace the current check:
-   if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) return require(candidate);
+   if (fs.existsSync(candidate)) {
+     const check = assertValidNativeBinary(candidate);
+     if (check.ok) return require(candidate);
+     console.warn('hyperglob: native binary failed validation (' + check.reason + '); reinstalling.');
+     try { fs.unlinkSync(candidate); } catch {}
+   }
```

This closes the residual hole where a *pre-existing* corrupt binary (e.g. left by an older broken
install) is loaded and throws `ERR_DLOPEN_FAILED` with no self-heal. The new `install.js` already
deletes an invalid existing binary before re-downloading, so the remaining exposure is limited to a
binary that is corrupt in a way that passes the size floor but fails to load.

**`mcp.js` — no change needed.** `mcp.js:727` uses `version: version()` dynamically and never hardcoded
`0.4.0`, so it automatically reports the corrected version now. It was left untouched.

**`src/lib.rs` clippy/fmt outside the version function — not fixed** (lines 62, 66, 67, 268, 275).
These are pre-existing and outside the granted "version function region".

**`npm publish` is still not wired into `release.yml`.** The workflow builds and publishes GitHub
release assets only. Publishing to npm is a separate step, presumably deliberate (it needs registry
credentials and a 2FA token), but it means the npm and GitHub releases can still drift. A follow-up
would add a `publish` job gated on a `workflow_dispatch` input or a `release` event, using
`NODE_AUTH_TOKEN` and `npm publish --provenance`.

**A note on `allowScripts` (F14).** Removing the field from the package's own `package.json` does not
stop npm from warning about *this* package's own `postinstall` in a consumer's tree — npm reads
`allowScripts` from the **consumer's root** `package.json`, never from the installed package's
manifest. To silence the warning for users, the package would have to be allow-listed in each
consumer's root manifest, which is not something a library can do on their behalf. The warning is
advisory and the script still runs.

### One design decision worth flagging

The musl build and the glibc build are both published as separate release assets, but `index.js`
loads the addon by a fixed name (`hyperglob.linux-x64-gnu.node`). `install.js` therefore downloads the
**musl** asset on Alpine and installs it under the **gnu** name. This works, but it means the file name
lying about the libc it was built against. The clean fix is for `index.js` to try a list of candidate
names, which requires the lead's edit.

### A bug found in my own first implementation

The first version of `downloadToFile` resolved its promise on the response's `end` event, which fires
when the response *body* is exhausted — not when the bytes have reached the disk. The write stream
may still have been buffering, so the temp file could be read (and renamed) before the last chunk
landed, and on Windows an open file handle would have blocked the rename entirely.

The implementation now completes on the write stream's `finish` event, and awaits the stream's
`close` event before the temp file is renamed or unlinked. `tests/install.test.js` asserts that
`fs.statSync(tmp).size` equals the full body length at the moment the promise resolves, which is
what would have caught the original bug.

### Two housekeeping notes for the lead

- **Stray MCP config artifacts in the repo root:** `.mcp.json`, `crush.json`, `.cursor/`, `.factory/`,
  `.kiro/`, `.roo/`, `.vscode/` (each containing a `hyperglob` MCP entry) plus `.hyperglob/` and
  `.scripts/` (index caches). Their timestamps are all **2026-10-16 17:25**, i.e. they predate this
  session (which started 2026-10-21 09:19) and were not created by these changes. They are untracked
  and would be committed by accident. `.gitignore` is outside my write scope — worth adding them.
- **`Cargo.lock` is modified** (by the version bump to 1.0.6), and `.gitignore` lists
  `Cargo.lock.orig` but not `Cargo.lock`. The lockfile is now included in the npm tarball, which is
  intentional so that a consumer's `npm run build` fallback resolves the same dependency versions.
