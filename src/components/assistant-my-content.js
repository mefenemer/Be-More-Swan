/**
 * src/components/assistant-my-content.js
 *
 * The "My Content" tab on assistant-detail.html — content-role only
 * (social_media_manager, blog_writer; registry.myContentTab). Surfaces the
 * org-wide content library (uploads/links/AI-generated media, content-assets.ts)
 * as a tab on the two assistants that actually consume it, instead of only being
 * reachable inline from the Create Post sheet / Blog Studio modal (issue #184).
 *
 * The library itself is NOT assistant-scoped (assets belong to the organisation,
 * shared across every assistant that can attach media) — this tab just reuses the
 * same my-content.html fragment + my-content.js controller that power the
 * standalone My Content route, the same way assistant-calendar.js reuses
 * calendar.html + calendar.js.
 *
 * Lifecycle (assistants.js):
 *   _applyDashboardRegistry → nothing to register (no assistant scoping needed)
 *   _activateMainTab('mycontent') → AssistantMyContent.show()   (lazy, on first open)
 *
 * The assistant-detail view is re-injected on every navigation, so #mycontent-host
 * is a fresh empty node each mount; we inject + boot once per mount (guarded by
 * host.dataset.ready), then just re-run initMyContent() on later visits to pick up
 * any assets added elsewhere (matches the Data Hub tab's refresh-on-open pattern).
 */
(function () {
  'use strict';

  const HOST_ID = 'mycontent-host';
  const FRAGMENT_URL = '/my-content.html?v=detail-mycontent';

  async function show() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;

    if (host.dataset.ready === '1') {
      if (typeof window.initMyContent === 'function') await window.initMyContent();
      return;
    }

    host.innerHTML = '<div class="flex items-center justify-center py-20 text-gray-400 text-sm">Loading your content…</div>';
    try {
      const res = await fetch(FRAGMENT_URL);
      if (!res.ok) throw new Error(`My Content failed to load (${res.status}).`);
      host.innerHTML = await res.text();
      host.dataset.ready = '1';
      if (typeof window.initMyContent === 'function') await window.initMyContent();
    } catch (err) {
      host.dataset.ready = '';
      host.innerHTML = `<div class="bg-red-50 border border-red-200 rounded-2xl p-6 text-sm font-semibold text-red-700">${
        String(err && err.message || 'Could not load My Content.').replace(/</g, '&lt;')
      }</div>`;
    }
  }

  window.AssistantMyContent = { show };
})();
