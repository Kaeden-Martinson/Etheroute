/**
 * Front-end / content-security-policy compatibility.
 *
 * The CSP sets `script-src 'self'` and helmet adds `script-src-attr 'none'`.
 * That combination silently breaks two things, with no server-side error and no
 * failing request — the browser just refuses to run the code:
 *
 *   - inline `onclick=` / `onsubmit=` attributes
 *   - scripts and stylesheets loaded from a CDN
 *
 * It is exactly the kind of breakage that ships unnoticed, so it is asserted here.
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

const PUBLIC_DIR = path.join(__dirname, '../public');

function readAll(dir, extension) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue; // third-party bundles are not ours to lint
      found.push(...readAll(full, extension));
    } else if (entry.name.endsWith(extension)) {
      found.push(full);
    }
  }
  return found;
}

const htmlFiles = readAll(PUBLIC_DIR, '.html');
const jsFiles = readAll(path.join(PUBLIC_DIR, 'js'), '.js');

// Matches a real inline handler attribute, not merely an attribute starting
// with "on" (data-dev-only= would otherwise trip a looser pattern).
const INLINE_HANDLER = /\son(?:click|submit|change|input|keyup|keydown|focus|blur|load|error|mouseover|mouseout)\s*=\s*"/gi;

describe('CSP - no inline event handlers', () => {
  for (const file of htmlFiles) {
    test(`${path.basename(file)} has none`, () => {
      const matches = fs.readFileSync(file, 'utf-8').match(INLINE_HANDLER) || [];
      assert.strictEqual(
        matches.length,
        0,
        `${path.basename(file)} has ${matches.length} inline handler(s): ${matches.join(', ')}. ` +
        'Use data-on-click / data-on-submit instead — script-src-attr \'none\' blocks these.'
      );
    });
  }

  for (const file of jsFiles) {
    test(`${path.relative(PUBLIC_DIR, file)} generates none`, () => {
      const matches = fs.readFileSync(file, 'utf-8').match(INLINE_HANDLER) || [];
      assert.strictEqual(
        matches.length,
        0,
        `${path.basename(file)} builds markup with ${matches.length} inline handler(s). ` +
        'Emit data-on-click instead.'
      );
    });
  }
});

describe('CSP - no external scripts or stylesheets', () => {
  const EXTERNAL = /(?:src|href)\s*=\s*"https?:\/\/[^"]*\.(?:js|css)(?:\?[^"]*)?"/gi;

  for (const file of htmlFiles) {
    test(`${path.basename(file)} loads only local assets`, () => {
      const matches = fs.readFileSync(file, 'utf-8').match(EXTERNAL) || [];
      assert.strictEqual(
        matches.length,
        0,
        `${path.basename(file)} loads ${matches.join(', ')} from a CDN. ` +
        'script-src/style-src are \'self\' — vendor the file into public/js/vendor instead.'
      );
    });
  }
});

describe('The action dispatcher is available wherever it is used', () => {
  for (const file of htmlFiles) {
    const source = fs.readFileSync(file, 'utf-8');
    if (!/data-on-(?:click|submit|change)/.test(source)) continue;

    test(`${path.basename(file)} includes actions.js`, () => {
      assert.ok(
        source.includes('/js/common/actions.js'),
        `${path.basename(file)} uses data-on-* attributes but never loads actions.js`
      );
    });
  }

  test('navbar markup is covered on every page', () => {
    // navbar.js injects data-on-click, so every page that renders it needs the
    // dispatcher regardless of its own markup.
    for (const file of htmlFiles) {
      const source = fs.readFileSync(file, 'utf-8');
      if (!source.includes('/js/common/navbar.js')) continue;
      assert.ok(
        source.includes('/js/common/actions.js'),
        `${path.basename(file)} loads navbar.js but not actions.js`
      );
    }
  });
});

describe('Password rules agree between client and server', () => {
  test('the signup page states the minimum the server enforces', () => {
    const authRoute = fs.readFileSync(path.join(__dirname, '../src/routes/auth.js'), 'utf-8');
    const serverMin = Number(/password\.length < (\d+)/.exec(authRoute)[1]);

    const clientJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/auth.js'), 'utf-8');
    const clientMin = Number(/password\.length < (\d+)/.exec(clientJs)[1]);

    assert.strictEqual(clientMin, serverMin, 'public/js/auth.js disagrees with the server');

    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'auth.html'), 'utf-8');
    assert.ok(
      html.includes(`At least ${serverMin} characters`),
      `auth.html should advertise a ${serverMin}-character minimum`
    );
  });
});

describe('One-time API key display', () => {
  const dashboardJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const dashboardHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');

  test('the key panel is a separate element from the list that gets re-rendered', () => {
    // loadAPIKeys() replaces #apiKeysContainer.innerHTML. If the newly issued
    // key were rendered inside that container, the refresh would erase it - the
    // key is unrecoverable, so this must not regress.
    assert.ok(
      dashboardHtml.includes('id="newApiKeyPanel"'),
      'dashboard.html is missing #newApiKeyPanel'
    );

    // The list is a one-line placeholder in the markup; the panel sits after
    // it as a sibling (under the key row, where the new key belongs), never
    // inside it.
    const listIndex = dashboardHtml.indexOf('id="apiKeysContainer"');
    const listLine = dashboardHtml.slice(listIndex, dashboardHtml.indexOf('\n', listIndex));
    assert.ok(listLine.includes('</div>'), '#apiKeysContainer closes on its own line');
    assert.ok(!listLine.includes('newApiKeyPanel'), '#newApiKeyPanel must not nest inside #apiKeysContainer');
    assert.ok(dashboardHtml.indexOf('id="newApiKeyPanel"') > listIndex, 'and follows it, under the key row');
  });

  /**
   * Slice out a top-level function body: from its signature to the first
   * closing brace that sits in column zero.
   */
  function functionBody(source, signature) {
    const start = source.indexOf(signature);
    if (start === -1) return null;
    const end = source.indexOf('\n}', start);
    return end === -1 ? source.slice(start) : source.slice(start, end + 2);
  }

  test('showNewApiKey writes to the panel, never to the refreshed list', () => {
    const fn = functionBody(dashboardJs, 'function showNewApiKey');
    assert.ok(fn, 'showNewApiKey not found');
    assert.ok(fn.includes('newApiKeyPanel'), 'showNewApiKey should target #newApiKeyPanel');
    assert.ok(
      !fn.includes('apiKeysContainer'),
      'showNewApiKey must not write into #apiKeysContainer - loadAPIKeys() overwrites it'
    );
  });

  test('the list refresh is awaited before the key is shown', () => {
    const fn = functionBody(dashboardJs, 'async function confirmGenerateAPIKey');
    assert.ok(fn, 'confirmGenerateAPIKey not found');
    assert.ok(
      /await\s+loadAPIKeys\(\)/.test(fn),
      'loadAPIKeys() must be awaited - an un-awaited refresh resolves after the key renders and wipes it'
    );

    assert.ok(
      fn.indexOf('await loadAPIKeys()') < fn.indexOf('showNewApiKey('),
      'the refresh must complete before the key is displayed'
    );
  });

  test('the key is assigned as text, not markup', () => {
    const fn = functionBody(dashboardJs, 'function showNewApiKey');
    assert.ok(
      fn.includes('.textContent = apiKey'),
      'the credential should be set with textContent so it is never parsed as HTML'
    );
  });

  test('the key can be dismissed explicitly', () => {
    assert.ok(dashboardJs.includes('function dismissNewApiKey'), 'missing dismissNewApiKey');
    assert.ok(
      dashboardJs.includes('data-on-click="dismissNewApiKey"'),
      'the panel should offer a dismiss control'
    );
  });
});

describe('The page bottom follows the theme', () => {
  /**
   * The footer and the closing call to action used a second palette,
   * --inverse-*, that was dark in BOTH themes. Under a light page that put a
   * black slab at the bottom that ignored the theme switch entirely, and it
   * forced every button inside those bands onto the inverse pair as well -
   * because a normal --ink button came out the same colour as the band (1.00:1
   * in light mode, invisible apart from its label).
   *
   * Both bands follow --ink / --surface now, so the second palette is gone and
   * the buttons in them are the ordinary ones.
   */
  const indexCss = fs.readFileSync(path.join(PUBLIC_DIR, 'css/index.css'), 'utf-8');
  const tokensCss = fs.readFileSync(path.join(PUBLIC_DIR, 'css/tokens.css'), 'utf-8');
  const aboutCss = fs.readFileSync(path.join(PUBLIC_DIR, 'css/about.css'), 'utf-8');

  /** Grab the declarations of the first rule whose selector contains `needle`. */
  function ruleBody(css, needle) {
    const index = css.indexOf(needle);
    if (index === -1) return null;
    const open = css.indexOf('{', index);
    const close = css.indexOf('}', open);
    return open === -1 || close === -1 ? null : css.slice(open + 1, close);
  }

  test('no stylesheet still reaches for the --inverse-* palette', () => {
    const dir = path.join(PUBLIC_DIR, 'css');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.css'))) {
      const css = fs.readFileSync(path.join(dir, file), 'utf-8');
      assert.ok(
        !/var\(--inverse-/.test(css),
        `${file}: --inverse-* is dark in both themes, so it cannot follow the theme`
      );
    }
    assert.ok(!/^\s*--inverse-/m.test(tokensCss), 'the tokens themselves should be gone too');
  });

  test('the footer takes its ground and its text from the theme', () => {
    const dir = path.join(PUBLIC_DIR, 'css');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.css'))) {
      const css = fs.readFileSync(path.join(dir, file), 'utf-8');
      const body = ruleBody(css, '\n.footer {');
      if (!body) continue;
      assert.match(body, /background:\s*var\(--surface-sunken\)/, `${file}: footer ground`);
      assert.match(body, /color:\s*var\(--ink\)/, `${file}: footer text`);
    }
  });

  test('the call-to-action band follows the theme as well', () => {
    const body = ruleBody(indexCss, '\n.cta-section {');
    assert.ok(body, 'index.css should style .cta-section');
    assert.match(body, /color:\s*var\(--ink\)/);
    assert.ok(!/--inverse-/.test(body), 'the band must not pin itself to one lightness');
  });

  test('its buttons are the ordinary inverted pair, with no band-specific override', () => {
    assert.ok(
      !indexCss.includes('.cta-section .btn:not('),
      'the band follows the theme now, so its solid button needs no override'
    );
    assert.ok(
      !tokensCss.includes('.footer .btn:not('),
      'same for the footer'
    );
    const primary = ruleBody(indexCss, '\n.btn-primary {');
    assert.match(primary, /background:\s*var\(--ink\)/);
    assert.match(primary, /color:\s*var\(--surface\)/);
  });

  test('hovering lightens or darkens the fill without losing the label', () => {
    // --ink-2 used to serve as the hover shade. It only moves the right way in
    // one theme: in dark mode it *darkens* the fill while the label stays
    // --surface (near-black), so the button dimmed towards its own text.
    assert.match(
      tokensCss,
      /--ink-hover:\s*color-mix\(in srgb, var\(--ink\)\s*\d+%, var\(--surface\)\)/,
      'the hover shade must be a mix of --ink towards --surface, so it moves with the theme'
    );
    for (const selector of ['.btn-primary:hover', '.btn-secondary:hover', '.btn-secondary-large:hover']) {
      const body = ruleBody(indexCss, `\n${selector} {`);
      assert.ok(body, selector);
      assert.match(body, /background:\s*var\(--ink-hover\)/, `${selector} background`);
      assert.match(body, /color:\s*var\(--surface\)/, `${selector} colour`);
    }
  });

  test('the about page ends on contact, with no closing band to theme', () => {
    // The page used to repeat the landing page's "Ready to Get Started?" band.
    // It now ends on the Get in touch block, so there is no second band here
    // that could drift away from the theme.
    const aboutHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'about.html'), 'utf-8');
    assert.ok(!aboutHtml.includes('cta-section'), 'no closing band in the markup');
    assert.ok(!aboutCss.includes('.cta-section'), 'and none left in the stylesheet');
    assert.ok(aboutHtml.includes('class="contact"'), 'the contact block is the ending');
  });
});

describe('Dashboard handles a rejected session', () => {
  const dashboardJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const checkoutJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard-checkout.js'), 'utf-8');
  const dashboardHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');

  test('every API call goes through the wrapper that handles 401', () => {
    // A stale token used to leave the dashboard rendered but dead: every
    // request 401'd and every action reported a generic failure.
    for (const [name, source] of [['dashboard.js', dashboardJs], ['dashboard-checkout.js', checkoutJs]]) {
      // /auth/verify is the pre-render check; /chains is public and needs no session.
      const raw = source.match(/await fetch\(`\$\{API_URL\}(?!\/auth\/verify|\/chains)/g) || [];
      assert.strictEqual(raw.length, 0, `${name} calls fetch() directly for the API in ${raw.length} place(s); use apiFetch()`);
    }
    assert.ok(dashboardJs.includes('async function apiFetch'));
    assert.ok(/response\.status === 401[\s\S]{0,80}endSession/.test(dashboardJs), 'apiFetch must end the session on 401');
  });

  test('the token is verified before the dashboard renders', () => {
    const load = dashboardJs.slice(dashboardJs.indexOf("window.addEventListener('load'"), dashboardJs.indexOf('function setupEventListeners'));
    assert.ok(load.includes('/auth/verify'), 'the load handler should verify the token');
    assert.ok(load.indexOf('/auth/verify') < load.indexOf('loadDashboardData()'), 'and do so before loading data');
  });

  test("wallet creation reports the server's reason", () => {
    const fn = dashboardJs.slice(dashboardJs.indexOf('async function createNewWallet'), dashboardJs.indexOf('async function loadAPIKeys'));
    assert.ok(fn.includes('errorMessageFrom(response'), 'the toast should carry the server message, not a fixed string');
  });

  test('the withdrawal badge has an icon before any data arrives', () => {
    assert.match(dashboardHtml, /class="status-badge available" data-icon="check"/);
  });
});

describe('Dashboard surfaces follow the theme', () => {
  test('no card, overlay or list item hardcodes a light background', () => {
    // The delete-wallet and API-key confirmation overlays were painted
    // rgba(248,248,248) regardless of theme, so in dark mode their light text
    // landed on a light panel. Any opaque near-white literal on a surface is
    // the same bug waiting to happen.
    const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8');
    const offenders = css.match(/background(?:-color)?:\s*(?:white|#fff\b|#ffffff|#f[0-9a-f]f[0-9a-f]f[0-9a-f]|rgba?\(\s*2[4-5]\d\s*,\s*2[4-5]\d\s*,\s*2[4-5]\d[^)]*\))/gi) || [];
    assert.deepStrictEqual(offenders, [], `use a --surface token instead: ${offenders.join(', ')}`);
  });
});

describe("Withdrawal review renders the server's figures", () => {
  const dashboardJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const review = dashboardJs.slice(dashboardJs.indexOf('function usd('), dashboardJs.indexOf('async function processWithdrawal'));

  test('no fee or gas is recomputed on the client', () => {
    // balance * 0.05 and a hardcoded 0.15 gas fallback made the per-chain
    // lines disagree with the totals beside them.
    assert.ok(!/\*\s*0\.05/.test(review), 'the fee comes from the server');
    assert.ok(!/0\.15/.test(review), 'no invented gas figure');
    assert.ok(review.includes('data.transfers'), 'lines come from the preview breakdown');
  });

  test('no inline colours - the review must follow the theme', () => {
    assert.ok(!/#27ae60|#f9f9f9|background:\s*#/.test(review), 'use summary-row--net / preview-item classes');
  });
});

describe('Status indicators are icons, not emoji', () => {
  test('no emoji glyph is used as a status marker in the dashboard', () => {
    // Emoji render differently on every platform and ignore the theme's
    // colours; the icon set in icons.js takes currentColor.
    const EMOJI = /[⏳⌛✓✔✗✖⚠\u{1F504}]/u;
    for (const file of ['js/dashboard.js', 'js/dashboard-checkout.js', 'dashboard.html']) {
      const source = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf-8');
      const hit = source.match(EMOJI);
      assert.strictEqual(hit, null, `${file} uses ${hit && hit[0]} - use <span class="inline-icon" data-icon="..."> instead`);
    }
  });

  test('the icon set provides the markers the dashboard asks for', () => {
    const icons = fs.readFileSync(path.join(PUBLIC_DIR, 'js/common/icons.js'), 'utf-8');
    const dashboard = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8') + fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
    const used = new Set([...dashboard.matchAll(/data-icon="([a-zA-Z]+)"/g)].map((m) => m[1]));
    for (const name of used) {
      assert.ok(icons.includes(`
  ${name}: () =>`), `icons.js has no "${name}" icon`);
    }
  });
});

describe('Withdrawal wallet selection', () => {
  const dashboardJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const fn = dashboardJs.slice(dashboardJs.indexOf('function displayWalletSelection'), dashboardJs.indexOf('async function getPreview'));

  test('zero ready wallets is shown as a red X; with some, the tally is the summary', () => {
    assert.ok(fn.includes('eligible > 0'), 'the summary must branch on the count');
    const zero = fn.slice(fn.indexOf('alert alert-error'), fn.indexOf('alert alert-error') + 120);
    assert.ok(zero.includes('data-icon="close"'), 'the zero case uses the error alert with the X icon');
    assert.ok(!fn.includes('alert alert-success'), 'no "found N wallets" banner: the rows and the tally say it');
    assert.ok(fn.includes('updateWithdrawTally();'));
  });

  test('a wallet is a row with a checkbox that says why it can or cannot be used', () => {
    assert.ok(fn.includes('<label class="wd-src${isEligible ? \'\' : \' is-off\'}">'), 'the row is the label, so the whole of it toggles the box');
    assert.ok(fn.includes('name="withdrawChain" value="${escapeHtml(wallet.address)}"'), 'the same checkbox getPreview() and processWithdrawal() read, escaped');
    assert.ok(fn.includes("'<span class=\"status-pill status-pill--verifying\">Confirming</span>'"));
    assert.ok(fn.includes("'<span class=\"status-pill status-pill--closed\">Below $5</span>'"));
    assert.ok(fn.includes('routeLabelFor(wallet, payoutChain, payoutAsset)'), 'an eligible row says whether it goes direct, through an on-chain swap, or through a swap');
    assert.ok(!fn.includes('wallet-card'), 'the old checkbox cards are gone');
  });
});

describe('Withdrawal: three steps, one receipt, one button', () => {
  const dashboardHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
  const dashboardJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8');
  const page = dashboardHtml.slice(dashboardHtml.indexOf('id="withdrawalPage"'), dashboardHtml.indexOf('id="createLinkPage"'));

  test('the page has the head every other page has, with the available figure as its action', () => {
    assert.match(page, /<h1 class="dash-head__title" data-reveal data-reveal-delay="60">Withdrawal<\/h1>/);
    assert.ok(page.includes('<div class="dash-head__actions wd-avail" data-reveal data-reveal-delay="100">'));
    assert.ok(page.includes('id="wdAvailable"') && page.includes('id="wdAvailableNote"'));
    const fn = dashboardJs.slice(dashboardJs.indexOf('function updateWithdrawalAvailable'), dashboardJs.indexOf('async function loadWithdrawalPage'));
    assert.ok(fn.includes('holdings(w) >= 5 && !w.isProcessing'), 'the same eligibility rule the rows use: coin and tokens together');
    assert.ok(dashboardJs.includes('withdrawal: loadWithdrawalPage,'), 'the switcher loads it');
  });

  test('the stepper is a three-step rail; the fourth stage is Sent, not a step', () => {
    const steps = [...page.matchAll(/<li[^>]*id="step(\d)-badge"[^>]*><span>Step \d<\/span><b>([^<]+)<\/b><\/li>/g)].map((m) => m[2]);
    assert.deepStrictEqual(steps, ['Destination', 'Sources', 'Review']);
    assert.ok(!page.includes('Connect'), 'nothing is "connected" here');
    assert.ok(!page.includes('step-badge'), 'the old badge row is gone');
    for (const id of ['step1', 'step2', 'step3', 'step4']) assert.ok(page.includes(`class="wd-stage${id === 'step1' ? ' active' : ''}" id="${id}"`), id);
    const go = dashboardJs.slice(dashboardJs.indexOf('function goToStep'), dashboardJs.indexOf('function goBackToStep'));
    assert.ok(go.includes("querySelectorAll('.wd-stage')") && go.includes("querySelectorAll('.wd-rail li')"));
    assert.ok(!go.includes('displayFinalSummary'), 'reaching stage 4 no longer redraws a summary; only a sent payout gets there');
    const back = dashboardJs.slice(dashboardJs.indexOf('function goBackToStep'), dashboardJs.indexOf('function updateWithdrawalAvailable'));
    assert.ok(back.includes('currentStep === 4'), 'from Sent the only way on is a new withdrawal');
    // a finished step wears the site's green dot, the one "Live" wears, not a tick
    const done = css.slice(css.indexOf('.wd-rail li.is-done b::after {'), css.indexOf('}', css.indexOf('.wd-rail li.is-done b::after {')));
    assert.ok(done.includes('border-radius: 50%') && done.includes('background: var(--ok)'), 'a dot');
    assert.ok(done.includes('box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 20%, transparent)'), 'with the same halo as .dash-live');
    assert.ok(!done.includes('2713'), 'no tick');
  });

  test('the address is checked for shape as it is typed, and says so honestly', () => {
    assert.match(page, /id="recipientAddress"[^>]*data-on-input="checkRecipientAddress"/);
    const fn = dashboardJs.slice(dashboardJs.indexOf('function checkRecipientAddress'), dashboardJs.indexOf('async function loadWithdrawalWallets'));
    assert.ok(fn.includes('`Looks like a ${spec.name} address`'));
    assert.ok(fn.includes('Does not look like a ${spec.name} address'));
    assert.ok(fn.includes('looksLikeAddressFor(chain, value)'), 'the same shape check the submit uses');
  });

  test('review is the receipt and the confirmation at once', () => {
    assert.ok(!page.includes('id="step4-badge"'), 'no fourth step');
    assert.ok(page.includes('<div id="preview-details"></div>'));
    assert.match(page, /<div class="wd-warn"><span class="inline-icon" data-icon="alert"><\/span><span>Once sent this cannot be reversed/);
    // the one button sends and names the figure
    assert.match(page, /data-on-click="processWithdrawal" id="confirmBtn">\s*<svg[^>]*>[\s\S]*?<\/svg>\s*<span id="confirmBtnLabel">Send<\/span>/);
    assert.ok(dashboardJs.includes('label.textContent = busy ? \'Sending…\' : `Send ${usd(netUsd)}`;'));
    const preview = dashboardJs.slice(dashboardJs.indexOf('function displayPreview'), dashboardJs.indexOf('function displayFinalSummary'));
    for (const part of ['<div class="receipt">', 'receipt__cap', 'renderTransferBreakdown(data)', 'renderTotals(data)', 'receipt__to', 'setSendButton(data.netAmountUsd, false)']) {
      assert.ok(preview.includes(part), part);
    }
    const lines = dashboardJs.slice(dashboardJs.indexOf('function renderTransferBreakdown'), dashboardJs.indexOf('function renderTotals'));
    assert.ok(lines.includes("t.gasIsLive ? '' : ' <span class=\"muted\">· estimate</span>'"), 'an estimated network fee says so');
    assert.ok(lines.includes('Platform fee (${rate}%)'), 'the rate is read from the preview');
    const totals = dashboardJs.slice(dashboardJs.indexOf('function renderTotals'), dashboardJs.indexOf('function setSendButton'));
    assert.ok(totals.includes('<div class="net"><span>You receive</span>'));
    // the send posts from the review, reports there, and lands on Sent
    const send = dashboardJs.slice(dashboardJs.indexOf('async function processWithdrawal'), dashboardJs.indexOf('function clearStep1'));
    assert.ok(send.includes("getElementById('step3-message')"));
    assert.ok(send.includes('displayFinalSummary(result);') && send.includes('goToStep(4);'));
    assert.ok(!send.includes('goToStep(1)'), 'a sent payout is shown, not wiped');
  });

  test('sent shows the payout and its transfers, and offers the two ways on', () => {
    const fn = dashboardJs.slice(dashboardJs.indexOf('function displayFinalSummary'), dashboardJs.indexOf('async function processWithdrawal'));
    assert.ok(fn.includes("getElementById('final-summary')") && fn.includes("getElementById('wdSentReceipt')"));
    assert.ok(fn.includes("t.type === 'DIRECT_TRANSFER' ? 'Sending' : 'Swapping'"));
    assert.ok(fn.includes('<span>Arriving</span>'));
    assert.match(page, /data-on-click="switchDashboardPage" data-arg="payouts">\s*<svg[\s\S]*?<\/svg>\s*See it in Payouts/);
    assert.match(page, /data-on-click="newWithdrawal">\s*<span data-icon="plus"><\/span>\s*New withdrawal/);
    assert.ok(dashboardJs.includes('function newWithdrawal()'));
  });

  test('every button on the page is the filled btn-small with a glyph', () => {
    const buttons = [...page.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length >= 7, `expected the step buttons, found ${buttons.length}`);
    for (const b of buttons) assert.match(b, /class="btn-small btn-primary"/, b);
    assert.ok(!page.includes('btn-ghost') && !page.includes('btn-secondary'));
    // the withdrawal vocabulary is in the stylesheet, themed
    for (const rule of ['.wd-rail li.is-done', '.wd-src', '.wd-tally b', '.receipt__cap', '.receipt__tot .net', '.wd-warn', '.wd-done']) {
      assert.ok(css.includes(`\n${rule}`) || css.includes(`\n${rule} `), rule);
    }
  });
});

describe('API: a page under Build, not a modal', () => {
  const dashboardHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
  const dashboardJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8');
  const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/api-calls.js'), 'utf-8');
  const page = dashboardHtml.slice(dashboardHtml.indexOf('id="apiPage"'), dashboardHtml.indexOf('id="accountPage"'));

  test('the modal and its pinned overlay are gone; the rail and the account page go to the page', () => {
    for (const gone of ['id="apiModal"', 'id="apiConfirmationOverlay"', 'closeAPIModalOnClickOutside', 'denyGenerateAPIKey', 'data-on-click="openAPIModal"']) {
      assert.ok(!dashboardHtml.includes(gone), gone);
    }
    assert.match(dashboardHtml, /<a class="nav-link" data-on-click="switchDashboardPage" data-arg="api">/);
    // the account row's button is the family's: filled, with the API rail glyph
    assert.match(dashboardHtml, /<button type="button" class="btn-small btn-primary" data-on-click="switchDashboardPage" data-arg="api">\s*<svg[^>]*><path d="M8 9l-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"\/><\/svg>\s*Manage\s*<\/button>/);
    assert.ok(dashboardJs.includes('api: loadApiPage,'), 'the switcher loads it');
    assert.ok(!dashboardJs.includes('function closeAPIModal') && !dashboardJs.includes('function denyGenerateAPIKey'));
    // anything that still asks for the modal gets the page
    assert.match(dashboardJs, /function openAPIModal\(\) \{\s*switchDashboardPage\('api'\);\s*\}/);
  });

  test('the head is the standard head, with the docs as its action', () => {
    assert.match(page, /<h1 class="dash-head__title" data-reveal data-reveal-delay="60">API<\/h1>/);
    assert.match(page, /<a class="btn-small btn-primary" href="\/api-reference" target="_blank" rel="noopener">\s*<span data-icon="book"><\/span>\s*View the docs/);
    const delays = [...page.matchAll(/<div class="fgroup" data-reveal data-reveal-delay="(\d+)">/g)].map((m) => Number(m[1]));
    assert.deepStrictEqual(delays, [180, 240, 300], 'three groups follow the head in');
  });

  test('the key is one row: glyph, prefix, when, and what you can do to it', () => {
    const fn = dashboardJs.slice(dashboardJs.indexOf('async function loadAPIKeys'), dashboardJs.indexOf('function copyQuickStart'));
    assert.ok(fn.includes('<div class="api-key__row is-none">'), 'no key: the row says so');
    assert.ok(fn.includes('data-on-click="generateNewAPIKey">${PLUS_GLYPH}Make a key'));
    assert.ok(fn.includes('<div class="api-key__row">'));
    assert.ok(fn.includes('<span class="dot">Active'), 'the green dot');
    assert.ok(fn.includes('data-on-click="generateNewAPIKey">${PLUS_GLYPH}New key'));
    assert.ok(fn.includes('class="btn-small btn-danger" data-on-click="revokeAPIKey">${CROSS_GLYPH}Revoke'), 'revoke is the one danger button');
    assert.ok(!fn.includes('style="'), 'no inline styles');
    assert.ok(fn.includes("quickKey.textContent = `${prefix}"), 'the quick start gets the prefix');
    // the glyph is a real key, not the broken path the mockup shipped with
    assert.ok(dashboardJs.includes('const API_KEY_GLYPH = \'<svg viewBox="0 0 24 24"'));
    assert.ok(dashboardJs.includes('7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4'));
  });

  test('making a key asks first when one exists; revoking always asks, in red', () => {
    const gen = dashboardJs.slice(dashboardJs.indexOf('async function generateNewAPIKey'), dashboardJs.indexOf('async function revokeAPIKey'));
    assert.ok(gen.includes(".api-key__row:not(.is-none)"), 'only when a key exists');
    assert.ok(gen.includes('await confirmDialog({') && gen.includes("confirmText: 'Make a new key'"));
    assert.ok(gen.includes('confirmGenerateAPIKey();'));
    const rev = dashboardJs.slice(dashboardJs.indexOf('async function revokeAPIKey'), dashboardJs.indexOf('async function confirmGenerateAPIKey'));
    assert.ok(rev.includes('danger: true'));
    assert.ok(rev.includes("method: 'DELETE'") && rev.includes('/api-keys`'));
    assert.ok(rev.includes('dismissNewApiKey();') && rev.includes('await loadAPIKeys();'));
    // the once-panel's buttons are the family now
    const once = dashboardJs.slice(dashboardJs.indexOf('function showNewApiKey'), dashboardJs.indexOf('function copyNewApiKey'));
    assert.ok(once.includes('class="btn-small btn-primary" data-on-click="copyNewApiKey"'));
    assert.ok(once.includes('class="btn-small btn-primary" data-on-click="dismissNewApiKey"'));
    assert.ok(!css.includes('.new-api-key .btn-quiet'), 'the quiet variant is gone');
  });

  test('quick start is a copyable curl with the origin and prefix filled in', () => {
    assert.ok(page.includes('<pre id="apiQuickStart">'));
    assert.ok(page.includes('id="apiQuickStartUrl"') && page.includes('id="apiQuickStartKey"'));
    assert.match(page, /data-on-click="copyQuickStart">\s*<svg[\s\S]*?<\/svg>\s*Copy/);
    assert.ok(dashboardJs.includes("url.textContent = `${window.location.origin}/api/wallets/list`"));
    assert.ok(dashboardJs.includes("copyToClipboard(pre.textContent.replace(/^# .*\\n/, ''))"), 'the comment line is not copied');
    assert.strictEqual((page.match(/<code>Idempotency-Key<\/code>/g) || []).length, 1);
  });

  test('usage is every call, said so, from a route that reads the log the server already keeps', () => {
    assert.ok(page.includes('Usage <em>&middot; every call, key or session</em>'));
    assert.ok(page.includes('id="apiLive"'));
    for (const id of ['apiFactTotal', 'apiFactDay', 'apiFactErrors', 'apiRecentBody']) assert.ok(page.includes(`id="${id}"`), id);
    const usage = dashboardJs.slice(dashboardJs.indexOf('async function loadApiUsage'), dashboardJs.indexOf('let apiPollTimer'));
    assert.ok(usage.includes('/api-calls/recent?limit=20'));
    assert.ok(usage.includes("status >= 500 ? 'failed'"), 'status tones from the one pill');
    assert.ok(usage.includes('escapeHtml(call.endpoint'), 'paths are escaped');
    // polled while the page is open, like the payment links
    assert.match(dashboardJs, /if \(page === 'api'\) \{\s*startApiPolling\(\);\s*\} else \{\s*stopApiPolling\(\);\s*\}/);
    // the route
    assert.ok(routeSource.includes("router.get('/recent'"));
    assert.ok(routeSource.includes("Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100)"), 'limit is clamped');
    assert.ok(routeSource.includes('errors24h: day.filter((call) => Number(call.statusCode) >= 400).length'));
    assert.ok(routeSource.includes('newestFirst: true'), 'newest first, from the index rather than a sort of the whole log');
  });

  test('the call log records the full path, not the router-relative one', () => {
    const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf-8');
    assert.ok(app.includes('endpoint: `${req.baseUrl || \'\'}${req.path}`'), 'every list used to be logged as "/list"');
  });
});

describe('Account: who you are, and the two things that keep it yours', () => {
  const dashboardHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
  const dashboardJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8');
  const page = dashboardHtml.slice(dashboardHtml.indexOf('id="accountPage"'), dashboardHtml.indexOf('<!-- /.dash-shell -->'));

  test('the rail has an Account section, and the page is the last card-free one', () => {
    assert.match(dashboardHtml, /<span class="rail__group">Account<\/span>\s*<a class="nav-link" data-on-click="switchDashboardPage" data-arg="account">/);
    for (const gone of ['class="stat-grid"', 'class="account-head"', 'class="grid-2"', 'btn-outline-link', 'class="card"']) {
      assert.ok(!page.includes(gone), gone);
    }
    assert.match(page, /<h1 class="dash-head__title acct-title" data-reveal data-reveal-delay="60"><span class="acct-avatar" id="accountAvatar">/);
    assert.match(page, /data-on-click="logout">\s*<svg[\s\S]*?<\/svg>\s*Sign out/, 'sign out is the head action');
    // every id loadAccountPage() writes to is still there
    for (const id of ['accountUsername', 'accountSince', 'accountBalance', 'accountBalanceNote', 'accountWallets', 'accountWalletsNote', 'accountPayouts', 'accountApiCalls', 'accountRowName', 'accountRowId', 'accountRowCreated', 'accountRowLogin', 'accountRowType', 'accountSession', 'accountCodes', 'accountCodesCount', 'accountApiState', 'accountApiPrefix', 'accountApiStatus']) {
      assert.ok(page.includes(`id="${id}"`), id);
    }
  });

  test('the session row is read from the token the browser already holds', () => {
    const fn = dashboardJs.slice(dashboardJs.indexOf('function sessionExpiryText'), dashboardJs.indexOf('function copyAccountId'));
    assert.ok(fn.includes("token.split('.')[1]"), 'the JWT payload');
    assert.ok(fn.includes('payload.exp * 1000'));
    assert.ok(!fn.includes('apiFetch'), 'no request');
    assert.ok(dashboardJs.includes("set('accountSession', sessionExpiryText());"));
  });

  test('the password can be changed in place, with the current one, and the pair checked first', () => {
    assert.match(page, /<form class="acct-form hidden" id="changePasswordForm" data-on-submit="changePassword" novalidate>/);
    for (const id of ['currentPassword', 'newPassword', 'newPasswordAgain', 'changePasswordMessage', 'changePasswordBtn']) assert.ok(page.includes(`id="${id}"`), id);
    assert.match(page, /id="newPassword" autocomplete="new-password" minlength="12" maxlength="200" required/);
    const fn = dashboardJs.slice(dashboardJs.indexOf('async function changePassword'), dashboardJs.indexOf('async function regenerateRecoveryCodes'));
    assert.ok(fn.includes("if (next !== again) return fail('The two new passwords do not match.');"));
    assert.ok(fn.includes("if (next.length < 12) return fail("));
    assert.ok(fn.includes('/auth/change-password`'));
    assert.ok(fn.includes('JSON.stringify({ currentPassword: current, newPassword: next })'));
    assert.ok(!fn.includes('localStorage.setItem'), 'nothing about the password is kept in the browser');
    // the route, and the service refusing without the current password
    const auth = fs.readFileSync(path.join(__dirname, '../src/routes/auth.js'), 'utf-8');
    assert.ok(auth.includes("router.post('/change-password', requireAuth, authLimiter,"));
    assert.ok(auth.includes("if (newPassword === currentPassword) {"));
    const service = fs.readFileSync(path.join(__dirname, '../src/services/AuthService.js'), 'utf-8');
    const change = service.slice(service.indexOf('static changePassword'), service.indexOf('static recoveryCodeStatus'));
    assert.ok(change.includes('verifyPassword(currentPassword, user.passwordHash)'));
    assert.ok(change.includes("throw new Error('Current password is incorrect')"));
  });

  test('recovery codes: the count is shown, amber when low, and a new set is shown once', () => {
    assert.match(page, /data-on-click="regenerateRecoveryCodes">\s*<span data-icon="plus"><\/span>\s*New codes/);
    assert.ok(page.includes('<div id="recoveryCodesPanel" class="new-api-key hidden" role="status" aria-live="polite"></div>'));
    const clients = fs.readFileSync(path.join(__dirname, '../src/routes/clients.js'), 'utf-8');
    assert.ok(clients.includes('recoveryCodesRemaining: codes.remaining') && clients.includes('recoveryCodesTotal: codes.total'));
    const count = dashboardJs.slice(dashboardJs.indexOf('function showRecoveryCodeCount'), dashboardJs.indexOf('function togglePasswordForm'));
    assert.ok(count.includes("row.classList.toggle('dot--warn', left <= 3)"));
    const regen = dashboardJs.slice(dashboardJs.indexOf('async function regenerateRecoveryCodes'), dashboardJs.indexOf('function showRecoveryCodes'));
    assert.ok(regen.includes('await confirmDialog({'), 'asks first: the old set stops working');
    assert.ok(regen.includes('/auth/recovery-codes`'));
    const show = dashboardJs.slice(dashboardJs.indexOf('function showRecoveryCodes'), dashboardJs.indexOf('function copyRecoveryCodes'));
    assert.ok(show.includes('cell.textContent = code;'), 'codes are assigned as text, never markup');
    assert.ok(show.includes('data-on-click="copyRecoveryCodes"') && show.includes('data-on-click="dismissRecoveryCodes"'));
    assert.ok(dashboardJs.includes("map((c) => c.textContent).join('\\n')"), 'copied one per line');
    assert.ok(css.includes('\n.acct-codes {') && css.includes('\n.acct-row .dot.dot--warn::before'));
  });

  test('every button on the page is the family; the API row hands off to the API tab', () => {
    const buttons = [...page.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length >= 7, `found ${buttons.length}`);
    for (const b of buttons) assert.match(b, /class="btn-small btn-primary"/, b);
    assert.match(page, /data-on-click="switchDashboardPage" data-arg="api">\s*<svg[\s\S]*?<\/svg>\s*Manage/);
    assert.ok(!page.includes('btn-ghost') && !page.includes('btn-secondary'));
  });
});

describe('Wallets: rows that open, a form in place, an address you can show', () => {
  const dashboardHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
  const dashboardJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8');
  const page = dashboardHtml.slice(dashboardHtml.indexOf('id="walletsPage"'), dashboardHtml.indexOf('<!-- Payouts Page -->'));

  test('add wallet is a form under the head, not a modal, and the overview button lands on it open', () => {
    assert.ok(!dashboardHtml.includes('id="createWalletModal"'), 'the modal is gone');
    assert.match(page, /<div class="wallet-add hidden" id="addWalletPanel">\s*<form id="createWalletForm" novalidate>/);
    assert.ok(page.includes('id="walletChain"') && page.includes('id="walletLabel"'), 'the ids loadChains() and createNewWallet() use');
    assert.match(page, /data-on-click="toggleAddWallet">\s*<span data-icon="plus"><\/span>\s*Add wallet/);
    assert.ok(page.includes('A wallet needs $5 in it before it can be withdrawn from.'), 'the minimum is a sentence, not a boxed info line');
    const open = dashboardJs.slice(dashboardJs.indexOf('function openCreateWalletModal'), dashboardJs.indexOf('function closeCreateWalletModal'));
    assert.ok(open.includes("switchDashboardPage('wallets')") && open.includes('setAddWalletOpen(true)'));
    assert.ok(dashboardJs.includes("document.getElementById('createWalletForm').addEventListener('submit', createNewWallet)"), 'the form still submits through setupEventListeners()');
    const create = dashboardJs.slice(dashboardJs.indexOf('async function createNewWallet'), dashboardJs.indexOf('async function loadAPIKeys'));
    assert.ok(!create.includes('btn.textContent ='), 'the button keeps its glyph while busy');
  });

  test('the row: badge, name, address, balance with fees held in amber, state, and the family\'s icon buttons', () => {
    const fn = dashboardJs.slice(dashboardJs.indexOf('function renderWalletCard('), dashboardJs.indexOf('\n}\n', dashboardJs.indexOf('function renderWalletCard(')));
    assert.ok(fn.includes('<div class="wallet-row" data-wallet-id="${w.id}" data-chain="${escapeHtml(chain)}" data-search="${escapeHtml(searchText)}" role="button" tabindex="0" aria-expanded="false">'));
    assert.ok(fn.includes('held for fees</span>'), 'anything held for fees is said on the balance line');
    assert.ok(fn.includes('class="btn-small btn-primary btn-icon" data-on-click="copyToClipboard"'));
    assert.ok(fn.includes('class="btn-small btn-primary btn-icon" data-on-click="renameWallet"'));
    assert.ok(fn.includes('class="btn-small btn-danger btn-icon" data-on-click="deleteWallet"'), 'delete is the danger colour');
    assert.ok(fn.includes('<div class="wallet-detail hidden" data-wallet-id="${w.id}"></div>'), 'each row has a details slot after it');
    assert.ok(!fn.includes('wallet-item') && !fn.includes('icon-btn'), 'the first-draft row is gone');
    assert.match(css, /\.btn-small\.btn-icon \{ padding: 6px; \}/);
  });

  test('a row opens to the address, its three balances, a QR and the ways on', () => {
    const details = dashboardJs.slice(dashboardJs.indexOf('function renderWalletDetails'), dashboardJs.indexOf('async function loadWalletQr'));
    for (const label of ["'Address'", "'Available'", "'On chain'", "'Held for fees'", "'Made'", "'Explorer'"]) assert.ok(details.includes(`fact(${label}`), label);
    assert.ok(details.includes('yours to withdraw') && details.includes('what the address holds') && details.includes('from earlier withdrawals, awaiting collection'), 'the help page\'s wording');
    assert.ok(details.includes('data-wallet-qr="${w.id}"'));
    assert.ok(details.includes('data-on-click="switchDashboardPage" data-arg="withdrawal"'), 'withdraw from it');
    // the explorer link is derived, never guessed
    const explorer = dashboardJs.slice(dashboardJs.indexOf('function explorerAddressUrl'), dashboardJs.indexOf('function renderWalletCard'));
    assert.ok(explorer.includes("if (!tx || !/\\/tx\\/$/.test(tx)) return null;"));
    // the row opens on click or Enter/Space, but not on its buttons or the rename form
    const wire = dashboardJs.slice(dashboardJs.indexOf('(function wireWalletRows()'), dashboardJs.indexOf('})();', dashboardJs.indexOf('(function wireWalletRows()')));
    assert.ok(wire.includes("target.closest('button, a, input, form, select')"));
    assert.ok(wire.includes("event.key !== 'Enter' && event.key !== ' '"));
    const toggle = dashboardJs.slice(dashboardJs.indexOf('function toggleWalletDetails'), dashboardJs.indexOf('(function wireWalletRows()'));
    assert.ok(toggle.includes('if (opening && !detail.innerHTML)'), 'drawn the first time it opens, then kept');
    assert.ok(toggle.includes('loadWalletQr(walletId)'));
    // the layout holds whether or not the QR is there: the column is never
    // display:none while empty (which squeezed the facts into it), a failed
    // QR drops the column, and the facts are a definition list that wraps
    // sentences as sentences - only the address may break inside a word
    assert.ok(!css.includes('.wallet-detail__qr:empty { display: none; }'));
    assert.match(css, /\.wallet-detail__qr:empty \{ background: var\(--surface-sunken\); \}/);
    assert.match(css, /\.wallet-detail__in\.no-qr \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    assert.match(css, /\.wallet-detail__facts > div \{[^}]*grid-template-columns: 108px minmax\(0, 1fr\);/);
    assert.match(css, /\.wallet-detail__facts > div > b \{[^}]*overflow-wrap: normal;/);
    assert.match(css, /\.wallet-detail__facts \.mono \{[^}]*overflow-wrap: anywhere;/);
    assert.ok(!/\.wallet-detail__facts[^{]*\{[^}]*word-break: break-all/.test(css));
    const drop = dashboardJs.slice(dashboardJs.indexOf('function dropWalletQr'), dashboardJs.indexOf('function toggleWalletDetails'));
    assert.ok(drop.includes("panel.classList.add('no-qr')") && drop.includes('holder.remove()'));
    // the QR route
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/wallets.js'), 'utf-8');
    assert.ok(route.includes("router.get('/:walletId/qr'"));
    assert.ok(route.includes("assertOwnership(db.getById('wallets', req.params.walletId), req, 'Wallet')"), 'only the owner');
    assert.ok(route.includes('QRCode.toString(wallet.address'));
  });

  test('the badge is the chain\'s mark in one colour, with the ticker as the fallback', () => {
    const logos = fs.readFileSync(path.join(PUBLIC_DIR, 'js/common/chain-logos.js'), 'utf-8');
    // The founding ten have drawn marks; a chain added since falls back to
    // its ticker in the badge until someone draws it.
    for (const code of ['ETH', 'POL', 'BASE', 'ARB', 'OP', 'BNB', 'AVAX', 'BTC', 'LTC', 'SOL']) assert.match(logos, new RegExp(`\\n\\s+${code}: svg\\(`), `a mark for ${code}`);
    assert.ok(logos.includes('window.chainLogo = function chainLogo(code, fallback)'));
    assert.ok(!/#[0-9a-f]{3,6}\b/i.test(logos), 'no brand colours - everything is currentColor');
    assert.ok(logos.includes('fill="currentColor"') && logos.includes('stroke="currentColor"'));
    // loaded before the scripts that draw badges, and used by both of them
    assert.ok(dashboardHtml.indexOf('/js/common/chain-logos.js') < dashboardHtml.indexOf('/js/dashboard.js"'));
    const row = dashboardJs.slice(dashboardJs.indexOf('function renderWalletCard('), dashboardJs.indexOf('\n}\n', dashboardJs.indexOf('function renderWalletCard(')));
    assert.ok(row.includes('<span class="wallet-row__badge chain-mark" title="${escapeHtml(PAYOUT_CHAINS[chain]?.name || chain)}">${chainLogo(chain, escapeHtml(symbol))}</span>'));
    const sources = dashboardJs.slice(dashboardJs.indexOf('function displayWalletSelection'), dashboardJs.indexOf('function updateWithdrawTally'));
    assert.ok(sources.includes('chain-mark" title="${escapeHtml(PAYOUT_CHAINS[wallet.chain]?.name || wallet.chain)}">${chainLogo(wallet.chain, escapeHtml(wallet.chain))}'));
    assert.match(css, /\.chain-mark svg \{ width: 20px; height: 20px; display: block; \}/);
  });

  test('chain chips come from the wallets the account has, and filter with the search', () => {
    assert.ok(page.includes('<div class="dash-chips" id="walletChips" role="group" aria-label="Filter by chain"></div>'));
    const chips = dashboardJs.slice(dashboardJs.indexOf('function renderWalletChips'), dashboardJs.indexOf('function setWalletChip'));
    assert.ok(chips.includes('if (chains.length < 2)'), 'no chips for one chain: nothing to choose between');
    assert.ok(chips.includes('data-on-click="setWalletChip" data-arg="${escapeHtml(value)}"'));
    const filter = dashboardJs.slice(dashboardJs.indexOf('function filterWallets'), dashboardJs.indexOf('function loadWalletsList'));
    assert.ok(filter.includes("(!walletChainFilter || item.dataset.chain === walletChainFilter)"));
    assert.ok(filter.includes('`${shown} of ${items.length} wallets`'), 'the count says how many the filter left');
  });
});

describe('Checkout page: details and layout', () => {
  const checkoutJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard-checkout.js'), 'utf-8');
  const dashboardHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8');
  const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/checkout.js'), 'utf-8');

  test('a table cell is never made a flex container', () => {
    // display:flex on a <td> pulls it out of table layout: it stops sharing
    // the row's height and its border no longer meets the neighbouring cells.
    // The links table has no actions cell any more - actions live in the
    // detail row - so the check is simply that no td rule anywhere is flex.
    const rules = css.split('}').map((chunk) => chunk.split('{')).filter((pair) => pair.length === 2);
    const tdRules = rules.filter(([selector]) => /(^|[\s,>+~])td\b/.test(selector.trim()));
    assert.ok(tdRules.length > 0, 'td rules exist');
    for (const [selector, body] of tdRules) {
      assert.ok(!/display:\s*(?:inline-)?flex/.test(body), `flex on a td: ${selector.trim()}`);
    }
    // and the detail's own layout is on a div inside the cell
    assert.ok(checkoutJs.includes('<td colspan="5"><div class="detail__wrap"><div class="detail__in">'));
  });

  test('every row has a details panel with the transaction, amounts and timeline', () => {
    assert.ok(checkoutJs.includes('function renderCheckoutDetails'));
    // the facts, by their labels
    for (const label of ['Requested', 'Received', 'Transaction', 'Customer sends from', 'Receiving wallet', 'On success', 'On failure', 'Webhook']) {
      assert.ok(checkoutJs.includes(`fact('${label}'`), `details should show ${label}`);
    }
    // the timeline, by its steps - created, opened, address, seen, confirming, paid
    for (const step of ['Link created', 'Customer opened it', 'Sending address given', 'Payment seen on chain', 'Confirming', 'Paid']) {
      assert.ok(checkoutJs.includes(step), `timeline step: ${step}`);
    }
    assert.ok(checkoutJs.includes('label: `Underpaid') && checkoutJs.includes('short by'), 'an underpayment is a stop on the timeline, with the shortfall');
    assert.ok(checkoutJs.includes("'Closed by you' : 'Expired unpaid'"), 'an expiry says whether the merchant closed it');
    // the link itself, copyable and openable, in every detail
    assert.match(checkoutJs, /<div class="ck-link">[\s\S]*?data-on-click="copyToClipboard"[\s\S]*?target="_blank" rel="noopener">Open<\/a>/);
  });

  test('transactions link to the chain explorer', () => {
    for (const chain of ['BTC', 'LTC', 'ETH', 'SOL']) {
      assert.ok(checkoutJs.includes(`${chain}: (hash) => \`https://`), `${chain} explorer`);
    }
  });

  test('open panels survive the auto-refresh', () => {
    assert.ok(checkoutJs.includes('const expandedCheckoutSessions = new Set()'));
    assert.ok(checkoutJs.includes('expandedCheckoutSessions.has(session.sessionId)'), 'render must consult the set');
  });

  test('the merchant view exposes the pending hash and last check', () => {
    const fn = routeSource.slice(routeSource.indexOf('function presentForMerchant'), routeSource.indexOf("router.get('/sessions'"));
    assert.ok(fn.includes('pendingTxHash: session.pendingTxHash'));
    assert.ok(fn.includes('lastCheckedAt: session.lastCheckedAt'));
  });

  test('the create form is grouped into sections with a segmented currency control', () => {
    // Three groups - Payment, After payment, Notifications - as small-caps
    // rules over hairlines rather than numbered fieldset legends.
    assert.ok((dashboardHtml.match(/class="fgroup__title"/g) || []).length >= 3);
    assert.ok(dashboardHtml.includes('name="checkoutCurrency"'), 'currency is a radio group');
    assert.ok(!dashboardHtml.includes('id="checkoutCurrency"'), 'the old currency <select> is gone');
    assert.ok(checkoutJs.includes("input[name=\"checkoutCurrency\"]:checked"), 'and the JS reads the radio');
  });

  test('the icon set has the chevron the details toggle uses', () => {
    const icons = fs.readFileSync(path.join(PUBLIC_DIR, 'js/common/icons.js'), 'utf-8');
    assert.ok(icons.includes('\n  chevronDown: () =>'));
  });

  test('the amount is the figure of the page, and the line under it is the conversion itself', () => {
    // 22px tabular, like the balance on the overview; the toggle sits beside it
    assert.match(css, /\.amount-field #checkoutAmount \{[^}]*font-size: 22px;[^}]*font-variant-numeric: tabular-nums;/);
    assert.ok(dashboardHtml.includes('id="checkoutAmountHint"'));
    assert.ok(dashboardHtml.includes('id="checkoutQuoteAge" hidden'), 'the price age is there but hidden until a rate arrives');
    assert.match(dashboardHtml, /id="checkoutAmount"[^>]*data-on-input="drawCheckoutQuote"/, 'redrawn on every keystroke');
    assert.strictEqual((dashboardHtml.match(/name="checkoutCurrency"[^>]*data-on-change="syncCheckoutCurrencyLabel"/g) || []).length, 2, 'and on the toggle');

    const draw = checkoutJs.slice(checkoutJs.indexOf('function drawCheckoutQuote'), checkoutJs.indexOf('function startCheckoutQuote'));
    assert.ok(draw.includes('(amount / quote.usdRate).toFixed(8)'), 'USD in: the coin figure, rounded as the server rounds it');
    assert.ok(draw.includes('(amount * quote.usdRate).toFixed(6)'), 'coin in: the USD figure, likewise');
    assert.ok(draw.includes('\\u2248 <b>'), 'marked as approximate');
    assert.ok(draw.includes("`Quoted in ${symbol} at today's rate"), 'prose until the rate has loaded');
    assert.ok(draw.includes("quote__age--stale', !quote.fresh"), 'a stale feed is said so');

    // fetched per chain, refreshed while the form is open, stopped on leaving it
    assert.ok(checkoutJs.includes('/checkout/quote?chain=${encodeURIComponent(chain)}'));
    const start = checkoutJs.slice(checkoutJs.indexOf('function startCheckoutQuote'), checkoutJs.indexOf('function stopCheckoutQuote'));
    assert.ok(start.includes('tick % 30 === 0) loadCheckoutQuote()'), 'a new rate every 30 s');
    assert.ok(start.includes("document.visibilityState !== 'visible'"), 'but not in a background tab');
    const load = checkoutJs.slice(checkoutJs.indexOf('async function loadCreateLinkPage'), checkoutJs.indexOf('let checkoutQuote'));
    assert.ok(load.includes('startCheckoutQuote();'));
    const dashboardJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
    assert.ok(dashboardJs.includes("if (page !== 'createLink') stopCheckoutQuote();"));

    // the wallet picker syncs as soon as it is filled, and the sync re-quotes
    const wallets = checkoutJs.slice(checkoutJs.indexOf('async function loadCheckoutWallets'), checkoutJs.indexOf('async function loadCheckoutSessions'));
    assert.ok(wallets.includes('syncCheckoutCurrencyLabel();'));
    const sync = checkoutJs.slice(checkoutJs.indexOf('function syncCheckoutCurrencyLabel'), checkoutJs.indexOf('async function loadCheckoutWallets'));
    assert.ok(sync.includes('drawCheckoutQuote();') && sync.includes('loadCheckoutQuote();'));
  });

  test('the two redirects share a line, and labels inside the form read as prose', () => {
    const page = dashboardHtml.slice(dashboardHtml.indexOf('id="createLinkPage"'), dashboardHtml.indexOf('id="checkoutPage"'));
    const row = page.slice(page.indexOf('<div class="fgroup__row">'), page.indexOf('</div>\n', page.indexOf('id="checkoutFailure"')));
    assert.ok(row.includes('id="checkoutSuccess"') && row.includes('id="checkoutFailure"'), 'success and failure sit in one row');
    assert.match(css, /\.fgroup__row \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /\.fgroup__row \{ grid-template-columns: 1fr;/, 'and stack on a phone');
    // the old label rule uppercases everything; the form's labels opt out
    assert.match(css, /\.field label \{[^}]*text-transform: none/);
  });

  test('the ready panel leads with the coin, shows the rate it was fixed at, and the link is the one filled button', () => {
    // amountRows draws the Amount and Rate rows for it (three ways to pay on a chain with dollar tokens)
    const fn = checkoutJs.slice(checkoutJs.indexOf('function amountRows'), checkoutJs.indexOf('async function loadLinkQr'));
    assert.ok(fn.includes('data.usdRate > 0 ? Number(data.usdRate)'), 'the rate is the one the server fixed the link at');
    assert.ok(fn.includes('Number(data.usdAmount) / Number(data.nativeAmount)'), 'with the ratio of the two amounts as a fallback');
    assert.ok(fn.includes('<span>Rate</span>'));
    assert.ok(fn.includes('fixed at creation'));
    assert.ok(fn.includes('<span>Pays into</span>'), 'the wallet, as the picker named it');
    assert.ok(fn.includes('#checkoutWallet option[value='), 'looked up by the id that was submitted');
    assert.ok(fn.includes('Redirect to ${esc(host(data.successRoute'));
    assert.ok(fn.includes('Expires in <b id="linkReadyCountdown">'), 'the countdown leads the subline');
    assert.match(fn, /class="btn-small btn-primary" href="\$\{esc\(url\)\}" target="_blank" rel="noopener">Open link<\/a>/);
    assert.ok(!fn.includes('Open in new tab'));
    assert.strictEqual((fn.match(/btn-primary/g) || []).length, 2, 'copy and open are the filled ones; the rest are ghosts');
  });
});

describe('Head buttons are siblings', () => {
  const dashboardHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8');

  test('the ghost borrows nothing but its colours; size comes from .btn-small', () => {
    // .btn-ghost once set its own padding, radius and weight, so "Withdraw"
    // sat 13px shorter than "Add wallet" beside it.
    const ghosts = [...css.matchAll(/\n\.btn-ghost \{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(ghosts.length >= 1);
    for (const body of ghosts) {
      for (const prop of ['padding', 'border-radius', 'font-size', 'font-weight']) {
        assert.ok(!body.includes(prop + ':'), `.btn-ghost sets ${prop}`);
      }
    }
    const small = css.slice(css.indexOf('\n.btn-small {'), css.indexOf('}', css.indexOf('\n.btn-small {')));
    for (const decl of ['display: inline-flex', 'padding: 6px 12px', 'border: 1px solid transparent', 'border-radius: 6px', 'font-weight: 600', 'text-decoration: none']) {
      assert.ok(small.includes(decl), `.btn-small has ${decl}`);
    }
    // an icon inside is sized, so it cannot stretch the button - whether it
    // is a data-icon span or a rail glyph pasted in as a bare <svg>
    assert.match(css, /\.btn-small \[data-icon\], \.btn-small \[data-icon\] svg, \.btn-small > svg \{ width: 14px; height: 14px;/);
  });

  test('every head action is the same button as Add wallet: filled, with a glyph', () => {
    const heads = [...dashboardHtml.matchAll(/<div class="dash-head__actions"[^>]*>([\s\S]*?)<\/header>/g)].map((m) => m[1]);
    const find = (text) => heads.find((h) => h.includes(text));
    const filled = (glyph, label) => new RegExp(`class="btn-small btn-primary"[^>]*>\\s*${glyph}\\s*${label}\\s*<`);
    const plus = '<span data-icon="plus"></span>';
    const svg = '<svg viewBox="0 0 24 24"[^>]*>[\\s\\S]*?</svg>';
    // it makes something: a plus
    assert.match(find('Add wallet'), filled(plus, 'Add wallet'));
    assert.match(find('New payout'), filled(plus, 'New payout'));
    assert.match(find('data-arg="createLink"'), filled(plus, 'New link'));
    // it goes somewhere: the destination's own rail glyph
    assert.match(find('data-arg="withdrawal">'), filled(svg, 'Withdraw'));
    assert.match(find('data-arg="checkout"'), filled(svg, 'All links'));
    // no head action is a ghost any more
    for (const head of heads) assert.ok(!head.includes('btn-ghost'), 'a ghost in a page head');
  });
});

describe('Dashboard pages enter from the left', () => {
  const dashboardHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
  const dashboardJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8');

  test('every page head is marked, staggered the same way', () => {
    // eyebrow first, then the actions, the title, the lede
    assert.strictEqual((dashboardHtml.match(/<span class="dash-head__eyebrow" data-reveal>/g) || []).length, 9);
    // the account's title carries the avatar, so its class list is longer
    assert.strictEqual((dashboardHtml.match(/<h1 class="dash-head__title(?: acct-title)?" data-reveal data-reveal-delay="60">/g) || []).length, 8);
    // eight: the overview's lede is the balance meta, counted below
    assert.strictEqual((dashboardHtml.match(/class="dash-head__lede"[^>]*data-reveal data-reveal-delay="120"/g) || []).length, 8);
    // seven with buttons; the withdrawal's action slot holds a figure instead
    assert.strictEqual((dashboardHtml.match(/<div class="dash-head__actions" data-reveal data-reveal-delay="100">/g) || []).length, 7);
    assert.strictEqual((dashboardHtml.match(/<div class="dash-head__actions wd-avail" data-reveal data-reveal-delay="100">/g) || []).length, 1);
    // the overview's title is the balance
    assert.ok(dashboardHtml.includes('<div class="dash-balance" id="totalBalanceUSD" data-reveal data-reveal-delay="60">'));
    assert.ok(dashboardHtml.includes('<div class="dash-balance__meta" data-reveal data-reveal-delay="120">'));
  });

  test('the New payment link form follows its head in, group by group', () => {
    const page = dashboardHtml.slice(dashboardHtml.indexOf('id="createLinkPage"'), dashboardHtml.indexOf('id="checkoutPage"'));
    const delays = [...page.matchAll(/<div class="fgroup" data-reveal data-reveal-delay="(\d+)">/g)].map((m) => Number(m[1]));
    assert.deepStrictEqual(delays, [180, 240, 300]);
    assert.ok(page.includes('<div class="link-form__foot" data-reveal data-reveal-delay="360">'));
    // and the link, once made, lands the same way
    assert.match(css, /\.link-ready:not\(\.hidden\) \{ animation: page-enter var\(--dur-slow\) var\(--ease-out\) both; \}/);
    assert.match(css, /@keyframes page-enter \{ from \{ opacity: 0; transform: translateX\(-18px\); \}/);
  });

  test('the switcher runs the entrance, since a hidden page never scrolls into view', () => {
    const fn = dashboardJs.slice(dashboardJs.indexOf('function enterDashboardPage'), dashboardJs.indexOf('function switchDashboardPage'));
    assert.ok(fn.includes("node.classList.remove('is-revealed')"), 'reset before showing');
    assert.ok(fn.indexOf("classList.remove('is-revealed')") < fn.indexOf("pageEl.style.display = 'block'"), 'while still hidden, so nothing fades out');
    assert.ok(fn.includes('void pageEl.offsetWidth;'), 'the hidden state is committed as the starting frame');
    assert.ok(fn.includes('requestAnimationFrame'));
    assert.ok(fn.includes("matchMedia('(prefers-reduced-motion: reduce)')"), 'reduced motion shows everything at once');
    assert.ok(fn.includes("`${delay}ms`"), 'the stagger is the same --reveal-delay tokens.css transitions on');
    // a page opens at its top: the document's scroll would otherwise carry
    // over from wherever you were on the last page
    // (scrollPageTop resets the main column too: on a phone that is the scroller)
    assert.ok(fn.includes('scrollPageTop();'));
    assert.ok(fn.indexOf("pageEl.style.display = 'block'") < fn.indexOf('scrollPageTop();'), 'once the page is showing');
    const switcher = dashboardJs.slice(dashboardJs.indexOf('function switchDashboardPage'), dashboardJs.indexOf('const loaders = {'));
    assert.ok(switcher.includes('enterDashboardPage(pageEl);'));
    assert.ok(!switcher.includes("pageEl.style.display = 'block'"), 'the switcher no longer shows the page itself');
    // the overview is shown by the markup and gets the entrance on boot, with
    // the failsafe reveal.js also has
    assert.ok(dashboardJs.includes("enterDashboardPage(document.getElementById('overviewPage'));"));
    assert.ok(dashboardJs.includes(".dashboard-page [data-reveal]:not(.is-revealed)"));
    // reveal.js itself is not loaded here: it would mark everything on
    // hidden pages revealed at load and nothing would ever animate
    assert.ok(!dashboardHtml.includes('/js/common/reveal.js'));
  });
});

describe('Dropdowns follow the theme', () => {
  const tokens = fs.readFileSync(path.join(PUBLIC_DIR, 'css/tokens.css'), 'utf-8');

  test('one global select rule paints the control from tokens', () => {
    const rule = tokens.slice(tokens.indexOf('\nselect {'), tokens.indexOf('select:hover {'));
    assert.match(rule, /appearance:\s*none/);
    assert.match(rule, /background-color:\s*var\(--surface\)/);
    assert.match(rule, /background-image:\s*var\(--select-chevron\)/);
    assert.match(rule, /color:\s*var\(--ink\)/);
  });

  test('the chevron colour is defined per theme', () => {
    assert.ok((tokens.match(/--select-chevron:/g) || []).length >= 3, 'light, system-dark and forced-dark');
  });

  test('no page-level rule sets a background shorthand on select that would wipe the chevron', () => {
    for (const file of ['dashboard.css', 'api-reference.css', 'checkout.css', 'auth.css']) {
      const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', file), 'utf-8');
      // Rules whose selector targets a <select> element (not .selected etc.).
      const rules = css.match(/[^}]*select[^{]*\{[^}]*\}/g) || [];
      for (const rule of rules) {
        const selector = rule.slice(0, rule.indexOf('{'));
        if (!/(^|[\s,>+~])select/.test(selector)) continue;
        assert.ok(!/\n\s*background:\s/.test(rule), `${file}: use background-color, not the shorthand, in ${rule.trim().slice(0, 40)}`);
      }
    }
  });
});

describe('Checkout page: logo and confirmation blocks', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'checkout.html'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/checkout.css'), 'utf-8');
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js/checkout.js'), 'utf-8');

  test('the header shows the shared brand mark, not a stand-in', () => {
    // The page used to draw its own hexagon with a hardcoded white fill -
    // invisible on the near-white tile in dark mode - instead of loading the
    // icon set every other page uses.
    assert.ok(html.includes('/js/common/icons.js'), 'icons.js must be loaded');
    // logoOutline, the same mark the navbar draws — the app header and the
    // marketing header should not show different logos.
    assert.ok(html.includes('class="logo-mini" data-icon="logoOutline"'));
    assert.ok(!/fill="white"/.test(html));
  });

  test('confirmations are drawn as one tile per required block', () => {
    assert.ok(html.includes('id="verify-blocks"'));
    assert.ok(js.includes('function renderBlockChain'));
    assert.ok(js.includes("holder.classList.toggle('block-chain--dense', shown > 8)"), 'many confirmations get small tiles');
    assert.ok(js.includes('block--next'), 'the block being mined is marked');
    assert.ok(js.includes('block--settled'), 'already-landed tiles do not replay their animation');
  });

  test('the block animations are gated on the motion preference', () => {
    const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
    for (const name of ['block-land', 'block-breathe', 'block-ring', 'link-grow']) {
      assert.ok(motion.includes(`@keyframes ${name}`), `${name} must live inside the no-preference block`);
    }
  });

  test('the amount is the page: no card, a three-step rail, the family\'s buttons', () => {
    assert.ok(!html.includes('checkout-card') && !html.includes('payment-summary'), 'the boxed card and its summary table are gone');
    assert.match(html, /<span id="amount-value" class="amount__value">/);
    assert.match(html, /<span class="pay-head__mark chain-mark" id="chain-mark"/);
    assert.ok(html.includes('/js/common/chain-logos.js'), 'the chain marks are the shared set');
    assert.ok(js.includes("mark.innerHTML = window.chainLogo(sessionData.chain, '')"));
    const rail = [...html.matchAll(/<li[^>]*data-rail="(\d)"><span>Step \d<\/span><b>([^<]+)<\/b><\/li>/g)].map((m) => m[2]);
    assert.deepStrictEqual(rail, ['Your address', 'Send', 'Confirmed']);
    assert.ok(js.includes('function markRail(stepId)') && js.includes('markRail(stepId);'), 'the rail follows showStep');
    // every button is the filled family with a glyph, and JS writes the
    // words into .btn__label so the glyph survives a state change
    const buttons = [...html.matchAll(/<(?:button|a)[^>]*class="btn-small[^"]*"[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length >= 8, `found ${buttons.length}`);
    for (const b of buttons) assert.match(b, /btn-primary/, b);
    for (const id of ['wallet-connect-btn', 'submit-address-btn', 'wallet-pay-btn', 'success-redirect-btn', 'failure-redirect-btn-insuf', 'failure-redirect-btn-exp']) {
      const start = html.indexOf(`id="${id}"`);
      assert.ok(html.slice(start, html.indexOf('</', start) + 400).includes('class="btn__label"'), `${id} has a label span`);
    }
    assert.ok(js.includes('function setLabel(button, text)') && !/btn\.textContent = /.test(js), 'checkout.js never writes a button\'s textContent');
    const wallet = fs.readFileSync(path.join(PUBLIC_DIR, 'js/checkout-wallet.js'), 'utf-8');
    assert.ok(!/button\.textContent = ['`]/.test(wallet), 'nor does checkout-wallet.js');
  });

  test('the clock drains under the amount and goes with the countdown row', () => {
    assert.match(html, /<div class="pay-head__clock" id="countdown-track"[^>]*><i id="countdown-bar"><\/i><\/div>/);
    assert.ok(js.includes("const TWINS = { 'countdown-row': 'countdown-track' };"));
    const countdown = js.slice(js.indexOf('function startCountdown'), js.indexOf('function stopCountdown'));
    assert.ok(countdown.includes("getElementById('countdown-bar')") && countdown.includes('sessionData.createdAt'), 'its full length is the session\'s whole life');
  });

  test('the receiving address is still withheld until the customer has given theirs', () => {
    // the To row lives in the send step and starts hidden; only revealSendToAddress() shows it
    assert.match(html, /<div id="send-to-row" class="hidden">\s*<span>To<\/span>\s*<b class="mono" id="wallet-address">/);
    assert.ok(js.includes("if (sessionData.hasClientAddress && sessionData.walletAddress) {"));
    for (const id of ['manual-address-section', 'wallet-required-note', 'wallet-note-address', 'wallet-note-pay', 'qr-code', 'verify-blocks', 'verify-bar', 'tx-hash-display', 'received-amount', 'required-amount']) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
  });
});

describe('Home page: hover contrast and motion', () => {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/index.css'), 'utf-8');
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js/index.js'), 'utf-8');

  test('buttons no longer grow a surface-coloured disc over their label on hover', () => {
    assert.ok(!/\.btn::before\s*\{/.test(css), 'the ripple pseudo-element is gone');
    assert.ok(!/\.btn:hover::before/.test(css));
  });

  test('every hover state restates its text colour against its background', () => {
    for (const selector of ['.btn-primary:hover', '.btn-secondary:hover']) {
      const start = css.indexOf(`${selector} {`);
      assert.ok(start !== -1, selector);
      const body = css.slice(start, css.indexOf('}', start));
      assert.match(body, /background:\s*var\(--ink(?:-hover)?\)/, `${selector} background`);
      assert.match(body, /color:\s*var\(--surface\)/, `${selector} colour`);
    }
  });

  test('the nav underline is not drawn under the button-styled links', () => {
    // This lives in navbar.js now, with the rest of the header: index.css no
    // longer styles the nav at all.
    const navbarJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/common/navbar.js'), 'utf-8');
    assert.ok(navbarJs.includes('#navLinksMenu .nav-link.login-btn::after,#navLinksMenu .nav-link.signup-btn::after{display:none;}'));
  });

  test('the hero has an animated backdrop and a typewriter kicker', () => {
    assert.ok(html.includes('class="hero-bg"'));
    assert.strictEqual((html.match(/class="hero-orb /g) || []).length, 3);
    assert.ok(html.includes('id="heroTyped"') && html.includes('data-phrases='));
    assert.ok(html.includes('class="typed-cursor"'));
    assert.ok(js.includes("getElementById('heroTyped')"));
    assert.ok(js.includes('prefers-reduced-motion: reduce'), 'the typewriter respects reduced motion');
  });

  test('the backdrop motion is gated on the motion preference', () => {
    const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
    for (const name of ['grid-slide', 'orb-drift-1', 'orb-drift-2', 'orb-drift-3', 'cursor-blink']) {
      assert.ok(motion.includes(`@keyframes ${name}`), name);
    }
  });
});

describe('Checkout page: expiry never overrides money that arrived', () => {
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js/checkout.js'), 'utf-8');

  test('the countdown only runs while a payment can still arrive', () => {
    const render = js.slice(js.indexOf('function renderCheckout'), js.indexOf('window.submitWalletAddress'));
    assert.ok(render.includes("['PENDING', 'AWAITING_PAYMENT', 'VERIFYING'].includes(sessionData.status)"));
    assert.ok(render.indexOf('includes(sessionData.status)') < render.indexOf('startCountdown('), 'the check gates the start');
  });

  test('the clock reaching zero asks the server instead of declaring expiry itself', () => {
    const countdown = js.slice(js.indexOf('function startCountdown'), js.indexOf('function stopCountdown'));
    assert.ok(!countdown.includes('handleExpired('), 'only a server EXPIRED status may show the expired screen');
    assert.ok(countdown.includes('pollStatus()'));
    assert.ok(!countdown.includes('stopPolling()'), 'polling must continue until the server answers');
  });

  test('paid, underpaid and expired screens all stop and hide the clock', () => {
    for (const fn of ['function handlePaid', 'function handleInsufficient', 'function handleExpired']) {
      const body = js.slice(js.indexOf(fn), js.indexOf('showStep(', js.indexOf(fn)));
      assert.ok(body.includes("hide('countdown-row')"), `${fn} hides the clock`);
    }
  });
});

describe('Checkout page: a reload shows the live state', () => {
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js/checkout.js'), 'utf-8');
  const render = js.slice(js.indexOf('function renderCheckout'), js.indexOf('window.submitWalletAddress'));

  test('every settled or in-progress state hydrates from the status endpoint on load', () => {
    // The session endpoint only says which screen; the details - amount that
    // arrived, transaction hash, confirmations, redirect - live on /status.
    // Rendering terminal screens from placeholders left a reloaded paid page
    // with no amount and no transaction.
    assert.ok(!render.includes('paidAmount: null'), 'no placeholder data on the paid screen');
    assert.ok(render.includes("case 'PAID':\n      case 'INSUFFICIENT':\n      case 'EXPIRED':".replace(/\n/g, '\r\n')) || render.includes("case 'PAID':\n      case 'INSUFFICIENT':\n      case 'EXPIRED':"), 'terminal states share the hydration path');
    assert.strictEqual((render.match(/pollStatus\(\{ initial: true \}\)/g) || []).length, 2, 'watching/verifying and terminal branches both hydrate');
  });

  test('a reloaded paid page does not redirect the customer again', () => {
    const paid = js.slice(js.indexOf('function handlePaid'), js.indexOf('function handleInsufficient'));
    assert.ok(paid.includes('autoRedirect = true'));
    assert.ok(paid.includes('if (autoRedirect) setTimeout('));
    const poll = js.slice(js.indexOf('async function pollStatus'), js.indexOf('const DEFAULT_WATCH_HINT'));
    assert.ok(poll.includes('handlePaid(data, { autoRedirect: !initial })'));
  });
});

describe('Landing page: the wordmark hero', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/index.css'), 'utf-8');
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js/index.js'), 'utf-8');

  test('the word is the heading, one span per letter, readable as a whole by assistive tech', () => {
    assert.ok(html.includes('<h1 class="wordmark" id="wordmark" aria-label="Etheroute">'));
    assert.strictEqual((html.match(/class="letter" style="--i:\d"/g) || []).length, 9, 'E-T-H-E-R-O-U-T-E');
    assert.ok(html.includes('class="wordmark__letters" aria-hidden="true"'), 'the letters are hidden from screen readers; the label carries the word');
  });

  test('the wordmark outranks the old headline size rule', () => {
    // `.hero h1` set 48px; a bare `.wordmark` rule lost to it and the word
    // rendered at headline size, inline beside the kicker.
    assert.ok(css.includes('.hero h1.wordmark {'));
    assert.match(css.slice(css.indexOf('.hero h1.wordmark {')), /display:\s*block/);
  });

  test('the route network canvas is drawn with theme colours and stops when unseen', () => {
    assert.ok(html.includes('<canvas id="routeCanvas" class="hero-canvas"></canvas>'));
    assert.ok(js.includes("getPropertyValue('--ink')") || js.includes("v('--ink')"), 'colours come from tokens');
    assert.ok(js.includes("window.addEventListener('themechange', readColors)"), 'and follow a theme switch');
    assert.ok(js.includes("document.addEventListener('visibilitychange'"), 'paused in a background tab');
    assert.ok(js.includes('IntersectionObserver'), 'paused once scrolled away');
    assert.ok(js.includes("getComputedStyle(canvas).display === 'none'"), 'not started where the stylesheet hides it');
  });

  test('reduced motion gets a still scene and filled letters', () => {
    assert.ok(js.includes('if (reduceMotion) {'), 'the canvas loop checks the preference');
    // The letter animation, sheen and scroll cue all live in the
    // no-preference block; outside it the letters are simply --ink.
    const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
    for (const name of ['letter-in', 'shine-sweep', 'chev-dip']) {
      assert.ok(motion.includes(`@keyframes ${name}`), name);
    }
    const base = css.slice(css.indexOf('.hero h1.wordmark {'), css.indexOf('.wordmark__shine {'));
    assert.match(base, /\.wordmark \.letter \{[^}]*color:\s*var\(--ink\)/);
  });

  test('the network is hidden on narrow screens where nodes would land on the copy', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 768px)'), css.indexOf('@media (max-width: 1024px)'));
    assert.match(narrow, /\.hero-canvas \{\s*display:\s*none;/);
  });
});

describe('navbar.js owns the header', () => {
  /**
   * The header markup is injected by navbar.js on every page that loads it, but
   * nine stylesheets still carried the header CSS from before that was true.
   * Dead weight at best — and on docs/help it actively fought the injected
   * rules. The per-page copies are gone; these stop them coming back.
   *
   * checkout.html and dashboard.html are the exception: they have their own
   * .header markup and never load navbar.js, so their stylesheets keep theirs.
   */
  const CSS_DIR = path.join(PUBLIC_DIR, 'css');
  const OWN_HEADER = new Set(['checkout.css', 'dashboard.css']);
  const navbarJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/common/navbar.js'), 'utf-8');

  const pagesWithSharedNav = fs.readdirSync(PUBLIC_DIR)
    .filter((file) => file.endsWith('.html'))
    .filter((file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf-8').includes('/js/common/navbar.js'));

  test('every page but checkout and dashboard uses the shared navbar', () => {
    assert.ok(pagesWithSharedNav.length >= 10, `only ${pagesWithSharedNav.length} pages load navbar.js`);
    for (const file of ['checkout.html', 'dashboard.html']) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf-8');
      assert.ok(!html.includes('/js/common/navbar.js'), `${file} styles its own header`);
    }
  });

  test('no page stylesheet redeclares the classes navbar.js injects', () => {
    // A stale `.nav-link.signup-btn { display: inline-block }` in docs.css is
    // what made the Dashboard button render its label against the top of the
    // button on the docs and help pages.
    const owned = /^\s*(\.header|\.header-left|\.logo-mini|\.brand|\.auth-buttons|\.nav-links?)\b[^{]*\{/m;
    for (const file of fs.readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'))) {
      if (OWN_HEADER.has(file)) continue;
      const css = fs.readFileSync(path.join(CSS_DIR, file), 'utf-8');
      const match = css.match(owned);
      assert.strictEqual(match, null, `${file} redeclares ${match && match[0].trim()}`);
    }
  });

  test('no page script sets the nav auth state with an inline style', () => {
    // navbar.js toggles .authed on #navLinksMenu and the CSS shows exactly one
    // cluster. A page doing it again with element.style.display wins the
    // cascade outright and strips the button of its flex centring.
    const JS_DIR = path.join(PUBLIC_DIR, 'js');
    for (const file of fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'))) {
      const js = fs.readFileSync(path.join(JS_DIR, file), 'utf-8');
      assert.ok(
        !/(dashboardBtn|authButtons)\s*\.style\.display/.test(js),
        `js/${file} sets the nav auth state itself; navbar.js already does`,
      );
    }
  });

  test('the header keeps a fixed height so pinned bars sit flush beneath it', () => {
    // docs and api-reference pin their "Contents" bar at top:59px.
    const height = /\.site-header\{height:(\d+)px;/.exec(navbarJs)[1];
    for (const file of ['docs.css', 'api-reference.css']) {
      const css = fs.readFileSync(path.join(CSS_DIR, file), 'utf-8');
      assert.match(css, new RegExp(`top:\\s*${Number(height) - 1}px`),
        `${file} pins its Contents bar under a ${height}px header`);
    }
  });

  test('the hamburger morph is transform-only, so it animates back the same way', () => {
    // The open state used to flip left/right and width, none of which were in
    // the transition list, so the bars jumped sideways while they rotated.
    const open = navbarJs.match(/\.nav-toggle\.open \.nav-toggle__bars i[^}]*\}/g) || [];
    assert.ok(open.length >= 3, 'expected a rule per bar');
    for (const rule of open) {
      assert.ok(!/(^|[;{])\s*(left|right|width|top)\s*:/.test(rule), `not animatable in both directions: ${rule}`);
    }
    assert.match(navbarJs, /transition:transform \.3s[^;]*,opacity/, 'only transform and opacity transition');
  });

  test('the theme toggle and hamburger sit at the end of the bar on mobile', () => {
    // .site-nav leaves the flow below 900px, so without this the cluster sits
    // a few pixels after the wordmark instead of hard right.
    const mobile = navbarJs.slice(navbarJs.indexOf('@media(max-width:900px)'));
    assert.match(mobile, /\.header-actions\{margin-left:auto;\}/);
  });

  test('in the phone sheet a sub-item title centres on its icon', () => {
    // The description is hidden there, and the title - a 16px line in a
    // 30px column - sat on the icon's top edge with nothing beneath it.
    const sheet = navbarJs.slice(navbarJs.indexOf('@media(max-width:900px)'));
    assert.ok(sheet.includes('.nav-drop{padding:11px 20px;border-radius:0;gap:12px;align-items:center;}'));
    assert.ok(sheet.includes('.nav-drop__txt{justify-content:center;}'));
    assert.ok(sheet.includes('.nav-drop__desc{display:none;}'), 'the description is still the thing that goes');
  });

  test('on a desktop a clicked group does not stay open once the pointer leaves', () => {
    // Focus keeps a panel open for the keyboard (:focus-within), and a mouse
    // click focuses the button too - so a clicked Developers stayed up, and
    // hovering Company put two panels on screen. A pointer click now drops
    // its focus; a keyboard activation (detail 0) keeps it.
    assert.ok(navbarJs.includes('.nav-group:hover .nav-menu,.nav-group:focus-within .nav-menu{opacity:1;'), 'hover and keyboard focus open a panel');
    const handler = navbarJs.slice(navbarJs.indexOf("menu?.querySelectorAll('.nav-group').forEach"), navbarJs.indexOf('// Exactly one of the auth buttons'));
    assert.ok(handler.includes('} else if (e.detail > 0) {'), 'pointer clicks only');
    assert.ok(handler.includes('trigger.blur();'));
    assert.ok(!handler.includes("classList.toggle('nav-group--open')") || handler.indexOf("matchMedia('(max-width:900px)')") < handler.indexOf("classList.toggle('nav-group--open')"), 'the accordion toggle stays a phone thing');
  });
});

describe('Status page fits the rest of the site', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'status.html'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/status.css'), 'utf-8');
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js/status.js'), 'utf-8');

  test('it opens with the shared hero and closes with the site footer', () => {
    // It used to do neither: a rounded card where the banner belongs, and the
    // page simply stopped at the last panel.
    assert.match(html, /<div class="hero">/, 'the shared landing banner from tokens.css');
    assert.ok(html.includes('<h1 id="heroTitle">'));
    assert.ok(html.includes('class="footer"'), 'and the footer every other page ends with');
    assert.ok(html.includes('class="footer-link"'));
  });

  test('it uses the site\'s buttons and radii, not its own', () => {
    assert.ok(!/class="primary-btn"|class="secondary-btn"/.test(html), 'no bespoke button classes');
    assert.ok(html.includes('class="btn btn-primary"') && html.includes('class="btn btn-secondary"'));
    // 22px/18px radii were what made this read as a different product.
    const literalRadii = css.match(/border-radius:\s*(\d+)px/g) || [];
    for (const radius of literalRadii) {
      const px = Number(radius.match(/\d+/)[0]);
      assert.ok(px <= 12, `${radius} is off the site's 4/8/12 scale — use a --radius token`);
    }
  });

  test('service health is a row of day ticks, not a grid of nested cards', () => {
    assert.ok(html.includes('id="serviceRows"'));
    assert.ok(!html.includes('id="serviceGrid"'));
    assert.ok(js.includes('function renderUptimeBar'));
    assert.match(css, /\.uptime-bar \{/);
    for (const tone of ['partial', 'down', 'unknown']) {
      assert.match(css, new RegExp(`\.tick--${tone}`), `missing a ${tone} tick`);
    }
  });

  test('operator text is escaped everywhere it reaches the page', () => {
    // Incident titles and messages are operator-supplied; two of these were
    // being interpolated raw.
    const renders = js.slice(js.indexOf('function renderUptimeBar'));
    for (const field of ['incident.label', 'incident.title', 'activeIncident.title', 'activeIncident.message']) {
      const raw = new RegExp(`\$\{${field.replace('.', '\.')}\}`);
      assert.ok(!raw.test(renders), `${field} is interpolated without escaping`);
    }
  });
});

describe('The logo follows the theme', () => {
  /**
   * The mark it replaces was an SVGRepo export: hardcoded #0F0F0F and #e9eced
   * fills, wrapped in three duplicate copies of its own paths. Hardcoded fills
   * are why it could not invert — it sits on an inked tile in the navbar and
   * bare on the page in the footer, and those need opposite colours.
   */
  const icons = fs.readFileSync(path.join(PUBLIC_DIR, 'js/common/icons.js'), 'utf-8');
  const favicon = fs.readFileSync(path.join(PUBLIC_DIR, 'svg/favicon.svg'), 'utf-8');
  const navbarJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/common/navbar.js'), 'utf-8');

  /** The body of one icon entry, from its name to the closing backtick. */
  function iconSource(name) {
    const start = icons.indexOf(`\n  ${name}: () =>`);
    if (start === -1) return null;
    const open = icons.indexOf('`', start);
    return icons.slice(open + 1, icons.indexOf('`,', open));
  }

  test('both marks exist and neither hardcodes a colour', () => {
    for (const name of ['logo', 'logoSmall']) {
      const svg = iconSource(name);
      assert.ok(svg, `${name} is missing`);
      const hex = svg.match(/(?:fill|stroke)="#[0-9a-f]{3,8}"/gi) || [];
      // The mask's own black/white are not paint — they are the mask channel.
      const paint = hex.filter((h) => !/#fff\b|#ffffff|#000\b|#000000/i.test(h));
      assert.deepStrictEqual(paint, [], `${name} hardcodes ${paint.join(', ')}`);
      assert.ok(svg.includes('currentColor'), `${name} should paint with currentColor`);
    }
  });

  test('the old SVGRepo export is gone, with its duplicate paths', () => {
    const svg = iconSource('logo');
    assert.ok(!svg.includes('SVGRepo'), 'wrapper groups still present');
    assert.ok(!svg.includes('#0F0F0F') && !svg.includes('#e9eced'));
  });

  test('nothing carries both a mask and a transform', () => {
    // A mask resolves in the user space the element's own transform
    // establishes, so putting the placement transform on the masked element
    // applies it to the hole a second time. Nothing errors, nothing warns — the
    // hollow letter just renders offset from the shape it is cut out of, thick
    // on one side and pinched on the other. The transform belongs on a child.
    for (const name of ['logo', 'logoOutline']) {
      const svg = iconSource(name);
      const masked = svg.match(/<g[^>]*mask="url\(#[^"]+\)"[^>]*>/g) || [];
      assert.ok(masked.length, `${name} should mask its letter hollow`);
      for (const tag of masked) {
        assert.ok(!/\stransform=/.test(tag),
          `${name}: ${tag.trim()} carries both — the hollow will sit offset`);
      }
    }
  });

  test('the mask region is pinned to user space, not the bounding box', () => {
    // maskUnits defaults to objectBoundingBox, whose region excludes stroke
    // width — that clipped the hollow letter's own outline into a hard
    // rectangle across the face.
    const svg = iconSource('logo');
    assert.match(svg, /<mask[^>]*maskUnits="userSpaceOnUse"/);
  });

  test('three marks, each drawn for the size it is used at', () => {
    // logo      full detail, for display sizes
    // logoOutline  hollow letter, simplified coin — the headers, at 56px
    // logoSmall solid letter, 6 ridges — the footer mark and the favicon
    for (const name of ['logo', 'logoOutline', 'logoSmall']) {
      assert.ok(iconSource(name), `${name} is missing`);
    }
    // Only the outlined marks have a hollow letter; logoSmall's is solid, so
    // scaling it up would never produce an outline.
    for (const name of ['logo', 'logoOutline']) {
      assert.match(iconSource(name), /<mask/, `${name} should punch the letter hollow`);
    }
    assert.ok(!iconSource('logoSmall').includes('<mask'), 'logoSmall draws the letter solid');

    // Nothing renders the full mark: it is 22 beads and 15 ridges, none of
    // which resolves at header size.
    for (const [name, file] of [['navbar.js', 'js/common/navbar.js'], ['index.html', 'index.html'],
                                ['checkout.html', 'checkout.html'], ['dashboard.html', 'dashboard.html']]) {
      const source = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf-8');
      assert.ok(!/data-icon="logo"/.test(source), `${name} renders the full mark; it is too dense on the page`);
    }
    assert.ok(navbarJs.includes('data-icon="logoOutline"'));
  });

  test('the outline is drawn large enough to survive', () => {
    // The rim is half the difference between the outer stroke and the core
    // punched out of it, in viewBox units. Below a rendered pixel the letter
    // stops being hollow and fills in, so the two are checked against each
    // other rather than against a number someone has to remember to update.
    const svg = iconSource('logoOutline');
    const outer = Number(/<g mask[\s\S]*?stroke-width="([\d.]+)"/.exec(svg)[1]);
    const inner = Number(/<mask[\s\S]*?stroke-width="([\d.]+)"/.exec(svg)[1]);
    const rim = (outer - inner) / 2;
    const size = Number(/\.site-header \.logo-mini svg\{width:(\d+)px/.exec(navbarJs)[1]);
    const rendered = rim * size / 32;
    assert.ok(rendered >= 1,
      `at ${size}px the ${rim} rim renders ${rendered.toFixed(2)}px; under 1px the letter fills in`);
  });

  test('every placement paints the mark in --ink, with nothing behind it', () => {
    // The mark used to be knocked out of an inked tile, which meant it had to
    // be --surface in the header and --ink in the footer. The tile is gone, so
    // both grounds are the page itself and the colour is the same everywhere.
    assert.match(navbarJs, /\.site-header \.logo-mini\{[^}]*background:none[^}]*color:var\(--ink\)/);
    for (const file of ['checkout.css', 'dashboard.css']) {
      const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', file), 'utf-8');
      const rule = css.slice(css.indexOf('\n.logo-mini {'), css.indexOf('}', css.indexOf('\n.logo-mini {')));
      assert.match(rule, /background:\s*none/, `${file}: the header mark should have no tile`);
      assert.match(rule, /color:\s*var\(--ink\)/, `${file}: and should paint in --ink`);
    }
    const indexCss = fs.readFileSync(path.join(PUBLIC_DIR, 'css/index.css'), 'utf-8');
    const mark = indexCss.slice(indexCss.indexOf('.footer-mark {'), indexCss.indexOf('}', indexCss.indexOf('.footer-mark {')));
    assert.match(mark, /color:\s*var\(--ink\)/);
  });

  test('the footer mark matches the header', () => {
    // Same mark, same size. The footer used logoSmall at 26px, whose letter is
    // solid — below about 49px the hollow rim is a sub-pixel line, so there was
    // no outlined option there until the mark grew.
    const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
    assert.match(indexHtml, /class="footer-mark" data-icon="logoOutline"/);

    const indexCss = fs.readFileSync(path.join(PUBLIC_DIR, 'css/index.css'), 'utf-8');
    const rule = indexCss.slice(indexCss.indexOf('.footer-mark {'), indexCss.indexOf('}', indexCss.indexOf('.footer-mark {')));
    const header = /\.site-header \.logo-mini svg\{width:(\d+)px/.exec(navbarJs)[1];
    assert.match(rule, new RegExp(`width:\\s*${header}px`), 'the footer mark should match the header');
    assert.match(rule, /color:\s*var\(--ink\)/);
  });

  test('the favicon stays in step with logoSmall, which is its source', () => {
    // favicon.svg is a standalone copy of logoSmall's geometry — it has to be,
    // since it cannot reach into the icon set. Hand-copied markup drifts, so
    // the paths are compared rather than trusted.
    const small = iconSource('logoSmall');
    const paths = [...small.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(paths.length >= 4, 'expected the coin, the reeding and the letter');
    for (const d of paths) {
      assert.ok(favicon.includes(d), `favicon.svg is missing a path logoSmall draws: ${d.slice(0, 40)}…`);
    }
  });

  test('the header mark is drawn at one size everywhere', () => {
    // checkout and dashboard draw their own headers; the brand should not
    // change size between the marketing pages and the app.
    const size = /\.site-header \.logo-mini svg\{width:(\d+)px/.exec(navbarJs)[1];
    for (const file of ['checkout.css', 'dashboard.css']) {
      const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', file), 'utf-8');
      const rule = css.slice(css.indexOf('.logo-mini svg {'), css.indexOf('}', css.indexOf('.logo-mini svg {')));
      assert.match(rule, new RegExp(`width:\\s*${size}px`), `${file} draws the mark at a different size to the navbar`);
    }
  });

  test('anything pinned under the header follows its height', () => {
    // The header grew for the bigger mark. docs and api-reference pin a
    // "Contents" bar directly beneath it; a stale offset leaves a gap that page
    // content scrolls through.
    const mobile = navbarJs.slice(navbarJs.indexOf('@media(max-width:900px)'));
    const height = Number(/\.site-header\{height:(\d+)px/.exec(mobile)[1]);
    for (const file of ['docs.css', 'api-reference.css']) {
      const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', file), 'utf-8');
      const top = Number(/top:\s*(\d+)px;[^}]*z-index:\s*90/.exec(css)?.[1] ?? /top:\s*(\d+)px/.exec(css)[1]);
      assert.ok(Math.abs(height - top) <= 1,
        `${file} pins its Contents bar at ${top}px under a ${height}px header`);
    }
  });

  test('the favicon carries its own colour, since it has no CSS to inherit', () => {
    // A standalone favicon has no page to take `color` from, so currentColor
    // would resolve to black and vanish into a dark browser chrome.
    assert.ok(favicon.includes('currentColor'));
    assert.match(favicon, /svg\s*\{\s*color:/);
    assert.match(favicon, /@media \(prefers-color-scheme: dark\)/);
  });
});

describe('Landing page: the settlement section', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/index.css'), 'utf-8');
  const tokenJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/token.js'), 'utf-8');

  test('the feature bento and the stats band are gone, markup and styles alike', () => {
    for (const dead of ['bento', 'stats-band', 'stats-strip', 'stat-number', 'section-title']) {
      assert.ok(!html.includes(dead), `index.html still mentions ${dead}`);
      assert.ok(!css.includes(`.${dead}`), `index.css still styles .${dead}`);
    }
  });

  test('nothing crosses the coin: the rail and receipt stop short of its columns', () => {
    // Track 8 is deliberately empty. The rail and the receipt end at line 8 and
    // the figure starts at line 9, so no item can overlap the token.
    const grab = (sel) => {
      const start = css.indexOf(`${sel} {`);
      assert.ok(start !== -1, sel);
      return css.slice(start, css.indexOf('}', start));
    };
    const railEnd = Number(/grid-column:\s*1 \/ (\d+)/.exec(grab('.settle-rail'))[1]);
    const receiptEnd = Number(/grid-column:\s*2 \/ (\d+)/.exec(grab('.settle-receipt'))[1]);
    const figureStart = Number(/grid-column:\s*(\d+) \/ 13/.exec(grab('.settle__figure'))[1]);

    assert.ok(railEnd <= figureStart, `rail ends at ${railEnd}, figure starts at ${figureStart}`);
    assert.ok(receiptEnd <= figureStart, `receipt ends at ${receiptEnd}, figure starts at ${figureStart}`);
    assert.ok(figureStart > railEnd, 'a gutter column is left between them');
  });

  test('the grid tracks cannot be stretched by their own contents', () => {
    // A bare 1fr is minmax(auto, 1fr): an item wider than its share expands its
    // own tracks and slides the rest of the grid, which is how the receipt ended
    // up over the coin the first time.
    const start = css.indexOf('.settle__compose {');
    const body = css.slice(start, css.indexOf('}', start));
    assert.match(body, /grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/);
  });

  test('the live figures are fetched, never written into the page', () => {
    // Every number has to come from the status API, or the landing page can
    // claim an uptime the status page contradicts.
    assert.ok(tokenJs.includes("fetch('/api/status'"), 'token.js fetches the status API');
    for (const field of ['overallStatusLabel', 'uptimePercentage', 'windowDays',
      'operationalCount', 'totalCount']) {
      assert.ok(tokenJs.includes(field), `token.js reads ${field}`);
    }
    // The strip ships empty and stays empty if the call fails.
    assert.match(html, /<span class="live-line__live" id="liveStatus"><\/span>/);
    assert.ok(/liveHost\.innerHTML = '';/.test(tokenJs), 'a failed call clears rather than invents');

    const strip = html.slice(html.indexOf('class="live-line"'), html.indexOf('</section>'));
    assert.ok(!/uptime/i.test(strip), 'no uptime figure is hardcoded in the markup');
  });

  test('the section reuses the site reveal rather than shipping a second one', () => {
    // reveal.js already handles reduced motion, jump scrolls, and a failsafe for
    // when the observer never fires. Only the direction differs here.
    assert.ok(html.includes('data-reveal-delay="210"'), 'the rail staggers via the site mechanism');
    assert.ok(!tokenJs.includes('IntersectionObserver'), 'token.js does not observe scroll itself');

    const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
    assert.match(motion, /\.settle \[data-reveal\][^}]*transform:\s*translateX\(-26px\)/);
    assert.match(motion, /\.settle \[data-reveal\]\.is-revealed[^}]*transform:\s*none/);
  });

  test('the in-row cascades rest visible even if their script never runs', () => {
    // token.js sets --cascade-delay. If it never runs the delay falls back to 0
    // rather than leaving the chips and rows permanently transparent.
    assert.match(css, /--cascade-delay,\s*0ms/);
    assert.ok(tokenJs.includes('--cascade-delay'), 'token.js sets the cascade index');
    // And it is dropped once the entrance has played, so a later theme change
    // does not wait out the entrance delay before recolouring.
    assert.ok(tokenJs.includes('removeProperty'), 'the delay is cleared after the entrance');
  });

  test('the receipt agrees with the configured platform fee', () => {
    // The tile this replaced showed 0.00100 on 0.5 ETH - 0.2% - under a heading
    // promising the number you see is the number that sends.
    const envJs = fs.readFileSync(path.join(__dirname, '..', 'src/config/env.js'), 'utf-8');
    const rate = Number(/PLATFORM_FEE_RATE \|\| '([\d.]+)'/.exec(envJs)[1]);
    const payment = 0.5;
    const network = 0.00042;
    const fee = payment * rate;

    assert.ok(html.includes(`${fee.toFixed(5)} ETH`), `platform fee should read ${fee.toFixed(5)} ETH`);
    assert.ok(html.includes(`${(payment - fee - network).toFixed(5)} ETH`), 'the total should net out');
    assert.ok(html.includes(`<i>${Math.round(rate * 100)}%</i>`), 'the rate is labelled');
  });
});

describe('Landing page: scrolling, the closing band and the footer', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/index.css'), 'utf-8');
  const navbarJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/common/navbar.js'), 'utf-8');

  test('the hero chevron scrolls down to the features rather than jumping', () => {
    assert.match(html, /class="hero-scroll[^"]*"[^>]*href="#features"/);

    const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
    assert.match(motion, /html\s*\{\s*scroll-behavior:\s*smooth/);

    // tokens.css forces scroll-behavior back to auto under reduced motion, so
    // this must not also be declared outside that query.
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*?\n\}/g, '');
    assert.ok(!/scroll-behavior:\s*smooth/.test(outside),
      'smooth scrolling is gated on the motion preference');
  });

  test('the anchor clears the sticky header instead of landing under it', () => {
    const headerHeight = Number(/\.site-header\{height:(\d+)px/.exec(navbarJs)[1]);
    const margin = Number(/\.settle\s*\{\s*scroll-margin-top:\s*(\d+)px/.exec(css)[1]);
    assert.ok(margin >= headerHeight,
      `scroll-margin-top ${margin}px should clear the ${headerHeight}px header`);
  });

  test('the closing band no longer claims a userbase it does not have', () => {
    // "Join thousands of users who trust Etheroute" was the same unverifiable
    // gesture as the $1k+ daily volume stat. Comments are stripped first: the
    // markup records what the line used to say, and that is not a claim.
    const copy = html.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/thousands of users/i.test(copy));

    const band = copy.slice(copy.indexOf('cta-section'), copy.indexOf('class="footer"'));
    assert.ok(band.includes('data-reveal'), 'the band animates in');
    assert.ok(band.includes('cta-rule'), 'it opens with a drawn rule');
  });

  test('the closing buttons keep their own transition and only borrow the delay', () => {
    // .btn carries `transition: all` plus its own hover lift, and it outranks
    // [data-reveal]'s transition - so redefining the shorthand here would drop
    // the hover states. Only the delay is added, and it is cleared on arrival
    // so a later hover does not wait out the entrance.
    const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
    assert.match(motion, /\.cta-buttons \.btn\s*\{\s*transition-delay:\s*var\(--reveal-delay/);
    assert.match(motion, /\.cta-buttons \.btn\.is-revealed\s*\{\s*transition-delay:\s*0ms/);
  });

  test('the footer columns and their links animate in, on every page that has one', () => {
    // The footer is the same on all ten pages, so the cascade lives in
    // tokens.css rather than in the ten stylesheets that each define
    // .footer-link for themselves.
    const tokens = fs.readFileSync(path.join(PUBLIC_DIR, 'css/tokens.css'), 'utf-8');
    const motion = tokens.slice(tokens.indexOf('/* \u2500\u2500 Footer entrance'));

    assert.match(motion, /@media \(prefers-reduced-motion: no-preference\)/);
    assert.match(motion, /\.footer-section \.footer-link[^}]*opacity:\s*0/);
    assert.match(motion, /\.footer-section\.is-revealed \.footer-link[^}]*opacity:\s*1/);

    // Links are siblings of their column's h4, so the first is :nth-child(2).
    for (const n of [2, 3, 4, 5]) {
      assert.ok(motion.includes(`.footer-section .footer-link:nth-child(${n})`), `nth-child(${n})`);
    }

    // No page may keep a private copy, or the two will drift.
    for (const file of fs.readdirSync(path.join(PUBLIC_DIR, 'css'))) {
      if (!file.endsWith('.css') || file === 'tokens.css') continue;
      const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', file), 'utf-8');
      assert.ok(!css.includes('--link-delay'), `${file} duplicates the footer cascade`);
    }
  });

  test('every footer marks its columns so the reveal has something to observe', () => {
    // Without data-reveal the links would sit at opacity 0 for good: the hidden
    // state is real CSS, and only reveal.js clears it.
    const pages = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
    let checked = 0;

    for (const page of pages) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf-8');
      const at = html.indexOf('class="footer"');
      if (at === -1) continue;
      checked += 1;

      const footer = html.slice(at);
      // data-reveal(?!-), or data-reveal-delay would count a second time each.
      const marks = (footer.match(/data-reveal(?!-)/g) || []).length;
      const columns = (footer.match(/class="footer-section"/g) || []).length;

      assert.ok(marks >= columns + 1,
        `${page}: ${marks} reveal targets for ${columns} columns and a bottom bar`);
      assert.ok(html.includes('/js/common/reveal.js'),
        `${page} hides its footer links but never loads reveal.js`);
    }

    assert.ok(checked >= 10, `only ${checked} pages with a footer were checked`);
  });

  test('the reveal fires on sight, not on load', () => {
    // reveal.js observes anything below the fold and releases it as it comes
    // into view; anything already on screen at load is shown at once rather
    // than animating an entrance the visitor has already scrolled to.
    const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js/common/reveal.js'), 'utf-8');
    assert.match(js, /new IntersectionObserver/);
    assert.match(js, /rect\.top < viewportHeight \* 0\.9/,
      'on-screen-at-load elements are revealed without animating');
    assert.match(js, /observer\.observe\(node\)/, 'everything else waits to be seen');
  });

  test('a footer link responds to hover without waiting out its entrance delay', () => {
    // colour must carry no delay in the transition list, or hovering a link
    // would lag by up to a quarter of a second.
    const tokens = fs.readFileSync(path.join(PUBLIC_DIR, 'css/tokens.css'), 'utf-8');
    const start = tokens.indexOf('.footer-section .footer-link {');
    const body = tokens.slice(start, tokens.indexOf('}', start));
    assert.match(body, /color var\(--dur\) var\(--ease-out\)\s*;/);
  });
});

describe('About and FAQ open like the status page', () => {
  const tokensCss = fs.readFileSync(path.join(PUBLIC_DIR, 'css/tokens.css'), 'utf-8');
  const themeJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/common/theme.js'), 'utf-8');

  test('both use the shared banner rather than overriding it', () => {
    // about.css used to redefine .hero with hardcoded #ffffff / #666666 — no
    // theme, no sheen, no rise. The shared rule in tokens.css does all three.
    for (const file of ['about.css', 'faq.css']) {
      const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', file), 'utf-8');
      assert.ok(!/^\.hero\s*\{/m.test(css), `${file} must not redefine .hero`);
    }
    for (const page of ['about.html', 'faq.html']) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf-8');
      assert.match(html, /<div class="hero">/, page);
      assert.match(html, /<span class="hero-pill">/, `${page} carries the kicker`);
    }
  });

  test('the banner keeps its light sweep and its rise', () => {
    assert.match(tokensCss, /animation:\s*hero-sheen/, 'the diagonal sweep');
    assert.match(tokensCss, /@keyframes hero-sheen/);
    assert.match(tokensCss, /\.hero h1[^}]*animation:\s*hero-rise/s, 'the heading rises in');
    assert.match(tokensCss, /\.hero-pill[^}]*animation:\s*hero-rise/s, 'so does the kicker');
  });

  test('scripting announces itself before the first paint', () => {
    // theme.js is the only file loaded from <head>, so it is the one place a
    // class can be set before anything renders. The FAQ's collapse depends on
    // it: set any later and the answers flash open first.
    assert.match(themeJs, /classList\.add\('js'\)/);
    for (const page of ['about.html', 'faq.html']) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf-8');
      const head = html.slice(0, html.indexOf('</head>'));
      assert.ok(head.includes('/js/common/theme.js'), `${page} loads theme.js in <head>`);
    }
  });
});

describe('About page: the template is gone', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'about.html'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/about.css'), 'utf-8');

  test('none of the generated-outline blocks survive', () => {
    // Mission / Values / Why Choose / Technology Stack / Our Journey was the
    // canonical outline, and two of its blocks — a four-card grid and a
    // six-item checkmark list — were the patterns just taken off the landing
    // page. They made the same four arguments twice.
    for (const dead of ['value-card', 'values-grid', 'feature-item', 'feature-list',
                        'feature-check', 'timeline', 'highlight-box', 'cta-section']) {
      assert.ok(!html.includes(dead), `about.html still has .${dead}`);
      assert.ok(!css.includes(`.${dead}`), `about.css still styles .${dead}`);
    }
  });

  test('the dependency list is not published', () => {
    // Naming the stack tells a merchant nothing about whether they get paid,
    // and publishing an exact dependency list is a mild security smell.
    for (const leak of ['ethers.js', 'bitcoinjs-lib', '@solana/web3.js', 'Express.js', 'Technology Stack']) {
      assert.ok(!html.includes(leak), `about.html still names ${leak}`);
    }
  });

  test('every figure in the strip is one the repo can back', () => {
    const chains = require('../src/config/chains.js').CHAINS;
    const envJs = fs.readFileSync(path.join(__dirname, '..', 'src/config/env.js'), 'utf-8');
    const rate = Number(/PLATFORM_FEE_RATE \|\| '([\d.]+)'/.exec(envJs)[1]);

    const strip = html.slice(html.indexOf('class="facts"'), html.indexOf('class="prose"'));
    assert.ok(strip.includes(`<b>${Object.keys(chains).length}</b>`), 'the network count');
    assert.ok(strip.includes(`<b>${Math.round(rate * 100)}%</b>`), 'the platform fee');
    assert.ok(strip.includes('<b>0</b>'), 'documents required');
  });

  test('it makes no claim about how many people use it', () => {
    const copy = html.replace(/<!--[\s\S]*?-->/g, '');
    for (const claim of [/thousands/i, /trusted by/i, /\bjoin \d/i]) {
      assert.ok(!claim.test(copy), `unverifiable claim: ${claim}`);
    }
  });

  test('the four principles are one rail, not a grid of cards', () => {
    assert.strictEqual((html.match(/class="rule"/g) || []).length, 4);
    const rail = css.slice(css.indexOf('.rule {'), css.indexOf('.rule code'));
    assert.ok(!/repeat\(auto-fit/.test(rail), 'the rail is not a card grid');
    // The accent rule draws itself in rather than the row moving.
    const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
    assert.match(css, /\.rule::before/);
    assert.match(motion, /\.rule\.is-revealed::before[^}]*transform:\s*scaleY\(1\)/s);
  });
});

describe('FAQ page: a usable accordion', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'faq.html'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/faq.css'), 'utf-8');
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js/faq.js'), 'utf-8');

  test('every question is a real button, not a div with a click handler', () => {
    // A div is not focusable, carries no role and exposes no aria-expanded, so
    // the whole FAQ was unreachable by keyboard.
    assert.ok(!html.includes('faq-question'), 'the old div is gone');
    assert.ok(!html.includes('toggleFaq'), 'and so is its handler');
    assert.ok(!js.includes('function toggleFaq'), 'faq.js no longer defines it globally');

    const buttons = html.match(/<button class="qa__q" type="button" aria-controls="[^"]+">/g) || [];
    assert.strictEqual(buttons.length, 18, 'eighteen questions, eighteen buttons');
    assert.strictEqual((html.match(/id="faq-a\d+"/g) || []).length, 18, 'each panel is addressable');
    assert.match(js, /setAttribute\('aria-expanded'/, 'state is stamped on and toggled');
  });

  test('nothing was lost moving seventeen questions across, and the eighteenth says what we support', () => {
    assert.strictEqual((html.match(/class="qa"/g) || []).length, 18);
    assert.strictEqual((html.match(/class="qa-group"/g) || []).length, 4);
    for (const group of ['Account &amp; Registration', 'Withdrawals &amp; Transactions',
                         'Security &amp; Privacy', 'Technical']) {
      assert.ok(html.includes(group), group);
    }
    // The two emphasis blocks kept their content AND their closing tags: the
    // first extraction pass matched non-greedily and ate them.
    const notes = html.match(/<div class="qa__note"><p>([\s\S]*?)<\/p><\/div>/g) || [];
    assert.strictEqual(notes.length, 2, 'both callouts survived');
    for (const note of notes) assert.ok(note.length > 40, 'with their text intact');
    assert.ok(!html.includes('class="highlight"'), 'none left half-converted');
  });

  test('the chain answers name every chain in the registry, not the four of the first draft', () => {
    const registry = require('../src/config/chains');
    const N = registry.CODES.length;
    const support = html.slice(html.indexOf('Which chains and coins do you support?'), html.indexOf('Which cryptocurrencies can I withdraw?'));
    for (const name of ['Ethereum (ETH)', 'Base', 'Arbitrum One', 'Optimism', 'Polygon (POL)', 'BNB Chain (BNB)', 'Avalanche (AVAX)', 'Bitcoin (BTC)', 'Litecoin (LTC)', 'Solana (SOL)']) {
      assert.ok(support.includes(name), `support answer names ${name}`);
    }
    for (const chain of registry.list().slice(10)) assert.ok(support.includes(chain.name), `support answer names ${chain.name}`);
    assert.ok(support.includes(`${N} networks across four families`), 'the count is the registry\'s');
    assert.ok(support.includes('USDC and USDT'), 'and the dollar tokens');
    assert.ok(support.includes('GET /api/chains'), 'and points at the live list');
    const withdraw = html.slice(html.indexOf('Which cryptocurrencies can I withdraw?'), html.indexOf('What are the withdrawal fees?'));
    assert.ok(withdraw.includes(`The coin of any of the ${N} chains we support`));
    assert.ok(withdraw.includes('quoted on the review screen before you confirm'), 'the swap is explained the way the product does it');
    for (const chain of registry.list().filter((c) => !registry.swappable(c.code))) assert.ok(withdraw.includes(chain.name), `${chain.name} is named as direct-only`);
    assert.ok(!html.includes('four major blockchain networks'), 'the four-chain answer is gone');
    assert.ok(!/ten (chains|networks)/i.test(html), 'no stale ten-chain copy');
    // the search text was rebuilt for both, lowercased with the tags stripped
    assert.ok(html.includes(`data-text="which chains and coins do you support? ${N} networks across four families`));
    assert.ok(html.includes(`data-text="which cryptocurrencies can i withdraw? the coin of any of the ${N} chains we support`));
    // and the timings, direct first, swap on top
    const times = html.slice(html.indexOf('How long does a withdrawal take?'), html.indexOf('Can I cancel a withdrawal?'));
    for (const name of ['Solana', 'Arbitrum One, Sei, Monad, opBNB, Cronos', 'Base, Optimism, Avalanche, BNB Chain, Sonic, Celo and most of the other EVM chains', 'Ethereum', 'Polygon', 'Litecoin', 'Bitcoin']) {
      assert.ok(times.includes(`<strong>${name}:</strong>`), `timings name ${name}`);
    }
    assert.ok(times.includes('swap provider&#x27;s own processing time comes on top'));
    assert.ok(!times.includes('30 seconds to 2 minutes'), 'the four-chain figures are gone');
    assert.ok(html.includes('data-text="how long does a withdrawal take? a direct transfer'), 'search text rebuilt');
  });

  test('an answer opens to its own height, with no ceiling to clip it', () => {
    // max-height: 0 -> 500px made a short answer stop dead rather than ease
    // out, and silently cut off anything taller than 500px.
    assert.ok(!/max-height:\s*500px/.test(css), 'the ceiling is gone');
    assert.match(css, /\.qa__a[^}]*grid-template-rows:\s*1fr/s);
    assert.match(css, /grid-template-rows:\s*0fr/);
    assert.match(css, /transition:\s*grid-template-rows/);
  });

  test('the answers stay readable when the script does not run', () => {
    // The collapse is keyed on html.js, so an unscripted page is merely long
    // rather than seventeen headings that do nothing.
    assert.match(css, /\.js \.qa__q:not\(\[aria-expanded="true"\]\) \+ \.qa__a[^}]*grid-template-rows:\s*0fr/s);
    assert.ok(!/aria-expanded/.test(html),
      'the attribute is stamped by script, so unscripted markup claims no collapsed state');
  });

  test('the filter searches answers as well as questions', () => {
    assert.strictEqual((html.match(/data-text="/g) || []).length, 18);
    // Built from the question and its answer with tags stripped.
    assert.ok(html.includes('data-text="how do i create an account?'));
    assert.match(js, /dataset\.text\.includes\(needle\)/);
    assert.match(js, /group\.hidden = matches === 0/, 'an empty group heading is hidden too');
    // Whatever the visitor typed is echoed as text, never as markup.
    assert.match(js, /term\.textContent/);
    assert.ok(!/term\.innerHTML/.test(js));
  });
});

describe('About and FAQ end on the Help Center contact block', () => {
  const helpCss = fs.readFileSync(path.join(PUBLIC_DIR, 'css/help.css'), 'utf-8');

  test('both reuse the block that already works, rather than a bare URL', () => {
    for (const page of ['about.html', 'faq.html']) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf-8');
      assert.ok(html.includes('class="channels-grid"'), `${page} uses the channel grid`);
      assert.strictEqual((html.match(/class="channel"/g) || []).length, 3, `${page}: three channels`);
      // The old blocks printed the Telegram address as plain text.
      assert.ok(!/<strong>Telegram:<\/strong>\s*https/.test(html), `${page}: no unlinked URL`);
      assert.ok(html.includes('href="https://t.me/etheroute"'), `${page}: Telegram is a link`);
      assert.ok(html.includes('href="mailto:support@etheroute.io"'), `${page}: email is a link`);
    }
  });

  test('the channel styling matches the Help Center it was taken from', () => {
    const helpChannel = /\.channel \{([\s\S]*?)\}/.exec(helpCss)[1];
    const wanted = ['border-radius', 'background', 'font-weight', 'text-decoration'];
    for (const file of ['about.css', 'faq.css']) {
      const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', file), 'utf-8');
      const block = /\.channel \{([\s\S]*?)\}/.exec(css)[1];
      for (const prop of wanted) {
        assert.ok(block.includes(prop), `${file}: .channel sets ${prop}`);
      }
      const lift = (text) => /\.channel:hover \{([\s\S]*?)\}/.exec(text)[1];
      assert.ok(lift(helpCss).includes('translateY(-2px)') && lift(css).includes('translateY(-2px)'),
        `${file}: same hover lift`);
    }
  });

  test('their Discord links point at the server, not at discord.gg', () => {
    // Nine links across the site still point at Discord's homepage. These two
    // pages were rewritten, so theirs are correct; the rest are untouched.
    for (const page of ['about.html', 'faq.html']) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf-8');
      assert.ok(!/href="https:\/\/discord\.gg"/.test(html), `${page} has a bare discord.gg link`);
      assert.ok(html.includes('https://discord.gg/etheroute'), `${page} links the server`);
    }
  });
});

describe('Compliance, Privacy and Terms share one treatment', () => {
  const PAGES = ['compliance', 'privacy', 'terms'];
  const read = (p) => fs.readFileSync(path.join(PUBLIC_DIR, p), 'utf-8');
  const legalCss = read('css/legal.css');
  const legalJs = read('js/legal.js');

  test('one stylesheet serves all three, with the duplicate gone', () => {
    // terms.css was a byte-identical copy of privacy.css, and compliance.html
    // linked privacy.css rather than having one of its own.
    for (const gone of ['css/privacy.css', 'css/terms.css']) {
      assert.ok(!fs.existsSync(path.join(PUBLIC_DIR, gone)), `${gone} should be gone`);
    }
    for (const page of PAGES) {
      const html = read(`${page}.html`);
      assert.ok(html.includes('/css/legal.css'), `${page} loads legal.css`);
      assert.ok(!/\/css\/(privacy|terms)\.css/.test(html), `${page} has no stale link`);
    }
  });

  test('the legal prose came across intact', () => {
    // Sentences from each document, chosen from different sections. The
    // transform only rewrapped: it must not have reworded anything.
    const spot = {
      compliance: ['highest standards of regulatory compliance',
                   'Transaction monitoring systems',
                   'we maintain the ability to implement KYC procedures when required'],
      privacy: ['Etheroute does not collect personally identifiable information',
                'Username (your chosen identifier)',
                'Password (hashed and encrypted)'],
      terms: ['Acceptance of Terms', 'Risk Disclaimer', 'Limitation of Liability'],
    };
    for (const [page, phrases] of Object.entries(spot)) {
      const html = read(`${page}.html`);
      for (const phrase of phrases) {
        assert.ok(html.includes(phrase), `${page}: "${phrase.slice(0, 40)}" is missing`);
      }
    }
  });

  test('every section is numbered, addressable, and reachable from the rail', () => {
    const expected = { compliance: 6, privacy: 15, terms: 15 };
    for (const page of PAGES) {
      const html = read(`${page}.html`);
      const ids = [...html.matchAll(/<h2 id="([^"]+)" data-reveal>/g)].map((m) => m[1]);
      assert.strictEqual(ids.length, expected[page], `${page}: section count`);
      assert.strictEqual(new Set(ids).size, ids.length, `${page}: ids are unique`);
      for (const id of ids) assert.ok(/^[a-z0-9-]+$/.test(id), `${page}: "${id}" is a clean anchor`);
    }
  });

  test('the rail is generated from the document, not written out twice', () => {
    // A hand-written rail drifts the moment a section is renamed.
    assert.match(legalJs, /querySelectorAll\('h2\[id\]'\)/);
    for (const page of PAGES) {
      const html = read(`${page}.html`);
      assert.match(html, /<ol id="legalToc"><\/ol>/, `${page} ships the rail empty`);
      assert.ok(html.includes('/js/legal.js'), `${page} loads legal.js`);
    }
  });

  test('the rail carries heading text, never heading markup', () => {
    assert.match(legalJs, /link\.textContent = heading\.textContent/);
    assert.ok(!/innerHTML\s*=\s*`?\$\{?heading/.test(legalJs));
  });

  test('an unscripted page shows the document rather than an empty rail', () => {
    assert.match(legalCss, /\.legal-toc\[hidden\]\s*\{\s*display:\s*none/);
    for (const page of PAGES) {
      assert.match(read(`${page}.html`), /<nav class="legal-toc"[^>]*hidden>/, page);
    }
    assert.match(legalJs, /nav\.hidden = false/);
  });

  test('the document is set to a reading measure', () => {
    // It ran the full container width before — around 110 characters a line,
    // well past what prose is comfortable at.
    const body = legalCss.slice(legalCss.indexOf('.legal-doc {'), legalCss.indexOf('.legal-doc .last-updated'));
    assert.match(body, /max-width:\s*70ch/);
  });

  test('an anchor lands clear of the sticky header', () => {
    const navbarJs = read('js/common/navbar.js');
    const headerHeight = Number(/\.site-header\{height:(\d+)px/.exec(navbarJs)[1]);
    const margin = Number(/\.legal-doc h2 \{[^}]*scroll-margin-top:\s*(\d+)px/s.exec(legalCss)[1]);
    assert.ok(margin >= headerHeight, `${margin}px should clear the ${headerHeight}px header`);
  });

  test('the grey callout slab became the accent rule used elsewhere', () => {
    for (const page of PAGES) {
      assert.ok(!read(`${page}.html`).includes('class="highlight"'), `${page}: no slab left`);
    }
    assert.match(legalCss, /\.legal-doc \.note \{[^}]*border-left:\s*2px solid var\(--ink\)/s);
  });

  test('the date is machine readable', () => {
    for (const page of PAGES) {
      const html = read(`${page}.html`);
      assert.match(html, /<time class="last-updated" datetime="\d{4}-\d{2}-\d{2}">/, page);
      assert.ok(!html.includes('<div class="last-updated">'), `${page}: old stamp gone`);
    }
  });

  test('only compliance ends on the contact block, since only it asks you to get in touch', () => {
    // Its last section says to "reach out to our team through our support
    // channels" without naming one.
    const compliance = read('compliance.html');
    assert.ok(compliance.includes('support channels'), 'the sentence stays');
    assert.strictEqual((compliance.match(/class="channel"/g) || []).length, 3);
    for (const page of ['privacy', 'terms']) {
      assert.ok(!read(`${page}.html`).includes('class="channel"'), `${page} has no contact block`);
    }
  });

  test('they follow the same banner and entrance as the rest of the site', () => {
    for (const page of PAGES) {
      const html = read(`${page}.html`);
      assert.match(html, /<div class="hero">/, page);
      assert.match(html, /<span class="hero-pill">Legal<\/span>/, `${page} kicker`);
    }
    assert.ok(!/^\.hero\s*\{/m.test(legalCss), 'legal.css must not override the shared banner');
    const motion = legalCss.slice(legalCss.indexOf('@media (prefers-reduced-motion: no-preference)'));
    assert.match(motion, /\.legal \[data-reveal\][^}]*translateX\(-22px\)/s);
  });
});

describe('dashboard.css carries each rule once', () => {
  /**
   * 26% of the file - 1,137 lines across 138 blocks - was repeated verbatim:
   * the whole transaction, payout and status-badge vocabulary defined twice,
   * and all three responsive blocks twice. A component defined in two places
   * is how the eight dashboard surfaces drifted apart in the first place.
   *
   * The earlier copy of each pair was removed, never the later: anything the
   * earlier copy wins in the cascade the later one also wins, so dropping the
   * earlier can change nothing - dropping the later could. Verified by a
   * computed-style snapshot of every element and pseudo-element on the live
   * dashboard before and after: 466 of 466 identical apart from a subtitle
   * whose text had changed between loads.
   */
  test('no top-level block appears twice', () => {
    const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8');
    const blocks = [];
    let depth = 0, start = 0, inComment = false;
    for (let i = 0; i < css.length; i += 1) {
      const two = css.slice(i, i + 2);
      if (!inComment && two === '/*') { inComment = true; i += 1; continue; }
      if (inComment && two === '*/') { inComment = false; i += 1; continue; }
      if (inComment) continue;
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) { blocks.push(css.slice(start, i + 1)); start = i + 1; }
      }
    }
    const seen = new Map();
    const dupes = [];
    for (const block of blocks) {
      const key = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
      if (seen.has(key)) dupes.push(key.slice(0, 60));
      seen.set(key, true);
    }
    // The count is deliberately not asserted: the foundation keeps adding
    // legitimate rules, and a ceiling that has to be raised every surface is
    // a number without a meaning. Zero duplicates is the invariant.
    assert.deepStrictEqual(dupes, [], `${dupes.length} duplicated block(s)`);
  });
});

describe('Dashboard foundation and the overview on it', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8');
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const overview = html.slice(html.indexOf('id="overviewPage"'), html.indexOf('<!-- Transactions Page -->'));

  test('the foundation is defined once and comes last, so it wins where rules disagree', () => {
    const at = css.indexOf('Foundation');
    assert.ok(at !== -1, 'the foundation block exists');
    for (const sel of ['.dash-head {', '.dash-facts {', '.dash-section {', '.status-pill {', '.segmented {', '.dash-empty {']) {
      // Top-level rules start at column 0; the responsive block indents its
      // restatements. trimEnd, because the working tree is CRLF on Windows
      // (core.autocrlf) and a trailing CR would otherwise defeat the compare.
      const tops = css.split(String.fromCharCode(10)).map((l, n) => [l.trimEnd(), n]).filter(([l]) => l === sel);
      assert.strictEqual(tops.length, 1, `${sel} is defined exactly once at top level`);
      const lineOfFoundation = css.slice(0, at).split(String.fromCharCode(10)).length;
      assert.ok(tops[0][1] > lineOfFoundation, `${sel} lives in the foundation`);
    }
  });

  test('the two definitions that fought over one name are resolved', () => {
    // .status-badge was a 24px icon dot AND a text pill, so each bled into the
    // other; .btn-small was uppercase only because its second copy won.
    assert.ok(!/align-items:\s*right/.test(css), 'the invalid align-items: right is gone');
    assert.strictEqual((css.match(/^\.btn-small \{/gm) || []).length, 1, '.btn-small once');
    assert.match(css, /#withdrawalStatus \.status-badge \{/, 'the dot is scoped to where it lives');
  });

  test('the overview is not a stack of cards', () => {
    assert.ok(!overview.includes('class="card"'), 'no .card on the overview');
    assert.ok(!overview.includes('class="grid-2"'), 'no card grid either');
    assert.ok(!/style="[^"]*border-bottom/.test(overview), 'no inline-styled stat rows');
    assert.match(overview, /<header class="dash-head">/);
    // activity, wallets, API calls
    assert.strictEqual((overview.match(/class="dash-section"/g) || []).length, 3);
  });

  test('no status line on the overview is fixed text', () => {
    // "Account Status: Active" and "API Status: Available" were hardcoded. A
    // status line that cannot change is not a status line.
    const copy = overview.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!copy.includes('Account Status'));
    assert.ok(!copy.includes('API Status'));
    assert.ok(!/>Active</.test(copy));
    assert.ok(!/>Available</.test(copy));
    // Every fact figure has an id, and dashboard.js writes to each.
    for (const id of ['walletCount', 'supportedChainCount', 'apiCallsTotal']) {
      assert.match(overview, new RegExp(`<b id="${id}">`), `${id} in the strip`);
      assert.ok(js.includes(`getElementById('${id}')`), `dashboard.js fills ${id}`);
    }
  });

  test('every hook dashboard.js writes to is still in the markup', () => {
    for (const id of ['totalBalanceUSD', 'withdrawalStatus', 'walletsContainer', 'apiCallsSubtitle',
      'apiCallsChart', 'hourBtn', 'dayBtn', 'weekBtn']) {
      assert.ok(overview.includes(`id="${id}"`), id);
    }
    // ...and the children updateWithdrawalStatus() reaches for.
    for (const child of ['status-text', 'status-badge', 'info-tooltip']) {
      assert.ok(overview.includes(`class="${child}`), child);
    }
  });

  test('the chart period reads as one control, driven by the class swap the script already does', () => {
    assert.match(overview, /<div class="segmented" role="group" aria-label="Chart period">/);
    assert.match(js, /classList\.add\('btn-primary'\)/, 'active = btn-primary');
    assert.match(css, /\.segmented \.btn-small\.btn-primary \{/);
    // Day is the default period in the script, so it ships selected.
    assert.match(js, /let currentChartPeriod = 'day'/);
    assert.match(overview, /id="dayBtn"/);
    assert.match(overview, /class="btn-small btn-primary" data-on-click="switchChartPeriod" data-arg="day"/);
  });

  test('the empty state is a line, and the script renders the same one', () => {
    assert.match(overview, /<div class="dash-empty">No wallets yet/);
    assert.ok(js.includes('<div class="dash-empty">No wallets yet'), 'dashboard.js uses the class, not inline style');
    const walletRenderer = js.slice(js.indexOf("getElementById('walletsContainer')"), js.indexOf('function calculateTotalBalance'));
    assert.ok(!walletRenderer.includes('style="padding: 24px'), 'no inline empty state left in the wallet renderer');
  });

  test('the readiness tooltip waits for the pointer and cannot push the page sideways', () => {
    // The first cut made it always-visible and nowrap; a long message pushed
    // the page 5px wide. dashboard.js sets display:block when there is
    // something to say, and the opacity gate keeps it out of the way until asked.
    const rule = css.slice(css.indexOf('#withdrawalStatus .info-tooltip {'), css.indexOf('#withdrawalStatus:hover'));
    assert.match(rule, /opacity:\s*0/);
    assert.match(rule, /white-space:\s*normal/);
    assert.match(rule, /max-width:/);
    assert.match(css, /#withdrawalStatus:hover \.info-tooltip,\s*#withdrawalStatus:focus-within \.info-tooltip \{ opacity: 1; \}/);
  });
});

describe('Dashboard shell and transactions', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8');
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const checkoutJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard-checkout.js'), 'utf-8');

  test('every click handler the markup names is defined', () => {
    // The dispatcher calls window[name]. A rewrite once sliced 25 functions out
    // of dashboard.js - the page switcher, the chart, every modal - and nothing
    // caught it until the page was loaded. Rendered templates are checked too.
    const defined = new Set([...(js + checkoutJs).matchAll(/^(?:async )?function ([A-Za-z]+)/gm)].map((m) => m[1]));
    // Globals defined elsewhere that the dashboard legitimately dispatches to.
    for (const g of ['cycleTheme', 'navigateTo']) defined.add(g);
    const referenced = new Set([...(html + js + checkoutJs).matchAll(/data-on-(?:click|submit)="([A-Za-z]+)"/g)].map((m) => m[1]));
    const missing = [...referenced].filter((n) => !defined.has(n));
    assert.deepStrictEqual(missing, [], `handlers referenced but never defined: ${missing.join(', ')}`);
  });

  test('the functions the page switcher and loaders depend on all exist', () => {
    for (const name of ['switchDashboardPage', 'loadDashboardData', 'loadTransactionsList', 'loadWalletsList',
      'loadPayoutsList', 'loadAccountPage', 'loadAPICallsChart', 'switchChartPeriod', 'displayWallets',
      'displayDistribution', 'displayTransactions', 'displayTransactionsList', 'copyToClipboard', 'escapeHtml']) {
      assert.match(js, new RegExp(`^(?:async )?function ${name}\\(`, 'm'), name);
    }
  });

  test('logout is defined once', () => {
    assert.strictEqual((js.match(/^function logout\(\)/gm) || []).length, 1);
  });

  test('the shell is a rail, and the switcher can still find its links', () => {
    assert.ok(!html.includes('<div class="header">'), 'the top bar is gone');
    assert.match(html, /<nav class="rail" id="dashRail"/);
    // switchDashboardPage matches .nav-link by data-arg; the rail keeps both.
    const links = html.match(/<a class="nav-link[^"]*" data-on-click="switchDashboardPage" data-arg="[a-zA-Z]+"/g) || [];
    assert.strictEqual(links.length, 9, 'nine page links: overview, four under Money, three under Build, account');
    assert.match(js, /setAttribute\('aria-current', 'page'\)/, 'active state is also announced');
    assert.match(css, /\.rail \.nav-link\.active,\s*\.rail \.nav-link\[aria-current="page"\]/, 'both select the same rule');
  });

  test('the theme button keeps the hooks tokens.css and syncThemeButton need', () => {
    assert.match(html, /<button class="theme-toggle rail__icon" id="themeToggle"/);
    for (const icon of ['sun', 'moon', 'auto']) assert.ok(html.includes(`theme-icon--${icon}`), icon);
    // it sits at the top of the rail beside the brand, not in the foot; the
    // foot is the signed-in name and the sign-out only
    const top = html.slice(html.indexOf('<div class="rail__top">'), html.indexOf('id="dashNavToggle"'));
    assert.ok(top.includes('class="rail__brand"') && top.includes('id="themeToggle"'));
    const foot = html.slice(html.indexOf('<div class="rail__foot">'), html.indexOf('</nav>'));
    assert.ok(!foot.includes('themeToggle') && foot.includes('data-on-click="logout"') && foot.includes('id="username"'));
    assert.ok(!html.includes('rail__tools'));
    assert.match(css, /\.rail__top \{[^}]*justify-content: space-between;/);
    assert.match(css, /\.rail__avatar \{[^}]*background: var\(--ink\);[^}]*color: var\(--surface\);/, 'the avatar in ink, as the account page draws it');
    // A display value on the icon container would show all three at once.
    const rule = css.slice(css.indexOf('.rail__icon svg, .rail__icon [data-icon] {'), css.indexOf('}', css.indexOf('.rail__icon svg, .rail__icon [data-icon] {')));
    assert.ok(!/display:/.test(rule), 'the icon rule sizes only');
  });

  test('the rail collapses to icons, then to a strip', () => {
    assert.match(css, /@media \(max-width: 1100px\)[\s\S]*?\.rail \.nav-link span \{ display: none; \}/);
    assert.match(css, /@media \(max-width: 860px\)[\s\S]*?\.rail__links\.open \{ display: flex; \}/);
    assert.match(html, /id="dashNavToggle"[^>]*aria-controls="dashNavLinks"/);
  });

  test('transactions is a real table with a filter, not a card of divs', () => {
    const page = html.slice(html.indexOf('id="transactionsPage"'), html.indexOf('<!-- Wallets Page -->'));
    assert.ok(!page.includes('class="card"'));
    assert.match(page, /<table class="dash-table" id="txTable">/);
    assert.strictEqual((page.match(/<th scope="col"/g) || []).length, 7);
    assert.match(page, /<tbody id="allTransactionsList">/);
    for (const id of ['txSearch', 'txChips', 'txCount']) assert.ok(page.includes(`id="${id}"`), id);
    assert.strictEqual((page.match(/data-filter="/g) || []).length, 5);
  });

  test('the transaction renderer escapes every API value and links hashes to the explorer', () => {
    const fn = js.slice(js.indexOf('function displayTransactionsList('), js.indexOf('function wireTransactionRows'));
    for (const field of ['chainInfo.name || tx.chain', 'hashFull.slice(0, 6)', 'token ? Number(tx.nativeAmount).toFixed(2) : formatBalance(tx.nativeAmount)', 'tx.failureReason', 'String(tx.blockNumber)', 'tx.asset']) {
      assert.ok(fn.includes(`escapeHtml(${field}`), `${field} is escaped`);
    }
    assert.match(fn, /chainInfo\.explorerTx/, 'hash links use the explorer the chains API provides');
    assert.match(fn, /rel="noopener"/);
    assert.ok(!/<div style="padding: 24px/.test(js.slice(js.indexOf('async function loadTransactionsList'), js.indexOf('* One wallet row'))),
      'no inline-styled empty states in the transactions loader');
  });

  test('a row is keyboard-operable and opens its detail in place', () => {
    const fn = js.slice(js.indexOf('function displayTransactionsList('), js.indexOf('function wireTransactionRows'));
    assert.match(fn, /<tr class="row" tabindex="0" aria-expanded="false" aria-controls="\$\{detailId\}">/);
    const wire = js.slice(js.indexOf('function wireTransactionRows'), js.indexOf('})();', js.indexOf('function wireTransactionRows')));
    assert.match(wire, /event\.key !== 'Enter' && event\.key !== ' '/);
    assert.match(css, /\.dash-table tr\.detail\.open \.detail__wrap \{ grid-template-rows: 1fr; \}/);
  });

  test('the overview draws wallets as tiles that share hairlines, refreshed in place', () => {
    assert.match(html, /<div class="wgrid-host" id="walletsContainer">/);
    assert.match(html, /data-on-click="switchDashboardPage" data-arg="wallets">All wallets &rarr;<\/a>/, 'the section head goes to the tab');
    const tile = js.slice(js.indexOf('function renderWalletTile'), js.indexOf('function syncWalletTiles'));
    assert.ok(tile.includes('<button type="button" class="wtile" data-on-click="openWalletFromOverview" data-arg="${w.id}" data-wallet-id="${w.id}"'), 'a tile is a button that hands off');
    assert.ok(tile.includes('${chainLogo(w.chain, escapeHtml(symbol))}'));
    assert.ok(tile.includes("class=\"wtile__dot${w.isProcessing ? ' wtile__dot--busy' : ''}\""), 'state is the dot');
    assert.ok(!tile.includes('data-on-click="renameWallet"') && !tile.includes('data-on-click="deleteWallet"'), 'no actions on a tile');
    const draw = js.slice(js.indexOf('function displayWallets'), js.indexOf('* Where the balance sits'));
    assert.ok(draw.includes('if (syncWalletTiles(container, wallets)) {'), 'a refresh writes into the tiles that are there');
    assert.ok(draw.includes('wallets.map(renderWalletTile).join(\'\')'));
    assert.ok(draw.includes('class="wtile wtile--add" data-on-click="openCreateWalletModal"'), 'the last tile adds one');
    assert.ok(!draw.includes('renderWalletCard'), 'the full rows live on the Wallets tab');
    // the hand-off clears any filter that could hide the row, then opens it
    const go = js.slice(js.indexOf('function openWalletFromOverview'), js.indexOf('function displayWallets'));
    assert.ok(go.includes("walletChainFilter = '';") && go.includes("switchDashboardPage('wallets');"));
    assert.ok(go.includes("if (!row.classList.contains('is-open')) toggleWalletDetails(row);"));
    // the grid's line is its gap, and the tile unsets the button rule to be a grid
    assert.match(css, /\.wgrid \{[^}]*gap: 1px;[^}]*background: var\(--line\);/);
    assert.match(css, /\.wtile \{\s*all: unset;/);
    // the Wallets tab's rows are refreshed in place too, unless a rename is open
    assert.ok(js.includes("if (!list.querySelector('form.wallet-rename') && syncWalletRows(list, wallets)) {"));
    const sync = js.slice(js.indexOf('function syncWalletRows'), js.indexOf('function renderWalletTile'));
    assert.ok(sync.includes("if (name && !name.querySelector('form')) {"), 'a name being edited is left alone');
    assert.ok(sync.includes('if (again && drawn) again.innerHTML = drawn;'), "an open row's QR is kept, not fetched again");
  });

  test('narrow screens lose table columns, not gain a sideways scroll', () => {
    const c = css.replace(/\r\n/g, '\n');
    const start760 = c.indexOf('@media (max-width: 760px) {\n    .dash-table th:nth-child(4)');
    assert.ok(start760 !== -1, 'the 760px table rule');
    const at760 = c.slice(start760, c.indexOf('@media (max-width: 480px)', start760));
    assert.ok(at760.includes('#payoutTable th:nth-child(3), #payoutTable td:nth-child(3) { display: none; }'), 'payouts drop gross too');
    const start480 = c.indexOf('@media (max-width: 480px) {\n    /* the type is said');
    assert.ok(start480 !== -1, 'the 480px table rule');
    const at480 = c.slice(start480, c.indexOf('@media (max-width: 860px)', start480));
    assert.ok(at480.includes('#txTable th:nth-child(2), #txTable td:nth-child(2)'), 'transactions drop the type column on a phone');
    assert.ok(at480.includes('.dash-table .detail dl { grid-template-columns: 1fr; }'), 'a row\'s details stack');
    assert.match(css, /@media \(max-width: 860px\) \{\s*\.dash-filter \{ position: sticky; top: 0; \}/, 'the filter pins to the top of the scrolling column, under the strip');
    assert.match(css, /\.dash-head__actions \{[^}]*flex-wrap: wrap;/, 'two head buttons can wrap on a phone');
    assert.match(css, /\.dist__seg:first-child:hover::after \{ left: 0; transform: none; \}/);
    assert.match(css, /\.dist__seg:last-child:hover::after \{ left: auto; right: 0; transform: none; \}/);
    assert.match(css, /\.api-code pre \{[^}]*padding-right: 84px;/, 'the curl clears the Copy button');
    // every page declares a viewport
    for (const file of fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'))) {
      assert.ok(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf-8').includes('name="viewport"'), file);
    }
  });

  test('the search fields keep room for their magnifying glass', () => {
    // The global input rule was a chain of :not()s - specificity (0,5,1) -
    // and outranked .dash-search input (0,1,1), so the 33px left padding for
    // the glass never applied and the glass sat on the text in every filter.
    assert.match(css, /^input:where\(:not\(\[type="checkbox"\]\)/m, 'the global rule is wrapped in :where()');
    assert.ok(!/^input:not\(\[type="checkbox"\]\)/m.test(css), 'and not left as a :not() chain');
    const search = css.slice(css.indexOf('\n.dash-search input {'), css.indexOf('}', css.indexOf('\n.dash-search input {')));
    assert.ok(search.includes('padding: 9px 12px 9px 33px;'));
    const glass = css.slice(css.indexOf('\n.dash-search svg {'), css.indexOf('}', css.indexOf('\n.dash-search svg {')));
    assert.ok(glass.includes('left: 11px;') && glass.includes('width: 14px;'), 'the glass sits inside that padding');
    // every filter's search is the same block: transactions, wallets, payment links
    assert.strictEqual((html.match(/<div class="dash-search">/g) || []).length, 3);
  });

  test('the bar is not redrawn on a refresh unless something moved by more than a tenth', () => {
    // Every wallet refresh (ten seconds) used to replace the bar's markup,
    // which replayed its entrance and killed any tip being read.
    const changed = js.slice(js.indexOf('function distributionChanged'), js.indexOf('function displayDistribution'));
    assert.ok(changed.includes('if (!distDrawn) return true;'), 'first draw');
    assert.ok(changed.includes('before.some((chain, i) => chain !== after[i])'), 'a chain arriving, leaving or reordering');
    assert.ok(changed.includes('Math.abs(v.usd - was) / Math.max(was, 0.01) > 0.10'), 'more than a tenth on any chain');
    const draw = js.slice(js.indexOf('function displayDistribution'), js.indexOf('function calculateTotalBalance'));
    assert.ok(draw.includes('if (!distributionChanged(funded)) {'));
    assert.ok(draw.includes('seg.style.flex = share.toFixed(3);'), 'otherwise the figures are written into the segments that are there');
    assert.ok(draw.includes('distDrawn = Object.fromEntries('));
    assert.match(css, /\.dist__seg \{[^}]*transition: flex-grow var\(--dur-slow\)/, 'a small move glides');
  });

  test('the segment tips can be seen, and the readiness line does not blink', () => {
    // overflow:hidden on the bar or a segment clips a segment's ::after tip
    const bar = css.slice(css.indexOf('\n.dist__bar {'), css.indexOf('}', css.indexOf('\n.dist__bar {')));
    const seg = css.slice(css.indexOf('\n.dist__seg {'), css.indexOf('}', css.indexOf('\n.dist__seg {')));
    assert.ok(!bar.includes('overflow') && !seg.includes('overflow'), 'nothing above the tip clips it');
    assert.match(css, /\.dist__seg > span \{ overflow: hidden;/, 'the label clips on its own');
    assert.match(css, /\.dist__seg:first-child \{ border-radius:/, 'the corners moved to the end segments');
    // the readiness line writes the DOM only when its state changed
    const status = js.slice(js.indexOf('function updateWithdrawalStatus'), js.indexOf('let allPayouts'));
    assert.ok(status.includes('if (statusEl.dataset.state === key) return;'));
    assert.ok(status.includes("tooltip.style.display = want.tip ? 'block' : 'none';"));
    // and its tip is not stretched between two anchors by the older rule
    const tip = css.slice(css.indexOf('#withdrawalStatus .info-tooltip {'), css.indexOf('}', css.indexOf('#withdrawalStatus .info-tooltip {')));
    assert.ok(tip.includes('bottom: auto;') && tip.includes('right: auto;') && tip.includes('margin: 0;'));
    // its arrow points at the badge: the badge's centre is measured and the
    // arrow sits under it, and the tip is never narrower than that spot
    const arrow = css.slice(css.indexOf('#withdrawalStatus .info-tooltip::after {'), css.indexOf('}', css.indexOf('#withdrawalStatus .info-tooltip::after {')));
    assert.ok(arrow.includes('left: var(--arrow-x, 14px);') && arrow.includes('transform: translateX(-50%);'));
    assert.ok(tip.includes('min-width: calc(var(--arrow-x, 14px) + 24px);'));
    const place = js.slice(js.indexOf('function placeStatusArrow'), js.indexOf('let allPayouts'));
    assert.ok(place.includes('badge.offsetLeft + badge.offsetWidth / 2'));
    assert.ok(place.includes("tooltip.style.setProperty('--arrow-x'"));
    assert.ok(status.includes("statusEl.addEventListener('mouseenter', placeStatusArrow);"), 'measured again as the pointer comes in');
  });

  test('the overview has its distribution bar and activity rail wired', () => {
    assert.match(html, /<div class="dist" id="distribution"/);
    assert.match(html, /id="activityRail"/);
    assert.match(html, /<b id="pendingCount">/);
    assert.match(js, /getElementById\('activityRail'\)/, 'displayTransactions renders the rail');
    assert.ok(!js.includes("getElementById('transactionsList')"), 'the dead target is gone');
    // the bar is drawn on the empty branch too, or it sits on "Loading"
    const empty = js.slice(js.indexOf('if (wallets.length === 0) {'), js.indexOf('return;', js.indexOf('if (wallets.length === 0) {')));
    assert.ok(empty.includes('displayDistribution()'));
  });
});

describe('Dashboard wallets and payouts', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');

  test('no dashboard renderer writes an inline-styled empty state any more', () => {
    assert.ok(!js.includes('padding: 24px; text-align: center'), 'the last inline empty state is gone');
    assert.ok(!html.includes('style="padding: 24px'));
  });

  test('wallet deletion goes through the themed dialog, not a second overlay', () => {
    // confirmDialog() existed the whole time; the wallet page carried its own
    // absolutely positioned overlay, a window.pendingDeleteWallet global and
    // two extra handlers instead of using it.
    assert.ok(!html.includes('deleteConfirmationOverlay'));
    assert.ok(!js.includes('pendingDeleteWallet'));
    assert.ok(!/function (confirm|deny)DeleteWallet/.test(js));
    const fn = js.slice(js.indexOf('async function deleteWallet('), js.indexOf('\n}\n', js.indexOf('async function deleteWallet(')));
    assert.match(fn, /await confirmDialog\(\{/);
    assert.match(fn, /danger: true/);
    assert.match(fn, /if \(!ok\) return;/, 'a cancelled dialog does nothing');
  });

  test('the wallet row escapes the address wherever it lands in an attribute', () => {
    const fn = js.slice(js.indexOf('function renderWalletCard('), js.indexOf('\n}\n', js.indexOf('function renderWalletCard(')));
    assert.ok(!/title="\$\{w\.address\}"/.test(fn), 'unescaped address in title');
    assert.ok(!/data-arg="\$\{w\.address\}"/.test(fn), 'unescaped address in data-arg');
    assert.match(fn, /data-arg="\$\{escapeHtml\(w\.address\)\}"/);
    assert.match(fn, /status-pill status-pill--(verifying|confirmed)/, 'state is the shared pill');
  });

  test('the wallets page is a head, a filter and a rail', () => {
    const page = html.slice(html.indexOf('id="walletsPage"'), html.indexOf('<!-- Payouts Page -->'));
    assert.ok(!page.includes('class="card"'));
    assert.match(page, /<header class="dash-head">/);
    assert.match(page, /id="walletSearch"[^>]*data-on-input="filterWallets"/);
    assert.match(page, /<div class="dash-rail" id="allWalletsList"><\/div>/);
    assert.match(js, /getElementById\('walletsPageCount'\)/);
  });

  test('payouts is the transactions table pattern with its own columns', () => {
    const page = html.slice(html.indexOf('id="payoutsPage"'), html.indexOf('<!-- Withdrawal Page -->'));
    assert.ok(!page.includes('class="card"'));
    assert.match(page, /<table class="dash-table" id="payoutTable">/);
    assert.strictEqual((page.match(/<th scope="col"/g) || []).length, 8);
    for (const col of ['Gross', 'Fee', 'Gas', 'Net', 'Paid in']) assert.ok(page.includes(`>${col}</th>`), col);
    assert.match(page, /<tbody id="allPayoutsList">/);
  });

  test('the payout fee rate is derived from the figures, not asserted', () => {
    // "Service Fee (5%)" was hardcoded. PLATFORM_FEE_RATE is configuration.
    assert.ok(!js.includes('Service Fee (5%)'));
    const fn = js.slice(js.indexOf('function displayPayoutsList('), js.indexOf('\n}\n', js.indexOf('function displayPayoutsList(')));
    assert.match(fn, /\(fee \/ gross\) \* 100/);
    for (const field of ['payout.payoutAsset || chainSymbol(payout.payoutChain || payout.chain)', 'String(payout.id || \'\')', 'legAmount(t)']) {
      assert.ok(fn.includes(`escapeHtml(${field}`), `${field} is escaped`);
    }
    assert.match(fn, /DIRECT_TRANSFER' \? 'Direct' : 'Swapped'/, 'the route is named');
    assert.ok(fn.includes("t.route === 'dex' ? 'On-chain swap'"), 'and an on-chain swap by its own name');
  });

  test('every rewrite kept every function: the page still has what its handlers call', () => {
    // A second guard beside the data-on-click one: the loaders and renderers
    // the switcher wires up by name.
    for (const name of ['displayPayoutsList', 'applyPayoutFilter', 'loadPayoutsList', 'renderWalletCard', 'filterWallets',
      'loadWalletsList', 'deleteWallet', 'renameWallet', 'saveWalletLabel', 'loadAPIKeys', 'loadAccountPage', 'submitWithdrawal',
      'createNewWallet', 'switchDashboardPage', 'loadAPICallsChart', 'confirmDialog', 'showToast']) {
      assert.match(js, new RegExp(`^(?:async )?function ${name}\\(`, 'm'), name);
    }
  });
});

describe('Dashboard scripts call only functions that exist', () => {
  /**
   * The data-on-click guard covers what the markup dispatches to. This covers
   * what the scripts call among themselves: a dead function was removed with
   * one of its two call sites left behind, and the 10-second refresh threw on
   * every tick from then on - silently taking the activity rail's refresh
   * down with it, because the throw came before loadTransactions().
   */
  test('every load*/display*/render* call site resolves to a definition', () => {
    const files = ['js/dashboard.js', 'js/dashboard-checkout.js'].map((f) => fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf-8'));
    const all = files.join('\n');
    const defined = new Set([...all.matchAll(/^(?:async )?function ([A-Za-z]+)/gm)].map((m) => m[1]));
    // (?<![.\w]) so a DOM method like e.stopPropagation() is not mistaken for one of ours
    const called = new Set([...all.matchAll(/(?<![.\w])((?:load|display|render|apply|show|dismiss|start|stop|sync|toggle)[A-Z][A-Za-z]*)\(/g)].map((m) => m[1]));
    // known globals defined elsewhere
    for (const g of ['loadSVGIcons', 'showToast', 'startCheckoutPolling', 'stopCheckoutPolling']) defined.add(g);
    const missing = [...called].filter((n) => !defined.has(n));
    assert.deepStrictEqual(missing, [], `called but never defined: ${missing.join(', ')}`);
  });
});

describe('What the phone pass found', () => {
  /**
   * Each of these was seen in a real browser at 375px, not guessed at. The
   * rule under test is the one that fixed it; the comment says what it looked
   * like, so a future edit that drops the rule knows what comes back.
   */
  const dash = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8').replace(/\r\n/g, '\n');
  const dashJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const checkout = fs.readFileSync(path.join(PUBLIC_DIR, 'css/checkout.css'), 'utf-8').replace(/\r\n/g, '\n');
  const checkoutHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'checkout.html'), 'utf-8');
  const faq = fs.readFileSync(path.join(PUBLIC_DIR, 'css/faq.css'), 'utf-8').replace(/\r\n/g, '\n');
  const apiRef = fs.readFileSync(path.join(PUBLIC_DIR, 'css/api-reference.css'), 'utf-8').replace(/\r\n/g, '\n');
  const BS = String.fromCharCode(92); // a backslash, kept out of the source so no tool rewrites it

  test('the dashboard strip on a phone is its own height, with a menu glyph that draws', () => {
    // With both grid rows auto, a short page's leftover height was split
    // between the strip and the page: a 190px strip with its controls
    // floating mid-band on Transactions.
    const at860 = dash.slice(dash.indexOf('@media (max-width: 860px) {\n    /* The dashboard is the frame'), dash.indexOf('/* ── Distribution bar'));
    assert.ok(at860.includes('grid-template-rows: auto minmax(0, 1fr);'));
    // The global button padding (10px 16px) inside a 36px box left 2px for
    // the hamburger, which drew as a dot.
    const toggle = at860.slice(at860.indexOf('.rail__toggle {'), at860.indexOf('.rail__links {'));
    assert.ok(toggle.includes('padding: 0;'), 'the toggle unsets the button padding');
    // A tap lands on the link's label or glyph, not the link, so the menu
    // stayed open after picking a page.
    const nav = dashJs.slice(dashJs.indexOf('// Dashboard mobile nav toggle'), dashJs.indexOf('function syncThemeButton'));
    assert.ok(nav.includes("if (e.target.closest('.nav-link')) setOpen(false);"), 'closest, not classList.contains');
    // The glyph is three bars that fold into a chevron while the menu is
    // open - the site header's morph - and the toggle carries .open with it.
    const dashHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
    assert.match(dashHtml, /<button class="rail__toggle" id="dashNavToggle"[^>]*>\s*<span class="rail__bars" aria-hidden="true"><i><\/i><i><\/i><i><\/i><\/span>\s*<\/button>/);
    assert.ok(!dashHtml.includes('<line x1="3" y1="6" x2="21" y2="6"/>'), 'the static svg is gone');
    assert.ok(at860.includes('.rail__bars { position: relative; display: block; width: 22px; height: 16px; }'));
    assert.ok(at860.includes('.rail__toggle.open .rail__bars i:nth-child(1) { transform: translate(-4.8px, 7px) rotate(-45deg) scaleX(0.56); }'));
    assert.ok(at860.includes('.rail__toggle.open .rail__bars i:nth-child(2) { opacity: 0; transform: translateX(-4.8px) scaleX(0.56); }'));
    assert.ok(at860.includes('.rail__toggle.open .rail__bars i:nth-child(3) { transform: translate(-4.8px, -7px) rotate(45deg) scaleX(0.56); }'));
    assert.ok(nav.includes("toggle.classList.toggle('open', isOpen);"), 'the toggle carries .open with the menu');
    // The theme and sign-out buttons are the toggle's 36px box, and so is the avatar.
    assert.ok(at860.includes('.rail__icon { width: 36px; height: 36px; border-radius: var(--radius); color: var(--ink); }'));
    assert.ok(at860.includes('.rail__icon svg, .rail__icon [data-icon] { width: 16px; height: 16px; }'));
    assert.ok(at860.includes('.rail__avatar { width: 36px; height: 36px; }'));
  });

  test('on a phone the dashboard is the frame: the strip stays put and the page scrolls inside it', () => {
    // The document scrolled, so the strip scrolled off, the page bounced past
    // its ends, and a sticky filter had to be static. Now the shell is the
    // viewport and the main column is the scroller.
    const at860 = dash.slice(dash.indexOf('@media (max-width: 860px) {\n    /* The dashboard is the frame'), dash.indexOf('/* ── Distribution bar'));
    assert.ok(at860.includes('html, body { height: 100%; overflow: hidden; }'), 'the document does not scroll');
    const shell = at860.slice(at860.indexOf('.dash-shell {'), at860.indexOf('}', at860.indexOf('.dash-shell {')));
    assert.ok(shell.includes('height: 100vh;') && shell.includes('height: 100dvh;') && shell.includes('min-height: 0;'), 'the shell is exactly the viewport, dvh where it exists');
    const col = at860.slice(at860.indexOf('.dash-shell .container {'), at860.indexOf('}', at860.indexOf('.dash-shell .container {')));
    for (const decl of ['min-height: 0;', 'overflow-y: auto;', 'overflow-x: hidden;', 'overscroll-behavior: contain;']) assert.ok(col.includes(decl), decl);
    assert.ok(at860.includes('.rail {\n        position: relative;'), 'the strip no longer needs to be sticky');
    // the column's top padding sits on the page, so a sticky filter pins flush under the strip
    assert.ok(at860.includes('.dash-shell .container { padding: 0 16px 40px; }'));
    assert.ok(at860.includes('.dash-shell .container > .dashboard-page { padding-top: 12px; }'));
    // the menu hangs flush and scrolls on its own if it is taller than the screen
    assert.ok(at860.includes('.rail__links { max-height: calc(100dvh - 70px); overflow-y: auto; }'));
    // a page opens at its top: both scrollers are reset, from one helper
    const js1 = dashJs.replace(/\r\n/g, '\n');
    assert.ok(js1.includes("function scrollPageTop() {\n    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });\n    const main = document.getElementById('dashMain');\n    if (main && main.scrollTop) main.scrollTop = 0;\n}"));
    assert.ok(js1.includes('    // otherwise carry over to this one.\n    scrollPageTop();'), 'the page switch uses it');
    assert.ok(js1.includes('    currentStep = step;\n    scrollPageTop();'), 'so does the withdrawal stepper');
    assert.ok(!js1.includes('window.scrollTo(0, 0);'), 'no stray document-only scroll left');
  });

  test('the "unable to withdraw" note sits in the flow on a phone, not over the head buttons', () => {
    // The old 768px rule made the tip inline, but only its opacity:1
    // !important survived the newer absolute-positioned rule: a raised tip
    // floated over Withdraw and Add wallet permanently, with nothing to hover.
    const inline = dash.slice(dash.indexOf('/* Nothing to hover with on a phone.'), dash.indexOf('/* ── Segmented control'));
    assert.ok(inline.includes('@media (max-width: 768px) {'));
    assert.ok(inline.includes('#withdrawalStatus { flex-wrap: wrap; }'));
    const tip = inline.slice(inline.indexOf('#withdrawalStatus .info-tooltip {'), inline.indexOf('#withdrawalStatus .info-tooltip::after'));
    for (const decl of ['position: static;', 'flex-basis: 100%;', 'background: none;', 'box-shadow: none;', 'opacity: 1;']) assert.ok(tip.includes(decl), decl);
    assert.ok(inline.includes('#withdrawalStatus .info-tooltip::after { display: none; }'), 'no arrow on an inline note');
  });

  test('the withdrawal stepper stays on one row and the empty bar on one line', () => {
    // Stacked, the three steps cost a phone half its first screen; three short
    // labels fit three columns at 375px.
    assert.ok(!dash.includes('.wd-rail { grid-template-columns: 1fr;'), 'the rail is never stacked');
    assert.match(dash, /@media \(max-width: 760px\) \{[^}]*\.wd-rail \{ gap: 8px; \}/);
    // The empty bar's sentence wrapped to two lines and ran past the 34px bar.
    const none = dash.slice(dash.indexOf('.dist__none {'), dash.indexOf('}', dash.indexOf('.dist__none {')));
    assert.ok(none.includes('white-space: nowrap;') && none.includes('text-overflow: ellipsis;'));
    // "just now" broke over two lines in the API log's time column.
    assert.ok(dash.includes('#apiRecentTable td.num { white-space: nowrap; }'));
  });

  test('the customer page keeps the amount line whole and the tiles on the screen', () => {
    // At 30px the copy button fell to a line of its own beside the 44px mark.
    const at520 = checkout.slice(checkout.indexOf('@media (max-width: 520px) {'), checkout.indexOf('}\n}', checkout.indexOf('@media (max-width: 520px) {')));
    assert.ok(at520.includes('.amount { font-size: 28px; gap: 8px; }'));
    assert.ok(at520.includes('.pay-head__mark { width: 36px; height: 36px; margin-top: 24px; }'));
    // The step note wrapped to a line of its own that began with "·".
    assert.ok(at520.includes('.fgroup__title em { flex-basis: 100%; }'));
    assert.ok(at520.includes('.fgroup__title em::before { content: none; }'));
    assert.ok(checkout.includes('.fgroup__title em::before { content: "' + BS + '00b7' + BS + '00a0"; }'), 'the separator is drawn, so it can go');
    assert.ok(!checkoutHtml.includes('<em>&middot; so we can'), 'and not typed into the markup');
    assert.ok(checkout.includes('.amount__usd:not(:empty)::before { content: "' + BS + '00b7' + BS + '00a0"; }'), 'a space that does not collapse after the dot');
    // Twenty dense tiles measured 415px at 375: off both edges of the screen.
    const chain = checkout.slice(checkout.indexOf('.block-chain {'), checkout.indexOf('}', checkout.indexOf('.block-chain {')));
    assert.ok(chain.includes('flex-wrap: wrap;') && chain.includes('row-gap: 8px;'));
    assert.ok(at520.includes('.block-chain--dense .block { width: 13px; height: 13px; border-radius: 3px; }'));
  });

  test('the FAQ filter pins under the sticky header, and API endpoint heads keep their shape', () => {
    // Pinned at 0 the filter slid under the 66px header; the search box
    // vanished as soon as the page scrolled.
    const filter = faq.slice(faq.indexOf('.faq-filter {'), faq.indexOf('}', faq.indexOf('.faq-filter {')));
    assert.ok(filter.includes('position: sticky;') && filter.includes('top: 65px;'));
    // A long path wrapped the auth pill and the chevron onto lines of their
    // own; seven language tabs clipped behind the card's overflow.
    const at768 = apiRef.slice(apiRef.indexOf('@media (max-width: 768px) {\n    /* Two rows'), apiRef.indexOf('/* Anchored sections clear'));
    assert.ok(at768.includes('grid-template-columns: auto minmax(0, 1fr) auto;'));
    assert.ok(at768.includes('.endpoint__chev { grid-row: 1; grid-column: 3; justify-self: end; }'));
    assert.ok(at768.includes('.endpoint__summary { grid-row: 2; grid-column: 1 / 3; white-space: normal; }'));
    assert.ok(at768.includes('.endpoint__head .auth-pill { grid-row: 2; grid-column: 3; justify-self: end; }'));
    assert.ok(at768.includes('.lang-tabs { overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }'));
    assert.ok(at768.includes('.lang-tab { flex: none; }'));
  });
});

describe('Docs, API reference and Help open on their first section', () => {
  /**
   * Each page's Contents rail is lit by a scroll spy whose band sits a way
   * down the viewport. On load nothing had scrolled into that band, so no
   * link was lit until you moved. The first section (or the one the hash
   * names) is lit before the observer says anything, and the observer's own
   * reports only count once the page has loaded and jumped to its hash.
   */
  for (const [file, band] of [['api-reference.js', "'-15% 0px -70% 0px'"], ['docs.js', "'-12% 0px -75% 0px'"], ['help.js', "'-12% 0px -75% 0px'"]]) {
    test(`${file} lights the first section on load`, () => {
      const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js', file), 'utf-8');
      const spy = js.slice(js.indexOf('function scrollSpy()'), js.indexOf('observer.observe', js.indexOf('function scrollSpy()')));
      assert.ok(spy.includes('const named = location.hash && sections.find((s) => `#${s.id}` === location.hash);'), 'the hash names a section');
      assert.ok(/setActive\(\(named \|\| sections\[0\]\)\.id\)/.test(spy), 'else the first');
      assert.ok(spy.indexOf('setActive((named') < spy.indexOf('new IntersectionObserver'), 'lit before the observer exists');
      assert.ok(spy.includes("let armed = document.readyState === 'complete';"));
      assert.ok(spy.includes("window.addEventListener('load', () => { armed = true; }, { once: true });"));
      assert.ok(spy.includes('if (!armed) return;'), 'reports before load are ignored');
      assert.ok(spy.includes(`rootMargin: ${band}`), 'the band itself is unchanged');
    });
  }
});

describe('The chain count on every page is the registry\'s', () => {
  const registry = require('../src/config/chains');
  const N = registry.CODES.length;
  test('landing, about, docs, help and the API reference all state the same number', () => {
    const index = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
    const about = fs.readFileSync(path.join(PUBLIC_DIR, 'about.html'), 'utf-8');
    const docs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/docs-content.js'), 'utf-8');
    const spec = fs.readFileSync(path.join(PUBLIC_DIR, 'js/api-spec.js'), 'utf-8');
    assert.ok(index.includes(`<span class="live-line__item"><b>${N}</b> networks</span>`), 'landing live line');
    assert.ok(index.includes(`across ${N} networks`), 'landing hero');
    assert.ok(index.includes(`<i>USDC</i><i>USDT</i>`), 'the chips name the dollar tokens');
    assert.ok(index.includes(`>+${N - 10} chains</i>`), 'and count the rest');
    assert.ok(about.includes(`<b>${N}</b><span>Networks, one integration</span>`), 'about strip');
    assert.ok(docs.includes(`across ${N} chains`), 'docs lead');
    assert.ok(spec.includes(`accept payments in ${N} chains`), 'API overview');
    // the two tables carry one row per chain, in registry order
    const docsRows = [...docs.matchAll(/^\s+\['[^']+', '([A-Z]+)', '[A-Z]+', '[^']*', '[^']*', '[^']*'\],$/gm)].map((m) => m[1]);
    assert.deepStrictEqual(docsRows, registry.CODES, 'docs chain table');
    const specRows = [...spec.matchAll(/^\s+\['([A-Z]+)', '[A-Z]+', '(?:EVM|UTXO|Solana|XRP Ledger)', '\d+', '[^']*', '(?:yes|no)', '[^']*', '[^']*'\],$/gm)].map((m) => m[1]);
    assert.deepStrictEqual(specRows, registry.CODES, 'API reference chain table');
    for (const file of ['index.html', 'about.html', 'js/docs-content.js', 'js/help-content.js', 'js/api-spec.js']) {
      const text = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf-8');
      assert.ok(!/\bten (chains|networks|blockchain)/i.test(text), `${file} has no stale ten-chain copy`);
    }
  });
});

describe('Dollar tokens on the pages', () => {
  /**
   * A wallet on an EVM chain holds the chain's coin and its dollar tokens; a
   * link on it can be paid in any of them, and the customer picks. These pin
   * what each page does with that - drawn in mockup 14 before it was built.
   */
  const dashJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard.js'), 'utf-8');
  const dashCss = fs.readFileSync(path.join(PUBLIC_DIR, 'css/dashboard.css'), 'utf-8');
  const linkJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/dashboard-checkout.js'), 'utf-8');
  const payHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'checkout.html'), 'utf-8');
  const payJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/checkout.js'), 'utf-8');
  const payCss = fs.readFileSync(path.join(PUBLIC_DIR, 'css/checkout.css'), 'utf-8');
  const walletJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js/checkout-wallet.js'), 'utf-8');

  test('the wallet row, the open row and the tile show the tokens beside the coin, only when there are any', () => {
    const line = dashJs.slice(dashJs.indexOf('function renderTokenLine'), dashJs.indexOf('function renderWalletTile'));
    assert.ok(line.includes("if (held.length === 0) return '';"), 'nothing for a wallet without tokens');
    assert.ok(line.includes('Number(t.balance).toFixed(2)'), 'a dollar token shows two decimals');
    const row = dashJs.slice(dashJs.indexOf('function renderWalletCard'), dashJs.indexOf('function renderWalletDetails'));
    assert.ok(row.includes('${renderTokenLine(w)}'), 'under the coin figure on the row');
    const detail = dashJs.slice(dashJs.indexOf('function renderWalletDetails'), dashJs.indexOf('async function loadWalletQr'));
    assert.ok(detail.includes('held · token payouts are next'), 'the open row is honest that a token cannot move yet');
    const tile = dashJs.slice(dashJs.indexOf('function renderWalletTile'), dashJs.indexOf('function syncWalletTiles'));
    assert.ok(tile.includes('${tileToksHtml(w)}') && tile.includes("${tokensUSD > 0 ? ' total' : ''}"), 'the tile totals them and names them');
    assert.match(dashCss, /\.wtile__toks \{ grid-column: 2 \/ 4; grid-row: 3;/, 'on a row of their own, so the name keeps its room');
    // the sync paths carry the line too
    assert.ok(dashJs.includes("const toks = balBox && balBox.querySelector('.toks');"));
    assert.ok(dashJs.includes("const toks = tile.querySelector('.wtile__toks');"));
  });

  test('the overview counts the tokens, and so does what can be withdrawn', () => {
    const total = dashJs.slice(dashJs.indexOf('function calculateTotalBalance'), dashJs.indexOf('function updateWithdrawalStatus'));
    assert.ok(total.includes('const held = (Number(w.balanceUSD) || 0) + walletTokensUSD(w);'));
    assert.ok(total.includes('if (!w.isProcessing) availableUSD += held;'), 'a token is withdrawable like the coin; only a busy wallet is not');
    assert.ok(total.includes("document.getElementById('availableBalance').textContent = `$${availableUSD.toFixed(2)}`;"));
    const head = dashJs.slice(dashJs.indexOf('function updateWithdrawalAvailable'), dashJs.indexOf('function loadWithdrawalPage'));
    assert.ok(head.includes('const holdings = (w) => (w.balanceUSD || 0) + walletTokensUSD(w);'), 'the withdrawal head counts them too');
    const dist = dashJs.slice(dashJs.indexOf('function displayDistribution'), dashJs.indexOf('function calculateTotalBalance'));
    assert.ok(dist.includes('const usd = (Number(w.balanceUSD) || 0) + walletTokensUSD(w);'), 'the bar agrees with the big number');
    assert.ok(dist.includes('in dollar tokens'), 'and its tip says so');
  });

  test('a token receipt in the list names the token', () => {
    const list = dashJs.slice(dashJs.indexOf('function displayTransactionsList('), dashJs.indexOf('function wireTransactionRows'));
    assert.ok(list.includes("const token = tx.asset && tx.asset !== chainSymbol(tx.chain) ? escapeHtml(tx.asset) : '';"));
    assert.ok(list.includes('<small class="asset-tag">'), 'a tag by the chain name');
    assert.match(dashCss, /\.dash-table \.chain \.asset-tag \{/);
    const rail = dashJs.slice(dashJs.indexOf('function displayTransactions('), dashJs.indexOf('function relativeTime'));
    assert.ok(rail.includes('const symbol = token || escapeHtml(chainSymbol(tx.chain));'), 'the activity rail too');
  });

  test('the create-link form has nothing to choose: the hint and the quote say what the wallet takes', () => {
    assert.ok(linkJs.includes('their choice on the payment page. It settles here.'));
    assert.ok(!linkJs.includes('name="checkoutAsset"'), 'no asset control for the merchant');
    const quote = linkJs.slice(linkJs.indexOf('function drawCheckoutQuote'), linkJs.indexOf('function startCheckoutQuote'));
    assert.ok(quote.includes("` \\u00b7 or <b>${esc(Number(dollars).toFixed(2))}</b> in ${tokens.map(esc).join(' or ')}`"), 'the dollar figure for the tokens');
    const rows = linkJs.slice(linkJs.indexOf('function amountRows'), linkJs.indexOf('function showCheckoutResult'));
    assert.ok(rows.includes('the customer picks'), 'the ready panel lists the ways');
    assert.ok(rows.includes('stablecoins at par') && rows.includes('<span>Tokens</span>'), 'and the contracts');
  });

  test('the customer picks on the page: one tile per asset, the address in the same step', () => {
    assert.ok(payHtml.includes('<div id="asset-pick" class="hidden">'), 'hidden until the session says the link can be paid more than one way');
    assert.ok(payHtml.includes('<div class="pick" id="asset-pick-tiles" role="radiogroup"'));
    assert.ok(payHtml.indexOf('id="asset-pick"') < payHtml.indexOf('id="manual-address-section"'), 'the pick comes first');
    assert.ok(payHtml.includes('<div id="token-row" class="hidden">'), 'the token is named by its contract');
    const pick = payJs.slice(payJs.indexOf('function renderAssetPick'), payJs.indexOf('function coinGlyph'));
    assert.ok(pick.includes("if (tokenAssets().length === 0 || !sessionData.usdAmount) { box.classList.add('hidden'); return; }"), 'none on a coin-only chain');
    assert.ok(pick.includes("button.setAttribute('role', 'radio');"));
    assert.ok(payJs.includes("body: JSON.stringify({ sessionId, clientWalletAddress: addr, asset: currentAsset() }),"), 'the pick travels with the address');
    assert.ok(walletJs.includes('body: JSON.stringify({ sessionId, clientWalletAddress: account, asset }),'), 'and with a connected wallet');
    const head = payJs.slice(payJs.indexOf('function renderHead'), payJs.indexOf('function appendSwitchLink'));
    assert.ok(head.includes('value.textContent = `$${Number(sessionData.usdAmount).toFixed(2)}`;'), 'before the pick the head is the price');
    assert.ok(head.includes('<span class="tok">'), 'a token wears its badge on the mark');
    assert.ok(payJs.includes("railFirst.textContent = tokenAssets().length > 0 ? 'How you\\u2019ll pay' : 'Your address';"));
    assert.match(payCss, /\.pick button\[aria-checked="true"\] \{ border-color: var\(--ink\);/);
  });

  test('the send step names the token, warns about the coin, and can switch until something is seen', () => {
    const facts = payJs.slice(payJs.indexOf('function populateWatchingStep'), payJs.indexOf('window.copyTokenContract'));
    assert.ok(facts.includes("document.getElementById('watch-chain').textContent  = asset;"));
    assert.ok(facts.includes('Send ${asset}, not ${chainSymbol()}. If you send the coin instead, the link still settles once'));
    const link = payJs.slice(payJs.indexOf('function appendSwitchLink'), payJs.indexOf('function renderAssetPick'));
    assert.ok(link.includes("if (detected || sessionData.status !== 'AWAITING_PAYMENT') return;"), 'not once a payment is on the chain');
    assert.ok(payJs.includes("fetch('/api/checkout/pick-asset'"), 'the switch asks the server for the new QR');
    assert.ok(payJs.includes("if (data.pendingAsset) { sessionData.asset = data.pendingAsset; pickedAsset = data.pendingAsset; }"), 'what arrived is what the page shows');
    assert.ok(payJs.includes('const asset = data.paidAsset || currentAsset();'), 'the paid screen names the asset that arrived');
  });

  test('a connected wallet pays a token with a plain transfer on the token contract', () => {
    assert.ok(walletJs.includes("return `0xa9059cbb${address}${units}`;"), 'transfer(address,uint256)');
    assert.ok(walletJs.includes("? { from: state.account, to: pay.token.contract, value: '0x0', data: transferData(to, pay.amount, pay.token.decimals) }"));
    assert.ok(walletJs.includes(': { from: state.account, to, value: toWeiHex(pay.amount, state.chainInfo.decimals) }'), 'the coin as before');
    assert.ok(walletJs.includes('if (amount) amount.textContent = paying().label;'), 'the button names the asset and figure');
  });
});

describe('The previews on the rail', () => {
  test('each row carries its own screen, folded shut; the scroll opens the row being read', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf-8').replace(/\r\n/g, '\n');
    const js = fs.readFileSync(path.join(__dirname, '../public/js/settle-preview.js'), 'utf-8').replace(/\r\n/g, '\n');
    const css = fs.readFileSync(path.join(__dirname, '../public/css/index.css'), 'utf-8').replace(/\r\n/g, '\n');
    const delays = { networks: 210, confirmation: 300, routing: 390 };
    for (const name of ['networks', 'confirmation', 'routing']) {
      const row = html.indexOf(`class="settle-rail__row" data-reveal data-reveal-delay="${delays[name]}" data-preview="${name}"`);
      assert.ok(row > 0, `${name} row names its preview`);
      // the preview sits inside the row, after its text, before the next row
      const preview = html.indexOf('<div class="settle-preview" aria-hidden="true">', row);
      const panel = html.indexOf(`<div class="settle-preview__panel" data-preview="${name}">`, row);
      const next = html.indexOf('class="settle-rail__row"', row + 1);
      assert.ok(preview > row && panel > preview && (next === -1 || panel < next), `${name} preview is in its row`);
    }
    assert.strictEqual((html.match(/class="settle-preview" aria-hidden="true"/g) || []).length, 3);
    assert.strictEqual((html.match(/class="settle-preview__panel"/g) || []).length, 3);
    assert.ok(!html.includes('id="settlePreview"'), 'no stage under the coin');
    assert.ok(html.includes('<script src="/js/settle-preview.js"></script>'));
    assert.ok(!/on(click|mouseenter|scroll)=/.test(html), 'no inline handlers');
    // the scroll is the control: the last row past a line above the middle, nothing on hover or tap
    assert.ok(js.includes('window.innerHeight * 0.45'));
    assert.ok(js.includes("window.addEventListener('scroll', onScroll, { passive: true })"));
    assert.ok(!/pointerenter|mouseenter|'click'/.test(js), 'no hover, no tap');
    assert.ok(js.includes("previous.classList.add('is-folding')") && js.includes('scrollNow(after - before)'), 'the fold is instant and the scroll follows it');
    assert.ok(js.includes("root.style.scrollBehavior = 'auto'"), 'that one move is not smoothed');
    assert.ok(js.includes("pill.textContent = 'Paid'"));
    assert.ok(js.includes("matchMedia('(prefers-reduced-motion: reduce)')"));
    // the styles: an accordion on grid rows; the frame is the receipt's family; the open row takes the ink; motion is opt-in
    assert.ok(css.includes('.settle-preview {') && css.includes('grid-template-rows: 0fr;'));
    assert.ok(css.includes('.settle-rail__row.is-active .settle-preview { grid-template-rows: 1fr;'));
    assert.ok(css.includes('.settle-rail__row.is-folding .settle-preview { transition: none; }'));
    assert.ok(css.includes('.settle-preview__frame {') && css.includes('.settle-rail__row.is-active::before { background: var(--ink); }'));
    assert.ok(!css.includes('.settle-rail__row { cursor: pointer; }'), 'rows are not buttons');
    assert.ok(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\.settle-rail__row\.is-active \.sp-tile \{/.test(css));
    assert.ok(css.includes('@keyframes sp-travel'));
    assert.ok(/@media \(max-width: 720px\) \{[\s\S]*?\.settle-preview__frame \{ max-width: none; \}/.test(css), 'the frame fills a phone');
  });
});
