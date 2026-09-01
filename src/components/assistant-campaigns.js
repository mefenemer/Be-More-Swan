/**
 * src/components/assistant-campaigns.js
 * Campaigns tab + Budget & Control strip — Phase 1 of docs/campaign-orchestrator-plan.md §3.2–3.3.
 *
 * One row per campaign, and the two controls that must never be more than one glance away: how
 * much of the month's capacity is committed, and how to stop everything.
 *
 * Backed by netlify/functions/campaigns.ts:
 *   • list     → POST campaigns { action:'list', assistantId }        → { campaigns, planGate }
 *   • start    → POST campaigns { action:'start', campaignId }
 *   • pause    → POST campaigns { action:'pause', campaignId, reason }
 *   • stop_all → POST campaigns { action:'stop_all', assistantId }
 *
 * ── Saying what is happening ─────────────────────────────────────────────────
 * Copied deliberately from assistant-signal-inbox.js, whose lesson was learned the expensive way:
 * a list that does not say what it is DOING reads as broken. A campaign saved from chat is a DRAFT
 * — nothing commissioned, nothing spent — and looks identical to a running campaign that has
 * achieved nothing unless the row says so outright. So every row carries a state chip from a closed
 * vocabulary and one plain sentence about what it is waiting for.
 *
 * "Throttled" and "Paused (guardrail)" are kept distinct on purpose: one is the agent optimising,
 * the other is the agent stopping. Conflating them is connection-status-vocabulary-drift.
 *
 * ── Every pause needs a resume ───────────────────────────────────────────────
 * "Stop everything" is the largest button here, and the last build shipped its equivalent with no
 * route back — posts and assistants sat paused for weeks and nobody noticed. So a stopped campaign
 * renders a NAMED resume on the row that stopped it, and the strip states how to undo the halt.
 *
 * ── What this tab may not do ─────────────────────────────────────────────────
 * Starting is the only spend-committing write on this screen, and it is always a human click with
 * the number visible. Nothing here starts a campaign automatically, on load, or as a side effect of
 * any other action.
 *
 * Styling reuses classes already compiled into style.css (no rebuild — see the Tailwind drift note
 * in the project conventions). All server values are escaped on render; treat them as untrusted.
 */
(function () {
  const API = '/.netlify/functions/campaigns';

  const state = {
    assistantId: null,
    cfg: null,
    /** Server rows. Never mutated in place — a failed write must not leave a lying row on screen. */
    campaigns: [],
    planGate: null,
    loaded: false,
    loadError: null,
    rendered: false,
    busy: false,
    /** get-campaign-funnel payload. Null until it arrives; a failure renders no panel, not zeroes. */
    funnel: null,
    funnelError: null,
    /** Per campaign: { open, loaded, rows, error }. Lazily loaded — most campaigns have no links. */
    links: {},
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /** Shared vocabulary, generated from src/config/campaign-vocab.ts. Never hand-copied. */
  const C = () => window.CampaignConstants;

  // ── State chips ────────────────────────────────────────────────────────────
  // The closed vocabulary from the plan. `status` alone cannot express the two kinds of pause, so
  // haltedBy is read as well: the server sets it only when a human pressed the button.
  function chipFor(c) {
    const base = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold border';
    if (c.status === 'paused') {
      return c.haltedBy
        ? { cls: `${base} bg-gray-50 text-gray-600 border-gray-200`, label: 'Paused (you)' }
        // Not the user's doing. Styled amber rather than grey because this one needs looking at:
        // the agent stopped itself and the campaign is going nowhere until someone decides.
        : { cls: `${base} bg-amber-50 text-amber-800 border-amber-200`, label: 'Paused (guardrail)' };
    }
    const MAP = {
      draft: `${base} bg-gray-50 text-gray-600 border-gray-200`,
      active: `${base} bg-emerald-50 text-emerald-800 border-emerald-200`,
      throttled: `${base} bg-amber-50 text-amber-800 border-amber-200`,
      finished: `${base} bg-indigo-50 text-indigo-700 border-indigo-200`,
      archived: `${base} bg-gray-50 text-gray-500 border-gray-200`,
    };
    return {
      cls: MAP[c.status] || `${base} bg-gray-50 text-gray-600 border-gray-200`,
      label: C() ? C().statusLabel(c.status) : c.status,
    };
  }

  /**
   * The one sentence that stops a row reading as broken.
   *
   * Every branch describes a state the user can act on, and none of them invents progress. A draft
   * says it has done nothing precisely BECAUSE it has done nothing — that is the fact the Searches
   * tab had to learn to state out loud.
   */
  function activityLine(c) {
    const o = c.orders || { open: 0, inReview: 0, delivered: 0 };
    if (c.status === 'draft') return 'Not started — nothing has been commissioned and no work has been done yet.';
    if (c.status === 'paused') {
      return c.haltReason
        ? `Stopped: ${c.haltReason}. Queued work was cancelled; anything already delivered is untouched.`
        : 'Stopped. Queued work was cancelled; anything already delivered is untouched.';
    }
    if (c.status === 'finished') {
      return o.delivered
        ? `Finished. ${o.delivered} ${o.delivered === 1 ? 'brief' : 'briefs'} came back with work.`
        : 'Finished without any work coming back.';
    }
    if (o.inReview) return `Waiting on you — ${o.inReview} ${o.inReview === 1 ? 'piece' : 'pieces'} of work ${o.inReview === 1 ? 'is' : 'are'} in a review queue.`;
    if (o.open) return `Running — ${o.open} ${o.open === 1 ? 'brief is' : 'briefs are'} with your other assistants.`;
    if (c.status === 'throttled') return 'Throttled — it has stopped commissioning new work while it waits for results from what it already sent.';
    return 'Running, but nothing is currently commissioned. It will brief your assistants as it decides what to do next.';
  }

  // ── Burn bar ───────────────────────────────────────────────────────────────
  // Tasks only. There is no money bar and there must not be one: Phase 1 campaigns are organic, a
  // "£0 / £0" bar states a budget that does not exist, and a pound sign on this screen reads as a
  // price whatever we meant by it (discovery-spend-cap-is-operator-only).
  function burnBar(c) {
    const cap = Number(c.maxWorkItems) || 0;
    const spent = Number(c.spentWork) || 0;
    const committed = Number(c.committedWork) || 0;
    if (!cap) return '';
    const pct = Math.min(100, Math.round((spent / cap) * 100));
    // Committed-but-unspent is drawn as a lighter segment. It matters: work that is with another
    // assistant is already claimed even though the ledger has not charged it, and a bar that
    // ignored it would tell the user they have room they do not have.
    const pctCommitted = Math.min(100 - pct, Math.round((committed / cap) * 100));
    const tone = pct >= 90 ? 'bg-amber-500' : 'bg-emerald-600';
    return `
      <div class="mt-3">
        <div class="flex items-center justify-between mb-1">
          <span class="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Task budget</span>
          <span class="text-[11px] font-semibold text-gray-600">${esc(String(spent))} of ${esc(String(cap))} used${committed ? ` · ${esc(String(committed))} committed` : ''}</span>
        </div>
        <div class="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden flex">
          <div class="${tone} h-full" style="width:${pct}%"></div>
          <div class="bg-emerald-200 h-full" style="width:${pctCommitted}%"></div>
        </div>
      </div>`;
  }

  function outcomeLine(c) {
    const label = C() ? C().outcomeLabel(c.outcomeMetric) : c.outcomeMetric;
    return c.targetValue
      ? `${esc(label)} — aiming for ${esc(String(c.targetValue))}`
      : esc(label);
  }

  // ── Rows ───────────────────────────────────────────────────────────────────
  function campaignRow(c) {
    const chip = chipFor(c);
    // Start is offered for a draft OR a pause, matching the server's own guard. A paused campaign
    // offering no way back is the bug connection-pause-needs-a-resume is named after, so the label
    // says which of the two this is rather than showing a bare "Start" on a campaign that ran once.
    const canStart = c.status === 'draft' || c.status === 'paused';
    const canPause = c.status === 'active' || c.status === 'throttled';
    return `
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-5" data-cmp-row="${esc(String(c.id))}">
        <div class="flex items-start justify-between gap-4 mb-2">
          <div class="min-w-0">
            <p class="font-bold text-gray-900 break-words">${esc(c.objective)}</p>
            <p class="text-xs text-gray-500 mt-0.5">${outcomeLine(c)}</p>
          </div>
          <span class="${chip.cls} shrink-0">${esc(chip.label)}</span>
        </div>

        <p class="text-xs text-gray-600 leading-relaxed">${esc(activityLine(c))}</p>
        ${burnBar(c)}

        <div class="flex items-center gap-2 mt-4">
          ${canStart ? `
            <button type="button" data-cmp-start="${esc(String(c.id))}"
              class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
              ${c.status === 'paused' ? 'Resume' : 'Start'}
            </button>` : ''}
          ${canPause ? `
            <button type="button" data-cmp-pause="${esc(String(c.id))}"
              class="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 text-xs font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
              Pause
            </button>` : ''}
        </div>
        <p class="hidden mt-2 text-xs font-semibold text-gray-600" data-cmp-status="${esc(String(c.id))}"></p>

        <button type="button" data-cmp-toggle-links="${esc(String(c.id))}"
          class="mt-3 text-xs font-bold text-gray-500 hover:text-gray-700 underline transition">
          ${state.links[c.id] && state.links[c.id].open ? 'Hide' : 'Tracked links'}
        </button>
        ${linksPanel(c.id)}
      </div>`;
  }

  /**
   * The empty state is DERIVED, not fixed.
   *
   * "It never got as far as looking" and "it looked and found nothing" are different facts and only
   * one of them means widen it. The Searches tab shipped a single empty state that told users to
   * create the thing they had just created; this is that lesson applied.
   */
  function emptyState() {
    return `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
        <p class="text-sm font-bold text-gray-700">No campaigns yet</p>
        <p class="text-xs text-gray-500 mt-2 max-w-md mx-auto leading-relaxed">
          A campaign turns one objective into briefs for your other assistants. Tell this assistant
          what you are trying to achieve and it will propose a plan — you approve it, and nothing
          starts until you press Start here.
        </p>
      </div>`;
  }

  function neverLaunchedNote(list) {
    // A workspace whose every campaign is a draft has approved plans and started none of them.
    // That is a specific, fixable situation and it deserves naming rather than leaving the user to
    // wonder why an approved campaign has produced nothing.
    if (!list.length || list.some((c) => c.status !== 'draft')) return '';
    return `
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
        <p class="text-xs text-amber-900 leading-relaxed">
          <span class="font-bold">Nothing has started yet.</span>
          ${list.length === 1 ? 'This campaign is' : 'These campaigns are'} saved but not running —
          no briefs have gone out and no work has been done. Press Start when you are ready.
        </p>
      </div>`;
  }

  // ── Budget & Control strip ─────────────────────────────────────────────────
  // Rendered outside this tab, above the tab bar, so it is visible wherever the user is. Two blocks
  // only: capacity, and the kill switch. No money block — see the file header.
  function renderStrip() {
    const host = document.getElementById('campaign-control-strip');
    if (!host) return;
    if (!state.loaded) { host.classList.add('hidden'); return; }
    host.classList.remove('hidden');

    const gate = state.planGate || {};
    const live = state.campaigns.filter((c) => c.status === 'active' || c.status === 'throttled');
    const committed = state.campaigns.reduce((n, c) => n + (Number(c.committedWork) || 0), 0);

    // `remaining` is null on an unmetered plan. Rendering "null left" or silently substituting a
    // number would both be worse than saying what is true.
    const capacity = gate.noPlan
      ? 'No active plan, so your assistants cannot take on campaign work.'
      : gate.limit == null
        ? `${esc(String(gate.used ?? 0))} tasks used this month. Your plan has no monthly limit.`
        : `${esc(String(gate.used ?? 0))} of ${esc(String(gate.limit))} tasks used this month · ${esc(String(gate.remaining ?? 0))} left`;

    host.innerHTML = `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 flex flex-wrap items-center justify-between gap-4">
        <div class="min-w-0">
          <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Capacity — your plan</p>
          <p class="text-sm font-bold text-gray-900 mt-0.5">${capacity}</p>
          <p class="text-xs text-gray-500 mt-1">
            ${committed ? `${esc(String(committed))} committed to campaigns. ` : ''}At the cap it stops. It never bills you extra.
          </p>
        </div>
        <div class="flex items-center gap-3">
          ${live.length ? `
            <p class="text-xs text-gray-500">${esc(String(live.length))} running</p>
            <button type="button" data-cmp-stop-all
              class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
              Stop everything
            </button>`
            // Never a disabled button. There is nothing running, and a greyed-out kill switch reads
            // as "this is broken" rather than "there is nothing to stop".
            : '<p class="text-xs text-gray-400">No campaigns running.</p>'}
        </div>
      </div>
      ${live.length ? '' : `
        <p class="text-[11px] text-gray-400 mt-2">
          Stopped a campaign? It stays in your list with a Resume button — stopping is never permanent.
        </p>`}
    `;
  }

  // ── The funnel ─────────────────────────────────────────────────────────────
  // Fed by get-campaign-funnel; the arithmetic is src/utils/campaign-funnel.ts. This renderer's
  // whole job is to not undo the honesty that module builds in:
  //
  //   • `value: null` means NOT KNOWABLE and must render as the server's own `display` string
  //     ("Not tracked", "—"). Coercing it with `|| 0` would turn "we cannot see revenue for this
  //     kind of conversion" into "this campaign earned nothing" — the exact lie the null exists
  //     to prevent, reintroduced in the last three characters of the pipeline.
  //   • The attribution caveat is rendered VERBATIM and is never hidden when it is inconvenient.
  //   • `unavailable` is shown as a plain line. An empty surface must say why it is empty.
  function funnelStage(s, isLast) {
    const known = s.value !== null && s.value !== undefined;
    return `
      <div class="flex-1 min-w-0">
        <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wide">${esc(s.label)}</p>
        <p class="text-xl font-bold ${known ? 'text-gray-900' : 'text-gray-400'} mt-0.5 truncate">${esc(s.display)}</p>
        <p class="text-xs text-gray-500 mt-1 leading-relaxed">${esc(s.note)}</p>
      </div>
      ${isLast ? '' : '<div class="text-gray-300 font-bold shrink-0 px-1">&rarr;</div>'}`;
  }

  /** A 0–1 rate as a percentage, or an em dash. NEVER "0%" for a rate we could not compute. */
  function pct(v) {
    return (v === null || v === undefined) ? '—' : `${(v * 100).toFixed(v < 0.01 && v > 0 ? 2 : 1)}%`;
  }

  function funnelHtml() {
    // No campaigns, a load failure, or a funnel that has never had data: render NOTHING. The tab's
    // own empty state already explains the situation, and a row of dashes above it would read as a
    // broken panel rather than an unstarted campaign.
    //
    // ⚠️ Returns a string rather than writing to a host element. render() owns the whole tab's
    // innerHTML, so a renderer that looked up its own host would depend on render() having already
    // run — and would silently no-op on the first paint, which is the one that matters.
    if (state.funnelError || !state.funnel || !state.funnel.hasData) return '';

    const f = state.funnel;
    const r = f.rates || {};
    const a = f.attribution || {};
    const stages = (f.stages || []).map((s, i, arr) => funnelStage(s, i === arr.length - 1)).join('');

    // Rates are only worth showing once there is something to divide by. Four dashes in a row is
    // noise, not information.
    const rateBits = [
      r.clickToConversion != null ? `${pct(r.clickToConversion)} of clicks convert` : '',
      r.conversionToWon != null ? `${pct(r.conversionToWon)} of tracked leads win` : '',
      // ⚠️ The £ is not decoration. "50.00 per conversion" next to "3.2 work items each" reads as
      // two counts of the same kind of thing, and this is the one figure on the page denominated
      // in real money.
      r.costPerConversion != null ? `£${esc(String(r.costPerConversion.toFixed(2)))} per conversion` : '',
      r.effortPerConversion != null ? `${esc(String(Math.round(r.effortPerConversion * 10) / 10))} work items each` : '',
    ].filter(Boolean);

    return `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-4">
        <div class="flex items-center justify-between gap-4 mb-4">
          <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wide">What the work turned into</p>
          <p class="text-xs text-gray-400">All time</p>
        </div>

        <div class="flex items-start gap-3 overflow-x-auto">${stages}</div>

        ${rateBits.length ? `
          <p class="text-xs text-gray-600 mt-4 pt-4 border-t border-gray-100">${rateBits.map(esc).join(' · ')}</p>` : ''}

        ${a.caveat ? `
          <p class="text-xs text-gray-500 mt-3 leading-relaxed">${esc(a.caveat)}</p>` : ''}

        ${(f.unavailable || []).length ? `
          <div class="mt-3 pt-3 border-t border-gray-100">
            <p class="text-[11px] font-bold text-gray-400 uppercase tracking-wide mb-1">Not shown yet</p>
            ${f.unavailable.map((u) => `
              <p class="text-xs text-gray-500 leading-relaxed">
                <span class="font-bold text-gray-600">${esc(u.label)}</span> — ${esc(u.reason)}
              </p>`).join('')}
          </div>` : ''}
      </div>`;
  }

  // ── Tracked links ──────────────────────────────────────────────────────────
  // Per campaign, collapsed by default: most campaigns have none, and an always-open empty panel
  // on every row buries the campaign list itself.
  //
  // ⚠️ The destination is validated SERVER-side (campaigns.ts → isSafeDestination). The check here
  // is only to give a faster answer — never treat it as the guard. A link on our own domain that
  // forwards anywhere is an open redirector, and a client-side check holds for exactly as long as
  // nobody opens devtools.
  function linkRow(l) {
    const url = l.url || '';
    const archived = !!l.archivedAt;
    return `
      <div class="flex items-start justify-between gap-3 py-2 border-b border-gray-100">
        <div class="min-w-0 flex-1">
          <p class="text-xs font-bold text-gray-900 truncate">${esc(l.label || l.destinationUrl)}</p>
          <p class="text-[11px] text-gray-500 font-mono truncate mt-0.5">${esc(url || '(link unavailable)')}</p>
          <p class="text-[11px] text-gray-500 mt-1">
            <span class="font-bold text-gray-700">${esc(String(l.clicks ?? 0))}</span> clicks ·
            <span class="font-bold text-gray-700">${esc(String(l.conversions ?? 0))}</span> conversions
            ${l.botClicks ? ` · ${esc(String(l.botClicks))} automated (excluded)` : ''}
            ${l.medium && l.medium !== 'organic' ? ` · ${esc(l.medium)}${l.network ? ` (${esc(l.network)})` : ''}` : ''}
            ${archived ? ' · <span class="font-bold">archived</span>' : ''}
          </p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          ${url && !archived ? `
            <button type="button" data-cmp-copy="${esc(url)}"
              class="px-2 py-1 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 text-[11px] font-bold rounded-lg transition">
              Copy
            </button>` : ''}
          ${archived ? '' : `
            <button type="button" data-cmp-archive-link="${esc(String(l.id))}"
              class="px-2 py-1 bg-white border border-gray-300 text-gray-500 hover:bg-gray-50 text-[11px] font-bold rounded-lg transition">
              Archive
            </button>`}
        </div>
      </div>`;
  }

  function linksPanel(campaignId) {
    const st = state.links[campaignId];
    if (!st || !st.open) return '';
    // Generated from src/config/campaign-vocab.ts — never hand-copied ([[client-constants-generated]]).
    // If the constants bundle has not loaded, offer nothing rather than a forked list: an empty
    // picker is obviously broken, a stale one is silently wrong.
    const mediums = (C() && C().linkMediums) || [];

    const body = st.error
      ? `<p class="text-xs text-red-600">${esc(st.error)}</p>`
      : !st.loaded
        ? '<p class="text-xs text-gray-400">Loading links…</p>'
        : st.rows.length
          ? st.rows.map(linkRow).join('')
          // ⚠️ Says what a tracked link IS and what it costs to make one. "No links yet" alone
          // leaves the user with no reason to make the first one.
          : `<p class="text-xs text-gray-500 leading-relaxed">
               No tracked links yet. A tracked link is an ordinary web address that counts who
               clicks it and ties any sign-up back to this campaign. Making one changes nothing
               about the page it points at.
             </p>`;

    return `
      <div class="mt-3 pt-3 border-t border-gray-100" data-cmp-links="${esc(String(campaignId))}">
        <div class="space-y-2">${body}</div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <input type="url" data-cmp-link-url="${esc(String(campaignId))}" placeholder="https://your-site.com/offer"
            class="flex-1 min-w-0 px-3 py-1.5 border border-gray-300 rounded-lg text-xs" />
          <input type="text" data-cmp-link-label="${esc(String(campaignId))}" placeholder="Label (optional)"
            class="px-3 py-1.5 border border-gray-300 rounded-lg text-xs" />
          <select data-cmp-link-medium="${esc(String(campaignId))}"
            class="px-2 py-1.5 border border-gray-300 rounded-lg text-xs">
            ${mediums.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
          </select>
          <input type="text" data-cmp-link-network="${esc(String(campaignId))}" placeholder="Network"
            class="hidden px-3 py-1.5 border border-gray-300 rounded-lg text-xs" style="display:none" />
          <button type="button" data-cmp-add-link="${esc(String(campaignId))}"
            class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
            Create link
          </button>
        </div>
        <p class="hidden mt-2 text-xs font-semibold text-gray-600" data-cmp-link-status="${esc(String(campaignId))}"></p>
      </div>`;
  }

  // ── Tab badge ──────────────────────────────────────────────────────────────
  /** Amber count on the tab button — the same affordance the Review Queue uses. */
  function updateBadge() {
    const el = document.getElementById('campaigns-live-badge');
    if (!el) return;
    const n = state.campaigns.filter((c) => c.status === 'active' || c.status === 'throttled').length;
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('hidden', n === 0);
    // `hidden` loses to a class that sets display (equal specificity, emitted later in style.css),
    // so pin it directly too — otherwise an empty amber dot shows on every load.
    el.style.display = n === 0 ? 'none' : '';
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    const host = document.getElementById('campaigns-host');
    if (!host) return;

    if (state.loadError) {
      host.innerHTML = `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
          <p class="text-sm font-bold text-gray-700">Could not load your campaigns</p>
          <p class="text-xs text-gray-500 mt-2">${esc(state.loadError)}</p>
        </div>`;
      return;
    }
    if (!state.loaded) {
      host.innerHTML = '<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center"><p class="text-sm text-gray-400">Loading campaigns…</p></div>';
      return;
    }
    if (!state.campaigns.length) { host.innerHTML = emptyState(); return; }

    host.innerHTML = `
      ${funnelHtml()}
      ${neverLaunchedNote(state.campaigns)}
      <div class="space-y-4">${state.campaigns.map(campaignRow).join('')}</div>`;
  }

  function rerender() {
    updateBadge();
    renderStrip();
    if (state.rendered) render();
  }

  // ── Server ─────────────────────────────────────────────────────────────────
  async function post(payload) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
    return data;
  }

  async function load() {
    if (!state.assistantId) return;
    try {
      const data = await post({ action: 'list', assistantId: state.assistantId });
      state.campaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
      state.planGate = data.planGate || null;
      state.loadError = null;
    } catch (err) {
      console.error('[AssistantCampaigns] load failed:', err);
      state.loadError = err.message;
    }
    state.loaded = true;
    rerender();
    loadFunnel();
  }

  /**
   * The funnel, fetched separately and deliberately NOT awaited by load().
   *
   * It reads five tables and joins the revenue ledger, so it is the slowest thing on this tab —
   * blocking the campaign list on it would leave the user staring at "Loading campaigns…" while
   * the part they came for was already available. A failure here sets funnelError and renders no
   * panel at all: the campaign list is the feature, the funnel is commentary on it.
   */
  async function loadFunnel() {
    if (!state.assistantId) return;
    try {
      const res = await fetch(`/.netlify/functions/get-campaign-funnel?id=${encodeURIComponent(state.assistantId)}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.funnel = await res.json();
      state.funnelError = null;
    } catch (err) {
      console.error('[AssistantCampaigns] funnel load failed:', err);
      state.funnelError = err.message;
      state.funnel = null;
    }
    if (state.rendered) render();
  }

  /** Load one campaign's tracked links. Lazy: only when the disclosure is opened. */
  async function loadLinks(campaignId) {
    const st = state.links[campaignId];
    if (!st) return;
    try {
      const data = await post({ action: 'list_links', campaignId });
      st.rows = Array.isArray(data.links) ? data.links : [];
      st.error = null;
    } catch (err) {
      st.error = err.message || 'Could not load the links for this campaign.';
      st.rows = [];
    }
    st.loaded = true;
    if (state.rendered) render();
  }

  function say(id, text, tone) {
    const el = document.querySelector(`[data-cmp-status="${id}"]`);
    if (!el) return;
    el.textContent = text;
    el.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-gray-600'}`;
  }

  function setRowBusy(id, busy) {
    document.querySelectorAll(`[data-cmp-start="${id}"], [data-cmp-pause="${id}"]`)
      .forEach((b) => { b.disabled = busy; });
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  // Every one of these RELOADS from the server rather than patching the row locally. A campaign's
  // state after a start is the server's to decide — it can refuse on the plan cap — and a row that
  // optimistically says "Running" while the server said 429 is the assistant lying about a spend.
  document.addEventListener('click', async (e) => {
    const startBtn = e.target.closest('[data-cmp-start]');
    const pauseBtn = e.target.closest('[data-cmp-pause]');
    const stopAll = e.target.closest('[data-cmp-stop-all]');
    if (!startBtn && !pauseBtn && !stopAll) return;
    if (state.busy) return;

    if (stopAll) {
      // Confirmed, because it halts every running campaign at once and cancels queued work. It
      // does NOT unmake delivered work, and saying so here is what makes the confirmation
      // answerable rather than frightening.
      const live = state.campaigns.filter((c) => c.status === 'active' || c.status === 'throttled').length;
      const ok = window.confirm(
        `Stop ${live} running ${live === 1 ? 'campaign' : 'campaigns'}?\n\n`
        + 'Queued work is cancelled and no new briefs go out. Anything already drafted or published '
        + 'stays exactly as it is, and you can resume each campaign afterwards.',
      );
      if (!ok) return;
      state.busy = true;
      stopAll.disabled = true;
      try {
        await post({ action: 'stop_all', assistantId: state.assistantId });
        window.showToast?.('All campaigns stopped. Each one can be resumed from its row.', 'success');
      } catch (err) {
        window.showToast?.(err.message || 'Could not stop the campaigns.', 'error');
      } finally {
        state.busy = false;
        await load();
      }
      return;
    }

    const id = Number(startBtn ? startBtn.dataset.cmpStart : pauseBtn.dataset.cmpPause);
    if (!id) return;
    state.busy = true;
    setRowBusy(id, true);
    say(id, startBtn ? 'Starting…' : 'Pausing…');
    try {
      if (startBtn) {
        await post({ action: 'start', campaignId: id });
      } else {
        await post({ action: 'pause', campaignId: id, reason: 'Paused by you' });
      }
    } catch (err) {
      say(id, err.message || 'That did not work — please try again.', 'error');
      setRowBusy(id, false);
      state.busy = false;
      return;
    }
    state.busy = false;
    await load();
  });

  // ── Tracked-link actions ───────────────────────────────────────────────────
  // A SECOND listener rather than more branches in the one above: that handler early-returns for
  // anything that is not start/pause/stop-all, and threading link actions through it would put the
  // spend-committing controls and a link form in the same busy flag. They are unrelated risks.
  document.addEventListener('click', async (e) => {
    const toggle = e.target.closest('[data-cmp-toggle-links]');
    const addBtn = e.target.closest('[data-cmp-add-link]');
    const archBtn = e.target.closest('[data-cmp-archive-link]');
    const copyBtn = e.target.closest('[data-cmp-copy]');
    if (!toggle && !addBtn && !archBtn && !copyBtn) return;

    if (copyBtn) {
      const url = copyBtn.dataset.cmpCopy || '';
      try {
        await navigator.clipboard.writeText(url);
        window.showToast?.('Link copied.', 'success');
      } catch {
        // Clipboard access is refused outside a secure context and in some embedded browsers.
        // Showing the URL is a worse experience than copying it, and a far better one than a
        // button that appears to do nothing.
        window.prompt('Copy this link:', url);
      }
      return;
    }

    if (toggle) {
      const id = Number(toggle.dataset.cmpToggleLinks);
      if (!id) return;
      const st = state.links[id] || (state.links[id] = { open: false, loaded: false, rows: [], error: null });
      st.open = !st.open;
      if (state.rendered) render();
      // Fetched on first open only. Re-opening shows what we already have rather than re-querying
      // on every toggle.
      if (st.open && !st.loaded) loadLinks(id);
      return;
    }

    if (archBtn) {
      const linkId = Number(archBtn.dataset.cmpArchiveLink);
      if (!linkId) return;
      // Confirmed, and the wording is the point: a tracked link may already be printed in an
      // advert, so "it stops working" is the consequence the user needs stated before they act.
      // It is also honest that the history survives — archiving is not a way to erase results.
      const ok = window.confirm(
        'Archive this link?\n\n'
        + 'It will stop working immediately, so anyone clicking it from an advert or a post already '
        + 'published will be sent to your homepage instead. The clicks and conversions it has '
        + 'already recorded are kept, and stay in your funnel.',
      );
      if (!ok) return;
      archBtn.disabled = true;
      try {
        await post({ action: 'archive_link', linkId });
        // Both the link list and the funnel change, so reload the funnel too — leaving a stale
        // click count above a link that no longer exists is the kind of small disagreement that
        // makes a user distrust every other number on the page.
        for (const cid of Object.keys(state.links)) {
          if (state.links[cid].loaded) { state.links[cid].loaded = false; loadLinks(Number(cid)); }
        }
        loadFunnel();
      } catch (err) {
        window.showToast?.(err.message || 'Could not archive that link.', 'error');
        archBtn.disabled = false;
      }
      return;
    }

    const id = Number(addBtn.dataset.cmpAddLink);
    if (!id) return;
    const urlEl = document.querySelector(`[data-cmp-link-url="${id}"]`);
    const labelEl = document.querySelector(`[data-cmp-link-label="${id}"]`);
    const mediumEl = document.querySelector(`[data-cmp-link-medium="${id}"]`);
    const networkEl = document.querySelector(`[data-cmp-link-network="${id}"]`);
    const destinationUrl = (urlEl?.value || '').trim();
    if (!destinationUrl) { sayLink(id, 'Enter the web address this link should send people to.', 'error'); return; }

    addBtn.disabled = true;
    sayLink(id, 'Creating…');
    try {
      await post({
        action: 'create_link',
        campaignId: id,
        destinationUrl,
        label: (labelEl?.value || '').trim() || undefined,
        medium: mediumEl?.value || undefined,
        network: (networkEl?.value || '').trim() || undefined,
      });
      // Success re-renders, which clears the form — correct, the link is made.
      state.links[id].loaded = false;
      await loadLinks(id);
      loadFunnel();
    } catch (err) {
      // ⚠️ Deliberately does NOT re-render on failure. render() rewrites the whole tab's innerHTML,
      // so it would wipe the address the user just typed and hand them an error plus an empty box
      // to retype into. The server's sentence goes into the status line and the form stays put.
      sayLink(id, err.message || 'Could not create that link.', 'error');
      addBtn.disabled = false;
    }
  });

  /** Status line under one campaign's link form. */
  function sayLink(id, text, tone) {
    const el = document.querySelector(`[data-cmp-link-status="${id}"]`);
    if (!el) return;
    el.textContent = text;
    el.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-gray-600'}`;
    // `hidden` loses to a class that sets display, so pin it directly as well — the same trap the
    // tab badge above documents.
    el.style.display = '';
  }

  // The network box only means anything for a paid link, and the server refuses a paid link
  // without one. Revealed on demand rather than always shown, so the common (organic) case is a
  // three-field form instead of a four-field one.
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-cmp-link-medium]');
    if (!sel) return;
    const id = sel.dataset.cmpLinkMedium;
    const net = document.querySelector(`[data-cmp-link-network="${id}"]`);
    if (!net) return;
    const paid = sel.value === 'paid';
    net.classList.toggle('hidden', !paid);
    net.style.display = paid ? '' : 'none';
  });

  // ── Writes made from outside this tab ──────────────────────────────────────
  /**
   * A campaign created from the chat window (CampaignStrategyProposalCard → chat-session.js) writes
   * straight to campaigns.ts, so this tab has no idea it happened. Without this the user closes the
   * chat onto a Campaigns tab still reading "No campaigns yet" and concludes the assistant did
   * nothing — which is exactly what happened to the Lead Generator (chat-creates-draft-campaigns).
   *
   * Listened for on `document` because the chat modal is mounted at body level, outside this
   * component's host. The assistantId check matters: a workspace can have several assistants and
   * only the one this tab belongs to should reload.
   */
  document.addEventListener('campaign:created', (e) => {
    const id = e.detail && e.detail.assistantId;
    if (!state.assistantId || Number(id) !== Number(state.assistantId)) return;
    load();
  });

  // ── Public API ─────────────────────────────────────────────────────────────
  window.AssistantCampaigns = {
    init({ assistantId, cfg }) {
      state.assistantId = assistantId;
      state.cfg = cfg || null;
      state.rendered = false;
      // Loaded eagerly even though the panel is lazy: the count drives the tab badge and the
      // control strip, and the strip is visible from every tab including the ones that never
      // activate this one.
      load();
    },
    /** Called on first activation of the tab. Cheap if init() already loaded. */
    activate() {
      if (state.rendered) return;
      state.rendered = true;
      render();
    },
  };
})();
