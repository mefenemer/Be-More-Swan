// help.js — Help & Support (the workspace's `help` view, help-content.html).
//
// Three tabs:
//   Knowledge Base   → help_articles (read-only here; edited in Admin → Master Data → Help articles)
//   Contact us       → ONE form and ONE list for the customer (2026-10-18), two queues behind it:
//                        "Something isn't working" → issue_reports (Admin → Issue Reports, the fix
//                        workflow, with area + screenshot); every other topic → support_tickets +
//                        ticket_replies (Admin → Support Tickets / helpdesk). The list merges both.
//   Feature Requests → feature_requests (Admin → Feature Requests; UI + logic in help-content.html)
// 'issues' and 'tickets' were tabs until 2026-10-18; they are aliases of 'contact' so notifications,
// the command bar and ?help=issues email links still land in the right place.
//
// "Report an Issue" used to be a header icon and a pop-up of its own (until 2026-10-03). It lives
// here now; window.openReportIssue / window.routeToIssueReport still exist so the command bar, the
// issue-update notification and the ?issue=N email link keep working — they navigate here.

(function () {
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const TABS = ['docs', 'contact', 'features'];
    const TAB_ALIAS = { issues: 'contact', tickets: 'contact' };
    const tabName = (t) => TAB_ALIAS[t] || t;
    const TAB_ON = 'tab-btn whitespace-nowrap py-4 px-1 border-b-2 font-bold text-sm border-emerald-500 text-emerald-600';
    const TAB_OFF = 'tab-btn whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300';

    // ── Tabs ─────────────────────────────────────────────────────────────────────────────────────
    // ⚠️ Callers that want a particular tab (a notification's "View ticket", the command bar's
    // "Report an issue") must not click a tab button after a timeout: the view loads asynchronously
    // and the buttons are bound only once initHelpCenter runs, so the click landed on nothing and
    // the user was left on the Knowledge Base. They set window._helpInitialTab (via openHelpTab)
    // and initHelpCenter opens it.
    let featureRequestsInitialized = false;
    let onTab = {};
    window.helpShowTab = function (tab) {
        tab = tabName(tab);
        if (!TABS.includes(tab)) tab = 'docs';
        let present = false;
        TABS.forEach((t) => {
            const content = document.getElementById(`tab-content-${t}`);
            const btn = document.getElementById(`tab-btn-${t}`);
            if (!content || !btn) return;
            present = true;
            content.classList.toggle('hidden', t !== tab);
            content.classList.toggle('block', t === tab);
            btn.className = t === tab ? TAB_ON : TAB_OFF;
            btn.setAttribute('aria-selected', String(t === tab));
        });
        if (!present) return false;
        if (typeof onTab[tab] === 'function') onTab[tab]();
        return true;
    };

    /** Go to Help & Support on a given tab, from anywhere in the workspace. */
    window.openHelpTab = function (tab, after) {
        tab = tabName(tab);
        window._helpInitialTab = tab;
        window._helpAfterOpen = typeof after === 'function' ? after : null;
        if (window._currentViewKey === 'help' && document.getElementById('tab-btn-docs')) {
            window._helpInitialTab = null;
            window.helpShowTab(tab);
            if (window._helpAfterOpen) { const f = window._helpAfterOpen; window._helpAfterOpen = null; f(); }
            return;
        }
        window.loadView && window.loadView('help');
    };

    // ── Report an Issue ──────────────────────────────────────────────────────────────────────────
    let _pendingImage = null;          // data URL of the attached screenshot
    let _myReports = [];
    const STATUS_BADGE = {
        reported:            ['Reported', 'bg-gray-100 text-gray-700'],
        backlog:             ['Backlog', 'bg-slate-100 text-slate-700'],
        on_hold:             ['On Hold', 'bg-orange-100 text-orange-700'],
        fix_in_progress:     ['Fix In Progress', 'bg-blue-100 text-blue-700'],
        merge:               ['Merge', 'bg-indigo-100 text-indigo-700'],
        fixed_ready_to_test: ['Fixed & Ready to Test', 'bg-emerald-100 text-emerald-700'],
        more_info_required:  ['More Info Required', 'bg-amber-100 text-amber-800'],
        closed:              ['Closed', 'bg-gray-200 text-gray-500'],
        roadmap:             ['On Roadmap', 'bg-violet-100 text-violet-700'],
    };
    const AREA_LABEL = (key) => {
        const opt = document.querySelector(`#ri-area option[value="${CSS.escape(String(key || ''))}"]`);
        return opt ? opt.textContent : '';
    };

    function riError(msg) {
        const el = document.getElementById('ri-error');
        if (!el) return;
        if (!msg) { el.classList.add('hidden'); return; }
        el.textContent = msg; el.classList.remove('hidden');
    }

    // Kept for callers elsewhere (the command bar, notifications): both land on this tab now.
    window.openReportIssue = function (tab) {
        window.openHelpTab('contact', tab === 'mine' ? () => document.getElementById('ri-my-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : null);
    };
    window.closeReportIssue = function () {};

    window.riClearImage = function () {
        _pendingImage = null;
        const input = document.getElementById('ri-image'); if (input) input.value = '';
        document.getElementById('ri-image-preview')?.classList.add('hidden');
    };

    // Bound on document once (the tab is re-injected on every visit).
    document.addEventListener('change', function (e) {
        if (!e.target || e.target.id !== 'ri-image') return;
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { riError('Image exceeds the 5 MB limit.'); window.riClearImage(); return; }
        const reader = new FileReader();
        reader.onload = () => {
            _pendingImage = reader.result;
            const thumb = document.getElementById('ri-image-thumb');
            if (thumb) thumb.src = _pendingImage;
            document.getElementById('ri-image-preview')?.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    });

    // The topic decides the queue: a fault goes to the fix workflow, everything else is a ticket.
    window.submitContact = function () {
        const topic = document.getElementById('cu-topic')?.value || 'broken';
        return topic === 'broken' ? window.submitReportIssue() : submitTicket(topic);
    };

    // ── Request a call back (src/utils/callback-request.ts) ──────────────────────────────────────
    // Its OWN small form in the "Prefer to talk?" card — an ADDITION to "How can we help?", never a
    // mode of it (owner, 2026-10-19: the first version switched the support form into a phone form,
    // so a customer arriving from Team Chat could no longer see how to raise a request). A ticket in
    // category 'callback': a phone number and the customer's timezone (so whoever rings does not call
    // in their night). No time is offered or promised. Opened by the card's button, by Team Chat and
    // by the assistant chat's card (window.openCallbackForm).
    const _tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
    function cbError(msg) {
        const el = document.getElementById('cb-error');
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('hidden', !msg);
    }
    function showCallbackForm(open) {
        document.getElementById('cb-form')?.classList.toggle('hidden', !open);
        const opener = document.getElementById('cb-open');
        if (opener) { opener.classList.toggle('hidden', open); opener.style.display = open ? 'none' : ''; }
        const tzNote = document.getElementById('cb-tz-note');
        if (tzNote) tzNote.textContent = _tz ? `We'll note your time zone (${_tz}) so we don't call at night.` : '';
        if (!open) cbError('');
    }
    window.openCallbackForm = function () {
        window.openHelpTab('contact', () => {
            showCallbackForm(true);
            document.getElementById('cb-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setTimeout(() => document.getElementById('cb-phone')?.focus(), 300);
        });
    };
    window.closeCallbackForm = function () { showCallbackForm(false); };

    window.submitCallback = async function () {
        const phoneEl = document.getElementById('cb-phone');
        const notesEl = document.getElementById('cb-notes');
        const phone = (phoneEl?.value || '').trim();
        const notes = (notesEl?.value || '').trim();
        cbError('');
        const digits = phone.replace(/\D/g, '');
        if (digits.length < 7 || digits.length > 15 || !/^\+?[\d\s().-]+$/.test(phone)) {
            cbError('Please give a phone number we can call, including the country code if you are outside the UK.');
            return;
        }
        const btn = document.getElementById('cb-submit');
        if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
        try {
            const res = await fetch('/.netlify/functions/support-tickets', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category: 'callback', callback: { phone, timezone: _tz, notes } }),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { cbError(d.error || 'Could not send — please try again.'); return; }
            if (phoneEl) phoneEl.value = '';
            if (notesEl) notesEl.value = '';
            showCallbackForm(false);
            window.showToast?.(`Thanks — we'll call you back. Request #TK-${d.ticket?.id ?? ''}; we've emailed you a copy.`, { icon: '📞' });
            window.updateNotificationBadge?.();
            loadMyReports();
        } catch {
            cbError('Network error — please try again.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Request a call back'; }
        }
    };

    // Area and screenshot only mean something for a fault — the helpdesk takes neither.
    function syncContactFields() {
        const broken = (document.getElementById('cu-topic')?.value || 'broken') === 'broken';
        document.getElementById('cu-broken-fields')?.classList.toggle('hidden', !broken);
        document.getElementById('cu-image-fields')?.classList.toggle('hidden', !broken);
        const desc = document.getElementById('ri-description');
        if (desc) desc.placeholder = broken ? 'What happened, and what did you expect?' : 'Tell us as much as you can — we usually reply within 1–2 business days.';
    }
    document.addEventListener('change', (e) => { if (e.target && e.target.id === 'cu-topic') syncContactFields(); });

    async function submitTicket(category) {
        const descEl = document.getElementById('ri-description');
        const desc = (descEl?.value || '').trim();
        riError('');
        if (!desc) { riError('Please tell us a little more.'); return; }
        // The helpdesk wants a subject; the first line of the message is it, so the form asks once.
        const first = desc.split('\n')[0].trim();
        const subject = first.length > 80 ? `${first.slice(0, 79).replace(/\s+\S*$/, '')}…` : first;
        const btn = document.getElementById('ri-submit');
        if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
        try {
            const res = await fetch('/.netlify/functions/support-tickets', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subject, category, description: desc }),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { riError(d.error || 'Could not send — please try again.'); return; }
            if (descEl) descEl.value = '';
            window.showToast?.(`Sent — request #TK-${d.ticket?.id ?? ''}. We've emailed you a copy.`, { icon: '✉️' });
            window.updateNotificationBadge?.();
            loadMyReports();
        } catch {
            riError('Network error — please try again.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
        }
    }

    window.submitReportIssue = async function () {
        const desc = (document.getElementById('ri-description')?.value || '').trim();
        riError('');
        if (!desc) { riError('Please describe the issue.'); return; }
        const area = document.getElementById('ri-area')?.value || 'other';
        const btn = document.getElementById('ri-submit');
        if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
        try {
            const res = await fetch('/.netlify/functions/issue-reports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    description: desc,
                    // The area the user picked, which is what the fix team needs — the URL is the
                    // Help page now, so it is sent alongside rather than instead.
                    sourceLocation: AREA_LABEL(area) || area,
                    sourceUrl: window.location.href,
                    image: _pendingImage || undefined,
                }),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { riError(d.error || 'Could not submit. Please try again.'); return; }
            document.getElementById('ri-description').value = '';
            window.riClearImage();
            window.showToast?.('Thanks — your issue has been reported. You can follow it here.', { icon: '🐞' });
            loadMyReports();
        } catch {
            riError('Network error — please try again.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
        }
    };

    // "Your requests": issues and tickets in one list, whatever is waiting on the user first, then
    // newest first. Each half loads on its own — one queue being down still shows the other.
    let _myTickets = [];
    let _listErrors = [];
    async function loadMyReports() {
        const list = document.getElementById('ri-my-list');
        if (!list) return;
        list.innerHTML = 'Loading…';
        _listErrors = [];
        const [issues, tickets] = await Promise.all([
            fetch('/.netlify/functions/issue-reports').then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error); return d.issues || []; })
                .catch(() => { _listErrors.push('reported problems'); return []; }),
            fetch('/.netlify/functions/support-tickets').then(async (r) => { const d = await r.json().catch(() => ([])); if (!r.ok) throw new Error(); return Array.isArray(d) ? d : []; })
                .catch(() => { _listErrors.push('questions'); return []; }),
        ]);
        _myReports = issues;
        _myTickets = tickets;
        renderMyReportsList();
    }

    function renderMyReportsList() {
        const list = document.getElementById('ri-my-list');
        if (!list) return;
        const items = [
            ..._myReports.map((i) => ({ kind: 'issue', at: i.createdAt, waiting: i.status === 'fixed_ready_to_test' || i.status === 'more_info_required', html: renderIssueCard(i) })),
            ..._myTickets.map((t) => ({ kind: 'ticket', at: t.createdAt, waiting: t.status === 'pending_customer' || t.status === 'pending', html: renderTicketCard(t) })),
        ].sort((a, b) => (Number(b.waiting) - Number(a.waiting)) || (new Date(b.at || 0) - new Date(a.at || 0)));
        const err = _listErrors.length ? `<p class="text-red-600 text-xs">Couldn't load your ${esc(_listErrors.join(' or '))} — try again in a moment.</p>` : '';
        list.innerHTML = err + (items.length ? items.map((x) => x.html).join('') : '<p class="text-gray-400">Nothing yet — anything you send appears here, with our replies.</p>');
    }

    function renderTicketCard(t) {
        const date = t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '';
        return `
          <div class="border border-gray-200 rounded-xl p-3 cursor-pointer hover:bg-gray-50" data-ticket-id="${esc(t.id)}" tabindex="0" role="button" aria-label="Open request ${esc(t.id)}">
            <div class="flex items-start justify-between gap-2">
              <p class="text-sm font-semibold text-gray-800">${esc(t.subject)}</p>
              <span class="shrink-0">${ticketBadge(t.status)}</span>
            </div>
            <p class="text-[11px] text-gray-400 mt-1">#TK-${esc(t.id)} · ${esc(CATEGORY_LABEL[t.category] || t.category)} · ${esc(date)} · <span class="text-emerald-700 font-semibold">Open conversation</span></p>
          </div>`;
    }

    function renderIssueCard(i) {
        const [label, cls] = STATUS_BADGE[i.status] || [i.statusLabel || i.status, 'bg-gray-100 text-gray-700'];
        const date = i.createdAt ? new Date(i.createdAt).toLocaleDateString() : '';
        const thread = (i.messages || []).map((m) => `
          <div class="mt-2 rounded-lg p-2 text-xs ${m.authorType === 'admin' ? 'bg-blue-50 border border-blue-100' : 'bg-gray-50 border border-gray-100'}">
            <span class="font-bold ${m.authorType === 'admin' ? 'text-blue-700' : 'text-gray-600'}">${m.authorType === 'admin' ? 'Be More Swan team' : 'You'}</span>
            <span class="text-gray-400"> · ${m.createdAt ? new Date(m.createdAt).toLocaleString() : ''}</span>
            <p class="text-gray-800 whitespace-pre-wrap mt-0.5">${esc(m.body)}</p>
          </div>`).join('');
        let actions = '';
        if (i.status === 'fixed_ready_to_test') {
            actions = `
            <div class="mt-3 flex gap-2 flex-wrap">
              <button type="button" onclick="window.riConfirmFixed(${i.id})" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg">Confirm fix works</button>
              <button type="button" onclick="window.riToggleReply(${i.id})" class="btn-secondary px-3 py-1.5 text-xs font-semibold border rounded-lg">Still broken — reply</button>
            </div>`;
        } else if (i.status === 'more_info_required') {
            actions = `<div class="mt-3"><button type="button" onclick="window.riToggleReply(${i.id})" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg">Provide more info</button></div>`;
        } else if (i.status !== 'closed') {
            actions = `<div class="mt-3"><button type="button" onclick="window.riToggleReply(${i.id})" class="btn-utility px-2 py-1 text-xs font-semibold rounded-lg">Add a comment</button></div>`;
        }
        return `
          <div class="border border-gray-200 rounded-xl p-3" data-issue-id="${i.id}">
            <div class="flex items-start justify-between gap-2">
              <p class="text-sm font-semibold text-gray-800 whitespace-pre-wrap">${esc(i.description)}</p>
              <span class="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${cls}">${esc(label)}</span>
            </div>
            <p class="text-[11px] text-gray-400 mt-1">#${i.id} · ${esc(i.sourceLocation || '—')} · ${date}${i.hasImage ? ' · 📎 screenshot' : ''}</p>
            ${thread}
            ${actions}
            <div id="ri-reply-${i.id}" class="hidden mt-2">
              <textarea id="ri-reply-input-${i.id}" rows="2" placeholder="Type your reply…" class="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:ring-2 focus:ring-emerald-600 focus:outline-none resize-none"></textarea>
              <button type="button" onclick="window.riSendReply(${i.id})" class="btn-primary mt-1 px-3 py-1 text-xs font-bold rounded-lg">Send</button>
            </div>
          </div>`;
    }

    window.riToggleReply = function (id) {
        document.getElementById(`ri-reply-${id}`)?.classList.toggle('hidden');
        document.getElementById(`ri-reply-input-${id}`)?.focus();
    };

    window.riSendReply = async function (id) {
        const input = document.getElementById(`ri-reply-input-${id}`);
        const message = (input?.value || '').trim();
        if (!message) return;
        try {
            const res = await fetch('/.netlify/functions/issue-reports', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ issueId: id, message }),
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); window.showToast?.(d.error || 'Could not send reply.'); return; }
            loadMyReports();
        } catch { window.showToast?.('Network error — please try again.'); }
    };

    window.riConfirmFixed = async function (id) {
        try {
            const res = await fetch('/.netlify/functions/issue-reports', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ issueId: id, action: 'confirm-fixed' }),
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); window.showToast?.(d.error || 'Could not update.'); return; }
            window.showToast?.('Great — marked as fixed. Thank you!', { icon: '✅' });
            loadMyReports();
        } catch { window.showToast?.('Network error — please try again.'); }
    };

    // The issue-update notification ("View issue") and the ?issue=N email link.
    window.routeToIssueReport = function (issueId) {
        window.openHelpTab('contact', () => {
            if (issueId == null) return;
            const focusCard = () => {
                const card = document.querySelector(`[data-issue-id="${issueId}"]`);
                if (!card) return false;
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                card.classList.add('ring-2', 'ring-amber-400');
                setTimeout(() => card.classList.remove('ring-2', 'ring-amber-400'), 2000);
                return true;
            };
            let tries = 0;
            const t = setInterval(() => { if (focusCard() || ++tries > 20) clearInterval(t); }, 150);
        });
    };
    try {
        const qs = new URLSearchParams(window.location.search);
        const issueId = qs.get('issue');
        if (issueId) window.addEventListener('load', () => setTimeout(() => window.routeToIssueReport(Number(issueId)), 600));
        // ?help=<tab> — a direct link to one Help & Support tab, e.g. the beta testers' welcome
        // email's "share feedback" link (?help=issues / ?help=features). Same timing as ?issue.
        const helpTab = qs.get('help');
        if (qs.get('callback') === '1') {
            // From the chat's "Request a call back" card on a page without this panel.
            window.addEventListener('load', () => setTimeout(() => window.openCallbackForm(), 600));
        } else if (helpTab && TABS.includes(tabName(helpTab))) {
            window.addEventListener('load', () => setTimeout(() => window.openHelpTab(helpTab), 600));
        }
    } catch { /* noop */ }

    // ── Support tickets ──────────────────────────────────────────────────────────────────────────
    // support_tickets.status is 'new' | 'open' | 'pending_customer' | 'resolved' | 'closed'. The
    // list used to know three of them, so a ticket waiting on the CUSTOMER read as "Open".
    const TICKET_BADGE = {
        new:              ['Received', 'bg-gray-100 text-gray-700 border-gray-200'],
        open:             ['Open', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
        pending:          ['Awaiting your reply', 'bg-amber-50 text-amber-700 border-amber-200'],
        pending_customer: ['Awaiting your reply', 'bg-amber-50 text-amber-700 border-amber-200'],
        resolved:         ['Resolved', 'bg-gray-100 text-gray-600 border-gray-200'],
        closed:           ['Closed', 'bg-gray-100 text-gray-500 border-gray-200'],
    };
    const ticketBadge = (status) => {
        const [label, cls] = TICKET_BADGE[status] || [status || 'Open', 'bg-gray-100 text-gray-600 border-gray-200'];
        return `<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold border ${cls}">${esc(label)}</span>`;
    };
    const CATEGORY_LABEL = {
        technical: 'How do I…? / Account help', assistant: 'Assistant behaviour', billing: 'Billing / Subscription',
        feature: 'Feature request', other: 'Something else', callback: 'Call back',
    };

    async function openTicket(id) {
        const box = document.getElementById('ticket-thread');
        if (!box) return;
        box.classList.remove('hidden');
        box.innerHTML = '<p class="text-sm text-gray-400">Loading…</p>';
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        try {
            const res = await fetch(`/.netlify/functions/support-tickets?ticketId=${encodeURIComponent(id)}`);
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.error || 'Could not open that ticket.');
            const t = d.ticket;
            const replies = (d.replies || []).map((r) => `
              <div class="rounded-lg p-3 text-sm ${r.fromTeam ? 'bg-blue-50 border border-blue-100' : 'bg-gray-50 border border-gray-100'}">
                <p class="text-xs"><span class="font-bold ${r.fromTeam ? 'text-blue-700' : 'text-gray-600'}">${r.fromTeam ? 'Be More Swan team' : 'You'}</span>
                  <span class="text-gray-400"> · ${esc(new Date(r.createdAt).toLocaleString())}</span></p>
                <p class="text-gray-800 whitespace-pre-wrap mt-1">${esc(r.body)}</p>
              </div>`).join('');
            const closed = t.status === 'closed';
            box.innerHTML = `
              <div class="flex items-start justify-between gap-3 mb-3">
                <div class="min-w-0">
                  <p class="text-xs text-gray-400 font-mono">#TK-${t.id}</p>
                  <h4 class="text-base font-bold text-gray-900">${esc(t.subject)}</h4>
                </div>
                <div class="flex items-center gap-2 shrink-0">${ticketBadge(t.status)}
                  <button type="button" data-ticket-close class="btn-utility px-2 py-1 text-xs font-semibold rounded-lg" aria-label="Close this ticket view">✕</button></div>
              </div>
              <div class="space-y-2">
                <div class="rounded-lg p-3 text-sm bg-gray-50 border border-gray-100">
                  <p class="text-xs"><span class="font-bold text-gray-600">You</span><span class="text-gray-400"> · ${esc(new Date(t.createdAt).toLocaleString())}</span></p>
                  <p class="text-gray-800 whitespace-pre-wrap mt-1">${esc(t.description)}</p>
                </div>
                ${replies || '<p class="text-xs text-gray-400">No replies yet — we typically respond within 1–2 business days.</p>'}
              </div>
              ${closed ? '<p class="text-xs text-gray-500 mt-4">This ticket is closed. Open a new one if you need more help.</p>' : `
              <div class="mt-4">
                <label for="ticket-reply-input" class="block text-xs font-bold text-gray-600 mb-1">Reply</label>
                <textarea id="ticket-reply-input" rows="3" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-emerald-600 outline-none" placeholder="Add more detail or answer the team's question…"></textarea>
                <div class="flex items-center gap-3 mt-2">
                  <button type="button" data-ticket-reply="${t.id}" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg">Send reply</button>
                  <span id="ticket-reply-msg" class="text-xs font-semibold"></span>
                </div>
              </div>`}`;
        } catch (e) {
            box.innerHTML = `<p class="text-sm text-red-600">${esc(e.message || 'Could not open that ticket.')}</p>`;
        }
    }

    async function sendTicketReply(id, btn) {
        const input = document.getElementById('ticket-reply-input');
        const msg = document.getElementById('ticket-reply-msg');
        const message = (input?.value || '').trim();
        if (!message) { if (msg) { msg.className = 'text-xs font-semibold text-red-600'; msg.textContent = 'Write a reply first.'; } return; }
        btn.disabled = true;
        try {
            const res = await fetch('/.netlify/functions/support-tickets', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticketId: id, message }),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.error || 'Could not send your reply.');
            window.showToast?.('Reply sent.', { icon: '✉️' });
            await loadMyReports();
            await openTicket(id);
        } catch (e) {
            if (msg) { msg.className = 'text-xs font-semibold text-red-600'; msg.textContent = e.message; }
            btn.disabled = false;
        }
    }

    // Delegated once on document — the view's DOM is replaced on every visit.
    document.addEventListener('click', (e) => {
        const row = e.target.closest && e.target.closest('#ri-my-list [data-ticket-id]');
        if (row) { openTicket(row.getAttribute('data-ticket-id')); return; }
        if (e.target.closest && e.target.closest('[data-ticket-close]')) { document.getElementById('ticket-thread')?.classList.add('hidden'); return; }
        const r = e.target.closest && e.target.closest('[data-ticket-reply]');
        if (r) sendTicketReply(r.getAttribute('data-ticket-reply'), r);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const row = e.target.closest && e.target.closest('#ri-my-list [data-ticket-id]');
        if (row) openTicket(row.getAttribute('data-ticket-id'));
    });

    // Notifications' "View ticket".
    window.routeToSupportTicket = function (ticketId) {
        window.openHelpTab('contact', ticketId != null ? () => openTicket(ticketId) : null);
    };

    // ── Knowledge base ───────────────────────────────────────────────────────────────────────────
    // Articles open with "# <their title>" — skip that line, or every card repeats its own heading.
    const excerpt = (md) => String(md || '').replace(/^\s*#\s+[^\n]*\n/, '').replace(/#{1,6}\s+/g, '').replace(/[*_`[\]>|]/g, '').replace(/\n+/g, ' ').trim().slice(0, 140);
    const CHIP_ON = 'px-4 py-2 rounded-full text-sm font-bold bg-emerald-50 text-emerald-700 border border-emerald-100 transition filter-btn';
    const CHIP_OFF = 'px-4 py-2 rounded-full text-sm font-medium bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 transition filter-btn';
    // Chip labels for the long category names; anything else shows as stored.
    const CHIP_SHORT = { 'Integrations & Connections': 'Integrations', 'Billing & Your Plan': 'Billing', 'Troubleshooting & Quick Fixes': 'Troubleshooting' };

    async function initKnowledgeBase() {
        const grid = document.getElementById('help-grid');
        if (!grid) return;
        const searchInput = document.getElementById('help-search-input');
        const filters = document.getElementById('help-filters');
        const listMode = document.getElementById('help-list-mode');
        const articleView = document.getElementById('help-article-view');
        let allArticles = [];
        let currentCategory = 'All';
        let currentSearch = '';

        function renderArticles(articles) {
            if (!articles.length) {
                grid.innerHTML = `<div class="col-span-full py-12 text-center text-gray-500 font-medium">No articles match — try another word, or <button type="button" class="font-semibold text-emerald-700 hover:underline" onclick="window.helpShowTab('contact')">ask the team</button>.</div>`;
                return;
            }
            // Cards, not buttons-as-actions: a white card with the button system's focus ring only.
            grid.innerHTML = articles.map((a) => `
              <button type="button" data-article-id="${esc(a.id)}"
                 class="text-left bg-white rounded-2xl border border-gray-200 hover:border-emerald-300 shadow-sm p-6 hover:shadow-md transition flex flex-col h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">
                <span class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-4">${esc(a.category)}</span>
                <h3 class="text-lg font-bold text-gray-900 mb-2">${esc(a.title)}</h3>
                <p class="text-sm text-gray-500 mb-6 flex-grow line-clamp-3">${esc(excerpt(a.contentMd))}</p>
                <span class="text-xs font-semibold text-emerald-700">Read article →</span>
              </button>`).join('');
        }

        function renderChips() {
            if (!filters) return;
            const cats = [...new Set(allArticles.map((a) => a.category).filter(Boolean))];
            filters.innerHTML = ['All', ...cats].map((c) =>
                `<button type="button" data-category="${esc(c)}" class="${c === currentCategory ? CHIP_ON : CHIP_OFF}">${esc(c === 'All' ? 'All Articles' : (CHIP_SHORT[c] || c))}</button>`).join('');
        }

        function filterData() {
            const q = currentSearch;
            renderArticles(allArticles.filter((a) =>
                (currentCategory === 'All' || a.category === currentCategory)
                && (!q || a.title.toLowerCase().includes(q) || String(a.contentMd || '').toLowerCase().includes(q))));
        }

        function showArticle(a) {
            document.getElementById('help-article-category').textContent = a.category || '';
            document.getElementById('help-article-title').textContent = a.title;
            let html = esc(a.contentMd);
            if (window.marked && window.DOMPurify) {
                window.marked.setOptions({ breaks: false, gfm: true });
                html = window.DOMPurify.sanitize(window.marked.parse(a.contentMd));
            }
            document.getElementById('help-article-body').innerHTML = html;
            listMode?.classList.add('hidden');
            articleView?.classList.remove('hidden');
            window.scrollTo(0, 0);
        }

        // In-article links are written as [text](#article-title-slug) — open that article here,
        // rather than letting a bare #hash do nothing.
        const slug = (t) => String(t || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        document.getElementById('help-article-body')?.addEventListener('click', (e) => {
            const link = e.target.closest('a[href^="#"]');
            if (!link) return;
            const want = decodeURIComponent(link.getAttribute('href').slice(1));
            const a = allArticles.find((x) => slug(x.title) === want);
            if (!a) return;
            e.preventDefault();
            showArticle(a);
        });

        grid.addEventListener('click', (e) => {
            const card = e.target.closest('[data-article-id]');
            if (!card) return;
            const a = allArticles.find((x) => String(x.id) === card.dataset.articleId);
            if (a) showArticle(a);
        });
        filters?.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-category]');
            if (!chip) return;
            currentCategory = chip.getAttribute('data-category') || 'All';
            renderChips();
            filterData();
        });
        searchInput?.addEventListener('input', (e) => { currentSearch = String(e.target.value).trim().toLowerCase(); filterData(); });
        document.getElementById('help-article-back')?.addEventListener('click', () => {
            articleView?.classList.add('hidden');
            listMode?.classList.remove('hidden');
        });

        try {
            const res = await fetch('/.netlify/functions/get-help-articles');
            if (!res.ok) throw new Error();
            allArticles = (await res.json()).articles || [];
            renderChips();
            renderArticles(allArticles);
            // Open a named article: window.openHelpArticle('Title') from anywhere in the workspace.
            if (window._helpOpenArticle) {
                const want = String(window._helpOpenArticle).toLowerCase();
                window._helpOpenArticle = null;
                const a = allArticles.find((x) => x.title.toLowerCase() === want);
                if (a) showArticle(a);
            }
        } catch {
            grid.innerHTML = `<div class="col-span-full text-center text-red-500">Couldn't load the knowledge base — try again.</div>`;
        }
    }

    window.openHelpArticle = function (title) {
        window._helpOpenArticle = title;
        window.openHelpTab('docs');
    };

    // ── Entry point (loadView('help') → initHelpCenter) ──────────────────────────────────────────
    window.initHelpCenter = async function () {
        featureRequestsInitialized = false;
        onTab = {
            contact: () => { syncContactFields(); loadMyReports(); },
            features: () => {
                if (!featureRequestsInitialized && typeof window.initFeatureRequests === 'function') {
                    featureRequestsInitialized = true;
                    window.initFeatureRequests();
                }
            },
        };
        TABS.forEach((t) => {
            document.getElementById(`tab-btn-${t}`)?.addEventListener('click', () => window.helpShowTab(t));
        });

        // Pre-select the area the user came from in the issue form.
        const prev = window._previousView && window._previousView.key;
        const area = document.getElementById('ri-area');
        if (area && prev && area.querySelector(`option[value="${CSS.escape(prev)}"]`)) area.value = prev;

        // Open the requested tab BEFORE the knowledge base's network wait, so a caller is never
        // left looking at the wrong tab while articles load.
        const want = window._helpInitialTab || 'docs';
        window._helpInitialTab = null;
        window.helpShowTab(want);
        if (window._helpAfterOpen) { const f = window._helpAfterOpen; window._helpAfterOpen = null; setTimeout(f, 0); }

        await initKnowledgeBase();
    };
})();
