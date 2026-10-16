'use strict';
// The PRD's own examples, run live. `npm run example`
const { hyperglob, hyperglobSync } = require('../index.js');

async function main() {
  console.log('— §5.1 Async Streaming API —');
  // Note: entry.content is populated when `content: true`. With a :contains
  // query the file was already read in-flight in Rust, so this is zero
  // extra fs.readFile calls on the JS side.
  for await (const entry of hyperglob('src/**/*.ts :contains("useServerHook")', {
    cwd: __dirname + '/fixture',
    gitignore: true,
    stats: true,
    content: true,
  })) {
    console.log(entry.path);
    console.log(entry.size);
    console.log(entry.content);
  }

  console.log('— §5.2 Array Batch API —');
  const entries = hyperglobSync(['src/**/*.ts', '!src/**/*.test.ts'], {
    cwd: __dirname + '/fixture',
    maxDepth: 5,
    threads: 8,
  });
  for (const e of entries) console.log(e.relativePath, e.size);

  console.log('— §4 Extended Query Syntax —');
  const checks = [
    'src/**/*.ts',
    'src/**/*.ts :contains("export const")',
    'src/**/*.json :has-key("dependencies.react")',
    'src/**/* :size(<100kb)',
    'src/**/* :modified(>2026-10-01)',
  ];
  for (const q of checks) {
    const hits = hyperglobSync(q, { cwd: __dirname + '/fixture' });
    console.log(q, '=>', hits.map((h) => h.relativePath).join(', ') || '(none)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
