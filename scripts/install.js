'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
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
if (fs.existsSync(dest)) { process.exit(0); }
const url = `https://github.com/Nom-nom-hub/hyperglob/releases/latest/download/${file}`;
console.log('hyperglob: downloading prebuilt binary for ' + process.platform + '-' + process.arch + '...');
const f = fs.createWriteStream(dest);
https.get(url, (res) => {
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    https.get(res.headers.location, (r2) => { r2.pipe(f); r2.on('end', ()=>{ f.close(); console.log('hyperglob: binary installed.'); }); }).on('error', e=>{ fs.unlinkSync(dest); console.warn('hyperglob: download failed, run `npm run build` (cargo): ' + e.message); process.exit(0); });
    return;
  }
  if (res.statusCode !== 200) { console.warn('hyperglob: no prebuilt binary on releases; run `npm run build` (cargo). status=' + res.statusCode); process.exit(0); }
  res.pipe(f);
  res.on('end', ()=>{ f.close(); console.log('hyperglob: binary installed.'); });
}).on('error', (e) => { try { fs.unlinkSync(dest); } catch {} console.warn('hyperglob: download failed, run `npm run build` (cargo): ' + e.message); process.exit(0); });

const os = require('os');
const home = os.homedir();

function tryRegister(configPath, mutate) {
  try {
    if (!fs.existsSync(configPath)) return;
    const raw = fs.readFileSync(configPath, 'utf8');
    let json;
    try { json = JSON.parse(raw); } catch { return; }
    const changed = mutate(json);
    if (changed) {
      fs.writeFileSync(configPath, JSON.stringify(json, null, 2) + '\n');
      console.log('hyperglob: registered MCP in ' + configPath);
    }
  } catch (e) { /* best effort */ }
}

const mcpEntry = { type: 'local', command: ['node', path.join(__dirname, '..', 'mcp.js')], enabled: true };

tryRegister(path.join(home, '.config', 'kilo', 'kilo.jsonc'), (cfg) => {
  cfg.mcp = cfg.mcp || {};
  if (cfg.mcp.hyperglob) return false;
  cfg.mcp.hyperglob = mcpEntry;
  return true;
});

tryRegister(path.join(process.cwd(), '.cursor', 'mcp.json'), (cfg) => {
  cfg.mcpServers = cfg.mcpServers || {};
  if (cfg.mcpServers.hyperglob) return false;
  cfg.mcpServers.hyperglob = { command: 'node', args: [path.join(__dirname, '..', 'mcp.js')] };
  return true;
});

tryRegister(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), (cfg) => {
  cfg.mcpServers = cfg.mcpServers || {};
  if (cfg.mcpServers.hyperglob) return false;
  cfg.mcpServers.hyperglob = { command: 'node', args: [path.join(__dirname, '..', 'mcp.js')] };
  return true;
});

tryRegister(path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'), (cfg) => {
  cfg.mcpServers = cfg.mcpServers || {};
  if (cfg.mcpServers.hyperglob) return false;
  cfg.mcpServers.hyperglob = { command: 'node', args: [path.join(__dirname, '..', 'mcp.js')] };
  return true;
});
