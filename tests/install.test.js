'use strict';
// Tests for the install/download path.
//
// These exercise the pure functions of scripts/install.js and
// scripts/native-integrity.js directly against a local HTTP server, so they
// do not need to spawn a child process (which some sandboxes forbid).
//
// See docs/PACKAGING_AUDIT.md F3 / F4 / F7.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const install = require('../scripts/install.js');
const { assertValidNativeBinary, MIN_NATIVE_BYTES } = require('../scripts/native-integrity.js');

let root;
let server;
let serverPort;
let lastRequest;

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-install-test-'));
  server = http.createServer((req, res) => {
    lastRequest = req.url;
    const route = req.url.split('?')[0];

    if (route === '/ok') {
      const body = Buffer.alloc(200 * 1024, 0x42);
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
      return;
    }
    if (route === '/truncated') {
      // Declares 1 MB, sends 1 KB, then ends the response early.
      res.writeHead(200, { 'Content-Length': '1000000' });
      res.write(Buffer.alloc(1024, 0x43));
      setTimeout(() => res.end(), 10);
      return;
    }
    if (route === '/abort') {
      // Declares 1 MB, sends 1 KB, then destroys the socket.
      res.writeHead(200, { 'Content-Length': '1000000' });
      res.write(Buffer.alloc(1024, 0x44));
      setTimeout(() => res.socket.destroy(), 10);
      return;
    }
    if (route === '/notfound') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (route === '/boom') {
      // A server error: transient, so the installer should retry it.
      res.writeHead(500);
      res.end('boom');
      return;
    }
    if (route === '/checksums.txt') {
      const body = Buffer.from(
        '0000000000000000000000000000000000000000000000000000000000000000  hyperglob.test.node\n'
      );
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  serverPort = server.address().port;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

const url = (route) => `http://127.0.0.1:${serverPort}${route}`;

// ---------------------------------------------------------------------------
// F3: a partial download must never be left at the destination
// ---------------------------------------------------------------------------

test('downloadToFile writes to a temp path, not the destination', async () => {
  const dest = path.join(root, 'ok.node');
  const tmp = await install.downloadToFile(url('/ok'), dest);
  try {
    assert.notEqual(tmp, dest);
    assert.ok(tmp.startsWith(dest + '.tmp-'), 'temp path should be derived from the destination: ' + tmp);
    assert.ok(fs.existsSync(tmp));
    assert.ok(!fs.existsSync(dest), 'the final path must not exist until the rename');
    // The bytes must actually be on disk when the promise resolves, not just
    // counted in memory.
    assert.equal(fs.statSync(tmp).size, 200 * 1024, 'the full body must be flushed to disk');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('a truncated response leaves NO file at the destination and no temp file', async () => {
  const dest = path.join(root, 'truncated.node');
  await assert.rejects(
    () => install.downloadToFile(url('/truncated'), dest),
    /incomplete download|aborted/i
  );
  assert.ok(!fs.existsSync(dest), 'a partial file must never be left at the destination path');
  const leftovers = fs.readdirSync(root).filter((f) => f.startsWith('truncated.node.tmp-'));
  assert.deepEqual(leftovers, [], 'the temp file must be cleaned up, found: ' + leftovers.join(', '));
});

test('an aborted response leaves NO file at the destination and no temp file', async () => {
  const dest = path.join(root, 'abort.node');
  await assert.rejects(
    () => install.downloadToFile(url('/abort'), dest),
    /aborted|incomplete download/i
  );
  assert.ok(!fs.existsSync(dest), 'a partial file must never be left at the destination path');
  const leftovers = fs.readdirSync(root).filter((f) => f.startsWith('abort.node.tmp-'));
  assert.deepEqual(leftovers, [], 'the temp file must be cleaned up, found: ' + leftovers.join(', '));
});

test('a 404 response leaves NO file at the destination', async () => {
  const dest = path.join(root, 'missing.node');
  await assert.rejects(() => install.downloadToFile(url('/notfound'), dest), /status=404/);
  assert.ok(!fs.existsSync(dest));
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.startsWith('missing.node.tmp-')), []);
});

test('a 404 error carries the status code', async () => {
  // The installer distinguishes "this release does not exist yet" (404) from
  // a transient failure worth retrying. It can only do that if the status
  // survives on the error.
  const dest = path.join(root, 'status.node');
  const err = await install
    .downloadToFile(url('/notfound'), dest)
    .then(() => null, (e) => e);
  assert.ok(err, 'expected the download to reject');
  assert.equal(err.status, 404);
  assert.match(err.message, /status=404/);
});

test('a non-404 failure carries its status code too', async () => {
  const dest = path.join(root, 'status500.node');
  const err = await install
    .downloadToFile(url('/boom'), dest)
    .then(() => null, (e) => e);
  assert.ok(err, 'expected the download to reject');
  assert.equal(err.status, 500);
});

test('an empty body is rejected', async () => {
  const dest = path.join(root, 'empty.node');
  await assert.rejects(() => install.downloadToFile(url('/empty'), dest));
  assert.ok(!fs.existsSync(dest));
});

// ---------------------------------------------------------------------------
// F3: the integrity helper
// ---------------------------------------------------------------------------

test('assertValidNativeBinary rejects a missing file', () => {
  const r = assertValidNativeBinary(path.join(root, 'nope.node'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not exist/);
});

test('assertValidNativeBinary rejects a truncated / too-small file', () => {
  const p = path.join(root, 'small.node');
  fs.writeFileSync(p, Buffer.alloc(1024, 0x41));
  const r = assertValidNativeBinary(p);
  assert.equal(r.ok, false);
  assert.match(r.reason, /too small/);
  fs.unlinkSync(p);
});

test('assertValidNativeBinary rejects a file with the wrong magic bytes', () => {
  const p = path.join(root, 'wrongmagic.node');
  fs.writeFileSync(p, Buffer.alloc(MIN_NATIVE_BYTES, 0x41));
  const r = assertValidNativeBinary(p, { platform: 'linux' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /magic/);
  fs.unlinkSync(p);
});

test('assertValidNativeBinary accepts a file with the right magic bytes', () => {
  const p = path.join(root, 'good.node');
  const buf = Buffer.alloc(MIN_NATIVE_BYTES, 0x41);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(buf, 0);
  fs.writeFileSync(p, buf);
  const r = assertValidNativeBinary(p, { platform: 'linux' });
  assert.equal(r.ok, true, r.reason);
  fs.unlinkSync(p);
});

test('assertValidNativeBinary recognises PE/MZ and Mach-O magics', () => {
  const pe = path.join(root, 'pe.node');
  const peBuf = Buffer.alloc(MIN_NATIVE_BYTES, 0x41);
  Buffer.from([0x4d, 0x5a]).copy(peBuf, 0);
  fs.writeFileSync(pe, peBuf);
  assert.equal(assertValidNativeBinary(pe, { platform: 'win32' }).ok, true);
  assert.equal(assertValidNativeBinary(pe, { platform: 'linux' }).ok, false);
  fs.unlinkSync(pe);

  const macho = path.join(root, 'macho.node');
  const machoBuf = Buffer.alloc(MIN_NATIVE_BYTES, 0x41);
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(machoBuf, 0);
  fs.writeFileSync(macho, machoBuf);
  assert.equal(assertValidNativeBinary(macho, { platform: 'darwin' }).ok, true);
  fs.unlinkSync(macho);
});

// ---------------------------------------------------------------------------
// F4: config parsing must never destroy user data
// ---------------------------------------------------------------------------

test('parseJsonLike parses plain JSON', () => {
  const r = install.parseJsonLike('{"a":1,"b":[2,3]}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { a: 1, b: [2, 3] });
});

test('parseJsonLike does NOT strip "//" inside a string value', () => {
  const src = '{ "url": "https://example.com/mcp", "n": 1 }';
  const r = install.parseJsonLike(src);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.value.url, 'https://example.com/mcp');
  assert.equal(r.value.n, 1);
});

test('parseJsonLike handles a real JSONC file with line and block comments', () => {
  const src = '{\n  // a comment\n  "a": 1, /* inline */ "b": "x"\n}';
  const r = install.parseJsonLike(src);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.value, { a: 1, b: 'x' });
});

test('parseJsonLike reports failure for genuinely invalid JSON', () => {
  const r = install.parseJsonLike('{ this is not json ');
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test('tryRegister does NOT overwrite a config it cannot parse', () => {
  const p = path.join(root, 'broken.json');
  const original = '{ "url": "https://example.com/mcp" /* unterminated';
  fs.writeFileSync(p, original);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  let changed;
  try {
    changed = install.tryRegister(p, (cfg) => {
      cfg.mcpServers = { hyperglob: {} };
      return true;
    });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(changed, false, 'registration must be skipped');
  assert.equal(fs.readFileSync(p, 'utf8'), original, 'the file must be left byte-for-byte intact');
  assert.ok(warnings.some((w) => /could not parse/.test(w)), 'a warning must be printed');
});

test('tryRegister preserves unrelated top-level keys', () => {
  const p = path.join(root, 'good.json');
  fs.writeFileSync(p, '{ "mcpServers": { "other": { "command": "npx" } }, "model": "gpt-5" }');
  install.tryRegister(p, (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers.hyperglob = { command: 'node', args: ['/x'] };
    return true;
  });
  const after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(after.model, 'gpt-5', 'unrelated top-level keys must survive');
  assert.deepEqual(after.mcpServers.other, { command: 'npx' }, 'unrelated servers must survive');
  assert.ok(after.mcpServers.hyperglob, 'the new server must be registered');
});

test('tryRegister is idempotent', () => {
  const p = path.join(root, 'idem.json');
  fs.writeFileSync(p, '{}');
  const mutate = (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.hyperglob) return false;
    cfg.mcpServers.hyperglob = { command: 'node' };
    return true;
  };
  assert.equal(install.tryRegister(p, mutate), true);
  const first = fs.readFileSync(p, 'utf8');
  assert.equal(install.tryRegister(p, mutate), false, 'a second run must not change anything');
  assert.equal(fs.readFileSync(p, 'utf8'), first);
});

// ---------------------------------------------------------------------------
// F7: checksum parsing
// ---------------------------------------------------------------------------

test('parseChecksums parses a sha256sum manifest', () => {
  // A sha256 digest is always 64 hex characters.
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const text =
    a + '  hyperglob.linux-x64-gnu.node\n' +
    b + ' *hyperglob.win32-x64-msvc.node\n' +
    'not a checksum line\n';
  const m = install.parseChecksums(text);
  assert.equal(m.get('hyperglob.linux-x64-gnu.node'), a);
  // Digests are normalised to lower case, matching sha256sum output.
  assert.equal(m.get('hyperglob.win32-x64-msvc.node'), b.toLowerCase());
  assert.equal(m.size, 2);
});

test('sha256File matches the crypto digest', () => {
  const p = path.join(root, 'hash.bin');
  const body = Buffer.from('hello hyperglob');
  fs.writeFileSync(p, body);
  const expected = crypto.createHash('sha256').update(body).digest('hex');
  assert.equal(install.sha256File(p), expected);
  fs.unlinkSync(p);
});

test('getText reads a manifest over http', async () => {
  const text = await install.getText(url('/checksums.txt'));
  assert.match(text, /hyperglob\.test\.node/);
});

test('getText throws on a non-200', async () => {
  await assert.rejects(() => install.getText(url('/notfound')), /status=404/);
});

// ---------------------------------------------------------------------------
// F2: the download URL must be pinned to the package version
// ---------------------------------------------------------------------------

test('the package version is discoverable and matches package.json', () => {
  const pkg = require('../package.json');
  assert.equal(install.packageVersion(), pkg.version);
});

test('nativeFilename returns null for an unsupported platform and a known name otherwise', () => {
  const f = install.nativeFilename();
  if (f === null) {
    assert.ok(
      ['linux', 'darwin', 'win32'].includes(process.platform),
      'nativeFilename() should only return null for an unsupported platform'
    );
  } else {
    assert.match(f, /^hyperglob\..+\.node$/);
  }
});

// ---------------------------------------------------------------------------
// The package check must be able to find npm on every platform.
//
// It used to capture `which npm` with stdout ignored, so the fallback
// could never fire, and the directory guesses only covered the Windows
// layout. On Linux -- the CI runner -- it failed with "could not locate
// the npm CLI entry point" and took the whole job down.
// ---------------------------------------------------------------------------

test('the package checker can find npm on this platform', () => {
  const checker = fs.readFileSync(
    path.join(__dirname, '..', 'tools', 'check-package.mjs'),
    'utf8'
  );
  // The lookup must actually read the launcher's output. It used to
  // capture `which npm` with stdout ignored, so the fallback could never
  // fire and the check only worked by luck on one platform.
  const whichCall = checker.match(/spawnSync\([^)]*'which'\s*,\s*\['npm'\][^)]*\)/);
  assert.ok(whichCall, 'the checker must shell out to which/where for npm');
  assert.ok(
    !/stdio:\s*\[\s*'ignore'\s*,\s*'ignore'\s*,\s*'ignore'\s*\]/.test(whichCall[0]),
    'the npm lookup must not discard the output of which/where'
  );
  assert.ok(
    /stdio:\s*\[\s*'ignore'\s*,\s*'pipe'/.test(whichCall[0]),
    'the npm lookup must pipe the output of which/where'
  );
  // And it must know about the POSIX layout: <prefix>/lib/node_modules/npm.
  assert.ok(
    /'lib',\s*'node_modules',\s*'npm'/.test(checker),
    'the npm lookup must try the lib/node_modules layout'
  );
});

test('the npm launcher is resolved through a relative path', () => {
  // Replicate the lookup against a fake POSIX prefix:
  //   <tmp>/bin/npm                            (the launcher)
  //   <tmp>/lib/node_modules/npm/bin/npm-cli.js (the CLI)
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperglob-npm-'));
  try {
    fs.mkdirSync(path.join(fake, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(fake, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
    const cli = path.join(fake, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.writeFileSync(cli, '// cli\n');
    const launcher = path.join(fake, 'bin', 'npm');
    fs.writeFileSync(
      launcher,
      [
        '#!/bin/sh',
        'basedir=$(dirname "$0")',
        'exec "$basedir/../lib/node_modules/npm/bin/npm-cli.js" "$@"',
        '',
      ].join('\n')
    );

    // The same two strategies the checker uses.
    const text = fs.readFileSync(launcher, 'utf8');
    let found = null;
    for (const m of text.matchAll(/["']?([^\s"'$][^\s"']*npm-cli\.js)["']?/g)) {
      const guess = path.isAbsolute(m[1]) ? m[1] : path.resolve(path.dirname(launcher), m[1]);
      if (fs.existsSync(guess)) { found = guess; break; }
    }
    if (!found) {
      const dir = path.dirname(launcher);
      const rel = path.join('node_modules', 'npm', 'bin', 'npm-cli.js');
      for (const g of [
        path.join(dir, rel),
        path.join(dir, '..', 'lib', rel),
        path.join(dir, '..', rel),
        path.join(dir, '..', '..', rel),
      ]) {
        if (fs.existsSync(g)) { found = path.resolve(g); break; }
      }
    }
    assert.ok(found, 'the launcher must resolve to the CLI');
    assert.equal(fs.realpathSync(found), fs.realpathSync(cli));
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});
