/**
 * src/components/assistant-welcome-messages.js
 *
 * Be More Swan–voiced "hello, I'm here and I'm already working" copy for the moment a
 * live assistant finishes onboarding. Keyed by the assistant's roleKey (db/seed-catalog.ts —
 * snake_case, verbatim), same convention as assistant-starter-prompts.js.
 *
 * Why this exists: completing the setup wizard used to drop the user on a terse "Setup
 * complete!" screen (schema roles) or silently back on the workspace (social) with no word
 * from the assistant they just hired — so they were left wondering what, if anything, was
 * happening next. This gives every live assistant a warm, in-character welcome that (a) says
 * hi and introduces itself, (b) states what it is ALREADY doing, and (c) points at the Chat
 * button so the user knows they can steer it any time.
 *
 * Usage:
 *   const html = window.AssistantWelcomeMessages.buildCardHtml({ assistantId, roleKey, assistantName, draftsQueued });
 *   const strip = window.AssistantWelcomeMessages.buildBannerHtml({ assistantId, roleKey, assistantName, draftsQueued });
 *
 * buildCardHtml  → the big centred card for a setup-complete screen (Chat + Workspace buttons).
 * buildBannerHtml→ a dismissible strip for the Assistant Detail page (Chat button + "Got it").
 *
 * Load before assistant-onboarding-shell.js / assistants.js. Adding a new live assistant?
 * Add its roleKey below; until then it inherits the generic `default` copy.
 */
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // role      — how the assistant names its own job in the intro ("I'm your …").
  // working   — present-tense line for what it is doing RIGHT NOW (no full stop; the template adds one).
  // produces  — plural noun for the review-queue items it drafts. Present ⇒ a known draft count can
  //             replace `working` with a concrete "N queued for your approval" line (buildWorkingLine).
  const ROLES = {
    social_media_manager: {
      role: 'your Social Media Manager',
      working: 'I’m already getting to work drafting your first posts',
      produces: 'posts',
    },
    blog_writer: {
      role: 'your Blog Writer',
      working: 'I’m already getting to work drafting your first articles',
      produces: 'articles',
    },
    lead_qualifier: {
      role: 'your Lead Qualifier',
      working: 'I’m already lining up leads to score and prioritise for you',
    },
    accounts_receivable_clerk: {
      role: 'your Accounts Receivable Clerk',
      working: 'I’m getting across your invoices so I can help you chase what’s owed',
    },
    meeting_note_taker: {
      role: 'your Meeting Note-Taker',
      working: 'I’m ready to turn your meetings into clean, shareable notes and action items',
    },
    tier1_support_agent: {
      role: 'your Support Agent',
      working: 'I’m ready to help you answer customer questions calmly and consistently',
    },
    crm_enricher: {
      role: 'your CRM Enricher',
      working: 'I’m ready to start filling in the gaps on your contacts and companies',
    },
    campaign_orchestrator: {
      role: 'your Campaign Orchestrator',
      working: 'I’m ready to help you shape and coordinate your next campaign',
    },
    default: {
      role: 'your new assistant',
      working: 'I’m already getting to work',
    },
  };

  /** Copy for a roleKey, falling back to the generic default. */
  function get(roleKey) {
    return ROLES[roleKey] || ROLES.default;
  }

  /**
   * The "what I'm doing now" sentence (no trailing full stop). When the caller knows a real
   * draft count for a role that produces a review queue, prefer the concrete evidence line
   * over the generic promise — an empty queue looks identical whether the assistant started
   * or silently didn't, so saying the number is what makes the welcome trustworthy.
   */
  function buildWorkingLine(roleKey, draftsQueued) {
    const copy = get(roleKey);
    const n = Number(draftsQueued) || 0;
    if (copy.produces && n > 0) {
      const noun = n === 1 ? copy.produces.replace(/s$/, '') : copy.produces;
      const verb = n === 1 ? 'is' : 'are';
      return `I’ve already started — ${n} ${noun} ${verb} queued and waiting for your approval`;
    }
    return copy.working;
  }

  function chatHref(assistantId) {
    return `assistant-chat.html?assistantId=${encodeURIComponent(assistantId)}`;
  }
  function workspaceHref(assistantId) {
    return `workspace.html?view=assistant-detail&assistantId=${encodeURIComponent(assistantId)}`;
  }

  /**
   * Big centred welcome card for a setup-complete screen. Two buttons: primary "Chat with
   * {name}" (opens the conversation) and a secondary route to the assistant's workspace.
   * opts: { assistantId, roleKey, assistantName, draftsQueued }
   */
  function buildCardHtml(opts) {
    const o = opts || {};
    const name = escapeHtml(o.assistantName || 'your assistant');
    const copy = get(o.roleKey);
    const working = escapeHtml(buildWorkingLine(o.roleKey, o.draftsQueued));
    const chat = o.assistantId != null ? chatHref(o.assistantId) : null;
    const workspace = o.assistantId != null ? workspaceHref(o.assistantId) : 'workspace.html';

    return `
      <div class="max-w-md mx-auto text-center py-4" data-assistant-welcome>
        <div class="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center text-4xl mx-auto mb-4">🦢</div>
        <h2 class="text-2xl sm:text-3xl font-extrabold text-gray-900 mb-3">Hi, I’m ${name}! 👋</h2>
        <p class="text-gray-600 leading-relaxed mb-2">I’m ${escapeHtml(copy.role)}, and I’m all set up. ${working}.</p>
        <p class="text-gray-500 text-sm leading-relaxed mb-6">Want to chat any time? Just hit the <span class="font-semibold text-gray-700">Chat</span> button and I’ll help however I can — steer my work, ask a question, or point me at something new.</p>
        <div class="flex flex-col sm:flex-row gap-3 justify-center">
          ${chat ? `<a href="${chat}" data-welcome-chat class="inline-flex items-center justify-center gap-2 px-6 py-3 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-lg shadow transition">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.9 9.9 0 01-4-.8L3 20l1.3-3.5A7.9 7.9 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
            Chat with ${name}
          </a>` : ''}
          <a href="${workspace}" data-welcome-workspace class="inline-flex items-center justify-center gap-2 px-6 py-3 bg-white border border-gray-300 hover:border-emerald-300 hover:bg-emerald-50 text-gray-700 hover:text-emerald-800 font-bold rounded-lg shadow-sm transition">
            Go to ${name}’s workspace
          </a>
        </div>
      </div>`;
  }

  /**
   * Dismissible welcome strip for the Assistant Detail page (the user is already ON the
   * workspace, so there's no "go to workspace" button — just a Chat button and a dismiss).
   * The [data-welcome-dismiss] control is wired by the caller.
   * opts: { assistantId, roleKey, assistantName, draftsQueued }
   */
  function buildBannerHtml(opts) {
    const o = opts || {};
    const name = escapeHtml(o.assistantName || 'your assistant');
    const copy = get(o.roleKey);
    const working = escapeHtml(buildWorkingLine(o.roleKey, o.draftsQueued));
    const chat = o.assistantId != null ? chatHref(o.assistantId) : null;

    return `
      <div class="relative bg-emerald-50 border border-emerald-200 rounded-2xl px-5 py-4 mb-6 flex items-start gap-4" data-assistant-welcome role="status">
        <div class="w-11 h-11 bg-white rounded-full flex items-center justify-center text-2xl shrink-0 shadow-sm">🦢</div>
        <div class="min-w-0 grow">
          <p class="font-bold text-gray-900">Hi, I’m ${name}! 👋</p>
          <p class="text-sm text-gray-600 mt-0.5">I’m ${escapeHtml(copy.role)}, and I’m all set up. ${working}. Want to chat any time? Just hit the <span class="font-semibold text-gray-700">Chat</span> button up top.</p>
          ${chat ? `<a href="${chat}" data-welcome-chat class="inline-flex items-center gap-1.5 mt-3 px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg shadow-sm transition">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.9 9.9 0 01-4-.8L3 20l1.3-3.5A7.9 7.9 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
            Chat with ${name}
          </a>` : ''}
        </div>
        <button type="button" data-welcome-dismiss aria-label="Dismiss welcome message"
          class="shrink-0 text-emerald-600 hover:text-emerald-800 transition p-1 -mt-1 -mr-1">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>`;
  }

  window.AssistantWelcomeMessages = { get, buildWorkingLine, buildCardHtml, buildBannerHtml, ROLES };
})();
