/**
 * src/components/mentor-commitments.js
 * The Business Mentor's Commitments list — top of its Results tab (docs/business-mentor-plan.md §5.1, §14).
 * The 1–3 things each person will do this week, their own first (§2.5); "Done", "Missed…" (why, from the
 * same closed list as the chat's end-of-week card) and "Drop"; earlier weeks below with their reasons.
 *
 * Backed by netlify/functions/mentor.ts (?commitments=1, commitments_add, commitment_close) through
 * window.MentorApply — the SAME actions as the chat's mentor_commitments card. A save from the card
 * dispatches `mentor:commitmentsChanged`, which reloads this list. Handlers are bound to `document` once,
 * at load, never from render. Server values are escaped.
 */
(function () {
  const API = '/.netlify/functions/mentor?commitments=1';
  const state = { assistantName: 'Your Mentor', data: null, error: null, busy: false, note: null, openMiss: null, draft: ['', '', ''] };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const host = () => document.getElementById('mentor-commitments-host');
  const ukDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
  const STATUS = { open: ['To do', 'bg-amber-50 text-amber-800 border border-amber-200'], done: ['Done', 'bg-green-50 text-green-800 border border-green-200'], missed: ['Missed', 'bg-red-50 text-red-700 border border-red-200'], dropped: ['Dropped', 'bg-gray-100 text-gray-600'] };

  async function load() {
    if (!host()) return;
    try {
      const res = await fetch(API, { credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn’t load (HTTP ${res.status}).`);
      state.data = body; state.error = null;
    } catch (err) {
      state.error = err.message || 'Couldn’t load your commitments.';
    }
    render();
  }

  function rowHtml(c, d) {
    const [label, cls] = STATUS[c.status] || STATUS.open;
    const canClose = c.status === 'open' && (c.ownerUserId === d.me || d.canManage);
    const reasons = Object.entries(d.missReasons || {});
    return `<li class="py-2 border-b border-gray-100 last:border-0" data-commitment="${Number(c.id)}">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <p class="text-sm text-gray-900 break-words">${esc(c.text)}</p>
          <p class="text-xs text-gray-500">${c.ownerUserId === d.me ? 'You' : esc(c.ownerName)}${c.status === 'missed' && c.missReason ? ` · ${esc((d.missReasons || {})[c.missReason] || c.missReason)}` : ''}${c.note ? ` · “${esc(c.note)}”` : ''}</p>
        </div>
        <span class="text-[11px] font-semibold rounded-full px-2 py-0.5 shrink-0 ${cls}">${label}</span>
      </div>
      ${canClose ? `<div class="flex flex-wrap items-center gap-2 mt-2">
        <button type="button" data-mcl-close="done" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50" ${state.busy ? 'disabled' : ''}>Done</button>
        <button type="button" data-mcl-miss aria-expanded="${state.openMiss === c.id ? 'true' : 'false'}" class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition disabled:opacity-50" ${state.busy ? 'disabled' : ''}>Missed…</button>
        <button type="button" data-mcl-close="dropped" class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition disabled:opacity-50" ${state.busy ? 'disabled' : ''}>Drop</button>
      </div>
      ${state.openMiss === c.id ? `<div class="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
        <label for="mcl-reason-${Number(c.id)}" class="text-xs font-semibold text-gray-700">Why was it missed?</label>
        <select id="mcl-reason-${Number(c.id)}" data-mcl-reason class="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
          <option value="">Pick one…</option>${reasons.map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}
        </select>
        <label for="mcl-note-${Number(c.id)}" class="sr-only">A few words</label>
        <input id="mcl-note-${Number(c.id)}" data-mcl-note type="text" maxlength="500" placeholder="A few words (needed for Other)" class="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
        <button type="button" data-mcl-close="missed" class="btn-primary mt-2 px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50" ${state.busy ? 'disabled' : ''}>Save</button>
      </div>` : ''}` : ''}
    </li>`;
  }

  function render() {
    const el = host();
    if (!el) return;
    const wrap = (inner) => `<section class="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 sm:p-6 min-w-0" data-mentor-panel="commitments">${inner}</section>`;
    if (state.error && !state.data) { el.innerHTML = wrap(`<h3 class="text-lg font-bold text-gray-900">Commitments</h3><p class="text-sm text-red-600 mt-1">${esc(state.error)}</p>`); return; }
    if (!state.data) { el.innerHTML = wrap('<p class="text-sm text-gray-400 animate-pulse">Loading…</p>'); return; }
    const d = state.data;
    if (!d.ready) { el.innerHTML = wrap('<h3 class="text-lg font-bold text-gray-900">Commitments</h3><p class="text-sm text-gray-600 mt-1">Commitments aren’t switched on for this workspace yet.</p>'); return; }
    const list = d.commitments || [];
    const thisWeek = list.filter((c) => c.weekStart === d.week);
    const mineThisWeek = thisWeek.filter((c) => c.ownerUserId === d.me && c.status !== 'dropped' && c.status !== 'missed').length;
    const room = Math.max(0, (d.maxPerWeek || 3) - mineThisWeek);
    const earlier = list.filter((c) => c.weekStart !== d.week);
    const weeks = [...new Set(earlier.map((c) => c.weekStart))];
    el.innerHTML = wrap(`
      <h3 class="text-lg font-bold text-gray-900">Commitments</h3>
      <p class="text-sm text-gray-500 mt-1">Up to ${d.maxPerWeek || 3} things each person will do this week. ${esc(state.assistantName)} asks how they went at the end of the week — and learns from why one was missed.</p>
      <h4 class="text-xs font-bold uppercase tracking-wide text-gray-500 mt-4">This week (from ${esc(ukDate(d.week))})</h4>
      ${thisWeek.length ? `<ul class="mt-1">${thisWeek.map((c) => rowHtml(c, d)).join('')}</ul>` : '<p class="text-sm text-gray-500 mt-1">Nothing set yet this week.</p>'}
      ${room ? `<div class="mt-3">
        <label for="mcl-add" class="text-xs font-semibold text-gray-700">Add one for this week</label>
        <div class="flex flex-wrap gap-2 mt-1">
          <input id="mcl-add" data-mcl-add type="text" maxlength="200" value="${esc(state.draft[0])}" placeholder="e.g. Call three past customers" class="min-w-0 flex-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm">
          <button type="button" data-mcl-add-go class="btn-primary shrink-0 px-3 py-1.5 text-sm font-bold rounded-lg transition disabled:opacity-50" ${state.busy ? 'disabled' : ''}>Add</button>
        </div>
        <p class="text-[11px] text-gray-500 mt-1">${room} more this week.</p>
      </div>` : ''}
      ${state.note ? `<p class="mt-2 text-xs font-semibold ${state.note.error ? 'text-red-600' : 'text-pink-700'}" role="status" aria-live="polite">${esc(state.note.text)}</p>` : ''}
      ${weeks.length ? `<details class="mt-4"><summary class="cursor-pointer text-sm font-semibold text-gray-700">Earlier weeks</summary>
        ${weeks.map((w) => `<h4 class="text-xs font-bold uppercase tracking-wide text-gray-500 mt-3">Week of ${esc(ukDate(w))}</h4><ul class="mt-1">${earlier.filter((c) => c.weekStart === w).map((c) => rowHtml(c, d)).join('')}</ul>`).join('')}
      </details>` : ''}`);
  }

  async function run(work, okText) {
    if (state.busy) return;
    state.busy = true; state.note = null; render();
    try {
      await work(window.MentorApply);
      state.note = okText ? { text: okText } : null;
      state.openMiss = null;
      state.busy = false;
      await load();
    } catch (err) {
      state.busy = false;
      state.note = { text: err.message, error: true };
      render();
    }
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !host()?.contains(t)) return;
    if (t.closest('[data-mcl-add-go]')) {
      const text = (host().querySelector('[data-mcl-add]')?.value || '').trim();
      if (!text) { state.note = { text: 'Write what you’ll do first.', error: true }; render(); return; }
      run((A) => A.commitmentsAdd([text]).then(() => { state.draft[0] = ''; }), 'Added.');
      return;
    }
    const li = t.closest('[data-commitment]');
    if (!li) return;
    const id = Number(li.getAttribute('data-commitment'));
    if (t.closest('[data-mcl-miss]')) { state.openMiss = state.openMiss === id ? null : id; render(); return; }
    const close = t.closest('[data-mcl-close]');
    if (!close) return;
    const status = close.getAttribute('data-mcl-close');
    if (status === 'missed') {
      const reason = li.querySelector('[data-mcl-reason]')?.value || '';
      const note = (li.querySelector('[data-mcl-note]')?.value || '').trim();
      if (!reason) { state.note = { text: 'Pick why it was missed.', error: true }; render(); return; }
      run((A) => A.commitmentClose(id, 'missed', reason, note), 'Saved — thanks for saying why.');
      return;
    }
    run((A) => A.commitmentClose(id, status), status === 'done' ? 'Marked done.' : 'Dropped.');
  });
  // The add box keeps what is typed across repaints (a card saved in chat reloads this list).
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t instanceof Element && t.matches('[data-mcl-add]') && host()?.contains(t)) state.draft[0] = t.value;
  });
  document.addEventListener('mentor:commitmentsChanged', () => { if (host() && state.data) load(); });

  window.MentorCommitments = {
    init({ assistantName }) {
      state.assistantName = assistantName || 'Your Mentor';
      state.data = null; state.error = null; state.note = null; state.openMiss = null; state.busy = false;
      render();
      load();
    },
  };
})();
