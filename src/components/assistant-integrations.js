// src/components/assistant-integrations.js
// Assistant Profile › Connections › "Synced actions" — surfaces the Integration Scenario
// Library (netlify/functions/integration-scenarios.ts) INSIDE the assistant detail Connections
// tab, scoped to this assistant and filtered to the recipes relevant to its role. The workspace
// hub (integrations.html) shows every recipe for a picked assistant; this embeds just the ones
// that can actually fire for THIS assistant, with the same enable / connect-first / configure /
// toggle / remove flow. active_scenarios are per-assistant, so this reads/writes the same rows.
//
//   window.AssistantIntegrations.init({ assistantId })   — mount once at page setup
//   window.AssistantIntegrations.refresh()               — re-read on Connections tab open
//
// Relevance: a recipe's scenarioType must be applicable to the assistant's Review-Queue
// recordType (read live from window._detailReviewQueue so it survives registry ordering), OR the
// recipe is already active for this assistant. Roadmap (tier 3) recipes are left to the hub.
(function () {
  'use strict';
  const API = '/api/integrations';

  // Which scenarioTypes can fire for a given Review-Queue recordType. Mirrors the trigger
  // statuses in scenario-engine.ts (meeting→MEETING_BOOKED, lead→QUALIFIED + inbound CRM sync).
  const RELEVANT_TYPES = {
    meeting: ['meeting_handoff'],
    lead: ['handoff_push', 'feedback_loop', 'suppression_sync'],
  };

  const state = { assistantId: null, scenarios: [] };
  let _wired = false;

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function host() { return document.getElementById('assistant-integrations-host'); }
  function recordType() { return (window._detailReviewQueue || {}).recordType || null; }

  // Recipes to show: relevant-and-available, plus any already active for this assistant.
  function relevantScenarios() {
    const types = RELEVANT_TYPES[recordType()] || [];
    return state.scenarios.filter((s) =>
      s.active || (types.includes(s.scenarioType) && s.tier !== 3 && s.status === 'available'));
  }

  function dirLabel(s) {
    return s.direction === 'inbound' ? '← in' : s.direction === 'two_way' ? '⇄ 2-way' : '→ out';
  }

  // Card action — mirrors integrations.html ctaFor(): connect-first gate, enable, or the
  // enabled toggle + configure + remove cluster. No tier-3 upvote here (filtered out).
  function ctaFor(s) {
    if (s.active) {
      const on = s.active.isEnabled;
      const dot = on ? 'bg-emerald-600' : 'bg-gray-400';
      return '<div class="flex items-center gap-2">' +
        '<button type="button" data-toggle="' + s.active.id + '" data-enabled="' + (on ? '1' : '0') + '" class="inline-flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm font-bold text-gray-700 cursor-pointer"><span class="w-1.5 h-1.5 rounded-full ' + dot + '"></span>' + (on ? 'Enabled' : 'Disabled') + '</button>' +
        '<button type="button" data-config="' + s.id + '" class="grow px-3 py-2 bg-white border border-gray-200 text-gray-600 text-sm font-bold rounded-lg cursor-pointer">Configure</button>' +
        '<button type="button" data-remove="' + s.active.id + '" class="px-3 py-2 text-gray-400 hover:text-red-600 text-sm font-bold rounded-lg cursor-pointer" title="Remove">✕</button>' +
      '</div>';
    }
    // Tier-1 recipes need the provider connected first; tier-2 (webhook) and connection-optional
    // (e.g. email) providers enable directly.
    if (s.tier !== 2 && !s.connection && !s.connectionOptional) {
      return '<a href="/api/oauth/' + esc(s.providerKey) + '/connect" class="block w-full text-center px-4 py-2 bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50 text-sm font-bold rounded-lg transition">Connect ' + esc(s.providerName) + ' first</a>';
    }
    return '<button type="button" data-config="' + s.id + '" class="w-full px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition cursor-pointer">Enable</button>';
  }

  function card(s) {
    const connected = s.active || s.connection || s.connectionOptional || s.tier === 2;
    const statusPill = s.active
      ? '<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border ' + (s.active.isEnabled ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-100 text-gray-500 border-gray-200') + '">' + (s.active.isEnabled ? '✓ Enabled' : 'Disabled') + '</span>'
      : connected
        ? '<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200">Not enabled</span>'
        : '<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">⚠ Connect ' + esc(s.providerName) + '</span>';
    return '<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 flex flex-col gap-3">' +
      '<div class="flex items-start justify-between gap-2">' +
        '<div class="flex items-center gap-2 flex-wrap">' + statusPill + '<span class="text-xs font-semibold text-gray-400">' + dirLabel(s) + '</span></div>' +
        '<span class="text-xs font-semibold text-gray-400">' + esc(s.providerName) + '</span>' +
      '</div>' +
      '<div class="grow"><p class="font-bold text-gray-900">' + esc(s.title) + '</p>' +
        '<p class="text-sm text-gray-500 mt-1">' + esc(s.description) + '</p></div>' +
      ctaFor(s) +
    '</div>';
  }

  function render() {
    const h = host();
    if (!h) return;
    const list = relevantScenarios();
    if (!list.length) { h.innerHTML = ''; h.classList.add('hidden'); return; }
    h.classList.remove('hidden');
    h.innerHTML =
      '<div class="mb-3">' +
        '<h3 class="text-lg font-bold text-gray-900">Synced actions</h3>' +
        '<p class="text-sm text-gray-500 mt-1">Prebuilt recipes that push this assistant’s work into your tools when you approve it. Connect the tool, then enable the recipe.</p>' +
      '</div>' +
      '<div class="grid grid-cols-1 sm:grid-cols-2 gap-5 items-start">' + list.map(card).join('') + '</div>';
  }

  async function load() {
    const h = host();
    if (!h) return;
    try {
      const res = await fetch(API + '/scenarios?assistantId=' + encodeURIComponent(state.assistantId));
      if (!res.ok) throw new Error('status ' + res.status);
      state.scenarios = (await res.json()).scenarios || [];
      render();
    } catch (e) {
      // Degrade quietly — the platform grid + Revoke All above stay usable.
      h.innerHTML = '<p class="text-sm text-gray-400">Couldn’t load synced actions.</p>';
      h.classList.remove('hidden');
    }
  }

  // ── Config / field-mapping modal (built lazily, appended to body) ──
  let modalEl = null;
  let editing = null;

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'fixed inset-0 z-[60] hidden items-center justify-center bg-black/40 p-4';
    modalEl.innerHTML =
      '<div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">' +
        '<div class="flex items-start justify-between gap-3 mb-1"><h3 data-ai-title class="text-lg font-bold text-gray-900"></h3>' +
          '<button type="button" data-ai-close class="text-gray-400 hover:text-gray-600 text-xl leading-none cursor-pointer">×</button></div>' +
        '<p data-ai-desc class="text-sm text-gray-500 mb-4"></p>' +
        '<div data-ai-webhook class="hidden mb-4"><label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Webhook URL</label>' +
          '<input data-ai-webhook-url type="url" placeholder="https://…" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-emerald-500"></div>' +
        '<div data-ai-fields class="space-y-2.5 mb-4"></div>' +
        '<p data-ai-error class="hidden text-sm font-semibold text-red-600 mb-3"></p>' +
        '<div class="flex justify-end gap-2"><button type="button" data-ai-cancel class="px-4 py-2 bg-white border border-gray-200 text-gray-600 text-sm font-bold rounded-lg cursor-pointer">Cancel</button>' +
          '<button type="button" data-ai-save class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg cursor-pointer">Enable</button></div>' +
      '</div>';
    document.body.appendChild(modalEl);
    modalEl.querySelector('[data-ai-close]').addEventListener('click', closeModal);
    modalEl.querySelector('[data-ai-cancel]').addEventListener('click', closeModal);
    modalEl.querySelector('[data-ai-save]').addEventListener('click', saveModal);
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
    return modalEl;
  }

  function openModal(s) {
    editing = s;
    const m = ensureModal();
    m.querySelector('[data-ai-title]').textContent = s.title;
    m.querySelector('[data-ai-desc]').textContent = s.description || '';
    m.querySelector('[data-ai-error]').classList.add('hidden');
    const webhookWrap = m.querySelector('[data-ai-webhook]');
    const webhookInput = m.querySelector('[data-ai-webhook-url]');
    if (s.tier === 2) { webhookWrap.classList.remove('hidden'); webhookInput.value = (s.active && s.active.webhookUrl) || ''; }
    else webhookWrap.classList.add('hidden');

    const map = (s.active && s.active.fieldMappings) || {};
    const fields = Array.isArray(s.fieldSchema) ? s.fieldSchema : [];
    m.querySelector('[data-ai-fields]').innerHTML = fields.length
      ? '<p class="text-xs font-bold text-gray-500 uppercase tracking-wide">Field mapping</p>' + fields.map((f) => {
          const val = map[f.bmsField] != null ? map[f.bmsField] : (f.defaultTarget || '');
          return '<div class="flex items-center gap-2"><span class="w-1/2 text-sm font-medium text-gray-700 truncate">' + esc(f.label) + (f.required ? ' *' : '') + '</span>' +
            '<span class="text-gray-300">→</span>' +
            '<input data-ai-map="' + esc(f.bmsField) + '" value="' + esc(val) + '" placeholder="external field" class="w-1/2 px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-emerald-500"></div>';
        }).join('')
      : '<p class="text-sm text-gray-500">This recipe has no fields to map — it runs automatically once enabled.</p>';
    m.querySelector('[data-ai-save]').textContent = s.active ? 'Save changes' : 'Enable recipe';
    m.classList.remove('hidden');
    m.classList.add('flex');
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.classList.add('hidden');
    modalEl.classList.remove('flex');
    editing = null;
  }

  async function saveModal() {
    if (!editing) return;
    const m = modalEl;
    const errEl = m.querySelector('[data-ai-error]');
    const fieldMappings = {};
    m.querySelectorAll('[data-ai-map]').forEach((i) => { if (i.value.trim()) fieldMappings[i.getAttribute('data-ai-map')] = i.value.trim(); });
    const payload = { scenarioId: editing.id, assistantId: Number(state.assistantId), fieldMappings };
    if (editing.tier === 2) {
      const url = m.querySelector('[data-ai-webhook-url]').value.trim();
      if (!/^https:\/\//.test(url)) { errEl.textContent = 'Enter a valid https webhook URL.'; errEl.classList.remove('hidden'); return; }
      payload.webhookUrl = url;
    } else if (editing.connection) {
      payload.integrationId = editing.connection.id;
    }
    const btn = m.querySelector('[data-ai-save]');
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Saving…';
    try {
      const res = await fetch(API + '/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not enable this recipe.');
      closeModal();
      window.showToast && window.showToast('Recipe enabled.');
      load();
    } catch (e) {
      errEl.textContent = String(e.message || 'Could not enable this recipe.'); errEl.classList.remove('hidden');
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  // ── Card actions (delegated on the host) ──
  function wireOnce() {
    if (_wired) return;
    _wired = true;
    document.addEventListener('click', async (e) => {
      const h = host();
      if (!h || !h.contains(e.target)) return;

      const cfg = e.target.closest('[data-config]');
      if (cfg) { const s = state.scenarios.find((x) => String(x.id) === cfg.getAttribute('data-config')); if (s) openModal(s); return; }

      const tog = e.target.closest('[data-toggle]');
      if (tog) {
        const id = Number(tog.getAttribute('data-toggle'));
        const next = tog.getAttribute('data-enabled') !== '1';
        tog.disabled = true;
        try {
          const res = await fetch(API + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeScenarioId: id, isEnabled: next }) });
          if (res.ok) load();
        } catch (err) { /* leave the card as-is on failure */ } finally { tog.disabled = false; }
        return;
      }

      const rm = e.target.closest('[data-remove]');
      if (rm) {
        if (!window.confirm('Remove this recipe? It will stop firing for this assistant.')) return;
        try {
          const res = await fetch(API + '/deactivate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeScenarioId: Number(rm.getAttribute('data-remove')) }) });
          if (res.ok) load();
        } catch (err) { /* no-op */ }
        return;
      }
    });
  }

  async function init({ assistantId } = {}) {
    if (!assistantId) return;
    state.assistantId = assistantId;
    wireOnce();
    await load();
  }

  async function refresh() {
    if (!state.assistantId) return;
    await load();
  }

  window.AssistantIntegrations = { init, refresh };
})();
