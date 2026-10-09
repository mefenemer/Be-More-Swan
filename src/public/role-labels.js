/**
 * src/public/role-labels.js — assistant ROLE TITLES from master data, for client-side copy.
 *
 * master_assistants.name is the source of truth and is admin-editable (Admin → Master Data). Copy
 * that hardcoded a title ("Your Social Media Manager publishes…") kept saying the old one after
 * every rename. Pages write `{role:<roleKey>}` in their copy and run it through RoleLabels.fill().
 *
 *   window.RoleLabels.load()            → Promise<{ [roleKey]: name }>  (one fetch per page, cached)
 *   window.RoleLabels.fill(text, map?)  → text with every {role:key} replaced
 *   window.RoleLabels.get(roleKey, map?) → one title
 *
 * FALLBACK is only what renders before (or without) the fetch — the catalogue's seeded names. The
 * live catalogue (GET master-assistants, public) overrides it.
 */
(function () {
  'use strict';
  var FALLBACK = {
    social_media_manager: 'Social Media Assistant',
    blog_writer: 'Blog Writing Assistant',
    newsletter_editor: 'Email Marketing Assistant',
    campaign_orchestrator: 'Campaign Assistant',
    brand_designer: 'Brand Designer',
    lead_qualifier: 'Lead Generation Assistant',
    crm_enricher: 'CRM Data Assistant',
    tier1_support_agent: 'First-Line Support Assistant',
    meeting_note_taker: 'Minute Taker',
    accounts_receivable_clerk: 'Accounts Receivable Clerk',
  };
  var current = Object.assign({}, FALLBACK);
  var pending = null;

  function load() {
    if (!pending) {
      pending = fetch('/.netlify/functions/master-assistants', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (d) {
          (d.assistants || []).forEach(function (a) {
            if (a && a.roleKey && a.name) current[a.roleKey] = a.name;
          });
          return current;
        })
        .catch(function () { return current; });
    }
    return pending;
  }
  function get(roleKey, map) {
    var m = map || current;
    return m[roleKey] || FALLBACK[roleKey] || roleKey;
  }
  function fill(text, map) {
    return String(text == null ? '' : text).replace(/\{role:([a-z0-9_]+)\}/g, function (_, k) { return get(k, map); });
  }
  // Static markup can carry <el data-role-label="roleKey">fallback</el>; it is filled on load.
  function applyMarkup() {
    var els = document.querySelectorAll('[data-role-label]');
    if (!els.length) return;
    load().then(function () {
      els.forEach(function (el) { el.textContent = get(el.getAttribute('data-role-label')); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyMarkup);
  else applyMarkup();

  window.RoleLabels = { load: load, get: get, fill: fill, fallback: FALLBACK };
})();
