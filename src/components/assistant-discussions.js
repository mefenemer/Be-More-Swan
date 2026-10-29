/**
 * src/components/assistant-discussions.js
 * Discussions tab — the Lead Generator's forum listening (registry `discussionsTab`).
 *
 * Public threads on Reddit, UK Business Forums, Quora and LinkedIn where someone is asking for what
 * this business sells, found by a daily Google scan of the topics set here, each with a drafted
 * reply. The person posts the reply themselves: "Copy reply & open thread" puts it on the clipboard
 * and opens the thread, and "Mark replied" files it. NOTHING here posts anywhere — see
 * src/config/discussion-sites.ts for why that is the design, not a missing feature.
 *
 * Backed by netlify/functions/discussions.ts — the same endpoint the chat's
 * discussion_action_proposal card calls (chat-session.js onDiscussionAction), which dispatches
 * `discussions:changed` on `document` so this tab reloads behind the chat.
 *
 * Vanilla IIFE assigning window.AssistantDiscussions. Handlers are bound ONCE to `document` and
 * scoped to the host, never from render() (memory: never bind handlers from a render path).
 * Styling reuses classes already compiled into style.css. All server values are escaped: thread
 * titles and snippets are strangers' words from the public web.
 */
(function () {
  const API = '/.netlify/functions/discussions';
  /** Re-read while a scan is running — it takes a minute or two. */
  const POLL_MS = 6000;

  const state = {
    assistantId: null,
    discussions: [],
    counts: { new: 0, replied: 0, dismissed: 0 },
    watch: null,
    sites: [],
    maxTopics: 5,
    filter: 'new',
    loading: false,
    loaded: false,
    notSetUp: false,
    error: null,
    // id → the text in its reply box, while it differs from what is saved.
    edits: {},
    // id (or 'watch' / 'scan') of the control waiting on the server.
    busy: null,
    // The "What to watch" form, while it is being edited, so a re-render keeps what was typed.
    watchDraft: null,
    pollTimer: null,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const host = () => document.getElementById('discussions-host');
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

  async function load() {
    if (!state.assistantId) return;
    state.loading = true;
    try {
      const data = await call('list');
      state.discussions = Array.isArray(data.discussions) ? data.discussions : [];
      state.counts = data.counts || state.counts;
      state.watch = data.watch || null;
      state.sites = Array.isArray(data.sites) ? data.sites : [];
      state.maxTopics = data.maxTopics || 5;
      state.notSetUp = false;
      state.error = null;
    } catch (err) {
      state.notSetUp = err.code === 'not_set_up';
      state.error = state.notSetUp ? null : err.message;
    } finally {
      state.loading = false;
      state.loaded = true;
    }
    setBadge();
    schedulePoll();
    render();
  }

  function setBadge() {
    const b = document.getElementById('discussions-badge');
    if (!b) return;
    const n = state.counts.new || 0;
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('hidden', !n);
    b.style.display = n ? '' : 'none';
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (state.watch && state.watch.scanning) state.pollTimer = setTimeout(load, POLL_MS);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function lastScanLine(w) {
    if (w.scanning) return '<span class="font-bold text-gray-900">Scanning now…</span> new threads appear here in a minute or two.';
    const ls = w.lastScan || {};
    if (ls.error) return `<span class="text-amber-800">${esc(ls.error)}</span>`;
    if (!w.lastScannedAt) return w.topics.length ? 'Not scanned yet — press “Scan now”, or the daily scan picks it up tomorrow morning.' : 'Add a topic to start.';
    const parts = [];
    if (ls.searches != null) parts.push(`${ls.searches} search${ls.searches === 1 ? '' : 'es'}`);
    if (ls.found != null) parts.push(`${ls.found} thread${ls.found === 1 ? '' : 's'} found`);
    if (ls.kept != null) parts.push(`${ls.kept} worth replying to`);
    return `Last scanned ${esc(when(w.lastScannedAt))}${parts.length ? ` — ${esc(parts.join(', '))}` : ''}.`;
  }

  function watchHtml() {
    const w = state.watch || { topics: [], sites: [], enabled: true, scanning: false };
    const d = state.watchDraft || { topics: w.topics.join('\n'), sites: w.sites.slice(), enabled: w.enabled };
    const siteBoxes = state.sites.map((s) => `
      <label class="inline-flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
        <input type="checkbox" data-disc-site="${esc(s.key)}" ${d.sites.includes(s.key) ? 'checked' : ''} class="rounded border-gray-300">
        ${esc(s.label)}
      </label>`).join('');
    return `
      <section class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-base font-bold text-gray-900">What to watch</h3>
            <p class="text-sm text-gray-600 mt-1">Write each topic the way a customer would ask for help — “can anyone recommend a bookkeeper for a small café”, not your business name. Up to ${esc(state.maxTopics)}, one per line.</p>
          </div>
          <button type="button" data-disc-scan class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${w.scanning || state.busy === 'scan' || !w.topics.length ? 'disabled' : ''}>${w.scanning ? 'Scanning…' : 'Scan now'}</button>
        </div>
        <label class="block text-xs font-bold text-gray-700 mt-4" for="disc-topics">Topics</label>
        <textarea id="disc-topics" data-disc-topics rows="3" class="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="best social media scheduler for a small business&#10;how do I get more Google reviews">${esc(d.topics)}</textarea>
        <p class="text-xs font-bold text-gray-700 mt-3">Sites</p>
        <div class="mt-1 flex flex-wrap gap-4">${siteBoxes}</div>
        <label class="inline-flex items-center gap-2 text-sm text-gray-800 mt-2 cursor-pointer">
          <input type="checkbox" data-disc-enabled ${d.enabled ? 'checked' : ''} class="rounded border-gray-300">
          Scan every morning
        </label>
        <div class="flex flex-wrap items-center gap-3 mt-3">
          <button type="button" data-disc-save-watch class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${state.busy === 'watch' || !state.watchDraft ? 'disabled' : ''}>Save</button>
          <p class="text-xs text-gray-600">${lastScanLine(w)} A scan costs one task.</p>
        </div>
      </section>`;
  }

  function rulesHtml() {
    return `
      <div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <span class="font-bold">You post, not us.</span> Copy a reply, open the thread and post it from your own account. Every reply ends with a disclosure line saying you work at the business — keep it in. The sites’ rules and UK consumer law both expect you to say when you’re recommending your own business.
      </div>`;
  }

  function chipsHtml() {
    const chip = (key, label) => `
      <button type="button" data-disc-filter="${key}" aria-pressed="${state.filter === key}" class="px-3 py-1.5 text-xs font-bold rounded-full border transition ${state.filter === key ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-300'}">${label} (${esc(state.counts[key] || 0)})</button>`;
    return `<div class="flex flex-wrap gap-2" role="group" aria-label="Show threads">${chip('new', 'New')}${chip('replied', 'Replied')}${chip('dismissed', 'Dismissed')}</div>`;
  }

  function cardHtml(t) {
    const text = state.edits[t.id] !== undefined ? state.edits[t.id] : (t.draftReply || '');
    const dirty = state.edits[t.id] !== undefined && state.edits[t.id] !== (t.draftReply || '');
    const disclosed = /\(Full disclosure:[^)]*\)\s*$/i.test(text);
    const busy = state.busy === t.id;
    const actions = t.status === 'new' ? `
        <button type="button" data-disc-copy="${t.id}" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Copy reply &amp; open thread</button>
        <button type="button" data-disc-status="${t.id}" data-status="replied" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Mark replied</button>
        <button type="button" data-disc-redraft="${t.id}" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Redraft</button>
        <button type="button" data-disc-status="${t.id}" data-status="dismissed" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Dismiss</button>`
      : `
        <a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition">Open thread</a>
        <button type="button" data-disc-status="${t.id}" data-status="new" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Put back in New</button>`;
    return `
      <article class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm" data-disc-card="${t.id}">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="px-2 py-0.5 rounded-full bg-gray-100 text-gray-800 font-bold">${esc(t.siteLabel)}</span>
          <span class="px-2 py-0.5 rounded-full ${t.fit === 'asking_for' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'} font-bold">${esc(t.fitLabel)}</span>
          <span class="text-gray-600">Relevance ${esc(t.relevance)}</span>
          ${t.postedLabel ? `<span class="text-gray-500">· ${esc(t.postedLabel)}</span>` : ''}
          ${t.status !== 'new' && t.decidedAt ? `<span class="text-gray-500">· ${t.status === 'replied' ? 'Replied' : 'Dismissed'} ${esc(when(t.decidedAt))}</span>` : ''}
        </div>
        <h4 class="text-base font-bold text-gray-900 mt-2 break-words"><a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer" class="hover:underline">${esc(t.title)}</a></h4>
        ${t.snippet ? `<p class="text-sm text-gray-600 mt-1 break-words">${esc(t.snippet)}</p>` : ''}
        ${t.why ? `<p class="text-sm text-gray-800 mt-2"><span class="font-bold">Why it’s worth replying:</span> ${esc(t.why)}</p>` : ''}
        ${t.readFrom === 'snippet' ? '<p class="text-xs text-amber-800 mt-2">Drafted from Google’s summary only — this site doesn’t let us read the thread. Read it before you reply.</p>' : ''}
        <label class="block text-xs font-bold text-gray-700 mt-3" for="disc-reply-${t.id}">Your reply</label>
        <textarea id="disc-reply-${t.id}" data-disc-reply="${t.id}" rows="6" class="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" ${t.status !== 'new' ? 'readonly' : ''}>${esc(text)}</textarea>
        ${!disclosed && text ? '<p class="text-xs text-red-600 mt-1">The disclosure line is missing. Add it back before you post — e.g. “(Full disclosure: I work at …, so I’m biased.)”</p>' : ''}
        ${dirty ? `<button type="button" data-disc-save-draft="${t.id}" class="btn-secondary border px-3 py-1.5 mt-2 text-xs font-bold rounded-lg transition disabled:opacity-50" ${busy ? 'disabled' : ''}>Save my changes</button>` : ''}
        <p class="text-xs text-gray-500 mt-2">${esc(t.promotionNote)}</p>
        <div class="flex flex-wrap items-center gap-2 mt-3">${actions}</div>
      </article>`;
  }

  function render() {
    const el = host();
    if (!el) return;
    if (!state.loaded) { el.innerHTML = '<p class="text-sm text-gray-600 p-4">Loading discussions…</p>'; return; }
    if (state.notSetUp) {
      el.innerHTML = '<div class="bg-white border border-gray-200 rounded-xl p-6 text-sm text-gray-700">Discussions isn’t set up on this server yet.</div>';
      return;
    }
    const list = state.discussions.filter((t) => t.status === state.filter);
    const empty = state.filter === 'new'
      ? (state.watch && state.watch.topics.length
          ? 'No new threads right now. The daily scan looks again tomorrow morning, or press “Scan now”.'
          : 'Add the topics your customers ask about above, then press “Scan now”.')
      : state.filter === 'replied' ? 'Threads you mark as replied are kept here.' : 'Threads you dismiss are kept here, in case you change your mind.';
    // Focus survives a re-render only by id — innerHTML replaces the element the user is typing in.
    const focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
    const caret = focused && document.activeElement.selectionStart;
    el.innerHTML = `
      <div class="space-y-4">
        ${state.error ? `<p class="text-sm text-red-600" role="alert">${esc(state.error)}</p>` : ''}
        ${watchHtml()}
        ${rulesHtml()}
        ${chipsHtml()}
        ${list.length ? list.map(cardHtml).join('') : `<p class="text-sm text-gray-600 bg-white border border-gray-200 rounded-xl p-6">${esc(empty)}</p>`}
      </div>`;
    if (focused) {
      const f = document.getElementById(focused);
      if (f) { f.focus(); if (typeof caret === 'number' && f.setSelectionRange) try { f.setSelectionRange(caret, caret); } catch { /* not a text field */ } }
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  function find(id) { return state.discussions.find((t) => t.id === id) || null; }

  function replace(d) {
    const i = state.discussions.findIndex((t) => t.id === d.id);
    const before = i >= 0 ? state.discussions[i] : null;
    if (i >= 0) state.discussions[i] = d; else state.discussions.unshift(d);
    if (before && before.status !== d.status) {
      state.counts[before.status] = Math.max(0, (state.counts[before.status] || 0) - 1);
      state.counts[d.status] = (state.counts[d.status] || 0) + 1;
      setBadge();
    }
  }

  async function withBusy(key, fn) {
    state.busy = key;
    render();
    try { await fn(); } catch (err) { toastErr(err.message); } finally { state.busy = null; render(); }
  }

  function readWatchForm() {
    const el = host();
    return {
      topics: (el.querySelector('[data-disc-topics]')?.value || ''),
      sites: [...el.querySelectorAll('[data-disc-site]')].filter((c) => c.checked).map((c) => c.dataset.discSite),
      enabled: !!el.querySelector('[data-disc-enabled]')?.checked,
    };
  }

  async function saveWatch() {
    const d = state.watchDraft || readWatchForm();
    await withBusy('watch', async () => {
      const r = await call('save_watch', { topics: d.topics.split('\n'), sites: d.sites, enabled: d.enabled });
      state.watch = r.watch;
      state.watchDraft = null;
      toastOk('Saved.');
    });
  }

  async function scanNow() {
    // Unsaved edits to the form are saved first — "Scan now" means scan for what is on screen.
    if (state.watchDraft) { await saveWatch(); if (state.watchDraft) return; }
    await withBusy('scan', async () => {
      const r = await call('scan_now');
      state.watch = r.watch;
      toastOk('Scanning now — new threads appear here in a minute or two.');
      schedulePoll();
    });
  }

  function copyAndOpen(id) {
    const t = find(id);
    if (!t) return;
    const text = state.edits[id] !== undefined ? state.edits[id] : (t.draftReply || '');
    // Opened inside the click itself, before anything awaits, or the browser blocks the new tab.
    window.open(t.url, '_blank', 'noopener');
    const done = () => toastOk('Reply copied. Paste it into the thread, then press “Mark replied”.');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => toastErr('Couldn’t copy the reply — select it in the box and copy it yourself.'));
    } else {
      toastErr('Couldn’t copy the reply — select it in the box and copy it yourself.');
    }
  }

  async function setStatus(id, status) {
    await withBusy(id, async () => {
      const r = await call('set_status', { id, status });
      delete state.edits[id];
      replace(r.discussion);
    });
  }

  async function saveDraft(id) {
    const text = state.edits[id];
    if (text === undefined) return;
    await withBusy(id, async () => {
      const r = await call('save_draft', { id, draft: text });
      delete state.edits[id];
      replace(r.discussion);
      toastOk('Saved.');
    });
  }

  async function redraft(id) {
    const instruction = await window.promptModal?.('What should change? Leave it blank to just improve it.', {
      title: 'Redraft this reply', confirmLabel: 'Redraft', multiline: true, placeholder: 'e.g. shorter, and mention we’re based in Leeds',
    });
    if (instruction === null || instruction === undefined) return;
    await withBusy(id, async () => {
      const r = await call('redraft', { id, instruction: instruction.trim() || undefined });
      delete state.edits[id];
      replace(r.discussion);
      toastOk('Rewritten.');
    });
  }

  // Bound once, to document, scoped to the host — render() replaces everything inside it.
  document.addEventListener('click', (e) => {
    const el = host();
    if (!el || !el.contains(e.target)) return;
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.discFilter) { state.filter = b.dataset.discFilter; render(); return; }
    if (b.hasAttribute('data-disc-scan')) { scanNow(); return; }
    if (b.hasAttribute('data-disc-save-watch')) { saveWatch(); return; }
    if (b.dataset.discCopy) { copyAndOpen(Number(b.dataset.discCopy)); return; }
    if (b.dataset.discStatus) { setStatus(Number(b.dataset.discStatus), b.dataset.status); return; }
    if (b.dataset.discRedraft) { redraft(Number(b.dataset.discRedraft)); return; }
    if (b.dataset.discSaveDraft) { saveDraft(Number(b.dataset.discSaveDraft)); }
  });

  document.addEventListener('input', (e) => {
    const el = host();
    if (!el || !el.contains(e.target)) return;
    if (e.target.dataset.discReply) {
      const id = Number(e.target.dataset.discReply);
      const t = find(id);
      const before = state.edits[id] !== undefined && state.edits[id] !== (t?.draftReply || '');
      state.edits[id] = e.target.value;
      const after = e.target.value !== (t?.draftReply || '');
      // Re-render only when the Save button or the disclosure warning has to appear or go.
      const disclosedBefore = /\(Full disclosure:[^)]*\)\s*$/i.test(t?.draftReply || '');
      if (before !== after || /\(Full disclosure:[^)]*\)\s*$/i.test(e.target.value) !== disclosedBefore) render();
      return;
    }
    if (e.target.matches('[data-disc-topics]')) {
      const hadDraft = !!state.watchDraft;
      state.watchDraft = readWatchForm();
      if (!hadDraft) render();
    }
  });

  document.addEventListener('change', (e) => {
    const el = host();
    if (!el || !el.contains(e.target)) return;
    if (e.target.matches('[data-disc-site], [data-disc-enabled]')) { state.watchDraft = readWatchForm(); render(); }
  });

  // A discussion card in the chat changed something — reload behind it.
  document.addEventListener('discussions:changed', (e) => {
    if (!state.assistantId || (e.detail && e.detail.assistantId && Number(e.detail.assistantId) !== Number(state.assistantId))) return;
    load();
  });

  window.AssistantDiscussions = {
    /** Loads eagerly — the tab badge is the count of new threads. Paints on activate(). */
    init({ assistantId }) {
      if (state.assistantId !== assistantId) {
        Object.assign(state, {
          assistantId, discussions: [], counts: { new: 0, replied: 0, dismissed: 0 }, watch: null,
          filter: 'new', loaded: false, notSetUp: false, error: null, edits: {}, busy: null, watchDraft: null,
        });
        clearTimeout(state.pollTimer);
      }
      load();
    },
    activate() {
      render();
      if (state.loaded) load();
    },
    reload: load,
  };
})();
