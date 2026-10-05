/**
 * waitlist-mode.js — the public site's "we're testing, join the waitlist" mode.
 *
 * Driven by the admin kill switch `new_registration_lock` (Admin Portal ▸ Emergency Controls), read
 * through platform-config-public. While it is ON:
 *   - every link to register.html / /register is pointed at /waitlist.html and, where it is a
 *     "Get Started" button, relabelled "Join the waitlist";
 *   - pages ask window.BmsWaitlist.isOn() before drawing a sign-up CTA (assistants.html does).
 *   - elements marked `data-waitlist-show` are revealed (they ship hidden), and links marked
 *     `data-waitlist-label="…"` take that label and point at /waitlist.html (or `data-waitlist-href`)
 *     — so a page can say
 *     "we're in beta" without a second copy of this logic.
 * While it is OFF this file changes nothing.
 *
 * This is presentation only. The lock itself is enforced by auth-guard (redirect) and register.ts
 * (403) — a visitor with this script blocked still cannot create an account.
 *
 * Existing users are never routed here: login.html is untouched, and links on "known" devices
 * (bms_known_user) are rewritten to login.html by their own handlers before this matters.
 *
 * Components (nav/footer) are injected by innerHTML after load, so a MutationObserver re-applies
 * the rewrite to whatever arrives later.
 */
(function () {
  'use strict';

  var LABEL = 'Join the waitlist';
  var REGISTER_HREF = /(^|\/)register(\.html)?([?#]|$)/;
  var _state = null;

  function load() {
    if (_state) return _state;
    _state = fetch('/.netlify/functions/platform-config-public', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (cfg) {
        return { locked: cfg.registrationLocked === true, formKey: cfg.waitlistFormKey || null, betaFormKey: cfg.betaFormKey || null };
      })
      // Fail open, like the edge: an unreachable config must not hide sign-up from a live site.
      .catch(function () { return { locked: false, formKey: null, betaFormKey: null }; });
    return _state;
  }

  function rewrite(root) {
    if (!root || !root.querySelectorAll) return;
    var shows = root.querySelectorAll('[data-waitlist-show]');
    for (var k = 0; k < shows.length; k++) {
      shows[k].classList.remove('hidden');
      shows[k].style.display = '';
    }
    var swaps = root.querySelectorAll('a[data-waitlist-label]');
    for (var m = 0; m < swaps.length; m++) {
      swaps[m].setAttribute('href', swaps[m].getAttribute('data-waitlist-href') || '/waitlist.html');
      swaps[m].textContent = swaps[m].getAttribute('data-waitlist-label');
      swaps[m].removeAttribute('data-waitlist-label');
    }
    var links = root.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.dataset.bmsWaitlist === '1') continue;
      if (!REGISTER_HREF.test(a.getAttribute('href') || '')) continue;
      a.dataset.bmsWaitlist = '1';
      a.setAttribute('href', '/waitlist.html');
      // Inline onclicks (the nav's, index.html's bmsStart) are left alone: they send a KNOWN
      // device to login.html — an existing user should log in, not join a waitlist — and send
      // everyone else to register.html, which the edge redirects here anyway.
      var key = a.getAttribute('data-i18n') || '';
      if (/get_started$/.test(key)) {
        a.removeAttribute('data-i18n');   // or the i18n pass writes "Get Started" back over it
        a.textContent = LABEL;
      }
    }
  }

  /**
   * Draw an Email Marketing sign-up form into #bms-subscribe — the same snippet a customer pastes
   * into their own site, injected because the key is admin-set at runtime. subscribe.js reads its
   * attributes from document.currentScript, which a dynamically inserted classic script still has.
   * `preselect` pre-ticks choices (e.g. which assistant they came from).
   */
  function mount(formKey, preselect, onError) {
    var tag = document.createElement('script');
    tag.src = '/subscribe.js';
    tag.setAttribute('data-bms-form', formKey);
    if (preselect && preselect.length) tag.setAttribute('data-bms-preselect', preselect.join(','));
    if (onError) tag.onerror = onError;
    document.body.appendChild(tag);
  }

  window.BmsWaitlist = {
    mount: mount,
    /** Promise<{ locked, formKey }> — fetched once per page. */
    state: load,
    /** Promise<boolean> — is the site in waitlist mode? */
    isOn: function () { return load().then(function (s) { return s.locked; }); },
    label: LABEL,
    href: '/waitlist.html',
  };

  load().then(function (s) {
    if (!s.locked) return;
    document.documentElement.setAttribute('data-waitlist-mode', '1');
    function start() {
      rewrite(document);
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          for (var j = 0; j < muts[i].addedNodes.length; j++) {
            var n = muts[i].addedNodes[j];
            if (n.nodeType === 1) { rewrite(n.parentNode || n); }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  });
})();
