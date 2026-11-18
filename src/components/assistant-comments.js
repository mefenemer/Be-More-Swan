/**
 * src/components/assistant-comments.js
 * Comments tab — the Social Media assistant's LinkedIn Company Page comments (registry `commentsTab`).
 *
 * Comments people left on the posts this assistant published to a LinkedIn Company Page, fetched
 * every 6 hours (ingest-linkedin-insights.ts) or now with "Check for new comments". On each one the
 * assistant drafts a reply in the brand's voice ("Draft a reply"); the person edits it and presses
 * "Post reply", which posts it AS the Page under the post. Nothing posts without that click.
 *
 * Backed by netlify/functions/page-comments.ts — the same endpoint the chat's comment_action_proposal
 * card calls (chat-session.js onCommentAction), which dispatches `comments:changed` on `document` so
 * this tab reloads behind the chat.
 *
 * Vanilla IIFE assigning window.AssistantComments. Handlers are bound ONCE to `document` and scoped to
 * the host, never from render(). All server values are escaped: comments are strangers' words.
 */
(function () {
  const API = '/.netlify/functions/page-comments';

  const state = {
    assistantId: null,
    assistantName: '',
    comments: [],
    counts: { new: 0, replied: 0, dismissed: 0 },
    hasPageConnection: false,
    maxReplyChars: 1250,
    filter: 'new',
    loaded: false,
    notSetUp: false,
    error: null,
    // id → the text in its reply box, while it differs from what is saved.
    edits: {},
    // id (or 'sync') of the control waiting on the server.
    busy: null,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const host = () => document.getElementById('comments-host');
  const toastOk = (m) => window.showToast?.(m, { icon: '✅' });
  const toastErr = (m) => window.showToast?.(m, { icon: '⚠️' });

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
    state.comments = Array.isArray(data.comments) ? data.comments : [];
    state.counts = data.counts || state.counts;
    state.hasPageConnection = !!data.hasPageConnection;
    state.maxReplyChars = data.maxReplyChars || 1250;
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
    setBadge();
    render();
  }

  function setBadge() {
    const b = document.getElementById('comments-badge');
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

  function headerHtml() {
    const syncing = state.busy === 'sync';
    return `
      <section class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-base font-bold text-gray-900">Comments on your LinkedIn Page posts</h3>
            <p class="text-sm text-gray-600 mt-1">New comments are fetched every few hours. ${esc(state.assistantName || 'Your assistant')} drafts a reply in your brand’s voice — you edit it and press “Post reply” to post it as your Page. Nothing is posted until you do.</p>
          </div>
          <button type="button" data-cmt-sync class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${syncing || !state.hasPageConnection ? 'disabled' : ''}>${syncing ? 'Checking…' : 'Check for new comments'}</button>
        </div>
      </section>`;
  }

  function notConnectedHtml() {
    return `
      <div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <span class="font-bold">Connect your LinkedIn Company Page to see comments here.</span>
        In Connections, reconnect LinkedIn and choose “A Company Page”. Comments on a personal profile, Facebook, Instagram or X aren’t fetched yet.
      </div>`;
  }

  function chipsHtml() {
    const chip = (key, label) => `
      <button type="button" data-cmt-filter="${key}" aria-pressed="${state.filter === key}" class="px-3 py-1.5 text-xs font-bold rounded-full border transition ${state.filter === key ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-300'}">${label} (${esc(state.counts[key] || 0)})</button>`;
    return `<div class="flex flex-wrap gap-2" role="group" aria-label="Show comments">${chip('new', 'New')}${chip('replied', 'Replied')}${chip('dismissed', 'Dismissed')}</div>`;
  }

  function cardHtml(c) {
    const text = state.edits[c.id] !== undefined ? state.edits[c.id] : (c.draftReply || '');
    const dirty = state.edits[c.id] !== undefined && state.edits[c.id] !== (c.draftReply || '');
    const busy = state.busy === c.id;
    const open = c.linkedInUrl ? `<a href="${esc(c.linkedInUrl)}" target="_blank" rel="noopener noreferrer" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition">Open on LinkedIn</a>` : '';
    const over = text.length > state.maxReplyChars;
    let body;
    if (c.status === 'replied') {
      body = `
        <div class="mt-3 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
          <p class="text-xs font-bold text-gray-700">${c.repliedVia === 'linkedin' ? 'Your Page replied on LinkedIn' : c.replyUnconfirmed ? 'Sent — LinkedIn didn’t confirm it' : 'Posted as your Page'}${c.decidedAt ? ` · ${esc(when(c.decidedAt))}` : ''}</p>
          <p class="text-sm text-gray-800 mt-1 whitespace-pre-wrap break-words">${esc(c.replyText || '')}</p>
        </div>
        ${c.replyUnconfirmed ? '<p class="text-xs text-amber-800 mt-2">Check the post on LinkedIn. If your reply isn’t there, put this back in New and post it again.</p>' : ''}
        <div class="flex flex-wrap items-center gap-2 mt-3">${open}${c.replyUnconfirmed ? `
          <button type="button" data-cmt-status="${c.id}" data-status="new" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Put back in New</button>` : ''}</div>`;
    } else if (c.status === 'dismissed') {
      body = `
        <div class="flex flex-wrap items-center gap-2 mt-3">
          ${open}
          <button type="button" data-cmt-status="${c.id}" data-status="new" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Put back in New</button>
        </div>`;
    } else {
      const hasDraft = !!text.trim();
      body = `
        <label class="block text-xs font-bold text-gray-700 mt-3" for="cmt-reply-${c.id}">Your reply</label>
        <textarea id="cmt-reply-${c.id}" data-cmt-reply="${c.id}" rows="4" class="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="Press “Draft a reply”, or write your own.">${esc(text)}</textarea>
        <p class="text-xs mt-1 ${over ? 'text-red-600' : 'text-gray-500'}">${esc(text.length)} / ${esc(state.maxReplyChars)} characters${over ? ' — LinkedIn won’t take a reply this long.' : ''}</p>
        ${dirty ? `<button type="button" data-cmt-save-draft="${c.id}" class="btn-secondary border px-3 py-1.5 mt-1 text-xs font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Save my changes</button>` : ''}
        <div class="flex flex-wrap items-center gap-2 mt-3">
          <button type="button" data-cmt-post="${c.id}" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy || !hasDraft || over ? 'disabled' : ''}>Post reply</button>
          <button type="button" data-cmt-draft="${c.id}" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>${c.draftReply ? 'Redraft' : 'Draft a reply'}</button>
          ${open}
          <button type="button" data-cmt-status="${c.id}" data-status="dismissed" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Dismiss</button>
        </div>`;
    }
    return `
      <article class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm" data-cmt-card="${c.id}">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="px-2 py-0.5 rounded-full bg-gray-100 text-gray-800 font-bold">LinkedIn</span>
          <span class="font-bold text-gray-900">${esc(c.authorName)}</span>
          ${c.commentedAt ? `<span class="text-gray-500">· ${esc(when(c.commentedAt))}</span>` : ''}
        </div>
        <p class="text-sm text-gray-900 mt-2 whitespace-pre-wrap break-words">${esc(c.body)}</p>
        ${c.postExcerpt ? `<p class="text-xs text-gray-500 mt-2 break-words">On your post: “${esc(c.postExcerpt)}”</p>` : ''}
        ${body}
      </article>`;
  }

  function render() {
    const el = host();
    if (!el) return;
    if (!state.loaded) { el.innerHTML = '<p class="text-sm text-gray-600 p-4">Loading comments…</p>'; return; }
    if (state.notSetUp) {
      el.innerHTML = '<div class="bg-white border border-gray-200 rounded-xl p-6 text-sm text-gray-700">Comments aren’t set up on this server yet.</div>';
      return;
    }
    const list = state.comments.filter((c) => c.status === state.filter);
    const empty = state.filter === 'new'
      ? (state.hasPageConnection
          ? 'No new comments. Comments on the posts this assistant published to your Company Page in the last 30 days appear here.'
          : 'No comments yet.')
      : state.filter === 'replied' ? 'Comments you reply to are kept here.' : 'Comments you dismiss are kept here, in case you change your mind.';
    const focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
    const caret = focused && document.activeElement.selectionStart;
    el.innerHTML = `
      <div class="space-y-4">
        ${state.error ? `<p class="text-sm text-red-600" role="alert">${esc(state.error)}</p>` : ''}
        ${headerHtml()}
        ${state.hasPageConnection ? '' : notConnectedHtml()}
        ${chipsHtml()}
        ${list.length ? list.map(cardHtml).join('') : `<p class="text-sm text-gray-600 bg-white border border-gray-200 rounded-xl p-6">${esc(empty)}</p>`}
      </div>`;
    if (focused) {
      const f = document.getElementById(focused);
      if (f) { f.focus(); if (typeof caret === 'number' && f.setSelectionRange) try { f.setSelectionRange(caret, caret); } catch { /* not a text field */ } }
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  function find(id) { return state.comments.find((c) => c.id === id) || null; }

  function replace(c) {
    const i = state.comments.findIndex((x) => x.id === c.id);
    const before = i >= 0 ? state.comments[i] : null;
    // A write answers with the comment without its post excerpt — keep the one we had.
    const merged = before && !c.postExcerpt ? { ...c, postExcerpt: before.postExcerpt } : c;
    if (i >= 0) state.comments[i] = merged; else state.comments.unshift(merged);
    if (before && before.status !== c.status) {
      state.counts[before.status] = Math.max(0, (state.counts[before.status] || 0) - 1);
      state.counts[c.status] = (state.counts[c.status] || 0) + 1;
      setBadge();
    }
  }

  async function withBusy(key, fn) {
    state.busy = key;
    render();
    try { await fn(); } catch (err) { toastErr(err.message); } finally { state.busy = null; render(); }
  }

  async function sync() {
    await withBusy('sync', async () => {
      const r = await call('sync');
      applyList(r);
      setBadge();
      const added = r.result?.added || 0;
      const later = r.result?.skippedForTime || 0;
      const found = added ? `${added} new comment${added === 1 ? '' : 's'}` : (later ? 'No new comments so far' : 'No new comments');
      // Ran out of time: say so — "No new comments" would be untrue for the posts not checked yet.
      toastOk(later
        ? `${found}. ${later} older post${later === 1 ? ' wasn’t' : 's weren’t'} checked this time — they’re picked up by the next automatic check, within 6 hours.`
        : `${found}.`);
    });
  }

  async function draft(id) {
    const c = find(id);
    let instruction;
    if (c && c.draftReply) {
      instruction = await window.promptModal?.('What should change? Leave it blank to just improve it.', {
        title: 'Redraft this reply', confirmLabel: 'Redraft', multiline: true, placeholder: 'e.g. shorter, and invite them to our open day',
      });
      if (instruction === null || instruction === undefined) return;
    }
    await withBusy(id, async () => {
      const r = await call('draft', { id, instruction: instruction && instruction.trim() ? instruction.trim() : undefined });
      delete state.edits[id];
      replace(r.comment);
    });
  }

  async function saveDraft(id) {
    const text = state.edits[id];
    if (text === undefined) return;
    await withBusy(id, async () => {
      const r = await call('save_draft', { id, draft: text });
      delete state.edits[id];
      replace(r.comment);
      toastOk('Saved.');
    });
  }

  async function postReply(id) {
    const c = find(id);
    if (!c) return;
    const text = (state.edits[id] !== undefined ? state.edits[id] : (c.draftReply || '')).trim();
    if (!text) return;
    const ok = await window.confirmModal?.(`This posts your reply under the post, as your Company Page, where everyone can see it.\n\n“${text}”`, {
      title: 'Post this reply on LinkedIn?', confirmLabel: 'Post reply',
    });
    if (ok === false) return;
    await withBusy(id, async () => {
      const r = await call('post_reply', { id, text });
      delete state.edits[id];
      replace(r.comment);
      if (r.warning) toastErr(r.warning); else toastOk('Posted on LinkedIn as your Page.');
    });
  }

  async function setStatus(id, status) {
    await withBusy(id, async () => {
      const r = await call('set_status', { id, status });
      delete state.edits[id];
      replace(r.comment);
    });
  }

  document.addEventListener('click', (e) => {
    const el = host();
    if (!el || !el.contains(e.target)) return;
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.cmtFilter) { state.filter = b.dataset.cmtFilter; render(); return; }
    if (b.hasAttribute('data-cmt-sync')) { sync(); return; }
    if (b.dataset.cmtDraft) { draft(Number(b.dataset.cmtDraft)); return; }
    if (b.dataset.cmtSaveDraft) { saveDraft(Number(b.dataset.cmtSaveDraft)); return; }
    if (b.dataset.cmtPost) { postReply(Number(b.dataset.cmtPost)); return; }
    if (b.dataset.cmtStatus) { setStatus(Number(b.dataset.cmtStatus), b.dataset.status); }
  });

  document.addEventListener('input', (e) => {
    const el = host();
    if (!el || !el.contains(e.target) || !e.target.dataset.cmtReply) return;
    const id = Number(e.target.dataset.cmtReply);
    const c = find(id);
    const prev = state.edits[id] !== undefined ? state.edits[id] : (c?.draftReply || '');
    state.edits[id] = e.target.value;
    // Re-render only when a button or the length warning has to change; the counter is patched in place.
    const flips = (v) => [!!v.trim(), v !== (c?.draftReply || ''), v.length > state.maxReplyChars].join();
    if (flips(prev) !== flips(e.target.value)) { render(); return; }
    const counter = e.target.nextElementSibling;
    if (counter) counter.textContent = `${e.target.value.length} / ${state.maxReplyChars} characters`;
  });

  // A comment card in the chat changed something — reload behind it.
  document.addEventListener('comments:changed', (e) => {
    if (!state.assistantId || (e.detail && e.detail.assistantId && Number(e.detail.assistantId) !== Number(state.assistantId))) return;
    load();
  });

  window.AssistantComments = {
    /** Loads eagerly — the tab badge is the count of new comments. Paints on activate(). */
    init({ assistantId, assistantName }) {
      state.assistantName = assistantName || '';
      if (state.assistantId !== assistantId) {
        Object.assign(state, {
          assistantId, comments: [], counts: { new: 0, replied: 0, dismissed: 0 }, hasPageConnection: false,
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
