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
