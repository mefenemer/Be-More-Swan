/**
 * src/components/mentor-review-all.js
 * "Review all" (docs/business-mentor-plan.md §3.13, §14): every Business Mentor suggestion still waiting,
 * together, each with its preview and its own tick. ONE component for the three places it appears:
 *   - the chat's `mentor_review_all` card (disruptive-ui-registry.js mounts it inline),
 *   - the Mentor's Overview tab (assistant-mentor-overview.js, a "Review all" button → openDialog),
 *   - Inbox "Needs you" (notifications.js, the Mentor strip → openDialog).
 *
 * Rules: nothing is pre-ticked; one click applies only the ticked ones, one after another, each through
 * its own card's action (window.MentorApply.applyCard — the same endpoint as that card in chat), then
 * records it as accepted (mentor.ts). Any that fail are reported one by one beside the suggestion and
 * stay ticked so they can be tried again; nothing is hidden.
 *
 * Reads GET /.netlify/functions/mentor → `open`. Handlers are bound once per mount, to the host, never
 * from render. Server values are escaped.
 */
(function () {
  const API = '/.netlify/functions/mentor';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const PROFILE_LABELS = { businessDescription: 'Business description', targetAudience: 'Who your customers are', industry: 'Industry', websiteUrl: 'Website' };

  /** What the suggestion would change, in a line or two. */
  function previewHtml(card) {
    if (!card || typeof card !== 'object') return '';
    if (card.type === 'mentor_business_profile') {
      const f = card.fields || {};
      return Object.keys(PROFILE_LABELS).filter((k) => f[k]).map((k) =>
        `<p class="text-xs text-gray-700 break-words"><span class="font-semibold">${esc(PROFILE_LABELS[k])}:</span> ${esc(String(f[k]).slice(0, 240))}</p>`).join('');
    }
    if (card.type === 'mentor_products') {
      const list = Array.isArray(card.products) ? card.products : [];
      return `<p class="text-xs text-gray-700 break-words"><span class="font-semibold">Add to Products &amp; Services:</span> ${esc(list.map((p) => p.name).join(', '))}</p>`;
    }
    if (card.type === 'setup_field_proposal') {
      return `<p class="text-xs text-gray-700 break-words"><span class="font-semibold">${esc(card.assistantName)} · ${esc(card.label)}:</span> ${esc(card.currentLabel || 'Not answered')} → <span class="font-semibold text-gray-900">${esc(card.valueLabel ?? card.value)}</span></p>`;
    }
    return '';
  }

  function mount(host, opts = {}) {
    if (!host) return;
    const st = { items: null, error: null, ticked: new Set(), results: {}, busy: false, summary: '' };

    async function load() {
      st.error = null;
      try {
        const res = await fetch(API, { credentials: 'same-origin' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Couldn’t load (HTTP ${res.status}).`);
        st.items = Array.isArray(body.open) ? body.open : [];
      } catch (err) {
        st.error = err.message || 'Couldn’t load your suggestions.';
      }
      render();
    }

    function render() {
      if (st.error) {
        host.innerHTML = `<p class="text-sm text-red-600">${esc(st.error)}</p>
          <button type="button" data-mra-retry class="btn-secondary mt-2 px-3 py-1.5 border text-xs font-bold rounded-lg">Try again</button>`;
        return;
      }
      if (!st.items) { host.innerHTML = '<p class="text-sm text-gray-400 animate-pulse">Loading…</p>'; return; }
      if (!st.items.length) {
        host.innerHTML = '<p class="text-sm text-gray-600" data-mra-empty>No suggestions are waiting. New ones appear here and in chat.</p>';
        return;
      }
      const n = st.ticked.size;
      const rows = st.items.map((it) => {
        const r = st.results[it.id];
        const done = r && r.ok;
        return `<li class="py-2.5 border-b border-gray-100 last:border-0">
          <label class="flex items-start gap-3 ${done ? 'opacity-70' : 'cursor-pointer'}">
            <input type="checkbox" data-mra-tick="${Number(it.id)}" class="mt-1 h-5 w-5 shrink-0 rounded border-gray-300" ${st.ticked.has(it.id) && !done ? 'checked' : ''} ${done || st.busy ? 'disabled' : ''} aria-describedby="mra-why-${Number(it.id)}">
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold text-gray-900 break-words">${esc(it.title)}</span>
              ${previewHtml(it.card)}
              ${it.why ? `<span id="mra-why-${Number(it.id)}" class="block mt-1 text-xs text-blue-800"><span class="font-bold">Why?</span> ${esc(it.why)}</span>` : ''}
              ${r ? `<span class="block mt-1 text-xs font-semibold ${r.ok ? 'text-green-700' : 'text-red-600'}" role="status">${r.ok ? '✓ Saved' : `✗ Not saved: ${esc(r.error)}`}</span>` : ''}
            </span>
          </label>
        </li>`;
      }).join('');
      host.innerHTML = `
        <p class="text-xs text-gray-600">Tick the ones you want. Nothing is ticked for you, and only the ticked ones change.</p>
        <ul class="mt-1" data-mra-list>${rows}</ul>
        <div class="flex flex-wrap items-center gap-2 mt-3">
          <button type="button" data-mra-apply class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${n && !st.busy ? '' : 'disabled'}>${st.busy ? 'Saving…' : n ? `Apply ${n} ticked` : 'Apply ticked'}</button>
          ${opts.onClose ? '<button type="button" data-mra-close class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition">Close</button>' : ''}
        </div>
        ${st.summary ? `<p class="mt-2 text-xs font-semibold text-gray-800" role="status" aria-live="polite">${esc(st.summary)}</p>` : ''}`;
    }

    async function applyTicked() {
      const chosen = st.items.filter((it) => st.ticked.has(it.id) && !(st.results[it.id] && st.results[it.id].ok));
      if (!chosen.length || st.busy || !window.MentorApply) return;
      st.busy = true; st.summary = ''; render();
      let ok = 0; let failed = 0;
      for (const it of chosen) {
        try {
          await window.MentorApply.applyCard(it.card);
          st.results[it.id] = { ok: true };
          st.ticked.delete(it.id);
          ok++;
          // The change is saved; recording it is bookkeeping, so its failure isn't the user's problem.
          await window.MentorApply.decide(it.id, 'accepted').catch(() => {});
        } catch (err) {
          st.results[it.id] = { ok: false, error: err.message || 'That couldn’t be saved.' };
          failed++;
        }
        render();
      }
      st.busy = false;
      st.summary = failed
        ? `${ok} saved, ${failed} not saved — each one that failed says why above, and is still ticked to try again.`
        : `${ok} saved.`;
      render();
    }

    host.addEventListener('change', (e) => {
      const t = e.target.closest('[data-mra-tick]');
      if (!t) return;
      const id = Number(t.getAttribute('data-mra-tick'));
      if (t.checked) st.ticked.add(id); else st.ticked.delete(id);
      render();
    });
    host.addEventListener('click', (e) => {
      if (e.target.closest('[data-mra-apply]')) { applyTicked(); return; }
      if (e.target.closest('[data-mra-retry]')) { load(); return; }
      if (e.target.closest('[data-mra-close]') && opts.onClose) opts.onClose();
    });

    render();
    load();
  }

  /** "Review all" as a dialog (Overview tab, Inbox). Marked data-dialog so /dialogs.js holds focus and Escape. */
  function openDialog() {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-dialog', '');
    // Inline styles for what the prebuilt style.css may not carry (arbitrary values).
    overlay.className = 'fixed inset-0 flex items-end sm:items-center justify-center p-0 sm:p-4';
    overlay.style.cssText = 'z-index:70;background:rgba(17,24,39,.45)';
    overlay.innerHTML = `
      <div class="bg-white w-full sm:max-w-lg overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-xl p-5" style="max-height:90vh">
        <div class="flex items-start justify-between gap-3">
          <h2 class="text-lg font-bold text-gray-900">Review all suggestions</h2>
          <button type="button" data-dialog-cancel aria-label="Close" class="btn-utility shrink-0 w-9 h-9 rounded-lg border text-lg leading-none">×</button>
        </div>
        <div class="mt-2" data-mra-dialog-host></div>
      </div>`;
    const close = () => { overlay.remove(); document.dispatchEvent(new CustomEvent('mentor:changed', { detail: { reviewAll: true } })); };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-dialog-cancel]')) close();
    });
    document.body.appendChild(overlay);
    mount(overlay.querySelector('[data-mra-dialog-host]'), { onClose: close });
  }

  window.MentorReviewAll = { mount, openDialog, previewHtml };
})();
