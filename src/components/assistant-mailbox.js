/**
 * src/components/assistant-mailbox.js — the Email Assistant's "Emails" tab (docs/email-assistant-plan.md §5.1).
 *
 *   window.AssistantMailbox.init({ hub, assistantId, assistantName })   (assistants.js, hubTab kind 'mailbox')
 *   window.AssistantMailbox.refresh()                                     (each time the tab opens)
 *
 * Reads netlify/functions/mailboxes.ts — the SIGNED-IN person's own mailboxes only. Phase 1 is read-only:
 * connect an Outlook or Gmail mailbox, see email sorted into categories with a priority and a one-line
 * summary, open one (its text is fetched from the mailbox then and not stored), move it to another category (in this
 * list only; the sender is remembered), mark senders private (never sent to AI), refresh, disconnect.
 * Renders into the Data Hub's own hosts (#datahub-toolbar, #datahub-table-host), which this tab owns.
 */
(function () {
  'use strict';
  const API = '/.netlify/functions/mailboxes';
  const state = { assistantId: null, data: null, pill: 'needs', mailboxId: null, open: new Set(), bodies: new Map(), busy: false };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (msg, kind) => (window.showToast ? window.showToast(msg, { type: kind || 'success' }) : console.log(msg));
  const host = () => document.getElementById('datahub-table-host');
  const bar = () => document.getElementById('datahub-toolbar');

  const PRIORITY_CHIP = {
    now: 'bg-red-100 text-red-800', today: 'bg-amber-100 text-amber-800', week: 'bg-blue-50 text-blue-800', whenever: 'bg-gray-100 text-gray-600',
  };
  // Connect outcomes coming back from mailbox-oauth.ts (?mailbox=connected / ?mailbox_error=…).
  const CONNECT_ERRORS = {
    access_denied: 'The sign-in was cancelled, so nothing was connected. (With Gmail, this also happens while Google is still reviewing the app and your address is not on its list of test users.)',
    admin_approval_needed: 'Your organisation needs an administrator to approve Be More Swan before you can connect this mailbox. Ask your Microsoft 365 or Google Workspace admin to allow the app, then try again.',
    scope_missing: 'Permission to read this mailbox was not given, so it was not connected. Try again and tick every permission on the sign-in screen.',
    not_available: 'The Email Assistant is not switched on for this workspace yet.',
    not_configured: 'Connecting this kind of mailbox is not set up on this site yet.',
    csrf_fail: 'That sign-in link had expired or was started by someone else. Please press Connect again.',
  };

  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso); const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const days = Math.floor((now - d) / 86400000);
    return days < 7 ? d.toLocaleDateString([], { weekday: 'short' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  const PROVIDER_NAME = { outlook: 'Outlook', gmail: 'Gmail' };
  const providerName = (p) => PROVIDER_NAME[p] || 'your email';

  function connectUrl(provider) {
    const p = provider === 'gmail' ? 'gmail' : 'outlook';
    return `/api/mailbox-oauth/${p}/connect?assistantId=${encodeURIComponent(state.assistantId)}`;
  }

  function showConnectOutcome() {
    const qp = new URLSearchParams(location.search);
    const ok = qp.get('mailbox') === 'connected';
    const err = qp.get('mailbox_error');
    if (!ok && !err) return;
    if (ok) toast('Mailbox connected. Your Email Assistant is sorting the last 14 days now — it takes a minute or two.');
    else if (window.alertModal) window.alertModal(CONNECT_ERRORS[err] || 'Connecting the mailbox did not work. Please try again.', { title: 'Mailbox not connected' });
    qp.delete('mailbox'); qp.delete('mailbox_error');
    history.replaceState(null, '', `${location.pathname}${qp.toString() ? `?${qp}` : ''}${location.hash}`);
  }

  async function load() {
    const res = await fetch(API, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load your email.');
    state.data = data;
    if (!state.mailboxId && data.mailboxes && data.mailboxes[0]) state.mailboxId = data.mailboxes[0].id;
    if (state.mailboxId && !(data.mailboxes || []).some((m) => m.id === state.mailboxId)) state.mailboxId = data.mailboxes[0]?.id ?? null;
  }

  function privacyNote() {
    return `<p class="text-xs text-gray-600 leading-relaxed">Only you can see this mailbox in Be More Swan — not your workspace's owner or admins.
      We keep each email's sender, subject, date and our one-line summary. We don't keep the text of your emails or any attachments:
      we fetch an email's text from your mailbox when you open it or when it's being sorted. Nothing in your mailbox is changed.</p>`;
  }

  function renderConnect() {
    bar().innerHTML = window._tabHead ? window._tabHead({ title: 'Emails' }) : '<h2 class="text-lg font-extrabold">Emails</h2>';
    host().innerHTML = `
      <div class="tab-card p-6 max-w-2xl space-y-4">
        <h3 class="text-base font-bold text-gray-900">Connect your business mailbox</h3>
        <p class="text-sm text-gray-700">Your Email Assistant reads your inbox, puts each email in a category, says what needs you today, and sums each one up in a line.</p>
        ${privacyNote()}
        <div class="flex flex-wrap items-center gap-3">
          ${(state.data.providers || {}).outlook !== false ? `<a href="${esc(connectUrl('outlook'))}" class="btn-primary inline-flex items-center px-4 py-2 text-sm font-bold rounded-lg" data-mailbox-connect="outlook">Connect Outlook</a>` : ''}
          ${(state.data.providers || {}).gmail ? `<a href="${esc(connectUrl('gmail'))}" class="btn-primary inline-flex items-center px-4 py-2 text-sm font-bold rounded-lg" data-mailbox-connect="gmail">Connect Gmail</a>` : ''}
          <span class="text-xs text-gray-500">${(state.data.providers || {}).gmail ? 'Outlook: Microsoft 365 and Outlook.com. Gmail: Gmail and Google Workspace.' : 'Microsoft 365 and Outlook.com. Gmail is coming soon.'}</span>
        </div>
      </div>`;
  }

  function renderUnavailable() {
    bar().innerHTML = window._tabHead ? window._tabHead({ title: 'Emails' }) : '';
    host().innerHTML = '<div class="tab-card p-6 text-sm text-gray-700">The Email Assistant is not switched on for this workspace yet.</div>';
  }

  function messagesFor(mailboxId) {
    return (state.data.messages || []).filter((m) => m.mailboxId === mailboxId);
  }

  function pillDefs(msgs) {
    const cats = state.data.categories || [];
    const count = (fn) => msgs.filter(fn).length;
    return [
      { key: 'needs', label: 'Needs you', n: count((m) => m.priority === 'now' || m.priority === 'today'), waiting: true },
      { key: 'all', label: 'All', n: msgs.length },
      // Only categories that hold email: ten empty pills would bury the list, worst of all on a phone.
      ...cats.map((c) => ({ key: `cat:${c.key}`, label: c.label, n: count((m) => m.category === c.key) })).filter((p) => p.n > 0),
      ...(count((m) => m.sortedBy === 'pending') ? [{ key: 'pending', label: 'Being sorted', n: count((m) => m.sortedBy === 'pending') }] : []),
    ];
  }

  function filtered(msgs) {
    if (state.pill === 'needs') return msgs.filter((m) => m.priority === 'now' || m.priority === 'today')
      .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'now' ? -1 : 1));
    if (state.pill === 'pending') return msgs.filter((m) => m.sortedBy === 'pending');
    if (state.pill.startsWith('cat:')) return msgs.filter((m) => m.category === state.pill.slice(4));
    return msgs;
  }

  function rowHtml(m) {
    const cats = state.data.categories || [];
    const pr = state.data.priorities || {};
    const chip = m.priority ? `<span class="inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full ${PRIORITY_CHIP[m.priority] || ''}">${esc(pr[m.priority] || m.priority)}</span>` : '<span class="inline-flex px-2 py-0.5 text-[11px] font-semibold rounded-full bg-gray-100 text-gray-500">Sorting…</span>';
    const open = state.open.has(m.id);
    const prov = providerName(((state.data.mailboxes || []).find((b) => b.id === m.mailboxId) || {}).provider);
    const body = state.bodies.get(m.id);
    const select = `<label class="sr-only" for="mbx-cat-${m.id}">Category</label>
      <select id="mbx-cat-${m.id}" data-mbx-cat="${m.id}" class="text-xs border border-gray-200 rounded-md px-1.5 py-1 bg-white" style="max-width:11rem">
        ${cats.filter((c) => c.key !== 'private').map((c) => `<option value="${esc(c.key)}"${c.key === m.category ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}
        ${m.category === 'private' ? '<option value="private" selected disabled>Private</option>' : ''}
      </select>`;
    return `<li class="border-b border-gray-100 last:border-0" data-mbx-row="${m.id}">
      <div class="flex items-start gap-3 px-4 py-3">
        <div class="pt-0.5 shrink-0 w-20">${chip}</div>
        <button type="button" class="min-w-0 flex-1 text-left cursor-pointer" data-mbx-open="${m.id}" aria-expanded="${open}">
          <span class="flex items-baseline gap-2">
            <span class="truncate text-sm ${m.isRead ? 'font-semibold text-gray-700' : 'font-extrabold text-gray-900'}">${esc(m.fromName || m.fromAddress || 'Unknown sender')}</span>
            <span class="ml-auto shrink-0 text-xs text-gray-500">${esc(when(m.receivedAt))}</span>
          </span>
          <span class="block truncate text-sm text-gray-800">${esc(m.subject || '(no subject)')}</span>
          ${m.summary ? `<span class="block text-xs text-gray-600 mt-0.5">${esc(m.summary)}</span>` : ''}
          ${m.reason && (m.priority === 'now' || m.priority === 'today') ? `<span class="block text-[11px] text-amber-700 mt-0.5">${esc(m.reason)}</span>` : ''}
        </button>
        <div class="shrink-0 hidden sm:block">${select}</div>
      </div>
      ${open ? `<div class="px-4 pb-4 space-y-2">
        <div class="sm:hidden">${select}</div>
        <div class="text-sm text-gray-800 whitespace-pre-wrap break-words bg-gray-50 border border-gray-100 rounded-lg p-3 max-h-64 overflow-y-auto">${body == null ? `Fetching this email from ${esc(prov)}…` : esc(body)}</div>
        <div class="flex flex-wrap gap-3 text-xs">
          ${m.webLink ? `<a class="tab-link" href="${esc(m.webLink)}" target="_blank" rel="noopener noreferrer">Open in ${esc(prov)}</a>` : ''}
          ${m.fromAddress && m.category !== 'private' ? `<button type="button" class="tab-link" data-mbx-private="${esc(m.fromAddress)}">Keep this sender private</button>` : ''}
        </div>
      </div>` : ''}
    </li>`;
  }

  function render() {
    const d = state.data;
    if (!d || !d.available) return renderUnavailable();
    if (!(d.mailboxes || []).length) return renderConnect();
    const box = d.mailboxes.find((m) => m.id === state.mailboxId) || d.mailboxes[0];
    const msgs = messagesFor(box.id);
    const statusChip = box.status === 'active'
      ? `<span class="tab-head-chip">${esc(box.address)}</span>`
      : `<span class="tab-head-chip" style="background:#fee2e2;color:#991b1b">${esc(box.address)} — needs reconnecting</span>`;
    const isOwner = !d.access || d.access === 'owner';
    const right = isOwner ? [
      window._tabSecBtn ? window._tabSecBtn('Refresh', 'data-mbx-refresh') : '',
      window._tabSecBtn ? window._tabSecBtn('Private senders', 'data-mbx-privlist') : '',
    ].join('') : '';
    bar().innerHTML = window._tabHead ? window._tabHead({ title: 'Emails', chip: statusChip, right }) : '';
    if (!isOwner) {
      host().innerHTML = `<div class="tab-card p-6 text-sm text-gray-700">Support view: email is only shown to the mailbox's owner, never here.
        ${Number(box.total) || 0} emails sorted, ${Number(box.needsYou) || 0} waiting for them.</div>`;
      return;
    }
    const pills = pillDefs(msgs);
    if (!pills.some((p) => p.key === state.pill)) state.pill = 'needs';
    const list = filtered(msgs);
    const lastRead = box.lastSyncAt ? `Last read ${when(box.lastSyncAt)}.` : 'Reading your inbox for the first time…';
    const problem = box.status !== 'active'
      ? `<div class="mx-4 mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">${esc(providerName(box.provider))} asked for this mailbox to be connected again. <a class="font-bold underline" href="${esc(connectUrl(box.provider))}">Reconnect</a></div>`
      : box.lastError ? `<p class="tab-help text-amber-700">${esc(box.lastError)}</p>` : '';
    const empty = state.pill === 'needs'
      ? 'Nothing needs you right now. 🎉'
      : msgs.length ? 'No emails here.' : 'No emails yet — your first sort is on its way.';
    host().innerHTML = `
      <div class="tab-card">
        <div class="tab-pillbar">
          <div class="stage-pills" role="tablist" aria-label="Email categories">
            ${pills.map((p) => `<button type="button" role="tab" aria-selected="${p.key === state.pill}" data-mbx-pill="${esc(p.key)}">${esc(p.label)}${window._tabPillCount ? window._tabPillCount(p.n, !!p.waiting) : ` (${p.n})`}</button>`).join('')}
          </div>
          <div class="tab-pillbar-actions"><button type="button" class="tab-link" data-mbx-disconnect>Disconnect</button></div>
        </div>
        <p class="tab-help">${esc(lastRead)} Sorted emails stay in your ${esc(providerName(box.provider))} inbox — nothing there is moved or changed.</p>
        ${problem}
        ${list.length ? `<ul class="mt-2">${list.map(rowHtml).join('')}</ul>` : `<p class="px-4 py-8 text-sm text-gray-600 text-center">${empty}</p>`}
      </div>`;
  }

  async function post(body) {
    const res = await fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'That did not work. Please try again.');
    return data;
  }

  async function openEmail(id) {
    if (state.open.has(id)) { state.open.delete(id); render(); return; }
    state.open.add(id); render();
    if (state.bodies.has(id)) return;
    try {
      const res = await fetch(`${API}?mailboxId=${encodeURIComponent(state.mailboxId)}&messageId=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      // Kept in this page's memory only, for this visit.
      state.bodies.set(id, res.ok ? (data.text || '(This email has no text.)') : (data.error || 'Could not fetch this email.'));
    } catch { state.bodies.set(id, 'Could not fetch this email.'); }
    render();
  }

  async function managePrivate() {
    const list = (state.data.privateSenders || {})[state.mailboxId] || [];
    const msg = `Emails from private senders are never sent to AI — not even the subject. They are listed as "Private".\n\n${list.length ? `Private now:\n${list.join('\n')}\n\n` : ''}Add an address, or @ and a domain (like @mydoctor.co.uk). To remove one, type it with a minus in front (-@mydoctor.co.uk).`;
    const value = window.promptModal ? await window.promptModal(msg, { title: 'Private senders', placeholder: 'name@example.com or @example.com', confirmLabel: 'Save' }) : window.prompt(msg);
    if (!value) return;
    const v = String(value).trim();
    try {
      const out = await post(v.startsWith('-') ? { action: 'private_senders', mailboxId: state.mailboxId, remove: v.slice(1) } : { action: 'private_senders', mailboxId: state.mailboxId, add: v });
      toast(out.message); await refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  function bind() {
    const root = host(); const top = bar();
    if (!root || root.dataset.mbxBound) return;
    root.dataset.mbxBound = '1';
    const onClick = async (e) => {
      const t = e.target.closest('[data-mbx-pill],[data-mbx-open],[data-mbx-private],[data-mbx-disconnect],[data-mbx-refresh],[data-mbx-privlist]');
      if (!t || state.busy) return;
      if (t.dataset.mbxPill) { state.pill = t.dataset.mbxPill; render(); return; }
      if (t.dataset.mbxOpen) { openEmail(Number(t.dataset.mbxOpen)); return; }
      if (t.hasAttribute('data-mbx-privlist')) { managePrivate(); return; }
      if (t.dataset.mbxPrivate) {
        try { const out = await post({ action: 'private_senders', mailboxId: state.mailboxId, add: t.dataset.mbxPrivate }); toast(out.message); await refresh(); }
        catch (err) { toast(err.message, 'error'); }
        return;
      }
      if (t.hasAttribute('data-mbx-refresh')) {
        try { const out = await post({ action: 'refresh', mailboxId: state.mailboxId }); toast(out.message); }
        catch (err) { toast(err.message, 'error'); }
        return;
      }
      if (t.hasAttribute('data-mbx-disconnect')) {
        const box = (state.data.mailboxes || []).find((m) => m.id === state.mailboxId);
        const ok = window.confirmModal ? await window.confirmModal(`Disconnect ${box ? box.address : 'this mailbox'}? Your Email Assistant stops reading it, and everything Be More Swan stored from it is deleted straight away. Your emails in ${box ? providerName(box.provider) : 'your mailbox'} are not touched.`, { title: 'Disconnect mailbox', confirmLabel: 'Disconnect', tone: 'destructive' }) : window.confirm('Disconnect this mailbox?');
        if (!ok) return;
        state.busy = true;
        try { const out = await post({ action: 'disconnect', mailboxId: state.mailboxId }); state.mailboxId = null; state.open.clear(); state.bodies.clear(); await refresh(); if (window.alertModal) window.alertModal(out.message, { title: 'Mailbox disconnected' }); }
        catch (err) { toast(err.message, 'error'); }
        finally { state.busy = false; }
      }
    };
    root.addEventListener('click', onClick);
    top?.addEventListener('click', onClick);
    root.addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-mbx-cat]');
      if (!sel) return;
      try {
        const out = await post({ action: 'recategorise', mailboxId: state.mailboxId, messageId: Number(sel.dataset.mbxCat), category: sel.value });
        const m = (state.data.messages || []).find((x) => x.id === Number(sel.dataset.mbxCat));
        if (m) { m.category = sel.value; m.sortedBy = 'user'; }
        toast(out.message); render();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  async function refresh() {
    if (!state.assistantId || !host()) return;
    // The page is a single-page app: after leaving the Email Assistant for another assistant, this
    // module must not paint over that assistant's Data Hub.
    const current = window._detailCurrentData;
    if (current && Number(current.id) !== Number(state.assistantId)) { state.assistantId = null; return; }
    try { await load(); render(); }
    catch (err) { host().innerHTML = `<div class="bg-red-50 border border-red-200 rounded-2xl p-6 text-sm font-semibold text-red-700">${esc(err.message)}</div>`; }
  }

  async function init({ assistantId }) {
    if (!assistantId) return;
    state.assistantId = assistantId;
    state.pill = 'needs'; state.open.clear(); state.bodies.clear(); state.mailboxId = null;
    if (host()) host().innerHTML = '<p class="text-sm text-gray-500">Loading…</p>';
    bind();
    showConnectOutcome();
    await refresh();
  }

  window.AssistantMailbox = { init, refresh, _test: { pillDefs, filtered, esc } };
})();
