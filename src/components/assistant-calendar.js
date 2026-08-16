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
 * Because it is the GLOBAL calendar's fragment, its social chrome has to be switched off by role:
 * `publishesContent` drops the platform filter and rewrites the posted/overdue status legend for
 * roles that publish nothing (Lead Generator, AR Clerk, Support, …), whose calendar is scheduled
 * records — a lead's chase reminder, say — plus completed runs.
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

  const state = { assistantId: null, roleKey: null };

  function register({ assistantId, roleKey } = {}) {
    state.assistantId = assistantId != null ? Number(assistantId) : null;
    state.roleKey = roleKey || null;
  }

  // Does this role publish to platforms? calendar.html is the GLOBAL Content Calendar fragment,
  // so everything social in it — the platform filter, the posted/overdue legend — comes along for
  // every role unless it is switched off. The signal is the dashboard registry's
  // modules.hasPostingSchedule: true for the content roles (social + blog, both of which appear in
  // the platform filter), false for the records roles, whose calendar holds only scheduled records
  // and completed task runs. Registry default is SHOWN (`!== false`), so an unknown roleKey — which
  // get() resolves to social_media_manager anyway — keeps the full social toolbar.
  function publishesContent() {
    const cfg = window.AssistantDashboardRegistry?.get(state.roleKey);
    return (cfg?.modules || {}).hasPostingSchedule !== false;
  }

  // Does this role have PENDING OUTREACH to draw — follow-up emails the cadence is going to send?
  // Opt-IN (`=== true`), the opposite default from publishesContent above, and deliberately so:
  // an unknown roleKey resolves to social_media_manager, and inheriting a lead's send queue is a
  // far worse default than inheriting a platform filter. See modules.hasLeadOutreach.
  function hasLeadOutreach() {
    const cfg = window.AssistantDashboardRegistry?.get(state.roleKey);
    return (cfg?.modules || {}).hasLeadOutreach === true;
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
        await window.initCalendar({
          assistantId: state.assistantId,
          publishesContent: publishesContent(),
          leadOutreach: hasLeadOutreach(),
        });
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
