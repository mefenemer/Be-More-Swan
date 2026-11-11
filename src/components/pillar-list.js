// src/components/pillar-list.js — a Social Media assistant's content pillars, or a Blog / Email
// assistant's topics, on its settings, one record each (docs/pillar-records-plan.md,
// src/utils/content-pillars-store.ts). The words ("pillar" / "topic") and the cap come from the server
// (the assistant's role, src/utils/pillar-profiles.ts). ⚠️ Blog and Email never say "pillar".
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
// Archived pillars are listed under "Archived pillars" with "Bring back" (description and posts kept).
//
// Blog and Email (Operational Setup): mount(host, { assistantId, initialText, contextKey: 'blogTopics' |
// 'newsletterTopics' }). There is no hidden carrier and no redraft offer; the derived text goes back
// into the page's context, and assistants.js leaves those keys out of the autosave entirely.
//
// window.PillarList.mount(host, { assistantId, initialText, contextKey? })  ·  .reload()
(function () {
  const API = '/.netlify/functions/content-pillars';
  let state = { host: null, assistantId: null, contextKey: 'content_pillars', noun: 'pillar', nounPlural: 'pillars', pillars: null, archived: [], limits: { maxActive: 5, maxName: 60, maxDescription: 300 }, busy: false, error: '', fallback: [] };
  const isSocial = () => state.contextKey === 'content_pillars';
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

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
    // Social keeps an array and a hidden carrier for the AI wand; Blog / Email keep "A, B, C" text.
    const value = isSocial() ? names : names.join(', ');
    if (isSocial()) {
      const hidden = document.getElementById('edit_pillars');
      if (hidden) hidden.value = names.join(', ');
    }
    window._detailSetContextKey?.(state.contextKey, value);
    if (window.cachedContext) window.cachedContext[state.contextKey] = value;
    // The redraft offer is for a Social assistant's scheduled posts only.
    if (offerRedraft && isSocial()) window.offerRedraftUpcoming?.(Number(state.assistantId));
  }

  async function run(body, opts) {
    if (state.busy) return;
    state.busy = true; state.error = '';
    render();
    const host = state.host, assistantId = state.assistantId;
    try {
      const data = await call('POST', body);
      if (!stillFor(host, assistantId)) return;
      if (!Array.isArray(data.pillars)) throw new Error('That didn\'t save. Try again.');
      state.pillars = data.pillars;
      if (Array.isArray(data.archived)) state.archived = data.archived;
      // A restore with five already on comes back switched off: say so, and there is nothing to redraft.
      if (data.switchedOff) state.error = `${state.limits.maxActive} ${state.nounPlural} are already switched on, so it came back switched off.`;
      publish(state.pillars, data.switchedOff ? { offerRedraft: false } : (opts || { offerRedraft: true }));
    } catch (err) {
      if (stillFor(host, assistantId)) state.error = err.message;
    } finally {
      state.busy = false;
      if (stillFor(host, assistantId)) render();
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
            <label class="sr-only" for="pillar-name-${p.id}">${cap(state.noun)} name</label>
            <input id="pillar-name-${p.id}" data-field="name" type="text" maxlength="${maxName}" value="${esc(p.name)}"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-semibold ${off ? 'text-gray-500' : 'text-gray-900'} focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700">
            <label class="sr-only" for="pillar-desc-${p.id}">What goes under ${esc(p.name)}</label>
            <textarea id="pillar-desc-${p.id}" data-field="description" rows="2" maxlength="${maxDescription}"
              placeholder="Optional: what goes under this ${state.noun}"
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
           <p class="text-xs text-gray-500 mt-2">${cap(state.nounPlural)} are being upgraded. You can edit them again in a few minutes.</p>`
        : `<p class="text-xs text-gray-500">${cap(state.nounPlural)} are being upgraded. You can add them again in a few minutes.</p>`;
      return;
    }

    const list = state.pillars;
    const onCount = list.filter((p) => p.isActive).length;
    const full = onCount >= maxActive;
    host.innerHTML = `
      ${list.length ? `<ul class="space-y-2" aria-label="${isSocial() ? 'Content pillars' : 'Topics'}">${list.map(rowHtml).join('')}</ul>`
        : `<p class="text-sm text-gray-500">${isSocial() ? 'No pillars yet. Add the 3 to 5 themes your posts should rotate between.' : 'No topics yet. Add the subjects you want to write about.'}</p>`}
      <p class="text-xs ${full ? 'text-amber-800' : 'text-gray-500'} mt-2" data-pillar-count>${onCount} of ${maxActive} switched on.${full ? ' Switch one off or archive it to add another.' : ''}</p>
      <form class="flex gap-2 mt-3" data-pillar-add>
        <label class="sr-only" for="pillar-new-name">New ${state.noun} name</label>
        <input id="pillar-new-name" type="text" maxlength="${maxName}" placeholder="${isSocial() ? 'New pillar, e.g. Behind the scenes' : `New ${state.noun}, e.g. Seasonal offers`}" ${full ? 'disabled' : ''}
          class="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700 disabled:bg-gray-50">
        <button type="submit" ${full || state.busy ? 'disabled' : ''}
          class="shrink-0 px-3 py-2 rounded-lg bg-emerald-800 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-40">+ Add ${state.noun}</button>
      </form>
      ${state.archived.length ? `
      <details class="mt-3" data-pillar-archived>
        <summary class="text-xs font-semibold text-gray-600 cursor-pointer">Archived ${state.nounPlural} (${state.archived.length})</summary>
        <ul class="mt-2 space-y-1">${state.archived.map((a) => `
          <li class="flex items-center justify-between gap-2 text-sm text-gray-600" data-archived-id="${a.id}">
            <span class="min-w-0 truncate" title="${esc(a.description || '')}">${esc(a.name)}</span>
            <button type="button" data-act="restore" ${state.busy ? 'disabled' : ''} class="shrink-0 text-xs font-semibold text-emerald-800 hover:text-emerald-700 disabled:opacity-40">Bring back</button>
          </li>`).join('')}</ul>
      </details>` : ''}
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
      if (btn.dataset.act === 'restore') {
        const id = Number(btn.closest('[data-archived-id]')?.dataset.archivedId);
        if (id) run({ action: 'restore', pillarId: id });
        return;
      }
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
        const msg = isSocial()
          ? `"${p.name}" stops being used for new posts. Posts already written under it keep it.`
          : `"${p.name}" stops being used for new drafts. Anything already written under it keeps it.`;
        if (window.showConfirmModal) window.showConfirmModal(msg, go, { title: `Archive this ${state.noun}?`, confirmLabel: 'Yes, archive', cancelLabel: 'Keep it' });
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

  // ⚠️ One list per page, but the page can switch assistant while a reply is on its way (the last-viewed
  // assistant restores, then another opens): a reply is applied only if it is still for the mounted one.
  // Seen on staging 2026-11-11: Misty's pillars painted into Mira's topics list.
  const stillFor = (host, assistantId) => state.host === host && state.assistantId === assistantId;

  async function reload() {
    if (!state.host || !state.assistantId) return;
    const host = state.host, assistantId = state.assistantId;
    try {
      const data = await call('GET');
      if (!stillFor(host, assistantId)) return;
      // Keep the defaults for any limit the answer leaves out, and treat an answer without a list as
      // "not available yet" (the fallback chips): `undefined` here crashed render() on list.filter.
      state.limits = {
        maxActive: Number(data.maxActive) || state.limits.maxActive,
        maxName: Number(data.maxName) || state.limits.maxName,
        maxDescription: Number(data.maxDescription) || state.limits.maxDescription,
      };
      if (data.noun) { state.noun = String(data.noun); state.nounPlural = String(data.nounPlural || `${data.noun}s`); }
      state.pillars = Array.isArray(data.pillars) ? data.pillars : null;
      state.archived = Array.isArray(data.archived) ? data.archived : [];
      state.error = '';
      if (state.pillars) publish(state.pillars, { offerRedraft: false });
    } catch (err) {
      if (!stillFor(host, assistantId)) return;
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
      contextKey: opts.contextKey || 'content_pillars',
      noun: opts.contextKey && opts.contextKey !== 'content_pillars' ? 'topic' : 'pillar',
      nounPlural: opts.contextKey && opts.contextKey !== 'content_pillars' ? 'topics' : 'pillars',
      pillars: [],
      archived: [],
      error: '',
      fallback: window.ContentPillars ? window.ContentPillars.parsePillarsUpTo(opts.initialText || '', opts.contextKey && opts.contextKey !== 'content_pillars' ? 8 : 5) : [],
    };
    // The detail view is re-injected on every visit, so the host is a new node: bind it once.
    if (fresh && !host.dataset.pillarBound) { host.dataset.pillarBound = '1'; bind(host); }
    host.innerHTML = `<p class="text-xs text-gray-400">Loading ${state.nounPlural}…</p>`;
    reload();
  }

  // Results tab: "Posts by pillar" bars in the Autopilot card (#autopilot-pillars). Drawn like "Content by
  // platform" beside it. Each cross-post counts once; switched-off and archived pillars are labelled.
  async function renderUsage(assistantId) {
    const box = document.getElementById('autopilot-pillars');
    const bars = document.getElementById('pillar-usage-bars');
    if (!box || !bars) return;
    try {
      const res = await fetch(`${API}?assistantId=${encodeURIComponent(assistantId)}&usage=1`, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      // The page moved on (another assistant opened) while this was on its way: its boxes are gone.
      if (!box.isConnected) return;
      const rows = Array.isArray(data.usage) ? data.usage : [];
      if (!res.ok || !rows.length) { box.classList.add('hidden'); return; }
      const note = document.getElementById('pillar-usage-note');
      if (note) {
        note.textContent = `Last ${Number(data.days) || 60} days`;
        note.title = 'Posts drafted under each pillar, each cross-post counted once. Your assistant gives the next posts to the pillars used least.';
      }
      const max = Math.max(1, ...rows.map((r) => r.posts));
      bars.innerHTML = `<div class="space-y-2.5">${rows.map((r) => {
        const tag = r.archived ? ' <span class="font-normal text-gray-400">(archived)</span>' : (!r.isActive ? ' <span class="font-normal text-gray-400">(off)</span>' : '');
        const pct = Math.round((r.posts / max) * 100);
        return `<div title="${esc(r.name)}: ${r.posts} post${r.posts === 1 ? '' : 's'}">
            <div class="flex items-center justify-between text-xs font-semibold mb-1">
              <span class="text-gray-700 min-w-0 truncate">${esc(r.name)}${tag}</span>
              <span class="text-gray-500 shrink-0" style="font-variant-numeric:tabular-nums">${r.posts}</span>
            </div>
            <div class="rounded-full overflow-hidden" style="height:8px;background:#f3f4f6;">
              <div class="bg-emerald-500 h-full rounded-full" style="width:${pct}%"></div>
            </div>
          </div>`;
      }).join('')}</div>`;
      box.classList.remove('hidden');
    } catch {
      box.classList.add('hidden'); // supplementary, like the other Results bars
    }
  }

  window.PillarList = { mount, reload, renderUsage };
}());
