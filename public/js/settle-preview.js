/**
 * The preview under the coin in "Built for payments that settle".
 *
 * Three rows on the rail - Networks, Confirmation, Routing - and three
 * panels in one small screen: a wallet grid, a payment confirming, a review
 * screen. The row nearest the reader's eye (a line a little above the middle
 * of the viewport) is the active one; the pointer over a row takes over
 * while it is there. The active row's panel slides in as the last slides
 * out, and the panel plays its own small scene: the confirmations fill and
 * the pill turns to Paid, the tiles arrive one by one, the dot travels the
 * route.
 *
 * On a phone the stage under the coin would scroll away while the rows are
 * read, so each row gets its own copy of its panel, shown as the row
 * reveals. The choice follows the width live, so a rotated tablet is right.
 */
(() => {
    'use strict';

    const stage = document.getElementById('settlePreview');
    const rows = Array.from(document.querySelectorAll('.settle-rail__row[data-preview]'));
    if (!stage || rows.length === 0) return;

    const panels = new Map(Array.from(stage.querySelectorAll('.settle-preview__panel')).map((p) => [p.dataset.preview, p]));
    const title = document.getElementById('settlePreviewTitle');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const stacked = window.matchMedia('(max-width: 1000px)');

    // ── the confirmation scene: three blocks, then Paid, then the webhook ──
    const timers = new WeakMap();
    function playConfirmation(panel) {
        stopConfirmation(panel);
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
        blocks.forEach((b, i) => list.push(setTimeout(() => { b.classList.add('is-done'); if (count) count.textContent = `${i + 1} of 3`; }, 320 + step * i)));
        list.push(setTimeout(() => { if (pill) { pill.textContent = 'Paid'; pill.classList.add('is-paid'); } }, 320 + step * blocks.length + 120));
        list.push(setTimeout(() => { if (hook) hook.classList.add('is-on'); }, 320 + step * blocks.length + 480));
        timers.set(panel, list);
    }
    function stopConfirmation(panel) {
        (timers.get(panel) || []).forEach(clearTimeout);
        timers.delete(panel);
    }

    // ── the stage: one panel showing, the others waiting ──────────────────
    let current = null;
    function show(name) {
        if (name === current || !panels.has(name)) return;
        const leaving = current ? panels.get(current) : null;
        const entering = panels.get(name);
        current = name;
        if (leaving) {
            leaving.classList.add('is-leaving');
            leaving.classList.remove('is-active');
            setTimeout(() => leaving.classList.remove('is-leaving'), 300);
            if (leaving.dataset.preview === 'confirmation') stopConfirmation(leaving);
        }
        entering.classList.add('is-active');
        if (title) title.textContent = entering.dataset.title || '';
        if (entering.dataset.preview === 'confirmation') playConfirmation(entering);
        rows.forEach((r) => r.classList.toggle('is-active', r.dataset.preview === name));
    }

    // The row whose middle is nearest a line 42% down the viewport.
    function nearestRow() {
        const line = window.innerHeight * 0.42;
        let best = null;
        let bestDistance = Infinity;
        for (const row of rows) {
            const box = row.getBoundingClientRect();
            const distance = Math.abs((box.top + box.bottom) / 2 - line);
            if (distance < bestDistance) { bestDistance = distance; best = row; }
        }
        return best;
    }

    let hovered = null;
    let inView = false;
    let ticking = false;
    const pointer = { x: -1, y: -1 };
    document.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });

    // The pointer holds a row only while it is really over it: rows scroll
    // past a resting pointer without a pointerleave the page can rely on.
    function stillHovered() {
        if (!hovered) return false;
        if (pointer.x < 0) return true;
        const under = document.elementFromPoint(pointer.x, pointer.y);
        return Boolean(under && under.closest && under.closest('.settle-rail__row') === hovered);
    }

    function onScroll() {
        if (ticking || stacked.matches || !inView) return;
        if (hovered && !stillHovered()) hovered = null;
        if (hovered) return;
        ticking = true;
        requestAnimationFrame(() => {
            ticking = false;
            const row = nearestRow();
            if (row) show(row.dataset.preview);
        });
    }

    for (const row of rows) {
        row.addEventListener('pointerenter', () => { if (stacked.matches) return; hovered = row; show(row.dataset.preview); });
        row.addEventListener('pointerleave', () => { hovered = null; onScroll(); });
        row.addEventListener('focusin', () => { if (!stacked.matches) show(row.dataset.preview); });
    }

    const section = stage.closest('.settle') || stage;
    if ('IntersectionObserver' in window) {
        new IntersectionObserver((entries) => {
            inView = entries.some((e) => e.isIntersecting);
            if (inView) onScroll();
        }, { threshold: 0.05 }).observe(section);
    } else {
        inView = true;
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    // ── stacked: a copy of each panel inside its row ──────────────────────
    const copies = new Map();
    function layout() {
        if (stacked.matches) {
            for (const row of rows) {
                if (copies.has(row)) continue;
                const panel = panels.get(row.dataset.preview);
                if (!panel) continue;
                const frame = document.createElement('div');
                frame.className = 'settle-preview';
                const inner = document.createElement('div');
                inner.className = 'settle-preview__frame';
                const bar = stage.querySelector('.settle-preview__bar').cloneNode(true);
                bar.querySelector('span').textContent = panel.dataset.title || '';
                bar.querySelector('span').removeAttribute('id');
                const body = document.createElement('div');
                body.className = 'settle-preview__body';
                const copy = panel.cloneNode(true);
                copy.classList.add('is-active');
                copy.classList.remove('is-leaving');
                body.appendChild(copy);
                inner.appendChild(bar);
                inner.appendChild(body);
                frame.appendChild(inner);
                row.querySelector('dd').appendChild(frame);
                copies.set(row, { frame, copy });
                if (copy.dataset.preview === 'confirmation') {
                    // play once the row is on screen, so the count is watched
                    if ('IntersectionObserver' in window) {
                        const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { playConfirmation(copy); io.disconnect(); } }, { threshold: 0.4 });
                        io.observe(copy);
                    } else {
                        playConfirmation(copy);
                    }
                }
            }
            rows.forEach((r) => r.classList.remove('is-active'));
        } else {
            for (const [row, { frame, copy }] of copies) { stopConfirmation(copy); frame.remove(); copies.delete(row); }
            if (!current) show(rows[0].dataset.preview);
            onScroll();
        }
    }
    layout();
    if (typeof stacked.addEventListener === 'function') stacked.addEventListener('change', layout);
    else stacked.addListener(layout);

    // The first panel is on from the start, so the stage is never blank.
    if (!stacked.matches) show(rows[0].dataset.preview);
})();
