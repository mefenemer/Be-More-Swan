/**
 * src/components/assistant-discovery-campaigns.js
 *
 * "Find New Leads" flow for the Lead Generator (roleKey lead_qualifier) on
 * assistant-detail.html — lets the user author an outbound discovery *campaign*
 * (an Idea / Blueprint + cadence + guardrails), then launches a background run that
 * searches the public web, dedupes, scores and files real leads into the Leads tab
 * (pending approval). Backed by netlify/functions/discovery-campaigns.ts.
 *
 *   • Create campaign → POST discovery-campaigns { action:'create', ... }  (one_off runs now)
 *   • List campaigns  → POST discovery-campaigns { action:'list', assistantId }
 *   • Run now         → POST discovery-campaigns { action:'run_now', campaignId }
 *   • View leads      → POST discovery-campaigns { action:'list_leads', campaignId }
 *
 * Wiring (assistants.js → _applyDashboardRegistry):
 *   window.AssistantDiscoveryCampaigns.init({ assistantId, cfg });  // cfg = registry.discoveryCampaigns
 *
 * Every campaign/lead field is stored (user- or LLM-authored) — treat as untrusted, escape on render.
 * Uses only Tailwind classes already present in the compiled style.css (no rebuild needed).
 */
(function () {
  'use strict';

  const API = '/.netlify/functions/discovery-campaigns';
  // briefCampaignId / brief hold the Phase 0 review step between generate_brief and approve_brief.
  const state = { assistantId: null, cfg: null, overlay: null, searchConfigured: true, briefCampaignId: null, brief: null };

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function call(action, extra) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, assistantId: state.assistantId, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  const STATUS_CHIP = {
    completed: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    processing: 'bg-blue-50 text-blue-800 border-blue-200',
    queued: 'bg-amber-50 text-amber-800 border-amber-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
  };
  /**
   * The score pill on a result row is coloured by its RATING — orange hot, yellow warm, blue cold —
   * from the generated mirror (window.LeadRating.chips ← src/config/lead-rating-chips.ts).
   *
   * ⚠️ Was a local table here, and it disagreed with the Leads tab and the scoring card. Neutral
   * grey when the rating is missing or the mirror has not loaded; an unrated result is not cold.
   */
  const ratingChip = (r) => ((window.LeadRating && typeof window.LeadRating.chipFor === 'function')
    ? window.LeadRating.chipFor(r).cls
    : 'bg-gray-100 text-gray-500 border-gray-200');

  /**
   * When this campaign next runs, in the viewer's timezone.
   *
   * Deliberately duplicated from `cadenceLine`/`when` in assistant-signal-inbox.js rather than
   * shared: these are IIFE script-tag modules with no import graph between them, and the two
   * surfaces read the same three fields from the same two list endpoints. If the wording diverges,
   * fix it in both — the rule they must agree on is that one_off has NO next run and a disabled
   * schedule (a draft) has no date yet, so neither may print a time.
   */
  function scheduleLine(c) {
    const cadence = c.cadence || 'one_off';
    if (cadence === 'one_off') return 'Runs once each time you start it.';
    const repeats = cadence === 'daily' ? 'daily' : 'weekly';
    if (!c.scheduleEnabled) return `Repeats ${repeats} once started.`;
    const t = Date.parse(c.nextRunAt || '');
    if (!t) return `Repeats ${repeats}.`;
    if (t <= Date.now()) return `Repeats ${repeats} — next run due, starting within the hour.`;
    return `Repeats ${repeats}. Next run ${whenLabel(t)}.`;
  }

  /** "today at 08:00" / "tomorrow at 08:00" / "Fri 15 Aug at 08:00", in the reader's timezone. */
  function whenLabel(t) {
    const d = new Date(t);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return `today at ${time}`;
    if (d.toDateString() === new Date(today.getTime() + 86400000).toDateString()) return `tomorrow at ${time}`;
    return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}`;
  }

  /**
   * What this campaign has found — the latest run and the running total, stated separately.
   *
   * ⚠️ This card used to print the cumulative total as a bare "15 leads found", which reads as
   * the result of the run you just watched finish. It is not. `leads_found` counts only the
   * domains a run actually INSERTED, and the candidate insert ignores conflicts on
   * (campaign_id, domain) — so re-running a campaign that re-finds the same companies banks
   * nothing and the total sits unchanged. A user who ran a search again and saw the same "15"
   * had no way to tell "it found fifteen more" from "it found none".
   *
   * The total is only worth saying when it differs from the latest run, otherwise a first run
   * would read "15 this run · 15 in total" and invite the reader to look for a distinction that
   * isn't there yet.
   */
  function leadCountLine(c) {
    const total = Number(c.leadsFound || 0);
    const latest = Number(c.latestRunLeadsFound || 0);
    const noun = (n) => `${n} lead${n === 1 ? '' : 's'}`;
    if (!total) return 'No leads found yet.';
    if (latest === total) return `${noun(total)} found.`;
    if (!latest) return `No new leads on the last run — ${noun(total)} found in total.`;
    return `${noun(latest)} on the last run · ${noun(total)} in total.`;
  }

  /**
   * ── Did this run see the market, or a corner of it? ───────────────────────
   *
   * ⚠️ This is the honesty fix. Before it, a run that read 9 of its 15 searches before hitting a
   * lead cap reported EXACTLY the same as one that worked its whole plan: a lead count and nothing
   * else. So 175 leads out of ~4,500 South East schools presented itself as a finished search, and
   * nothing on screen invited the reader to doubt it. Silent under-delivery dressed as a result is
   * worse than a small number honestly labelled.
   *
   * Two independent facts, and they must not be conflated:
   *   • Did we finish OUR PLAN?     — stopReason
   *   • Is there more OUT THERE?    — the newness rate (new domains / everything we looked at)
   *
   * A run can finish its plan and still have barely scratched the market, which is exactly the
   * schools case. Saying only "completed" there would be true and still misleading.
   *
   * Returns null when there is nothing honest to say — no run yet, or a run that predates this
   * being recorded. An absent line is better than a confident guess about a run we did not measure.
   */
  function coverageLine(c) {
    const reason = c.latestRunStopReason;
    if (!reason) return null;

    const run = Number(c.latestRunQueriesRun ?? 0);
    const planned = Number(c.latestRunQueriesPlanned ?? 0);
    const seen = Number(c.latestRunResolved ?? 0);
    const fresh = Number(c.latestRunNewDomains ?? 0);

    // "Every company it looked at was one it had never seen" — the signal that the market is far
    // from exhausted. Gated on a meaningful sample: 2 of 2 proves nothing.
    const mostlyNew = seen >= 10 && fresh / seen >= 0.8;

    const CAPPED = {
      lead_cap:   'it hit the lead limit for this search',
      search_cap: 'it hit the search limit for this run',
      cost_cap:   'it reached this run\'s cost budget',
      token_cap:  'it reached this run\'s processing budget',
      month_cap:  'this campaign has used its monthly lead allowance',
    };

    if (CAPPED[reason]) {
      const progress = planned && run < planned ? ` after ${run} of ${planned} searches` : '';
      const more = reason === 'month_cap'
        // A monthly allowance is not a per-run knob: re-running today changes nothing, so do not
        // send the reader off to raise a per-run limit that was never what stopped them.
        ? ' Running it again now will not find more — the allowance resets next month.'
        : ' There were more results still to read, so this is a sample rather than the whole market.';
      return `Stopped early${progress} — ${CAPPED[reason]}.${more}`;
    }

    // plan_complete: we worked every query we were given. That is a fact about our plan, and on its
    // own it does NOT mean the market is exhausted.
    if (mostlyNew) {
      return `Worked through all ${planned || run} searches, and nearly every company found was a new one. `
        + 'That usually means there are many more out there than these searches can reach — try narrowing '
        + 'to one area at a time, or importing a list if an official register exists for this market.';
    }
    return `Worked through all ${planned || run} searches. Most results were companies already on this list, `
      + 'which suggests these searches have found what they can.';
  }

  function body() { return state.overlay?.querySelector('[data-dc-body]'); }
  function setBody(html) { const b = body(); if (b) b.innerHTML = html; }

  // ── Views ─────────────────────────────────────────────────────────────────

  function form() {
    return `
      <div class="border border-gray-200 rounded-xl p-4">
        <p class="font-bold text-gray-900">Describe who you want to find</p>
        <p class="text-xs text-gray-500 mt-0.5 mb-3">A plain-English hypothesis. The Lead Generation Assistant turns it into web searches, then scores what it finds.</p>
        <textarea data-dc-idea rows="3" class="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm"
          placeholder="e.g. Boutique hotels in Southern Europe that don't have a modern online booking app"></textarea>

        <!-- Optional short label. The hypothesis above is a paragraph; the Signal Inbox needs
             something chip-sized to filter by. Left blank, readers fall back to a truncated idea. -->
        <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1 mt-3">Name this search <span class="font-normal normal-case text-gray-400">(optional)</span></label>
        <input data-dc-name type="text" maxlength="80" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm"
          placeholder="e.g. UK retreat venues">

        <div class="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">How often</label>
            <select data-dc-cadence class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">
              <option value="one_off">Run once now</option>
              <option value="daily">Daily at 08:00 UTC</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Max leads / run</label>
            <input data-dc-maxleads type="number" min="1" value="50" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">
          </div>
        </div>

        <div class="mt-3">
          <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Exclude (comma-sep)</label>
          <input data-dc-negatives type="text" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm" placeholder="competitor.com, acme">
        </div>

        <label class="flex items-center gap-2 mt-3 text-sm text-gray-700">
          <input data-dc-approval type="checkbox" checked class="rounded border-gray-300 text-emerald-700 focus:ring-emerald-700">
          Review found leads before any outreach (recommended)
        </label>

        <div class="flex items-center gap-2 mt-4">
          <button type="button" data-dc-create class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Start finding leads</button>
          <span class="hidden text-xs font-semibold text-red-600" data-dc-error></span>
        </div>
      </div>`;
  }

  function campaignCard(c) {
    const running = c.latestJobStatus === 'queued' || c.latestJobStatus === 'processing';
    // A sliced run rests at status='queued' between slices — one search query per slice, then the
    // row goes back to 'queued' and waits for the next pass — so printing the raw status labelled a
    // campaign that was mid-run and already filing leads as "queued". `stage` is NULL only until the
    // first slice claims the job, which makes it the honest "has this started" test. Kept in step
    // with searchState() in assistant-signal-inbox.js: the two surfaces show the same search.
    const inFlight = c.latestJobStatus === 'processing' || (c.latestJobStatus === 'queued' && !!c.latestJobStage);
    const chip = (inFlight ? STATUS_CHIP.processing : STATUS_CHIP[c.latestJobStatus]) || 'bg-gray-50 text-gray-500 border-gray-200';
    const paused = c.status === 'paused';
    // A draft is a search the assistant proposed in chat and the user approved, which has never
    // run and is spending nothing. It reads as "no runs yet" otherwise — indistinguishable from a
    // live campaign that simply hasn't fired, which is the difference the user needs to see.
    // Reuses the amber chip classes already compiled into style.css (no Tailwind rebuild).
    const draft = c.status === 'draft' && !c.latestJobStatus;
    // ⚠️ `draft` above additionally requires NO run history, which is right for the "never
    // started" label and wrong for the button. A campaign whose targeting was edited is put back
    // to draft while keeping its old jobs, and keying the button on `draft` left it showing
    // "Run now" — i.e. the brief was unreachable for any campaign that had ever run, which is
    // most of them. Status alone decides whether a plan still needs reading.
    const needsBrief = c.status === 'draft';
    const statusLabel = draft ? 'draft — not started'
      : inFlight ? 'searching'
        : needsBrief ? 'plan needs review'
          : c.latestJobStatus ? esc(c.latestJobStatus) : 'no runs yet';
    const ghost = 'px-2.5 py-1 bg-white border border-gray-200 text-gray-600 hover:border-gray-300 text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed';
    // Primary action: Cancel while a run is in flight, else Run now (blocked while paused).
    // A draft says "Review & start" and is emphasised: it is the ONLY thing standing between an
    // approved proposal and any leads, and it opens the BRIEF rather than starting a run, because
    // a draft is by definition a search plan nobody has read yet. Approving it is also what
    // activates a recurring cadence server-side (discovery-campaigns.ts approve_brief).
    const primaryBtn = running
      ? `<button type="button" data-dc-cancel="${c.id}" class="px-3 py-1.5 bg-white border border-gray-200 text-red-600 hover:border-red-300 hover:bg-red-50 text-xs font-bold rounded-lg transition">Cancel run</button>`
      : needsBrief
        ? `<button type="button" data-dc-brief="${c.id}" class="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition">Review &amp; start</button>`
        : `<button type="button" data-dc-run="${c.id}" class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed" ${paused ? 'disabled title="Resume this campaign to run it"' : ''}>Run now</button>`;
    return `
      <div class="border border-gray-200 rounded-xl p-4 ${paused ? 'opacity-70' : ''}" data-campaign="${c.id}" data-dc-idea-val="${esc(c.idea)}"
           data-dc-name-val="${esc(c.name || '')}"
           data-dc-maxleads-val="${esc(c.maxLeadsPerRun ?? 50)}"
           data-dc-negatives-val="${esc(Array.isArray(c.negativeKeywords) ? c.negativeKeywords.join(', ') : '')}"
           data-dc-domains-val="${esc(Array.isArray(c.excludedDomains) ? c.excludedDomains.join(', ') : '')}"
           data-dc-approval-val="${c.requireHumanApproval === false ? '0' : '1'}">
        <div class="flex items-start justify-between gap-3">
          <p class="font-semibold text-gray-900 text-sm min-w-0">${esc(c.name || c.idea)}</p>
          <span class="shrink-0 text-xs font-bold px-2 py-0.5 rounded-full border ${paused ? 'bg-gray-100 text-gray-500 border-gray-200' : draft ? STATUS_CHIP.queued : chip}">${paused ? 'paused' : statusLabel}</span>
        </div>
        ${c.name ? `<p class="text-xs text-gray-500 mt-0.5">${esc(c.idea)}</p>` : ''}
        <p class="text-xs text-gray-500 mt-1">${leadCountLine(c)}</p>
        ${coverageLine(c) ? `<p class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-1.5">${esc(coverageLine(c))}</p>` : ''}
        <p class="text-xs text-gray-400 mt-0.5">${paused ? 'Paused — it will not run until you resume it.' : esc(scheduleLine(c))}</p>
        <div class="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-gray-100">
          ${primaryBtn}
          ${running || needsBrief ? '' : `<button type="button" data-dc-brief="${c.id}" class="${ghost}">Review plan</button>`}
          <button type="button" data-dc-view="${c.id}" class="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 hover:border-gray-300 text-xs font-bold rounded-lg transition">View leads</button>
          <button type="button" data-dc-edit="${c.id}" class="${ghost}">Edit</button>
          <button type="button" data-dc-toggle="${c.id}" data-paused="${paused ? '1' : '0'}" class="${ghost}">${paused ? 'Resume' : 'Pause'}</button>
          <button type="button" data-dc-archive="${c.id}" class="${ghost} text-gray-400 hover:text-red-600 hover:border-red-300 ml-auto">Archive</button>
          <span class="hidden text-xs font-semibold text-red-600 w-full" data-dc-cerror></span>
        </div>
        <div data-dc-leads></div>
      </div>`;
  }

  function render(campaigns) {
    const warn = state.searchConfigured ? '' : `
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs font-semibold text-amber-800">
        No web search provider is connected yet — campaigns will run but find nothing until one is set up.
      </div>`;
    const list = campaigns.length
      ? `<div class="space-y-3">${campaigns.map(campaignCard).join('')}</div>`
      : `<p class="text-sm text-gray-400 text-center py-4">No campaigns yet — describe your first one above.</p>`;
    setBody(`<div class="space-y-4">${warn}${form()}<div><p class="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Your campaigns</p>${list}</div></div>`);
    wire();
  }

  function leadRow(l) {
    const chip = ratingChip(l.rating);
    const via = l.discoveredVia ? `<span class="text-gray-400"> · ${esc(l.discoveredVia.replace(/_/g, ' '))}</span>` : '';
    return `
      <li class="py-2">
        <div class="flex items-center gap-2">
          <span class="text-xs font-bold px-2 py-0.5 rounded-full border shrink-0 ${chip}">${l.score == null ? '—' : esc(l.score) + '/100'}</span>
          <span class="font-semibold text-gray-900 text-sm truncate">${esc(l.companyName)}</span>
        </div>
        <p class="text-xs text-gray-500 mt-0.5">${esc(l.domain || '')}${via}</p>
      </li>`;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function refresh() {
    setBody('<p class="text-sm text-gray-400 py-8 text-center">Loading…</p>');
    try {
      const { campaigns, searchConfigured } = await call('list');
      state.searchConfigured = searchConfigured !== false;
      render(campaigns || []);
    } catch (err) {
      setBody(`<div class="bg-red-50 border border-red-200 rounded-xl p-4 text-sm font-semibold text-red-700">${esc(err.message)}</div>`);
    }
  }

  async function create(btn) {
    const root = body();
    const idea = root.querySelector('[data-dc-idea]')?.value.trim();
    const errEl = root.querySelector('[data-dc-error]');
    if (errEl) errEl.classList.add('hidden');
    if (!idea) { if (errEl) { errEl.textContent = 'Describe who you want to find first.'; errEl.classList.remove('hidden'); } return; }

    const negatives = (root.querySelector('[data-dc-negatives]')?.value || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const payload = {
      idea,
      name: (root.querySelector('[data-dc-name]')?.value || '').trim() || undefined,
      cadence: root.querySelector('[data-dc-cadence]')?.value || 'one_off',
      guardrails: {
        maxLeadsPerRun: Number(root.querySelector('[data-dc-maxleads]')?.value) || undefined,
        negativeKeywords: negatives.length ? negatives : undefined,
        requireHumanApproval: !!root.querySelector('[data-dc-approval]')?.checked,
      },
    };
    // Phase 0: the form no longer starts a search. It saves the campaign as a DRAFT — spending
    // nothing — and goes to the brief, where the user reads the actual web searches before any
    // money is committed. `asDraft` is what stops createDiscoveryRun enqueuing a job here.
    btn.disabled = true; btn.textContent = 'Drafting the plan…';
    try {
      // fromForm distinguishes this from a chat proposal: the server dedupes repeat chat
      // approvals by idea, and must NOT do that to a deliberate form submission.
      const data = await call('create', { ...payload, asDraft: true, fromForm: true });
      state.searchConfigured = data.searchConfigured !== false;
      if (!state.searchConfigured) {
        window.showToast?.('Campaign saved. Connect a web search provider to start finding leads.');
        await refresh();
        return;
      }
      await openBrief(data.campaignId);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Start finding leads';
      if (errEl) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
    }
  }

  // ── The brief: what this search will actually do, before it does it ──────────
  //
  // ⚠️ This exists because a prod run spent its entire budget on `site:linkedin.com/jobs`,
  // `site:trustpilot.com OR site:g2.com` and `best social media agencies UK ... directories`.
  // Every result was discarded or scored cold. The queries were visible nowhere until after the
  // money was gone — they were generated inside the job — so the only feedback channel a user had
  // was rejecting fifteen useless leads afterwards. Reading them takes seconds.
  //
  // Costs nothing extra: the worker skips its own query_gen when the job's cursor is pre-seeded,
  // so approving RELOCATES the Haiku call rather than adding one.

  const STRATEGY_LABELS = {
    niche_scrape: 'How they describe themselves',
    intent_signal: 'Signs they need this',
    footprint: 'What they’re missing',
  };

  /**
   * ── What this plan can reach, said BEFORE the user spends ─────────────────
   *
   * Tier 2 of the coverage work. Tier 1 (coverageLine) tells them after a run that it sampled
   * rather than covered; by then the money is gone and the list looks finished. This is the same
   * fact at the only moment it is still actionable — they are already reading the queries, and
   * "narrow this to one county" is a five-second edit here and a re-run later.
   *
   * ⚠️ Two blocks with deliberately different confidence, and they must not blur together:
   *   • Reach is ARITHMETIC — exact, ours, stated plainly.
   *   • Market advice is ADVISORY — a model's read, may be absent, phrased as something to check.
   * Presenting a guess in the same voice as the arithmetic is how a confident wrong number ships.
   */
  /**
   * ── Offer to work the area piece by piece ─────────────────────────────────
   *
   * The only lever in this whole piece of work that changes the ORDER of the answer rather than a
   * multiple of it. "primary school kent surrey sussex" is one search against ~1,500 schools; one
   * search per county is a question each result set can actually answer.
   *
   * ⚠️ An OFFER, never automatic. Expanding turns a 15-query plan into a 60-query one and moves the
   * binding limit — usually onto the search cap. That has to be something the user sees and accepts
   * on the screen they are already reading, not something that happens to their bill.
   */
  function territoryBlock(brief) {
    const t = brief.territorySplit;
    if (!t || !Array.isArray(t.territories) || t.territories.length < 2) return '';
    if (state.territoriesApplied) {
      return `
        <div class="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
          <p class="text-xs font-bold text-emerald-900">Split across ${esc(String(t.territories.length))} areas</p>
          <p class="text-xs text-emerald-800 mt-1">The broadest search from each angle now runs once per area. Check the reach below — a bigger plan often means a limit cuts it short.</p>
        </div>`;
    }
    return `
      <div class="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
        <p class="text-xs font-bold text-blue-900">This covers ${esc(t.area || 'a large area')}</p>
        <p class="text-xs text-blue-800 mt-1">
          One search for a whole region returns whatever ranks, not whatever matches. Splitting it into
          ${esc(String(t.territories.length))} ${esc(t.basis || 'areas')} asks a question each set of results can actually answer.
        </p>
        <button type="button" data-dc-split class="mt-2 px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white text-xs font-bold rounded-lg transition disabled:opacity-60">
          Split into ${esc(String(t.territories.length))} areas
        </button>
        <span class="hidden ml-2 text-xs font-semibold text-red-600" data-dc-split-error></span>
      </div>`;
  }

  function planReachBlock(brief) {
    const r = brief.planReach;
    if (!r || !r.queries) return '';

    const BINDING = {
      lead_cap:   'your lead limit for a single run',
      search_cap: 'the search limit for a single run',
      month_cap:  'what is left of this campaign\'s monthly lead allowance',
    };
    // Depth is EARNED, never planned, so reach is a range. Quoting only the floor understates it
    // fourfold; quoting only the ceiling promises depth a saturated market never buys.
    const deep = Number(r.searchesIfAllProductive || 0) > Number(r.searchesThatWillRun || 0);
    const limitLine = BINDING[r.bindingLimit]
      ? `It will stop at ${esc(String(r.maxLeadsBanked))} lead${r.maxLeadsBanked === 1 ? '' : 's'} — that is ${esc(BINDING[r.bindingLimit])}.`
      : 'No limit will cut this run short.';

    return `
      <div class="mt-4 pt-3 border-t border-gray-100">
        <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">What this plan can reach</p>
        <p class="text-xs text-gray-600 mt-1">
          ${esc(String(r.searchesThatWillRun))} search${r.searchesThatWillRun === 1 ? '' : 'es'} to start,
          reading <span class="font-semibold">${esc(String(r.maxResultsRead))} web results</span>.
          ${deep ? `Searches that keep turning up new companies go deeper on their own, up to ${esc(String(r.searchesIfAllProductive))} searches and ${esc(String(r.maxResultsReadIfAllProductive))} results. ` : ''}${esc(limitLine)}
        </p>
        <p class="text-xs text-gray-500 mt-1">A search that starts repeating itself stops early rather than paying to re-read the same companies${deep ? '' : ''} — so a market much larger than this is sampled, not covered.</p>
      </div>`;
  }

  /**
   * The advisory half — is this a market you can LIST, or only one you can SAMPLE?
   *
   * ⚠️ Renders NOTHING unless the assessment came back and said "enumerable". A "not enumerable"
   * verdict needs no words: sampling is the right tool and the plan above is the right plan. Only
   * the enumerable case changes what the user should do, and only that case earns screen space.
   */
  function marketAdviceBlock(brief) {
    const m = brief.marketAdvice;
    if (!m || !m.enumerable) return '';

    const sector = m.sector ? esc(m.sector) : 'this market';
    // The register name is offered, never asserted — assessMarket() returns null when unsure
    // rather than inventing one, and the copy has to survive that null without reading oddly.
    const register = m.registerName
      ? ` Check whether <span class="font-semibold">${esc(m.registerName)}</span> covers it.`
      : ' It is worth checking whether an official register covers it.';

    return `
      <div class="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
        <p class="text-xs font-bold text-blue-900">There may be a complete list of ${sector}</p>
        <p class="text-xs text-blue-800 mt-1">
          Web searches sample a market; they cannot enumerate one. ${register}
          If it does, importing that list into your Enrichment tab gives you every one of them — and this
          assistant can then score and write to them, which is the part searching cannot replace.
        </p>
      </div>`;
  }

  function briefView(brief) {
    const q = brief.queries || {};
    const groups = ['niche_scrape', 'intent_signal', 'footprint'].map((key) => {
      const list = Array.isArray(q[key]) ? q[key] : [];
      return `
        <div class="mt-3">
          <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">${esc(STRATEGY_LABELS[key])}</p>
          <div data-dc-group="${key}" class="mt-1.5 space-y-1.5">
            ${list.map((query) => queryRow(key, query)).join('')}
          </div>
          <button type="button" data-dc-add="${key}" class="mt-1.5 text-[11px] font-bold text-emerald-700 hover:text-emerald-800 transition cursor-pointer">+ Add a search</button>
        </div>`;
    }).join('');

    const ex = brief.exclusions || {};
    const skipped = Array.isArray(ex.categories) ? ex.categories : [];
    const negatives = Array.isArray(ex.negativeKeywords) ? ex.negativeKeywords : [];

    return `
      <div class="border border-gray-200 rounded-xl p-4">
        <p class="font-bold text-gray-900">Here’s what it will search</p>
        <p class="text-xs text-gray-500 mt-0.5">These are the exact web searches. Edit or remove any that look wrong — each one costs a search, and a bad one fills your Enrichment tab with things you can’t sell to.</p>
        ${groups}

        <div class="mt-4 pt-3 border-t border-gray-100">
          <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">It will skip</p>
          <p class="text-xs text-gray-600 mt-1">${skipped.length ? esc(skipped.join(' · ')) : 'Nothing configured.'}</p>
          ${negatives.length ? `<p class="text-xs text-gray-600 mt-1">Plus anything matching: <span class="font-semibold">${esc(negatives.join(', '))}</span></p>` : ''}
        </div>

        ${territoryBlock(brief)}
        ${planReachBlock(brief)}
        ${marketAdviceBlock(brief)}

        <div class="flex flex-wrap items-center gap-2 mt-4">
          <button type="button" data-dc-approve class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Approve &amp; start searching</button>
          <button type="button" data-dc-regen class="px-3 py-2 bg-white border border-gray-200 text-gray-700 hover:border-gray-300 text-sm font-bold rounded-lg transition disabled:opacity-60">Draft a different plan</button>
          <button type="button" data-dc-brief-cancel class="px-3 py-2 text-sm font-bold text-gray-500 hover:text-gray-700 transition">Later</button>
          <span class="hidden text-xs font-semibold text-red-600 w-full" data-dc-brief-error></span>
        </div>
      </div>`;
  }

  function queryRow(key, query) {
    return `
      <div class="flex items-start gap-2" data-dc-query>
        <input type="text" value="${esc(query)}" data-dc-query-input
          class="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-xs font-mono text-gray-700 focus:ring-2 focus:ring-emerald-700 transition">
        <button type="button" data-dc-remove class="shrink-0 px-2 py-1.5 text-[11px] font-bold text-gray-400 hover:text-red-600 transition cursor-pointer" title="Remove this search">Remove</button>
      </div>`;
  }

  /** Read the (possibly edited) plan back out of the DOM. */
  function collectQueries(root) {
    const out = { niche_scrape: [], intent_signal: [], footprint: [] };
    for (const key of Object.keys(out)) {
      const group = root.querySelector(`[data-dc-group="${key}"]`);
      if (!group) continue;
      out[key] = [...group.querySelectorAll('[data-dc-query-input]')]
        .map((el) => el.value.trim())
        .filter(Boolean);
    }
    return out;
  }

  async function openBrief(campaignId) {
    state.briefCampaignId = campaignId;
    setBody('<p class="text-sm text-gray-400 py-10 text-center">Drafting the search plan…</p>');
    let data;
    try {
      data = await call('generate_brief', { campaignId });
    } catch (err) {
      setBody(`<div class="bg-red-50 border border-red-200 rounded-xl p-4 text-sm font-semibold text-red-700">${esc(err.message)}</div>`);
      return;
    }
    if (data.searchConfigured === false) {
      setBody('<div class="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm font-semibold text-amber-900">Saved. Connect a web search provider to start finding leads.</div>');
      return;
    }
    if (data.failed) {
      setBody(`<div class="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm font-semibold text-amber-900">${esc(data.message || 'Could not draft a search plan.')}</div>`);
      return;
    }
    state.brief = data;
    // Reset with the plan it describes: reopening a brief must not inherit a previous expansion's
    // "already split" banner over a freshly generated, unexpanded plan.
    state.territoriesApplied = false;
    setBody(briefView(data));
    wireBrief();
  }

  /**
   * Expand the on-screen plan across territories.
   *
   * ⚠️ Sends the queries as currently EDITED, not the generated ones — same rule as approveBrief.
   * Expanding a regenerated plan would silently discard whatever the user just typed.
   *
   * The response replaces the plan in place and re-renders. Nothing is saved: approving is still a
   * separate, deliberate act, and "Draft a different plan" still discards the whole thing.
   */
  async function expandTerritories(btn) {
    const b = body();
    const err = b?.querySelector('[data-dc-split-error]');
    if (err) err.classList.add('hidden');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Splitting…';
    try {
      const data = await call('expand_territories', {
        campaignId: state.briefCampaignId,
        queries: collectQueries(b),
      });
      if (!data.expanded) throw new Error('There is no clear way to split this area up.');
      // Carry the untouched halves forward: the server returns the new plan and its reach, but the
      // exclusions and market advice belong to the brief and have not changed.
      state.brief = { ...state.brief, queries: data.queries, planReach: data.planReach, territorySplit: data.territorySplit };
      state.territoriesApplied = true;
      setBody(briefView(state.brief));
      wireBrief();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = label;
      if (err) { err.textContent = e.message || 'Could not split that area.'; err.classList.remove('hidden'); }
    }
  }

  function wireBrief() {
    const b = body();
    if (!b) return;
    b.querySelector('[data-dc-approve]')?.addEventListener('click', (e) => approveBrief(e.currentTarget));
    b.querySelector('[data-dc-regen]')?.addEventListener('click', () => openBrief(state.briefCampaignId));
    b.querySelector('[data-dc-split]')?.addEventListener('click', (e) => expandTerritories(e.currentTarget));
    b.querySelector('[data-dc-brief-cancel]')?.addEventListener('click', () => refresh());
    b.querySelectorAll('[data-dc-remove]').forEach((el) => {
      el.addEventListener('click', () => el.closest('[data-dc-query]')?.remove());
    });
    b.querySelectorAll('[data-dc-add]').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.getAttribute('data-dc-add');
        const group = b.querySelector(`[data-dc-group="${key}"]`);
        if (!group) return;
        group.insertAdjacentHTML('beforeend', queryRow(key, ''));
        const rows = group.querySelectorAll('[data-dc-query-input]');
        rows[rows.length - 1]?.focus();
        group.querySelectorAll('[data-dc-remove]').forEach((r) => {
          if (r.dataset.dcWired) return;
          r.dataset.dcWired = '1';
          r.addEventListener('click', () => r.closest('[data-dc-query]')?.remove());
        });
      });
    });
  }

  async function approveBrief(btn) {
    const root = body();
    const errEl = root.querySelector('[data-dc-brief-error]');
    if (errEl) errEl.classList.add('hidden');
    const queries = collectQueries(root);
    const total = queries.niche_scrape.length + queries.intent_signal.length + queries.footprint.length;
    if (!total) {
      if (errEl) { errEl.textContent = 'Keep at least one search, or this campaign has nothing to run.'; errEl.classList.remove('hidden'); }
      return;
    }
    btn.disabled = true; btn.textContent = 'Starting…';
    try {
      const data = await call('approve_brief', {
        campaignId: state.briefCampaignId,
        queries,
        persona: state.brief?.persona ?? null,
        exclusions: state.brief?.exclusions ?? null,
      });
      window.showToast?.(data.alreadyRunning
        ? 'A run is already in progress.'
        : `Approved — running ${data.queryCount} search${data.queryCount === 1 ? '' : 'es'}. Leads appear in your Enrichment tab as they’re found.`);
      window._leadIdeasDidAddLeads = true;
      await refresh();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Approve & start searching';
      if (errEl) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
    }
  }

  async function runNow(btn) {
    const id = Number(btn.getAttribute('data-dc-run'));
    btn.disabled = true; btn.textContent = 'Running…';
    try {
      const data = await call('run_now', { campaignId: id });
      window.showToast?.(data.alreadyRunning ? 'A run is already in progress.' : 'Run started.');
      await refresh();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Run now';
      const e = btn.parentElement?.querySelector('[data-dc-cerror]');
      if (e) { e.textContent = err.message; e.classList.remove('hidden'); }
    }
  }

  async function viewLeads(btn) {
    const id = Number(btn.getAttribute('data-dc-view'));
    const container = btn.closest('[data-campaign]')?.querySelector('[data-dc-leads]');
    if (!container) return;
    container.innerHTML = '<p class="text-xs text-gray-400 py-2">Loading leads…</p>';
    try {
      const { leads } = await call('list_leads', { campaignId: id });
      container.innerHTML = (leads && leads.length)
        ? `<ul class="divide-y divide-gray-100 mt-2 pt-2 border-t border-gray-100">${leads.map(leadRow).join('')}</ul>`
        : '<p class="text-xs text-gray-400 py-2">No leads discovered for this campaign yet.</p>';
    } catch (err) {
      container.innerHTML = `<p class="text-xs text-red-600 py-2">${esc(err.message)}</p>`;
    }
  }

  function cardErr(el, msg) {
    const e = el.closest('[data-campaign]')?.querySelector('[data-dc-cerror]');
    if (e) { e.textContent = msg; e.classList.remove('hidden'); }
  }

  async function cancelRun(btn) {
    const id = Number(btn.getAttribute('data-dc-cancel'));
    btn.disabled = true; btn.textContent = 'Cancelling…';
    try {
      const data = await call('cancel_run', { campaignId: id });
      window.showToast?.(data.cancelled ? 'Run cancelled.' : 'No active run to cancel.');
      await refresh();
    } catch (err) { btn.disabled = false; btn.textContent = 'Cancel run'; cardErr(btn, err.message); }
  }

  async function togglePause(btn) {
    const id = Number(btn.getAttribute('data-dc-toggle'));
    const paused = btn.getAttribute('data-paused') === '1';
    btn.disabled = true;
    try {
      await call(paused ? 'resume' : 'pause', { campaignId: id });
      window.showToast?.(paused ? 'Campaign resumed.' : 'Campaign paused.');
      await refresh();
    } catch (err) { btn.disabled = false; cardErr(btn, err.message); }
  }

  async function archiveCampaign(btn) {
    const id = Number(btn.getAttribute('data-dc-archive'));
    if (!window.confirm('Archive this campaign? It stops running and leaves this list. Leads already found stay in your Leads tab.')) return;
    btn.disabled = true;
    try {
      await call('archive', { campaignId: id });
      window.showToast?.('Campaign archived.');
      await refresh();
    } catch (err) { btn.disabled = false; cardErr(btn, err.message); }
  }

  /**
   * Edit an existing campaign's idea + guardrails.
   *
   * `values` is a plain snapshot rather than a DOM node so the SAME modal serves both callers: the
   * campaign card in here (which has the values as data-* attributes already) and the Searches tab
   * (which fetches them with `get`). Two edit forms over one table is how the two surfaces would
   * drift apart — one growing a field the other silently clears.
   *
   * `onSaved` lets the caller re-read its own list; this component refreshes itself when the card
   * is the caller and does nothing when it is not on screen.
   */
  function openEditModal(values, id, onSaved) {
    if (!values) return;
    const g = (a, d) => (values[a] ?? d);
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100">
          <h3 class="text-lg font-bold text-gray-900">Edit campaign</h3>
          <button type="button" data-edit-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer">&times;</button>
        </div>
        <div class="p-5 space-y-3">
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Name this search <span class="font-normal normal-case text-gray-400">(optional)</span></label>
            <input data-edit-name type="text" maxlength="80" value="${esc(g('name', ''))}" placeholder="e.g. UK retreat venues" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Who to find</label>
            <textarea data-edit-idea rows="3" class="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">${esc(g('idea', ''))}</textarea>
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Max leads / run</label>
            <input data-edit-maxleads type="number" min="1" value="${esc(g('maxLeadsPerRun', '50'))}" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Exclude words (comma-sep)</label>
            <input data-edit-negatives type="text" value="${esc(g('negativeKeywords', ''))}" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm" placeholder="marketing agency, franchise">
            <p class="text-[11px] text-gray-500 mt-1">Matched against each result's title and description. Keep them specific — a broad word here also drops good results that merely mention it.</p>
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Blocked domains (comma-sep)</label>
            <input data-edit-domains type="text" value="${esc(g('excludedDomains', ''))}" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm" placeholder="competitor.com, acme.co.uk">
            <p class="text-[11px] text-gray-500 mt-1">Exact company websites this search must skip. Domains you block from the review queue appear here — delete one to allow it back.</p>
          </div>
          <label class="flex items-center gap-2 text-sm text-gray-700">
            <input data-edit-approval type="checkbox" ${g('requireHumanApproval', true) === false ? '' : 'checked'} class="rounded border-gray-300 text-emerald-700 focus:ring-emerald-700">
            Review found leads before any outreach (recommended)
          </label>
          <p class="hidden text-xs font-semibold text-red-600" data-edit-error></p>
          <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" data-edit-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 rounded-lg cursor-pointer">Cancel</button>
            <button type="button" data-edit-save class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Save changes</button>
          </div>
        </div>
      </div>`;
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-edit-close]').forEach((b) => b.addEventListener('click', close));
    const saveBtn = overlay.querySelector('[data-edit-save]');
    const errEl = overlay.querySelector('[data-edit-error]');
    saveBtn.addEventListener('click', async () => {
      const idea = overlay.querySelector('[data-edit-idea]').value.trim();
      if (!idea) { errEl.textContent = 'Describe who you want to find.'; errEl.classList.remove('hidden'); return; }
      errEl.classList.add('hidden');
      const negatives = (overlay.querySelector('[data-edit-negatives]').value || '').split(',').map((s) => s.trim()).filter(Boolean);
      // Always sent, like `name` above — an emptied field must be able to CLEAR the list, which is
      // the only way to unblock a domain excluded by one click from the review queue. The server
      // normalises each entry, so a pasted "https://Foo.com/" still matches at run time.
      const domains = (overlay.querySelector('[data-edit-domains]').value || '').split(',').map((s) => s.trim()).filter(Boolean);
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        await call('edit', {
          campaignId: id,
          idea,
          // Always sent, so clearing the field genuinely clears the name (the server treats
          // `undefined` as "leave alone" and an empty string as "revert to the idea fallback").
          name: overlay.querySelector('[data-edit-name]').value.trim(),
          guardrails: {
            maxLeadsPerRun: Number(overlay.querySelector('[data-edit-maxleads]').value) || undefined,
            negativeKeywords: negatives,
            excludedDomains: domains,
            requireHumanApproval: !!overlay.querySelector('[data-edit-approval]').checked,
          },
        });
        window.showToast?.('Search updated.');
        close();
        // Only re-read this component's own list when it is actually on screen — opened from the
        // Searches tab there is no campaign list behind this modal, and refresh() would write
        // "Loading…" into a detached body.
        if (state.overlay) await refresh();
        onSaved?.();
      } catch (err) { saveBtn.disabled = false; saveBtn.textContent = 'Save changes'; errEl.textContent = err.message; errEl.classList.remove('hidden'); }
    });
    document.body.appendChild(overlay);
    overlay.querySelector('[data-edit-idea]')?.focus();
  }

  // ── Managing one search from the Searches tab ────────────────────────────────
  //
  // View / Edit / Schedule / Archive, each opening on its own overlay. They live HERE rather than
  // in assistant-signal-inbox.js because every one of them WRITES to (or reads the full shape of) a
  // discovery campaign, and this component is the single owner of that table's UI. The Searches tab
  // owns the results; this owns the search.

  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /**
   * A standalone modal, independent of the Find New Leads overlay this component also renders.
   * Returns the node and its close function so each caller can wire its own footer.
   */
  function modalShell({ title, subtitle, bodyHtml, maxWidth }) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full ${maxWidth || 'max-w-lg'} max-h-[90vh] flex flex-col">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100 shrink-0">
          <div class="min-w-0">
            <h3 class="text-lg font-bold text-gray-900">${esc(title)}</h3>
            ${subtitle ? `<p class="text-sm text-gray-500 mt-0.5">${esc(subtitle)}</p>` : ''}
          </div>
          <button type="button" data-modal-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer shrink-0">&times;</button>
        </div>
        <div class="p-5 overflow-y-auto" data-modal-body>${bodyHtml}</div>
      </div>`;
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', close));
    document.body.appendChild(overlay);
    return { overlay, close };
  }

  /** A one-line "loading" modal, replaced in place once the fetch lands. */
  function loadingModal(title) {
    return modalShell({ title, bodyHtml: '<p class="text-sm text-gray-400 py-8 text-center">Loading…</p>' });
  }

  async function fetchCampaign(campaignId) {
    const { campaign } = await call('get', { campaignId });
    return campaign;
  }

  /** UTC hour → the same instant in the reader's own clock, e.g. "09:00". */
  function localHourLabel(utcHour) {
    const d = new Date();
    d.setUTCHours(utcHour, 0, 0, 0);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** "08:00 UTC", spelled out, so the stored value is never a mystery. */
  function utcHourLabel(utcHour) {
    return `${String(utcHour).padStart(2, '0')}:00 UTC`;
  }

  /**
   * The schedule as a sentence, for the read-only view.
   *
   * ⚠️ Says what the DISPATCHER does, not what the row wishes. A schedule can be perfectly well
   * configured and still never fire — a draft has never been started and a paused search is meant
   * not to run — and a modal that printed "Repeats weekly on Monday" for either would be describing
   * an intention as a fact.
   */
  function scheduleSummary(c) {
    const cadence = c.cadence || 'one_off';
    if (cadence === 'one_off') return 'Runs once each time you start it. Nothing is scheduled.';
    const days = Array.isArray(c.daysOfWeek) && c.daysOfWeek.length
      ? c.daysOfWeek.map((d) => DAY_FULL[d]).join(', ')
      : null;
    const when = cadence === 'daily'
      ? `every day at ${localHourLabel(c.runAtHourUtc)} (${utcHourLabel(c.runAtHourUtc)})`
      : `every week on ${days || 'the same day it was started'} at ${localHourLabel(c.runAtHourUtc)} (${utcHourLabel(c.runAtHourUtc)})`;
    if (!c.scheduleEnabled) {
      const why = c.status === 'draft'
        ? 'It has not been started yet, so nothing is scheduled.'
        : c.status === 'paused'
          ? 'It is paused, so nothing is scheduled.'
          : 'The schedule is switched off, so nothing is scheduled.';
      return `Set to run ${when}. ${why}`;
    }
    const t = Date.parse(c.nextRunAt || '');
    if (!t) return `Runs ${when}.`;
    if (t <= Date.now()) return `Runs ${when}. The next run is due and starts within the hour.`;
    return `Runs ${when}. Next run ${whenLabel(t)}.`;
  }

  function queryListHtml(c) {
    const q = c.approvedQueries;
    const total = q ? q.niche_scrape.length + q.intent_signal.length + q.footprint.length : 0;
    if (!total) {
      return `<p class="text-xs text-gray-500">No search plan has been approved yet. Press <span class="font-semibold">Review plan</span> under Find New Leads to draft one — until then this search has nothing to run.</p>`;
    }
    return ['niche_scrape', 'intent_signal', 'footprint'].map((key) => {
      const list = q[key] || [];
      if (!list.length) return '';
      return `
        <div class="mt-2">
          <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wide">${esc(STRATEGY_LABELS[key])}</p>
          <ul class="mt-1 space-y-1">
            ${list.map((s) => `<li class="text-xs font-mono text-gray-700 bg-gray-50 border border-gray-100 rounded px-2 py-1 break-words">${esc(s)}</li>`).join('')}
          </ul>
        </div>`;
    }).join('');
  }

  function section(label, html) {
    return `
      <div class="border border-gray-200 rounded-xl p-4">
        <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">${esc(label)}</p>
        <div class="mt-1.5">${html}</div>
      </div>`;
  }

  /** Read-only: everything this search IS, with no control that changes it. */
  function viewBody(c) {
    const listOr = (arr, none) => (Array.isArray(arr) && arr.length
      ? `<p class="text-xs text-gray-700">${esc(arr.join(', '))}</p>`
      : `<p class="text-xs text-gray-400">${esc(none)}</p>`);
    const created = c.createdAt ? new Date(c.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    return `
      <div class="space-y-3">
        ${section('Who it looks for', `<p class="text-sm text-gray-800 whitespace-pre-wrap">${esc(c.idea)}</p>`)}
        ${section('What it searches for', queryListHtml(c))}
        ${section('What it skips', `
          <p class="text-xs text-gray-600">${esc(c.skippedCategories.join(' · '))}</p>
          <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wide mt-2">Excluded words</p>
          ${listOr(c.negativeKeywords, 'None')}
          <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wide mt-2">Blocked websites</p>
          ${listOr(c.excludedDomains, 'None')}`)}
        ${section('When it runs', `
          <p class="text-xs text-gray-700">${esc(scheduleSummary(c))}</p>
          <p class="text-xs text-gray-500 mt-1">${esc(c.requireHumanApproval
            ? 'Companies it finds wait for your approval before any outreach.'
            : 'Companies it finds are approved automatically — no review step before outreach.')}</p>
          <p class="text-xs text-gray-500 mt-1">Up to ${esc(c.maxLeadsPerRun)} companies per run.</p>`)}
        ${section('What it has found', `
          <p class="text-xs text-gray-700">${esc(leadCountLine(c))}</p>
          ${coverageLine(c) ? `<p class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-1.5">${esc(coverageLine(c))}</p>` : ''}
          <p class="text-xs text-gray-500 mt-1">${esc(c.runCount === 0
            ? 'It has not finished a run yet.'
            : `${c.runCount} run${c.runCount === 1 ? '' : 's'} finished. Created ${created}.`)}</p>`)}
      </div>`;
  }

  /**
   * View — deliberately has no Save, no Start and no Edit. It is the answer to "what did I set this
   * search up to do", and a read-only surface that quietly grows write controls stops being one.
   */
  async function openView(campaignId) {
    const { overlay, close } = loadingModal('Search details');
    try {
      const c = await fetchCampaign(campaignId);
      const b = overlay.querySelector('[data-modal-body]');
      overlay.querySelector('h3').textContent = c.name || 'Search details';
      if (b) b.innerHTML = viewBody(c);
    } catch (err) {
      const b = overlay.querySelector('[data-modal-body]');
      if (b) b.innerHTML = `<p class="text-sm font-semibold text-red-700">${esc(err.message)}</p>`;
    }
    return close;
  }

  function hourOptions(selected) {
    return Array.from({ length: 24 }, (_, h) => `
      <option value="${h}" ${h === selected ? 'selected' : ''}>${esc(localHourLabel(h))} — ${esc(utcHourLabel(h))}</option>`).join('');
  }

  function scheduleBody(c) {
    const cadence = c.cadence || 'one_off';
    const days = Array.isArray(c.daysOfWeek) && c.daysOfWeek.length ? c.daysOfWeek : [1];
    // Why a chosen schedule still will not fire. Stated up front rather than after saving: a user
    // who sets a draft to run weekly and is told "Saved" has been told the wrong thing.
    const blocked = c.status === 'draft'
      ? 'This search has not been started yet. Save a schedule now if you like — it begins repeating once you press Start search.'
      : c.status === 'paused'
        ? 'This search is paused, so nothing will run until you resume it under Find New Leads.'
        : null;
    return `
      <div class="space-y-3">
        ${blocked ? `<div class="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs font-semibold text-amber-800">${esc(blocked)}</div>` : ''}
        <div>
          <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">How often</label>
          <select data-sched-cadence class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">
            <option value="one_off" ${cadence === 'one_off' ? 'selected' : ''}>Only when I start it</option>
            <option value="daily" ${cadence === 'daily' ? 'selected' : ''}>Every day</option>
            <option value="weekly" ${cadence === 'weekly' ? 'selected' : ''}>Every week</option>
          </select>
        </div>

        <div data-sched-days-wrap class="${cadence === 'weekly' ? '' : 'hidden'}">
          <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Which days</label>
          <div class="flex flex-wrap gap-1.5">
            ${DAY_LABELS.map((label, i) => `
              <label class="cursor-pointer">
                <input type="checkbox" data-sched-day="${i}" ${days.includes(i) ? 'checked' : ''} class="peer sr-only">
                <span class="inline-block px-2.5 py-1 text-xs font-bold rounded-lg border bg-white text-gray-600 border-gray-200 peer-checked:bg-emerald-700 peer-checked:text-white peer-checked:border-emerald-600 transition">${esc(label)}</span>
              </label>`).join('')}
          </div>
          <p class="text-[11px] text-gray-500 mt-1">Each chosen day is a separate run, and each run costs searches.</p>
        </div>

        <div data-sched-time-wrap class="${cadence === 'one_off' ? 'hidden' : ''}">
          <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">What time</label>
          <select data-sched-hour class="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 transition shadow-sm">
            ${hourOptions(Number(c.runAtHourUtc ?? 8))}
          </select>
          <p class="text-[11px] text-gray-500 mt-1">Times are shown in your own timezone first, then as they are stored. Runs are picked up on the hour, so a search starts within the hour of its time.</p>
        </div>

        <label data-sched-enabled-wrap class="flex items-center gap-2 text-sm text-gray-700 ${cadence === 'one_off' ? 'hidden' : ''}">
          <input data-sched-enabled type="checkbox" ${c.scheduleEnabled === false && c.status === 'active' ? '' : 'checked'} class="rounded border-gray-300 text-emerald-700 focus:ring-emerald-700">
          Keep this schedule switched on
        </label>

        <p class="text-xs text-gray-500" data-sched-preview></p>
        <p class="hidden text-xs font-semibold text-red-600" data-sched-error></p>
        <div class="flex items-center justify-end gap-2 pt-1">
          <button type="button" data-modal-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 rounded-lg cursor-pointer">Cancel</button>
          <button type="button" data-sched-save class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Save schedule</button>
        </div>
      </div>`;
  }

  /** Schedule — the only surface that can change a saved search's cadence after it is created. */
  async function openSchedule(campaignId, onSaved) {
    const { overlay, close } = loadingModal('Schedule this search');
    let c;
    try {
      c = await fetchCampaign(campaignId);
    } catch (err) {
      const b = overlay.querySelector('[data-modal-body]');
      if (b) b.innerHTML = `<p class="text-sm font-semibold text-red-700">${esc(err.message)}</p>`;
      return;
    }
    const b = overlay.querySelector('[data-modal-body]');
    if (!b) return;
    b.innerHTML = scheduleBody(c);
    overlay.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', close));

    const cadenceEl = b.querySelector('[data-sched-cadence]');
    const daysWrap = b.querySelector('[data-sched-days-wrap]');
    const timeWrap = b.querySelector('[data-sched-time-wrap]');
    const enabledWrap = b.querySelector('[data-sched-enabled-wrap]');
    const preview = b.querySelector('[data-sched-preview]');
    const errEl = b.querySelector('[data-sched-error]');
    const saveBtn = b.querySelector('[data-sched-save]');

    const readDays = () => [...b.querySelectorAll('[data-sched-day]')]
      .filter((el) => el.checked).map((el) => Number(el.getAttribute('data-sched-day')));

    // Says what the choice means before it is made — "every week on Tue" is a different commitment
    // from "every day", and the difference is the search budget.
    const sync = () => {
      const cad = cadenceEl.value;
      daysWrap.classList.toggle('hidden', cad !== 'weekly');
      timeWrap.classList.toggle('hidden', cad === 'one_off');
      enabledWrap.classList.toggle('hidden', cad === 'one_off');
      const hour = Number(b.querySelector('[data-sched-hour]').value);
      const days = readDays();
      preview.textContent = cad === 'one_off'
        ? 'It will only run when you press Start search.'
        : cad === 'daily'
          ? `It will run once a day at ${localHourLabel(hour)} — about 7 runs a week.`
          : days.length
            ? `It will run on ${days.map((d) => DAY_FULL[d]).join(', ')} at ${localHourLabel(hour)} — ${days.length} run${days.length === 1 ? '' : 's'} a week.`
            : 'Pick at least one day.';
    };
    cadenceEl.addEventListener('change', sync);
    b.querySelector('[data-sched-hour]').addEventListener('change', sync);
    b.querySelectorAll('[data-sched-day]').forEach((el) => el.addEventListener('change', sync));
    sync();

    saveBtn.addEventListener('click', async () => {
      const cadence = cadenceEl.value;
      const days = readDays();
      errEl.classList.add('hidden');
      if (cadence === 'weekly' && !days.length) {
        errEl.textContent = 'Pick at least one day of the week.';
        errEl.classList.remove('hidden');
        return;
      }
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        const res = await call('schedule', {
          campaignId,
          cadence,
          daysOfWeek: days,
          runAtHourUtc: Number(b.querySelector('[data-sched-hour]').value),
          // The reader's own zone, stored for display. The dispatcher works in UTC — see
          // src/utils/discovery-schedule.ts — so this never changes when a run fires.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          enabled: !!b.querySelector('[data-sched-enabled]')?.checked,
        });
        // Report what will actually happen, not "Saved". `blockedBy` is the server telling us the
        // cadence was stored but nothing will fire, which is the one outcome a bare success toast
        // would hide.
        window.showToast?.(res.blockedBy === 'draft'
          ? 'Schedule saved. It starts repeating once you start the search.'
          : res.blockedBy === 'paused'
            ? 'Schedule saved. It stays paused until you resume the search.'
            : res.nextRunAt
              ? `Schedule saved — next run ${whenLabel(Date.parse(res.nextRunAt))}.`
              : 'Schedule saved.', 'success');
        close();
        if (state.overlay) await refresh();
        onSaved?.();
      } catch (err) {
        saveBtn.disabled = false; saveBtn.textContent = 'Save schedule';
        errEl.textContent = err.message; errEl.classList.remove('hidden');
      }
    });
  }

  /** Edit, opened from anywhere: fetch the current values first rather than trusting a stale card. */
  async function openEdit(campaignId, onSaved) {
    let c;
    try {
      c = await fetchCampaign(campaignId);
    } catch (err) {
      window.showToast?.(err.message || 'Could not open that search.', 'error');
      return;
    }
    openEditModal({
      name: c.name || '',
      idea: c.idea,
      maxLeadsPerRun: c.maxLeadsPerRun,
      negativeKeywords: (c.negativeKeywords || []).join(', '),
      excludedDomains: (c.excludedDomains || []).join(', '),
      requireHumanApproval: c.requireHumanApproval !== false,
    }, campaignId, onSaved);
  }

  /**
   * Archive, from anywhere. The confirm names what SURVIVES as well as what stops — archiving a
   * search does not retract the companies it already found, and a user who thinks it might will
   * keep a dead search on their list forever rather than risk it.
   */
  async function archive(campaignId, onDone) {
    const msg = 'It stops running and leaves your Searches list. Companies it already found stay in your Leads tab.';
    const ok = window.confirmModal
      ? await window.confirmModal(msg, { title: 'Archive this search?', confirmLabel: 'Archive' })
      : window.confirm(`Archive this search? ${msg}`);
    if (!ok) return;
    try {
      await call('archive', { campaignId });
      window.showToast?.('Search archived.', 'success');
      if (state.overlay) await refresh();
      onDone?.();
    } catch (err) {
      window.showToast?.(err.message || 'Could not archive that search.', 'error');
    }
  }

  function wire() {
    const b = body();
    if (!b) return;
    b.querySelector('[data-dc-create]')?.addEventListener('click', (e) => create(e.currentTarget));
    b.querySelectorAll('[data-dc-run]').forEach((el) => el.addEventListener('click', () => runNow(el)));
    // A draft has never been read by anyone — send it to the brief rather than starting it blind.
    b.querySelectorAll('[data-dc-brief]').forEach((el) => el.addEventListener('click', () => openBrief(Number(el.getAttribute('data-dc-brief')))));
    b.querySelectorAll('[data-dc-view]').forEach((el) => el.addEventListener('click', () => viewLeads(el)));
    b.querySelectorAll('[data-dc-cancel]').forEach((el) => el.addEventListener('click', () => cancelRun(el)));
    b.querySelectorAll('[data-dc-toggle]').forEach((el) => el.addEventListener('click', () => togglePause(el)));
    b.querySelectorAll('[data-dc-archive]').forEach((el) => el.addEventListener('click', () => archiveCampaign(el)));
    b.querySelectorAll('[data-dc-edit]').forEach((el) => el.addEventListener('click', () => {
      const card = el.closest('[data-campaign]');
      if (!card) return;
      const attr = (a) => card.getAttribute(a) ?? '';
      openEditModal({
        name: attr('data-dc-name-val'),
        idea: attr('data-dc-idea-val'),
        maxLeadsPerRun: attr('data-dc-maxleads-val') || '50',
        negativeKeywords: attr('data-dc-negatives-val'),
        excludedDomains: attr('data-dc-domains-val'),
        requireHumanApproval: attr('data-dc-approval-val') !== '0',
      }, Number(el.getAttribute('data-dc-edit')));
    }));
  }

  function open() {
    if (!state.assistantId) return;
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100 shrink-0">
          <div>
            <h3 class="text-lg font-bold text-gray-900">${esc(state.cfg?.title || 'Find New Leads')}</h3>
            <p class="text-sm text-gray-500 mt-0.5">Describe who you want to reach — the Lead Generator searches the web, scores what it finds, and files leads for your approval.</p>
          </div>
          <button type="button" data-dc-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer">&times;</button>
        </div>
        <div class="p-5 overflow-y-auto" data-dc-body></div>
      </div>`;
    const close = () => {
      overlay.remove();
      state.overlay = null;
      // Always re-read the Signal Inbox, not just when a campaign was CREATED: starting, pausing,
      // archiving or renaming a search all change what that tab says about it, and none of them
      // set the flag below. A user who started their draft in here and closed the modal was left
      // staring at "Not started". One cheap request beats a surface that lies.
      window.AssistantSignalInbox?.refresh?.();
      if (window._leadIdeasDidAddLeads) {
        window._leadIdeasDidAddLeads = false;
        window.AssistantDataHub?.init?.({
          hub: window.AssistantDashboardRegistry?.get('lead_qualifier')?.hubTab,
          assistantId: state.assistantId,
        });
      }
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-dc-close]').addEventListener('click', close);
    document.body.appendChild(overlay);
    state.overlay = overlay;
    refresh();
  }

  // Callers own their own trigger — this only loads state. The old #btn-discovery-campaigns
  // wiring lived here until that button was removed from the Leads tab; the Signal Inbox toolbar
  // is now the single entry point and binds its own click (assistant-signal-inbox.js).
  // Idempotent: safe to call on every open.
  function init({ assistantId, cfg }) {
    if (!assistantId) return;
    state.assistantId = assistantId;
    state.cfg = cfg || null;
  }

  // open() is the Find New Leads modal. The four below are per-search management, called from the
  // Searches tab (assistant-signal-inbox.js) — each takes an optional callback so that tab can
  // re-read itself, since it renders the same searches from a different endpoint.
  window.AssistantDiscoveryCampaigns = { init, open, openView, openEdit, openSchedule, archive };
})();
