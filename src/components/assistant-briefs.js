/**
 * src/components/assistant-briefs.js
 * The Brand Designer's Briefs tab — docs/brand-designer-plan.md §4.2–4.4.
 *
 * A brief says what a picture is FOR. "Make options" runs one round (stock, AI, branded cards — the
 * sources the brief allows); the options come back as a grid; the user approves one into the library
 * or turns options down with a reason the next round reads.
 *
 * Backed by netlify/functions/brand-briefs.ts — the SAME actions the chat cards call
 * (chat-session.js → brief:create / brief:review), so the two surfaces can never disagree about what
 * a brief can do. Writes made from the chat dispatch `brief:changed`, which reloads this tab.
 *
 * ── What this tab may not do ─────────────────────────────────────────────────
 * Spend without a click. "Make options" is the only write that can cost anything, and its button
 * states the cost before it is pressed. Nothing here generates on load or as a side effect.
 *
 * ── Saying what is happening ─────────────────────────────────────────────────
 * Every brief carries one plain sentence about what it is waiting for (the Searches/Campaigns tab
 * lesson: a list that does not say what it is doing reads as broken). A round in flight is polled
 * until it ends; one that never ends is closed and refunded by the server's sweep on the next load.
 *
 * Handlers are bound to `document` once, at load, never from render — a button that renders but has
 * no handler is the one failure this codebase keeps rediscovering. Server values are escaped.
 */
(function () {
  const API = '/.netlify/functions/brand-briefs';
  const POLL_MS = 4000;

  const state = {
    assistantId: null,
    briefs: [],
    vocab: null,
    credits: null,
    aiAvailable: false,
    /** What a new brief ticks — from the assistant's setup (all sources, or free ones only). */
    defaultSources: null,
    loaded: false,
    loadError: null,
    rendered: false,
    /** null | { mode: 'create' } | { mode: 'edit', id } */
    form: null,
    /** Option id whose "Not this" reason picker is open. */
    rejecting: null,
    /** Brief ids with their per-brief message line, e.g. a refusal from the server. */
    notes: {},
    showCancelled: false,
    pollTimer: null,
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const V = () => state.vocab || { purposes: [], aspectRatios: [], sources: [], rejectReasons: [], maxRounds: 6 };
  const sourceLabel = (k) => (V().sources.find((s) => s.key === k) || { label: k }).label;
  const purposeLabel = (k) => (V().purposes.find((p) => p.key === k) || { label: k }).label;

  // ── Server ─────────────────────────────────────────────────────────────────
  async function post(payload) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(data, res.status));
    return data;
  }

  /** The credit refusal is a code, not a sentence — say it in words, with the numbers. */
  function errorText(data, status) {
    if (data && data.code === 'insufficient_credits') {
      return `Not enough AI credits: a round needs ${data.cost}, and ${data.balance} ${data.balance === 1 ? 'is' : 'are'} left this month. Edit the brief and untick AI images to use stock photos and branded cards, which are free.`;
    }
    return (data && data.error) || `Request failed (HTTP ${status}).`;
  }

  async function load() {
    if (!state.assistantId) return;
    try {
      const data = await post({ action: 'list', assistantId: state.assistantId });
      state.briefs = Array.isArray(data.briefs) ? data.briefs : [];
      state.vocab = data.vocab || null;
      state.credits = data.credits ?? null;
      state.aiAvailable = !!data.aiAvailable;
      state.defaultSources = Array.isArray(data.defaultSources) ? data.defaultSources : null;
      state.loadError = null;
    } catch (err) {
      console.error('[AssistantBriefs] load failed:', err);
      state.loadError = err.message;
    }
    state.loaded = true;
    rerender();
    schedulePoll();
  }

  /** Poll only while a round is in flight. The server ends a stuck one, so this always stops. */
  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (state.briefs.some((b) => b.status === 'generating')) state.pollTimer = setTimeout(load, POLL_MS);
  }

  // ── Tab badge ──────────────────────────────────────────────────────────────
  /** Briefs with options waiting for a decision — the number the user is meant to bring down. */
  function updateBadge() {
    const el = document.getElementById('briefs-review-badge');
    if (!el) return;
    const n = state.briefs.filter((b) => b.options.some((o) => o.status === 'proposed') && b.status !== 'cancelled').length;
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('hidden', n === 0);
    // `hidden` loses to inline-flex (equal specificity, later in style.css) — pin it inline too.
    el.style.display = n === 0 ? 'none' : '';
  }

  // ── Pieces ─────────────────────────────────────────────────────────────────
  function chip(b) {
    const base = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold border';
    const waiting = b.options.filter((o) => o.status === 'proposed').length;
    if (b.status === 'generating') return `<span class="${base} bg-indigo-50 text-indigo-700 border-indigo-200">Making options</span>`;
    if (b.status === 'cancelled') return `<span class="${base} bg-gray-50 text-gray-500 border-gray-200">Cancelled</span>`;
    if (b.status === 'approved') return `<span class="${base} bg-emerald-50 text-emerald-800 border-emerald-200">Approved</span>`;
    if (waiting) return `<span class="${base} bg-amber-50 text-amber-800 border-amber-200">Needs you</span>`;
    return `<span class="${base} bg-gray-50 text-gray-600 border-gray-200">Not started</span>`;
  }

  function activityLine(b) {
    const waiting = b.options.filter((o) => o.status === 'proposed').length;
    const approved = b.options.filter((o) => o.status === 'approved').length;
    if (b.status === 'generating') return 'Making options now — usually under a minute. This page updates by itself.';
    if (b.status === 'cancelled') return 'Cancelled. Anything you approved is still in your library.';
    if (b.status === 'approved') {
      return `Done — ${approved} in your library${waiting ? `, and ${waiting} more ${waiting === 1 ? 'option is' : 'options are'} still here if you want ${waiting === 1 ? 'it' : 'them'}` : ''}.`;
    }
    if (waiting) return `${waiting} ${waiting === 1 ? 'option is' : 'options are'} waiting for you. Nothing is used anywhere until you approve it.`;
    if (b.rounds > 0) return 'Every option so far was turned down. Make another round — it reads why you turned them down.';
    return 'Not started. Press "Make options" when the brief says what you want.';
  }

  /** The label on the round button states its cost before the click. */
  function roundButtonLabel(b) {
    const verb = b.rounds > 0 ? 'Make more options' : 'Make options';
    const ai = b.sources.includes('ai_image') && state.aiAvailable;
    return ai ? `${verb} (${b.roundCredits} AI credit)` : `${verb} (free)`;
  }

  function optionTile(b, o) {
    const ratio = String(b.aspectRatio || '1:1').replace(':', ' / ');
    const img = o.url
      ? `<img src="${esc(o.url)}" alt="${esc(sourceLabel(o.source))} option" loading="lazy" class="w-full h-full object-cover">`
      : '<div class="w-full h-full flex items-center justify-center text-xs text-gray-400">No preview</div>';
    const credit = o.source === 'stock' && o.attributionName
      ? `<p class="text-[11px] text-gray-500 mt-1 truncate">Photo by ${o.attributionUrl ? `<a href="${esc(o.attributionUrl)}" target="_blank" rel="noopener" class="underline">${esc(o.attributionName)}</a>` : esc(o.attributionName)} on Pexels</p>`
      : '';
    let actions = '';
    if (o.status === 'approved') {
      actions = '<p class="text-xs font-bold text-emerald-700 mt-2">✓ In your library</p>';
    } else if (state.rejecting === o.id) {
      actions = `
        <div class="mt-2 space-y-1" data-brief-reject-panel="${o.id}">
          <p class="text-[11px] font-bold text-gray-700">What is wrong with it?</p>
          <div class="flex flex-wrap gap-1">
            ${V().rejectReasons.map((r) => `<button type="button" data-brief-reject-reason="${esc(r.key)}" data-option="${o.id}"
              class="btn-secondary px-2 py-1 border text-[11px] font-bold rounded-lg">${esc(r.label)}</button>`).join('')}
          </div>
          <input type="text" data-brief-reject-note="${o.id}" maxlength="300" placeholder="In your words (optional)"
            class="w-full mt-1 px-2 py-1 border border-gray-200 rounded-lg text-xs">
          <button type="button" data-brief-reject-cancel class="text-[11px] text-gray-500 underline">Keep it</button>
        </div>`;
    } else if (o.status === 'proposed' && b.status !== 'cancelled') {
      actions = `
        <div class="flex gap-1 mt-2">
          <button type="button" data-brief-approve="${o.id}" class="btn-primary flex-1 px-2 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50">Use this</button>
          <button type="button" data-brief-reject="${o.id}" class="btn-secondary flex-1 px-2 py-1.5 border text-xs font-bold rounded-lg transition disabled:opacity-50">Not this</button>
        </div>`;
    }
    return `
      <div class="bg-white border ${o.status === 'approved' ? 'border-emerald-300' : 'border-gray-200'} rounded-xl p-2">
        <div class="relative rounded-lg overflow-hidden bg-gray-100" style="aspect-ratio:${esc(ratio)}">${img}</div>
        <p class="text-[11px] font-bold text-gray-600 mt-1">${esc(sourceLabel(o.source).replace(/s$/, ''))} · round ${o.round}</p>
        ${credit}
        ${actions}
      </div>`;
  }

  function artDirectionHtml(b) {
    const a = b.artDirection;
    if (!a || typeof a !== 'object') return '';
    const rows = [
      a.imagePrompt && b.sources.includes('ai_image') ? `<li><span class="font-bold">AI image:</span> ${esc(a.imagePrompt)}</li>` : '',
      a.stockKeywords && b.sources.includes('stock') ? `<li><span class="font-bold">Stock search:</span> ${esc(a.stockKeywords)}</li>` : '',
      Array.isArray(a.cardHeadlines) && a.cardHeadlines.length && b.sources.includes('brand_card')
        ? `<li><span class="font-bold">Card words:</span> ${a.cardHeadlines.map(esc).join(' / ')}</li>` : '',
    ].filter(Boolean).join('');
    if (!rows) return '';
    return `
      <details class="mt-3 text-xs text-gray-600">
        <summary class="cursor-pointer font-bold text-gray-700"><span data-explain="brand-art-direction">How the designer read this brief</span></summary>
        <ul class="mt-2 space-y-1 list-disc pl-5">${rows}</ul>
        ${a.by === 'fallback' ? '<p class="mt-1 text-amber-700">The designer could not be reached, so your brief was used word for word.</p>' : ''}
      </details>`;
  }

  function briefCard(b) {
    const visible = b.options.filter((o) => o.status !== 'rejected');
    const rejected = b.options.length - visible.length;
    const note = state.notes[b.id];
    const meta = [purposeLabel(b.purpose), b.aspectRatio, b.sources.map(sourceLabel).join(', '), b.dueDate ? `due ${b.dueDate}` : '', b.origin === 'chat' ? 'from chat' : '']
      .filter(Boolean).map(esc).join(' · ');
    const live = b.status !== 'cancelled';
    return `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5" data-brief-card="${b.id}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-bold text-gray-900 break-words">${esc(b.title)}</p>
            <p class="text-xs text-gray-500 mt-0.5">${meta}</p>
          </div>
          ${chip(b)}
        </div>
        ${b.message ? `<p class="text-sm text-gray-700 mt-2 break-words">${esc(b.message)}</p>` : ''}
        ${b.headline ? `<p class="text-xs text-gray-600 mt-1">Words on the card: <span class="font-bold">${esc(b.headline)}</span></p>` : ''}
        <p class="text-xs text-gray-600 mt-2">${esc(activityLine(b))}</p>
        ${b.generationNote ? `<p class="text-xs text-amber-700 mt-1">${esc(b.generationNote)}</p>` : ''}
        ${note ? `<p class="text-xs mt-1 ${note.tone === 'error' ? 'text-red-600' : 'text-indigo-700'} font-semibold">${esc(note.text)}</p>` : ''}
        ${visible.length ? `<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">${visible.map((o) => optionTile(b, o)).join('')}</div>` : ''}
        ${rejected ? `<p class="text-[11px] text-gray-500 mt-2">${rejected} turned down — the next round reads why.</p>` : ''}
        ${artDirectionHtml(b)}
        ${live ? `
          <div class="flex flex-wrap items-center gap-2 mt-4">
            <button type="button" data-brief-generate="${b.id}" ${b.status === 'generating' || b.rounds >= V().maxRounds ? 'disabled' : ''}
              class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${esc(roundButtonLabel(b))}</button>
            <button type="button" data-brief-edit="${b.id}" ${b.status === 'generating' ? 'disabled' : ''}
              class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition disabled:opacity-50">Edit brief</button>
            <button type="button" data-brief-cancel="${b.id}" ${b.status === 'generating' ? 'disabled' : ''}
              class="btn-utility px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50">Cancel brief</button>
          </div>` : ''}
      </div>`;
  }

  function formHtml() {
    if (!state.form) return '';
    const editing = state.form.mode === 'edit' ? state.briefs.find((b) => b.id === state.form.id) : null;
    const v = editing || { purpose: 'social_post', aspectRatio: '', sources: state.defaultSources || V().sources.map((s) => s.key) };
    const field = (label, inner, explain) => `
      <label class="block">
        <span class="text-xs font-bold text-gray-700"${explain ? ` data-explain="${explain}"` : ''}>${label}</span>
        ${inner}
      </label>`;
    const input = (name, val, ph, max) => `<input type="text" data-keep="brief-${name}" name="${name}" value="${esc(val || '')}" maxlength="${max}" placeholder="${esc(ph)}" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">`;
    return `
      <form data-brief-form class="bg-white rounded-2xl border-2 border-indigo-200 shadow-sm p-5 mb-4 space-y-3">
        <p class="text-sm font-bold text-gray-900">${editing ? 'Edit brief' : 'New brief'}</p>
        ${field('Name', input('title', v.title, 'e.g. Spring launch — hero image', 120))}
        ${field('What should it show, or say?', `<textarea data-keep="brief-message" name="message" maxlength="1000" rows="3" placeholder="e.g. A small team celebrating in a bright studio — the feeling of finally having time back" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">${esc(v.message || '')}</textarea>`)}
        ${field('Exact words for a branded card (optional)', input('headline', v.headline, 'e.g. Your Monday, sorted.', 120))}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${field('Mood (optional)', input('mood', v.mood, 'e.g. warm, calm, confident', 300))}
          ${field('Due (optional)', `<input type="date" data-keep="brief-dueDate" name="dueDate" value="${esc(v.dueDate || '')}" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">`)}
          ${field('Must include (optional)', input('mustInclude', v.mustInclude, 'e.g. a laptop, our pink', 500))}
          ${field('Must avoid (optional)', input('mustAvoid', v.mustAvoid, 'e.g. handshakes, suits', 500))}
          ${field('What is it for?', `<select data-keep="brief-purpose" name="purpose" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">
            ${V().purposes.map((p) => `<option value="${esc(p.key)}" ${p.key === v.purpose ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>`)}
          ${field('Shape', `<select data-keep="brief-aspectRatio" name="aspectRatio" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">
            <option value="">Best for what it is for</option>
            ${V().aspectRatios.map((a) => `<option value="${esc(a.key)}" ${editing && a.key === v.aspectRatio ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select>`)}
        </div>
        <fieldset>
          <legend class="text-xs font-bold text-gray-700"><span data-explain="brand-brief-sources">Where options come from</span></legend>
          <div class="mt-1 space-y-1">
            ${V().sources.map((s) => {
              const off = s.key === 'ai_image' && !state.aiAvailable;
              return `<label class="flex items-start gap-2 text-sm ${off ? 'text-gray-400' : 'text-gray-700'}">
                <input type="checkbox" data-keep="brief-src-${esc(s.key)}" name="source" value="${esc(s.key)}" ${v.sources.includes(s.key) && !off ? 'checked' : ''} ${off ? 'disabled' : ''} class="mt-1">
                <span>${esc(s.label)} <span class="text-xs text-gray-500">— ${esc(off ? 'not switched on for this workspace' : s.cost)}</span></span>
              </label>`;
            }).join('')}
          </div>
        </fieldset>
        <p class="text-xs text-red-600 font-semibold hidden" data-brief-form-error></p>
        <div class="flex flex-wrap gap-2">
          ${editing ? '' : '<button type="submit" data-brief-submit="generate" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Save and make options</button>'}
          <button type="submit" data-brief-submit="save" class="${editing ? 'btn-primary' : 'btn-secondary border'} px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">${editing ? 'Save changes' : 'Just save the brief'}</button>
          <button type="button" data-brief-form-close class="btn-utility px-4 py-2 text-sm font-bold rounded-lg">Cancel</button>
        </div>
      </form>`;
  }

  function toolbarHtml() {
    const credits = state.credits == null ? '' : `<span class="text-xs text-gray-500">AI credits left this month: <span class="font-bold">${esc(state.credits)}</span></span>`;
    return `
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 class="text-base font-bold text-gray-900"><span data-explain="brand-briefs">Briefs</span></h2>
          <p class="text-xs text-gray-500">Say what a picture is for. Approve the option that fits — it goes into your library for every assistant to use.</p>
        </div>
        <div class="flex items-center gap-3">
          ${credits}
          ${state.form ? '' : '<button type="button" data-brief-new class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition">New brief</button>'}
        </div>
      </div>`;
  }

  function emptyState() {
    return `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
        <p class="text-sm font-bold text-gray-700">No briefs yet</p>
        <p class="text-xs text-gray-500 mt-2">Press "New brief", or tell your Brand Designer in chat what you need — "a square image for our spring offer, warm and bright". Either way, nothing is made until you press "Make options", and nothing is used until you approve it.</p>
      </div>`;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    const host = document.getElementById('briefs-host');
    if (!host) return;
    if (state.loadError && !state.briefs.length) {
      host.innerHTML = `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
          <p class="text-sm font-bold text-gray-700">Could not load your briefs</p>
          <p class="text-xs text-gray-500 mt-2">${esc(state.loadError)}</p>
        </div>`;
      return;
    }
    if (!state.loaded) {
      host.innerHTML = '<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center"><p class="text-sm text-gray-400">Loading briefs…</p></div>';
      return;
    }
    // The poll re-renders every few seconds while a round runs — carry typed values across it.
    const kept = {};
    host.querySelectorAll('[data-keep]').forEach((el) => { kept[el.dataset.keep] = el.type === 'checkbox' ? el.checked : el.value; });
    const keptNotes = {};
    host.querySelectorAll('[data-brief-reject-note]').forEach((el) => { keptNotes[el.dataset.briefRejectNote] = el.value; });

    const live = state.briefs.filter((b) => b.status !== 'cancelled');
    const cancelled = state.briefs.filter((b) => b.status === 'cancelled');
    host.innerHTML = `
      ${toolbarHtml()}
      ${formHtml()}
      ${!live.length && !state.form ? emptyState() : ''}
      <div class="space-y-4">${live.map(briefCard).join('')}</div>
      ${cancelled.length ? `
        <button type="button" data-brief-toggle-cancelled class="mt-4 text-xs text-gray-500 underline">${state.showCancelled ? 'Hide' : 'Show'} cancelled briefs (${cancelled.length})</button>
        ${state.showCancelled ? `<div class="space-y-4 mt-3">${cancelled.map(briefCard).join('')}</div>` : ''}` : ''}`;

    host.querySelectorAll('[data-keep]').forEach((el) => {
      if (!Object.prototype.hasOwnProperty.call(kept, el.dataset.keep)) return;
      if (el.type === 'checkbox') el.checked = kept[el.dataset.keep];
      else el.value = kept[el.dataset.keep];
    });
    host.querySelectorAll('[data-brief-reject-note]').forEach((el) => {
      if (keptNotes[el.dataset.briefRejectNote] != null) el.value = keptNotes[el.dataset.briefRejectNote];
    });
  }

  function rerender() {
    updateBadge();
    if (state.rendered) render();
  }

  function say(briefId, text, tone) {
    state.notes[briefId] = text ? { text, tone } : null;
    rerender();
  }

  // ── Actions (bound once, to document) ──────────────────────────────────────
  async function generateRound(briefId) {
    say(briefId, 'Starting…');
    try {
      await post({ action: 'generate', briefId });
      say(briefId, null);
    } catch (err) {
      say(briefId, err.message, 'error');
    }
    await load();
  }

  document.addEventListener('click', async (e) => {
    if (!state.assistantId || !e.target.closest('#briefs-host')) return;
    const t = (sel) => e.target.closest(sel);

    if (t('[data-brief-new]')) { state.form = { mode: 'create' }; render(); return; }
    if (t('[data-brief-form-close]')) { state.form = null; render(); return; }
    if (t('[data-brief-toggle-cancelled]')) { state.showCancelled = !state.showCancelled; render(); return; }
    if (t('[data-brief-reject-cancel]')) { state.rejecting = null; render(); return; }

    const edit = t('[data-brief-edit]');
    if (edit) { state.form = { mode: 'edit', id: Number(edit.dataset.briefEdit) }; render(); window.scrollTo?.({ top: 0, behavior: 'smooth' }); return; }

    const gen = t('[data-brief-generate]');
    if (gen) { gen.disabled = true; await generateRound(Number(gen.dataset.briefGenerate)); return; }

    const cancel = t('[data-brief-cancel]');
    if (cancel) {
      const id = Number(cancel.dataset.briefCancel);
      const ok = await window.confirmModal('Options you have not approved are deleted. Anything already in your library stays.', {
        title: 'Cancel this brief?', confirmLabel: 'Cancel brief', cancelLabel: 'Keep it',
      });
      if (!ok) return;
      try { await post({ action: 'cancel', briefId: id }); } catch (err) { say(id, err.message, 'error'); }
      await load();
      return;
    }

    const approve = t('[data-brief-approve]');
    if (approve) {
      approve.disabled = true;
      const optionId = Number(approve.dataset.briefApprove);
      const brief = state.briefs.find((b) => b.options.some((o) => o.id === optionId));
      try {
        await post({ action: 'decide', optionId, decision: 'approve' });
        if (brief) say(brief.id, 'Added to your library — every assistant can use it now.');
      } catch (err) {
        if (brief) say(brief.id, err.message, 'error');
      }
      await load();
      return;
    }

    const reject = t('[data-brief-reject]');
    if (reject) { state.rejecting = Number(reject.dataset.briefReject); render(); return; }

    const reason = t('[data-brief-reject-reason]');
    if (reason) {
      const optionId = Number(reason.dataset.option);
      const note = document.querySelector(`[data-brief-reject-note="${optionId}"]`)?.value || '';
      const brief = state.briefs.find((b) => b.options.some((o) => o.id === optionId));
      try {
        await post({ action: 'decide', optionId, decision: 'reject', reason: reason.dataset.briefRejectReason, note });
        state.rejecting = null;
      } catch (err) {
        if (brief) say(brief.id, err.message, 'error');
      }
      await load();
    }
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest && e.target.closest('[data-brief-form]');
    if (!form || !state.assistantId) return;
    e.preventDefault();
    const submitter = e.submitter && e.submitter.dataset ? e.submitter.dataset.briefSubmit : 'save';
    const errEl = form.querySelector('[data-brief-form-error]');
    const fd = new FormData(form);
    const brief = {
      title: fd.get('title'), message: fd.get('message'), headline: fd.get('headline'), mood: fd.get('mood'),
      mustInclude: fd.get('mustInclude'), mustAvoid: fd.get('mustAvoid'), purpose: fd.get('purpose'),
      aspectRatio: fd.get('aspectRatio') || undefined, dueDate: fd.get('dueDate') || null,
      sources: fd.getAll('source'),
    };
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      if (state.form && state.form.mode === 'edit') {
        await post({ action: 'edit', briefId: state.form.id, ...brief });
      } else {
        const res = await post({ action: 'create', assistantId: state.assistantId, ...brief, generate: submitter === 'generate' });
        // The brief was saved even when its first round could not start — show why ON the brief, and
        // close the form, so pressing Save again cannot make a second copy.
        if (res.roundError && res.briefId) state.notes[res.briefId] = { text: errorText(res.roundError, 0), tone: 'error' };
      }
      state.form = null;
      await load();
    } catch (err) {
      form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      if (errEl) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
    }
  });

  // A brief created, or options decided, from the chat (chat-session.js).
  document.addEventListener('brief:changed', (e) => {
    const id = e.detail && e.detail.assistantId;
    if (!state.assistantId || Number(id) !== Number(state.assistantId)) return;
    load();
  });

  window.AssistantBriefs = {
    init({ assistantId }) {
      state.assistantId = assistantId;
      state.rendered = false;
      state.form = null;
      state.rejecting = null;
      state.notes = {};
      // Eager: the count drives the tab badge, visible from every tab.
      load();
    },
    /** Called on first activation of the tab. */
    activate() {
      if (state.rendered) return;
      state.rendered = true;
      render();
    },
  };
})();
