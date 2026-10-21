// Probe engine semantics vs fast-glob reference.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hyperglobSync } from '../index.js';
import fg from 'fast-glob';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-sem-'));
const w = (rel, c = 'x') => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
};
w('src/a.ts', 'a');
w('src/sub/b.ts', 'b');
w('src/sub/deep/c.ts', 'c');
w('top.ts', 't');
w('pkg/node_modules/dep/index.js', 'd');
w('pkg/node_modules/keep.js', 'k');

const t = (label, hgOpts, fgOpts, pattern) => {
  let hg, fgv;
  try { hg = hyperglobSync(pattern, { cwd: root, pathsOnly: true, ...hgOpts }).sort(); }
  catch (e) { hg = 'ERR:' + e.message; }
  try { fgv = fg.sync(pattern, { cwd: root, ...fgOpts }).sort(); }
  catch (e) { fgv = 'ERR:' + e.message; }
  const same = JSON.stringify(hg) === JSON.stringify(fgv);
  console.log(`${same ? 'SAME' : 'DIFF'}  ${label}`);
  if (!same) {
    console.log('   hg:', JSON.stringify(hg));
    console.log('   fg:', JSON.stringify(fgv));
  }
};

// onlyFiles:false — do directories come back at all?
t('onlyFiles:false  src/**', { onlyFiles: false }, { onlyFiles: false }, 'src/**');
t('onlyFiles:false  **', { onlyFiles: false }, { onlyFiles: false }, '**');
t('onlyFiles:false  src/**/*', { onlyFiles: false }, { onlyFiles: false }, 'src/**/*');

// ignore option: does it prune directories?
t('ignore:[node_modules]  **/*', { ignore: ['node_modules'] }, {}, '**/*');
t('ignore:[**/node_modules/**]  **/*', { ignore: ['**/node_modules/**'] }, {}, '**/*');
t('ignore:[pkg/**]  **/*', { ignore: ['pkg/**'] }, {}, '**/*');

// dot handling
t('dot:true  **/*.ts', { dot: true }, { dot: true }, '**/*.ts');

fs.rmSync(root, { recursive: true, force: true });
