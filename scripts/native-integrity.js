'use strict';
// Shared native-binary integrity helpers.
//
// Used by scripts/install.js to validate a downloaded prebuilt .node before it
// is moved into place, and intended for use by index.js's loadNative() so a
// corrupt or truncated binary is rejected instead of being handed to
// process.dlopen (which throws ERR_DLOPEN_FAILED).
//
// See docs/PACKAGING_AUDIT.md F3 / F7.
const fs = require('fs');

// The published binaries are ~3-4 MB. 64 KB is a very conservative floor that
// still catches every realistic truncation (a partial download of these files
// is orders of magnitude larger than 64 KB, but a killed/zero-byte write is
// not) while never rejecting a legitimate build.
const MIN_NATIVE_BYTES = 64 * 1024;

// Native module magic numbers. A Node .node file is a shared library, so it
// starts with the platform's executable/object header.
const MAGICS = {
  win32: [
    { name: 'PE/MZ (Windows)', bytes: [0x4d, 0x5a] },
  ],
  linux: [
    { name: 'ELF (Linux)', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  ],
  darwin: [
    // Mach-O 64-bit (0xfeedfacf) and 32-bit (0xfeedface), little endian.
    { name: 'Mach-O 64 (macOS)', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
    { name: 'Mach-O 32 (macOS)', bytes: [0xce, 0xfa, 0xed, 0xfe] },
    // Universal ("fat") binary.
    { name: 'Mach-O universal (macOS)', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  ],
};

function platformMagics(platform) {
  return MAGICS[platform] || [];
}

function readMagic(file, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Check that `file` looks like a valid native addon for `platform`.
 *
 * Returns { ok: true } when the file passes, or { ok: false, reason } with a
 * human-readable explanation when it does not. Never throws for a missing or
 * unreadable file -- that is reported as ok: false.
 *
 * @param {string} file      path to the candidate .node file
 * @param {object} [options]
 * @param {string} [options.platform]  override the detected platform
 * @param {number} [options.minBytes]  override the minimum size floor
 */
function assertValidNativeBinary(file, options = {}) {
  const platform = options.platform || process.platform;
  const minBytes = Number.isFinite(options.minBytes) ? options.minBytes : MIN_NATIVE_BYTES;

  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return { ok: false, reason: 'file does not exist: ' + file };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: 'not a regular file: ' + file };
  }
  if (stat.size < minBytes) {
    return {
      ok: false,
      reason: `file is too small (${stat.size} bytes < ${minBytes}); it is truncated or empty`,
    };
  }

  const magics = platformMagics(platform);
  if (magics.length === 0) {
    // Unknown platform: the size check is all we can do.
    return { ok: true };
  }

  let head;
  try {
    head = readMagic(file, 4);
  } catch (e) {
    return { ok: false, reason: 'could not read file header: ' + e.message };
  }

  for (const magic of magics) {
    if (head.length >= magic.bytes.length && magic.bytes.every((b, i) => head[i] === b)) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    reason:
      `file does not start with a valid ${platform} native-module magic ` +
      `(expected one of: ${magics.map((m) => m.name).join(', ')}); ` +
      'it is corrupt or not a native addon',
  };
}

module.exports = {
  assertValidNativeBinary,
  MIN_NATIVE_BYTES,
  MAGICS,
};
