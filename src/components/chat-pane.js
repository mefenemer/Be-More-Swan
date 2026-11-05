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
 *   });
 *   pane.setReference({ label, message })   — "Select": a part of the page on a chip above the box
 *   pane.focus();  pane.ready (Promise);  pane.destroy();
 *
 * The conversation is the ordinary one (chat-session.js) — every change still arrives as a card the
 * user approves. The thread is remembered per surface in this browser, so coming back carries on;
 * "New chat" starts again. An archived, missing or other assistant's thread is never resumed.
 * Requires chat-session.js (window.ChatSession) and its card registry on the page.
 */
(function () {
  'use strict';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const read = (k) => { try { return Number(localStorage.getItem(k)) || null; } catch { return null; } };
  const write = (k, id) => { try { if (id) localStorage.setItem(k, String(id)); else localStorage.removeItem(k); } catch { /* private window */ } };

  function available() { return !!(window.ChatSession && typeof window.ChatSession.mount === 'function'); }

  function mount(container, opts) {
    opts = opts || {};
    const key = opts.rememberKey || null;
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
            <p class="text-sm font-black text-gray-900 truncate">${esc(opts.title || `Chat with ${opts.assistantName || 'your assistant'}`)}</p>
          </span>
          <span class="flex items-center gap-1" style="flex-shrink:0"><button type="button" data-chatpane-new title="Start a new conversation" class="inline-flex items-center gap-1 px-2 py-1 text-xs font-bold text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg" style="background:none;border:0;cursor:pointer"><span aria-hidden="true">+</span> New chat</button>${opts.onClose ? '<button type="button" data-chatpane-close aria-label="Close the chat" class="px-2 py-1 text-lg leading-none text-gray-500 hover:text-gray-900">&times;</button>' : ''}</span>
        </div>
        <div style="position:relative;flex:1;min-height:0"><div data-chatpane-mount style="position:absolute;inset:0"><p class="text-sm text-gray-500 text-center p-8">Loading the chat…</p></div></div>
      </div>`;
    const mountEl = container.querySelector('[data-chatpane-mount]');

    async function start(sessionId) {
      if (session && session.destroy) { try { session.destroy(); } catch { /* gone */ } }
      session = null;
      let initialMessages = [];
      let chatSessionId = null;
      if (sessionId) {
        try {
          const r = await fetch(`/.netlify/functions/get-chat-session?chatSessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' });
          const d = r.ok ? await r.json() : null;
          if (d && d.session && Number(d.session.aiAssistantId) === Number(opts.assistantId) && d.session.status !== 'archived') {
            chatSessionId = sessionId; initialMessages = d.messages || [];
          } else if (key) write(key, null);
        } catch { /* start a new one */ }
      }
      if (destroyed || !mountEl.isConnected) return;
      session = window.ChatSession.mount({
        container: mountEl,
        assistantId: opts.assistantId,
        chatSessionId,
        assistantName: opts.assistantName,
        roleKey: opts.roleKey,
        initialMessages,
        placeholder: opts.placeholder,
        starterPrompts: chatSessionId ? null : opts.starterPrompts || null,
        // A docked pane is narrow and short: one line that grows as they type, Send inside it. Only the
        // Website tab keeps a tall box to describe a site in (owner, 2026-11-05): tallComposer.
        compactComposer: !opts.tallComposer,
        composerRows: opts.tallComposer ? opts.composerRows || 4 : 1,
        draftTarget: opts.draftTarget,
        turnContext: opts.turnContext,
        onSession: (id) => { if (key && !destroyed) write(key, id); },
      });
      if (pendingRef) { session.setReference(pendingRef); pendingRef = null; }
    }
    const onClick = (e) => {
      if (e.target.closest('[data-chatpane-close]')) { opts.onClose(); return; }
      if (!e.target.closest('[data-chatpane-new]')) return;
      if (key) write(key, null);
      api.ready = start(null);
    };
    container.addEventListener('click', onClick);

    const api = {
      ready: start(key ? read(key) : null),
      /** A part of the page onto the chip above the message box (waits for the chat to be ready). */
      setReference(ref) { if (session) session.setReference(ref); else pendingRef = ref; },
      /** Say this for the user, once the chat is ready ("New brief" on the Briefs tab). */
      send(text) { return Promise.resolve(api.ready).then(() => (session ? session.sendMessage(text, { noReference: true }) : undefined)); },
      /** "New chat", then say this: a new piece of work never continues the conversation on screen. */
      sendFresh(text) {
        if (key) write(key, null);
        api.ready = start(null);
        return api.send(text);
      },
      focus() { if (session) session.focus(); },
      get session() { return session; },
      destroy() {
        destroyed = true;
        container.removeEventListener('click', onClick);
        if (session && session.destroy) { try { session.destroy(); } catch { /* gone */ } }
        session = null;
        container.innerHTML = '';
      },
    };
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
        }
        @media (max-width: 1279px) {
          .chatpane-dock.is-on > .chatpane-dock-col { position: fixed; top: 76px; right: 12px; bottom: 12px; z-index: 40; width: min(420px, calc(100vw - 24px)); box-shadow: 0 18px 50px rgba(0,0,0,.25); border-radius: 16px; }
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
      wanted() {
        try { const v = localStorage.getItem(opts.storageKey); if (v === '1' || v === '0') return v === '1'; } catch { /* private window */ }
        return window.innerWidth >= 1440;   // on by default where the list keeps its room beside it
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
      },
      /** False once the page holding it has been replaced. */
      connected: () => layout.isConnected,
    };
    return api;
  }

  window.ChatPane = { mount, available, dock };
})();
