// Ad-hoc probe: engine edge cases — symlink cycles, path escape, walk root.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hyperglobSync } from '../index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-root-'));
fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
fs.writeFileSync(path.join(root, 'src', 'sub', 'b.ts'), '');

// A junction (Windows) / symlink (Unix) pointing at its own ancestor.
try {
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'src', 'loop'), 'junction');
  console.log('created junction src/loop -> src');
} catch (e) {
  console.log('could not create junction:', e.code);
}

const t = (l, f) => {
  try { console.log(l, JSON.stringify(f())); }
  catch (e) { console.log(l, 'ERR:', e.message); }
};

t('followSymlinks:false [expect: src/a.ts, src/sub/b.ts]', () =>
  hyperglobSync('src/**/*', { cwd: root, pathsOnly: true, followSymlinks: false }).sort());
t('followSymlinks:true  [expect: no infinite loop]', () =>
  hyperglobSync('src/**/*', { cwd: root, pathsOnly: true, followSymlinks: true }).sort());
t('escape ../*.ts      [expect: error or []]', () =>
  hyperglobSync('../*.ts', { cwd: root, pathsOnly: true }).sort());
t('onlyFiles:false src [expect: includes "src"]', () =>
  hyperglobSync('src', { cwd: root, pathsOnly: true, onlyFiles: false }).sort());
t('onlyFiles:false src/** [expect: includes "src"]', () =>
  hyperglobSync('src/**', { cwd: root, pathsOnly: true, onlyFiles: false }).sort());

fs.rmSync(root, { recursive: true, force: true });
