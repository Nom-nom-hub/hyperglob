'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const home = os.homedir();

function nativeFilename() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return 'hyperglob.linux-x64-gnu.node';
  if (platform === 'linux' && arch === 'arm64') return 'hyperglob.linux-arm64-gnu.node';
  if (platform === 'darwin' && arch === 'x64') return 'hyperglob.darwin-x64.node';
  if (platform === 'darwin' && arch === 'arm64') return 'hyperglob.darwin-arm64.node';
  if (platform === 'win32' && arch === 'x64') return 'hyperglob.win32-x64-msvc.node';
  return null;
}

const file = nativeFilename();
if (!file) { console.warn('hyperglob: unsupported platform ' + process.platform + '-' + process.arch); process.exit(0); }
const dest = path.join(__dirname, '..', file);
if (!fs.existsSync(dest)) {
  const url = 'https://github.com/Nom-nom-hub/hyperglob/releases/latest/download/' + file;
  console.log('hyperglob: downloading prebuilt binary for ' + process.platform + '-' + process.arch + '...');
  const f = fs.createWriteStream(dest);
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      https.get(res.headers.location, (r2) => { r2.pipe(f); r2.on('end', ()=>{ f.close(); console.log('hyperglob: binary installed.'); }); }).on('error', e=>{ try{fs.unlinkSync(dest);}catch{} console.warn('hyperglob: download failed: ' + e.message); process.exit(0); });
      return;
    }
    if (res.statusCode !== 200) { try { fs.unlinkSync(dest); } catch {} console.warn('hyperglob: no prebuilt binary on releases; run npm run build (cargo). status=' + res.statusCode); process.exit(0); }
    res.pipe(f);
    res.on('end', ()=>{ f.close(); console.log('hyperglob: binary installed.'); });
  }).on('error', (e) => { try { fs.unlinkSync(dest); } catch {} console.warn('hyperglob: download failed: ' + e.message); process.exit(0); });
}

const bin = path.join(__dirname, '..', 'mcp.js');
const stdioEntry = { command: 'node', args: [bin] };

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
tryRegister(path.join(process.cwd(), '.mcp.json'), (cfg) => {
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
tryRegister(path.join(process.cwd(), '.cursor', 'mcp.json'), (cfg) => {
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

// VS Code / Copilot (project .vscode/mcp.json uses "servers" key)
tryRegister(path.join(process.cwd(), '.vscode', 'mcp.json'), (cfg) => {
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
tryRegister(path.join(process.cwd(), '.roo', 'mcp.json'), (cfg) => {
  cfg.mcpServers = cfg.mcpServers || {};
  if (cfg.mcpServers.hyperglob) return false;
  cfg.mcpServers.hyperglob = stdioEntry;
  return true;
});

// Continue (global config.json — mcpServers is an array)
tryRegister(path.join(home, '.continue', 'config.json'), (cfg) => {
  cfg.mcpServers = Array.isArray(cfg.mcpServers) ? cfg.mcpServers : [];
  if (cfg.mcpServers.some(s => s && s.name === 'hyperglob')) return false;
  cfg.mcpServers.push({ name: 'hyperglob', ...stdioEntry });
  return true;
});

// Zed (global settings.json — context_servers key)
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
tryRegister(path.join(process.cwd(), '.kiro', 'settings', 'mcp.json'), (cfg) => {
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
tryRegister(path.join(process.cwd(), '.factory', 'mcp.json'), (cfg) => {
  cfg.mcpServers = cfg.mcpServers || {};
  if (cfg.mcpServers.hyperglob) return false;
  cfg.mcpServers.hyperglob = stdioEntry;
  return true;
});

// Crush (project)
tryRegister(path.join(process.cwd(), 'crush.json'), (cfg) => {
  cfg.mcpServers = cfg.mcpServers || {};
  if (cfg.mcpServers.hyperglob) return false;
  cfg.mcpServers.hyperglob = stdioEntry;
  return true;
});

// OpenAI Codex (TOML) — append a table if file exists
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
