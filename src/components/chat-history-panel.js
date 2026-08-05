/**
 * src/components/chat-history-panel.js
 *
 * "Past conversations" drawer for the Digital Assistant chat.
 *
 * Every chat surface (assistant-chat-modal.js, the workspace chat modal, assistant-chat.html)
 * mounts this same panel, so a thread archived in one place is gone from all of them and the
 * Active/Archived split cannot drift between surfaces.
 *
 * Reads list-chat-sessions.ts; writes archive-chat-session.ts. Nothing here deletes anything.
 *
 * Usage:
 *   const panel = window.ChatHistoryPanel.mount({
 *     container,                 // HTMLElement to render into
 *     assistantId,               // number — scopes the list to one assistant
 *     currentSessionId,          // number | null — highlighted, and never offered as "resume"
 *     onSelect(id, { readOnly }) // a row was picked; readOnly is true for an archived thread
 *     onNew()                    // "New conversation" was clicked
 *   });
 *   panel.refresh()              // re-fetch (e.g. after the first reply creates a session)
 *   panel.destroy()
 *
 * Requires nothing beyond the two endpoints — no marked/DOMPurify, since previews are plain
 * text and are escaped, never rendered as Markdown.
 */
(function () {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Compact relative time — the list is scanned, not studied.
  function relativeTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.round(hours / 24);
    if (days < 7) return days + 'd ago';
    return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function mount(props) {
    const { container } = props || {};
    if (!(container instanceof HTMLElement)) {
      throw new Error('[ChatHistoryPanel] mount() requires a container element.');
    }
    const assistantId = Number(props.assistantId);
    const onSelect = typeof props.onSelect === 'function' ? props.onSelect : function () {};
    const onNew = typeof props.onNew === 'function' ? props.onNew : function () {};

    let currentSessionId = props.currentSessionId != null ? Number(props.currentSessionId) : null;
    let view = 'active';          // 'active' | 'archived'
    let rows = [];
    let loading = false;
    let destroyed = false;

    container.innerHTML = ''
      + '<div class="flex flex-col h-full bg-white" data-ch-root>'
      +   '<div class="px-4 py-3 border-b border-gray-100 shrink-0">'
      +     '<button type="button" data-ch-new '
      +       'class="w-full flex items-center justify-center gap-2 px-3 py-2 bg-emerald-700 hover:bg-emerald-800 '
      +       'text-white text-sm font-bold rounded-lg transition cursor-pointer">'
      +       '<span aria-hidden="true">+</span> New conversation</button>'
      +     '<div class="flex gap-1 mt-3" role="tablist">'
      +       '<button type="button" data-ch-view="active" role="tab" class="px-3 py-1 text-xs font-bold rounded-md cursor-pointer">Active</button>'
      +       '<button type="button" data-ch-view="archived" role="tab" class="px-3 py-1 text-xs font-bold rounded-md cursor-pointer">Archived</button>'
      +     '</div>'
      +   '</div>'
      +   '<div class="grow overflow-y-auto p-2" data-ch-list></div>'
      + '</div>';

    const listEl = container.querySelector('[data-ch-list]');
    const newBtn = container.querySelector('[data-ch-new]');
    const viewBtns = Array.prototype.slice.call(container.querySelectorAll('[data-ch-view]'));

    function paintTabs() {
      viewBtns.forEach(function (b) {
        const on = b.dataset.chView === view;
        b.className = 'px-3 py-1 text-xs font-bold rounded-md cursor-pointer transition '
          + (on ? 'bg-emerald-50 text-emerald-800' : 'text-gray-500 hover:bg-gray-100');
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }

    function renderRows() {
      if (loading) {
        listEl.innerHTML = '<p class="text-center text-xs text-gray-400 py-8">Loading…</p>';
        return;
      }
      if (!rows.length) {
        listEl.innerHTML = '<p class="text-center text-xs text-gray-400 py-8">'
          + (view === 'archived' ? 'Nothing archived yet.' : 'No past conversations yet.')
          + '</p>';
        return;
      }
      listEl.innerHTML = rows.map(function (r) {
        const isCurrent = currentSessionId != null && r.id === currentSessionId;
        // An empty thread has nothing to show and nothing to resume, but it IS real (the session
        // is created before the first turn is persisted) — label it rather than hide it.
        const preview = r.preview
          ? escapeHtml(r.preview)
          : '<span class="italic text-gray-400">Empty conversation</span>';
        const meta = [relativeTime(r.lastMessageAt || r.updatedAt), (r.messageCount || 0) + ' messages']
          .filter(Boolean).join(' · ');
        return ''
          + '<div class="group relative rounded-lg mb-1 ' + (isCurrent ? 'bg-emerald-50' : 'hover:bg-gray-50') + '">'
          +   '<button type="button" data-ch-open="' + r.id + '" '
          +     'class="w-full text-left px-3 py-2.5 pr-9 cursor-pointer">'
          +     '<p class="text-xs font-semibold text-gray-800 line-clamp-2">' + preview + '</p>'
          +     '<p class="text-[11px] text-gray-400 mt-1">' + escapeHtml(meta)
          +       (isCurrent ? ' · <span class="text-emerald-700 font-bold">current</span>' : '')
          +     '</p>'
          +   '</button>'
          +   '<button type="button" data-ch-archive="' + r.id + '" data-ch-to="'
          +     (view === 'archived' ? 'active' : 'archived') + '" '
          +     'title="' + (view === 'archived' ? 'Restore this conversation' : 'Archive this conversation') + '" '
          +     'aria-label="' + (view === 'archived' ? 'Restore conversation' : 'Archive conversation') + '" '
          +     'class="absolute top-2 right-2 w-6 h-6 rounded-md text-gray-400 hover:text-gray-700 '
          +     'hover:bg-gray-200 text-xs leading-none opacity-0 group-hover:opacity-100 focus:opacity-100 transition cursor-pointer">'
          +     (view === 'archived' ? '&#8630;' : '&#128451;')
          +   '</button>'
          + '</div>';
      }).join('');
    }

    function load() {
      loading = true;
      renderRows();
      return fetch('/.netlify/functions/list-chat-sessions?limit=50&status=' + view
          + '&aiAssistantId=' + assistantId, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (d) {
          if (destroyed) return;
          loading = false;
          rows = (d && d.sessions) || [];
          renderRows();
        });
    }

    function setStatus(id, to) {
      return fetch('/.netlify/functions/archive-chat-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ chatSessionId: id, status: to }),
      })
        .then(function (r) { return r.ok; })
        .catch(function () { return false; });
    }

    function onClick(e) {
      const openBtn = e.target.closest('[data-ch-open]');
      if (openBtn) {
        const id = Number(openBtn.dataset.chOpen);
        // Archived threads open read-only — the orchestrator refuses writes to them.
        onSelect(id, { readOnly: view === 'archived' });
        return;
      }
      const archiveBtn = e.target.closest('[data-ch-archive]');
      if (archiveBtn) {
        const id = Number(archiveBtn.dataset.chArchive);
        const to = archiveBtn.dataset.chTo;
        archiveBtn.disabled = true;
        setStatus(id, to).then(function (ok) {
          if (destroyed) return;
          if (!ok) { archiveBtn.disabled = false; return; }
          // Archiving the conversation on screen leaves the caller showing a thread that can no
          // longer take a turn, so hand back to a fresh one.
          if (to === 'archived' && currentSessionId === id) { currentSessionId = null; onNew(); }
          load();
        });
      }
    }

    container.addEventListener('click', onClick);
    newBtn.addEventListener('click', function () { onNew(); });
    viewBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        if (view === b.dataset.chView) return;
        view = b.dataset.chView;
        paintTabs();
        load();
      });
    });

    paintTabs();
    load();

    return {
      refresh: load,
      setCurrentSession: function (id) {
        currentSessionId = id != null ? Number(id) : null;
        renderRows();
      },
      destroy: function () {
        destroyed = true;
        container.removeEventListener('click', onClick);
        container.innerHTML = '';
      },
    };
  }

  window.ChatHistoryPanel = { mount: mount };
})();
