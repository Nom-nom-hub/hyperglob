> How to install hyperglob as a DeepSeek Harness bundle so every session gets `mcp__hyperglob__*` tools.

# DeepSeek Harness

hyperglob ships as a [DeepSeek Harness](https://github.com/deepseek-ai) **bundle**.
Installing the bundle registers hyperglob's three MCP tools with the Harness,
so any model running in that profile can find files by glob + selector without
leaving the conversation.

| Tool | What it does |
| --- | --- |
| `mcp__hyperglob__hyperglob_query` | Find files by glob pattern and selector, with sizes and timestamps. |
| `mcp__hyperglob__hyperglob_paths` | The same discovery, paths only — the fastest form. |
| `mcp__hyperglob__hyperglob_dependents` | The import-graph dependents of a file. |

## Install

The bundle is a normal npm package, so it installs like one. From your
Harness profile directory:

```bash
cd ~/.dsh/profiles/desktop
pnpm add @blazeinstall/hyperglob
```

Then list the bundle in the profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@blazeinstall/hyperglob"
      ]
    }
  }
}
```

Restart the Harness. The three `mcp__hyperglob__*` tools are now available
to every session in that profile.

> The `desktop` profile is managed by the Electron application, so `dsh` CLI
> commands refuse it. Use the `web` or `headless` profile for scripted checks.

### Developing against a local checkout

Point the profile at a working copy instead of the published package:

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:/path/to/hyperglob
```

The bundle resolves the MCP server through its own installed location, so a
linked checkout works exactly like a published one — rebuild the native
binding with `npm run build` after changing the Rust core.

## How it works

A bundle is an npm package that declares a patch file:

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

hyperglob's `cordis.patch.yml` inserts a single row:

```yaml
- insert:
    - id: hyperglob-dsh
      name: './dsh-plugin/index.mjs'
```

The row's `name` is a **relative** path on purpose. The Harness rewrites a
relative plugin name in an inserted row to a file URL beside the patch file,
so the plugin is found wherever the bundle happens to be installed. This
matters because config values do not get the same treatment: a bundle cannot
name its own files in a row's `args` or `cwd`, and a bare `mcp.js` would be
resolved against the Harness's working directory instead of the bundle's.

The plugin anchors itself with `import.meta.url` and registers the MCP
server from there:

```js
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);          // the package root, holding mcp.js
const SERVER = path.join(root, 'mcp.js');

loader.create({
  id: 'mcp-hyperglob',
  name: '@deepseek-ai/dsh-mcp-client',
  config: {
    serverName: 'hyperglob',
    transport: 'stdio',
    command: process.execPath,           // absolute node path
    args: [SERVER],
    cwd: root,                            // never empty
    failOnStartupError: true,
    toolCallTimeoutMs: 120_000,
  },
});
```

Two details are load-bearing:

- **`command: process.execPath`.** The Harness scrubs the environment it
  passes to MCP servers, and the scrubbed `PATH` need not contain the Node
  install. A bare `"node"` fails with `spawn node ENOENT`; the absolute path
  of the running Node binary always works.
- **`cwd` is never empty.** An empty `cwd` makes the spawn fail with `ENOENT`.
  The server starts in the package root; the model passes the session's
  working directory explicitly on every call, so the server itself does not
  need to know it.

## Configuration

The plugin accepts two options. They are set on the inserted row in your own
profile patch, or in the bundle's own `cordis.patch.yml`:

```yaml
- id: hyperglob-dsh
  name: './dsh-plugin/index.mjs'
  config:
    timeoutMs: 120000
    failOnStartupError: true
```

| Option | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | `120000` | The per-call timeout for a hyperglob tool call. |
| `failOnStartupError` | `true` | Fail the plugin's start when the MCP server cannot be reached. |

`failOnStartupError: true` is the default on purpose. A missing native
binding is a real problem, and a silently absent tool is much harder to
diagnose than a failed start.

## Working directory

Every hyperglob MCP tool takes an optional `cwd`. The Harness puts the
session's working directory in the system prompt:

```
Current working directory: "C:\\path\\to\\project"
```

so a model can pass it straight through and search the right tree:

```json
{
  "pattern": "src/**/*.ts",
  "cwd": "C:\\path\\to\\project"
}
```

Without a `cwd`, the tools search the server's own working directory — the
package root. That is almost never what you want, so pass it.

## Verifying the install

Check that the server started and the tools registered. A healthy boot logs
nothing about `mcp-hyperglob`; a broken one logs the reason:

```
mcp-hyperglob (@deepseek-ai/dsh-mcp-client): Error: mcp-client(hyperglob):
initial connection or tool synchronization failed
```

Common failures:

| Symptom | Cause |
| --- | --- |
| `spawn node ENOENT` | The command was a bare `node`; use `process.execPath`. |
| `ENOENT` with no command | The `cwd` was empty. |
| `Cannot find module .../mcp.js` | The plugin resolved the server path wrong; it must be `path.join(root, 'mcp.js')`. |
| `no tools registered` | The native binding is missing; run `npm run build`. |

The fastest end-to-end check is to ask the model to run
`mcp__hyperglob__hyperglob_paths` with a `cwd` pointing at a directory you
know, and confirm the paths come back relative to it.

## Using it outside the Harness

The same server speaks plain MCP over stdio, so any MCP client can use it:

```bash
npx @blazeinstall/hyperglob-mcp
```

See [MCP](mcp.html) for the full tool reference, timeouts, and the other
clients hyperglob supports.

## See also

- [MCP](mcp.html) — the tool reference and the other MCP clients.
- [Getting started](getting-started.html) — the API and CLI in five minutes.
- [Architecture](architecture.html) — how the Rust core works.
