'use strict';
// hyperglob postinstall.
//
// 1. Ensure a native prebuilt binary for this platform exists, downloading it
//    from the GitHub release that matches the *installed package version*.
//    The download is written to a temp file and atomically renamed into place
//    only after it has been fully received and its integrity verified, so a
//    partial file can never be left at the final path.
// 2. Optionally register the MCP server in local agent configurations.
//
// See docs/PACKAGING_AUDIT.md for the findings this file implements.
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const { assertValidNativeBinary } = require('./native-integrity.js');

const REPO = 'Nom-nom-hub/hyperglob';
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

// Every platform/arch pair the project supports.
//
//   canonical -- the file name index.js loads at runtime. On musl systems this
//                is still the "-gnu" name, because index.js (owned by another
//                agent) looks the addon up by a fixed name.
//   release   -- the asset name uploaded to the GitHub release.
//
// The keys are the release-matrix target names used in
// .github/workflows/release.yml, so the two can be compared mechanically by
// `tools/check-platforms.mjs` (run by ci.yml).
const SUPPORTED_PLATFORMS = {
  'linux-x64-gnu': {
    canonical: 'hyperglob.linux-x64-gnu.node',
    release: 'hyperglob.linux-x64-gnu.node',
  },
  'linux-arm64-gnu': {
    canonical: 'hyperglob.linux-arm64-gnu.node',
    release: 'hyperglob.linux-arm64-gnu.node',
  },
  'linux-x64-musl': {
    canonical: 'hyperglob.linux-x64-gnu.node',
    release: 'hyperglob.linux-x64-musl.node',
  },
  'linux-arm64-musl': {
    canonical: 'hyperglob.linux-arm64-gnu.node',
    release: 'hyperglob.linux-arm64-musl.node',
  },
  'darwin-x64': {
    canonical: 'hyperglob.darwin-x64.node',
    release: 'hyperglob.darwin-x64.node',
  },
  'darwin-arm64': {
    canonical: 'hyperglob.darwin-arm64.node',
    release: 'hyperglob.darwin-arm64.node',
  },
  'win32-x64-msvc': {
    canonical: 'hyperglob.win32-x64-msvc.node',
    release: 'hyperglob.win32-x64-msvc.node',
  },
};

// The platform/arch -> asset name table. MUST stay in sync with:
//   * the release matrix in .github/workflows/release.yml
//   * targetName() in scripts/build-native.mjs
//   * nativeFilename() in index.js
// `tools/check-platforms.mjs` (run by ci.yml) fails the build if they drift.
function nativeFilename() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return 'hyperglob.linux-x64-gnu.node';
  if (platform === 'linux' && arch === 'arm64') return 'hyperglob.linux-arm64-gnu.node';
  if (platform === 'darwin' && arch === 'x64') return 'hyperglob.darwin-x64.node';
  if (platform === 'darwin' && arch === 'arm64') return 'hyperglob.darwin-arm64.node';
  if (platform === 'win32' && arch === 'x64') return 'hyperglob.win32-x64-msvc.node';
  return null;
}

// True on musl-based Linux (Alpine and friends), where the glibc build
// cannot be loaded.
function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    const header = process.report && process.report.getReport && process.report.getReport().header;
    if (header && header.glibcVersionRuntime) return false; // glibc
  } catch (e) { /* fall through to the musl probe */ }
  const machine = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  try {
    if (fs.existsSync('/lib/ld-musl-' + machine + '.so.1')) return true;
    if (fs.existsSync('/lib/libc.musl-' + machine + '.so.1')) return true;
  } catch (e) { /* ignore */ }
  return false;
}

// The asset to download from the GitHub release. On musl systems this is the
// musl build; the downloaded bytes are then installed under the canonical
// name that index.js expects.
function releaseAssetName() {
  const canonical = nativeFilename();
  if (!canonical) return null;
  if (isMusl() && canonical.endsWith('-gnu.node')) {
    return canonical.replace('-gnu.node', '-musl.node');
  }
  return canonical;
}

function packageVersion() {
  try {
    return require('../package.json').version;
  } catch (e) {
    return null;
  }
}

const version = packageVersion();
const file = nativeFilename();
const dest = path.join(__dirname, '..', file);

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

// Parse a sha256sum-style manifest: "<hex>  <name>" per line.
function parseChecksums(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?(\S.*?)\s*$/i);
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

function get(url, redirects) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const req = client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) {
          reject(new Error('too many redirects'));
          return;
        }
        resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
      }
      resolve(res);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('request timed out after ' + REQUEST_TIMEOUT_MS + 'ms'));
    });
    req.on('error', reject);
  });
}

async function getText(url) {
  const res = await get(url, 0);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error('status=' + res.statusCode);
  }
  return await new Promise((resolve, reject) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve(data));
    res.on('error', reject);
  });
}

// Download `url` to `target`. The bytes are written to a temp path and the
// caller is expected to rename it into place only after validation. The
// transfer must complete fully: if the server declared a Content-Length, the
// received byte count must match it exactly, otherwise the download is
// rejected and the temp file removed.
async function downloadToFile(url, target) {
  const tmp = target + '.tmp-' + process.pid;
  try {
    fs.unlinkSync(tmp);
  } catch {}

  let res;
  try {
    res = await get(url, 0);
  } catch (e) {
    throw new Error('download request failed: ' + e.message);
  }

  if (res.statusCode !== 200) {
    res.resume();
    throw new Error('status=' + res.statusCode);
  }

  const expectedLength = Number(res.headers['content-length']);
  let received = 0;
  let failed = null;
  let closed = null;

  await new Promise((resolve) => {
    const out = fs.createWriteStream(tmp);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // The write stream must be fully closed before the temp file can be
    // renamed or unlinked (on Windows an open handle blocks both).
    closed = new Promise((r) => out.on('close', r));

    const fail = (err) => {
      if (!failed) failed = err;
      out.destroy();
      done();
    };

    res.on('data', (chunk) => { received += chunk.length; });
    res.on('aborted', () => fail(new Error('response aborted mid-transfer')));
    res.on('error', (e) => fail(e));
    res.on('end', () => {
      if (Number.isFinite(expectedLength) && expectedLength > 0 && received !== expectedLength) {
        fail(new Error('incomplete download: got ' + received + ' of ' + expectedLength + ' bytes'));
      }
      // Otherwise the write stream's 'finish' event (below) completes the
      // transfer -- 'end' only means the response body was exhausted, not
      // that the bytes reached the disk.
    });

    out.on('error', (e) => fail(e));
    out.on('finish', () => {
      if (!failed) {
        if (Number.isFinite(expectedLength) && expectedLength > 0 && received !== expectedLength) {
          failed = new Error(
            'incomplete download: got ' + received + ' of ' + expectedLength + ' bytes'
          );
        } else {
          done();
        }
      }
    });
    res.pipe(out);
  });

  // Wait for the file handle to be released before touching the file.
  if (closed) await closed;

  if (failed) {
    try { fs.unlinkSync(tmp); } catch {}
    throw failed;
  }
  try {
    const st = fs.statSync(tmp);
    if (st.size === 0) throw new Error('downloaded file is empty');
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  return tmp;
}

async function ensureNativeBinary() {
  if (!file) {
    throw new Error(
      'unsupported platform ' + process.platform + '-' + process.arch + '. ' +
      'Supported: linux-x64-gnu, linux-arm64-gnu, linux-x64-musl, linux-arm64-musl, ' +
      'darwin-x64, darwin-arm64, win32-x64-msvc.'
    );
  }

  // The asset to download may differ from the file we install under (musl vs
  // gnu), but the destination is always the canonical name index.js expects.
  const asset = releaseAssetName() || file;

  // Already present and valid -> nothing to do.
  if (fs.existsSync(dest)) {
    const check = assertValidNativeBinary(dest);
    if (check.ok) return { installed: false, reason: 'already installed' };
    console.warn('hyperglob: existing binary is invalid (' + check.reason + '); re-downloading.');
    try { fs.unlinkSync(dest); } catch {}
  }

  if (!version) {
    throw new Error('could not determine the package version; refusing to guess a release tag.');
  }
  const tag = 'v' + version;
  const assetUrl = `${DOWNLOAD_BASE}/${tag}/${asset}`;

  console.log('hyperglob: downloading ' + asset + ' for ' + process.platform + '-' + process.arch +
    ' (release ' + tag + ')...');

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 2);
      console.warn('hyperglob: attempt ' + attempt + '/' + MAX_ATTEMPTS + ' after ' + delay + 'ms: ' +
        (lastError && lastError.message));
      await sleep(delay);
    }
    let tmp = null;
    try {
      tmp = await downloadToFile(assetUrl, dest);

      // Integrity: prefer the published checksums.txt, fall back to a
      // size + magic-byte check when the manifest is unavailable.
      let expected = null;
      try {
        const manifest = await getText(`${DOWNLOAD_BASE}/${tag}/checksums.txt`);
        expected = parseChecksums(manifest).get(asset) || null;
        if (!expected) {
          console.warn('hyperglob: checksums.txt has no entry for ' + asset +
            '; falling back to size/magic validation.');
        }
      } catch (e) {
        console.warn('hyperglob: checksums.txt unavailable (' + e.message + '); ' +
          'falling back to size/magic validation.');
      }

      if (expected) {
        const actual = sha256File(tmp);
        if (actual !== expected) {
          throw new Error(
            'checksum mismatch for ' + asset + ': expected ' + expected + ', got ' + actual
          );
        }
        console.log('hyperglob: sha256 verified.');
      } else {
        const check = assertValidNativeBinary(tmp);
        if (!check.ok) {
          throw new Error('downloaded binary failed validation: ' + check.reason);
        }
      }

      fs.renameSync(tmp, dest);
      tmp = null;
      console.log('hyperglob: binary installed.');
      return { installed: true, reason: 'downloaded' };
    } catch (e) {
      lastError = e;
      if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
    }
  }

  throw new Error(
    'could not install the native binary for ' + process.platform + '-' + process.arch + ': ' +
    (lastError && lastError.message) + '. ' +
    'Build it from source instead: npm run build'
  );
}

// ---------------------------------------------------------------------------
// MCP registration (opt-in)
// ---------------------------------------------------------------------------

/**
 * Parse a JSON config that may contain comments (JSONC).
 *
 * JSON.parse is tried first. Only if that fails do we fall back to a
 * comment-stripper that is aware of string literals, so a "//" inside a
 * string value (a URL, a file:// path, a UNC path) is never mangled.
 *
 * Returns { ok: true, value } or { ok: false, reason }.
 */
function parseJsonLike(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    // fall through to the JSONC-aware stripper
  }

  let out = '';
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++; }
      else if (ch === '\n') { out += ch; }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) { escaped = false; }
      else if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    out += ch;
  }

  // Strip trailing commas, which plain JSON.parse rejects.
  out = out.replace(/,(\s*[}\]])/g, '$1');

  try {
    return { ok: true, value: JSON.parse(out) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Register the MCP server in one config file.
 *
 * Fails closed: if the file exists but cannot be parsed, it is left completely
 * untouched and a warning is printed. Unrelated top-level keys are preserved.
 *
 * Returns true if the file was modified, false if nothing was changed or the
 * file was skipped.
 */
function tryRegister(p, mutate) {
  let cfg = {};
  if (fs.existsSync(p)) {
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      console.warn('hyperglob: could not read ' + p + ' (' + e.message + '); skipping.');
      return false;
    }
    const parsed = parseJsonLike(raw);
    if (!parsed.ok) {
      console.warn('hyperglob: could not parse ' + p + ' (' + parsed.reason +
        '); skipping to avoid destroying your configuration.');
      return false;
    }
    if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      console.warn('hyperglob: ' + p + ' is not a JSON object; skipping.');
      return false;
    }
    cfg = parsed.value;
  }
  try {
    const changed = mutate(cfg);
    if (changed) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
      console.log('hyperglob: registered MCP in ' + p);
    }
    return changed;
  } catch (e) {
    console.warn('hyperglob: could not update ' + p + ' (' + e.message + '); skipped.');
    return false;
  }
}

function registerMcpServers() {
  const home = os.homedir();
  // npm runs lifecycle scripts with cwd = the package directory. INIT_CWD is
  // the directory the user invoked npm from, i.e. their project root.
  const projectRoot = process.env.INIT_CWD || process.cwd();

  const bin = path.join(__dirname, '..', 'mcp.js');
  const stdioEntry = { command: 'node', args: [bin] };

  // Global (user-level) agent configurations.
  // Kilo Code (global, jsonc)
  tryRegister(path.join(home, '.config', 'kilo', 'kilo.jsonc'), (cfg) => {
    cfg.mcp = cfg.mcp || {};
    if (cfg.mcp.hyperglob) return false;
    cfg.mcp.hyperglob = { type: 'local', command: ['node', bin], enabled: true };
    return true;
  });

  // Claude Code (global + project)
  tryRegister(path.join(home, '.claude.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });
  tryRegister(path.join(projectRoot, '.mcp.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });

  // Cursor (global + project)
  tryRegister(path.join(home, '.cursor', 'mcp.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });
  tryRegister(path.join(projectRoot, '.cursor', 'mcp.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });

  // Windsurf (global)
  tryRegister(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });

  // VS Code (project .vscode/mcp.json uses the "servers" key)
  tryRegister(path.join(projectRoot, '.vscode', 'mcp.json'), (cfg) => {
    cfg.servers = cfg.servers || {};
    if (cfg.servers.hyperglob) return false;
    cfg.servers.hyperglob = { type: 'stdio', ...stdioEntry };
    return true;
  });

  // Cline
  tryRegister(path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });
  tryRegister(path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });

  // Roo Code (project)
  tryRegister(path.join(projectRoot, '.roo', 'mcp.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });

  // Continue (global config.json -- mcpServers is an array)
  tryRegister(path.join(home, '.continue', 'config.json'), (cfg) => {
    cfg.mcpServers = Array.isArray(cfg.mcpServers) ? cfg.mcpServers : [];
    if (cfg.mcpServers.some((s) => s && s.name === 'hyperglob')) return false;
    cfg.mcpServers.push({ name: 'hyperglob', ...stdioEntry });
    return true;
  });

  // Zed (global settings.json -- context_servers key)
  tryRegister(path.join(home, '.config', 'zed', 'settings.json'), (cfg) => {
    cfg.context_servers = cfg.context_servers || {};
    if (cfg.context_servers.hyperglob) return false;
    cfg.context_servers.hyperglob = { command: 'node', args: [bin], env: {} };
    return true;
  });
  tryRegister(path.join(home, 'AppData', 'Roaming', 'Zed', 'settings.json'), (cfg) => {
    cfg.context_servers = cfg.context_servers || {};
    if (cfg.context_servers.hyperglob) return false;
    cfg.context_servers.hyperglob = { command: 'node', args: [bin], env: {} };
    return true;
  });

  // Gemini CLI
  tryRegister(path.join(home, '.gemini', 'settings.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });

  // Copilot CLI
  tryRegister(path.join(home, '.copilot', 'mcp-config.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });

  // OpenCode
  tryRegister(path.join(home, '.config', 'opencode', 'opencode.json'), (cfg) => {
    cfg.mcp = cfg.mcp || {};
    if (cfg.mcp.hyperglob) return false;
    cfg.mcp.hyperglob = { type: 'local', command: ['node', bin], enabled: true };
    return true;
  });

  // Kiro (project)
  tryRegister(path.join(projectRoot, '.kiro', 'settings', 'mcp.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });

  // Amp (global)
  tryRegister(path.join(home, '.config', 'amp', 'settings.json'), (cfg) => {
    cfg['amp.mcpServers'] = cfg['amp.mcpServers'] || {};
    if (cfg['amp.mcpServers'].hyperglob) return false;
    cfg['amp.mcpServers'].hyperglob = stdioEntry;
    return true;
  });

  // Factory Droid (project)
  tryRegister(path.join(projectRoot, '.factory', 'mcp.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });

  // Crush (project)
  tryRegister(path.join(projectRoot, 'crush.json'), (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = stdioEntry;
    return true;
  });

  // OpenAI Codex (TOML) -- append a table if file exists
  try {
    const codex = path.join(home, '.codex', 'config.toml');
    if (fs.existsSync(codex)) {
      const raw = fs.readFileSync(codex, 'utf8');
      if (!raw.includes('[mcp_servers.hyperglob]')) {
        fs.appendFileSync(codex, '\n[mcp_servers.hyperglob]\ncommand = "node"\nargs = ["' + bin.replace(/\\/g, '\\\\') + '"]\n');
        console.log('hyperglob: registered MCP in ' + codex);
      }
    }
  } catch (e) { /* best effort */ }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function main() {
  // MCP auto-registration is opt-in: installing a library must not silently
  // rewrite the user's agent configuration. Set HYPERGLOB_REGISTER_MCP=1 to
  // enable it (docs/PACKAGING_AUDIT.md F11).
  const register = process.env.HYPERGLOB_REGISTER_MCP === '1';
  if (register) {
    console.log('hyperglob: HYPERGLOB_REGISTER_MCP=1 -- registering the MCP server in agent configs.');
    registerMcpServers();
  } else {
    console.log(
      'hyperglob: to register the MCP server in your agent configs, re-run with ' +
      'HYPERGLOB_REGISTER_MCP=1'
    );
  }

  await ensureNativeBinary();
}

if (require.main === module) {
  main().then(
    () => { process.exitCode = 0; },
    (err) => {
      console.error('hyperglob: ' + (err && err.message ? err.message : String(err)));
      process.exitCode = 1;
    }
  );
}

module.exports = {
  nativeFilename,
  releaseAssetName,
  isMusl,
  packageVersion,
  parseJsonLike,
  parseChecksums,
  sha256File,
  tryRegister,
  registerMcpServers,
  ensureNativeBinary,
  downloadToFile,
  get,
  getText,
  main,
};
