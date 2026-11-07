/**
 * src/components/assistant-videos.js
 * The Video Producer's Videos tab — docs/video-producer-plan.md §5.2–5.8.
 *
 * A video goes: brief → storyboard (planned in the background, free) → the owner checks every scene,
 * changes any, or plans it again with notes → "Make the video" (states the tasks first) → a finished
 * post in the Review Queue.
 *
 * Backed by netlify/functions/video-projects.ts — the SAME actions the chat cards call (chat-session.js
 * → video:create / video:replan), so the two can never disagree. Writes from the chat dispatch
 * `video:changed`, which reloads this tab.
 *
 * Spends only on "Make the video", whose button carries the cost. Nothing generates on load.
 * Handlers are bound to `document` once, at load, never from render. Server values are escaped.
 */
(function () {
  const API = '/.netlify/functions/video-projects';
  const POLL_MS = 5000;

  const SOURCE = {
    stock_video: 'Stock footage', stock_photo: 'Stock photo', product_photo: 'Your picture',
    brand_card: 'Branded card', ai_image: 'AI picture', ai_video: 'AI clip',
  };
  const BEAT = { hook: 'Hook', problem: 'Problem', value: 'Value', proof: 'Proof', cta: 'Call to action' };
  // Voices come from src/public/voice-catalogue.json through voice-picker.js — the list the server
  // speaks from — and are chosen by ear there. This is the default when setup named none.
  const DEFAULT_VOICE = 'british_woman';
  const WAITING = {
    planning: 'Writing the storyboard — about a minute.',
    planned: 'Storyboard ready. Check the scenes, then press “Make the video”.',
    building: 'Making the video — a few minutes. You can leave this page.',
    built: 'Made. It’s in the Review Queue waiting for your approval.',
    // Not a project status: a built project whose post then failed its final render (postRenderStatus).
    render_failed: 'Made, but the final render failed. Open it in the Review Queue to try the render again.',
    failed: 'Stopped.',
    cancelled: 'Cancelled.',
  };

  // Where a video came from (video_projects.origin, Phase 7). 'user' says nothing — the owner asked.
  const ORIGIN = {
    autopilot: 'Planned by autopilot',
    handoff: 'From one of your posts',
    campaign: 'For a campaign',
  };

  const state = {
    assistantId: null, assistantName: null, setup: {}, videos: [], loaded: false, loadError: null,
    rendered: false, form: false, editing: null, replanning: null, notes: {}, busy: new Set(), pollTimer: null,
    stage: null, userStage: false, opened: new Set(), full: false,
  };

  // Stages as pills, like the Brand Designer's Briefs (owner, 2026-11-06: the Briefs tab's patterns on
  // every assistant's work tab). "To check" is what waits for the owner, so the tab opens there.
  const STAGES = [
    { key: 'check', label: 'To check', statuses: ['planned', 'failed'], urgent: true },
    { key: 'making', label: 'Being made', statuses: ['planning', 'building'] },
    { key: 'made', label: 'Made', statuses: ['built'] },
    { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
  ];
  const inStage = (key) => {
    const st = STAGES.find((x) => x.key === key) || STAGES[0];
    return state.videos.filter((v) => st.statuses.includes(v.status));
  };
  // Videos start closed; the ones opened are remembered per assistant in this browser (as the Briefs are).
  // A new key: the old one listed the ones hidden.
  const foldKey = () => `bms-video-open:${state.assistantId}`;
  function loadFolded() {
    try { state.opened = new Set(JSON.parse(localStorage.getItem(foldKey()) || '[]').map(Number)); } catch { state.opened = new Set(); }
  }
  function saveFolded() {
    try { localStorage.setItem(foldKey(), JSON.stringify([...state.opened])); } catch { /* private window */ }
  }

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const host = () => document.getElementById('videos-host');
  const who = () => esc(state.assistantName || 'your Video Producer');

  async function call(method, body, query) {
    const res = await fetch(API + (query || ''), {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error === 'insufficient_credits'
        ? (data.unit === 'tasks'
          ? `Not enough tasks left this month: this video needs ${data.cost}, and ${data.balance} ${data.balance === 1 ? 'is' : 'are'} left. Change AI scenes to stock to use fewer.`
          : `You need ${data.cost} credits for this video and have ${data.balance}.`)
        : (data.message || data.error || `That didn’t work (HTTP ${res.status}).`);
      throw new Error(msg);
    }
    return data;
  }

  async function load() {
    try {
      const data = await call('GET', null, `?assistantId=${encodeURIComponent(state.assistantId)}`);
      state.videos = (data.projects || []).filter((p) => p.aiAssistantId == null || p.aiAssistantId === state.assistantId);
      state.loadError = null;
    } catch (err) {
      state.loadError = err.message;
    }
    state.loaded = true;
    updateBadge();
    if (state.rendered) render();
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (state.videos.some((v) => v.status === 'planning' || v.status === 'building')) state.pollTimer = setTimeout(load, POLL_MS);
  }

  function updateBadge() {
    const n = state.videos.filter((v) => v.status === 'planned').length;
    // The page's "Needs you" strip counts the same storyboards (assistants.js _renderNeedsYou 'videos').
    window._setNeedsYouCount?.(n);
    // The compact header's Needs-you card names the storyboards waiting (each opens its video).
    window._setNeedsYouItems?.(state.videos.filter((v) => v.status === 'planned').slice(0, 4)
      .map((v) => ({ id: v.id, label: v.title || 'Untitled video', sub: 'storyboard to check' })));
    const el = document.getElementById('videos-review-badge');
    if (!el) return;
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('hidden', n === 0);
    el.style.display = n === 0 ? 'none' : '';
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  // The form starts from the setup answers (assistant-onboarding-schemas.js video_producer) — the same
  // defaults the server fills for a brief that leaves them out (video-producer.ts withSetupDefaults).
  function setupDefaults() {
    const s = state.setup || {};
    return {
      lengthS: ['15', '30', '60'].includes(String(s.defaultLength)) ? String(s.defaultLength) : '30',
      voice: typeof s.defaultVoice === 'string' && s.defaultVoice ? s.defaultVoice : DEFAULT_VOICE,
      captions: s.defaultCaptions !== 'off' && s.defaultCaptions !== false,
      captionStyle: (() => {
        let c = s.captionStyle;
        if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = null; } }
        return c && typeof c === 'object' ? c : null;
      })(),
      allowAi: ['stock_and_ai', 'stock_only', 'ai_first'].includes(s.defaultAllowAi) ? s.defaultAllowAi : 'stock_and_ai',
      cta: typeof s.defaultCta === 'string' ? s.defaultCta : '',
    };
  }
  const sel = (on) => (on ? ' selected' : '');

  function formHtml() {
    if (!state.form) return '';
    const d = setupDefaults();
    return `
      <form data-vid-form class="bg-white border border-gray-200 rounded-xl p-4 mb-4 space-y-3">
        <p class="text-sm font-bold text-gray-900">New video</p>
        <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">What should it say?</span>
          <textarea name="message" rows="3" maxlength="1200" required class="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" placeholder="e.g. Our autumn menu is here — pumpkin spice latte and cinnamon buns, this week only."></textarea></label>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Length</span>
            <select name="lengthS" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2">${['15', '30', '60'].map((n) => `<option value="${n}"${sel(d.lengthS === n)}>${n} seconds</option>`).join('')}</select></label>
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Call to action (optional)</span>
            <input name="cta" maxlength="200" value="${esc(d.cta)}" class="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" placeholder="e.g. Pop in this week"></label>
          <div class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Voice</span>
            <input type="hidden" name="voice" value="${esc(d.voice)}">
            <div class="flex items-center gap-2 border border-gray-300 rounded-lg px-2 py-2">
              <span data-vid-voice-name class="flex-1 min-w-0 text-sm text-gray-800 truncate">${esc(window.VoicePicker?.describe(d.voice) || d.voice)}</span>
              <button type="button" data-vid-act="voice-listen" class="shrink-0 text-xs font-bold text-gray-600 hover:text-gray-900 cursor-pointer" aria-pressed="false">&#9654; Listen</button>
              <button type="button" data-vid-act="voice-choose" class="shrink-0 text-xs font-bold text-indigo-700 hover:underline cursor-pointer">Change</button>
            </div>
            <label class="mt-1 inline-flex items-center gap-1.5 text-xs text-gray-600"><input type="checkbox" name="noVoice"> No voiceover — on-screen text only</label>
            <p class="text-[11px] text-gray-500 mt-0.5">The script is written in your voice's language.</p></div>
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Pictures from</span>
            <select name="allowAi" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2"><option value="stock_and_ai"${sel(d.allowAi === 'stock_and_ai')}>Stock first, AI where it fits</option><option value="stock_only"${sel(d.allowAi === 'stock_only')}>Stock and my own pictures only</option><option value="ai_first"${sel(d.allowAi === 'ai_first')}>Lean on AI</option></select></label>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label class="inline-flex items-center gap-1.5 text-sm text-gray-700"><input type="checkbox" name="captions"${d.captions ? ' checked' : ''}> Captions that follow the voice</label>
          <span data-vid-cap-desc class="text-xs text-gray-500">${esc(window.CaptionStyle?.describe(d.captionStyle) || '')}</span>
          <button type="button" data-vid-act="caption-style" class="text-xs font-bold text-indigo-700 hover:underline cursor-pointer">Change the look</button>
          <input type="hidden" name="captionStyle" value="${esc(d.captionStyle ? JSON.stringify(d.captionStyle) : '')}">
        </div>
        <fieldset><legend class="text-xs font-bold text-gray-600 mb-1">Post it as</legend>
          <div class="flex flex-wrap gap-3 text-sm text-gray-700">
            <label class="inline-flex items-center gap-1.5"><input type="checkbox" name="platforms" value="instagram" checked> Instagram Reel</label>
            <label class="inline-flex items-center gap-1.5"><input type="checkbox" name="platforms" value="youtube"> YouTube Short</label>
            <label class="inline-flex items-center gap-1.5"><input type="checkbox" name="platforms" value="facebook"> Facebook Reel</label>
          </div></fieldset>
        <p class="text-xs text-gray-500">Planning the storyboard is free. You check every scene before anything is made.</p>
        <div class="flex flex-wrap gap-2">
          <button type="submit" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg">Plan this video</button>
          <button type="button" data-vid-act="close-form" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg">Cancel</button>
        </div>
        <p data-vid-form-msg class="hidden text-xs font-semibold text-red-600"></p>
      </form>`;
  }

  function sceneHtml(v, s, i) {
    const editable = v.status === 'planned' || v.status === 'failed';
    const thumb = v.sceneThumbs && v.sceneThumbs[s.id];
    const isVideo = s.source === 'stock_video' || s.source === 'ai_video';
    const media = thumb
      ? (isVideo ? `<video src="${esc(thumb)}" muted playsinline class="w-14 h-24 object-cover rounded-md bg-gray-100 shrink-0"></video>` : `<img src="${esc(thumb)}" alt="" class="w-14 h-24 object-cover rounded-md bg-gray-100 shrink-0">`)
      : `<div class="w-14 h-24 rounded-md bg-gray-100 shrink-0 flex items-center justify-center text-[10px] text-gray-400 text-center px-1">${esc(SOURCE[s.source] || s.source)}</div>`;
    const editing = state.editing && state.editing.id === v.id && state.editing.sceneId === s.id;
    if (editing) {
      return `
        <li class="border border-indigo-200 bg-indigo-50/40 rounded-lg p-3">
          <form data-vid-scene-form data-id="${v.id}" data-scene="${esc(s.id)}" class="space-y-2">
            <p class="text-xs font-bold text-gray-700">Scene ${i + 1} · ${esc(BEAT[s.beat] || s.beat)}</p>
            <label class="block"><span class="block text-[11px] font-bold text-gray-600">Voiceover</span>
              <textarea name="voiceover" rows="2" maxlength="240" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5">${esc(s.voiceover)}</textarea></label>
            <label class="block"><span class="block text-[11px] font-bold text-gray-600">On-screen text (optional)</span>
              <input name="onScreenText" maxlength="60" value="${esc(s.onScreenText || '')}" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5"></label>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label class="block"><span class="block text-[11px] font-bold text-gray-600">Picture from</span>
                <select name="source" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5">${Object.entries(SOURCE).filter(([k]) => k !== 'product_photo' || s.source === 'product_photo').map(([k, l]) => `<option value="${k}" ${k === s.source ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
              <label class="block"><span class="block text-[11px] font-bold text-gray-600">Search words / what to picture</span>
                <input name="keywords" maxlength="120" value="${esc(s.keywords || s.prompt || '')}" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5"></label>
            </div>
            <p class="text-[11px] text-gray-500">Changing a voiceover line re-records the voiceover when the video is made.</p>
            <div class="flex gap-2"><button type="submit" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg">Save scene</button>
              <button type="button" data-vid-act="cancel-edit" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">Cancel</button></div>
          </form>
        </li>`;
    }
    return `
      <li class="flex gap-3 border border-gray-200 rounded-lg p-2.5 bg-white">
        ${media}
        <div class="flex-1 min-w-0">
          <p class="text-[11px] font-bold text-gray-500">Scene ${i + 1} · ${esc(BEAT[s.beat] || s.beat)} · about ${esc(s.targetS)}s · ${esc(SOURCE[s.source] || s.source)}</p>
          ${s.voiceover ? `<p class="text-sm text-gray-900 mt-0.5 break-words">“${esc(s.voiceover)}”</p>` : ''}
          ${s.onScreenText ? `<p class="text-xs text-gray-600 mt-0.5 break-words"><span class="font-bold">On screen:</span> ${esc(s.onScreenText)}</p>` : ''}
          ${editable && chatPaneAvailable() ? `<button type="button" data-vid-act="select-scene" data-id="${v.id}" data-index="${i}" title="Ask ${who()} about this scene" class="mt-1 mr-3 text-xs font-bold text-indigo-700 hover:underline">🎯 Select</button>` : ''}
          ${editable ? `<button type="button" data-vid-act="edit-scene" data-id="${v.id}" data-scene="${esc(s.id)}" class="mt-1 text-xs font-bold text-indigo-700 hover:underline cursor-pointer">Change</button>` : ''}
        </div>
      </li>`;
  }

  function videoHtml(v) {
    const sb = v.storyboard;
    const busy = state.busy.has(v.id);
    const canMake = (v.status === 'planned' || v.status === 'failed') && sb && sb.scenes && sb.scenes.length >= 3;
    // The same figure the hold takes, in the workspace's unit (video-producer.ts buildEstimate).
    const unit = v.unit === 'credits' ? 'credit' : 'task';
    const cost = v.estimate == null ? '' : (v.estimate === 0 ? ' — free' : ` — uses ${v.estimate} ${unit}${v.estimate === 1 ? '' : 's'}`);
    const replanning = state.replanning === v.id;
    const note = state.notes[v.id];
    // Closed until opened (owner, 2026-11-06), and remembered in this browser.
    const folded = !state.opened.has(v.id) && !replanning && !(state.editing && state.editing.id === v.id);
    return `
      <article data-no-fold class="bg-white border border-gray-200 rounded-xl p-4" data-video="${v.id}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <button type="button" data-vid-act="fold" data-id="${v.id}" aria-expanded="${folded ? 'false' : 'true'}" title="${folded ? 'Show this video' : 'Hide this video'}"
              class="flex items-start gap-1.5 text-left text-sm font-bold text-gray-900 break-words cursor-pointer hover:text-gray-700">
              <svg class="w-4 h-4 mt-0.5 shrink-0 text-gray-400 transition-transform ${folded ? '-rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
              <span>${esc(v.title)}</span></button>
            <p class="text-xs text-gray-600 mt-0.5">${ORIGIN[v.origin] ? `${esc(ORIGIN[v.origin])} · ` : ''}${esc((v.brief && v.brief.lengthS) || '')}s · ${esc(WAITING[v.status === 'built' && v.postRenderStatus === 'failed' ? 'render_failed' : v.status] || v.status)}</p>
            ${v.note ? `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mt-1.5">${esc(v.note)}</p>` : ''}
            ${note ? `<p class="text-xs font-semibold mt-1.5 ${note.error ? 'text-red-600' : 'text-gray-700'}">${esc(note.text)}</p>` : ''}
          </div>
          ${chatPaneAvailable() ? `<button type="button" data-vid-act="talk" data-id="${v.id}" class="text-xs font-bold text-indigo-700 hover:underline shrink-0 whitespace-nowrap">Talk it through</button>` : ''}
          ${v.status === 'built' ? `<button type="button" data-vid-act="open-review" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg shrink-0">Open the Review Queue</button>` : ''}
        </div>
        ${folded ? '' : `<div data-vid-body>
        ${Array.isArray(v.changes) && v.changes.length && (v.status === 'planned' || v.status === 'failed')
          ? `<details class="mt-2"><summary class="text-xs text-gray-500 cursor-pointer">What ${who()} adjusted (${v.changes.length})</summary><ul class="list-disc ml-5 mt-1 text-xs text-gray-600">${v.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details>` : ''}
        ${sb && sb.scenes && sb.scenes.length ? `<ol class="mt-3 space-y-2">${sb.scenes.map((s, i) => sceneHtml(v, s, i)).join('')}</ol>` : ''}
        ${sb && sb.caption ? `<p class="text-xs text-gray-600 mt-2"><span class="font-bold">Caption:</span> ${esc(sb.caption)}</p>` : ''}
        ${replanning ? `
          <form data-vid-replan-form data-id="${v.id}" class="mt-3 space-y-2">
            <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">What should be different? (optional)</span>
              <textarea name="feedback" rows="2" maxlength="600" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" placeholder="e.g. More energy, and show the cinnamon buns first"></textarea></label>
            <div class="flex gap-2"><button type="submit" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg">Plan it again</button>
              <button type="button" data-vid-act="cancel-replan" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">Cancel</button></div>
          </form>` : ''}
        ${v.status !== 'cancelled' && v.status !== 'built' && v.status !== 'planning' && v.status !== 'building' ? `
          <div class="flex flex-wrap gap-2 mt-3">
            ${canMake ? `<button type="button" data-vid-act="build" data-id="${v.id}" ${busy ? 'disabled' : ''} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">Make the video${esc(cost)}</button>` : ''}
            ${!replanning ? `<button type="button" data-vid-act="replan" data-id="${v.id}" ${busy ? 'disabled' : ''} class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">Plan it again</button>` : ''}
            <button type="button" data-vid-act="cancel" data-id="${v.id}" ${busy ? 'disabled' : ''} class="btn-utility px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">Cancel</button>
          </div>` : ''}
        </div>`}
      </article>`;
  }

  /** The form's voice row, once the catalogue has loaded (its names come from there). */
  function paintFormVoice() {
    const f = host()?.querySelector('[data-vid-form]');
    const name = f?.querySelector('[data-vid-voice-name]');
    if (name && window.VoicePicker) name.textContent = window.VoicePicker.describe(f.elements.voice.value);
  }

  function render() {
    const el = host();
    if (!el) return;
    // Opens on "To check" while anything waits there. Until the user picks a stage themselves, an empty
    // stage gives way to the first one with something in it (the first paint can come before the load).
    if (!state.stage || (!state.userStage && !inStage(state.stage).length)) {
      state.stage = (STAGES.find((st) => inStage(st.key).length) || STAGES[0]).key;
    }
    const visible = inStage(state.stage);
    const stageLabel = (STAGES.find((st) => st.key === state.stage) || STAGES[0]).label;
    const anyOpen = visible.some((v) => state.opened.has(v.id));
    const pills = STAGES.map((st) => {
      const n = inStage(st.key).length;
      const on = st.key === state.stage;
      return `<button type="button" role="tab" aria-selected="${on ? 'true' : 'false'}" tabindex="${on ? 0 : -1}" data-vid-stage="${st.key}"
        class="flex-shrink-0 min-h-[44px] sm:min-h-0 text-sm whitespace-nowrap">${esc(st.label)}${window._tabPillCount(n, !!st.urgent)}</button>`;
    }).join('');
    const empty = state.stage === 'check'
      ? `No videos to check. Press “New video”, or tell ${who()} in chat what you’d like a video about.`
      : `No videos ${esc(stageLabel.toLowerCase())}.`;
    // The standard tab header and card (owner, 2026-11-07).
    const full = `<button type="button" data-vid-act="full" aria-pressed="${state.full ? 'true' : 'false'}" title="${state.full ? 'Back to the page (Esc)' : 'Use the whole screen for your videos and the chat'}" class="btn-secondary border min-h-[44px] sm:min-h-0 px-3 py-2 text-sm font-bold rounded-lg whitespace-nowrap">${state.full ? 'Exit full screen' : 'Full screen'}</button>`;
    el.innerHTML = `
      ${window._tabHead({ title: 'Videos', explain: 'video-videos', right: `${full}${state.form ? '' : window._tabNewBtn('New video', 'data-vid-act="new"')}` })}
      ${formHtml()}
      <div class="tab-card">
        <div class="tab-pillbar">
          <div role="tablist" aria-label="Videos by stage" class="stage-pills tab-scroller">${pills}</div>
          <div class="tab-pillbar-actions">${visible.length > 1 ? `<button type="button" data-vid-act="fold-all" class="tab-link">${anyOpen ? 'Hide all' : 'Show all'}</button>` : ''}</div>
        </div>
        <div class="px-4 pb-4 pt-2">
        ${!state.loaded ? '<p class="text-sm text-gray-500">Loading your videos…</p>'
          : state.loadError ? `<p class="text-sm text-red-600">Your videos couldn’t be loaded: ${esc(state.loadError)}</p>`
          : visible.length ? `<div class="space-y-4">${visible.map(videoHtml).join('')}</div>`
          : `<div class="text-center py-10 text-sm text-gray-500">${empty}</div>`}
        </div>
      </div>`;
  }

  // ── Full screen (as on the Briefs and Website tabs) ─────────────────────────────────────────────
  // The videos and the docked chat over the whole page; Exit full screen or Esc comes back.
  function setFull(on) {
    state.full = !!on;
    const box = document.getElementById('videos-layout') || host();
    if (box) box.toggleAttribute('data-videos-full', state.full);
    if (window.ScrollLock) { if (state.full) window.ScrollLock.lock('videos-full'); else window.ScrollLock.release('videos-full'); }
    if (!document.getElementById('videos-full-css')) {
      const css = document.createElement('style');
      css.id = 'videos-full-css';
      // z 60: over the top bar (50), under the voice and caption pop-ups (70) this tab opens.
      css.textContent = `[data-videos-full] { position: fixed; inset: 0; z-index: 60; background: #fff; overflow: auto; padding: 12px; }
        .chatpane-dock[data-videos-full].is-on > .chatpane-dock-col { top: 12px; height: calc(100vh - 24px); }`;
      document.head.appendChild(css);
    }
    render();
    host()?.querySelector('[data-vid-act="full"]')?.focus();
  }
  // An OPEN dialog takes Esc first. Not just "a dialog": the settings drawer is always in the page as one (inert while shut).
  const dialogOpen = () => [...document.querySelectorAll('[role="dialog"]')].some((d) => !d.inert && !d.hidden && d.getClientRects().length && getComputedStyle(d).visibility !== 'hidden');
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.full && !dialogOpen()) setFull(false);
  });

  // ── Actions ────────────────────────────────────────────────────────────────
  async function act(id, body, okText) {
    state.busy.add(id);
    state.notes[id] = { text: 'Working…' };
    render();
    try {
      await call('POST', body);
      state.notes[id] = okText ? { text: okText } : null;
    } catch (err) {
      state.notes[id] = { text: err.message, error: true };
    }
    state.busy.delete(id);
    await load();
  }

  document.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-vid-stage]');
    if (pill && host() && host().contains(pill)) {
      state.stage = pill.dataset.vidStage; state.userStage = true; render();
      host()?.querySelector(`[data-vid-stage="${state.stage}"]`)?.focus();
      return;
    }
    const b = e.target.closest('[data-vid-act]');
    if (!b || !host() || !host().contains(b)) return;
    const id = Number(b.dataset.id);
    switch (b.dataset.vidAct) {
      case 'new': state.form = true; render(); window.VoicePicker?.load().then(paintFormVoice).catch(() => {}); break;
      case 'voice-listen': window.VoicePicker?.play(b.closest('form')?.elements.voice?.value, b); break;
      case 'voice-choose': {
        const f = b.closest('form');
        window.VoicePicker?.open({ value: f?.elements.voice?.value, title: 'Choose the voice for this video', onSelect: (vid) => { if (f) { f.elements.voice.value = vid; f.elements.noVoice.checked = false; paintFormVoice(); } } });
        break;
      }
      case 'caption-style': {
        const f = b.closest('form');
        let cur = null;
        try { cur = JSON.parse(f?.elements.captionStyle?.value || 'null'); } catch { cur = null; }
        window.CaptionStyle?.open({ value: cur, onSave: (style) => {
          if (!f) return;
          f.elements.captionStyle.value = JSON.stringify(style);
          f.elements.captions.checked = true;
          const d = f.querySelector('[data-vid-cap-desc]'); if (d) d.textContent = window.CaptionStyle.describe(style);
        } });
        break;
      }
      case 'close-form': state.form = false; render(); break;
      case 'fold': {
        if (state.opened.has(id)) state.opened.delete(id); else state.opened.add(id);
        saveFolded(); render();
        host()?.querySelector(`[data-vid-act="fold"][data-id="${id}"]`)?.focus();
        break;
      }
      case 'fold-all': {
        const shown = inStage(state.stage);
        const anyOpen = shown.some((v) => state.opened.has(v.id));
        shown.forEach((v) => { if (anyOpen) state.opened.delete(v.id); else state.opened.add(v.id); });
        saveFolded(); render();
        break;
      }
      case 'full': setFull(!state.full); break;
      case 'talk': {
        const v = state.videos.find((x) => x.id === id);
        if (v) getChatDock()?.refer({ label: `Video “${v.title}”`, message: `About my video ${v.id} “${v.title}”.` });
        break;
      }
      case 'select-scene': {
        const v = state.videos.find((x) => x.id === id);
        const i = Number(b.dataset.index);
        const s = v && v.storyboard && v.storyboard.scenes[i];
        if (!s) break;
        const onScreen = s.onScreenText ? `, on screen “${s.onScreenText}”` : '';
        getChatDock()?.refer({
          label: `Scene ${i + 1} of “${v.title}”`,
          message: `About this scene of my video ${v.id} “${v.title}”: scene ${i + 1} (${BEAT[s.beat] || s.beat}), voiceover “${s.voiceover || ''}”${onScreen}, picture from ${SOURCE[s.source] || s.source}.`,
        });
        break;
      }
      case 'edit-scene': state.editing = { id, sceneId: b.dataset.scene }; render(); break;
      case 'cancel-edit': state.editing = null; render(); break;
      case 'replan': state.replanning = id; render(); break;
      case 'cancel-replan': state.replanning = null; render(); break;
      case 'build': act(id, { action: 'build', id }, 'Making the video — it lands in the Review Queue when it’s done.'); break;
      case 'cancel': act(id, { action: 'cancel', id }, null); break;
      case 'open-review': document.querySelector('[data-maintab="review-queue"]')?.click(); break;
    }
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (!host() || !host().contains(f)) return;
    if (f.matches('[data-vid-form]')) {
      e.preventDefault();
      const fd = new FormData(f);
      const voice = fd.get('noVoice') ? '' : String(fd.get('voice') || '');
      let captionStyle;
      try { captionStyle = JSON.parse(String(fd.get('captionStyle') || 'null')) || undefined; } catch { captionStyle = undefined; }
      const brief = {
        message: String(fd.get('message') || ''), lengthS: Number(fd.get('lengthS')), cta: String(fd.get('cta') || ''),
        voiceover: !!voice, voice: voice || undefined, allowAi: String(fd.get('allowAi') || 'stock_and_ai'),
        captions: !!fd.get('captions'), ...(captionStyle ? { captionStyle } : {}),
        platforms: fd.getAll('platforms').map(String),
      };
      const msg = f.querySelector('[data-vid-form-msg]');
      f.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      try {
        await call('POST', { action: 'create', assistantId: state.assistantId, brief });
        state.form = false;
        await load();
      } catch (err) {
        msg.textContent = err.message; msg.classList.remove('hidden');
        f.querySelectorAll('button').forEach((x) => { x.disabled = false; });
      }
    } else if (f.matches('[data-vid-scene-form]')) {
      e.preventDefault();
      const fd = new FormData(f);
      const source = String(fd.get('source'));
      const words = String(fd.get('keywords') || '');
      const patch = {
        voiceover: String(fd.get('voiceover') || ''), onScreenText: String(fd.get('onScreenText') || ''), source,
        ...(source === 'ai_image' || source === 'ai_video' ? { prompt: words } : { keywords: words }),
      };
      const id = Number(f.dataset.id);
      state.editing = null;
      act(id, { action: 'edit_scene', id, sceneId: f.dataset.scene, patch }, 'Scene saved.');
    } else if (f.matches('[data-vid-replan-form]')) {
      e.preventDefault();
      const id = Number(f.dataset.id);
      state.replanning = null;
      act(id, { action: 'replan', id, feedback: String(new FormData(f).get('feedback') || '') }, 'Planning it again — about a minute.');
    }
  });

  // A card approved in chat changes this list.
  document.addEventListener('video:changed', () => { if (state.assistantId) load(); });

  // ── The chat docked beside the videos (ChatPane.dock) ────────────────────────────────────────────
  // Owner, 2026-11-05: the Website tab's pane, for the Video Producer. As on the Briefs tab: one conversation
  // for the tab, and "Select" is a button on each scene rather than a mode.
  let chatDock = null;
  const chatPaneAvailable = () => !!window.ChatPane?.available?.() && !!state.assistantId;
  function getChatDock() {
    const el = host();
    if (!el || !chatPaneAvailable()) return null;
    if (chatDock && chatDock.connected()) return chatDock;
    chatDock = window.ChatPane.dock(el, {
      prefix: 'videos', storageKey: 'bms-video-chat-on',
      pane: () => ({
        assistantId: state.assistantId, assistantName: state.assistantName || 'your Video Producer', roleKey: 'video_producer',
        rememberKey: `bms-video-chat:${state.assistantId}`,
        placeholder: 'Ask for a video…',
        starterPrompts: ['Plan me a 30-second video about what we do.', 'Make the opening of my video grab attention.', 'What would make this video work better?'],
        composerRows: 3,
      }),
    });
    return chatDock;
  }

  window.AssistantVideos = {
    init({ assistantId, assistantName, setup }) {
      chatDock?.destroy();
      chatDock = null;
      state.assistantId = assistantId;
      state.assistantName = assistantName || null;
      state.setup = setup && typeof setup === 'object' ? setup : {};
      // A new view: the old full-screen box went with the old page, so only the lock is left to drop.
      if (state.full) { state.full = false; window.ScrollLock?.release('videos-full'); }
      state.rendered = false; state.form = false; state.editing = null; state.replanning = null; state.notes = {};
      state.stage = null; state.userStage = false;
      loadFolded();
      load();   // eager: the planned count is the tab badge
    },
    /** The assistant was renamed: this tab says the new name (assistants.js _assistantRenamed). */
    rename(name) { state.assistantName = name || state.assistantName; if (state.rendered) render(); },
    activate() {
      if (state.rendered) return;
      state.rendered = true;
      render();
      const dock = getChatDock();
      if (dock && dock.wanted()) dock.setOn(true, false);
    },
  };
})();
