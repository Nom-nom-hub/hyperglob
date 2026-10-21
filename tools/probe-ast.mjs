// Ad-hoc probe: AST-selector behaviour — comments and strings must never
// be mistaken for real export/import sites.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hyperglobSync } from '../index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-ast-'));
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
const w = (n, c) => fs.writeFileSync(path.join(root, 'src', n), c);

// --- Real parse error (unclosed brace) but an export-shaped comment.
w('broken.ts', '// export const ghost = 1;\nfunction broken( {\n');
// --- Real parse error + an import-shaped string literal.
w('broken2.ts', 'const s = "import { x } from \'react\';";\nlet y = ;\n');
// --- Clean control file: export-shaped text only in a comment.
w('clean.ts', '// export const ghost = 1;\nexport const real = 1;\n');
// --- Import-shaped text only in a comment (clean file).
w('comment.ts', "// import { x } from 'react';\nconst y = 1;\n");
// --- Import-shaped text only inside a string literal (clean file).
w('string.ts', 'const s = "import(\'react\')";\nconst t = "require(\'react\')";\n');
// --- A genuine import site.
w('real.ts', "import { x } from 'react';\nexport const real = 1;\n");
// --- A genuine require() call.
w('realrequire.ts', "const r = require('react');\n");
// --- A genuine dynamic import().
w('realdynamic.ts', "const p = import('react');\n");
// --- Export-shaped text only in a block comment.
w('blockcomment.ts', '/* export const ghost = 1; */\nexport const ok = 1;\n');
// --- Member access must NOT be an import site.
w('member.ts', "const o = { import: 1 };\nconst p = o.import;\nconst q = o?.import;\n");
// --- `from` as a plain identifier / property must NOT be an import site.
w('fromident.ts', "const from = 1;\nconst o = { from: 'x' };\nconst s = o.from;\n");

const t = (l, f) => {
  try { console.log(l, JSON.stringify(f())); }
  catch (e) { console.log(l, 'ERR:', e.message); }
};

t('exports("ghost")  [expect: []]', () =>
  hyperglobSync('src/*.ts :exports("ghost")', { cwd: root, pathsOnly: true }).sort());
t('exports("real")   [expect: clean.ts, real.ts]', () =>
  hyperglobSync('src/*.ts :exports("real")', { cwd: root, pathsOnly: true }).sort());
t('exports("ok")     [expect: blockcomment.ts]', () =>
  hyperglobSync('src/*.ts :exports("ok")', { cwd: root, pathsOnly: true }).sort());
t('imports("react")  [expect: real.ts, realrequire.ts, realdynamic.ts]', () =>
  hyperglobSync('src/*.ts :imports("react")', { cwd: root, pathsOnly: true }).sort());
t('imports("x")      [expect: []]', () =>
  hyperglobSync('src/*.ts :imports("x")', { cwd: root, pathsOnly: true }).sort());
t('all files         [expect: 11]', () =>
  hyperglobSync('src/*.ts', { cwd: root, pathsOnly: true }).sort());

fs.rmSync(root, { recursive: true, force: true });
