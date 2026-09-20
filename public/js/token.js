/**
 * The settlement token: a rotating coin with a paper plane in orbit around it,
 * dropping parachuted supply coins as it goes.
 *
 * Everything here is progressive. The section's copy, the receipt and the
 * network count are all in the markup and render without this file; what this
 * adds is the coin itself, the drops, the per-item entrance cascades, and the
 * live figures fetched from the status API. If it never runs, the section is
 * still complete — just still.
 */
(() => {
    'use strict';

    const scene = document.getElementById('tokenScene');
    if (!scene) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    // ── The coin ─────────────────────────────────────────────────────────────
    // R and T are the scene's own units: the rim sits at R, and each edge panel
    // is T wide, which is the coin's thickness.
    const R = 120;
    const N = 48;

    /**
     * The coin face, drawn flat.
     *
     * The navbar mark is a fixed three-quarter view and cannot be reused here —
     * this face has to be seen straight on. Same construction though: a hollow
     * bubble E cut out of solid strokes by a mask, over a ring of rim beads.
     *
     * The mask sits on a transform-free wrapper. Putting it on the same element
     * as the placement transform applies that transform to the hole as well as
     * the letter, and the hollow drifts off the glyph.
     */
    function face(maskId) {
        const beads = Array.from({ length: 26 }, (_, i) => {
            const a = (2 * Math.PI * i) / 26;
            const cx = (16 + 12.9 * Math.cos(a)).toFixed(2);
            const cy = (16 + 12.9 * Math.sin(a)).toFixed(2);
            return `<circle cx="${cx}" cy="${cy}" r=".42"/>`;
        }).join('');

        const glyph = (w1, w2) => `
            <g transform="translate(16 16) scale(1.25) translate(-16 -16)"
               stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.05 9.15V11.4M17.95 9.15V11.4M14.05 20.6V22.85M17.95 20.6V22.85" stroke-width="${w1}"/>
              <path d="M19.6 11.4H12.4V20.6H19.6" stroke-width="${w2}"/>
              <path d="M12.4 16H18.4" stroke-width="${w2}"/>
            </g>`;

        return `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <defs>
            <mask id="${maskId}" maskUnits="userSpaceOnUse" x="-16" y="-16" width="64" height="64">
              <rect x="-16" y="-16" width="64" height="64" fill="#fff"/>
              <g stroke="#000">${glyph(1.8, 1.7)}</g>
            </mask>
          </defs>
          <g stroke="currentColor">
            <circle cx="16" cy="16" r="15.1" stroke-width="1.5"/>
            <g fill="currentColor" stroke="none">${beads}</g>
            <g mask="url(#${maskId})">${glyph(3.3, 3.2)}</g>
          </g>
        </svg>`;
    }

    document.getElementById('tokenFaceFront').innerHTML = face('tokenHollowF');
    document.getElementById('tokenFaceBack').innerHTML = face('tokenHollowB');

    // The rim is N panels, each turned edge-on so its width reads as thickness.
    // 24 panels leave the silhouette 1.03px short of a true circle at its widest,
    // which shows as flat spots; 48 puts that at 0.26px, under what the pixels
    // can resolve.
    document.getElementById('tokenEdge').innerHTML = Array.from({ length: N }, (_, i) =>
        `<i style="transform:rotateZ(${((i * 360) / N).toFixed(2)}deg) translateX(${R}px) rotateY(90deg)"></i>`
    ).join('');

    // ── Supply drops ─────────────────────────────────────────────────────────
    // The six chains drawn as monochrome glyphs rather than brand marks: the
    // rest of this section is currentColor line work, and a coloured logo
    // dropped into it reads as a foreign object.
    const CHAIN_GLYPHS = {
        ETH: 'M12 3 6 12.4l6 3.5 6-3.5L12 3Zm0 14.2-6-3.5L12 21l6-7.3-6 3.5Z',
        BTC: 'M10.2 5.2h1.7v2h1.1v-2h1.7v2.1a3.2 3.2 0 0 1 2.1 2.9c0 .9-.4 1.6-1 2a2.9 2.9 0 0 1 1.5 2.5c0 1.6-1.2 2.9-2.6 3.1v2.1h-1.7v-2h-1.1v2h-1.7v-2H7.4V6.6h2.8v-1.4Zm-1 4.2v2.6h2.9c.8 0 1.4-.6 1.4-1.3 0-.7-.6-1.3-1.4-1.3H9.2Zm0 4.3v2.9h3.3c.9 0 1.6-.6 1.6-1.4s-.7-1.5-1.6-1.5H9.2Z',
        LTC: 'M13.4 4.4h3.2l-2 7.6 2.6-.8-.5 2-2.6.8-1 3.7h6.1l-.6 2.3H8.4l1.6-5.9-2.2.7.5-2 2.3-.7 2.8-7.7Z',
        SOL: 'M6.6 15.6a.6.6 0 0 1 .4-.2h11.4c.3 0 .5.4.3.7l-2.3 2.4a.6.6 0 0 1-.4.2H4.6a.4.4 0 0 1-.3-.7l2.3-2.4Zm0-9a.6.6 0 0 1 .4-.2h11.4c.3 0 .5.4.3.7l-2.3 2.4a.6.6 0 0 1-.4.2H4.6a.4.4 0 0 1-.3-.7L6.6 6.6Zm9.8 4.5a.6.6 0 0 0-.4-.2H4.6a.4.4 0 0 0-.3.7l2.3 2.4c.1.1.2.2.4.2h11.4c.3 0 .5-.4.3-.7l-2.3-2.4Z',
        AVAX: 'M12 3.4 21 19.2H3L12 3.4Zm0 4.9-4.4 7.7h8.8L12 8.3Z',
        POL: 'M15.8 8.6a.9.9 0 0 0-.9 0l-2.1 1.2-1.4.8-2.1 1.2a.9.9 0 0 1-.9 0l-1.7-1a.9.9 0 0 1-.4-.7V8.2c0-.3.2-.6.4-.7l1.6-1a.9.9 0 0 1 .9 0l1.7 1c.2.1.4.4.4.7v1.2l1.4-.8V7.4a.9.9 0 0 0-.4-.7l-3-1.8a.9.9 0 0 0-.9 0l-3.1 1.8a.9.9 0 0 0-.5.7v3.6c0 .3.2.6.5.7l3.1 1.8a.9.9 0 0 0 .9 0l2.1-1.2 1.4-.8 2.1-1.2a.9.9 0 0 1 .9 0l1.6 1c.3.1.5.4.5.7v2c0 .2-.2.5-.5.6l-1.6 1a.9.9 0 0 1-.9 0l-1.7-1a.9.9 0 0 1-.4-.7v-1.2l-1.4.8v1.2c0 .3.2.6.4.7l3.1 1.8a.9.9 0 0 0 .9 0l3.1-1.8c.2-.1.4-.4.4-.7v-3.6a.9.9 0 0 0-.4-.7l-3.1-1.8Z',
    };
    const TICKERS = Object.keys(CHAIN_GLYPHS);

    // The canopy started as a semicircle 32 wide on a radius of 16, which put its
    // apex at y = -2: two pixels above the viewBox, clipped off, which read as a
    // gap in the top. A radius can never be less than half its chord, so the
    // canopy had to narrow — 28 wide on a radius of 14 puts the apex at y = 1.
    // The rigging converges on a single point so the coin has something to hang
    // from rather than two lines ending near it.
    const CHUTE = `<svg class="drop__chute" viewBox="0 0 36 32" fill="none" aria-hidden="true">
        <path d="M4 15a14 14 0 0 1 28 0" stroke="currentColor" stroke-width="1.6"/>
        <path d="M4 15q3.5 5 7 0 3.5 5 7 0 3.5 5 7 0 3.5 5 7 0" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M4 15 18 31M11 17.4 18 31M25 17.4 18 31M32 15 18 31" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
      </svg>`;

    const dropCoin = (ticker) => `<svg class="drop__coin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10.4" stroke="currentColor" stroke-width="1.5"/>
        <path d="${CHAIN_GLYPHS[ticker]}" fill="currentColor"/>
      </svg>`;

    const dropsHost = document.getElementById('tokenDrops');
    const stageEl = document.querySelector('.token-stage');

    function dropSupply() {
        const body = document.querySelector('.plane__body');
        if (!body || !dropsHost || !stageEl) return;

        // The plane's live screen position, not a guess from the orbit angle: it
        // is inside a rotating 3D subtree, so its rect is the only honest source.
        const b = body.getBoundingClientRect();
        const host = stageEl.getBoundingClientRect();
        if (!b.width || !host.height) return;

        const y = b.top + b.height / 2 - host.top;
        // Only from the upper arc. Released from the bottom of the orbit there is
        // no room left to fall and the chute lands outside the section.
        if (y > host.height * 0.52) return;

        // The overlay sits outside .token-scene so it does not inherit the 3D
        // transform — which also means it does not inherit the mobile scale, and
        // a drop would otherwise fall a full-size distance through a scene that
        // is two-thirds the size.
        const scale = parseFloat(getComputedStyle(stageEl).getPropertyValue('--token-scale')) || 1;

        const el = document.createElement('div');
        el.className = 'drop';
        el.style.left = `${b.left + b.width / 2 - host.left}px`;
        el.style.top = `${y}px`;
        el.style.setProperty('--s', scale);
        el.style.setProperty('--sway', `${((Math.random() * 44 - 22) * scale).toFixed(0)}px`);
        el.style.setProperty('--fall', `${(130 * scale).toFixed(0)}px`);

        const ticker = TICKERS[Math.floor(Math.random() * TICKERS.length)];
        // The chute and its load rock as one rigid body. On the canopy alone the
        // rigging swung away from a coin that stayed put, and the two visibly
        // came apart. The burst ring needs its own copy of the rock because it
        // cannot live inside the element running the pop.
        el.innerHTML =
            `<div class="drop__inner"><div class="drop__rig">${CHUTE}${dropCoin(ticker)}</div></div>` +
            '<div class="drop__rig drop__rig--burst"><span class="drop__ring"></span></div>';

        dropsHost.appendChild(el);

        // A timer, not animationend: the event does not fire reliably when the
        // tab throttles animations, and a missed one leaves the chute in the DOM
        // for good. They were accumulating a node per drop.
        setTimeout(() => el.remove(), 3600);
    }

    let dropTimer = null;
    function scheduleDrop() {
        // Irregular, so it never settles into a metronome.
        dropTimer = setTimeout(() => { dropSupply(); scheduleDrop(); }, 2200 + Math.random() * 2600);
    }

    if (!reduced.matches) {
        setTimeout(() => { dropSupply(); scheduleDrop(); }, 900);
        // Nothing spawns while the tab is hidden, otherwise a minute away leaves
        // a pile of chutes to animate the moment it comes back.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                clearTimeout(dropTimer);
                dropTimer = null;
            } else if (!dropTimer) {
                scheduleDrop();
            }
        });
    }

    // ── Entrance cascades ────────────────────────────────────────────────────
    // The section's own reveal is the site's [data-reveal] observer. These are
    // the cascades *inside* a revealed block, so the row resolves into its
    // detail instead of arriving whole. Index goes in a custom property and the
    // stylesheet does the arithmetic, so a missed element is simply undelayed
    // rather than invisible.
    function cascade(selector, step, base) {
        document.querySelectorAll(selector).forEach((el, i) => {
            el.style.setProperty('--cascade-delay', `${base + i * step}ms`);
        });
    }
    cascade('.settle-rail__chains i', 34, 300);
    cascade('.settle-rail__ticks i', 90, 430);
    cascade('.settle-receipt__body > div', 80, 560);

    /**
     * The cascade delay is for the entrance and nothing else.
     *
     * Left in place it goes on delaying every *later* transition on those
     * properties too: switching the theme made the confirmation ticks change
     * colour half a second after the rest of the page had already changed.
     * So once a block has entered and its children have landed, the delay is
     * dropped and they behave like ordinary elements again.
     */
    const CASCADE_SETTLED = 1600;

    function dropCascadeDelay(parent, childSelector) {
        setTimeout(() => {
            parent.querySelectorAll(childSelector).forEach((child) => {
                child.style.removeProperty('--cascade-delay');
            });
        }, CASCADE_SETTLED);
    }

    function whenRevealed(parentSelector, childSelector) {
        document.querySelectorAll(parentSelector).forEach((parent) => {
            if (parent.classList.contains('is-revealed')) {
                dropCascadeDelay(parent, childSelector);
                return;
            }
            const watcher = new MutationObserver(() => {
                if (!parent.classList.contains('is-revealed')) return;
                watcher.disconnect();
                dropCascadeDelay(parent, childSelector);
            });
            watcher.observe(parent, { attributes: true, attributeFilter: ['class'] });
        });
    }

    whenRevealed('.settle-rail__row', '.settle-rail__chains i, .settle-rail__ticks i');
    whenRevealed('.settle-receipt', '.settle-receipt__body > div');

    // ── Live figures ─────────────────────────────────────────────────────────
    // The strip ships empty and is filled from the status API, so it can never
    // claim an uptime the status page would contradict. On failure it stays
    // empty rather than inventing one — the network count beside it is a
    // build-time fact and is already in the markup.
    const liveHost = document.getElementById('liveStatus');
    if (liveHost) {
        liveHost.dataset.state = 'loading';
        liveHost.innerHTML =
            '<span class="live-line__item"><i class="live-line__dot"></i><b class="live-line__val">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</b></span>' +
            '<span class="live-line__sep"></span>' +
            '<span class="live-line__item"><b class="live-line__val">&nbsp;&nbsp;&nbsp;&nbsp;</b>&nbsp;uptime</span>' +
            '<span class="live-line__sep"></span>' +
            '<span class="live-line__item"><b class="live-line__val">&nbsp;&nbsp;&nbsp;</b>&nbsp;services</span>' +
            '<span class="live-line__sep"></span>';

        const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));

        fetch('/api/status', { headers: { Accept: 'application/json' } })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
            .then((data) => {
                if (!data || data.success === false) throw new Error('unavailable');

                const tone = ['operational', 'degraded', 'down'].includes(data.overallStatus)
                    ? data.overallStatus
                    : 'operational';
                const uptime = Number(data.uptimePercentage);
                const days = Number(data.windowDays);
                const ok = Number(data.operationalCount);
                const total = Number(data.totalCount);

                const parts = [
                    `<span class="live-line__item"><i class="live-line__dot" data-tone="${tone}"></i>` +
                    `<b>${esc(data.overallStatusLabel || 'Operational')}</b></span>`,
                ];
                if (Number.isFinite(uptime) && Number.isFinite(days)) {
                    // Whole numbers stay whole: "100% uptime", not "100.0%".
                    const shown = Number.isInteger(uptime) ? uptime : uptime.toFixed(2);
                    parts.push('<span class="live-line__sep"></span>');
                    parts.push(`<span class="live-line__item"><b>${shown}%</b> uptime &middot; ${days} days</span>`);
                }
                if (Number.isFinite(ok) && Number.isFinite(total)) {
                    parts.push('<span class="live-line__sep"></span>');
                    parts.push(`<span class="live-line__item"><b>${ok}/${total}</b> services</span>`);
                }
                parts.push('<span class="live-line__sep"></span>');

                liveHost.innerHTML = parts.join('');
                liveHost.dataset.state = 'ready';
            })
            .catch(() => {
                liveHost.innerHTML = '';
                liveHost.dataset.state = 'failed';
            });
    }
})();
