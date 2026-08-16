/**
 * src/components/lead-calendar-modal.js
 *
 * The detail modal behind a chip on the Lead Generator's Calendar tab.
 *
 * ── What problem this solves ─────────────────────────────────────────────────
 * The calendar could draw a lead's work but could not explain it. A chase-reminder chip was inert
 * with a code comment saying "records open from the Data Hub" — so answering "what is this, and
 * what are we about to send this company?" meant leaving the calendar, opening the Enrichment tab
 * and finding the row by name. The one screen that shows you WHEN could not show you WHAT.
 *
 * ── The two things it opens, which are not the same thing ────────────────────
 *   kind: 'record'   → a lead whose outreach has ALREADY gone out. `scheduled_for` is the chase
 *                      reminder left behind for a human; nothing sends on that date. The email in
 *                      the panel is the one that WAS sent (or, with no inbox connected, the one
 *                      still waiting for the user to send themselves).
 *   kind: 'followup' → a chaser the cadence is GOING TO SEND on that date
 *                      (sequence_enrolments.next_send_at). Its body does not exist yet: the worker
 *                      drafts each step in the context of the thread at send time, so this panel
 *                      shows the thread's last outbound message as what the chaser follows, and
 *                      says plainly that the text is written when it goes.
 *
 * ⚠️ Never merge those two into one "the email that will be sent" panel. The first has a body and
 * is in the past; the second has a date and no body yet. A panel that showed the stored
 * `outreachDraft` under a "will be sent" heading would be asserting that a stranger is about to
 * receive a copy of an email they already have.
 *
 * ── Where the data comes from ────────────────────────────────────────────────
 *   assistant-records.ts  GET ?assistantId&recordId  → the lead, with its full `data`
 *   lead-threads.ts       POST { action: 'get' }     → the thread, its messages and its enrolment
 * Both are read-only. Everything that WRITES a lead is somewhere else on purpose; this panel's only
 * write is "stop follow-ups", which goes through lead-threads.ts like every other caller.
 *
 * Usage (calendar.js):
 *   window.LeadCalendarModal.open({ kind, assistantId, recordId?, threadId?, followUp?, onChanged })
 *
 * All server values are escaped on render; treat them as untrusted.
 */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const fmtDateTime = (v) => {
    if (!v) return '';
    const d = new Date(v);
    return isNaN(d) ? '' : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const fmtDate = (v) => {
    if (!v) return '';
    const d = new Date(v);
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };

  /** Rating chips share one vocabulary with the Leads table — see [[lead-rating-chips-single-source]]. */
  const RATING = {
    hot:  'bg-orange-100 text-orange-700 border-orange-200',
    warm: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    cold: 'bg-blue-100 text-blue-700 border-blue-200',
  };

  const SECTION = 'border-t border-gray-100 pt-4 mt-4 first:border-0 first:pt-0 first:mt-0';
  const LABEL = 'text-[11px] font-bold text-gray-400 uppercase tracking-wide';

  /** A definition row, skipped entirely when there is no value — blank rows read as broken. */
  function field(label, value) {
    if (value === null || value === undefined || String(value).trim() === '') return '';
    return `<div class="flex items-start gap-3 py-1">
      <span class="${LABEL} w-28 shrink-0 pt-0.5">${esc(label)}</span>
      <span class="text-sm text-gray-800 break-words min-w-0">${value}</span>
    </div>`;
  }

  /** Same as `field`, but the value is escaped for you. */
  const textField = (label, value) => field(label, value == null ? '' : esc(value));

  function ratingChip(status) {
    const key = String(status || '').toLowerCase();
    const cls = RATING[key];
    if (!cls) return '';
    return `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border ${cls}">${esc(key.charAt(0).toUpperCase() + key.slice(1))}</span>`;
  }

  /**
   * The Email Sent / Email Drafted chip, from the generated window.LeadOutreach so this panel and
   * the Review Queue cannot name the same lead's state differently.
   */
  function outreachChip(data) {
    const OUT = window.LeadOutreach;
    const chip = (OUT && typeof OUT.chipFor === 'function') ? OUT.chipFor(data || {}) : null;
    if (!chip) return '';
    return `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border ${chip.cls}">${esc(chip.label)}</span>`;
  }

  function outreachState(data) {
    const OUT = window.LeadOutreach;
    return (OUT && typeof OUT.state === 'function') ? OUT.state(data || {}) : null;
  }

  // ── Panels ────────────────────────────────────────────────────────────────

  /**
   * The email panel for a RECORD chip — the message that has already gone out, or the draft the
   * user still has to send themselves.
   *
   * ⚠️ The heading is chosen from the outreach state, not from the presence of a draft. Three
   * different things live in `data.outreachDraft` depending on that state, and calling all of them
   * "the email that will be sent" is how a panel ends up promising a send that already happened.
   * ⚠️ `outreachSentVia: 'manual'` is the user telling us THEY contacted the lead some other way —
   * the stored text was never emailed from here and must not be described as what the contact read.
   */
  function recordEmailPanel(data) {
    const draft = (data && typeof data.outreachDraft === 'object') ? data.outreachDraft : null;
    const body = draft && typeof draft.body === 'string' ? draft.body.trim() : '';
    const state = outreachState(data);
    const manual = state === 'sent' && data.outreachSentVia === 'manual';

    if (!body) {
      return `<div class="${SECTION}">
        <p class="${LABEL} mb-2">Outreach email</p>
        <p class="text-sm text-gray-500">No email has been drafted for this lead yet.</p>
      </div>`;
    }

    const heading = manual ? 'The drafted email'
      : state === 'sent' ? 'The email that was sent'
      : state === 'drafted' ? 'Your drafted email — ready for you to send'
      : 'The drafted email';
    const note = manual
      ? 'You marked this lead as contacted yourself, so this draft was never emailed from here.'
      : state === 'sent'
        ? `This is the message that went to the contact${data.outreachSentAt ? ` on ${fmtDateTime(data.outreachSentAt)}` : ''}.`
        : state === 'drafted'
          ? 'Nothing has been emailed. This is yours to send from your own inbox.'
          : 'Not sent yet — approving this lead in the Outreach tab is what releases it.';

    return `<div class="${SECTION}">
      <p class="${LABEL} mb-1">${esc(heading)}</p>
      <p class="text-xs text-gray-500 mb-2">${esc(note)}</p>
      <div class="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
        ${draft.to ? `<div class="px-3 py-2 border-b border-gray-200 text-xs"><span class="text-gray-400 font-bold">To</span> <span class="text-gray-800">${esc(draft.to)}</span></div>` : ''}
        ${draft.subject ? `<div class="px-3 py-2 border-b border-gray-200 text-xs"><span class="text-gray-400 font-bold">Subject</span> <span class="text-gray-900 font-bold">${esc(draft.subject)}</span></div>` : ''}
        <pre class="px-3 py-3 text-xs text-gray-700 whitespace-pre-wrap break-words font-sans max-h-64 overflow-y-auto m-0">${esc(body)}</pre>
      </div>
    </div>`;
  }

  /**
   * The email panel for a FOLLOW-UP chip.
   *
   * There is deliberately no draft to show. process-sequence-sends.ts writes each chaser at send
   * time from the thread's history, so no text exists for a step that has not gone yet — and
   * inventing a preview here would be a preview of something the worker will not send. What the
   * panel CAN honestly show is the thread so far, which is the context that chaser is written
   * against, so the last outbound message is rendered under a heading that says exactly that.
   */
  function followUpEmailPanel(followUp, messages) {
    const outbound = (messages || []).filter((m) => m.direction === 'outbound');
    const last = outbound.length ? outbound[outbound.length - 1] : null;
    return `<div class="${SECTION}">
      <p class="${LABEL} mb-1">What will be sent</p>
      <p class="text-xs text-gray-500 mb-2">
        Follow-up #${esc(followUp.nextStep)} is written when it goes out, in the context of this
        conversation — so there is no draft to read yet. It only sends if they still haven't
        replied${followUp.contactEmail ? `, and it goes to ${esc(followUp.contactEmail)}` : ''}.
      </p>
      ${last ? `
        <p class="${LABEL} mb-1 mt-3">The last message we sent</p>
        <div class="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
          ${last.subject ? `<div class="px-3 py-2 border-b border-gray-200 text-xs"><span class="text-gray-400 font-bold">Subject</span> <span class="text-gray-900 font-bold">${esc(last.subject)}</span></div>` : ''}
          <pre class="px-3 py-3 text-xs text-gray-700 whitespace-pre-wrap break-words font-sans max-h-56 overflow-y-auto m-0">${esc(last.body || '')}</pre>
          ${last.occurredAt ? `<div class="px-3 py-2 border-t border-gray-200 text-[11px] text-gray-400">Sent ${esc(fmtDateTime(last.occurredAt))}</div>` : ''}
        </div>` : ''}
    </div>`;
  }

  /**
   * Lead details. Reads the scoring card's closed shape (discovery-scoring.ts normaliseLeadCard)
   * with fallbacks for CSV-imported and hand-added leads, which carry the same keys at top level
   * but never all of them.
   */
  function leadPanel(record) {
    const d = record.data || {};
    const lead = (d.lead && typeof d.lead === 'object') ? d.lead : {};
    const email = d.contactEmail || lead.email || (d.outreachDraft && d.outreachDraft.to) || '';
    const website = d.website || lead.website || '';
    const reasons = Array.isArray(d.reasons) ? d.reasons.filter((r) => typeof r === 'string') : [];

    return `<div class="${SECTION}">
      <p class="${LABEL} mb-2">Lead</p>
      ${textField('Contact', d.contactName || lead.contactName || '')}
      ${email ? field('Email', `<a href="mailto:${esc(email)}" class="text-emerald-700 font-semibold hover:underline">${esc(email)}</a>`) : ''}
      ${website ? field('Website', `<a href="${esc(/^https?:\/\//i.test(website) ? website : 'https://' + website)}" target="_blank" rel="noopener noreferrer" class="text-emerald-700 font-semibold hover:underline">${esc(website)}</a>`) : ''}
      ${textField('Industry', d.industry || lead.industry || '')}
      ${textField('Location', d.location || lead.location || '')}
      ${d.score != null ? textField('Score', `${d.score}/100`) : ''}
      ${textField('Source', record.source || '')}
      ${textField('Added', fmtDate(record.createdAt))}
      ${reasons.length ? `
        <div class="mt-3">
          <p class="${LABEL} mb-1">Why it scored this way</p>
          <ul class="list-disc pl-5 space-y-0.5">
            ${reasons.slice(0, 6).map((r) => `<li class="text-sm text-gray-700">${esc(r)}</li>`).join('')}
          </ul>
        </div>` : ''}
      ${d.suggestedNextStep ? `
        <div class="mt-3">
          <p class="${LABEL} mb-1">Suggested next step</p>
          <p class="text-sm text-gray-700">${esc(d.suggestedNextStep)}</p>
        </div>` : ''}
      ${d.notes ? `
        <div class="mt-3">
          <p class="${LABEL} mb-1">Your notes</p>
          <p class="text-sm text-gray-700 whitespace-pre-wrap">${esc(d.notes)}</p>
        </div>` : ''}
    </div>`;
  }

  /** The strip that says what the CALENDAR ENTRY is — the one thing a user opens this to learn. */
  function whatThisIsPanel(opts, record, followUp) {
    if (opts.kind === 'followup' && followUp) {
      const blocked = followUp.threadState && followUp.threadState !== 'open';
      return `<div class="rounded-xl border ${blocked ? 'border-gray-200 bg-gray-50' : 'border-indigo-200 bg-indigo-50'} p-3">
        <p class="text-xs font-bold ${blocked ? 'text-gray-600' : 'text-indigo-800'}">
          ${blocked
            ? `Follow-up #${esc(followUp.nextStep)} is on hold`
            : `Follow-up #${esc(followUp.nextStep)} sends ${esc(fmtDateTime(followUp.nextSendAt))}`}
        </p>
        <p class="text-xs ${blocked ? 'text-gray-500' : 'text-indigo-700'} mt-1">
          ${blocked
            ? 'They have replied, so the cadence stops here — nothing further is sent automatically.'
            : 'This is a real email. Drag the chip on the calendar to move it; it can’t be moved into the past.'}
        </p>
      </div>`;
    }
    const when = record && record.scheduledFor ? fmtDateTime(record.scheduledFor) : '';
    return `<div class="rounded-xl border border-yellow-200 bg-yellow-50 p-3">
      <p class="text-xs font-bold text-yellow-800">Chase reminder${when ? ` — ${esc(when)}` : ''}</p>
      <p class="text-xs text-yellow-700 mt-1">
        A prompt for you, not a scheduled send. The outreach email below has already gone out;
        nothing is emailed on this date.
      </p>
    </div>`;
  }

  /** The cadence line on a record chip: is a chaser still coming, and when? */
  function cadencePanel(enrolment) {
    if (!enrolment) return '';
    if (enrolment.state === 'active' && enrolment.nextSendAt) {
      return `<div class="${SECTION}">
        <p class="${LABEL} mb-1">Follow-ups</p>
        <p class="text-sm text-gray-700">Next chaser goes out ${esc(fmtDateTime(enrolment.nextSendAt))} (#${esc((enrolment.lastStepSent || 0) + 1)}).</p>
      </div>`;
    }
    return `<div class="${SECTION}">
      <p class="${LABEL} mb-1">Follow-ups</p>
      <p class="text-sm text-gray-700">Stopped${enrolment.haltReasonLabel ? ` — ${esc(enrolment.haltReasonLabel)}` : ''}. Nothing further is sent automatically.</p>
    </div>`;
  }

  // ── Fetching ──────────────────────────────────────────────────────────────

  async function loadRecord(assistantId, recordId) {
    if (!Number.isInteger(Number(recordId))) return null;
    try {
      const res = await fetch(`/.netlify/functions/assistant-records?assistantId=${encodeURIComponent(assistantId)}&recordId=${encodeURIComponent(recordId)}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) return null;
      return (await res.json()).record || null;
    } catch { return null; }
  }

  async function loadThread(assistantId, threadId) {
    if (!Number.isInteger(Number(threadId))) return null;
    try {
      const res = await fetch('/.netlify/functions/lead-threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'get', assistantId, threadId }),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  /**
   * A record chip has no threadId, so the cadence line needs one resolved from the record. The
   * `calendar` action is already the cheapest read of active enrolments for this assistant and is
   * scoped to it, so it is reused with no window rather than adding a lookup endpoint for one line
   * of copy. Returns null when the lead has no live cadence, which is the common case.
   */
  async function findFollowUpForRecord(assistantId, recordId) {
    try {
      const res = await fetch('/.netlify/functions/lead-threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'calendar', assistantId }),
      });
      if (!res.ok) return null;
      const { followUps } = await res.json();
      return (followUps || []).find((f) => f.assistantRecordId === Number(recordId)) || null;
    } catch { return null; }
  }

  // ── The modal ─────────────────────────────────────────────────────────────

  function open(opts) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100 shrink-0">
          <div class="min-w-0">
            <h3 data-lcm-title class="text-lg font-bold text-gray-900 truncate">Loading…</h3>
            <div data-lcm-chips class="flex items-center gap-2 mt-1 flex-wrap"></div>
          </div>
          <button type="button" data-lcm-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer shrink-0">&times;</button>
        </div>
        <div data-lcm-body class="p-5 overflow-y-auto flex-1">
          <div class="flex items-center justify-center py-10 text-sm text-gray-400">Loading details…</div>
        </div>
        <div data-lcm-foot class="flex items-center justify-end gap-2 p-4 border-t border-gray-100 shrink-0"></div>
      </div>`;

    // `changed` is tracked rather than calling back per action: the calendar's refresh is a full
    // range reload, and firing it on close once is cheaper than after every button.
    let changed = false;
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (changed) opts.onChanged?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-lcm-close]').addEventListener('click', close);
    document.body.appendChild(overlay);

    const titleEl = overlay.querySelector('[data-lcm-title]');
    const chipsEl = overlay.querySelector('[data-lcm-chips]');
    const bodyEl = overlay.querySelector('[data-lcm-body]');
    const footEl = overlay.querySelector('[data-lcm-foot]');

    // Name the thing straight away from what the calendar already knows, so the header is never
    // the word "Loading" over a chip the user can still see behind the modal.
    if (opts.followUp && opts.followUp.title) titleEl.textContent = opts.followUp.title;

    void (async () => {
      const assistantId = Number(opts.assistantId);
      const isFollowUp = opts.kind === 'followup';

      // The record is the identity in both cases; the thread is only fetched for a follow-up,
      // where its history is the panel's whole content.
      const [record, thread] = await Promise.all([
        loadRecord(assistantId, opts.recordId),
        isFollowUp ? loadThread(assistantId, opts.threadId) : Promise.resolve(null),
      ]);

      // A record chip's cadence line needs an enrolment the calendar never loaded for it.
      const followUp = isFollowUp
        ? (opts.followUp || null)
        : (record ? await findFollowUpForRecord(assistantId, record.id) : null);

      if (!overlay.isConnected) return;   // closed while the fetches were in flight

      const data = (record && record.data) || {};
      const title = (record && record.title) || (opts.followUp && opts.followUp.title) || (thread && thread.thread && thread.thread.title) || 'Lead';
      titleEl.textContent = title;

      chipsEl.innerHTML = [
        record ? ratingChip(record.status) : '',
        record ? outreachChip(data) : '',
        isFollowUp
          ? `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-indigo-50 text-indigo-700 border-indigo-200">Pending follow-up</span>`
          : `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-yellow-50 text-yellow-700 border-yellow-200">Chase reminder</span>`,
      ].filter(Boolean).join('');

      // A follow-up whose lead record has been deleted still has a thread and a due date, so the
      // panel degrades to those rather than refusing to open.
      const missingRecord = !record;

      bodyEl.innerHTML = `
        ${whatThisIsPanel(opts, record, isFollowUp ? followUp : null)}
        ${isFollowUp
          ? followUpEmailPanel(followUp || { nextStep: '', contactEmail: (thread && thread.thread && thread.thread.contactEmail) || '' }, thread && thread.messages)
          : recordEmailPanel(data)}
        ${missingRecord
          ? `<div class="${SECTION}"><p class="text-sm text-gray-500">This lead's record is no longer in the Data Hub, so there are no details to show.</p></div>`
          : leadPanel(record)}
        ${isFollowUp ? '' : cadencePanel(followUp
          ? { state: 'active', nextSendAt: followUp.nextSendAt, lastStepSent: followUp.lastStepSent }
          : null)}`;

      // ── Footer ──────────────────────────────────────────────────────────
      // "Stop follow-ups" is the only write this panel offers, and only where it is meaningful:
      // an ACTIVE cadence on an open thread. It is the one thing a user looking at a pending
      // chaser most often wants and currently has to go to the Conversations tab to do.
      const canStop = isFollowUp && followUp && !(followUp.threadState && followUp.threadState !== 'open');
      footEl.innerHTML = `
        ${canStop ? `<button type="button" data-lcm-stop class="px-4 py-2 text-sm font-bold text-red-700 bg-white border border-gray-200 hover:border-red-300 rounded-lg transition cursor-pointer">Stop follow-ups</button>` : ''}
        <button type="button" data-lcm-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 rounded-lg cursor-pointer">Close</button>`;
      footEl.querySelector('[data-lcm-close]').addEventListener('click', close);

      footEl.querySelector('[data-lcm-stop]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        // Destructive and irreversible — haltEnrolment writes a terminal row and there is no
        // "resume" anywhere in the product, so this asks first.
        const ok = window.confirmModal
          ? await window.confirmModal(
              `No more follow-up emails will go to <strong>${esc(title)}</strong>. This can’t be undone.`,
              { title: 'Stop follow-ups?', confirmLabel: 'Stop follow-ups' })
          : true;
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = 'Stopping…';
        try {
          const res = await fetch('/.netlify/functions/lead-threads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ action: 'stop_follow_ups', assistantId, threadId: opts.threadId }),
          });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(out.error || 'Could not stop the follow-ups.');
          changed = true;
          window.showToast?.('Follow-ups stopped.');
          close();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Stop follow-ups';
          window.showToast?.(err.message || 'Could not stop the follow-ups.', { icon: '⚠️' });
        }
      });
    })();
  }

  window.LeadCalendarModal = { open };
})();
