// What work costs comes from Admin → Revenue → Task costs (/task-costs.js); this keeps a page that didn't load it working.
window.taskCost = window.taskCost || ((kind, fallback) => fallback || '1 task');
/**
 * src/components/assistant-mentor-overview.js
 * The Business Mentor's first tab, Suggestions: what it produces, as one list with a pill per stage, the way
 * Posts and Briefs work on the other assistants (redesigned 2026-11-06, docs/business-mentor-plan.md §14). This
 * file keeps its old name; the tab's key is still `mentor`.
 *
 * Suggestions (#mentor-overview-host)
 *   To review              — the open ones, each with its own answer: the same button words and server action as
 *                            its chat card, and "Dismiss…" with the same reasons. "Review all" (mentor-review-all.js,
 *                            the same list as the chat card and Inbox "Needs you"; nothing pre-ticked) does several
 *   Accepted               — accepted suggestions and what changed SINCE (mentor-outcomes.ts)
 *   Dismissed              — what the user dismissed, with the reason; "Bring back"
 * Results tab (#mentor-results-host)
 *   Reviews (Phase 3)      — every weekly review, its suggestions and what was answered; "Review my week now"
 *                            (mentor.ts review_now, owners and admins); its day and on/off are on the profile
 *   Customers (Phase 3b)   — quiet customers, deals, reviews and tickets, only from active assistants
 *                            (mentor-customers.ts, the same summary the Mentor reads)
 * Assistant Settings (#mentor-sees-host)
 *   What I can see         — generated from src/config/mentor-data-inventory.ts, the list its prompt reads
 *
 * The Plan tab shows the Set-up checklist and Recommended next from this module's read: `mentor:overviewLoaded`.
 *
 * Backed by netlify/functions/mentor.ts, the SAME action a card's Dismiss calls (chat-session.js →
 * mentor:decide). A save from a card dispatches `mentor:changed` / `bizinfo:*Changed`, which reload this
 * tab. Handlers are bound to `document` once, at load, never from render. Server values are escaped.
 */
(function () {
  const API = '/.netlify/functions/mentor';
  const state = { assistantId: null, assistantName: 'Your Mentor', data: null, error: null, loading: false, notes: {},
    stage: 'review', busyRow: null, dismissing: null,
    reviews: null, customers: null, reviewBusy: false, reviewNote: null, poll: null };
  const STAGES = ['review', 'accepted', 'dismissed'];
  // The same reasons as a chat card's "Dismiss…" (disruptive-ui-registry.js MENTOR_DISMISS_REASONS).
  const DISMISS_REASONS = [['not_relevant', 'Not relevant'], ['already_done', 'Already done'], ['disagree', 'Disagree'], ['not_now', 'Not now']];
  /** The same words as this suggestion's chat card. */
  function acceptLabel(c) {
    if (c && c.type === 'mentor_products') return (c.products || []).length > 1 ? `Add these ${c.products.length}` : 'Add this';
    if (c && c.type === 'mentor_draft_request') return 'Ask for this post';
    return 'Save this';
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const host = () => document.getElementById('mentor-overview-host');
  const resultsHost = () => document.getElementById('mentor-results-host');
  const seesHost = () => document.getElementById('mentor-sees-host');
  /** A click in any of the three places this module paints. */
  const isOurs = (el) => [host(), resultsHost(), seesHost()].some((h) => h && h.contains(el));
  const ukDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Couldn’t load (HTTP ${res.status}).`);
    return body;
  }

  async function load() {
    if (!host()) return;
    state.loading = true;
    const [main, reviews, customers] = await Promise.allSettled([getJson(API), getJson(`${API}?reviews=1`), getJson(`${API}?customers=1`)]);
    if (main.status === 'fulfilled') {
      state.data = main.value; state.error = null;
      document.dispatchEvent(new CustomEvent('mentor:overviewLoaded', { detail: state.data }));
    }
    else state.error = main.reason?.message || 'Couldn’t load your Mentor’s overview.';
    state.reviews = reviews.status === 'fulfilled' ? reviews.value : { error: reviews.reason?.message || 'Couldn’t load your reviews.' };
    state.customers = customers.status === 'fulfilled' ? customers.value.customers : { error: customers.reason?.message || 'Couldn’t load your customers.' };
    state.loading = false;
    feedNeedsYou();
    render();
    schedulePoll();
  }

  // While a review is being written, look again every 15 s (it takes a minute or two).
  /** The card beside the hero says what is waiting, as every assistant's does. */
  function feedNeedsYou() {
    const open = state.data?.open || [];
    window._setNeedsYouItems?.(open.slice(0, 4).map((s) => ({ id: s.id, label: s.title || 'A suggestion', sub: 'Waiting' })));
    window._setNeedsYouCount?.(open.length);
    const badge = document.getElementById('mentor-review-badge');
    if (badge) {
      badge.textContent = String(open.length);
      badge.classList.toggle('hidden', !open.length);
      badge.style.display = open.length ? 'inline-flex' : 'none';   // `hidden` loses to inline-flex
    }
  }

  function schedulePoll() {
    clearTimeout(state.poll);
    const writing = (state.reviews?.reviews || []).some((r) => r.status === 'queued' || r.status === 'running');
    // The "writing…" note goes once the review is there (its row says how it went).
    if (!writing && state.reviewNote && !state.reviewNote.error && !state.reviewBusy) { state.reviewNote = null; render(); }
    if (writing && host()) state.poll = setTimeout(() => { if (host() && document.contains(host())) load(); }, 15000);
  }

  async function reviewNow() {
    if (state.reviewBusy) return;
    state.reviewBusy = true; state.reviewNote = null; render();
    try {
      await window.MentorApply.reviewNow();
      state.reviewNote = { text: 'Writing your review — it’ll be in your chat with me in a minute or two.' };
      await load();
    } catch (err) {
      state.reviewNote = { text: err.message, error: true };
    }
    state.reviewBusy = false;
    render();
  }

  const DAY_LABEL = { monday: 'Mondays', tuesday: 'Tuesdays', wednesday: 'Wednesdays', thursday: 'Thursdays', friday: 'Fridays', saturday: 'Saturdays', sunday: 'Sundays' };
  const PROPOSAL_STATUS = { shown: ['Waiting', 'bg-amber-50 text-amber-800 border border-amber-200'], accepted: ['Accepted', 'bg-green-50 text-green-800 border border-green-200'], dismissed: ['Dismissed', 'bg-gray-100 text-gray-600'], expired: ['Expired', 'bg-gray-100 text-gray-600'], failed: ['Didn’t apply', 'bg-red-50 text-red-700'] };

  function reviewsHtml() {
    const r = state.reviews;
    if (!r) return '';
    if (r.error) return card(`<h2 class="text-base font-bold text-gray-900">Reviews</h2><p class="text-sm text-red-600 mt-1">${esc(r.error)}</p>`, 'data-mentor-panel="reviews"');
    if (!r.ready) return card(`<h2 class="text-base font-bold text-gray-900">Reviews</h2><p class="text-sm text-gray-600 mt-1">Weekly reviews aren’t switched on for this workspace yet.</p>`, 'data-mentor-panel="reviews"');
    const st = r.settings || {};
    const when = st.quiet ? 'Off while Quiet mode is on.' : st.on === false ? 'Switched off.' : `Every week on ${DAY_LABEL[st.day] || 'Mondays'}, to the workspace’s owners and admins.`;
    const items = (r.reviews || []).map((v) => {
      const writing = v.status === 'queued' || v.status === 'running';
      const label = writing ? 'Being written…' : v.status === 'failed' ? (v.error || 'Didn’t finish. Nothing was charged.') : (v.summary || '');
      const props = (v.proposals || []).map((p) => {
        const [txt, cls] = PROPOSAL_STATUS[p.status] || PROPOSAL_STATUS.shown;
        return `<li class="flex flex-wrap items-start justify-between gap-2 py-1"><span class="text-xs text-gray-800 min-w-0 flex-1 break-words">${esc(p.title)}${p.target ? ` <span class="text-gray-500">· ${esc(p.target)}</span>` : ''}</span><span class="text-[11px] font-semibold rounded-full px-2 py-0.5 shrink-0 ${cls}">${txt}</span></li>`;
      }).join('');
      const sections = (v.sections || []).map((x) => `<h4 class="text-xs font-bold text-gray-700 mt-2">${esc(x.title)}</h4><p class="text-xs text-gray-700 whitespace-pre-line break-words">${esc(x.text)}</p>`).join('');
      return `<li class="py-2 border-b border-gray-100 last:border-0">
        <details>
          <summary class="cursor-pointer">
            <span class="text-sm font-semibold text-gray-900">Week of ${esc(ukDate(v.weekStart))}</span>
            <span class="text-xs text-gray-500"> · ${v.trigger === 'on_demand' ? 'asked for' : 'weekly'}${v.outcome === 'not_enough_data' ? ' · not enough data yet' : ''}${(v.proposals || []).length ? ` · ${(v.proposals || []).length} suggestion${v.proposals.length === 1 ? '' : 's'}` : ''}</span>
            <p class="text-xs mt-0.5 break-words ${v.status === 'failed' ? 'text-red-600' : 'text-gray-600'}">${esc(label)}</p>
          </summary>
          <div class="mt-1 pl-1">${sections}${props ? `<h4 class="text-xs font-bold text-gray-700 mt-2">Suggestions</h4><ul>${props}</ul>` : ''}
            ${v.chatSessionId ? `<button type="button" data-mentor-open-review="${Number(v.chatSessionId)}" class="btn-swan-link mt-2 px-0 py-1 text-xs font-bold">Open in chat</button>` : ''}</div>
        </details>
      </li>`;
    }).join('');
    return card(`
      <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div class="min-w-0 sm:flex-1">
          <h2 class="text-base font-bold text-gray-900">Reviews</h2>
          <p class="text-xs text-gray-500 mt-0.5">${esc(when)} Change the day or switch it off on my profile, under “How should your Mentor work?”.</p>
        </div>
        ${r.canRun ? `<button type="button" data-mentor-review-now class="btn-secondary self-start shrink-0 px-3 py-1.5 border text-xs font-bold rounded-lg transition disabled:opacity-50" ${state.reviewBusy ? 'disabled' : ''}>${state.reviewBusy ? 'Starting…' : `Review my week now · ${window.taskCost('mentor_review')}`}</button>` : ''}
      </div>
      ${state.reviewNote ? `<p class="mt-2 text-xs font-semibold ${state.reviewNote.error ? 'text-red-600' : 'text-pink-700'}" role="status">${esc(state.reviewNote.text)}</p>` : ''}
      ${items ? `<ul class="mt-2">${items}</ul>` : '<p class="text-sm text-gray-500 mt-2">No reviews yet. Your first arrives in your chat with me on your review day.</p>'}`, 'data-mentor-panel="reviews"');
  }

  const VERDICT = { up: 'text-green-700', down: 'text-red-700', same: 'text-gray-700', too_early: 'text-gray-500', too_small: 'text-gray-500', no_measure: 'text-gray-500', drafted: 'text-gray-500' };
  function acceptedPane() {
    const r = state.reviews;
    if (!r) return '<p class="text-sm text-gray-400 animate-pulse">Loading…</p>';
    if (r.error) return `<p class="text-sm text-red-600">${esc(r.error)}</p>`;
    if (!r.trackReady) return '<p class="text-sm text-gray-600">I can’t follow accepted suggestions in this workspace yet.</p>';
    const list = r.trackRecord || [];
    if (!list.length) return '<p class="text-sm text-gray-500">Nothing yet. When you accept a suggestion, I follow what happens next here.</p>';
    const items = list.map((t) => `<li class="py-2 border-b border-gray-100 last:border-0"><p class="text-xs break-words ${VERDICT[t.verdict] || 'text-gray-700'}">${esc(t.line)}</p>${t.target ? `<p class="text-[11px] text-gray-500">${esc(t.target)}</p>` : ''}</li>`).join('');
    // Said once, not on every row (it repeated four times on staging, 27 Oct).
    const early = list.some((t) => t.verdict === 'too_early');
    return `<p class="text-xs text-gray-500">Suggestions you accepted and what changed since. “Since”, not “because” — other things change too.${early ? ' I look at each one again a week after you accept it.' : ''}</p>
      <ul class="mt-1">${items}</ul>`;
  }

  function customersHtml() {
    const c = state.customers;
    if (!c) return '';
    if (c.error) return card(`<h2 class="text-base font-bold text-gray-900">Customers</h2><p class="text-sm text-red-600 mt-1">${esc(c.error)}</p>`, 'data-mentor-panel="customers"');
    const parts = [];
    if (c.deals) {
      const d = c.deals;
      parts.push(`<p class="text-sm text-gray-800">Last 90 days: <strong>${d.won}</strong> won, <strong>${d.lost}</strong> lost, <strong>${d.disqualified || 0}</strong> disqualified.</p>
        <p class="text-xs text-gray-600 mt-0.5">${d.enough ? (d.lossReasons.length ? `Lost mostly to: ${esc(d.lossReasons.map((x) => `${x.reason} (${x.count})`).join(', '))}.` : 'No loss reasons recorded.') : 'Too few closed deals yet to say why deals are lost.'}</p>`);
    }
    if (c.quiet) {
      parts.push(c.quiet.length
        ? `<h3 class="text-xs font-bold uppercase tracking-wide text-gray-500 mt-3">Not heard from lately</h3><ul class="mt-1">${c.quiet.map((q) => `<li class="text-sm text-gray-800 py-1 break-words">${esc(q.company)}${q.contact ? ` <span class="text-gray-500">· ${esc(q.contact)}</span>` : ''}<span class="block text-xs text-gray-500">${q.lastContactAt ? `Last contact ${esc(ukDate(q.lastContactAt))}` : 'No contact recorded'} · won ${esc(ukDate(q.wonAt))}</span></li>`).join('')}</ul><p class="text-xs text-gray-500 mt-1">Ask me in chat for a check-in message you can send them.</p>`
        : '<p class="text-xs text-gray-600 mt-2">No won customer has gone quiet.</p>');
    }
    if (c.reviews) {
      parts.push(`<h3 class="text-xs font-bold uppercase tracking-wide text-gray-500 mt-3">Reviews</h3><p class="text-sm text-gray-800 mt-1">${c.reviews.count} review${c.reviews.count === 1 ? '' : 's'}${c.reviews.average !== null ? `, average ${c.reviews.average}/5` : ''}.</p>
        ${c.reviews.low.map((r) => `<p class="text-xs text-gray-600 mt-1 break-words">${r.rating}/5 — “${esc(r.excerpt)}”</p>`).join('')}`);
    }
    if (c.tickets) parts.push(`<h3 class="text-xs font-bold uppercase tracking-wide text-gray-500 mt-3">Support tickets</h3><p class="text-sm text-gray-800 mt-1">${c.tickets.last30} in 30 days, ${c.tickets.open} open.</p>${c.tickets.subjects.length ? `<p class="text-xs text-gray-600 mt-0.5 break-words">Recent: ${esc(c.tickets.subjects.join('; '))}</p>` : ''}`);
    if (c.overdueInvoices !== null && c.overdueInvoices !== undefined) parts.push(`<h3 class="text-xs font-bold uppercase tracking-wide text-gray-500 mt-3">Overdue invoices</h3><p class="text-sm text-gray-800 mt-1">${c.overdueInvoices}</p>`);
    const off = (c.sources || []).filter((x) => !x.available);
    return card(`
      <h2 class="text-base font-bold text-gray-900">Customers</h2>
      <p class="text-xs text-gray-500 mt-1">Your own customers, from your active assistants only. Names and dates — never contact details.</p>
      ${parts.length ? parts.join('') : '<p class="text-sm text-gray-600 mt-2">I can’t see any customer records yet. Tell me about your customers in chat — who buys, who comes back, who has gone quiet.</p>'}
      ${off.length ? `<details class="mt-3"><summary class="cursor-pointer text-xs font-semibold text-gray-600">What I can’t see (${off.length})</summary><ul class="mt-1">${off.map((x) => `<li class="text-xs text-gray-600 py-0.5">${esc(x.label)}: ${esc(x.note)}</li>`).join('')}</ul></details>` : ''}`, 'data-mentor-panel="customers"');
  }

  function card(inner, attrs = '') {
    return `<section class="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 sm:p-5 min-w-0" ${attrs}>${inner}</section>`;
  }

  function visibilityHtml(v) {
    const list = (xs) => `<ul class="mt-1 space-y-1">${xs.map((x) => `<li class="text-sm text-gray-700 flex gap-2"><span aria-hidden="true" class="text-gray-400">•</span><span class="min-w-0">${esc(x)}</span></li>`).join('')}</ul>`;
    return card(`
      <h3 class="text-lg font-bold text-gray-900">What I can see</h3>
      <p class="text-sm text-gray-500 mt-1">I work from this list, and never change anything without your click.</p>
      <h4 class="text-xs font-bold uppercase tracking-wide text-gray-500 mt-4">Sees</h4>
      ${list(v.sees || [])}
      <h4 class="text-xs font-bold uppercase tracking-wide text-gray-500 mt-4">Never sees</h4>
      ${list(v.never || [])}`, 'data-mentor-panel="visibility"');
  }

  function dismissedPane(rows) {
    const items = rows.map((d) => {
      const back = d.reason === 'not_now' && d.snoozedUntil && new Date(d.snoozedUntil) > new Date() ? ` · back on ${esc(ukDate(d.snoozedUntil))}` : '';
      return `<li class="py-2 border-b border-gray-100 last:border-0">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <p class="text-sm text-gray-900 break-words">${esc(d.title)}</p>
            <p class="text-xs text-gray-500">${esc(d.reasonLabel)}${back}${d.decidedAt ? ` · dismissed ${esc(ukDate(d.decidedAt))}` : ''}</p>
            ${state.notes[d.id] ? `<p class="text-xs font-semibold mt-1 ${state.notes[d.id].error ? 'text-red-600' : 'text-pink-700'}">${esc(state.notes[d.id].text)}</p>` : ''}
          </div>
          <button type="button" data-mentor-bring-back="${Number(d.id)}" class="btn-secondary shrink-0 px-3 py-1.5 border text-xs font-bold rounded-lg transition">Bring back</button>
        </div>
      </li>`;
    }).join('');
    return rows.length
      ? `<p class="text-xs text-gray-500">I won’t suggest these again. "Bring back" lets me.</p><ul class="mt-1">${items}</ul>`
      : '<p class="text-sm text-gray-500">Nothing dismissed. When you dismiss a suggestion in chat, it’s listed here with your reason.</p>';
  }

  function rowHtml(it) {
    const busy = state.busyRow === it.id;
    const note = state.notes[it.id];
    const preview = window.MentorReviewAll?.previewHtml?.(it.card) || '';
    return `<li class="py-3 border-b border-gray-100 last:border-0" data-mentor-suggestion="${Number(it.id)}">
      <p class="text-sm font-semibold text-gray-900 break-words">${esc(it.title || 'A suggestion')}</p>
      ${preview ? `<div class="mt-1">${preview}</div>` : ''}
      ${it.why ? `<p class="mt-1 text-xs text-blue-800 break-words"><span class="font-bold">Why?</span> ${esc(it.why)}</p>` : ''}
      <div class="flex flex-wrap items-center gap-2 mt-2">
        <button type="button" data-mentor-accept class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>${esc(acceptLabel(it.card))}</button>
        <button type="button" data-mentor-dismiss aria-expanded="${state.dismissing === it.id}" class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Dismiss…</button>
      </div>
      ${state.dismissing === it.id ? `<div class="flex flex-wrap items-center gap-2 mt-2">
        <span class="text-xs text-gray-500">Why?</span>
        ${DISMISS_REASONS.map(([k, label]) => `<button type="button" data-mentor-dismiss-reason="${k}" class="btn-secondary px-2.5 py-1 border text-xs font-semibold rounded-full transition disabled:opacity-50" ${busy ? 'disabled' : ''}>${label}</button>`).join('')}
      </div>` : ''}
      ${note ? `<p class="mt-2 text-xs font-semibold ${note.error ? 'text-red-600' : 'text-pink-700'}" role="status">${esc(note.text)}</p>` : ''}
    </li>`;
  }

  function reviewPane(open, week) {
    const used = week && week.used != null ? week.used : null;
    const list = open.length
      ? `<p class="text-xs text-gray-500">My suggestions you haven’t answered yet. Nothing changes until you say so.</p>
        <ul class="mt-1">${open.map(rowHtml).join('')}</ul>`
      : '<p class="text-sm text-gray-500">Nothing to review. New suggestions appear here and in chat.</p>';
    return `${list}
      <div class="mt-3 pt-3 border-t border-gray-100">
        <p class="text-xs font-semibold text-gray-700">Suggestions this week: ${used == null ? 'not available just now' : `${Math.min(used, week.cap)} of ${week.cap} used since Monday`}</p>
        <p class="text-xs text-gray-500 mt-0.5">I make at most ${week ? week.cap : 3} suggestions a week, picking the ones with the most evidence. Anything you ask for in chat doesn’t count, and nor does answering one from an earlier week.</p>
      </div>`;
  }

  /** The tab's one list, its stages as pills like the Review and Briefs tabs. Never folded: it's what the tab is for. */
  function suggestionsHtml(d) {
    const open = d.open || [];
    const dismissed = d.dismissed || [];
    const accepted = state.reviews?.trackRecord || [];
    const pills = [['review', 'To review', open.length], ['accepted', 'Accepted', accepted.length], ['dismissed', 'Dismissed', dismissed.length]].map(([key, label, n]) => {
      const on = state.stage === key;
      const count = !n ? '' : key === 'review' ? ` <span class="ml-1 bg-amber-100 text-amber-700 text-xs px-1.5 py-0.5 rounded-full">${n}</span>` : ` <span class="text-xs font-semibold text-gray-500">${n}</span>`;
      return `<button type="button" role="tab" id="mentor-stage-${key}" aria-controls="mentor-stage-panel" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-mentor-stage="${key}" class="text-sm whitespace-nowrap">${label}${count}</button>`;
    }).join('');
    const pane = state.stage === 'accepted' ? acceptedPane() : state.stage === 'dismissed' ? dismissedPane(dismissed) : reviewPane(open, d.week);
    return card(`
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div class="stage-pills tab-scroller" style="margin:0;max-width:100%" role="tablist" aria-label="Suggestions by stage">${pills}</div>
        ${state.stage === 'review' && open.length > 1 ? '<button type="button" data-mentor-review-all class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Review all</button>' : ''}
      </div>
      <div id="mentor-stage-panel" role="tabpanel" aria-labelledby="mentor-stage-${esc(state.stage)}" tabindex="0">${pane}</div>`, 'data-mentor-panel="suggestions" data-no-fold');
  }

  function render() {
    const results = resultsHost();
    if (results) results.innerHTML = state.data || state.reviews ? `<div class="space-y-4 min-w-0">${reviewsHtml()}${customersHtml()}</div>` : '';
    const sees = seesHost();
    if (sees) sees.innerHTML = state.data ? visibilityHtml(state.data.visibility || { sees: [], never: [] }) : card('<p class="text-sm text-gray-400 animate-pulse">Loading…</p>');
    const el = host();
    if (!el) return;
    if (state.error && !state.data) {
      el.innerHTML = card(`<p class="text-sm text-red-600">${esc(state.error)}</p>
        <button type="button" data-mentor-retry class="btn-secondary mt-3 px-3 py-1.5 border text-xs font-bold rounded-lg">Try again</button>`);
      return;
    }
    if (!state.data) { el.innerHTML = card('<p class="text-sm text-gray-400 animate-pulse">Loading…</p>'); return; }
    const d = state.data;
    el.innerHTML = `
      ${suggestionsHtml(d)}
      <p class="text-xs text-gray-600 px-1 mt-4">Need help with Be More Swan? Ask me in chat, or use <button type="button" data-mentor-help class="font-semibold text-pink-700 hover:underline">Help &amp; Support</button>.</p>`;
  }

  /** The same two steps as "Review all": the change, then recording it, whose failure isn't the user's problem. */
  async function accept(id) {
    const it = (state.data?.open || []).find((x) => x.id === id);
    if (!it || state.busyRow || !window.MentorApply) return;
    state.busyRow = id; state.notes[id] = { text: 'Saving…' }; render();
    try {
      await window.MentorApply.applyCard({ ...it.card, proposalId: it.id });
      await window.MentorApply.decide(it.id, 'accepted').catch(() => {});
      delete state.notes[id];
      state.busyRow = null;
      await load();
    } catch (err) {
      state.busyRow = null;
      state.notes[id] = { text: `Not saved: ${err.message || 'that couldn’t be saved.'}`, error: true };
      render();
    }
  }

  async function dismiss(id, reason) {
    if (state.busyRow || !window.MentorApply) return;
    state.busyRow = id; state.notes[id] = { text: 'Saving…' }; render();
    try {
      await window.MentorApply.decide(id, 'dismissed', reason);
      delete state.notes[id];
      state.busyRow = null; state.dismissing = null;
      await load();
    } catch (err) {
      state.busyRow = null;
      state.notes[id] = { text: err.message || 'That couldn’t be saved.', error: true };
      render();
    }
  }

  async function bringBack(id) {
    state.notes[id] = { text: 'Bringing back…' };
    render();
    try {
      const res = await fetch(API, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bring_back', proposalId: id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'That didn’t work — please try again.');
      delete state.notes[id];
      await load();
    } catch (err) {
      state.notes[id] = { text: err.message, error: true };
      render();
    }
  }

  // ── Handlers: bound once, to document ──────────────────────────────────────
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !isOurs(t)) return;
    const stage = t.closest('[data-mentor-stage]');
    if (stage) {
      state.stage = stage.getAttribute('data-mentor-stage');
      render();
      document.getElementById(`mentor-stage-${state.stage}`)?.focus();   // the repaint replaced the pill
      return;
    }
    const row = t.closest('[data-mentor-suggestion]');
    if (row) {
      const id = Number(row.getAttribute('data-mentor-suggestion'));
      if (t.closest('[data-mentor-accept]')) { accept(id); return; }
      if (t.closest('[data-mentor-dismiss]')) { state.dismissing = state.dismissing === id ? null : id; render(); return; }
      const reason = t.closest('[data-mentor-dismiss-reason]');
      if (reason) { dismiss(id, reason.getAttribute('data-mentor-dismiss-reason')); return; }
    }
    const back = t.closest('[data-mentor-bring-back]');
    if (back) { bringBack(Number(back.getAttribute('data-mentor-bring-back'))); return; }
    if (t.closest('[data-mentor-retry]')) { load(); return; }
    if (t.closest('[data-mentor-review-all]')) { window.MentorReviewAll?.openDialog(); return; }
    if (t.closest('[data-mentor-review-now]')) { reviewNow(); return; }
    const openReview = t.closest('[data-mentor-open-review]');
    if (openReview) { window.openAssistantChat?.({ assistantId: state.assistantId, sessionId: Number(openReview.getAttribute('data-mentor-open-review')) }); return; }
    if (t.closest('[data-mentor-help]') && window.loadView) window.loadView('help');
  });
  // The pills, by keyboard, as every other row of tabs on this page.
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !t.matches('[data-mentor-stage]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const at = STAGES.indexOf(state.stage);
    state.stage = e.key === 'Home' ? STAGES[0] : e.key === 'End' ? STAGES[STAGES.length - 1] : STAGES[(at + (e.key === 'ArrowRight' ? 1 : -1) + STAGES.length) % STAGES.length];
    render();
    document.getElementById(`mentor-stage-${state.stage}`)?.focus();
  });
  // A card applied or dismissed in chat, or Business Information saved: repaint from the server.
  ['mentor:changed', 'bizinfo:profileChanged', 'bizinfo:productsChanged', 'assistant:settingsChanged'].forEach((ev) =>
    document.addEventListener(ev, () => { if (state.assistantId && host()) load(); }));

  // The chat panel beside the list, as on the landing tab of the other assistants (owner, 2026-11-06). The
  // same thread as the Plan tab's: it is one conversation with the Mentor.
  let chatDock = null;
  function getChatDock() {
    const el = host();
    if (!el || !window.ChatPane?.available?.() || !state.assistantId) return null;
    if (chatDock && chatDock.connected()) return chatDock;
    chatDock = window.ChatPane.dock(el, {
      prefix: 'mentoroverview', storageKey: 'bms-mentorplan-chat-on',
      pane: () => ({
        assistantId: state.assistantId, assistantName: state.assistantName, roleKey: 'business_mentor',
        rememberKey: `bms-mentorplan-chat:${state.assistantId}`,
        placeholder: 'Ask your Mentor…',
        starterPrompts: ['What should I focus on this week?', 'Where is my business weakest right now?', 'Which assistant would help me most next?'],
        composerRows: 3,
      }),
    });
    return chatDock;
  }

  window.AssistantMentorOverview = {
    init({ assistantId, assistantName }) {
      chatDock?.destroy();
      chatDock = null;
      state.assistantId = assistantId;
      state.assistantName = assistantName || 'Your Mentor';
      state.data = null; state.error = null; state.notes = {}; state.stage = 'review'; state.busyRow = null; state.dismissing = null;
      state.reviews = null; state.customers = null; state.reviewNote = null; clearTimeout(state.poll);
      render();
      load();
    },
    /** The last read, for the Plan tab's Set-up checklist and Recommended next. */
    data() { return state.data; },
    /** The assistant was renamed: this tab says the new name (assistants.js _assistantRenamed). */
    rename(name) { state.assistantName = name || state.assistantName; render(); },
    activate() {
      if (!state.data && !state.loading) load(); else render();
      const dock = getChatDock();
      if (dock && !dock.isOn() && dock.wanted()) dock.setOn(true, false);
    },
  };
})();
