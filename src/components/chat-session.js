/**
 * src/components/chat-session.js
 *
 * Main chat interface for the Digital Assistant orchestrator
 * (netlify/functions/chat-orchestrator.ts).
 *
 * Usage:
 *   const chat = window.ChatSession.mount({
 *     container,                    // HTMLElement to render into
 *     chatSessionId,                // number — continue an existing conversation
 *     assistantId,                  // number — start a new one (maps to aiAssistantId)
 *     assistantName,                // optional display name for the header/empty state
 *     roleKey,                      // optional snake_case catalog key — picks the
 *                                   //   zero-state starter prompts (assistant-starter-prompts.js)
 *     initialMessages,              // optional history rows: { role, content,
 *                                   //   uiElement | uiElementJson, createdAt }
 *   });
 *   chat.sendMessage(text)          // programmatic send
 *   chat.getSessionId()             // number | null (set after the first reply)
 *   chat.destroy()
 *
 * Netlify Functions buffer responses (no streaming), so a typing skeleton is shown
 * between send and reply. Assistant text renders as sanitised Markdown — via
 * marked + DOMPurify when the page loads them (workspace.html pattern), otherwise a
 * minimal escape-first fallback. Messages with a uiElementJson payload additionally
 * mount their "Disruptive UI" card through window.DisruptiveUIRegistry.
 */
(function () {
  'use strict';

  const ORCHESTRATOR_URL = '/.netlify/functions/chat-orchestrator';
  const MAX_MESSAGE_CHARS = 4000; // mirrors the orchestrator's server-side cap

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Escape-first Markdown: full renderer when marked + DOMPurify are on the page,
   * otherwise bold / italic / inline code / links / paragraphs only. Either path
   * returns HTML that is safe to inject.
   */
  function renderMarkdown(text) {
    if (window.marked && window.DOMPurify) {
      window.marked.setOptions({ breaks: true, gfm: true });
      return window.DOMPurify.sanitize(window.marked.parse(text));
    }
    let html = escapeHtml(text);
    html = html
      .replace(/`([^`\n]+)`/g, '<code class="bg-gray-100 rounded px-1 py-0.5 text-xs font-mono">$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-emerald-700 font-semibold underline hover:text-emerald-800">$1</a>');
    return html
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  function mount(props) {
    const { container, assistantName } = props || {};
    if (!(container instanceof HTMLElement)) {
      throw new Error('[ChatSession] mount() requires a container element.');
    }

    // ── State ──
    let chatSessionId = props.chatSessionId ?? null;
    const assistantId = props.assistantId ?? null;
    let sending = false;

    // Zero-state: a brand-new session (no visible history — system rows don't count)
    // greets with clickable starter prompts tailored to the assistant's roleKey.
    const hasHistory = (props.initialMessages || []).some(
      (m) => m && m.role !== 'system' && typeof m.content === 'string'
    );
    const starterPrompts = !hasHistory && window.AssistantStarterPrompts
      ? window.AssistantStarterPrompts.get(props.roleKey)
      : null;

    const displayName = escapeHtml(assistantName || 'your assistant');
    const emptyStateHtml = starterPrompts
      ? `
          <div class="max-w-md mx-auto text-center py-8" data-chat-empty>
            <div class="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center text-3xl mx-auto mb-4">👋</div>
            <p class="text-lg font-bold text-gray-900">Hi, I'm ${displayName}.</p>
            <p class="text-sm text-gray-500 mt-1 mb-6">Here's how I can help — pick one to get started, or type your own message below.</p>
            <div class="flex flex-col gap-2.5 text-left">
              ${starterPrompts.map((prompt, i) => `
                <button type="button" data-starter-prompt="${i}"
                  class="group w-full flex items-center justify-between gap-3 bg-white border border-gray-200 hover:border-emerald-300 hover:bg-emerald-50 rounded-xl px-4 py-3 text-sm font-semibold text-gray-700 hover:text-emerald-800 shadow-sm transition text-left cursor-pointer">
                  <span>${escapeHtml(prompt)}</span>
                  <svg class="w-4 h-4 shrink-0 text-gray-300 group-hover:text-emerald-700 transition" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
                </button>`).join('')}
            </div>
          </div>`
      : `
          <div class="text-center py-10" data-chat-empty>
            <div class="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center text-2xl mx-auto mb-3">💬</div>
            <p class="font-bold text-gray-900">${escapeHtml(assistantName || 'Your assistant')} is ready</p>
            <p class="text-sm text-gray-500 mt-1">Send a message below to get started.</p>
          </div>`;

    // ── Shell ──
    container.innerHTML = `
      <div class="flex flex-col h-full bg-gray-50" data-chat-root>
        <div class="grow overflow-y-auto px-4 sm:px-6 py-6 space-y-4" data-chat-scroll>${emptyStateHtml}
        </div>
        <div class="border-t border-gray-200 bg-white px-4 sm:px-6 py-4">
          <div class="hidden mb-2 text-sm text-red-600 font-semibold" data-chat-error role="alert"></div>
          <form class="flex items-end gap-3" data-chat-form>
            <textarea rows="1" placeholder="Type your message…" maxlength="${MAX_MESSAGE_CHARS}"
              class="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700 transition shadow-sm bg-white resize-none max-h-40"
              data-chat-input></textarea>
            <button type="submit"
              class="px-5 py-3 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-lg transition shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              data-chat-send>Send</button>
          </form>
        </div>
      </div>`;

    const scrollEl = container.querySelector('[data-chat-scroll]');
    const emptyEl = container.querySelector('[data-chat-empty]');
    const formEl = container.querySelector('[data-chat-form]');
    const inputEl = container.querySelector('[data-chat-input]');
    const sendBtn = container.querySelector('[data-chat-send]');
    const errorEl = container.querySelector('[data-chat-error]');

    function scrollToBottom() {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    function showError(text) {
      errorEl.textContent = text;
      errorEl.classList.remove('hidden');
    }

    function clearError() {
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
    }

    /** Append one message row. Accepts API shape ({ uiElement }) and DB rows ({ uiElementJson }). */
    function appendMessage(message) {
      if (!message || typeof message.content !== 'string') return;
      if (message.role === 'system') return; // audit rows — never part of the visible transcript
      emptyEl?.remove();

      const isUser = message.role === 'user';
      const row = document.createElement('div');
      row.className = `flex flex-col gap-2 ${isUser ? 'items-end' : 'items-start'}`;

      const bubble = document.createElement('div');
      if (isUser) {
        bubble.className = 'bg-emerald-700 text-white rounded-2xl rounded-br-md px-4 py-3 text-sm max-w-[85%] sm:max-w-md whitespace-pre-wrap break-words shadow-sm';
        bubble.textContent = message.content;
      } else {
        bubble.className = 'bg-white border border-gray-200 rounded-2xl rounded-bl-md px-4 py-3 text-sm text-gray-800 max-w-[85%] sm:max-w-md break-words shadow-sm space-y-2 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5';
        bubble.innerHTML = renderMarkdown(message.content);
      }
      row.appendChild(bubble);

      // Disruptive UI: mount the interactive card inline, under the text bubble.
      const uiElement = message.uiElement ?? message.uiElementJson ?? null;
      if (uiElement && window.DisruptiveUIRegistry) {
        const card = window.DisruptiveUIRegistry.render(uiElement);
        if (card) row.appendChild(card);
      }

      // Issue #180: when a turn produced a Data Hub record (chat-orchestrator.ts
      // stamps a hubLink onto uiElement), surface a jump-off link to the exact
      // Assistant Detail tab it landed in — the chat previously had no path there.
      const hubLink = uiElement && typeof uiElement === 'object' ? uiElement.hubLink : null;
      const hubLinkEl = renderHubLink(hubLink);
      if (hubLinkEl) row.appendChild(hubLinkEl);

      scrollEl.appendChild(row);
      scrollToBottom();
    }

    /** "View in Review Queue" style jump-off link — see appendMessage's hubLink handling. */
    function renderHubLink(hubLink) {
      if (!hubLink || typeof hubLink !== 'object' || typeof hubLink.tab !== 'string' || assistantId == null) return null;
      const params = new URLSearchParams({ view: 'assistant-detail', assistantId: String(assistantId), tab: hubLink.tab });
      if (hubLink.postId != null) params.set('postId', String(hubLink.postId));
      const a = document.createElement('a');
      a.href = `workspace.html?${params.toString()}`;
      a.className = 'inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 transition w-fit';
      const label = typeof hubLink.label === 'string' && hubLink.label.trim() ? hubLink.label.trim() : 'View in Review Queue';
      a.textContent = `${label} →`;
      return a;
    }

    /**
     * Paywall (403 upgrade_required from the orchestrator): mount the
     * UpgradeRequiredCard inline as an assistant-side bubble instead of the red
     * error line. Falls back to showError if the registry isn't on the page.
     */
    function appendPaywallCard(uiElement) {
      const card = window.DisruptiveUIRegistry ? window.DisruptiveUIRegistry.render(uiElement) : null;
      if (!card) {
        showError(uiElement.reason || 'You have reached your plan limit — upgrade to continue.');
        return;
      }
      emptyEl?.remove();
      const row = document.createElement('div');
      row.className = 'flex flex-col gap-2 items-start';
      row.appendChild(card);
      scrollEl.appendChild(row);
      scrollToBottom();
    }

    // Conversion telemetry: record the paywall impression through the existing
    // page-events churn tracker (US-AUD-3.1.1) — fire-and-forget, never blocks the UI.
    function trackPaywallHit(reason) {
      const metadata = { event: 'chat_paywall_shown', reason: reason || null, chatSessionId };
      if (typeof window._trackPageEvent === 'function') {
        window._trackPageEvent(window.location.pathname, metadata);
        return;
      }
      fetch('/.netlify/functions/page-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pagePath: window.location.pathname, metadata }),
      }).catch(() => { /* non-critical */ });
    }

    function showTypingSkeleton() {
      const el = document.createElement('div');
      el.dataset.chatTyping = '1';
      el.className = 'flex items-start';
      el.innerHTML = `
        <div class="bg-white border border-gray-200 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm" aria-label="Assistant is typing" role="status">
          <div class="flex items-center gap-1.5">
            <span class="w-2 h-2 bg-emerald-700 rounded-full animate-bounce"></span>
            <span class="w-2 h-2 bg-emerald-700 rounded-full animate-bounce" style="animation-delay: 150ms;"></span>
            <span class="w-2 h-2 bg-emerald-700 rounded-full animate-bounce" style="animation-delay: 300ms;"></span>
          </div>
        </div>`;
      scrollEl.appendChild(el);
      scrollToBottom();
      return el;
    }

    function setSending(value) {
      sending = value;
      sendBtn.disabled = value;
      inputEl.disabled = value;
    }

    /**
     * Send one turn to the orchestrator.
     * opts.approvedHandoff — hidden flag for HITL cross-assistant handoffs: rides in the
     * request body (never in the visible message text) and tells the orchestrator to run
     * the target assistant as a background "shadow call" before this assistant replies.
     * Shape: { targetRoleKey, targetAssistantName, payloadToPass }.
     */
    async function sendMessage(text, opts) {
      const message = String(text ?? '').trim();
      if (!message || sending) return;
      if (message.length > MAX_MESSAGE_CHARS) {
        showError(`Message too long (max ${MAX_MESSAGE_CHARS} characters).`);
        return;
      }

      clearError();
      appendMessage({ role: 'user', content: message });
      setSending(true);
      const skeleton = showTypingSkeleton();

      try {
        const body = chatSessionId != null
          ? { chatSessionId, message }
          : { aiAssistantId: assistantId, message };
        if (opts && opts.approvedHandoff) body.approvedHandoff = opts.approvedHandoff;

        const res = await fetch(ORCHESTRATOR_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        // Read the body as TEXT first. Every failure the orchestrator knows about answers in JSON
        // with its own `error`; a body that will not parse means the function never got that far —
        // a crash, a timeout or an auth redirect — and that raw text is the only evidence of which.
        const raw = await res.text();
        let data = {};
        let parsed = true;
        try { data = raw ? JSON.parse(raw) : {}; } catch { parsed = false; }

        // The orchestrator creates the session before the LLM call — keep its id even
        // on failure so a retry continues the same conversation.
        if (data.chatSessionId) chatSessionId = data.chatSessionId;

        if (!res.ok || !data.message) {
          // Over plan limit: render the upgrade paywall as a native chat bubble.
          if (res.status === 403 && data.uiElementJson && data.uiElementJson.type === 'upgrade_required') {
            appendPaywallCard(data.uiElementJson);
            trackPaywallHit(data.uiElementJson.reason);
            return;
          }
          // The bare "Something went wrong" told the user nothing and told us less: it was shown
          // for a 500, a 504 and a 200-with-the-wrong-shape alike, so a report of it could not be
          // acted on. Name the status, and put the body in the console for whoever is looking.
          if (!data.error) {
            console.error('[ChatSession] orchestrator did not answer', {
              status: res.status, parsedAsJson: parsed, body: raw.slice(0, 2000),
            });
          }
          showError(data.error || `Something went wrong (HTTP ${res.status}) — please try again in a moment.`);
          return;
        }
        appendMessage(data.message);
      } catch (err) {
        console.error('[ChatSession] send failed:', err);
        showError('Connection problem — please check your internet and try again.');
      } finally {
        skeleton.remove();
        setSending(false);
        inputEl.focus();
      }
    }

    function onSubmit(e) {
      e.preventDefault();
      const text = inputEl.value;
      inputEl.value = '';
      inputEl.style.height = 'auto';
      sendMessage(text);
    }

    function onKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        formEl.requestSubmit();
      }
    }

    function onInput() {
      inputEl.style.height = 'auto';
      inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
    }

    // HITL handoff approvals bubble up from HandoffProposalCard (disruptive-ui-registry.js).
    // Approve → submit a turn carrying the payload + hidden approved-handoff flag so the
    // orchestrator runs the target assistant in the background before this one resumes.
    // Decline → plain message so the assistant knows to continue with what it has.
    function onHandoffResponse(e) {
      const d = e.detail || {};
      const targetName = d.targetAssistantName || 'the other assistant';
      if (d.approved && d.targetRoleKey) {
        sendMessage(`Approve handoff to ${targetName}.`, {
          approvedHandoff: {
            targetRoleKey: d.targetRoleKey,
            targetAssistantName: targetName,
            payloadToPass: d.payloadToPass ?? {},
          },
        });
      } else {
        sendMessage(`I've declined the handoff to ${targetName} — please continue with the information you already have.`);
      }
    }

    formEl.addEventListener('submit', onSubmit);
    inputEl.addEventListener('keydown', onKeydown);
    inputEl.addEventListener('input', onInput);
    container.addEventListener('handoff:response', onHandoffResponse);

    // Starter pills send their prompt verbatim; the first appendMessage removes the
    // zero-state (and the pills with it), so no explicit teardown is needed.
    container.querySelectorAll('[data-starter-prompt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const prompt = starterPrompts?.[Number(btn.dataset.starterPrompt)];
        if (prompt) sendMessage(prompt);
      });
    });

    // ── Hydrate history ──
    (props.initialMessages || []).forEach(appendMessage);
    scrollToBottom();

    return {
      sendMessage,
      appendMessage,
      getSessionId: () => chatSessionId,
      destroy() {
        formEl.removeEventListener('submit', onSubmit);
        inputEl.removeEventListener('keydown', onKeydown);
        inputEl.removeEventListener('input', onInput);
        container.removeEventListener('handoff:response', onHandoffResponse);
        container.innerHTML = '';
      },
    };
  }

  window.ChatSession = { mount };
})();
