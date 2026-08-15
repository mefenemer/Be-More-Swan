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
 *   window.DisruptiveUIRegistry.render(uiElement, opts?)   // opts describes the SURFACE, not the data
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

  /**
   * `opts` describes the SURFACE, not the data — the same stored card renders in the chat
   * transcript and inside a record's detail panel, and one of its sentences is only true on one of
   * them. Renderers that do not care ignore it; see renderLeadScoringCard's `sendsOnApproval`.
   */
  function render(uiElement, opts) {
    if (!uiElement || typeof uiElement !== 'object' || typeof uiElement.type !== 'string') return null;
    const renderFn = renderers.get(uiElement.type);
    if (!renderFn) return null;
    try {
      const el = renderFn(uiElement, escapeHtml, opts || {});
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
  /**
   * The rating chip + score bar, from the GENERATED mirror (window.LeadRating.chips, built from
   * src/config/lead-rating-chips.ts) — orange hot, yellow warm, blue cold.
   *
   * ⚠️ Not a local table any more. Three surfaces draw this chip (this card, the Searches result
   * row, the Leads tab's Rating column) and each used to own its class strings, so the same rating
   * was emerald on a card and neutral grey in the table.
   *
   * The neutral fallback covers both an unknown rating and a page that has not loaded the constants
   * script. `cardLabel` is blank in that case, so the card renders no chip rather than inventing a
   * band — this card is the one surface with no column heading to qualify the word.
   */
  function ratingStyle(rating) {
    const c = (window.LeadRating && typeof window.LeadRating.chipFor === 'function')
      ? window.LeadRating.chipFor(rating)
      : null;
    return c
      ? { chip: c.cls, bar: c.bar, label: c.cardLabel }
      : { chip: 'bg-gray-100 text-gray-500 border-gray-200', bar: 'bg-gray-400', label: '' };
  }

  /**
   * `opts.sendsOnApproval` — does pressing Approve, on the surface this card is sitting in, put the
   * email in the post?
   *
   * ⚠️ It depends on the surface, and getting it wrong points a compliance warning at the wrong
   * button. Approving in the REVIEW QUEUE calls send_outreach and the mail goes (assistants.js);
   * approving in the LEADS TAB only records the decision, and that handler's own status line says
   * "Nothing has been sent — the drafted email is waiting for you in the Review tab". This card was
   * written for the first case and rendered unchanged in the second, so a user reading a lead in
   * the Leads tab was told, directly above an Approve button, that approving would email a named
   * individual automatically. Default true: chat and the Review Queue are where this card came
   * from, and a surface that does send must never be the one that forgets to say so.
   */
  /**
   * `opts.outreachActions` — may this card offer to DO something with the email?
   *
   * False on a surface whose job is the lead record rather than the message. The Leads tab is one:
   * it exists to read a lead, progress its next step, enrich it or delete it, and every act on the
   * outreach email — draft, copy, edit, send — belongs to the Review tab, where the full email is
   * on screen to be read before any of them. Two places to push the same draft into Gmail is how a
   * user ends up with two drafts and no idea which one they edited.
   *
   * The address still renders: that is a fact about the lead (who was found), not an action on
   * the message.
   */
  /**
   * `opts.nextStep` — who performs the suggested next step, and the one button that starts it.
   *
   * ── Why the card cannot work this out for itself ────────────────────────────
   * `suggestedNextStep` is a free-text sentence from the model — "Email the head of ops about
   * their Q4 rollout", "Call them", "Check whether they still run in-house". The card rendered it
   * as an instruction with no subject, so nobody could tell whether it described something the
   * assistant was about to do or something waiting on the user. Both readings were live: an
   * approved, deliverable lead really does get its outreach sent and chased for you, and every
   * other step in that list is yours alone.
   *
   * Deciding that from the SENTENCE would mean regex-matching prose from an LLM, which is guessing
   * dressed as logic. It is decided from the lead's STATE instead — approval gate, address,
   * outcome — by the surface that holds the record (assistant-data-hub.js `nextStepGuidance`), and
   * this renderer only draws the verdict it is handed:
   *
   *   { owner: 'you' | 'assistant' | 'closed',
   *     note: '<one sentence naming what the platform will and will not do>',
   *     action: { key: '<host-defined>', label: '<button text>' } | null }
   *
   * ⚠️ The button carries `data-lead-next-step="<key>"` and NOTHING ELSE — no handler, no fetch.
   * The host that supplied the guidance is the host that wires it, so a surface which cannot
   * actually perform the action cannot accidentally render a button that pretends it can. Omit
   * `opts.nextStep` (chat, the Review Queue) and the step renders exactly as it always did.
   */
  const NEXT_STEP_OWNER = {
    you: { label: 'Yours to do', cls: 'bg-white text-emerald-800 border-emerald-300' },
    // border-emerald-200, not -700: only the classes already compiled into style.css may be used
    // here, and a Tailwind rebuild to gain one border colour churns unrelated selectors app-wide.
    assistant: { label: 'Your assistant does this', cls: 'bg-emerald-700 text-white border-emerald-200' },
    closed: { label: 'Nothing is happening', cls: 'bg-gray-100 text-gray-600 border-gray-300' },
  };

  function nextStepFooter(guidance, esc) {
    const owner = guidance && NEXT_STEP_OWNER[guidance.owner];
    if (!owner) return '';
    const action = guidance.action && guidance.action.key && guidance.action.label ? guidance.action : null;
    // `data-next-step-footer` is the handle the host re-renders through. Approving a lead changes
    // who owns its next step — the sentence "approving clears this lead for outreach" is wrong the
    // instant it has been approved — and the panel is not rebuilt around it, so the host swaps
    // this node in place (assistant-data-hub.js syncNextStepFooter).
    return `
      <div data-next-step-footer class="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t border-emerald-200">
        <span class="text-xs font-bold px-2 py-0.5 rounded-full border ${owner.cls}">${esc(owner.label)}</span>
        ${guidance.note ? `<span class="text-xs text-emerald-800 flex-1 min-w-0">${esc(guidance.note)}</span>` : ''}
        ${action ? `<button type="button" data-lead-next-step="${esc(action.key)}"
          class="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed ml-auto shrink-0">${esc(action.label)}</button>` : ''}
      </div>`;
  }

  function renderLeadScoringCard(ui, esc, opts) {
    const sendsOnApproval = !opts || opts.sendsOnApproval !== false;
    const outreachActions = !opts || opts.outreachActions !== false;
    const score = Math.max(0, Math.min(100, Number(ui.score) || 0));
    // ⚠️ Was `RATING_STYLES[ui.rating] || RATING_STYLES.cold` — an unrated lead was drawn as COLD,
    // which is a verdict the scorer never reached. ratingStyle() returns the neutral chip with an
    // empty label instead, and the chip below is omitted entirely when there is nothing to say.
    const rating = ratingStyle(ui.rating);
    const reasons = Array.isArray(ui.reasons) ? ui.reasons.filter((r) => typeof r === 'string') : [];

    // Outreach draft: only render the Gmail action when the LLM produced an email body AND this
    // surface deals in the email at all.
    const draft = (outreachActions && ui.outreachDraft && typeof ui.outreachDraft === 'object'
      && typeof ui.outreachDraft.body === 'string' && ui.outreachDraft.body.trim())
      ? ui.outreachDraft : null;

    // Enriched contact (process-discovery-jobs.ts `enriching` stage). Approving a
    // discovered lead AUTO-SENDS to this address, so the reviewer must be able to see
    // it. 'personal' = a named individual's inbox rather than a generic role inbox:
    // weaker footing for cold B2B outreach, so it's called out rather than shown
    // identically to info@/enquiries@.
    //
    // ⚠️ WHERE the address came from is deliberately NOT rendered here any more. The line read
    // "Found on <emailFoundOn> — published by the company, not verified", and on a paid-provider
    // hit `emailFoundOn` is the provider's name, so the card announced "Found on hunter" to a user
    // who has never heard of Hunter and cannot act on the fact. Naming our data supplier is
    // plumbing; the decision it was supposed to inform ("is this a named individual?") is made by
    // the personal-inbox warning below, which is kept. The provenance itself is NOT discarded —
    // emailKind / emailSource still ride on the record and still drive
    // needsPersonalInboxConfirmation at the send seam (src/config/lead-email-kind.ts), which is
    // the gate that actually has to know.
    const contactEmail = typeof ui.contactEmail === 'string' && ui.contactEmail.trim() ? ui.contactEmail.trim() : null;
    const isPersonalInbox = contactEmail && ui.emailKind === 'personal';

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
        ${rating.label ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full border shrink-0 ${rating.chip}">${rating.label}</span>` : ''}
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
          ${nextStepFooter(opts && opts.nextStep, esc)}
        </div>` : ''}

      ${contactEmail ? `
        <div class="mt-4 pt-3 border-t border-gray-100">
          <p class="text-xs font-bold text-gray-500 tracking-wider uppercase mb-1.5">${sendsOnApproval ? 'Outreach will be sent to' : 'Outreach is addressed to'}</p>
          <p class="text-sm font-semibold text-gray-900 break-all">${esc(contactEmail)}</p>
          ${isPersonalInbox ? `
            <div class="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
              <p class="text-xs font-bold text-amber-900">Personal inbox — check before approving</p>
              <p class="text-xs text-amber-800 mt-0.5">This looks like a named individual rather than a general contact address. ${sendsOnApproval
                ? 'Approving sends the outreach email automatically.'
                : 'Approving here records your decision only — the email goes out when you approve it in the Review tab.'}</p>
            </div>` : ''}
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
  //   invoiceNumber?: string|null,
  //   emailDraft?: { subject, body } | null }, ...] }
  // emailDraft is the tone-matched chasing email (friendly at ~7 days, firm at 30+);
  // drafts render as expandable blocks under the table with a copy action.
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
      ${invoices.some((inv) => inv.emailDraft && typeof inv.emailDraft === 'object' && inv.emailDraft.body) ? `
      <div class="px-5 py-4 border-t border-gray-100 space-y-2">
        <p class="text-xs font-bold text-gray-500 tracking-wider uppercase">Chasing emails — ready to send</p>
        ${invoices.map((inv, i) => {
          const draft = (inv.emailDraft && typeof inv.emailDraft === 'object' && inv.emailDraft.body) ? inv.emailDraft : null;
          if (!draft) return '';
          return `
          <details class="group bg-gray-50 border border-gray-200 rounded-lg">
            <summary class="flex items-center justify-between gap-3 px-4 py-2.5 cursor-pointer select-none list-none">
              <span class="text-sm font-semibold text-gray-900 truncate">${esc(inv.clientName) || 'Unknown client'} <span class="font-normal text-gray-500">— ${esc(draft.subject) || 'chasing email'}</span></span>
              <svg class="w-4 h-4 text-gray-400 shrink-0 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </summary>
            <div class="px-4 pb-3">
              <p class="text-sm text-gray-700 whitespace-pre-line">${esc(draft.body)}</p>
              <button type="button" data-copy-chase="${i}"
                class="mt-3 px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition">
                Copy email
              </button>
            </div>
          </details>`;
        }).join('')}
      </div>` : ''}
      <p class="px-5 py-3 text-xs text-gray-400 border-t border-gray-100" data-table-status>Toggle off to pause chasing a client (visual only). "Log note" writes a chasing note against the invoice in ${acctLabel}.</p>
    `;

    // Mock behaviour: unticking "chasing" dims the row so the pause reads visually.
    el.addEventListener('change', (e) => {
      const toggle = e.target.closest('[data-pause-chasing]');
      if (!toggle) return;
      const row = toggle.closest('[data-invoice-row]');
      if (row) row.classList.toggle('opacity-40', !toggle.checked);
    });

    // Copy a chasing email draft — the no-accounting-platform (spreadsheet fallback) path.
    el.addEventListener('click', async (e) => {
      const copyBtn = e.target.closest('[data-copy-chase]');
      if (!copyBtn) return;
      const draft = invoices[Number(copyBtn.getAttribute('data-copy-chase'))]?.emailDraft;
      if (!draft) return;
      try {
        await navigator.clipboard.writeText(`Subject: ${draft.subject || ''}\n\n${draft.body || ''}`);
        copyBtn.textContent = 'Copied ✓';
      } catch {
        copyBtn.textContent = 'Copy failed';
      }
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
  //   escalationReason: string|null, escalationEmail?: string|null,
  //   kbCitations?: string[]|null, draftReply?: string }
  // kbCitations names the Knowledge Base articles that ground a Resolved answer
  // (KB phase — kb_articles via the Knowledge Base tab); null/absent = ungrounded.
  // draftReply is the ready-to-send customer-facing response (Spreadsheet-fallback
  // path: SMBs without a helpdesk copy it into their own inbox).
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

      ${!escalated && Array.isArray(ui.kbCitations) && ui.kbCitations.length ? `
        <div class="mt-3 text-xs text-gray-500">
          <span class="font-bold text-gray-600">📚 Grounded in your Knowledge Base:</span>
          ${ui.kbCitations.map((c) => `<span class="inline-block bg-gray-50 border border-gray-200 rounded-full px-2 py-0.5 font-semibold text-gray-600 ml-1 mt-1">${esc(c)}</span>`).join('')}
        </div>` : ''}

      ${typeof ui.draftReply === 'string' && ui.draftReply.trim() ? `
      <details class="mt-4 group">
        <summary class="flex items-center justify-between gap-3 cursor-pointer select-none list-none">
          <span class="text-xs font-bold text-gray-500 tracking-wider uppercase">Drafted customer reply</span>
          <svg class="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
        </summary>
        <div class="mt-2 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
          <p class="text-sm text-gray-700 whitespace-pre-line">${esc(ui.draftReply.trim())}</p>
          <button type="button" data-copy-reply
            class="mt-3 px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition">
            Copy reply
          </button>
        </div>
      </details>` : ''}

      <div class="flex items-center justify-between gap-3 mt-4 pt-3 border-t border-gray-100">
        <p class="text-xs text-gray-400" data-helpdesk-status>Logs this triage summary as an internal note on the ${isIntercom ? 'conversation' : 'ticket'}.</p>
        <button type="button" data-log-helpdesk
          class="px-4 py-2 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed shrink-0 whitespace-nowrap">
          Log to ${deskLabel}
        </button>
      </div>
    `;

    // Copy the drafted customer reply — the no-helpdesk (spreadsheet fallback) path.
    el.addEventListener('click', async (e) => {
      const copyBtn = e.target.closest('[data-copy-reply]');
      if (!copyBtn) return;
      try {
        await navigator.clipboard.writeText(String(ui.draftReply).trim());
        copyBtn.textContent = 'Copied ✓';
      } catch {
        copyBtn.textContent = 'Copy failed';
      }
    });

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

  // ── Built-in: Discovery Campaign Proposal Card ──────────────────────────────
  // Renderer for the lead-qualifier route's outbound-search wire shape
  // (chat-orchestrator.ts): { type: 'discovery_campaign_proposal', name, idea,
  //   cadence: 'one_off'|'daily'|'weekly', rationale?,
  //   guardrails?: { maxLeadsPerRun?, negativeKeywords?: string[],
  //                  requireHumanApproval?: boolean } }
  //
  // The whole point of this card is that the assistant STOPS here. Approving saves the search
  // as a DRAFT — it spends nothing and finds nothing until the user starts it from the Signal
  // Inbox. A run costs real money per run and emails real strangers downstream, so nothing may
  // begin on the strength of a model's judgement plus one click in a chat window.
  //
  // Indigo/purple, matching HandoffProposalCard: in this transcript's visual language that means
  // "an action awaiting your approval", not a finished deliverable (the emerald cards).
  //
  // Approve dispatches a bubbling 'discovery:create' CustomEvent — chat-session.js owns the call
  // because it is what knows the assistantId; the renderer only ever receives `ui`. detail.respond
  // is how the outcome gets back here, since a create can fail (no session, no such assistant) and
  // a card that always claims success is worse than no card.
  function renderDiscoveryCampaignProposalCard(ui, esc) {
    const CADENCE_LABEL = {
      one_off: 'Runs once, when you start it',
      daily: 'Every day at 08:00 UTC, once started',
      weekly: 'Every week, once started',
    };
    const cadence = typeof ui.cadence === 'string' && CADENCE_LABEL[ui.cadence] ? ui.cadence : 'one_off';
    const idea = typeof ui.idea === 'string' ? ui.idea.trim() : '';
    const name = typeof ui.name === 'string' && ui.name.trim() ? ui.name.trim() : 'Untitled search';
    const g = (ui.guardrails && typeof ui.guardrails === 'object') ? ui.guardrails : {};

    // Only state limits the proposal actually set. Printing the table defaults here would be
    // inventing numbers the server was never told, which the user would then read as a promise.
    //
    // maxCostGbpPerRun is deliberately NOT shown, and no longer proposable. It is a ceiling on OUR
    // Serper spend (£0.001/call, so maxSearchCallsPerRun caps a run at ~£0.10 long before any £
    // figure binds) — never the user's money, and nothing bills it to them. Rendering it put a
    // pound sign on a card whose whole job is informed consent, and every user read it as a price.
    const limits = [];
    if (typeof g.maxLeadsPerRun === 'number') limits.push(`Up to ${esc(String(g.maxLeadsPerRun))} leads per run`);
    if (Array.isArray(g.negativeKeywords) && g.negativeKeywords.length) {
      limits.push(`Excluding: ${esc(g.negativeKeywords.filter((k) => typeof k === 'string').join(', '))}`);
    }
    if (g.requireHumanApproval !== false) limits.push('You review every lead before any outreach');

    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <div class="flex items-start gap-3 mb-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-xl shrink-0">🔍</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">New search · Approval needed</p>
          <p class="font-bold text-gray-900 truncate">${esc(name)}</p>
        </div>
      </div>

      ${idea ? `
        <p class="text-xs font-bold text-indigo-700 uppercase tracking-wide mb-1">Who I'll look for</p>
        <p class="text-sm text-gray-700 mb-3 whitespace-pre-wrap break-words">${esc(idea)}</p>` : ''}

      ${ui.rationale ? `
        <p class="text-sm text-gray-700 mb-3"><span class="font-bold text-indigo-900">Why:</span> ${esc(ui.rationale)}</p>` : ''}

      <ul class="mb-4 space-y-1">
        <li class="text-xs text-gray-600">• ${esc(CADENCE_LABEL[cadence])}</li>
        ${limits.map((l) => `<li class="text-xs text-gray-600">• ${l}</li>`).join('')}
      </ul>

      <div class="flex items-center gap-2" data-dcp-actions>
        <button type="button" data-dcp-approve
          class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Save this search
        </button>
        <button type="button" data-dcp-decline
          class="px-4 py-2 bg-white border border-indigo-200 text-indigo-700 hover:bg-indigo-50 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Not this one
        </button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-dcp-status></p>
    `;

    const status = el.querySelector('[data-dcp-status]');
    function say(text, tone) {
      status.textContent = text;
      status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`;
    }
    function setBusy(busy) {
      el.querySelectorAll('[data-dcp-approve], [data-dcp-decline]').forEach((b) => { b.disabled = busy; });
    }

    el.addEventListener('click', (e) => {
      const approve = e.target.closest('[data-dcp-approve]');
      const decline = e.target.closest('[data-dcp-decline]');
      if (!approve && !decline) return;

      if (decline) {
        setBusy(true);
        say('Search declined.');
        return;
      }

      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('discovery:create', {
        bubbles: true,
        detail: {
          name,
          idea,
          cadence,
          guardrails: g,
          // Re-enabling on failure is the point: a transient error must leave the user able to
          // try again rather than stranding an approved proposal with two dead buttons.
          respond({ ok, deduped, error }) {
            if (ok) {
              // Tab name must match assistant-dashboard-registry.js `signalInbox.label` — it has
              // been renamed once already ("Signal Inbox" → "Searches"). Pinned by
              // tests/lead-prompt-surfaces.test.ts so this copy cannot drift off the tab silently.
              say(deduped
                ? 'Already saved — it is in your Searches tab.'
                : 'Saved as a draft — press "Start search" on it in your Searches tab.');
              return;
            }
            setBusy(false);
            say(error || 'Could not save that search — please try again.', 'error');
          },
        },
      }));
    });

    return el;
  }

  register('discovery_campaign_proposal', renderDiscoveryCampaignProposalCard);
  register('DiscoveryCampaignProposalCard', renderDiscoveryCampaignProposalCard);

  // ── Built-in: Campaign Strategy Proposal Card ───────────────────────────────
  // Renderer for the campaign_orchestrator route's wire shape (chat-orchestrator.ts):
  //   { type: 'campaign_strategy_proposal', objective, outcomeMetric, targetValue?,
  //     maxWorkItems?, endsAt?, rationale?,
  //     orders?: [{ action, assignedRole, quantity? }] }
  //
  // Same indigo "awaiting your approval" language as the discovery card above, and for the same
  // reason: approving here SAVES A DRAFT. It commissions nothing, spends nothing and briefs
  // nobody until the user presses Start on the Campaigns tab, with the numbers in front of them.
  // A campaign is the largest blast radius in the product — it can put work into three other
  // assistants at once — so a model's judgement plus one click in a chat window is not enough.
  //
  // ⚠️ NO £ FIGURE APPEARS ON THIS CARD, EVER. Not "£0", not "no cost". Phase 1 campaigns spend
  // capacity, not money, and discovery-spend-cap-is-operator-only is the receipt: a pound sign on
  // a card IS a price to whoever reads it, whatever we meant by it. Work is counted in tasks.
  function renderCampaignStrategyProposalCard(ui, esc) {
    const C = window.CampaignConstants;
    // Named for the user, not for the schema. "lead_qualifier" on a card is an internal identifier
    // leaking into a founder's inbox; these match the catalog names in db/seed-catalog.ts.
    const ROLE_LABEL = {
      social_media_manager: 'Social Media Assistant',
      blog_writer: 'Blog Writing Assistant',
      lead_qualifier: 'Lead Generation Assistant',
    };

    const objective = typeof ui.objective === 'string' ? ui.objective.trim() : '';
    const rationale = typeof ui.rationale === 'string' ? ui.rationale.trim() : '';
    const outcomeMetric = typeof ui.outcomeMetric === 'string' ? ui.outcomeMetric : 'leads';
    const outcomeLabel = C ? C.outcomeLabel(outcomeMetric) : outcomeMetric;
    const targetValue = Number.isFinite(Number(ui.targetValue)) ? Number(ui.targetValue) : null;
    const maxWorkItems = Number.isFinite(Number(ui.maxWorkItems)) ? Number(ui.maxWorkItems) : null;

    // Only render orders the client can name. An unknown action or role means the model invented
    // one, and listing it would promise the user work no assistant will ever be asked to do.
    const orders = (Array.isArray(ui.orders) ? ui.orders : [])
      .filter((o) => o && typeof o === 'object' && ROLE_LABEL[o.assignedRole])
      .map((o) => ({
        label: C ? C.orderActionLabel(o.action) : String(o.action || ''),
        role: ROLE_LABEL[o.assignedRole],
        qty: Number.isFinite(Number(o.quantity)) && Number(o.quantity) > 1 ? Number(o.quantity) : null,
      }))
      .filter((o) => o.label);

    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <div class="flex items-start gap-3 mb-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-xl shrink-0">🎯</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Campaign plan · Approval needed</p>
          <p class="font-bold text-gray-900 break-words">${esc(objective || 'Untitled campaign')}</p>
        </div>
      </div>

      ${rationale ? `
        <p class="text-sm text-gray-700 mb-3"><span class="font-bold text-indigo-900">Why:</span> ${esc(rationale)}</p>` : ''}

      ${orders.length ? `
        <p class="text-xs font-bold text-indigo-700 uppercase tracking-wide mb-1">Who I'd brief</p>
        <ul class="mb-3 space-y-1">
          ${orders.map((o) => `
            <li class="text-xs text-gray-600">• ${esc(o.label)}${o.qty ? ` ×${esc(String(o.qty))}` : ''} — ${esc(o.role)}</li>
          `).join('')}
        </ul>` : ''}

      <ul class="mb-4 space-y-1">
        <li class="text-xs text-gray-600">• Counts ${esc(String(outcomeLabel).toLowerCase())}${targetValue ? `, aiming for ${esc(String(targetValue))}` : ''}</li>
        ${maxWorkItems ? `<li class="text-xs text-gray-600">• Uses at most ${esc(String(maxWorkItems))} tasks from your monthly allowance</li>` : ''}
        <li class="text-xs text-gray-600">• You approve every piece of work before it goes out</li>
      </ul>

      <div class="flex items-center gap-2" data-csp-actions>
        <button type="button" data-csp-approve
          class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Save this campaign
        </button>
        <button type="button" data-csp-decline
          class="px-4 py-2 bg-white border border-indigo-200 text-indigo-700 hover:bg-indigo-50 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Not this one
        </button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-csp-status></p>
    `;

    const status = el.querySelector('[data-csp-status]');
    function say(text, tone) {
      status.textContent = text;
      status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`;
    }
    function setBusy(busy) {
      el.querySelectorAll('[data-csp-approve], [data-csp-decline]').forEach((b) => { b.disabled = busy; });
    }

    el.addEventListener('click', (e) => {
      const approve = e.target.closest('[data-csp-approve]');
      const decline = e.target.closest('[data-csp-decline]');
      if (!approve && !decline) return;

      if (decline) {
        setBusy(true);
        say('Plan declined.');
        return;
      }
      if (!objective) {
        setBusy(true);
        say('This plan has no objective, so it cannot be saved.', 'error');
        return;
      }

      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('campaign:create', {
        bubbles: true,
        detail: {
          objective,
          outcomeMetric,
          targetValue,
          maxWorkItems,
          endsAt: typeof ui.endsAt === 'string' ? ui.endsAt : null,
          // The success line is built from the SERVER's answer, never from the model's intent —
          // chat-claims-drafts-it-never-saved is a reply that announced drafts which were never
          // written. Re-enabling on failure lets a transient error be retried instead of
          // stranding an approved plan behind two dead buttons.
          respond({ ok, deduped, error }) {
            if (ok) {
              // Tab name must match assistant-dashboard-registry.js `campaignsTab.label` and the
              // chat-orchestrator system prompt. Pinned by tests/campaign-prompt-surfaces.test.ts
              // so this copy cannot drift off the tab silently.
              say(deduped
                ? 'Already saved — it is in your Campaigns tab.'
                : 'Saved as a draft — press "Start" on it in your Campaigns tab to begin.');
              return;
            }
            setBusy(false);
            say(error || 'Could not save that campaign — please try again.', 'error');
          },
        },
      }));
    });

    return el;
  }

  register('campaign_strategy_proposal', renderCampaignStrategyProposalCard);
  register('CampaignStrategyProposalCard', renderCampaignStrategyProposalCard);

  // ── Built-in: Action Item Assignment Card ───────────────────────────────────
  // Renderer for the meeting-note-taker route's wire shape (chat-orchestrator.ts):
  // { type: 'action_item_assignment', meetingSummary, decisionsMade?: string[],
  //   identifiedRisks?: string[], targetDestination, channel?,
  //   attendees?: [{ name, email: string|null }, ...],
  //   followupEmail?: { subject, body } | null,
  //   tasks: [{ description, assignee, dueDate: string|null }, ...] }
  // targetDestination echoes the onboarding taskDestination label and picks the sync
  // route: 'Notion' creates a page (summary paragraph + to_do blocks) via
  // /api/actions/sync (notion_create_page); anything else posts the summary + tasks
  // to Slack as Block Kit (slack_post_summary), where an optional ui.channel ('#name'
  // or channel id) picks the channel, defaulting to #general.
  function renderActionItemAssignmentCard(ui, esc) {
    const tasks = (Array.isArray(ui.tasks) ? ui.tasks : [])
      .filter((t) => t && typeof t === 'object' && t.description);
    const decisions = (Array.isArray(ui.decisionsMade) ? ui.decisionsMade : [])
      .filter((d) => typeof d === 'string' && d.trim());
    const risks = (Array.isArray(ui.identifiedRisks) ? ui.identifiedRisks : [])
      .filter((r) => typeof r === 'string' && r.trim());
    const attendees = (Array.isArray(ui.attendees) ? ui.attendees : [])
      .map((a) => (a && typeof a === 'object'
        ? { name: typeof a.name === 'string' ? a.name : '', email: typeof a.email === 'string' ? a.email : '' }
        : null))
      .filter((a) => a && (a.name || a.email));
    const followup = (ui.followupEmail && typeof ui.followupEmail === 'object') ? ui.followupEmail : null;
    if (!ui.meetingSummary && !decisions.length && !risks.length && tasks.length === 0) return null; // nothing extracted — fall back to text-only

    const destination = typeof ui.targetDestination === 'string' && ui.targetDestination.trim()
      ? ui.targetDestination.trim() : 'your task tracker';
    const isNotion = destination.toLowerCase() === 'notion';
    const syncActionType = isNotion ? 'notion_create_page' : 'slack_post_summary';
    // Only Notion has a native create action today; every other destination (Jira,
    // Asana, Monday, "your task tracker") is fulfilled by posting to Slack — the
    // button must say what actually happens.
    const syncLabel = isNotion ? 'Notion' : 'Slack';

    // Summary / Decisions / Risks stack above the action-item table. Each section
    // carries a bottom divider unless it is the last thing before the footer (the
    // footer already draws its own top border), so the borders never double up.
    const bodySections = [];
    if (ui.meetingSummary) {
      bodySections.push(`<p class="text-sm text-gray-700 whitespace-pre-line">${esc(ui.meetingSummary)}</p>`);
    }
    if (decisions.length) {
      bodySections.push(`
        <p class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Decisions</p>
        <ul class="space-y-1">
          ${decisions.map((d) => `<li class="text-sm text-gray-700 flex gap-2"><span class="text-emerald-600 shrink-0">✓</span><span>${esc(d)}</span></li>`).join('')}
        </ul>`);
    }
    if (risks.length) {
      bodySections.push(`
        <p class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Risks &amp; blockers</p>
        <ul class="space-y-1">
          ${risks.map((r) => `<li class="text-sm text-gray-700 flex gap-2"><span class="text-amber-500 shrink-0">⚠</span><span>${esc(r)}</span></li>`).join('')}
        </ul>`);
    }
    if (attendees.length) {
      bodySections.push(`
        <p class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Attendees</p>
        <div class="flex flex-wrap gap-2">
          ${attendees.map((a) => {
            const nameHtml = a.name ? `<span class="font-semibold text-gray-700">${esc(a.name)}</span>` : '';
            const emailHtml = a.email
              ? `<span class="text-gray-500">${esc(a.email)}</span>`
              : `<span class="text-gray-400 italic">email needed</span>`;
            const sep = a.name ? `<span class="text-gray-300">·</span>` : '';
            return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-50 border border-gray-200 rounded-full text-xs">${nameHtml}${sep}${emailHtml}</span>`;
          }).join('')}
        </div>`);
    }
    if (followup && (followup.subject || followup.body)) {
      bodySections.push(`
        <p class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Follow-up email <span class="font-normal normal-case text-gray-400">— review &amp; edit in your inbox before it sends</span></p>
        <div class="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
          ${followup.subject ? `<p class="px-3 py-2 text-sm font-semibold text-gray-800 border-b border-gray-200">${esc(followup.subject)}</p>` : ''}
          ${followup.body ? `<p class="px-3 py-2 text-sm text-gray-600 whitespace-pre-line">${esc(followup.body)}</p>` : ''}
        </div>`);
    }
    const bodyHtml = bodySections.map((section, i) => {
      const needsBorder = tasks.length > 0 || i < bodySections.length - 1;
      return `<div class="px-5 py-4 ${needsBorder ? 'border-b border-gray-100' : ''}">${section}</div>`;
    }).join('');

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

      ${bodyHtml}

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
        <p class="text-xs text-gray-400" data-sync-status>${isNotion
          ? `Pushes ${tasks.length} action item${tasks.length === 1 ? '' : 's'} to Notion.`
          : `Posts the summary and ${tasks.length} action item${tasks.length === 1 ? '' : 's'} to Slack${destination.toLowerCase() !== 'slack' ? ` (direct ${esc(destination)} sync is coming — Slack is the delivery channel today)` : ''}.`}</p>
        <button type="button" data-sync-action
          class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed shrink-0 whitespace-nowrap">
          ${isNotion ? 'Sync to Notion' : 'Post to Slack'}
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
          decisionsMade: decisions,
          identifiedRisks: risks,
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
        statusLine.textContent = data.message || `Synced to ${syncLabel}.`;
        statusLine.className = 'text-xs font-semibold text-emerald-700';
      } catch (err) {
        button.disabled = false;
        button.textContent = 'Retry sync';
        button.className = 'px-4 py-2 bg-red-50 border border-red-200 text-red-700 hover:border-red-300 text-sm font-bold rounded-lg transition shrink-0 whitespace-nowrap';
        statusLine.textContent = err.message || `Could not sync to ${syncLabel}.`;
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

  // ── Built-in: Social Post Draft Card ────────────────────────────────────────
  // Renderer for the social_media_manager route's wire shape (chat-orchestrator.ts):
  // { type: 'social_post_draft', platforms: [...], caption, hashtags, forPostId? }
  //
  // Two situations, one card:
  //
  //   No forPostId — the orchestrator already saved this as a new post, and appendMessage's
  //   hubLink renders "review & approve" underneath. The card just shows the copy, so the
  //   caption is legible instead of buried in prose.
  //
  //   forPostId — the chat was opened FROM the post editor about a post the user is editing, and
  //   NOTHING was saved. The card is where the offer is made: press the button and the caption is
  //   written into that post. It is a button and not a "yes" typed into the chat because the
  //   caption is already a structured field here — reading intent back out of prose would be the
  //   one step in this flow that could get it wrong.
  //
  // The target itself (which post, and how to write to it) belongs to whoever opened the chat, not
  // to this registry: window.ChatDraftTarget = { postId, apply({caption, hashtags}), done() }.
  function socialPlatformLabel(p) {
    const key = String(p || '').trim().toLowerCase();
    return SOCIAL_SCHEDULED_PLATFORMS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : '');
  }

  function renderSocialPostDraftCard(ui, esc) {
    const caption = typeof ui.caption === 'string' ? ui.caption.trim() : '';
    if (!caption) return null;                     // nothing drafted — fall back to text-only
    const hashtags = typeof ui.hashtags === 'string' ? ui.hashtags.trim() : '';
    const labels = (Array.isArray(ui.platforms) ? ui.platforms : []).map(socialPlatformLabel).filter(Boolean);
    // The wording of the branded text card the orchestrator drew for this post. Shown because it is
    // frequently the thing that was ASKED for ("give me words for a colour block") and it is
    // otherwise invisible until the post is opened. Only on a saved draft: with forPostId nothing was
    // persisted, so no card was made and showing a line of card copy would promise one.
    const cardHeadline = ui.forPostId == null && typeof ui.cardHeadline === 'string' ? ui.cardHeadline.trim() : '';

    // The offer stands only while the editor that opened this chat is still pointed at this post.
    // A reloaded transcript has the forPostId but no live target, so it shows the copy alone.
    const target = window.ChatDraftTarget;
    const canApply = !!(target && typeof target.apply === 'function'
      && (ui.forPostId == null || Number(ui.forPostId) === Number(target.postId)));

    const el = document.createElement('div');
    el.className = 'bg-white border border-gray-200 rounded-xl shadow-sm p-4 max-w-md space-y-2';
    el.innerHTML = `
      <div class="flex items-center justify-between gap-3">
        <p class="text-[11px] font-bold text-emerald-700 tracking-wider uppercase">Suggested caption</p>
        ${labels.length ? `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-gray-50 text-gray-600 border-gray-200 shrink-0">${esc(labels.join(' · '))}</span>` : ''}
      </div>
      <p class="text-sm text-gray-800 whitespace-pre-line">${esc(caption)}</p>
      ${hashtags ? `<p class="text-xs font-semibold text-emerald-700">${esc(hashtags)}</p>` : ''}
      ${cardHeadline ? `
      <div class="pt-2 mt-1 border-t border-gray-100">
        <p class="text-[11px] font-bold text-gray-400 tracking-wider uppercase">On the branded card</p>
        <p class="text-sm font-bold text-gray-800">${esc(cardHeadline)}</p>
      </div>` : ''}
      ${canApply ? `
      <div class="pt-2.5 mt-1 border-t border-gray-100 space-y-2" data-offer>
        <p class="text-xs text-gray-500" data-offer-status>Want me to put this in the post you're editing?</p>
        <div class="flex items-center gap-2">
          <button type="button" data-apply-draft
            class="px-3 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">
            Yes, add it to my draft
          </button>
          <button type="button" data-dismiss-draft
            class="px-3 py-2 border border-gray-300 text-gray-600 hover:bg-gray-50 text-xs font-bold rounded-lg transition">
            No thanks
          </button>
        </div>
      </div>` : ''}
    `;

    if (!canApply) return el;

    const offer = el.querySelector('[data-offer]');
    const status = el.querySelector('[data-offer-status]');
    el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-dismiss-draft]')) {
        // The copy stays on screen — only the question goes away. Asking again would make "no"
        // feel unheard, and the user can still ask for another version in the conversation.
        offer.remove();
        return;
      }
      const button = e.target.closest('[data-apply-draft]');
      if (!button || button.disabled) return;

      button.disabled = true;
      button.textContent = 'Adding…';
      status.className = 'text-xs text-gray-500';
      try {
        await window.ChatDraftTarget.apply({ caption, hashtags: hashtags || null });
        offer.innerHTML = `
          <p class="text-xs font-bold text-emerald-700">✓ Added to your draft</p>
          <button type="button" data-back-to-draft
            class="mt-2 px-3 py-2 border border-emerald-300 text-emerald-700 hover:bg-emerald-50 text-xs font-bold rounded-lg transition">
            Back to the post
          </button>`;
        offer.querySelector('[data-back-to-draft]').addEventListener('click', () => {
          try { window.ChatDraftTarget?.done?.(); } catch { /* the chat is already closing */ }
        });
      } catch (err) {
        button.disabled = false;
        button.textContent = 'Try again';
        status.textContent = (err && err.message) || 'Could not add that to your draft.';
        status.className = 'text-xs font-semibold text-red-600';
      }
    });

    return el;
  }

  register('social_post_draft', renderSocialPostDraftCard);
  register('SocialPostDraftCard', renderSocialPostDraftCard);

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

  // `nextStepFooterHtml` is exported so the surface that decided the guidance can re-render it
  // when the lead's state moves under it, without a second copy of the markup living there.
  window.DisruptiveUIRegistry = {
    register, has, render, escapeHtml,
    nextStepFooterHtml: (guidance) => nextStepFooter(guidance, escapeHtml),
  };
})();
