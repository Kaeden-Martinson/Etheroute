/**
 * Link previews and the logo: every public page carries Open Graph and
 * Twitter tags with absolute image URLs filled in from the request, and
 * the images they point at exist at the sizes the networks want.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const app = require('../src/app');

const PUBLIC = path.join(__dirname, '..', 'public');
const PAGES = ['index', 'about', 'docs', 'api-reference', 'faq', 'help', 'status', 'terms', 'privacy', 'compliance', 'auth', 'checkout'];
const pngSize = (file) => { const b = fs.readFileSync(path.join(PUBLIC, 'img', file)); assert.strictEqual(b.toString('ascii', 1, 4), 'PNG', file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

let server;
let base;
before(async () => { await new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }); });
after(async () => { await new Promise((r) => server.close(r)); });

describe('The tags in the files', () => {
  test('every public page names itself for a preview, with the origin left for the server to fill in', () => {
    for (const page of PAGES) {
      const html = fs.readFileSync(path.join(PUBLIC, `${page}.html`), 'utf-8');
      for (const tag of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt']) assert.ok(html.includes(`property="${tag}"`), `${page}: ${tag}`);
      for (const tag of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) assert.ok(html.includes(`name="${tag}"`), `${page}: ${tag}`);
      assert.ok(html.includes('content="__SITE_URL__/img/og-image.png"'), `${page}: the image is absolute once served`);
      assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'), page);
      assert.ok(html.includes('<link rel="apple-touch-icon" href="/img/apple-touch-icon.png">'), page);
      assert.ok(html.includes('<meta name="description"'), `${page}: a description for search results`);
      assert.ok(!/content="\/img\/etheroute\.png"/.test(html), `${page}: no relative image URL, which previews ignore`);
    }
  });

  test('the images exist at the sizes the networks want', () => {
    assert.deepStrictEqual(pngSize('og-image.png'), [1200, 630]);
    assert.deepStrictEqual(pngSize('logo-512.png'), [512, 512]);
    assert.deepStrictEqual(pngSize('logo-192.png'), [192, 192]);
    assert.deepStrictEqual(pngSize('apple-touch-icon.png'), [180, 180]);
    assert.deepStrictEqual(pngSize('etheroute.png'), [512, 512], 'the old name still serves the mark');
    for (const svg of ['logo.svg', 'logo-dark.svg']) {
      const text = fs.readFileSync(path.join(PUBLIC, 'img', svg), 'utf-8');
      assert.ok(text.includes('<svg') && text.includes('style="color:#'), `${svg} is a standalone mark with its own colour`);
    }
    assert.ok(fs.statSync(path.join(PUBLIC, 'img', 'og-image.png')).size < 400 * 1024, 'the card stays light');
  });
});

describe('The tags as served', () => {
  test('the origin comes from the request - and from the proxy\'s scheme behind one', async () => {
    const plain = await (await fetch(`${base}/about`)).text();
    assert.ok(plain.includes(`<meta property="og:url" content="${base}/about">`));
    assert.ok(plain.includes(`<meta property="og:image" content="${base}/img/og-image.png">`));
    assert.ok(!plain.includes('__SITE_URL__'));
    const checkout = await (await fetch(`${base}/checkout/some-session`)).text();
    assert.ok(checkout.includes('<meta property="og:title" content="Pay with crypto - Etheroute">'));
    assert.ok(checkout.includes(`content="${base}/img/og-image.png"`));
  });

  test('SITE_URL pins the origin whatever host the request came in on', async () => {
    process.env.SITE_URL = 'https://pinned.example/';
    try {
      const html = await (await fetch(`${base}/`)).text();
      assert.ok(html.includes('<meta property="og:image" content="https://pinned.example/img/og-image.png">'));
      assert.ok(html.includes('<meta property="og:url" content="https://pinned.example/">'));
    } finally {
      delete process.env.SITE_URL;
    }
  });
});
