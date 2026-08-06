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
