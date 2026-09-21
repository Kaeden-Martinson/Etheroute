/**
 * The previews on the rail in "Built for payments that settle".
 *
 * Each of the three rows - Networks, Confirmation, Routing - carries a small
 * screen under its text: the wallet grid, a payment confirming, the review.
 * The scroll decides which one is open: the row being read is the last row
 * whose top has passed a line a little above the middle of the viewport.
 * Its preview slides open from under the text and plays its scene; the one
 * open before folds shut in the same instant, and the scroll is moved by
 * exactly the height that fold took away, so nothing under the eye shifts.
 * There is no hover and nothing to tap: reading down the rail is the control.
 */
(() => {
    'use strict';

    const rows = Array.from(document.querySelectorAll('.settle-rail__row[data-preview]'));
    if (rows.length === 0) return;
    const section = rows[0].closest('.settle') || rows[0].parentElement;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const previewOf = (row) => row.querySelector('.settle-preview');

    // ── the confirmation scene: three blocks, then Paid, then the webhook ──
    const timers = new Map();
    function playConfirmation(row) {
        stopConfirmation(row);
        const panel = row.querySelector('[data-preview="confirmation"].settle-preview__panel');
        if (!panel) return;
        const blocks = panel.querySelectorAll('.sp-confs i');
        const count = panel.querySelector('[data-confs]');
        const pill = panel.querySelector('[data-pill]');
        const hook = panel.querySelector('[data-hook]');
        blocks.forEach((b) => b.classList.remove('is-done'));
        if (count) count.textContent = '0 of 3';
        if (pill) { pill.textContent = 'Confirming'; pill.classList.remove('is-paid'); }
        if (hook) hook.classList.remove('is-on');
        const step = reduceMotion.matches ? 0 : 520;
        const list = [];
        blocks.forEach((b, i) => list.push(setTimeout(() => { b.classList.add('is-done'); if (count) count.textContent = `${i + 1} of 3`; }, 480 + step * i)));
        list.push(setTimeout(() => { if (pill) { pill.textContent = 'Paid'; pill.classList.add('is-paid'); } }, 480 + step * blocks.length + 120));
        list.push(setTimeout(() => { if (hook) hook.classList.add('is-on'); }, 480 + step * blocks.length + 480));
        timers.set(row, list);
    }
    function stopConfirmation(row) {
        (timers.get(row) || []).forEach(clearTimeout);
        timers.delete(row);
    }

    // ── one row open at a time ───────────────────────────────────────────
    let current = null;
    function open(row) {
        if (row === current) return;
        const previous = current;
        current = row;

        // The fold is instant and the scroll follows it: the height the
        // previous preview gave up is taken off the scroll position, so the
        // row being opened does not move under the eye.
        const before = row.getBoundingClientRect().top;
        if (previous) {
            previous.classList.add('is-folding');
            previous.classList.remove('is-active');
            stopConfirmation(previous);
            const p = previewOf(previous);
            if (p) p.setAttribute('aria-hidden', 'true');
            // lay the fold out now, before the class that restores the transition goes
            void previous.offsetHeight;
            previous.classList.remove('is-folding');
        }
        // measured after that layout, so a browser that already anchored the
        // scroll to the row is not moved a second time
        const after = row.getBoundingClientRect().top;
        if (after !== before) scrollNow(after - before);

        row.classList.add('is-active');
        const preview = previewOf(row);
        if (preview) preview.setAttribute('aria-hidden', 'false');
        if (row.dataset.preview === 'confirmation') playConfirmation(row);
    }

    // The page scrolls smoothly to anchors; this one move must not.
    function scrollNow(by) {
        const root = document.documentElement;
        const was = root.style.scrollBehavior;
        root.style.scrollBehavior = 'auto';
        window.scrollBy(0, by);
        root.style.scrollBehavior = was;
    }

    // The last row whose top has passed the line, or the first row until any has.
    function rowForScroll() {
        const line = window.innerHeight * 0.45;
        let pick = null;
        for (const row of rows) {
            if (row.getBoundingClientRect().top <= line) pick = row;
        }
        return pick || rows[0];
    }

    // One pick per few frames, and only while the section is on screen.
    let pending = false;
    function onScroll() {
        if (pending) return;
        pending = true;
        setTimeout(() => {
            pending = false;
            const r = section.getBoundingClientRect();
            if (r.bottom <= 0 || r.top >= window.innerHeight) return;
            open(rowForScroll());
        }, 40);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
})();
