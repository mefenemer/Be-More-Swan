/**
 * src/components/chat-pane.js — an assistant's chat DOCKED beside what it works on (owner, 2026-11-05:
 * "loving the chat pane on the right"). First built inside the Website tab; shared here so every
 * assistant's editor can have one: the Website tab (assistant-site-editor.js), the Blog Studio
 * (blog-studio-modal.js), the post editor (workspace.html), the Email Studio (newsletter.js), and through dock() below the Briefs and Videos tabs.
 *
 *   const pane = window.ChatPane.mount(container, {
 *     assistantId, assistantName, roleKey,
 *     rememberKey,        // localStorage key for "carry on this thread here" (e.g. 'bms-site-chat:63')
 *     placeholder?, starterPrompts?, title?,
 *     tallComposer?, composerRows?   // a tall message box (the Website tab); otherwise one line that grows
 *     draftTarget?        // () => the post this chat is about, or null: see chat-session.js
 *     turnContext?        // () => extra fields sent with every turn (the Email Studio's forIssueId)
 *     onClose?            // a ✕ on the pane: for where it covers the page and its own toggle
 *     onCollapse?(collapsed)   // the pane was folded to its strip or opened again (the page's work changed width)
 *     collapseKey?        // localStorage key for "folded"; by default one per surface, from rememberKey's prefix
 *   });
 *   pane.setReference({ label, message })   — "Select": a part of the page on a chip above the box
 *   pane.focus();  pane.ready (Promise);  pane.destroy();  pane.setCollapsed(bool);  pane.isCollapsed();
 *
 * Collapsible (owner, 2026-11-09): the » in the header folds the pane to a slim strip (the assistant's icon
 * and "Chat"), so the work gets the room; a click on the strip opens it again. Where the pane is full width
 * (the Website tab on a phone) the strip lies flat as a bar. Each surface's column shrinks with it through
 * a `:has(.is-collapsed[data-chatpane])` rule beside that surface's own layout CSS. Select, the page's Chat
 * button and send() open a folded pane first. Remembered per surface in this browser.
 *
 * The conversation is the ordinary one (chat-session.js) — every change still arrives as a card the
 * user approves. The thread is remembered per surface in this browser, so coming back carries on —
 * unless nothing was said in it for a day (STALE_MS), when a new chat starts (owner, 2026-11-06).
 * "New chat" starts again; "History" (chat-history-panel.js, the pop-up chat's drawer) lists this
 * assistant's chats, so an earlier one is one click away. An archived, missing or other assistant's
 * thread is never resumed by itself; one picked from History's Archived list opens read-only.
 * Requires chat-session.js (window.ChatSession) and its card registry on the page.
 */
(function () {
  'use strict';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const read = (k) => { try { return Number(localStorage.getItem(k)) || null; } catch { return null; } };
  const write = (k, id) => { try { if (id) localStorage.setItem(k, String(id)); else localStorage.removeItem(k); } catch { /* private window */ } };

  /** A remembered thread nobody has said anything in for this long opens as a new chat instead. */
  const STALE_MS = 24 * 60 * 60 * 1000;

  function available() { return !!(window.ChatSession && typeof window.ChatSession.mount === 'function'); }

  /**
   * Wake the chat function while the user is still reading or typing. A cold chat-orchestrator took
   * 3–3.9 s on staging (2026-11-06) before it even looked at a message, and the first message after
   * opening a pane paid all of it. A GET is answered 405 before any database or model work (the
   * handler's first line), so this costs one tiny invocation; at most once every four minutes, about
   * as long as an idle function instance is kept.
   */
  let warmedAt = 0;
  function warm() {
    if (Date.now() - warmedAt < 4 * 60 * 1000) return;
    warmedAt = Date.now();
    try { fetch('/.netlify/functions/chat-orchestrator', { method: 'GET', credentials: 'same-origin' }).catch(() => {}); } catch { /* never in the way */ }
  }

  // Every pane and dock on the page: what the page's own Chat button reaches, and what a rename updates.
  const panes = new Set();
  const docks = new Set();
  const onScreen = (el) => !!el && el.isConnected && el.getClientRects().length > 0;

  /**
   * The page's Chat button (the right-hand menu's, or the header's on a phone): bring up the chat docked on
   * this tab, opening it if it was closed. False when this tab has none, so the caller opens the pop-up.
   */
  function focusOnScreen() {
    for (const d of docks) {
      if (d.connected() && onScreen(d.layout)) { d.setOn(true, true); return true; }
    }
    for (const p of panes) {
      if (onScreen(p.container)) { p.focus(); return true; }
    }
    return false;
  }
  function renameAll(assistantId, name) {
    panes.forEach((p) => { if (Number(p.assistantId) === Number(assistantId)) p.rename(name); });
  }

  /** The strip a folded pane shows, on every surface (each surface's own CSS shrinks its column). */
  function injectCss() {
    if (document.getElementById('chatpane-css')) return;
    const css = document.createElement('style');
    css.id = 'chatpane-css';
    css.textContent = `
      [data-chatpane].is-collapsed { height: auto !important; }
      [data-chatpane].is-collapsed > :not([data-chatpane-rail]) { display: none !important; }
      [data-chatpane-rail] { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; padding: 12px 0; background: none; border: 0; cursor: pointer; color: #4b5563; }
      [data-chatpane-rail][hidden] { display: none; }
      [data-chatpane-rail]:hover { background: #f9fafb; color: #111827; }
      [data-chatpane-rail]:focus-visible { outline: 2px solid #db2777; outline-offset: -2px; }
      [data-chatpane-rail] .chatpane-rail-label { writing-mode: vertical-rl; transform: rotate(180deg); font-size: 12px; font-weight: 800; letter-spacing: .02em; }
      [data-chatpane].is-bar [data-chatpane-rail] { flex-direction: row; justify-content: flex-start; padding: 8px 14px; }
      [data-chatpane].is-bar [data-chatpane-rail] .chatpane-rail-label { writing-mode: horizontal-tb; transform: none; font-size: 13px; }
      [data-chatpane].is-bar [data-chatpane-rail] .chatpane-rail-chev { margin-left: auto; transform: rotate(-90deg); }`;
    document.head.appendChild(css);
  }
  const readFlag = (k) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
  const writeFlag = (k, on) => { try { if (on) localStorage.setItem(k, '1'); else localStorage.removeItem(k); } catch { /* private window */ } };

  function mount(container, opts) {
    opts = opts || {};
    warm();
    injectCss();
    const key = opts.rememberKey || null;
    const collapseKey = opts.collapseKey || `bms-chatpane-folded:${String(opts.rememberKey || 'chat').split(':')[0]}`;
    let session = null;
    let destroyed = false;
    let pendingRef = null;
    // The assistant's own icon (the colour and letter it has on its card), so the pane reads as THAT assistant.
    const AC = window.AssistantColors;
    const avatarColor = AC && AC.colorFor ? AC.colorFor(opts.assistantId) : '#10b981';
    const avatarLetter = AC && AC.letterFor ? AC.letterFor(opts.assistantId, opts.assistantName) : (String(opts.assistantName || 'A').trim()[0] || 'A').toUpperCase();
    container.innerHTML = `<div data-chatpane class="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden flex flex-col" style="height:100%">
        <div class="flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-200" style="flex-shrink:0">
          <span class="flex items-center gap-2 min-w-0">
            <span aria-hidden="true" data-chatpane-avatar style="position:relative;flex-shrink:0;width:28px;height:28px;border-radius:9999px;background:${esc(avatarColor)};color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:800">${esc(avatarLetter)}<span style="position:absolute;right:-1px;bottom:-1px;width:9px;height:9px;border-radius:9999px;background:#22c55e;border:2px solid #fff"></span></span>
            <p data-chatpane-title class="text-sm font-black text-gray-900 truncate">${esc(opts.title || `Chat with ${opts.assistantName || 'your assistant'}`)}</p>
          </span>
          <span class="flex items-center gap-1" style="flex-shrink:0">${window.ChatHistoryPanel ? '<button type="button" data-chatpane-history aria-expanded="false" aria-label="Past chats" title="Past chats" class="inline-flex items-center px-2 py-1 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg" style="background:none;border:0;cursor:pointer"><svg aria-hidden="true" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 2m6-2a9 9 0 11-9-9 9 9 0 019 9z"/></svg></button>' : ''}<button type="button" data-chatpane-new title="Start a new conversation" class="inline-flex items-center gap-1 px-2 py-1 text-xs font-bold text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg" style="background:none;border:0;cursor:pointer"><span aria-hidden="true">+</span> New chat</button><button type="button" data-chatpane-collapse aria-expanded="true" aria-label="Collapse the chat" title="Collapse the chat" class="inline-flex items-center px-2 py-1 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg" style="background:none;border:0;cursor:pointer"><svg aria-hidden="true" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7"/></svg></button>${opts.onClose ? '<button type="button" data-chatpane-close aria-label="Close the chat" class="px-2 py-1 text-lg leading-none text-gray-500 hover:text-gray-900">&times;</button>' : ''}</span>
        </div>
        <div style="position:relative;flex:1;min-height:0;overflow:hidden"><div data-chatpane-mount style="position:absolute;inset:0"><p class="text-sm text-gray-500 text-center p-8">Loading the chat…</p></div>
          <div data-chatpane-drawer hidden style="position:absolute;top:0;left:0;bottom:0;width:280px;max-width:88%;background:#fff;border-right:1px solid #e5e7eb;box-shadow:6px 0 18px rgba(0,0,0,.08);z-index:2"></div></div>
        <button type="button" data-chatpane-rail hidden aria-expanded="false" aria-label="Expand the chat" title="Expand the chat">
          <span aria-hidden="true" data-chatpane-rail-avatar style="flex-shrink:0;width:28px;height:28px;border-radius:9999px;background:${esc(avatarColor)};color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:800">${esc(avatarLetter)}</span>
          <span class="chatpane-rail-label">Chat</span>
          <svg aria-hidden="true" class="chatpane-rail-chev w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7"/></svg>
        </button>
      </div>`;
    const rootEl = container.querySelector('[data-chatpane]');
    const railEl = container.querySelector('[data-chatpane-rail]');
    const mountEl = container.querySelector('[data-chatpane-mount]');
    const drawerEl = container.querySelector('[data-chatpane-drawer]');
    const historyBtn = container.querySelector('[data-chatpane-history]');
    let history = null;
    let viewingArchived = false;   // an archived chat picked in History: read-only, so sending starts a new one

    // ── History: the pop-up chat's drawer, over the conversation from the left ──
    function setHistoryOpen(open) {
      if (!drawerEl || !historyBtn) return;
      if (open && !history && window.ChatHistoryPanel) {
        history = window.ChatHistoryPanel.mount({
          container: drawerEl,
          assistantId: opts.assistantId,
          currentSessionId: session && session.getSessionId ? session.getSessionId() : null,
          onSelect: (id, o) => {
            setHistoryOpen(false);
            const readOnly = !!(o && o.readOnly);
            if (key) write(key, readOnly ? null : id);
            api.ready = start(id, { picked: true, readOnly });
          },
          onNew: () => { setHistoryOpen(false); if (key) write(key, null); api.ready = start(null); },
        });
      } else if (open && history) {
        if (history.setCurrentSession) history.setCurrentSession(session && session.getSessionId ? session.getSessionId() : null);
        history.refresh();
      }
      drawerEl.hidden = !open;
      historyBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    /** opts2.picked — chosen in History: no "a day old" check, and an archived one opens read-only. */
    async function start(sessionId, opts2) {
      opts2 = opts2 || {};
      if (session && session.destroy) { try { session.destroy(); } catch { /* gone */ } }
      session = null;
      let initialMessages = [];
      let chatSessionId = null;
      if (sessionId) {
        try {
          const r = await fetch(`/.netlify/functions/get-chat-session?chatSessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' });
          const d = r.ok ? await r.json() : null;
          const msgs = (d && d.messages) || [];
          const last = msgs.length ? msgs[msgs.length - 1].createdAt : d && d.session && d.session.updatedAt;
          const stale = !opts2.picked && last && Date.now() - new Date(last).getTime() > STALE_MS;
          const archived = d && d.session && d.session.status === 'archived';
          if (d && d.session && Number(d.session.aiAssistantId) === Number(opts.assistantId) && !stale && (!archived || opts2.readOnly)) {
            chatSessionId = sessionId; initialMessages = msgs;
          } else if (key) write(key, null);
        } catch { /* start a new one */ }
      }
      if (destroyed || !mountEl.isConnected) return;
      viewingArchived = !!(opts2.readOnly && chatSessionId);
      session = window.ChatSession.mount({
        container: mountEl,
        assistantId: opts.assistantId,
        chatSessionId,
        assistantName: opts.assistantName,
        roleKey: opts.roleKey,
        initialMessages,
        readOnly: viewingArchived,
        placeholder: opts.placeholder,
        starterPrompts: chatSessionId ? null : opts.starterPrompts || null,
        // A docked pane is narrow and short: one line that grows as they type, Send inside it. Only the
        // Website tab keeps a tall box to describe a site in (owner, 2026-11-05): tallComposer.
        compactComposer: !opts.tallComposer,
        composerRows: opts.tallComposer ? opts.composerRows || 4 : 1,
        draftTarget: opts.draftTarget,
        turnContext: opts.turnContext,
        onSession: (id) => { if (key && !destroyed && !opts2.readOnly) write(key, id); },
      });
      if (pendingRef) { session.setReference(pendingRef); pendingRef = null; }
    }
    // ── Collapse: fold to the strip and back ──
    let collapsed = false;
    /** Flat as a bar where the pane is full width (the Website tab on a phone); upright as a strip beside the work. */
    function syncBar() {
      rootEl.classList.toggle('is-bar', collapsed && container.getBoundingClientRect().width > 140);
    }
    function setCollapsed(next, remember) {
      next = !!next;
      if (remember) writeFlag(collapseKey, next);
      if (next === collapsed) return;
      collapsed = next;
      if (collapsed) setHistoryOpen(false);
      rootEl.classList.toggle('is-collapsed', collapsed);
      railEl.hidden = !collapsed;
      const btn = container.querySelector('[data-chatpane-collapse]');
      if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      syncBar();
      requestAnimationFrame(syncBar);   // the column has the strip's width only once the page has laid out again
      if (opts.onCollapse) { try { opts.onCollapse(collapsed); } catch { /* the page's own business */ } }
    }
    const onResize = () => { if (collapsed) syncBar(); };
    window.addEventListener('resize', onResize);

    const onClick = (e) => {
      if (e.target.closest('[data-chatpane-collapse]')) { setCollapsed(true, true); railEl.focus(); return; }
      if (e.target.closest('[data-chatpane-rail]')) { setCollapsed(false, true); if (session) session.focus(); return; }
      if (e.target.closest('[data-chatpane-close]')) { opts.onClose(); return; }
      if (e.target.closest('[data-chatpane-history]')) { setHistoryOpen(drawerEl.hidden); return; }
      if (!e.target.closest('[data-chatpane-new]')) return;
      setHistoryOpen(false);
      if (key) write(key, null);
      api.ready = start(null);
    };
    container.addEventListener('click', onClick);

    const api = {
      container,
      /** The assistant was renamed while this pane is open: its header and the "I'm …" of an empty chat. */
      rename(name) {
        const was = opts.assistantName;
        opts.assistantName = name;
        if (session && session.setAssistantName) session.setAssistantName(name);
        const title = container.querySelector('[data-chatpane-title]');
        if (title && !opts.title) title.textContent = `Chat with ${name || 'your assistant'}`;
        const avatar = container.querySelector('[data-chatpane-avatar]');
        const letter = AC && AC.letterFor ? AC.letterFor(opts.assistantId, name) : (String(name || 'A').trim()[0] || 'A').toUpperCase();
        if (avatar && avatar.firstChild && was !== name) avatar.firstChild.textContent = letter;
        const railAvatar = container.querySelector('[data-chatpane-rail-avatar]');
        if (railAvatar && was !== name) railAvatar.textContent = letter;
      },
      get assistantId() { return opts.assistantId; },
      ready: start(key ? read(key) : null),
      /** A part of the page onto the chip above the message box (waits for the chat to be ready). */
      setReference(ref) { setCollapsed(false, true); if (session) session.setReference(ref); else pendingRef = ref; },
      /** Say this for the user, once the chat is ready ("New brief" on the Briefs tab). */
      send(text) {
        setCollapsed(false, true);
        if (viewingArchived) return api.sendFresh(text);
        return Promise.resolve(api.ready).then(() => (session ? session.sendMessage(text, { noReference: true }) : undefined));
      },
      /** "New chat", then say this: a new piece of work never continues the conversation on screen. */
      sendFresh(text) {
        if (key) write(key, null);
        api.ready = start(null);
        return api.send(text);
      },
      focus() { setCollapsed(false, true); if (session) session.focus(); },
      setCollapsed(next) { setCollapsed(next, true); },
      isCollapsed: () => collapsed,
      get session() { return session; },
      destroy() {
        destroyed = true;
        container.removeEventListener('click', onClick);
        window.removeEventListener('resize', onResize);
        if (history && history.destroy) { try { history.destroy(); } catch { /* gone */ } }
        history = null;
        if (session && session.destroy) { try { session.destroy(); } catch { /* gone */ } }
        session = null;
        container.innerHTML = '';
        panes.delete(api);
      },
    };
    panes.add(api);
    if (readFlag(collapseKey)) setCollapsed(true, false);
    return api;
  }

  /**
   * A tab that is a LIST of things (the Brand Designer's Briefs, the Video Producer's Videos): the list on the
   * left, the chat on the right, built around `host`, whose contents the tab keeps replacing. Sticky beside it
   * from 1280px; over the right edge below that, with its own ✕ because it covers the tab's toggle.
   *
   *   const d = ChatPane.dock(host, { prefix, storageKey, pane: () => mount options, onToggle?(on) });
   *   d.wanted(); d.isOn(); d.setOn(on, remember); d.refer({ label, message }); d.destroy();
   */
  function dock(host, opts) {
    if (!document.getElementById('chatpane-dock-css')) {
      const css = document.createElement('style');
      css.id = 'chatpane-dock-css';
      css.textContent = `
        .chatpane-dock-col { display: none; }
        .chatpane-dock.is-on > .chatpane-dock-col { display: block; }
        .chatpane-dock-col > div { height: 100%; }
        @media (min-width: 1280px) {
          .chatpane-dock.is-on { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 24px; align-items: start; }
          .chatpane-dock.is-on > .chatpane-dock-col { position: sticky; top: 76px; height: calc(100vh - 92px); }
          .chatpane-dock.is-on:has(> .chatpane-dock-col .is-collapsed[data-chatpane]) { grid-template-columns: minmax(0, 1fr) 56px; }
        }
        @media (max-width: 1279px) {
          .chatpane-dock.is-on > .chatpane-dock-col { position: fixed; top: 76px; right: 12px; bottom: 12px; z-index: 40; width: min(420px, calc(100vw - 24px)); box-shadow: 0 18px 50px rgba(0,0,0,.25); border-radius: 16px; }
          .chatpane-dock.is-on > .chatpane-dock-col:has(.is-collapsed[data-chatpane]) { width: 56px; bottom: auto; }
        }`;
      document.head.appendChild(css);
    }
    const layoutId = `${opts.prefix}-layout`;
    let layout = document.getElementById(layoutId);
    if (!layout) {
      layout = document.createElement('div');
      layout.id = layoutId;
      layout.className = 'chatpane-dock';
      host.parentNode.insertBefore(layout, host);
      layout.appendChild(host);
      host.classList.add('min-w-0');
      const col = document.createElement('aside');
      col.id = `${opts.prefix}-chat-col`;
      col.className = 'chatpane-dock-col';
      col.setAttribute('aria-label', 'Chat with your assistant');
      col.innerHTML = `<div id="${opts.prefix}-chat-host"></div>`;
      layout.appendChild(col);
    }
    layout.classList.remove('is-on');
    let on = false;
    let pane = null;
    const api = {
      layout,
      wanted() {
        try { const v = localStorage.getItem(opts.storageKey); if (v === '1' || v === '0') return v === '1'; } catch { /* private window */ }
        // On wherever it docks beside the tab rather than over it: with no button on the tab to ask for it,
        // the chat panel is simply there (owner, 2026-11-06). Its ✕ and the menu's Chat close and reopen it.
        return window.innerWidth >= 1280;
      },
      isOn: () => on,
      setOn(next, remember) {
        on = !!next;
        if (remember) { try { localStorage.setItem(opts.storageKey, on ? '1' : '0'); } catch { /* private window */ } }
        layout.classList.toggle('is-on', on);
        if (opts.onToggle) opts.onToggle(on);
        if (!on) return;
        if (pane) { pane.focus(); return; }
        pane = mount(document.getElementById(`${opts.prefix}-chat-host`), { ...opts.pane(), onClose: () => api.setOn(false, true) });
      },
      refer(ref) {
        if (!on) api.setOn(true, true);
        if (pane) pane.setReference(ref);
      },
      ask(text, { fresh = false } = {}) {
        if (!on) api.setOn(true, true);
        if (pane) { pane.focus(); if (fresh) pane.sendFresh(text); else pane.send(text); }
      },
      destroy() {
        if (pane) { try { pane.destroy(); } catch { /* gone */ } }
        pane = null; on = false;
        layout.classList.remove('is-on');
        docks.delete(api);
      },
      /** False once the page holding it has been replaced. */
      connected: () => layout.isConnected,
    };
    docks.add(api);
    return api;
  }

  window.ChatPane = { mount, available, dock, warm, focusOnScreen, renameAll };
})();
