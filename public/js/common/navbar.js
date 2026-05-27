(function () {
  const path = window.location.pathname;

  const legalPages = ['/privacy', '/terms', '/compliance'];
  const docsPages = ['/docs', '/api-reference', '/help'];

  const navSets = {
    legal: [
      { href: '/', label: 'Home' },
      { href: '/privacy', label: 'Privacy Policy' },
      { href: '/terms', label: 'Terms' },
      { href: '/compliance', label: 'Compliance' },
    ],
    docs: [
      { href: '/', label: 'Home' },
      { href: '/api-reference', label: 'API Reference' },
      { href: '/docs', label: 'Docs' },
      { href: '/help', label: 'Help Center' },
    ],
    default: [
      { href: '/', label: 'Home' },
      { href: '/faq', label: 'FAQ' },
      { href: '/about', label: 'About' },
      { href: '/status', label: 'Status' },
    ],
  };

  const navLinks = legalPages.some(p => path === p || path.startsWith(p + '/'))
    ? navSets.legal
    : docsPages.some(p => path === p || path.startsWith(p + '/'))
    ? navSets.docs
    : navSets.default;

  const linksHTML = navLinks
    .map(({ href, label }) => {
      const isActive = href === '/' ? path === '/' : path === href || path.startsWith(href + '/');
      return `<a href="${href}" class="nav-link${isActive ? ' active' : ''}">${label}</a>`;
    })
    .join('\n            ');

  const html = `<div class="header">
        <div class="header-left" onclick="window.location.href='/'">
            <div class="logo-mini" data-icon="logo"></div>
            <div class="brand">Etheroute</div>
        </div>
        <button class="nav-toggle" id="navToggle" aria-label="Toggle navigation" aria-expanded="false">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="3" y1="6" x2="21" y2="6"/>
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
        </button>
        <div class="nav-links" id="navLinksMenu">
            ${linksHTML}
            <div class="auth-buttons" id="authButtons">
                <a href="/auth" class="nav-link login-btn">Sign In</a>
                <a href="/auth" class="nav-link signup-btn">Get Started</a>
            </div>
            <a href="/dashboard" class="nav-link signup-btn" id="dashboardBtn" style="display: none;">Dashboard</a>
        </div>
    </div>`;

  document.currentScript.insertAdjacentHTML('beforebegin', html);

  // Inject responsive navbar styles once per page load
  if (!document.getElementById('navbar-responsive-styles')) {
    const style = document.createElement('style');
    style.id = 'navbar-responsive-styles';
    style.textContent =
      '.nav-toggle{display:none;background:none;border:none;cursor:pointer;padding:6px;color:#1a1a1a;align-items:center;justify-content:center;border-radius:4px;transition:background 0.2s;flex-shrink:0;}' +
      '.nav-toggle:hover{background:#f5f5f5;}' +
      '@media(max-width:768px){' +
        '.nav-toggle{display:flex;}' +
        '#navLinksMenu{display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border-bottom:1px solid #e5e5e5;flex-direction:column;align-items:stretch;padding:6px 0 12px;gap:0;box-shadow:0 4px 16px rgba(0,0,0,.09);z-index:999;}' +
        '#navLinksMenu.open{display:flex;}' +
        '#navLinksMenu .nav-link{padding:11px 20px!important;font-size:14px;border-bottom:1px solid #f0f0f0;border-radius:0!important;text-align:left;}' +
        '#navLinksMenu .nav-link::after{display:none!important;}' +
        '#navLinksMenu .nav-link:hover{background:#f8f8f8;color:#1a1a1a;}' +
        '#navLinksMenu .auth-buttons{flex-direction:column;padding:10px 20px 4px;gap:8px;border-top:1px solid #ebebeb;margin-top:4px;}' +
        '#navLinksMenu .nav-link.login-btn,#navLinksMenu .nav-link.signup-btn{display:block!important;text-align:center;width:100%;padding:10px 20px!important;border-bottom:none!important;}' +
        '#navLinksMenu>#dashboardBtn{margin:8px 20px 0;text-align:center;border-radius:4px;padding:10px!important;border-bottom:none!important;}' +
      '}';
    document.head.appendChild(style);
  }

  // Hamburger toggle
  const toggle = document.getElementById('navToggle');
  const menu = document.getElementById('navLinksMenu');
  if (toggle && menu) {
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      const isOpen = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(isOpen));
    });
    document.addEventListener('click', function (e) {
      if (!menu.contains(e.target) && !toggle.contains(e.target)) {
        menu.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  const authToken = localStorage.getItem('authToken');
  const clientId = localStorage.getItem('clientId');
  if (authToken && clientId) {
    document.getElementById('authButtons').style.display = 'none';
    document.getElementById('dashboardBtn').style.display = 'block';
  }
})();
