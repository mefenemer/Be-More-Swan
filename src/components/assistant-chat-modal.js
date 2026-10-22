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
 *   openAssistantChat({ assistantId?, sessionId?, forceNew?, draft?, send? })
 *       assistantId  — start a new chat with that assistant.
 *       sessionId    — continue this exact thread (wins over assistantId).
 *       forceNew     — kept for callers that pass it; every assistantId-only open is new anyway.
 *   closeAssistantChat()                             — close + tear down the ChatSession.
 *
 * The header's "New Chat" button starts a fresh thread in place. Its "History" button opens a drawer
 * (chat-history-panel.js) listing this assistant's past conversations, with archive/restore. Picking a thread re-mounts the
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
    // "This chat | Team" switch: the same assistant's Team Chat thread (team-feed.js) in place of
    // the conversation, so a brief or a question from the team is one click from the chat.
    + '.bms-chat-modes{display:inline-flex;background:#f3f4f6;border-radius:8px;padding:2px;flex-shrink:0;}'
    + '.bms-chat-mode{background:transparent;border:0;border-radius:6px;height:28px;padding:0 10px;'
    + 'font-size:12px;font-weight:700;color:#4b5563;cursor:pointer;}'
    + '.bms-chat-mode[aria-pressed="true"]{background:#fff;color:#111827;box-shadow:0 1px 2px rgba(0,0,0,.08);}'
    + '.bms-chat-team{position:absolute;inset:0;overflow-y:auto;padding:16px 20px;background:#fff;}'
    // Phone width: name + close on the first row, Chat|Team / New Chat / History on the second —
    // in one row they pushed the name to nothing and History and the close off the panel.
    + '@media (max-width:540px){.bms-chat-head{flex-wrap:wrap;row-gap:10px;padding:12px 16px;}'
    + '.bms-chat-id{flex:1 1 calc(100% - 108px);}.bms-chat-close{order:1;}'
    + '.bms-chat-modes,#bms-chat-new-btn,#bms-chat-history-btn{order:2;}}'
    + '.ac-hidden{display:none !important;}';

  var MARKUP = ''
    + '<div class="bms-chat-panel" role="dialog" aria-modal="true" aria-label="Chat with your assistant">'
    +   '<div class="bms-chat-head">'
    +     '<div class="bms-chat-avatar" id="bms-chat-avatar">💬</div>'
    +     '<div class="bms-chat-id">'
    +       '<div class="bms-chat-name" id="bms-chat-name"></div>'
    +       '<div class="bms-chat-role" id="bms-chat-role"></div>'
    +     '</div>'
    +     '<div class="bms-chat-modes" role="group" aria-label="Show">'
    +       '<button type="button" class="bms-chat-mode" id="bms-chat-mode-chat" aria-pressed="true">Chat</button>'
    +       '<button type="button" class="bms-chat-mode" id="bms-chat-mode-team" aria-pressed="false" title="What the team has said to and from this assistant">Team</button>'
    +     '</div>'
    +     '<button type="button" class="bms-chat-headbtn" id="bms-chat-new-btn" title="Start a new chat">+ New Chat</button>'
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
    +     '<div class="bms-chat-team ac-hidden" id="bms-chat-team">'
    +       '<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button type="button" class="bms-chat-headbtn" id="bms-chat-team-open">Open Team Chat</button></div>'
    +       '<div id="bms-chat-team-host"></div>'
    +     '</div>'
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
    el('bms-chat-mode-chat').addEventListener('click', function () { setMode('chat'); });
    el('bms-chat-mode-team').addEventListener('click', function () { setMode('team'); });
    el('bms-chat-team-open').addEventListener('click', function () {
      closeAssistantChat();
      if (typeof window.loadView === 'function') window.loadView('team');
    });
    el('bms-chat-new-btn').addEventListener('click', function () {
      if (!state.assistantId) return;
      setHistoryOpen(false);
      loadConversation({ assistantId: state.assistantId });
    });
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
    return (window.bmsCachedFetch ? window.bmsCachedFetch.assistants() : fetch('/.netlify/functions/get-assistants', { credentials: 'same-origin' }))
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
  //   cfg: { assistantId, sessionId, readOnly }
  function loadConversation(cfg) {
    var assistantId = cfg.assistantId;
    var sessionId = cfg.sessionId;

    if (state.chat && state.chat.destroy) { state.chat.destroy(); state.chat = null; }
    el('bms-chat-mount').innerHTML = '';
    showState('loading');

    // No sessionId means a new chat (owner, 2026-10-22: opening the chat starts fresh; an older
    // thread is one click away in History).
    return resolveConversation(assistantId, sessionId)
      .then(function (info) {
        // Guard against a race where the user closed the modal before this resolved.
        if (!el('bms-chat-backdrop').classList.contains('ac-open')) return null;
        if (!info) {
          showState('error', 'This conversation could not be found in your workspace.');
          return null;
        }
        el('bms-chat-name').textContent = info.assistantName || 'Your assistant';
        el('bms-chat-role').textContent = info.assistantRole || 'Digital Assistant';
        paintAvatar(info);
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

  // Chat or the Team thread. The conversation stays mounted underneath, so switching back loses nothing.
  function setMode(mode) {
    var team = mode === 'team' && !!state.assistantId;
    el('bms-chat-mode-chat').setAttribute('aria-pressed', team ? 'false' : 'true');
    el('bms-chat-mode-team').setAttribute('aria-pressed', team ? 'true' : 'false');
    el('bms-chat-team').classList.toggle('ac-hidden', !team);
    el('bms-chat-history-btn').classList.toggle('ac-hidden', team);
    el('bms-chat-new-btn').classList.toggle('ac-hidden', team);
    if (team) {
      setHistoryOpen(false);
      if (window.TeamFeed) window.TeamFeed.mount(el('bms-chat-team-host'), { mode: 'assistant', assistantId: state.assistantId });
    } else if (state.staleSessionId && state.chat && state.chat.getSessionId() === state.staleSessionId) {
      // A note sent on the Team tab was answered in THIS conversation (team-feed.js → team:chatTurn):
      // reload it so the Chat tab shows that exchange too.
      var sid = state.staleSessionId;
      state.staleSessionId = null;
      loadConversation({ assistantId: state.assistantId, sessionId: sid });
    }
  }

  // Bound once, at load. Remember which conversation a Team reply landed in (see setMode).
  document.addEventListener('team:chatTurn', function (e) {
    var d = (e && e.detail) || {};
    if (d.chatSessionId && Number(d.assistantId) === Number(state.assistantId)) state.staleSessionId = Number(d.chatSessionId);
  });

  // The assistant's own letter and colour (assistant-colors.js), as on its card and in Team Chat.
  function paintAvatar(info) {
    var av = el('bms-chat-avatar');
    var AC = window.AssistantColors;
    if (!av) return;
    if (!AC || !info || !info.assistantId) { av.textContent = '💬'; av.style.background = ''; av.style.color = ''; return; }
    av.textContent = AC.letterFor(info.assistantId, info.assistantName);
    av.style.background = AC.colorFor(info.assistantId);
    av.style.color = '#fff';
    av.style.fontWeight = '700';
    av.style.fontSize = '16px';
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
        loadConversation({ assistantId: assistantId });
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
    paintAvatar(null);
    state.assistantId = null;   // until this conversation resolves, Team has no one to show
    setMode('chat');
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

    loadConversation({ assistantId: assistantId, sessionId: sessionId }).then(function (info) {
      // The drawer needs the resolved assistant id — a caller may have passed only a sessionId.
      if (info) mountHistory(info.assistantId);
      // `draft` is typed into the composer, never sent: the user reads it, edits it, sends it.
      // `send` is a message the user has ALREADY written somewhere else (the website editor's swan
      // button, "ask for a change to this section") — it is sent as theirs, as if typed here.
      var text = opts.send || opts.draft;
      if (text) {
        var input = el('bms-chat-mount') && el('bms-chat-mount').querySelector('[data-chat-input]');
        if (input) {
          input.value = String(text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
          var sendBtn = opts.send && el('bms-chat-mount').querySelector('[data-chat-send]');
          if (sendBtn) sendBtn.click();
        }
      }
    });
  }

  function closeAssistantChat() {
    if (!state.injected) return;
    if (state.chat && state.chat.destroy) { state.chat.destroy(); state.chat = null; }
    if (state.history && state.history.destroy) { state.history.destroy(); state.history = null; }
    setHistoryOpen(false);
    setMode('chat');
    el('bms-chat-team-host').innerHTML = '';
    el('bms-chat-backdrop').classList.remove('ac-open');
    window.ScrollLock.release('assistant-chat');
    if (state.escHandler) { document.removeEventListener('keydown', state.escHandler); state.escHandler = null; }
  }

  window.openAssistantChat = openAssistantChat;
  window.closeAssistantChat = closeAssistantChat;
})();
