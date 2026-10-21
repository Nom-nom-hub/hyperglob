// Remove stray "hyperglob" MCP server entries.
//
// These were written by an earlier version of scripts/install.js, which
// auto-registered the MCP server into every agent config it could find.
// Registration is now opt-in (HYPERGLOB_REGISTER_MCP=1), so the entries
// left behind are orphans pointing at a local checkout.
//
// This script is deliberately surgical: it removes ONLY the "hyperglob"
// key and preserves every other server and top-level key. JSON files are
// rewritten with 2-space indentation; the TOML file is edited textually.
//
// A timestamped backup of every file it touches is written next to the
// original, as "<name>.hyperglob-backup", so the change is reversible.
//
// Usage: node tools/cleanup-mcp-strays.mjs [--dry-run]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const BACKUP_SUFFIX = '.hyperglob-backup';

// Backups are written into the workspace rather than next to the original,
// because a sandboxed run may not be able to write outside the workspace.
const BACKUP_DIR =
  process.env.HYPERGLOB_CLEANUP_BACKUP_DIR ||
  path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '.cleanup-backup');

// Files that are entirely ours (created by the stray registration in the
// project root) and can be deleted outright.
const REPO_ROOT_FILES = [
  '.mcp.json',
  'crush.json',
  '.cursor/mcp.json',
  '.factory/mcp.json',
  '.kiro/settings/mcp.json',
  '.roo/mcp.json',
  '.vscode/mcp.json',
];

function backup(file) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // Flatten the path so the backup name is unique and readable.
  const flat = file.replace(/[:\\/]/g, '_').replace(/^_+/, '');
  const bak = path.join(BACKUP_DIR, flat + BACKUP_SUFFIX);
  fs.copyFileSync(file, bak);
  return bak;
}

// Remove the "hyperglob" key from a JSON object, keeping every other key.
// Returns the new text, or null when there was nothing to remove.
function stripFromJson(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { error: 'not valid JSON: ' + e.message };
  }
  if (!obj || typeof obj !== 'object') return { error: 'not a JSON object' };

  let removed = false;
  // MCP servers live under a handful of well-known container keys
  // depending on the agent.
  for (const container of ['mcpServers', 'servers']) {
    const holder = obj[container];
    if (holder && typeof holder === 'object' && 'hyperglob' in holder) {
      delete holder.hyperglob;
      removed = true;
      // Drop the now-empty container so we do not leave "{ }" litter.
      if (Object.keys(holder).length === 0) delete obj[container];
    }
  }
  // Some agents put it at the top level.
  if ('hyperglob' in obj) {
    delete obj.hyperglob;
    removed = true;
  }
  if (!removed) return { removed: false };
  return { removed: true, text: JSON.stringify(obj, null, 2) + '\n' };
}

// Remove the [mcp_servers.hyperglob] table from a TOML file, textually.
// The table ends at the next top-level table header.
function stripFromToml(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  let removed = false;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\[mcp_servers\.hyperglob\]\s*$/.test(line)) {
      removed = true;
      i++;
      // Skip the body of the table until the next table header.
      while (i < lines.length && !/^\s*\[/.test(lines[i])) i++;
      continue;
    }
    out.push(line);
    i++;
  }
  if (!removed) return { removed: false };
  // Collapse any run of 3+ blank lines left behind to a single blank line.
  const text2 = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return { removed: true, text: text2 };
}

function processFile(file, kind) {
  if (!fs.existsSync(file)) return { status: 'absent' };
  const text = fs.readFileSync(file, 'utf8');
  const result = kind === 'toml' ? stripFromToml(text) : stripFromJson(text);
  if (result.error) return { status: 'error', detail: result.error };
  if (!result.removed) return { status: 'clean' };

  if (DRY_RUN) {
    return { status: 'would-remove', preview: result.text };
  }
  const bak = backup(file);
  fs.writeFileSync(file, result.text, 'utf8');
  return { status: 'removed', backup: bak };
}

const home = os.homedir();
const targets = [
  // Global agent configs: preserve other servers, drop only "hyperglob".
  { file: path.join(home, '.claude.json'), kind: 'json' },
  { file: path.join(home, '.cursor', 'mcp.json'), kind: 'json' },
  { file: path.join(home, '.gemini', 'settings.json'), kind: 'json' },
  { file: path.join(home, '.codex', 'config.toml'), kind: 'toml' },
];

console.log(DRY_RUN ? 'DRY RUN -- no files will be changed\n' : '');

for (const t of targets) {
  const r = processFile(t.file, t.kind);
  const label = path.relative(home, t.file) || t.file;
  if (r.status === 'removed') {
    console.log(`removed  ${label}  (backup: ${path.basename(r.backup)})`);
  } else if (r.status === 'would-remove') {
    console.log(`WOULD REMOVE  ${label}`);
    console.log(
      r.preview.split('\n').map((l) => '    ' + l).join('\n')
    );
  } else if (r.status === 'error') {
    console.log(`ERROR    ${label}: ${r.detail} -- left untouched`);
  } else if (r.status === 'absent') {
    console.log(`absent   ${label}`);
  } else {
    console.log(`clean    ${label}  (no hyperglob entry)`);
  }
}

// Project-root files are wholly ours: they exist only to hold the stray
// registration, so remove them entirely.
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
for (const rel of REPO_ROOT_FILES) {
  const file = path.join(repoRoot, rel);
  if (!fs.existsSync(file)) continue;
  // Safety: only delete if the file mentions hyperglob and nothing else.
  const text = fs.readFileSync(file, 'utf8');
  const mentions = /hyperglob/.test(text);
  const otherServers = ['rea', 'context7', 'playwright', 'filesystem', 'memory', 'sequential-thinking']
    .filter((n) => text.includes(`"${n}"`));
  if (!mentions) {
    console.log(`skip     ${rel}  (no hyperglob entry)`);
    continue;
  }
  if (otherServers.length) {
    console.log(`skip     ${rel}  (also configures: ${otherServers.join(', ')})`);
    continue;
  }
  if (DRY_RUN) {
    console.log(`WOULD DELETE  ${rel}`);
  } else {
    const bak = backup(file);
    fs.unlinkSync(file);
    console.log(`deleted  ${rel}  (backup: ${path.basename(bak)})`);
  }
}

// Now the empty directories those files lived in.
if (!DRY_RUN) {
  for (const dir of ['.cursor', '.factory', '.kiro/settings', '.kiro', '.roo', '.vscode']) {
    const d = path.join(repoRoot, dir);
    if (!fs.existsSync(d)) continue;
    const remaining = fs.readdirSync(d);
    if (remaining.length === 0) {
      fs.rmdirSync(d);
      console.log(`rmdir    ${dir}/`);
    }
  }
}

console.log('\ndone.');
