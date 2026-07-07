/**
 * src/components/assistant-lead-ideas.js
 *
 * "Review Lead Ideas" flow for the Lead Generator (roleKey lead_qualifier) on
 * assistant-detail.html — the role-relevant replacement for the social "Review
 * Pending Items" button. Drives the Overview #btn-lead-ideas button and a modal:
 *
 *   • Propose ideas   → POST lead-generation { action:'generate_ideas' }
 *   • List ideas      → POST lead-generation { action:'list_ideas' }
 *   • Approve an idea → POST lead-generation { action:'approve_idea', ideaId }
 *                       the assistant finds, scores and files matching leads (into the
 *                       Leads Data Hub tab) and tags each with a next-best-action owner —
 *                       handled here vs handed off to another assistant.
 *   • Decline an idea → POST lead-generation { action:'decline_idea', ideaId }
 *
 * Wiring (assistants.js → _applyDashboardRegistry):
 *   window.AssistantLeadIdeas.init({ assistantId, cfg });   // cfg = registry.ideasReview
 *
 * Every idea/lead field is stored LLM output — treat as untrusted, escape on render.
 */
(function () {
  'use strict';

  const API = '/.netlify/functions/lead-generation';
  const state = { assistantId: null, cfg: null, overlay: null };

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function call(action, extra) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, assistantId: state.assistantId, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  const RATING_CHIP = {
    hot: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    warm: 'bg-amber-50 text-amber-800 border-amber-200',
    cold: 'bg-gray-50 text-gray-500 border-gray-200',
  };

  function body() { return state.overlay?.querySelector('[data-ideas-body]'); }

  function setBody(html) { const b = body(); if (b) b.innerHTML = html; }

  function ideaCard(idea) {
    const d = idea.data || {};
    const declined = idea.status === 'declined';
    const approved = String(idea.status || '').startsWith('approved');
    const meta = [d.demographic, d.industrySector, d.companySizeBand].filter(Boolean).map(esc).join(' · ');
    return `
      <div class="border border-gray-200 rounded-xl p-4 ${declined ? 'opacity-60' : ''}" data-idea="${idea.id}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-bold text-gray-900">${esc(d.title || idea.title)}</p>
            ${meta ? `<p class="text-xs text-gray-500 mt-0.5">${meta}</p>` : ''}
          </div>
          ${approved ? '<span class="shrink-0 text-xs font-bold px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-800 border-emerald-200">Approved</span>'
            : declined ? '<span class="shrink-0 text-xs font-bold px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200">Declined</span>' : ''}
        </div>
        ${d.rationale ? `<p class="text-sm text-gray-600 mt-2">${esc(d.rationale)}</p>` : ''}
        ${!approved && !declined ? `
          <div class="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
            <button type="button" data-approve="${idea.id}"
              class="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Approve &amp; find leads</button>
            <button type="button" data-decline="${idea.id}"
              class="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 hover:border-gray-300 text-xs font-bold rounded-lg transition disabled:opacity-60">Decline</button>
            <span class="hidden text-xs font-semibold text-red-600" data-idea-status></span>
          </div>` : ''}
        <div data-idea-results></div>
      </div>`;
  }

  function leadRow(lead) {
    const d = lead.data || {};
    const chip = RATING_CHIP[d.rating] || RATING_CHIP.cold;
    const owner = lead.owner !== 'lead_qualifier'
      ? `<span class="text-xs text-gray-500"> → hand off to <span class="font-semibold text-gray-700">${esc(lead.ownerName)}</span></span>` : '';
    return `
      <li class="py-2">
        <div class="flex items-center gap-2">
          <span class="text-xs font-bold px-2 py-0.5 rounded-full border shrink-0 ${chip}">${esc(d.score)}/100</span>
          <span class="font-semibold text-gray-900 text-sm truncate">${esc(d.leadName)}</span>
        </div>
        ${d.suggestedNextStep ? `<p class="text-xs text-gray-600 mt-1"><span class="font-semibold">Next:</span> ${esc(d.suggestedNextStep)}${owner}</p>` : owner ? `<p class="text-xs mt-1">${owner}</p>` : ''}
      </li>`;
  }

  function renderResults(container, data) {
    const handledHere = data.handledHere || [];
    const handoffs = data.handoffs || [];
    container.innerHTML = `
      <div class="mt-3 pt-3 border-t border-gray-100 space-y-3">
        <p class="text-sm font-semibold text-emerald-800">Found &amp; scored ${data.leads.length} lead${data.leads.length === 1 ? '' : 's'} — now in your Leads tab.</p>
        ${handledHere.length ? `
          <div>
            <p class="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Ready for the Lead Generator</p>
            <ul class="divide-y divide-gray-100">${handledHere.map(leadRow).join('')}</ul>
          </div>` : ''}
        ${handoffs.length ? `
          <div>
            <p class="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Needs another assistant</p>
            <ul class="divide-y divide-gray-100">${handoffs.map(leadRow).join('')}</ul>
          </div>` : ''}
      </div>`;
  }

  function emptyState() {
    return `
      <div class="text-center py-10">
        <p class="text-4xl mb-3">💡</p>
        <p class="font-bold text-gray-900 mb-1">No lead ideas yet</p>
        <p class="text-sm text-gray-500 max-w-sm mx-auto mb-5">${esc(state.cfg?.description || 'Let the Lead Generator suggest where to find your next customers — review and approve the ones worth pursuing.')}</p>
        <button type="button" data-generate
          class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Propose lead ideas</button>
      </div>`;
  }

  function renderList(ideas) {
    setBody(`
      <div class="space-y-3">${ideas.map(ideaCard).join('')}</div>
      <div class="mt-4 pt-4 border-t border-gray-100 flex justify-center">
        <button type="button" data-generate
          class="px-4 py-2 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Propose more ideas</button>
      </div>`);
    wireList();
  }

  async function refresh() {
    setBody('<p class="text-sm text-gray-400 py-8 text-center">Loading…</p>');
    try {
      const { ideas } = await call('list_ideas');
      if (!ideas || ideas.length === 0) setBody(emptyState());
      else renderList(ideas);
      wireGenerate();
    } catch (err) {
      setBody(`<div class="bg-red-50 border border-red-200 rounded-xl p-4 text-sm font-semibold text-red-700">${esc(err.message)}</div>`);
    }
  }

  async function generate(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
    try {
      await call('generate_ideas');
      await refresh();
    } catch (err) {
      setBody(`<div class="bg-red-50 border border-red-200 rounded-xl p-4 text-sm font-semibold text-red-700">${esc(err.message)}</div>
        <div class="mt-3 text-center"><button type="button" data-generate class="px-4 py-2 bg-emerald-700 text-white text-sm font-bold rounded-lg">Try again</button></div>`);
      wireGenerate();
    }
  }

  function wireGenerate() {
    body()?.querySelectorAll('[data-generate]').forEach((b) => b.addEventListener('click', () => generate(b)));
  }

  function wireList() {
    const b = body();
    if (!b) return;
    b.querySelectorAll('[data-approve]').forEach((btn) => btn.addEventListener('click', () => approve(btn)));
    b.querySelectorAll('[data-decline]').forEach((btn) => btn.addEventListener('click', () => decline(btn)));
  }

  async function approve(btn) {
    const ideaId = Number(btn.getAttribute('data-approve'));
    const card = btn.closest('[data-idea]');
    const results = card?.querySelector('[data-idea-results]');
    const statusEl = card?.querySelector('[data-idea-status]');
    btn.disabled = true;
    const declineBtn = card?.querySelector('[data-decline]');
    if (declineBtn) declineBtn.disabled = true;
    btn.textContent = 'Finding & scoring leads…';
    if (statusEl) statusEl.classList.add('hidden');
    try {
      const data = await call('approve_idea', { ideaId });
      // Approval now launches a background discovery run (real web search) rather than
      // returning fabricated leads synchronously. Show a "run started" state in place.
      btn.parentElement?.remove();
      const configured = data.searchConfigured !== false;
      if (results) {
        results.innerHTML = `
          <div class="mt-3 pt-3 border-t border-gray-100">
            <p class="text-sm font-semibold ${configured ? 'text-emerald-800' : 'text-amber-800'}">
              ${configured ? '🔍 Discovery run started' : '⚠️ Search provider not connected'}
            </p>
            <p class="text-xs text-gray-600 mt-1">${esc(data.message || 'Found leads will appear in your Leads tab for approval shortly.')}</p>
          </div>`;
      }
      window.showToast?.(configured
        ? 'Discovery run started — leads will appear in your Leads tab shortly.'
        : 'Idea approved. Connect a web search provider to start discovering leads.');
      window._leadIdeasDidAddLeads = true;
    } catch (err) {
      btn.disabled = false;
      if (declineBtn) declineBtn.disabled = false;
      btn.textContent = 'Approve & find leads';
      if (statusEl) { statusEl.textContent = err.message; statusEl.classList.remove('hidden'); }
    }
  }

  async function decline(btn) {
    const ideaId = Number(btn.getAttribute('data-decline'));
    btn.disabled = true;
    try {
      await call('decline_idea', { ideaId });
      await refresh();
    } catch (err) {
      btn.disabled = false;
      const statusEl = btn.closest('[data-idea]')?.querySelector('[data-idea-status]');
      if (statusEl) { statusEl.textContent = err.message; statusEl.classList.remove('hidden'); }
    }
  }

  function open() {
    if (!state.assistantId) return;
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100 shrink-0">
          <div>
            <h3 class="text-lg font-bold text-gray-900">${esc(state.cfg?.title || 'Lead Ideas')}</h3>
            <p class="text-sm text-gray-500 mt-0.5">Approve an idea and the Lead Generator finds, scores and files matching leads.</p>
          </div>
          <button type="button" data-ideas-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer">&times;</button>
        </div>
        <div class="p-5 overflow-y-auto" data-ideas-body></div>
      </div>`;
    const close = () => {
      overlay.remove();
      state.overlay = null;
      // If any idea produced leads, refresh the Data Hub so the Leads tab reflects them.
      if (window._leadIdeasDidAddLeads) {
        window._leadIdeasDidAddLeads = false;
        window.AssistantDataHub?.init?.({
          hub: window.AssistantDashboardRegistry?.get('lead_qualifier')?.hubTab,
          assistantId: state.assistantId,
        });
      }
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-ideas-close]').addEventListener('click', close);
    document.body.appendChild(overlay);
    state.overlay = overlay;
    refresh();
  }

  function init({ assistantId, cfg }) {
    if (!assistantId) return;
    state.assistantId = assistantId;
    state.cfg = cfg || null;
    const btn = document.getElementById('btn-lead-ideas');
    if (btn && !btn.dataset.ideasWired) {
      btn.dataset.ideasWired = '1';
      btn.addEventListener('click', open);
    }
  }

  window.AssistantLeadIdeas = { init, open };
})();
