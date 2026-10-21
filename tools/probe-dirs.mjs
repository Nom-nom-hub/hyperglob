// Probe: onlyFiles:false directory results, and `..` path escape.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pkg from '../index.js';
const { hyperglobSync } = pkg;
import fg from 'fast-glob';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-dir-'));
const w = (rel, c = 'x') => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
};
w('src/a.ts', 'a');
w('src/sub/b.ts', 'b');

const t = (label, fn) => {
  try { console.log(label, JSON.stringify(fn())); }
  catch (e) { console.log(label, 'ERR:', e.message); }
};

t('hg onlyFiles:false src/**', () => hyperglobSync('src/**', { cwd: root, pathsOnly: true, onlyFiles: false }).sort());
t('fg onlyFiles:false src/**', () => fg.sync('src/**', { cwd: root, onlyFiles: false }).sort());
t('hg onlyFiles:false **', () => hyperglobSync('**', { cwd: root, pathsOnly: true, onlyFiles: false }).sort());
t('fg onlyFiles:false **', () => fg.sync('**', { cwd: root, onlyFiles: false }).sort());

// `..` escape: does the walk leave cwd?
const parentMarker = path.join(root, '..', `hg-escape-${path.basename(root)}.ts`);
fs.writeFileSync(parentMarker, 'outside');
t('escape ../*.ts (should not match files above cwd)', () =>
  hyperglobSync('../*.ts', { cwd: root, pathsOnly: true }).sort());
fs.rmSync(parentMarker, { force: true });

fs.rmSync(root, { recursive: true, force: true });
