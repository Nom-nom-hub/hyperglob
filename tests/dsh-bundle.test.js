'use strict';

// Tests for the DeepSeek Harness bundle.
//
// The bundle is what wires hyperglob into the Harness as
// mcp__hyperglob__hyperglob_query / _paths / _dependents. Its correctness
// depends on a few Harness-specific contracts that are easy to break and
// impossible to notice until a session boots without its tools:
//
//   - package.json declares dsh.bundle.patch, pointing at the patch file.
//   - The patch file inserts a row whose `name` is a RELATIVE path. The
//     Harness rewrites a relative name in an inserted row to a file URL
//     beside the patch file; an absolute name would break the moment the
//     bundle is installed anywhere but this checkout.
//   - The plugin resolves the MCP server relative to itself, because a
//     bundle's config values cannot name the bundle's own files.
//   - The server is spawned with an absolute node path and a non-empty
//     cwd, because the Harness scrubs the child's environment.
//
// These tests are static: they read the shipped files and assert the
// contracts. Booting a Harness is not something a unit test can do.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const PATCH_PATH = 'cordis.patch.yml';
const PLUGIN_PATH = path.join('dsh-plugin', 'index.mjs');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('the package declares a DSH bundle', () => {
  assert.ok(pkg.dsh, 'package.json has no dsh section');
  assert.ok(pkg.dsh.bundle, 'package.json has no dsh.bundle section');
  assert.equal(pkg.dsh.bundle.patch, `./${PATCH_PATH}`);
});

test('the bundle patch and plugin are published', () => {
  assert.ok(
    pkg.files.includes(PATCH_PATH),
    `the "files" list must include ${PATCH_PATH}`
  );
  assert.ok(
    pkg.files.includes('dsh-plugin'),
    'the "files" list must include the dsh-plugin directory'
  );
});

test('the patch file inserts the plugin with a relative name', () => {
  const patch = read(PATCH_PATH);
  assert.match(patch, /^\s*-\s+insert:/m, 'the patch must have an insert list');

  // The inserted row's name must stay relative: the Harness anchors it
  // beside the patch file, which is the only bundle-relative anchor it
  // provides.
  const names = [...patch.matchAll(/^\s+name:\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map(
    (m) => m[1].trim()
  );
  assert.ok(names.length > 0, 'the patch inserts no named row');

  for (const name of names) {
    assert.ok(
      name.startsWith('./') || name.startsWith('../'),
      `the inserted plugin name must be relative, got ${JSON.stringify(name)}`
    );
    assert.ok(
      !/^[A-Za-z]:[\\/]/.test(name) && !name.startsWith('/'),
      `the inserted plugin name must not be absolute, got ${JSON.stringify(name)}`
    );
  }

  assert.ok(
    names.some((n) => n.replace(/\\/g, '/') === `./${PLUGIN_PATH.split(path.sep).join('/')}`),
    `the patch must insert ./${PLUGIN_PATH.split(path.sep).join('/')}`
  );
});

test('the plugin resolves the MCP server from its own location', () => {
  const plugin = read(PLUGIN_PATH);

  // The server path has to be derived from import.meta.url; the bundle
  // cannot hard-code an install path.
  assert.match(plugin, /import\.meta\.url/, 'the plugin must anchor on import.meta.url');
  assert.match(plugin, /fileURLToPath/, 'the plugin must convert the file URL to a path');

  // mcp.js lives in the package root, one level above dsh-plugin/.
  assert.match(
    plugin,
    /path\.(?:join|resolve)\([^)]*['"]mcp\.js['"]/,
    'the plugin must point at mcp.js'
  );
});

test('the plugin spawns the server with an absolute command and a cwd', () => {
  const plugin = read(PLUGIN_PATH);

  // A bare "node" fails: the Harness scrubs the child's PATH.
  assert.match(plugin, /process\.execPath/, 'the command must be process.execPath');
  assert.doesNotMatch(
    plugin,
    /command:\s*['"]node['"]/,
    'the command must not be a bare "node"'
  );

  // An empty cwd makes the spawn fail with ENOENT.
  assert.match(plugin, /cwd:\s*(?!['"]\s*['"])\S/, 'the plugin must set a non-empty cwd');
  assert.doesNotMatch(plugin, /cwd:\s*['"]['"]/, 'the cwd must not be empty');
});

test('the plugin registers the MCP client under the hyperglob server name', () => {
  const plugin = read(PLUGIN_PATH);
  assert.match(plugin, /serverName:\s*['"]hyperglob['"]/, 'the server name must be hyperglob');
  assert.match(
    plugin,
    /name:\s*['"]@deepseek-ai\/dsh-mcp-client['"]/,
    'the plugin must load the Harness MCP client'
  );
  assert.match(plugin, /transport:\s*['"]stdio['"]/, 'the transport must be stdio');
});

test('the plugin validates its config with a Standard Schema', () => {
  const plugin = read(PLUGIN_PATH);

  // The Harness validates a plugin's config through the "~standard"
  // protocol. A plain object here fails at load with
  // "Cannot read properties of undefined (reading 'validate')".
  assert.match(
    plugin,
    /['"]~standard['"]/,
    'the Config schema must implement the ~standard protocol'
  );
  assert.match(plugin, /validate\s*\(/, 'the schema must provide a validate function');
});

test('the plugin fails loudly when the server cannot be reached', () => {
  const plugin = read(PLUGIN_PATH);
  assert.match(
    plugin,
    /failOnStartupError/,
    'the plugin must set failOnStartupError so a broken install is visible'
  );
});

test('the DSH guide documents the install and the pitfalls', () => {
  const guide = read(path.join('docs', 'dsh.md'));
  assert.match(guide, /pnpm add @blazeinstall\/hyperglob/, 'the install command is missing');
  assert.match(guide, /"bundles"/, 'the bundles list is not documented');
  assert.match(guide, /"profile"/, 'the profile section is not documented');
  assert.match(guide, /mcp__hyperglob__hyperglob_query/, 'the tool names are missing');
  assert.match(guide, /mcp__hyperglob__hyperglob_paths/, 'the tool names are missing');
  assert.match(guide, /mcp__hyperglob__hyperglob_dependents/, 'the tool names are missing');
  assert.match(guide, /process\.execPath/, 'the node-path pitfall is not documented');
  assert.match(guide, /ENOENT/, 'the cwd pitfall is not documented');
});
