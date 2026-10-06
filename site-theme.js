// site-theme.js — applies the Be More Swan site theme (Admin ▸ Site Styles) to this page, and keeps
// it current while the page is open.
//
// Loaded in <head>, straight after style.css, on every website, workspace and admin page. Not
// deferred on purpose: it paints the last-known theme from localStorage BEFORE the body renders, so
// a restyled site never flashes the old look first.
//
// "Without a refresh" — three ways a published change arrives:
//   · instantly, in every tab of the browser that published it (BroadcastChannel)
//   · within ~30s everywhere else: the page re-asks while it is visible, and at once when a tab
//     comes back into view (the endpoint is CDN-cached for 10s, so polling stays cheap)
//   · on the next load, from localStorage, with no request at all
//
// The CSS arrives BUILT by the server from validated tokens (src/public/site-theme-core.js), so
// this file never interprets a theme — it only swaps one <style> element's text.
(function () {
  'use strict';
  if (window.SiteTheme) return;

  var URL_ = '/.netlify/functions/site-theme';
  var STORE = 'bms-site-theme';
  var POLL_MS = 30000;
  var current = { version: null, css: '', fontUrl: null };
  var previewing = false;

  function styleEl() {
    var el = document.getElementById('bms-site-theme');
    if (!el) {
      el = document.createElement('style');
      el.id = 'bms-site-theme';
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function fontLink(href) {
    var el = document.getElementById('bms-site-theme-font');
    if (!href) { if (el) el.remove(); return; }
    if (el && el.getAttribute('href') === href) return;
    if (!el) {
      el = document.createElement('link');
      el.id = 'bms-site-theme-font';
      el.rel = 'stylesheet';
      (document.head || document.documentElement).appendChild(el);
    }
    el.href = href;
  }

  function paint(theme) {
    styleEl().textContent = theme.css || '';
    fontLink(theme.fontUrl || null);
  }

  function remember(theme) {
    try { localStorage.setItem(STORE, JSON.stringify(theme)); } catch (e) { /* private mode */ }
  }

  function apply(theme, fromBroadcast) {
    if (!theme || typeof theme.css !== 'string') return;
    if (theme.version === current.version && theme.css === current.css) return;
    current = { version: theme.version, css: theme.css, fontUrl: theme.fontUrl || null };
    remember(current);
    if (!previewing) paint(current);
    if (!fromBroadcast && channel) { try { channel.postMessage(current); } catch (e) { /* closed */ } }
  }

  // 1. Last-known theme, synchronously.
  try {
    var cached = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (cached && typeof cached.css === 'string') { current = cached; paint(cached); }
  } catch (e) { /* none yet */ }

  // 2. Other tabs in this browser.
  var channel = null;
  try {
    channel = new BroadcastChannel('bms-site-theme');
    channel.onmessage = function (ev) { apply(ev.data, true); };
  } catch (e) { /* older browser: polling still covers it */ }

  // 3. The server.
  var inflight = false;
  function refresh() {
    if (inflight) return;
    inflight = true;
    fetch(URL_, { credentials: 'omit', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (t) { if (t) apply(t, false); })
      .catch(function () { /* offline: keep what we have */ })
      .then(function () { inflight = false; });
  }
  refresh();
  setInterval(function () { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(); });

  window.SiteTheme = {
    /** Admin ▸ Site Styles: show an unpublished draft on THIS page only. */
    preview: function (css, fontUrl) { previewing = true; paint({ css: css, fontUrl: fontUrl }); },
    /** Stop previewing and show the standard again. */
    endPreview: function () { previewing = false; paint(current); },
    /** After a publish: adopt it here and tell every other tab at once. */
    published: function (theme) { previewing = false; current = { version: null, css: null }; apply(theme, false); paint(current); },
    refresh: refresh,
  };
})();
