/**
 * src/components/disruptive-ui-registry.js
 *
 * "Disruptive UI" registry — the factory that turns chatMessages.uiElementJson payloads
 * (emitted by netlify/functions/chat-orchestrator.ts route parsers) into interactive
 * cards mounted inline with the chat transcript.
 *
 * Usage:
 *   window.DisruptiveUIRegistry.register(type, (uiElement) => HTMLElement)
 *     → Add a renderer for a uiElement.type. Later registrations win, so pages can
 *       override the built-in stubs.
 *
 *   window.DisruptiveUIRegistry.render(uiElement)
 *     → Returns the mounted HTMLElement for a known type, or null for unknown/absent
 *       types (the chat falls back to text-only — an unrecognised card must never
 *       break a transcript). Renderer exceptions are caught and also return null.
 *
 * Every value inside uiElement originates from an LLM response: treat it as untrusted.
 * Renderers must escape all interpolated strings (use the escapeHtml passed as the
 * second argument) — never innerHTML raw payload values.
 */
(function () {
  'use strict';

  const renderers = new Map();

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function register(type, renderFn) {
    if (typeof type !== 'string' || !type || typeof renderFn !== 'function') return;
    renderers.set(type, renderFn);
  }

  function has(type) {
    return renderers.has(type);
  }

  function render(uiElement) {
    if (!uiElement || typeof uiElement !== 'object' || typeof uiElement.type !== 'string') return null;
    const renderFn = renderers.get(uiElement.type);
    if (!renderFn) return null;
    try {
      const el = renderFn(uiElement, escapeHtml);
      return el instanceof HTMLElement ? el : null;
    } catch (err) {
      console.error(`[DisruptiveUIRegistry] renderer for "${uiElement.type}" threw:`, err);
      return null;
    }
  }

  // ── Built-in: Lead Scoring Card ─────────────────────────────────────────────
  // Stub renderer for the lead-qualifier route's wire shape (chat-orchestrator.ts):
  // { type: 'lead_scoring_card', leadName, score: 0-100, rating: 'hot'|'warm'|'cold',
  //   reasons: [...], suggestedNextStep }
  const RATING_STYLES = {
    hot: { chip: 'bg-emerald-50 text-emerald-800 border-emerald-200', bar: 'bg-emerald-700', label: 'Hot lead' },
    warm: { chip: 'bg-amber-50 text-amber-800 border-amber-200', bar: 'bg-amber-500', label: 'Warm lead' },
    cold: { chip: 'bg-gray-50 text-gray-500 border-gray-200', bar: 'bg-gray-400', label: 'Cold lead' },
  };

  function renderLeadScoringCard(ui, esc) {
    const score = Math.max(0, Math.min(100, Number(ui.score) || 0));
    const rating = RATING_STYLES[ui.rating] || RATING_STYLES.cold;
    const reasons = Array.isArray(ui.reasons) ? ui.reasons.filter((r) => typeof r === 'string') : [];

    const el = document.createElement('div');
    el.className = 'bg-white border border-gray-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 bg-emerald-100 rounded-lg flex items-center justify-center text-xl shrink-0">🎯</div>
          <div class="min-w-0">
            <p class="text-xs font-bold text-emerald-700 tracking-wider uppercase">Lead Score</p>
            <p class="font-bold text-gray-900 truncate">${esc(ui.leadName) || 'Unnamed lead'}</p>
          </div>
        </div>
        <span class="text-xs font-bold px-2 py-0.5 rounded-full border shrink-0 ${rating.chip}">${rating.label}</span>
      </div>

      <div class="flex items-center gap-3 mb-4">
        <div class="bg-gray-100 h-2 rounded-full grow overflow-hidden">
          <div class="${rating.bar} h-2 rounded-full transition-all duration-500" style="width: ${score}%;"></div>
        </div>
        <span class="text-sm font-extrabold text-gray-900 shrink-0">${score}<span class="text-xs font-semibold text-gray-500">/100</span></span>
      </div>

      ${reasons.length ? `
        <ul class="space-y-1.5 mb-4">
          ${reasons.map((r) => `
            <li class="flex items-start gap-2 text-sm text-gray-700">
              <svg class="w-4 h-4 text-emerald-700 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
              <span>${esc(r)}</span>
            </li>`).join('')}
        </ul>` : ''}

      ${ui.suggestedNextStep ? `
        <div class="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-900">
          <span class="font-bold">Suggested next step:</span> ${esc(ui.suggestedNextStep)}
        </div>` : ''}
    `;
    return el;
  }

  register('lead_scoring_card', renderLeadScoringCard);
  // Alias for callers/routes that use the PascalCase component name as the type key.
  register('LeadScoringCard', renderLeadScoringCard);

  // ── Built-in: Aging Invoices Table Card ─────────────────────────────────────
  // Renderer for the accounts-receivable-clerk route's wire shape (chat-orchestrator.ts):
  // { type: 'aging_invoices_table', title?, invoices: [{ clientName, daysPastDue,
  //   amount, status: 'reminder'|'overdue'|'final_notice'|'escalated' }, ...] }
  // The "Pause chasing" toggle is a client-side mock for now — it dims the row but
  // does not persist anywhere yet.
  const INVOICE_STATUS_STYLES = {
    reminder: { chip: 'bg-emerald-50 text-emerald-800 border-emerald-200', label: 'Reminder' },
    overdue: { chip: 'bg-amber-50 text-amber-800 border-amber-200', label: 'Overdue' },
    final_notice: { chip: 'bg-orange-50 text-orange-800 border-orange-200', label: 'Final notice' },
    escalated: { chip: 'bg-red-50 text-red-700 border-red-200', label: 'Escalated' },
  };

  function renderAgingInvoicesTableCard(ui, esc) {
    const invoices = (Array.isArray(ui.invoices) ? ui.invoices : [])
      .filter((inv) => inv && typeof inv === 'object');
    if (invoices.length === 0) return null; // nothing to tabulate — fall back to text-only

    const el = document.createElement('div');
    el.className = 'bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden max-w-2xl';
    el.innerHTML = `
      <div class="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
        <div class="w-10 h-10 bg-emerald-100 rounded-lg flex items-center justify-center text-xl shrink-0">💷</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-emerald-700 tracking-wider uppercase">Aged Receivables</p>
          <p class="font-bold text-gray-900 truncate">${esc(ui.title) || 'Overdue invoices'}</p>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs font-bold text-gray-500 uppercase tracking-wider border-b border-gray-100">
              <th class="px-5 py-3">Client</th>
              <th class="px-3 py-3 text-right">Days overdue</th>
              <th class="px-3 py-3 text-right">Amount</th>
              <th class="px-3 py-3">Status</th>
              <th class="px-5 py-3 text-right">Chasing</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${invoices.map((inv) => {
              const status = INVOICE_STATUS_STYLES[inv.status] || INVOICE_STATUS_STYLES.overdue;
              const days = Number(inv.daysPastDue);
              return `
              <tr data-invoice-row>
                <td class="px-5 py-3 font-semibold text-gray-900">${esc(inv.clientName) || 'Unknown client'}</td>
                <td class="px-3 py-3 text-right font-semibold ${days >= 60 ? 'text-red-600' : days >= 30 ? 'text-orange-600' : 'text-gray-700'}">${Number.isFinite(days) ? days : '—'}</td>
                <td class="px-3 py-3 text-right font-extrabold text-gray-900">${esc(inv.amount)}</td>
                <td class="px-3 py-3"><span class="text-xs font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${status.chip}">${status.label}</span></td>
                <td class="px-5 py-3 text-right">
                  <label class="relative inline-flex items-center cursor-pointer align-middle" title="Pause chasing">
                    <input type="checkbox" class="sr-only peer" data-pause-chasing checked>
                    <span class="w-9 h-5 bg-gray-200 rounded-full peer-checked:bg-emerald-700 peer-focus:ring-2 peer-focus:ring-emerald-700 transition
                      after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:bg-white after:rounded-full after:shadow after:transition-all peer-checked:after:translate-x-4"></span>
                  </label>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <p class="px-5 py-3 text-xs text-gray-400 border-t border-gray-100">Toggle off to pause chasing a client. (Preview — pausing is not saved yet.)</p>
    `;

    // Mock behaviour: unticking "chasing" dims the row so the pause reads visually.
    el.addEventListener('change', (e) => {
      const toggle = e.target.closest('[data-pause-chasing]');
      if (!toggle) return;
      const row = toggle.closest('[data-invoice-row]');
      if (row) row.classList.toggle('opacity-40', !toggle.checked);
    });

    return el;
  }

  register('aging_invoices_table', renderAgingInvoicesTableCard);
  // Alias for callers/routes that use the PascalCase component name as the type key.
  register('AgingInvoicesTableCard', renderAgingInvoicesTableCard);

  // ── Built-in: Data Diff View Card ───────────────────────────────────────────
  // Renderer for the crm-enricher route's wire shape (chat-orchestrator.ts):
  // { type: 'data_diff_view', recordName?, fields: [{ fieldName, oldValue: string|null,
  //   newValue }, ...] }
  // Side-by-side current → proposed comparison; the proposed value is highlighted in
  // emerald when it differs from the current value (or the current value is blank).
  function renderDataDiffViewCard(ui, esc) {
    const fields = (Array.isArray(ui.fields) ? ui.fields : [])
      .filter((f) => f && typeof f === 'object' && f.fieldName);
    if (fields.length === 0) return null; // nothing to compare — fall back to text-only

    const el = document.createElement('div');
    el.className = 'bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden max-w-2xl';
    el.innerHTML = `
      <div class="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
        <div class="w-10 h-10 bg-emerald-100 rounded-lg flex items-center justify-center text-xl shrink-0">🔎</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-emerald-700 tracking-wider uppercase">CRM Enrichment</p>
          <p class="font-bold text-gray-900 truncate">${esc(ui.recordName) || 'Proposed changes'}</p>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs font-bold text-gray-500 uppercase tracking-wider border-b border-gray-100">
              <th class="px-5 py-3">Field</th>
              <th class="px-3 py-3">Current</th>
              <th class="px-5 py-3">Proposed</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${fields.map((f) => {
              const hasOld = f.oldValue !== null && f.oldValue !== undefined && String(f.oldValue).trim() !== '';
              const changed = !hasOld || String(f.oldValue) !== String(f.newValue);
              return `
              <tr>
                <td class="px-5 py-3 font-semibold text-gray-900 whitespace-nowrap">${esc(f.fieldName)}</td>
                <td class="px-3 py-3 ${hasOld ? 'text-gray-700' : 'text-gray-400 italic'}">${hasOld ? esc(f.oldValue) : 'Empty'}</td>
                <td class="px-5 py-3 font-bold ${changed ? 'text-emerald-600' : 'text-gray-700'}">${esc(f.newValue)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <p class="px-5 py-3 text-xs text-gray-400 border-t border-gray-100">Simulated enrichment preview — values are not written to your CRM yet.</p>
    `;
    return el;
  }

  register('data_diff_view', renderDataDiffViewCard);
  // Alias for callers/routes that use the PascalCase component name as the type key.
  register('DataDiffViewCard', renderDataDiffViewCard);

  // ── Built-in: Ticket Triage View Card ───────────────────────────────────────
  // Renderer for the tier1-support-agent route's wire shape (chat-orchestrator.ts):
  // { type: 'ticket_triage_view', status: 'Resolved'|'Escalated', confidenceScore: 0-100,
  //   summary, escalationReason: string|null, escalationEmail?: string|null }
  // Escalated tickets get an amber/red warning treatment naming the escalation inbox;
  // resolved tickets get an emerald treatment.
  function renderTicketTriageViewCard(ui, esc) {
    const escalated = String(ui.status).toLowerCase() === 'escalated';
    const confidence = Math.max(0, Math.min(100, Number(ui.confidenceScore) || 0));

    const el = document.createElement('div');
    el.className = `bg-white border-2 rounded-xl shadow-sm p-5 max-w-md ${escalated ? 'border-red-300' : 'border-emerald-300'}`;
    el.innerHTML = `
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 ${escalated ? 'bg-amber-100' : 'bg-emerald-100'} rounded-lg flex items-center justify-center text-xl shrink-0">${escalated ? '🚨' : '✅'}</div>
          <div class="min-w-0">
            <p class="text-xs font-bold ${escalated ? 'text-red-700' : 'text-emerald-700'} tracking-wider uppercase">Ticket Triage</p>
            <p class="font-bold text-gray-900">${escalated ? 'Escalated' : 'Resolved'}</p>
          </div>
        </div>
        <span class="text-xs font-bold px-2 py-0.5 rounded-full border shrink-0 ${escalated ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'}">${confidence}% confident</span>
      </div>

      <div class="flex items-center gap-3 mb-4">
        <div class="bg-gray-100 h-2 rounded-full grow overflow-hidden">
          <div class="${escalated ? 'bg-amber-500' : 'bg-emerald-700'} h-2 rounded-full transition-all duration-500" style="width: ${confidence}%;"></div>
        </div>
      </div>

      ${ui.summary ? `
        <p class="text-sm text-gray-700 mb-4"><span class="font-bold text-gray-900">Issue:</span> ${esc(ui.summary)}</p>` : ''}

      ${escalated ? `
        <div class="bg-amber-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
          <p class="font-bold mb-0.5">Escalated to ${esc(ui.escalationEmail) || 'your escalation contact'}</p>
          ${ui.escalationReason ? `<p>${esc(ui.escalationReason)}</p>` : ''}
        </div>` : `
        <div class="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-900">
          <span class="font-bold">Handled automatically</span> — no human follow-up needed.
        </div>`}
    `;
    return el;
  }

  register('ticket_triage_view', renderTicketTriageViewCard);
  // Alias for callers/routes that use the PascalCase component name as the type key.
  register('TicketTriageViewCard', renderTicketTriageViewCard);

  // ── Built-in: Handoff Proposal Card ─────────────────────────────────────────
  // Renderer for the cross-assistant HITL handoff wire shape (chat-orchestrator.ts):
  // { type: 'handoff_proposal', targetAssistantName, targetRoleKey, reason,
  //   payloadToPass: object }
  // Indigo/purple treatment: this is a SYSTEM ROUTING action awaiting human approval,
  // not a final deliverable — it must read visually distinct from the emerald cards.
  // Clicking Approve/Decline dispatches a bubbling 'handoff:response' CustomEvent that
  // chat-session.js turns into an orchestrator submission (Approve carries the
  // payloadToPass + approved-handoff flag; Decline sends a plain decline message).
  function renderHandoffProposalCard(ui, esc) {
    const targetName = typeof ui.targetAssistantName === 'string' && ui.targetAssistantName.trim()
      ? ui.targetAssistantName.trim() : 'another assistant';
    const payload = (ui.payloadToPass && typeof ui.payloadToPass === 'object') ? ui.payloadToPass : {};

    let payloadPreview = '';
    try { payloadPreview = JSON.stringify(payload, null, 2); } catch { payloadPreview = '{}'; }

    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <div class="flex items-start gap-3 mb-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-xl shrink-0">🔀</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">System Routing · Approval needed</p>
          <p class="font-bold text-gray-900 truncate">Hand off to ${esc(targetName)}</p>
        </div>
      </div>

      ${ui.reason ? `
        <p class="text-sm text-gray-700 mb-3"><span class="font-bold text-indigo-900">Why:</span> ${esc(ui.reason)}</p>` : ''}

      <details class="mb-4 group">
        <summary class="text-xs font-bold text-indigo-700 cursor-pointer select-none hover:text-indigo-900">Data that will be passed</summary>
        <pre class="mt-2 bg-white border border-indigo-100 rounded-lg p-3 text-xs text-gray-600 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words">${esc(payloadPreview)}</pre>
      </details>

      <div class="flex items-center gap-2" data-handoff-actions>
        <button type="button" data-handoff-approve
          class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Approve Handoff
        </button>
        <button type="button" data-handoff-decline
          class="px-4 py-2 bg-white border border-indigo-200 text-indigo-700 hover:bg-indigo-50 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Decline
        </button>
      </div>
      <p class="hidden mt-1 text-xs font-semibold text-indigo-700" data-handoff-status></p>
    `;

    function settle(statusText) {
      el.querySelectorAll('[data-handoff-approve], [data-handoff-decline]').forEach((b) => { b.disabled = true; });
      const status = el.querySelector('[data-handoff-status]');
      status.textContent = statusText;
      status.classList.remove('hidden');
    }

    el.addEventListener('click', (e) => {
      const approve = e.target.closest('[data-handoff-approve]');
      const decline = e.target.closest('[data-handoff-decline]');
      if (!approve && !decline) return;
      const approved = Boolean(approve);
      settle(approved ? `Handoff approved — ${targetName} is working in the background…` : 'Handoff declined.');
      el.dispatchEvent(new CustomEvent('handoff:response', {
        bubbles: true,
        detail: {
          approved,
          targetAssistantName: targetName,
          targetRoleKey: typeof ui.targetRoleKey === 'string' ? ui.targetRoleKey : null,
          reason: typeof ui.reason === 'string' ? ui.reason : null,
          payloadToPass: payload,
        },
      }));
    });

    return el;
  }

  register('handoff_proposal', renderHandoffProposalCard);
  // Alias for callers/routes that use the PascalCase component name as the type key.
  register('HandoffProposalCard', renderHandoffProposalCard);

  window.DisruptiveUIRegistry = { register, has, render, escapeHtml };
})();
