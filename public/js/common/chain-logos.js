/**
 * Chain marks, in one colour.
 *
 * Each supported chain's mark as a small SVG drawn in currentColor, so it
 * takes the badge's ink in either theme - white on the dark surface, black on
 * the light one - rather than ten brand colours fighting the page. They are
 * simplified redrawings of the marks, not the official artwork: one entry per
 * chain, so an official monochrome file can replace any of them.
 *
 *   chainLogo('ETH', 'ETH')  -> the mark
 *   chainLogo('XYZ', 'XYZ')  -> the fallback text, for a chain with no mark
 *
 * The fallback is returned as given: callers escape it themselves.
 */
(() => {
    'use strict';

    const svg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${inner}</svg>`;
    const stroke = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

    const MARKS = {
        // The diamond: two halves above, two below.
        ETH: svg('<path fill="currentColor" d="M11.944 17.97 4.58 13.62 11.943 24l7.37-10.38-7.372 4.35zM12.056 0 4.69 12.223l7.365 4.354 7.365-4.35z"/>'),

        // A B with the two bars, tilted as the mark is, in a ring.
        BTC: svg(`<circle cx="12" cy="12" r="9.2" ${stroke}/><g transform="rotate(-12 12 12)" ${stroke}><path d="M9.6 7.2v9.6M11.2 7.2V5.6M11.2 18.4v-1.6M13.6 7.2V5.6M13.6 18.4v-1.6M9.6 7.2h3.9a2.1 2.1 0 0 1 0 4.2H9.6M9.6 11.4h4.4a2.4 2.4 0 0 1 0 4.8H9.6"/></g>`),

        // An L with the bar through it, in a ring.
        LTC: svg(`<circle cx="12" cy="12" r="9.2" ${stroke}/><path d="M10.2 6.4v11.2h6.2M7.9 13.1l5.6-2.2" ${stroke}/>`),

        // Three bars, the ends cut on alternating slants.
        SOL: svg('<path fill="currentColor" d="M7 5.5h13l-3 3H4zM4 10.5h13l3 3H7zM7 15.5h13l-3 3H4z"/>'),

        // The two linked shapes.
        POL: svg(`<path d="M3.5 15.4V9.2l4.2-2.4 4.2 2.4v6.2M12 9.2l4.3-2.4 4.2 2.4v6.2l-4.2 2.4-4.3-2.4M7.7 17.6l-4.2-2.2M16.3 17.8l-4.3-2.4" ${stroke}/>`),

        // A disc with the slot on its left.
        BASE: svg('<path fill="currentColor" fill-rule="evenodd" d="M12 2.8a9.2 9.2 0 1 1 0 18.4 9.2 9.2 0 0 1 0-18.4zM3 11h8.2v2H3z"/>'),

        // The shield with the A inside.
        ARB: svg(`<path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z" ${stroke}/><path d="M8.6 16.4 12 7.6l3.4 8.8M10.1 12.9h3.8" ${stroke}/>`),

        // The letters, in a ring.
        OP: svg(`<circle cx="12" cy="12" r="9.2" ${stroke}/><circle cx="8.9" cy="12" r="2.6" ${stroke}/><path d="M13.9 15V9h2.1a1.9 1.9 0 0 1 0 3.8h-2.1" ${stroke}/>`),

        // The centre lozenge and the four around it.
        BNB: svg('<path fill="currentColor" d="M12 9.4 14.6 12 12 14.6 9.4 12zM12 3.2l3.3 3.3-1.9 1.9L12 7l-1.4 1.4-1.9-1.9zM12 20.8l-3.3-3.3 1.9-1.9L12 17l1.4-1.4 1.9 1.9zM5.2 12l1.9-1.9L9 12l-1.9 1.9zM17 12l1.9-1.9 1.9 1.9-1.9 1.9z"/>'),

        // The peak with the notch cut from its foot.
        AVAX: svg('<path fill="currentColor" d="M12 3 3 19.2h6.4l2.6-4.6 2.6 4.6H21z"/>'),
    };

    window.CHAIN_LOGOS = MARKS;

    window.chainLogo = function chainLogo(code, fallback) {
        return MARKS[String(code || '').toUpperCase()] || (fallback == null ? '' : String(fallback));
    };
})();
