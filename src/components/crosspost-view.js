/**
 * src/components/crosspost-view.js
 *
 * "Show a cross-post as one post" — one per-user preference behind three controls: the
 * Notification Preferences card in My Account, the notification inbox header and the assistant
 * detail page's Activity card. Stored server-side in user_profiles.preferences.combineCrossPosts
 * (update-profile.ts, default ON) because the SERVER does the combining — notifications.ts and
 * get-assistant-activity.ts read it, so the badge count and the list can never disagree.
 *
 * Any element carrying [data-crosspost-toggle] is a control: an <input type="checkbox"> or a
 * <button role="switch"> styled like the Sounds switches. One click handler, bound to document at
 * load (never from a render path), so controls injected later by a view need no wiring. A change
 * fires `bms:crosspost-view` on window with { combined }, which each view listens for to re-fetch.
 *
 * localStorage (bms_combineCrossPosts) is only a cache for painting the control before the
 * profile fetch answers; the server value always wins.
 */
(function () {
  'use strict';

  const KEY = 'combineCrossPosts';
  const CACHE = 'bms_' + KEY;
  const EVENT = 'bms:crosspost-view';

  function cached() {
    try { return localStorage.getItem(CACHE) !== '0'; } catch { return true; }
  }
  function cache(on) {
    try { localStorage.setItem(CACHE, on ? '1' : '0'); } catch { /* private mode */ }
  }

  let combined = cached();

  function paint(el, on) {
    if (el.type === 'checkbox') { el.checked = on; return; }
    el.setAttribute('aria-checked', String(on));
    el.classList.toggle('bg-emerald-500', on);
    el.classList.toggle('bg-gray-300', !on);
    const knob = el.querySelector('span');
    if (knob) { knob.classList.toggle('translate-x-5', on); knob.classList.toggle('translate-x-0', !on); }
  }

  /** Bring every control on the page in line with the current value. Safe to call any time. */
  function sync(root) {
    (root || document).querySelectorAll('[data-crosspost-toggle]').forEach(el => paint(el, combined));
  }

  async function set(on) {
    const prev = combined;
    combined = !!on;
    sync();
    try {
      const res = await fetch('/.netlify/functions/update-profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldKey: KEY, value: combined }),
      });
      if (!res.ok) throw new Error(String(res.status));
      cache(combined);
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { combined } }));
      return true;
    } catch {
      combined = prev;
      sync();
      window.showToast?.('Could not save that setting — please try again.', { icon: '⚠️' });
      return false;
    }
  }

  let hydrated = null;
  /** Read the saved value once per page load. Resolves to the value. */
  function hydrate() {
    if (!hydrated) {
      hydrated = fetch('/.netlify/functions/update-profile')
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (d && typeof d[KEY] === 'boolean') { combined = d[KEY]; cache(combined); }
          sync();
          return combined;
        })
        .catch(() => combined);
    }
    return hydrated;
  }

  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest && e.target.closest('[data-crosspost-toggle]');
    if (!el || el.type === 'checkbox') return; // checkboxes report through 'change'
    e.preventDefault();
    set(el.getAttribute('aria-checked') !== 'true');
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el && el.matches && el.matches('input[type="checkbox"][data-crosspost-toggle]')) set(el.checked);
  });

  window.CrossPostView = { isCombined: () => combined, set, sync, hydrate, EVENT };
})();
