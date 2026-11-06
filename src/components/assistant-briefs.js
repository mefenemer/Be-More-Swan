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
    unit: 'credits',
    aiAvailable: false,
    /** Null when AI video can be made here; otherwise why not, in words. */
    aiVideoUnavailable: null,
    /** Brief id whose "Add your own" panel is open, with its library list once loaded. */
    own: { briefId: null, library: null, error: null, selected: new Set(), busy: false, status: '' },
    /** What a new brief ticks — from the assistant's setup (all sources, or free ones only). */
    defaultSources: null,
    /** The workspace's picture guidelines; undefined until loaded, null if unreadable. */
    guidelines: undefined,
    /** What a flyer's empty contact, QR and offer fields start from (brand-briefs.ts list). */
    flyerDefaults: null,
    loaded: false,
    loadError: null,
    rendered: false,
    /** null | { mode: 'create', flyer? } | { mode: 'edit', id, flyer? }. `gen` changes when a flyer's
     *  words are redrafted, so render() does not carry the OLD typed words over the new ones. */
    form: null,
    /** Option id whose "Not this" reason picker is open. */
    rejecting: null,
    /** Brief ids with their per-brief message line, e.g. a refusal from the server. */
    notes: {},
    /** The brand kit, for the style panel; null until loaded or if unreadable. */
    brandKit: null,
    /** The open tab (TABS below). null until the first load picks the one that needs the user. */
    tab: null,
    /** The design open in the studio: { briefId, optionId }, optionId null while its options are being made. */
    studio: null,
    /** "Select" is on: the next option or brief clicked goes onto the chat's chip. */
    picking: false,
    pollTimer: null,
    /** The HTML each brief card and the toolbar were last painted with — what a poll diffs against. */
    painted: { cards: new Map(), toolbar: '' },
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const V = () => state.vocab || { purposes: [], aspectRatios: [], sources: [], rejectReasons: [], maxRounds: 6 };
  const sourceLabel = (k) => (k === 'own' ? (V().ownLabel || 'Your own')
    : k === 'flyer_layout' ? ((V().flyer && V().flyer.sourceLabel) || 'Flyer')
    : (V().sources.find((s) => s.key === k) || { label: k }).label);
  /** A printed flyer (docs/brand-designer-flyers-plan.md) — its own form, words and tiles. */
  const isFlyer = (b) => !!b && b.purpose === 'flyer';
  const paperLabel = (k) => ((V().flyer && V().flyer.paperSizes.find((p) => p.key === k)) || { label: k || 'A5' }).label.split(' — ')[0];
  const purposeLabel = (k) => (V().purposes.find((p) => p.key === k) || { label: k }).label;

  // ── Server ─────────────────────────────────────────────────────────────────
  // Actions that only read: they leave the shared GET cache alone (cached-fetch.js `bmsRead`).
  const READ_ACTIONS = new Set(['list', 'performance', 'calendar']);
  async function post(payload) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
      bmsRead: READ_ACTIONS.has(payload && payload.action),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(data, res.status));
    return data;
  }

  /** The credit refusal is a code, not a sentence — say it in words, with the numbers. */
  function errorText(data, status) {
    if (data && data.code === 'insufficient_credits' && data.unit === 'tasks') {
      return `Not enough tasks left this month: a round needs ${data.cost}, and ${data.balance} ${data.balance === 1 ? 'is' : 'are'} left. Edit the brief and untick AI images and video to use stock photos and branded cards, which use no extra tasks.`;
    }
    if (data && data.code === 'insufficient_credits') {
      return `Not enough AI credits: a round needs ${data.cost}, and ${data.balance} ${data.balance === 1 ? 'is' : 'are'} left this month. Edit the brief and untick AI images to use stock photos and branded cards, which are free.`;   // workspaces still on credits only
    }
    return (data && data.error) || `Request failed (HTTP ${status}).`;
  }

  /** `poll` — a background refresh while a round runs: repaint only what changed (see repaintChanged). */
  async function load({ poll = false } = {}) {
    if (!state.assistantId) return;
    try {
      const data = await post({ action: 'list', assistantId: state.assistantId });
      state.briefs = Array.isArray(data.briefs) ? data.briefs : [];
      state.vocab = data.vocab || null;
      state.credits = data.credits ?? null;
      state.unit = data.unit === 'tasks' ? 'tasks' : 'credits';
      state.aiAvailable = !!data.aiAvailable;
      state.aiVideoUnavailable = data.aiVideoUnavailable || null;
      state.defaultSources = Array.isArray(data.defaultSources) ? data.defaultSources : null;
      state.guidelines = data.guidelines === undefined ? undefined : data.guidelines;
      state.brandKit = data.brandKit || null;
      state.flyerDefaults = data.flyerDefaults || null;
      state.loadError = null;
    } catch (err) {
      console.error('[AssistantBriefs] load failed:', err);
      state.loadError = err.message;
    }
    state.loaded = true;
    if (poll && state.rendered) { updateBadge(); repaintChanged(); } else rerender();
    schedulePoll();
  }

  /** Poll only while a round is in flight. The server ends a stuck one, so this always stops. */
  function schedulePoll() {
    clearTimeout(state.pollTimer);
    const making = state.briefs.some((b) => b.status === 'generating');
    syncBusy(making);
    if (making) state.pollTimer = setTimeout(() => load({ poll: true }), POLL_MS);
  }

  /**
   * The house "working" spinner (dialogs.js bmsBusy) for as long as a round is being made — it is
   * refcounted, so this holds exactly ONE count and gives it back when the round ends, rather than
   * adding one per poll. Pressing "Make options" showed nothing at all before (2026-10-14).
   */
  function syncBusy(on) {
    if (on === !!state.busyHeld || typeof window.bmsBusy !== 'function') return;
    state.busyHeld = on;
    window.bmsBusy(on);
  }

  // ── Tab badge ──────────────────────────────────────────────────────────────
  /** Briefs with options waiting for a decision — the number the user is meant to bring down. */
  function updateBadge() {
    const el = document.getElementById('briefs-review-badge');
    if (!el) return;
    // A brief with every picture it needs chosen is finished — leftover options do not ask for anything.
    const n = state.briefs.filter((b) => b.options.some((o) => o.status === 'proposed') && b.status !== 'cancelled' && !progress(b).done).length;
    el.textContent = n > 99 ? '99+' : String(n);
    // The page's Needs-you strip counts the same briefs as this badge.
    window._setNeedsYouCount?.(n);
    window._setNextUp?.(nextUpLine());
    // The compact header's Needs-you card lists them, each opening its brief on "To review".
    window._setNeedsYouItems?.(inTab('review').slice(0, 3).map((b) => {
      const w = b.options.filter((o) => o.status === 'proposed').length;
      return { id: b.id, label: b.title || 'Untitled brief', sub: `${w} option${w === 1 ? '' : 's'} to choose from` };
    }));
    el.classList.toggle('hidden', n === 0);
    // `hidden` loses to inline-flex (equal specificity, later in style.css) — pin it inline too.
    el.style.display = n === 0 ? 'none' : '';
  }

  // ── Pieces ─────────────────────────────────────────────────────────────────
  // ── Tabs ───────────────────────────────────────────────────────────────
  // Left to right, the order a brief moves through, each named for where it is. Every brief is in exactly
  // one, and the count on each shows where the work is without opening it (owner, 2026-11-05).
  const TABS = [
    { key: 'todo', label: 'Not started', help: 'Ask for options on a brief to get it going.', empty: 'Nothing waiting to start. Press "New brief" to begin one.' },
    { key: 'making', label: 'Being made', help: 'Nothing to do here. Options move to "To review" when they are ready.', empty: 'Nothing is being made right now.' },
    { key: 'review', label: 'To review', help: 'Choose "Use this" on the one you like, or "Not this" and say why.', empty: 'Nothing is waiting for you to review.' },
    { key: 'approved', label: 'Approved', help: 'Finished, and in My Content for your assistants to use.', empty: 'Nothing approved yet.' },
    { key: 'archived', label: 'Archived', help: 'Briefs you stopped. Anything you had approved stays in My Content.', empty: 'Nothing archived.' },
  ];
  function tabOf(b) {
    if (b.status === 'cancelled') return 'archived';
    if (b.status === 'generating') return 'making';
    if (b.status === 'approved' || progress(b).done) return 'approved';
    return b.options.some((o) => o.status === 'proposed') ? 'review' : 'todo';
  }
  const inTab = (key) => state.briefs.filter((b) => tabOf(b) === key);
  function tabsHtml() {
    return `
      ${''/* Pills in a grey track, not underlined tabs (owner, 2026-11-06): the page's own tabs above are
         underlined, and these filter a list rather than move round the page. overflow-y is hidden inline:
         overflow-x:auto alone gave the row a stray vertical scrollbar. */}
      <div role="tablist" aria-label="Briefs by stage" class="inline-flex max-w-full gap-1 p-1 rounded-xl bg-gray-100 mb-4" style="overflow-x:auto;overflow-y:hidden" data-brief-tabs>
        ${TABS.map((t) => {
          const n = inTab(t.key).length;
          const on = state.tab === t.key;
          const urgent = t.key === 'review' && n > 0;
          return `<button type="button" role="tab" id="brief-tab-${t.key}" aria-selected="${on}" aria-controls="brief-tab-panel" tabindex="${on ? 0 : -1}" data-brief-tab="${t.key}"
            class="flex-shrink-0 min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-lg text-sm font-bold whitespace-nowrap transition ${on ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}">
            ${esc(t.label)} <span class="ml-1 inline-block min-w-[20px] px-1.5 rounded-full text-[11px] text-center ${urgent ? 'bg-amber-100 text-amber-900' : on ? 'bg-gray-100 text-gray-700' : 'bg-gray-200 text-gray-700'}">${n}</span>
          </button>`;
        }).join('')}
      </div>`;
  }
  function openTab(key, focus) {
    state.tab = key;
    render();
    if (focus) document.getElementById(`brief-tab-${key}`)?.focus();
  }

  function chip(b) {
    const base = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold border';
    const waiting = b.options.filter((o) => o.status === 'proposed').length;
    if (b.status === 'generating') return `<span class="${base} bg-emerald-50 text-emerald-800 border-emerald-200">Making options</span>`;
    if (b.status === 'cancelled') return `<span class="${base} bg-gray-50 text-gray-500 border-gray-200">Archived</span>`;
    if (b.status === 'approved') return `<span class="${base} bg-emerald-50 text-emerald-800 border-emerald-200">Approved</span>`;
    if (waiting) return `<span class="${base} bg-amber-50 text-amber-800 border-amber-200">Needs you</span>`;
    return `<span class="${base} bg-gray-50 text-gray-600 border-gray-200">Not started</span>`;
  }

  /** "What happens next" for the page's Needs-you strip. */
  function nextUpLine() {
    const making = state.briefs.find((b) => b.status === 'generating');
    if (making) return `${name()} is making options for “${making.title}” now.`;
    const due = state.briefs
      .filter((b) => b.status !== 'cancelled' && b.dueDate && !progress(b).done)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
    if (due) return `“${due.title}” is due ${new Date(`${due.dueDate}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}.`;
    return state.briefs.length ? 'Nothing is being made right now.' : `No briefs yet — press “New brief”, or tell ${name()} in chat what you need.`;
  }

  /** How many pictures this brief is for, and how many are chosen. */
  function progress(b) {
    const needed = Math.max(1, Number(b.picturesNeeded) || 1);
    const chosen = b.options.filter((o) => o.status === 'approved').length;
    return { needed, chosen, left: Math.max(0, needed - chosen), done: chosen >= needed };
  }

  /** What the pictures are for, in the campaign's words: its social posts, its articles, its emails. */
  function forWhat(b) {
    const noun = b.purpose === 'blog_header' ? 'articles' : b.purpose === 'email_header' ? 'emails' : 'social posts';
    return b.campaign ? `the campaign's ${noun}` : noun;
  }

  // ⚠️ Every line says how many are chosen OF how many, and says plainly when no more are needed.
  // "Use this" used to leave the user wondering how many more they had to pick (2026-10-14); a
  // campaign brief for 10 posts now offers options until 10 are chosen, then stops.
  function activityLine(b) {
    const waiting = b.options.filter((o) => o.status === 'proposed').length;
    const p = progress(b);
    if (b.status === 'generating') return `${name()} is making options now — usually under a minute. This page updates by itself.`;
    if (b.status === 'cancelled') return 'Cancelled. Anything you chose is still in your library.';
    if (p.done && isFlyer(b)) return 'Done — your flyer is ready to print. Need different words or a different photo? "Change this flyer" starts a new version with these words filled in.';
    if (p.done) {
      return p.needed > 1 || b.campaign
        ? `All ${p.needed} chosen — no more pictures are needed for ${forWhat(b)}.`
        : 'Done — you have chosen the picture this brief needs. Nothing else to do here.';
    }
    const tally = p.needed > 1 ? `${p.chosen} of ${p.needed} chosen for ${forWhat(b)} — ${p.left} more needed. ` : '';
    if (waiting) {
      // Fewer options here than pictures still needed: say where the rest come from.
      return waiting >= p.left
        ? `${tally}Choose ${p.left === 1 ? 'the one you like' : `${p.left} you like`} with "Use this".`
        : `${tally}Choose the ones you like with "Use this", then ask ${name()} for more options for the rest.`;
    }
    if (b.waitingOn) return `${tally}Waiting on ${b.waitingOn} to add their own — they use "Add your own" on this brief. Nothing is sent to them; tell them yourself.`;
    if (b.rounds > 0) return `${tally}Ask ${name()} for more options — the next round reads why you turned any down.`;
    return `${tally}Not started. Ask ${name()} for options when the brief says what you want.`;
  }


  /** The label on the round button states its cost before the click. */
  /** Why a paid source cannot run here, or null. The round skips it, so the label must not charge for it. */
  function sourceBlocked(key) {
    if (key === 'ai_image' && !state.aiAvailable) return 'not switched on for this workspace';
    if (key === 'ai_video' && state.aiVideoUnavailable) return state.aiVideoUnavailable;
    return null;
  }

  /** The assistant's own name — the button asks THEM, not a machine. */
  function name() { return state.assistantName || 'Your Brand Designer'; }

  // The button names who does the work; the cost sits on its own line under the buttons (owner,
  // 2026-10-14: "1 AI Credit" on the button itself read as part of the action's name).
  function roundButtonLabel(b) {
    if (b.purpose === 'flyer') return b.rounds > 0 ? 'Make different versions' : 'Make the flyer';
    return b.rounds > 0 ? `Ask ${name()} for more options` : `Ask ${name()} for options`;
  }

  /** What one round costs, stated before the click — in tasks under the single task allowance. */
  function roundCostLine(b) {
    const tasks = state.unit === 'tasks';
    const key = tasks ? 'tasks' : 'credits';
    const paid = b.sources.filter((k) => !sourceBlocked(k))
      .map((k) => V().sources.find((s) => s.key === k)).filter((s) => s && s[key]);
    const n = paid.reduce((sum, s) => sum + s[key], 0);
    if (!n) return tasks ? 'Each round uses no extra tasks — stock and branded options only.' : 'Each round is free — stock and branded options only.';
    return tasks
      ? `Each round uses ${n} task${n === 1 ? '' : 's'}, for the ${paid.map((s) => s.label).join(' and ')}. Stock photos and branded cards use none.`
      : `Each round uses ${n} AI credit${n === 1 ? '' : 's'}, for the ${paid.map((s) => s.label).join(' and ')}. Stock photos and branded cards are free.`;
  }

  const isVideoBrief = (b) => Array.isArray(b.sources) && b.sources.length > 0 && b.sources.every((s) => /video/.test(String(s)));
  /** What the studio can work on: a picture or flyer page still to be decided. A video has its own tools. */
  const canEdit = (o) => o.status === 'proposed' && !String(o.mimeType || '').startsWith('video/') && !!window.DesignStudio;

  function optionTile(b, o) {
    // A flyer page is the paper's shape, not the brief's photo shape.
    const ratio = o.flyer && o.width && o.height ? `${o.width} / ${o.height}` : String(b.aspectRatio || '1:1').replace(':', ' / ');
    const isVideo = String(o.mimeType || '').startsWith('video/');
    const img = o.url && isVideo
      ? `<video src="${esc(o.url)}" controls muted playsinline preload="metadata" class="w-full h-full object-cover"></video>`
      : o.url
      ? `<img src="${esc(o.url)}" alt="${esc(`${sourceLabel(o.source)} option for “${b.title || 'this brief'}”`)}" loading="lazy" class="w-full h-full object-cover">`
      : '<div class="w-full h-full flex items-center justify-center text-xs text-gray-500">No preview</div>';
    const credit = (o.source === 'stock' || o.source === 'stock_video' || o.source === 'flyer_layout') && o.attributionName
      ? `<p class="text-[11px] text-gray-500 mt-1 truncate">Photo by ${o.attributionUrl ? `<a href="${esc(o.attributionUrl)}" target="_blank" rel="noopener" class="underline">${esc(o.attributionName)}</a>` : esc(o.attributionName)} on Pexels</p>`
      : '';
    let actions = '';
    if (o.status === 'approved') {
      // Approved pictures go to My Content, which this page has no tab for — so say where, and link
      // it (review, 2026-10-22).
      actions = o.flyer
        ? `<p class="text-xs font-bold text-emerald-800 mt-2">✓ Print-ready PDF in your library</p>
           <div class="flex flex-wrap items-center gap-2 mt-1">
             ${o.contentAssetId ? `<a href="/.netlify/functions/content-asset-download?assetId=${encodeURIComponent(o.contentAssetId)}&inline=1" target="_blank" rel="noopener" class="btn-primary min-h-[44px] sm:min-h-0 inline-flex items-center px-3 py-1.5 text-xs font-bold rounded-lg">Print</a>` : ''}
             <button type="button" data-brief-library class="btn-swan-link min-h-[44px] sm:min-h-0 text-xs font-bold">See it in My Content</button>
           </div>`
        : `<p class="text-xs font-bold text-emerald-800 mt-2">✓ In your library · <button type="button" data-brief-library class="btn-swan-link text-xs font-bold">See it in My Content</button></p>`;
    } else if (state.rejecting === o.id) {
      actions = `
        <div class="mt-2 space-y-1" data-brief-reject-panel="${o.id}">
          <p class="text-[11px] font-bold text-gray-700">What is wrong with it?</p>
          <div class="flex flex-wrap gap-1">
            ${V().rejectReasons.map((r) => `<button type="button" data-brief-reject-reason="${esc(r.key)}" data-option="${o.id}"
              class="btn-secondary min-h-[44px] sm:min-h-0 px-2 py-1 border text-xs font-bold rounded-lg">${esc(r.label)}</button>`).join('')}
          </div>
          <input type="text" data-brief-reject-note="${o.id}" maxlength="300" placeholder="Or say why in your words" aria-label="Why not this one, in your words"
            class="w-full mt-1 px-2 py-1 border border-gray-200 rounded-lg text-base sm:text-xs">
          <button type="button" data-brief-reject-reason="other" data-brief-reject-own data-option="${o.id}" class="btn-primary min-h-[44px] sm:min-h-0 px-3 py-1 text-xs font-bold rounded-lg">Not this one</button>
          <button type="button" data-brief-reject-cancel class="btn-swan-link min-h-[44px] sm:min-h-0 px-1 py-1 text-xs font-bold">Keep it</button>
        </div>`;
    } else if (o.status === 'proposed' && b.status !== 'cancelled' && !progress(b).done) {
      actions = `
        <div class="flex gap-1 mt-2">
          <button type="button" data-brief-approve="${o.id}" class="btn-golive min-h-[44px] sm:min-h-0 flex-1 px-2 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50">${o.flyer ? 'Use this flyer' : 'Use this'}</button>
          <button type="button" data-brief-reject="${o.id}" class="btn-secondary min-h-[44px] sm:min-h-0 flex-1 px-2 py-1.5 border text-xs font-bold rounded-lg transition disabled:opacity-50">Not this</button>
        </div>`;
    }
    return `
      <div class="bg-white border ${o.status === 'approved' ? 'border-emerald-700' : 'border-gray-200'} rounded-xl p-2" data-brief-option="${o.id}" data-brief-option-brief="${b.id}">
        <div class="relative rounded-lg overflow-hidden bg-gray-100" style="aspect-ratio:${esc(ratio)}">${o.flyer && o.url
          ? `<button type="button" data-brief-preview="${o.id}" aria-label="${esc(`Preview ${o.prompt || 'this flyer'} larger`)}" class="block w-full h-full" style="cursor:zoom-in">${img}</button>`
          : img}</div>
        <p class="text-[11px] font-bold text-gray-600 mt-1">${o.flyer ? esc(o.prompt || 'Flyer') : esc(sourceLabel(o.source).replace(/s$/, ''))} · round ${o.round}</p>
        ${chatPaneAvailable() && !canEdit(o) ? `<button type="button" data-brief-select="${o.id}" data-brief="${b.id}" title="Ask ${esc(name())} about this one" class="btn-swan-link min-h-[44px] sm:min-h-0 text-xs font-bold mt-0.5">🎯 Select</button>` : ''}
        ${canEdit(o) ? `<button type="button" data-brief-open-studio="${o.id}" data-brief="${b.id}" class="btn-primary w-full min-h-[44px] sm:min-h-0 px-2 py-1.5 mt-1 text-xs font-bold rounded-lg">Open in editor</button>` : ''}
        ${o.flyer && o.url ? `<button type="button" data-brief-preview="${o.id}" class="btn-swan-link min-h-[44px] sm:min-h-0 text-xs font-bold mt-0.5">Preview</button>` : ''}
        ${o.flyer && o.flyer.lowResPhoto ? '<p class="text-[11px] text-amber-700 mt-1">This photo may look soft when printed — try a smaller paper size or another round.</p>' : ''}
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

  /**
   * "Add your own" (Phase 4): an upload, or anything already in the library — which is where a Canva
   * import lands, so this is also how a Canva design joins a brief. Uploads go through My Content's
   * own three steps (upload URL → R2 → content-assets, with its safety check), so a brief can never
   * hold a file the library would have refused.
   */
  function ownPanelHtml(b) {
    const o = state.own;
    if (o.briefId !== b.id) return '';
    const lib = o.library;
    return `
      <div class="mt-3 bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-3" data-brief-own-panel="${b.id}">
        <p class="text-xs font-bold text-gray-700"><span data-explain="brand-brief-own">Add your own</span></p>
        <label class="block text-xs text-gray-600">Upload a picture or video
          <input type="file" accept="image/*,video/*" data-brief-own-file="${b.id}" class="block mt-1 text-xs">
        </label>
        <p class="text-xs font-bold text-gray-600">…or choose from your library <span class="font-normal text-gray-500">(designs you imported from Canva are here too)</span></p>
        ${o.error ? `<p class="text-xs text-red-600">${esc(o.error)}</p>`
          : !lib ? '<p class="text-xs text-gray-500">Loading your library…</p>'
          : !lib.length ? '<p class="text-xs text-gray-500">Your library is empty.</p>'
          : `<div class="grid grid-cols-4 sm:grid-cols-6 gap-2 max-h-64 overflow-y-auto">${lib.map((a) => `
              <button type="button" data-brief-own-pick="${a.id}" title="${esc(a.name)}"
                class="relative rounded-lg overflow-hidden border-2 ${o.selected.has(a.id) ? 'border-emerald-700' : 'border-transparent'} bg-gray-100" style="aspect-ratio:1 / 1">
                ${a.url ? (a.assetType === 'video'
                  ? `<video src="${esc(a.url)}" muted preload="metadata" class="w-full h-full object-cover"></video>`
                  : `<img src="${esc(a.url)}" alt="" loading="lazy" class="w-full h-full object-cover">`)
                  : '<span class="text-[10px] text-gray-500">No preview</span>'}
                ${a.fromCanva ? '<span class="absolute bottom-0 left-0 right-0 bg-white/80 text-[10px] font-bold text-gray-700">Canva</span>' : ''}
              </button>`).join('')}</div>`}
        ${o.status ? `<p class="text-xs font-semibold text-gray-700">${esc(o.status)}</p>` : ''}
        <div class="flex gap-2">
          <button type="button" data-brief-own-add="${b.id}" ${o.selected.size && !o.busy ? '' : 'disabled'}
            class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Add ${o.selected.size || ''} to this brief</button>
          <button type="button" data-brief-own-close class="btn-utility px-3 py-1.5 text-xs font-bold rounded-lg">Close</button>
        </div>
      </div>`;
  }

  /**
   * Pictures-only briefs ASK about video rather than assume (owner, 2026-10-14: "it did not ask me
   * if I wanted any videos"). A campaign brief is created with picture sources, so this is where
   * the question gets asked. Adding a source is an ordinary brief edit; nothing is made until the
   * next round is asked for.
   */
  function videoOfferHtml(b) {
    if (b.status === 'generating' || (b.sources || []).some((k) => k === 'stock_video' || k === 'ai_video')) return '';
    const ai = V().sources.find((s) => s.key === 'ai_video');
    const aiOk = ai && !sourceBlocked('ai_video');
    return `
      <div class="mt-3 flex flex-wrap items-center gap-2 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2">
        <p class="text-xs text-gray-700 mr-auto">This brief makes pictures only. Would you like video options too?</p>
        <button type="button" data-brief-add-video="${b.id}" data-kind="stock_video"
          class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Add stock video (free)</button>
        ${aiOk ? `<button type="button" data-brief-add-video="${b.id}" data-kind="ai_video"
          class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Add AI video (${esc(state.unit === 'tasks' ? `${ai.tasks} tasks` : `${ai.credits} credits`)} a round)</button>` : ''}
      </div>`;
  }

  function briefCard(b) {
    const visible = b.options.filter((o) => o.status !== 'rejected');
    const rejected = b.options.length - visible.length;
    const note = state.notes[b.id];
    const flyer = isFlyer(b);
    const words = flyer && b.flyerContent && b.flyerContent.headline ? b.flyerContent : null;
    const meta = [purposeLabel(b.purpose), (Number(b.picturesNeeded) || 1) > 1 ? `${b.picturesNeeded} pictures` : '', flyer ? paperLabel(b.paperSize) : b.aspectRatio,
      flyer ? (b.sources.length ? `photo from ${b.sources.map(sourceLabel).join(' or ')}` : 'words only') : b.sources.map(sourceLabel).join(', '), b.dueDate ? `due ${b.dueDate}` : '', b.origin === 'chat' ? 'from chat' : '', b.origin === 'campaign' && !b.requestedBy ? 'from a campaign' : '', b.origin === 'assistant' && !b.requestedBy ? 'raised by your Social Media Assistant' : '']
      .filter(Boolean).map(esc).join(' · ');
    const live = b.status !== 'cancelled';
    const open = !isCollapsed(b.id);
    return `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5" data-brief-card="${b.id}">
        <div class="flex items-start justify-between gap-3">
          <button type="button" data-brief-toggle="${b.id}" aria-expanded="${open}" aria-controls="brief-body-${b.id}" class="min-w-0 flex items-start gap-2 text-left flex-1 rounded-lg -m-1 p-1 hover:bg-gray-50">
            <span aria-hidden="true" class="text-gray-500 text-xs mt-0.5 inline-block transition-transform" style="transform:rotate(${open ? 90 : 0}deg)">▶</span>
            <span class="min-w-0">
              <span class="block text-sm font-bold text-gray-900 break-words">${esc(b.title)}</span>
              <span class="block text-xs text-gray-500 mt-0.5">${meta}</span>
              <span class="sr-only">${open ? 'Hide details' : 'Show details'}</span>
            </span>
          </button>
          ${chip(b)}
        </div>
        ${b.requestedBy && window.rqRequestedPill ? `<div class="flex mt-1.5">${window.rqRequestedPill(b.requestedBy)}</div>` : ''}
        <div id="brief-body-${b.id}" data-brief-body="${b.id}" ${open ? '' : 'hidden'}>
        ${b.scheduledPostId ? '<p class="text-xs text-gray-700 mt-1">For a social post that found no picture — the one you approve goes onto that post if it still has none.</p>' : ''}
        ${b.campaign ? `<p class="text-xs text-gray-700 mt-1 break-words">For the campaign “${esc(b.campaign.objective)}” — the picture you approve joins that campaign's pictures.</p>` : ''}
        ${b.message ? `<p class="text-sm text-gray-700 mt-2 break-words">${esc(b.message)}</p>` : ''}
        ${b.headline && !flyer ? `<p class="text-xs text-gray-600 mt-1">Words on the card: <span class="font-bold">${esc(b.headline)}</span></p>` : ''}
        ${flyer ? (words
          ? `<p class="text-xs text-gray-600 mt-1">Headline: <span class="font-bold">${esc(words.headline)}</span>${progress(b).done ? '' : ` · <button type="button" data-brief-edit="${b.id}" class="btn-swan-link text-xs font-bold">Edit the words</button>`}</p>`
          : `<p class="text-xs text-amber-800 mt-1 font-semibold">No words yet — <button type="button" data-brief-edit="${b.id}" class="btn-swan-link text-xs font-bold">write or draft them</button> before asking for options.</p>`) : ''}
        <p class="text-xs text-gray-600 mt-2 flex items-center gap-2">${b.status === 'generating' && window.bmsSpinnerHtml ? window.bmsSpinnerHtml(14) : ''}<span>${esc(activityLine(b))}</span></p>
        ${b.generationNote ? `<p class="text-xs text-amber-700 mt-1">${esc(b.generationNote)}</p>` : ''}
        ${note ? `<p class="text-xs mt-1 ${note.tone === 'error' ? 'text-red-600' : 'text-emerald-800'} font-semibold">${esc(note.text)}</p>` : ''}
        ${visible.length ? `<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">${visible.map((o) => optionTile(b, o)).join('')}</div>` : ''}
        ${rejected ? `<p class="text-[11px] text-gray-500 mt-2">${rejected} turned down — the next round reads why.</p>` : ''}
        ${artDirectionHtml(b)}
        ${live ? ownPanelHtml(b) : ''}
        ${live ? `
          <div class="flex flex-wrap items-center gap-2 mt-4">
            ${progress(b).done ? '' : `<button type="button" data-brief-generate="${b.id}" ${b.status === 'generating' || b.rounds >= (b.maxRounds || V().maxRounds) || (flyer && !words) ? 'disabled' : ''}
              class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">${esc(roundButtonLabel(b))}</button>`}
            ${flyer ? '' : `<button type="button" data-brief-own-open="${b.id}"
              class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Add your own</button>`}
            <button type="button" data-brief-edit="${b.id}" ${b.status === 'generating' ? 'disabled' : ''}
              class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition disabled:opacity-50">${flyer && progress(b).done ? 'Change this flyer' : 'Edit brief'}</button>
            ${/* Flyers and pictures are talked through in the editor, with the chat beside it (owner 2026-11-06: the link
               duplicated the chat pane). A video has no editor, and with no docked chat this is the only way in. */
              isVideoBrief(b) || !chatPaneAvailable() ? `<button type="button" data-brief-chat="${b.id}"
              class="btn-swan-link min-h-[44px] sm:min-h-0 px-1 py-1.5 text-xs font-bold">Talk it through with ${esc(name())}</button>` : ''}
            <button type="button" data-brief-cancel="${b.id}" ${b.status === 'generating' ? 'disabled' : ''}
              class="btn-utility px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50">Archive brief</button>
          </div>
          ${progress(b).done ? '' : `<p class="text-[11px] text-gray-500 mt-1">${esc(flyer ? flyerCostLine(b) : roundCostLine(b))}</p>
          ${flyer ? '' : videoOfferHtml(b)}`}` : ''}
        </div>
      </div>`;
  }

  // ── Full screen (owner 2026-11-06: "like the Website assistant") ──────────────────────
  // The briefs and the docked chat over the whole page; the editor keeps its own Full screen inside it.
  function setFull(on) {
    state.full = !!on;
    const host = document.getElementById('briefs-host');
    const box = document.getElementById('briefs-layout') || host;
    if (box) box.toggleAttribute('data-briefs-full', state.full);
    if (window.ScrollLock) { if (state.full) window.ScrollLock.lock('briefs-full'); else window.ScrollLock.release('briefs-full'); }
    if (!document.getElementById('briefs-full-css')) {
      const css = document.createElement('style');
      css.id = 'briefs-full-css';
      css.textContent = `[data-briefs-full] { position: fixed; inset: 0; z-index: 10500; background: #fff; overflow: auto; padding: 12px; }
        .chatpane-dock[data-briefs-full].is-on > .chatpane-dock-col { top: 12px; height: calc(100vh - 24px); }`;
      document.head.appendChild(css);
    }
    render();
    document.querySelector('[data-brief-full]')?.focus();
  }

  // ── "Your brand style" in the profile's Brand Knowledge section (owner 2026-11-05: not above the briefs) ──
  // Added from here because init() only ever runs for a Brand Designer, so no other role's profile gets it.
  function mountProfileStyle() {
    const section = document.getElementById('tab-strategy');
    if (!section || !window.BrandStyleCard) return;
    let el = document.getElementById('module-brand-style');
    if (!el) {
      el = document.createElement('div');
      el.id = 'module-brand-style';
      el.className = 'bg-white rounded-2xl border border-gray-200 shadow-sm p-6 sm:p-8';
      section.prepend(el);
    }
    window.BrandStyleCard.mount(el, { assistantName: state.assistantName });
  }

  // ── "It is being made" pop-up (owner 2026-11-05: half see-through, over the page, not a screen of its own) ──
  function makingNotice(b) {
    const what = isFlyer(b) ? 'your flyer' : isVideoBrief(b) ? 'your video' : 'your pictures';
    showNotice(`${name()} is making ${what}. It will be under “To review” in about a minute, ready to open in the editor.`);
  }
  function showNotice(text) {
    document.getElementById('brief-notice')?.remove();
    const el = document.createElement('div');
    el.id = 'brief-notice';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:10600;max-width:min(420px,calc(100vw - 32px));'
      + 'background:rgba(17,24,39,0.5);color:#fff;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border-radius:16px;padding:18px 22px;'
      + 'font-size:15px;font-weight:700;line-height:1.4;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.2);cursor:pointer;text-shadow:0 1px 2px rgba(0,0,0,.4)';
    el.textContent = text;
    el.title = 'Click to close';
    el.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  // ── Show or hide a brief (owner 2026-11-05: every tab's briefs expandable/collapsible) ─────
  // Remembered per assistant in this browser. Open unless hidden; "Hide all" / "Show all" per tab.
  const collapseKey = () => `bms-briefs-collapsed-${state.assistantId}`;
  let collapsedIds = null;
  function collapsedSet() {
    if (collapsedIds) return collapsedIds;
    try { collapsedIds = new Set(JSON.parse(localStorage.getItem(collapseKey()) || '[]').map(Number)); }
    catch { collapsedIds = new Set(); }
    return collapsedIds;
  }
  const isCollapsed = (id) => collapsedSet().has(Number(id));
  function setCollapsed(ids, hide) {
    const set = collapsedSet();
    ids.forEach((id) => (hide ? set.add(Number(id)) : set.delete(Number(id))));
    try { localStorage.setItem(collapseKey(), JSON.stringify([...set].slice(-500))); } catch { /* private window */ }
  }

  /** A flyer round: the pages are drawn free; only an AI photo costs. Said before the click. */
  function flyerCostLine(b) {
    const ai = (b.sources || []).includes('ai_image') && !sourceBlocked('ai_image') ? V().sources.find((s) => s.key === 'ai_image') : null;
    const unit = state.unit === 'tasks' ? 'tasks' : 'credits';
    const n = ai ? ai[unit] : 0;
    return n
      ? `Each round draws up to three pages and uses ${n} ${unit === 'tasks' ? 'task' : 'AI credit'}${n === 1 ? '' : 's'}, for the AI photo. The pages themselves are free.`
      : 'Each round draws up to three pages and uses no extra tasks.';
  }

  function flyerFormHtml(editing) {
    const F = V().flyer || { paperSizes: [], limits: {}, defaultPaperSize: 'A5', photoSources: ['stock', 'ai_image'] };
    const L = F.limits || {};
    const v = editing || { title: '', message: '', paperSize: F.defaultPaperSize, sources: (state.defaultSources || ['stock']).filter((k) => F.photoSources.includes(k)), flyerContent: null };
    // A flyer with no words yet starts from the business's recorded details (last flyer, website, offer).
    const d = state.flyerDefaults || {};
    // No words yet on a saved flyer: its title starts as the headline, so Save works, and the user sees it to change.
    const c = v.flyerContent || { offer: d.offer || '', headline: editing ? (v.title || '') : '' };
    const contact = c.contact || d.contact || {};
    const qr = c.qr || (v.flyerContent ? {} : d.qr) || {};
    const points = (c.points || []).concat(['', '', '']).slice(0, L.points || 3);
    // A new key per redraft, so the words just drafted are not overwritten by the old typed ones.
    const k = (name) => `flyer-${state.form.gen || 0}-${name}`;
    const field = (label, inner, hint) => `
      <label class="block">
        <span class="text-xs font-bold text-gray-700">${label}</span>
        ${inner}
        ${hint ? `<span class="block text-[11px] text-gray-500 mt-0.5">${hint}</span>` : ''}
      </label>`;
    const input = (name, val, ph, max, extra = '') => `<input type="text" data-keep="${k(name)}" name="${name}" value="${esc(val || '')}" maxlength="${max || 200}" placeholder="${esc(ph)}" ${extra} class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">`;
    const words = !!(c.headline);
    const draftCost = state.unit === 'tasks' ? ' (1 task)' : '';
    return `
      <form data-flyer-form class="bg-white rounded-2xl border-2 border-emerald-200 shadow-sm p-5 mb-4 space-y-3">
        <p class="text-sm font-bold text-gray-900">${state.form.fork ? 'Change this flyer' : editing ? 'Edit brief' : 'New printed flyer'}</p>
        ${editing && !state.form.fork ? editKeepsMadeHtml(editing, true) : ''}
        ${state.form.fork ? '<p class="text-xs text-gray-600">This makes a new version. The flyer you approved stays in My Content until you delete it.</p>' : ''}
        <p class="text-xs text-gray-500">${esc(name())} draws the pages in your brand. When you approve one, a print-ready PDF goes into My Content — print it at home, or send it to a print shop.</p>
        ${field('Name', input('title', v.title, 'e.g. November open day flyer', 120))}
        ${field('What is the flyer for?', `<textarea data-keep="${k('message')}" name="message" maxlength="1000" rows="2" placeholder="e.g. Bring new local customers in for our first-visit offer — hand out at the farmers' market" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">${esc(v.message || '')}</textarea>`)}
        ${field('The look you want (optional)', input('mood', v.mood, 'e.g. bright and playful, pink and teal', 300), 'Colours or a feel. Leave it empty to use your brand colours.')}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${field('Paper', `<select data-keep="${k('paperSize')}" name="paperSize" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">
            ${F.paperSizes.map((p) => `<option value="${esc(p.key)}" ${p.key === (v.paperSize || F.defaultPaperSize) ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>`)}
          <fieldset>
            <legend class="text-xs font-bold text-gray-700">Photo</legend>
            <div class="mt-1 space-y-1">
              ${F.photoSources.map((key) => {
                const s = V().sources.find((x) => x.key === key) || { label: key, cost: '' };
                const off = sourceBlocked(key);
                return `<label class="flex items-start gap-2 text-sm ${off ? 'text-gray-500' : 'text-gray-700'}">
                  <input type="checkbox" data-keep="${k(`src-${key}`)}" name="source" value="${esc(key)}" ${(v.sources || []).includes(key) && !off ? 'checked' : ''} ${off ? 'disabled' : ''} class="mt-1">
                  <span>${key === 'stock' ? 'A stock photo' : 'An AI photo'} <span class="text-xs text-gray-500">— ${esc(off || s.cost)}</span></span>
                </label>`;
              }).join('')}
              <p class="text-[11px] text-gray-500">Untick both for a words-only flyer.</p>
            </div>
          </fieldset>
        </div>
        ${editing ? `
        <div class="border-t border-gray-200 pt-3 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs font-bold text-gray-700">The words on the flyer</p>
            <button type="submit" data-brief-submit="draft" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50">${words ? 'Redraft the words' : 'Draft the words for me'}${draftCost}</button>
          </div>
          ${words ? '' : '<p class="text-xs text-gray-600">Type them below, or have them drafted from what your business has recorded. Contact details are never made up — check them before you print.</p>'}
          ${field('Headline', input('headline', c.headline, 'e.g. Calm grooming for nervous cats', L.headline, 'required'))}
          ${field('Subheading (optional)', input('subheading', c.subheading, 'One sentence of detail', L.subheading))}
          ${points.map((p, i) => field(i === 0 ? 'Points (optional, up to three)' : '', input(`point${i}`, p, i === 0 ? 'e.g. Fear-free handling' : '', L.point))).join('')}
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${field('Offer (optional)', input('offer', c.offer, 'e.g. 20% off your first visit', L.offer), 'Only an offer you really run.')}
            ${field('Call to action (optional)', input('callToAction', c.callToAction, 'e.g. Book online or call us', L.callToAction))}
            ${field('Date or opening times (optional)', input('dateLine', c.dateLine, 'e.g. Saturday 15 November, 10am–2pm', L.dateLine))}
            ${field('Phone (optional)', input('phone', contact.phone, '', L.phone))}
            ${field('Email (optional)', input('email', contact.email, '', L.email))}
            ${field('Website (optional)', input('website', contact.website, '', L.website))}
            ${field('Address (optional)', input('address', contact.address, '', L.address))}
            ${field('QR code link (optional)', input('qrUrl', qr.url, 'e.g. your booking page', L.qrUrl), 'Leave empty for no QR code.')}
            ${field('Words beside the QR code (optional)', input('qrLabel', qr.label, 'e.g. Scan to book', L.qrLabel))}
          </div>
        </div>` : ''}
        <p class="text-xs text-red-600 font-semibold hidden" data-brief-form-error></p>
        <div class="flex flex-wrap gap-2">
          ${editing
            ? `<button type="submit" data-brief-submit="generate" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Save and make the flyer</button>
               <button type="submit" data-brief-submit="save" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Just save</button>`
            : `<button type="submit" data-brief-submit="draft" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Next: draft the words for me${draftCost}</button>
               <button type="submit" data-brief-submit="save" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Next: I'll write the words</button>`}
          <button type="button" data-brief-form-close class="btn-utility px-4 py-2 text-sm font-bold rounded-lg">Cancel</button>
        </div>
      </form>`;
  }

  /** What saving an edit does to what is already made (owner 2026-11-05 asked): nothing; the next round uses it. */
  function editKeepsMadeHtml(b, flyer) {
    const made = b && Array.isArray(b.options) ? b.options.filter((o) => o.status === 'proposed' || o.status === 'approved').length : 0;
    if (!made) return '';
    const what = flyer ? (made === 1 ? 'flyer page' : 'flyer pages') : (made === 1 ? 'option' : 'options');
    return `<p class="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2" data-brief-edit-keeps>Saving changes only this brief. The ${made} ${what} already made stay as they are${flyer ? ': change one with "Open in editor", or press "Save and make the flyer" for new pages from these words' : ', and the next options you ask for use these changes'}.</p>`;
  }

  function formHtml() {
    if (!state.form) return '';
    const editing = state.form.mode === 'edit' ? state.briefs.find((b) => b.id === state.form.id) : null;
    if (state.form.flyer || isFlyer(editing)) return flyerFormHtml(editing);
    const v = editing || { purpose: 'social_post', aspectRatio: '', sources: state.defaultSources || V().sources.map((s) => s.key) };
    const field = (label, inner, explain) => `
      <label class="block">
        <span class="text-xs font-bold text-gray-700"${explain ? ` data-explain="${explain}"` : ''}>${label}</span>
        ${inner}
      </label>`;
    const input = (name, val, ph, max) => `<input type="text" data-keep="brief-${name}" name="${name}" value="${esc(val || '')}" maxlength="${max}" placeholder="${esc(ph)}" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">`;
    return `
      <form data-brief-form class="bg-white rounded-2xl border-2 border-emerald-200 shadow-sm p-5 mb-4 space-y-3">
        <p class="text-sm font-bold text-gray-900">${editing ? 'Edit brief' : 'New brief'}</p>
        ${editKeepsMadeHtml(editing, false)}
        ${field('Name', input('title', v.title, 'e.g. Spring launch — hero image', 120))}
        ${field('What should it show, or say?', `<textarea data-keep="brief-message" name="message" maxlength="1000" rows="3" placeholder="e.g. A small team celebrating in a bright studio — the feeling of finally having time back" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">${esc(v.message || '')}</textarea>`)}
        ${field('Exact words for a branded card (optional)', input('headline', v.headline, 'e.g. Your Monday, sorted.', 120))}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${field('Mood (optional)', input('mood', v.mood, 'e.g. warm, calm, confident', 300))}
          ${field('Due (optional)', `<input type="date" data-keep="brief-dueDate" name="dueDate" value="${esc(v.dueDate || '')}" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">`)}
          ${field('Must include (optional)', input('mustInclude', v.mustInclude, 'e.g. a laptop, our pink', 500))}
          ${field('Must avoid (optional)', input('mustAvoid', v.mustAvoid, 'e.g. handshakes, suits', 500))}
          ${field('Someone on my team is making it (optional)', input('waitingOn', v.waitingOn, 'e.g. Sam (designer)', 120), 'brand-brief-own')}
          ${field('What is it for?', `<select data-keep="brief-purpose" name="purpose" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">
            ${V().purposes.filter((p) => p.key !== 'flyer' || !editing).map((p) => `<option value="${esc(p.key)}" ${p.key === v.purpose ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>`)}
          ${field('Shape', `<select data-keep="brief-aspectRatio" name="aspectRatio" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm">
            <option value="">Best for what it is for</option>
            ${V().aspectRatios.map((a) => `<option value="${esc(a.key)}" ${editing && a.key === v.aspectRatio ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select>`)}
        </div>
        <fieldset>
          <legend class="text-xs font-bold text-gray-700"><span data-explain="brand-brief-sources">Where options come from</span></legend>
          <div class="mt-1 space-y-1">
            ${V().sources.map((s) => {
              const off = sourceBlocked(s.key);
              return `<label class="flex items-start gap-2 text-sm ${off ? 'text-gray-500' : 'text-gray-700'}">
                <input type="checkbox" data-keep="brief-src-${esc(s.key)}" name="source" value="${esc(s.key)}" ${v.sources.includes(s.key) && !off ? 'checked' : ''} ${off ? 'disabled' : ''} class="mt-1">
                <span>${esc(s.label)} <span class="text-xs text-gray-500">— ${esc(off || s.cost)}</span></span>
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
    // Tasks: 1,000,000 means an uncapped plan, so there is no "left" worth showing.
    // One header row (owner, 2026-11-06): the title on the left, the buttons on the right, and the long
    // description gone (the ⓘ beside the title explains Briefs). What is left this month is a small badge,
    // and not shown at all where the page's own "Tasks this month" bar is already on screen above.
    const leftText = Number(state.credits).toLocaleString('en-GB');
    const allowanceShown = !!document.querySelector('.detail-v2 #detail-task-share:not(.hidden)');
    const creditsLabel = `${state.unit === 'tasks' ? 'Tasks left this month' : 'AI credits left this month'}: ${leftText}`;
    const credits = state.credits == null || (state.unit === 'tasks' && state.credits >= 1000000) || allowanceShown ? ''
      : `<span class="inline-flex items-center px-2 py-1 rounded-full bg-gray-100 text-[11px] font-semibold text-gray-600 whitespace-nowrap" title="${esc(creditsLabel)}">${esc(leftText)} ${state.unit === 'tasks' ? 'tasks' : 'credits'} left</span>`;
    return `
      <div class="flex items-center justify-between gap-3 mb-3" data-brief-toolbar>
        <h2 class="text-base font-bold text-gray-900 shrink-0"><span data-explain="brand-briefs">Briefs</span></h2>
        <div class="flex flex-wrap items-center justify-end gap-2">
          ${credits}
          ${''/* Select lives in the editor, where the design is changed (owner 2026-11-05): not beside New brief. */}
          ${chatPaneAvailable() && !chatIsOn() ? `<button type="button" data-brief-chat-toggle aria-pressed="false" title="Show the chat beside your briefs" class="btn-assistant border min-h-[44px] sm:min-h-0 px-3 py-2 text-sm font-bold rounded-lg transition">Chat with ${esc(name())}</button>` : ''}
          <button type="button" data-brief-full aria-pressed="${state.full ? 'true' : 'false'}" title="${state.full ? 'Back to the page (Esc)' : 'Use the whole screen for your briefs and the chat'}" class="btn-secondary border min-h-[44px] sm:min-h-0 px-3 py-2 text-sm font-bold rounded-lg">${state.full ? 'Exit full screen' : 'Full screen'}</button>
          ${state.form ? '' : `<button type="button" data-brief-new class="btn-primary min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition">New brief</button>`}
        </div>
      </div>`;
  }

  /**
   * What every round starts from: the brand kit and the picture guidelines, both changed in a pop-up here
   * (brand-style-dialog.js) or in chat, so nobody has to leave the Brand Designer to see or change them.
   */
  // "Your brand style" moved to the profile's Brand Knowledge section: src/components/brand-style-card.js.

  function emptyState() {
    return `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
        <p class="text-sm font-bold text-gray-700">No briefs yet</p>
        <p class="text-xs text-gray-500 mt-2">Press "New brief" and ${esc(state.assistantName || 'your Brand Designer')} will ask a few quick questions, or just say what you need in the chat. Once you have answered, it starts making the design and opens it here, to change and approve. Only an AI-made picture uses a task, and the question says so.</p>
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
      host.innerHTML = '<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center"><p class="text-sm text-gray-500">Loading briefs…</p></div>';
      return;
    }
    if (state.studio) { renderStudio(host); return; }
    closeStudioInstance();
    // The poll re-renders every few seconds while a round runs — carry typed values across it.
    const kept = {};
    host.querySelectorAll('[data-keep]').forEach((el) => { kept[el.dataset.keep] = el.type === 'checkbox' ? el.checked : el.value; });
    const keptNotes = {};
    host.querySelectorAll('[data-brief-reject-note]').forEach((el) => { keptNotes[el.dataset.briefRejectNote] = el.value; });

    // Opens on "To review" while anything waits there, else at the start of the row (owner, 2026-11-06: it
    // used to open on an empty "Not started" under "Needs you: 4"). Until the user picks a tab themselves, an
    // empty tab gives way to "To review" too, since the first paint can come before the briefs have loaded.
    if (!state.tab || (!state.userTab && !inTab(state.tab).length && inTab('review').length)) {
      state.tab = inTab('review').length ? 'review' : 'todo';
    }
    // The brief being watched is finished: follow it, rather than leaving an empty "Being made".
    if (state.tab === 'making' && !inTab('making').length && inTab('review').length) state.tab = 'review';
    const tab = TABS.find((t) => t.key === state.tab);
    const shown = inTab(state.tab);
    host.innerHTML = `
      ${toolbarHtml()}
      ${formHtml()}
      ${state.briefs.length || state.form ? tabsHtml() : ''}
      <div id="brief-tab-panel" role="tabpanel" aria-labelledby="brief-tab-${tab.key}" class="${state.picking ? 'brief-picking' : ''}">
        ${!state.briefs.length && !state.form ? emptyState() : shown.length ? `<div class="flex flex-wrap items-center justify-between gap-2 mb-3"><p class="text-xs text-gray-600">${esc(tab.help)}</p>${shown.length > 1 ? (shown.every((b) => isCollapsed(b.id))
          ? '<button type="button" data-brief-expand-all class="btn-swan-link min-h-[44px] sm:min-h-0 text-xs font-bold">Show all</button>'
          : '<button type="button" data-brief-collapse-all class="btn-swan-link min-h-[44px] sm:min-h-0 text-xs font-bold">Hide all</button>') : ''}</div>` : `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center"><p class="text-sm text-gray-600">${esc(tab.empty)}</p></div>`}
        <div class="space-y-4">${shown.map(briefCard).join('')}</div>
      </div>`;
    ensurePickCss();

    host.querySelectorAll('[data-keep]').forEach((el) => {
      if (!Object.prototype.hasOwnProperty.call(kept, el.dataset.keep)) return;
      if (el.type === 'checkbox') el.checked = kept[el.dataset.keep];
      else el.value = kept[el.dataset.keep];
    });
    host.querySelectorAll('[data-brief-reject-note]').forEach((el) => {
      if (keptNotes[el.dataset.briefRejectNote] != null) el.value = keptNotes[el.dataset.briefRejectNote];
    });
    state.painted.cards = new Map(state.briefs.map((b) => [b.id, briefCard(b)]));
    state.painted.toolbar = toolbarHtml();
  }

  /** The brief ids in the order render() lays them out — live first, then cancelled when shown. */
  // ── The studio ─────────────────────────────────────────────────────────
  // Making a design happens here; the tabs only say where a brief has got to (owner, 2026-11-05).
  let studioInstance = null;
  function closeStudioInstance() {
    if (studioInstance) { studioInstance.destroy(); studioInstance = null; }
  }
  const studioOptions = (b) => b.options.filter(canEdit).map((o) => ({ id: o.id, url: o.url, hasPhoto: !o.flyer || o.flyer.layout !== 'type_only' }));
  function renderStudio(host) {
    const b = state.briefs.find((x) => x.id === state.studio.briefId);
    if (!b) { state.studio = null; closeStudioInstance(); render(); return; }
    if (studioInstance && studioInstance.briefId === b.id && host.querySelector('[data-design-studio]')) {
      studioInstance.refreshThumbs();
      return;
    }
    closeStudioInstance();
    const first = state.studio.optionId || (b.options.filter(canEdit)[0] || {}).id;
    if (!first) {
      // Nothing to edit (still being made, or nothing came back): back to the brief on its tab, never a waiting screen.
      state.studio = null;
      state.tab = tabOf(b);
      render();
      return;
    }
    state.studio.optionId = first;
    studioInstance = window.DesignStudio.mount(host, {
      brief: b, optionId: first, assistantName: name(), chatAvailable: chatPaneAvailable(),
      options: () => studioOptions(state.briefs.find((x) => x.id === b.id) || b),
      post,
      onRefer: (ref) => chatRefer(ref),
      onClose: () => { state.studio = null; closeStudioInstance(); state.tab = tabOf(state.briefs.find((x) => x.id === b.id) || b); load(); },
      onMore: () => { state.tab = tabOf(b); render(); },
      onApprove: async (optionId) => {
        await post({ action: 'decide', optionId, decision: 'approve' });
        state.studio = null;
        closeStudioInstance();
        state.tab = 'approved';
        await load();
      },
    });
    studioInstance.briefId = b.id;
  }
  function openStudio(briefId, optionId) {
    state.picking = false;
    // Nothing to edit yet (it is still being made): the brief on its tab and a pop-up, never a waiting screen.
    const b = state.briefs.find((x) => x.id === briefId);
    if (b && !optionId && !b.options.some(canEdit)) {
      state.studio = null;
      closeStudioInstance();
      state.tab = tabOf(b);
      setCollapsed([b.id], false);
      render();
      if (b.status === 'generating') makingNotice(b);
      return;
    }
    state.studio = { briefId, optionId: optionId || null };
    render();
    document.getElementById('briefs-host')?.scrollIntoView({ block: 'start' });
  }

  function paintedOrder() {
    return inTab(state.tab).map((b) => String(b.id));
  }

  /**
   * The poll's repaint. render() replaces the whole tab, and every 4 s while a round ran that threw
   * away focus, the caret, scroll inside the grid and any video that was playing — on a phone the
   * keyboard closed mid-word (review, 2026-10-22). Only the cards whose HTML actually changed (the one
   * being made, as a rule) are swapped; the form, the guidelines and every other card are left alone.
   * A brief appearing, disappearing or changing section falls back to the full render.
   */
  function repaintChanged() {
    const host = document.getElementById('briefs-host');
    if (!host) return;
    if (state.studio) { render(); return; }
    const onScreen = Array.from(host.querySelectorAll('[data-brief-card]')).map((el) => el.dataset.briefCard);
    const wanted = paintedOrder();
    if (state.tab === 'making' && !wanted.length) { render(); return; }
    if (onScreen.length !== wanted.length || onScreen.some((id, i) => id !== wanted[i])) { render(); return; }

    const toolbar = toolbarHtml();
    if (toolbar !== state.painted.toolbar) {
      const el = host.querySelector('[data-brief-toolbar]');
      if (el) el.outerHTML = toolbar;
      state.painted.toolbar = toolbar;
    }
    const tabs = host.querySelector('[data-brief-tabs]');
    if (tabs) tabs.outerHTML = tabsHtml();
    for (const b of inTab(state.tab)) {
      const html = briefCard(b);
      if (state.painted.cards.get(b.id) === html) continue;
      state.painted.cards.set(b.id, html);
      const el = host.querySelector(`[data-brief-card="${b.id}"]`);
      if (!el) continue;
      // A half-typed "why not" note in this card survives the swap, as it does a full render.
      const notes = {};
      el.querySelectorAll('[data-brief-reject-note]').forEach((n) => { notes[n.dataset.briefRejectNote] = n.value; });
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const fresh = tpl.content.firstElementChild;
      fresh.querySelectorAll('[data-brief-reject-note]').forEach((n) => {
        if (notes[n.dataset.briefRejectNote] != null) n.value = notes[n.dataset.briefRejectNote];
      });
      el.replaceWith(fresh);
    }
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
    window.bmsBusy?.(true);
    try {
      await post({ action: 'generate', briefId });
      say(briefId, null);
      state.tab = 'making';
      // Stay on the Briefs tab, on "Being made", with a pop-up saying so (owner 2026-11-05: no waiting screen).
      const b = state.briefs.find((x) => x.id === briefId);
      setCollapsed([briefId], false);
      if (b) makingNotice(b);
    } catch (err) {
      say(briefId, err.message, 'error');
    } finally {
      window.bmsBusy?.(false);
    }
    // load() takes over the spinner (syncBusy) for as long as the round is in flight.
    await load();
  }

  document.addEventListener('click', async (e) => {
    if (!state.assistantId || !e.target.closest('#briefs-host')) return;
    const t = (sel) => e.target.closest(sel);

    // "Select" is on: this click chooses what to talk about, whatever it landed on.
    if (state.picking) {
      const onTool = t('[data-brief-pick]');
      const tile = t('[data-brief-option]');
      const card = t('[data-brief-card]');
      if (!onTool && (tile || card)) {
        e.preventDefault();
        e.stopPropagation();
        const b = state.briefs.find((x) => x.id === Number((tile || card).dataset.briefOptionBrief || (card && card.dataset.briefCard)));
        setPicking(false);
        if (!b) return;
        const o = tile && b.options.find((x) => x.id === Number(tile.dataset.briefOption));
        if (o) referOption(b, o); else referBrief(b);
        return;
      }
    }
    if (t('[data-brief-pick]')) { setPicking(!state.picking); return; }
    if (t('[data-brief-full]')) { setFull(!state.full); return; }
    const toggle = t('[data-brief-toggle]');
    if (toggle && !state.picking) {
      const id = Number(toggle.dataset.briefToggle);
      setCollapsed([id], !isCollapsed(id));
      render();
      document.querySelector(`[data-brief-toggle="${id}"]`)?.focus();
      return;
    }
    if (t('[data-brief-collapse-all]') || t('[data-brief-expand-all]')) {
      setCollapsed(inTab(state.tab).map((b) => b.id), !!t('[data-brief-collapse-all]'));
      render();
      return;
    }
    const toStudio = t('[data-brief-open-studio]');
    if (toStudio) { openStudio(Number(toStudio.dataset.brief), Number(toStudio.dataset.briefOpenStudio)); return; }
    if (t('[data-brief-studio-back]')) { state.studio = null; render(); return; }
    const tabBtn = t('[data-brief-tab]');
    if (tabBtn) { state.userTab = true; openTab(tabBtn.dataset.briefTab, false); return; }
    if (t('[data-brief-new]')) { startNewBrief(); return; }
    if (t('[data-brief-form-close]')) { state.form = null; render(); return; }
    if (t('[data-brief-reject-cancel]')) { state.rejecting = null; render(); return; }

    const ownOpen = t('[data-brief-own-open]');
    if (ownOpen) {
      state.own = { briefId: Number(ownOpen.dataset.briefOwnOpen), library: null, error: null, selected: new Set(), busy: false, status: '' };
      render();
      try { state.own.library = (await post({ action: 'list_library' })).assets || []; }
      catch (err) { state.own.error = err.message; }
      render();
      return;
    }
    if (t('[data-brief-own-close]')) { state.own = { briefId: null, library: null, error: null, selected: new Set(), busy: false, status: '' }; render(); return; }
    const pick = t('[data-brief-own-pick]');
    if (pick) {
      const id = Number(pick.dataset.briefOwnPick);
      if (state.own.selected.has(id)) state.own.selected.delete(id); else state.own.selected.add(id);
      render();
      return;
    }
    const ownAdd = t('[data-brief-own-add]');
    if (ownAdd) {
      await addOwn(Number(ownAdd.dataset.briefOwnAdd), [...state.own.selected]);
      return;
    }

    const edit = t('[data-brief-edit]');
    if (edit) {
      const id = Number(edit.dataset.briefEdit);
      const target = state.briefs.find((b) => b.id === id);
      // An approved flyer's PDF is already made and no more rounds run on its brief, so saving words
      // onto it would change nothing printed. `fork`: the form opens with its words, and saving makes
      // a new flyer brief instead. Nothing is created if they cancel.
      state.form = { mode: 'edit', id, flyer: isFlyer(target), fork: isFlyer(target) && progress(target).done, gen: Date.now() };
      render(); window.scrollTo?.({ top: 0, behavior: 'smooth' }); return;
    }

    const preview = t('[data-brief-preview]');
    if (preview) {
      const optionId = Number(preview.dataset.briefPreview);
      const pages = state.briefs.flatMap((b) => (b.options.some((o) => o.id === optionId) ? b.options : []))
        .filter((o) => o.flyer && o.url && o.status !== 'rejected');
      window.ImageLightbox?.open({ urls: pages.map((o) => o.url), index: pages.findIndex((o) => o.id === optionId) });
      return;
    }

    const gen = t('[data-brief-generate]');
    if (gen) { gen.disabled = true; await generateRound(Number(gen.dataset.briefGenerate)); return; }

    const cancel = t('[data-brief-cancel]');
    if (cancel) {
      const id = Number(cancel.dataset.briefCancel);
      const ok = await window.confirmModal('It moves to the Archived tab, and it cannot be started again. Options you have not approved are deleted. Anything already in your library stays.', {
        title: 'Archive this brief?', confirmLabel: 'Archive brief', cancelLabel: 'Keep it',
      });
      if (!ok) return;
      try { await post({ action: 'cancel', briefId: id }); } catch (err) { say(id, err.message, 'error'); }
      await load();
      return;
    }

    if (t('[data-brief-library]')) { window.loadView?.('my-content'); return; }
    if (t('[data-brief-chat-toggle]')) { setChatOn(!chatIsOn(), true); return; }
    const select = t('[data-brief-select]');
    if (select) {
      const b = state.briefs.find((x) => x.id === Number(select.dataset.brief));
      const o = b && b.options.find((x) => x.id === Number(select.dataset.briefSelect));
      if (!o) return;
      referOption(b, o);
      return;
    }
    const chat = t('[data-brief-chat]');
    if (chat) {
      const b = state.briefs.find((x) => x.id === Number(chat.dataset.briefChat));
      // With the docked chat here, talk it through there rather than in a pop-up.
      if (b && chatPaneAvailable()) { referBrief(b); return; }
      window.openAssistantChat?.({ assistantId: state.assistantId, draft: b ? `About the brief "${b.title}": ` : '' });
      return;
    }

    const addVideo = t('[data-brief-add-video]');
    if (addVideo) {
      const id = Number(addVideo.dataset.briefAddVideo);
      const b = state.briefs.find((x) => x.id === id);
      if (!b) return;
      addVideo.disabled = true;
      try {
        await post({ action: 'edit', briefId: id, sources: [...new Set([...(b.sources || []), addVideo.dataset.kind])] });
        say(id, `Added. Press "${roundButtonLabel(b)}" and the next round includes video.`);
      } catch (err) { say(id, err.message, 'error'); }
      await load();
      return;
    }

    const approve = t('[data-brief-approve]');
    if (approve) {
      approve.disabled = true;
      const optionId = Number(approve.dataset.briefApprove);
      const brief = state.briefs.find((b) => b.options.some((o) => o.id === optionId));
      try {
        const res = await post({ action: 'decide', optionId, decision: 'approve' });
        // Say how many are chosen OF how many, and plainly when no more are needed (2026-10-14).
        const needed = Number(res.needed) || 1;
        const chosen = Number(res.chosen) || 1;
        const tally = chosen >= needed
          ? (needed > 1 ? `All ${needed} chosen — no more are needed.` : 'That is all this brief needed, so you are done here.')
          : `${chosen} of ${needed} chosen — ${needed - chosen} more needed.`;
        const where = brief && isFlyer(brief) ? 'Made the print-ready PDF.' : brief && brief.campaign ? 'Added to the campaign and your library.' : 'Added to your library — every assistant can use it now.';
        // Where it went (a post it was for, or one of the campaign's posts) is the server's sentence.
        if (brief) say(brief.id, `${where} ${tally}${res.postNote ? ` ${res.postNote}` : ''}`);
        window.showToast?.(chosen >= needed ? 'Done — no more pictures needed for this brief.' : `${chosen} of ${needed} chosen.`, 'success');
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
      // Their own words, sent with the button under them (owner 2026-11-05: typed a reason, then nothing to press).
      if (reason.hasAttribute('data-brief-reject-own') && !note.trim()) {
        const box = document.querySelector(`[data-brief-reject-note="${optionId}"]`);
        if (box) { box.placeholder = 'Type why, or choose a reason above'; box.focus(); }
        return;
      }
      try {
        await post({ action: 'decide', optionId, decision: 'reject', reason: reason.dataset.briefRejectReason, note });
        state.rejecting = null;
      } catch (err) {
        if (brief) say(brief.id, err.message, 'error');
      }
      await load();
    }
  });

  async function addOwn(briefId, contentAssetIds) {
    state.own.busy = true;
    state.own.status = 'Adding…';
    render();
    try {
      const res = await post({ action: 'add_own', briefId, contentAssetIds });
      const n = (res.added || []).length;
      state.own = { briefId: null, library: null, error: null, selected: new Set(), busy: false, status: '' };
      say(briefId, n ? `Added ${n} — choose it below like any other option.` : 'Those are already on this brief.');
    } catch (err) {
      state.own.busy = false;
      state.own.status = '';
      state.own.error = err.message;
      render();
    }
    await load();
  }

  /** My Content's own upload: a presigned R2 URL, the PUT, then the library row (with its safety check). */
  async function uploadToLibrary(file) {
    const urlRes = await fetch('/.netlify/functions/content-upload-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ fileName: file.name, mimeType: file.type, fileSize: file.size }),
    });
    const u = await urlRes.json().catch(() => ({}));
    if (!urlRes.ok) throw new Error(u.error || 'Could not start the upload.');
    if (u.uploadUrl) {
      const put = await fetch(u.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!put.ok) throw new Error('The upload did not finish — please try again.');
    }
    const assetType = file.type.startsWith('video/') ? 'video' : 'image';
    const res = await fetch('/.netlify/functions/content-assets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ name: file.name, assetType, mimeType: file.type, fileSize: file.size, storageKey: u.storageKey }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not add it to your library.');
    if (data.rejected) throw new Error(data.asset?.rejectionReason || 'That file did not pass the safety check.');
    return data.asset.id;
  }

  // The one form: choosing a printed flyer swaps to its own fields (paper, words, contact details).
  document.addEventListener('change', (e) => {
    if (!e.target.matches || !e.target.matches('[data-brief-form] select[name="purpose"]')) return;
    if (e.target.value !== 'flyer' || !state.form || state.form.mode !== 'create') return;
    state.form = { mode: 'create', flyer: true, gen: Date.now() };
    render();
  });

  // The tabs' arrow keys, and Escape to stop selecting.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.picking) { setPicking(false); return; }
    // Esc leaves full screen, unless a dialog or the editor (which has its own full screen) is taking it.
    if (e.key === 'Escape' && state.full && !state.studio && !document.querySelector('[role="dialog"]')) { setFull(false); return; }
    const tab = e.target.closest && e.target.closest('[data-brief-tab]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const at = TABS.findIndex((t) => t.key === tab.dataset.briefTab);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    state.userTab = true;
    openTab(TABS[next].key, true);
  });

  document.addEventListener('change', async (e) => {
    const input = e.target.closest && e.target.closest('[data-brief-own-file]');
    if (!input || !input.files || !input.files[0]) return;
    const briefId = Number(input.dataset.briefOwnFile);
    const file = input.files[0];
    if (!/^(image|video)\//.test(file.type)) { state.own.error = 'Choose a picture or a video.'; render(); return; }
    state.own.busy = true;
    state.own.error = null;
    state.own.status = `Uploading ${file.name}…`;
    render();
    try {
      const id = await uploadToLibrary(file);
      await addOwn(briefId, [id]);
    } catch (err) {
      state.own.busy = false;
      state.own.status = '';
      state.own.error = err.message;
      render();
    }
  });

  /** The flyer form's words, in the shape normaliseFlyerContent reads. */
  function flyerContentFrom(fd) {
    const g = (n) => String(fd.get(n) || '').trim();
    if (!g('headline')) return null;
    return {
      headline: g('headline'), subheading: g('subheading'),
      points: [0, 1, 2].map((i) => g(`point${i}`)).filter(Boolean),
      offer: g('offer'), callToAction: g('callToAction'), dateLine: g('dateLine'),
      contact: { phone: g('phone'), email: g('email'), website: g('website'), address: g('address') },
      qr: g('qrUrl') ? { url: g('qrUrl'), label: g('qrLabel') } : null,
    };
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest && e.target.closest('[data-flyer-form]');
    if (!form || !state.assistantId) return;
    e.preventDefault();
    const submitter = e.submitter && e.submitter.dataset ? e.submitter.dataset.briefSubmit : 'save';
    const errEl = form.querySelector('[data-brief-form-error]');
    const fd = new FormData(form);
    const editing = state.form && state.form.mode === 'edit';
    const brief = {
      purpose: 'flyer', title: fd.get('title'), message: fd.get('message'), mood: fd.get('mood'), paperSize: fd.get('paperSize'),
      sources: fd.getAll('source'),
      // Only an edit carries words; an empty headline leaves the saved words as they were.
      ...(editing && flyerContentFrom(fd) ? { flyerContent: flyerContentFrom(fd) } : {}),
    };
    if (editing && submitter === 'generate' && !brief.flyerContent) {
      if (errEl) { errEl.textContent = 'Type a headline first: it is the main line on the flyer, for example "Launch party, 21 December".'; errEl.classList.remove('hidden'); }
      return;
    }
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      let id = editing ? state.form.id : null;
      if (editing && !state.form.fork) await post({ action: 'edit', briefId: id, ...brief });
      else { id = (await post({ action: 'create', assistantId: state.assistantId, ...brief })).briefId; state.tab = 'todo'; }
      if (submitter === 'draft') {
        if (errEl) { errEl.textContent = 'Drafting the words…'; errEl.classList.remove('hidden', 'text-red-600'); }
        try { await post({ action: 'draft_flyer_words', briefId: id }); }
        catch (err) { state.notes[id] = { text: err.message, tone: 'error' }; }
      }
      // Draft or "I'll write them": stay in the form, now editing, with the words to check.
      state.form = submitter === 'generate' ? null : { mode: 'edit', id, flyer: true, gen: Date.now() };
      await load();
      if (submitter === 'generate') await generateRound(id);
    } catch (err) {
      form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      if (errEl) { errEl.textContent = err.message; errEl.classList.add('text-red-600'); errEl.classList.remove('hidden'); }
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
      waitingOn: fd.get('waitingOn') || null,
    };
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      if (state.form && state.form.mode === 'edit') {
        await post({ action: 'edit', briefId: state.form.id, ...brief });
      } else {
        const res = await post({ action: 'create', assistantId: state.assistantId, ...brief, generate: submitter === 'generate' });
        state.tab = res.roundStarted ? 'making' : 'todo';
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
  // The questions finished and the design is being made (brief-from-chat.ts): go there.
  document.addEventListener('brief:openStudio', (e) => {
    const d = e.detail || {};
    if (!state.assistantId || Number(d.assistantId) !== Number(state.assistantId)) return;
    load().then(() => {
      if (!state.rendered) return;
      const b = state.briefs.find((x) => x.id === Number(d.briefId));
      // A video has no editor (its options are clips): show its brief where it is being made instead.
      if (b && isVideoBrief(b)) { state.studio = null; state.tab = tabOf(b); render(); return; }
      openStudio(Number(d.briefId), null);
    });
  });
  // "Open in editor" on that card, later on: only if it is this assistant's brief, which the list says.
  document.addEventListener('brief:openStudioAny', (e) => {
    const id = Number(e.detail && e.detail.briefId);
    const b = state.rendered ? state.briefs.find((x) => x.id === id) : null;
    if (!b) return;
    if (isVideoBrief(b)) { state.studio = null; state.tab = tabOf(b); render(); return; }
    openStudio(id, null);
  });
  // A chat card changed the open design.
  document.addEventListener('design:changed', (e) => {
    const d = e.detail || {};
    if (studioInstance) studioInstance.setDesign(Number(d.optionId), d.design, d.photoUrl);
    load();
  });

  document.addEventListener('brief:changed', (e) => {
    const id = e.detail && e.detail.assistantId;
    if (!state.assistantId || Number(id) !== Number(state.assistantId)) return;
    // A brief just saved from the chat: open the tab it landed on, so it does not seem to vanish.
    const known = new Set(state.briefs.map((b) => b.id));
    load().then(() => {
      const fresh = state.briefs.find((b) => !known.has(b.id));
      if (fresh && state.rendered) openTab(tabOf(fresh), false);
    });
  });

  // ── The chat docked beside the briefs (chat-pane.js) ─────────────────────────────────────────────
  // Owner, 2026-11-05: the Website tab's pane, for the Brand Designer. One conversation for the tab, because
  // it is a list of briefs and the chat already knows them all (buildBriefsSnapshot). "Select" is a button on
  // each option rather than a mode: there is nothing to pick from but the options, and this way it is there
  // at any scroll position, on a phone too. The layout is ChatPane.dock's.
  let chatDock = null;
  const chatPaneAvailable = () => !!window.ChatPane?.available?.() && !!state.assistantId;
  const chatIsOn = () => !!chatDock && chatDock.isOn();
  function getChatDock() {
    const host = document.getElementById('briefs-host');
    if (!host || !chatPaneAvailable()) return null;
    if (chatDock && chatDock.connected()) return chatDock;
    chatDock = window.ChatPane.dock(host, {
      prefix: 'briefs', storageKey: 'bms-brief-chat-on',
      onToggle: (on) => {
        // Only offered while the chat is closed: with it open beside the briefs the button says nothing.
        const bar = document.querySelector('[data-brief-toolbar]');
        if (bar) bar.outerHTML = toolbarHtml();
        state.painted.toolbar = toolbarHtml();
      },
      pane: () => ({
        assistantId: state.assistantId, assistantName: name(), roleKey: 'brand_designer',
        rememberKey: `bms-brief-chat:${state.assistantId}`,
        placeholder: 'Ask for a picture or a flyer…',
        starterPrompts: ['I need a picture for a post.', 'Make me a printed flyer.', 'Which of these options would you choose?'],
        composerRows: 3,
      }),
    });
    return chatDock;
  }
  function setChatOn(on, remember) { getChatDock()?.setOn(on, remember); }
  function chatRefer(ref) { getChatDock()?.refer(ref); }
  function referOption(b, o) {
    const what = o.flyer ? (o.prompt || 'Flyer') : sourceLabel(o.source).replace(/s$/, '');
    const about = o.prompt && !o.flyer ? `, showing: ${String(o.prompt).slice(0, 300)}` : '';
    chatRefer({
      label: `${what} on “${b.title}”`,
      message: `About this option on my brief ${b.id} “${b.title}”: option ${o.id} (${what}, round ${o.round}${about}).`,
    });
  }
  function referBrief(b) { chatRefer({ label: `Brief “${b.title}”`, message: `About my brief ${b.id} “${b.title}”.` }); }
  /** Opens the chat and says this for them. Nothing is spent: the reply is questions or a card to press. */
  function askChat(text, opts) { getChatDock()?.ask(text, opts); }
  /** One button for every kind of brief: the assistant's questions decide what it should be. */
  // One way in (owner 2026-11-05: "either the chat or one button"). The form only appears when the chat cannot run,
  // so a brief can still be made in an AI outage.
  function startNewBrief() {
    // A new conversation each time (owner 2026-11-05): it never carries on from the chat that was on screen.
    if (chatPaneAvailable()) { state.studio = null; closeStudioInstance(); askChat('I need a new brief.', { fresh: true }); render(); return; }
    state.form = { mode: 'create' };
    render();
  }
  function setPicking(on) {
    state.picking = !!on;
    render();
  }
  function ensurePickCss() {
    if (document.getElementById('brief-pick-css')) return;
    const css = document.createElement('style');
    css.id = 'brief-pick-css';
    css.textContent = `.brief-picking [data-brief-card], .brief-picking [data-brief-option] { cursor: pointer; }
      .brief-picking [data-brief-option]:hover, .brief-picking [data-brief-option]:focus-within { outline: 3px solid var(--color-emerald-700, #ff007f); outline-offset: 2px; border-radius: 8px; }
      .brief-picking [data-brief-card]:not(:has([data-brief-option]:hover)):hover { outline: 2px dashed var(--color-emerald-700, #ff007f); outline-offset: 2px; }`;
    document.head.appendChild(css);
  }

  window.AssistantBriefs = {
    init({ assistantId, assistantName }) {
      chatDock?.destroy();
      chatDock = null;
      if (state.full) setFull(false);
      state.assistantId = assistantId;
      state.assistantName = assistantName || null;
      collapsedIds = null;
      state.rendered = false;
      state.form = null;
      state.tab = null;
      state.userTab = false;
      state.picking = false;
      state.studio = null;
      closeStudioInstance();
      state.rejecting = null;
      state.notes = {};
      state.own = { briefId: null, library: null, error: null, selected: new Set(), busy: false, status: '' };
      // Eager: the count drives the tab badge, visible from every tab.
      load();
      mountProfileStyle();
    },
    /** The Needs-you card's buttons: the Briefs tab on "To review", one brief opened and in view. */
    openReview(briefId) {
      window._activateMainTab?.('briefs');
      if (briefId != null) setCollapsed([briefId], false);
      state.tab = 'review';
      state.rendered = true;
      render();
      if (briefId != null) {
        setTimeout(() => document.querySelector(`[data-brief-card="${Number(briefId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      }
    },
    /** Called on first activation of the tab. */
    activate() {
      if (state.rendered) return;
      state.rendered = true;
      render();
      const dock = getChatDock();
      if (dock && dock.wanted()) dock.setOn(true, false);
    },
  };
})();
