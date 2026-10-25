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
 *   Suggestions waiting    — the open ones, with "Review all" (mentor-review-all.js, the same list as the
 *                            chat card and Inbox "Needs you"; nothing pre-ticked)
 *   Recommended next       — who to hire next (mentor-hire.ts — the same list as the chat card and the
 *                            catalogue's "Recommended" badge); "See this assistant" opens the catalogue
 *   Get feedback           — paste a draft (or open a .txt/.md file) and get the Mentor's critique inline
 *                            (mentor.ts action 'feedback' → mentor-feedback.ts, the same craft as chat)
 *
 * Backed by netlify/functions/mentor.ts, the SAME action a card's Dismiss calls (chat-session.js →
 * mentor:decide). A save from a card dispatches `mentor:changed` / `bizinfo:*Changed`, which reload this
 * tab. Handlers are bound to `document` once, at load, never from render. Server values are escaped.
 */
(function () {
  const API = '/.netlify/functions/mentor';
  const state = { assistantId: null, assistantName: 'Your Mentor', data: null, error: null, loading: false, notes: {},
    feedback: { text: '', busy: false, result: null, error: null } };
  const FEEDBACK_MAX = 12000;

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

  function waitingHtml(open) {
    if (!open.length) return '';
    return card(`
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <h2 class="text-base font-bold text-gray-900">Suggestions waiting (${open.length})</h2>
          <p class="text-xs text-gray-500 mt-0.5">${esc(state.assistantName)}’s suggestions you haven’t answered yet. Review them together and tick the ones you want.</p>
        </div>
        <button type="button" data-mentor-review-all class="btn-primary shrink-0 px-4 py-2 text-sm font-bold rounded-lg transition">Review all</button>
      </div>`, 'data-mentor-panel="waiting"');
  }

  function recommendedHtml(rec) {
    const picks = (rec && rec.picks) || [];
    const cap = (rec && rec.capacity) || {};
    const rows = picks.map((p, i) => `
      <li class="py-2 border-b border-gray-100 last:border-0">
        <p class="text-sm font-semibold text-gray-900">${i + 1}. ${esc(p.name)}</p>
        <p class="text-xs text-gray-600 mt-0.5 break-words">${esc(p.reason)}</p>
        <button type="button" data-mentor-see-role="${esc(p.roleKey)}" class="btn-swan-link mt-1 px-0 py-1 text-xs font-bold">See this assistant</button>
      </li>`).join('');
    return card(`
      <h2 class="text-base font-bold text-gray-900">Recommended next</h2>
      ${picks.length
        ? `<p class="text-xs text-gray-500 mt-1">Who ${esc(state.assistantName)} would hire next, and why. Nothing is hired from here.</p><ol class="mt-1">${rows}</ol>`
        : '<p class="text-sm text-gray-600 mt-1">No clear gap for another assistant right now.</p>'}
      ${cap.note ? `<p class="mt-2 text-xs rounded-lg px-2.5 py-1.5 ${cap.needsUpgrade ? 'border border-amber-200 bg-amber-50 text-amber-900' : 'bg-gray-50 text-gray-700'}">${esc(cap.note)}</p>` : ''}`, 'data-mentor-panel="recommended"');
  }

  function feedbackHtml() {
    const f = state.feedback;
    return card(`
      <h2 class="text-base font-bold text-gray-900">Get feedback</h2>
      <p class="text-xs text-gray-500 mt-1">Paste something you wrote — a sales email, a post, a flyer — and ${esc(state.assistantName)} will say what works and what to change, for your customers. Nothing is saved or changed.</p>
      <label for="mentor-feedback-text" class="sr-only">Your draft</label>
      <textarea id="mentor-feedback-text" data-mentor-feedback-text rows="6" maxlength="${FEEDBACK_MAX}" class="mt-2 w-full rounded-lg border border-gray-300 p-2.5 text-sm" placeholder="Paste your draft here…" ${f.busy ? 'disabled' : ''}>${esc(f.text)}</textarea>
      <div class="flex flex-wrap items-center gap-2 mt-2">
        <button type="button" data-mentor-feedback-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${f.busy ? 'disabled' : ''}>${f.busy ? 'Reading…' : 'Get feedback'}</button>
        <label class="btn-secondary px-3 py-2 border text-xs font-bold rounded-lg transition cursor-pointer">
          Open a text file<input type="file" accept=".txt,.md,text/plain,text/markdown" data-mentor-feedback-file class="sr-only">
        </label>
        <span class="text-[11px] text-gray-500" data-mentor-feedback-count>${f.text.length.toLocaleString('en-GB')} / ${FEEDBACK_MAX.toLocaleString('en-GB')}</span>
      </div>
      ${f.error ? `<p class="mt-2 text-xs font-semibold text-red-600" role="alert">${esc(f.error)}</p>` : ''}
      ${f.result ? `<div class="mt-3 rounded-lg border border-pink-200 bg-pink-50 p-3" data-mentor-feedback-result role="status" aria-live="polite"><p class="text-xs font-bold text-pink-800 uppercase tracking-wide">${esc(state.assistantName)}’s feedback</p><p class="text-sm text-gray-800 mt-1 whitespace-pre-line break-words">${esc(f.result)}</p></div>` : ''}`, 'data-mentor-panel="feedback"');
  }

  async function getFeedback() {
    const f = state.feedback;
    if (f.busy) return;
    if (f.text.trim().length < 20) { f.error = 'Paste a little more of your draft so there’s something to judge.'; render(); return; }
    f.busy = true; f.error = null; f.result = null; render();
    try {
      const res = await fetch(API, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'feedback', text: f.text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Your Mentor couldn’t read that just now — please try again.');
      f.result = body.feedback;
    } catch (err) {
      f.error = err.message;
    }
    f.busy = false;
    render();
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
        <div class="space-y-4 min-w-0 lg:col-span-2">${waitingHtml(d.open || [])}${checklistHtml(d.checklist || [])}${feedbackHtml()}${dismissedHtml(d.dismissed || [])}</div>
        <div class="space-y-4 min-w-0">${recommendedHtml(d.recommended)}${weekHtml(d.week)}${visibilityHtml(d.visibility || { sees: [], never: [] })}
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
    if (t.closest('[data-mentor-review-all]')) { window.MentorReviewAll?.openDialog(); return; }
    const see = t.closest('[data-mentor-see-role]');
    if (see) { window.MentorOpenCatalogue?.(see.getAttribute('data-mentor-see-role')); return; }
    if (t.closest('[data-mentor-feedback-go]')) { getFeedback(); return; }
    if (t.closest('[data-mentor-help]') && window.loadView) window.loadView('help');
  });
  // The draft is kept as it is typed, so a repaint (a card saved in chat) never loses it.
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !t.matches('[data-mentor-feedback-text]') || !host()?.contains(t)) return;
    state.feedback.text = t.value.slice(0, FEEDBACK_MAX);
    const n = host().querySelector('[data-mentor-feedback-count]');
    if (n) n.textContent = `${state.feedback.text.length.toLocaleString('en-GB')} / ${FEEDBACK_MAX.toLocaleString('en-GB')}`;
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !t.matches('[data-mentor-feedback-file]') || !host()?.contains(t)) return;
    const file = t.files && t.files[0];
    if (!file) return;
    if (file.size > 200000) { state.feedback.error = 'That file is too big — paste the part you want feedback on instead.'; render(); return; }
    file.text().then((txt) => {
      state.feedback.text = String(txt).slice(0, FEEDBACK_MAX);
      state.feedback.error = txt.length > FEEDBACK_MAX ? `Only the first ${FEEDBACK_MAX.toLocaleString('en-GB')} characters were kept.` : null;
      render();
    }, () => { state.feedback.error = 'That file couldn’t be read — paste the text instead.'; render(); });
  });
  // A card applied or dismissed in chat, or Business Information saved: repaint from the server.
  ['mentor:changed', 'bizinfo:profileChanged', 'bizinfo:productsChanged', 'assistant:settingsChanged'].forEach((ev) =>
    document.addEventListener(ev, () => { if (state.assistantId && host()) load(); }));

  window.AssistantMentorOverview = {
    init({ assistantId, assistantName }) {
      state.assistantId = assistantId;
      state.assistantName = assistantName || 'Your Mentor';
      state.data = null; state.error = null; state.notes = {};
      state.feedback = { text: '', busy: false, result: null, error: null };
      render();
      load();
    },
    activate() { if (!state.data && !state.loading) load(); else render(); },
  };
})();
