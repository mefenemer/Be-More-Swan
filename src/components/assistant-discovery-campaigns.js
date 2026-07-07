/**
 * src/components/assistant-discovery-campaigns.js
 *
 * "Find New Leads" flow for the Lead Generator (roleKey lead_qualifier) on
 * assistant-detail.html — lets the user author an outbound discovery *campaign*
 * (an Idea / Blueprint + cadence + guardrails), then launches a background run that
 * searches the public web, dedupes, scores and files real leads into the Leads tab
 * (pending approval). Backed by netlify/functions/discovery-campaigns.ts.
 *
 *   • Create campaign → POST discovery-campaigns { action:'create', ... }  (one_off runs now)
 *   • List campaigns  → POST discovery-campaigns { action:'list', assistantId }
 *   • Run now         → POST discovery-campaigns { action:'run_now', campaignId }
 *   • View leads      → POST discovery-campaigns { action:'list_leads', campaignId }
 *
 * Wiring (assistants.js → _applyDashboardRegistry):
 *   window.AssistantDiscoveryCampaigns.init({ assistantId, cfg });  // cfg = registry.discoveryCampaigns
 *
 * Every campaign/lead field is stored (user- or LLM-authored) — treat as untrusted, escape on render.
 * Uses only Tailwind classes already present in the compiled style.css (no rebuild needed).
 */
(function () {
  'use strict';

  const API = '/.netlify/functions/discovery-campaigns';
  const state = { assistantId: null, cfg: null, overlay: null, searchConfigured: true };

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

  const STATUS_CHIP = {
    completed: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    processing: 'bg-blue-50 text-blue-800 border-blue-200',
    queued: 'bg-amber-50 text-amber-800 border-amber-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
  };
  const RATING_CHIP = {
    hot: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    warm: 'bg-amber-50 text-amber-800 border-amber-200',
    cold: 'bg-gray-50 text-gray-500 border-gray-200',
  };

  function body() { return state.overlay?.querySelector('[data-dc-body]'); }
  function setBody(html) { const b = body(); if (b) b.innerHTML = html; }

  // ── Views ─────────────────────────────────────────────────────────────────

  function form() {
    return `
      <div class="border border-gray-200 rounded-xl p-4">
        <p class="font-bold text-gray-900">Describe who you want to find</p>
        <p class="text-xs text-gray-500 mt-0.5 mb-3">A plain-English hypothesis. The Lead Generator turns it into web searches, then scores what it finds.</p>
        <textarea data-dc-idea rows="3" class="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm"
          placeholder="e.g. Boutique hotels in Southern Europe that don't have a modern online booking app"></textarea>

        <div class="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">How often</label>
            <select data-dc-cadence class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">
              <option value="one_off">Run once now</option>
              <option value="daily">Daily at 08:00 UTC</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Max leads / run</label>
            <input data-dc-maxleads type="number" min="1" value="50" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Max spend / run (£)</label>
            <input data-dc-budget type="number" min="0" step="0.5" value="2" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Exclude (comma-sep)</label>
            <input data-dc-negatives type="text" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm" placeholder="competitor.com, acme">
          </div>
        </div>

        <label class="flex items-center gap-2 mt-3 text-sm text-gray-700">
          <input data-dc-approval type="checkbox" checked class="rounded border-gray-300 text-emerald-700 focus:ring-emerald-700">
          Review found leads before any outreach (recommended)
        </label>

        <div class="flex items-center gap-2 mt-4">
          <button type="button" data-dc-create class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Start finding leads</button>
          <span class="hidden text-xs font-semibold text-red-600" data-dc-error></span>
        </div>
      </div>`;
  }

  function campaignCard(c) {
    const chip = STATUS_CHIP[c.latestJobStatus] || 'bg-gray-50 text-gray-500 border-gray-200';
    const statusLabel = c.latestJobStatus ? esc(c.latestJobStatus) : 'no runs yet';
    const running = c.latestJobStatus === 'queued' || c.latestJobStatus === 'processing';
    const paused = c.status === 'paused';
    const ghost = 'px-2.5 py-1 bg-white border border-gray-200 text-gray-600 hover:border-gray-300 text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed';
    // Primary action: Cancel while a run is in flight, else Run now (blocked while paused).
    const primaryBtn = running
      ? `<button type="button" data-dc-cancel="${c.id}" class="px-3 py-1.5 bg-white border border-gray-200 text-red-600 hover:border-red-300 hover:bg-red-50 text-xs font-bold rounded-lg transition">Cancel run</button>`
      : `<button type="button" data-dc-run="${c.id}" class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed" ${paused ? 'disabled title="Resume this campaign to run it"' : ''}>Run now</button>`;
    return `
      <div class="border border-gray-200 rounded-xl p-4 ${paused ? 'opacity-70' : ''}" data-campaign="${c.id}" data-dc-idea-val="${esc(c.idea)}"
           data-dc-maxleads-val="${esc(c.maxLeadsPerRun ?? 50)}" data-dc-budget-val="${esc(c.maxCostGbpPerRun ?? 2)}"
           data-dc-negatives-val="${esc(Array.isArray(c.negativeKeywords) ? c.negativeKeywords.join(', ') : '')}"
           data-dc-approval-val="${c.requireHumanApproval === false ? '0' : '1'}">
        <div class="flex items-start justify-between gap-3">
          <p class="font-semibold text-gray-900 text-sm min-w-0">${esc(c.idea)}</p>
          <span class="shrink-0 text-xs font-bold px-2 py-0.5 rounded-full border ${paused ? 'bg-gray-100 text-gray-500 border-gray-200' : chip}">${paused ? 'paused' : statusLabel}</span>
        </div>
        <p class="text-xs text-gray-500 mt-1">${Number(c.leadsFound || 0)} lead${Number(c.leadsFound) === 1 ? '' : 's'} found</p>
        <div class="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-gray-100">
          ${primaryBtn}
          <button type="button" data-dc-view="${c.id}" class="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 hover:border-gray-300 text-xs font-bold rounded-lg transition">View leads</button>
          <button type="button" data-dc-edit="${c.id}" class="${ghost}">Edit</button>
          <button type="button" data-dc-toggle="${c.id}" data-paused="${paused ? '1' : '0'}" class="${ghost}">${paused ? 'Resume' : 'Pause'}</button>
          <button type="button" data-dc-archive="${c.id}" class="${ghost} text-gray-400 hover:text-red-600 hover:border-red-300 ml-auto">Archive</button>
          <span class="hidden text-xs font-semibold text-red-600 w-full" data-dc-cerror></span>
        </div>
        <div data-dc-leads></div>
      </div>`;
  }

  function render(campaigns) {
    const warn = state.searchConfigured ? '' : `
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs font-semibold text-amber-800">
        No web search provider is connected yet — campaigns will run but find nothing until one is set up.
      </div>`;
    const list = campaigns.length
      ? `<div class="space-y-3">${campaigns.map(campaignCard).join('')}</div>`
      : `<p class="text-sm text-gray-400 text-center py-4">No campaigns yet — describe your first one above.</p>`;
    setBody(`<div class="space-y-4">${warn}${form()}<div><p class="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Your campaigns</p>${list}</div></div>`);
    wire();
  }

  function leadRow(l) {
    const chip = RATING_CHIP[l.rating] || RATING_CHIP.cold;
    const via = l.discoveredVia ? `<span class="text-gray-400"> · ${esc(l.discoveredVia.replace(/_/g, ' '))}</span>` : '';
    return `
      <li class="py-2">
        <div class="flex items-center gap-2">
          <span class="text-xs font-bold px-2 py-0.5 rounded-full border shrink-0 ${chip}">${l.score == null ? '—' : esc(l.score) + '/100'}</span>
          <span class="font-semibold text-gray-900 text-sm truncate">${esc(l.companyName)}</span>
        </div>
        <p class="text-xs text-gray-500 mt-0.5">${esc(l.domain || '')}${via}</p>
      </li>`;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function refresh() {
    setBody('<p class="text-sm text-gray-400 py-8 text-center">Loading…</p>');
    try {
      const { campaigns, searchConfigured } = await call('list');
      state.searchConfigured = searchConfigured !== false;
      render(campaigns || []);
    } catch (err) {
      setBody(`<div class="bg-red-50 border border-red-200 rounded-xl p-4 text-sm font-semibold text-red-700">${esc(err.message)}</div>`);
    }
  }

  async function create(btn) {
    const root = body();
    const idea = root.querySelector('[data-dc-idea]')?.value.trim();
    const errEl = root.querySelector('[data-dc-error]');
    if (errEl) errEl.classList.add('hidden');
    if (!idea) { if (errEl) { errEl.textContent = 'Describe who you want to find first.'; errEl.classList.remove('hidden'); } return; }

    const negatives = (root.querySelector('[data-dc-negatives]')?.value || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const payload = {
      idea,
      cadence: root.querySelector('[data-dc-cadence]')?.value || 'one_off',
      guardrails: {
        maxLeadsPerRun: Number(root.querySelector('[data-dc-maxleads]')?.value) || undefined,
        maxCostGbpPerRun: Number(root.querySelector('[data-dc-budget]')?.value) || undefined,
        negativeKeywords: negatives.length ? negatives : undefined,
        requireHumanApproval: !!root.querySelector('[data-dc-approval]')?.checked,
      },
    };
    btn.disabled = true; btn.textContent = 'Starting…';
    try {
      const data = await call('create', payload);
      state.searchConfigured = data.searchConfigured !== false;
      window.showToast?.(state.searchConfigured
        ? 'Campaign started — leads will appear in your Leads tab shortly.'
        : 'Campaign saved. Connect a web search provider to start finding leads.');
      window._leadIdeasDidAddLeads = true;
      await refresh();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Start finding leads';
      if (errEl) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
    }
  }

  async function runNow(btn) {
    const id = Number(btn.getAttribute('data-dc-run'));
    btn.disabled = true; btn.textContent = 'Running…';
    try {
      const data = await call('run_now', { campaignId: id });
      window.showToast?.(data.alreadyRunning ? 'A run is already in progress.' : 'Run started.');
      await refresh();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Run now';
      const e = btn.parentElement?.querySelector('[data-dc-cerror]');
      if (e) { e.textContent = err.message; e.classList.remove('hidden'); }
    }
  }

  async function viewLeads(btn) {
    const id = Number(btn.getAttribute('data-dc-view'));
    const container = btn.closest('[data-campaign]')?.querySelector('[data-dc-leads]');
    if (!container) return;
    container.innerHTML = '<p class="text-xs text-gray-400 py-2">Loading leads…</p>';
    try {
      const { leads } = await call('list_leads', { campaignId: id });
      container.innerHTML = (leads && leads.length)
        ? `<ul class="divide-y divide-gray-100 mt-2 pt-2 border-t border-gray-100">${leads.map(leadRow).join('')}</ul>`
        : '<p class="text-xs text-gray-400 py-2">No leads discovered for this campaign yet.</p>';
    } catch (err) {
      container.innerHTML = `<p class="text-xs text-red-600 py-2">${esc(err.message)}</p>`;
    }
  }

  function cardErr(el, msg) {
    const e = el.closest('[data-campaign]')?.querySelector('[data-dc-cerror]');
    if (e) { e.textContent = msg; e.classList.remove('hidden'); }
  }

  async function cancelRun(btn) {
    const id = Number(btn.getAttribute('data-dc-cancel'));
    btn.disabled = true; btn.textContent = 'Cancelling…';
    try {
      const data = await call('cancel_run', { campaignId: id });
      window.showToast?.(data.cancelled ? 'Run cancelled.' : 'No active run to cancel.');
      await refresh();
    } catch (err) { btn.disabled = false; btn.textContent = 'Cancel run'; cardErr(btn, err.message); }
  }

  async function togglePause(btn) {
    const id = Number(btn.getAttribute('data-dc-toggle'));
    const paused = btn.getAttribute('data-paused') === '1';
    btn.disabled = true;
    try {
      await call(paused ? 'resume' : 'pause', { campaignId: id });
      window.showToast?.(paused ? 'Campaign resumed.' : 'Campaign paused.');
      await refresh();
    } catch (err) { btn.disabled = false; cardErr(btn, err.message); }
  }

  async function archiveCampaign(btn) {
    const id = Number(btn.getAttribute('data-dc-archive'));
    if (!window.confirm('Archive this campaign? It stops running and leaves this list. Leads already found stay in your Leads tab.')) return;
    btn.disabled = true;
    try {
      await call('archive', { campaignId: id });
      window.showToast?.('Campaign archived.');
      await refresh();
    } catch (err) { btn.disabled = false; cardErr(btn, err.message); }
  }

  // Edit an existing campaign's idea + guardrails, prefilled from the card's data-* snapshot.
  function openEditModal(cardEl, id) {
    if (!cardEl) return;
    const g = (a, d) => cardEl.getAttribute(a) ?? d;
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100">
          <h3 class="text-lg font-bold text-gray-900">Edit campaign</h3>
          <button type="button" data-edit-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer">&times;</button>
        </div>
        <div class="p-5 space-y-3">
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Who to find</label>
            <textarea data-edit-idea rows="3" class="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">${esc(g('data-dc-idea-val', ''))}</textarea>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Max leads / run</label>
              <input data-edit-maxleads type="number" min="1" value="${esc(g('data-dc-maxleads-val', '50'))}" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Max spend / run (£)</label>
              <input data-edit-budget type="number" min="0" step="0.5" value="${esc(g('data-dc-budget-val', '2'))}" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">
            </div>
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Exclude (comma-sep)</label>
            <input data-edit-negatives type="text" value="${esc(g('data-dc-negatives-val', ''))}" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm" placeholder="competitor.com, acme">
          </div>
          <label class="flex items-center gap-2 text-sm text-gray-700">
            <input data-edit-approval type="checkbox" ${g('data-dc-approval-val', '1') === '0' ? '' : 'checked'} class="rounded border-gray-300 text-emerald-700 focus:ring-emerald-700">
            Review found leads before any outreach (recommended)
          </label>
          <p class="hidden text-xs font-semibold text-red-600" data-edit-error></p>
          <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" data-edit-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 rounded-lg cursor-pointer">Cancel</button>
            <button type="button" data-edit-save class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Save changes</button>
          </div>
        </div>
      </div>`;
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-edit-close]').forEach((b) => b.addEventListener('click', close));
    const saveBtn = overlay.querySelector('[data-edit-save]');
    const errEl = overlay.querySelector('[data-edit-error]');
    saveBtn.addEventListener('click', async () => {
      const idea = overlay.querySelector('[data-edit-idea]').value.trim();
      if (!idea) { errEl.textContent = 'Describe who you want to find.'; errEl.classList.remove('hidden'); return; }
      errEl.classList.add('hidden');
      const negatives = (overlay.querySelector('[data-edit-negatives]').value || '').split(',').map((s) => s.trim()).filter(Boolean);
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        await call('edit', {
          campaignId: id,
          idea,
          guardrails: {
            maxLeadsPerRun: Number(overlay.querySelector('[data-edit-maxleads]').value) || undefined,
            maxCostGbpPerRun: Number(overlay.querySelector('[data-edit-budget]').value) || undefined,
            negativeKeywords: negatives,
            requireHumanApproval: !!overlay.querySelector('[data-edit-approval]').checked,
          },
        });
        window.showToast?.('Campaign updated.');
        close();
        await refresh();
      } catch (err) { saveBtn.disabled = false; saveBtn.textContent = 'Save changes'; errEl.textContent = err.message; errEl.classList.remove('hidden'); }
    });
    document.body.appendChild(overlay);
    overlay.querySelector('[data-edit-idea]')?.focus();
  }

  function wire() {
    const b = body();
    if (!b) return;
    b.querySelector('[data-dc-create]')?.addEventListener('click', (e) => create(e.currentTarget));
    b.querySelectorAll('[data-dc-run]').forEach((el) => el.addEventListener('click', () => runNow(el)));
    b.querySelectorAll('[data-dc-view]').forEach((el) => el.addEventListener('click', () => viewLeads(el)));
    b.querySelectorAll('[data-dc-cancel]').forEach((el) => el.addEventListener('click', () => cancelRun(el)));
    b.querySelectorAll('[data-dc-toggle]').forEach((el) => el.addEventListener('click', () => togglePause(el)));
    b.querySelectorAll('[data-dc-archive]').forEach((el) => el.addEventListener('click', () => archiveCampaign(el)));
    b.querySelectorAll('[data-dc-edit]').forEach((el) => el.addEventListener('click', () => openEditModal(el.closest('[data-campaign]'), Number(el.getAttribute('data-dc-edit')))));
  }

  function open() {
    if (!state.assistantId) return;
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100 shrink-0">
          <div>
            <h3 class="text-lg font-bold text-gray-900">${esc(state.cfg?.title || 'Find New Leads')}</h3>
            <p class="text-sm text-gray-500 mt-0.5">Describe who you want to reach — the Lead Generator searches the web, scores what it finds, and files leads for your approval.</p>
          </div>
          <button type="button" data-dc-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer">&times;</button>
        </div>
        <div class="p-5 overflow-y-auto" data-dc-body></div>
      </div>`;
    const close = () => {
      overlay.remove();
      state.overlay = null;
      if (window._leadIdeasDidAddLeads) {
        window._leadIdeasDidAddLeads = false;
        window.AssistantDataHub?.init?.({
          hub: window.AssistantDashboardRegistry?.get('lead_qualifier')?.hubTab,
          assistantId: state.assistantId,
        });
      }
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-dc-close]').addEventListener('click', close);
    document.body.appendChild(overlay);
    state.overlay = overlay;
    refresh();
  }

  function init({ assistantId, cfg }) {
    if (!assistantId) return;
    state.assistantId = assistantId;
    state.cfg = cfg || null;
    const btn = document.getElementById('btn-discovery-campaigns');
    if (btn && !btn.dataset.dcWired) {
      btn.dataset.dcWired = '1';
      btn.addEventListener('click', open);
    }
  }

  window.AssistantDiscoveryCampaigns = { init, open };
})();
