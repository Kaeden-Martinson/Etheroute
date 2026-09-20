/**
 * Help Center page.
 *
 * Renders window.HELP_CONTENT (help-content.js) into the sidebar and body,
 * with search across every section's text and a sidebar that follows scroll.
 * Mirrors the docs page so the two behave identically.
 */
(() => {
  const content = window.HELP_CONTENT;
  const sidebar = document.getElementById('helpSidebar');
  const main = document.getElementById('helpMain');
  const searchInput = document.getElementById('helpSearch');
  const searchMeta = document.getElementById('helpSearchMeta');
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
      case 'callout': return `<div class="callout callout--${b.tone}"><div class="callout__title">${esc(b.title)}</div><div class="callout__body">${b.body}</div></div>`;
      case 'faq': return `<div class="docs-faq">${b.items.map((f) => `<details class="docs-faq__item"><summary>${esc(f.q)}</summary><div class="docs-faq__a">${f.a}</div></details>`).join('')}</div>`;
      case 'channels': return `<div class="channels-grid">${b.items.map((c) => `<a class="channel" href="${esc(c.href)}"${c.external ? ' target="_blank" rel="noopener"' : ''}><svg class="channel-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${c.svg}</svg><span>${esc(c.label)}</span></a>`).join('')}</div>`;
      default: return '';
    }
  }

  function searchText(s) {
    return (s.title + ' ' + s.blocks.map((b) => {
      if (b.html) return stripTags(b.html);
      if (b.type === 'faq') return b.items.map((f) => stripTags(`${f.q} ${f.a}`)).join(' ');
      if (b.type === 'channels') return b.items.map((c) => c.label).join(' ');
      if (b.items) return b.items.map((i) => (typeof i === 'string' ? stripTags(i) : '')).join(' ');
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
    let empty = document.getElementById('helpSearchEmpty');
    if (!empty) {
      empty = document.createElement('div');
      empty.id = 'helpSearchEmpty';
      empty.className = 'docs-search-empty';
      empty.textContent = 'Nothing in the Help Center matches that. Try the docs, or ask us through a support channel below.';
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

  window.helpToggleSidebar = () => {
    const wrap = document.getElementById('helpSidebarWrap');
    const button = document.getElementById('mobileSidebarToggle');
    if (!wrap) return;
    const open = wrap.classList.toggle('mobile-open');
    if (button) button.classList.toggle('open', open);
  };

  // On mobile the topic list is an overlay; picking a topic closes it.
  sidebar.addEventListener('click', (event) => {
    if (!event.target.closest('.sidebar-link')) return;
    const wrap = document.getElementById('helpSidebarWrap');
    const button = document.getElementById('mobileSidebarToggle');
    if (wrap) wrap.classList.remove('mobile-open');
    if (button) button.classList.remove('open');
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
