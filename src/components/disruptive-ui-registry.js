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
  // Renderer for the lead-qualifier route's wire shape (chat-orchestrator.ts):
  // { type: 'lead_scoring_card', leadName, score: 0-100, rating: 'hot'|'warm'|'cold',
  //   reasons: [...], suggestedNextStep,
  //   outreachDraft?: { to: string|null, subject, body } | null }
  // When the LLM includes an outreachDraft, "Draft Outreach in Gmail" pushes it into
  // the user's Gmail Drafts via /api/actions/sync (gmail_create_draft) so they can
  // review and send it themselves.
  const RATING_STYLES = {
    hot: { chip: 'bg-emerald-50 text-emerald-800 border-emerald-200', bar: 'bg-emerald-700', label: 'Hot lead' },
    warm: { chip: 'bg-amber-50 text-amber-800 border-amber-200', bar: 'bg-amber-500', label: 'Warm lead' },
    cold: { chip: 'bg-gray-50 text-gray-500 border-gray-200', bar: 'bg-gray-400', label: 'Cold lead' },
  };

  function renderLeadScoringCard(ui, esc) {
    const score = Math.max(0, Math.min(100, Number(ui.score) || 0));
    const rating = RATING_STYLES[ui.rating] || RATING_STYLES.cold;
    const reasons = Array.isArray(ui.reasons) ? ui.reasons.filter((r) => typeof r === 'string') : [];

    // Outreach draft: only render the Gmail action when the LLM produced an email body.
    const draft = (ui.outreachDraft && typeof ui.outreachDraft === 'object'
      && typeof ui.outreachDraft.body === 'string' && ui.outreachDraft.body.trim())
      ? ui.outreachDraft : null;

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

      ${draft ? `
      <div class="flex items-center justify-between gap-3 mt-4 pt-3 border-t border-gray-100">
        <p class="text-xs text-gray-400" data-gmail-status>Saves the outreach email to your Gmail Drafts for review before sending.</p>
        <button type="button" data-draft-gmail
          class="px-4 py-2 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed shrink-0 whitespace-nowrap">
          Draft Outreach in Gmail
        </button>
      </div>` : ''}
    `;

    // Live behaviour: push the LLM-drafted outreach email into Gmail Drafts.
    if (draft) {
      const gmailStatusLine = el.querySelector('[data-gmail-status]');
      el.addEventListener('click', async (e) => {
        const button = e.target.closest('[data-draft-gmail]');
        if (!button || button.disabled) return;

        button.disabled = true;
        button.textContent = 'Drafting…';
        gmailStatusLine.className = 'text-xs text-gray-400';
        try {
          const data = await postSyncAction('gmail_create_draft', {
            to: typeof draft.to === 'string' ? draft.to : null,
            subject: draft.subject ?? '',
            body: draft.body,
          });
          button.textContent = 'Drafted ✓';
          button.className = 'px-4 py-2 bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-bold rounded-lg cursor-default shrink-0 whitespace-nowrap';
          gmailStatusLine.textContent = data.message || 'Draft created in Gmail.';
          gmailStatusLine.className = 'text-xs font-semibold text-emerald-700';
        } catch (err) {
          button.disabled = false;
          button.textContent = 'Retry draft';
          button.className = 'px-4 py-2 bg-red-50 border border-red-200 text-red-700 hover:border-red-300 text-sm font-bold rounded-lg transition shrink-0 whitespace-nowrap';
          gmailStatusLine.textContent = err.message || 'Could not create the Gmail draft.';
          gmailStatusLine.className = 'text-xs font-semibold text-red-600';
        }
      });
    }

    return el;
  }

  register('lead_scoring_card', renderLeadScoringCard);
  // Alias for callers/routes that use the PascalCase component name as the type key.
  register('LeadScoringCard', renderLeadScoringCard);

  // ── Shared: POST an action payload to the generic sync endpoint ─────────────
  // /api/actions/sync (netlify/functions/sync-action.ts) resolves the workspace's
  // OAuth token for the target provider and executes the third-party call.
  // Throws Error(message) on any non-2xx / {error} response so callers can render
  // their local error state.
  async function postSyncAction(actionType, payload) {
    const res = await fetch('/api/actions/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionType, payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Sync failed (HTTP ${res.status}).`);
    return data;
  }

  // ── Built-in: Aging Invoices Table Card ─────────────────────────────────────
  // Renderer for the accounts-receivable-clerk route's wire shape (chat-orchestrator.ts):
  // { type: 'aging_invoices_table', title?, accountingProvider?, invoices: [{ clientName,
  //   daysPastDue, amount, status: 'reminder'|'overdue'|'final_notice'|'escalated',
  //   invoiceNumber?: string|null }, ...] }
  // accountingProvider echoes the onboarding accountingPlatform: 'quickbooks' routes the
  // "Log note" button to qbo_log_note (invoice private-memo update), anything else
  // defaults to Xero (xero_log_note, invoice history note) — both via /api/actions/sync.
  // The "Pause chasing" toggle is still a client-side mock — it dims the row but does
  // not persist anywhere yet.
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

    const isQuickBooks = /^(quickbooks|qbo)$/.test(String(ui.accountingProvider || '').trim().toLowerCase());
    const acctLabel = isQuickBooks ? 'QuickBooks' : 'Xero';
    const acctAction = isQuickBooks ? 'qbo_log_note' : 'xero_log_note';

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
              <th class="px-3 py-3 text-right">Chasing</th>
              <th class="px-5 py-3 text-right">${acctLabel}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${invoices.map((inv, i) => {
              const status = INVOICE_STATUS_STYLES[inv.status] || INVOICE_STATUS_STYLES.overdue;
              const days = Number(inv.daysPastDue);
              return `
              <tr data-invoice-row>
                <td class="px-5 py-3 font-semibold text-gray-900">${esc(inv.clientName) || 'Unknown client'}</td>
                <td class="px-3 py-3 text-right font-semibold ${days >= 60 ? 'text-red-600' : days >= 30 ? 'text-orange-600' : 'text-gray-700'}">${Number.isFinite(days) ? days : '—'}</td>
                <td class="px-3 py-3 text-right font-extrabold text-gray-900">${esc(inv.amount)}</td>
                <td class="px-3 py-3"><span class="text-xs font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${status.chip}">${status.label}</span></td>
                <td class="px-3 py-3 text-right">
                  <label class="relative inline-flex items-center cursor-pointer align-middle" title="Pause chasing">
                    <input type="checkbox" class="sr-only peer" data-pause-chasing checked>
                    <span class="w-9 h-5 bg-gray-200 rounded-full peer-checked:bg-emerald-700 peer-focus:ring-2 peer-focus:ring-emerald-700 transition
                      after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:bg-white after:rounded-full after:shadow after:transition-all peer-checked:after:translate-x-4"></span>
                  </label>
                </td>
                <td class="px-5 py-3 text-right">
                  <button type="button" data-log-note="${i}"
                    class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed">
                    Log note
                  </button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <p class="px-5 py-3 text-xs text-gray-400 border-t border-gray-100" data-table-status>Toggle off to pause chasing a client (visual only). "Log note" writes a chasing note against the invoice in ${acctLabel}.</p>
    `;

    // Mock behaviour: unticking "chasing" dims the row so the pause reads visually.
    el.addEventListener('change', (e) => {
      const toggle = e.target.closest('[data-pause-chasing]');
      if (!toggle) return;
      const row = toggle.closest('[data-invoice-row]');
      if (row) row.classList.toggle('opacity-40', !toggle.checked);
    });

    // Live behaviour: "Log note" pushes a chasing note onto the invoice in the
    // configured accounting platform.
    const statusLine = el.querySelector('[data-table-status]');
    el.addEventListener('click', async (e) => {
      const button = e.target.closest('[data-log-note]');
      if (!button || button.disabled) return;
      const inv = invoices[Number(button.getAttribute('data-log-note'))];
      if (!inv) return;

      button.disabled = true;
      button.textContent = 'Logging…';
      statusLine.className = 'px-5 py-3 text-xs text-gray-400 border-t border-gray-100';
      try {
        const data = await postSyncAction(acctAction, {
          title: ui.title ?? null,
          clientName: inv.clientName ?? null,
          invoiceNumber: inv.invoiceNumber ?? null,
          invoiceId: inv.invoiceId ?? null,
          daysPastDue: inv.daysPastDue ?? null,
          amount: inv.amount ?? null,
          status: inv.status ?? null,
        });
        button.textContent = 'Logged ✓';
        button.className = 'px-3 py-1.5 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold rounded-lg cursor-default whitespace-nowrap';
        statusLine.textContent = data.message || `Note logged in ${acctLabel}.`;
        statusLine.className = 'px-5 py-3 text-xs font-semibold text-emerald-700 border-t border-gray-100';
      } catch (err) {
        button.disabled = false;
        button.textContent = 'Retry note';
        button.className = 'px-3 py-1.5 bg-red-50 border border-red-200 text-red-700 hover:border-red-300 text-xs font-bold rounded-lg transition whitespace-nowrap';
        statusLine.textContent = err.message || `Could not log the note in ${acctLabel}.`;
        statusLine.className = 'px-5 py-3 text-xs font-semibold text-red-600 border-t border-gray-100';
      }
    });

    return el;
  }

  register('aging_invoices_table', renderAgingInvoicesTableCard);
  // Alias for callers/routes that use the PascalCase component name as the type key.
  register('AgingInvoicesTableCard', renderAgingInvoicesTableCard);

  // ── Built-in: Data Diff View Card ───────────────────────────────────────────
  // Renderer for the crm-enricher route's wire shape (chat-orchestrator.ts):
  // { type: 'data_diff_view', recordName?, recordEmail?, objectType?, crmProvider?,
  //   fields: [{ fieldName, oldValue: string|null, newValue, propertyName? }, ...] }
  // Side-by-side current → proposed comparison; the proposed value is highlighted in
  // emerald when it differs from the current value (or the current value is blank).
  // crmProvider echoes the user's onboarding primaryCrm: 'salesforce' routes the apply
  // button to salesforce_update_record, anything else defaults to HubSpot
  // (hubspot_update_record). Both PATCH the proposed values onto the matching
  // contact/company record via /api/actions/sync.
  function renderDataDiffViewCard(ui, esc) {
    const fields = (Array.isArray(ui.fields) ? ui.fields : [])
      .filter((f) => f && typeof f === 'object' && f.fieldName);
    if (fields.length === 0) return null; // nothing to compare — fall back to text-only

    const isSalesforce = String(ui.crmProvider || '').trim().toLowerCase() === 'salesforce';
    const crmLabel = isSalesforce ? 'Salesforce' : 'HubSpot';
    const crmAction = isSalesforce ? 'salesforce_update_record' : 'hubspot_update_record';

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
      <div class="flex items-center justify-between gap-3 px-5 py-3 border-t border-gray-100">
        <p class="text-xs text-gray-400" data-diff-status>Review the proposed values, then apply them to the record in ${crmLabel}.</p>
        <button type="button" data-apply-diff
          class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed shrink-0 whitespace-nowrap">
          Apply in ${crmLabel}
        </button>
      </div>
    `;

    // Live behaviour: PATCH the proposed values onto the CRM record.
    const statusLine = el.querySelector('[data-diff-status]');
    el.addEventListener('click', async (e) => {
      const button = e.target.closest('[data-apply-diff]');
      if (!button || button.disabled) return;

      button.disabled = true;
      button.textContent = 'Applying…';
      statusLine.className = 'text-xs text-gray-400';
      try {
        const data = await postSyncAction(crmAction, {
          recordName: ui.recordName ?? null,
          recordEmail: ui.recordEmail ?? null,
          objectType: ui.objectType ?? null,
          fields: fields.map((f) => ({
            fieldName: f.fieldName,
            newValue: f.newValue ?? '',
            propertyName: f.propertyName ?? null,
          })),
        });
        button.textContent = 'Applied ✓';
        button.className = 'px-4 py-2 bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-bold rounded-lg cursor-default shrink-0 whitespace-nowrap';
        statusLine.textContent = data.message || `Record updated in ${crmLabel}.`;
        statusLine.className = 'text-xs font-semibold text-emerald-700';
      } catch (err) {
        button.disabled = false;
        button.textContent = 'Retry';
        button.className = 'px-4 py-2 bg-red-50 border border-red-200 text-red-700 hover:border-red-300 text-sm font-bold rounded-lg transition shrink-0 whitespace-nowrap';
        statusLine.textContent = err.message || `Could not update the record in ${crmLabel}.`;
        statusLine.className = 'text-xs font-semibold text-red-600';
      }
    });

    return el;
  }

  register('data_diff_view', renderDataDiffViewCard);
  // Alias for callers/routes that use the PascalCase component name as the type key.
  register('DataDiffViewCard', renderDataDiffViewCard);

  // ── Built-in: Ticket Triage View Card ───────────────────────────────────────
  // Renderer for the tier1-support-agent route's wire shape (chat-orchestrator.ts):
  // { type: 'ticket_triage_view', status: 'Resolved'|'Escalated', helpdeskProvider?,
  //   ticketId?: string|null, confidenceScore: 0-100, summary,
  //   escalationReason: string|null, escalationEmail?: string|null }
  // Escalated tickets get an amber/red warning treatment naming the escalation inbox;
  // resolved tickets get an emerald treatment. helpdeskProvider echoes the onboarding
  // helpdeskPlatform: 'intercom' routes the log button to intercom_add_internal_note
  // (admin note on the conversation), anything else defaults to Zendesk
  // (zendesk_add_internal_note, private ticket comment) — both via /api/actions/sync
  // and never requester-visible.
  function renderTicketTriageViewCard(ui, esc) {
    const escalated = String(ui.status).toLowerCase() === 'escalated';
    const confidence = Math.max(0, Math.min(100, Number(ui.confidenceScore) || 0));

    const isIntercom = String(ui.helpdeskProvider || '').trim().toLowerCase() === 'intercom';
    const deskLabel = isIntercom ? 'Intercom' : 'Zendesk';
    const deskAction = isIntercom ? 'intercom_add_internal_note' : 'zendesk_add_internal_note';

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

      <div class="flex items-center justify-between gap-3 mt-4 pt-3 border-t border-gray-100">
        <p class="text-xs text-gray-400" data-helpdesk-status>Logs this triage summary as an internal note on the ${isIntercom ? 'conversation' : 'ticket'}.</p>
        <button type="button" data-log-helpdesk
          class="px-4 py-2 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed shrink-0 whitespace-nowrap">
          Log to ${deskLabel}
        </button>
      </div>
    `;

    // Live behaviour: push the triage summary as an internal note in the configured
    // helpdesk (private Zendesk ticket comment / Intercom admin note).
    const helpdeskStatusLine = el.querySelector('[data-helpdesk-status]');
    el.addEventListener('click', async (e) => {
      const button = e.target.closest('[data-log-helpdesk]');
      if (!button || button.disabled) return;

      button.disabled = true;
      button.textContent = 'Logging…';
      helpdeskStatusLine.className = 'text-xs text-gray-400';
      try {
        const data = await postSyncAction(deskAction, {
          ticketId: ui.ticketId ?? null,
          conversationId: ui.ticketId ?? null,
          summary: ui.summary ?? null,
          status: ui.status ?? null,
          confidenceScore: ui.confidenceScore ?? null,
          escalationReason: ui.escalationReason ?? null,
        });
        button.textContent = 'Logged ✓';
        button.className = 'px-4 py-2 bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-bold rounded-lg cursor-default shrink-0 whitespace-nowrap';
        helpdeskStatusLine.textContent = data.message || `Internal note added in ${deskLabel}.`;
        helpdeskStatusLine.className = 'text-xs font-semibold text-emerald-700';
      } catch (err) {
        button.disabled = false;
        button.textContent = `Retry ${deskLabel}`;
        button.className = 'px-4 py-2 bg-red-50 border border-red-200 text-red-700 hover:border-red-300 text-sm font-bold rounded-lg transition shrink-0 whitespace-nowrap';
        helpdeskStatusLine.textContent = err.message || `Could not add the note in ${deskLabel}.`;
        helpdeskStatusLine.className = 'text-xs font-semibold text-red-600';
      }
    });

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

  // ── Built-in: Action Item Assignment Card ───────────────────────────────────
  // Renderer for the meeting-note-taker route's wire shape (chat-orchestrator.ts):
  // { type: 'action_item_assignment', meetingSummary, targetDestination,
  //   channel?, tasks: [{ description, assignee, dueDate: string|null }, ...] }
  // targetDestination echoes the onboarding taskDestination label and picks the sync
  // route: 'Notion' creates a page (summary paragraph + to_do blocks) via
  // /api/actions/sync (notion_create_page); anything else posts the summary + tasks
  // to Slack as Block Kit (slack_post_summary), where an optional ui.channel ('#name'
  // or channel id) picks the channel, defaulting to #general.
  function renderActionItemAssignmentCard(ui, esc) {
    const tasks = (Array.isArray(ui.tasks) ? ui.tasks : [])
      .filter((t) => t && typeof t === 'object' && t.description);
    if (!ui.meetingSummary && tasks.length === 0) return null; // nothing extracted — fall back to text-only

    const destination = typeof ui.targetDestination === 'string' && ui.targetDestination.trim()
      ? ui.targetDestination.trim() : 'your task tracker';
    const isNotion = destination.toLowerCase() === 'notion';
    const syncActionType = isNotion ? 'notion_create_page' : 'slack_post_summary';

    const el = document.createElement('div');
    el.className = 'bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden max-w-2xl';
    el.innerHTML = `
      <div class="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
        <div class="w-10 h-10 bg-emerald-100 rounded-lg flex items-center justify-center text-xl shrink-0">📝</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-emerald-700 tracking-wider uppercase">Meeting Minutes</p>
          <p class="font-bold text-gray-900 truncate">Summary &amp; action items</p>
        </div>
      </div>

      ${ui.meetingSummary ? `
        <div class="px-5 py-4 ${tasks.length ? 'border-b border-gray-100' : ''}">
          <p class="text-sm text-gray-700 whitespace-pre-line">${esc(ui.meetingSummary)}</p>
        </div>` : ''}

      ${tasks.length ? `
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs font-bold text-gray-500 uppercase tracking-wider border-b border-gray-100">
              <th class="px-5 py-3">Action item</th>
              <th class="px-3 py-3">Owner</th>
              <th class="px-5 py-3">Due</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${tasks.map((t) => {
              const hasDue = t.dueDate !== null && t.dueDate !== undefined && String(t.dueDate).trim() !== '';
              return `
              <tr>
                <td class="px-5 py-3 text-gray-900">${esc(t.description)}</td>
                <td class="px-3 py-3 font-semibold text-gray-700 whitespace-nowrap">${esc(t.assignee) || 'Unassigned'}</td>
                <td class="px-5 py-3 whitespace-nowrap ${hasDue ? 'text-gray-700' : 'text-gray-400 italic'}">${hasDue ? esc(t.dueDate) : 'No due date'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>` : ''}

      <div class="flex items-center justify-between gap-3 px-5 py-4 border-t border-gray-100">
        <p class="text-xs text-gray-400" data-sync-status>Pushes ${tasks.length} action item${tasks.length === 1 ? '' : 's'} to ${esc(destination)}.</p>
        <button type="button" data-sync-action
          class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed shrink-0 whitespace-nowrap">
          Sync to ${esc(destination)}
        </button>
      </div>
    `;

    // Live behaviour: create a Notion page or post to Slack, per the destination.
    const statusLine = el.querySelector('[data-sync-status]');
    el.addEventListener('click', async (e) => {
      const button = e.target.closest('[data-sync-action]');
      if (!button || button.disabled) return;

      button.disabled = true;
      button.textContent = 'Syncing…';
      statusLine.className = 'text-xs text-gray-400';
      try {
        const data = await postSyncAction(syncActionType, {
          meetingSummary: ui.meetingSummary ?? null,
          targetDestination: ui.targetDestination ?? null,
          channel: ui.channel ?? null,
          tasks: tasks.map((t) => ({
            description: t.description,
            assignee: t.assignee ?? null,
            dueDate: t.dueDate ?? null,
          })),
        });
        button.textContent = 'Synced ✓';
        button.className = 'px-4 py-2 bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-bold rounded-lg cursor-default shrink-0 whitespace-nowrap';
        statusLine.textContent = data.message || `Synced to ${destination}.`;
        statusLine.className = 'text-xs font-semibold text-emerald-700';
      } catch (err) {
        button.disabled = false;
        button.textContent = 'Retry sync';
        button.className = 'px-4 py-2 bg-red-50 border border-red-200 text-red-700 hover:border-red-300 text-sm font-bold rounded-lg transition shrink-0 whitespace-nowrap';
        statusLine.textContent = err.message || `Could not sync to ${destination}.`;
        statusLine.className = 'text-xs font-semibold text-red-600';
      }
    });

    return el;
  }

  register('action_item_assignment', renderActionItemAssignmentCard);
  // Alias for callers/routes that use the PascalCase component name as the type key.
  register('ActionItemAssignmentCard', renderActionItemAssignmentCard);

  // ── Built-in: Social Publish Card ───────────────────────────────────────────
  // Renderer for the social-media-manager publish wire shape:
  // { type: 'social_publish_card', platform, caption?, hashtags?, mediaUrl?,
  //   title?, description?, tags?, format?, conversational? }
  // Valid targets are all seven social platforms. threads/tiktok/youtube publish ON
  // DEMAND here via /api/actions/sync (threads_create_post / tiktok_upload_video /
  // youtube_upload_video — workspace OAuth token injected server-side); facebook/
  // instagram/linkedin/x drafts are published by the scheduled publisher pipeline at
  // the approved slot, so their card is informational (no direct-publish button).
  const SOCIAL_PUBLISH_TARGETS = {
    threads: {
      label: 'Threads', emoji: '🧵',
      action: 'threads_create_post',
      payload: (ui) => ({
        caption: ui.caption ?? null,
        hashtags: ui.hashtags ?? null,
        mediaUrl: ui.mediaUrl ?? null,
        conversational: ui.conversational ?? null,
      }),
    },
    tiktok: {
      label: 'TikTok', emoji: '🎵',
      action: 'tiktok_upload_video',
      payload: (ui) => ({
        videoUrl: ui.mediaUrl ?? null,
        caption: ui.caption ?? null,
        hashtags: ui.hashtags ?? null,
      }),
    },
    youtube: {
      label: 'YouTube', emoji: '▶️',
      action: 'youtube_upload_video',
      payload: (ui) => ({
        videoUrl: ui.mediaUrl ?? null,
        title: ui.title ?? null,
        caption: ui.caption ?? null,
        description: ui.description ?? null,
        tags: ui.tags ?? null,
        format: ui.format ?? null,
      }),
    },
  };
  const SOCIAL_SCHEDULED_PLATFORMS = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X (Twitter)', twitter: 'X (Twitter)' };

  function renderSocialPublishCard(ui, esc) {
    const platform = String(ui.platform || '').trim().toLowerCase();
    const target = SOCIAL_PUBLISH_TARGETS[platform];
    const scheduledLabel = SOCIAL_SCHEDULED_PLATFORMS[platform];
    if (!target && !scheduledLabel) return null; // unknown platform — fall back to text-only

    const label = target ? target.label : scheduledLabel;
    const caption = typeof ui.caption === 'string' ? ui.caption : '';
    const hashtags = typeof ui.hashtags === 'string' ? ui.hashtags : '';
    const title = typeof ui.title === 'string' ? ui.title : '';
    if (!caption && !title) return null; // nothing to publish — fall back to text-only

    const el = document.createElement('div');
    el.className = 'bg-white border border-gray-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 bg-emerald-100 rounded-lg flex items-center justify-center text-xl shrink-0">${target ? target.emoji : '📣'}</div>
          <div class="min-w-0">
            <p class="text-xs font-bold text-emerald-700 tracking-wider uppercase">Ready to publish</p>
            <p class="font-bold text-gray-900 truncate">${esc(title) || `${esc(label)} post`}</p>
          </div>
        </div>
        <span class="text-xs font-bold px-2 py-0.5 rounded-full border shrink-0 bg-gray-50 text-gray-600 border-gray-200">${esc(label)}</span>
      </div>

      ${caption ? `<p class="text-sm text-gray-700 whitespace-pre-line mb-2">${esc(caption)}</p>` : ''}
      ${hashtags ? `<p class="text-xs font-semibold text-emerald-700 mb-2">${esc(hashtags)}</p>` : ''}
      ${ui.mediaUrl ? `<p class="text-xs text-gray-400 mb-2">📎 Media attached</p>` : ''}

      ${target ? `
      <div class="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-gray-100">
        <p class="text-xs text-gray-400" data-publish-status>Publishes this draft to ${esc(label)} now.</p>
        <button type="button" data-publish-social
          class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed shrink-0 whitespace-nowrap">
          Publish to ${esc(label)}
        </button>
      </div>` : `
      <div class="mt-3 pt-3 border-t border-gray-100">
        <p class="text-xs text-gray-400">${esc(label)} posts go out automatically at their approved slot via the scheduled publisher.</p>
      </div>`}
    `;

    // Live behaviour (threads/tiktok/youtube): dispatch the matching sync action.
    if (target) {
      const statusLine = el.querySelector('[data-publish-status]');
      el.addEventListener('click', async (e) => {
        const button = e.target.closest('[data-publish-social]');
        if (!button || button.disabled) return;

        button.disabled = true;
        button.textContent = 'Publishing…';
        statusLine.className = 'text-xs text-gray-400';
        try {
          const data = await postSyncAction(target.action, target.payload(ui));
          button.textContent = 'Published ✓';
          button.className = 'px-4 py-2 bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-bold rounded-lg cursor-default shrink-0 whitespace-nowrap';
          statusLine.textContent = data.message || `Published to ${label}.`;
          statusLine.className = 'text-xs font-semibold text-emerald-700';
        } catch (err) {
          button.disabled = false;
          button.textContent = 'Retry publish';
          button.className = 'px-4 py-2 bg-red-50 border border-red-200 text-red-700 hover:border-red-300 text-sm font-bold rounded-lg transition shrink-0 whitespace-nowrap';
          statusLine.textContent = err.message || `Could not publish to ${label}.`;
          statusLine.className = 'text-xs font-semibold text-red-600';
        }
      });
    }

    return el;
  }

  register('social_publish_card', renderSocialPublishCard);
  // Alias for callers/routes that use the PascalCase component name as the type key.
  register('SocialPublishCard', renderSocialPublishCard);

  // ── Built-in: Upgrade Required Card (paywall) ───────────────────────────────
  // Renderer for the orchestrator's 403 over-limit wire shape (chat-orchestrator.ts):
  // { type: 'upgrade_required', reason }
  // Amber→purple gradient border marks this as a PLAN BOUNDARY, not an assistant
  // deliverable (emerald) or a routing action (indigo). Rendered by chat-session.js in
  // place of the assistant reply when the orchestrator rejects a turn over the cap;
  // the CTA goes to the pricing page, the app's existing upgrade/checkout entry point.
  function renderUpgradeRequiredCard(ui, esc) {
    const reason = typeof ui.reason === 'string' && ui.reason.trim()
      ? ui.reason.trim() : 'You have reached your monthly AI task limit.';

    const el = document.createElement('div');
    el.className = 'bg-gradient-to-br from-amber-400 via-purple-400 to-purple-600 p-[2px] rounded-xl shadow-sm max-w-md';
    el.innerHTML = `
      <div class="bg-white rounded-[10px] p-5">
        <div class="flex items-start gap-3 mb-3">
          <div class="w-10 h-10 bg-gradient-to-br from-amber-100 to-purple-100 rounded-lg flex items-center justify-center shrink-0">
            <svg class="w-5 h-5 text-purple-700" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/>
            </svg>
          </div>
          <div class="min-w-0">
            <p class="text-xs font-bold text-purple-700 tracking-wider uppercase">Plan limit reached</p>
            <p class="font-bold text-gray-900">Upgrade to keep going</p>
          </div>
        </div>
        <p class="text-sm text-gray-700 mb-4">${esc(reason)}</p>
        <a href="/pricing.html"
          class="block w-full text-center px-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold rounded-lg transition">
          Upgrade to Premium
        </a>
        <p class="mt-2.5 text-xs text-gray-400 text-center">Your conversation is saved — pick up right where you left off.</p>
      </div>`;
    return el;
  }

  register('upgrade_required', renderUpgradeRequiredCard);
  // Alias for callers/routes that use the PascalCase component name as the type key.
  register('UpgradeRequiredCard', renderUpgradeRequiredCard);

  window.DisruptiveUIRegistry = { register, has, render, escapeHtml };
})();
