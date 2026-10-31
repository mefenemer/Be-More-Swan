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

  // What a campaign does to usual Autopilot posting (campaign-usual-posting.ts). Only the two known
  // kinds and three known values are passed on; anything else is dropped and the server's default stands.
  const USUAL_POSTING_WORDS = { make_way: 'make way for the campaign', pause: 'paused until it ends', normal: 'carry on as normal' };
  function usualPostingOf(ui) {
    const u = ui && ui.usualPosting;
    if (!u || typeof u !== 'object') return undefined;
    const out = {};
    if (USUAL_POSTING_WORDS[u.social]) out.social = u.social;
    if (USUAL_POSTING_WORDS[u.blog]) out.blog = u.blog;
    return Object.keys(out).length ? out : undefined;
  }

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
  // ⚠️ outreachDraft still rides on the wire but this card renders NOTHING for it. "Draft
  // Outreach in Gmail" pushed it into the user's Gmail Drafts via /api/actions/sync until
  // 2026-08-26; that call needed gmail.compose, a RESTRICTED scope carrying a CASA security
  // assessment, and the app now requests gmail.send only. Acting on the draft — read it, edit
  // it, copy it, send it — belongs to the Review tab, which shows the email before it acts.
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
   * the LEADS TAB does not approve at all — its button is "Move to Outreach", which puts the lead
   * in the review column and sends nothing. This card was written for the first case and rendered
   * unchanged in the second, so a user reading a lead in the Leads tab was told, directly above
   * that button, that pressing it would email a named individual automatically. Default true:
   * chat and the Review Queue are where this card came from, and a surface that does send must
   * never be the one that forgets to say so.
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
    // The sentence sits on its own line under the chip and button (2026-10-27): beside them, on a
    // phone, it was squeezed into a column two words wide.
    return `
      <div data-next-step-footer class="mt-2 pt-2 border-t border-emerald-200">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-bold px-2 py-0.5 rounded-full border ${owner.cls}">${esc(owner.label)}</span>
          ${action ? `<button type="button" data-lead-next-step="${esc(action.key)}"
            class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed ml-auto shrink-0">${esc(action.label)}</button>` : ''}
        </div>
        ${guidance.note ? `<p class="text-xs text-emerald-800 mt-1.5">${esc(guidance.note)}</p>` : ''}
      </div>`;
  }

  function renderLeadScoringCard(ui, esc, opts) {
    const sendsOnApproval = !opts || opts.sendsOnApproval !== false;
    const score = Math.max(0, Math.min(100, Number(ui.score) || 0));
    // ⚠️ Was `RATING_STYLES[ui.rating] || RATING_STYLES.cold` — an unrated lead was drawn as COLD,
    // which is a verdict the scorer never reached. ratingStyle() returns the neutral chip with an
    // empty label instead, and the chip below is omitted entirely when there is nothing to say.
    const rating = ratingStyle(ui.rating);
    const reasons = Array.isArray(ui.reasons) ? ui.reasons.filter((r) => typeof r === 'string') : [];

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
        </div>`
        // ⚠️ The footer was nested INSIDE this box, so it existed only on leads whose model output
        // happened to include a `suggestedNextStep` sentence. Everything the footer carries — who
        // owns the next step, and the button that starts it — silently vanished on every lead
        // without one, which is not a property of the lead, just of what the drafter wrote. The
        // host also hides the action-bar button the footer promotes, so on those leads the action
        // had nowhere left to be pressed from. Rendered standalone when there is no sentence: it
        // already carries its own top border and reads as a strip.
        : nextStepFooter(opts && opts.nextStep, esc)}

      ${contactEmail ? `
        <div class="mt-4 pt-3 border-t border-gray-100">
          <p class="text-xs font-bold text-gray-500 tracking-wider uppercase mb-1.5">${sendsOnApproval ? 'Outreach will be sent to' : 'Outreach is addressed to'}</p>
          <p class="text-sm font-semibold text-gray-900 break-all">${esc(contactEmail)}</p>
          ${isPersonalInbox ? `
            <div class="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
              <p class="text-xs font-bold text-amber-900">Personal inbox — check before approving</p>
              <p class="text-xs text-amber-800 mt-0.5">This looks like a named individual rather than a general contact address. ${sendsOnApproval
                ? 'Approving sends the outreach email automatically.'
                : 'Moving it to Outreach records your decision only — the email goes out when you approve it there.'}</p>
            </div>` : ''}
        </div>` : ''}

    `;

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
                    class="btn-primary px-3 py-1.5 border text-xs font-bold rounded-lg transition whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed">
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
                class="btn-utility mt-3 px-3 py-1.5 border text-xs font-bold rounded-lg transition">
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
          class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed shrink-0 whitespace-nowrap">
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
            class="btn-utility mt-3 px-3 py-1.5 border text-xs font-bold rounded-lg transition">
            Copy reply
          </button>
        </div>
      </details>` : ''}

      <div class="flex items-center justify-between gap-3 mt-4 pt-3 border-t border-gray-100">
        <p class="text-xs text-gray-400" data-helpdesk-status>Logs this triage summary as an internal note on the ${isIntercom ? 'conversation' : 'ticket'}.</p>
        <button type="button" data-log-helpdesk
          class="btn-primary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed shrink-0 whitespace-nowrap">
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
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <div class="flex items-start gap-3 mb-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-xl shrink-0">🔀</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">System Routing · Approval needed</p>
          <p class="font-bold text-gray-900 truncate">Hand off to ${esc(targetName)}</p>
        </div>
      </div>

      ${ui.reason ? `
        <p class="text-sm text-gray-700 mb-3"><span class="font-bold text-indigo-900">Why:</span> ${esc(ui.reason)}</p>` : ''}

      <details class="mb-4 group">
        <summary class="text-xs font-bold text-emerald-800 cursor-pointer select-none hover:text-indigo-900">Data that will be passed</summary>
        <pre class="mt-2 bg-white border border-indigo-100 rounded-lg p-3 text-xs text-gray-600 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words">${esc(payloadPreview)}</pre>
      </details>

      <div class="flex items-center gap-2" data-handoff-actions>
        <button type="button" data-handoff-approve
          class="btn-golive px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Approve Handoff
        </button>
        <button type="button" data-handoff-decline
          class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Decline
        </button>
      </div>
      <p class="hidden mt-1 text-xs font-semibold text-emerald-800" data-handoff-status></p>
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
          class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Save this search
        </button>
        <button type="button" data-dcp-decline
          class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
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
  //     maxWorkItems?, endsAt?, rationale?, campaignId?,
  //     orders?: [{ action, assignedRole, quantity?, angle?, audience?, idea?, discoveryCampaignId? }] }
  //
  // Two modes. Without campaignId it saves a NEW draft campaign with its plan attached; with one it
  // files more work for a campaign that already exists. Either way the briefs become a PENDING plan
  // the user approves on the Campaigns tab — the card itself never places an order (§9.1).
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
  // Pictures named on a campaign card (§9.3): [{ id, name }] → only positive integer ids, each with
  // a display name. The SERVER checks every id against the org's own library and reports what it
  // actually attached, so a name here is a label for the user, never the authority.
  function campaignCardAssets(list) {
    return (Array.isArray(list) ? list : [])
      .map((a) => ({ id: Number(a && a.id), name: a && typeof a.name === 'string' ? a.name.trim().slice(0, 80) : '' }))
      .filter((a) => Number.isInteger(a.id) && a.id > 0)
      .slice(0, 30);
  }

  function renderCampaignStrategyProposalCard(ui, esc) {
    const C = window.CampaignConstants;
    // Named for the user, not for the schema. "lead_qualifier" on a card is an internal identifier
    // leaking into a founder's inbox; these match the catalog names in db/seed-catalog.ts.
    const ROLE_LABEL = {
      social_media_manager: 'Social Media Assistant',
      blog_writer: 'Blog Writing Assistant',
      lead_qualifier: 'Lead Generation Assistant',
      newsletter_editor: 'Email Marketing Assistant',
      brand_designer: 'Brand Designer',
      human: 'A person on your team',
    };

    const objective = typeof ui.objective === 'string' ? ui.objective.trim() : '';
    const rationale = typeof ui.rationale === 'string' ? ui.rationale.trim() : '';
    const outcomeMetricRaw = typeof ui.outcomeMetric === 'string' ? ui.outcomeMetric : '';
    const targetValue = Number.isFinite(Number(ui.targetValue)) ? Number(ui.targetValue) : null;
    const maxWorkItems = Number.isFinite(Number(ui.maxWorkItems)) ? Number(ui.maxWorkItems) : null;
    const campaignId = Number.isInteger(Number(ui.campaignId)) && Number(ui.campaignId) > 0 ? Number(ui.campaignId) : null;
    // Who it is for (§9.2). Shown as well as sent: the user is approving an audience, and an
    // audience saved without being seen is a decision made for them.
    const aud = ui.audience && typeof ui.audience === 'object' ? ui.audience : null;
    const persona = aud && typeof aud.persona === 'string' ? aud.persona.trim() : '';
    const audDesc = aud && typeof aud.description === 'string' ? aud.description.trim() : '';
    const excludeDomains = aud && Array.isArray(aud.excludeDomains)
      ? aud.excludeDomains.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim()) : [];
    const tone = typeof ui.tone === 'string' ? ui.tone.trim().slice(0, 300) : '';
    const attach = campaignCardAssets(ui.attachAssets);
    // §9.4. The umbrella is shown by id only on purpose — the card cannot see campaign names, and
    // the server refuses an umbrella that is not this assistant's, or that would nest two deep.
    const parentId = Number.isInteger(Number(ui.parentCampaignId)) && Number(ui.parentCampaignId) > 0 ? Number(ui.parentCampaignId) : null;
    const alwaysOn = ui.alwaysOn === true;
    // The stage (§9.6). An unknown value falls back to the default rather than being shown raw.
    const stage = C && C.funnelStages.indexOf(ui.funnelStage) !== -1 ? ui.funnelStage : (C ? C.defaultFunnelStage : 'conversion');
    // An explicit choice wins; otherwise the stage decides — the same default the server applies
    // (defaultExcludeCustomers): retention is aimed AT customers, everything else leaves them out.
    const excludeCustomers = typeof ui.excludeExistingCustomers === 'boolean'
      ? ui.excludeExistingCustomers : stage !== 'retention';
    // The card shows the outcome the SERVER will save: one the stage allows, else the stage's
    // default (outcomeForStage). Showing the model's choice when the server will replace it would
    // have the user approve a measure the campaign never uses.
    const allowedOutcomes = C ? C.stageOutcomes(stage) : ['leads'];
    const outcomeMetric = allowedOutcomes.indexOf(outcomeMetricRaw) !== -1 ? outcomeMetricRaw : allowedOutcomes[0];
    const outcomeLabel = C ? C.outcomeLabel(outcomeMetric) : outcomeMetric;

    // Only render orders the client can name. An unknown action or role means the model invented
    // one, and listing it would promise the user work no assistant will ever be asked to do.
    //
    // The orders SENT are exactly the orders SHOWN: `raw` rides along with each rendered row, so an
    // order the card hid can never be saved behind the user's back. The server re-validates all of it.
    const actionSpec = (a) => (C && Array.isArray(C.orderActions) ? C.orderActions.find((x) => x.key === a) : null);
    // Which raw items the SERVER will actually place (campaign-plan.ts normalisePlanOrders): one it
    // can name, whose "after" — if any — points backwards at an item that itself survives. Computed
    // once so the list, the "waits until" note and the task total all agree with what approving does.
    const rawOrders = Array.isArray(ui.orders) ? ui.orders : [];
    const survives = [];
    rawOrders.forEach((r, i) => {
      const shown = !!(r && typeof r === 'object' && ROLE_LABEL[r.assignedRole] && actionSpec(r.action));
      const a = Math.floor(Number(r && r.after));
      const waitsBack = Number.isInteger(a) && a >= 1 && a <= i;
      survives.push(shown && (!waitsBack || survives[a - 1]));
    });
    const orders = (Array.isArray(ui.orders) ? ui.orders : [])
      .filter((o) => o && typeof o === 'object' && ROLE_LABEL[o.assignedRole] && actionSpec(o.action))
      .map((o) => {
        const spec = actionSpec(o.action);
        // Same rule as the server's normalisePlanOrders: no quantity means the action's default
        // (four emails, one post), so the card prices exactly what approving will commit.
        const qty = !spec.takesQuantity ? 1
          : Number.isFinite(Number(o.quantity)) && o.quantity !== null && o.quantity !== ''
            ? Math.max(1, Math.min(spec.maxQuantity, Math.floor(Number(o.quantity))))
            : (spec.defaultQuantity || 1);
        const detail = [o.angle, o.idea, o.task, o.hypothesis, o.show, o.headline].find((v) => typeof v === 'string' && v.trim());
        // An A/B test (§9.8) shows BOTH angles — the user is approving a comparison, not one post.
        const testNote = o.action === 'ab_test_posts' && typeof o.angleA === 'string' && typeof o.angleB === 'string'
          ? `A: ${o.angleA.trim()} · B: ${o.angleB.trim()} — per angle, every post still comes to you`
          : '';
        const forWho = typeof o.audience === 'string' && o.audience.trim() ? o.audience.trim() : '';
        // An email order says who gets the emails and that nothing is sent (§9.7) — approving a
        // card that silently meant "email everyone who signs up" would be a decision made for them.
        const emailNote = o.action === 'draft_email_campaign'
          ? (o.emailTrigger === 'custom'
            ? 'Emails you send to a group yourself — saved as drafts, nothing sent'
            : o.emailTrigger === 'form'
              ? 'A follow-up for people who sign up through a form — saved switched off'
              : 'Saved in Email Studio, switched off — nothing is sent until you say')
          : '';
        // Pictures (Brand Designer, Phase 3) say where the choice happens and that AI waits for a
        // click — approving this plan must not read as approving an AI-credit spend.
        const sources = Array.isArray(o.sources) ? o.sources : null;
        const pictureNote = o.action === 'commission_visuals'
          ? `${sources && !sources.some((x) => x === 'ai_image' || x === 'ai_video') ? 'Stock and branded cards, made straight away' : 'Stock and branded cards straight away; AI images and video only when you ask for options on its Briefs tab'} — you choose; the picture joins this campaign`
          : '';
        // A person's task (§9.5) names who, says nothing is sent to them, and shows what waits.
        const humanNote = o.action === 'request_human_task'
          ? `${typeof o.assignee === 'string' && o.assignee.trim() ? o.assignee.trim() : 'Someone on your team'}${typeof o.dueDate === 'string' && o.dueDate ? ` · due ${o.dueDate}` : ''} — you tell them; nothing is sent${o.fileIn === 'jira' || o.fileIn === 'asana' ? ` · also filed as a ${o.fileIn === 'jira' ? 'Jira' : 'Asana'} ticket` : ''}`
          : '';
        // Named, not numbered: the card hides items it cannot show, so a bare "item 4" would not
        // match anything the user can see. Same positions as the server (raw list, backwards only).
        const rawIdx = rawOrders.indexOf(o);
        const skipped = !survives[rawIdx];
        const afterN = Math.floor(Number(o.after));
        const prereq = Number.isInteger(afterN) && afterN >= 1 && afterN <= rawIdx ? rawOrders[afterN - 1] : null;
        const afterNote = skipped
          ? 'Waits for something that cannot be done, so it will be skipped'
          : prereq
            ? `Waits until: ${actionSpec(prereq.action).label}${typeof prereq.assignee === 'string' && prereq.assignee ? ` (${prereq.assignee})` : ''}`
            : '';
        return {
          raw: o,
          label: spec.label,
          role: ROLE_LABEL[o.assignedRole],
          qty: qty > 1 ? qty : null,
          detail: detail ? String(detail).trim() : '',
          forWho,
          emailNote,
          pictureNote,
          humanNote,
          testNote,
          afterNote,
          skipped,
          tasks: (spec.workItemsPerUnit || 0) * qty,
        };
      });
    // Skipped items are listed (so the user sees them) but neither priced nor sent.
    const planTasks = orders.reduce((n, o) => n + (o.skipped ? 0 : o.tasks), 0);
    // What is SENT: only the items that survive, with each "after" rewritten from the model's raw
    // position to the position in THIS list. Sending the raw "after" against a filtered list would
    // point every later item at the wrong one — the server counts positions in what it receives.
    const sentPosByRaw = new Map();
    const sendOrders = [];
    orders.forEach((o) => {
      if (o.skipped) return;
      const rawIdx = rawOrders.indexOf(o.raw);
      const a = Math.floor(Number(o.raw.after));
      const copy = Object.assign({}, o.raw);
      delete copy.after;
      if (Number.isInteger(a) && a >= 1 && a <= rawIdx && sentPosByRaw.has(a)) copy.after = sentPosByRaw.get(a);
      sendOrders.push(copy);
      sentPosByRaw.set(rawIdx + 1, sendOrders.length);
    });

    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <div class="flex items-start gap-3 mb-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-xl shrink-0">🎯</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">${campaignId ? 'More work for a campaign' : 'Campaign plan'} · Approval needed</p>
          <p class="font-bold text-gray-900 break-words">${esc(objective || 'Untitled campaign')}</p>
        </div>
      </div>

      ${rationale ? `
        <p class="text-sm text-gray-700 mb-3"><span class="font-bold text-indigo-900">Why:</span> ${esc(rationale)}</p>` : ''}

      ${!campaignId ? `
        <p class="text-sm text-gray-700 mb-1"><span class="font-bold text-indigo-900">Stage:</span>
          ${esc(C ? C.stageLabel(stage) : stage)}${C && C.stageDescription(stage) ? ` — ${esc(C.stageDescription(stage).toLowerCase())}` : ''}</p>
        <p class="text-sm text-gray-700 mb-1 break-words"><span class="font-bold text-indigo-900">For:</span>
          ${persona || audDesc ? `${esc(persona)}${persona && audDesc ? ' — ' : ''}${esc(audDesc)}` : '<span class="text-amber-700">no audience given yet</span>'}</p>
        ${tone ? `<p class="text-sm text-gray-700 mb-1 break-words"><span class="font-bold text-indigo-900">Tone:</span> ${esc(tone)}</p>` : ''}
        ${alwaysOn ? '<p class="text-sm text-gray-700 mb-1"><span class="font-bold text-indigo-900">Always on</span> — business as usual, no end date</p>' : ''}
        <p class="text-sm text-gray-700 mb-1"><span class="font-bold text-indigo-900">Your usual posts</span> — social: ${escapeHtml(USUAL_POSTING_WORDS[(usualPostingOf(ui) || {}).social || 'make_way'])}; articles: ${escapeHtml(USUAL_POSTING_WORDS[(usualPostingOf(ui) || {}).blog || 'make_way'])}</p>
        ${parentId ? `<p class="text-sm text-gray-700 mb-1"><span class="font-bold text-indigo-900">Inside umbrella:</span> campaign #${esc(String(parentId))}</p>` : ''}
        ${attach.length ? `<p class="text-sm text-gray-700 mb-1 break-words"><span class="font-bold text-indigo-900">Pictures:</span> ${esc(attach.map((a) => a.name || `#${a.id}`).join(', '))}</p>` : ''}
        <p class="text-xs mb-3 ${excludeCustomers ? 'text-gray-600' : 'text-amber-700 font-bold'}">
          ${excludeCustomers
            ? `Leaves out companies you have marked as won${excludeDomains.length ? `, plus ${esc(String(excludeDomains.length))} more you named` : ''}.`
            : 'Includes your existing customers — for a campaign aimed at them.'}
        </p>` : ''}

      ${orders.length ? `
        <p class="text-xs font-bold text-indigo-700 uppercase tracking-wide mb-1">Who I'd brief</p>
        <ul class="mb-3 space-y-1">
          ${orders.map((o) => `
            <li class="text-xs text-gray-600">• ${esc(o.label)}${o.qty ? ` ×${esc(String(o.qty))}` : ''} — ${esc(o.role)}${o.detail ? `<span class="block pl-3 text-gray-500 italic break-words">${esc(o.detail)}</span>` : ''}${o.forWho ? `<span class="block pl-3 text-gray-500 break-words">For: ${esc(o.forWho)}</span>` : ''}${o.emailNote ? `<span class="block pl-3 text-gray-500 break-words">${esc(o.emailNote)}</span>` : ''}${o.pictureNote ? `<span class="block pl-3 text-gray-500 break-words">${esc(o.pictureNote)}</span>` : ''}${o.humanNote ? `<span class="block pl-3 text-gray-500 break-words">${esc(o.humanNote)}</span>` : ''}${o.testNote ? `<span class="block pl-3 text-gray-500 break-words">${esc(o.testNote)}</span>` : ''}${o.afterNote ? `<span class="block pl-3 text-gray-500">${esc(o.afterNote)}</span>` : ''}</li>
          `).join('')}
        </ul>` : ''}

      <ul class="mb-4 space-y-1">
        ${campaignId ? '' /* the campaign's own measure is not on the wire — a default here would misstate it */ : `<li class="text-xs text-gray-600">• Counts ${esc(String(outcomeLabel).toLowerCase())}${targetValue ? `, aiming for ${esc(String(targetValue))}` : ''}</li>`}
        ${!campaignId && maxWorkItems ? `<li class="text-xs text-gray-600">• Uses at most ${esc(String(maxWorkItems))} tasks from your monthly allowance</li>` : ''}
        ${planTasks ? `<li class="text-xs text-gray-600">• ${campaignId ? 'These briefs use' : 'The first briefs use'} ${esc(String(planTasks))} tasks from your monthly allowance</li>` : ''}
        <li class="text-xs text-gray-600">• Nothing is briefed until you approve the plan on the Campaigns tab</li>
        <li class="text-xs text-gray-600">• You approve every piece of work before it goes out</li>
      </ul>

      <div class="flex items-center gap-2" data-csp-actions>
        <button type="button" data-csp-approve
          class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          ${campaignId ? 'Save this plan' : 'Save this campaign'}
        </button>
        <button type="button" data-csp-decline
          class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
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
      if (campaignId) {
        if (!orders.length) {
          setBusy(true);
          say('This plan has no work an assistant can do, so there is nothing to save.', 'error');
          return;
        }
        setBusy(true);
        say('Saving…');
        el.dispatchEvent(new CustomEvent('campaign:proposePlan', {
          bubbles: true,
          detail: {
            campaignId,
            orders: sendOrders,
            respond({ ok, error }) {
              if (ok) {
                say('Plan saved — approve it on that campaign in your Campaigns tab to brief your assistants.');
                return;
              }
              setBusy(false);
              say(error || 'Could not save that plan — please try again.', 'error');
            },
          },
        }));
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
          audience: aud ? { persona, description: audDesc, excludeDomains } : null,
          funnelStage: stage,
          tone: tone || null,
          attachAssetIds: attach.map((a) => a.id),
          parentCampaignId: parentId,
          alwaysOn,
          usualPosting: usualPostingOf(ui),
          // Always-on campaigns have no end date — never send one alongside.
          ...(alwaysOn ? { endsAt: null } : {}),
          excludeExistingCustomers: excludeCustomers,
          orders: sendOrders,
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
                : (orders.length
                  ? 'Saved as a draft with its plan — press "Approve plan & start" on it in your Campaigns tab to begin.'
                  : 'Saved as a draft — press "Start" on it in your Campaigns tab to begin.'));
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

  // ── Built-in: Campaign Edit Proposal Card ───────────────────────────────────
  // { type: 'campaign_edit_proposal', campaignId, objective?, outcomeMetric?, targetValue?, endsAt? }
  //
  // The chat twin of the row's "Edit" button (§9.0 — every capability is reachable both ways).
  // ⚠️ It carries NO budget field and never will: a chat turn may not raise a ceiling (§1.3), and
  // campaigns.ts refuses budget fields on the viaChat path even if a crafted card sent them.
  function renderCampaignEditProposalCard(ui, esc) {
    const C = window.CampaignConstants;
    const campaignId = Number.isInteger(Number(ui.campaignId)) && Number(ui.campaignId) > 0 ? Number(ui.campaignId) : null;
    const changes = {};
    const rows = [];
    if (typeof ui.objective === 'string' && ui.objective.trim()) {
      changes.objective = ui.objective.trim();
      rows.push(['Objective', changes.objective]);
    }
    if (C && C.funnelStages.indexOf(ui.funnelStage) !== -1) {
      changes.funnelStage = ui.funnelStage;
      rows.push(['Stage', C.stageLabel(ui.funnelStage)]);
    }
    if (typeof ui.outcomeMetric === 'string' && C && C.selectableOutcomes.indexOf(ui.outcomeMetric) !== -1) {
      changes.outcomeMetric = ui.outcomeMetric;
      rows.push(['Counts', C.outcomeLabel(ui.outcomeMetric)]);
    }
    if (Number.isFinite(Number(ui.targetValue)) && Number(ui.targetValue) > 0) {
      changes.targetValue = Math.floor(Number(ui.targetValue));
      rows.push(['Aiming for', String(changes.targetValue)]);
    }
    if (typeof ui.endsAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ui.endsAt)) {
      changes.endsAt = ui.endsAt;
      rows.push(['Ends', ui.endsAt]);
    }
    const a = ui.audience && typeof ui.audience === 'object' ? ui.audience : null;
    if (a) {
      const persona = typeof a.persona === 'string' ? a.persona.trim() : '';
      const description = typeof a.description === 'string' ? a.description.trim() : '';
      const excludeDomains = Array.isArray(a.excludeDomains) ? a.excludeDomains.filter((d) => typeof d === 'string' && d.trim()) : [];
      if (persona || description || excludeDomains.length) {
        changes.audience = { persona, description, excludeDomains };
        if (persona || description) rows.push(['For', `${persona}${persona && description ? ' — ' : ''}${description}`]);
        // The server MERGES these on the chat path, so the card says "also" — it never replaces
        // the list the user typed on the tab.
        if (excludeDomains.length) rows.push(['Also leave out', excludeDomains.join(', ')]);
      }
    }
    if (typeof ui.tone === 'string' && ui.tone.trim()) {
      changes.tone = ui.tone.trim().slice(0, 300);
      rows.push(['Tone', changes.tone]);
    }
    const addPics = campaignCardAssets(ui.attachAssets);
    const removePics = campaignCardAssets(ui.detachAssets);
    if (addPics.length) {
      changes.attachAssetIds = addPics.map((a) => a.id);
      rows.push(['Add pictures', addPics.map((a) => a.name || `#${a.id}`).join(', ')]);
    }
    if (removePics.length) {
      changes.detachAssetIds = removePics.map((a) => a.id);
      rows.push(['Remove pictures', removePics.map((a) => a.name || `#${a.id}`).join(', ')]);
    }
    if (ui.parentCampaignId !== undefined && ui.parentCampaignId !== null && Number.isInteger(Number(ui.parentCampaignId)) && Number(ui.parentCampaignId) >= 0) {
      changes.parentCampaignId = Number(ui.parentCampaignId);
      rows.push(['Umbrella', changes.parentCampaignId ? `inside campaign #${changes.parentCampaignId}` : 'taken out of its umbrella']);
    }
    if (typeof ui.alwaysOn === 'boolean') {
      changes.alwaysOn = ui.alwaysOn;
      rows.push(['Always on', ui.alwaysOn ? 'yes — no end date' : 'no']);
    }
    const usual = usualPostingOf(ui);
    if (usual) {
      changes.usualPosting = usual;
      if (usual.social) rows.push(['Usual social posts', USUAL_POSTING_WORDS[usual.social]]);
      if (usual.blog) rows.push(['Usual articles', USUAL_POSTING_WORDS[usual.blog]]);
    }
    // Only ever ON from a card (§9.0). A card carrying false shows nothing and sends nothing.
    if (ui.excludeExistingCustomers === true) {
      changes.excludeExistingCustomers = true;
      rows.push(['Existing customers', 'left out of lead searches']);
    }

    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <div class="flex items-start gap-3 mb-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-xl shrink-0">✏️</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Change a campaign · Approval needed</p>
          <p class="font-bold text-gray-900">Proposed changes</p>
        </div>
      </div>
      ${rows.length ? `
        <ul class="mb-4 space-y-1">
          ${rows.map(([k, v]) => `<li class="text-xs text-gray-600 break-words"><span class="font-bold text-gray-700">${esc(k)}:</span> ${esc(v)}</li>`).join('')}
        </ul>` : '<p class="text-xs text-gray-500 mb-4">There is nothing here to change.</p>'}
      <div class="flex items-center gap-2">
        <button type="button" data-cep-approve ${rows.length && campaignId ? '' : 'disabled'}
          class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Save these changes
        </button>
        <button type="button" data-cep-decline
          class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Not now
        </button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-cep-status></p>
    `;

    const status = el.querySelector('[data-cep-status]');
    function say(text, tone) {
      status.textContent = text;
      status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`;
    }
    function setBusy(busy) {
      el.querySelectorAll('[data-cep-approve], [data-cep-decline]').forEach((b) => { b.disabled = busy; });
    }

    el.addEventListener('click', (e) => {
      const approve = e.target.closest('[data-cep-approve]');
      const decline = e.target.closest('[data-cep-decline]');
      if (!approve && !decline) return;
      setBusy(true);
      if (decline) { say('Left as it is.'); return; }
      say('Saving…');
      el.dispatchEvent(new CustomEvent('campaign:edit', {
        bubbles: true,
        detail: {
          campaignId,
          changes,
          respond({ ok, error }) {
            if (ok) { say('Saved — the campaign in your Campaigns tab now shows these changes.'); return; }
            setBusy(false);
            say(error || 'Could not save those changes — please try again.', 'error');
          },
        },
      }));
    });

    return el;
  }

  register('campaign_edit_proposal', renderCampaignEditProposalCard);

  // ── Built-in: Campaign Task Update Card ─────────────────────────────────────
  // { type: 'campaign_task_update', orderId, outcome: 'done'|'wont_happen', note? }
  //
  // The chat twin of a task's "Mark done" / "Won't happen" buttons on the Campaigns tab (§9.0).
  // The user confirms on the card; the click performs campaigns.ts complete_task. "Won't happen"
  // says outright that it cancels the work waiting on the task — that is the consequence the user
  // is approving.
  function renderCampaignTaskUpdateCard(ui, esc) {
    const orderId = Number.isInteger(Number(ui.orderId)) && Number(ui.orderId) > 0 ? Number(ui.orderId) : null;
    const outcome = ui.outcome === 'wont_happen' ? 'wont_happen' : 'done';
    const note = typeof ui.note === 'string' ? ui.note.trim().slice(0, 280) : '';
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Campaign task · Confirm</p>
      <p class="font-bold text-gray-900 mt-1">${outcome === 'done' ? 'Mark this task done' : 'This task will not happen'}</p>
      ${note ? `<p class="text-sm text-gray-700 mt-1 break-words">${esc(note)}</p>` : ''}
      <p class="text-xs text-gray-600 mt-2">${outcome === 'done'
        ? 'Any work that was waiting for it starts now.'
        : 'Any work that was waiting for it is cancelled.'}</p>
      <div class="flex items-center gap-2 mt-3">
        <button type="button" data-ctu-confirm ${orderId ? '' : 'disabled'}
          class="${outcome === 'done' ? 'btn-primary' : 'btn-destructive'} px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          ${outcome === 'done' ? 'Mark done' : 'Confirm'}
        </button>
        <button type="button" data-ctu-cancel
          class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Not yet</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-ctu-status></p>`;
    const status = el.querySelector('[data-ctu-status]');
    const say = (text, tone) => {
      status.textContent = text;
      status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`;
    };
    const setBusy = (b) => el.querySelectorAll('[data-ctu-confirm], [data-ctu-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      const confirm = e.target.closest('[data-ctu-confirm]');
      const cancel = e.target.closest('[data-ctu-cancel]');
      if (!confirm && !cancel) return;
      setBusy(true);
      if (cancel) { say('Left open.'); return; }
      say('Saving…');
      el.dispatchEvent(new CustomEvent('campaign:taskUpdate', {
        bubbles: true,
        detail: {
          orderId, outcome, note,
          respond({ ok, error }) {
            if (ok) { say(outcome === 'done' ? 'Done — your Campaigns tab shows it.' : 'Recorded — your Campaigns tab shows it.'); return; }
            setBusy(false);
            say(error || 'Could not save that — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('campaign_task_update', renderCampaignTaskUpdateCard);

  // ── Built-in: Campaign Learning Proposal Card ───────────────────────────────
  // { type: 'campaign_learning_proposal', campaignId?, text, applyToDrafting? }
  //
  // The chat twin of "Keep" on a campaign's Summary (§9.8). The user can untick "also apply to
  // drafting" before saving — that part turns the lesson into a rule on other assistants, and the
  // card says so and says where to remove it.
  function renderCampaignLearningProposalCard(ui, esc) {
    const text = typeof ui.text === 'string' ? ui.text.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const campaignId = Number.isInteger(Number(ui.campaignId)) && Number(ui.campaignId) > 0 ? Number(ui.campaignId) : null;
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Keep a lesson · Approval needed</p>
      <p class="text-sm text-gray-900 mt-2 break-words">${text ? esc(text) : '<span class="text-amber-700">No lesson was written.</span>'}</p>
      ${campaignId ? `
        <label class="flex items-start gap-2 text-xs text-gray-700 mt-3">
          <input type="checkbox" data-clp-apply ${ui.applyToDrafting === true ? 'checked' : ''} class="mt-0.5">
          <span>Also make it a rule for the writing assistants this campaign briefed. You can remove it from each assistant's Do’s and don’ts card.</span>
        </label>` : ''}
      <p class="text-xs text-gray-600 mt-2">Your Campaign Assistant reads kept lessons whenever it plans a campaign.</p>
      <div class="flex items-center gap-2 mt-3">
        <button type="button" data-clp-save ${text ? '' : 'disabled'}
          class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Keep this lesson</button>
        <button type="button" data-clp-cancel
          class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-clp-status></p>`;
    const status = el.querySelector('[data-clp-status]');
    const say = (t, tone) => {
      status.textContent = t;
      status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`;
    };
    const setBusy = (b) => el.querySelectorAll('[data-clp-save], [data-clp-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      const save = e.target.closest('[data-clp-save]');
      const cancel = e.target.closest('[data-clp-cancel]');
      if (!save && !cancel) return;
      setBusy(true);
      if (cancel) { say('Not kept.'); return; }
      const apply = !!el.querySelector('[data-clp-apply]')?.checked;
      say('Saving…');
      el.dispatchEvent(new CustomEvent('campaign:saveLearning', {
        bubbles: true,
        detail: {
          campaignId, text, applyToDrafting: apply,
          respond({ ok, error, appliedTo }) {
            if (ok) {
              const n = Array.isArray(appliedTo) ? appliedTo.length : 0;
              say(apply
                ? (n ? `Kept, and added as a rule for ${n} ${n === 1 ? 'assistant' : 'assistants'}.` : 'Kept. No writing assistant was briefed by that campaign, so no rule was added.')
                : 'Kept — your Campaign Assistant will plan with it.');
              return;
            }
            setBusy(false);
            say(error || 'Could not save that — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('campaign_learning_proposal', renderCampaignLearningProposalCard);

  // ── Built-in: Visual Brief Proposal Card (Brand Designer) ──────────────────
  // { type: 'visual_brief_proposal', title, message?, headline?, mood?, mustInclude?, mustAvoid?,
  //   purpose?, aspectRatio?, sources?: string[], dueDate? }
  //
  // The chat twin of "New brief" on the Briefs tab — same server action (brand-briefs.ts create).
  // ⚠️ A card may only MAKE OPTIONS when every source is free. A brief that includes AI images is
  // saved here and its round is started on the Briefs tab, where the button states the credit cost:
  // a chat turn never spends (the Campaign Assistant's rule, and the user's).
  function renderVisualBriefProposalCard(ui, esc) {
    const clean = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    const brief = {
      title: clean(ui.title, 120), message: clean(ui.message, 1000), headline: clean(ui.headline, 120),
      mood: clean(ui.mood, 300), mustInclude: clean(ui.mustInclude, 500), mustAvoid: clean(ui.mustAvoid, 500),
      purpose: clean(ui.purpose, 40), aspectRatio: clean(ui.aspectRatio, 8),
      sources: Array.isArray(ui.sources) ? ui.sources.filter((x) => ['stock', 'ai_image', 'brand_card', 'stock_video', 'ai_video'].includes(x)) : ['stock', 'ai_image', 'brand_card'],
      waitingOn: clean(ui.waitingOn, 120),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(ui.dueDate || '')) ? String(ui.dueDate) : '',
    };
    if (!brief.sources.length) brief.sources = ['stock', 'brand_card'];
    // Free = no AI image AND no AI video (PAID_SOURCES in visual-brief-vocab.ts).
    const free = !brief.sources.some((x) => x === 'ai_image' || x === 'ai_video');
    const SOURCE = { stock: 'Stock photos', ai_image: 'AI images', brand_card: 'Branded cards', stock_video: 'Stock videos', ai_video: 'AI video' };
    const row = (label, v) => (v ? `<p class="text-xs text-gray-700 mt-1"><span class="font-bold">${label}:</span> ${esc(v)}</p>` : '');
    const runnable = !!brief.title && !!(brief.message || brief.headline);
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">New brief · Approval needed</p>
      <p class="text-sm font-bold text-gray-900 mt-2 break-words">${brief.title ? esc(brief.title) : '<span class="text-amber-700">No name was given.</span>'}</p>
      ${row('Shows', brief.message)}
      ${row('Words on the card', brief.headline)}
      ${row('Mood', brief.mood)}
      ${row('Must include', brief.mustInclude)}
      ${row('Must avoid', brief.mustAvoid)}
      ${row('Shape', brief.aspectRatio)}
      ${row('Due', brief.dueDate)}
      ${row('Someone on your team is making it', brief.waitingOn)}
      <p class="text-xs text-gray-700 mt-1"><span class="font-bold">Options from:</span> ${brief.sources.map((x) => esc(SOURCE[x])).join(', ')}</p>
      <p class="text-xs text-gray-600 mt-2">${free
        ? 'Stock and branded cards are free. Nothing is used anywhere until you approve it.'
        : 'Saved to your Briefs tab. Ask for options there — the cost of any AI images or video is shown before anything is spent.'}</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${free ? `<button type="button" data-vbp-save="generate" ${runnable ? '' : 'disabled'} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Save and make options</button>` : ''}
        <button type="button" data-vbp-save="save" ${runnable ? '' : 'disabled'} class="${free ? 'btn-secondary border' : 'btn-primary'} px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Save brief</button>
        <button type="button" data-vbp-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-vbp-status></p>`;
    const status = el.querySelector('[data-vbp-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      const save = e.target.closest('[data-vbp-save]');
      if (e.target.closest('[data-vbp-cancel]')) { setBusy(true); say('Not saved.'); return; }
      if (!save) return;
      setBusy(true);
      const generate = save.dataset.vbpSave === 'generate' && free;
      say(generate ? 'Saving and starting…' : 'Saving…');
      el.dispatchEvent(new CustomEvent('brief:create', {
        bubbles: true,
        detail: {
          brief, generate,
          respond({ ok, error, roundStarted }) {
            if (!ok) { setBusy(false); say(error || 'Could not save that — please try again.', 'error'); return; }
            say(generate && roundStarted
              ? 'Saved. Options are being made — they appear on the Briefs tab in about a minute.'
              : (error ? `Saved, but options could not start: ${error}` : 'Saved to your Briefs tab.'));
          },
        },
      }));
    });
    return el;
  }

  register('visual_brief_proposal', renderVisualBriefProposalCard);

  // ── Built-ins: Video Producer cards (docs/video-producer-plan.md §5.10) ─────────────────────
  // { type: 'video_brief_proposal', message, purpose?, lengthS?, cta?, voiceover?, allowAi?, platforms? }
  // { type: 'video_replan_proposal', projectId, feedback? }
  //
  // The chat twins of "New video" and "Plan it again" on the Videos tab — the same video-projects.ts
  // actions. Both are FREE (planning is one model call). Making the video spends credits, so no card
  // can do it: that is "Make the video" on the Videos tab, which states the cost first.
  function renderVideoBriefProposalCard(ui, esc) {
    const clean = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    const PLATFORMS = { instagram: 'Instagram Reel', youtube: 'YouTube Short', facebook: 'Facebook Reel' };
    const ALLOW = { stock_and_ai: 'Stock first, AI where it fits', stock_only: 'Stock and your own pictures only', ai_first: 'Leans on AI' };
    const brief = {
      message: clean(ui.message, 1200),
      purpose: clean(ui.purpose, 60) || 'promo',
      lengthS: [15, 30, 60].includes(Number(ui.lengthS)) ? Number(ui.lengthS) : 30,
      cta: clean(ui.cta, 200),
      voiceover: ui.voiceover !== false,
      allowAi: ALLOW[ui.allowAi] ? ui.allowAi : 'stock_and_ai',
      platforms: (Array.isArray(ui.platforms) ? ui.platforms : ['instagram']).filter((p) => PLATFORMS[p]),
    };
    if (!brief.platforms.length) brief.platforms = ['instagram'];
    const row = (label, v) => (v ? `<p class="text-xs text-gray-700 mt-1"><span class="font-bold">${label}:</span> ${esc(v)}</p>` : '');
    const runnable = brief.message.length >= 10;
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">New video · Approval needed</p>
      <p class="text-sm text-gray-900 mt-2 break-words">${runnable ? esc(brief.message) : '<span class="text-amber-700">It needs a sentence or two on what the video is about.</span>'}</p>
      ${row('Length', `${brief.lengthS} seconds`)}
      ${row('Kind', brief.purpose)}
      ${row('Ends with', brief.cta)}
      ${row('Voiceover', brief.voiceover ? 'Yes, with captions' : 'No — on-screen text only')}
      ${row('Pictures from', ALLOW[brief.allowAi])}
      ${row('For', brief.platforms.map((p) => PLATFORMS[p]).join(', '))}
      <p class="text-xs text-gray-600 mt-2">Planning the storyboard is free. You check it on the Videos tab before anything is made — the cost of making it is shown there first.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-vdp-save ${runnable ? '' : 'disabled'} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Plan this video</button>
        <button type="button" data-vdp-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-vdp-status></p>`;
    const status = el.querySelector('[data-vdp-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-vdp-cancel]')) { setBusy(true); say('Not planned.'); return; }
      if (!e.target.closest('[data-vdp-save]')) return;
      setBusy(true);
      say('Starting the storyboard…');
      el.dispatchEvent(new CustomEvent('video:create', {
        bubbles: true,
        detail: {
          brief,
          respond({ ok, error }) {
            if (!ok) { setBusy(false); say(error || 'Could not start that — please try again.', 'error'); return; }
            say('Started. The storyboard appears on the Videos tab in about a minute.');
          },
        },
      }));
    });
    return el;
  }

  function renderVideoReplanProposalCard(ui, esc) {
    const projectId = Number(ui.projectId);
    const feedback = typeof ui.feedback === 'string' ? ui.feedback.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
    const ok = Number.isInteger(projectId) && projectId > 0;
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Plan the video again · Approval needed</p>
      ${feedback ? `<p class="text-xs text-gray-700 mt-2"><span class="font-bold">Your notes:</span> ${esc(feedback)}</p>` : ''}
      <p class="text-xs text-gray-600 mt-2">Free. The new storyboard replaces the current one, and any scenes already made for it are dropped.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-vrp-go ${ok ? '' : 'disabled'} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Plan it again</button>
        <button type="button" data-vrp-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-vrp-status></p>`;
    const status = el.querySelector('[data-vrp-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-vrp-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-vrp-go]')) return;
      setBusy(true);
      say('Re-planning…');
      el.dispatchEvent(new CustomEvent('video:replan', {
        bubbles: true,
        detail: {
          projectId, feedback,
          respond({ ok: done, error }) {
            if (!done) { setBusy(false); say(error || 'Could not re-plan that — please try again.', 'error'); return; }
            say('Re-planning. The new storyboard appears on the Videos tab in about a minute.');
          },
        },
      }));
    });
    return el;
  }

  register('video_brief_proposal', renderVideoBriefProposalCard);
  register('video_replan_proposal', renderVideoReplanProposalCard);

  // ── Built-ins: Mystery Shopper cards (docs/mystery-shopper-plan.md §4.6) ──────────────────────
  // The chat twins of the Website tab's buttons — same server actions (site-audits.ts), handled in
  // chat-session.js. Each writes only on the user's click; a check that re-scores spends a task and
  // the card says so before it is pressed.

  // { type: 'site_audit_check' }
  function renderSiteAuditCheckCard(ui, esc) {
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Website check</p>
      <p class="text-sm text-gray-800 mt-2">Read your website again now and re-score it.</p>
      <p class="text-xs text-gray-600 mt-2">If nothing on your site or your competitors' sites has changed, the last score stands and nothing is used. A check that re-scores uses 1 task from your monthly allowance.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-sac-run class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Check my site now</button>
        <button type="button" data-sac-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-sac-status></p>`;
    const status = el.querySelector('[data-sac-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-sac-cancel]')) { setBusy(true); say('Not checked.'); return; }
      if (!e.target.closest('[data-sac-run]')) return;
      setBusy(true);
      say('Starting…');
      el.dispatchEvent(new CustomEvent('siteaudit:check', {
        bubbles: true,
        detail: {
          respond({ ok, error, alreadyRunning }) {
            if (!ok) { setBusy(false); say(error || 'Could not start the check — please try again.', 'error'); return; }
            say(alreadyRunning ? 'A check is already running — the result appears on the Website tab.' : 'Checking your site — the result appears on the Website tab in a minute or two.');
          },
        },
      }));
    });
    return el;
  }
  register('site_audit_check', renderSiteAuditCheckCard);

  // { type: 'site_audit_settings', url?, icp?, conversionGoal?, competitorUrls?, checkWeekday? }
  // Only the fields present are sent, so a card that changes the competitors cannot blank the rest.
  function renderSiteAuditSettingsCard(ui, esc) {
    const clean = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const change = {};
    if (clean(ui.url, 500)) change.url = clean(ui.url, 500);
    if (clean(ui.icp, 400)) change.icp = clean(ui.icp, 400);
    if (clean(ui.conversionGoal, 200)) change.conversionGoal = clean(ui.conversionGoal, 200);
    if (Array.isArray(ui.competitorUrls)) change.competitorUrls = ui.competitorUrls.map((x) => clean(x, 500)).filter(Boolean).slice(0, 3);
    const wd = Number(ui.checkWeekday);
    if (ui.checkWeekday !== undefined && ui.checkWeekday !== null && Number.isInteger(wd) && wd >= 0 && wd <= 6) change.checkWeekday = wd;
    const row = (label, v) => `<p class="text-xs text-gray-700 mt-1"><span class="font-bold">${label}:</span> ${v}</p>`;
    const rows = [
      change.url !== undefined ? row('Website', esc(change.url)) : '',
      change.icp !== undefined ? row('Who it is for', esc(change.icp)) : '',
      change.conversionGoal !== undefined ? row('Visitors should', esc(change.conversionGoal)) : '',
      change.competitorUrls !== undefined ? row('Competitors', change.competitorUrls.length ? change.competitorUrls.map(esc).join(', ') : 'none') : '',
      change.checkWeekday !== undefined ? row('Weekly check', esc(DAYS[change.checkWeekday])) : '',
    ].join('');
    const any = Object.keys(change).length > 0;
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Website check settings · Approval needed</p>
      ${any ? rows : '<p class="text-xs text-amber-700 mt-2">Nothing to change was given.</p>'}
      <p class="text-xs text-gray-600 mt-2">Saved to the Website tab. If this is the first time your website is saved, its first check starts straight away (1 task).</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-sas-save ${any ? '' : 'disabled'} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Save</button>
        <button type="button" data-sas-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-sas-status></p>`;
    const status = el.querySelector('[data-sas-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-sas-cancel]')) { setBusy(true); say('Not saved.'); return; }
      if (!e.target.closest('[data-sas-save]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('siteaudit:save', {
        bubbles: true,
        detail: {
          change,
          respond({ ok, error, started }) {
            if (!ok) { setBusy(false); say(error || 'Could not save that — please try again.', 'error'); return; }
            say(started ? 'Saved. Your first check has started — the result appears on the Website tab.' : 'Saved.');
          },
        },
      }));
    });
    return el;
  }
  register('site_audit_settings', renderSiteAuditSettingsCard);

  // { type: 'site_audit_fix_update', decisions: [{ fixId, status: 'accepted'|'dismissed'|'open'|'done' }] }
  // "done" is the user's "I've made this change"; a later check confirms it (site-audits.ts).
  function renderSiteAuditFixUpdateCard(ui, esc) {
    const WORDS = { accepted: "I'll make this change", dismissed: 'Reject', open: 'Undecided again', done: "I've made this change" };
    const decisions = (Array.isArray(ui.decisions) ? ui.decisions : [])
      .map((d) => ({ fixId: Number(d && d.fixId), status: d && d.status }))
      .filter((d) => Number.isInteger(d.fixId) && d.fixId > 0 && Object.prototype.hasOwnProperty.call(WORDS, d.status))
      .slice(0, 10);
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Suggested fixes · Approval needed</p>
      ${decisions.length
        ? `<ul class="mt-2 space-y-1">${decisions.map((d) => `<li class="text-xs text-gray-800">Fix ${esc(d.fixId)}: <span class="font-bold">${esc(WORDS[d.status])}</span></li>`).join('')}</ul>`
        : '<p class="text-xs text-amber-700 mt-2">No fixes were named.</p>'}
      <p class="text-xs text-gray-600 mt-2">The next check confirms each change once it finds it on your site.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-safu-confirm ${decisions.length ? '' : 'disabled'} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Confirm</button>
        <button type="button" data-safu-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-safu-status></p>`;
    const status = el.querySelector('[data-safu-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-safu-cancel]')) { setBusy(true); say('Nothing changed.'); return; }
      if (!e.target.closest('[data-safu-confirm]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('siteaudit:fix', {
        bubbles: true,
        detail: {
          decisions,
          respond({ results }) {
            const failed = (results || []).filter((r) => !r.ok);
            if (!failed.length) { say('Done — the Website tab is up to date.'); return; }
            say(`${(results || []).length - failed.length} saved; ${failed.map((f) => `fix ${f.fixId}: ${f.error}`).join('; ')}`, 'error');
          },
        },
      }));
    });
    return el;
  }
  register('site_audit_fix_update', renderSiteAuditFixUpdateCard);

  // { type: 'site_audit_handoff', target: 'social_media_manager'|'blog_writer'|'campaign_orchestrator', title?, brief }
  // Opens the target assistant's chat with the brief TYPED IN — the user reads it and sends it. The
  // same as "Brief <name>" under "Ideas for your other assistants" on the Website tab.
  function renderSiteAuditHandoffCard(ui, esc) {
    const TARGETS = { social_media_manager: 'Social Media Assistant', blog_writer: 'Blog Writing Assistant', campaign_orchestrator: 'Campaign Assistant' };
    const target = Object.prototype.hasOwnProperty.call(TARGETS, ui.target) ? ui.target : null;
    const clean = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    const brief = clean(ui.brief, 800);
    const title = clean(ui.title, 80);
    const label = target ? ((window.RoleLabels && window.RoleLabels.get && window.RoleLabels.get(target)) || TARGETS[target]) : '';
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Brief for your ${esc(label || 'other assistant')}</p>
      ${title ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(title)}</p>` : ''}
      <p class="text-xs text-gray-700 mt-1">${brief ? esc(brief) : '<span class="text-amber-700">No brief was given.</span>'}</p>
      <p class="text-xs text-gray-600 mt-2">Opens their chat with this typed in. Nothing is sent until you send it.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-sah-open ${target && brief ? '' : 'disabled'} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Open their chat</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-sah-status></p>`;
    const status = el.querySelector('[data-sah-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sah-open]');
      if (!btn) return;
      btn.disabled = true;
      el.dispatchEvent(new CustomEvent('siteaudit:handoff', {
        bubbles: true,
        detail: {
          target, brief, title,
          respond({ ok, error }) {
            btn.disabled = false;
            if (!ok) say(error || 'Could not open their chat.', 'error');
          },
        },
      }));
    });
    return el;
  }
  register('site_audit_handoff', renderSiteAuditHandoffCard);

  // ── Built-ins: Website Assistant cards (docs/website-assistant-plan.md §5.5) ───────────────────
  // The chat twins of the Website tab — same server action (sites.ts `apply` / `draft`), handled in
  // chat-session.js. The user's click applies; the server's gate (site-definition.ts) re-checks every
  // change and refuses the whole batch if any one would break a rule.

  // Plain words for each change — never the internal page or section ids the operations carry.
  const SITE_SECTION_WORDS = { hero: 'top (hero)', features: 'features', steps: 'steps', text: 'text', faq: 'questions', testimonials: 'testimonials', cta: 'call-to-action', social_feed: 'latest social posts' };
  const SITE_PROP_WORDS = { headline: 'headline', subheadline: 'line under the headline', eyebrow: 'small label', primaryCta: 'main button', secondaryCta: 'second button',
    image: 'picture', heading: 'heading', intro: 'introduction', items: 'items', body: 'text', button: 'button', layout: 'layout',
    platforms: 'platforms shown', count: 'number of posts', enabled: 'on/off' };
  const SITE_OP_WORDS = {
    add_page: (o) => `Add a page: “${o.title || ''}”`,
    update_page: (o) => (o.title ? `Rename a page to “${o.title}”` : o.hideFromMenu === true ? 'Hide a page from the menu' : o.hideFromMenu === false ? 'Show a page in the menu' : o.seo ? 'Update a page\'s search title and description' : 'Update a page'),
    remove_page: () => 'Remove a page',
    add_section: (o) => `Add a ${SITE_SECTION_WORDS[(o.section || {}).type] || 'new'} section`,
    update_section: (o) => {
      // The social posts section's switch, said as what it does.
      const keys = Object.keys(o.props || {});
      if (keys.length === 1 && keys[0] === 'enabled' && !o.look) return o.props.enabled ? 'Switch the social posts section on' : 'Switch the social posts section off (kept, not shown)';
      const words = Object.keys(o.props || {}).map((k) => SITE_PROP_WORDS[k] || k);
      const look = o.look || {};
      if (look.menuLabel) words.push(`menu label (“${look.menuLabel}”)`);
      if (look.background || look.columns) words.push('look');
      return `Change the ${words.join(', ') || 'section'}`;
    },
    set_structure: (o) => (o.structure === 'one_page' ? 'Make it a one-page site (the menu jumps down the page)' : 'Make it a site of several pages'),
    combine_pages: () => 'Combine every page into one page',
    apply_template: (o) => (o.mode === 'full' ? `Start again with the ${o.templateId} template (replaces your pages)` : `Use the ${o.templateId} template's design (your words and pictures stay)`),
    split_pages: () => 'Split the home page back into separate pages, one per menu entry',
    remove_section: () => 'Remove a section',
    move_section: (o) => (o.toPageId && o.toPageId !== o.pageId ? 'Move a section to another page' : 'Move a section'),
    set_theme: () => 'Change the design (colours, lettering or corners)',
    set_settings: (o) => {
      const f = o.settings && Array.isArray(o.settings.features) ? o.settings.features : null;
      if (!f) return 'Update the business details';
      const WORDS = { shop: 'selling', bookings: 'bookings', menu: 'a menu', hours: 'opening hours', gallery: 'a gallery', reviews: 'reviews', signup: 'email sign-up', faq: 'questions & answers' };
      const on = f.map((k) => WORDS[k]).filter(Boolean);
      return `Set what your website does: ${on.length ? on.join(', ') : 'just the basics'} (everything else hidden)`;
    },
    set_footer: () => 'Change the footer text',
    set_nav: () => 'Change the menu',
  };

  // { type: 'site_changes', summary, ops: SiteOperation[] }
  function renderSiteChangesCard(ui, esc) {
    const ops = (Array.isArray(ui.ops) ? ui.ops : []).filter((o) => o && typeof o === 'object' && SITE_OP_WORDS[o.op]).slice(0, 25);
    const summary = typeof ui.summary === 'string' ? ui.summary.slice(0, 300) : '';
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Changes to your website · Approval needed</p>
      ${summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(summary)}</p>` : ''}
      ${ops.length ? `<ul class="mt-2 space-y-1 list-disc pl-5">${ops.map((o) => `<li class="text-xs text-gray-700">${esc(SITE_OP_WORDS[o.op](o))}</li>`).join('')}</ul>` : '<p class="text-xs text-amber-700 mt-2">No changes were given.</p>'}
      <p class="text-xs text-gray-600 mt-2">Changes your draft only — nothing is live. The preview on the Website tab updates straight away.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-sc-apply ${ops.length ? '' : 'disabled'} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Apply changes</button>
        <button type="button" data-sc-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-sc-status></p>`;
    const status = el.querySelector('[data-sc-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-sc-cancel]')) { setBusy(true); say('Not applied.'); return; }
      if (!e.target.closest('[data-sc-apply]')) return;
      setBusy(true);
      say('Applying…');
      el.dispatchEvent(new CustomEvent('site:apply', {
        bubbles: true,
        detail: {
          ops,
          respond({ ok, error, warnings }) {
            if (!ok) { setBusy(false); say(error || 'Could not apply that — nothing was changed.', 'error'); return; }
            say(warnings && warnings.length ? `Applied. ${warnings.join(' ')}` : 'Applied — see the preview on the Website tab.');
          },
        },
      }));
    });
    return el;
  }
  register('site_changes', renderSiteChangesCard);

  // { type: 'site_draft_request', request }
  function renderSiteDraftRequestCard(ui, esc) {
    const request = typeof ui.request === 'string' ? ui.request.replace(/\s+/g, ' ').trim().slice(0, 2000) : '';
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Draft your whole site</p>
      ${request ? `<p class="text-xs text-gray-700 mt-2"><span class="font-bold">Your wishes:</span> ${esc(request)}</p>` : ''}
      <p class="text-xs text-gray-600 mt-2">Writes every page again, replacing your current draft. Nothing is live. Uses 1 task from your monthly allowance.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-sd-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Draft my whole site</button>
        <button type="button" data-sd-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-sd-status></p>`;
    const status = el.querySelector('[data-sd-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-sd-cancel]')) { setBusy(true); say('Not started.'); return; }
      if (!e.target.closest('[data-sd-go]')) return;
      setBusy(true);
      say('Starting…');
      el.dispatchEvent(new CustomEvent('site:draft', {
        bubbles: true,
        detail: {
          request,
          respond({ ok, error }) {
            if (!ok) { setBusy(false); say(error || 'Could not start the draft.', 'error'); return; }
            say('Drafting your site — it appears on the Website tab in a minute or two, and you\'ll be notified.');
          },
        },
      }));
    });
    return el;
  }
  register('site_draft_request', renderSiteDraftRequestCard);

  // { type: 'site_import_request', url } — "Import my current site" (sites.ts `import`, the same action
  // as the Website tab's "Read my site"). The owner confirms the site is theirs and chooses what happens
  // to its pictures HERE — the assistant never decides either. It makes a draft to review; nothing is
  // replaced until they choose "Use this as my draft".
  function renderSiteImportRequestCard(ui, esc) {
    const url = typeof ui.url === 'string' ? ui.url.replace(/\s+/g, '').slice(0, 500) : '';
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    const name = `si-pics-${Math.random().toString(36).slice(2, 8)}`;
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Import your current site</p>
      <label class="block text-xs font-bold text-gray-700 mt-2">Address
        <input data-si-url class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mt-1" value="${esc(url)}" placeholder="yourbusiness.co.uk"></label>
      <fieldset class="mt-2"><legend class="text-xs font-bold text-gray-700">Its pictures</legend>
        <label class="flex items-start gap-2 text-xs text-gray-700 mt-1"><input type="radio" name="${name}" value="copy"> <span>Copy them into my picture library and use them</span></label>
        <label class="flex items-start gap-2 text-xs text-gray-700 mt-1"><input type="radio" name="${name}" value="skip"> <span>Leave them out</span></label>
      </fieldset>
      <label class="flex items-start gap-2 text-xs text-gray-700 mt-2"><input type="checkbox" data-si-own> <span>This website belongs to my business, and I have the right to use its words and pictures.</span></label>
      <p class="text-xs text-gray-600 mt-2">Your own words are laid out unchanged; prices aren't copied (they belong in Business Information). You'll see the result before it replaces anything. Uses 1 task, only if a draft is made.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-si-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Read my site</button>
        <button type="button" data-si-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-si-status></p>`;
    const status = el.querySelector('[data-si-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button, input').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-si-cancel]')) { setBusy(true); say('Not started.'); return; }
      if (!e.target.closest('[data-si-go]')) return;
      const address = el.querySelector('[data-si-url]').value.trim();
      const pick = el.querySelector(`input[name="${name}"]:checked`);
      if (!address) { say('Type your website\'s address.', 'error'); return; }
      if (!pick) { say('Choose what happens to your pictures.', 'error'); return; }
      if (!el.querySelector('[data-si-own]').checked) { say('Tick the box to say this website is yours — only import your own site.', 'error'); return; }
      setBusy(true);
      say('Starting…');
      el.dispatchEvent(new CustomEvent('site:import', {
        bubbles: true,
        detail: {
          url: address, pictures: pick.value, ownSite: true,
          respond({ ok, error }) {
            if (!ok) { setBusy(false); say(error || 'The import couldn\'t be started.', 'error'); return; }
            say('Reading your site — the imported draft appears on the Website tab in a minute or two, and you\'ll be notified. Nothing has changed yet.');
          },
        },
      }));
    });
    return el;
  }
  register('site_import_request', renderSiteImportRequestCard);

  // { type: 'site_publish_open', blocker } — takes them to the Publish card on the Website tab. It never
  // publishes: that is a click there (sites.ts publish), so the owner always decides what goes live.
  function renderSitePublishOpenCard(ui, esc) {
    const blocker = typeof ui.blocker === 'string' && ui.blocker.trim() ? ui.blocker.trim().slice(0, 400) : '';
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Publish your site</p>
      ${blocker ? `<p class="text-xs font-semibold text-amber-800 mt-2">Before you can publish: ${esc(blocker)}</p>` : ''}
      <p class="text-xs text-gray-600 mt-2">Publishing is a button on your Website tab, so you always decide what goes live. Nothing changes until you press it there.</p>
      <div class="mt-3"><button type="button" data-sp-open class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition">Open the Publish card</button></div>`;
    el.addEventListener('click', (e) => {
      if (!e.target.closest('[data-sp-open]')) return;
      window._activateMainTab?.('sitebuilder');
      // The Website tab paints its cards as it opens; bring the Publish card into view once it is there.
      let tries = 0;
      const find = () => {
        const card = document.querySelector('[data-site-host="website"] [data-site-block="publish"]:not([hidden])');
        // Painted AND its tab showing (a card in a hidden tab can't be scrolled to).
        if (card && card.getClientRects().length) { card.scrollIntoView({ block: 'start' }); const b = card.querySelector('button:not([disabled]), input'); if (b) b.focus({ preventScroll: true }); return; }
        if (++tries < 20) setTimeout(find, 150);
      };
      find();
    });
    return el;
  }
  register('site_publish_open', renderSitePublishOpenCard);

  // { type: 'site_import_decision', decision: 'use' | 'discard' } — the owner's decision on an imported
  // draft (sites.ts import_accept / import_discard, the Website tab's two buttons).
  function renderSiteImportDecisionCard(ui) {
    const use = ui.decision === 'use';
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Your imported site</p>
      <p class="text-xs text-gray-700 mt-2">${use
        ? 'Replace your current draft with the imported pages. Your design stays, and nothing goes live until you publish.'
        : 'Throw the imported pages away. Your current draft stays as it is; any copied pictures stay in your library.'}</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-sid-go class="${use ? 'btn-primary' : 'btn-destructive'} px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">${use ? 'Use this as my draft' : 'Discard it'}</button>
        <button type="button" data-sid-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-sid-status></p>`;
    const status = el.querySelector('[data-sid-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-sid-cancel]')) { setBusy(true); say('Nothing changed.'); return; }
      if (!e.target.closest('[data-sid-go]')) return;
      setBusy(true);
      say(use ? 'Using it…' : 'Discarding…');
      el.dispatchEvent(new CustomEvent('site:importDecision', {
        bubbles: true,
        detail: {
          decision: use ? 'use' : 'discard',
          respond({ ok, error }) {
            if (!ok) { setBusy(false); say(error || 'That didn\'t work — nothing changed.', 'error'); return; }
            say(use ? 'Done — the imported pages are your draft. See the preview on the Website tab.' : 'Discarded. Your draft is unchanged.');
          },
        },
      }));
    });
    return el;
  }
  register('site_import_decision', renderSiteImportDecisionCard);

  // { type: 'site_words', pageId, attachmentId?, quote?, note? } — the owner's OWN words onto a page,
  // word for word (sites.ts `words` → site-words.ts). The card never carries their words for the
  // model to retype: it names an attached document, or quotes their own message (checked server-side).
  // Two clicks: "Place my words" shows exactly where everything goes; "Apply" saves it (site:apply).
  function renderSiteWordsCard(ui, esc) {
    const pageId = typeof ui.pageId === 'string' ? ui.pageId.slice(0, 40) : '';
    const attachmentId = Number.isInteger(Number(ui.attachmentId)) && Number(ui.attachmentId) > 0 ? Number(ui.attachmentId) : null;
    const quote = typeof ui.quote === 'string' && ui.quote.trim() ? ui.quote.slice(0, 20000) : null;
    const note = typeof ui.note === 'string' ? ui.note.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Your own words on your website</p>
      ${note ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(note)}</p>` : ''}
      <p class="text-xs text-gray-600 mt-2">Your words go on the page exactly as you wrote them — split into headings and paragraphs, never reworded. You'll see where everything goes before anything changes. Uses 1 task.</p>
      <div data-sw-preview></div>
      <div class="flex flex-wrap items-center gap-2 mt-3" data-sw-actions>
        <button type="button" data-sw-go ${pageId && (attachmentId || quote) ? '' : 'disabled'} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Place my words</button>
        <button type="button" data-sw-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-sw-status></p>`;
    const status = el.querySelector('[data-sw-status]');
    const preview = el.querySelector('[data-sw-preview]');
    const actions = el.querySelector('[data-sw-actions]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    let proposal = null;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-sw-cancel]')) { setBusy(true); say(proposal ? 'Not applied — nothing changed.' : 'Not placed.'); return; }
      if (e.target.closest('[data-sw-go]')) {
        setBusy(true);
        say('Placing your words…');
        el.dispatchEvent(new CustomEvent('site:words', {
          bubbles: true,
          detail: {
            pageId, attachmentId, quote, note,
            respond({ ok, error, proposal: p }) {
              if (!ok || !p) { setBusy(false); say(error || 'Your words couldn\'t be placed.', 'error'); return; }
              proposal = p;
              preview.innerHTML = `
                <p class="text-xs font-bold text-green-700 mt-3">Your wording, unchanged</p>
                <ul class="mt-2 space-y-2">${(p.preview || []).map((x) => `<li class="bg-white border border-gray-200 rounded-lg p-2"><p class="text-xs font-bold text-gray-900">${esc(x.label)}</p>${x.text ? `<p class="text-xs text-gray-700 mt-1" style="white-space:pre-wrap">${esc(x.text)}</p>` : ''}</li>`).join('')}</ul>`;
              actions.innerHTML = `
                <button type="button" data-sw-apply class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Apply to my page</button>
                <button type="button" data-sw-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`;
              say('Nothing has changed yet.');
            },
          },
        }));
        return;
      }
      if (e.target.closest('[data-sw-apply]') && proposal) {
        setBusy(true);
        say('Applying…');
        el.dispatchEvent(new CustomEvent('site:apply', {
          bubbles: true,
          detail: {
            ops: proposal.ops || [],
            respond({ ok, error, warnings }) {
              if (!ok) { setBusy(false); say(error || 'Could not apply that — nothing was changed.', 'error'); return; }
              say(warnings && warnings.length ? `Applied. ${warnings.join(' ')}` : 'Applied — see the preview on the Website tab.');
            },
          },
        }));
      }
    });
    return el;
  }
  register('site_words', renderSiteWordsCard);

  // { type: 'booking_setup', summary, settings, section? } — hours & booking rules into Business
  // Information, and (optionally) a booking section on a page: sites.ts `booking_setup`, after the
  // owner's click. The settings pass the same checks as Business Information (booking-settings.ts).
  const BK_DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
  function renderBookingSetupCard(ui, esc) {
    const settings = ui.settings && typeof ui.settings === 'object' ? ui.settings : {};
    const section = ui.section && typeof ui.section === 'object' ? ui.section : null;
    const hours = settings.weeklyHours && typeof settings.weeklyHours === 'object' ? settings.weeklyHours : null;
    const hoursList = hours ? BK_DAYS.map(([k, l]) => `<li class="text-xs text-gray-700">${l}: ${Array.isArray(hours[k]) && hours[k].length ? hours[k].map((p) => `${esc(p.start)}–${esc(p.end)}`).join(', ') : 'closed'}</li>`).join('') : '';
    const kinds = { appointment: 'Appointments', consultation: 'Consultations', table: 'Tables' };
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">${settings.mode || section ? 'Set up bookings' : 'Hours &amp; location'} · Approval needed</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      ${hoursList ? `<p class="text-xs font-bold text-gray-800 mt-2">Opening hours</p><ul class="mt-1 space-y-0.5">${hoursList}</ul>` : ''}
      ${typeof settings.visitAddress === 'string' && settings.visitAddress.trim() ? `<p class="text-xs font-bold text-gray-800 mt-2">Address customers visit</p><p class="text-xs text-gray-700">${esc(settings.visitAddress).replace(/\n/g, '<br>')}</p>` : ''}
      ${typeof settings.whatsapp === 'string' && settings.whatsapp.trim() ? `<p class="text-xs text-gray-700 mt-1">WhatsApp: ${esc(settings.whatsapp)}</p>` : ''}
      ${settings.mode ? `<p class="text-xs text-gray-700 mt-2">${settings.mode === 'instant' ? 'Bookings are confirmed straight away.' : 'You confirm each booking.'}</p>` : ''}
      ${section ? `<p class="text-xs text-gray-700 mt-1">Adds a ${esc(kinds[section.kind] || 'booking')} section to your site.</p>` : ''}
      <p class="text-xs text-gray-600 mt-2">Saved to Business Information (Hours &amp; Location, and Bookings), where you can change it any time. Uses no tasks.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-bs-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Set up bookings</button>
        <button type="button" data-bs-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-bs-status></p>`;
    const status = el.querySelector('[data-bs-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-bs-cancel]')) { setBusy(true); say('Not set up.'); return; }
      if (!e.target.closest('[data-bs-go]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('site:bookingSetup', {
        bubbles: true,
        detail: {
          settings, section,
          respond({ ok, error }) {
            if (!ok) { setBusy(false); say(error || 'That couldn\'t be saved — nothing was changed.', 'error'); return; }
            say('Bookings are set up — see the Website tab, under Bookings.');
          },
        },
      }));
    });
    return el;
  }
  register('booking_setup', renderBookingSetupCard);

  // { type: 'offer_profile', summary, offers } — "What does your business offer?" in Business
  // Information ▸ Products & Services (src/utils/offer-profile.ts), after the owner's click:
  // org-products.ts PATCH { offer }, the same call as the tab's tick boxes.
  // Same wording and order as src/utils/offer-profile.ts OFFER_LABELS.
  const OFFER_LABELS = {
    products: 'We sell products (physical or digital)',
    services: 'We provide services (consulting, trades, coaching, agencies)',
    subscriptions: 'We sell software or subscriptions',
    bookings: 'People book time with us (appointments, classes, tables or events)',
    visits: 'Customers visit us (a shop, venue or studio)',
    menu: 'We serve food or drink',
  };
  function renderOfferProfileCard(ui, esc) {
    const offers = Array.isArray(ui.offers) ? ui.offers.filter((k) => OFFER_LABELS[k]) : [];
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">What your business offers · Approval needed</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <ul class="mt-2 space-y-0.5">${Object.keys(OFFER_LABELS).map((k) => `<li class="text-xs text-gray-700">${offers.includes(k) ? '✓' : '✗'} ${esc(OFFER_LABELS[k])}</li>`).join('')}</ul>
      <p class="text-xs text-gray-600 mt-2">Business Information then shows only the fields that fit. Nothing you've typed is lost. Change it any time under Products &amp; Services.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-op-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Save this</button>
        <button type="button" data-op-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-op-status></p>`;
    const status = el.querySelector('[data-op-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-op-cancel]')) { setBusy(true); say('Not changed.'); return; }
      if (!e.target.closest('[data-op-go]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('site:offerProfile', {
        bubbles: true,
        detail: {
          offers,
          respond({ ok, error }) {
            if (!ok) { setBusy(false); say(error || 'That couldn\'t be saved — nothing was changed.', 'error'); return; }
            say('Saved — Business Information now shows the fields that fit.');
          },
        },
      }));
    });
    return el;
  }
  register('offer_profile', renderOfferProfileCard);

  // { type: 'intro_offer', summary, offer } — the workspace's free trial / introductory offer
  // (src/utils/intro-offer.ts), checked by the server before it gets here. Any assistant's chat.
  // After the owner's click: org-products.ts PATCH { introOffer }, the same call as the tab's form.
  // Same wording as src/utils/intro-offer.ts INTRO_OFFER_LABELS.
  const INTRO_OFFER_LABELS = {
    free_trial: 'A free trial',
    freemium: 'A free plan',
    free_consultation: 'A free consultation or discovery call',
    first_visit: 'A first-visit or first-booking offer',
    intro_discount: 'An introductory discount',
    free_sample: 'A free sample or taster',
    money_back: 'A money-back guarantee',
    other: 'Something else',
  };
  function renderIntroOfferCard(ui, esc) {
    const o = ui.offer && typeof ui.offer === 'object' ? ui.offer : { has: false };
    const rows = [];
    if (!o.has) rows.push('No free trial or introductory offer — your assistants won\'t mention one.');
    else {
      rows.push(INTRO_OFFER_LABELS[o.kind] || 'An introductory offer');
      if (o.days) rows.push(`${o.days} days`);
      if (o.cardUpFront === false) rows.push('No card needed up front');
      if (o.cardUpFront === true) rows.push('Card taken at sign-up');
      if (o.afterwards === 'stops') rows.push('When it ends, it just stops');
      if (o.afterwards === 'auto_charge') rows.push('When it ends, the paid plan starts');
      if (o.terms) rows.push(`Offer: ${o.terms}`);
      if (o.whoFor) rows.push(`Who can have it: ${o.whoFor}`);
      if (o.appliesTo) rows.push(`Applies to: ${o.appliesTo}`);
      if (o.url) rows.push(`Where to start: ${o.url}`);
    }
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Free trial or introductory offer · Approval needed</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <ul class="mt-2 space-y-0.5">${rows.map((r) => `<li class="text-xs text-gray-700 break-words">${esc(r)}</li>`).join('')}</ul>
      <p class="text-xs text-gray-600 mt-2">Every assistant then uses this, on exactly these terms. Change it any time under Business Information ▸ Products &amp; Services.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-io-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Save this</button>
        <button type="button" data-io-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-io-status></p>`;
    const status = el.querySelector('[data-io-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-io-cancel]')) { setBusy(true); say('Not changed.'); return; }
      if (!e.target.closest('[data-io-go]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('intro:offer', {
        bubbles: true,
        detail: {
          offer: o,
          respond({ ok, error }) {
            if (!ok) { setBusy(false); say(error || 'That couldn\'t be saved — nothing was changed.', 'error'); return; }
            say('Saved — every assistant now uses this.');
          },
        },
      }));
    });
    return el;
  }
  register('intro_offer', renderIntroOfferCard);

  // ── Business Mentor cards (src/utils/mentor-cards.ts), checked by the server before they get here.
  // Each click goes through chat-session.js to the endpoint the screen itself uses (§14 of
  // docs/business-mentor-plan.md). The "Why?" line is the evidence the suggestion is based on.
  // A suggestion (proposalId set — the server recorded it, mentor-proposals.ts) is answered: the click
  // records "accepted" once it has saved, and "Dismiss…" asks why (§3.13) before recording it. The
  // user's own requests (quiet mode, support) carry no proposalId and keep a plain "Not now".
  const MENTOR_DISMISS_REASONS = [['not_relevant', 'Not relevant'], ['already_done', 'Already done'], ['disagree', 'Disagree'], ['not_now', 'Not now']];
  // `answered` (chat-card-refresh.ts → mentor-proposal-cards.ts): the suggestion was answered somewhere else —
  // this chat, another member's, Inbox "Needs you" or "Review all" — so the card says so instead of offering
  // its buttons again.
  const MENTOR_ANSWERED = { accepted: 'Done — this suggestion was accepted.', dismissed: 'Dismissed — listed under Dismissed suggestions on your Mentor’s Overview tab.', expired: 'This suggestion has expired.', failed: 'This suggestion couldn’t be applied.' };
  function mentorCard(esc, { eyebrow, summary, why, bodyHtml, goLabel, eventName, detail, doneText, note, proposalId, noGo, answered }) {
    const suggestion = Number.isInteger(proposalId) && proposalId > 0;
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-pink-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-pink-700 tracking-wider uppercase">${esc(eyebrow)}${suggestion && answered && MENTOR_ANSWERED[answered] ? '' : ' · Approval needed'}</p>
      ${summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(summary).slice(0, 300))}</p>` : ''}
      ${why ? `<p class="mt-2 text-xs rounded-lg border border-blue-200 bg-blue-50 text-blue-800 px-2.5 py-1.5"><span class="font-bold">Why?</span> ${esc(String(why).slice(0, 400))}</p>` : ''}
      ${bodyHtml}
      ${note ? `<p class="text-xs text-gray-600 mt-2">${note}</p>` : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${noGo ? '' : `<button type="button" data-mc-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">${esc(goLabel)}</button>`}
        ${suggestion
          ? '<button type="button" data-mc-dismiss aria-expanded="false" class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Dismiss…</button>'
          : noGo ? '' : '<button type="button" data-mc-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>'}
      </div>
      ${suggestion ? `<div class="hidden flex-wrap items-center gap-2 mt-2" data-mc-reasons style="display:none">
        <span class="text-xs text-gray-500">Why?</span>
        ${MENTOR_DISMISS_REASONS.map(([k, label]) => `<button type="button" data-mc-reason="${k}" class="btn-secondary px-2.5 py-1 border text-xs font-semibold rounded-full transition disabled:opacity-50">${label}</button>`).join('')}
      </div>` : ''}
      <p class="hidden mt-2 text-xs font-semibold text-pink-700" data-mc-status></p>`;
    const status = el.querySelector('[data-mc-status]');
    const reasons = el.querySelector('[data-mc-reasons]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-pink-700'}`; };
    if (suggestion && answered && MENTOR_ANSWERED[answered]) {
      el.querySelectorAll('[data-mc-go], [data-mc-dismiss], [data-mc-cancel]').forEach((b) => b.remove());
      say(MENTOR_ANSWERED[answered]);
      return el;
    }
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    // What the user did with the card, saved on its chat message (chat-session.js → mentor.ts card_outcome)
    // so the Mentor's next turn knows (mentor-card-outcome.ts).
    const outcome = (status, note) => el.dispatchEvent(new CustomEvent('mentor:cardOutcome', { bubbles: true, detail: { outcome: status, note: note || null } }));
    const decide = (decision, reason, respond) => el.dispatchEvent(new CustomEvent('mentor:decide', {
      bubbles: true, detail: { proposalId, decision, reason, respond: respond || (() => {}) },
    }));
    // For a card whose own body acts (the hire list's links): record the suggestion as taken up, once.
    let accepted = false;
    el._mcAccept = () => { if (suggestion && !accepted) { accepted = true; decide('accepted'); } };
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-mc-cancel]')) { setBusy(true); say('Not changed.'); outcome('not_now'); return; }
      if (e.target.closest('[data-mc-dismiss]')) {
        const open = reasons.style.display === 'none';
        reasons.style.display = open ? 'flex' : 'none';
        e.target.closest('[data-mc-dismiss]').setAttribute('aria-expanded', open ? 'true' : 'false');
        // The chips open under the buttons, often below the chat's fold (staging, 2026-10-25).
        if (open) reasons.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const r = e.target.closest('[data-mc-reason]');
      if (r) {
        const reason = r.getAttribute('data-mc-reason');
        setBusy(true);
        say('Saving…');
        decide('dismissed', reason, ({ ok, error }) => {
          if (!ok) { setBusy(false); say(error || 'That couldn\'t be saved.', 'error'); return; }
          reasons.style.display = 'none';
          outcome('dismissed', reason);
          say(reason === 'not_now' ? 'Dismissed for now — your Mentor may raise it again in two weeks. It\'s listed under Dismissed suggestions on its Overview tab.'
            : reason === 'already_done' ? 'Dismissed — thanks for letting your Mentor know.'
              : 'Dismissed — your Mentor won\'t suggest this again. Bring it back from its Overview tab any time.');
        });
        return;
      }
      if (!e.target.closest('[data-mc-go]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent(eventName, {
        bubbles: true,
        detail: {
          ...detail,
          respond({ ok, error, message }) {
            if (!ok) { setBusy(false); say(error || 'That couldn\'t be saved — nothing was changed.', 'error'); outcome('failed', error); return; }
            if (reasons) reasons.style.display = 'none';
            say(message || doneText);
            outcome('applied', message || doneText);
            if (suggestion) decide('accepted');
          },
        },
      }));
    });
    return el;
  }

  const MENTOR_PROFILE_LABELS = { businessDescription: 'Business description', targetAudience: 'Who your customers are', industry: 'Industry', websiteUrl: 'Website' };
  register('mentor_business_profile', (ui, esc) => {
    const fields = ui.fields && typeof ui.fields === 'object' ? ui.fields : {};
    const rows = Object.keys(MENTOR_PROFILE_LABELS).filter((k) => fields[k]).map((k) =>
      `<li class="text-xs text-gray-700 break-words"><span class="font-semibold">${esc(MENTOR_PROFILE_LABELS[k])}:</span> ${esc(String(fields[k]))}</li>`).join('');
    return mentorCard(esc, {
      eyebrow: 'Business Information', summary: ui.summary, why: ui.why,
      bodyHtml: `<ul class="mt-2 space-y-1">${rows}</ul>`,
      goLabel: 'Save this', eventName: 'mentor:businessProfile', detail: { fields }, proposalId: ui.proposalId, answered: ui.answered,
      doneText: 'Saved to Business Information — every assistant now uses it.',
      note: 'Only these fields change. You can edit them any time under Business Information.',
    });
  });

  register('mentor_products', (ui, esc) => {
    const products = Array.isArray(ui.products) ? ui.products : [];
    const rows = products.map((p) => `<li class="text-xs text-gray-700 break-words"><span class="font-semibold">${esc(String(p.name || ''))}</span> <span class="text-gray-500">(${esc(p.kind === 'service' ? 'service' : 'product')})</span>${p.description ? ` — ${esc(String(p.description))}` : ''}</li>`).join('');
    return mentorCard(esc, {
      eyebrow: 'Products & Services', summary: ui.summary, why: ui.why,
      bodyHtml: `<ul class="mt-2 space-y-1">${rows}</ul>`,
      goLabel: products.length > 1 ? `Add these ${products.length}` : 'Add this', eventName: 'mentor:products', detail: { products }, proposalId: ui.proposalId, answered: ui.answered,
      doneText: 'Added — add prices under Business Information ▸ Products & Services.',
      note: 'Prices are left for you to add on the Products &amp; Services tab.',
    });
  });

  register('mentor_products_remove', (ui, esc) => {
    const products = Array.isArray(ui.products) ? ui.products : [];
    const ids = products.map((p) => Number(p.id)).filter((n) => Number.isInteger(n) && n > 0);
    const rows = products.map((p) => `<li class="text-xs text-gray-700 break-words"><span class="font-semibold">${esc(String(p.name || ''))}</span></li>`).join('');
    return mentorCard(esc, {
      eyebrow: 'Products & Services', summary: ui.summary, why: null,
      bodyHtml: `<ul class="mt-2 space-y-1">${rows}</ul>`,
      goLabel: ids.length > 1 ? `Remove these ${ids.length}` : 'Remove this', eventName: 'mentor:productsRemove', detail: { ids },
      doneText: 'Removed from Business Information ▸ Products & Services.',
      note: 'They’re deleted for good — your assistants stop mentioning them straight away.',
    });
  });

  register('mentor_products_update', (ui, esc) => {
    const changes = Array.isArray(ui.changes) ? ui.changes : [];
    const fields = ui.fields && typeof ui.fields === 'object' ? ui.fields : {};
    const rows = changes.map((c) => `<li class="text-xs text-gray-700 break-words"><span class="font-semibold">${esc(String(c.label || ''))}:</span> ${esc(String(c.to || ''))}${c.from ? `<span class="block text-gray-500 mt-0.5">Replaces: ${esc(String(c.from))}</span>` : ''}</li>`).join('');
    return mentorCard(esc, {
      eyebrow: 'Products & Services', summary: ui.summary || (ui.productName ? `Update “${ui.productName}”` : ''), why: null,
      bodyHtml: `${ui.productName ? `<p class="mt-2 text-xs font-bold text-gray-900 break-words">${esc(String(ui.productName))}</p>` : ''}<ul class="mt-1 space-y-1.5">${rows}</ul>`,
      goLabel: 'Save this change', eventName: 'mentor:productsUpdate', detail: { id: Number(ui.productId), fields },
      doneText: 'Saved to Business Information ▸ Products & Services — every assistant now uses it.',
      note: 'Only these fields change. The price and everything else stay as they are.',
    });
  });

  register('mentor_quiet_mode', (ui, esc) => mentorCard(esc, {
    eyebrow: 'Quiet mode', summary: ui.summary, why: null,
    bodyHtml: `<p class="mt-2 text-xs text-gray-700">${ui.on ? 'Your Mentor will answer your questions but stop making suggestions until you ask.' : 'Your Mentor will point out what to fix and suggest next steps again.'}</p>`,
    goLabel: ui.on ? 'Turn on Quiet mode' : 'Turn off Quiet mode', eventName: 'mentor:quietMode', detail: { on: !!ui.on, assistantId: ui.assistantId },
    doneText: ui.on ? 'Quiet mode is on.' : 'Quiet mode is off.',
    note: 'Also on your Mentor’s profile, under how it works.',
  }));

  register('mentor_support_request', (ui, esc) => {
    const issue = ui.destination === 'issue';
    return mentorCard(esc, {
      eyebrow: issue ? 'Report a problem to Be More Swan' : 'Message Be More Swan support', summary: ui.summary, why: null,
      bodyHtml: `<div class="mt-2 rounded-lg bg-gray-50 border border-dashed border-gray-300 px-3 py-2"><p class="text-xs font-bold text-gray-900">${esc(String(ui.subject || ''))}</p><p class="text-xs text-gray-700 mt-1 whitespace-pre-line break-words">${esc(String(ui.description || ''))}</p></div>`,
      goLabel: issue ? 'Send report' : 'Send', eventName: 'mentor:support',
      detail: { destination: issue ? 'issue' : 'support', subject: ui.subject, description: ui.description },
      doneText: issue ? 'Sent — follow it under Help & Support ▸ Report an Issue.' : 'Sent — the team will reply by email and in Help & Support.',
      note: 'Only what’s written here is sent, with the page you were on. Nothing else from your workspace.',
    });
  });

  // "Established business or new idea?" (§3.1): both answers are buttons; the click saves the Mentor's
  // businessStage set-up answer (mentor-apply.js → update-assistant-context.ts patchContext).
  register('mentor_business_stage', (ui, esc) => {
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-pink-200 rounded-xl shadow-sm p-5 max-w-md';
    const choice = (stage, label, sub) => `<button type="button" data-mbs-stage="${stage}" class="btn-secondary w-full text-left border rounded-lg px-3 py-2.5 transition disabled:opacity-50">
        <span class="block text-sm font-bold text-gray-900">${label}</span><span class="block text-xs text-gray-600 mt-0.5">${sub}</span></button>`;
    el.innerHTML = `
      <p class="text-xs font-bold text-pink-700 tracking-wider uppercase">Where is your business today?</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <div class="mt-3 space-y-2">
        ${choice('existing', 'I run an established business', 'Start from what is already set up here.')}
        ${choice('new_idea', 'I’m starting something new', 'Start by testing the idea.')}
      </div>
      <p class="text-xs text-gray-600 mt-2">You can change this later on your Mentor’s profile.</p>
      <p class="hidden mt-2 text-xs font-semibold text-pink-700" data-mc-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-mc-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-pink-700'}`; };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mbs-stage]');
      if (!b) return;
      const stage = b.getAttribute('data-mbs-stage');
      el.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      say('Saving…');
      el.dispatchEvent(new CustomEvent('mentor:businessStage', {
        bubbles: true,
        detail: { stage, assistantId: ui.assistantId, respond({ ok, error }) {
          if (!ok) { el.querySelectorAll('button').forEach((x) => { x.disabled = false; }); say(error || 'That couldn’t be saved.', 'error'); return; }
          b.style.boxShadow = '0 0 0 2px #f9a8d4';
          say(stage === 'new_idea' ? 'Saved — tell me about the idea and I’ll help you test it.' : 'Saved — I’ll start from what’s already set up here.');
        } },
      }));
    });
    return el;
  });

  // One set-up answer on an active assistant (src/utils/chat-setup-field.ts) — the server rebuilt it from
  // the row, so the labels and the current answer are real. Any route can draw it; from the Mentor it is
  // a suggestion (proposalId) with Dismiss…. The click → mentor-apply.js setupAnswer (patchContext).
  // A multi-line answer (an email signature) keeps its lines: `whitespace-pre-line`, or the card showed
  // a three-line signature on one line.
  register('setup_field_proposal', (ui, esc) => retireOlderSetupCards(mentorCard(esc, {
    eyebrow: `Set-up answer · ${String(ui.assistantName || 'Assistant')}`, summary: ui.summary, why: ui.why,
    bodyHtml: `<dl class="mt-2 text-xs text-gray-700 space-y-1">
        <div><dt class="inline font-semibold">${esc(String(ui.label || ui.key || ''))}</dt></div>
        <div class="break-words"><dt class="inline text-gray-500">Now:</dt> <dd class="inline whitespace-pre-line">${esc(String(ui.currentLabel || 'Not answered'))}</dd></div>
        <div class="break-words"><dt class="block text-gray-500">Change to:</dt> <dd class="font-semibold text-gray-900 whitespace-pre-line">${esc(String(ui.valueLabel ?? ui.value ?? ''))}</dd></div>
      </dl>`,
    goLabel: 'Save this', eventName: 'setupField:apply',
    detail: { assistantId: ui.assistantId, key: ui.key, value: ui.value }, proposalId: ui.proposalId, answered: ui.answered,
    doneText: `Saved — ${String(ui.assistantName || 'the assistant')} uses it from now on.`,
    note: `Only this answer changes. It’s also on ${esc(String(ui.assistantName || 'the assistant'))}’s profile.`,
  }), ui));

  // Two open suggestions for the SAME answer on the same assistant (the owner corrected the draft: "change
  // the signature to Catherine…"): only the newest (highest proposalId) stays clickable, or the old one
  // could still be saved over the new. The server expires the older row too (mentor-proposals.ts
  // supersedeSetupFieldProposals); this handles cards already on screen. Order-independent, because
  // Review all lists newest first and chat oldest first.
  function retireOlderSetupCards(el, ui) {
    const id = Number(ui.proposalId);
    if (!Number.isInteger(id) || id <= 0 || ui.answered) return el;
    const sig = `${ui.assistantId}:${ui.key}`;
    el.dataset.mcSetupSig = sig;
    el.dataset.mcProposalId = String(id);
    const retire = (card) => {
      card.querySelectorAll('[data-mc-go], [data-mc-dismiss], [data-mc-cancel], [data-mc-reasons]').forEach((b) => b.remove());
      const eyebrow = card.querySelector('p');
      if (eyebrow) eyebrow.textContent = eyebrow.textContent.replace(' · Approval needed', '');
      const status = card.querySelector('[data-mc-status]');
      if (status) { status.textContent = 'Replaced by a newer suggestion — use that one.'; status.className = 'mt-2 text-xs font-semibold text-gray-500'; }
      delete card.dataset.mcSetupSig;
    };
    let newest = id;
    document.querySelectorAll('[data-mc-setup-sig]').forEach((other) => {
      if (other.dataset.mcSetupSig !== sig) return;
      const otherId = Number(other.dataset.mcProposalId);
      if (otherId < id) retire(other);
      else if (otherId > newest) newest = otherId;
    });
    if (newest > id) retire(el);
    return el;
  }

  // A post asked of an ACTIVE Social Media assistant (src/utils/mentor-draft-request.ts, Phase 3). The click
  // is "Create a Post" on that assistant's Posts tab (generate-post.ts), carrying the suggestion's id so the
  // draft shows "Requested by" the Mentor.
  register('mentor_draft_request', (ui, esc) => mentorCard(esc, {
    eyebrow: `Post request · ${String(ui.assistantName || 'Social Media assistant')}`, summary: ui.summary, why: ui.why,
    bodyHtml: `<p class="mt-2 text-xs text-gray-700 break-words"><span class="font-semibold">What the post should say:</span> ${esc(String(ui.brief || '').slice(0, 500))}</p>`,
    goLabel: 'Ask for this post', eventName: 'mentor:draftRequest',
    detail: { assistantId: ui.assistantId, brief: ui.brief, proposalId: ui.proposalId }, proposalId: ui.proposalId, answered: ui.answered,
    doneText: `Asked — ${String(ui.assistantName || 'the assistant')} is drafting it. It’ll be in its Posts tab for you to review.`,
    note: `Nothing is posted: the draft waits in ${esc(String(ui.assistantName || 'the assistant'))}’s Posts tab for your review.`,
  }));

  // Commitments (src/utils/mentor-commitments.ts, Phase 3 §5.1). "set" saves 1–3 things for this week; "close"
  // is the end-of-week check on one: Done, Missed (pick why from the fixed list) or Drop it. Both call the same
  // mentor.ts actions as the Commitments list on the Mentor's Results tab.
  const MENTOR_MISS_REASONS = [['no_time', 'No time'], ['didnt_know_how', 'Didn’t know how'], ['priorities_changed', 'Priorities changed'], ['waiting_on_someone', 'Waiting on someone else'], ['decided_against', 'Decided against it'], ['other', 'Other']];
  register('mentor_commitments', (ui, esc) => {
    if (ui.op !== 'close') {
      const texts = Array.isArray(ui.texts) ? ui.texts.slice(0, 3) : [];
      return mentorCard(esc, {
        eyebrow: 'Commitments this week', summary: ui.summary,
        bodyHtml: `<ol class="mt-2 list-decimal pl-5 space-y-1">${texts.map((t) => `<li class="text-sm text-gray-800 break-words">${esc(String(t))}</li>`).join('')}</ol>`,
        goLabel: texts.length > 1 ? 'Save these' : 'Save this', eventName: 'mentor:commitmentsAdd', detail: { texts },
        doneText: 'Saved — they’re on the Commitments list on my Results tab. I’ll ask how they went at the end of the week.',
      });
    }
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-pink-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-pink-700 tracking-wider uppercase">End-of-week check</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <p class="mt-2 text-sm text-gray-800 break-words">“${esc(String(ui.text || ''))}”</p>
      <p class="text-xs text-gray-500 mt-0.5">${ui.mine ? 'Yours' : esc(String(ui.ownerName || ''))} · week of ${esc(String(ui.weekStart || ''))}</p>
      ${ui.closed ? `<p class="mt-2 text-xs font-semibold text-pink-700">Already marked ${esc(String(ui.closed))} — it’s on the Commitments list on your Mentor’s Results tab.</p>` : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3" ${ui.closed ? 'style="display:none"' : ''}>
        <button type="button" data-mcc="done" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Done</button>
        <button type="button" data-mcc="missed" aria-expanded="false" class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Missed…</button>
        <button type="button" data-mcc="dropped" class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Drop it</button>
      </div>
      <div data-mcc-reasons class="flex-wrap items-center gap-2 mt-2" style="display:none">
        <span class="text-xs text-gray-500">Why?</span>
        ${MENTOR_MISS_REASONS.map(([k, label]) => `<button type="button" data-mcc-reason="${k}" class="btn-secondary px-2.5 py-1 border text-xs font-semibold rounded-full transition disabled:opacity-50">${label}</button>`).join('')}
        <label class="sr-only" for="mcc-note-${Number(ui.commitmentId)}">A few words (needed for Other)</label>
        <input id="mcc-note-${Number(ui.commitmentId)}" data-mcc-note type="text" maxlength="500" placeholder="A few words (needed for Other)" class="w-full mt-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs">
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-pink-700" data-mc-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-mc-status]');
    const reasons = el.querySelector('[data-mcc-reasons]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-pink-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button, input').forEach((x) => { x.disabled = b; });
    const send = (st, missReason) => {
      setBusy(true); say('Saving…');
      el.dispatchEvent(new CustomEvent('mentor:commitmentClose', {
        bubbles: true,
        detail: { id: ui.commitmentId, status: st, missReason, note: el.querySelector('[data-mcc-note]').value.trim(), respond({ ok, error }) {
          if (!ok) { setBusy(false); say(error || 'That couldn’t be saved.', 'error'); return; }
          reasons.style.display = 'none';
          say(st === 'done' ? 'Marked done — well done.' : st === 'dropped' ? 'Dropped.' : 'Saved — thanks for saying why. I’ll take it into account.');
        } },
      }));
    };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mcc]');
      if (b) {
        const st = b.getAttribute('data-mcc');
        if (st === 'missed') {
          const open = reasons.style.display === 'none';
          reasons.style.display = open ? 'flex' : 'none';
          b.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (open) reasons.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          return;
        }
        send(st);
        return;
      }
      const r = e.target.closest('[data-mcc-reason]');
      if (r) send('missed', r.getAttribute('data-mcc-reason'));
    });
    return el;
  });

  // Who to hire next (src/utils/mentor-hire.ts — the same list as "Recommended next" on the Mentor's
  // Overview tab and the catalogue's "Recommended" badge). Hires nothing: each pick opens the catalogue.
  function openCatalogue(roleKey) {
    try { sessionStorage.setItem('intended_role', roleKey); } catch (e) { /* the badge still marks it */ }
    window.closeAssistantChat?.();
    if (typeof window.loadView === 'function') window.loadView('catalog');
    else window.location.href = '/workspace.html';
  }
  window.MentorOpenCatalogue = openCatalogue;
  register('mentor_hire_recommendation', (ui, esc) => {
    const picks = Array.isArray(ui.picks) ? ui.picks.slice(0, 3) : [];
    const cap = ui.capacity && typeof ui.capacity === 'object' ? ui.capacity : {};
    const rows = picks.map((p, i) => `<li class="py-2 border-b border-gray-100 last:border-0">
        <p class="text-sm font-bold text-gray-900">${i + 1}. ${esc(String(p.name || ''))}</p>
        <p class="text-xs text-gray-700 mt-0.5 break-words">${esc(String(p.reason || ''))}</p>
        <button type="button" data-mhr-open="${esc(String(p.roleKey || ''))}" class="btn-swan-link mt-1 px-0 py-1 text-xs font-bold">See this assistant</button>
      </li>`).join('');
    const el = mentorCard(esc, {
      eyebrow: 'Who to hire next', summary: ui.summary, why: ui.why, noGo: true, proposalId: ui.proposalId, answered: ui.answered,
      bodyHtml: `<ol class="mt-2">${rows}</ol>
        ${cap.note ? `<p class="mt-2 text-xs rounded-lg px-2.5 py-1.5 ${cap.needsUpgrade ? 'border border-amber-200 bg-amber-50 text-amber-900' : 'bg-gray-50 text-gray-700'}">${esc(String(cap.note))}</p>` : ''}`,
      note: 'Nothing is hired from here. The same list is under "Recommended next" on your Mentor’s Overview tab.',
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mhr-open]');
      if (!b) return;
      el._mcAccept?.();
      openCatalogue(b.getAttribute('data-mhr-open'));
    });
    return el;
  });

  // Review all (§3.13): every suggestion still waiting, each with its preview and its own tick, inline in
  // the chat. The list and the apply are src/components/mentor-review-all.js — the same component as on
  // the Overview tab and in Inbox "Needs you".
  register('mentor_review_all', (ui, esc) => {
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-pink-200 rounded-xl shadow-sm p-5 max-w-md w-full';
    el.innerHTML = `<p class="text-xs font-bold text-pink-700 tracking-wider uppercase">Review all suggestions</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <div class="mt-2" data-mra-host></div>`;
    const host = el.querySelector('[data-mra-host]');
    if (window.MentorReviewAll) window.MentorReviewAll.mount(host);
    else host.innerHTML = '<p class="text-xs text-gray-600">Open your Mentor’s Overview tab to review them.</p>';
    return el;
  });

  // ── Business Mentor Phase 2 (src/utils/mentor-plan-cards.ts): its plans, research and break-even. ──
  // strategy_proposal — the server rebuilt it from the documents, so "Now" is the real saved text.
  //   revise  → mentor:strategySave    (mentor.ts strategy_save — the Plan tab's Save draft)
  //   approve → mentor:strategyApprove (mentor.ts strategy_approve — the Plan tab's Approve)
  //   draft   → mentor:strategyDraft   (mentor.ts strategy_draft — "Draft it for me", 1 task)
  const clipText = (t, n) => { const v = String(t || ''); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
  register('strategy_proposal', (ui, esc) => {
    const label = String(ui.kindLabel || 'Plan');
    const lower = label.toLowerCase();
    if (ui.op === 'approve') {
      const changed = Array.isArray(ui.changed) ? ui.changed : [];
      return mentorCard(esc, {
        eyebrow: `Approve your ${lower}`, summary: ui.summary, why: null,
        bodyHtml: `<p class="mt-2 text-xs text-gray-700">Draft v${Number(ui.version) || ''}${ui.approvedVersion ? ` replaces approved v${Number(ui.approvedVersion)}` : ' becomes your first approved version'}. What changes:</p>
          <ul class="mt-1 space-y-0.5">${changed.map((c) => `<li class="text-xs text-gray-700"><span class="font-semibold">${esc(String(c.label || ''))}</span> <span class="text-gray-500">(${esc(String(c.change || ''))})</span></li>`).join('')}</ul>`,
        goLabel: 'Approve', eventName: 'mentor:strategyApprove', detail: { kind: ui.kind, draftId: ui.draftId, updatedAt: ui.draftUpdatedAt },
        // Only the business and marketing plans reach other assistants (strategy-documents.ts feedsDrafts).
        doneText: ui.kind === 'idea_check' ? 'Approved — it’s on your Mentor’s Plan tab. The old version is kept there.'
          : 'Approved — every assistant writes from it from their next draft. The old version is kept on the Plan tab.',
        note: ui.kind === 'idea_check' ? 'Your idea check is your Mentor’s record of the idea. It doesn’t change what your other assistants write.'
          : 'Every assistant will write from it. See the full changes on your Mentor’s Plan tab first if you like.',
      });
    }
    if (ui.op === 'draft') {
      return mentorCard(esc, {
        eyebrow: `Draft your ${lower}`, summary: ui.summary, why: null,
        bodyHtml: '<p class="mt-2 text-xs text-gray-700">Uses 1 task. Ready in about a minute — it’s posted into this chat and on the Plan tab, and you’ll get a notification. Nothing is saved until you choose “Use this draft”.</p>',
        goLabel: 'Draft it · 1 task', eventName: 'mentor:strategyDraft', detail: { kind: ui.kind },
        doneText: 'Drafting — I’ll post it here when it’s ready (about a minute). Reopen this chat or check the Plan tab.',
      });
    }
    const changes = Array.isArray(ui.changes) ? ui.changes : [];
    const rows = changes.map((c) => `<li class="py-1.5 border-b border-gray-100 last:border-0">
        <p class="text-xs font-bold text-gray-900">${esc(String(c.label || c.key || ''))}</p>
        ${c.now ? `<p class="text-[11px] text-gray-500 break-words"><span class="font-semibold">Now:</span> ${esc(clipText(c.now, 160))}</p>` : ''}
        <p class="text-xs text-gray-800 whitespace-pre-line break-words">${esc(String(c.next || ''))}</p></li>`).join('');
    const ass = Array.isArray(ui.assumptions) ? ui.assumptions : null;
    const assHtml = ass ? `<p class="text-xs font-bold text-gray-900 mt-2">Riskiest assumptions</p><ul class="mt-1 space-y-1 list-disc pl-4">${ass.map((a) => `<li class="text-xs text-gray-800 break-words">${esc(String(a.assumption || ''))}${a.test ? ` <span class="text-gray-500">→ ${esc(String(a.test))}</span>` : ''}</li>`).join('')}</ul>` : '';
    return mentorCard(esc, {
      eyebrow: label, summary: ui.summary, why: ui.why, proposalId: ui.proposalId, answered: ui.answered,
      bodyHtml: `<ul class="mt-2">${rows}</ul>${assHtml}`,
      goLabel: ui.jobId ? 'Use this draft' : ui.kind === 'idea_check' ? 'Save to my idea check' : 'Save to my draft',
      eventName: 'mentor:strategySave', detail: { kind: ui.kind, sections: ui.sections || {}, assumptions: ass || undefined },
      doneText: 'Saved to your draft on the Plan tab. Nothing changes for your assistants until you approve it.',
      note: 'Saved as a draft, not approved. Edit or approve it on your Mentor’s Plan tab.',
    });
  });

  // mentor_research — "Look this up" (mentor.ts research, 1 task). The answer is posted into this chat
  // when ready (about two minutes); the card also polls (mentor.ts ?job=) and shows it here.
  register('mentor_research', (ui, esc) => {
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-pink-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `<p class="text-xs font-bold text-pink-700 tracking-wider uppercase">Look this up</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <p class="mt-2 text-xs rounded-lg bg-gray-50 border border-dashed border-gray-300 px-3 py-2 text-gray-800 break-words">${esc(String(ui.question || ''))}</p>
      <p class="text-xs text-gray-600 mt-2">Searches the web and answers with its sources: about two minutes, 1 task. If it can’t find a source, it says so rather than guess.</p>
      <div class="flex flex-wrap gap-2 mt-3">
        <button type="button" data-mr-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Look it up · 1 task</button>
        <button type="button" data-mr-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-pink-700" data-mc-status role="status" aria-live="polite"></p>
      <div data-mr-answer></div>`;
    const status = el.querySelector('[data-mc-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-pink-700'}`; };
    const buttons = () => el.querySelectorAll('[data-mr-go],[data-mr-cancel]');
    const showAnswer = (job) => {
      const r = job.result || {};
      const src = Array.isArray(r.sources) ? r.sources : [];
      el.querySelector('[data-mr-answer]').innerHTML = `<div class="mt-2 rounded-lg border border-pink-200 bg-pink-50 p-3">
        <p class="text-xs text-gray-800 whitespace-pre-line break-words">${esc(String(r.answer || ''))}</p>
        ${src.length ? `<ul class="mt-2 space-y-0.5">${src.map((x) => `<li class="text-[11px] break-words"><a href="${esc(String(x.url || ''))}" target="_blank" rel="noopener noreferrer" class="text-pink-700 underline">${esc(String(x.title || x.url || ''))}</a></li>`).join('')}</ul>` : ''}
      </div>`;
    };
    let tries = 0;
    const poll = (jobId) => {
      if (!el.isConnected) return; // the chat closed: the answer is still posted into it
      if (++tries > 45) { say('Still working — the answer will be posted in this chat and on the Plan tab.'); return; }
      window.MentorApply?.jobStatus(jobId).then((job) => {
        if (!job || job.status === 'queued' || job.status === 'running') { setTimeout(() => poll(jobId), 8000); return; }
        if (job.status === 'failed') { say(job.error || 'It couldn’t be finished. Nothing was charged.', 'error'); return; }
        say(job.result && job.result.outcome === 'answered' ? 'Here’s what I found — it’s also on the Plan tab.' : 'Done — nothing I could source.');
        showAnswer(job);
      }, () => setTimeout(() => poll(jobId), 8000));
    };
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-mr-cancel]')) { buttons().forEach((b) => { b.disabled = true; }); say('Not looked up.'); return; }
      if (!e.target.closest('[data-mr-go]')) return;
      buttons().forEach((b) => { b.disabled = true; });
      say('Starting…');
      el.dispatchEvent(new CustomEvent('mentor:research', {
        bubbles: true,
        detail: { question: ui.question, respond({ ok, error, jobId }) {
          if (!ok) { buttons().forEach((b) => { b.disabled = false; }); say(error || 'That couldn’t be started — nothing was charged.', 'error'); return; }
          say('Looking it up — about two minutes. You can carry on chatting.');
          if (jobId) setTimeout(() => poll(jobId), 8000);
        } },
      }));
    });
    return el;
  });

  // mentor_break_even — worked out in code on the server (break-even.ts); nothing is saved. "Open in the
  // calculator" fills the Plan tab's calculator (assistant-mentor-plan.js listens for mentor:openCalculator).
  register('mentor_break_even', (ui, esc) => {
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-pink-200 rounded-xl shadow-sm p-5 max-w-md';
    const inputs = ui.inputs && typeof ui.inputs === 'object' ? ui.inputs : {};
    const labels = ui.labels && typeof ui.labels === 'object' ? ui.labels : {};
    const r = ui.result || {};
    const n = (v) => Number(v).toLocaleString('en-GB');
    const rows = Object.keys(labels).filter((k) => inputs[k]).map((k) => {
      const i = inputs[k];
      const src = i.source === 'assumption' ? '<span class="text-amber-700 font-semibold">assumption</span>' : i.source === 'plan' ? 'from your plan' : 'from you';
      const val = k === 'conversionRate' ? `${n(i.value)}%` : `£${n(i.value)}`;
      return `<li class="text-xs text-gray-700 break-words"><span class="font-semibold">${esc(String(labels[k]))}:</span> ${esc(val)} <span class="text-gray-500">(${src}${i.note ? ` — ${esc(String(i.note))}` : ''})</span></li>`;
    }).join('');
    el.innerHTML = `<p class="text-xs font-bold text-pink-700 tracking-wider uppercase">Break-even · worked out in code</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <ul class="mt-2 space-y-0.5">${rows}</ul>
      <dl class="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-pink-50 border border-pink-200 p-3">
        <div><dt class="text-[11px] text-gray-600">Sales to break even</dt><dd class="text-sm font-bold text-gray-900">${esc(n(r.salesToBreakEven))}</dd></div>
        ${r.leadsToBreakEven != null ? `<div><dt class="text-[11px] text-gray-600">Leads needed</dt><dd class="text-sm font-bold text-gray-900">${esc(n(r.leadsToBreakEven))}</dd></div>` : ''}
        <div><dt class="text-[11px] text-gray-600">Each sale brings in</dt><dd class="text-sm font-bold text-gray-900">£${esc(n(r.marginPerSale))}</dd></div>
      </dl>
      ${(r.assumed || []).length ? `<p class="text-[11px] text-amber-800 mt-2">Assumed, not from you: ${esc(r.assumed.join(', '))}. Change them in the calculator.</p>` : ''}
      <button type="button" data-mbe-open class="btn-secondary mt-3 px-4 py-2 border text-sm font-bold rounded-lg transition">Open in the calculator</button>
      <p class="hidden mt-2 text-xs font-semibold text-pink-700" data-mc-status></p>`;
    el.addEventListener('click', (e) => {
      if (!e.target.closest('[data-mbe-open]')) return;
      if (!window.AssistantMentorPlan) {
        const st = el.querySelector('[data-mc-status]');
        st.textContent = 'Open your Mentor’s Plan tab to use the calculator.'; st.className = 'mt-2 text-xs font-semibold text-pink-700';
        return;
      }
      document.dispatchEvent(new CustomEvent('mentor:openCalculator', { detail: { inputs } }));
    });
    return el;
  });

  // { type: 'outreach_offer', summary, offer, offerLabel, formId, formName, giftLabel } — what a Lead
  // Generator's first emails offer (src/config/outreach-offer.ts), rebuilt by the server against the
  // workspace's real gift forms (src/utils/chat-outreach-offer.ts). The click → lead-generation.ts
  // set_outreach_offer, the same action as the Outreach tab's offer strip.
  function renderOutreachOfferCard(ui, esc) {
    const what = ui.offer === 'gift' && ui.giftLabel
      ? `A free "${ui.giftLabel}" from your "${ui.formName || 'sign-up'}" form`
      : (ui.offerLabel || 'No offer — just ask a question');
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Outreach offer · Approval needed</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <p class="text-xs text-gray-700 mt-2 break-words">First emails will offer: <span class="font-semibold">${esc(what)}</span></p>
      <p class="text-xs text-gray-600 mt-2">Emails already drafted keep their words. Change it any time on the Outreach tab.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-oo-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Save this</button>
        <button type="button" data-oo-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-oo-status></p>`;
    const status = el.querySelector('[data-oo-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-oo-cancel]')) { setBusy(true); say('Not changed.'); return; }
      if (!e.target.closest('[data-oo-go]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('lead:outreachOffer', {
        bubbles: true,
        detail: {
          offer: ui.offer, formId: ui.formId ?? null,
          respond({ ok, error }) {
            if (!ok) { setBusy(false); say(error || 'That couldn\'t be saved — nothing was changed.', 'error'); return; }
            say('Saved — your next first emails use this offer.');
          },
        },
      }));
    });
    return el;
  }
  register('outreach_offer', renderOutreachOfferCard);

  // { type: 'follow_up_plan', summary, enabled, steps:[{stepNumber, delayDays, brief}]|null, current,
  // proposed, running, blocked } — a Lead Generator's chasers after a first email, rebuilt by the
  // server against the stored plan (src/utils/chat-follow-up-plan.ts). The click → lead-generation.ts
  // save_follow_up_plan, the same action as the Outreach tab's Follow-up plan panel.
  function renderFollowUpPlanCard(ui, esc) {
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    const steps = Array.isArray(ui.steps) ? ui.steps : [];
    const days = (d) => `${d} day${d === 1 ? '' : 's'}`;
    const list = ui.enabled && steps.length
      ? `<ol class="mt-2 flex flex-col gap-1.5">${steps.map((s, i) => `
          <li class="text-xs text-gray-700"><span class="font-semibold">${i + 1}. After ${esc(days(s.delayDays))}${i === steps.length - 1 ? ' · the last one' : ''}:</span> ${esc(String(s.brief).slice(0, 600))}</li>`).join('')}</ol>`
      : '';
    const running = Number(ui.running) || 0;
    const stopChoice = !ui.enabled && running && !ui.blocked
      ? `<label class="flex items-start gap-2 mt-2 text-xs text-gray-700"><input type="checkbox" data-fp-card-stop class="mt-0.5 rounded border-gray-300">
           <span>Also stop the ${running} lead${running === 1 ? '' : 's'} being followed up now. Otherwise only leads approved from here on are affected.</span></label>`
      : '';
    const live = !ui.blocked && !ui.settled;
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Follow-up plan · Approval needed</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <p class="text-xs text-gray-600 mt-2 break-words">Now: ${esc(ui.current || '')}</p>
      <p class="text-xs text-gray-900 mt-1 break-words"><span class="font-semibold">New:</span> ${esc(ui.proposed || '')}</p>
      ${list}
      ${stopChoice}
      ${ui.blocked ? `<p class="text-xs font-semibold text-amber-800 mt-2">${esc(ui.blocked)}</p>` : ''}
      ${live ? `<div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-fp-card-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Save this plan</button>
        <button type="button" data-fp-card-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>` : ''}
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-fp-card-status></p>`;
    const status = el.querySelector('[data-fp-card-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button, input').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-fp-card-cancel]')) { setBusy(true); say('Not changed.'); return; }
      if (!e.target.closest('[data-fp-card-go]')) return;
      const stopRunning = !!el.querySelector('[data-fp-card-stop]')?.checked;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('lead:followUpPlan', {
        bubbles: true,
        detail: {
          enabled: !!ui.enabled, steps: ui.enabled ? steps : null, stopRunning,
          respond({ ok, error, summary, stopped }) {
            if (!ok) { setBusy(false); say(error || 'That couldn\'t be saved — nothing was changed.', 'error'); return; }
            say(`Saved — ${String(summary || ui.proposed).replace(/^No /, 'no ')}.${stopped ? ` Stopped follow-ups for ${stopped} lead${stopped === 1 ? '' : 's'}.` : ''}`);
          },
        },
      }));
    });
    return el;
  }
  register('follow_up_plan', renderFollowUpPlanCard);

  // { type: 'follow_up_preview', recordId, threadId, leadTitle, position|null, blocked } — "what would
  // the next follow-up to Acme say?" (src/utils/chat-follow-up-plan.ts). The button drafts it through
  // lead-generation.ts preview_follow_up — the same action as Preview on the Outreach tab — and the
  // card shows it. Nothing is sent or saved; it is metered as an editing helper.
  function renderFollowUpPreviewCard(ui, esc) {
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-gray-200 rounded-xl shadow-sm p-5 max-w-lg';
    const which = ui.position ? `Follow-up ${ui.position}` : 'Their next follow-up';
    el.innerHTML = `
      <p class="text-xs font-bold text-gray-500 tracking-wider uppercase">Follow-up preview · nothing is sent</p>
      <p class="text-sm font-bold text-gray-900 mt-2">${esc(which)} to ${esc(ui.leadTitle || 'this lead')}</p>
      ${ui.blocked ? `<p class="text-xs font-semibold text-amber-800 mt-2">${esc(ui.blocked)}</p>` : `
      <p class="text-xs text-gray-600 mt-1">Written the way your assistant writes the real one — from the conversation so far and your follow-up plan.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-fpv-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Write the preview</button>
      </div>`}
      <div data-fpv-out></div>`;
    const out = el.querySelector('[data-fpv-out]');
    el.addEventListener('click', (e) => {
      const go = e.target.closest('[data-fpv-go]');
      if (!go) return;
      go.disabled = true;
      go.textContent = 'Writing…';
      el.dispatchEvent(new CustomEvent('lead:followUpPreview', {
        bubbles: true,
        detail: {
          threadId: ui.threadId, position: ui.position ?? null,
          respond({ ok, error, result }) {
            go.disabled = false;
            go.textContent = 'Write it again';
            if (!ok) { out.innerHTML = `<p class="mt-2 text-xs font-semibold text-red-600">${esc(error || 'The preview couldn\'t be written.')}</p>`; return; }
            out.innerHTML = `
              <div class="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Follow-up ${esc(result.position)}${result.isLast ? ' · the last one' : ''} · not sent</p>
                <p class="text-sm font-semibold text-gray-900 mt-1">${esc(result.subject)}</p>
                <p class="text-sm text-gray-700 mt-1 whitespace-pre-wrap">${esc(result.body)}</p>
                <p class="text-[11px] text-gray-500 mt-2">${esc(result.note || '')}</p>
              </div>`;
          },
        },
      }));
    });
    return el;
  }
  register('follow_up_preview', renderFollowUpPreviewCard);

  // { type: 'call_to_action', summary, kind, kindLabel, formId, formName, giftLabel } — what a Social,
  // Blog or Email assistant's work invites people to do (src/config/call-to-action.ts), rebuilt by the
  // server against the real gift forms. The click → org-products.ts PATCH { callToAction }, the same
  // save as Business Information ▸ Products & Services ▸ Calls to action.
  function renderCallToActionCard(ui, esc) {
    const what = ui.kind === 'gift' && ui.giftLabel
      ? `The free "${ui.giftLabel}" from your "${ui.formName || 'sign-up'}" form`
      : (ui.kindLabel || 'Its own call to action');
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Call to action · Approval needed</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <p class="text-xs text-gray-700 mt-2 break-words">My work will invite people to: <span class="font-semibold">${esc(what)}</span></p>
      <p class="text-xs text-gray-600 mt-2">Drafts already written keep their words. Change it any time on Business Information ▸ Products &amp; Services.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-cta-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Save this</button>
        <button type="button" data-cta-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-cta-status></p>`;
    const status = el.querySelector('[data-cta-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-cta-cancel]')) { setBusy(true); say('Not changed.'); return; }
      if (!e.target.closest('[data-cta-go]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('cta:change', {
        bubbles: true,
        detail: {
          kind: ui.kind, formId: ui.formId ?? null,
          respond({ ok, error }) {
            if (!ok) { setBusy(false); say(error || 'That couldn\'t be saved — nothing was changed.', 'error'); return; }
            say('Saved — my next drafts use this.');
          },
        },
      }));
    });
    return el;
  }
  register('call_to_action', renderCallToActionCard);

  // ── Request a call back (src/utils/callback-request.ts) ───────────────────────────────────────
  // Shown when the customer asks the chat for a call or a person. It only OPENS the Help & Support
  // form — the chat never books a call. No time is promised (owner, 2026-10-19).
  function renderCallbackOfferCard() {
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-gray-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-gray-500 tracking-wider uppercase">📞 Talk to a person</p>
      <p class="text-sm text-gray-800 mt-2">A person from the Be More Swan team can call you back. Leave your number and we'll be in touch.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-cb-open class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition">Request a call back</button>
      </div>`;
    el.addEventListener('click', (e) => {
      if (!e.target.closest('[data-cb-open]')) return;
      // In the workspace, help.js is loaded and opens the form in place; anywhere else (the
      // stand-alone chat page) go to the workspace with ?help=contact&callback=1, which does the same.
      if (typeof window.openCallbackForm === 'function') window.openCallbackForm();
      else window.location.href = '/workspace.html?help=contact&callback=1';
    });
    return el;
  }
  register('callback_offer', renderCallbackOfferCard);

  // { type: 'reviews_add', summary, reviews: [{ authorName, authorDetail, rating, body, source, reviewedOn }] }
  // Reviews the owner pasted, set out for them to check WORD FOR WORD before they are saved to
  // Audience ▸ Reviews (org-reviews.ts, the same checks as the form there).
  const RV_SOURCES = { google: 'Google', facebook: 'Facebook', trustpilot: 'Trustpilot', tripadvisor: 'Tripadvisor', checkatrade: 'Checkatrade', yell: 'Yell', direct: 'Sent directly', website: 'Their website', other: 'Elsewhere' };
  function renderReviewsAddCard(ui, esc) {
    const reviews = (Array.isArray(ui.reviews) ? ui.reviews : []).filter((r) => r && typeof r === 'object' && typeof r.body === 'string' && r.body.trim()).slice(0, 50)
      .map((r) => ({ authorName: String(r.authorName || ''), authorDetail: r.authorDetail ? String(r.authorDetail) : null, rating: Number.isInteger(r.rating) ? r.rating : null, body: String(r.body), source: RV_SOURCES[r.source] ? r.source : 'other', reviewedOn: typeof r.reviewedOn === 'string' ? r.reviewedOn : null }));
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Add reviews · Check them first</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <div class="space-y-2 mt-2 max-h-80 overflow-y-auto">${reviews.map((r) => `
        <div class="bg-white border border-gray-200 rounded-lg p-3">
          <p class="text-xs"><span class="text-amber-500">${r.rating ? '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) : 'No stars'}</span> <strong>${esc(r.authorName || '(no name)')}</strong>${r.authorDetail ? ` · ${esc(r.authorDetail)}` : ''} <span class="text-gray-500">· ${esc(RV_SOURCES[r.source])}${r.reviewedOn ? ` · ${esc(r.reviewedOn)}` : ''}</span></p>
          <p class="text-xs text-gray-700 mt-1 whitespace-pre-line">${esc(r.body)}</p></div>`).join('')}</div>
      <p class="text-xs text-gray-600 mt-2">Check each one matches what the customer wrote, word for word. They're saved to Audience ▸ Reviews, where you can edit or hide them.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-rv-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${reviews.length ? '' : 'disabled'}>Add ${reviews.length} review${reviews.length === 1 ? '' : 's'}</button>
        <button type="button" data-rv-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-rv-status></p>`;
    const status = el.querySelector('[data-rv-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-rv-cancel]')) { setBusy(true); say('Not added.'); return; }
      if (!e.target.closest('[data-rv-go]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('site:reviewsAdd', {
        bubbles: true,
        detail: {
          reviews,
          respond({ ok, error }) {
            if (!ok) { setBusy(false); say(error || 'They couldn\'t be saved — nothing was added.', 'error'); return; }
            say('Added to Audience ▸ Reviews.');
          },
        },
      }));
    });
    return el;
  }
  register('reviews_add', renderReviewsAddCard);

  // { type: 'class_sessions', summary, session: { serviceId, date, start, end, capacity, resourceId, repeatWeeks, notes } }
  // Dates for a class or event on the timetable (sites.ts `session_add`, the same checks as the
  // Website tab's Timetable), after the owner's click.
  function renderClassSessionsCard(ui, esc) {
    const s = ui.session && typeof ui.session === 'object' ? ui.session : {};
    const weeks = Number.isInteger(s.repeatWeeks) ? s.repeatWeeks : 0;
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Add to your timetable · Approval needed</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <ul class="text-xs text-gray-700 mt-2 space-y-0.5">
        <li><strong>${esc(String(s.date || ''))}</strong>, ${esc(String(s.start || ''))}–${esc(String(s.end || ''))}</li>
        <li>${esc(String(s.capacity || ''))} places</li>
        <li>${weeks ? `Then weekly for ${weeks} more week${weeks === 1 ? '' : 's'} (${weeks + 1} dates)` : 'Just this date'}</li>
        ${s.notes ? `<li>${esc(String(s.notes).slice(0, 300))}</li>` : ''}
      </ul>
      <p class="text-xs text-gray-600 mt-2">You can see and cancel dates on the Bookings tab, under Availability. Uses no tasks.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-cs-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Add ${weeks ? `${weeks + 1} dates` : 'it'}</button>
        <button type="button" data-cs-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-cs-status></p>`;
    const status = el.querySelector('[data-cs-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-cs-cancel]')) { setBusy(true); say('Not added.'); return; }
      if (!e.target.closest('[data-cs-go]')) return;
      setBusy(true);
      say('Adding…');
      el.dispatchEvent(new CustomEvent('site:classSessions', {
        bubbles: true,
        detail: {
          session: s,
          respond({ ok, error, added }) {
            if (!ok) { setBusy(false); say(error || 'That couldn\'t be added — nothing was changed.', 'error'); return; }
            say(added === 1 ? 'Added to your timetable.' : `${added} dates added to your timetable.`);
          },
        },
      }));
    });
    return el;
  }
  register('class_sessions', renderClassSessionsCard);

  // { type: 'review_decisions', summary, decisions: [{ reviewId, decision: approve|decline, reason }] }
  // Approve / decline reviews customers sent in — org-reviews.ts PATCH { id, decision }, the same as
  // Audience ▸ Reviews. Decline is only for a review that isn't genuine, is offensive or
  // isn't about the business; the server refuses one already dealt with.
  const RD_REASON = { not_genuine: 'not genuine', offensive: 'offensive', not_about_us: 'not about you' };
  function renderReviewDecisionsCard(ui, esc) {
    const decisions = (Array.isArray(ui.decisions) ? ui.decisions : [])
      .map((d) => ({ reviewId: Number(d && d.reviewId), decision: d && d.decision === 'decline' ? 'decline' : d && d.decision === 'approve' ? 'approve' : null, reason: d && RD_REASON[d.reason] ? d.reason : null }))
      .filter((d) => Number.isInteger(d.reviewId) && d.reviewId > 0 && d.decision && (d.decision === 'approve' || d.reason)).slice(0, 20);
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Waiting reviews · Approval needed</p>
      ${ui.summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(ui.summary).slice(0, 300))}</p>` : ''}
      <ul class="text-xs text-gray-700 mt-2 space-y-0.5">${decisions.map((d) => `<li>Review ${esc(d.reviewId)}: <strong>${d.decision === 'approve' ? 'approve it' : `decline — ${esc(RD_REASON[d.reason])}`}</strong></li>`).join('')}</ul>
      <p class="text-xs text-gray-600 mt-2">Declined reviews aren't shown or counted. A genuine bad review should be approved — you can hide it later, and it still counts in your average.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-rd-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${decisions.length ? '' : 'disabled'}>Do it</button>
        <button type="button" data-rd-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-rd-status></p>`;
    const status = el.querySelector('[data-rd-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-rd-cancel]')) { setBusy(true); say('Nothing changed.'); return; }
      if (!e.target.closest('[data-rd-go]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('site:reviewDecisions', {
        bubbles: true,
        detail: {
          decisions,
          respond({ ok, error, done }) {
            if (!ok) { setBusy(false); say(error || 'That couldn\'t be saved.', 'error'); return; }
            say(`Done — ${done} review${done === 1 ? '' : 's'} updated in Audience ▸ Reviews.`);
          },
        },
      }));
    });
    return el;
  }
  register('review_decisions', renderReviewDecisionsCard);

  // ── Built-in: Visual Option Review Card (Brand Designer) ───────────────────
  // { type: 'visual_option_review', briefId, decisions: [{ optionId, decision, reason?, note? }], remake? }
  //
  // The chat twin of "Use this" / "Not this" on the Briefs tab — the same brand-briefs.ts `decide`.
  // Option ids come from the per-turn snapshot; a stale or invented one is refused by the server and
  // the card says which, rather than claiming it was done.
  function renderVisualOptionReviewCard(ui, esc) {
    const decisions = (Array.isArray(ui.decisions) ? ui.decisions : [])
      .map((d) => ({
        optionId: Number(d && d.optionId),
        decision: d && d.decision === 'approve' ? 'approve' : d && d.decision === 'reject' ? 'reject' : null,
        reason: typeof (d && d.reason) === 'string' ? d.reason : 'other',
        note: typeof (d && d.note) === 'string' ? d.note.slice(0, 300) : '',
      }))
      .filter((d) => Number.isInteger(d.optionId) && d.optionId > 0 && d.decision)
      .slice(0, 12);
    const label = (r) => String(r || 'other').replace(/_/g, ' ');
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Choose options · Approval needed</p>
      ${decisions.length ? `<ul class="mt-2 space-y-1">${decisions.map((d) => `
        <li class="text-sm text-gray-900">${d.decision === 'approve' ? '✓ Use' : '✗ Turn down'} option ${esc(d.optionId)}${d.decision === 'reject' ? ` <span class="text-xs text-gray-600">— ${esc(label(d.reason))}${d.note ? `: ${esc(d.note)}` : ''}</span>` : ''}</li>`).join('')}</ul>`
        : '<p class="text-sm text-amber-700 mt-2">No options were named.</p>'}
      <p class="text-xs text-gray-600 mt-2">Approved pictures go into your library for every assistant to use. Turned-down ones are deleted, and the next round reads why.${ui.remake === true ? ' For a new round, ask for more options on the brief in your Briefs tab.' : ''}</p>
      <div class="flex items-center gap-2 mt-3">
        <button type="button" data-vor-confirm ${decisions.length ? '' : 'disabled'} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Confirm</button>
        <button type="button" data-vor-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-vor-status></p>`;
    const status = el.querySelector('[data-vor-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-vor-cancel]')) { setBusy(true); say('Nothing changed.'); return; }
      if (!e.target.closest('[data-vor-confirm]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('brief:review', {
        bubbles: true,
        detail: {
          decisions,
          respond({ results }) {
            const failed = (results || []).filter((r) => !r.ok);
            const done = (results || []).length - failed.length;
            // A brief raised for a post (Phase 5) says what happened to that post.
            const notes = (results || []).map((r) => r.postNote).filter(Boolean);
            if (!failed.length) { say(`Done — ${done} ${done === 1 ? 'option' : 'options'} decided.${notes.length ? ` ${notes[0]}` : ''}`); return; }
            say(`${done} done. Not done: ${failed.map((r) => `option ${r.optionId} (${r.error})`).join('; ')}`, 'error');
          },
        },
      }));
    });
    return el;
  }

  register('visual_option_review', renderVisualOptionReviewCard);

  // ── Built-in: Brand Guideline Proposal Card (Brand Designer) ───────────────
  // { type: 'brand_guideline_proposal', photoStyle?, mustInclude?, mustAvoid?, secondaryColors? }
  //
  // The chat twin of "Save picture guidelines" on Business Information ▸ Brand Assets — the same
  // brand-kit.ts `save_guidelines`. Each field present REPLACES that guideline, so the card shows the
  // whole new text, and says plainly that every assistant's AI images read it.
  function renderBrandGuidelineProposalCard(ui, esc) {
    const clean = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : undefined);
    const changes = {};
    const p = clean(ui.photoStyle, 500); if (p !== undefined) changes.photoStyle = p || null;
    const i = clean(ui.mustInclude, 300); if (i !== undefined) changes.mustInclude = i || null;
    const a = clean(ui.mustAvoid, 300); if (a !== undefined) changes.mustAvoid = a || null;
    if (Array.isArray(ui.secondaryColors)) changes.secondaryColors = ui.secondaryColors.map((c) => String(c).trim()).filter(Boolean).slice(0, 4);
    const LABEL = { photoStyle: 'Photo style', mustInclude: 'Include where it fits', mustAvoid: 'Never show', secondaryColors: 'Extra colours' };
    const keys = Object.keys(changes);
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">Picture guidelines · Approval needed</p>
      ${keys.length ? keys.map((k) => {
        const v = changes[k];
        const shown = Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : (v || '(cleared)');
        return `<p class="text-xs text-gray-700 mt-2"><span class="font-bold">${esc(LABEL[k])}:</span> ${esc(shown)}</p>`;
      }).join('') : '<p class="text-sm text-amber-700 mt-2">No change was written.</p>'}
      <p class="text-xs text-gray-600 mt-2">Replaces what is there now. Every AI image your assistants make reads these — not only your Brand Designer's. You can change them any time on Business Information ▸ Brand Assets.</p>
      <div class="flex items-center gap-2 mt-3">
        <button type="button" data-bgp-save ${keys.length ? '' : 'disabled'} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Save guidelines</button>
        <button type="button" data-bgp-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>
      </div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-bgp-status></p>`;
    const status = el.querySelector('[data-bgp-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-bgp-cancel]')) { setBusy(true); say('Nothing changed.'); return; }
      if (!e.target.closest('[data-bgp-save]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('brand:saveGuidelines', {
        bubbles: true,
        detail: {
          guidelines: changes,
          respond({ ok, error }) {
            if (ok) { say('Saved. New AI images will follow these.'); return; }
            setBusy(false);
            say(error || 'Could not save that — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('brand_guideline_proposal', renderBrandGuidelineProposalCard);

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
          class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed shrink-0 whitespace-nowrap">
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
          class="btn-golive px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed shrink-0 whitespace-nowrap">
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
            class="btn-primary px-3 py-2 text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">
            Yes, add it to my draft
          </button>
          <button type="button" data-dismiss-draft
            class="btn-secondary px-3 py-2 border text-xs font-bold rounded-lg transition">
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
            class="btn-secondary mt-2 px-3 py-2 border text-xs font-bold rounded-lg transition">
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

  // ── Built-in: Post Action Proposal Card (Social Media chat) ────────────────
  // { type: 'post_action_proposal', action: 'approve'|'reject'|'retry'|'reschedule'|'remove', postId,
  //   postIds, platforms, status, publishDate, timezone, text, reason, when, blocked }
  //
  // The chat's hands on a post that already exists — the twin of the Posts tab's Approve, Reject,
  // "Try again" and Reschedule. Every fact on it was read from the database by the orchestrator
  // (src/utils/chat-post-action.ts), not written by the model. The click dispatches `post:action`;
  // chat-session.js calls the same endpoints the tab does, so the tab's gates (a disconnected
  // account, an open compliance warning, a time in the past) stop it here too — and when one does,
  // the card says so and offers the post itself, where that is settled.
  const POST_ACTION_COPY = {
    approve: { head: 'Approve this post', button: 'Approve', busy: 'Approving…' },
    // "Reject and redraft": the same words as the editor (reject-post always queues a replacement;
    // the checkbox below only decides whether the reason is also kept as a rule).
    reject: { head: 'Reject and redraft', button: 'Reject and redraft', busy: 'Rejecting…' },
    retry: { head: 'Try this post again', button: 'Try again now', busy: 'Putting it back in the queue…' },
    reschedule: { head: 'Move this post', button: 'Move it', busy: 'Moving…' },
    // "Remove": the editor's and the Review tab's word — no rule, no replacement.
    remove: { head: 'Remove this post', button: 'Remove', busy: 'Removing…' },
    // The post editor's "Make it shorter" / "Make it longer", every platform of the post.
    shorter: { head: 'Make this post shorter', button: 'Make it shorter', busy: 'Rewriting…' },
    longer: { head: 'Make this post longer', button: 'Make it longer', busy: 'Rewriting…' },
  };

  function renderPostActionProposalCard(ui, esc) {
    const copy = POST_ACTION_COPY[ui.action];
    const postId = Number(ui.postId);
    if (!copy || !Number.isInteger(postId)) return null;
    const ids = (Array.isArray(ui.postIds) ? ui.postIds : []).map(Number).filter(Number.isInteger);
    const labels = (Array.isArray(ui.platforms) ? ui.platforms : []).map(socialPlatformLabel).filter(Boolean);
    let when = '';
    if (ui.publishDate) {
      const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
      try { when = new Date(ui.publishDate).toLocaleString('en-GB', ui.timezone ? { ...opts, timeZone: ui.timezone } : opts); }
      catch { when = new Date(ui.publishDate).toLocaleString('en-GB', opts); }
    }
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const canOpen = typeof window.openPostReview === 'function';
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">${esc(copy.head)} · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      <p class="text-xs text-gray-500 mt-2">#${postId}${labels.length ? ` · ${esc(labels.join(', '))}` : ''}${when ? ` · ${esc(when)}` : ''}</p>
      ${ui.text ? `<p class="text-sm text-gray-900 mt-1 break-words">“${esc(ui.text)}”</p>` : ''}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      ${!blocked && ui.action === 'reschedule' ? `<p class="text-sm text-gray-700 mt-3"><span class="font-bold">New time:</span> ${esc(ui.when || '')}</p>
        <p class="text-xs text-gray-500 mt-1">The exact time is worked out when you press ${esc(copy.button)}, and said back to you here.</p>` : ''}
      ${!blocked && ui.action === 'reject' ? `
        <label class="block text-xs font-bold text-gray-700 mt-3" for="pap-reason-${postId}">What’s wrong with it</label>
        <textarea id="pap-reason-${postId}" data-pap-reason rows="2" maxlength="500" class="mt-1 w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700">${esc(ui.reason || '')}</textarea>
        <label class="flex items-start gap-2 text-xs text-gray-700 mt-2">
          <input type="checkbox" data-pap-rule checked class="mt-0.5">
          <span>Also keep this as a rule for future posts. A replacement is written either way.</span>
        </label>` : ''}
      ${!blocked && ui.action === 'approve' ? '<p class="text-xs text-gray-600 mt-3">It’s booked into a free slot in your posting schedule.</p>' : ''}
      ${!blocked && ui.action === 'revise' ? `
        <label class="block text-xs font-bold text-gray-700 mt-3" for="bap-instruction-${postId}">What to change</label>
        <textarea id="bap-instruction-${postId}" data-bap-instruction rows="3" maxlength="500" class="mt-1 w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700">${esc(ui.instruction || '')}</textarea>
        <p class="text-xs text-gray-600 mt-2">The article is rewritten and saved in place, using your Business Knowledge for anything new — no invented facts. Pictures and links stay. The title, SEO and schedule don’t change.</p>` : ''}
      ${!blocked && ui.action === 'remove' ? '<p class="text-xs text-gray-600 mt-3">It moves to Archived. Nothing is learned from it and no replacement is written.</p>' : ''}
      ${!blocked && (ui.action === 'shorter' || ui.action === 'longer') ? `<p class="text-xs text-gray-600 mt-3">${ui.action === 'shorter' ? 'About half the length — same message, nothing new added.' : 'About half as long again — it develops what the post already says, with no invented facts.'} Each platform’s caption is rewritten and saved. It stays where it is in your queue.</p>` : ''}
      ${!blocked && ui.action === 'retry' && ui.when ? `<p class="text-sm text-gray-700 mt-3"><span class="font-bold">Try again at:</span> ${esc(ui.when)}</p>
        <p class="text-xs text-gray-500 mt-1">The exact time is worked out when you press the button, and said back to you here. If the same problem is still there, it will fail again.</p>` : ''}
      ${!blocked && ui.action === 'retry' && !ui.when ? '<p class="text-xs text-gray-600 mt-3">It goes back in the queue and publishes on the next run. If the same problem is still there, it will fail again — open the post to see why it stopped.</p>' : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-pap-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${esc(ui.action === 'retry' && ui.when ? 'Try again then' : copy.button)}</button>
        <button type="button" data-pap-cancel class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
        ${canOpen ? `<button type="button" data-pap-open class="btn-swan-link px-1 py-2 text-sm font-bold">Open the post</button>` : ''}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-pap-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-pap-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-pap-go], [data-pap-cancel], [data-pap-reason], [data-pap-rule]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-pap-open]')) { window.openPostReview?.(postId); return; }
      if (e.target.closest('[data-pap-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-pap-go]')) return;
      const reason = el.querySelector('[data-pap-reason]')?.value.trim() || '';
      if (ui.action === 'reject' && !reason) { say('Say what’s wrong with it first — it steers the replacement.', 'error'); return; }
      setBusy(true);
      say(copy.busy);
      el.dispatchEvent(new CustomEvent('post:action', {
        bubbles: true,
        detail: {
          action: ui.action, postId, postIds: ids.length ? ids : [postId], when: ui.when || null,
          reason, applyAsRule: !!el.querySelector('[data-pap-rule]')?.checked,
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Done.'); return; }
            setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('post_action_proposal', renderPostActionProposalCard);

  // ── Built-in: Blog Action Proposal Card (Blog Writer chat) ─────────────────
  // { type: 'blog_action_proposal', action: 'approve'|'schedule'|'unschedule'|'reject', postId,
  //   title, status, publishDate, scheduleAt, timezone, reason, when, blocked, settled? }
  //
  // The blog twin of the card above: Blog Studio's Approve, "Pick a time myself", Unschedule and
  // Reject. Every fact on it was read from blog_posts by the orchestrator (src/utils/chat-blog-action.ts)
  // — including `scheduleAt`, the exact instant a "schedule" books, worked out before the card was
  // shown so the user agrees to a real time. The click dispatches `blog:action`; chat-session.js
  // calls schedule-blog / reject-blog-post, the same endpoints Blog Studio uses.
  const BLOG_ACTION_COPY = {
    approve: { head: 'Approve this article', button: 'Approve', busy: 'Approving…' },
    schedule: { head: 'Book this article', button: 'Book it', busy: 'Booking…' },
    unschedule: { head: 'Take this article off the schedule', button: 'Unschedule', busy: 'Clearing the schedule…' },
    // Same two words as the post editor: "Reject and redraft", or — with the replacement box
    // unticked — a reject that writes nothing new (the button follows the box, below).
    reject: { head: 'Reject and redraft', button: 'Reject and redraft', busy: 'Rejecting…' },
    // "Remove": the Blogs tab's word — archived, no rule, no replacement.
    remove: { head: 'Remove this article', button: 'Remove', busy: 'Removing…' },
    // Blog Studio's "Make it shorter" / "Make it longer".
    shorter: { head: 'Make this article shorter', button: 'Make it shorter', busy: 'Rewriting — about a minute…' },
    longer: { head: 'Make this article longer', button: 'Make it longer', busy: 'Rewriting — about a minute…' },
    // The same background rewrite, to the user's own words ("improve it", "bring it up to date").
    revise: { head: 'Revise this article', button: 'Rewrite it', busy: 'Rewriting — about a minute…' },
  };

  function renderBlogActionProposalCard(ui, esc) {
    const copy = BLOG_ACTION_COPY[ui.action];
    const postId = Number(ui.postId);
    if (!copy || !Number.isInteger(postId)) return null;
    const fmt = (iso) => {
      if (!iso) return '';
      const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
      try { return new Date(iso).toLocaleString('en-GB', ui.timezone ? { ...opts, timeZone: ui.timezone } : opts); }
      catch { return new Date(iso).toLocaleString('en-GB', opts); }
    };
    const booked = fmt(ui.publishDate);
    const at = fmt(ui.scheduleAt);
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const canOpen = typeof window.openBlogStudio === 'function';
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">${esc(copy.head)} · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      <p class="text-xs text-gray-500 mt-2">#${postId}${booked ? ` · booked for ${esc(booked)}` : ''}</p>
      ${ui.title ? `<p class="text-sm font-bold text-gray-900 mt-1 break-words">${esc(ui.title)}</p>` : ''}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      ${!blocked && ui.action === 'schedule' ? `<p class="text-sm text-gray-700 mt-3"><span class="font-bold">Goes live:</span> ${esc(at)}</p>
        ${ui.when ? `<p class="text-xs text-gray-500 mt-1">From “${esc(ui.when)}”. If that’s not the time you meant, press Not now and say it again.</p>` : ''}` : ''}
      ${!blocked && ui.action === 'approve' ? '<p class="text-xs text-gray-600 mt-3">Your assistant books it into the next free slot in its posting schedule. It goes live on your blog then, and to any platforms you’ve connected.</p>' : ''}
      ${!blocked && ui.action === 'unschedule' ? '<p class="text-xs text-gray-600 mt-3">It goes back to a draft in the "Review" column and won’t publish until it’s approved again.</p>' : ''}
      ${!blocked && (ui.action === 'shorter' || ui.action === 'longer') ? `<p class="text-xs text-gray-600 mt-3">${ui.action === 'shorter' ? 'About a third shorter — same message, nothing new added.' : 'About half as long again — it develops what the article already says, with no invented facts.'} Pictures and links stay. The title, SEO and schedule don’t change.</p>` : ''}
      ${!blocked && ui.action === 'remove' ? '<p class="text-xs text-gray-600 mt-3">It moves to Archived. Nothing is learned from it and no replacement is written.</p>' : ''}
      ${!blocked && ui.action === 'reject' ? `
        <label class="block text-xs font-bold text-gray-700 mt-3" for="bap-reason-${postId}">What’s wrong with it</label>
        <textarea id="bap-reason-${postId}" data-bap-reason rows="2" maxlength="500" class="mt-1 w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700">${esc(ui.reason || '')}</textarea>
        <label class="flex items-start gap-2 text-xs text-gray-700 mt-2">
          <input type="checkbox" data-bap-rule checked class="mt-0.5">
          <span>Keep this as a rule for future articles</span>
        </label>
        <label class="flex items-start gap-2 text-xs text-gray-700 mt-1">
          <input type="checkbox" data-bap-redraft checked class="mt-0.5">
          <span>Write a replacement for this slot</span>
        </label>` : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-bap-go class="${ui.action === 'reject' || ui.action === 'unschedule' || ui.action === 'remove' ? 'btn-destructive' : 'btn-primary'} min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${esc(copy.button)}</button>
        <button type="button" data-bap-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
        ${canOpen ? '<button type="button" data-bap-open class="btn-swan-link px-1 py-2 text-sm font-bold">Open in Blog Studio</button>' : ''}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-bap-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-bap-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-bap-go], [data-bap-cancel], [data-bap-reason], [data-bap-instruction], [data-bap-rule], [data-bap-redraft]').forEach((x) => { x.disabled = b; });
    el.addEventListener('change', (e) => {
      if (!e.target.matches('[data-bap-redraft]')) return;
      const go = el.querySelector('[data-bap-go]');
      if (go) go.textContent = e.target.checked ? 'Reject and redraft' : 'Reject (no redraft)';
    });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-bap-open]')) { window.openBlogStudio?.({ postId, intent: 'review' }); return; }
      if (e.target.closest('[data-bap-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-bap-go]')) return;
      const reason = el.querySelector('[data-bap-reason]')?.value.trim() || '';
      if (ui.action === 'reject' && !reason) { say('Say what’s wrong with it first — that is what your assistant learns from.', 'error'); return; }
      const instruction = el.querySelector('[data-bap-instruction]')?.value.trim() || '';
      if (ui.action === 'revise' && !instruction) { say('Say what should change first.', 'error'); return; }
      setBusy(true);
      say(copy.busy);
      el.dispatchEvent(new CustomEvent('blog:action', {
        bubbles: true,
        detail: {
          action: ui.action, postId, scheduleAt: ui.scheduleAt || null, timezone: ui.timezone || null, reason, instruction,
          applyAsRule: !!el.querySelector('[data-bap-rule]')?.checked,
          redraft: !!el.querySelector('[data-bap-redraft]')?.checked,
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Done.'); return; }
            setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('blog_action_proposal', renderBlogActionProposalCard);

  // ── Built-in: Email Action Proposal Card (Email Marketing chat) ────────────
  // { type: 'email_action_proposal', action: 'approve'|'schedule'|'reject', issueId, subject, status,
  //   scheduledFor, scheduleAt, timezone, when, blocked, settled? }
  //
  // The Email Studio's Approve, Approve-for-a-time and Reject, from chat. Facts from newsletter_issues
  // (src/utils/chat-email-action.ts); `scheduleAt` is the exact send instant, worked out before the
  // card was shown. The click dispatches `email:action`; chat-session.js calls newsletter-issues —
  // the Studio's own endpoint, so its owner/admin rule and empty-email check apply here too.
  const EMAIL_ACTION_COPY = {
    approve: { head: 'Approve this email', button: 'Approve', busy: 'Approving…' },
    schedule: { head: 'Approve and book this email', button: 'Approve and book', busy: 'Booking…' },
    reject: { head: 'Send this email back to draft', button: 'Back to draft', busy: 'Sending it back…' },
  };

  function renderEmailActionProposalCard(ui, esc) {
    const copy = EMAIL_ACTION_COPY[ui.action];
    const issueId = Number(ui.issueId);
    if (!copy || !Number.isInteger(issueId)) return null;
    const fmt = (iso) => {
      if (!iso) return '';
      const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
      try { return new Date(iso).toLocaleString('en-GB', ui.timezone ? { ...opts, timeZone: ui.timezone } : opts); }
      catch { return new Date(iso).toLocaleString('en-GB', opts); }
    };
    const booked = fmt(ui.scheduledFor);
    const at = fmt(ui.scheduleAt);
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const canOpen = typeof window.loadView === 'function';
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">${esc(copy.head)} · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      <p class="text-xs text-gray-500 mt-2">#${issueId}${booked ? ` · booked for ${esc(booked)}` : ''}</p>
      ${ui.subject ? `<p class="text-sm font-bold text-gray-900 mt-1 break-words">${esc(ui.subject)}</p>` : ''}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      ${!blocked && ui.action === 'schedule' ? `<p class="text-sm text-gray-700 mt-3"><span class="font-bold">Sends:</span> ${esc(at)}</p>
        ${ui.when ? `<p class="text-xs text-gray-500 mt-1">From “${esc(ui.when)}”. If that’s not the time you meant, press Not now and say it again.</p>` : ''}
        <p class="text-xs text-gray-600 mt-2">It goes to the list chosen in the Email Studio. Open it there first if you want to check who gets it.</p>` : ''}
      ${!blocked && ui.action === 'approve' ? '<p class="text-xs text-gray-600 mt-3">It moves to the "Approved" column and waits there. Nothing is sent until you send or schedule it.</p>' : ''}
      ${!blocked && ui.action === 'reject' ? '<p class="text-xs text-gray-600 mt-3">It goes back to a draft in "Review" and won’t be sent. Any send time it had is dropped.</p>' : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-eap-go class="${ui.action === 'reject' ? 'btn-destructive' : 'btn-primary'} min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${esc(copy.button)}</button>
        <button type="button" data-eap-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
        ${canOpen ? '<button type="button" data-eap-open class="btn-swan-link px-1 py-2 text-sm font-bold">Open in the Email Studio</button>' : ''}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-eap-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-eap-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-eap-go], [data-eap-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-eap-open]')) {
        window._newsletterInitialIssueId = issueId;
        window._newsletterAssistantId = window._currentAssistantId || null;
        window.loadView?.('newsletter');
        return;
      }
      if (e.target.closest('[data-eap-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-eap-go]')) return;
      // The time was checked when the card was made; it may have passed while the card sat here.
      if (ui.action === 'schedule' && (!ui.scheduleAt || new Date(ui.scheduleAt).getTime() <= Date.now())) {
        say('That time has passed. Ask again with a new one.', 'error');
        return;
      }
      setBusy(true);
      say(copy.busy);
      el.dispatchEvent(new CustomEvent('email:action', {
        bubbles: true,
        detail: {
          action: ui.action, issueId, scheduleAt: ui.scheduleAt || null, timezone: ui.timezone || null,
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Done.'); return; }
            setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('email_action_proposal', renderEmailActionProposalCard);

  // ── Built-in: Audience cards (Email Marketing chat) ───────────────────────
  // { type: 'audience_segment_proposal', name, rules, description, matches, blocked, settled? }
  // { type: 'audience_contact_proposal', email, firstName, lastName, company, segmentId, segmentName,
  //   blocked, settled? }
  //
  // The Audience page's "Rule-based segment" and "Add contact", from chat. Facts from the
  // organisation's rows (src/utils/chat-audience.ts): the segment's description and count come from
  // the rule builder's own preview, and a contact who is already in the audience or opted out never
  // gets a button. The click dispatches `audience:action`; chat-session.js calls audience-segments /
  // audience-contacts — the page's own endpoints. A contact also needs the consent box ticked.
  function renderAudienceProposalCard(ui, esc) {
    const isSegment = ui.type === 'audience_segment_proposal';
    if (isSegment ? !ui.name : !ui.email) return null;
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const head = isSegment ? 'New segment' : 'Add to your audience';
    const person = [ui.firstName, ui.lastName].filter(Boolean).join(' ');
    const matches = Number(ui.matches);
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">${esc(head)} · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      ${isSegment
        ? `<p class="text-sm font-bold text-gray-900 mt-2 break-words">${esc(ui.name)}</p>
           ${ui.description ? `<p class="text-sm text-gray-700 mt-1">${esc(ui.description)}</p>` : ''}
           ${!blocked && Number.isFinite(matches) ? `<p class="text-sm text-gray-900 mt-3"><span class="font-bold">${matches.toLocaleString()}</span> subscribed ${matches === 1 ? 'person matches' : 'people match'} right now.</p>
             <p class="text-xs text-gray-600 mt-1">Members are worked out from the rule every time you send, so it never goes stale.</p>` : ''}`
        : `<p class="text-sm font-bold text-gray-900 mt-2 break-words">${esc(ui.email)}</p>
           ${person || ui.company ? `<p class="text-sm text-gray-700 mt-1">${esc([person, ui.company].filter(Boolean).join(' · '))}</p>` : ''}
           ${ui.segmentName ? `<p class="text-xs text-gray-600 mt-1">Also added to “${esc(ui.segmentName)}”.</p>` : ''}`}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      ${!blocked && !isSegment ? `<label class="flex items-start gap-2 mt-3 text-sm text-gray-800 cursor-pointer">
          <input type="checkbox" data-aud-consent class="mt-0.5 rounded border-gray-300 text-emerald-700 focus:ring-emerald-700">
          <span>They agreed to hear from me. This is recorded against my account.</span>
        </label>` : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-aud-go class="btn-primary min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${isSegment ? 'Save segment' : 'Add contact'}</button>
        <button type="button" data-aud-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
        ${typeof window.loadView === 'function' ? '<button type="button" data-aud-open class="btn-swan-link px-1 py-2 text-sm font-bold">Open the Audience page</button>' : ''}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-aud-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-aud-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-aud-go], [data-aud-cancel], [data-aud-consent]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-aud-open]')) { window.loadView?.('audience'); return; }
      if (e.target.closest('[data-aud-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-aud-go]')) return;
      const consent = el.querySelector('[data-aud-consent]');
      if (!isSegment && !consent?.checked) { say('Tick the box first — only add people who agreed to hear from you.', 'error'); consent?.focus(); return; }
      setBusy(true);
      say(isSegment ? 'Saving…' : 'Adding…');
      el.dispatchEvent(new CustomEvent('audience:action', {
        bubbles: true,
        detail: {
          kind: isSegment ? 'segment' : 'contact',
          name: ui.name, rules: ui.rules,
          email: ui.email, firstName: ui.firstName || null, lastName: ui.lastName || null, company: ui.company || null,
          segmentId: ui.segmentId || null, segmentName: ui.segmentName || null, consented: !!consent?.checked,
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Done.'); return; }
            setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('audience_segment_proposal', renderAudienceProposalCard);
  register('audience_contact_proposal', renderAudienceProposalCard);

  // ── Built-in: Lead Action Proposal Card (Lead Generation chat) ─────────────
  // { type: 'lead_action_proposal', action: 'send'|'move_to_outreach'|'reject'|'set_outcome', recordId,
  //   assistantId, title, rating, approvalStatus, to, subject, body, signature, footerName,
  //   footerAddress, personalInbox, approveFirst, draftHash, followUps, hasEmail, outcome,
  //   outcomeLabel, lossReason, lossReasonLabel, valueGbp, currentOutcome, blocked, settled? }
  //
  // The Enrichment, Outreach and Conversations buttons, from chat. Every fact comes from the lead's
  // row (src/utils/chat-lead-action.ts) — for "send", the stored email word for word, which is the
  // owner's condition for letting the chat send at all: nothing reaches a stranger that was not on
  // this card. The click dispatches `lead:action`; chat-session.js calls the tabs' own endpoints.
  const LEAD_ACTION_COPY = {
    send: { head: 'Send this outreach email', busy: 'Sending…' },
    improve: { head: 'Improve this outreach email', button: 'Rewrite it', busy: 'Rewriting…' },
    move_to_outreach: { head: 'Move this lead to Outreach', button: 'Move to Outreach', busy: 'Moving…' },
    reject: { head: 'Turn this lead down', button: 'Turn it down', busy: 'Turning it down…' },
    set_outcome: { head: 'Record how this deal ended', busy: 'Recording…' },
  };

  // "Approve all" (send_all): every email on the card, word for word, and ONE button. The click
  // dispatches `lead:action` with the items; chat-session.js runs them through LeadBulkSend
  // (src/components/lead-bulk-send.js), the same run as the Outreach tab's bulk bar.
  function renderLeadBulkSendCard(ui, esc) {
    const items = Array.isArray(ui.items) ? ui.items : [];
    const skipped = Array.isArray(ui.skipped) ? ui.skipped : [];
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const n = items.length;
    const emails = items.map((it, i) => `
      <details class="rounded-lg border border-gray-200 bg-gray-50" ${i === 0 ? 'open' : ''}>
        <summary class="cursor-pointer px-3 py-2 text-sm">
          <span class="font-bold text-gray-900 break-words">${esc(it.title || `#${it.recordId}`)}</span>
          <span class="block text-xs text-gray-600 break-all">To ${esc(it.to || 'no address')} · ${esc(it.subject || '')}</span>
        </summary>
        <div class="px-3 pb-3">
          <p class="text-sm text-gray-900 whitespace-pre-wrap break-words">${esc(it.body || '')}</p>
          ${ui.signature ? `<p class="text-sm text-gray-700 whitespace-pre-wrap break-words mt-3">${esc(ui.signature)}</p>` : ''}
        </div>
      </details>`).join('');
    const skippedHtml = skipped.length ? `
      <div class="mt-3">
        <p class="text-sm font-bold text-gray-900">Not on this card (${skipped.length})</p>
        <ul class="mt-1 space-y-1">${skipped.map((x) => `<li class="text-xs text-gray-700"><span class="font-bold">${esc(x.title || `#${x.recordId}`)}</span> — ${esc(x.why || '')}</li>`).join('')}</ul>
      </div>` : '';
    const f = ui.followUps;
    const followHtml = blocked || !n ? ''
      : f && f.enabled && Array.isArray(f.steps) && f.steps.length
        ? `<p class="mt-3 text-xs text-gray-700">If a lead doesn’t reply, up to ${f.steps.length} follow-up${f.steps.length === 1 ? '' : 's'} go automatically (day ${f.steps.map((st) => esc(String(st.daysAfterOpener))).join(', ')}), each written when it’s due and stopped the moment they reply.</p>`
        : f && !f.enabled ? '<p class="mt-3 text-xs text-gray-600">No follow-ups: this assistant is set to send one email only.</p>'
        : '<p class="mt-3 text-xs text-amber-800">I couldn’t check whether follow-ups would start. If this assistant chases automatically, more emails follow unless they reply.</p>';
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-lg';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">Approve &amp; send ${n === 1 ? '1 email' : `${n} emails`} · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      ${n ? `<p class="text-xs text-gray-600 mt-2">Each email below goes exactly as shown — tap one to read it. Added at the bottom of each: ${ui.signature ? 'your signature, then ' : ''}a one-click unsubscribe line and ${esc(ui.footerName || 'your business name')}${ui.footerAddress ? `, ${esc(ui.footerAddress)}` : ' and postal address'}.</p>
      <div class="mt-3 space-y-2 max-h-96 overflow-y-auto" tabindex="0" aria-label="The emails that will be sent">${emails}</div>` : ''}
      ${ui.more ? `<p class="mt-2 text-xs text-gray-600">${esc(String(ui.more))} more are waiting — ask again once these have gone.</p>` : ''}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      ${skippedHtml}
      ${followHtml}
      ${blocked ? '' : `<p class="text-xs text-gray-600 mt-3">Pressing the button approves ${n === 1 ? 'this lead' : `these ${n} leads`} and sends ${n === 1 ? 'its email' : 'their emails'} now from your connected inbox, one after another.</p>`}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-lap-go class="btn-golive min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${n === 1 ? 'Approve &amp; send email' : `Approve &amp; send ${n} emails`}</button>
        <button type="button" data-lap-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-lap-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-lap-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-lap-go], [data-lap-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-lap-cancel]')) { setBusy(true); say('Left as they are.'); return; }
      if (!e.target.closest('[data-lap-go]')) return;
      setBusy(true);
      say(`Sending 1 of ${n}…`);
      el.dispatchEvent(new CustomEvent('lead:action', {
        bubbles: true,
        detail: {
          action: 'send_all', assistantId: Number(ui.assistantId) || null,
          items: items.map((it) => ({ recordId: Number(it.recordId), title: it.title, draftHash: it.draftHash, approveFirst: true })),
          progress(done) { say(`Sending ${Math.min(done + 1, n)} of ${n}…`); },
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Done.'); return; }
            say(error || 'That didn’t work.', 'error');
          },
        },
      }));
    });
    return el;
  }

  function renderLeadActionProposalCard(ui, esc) {
    if (ui.action === 'send_all') return renderLeadBulkSendCard(ui, esc);
    const copy = LEAD_ACTION_COPY[ui.action];
    const recordId = Number(ui.recordId);
    if (!copy || !Number.isInteger(recordId)) return null;
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const isSend = ui.action === 'send';
    const gbp = (n) => `£${Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
    const buttonLabel = isSend ? (ui.approveFirst ? 'Approve & send email' : 'Send email now')
      : ui.action === 'set_outcome' ? `Mark as ${ui.outcomeLabel || ui.outcome}`
      : copy.button;
    const buttonCls = ui.action === 'reject' ? 'btn-destructive' : isSend ? 'btn-golive' : 'btn-primary';

    // The email, exactly as send_outreach will send it: the stored draft, then the signature, then
    // the footer the server appends. Shown even when blocked — it is what the user asked about.
    const isImprove = ui.action === 'improve';
    const improveHtml = isImprove && ui.body ? `
      <p class="text-xs text-gray-600 mt-3">The email as it is now — to ${esc(ui.to || 'no address')}:</p>
      <div class="mt-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 max-h-56 overflow-y-auto" tabindex="0">
        <p class="text-xs font-bold text-gray-900 break-words">${esc(ui.subject || '')}</p>
        <p class="text-sm text-gray-900 whitespace-pre-wrap break-words mt-1">${esc(ui.body)}</p>
      </div>
      <p class="text-sm text-gray-800 mt-2"><span class="font-bold">What to change:</span> ${esc(ui.instruction || 'improve it generally')}</p>` : '';
    const emailHtml = isSend && ui.body ? `
      <dl class="mt-3 text-sm space-y-1">
        <div class="flex gap-2"><dt class="font-bold text-gray-700 shrink-0">To:</dt><dd class="text-gray-900 break-all">${esc(ui.to || 'no address')}</dd></div>
        <div class="flex gap-2"><dt class="font-bold text-gray-700 shrink-0">Subject:</dt><dd class="text-gray-900 break-words">${esc(ui.subject || '')}</dd></div>
      </dl>
      ${ui.personalInbox && !blocked ? `<p class="mt-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">This address looks like a named person’s own inbox — it was found for this company, not given to you by them. Pressing the button below confirms you’re happy to email this person.</p>` : ''}
      <div class="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 max-h-72 overflow-y-auto" tabindex="0" aria-label="The email that will be sent">
        <p class="text-sm text-gray-900 whitespace-pre-wrap break-words">${esc(ui.body)}</p>
        ${ui.signature ? `<p class="text-sm text-gray-700 whitespace-pre-wrap break-words mt-3">${esc(ui.signature)}</p>` : ''}
        <p class="text-xs text-gray-500 mt-3">Added at the very bottom, as the law requires: a one-click unsubscribe line and ${esc(ui.footerName || 'your business name')}${ui.footerAddress ? `, ${esc(ui.footerAddress)}` : ' and postal address'}.</p>
      </div>` : '';

    let followHtml = '';
    if (isSend && !blocked) {
      const f = ui.followUps;
      if (f && f.enabled && Array.isArray(f.steps) && f.steps.length) {
        followHtml = `
          <div class="mt-3">
            <p class="text-sm font-bold text-gray-900">If they don’t reply: ${f.steps.length} follow-up${f.steps.length === 1 ? '' : 's'}, sent automatically</p>
            <ol class="mt-1 space-y-1.5">
              ${f.steps.map((st) => `<li class="text-xs text-gray-700"><span class="font-bold text-gray-900">Day ${esc(String(st.daysAfterOpener))}:</span> ${esc(st.brief)}</li>`).join('')}
            </ol>
            <p class="text-xs text-gray-500 mt-1.5">These aren’t written yet — each one is written when it’s due, from the brief above, and they stop the moment they reply. To send one email only, change “Chase leads who do not reply?” in Assistant Profile.</p>
          </div>`;
      } else if (f && !f.enabled) {
        followHtml = '<p class="mt-3 text-xs text-gray-600">No follow-ups: this assistant is set to send one email only.</p>';
      } else {
        followHtml = '<p class="mt-3 text-xs text-amber-800">I couldn’t check whether follow-ups would start. If this assistant chases automatically, its follow-up plan sends more emails unless they reply.</p>';
      }
    }

    let actionHtml = '';
    if (!blocked) {
      if (isSend) actionHtml = `<p class="text-xs text-gray-600 mt-3">${ui.approveFirst ? 'Pressing the button approves the lead and sends this email now' : 'Pressing the button sends this email now'} from your connected inbox, then sets a reminder to chase.</p>`;
      if (isImprove) actionHtml = '<p class="text-xs text-gray-600 mt-3">Pressing the button rewrites this email and saves it on the Outreach tab. Nothing is sent — read the new version there, or ask me to send it.</p>';
      if (ui.action === 'move_to_outreach') actionHtml = `<p class="text-xs text-gray-600 mt-3">It moves to the Outreach tab’s Review column. ${ui.hasEmail ? 'Its drafted email waits there for you to read.' : 'It has no email written or no address yet, so there will be nothing to send until it does.'} Nothing is sent.</p>`;
      if (ui.action === 'reject') actionHtml = '<p class="text-xs text-gray-600 mt-3">It’s turned down and nothing is sent. Turned-down leads teach your searches what to skip.</p>';
      if (ui.action === 'set_outcome') {
        actionHtml = `<p class="text-sm text-gray-700 mt-3"><span class="font-bold">${esc(ui.outcomeLabel || ui.outcome || '')}</span>${ui.lossReasonLabel ? ` — ${esc(ui.lossReasonLabel)}` : ''}${ui.valueGbp != null ? ` · ${esc(gbp(ui.valueGbp))}` : ''}</p>
          ${ui.currentOutcome ? `<p class="text-xs text-amber-800 mt-1">It’s marked ${esc(ui.currentOutcome)} now — this changes it.</p>` : ''}
          <p class="text-xs text-gray-600 mt-1">Any follow-ups still running for this lead stop.</p>`;
      }
    }

    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-lg';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">${esc(copy.head)} · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      <p class="text-xs text-gray-500 mt-2">#${recordId}${ui.rating ? ` · ${esc(ui.rating)}` : ''}</p>
      ${ui.title ? `<p class="text-sm font-bold text-gray-900 mt-1 break-words">${esc(ui.title)}</p>` : ''}
      ${emailHtml}${improveHtml}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      ${followHtml}
      ${actionHtml}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-lap-go class="${buttonCls} min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${esc(buttonLabel)}</button>
        <button type="button" data-lap-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-lap-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-lap-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-lap-go], [data-lap-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-lap-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-lap-go]')) return;
      setBusy(true);
      say(copy.busy);
      el.dispatchEvent(new CustomEvent('lead:action', {
        bubbles: true,
        detail: {
          action: ui.action, recordId, assistantId: Number(ui.assistantId) || null,
          draftHash: ui.draftHash || null, personalInbox: !!ui.personalInbox, approveFirst: !!ui.approveFirst,
          outcome: ui.outcome || null, lossReason: ui.lossReason || null, valueGbp: ui.valueGbp ?? null,
          instruction: ui.instruction || null,
          confirmChange: !!ui.currentOutcome,
          respond({ ok, message, error, final }) {
            if (ok) { say(message || 'Done.'); return; }
            // A refusal that settles the matter (the draft changed, it was already sent) keeps the
            // button off; a failure worth retrying gives it back.
            if (!final) setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('lead_action_proposal', renderLeadActionProposalCard);

  // ── Built-in: Discussion Action Proposal Card (Lead Generation chat) ───────
  // { type: 'discussion_action_proposal', action: 'set_watch'|'scan_now'|'redraft'|'mark_replied'|'dismiss',
  //   assistantId, current?, proposed?, discussionId?, title?, url?, siteLabel?, draftReply?, instruction?,
  //   blocked, settled? }
  //
  // The Discussions tab's buttons, from chat. Every fact comes from the rows
  // (src/utils/chat-discussion-action.ts). The click dispatches `discussion:action`; chat-session.js
  // calls discussions.ts, the endpoint the tab uses. Nothing here posts to any site.
  const DISCUSSION_ACTION_COPY = {
    set_watch: { head: 'Change what Discussions watches', button: 'Save', busy: 'Saving…' },
    scan_now: { head: 'Scan for discussions now', button: 'Scan now', busy: 'Starting…' },
    redraft: { head: 'Rewrite this reply', button: 'Rewrite it', busy: 'Rewriting…' },
    mark_replied: { head: 'Mark this thread replied', button: 'Mark replied', busy: 'Saving…' },
    dismiss: { head: 'Dismiss this thread', button: 'Dismiss', busy: 'Dismissing…' },
  };

  function renderDiscussionActionProposalCard(ui, esc) {
    const copy = DISCUSSION_ACTION_COPY[ui.action];
    if (!copy) return null;
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const list = (xs) => (Array.isArray(xs) && xs.length ? xs.map((x) => esc(String(x))).join(', ') : 'none');
    let bodyHtml = '';
    if (ui.action === 'set_watch' && ui.proposed) {
      const p = ui.proposed;
      const c = ui.current || {};
      bodyHtml = `
        <dl class="mt-3 text-sm space-y-2">
          <div><dt class="font-bold text-gray-700">Topics</dt><dd class="text-gray-900 break-words">${list(p.topics)}</dd>
            ${c.topics && c.topics.length ? `<dd class="text-xs text-gray-500 break-words">Now: ${list(c.topics)}</dd>` : ''}</div>
          <div><dt class="font-bold text-gray-700">Sites</dt><dd class="text-gray-900">${list(p.siteLabels)}</dd></div>
          <div><dt class="font-bold text-gray-700">Daily scan</dt><dd class="text-gray-900">${p.enabled ? 'On' : 'Off'}</dd></div>
        </dl>
        <p class="text-xs text-gray-600 mt-3">Saving changes what the daily scan looks for. It posts nothing — you reply to threads yourself.</p>`;
    } else if (ui.action === 'scan_now') {
      const c = ui.current || {};
      bodyHtml = `<p class="text-sm text-gray-800 mt-3">Searches ${list(c.sites)} for the last week of threads about ${list(c.topics)}.</p>
        <p class="text-xs text-gray-600 mt-2">Costs one task. New threads land on the Discussions tab in a minute or two, each with a drafted reply. Nothing is posted.</p>`;
    } else if (ui.title) {
      bodyHtml = `
        <p class="text-xs text-gray-500 mt-2">#${esc(String(ui.discussionId))} · ${esc(ui.siteLabel || '')}</p>
        <p class="text-sm font-bold text-gray-900 mt-1 break-words">${ui.url ? `<a href="${esc(ui.url)}" target="_blank" rel="noopener noreferrer" class="underline">${esc(ui.title)}</a>` : esc(ui.title)}</p>
        ${ui.draftReply ? `<p class="text-xs text-gray-600 mt-3">${ui.action === 'redraft' ? 'The reply as it is now:' : 'The drafted reply:'}</p>
        <div class="mt-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 max-h-56 overflow-y-auto" tabindex="0"><p class="text-sm text-gray-900 whitespace-pre-wrap break-words">${esc(ui.draftReply)}</p></div>` : ''}
        ${ui.action === 'redraft' ? `<p class="text-sm text-gray-800 mt-2"><span class="font-bold">What to change:</span> ${esc(ui.instruction || 'improve it generally')}</p>
        <p class="text-xs text-gray-600 mt-2">Pressing the button rewrites the reply on the Discussions tab, disclosure line included. Nothing is posted.</p>` : ''}
        ${ui.action === 'mark_replied' ? '<p class="text-xs text-gray-600 mt-2">Only mark it once you’ve posted the reply yourself — this just files the thread under Replied.</p>' : ''}
        ${ui.action === 'dismiss' ? '<p class="text-xs text-gray-600 mt-2">It moves to Dismissed and won’t be suggested again. You can put it back from there.</p>' : ''}`;
    }
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-lg';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">${esc(copy.head)} · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      ${bodyHtml}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-dap-go class="${ui.action === 'dismiss' ? 'btn-secondary border' : 'btn-primary'} min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${esc(copy.button)}</button>
        <button type="button" data-dap-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-dap-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-dap-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-dap-go], [data-dap-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-dap-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-dap-go]')) return;
      setBusy(true);
      say(copy.busy);
      el.dispatchEvent(new CustomEvent('discussion:action', {
        bubbles: true,
        detail: {
          action: ui.action, assistantId: Number(ui.assistantId) || null,
          discussionId: Number(ui.discussionId) || null, instruction: ui.instruction || null,
          proposed: ui.proposed || null,
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Done.'); return; }
            setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('discussion_action_proposal', renderDiscussionActionProposalCard);

  // ── Built-in: Assistant Settings Proposal Card (every structured chat) ─────
  // { type: 'assistant_settings_proposal', setting: 'pause'|'resume'|'draft_horizon'|'review_alerts'|
  //   'content_suggestions', assistantId, assistantName, current, proposed, days, value, enabled,
  //   monthlyCap, blocked, settled? }
  // A change to the assistant's OWN settings. Every fact on it was read from its row by the
  // orchestrator (src/utils/chat-assistant-settings.ts). The click dispatches `settings:change`;
  // chat-session.js calls the endpoint the Assistant Profile uses for that setting.
  const SETTINGS_COPY = {
    pause: { head: 'Pause this assistant', button: 'Yes, pause', busy: 'Pausing…', danger: true },
    resume: { head: 'Start this assistant', button: 'Start it', busy: 'Starting…' },
    draft_horizon: { head: 'Generate posts ahead', button: 'Save', busy: 'Saving…' },
    review_alerts: { head: 'Review alerts', button: 'Save', busy: 'Saving…' },
    content_suggestions: { head: 'Autonomous Content Suggestions', button: 'Save', busy: 'Saving…' },
  };

  function renderAssistantSettingsProposalCard(ui, esc) {
    const copy = SETTINGS_COPY[ui.setting];
    const assistantId = Number(ui.assistantId);
    if (!copy || !Number.isInteger(assistantId)) return null;
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">${esc(copy.head)} · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      ${ui.assistantName ? `<p class="text-xs text-gray-500 mt-2">${esc(ui.assistantName)}</p>` : ''}
      ${ui.current ? `<p class="text-sm text-gray-700 mt-2"><span class="font-bold">Now:</span> ${esc(ui.current)}</p>` : ''}
      ${!blocked && ui.proposed ? `<p class="text-sm text-gray-900 mt-1"><span class="font-bold">After:</span> ${esc(ui.proposed)}</p>` : ''}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      ${!blocked && ui.setting === 'pause' ? '<p class="text-xs text-gray-600 mt-3">It stops all actions until you start it again. Nothing it has already scheduled is deleted.</p>' : ''}
      ${!blocked && ui.setting === 'draft_horizon' ? '<p class="text-xs text-gray-600 mt-3">Further ahead: it drafts more straight away. Shorter: unreviewed drafts beyond the new window are archived.</p>' : ''}
      ${!blocked && ui.setting === 'content_suggestions' ? '<p class="text-xs text-gray-600 mt-3">It stops when your monthly tasks run out — you are never charged extra.</p>' : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-asp-go class="${copy.danger ? 'btn-destructive' : 'btn-primary'} min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${esc(copy.button)}</button>
        <button type="button" data-asp-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-asp-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-asp-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-asp-go], [data-asp-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-asp-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-asp-go]')) return;
      setBusy(true);
      say(copy.busy);
      el.dispatchEvent(new CustomEvent('settings:change', {
        bubbles: true,
        detail: {
          setting: ui.setting, assistantId,
          days: ui.days ?? null, value: ui.value ?? null, enabled: ui.enabled ?? null, monthlyCap: ui.monthlyCap ?? null,
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Done.'); return; }
            setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('assistant_settings_proposal', renderAssistantSettingsProposalCard);

  // ── Built-in: Rule Proposal Card (every structured chat) ──────────────────
  // { type: 'rule_proposal', action: 'add'|'edit'|'turn_off'|'turn_on'|'delete', assistantId, ruleId,
  //   currentText, ruleText, platform, platformLabel, isActive, blocked, settled? }
  // A change to the assistant's Do's and don'ts, checked against content_rules by the orchestrator
  // (src/utils/chat-rules.ts). The click dispatches `rule:change`; chat-session.js calls
  // content-rules.ts — the endpoint the Do's and don'ts card uses.
  const RULE_COPY = {
    add: { head: 'Add a rule', button: 'Save rule', busy: 'Saving…' },
    edit: { head: 'Reword a rule', button: 'Save', busy: 'Saving…' },
    turn_off: { head: 'Switch a rule off', button: 'Switch off', busy: 'Switching off…' },
    turn_on: { head: 'Switch a rule back on', button: 'Switch on', busy: 'Switching on…' },
    delete: { head: 'Delete a rule', button: 'Delete rule', busy: 'Deleting…', danger: true },
  };

  function renderRuleProposalCard(ui, esc) {
    const copy = RULE_COPY[ui.action];
    const assistantId = Number(ui.assistantId);
    if (!copy || !Number.isInteger(assistantId)) return null;
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const ruleNo = Number.isInteger(Number(ui.ruleId)) && ui.ruleId ? `#${Number(ui.ruleId)}` : '';
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">${esc(copy.head)} · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      <p class="text-xs text-gray-500 mt-2">Do’s and don’ts${ruleNo ? ` · rule ${ruleNo}` : ''}${ui.platformLabel ? ` · only for ${esc(ui.platformLabel)}` : ''}</p>
      ${ui.currentText ? `<p class="text-sm text-gray-700 mt-2 break-words"><span class="font-bold">${ui.action === 'edit' ? 'Now:' : 'Rule:'}</span> ${esc(ui.currentText)}</p>` : ''}
      ${ui.ruleText && (ui.action === 'add' || ui.action === 'edit') ? `<p class="text-sm text-gray-900 mt-1 break-words"><span class="font-bold">${ui.action === 'edit' ? 'After:' : 'Rule:'}</span> ${esc(ui.ruleText)}</p>` : ''}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      ${!blocked && ui.action === 'turn_off' ? '<p class="text-xs text-gray-600 mt-3">It is kept, and can be switched back on any time.</p>' : ''}
      ${!blocked && ui.action === 'delete' ? '<p class="text-xs text-gray-600 mt-3">This removes it for good. To stop it for now instead, switch it off.</p>' : ''}
      ${!blocked && (ui.action === 'add' || ui.action === 'edit') ? '<p class="text-xs text-gray-600 mt-3">Your assistant follows it in everything it does from your next message.</p>' : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-rp-go class="${copy.danger ? 'btn-destructive' : 'btn-primary'} min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${esc(copy.button)}</button>
        <button type="button" data-rp-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-rp-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-rp-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-rp-go], [data-rp-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-rp-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-rp-go]')) return;
      setBusy(true);
      say(copy.busy);
      el.dispatchEvent(new CustomEvent('rule:change', {
        bubbles: true,
        detail: {
          action: ui.action, assistantId, ruleId: ui.ruleId ?? null, ruleText: ui.ruleText ?? null, platform: ui.platform ?? null,
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Done.'); return; }
            setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('rule_proposal', renderRuleProposalCard);

  // ── Built-in: Goal Proposal Card (every structured chat) ──────────────────
  // { type: 'goal_proposal', action: 'create'|'update'|'delete', assistantId, goalId, metricKey,
  //   metricLabel, unit, current, proposed, targetValue, targetDate, title?, isPrimary?, blocked, settled? }
  // Checked with manage-goals.ts's own rules (src/utils/chat-goals.ts), realism included. The click
  // dispatches `goal:change`; chat-session.js calls manage-goals.ts as the Results tab does.
  const GOAL_COPY = {
    create: { head: 'Set a goal', button: 'Set goal', busy: 'Saving…' },
    update: { head: 'Change a goal', button: 'Save', busy: 'Saving…' },
    delete: { head: 'Delete a goal', button: 'Delete goal', busy: 'Deleting…', danger: true },
  };

  function renderGoalProposalCard(ui, esc) {
    const copy = GOAL_COPY[ui.action];
    const assistantId = Number(ui.assistantId);
    if (!copy || !Number.isInteger(assistantId)) return null;
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    // Set when the Business Mentor proposes it for another assistant (chat-goals.ts resolveTeamGoalProposal).
    const who = typeof ui.assistantName === 'string' && ui.assistantName.trim() ? ui.assistantName.trim() : '';
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">${esc(copy.head)} · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      <p class="text-xs text-gray-500 mt-2">${who ? `${esc(who)}’s ` : ''}Results tab${ui.goalId ? ` · goal #${Number(ui.goalId)}` : ''}${ui.metricLabel ? ` · ${esc(ui.metricLabel)}` : ''}</p>
      ${ui.current ? `<p class="text-sm text-gray-700 mt-2 break-words"><span class="font-bold">${ui.action === 'delete' ? 'Goal:' : 'Now:'}</span> ${esc(ui.current)}</p>` : ''}
      ${ui.proposed && ui.action !== 'delete' ? `<p class="text-sm text-gray-900 mt-1 break-words"><span class="font-bold">${ui.action === 'create' ? 'Goal:' : 'After:'}</span> ${esc(ui.proposed)}</p>` : ''}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      ${!blocked && ui.action !== 'delete' ? `<p class="text-xs text-gray-600 mt-3">${who ? esc(who) : 'Your assistant'} steers what it drafts toward this from now on.</p>` : ''}
      ${!blocked && ui.action === 'delete' ? '<p class="text-xs text-gray-600 mt-3">This removes the goal and its progress for good.</p>' : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-gp-go class="${copy.danger ? 'btn-destructive' : 'btn-primary'} min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${esc(copy.button)}</button>
        <button type="button" data-gp-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-gp-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-gp-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-gp-go], [data-gp-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-gp-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-gp-go]')) return;
      setBusy(true);
      say(copy.busy);
      el.dispatchEvent(new CustomEvent('goal:change', {
        bubbles: true,
        detail: {
          action: ui.action, assistantId, goalId: ui.goalId ?? null, metricKey: ui.metricKey ?? null,
          targetValue: ui.targetValue ?? null, targetDate: ui.targetDate ?? null,
          // Stored cards drop undefined: absent = unchanged, null = clear the name.
          title: Object.prototype.hasOwnProperty.call(ui, 'title') ? ui.title : undefined,
          isPrimary: typeof ui.isPrimary === 'boolean' ? ui.isPrimary : undefined,
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Done.'); return; }
            setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('goal_proposal', renderGoalProposalCard);

  // ── Built-in: Schedule Proposal Card (Social Media / Blog Writer chats) ────
  // { type: 'schedule_proposal', assistantId, current, proposed, set, blocked, settled? }
  // `set` holds only the onboarding_context keys that change (src/utils/chat-schedule.ts). The click
  // dispatches `schedule:change`; chat-session.js reads the current context and saves it through
  // update-assistant-context.ts, as the Posting Schedule card does.
  function renderScheduleProposalCard(ui, esc) {
    const assistantId = Number(ui.assistantId);
    if (!Number.isInteger(assistantId) || !ui.set || typeof ui.set !== 'object') return null;
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">Posting schedule · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      ${ui.current ? `<p class="text-sm text-gray-700 mt-2 break-words"><span class="font-bold">Now:</span> ${esc(ui.current)}</p>` : ''}
      ${!blocked && ui.proposed ? `<p class="text-sm text-gray-900 mt-1 break-words"><span class="font-bold">After:</span> ${esc(ui.proposed)}</p>` : ''}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      ${!blocked ? '<p class="text-xs text-gray-600 mt-3">New drafts follow it from now on. Posts already booked keep their times.</p>' : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-sp-go class="btn-primary min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Save schedule</button>
        <button type="button" data-sp-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-sp-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-sp-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-sp-go], [data-sp-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-sp-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-sp-go]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('schedule:change', {
        bubbles: true,
        detail: {
          assistantId, set: ui.set,
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Saved.'); return; }
            setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('schedule_proposal', renderScheduleProposalCard);

  // ── Built-in: Platforms Proposal Card (chats whose Connections card has the switches) ────
  // { type: 'platforms_proposal', assistantId, nowOn, afterOn, changes, before, linked, codes, blocked, settled? }
  // Built by src/utils/chat-platforms.ts. The click dispatches `platforms:change`; chat-session.js
  // saves the lists through update-assistant-context.ts, as the "Use for this assistant" switch does.
  function renderPlatformsProposalCard(ui, esc) {
    const assistantId = Number(ui.assistantId);
    if (!Number.isInteger(assistantId) || !Array.isArray(ui.linked)) return null;
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const list = (a) => (Array.isArray(a) && a.length ? a.map((x) => esc(String(x))).join(', ') : 'none');
    const changes = Array.isArray(ui.changes) ? ui.changes : [];
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">Where I post · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      ${!blocked && changes.length ? `<ul class="mt-2 space-y-1">${changes.map((c) => `<li class="text-sm text-gray-900 break-words"><span class="font-bold">${c.on ? 'Turn on' : 'Turn off'}:</span> ${esc(String(c.platform))}</li>`).join('')}</ul>` : ''}
      <p class="text-sm text-gray-700 mt-2 break-words"><span class="font-bold">On now:</span> ${list(ui.nowOn)}</p>
      ${!blocked ? `<p class="text-sm text-gray-900 mt-1 break-words"><span class="font-bold">After:</span> ${list(ui.afterOn)}</p>` : ''}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      ${!blocked ? '<p class="text-xs text-gray-600 mt-3">New drafts follow this from now on. Posts already drafted or booked keep their place.</p>' : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-pp-go class="btn-primary min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Save</button>
        <button type="button" data-pp-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-pp-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-pp-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-pp-go], [data-pp-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-pp-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-pp-go]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('platforms:change', {
        bubbles: true,
        detail: {
          assistantId, before: ui.before || [], linked: ui.linked, codes: ui.codes || [],
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Saved.'); return; }
            setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('platforms_proposal', renderPlatformsProposalCard);

  // ── Built-in: Site Directory Card (every structured chat) ────────────────────────────────
  // { type: 'site_directory', action: 'refresh'|'exclude'|'include', path, pageTitle, sourceUrl, blocked, settled? }
  // Built by src/utils/chat-site-directory.ts. The click POSTs to site-directory.ts — the same action
  // as Business Information ▸ Website Pages (docs/site-directory-plan.md §7).
  function renderSiteDirectoryCard(ui, esc) {
    const action = ui.action === 'exclude' || ui.action === 'include' ? ui.action : 'refresh';
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const page = ui.pageTitle ? `${esc(String(ui.pageTitle))} <span class="text-gray-500">(${esc(String(ui.path || ''))})</span>` : esc(String(ui.path || ''));
    const what = action === 'refresh'
      ? `Re-read ${ui.sourceUrl ? esc(String(ui.sourceUrl)) : 'your website'} so every assistant has its current pages.`
      : action === 'exclude' ? `Leave out ${page} — no assistant will link to it or read it.` : `Put back ${page} — assistants can link to it again.`;
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">Website pages · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      <p class="text-sm text-gray-900 mt-2 break-words">${what}</p>
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked || ui.settled ? '' : `<button type="button" data-sd-go class="btn-primary min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${action === 'refresh' ? 'Re-read my site' : action === 'exclude' ? 'Leave it out' : 'Put it back'}</button>
        <button type="button" data-sd-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-sd-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-sd-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-sd-go], [data-sd-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-sd-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-sd-go]')) return;
      setBusy(true);
      say(action === 'refresh' ? 'Starting…' : 'Saving…');
      try {
        const res = await fetch('/.netlify/functions/site-directory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action === 'refresh' ? { action } : { action, path: ui.path }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'That didn’t work — please try again.');
        say(action === 'refresh'
          ? (data.status === 'reading' ? 'Reading your site now — it takes a minute or two. See Business Information ▸ Website Pages.' : `Done — ${Array.isArray(data.pages) ? data.pages.length : 0} pages read.`)
          : action === 'exclude' ? 'Left out. Assistants won’t use that page.' : 'Put back.');
      } catch (err) {
        setBusy(false);
        say(err && err.message ? err.message : 'That didn’t work — please try again.', 'error');
      }
    });
    return el;
  }

  register('site_directory', renderSiteDirectoryCard);

  // ── Built-in: Library Proposal Cards (Support Agent's Knowledge Base; Social / Blog Inspo) ────
  // { type: 'kb_article_proposal', assistantId, title, content, blocked, settled? }
  // { type: 'inspo_proposal', assistantId, kind: 'text'|'url', title, body, url, note, blocked, settled? }
  // Built by src/utils/chat-library.ts. The card shows EXACTLY what will be saved; the click dispatches
  // `library:add` and chat-session.js POSTs it to kb-articles.ts / inspo-items.ts as the tab's Save does.
  function renderLibraryProposalCard(ui, esc) {
    const assistantId = Number(ui.assistantId);
    if (!Number.isInteger(assistantId)) return null;
    const isKb = ui.type === 'kb_article_proposal';
    const blocked = typeof ui.blocked === 'string' && ui.blocked ? ui.blocked : '';
    const text = isKb ? String(ui.content || '') : String(ui.body || '');
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">${isKb ? 'Knowledge Base' : 'Inspo'} · ${ui.settled ? 'Earlier request' : blocked ? 'Can’t be done' : 'Needs your OK'}</p>
      ${ui.title ? `<p class="text-sm font-bold text-gray-900 mt-2 break-words">${esc(String(ui.title))}</p>` : ''}
      ${!isKb && ui.kind === 'url' && ui.url ? `<p class="text-sm text-gray-700 mt-1 break-all">${esc(String(ui.url))}</p>` : ''}
      ${text ? `<div class="mt-2 max-h-48 overflow-y-auto rounded-lg bg-gray-50 border border-gray-100 p-3 text-sm text-gray-800 whitespace-pre-wrap break-words">${esc(text)}</div>` : ''}
      ${!isKb && ui.note ? `<p class="text-sm text-gray-700 mt-2 break-words"><span class="font-bold">What you like about it:</span> ${esc(String(ui.note))}</p>` : ''}
      ${blocked ? `<p class="text-sm ${ui.settled ? 'text-gray-600' : 'text-amber-800'} mt-3">${esc(blocked)}</p>` : ''}
      ${!blocked ? `<p class="text-xs text-gray-600 mt-3">${isKb ? 'I answer from this once it’s saved. You can edit or remove it in the Knowledge Base tab.' : (ui.kind === 'url' ? 'I read the page once it’s saved, then apply what I learn to every draft. You can edit or remove it in the Inspo tab.' : 'I apply this to every draft once it’s saved. You can edit or remove it in the Inspo tab.')}</p>` : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${blocked ? '' : `<button type="button" data-lp-go class="btn-primary min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${isKb ? 'Add article' : 'Add to Inspo'}</button>
        <button type="button" data-lp-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-lp-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-lp-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-lp-go], [data-lp-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-lp-cancel]')) { setBusy(true); say('Left as it is.'); return; }
      if (!e.target.closest('[data-lp-go]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('library:add', {
        bubbles: true,
        detail: {
          assistantId, which: isKb ? 'kb' : 'inspo', title: ui.title || '', content: ui.content || '',
          kind: ui.kind, body: ui.body || '', url: ui.url || '', note: ui.note || '',
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Saved.'); return; }
            setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('kb_article_proposal', renderLibraryProposalCard);
  register('inspo_proposal', renderLibraryProposalCard);
  register('SocialPostDraftCard', renderSocialPostDraftCard);

  // ── Built-in: Blog Post Draft Card ──────────────────────────────────────────
  // Renderer for the blog_writer route's wire shape (chat-orchestrator.ts, normalised by
  // src/utils/blog-chat-draft.ts): { type: 'blog_post_draft', title, bodyMarkdown, tags }.
  //
  // The ONE drafting card whose content is not already saved when it appears. The social draft
  // card shows a post the orchestrator has already written to scheduled_posts; this one holds the
  // only copy of a whole article, and pressing "Save this draft" is what creates the row. So the
  // card has to say that plainly BEFORE the buttons — a user who assumes it is filed and closes
  // the chat loses the piece — and the wording after a save has to name where it went.
  //
  // Indigo, like the two proposal cards: in this transcript's visual language indigo means "your
  // decision", emerald means "done". Discarding is a real choice here, not a dismissal of a card.
  //
  // Save dispatches a bubbling 'blog:createDraft' CustomEvent — chat-session.js owns the call
  // because it is what holds the assistantId the post must belong to; the renderer only ever
  // receives `ui`. detail.respond carries the outcome back, because a create can fail and a card
  // that always claims success is worse than no card at all.
  function renderBlogPostDraftCard(ui, esc) {
    const bodyMarkdown = typeof ui.bodyMarkdown === 'string' ? ui.bodyMarkdown.trim() : '';
    if (!bodyMarkdown) return null;                 // nothing written — fall back to text-only
    const title = typeof ui.title === 'string' && ui.title.trim() ? ui.title.trim() : 'Untitled draft';
    // Strip a leading hash for display: the normaliser (src/utils/blog-chat-draft.ts) already does
    // it server-side, but the same rendering path also has to survive whatever a transcript
    // stored before that normaliser existed.
    const tags = (Array.isArray(ui.tags) ? ui.tags : [])
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => t.trim().replace(/^#/, ''))
      .filter((t, i, all) => t && all.indexOf(t) === i);
    const words = bodyMarkdown.split(/\s+/).filter(Boolean).length;

    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <div class="flex items-start gap-3 mb-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-xl shrink-0">📝</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase" data-bpd-eyebrow>Blog draft · Not saved yet</p>
          <p class="font-bold text-gray-900 break-words">${esc(title)}</p>
        </div>
      </div>

      <div class="bg-white border border-indigo-100 rounded-lg p-3 mb-3 max-h-64 overflow-y-auto">
        <p class="text-sm text-gray-700 whitespace-pre-wrap break-words">${esc(bodyMarkdown)}</p>
      </div>

      <div class="flex flex-wrap items-center gap-1.5 mb-3">
        <span class="text-[11px] font-semibold text-gray-500">${esc(String(words))} words</span>
        ${tags.map((t) => `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-white text-indigo-700 border border-indigo-200">${esc(t)}</span>`).join('')}
      </div>

      <div class="flex items-center gap-2" data-bpd-actions>
        <button type="button" data-bpd-save
          class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Save this draft
        </button>
        <button type="button" data-bpd-discard
          class="btn-destructive px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Discard
        </button>
      </div>
      <p class="mt-2 text-xs font-semibold text-indigo-700" data-bpd-status>Saving keeps it as a draft you can edit, schedule or publish. Discarding throws it away.</p>
    `;

    const status = el.querySelector('[data-bpd-status]');
    function say(text, tone) {
      status.textContent = text;
      status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`;
    }
    function setBusy(busy) {
      el.querySelectorAll('[data-bpd-save], [data-bpd-discard]').forEach((b) => { b.disabled = busy; });
    }

    // The eyebrow is a claim about where this article is, and it is the first thing read. Leaving
    // it on "Not saved yet" above a line saying it saved is the same contradiction this card
    // exists to prevent, one paragraph higher up.
    function setEyebrow(text) {
      const eyebrow = el.querySelector('[data-bpd-eyebrow]');
      if (eyebrow) eyebrow.textContent = text;
    }

    el.addEventListener('click', (e) => {
      const save = e.target.closest('[data-bpd-save]');
      const discard = e.target.closest('[data-bpd-discard]');
      if (!save && !discard) return;

      if (discard) {
        // The article stays on screen — only the choice goes away. It is still in the transcript,
        // and "discard" here means "don't file it", not "delete the conversation".
        setBusy(true);
        setEyebrow('Blog draft · Discarded');
        say('Discarded — nothing was saved. Ask me for another angle any time.');
        return;
      }

      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('blog:createDraft', {
        bubbles: true,
        detail: {
          title,
          bodyMarkdown,
          tags: tags.map((t) => t.trim()),
          // Re-enabling on failure is the point: this card holds the only copy of the article, so
          // a transient error must never strand it behind two dead buttons.
          respond({ ok, deduped, error }) {
            if (ok) {
              setEyebrow('Blog draft · Saved');
              // "Blogs" and "Blog Studio" are the REAL names of those surfaces
              // (assistant-dashboard-registry.js blog_writer.reviewQueue.label, and the detail
              // page's primary button). Pinned by tests/chat-blog-draft.test.ts so this sentence
              // cannot drift off the tab it names.
              say(deduped
                ? 'Already saved — it is in your Blogs tab.'
                : 'Saved to your Blogs tab — open it in Blog Studio to edit, schedule or publish it.');
              return;
            }
            setBusy(false);
            setEyebrow('Blog draft · Not saved yet');
            say(error || 'Could not save that draft — please try again.', 'error');
          },
        },
      }));
    });

    return el;
  }

  // ── Built-in: Newsletter Issue Draft Card ───────────────────────────────────
  // Renderer for the newsletter_editor route's wire shape (chat-orchestrator.ts, normalised by
  // src/utils/newsletter-chat-draft.ts): { type: 'newsletter_issue_draft', subject, preheader,
  // bodyMarkdown, warnings }.
  //
  // Same contract as the blog card and for the same reason — it holds the only copy of the issue
  // until Save is pressed — with one addition: `warnings`. The normaliser strips personalisation
  // tags the send worker could not resolve, and a card that edited someone's copy silently would
  // be worse than one that refused it.
  function renderNewsletterIssueDraftCard(ui, esc) {
    const bodyMarkdown = typeof ui.bodyMarkdown === 'string' ? ui.bodyMarkdown.trim() : '';
    if (!bodyMarkdown) return null;
    const subject = typeof ui.subject === 'string' && ui.subject.trim() ? ui.subject.trim() : 'Untitled email';
    const preheader = typeof ui.preheader === 'string' ? ui.preheader.trim() : '';
    const warnings = (Array.isArray(ui.warnings) ? ui.warnings : []).filter((w) => typeof w === 'string' && w.trim());
    const words = bodyMarkdown.split(/\s+/).filter(Boolean).length;
    // A send time the assistant has PROPOSED (src/utils/newsletter-chat-draft.ts validated the
    // shape). It adds a button; it does not schedule anything. The bare wall-clock is shown back
    // verbatim and never reformatted through Date(), which would silently re-read it in whatever
    // timezone this browser happens to be set to — the exact bug newsletter-send-time.sql fixed.
    const sendAt = typeof ui.sendAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(ui.sendAt) ? ui.sendAt : '';
    const sendAtLabel = sendAt ? sendAt.replace('T', ' at ') : '';

    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <div class="flex items-start gap-3 mb-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-xl shrink-0">✉️</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase" data-nid-eyebrow>Email draft · Not saved yet</p>
          <p class="font-bold text-gray-900 break-words">${esc(subject)}</p>
          ${preheader ? `<p class="text-xs text-gray-500 break-words">${esc(preheader)}</p>` : ''}
        </div>
      </div>

      <div class="bg-white border border-indigo-100 rounded-lg p-3 mb-3 max-h-64 overflow-y-auto">
        <p class="text-sm text-gray-700 whitespace-pre-wrap break-words">${esc(bodyMarkdown)}</p>
      </div>

      <div class="flex flex-wrap items-center gap-1.5 mb-3">
        <span class="text-[11px] font-semibold text-gray-500">${esc(String(words))} words</span>
      </div>

      ${warnings.length ? `<div class="bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-3">
        <p class="text-[11px] font-bold text-amber-900 mb-0.5">We tidied this before showing it</p>
        <ul class="text-[11px] text-amber-900 list-disc pl-4">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      </div>` : ''}

      <div class="flex flex-wrap items-center gap-2" data-nid-actions>
        <button type="button" data-nid-save
          class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Save this draft
        </button>
        ${sendAt ? `<button type="button" data-nid-schedule
          class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Save and schedule
        </button>` : ''}
        <button type="button" data-nid-discard
          class="btn-destructive px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          Discard
        </button>
      </div>
      <p class="mt-2 text-xs font-semibold text-indigo-700" data-nid-status>${sendAt
        ? `Saving keeps it as a draft. <span class="font-bold">Save and schedule</span> also approves it and sets it to go out on ${esc(sendAtLabel)}, your time — approving records that you have read it.`
        : 'Saving keeps it as a draft you can edit and send later. Nothing is sent to anyone until you approve it in the Studio.'}</p>
    `;

    const status = el.querySelector('[data-nid-status]');
    function say(text, tone) {
      status.textContent = text;
      status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`;
    }
    function setBusy(busy) {
      el.querySelectorAll('[data-nid-save], [data-nid-discard]').forEach((b) => { b.disabled = busy; });
    }
    function setEyebrow(text) {
      const eyebrow = el.querySelector('[data-nid-eyebrow]');
      if (eyebrow) eyebrow.textContent = text;
    }

    el.addEventListener('click', async (e) => {
      const save = e.target.closest('[data-nid-save]');
      const schedule = e.target.closest('[data-nid-schedule]');
      const discard = e.target.closest('[data-nid-discard]');
      if (!save && !discard && !schedule) return;

      if (discard) {
        setBusy(true);
        setEyebrow('Email draft · Discarded');
        say('Discarded — nothing was saved. Ask me for another angle any time.');
        return;
      }

      // ⚠️ Scheduling is the decision to email real people on a date, so it is confirmed even
      // though the whole issue is on screen above the button. Saving is not — a draft harms nobody.
      if (schedule && typeof window.confirmModal === 'function') {
        const ok = await window.confirmModal(
          `This approves the email and sets it to send on ${sendAtLabel}, in your business's timezone. It goes to everyone subscribed unless you change that in the Studio first. Approving records that you have read it.`,
          { title: 'Approve and schedule?', confirmLabel: 'Approve and schedule', confirmColor: '#059669' });
        if (!ok) return;
      }

      setBusy(true);
      say(schedule ? 'Saving and scheduling…' : 'Saving…');
      el.dispatchEvent(new CustomEvent('newsletter:createDraft', {
        bubbles: true,
        detail: {
          subject,
          preheader,
          bodyMarkdown,
          // Only present when the SCHEDULE button was the one pressed: saving from the plain button
          // must never schedule, even on a card that carries a proposed time.
          scheduleFor: schedule ? sendAt : null,
          // Re-enabling on failure is the point: this card holds the only copy of the issue, so a
          // transient error must never strand it behind two dead buttons.
          respond({ ok, deduped, error, scheduled, scheduleError }) {
            if (ok) {
              setEyebrow(scheduled ? 'Email draft · Scheduled' : 'Email draft · Saved');
              // "Issues" and "Email Studio" are the REAL names of those surfaces
              // (assistant-dashboard-registry.js newsletter_editor.hubTab.label and the detail
              // page's primary button), pinned by tests so this sentence cannot drift off them.
              if (scheduled) {
                say(`Approved and scheduled for ${sendAtLabel}, your time. You can still change or cancel it in the Email Studio until it starts sending.`);
                return;
              }
              // ⚠️ A half-success is reported as one. The issue IS saved; only the scheduling was
              // refused (almost always because approving needs an owner or an admin), and a card
              // that said "could not save" would send them looking for a draft that is right there.
              if (scheduleError) {
                say(`Saved to your Emails tab, but not scheduled: ${scheduleError}`, 'error');
                return;
              }
              say(deduped
                ? 'Already saved — it is in your Emails tab.'
                : 'Saved to your Emails tab — open it in the Email Studio to edit, choose who it goes to, and send it.');
              return;
            }
            setBusy(false);
            setEyebrow('Email draft · Not saved yet');
            say(error || 'Could not save that draft — please try again.', 'error');
          },
        },
      }));
    });

    return el;
  }

  register('newsletter_issue_draft', renderNewsletterIssueDraftCard);
  register('NewsletterIssueDraftCard', renderNewsletterIssueDraftCard);

  // ── Built-in: Newsletter Campaign Draft Card ────────────────────────────────
  // Renderer for a campaign — an ordered series of emails — from the same route, normalised by
  // src/utils/newsletter-campaign-chat-draft.ts: { type: 'newsletter_campaign_draft', stage, name,
  // campaignType, goal, audience, trigger, tone, newsletters[], warnings }.
  //
  // TWO STAGES, ONE CARD. A 'plan' is the outline the assistant proposes before writing anything,
  // and it has NO buttons: there is nothing to keep yet, and a Save on an outline would file five
  // empty emails. A 'draft' has every email written and offers Save / Discard.
  //
  // WHERE SAVE GOES depends on the trigger, and the card says which before it is pressed:
  //  • 'subscribed' → the welcome sequence (newsletter-sequences importCampaign). Stays OFF.
  //  • anything else → one draft issue per email (newsletter-issues createCampaign), because the
  //    platform cannot see a renewal date or a cancellation, so nothing could start it.
  const CAMPAIGN_TYPE_LABELS = {
    onboarding: 'Onboarding', renewal: 'Renewal', upgrade: 'Upgrade', winback: 'Win-back',
    reengagement: 'Re-engagement', launch: 'Launch', custom: 'Custom',
  };

  function renderNewsletterCampaignDraftCard(ui, esc) {
    const emails = (Array.isArray(ui.newsletters) ? ui.newsletters : []).filter((n) => n && typeof n === 'object');
    if (!emails.length) return null;
    const isDraft = ui.stage === 'draft' && emails.every((n) => typeof n.bodyMarkdown === 'string' && n.bodyMarkdown.trim());
    const trigger = ui.trigger && typeof ui.trigger === 'object' ? ui.trigger : {};
    // Re-derived rather than trusted, same as the server: 'subscribed' (the welcome sequence) and
    // 'form' (an email flow a sign-up form starts) start by themselves; anything else does not.
    // ⚠️ The model's guess is only the STARTING choice for an automatic series. It once filed a
    // "beta testers" campaign as the welcome sequence — Save then tried to overwrite the LIVE
    // waitlist welcome sequence, and the user had no way to say "no, this is for a form". The card
    // now asks (data-ncd-who), and everything below reads the current answer.
    let event = trigger.event === 'subscribed' || trigger.event === 'form' ? trigger.event : 'custom';
    const automatic = event !== 'custom';
    let isForm = event === 'form';
    const whoName = `ncd-who-${Math.random().toString(36).slice(2, 9)}`;
    const name = typeof ui.name === 'string' && ui.name.trim() ? ui.name.trim() : 'Email sequence';
    const goal = typeof ui.goal === 'string' ? ui.goal.trim() : '';
    const warnings = (Array.isArray(ui.warnings) ? ui.warnings : []).filter((w) => typeof w === 'string' && w.trim());
    const lastDay = Number(emails[emails.length - 1].sendDay) || 1;
    const typeLabel = CAMPAIGN_TYPE_LABELS[ui.campaignType] || 'Custom';
    const n = emails.length;
    const saveLabelFor = () => isForm ? 'Save as form email flow' : automatic ? 'Save as email flow' : `Save as ${n} draft ${n === 1 ? 'email' : 'emails'}`;
    const startsLabelFor = () => isForm ? 'Starts when someone fills in a form' : 'Starts when someone subscribes';
    const statusFor = () => isForm
      ? 'Saving creates this email flow under Email Flows in the Email Studio, switched off. Link it to a sign-up form in Audience → Sign-up forms, then turn it on — nobody is emailed by saving.'
      : automatic
        ? 'Saving makes this a new email flow for everyone who subscribes, under Email Flows in the Email Studio. It stays switched off until you turn it on there — nobody is emailed by saving.'
        : 'Saving puts each email in your Emails tab as a draft. Nothing is sent to anyone: you send each one to the right people on the right day from the Email Studio.';
    const eyebrow = (s) => `${isDraft ? 'Email flow draft' : 'Email flow plan'} · ${s}`;

    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-lg';
    el.innerHTML = `
      <div class="flex items-start gap-3 mb-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-xl shrink-0">📬</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase" data-ncd-eyebrow>${esc(eyebrow(isDraft ? 'Not saved yet' : 'Not written yet'))}</p>
          <p class="font-bold text-gray-900 break-words">${esc(name)}</p>
          ${goal ? `<p class="text-xs text-gray-500 break-words">Goal: ${esc(goal)}</p>` : ''}
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-1.5 mb-3">
        <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-white border border-indigo-200 text-indigo-700">${esc(typeLabel)}</span>
        <span class="text-[11px] font-semibold text-gray-500">${esc(`${n} ${n === 1 ? 'email' : 'emails'} over ${lastDay} ${lastDay === 1 ? 'day' : 'days'}`)}</span>
        ${automatic
          ? `<span data-ncd-starts class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-emerald-50 border-emerald-200 text-emerald-800">${esc(startsLabelFor())}</span>`
          : '<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-amber-50 border-amber-200 text-amber-900">Won’t start by itself</span>'}
      </div>
      ${trigger.description ? `<p class="text-xs text-gray-600 mb-3 break-words">Who it’s for: ${esc(trigger.description)}</p>` : ''}
      ${automatic && isDraft ? `<fieldset class="bg-white border border-indigo-100 rounded-lg p-3 mb-3" data-ncd-who>
        <legend class="text-[11px] font-bold text-gray-700 px-1">Who gets these emails?</legend>
        <label class="flex items-start gap-2 text-sm text-gray-800 cursor-pointer mb-1.5">
          <input type="radio" name="${whoName}" value="form" class="mt-1" ${isForm ? 'checked' : ''}>
          <span>Only people who fill in a particular sign-up form <span class="text-gray-500">— e.g. beta testers. You link the form afterwards.</span></span>
        </label>
        <label class="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
          <input type="radio" name="${whoName}" value="subscribed" class="mt-1" ${isForm ? '' : 'checked'}>
          <span>Everyone who joins your list <span class="text-gray-500">— saved as a new email flow; your current one is not touched.</span></span>
        </label>
      </fieldset>` : ''}

      <ol class="space-y-2 mb-3">
        ${emails.map((e, i) => {
          const cta = e.callToAction && typeof e.callToAction === 'object' && e.callToAction.label ? e.callToAction : null;
          const body = typeof e.bodyMarkdown === 'string' ? e.bodyMarkdown.trim() : '';
          return `<li class="bg-white border border-indigo-100 rounded-lg p-3">
            <div class="flex items-start gap-2">
              <span class="shrink-0 text-[11px] font-black px-2 py-0.5 rounded bg-indigo-600 text-white">Day ${esc(String(Number(e.sendDay) || i + 1))}</span>
              <div class="min-w-0">
                <p class="text-[11px] font-bold text-indigo-700 uppercase tracking-wider">Email ${i + 1}${e.role ? ` · ${esc(e.role)}` : ''}</p>
                <p class="text-sm font-bold text-gray-900 break-words">${esc(e.subject || `Email ${i + 1}`)}</p>
                ${e.preheader ? `<p class="text-xs text-gray-500 break-words">${esc(e.preheader)}</p>` : ''}
                ${cta ? `<p class="text-[11px] text-gray-600 mt-1">Asks them to: <span class="font-bold">${esc(cta.label)}</span>${cta.url ? '' : ' <span class="text-amber-700 font-bold">· needs a link</span>'}</p>` : ''}
              </div>
            </div>
            ${body ? `<details class="mt-2">
              <summary class="text-xs font-bold text-indigo-700 cursor-pointer">Read email ${i + 1}</summary>
              <p class="mt-2 text-sm text-gray-700 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">${esc(body)}</p>
            </details>` : ''}
          </li>`;
        }).join('')}
      </ol>

      ${warnings.length ? `<div class="bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-3">
        <p class="text-[11px] font-bold text-amber-900 mb-0.5">We tidied this before showing it</p>
        <ul class="text-[11px] text-amber-900 list-disc pl-4">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      </div>` : ''}

      ${isDraft ? `<div class="flex flex-wrap items-center gap-2" data-ncd-actions>
        <button type="button" data-ncd-save
          class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${esc(saveLabelFor())}</button>
        <button type="button" data-ncd-discard
          class="btn-destructive px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Discard</button>
      </div>` : ''}
      <p class="mt-2 text-xs font-semibold text-indigo-700" data-ncd-status>${!isDraft
        ? 'This is the plan, not the emails yet. Tell me what to change — more or fewer emails, different days — or say “write it” and I’ll draft every one.'
        : esc(statusFor())}</p>
    `;
    if (!isDraft) return el;

    const status = el.querySelector('[data-ncd-status]');
    function say(text, tone) {
      status.textContent = text;
      status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`;
    }
    function setBusy(busy) {
      el.querySelectorAll('[data-ncd-save], [data-ncd-discard]').forEach((b) => { b.disabled = busy; });
    }
    function setEyebrow(text) {
      const node = el.querySelector('[data-ncd-eyebrow]');
      if (node) node.textContent = eyebrow(text);
    }

    function dispatchSave() {
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('newsletter:createCampaign', {
        bubbles: true,
        detail: {
          name,
          trigger: { event },
          newsletters: emails.map((e) => ({
            subject: e.subject, preheader: e.preheader || '', bodyMarkdown: e.bodyMarkdown,
            delayDaysAfterPrevious: Number(e.delayDaysAfterPrevious) || 0,
          })),
          // Re-enabling on every failure is the point: this card holds the only copy.
          async respond({ ok, deduped, error, stepCount, created }) {
            if (ok) {
              setEyebrow('Saved');
              if (isForm) {
                say(deduped
                  ? 'Already saved — it is under Email Flows in the Email Studio.'
                  : `Saved as an email flow — ${stepCount || n} emails, switched off. Link it to a sign-up form in Audience → Sign-up forms, then turn it on under Email Flows.`);
              } else if (automatic) {
                say(deduped
                  ? 'Already saved — it is under Email Flows in the Email Studio.'
                  : `Saved as a new email flow for everyone who subscribes — ${stepCount || n} emails, switched off. Turn it on under Email Flows in the Email Studio when you are ready.`);
              } else {
                say(deduped
                  ? 'Already saved — these are in your Emails tab.'
                  : `Saved ${created || n} draft ${(created || n) === 1 ? 'email' : 'emails'} to your Emails tab. Send each one from the Email Studio on its day.`);
              }
              return;
            }
            setBusy(false);
            setEyebrow('Not saved yet');
            say(error || 'Could not save this email flow — please try again.', 'error');
          },
        },
      }));
    }

    // The "who gets these emails?" answer re-points everything that describes where Save goes.
    el.addEventListener('change', (e) => {
      const pick = e.target.closest && e.target.closest(`input[name="${whoName}"]`);
      if (!pick) return;
      event = pick.value === 'form' ? 'form' : 'subscribed';
      isForm = event === 'form';
      const btn = el.querySelector('[data-ncd-save]');
      if (btn) btn.textContent = saveLabelFor();
      const starts = el.querySelector('[data-ncd-starts]');
      if (starts) starts.textContent = startsLabelFor();
      say(statusFor());
    });

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-ncd-discard]')) {
        setBusy(true);
        setEyebrow('Discarded');
        say('Discarded — nothing was saved. Ask me for a different shape any time.');
        return;
      }
      if (e.target.closest('[data-ncd-save]')) dispatchSave();
    });

    return el;
  }

  // ── Built-in: Sign-up Form Draft Card ───────────────────────────────────────
  // Renderer for a sign-up form the Email Marketing Assistant designed in chat (Mode A of
  // docs/form-builder-plan.md), normalised by src/utils/form-chat-draft.ts:
  //   { type: 'audience_form_draft', form: FormDefinition, warnings }
  //
  // A LIVE PREVIEW drawn by window.BmsForm — the same renderer the customer's website and the hosted
  // page use — then where each answer goes, then Save / Discard. Save creates the form SWITCHED OFF:
  // it is published from the form builder, by someone who has seen it there.
  const TARGET_LABELS = { first_name: 'First name', last_name: 'Last name', company: 'Company', phone: 'Phone', email: 'Email' };

  function renderAudienceFormDraftCard(ui, esc) {
    const def = ui.form && typeof ui.form === 'object' ? ui.form : null;
    if (!def || !Array.isArray(def.fields) || !def.fields.length) return null;
    const warnings = (Array.isArray(ui.warnings) ? ui.warnings : []).filter((w) => typeof w === 'string' && w.trim());
    const where = (f) => {
      const t = f.target || {};
      if (t.kind === 'contact') return TARGET_LABELS[t.column] || t.column;
      if (t.kind === 'tag') return 'tags';
      return `your field "${t.key || ''}"`;
    };
    const hosted = def.delivery && def.delivery.hosted && def.delivery.hosted.enabled;
    const slug = hosted && def.delivery.hosted.slug;

    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-lg';
    el.innerHTML = `
      <div class="flex items-start gap-3 mb-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-xl shrink-0">📝</div>
        <div class="min-w-0">
          <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase" data-afd-eyebrow>Sign-up form · Not saved yet</p>
          <p class="font-bold text-gray-900 break-words">${esc(def.name || 'Sign-up form')}</p>
          <p class="text-xs text-gray-500">${esc(def.fields.length === 1 ? '1 question' : `${def.fields.length} questions`)} · ${hosted ? esc(slug ? `its own page at /f/${slug}` : 'its own page') : 'for your website'}</p>
        </div>
      </div>
      <div class="bg-white border border-indigo-100 rounded-lg p-3 mb-3" data-afd-preview></div>
      <ul class="text-[11px] text-gray-600 mb-3 space-y-0.5">
        ${def.fields.map((f) => `<li><span class="font-bold">${esc(f.label)}</span>${f.required ? ' (required)' : ''} → ${esc(where(f))}</li>`).join('')}
      </ul>
      ${warnings.length ? `<div class="bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-3">
        <p class="text-[11px] font-bold text-amber-900 mb-0.5">We tidied this before showing it</p>
        <ul class="text-[11px] text-amber-900 list-disc pl-4">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      </div>` : ''}
      <div class="flex flex-wrap items-center gap-2" data-afd-actions>
        <button type="button" data-afd-save class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Save form</button>
        <button type="button" data-afd-discard class="btn-destructive px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Discard</button>
      </div>
      <p class="mt-2 text-xs font-semibold text-indigo-700" data-afd-status>Saving keeps it switched off. Open it in the form builder to link an email flow, check it, and publish it — nobody can sign up until you do.</p>
    `;

    // The preview — only when the renderer is on this page (the workspace loads it; a standalone
    // chat page may not, and the summary above still says everything).
    const pv = el.querySelector('[data-afd-preview]');
    if (window.BmsForm && pv) {
      window.BmsForm.render({ content: def.content || {}, fields: def.fields, consent: def.consent || {}, style: Object.assign({}, def.style || {}, { logoUrl: null }), senderName: '' },
        pv, { surface: 'preview', previewAs: 'embed', preview: true });
    } else if (pv) {
      pv.remove();
    }

    const status = el.querySelector('[data-afd-status]');
    const say = (text, tone) => { status.textContent = text; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-afd-save], [data-afd-discard]').forEach((x) => { x.disabled = b; });
    const eyebrow = (t) => { const n = el.querySelector('[data-afd-eyebrow]'); if (n) n.textContent = `Sign-up form · ${t}`; };

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-afd-discard]')) { setBusy(true); eyebrow('Discarded'); say('Discarded — nothing was saved.'); return; }
      const openBtn = e.target.closest('[data-afd-open]');
      if (openBtn && el._savedForm && window.FormBuilder) { window.FormBuilder.open({ form: el._savedForm }); return; }
      if (!e.target.closest('[data-afd-save]')) return;
      setBusy(true);
      say('Saving…');
      el.dispatchEvent(new CustomEvent('audience:createForm', {
        bubbles: true,
        detail: {
          definition: def,
          respond({ ok, form, warnings: more, error }) {
            if (!ok) { setBusy(false); eyebrow('Not saved yet'); say(error || 'Could not save this form — please try again.', 'error'); return; }
            eyebrow('Saved · switched off');
            el._savedForm = form;
            const extra = (more || []).length ? ` (${more.join(' ')})` : '';
            say(`Saved, switched off. Open it in the form builder to link an email flow and publish it.${extra}`);
            const actions = el.querySelector('[data-afd-actions]');
            if (actions && window.FormBuilder) {
              actions.innerHTML = '<button type="button" data-afd-open class="btn-secondary px-4 py-2 text-sm font-bold rounded-lg transition border">Open in the form builder</button>';
            }
          },
        },
      }));
    });

    return el;
  }

  register('audience_form_draft', renderAudienceFormDraftCard);
  register('AudienceFormDraftCard', renderAudienceFormDraftCard);

  register('newsletter_campaign_draft', renderNewsletterCampaignDraftCard);
  register('NewsletterCampaignDraftCard', renderNewsletterCampaignDraftCard);

  register('blog_post_draft', renderBlogPostDraftCard);

  // ── Built-in: several articles at once (Blog Writer chat, owner 2026-10-27) ──
  // { type: 'blog_batch_proposal', topics: [{ title, brief }], more, assistantId }
  // src/utils/blog-chat-batch.ts. One button queues every article through generate-blog.ts (the
  // background worker); the click dispatches `blog:batch` and chat-session.js makes the call.
  function renderBlogBatchProposalCard(ui, esc) {
    const topics = Array.isArray(ui.topics) ? ui.topics.filter((t) => t && t.title) : [];
    if (!topics.length) return null;
    const n = topics.length;
    const el = document.createElement('div');
    el.className = 'bg-white border-2 border-emerald-100 rounded-xl shadow-sm p-5 max-w-lg';
    el.innerHTML = `
      <p class="text-xs font-bold text-emerald-800 tracking-wider uppercase">${n === 1 ? 'Write this article' : `Write ${n} articles`} · ${ui.queued ? 'Started' : 'Needs your OK'}</p>
      <ol class="mt-3 space-y-2 list-decimal pl-5">
        ${topics.map((t) => `<li class="text-sm text-gray-900"><span class="font-bold">${esc(t.title)}</span>${t.brief ? `<span class="block text-xs text-gray-600 mt-0.5">${esc(t.brief)}</span>` : ''}</li>`).join('')}
      </ol>
      ${ui.more ? `<p class="text-xs text-amber-800 mt-2">${esc(String(ui.more))} more were asked for — ask again once these are written.</p>` : ''}
      <p class="text-xs text-gray-600 mt-3">${n === 1 ? 'It’s written in the background — usually a minute or two — and lands in the Review column of the Blogs tab. Nothing is published, and it counts as one task.' : 'Each one is written in the background — a minute or two apiece — and lands in the Review column of the Blogs tab. Nothing is published, and each counts as one task.'}</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        ${ui.queued ? '' : `<button type="button" data-bb-go class="btn-primary min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${n === 1 ? 'Write it' : `Write all ${n}`}</button>
        <button type="button" data-bb-cancel class="btn-secondary min-h-[44px] sm:min-h-0 px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50">Not now</button>`}
      </div>
      <p class="hidden mt-2 text-xs font-semibold" data-bb-status role="status" aria-live="polite"></p>`;
    const status = el.querySelector('[data-bb-status]');
    const say = (t, tone) => { status.textContent = t; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-emerald-800'}`; };
    const setBusy = (b) => el.querySelectorAll('[data-bb-go], [data-bb-cancel]').forEach((x) => { x.disabled = b; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-bb-cancel]')) { setBusy(true); say('Nothing started.'); return; }
      if (!e.target.closest('[data-bb-go]')) return;
      setBusy(true);
      say('Starting…');
      el.dispatchEvent(new CustomEvent('blog:batch', {
        bubbles: true,
        detail: {
          assistantId: Number(ui.assistantId) || null,
          topics: topics.map((t) => ({ title: t.title, brief: t.brief || null })),
          respond({ ok, message, error }) {
            if (ok) { say(message || 'Started.'); return; }
            setBusy(false);
            say(error || 'That didn’t work — please try again.', 'error');
          },
        },
      }));
    });
    return el;
  }

  register('blog_batch_proposal', renderBlogBatchProposalCard);
  register('BlogPostDraftCard', renderBlogPostDraftCard);

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
          class="btn-golive block w-full text-center px-4 py-2.5 text-sm font-bold rounded-lg transition">
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
