/* Delegated action dispatcher for the admin and customer portals.
   =============================================================================
   Both portals originally wired their controls with inline `onclick="fn(1)"`
   attributes. A Content-Security-Policy blocks inline event handlers outright —
   a nonce cannot whitelist them, because there is nowhere to put one — so
   keeping them would have meant keeping 'unsafe-inline' in script-src, which
   defeats the entire policy.

   The attributes are now declarative:

       <button data-action="deleteBooking" data-arg0="12">
       <button data-action="setReviewStatus" data-arg0="7" data-arg1="approved">
       <button data-action="openDetail" data-arg0="4" data-stop="1">
       <form   data-submit="saveDog">

   This file binds ONE click listener and ONE submit listener on the document
   and calls the named global function with the decoded arguments. Because it is
   delegated, markup rendered later by the portals' own template strings works
   without re-binding.

   Argument decoding is deliberately narrow: only numbers, booleans and null are
   coerced, everything else stays a string. `toggleClient` indexes an array with
   its argument, so passing the string "3" would silently do nothing. */

(function () {
  'use strict';

  function decode(value) {
    if (value === 'null') return null;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value !== '' && value !== null && !Number.isNaN(Number(value))) return Number(value);
    return value;
  }

  function argsFrom(el) {
    const args = [];
    for (let i = 0; i < 8; i++) {
      const raw = el.getAttribute(`data-arg${i}`);
      if (raw === null) break;
      args.push(decode(raw));
    }
    return args;
  }

  function invoke(name, args, el) {
    const fn = window[name];
    if (typeof fn !== 'function') {
      console.error('[portal-actions] no handler named', name);
      return;
    }
    try {
      fn.apply(el, args);
    } catch (err) {
      console.error('[portal-actions]', name, 'failed:', err);
    }
  }

  document.addEventListener('click', function (event) {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    if (el.getAttribute('data-stop') === '1') event.stopPropagation();
    // A <button> inside a <form> defaults to type=submit; these are actions,
    // not submissions.
    if (el.tagName === 'BUTTON' && !el.getAttribute('type')) event.preventDefault();
    invoke(el.getAttribute('data-action'), argsFrom(el), el);
  });

  document.addEventListener('submit', function (event) {
    const form = event.target.closest('[data-submit]');
    if (!form) return;
    invoke(form.getAttribute('data-submit'), [event].concat(argsFrom(form)), form);
  });

  // Image fallback: replaces the inline onerror that swapped a broken photo for
  // its placeholder sibling. Capture phase, because `error` does not bubble.
  document.addEventListener('error', function (event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || img.dataset.fallback !== 'next') return;
    img.style.display = 'none';
    if (img.nextElementSibling) img.nextElementSibling.style.display = 'flex';
  }, true);
})();
