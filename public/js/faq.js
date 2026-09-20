/**
 * FAQ: accordion state and the question filter.
 *
 * Progressive. All eighteen questions and answers are in the markup, so the
 * page reads and indexes without this file; what it adds is collapsing the
 * answers and filtering the list.
 *
 * That ordering matters for the collapse in particular. The answers rest OPEN
 * in the stylesheet, and only `html.js` — set by theme.js from inside <head> —
 * collapses them. So a visitor without scripting gets a long page with every
 * answer showing, rather than eighteen headings that do nothing, and a visitor
 * with it sees them collapsed on the first paint rather than after a flash.
 *
 * This file's job is to stamp aria-expanded on, and toggle it. Until it runs
 * the attribute is absent, which is honest: without scripting these are not
 * disclosure widgets and should not claim to be.
 */
(() => {
    'use strict';

    const list = document.getElementById('faqList');
    if (!list) return;

    // ── Accordion ────────────────────────────────────────────────────────────
    // The buttons carry aria-expanded in the markup, so state lives in one
    // place and the CSS keys off the same attribute the screen reader reads.
    // Answers stay independent of one another: comparing two is worth more than
    // keeping the page short.
    list.addEventListener('click', (event) => {
        const button = event.target.closest('.qa__q');
        if (!button || !list.contains(button)) return;
        const open = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', open ? 'false' : 'true');
    });

    // ── Filter ───────────────────────────────────────────────────────────────
    const input = document.getElementById('faqSearch');
    const cats = document.getElementById('faqCats');
    const count = document.getElementById('faqCount');
    const empty = document.getElementById('faqEmpty');
    const term = document.getElementById('faqTerm');
    if (!input || !cats || !count) return;

    let category = 'all';

    function apply() {
        const needle = input.value.trim().toLowerCase();
        let shown = 0;

        for (const group of list.querySelectorAll('.qa-group')) {
            const inCategory = category === 'all' || group.dataset.group === category;
            let matches = 0;

            for (const qa of group.querySelectorAll('.qa')) {
                // data-text is the question and its answer, tags stripped and
                // lowercased at build time, so a search covers both.
                const hit = inCategory && (!needle || qa.dataset.text.includes(needle));
                qa.hidden = !hit;
                if (hit) matches += 1;
            }

            // A group heading with nothing under it reads as a broken filter.
            group.hidden = matches === 0;
            shown += matches;
        }

        count.textContent = shown === 1 ? '1 question' : `${shown} questions`;

        if (empty && term) {
            // textContent, not innerHTML: this is whatever the visitor typed.
            term.textContent = `“${input.value.trim()}”`;
            empty.hidden = shown > 0;
        }
    }

    input.addEventListener('input', apply);

    // Escape clears the field, which is what a search input is expected to do.
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && input.value) {
            input.value = '';
            apply();
        }
    });

    cats.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        category = button.dataset.cat;
        for (const chip of cats.querySelectorAll('button')) {
            chip.setAttribute('aria-pressed', String(chip === button));
        }
        apply();
    });

    // The stylesheet has already collapsed them; this makes that state readable
    // to assistive tech. Then run the filter once, so the count comes from the
    // markup rather than from a number baked into the page.
    for (const button of list.querySelectorAll('.qa__q')) {
        button.setAttribute('aria-expanded', 'false');
    }
    apply();
})();
