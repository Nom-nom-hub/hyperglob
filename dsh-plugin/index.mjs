// A DeepSeek Harness plugin that exposes hyperglob's MCP server.
//
// WHY A PLUGIN RATHER THAN A BARE PATCH ROW
//
// The Harness's patch format gives a bundle exactly one bundle-relative
// anchor: a relative `name:` in an inserted row is rewritten to a file URL
// beside the patch file (see `anchorInsertedPluginNames` in dsh-app-boot).
// Config values such as `args` and `cwd` get no such treatment, so a
// bundle cannot name its own files in them -- and a bare `mcp.js` would be
// resolved against the Harness's working directory, not the bundle's.
//
// This plugin closes that gap. It is loaded from the bundle directory, so
// `import.meta.url` is a reliable anchor for the bundle's own files, and
// it registers the MCP server with paths derived from there.
//
// It also gives hyperglob a first-class home inside the Harness: the
// model is told the session's working directory in the system prompt
// ("Current working directory: <path>") and passes it on every call, so
// hyperglob searches the right tree without the server needing to know it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The package root -- the directory holding mcp.js and the native binding. */
const root = path.dirname(here);

/** The MCP server entry point, in the package root. */
const SERVER = path.join(root, 'mcp.js');

/** The default per-call timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * A minimal Standard Schema for the plugin's config.
 *
 * The Harness validates a plugin's config through the `~standard` protocol
 * (see `resolveConfig` in @deepseek-ai/cordis). The Harness's own schema
 * library is an internal dependency, so this implements the protocol
 * directly rather than depending on it: two optional fields, each with a
 * default and a range check.
 */
const Config = {
  '~standard': {
    version: 1,
    vendor: '@blazeinstall/hyperglob-dsh',
    validate(value) {
      const input = value ?? {};
      const issues = [];

      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        issues.push({ path: ['timeoutMs'], message: 'timeoutMs must be a positive finite number' });
      }

      const failOnStartupError = input.failOnStartupError ?? true;
      if (typeof failOnStartupError !== 'boolean') {
        issues.push({ path: ['failOnStartupError'], message: 'failOnStartupError must be a boolean' });
      }

      if (issues.length) return { issues };
      return { value: { timeoutMs, failOnStartupError } };
    },
  },
};

export function apply(ctx, config) {
  const loader = ctx.get('loader');
  if (!loader) {
    ctx.logger.warn('hyperglob: the loader service is unavailable; hyperglob tools are not registered');
    return;
  }

  loader.create({
    id: 'mcp-hyperglob',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'hyperglob',
      transport: 'stdio',
      // The absolute path of the node binary running the Harness. A bare
      // "node" is not reliable: the server is spawned with a scrubbed
      // environment whose PATH need not contain the node install.
      command: process.execPath,
      args: [SERVER],
      // An empty cwd makes the spawn fail with ENOENT, so the server is
      // started in the directory holding mcp.js. The model passes the
      // session's working directory explicitly on every call.
      cwd: root,
      // A missing native binding is a real problem, and a silent "no
      // tools" is far harder to diagnose than a failed start.
      failOnStartupError: config.failOnStartupError,
      toolCallTimeoutMs: config.timeoutMs,
    },
  });
}

export { Config };
export const name = '@blazeinstall/hyperglob-dsh';
