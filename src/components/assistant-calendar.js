/**
 * src/components/assistant-calendar.js
 *
 * The per-assistant Calendar tab on assistant-detail.html — one of the four core tabs in the
 * unified template (Overview · Data Hub · Review Queue · Calendar).
 *
 * Rather than reimplement the calendar, it REUSES the global Content Calendar (calendar.js +
 * calendar.html) scoped to a single assistant: it injects the calendar.html fragment into
 * #assistant-calendar-host and boots calendar.js with `initCalendar({ assistantId })`, which
 * locks the assistant filter (hidden picker, suppressed legend) and shows only this assistant's
 * scheduled posts and completed task-run activity (get-calendar-activity).
 *
 * Lifecycle (assistants.js):
 *   _applyDashboardRegistry → AssistantCalendar.register({ assistantId })   (per detail load)
 *   _activateMainTab('calendar') → AssistantCalendar.show()                 (lazy, on first open)
 *
 * The assistant-detail view is re-injected on every navigation, so #assistant-calendar-host is a
 * fresh empty node each mount; we inject + boot once per mount (guarded by host.dataset.ready).
 */
(function () {
  'use strict';

  const HOST_ID = 'assistant-calendar-host';
  // calendar.html is a static view fragment (same one the global Calendar page loads). The query
  // string is a lightweight cache-bust; it does not need to match the SPA's VIEW_VERSION.
  const FRAGMENT_URL = '/calendar.html?v=detail-cal';

  const state = { assistantId: null };

  function register({ assistantId } = {}) {
    state.assistantId = assistantId != null ? Number(assistantId) : null;
  }

  async function show() {
    const host = document.getElementById(HOST_ID);
    if (!host || state.assistantId == null) return;
    // Inject + boot once per mount. Subsequent clicks on the Calendar tab just re-reveal the
    // already-rendered calendar (avoids double-binding calendar.js's nav listeners).
    if (host.dataset.ready === '1') return;
    host.dataset.ready = '1';

    host.innerHTML = '<div class="flex items-center justify-center py-20 text-gray-400 text-sm">Loading calendar…</div>';
    try {
      const res = await fetch(FRAGMENT_URL);
      if (!res.ok) throw new Error(`Calendar failed to load (${res.status}).`);
      host.innerHTML = await res.text();
      if (typeof window.initCalendar === 'function') {
        await window.initCalendar({ assistantId: state.assistantId });
      }
    } catch (err) {
      host.dataset.ready = '';
      host.innerHTML = `<div class="bg-red-50 border border-red-200 rounded-2xl p-6 text-sm font-semibold text-red-700">${
        String(err && err.message || 'Could not load the calendar.').replace(/</g, '&lt;')
      }</div>`;
    }
  }

  window.AssistantCalendar = { register, show };
})();
