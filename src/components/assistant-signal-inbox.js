/**
 * src/components/assistant-signal-inbox.js
 * Signal Inbox tab — Phase 1a of docs/lead-generator-revenue-engine-plan.md.
 *
 * Everything that came IN before it became a lead. Two independent feeds behind one surface:
 *   • saved searches — projected from discovered_leads, categorised "<Assistant> Search".
 *     Works with ONLY a Lead Generator hired.
 *   • social         — Phase 1b, additive. When absent the inbox is still fully populated and
 *                      offers social capture as a one-line footer, never an empty state.
 *
 * Backed by netlify/functions/signal-inbox.ts:
 *   • list    → POST signal-inbox { action:'list', assistantId, savedSearchId?, showFiltered?, cursor? }
 *   • approve → POST signal-inbox { action:'approve', assistantId, ids:[...] }   ← the CLASS A batch gate
 * and, for the one write that belongs to this screen, netlify/functions/discovery-campaigns.ts:
 *   • start   → POST discovery-campaigns { action:'run_now', campaignId }
 *
 * ── Saying what is happening ─────────────────────────────────────────────────
 * The list is only half the tab. Above it, every saved search states what it is DOING — not
 * started, queued, searching, ran N minutes ago, paused — and offers the one action that unblocks
 * it. Without that, a search proposed in chat (saved as a DRAFT: nothing searched, nothing spent)
 * looked exactly like a live search that had found nothing, under an empty state that told the
 * user to go and create the search they had just created.
 *
 * Two things keep this surface honest about writes made elsewhere:
 *   • `discovery:created` on `document` — the chat modal creating a search from outside this tab.
 *   • a poll while a run is in flight — the only change that happens with no user action here.
 *
 * ── The batch gate ───────────────────────────────────────────────────────────
 * Signals in `needs_review` get NO checkbox and are never selectable. That is deliberate and it is
 * the point of the whole screen: a scraped address belonging to a named individual must not be
 * swept into a bulk approve. The server re-checks this independently — this UI is a convenience,
 * never the enforcement.
 *
 * Styling reuses classes already compiled into style.css (no rebuild — see the Tailwind drift note
 * in the project conventions). All server values are escaped on render; treat them as untrusted.
 */
(function () {
  const API = '/.netlify/functions/signal-inbox';
  const DISCOVERY_API = '/.netlify/functions/discovery-campaigns';
  /** How often to re-read while a run is in flight. Long enough not to hammer, short enough that
   *  "Searching now" visibly becomes "found 12 companies" without the user reloading the page. */
  const POLL_MS = 15000;

  let state = {
    assistantId: null,
    signals: [],
    counts: { total: 0, ready: 0, needsReview: 0, promoted: 0, filtered: 0 },
    savedSearches: [],
    savedSearchId: null,
    showFiltered: false,
    hasSocialFeed: false,
    sourceLabel: 'Saved search',
    selected: new Set(),
    nextCursor: null,
    loading: false,
    error: null,
    rendered: false,
    pollTimer: null,
    pagedIn: false,
    tabLabel: 'Searches',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const host = () => document.getElementById('signal-inbox-host');

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

  /**
   * Starting a search is a WRITE to discovery-campaigns, not to this inbox's own API — that
   * function owns the IDOR guard, the draft→active promotion and the in-flight dedupe. Calling it
   * directly (rather than routing a second start path through signal-inbox.ts) is the same choice
   * chat-session.js made for create, and for the same reason: two paths to one table drift.
   */
  async function callDiscovery(action, extra) {
    const res = await fetch(DISCOVERY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action, assistantId: state.assistantId, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  const CHIP = {
    ready: 'bg-amber-50 text-amber-700 border-amber-200',
    needs_review: 'bg-amber-50 text-amber-800 border-amber-300',
    promoted: 'bg-green-50 text-green-700 border-green-100',
    filtered: 'bg-gray-100 text-gray-500 border-gray-200',
    auto_promoted: 'bg-green-50 text-green-700 border-green-100',
    ignored: 'bg-gray-100 text-gray-500 border-gray-200',
  };
  const STATE_LABEL = {
    ready: 'Ready to approve',
    needs_review: 'Individual review',
    promoted: 'Approved',
    filtered: 'Filtered',
    auto_promoted: 'Auto-promoted',
    ignored: 'Ignored',
  };
  const ratingChip = (r) => r === 'hot' ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
    : r === 'warm' ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-gray-100 text-gray-500 border-gray-200';

  function row(s) {
    const selectable = s.handoffStatus === 'ready';
    const checked = state.selected.has(s.id) ? 'checked' : '';
    const dim = s.handoffStatus === 'filtered' ? 'opacity-70' : '';
    const warn = s.handoffStatus === 'needs_review';
    return `
      <div class="flex items-start gap-3 p-4 border-b border-gray-100 ${dim} ${warn ? 'bg-amber-50' : ''}">
        <div class="pt-0.5 w-5 shrink-0">
          ${selectable
            ? `<input type="checkbox" data-si-sel="${esc(s.id)}" ${checked} class="cursor-pointer">`
            : warn ? '<span title="Excluded from batch approve">&#9888;&#65039;</span>' : ''}
        </div>
        <div class="min-w-0 flex-1">
          <p class="font-semibold text-gray-900 text-sm">${esc(s.title)}</p>
          ${s.excerpt ? `<p class="text-xs text-gray-500 mt-0.5">${esc(s.excerpt)}</p>` : ''}
          ${s.reviewReason ? `<p class="text-xs text-amber-800 mt-1">${esc(s.reviewReason)}</p>` : ''}
          ${s.filterReason ? `<p class="text-xs text-gray-400 mt-1">${esc(s.filterReason)}</p>` : ''}
        </div>
        <div class="shrink-0 text-right">
          <span class="text-xs font-bold px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-800 border-emerald-200">${esc(s.sourceLabel)}</span>
          <p class="text-xs text-gray-400 mt-1">${esc(s.savedSearchName || '')}</p>
        </div>
        <div class="shrink-0 w-20 text-right">
          ${s.rating ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${ratingChip(s.rating)}">${esc(s.rating)}${s.confidence != null ? ' &middot; ' + esc(s.confidence) : ''}</span>` : ''}
        </div>
        <div class="shrink-0 w-32 text-right">
          <span class="text-xs font-bold px-2 py-0.5 rounded-full border ${CHIP[s.handoffStatus] || CHIP.filtered}">${esc(STATE_LABEL[s.handoffStatus] || s.handoffStatus)}</span>
        </div>
      </div>`;
  }

  // ── What each saved search is actually doing ───────────────────────────────
  // The tab's job is not only "which signals came in" but "is anything happening, and what am I
  // supposed to do next". Without this a chat-proposed search — saved as a DRAFT that has spent
  // nothing and searched nothing — rendered as four zeros and an empty list, identical to a live
  // search that had simply found nothing. Every state below therefore says what it means in plain
  // words and, where the user is the thing standing in the way, hands them the button.

  /**
   * "today at 08:00" / "tomorrow at 08:00" / "Fri 15 Aug at 08:00".
   *
   * Deliberately unlike `ago()` below, which stays relative: a PAST run is a rough fact ("ran 20
   * minutes ago" is all anyone needs), but a FUTURE run is something the user plans around, and
   * "in 14 hours" makes them do the arithmetic. Rendered in the viewer's own timezone — the
   * schedule is stored in UTC and saying "08:00 UTC" to someone in another timezone was a small
   * lie about when their leads would appear.
   */
  function when(t) {
    const d = new Date(t);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const day = d.toDateString();
    const today = new Date();
    if (day === today.toDateString()) return `today at ${time}`;
    const tomorrow = new Date(today.getTime() + 86400000);
    if (day === tomorrow.toDateString()) return `tomorrow at ${time}`;
    return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}`;
  }

  /**
   * What happens next, on its own — the row used to print a fixed string per cadence ("it repeats
   * daily at 08:00 UTC") which never named an actual date, so a user with a weekly search could
   * not tell whether that meant tomorrow or in six days.
   *
   * Three genuinely different states, and conflating them is what made the old copy wrong:
   *   • one_off        — there IS no next run. It is the default cadence, so this is most searches.
   *   • not enabled    — a draft: it repeats only once a human starts it, so no date exists yet.
   *   • enabled        — a real timestamp, or "due" when the dispatcher has yet to pick it up.
   * `nextRunAt` is seeded to now() at creation and the hourly dispatcher moves it forward, so a
   * due-but-unfired schedule is normal and means "within the hour", not "overdue".
   */
  function cadenceLine(s) {
    const cadence = s.cadence || 'one_off';
    if (cadence === 'one_off') return 'It runs once each time you start it — nothing is scheduled after that.';
    const repeats = cadence === 'daily' ? 'daily' : 'weekly';
    if (!s.scheduleEnabled) return `Once started, it repeats ${repeats}.`;
    const t = Date.parse(s.nextRunAt || '');
    if (!t) return `It repeats ${repeats}.`;
    if (t <= Date.now()) return `Repeats ${repeats} — the next run is due and starts within the hour.`;
    return `Repeats ${repeats}. Next run ${when(t)}.`;
  }

  /** "just now" / "14 minutes ago" / "3 days ago". Absolute dates read as noise at this size. */
  function ago(iso) {
    const t = Date.parse(iso || '');
    if (Number.isNaN(t)) return '';
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
    const days = Math.round(hrs / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  /**
   * How long a run may sit without advancing before the row stops claiming it is working.
   *
   * The on-demand drain loops for at most twelve minutes; past that a run falls back to the
   * ten-minute cron, so gaps of a few minutes are ordinary and a gap of fifteen is not.
   */
  const STALL_MS = 15 * 60 * 1000;

  /**
   * What an in-flight run is doing right now, per stage.
   *
   * The lead count belongs in every one of these: the complaint that produced this code was a
   * search showing a "Queued" chip while fifteen leads sat in the Leads tab, and a row that names
   * the leads it has already filed cannot read as "nothing is happening".
   */
  function runningLine(s, stage, total) {
    const i = Number(s.queryIndex || 0);
    const n = Number(s.queryTotal || 0);
    // Only claim a position once query_gen has produced the plan; before that there is no
    // denominator and "query 0 of 0" is worse than saying nothing.
    const progress = n > 0 ? ` Query ${Math.min(i + 1, n)} of ${n}.` : '';
    if (stage === 'promoting') return `Filing what it found into your Leads tab. ${total}`;
    if (stage === 'enriching') return `Looking up contact details for the best matches — the companies themselves are already in your Leads tab. ${total}`;
    return `Searching the web and scoring what it finds.${progress} ${total}`;
  }

  /**
   * Collapse (campaign status × latest job status × stage) into one thing to show the user.
   *
   * Order matters: an in-flight job outranks the campaign status, because "searching now" is the
   * more useful truth while a draft is mid-promotion. `action:'start'` is the only state where the
   * search cannot progress without a click — that is what earns the emphasised button.
   */
  function searchState(s) {
    const job = s.latestJobStatus;
    const stage = s.latestJobStage || null;
    const found = Number(s.leadsFound || 0);
    const cadence = cadenceLine(s);
    const total = found
      ? `${found} compan${found === 1 ? 'y' : 'ies'} found so far.`
      : 'No companies found yet.';

    // 'queued' is where a RUNNING search rests, not only where a new one waits. The worker takes
    // one search query per slice (~10s), writes the row back to 'queued' and returns, so a live run
    // reads 'queued' for almost its whole life — through searching, promoting and enriching alike.
    // Labelling that "Queued" told a user whose search had already filed fifteen leads that nothing
    // had started. `stage` is the discriminator: it is NULL until the first slice claims the job.
    const started = job === 'processing' || (job === 'queued' && !!stage);
    if (started) {
      // …but a run only rests between slices while something is driving it. The on-demand drain
      // gives up after twelve minutes and hands back to the ten-minute cron, so a row that has not
      // moved in a quarter of an hour must not keep animating "Searching now" — that would trade
      // the old lie for a more convincing one. It is still genuinely queued work, not a failure,
      // and it needs no click, so this states the fact and offers no alarm.
      const moved = Date.parse(s.latestJobUpdatedAt || '');
      if (moved && Date.now() - moved > STALL_MS) {
        return { chip: 'bg-amber-50 text-amber-800 border-amber-200', label: 'Paused between steps', running: true,
          line: `Part-way through and waiting on the next pass of the worker, which picks it up on its own. ${total}` };
      }
      return { chip: 'bg-blue-50 text-blue-800 border-blue-200', label: 'Searching now', running: true,
        line: runningLine(s, stage, total) };
    }
    if (job === 'queued') {
      // Nothing has claimed a slice yet. "starts within a few minutes" was wrong in both
      // environments before the on-demand poke: the worker ran on a ten-minute cron, and branch
      // deploys never fire native crons at all, so a staging search sat here indefinitely. Starting
      // a search now pokes the queue directly (discovery-campaigns.ts run_now →
      // run-discovery-jobs-background), so it really does begin straight away — but the poke is
      // best-effort by design, so this promises no clock time.
      return { chip: 'bg-amber-50 text-amber-800 border-amber-200', label: 'Queued', running: true,
        line: 'Starting now — companies appear below as they are found and scored.' };
    }
    if (s.status === 'paused') {
      return { chip: 'bg-gray-100 text-gray-500 border-gray-200', label: 'Paused',
        line: `Paused, so it will not run. ${total} Resume it under Find New Leads.` };
    }
    if (s.status === 'draft') {
      return { chip: 'bg-amber-50 text-amber-800 border-amber-200', label: 'Not started', action: 'start',
        line: `Saved but never run — nothing has been searched and nothing spent. ${cadence}` };
    }
    if (job === 'failed') {
      return { chip: 'bg-red-50 text-red-700 border-red-200', label: 'Last run failed', action: 'run',
        line: `The last run stopped before it finished ${ago(s.lastFinishedAt)}. Starting it again is safe.` };
    }
    if (job === 'completed') {
      return { chip: 'bg-emerald-50 text-emerald-800 border-emerald-200', label: `Ran ${ago(s.lastFinishedAt)}`, action: 'run',
        line: `${total} ${cadence}` };
    }
    return { chip: 'bg-gray-100 text-gray-500 border-gray-200', label: 'No runs yet', action: 'run',
      line: `Active but it has not run yet. ${cadence}` };
  }

  // `last` rather than a `last:border-b-0` utility — that class is not in the compiled style.css,
  // and rebuilding Tailwind for one divider churns unrelated classes across the whole sheet.
  function searchRow(s, last) {
    const st = searchState(s);
    const btn = st.action === 'start'
      ? `<button type="button" data-si-start="${s.id}" class="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Start search</button>`
      : st.action === 'run'
        ? `<button type="button" data-si-start="${s.id}" class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Run again</button>`
        : '';
    return `
      <div class="p-4 ${last ? '' : 'border-b border-gray-100'}">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="font-semibold text-gray-900 text-sm">${esc(s.label)}</p>
              <span class="text-xs font-bold px-2 py-0.5 rounded-full border ${st.chip}">${esc(st.label)}</span>
            </div>
            <p class="text-xs text-gray-500 mt-1">${esc(st.line)}</p>
          </div>
          <div class="shrink-0">${btn}</div>
        </div>
      </div>`;
  }

  function searchesPanel() {
    if (!state.savedSearches.length) return '';
    return `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm mb-4">
        <div class="p-4 border-b border-gray-100">
          <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">Your searches</p>
          <p class="text-xs text-gray-500 mt-1">Each search looks across the public web, scores what it finds against your profile, and files the companies below. You approve the ones worth pursuing &mdash; approved companies become leads and move to your Leads tab.</p>
        </div>
        ${state.savedSearches.map((s, i) => searchRow(s, i === state.savedSearches.length - 1)).join('')}
      </div>`;
  }

  /**
   * The empty list, explained by why it is empty. The old copy said "create a saved search" no
   * matter what — advice that was actively wrong for the user who had just created one in chat and
   * was being told to go and do it again.
   */
  function emptyState() {
    if (!state.savedSearches.length) {
      return `<div class="p-8 text-center">
        <p class="text-sm font-semibold text-gray-900">No signals yet</p>
        <p class="text-xs text-gray-500 mt-1">Create a saved search and your assistant will start filling this inbox.</p>
        <button type="button" data-si-new-search
          class="mt-3 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition">Find New Leads</button>
      </div>`;
    }
    if (state.savedSearches.some((s) => s.latestJobStatus === 'queued' || s.latestJobStatus === 'processing')) {
      return `<div class="p-8 text-center">
        <p class="text-sm font-semibold text-gray-900">Searching now</p>
        <p class="text-xs text-gray-500 mt-1">A search works through one query at a time, so companies arrive here in batches rather than all at once. This page updates itself &mdash; you do not need to wait on it.</p>
      </div>`;
    }
    // "Found nothing" and "never got as far as looking" are different facts about an empty list,
    // and only one of them is the user's cue to widen the search. A run that FAILED has produced
    // no evidence about their profile at all — telling them to broaden it would be a guess
    // dressed as a finding.
    if (!state.savedSearches.some((s) => s.latestJobStatus === 'completed')) {
      if (state.savedSearches.some((s) => s.latestJobStatus === 'failed')) {
        return `<div class="p-8 text-center">
          <p class="text-sm font-semibold text-gray-900">The last run did not finish</p>
          <p class="text-xs text-gray-500 mt-1">Nothing has come in because the search stopped early, not because it found nothing. Starting it again is safe.</p>
        </div>`;
      }
      return `<div class="p-8 text-center">
        <p class="text-sm font-semibold text-gray-900">Nothing has been searched yet</p>
        <p class="text-xs text-gray-500 mt-1">Your search is saved but has not run. Start it above and the companies it finds land here for your approval.</p>
      </div>`;
    }
    return `<div class="p-8 text-center">
      <p class="text-sm font-semibold text-gray-900">Nothing new came in</p>
      <p class="text-xs text-gray-500 mt-1">The last run found no companies that cleared your profile. Run it again, or widen the description under Find New Leads.</p>
    </div>`;
  }

  function view() {
    if (state.loading && !state.signals.length) {
      return `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center text-sm text-gray-500">Loading your signals…</div>`;
    }
    if (state.error) {
      return `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <p class="text-sm font-semibold text-gray-900">${esc(state.error)}</p>
        <button type="button" data-si-retry class="mt-3 px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-gray-300 text-xs font-bold rounded-lg transition">Try again</button>
      </div>`;
    }

    const c = state.counts;
    const selCount = state.selected.size;

    // Source chips filter the list BELOW; the searches panel above states what each one is doing.
    // With a single search the chip row is pure noise — "All" and one chip that select the same
    // rows — so it only appears once there is a genuine choice to make.
    const searchChips = state.savedSearches.length > 1 ? `
      <button type="button" data-si-search="" class="px-2.5 py-1 text-xs font-bold rounded-lg border transition ${state.savedSearchId === null ? 'bg-emerald-700 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}">All</button>
      ${state.savedSearches.map((s) => `
      <button type="button" data-si-search="${s.id}"
        class="px-2.5 py-1 text-xs font-bold rounded-lg border transition ${state.savedSearchId === s.id ? 'bg-emerald-700 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}">${esc(s.label)}</button>`).join('')}` : '';

    const empty = state.signals.length === 0;

    // No summary-card row. Four big numbers across the top ("Signals / Ready to approve / Need
    // review / Filtered") restated what the list below already shows, row by row and with the
    // company names attached — and pushed the searches panel, which is the thing the user has to
    // act on, below the fold. The two counts worth keeping are still on screen where the decision
    // is made: "Show filtered (N)" on its own toggle, and "N need individual review" on the batch
    // bar. The number of SEARCHES now rides on the tab button itself (updateTab).
    return `
      ${searchesPanel()}

      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm">
        <div class="p-4 border-b border-gray-100 flex flex-wrap items-center gap-2">
          ${searchChips}
          <label class="ml-auto flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input type="checkbox" data-si-filtered ${state.showFiltered ? 'checked' : ''} class="cursor-pointer">
            Show filtered (${c.filtered})
          </label>
          <button type="button" data-si-lead-ideas
            class="px-2.5 py-1 text-xs font-bold rounded-lg border bg-white text-gray-600 border-gray-200 hover:border-gray-300 transition">Review Lead Ideas</button>
          <button type="button" data-si-new-search
            class="px-2.5 py-1 text-xs font-bold rounded-lg border bg-white text-emerald-700 border-emerald-200 hover:border-emerald-300 hover:bg-emerald-50 transition">Find New Leads</button>
        </div>

        ${c.ready > 0 ? `
        <div class="p-4 border-b border-gray-100 bg-emerald-50 flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-2 text-xs font-bold text-gray-700 cursor-pointer">
            <input type="checkbox" data-si-all class="cursor-pointer"> ${selCount ? selCount + ' selected' : 'Select all ready'}
          </label>
          ${c.needsReview > 0 ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full border bg-gray-100 text-gray-500 border-gray-200">${c.needsReview} need individual review</span>` : ''}
          <button type="button" data-si-approve ${selCount ? '' : 'disabled'}
            class="ml-auto px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
            ${selCount ? 'Approve ' + selCount : 'Approve'}
          </button>
        </div>` : ''}

        ${empty ? emptyState() : state.signals.map(row).join('')}

        ${!state.hasSocialFeed ? `
        <div class="p-4 border-t border-gray-100 bg-gray-50 flex flex-wrap items-center gap-3">
          <p class="text-xs text-gray-500">Also capture comments, DMs and mentions as signals &mdash; needs a Social Media Assistant.</p>
        </div>` : ''}
      </div>

      ${state.nextCursor ? `
      <div class="text-center mt-4">
        <button type="button" data-si-more class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-gray-300 text-xs font-bold rounded-lg transition">Load more</button>
      </div>` : ''}`;
  }

  function render() {
    const h = host();
    if (!h) return;
    h.innerHTML = view();
    bind(h);
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  function bind(h) {
    h.querySelector('[data-si-retry]')?.addEventListener('click', () => load());
    // 'change', not 'click' — fires for keyboard toggling too, and matches the other checkboxes.
    h.querySelector('[data-si-filtered]')?.addEventListener('change', (e) => {
      state.showFiltered = !!e.target.checked;
      load();
    });
    h.querySelectorAll('[data-si-search]').forEach((b) => b.addEventListener('click', () => {
      const v = b.getAttribute('data-si-search');
      state.savedSearchId = v ? Number(v) : null;
      load();
    }));
    h.querySelectorAll('[data-si-sel]').forEach((box) => box.addEventListener('change', () => {
      const id = box.getAttribute('data-si-sel');
      if (box.checked) state.selected.add(id); else state.selected.delete(id);
      render();
    }));
    h.querySelector('[data-si-all]')?.addEventListener('change', (e) => {
      // Selects only what the SERVER marked ready — never the needs_review rows.
      state.selected = e.target.checked
        ? new Set(state.signals.filter((s) => s.handoffStatus === 'ready').map((s) => s.id))
        : new Set();
      render();
    });
    h.querySelectorAll('[data-si-start]').forEach((b) => b.addEventListener('click', () => startSearch(b)));
    h.querySelector('[data-si-approve]')?.addEventListener('click', (e) => approve(e.currentTarget));
    h.querySelector('[data-si-more]')?.addEventListener('click', () => load({ append: true }));
    // Two of these can be on screen at once (toolbar + empty state), so bind them as a set.
    h.querySelectorAll('[data-si-new-search]').forEach((b) => b.addEventListener('click', openNewSearch));
    h.querySelector('[data-si-lead-ideas]')?.addEventListener('click', openLeadIdeas);
  }

  /**
   * "New search" → the outbound discovery modal (assistant-discovery-campaigns.js), which is the
   * only surface that creates a saved search. Until this button existed the inbox told users to
   * "create a saved search" with no way to do it — the modal's only entry point was the Find New
   * Leads button over in the Leads tab.
   *
   * That component normally takes its assistantId from the Overview action bar's wiring, and its
   * open() silently no-ops without one. Re-init from the registry here so the modal opens no
   * matter which tab the user landed on first; init() is idempotent (its click listener is
   * guarded by a dataset flag).
   */
  function openNewSearch() {
    const dc = window.AssistantDiscoveryCampaigns;
    if (!dc || !state.assistantId) return;
    dc.init({
      assistantId: state.assistantId,
      cfg: window.AssistantDashboardRegistry?.get('lead_qualifier')?.discoveryCampaigns,
    });
    dc.open();
  }

  /**
   * "Review Lead Ideas" → assistant-lead-ideas.js, the lighter-weight sibling of a standing
   * search: the assistant proposes where to look, and approving one files matching companies.
   * Moved here from the Leads tab action bar for the same reason the search button was — both
   * are "go and find me more", which belongs at the top of the funnel, not in the record list.
   *
   * Same init-then-open shape as openNewSearch: that component's open() also no-ops without an
   * assistantId, and nothing else on the page wires it any more.
   */
  function openLeadIdeas() {
    const li = window.AssistantLeadIdeas;
    if (!li || !state.assistantId) return;
    li.init({
      assistantId: state.assistantId,
      cfg: window.AssistantDashboardRegistry?.get('lead_qualifier')?.ideasReview,
    });
    li.open();
  }

  /**
   * Start (or re-run) a saved search from the tab it lives on.
   *
   * Deliberately the ONLY write this component makes besides approve. Everything else about a
   * search — editing it, pausing it, archiving it — stays behind Find New Leads, because those are
   * decisions about the search, and this tab is about its output. Starting is different: it is the
   * one thing a user standing on this screen is blocked by, and the reason the empty state existed.
   *
   * Server-side, run_now on a draft also promotes it to active, which is what makes a recurring
   * cadence actually recur (discovery-campaigns.ts).
   */
  async function startSearch(btn) {
    const id = Number(btn.getAttribute('data-si-start'));
    if (!id) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      const data = await callDiscovery('run_now', { campaignId: id });
      if (data.searchConfigured === false) {
        window.showToast?.('Search saved, but no web search provider is connected yet — it will find nothing until one is set up.', 'info');
      } else {
        window.showToast?.(data.alreadyRunning ? 'That search is already running.' : 'Search started — results appear here as they are found.', 'success');
      }
      await load();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      window.showToast?.(err.message || 'Could not start that search.', 'error');
    }
  }

  /**
   * Re-read while a run is in flight, and only then. A queued/processing job is the one situation
   * where this screen goes stale on its own — everything else changes because the user did
   * something, and that path already reloads.
   *
   * Skipped while the tab is off-screen (the panel is display:none behind .main-tab-content, so
   * offsetParent is null) or the browser tab is backgrounded: polling a surface nobody is looking
   * at spends the user's function invocations to render nothing.
   */
  function schedulePoll() {
    if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
    const running = state.savedSearches.some((s) => s.latestJobStatus === 'queued' || s.latestJobStatus === 'processing');
    if (!running) return;
    // Never yank the list out from under someone working in it: a reload clears the selection and
    // drops back to page one, so a poll that fired mid-review would undo their work silently.
    if (state.selected.size || state.pagedIn) return;
    const h = host();
    if (!h || h.offsetParent === null || document.visibilityState === 'hidden') return;
    state.pollTimer = setTimeout(() => { state.pollTimer = null; load(); }, POLL_MS);
  }

  async function load(opts) {
    const append = !!(opts && opts.append);
    state.loading = true;
    state.error = null;
    if (!append) render();
    try {
      const data = await call('list', {
        savedSearchId: state.savedSearchId ?? undefined,
        showFiltered: state.showFiltered,
        cursor: append ? state.nextCursor : undefined,
      });
      state.signals = append ? state.signals.concat(data.signals || []) : (data.signals || []);
      state.counts = data.counts || state.counts;
      state.savedSearches = data.savedSearches || [];
      // The server stopped listing archived searches, so a filter pinned to one would silently
      // show an empty list with no chip selected. Fall back to All rather than a dead filter.
      if (state.savedSearchId !== null && !state.savedSearches.some((s) => s.id === state.savedSearchId)) {
        state.savedSearchId = null;
      }
      state.hasSocialFeed = !!data.hasSocialFeed;
      state.sourceLabel = data.sourceLabel || state.sourceLabel;
      state.nextCursor = data.nextCursor || null;
      if (!append) state.selected = new Set();
      // Tracks "the user has paged past the first screen", which schedulePoll() treats as work in
      // progress — a background reload would silently throw those pages away.
      state.pagedIn = append;
    } catch (err) {
      // The columns arrive with db/signal-inbox-1a.sql, a MANUAL apply. Say so plainly rather than
      // showing a generic failure the user can do nothing with.
      state.error = err.code === 'MIGRATION_PENDING'
        ? 'Searches is not set up on this environment yet.'
        : (err.message || 'Could not load your signals.');
    } finally {
      state.loading = false;
      updateTab();
      render();
      schedulePoll();
    }
  }

  async function approve(btn) {
    const ids = [...state.selected];
    if (!ids.length) return;
    btn.disabled = true;
    btn.textContent = 'Approving…';
    try {
      const res = await call('approve', { ids });
      // The server may refuse some of them (it re-checks the gate against fresh state), so report
      // what actually happened rather than assuming the whole selection went through.
      if (res.skipped && res.skipped.length) {
        window.showToast?.(`Approved ${res.approved}. ${res.skipped.length} need individual review.`, 'info');
      } else {
        window.showToast?.(`Approved ${res.approved} lead${res.approved === 1 ? '' : 's'}.`, 'success');
      }
      state.selected = new Set();
      await load();
    } catch (err) {
      window.showToast?.(err.message || 'Could not approve those signals.', 'error');
      btn.disabled = false;
      btn.textContent = `Approve ${ids.length}`;
    }
  }

  /**
   * The tab button: how many SEARCHES exist, plus the amber "needs you" count.
   *
   * Two different numbers on purpose, and they answer two different questions. The parenthetical
   * is inventory — how many searches this assistant is running, which is what the tab is FOR and
   * the thing a user checks without opening it. The amber badge is the same "needs you" affordance
   * every other tab uses, and it counts signals awaiting approval, not searches.
   *
   * `(0)` is suppressed: a bare "Searches" reads as an empty tab, where "Searches (0)" reads as a
   * counter that failed to load.
   */
  function updateTab() {
    const label = document.getElementById('signals-tab-label');
    if (label) {
      const searches = state.savedSearches.length;
      label.textContent = searches ? `${state.tabLabel} (${searches})` : state.tabLabel;
    }

    const el = document.getElementById('signals-ready-badge');
    if (!el) return;
    const n = state.counts.ready + state.counts.needsReview;
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('hidden', n === 0);
    // `hidden` loses to a class that sets display, so pin it directly too.
    el.style.display = n === 0 ? 'none' : '';
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * A search created from the chat window (DiscoveryCampaignProposalCard → chat-session.js) writes
   * straight to discovery-campaigns.ts, so this tab has no idea it happened. The user closed the
   * chat onto a Searches tab that still showed nothing and only saw their new search after a
   * manual page refresh — the assistant appeared to have done nothing.
   *
   * Listened for on `document` because the chat modal is mounted at body level, outside this
   * component's host. The assistantId check matters: the workspace can have several assistants and
   * only the one this inbox belongs to should reload.
   */
  document.addEventListener('discovery:created', (e) => {
    const id = e.detail && e.detail.assistantId;
    if (!state.assistantId || Number(id) !== Number(state.assistantId)) return;
    load();
  });

  // A poll scheduled while the tab was open must not keep firing once the browser tab is
  // backgrounded; schedulePoll re-arms itself on the next load when the page comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    } else if (document.visibilityState === 'visible' && state.assistantId && state.rendered) {
      schedulePoll();
    }
  });

  window.AssistantSignalInbox = {
    init({ assistantId, cfg }) {
      state.assistantId = assistantId;
      // The base label, so updateTab can re-append "(N)" without compounding it. Taken from the
      // registry rather than read back off the button, which would already have a count on it
      // after the first load.
      state.tabLabel = (cfg && cfg.label) || 'Searches';
      state.rendered = false;
      // Counts drive the tab badge, so fetch once on init even though the panel is lazy.
      load();
    },
    /** Called on first activation of the tab. Cheap if init() already loaded. */
    activate() {
      if (state.rendered) return;
      state.rendered = true;
      render();
      // init()'s load ran while this panel was hidden, so any poll it wanted was suppressed
      // (offsetParent was null). Now the panel is on screen, arm it.
      schedulePoll();
    },
    refresh: load,
  };
})();
