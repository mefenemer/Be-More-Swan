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

    // Source chips. The saved-search chip is ALWAYS present; social only when that feed exists.
    const searchChips = state.savedSearches.map((s) => `
      <button type="button" data-si-search="${s.id}"
        class="px-2.5 py-1 text-xs font-bold rounded-lg border transition ${state.savedSearchId === s.id ? 'bg-emerald-700 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}">${esc(s.label)}</button>`).join('');

    const empty = state.signals.length === 0;

    return `
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        ${[['Signals', c.total], ['Ready to approve', c.ready], ['Need review', c.needsReview], ['Filtered', c.filtered]]
          .map(([label, n]) => `
          <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
            <p class="text-2xl font-bold text-gray-900">${n}</p>
            <p class="text-xs text-gray-500 mt-0.5">${label}</p>
          </div>`).join('')}
      </div>

      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm">
        <div class="p-4 border-b border-gray-100 flex flex-wrap items-center gap-2">
          <button type="button" data-si-search="" class="px-2.5 py-1 text-xs font-bold rounded-lg border transition ${state.savedSearchId === null ? 'bg-emerald-700 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}">All</button>
          ${searchChips}
          <label class="ml-auto flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input type="checkbox" data-si-filtered ${state.showFiltered ? 'checked' : ''} class="cursor-pointer">
            Show filtered (${c.filtered})
          </label>
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

        ${empty
          ? `<div class="p-8 text-center">
               <p class="text-sm font-semibold text-gray-900">No signals yet</p>
               <p class="text-xs text-gray-500 mt-1">Create a saved search and your assistant will start filling this inbox.</p>
               <button type="button" data-si-new-search
                 class="mt-3 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition">Find New Leads</button>
             </div>`
          : state.signals.map(row).join('')}

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
    h.querySelector('[data-si-approve]')?.addEventListener('click', (e) => approve(e.currentTarget));
    h.querySelector('[data-si-more]')?.addEventListener('click', () => load({ append: true }));
    // Two of these can be on screen at once (toolbar + empty state), so bind them as a set.
    h.querySelectorAll('[data-si-new-search]').forEach((b) => b.addEventListener('click', openNewSearch));
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
      state.hasSocialFeed = !!data.hasSocialFeed;
      state.sourceLabel = data.sourceLabel || state.sourceLabel;
      state.nextCursor = data.nextCursor || null;
      if (!append) state.selected = new Set();
    } catch (err) {
      // The columns arrive with db/signal-inbox-1a.sql, a MANUAL apply. Say so plainly rather than
      // showing a generic failure the user can do nothing with.
      state.error = err.code === 'MIGRATION_PENDING'
        ? 'The Signal Inbox is not set up on this environment yet.'
        : (err.message || 'Could not load your signals.');
    } finally {
      state.loading = false;
      updateBadge();
      render();
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

  /** Amber count on the tab button — the same affordance the Review Queue uses. */
  function updateBadge() {
    const el = document.getElementById('signals-ready-badge');
    if (!el) return;
    const n = state.counts.ready + state.counts.needsReview;
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('hidden', n === 0);
    // `hidden` loses to a class that sets display, so pin it directly too.
    el.style.display = n === 0 ? 'none' : '';
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  window.AssistantSignalInbox = {
    init({ assistantId }) {
      state.assistantId = assistantId;
      state.rendered = false;
      // Counts drive the tab badge, so fetch once on init even though the panel is lazy.
      load();
    },
    /** Called on first activation of the tab. Cheap if init() already loaded. */
    activate() {
      if (state.rendered) return;
      state.rendered = true;
      render();
    },
    refresh: load,
  };
})();
