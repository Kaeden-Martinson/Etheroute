/**
 * API reference page.
 *
 * Everything on the page is rendered from window.API_SPEC (api-spec.js):
 * the sidebar, each section, every endpoint card, and the code samples,
 * which are generated from the endpoint's method, path and body so they
 * cannot disagree with the request they describe.
 *
 * Search filters endpoints as you type - by path, method, summary or any
 * field name in the request or response - and the sidebar follows scroll.
 */
(() => {
  const spec = window.API_SPEC;
  if (!spec) return;

  const sidebar = document.getElementById('apiSidebar');
  const main = document.getElementById('apiMain');
  const searchInput = document.getElementById('apiSearch');
  const searchMeta = document.getElementById('apiSearchMeta');
  if (!sidebar || !main) return;

  const origin = window.location.origin;
  const baseUrl = `${origin}${spec.baseUrl}`;

  // ── helpers ──────────────────────────────────────────────────────────────

  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const json = (value) => JSON.stringify(value, null, 2);

  function samplePath(path) {
    // :param -> a readable placeholder
    return path.replace(/:([a-zA-Z]+)/g, (_, name) => `{${name}}`);
  }

  function curlSample(ep) {
    const lines = [`curl -X ${ep.method} "${baseUrl}${samplePath(ep.path)}"`];
    if (ep.auth !== 'public') lines.push('  -H "Authorization: Bearer YOUR_API_KEY"');
    for (const [name, note] of ep.headers || []) lines.push(`  -H "${name}: ${name === 'Idempotency-Key' ? '3f2b1c…' : note}"`);
    if (ep.body) {
      lines.push('  -H "Content-Type: application/json"');
      lines.push(`  -d '${JSON.stringify(ep.body)}'`);
    }
    return lines.join(' \\\n');
  }

  function nodeSample(ep) {
    const headers = [];
    if (ep.auth !== 'public') headers.push("    'Authorization': `Bearer ${process.env.ETHEROUTE_API_KEY}`");
    for (const [name] of ep.headers || []) headers.push(`    '${name}': ${name === 'Idempotency-Key' ? 'crypto.randomUUID()' : "'…'"}`);
    if (ep.body) headers.push("    'Content-Type': 'application/json'");
    const opts = [`  method: '${ep.method}'`];
    if (headers.length) opts.push(`  headers: {\n${headers.join(',\n')}\n  }`);
    if (ep.body) opts.push(`  body: JSON.stringify(${json(ep.body).replace(/\n/g, '\n  ')})`);
    const pre = (ep.headers || []).some(([n]) => n === 'Idempotency-Key') ? "const crypto = require('crypto');\n\n" : '';
    return `${pre}const response = await fetch('${baseUrl}${samplePath(ep.path)}', {\n${opts.join(',\n')}\n});\nconst data = await response.json();\nif (!response.ok) throw new Error(data.message);\nconsole.log(data);`;
  }

  function pythonSample(ep) {
    const headers = [];
    if (ep.auth !== 'public') headers.push("    'Authorization': f'Bearer {API_KEY}'");
    for (const [name] of ep.headers || []) headers.push(`    '${name}': ${name === 'Idempotency-Key' ? 'str(uuid.uuid4())' : "'…'"}`);
    const pre = (ep.headers || []).some(([n]) => n === 'Idempotency-Key') ? 'import uuid\n' : '';
    const kwargs = [];
    if (headers.length) kwargs.push(`    headers={\n${headers.join(',\n')}\n    }`);
    if (ep.body) kwargs.push(`    json=${json(ep.body).replace(/\n/g, '\n    ').replace(/: true/g, ': True').replace(/: false/g, ': False').replace(/: null/g, ': None')}`);
    return `${pre}import requests\n\nresponse = requests.${ep.method.toLowerCase()}(\n    '${baseUrl}${samplePath(ep.path)}',\n${kwargs.join(',\n')}\n)\nresponse.raise_for_status()\nprint(response.json())`;
  }

  // Shared header list for the compiled / other-language samples: [name, value].
  function sampleHeaders(ep) {
    const headers = [];
    if (ep.auth !== 'public') headers.push(['Authorization', 'Bearer YOUR_API_KEY']);
    for (const [name] of ep.headers || []) headers.push([name, name === 'Idempotency-Key' ? '<generate-a-uuid>' : '...']);
    if (ep.body) headers.push(['Content-Type', 'application/json']);
    return headers;
  }

  const NL = String.fromCharCode(10);

  function goSample(ep) {
    const url = baseUrl + samplePath(ep.path);
    const imports = ['"fmt"', '"io"', '"net/http"'];
    if (ep.body) imports.unshift('"strings"');
    const out = ['package main', '', 'import (', ...imports.map((i) => '\t' + i), ')', '', 'func main() {'];
    if (ep.body) out.push('\tbody := strings.NewReader(`' + JSON.stringify(ep.body) + '`)');
    out.push('\treq, _ := http.NewRequest("' + ep.method + '", "' + url + '", ' + (ep.body ? 'body' : 'nil') + ')');
    for (const [name, value] of sampleHeaders(ep)) out.push('\treq.Header.Set("' + name + '", "' + value + '")');
    out.push('\tresp, err := http.DefaultClient.Do(req)', '\tif err != nil {', '\t\tpanic(err)', '\t}', '\tdefer resp.Body.Close()', '\tout, _ := io.ReadAll(resp.Body)', '\tfmt.Println(string(out))', '}');
    return out.join(NL);
  }

  function rubySample(ep) {
    const url = baseUrl + samplePath(ep.path);
    const verb = ep.method[0] + ep.method.slice(1).toLowerCase();
    const out = ["require 'net/http'", "require 'uri'", "require 'json'", '', "uri = URI('" + url + "')", 'req = Net::HTTP::' + verb + '.new(uri)'];
    for (const [name, value] of sampleHeaders(ep)) out.push("req['" + name + "'] = '" + value + "'");
    if (ep.body) out.push('req.body = ' + JSON.stringify(ep.body) + '.to_json');
    out.push("res = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == 'https') do |http|", '  http.request(req)', 'end', 'puts res.body');
    return out.join(NL);
  }

  function cppSample(ep) {
    const url = baseUrl + samplePath(ep.path);
    const out = ['#include <curl/curl.h>', '', 'int main() {', '    CURL* curl = curl_easy_init();', '    struct curl_slist* headers = nullptr;'];
    for (const [name, value] of sampleHeaders(ep)) out.push('    headers = curl_slist_append(headers, "' + name + ': ' + value + '");');
    out.push('    curl_easy_setopt(curl, CURLOPT_URL, "' + url + '");');
    out.push('    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "' + ep.method + '");');
    out.push('    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);');
    if (ep.body) out.push('    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, R"(' + JSON.stringify(ep.body) + ')");');
    out.push('    curl_easy_perform(curl);', '    curl_slist_free_all(headers);', '    curl_easy_cleanup(curl);', '    return 0;', '}');
    return out.join(NL);
  }

  function cSample(ep) {
    const url = baseUrl + samplePath(ep.path);
    const out = ['#include <curl/curl.h>', '', 'int main(void) {', '    CURL *curl = curl_easy_init();', '    struct curl_slist *headers = NULL;'];
    for (const [name, value] of sampleHeaders(ep)) out.push('    headers = curl_slist_append(headers, "' + name + ': ' + value + '");');
    out.push('    curl_easy_setopt(curl, CURLOPT_URL, "' + url + '");');
    out.push('    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "' + ep.method + '");');
    out.push('    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);');
    if (ep.body) out.push('    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, ' + JSON.stringify(JSON.stringify(ep.body)) + ');');
    out.push('    curl_easy_perform(curl);', '    curl_slist_free_all(headers);', '    curl_easy_cleanup(curl);', '    return 0;', '}');
    return out.join(NL);
  }

  const LANGS = [
    { id: 'curl', label: 'cURL', hl: 'bash', make: curlSample },
    { id: 'node', label: 'Node.js', hl: 'javascript', make: nodeSample },
    { id: 'python', label: 'Python', hl: 'python', make: pythonSample },
    { id: 'go', label: 'Go', hl: 'go', make: goSample },
    { id: 'ruby', label: 'Ruby', hl: 'ruby', make: rubySample },
    { id: 'cpp', label: 'C++', hl: 'cpp', make: cppSample },
    { id: 'c', label: 'C', hl: 'c', make: cSample },
  ];

  // ── render ───────────────────────────────────────────────────────────────

  function facts(rows) {
    return `<dl class="facts">${rows.map(([k, v]) => `<div class="facts__row"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  }

  function table(t) {
    return `<div class="table-scroll"><table class="spec-table"><thead><tr>${t.head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function paramTable(rows, cols) {
    return `<div class="table-scroll"><table class="spec-table spec-table--params"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td>${i === 0 ? `<code>${c}</code>` : c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function codeBlock(code, lang, id) {
    return `<div class="code-block" data-code-id="${esc(id)}">
      <div class="code-block__bar"><span class="code-block__lang">${esc(lang)}</span><button type="button" class="code-block__copy" data-on-click="apiCopyCode" data-arg="${esc(id)}">Copy</button></div>
      <pre><code class="language-${esc(lang)}" id="${esc(id)}">${esc(code)}</code></pre>
    </div>`;
  }

  function endpointCard(ep) {
    const authPill = ep.auth === 'public'
      ? '<span class="auth-pill auth-pill--public">Public</span>'
      : (ep.auth === 'developer' ? '<span class="auth-pill auth-pill--dev">Developer</span>' : '<span class="auth-pill">Bearer</span>');

    const samples = LANGS.map((lang, i) => `
      <div class="sample${i === 0 ? '' : ' hidden'}" data-lang="${lang.id}">
        ${codeBlock(lang.make(ep), lang.hl, `${ep.id}-${lang.id}`)}
      </div>`).join('');

    const langTabs = `<div class="lang-tabs" role="tablist">${LANGS.map((lang, i) => `<button type="button" role="tab" class="lang-tab${i === 0 ? ' is-active' : ''}" data-on-click="apiPickLang" data-arg="${ep.id}" data-arg2="${lang.id}">${lang.label}</button>`).join('')}</div>`;

    return `
      <article class="endpoint" id="${esc(ep.id)}" data-search="${esc(searchText(ep))}">
        <button type="button" class="endpoint__head" data-on-click="apiToggleEndpoint" data-arg="${esc(ep.id)}" aria-expanded="false">
          <span class="method method--${ep.method.toLowerCase()}">${ep.method}</span>
          <code class="endpoint__path">${esc(ep.path)}</code>
          <span class="endpoint__summary">${esc(ep.summary)}</span>
          ${authPill}
          <span class="endpoint__chev" aria-hidden="true"></span>
        </button>
        <div class="endpoint__body">
          <div class="endpoint__inner">
            ${ep.description ? `<p class="endpoint__desc">${ep.description}</p>` : ''}
            ${ep.headers ? `<h4>Headers</h4>${paramTable(ep.headers, ['Header', 'Value'])}` : ''}
            ${ep.query ? `<h4>Query parameters</h4>${paramTable(ep.query, ['Parameter', 'Meaning'])}` : ''}
            ${ep.bodyDoc ? `<h4>Request body</h4>${paramTable(ep.bodyDoc, ['Field', 'Type', 'Meaning'])}` : ''}
            <h4>Example request</h4>
            ${langTabs}
            ${samples}
            <h4>Response${ep.status ? ` <span class="status-code">${ep.status}</span>` : ''}</h4>
            ${codeBlock(json(ep.response), 'json', `${ep.id}-response`)}
            ${ep.notes ? `<p class="endpoint__note">${ep.notes}</p>` : ''}
            <a class="endpoint__link" href="#${esc(ep.id)}">Link to this endpoint</a>
          </div>
        </div>
      </article>`;
  }

  function searchText(ep) {
    const keys = (obj) => (obj && typeof obj === 'object' ? Object.keys(Array.isArray(obj) ? obj[0] || {} : obj) : []);
    return [ep.method, ep.path, ep.summary, ep.id, ...keys(ep.body), ...keys(ep.response), ...(ep.bodyDoc || []).map((r) => r[0])].join(' ').toLowerCase();
  }

  function section(s) {
    const parts = [];
    parts.push(`<section class="section" id="${esc(s.id)}" data-reveal>`);
    // Header icons live in the sidebar only, matching the docs and help pages.
    parts.push(`<h2 class="section-title">${esc(s.title)}</h2>`);
    for (const p of s.intro || []) parts.push(`<p class="section-intro">${p}</p>`);
    if (s.facts && s.id !== 'errors') parts.push(facts(s.facts));
    if (s.table) parts.push(table(s.table));
    if (s.events) parts.push(`<h4>Events</h4>${paramTable(s.events, ['Event', 'Sent when'])}`);
    if (s.payload) parts.push(`<h4>${s.id === 'errors' ? 'Error body' : 'Payload'}</h4>${codeBlock(json(s.payload), 'json', `${s.id}-payload`)}`);
    if (s.verify) parts.push(`<h4>Verifying a signature (Node.js)</h4>${codeBlock(s.verify, 'javascript', `${s.id}-verify`)}`);
    if (s.facts && s.id === 'errors') parts.push('<h4>Rate limits</h4>' + facts(s.facts));
    if (s.endpoints) parts.push(`<div class="endpoints">${s.endpoints.map(endpointCard).join('')}</div>`);
    parts.push('</section>');
    return parts.join('');
  }

  function renderSidebar() {
    sidebar.innerHTML = spec.sections.map((s) => `
      <div class="sidebar-section">
        <a href="#${esc(s.id)}" class="sidebar-link" data-section="${esc(s.id)}"><span class="sidebar-icon" data-icon="${esc(s.icon)}"></span>${esc(s.title)}</a>
        ${(s.endpoints || []).map((ep) => `<a href="#${esc(ep.id)}" class="sidebar-sub" data-endpoint="${esc(ep.id)}"><span class="method method--mini method--${ep.method.toLowerCase()}">${ep.method}</span>${esc(ep.path)}</a>`).join('')}
      </div>`).join('');
  }

  function renderMain() {
    main.innerHTML = spec.sections.map(section).join('');
    if (window.loadSVGIcons) window.loadSVGIcons();
    if (window.hljs) main.querySelectorAll('pre code').forEach((el) => window.hljs.highlightElement(el));
  }

  // ── behaviour ────────────────────────────────────────────────────────────

  window.apiToggleEndpoint = (id) => {
    const card = document.getElementById(id);
    if (!card) return;
    const open = !card.classList.contains('is-open');
    card.classList.toggle('is-open', open);
    card.querySelector('.endpoint__head').setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  window.apiPickLang = (epId, langId) => {
    const card = document.getElementById(epId);
    if (!card) return;
    card.querySelectorAll('.lang-tab').forEach((tab) => tab.classList.toggle('is-active', tab.getAttribute('data-arg2') === langId));
    card.querySelectorAll('.sample').forEach((s) => s.classList.toggle('hidden', s.dataset.lang !== langId));
    try { localStorage.setItem('apiLang', langId); } catch { /* ignore */ }
  };

  window.apiCopyCode = async (id) => {
    const code = document.getElementById(id);
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent);
      const button = document.querySelector(`[data-code-id="${CSS.escape(id)}"] .code-block__copy`);
      if (button) { button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1400); }
    } catch { /* clipboard unavailable */ }
  };

  function applyPreferredLang() {
    let lang = null;
    try { lang = localStorage.getItem('apiLang'); } catch { /* ignore */ }
    if (!lang || !LANGS.some((l) => l.id === lang)) return;
    for (const s of spec.sections) for (const ep of s.endpoints || []) window.apiPickLang(ep.id, lang);
  }

  function openFromHash() {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const card = document.getElementById(id);
    if (card && card.classList.contains('endpoint')) {
      card.classList.add('is-open');
      card.querySelector('.endpoint__head').setAttribute('aria-expanded', 'true');
      card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  function search() {
    const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    let shown = 0;
    let total = 0;
    main.querySelectorAll('.endpoint').forEach((card) => {
      total += 1;
      const match = terms.every((t) => card.dataset.search.includes(t));
      card.classList.toggle('hidden', !match);
      if (match) shown += 1;
      // A search hit opens itself so the answer is on screen.
      if (query && match) card.classList.add('is-open');
    });
    main.querySelectorAll('.section').forEach((sec) => {
      const hasCards = sec.querySelector('.endpoint');
      const anyShown = sec.querySelector('.endpoint:not(.hidden)');
      // Prose-only sections hide during a search; sections with no matches too.
      sec.classList.toggle('hidden', Boolean(query) && (!hasCards || !anyShown));
    });
    sidebar.querySelectorAll('.sidebar-sub').forEach((link) => {
      const card = document.getElementById(link.dataset.endpoint);
      link.classList.toggle('hidden', Boolean(card && card.classList.contains('hidden')));
    });
    if (searchMeta) searchMeta.textContent = query ? `${shown} of ${total} endpoints` : '';
  }

  // Scroll the sidebar (and only the sidebar, never the page) so the active
  // link stays visible as you read down the page.
  function keepLinkInView(link) {
    const container = link.closest('.sidebar');
    if (!container || container.scrollHeight <= container.clientHeight) return;
    const c = container.getBoundingClientRect();
    const l = link.getBoundingClientRect();
    const margin = 16;
    if (l.top < c.top + margin) {
      container.scrollTop -= (c.top + margin) - l.top;
    } else if (l.bottom > c.bottom - margin) {
      container.scrollTop += l.bottom - (c.bottom - margin);
    }
  }

  function scrollSpy() {
    const sections = [...main.querySelectorAll('.section:not(.hidden)')];
    const links = [...sidebar.querySelectorAll('.sidebar-link')];
    if (sections.length === 0) return;
    const setActive = (id) => links.forEach((l) => {
      const on = l.dataset.section === id;
      l.classList.toggle('active', on);
      if (on) keepLinkInView(l);
    });
    // The page opens on its first section (or the one the hash names) before
    // anything has scrolled: the observer's band sits a way down the viewport,
    // so on load nothing was in it and no link was lit.
    const named = location.hash && sections.find((s) => `#${s.id}` === location.hash);
    setActive((named || sections[0]).id);
    if (!('IntersectionObserver' in window)) return;
    // The observer's first report can arrive before the browser has jumped to
    // the hash, with the page still at the top; it would light the first
    // section over the named one. Reports count once the page has loaded.
    let armed = document.readyState === 'complete';
    if (!armed) window.addEventListener('load', () => { armed = true; }, { once: true });
    const observer = new IntersectionObserver((entries) => {
      if (!armed) return;
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActive(visible.target.id);
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
    sections.forEach((s) => observer.observe(s));
  }

  // "/" focuses search from anywhere on the page.
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && searchInput && document.activeElement !== searchInput && !/input|textarea/i.test(document.activeElement.tagName)) {
      event.preventDefault();
      searchInput.focus();
    }
    if (event.key === 'Escape' && document.activeElement === searchInput) {
      searchInput.value = '';
      search();
      searchInput.blur();
    }
  });

  window.apiToggleSidebar = () => {
    const wrap = document.getElementById('apiSidebarWrap');
    const button = document.getElementById('mobileSidebarToggle');
    if (!wrap) return;
    const open = wrap.classList.toggle('mobile-open');
    if (button) button.classList.toggle('open', open);
  };

  // On mobile the section list is an overlay; picking a section closes it.
  sidebar.addEventListener('click', (event) => {
    if (!event.target.closest('.sidebar-link')) return;
    const wrap = document.getElementById('apiSidebarWrap');
    const button = document.getElementById('mobileSidebarToggle');
    if (wrap) wrap.classList.remove('mobile-open');
    if (button) button.classList.remove('open');
  });

  if (searchInput) searchInput.addEventListener('input', search);
  window.addEventListener('hashchange', openFromHash);

  const base = document.getElementById('base-url-display');
  if (base) base.textContent = baseUrl;

  renderSidebar();
  renderMain();
  applyPreferredLang();
  openFromHash();
  scrollSpy();
})();
