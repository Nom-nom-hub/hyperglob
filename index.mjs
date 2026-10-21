// ESM wrapper around the CommonJS implementation in ./index.js.
//
// Re-exports every public member of index.js, including the default export
// (`module.exports.default = hyperglob`).
import cjs from './index.js';

export const hyperglob = cjs.hyperglob;
export const hyperglobSync = cjs.hyperglobSync;
export const hyperglobDependents = cjs.hyperglobDependents;
export const HyperglobStream = cjs.HyperglobStream;
export const HyperEntry = cjs.HyperEntry;
export const parseQuery = cjs.parseQuery;
export const version = cjs.version;
export const native = cjs.native;
export const loadNative = cjs.loadNative;
export const nativeFilename = cjs.nativeFilename;

export default cjs.hyperglob;
