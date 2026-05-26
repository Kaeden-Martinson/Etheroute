// FAQ cards are intentionally always expanded on this page.

// Sidebar navigation with smooth scroll
const sidebarLinks = document.querySelectorAll('.sidebar-nav a');

function setActiveSidebarLink(targetLink, smooth = true) {
    if (!targetLink) return;

    sidebarLinks.forEach(link => {
        link.classList.toggle('active', link === targetLink);
    });

    targetLink.scrollIntoView({
        behavior: smooth ? 'smooth' : 'auto',
        block: 'nearest',
        inline: 'nearest'
    });
}

sidebarLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();

        setActiveSidebarLink(link);

        // Smooth scroll to target section with 50px offset for navbar
        const href = link.getAttribute('href');
        if (href && href.startsWith('#')) {
            const targetId = href.substring(1);
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                const elementPosition = targetElement.getBoundingClientRect().top + window.pageYOffset;
                const offsetPosition = elementPosition - 60;
                window.scrollTo({
                    top: offsetPosition,
                    behavior: 'smooth'
                });
            }
        }
    });
});

const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const id = entry.target.id;
            const matchedLink = Array.from(sidebarLinks).find(
                link => link.getAttribute('data-section') === id
            );
            setActiveSidebarLink(matchedLink);
        }
    });
}, {
    root: null,
    rootMargin: '-100px 0px -66%',
    threshold: 0
});

document.querySelectorAll('.section[id]').forEach(section => {
    sectionObserver.observe(section);
});

// Enhanced search functionality
const searchInput = document.getElementById('searchInput');
const faqItems = document.querySelectorAll('.faq-item');

if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();

        if (query.length === 0) {
            faqItems.forEach(item => {
                item.style.display = '';
                item.classList.remove('active');
            });
            const noResults = document.querySelector('.no-results');
            if (noResults) noResults.remove();
            return;
        }

        let foundCount = 0;
        faqItems.forEach(item => {
            const keywords = item.dataset.keywords.toLowerCase();
            const question = item.querySelector('.faq-question span:first-child').textContent.toLowerCase();
            const answer = item.querySelector('.faq-answer p').textContent.toLowerCase();

            const matches = keywords.includes(query) || question.includes(query) || answer.includes(query);

            if (matches) {
                item.style.display = '';
                item.classList.add('active');
                foundCount++;
            } else {
                item.style.display = 'none';
                item.classList.remove('active');
            }
        });

        // Show/hide no results message
        if (foundCount === 0) {
            const mainContent = document.querySelector('.main-content');
            let noResults = mainContent.querySelector('.no-results');
            if (!noResults) {
                noResults = document.createElement('div');
                noResults.className = 'no-results';
                noResults.innerHTML = '<p>No results found for "' + query + '"</p>';
                mainContent.appendChild(noResults);
            }
        } else {
            const noResults = document.querySelector('.no-results');
            if (noResults) noResults.remove();
        }
    });
}

