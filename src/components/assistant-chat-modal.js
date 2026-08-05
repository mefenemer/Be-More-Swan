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
 *   openAssistantChat({ assistantId?, sessionId?, forceNew? })
 *       assistantId  — resume that assistant's newest active thread, or start one if it has none.
 *       sessionId    — continue this exact thread (wins over assistantId).
 *       forceNew     — with assistantId, skip the resume and start a fresh thread.
 *   closeAssistantChat()                             — close + tear down the ChatSession.
 *
 * The header's "History" button opens a drawer (chat-history-panel.js) listing this assistant's
 * past conversations, with archive/restore and "New conversation". Picking a thread re-mounts the
 * ChatSession in place; archived threads mount read-only, because the orchestrator refuses writes
 * to them.
 *
 * Requires (already loaded by workspace.html): src/components/chat-session.js,
 * chat-history-panel.js, assistant-starter-prompts.js, disruptive-ui-registry.js,
 * marked@12 + dompurify@3.
 */
(function () {
  'use strict';

  var state = { injected: false, chat: null, history: null, assistantId: null, escHandler: null };

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
    + '.bms-chat-body{flex:1;min-height:0;position:relative;overflow:hidden;}'
    + '.bms-chat-mount{position:absolute;inset:0;}'
    // History drawer: slides in over the transcript from the left. transform (not display) so it
    // animates, and so the panel keeps its scroll position between opens.
    + '.bms-chat-history{position:absolute;top:0;left:0;bottom:0;width:270px;max-width:80%;'
    + 'background:#fff;border-right:1px solid #e5e7eb;box-shadow:6px 0 18px rgba(0,0,0,.06);'
    + 'transform:translateX(-102%);transition:transform .18s ease;z-index:2;}'
    + '.bms-chat-history.ac-open{transform:translateX(0);}'
    + '.bms-chat-headbtn{background:#f3f4f6;border:0;border-radius:8px;height:32px;padding:0 10px;'
    + 'font-size:12px;font-weight:700;line-height:1;cursor:pointer;color:#374151;flex-shrink:0;}'
    + '.bms-chat-headbtn:hover{background:#e5e7eb;}'
    + '.bms-chat-headbtn.ac-on{background:#fce7f3;color:#9d174d;}'
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
    +     '<button type="button" class="bms-chat-headbtn" id="bms-chat-history-btn" aria-expanded="false" '
    +       'title="Past conversations">History</button>'
    +     '<button type="button" class="bms-chat-close" id="bms-chat-close" aria-label="Close chat">&times;</button>'
    +   '</div>'
    +   '<div class="bms-chat-disclosure" role="note">'
    +     '<svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20" style="flex-shrink:0"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clip-rule="evenodd"/></svg>'
    +     '<span>You are interacting with an AI assistant. AI-generated content may be inaccurate — always review before sending or publishing.</span>'
    +   '</div>'
    +   '<div class="bms-chat-body">'
    +     '<div class="bms-chat-mount" id="bms-chat-mount"></div>'
    +     '<div class="bms-chat-history" id="bms-chat-history"></div>'
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
    el('bms-chat-history-btn').addEventListener('click', function () {
      setHistoryOpen(!el('bms-chat-history').classList.contains('ac-open'));
    });
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

  // Newest active thread with this assistant, or null. Any failure resolves to null so a
  // history outage degrades to "start a new conversation" rather than blocking the chat.
  function findLatestSession(assistantId) {
    return fetch('/.netlify/functions/list-chat-sessions?limit=1&status=active&aiAssistantId=' + assistantId,
      { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var rows = (d && d.sessions) || [];
        return rows.length ? rows[0].id : null;
      })
      .catch(function () { return null; });
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
            status: data.session.status,
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
          status: null,
          initialMessages: [],
        };
      })
      .catch(function () { return null; });
  }

  // Mount (or re-mount) one conversation into the open modal. Shared by the initial open and by
  // every pick in the history drawer, so a drawer selection behaves exactly like opening it.
  //   cfg: { assistantId, sessionId, forceNew, readOnly }
  function loadConversation(cfg) {
    var assistantId = cfg.assistantId;
    var sessionId = cfg.sessionId;

    if (state.chat && state.chat.destroy) { state.chat.destroy(); state.chat = null; }
    el('bms-chat-mount').innerHTML = '';
    showState('loading');

    // Continuity: opening an assistant with no explicit sessionId resumes that assistant's
    // newest active thread instead of silently minting a new one every time (which is what
    // stranded every prior conversation). forceNew is the deliberate "New conversation" escape.
    var autoResume = !sessionId && !cfg.forceNew && !!assistantId;
    var resolveSession = autoResume ? findLatestSession(assistantId) : Promise.resolve(sessionId);

    return resolveSession
      .then(function (resumedId) {
        return resolveConversation(assistantId, resumedId).then(function (info) {
          // An auto-resumed thread that won't hydrate (archived or deleted between the two
          // calls) is not an error the user asked for — fall through to a new conversation.
          // A sessionId the CALLER passed still surfaces as an error, as it did before.
          if (!info && resumedId && autoResume) return resolveConversation(assistantId, null);
          return info;
        });
      })
      .then(function (info) {
        // Guard against a race where the user closed the modal before this resolved.
        if (!el('bms-chat-backdrop').classList.contains('ac-open')) return null;
        if (!info) {
          showState('error', 'This conversation could not be found in your workspace.');
          return null;
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
          // Authoritative: an archived thread is read-only however it was reached — the drawer's
          // hint is only a fast path, the session's own status is the truth.
          readOnly: cfg.readOnly === true || info.status === 'archived',
        });
        state.assistantId = info.assistantId;
        if (state.history) state.history.setCurrentSession(info.sessionId);
        return info;
      });
  }

  function setHistoryOpen(open) {
    var drawer = el('bms-chat-history');
    var btn = el('bms-chat-history-btn');
    if (!drawer || !btn) return;
    drawer.classList.toggle('ac-open', open);
    btn.classList.toggle('ac-on', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Re-read on every open: a thread created since the last look (or archived on another
    // surface) should be there, and the panel is cheap to refresh.
    if (open && state.history) state.history.refresh();
  }

  function mountHistory(assistantId) {
    if (state.history && state.history.destroy) { state.history.destroy(); state.history = null; }
    var host = el('bms-chat-history');
    if (!host || !window.ChatHistoryPanel) return;
    state.history = window.ChatHistoryPanel.mount({
      container: host,
      assistantId: assistantId,
      currentSessionId: state.chat ? state.chat.getSessionId() : null,
      onSelect: function (id, o) {
        setHistoryOpen(false);
        loadConversation({ assistantId: assistantId, sessionId: id, readOnly: o && o.readOnly });
      },
      onNew: function () {
        setHistoryOpen(false);
        loadConversation({ assistantId: assistantId, forceNew: true });
      },
    });
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
    el('bms-chat-name').textContent = '';
    el('bms-chat-role').textContent = '';
    setHistoryOpen(false);

    el('bms-chat-backdrop').classList.add('ac-open');
    window.ScrollLock.lock('assistant-chat');

    state.escHandler = function (e) {
      // Esc closes the drawer first when it is open — closing the whole modal would lose the
      // conversation the user is in the middle of picking.
      if (e.key !== 'Escape') return;
      if (el('bms-chat-history').classList.contains('ac-open')) setHistoryOpen(false);
      else closeAssistantChat();
    };
    document.addEventListener('keydown', state.escHandler);

    if (!sessionId && (!Number.isInteger(assistantId) || assistantId <= 0)) {
      showState('error', 'No assistant was specified — open a conversation from your workspace.');
      return;
    }

    loadConversation({
      assistantId: assistantId,
      sessionId: sessionId,
      forceNew: opts.forceNew,
    }).then(function (info) {
      // The drawer needs the resolved assistant id — a caller may have passed only a sessionId.
      if (info) mountHistory(info.assistantId);
    });
  }

  function closeAssistantChat() {
    if (!state.injected) return;
    if (state.chat && state.chat.destroy) { state.chat.destroy(); state.chat = null; }
    if (state.history && state.history.destroy) { state.history.destroy(); state.history = null; }
    setHistoryOpen(false);
    el('bms-chat-backdrop').classList.remove('ac-open');
    window.ScrollLock.release('assistant-chat');
    if (state.escHandler) { document.removeEventListener('keydown', state.escHandler); state.escHandler = null; }
  }

  window.openAssistantChat = openAssistantChat;
  window.closeAssistantChat = closeAssistantChat;
})();
