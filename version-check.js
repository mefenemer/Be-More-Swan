// version-check.js — tells a long-open workspace tab that a newer deploy is live.
//
// Why: the server side of a deploy is live for everyone at once, but workspace.html is one
// long-lived page with its code built in. A tab opened before a deploy keeps running the OLD page
// code against the NEW functions until it reloads, which can be days. Nothing told the user.
//
// How: the page knows the deploy it was built from (window.BMS_VIEW_VERSION, the first 8 characters
// of the commit, stamped by scripts/stamp-view-version.mjs). /.netlify/functions/build-info reports
// the commit that is live NOW. When they differ:
//   · a banner offers "Refresh" (the workspace reopens the last view on reload, so nothing is lost
//     by navigating)
//   · if the tab is in the BACKGROUND and nothing looks unsaved, it reloads on its own, so the user
//     comes back to the new version without noticing
//   · it never reloads a tab the user is looking at, and never one with typed-but-unsent text, an
//     open dialog, or a write request still in flight — losing a half-written post is worse than
//     running slightly older code
//
// Quiet by design when it cannot tell: local dev (build-info answers null), a failed request, or a
// version that is not a commit id all mean "do nothing".
(function () {
    if (window.bmsVersionCheck) return; // loaded twice — keep the first

    const BUILD_INFO_URL = '/.netlify/functions/build-info';
    const POLL_MS = 10 * 60 * 1000;          // while the tab is open
    const MIN_GAP_MS = 60 * 1000;            // focus/visibility checks no more often than this
    const SNOOZE_MS = 30 * 60 * 1000;        // "Later" hides the banner this long
    const RELOADED_KEY = 'bms.versionReloadedFor';
    const BANNER_ID = 'bms-version-banner';

    const state = {
        liveCommit: null,      // full sha of the newer deploy, once seen
        lastCheck: 0,
        snoozedUntil: 0,
        writesInFlight: 0,
        timer: null,
    };

    function localVersion() {
        const v = String(window.BMS_VIEW_VERSION || '');
        return /^[0-9a-f]{7,40}$/i.test(v) ? v.toLowerCase() : null;
    }

    // ── What counts as "unsaved" ─────────────────────────────────────────────────────────────────
    // Fields the user has typed into this page load. A field still on the page with text in it is
    // treated as unsent work; one that was cleared (chat sent) or removed (view changed) is not.
    const typedFields = new Set();
    document.addEventListener('input', (e) => {
        const el = e.target;
        if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) typedFields.add(el);
    }, true);

    function fieldHasText(el) {
        if (el.isContentEditable) return (el.textContent || '').trim() !== '';
        if (el.type === 'checkbox' || el.type === 'radio') return true; // a changed choice is a change
        return String(el.value || '').trim() !== '';
    }

    function hasUnsentText() {
        for (const el of Array.from(typedFields)) {
            if (!el.isConnected) { typedFields.delete(el); continue; }
            if (fieldHasText(el)) return true;
        }
        return false;
    }

    // Most of the app's modals are plain `fixed inset-0` overlays with no role (measured on staging
    // 2026-11-13: #plan-gate-modal), so a visible full-screen overlay counts as a dialog too.
    function dialogOpen() {
        if (document.querySelector('dialog[open]')) return true;
        for (const el of Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .fixed.inset-0'))) {
            if (el.id === BANNER_ID) continue;
            if (!el.classList.contains('hidden') && el.getClientRects().length > 0) return true;
        }
        return false;
    }

    // A POST still going (a chat reply streaming, an upload, a save) would be cut off by a reload.
    const realFetch = window.fetch && window.fetch.bind(window);
    if (realFetch) {
        window.fetch = function (input, init) {
            const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            const isWrite = method !== 'GET' && method !== 'HEAD';
            if (!isWrite) return realFetch(input, init);
            state.writesInFlight++;
            let done = false;
            const finish = () => { if (!done) { done = true; state.writesInFlight--; } };
            try {
                const p = realFetch(input, init);
                p.then(finish, finish);
                return p;
            } catch (err) { finish(); throw err; }
        };
    }

    function isSafeToReload() {
        return state.writesInFlight === 0 && !hasUnsentText() && !dialogOpen();
    }

    // ── Banner ───────────────────────────────────────────────────────────────────────────────────
    // Inline styles, not Tailwind classes: the compiled CSS only carries classes it found when it
    // was built, and this must render on whatever stylesheet the old tab has.
    function showBanner() {
        if (Date.now() < state.snoozedUntil) return;
        let bar = document.getElementById(BANNER_ID);
        if (bar) { bar.style.display = 'flex'; return; }
        bar = document.createElement('div');
        bar.id = BANNER_ID;
        bar.setAttribute('role', 'status');
        bar.setAttribute('aria-live', 'polite');
        bar.style.cssText = [
            // left/right 0 + auto margins, not left:50% + translate: the translate trick caps the
            // box at half the screen, so on a phone the text wrapped into a narrow column.
            'position:fixed', 'left:0', 'right:0', 'margin:0 auto', 'width:max-content', 'bottom:20px', 'z-index:2147483000',
            'display:flex', 'align-items:center', 'gap:12px', 'flex-wrap:wrap', 'justify-content:center',
            'max-width:calc(100vw - 32px)', 'box-sizing:border-box', 'padding:10px 12px 10px 16px',
            'background:#111827', 'color:#fff', 'border-radius:12px', 'box-shadow:0 8px 24px rgba(0,0,0,.25)',
            'font:500 14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif',
        ].join(';');

        const text = document.createElement('span');
        text.textContent = 'A new version of Be More Swan is ready.';

        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.textContent = 'Refresh';
        refresh.style.cssText = 'background:#fff;color:#111827;border:0;border-radius:8px;padding:6px 14px;font:inherit;font-weight:600;cursor:pointer';
        refresh.addEventListener('click', () => reloadNow());

        const later = document.createElement('button');
        later.type = 'button';
        later.textContent = 'Later';
        later.style.cssText = 'background:transparent;color:#d1d5db;border:0;padding:6px 8px;font:inherit;cursor:pointer';
        later.addEventListener('click', () => {
            state.snoozedUntil = Date.now() + SNOOZE_MS;
            bar.style.display = 'none';
        });

        bar.append(text, refresh, later);
        document.body.appendChild(bar);
    }

    function reloadNow() {
        try { sessionStorage.setItem(RELOADED_KEY, state.liveCommit || ''); } catch (_) {}
        window.location.reload();
    }

    // Background tab + nothing unsaved → reload quietly. Guarded against a loop: if this tab
    // already reloaded for this exact live commit and STILL sees a mismatch (an edge cache serving
    // the old page), it stops reloading on its own and leaves the banner.
    function maybeAutoReload() {
        if (!state.liveCommit || !document.hidden || !isSafeToReload()) return false;
        let already = '';
        try { already = sessionStorage.getItem(RELOADED_KEY) || ''; } catch (_) {}
        if (already === state.liveCommit) return false;
        reloadNow();
        return true;
    }

    // ── Checking ─────────────────────────────────────────────────────────────────────────────────
    async function check(force) {
        const local = localVersion();
        if (!local || !realFetch) return null;
        const now = Date.now();
        if (!force && now - state.lastCheck < MIN_GAP_MS) return state.liveCommit;
        state.lastCheck = now;

        if (!state.liveCommit) {
            let live = null;
            try {
                const res = await realFetch(BUILD_INFO_URL, { cache: 'no-store', credentials: 'same-origin' });
                if (!res.ok) return null;
                const body = await res.json();
                live = body && typeof body.commit === 'string' ? body.commit.toLowerCase() : null;
            } catch (_) { return null; }
            if (!live || !/^[0-9a-f]{40}$/.test(live)) return null;
            if (live.startsWith(local)) return null; // same deploy
            state.liveCommit = live;
        }
        showBanner();
        maybeAutoReload();
        return state.liveCommit;
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) maybeAutoReload(); else check(false);
    });
    window.addEventListener('focus', () => check(false));
    state.timer = setInterval(() => check(true), POLL_MS);
    // First look shortly after load, off the critical path.
    setTimeout(() => check(true), 30 * 1000);

    window.bmsVersionCheck = { check, isSafeToReload, maybeAutoReload, state };
})();
