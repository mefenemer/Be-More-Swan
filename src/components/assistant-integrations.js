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

  // One recipe = one ROW, in the same list language as the connector rows below it
  // (integrations.js _connRow — the Social Media Assistant's Connections layout): icon, title,
  // provider + direction, the ONE control that matters in its state, and Configure / Remove
  // behind ⋮. Mirrors integrations.html ctaFor()'s states: connect-first gate, enable, or the
  // enabled switch. No tier-3 upvote here (filtered out). Handlers are delegated (wireOnce).
  const ROW_BTN = 'shrink-0 inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg border transition cursor-pointer';

  function controlFor(s) {
    if (s.active) {
      const on = s.active.isEnabled;
      // The click lands on the input (the label forwards it), which carries data-toggle.
      return '<label class="relative shrink-0 cursor-pointer" title="' + (on ? 'Enabled — click to pause' : 'Paused — click to enable') + '">' +
        '<input type="checkbox" class="sr-only peer" data-toggle="' + s.active.id + '" data-enabled="' + (on ? '1' : '0') + '" aria-label="' + esc(s.title) + ' enabled"' + (on ? ' checked' : '') + '>' +
        '<span class="block w-11 h-6 bg-gray-200 rounded-full peer-checked:bg-emerald-700 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-200 transition-colors after:content-[\'\'] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:shadow-sm after:transition-all peer-checked:after:translate-x-full peer-checked:after:border-white"></span>' +
      '</label>';
    }
    // Tier-1 recipes need the provider connected first; tier-2 (webhook) and connection-optional
    // (e.g. email) providers enable directly.
    if (s.tier !== 2 && !s.connection && !s.connectionOptional) {
      return '<a href="/api/oauth/' + esc(s.providerKey) + '/connect" class="' + ROW_BTN + ' btn-primary border-transparent">Connect ' + esc(s.providerName) + '</a>';
    }
    return '<button type="button" data-config="' + s.id + '" class="' + ROW_BTN + ' btn-primary border-transparent">Enable</button>';
  }

  function card(s) {
    const connected = s.active || s.connection || s.connectionOptional || s.tier === 2;
    const stateText = s.active
      ? (s.active.isEnabled ? 'Enabled' : 'Paused')
      : connected ? 'Not enabled' : 'Connect ' + esc(s.providerName) + ' first';
    const manage = s.active
      ? '<div class="flex items-center gap-2 flex-wrap">' +
          '<button type="button" data-config="' + s.id + '" class="' + ROW_BTN + ' btn-secondary">Configure</button>' +
          '<button type="button" data-remove="' + s.active.id + '" class="' + ROW_BTN + ' btn-destructive">Remove</button>' +
        '</div>' +
        '<p class="text-xs text-gray-500 mt-2">' + esc(s.description) + '</p>'
      : '';
    const kebab = manage
      ? '<button type="button" aria-label="Manage ' + esc(s.title) + '" aria-expanded="false"' +
          ' onclick="var p=this.closest(\'[data-conn-row]\').querySelector(\'[data-conn-manage]\');var o=p.classList.toggle(\'hidden\');this.setAttribute(\'aria-expanded\',String(!o))"' +
          ' class="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition cursor-pointer">' +
          '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z"/></svg>' +
        '</button>'
      : '<span class="shrink-0 w-8"></span>';
    return '<div data-conn-row="recipe-' + esc(s.id) + '" class="px-4 py-3">' +
      '<div class="flex items-center gap-3">' +
        '<div class="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center text-base shrink-0">⚡</div>' +
        '<div class="flex-1 min-w-0">' +
          '<p class="text-sm font-bold text-gray-900 truncate" title="' + esc(s.description) + '">' + esc(s.title) + '</p>' +
          '<p class="text-xs ' + (connected ? 'text-gray-500' : 'text-amber-700') + ' truncate">' + esc(s.providerName) + ' ' + dirLabel(s) + ' · ' + stateText + '</p>' +
        '</div>' +
        controlFor(s) +
        kebab +
      '</div>' +
      (manage ? '<div data-conn-manage class="hidden mt-2 pl-11">' + manage + '</div>' : '') +
    '</div>';
  }

  // Category of each recipe provider, so the connector grid can suppress a "coming soon"
  // card for a capability that already appears here as an enable-able recipe.
  const PROVIDER_CATEGORY = { hubspot: 'crm', salesforce: 'crm', pipedrive: 'crm', zoho: 'crm', asana: 'project_mgmt', jira: 'project_mgmt', slack: 'chat', notion: 'knowledge', email: 'email' };

  // Publish the capabilities covered by enable-able recipes, then re-render the connector
  // grid so it can drop duplicate "coming soon" cards. One-way: the grid never calls back.
  function publishCoveredCategories(list) {
    window._syncedActionCategories = new Set(list.map((s) => PROVIDER_CATEGORY[s.providerKey]).filter(Boolean));
    if (typeof window._intLoadConnections === 'function') window._intLoadConnections();
  }

  function render() {
    const h = host();
    if (!h) return;
    const list = relevantScenarios();
    publishCoveredCategories(list);
    if (!list.length) { h.innerHTML = ''; h.classList.add('hidden'); return; }
    h.classList.remove('hidden');
    // No heading here — the unified "Synced actions" heading lives in assistant-detail.html
    // above this host, so these enable-able recipe cards read as part of that one section.
    h.innerHTML =
      '<div class="bg-white rounded-2xl border border-gray-200 shadow-sm divide-y divide-gray-100">' + list.map(card).join('') + '</div>';
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
        '<div class="flex justify-end gap-2"><button type="button" data-ai-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg cursor-pointer">Cancel</button>' +
          '<button type="button" data-ai-save class="btn-primary px-4 py-2 text-sm font-bold rounded-lg cursor-pointer">Enable</button></div>' +
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
    // This list is rendered inside the Assistant Profile slide-over, which would otherwise
    // stay open over the top of this modal (the drawer sits at z-9001, this at z-60).
    if (document.body.classList.contains('brief-drawer-open')) window._closeBriefDrawer?.();
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
