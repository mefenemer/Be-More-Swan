/**
 * src/components/assistant-mentor-overview.js
 * The Business Mentor's Overview tab — docs/business-mentor-plan.md §14 and the approved mockup
 * (docs/mockups/business-mentor-mockup.html). The screen twins of what the Mentor does in chat:
 *
 *   Set-up checklist       — the same gaps it raises as cards (mentor-snapshot.ts setupChecklist);
 *                            each opens its Business Information tab
 *   What I can see         — generated from src/config/mentor-data-inventory.ts, the list its prompt reads
 *   Dismissed suggestions  — what the user dismissed from a card, with the reason; "Bring back"
 *   Suggestions this week  — n of 3 (§3.13)
 *
 * Backed by netlify/functions/mentor.ts, the SAME action a card's Dismiss calls (chat-session.js →
 * mentor:decide). A save from a card dispatches `mentor:changed` / `bizinfo:*Changed`, which reload this
 * tab. Handlers are bound to `document` once, at load, never from render. Server values are escaped.
 */
(function () {
  const API = '/.netlify/functions/mentor';
  const state = { assistantId: null, assistantName: 'Your Mentor', data: null, error: null, loading: false, notes: {} };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const host = () => document.getElementById('mentor-overview-host');
  const ukDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });

  async function load() {
    if (!host()) return;
    state.loading = true;
    try {
      const res = await fetch(API, { credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn’t load (HTTP ${res.status}).`);
      state.data = body; state.error = null;
    } catch (err) {
      state.error = err.message || 'Couldn’t load your Mentor’s overview.';
    }
    state.loading = false;
    render();
  }

  function card(inner, attrs = '') {
    return `<section class="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 sm:p-5 min-w-0" ${attrs}>${inner}</section>`;
  }

  function checklistHtml(items) {
    const done = items.filter((i) => i.done).length;
    const rows = items.map((i) => `
      <li class="flex items-start gap-3 py-2 border-b border-gray-100 last:border-0">
        <span class="mt-0.5 w-5 h-5 shrink-0 rounded-md border-2 flex items-center justify-center text-xs font-bold ${i.done ? 'border-green-500 bg-green-600 text-white' : 'border-gray-300'}" aria-hidden="true">${i.done ? '✓' : ''}</span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            ${i.done
              ? `<span class="text-sm text-gray-700">${esc(i.label)}</span><span class="sr-only">(done)</span>`
              : `<button type="button" data-mentor-open-field="${esc(i.tab)}" class="text-sm font-semibold text-pink-700 hover:underline text-left">${esc(i.label)}</button>
                 ${i.optional ? '<span class="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-gray-100 text-gray-600">Optional</span>' : '<span class="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-amber-50 text-amber-800 border border-amber-200">To do</span>'}`}
          </div>
          ${i.done ? '' : `<p class="text-xs text-gray-500 mt-0.5">${esc(i.why)}</p>`}
        </div>
      </li>`).join('');
    return card(`
      <div class="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 class="text-base font-bold text-gray-900">Set-up checklist</h2>
        <span class="text-xs font-semibold text-gray-500">${done} of ${items.length} done</span>
      </div>
      <p class="text-xs text-gray-500 mt-1 mb-2">The same gaps ${esc(state.assistantName)} raises in chat. Each opens its place in Business Information.</p>
      <ul>${rows}</ul>`, 'data-mentor-panel="checklist"');
  }

  function visibilityHtml(v) {
    const list = (xs) => `<ul class="mt-1 space-y-1">${xs.map((x) => `<li class="text-sm text-gray-700 flex gap-2"><span aria-hidden="true" class="text-gray-400">•</span><span class="min-w-0">${esc(x)}</span></li>`).join('')}</ul>`;
    return card(`
      <details>
        <summary class="cursor-pointer text-base font-bold text-gray-900">What I can see</summary>
        <p class="text-xs text-gray-500 mt-2">${esc(state.assistantName)} works from this list, and never changes anything without your click.</p>
        <h3 class="text-xs font-bold uppercase tracking-wide text-gray-500 mt-3">Sees</h3>
        ${list(v.sees || [])}
        <h3 class="text-xs font-bold uppercase tracking-wide text-gray-500 mt-3">Never sees</h3>
        ${list(v.never || [])}
      </details>`, 'data-mentor-panel="visibility"');
  }

  function dismissedHtml(rows) {
    const items = rows.map((d) => {
      const back = d.reason === 'not_now' && d.snoozedUntil && new Date(d.snoozedUntil) > new Date() ? ` · back on ${esc(ukDate(d.snoozedUntil))}` : '';
      return `<li class="py-2 border-b border-gray-100 last:border-0">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <p class="text-sm text-gray-900 break-words">${esc(d.title)}</p>
            <p class="text-xs text-gray-500">${esc(d.reasonLabel)}${back}${d.decidedAt ? ` · dismissed ${esc(ukDate(d.decidedAt))}` : ''}</p>
            ${state.notes[d.id] ? `<p class="text-xs font-semibold mt-1 ${state.notes[d.id].error ? 'text-red-600' : 'text-pink-700'}">${esc(state.notes[d.id].text)}</p>` : ''}
          </div>
          <button type="button" data-mentor-bring-back="${Number(d.id)}" class="btn-secondary shrink-0 px-3 py-1.5 border text-xs font-bold rounded-lg transition">Bring back</button>
        </div>
      </li>`;
    }).join('');
    return card(`
      <details ${rows.length ? 'open' : ''}>
        <summary class="cursor-pointer text-base font-bold text-gray-900">Dismissed suggestions (${rows.length})</summary>
        ${rows.length
          ? `<p class="text-xs text-gray-500 mt-2">${esc(state.assistantName)} won’t suggest these again. "Bring back" lets it.</p><ul class="mt-1">${items}</ul>`
          : `<p class="text-sm text-gray-500 mt-2">Nothing dismissed. When you dismiss a suggestion in chat, it’s listed here with your reason.</p>`}
      </details>`, 'data-mentor-panel="dismissed"');
  }

  function weekHtml(week) {
    const used = week && week.used != null ? week.used : null;
    return card(`
      <h2 class="text-base font-bold text-gray-900">Suggestions this week</h2>
      <p class="text-sm text-gray-700 mt-1">${used == null ? 'Not available just now.' : `${Math.min(used, week.cap)} of ${week.cap} used`}</p>
      <p class="text-xs text-gray-500 mt-1">${esc(state.assistantName)} makes at most ${week ? week.cap : 3} suggestions a week, picking the ones with the most evidence. Anything you ask for in chat doesn’t count.</p>`, 'data-mentor-panel="week"');
  }

  function render() {
    const el = host();
    if (!el) return;
    if (state.error && !state.data) {
      el.innerHTML = card(`<p class="text-sm text-red-600">${esc(state.error)}</p>
        <button type="button" data-mentor-retry class="btn-secondary mt-3 px-3 py-1.5 border text-xs font-bold rounded-lg">Try again</button>`);
      return;
    }
    if (!state.data) { el.innerHTML = card('<p class="text-sm text-gray-400 animate-pulse">Loading…</p>'); return; }
    const d = state.data;
    el.innerHTML = `
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-3 items-start">
        <div class="space-y-4 min-w-0 lg:col-span-2">${checklistHtml(d.checklist || [])}${dismissedHtml(d.dismissed || [])}</div>
        <div class="space-y-4 min-w-0">${weekHtml(d.week)}${visibilityHtml(d.visibility || { sees: [], never: [] })}
          ${card(`<p class="text-xs text-gray-600">Need help with Be More Swan? Ask ${esc(state.assistantName)} in chat, or use <button type="button" data-mentor-help class="font-semibold text-pink-700 hover:underline">Help &amp; Support</button>.</p>`)}
        </div>
      </div>`;
  }

  async function bringBack(id) {
    state.notes[id] = { text: 'Bringing back…' };
    render();
    try {
      const res = await fetch(API, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bring_back', proposalId: id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'That didn’t work — please try again.');
      delete state.notes[id];
      await load();
    } catch (err) {
      state.notes[id] = { text: err.message, error: true };
      render();
    }
  }

  // ── Handlers: bound once, to document ──────────────────────────────────────
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !host()?.contains(t)) return;
    const open = t.closest('[data-mentor-open-field]');
    if (open) {
      window._bizinfoInitialTab = open.getAttribute('data-mentor-open-field');
      if (window.loadView) window.loadView('assets');
      return;
    }
    const back = t.closest('[data-mentor-bring-back]');
    if (back) { bringBack(Number(back.getAttribute('data-mentor-bring-back'))); return; }
    if (t.closest('[data-mentor-retry]')) { load(); return; }
    if (t.closest('[data-mentor-help]') && window.loadView) window.loadView('help');
  });
  // A card applied or dismissed in chat, or Business Information saved: repaint from the server.
  ['mentor:changed', 'bizinfo:profileChanged', 'bizinfo:productsChanged'].forEach((ev) =>
    document.addEventListener(ev, () => { if (state.assistantId && host()) load(); }));

  window.AssistantMentorOverview = {
    init({ assistantId, assistantName }) {
      state.assistantId = assistantId;
      state.assistantName = assistantName || 'Your Mentor';
      state.data = null; state.error = null; state.notes = {};
      render();
      load();
    },
    activate() { if (!state.data && !state.loading) load(); else render(); },
  };
})();
