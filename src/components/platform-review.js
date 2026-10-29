// src/components/platform-review.js
// "Leave a review" — the signed-in person reviewing Be More Swan itself (platform-review.ts,
// src/utils/platform-reviews.ts). Not Business Information ▸ Reviews, which is THEIR customers'
// reviews of THEIR business.
//
// Three ways in:
//   1. check()  — workspace.html calls it once per browser session, a while after load. When the
//      server says it is time (account age / posts published / an admin's request), one bubble pops
//      up from "Be More Swan" with a Leave a review button. The ask is counted when it shows.
//   2. open()   — the header's account menu → Leave a review, at any time.
//   3. workspace.html?review=1 — the link in an admin's emailed request opens the form straight away.
//
// After sending, Trustpilot and G2 are offered to EVERYONE alike, whatever their stars — sending only
// happy reviewers there is review gating, which both sites and UK law forbid. Their words are copied
// to the clipboard so they can paste them. Nothing here ever posts anywhere on their behalf.
(function () {
    'use strict';

    const API = '/.netlify/functions/platform-review';
    const SESSION_KEY = 'bms.reviewAskChecked';
    const ASK_DELAY_MS = 20000;
    const esc = (s) => (window.escapeHtml ? window.escapeHtml(String(s == null ? '' : s))
        : String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const toast = (msg, ok) => window.showToast?.(msg, { icon: ok ? '✅' : '⚠️' });

    let state = null;      // last GET
    let fromAsk = false;   // opened from the bubble / email: offer "maybe later" and "don't ask again"
    let source = 'in_app';

    async function load() {
        const res = await fetch(API, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Could not load your review.');
        state = await res.json();
        return state;
    }

    async function post(body) {
        const res = await fetch(API, {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'Something went wrong. Please try again.');
        return d;
    }

    function close() {
        document.getElementById('platform-review-modal')?.remove();
        document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    function shell(inner) {
        close();
        const m = document.createElement('div');
        m.id = 'platform-review-modal';
        m.setAttribute('role', 'dialog');
        m.setAttribute('aria-modal', 'true');
        m.setAttribute('aria-labelledby', 'platform-review-title');
        m.style.cssText = 'position:fixed;inset:0;z-index:2147482000;background:rgba(17,24,39,.5);display:flex;align-items:center;justify-content:center;padding:16px';
        m.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6" style="max-height:calc(100vh - 32px);overflow-y:auto">${inner}</div>`;
        m.addEventListener('click', (e) => { if (e.target === m) close(); });
        document.body.appendChild(m);
        document.addEventListener('keydown', onKey);
        return m;
    }

    function stars(selected) {
        return [1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" aria-label="${n} star${n === 1 ? '' : 's'}" aria-pressed="${n === selected}"
            style="font-size:28px;line-height:1;padding:2px;color:${n <= selected ? '#f59e0b' : '#d1d5db'}">★</button>`).join('');
    }

    function renderForm() {
        const r = state.review || {};
        let rating = r.rating || 0;
        const m = shell(`
          <h2 id="platform-review-title" class="text-lg font-bold text-gray-900">How is Be More Swan working for you?</h2>
          <p class="text-sm text-gray-500 mt-1">Good or bad, in your own words. It tells us what to fix, and helps other small businesses decide.</p>
          ${r.status ? `<p class="text-xs text-gray-500 mt-2">You reviewed us on ${esc(new Date(r.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}. Sending it again replaces it.</p>` : ''}
          <div class="mt-4" data-stars role="group" aria-label="Your rating">${stars(rating)}</div>
          <label for="pr-body" class="block text-xs font-bold text-gray-500 uppercase mt-4">Your review</label>
          <textarea id="pr-body" rows="5" maxlength="2000" class="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="What has it done for your business? What could be better?">${esc(r.body || '')}</textarea>
          <label class="flex items-start gap-2 mt-4 text-sm text-gray-700">
            <input type="checkbox" id="pr-consent" class="mt-1" ${r.consentToPublish ? 'checked' : ''}>
            <span>You can quote this on the Be More Swan website.</span>
          </label>
          <div id="pr-names" class="${r.consentToPublish ? '' : 'hidden'} grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <div>
              <label for="pr-name" class="block text-xs font-bold text-gray-500 uppercase">Name to show</label>
              <input id="pr-name" maxlength="80" class="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Sarah K." value="${esc(r.displayName || '')}">
            </div>
            <div>
              <label for="pr-detail" class="block text-xs font-bold text-gray-500 uppercase">Business (optional)</label>
              <input id="pr-detail" maxlength="80" class="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Florist, Leeds" value="${esc(r.displayDetail || '')}">
            </div>
          </div>
          ${state.incentiveNote ? `<p class="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 mt-4">Because you had free access during the beta, anywhere we show your review it will say <strong>“${esc(state.incentiveNote)}”</strong>. That is the law, and it keeps reviews trustworthy.</p>` : ''}
          <p id="pr-error" class="hidden text-sm font-semibold text-red-600 mt-3"></p>
          <div class="flex flex-wrap items-center justify-between gap-2 mt-5">
            <div class="flex gap-3 text-xs">
              ${fromAsk ? '<button type="button" data-pr-later class="text-gray-500 hover:text-gray-800 underline">Maybe later</button><button type="button" data-pr-never class="text-gray-500 hover:text-gray-800 underline">Don’t ask me again</button>' : ''}
            </div>
            <div class="flex gap-2">
              <button type="button" data-pr-cancel class="btn-secondary px-4 py-2 text-sm font-bold rounded-lg border">Cancel</button>
              <button type="button" data-pr-send class="btn-primary px-4 py-2 text-sm font-bold rounded-lg">Send review</button>
            </div>
          </div>`);

        const starsEl = m.querySelector('[data-stars]');
        starsEl.addEventListener('click', (e) => {
            const b = e.target.closest('[data-star]');
            if (!b) return;
            rating = Number(b.dataset.star);
            starsEl.innerHTML = stars(rating);
        });
        const consent = m.querySelector('#pr-consent');
        consent.addEventListener('change', () => m.querySelector('#pr-names').classList.toggle('hidden', !consent.checked));
        m.querySelector('[data-pr-cancel]').addEventListener('click', close);
        m.querySelector('[data-pr-later]')?.addEventListener('click', () => { post({ action: 'later' }).catch(() => {}); close(); });
        m.querySelector('[data-pr-never]')?.addEventListener('click', () => {
            post({ action: 'never' }).then(() => toast('We won’t ask again. You can still leave a review from your account menu.', true)).catch(() => {});
            close();
        });
        m.querySelector('[data-pr-send]').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const err = m.querySelector('#pr-error');
            err.classList.add('hidden');
            btn.disabled = true;
            try {
                const d = await post({
                    action: 'submit', rating, source,
                    body: m.querySelector('#pr-body').value,
                    consentToPublish: consent.checked,
                    displayName: m.querySelector('#pr-name').value,
                    displayDetail: m.querySelector('#pr-detail').value,
                });
                state.review = d.review;
                state.destinations = d.destinations || [];
                renderThanks();
            } catch (ex) {
                err.textContent = ex.message;
                err.classList.remove('hidden');
                btn.disabled = false;
            }
        });
        m.querySelector('#pr-body').focus();
    }

    function renderThanks() {
        const dest = state.destinations || [];
        const m = shell(`
          <h2 id="platform-review-title" class="text-lg font-bold text-gray-900">Thank you</h2>
          <p class="text-sm text-gray-600 mt-1">We read every review, and yours goes straight to the team.</p>
          ${dest.length ? `
            <p class="text-sm text-gray-700 mt-4">Would you post it on ${dest.map((d) => esc(d.label)).join(' or ')} too? That is where other business owners look. We’ll copy your words so you can paste them.</p>
            <div class="flex flex-wrap gap-2 mt-3">
              ${dest.map((d) => `<button type="button" data-pr-share="${esc(d.key)}" data-url="${esc(d.url)}" class="btn-secondary px-4 py-2 text-sm font-bold rounded-lg border">Post on ${esc(d.label)}</button>`).join('')}
            </div>
            ${state.incentiveNote ? `<p class="text-xs text-gray-500 mt-3">Please mention there that you had free access during the beta — both sites ask for it.</p>` : ''}` : ''}
          <div class="flex justify-end mt-5">
            <button type="button" data-pr-done class="btn-primary px-4 py-2 text-sm font-bold rounded-lg">Done</button>
          </div>`);
        m.querySelector('[data-pr-done]').addEventListener('click', close);
        m.querySelectorAll('[data-pr-share]').forEach((b) => b.addEventListener('click', async () => {
            // Open first, synchronously, so the browser treats it as the click's own window.
            window.open(b.dataset.url, '_blank', 'noopener');
            try { await navigator.clipboard.writeText(state.review?.body || ''); toast('Your review is copied — paste it there.', true); } catch { /* the site still opened */ }
            post({ action: 'shared', to: b.dataset.prShare }).catch(() => {});
        }));
    }

    /** Open the form. opts.fromAsk: offer "maybe later" / "don't ask again". */
    async function open(opts) {
        fromAsk = !!(opts && opts.fromAsk);
        source = (opts && opts.source) || 'in_app';
        try {
            await load();
            if (state.setUp === false) { toast('Reviews are not switched on yet.'); return; }
            renderForm();
        } catch (e) { toast(e.message); }
    }

    /** Once per browser session: if it is time, one bubble from Be More Swan. */
    function check() {
        try { if (sessionStorage.getItem(SESSION_KEY)) return; sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* private mode: may ask again next load, the server still limits it */ }
        setTimeout(async () => {
            try {
                const s = await load();
                if (!s.ask || !window.AssistantBubbles) return;
                window.AssistantBubbles.show({
                    name: 'Be More Swan',
                    text: 'Got two minutes? Tell us how Be More Swan is working for you — good or bad.',
                    action: { label: 'Leave a review', run: () => open({ fromAsk: true }) },
                });
                post({ action: 'shown' }).catch(() => {});
            } catch { /* no bubble; the account menu still has it */ }
        }, ASK_DELAY_MS);
    }

    /** The link in an admin's emailed request. */
    function fromLink() {
        try {
            const u = new URL(window.location.href);
            if (u.searchParams.get('review') !== '1') return false;
            u.searchParams.delete('review');
            history.replaceState(history.state, '', u.pathname + u.search + u.hash);
        } catch { return false; }
        open({ fromAsk: true, source: 'email' });
        post({ action: 'shown' }).catch(() => {});
        return true;
    }

    function init() { if (!fromLink()) check(); }

    window.PlatformReview = { open, check, init };
})();
