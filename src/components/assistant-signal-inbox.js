/**
 * src/components/assistant-signal-inbox.js
 * Signal Inbox tab — Phase 1a of docs/lead-generator-revenue-engine-plan.md.
 *
 * The user's searches, and what each one found. Two independent feeds behind one surface:
 *   • saved searches — projected from discovered_leads, categorised "<Assistant> Search".
 *     Works with ONLY a Lead Generator hired.
 *   • social         — Phase 1b, additive. When absent the inbox is still fully populated and
 *                      offers social capture as a one-line footer, never an empty state.
 *
 * Backed by netlify/functions/signal-inbox.ts:
 *   • list    → POST signal-inbox { action:'list', assistantId, savedSearchId?, showFiltered?, cursor? }
 * and, for the writes that belong to a search rather than to its output,
 * netlify/functions/discovery-campaigns.ts (via window.AssistantDiscoveryCampaigns):
 *   • start   → POST discovery-campaigns { action:'run_now', campaignId }
 *   • view / edit / schedule / archive → that component's own modals
 *
 * ── Two levels, two reads ────────────────────────────────────────────────────
 * The TAB lists searches: what each is doing, what it found, and the four controls that manage it.
 * The RESULTS of a search open in a modal from its own row (openResults → loadResults).
 * `load()` reads the tab and never filters by search — `countsBySearch` is only complete
 * unfiltered, and every "View results (N)" button is derived from it.
 *
 * ── This tab decides nothing about a lead ────────────────────────────────────
 * The results list is READ-ONLY, and that is a deliberate reversal. It used to carry a batch
 * approve, which implied that approving is what turns a search result into a lead. It never was:
 * every scored company is mirrored into assistant_records the moment the worker scores it
 * (process-discovery-jobs.ts promoteOne), hot, warm and cold alike, so by the time a row appears
 * here the lead already exists. Approving only clears an existing lead for OUTREACH — a decision
 * the Leads tab already offers per lead, beside the Approval and Contact columns it needs, and one
 * that is optional per search (the "review before outreach" guardrail auto-approves when unticked).
 * Two triage surfaces over one `approval_status` column is how they drift; this is the one that
 * went. Searches show what a search did.
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
 * ⚠️ signal-inbox.ts still exposes `approve` and still refuses to batch a lead whose only contact
 * is a named individual's scraped address. Nothing in this component calls it any more. It is kept
 * because that gate is the enforcement, not this UI, and because bulk triage belongs with the leads
 * if it ever returns — see tests/signal-inbox.test.ts, which pins it either way.
 *
 * Styling reuses classes already compiled into style.css (no rebuild — see the Tailwind drift note
 * in the project conventions). All server values are escaped on render; treat them as untrusted.
 */
(function () {
  const API = '/.netlify/functions/signal-inbox';
  const DISCOVERY_API = '/.netlify/functions/discovery-campaigns';
  /**
   * How often to re-read while a run is in flight.
   *
   * Two cadences, because a run has two very different tempos. While the worker is ADVANCING it
   * files companies continuously, and the "View results (N)" count is the proof the search is
   * working — at fifteen seconds that number moved rarely enough to read as stuck, which is the
   * complaint this pair of constants answers. Once a run has stopped advancing (the on-demand drain
   * gives up after twelve minutes and hands back to the ten-minute cron) there is nothing to see
   * for minutes at a time, and polling fast would spend the user's function invocations to render
   * the same numbers.
   */
  const POLL_MS = 6000;
  const POLL_STALLED_MS = 30000;

  let state = {
    assistantId: null,
    // The results LIST belongs to the modal now, not to the tab. Kept on the same state object
    // because the poll needs it, but only ever rendered inside the overlay.
    signals: [],
    counts: { total: 0, ready: 0, needsReview: 0, promoted: 0, filtered: 0 },
    // Per-search totals, so a "View results (12)" button on one search cannot state the whole tab's
    // number. Keyed by campaign id.
    countsBySearch: {},
    // Counts for the search whose results modal is open — held apart from the tab's own, so a modal
    // read never overwrites them.
    resultCounts: { total: 0, ready: 0, needsReview: 0, promoted: 0, filtered: 0 },
    savedSearches: [],
    // Which page of "Your searches" is on screen. Kept on state rather than derived per render, and
    // deliberately NOT reset by load(): this tab re-reads itself on every activate() and on every
    // poll tick while a run is in flight, and a page number that resets underneath the user is the
    // same "lost my place" failure the filters were built to avoid. ListPager clamps it, so a page
    // that stops existing (a search archived from page 3 of 3) lands on the last real page.
    searchPage: 1,
    savedSearchId: null,
    resultsOverlay: null,
    hasSocialFeed: false,
    sourceLabel: 'Saved search',
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

  /**
   * Where a found company stands AS A LEAD.
   *
   * This replaced a chip drawn from `handoffStatus` — the batch gate's vocabulary ("Ready to
   * approve", "Filtered"). That vocabulary described this screen's own workflow rather than the
   * lead, and it was wrong in the ordinary case: a cold-scored company is `filtered` for batch
   * purposes and sits in the Leads tab awaiting approval exactly like a hot one, so "Filtered" read
   * as "discarded" about a lead the user owns. The rating chip beside this one already says how
   * well it scored; this one says what has been decided about it, and nothing else.
   */
  const LEAD_CHIP = {
    approved: 'bg-green-50 text-green-700 border-green-100',
    rejected: 'bg-gray-100 text-gray-500 border-gray-200',
  };
  const LEAD_LABEL = {
    approved: 'Approved',
    rejected: 'Rejected',
  };
  /**
   * The rating chip's colours — orange hot, yellow warm, blue cold.
   *
   * ⚠️ Read from the GENERATED mirror (window.LeadRating.chips, built from
   * src/config/lead-rating-chips.ts), for the same reason ratingHelp() below reads the bands from
   * there: this chip is drawn by three surfaces, and when each held its own class strings a hot
   * lead was emerald here and neutral grey in the Leads tab — one fact, two appearances.
   *
   * Falls back to the neutral chip when the mirror has not loaded, which is also what an unrated
   * lead gets. Deliberately not a hardcoded copy of the three colours: that is the fourth copy this
   * exists to prevent.
   */
  const ratingChip = (r) => ((window.LeadRating && typeof window.LeadRating.chipFor === 'function')
    ? window.LeadRating.chipFor(r).cls
    : 'bg-gray-100 text-gray-500 border-gray-200');

  /**
   * What "hot" / "warm" / "cold" actually mean, for the chip's tooltip.
   *
   * ⚠️ Read from the GENERATED mirror of the scoring rubric (src/generated/platform-constants.js →
   * window.LeadRating, built from RATING_BANDS in src/config/icp-profile.ts), never typed here.
   * Those thresholds have already drifted once between three prompt copies, and a tooltip quoting a
   * band that differs from the one that produced the chip is that bug pointed at a user.
   *
   * Returns '' when the mirror has not loaded, which renders no tooltip at all. That is the right
   * failure: a hardcoded fallback is exactly the fourth copy this avoids.
   */
  function ratingHelp(rating) {
    return (window.LeadRating && typeof window.LeadRating.help === 'function')
      ? window.LeadRating.help(rating) : '';
  }

  /**
   * The house button styles, so a row cannot invent its own.
   *
   * Primary is the emerald fill used for the one action a screen is FOR; secondary is the white
   * ghost with the emerald hover (the dominant variant across the app — the plain grey-hover ghost
   * is the older, weaker one); danger is the same ghost that reddens. Every class here is already
   * compiled into style.css, so none of this needs a Tailwind rebuild.
   */
  const BTN = {
    primary: 'px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed',
    secondary: 'px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed',
    danger: 'px-3 py-1.5 bg-white border border-gray-200 text-gray-500 hover:text-red-600 hover:border-red-300 text-xs font-bold rounded-lg transition',
  };

  /**
   * One company a search found — a RECORD of the find, not a decision to make.
   *
   * There is no checkbox and no approve button here any more, and that is the point. Every scored
   * company is already a lead: the worker mirrors it into assistant_records the instant it is
   * scored, whatever its rating (process-discovery-jobs.ts promoteOne). Approving never created the
   * lead — it clears an existing one for outreach — so offering that decision on this tab put a
   * second triage surface in front of the Leads tab, over the same `approval_status` column, and
   * made a step that is genuinely optional (the per-search "review before outreach" guardrail) look
   * mandatory. Searches show what a search did; leads are managed in the Leads tab.
   */
  function row(s) {
    const dim = s.handoffStatus === 'filtered' && s.leadState === 'rejected' ? 'opacity-70' : '';
    const help = ratingHelp(s.rating);

    // The company name opens its lead record. A signal with no assistantRecordId has not been
    // mirrored yet (it is mid-run), so it renders as plain text rather than a control that would
    // open nothing.
    const title = s.assistantRecordId
      ? `<button type="button" data-si-lead="${esc(s.assistantRecordId)}" title="Open this lead"
           class="font-semibold text-gray-900 text-sm text-left hover:text-emerald-800 hover:underline cursor-pointer">${esc(s.title)}</button>`
      : `<p class="font-semibold text-gray-900 text-sm">${esc(s.title)}</p>`;

    // ⚠️ Only the DECIDED states get a chip. Every row here is a lead awaiting a decision — that is
    // the ordinary case, stated once at the top of the modal — so an "In Leads · awaiting you" pill
    // on each row was the same sentence repeated down the page, crowding out the two rows that are
    // actually different. Absence now means "nothing decided yet", which is what a blank column
    // should mean.
    const decided = s.leadState === 'approved' || s.leadState === 'rejected';
    return `
      <div class="flex items-start gap-3 p-4 border-b border-gray-100 ${dim}">
        <div class="min-w-0 flex-1">
          ${title}
          ${s.excerpt ? `<p class="text-xs text-gray-500 mt-0.5">${esc(s.excerpt)}</p>` : ''}
          ${s.reviewReason ? `<p class="text-xs text-amber-800 mt-1">${esc(s.reviewReason)}</p>` : ''}
        </div>
        <div class="shrink-0 w-20 text-right">
          ${s.rating ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full border cursor-help ${ratingChip(s.rating)}"${help ? ` title="${esc(help)}"` : ''}>${esc(s.rating)}${s.confidence != null ? ' &middot; ' + esc(s.confidence) : ''}</span>` : ''}
        </div>
        <div class="shrink-0 w-24 text-right">
          ${decided ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${LEAD_CHIP[s.leadState]}">${esc(LEAD_LABEL[s.leadState])}</span>` : ''}
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
   * "Contact details for 4 of 65 — 20 publish none, 41 scored cold so were never checked."
   *
   * Enrichment hits about one SMB site in three, so a search that found 65 companies stocks the
   * Review tab with a handful. Without this line an empty Review reads as a broken assistant; with
   * it, the emptiness is a result — and it points at the right remedy, which is usually TARGETING
   * (too many cold leads) rather than the scraper.
   *
   * ⚠️ The four counts partition the total, so they must be stated as parts of it and never added
   * up independently. They come from src/config/lead-contact-state.ts, the same definitions the
   * Leads tab's Contact column is pinned against — this sentence sits one click from that table
   * and a user WILL check it against the chips.
   *
   * Returns '' when the search has no leads: "contact details for 0 of 0" is noise on a search
   * whose own line already says nothing was found.
   */
  function contactAggregateLine(s) {
    const total = Number(s.contactTotal || 0);
    if (!total) return '';
    const found = Number(s.contactReachable || 0);
    const none = Number(s.contactNonePublished || 0);
    const cold = Number(s.contactNotAttempted || 0);
    const pending = Number(s.contactPending || 0);

    const missed = Number(s.contactMissed || 0);

    const parts = [];
    // Each clause explains a different remedy, which is the whole point of not collapsing them:
    // "publishes none" sends you to find an address by hand, "scored cold" sends you to targeting,
    // "not looked up" sends you to run the search again.
    if (none) parts.push(`${none} publish${none === 1 ? 'es' : ''} none`);
    if (cold) parts.push(`${cold} scored cold so ${cold === 1 ? 'was' : 'were'} never checked`);
    // ⚠️ Distinct from `pending`, which is a promise. These are hot/warm leads the run ended
    // without reaching, so nothing will look them up unless someone asks it to (item 11).
    if (missed) parts.push(`${missed} ${missed === 1 ? 'was' : 'were'} not looked up`);
    if (pending) parts.push(`${pending} still to check`);

    const lead = `Contact details for ${found} of ${total}`;
    return parts.length ? `${lead} — ${parts.join(', ')}.` : `${lead}.`;
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
    const latest = Number(s.latestRunLeadsFound || 0);
    const cadence = cadenceLine(s);
    const companies = (n) => `${n} compan${n === 1 ? 'y' : 'ies'}`;

    // 'queued' is where a RUNNING search rests, not only where a new one waits. The worker takes
    // one search query per slice (~10s), writes the row back to 'queued' and returns, so a live run
    // reads 'queued' for almost its whole life — through searching, promoting and enriching alike.
    // Labelling that "Queued" told a user whose search had already filed fifteen leads that nothing
    // had started. `stage` is the discriminator: it is NULL until the first slice claims the job.
    // Computed BEFORE the count line because that line has to say "this run" while one is in
    // flight and "the last run" once it has stopped.
    const started = job === 'processing' || (job === 'queued' && !!stage);

    // "found so far" is the CAMPAIGN total across every run. On a re-run it can stay completely
    // still while the run itself did work, because leads_found counts only newly inserted domains
    // and the insert ignores (campaign_id, domain) conflicts — so a repeat run that re-finds the
    // same companies banks nothing. Saying only the total let a re-run that added nothing read as
    // "15 companies found so far", which a user reasonably hears as "this run found 15".
    //
    // ⚠️ While a run is in flight `latest` is that run's count climbing, so it must never be
    // called "the last run" — and "no new companies" must not be stated as a result before the
    // run has had a chance to find any.
    const runLabel = started ? 'this run' : 'the last run';
    const total = !found
      ? (started ? 'Nothing found yet.' : 'No companies found yet.')
      : latest === found
        ? `${companies(found)} found.`
        : !latest
          ? (started
              ? `Nothing new yet this run — ${companies(found)} found so far.`
              : `No new companies on the last run — ${companies(found)} found so far.`)
          : `${companies(latest)} on ${runLabel} · ${companies(found)} so far.`;
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
      // The reachability aggregate belongs on a FINISHED run and nowhere else. Mid-run the counts
      // are still moving (enriching is the last stage), and on a failed run they describe a
      // pipeline that stopped early — in both cases the sentence would be true of the database and
      // misleading about the search.
      //
      // Returned as its own field, not appended to `line`. Concatenated, it landed between the
      // count and the cadence — "65 companies found. Contact details for 4 of 65 — 9 publish
      // none, 52 scored cold so were never checked. It runs once each time you start it…" — three
      // sentences of different kinds in one grey paragraph, which buries the one the user came for.
      return { chip: 'bg-emerald-50 text-emerald-800 border-emerald-200', label: `Ran ${ago(s.lastFinishedAt)}`, action: 'run',
        line: `${total} ${cadence}`, reach: contactAggregateLine(s) };
    }
    return { chip: 'bg-gray-100 text-gray-500 border-gray-200', label: 'No runs yet', action: 'run',
      line: `Active but it has not run yet. ${cadence}` };
  }

  /**
   * How many companies one search has found — every one of them, because that is now exactly what
   * the modal shows. It counted only the non-filtered ones while the modal hid cold leads behind a
   * toggle; both halves of that went when the approve step left this tab.
   */
  function resultsCount(id) {
    const c = state.countsBySearch[id];
    return { total: c ? c.total : 0 };
  }

  // `last` rather than a `last:border-b-0` utility — that class is not in the compiled style.css,
  // and rebuilding Tailwind for one divider churns unrelated classes across the whole sheet.
  function searchRow(s, last) {
    const st = searchState(s);
    const rc = resultsCount(s.id);

    // One emphasised action per row, and it is whichever thing the row is FOR right now. A search
    // that has never run has exactly one useful control (start it); a search with results is a
    // thing you open. Making both emerald would emphasise nothing, and making neither — which is
    // what this row used to do — leaves a wall of identical white buttons with no way in.
    const startIsPrimary = st.action === 'start';
    const btn = st.action === 'start'
      ? `<button type="button" data-si-start="${s.id}" class="${BTN.primary}">Start search</button>`
      : st.action === 'run'
        ? `<button type="button" data-si-start="${s.id}" class="${BTN.secondary}">Run again</button>`
        : '';

    // The results button. Disabled — not hidden — while a search has found nothing: a row with no
    // way to open its results reads as a broken control, where a disabled one with a reason reads
    // as a fact about the search.
    //
    // The count is live: while a run is in flight the poll re-reads countsBySearch and re-renders
    // this row, so it climbs on its own. The pulsing dot says that out loud — a number that changes
    // only when you happen to look at it is indistinguishable from one that is stuck.
    const resultsBtn = rc.total === 0
      ? `<button type="button" disabled title="This search has not found anything yet"
           class="${BTN.secondary} opacity-60 cursor-not-allowed">View results</button>`
      : `<button type="button" data-si-results="${s.id}" aria-live="polite"
           class="${startIsPrimary ? BTN.secondary : BTN.primary}">View results (${rc.total})${st.running
             ? ' <span class="inline-block w-1.5 h-1.5 rounded-full bg-white animate-pulse align-middle"></span>' : ''}</button>`;

    return `
      <div class="p-4 ${last ? '' : 'border-b border-gray-100'}">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="font-semibold text-gray-900 text-sm">${esc(s.label)}</p>
              <span class="text-xs font-bold px-2 py-0.5 rounded-full border ${st.chip}">${esc(st.label)}</span>
            </div>
            <p class="text-xs text-gray-500 mt-1">${esc(st.line)}</p>
            ${st.reach ? `<p class="text-xs text-gray-700 mt-1">${esc(st.reach)}</p>` : ''}
          </div>
          <div class="shrink-0">${btn}</div>
        </div>
        <div class="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-gray-100">
          ${resultsBtn}
          <span class="ml-auto flex flex-wrap items-center gap-2">
            <button type="button" data-si-view="${s.id}" class="${BTN.secondary}">View</button>
            <button type="button" data-si-edit="${s.id}" class="${BTN.secondary}">Edit</button>
            <button type="button" data-si-schedule="${s.id}" class="${BTN.secondary}">Schedule</button>
            <button type="button" data-si-archive="${s.id}" class="${BTN.danger}">Archive</button>
          </span>
        </div>
      </div>`;
  }

  /**
   * How many searches are listed at once.
   *
   * Ten because a search row is tall — a state line, a reachability line and six controls — so ten
   * is already a screen and a half. The count in the tab label ("Searches (34)") still states the
   * whole inventory, so paging never hides how many there are.
   */
  const SEARCHES_PER_PAGE = 10;

  function searchesPanel() {
    if (!state.savedSearches.length) return '';
    const pg = window.ListPager
      ? window.ListPager.page(state.savedSearches, state.searchPage, SEARCHES_PER_PAGE)
      : { items: state.savedSearches, pages: 1 };
    return `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm mb-4">
        <div class="p-4 border-b border-gray-100">
          <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">Your searches</p>
          <p class="text-xs text-gray-500 mt-1">Each search looks across the public web, scores what it finds against your profile, and files every company it finds as a lead in your <span class="font-semibold text-gray-700">Leads</span> tab &mdash; hot, warm or cold. Open a search&rsquo;s results to see what it found; decide who to pursue in the Leads tab.</p>
        </div>
        ${pg.items.map((s, i) => searchRow(s, i === pg.items.length - 1)).join('')}
        ${window.ListPager ? window.ListPager.controlsHtml(pg, { attr: 'data-si-page', noun: 'searches' }) : ''}
      </div>`;
  }

  /**
   * No searches at all — the only empty state the TAB itself can have now that results live behind
   * a per-search button. The "it ran and found nothing" / "it never ran" / "it is running" copy
   * moved to resultsEmptyState(), where it can name one search instead of guessing across all of
   * them: this state used to say "create a saved search" to a user who had just created one in
   * chat, and the fix was to make the empty state describe the actual situation.
   */
  function emptyState() {
    return `<div class="p-8 text-center">
      <p class="text-sm font-semibold text-gray-900">No searches yet</p>
      <p class="text-xs text-gray-500 mt-1">Create a search and your assistant will start looking for companies that match it.</p>
      <button type="button" data-si-new-search
        class="mt-3 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition">Find New Leads</button>
    </div>`;
  }

  /**
   * The tab: the searches themselves, and nothing else.
   *
   * The results used to be printed straight down this page, every search's companies interleaved
   * under one filter chip row. That put the list a user reviews occasionally above the searches
   * they manage constantly, and it meant "approve" acted on a mixed selection spanning searches.
   * Results now open per search, from the row that produced them (openResults) — so the thing you
   * approve is always the output of one search you can see the state of.
   */
  function view() {
    if (state.loading && !state.savedSearches.length) {
      return `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center text-sm text-gray-500">Loading your searches…</div>`;
    }
    if (state.error) {
      return `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <p class="text-sm font-semibold text-gray-900">${esc(state.error)}</p>
        <button type="button" data-si-retry class="mt-3 px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-gray-300 text-xs font-bold rounded-lg transition">Try again</button>
      </div>`;
    }

    return `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm mb-4">
        <div class="p-4 flex flex-wrap items-center gap-2">
          <p class="text-xs font-bold text-gray-500 uppercase tracking-wide mr-auto">Lead searches</p>
          <button type="button" data-si-lead-ideas
            class="px-2.5 py-1 text-xs font-bold rounded-lg border bg-white text-gray-600 border-gray-200 hover:border-gray-300 transition">Review Lead Ideas</button>
          <button type="button" data-si-new-search
            class="px-2.5 py-1 text-xs font-bold rounded-lg border bg-white text-emerald-700 border-emerald-200 hover:border-emerald-300 hover:bg-emerald-50 transition">Find New Leads</button>
        </div>
        ${state.savedSearches.length ? '' : emptyState()}
        ${!state.hasSocialFeed ? `
        <div class="p-4 border-t border-gray-100 bg-gray-50 flex flex-wrap items-center gap-3">
          <p class="text-xs text-gray-500">Also capture comments, DMs and mentions as signals &mdash; needs a Social Media Assistant.</p>
        </div>` : ''}
      </div>

      ${searchesPanel()}`;
  }

  function render() {
    const h = host();
    if (!h) return;
    h.innerHTML = view();
    bind(h);
    // Delegated on the HOST, which survives every render — the panel's innerHTML is rewritten on
    // each one, so a listener bound to the buttons themselves would have to be re-attached here and
    // would silently stop working the first time a render was missed.
    window.ListPager?.bind(h, 'data-si-page', (n) => { state.searchPage = n; render(); });
  }

  // ── The results modal ──────────────────────────────────────────────────────
  //
  // One search's companies, opened from its row. Everything about reviewing results lives in here:
  // the filtered toggle, the batch gate, paging. The gate itself is unchanged and still enforced
  // server-side — needs_review rows get no checkbox here and signal-inbox.ts re-classifies anyway.

  function resultsModalView() {
    const c = state.resultCounts;
    const search = state.savedSearches.find((s) => s.id === state.savedSearchId);
    const empty = state.signals.length === 0;
    // What the user does next, and where. Stated once, at the top, because this list itself offers
    // no action: the leads are already filed and the decision about them belongs to the Leads tab.
    const waiting = c.total - c.promoted;

    return `
      <div class="p-4 border-b border-gray-100">
        <p class="text-xs text-gray-500">${esc(search ? searchState(search).line : '')}</p>
        ${c.total ? `<p class="text-xs text-gray-500 mt-1">${waiting > 0
          ? esc(`${waiting} of ${c.total} still ${waiting === 1 ? 'has' : 'have'} no decision — approve or reject ${waiting === 1 ? 'it' : 'them'} in the Leads tab.`)
          : 'Every one of them has been decided.'}</p>` : ''}
      </div>

      ${state.loading && empty
        ? '<p class="text-sm text-gray-400 py-10 text-center">Loading results…</p>'
        : empty ? resultsEmptyState() : state.signals.map(row).join('')}

      ${state.nextCursor ? `
      <div class="text-center p-4">
        <button type="button" data-si-more class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-gray-300 text-xs font-bold rounded-lg transition">Load more</button>
      </div>` : ''}`;
  }

  /**
   * An empty results list, explained by why it is empty — for ONE search, so it can be specific in
   * a way the old tab-wide empty state could not. The filtered case is the new one and the one that
   * matters most: a search whose every company scored cold has a full results table and shows
   * nothing, which reads as a broken modal rather than a targeting problem.
   */
  function resultsEmptyState() {
    const s = state.savedSearches.find((x) => x.id === state.savedSearchId);
    if (s && (s.latestJobStatus === 'queued' || s.latestJobStatus === 'processing')) {
      return `<div class="p-8 text-center">
        <p class="text-sm font-semibold text-gray-900">Searching now</p>
        <p class="text-xs text-gray-500 mt-1">A search works through one query at a time, so companies arrive in batches rather than all at once. This list updates itself.</p>
      </div>`;
    }
    if (s && s.latestJobStatus === 'failed') {
      return `<div class="p-8 text-center">
        <p class="text-sm font-semibold text-gray-900">The last run did not finish</p>
        <p class="text-xs text-gray-500 mt-1">Nothing came in because the search stopped early, not because it found nothing. Starting it again is safe.</p>
      </div>`;
    }
    if (s && !s.latestJobStatus) {
      return `<div class="p-8 text-center">
        <p class="text-sm font-semibold text-gray-900">This search has not run yet</p>
        <p class="text-xs text-gray-500 mt-1">Start it from its row and the companies it finds land here for your approval.</p>
      </div>`;
    }
    return `<div class="p-8 text-center">
      <p class="text-sm font-semibold text-gray-900">Nothing came in</p>
      <p class="text-xs text-gray-500 mt-1">The last run found no companies that cleared your profile. Run it again, or widen the description with Edit.</p>
    </div>`;
  }

  function renderResults() {
    const b = state.resultsOverlay?.querySelector('[data-si-results-body]');
    if (!b) return;
    b.innerHTML = resultsModalView();
    bindResults(b);
  }

  function openResults(id) {
    closeResults();
    state.savedSearchId = id;
    state.signals = [];
    state.nextCursor = null;
    state.pagedIn = false;
    const search = state.savedSearches.find((s) => s.id === id);

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100 shrink-0">
          <div class="min-w-0">
            <h3 class="text-lg font-bold text-gray-900">${esc(search ? search.label : 'Search results')}</h3>
            <p class="text-sm text-gray-500 mt-0.5">What this search found. Every company is already a lead &mdash; pursue or turn them down in the Leads tab.</p>
          </div>
          <button type="button" data-si-results-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer shrink-0">&times;</button>
        </div>
        <div class="overflow-y-auto" data-si-results-body></div>
      </div>`;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeResults(); });
    overlay.querySelector('[data-si-results-close]').addEventListener('click', () => closeResults());
    document.body.appendChild(overlay);
    state.resultsOverlay = overlay;
    loadResults();
  }

  function closeResults() {
    if (!state.resultsOverlay) return;
    state.resultsOverlay.remove();
    state.resultsOverlay = null;
    state.savedSearchId = null;
    state.signals = [];
    state.nextCursor = null;
    state.pagedIn = false;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  /** The tab: searches and the buttons that manage them. */
  function bind(h) {
    h.querySelector('[data-si-retry]')?.addEventListener('click', () => load());
    h.querySelectorAll('[data-si-start]').forEach((b) => b.addEventListener('click', () => startSearch(b)));
    h.querySelectorAll('[data-si-results]').forEach((b) => b.addEventListener('click', () => openResults(Number(b.getAttribute('data-si-results')))));
    // Two of these can be on screen at once (toolbar + empty state), so bind them as a set.
    h.querySelectorAll('[data-si-new-search]').forEach((b) => b.addEventListener('click', openNewSearch));
    h.querySelector('[data-si-lead-ideas]')?.addEventListener('click', openLeadIdeas);
    h.querySelectorAll('[data-si-view]').forEach((b) => b.addEventListener('click', () => manageSearch('openView', b, 'data-si-view')));
    h.querySelectorAll('[data-si-edit]').forEach((b) => b.addEventListener('click', () => manageSearch('openEdit', b, 'data-si-edit')));
    h.querySelectorAll('[data-si-schedule]').forEach((b) => b.addEventListener('click', () => manageSearch('openSchedule', b, 'data-si-schedule')));
    h.querySelectorAll('[data-si-archive]').forEach((b) => b.addEventListener('click', () => manageSearch('archive', b, 'data-si-archive')));
  }

  /** The results modal: paging, and opening a lead. The list itself decides nothing. */
  function bindResults(b) {
    b.querySelector('[data-si-more]')?.addEventListener('click', () => loadResults({ append: true }));
    b.querySelectorAll('[data-si-lead]').forEach((el) => el.addEventListener('click', () => openLead(el.getAttribute('data-si-lead'))));
  }

  /**
   * A company in the results → its lead record.
   *
   * Three steps, in this order and for a reason. The results modal closes because it is a record of
   * a search, and the user has just left that question behind. The Leads tab is activated because
   * that is where leads are managed — approving from a modal floating over the Searches tab would
   * update a table that is not on screen, and closing it would drop the user back somewhere that
   * shows none of what they just did. The record modal then opens over the Leads table, so the
   * decision they take is visible in the list underneath the moment they close it.
   *
   * The record itself is rendered by assistant-data-hub.js, which owns lead records — this one
   * passes an id and gets out of the way.
   */
  function openLead(recordId) {
    const id = Number(recordId);
    if (!id) return;
    closeResults();
    window._activateMainTab?.('datahub');
    window.AssistantDataHub?.openRecordModal?.(id);
  }

  /**
   * View / Edit / Schedule / Archive — all four are decisions about the SEARCH, and they live in
   * assistant-discovery-campaigns.js, which owns every write to a discovery campaign. This tab
   * only routes to them and re-reads itself afterwards, because it renders those same searches
   * from a different endpoint and would otherwise keep showing the old cadence or the archived row.
   *
   * Same init-then-open shape as openNewSearch: that component no-ops without an assistantId.
   */
  function manageSearch(method, btn, attr) {
    const dc = window.AssistantDiscoveryCampaigns;
    const id = Number(btn.getAttribute(attr));
    if (!dc || !id || !state.assistantId) return;
    dc.init({
      assistantId: state.assistantId,
      cfg: window.AssistantDashboardRegistry?.get('lead_qualifier')?.discoveryCampaigns,
    });
    // Archiving the search whose results are open would leave a modal listing a search that no
    // longer exists; editing one changes what its results mean. Close first, reload after.
    if (method !== 'openView') closeResults();
    dc[method](id, () => load());
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
    const inFlight = state.savedSearches.filter((s) => s.latestJobStatus === 'queued' || s.latestJobStatus === 'processing');
    if (!inFlight.length) return;
    // Advancing = at least one in-flight run has moved within the stall window. searchState() draws
    // the same line for its "Paused between steps" label, so the row and the poll agree about
    // whether anything is actually happening.
    const advancing = inFlight.some((s) => {
      const moved = Date.parse(s.latestJobUpdatedAt || '');
      return !moved || Date.now() - moved <= STALL_MS;
    });
    // Never yank the list out from under someone reading it: a reload drops back to page one, so a
    // poll that fired after they had paged through would silently throw those pages away.
    if (state.pagedIn) return;
    const h = host();
    if (!h || h.offsetParent === null || document.visibilityState === 'hidden') return;
    state.pollTimer = setTimeout(() => {
      state.pollTimer = null;
      load();
      // The modal is the surface actually being watched while a run is in flight — a poll that
      // refreshed only the row behind it would leave the open list of companies frozen.
      if (state.resultsOverlay) loadResults();
    }, advancing ? POLL_MS : POLL_STALLED_MS);
  }

  /**
   * The TAB's read: the searches, their state, and the counts the buttons and the tab badge state.
   *
   * Deliberately never filtered by a search. The response's `countsBySearch` is only complete for
   * an unfiltered read, and it is what every "View results (N)" button is derived from — asking for
   * one search's rows here would zero the others' buttons.
   */
  async function load() {
    state.loading = true;
    state.error = null;
    render();
    try {
      const data = await call('list', { showFiltered: false });
      state.counts = data.counts || state.counts;
      state.countsBySearch = data.countsBySearch || {};
      state.savedSearches = data.savedSearches || [];
      // Archived searches stop being listed, so a results modal open on one is now showing a search
      // that is no longer here. Close it rather than leaving a dead list on screen.
      if (state.savedSearchId !== null && !state.savedSearches.some((s) => s.id === state.savedSearchId)) {
        closeResults();
      }
      state.hasSocialFeed = !!data.hasSocialFeed;
      state.sourceLabel = data.sourceLabel || state.sourceLabel;
    } catch (err) {
      // The columns arrive with db/signal-inbox-1a.sql, a MANUAL apply. Say so plainly rather than
      // showing a generic failure the user can do nothing with.
      state.error = err.code === 'MIGRATION_PENDING'
        ? 'Searches is not set up on this environment yet.'
        : (err.message || 'Could not load your searches.');
    } finally {
      state.loading = false;
      updateTab();
      render();
      schedulePoll();
    }
  }

  /** The MODAL's read: one search's companies, paged. */
  async function loadResults(opts) {
    if (!state.savedSearchId || !state.resultsOverlay) return;
    const append = !!(opts && opts.append);
    state.loading = true;
    if (!append) renderResults();
    try {
      const data = await call('list', {
        savedSearchId: state.savedSearchId,
        // Always everything. `showFiltered` existed to keep un-approvable rows out of a batch
        // approve; with no approve here, a cold-scored company is simply a result with a cold chip
        // — and one that is a lead in the Leads tab like any other, so hiding it by default made
        // this list disagree with the tab it points at.
        showFiltered: true,
        cursor: append ? state.nextCursor : undefined,
      });
      state.signals = append ? state.signals.concat(data.signals || []) : (data.signals || []);
      // Filtered to this search, so `counts` describes THIS search — held apart from the tab's own
      // counts, which the badge is derived from and which cover every search.
      state.resultCounts = data.counts || state.resultCounts;
      state.nextCursor = data.nextCursor || null;
      // Tracks "the user has paged past the first screen", which schedulePoll() treats as work in
      // progress — a background reload would silently throw those pages away.
      state.pagedIn = append;
    } catch (err) {
      const b = state.resultsOverlay?.querySelector('[data-si-results-body]');
      if (b) b.innerHTML = `<p class="p-6 text-sm font-semibold text-red-700">${esc(err.message || 'Could not load these results.')}</p>`;
      state.loading = false;
      return;
    }
    state.loading = false;
    renderResults();
  }

  /**
   * The tab button: how many SEARCHES exist, plus the amber "needs you" count.
   *
   * Two different numbers on purpose, and they answer two different questions. The parenthetical
   * is inventory — how many searches this assistant is running, which is what the tab is FOR and
   * the thing a user checks without opening it. The amber badge is the same "needs you" affordance
   * every other tab uses.
   *
   * ⚠️ That badge used to count LEADS awaiting approval. It was pointing at work that is not done
   * on this tab — approving happens in Leads, and the Review tab already carries its own
   * pending badge over the same records — so the same number was badged twice and one of them
   * led nowhere. It now counts SEARCHES that cannot progress without the user: a draft nobody has
   * started (it has searched nothing and spent nothing) and a search whose last run failed.
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

    const el = document.getElementById('signals-attention-badge');
    if (!el) return;
    const n = state.savedSearches.filter((s) => s.status === 'draft' || s.latestJobStatus === 'failed').length;
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
      // A different assistant is a different set of searches — the page number from the last one
      // means nothing here. (load() deliberately leaves it alone; init() is the reset.)
      state.searchPage = 1;
      // Counts drive the tab badge, so fetch once on init even though the panel is lazy.
      load();
    },
    /**
     * Called every time the tab is opened (assistants.js _activateMainTab).
     *
     * ⚠️ This used to return early once it had painted, and that froze the live count. The poll
     * suppresses itself whenever the panel is off-screen — it re-reads `offsetParent` and returns
     * WITHOUT re-arming — so leaving the Searches tab mid-run killed the timer for good, and coming
     * back did nothing because `rendered` was already true. "View results (12)" then sat at 12
     * while the run filed another forty, and only a page refresh moved it.
     *
     * Now it always re-reads and re-arms. Returning to a tab that has been away is precisely when
     * the counts are most stale and the timer is most likely dead, and one list read is cheap.
     */
    activate() {
      if (!state.rendered) {
        state.rendered = true;
        render();
      }
      load();
    },
    refresh: load,
  };
})();
