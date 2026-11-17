// src/components/assistant-integrations.js
// Assistant Settings › Connections › "Synced actions" — surfaces the Integration Scenario
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
  function connectHref(providerKey) {
    const id = Number(state.assistantId);
    return '/api/oauth/' + encodeURIComponent(providerKey) + '/connect' + (Number.isInteger(id) && id > 0 ? '?assistantId=' + id : '');
  }
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
    // Tier-1 recipes need the provider connected first — the email recipes need Gmail or Outlook (owner,
    // 2026-11-17: no mailbox, no email; nothing is sent from Be More Swan's address); tier-2 (webhook) enables directly.
    if (s.tier !== 2 && !s.connection && s.needsMailbox) {
      return '<span class="flex gap-1.5 shrink-0"><a href="' + connectHref('gmail') + '" class="' + ROW_BTN + ' btn-secondary">Connect Gmail</a>' +
        '<a href="' + connectHref('outlook') + '" class="' + ROW_BTN + ' btn-secondary">Connect Outlook</a></span>';
    }
    if (s.tier !== 2 && !s.connection) {
      // ?assistantId= brings the user back to THIS assistant's Connections tab after sign-in (or with the
      // error, if it failed) — without it oauth-integrations.ts had nowhere to return them but the
      // workspace-wide integrations.html (found connecting Slack/Notion/Jira, 2026-11-16).
      return '<a href="' + connectHref(s.providerKey) + '" class="' + ROW_BTN + ' btn-primary border-transparent">Connect ' + esc(s.providerName) + '</a>';
    }
    return '<button type="button" data-config="' + s.id + '" class="' + ROW_BTN + ' btn-primary border-transparent">' + (Array.isArray(s.settings) && s.settings.length ? 'Set up' : 'Switch on') + '</button>';
  }

  // Category of each recipe provider, so the connector grid can suppress a "coming soon"
  // card for a capability that already appears here as an enable-able recipe.
  const PROVIDER_CATEGORY = { hubspot: 'crm', salesforce: 'crm', pipedrive: 'crm', zoho: 'crm', asana: 'project_mgmt', jira: 'project_mgmt', slack: 'chat', notion: 'knowledge', email: 'email' };

  // Publish the capabilities covered by enable-able recipes, then re-render the connector
  // grid so it can drop duplicate "coming soon" cards. One-way: the grid never calls back.
  function publishCoveredCategories(list) {
    window._syncedActionCategories = new Set(list.map((s) => PROVIDER_CATEGORY[s.providerKey]).filter(Boolean));
    // Redraw, not reload: the grid's data is already loaded (or about to be — its own load draws
    // again when it lands). Reloading here fetched integrations a second time on every page.
    if (typeof window._intRenderConnections === 'function') window._intRenderConnections();
    else if (typeof window._intLoadConnections === 'function') window._intLoadConnections();
  }

  // ── Tool → its actions (owner, 2026-11-17: "connect to a tool, then you can do certain things with it") ──
  // Each tool is one row (connected, or a Connect button), and what this assistant does with it — its
  // ACTIONS, the old "recipes" — sit underneath, each with its switch. A tool that needs no connection
  // (email: the Gmail/Outlook rows already sit in the section above) shows only its actions.
  const PROVIDER_ICON = { slack: '💬', notion: '📝', jira: '🗂️', asana: '✅', email: '✉️', hubspot: '🧲', salesforce: '☁️', pipedrive: '📈', zoho: '📇', custom_webhook: '🔗' };

  function actionRow(s, connected) {
    const on = !!(s.active && s.active.isEnabled);
    // A follow-up switched on before the mailbox went away still shows its state — and that it won't send.
    const noMailbox = s.needsMailbox && !s.connection;
    const stateText = noMailbox
      ? (on ? 'On, but not sending — connect Gmail or Outlook above' : 'Connect Gmail or Outlook above first — follow-ups only go from your own inbox')
      : s.active ? (on ? 'On' : 'Off') : connected ? 'Off' : 'Connect ' + esc(s.providerName) + ' first';
    const control = noMailbox && !s.active ? '<span class="shrink-0 text-xs font-semibold text-gray-400">No inbox connected</span>'
      : connected || noMailbox ? controlFor(s) : '<span class="shrink-0 text-xs font-semibold text-gray-400">Not connected</span>';
    const manage = s.active
      ? '<div class="flex items-center gap-2 flex-wrap">' +
          (Array.isArray(s.settings) && s.settings.length || (Array.isArray(s.fieldSchema) && s.fieldSchema.length) || s.tier === 2
            ? '<button type="button" data-config="' + s.id + '" class="' + ROW_BTN + ' btn-secondary">Settings</button>' : '') +
          '<button type="button" data-remove="' + s.active.id + '" class="' + ROW_BTN + ' btn-destructive">Remove</button>' +
        '</div>'
      : '';
    const kebab = manage
      ? '<button type="button" aria-label="Manage ' + esc(s.title) + '" aria-expanded="false"' +
          ' onclick="var p=this.closest(\'[data-action-row]\').querySelector(\'[data-conn-manage]\');var o=p.classList.toggle(\'hidden\');this.setAttribute(\'aria-expanded\',String(!o))"' +
          ' class="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition cursor-pointer">' +
          '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z"/></svg>' +
        '</button>'
      : '<span class="shrink-0 w-8"></span>';
    return '<div data-action-row="' + esc(s.id) + '" class="py-2.5 pl-11 pr-4">' +
      '<div class="flex items-center gap-3">' +
        '<div class="flex-1 min-w-0">' +
          '<p class="text-sm font-semibold text-gray-900">' + esc(s.title) + '</p>' +
          '<p class="text-xs text-gray-500">' + esc(s.description || '') + '</p>' +
          '<p class="text-[11px] font-bold mt-0.5 ' + (noMailbox ? 'text-amber-700' : on ? 'text-emerald-700' : 'text-gray-400') + '">' + stateText + '</p>' +
        '</div>' + control + kebab +
      '</div>' +
      (manage ? '<div data-conn-manage class="hidden mt-2">' + manage + '</div>' : '') +
    '</div>';
  }

  function toolBlock(list) {
    const s0 = list[0];
    // No tool row of its own: the webhook, and email (its Gmail/Outlook rows sit in the section above).
    const optional = !!s0.needsMailbox || s0.tier === 2;
    const connected = s0.tier === 2 || !!s0.connection;
    const icon = PROVIDER_ICON[s0.providerKey] || '🔌';
    const head = optional ? '' :
      '<div class="px-4 pt-3 pb-1 flex items-center gap-3">' +
        '<div class="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center text-base shrink-0" aria-hidden="true">' + icon + '</div>' +
        '<div class="flex-1 min-w-0"><p class="text-sm font-bold text-gray-900">' + esc(s0.providerName) + '</p>' +
          '<p class="text-xs ' + (connected ? 'text-emerald-700' : 'text-gray-500') + '">' + (connected ? '✓ Connected' : 'Not connected') + '</p></div>' +
        (connected ? '' : '<a href="' + connectHref(s0.providerKey) + '" class="' + ROW_BTN + ' btn-primary border-transparent">Connect ' + esc(s0.providerName) + '</a>') +
        '<span class="shrink-0 w-8"></span>' +
      '</div>';
    return '<div data-tool-block="' + esc(s0.providerKey) + '" data-ai-actions class="py-1">' + head +
      '<p class="pl-11 pr-4 text-[11px] font-bold uppercase tracking-wide text-gray-400 ' + (optional ? 'mt-2' : 'mt-1') + '">Actions</p>' +
      list.map((s) => actionRow(s, connected)).join('') +
    '</div>';
  }

  /** { category: { html, on, connected } } — what integrations.js draws inside each section. */
  function buildGroups(list) {
    const byCat = {};
    for (const s of list) {
      const cat = PROVIDER_CATEGORY[s.providerKey] || s.providerCategory || 'other';
      (byCat[cat] = byCat[cat] || {})[s.providerKey] = (byCat[cat][s.providerKey] || []).concat(s);
    }
    const out = {};
    for (const [cat, tools] of Object.entries(byCat)) {
      const all = [].concat(...Object.values(tools));
      out[cat] = {
        html: Object.values(tools).map(toolBlock).join(''),
        on: all.filter((s) => s.active && s.active.isEnabled).length,
        connected: Object.values(tools).filter((t) => t[0].connection).length,
      };
    }
    return out;
  }

  function render() {
    const h = host();
    if (!h) return;
    const list = relevantScenarios();
    // Drawn INSIDE the Connections sections by integrations.js (one tool, then its actions), so the
    // separate list above the connectors is gone. The host stays as the fallback for a page without them.
    window._syncedActionGroups = buildGroups(list);
    publishCoveredCategories(list);
    if (typeof window._intRenderConnections === 'function' || typeof window._intLoadConnections === 'function') {
      h.innerHTML = ''; h.classList.add('hidden'); return;
    }
    if (!list.length) { h.innerHTML = ''; h.classList.add('hidden'); return; }
    h.classList.remove('hidden');
    h.innerHTML = '<div class="bg-white rounded-2xl border border-gray-200 shadow-sm divide-y divide-gray-100">' +
      Object.values(window._syncedActionGroups).map((g) => g.html).join('') + '</div>';
  }

  async function load() {
    const h = host();
    if (!h) return;
    try {
      // Shared GET cache (cached-fetch.js): the page load and opening Settings → Connections asked for
      // the same list seconds apart. Any activate / toggle / remove (a POST) clears it.
      const url = API + '/scenarios?assistantId=' + encodeURIComponent(state.assistantId);
      const res = await (window.bmsCachedFetch ? window.bmsCachedFetch(url, { ttlMs: 300000 }) : fetch(url));
      if (!res.ok) throw new Error('status ' + res.status);
      state.scenarios = (await res.json()).scenarios || [];
      render();
      openPendingSetup();
    } catch (e) {
      // Degrade quietly — the platform grid + Revoke All above stay usable.
      h.innerHTML = '<p class="text-sm text-gray-400">Couldn’t load this assistant’s actions.</p>';
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
    // This list is rendered inside the Assistant Settings slide-over, which would otherwise
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
    // Recipes with real settings (src/config/recipe-settings.ts): pickers filled from the tool, not the
    // catalogue's field-mapping form (recipe-settings-form.js, shared with integrations.html).
    if (Array.isArray(s.settings) && s.settings.length && window.RecipeSettingsForm) {
      window.RecipeSettingsForm.render(m.querySelector('[data-ai-fields]'), s, map);
      m.querySelector('[data-ai-save]').textContent = s.active ? 'Save changes' : 'Switch on';
      m.classList.remove('hidden');
      m.classList.add('flex');
      return;
    }
    const fields = Array.isArray(s.fieldSchema) ? s.fieldSchema : [];
    m.querySelector('[data-ai-fields]').innerHTML = fields.length
      ? '<p class="text-xs font-bold text-gray-500 uppercase tracking-wide">Field mapping</p>' + fields.map((f) => {
          const val = map[f.bmsField] != null ? map[f.bmsField] : (f.defaultTarget || '');
          return '<div class="flex items-center gap-2"><span class="w-1/2 text-sm font-medium text-gray-700 truncate">' + esc(f.label) + (f.required ? ' *' : '') + '</span>' +
            '<span class="text-gray-300">→</span>' +
            '<input data-ai-map="' + esc(f.bmsField) + '" value="' + esc(val) + '" placeholder="external field" class="w-1/2 px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-emerald-500"></div>';
        }).join('')
      : '<p class="text-sm text-gray-500">Nothing to set up — once it’s on, it runs by itself.</p>';
    m.querySelector('[data-ai-save]').textContent = s.active ? 'Save changes' : 'Switch on';
    m.classList.remove('hidden');
    m.classList.add('flex');
  }

  // One task tool per assistant: the server switched the other one off — say so, in plain words.
  function switchedOffNote(s, switchedOff) {
    if (!s || !Array.isArray(switchedOff) || !switchedOff.length) return '';
    return 'Tasks now go to ' + s.providerName + '. ' + switchedOff.join(' and ') + ' is switched off — one task tool at a time.';
  }

  // Just connected a tool (workspace.html sets this from ?oauth_success=): open its recipe's settings
  // when they are still missing, so the next step — choose the project or channel — is right there.
  function openPendingSetup() {
    const provider = window._pendingRecipeSetup;
    if (!provider) return;
    window._pendingRecipeSetup = null;
    const s = relevantScenarios().find((x) => x.providerKey === provider && Array.isArray(x.settings) && x.settings.length
      && (!x.active || x.settings.some((d) => d.required && !((x.active.fieldMappings || {})[d.key]))));
    if (s && s.connection) openModal(s);
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
    let fieldMappings = {};
    if (Array.isArray(editing.settings) && editing.settings.length && window.RecipeSettingsForm) {
      const got = window.RecipeSettingsForm.collect(m.querySelector('[data-ai-fields]'), editing);
      if (got.error) { errEl.textContent = got.error; errEl.classList.remove('hidden'); return; }
      fieldMappings = got.fieldMappings;
    } else {
      m.querySelectorAll('[data-ai-map]').forEach((i) => { if (i.value.trim()) fieldMappings[i.getAttribute('data-ai-map')] = i.value.trim(); });
    }
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
      if (!res.ok) throw new Error(data.error || 'Couldn’t switch this on.');
      closeModal();
      window.showToast && window.showToast(switchedOffNote(editing, data.switchedOff) || 'Switched on.');
      load();
    } catch (e) {
      errEl.textContent = String(e.message || 'Couldn’t switch this on.'); errEl.classList.remove('hidden');
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  // ── Card actions (delegated on the host) ──
  function wireOnce() {
    if (_wired) return;
    _wired = true;
    document.addEventListener('click', async (e) => {
      // Actions are drawn inside the Connections sections (integrations.js) or, as a fallback, the host.
      if (!e.target.closest('[data-ai-actions]') && !(host() && host().contains(e.target))) return;

      const cfg = e.target.closest('[data-config]');
      if (cfg) { const s = state.scenarios.find((x) => String(x.id) === cfg.getAttribute('data-config')); if (s) openModal(s); return; }

      const tog = e.target.closest('[data-toggle]');
      if (tog) {
        const id = Number(tog.getAttribute('data-toggle'));
        const next = tog.getAttribute('data-enabled') !== '1';
        tog.disabled = true;
        try {
          const res = await fetch(API + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeScenarioId: id, isEnabled: next }) });
          if (res.ok) {
            const data = await res.json().catch(() => ({}));
            const s = state.scenarios.find((x) => x.active && x.active.id === id);
            const note = switchedOffNote(s, data.switchedOff);
            if (note && window.showToast) window.showToast(note);
            load();
          } else {
            // Refused (e.g. the follow-up with no Gmail or Outlook connected): say why, and redraw so the
            // switch the click already flipped goes back.
            const err = await res.json().catch(() => ({}));
            if (window.showToast) window.showToast(err.error || 'That couldn’t be changed. Please try again.', { tone: 'error' });
            load();
          }
        } catch (err) { /* leave the card as-is on failure */ } finally { tog.disabled = false; }
        return;
      }

      const rm = e.target.closest('[data-remove]');
      if (rm) {
        if (!(await window.confirmModal('This assistant stops doing it. You can add it again any time.', { title: 'Remove this action?', confirmLabel: 'Remove' }))) return;
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
