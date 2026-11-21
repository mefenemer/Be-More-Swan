/**
 * src/components/assistant-messages.js
 * Messages tab — the Social Media assistant's Facebook Page + Instagram messages (registry `messagesTab`).
 * docs/meta-messages-plan.md, Phase 2.
 *
 * Private messages people sent to the business's Facebook Page or Instagram account, delivered by
 * Meta's webhook (meta-webhook.ts). On each conversation the assistant drafts a reply in the brand's
 * voice ("Draft a reply"); the person edits it and presses "Send", which sends it AS the Page /
 * Instagram account. Nothing is sent without that click. Meta only allows a reply within 24 hours
 * of the person's last message — the card counts it down, and the server checks it again right
 * before sending.
 *
 * Backed by netlify/functions/social-messages.ts — the same endpoint the chat's
 * message_action_proposal card calls (chat-session.js onMessageAction), which dispatches
 * `messages:changed` on `document` so this tab reloads behind the chat.
 *
 * Vanilla IIFE assigning window.AssistantMessages. Handlers are bound ONCE to `document` and scoped to
 * the host, never from render(). All server values are escaped: messages are strangers' words.
 */
(function () {
  const API = '/.netlify/functions/social-messages';

  const state = {
    assistantId: null,
    assistantName: '',
    conversations: [],
    counts: { new: 0, replied: 0, dismissed: 0 },
    connection: { enabled: false, connected: false, receiving: false, needsReconnect: false },
    // Owners and admins may delete a conversation (an erasure request); the server enforces it too.
    canDelete: false,
    filter: 'new',
    loaded: false,
    notSetUp: false,
    error: null,
    // id → the text in its reply box, while it differs from what is saved.
    edits: {},
    // id of the control waiting on the server.
    busy: null,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const host = () => document.getElementById('messages-host');
  const toastOk = (m) => window.showToast?.(m, { icon: '✅' });
  const toastErr = (m) => window.showToast?.(m, { icon: '⚠️' });
  const PLATFORM = { facebook: 'Facebook', instagram: 'Instagram' };
  // Ask before anything that reaches a person or erases data. If dialogs.js didn't load, fall back to
  // the browser's own confirm (plain text) — never act without asking.
  async function ask(html, opts) {
    if (typeof window.confirmModal === 'function') return (await window.confirmModal(html, opts)) === true;
    const plain = String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    return window.confirm(`${opts && opts.title ? `${opts.title}\n\n` : ''}${plain}`);
  }

  async function call(action, extra) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action, assistantId: state.assistantId, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `That didn’t work (HTTP ${res.status}).`), { code: data.code });
    return data;
  }

  function applyList(data) {
    state.conversations = Array.isArray(data.conversations) ? data.conversations : [];
    state.counts = data.counts || state.counts;
    state.connection = data.connection || state.connection;
    state.canDelete = data.canDelete === true;
  }

  async function load() {
    if (!state.assistantId) return;
    try {
      applyList(await call('list'));
      state.notSetUp = false;
      state.error = null;
    } catch (err) {
      state.notSetUp = err.code === 'not_set_up';
      state.error = state.notSetUp ? null : err.message;
    } finally {
      state.loaded = true;
    }
    // Not set up on this database, or switched off here with nothing ever arrived: no tab at all
    // (prod until Meta approves messaging). A plain load error keeps the tab, so the error shows.
    const btn = document.getElementById('maintab-btn-messages');
    if (btn && !state.error) {
      const any = (state.counts.new || 0) + (state.counts.replied || 0) + (state.counts.dismissed || 0) > 0;
      btn.classList.toggle('hidden', state.notSetUp || (!state.connection.enabled && !any));
    }
    setBadge();
    render();
  }

  function setBadge() {
    const b = document.getElementById('messages-badge');
    if (!b) return;
    const n = state.counts.new || 0;
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('hidden', !n);
    b.style.display = n ? '' : 'none';
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function when(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  /** "5h 12m left" — from the clock the server sent, refreshed on every render. */
  function timeLeft(iso) {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return null;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return { label: h ? `${h}h ${m}m left to reply` : `${m}m left to reply`, urgent: ms < 4 * 3600000 };
  }

  function headerHtml() {
    return `
      <section class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
        <h3 class="text-base font-bold text-gray-900">Messages from Facebook and Instagram</h3>
        <p class="text-sm text-gray-600 mt-1">Private messages people send your Facebook Page and Instagram account arrive here. ${esc(state.assistantName || 'Your assistant')} drafts a reply in your brand’s voice — you edit it and press “Send”. Nothing is sent until you do. Meta only lets you reply within 24 hours of their last message.</p>
      </section>`;
  }

  function connectionHtml() {
    const c = state.connection;
    if (!c.enabled) return '';
    if (!c.connected) {
      return `<div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <span class="font-bold">Connect your Facebook Page or Instagram account to get messages here.</span> You can do it in Connections.</div>`;
    }
    if (c.needsReconnect) {
      return `<div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <span class="font-bold">Reconnect Facebook to see your messages here.</span> In Connections, reconnect Facebook (and Instagram) and leave the messaging permissions ticked.</div>`;
    }
    return '';
  }

  function chipsHtml() {
    const chip = (key, label) => `
      <button type="button" data-msg-filter="${key}" aria-pressed="${state.filter === key}" class="px-3 py-1.5 text-xs font-bold rounded-full border transition ${state.filter === key ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-300'}">${label} (${esc(state.counts[key] || 0)})</button>`;
    return `<div class="flex flex-wrap gap-2" role="group" aria-label="Show conversations">${chip('new', 'Waiting')}${chip('replied', 'Replied')}${chip('dismissed', 'Dismissed')}</div>`;
  }

  function bubbleHtml(m) {
    const mine = m.direction === 'out';
    const bodyHtml = m.body
      ? `<p class="whitespace-pre-wrap break-words">${esc(m.body)}</p>`
      : `<p class="italic">${m.attachmentType ? `Sent a${/^[aeiou]/i.test(m.attachmentType) ? 'n' : ''} ${esc(m.attachmentType)}` : 'Message no longer available'}</p>`;
    return `
      <div class="flex ${mine ? 'justify-end' : 'justify-start'}">
        <div class="max-w-[85%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-emerald-50 border border-emerald-100 text-gray-900' : 'bg-gray-100 text-gray-900'}">
          ${bodyHtml}
          <p class="text-[11px] text-gray-500 mt-1">${mine ? (m.sentHere ? 'Sent from here' : 'You replied in the app') : 'Them'}${m.sentAt ? ` · ${esc(when(m.sentAt))}` : ''}</p>
        </div>
      </div>`;
  }

  function cardHtml(c) {
    const text = state.edits[c.id] !== undefined ? state.edits[c.id] : (c.draftReply || '');
    const dirty = state.edits[c.id] !== undefined && state.edits[c.id] !== (c.draftReply || '');
    const busy = state.busy === c.id;
    const left = c.windowOpen ? timeLeft(c.windowClosesAt) : null;
    const max = c.maxReplyChars || 1000;
    const over = text.length > max;
    const pill = left
      ? `<span class="px-2 py-0.5 rounded-full font-bold ${left.urgent ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-800'}">${esc(left.label)}</span>`
      : '<span class="px-2 py-0.5 rounded-full font-bold bg-gray-100 text-gray-600">Reply window closed</span>';
    let actions;
    if (c.status === 'dismissed') {
      actions = `
        <div class="flex flex-wrap items-center gap-2 mt-3">
          <button type="button" data-msg-status="${c.id}" data-status="new" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Put back in Waiting</button>
        </div>`;
    } else if (!left) {
      actions = `<p class="text-xs text-gray-600 mt-3">Meta only lets you reply within 24 hours of their last message, so this can only be answered in the ${esc(PLATFORM[c.platform] || 'Facebook')} app now. If they write again, you can reply here.</p>
        ${c.status === 'new' ? `<div class="flex flex-wrap items-center gap-2 mt-2"><button type="button" data-msg-status="${c.id}" data-status="dismissed" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Dismiss</button></div>` : ''}`;
    } else {
      const hasDraft = !!text.trim();
      actions = `
        <label class="block text-xs font-bold text-gray-700 mt-3" for="msg-reply-${c.id}">Your reply</label>
        <textarea id="msg-reply-${c.id}" data-msg-reply="${c.id}" rows="3" class="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="Press “Draft a reply”, or write your own.">${esc(text)}</textarea>
        <p class="text-xs mt-1 ${over ? 'text-red-600' : 'text-gray-500'}" data-msg-counter>${esc(text.length)} / ${esc(max)} characters${over ? ` — ${esc(PLATFORM[c.platform])} won’t take a reply this long.` : ''}</p>
        ${dirty ? `<button type="button" data-msg-save-draft="${c.id}" class="btn-secondary border px-3 py-1.5 mt-1 text-xs font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Save my changes</button>` : ''}
        <div class="flex flex-wrap items-center gap-2 mt-3">
          <button type="button" data-msg-send="${c.id}" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy || !hasDraft || over ? 'disabled' : ''}>Send</button>
          <button type="button" data-msg-draft="${c.id}" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>${c.draftReply ? 'Redraft' : 'Draft a reply'}</button>
          ${c.status === 'new' ? `<button type="button" data-msg-status="${c.id}" data-status="dismissed" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Dismiss</button>` : ''}
        </div>`;
    }
    return `
      <article class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm" data-msg-card="${c.id}">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="px-2 py-0.5 rounded-full bg-gray-100 text-gray-800 font-bold">${esc(PLATFORM[c.platform] || 'Facebook')}</span>
          <span class="font-bold text-gray-900">${esc(c.personLabel)}</span>
          ${pill}
        </div>
        <div class="mt-3 space-y-2">${(c.messages || []).map(bubbleHtml).join('') || '<p class="text-sm text-gray-500">No messages to show.</p>'}</div>
        ${actions}
        ${state.canDelete ? `<div class="mt-3 pt-3 border-t border-gray-100 flex justify-end">
          <button type="button" data-msg-delete="${c.id}" class="text-xs font-bold text-red-700 underline disabled:opacity-50" ${busy ? 'disabled' : ''}>Delete conversation</button>
        </div>` : ''}
      </article>`;
  }

  function render() {
    const el = host();
    if (!el) return;
    if (!state.loaded) { el.innerHTML = '<p class="text-sm text-gray-600 p-4">Loading messages…</p>'; return; }
    if (state.notSetUp) {
      el.innerHTML = '<div class="bg-white border border-gray-200 rounded-xl p-6 text-sm text-gray-700">Messages aren’t set up on this server yet.</div>';
      return;
    }
    const list = state.conversations.filter((c) => c.status === state.filter);
    const empty = state.filter === 'new'
      ? (state.connection.receiving ? 'Nobody is waiting for a reply. New messages to your Facebook Page and Instagram account appear here.' : 'No messages yet.')
      : state.filter === 'replied' ? 'Conversations you’ve answered are kept here.' : 'Conversations you dismiss are kept here, in case you change your mind.';
    const focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
    const caret = focused && document.activeElement.selectionStart;
    el.innerHTML = `
      <div class="space-y-4">
        ${state.error ? `<p class="text-sm text-red-600" role="alert">${esc(state.error)}</p>` : ''}
        ${headerHtml()}
        ${connectionHtml()}
        ${chipsHtml()}
        ${list.length ? list.map(cardHtml).join('') : `<p class="text-sm text-gray-600 bg-white border border-gray-200 rounded-xl p-6">${esc(empty)}</p>`}
      </div>`;
    if (focused) {
      const f = document.getElementById(focused);
      if (f) { f.focus(); if (typeof caret === 'number' && f.setSelectionRange) try { f.setSelectionRange(caret, caret); } catch { /* not a text field */ } }
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  function find(id) { return state.conversations.find((c) => c.id === id) || null; }

  function replace(c) {
    const i = state.conversations.findIndex((x) => x.id === c.id);
    const before = i >= 0 ? state.conversations[i] : null;
    if (i >= 0) state.conversations[i] = c; else state.conversations.unshift(c);
    if (before && before.status !== c.status) {
      state.counts[before.status] = Math.max(0, (state.counts[before.status] || 0) - 1);
      state.counts[c.status] = (state.counts[c.status] || 0) + 1;
      setBadge();
    }
  }

  async function withBusy(key, fn) {
    state.busy = key;
    render();
    try { await fn(); } catch (err) { toastErr(err.message); if (err.code === 'window_closed') load(); } finally { state.busy = null; render(); }
  }

  async function draft(id) {
    const c = find(id);
    let instruction;
    if (c && c.draftReply) {
      instruction = await window.promptModal?.('What should change? Leave it blank to just improve it.', {
        title: 'Redraft this reply', confirmLabel: 'Redraft', multiline: true, placeholder: 'e.g. shorter, and offer a call',
      });
      if (instruction === null || instruction === undefined) return;
    }
    await withBusy(id, async () => {
      const r = await call('draft', { id, instruction: instruction && instruction.trim() ? instruction.trim() : undefined });
      delete state.edits[id];
      replace(r.conversation);
    });
  }

  async function saveDraft(id) {
    const text = state.edits[id];
    if (text === undefined) return;
    await withBusy(id, async () => {
      const r = await call('save_draft', { id, draft: text });
      delete state.edits[id];
      replace(r.conversation);
      toastOk('Saved.');
    });
  }

  async function send(id) {
    const c = find(id);
    if (!c) return;
    const text = (state.edits[id] !== undefined ? state.edits[id] : (c.draftReply || '')).trim();
    if (!text) return;
    const where = PLATFORM[c.platform] || 'Facebook';
    // ⚠️ confirmModal renders its message as HTML (dialogs.js): the name comes from Meta and is a
    // stranger's choice, so everything interpolated here is escaped.
    const ok = await ask(`This sends your reply to ${esc(c.personLabel)} as a private ${esc(where)} message from your business.<br><br>“${esc(text).replace(/\n/g, '<br>')}”`, {
      title: `Send this on ${where}?`, confirmLabel: 'Send', tone: 'primary',
    });
    if (!ok) return;
    await withBusy(id, async () => {
      const r = await call('send', { id, text });
      delete state.edits[id];
      replace(r.conversation);
      toastOk(`Sent on ${where}.`);
    });
  }

  // For when the person asks the business to erase what they sent (a GDPR request): our copy goes,
  // Meta keeps its own. Owners and admins only — the server refuses anyone else.
  async function remove(id) {
    const c = find(id);
    if (!c) return;
    const where = PLATFORM[c.platform] || 'Facebook';
    const ok = await ask(`This deletes this conversation with ${esc(c.personLabel)} and every message in it from Be More Swan, for good. It stays in ${esc(where)} — delete it there too if they asked.<br><br>Use this when someone asks you to erase what they sent you.`, {
      title: 'Delete this conversation?', confirmLabel: 'Delete', tone: 'destructive',
    });
    if (!ok) return;
    await withBusy(id, async () => {
      await call('delete', { id });
      const i = state.conversations.findIndex((x) => x.id === id);
      if (i >= 0) {
        const st = state.conversations[i].status;
        state.conversations.splice(i, 1);
        state.counts[st] = Math.max(0, (state.counts[st] || 0) - 1);
        setBadge();
      }
      delete state.edits[id];
      toastOk('Conversation deleted.');
    });
  }

  async function setStatus(id, status) {
    await withBusy(id, async () => {
      const r = await call('set_status', { id, status });
      delete state.edits[id];
      replace(r.conversation);
    });
  }

  document.addEventListener('click', (e) => {
    const el = host();
    if (!el || !el.contains(e.target)) return;
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.msgFilter) { state.filter = b.dataset.msgFilter; render(); return; }
    if (b.dataset.msgDraft) { draft(Number(b.dataset.msgDraft)); return; }
    if (b.dataset.msgSaveDraft) { saveDraft(Number(b.dataset.msgSaveDraft)); return; }
    if (b.dataset.msgSend) { send(Number(b.dataset.msgSend)); return; }
    if (b.dataset.msgDelete) { remove(Number(b.dataset.msgDelete)); return; }
    if (b.dataset.msgStatus) { setStatus(Number(b.dataset.msgStatus), b.dataset.status); }
  });

  document.addEventListener('input', (e) => {
    const el = host();
    if (!el || !el.contains(e.target) || !e.target.dataset.msgReply) return;
    const id = Number(e.target.dataset.msgReply);
    const c = find(id);
    const max = c?.maxReplyChars || 1000;
    const prev = state.edits[id] !== undefined ? state.edits[id] : (c?.draftReply || '');
    state.edits[id] = e.target.value;
    // Re-render only when a button or the length warning has to change; the counter is patched in place.
    const flips = (v) => [!!v.trim(), v !== (c?.draftReply || ''), v.length > max].join();
    if (flips(prev) !== flips(e.target.value)) { render(); return; }
    const counter = e.target.parentElement?.querySelector('[data-msg-counter]');
    if (counter) counter.textContent = `${e.target.value.length} / ${max} characters`;
  });

  // A message card in the chat changed something — reload behind it.
  document.addEventListener('messages:changed', (e) => {
    if (!state.assistantId || (e.detail && e.detail.assistantId && Number(e.detail.assistantId) !== Number(state.assistantId))) return;
    load();
  });

  window.AssistantMessages = {
    /** Loads eagerly — the tab badge is the count of conversations waiting. Paints on activate(). */
    init({ assistantId, assistantName }) {
      state.assistantName = assistantName || '';
      if (state.assistantId !== assistantId) {
        Object.assign(state, {
          assistantId, conversations: [], counts: { new: 0, replied: 0, dismissed: 0 },
          connection: { enabled: false, connected: false, receiving: false, needsReconnect: false },
          filter: 'new', loaded: false, notSetUp: false, error: null, edits: {}, busy: null,
        });
      }
      load();
    },
    rename(name) { state.assistantName = name || state.assistantName; render(); },
    activate() {
      render();
      if (state.loaded) load();
    },
    reload: load,
  };
})();
