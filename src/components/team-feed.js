/**
 * src/components/team-feed.js
 * The Team feed — docs/campaign-orchestrator-flow.md §4. Backed by netlify/functions/team.ts.
 *
 * Where your assistants tell you, and each other, what they are doing: a brief received, work
 * started, ready for you, done. Their questions carry answer buttons. You can write to any
 * assistant; a note about a campaign reaches what it drafts for that campaign.
 *
 * Three places, one component:
 *   TeamFeed.mount(host, { mode: 'page' })                       — the Team page (side menu)
 *   TeamFeed.mount(host, { mode: 'assistant', assistantId })     — "From your team" on an assistant
 *   TeamFeed.mount(host, { mode: 'campaign', campaignId })       — a campaign's own conversation
 *
 * ⚠️ Every assistant message is written by the server where the work changed state — this file
 * renders, it never invents. Handlers are bound to `document` once, at load, and find their
 * instance by the host's data attribute, so a re-render can never strand a button without one.
 *
 * A note you send gets a real answer (2026-10-22): `send` with reply:'model' stores it, then this
 * file asks chat-orchestrator.ts for a turn on it (`teamMessageId`) — the same assistant, context and
 * cards as its chat, in its newest conversation. The server writes the reply under your note. A card
 * on that reply (change a setting, a rule, act on a post…) is shown in place by ChatSession in
 * `cardOnly` mode, so its buttons run through exactly the chat's handlers and endpoints.
 */
(function () {
  const API = '/.netlify/functions/team';
  const POLL_MS = 30000;
  /** The chosen order, remembered in this browser only — newest first unless they changed it. */
  const SORT_KEY = 'bms.teamChat.sort';
  function readSort() {
    try { return localStorage.getItem(SORT_KEY) !== 'oldest'; } catch (_) { return true; }
  }
  const instances = new Map();
  let nextId = 1;

  const ROLE_LABELS = {
    social_media_manager: 'Social Media', blog_writer: 'Blog Writing', lead_qualifier: 'Lead Generation',
    newsletter_editor: 'Email Marketing', brand_designer: 'Brand Designer', campaign_orchestrator: 'Campaign',
    mystery_shopper: 'Mystery Shopper',
    website_assistant: 'Website Assistant',
  };
  const KIND_CHIPS = {
    brief: ['Brief', 'bg-gray-50 text-gray-600 border-gray-200'],
    started: ['Started', 'bg-sky-50 text-sky-700 border-sky-200'],
    ready: ['Ready for you', 'bg-amber-50 text-amber-800 border-amber-200'],
    done: ['Done', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
    cancelled: ['Could not do it', 'bg-red-50 text-red-700 border-red-200'],
    question: ['Question', 'bg-amber-50 text-amber-800 border-amber-200'],
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function post(payload) {
    const res = await fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
    return data;
  }

  function when(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  async function load(inst) {
    const filter = inst.mode === 'campaign' ? { campaignId: inst.campaignId }
      : inst.mode === 'assistant' ? { assistantId: Number(inst.to) || inst.assistantId }
      : inst.thread.type === 'campaign' ? { campaignId: inst.thread.id }
      : inst.thread.type === 'assistant' ? { assistantId: inst.thread.id }
      : inst.thread.type === 'me' ? { mine: true } : {};
    try {
      const data = await post({ action: 'list', ...filter });
      // The server answers newest first; the order shown is the person's choice (sortNewest).
      inst.messages = (data.messages || []).slice().reverse();
      inst.assistants = data.assistants || [];
      inst.campaigns = data.campaigns || [];
      inst.error = null;
    } catch (err) {
      inst.error = err.message;
    }
    inst.loaded = true;
    render(inst);
    // Reading the page reads the messages: the badge on the side menu and the bell come down.
    if (inst.mode === 'page' && inst.messages.length) {
      const top = Math.max(...inst.messages.map((m) => m.id));
      if (top > (inst.readUpTo || 0)) {
        inst.readUpTo = top;
        post({ action: 'mark_read', upToId: top }).then(() => window.updateNotificationBadge?.()).catch(() => {});
      }
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  function assistantName(inst, id) {
    const a = inst.assistants.find((x) => Number(x.id) === Number(id));
    return a ? a.name : 'An assistant';
  }

  /** The assistant's avatar — its own letter and colour (assistant-colors.js), as on its card. */
  function avatarHtml(inst, id, size) {
    const known = inst.assistants.find((x) => Number(x.id) === Number(id));
    const a = known || { id, name: assistantName(inst, id) };
    const AC = window.AssistantColors;
    if (known) AC?.remember?.(known);   // never with the stand-in: that would drop a cached choice
    const colour = AC?.colorFor(a.id, a.avatarColor) || '#9ca3af';
    const letter = String(AC?.letterFor(a.id, a.name, a.avatarLetter) || (a.name || 'A').charAt(0).toUpperCase()).slice(0, 2);
    const px = size || 32;
    return `<span aria-hidden="true" class="shrink-0 inline-flex items-center justify-center rounded-full text-white font-bold"
      style="width:${px}px;height:${px}px;font-size:${Math.round(px * 0.42)}px;background:${esc(colour)}">${esc(letter)}</span>`;
  }

  function threadTitle(inst) {
    // An assistant's Team tab follows whoever "To" names — say so once it is someone else.
    if (inst.mode === 'assistant') return Number(inst.to) && Number(inst.to) !== inst.assistantId ? `With ${assistantName(inst, inst.to)}` : '';
    if (inst.mode !== 'page' || inst.thread.type === 'all') return inst.mode === 'page' ? 'Everything' : '';
    if (inst.thread.type === 'me') return 'Me';
    if (inst.thread.type === 'campaign') {
      const c = inst.campaigns.find((x) => Number(x.id) === Number(inst.thread.id));
      return c ? `Campaign: ${c.objective}` : 'Campaign';
    }
    return assistantName(inst, inst.thread.id);
  }

  /** Answer a just-sent note with a real chat turn. Resolves to an error message, or null. */
  async function askForReply(assistantId, teamMessageId) {
    try {
      const res = await fetch('/.netlify/functions/chat-orchestrator', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ aiAssistantId: assistantId, teamMessageId }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        // Their Chat window may be showing this same conversation behind the Team tab.
        document.dispatchEvent(new CustomEvent('team:chatTurn', { detail: { assistantId, chatSessionId: data.chatSessionId || null } }));
        return null;
      }
      const data = await res.json().catch(() => ({}));
      const why = data.uiElementJson?.reason || data.error;
      return `Your note is saved, but they couldn’t reply just now${why ? ` — ${why}` : '.'} They’ll see it when you next chat.`;
    } catch (_) {
      return 'Your note is saved, but they couldn’t reply just now. They’ll see it when you next chat.';
    }
  }

  /**
   * Mount each reply's card into its placeholder. A card already mounted for the same data is moved
   * back in rather than rebuilt, so a poll re-render never wipes a click that is still running.
   */
  function mountCards(inst) {
    if (!window.ChatSession || !window.DisruptiveUIRegistry) return;
    inst.cardEls = inst.cardEls || new Map();
    inst.host.querySelectorAll(`[data-team-card]`).forEach((slot) => {
      const m = inst.messages.find((x) => String(x.id) === slot.getAttribute('data-team-card'));
      if (!m || !m.card) return;
      const key = JSON.stringify(m.card);
      const had = inst.cardEls.get(m.id);
      if (had && had.key === key) { slot.appendChild(had.el); return; }
      const el = document.createElement('div');
      try {
        window.ChatSession.mount({
          container: el, cardOnly: true,
          assistantId: m.from.id, chatSessionId: m.link?.chatSessionId ?? null,
          initialMessages: [{ role: 'assistant', content: '', uiElement: m.card }],
        });
      } catch (_) { return; }
      inst.cardEls.set(m.id, { key, el });
      slot.appendChild(el);
    });
  }

  function messageHtml(inst, m) {
    const mine = m.from.kind === 'user';
    const [chip, chipCls] = KIND_CHIPS[m.kind] || [null, ''];
    const to = m.to.kind === 'assistant' ? ` → ${esc(m.to.name || 'a colleague')}` : m.to.kind === 'user' && !mine ? ' → you' : '';
    const camp = inst.mode !== 'campaign' && m.campaignId ? inst.campaigns.find((c) => Number(c.id) === Number(m.campaignId)) : null;
    const link = m.link ? `<button type="button" data-team-link='${esc(JSON.stringify(m.link))}' class="btn-secondary border px-3 py-1 text-xs font-bold rounded-lg mt-2">${esc(m.link.label || 'Open')}</button>` : '';
    const q = m.question;
    const answer = q ? (q.answered
      ? `<p class="text-xs text-gray-500 mt-2">You answered: <span class="font-bold text-gray-700">${esc(q.answer || '')}</span></p>`
      : `<div class="flex flex-wrap gap-2 mt-2">${q.choices.map((c) => `<button type="button" data-team-answer="${m.id}" data-value="${esc(c.value)}"
            class="btn-secondary border px-3 py-1 text-xs font-bold rounded-lg disabled:opacity-50">${esc(c.label)}</button>`).join('')}</div>`) : '';
    const face = !mine && m.from.kind === 'assistant' && m.from.id ? avatarHtml(inst, m.from.id, 32) : '';
    return `
      <div class="flex items-start gap-2 ${mine ? 'justify-end' : 'justify-start'}">
        ${face}
        <div class="rounded-xl border px-3 py-2 ${mine ? 'bg-gray-50 border-gray-200' : 'bg-white border-gray-200'}" style="max-width:36rem">
          <p class="text-[11px] text-gray-500"><span class="font-bold text-gray-700">${esc(mine ? 'You' : m.from.name)}</span>${to} · ${esc(when(m.createdAt))}
            ${chip ? `<span class="inline-flex items-center px-2 py-0.5 ml-1 rounded-full text-[10px] font-bold border ${chipCls}">${esc(chip)}</span>` : ''}</p>
          ${camp ? `<p class="text-[11px] text-gray-400 truncate">${esc(camp.objective)}</p>` : ''}
          <p class="text-sm text-gray-800 mt-1 whitespace-pre-line break-words">${esc(m.body)}</p>
          ${m.card ? `<div data-team-card="${m.id}" class="mt-2"></div>` : ''}
          ${answer}${link}
        </div>
      </div>`;
  }

  /** Who a new message can go to here: anyone, except in one assistant's thread on the Team page.
   *  An assistant's own Team tab offers everyone too (owner, 2026-10-22) — it starts on that
   *  assistant, and picking another shows your thread with them (see load and the change handler). */
  function recipients(inst) {
    const fixed = inst.mode === 'page' && inst.thread.type === 'assistant' ? inst.thread.id : null;
    if (fixed) return inst.assistants.filter((a) => Number(a.id) === Number(fixed));
    return inst.assistants;
  }
  function campaignOf(inst) {
    return inst.mode === 'campaign' ? inst.campaignId : inst.thread.type === 'campaign' ? inst.thread.id : null;
  }

  function composerHtml(inst) {
    const to = recipients(inst);
    if (!to.length) return '';
    const campaign = campaignOf(inst);
    return `
      <div class="border-t border-gray-100 pt-3 mt-3">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <label class="text-xs font-bold text-gray-600">To
            <select data-team-to="${inst.id}" class="ml-1 text-xs border border-gray-300 rounded-lg px-2 py-1 font-normal">
              ${to.map((a) => `<option value="${esc(String(a.id))}" ${Number(inst.to) === Number(a.id) ? 'selected' : ''}>${esc(a.name)}${ROLE_LABELS[a.roleKey] ? ` (${esc(ROLE_LABELS[a.roleKey])})` : ''}</option>`).join('')}
            </select>
          </label>
          <p class="text-[11px] text-gray-500">${campaign ? 'About this campaign — it changes what they draft for it from now on. They reply here.' : 'They reply here. Ask them to change a setting or remember a rule and they’ll offer it for you to confirm.'}</p>
        </div>
        <div class="flex items-end gap-2">
          <textarea data-team-text="${inst.id}" rows="2" maxlength="1000" placeholder="Tell them something, or ask a question…"
            class="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2">${esc(inst.draft || '')}</textarea>
          <button type="button" data-team-send="${inst.id}" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50" ${inst.sending ? 'disabled' : ''}>Send</button>
        </div>
        ${inst.sendError ? `<p class="text-xs font-semibold text-red-600 mt-1">${esc(inst.sendError)}</p>` : ''}
      </div>`;
  }

  function threadListHtml(inst) {
    const item = (type, id, label, sub, face) => {
      const active = inst.thread.type === type && Number(inst.thread.id || 0) === Number(id || 0);
      return `<button type="button" data-team-thread="${inst.id}" data-type="${type}" data-id="${id || ''}"
        class="w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${active ? 'bg-gray-100 font-bold text-gray-900' : 'text-gray-700 hover:bg-gray-50'}">
        ${face || ''}<span class="min-w-0"><span class="block truncate">${esc(label)}</span>${sub ? `<span class="block text-[11px] text-gray-500 truncate">${esc(sub)}</span>` : ''}</span></button>`;
    };
    const live = inst.campaigns.filter((c) => c.status === 'active' || c.status === 'throttled' || c.status === 'draft' || c.status === 'paused');
    return `
      <div class="space-y-1">
        ${item('all', null, 'Everything', 'Every message')}
        ${item('me', null, 'Me', 'To you, and what you have sent')}
        ${live.length ? `<p class="px-3 pt-3 text-[11px] font-bold text-gray-500 uppercase tracking-wide">Campaigns</p>${live.map((c) => item('campaign', c.id, c.objective, c.status)).join('')}` : ''}
        ${inst.assistants.length ? `<p class="px-3 pt-3 text-[11px] font-bold text-gray-500 uppercase tracking-wide">Assistants</p>${inst.assistants.map((a) => item('assistant', a.id, a.name, ROLE_LABELS[a.roleKey] || '', avatarHtml(inst, a.id, 24))).join('')}` : ''}
      </div>`;
  }

  function emptyText(inst) {
    if (inst.mode === 'assistant') return 'Nothing from the team yet. When a campaign briefs this assistant, or it has a question for you, it appears here.';
    if (inst.mode === 'campaign') return 'No messages on this campaign yet. When it briefs your assistants, they say so here.';
    if (inst.thread.type === 'me') return 'Nothing for you yet. Questions your assistants ask you, work ready for you, and anything you send appear here.';
    return 'No messages yet. When your assistants are briefed, start work, finish it or have a question, they say so here.';
  }

  function render(inst) {
    if (!inst.host || !document.body.contains(inst.host)) return;
    // Keep what was being typed: a poll re-render must never eat a half-written message.
    const typing = inst.host.querySelector(`[data-team-text="${inst.id}"]`);
    if (typing) inst.draft = typing.value;
    const toSel = inst.host.querySelector(`[data-team-to="${inst.id}"]`);
    if (toSel) inst.to = toSel.value;

    // Newest first by default (owner, 2026-10-14) — the latest news is what you open it for. Oldest
    // first reads like a conversation. The composer sits at the end you read from, so a reply is
    // written next to the message it answers.
    const ordered = inst.sortNewest ? inst.messages.slice().reverse() : inst.messages;
    const list = !inst.loaded ? '<p class="text-sm text-gray-400 py-6 text-center">Loading…</p>'
      : inst.error ? `<p class="text-sm text-red-600 py-6 text-center">${esc(inst.error)}</p>`
      : !inst.messages.length ? `<p class="text-sm text-gray-500 py-6 text-center">${esc(emptyText(inst))}</p>`
      : ordered.map((m) => messageHtml(inst, m)).join('');
    const replying = inst.replying
      ? `<p class="text-xs text-gray-500 italic py-1" role="status">${esc(assistantName(inst, inst.replying))} is writing a reply…</p>` : '';
    const composer = inst.loaded && !inst.error ? composerHtml(inst) : '';
    const sortBtn = inst.messages.length > 1 ? `<button type="button" data-team-sort="${inst.id}"
        class="btn-utility px-2 py-1 text-xs font-bold rounded-lg shrink-0">${inst.sortNewest ? 'Newest first ↓' : 'Oldest first ↑'}</button>` : '';
    const body = `
      <div class="flex items-center justify-between gap-3 mb-3">
        ${threadTitle(inst) ? `<p class="text-sm font-bold text-gray-900 truncate">${esc(threadTitle(inst))}</p>` : '<span></span>'}
        ${sortBtn}
      </div>
      ${inst.sortNewest ? composer.replace('border-t border-gray-100 pt-3 mt-3', 'border-b border-gray-100 pb-3 mb-3') : ''}
      <div data-team-scroll="${inst.id}" class="space-y-3 overflow-y-auto" style="max-height:${inst.mode === 'page' ? '60vh' : '24rem'}">${inst.sortNewest ? replying + list : list + replying}</div>
      ${inst.sortNewest ? '' : composer}`;

    inst.host.innerHTML = inst.mode === 'page'
      ? `<div class="team-grid" style="display:grid;gap:1rem">
           <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-3">${threadListHtml(inst)}</div>
           <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 min-w-0">${body}</div>
         </div>`
      : `<div class="min-w-0">${body}</div>`;
    mountCards(inst);
    // Start at the newest message, wherever the order puts it.
    const scroll = inst.host.querySelector(`[data-team-scroll="${inst.id}"]`);
    if (scroll) scroll.scrollTop = inst.sortNewest ? 0 : scroll.scrollHeight;
  }

  // ── Handlers (once, on document) ──────────────────────────────────────────
  function instFor(el, attr) {
    return instances.get(Number(el.getAttribute(attr))) || null;
  }

  document.addEventListener('click', async (e) => {
    const sort = e.target.closest('[data-team-sort]');
    if (sort) {
      const inst = instFor(sort, 'data-team-sort');
      if (!inst) return;
      inst.sortNewest = !inst.sortNewest;
      try { localStorage.setItem(SORT_KEY, inst.sortNewest ? 'newest' : 'oldest'); } catch (_) { /* per-viewer nicety only */ }
      render(inst);
      return;
    }
    const thread = e.target.closest('[data-team-thread]');
    if (thread) {
      const inst = instFor(thread, 'data-team-thread');
      if (!inst) return;
      inst.thread = { type: thread.dataset.type, id: thread.dataset.id ? Number(thread.dataset.id) : null };
      inst.loaded = false;
      render(inst);
      await load(inst);
      return;
    }

    const link = e.target.closest('[data-team-link]');
    if (link) {
      let l = null;
      try { l = JSON.parse(link.getAttribute('data-team-link')); } catch { return; }
      if (!l || !l.assistantId) return;
      if (l.callback) {
        // Help & Support's call-back form, in place when help.js is loaded; else via the URL it reads.
        if (typeof window.openCallbackForm === 'function') window.openCallbackForm();
        else window.location.href = '/workspace.html?help=contact&callback=1';
        return;
      }
      if (l.chat) { window.openAssistantChat?.({ assistantId: l.assistantId }); return; }
      window._assistantDetailInitialTab = l.tab || null;
      window.routeToAssistantDetail?.(String(l.assistantId));
      return;
    }

    const ans = e.target.closest('[data-team-answer]');
    if (ans) {
      const host = ans.closest('[data-team-host]');
      const inst = host ? instances.get(Number(host.getAttribute('data-team-host'))) : null;
      ans.parentElement.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await post({ action: 'answer', messageId: Number(ans.dataset.teamAnswer), value: ans.dataset.value });
      } catch (err) {
        window.showToast?.(err.message || 'That did not work — please try again.', 'error', { icon: '⚠️' });
      }
      if (inst) await load(inst);
      // An answer can start work or change a brief: anything showing those re-reads itself.
      document.dispatchEvent(new CustomEvent('campaign:updated', { detail: {} }));
      return;
    }

    const send = e.target.closest('[data-team-send]');
    if (send) {
      const inst = instFor(send, 'data-team-send');
      if (!inst || inst.sending) return;
      const text = (inst.host.querySelector(`[data-team-text="${inst.id}"]`)?.value || '').trim();
      const to = inst.host.querySelector(`[data-team-to="${inst.id}"]`)?.value;
      if (!text) { inst.sendError = 'Write something first.'; render(inst); return; }
      inst.sending = true;
      inst.sendError = null;
      send.disabled = true;
      let sentId = null;
      try {
        const r = await post({ action: 'send', assistantId: Number(to), campaignId: campaignOf(inst) || undefined, body: text, reply: 'model' });
        sentId = r.id || null;
        inst.draft = '';
        const box = inst.host.querySelector(`[data-team-text="${inst.id}"]`);
        if (box) box.value = '';
      } catch (err) {
        inst.sendError = err.message || 'It could not be sent — please try again.';
      }
      inst.sending = false;
      if (!sentId) { await load(inst); return; }
      // Show the note at once, then the real reply when the turn finishes.
      inst.replying = Number(to);
      await load(inst);
      const failed = await askForReply(Number(to), sentId);
      inst.replying = null;
      if (failed) inst.sendError = failed;
      await load(inst);
      // A confirmed card or a drafted post can change what other panels show.
      document.dispatchEvent(new CustomEvent('campaign:updated', { detail: {} }));
    }
  });

  // In an assistant's Team tab, picking someone else in "To" shows your thread with them, so their
  // reply lands where you are looking. On the Team page the thread list already does that.
  document.addEventListener('change', async (e) => {
    const sel = e.target.closest && e.target.closest('[data-team-to]');
    if (!sel) return;
    const inst = instFor(sel, 'data-team-to');
    if (!inst || inst.mode !== 'assistant') return;
    inst.to = sel.value;
    inst.loaded = false;
    render(inst);
    await load(inst);
  });

  // Enter sends, Shift+Enter is a new line — as in any chat.
  document.addEventListener('keydown', (e) => {
    const box = e.target.closest && e.target.closest('[data-team-text]');
    if (!box || e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    box.closest('[data-team-host]')?.querySelector('[data-team-send]')?.click();
  });

  // ── Mounting ──────────────────────────────────────────────────────────────
  function mount(host, opts) {
    if (!host) return null;
    // One instance per host: mounting again replaces it rather than doubling its polls.
    const prev = Number(host.getAttribute('data-team-host'));
    if (prev && instances.has(prev)) unmount(instances.get(prev));
    const inst = {
      id: nextId++, host, mode: opts.mode || 'page',
      assistantId: opts.assistantId ? Number(opts.assistantId) : null,
      campaignId: opts.campaignId ? Number(opts.campaignId) : null,
      thread: { type: 'all', id: null }, messages: [], assistants: [], campaigns: [],
      loaded: false, error: null, draft: '', to: opts.assistantId || null, sending: false, sendError: null,
      sortNewest: readSort(),
    };
    host.setAttribute('data-team-host', String(inst.id));
    instances.set(inst.id, inst);
    render(inst);
    load(inst);
    if (inst.mode === 'page') {
      inst.timer = setInterval(() => {
        if (!document.body.contains(host)) { unmount(inst); return; }
        if (!document.hidden) load(inst);
      }, POLL_MS);
    }
    return { refresh: () => load(inst), destroy: () => unmount(inst) };
  }

  function unmount(inst) {
    clearInterval(inst.timer);
    instances.delete(inst.id);
  }

  window.TeamFeed = { mount };
  /** The Team page (team.html), from the workspace router. */
  window.initTeam = async function () {
    const host = document.getElementById('team-host');
    if (host) mount(host, { mode: 'page' });
  };
})();
