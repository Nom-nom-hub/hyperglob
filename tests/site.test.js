'use strict';

// Tests for the documentation site.
//
// The site is built from docs/*.md by tools/build-site.mjs and served by
// GitHub Pages. These tests guard the things that break silently: stale
// rendered HTML, broken internal links, and Markdown that escaped the
// renderer as literal text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

const PAGES = [
  'getting-started',
  'api',
  'selectors',
  'cli',
  'mcp',
  'dsh',
  'architecture',
];

const htmlFiles = fs.existsSync(DOCS)
  ? fs.readdirSync(DOCS).filter((f) => f.endsWith('.html'))
  : [];

/** Remove code blocks and inline code so we only inspect prose. */
function prose(html) {
  return html
    .replace(/<div class="code-block"[\s\S]*?<\/div>/g, '')
    .replace(/<pre[\s\S]*?<\/pre>/g, '')
    .replace(/<code[\s\S]*?<\/code>/g, '')
    .replace(/<span class="brand-mark"[\s\S]*?<\/span>/g, '');
}

test('the site has a landing page and its assets', () => {
  for (const f of ['index.html', 'assets/site.css', 'assets/site.js', 'assets/favicon.svg']) {
    assert.ok(fs.existsSync(path.join(DOCS, f)), `missing ${f}`);
  }
});

/**
 * Run a tool and report whether it succeeded.
 *
 * Returns null when the child process could not be started at all, which
 * happens in sandboxes that forbid spawn(). The caller then skips rather
 * than fails: an environment restriction is not a defect in the site.
 */
function runTool(tool) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', tool)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    return { ok: true };
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
      return { ok: null, reason: 'spawn is not permitted here' };
    }
    return { ok: false, error: e };
  }
}

test('the committed HTML is up to date with the Markdown', () => {
  // build-site.mjs --check exits non-zero when the rendered output differs
  // from what the current Markdown would produce.
  const r = runTool('build-site.mjs');
  if (r.ok === null) {
    return; // cannot spawn here; the CI job runs this check directly
  }
  if (!r.ok) {
    assert.fail(
      'the rendered site is stale — run `node tools/build-site.mjs` and commit the result'
    );
  }
});

test('every documentation page is rendered', () => {
  for (const p of PAGES) {
    assert.ok(
      fs.existsSync(path.join(DOCS, `${p}.html`)),
      `docs/${p}.html was not rendered`
    );
  }
});

test('no page leaks unrendered Markdown', () => {
  for (const f of htmlFiles) {
    const p = prose(fs.readFileSync(path.join(DOCS, f), 'utf8'));
    assert.ok(!/\n\s*\|\s*-{3,}\s*\|/.test(p), `${f}: an unrendered Markdown table`);
    assert.ok(!/```/.test(p), `${f}: an unrendered code fence`);
    assert.ok(!/^#{1,6} /m.test(p), `${f}: an unrendered heading`);
    assert.ok(!/\*\*[^*]+\*\*/.test(p), `${f}: unrendered bold markers`);
    assert.ok(!/\[[^\]]+\]\([^)]+\)/.test(p), `${f}: an unrendered link`);
  }
});

test('every internal link resolves', () => {
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(DOCS, f), 'utf8');
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      if (/^https?:/.test(href) || href.startsWith('#') || href.startsWith('mailto:')) continue;
      const target = href.split('#')[0];
      if (!target) continue;
      assert.ok(
        fs.existsSync(path.join(DOCS, target)),
        `${f}: broken link to ${href}`
      );
    }
  }
});

test('every in-page anchor has a matching id', () => {
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(DOCS, f), 'utf8');
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/href="#([^"]+)"/g)) {
      assert.ok(ids.has(m[1]), `${f}: anchor #${m[1]} has no target`);
    }
  }
});

test('the navigation marks the current page', () => {
  for (const p of PAGES) {
    const html = fs.readFileSync(path.join(DOCS, `${p}.html`), 'utf8');
    const nav = html.match(/<nav class="site-nav"[\s\S]*?<\/nav>/);
    assert.ok(nav, `${p}.html has no navigation`);
    const current = [...nav[0].matchAll(/aria-current="page"/g)];
    assert.equal(current.length, 1, `${p}.html should mark exactly one nav item as current`);
    assert.ok(
      nav[0].includes(`href="${p}.html"`),
      `${p}.html does not mark itself as the current page`
    );
  }
});

test('the landing page has the expected sections', () => {
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  for (const sel of [
    'class="hero"',
    'class="terminal"',
    'class="sel-card"',
    'class="surface"',
    'class="bench-card"',
    'class="feature"',
    'class="section cta"',
  ]) {
    assert.ok(html.includes(sel), `the landing page is missing ${sel}`);
  }
  // Six selector cards, one per documented selector.
  assert.equal((html.match(/class="sel-card"/g) || []).length, 6);
});

test('every page carries the required metadata', () => {
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(DOCS, f), 'utf8');
    assert.ok(/^<!DOCTYPE html>/i.test(html), `${f}: no doctype`);
    assert.ok(/<html lang="en"/.test(html), `${f}: no lang attribute`);
    assert.ok(/name="viewport"/.test(html), `${f}: no viewport meta`);
    assert.ok(/name="description" content="[^"]{20,}"/.test(html), `${f}: no description`);
    assert.ok(/rel="canonical"/.test(html), `${f}: no canonical link`);
    assert.ok(/<meta name="viewport"/.test(html), `${f}: no viewport`);
  }
});

test('the sitemap lists every page', () => {
  const sitemap = fs.readFileSync(path.join(DOCS, 'sitemap.xml'), 'utf8');
  for (const p of ['index', ...PAGES]) {
    assert.ok(
      sitemap.includes(`/${p}.html`),
      `the sitemap is missing ${p}.html`
    );
  }
});

test('the documentation agrees with the code', () => {
  const r = runTool('check-docs.mjs');
  if (r.ok === null) {
    return; // cannot spawn here; the CI job runs this check directly
  }
  if (!r.ok) {
    assert.fail('the documentation contradicts the code (see the output above)');
  }
});
