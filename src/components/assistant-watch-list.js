/**
 * src/components/assistant-watch-list.js
 * Watch list tab — the Lead Generator's buying triggers Phase 2 (registry `watchListTab`,
 * docs/buying-triggers-plan.md §5).
 *
 * Companies this assistant watches on Companies House — its leads (with a register match), its
 * customers (leads marked won) and companies added here by hand — and what changed: a new director,
 * a new owner or controller, a new office, a new charge, or the company closing. The wording of each
 * piece of news is fixed by code (src/lib/triggers/ch-watch.ts), never written by a model.
 *
 * Backed by netlify/functions/lead-watch.ts — the same endpoint the chat's watch_action_proposal card
 * calls (chat-session.js onWatchAction), which dispatches `watchlist:changed` so this tab reloads.
 *
 * Vanilla IIFE assigning window.AssistantWatchList. Handlers are bound ONCE to `document` and scoped to
 * the host, never from render(). Every server value is escaped.
 */
(function () {
  const API = '/.netlify/functions/lead-watch';

  const state = {
    assistantId: null,
    assistantName: '',
    view: null,
    loaded: false,
    notSetUp: false,
    error: null,
    filter: 'all',
    busy: null,
    query: '',
    results: null,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const host = () => document.getElementById('watchlist-host');
  const toastOk = (m) => window.showToast?.(m, { icon: '✅' });
  const toastErr = (m) => window.showToast?.(m, { icon: '⚠️' });
  const KIND_LABEL = { customer: 'Customer', lead: 'Lead', manual: 'Added by you' };
  const DIR_CHIP = {
    positive: ['Reason to get in touch', 'bg-green-100 text-green-800'],
    neutral: ['Worth knowing', 'bg-gray-100 text-gray-700'],
    negative: ['Warning', 'bg-red-100 text-red-800'],
  };

  async function call(action, extra) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action, assistantId: state.assistantId, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `That didn’t work (HTTP ${res.status}).`);
    return data;
  }

  async function load() {
    if (!state.assistantId) return;
    try {
      const data = await call('list');
      state.notSetUp = data.setUp === false;
      // Every field defaulted: a partial reply (an older server, a stubbed test) must never throw in
      // render() — this tab loads eagerly on every Lead Generator page, so a throw breaks the page.
      state.view = state.notSetUp ? null : {
        ...data,
        enabled: data.enabled !== false,
        counts: { lead: 0, customer: 0, manual: 0, watching: 0, ...(data.counts || {}) },
        items: Array.isArray(data.items) ? data.items : [],
        signals: Array.isArray(data.signals) ? data.signals : [],
      };
      state.error = null;
    } catch (err) {
      state.error = err.message;
    } finally {
      state.loaded = true;
    }
    setBadge();
    render();
  }

  function setBadge() {
    const b = document.getElementById('watchlist-badge');
    if (!b) return;
    const week = Date.now() - 7 * 86400000;
    const n = (state.view?.signals || []).filter((s) => s.direction !== 'neutral' && Date.parse(s.seenAt) > week).length;
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('hidden', !n);
    b.style.display = n ? '' : 'none';
  }

  function when(iso) {
    const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return '';
    const days = Math.round((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 14) return `${days} days ago`;
    if (days < 60) return `${Math.round(days / 7)} weeks ago`;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function headHtml() {
    const v = state.view;
    const explain = 'News on your customers, your leads and companies you add: from Companies House (a new director, a new owner, a move, new borrowing, or the company closing), and from their own websites (a new senior person, new jobs) and, for US companies, SEC fundraising filings.';
    if (typeof window._tabHead === 'function') {
      return window._tabHead({ title: 'Watch list', emoji: '👀', explain, chip: v ? `${v.counts.watching} watched` : '' });
    }
    return `<div><h2 class="text-lg font-bold text-gray-900">Watch list</h2><p class="text-sm text-gray-600">${esc(explain)}</p></div>`;
  }

  function switchHtml() {
    const v = state.view;
    const busy = state.busy === 'enabled';
    return `
      <div class="bg-white border border-gray-200 rounded-xl p-4" data-no-fold>
        <label class="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" data-wl-enabled class="mt-1 h-4 w-4" ${v.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}>
          <span>
            <span class="block text-sm font-bold text-gray-900">Watch my customers and leads</span>
            <span class="block text-xs text-gray-600 mt-0.5">Checked every few days for free. Leads are watched on Companies House once ${esc(state.assistantName || 'your Lead Generator')} has matched them there, and on their own website (team page, careers page) whenever they have one. A new reason to get in touch becomes the lead’s Why now on All leads. You get one note a day when there is news. Nothing is sent to anyone.</span>
          </span>
        </label>
        ${!v.companiesHouseConfigured ? '<p class="text-xs text-amber-700 mt-2">Companies House isn’t connected on this site yet, so nothing is checked.</p>' : ''}
        ${v.lastRunAt ? `<p class="text-xs text-gray-500 mt-2">Last checked ${esc(when(v.lastRunAt))}.</p>` : ''}
      </div>`;
  }

  function addHtml() {
    const busy = state.busy === 'search' || state.busy === 'add';
    const results = state.results;
    const list = results === null ? '' : results.length === 0
      ? '<p class="text-xs text-gray-600 mt-2">No companies found with that name.</p>'
      : `<ul class="mt-2 divide-y divide-gray-100 border border-gray-100 rounded-lg">${results.map((r) => `
          <li class="flex items-center justify-between gap-3 px-3 py-2">
            <span class="text-sm text-gray-800">${esc(r.name)} <span class="text-xs text-gray-500">${esc(r.number)}${r.postcode ? ` · ${esc(r.postcode)}` : ''}${r.status && r.status !== 'active' ? ` · ${esc(r.status)}` : ''}</span></span>
            <button type="button" data-wl-add="${esc(r.number)}" class="btn-secondary border px-3 py-1 text-xs font-bold rounded-lg" ${busy ? 'disabled' : ''}>Watch</button>
          </li>`).join('')}</ul>`;
    return `
      <div class="bg-white border border-gray-200 rounded-xl p-4" data-no-fold>
        <p class="text-sm font-bold text-gray-900">Add a company</p>
        <p class="text-xs text-gray-600 mt-0.5">A customer or prospect you know about. Type its name or Companies House number.</p>
        <div class="flex gap-2 mt-2">
          <input type="text" id="wl-query" data-wl-query value="${esc(state.query)}" maxlength="120" placeholder="e.g. Acme Signs Ltd or 01234567" class="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <button type="button" data-wl-find class="btn-primary px-4 py-2 text-sm font-bold rounded-lg" ${busy || !state.query.trim() ? 'disabled' : ''}>${busy ? 'Looking…' : 'Find'}</button>
        </div>
        ${list}
      </div>`;
  }

  // Website and SEC news (Why now Phase 2, src/utils/lead-site-watch.ts) carry a `source`; Companies House
  // news does not, and keeps its original link text.
  const SOURCE_LINK = { team_page: 'Open their team page', careers: 'See the job', sec: 'Check on SEC EDGAR', site: 'Open their website', crtsh: 'Open the website' };

  function newsHtml() {
    const signals = state.view.signals || [];
    if (!signals.length) {
      return '<div class="bg-white border border-gray-200 rounded-xl p-4 text-sm text-gray-600" data-no-fold>No news yet. The first check of each company only records where it stands; news is reported from then on.</div>';
    }
    return `
      <div class="bg-white border border-gray-200 rounded-xl p-4" data-no-fold>
        <p class="text-sm font-bold text-gray-900 mb-2">News (last 90 days)</p>
        <ul class="divide-y divide-gray-100">${signals.map((s) => {
          const [label, cls] = DIR_CHIP[s.direction] || DIR_CHIP.neutral;
          return `
            <li class="py-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-bold text-gray-900">${esc(s.companyName || 'A company')}</span>
                <span class="text-xs px-2 py-0.5 rounded-full ${cls}">${label}</span>
                <span class="text-xs text-gray-500">${esc(when(s.occurredOn))}</span>
              </div>
              <p class="text-sm text-gray-700 mt-0.5">${esc(s.text)}</p>
              ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="text-xs text-blue-700 underline">${esc(SOURCE_LINK[s.source] || 'Check on Companies House')}</a>` : ''}
            </li>`;
        }).join('')}</ul>
      </div>`;
  }

  function companiesHtml() {
    const v = state.view;
    const items = v.items.filter((i) => state.filter === 'all' || i.kind === state.filter);
    const chip = (key, label, n) => `<button type="button" data-wl-filter="${key}" class="px-3 py-1 text-xs font-bold rounded-full border ${state.filter === key ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-300'}">${label} (${n})</button>`;
    const rows = items.map((i) => {
      const busy = state.busy === `row:${i.id}`;
      const action = i.kind === 'manual'
        ? `<button type="button" data-wl-remove="${i.id}" class="btn-secondary border px-3 py-1 text-xs font-bold rounded-lg" ${busy ? 'disabled' : ''}>Remove</button>`
        : i.pausedReason === 'removed_by_user'
          ? `<button type="button" data-wl-resume="${i.id}" class="btn-secondary border px-3 py-1 text-xs font-bold rounded-lg" ${busy ? 'disabled' : ''}>Watch again</button>`
          : `<button type="button" data-wl-remove="${i.id}" class="btn-secondary border px-3 py-1 text-xs font-bold rounded-lg" ${busy ? 'disabled' : ''}>Stop watching</button>`;
      return `
        <li class="py-2 flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-bold text-gray-900">${esc(i.companyName || i.chNumber)}</span>
              <span class="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-800">${KIND_LABEL[i.kind] || ''}</span>
              ${i.closing ? `<span class="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800">${esc(i.status)}</span>` : ''}
              ${!i.watching ? '<span class="text-xs text-gray-500">not watching</span>' : ''}
            </div>
            <p class="text-xs text-gray-600 mt-0.5"><a href="${esc(i.url)}" target="_blank" rel="noopener" class="underline">${esc(i.chNumber)}</a>${i.latest ? ` · ${esc(i.latest.text)}` : (i.lastCheckedAt ? ' · no news since we started watching' : ' · first check pending')}</p>
          </div>
          ${action}
        </li>`;
    }).join('');
    return `
      <div class="bg-white border border-gray-200 rounded-xl p-4" data-no-fold>
        <p class="text-sm font-bold text-gray-900 mb-2">Companies watched</p>
        <div class="flex flex-wrap gap-2 mb-2">
          ${chip('all', 'All', v.items.length)}${chip('customer', 'Customers', v.counts.customer)}${chip('lead', 'Leads', v.counts.lead)}${chip('manual', 'Added by you', v.counts.manual)}
        </div>
        ${rows ? `<ul class="divide-y divide-gray-100">${rows}</ul>` : '<p class="text-sm text-gray-600">Nothing here yet. Leads appear once they are matched to Companies House, customers once a lead is marked won.</p>'}
      </div>`;
  }

  function render() {
    const el = host();
    if (!el) return;
    if (!state.loaded) { el.innerHTML = '<p class="text-sm text-gray-600 p-4">Loading the Watch list…</p>'; return; }
    if (state.notSetUp) {
      el.innerHTML = '<div class="bg-white border border-gray-200 rounded-xl p-6 text-sm text-gray-700" data-no-fold>The Watch list isn’t set up on this server yet.</div>';
      return;
    }
    if (!state.view) {
      el.innerHTML = `<p class="text-sm text-red-600 p-4" role="alert">${esc(state.error || 'Could not load the Watch list.')}</p>`;
      return;
    }
    const focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
    el.innerHTML = `
      <div class="space-y-4">
        ${headHtml()}
        ${state.error ? `<p class="text-sm text-red-600" role="alert">${esc(state.error)}</p>` : ''}
        ${switchHtml()}
        ${newsHtml()}
        ${addHtml()}
        ${companiesHtml()}
        <p class="text-xs text-gray-500">From the Companies House register (Crown copyright, Open Government Licence v3.0).</p>
      </div>`;
    if (focused) document.getElementById(focused)?.focus();
  }

  async function withBusy(key, fn) {
    state.busy = key;
    render();
    try { await fn(); } catch (err) { toastErr(err.message); } finally { state.busy = null; render(); }
  }

  function looksLikeNumber(q) { return /^\s*([A-Za-z]{2}\s*\d{1,6}|\d{1,8})\s*$/.test(q); }

  async function find() {
    const q = state.query.trim();
    if (!q) return;
    if (looksLikeNumber(q)) { await add(q); return; }
    await withBusy('search', async () => {
      const r = await call('search', { query: q });
      state.results = Array.isArray(r.items) ? r.items : [];
    });
  }

  async function add(number) {
    await withBusy('add', async () => {
      const r = await call('add', { number });
      toastOk(r.message);
      state.results = null;
      state.query = '';
      await load();
    });
  }

  async function rowAction(action, id) {
    await withBusy(`row:${id}`, async () => {
      const r = await call(action, { id });
      toastOk(r.message);
      await load();
    });
  }

  document.addEventListener('click', (e) => {
    const el = host();
    if (!el || !el.contains(e.target)) return;
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.wlFilter) { state.filter = b.dataset.wlFilter; render(); return; }
    if (b.hasAttribute('data-wl-find')) { find(); return; }
    if (b.dataset.wlAdd) { add(b.dataset.wlAdd); return; }
    if (b.dataset.wlRemove) { rowAction('remove', Number(b.dataset.wlRemove)); return; }
    if (b.dataset.wlResume) { rowAction('resume', Number(b.dataset.wlResume)); }
  });

  document.addEventListener('input', (e) => {
    const el = host();
    if (!el || !el.contains(e.target) || !e.target.matches('[data-wl-query]')) return;
    const had = !!state.query.trim();
    state.query = e.target.value;
    if (had !== !!state.query.trim()) render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches?.('[data-wl-query]') || !host()?.contains(e.target)) return;
    e.preventDefault();
    find();
  });

  document.addEventListener('change', (e) => {
    const el = host();
    if (!el || !el.contains(e.target) || !e.target.matches('[data-wl-enabled]')) return;
    const enabled = e.target.checked;
    withBusy('enabled', async () => {
      const r = await call('set_enabled', { enabled });
      toastOk(r.message);
      await load();
    });
  });

  // A Watch list card in the chat changed something — reload behind it.
  document.addEventListener('watchlist:changed', (e) => {
    if (!state.assistantId || (e.detail && e.detail.assistantId && Number(e.detail.assistantId) !== Number(state.assistantId))) return;
    load();
  });

  window.AssistantWatchList = {
    init({ assistantId, assistantName }) {
      state.assistantName = assistantName || '';
      if (state.assistantId !== assistantId) {
        Object.assign(state, { assistantId, view: null, loaded: false, notSetUp: false, error: null, filter: 'all', busy: null, query: '', results: null });
      }
      load();
    },
    rename(name) { state.assistantName = name || state.assistantName; render(); },
    activate() { render(); if (state.loaded) load(); },
    reload: load,
  };
})();
