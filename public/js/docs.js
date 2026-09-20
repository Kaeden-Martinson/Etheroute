/**
 * Documentation page.
 *
 * Renders window.DOCS_CONTENT (docs-content.js) into the sidebar and body,
 * with search across every section's text and a sidebar that follows scroll.
 */
(() => {
  const content = window.DOCS_CONTENT;
  const sidebar = document.getElementById('docsSidebar');
  const main = document.getElementById('docsMain');
  const searchInput = document.getElementById('docsSearch');
  const searchMeta = document.getElementById('docsSearchMeta');
  if (!content || !sidebar || !main) return;

  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const stripTags = (html) => String(html).replace(/<[^>]+>/g, ' ');

  // ── block renderers ────────────────────────────────────────────────────

  function block(b) {
    switch (b.type) {
      case 'lead': return `<p class="docs-lead">${b.html}</p>`;
      case 'p': return `<p>${b.html}</p>`;
      case 'h3': return `<h3>${b.html}</h3>`;
      case 'list': return `<ul>${b.items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
      case 'olist': return `<ol>${b.items.map((i) => `<li>${i}</li>`).join('')}</ol>`;
      case 'steps': return `<ol class="docs-steps">${b.items.map((s) => `<li><span class="docs-step__title">${s.title}</span><span class="docs-step__body">${s.body}</span></li>`).join('')}</ol>`;
      case 'callout': return `<div class="callout callout--${b.tone}"><div class="callout__title">${esc(b.title)}</div><div class="callout__body">${b.body}</div></div>`;
      case 'table': return `<div class="table-scroll"><table class="docs-table"><thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c, i) => `<td>${i === 0 ? `<strong>${esc(c)}</strong>` : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      case 'code': return `<div class="code-block"><div class="code-block__bar"><span class="code-block__lang">${esc(b.lang)}</span></div><pre><code class="language-${esc(b.lang)}">${esc(b.code)}</code></pre></div>`;
      case 'faq': return `<div class="docs-faq">${b.items.map((f) => `<details class="docs-faq__item"><summary>${esc(f.q)}</summary><div class="docs-faq__a">${f.a}</div></details>`).join('')}</div>`;
      default: return '';
    }
  }

  function searchText(s) {
    return (s.title + ' ' + s.blocks.map((b) => {
      if (b.html) return stripTags(b.html);
      if (b.items) return b.items.map((i) => (typeof i === 'string' ? stripTags(i) : stripTags(`${i.title} ${i.body} ${i.q} ${i.a}`))).join(' ');
      if (b.rows) return b.rows.flat().join(' ');
      if (b.code) return b.code;
      if (b.body) return `${b.title} ${stripTags(b.body)}`;
      return '';
    }).join(' ')).toLowerCase();
  }

  // ── render ───────────────────────────────────────────────────────────────

  function renderSidebar() {
    const groups = [];
    for (const s of content.sections) {
      let group = groups.find((g) => g.name === s.group);
      if (!group) { group = { name: s.group, items: [] }; groups.push(group); }
      group.items.push(s);
    }
    sidebar.innerHTML = groups.map((g) => `
      <div class="sidebar-section">
        <div class="sidebar-section-title">${esc(g.name)}</div>
        ${g.items.map((s) => `<a href="#${esc(s.id)}" class="sidebar-link" data-section="${esc(s.id)}"><span class="sidebar-icon" data-icon="${esc(s.icon)}"></span>${esc(s.title)}</a>`).join('')}
      </div>`).join('');
  }

  function renderMain() {
    main.innerHTML = content.sections.map((s, i) => `
      ${i > 0 ? '<div class="section-divider"></div>' : ''}
      <section class="doc-section" id="${esc(s.id)}" data-search="${esc(searchText(s))}" data-title="${esc(s.title)}">
        <h2>${esc(s.title)}</h2>
        ${s.blocks.map(block).join('')}
      </section>`).join('');
    if (window.loadSVGIcons) window.loadSVGIcons();
    if (window.hljs) main.querySelectorAll('pre code').forEach((el) => window.hljs.highlightElement(el));
  }

  // ── search ───────────────────────────────────────────────────────────────

  function search() {
    const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    let shown = 0;
    const sections = main.querySelectorAll('.doc-section');
    sections.forEach((sec) => {
      const match = terms.every((t) => sec.dataset.search.includes(t));
      sec.classList.toggle('hidden', !match);
      if (match) shown += 1;
    });
    main.querySelectorAll('.section-divider').forEach((d) => d.classList.toggle('hidden', Boolean(query)));
    sidebar.querySelectorAll('.sidebar-link').forEach((link) => {
      const sec = document.getElementById(link.dataset.section);
      link.classList.toggle('hidden', Boolean(sec && sec.classList.contains('hidden')));
    });
    let empty = document.getElementById('docsSearchEmpty');
    if (!empty) {
      empty = document.createElement('div');
      empty.id = 'docsSearchEmpty';
      empty.className = 'docs-search-empty';
      empty.textContent = 'Nothing in the docs matches that. Try the API Reference, or search the Help Center.';
      main.appendChild(empty);
    }
    empty.classList.toggle('hidden', shown > 0);
    if (searchMeta) searchMeta.textContent = query ? `${shown} section${shown === 1 ? '' : 's'}` : '';
  }

  // ── scroll spy ─────────────────────────────────────────────────────────

  // Scroll the sidebar (and only the sidebar, never the page) so the active
  // link stays visible as you read down the page.
  function keepLinkInView(link) {
    const container = link.closest('.docs-sidebar');
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
    const links = [...sidebar.querySelectorAll('.sidebar-link')];
    const setActive = (id) => links.forEach((l) => {
      const on = l.dataset.section === id;
      l.classList.toggle('active', on);
      if (on) keepLinkInView(l);
    });
    // The page opens on its first section (or the one the hash names) before
    // anything has scrolled: the observer's band sits a way down the viewport,
    // so on load nothing was in it and no link was lit.
    const sections = [...main.querySelectorAll('.doc-section')];
    const named = location.hash && sections.find((s) => `#${s.id}` === location.hash);
    if (named || sections[0]) setActive((named || sections[0]).id);
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
    }, { rootMargin: '-12% 0px -75% 0px' });
    sections.forEach((s) => observer.observe(s));
  }

  function closeMobileSidebar() {
    const wrap = document.getElementById('docsSidebarWrap');
    const button = document.getElementById('mobileSidebarToggle');
    if (wrap) wrap.classList.remove('mobile-open');
    if (button) button.classList.remove('open');
  }

  window.docsToggleSidebar = () => {
    const wrap = document.getElementById('docsSidebarWrap');
    const button = document.getElementById('mobileSidebarToggle');
    if (!wrap) return;
    const open = wrap.classList.toggle('mobile-open');
    if (button) button.classList.toggle('open', open);
  };

  // On mobile the section list is an overlay; picking a section should jump to it
  // and close the overlay so it stops covering the page.
  sidebar.addEventListener('click', (event) => {
    if (event.target.closest('.sidebar-link')) closeMobileSidebar();
  });

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

  // The nav's signed-in state is navbar.js's job: it puts .authed on
  // #navLinksMenu and the CSS shows exactly one of the two clusters. This file
  // used to do it here as well, and its `style.display = 'block'` was an inline
  // style, so it beat the navbar's `inline-flex` — the Dashboard button lost
  // its centring and the label rendered against the top of a 38px box.

  if (searchInput) searchInput.addEventListener('input', search);

  renderSidebar();
  renderMain();
  scrollSpy();
})();
