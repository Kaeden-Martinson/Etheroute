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
        <div class="nav-links">
            ${linksHTML}
            <div class="auth-buttons" id="authButtons">
                <a href="/auth" class="nav-link login-btn">Sign In</a>
                <a href="/auth" class="nav-link signup-btn">Get Started</a>
            </div>
            <a href="/dashboard" class="nav-link signup-btn" id="dashboardBtn" style="display: none;">Dashboard</a>
        </div>
    </div>`;

  document.currentScript.insertAdjacentHTML('beforebegin', html);

  const authToken = localStorage.getItem('authToken');
  const clientId = localStorage.getItem('clientId');
  if (authToken && clientId) {
    document.getElementById('authButtons').style.display = 'none';
    document.getElementById('dashboardBtn').style.display = 'block';
  }
})();
