/**
 * Declarative event binding.
 *
 * The content security policy sets `script-src-attr 'none'`, which blocks inline
 * `onclick=` / `onsubmit=` attributes outright - they are one of the main ways an
 * HTML injection turns into script execution. Markup declares intent instead:
 *
 *   <button data-on-click="switchTab" data-arg="signup">Sign Up</button>
 *   <form data-on-submit="handleSignIn">
 *   <div data-on-click="toggleFaq" data-arg="@this">
 *
 * One delegated listener per event type resolves the named function and calls it.
 * Because binding happens at the document, markup added later works with no
 * rebinding step.
 *
 * Argument rules:
 *   no data-arg      -> the function receives the event
 *   data-arg="@this" -> the element carrying the attribute
 *   data-arg="@event"-> the event
 *   data-arg="12"    -> the number 12
 *   data-arg="true"  -> the boolean true
 *   anything else    -> the string as written
 *   data-arg2        -> an optional second argument, same rules
 */
(() => {
  'use strict';

  // Only plain decimals become numbers. Notably this leaves hex strings such as
  // an 0x-prefixed wallet address alone - Number('0x1f') would otherwise turn an
  // address into 31.
  const DECIMAL = /^-?\d+(\.\d+)?$/;

  function coerce(raw, element, event) {
    if (raw === null) return undefined;
    if (raw === '@this') return element;
    if (raw === '@event') return event;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (raw !== '' && DECIMAL.test(raw)) return Number(raw);
    return raw;
  }

  function dispatch(type, event) {
    const attribute = `data-on-${type}`;

    const target = event.target instanceof Element
      ? event.target.closest(`[${attribute}]`)
      : null;

    if (!target) return;

    const name = target.getAttribute(attribute);
    const handler = window[name];

    if (typeof handler !== 'function') {
      console.warn(`[actions] No function named "${name}" for ${attribute}`);
      return;
    }

    // An anchor used as a button should not jump to the top of the page.
    if (target.tagName === 'A') {
      const href = target.getAttribute('href') || '';
      if (href === '' || href.startsWith('#')) event.preventDefault();
    }

    const supplied = ['data-arg', 'data-arg2', 'data-arg3']
      .map((name) => coerce(target.getAttribute(name), target, event));

    // No data-arg at all means the handler wants the event. Otherwise pass the
    // arguments that were actually supplied, trailing gaps trimmed.
    const args = supplied[0] === undefined
      ? [event]
      : supplied.slice(0, supplied.findLastIndex((value) => value !== undefined) + 1);

    try {
      handler.apply(target, args);
    } catch (error) {
      console.error(`[actions] "${name}" threw:`, error);
    }
  }

  for (const type of ['click', 'submit', 'change', 'input']) {
    document.addEventListener(type, (event) => dispatch(type, event));
  }

  /**
   * Navigation helper, so markup does not need an inline assignment to
   * window.location just to move between pages.
   */
  window.navigateTo = function navigateTo(path) {
    window.location.href = typeof path === 'string' ? path : '/';
  };
})();
