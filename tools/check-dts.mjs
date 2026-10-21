// Structural sanity check of index.d.ts without a TypeScript compiler:
// every value-level export in the .d.ts must exist on the runtime module.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dts = fs.readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8');

// Loading index.js pulls in the native binding. If it is missing, the loader
// tries to download one -- which fails for an unreleased commit, since the
// release page has no binary for it yet. Say so plainly instead.
let mod;
try {
  mod = require('../index.js');
} catch (e) {
  console.error(
    'check-dts: could not load the runtime module.\n' +
      'The native binding is probably not built. Run `npm run build` first.\n' +
      `Underlying error: ${e && e.message ? e.message : e}`
  );
  process.exit(1);
}

const valueNames = new Set();
// export declare function X / export declare const X / export declare class X
for (const m of dts.matchAll(/export declare (?:function|const|class) (\w+)/g)) valueNames.add(m[1]);
// export interface X / export type X (type-only: no runtime counterpart)
const typeNames = new Set();
for (const m of dts.matchAll(/export (?:interface|type) (\w+)/g)) typeNames.add(m[1]);

const missing = [...valueNames].filter((n) => !(n in mod));
console.log('declared value exports:', [...valueNames].sort().join(', '));
console.log('declared type-only exports:', [...typeNames].sort().join(', '));
console.log('missing at runtime:', missing.length ? missing.join(', ') : '(none)');

// The `Native` interface must also match the real native binding: every
// method it declares must exist on the loaded addon, and vice versa.
const nativeIface = dts.slice(dts.indexOf('export interface Native {'));
const nativeMembers = new Set();
for (const m of nativeIface.matchAll(/^\s{2}(\w+)[(:?]/gm)) nativeMembers.add(m[1]);
const nativeObj = mod.native;
const missingNative = [...nativeMembers].filter((n) => !(n in nativeObj));
console.log('native members declared:', [...nativeMembers].sort().join(', '));
console.log('missing on native binding:', missingNative.length ? missingNative.join(', ') : '(none)');

// The ESM wrapper must re-export every value export of the CJS module,
// otherwise `import { x } from 'hyperglob'` silently gives undefined for
// a member that `require('hyperglob').x` provides.
const mjs = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
const mjsNames = new Set();
for (const m of mjs.matchAll(/^export const (\w+)/gm)) mjsNames.add(m[1]);
const missingMjs = [...valueNames].filter((n) => !mjsNames.has(n));
console.log('index.mjs exports:', [...mjsNames].sort().join(', '));
console.log('missing from index.mjs:', missingMjs.length ? missingMjs.join(', ') : '(none)');
process.exit(missing.length || missingNative.length || missingMjs.length ? 1 : 0);
