// src/components/assistant-bubbles.js
// Assistant chat bubbles (owner, 2026-10-27): short messages from an assistant that pop up at the
// bottom of the screen for 5 seconds and then go, on top of everything notifications already do.
//
// Three ways a bubble appears:
//   1. pageNudges()  — opening an assistant's page: what it wants to remind you of (work waiting for
//      you, being paused), plus the Business Mentor's open suggestions about that assistant. The
//      server (assistant-nudges.ts) adds the Mentor's and also posts each one to Team Chat, once a
//      day, so nothing that popped up is lost when it fades.
//   2. say()         — while you work on a page: something the assistant has spotted (e.g. the
//      Outreach tab cannot send). Shown once per page visit per key.
//   3. onNotificationsRose() — a new notification from an assistant arrived (the badge poller in
//      notifications.js calls this when its count goes up): its title pops up as that assistant.
//
// Hover holds a bubble; × closes it; its button does the thing and closes it. At most three on
// screen, the rest wait their turn. Purely a display layer — it never writes anything itself except
// through assistant-nudges.ts, and a failure anywhere just means no bubble.
(function () {
    'use strict';

    const SHOW_MS = 5000;
    const MAX_ON_SCREEN = 3;
    const queue = [];
    let onScreen = 0;
    const saidThisPage = new Set();

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function host() {
        let h = document.getElementById('assistant-bubbles');
        if (!h) {
            h = document.createElement('div');
            h.id = 'assistant-bubbles';
            h.setAttribute('aria-live', 'polite');
            // Bottom-left: the bottom-right corner already holds toasts and the chat launcher.
            h.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:60;display:flex;flex-direction:column;gap:8px;max-width:min(360px,calc(100vw - 32px));pointer-events:none';
            document.body.appendChild(h);
        }
        return h;
    }

    function colourFor(assistantId) {
        try { return window.AssistantColors?.colorFor?.(assistantId) || null; } catch { return null; }
    }

    function render(b) {
        onScreen++;
        const el = document.createElement('div');
        el.setAttribute('role', 'status');
        el.className = 'bg-white border border-gray-200 rounded-2xl shadow-lg p-3 flex gap-3 items-start';
        el.style.cssText = 'pointer-events:auto;transition:opacity .25s,transform .25s;opacity:0;transform:translateY(8px)';
        const letter = esc((b.name || '?').trim().charAt(0).toUpperCase());
        const bg = colourFor(b.assistantId) || '#be185d';
        el.innerHTML = `
          <span class="shrink-0 rounded-full text-white text-sm font-bold flex items-center justify-center" style="width:32px;height:32px;background:${esc(bg)}">${letter}</span>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-gray-900">${esc(b.name || 'Your assistant')}</p>
            <p class="text-sm text-gray-700 mt-0.5 break-words">${esc(b.text)}</p>
            ${b.action && b.action.label ? `<button type="button" data-bubble-go class="btn-primary mt-2 px-3 py-1 text-xs font-bold rounded-lg">${esc(b.action.label)}</button>` : ''}
          </div>
          <button type="button" data-bubble-close aria-label="Close" class="text-gray-400 hover:text-gray-700 text-lg leading-none shrink-0">&times;</button>`;
        host().appendChild(el);
        requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'none'; });

        let timer = null;
        let gone = false;
        const close = () => {
            if (gone) return;
            gone = true;
            clearTimeout(timer);
            el.style.opacity = '0';
            setTimeout(() => { el.remove(); onScreen--; next(); }, 250);
        };
        const arm = () => { clearTimeout(timer); timer = setTimeout(close, SHOW_MS); };
        el.addEventListener('mouseenter', () => clearTimeout(timer));
        el.addEventListener('mouseleave', arm);
        el.querySelector('[data-bubble-close]').addEventListener('click', close);
        el.querySelector('[data-bubble-go]')?.addEventListener('click', () => {
            try { b.action.run?.(); } catch { /* the button is a shortcut, never load-bearing */ }
            close();
        });
        arm();
    }

    function next() {
        while (onScreen < MAX_ON_SCREEN && queue.length) render(queue.shift());
    }

    /** Pop one bubble. { assistantId, name, text, action?: { label, run } } */
    function show(b) {
        if (!b || !b.text) return;
        queue.push(b);
        // Staggered so three arriving together read as three messages, not one block.
        setTimeout(next, 400 * Math.min(queue.length - 1, 4));
    }

    /** Something the assistant spotted while you work. Once per key per page visit. */
    function say(key, b) {
        if (!key || saidThisPage.has(key)) return;
        saidThisPage.add(key);
        show(b);
    }

    /** A page change: what was "said" on the last page may be said again here. */
    function resetPage() { saidThisPage.clear(); }

    const openTab = (tab) => () => {
        if (!tab) return;
        if (typeof window._activateMainTab === 'function') window._activateMainTab(tab);
        if (tab === 'review-queue') window.detailRqOpenStatus?.('review');
    };
    const openChat = (assistantId) => () => window.openAssistantChat?.({ assistantId });

    /**
     * Opening an assistant's page. `items` are what the page knows ({ key, text, tab?, label? });
     * the server adds the Business Mentor's suggestions and records them all in Team Chat.
     */
    async function pageNudges({ assistantId, name, items }) {
        resetPage();
        let nudges = (items || []).map((i) => ({ ...i, from: { id: assistantId, name } }));
        try {
            const res = await fetch('/.netlify/functions/assistant-nudges', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify({ assistantId, nudges: items || [] }),
            });
            if (res.ok) nudges = (await res.json()).nudges || nudges;
        } catch { /* show what the page knows; the Team Chat copy is best-effort */ }
        // The page may have moved on while the request was out.
        if (Number(window._currentAssistantId) !== Number(assistantId)) return;
        for (const n of nudges) {
            const fromSelf = Number(n.from && n.from.id) === Number(assistantId);
            show({
                assistantId: n.from && n.from.id, name: n.from && n.from.name, text: n.text,
                action: n.tab && fromSelf ? { label: n.label || 'Show me', run: openTab(n.tab) }
                    : !fromSelf && n.from && n.from.id ? { label: n.label || 'Talk it through', run: openChat(n.from.id) } : null,
            });
        }
    }

    // ── New notifications, as bubbles ────────────────────────────────────────
    let lastSeen = Date.now();
    async function onNotificationsRose() {
        try {
            const res = await fetch('/.netlify/functions/notifications', { credentials: 'same-origin' });
            if (!res.ok) return;
            const list = (await res.json()).notifications || [];
            const fresh = list
                .filter((n) => n.actor && n.actor.name && new Date(n.createdAt).getTime() > lastSeen && !n.isRead)
                .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
                .slice(-3);
            for (const n of list) lastSeen = Math.max(lastSeen, new Date(n.createdAt).getTime() || 0);
            for (const n of fresh) {
                show({
                    assistantId: n.actor.assistantId, name: n.actor.name, text: n.title,
                    action: { label: 'View', run: () => window.loadView?.('notifications') },
                });
            }
        } catch { /* a missed bubble is fine; the notification itself is still there */ }
    }

    window.AssistantBubbles = { show, say, pageNudges, onNotificationsRose, resetPage };
})();
