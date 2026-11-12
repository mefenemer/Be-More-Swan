// src/components/admin-board.js — one kanban board for the admin portal's work queues.
//
// Used by the Fix pipeline and Feature requests (admin.html), so both read the same way: a toolbar
// (search, filters, group by, sort, a "Needs me" quick view), columns with counts, rows of columns
// when grouped, and drag-and-drop ONLY where a person makes the decision. A column the pipeline
// fills by itself refuses a drop and says why.
//
// The page owns the data and the actions; this file owns layout and view state. Cards are HTML the
// page builds (and escapes); everything this file prints itself goes through esc().
//
// View state (search, filters, group, sort, quick view, folded columns) is remembered per board in
// localStorage — every access wrapped, so a blocked store just means defaults — and mirrored into the
// URL's `<id>` query parameter, so a view can be shared by link.
//
//   const board = AdminBoard.create({
//     id: 'fix', mount, columns: [{ key, label, hint?, folded?, emptyText? }],
//     columnOf(item), idOf(item), searchText(item), renderCard(item),
//     filters?: [{ key, label, options(items) → [{ value, label }], test(item, value) }],
//     groups?: [{ key, label, of(item) → string }],          // '' = no grouping is added for you
//     sorts: [{ key, label, compare(a, b) }], defaultSort,
//     quickViews?: [{ key, label, columns: [columnKey…] }],
//     canDrop?(item, toKey) → true | 'reason it can't go there',
//     onDrop?(item, toKey) → Promise,  onOpen?(item),
//   });
//   board.setItems(items);   // re-renders

(function () {
  'use strict';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function readStore(key) {
    try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  function writeStore(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window / blocked: defaults next time */ }
  }

  // URL form: ?fix=q~bug|f.source~system|g~area|s~oldest|v~needs|c~closed,review
  function readUrl(id) {
    try {
      const raw = new URLSearchParams(window.location.search).get(id);
      if (!raw) return null;
      const out = { filters: {}, folded: null };
      raw.split('|').forEach((part) => {
        const at = part.indexOf('~');
        if (at < 0) return;
        const k = part.slice(0, at); const v = decodeURIComponent(part.slice(at + 1));
        if (k === 'q') out.q = v;
        else if (k === 'g') out.group = v;
        else if (k === 's') out.sort = v;
        else if (k === 'v') out.quick = v;
        else if (k === 'c') out.folded = v ? v.split(',') : [];
        else if (k.startsWith('f.')) out.filters[k.slice(2)] = v;
      });
      return out;
    } catch { return null; }
  }
  function writeUrl(id, st) {
    try {
      const parts = [];
      if (st.q) parts.push(`q~${encodeURIComponent(st.q)}`);
      Object.entries(st.filters).forEach(([k, v]) => { if (v) parts.push(`f.${k}~${encodeURIComponent(v)}`); });
      if (st.group) parts.push(`g~${encodeURIComponent(st.group)}`);
      if (st.sort) parts.push(`s~${encodeURIComponent(st.sort)}`);
      if (st.quick) parts.push(`v~${encodeURIComponent(st.quick)}`);
      parts.push(`c~${st.folded.join(',')}`);
      const url = new URL(window.location.href);
      url.searchParams.set(id, parts.join('|'));
      window.history.replaceState(window.history.state, '', url.toString());
    } catch { /* URL mirroring is a convenience only */ }
  }

  function create(cfg) {
    const storeKey = `admin-board:${cfg.id}`;
    const defaults = {
      q: '', filters: {}, group: '', sort: cfg.defaultSort || (cfg.sorts[0] && cfg.sorts[0].key) || '', quick: '',
      folded: cfg.columns.filter((c) => c.folded).map((c) => c.key),
    };
    const st = Object.assign({}, defaults, readStore(storeKey) || {});
    const fromUrl = readUrl(cfg.id);
    if (fromUrl) {
      Object.assign(st, Object.fromEntries(Object.entries(fromUrl).filter(([k, v]) => v != null && k !== 'filters')));
      if (Object.keys(fromUrl.filters).length) st.filters = fromUrl.filters;
    }
    st.filters = Object.assign({}, st.filters);
    let items = [];
    let dragId = null;
    let busy = false;

    const save = () => { writeStore(storeKey, st); writeUrl(cfg.id, st); };
    const byId = (id) => items.find((x) => String(cfg.idOf(x)) === String(id));

    function visible() {
      const q = st.q.trim().toLowerCase();
      const quick = (cfg.quickViews || []).find((v) => v.key === st.quick);
      return items.filter((it) => {
        if (q) {
          const hay = String(cfg.searchText(it) || '').toLowerCase();
          const idq = q.replace(/^#/, '');
          if (!hay.includes(q) && String(cfg.idOf(it)) !== idq) return false;
        }
        for (const f of cfg.filters || []) {
          const v = st.filters[f.key];
          if (v && !f.test(it, v)) return false;
        }
        if (quick && !quick.columns.includes(cfg.columnOf(it))) return false;
        return true;
      });
    }

    function sorted(list) {
      const s = cfg.sorts.find((x) => x.key === st.sort) || cfg.sorts[0];
      return s ? list.slice().sort(s.compare) : list;
    }

    function toolbar() {
      const sel = (key, label, options, value, extra = '') => `
        <label class="flex items-center gap-1 text-xs text-gray-500"><span class="sr-only">${esc(label)}</span>
          <select data-ab="${key}" ${extra} aria-label="${esc(label)}" class="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white" style="max-width:12rem">
            ${options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select></label>`;
      const filters = (cfg.filters || []).map((f) => {
        const opts = f.options(items);
        return sel('filter', f.label, [{ value: '', label: `${f.label}: all` }, ...opts], st.filters[f.key] || '', `data-key="${esc(f.key)}"`);
      }).join('');
      const groups = cfg.groups && cfg.groups.length
        ? sel('group', 'Group by', [{ value: '', label: 'Group: none' }, ...cfg.groups.map((g) => ({ value: g.key, label: `Group: ${g.label}` }))], st.group) : '';
      const sorts = sel('sort', 'Sort', cfg.sorts.map((s) => ({ value: s.key, label: `Sort: ${s.label}` })), st.sort);
      const quick = (cfg.quickViews || []).map((v) => `
        <button type="button" data-ab="quick" data-key="${esc(v.key)}" aria-pressed="${st.quick === v.key}"
          class="px-3 py-1.5 rounded-full text-xs font-semibold border ${st.quick === v.key ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}">${esc(v.label)}</button>`).join('');
      const active = !!(st.q || st.quick || st.group || Object.values(st.filters).some(Boolean));
      return `
        <div class="flex flex-wrap items-center gap-2 mb-3" data-ab-toolbar>
          <input type="search" data-ab="q" value="${esc(st.q)}" placeholder="Search text, #id or email…" aria-label="Search"
            style="width:14rem" class="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-emerald-500 focus:outline-none">
          ${quick}${filters}${groups}${sorts}
          ${active ? '<button type="button" data-ab="reset" class="text-xs font-semibold text-gray-500 hover:text-gray-800 hover:underline">Clear</button>' : ''}
        </div>`;
    }

    function column(col, list, laneKey) {
      const folded = st.folded.includes(col.key);
      const count = list.length;
      if (folded) {
        return `
          <div class="shrink-0 w-11 bg-gray-50 border border-gray-200 rounded-xl flex flex-col items-center py-3 gap-2" data-ab-col="${esc(col.key)}" data-ab-lane="${esc(laneKey)}" data-ab-drop="${esc(col.key)}">
            <button type="button" data-ab="fold" data-key="${esc(col.key)}" title="Show ${esc(col.label)}" aria-label="Show ${esc(col.label)} (${count})"
              style="writing-mode:vertical-rl;transform:rotate(180deg)" class="text-xs font-bold text-gray-500 hover:text-gray-900 whitespace-nowrap">${esc(col.label)} · ${count}</button>
          </div>`;
      }
      return `
        <div style="width:18rem" class="shrink-0 bg-gray-50 border border-gray-200 rounded-xl flex flex-col max-h-[70vh]" data-ab-col="${esc(col.key)}" data-ab-lane="${esc(laneKey)}">
          <div class="flex items-start justify-between gap-2 px-3 pt-3 pb-2">
            <div class="min-w-0">
              <p class="text-xs font-bold text-gray-800">${esc(col.label)} <span class="text-gray-400 font-semibold">${count}</span></p>
              ${col.hint ? `<p class="text-[11px] text-gray-400 leading-snug">${esc(col.hint)}</p>` : ''}
            </div>
            <button type="button" data-ab="fold" data-key="${esc(col.key)}" title="Fold ${esc(col.label)}" aria-label="Fold ${esc(col.label)}" class="text-gray-400 hover:text-gray-700 text-xs shrink-0">⇤</button>
          </div>
          <div style="min-height:3rem" class="flex-1 overflow-y-auto px-2 pb-2 space-y-2 rounded-xl" data-ab-drop="${esc(col.key)}">
            ${list.map((it) => `
              <div draggable="${cfg.onDrop ? 'true' : 'false'}" data-ab-card="${esc(cfg.idOf(it))}" tabindex="0" role="button"
                class="bg-white border border-gray-200 rounded-lg p-2.5 text-left cursor-pointer hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500">${cfg.renderCard(it)}</div>`).join('')
              || `<p class="text-[11px] text-gray-400 text-center py-3">${esc(col.emptyText || 'Nothing here')}</p>`}
          </div>
        </div>`;
    }

    function lanes(list) {
      const g = (cfg.groups || []).find((x) => x.key === st.group);
      if (!g) return [{ key: '', label: '', items: list }];
      const map = new Map();
      list.forEach((it) => {
        const k = String(g.of(it) || '—');
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(it);
      });
      return [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([k, v]) => ({ key: k, label: k, items: v }));
    }

    function render() {
      const mount = cfg.mount;
      if (!mount) return;
      const focusedSearch = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-ab') === 'q';
      const caret = focusedSearch ? document.activeElement.selectionStart : null;
      const list = sorted(visible());
      const total = items.length;
      const ls = lanes(list);
      mount.innerHTML = `${toolbar()}
        <p class="text-[11px] text-gray-400 mb-2" aria-live="polite">${list.length === total ? `${total} item${total === 1 ? '' : 's'}` : `${list.length} of ${total} shown`}</p>
        <div class="space-y-4">
          ${ls.map((lane) => `
            <section>
              ${lane.label ? `<h3 class="text-xs font-bold text-gray-600 mb-2">${esc(lane.label)} <span class="text-gray-400">${lane.items.length}</span></h3>` : ''}
              <div class="flex gap-3 overflow-x-auto pb-2">
                ${cfg.columns.map((c) => column(c, lane.items.filter((it) => cfg.columnOf(it) === c.key), lane.key)).join('')}
              </div>
            </section>`).join('')}
        </div>`;
      if (focusedSearch) {
        const input = mount.querySelector('[data-ab="q"]');
        if (input) { input.focus(); try { input.setSelectionRange(caret, caret); } catch { /* type=search may refuse */ } }
      }
    }

    function markTargets(item) {
      cfg.mount.querySelectorAll('[data-ab-drop]').forEach((zone) => {
        const to = zone.getAttribute('data-ab-drop');
        const ok = cfg.canDrop ? cfg.canDrop(item, to) : true;
        zone.classList.toggle('ring-2', ok === true);
        zone.classList.toggle('ring-emerald-400', ok === true);
        zone.classList.toggle('opacity-40', ok !== true);
        zone.title = ok === true ? '' : String(ok || '');
      });
    }
    function clearTargets() {
      cfg.mount.querySelectorAll('[data-ab-drop]').forEach((zone) => {
        zone.classList.remove('ring-2', 'ring-emerald-400', 'opacity-40', 'bg-emerald-50');
        zone.title = '';
      });
    }

    function wire() {
      const m = cfg.mount;
      if (!m || m.__abWired) return;
      m.__abWired = true;
      let qTimer = null;
      m.addEventListener('input', (e) => {
        if (e.target.getAttribute('data-ab') !== 'q') return;
        clearTimeout(qTimer);
        const v = e.target.value;
        qTimer = setTimeout(() => { st.q = v; save(); render(); }, 150);
      });
      m.addEventListener('change', (e) => {
        const t = e.target; const kind = t.getAttribute('data-ab');
        if (kind === 'filter') st.filters[t.getAttribute('data-key')] = t.value;
        else if (kind === 'group') st.group = t.value;
        else if (kind === 'sort') st.sort = t.value;
        else return;
        save(); render();
      });
      m.addEventListener('click', (e) => {
        const ctl = e.target.closest('[data-ab]');
        if (ctl) {
          const kind = ctl.getAttribute('data-ab');
          if (kind === 'fold') {
            const k = ctl.getAttribute('data-key');
            st.folded = st.folded.includes(k) ? st.folded.filter((x) => x !== k) : st.folded.concat(k);
            save(); render(); return;
          }
          if (kind === 'quick') { const k = ctl.getAttribute('data-key'); st.quick = st.quick === k ? '' : k; save(); render(); return; }
          if (kind === 'reset') { st.q = ''; st.filters = {}; st.group = ''; st.quick = ''; save(); render(); return; }
          return;
        }
        // A link or button inside a card (a PR link) does its own thing.
        if (e.target.closest('a, button, select, input')) return;
        const card = e.target.closest('[data-ab-card]');
        if (card && cfg.onOpen) { const it = byId(card.getAttribute('data-ab-card')); if (it) cfg.onOpen(it); }
      });
      m.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const card = e.target.closest && e.target.closest('[data-ab-card]');
        if (!card || e.target !== card || !cfg.onOpen) return;
        e.preventDefault();
        const it = byId(card.getAttribute('data-ab-card')); if (it) cfg.onOpen(it);
      });
      m.addEventListener('dragstart', (e) => {
        const card = e.target.closest && e.target.closest('[data-ab-card]');
        if (!card || !cfg.onDrop || busy) return;
        dragId = card.getAttribute('data-ab-card');
        try { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; } catch { /* some browsers */ }
        const it = byId(dragId); if (it) markTargets(it);
      });
      m.addEventListener('dragend', () => { dragId = null; clearTargets(); });
      m.addEventListener('dragover', (e) => {
        const zone = e.target.closest && e.target.closest('[data-ab-drop]');
        if (!zone || dragId == null) return;
        const it = byId(dragId);
        const ok = it && (cfg.canDrop ? cfg.canDrop(it, zone.getAttribute('data-ab-drop')) : true);
        if (ok === true) { e.preventDefault(); zone.classList.add('bg-emerald-50'); }
      });
      m.addEventListener('dragleave', (e) => {
        const zone = e.target.closest && e.target.closest('[data-ab-drop]');
        if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('bg-emerald-50');
      });
      m.addEventListener('drop', async (e) => {
        const zone = e.target.closest && e.target.closest('[data-ab-drop]');
        if (!zone || dragId == null) return;
        e.preventDefault();
        const it = byId(dragId); const to = zone.getAttribute('data-ab-drop');
        dragId = null; clearTargets();
        if (!it || cfg.columnOf(it) === to) return;
        const ok = cfg.canDrop ? cfg.canDrop(it, to) : true;
        if (ok !== true) { if (ok) window.showToast?.(String(ok), { icon: 'ℹ️' }); return; }
        busy = true;
        try { await cfg.onDrop(it, to); } finally { busy = false; }
      });
    }

    wire();
    return {
      setItems(next) { items = Array.isArray(next) ? next : []; render(); },
      render,
      state: () => JSON.parse(JSON.stringify(st)),
    };
  }

  window.AdminBoard = { create, _esc: esc };
})();
