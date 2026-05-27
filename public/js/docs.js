// Check if user is already authenticated
window.addEventListener('load', () => {
    const authToken = localStorage.getItem('authToken');
    const clientId = localStorage.getItem('clientId');
    
    if (authToken && clientId) {
        // User is authenticated, show dashboard button
        document.getElementById('authButtons').style.display = 'none';
        document.getElementById('dashboardBtn').style.display = 'block';
    }

    // Initialize SVG icons
    loadSVGIcons();

    // Handle sidebar navigation
    const sidebarLinks = document.querySelectorAll('.sidebar-link');

    function setActiveSidebarLink(targetLink, smooth = true) {
        if (!targetLink) return;

        sidebarLinks.forEach(link => {
            link.classList.toggle('active', link === targetLink);
        });

        // Keep the active link visible within the scrollable sidebar.
        targetLink.scrollIntoView({
            behavior: smooth ? 'smooth' : 'auto',
            block: 'nearest',
            inline: 'nearest'
        });
    }
    
    sidebarLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            setActiveSidebarLink(link);
            
            // Smooth scroll to section
            const sectionId = link.getAttribute('data-section');
            const section = document.getElementById(sectionId);
            if (section) {
                section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });

    // Update active sidebar link based on scroll position
    const observerOptions = {
        root: null,
        rootMargin: '-100px 0px -66%',
        threshold: 0
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const id = entry.target.id;
                const matchedLink = Array.from(sidebarLinks).find(
                    link => link.getAttribute('data-section') === id
                );
                setActiveSidebarLink(matchedLink);
            }
        });
    }, observerOptions);

    // Observe all doc sections
    const docSections = document.querySelectorAll('.doc-section');
    docSections.forEach(section => {
        observer.observe(section);
    });
});

// Mobile sidebar toggle
(function () {
    var toggleBtn = document.getElementById('mobileSidebarToggle');
    var sidebar = document.querySelector('.docs-sidebar');
    if (!toggleBtn || !sidebar) return;
    toggleBtn.addEventListener('click', function () {
        var isOpen = sidebar.classList.toggle('mobile-open');
        toggleBtn.classList.toggle('open', isOpen);
    });
    sidebar.addEventListener('click', function (e) {
        if (e.target.closest('a')) {
            sidebar.classList.remove('mobile-open');
            toggleBtn.classList.remove('open');
        }
    });
}());
