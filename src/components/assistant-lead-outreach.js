/**
 * src/components/assistant-lead-outreach.js
 * The Lead Generator's Outreach tab, laid out as the steps a lead goes through —
 *
 *   1 To approve │ 2 Following up │ 3 Replied │ 4 Finished │ Archived
 *
 * docs/lead-outreach-restructure-plan.md, Phase 2. Which stage a lead is in is decided by ONE
 * function, window.LeadOutreachPhase.of (src/config/lead-outreach-phase.ts); this file only draws
 * the strip and decides what is on screen under it.
 *
 * ── What it reuses, and why ───────────────────────────────────────────────────
 * Nothing here renders a lead. Each stage is an existing, tested surface:
 *   • To approve  → the review cards (assistants.js detailRqOpenStatus 'review'), with a second pill
 *                   for approved leads the user has to send themselves ('approved', filtered there to
 *                   the unsent ones). Bulk approve, Edit draft, Send email now — all unchanged.
 *   • Following up / Replied / Finished → the conversations list (assistant-lead-threads.js), fed by
 *                   lead-threads.ts `board` and filtered to one phase.
 *   • Archived    → the review cards' 'archived' column.
 * The shared lifecycle columns (#detail-rq-colstrip) are hidden for this role only; every other role
 * keeps them, and `reset()` puts them back when the page is reused for a different assistant
 * (workspace.html loadView reuses the view across assistant switches).
 *
 * ⚠️ This is the Conversations tab's replacement. `_activateMainTab('conversations')` is an alias for
 * opening this tab, so old links, bookmarks and notifications still land somewhere true.
 *
 * Styling reuses classes already compiled into style.css (no Tailwind rebuild).
 */
(function () {
  /** The steps, left to right. Labels come from the generated vocabulary where it is loaded. */
  const STAGES = ['to_approve', 'following_up', 'replied', 'finished', 'archived'];
  const FALLBACK_LABELS = {
    to_approve: 'To approve', following_up: 'Following up', replied: 'Replied', finished: 'Finished', archived: 'Archived',
  };
  /** The conversations stages — rendered by assistant-lead-threads.js rather than the review cards. */
  const BOARD_STAGES = new Set(['following_up', 'replied', 'finished']);

  /**
   * One line under the strip saying what this step is for and what happens next. The "what next"
   * is the part users asked for: a stage with no stated exit reads as a place leads go to die.
   */
  const STAGE_NOTES = {
    to_approve: 'Read each drafted first email and approve it — it goes from your connected inbox. Approved leads with no inbox connected wait here for you to send.',
    following_up: 'Sent, no reply yet. Your follow-up plan chases them from your own mailbox and stops the moment they reply.',
    replied: 'They wrote back. Read the reply, answer it here, and record how it ends — won, lost or disqualified.',
    finished: 'Done, one way or the other. A win can add them to your Audience (it is a box on the outcome form); leads with no reply stay on the normal 30-day clock and are never added to a marketing list.',
    archived: 'Turned down before anything was sent.',
  };

  /** Old column / tab names a deep link may still carry, mapped onto a stage (and sub-view). */
  const LEGACY = {
    review: { stage: 'to_approve', sub: 'review' },
    approved: { stage: 'to_approve', sub: 'approved' },
    scheduled: { stage: 'following_up' },
    archived: { stage: 'archived' },
    conversations: { stage: 'following_up' },
  };

  let state = {
    staged: false,
    assistantId: null,
    stage: 'to_approve',
    sub: 'review',               // to_approve only: 'review' | 'approved' (send it yourself)
    records: { review: null, sendYourself: null, archived: null },
    board: null,                 // counts from lead-threads.ts `board`
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const $ = (id) => document.getElementById(id);

  function stageLabel(key) {
    const P = window.LeadOutreachPhase;
    return (P && P.phaseLabels && P.phaseLabels[key]) || FALLBACK_LABELS[key] || key;
  }

  /** Show or hide an element. `hidden` alone loses to an inline display (see project notes). */
  function show(el, on) {
    if (!el) return;
    el.classList.toggle('hidden', !on);
    el.style.display = on ? '' : 'none';
  }

  // ── Counts ────────────────────────────────────────────────────────────────

  function stageCount(key) {
    const r = state.records;
    const b = state.board && state.board.phases;
    switch (key) {
      case 'to_approve':
        if (r.review == null && r.sendYourself == null) return null;
        return (r.review || 0) + (r.sendYourself || 0);
      case 'archived': return r.archived;
      default: return b ? (b[key] || 0) : null;
    }
  }

  /** Leads in Following up whose plan has stopped on something the user can fix. */
  function attentionCount() {
    return (state.board && state.board.needsAttention) || 0;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  function badge(key) {
    const n = stageCount(key);
    if (!n) return '';
    // Replied is the one stage that is waiting on the user, so it is the one that is amber. It
    // clears when an outcome is recorded — the lead moves to Finished — which is what makes a badge
    // here honest where it was not on the old Conversations tab (no way to clear it).
    const cls = key === 'replied' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600';
    return `<span class="ml-1 ${cls} text-xs px-1.5 py-0.5 rounded-full">${esc(n)}</span>`;
  }

  function stripHtml() {
    const attention = attentionCount();
    const buttons = STAGES.map((key, i) => {
      const on = key === state.stage;
      // Numbered, because the order IS the point — except Archived, which is a side exit rather
      // than a fifth step.
      const num = key === 'archived' ? '' : `<span class="text-gray-400 mr-1">${i + 1}</span>`;
      const flag = key === 'following_up' && attention
        ? `<span class="ml-1 bg-red-100 text-red-700 text-xs px-1.5 py-0.5 rounded-full" title="Needs attention">${esc(attention)} need${attention === 1 ? 's' : ''} you</span>`
        : '';
      return `<button type="button" role="tab" data-lo-stage="${key}" aria-selected="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}"
        class="px-4 py-2 text-sm whitespace-nowrap rounded-t ${on ? 'font-semibold border-b-2 text-emerald-800' : 'font-medium text-gray-500 hover:text-gray-700'}"
        ${on ? 'style="border-bottom-color:#ff007f"' : ''}>${num}${esc(stageLabel(key))}${badge(key)}${flag}</button>`;
    }).join('');

    const r = state.records;
    const subs = state.stage === 'to_approve' ? `
      <div class="flex flex-wrap gap-2 px-4 pt-3" role="group" aria-label="To approve">
        ${[['review', 'Waiting for your approval', r.review], ['approved', 'Approved — send it yourself', r.sendYourself]]
          .map(([key, label, n]) => {
            const on = state.sub === key;
            return `<button type="button" data-lo-sub="${key}" aria-pressed="${on ? 'true' : 'false'}"
              class="px-3 py-1 text-xs font-bold rounded-full border transition cursor-pointer ${on ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:border-gray-400'}">
              ${esc(label)}${n ? ` · ${esc(n)}` : ''}</button>`;
          }).join('')}
      </div>` : '';

    return `
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-4">
        <div class="tab-scroller flex gap-1 px-4 pt-3 border-b border-gray-100 overflow-x-auto" role="tablist" aria-label="Outreach stages">${buttons}</div>
        ${subs}
        <div class="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
          <p class="text-xs text-gray-500 flex-1 min-w-0" data-lo-note>${esc(noteText())}</p>
          <button type="button" data-lo-plan aria-expanded="${window.LeadFollowUpPlan?.isOpen() ? 'true' : 'false'}" aria-controls="lead-follow-up-plan"
            class="btn-secondary px-3 py-1.5 text-xs font-bold rounded-lg border shrink-0">Follow-up plan</button>
        </div>
      </div>`;
  }

  /**
   * The note under the strip. To approve's carries the consent disclosure: approving starts the
   * follow-up plan, so the note says what that plan is NOW (assistant-follow-up-plan.js), not a
   * cadence typed into the copy that the user may since have changed.
   */
  function noteText() {
    const base = STAGE_NOTES[state.stage] || '';
    if (state.stage !== 'to_approve') return base;
    const plan = window.LeadFollowUpPlan?.plan();
    if (!plan || !plan.summary) return base;
    return plan.enabled
      ? `${base} Approving also starts your follow-up plan: ${plan.summary}, stopping the moment they reply.`
      : `${base} Follow-ups are off, so approving sends one email only.`;
  }

  function paintStrip() {
    const host = $('lead-outreach-stages');
    if (!host || !state.staged) return;
    host.innerHTML = stripHtml();
  }

  /** Put the right surface under the strip for the current stage. */
  function paintBody() {
    const onBoard = BOARD_STAGES.has(state.stage);
    show($('detail-rq-card'), !onBoard);
    show($('lead-threads-host'), onBoard);
    if (onBoard) {
      window.AssistantLeadThreads?.showPhase(state.stage);
    } else if (typeof window.detailRqOpenStatus === 'function') {
      window.detailRqOpenStatus(state.stage === 'archived' ? 'archived' : state.sub);
    }
  }

  // ── Wiring (delegated once; the host is re-rendered on every count) ───────

  document.addEventListener('click', (e) => {
    const host = $('lead-outreach-stages');
    if (!host || !host.contains(e.target)) return;
    const stageBtn = e.target.closest('[data-lo-stage]');
    if (stageBtn) { open(stageBtn.getAttribute('data-lo-stage')); return; }
    const subBtn = e.target.closest('[data-lo-sub]');
    if (subBtn) { open('to_approve', subBtn.getAttribute('data-lo-sub')); return; }
    if (e.target.closest('[data-lo-plan]')) {
      window.LeadFollowUpPlan?.toggle();
      paintStrip();                                // aria-expanded on the button
    }
  });

  // The plan loaded or changed (the panel, or the chat's card) — the To approve note quotes it.
  document.addEventListener('lead:followUpPlanChanged', () => paintStrip());
  document.addEventListener('lead:followUpPlanToggled', () => paintStrip());

  // Arrow keys move along the strip, as on the other tab strips (roving tabindex).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const btn = e.target.closest && e.target.closest('[data-lo-stage]');
    if (!btn) return;
    const i = STAGES.indexOf(btn.getAttribute('data-lo-stage'));
    const next = STAGES[(i + (e.key === 'ArrowRight' ? 1 : STAGES.length - 1)) % STAGES.length];
    open(next);
    $('lead-outreach-stages')?.querySelector(`[data-lo-stage="${next}"]`)?.focus();
  });

  /** Open a stage (and, for To approve, a sub-view). Unknown keys are ignored. */
  function open(stage, sub) {
    if (!STAGES.includes(stage)) return;
    state.stage = stage;
    if (stage === 'to_approve' && (sub === 'review' || sub === 'approved')) state.sub = sub;
    paintStrip();
    paintBody();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.AssistantLeadOutreach = {
    /** Called from _applyDashboardRegistry for a role whose reviewQueue is `staged`. */
    init({ assistantId }) {
      state = {
        ...state,
        staged: true,
        assistantId,
        stage: 'to_approve',
        sub: 'review',
        records: { review: null, sendYourself: null, archived: null },
        board: null,
      };
      show($('detail-rq-colstrip'), false);
      show($('lead-outreach-stages'), true);
      show($('lead-follow-up-plan'), true);
      window.LeadFollowUpPlan?.init({ assistantId });
      paintStrip();
    },

    /** Every other role: put the shared lifecycle columns back exactly as the markup has them. */
    reset() {
      state.staged = false;
      const host = $('lead-outreach-stages');
      if (host) host.innerHTML = '';
      show(host, false);
      const plan = $('lead-follow-up-plan');
      if (plan) plan.innerHTML = '';
      show(plan, false);
      show($('detail-rq-colstrip'), true);
      show($('detail-rq-card'), true);
      show($('lead-threads-host'), false);
    },

    isStaged() { return state.staged; },

    /**
     * The tab was opened. `wanted` may be a stage, a legacy column ('approved' from the mailbox
     * connect return) or the old 'conversations' tab name; otherwise the stage last open is kept.
     */
    activate(wanted) {
      if (!state.staged) return;
      // A deep link to one lead (the reply notification) wins over any stage the link named: the
      // lead may have moved on since the link was made, and the row is what the user came for.
      const focusPhase = window.AssistantLeadThreads?.pendingFocusPhase?.();
      if (focusPhase) { open(focusPhase); return; }
      const legacy = wanted && LEGACY[wanted];
      if (legacy) open(legacy.stage, legacy.sub);
      else if (wanted && STAGES.includes(wanted)) open(wanted);
      else open(state.stage, state.sub);
    },

    open,

    /** From the review cards' counts (assistants.js _detailRqRefreshRecordCounts). */
    setRecordCounts({ review, sendYourself, archived }) {
      state.records = { review, sendYourself, archived };
      paintStrip();
    },

    /** From lead-threads.ts `board` (assistant-lead-threads.js). */
    setBoardCounts(counts) {
      state.board = counts || null;
      paintStrip();
    },

    /**
     * Open the stage a lead is in and focus it — the All leads tab's "Open in Outreach" button.
     * Resolved by the conversations component, which holds the board.
     */
    openRecord(recordId) {
      window._activateMainTab?.('review-queue');
      window.AssistantLeadThreads?.focus({ recordId });
    },
  };
})();
