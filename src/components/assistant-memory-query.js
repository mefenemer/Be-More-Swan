/**
 * src/components/assistant-memory-query.js
 * "Ask your memory" — the conversational query surface over the account graph (Phase 3 §5.5).
 *
 * Mounts INSIDE the Data Hub tab, above the records table. That placement is the design (§5.5):
 * users keep the table they know, and the change is that both now read the same memory layer.
 * Replacing the table would trade a thing that works for a thing that sometimes does.
 *
 * Backed by netlify/functions/memory-query.ts:
 *   • context → POST { action:'context', assistantId }            — cheap; drives the empty state
 *   • ask     → POST { action:'ask', assistantId, question, accountNodeId? }
 *
 * ── Rendering rules that are not negotiable ──────────────────────────────────
 * Every value here originates as either MODEL OUTPUT or a PROSPECT'S EMAIL TEXT. Both are
 * untrusted:
 *   • everything is escaped through esc() before it reaches innerHTML;
 *   • NOTHING is ever interpolated into an onclick or any inline handler — actions go through
 *     delegated listeners reading data-* attributes, so a citation snippet containing a quote
 *     character cannot become script.
 * Styling reuses classes already compiled into style.css (no Tailwind rebuild — a rebuild churns
 * unrelated selectors).
 */
(function () {
  const API = '/.netlify/functions/memory-query';

  const state = {
    assistantId: null,
    hasMemory: false,
    counts: { memories: 0, unembedded: 0, accounts: 0 },
    accounts: [],
    accountNodeId: null,
    question: '',
    result: null,          // { answer, empty, reason, citations, related, stats }
    loading: false,
    error: null,
    expanded: new Set(),   // citation numbers whose full snippet is open
    rendered: false,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const host = () => document.getElementById('memory-query-host');

  async function call(action, extra) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action, assistantId: state.assistantId, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function loadContext() {
    try {
      const res = await call('context', {});
      state.hasMemory = !!res.hasMemory;
      state.counts = res.counts || state.counts;
      state.accounts = Array.isArray(res.accounts) ? res.accounts : [];
      state.error = null;
    } catch (err) {
      // A missing migration or a cold table must not blank the Data Hub — the panel simply
      // does not offer itself.
      state.error = err.message || 'Could not reach memory.';
      state.hasMemory = false;
    }
    render();
  }

  async function ask() {
    const q = state.question.trim();
    if (!q || state.loading) return;
    state.loading = true;
    state.error = null;
    state.expanded = new Set();
    render();
    try {
      state.result = await call('ask', { question: q, accountNodeId: state.accountNodeId });
    } catch (err) {
      state.error = err.message || 'Could not search memory.';
      state.result = null;
    }
    state.loading = false;
    render();
  }

  /**
   * Turn the model's [1] / [2][3] markers into styled chips.
   *
   * Runs on ALREADY-ESCAPED text — esc() first, then this. Doing it the other way round would let
   * an answer containing "<b>[1]</b>" inject markup, because this function writes raw HTML.
   * The regex only ever matches digits, so nothing from the model reaches the attribute.
   */
  function withCitationChips(escapedAnswer, maxN) {
    return escapedAnswer.replace(/\[(\d{1,2})\]/g, (whole, n) => {
      const num = parseInt(n, 10);
      if (!num || num > maxN) return whole;   // a hallucinated citation stays plain text
      return `<button type="button" data-cite="${num}" class="inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1 rounded text-xs font-black bg-emerald-100 text-emerald-700 hover:bg-emerald-200 cursor-pointer">${num}</button>`;
    });
  }

  function sourceLabel(t) {
    return { message: 'Email', outcome: 'Deal outcome', engagement: 'Engagement', note: 'Note' }[t] || 'Record';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function renderResult() {
    const r = state.result;
    if (!r) return '';

    if (r.empty) {
      return `<div class="mt-4 p-4 rounded-xl bg-gray-50 border border-gray-200 text-sm text-gray-600">
        ${esc(r.reason || 'Nothing on file for that yet.')}
      </div>`;
    }

    const cites = Array.isArray(r.citations) ? r.citations : [];
    const answerHtml = withCitationChips(esc(r.answer || ''), cites.length);

    const sources = cites.map((c) => {
      const open = state.expanded.has(c.n);
      const snippet = open ? esc(c.snippet) : esc(c.snippet.slice(0, 160)) + (c.snippet.length > 160 ? '…' : '');
      return `<li id="memq-cite-${c.n}" class="p-3 rounded-lg border border-gray-200 bg-white">
        <div class="flex items-center gap-2 mb-1">
          <span class="inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1 rounded text-xs font-black bg-emerald-100 text-emerald-700">${c.n}</span>
          <span class="text-xs font-bold text-gray-700">${esc(sourceLabel(c.sourceType))}</span>
          ${c.accountLabel ? `<span class="text-xs text-gray-500">· ${esc(c.accountLabel)}</span>` : ''}
          <span class="text-xs text-gray-400 ml-auto">${esc(fmtDate(c.occurredAt))}</span>
        </div>
        <p class="text-sm text-gray-600 whitespace-pre-wrap break-words">${snippet}</p>
        ${c.snippet.length > 160 ? `<button type="button" data-expand="${c.n}" class="mt-1 text-xs font-bold text-emerald-700 hover:underline cursor-pointer">${open ? 'Show less' : 'Show more'}</button>` : ''}
      </li>`;
    }).join('');

    const related = Array.isArray(r.related) ? r.related.filter((n) => n.depth > 0) : [];
    const relatedHtml = related.length
      ? `<div class="mt-4">
           <h4 class="text-xs font-black text-gray-500 uppercase tracking-wide mb-2">Related</h4>
           <div class="flex flex-wrap gap-1.5">
             ${related.slice(0, 12).map((n) => `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-100 text-xs text-gray-700">${esc(n.label)}<span class="text-gray-400">${esc(n.nodeType)}</span></span>`).join('')}
           </div>
         </div>`
      : '';

    const s = r.stats;
    const statsHtml = s
      ? `<p class="mt-3 text-xs text-gray-500">Across all closed deals: ${s.won} won · ${s.lost} lost · ${s.disqualified} disqualified.</p>`
      : '';

    return `<div class="mt-4">
      <div class="p-4 rounded-xl bg-emerald-50 border border-emerald-200">
        <p class="text-sm text-gray-800 whitespace-pre-wrap break-words leading-relaxed">${answerHtml}</p>
        ${statsHtml}
      </div>
      ${sources ? `<h4 class="text-xs font-black text-gray-500 uppercase tracking-wide mt-4 mb-2">Sources</h4><ul class="space-y-2">${sources}</ul>` : ''}
      ${relatedHtml}
    </div>`;
  }

  function render() {
    const el = host();
    if (!el) return;

    // No memory and no error: stay completely out of the way. An empty "Ask your memory" box that
    // can never answer anything is worse than no box — it advertises a broken feature.
    if (!state.hasMemory && !state.result && !state.loading) {
      el.innerHTML = '';
      el.classList.add('hidden');
      el.style.display = 'none';
      return;
    }
    el.classList.remove('hidden');
    el.style.display = '';

    const accountOptions = ['<option value="">All accounts</option>']
      .concat(state.accounts.map((a) => `<option value="${Number(a.id)}"${state.accountNodeId === a.id ? ' selected' : ''}>${esc(a.label)}</option>`))
      .join('');

    // Surfaced deliberately: without VOYAGE_API_KEY rows are stored unembedded and retrieval
    // silently degrades to keyword search. A working-but-worse system should say so.
    const degraded = state.counts.unembedded > 0
      ? `<p class="mt-2 text-xs text-amber-700">${state.counts.unembedded} of ${state.counts.memories} records are not indexed for meaning yet — answers fall back to keyword matching for those.</p>`
      : '';

    el.innerHTML = `
      <div class="mb-6 p-4 sm:p-5 bg-white border border-gray-200 rounded-2xl shadow-sm">
        <div class="flex items-center gap-2 mb-3">
          <svg class="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          <h3 class="text-sm font-black text-gray-900">Ask your memory</h3>
          <span class="text-xs text-gray-500">${state.counts.memories} record${state.counts.memories === 1 ? '' : 's'} · ${state.counts.accounts} account${state.counts.accounts === 1 ? '' : 's'}</span>
        </div>
        <p class="text-xs text-gray-500 mb-3">Ask about anything this assistant has recorded — conversations, objections, outcomes. Every answer cites the records it came from.</p>
        <div class="flex flex-col sm:flex-row gap-2">
          <select id="memq-account" class="w-full sm:w-auto px-3 py-2 text-sm border border-gray-300 rounded-xl bg-white cursor-pointer">${accountOptions}</select>
          <input id="memq-input" type="text" maxlength="500" value="${esc(state.question)}"
            placeholder="e.g. what objections come up most often?"
            class="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-xl" />
          <button type="button" id="memq-ask" ${state.loading ? 'disabled' : ''}
            class="px-4 py-2 text-sm font-extrabold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-sm transition-colors cursor-pointer disabled:opacity-60">
            ${state.loading ? 'Searching…' : 'Ask'}
          </button>
        </div>
        ${degraded}
        ${state.error ? `<p class="mt-3 text-sm text-red-600">${esc(state.error)}</p>` : ''}
        ${renderResult()}
      </div>`;

    wire();
  }

  function wire() {
    const el = host();
    if (!el) return;

    const input = document.getElementById('memq-input');
    if (input) {
      input.addEventListener('input', (e) => { state.question = e.target.value; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(); } });
    }
    document.getElementById('memq-account')?.addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      state.accountNodeId = Number.isInteger(v) ? v : null;
    });
    document.getElementById('memq-ask')?.addEventListener('click', ask);

    // Delegated — citation chips and "show more" are rendered from untrusted text, so their
    // behaviour lives here and reads a numeric data attribute rather than an inline handler.
    el.addEventListener('click', (e) => {
      const cite = e.target.closest('[data-cite]');
      if (cite) {
        const target = document.getElementById(`memq-cite-${parseInt(cite.dataset.cite, 10)}`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('ring-2', 'ring-emerald-400');
          setTimeout(() => target.classList.remove('ring-2', 'ring-emerald-400'), 1200);
        }
        return;
      }
      const exp = e.target.closest('[data-expand]');
      if (exp) {
        const n = parseInt(exp.dataset.expand, 10);
        if (state.expanded.has(n)) state.expanded.delete(n); else state.expanded.add(n);
        render();
      }
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  window.AssistantMemoryQuery = {
    init({ assistantId }) {
      state.assistantId = assistantId;
      state.rendered = false;
      state.result = null;
      state.question = '';
      state.accountNodeId = null;
    },
    /** Called when the Data Hub tab is activated. Loads once, then repaints cheaply. */
    activate() {
      if (!state.assistantId) return;
      if (state.rendered) { render(); return; }
      state.rendered = true;
      loadContext();
    },
    refresh: loadContext,
  };
})();
