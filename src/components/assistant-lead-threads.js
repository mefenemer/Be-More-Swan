/**
 * src/components/assistant-lead-threads.js
 * Conversations tab — the human-facing surface over Phase 2 of
 * docs/lead-generator-revenue-engine-plan.md (§5.1 threads, §5.2 sequences).
 *
 * The mockup calls this screen "Deal Thread". It is named Conversations here because the deal
 * half of that mockup — envelope, floor price, concession rounds, Closing Agent — is Phase 4 and
 * does not exist. Naming the tab after the part that isn't built would advertise a feature the
 * screen cannot show. What IS built, and what this renders:
 *
 *   • the exchange itself      lead_messages, outbound + inbound, in order
 *   • what a reply meant       classification / sentiment / objections, set by the classifier
 *   • what the human changed   generated_body vs body — the §2.6 edit, shown as a diff
 *   • what the cadence did     sequence_enrolments: step reached, next send, why it halted
 *
 * Backed by netlify/functions/lead-threads.ts:
 *   • list → POST lead-threads { action:'list', assistantId, state?, cursor? }
 *   • get  → POST lead-threads { action:'get',  assistantId, threadId }
 *
 * Read-only about the THREAD, by design. Writes to lead_threads / lead_messages go through
 * src/utils/lead-threads.ts, which is the only writer of those tables — this screen must not become
 * a second one. "Take over thread" / "pause agent" from the mockup are thread state changes and
 * still belong with that writer, not here.
 *
 * ⚠️ There is now exactly ONE write from this screen, and it deliberately does not touch those
 * tables: "Record outcome" (won / lost / disqualified) writes `dealOutcome` onto the LEAD record
 * via lead-generation.ts `set_outcome`. It lives here because this is the screen holding the
 * evidence for the decision — reading what the prospect said in one tab and recording what it
 * meant in another is a split with no defence. The Leads tab keeps its own entry point: a lead
 * with no address, or one worked entirely offline, has no thread, and those deals must still be
 * closable. The form itself is src/components/lead-outcome-modal.js, shared by both.
 *
 * Styling reuses classes already compiled into style.css (no Tailwind rebuild — see the drift note
 * in the project conventions). All server values are escaped on render; treat them as untrusted.
 */
(function () {
  const API = '/.netlify/functions/lead-threads';

  let state = {
    assistantId: null,
    threads: [],
    counts: { total: 0, open: 0, replied: 0, stalled: 0, closed: 0 },
    // The role's label for this tab, from the registry (conversationsTab.label). Held here rather
    // than read back off the button, because the button's text carries the record count once one
    // has landed and re-wrapping it would give "Conversations (12) (12)".
    tabLabel: 'Conversations',
    stateFilter: null,
    nextCursor: null,
    // Non-null when a thread is open: { thread, messages, enrolment }.
    open: null,
    openId: null,
    showDiff: {},        // messageId → bool, for "show changes vs template"
    loading: false,
    error: null,
    rendered: false,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const host = () => document.getElementById('lead-threads-host');

  async function call(action, extra) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action, assistantId: state.assistantId, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { code: data.code });
    return data;
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  /** "3d ago" / "just now". Coarse on purpose — an exact timestamp is noise in a timeline. */
  function ago(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  /** Future-facing counterpart, for the next scheduled send. */
  function until(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const mins = Math.round((then - Date.now()) / 60000);
    if (mins <= 0) return 'due now';
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `in ${hours}h`;
    return `in ${Math.round(hours / 24)}d`;
  }

  const THREAD_CHIP = {
    open: 'bg-amber-50 text-amber-700 border-amber-200',
    replied: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    stalled: 'bg-gray-100 text-gray-500 border-gray-200',
    closed: 'bg-gray-100 text-gray-500 border-gray-200',
  };
  const THREAD_LABEL = {
    open: 'Awaiting reply',
    replied: 'Replied',
    stalled: 'Stalled',
    closed: 'Closed',
  };

  // How the classifier's verdict on an inbound reply is shown. Mirrors the `classification`
  // vocabulary on lead_messages; an unknown value falls through to the raw string rather than
  // vanishing, so a newly-added class is visible rather than silently dropped.
  const CLASS_CHIP = {
    interested: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    not_now: 'bg-amber-50 text-amber-700 border-amber-200',
    objection: 'bg-amber-50 text-amber-800 border-amber-300',
    not_interested: 'bg-gray-100 text-gray-500 border-gray-200',
    unsubscribe: 'bg-red-50 text-red-700 border-red-200',
    ooo: 'bg-gray-100 text-gray-500 border-gray-200',
    other: 'bg-gray-100 text-gray-500 border-gray-200',
  };
  const CLASS_LABEL = {
    interested: 'Interested',
    not_now: 'Not right now',
    objection: 'Objection',
    not_interested: 'Not interested',
    unsubscribe: 'Unsubscribed',
    ooo: 'Out of office',
    other: 'Other',
  };

  const chip = (cls, text) => `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${cls}">${esc(text)}</span>`;

  // ── Deal outcome ───────────────────────────────────────────────────────────
  // How the deal ENDED, which is a different axis from the thread state above it. A thread can be
  // 'replied' and the deal won, lost or still running; a thread can be 'stalled' and the deal won
  // on the phone. Neither column can be derived from the other, which is exactly why marking the
  // outcome has to be an explicit act rather than something inferred from the last message.
  const OUTCOME_CHIP = {
    won: 'bg-green-50 text-green-700 border-green-100',
    lost: 'bg-red-50 text-red-700 border-red-200',
    disqualified: 'bg-gray-100 text-gray-500 border-gray-200',
  };

  /** The recorded outcome's display label, via the generated vocabulary. Empty when unrecorded. */
  function outcomeLabel(outcome) {
    const RC = window.RevenueConstants;
    return (RC && outcome) ? RC.outcomeLabel(outcome) : '';
  }

  /**
   * The strip that closes the lifecycle: what the deal came to, and the button to say so.
   *
   * ⚠️ Gated on `assistantRecordId`. `set_outcome` is keyed by the LEAD record, and a thread can
   * exist without one — a record deleted after the conversation started leaves the thread behind
   * (the FK is ON DELETE SET NULL). Offering the button there would open a form whose save can only
   * 404, so it says why instead.
   *
   * ⚠️ Also gated on window.RevenueConstants, which carries the CHECK-constrained vocabulary. If
   * the constants script has not loaded there is nothing honest to put in the picker.
   */
  function outcomeBar(thread) {
    const recorded = thread.dealOutcome && thread.dealOutcome.outcome ? thread.dealOutcome : null;
    const label = recorded ? outcomeLabel(recorded.outcome) : '';
    const RC = window.RevenueConstants;

    if (!thread.assistantRecordId) {
      return `<div class="p-4 border-b border-gray-100 bg-gray-50">
        <p class="text-xs text-gray-500">The lead this conversation belongs to has been deleted, so there is no outcome to record against it.</p>
      </div>`;
    }

    // The reason line under a loss is the whole point of the closed vocabulary — it is what makes
    // "why are we losing?" answerable — so it is shown rather than left inside the form.
    const detail = recorded
      ? [
          recorded.lossReason && RC ? RC.lossReasonLabel(recorded.lossReason) : '',
          recorded.valueGbp != null && recorded.valueGbp !== '' ? `£${esc(recorded.valueGbp)}` : '',
        ].filter(Boolean).join(' · ')
      : '';

    return `
      <div class="p-4 border-b border-gray-100 flex flex-wrap items-center gap-2">
        ${recorded
          ? `${chip(OUTCOME_CHIP[recorded.outcome] || OUTCOME_CHIP.disqualified, label)}
             ${detail ? `<span class="text-xs text-gray-500">${detail}</span>` : ''}`
          : '<p class="text-xs text-gray-500">No outcome recorded yet — mark it when this deal is done, either way.</p>'}
        <button type="button" data-lt-outcome
          class="ml-auto px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition"
          >${recorded ? 'Change outcome' : 'Record outcome'}</button>
      </div>`;
  }

  // ── List view ──────────────────────────────────────────────────────────────

  function threadRow(t) {
    const dir = t.lastDirection === 'inbound' ? 'They wrote' : t.lastDirection === 'outbound' ? 'We wrote' : '';
    const halted = t.sequence && t.sequence.state === 'halted';
    return `
      <button type="button" data-lt-open="${t.id}"
        class="w-full text-left flex items-start gap-3 p-4 border-b border-gray-100 hover:bg-gray-50 transition">
        <div class="min-w-0 flex-1">
          <p class="font-semibold text-gray-900 text-sm">${esc(t.title)}</p>
          ${t.contactEmail ? `<p class="text-xs text-gray-400 mt-0.5">${esc(t.contactEmail)}</p>` : ''}
          ${t.lastExcerpt
            ? `<p class="text-xs text-gray-500 mt-1">${dir ? `<span class="font-bold">${dir}:</span> ` : ''}${esc(t.lastExcerpt)}</p>`
            : '<p class="text-xs text-gray-400 mt-1">No messages recorded yet.</p>'}
        </div>
        <div class="shrink-0 w-32 text-right">
          ${t.classification ? chip(CLASS_CHIP[t.classification] || CLASS_CHIP.other, CLASS_LABEL[t.classification] || t.classification) : ''}
          ${t.dealOutcome && t.dealOutcome.outcome
            ? `<div class="mt-1">${chip(OUTCOME_CHIP[t.dealOutcome.outcome] || OUTCOME_CHIP.disqualified, outcomeLabel(t.dealOutcome.outcome))}</div>`
            : ''}
        </div>
        <div class="shrink-0 w-32 text-right">
          ${chip(THREAD_CHIP[t.state] || THREAD_CHIP.closed, THREAD_LABEL[t.state] || t.state)}
          <p class="text-xs text-gray-400 mt-1">${esc(t.messageCount)} message${t.messageCount === 1 ? '' : 's'} &middot; ${esc(ago(t.updatedAt))}</p>
          ${halted && t.sequence.haltReason !== 'replied'
            ? '<p class="text-xs text-amber-700 mt-0.5">Follow-ups stopped</p>' : ''}
        </div>
      </button>`;
  }

  function listView() {
    const c = state.counts;
    const filters = [
      ['', 'All', c.total],
      ['open', 'Awaiting reply', c.open],
      ['replied', 'Replied', c.replied],
      ['stalled', 'Stalled', c.stalled],
      ['closed', 'Closed', c.closed],
    ];

    return `
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        ${[['Conversations', c.total], ['Awaiting reply', c.open], ['Replied', c.replied], ['Stalled', c.stalled]]
          .map(([label, n]) => `
          <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
            <p class="text-2xl font-bold text-gray-900">${n}</p>
            <p class="text-xs text-gray-500 mt-0.5">${label}</p>
          </div>`).join('')}
      </div>

      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm">
        <div class="p-4 border-b border-gray-100 flex flex-wrap items-center gap-2">
          ${filters.map(([v, label, n]) => `
            <button type="button" data-lt-state="${v}"
              class="px-2.5 py-1 text-xs font-bold rounded-lg border transition ${(state.stateFilter || '') === v ? 'bg-emerald-700 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}">${label} (${n})</button>`).join('')}
        </div>

        ${state.threads.length === 0
          ? `<div class="p-8 text-center">
               <p class="text-sm font-semibold text-gray-900">No conversations yet</p>
               <p class="text-xs text-gray-500 mt-1">Approve a lead and the outreach it sends starts a conversation here &mdash; including anything they write back.</p>
             </div>`
          : state.threads.map(threadRow).join('')}
      </div>

      ${state.nextCursor ? `
      <div class="text-center mt-4">
        <button type="button" data-lt-more class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-gray-300 text-xs font-bold rounded-lg transition">Load more</button>
      </div>` : ''}`;
  }

  // ── Thread view ────────────────────────────────────────────────────────────

  /**
   * Word-level diff of the agent's draft against what actually went out (plan §2.6).
   *
   * A word-level LCS is the right granularity: messages are a few hundred words, and "what did the
   * human change about the wording" is a word-level question. Two things make the output readable
   * rather than confetti:
   *
   *   • Consecutive same-type tokens are COALESCED into one span. Per-word spans turn a rewritten
   *     sentence into alternating red/green fragments with no word boundaries left to read.
   *   • Additions use green-*, not emerald-*. input.css remaps the emerald scale to the brand's
   *     neon pink, which lands close enough to the red deletions that the two stop being
   *     distinguishable — the one thing a diff has to get right.
   *
   * Both sides are escaped before any markup is added.
   */
  const DIFF_STYLE = {
    del: 'bg-red-50 text-red-700 line-through',
    ins: 'bg-green-50 text-green-700',
  };

  /**
   * A common run this short between two edits is noise, not a match.
   *
   * Raw LCS latches onto filler — "venues", "in the", "a" — and shreds a rewritten sentence into
   * alternating red/green fragments that nobody can read as either the old wording or the new one.
   * Six characters is the point where the common run stops being incidental.
   */
  const SHORT_SAME_CHARS = 6;

  /**
   * Collapse each region of change into ONE removal followed by ONE addition.
   *
   * This is what diff-match-patch calls semantic cleanup, and the reason every readable diff does
   * it: the useful unit is "here is the phrase that was there, here is the phrase that replaced
   * it", not a token-by-token account of how the algorithm got from one to the other.
   */
  function coalesceRegions(ops) {
    const isChange = (o) => o.kind !== 'same';
    const out = [];
    let k = 0;
    while (k < ops.length) {
      if (!isChange(ops[k])) { out.push(ops[k]); k++; continue; }

      // Extend through changes, and through short common runs that have another change after them.
      let end = k, lastChange = k;
      while (end < ops.length) {
        if (isChange(ops[end])) { lastChange = end; end++; }
        else if (ops[end].text.trim().length <= SHORT_SAME_CHARS
          && end + 1 < ops.length && isChange(ops[end + 1])) { end++; }
        else break;
      }

      // A common run inside the region belongs to BOTH sides — it was there before and after.
      let oldText = '', newText = '';
      for (const o of ops.slice(k, lastChange + 1)) {
        if (o.kind !== 'ins') oldText += o.text;
        if (o.kind !== 'del') newText += o.text;
      }
      if (oldText.trim()) out.push({ kind: 'del', text: oldText });
      if (newText.trim()) out.push({ kind: 'ins', text: newText });
      k = lastChange + 1;
    }
    return out;
  }

  function diffWords(before, after) {
    // Keep the separators as tokens so whitespace survives the round trip intact.
    const a = String(before || '').split(/(\s+)/);
    const b = String(after || '').split(/(\s+)/);
    const n = a.length, m = b.length;

    // Standard LCS table, bounded by message length — the sender caps that well below anything
    // that would make this expensive.
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }

    // Walk the table into runs first, render second.
    const runs = [];
    const push = (kind, text) => {
      const last = runs[runs.length - 1];
      if (last && last.kind === kind) last.text += text;
      else runs.push({ kind, text });
    };
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push('del', a[i]); i++; }
      else { push('ins', b[j]); j++; }
    }
    while (i < n) { push('del', a[i]); i++; }
    while (j < m) { push('ins', b[j]); j++; }

    const cleaned = coalesceRegions(runs);
    return cleaned.map((r, idx) => {
      if (r.kind === 'same') return esc(r.text);
      // A removal butted straight against its replacement reads as one run-on word ("UK.Grade").
      // The gap is presentational — it belongs to neither side's text.
      const gap = (r.kind === 'ins' && cleaned[idx - 1] && cleaned[idx - 1].kind === 'del') ? ' ' : '';
      // Trailing whitespace inside a highlighted run paints a stray coloured gap against the next
      // word, so it is lifted out of the span rather than filled.
      const trail = (/\s+$/.exec(r.text) || [''])[0];
      return `${gap}<span class="${DIFF_STYLE[r.kind]}">${esc(r.text.replace(/\s+$/, ''))}</span>${esc(trail)}`;
    }).join('');
  }

  function messageItem(m) {
    const inbound = m.direction === 'inbound';
    const showDiff = !!state.showDiff[m.id];
    const objections = Array.isArray(m.objections) ? m.objections : [];

    const bodyHtml = (m.edited && showDiff)
      ? diffWords(m.generatedBody, m.body)
      : esc(m.body);

    return `
      <div class="p-4 border-b border-gray-100 ${inbound ? 'bg-emerald-50' : ''}">
        <div class="flex flex-wrap items-center gap-2 mb-1">
          ${chip(inbound ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-gray-100 text-gray-600 border-gray-200',
            inbound ? 'Reply received' : 'Sent by your assistant')}
          ${m.classification ? chip(CLASS_CHIP[m.classification] || CLASS_CHIP.other, CLASS_LABEL[m.classification] || m.classification) : ''}
          ${m.edited ? chip('bg-amber-50 text-amber-700 border-amber-200', 'Edited before sending') : ''}
          <span class="text-xs text-gray-400">${esc(ago(m.occurredAt))}</span>
          ${m.edited ? `
            <label class="ml-auto flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" data-lt-diff="${m.id}" ${showDiff ? 'checked' : ''} class="cursor-pointer">
              Show changes vs the draft
            </label>` : ''}
        </div>
        ${m.subject ? `<p class="text-sm font-semibold text-gray-900">${esc(m.subject)}</p>` : ''}
        ${m.fromEmail ? `<p class="text-xs text-gray-400 mt-0.5">${inbound ? 'From' : 'To'} ${esc(m.fromEmail)}</p>` : ''}
        <p class="text-sm text-gray-700 mt-2 whitespace-pre-wrap">${bodyHtml}</p>
        ${objections.length ? `<p class="text-xs text-amber-800 mt-2">Objections raised: ${objections.map((o) => esc(o)).join(', ')}</p>` : ''}
        ${m.edited && m.editedByName ? `<p class="text-xs text-gray-400 mt-2">Edited by ${esc(m.editedByName)} before sending.</p>` : ''}
      </div>`;
  }

  /** The cadence banner: what the sequence engine is doing, or why it stopped. */
  function cadenceBanner(e) {
    if (!e) {
      return `<div class="p-4 border-b border-gray-100 bg-gray-50">
        <p class="text-xs text-gray-500">No follow-up sequence is running on this conversation.</p>
      </div>`;
    }
    if (e.state === 'active') {
      return `<div class="p-4 border-b border-gray-100 bg-gray-50">
        <p class="text-xs text-gray-600">
          <span class="font-bold">Follow-ups running.</span>
          ${e.lastStepSent > 0 ? `Step ${esc(e.lastStepSent)} sent.` : 'Opening email sent.'}
          ${e.nextSendAt ? `Next nudge ${esc(until(e.nextSendAt))}.` : ''}
        </p>
      </div>`;
    }
    // 'replied' is the success case and reads as good news; every other halt is something the user
    // may need to act on, so it gets the amber treatment.
    const good = e.haltReason === 'replied' || e.state === 'completed';
    return `<div class="p-4 border-b border-gray-100 ${good ? 'bg-emerald-50' : 'bg-amber-50'}">
      <p class="text-xs ${good ? 'text-emerald-800' : 'text-amber-800'}">
        <span class="font-bold">Follow-ups stopped.</span>
        ${esc(e.haltReasonLabel || (e.state === 'completed' ? 'The sequence finished.' : 'The sequence is no longer running.'))}
      </p>
      ${e.lastError ? `<p class="text-xs text-gray-500 mt-1">Last error: ${esc(e.lastError)}</p>` : ''}
    </div>`;
  }

  function threadView() {
    const { thread, messages, enrolment } = state.open;
    return `
      <button type="button" data-lt-back class="mb-4 text-xs font-bold text-gray-500 hover:text-gray-900 transition">&larr; All conversations</button>

      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm">
        <div class="p-4 border-b border-gray-100 flex flex-wrap items-center gap-2">
          <div class="min-w-0">
            <p class="font-semibold text-gray-900 text-sm">${esc(thread.title)}</p>
            ${thread.contactEmail ? `<p class="text-xs text-gray-400 mt-0.5">${esc(thread.contactEmail)} &middot; ${esc(thread.channel)}</p>` : ''}
          </div>
          <div class="ml-auto">${chip(THREAD_CHIP[thread.state] || THREAD_CHIP.closed, THREAD_LABEL[thread.state] || thread.state)}</div>
        </div>

        ${outcomeBar(thread)}
        ${cadenceBanner(enrolment)}

        ${messages.length
          ? messages.map(messageItem).join('')
          : `<div class="p-8 text-center">
               <p class="text-sm font-semibold text-gray-900">Nothing recorded on this conversation</p>
               <p class="text-xs text-gray-500 mt-1">The thread exists but no message was written to it &mdash; check the function logs for lead-threads warnings.</p>
             </div>`}
      </div>`;
  }

  // ── Shell ──────────────────────────────────────────────────────────────────

  function view() {
    if (state.loading && !state.threads.length && !state.open) {
      return `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center text-sm text-gray-500">Loading conversations…</div>`;
    }
    if (state.error) {
      return `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <p class="text-sm font-semibold text-gray-900">${esc(state.error)}</p>
        <button type="button" data-lt-retry class="mt-3 px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-gray-300 text-xs font-bold rounded-lg transition">Try again</button>
      </div>`;
    }
    return state.open ? threadView() : listView();
  }

  function render() {
    const h = host();
    if (!h) return;
    h.innerHTML = view();
    bind(h);
  }

  function bind(h) {
    h.querySelector('[data-lt-retry]')?.addEventListener('click', () => (state.open ? openThread(state.openId) : load()));
    h.querySelector('[data-lt-back]')?.addEventListener('click', () => {
      state.open = null;
      state.openId = null;
      state.showDiff = {};
      render();
    });
    h.querySelectorAll('[data-lt-state]').forEach((b) => b.addEventListener('click', () => {
      const v = b.getAttribute('data-lt-state');
      state.stateFilter = v || null;
      load();
    }));
    h.querySelectorAll('[data-lt-open]').forEach((b) => b.addEventListener('click', () => {
      openThread(Number(b.getAttribute('data-lt-open')));
    }));
    h.querySelector('[data-lt-more]')?.addEventListener('click', () => load({ append: true }));
    h.querySelectorAll('[data-lt-diff]').forEach((box) => box.addEventListener('change', () => {
      state.showDiff[box.getAttribute('data-lt-diff')] = box.checked;
      render();
    }));
    h.querySelector('[data-lt-outcome]')?.addEventListener('click', () => {
      const t = state.open && state.open.thread;
      if (!t || !t.assistantRecordId) return;
      window.LeadOutcomeModal?.open({
        assistantId: state.assistantId,
        recordId: t.assistantRecordId,
        title: t.title,
        existing: t.dealOutcome || null,
        // Patched in place rather than refetched. The save has already told us what was written,
        // and a refetch would reset the thread view — collapsing the diffs the user had open and
        // scrolling them away from the message they were reading when they decided the outcome.
        //
        // ⚠️ The LIST copy is updated too. It carries its own dealOutcome for the chip, and
        // going back to a list still showing "no outcome" on a deal just closed reads as the save
        // having failed.
        onSaved: (dealOutcome) => {
          t.dealOutcome = dealOutcome;
          const row = state.threads.find((x) => x.id === t.id);
          if (row) row.dealOutcome = dealOutcome;
          render();
        },
      });
    });
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  /**
   * The tab button: how many conversations exist.
   *
   * ⚠️ `counts.total` is the count for the CURRENT state filter's superset, not for the page on
   * screen — `state.threads` is one cursor page and would report "20" on an account with sixty.
   * The server sends the totals precisely so the filter chips can be labelled without paging, and
   * the tab reads the same number the "All" chip does.
   *
   * No amber pill here, deliberately. The natural candidate is `counts.replied` — a stranger has
   * written back and nobody has looked — but this tab has no "mark as seen", so the pill could
   * only ever be cleared by the conversation being closed. A permanent badge is a broken badge.
   */
  function updateTab() {
    window.AssistantDashboardRegistry?.setTabCount(
      'conversations-tab-label', state.tabLabel, state.counts && state.counts.total,
    );
  }

  async function load(opts) {
    const append = !!(opts && opts.append);
    state.loading = true;
    state.error = null;
    if (!append) render();
    try {
      const data = await call('list', {
        state: state.stateFilter ?? undefined,
        cursor: append ? state.nextCursor : undefined,
      });
      state.threads = append ? state.threads.concat(data.threads || []) : (data.threads || []);
      state.counts = data.counts || state.counts;
      state.nextCursor = data.nextCursor || null;
      updateTab();
    } catch (err) {
      // lead_threads / sequence_enrolments are MANUAL applies (db/lead-threads.sql,
      // db/outreach-sequences.sql). Name that rather than showing a generic failure.
      state.error = err.code === 'MIGRATION_PENDING'
        ? 'Conversations are not set up on this environment yet.'
        : (err.message || 'Could not load your conversations.');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function openThread(threadId) {
    if (!Number.isInteger(threadId)) return;
    state.loading = true;
    state.error = null;
    state.openId = threadId;
    state.showDiff = {};
    render();
    try {
      const data = await call('get', { threadId });
      state.open = { thread: data.thread, messages: data.messages || [], enrolment: data.enrolment || null };
    } catch (err) {
      state.error = err.message || 'Could not open that conversation.';
    } finally {
      state.loading = false;
      render();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  window.AssistantLeadThreads = {
    init({ assistantId, cfg }) {
      state.assistantId = assistantId;
      state.rendered = false;
      state.threads = [];
      state.open = null;
      state.openId = null;
      if (cfg && cfg.label) state.tabLabel = cfg.label;
      // ⚠️ This DOES prefetch now, and the comment that used to sit below said the opposite for a
      // good reason: "no tab badge depends on the counts, so a user who never opens the tab should
      // never pay for the query". A count on the button is exactly such a dependency, and it is
      // the point — Conversations was the one tab in the funnel with no number on it, so the tab
      // gave no indication that anything had ever replied.
      //
      // The cost is one list query per assistant-detail page load. `activate()` reuses this
      // result rather than fetching again, so opening the tab is now free where it used to cost
      // the query — the spend moved rather than doubled.
      state.rendered = true;
      load();
    },
    /**
     * Called on first activation of the tab. init() has normally loaded already, so the usual
     * outcome here is a repaint or nothing at all.
     *
     * ⚠️ The empty-host check is load-bearing now that init() prefetches. init() runs during
     * _applyDashboardRegistry, and its render() writes into `lead-threads-host`; if that fetch
     * resolved before the panel existed, the paint went nowhere and `rendered` was already true —
     * which, with a bare `if (state.rendered) return`, left the tab permanently blank. Repainting
     * from state costs nothing and cannot produce that.
     */
    activate() {
      if (!state.rendered) {
        state.rendered = true;
        load();
        return;
      }
      const h = host();
      if (h && !h.innerHTML.trim()) render();
    },
    refresh: load,
  };
})();
