/**
 * src/components/lead-outcome-modal.js
 * "Record outcome" — how a lead's deal actually ended (won / lost / disqualified).
 *
 * ── Why this is a shared component ───────────────────────────────────────────
 * TWO surfaces open it, and they must not be able to disagree about the rules:
 *
 *   • the Leads tab (assistant-data-hub.js) — the expanded row of any lead, including the ones
 *     that have no conversation at all: no address, or worked entirely offline. This entry point
 *     is why outcome capture cannot simply MOVE to the thread.
 *   • the Conversations tab (assistant-lead-threads.js) — the thread the deal actually happened
 *     in. This is where the evidence for the decision is on screen, so it is the natural place to
 *     record it; reading the reply in one tab and recording what it meant in another is the same
 *     split this product has already had to close elsewhere.
 *
 * It was written once inside the Data Hub. Copying it into the thread view would have produced a
 * second implementation of a form whose two hard rules (a loss needs a reason, only a win takes a
 * value) exist to keep revenue aggregates meaningful — and the one thing this codebase reliably
 * learns is that the second copy drifts.
 *
 * ── The rules, and who enforces them ─────────────────────────────────────────
 * The SERVER is the enforcer (lead-generation.ts `set_outcome`); everything mirrored here only
 * decides which fields are shown, so an unreachable constants script degrades to a refused save
 * rather than a silently wrong one:
 *   • lost / disqualified REQUIRE a loss reason — recordEvent() stores lossReason on any terminal
 *     event, so a won deal carrying one is counted by every "why are we losing?" aggregate;
 *   • only a win takes a value, or "mean deal value" merges revenue earned with revenue missed;
 *   • ⚠️ the ledger is APPEND-ONLY. Correcting an outcome writes a SECOND terminal row, so the
 *     server answers 409 + needsConfirmation the first time and the change has to be confirmed.
 *     Every reader must take the LATEST terminal event per record.
 *
 * Vocabulary comes from window.RevenueConstants (generated from src/config/revenue-events.ts) —
 * these are CHECK-constrained server-side and are the Strategy Agent's GROUP BY keys, so a
 * hand-typed copy writes values the database rejects. recordEvent() swallows its errors, which
 * makes that failure invisible rather than loud.
 *
 * Usage:
 *   window.LeadOutcomeModal.open({
 *     assistantId, recordId, title,
 *     existing,            // the record's current data.dealOutcome, or null
 *     onSaved(dealOutcome, info),   // info = { sequencesHalted }
 *   });
 *
 * All server values are escaped on render; treat them as untrusted.
 */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const OUTCOME_BTN = {
    on: 'px-3 py-1.5 bg-emerald-700 border border-emerald-700 text-white text-xs font-bold rounded-lg transition',
    off: 'px-3 py-1.5 bg-white border border-gray-200 text-gray-700 text-xs font-bold rounded-lg transition',
  };

  function open(opts) {
    const RC = window.RevenueConstants;
    if (!RC) { window.showToast?.('Outcome options failed to load — refresh the page.'); return; }
    const existing = opts.existing || null;

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100">
          <div>
            <h3 class="text-lg font-bold text-gray-900">Record outcome</h3>
            <p class="text-xs text-gray-500 mt-0.5">${esc(opts.title || 'This lead')}</p>
          </div>
          <button type="button" data-oc-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer">&times;</button>
        </div>
        <form data-oc-form class="p-5 space-y-4">
          ${existing && existing.outcome ? `
            <div class="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p class="text-xs font-bold text-amber-700">Already marked ${esc(RC.outcomeLabel(existing.outcome))}</p>
              <p class="text-xs text-amber-700 mt-1">Recording a different outcome keeps both in the history — the most recent one counts.</p>
            </div>` : ''}

          <div>
            <span class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">What happened?</span>
            <div class="flex flex-wrap gap-2" data-oc-outcomes>
              ${RC.outcomes.map((o) => `
                <button type="button" data-oc-outcome="${esc(o)}"
                  class="${OUTCOME_BTN.off}">${esc(RC.outcomeLabel(o))}</button>`).join('')}
            </div>
          </div>

          <label class="block" data-oc-reason-wrap hidden>
            <span class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Why?</span>
            <select name="lossReason" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-400">
              <option value="">Choose a reason…</option>
              ${RC.lossReasons.map((r) => `<option value="${esc(r)}">${esc(RC.lossReasonLabel(r))}</option>`).join('')}
            </select>
            <span class="block text-xs text-gray-400 mt-1">Fixed list on purpose — it's what makes "why are we losing?" answerable.</span>
          </label>

          <label class="block" data-oc-value-wrap hidden>
            <span class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Deal value (optional)</span>
            <input type="number" name="valueGbp" min="0" step="0.01" placeholder="e.g. 4800"
              class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-400">
            <span class="block text-xs text-gray-400 mt-1">In £. Leave blank if you'd rather not say.</span>
          </label>

          <p class="hidden text-xs font-semibold" data-oc-status></p>
          <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" data-oc-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 rounded-lg cursor-pointer">Cancel</button>
            <button type="submit" data-oc-submit disabled
              class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Save outcome</button>
          </div>
        </form>
      </div>`;

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-oc-close]').forEach((b) => b.addEventListener('click', close));

    const form = overlay.querySelector('[data-oc-form]');
    const status = overlay.querySelector('[data-oc-status]');
    const submit = overlay.querySelector('[data-oc-submit]');
    const reasonWrap = overlay.querySelector('[data-oc-reason-wrap]');
    const valueWrap = overlay.querySelector('[data-oc-value-wrap]');
    let chosen = null;

    // `hidden` loses to a class that sets display (these wrappers are `block`), so pin
    // style.display as well — the same trap that left an empty badge dot on the Review Queue tab.
    const setShown = (el, on) => { el.hidden = !on; el.style.display = on ? 'block' : 'none'; };
    setShown(reasonWrap, false);
    setShown(valueWrap, false);

    overlay.querySelector('[data-oc-outcomes]').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-oc-outcome]');
      if (!btn) return;
      chosen = btn.getAttribute('data-oc-outcome');
      overlay.querySelectorAll('[data-oc-outcome]').forEach((b) => {
        b.className = b === btn ? OUTCOME_BTN.on : OUTCOME_BTN.off;
      });
      setShown(reasonWrap, RC.needsLossReason(chosen));
      setShown(valueWrap, chosen === 'won');
      if (!RC.needsLossReason(chosen)) form.elements.lossReason.value = '';
      if (chosen !== 'won') form.elements.valueGbp.value = '';
      submit.disabled = false;
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!chosen) return;
      const lossReason = form.elements.lossReason.value || '';
      if (RC.needsLossReason(chosen) && !lossReason) {
        status.textContent = 'Pick a reason so this counts toward "why are we losing?".';
        status.className = 'block text-xs font-semibold text-red-600';
        return;
      }
      const rawValue = form.elements.valueGbp.value;
      submit.disabled = true;
      status.textContent = 'Saving…';
      status.className = 'block text-xs font-semibold text-gray-500';

      const post = (confirmChange) => fetch('/.netlify/functions/lead-generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'set_outcome',
          assistantId: opts.assistantId,
          recordId: opts.recordId,
          outcome: chosen,
          ...(lossReason ? { lossReason } : {}),
          ...(chosen === 'won' && rawValue !== '' ? { valueGbp: Number(rawValue) } : {}),
          ...(confirmChange ? { confirmChange: true } : {}),
        }),
      });

      try {
        let res = await post(false);
        let data = await res.json().catch(() => ({}));

        // 409: an outcome is already recorded. The server refuses by default so a double-click
        // cannot leave one lead counted as both won and lost — confirming is a deliberate act.
        if (res.status === 409 && data.needsConfirmation) {
          const RCl = RC.outcomeLabel(data.currentOutcome);
          const ok = window.confirm(
            `This lead is already marked ${RCl}.\n\n`
            + `Recording "${RC.outcomeLabel(chosen)}" instead keeps both in the history — the most recent one is what counts.\n\n`
            + 'Change it?'
          );
          if (!ok) { close(); return; }
          res = await post(true);
          data = await res.json().catch(() => ({}));
        }
        if (!res.ok) throw new Error(data.error || 'Could not record the outcome.');

        close();
        const halted = Number(data.sequencesHalted) || 0;
        opts.onSaved?.(data.dealOutcome, { sequencesHalted: halted });
        window.showToast?.(
          `Outcome recorded: ${RC.outcomeLabel(chosen)}.`
          + (halted ? ' Follow-up emails stopped.' : '')
        );
      } catch (err) {
        submit.disabled = false;
        status.textContent = err.message || 'Could not record the outcome.';
        status.className = 'block text-xs font-semibold text-red-600';
      }
    });

    document.body.appendChild(overlay);
  }

  window.LeadOutcomeModal = { open };
})();
