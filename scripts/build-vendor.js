#!/usr/bin/env node
/**
 * Build the vendored browser assets in public/js/vendor and public/css/vendor.
 *
 * The content security policy allows scripts and styles from 'self' only, so
 * third-party libraries are bundled into the app rather than loaded from a CDN.
 * That also removes a supply-chain risk: a compromised CDN script would run on
 * the dashboard origin, where the session token lives.
 *
 * Re-run after upgrading chart.js or highlight.js:  npm run build:vendor
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'public/js/vendor');
const CSS_DIR = path.join(ROOT, 'public/css/vendor');

fs.mkdirSync(JS_DIR, { recursive: true });
fs.mkdirSync(CSS_DIR, { recursive: true });

function copy(from, to) {
  fs.copyFileSync(path.join(ROOT, from), path.join(ROOT, to));
  const { size } = fs.statSync(path.join(ROOT, to));
  console.log(`  ${to}  (${Math.round(size / 1024)} KB)`);
}

async function main() {
  console.log('Building vendor assets\n');

  // Chart.js ships a ready-made UMD build.
  copy('node_modules/chart.js/dist/chart.umd.js', 'public/js/vendor/chart.umd.js');

  // highlight.js publishes no browser bundle, so build one that exposes the
  // global window.hljs the API reference page expects.
  await esbuild.build({
    stdin: {
      contents: "import hljs from 'highlight.js/lib/common'; window.hljs = hljs;",
      resolveDir: ROOT,
      loader: 'js',
    },
    bundle: true,
    minify: true,
    format: 'iife',
    outfile: path.join(JS_DIR, 'highlight.min.js'),
  });
  const hl = fs.statSync(path.join(JS_DIR, 'highlight.min.js'));
  console.log(`  public/js/vendor/highlight.min.js  (${Math.round(hl.size / 1024)} KB)`);

  copy('node_modules/highlight.js/styles/atom-one-dark.min.css', 'public/css/vendor/atom-one-dark.min.css');

  console.log('\nDone.');
}

main().catch((error) => {
  console.error(`\nVendor build failed: ${error.message}\n`);
  process.exit(1);
});
