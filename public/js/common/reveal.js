/**
 * Reveal-on-scroll.
 *
 * Elements marked `data-reveal` fade and rise into place as they enter the
 * viewport. `data-reveal-delay="120"` staggers one behind its neighbours.
 *
 * Two things this deliberately does *not* do:
 *
 *  - It does not animate anything already on screen at load. Those are revealed
 *    immediately, so the first frame a visitor sees is complete rather than
 *    blank-then-populated.
 *  - It does not leave anything hidden if it cannot run. The CSS only hides
 *    `[data-reveal]` inside a `prefers-reduced-motion: no-preference` query, and
 *    this file reveals everything unconditionally when IntersectionObserver is
 *    missing.
 */
(() => {
    'use strict';

    function revealAll(nodes) {
        nodes.forEach((node) => node.classList.add('is-revealed'));
    }

    function init() {
        const nodes = Array.from(document.querySelectorAll('[data-reveal]'));
        if (nodes.length === 0) return;

        // Respect the OS preference: show everything, animate nothing.
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
            typeof IntersectionObserver === 'undefined') {
            revealAll(nodes);
            return;
        }

        for (const node of nodes) {
            const delay = node.getAttribute('data-reveal-delay');
            if (delay) node.style.setProperty('--reveal-delay', `${delay}ms`);
        }

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                // Reveal when the element comes into view, and also when it has
                // ended up *above* the viewport. A jump scroll — an anchor link,
                // a restored scroll position, a flick on a trackpad — can take an
                // element from below the fold to above it between two frames,
                // firing the callback with isIntersecting false. Without this
                // second case those elements stay invisible permanently.
                const passed = entry.boundingClientRect.bottom < 0;
                if (!entry.isIntersecting && !passed) continue;

                entry.target.classList.add('is-revealed');
                observer.unobserve(entry.target);
            }
        }, {
            // Start slightly before the element is fully on screen, so the
            // motion finishes about when it reaches a comfortable reading spot.
            rootMargin: '0px 0px -8% 0px',
            threshold: 0.05,
        });

        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const pending = [];

        for (const node of nodes) {
            // Anything already on screen, or already scrolled past, is shown at
            // once rather than animated in.
            const rect = node.getBoundingClientRect();
            if (rect.top < viewportHeight * 0.9) {
                node.classList.add('is-revealed');
            } else {
                pending.push(node);
                observer.observe(node);
            }
        }

        // Last resort: content must never stay hidden because of an animation.
        // If anything is still unrevealed after a few seconds, show it.
        if (pending.length > 0) {
            setTimeout(() => {
                for (const node of pending) {
                    if (!node.classList.contains('is-revealed')) {
                        node.classList.add('is-revealed');
                        observer.unobserve(node);
                    }
                }
            }, 4000);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

/**
 * Count-up for stat figures.
 *
 * `data-count-to="99.9" data-count-suffix="%" data-count-decimals="1"` counts
 * from zero when the element scrolls into view.
 *
 * The final value is already written in the markup, so the number is correct
 * with JavaScript disabled, under reduced motion, and if this never runs. The
 * animation only replaces text that is about to say the same thing anyway.
 */
(() => {
    'use strict';

    function animate(el) {
        const target = parseFloat(el.getAttribute('data-count-to'));
        if (!Number.isFinite(target)) return;

        const decimals = parseInt(el.getAttribute('data-count-decimals') || '0', 10);
        const suffix = el.getAttribute('data-count-suffix') || '';
        const duration = 1100;
        const start = performance.now();

        function frame(now) {
            const progress = Math.min((now - start) / duration, 1);
            // Ease out, so it decelerates into the final figure.
            const eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = (target * eased).toFixed(decimals) + suffix;
            if (progress < 1) requestAnimationFrame(frame);
        }

        requestAnimationFrame(frame);
    }

    function init() {
        const nodes = Array.from(document.querySelectorAll('[data-count-to]'));
        if (nodes.length === 0) return;

        // Reduced motion, or no observer: leave the markup's value in place.
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
            typeof IntersectionObserver === 'undefined') {
            return;
        }

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                animate(entry.target);
                observer.unobserve(entry.target);
            }
        }, { threshold: 0.4 });

        nodes.forEach((node) => observer.observe(node));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
