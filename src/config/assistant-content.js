/**
 * src/config/assistant-content.js
 *
 * Client-side registry of assistant marketing copy, read from the DB.
 *
 * Replaces the old src/config/assistant-role-content.js, which hard-coded name/category/icons/
 * tagline/description/keyFeatures/integrations/video for 7 of the ~20 catalog roles. That file was a
 * second source of truth: master_assistants already held name/description/icons and the catalogue
 * card rendered from it, so the card and the detail page had silently drifted apart. Copy now lives
 * in master_assistants (db/assistant-content.sql) and is admin-edited in Master Data → Assistants.
 *
 * Source: GET /.netlify/functions/master-assistants (the same call the catalogue pages already make).
 *
 * Usage:
 *   AssistantContent.prime(assistants);            // reuse a list you already fetched
 *   await AssistantContent.load();                 // …or fetch it here
 *   const content = AssistantContent.get('lead_qualifier');
 */
(function () {
  'use strict';

  // Assistants hired before the roleKey namespace unification (db/rolekey-namespace-unification.sql)
  // still carry these retired keys in ai_assistants.configuration->>'type'. They were all Social
  // Media Managers. This is migration data about keys that no longer exist — not assistant content —
  // so it stays in code rather than moving to the DB.
  var LEGACY_ALIASES = {
    social_media: 'social_media_manager',
    community_mgmt: 'social_media_manager',
  };

  var _byRoleKey = null;   // null = not loaded yet
  var _loading = null;     // in-flight load(), so concurrent callers share one request

  function prime(assistants) {
    var map = {};
    (assistants || []).forEach(function (a) {
      if (a && a.roleKey) map[a.roleKey] = a;
    });
    Object.keys(LEGACY_ALIASES).forEach(function (legacy) {
      var canonical = LEGACY_ALIASES[legacy];
      if (!map[legacy] && map[canonical]) map[legacy] = map[canonical];
    });
    _byRoleKey = map;
    return map;
  }

  function load() {
    if (_byRoleKey) return Promise.resolve(_byRoleKey);
    if (_loading) return _loading;
    _loading = fetch('/.netlify/functions/master-assistants')
      .then(function (r) { return r.ok ? r.json() : { assistants: [] }; })
      .then(function (d) { return prime(d.assistants); })
      .catch(function () { return prime([]); })
      .then(function (map) { _loading = null; return map; });
    return _loading;
  }

  function get(roleKey) {
    return (_byRoleKey || {})[roleKey] || null;
  }

  function all() {
    return _byRoleKey || {};
  }

  window.AssistantContent = { prime: prime, load: load, get: get, all: all };
})();
