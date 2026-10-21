// Probe fast-glob's exact semantics for directory roots, to match them.
import fg from 'fast-glob';
import { hyperglobSync } from '../index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-root-'));
fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
fs.writeFileSync(path.join(root, 'src', 'sub', 'b.ts'), '');
fs.writeFileSync(path.join(root, 'lib', 'c.ts'), '');

const cases = [
  ['src', 'src'],
  ['src (onlyFiles)', 'src'],
  ['src (onlyFiles:false)', 'src'],
];

for (const [label, pat] of cases) {
  const onlyFiles = !label.includes('onlyFiles:false');
  const a = fg.sync(pat, { cwd: root, onlyFiles }).sort();
  let b;
  try {
    b = hyperglobSync(pat, { cwd: root, pathsOnly: true, onlyFiles }).sort();
  } catch (e) {
    b = 'ERR: ' + e.message;
  }
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(`${same ? 'OK  ' : 'DIFF'} ${label}`);
  if (!same) {
    console.log('   fast-glob:', JSON.stringify(a));
    console.log('   hyperglob:', JSON.stringify(b));
  }
}

// What does fast-glob do for a magic-free pattern pointing at a FILE?
fs.writeFileSync(path.join(root, 'top.ts'), '');
console.log("fg 'top.ts'         =>", JSON.stringify(fg.sync('top.ts', { cwd: root, onlyFiles: false })));
console.log("hg 'top.ts'         =>", JSON.stringify(hyperglobSync('top.ts', { cwd: root, pathsOnly: true, onlyFiles: false })));
console.log("fg 'src/a.ts'       =>", JSON.stringify(fg.sync('src/a.ts', { cwd: root, onlyFiles: false })));
console.log("hg 'src/a.ts'       =>", JSON.stringify(hyperglobSync('src/a.ts', { cwd: root, pathsOnly: true, onlyFiles: false })));

fs.rmSync(root, { recursive: true, force: true });
