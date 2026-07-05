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

  window.DisruptiveUIRegistry = { register, has, render, escapeHtml };
})();
