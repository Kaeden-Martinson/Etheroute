(function () {
  const path = window.location.pathname;

  // One nav for every page. "Home" is a direct link; the rest are grouped into
  // hover dropdowns (accordions on mobile). Each item carries an icon and a
  // one-line description, usenotra-style.
  const NAV = [
    { label: 'Home', href: '/' },
    {
      label: 'Developers', key: 'developers',
      items: [
        { href: '/api-reference', title: 'API Reference', desc: 'Every endpoint, with copy-paste examples in seven languages.', icon: 'apiKeys' },
        { href: '/docs', title: 'Documentation', desc: 'Guides from a first account to a live integration.', icon: 'book' },
        { href: '/help', title: 'Help Center', desc: 'Answers on wallets, checkout and payouts.', icon: 'support' },
      ],
    },
    {
      label: 'Company', key: 'company',
      items: [
        { href: '/about', title: 'About', desc: 'Who we are and what we are building.', icon: 'userProfile' },
        { href: '/faq', title: 'FAQ', desc: 'Quick answers to the common questions.', icon: 'faq' },
        { href: '/status', title: 'Status', desc: 'Live platform and network health.', icon: 'globalCheck' },
      ],
    },
    {
      label: 'Legal', key: 'legal',
      items: [
        { href: '/privacy', title: 'Privacy Policy', desc: "What we collect — and deliberately don't.", icon: 'security' },
        { href: '/terms', title: 'Terms of Service', desc: 'The agreement governing your use.', icon: 'book' },
        { href: '/compliance', title: 'Compliance', desc: 'Our regulatory framework and commitments.', icon: 'checkmark' },
      ],
    },
  ];

  const isActive = (href) => (href === '/' ? path === '/' : path === href || path.startsWith(href + '/'));

  const linksHTML = NAV.map((entry) => {
    if (!entry.items) {
      return `<a href="${entry.href}" class="nav-top${isActive(entry.href) ? ' active' : ''}">${entry.label}</a>`;
    }
    const groupActive = entry.items.some((i) => isActive(i.href));
    const itemsHTML = entry.items.map((i) => `
        <a href="${i.href}" class="nav-drop${isActive(i.href) ? ' active' : ''}">
          <span class="nav-drop__ico" data-icon="${i.icon}" aria-hidden="true"></span>
          <span class="nav-drop__txt"><span class="nav-drop__title">${i.title}</span><span class="nav-drop__desc">${i.desc}</span></span>
        </a>`).join('');
    return `<div class="nav-group${groupActive ? ' active' : ''}" data-group="${entry.key}">
        <button type="button" class="nav-group__trigger" aria-expanded="false" aria-controls="navmenu-${entry.key}">
          ${entry.label}<span class="nav-chev" aria-hidden="true"></span>
        </button>
        <div class="nav-menu" id="navmenu-${entry.key}">
          <div class="nav-menu__card">${itemsHTML}</div>
        </div>
      </div>`;
  }).join('\n        ');

  const html = `<div class="header site-header">
        <a class="header-left" href="/">
            <div class="logo-mini" data-icon="logoOutline"></div>
            <div class="brand">Etheroute</div>
        </a>
        <nav class="nav-links site-nav" id="navLinksMenu" aria-label="Primary">
            ${linksHTML}
            <div class="auth-buttons" id="authButtons">
                <a href="/auth" class="nav-link login-btn">Sign In</a>
                <a href="/auth" class="nav-link signup-btn">Get Started</a>
            </div>
            <!-- Same wrapper as the signed-out pair, so both states get the
                 identical cluster spacing on desktop and, on mobile, the same
                 separator and gutters inside the sheet. -->
            <div class="auth-buttons" id="dashboardWrap">
                <a href="/dashboard" class="nav-link signup-btn" id="dashboardBtn">Dashboard</a>
            </div>
        </nav>
        <div class="header-actions">
            <button class="theme-toggle" id="themeToggle" data-on-click="cycleTheme"
                    aria-label="Switch colour theme" title="Switch colour theme">
                <svg class="theme-icon theme-icon--sun" width="18" height="18" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="4"/>
                    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>
                </svg>
                <svg class="theme-icon theme-icon--moon" width="18" height="18" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>
                </svg>
                <svg class="theme-icon theme-icon--auto" width="18" height="18" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9"/>
                    <path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>
                </svg>
            </button>
            <button class="nav-toggle" id="navToggle" aria-label="Toggle navigation" aria-expanded="false">
                <span class="nav-toggle__bars" aria-hidden="true"><i></i><i></i><i></i></span>
            </button>
        </div>
    </div>`;

  document.currentScript.insertAdjacentHTML('beforebegin', html);

  // ── Styles (injected so they land after the per-page stylesheet and win) ──
  if (!document.getElementById('navbar-responsive-styles')) {
    const style = document.createElement('style');
    style.id = 'navbar-responsive-styles';
    style.textContent = `
      /* ── Header chrome ──────────────────────────────────────────────────
         This used to live in every page stylesheet, copied from before this
         file existed. Nine of them still had it, and on docs/help the stale
         copy beat the rules below for one property — the Dashboard button kept
         \`display:inline-block\`, so its label rendered 3px from the top of a
         38px box instead of centred. navbar.js injects the markup, so it owns
         the styling too; the per-page copies are gone.

         (checkout.css and dashboard.css still style .header themselves — those
         two pages have their own header markup and never load this file.) */
      /* width + flex:none so a page whose <body> is itself a flex or grid
         container cannot shrink the bar to its contents (auth.css centres its
         card that way, and the header was being centred along with it). */
      .site-header{background:var(--surface);border-bottom:1px solid var(--line);
        padding:16px 24px;display:flex;align-items:center;position:sticky;top:0;z-index:100;
        width:100%;flex:none;box-sizing:border-box;}
      .site-header .header-left{display:flex;align-items:center;gap:16px;cursor:pointer;
        text-decoration:none;transition:opacity .2s;}
      .site-header .header-left:hover{opacity:.8;}
      /* logoOutline, at 56px. The hollow letter only exists in the outlined
         marks — logoSmall draws it solid, so no amount of scaling would have
         produced an outline. The rim is 0.65 of a 32-unit viewBox, a sub-pixel
         line until about 49px, so at 45px it is 0.91px — just under, and the
         letter softens rather than holding a crisp edge. */
      .site-header .logo-mini{width:45px;height:45px;background:none;border-radius:0;
        display:flex;align-items:center;justify-content:center;flex:none;color:var(--ink);}
      .site-header .logo-mini svg{width:45px;height:45px;display:block;}
      /* A 45px mark does not fit a 16px-padded bar, so the header grows with it.
         Anything that pins beneath the header follows — see the 76px mobile
         height below, and the Contents bars in docs.css / api-reference.css. */
      .site-header{padding-top:10px;padding-bottom:10px;}
      .site-header .brand{font-size:16px;font-weight:600;color:var(--ink);}
      /* flex-start + margin-left:auto on the nav means spacing is controlled by
         explicit margins, not by space-between dumping leftover room between
         the nav and the actions cluster. */
      .site-header{justify-content:flex-start;gap:0;}
      .site-nav{display:flex;align-items:center;gap:2px;margin-left:auto;}
      /* Top-level items */
      .nav-top,.nav-group__trigger{display:inline-flex;align-items:center;justify-content:center;gap:6px;
        height:38px;padding:0 12px;border-radius:10px;box-sizing:border-box;
        font-size:13.5px;font-weight:600;color:var(--ink-2);background:none;border:0;cursor:pointer;font-family:inherit;
        text-decoration:none;transition:color .15s ease,background .15s ease;}
      .nav-top:hover,.nav-group__trigger:hover{color:var(--ink);background:var(--surface-sunken);}
      .nav-top.active{color:var(--ink);}
      .nav-group.active>.nav-group__trigger{color:var(--ink);}
      .nav-chev{width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;
        transform:rotate(45deg) translate(-1px,-1px);opacity:.65;transition:transform .2s ease;}
      .nav-group{position:relative;}
      .nav-group:hover .nav-chev,.nav-group:focus-within .nav-chev{transform:rotate(225deg) translate(-1px,-1px);}
      /* Dropdown panel */
      /* Anchored to the trigger's right edge so the panel opens leftward. The
         nav sits on the right of the header, so left-aligning pushed the last
         group (Legal) past the viewport and gave the page a horizontal scroll. */
      .nav-menu{position:absolute;top:100%;left:auto;right:0;padding-top:9px;min-width:340px;z-index:600;
        opacity:0;visibility:hidden;transform:translateY(6px);
        transition:opacity .18s ease,transform .18s ease,visibility 0s linear .18s;}
      .nav-group:hover .nav-menu,.nav-group:focus-within .nav-menu{opacity:1;visibility:visible;transform:none;transition-delay:0s;}
      .nav-menu__card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:8px;
        box-shadow:0 16px 40px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.12);}
      .nav-drop{display:flex;gap:12px;padding:11px 12px;border-radius:10px;text-decoration:none;transition:background .15s ease;}
      .nav-drop:hover{background:var(--surface-sunken);}
      .nav-drop.active{background:var(--surface-sunken);}
      .nav-drop__ico{width:34px;height:34px;flex:none;border-radius:9px;background:var(--surface-sunken);
        border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--ink-2);}
      .nav-drop:hover .nav-drop__ico{color:var(--ink);border-color:var(--line-strong);}
      .nav-drop__ico [data-icon],.nav-drop__ico svg{width:17px;height:17px;}
      .nav-drop__txt{display:flex;flex-direction:column;gap:2px;}
      .nav-drop__title{color:var(--ink);font-size:13.5px;font-weight:700;line-height:1.2;}
      .nav-drop__desc{color:var(--ink-3);font-size:12px;line-height:1.4;}
      /* One control size for the whole bar: every interactive element in the
         header is 38px tall with the same radius, so heights, baselines and
         gaps line up. These override the per-page .signup-btn/.login-btn rules
         (4px radius, uppercase 12px) that made the bar look mismatched. */
      #navLinksMenu .nav-link.login-btn,
      #navLinksMenu .nav-link.signup-btn,
      .header-actions .theme-toggle{
        height:38px;box-sizing:border-box;border-radius:10px;display:inline-flex;align-items:center;
        justify-content:center;padding:0 16px;font-size:13px;font-weight:600;font-family:inherit;
        text-transform:none;letter-spacing:0;text-decoration:none;position:static;
        transition:background .15s ease,border-color .15s ease,color .15s ease;}
      .header-actions .theme-toggle{width:38px;padding:0;flex:none;
        border:1px solid var(--line);background:transparent;color:var(--ink-2);}
      .header-actions .theme-toggle:hover{color:var(--ink);border-color:var(--line-strong);background:var(--surface-sunken);}
      #navLinksMenu .nav-link.login-btn{background:transparent;border:1px solid var(--line);color:var(--ink);}
      #navLinksMenu .nav-link.login-btn:hover{background:var(--surface-sunken);border-color:var(--line-strong);}
      #navLinksMenu .nav-link.signup-btn{background:var(--ink);border:1px solid var(--ink);color:var(--surface);}
      /* Hovers to --ink-hover (--ink nudged toward --surface) rather than
         --ink-2: --ink-2 only lightens in the light theme, and in dark mode it
         darkens the fill under an already-dark label. */
      #navLinksMenu .nav-link.signup-btn:hover{background:var(--ink-hover);border-color:var(--ink-hover);color:var(--surface);}
      #navLinksMenu .nav-link.login-btn::after,#navLinksMenu .nav-link.signup-btn::after{display:none;}

      /* Actions */
      .header-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:14px;}
      .nav-toggle{display:none;background:none;border:none;cursor:pointer;padding:6px;color:var(--ink);
        align-items:center;justify-content:center;border-radius:6px;transition:background .2s;flex-shrink:0;}
      .nav-toggle:hover{background:var(--surface-sunken);}
      .nav-toggle__bars{position:relative;display:block;width:22px;height:16px;}
      /* The morph is transform-only. The previous version also flipped
         left:0 -> auto and right:0 -> 5px, neither of which was in the
         transition list, so the bars jumped sideways while they rotated —
         most visible on the way back to the hamburger. Every bar now keeps
         its box and moves with translate/rotate/scaleX, which interpolate,
         so opening and closing are the same animation in reverse. */
      .nav-toggle__bars i{position:absolute;left:0;right:0;height:2px;border-radius:2px;background:currentColor;
        transform-origin:100% 50%;transition:transform .3s var(--ease-out,ease),opacity .18s ease;}
      .nav-toggle__bars i:nth-child(1){top:0;}
      .nav-toggle__bars i:nth-child(2){top:7px;}
      .nav-toggle__bars i:nth-child(3){top:14px;}
      /* scaleX shortens each bar towards its right edge, which is where the
         chevron's point sits, so the two strokes meet instead of crossing.
         The -4.8px is what keeps the two states on the same optical centre:
         scaling 22px to 56% about the right edge would otherwise leave the
         chevron sitting 4.8px right of where the hamburger was. */
      .nav-toggle.open .nav-toggle__bars i:nth-child(1){transform:translate(-4.8px,7px) rotate(-45deg) scaleX(.56);}
      .nav-toggle.open .nav-toggle__bars i:nth-child(2){opacity:0;transform:translateX(-4.8px) scaleX(.56);}
      .nav-toggle.open .nav-toggle__bars i:nth-child(3){transform:translate(-4.8px,-7px) rotate(45deg) scaleX(.56);}
      @media(prefers-reduced-motion:reduce){.nav-toggle__bars i{transition:none;}}
      /* Auth state (exactly one of {sign in/get started} or {dashboard}) */
      #navLinksMenu:not(.authed) #dashboardWrap{display:none!important;}
      #navLinksMenu.authed #authButtons{display:none!important;}
      .site-nav .auth-buttons{display:flex;align-items:center;gap:8px;margin-left:14px;}

      /* ── Mobile: collapse to a hamburger dropdown with accordion groups ── */
      @media(max-width:900px){
        .nav-toggle{display:flex;}
        /* .site-nav leaves the flow below 900px, so nothing is left to push the
           actions cluster over — without this the theme toggle and hamburger
           sat mid-bar, a few pixels after the wordmark. */
        .header-actions{margin-left:auto;}
        /* A fixed 66px so anything that pins beneath the header — the docs and
           API "Contents" bars sit at top:65px — lands flush against it. When
           the height depended on padding plus the tallest control, content bled
           through the few pixels of difference while scrolling. Both of those
           pages used to declare this themselves, against a class they no longer
           own. */
        .site-header{height:66px;padding:0 20px;box-sizing:border-box;}
        .site-nav{position:absolute;top:100%;left:0;right:0;margin-left:0;background:var(--surface);
          border-bottom:1px solid var(--line);flex-direction:column;align-items:stretch;gap:0;
          padding:6px 0 12px;box-shadow:0 12px 28px rgba(0,0,0,.28);z-index:999;display:none;max-height:calc(100dvh - 70px);overflow-y:auto;}
        #navLinksMenu.open{display:flex;}
        .nav-top,.nav-group__trigger{width:100%;justify-content:space-between;border-radius:0;padding:13px 20px!important;
          font-size:14px;border-bottom:1px solid var(--line);}
        .nav-group{width:100%;}
        .nav-chev{margin-left:auto;}
        /* Accordion: panel is inline, revealed when the group is open */
        .nav-menu{position:static;padding-top:0;min-width:0;opacity:1;visibility:visible;transform:none;display:none;
          transition:none;background:var(--surface-sunken);border-bottom:1px solid var(--line);}
        .nav-group.nav-group--open>.nav-menu{display:block;}
        .nav-group.nav-group--open>.nav-group__trigger .nav-chev{transform:rotate(225deg) translate(-1px,-1px);}
        /* Every row in the sheet starts on the same 20px gutter as the header.
           Sub-items were indented to 24px, which read as a misalignment rather
           than as hierarchy; a rule down the left says "nested" without
           breaking the column. */
        .nav-menu__card{background:none;border:0;border-radius:0;padding:4px 0 8px;box-shadow:none;
          margin-left:20px;border-left:2px solid var(--line);}
        /* With the description gone the title is the row's only text, so it
           centres on the icon instead of sitting on the top edge of a
           30px box with nothing beneath it. */
        .nav-drop{padding:11px 20px;border-radius:0;gap:12px;align-items:center;}
        .nav-drop__ico{width:30px;height:30px;}
        .nav-drop__txt{justify-content:center;}
        .nav-drop__desc{display:none;}
        .site-nav .auth-buttons{flex-direction:column;align-items:stretch;margin:6px 0 0;padding:12px 20px 4px;
          gap:8px;border-top:1px solid var(--line);}
        #navLinksMenu .nav-link.login-btn,#navLinksMenu .nav-link.signup-btn{display:flex!important;width:100%;
          height:44px;padding:0 20px;border-radius:10px;justify-content:center;font-size:13.5px;}
        #navLinksMenu .nav-link.signup-btn{color:var(--surface);}
      }`;
    document.head.appendChild(style);
  }

  const toggle = document.getElementById('navToggle');
  const menu = document.getElementById('navLinksMenu');

  // Hamburger open/close.
  if (toggle && menu) {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.toggle('open');
      toggle.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (!open) menu.querySelectorAll('.nav-group--open').forEach((g) => g.classList.remove('nav-group--open'));
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && !toggle.contains(e.target)) {
        menu.classList.remove('open');
        toggle.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
    // Picking a real link closes the whole menu.
    menu.addEventListener('click', (e) => {
      if (e.target.closest('a[href]')) {
        menu.classList.remove('open');
        toggle.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Group triggers: accordion toggle on mobile; on desktop hover opens the
  // panel, and a click does nothing except drop the focus the click gave the
  // button. Focus keeps a panel open (:focus-within, for the keyboard), so a
  // clicked group stayed open after the pointer left it, and hovering the
  // next group put two panels up at once. A keyboard activation has
  // detail 0 and keeps its focus. aria-expanded is kept in sync on mobile.
  menu?.querySelectorAll('.nav-group').forEach((group) => {
    const trigger = group.querySelector('.nav-group__trigger');
    trigger?.addEventListener('click', (e) => {
      if (window.matchMedia('(max-width:900px)').matches) {
        e.preventDefault();
        e.stopPropagation();
        const open = group.classList.toggle('nav-group--open');
        // Only one open group at a time.
        if (open) {
          menu.querySelectorAll('.nav-group--open').forEach((g) => { if (g !== group) g.classList.remove('nav-group--open'); });
        }
        trigger.setAttribute('aria-expanded', String(open));
      } else if (e.detail > 0) {
        trigger.blur();
      }
    });
  });

  // Exactly one of the auth buttons / Dashboard link shows.
  const authToken = localStorage.getItem('authToken');
  const clientId = localStorage.getItem('clientId');
  if (menu) menu.classList.toggle('authed', Boolean(authToken && clientId));

  /** Show the icon matching the current preference; describe the next action. */
  function syncThemeButton() {
    const button = document.getElementById('themeToggle');
    if (!button || !window.Theme) return;
    const preference = window.Theme.get();
    button.setAttribute('data-theme-state', preference);
    const next = { light: 'dark', dark: 'system', system: 'light' }[preference];
    const label = `Theme: ${preference}. Switch to ${next}.`;
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }

  syncThemeButton();
  window.addEventListener('themechange', syncThemeButton);
})();
