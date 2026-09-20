/**
 * Theme switching.
 *
 * Three states, matching how tokens.css is written:
 *   'light' / 'dark'  an explicit choice, stamped on <html data-theme>
 *   'system'          no stamp; prefers-color-scheme decides
 *
 * This file must be loaded in <head>, before any stylesheet renders, so the
 * stored choice is applied before first paint. Applying it later means the page
 * paints light and then flips, which is worse than having no dark mode at all.
 */
(() => {
    'use strict';

    const STORAGE_KEY = 'theme';
    const root = document.documentElement;

    function stored() {
        try {
            const value = localStorage.getItem(STORAGE_KEY);
            return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
        } catch {
            // Private browsing, or site data blocked. Follow the OS.
            return 'system';
        }
    }

    function apply(preference) {
        if (preference === 'system') {
            root.removeAttribute('data-theme');
        } else {
            root.setAttribute('data-theme', preference);
        }
    }

    // Run immediately, before the body exists.
    apply(stored());

    // Marks that scripting is available, from inside <head> and so before the
    // first paint. It lets a stylesheet keep a readable resting state for a
    // component that JavaScript would otherwise collapse — the FAQ's answers
    // stay open without this class — and collapse it on the first frame rather
    // than after a visible flash.
    root.classList.add('js');

    /** What is actually on screen right now, resolving 'system'. */
    function resolved() {
        const preference = stored();
        if (preference !== 'system') return preference;
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    /**
     * Cycle light -> dark -> system. Keeping 'system' in the rotation means a
     * viewer can hand control back to their OS after having chosen once.
     */
    function cycleTheme() {
        const order = ['light', 'dark', 'system'];
        const next = order[(order.indexOf(stored()) + 1) % order.length];

        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // Not fatal - the choice just will not survive a reload.
        }

        apply(next);
        window.dispatchEvent(new CustomEvent('themechange', { detail: { preference: next, resolved: resolved() } }));
        return next;
    }

    // Track the OS while the viewer is on 'system', so the page follows a
    // change made outside the browser without needing a reload.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => {
        if (stored() === 'system') {
            window.dispatchEvent(new CustomEvent('themechange', { detail: { preference: 'system', resolved: resolved() } }));
        }
    };
    if (media.addEventListener) media.addEventListener('change', onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);

    window.Theme = { get: stored, resolved, set: apply, cycle: cycleTheme };
    window.cycleTheme = cycleTheme;
})();
