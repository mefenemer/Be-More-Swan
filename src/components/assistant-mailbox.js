/**
 * src/components/assistant-mailbox.js — the Email Assistant's "Emails" tab (docs/email-assistant-plan.md §5.1).
 *
 *   window.AssistantMailbox.init({ hub, assistantId, assistantName })   (assistants.js, hubTab kind 'mailbox')
 *   window.AssistantMailbox.refresh()                                     (each time the tab opens)
 *
 * Reads netlify/functions/mailboxes.ts — the SIGNED-IN person's own mailboxes only:
 * connect an Outlook or Gmail mailbox, see email sorted into categories with a priority and a one-line
 * summary, open one (its text is fetched from the mailbox then and not stored), move it to another category (in this
 * list only; the sender is remembered), mark senders private (never sent to AI), refresh, disconnect.
 * Phase 2a: draft a reply (edit it; Shorter / Longer / Redraft; Send in the thread or Save to drafts —
 * each after a confirm), clean-up batches (untick any; Archive or Move to trash after a confirm), and a
 * Done list with Undo. Nothing is sent or moved without the owner pressing the button for it.
 * Renders into the Data Hub's own hosts (#datahub-toolbar, #datahub-table-host), which this tab owns.
 */
(function () {
  'use strict';
  const API = '/.netlify/functions/mailboxes';
  const state = {
    assistantId: null, data: null, pill: 'needs', mailboxId: null, open: new Set(), bodies: new Map(), busy: false,
    // Phase 2a
    actions: [], cleanup: [], undoDays: 30, cleanupChunk: 25, archiveRules: [], labelsOn: false,
    drafting: new Set(),      // message ids with a draft being written
    draftText: new Map(),     // action id → the text in the editor (saved on blur, sent as shown)
    cleanupSel: new Map(),    // batch key → Set of message ids still ticked
    cleanupOpen: new Set(),   // batch keys showing their emails
  };
  const GAP_RE = /\[check:[^\]]*\]/gi;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // dialogs.js showToast takes { icon, tone }: tone 'error' keeps it up longer and announces it (role=alert).
  const toast = (msg, kind) => (window.showToast
    ? window.showToast(msg, kind === 'error' ? { tone: 'error', icon: '⚠️' } : { icon: '✅' })
    : console.log(msg));
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
    // workspace.html lifts these off the URL (it clears the query string when it opens an assistant);
    // the URL is read too, for a page that keeps it.
    const lifted = window._mailboxConnectOutcome;
    window._mailboxConnectOutcome = null;
    const qp = new URLSearchParams(location.search);
    const ok = (lifted && lifted.connected) || qp.get('mailbox') === 'connected';
    const err = (lifted && lifted.error) || qp.get('mailbox_error');
    if (!ok && !err) return;
    if (ok) toast('Mailbox connected. Your Email Assistant is sorting the last 14 days now — it takes a minute or two.');
    else if (window.alertModal) window.alertModal(CONNECT_ERRORS[err] || 'Connecting the mailbox did not work. Please try again.', { title: 'Mailbox not connected' });
    qp.delete('mailbox'); qp.delete('mailbox_error');
    history.replaceState(null, '', `${location.pathname}${qp.toString() ? `?${qp}` : ''}${location.hash}`);
  }

  async function load() {
    // seen=1: this IS the Emails tab, so the "needs you now" notification has done its job (the Results cards don't send it).
    const res = await fetch(API + '?seen=1', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load your email.');
    state.data = data;
    if (!state.mailboxId && data.mailboxes && data.mailboxes[0]) state.mailboxId = data.mailboxes[0].id;
    if (state.mailboxId && !(data.mailboxes || []).some((m) => m.id === state.mailboxId)) state.mailboxId = data.mailboxes[0]?.id ?? null;
    state.actions = []; state.cleanup = [];
    if (state.mailboxId && (!data.access || data.access === 'owner')) {
      const r = await fetch(`${API}?mailboxId=${encodeURIComponent(state.mailboxId)}&actions=1`, { credentials: 'same-origin' });
      const a = await r.json().catch(() => ({}));
      if (r.ok) {
        state.actions = a.actions || []; state.cleanup = a.cleanup || [];
        state.undoDays = a.undoDays || 30; state.cleanupChunk = a.cleanupChunk || 25;
        state.archiveRules = a.archiveRules || []; state.labelsOn = Boolean(a.labelsOn);
        // A batch keeps the user's unticks across a refresh; new emails in it start ticked.
        for (const b of state.cleanup) {
          const prev = state.cleanupSel.get(b.key);
          state.cleanupSel.set(b.key, new Set(prev ? b.messageIds.filter((id) => prev.has(id) || !prev.seen?.has(id)) : b.messageIds));
          state.cleanupSel.get(b.key).seen = new Set(b.messageIds);
        }
      }
    }
  }

  const waitingReplyFor = (messageId) => state.actions.find((a) => a.kind === 'reply' && a.status === 'waiting' && a.messageId === messageId);
  const draftTextOf = (a) => (state.draftText.has(a.id) ? state.draftText.get(a.id) : (a.body || ''));
  const gapsIn = (text) => (String(text).match(GAP_RE) || []).map((g) => g.replace(/^\[check:\s*/i, '').replace(/\]$/, '').trim());

  function privacyNote() {
    return `<p class="text-xs text-gray-600 leading-relaxed">Only you can see this mailbox in Be More Swan — not your workspace's owner or admins.
      We keep each email's sender, subject, date and our one-line summary. We don't keep the text of your emails or any attachments:
      we fetch an email's text from your mailbox when you open it or when it's being sorted. Nothing is sent, moved or deleted unless you press the button for it; we add a "Swan" label showing each email's category, which you can turn off.</p>`;
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
    const drafts = state.actions.filter((a) => a.kind === 'reply' && a.status === 'waiting').length;
    const toClear = state.cleanup.reduce((n, b) => n + b.messageIds.length, 0);
    const done = state.actions.filter((a) => a.status !== 'waiting').length;
    return [
      { key: 'needs', label: 'Needs you', n: count((m) => m.priority === 'now' || m.priority === 'today'), waiting: true },
      { key: 'drafts', label: 'Drafts', n: drafts, waiting: true },
      ...(toClear ? [{ key: 'cleanup', label: 'Clean-up', n: toClear }] : []),
      { key: 'all', label: 'All', n: msgs.length },
      // Only categories that hold email: ten empty pills would bury the list, worst of all on a phone.
      ...cats.map((c) => ({ key: `cat:${c.key}`, label: c.label, n: count((m) => m.category === c.key) })).filter((p) => p.n > 0),
      ...(count((m) => m.sortedBy === 'pending') ? [{ key: 'pending', label: 'Being sorted', n: count((m) => m.sortedBy === 'pending') }] : []),
      ...(done ? [{ key: 'done', label: 'Done', n: done }] : []),
    ];
  }

  function filtered(msgs) {
    if (state.pill === 'needs') return msgs.filter((m) => m.priority === 'now' || m.priority === 'today')
      .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'now' ? -1 : 1));
    if (state.pill === 'pending') return msgs.filter((m) => m.sortedBy === 'pending');
    if (state.pill === 'drafts') return msgs.filter((m) => waitingReplyFor(m.id));
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
          ${m.fromAddress ? `<button type="button" class="tab-link" data-mbx-rule="${esc(m.fromAddress)}">Always archive from this sender…</button>` : ''}
          ${m.category === 'newsletters' ? `<button type="button" class="tab-link" data-mbx-unsub="${m.id}">Unsubscribe</button>` : ''}
        </div>
        ${replyHtml(m, prov)}
      </div>` : ''}
    </li>`;
  }

  /** The reply area under an opened email: a draft to edit, or the button that writes one. */
  function replyHtml(m, prov) {
    if (m.category === 'private') return '<p class="text-xs text-gray-500">This sender is private, so their email is never sent to AI — reply in your mail app.</p>';
    const a = waitingReplyFor(m.id);
    if (state.drafting.has(m.id)) return '<p class="text-sm text-gray-600">Writing a draft…</p>';
    if (!a) {
      return `<div class="flex flex-wrap items-center gap-2 pt-1">
        <label class="sr-only" for="mbx-note-${m.id}">What should the reply say?</label>
        <input id="mbx-note-${m.id}" data-mbx-note="${m.id}" type="text" placeholder="What should it say? (optional)" class="flex-1 min-w-0 text-sm border border-gray-200 rounded-lg px-3 py-1.5" style="min-width:12rem">
        <button type="button" class="btn-primary px-3 py-1.5 text-sm font-bold rounded-lg" data-mbx-draftnew="${m.id}">Draft a reply</button>
      </div>`;
    }
    const text = draftTextOf(a);
    const gaps = gapsIn(text);
    return `<div class="border border-gray-200 rounded-lg p-3 space-y-2 bg-white" data-mbx-editor="${a.id}">
      <p class="text-xs text-gray-600"><span class="font-semibold">To:</span> ${esc(a.to)} · <span class="font-semibold">Subject:</span> ${esc(a.subject)}</p>
      <label class="sr-only" for="mbx-draft-${a.id}">Your reply</label>
      <textarea id="mbx-draft-${a.id}" data-mbx-draft="${a.id}" rows="8" class="w-full text-sm border border-gray-200 rounded-lg p-2">${esc(text)}</textarea>
      ${gaps.length ? `<p class="text-xs text-amber-700" data-mbx-gaps="${a.id}">Fill in before sending: ${gaps.map(esc).join(' · ')}</p>` : `<p class="text-xs text-gray-500" data-mbx-gaps="${a.id}">Nothing is sent until you press Send.</p>`}
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn-primary px-3 py-1.5 text-sm font-bold rounded-lg disabled:opacity-40" data-mbx-send="${a.id}" data-mbx-msg="${m.id}" ${gaps.length ? 'disabled' : ''}>Send</button>
        <button type="button" class="btn-secondary border px-3 py-1.5 text-sm font-bold rounded-lg" data-mbx-savedraft="${a.id}" data-mbx-msg="${m.id}">Save to ${esc(prov)} drafts</button>
        <button type="button" class="tab-link" data-mbx-redraft="shorter" data-mbx-msg="${m.id}">Shorter</button>
        <button type="button" class="tab-link" data-mbx-redraft="longer" data-mbx-msg="${m.id}">Longer</button>
        <button type="button" class="tab-link" data-mbx-redraft="redraft" data-mbx-msg="${m.id}">Redraft</button>
        <button type="button" class="tab-link" style="color:#6b7280" data-mbx-dismiss="${a.id}">Throw away</button>
      </div>
    </div>`;
  }

  function cleanupHtml() {
    if (!state.cleanup.length) return '<p class="px-4 py-8 text-sm text-gray-600 text-center">Nothing to clear right now. 🎉</p>';
    const byId = new Map((state.data.messages || []).map((m) => [m.id, m]));
    return `<div class="p-4 space-y-3">${state.cleanup.map((b) => {
      const sel = state.cleanupSel.get(b.key) || new Set();
      const n = b.messageIds.filter((id) => sel.has(id)).length;
      const verb = b.op === 'trash' ? `Move ${n} to trash` : `Archive ${n}`;
      const open = state.cleanupOpen.has(b.key);
      return `<div class="border border-gray-200 rounded-lg p-3 bg-white">
        <div class="flex flex-wrap items-center gap-2">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-bold text-gray-900">${esc(b.label)}</p>
            <p class="text-xs text-gray-600">${b.messageIds.length} email${b.messageIds.length === 1 ? '' : 's'} · ${b.op === 'trash' ? 'moved to trash (your provider empties it later)' : 'archived (kept, out of your inbox)'} · you can undo for ${state.undoDays} days</p>
          </div>
          <button type="button" class="tab-link" data-mbx-cleanupopen="${esc(b.key)}" aria-expanded="${open}">${open ? 'Hide emails' : 'Show emails'}</button>
          <button type="button" class="${b.op === 'trash' ? 'btn-secondary border' : 'btn-primary'} px-3 py-1.5 text-sm font-bold rounded-lg disabled:opacity-40" data-mbx-cleanup="${esc(b.key)}" ${n ? '' : 'disabled'}>${verb}</button>
        </div>
        ${open ? `<ul class="mt-2 max-h-64 overflow-y-auto divide-y divide-gray-100">${b.messageIds.map((id) => {
          const m = byId.get(id);
          return `<li class="py-1.5"><label class="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
            <input type="checkbox" class="mt-0.5" data-mbx-cleanuptick="${esc(b.key)}" value="${id}" ${sel.has(id) ? 'checked' : ''}>
            <span class="min-w-0"><span class="font-semibold">${esc(m ? (m.fromName || m.fromAddress || '') : '')}</span> — ${esc(m ? (m.subject || '(no subject)') : 'an email')}</span>
          </label></li>`;
        }).join('')}</ul>` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  function doneHtml() {
    const done = state.actions.filter((a) => a.status !== 'waiting');
    if (!done.length) return '<p class="px-4 py-8 text-sm text-gray-600 text-center">Nothing done yet.</p>';
    const undoUntil = Date.now() - state.undoDays * 86400000;
    return `<ul class="mt-2">${done.map((a) => {
      let text = '';
      if (a.kind === 'reply') {
        text = a.status === 'sent' ? `Replied to ${esc(a.to)} — ${esc(a.subject)}`
          : a.status === 'drafted' ? `Saved a reply to ${esc(a.to)} in your drafts — ${esc(a.subject)}`
          : a.status === 'dismissed' ? `Threw away a draft to ${esc(a.to)}` : `Reply to ${esc(a.to)}: ${esc((a.result && a.result.error) || a.status)}`;
      } else {
        const verb = a.op === 'trash' ? 'moved to trash' : 'archived';
        text = a.status === 'undone' ? `${esc(a.label)}: put back in your inbox`
          : a.status === 'failed' ? `${esc(a.label)}: nothing could be ${verb}`
          : `${esc(a.label)}: ${a.count} ${verb}${a.failed ? ` (${a.failed} could not be)` : ''}`;
      }
      const canUndo = a.kind === 'cleanup' && a.status === 'applied' && a.actedAt && new Date(a.actedAt).getTime() > undoUntil;
      return `<li class="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-gray-100 last:border-0 text-sm text-gray-800">
        <span class="min-w-0 flex-1">${text}</span>
        <span class="text-xs text-gray-500">${esc(when(a.actedAt || a.updatedAt))}</span>
        ${canUndo ? `<button type="button" class="tab-link" data-mbx-undo="${a.id}">Undo</button>` : ''}
      </li>`;
    }).join('')}</ul>`;
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
      : state.pill === 'drafts' ? 'No drafts. Open an email and press "Draft a reply".'
      : msgs.length ? 'No emails here.' : 'No emails yet — your first sort is on its way.';
    const content = state.pill === 'cleanup' ? cleanupHtml()
      : state.pill === 'done' ? doneHtml()
      : list.length ? `<ul class="mt-2">${list.map(rowHtml).join('')}</ul>` : `<p class="px-4 py-8 text-sm text-gray-600 text-center">${empty}</p>`;
    host().innerHTML = `
      <div class="tab-card">
        <div class="tab-pillbar">
          <div class="stage-pills" role="tablist" aria-label="Email categories">
            ${pills.map((p) => `<button type="button" role="tab" aria-selected="${p.key === state.pill}" data-mbx-pill="${esc(p.key)}">${esc(p.label)}${window._tabPillCount ? window._tabPillCount(p.n, !!p.waiting) : ` (${p.n})`}</button>`).join('')}
          </div>
          <div class="tab-pillbar-actions">
            <button type="button" class="tab-link" data-mbx-labels aria-pressed="${state.labelsOn}">Labels in ${esc(providerName(box.provider))}: ${state.labelsOn ? 'on' : 'off'}</button>
            <button type="button" class="tab-link" data-mbx-rules>Rules (${state.archiveRules.length})</button>
            <button type="button" class="tab-link" data-mbx-disconnect>Disconnect</button>
          </div>
        </div>
        <p class="tab-help">${esc(lastRead)} Nothing in your ${esc(providerName(box.provider))} mailbox is sent, moved or deleted unless you press the button for it (or set a rule)${state.labelsOn ? `; each email gets a "Swan" ${box.provider === 'gmail' ? 'label' : 'category'} showing where it was sorted` : ''}.</p>
        ${problem}
        ${content}
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
    // Kept in this page's memory only, for this visit.
    await loadBody(id);
  }

  async function loadBody(id) {
    if (state.bodies.has(id)) return;
    try {
      const res = await fetch(`${API}?mailboxId=${encodeURIComponent(state.mailboxId)}&messageId=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      state.bodies.set(id, res.ok ? (data.text || '(This email has no text.)') : (data.error || 'Could not fetch this email.'));
    } catch { state.bodies.set(id, 'Could not fetch this email.'); }
    render();
  }

  /** Ask the assistant for a draft (new, or Shorter / Longer / Redraft of the current one). Changes nothing in the mailbox. */
  async function draft(messageId, mode) {
    const noteEl = host().querySelector(`[data-mbx-note="${messageId}"]`);
    const note = noteEl ? noteEl.value.trim() : '';
    const current = waitingReplyFor(messageId);
    // A redraft starts from what is in the editor now, not what was last saved.
    if (current && state.draftText.has(current.id)) {
      await post({ action: 'edit_reply', mailboxId: state.mailboxId, actionId: current.id, body: state.draftText.get(current.id) }).catch(() => undefined);
    }
    state.drafting.add(messageId); render();
    try {
      const out = await post({ action: 'draft_reply', mailboxId: state.mailboxId, messageId, mode, ...(note ? { note } : {}) });
      state.draftText.delete(out.actionId);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
    finally { state.drafting.delete(messageId); render(); }
  }

  /** Send (or save to the mailbox's drafts) exactly the text on screen, after the owner confirms. */
  async function sendDraft(actionId, how) {
    const a = state.actions.find((x) => x.id === actionId);
    if (!a) return;
    const text = draftTextOf(a);
    const box = (state.data.mailboxes || []).find((m) => m.id === state.mailboxId);
    const prov = providerName(box && box.provider);
    if (how === 'send') {
      if (gapsIn(text).length) { toast('Fill in the parts marked [check: …] first.', 'error'); return; }
      const ok = window.confirmModal
        ? await window.confirmModal(`Send this reply to ${a.to}? It goes from your ${prov} mailbox, in the same conversation.`, { title: 'Send reply', confirmLabel: 'Send', tone: 'primary' })
        : window.confirm(`Send this reply to ${a.to}?`);
      if (!ok) return;
    }
    state.busy = true;
    try {
      const out = await post({ action: 'send_reply', mailboxId: state.mailboxId, actionId, body: text, how });
      state.draftText.delete(actionId);
      toast(out.message);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
    finally { state.busy = false; }
  }

  /** Undo a whole clean-up: the server puts back a chunk per call, so call until none remain (or one call puts none back). */
  async function undoAll(actionId) {
    let restored = 0; let failed = 0;
    for (let guard = 0; guard < 50; guard++) {
      const out = await post({ action: 'undo_cleanup', mailboxId: state.mailboxId, actionId });
      restored += out.restored || 0; failed = out.failed || 0;
      if (!out.remaining || !out.restored) break;
    }
    return `Put back in your inbox: ${restored}.${failed ? ` ${failed} could not be put back — try Undo again.` : ''}`;
  }

  /** Archive or trash the ticked emails of one batch, after a confirm, in chunks the server accepts. */
  async function runCleanup(key) {
    const b = state.cleanup.find((x) => x.key === key);
    if (!b) return;
    const sel = state.cleanupSel.get(key) || new Set();
    const ids = b.messageIds.filter((id) => sel.has(id));
    if (!ids.length) return;
    const box = (state.data.mailboxes || []).find((m) => m.id === state.mailboxId);
    const prov = providerName(box && box.provider);
    const nEmails = `${ids.length} email${ids.length === 1 ? '' : 's'}`;
    const what = b.op === 'trash' ? `Move ${nEmails} to trash in ${prov}?` : `Archive ${nEmails} in ${prov}?`;
    const ok = window.confirmModal
      ? await window.confirmModal(`${what} ${b.op === 'trash' ? 'Your provider empties its trash later.' : 'They stay in your mailbox, out of the inbox.'} You can undo this for ${state.undoDays} days from the Done list.`,
          { title: b.op === 'trash' ? 'Move to trash' : 'Archive', confirmLabel: b.op === 'trash' ? 'Move to trash' : 'Archive', tone: b.op === 'trash' ? 'destructive' : 'primary' })
      : window.confirm(what);
    if (!ok) return;
    state.busy = true;
    let moved = 0; let failed = 0; let joinActionId = null;
    try {
      // One batch = one entry in Done: every chunk after the first joins the first chunk's entry.
      for (let i = 0; i < ids.length; i += state.cleanupChunk) {
        const out = await post({ action: 'cleanup', mailboxId: state.mailboxId, op: b.op, label: b.label, messageIds: ids.slice(i, i + state.cleanupChunk), ...(joinActionId ? { joinActionId } : {}) });
        moved += out.moved || 0; failed += out.failed || 0;
        if (!joinActionId && out.actionId) joinActionId = out.actionId;
      }
      toast(`${b.op === 'trash' ? 'Moved to trash' : 'Archived'}: ${moved}.${failed ? ` ${failed} could not be moved.` : ''} Undo from the Done list.`, failed ? 'error' : 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { state.busy = false; state.cleanupSel.delete(key); await refresh(); }
  }

  /** Save an archive rule for a sender, after the owner chooses the days (rules archive, never delete). */
  async function addRule(address) {
    const domain = address.includes('@') ? `@${address.split('@').pop()}` : address;
    const msg = `Archive email from ${address} (or type ${domain} for everyone at that domain) once it's this many days old. It's moved out of your inbox, never deleted, and anything that needs you stays. Each run can be undone from Done.`;
    const answer = window.promptModal ? await window.promptModal(msg, { title: 'Archive rule', placeholder: '7', inputLabel: 'Days (0 = as it arrives)', confirmLabel: 'Save rule' }) : window.prompt(msg, '7');
    if (answer == null || String(answer).trim() === '') return;
    let match = address; let days = String(answer).trim();
    const m = days.match(/^(@[^\s]+|[^\s@]+@[^\s]+)\s+(\d+)$/); // "@stripe.com 7" also accepted
    if (m) { match = m[1]; days = m[2]; }
    if (!/^\d+$/.test(days)) { toast('Enter a number of days, like 7.', 'error'); return; }
    try { const out = await post({ action: 'add_rule', mailboxId: state.mailboxId, match, afterDays: Number(days) }); toast(out.message); await refresh(); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function manageRules() {
    const list = state.archiveRules.map((r) => `${r.match} — after ${r.afterDays} day${r.afterDays === 1 ? '' : 's'}`);
    const msg = `${list.length ? `Your archive rules:\n${list.join('\n')}\n\nTo remove one, type its sender (like @stripe.com).` : 'No rules yet. Open an email and press "Always archive from this sender…".'}`;
    if (!list.length) { if (window.alertModal) await window.alertModal(msg, { title: 'Archive rules' }); return; }
    const answer = window.promptModal ? await window.promptModal(msg, { title: 'Archive rules', placeholder: '@stripe.com', confirmLabel: 'Remove rule' }) : window.prompt(msg);
    if (!answer) return;
    try { const out = await post({ action: 'remove_rule', mailboxId: state.mailboxId, match: String(answer).trim() }); toast(out.message); await refresh(); }
    catch (err) { toast(err.message, 'error'); }
  }

  /** One-click unsubscribe after a confirm; without one-click, the sender's own link to open. */
  async function unsubscribe(messageId) {
    const ok = window.confirmModal
      ? await window.confirmModal('Unsubscribe from this sender? This tells them to stop sending — it can\'t be undone from here.', { title: 'Unsubscribe', confirmLabel: 'Unsubscribe', tone: 'primary' })
      : window.confirm('Unsubscribe from this sender?');
    if (!ok) return;
    try {
      const res = await fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unsubscribe', mailboxId: state.mailboxId, messageId }) });
      const out = await res.json().catch(() => ({}));
      if (out.manual) {
        const link = out.webUrl && /^https:\/\//i.test(out.webUrl) ? out.webUrl : out.mailto && /^mailto:/i.test(out.mailto) ? out.mailto : null;
        if (link && window.confirmModal && await window.confirmModal(`${out.message}`, { title: 'Unsubscribe', confirmLabel: 'Open their link', tone: 'primary' })) window.open(link, '_blank', 'noopener');
        else if (!link) toast(out.message, 'error');
        return;
      }
      if (!res.ok) throw new Error(out.error || 'That didn\'t work.');
      toast(out.message);
    } catch (err) { toast(err.message, 'error'); }
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
      const t = e.target.closest('[data-mbx-pill],[data-mbx-open],[data-mbx-private],[data-mbx-disconnect],[data-mbx-refresh],[data-mbx-privlist],[data-mbx-draftnew],[data-mbx-redraft],[data-mbx-send],[data-mbx-savedraft],[data-mbx-dismiss],[data-mbx-cleanup],[data-mbx-cleanupopen],[data-mbx-undo],[data-mbx-rule],[data-mbx-rules],[data-mbx-labels],[data-mbx-unsub]');
      if (!t || state.busy) return;
      if (t.dataset.mbxPill) {
        state.pill = t.dataset.mbxPill;
        // In Drafts, every draft is open and editable straight away.
        if (state.pill === 'drafts') state.actions.filter((a) => a.kind === 'reply' && a.status === 'waiting' && a.messageId).forEach((a) => { state.open.add(a.messageId); loadBody(a.messageId); });
        render(); return;
      }
      if (t.dataset.mbxDraftnew || t.dataset.mbxRedraft) { await draft(Number(t.dataset.mbxDraftnew || t.dataset.mbxMsg), t.dataset.mbxRedraft || 'new'); return; }
      if (t.dataset.mbxSend || t.dataset.mbxSavedraft) { await sendDraft(Number(t.dataset.mbxSend || t.dataset.mbxSavedraft), t.dataset.mbxSend ? 'send' : 'drafts'); return; }
      if (t.dataset.mbxDismiss) {
        try { const out = await post({ action: 'dismiss_reply', mailboxId: state.mailboxId, actionId: Number(t.dataset.mbxDismiss) }); state.draftText.delete(Number(t.dataset.mbxDismiss)); toast(out.message); await refresh(); }
        catch (err) { toast(err.message, 'error'); }
        return;
      }
      if (t.dataset.mbxRule) { await addRule(t.dataset.mbxRule); return; }
      if (t.hasAttribute('data-mbx-rules')) { await manageRules(); return; }
      if (t.hasAttribute('data-mbx-labels')) {
        const box = (state.data.mailboxes || []).find((m) => m.id === state.mailboxId);
        const turnOn = !state.labelsOn;
        const prov = providerName(box && box.provider);
        const ok = window.confirmModal
          ? await window.confirmModal(turnOn
            ? `Show each email's category in ${prov} too? New emails get a "Swan" ${box && box.provider === 'gmail' ? 'label' : 'category'} (like "Swan/Needs a reply"). Nothing is moved or deleted.`
            : `Stop writing categories into ${prov}? Labels already there stay until you remove them.`, { title: 'Labels', confirmLabel: turnOn ? 'Turn on' : 'Turn off', tone: 'primary' })
          : true;
        if (!ok) return;
        try { const out = await post({ action: 'set_labels', mailboxId: state.mailboxId, on: turnOn }); toast(out.message); await refresh(); }
        catch (err) { toast(err.message, 'error'); }
        return;
      }
      if (t.dataset.mbxUnsub) { await unsubscribe(Number(t.dataset.mbxUnsub)); return; }
      if (t.dataset.mbxCleanupopen) { const k = t.dataset.mbxCleanupopen; state.cleanupOpen.has(k) ? state.cleanupOpen.delete(k) : state.cleanupOpen.add(k); render(); return; }
      if (t.dataset.mbxCleanup) { await runCleanup(t.dataset.mbxCleanup); return; }
      if (t.dataset.mbxUndo) {
        state.busy = true;
        try { toast(await undoAll(Number(t.dataset.mbxUndo))); await refresh(); }
        catch (err) { toast(err.message, 'error'); }
        finally { state.busy = false; }
        return;
      }
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
    // The draft editor: keep the text as typed; save it when the box loses focus.
    root.addEventListener('input', (e) => {
      const ta = e.target.closest('[data-mbx-draft]');
      if (!ta) return;
      const id = Number(ta.dataset.mbxDraft);
      state.draftText.set(id, ta.value);
      const gaps = gapsIn(ta.value);
      const send = root.querySelector(`[data-mbx-send="${id}"]`);
      if (send) send.disabled = gaps.length > 0;
      const note = root.querySelector(`[data-mbx-gaps="${id}"]`);
      if (note) {
        note.className = gaps.length ? 'text-xs text-amber-700' : 'text-xs text-gray-500';
        note.textContent = gaps.length ? `Fill in before sending: ${gaps.join(' · ')}` : 'Nothing is sent until you press Send.';
      }
    });
    root.addEventListener('focusout', (e) => {
      const ta = e.target.closest('[data-mbx-draft]');
      if (!ta) return;
      post({ action: 'edit_reply', mailboxId: state.mailboxId, actionId: Number(ta.dataset.mbxDraft), body: ta.value }).catch(() => { /* kept on screen; saved with Send */ });
    });
    root.addEventListener('change', async (e) => {
      const tick = e.target.closest('[data-mbx-cleanuptick]');
      if (tick) {
        const set = state.cleanupSel.get(tick.dataset.mbxCleanuptick) || new Set();
        tick.checked ? set.add(Number(tick.value)) : set.delete(Number(tick.value));
        state.cleanupSel.set(tick.dataset.mbxCleanuptick, set);
        render(); return;
      }
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
    state.draftText.clear(); state.cleanupSel.clear(); state.cleanupOpen.clear(); state.drafting.clear();
    if (host()) host().innerHTML = '<p class="text-sm text-gray-500">Loading…</p>';
    bind();
    showConnectOutcome();
    await refresh();
  }

  window.AssistantMailbox = { init, refresh, _test: { pillDefs, filtered, esc, gapsIn } };
})();
