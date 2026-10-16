#!/usr/bin/env node
'use strict';
// hyperglob CLI — built for agents and shell pipelines.
//   hyperglob 'src/**/*.ts :contains("export const")' [--cwd dir] [--json] [--content]
const { hyperglobSync } = require('./index.js');

function main(argv) {
  const args = argv.slice(2);
  const patterns = [];
  const options = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--cwd') options.cwd = args[++i];
    else if (a === '--no-gitignore') options.gitignore = false;
    else if (a === '--dot') options.dot = true;
    else if (a === '--content') options.content = true;
    else if (a === '--max-depth') options.maxDepth = parseInt(args[++i], 10);
    else if (a === '--threads') options.threads = parseInt(args[++i], 10);
    else if (a.startsWith('--')) {
      console.error(`hyperglob: unknown flag ${a}`);
      process.exit(2);
    } else patterns.push(a);
  }
  if (patterns.length === 0) {
    console.error('usage: hyperglob <pattern...> [options]');
    process.exit(2);
  }
  const entries = hyperglobSync(patterns, options);
  if (json) {
    console.log(JSON.stringify(entries.map((e) => ({
      path: e.path,
      relativePath: e.relativePath,
      size: e.size,
      modified: e.modified ? e.modified.toISOString() : undefined,
      content: e.content,
    })), null, 2));
  } else {
    for (const e of entries) console.log(e.relativePath);
  }
}

main(process.argv);
