/**
 * src/components/chat-pane.js — an assistant's chat DOCKED beside what it works on (owner, 2026-11-05:
 * "loving the chat pane on the right"). First built inside the Website tab; shared here so every
 * assistant's editor can have one: the Website tab (assistant-site-editor.js), the Blog Studio
 * (blog-studio-modal.js), the post editor (workspace.html), and next the email designer.
 *
 *   const pane = window.ChatPane.mount(container, {
 *     assistantId, assistantName, roleKey,
 *     rememberKey,        // localStorage key for "carry on this thread here" (e.g. 'bms-site-chat:63')
 *     placeholder?, starterPrompts?, composerRows? (default 4), title?,
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
    container.innerHTML = `<div data-chatpane class="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden flex flex-col" style="height:100%">
        <div class="flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-200" style="flex-shrink:0">
          <p class="text-sm font-black text-gray-900 truncate">${esc(opts.title || `Chat with ${opts.assistantName || 'your assistant'}`)}</p>
          <span class="flex items-center gap-1" style="flex-shrink:0"><button type="button" data-chatpane-new title="Start a new conversation" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">New chat</button>${opts.onClose ? '<button type="button" data-chatpane-close aria-label="Close the chat" class="px-2 py-1 text-lg leading-none text-gray-500 hover:text-gray-900">&times;</button>' : ''}</span>
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
        composerRows: opts.composerRows || 4,
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

  window.ChatPane = { mount, available };
})();
