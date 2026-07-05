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

    // ── Shell ──
    container.innerHTML = `
      <div class="flex flex-col h-full bg-gray-50" data-chat-root>
        <div class="grow overflow-y-auto px-4 sm:px-6 py-6 space-y-4" data-chat-scroll>
          <div class="text-center py-10" data-chat-empty>
            <div class="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center text-2xl mx-auto mb-3">💬</div>
            <p class="font-bold text-gray-900">${escapeHtml(assistantName || 'Your assistant')} is ready</p>
            <p class="text-sm text-gray-500 mt-1">Send a message below to get started.</p>
          </div>
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

      scrollEl.appendChild(row);
      scrollToBottom();
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

    async function sendMessage(text) {
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

        const res = await fetch(ORCHESTRATOR_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));

        // The orchestrator creates the session before the LLM call — keep its id even
        // on failure so a retry continues the same conversation.
        if (data.chatSessionId) chatSessionId = data.chatSessionId;

        if (!res.ok || !data.message) {
          showError(data.error || 'Something went wrong — please try again in a moment.');
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

    formEl.addEventListener('submit', onSubmit);
    inputEl.addEventListener('keydown', onKeydown);
    inputEl.addEventListener('input', onInput);

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
        container.innerHTML = '';
      },
    };
  }

  window.ChatSession = { mount };
})();
