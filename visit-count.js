/**
 * visit-count.js — the growth funnel's cookieless visit counter (owner, 2026-10-31).
 *
 * On each marketing page it sends ONE request to track-visit: the page, the referring site and any
 * campaign tag. The server adds +1 to a daily total and answers with a source label ("linkedin",
 * "google", "direct" …). Nothing is written to the device — no cookie, no localStorage, no
 * sessionStorage — and the server keeps no IP address or user agent (privacy.html §12).
 *
 * To credit a sign-up to the marketing that brought it, a visitor who arrived from somewhere carries
 * that label in the address of the next page: same-site links get ?src=…&cmp=… added at the moment
 * they are clicked (so links injected later — nav, footer, waitlist relabels — are covered too).
 * register.html reads window.VisitSource.ready and sends the label with the sign-up.
 *
 * Classification lives on the server (src/utils/visit-source.ts); this file only reports.
 */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var EMPTY = { source: null, campaign: '' };

  var ready = (function () {
    try {
      return fetch('/.netlify/functions/track-visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        keepalive: true,
        body: JSON.stringify({
          path: location.pathname,
          ref: document.referrer ? (function () { try { return new URL(document.referrer).hostname; } catch (e) { return ''; } })() : '',
          utmSource: params.get('utm_source') || '',
          utmCampaign: params.get('utm_campaign') || '',
          src: params.get('src') || '',
          cmp: params.get('cmp') || '',
        }),
      })
        .then(function (r) { return r.ok ? r.json() : EMPTY; })
        .then(function (d) { return d && d.source ? { source: d.source, campaign: d.campaign || '' } : EMPTY; })
        .catch(function () { return EMPTY; });
    } catch (e) {
      return Promise.resolve(EMPTY);
    }
  })();

  // The carried label has done its job once read; keep it out of the address bar so a copied link
  // doesn't credit the next person to someone else's source. Campaign tags (utm_*) are left alone.
  if (params.has('src') || params.has('cmp')) {
    try {
      var clean = new URL(location.href);
      clean.searchParams.delete('src');
      clean.searchParams.delete('cmp');
      history.replaceState(history.state, '', clean.pathname + clean.search + clean.hash);
    } catch (e) { /* the label simply stays visible */ }
  }

  var carried = EMPTY;
  ready.then(function (s) { if (s.source && s.source !== 'direct') carried = s; });

  document.addEventListener('click', function (e) {
    if (!carried.source) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var url;
    try { url = new URL(a.getAttribute('href'), location.href); } catch (err) { return; }
    if (url.origin !== location.origin || url.pathname.indexOf('/.netlify/') === 0) return;
    if (url.pathname === location.pathname && url.hash && url.search === location.search) return;   // in-page jump
    if (url.searchParams.has('src')) return;
    url.searchParams.set('src', carried.source);
    if (carried.campaign) url.searchParams.set('cmp', carried.campaign);
    a.setAttribute('href', url.pathname + url.search + url.hash);
  }, true);

  /** Promise<{ source, campaign }> — the label this visit is credited to (source null = unknown). */
  window.VisitSource = { ready: ready };
})();
