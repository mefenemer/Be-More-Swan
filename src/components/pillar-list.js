// src/components/pillar-list.js — a Social Media assistant's content pillars on the profile, one
// record each (docs/pillar-records-plan.md, src/utils/content-pillars-store.ts).
//
// Each pillar: a name, an optional description ("what goes under this"), on/off, order, archive.
// Every change saves AT ONCE through netlify/functions/content-pillars.ts, never through the
// profile's autosave. After each change:
//   · the hidden #edit_pillars and the profile's in-memory context get the derived names, so the
//     next autosave carries the same list and the server leaves the records alone;
//   · the "redraft upcoming posts" offer is made when what the posts are about changed.
// The AI wand and Review Progress's strategy fix still write pillar TEXT into #edit_pillars; the
// autosave then sends it and the server reconciles the records (syncPillarsFromNames), and
// assistants.js calls PillarList.reload() after that save.
//
// window.PillarList.mount(host, { assistantId, initialText })  ·  .reload()
(function () {
  const API = '/.netlify/functions/content-pillars';
  let state = { host: null, assistantId: null, pillars: null, limits: { maxActive: 5, maxName: 60, maxDescription: 300 }, busy: false, error: '', fallback: [] };

  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  async function call(method, body) {
    const url = method === 'GET' ? `${API}?assistantId=${encodeURIComponent(state.assistantId)}` : API;
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ assistantId: state.assistantId, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `That didn't save (HTTP ${res.status}). Try again.`);
    return data;
  }

  function activeNames(pillars) {
    return (pillars || []).filter((p) => p.isActive).map((p) => p.name);
  }

  // Keep the rest of the profile in step with the records (see the header).
  function publish(pillars, { offerRedraft }) {
    const names = activeNames(pillars);
    const hidden = document.getElementById('edit_pillars');
    if (hidden) hidden.value = names.join(', ');
    window._detailSetContextKey?.('content_pillars', names);
    if (window.cachedContext) window.cachedContext.content_pillars = names;
    if (offerRedraft) window.offerRedraftUpcoming?.(Number(state.assistantId));
  }

  async function run(body, opts) {
    if (state.busy) return;
    state.busy = true; state.error = '';
    render();
    try {
      const data = await call('POST', body);
      if (!Array.isArray(data.pillars)) throw new Error('That didn\'t save. Try again.');
      state.pillars = data.pillars;
      publish(state.pillars, opts || { offerRedraft: true });
    } catch (err) {
      state.error = err.message;
    } finally {
      state.busy = false;
      render();
    }
  }

  function rowHtml(p, i, list) {
    const { maxName, maxDescription } = state.limits;
    const off = !p.isActive;
    return `
      <li class="border border-gray-200 rounded-xl p-3 ${off ? 'bg-gray-50' : 'bg-white'}" data-pillar-id="${p.id}">
        <div class="flex items-start gap-2">
          <div class="flex flex-col pt-1">
            <button type="button" data-act="up" ${i === 0 ? 'disabled' : ''} class="text-gray-400 hover:text-gray-700 disabled:opacity-30 leading-none px-1" aria-label="Move ${esc(p.name)} up">▲</button>
            <button type="button" data-act="down" ${i === list.length - 1 ? 'disabled' : ''} class="text-gray-400 hover:text-gray-700 disabled:opacity-30 leading-none px-1" aria-label="Move ${esc(p.name)} down">▼</button>
          </div>
          <div class="flex-1 min-w-0 space-y-2">
            <label class="sr-only" for="pillar-name-${p.id}">Pillar name</label>
            <input id="pillar-name-${p.id}" data-field="name" type="text" maxlength="${maxName}" value="${esc(p.name)}"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-semibold ${off ? 'text-gray-500' : 'text-gray-900'} focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700">
            <label class="sr-only" for="pillar-desc-${p.id}">What goes under ${esc(p.name)}</label>
            <textarea id="pillar-desc-${p.id}" data-field="description" rows="2" maxlength="${maxDescription}"
              placeholder="Optional: what goes under this pillar"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 resize-none focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700">${esc(p.description || '')}</textarea>
          </div>
          <div class="flex flex-col items-end gap-2 shrink-0">
            <label class="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 cursor-pointer">
              <input type="checkbox" data-act="toggle" ${p.isActive ? 'checked' : ''} class="w-4 h-4 accent-emerald-700">
              ${p.isActive ? 'On' : 'Off'}
            </label>
            <button type="button" data-act="archive" class="text-xs font-semibold text-gray-500 hover:text-red-700">Archive</button>
          </div>
        </div>
      </li>`;
  }

  function render() {
    const host = state.host;
    if (!host) return;
    const { maxActive, maxName } = state.limits;

    // The SQL is not applied yet: show the old text's pillars, read-only.
    if (state.pillars === null) {
      host.innerHTML = state.fallback.length
        ? `<div class="flex flex-wrap gap-1.5">${state.fallback.map((n) => `<span class="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">${esc(n)}</span>`).join('')}</div>
           <p class="text-xs text-gray-500 mt-2">Pillars are being upgraded. You can edit them again in a few minutes.</p>`
        : `<p class="text-xs text-gray-500">Pillars are being upgraded. You can add them again in a few minutes.</p>`;
      return;
    }

    const list = state.pillars;
    const onCount = list.filter((p) => p.isActive).length;
    const full = onCount >= maxActive;
    host.innerHTML = `
      ${list.length ? `<ul class="space-y-2" aria-label="Content pillars">${list.map(rowHtml).join('')}</ul>`
        : '<p class="text-sm text-gray-500">No pillars yet. Add the 3 to 5 themes your posts should rotate between.</p>'}
      <p class="text-xs ${full ? 'text-amber-800' : 'text-gray-500'} mt-2" data-pillar-count>${onCount} of ${maxActive} switched on.${full ? ' Switch one off or archive it to add another.' : ''}</p>
      <form class="flex gap-2 mt-3" data-pillar-add>
        <label class="sr-only" for="pillar-new-name">New pillar name</label>
        <input id="pillar-new-name" type="text" maxlength="${maxName}" placeholder="New pillar, e.g. Behind the scenes" ${full ? 'disabled' : ''}
          class="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700 disabled:bg-gray-50">
        <button type="submit" ${full || state.busy ? 'disabled' : ''}
          class="shrink-0 px-3 py-2 rounded-lg bg-emerald-800 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-40">+ Add pillar</button>
      </form>
      ${state.error ? `<p class="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2" role="alert">${esc(state.error)}</p>` : ''}`;
  }

  function pillarOf(el) {
    const li = el.closest('[data-pillar-id]');
    return li ? state.pillars.find((p) => p.id === Number(li.dataset.pillarId)) : null;
  }

  function bind(host) {
    host.addEventListener('submit', (e) => {
      if (!e.target.matches('[data-pillar-add]')) return;
      e.preventDefault();
      const input = host.querySelector('#pillar-new-name');
      const name = (input?.value || '').trim();
      if (!name) return;
      run({ action: 'add', name });
    });

    host.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const p = pillarOf(btn);
      if (!p) return;
      if (btn.dataset.act === 'up' || btn.dataset.act === 'down') {
        const ids = state.pillars.map((x) => x.id);
        const i = ids.indexOf(p.id);
        const j = btn.dataset.act === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        run({ action: 'reorder', ids }, { offerRedraft: false });
      } else if (btn.dataset.act === 'archive') {
        const go = () => run({ action: 'archive', pillarId: p.id });
        const msg = `"${p.name}" stops being used for new posts. Posts already written under it keep it.`;
        if (window.showConfirmModal) window.showConfirmModal(msg, go, { title: 'Archive this pillar?', confirmLabel: 'Yes, archive', cancelLabel: 'Keep it' });
        else go();
      }
    });

    host.addEventListener('change', (e) => {
      const el = e.target;
      const p = pillarOf(el);
      if (!p) return;
      if (el.matches('[data-act="toggle"]')) {
        run({ action: 'update', pillarId: p.id, isActive: el.checked });
      } else if (el.matches('[data-field="name"]')) {
        const name = el.value.trim();
        if (name === p.name) return;
        if (!name) { el.value = p.name; return; }
        run({ action: 'update', pillarId: p.id, name }, { offerRedraft: p.isActive });
      } else if (el.matches('[data-field="description"]')) {
        const description = el.value.trim();
        if (description === (p.description || '')) return;
        run({ action: 'update', pillarId: p.id, description }, { offerRedraft: p.isActive });
      }
    });

    // Enter in a name box saves it (a change event) instead of submitting anything.
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('[data-field="name"]')) { e.preventDefault(); e.target.blur(); }
    });
  }

  async function reload() {
    if (!state.host || !state.assistantId) return;
    try {
      const data = await call('GET');
      // Keep the defaults for any limit the answer leaves out, and treat an answer without a list as
      // "not available yet" (the fallback chips): `undefined` here crashed render() on list.filter.
      state.limits = {
        maxActive: Number(data.maxActive) || state.limits.maxActive,
        maxName: Number(data.maxName) || state.limits.maxName,
        maxDescription: Number(data.maxDescription) || state.limits.maxDescription,
      };
      state.pillars = Array.isArray(data.pillars) ? data.pillars : null;
      state.error = '';
      if (state.pillars) publish(state.pillars, { offerRedraft: false });
    } catch (err) {
      state.error = err.message;
      if (!Array.isArray(state.pillars)) state.pillars = null;
    }
    render();
  }

  function mount(host, opts) {
    if (!host) return;
    const fresh = state.host !== host;
    state = {
      ...state,
      host,
      assistantId: opts.assistantId,
      pillars: [],
      error: '',
      fallback: window.ContentPillars ? window.ContentPillars.parsePillars(opts.initialText || '') : [],
    };
    // The detail view is re-injected on every visit, so the host is a new node: bind it once.
    if (fresh && !host.dataset.pillarBound) { host.dataset.pillarBound = '1'; bind(host); }
    host.innerHTML = '<p class="text-xs text-gray-400">Loading pillars…</p>';
    reload();
  }

  window.PillarList = { mount, reload };
}());
