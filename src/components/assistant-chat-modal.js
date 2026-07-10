/**
 * src/components/assistant-chat-modal.js
 *
 * Assistant chat as a native in-SPA popup modal.
 *
 * Issue #197 gave every Assistant Detail tab a header "Chat" CTA that redirected to the
 * standalone assistant-chat.html page. This module hosts that same conversation as a popup
 * instead, so the user never loses their place on the Detail page. It mirrors the identity
 * resolution + ChatSession mount that assistant-chat.html performs, but inside a backdrop
 * dialog it injects on first open.
 *
 * Public API (attached to window):
 *   openAssistantChat({ assistantId?, sessionId? })  — open the modal (assistantId for a new
 *                                                       thread, sessionId to continue one).
 *   closeAssistantChat()                             — close + tear down the ChatSession.
 *
 * Requires (already loaded by workspace.html): src/components/chat-session.js,
 * assistant-starter-prompts.js, disruptive-ui-registry.js, marked@12 + dompurify@3.
 */
(function () {
  'use strict';

  var state = { injected: false, chat: null, escHandler: null };

  function el(id) { return document.getElementById(id); }

  var STYLES = ''
    + '#bms-chat-backdrop{position:fixed;inset:0;z-index:90;background:rgba(17,24,39,.6);'
    + '-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);display:none;'
    + 'align-items:center;justify-content:center;padding:24px;}'
    + '#bms-chat-backdrop.ac-open{display:flex;}'
    + '.bms-chat-panel{width:100%;max-width:720px;height:min(80vh,760px);background:#f9fafb;'
    + 'border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.35);display:flex;flex-direction:column;'
    + 'overflow:hidden;position:relative;}'
    + '.bms-chat-head{display:flex;align-items:center;gap:12px;padding:16px 20px;background:#fff;'
    + 'border-bottom:1px solid #e5e7eb;}'
    + '.bms-chat-avatar{width:40px;height:40px;border-radius:9999px;background:#fce7f3;'
    + 'display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;}'
    + '.bms-chat-id{min-width:0;flex:1;}'
    + '.bms-chat-name{font-weight:700;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.bms-chat-role{font-size:12px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.bms-chat-close{background:#f3f4f6;border:0;border-radius:8px;width:32px;height:32px;'
    + 'font-size:18px;line-height:1;cursor:pointer;color:#374151;flex-shrink:0;}'
    + '.bms-chat-close:hover{background:#e5e7eb;}'
    + '.bms-chat-disclosure{display:flex;align-items:center;gap:8px;padding:8px 20px;'
    + 'background:#eff6ff;border-bottom:1px solid #dbeafe;font-size:11px;color:#1d4ed8;font-weight:500;}'
    + '.bms-chat-body{flex:1;min-height:0;position:relative;}'
    + '.bms-chat-mount{position:absolute;inset:0;}'
    + '.bms-chat-state{position:absolute;inset:0;display:flex;flex-direction:column;'
    + 'align-items:center;justify-content:center;gap:8px;text-align:center;padding:32px;color:#6b7280;}'
    + '.ac-hidden{display:none !important;}';

  var MARKUP = ''
    + '<div class="bms-chat-panel" role="dialog" aria-modal="true" aria-label="Chat with your assistant">'
    +   '<div class="bms-chat-head">'
    +     '<div class="bms-chat-avatar">💬</div>'
    +     '<div class="bms-chat-id">'
    +       '<div class="bms-chat-name" id="bms-chat-name"></div>'
    +       '<div class="bms-chat-role" id="bms-chat-role"></div>'
    +     '</div>'
    +     '<button type="button" class="bms-chat-close" id="bms-chat-close" aria-label="Close chat">&times;</button>'
    +   '</div>'
    +   '<div class="bms-chat-disclosure" role="note">'
    +     '<svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20" style="flex-shrink:0"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clip-rule="evenodd"/></svg>'
    +     '<span>You are interacting with an AI assistant. AI-generated content may be inaccurate — always review before sending or publishing.</span>'
    +   '</div>'
    +   '<div class="bms-chat-body">'
    +     '<div class="bms-chat-mount" id="bms-chat-mount"></div>'
    +     '<div class="bms-chat-state" id="bms-chat-loading">Loading your assistant…</div>'
    +     '<div class="bms-chat-state ac-hidden" id="bms-chat-errstate">'
    +       '<div style="width:48px;height:48px;border-radius:9999px;background:#fef3c7;display:flex;align-items:center;justify-content:center;font-size:24px">🤔</div>'
    +       '<p style="font-weight:700;color:#111827">We couldn\'t open this conversation</p>'
    +       '<p id="bms-chat-errdetail" style="font-size:13px">The assistant could not be found.</p>'
    +     '</div>'
    +   '</div>'
    + '</div>';

  function inject() {
    if (state.injected) return;
    var style = document.createElement('style');
    style.id = 'bms-chat-modal-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);

    var backdrop = document.createElement('div');
    backdrop.id = 'bms-chat-backdrop';
    backdrop.innerHTML = MARKUP;
    document.body.appendChild(backdrop);

    el('bms-chat-close').addEventListener('click', closeAssistantChat);
    // Click on the dimmed backdrop (outside the panel) closes.
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeAssistantChat();
    });

    state.injected = true;
  }

  function showState(which, detail) {
    el('bms-chat-loading').classList.toggle('ac-hidden', which !== 'loading');
    el('bms-chat-errstate').classList.toggle('ac-hidden', which !== 'error');
    el('bms-chat-mount').classList.toggle('ac-hidden', which !== 'chat');
    if (which === 'error' && detail) el('bms-chat-errdetail').textContent = detail;
  }

  // Resolve the assistant's identity (mirrors assistant-chat.html): a sessionId continues an
  // existing thread and hydrates its transcript; an assistantId starts a fresh conversation.
  function resolveConversation(assistantId, sessionId) {
    if (sessionId) {
      return fetch('/.netlify/functions/get-chat-session?chatSessionId=' + sessionId, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || !data.session) return null;
          return {
            assistantId: data.session.aiAssistantId,
            assistantName: data.session.assistantName,
            assistantRole: data.session.assistantRole,
            assistantRoleKey: null,
            sessionId: sessionId,
            initialMessages: data.messages || [],
          };
        })
        .catch(function () { return null; });
    }
    return fetch('/.netlify/functions/get-assistants', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var a = data && (data.assistants || []).find(function (x) { return x.id === assistantId; });
        if (!a) return null;
        return {
          assistantId: assistantId,
          assistantName: a.name,
          assistantRole: a.role,
          assistantRoleKey: a.roleKey,
          sessionId: null,
          initialMessages: [],
        };
      })
      .catch(function () { return null; });
  }

  function openAssistantChat(opts) {
    opts = opts || {};
    var assistantId = opts.assistantId != null ? Number(opts.assistantId) : null;
    var sessionId = opts.sessionId != null ? Number(opts.sessionId) : null;

    if (!window.ChatSession || typeof window.ChatSession.mount !== 'function') {
      // ChatSession isn't on this page — fall back to the standalone chat page.
      if (assistantId) window.location.href = 'assistant-chat.html?assistantId=' + assistantId;
      return;
    }

    inject();
    // Tear down any prior conversation before opening a new one.
    if (state.chat && state.chat.destroy) { state.chat.destroy(); state.chat = null; }
    el('bms-chat-mount').innerHTML = '';
    el('bms-chat-name').textContent = '';
    el('bms-chat-role').textContent = '';
    showState('loading');

    el('bms-chat-backdrop').classList.add('ac-open');
    document.body.style.overflow = 'hidden';

    state.escHandler = function (e) { if (e.key === 'Escape') closeAssistantChat(); };
    document.addEventListener('keydown', state.escHandler);

    if (!sessionId && (!Number.isInteger(assistantId) || assistantId <= 0)) {
      showState('error', 'No assistant was specified — open a conversation from your workspace.');
      return;
    }

    resolveConversation(assistantId, sessionId).then(function (info) {
      // Guard against a race where the user closed the modal before this resolved.
      if (!el('bms-chat-backdrop').classList.contains('ac-open')) return;
      if (!info) {
        showState('error', 'This conversation could not be found in your workspace.');
        return;
      }
      el('bms-chat-name').textContent = info.assistantName || 'Your assistant';
      el('bms-chat-role').textContent = info.assistantRole || 'Digital Assistant';
      showState('chat');
      state.chat = window.ChatSession.mount({
        container: el('bms-chat-mount'),
        assistantId: info.assistantId,
        chatSessionId: info.sessionId,
        assistantName: info.assistantName,
        roleKey: info.assistantRoleKey,
        initialMessages: info.initialMessages,
      });
    });
  }

  function closeAssistantChat() {
    if (!state.injected) return;
    if (state.chat && state.chat.destroy) { state.chat.destroy(); state.chat = null; }
    el('bms-chat-backdrop').classList.remove('ac-open');
    document.body.style.overflow = '';
    if (state.escHandler) { document.removeEventListener('keydown', state.escHandler); state.escHandler = null; }
  }

  window.openAssistantChat = openAssistantChat;
  window.closeAssistantChat = closeAssistantChat;
})();
