/**
 * The API reference is generated from public/js/api-spec.js. This checks that
 * spec against the routes actually mounted, so the docs cannot drift from the
 * code: every documented path must exist, and every authenticated route must
 * be documented.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('../src/app');

/** Load the browser spec file in a sandbox and return window.API_SPEC. */
function loadSpec() {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/api-spec.js'), 'utf-8');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.API_SPEC;
}

/** Walk the mounted Express app and collect "METHOD /full/path" strings. */
function mountedRoutes(expressApp) {
  const routes = [];

  function walk(stack, prefix) {
    for (const layer of stack) {
      if (layer.route) {
        const routePath = layer.route.path;
        const methods = Object.keys(layer.route.methods).filter((m) => m !== '_all');
        for (const method of methods) {
          routes.push(`${method.toUpperCase()} ${prefix}${routePath}`);
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        // Recover the mount path from the layer's regexp.
        const mount = layerMountPath(layer);
        walk(layer.handle.stack, prefix + mount);
      }
    }
  }

  function layerMountPath(layer) {
    if (layer.regexp && layer.regexp.fast_slash) return '';
    const match = layer.regexp && layer.regexp.source
      .replace('^\\/', '/')
      .replace('\\/?(?=\\/|$)', '')
      .replace(/\\\//g, '/');
    return match && match.startsWith('/') ? match : '';
  }

  walk(expressApp._router.stack, '');
  return routes;
}

/** Normalise ":param" and Express regex params to a common placeholder. */
function canonical(route) {
  // Fold ":param" and a trailing slash (a router mounted at /x with route "/"
  // yields "/x/", but the spec writes "/x").
  return route.replace(/:[A-Za-z]+/g, ':x').replace(/(.)\/+$/, '$1');
}

describe('The API reference matches the mounted routes', () => {
  const spec = loadSpec();
  const routes = new Set(mountedRoutes(app).map(canonical));

  const documented = [];
  for (const section of spec.sections) {
    for (const ep of section.endpoints || []) {
      documented.push({ id: ep.id, key: canonical(`${ep.method} /api${ep.path}`) });
    }
  }

  test('every documented endpoint is a real route', () => {
    const missing = documented.filter((d) => !routes.has(d.key));
    assert.deepStrictEqual(missing.map((m) => `${m.id} (${m.key})`), [], 'documented but not mounted');
  });

  test('the spec is internally consistent', () => {
    const ids = documented.map((d) => d.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'endpoint ids are unique');
    for (const section of spec.sections) {
      assert.ok(section.id && section.title && section.icon, `section ${section.id} is complete`);
    }
  });

  test('every authenticated API route is documented', () => {
    // Routes a merchant or integrator calls. Excludes internal/no-doc paths.
    const exclude = new Set([
      'GET /healthz', 'GET /readyz',
      // Static pages, redirects and the checkout HTML are not API endpoints.
    ]);
    const apiRoutes = [...routes].filter((r) => r.includes(' /api/') || r === 'GET /api/chains');
    const documentedKeys = new Set(documented.map((d) => d.key));

    // Status write endpoints are developer-only and intentionally undocumented
    // for now; note them rather than fail.
    // The owner panel's API is the operator's own, not an integrator's; the
    // Telegram bot's internal endpoints are the bot's, behind its own secret.
    const undocumented = apiRoutes.filter((r) => !documentedKeys.has(r) && !exclude.has(r) && !r.includes('/api/status/incidents') && !r.includes('/api/owner') && !r.includes('/api/telegram/internal'));

    assert.deepStrictEqual(undocumented, [], `these mounted API routes have no docs entry: ${undocumented.join(', ')}`);
  });
});

describe('Docs content is well formed', () => {
  function loadDocs() {
    const src = fs.readFileSync(path.join(__dirname, '../public/js/docs-content.js'), 'utf-8');
    const sandbox = { window: {} };
    vm.runInNewContext(src, sandbox);
    return sandbox.window.DOCS_CONTENT;
  }

  test('every section has an id, title, icon, group and blocks', () => {
    for (const s of loadDocs().sections) {
      assert.ok(s.id && s.title && s.icon && s.group, `section ${s.id}`);
      assert.ok(Array.isArray(s.blocks) && s.blocks.length > 0, `${s.id} has blocks`);
    }
  });

  test('it reflects the ten-chain, wallet-pay, wallet-name product', () => {
    const text = JSON.stringify(loadDocs());
    for (const needle of ['BASE', 'Polygon', 'Avalanche', 'wallet', 'Naming your wallets', 'Connect wallet', 'fixed-rate']) {
      assert.ok(text.includes(needle), `docs mention ${needle}`);
    }
    assert.ok(!/ETH, BTC, LTC(,| or) SOL/.test(text), 'no stale four-chain list');
  });
});

describe('Help Center content is well formed', () => {
  function loadHelp() {
    const src = fs.readFileSync(path.join(__dirname, '../public/js/help-content.js'), 'utf-8');
    const sandbox = { window: {} };
    vm.runInNewContext(src, sandbox);
    return sandbox.window.HELP_CONTENT;
  }

  test('every section has an id, title, icon, group and blocks', () => {
    for (const s of loadHelp().sections) {
      assert.ok(s.id && s.title && s.icon && s.group, `section ${s.id}`);
      assert.ok(Array.isArray(s.blocks) && s.blocks.length > 0, `${s.id} has blocks`);
    }
  });

  test('it reflects the whole registry and drops the stale four-chain answer', () => {
    const text = JSON.stringify(loadHelp());
    const { CODES, list } = require('../src/config/chains');
    for (const needle of ['Polygon', 'Avalanche', 'Base', 'wallet-pay', 'checkout', String(CODES.length), 'USDC and USDT']) {
      assert.ok(text.includes(needle), `help mentions ${needle}`);
    }
    // every chain added since the founding ten is named in the networks answer
    for (const chain of list().slice(10)) assert.ok(text.includes(chain.name), `help names ${chain.name}`);
    assert.ok(!/four major blockchain/.test(text), 'no stale four-chain answer');
    assert.ok(!/Ten networks across/.test(text), 'no stale ten-chain answer');
  });

  test('the support section still offers contact channels', () => {
    const support = loadHelp().sections.find((s) => s.id === 'support');
    assert.ok(support, 'support section exists');
    const channels = support.blocks.find((b) => b.type === 'channels');
    assert.ok(channels && channels.items.length >= 2, 'has a channels block');
    for (const c of channels.items) {
      assert.ok(c.label && c.href && c.svg, `channel ${c.label} is complete`);
    }
  });
});

describe('API reference code samples', () => {
  const js = fs.readFileSync(path.join(__dirname, '../public/js/api-reference.js'), 'utf-8');
  const css = fs.readFileSync(path.join(__dirname, '../public/css/api-reference.css'), 'utf-8');

  test('offers cURL, Node, Python, Go, Ruby, C++ and C', () => {
    for (const id of ['curl', 'node', 'python', 'go', 'ruby', 'cpp', 'c']) {
      assert.ok(new RegExp(`id: '${id}',`).test(js), `LANGS includes ${id}`);
    }
    for (const fn of ['goSample', 'rubySample', 'cppSample', 'cSample']) {
      assert.ok(js.includes(`function ${fn}`), `${fn} generator exists`);
    }
  });

  test('every LANGS highlight id is one the bundled highlighter registers', () => {
    const hl = fs.readFileSync(path.join(__dirname, '../public/js/vendor/highlight.min.js'), 'utf-8');
    for (const id of ['bash', 'javascript', 'python', 'go', 'ruby', 'cpp', 'c']) {
      assert.ok(hl.includes(`registerLanguage("${id}"`), `highlighter has ${id}`);
    }
  });

  test('code text is a fixed light colour, not a theme token that vanishes in dark mode', () => {
    // The pre background is always #1e1e1e; base text tied to --line-strong
    // turned dark-grey-on-near-black in dark mode.
    const preCode = css.slice(css.indexOf('pre code {'), css.indexOf('}', css.indexOf('pre code {')));
    assert.match(preCode, /color:\s*#d4d4d4/);
    assert.ok(!/var\(--line-strong\)/.test(preCode), 'not the theme token');
    const hljs = css.slice(css.indexOf('.hljs {'), css.indexOf('}', css.indexOf('.hljs {')));
    assert.match(hljs, /color:\s*#d4d4d4/);
  });
});
