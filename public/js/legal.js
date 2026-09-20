/**
 * Contents rail for the legal pages.
 *
 * Compliance, Privacy and Terms are one unbroken column of numbered sections —
 * fifteen of them on two of the three — with no way to reach one except
 * scrolling. This builds a rail from the document's own headings and keeps the
 * current one marked as you read.
 *
 * Generated rather than written by hand, so the rail cannot drift out of step
 * with the text: a section added, renamed or renumbered is picked up with no
 * second place to update. The markup ships with the rail empty, so a page
 * without scripting is simply the document, which is what it always was.
 */
(() => {
    'use strict';

    const doc = document.getElementById('legalDoc');
    const list = document.getElementById('legalToc');
    if (!doc || !list) return;

    const headings = Array.from(doc.querySelectorAll('h2[id]'));
    if (headings.length === 0) return;

    list.innerHTML = headings.map((heading) => {
        // textContent, not innerHTML: the rail is built from the page's own
        // headings, and it should carry their text rather than their markup.
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `#${heading.id}`;
        link.textContent = heading.textContent;
        item.appendChild(link);
        return item.outerHTML;
    }).join('');

    const links = Array.from(list.querySelectorAll('a'));
    const nav = list.closest('.legal-toc');
    if (nav) nav.hidden = false;

    // The section being read is the last heading that has passed the reading
    // line. A heading still below it has not been reached yet, however much of
    // it is on screen.
    const READING_LINE = 96;
    let current = -1;

    function spy() {
        let active = 0;
        for (let i = 0; i < headings.length; i += 1) {
            if (headings[i].getBoundingClientRect().top <= READING_LINE) active = i;
        }
        if (active === current) return;
        if (current >= 0) links[current].removeAttribute('aria-current');
        links[active].setAttribute('aria-current', 'true');
        current = active;
    }

    // Coalesce to one update per frame: scroll fires far more often than the
    // rail can usefully change.
    let queued = false;
    function onScroll() {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            spy();
        });
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    spy();
})();
