// Verify that the documentation does not contradict the code.
//
// The docs are hand-written, so they drift. This check asserts the handful
// of claims that are easiest to get wrong and most costly to get wrong:
// error messages, defaults, and the option surface.
//
// A failure here means the docs and the code disagree -- fix whichever is
// actually wrong, not the checker.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

const failures = [];
function expect(label, condition, detail) {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

// Load the doc pages that exist. Some may be absent during development.
const pages = ['getting-started', 'api', 'selectors', 'cli', 'mcp', 'architecture'];
const docText = pages
  .map((p) => {
    const f = path.join(DOCS, `${p}.md`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  })
  .join('\n');
const hasDocs = docText.trim().length > 0;

if (!hasDocs) {
  console.log('check-docs: no documentation pages found — skipping.');
  process.exit(0);
}

const indexJs = read('index.js');
const cliJs = read('cli.js');
const mcpJs = read('mcp.js');

// ---------------------------------------------------------------------------
// Error messages: the docs quote them verbatim, so they must match.
// ---------------------------------------------------------------------------
const maxDepthMsg = 'maxDepth must be a non-negative integer';
const threadsMsg = 'threads must be a non-negative integer';
const escapeMsg = 'pattern escapes the working directory';

// index.js builds the message from a template literal, so the literal
// "maxDepth must be..." never appears verbatim. Match the template instead.
const nonNegTemplate = /must be a non-negative integer, got/;
expect(
  'index.js raises the documented maxDepth error',
  nonNegTemplate.test(indexJs) && indexJs.includes("requireNonNegativeInt(options.maxDepth, 'maxDepth')"),
  'expected a maxDepth validation in index.js'
);
expect(
  'index.js raises the documented threads error',
  nonNegTemplate.test(indexJs) && indexJs.includes("requireNonNegativeInt(options.threads, 'threads')"),
  'expected a threads validation in index.js'
);
expect(
  'the escape error is produced by the Rust engine',
  read('src/engine.rs').includes(escapeMsg),
  `expected ${JSON.stringify(escapeMsg)} in src/engine.rs`
);

if (docText.includes(maxDepthMsg)) {
  expect(
    'the docs quote the real maxDepth error',
    nonNegTemplate.test(indexJs)
  );
}
if (docText.includes(threadsMsg)) {
  expect('the docs quote the real threads error', nonNegTemplate.test(indexJs));
}
if (docText.includes(escapeMsg)) {
  expect(
    'the docs quote the real escape error',
    read('src/engine.rs').includes(escapeMsg)
  );
}

// ---------------------------------------------------------------------------
// Option names: every option the docs mention as a supported option must
// exist in the JS option normalizer.
// ---------------------------------------------------------------------------
const knownOptions = [
  'cwd', 'gitignore', 'ignoreFiles', 'dot', 'maxDepth', 'threads',
  'stats', 'onlyFiles', 'followSymlinks', 'content', 'withContent',
  'ignore', 'pathsOnly', 'index',
];
for (const opt of knownOptions) {
  expect(
    `option "${opt}" is handled by index.js`,
    indexJs.includes(`options.${opt}`) || indexJs.includes(`options['${opt}']`)
  );
}

// ---------------------------------------------------------------------------
// Defaults: the docs must not claim a default the code does not use.
// ---------------------------------------------------------------------------
const defaults = {
  gitignore: 'true',
  ignoreFiles: 'true',
  dot: 'false',
  stats: 'true',
  onlyFiles: 'true',
  followSymlinks: 'false',
  content: 'false',
  pathsOnly: 'false',
  index: 'false',
};
for (const [opt, dflt] of Object.entries(defaults)) {
  const re = new RegExp(`\\|\s*\`${opt}\`\\s*\\|\\s*\`?${dflt}\`?\\s*\\|`, 'i');
  if (re.test(docText)) {
    const codeRe = new RegExp(`${opt}[^\\n]*default: ${dflt}|${opt}: ${dflt}`);
    expect(
      `the documented default for "${opt}" matches the code`,
      codeRe.test(indexJs) || indexJs.includes(`${opt} = ${dflt}`),
      `expected default ${dflt} for ${opt} in index.js`
    );
  }
}

// ---------------------------------------------------------------------------
// CLI exit codes and flags.
// ---------------------------------------------------------------------------
expect(
  'the CLI documents exit code 2 for usage errors',
  cliJs.includes('2') && docText.includes('2')
);
for (const flag of ['--max-depth', '--threads', '--json', '--paths-only', '--ignore', '--include-dirs', '--follow-symlinks', '--no-stats', '--dependents', '--index', '--dot', '--absolute']) {
  if (docText.includes(flag)) {
    expect(`the CLI implements ${flag}`, cliJs.includes(flag));
  }
}

// ---------------------------------------------------------------------------
// MCP tool names and the timeout behaviour.
// ---------------------------------------------------------------------------
for (const tool of ['hyperglob_query', 'hyperglob_paths', 'hyperglob_dependents']) {
  expect(`mcp.js implements ${tool}`, mcpJs.includes(tool));
  if (docText.includes(tool)) {
    expect(`the docs mention ${tool}`, true);
  }
}
expect(
  'the MCP timeout default is 60 seconds',
  mcpJs.includes('DEFAULT_TIMEOUT_MS = 60000')
);
expect(
  'the per-call timeout can override the server default',
  /resolveTimeoutMs\(args\.timeoutMs,\s*runner\.timeoutMs\)/.test(mcpJs)
);

// ---------------------------------------------------------------------------
// Registration is opt-in.
// ---------------------------------------------------------------------------
expect(
  'MCP auto-registration is opt-in',
  read('scripts/install.js').includes("HYPERGLOB_REGISTER_MCP === '1'")
);
if (docText.includes('HYPERGLOB_REGISTER_MCP')) {
  expect(
    'the docs mention the opt-in flag',
    docText.includes('HYPERGLOB_REGISTER_MCP=1')
  );
}

// ---------------------------------------------------------------------------
// The `stats: false` behaviour: `modified` is undefined, not an Invalid Date.
// ---------------------------------------------------------------------------
expect(
  'index.js returns undefined for modified when modifiedMs is absent',
  /modifiedMs === undefined[\s\S]{0,80}return undefined/.test(indexJs)
);
// The stale behaviour was "modified is an Invalid Date when stats is false".
// The docs may MENTION an Invalid Date to say it does not happen; what must
// not appear is a claim that it IS one.
if (/is (?:an? )?Invalid Date/i.test(docText)) {
  expect(
    'the docs do not claim modified is an Invalid Date',
    false,
    'the docs still describe the old Invalid Date behaviour'
  );
} else {
  expect('the docs do not claim modified is an Invalid Date', true);
}

// ---------------------------------------------------------------------------
// The streaming pathsOnly path is incremental (a native PathsScanner exists).
// ---------------------------------------------------------------------------
expect('index.js uses a native paths scanner for pathsOnly streaming', indexJs.includes('createPathsScanner'));
expect('the native module exposes createPathsScanner', read('src/lib.rs').includes('create_paths_scanner'));

// ---------------------------------------------------------------------------
// The warm index directory is excluded unconditionally.
// ---------------------------------------------------------------------------
expect(
  'the index directory is always excluded from results',
  /ignore_patterns\.push\("\.hyperglob"\.to_string\(\)\)/.test(read('src/engine.rs'))
);

// ---------------------------------------------------------------------------
// The exports map must expose the subpaths the docs tell users to import.
// ---------------------------------------------------------------------------
const pkg = JSON.parse(read('package.json'));
for (const sub of ['./mcp.js', './cli.js']) {
  expect(
    `the exports map exposes ${sub}`,
    Object.prototype.hasOwnProperty.call(pkg.exports, sub),
    'the docs show requiring this subpath'
  );
  expect(
    `the ${sub} file is in the published files list`,
    (pkg.files || []).includes(sub.replace('./', ''))
  );
}
expect(
  'the root export lists types first',
  Object.keys(pkg.exports['.'])[0] === 'types',
  'TypeScript needs the "types" condition first'
);

// ---------------------------------------------------------------------------
// The size units: kb and kib are the same multiplier.
// ---------------------------------------------------------------------------
const selectorsRs = read('src/selectors.rs');
expect(
  'kb and kib use the same multiplier',
  /strip_suffix\("kib"\)\s*\{\s*\n?\s*\(p, 1024\.0\)/.test(selectorsRs) &&
    /strip_suffix\("kb"\)\s*\{\s*\n?\s*\(p, 1024\.0\)/.test(selectorsRs)
);

// ---------------------------------------------------------------------------
// The regex flags: a `/pattern/flags` argument must be parsed as a
// regular expression with those flags, not as a literal search for the
// text "/pattern/flags". The docs must document them.
// ---------------------------------------------------------------------------
expect(
  'the regex flag set is parsed',
  /const REGEX_FLAG_CHARS/.test(selectorsRs) &&
    /\.case_insensitive\(flags\.contains\('i'\)\)/.test(selectorsRs) &&
    /fn split_regex_arg/.test(selectorsRs)
);
const selectorsMd = read('docs/selectors.md');
expect(
  'the docs document the regex flags',
  /`:contains\(\/regex\/flags\)`/.test(selectorsMd) && /\| `i` \| Case-insensitive/.test(selectorsMd)
);

// ---------------------------------------------------------------------------
// A version quoted in the docs must match the current version, or the
// example is lying. A stale version number is worse than no example.
// ---------------------------------------------------------------------------
const currentVersion = pkg.version;
const versionedDocs = pages
  .map((p) => path.join(DOCS, `${p}.md`))
  .filter((f) => fs.existsSync(f));
for (const f of versionedDocs) {
  const text = fs.readFileSync(f, 'utf8');
  // Only look at quoted version literals, e.g. version(); // '1.0.7'
  const quoted = [...text.matchAll(/['"](\d+\.\d+\.\d+)['"]/g)].map((m) => m[1]);
  for (const v of quoted) {
    expect(
      `${path.basename(f)} quotes the current version (${v})`,
      v === currentVersion,
      `the current version is ${currentVersion}`
    );
  }
}

console.log('');
if (failures.length) {
  console.error(`check-docs: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('check-docs: OK — documentation and code agree.');
