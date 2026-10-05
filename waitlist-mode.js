/**
 * waitlist-mode.js — the public site's "we're testing, join the waitlist" mode.
 *
 * Driven by the admin kill switch `new_registration_lock` (Admin Portal ▸ Emergency Controls), read
 * through platform-config-public. While it is ON:
 *   - every link to register.html / /register is pointed at /waitlist.html and, where it is a
 *     "Get Started" button, relabelled "Join the waitlist";
 *   - pages ask window.BmsWaitlist.isOn() before drawing a sign-up CTA (assistants.html does).
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
        return { locked: cfg.registrationLocked === true, formKey: cfg.waitlistFormKey || null };
      })
      // Fail open, like the edge: an unreachable config must not hide sign-up from a live site.
      .catch(function () { return { locked: false, formKey: null }; });
    return _state;
  }

  function rewrite(root) {
    if (!root || !root.querySelectorAll) return;
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

  window.BmsWaitlist = {
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
