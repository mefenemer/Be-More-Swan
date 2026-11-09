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
 * Your own footage (docs/video-producer-footage-and-ai-plan.md §4): "Use my own footage" → pick or upload
 * videos, say what you want → the browser reads each new video (footage-reader.js) → "Review my footage"
 * (the only other spend: FOOTAGE_REVIEW_TASKS when a video is new to it) → what it saw and suggested
 * edits, each ticked → "Make the storyboard" from the ticked ones (free) → the usual storyboard.
 *
 * Spends only on "Make the video" and "Review my footage", whose buttons say so. Nothing generates on load.
 * Handlers are bound to `document` once, at load, never from render. Server values are escaped.
 */
(function () {
  const API = '/.netlify/functions/video-projects';
  const POLL_MS = 5000;

  const SOURCE = {
    stock_video: 'Stock footage', stock_photo: 'Stock photo', product_photo: 'Your picture',
    brand_card: 'Branded card', ai_image: 'AI picture', ai_video: 'AI clip', own_video: 'Your video',
  };
  const FOOTAGE_API = '/.netlify/functions/footage';
  /** What one footage review costs when a video is new to it (src/lib/footage.ts FOOTAGE_REVIEW_TASKS). */
  const REVIEW_TASKS = 2;
  const MAX_FOOTAGE = 10;
  const KIND = { cut: 'Cut', trim: 'Trim', reorder: 'Order', fill: 'Fill a gap', text: 'Words', sound: 'Sound', frame: 'Frame', other: 'Edit' };
  const mmss = (n) => { const t = Math.max(0, Math.floor(Number(n) || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const BEAT = { hook: 'Hook', problem: 'Problem', value: 'Value', proof: 'Proof', cta: 'Call to action' };
  // Voices come from src/public/voice-catalogue.json through voice-picker.js — the list the server
  // speaks from — and are chosen by ear there. This is the default when setup named none.
  const DEFAULT_VOICE = 'british_woman';
  const WAITING = {
    reviewing: 'Watching your footage — a minute or two. You can leave this page.',
    reviewed: 'Footage reviewed. Tick the edits you want, then press “Make the storyboard”.',
    planning: 'Writing the storyboard — about a minute.',
    planned: 'Storyboard ready. Check the scenes, then press “Make the video”.',
    building: 'Making the video — a few minutes. You can leave this page.',
    built: 'Made. It’s in the Review Queue waiting for your approval.',
    // Not a project status: built, and its finished file is still rendering (video-producer.ts renderFinishedVideo).
    rendering: 'Made — the finished video is rendering, a few minutes. Watch it in the Review Queue once it’s done.',
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
    // "Use my own footage": the form, the library's own videos, what is ticked, and files just added.
    footage: null,
  };

  // Stages as pills, like the Brand Designer's Briefs (owner, 2026-11-06: the Briefs tab's patterns on
  // every assistant's work tab). "To check" is what waits for the owner, so the tab opens there.
  const STAGES = [
    { key: 'check', label: 'To check', statuses: ['reviewed', 'planned', 'failed'], urgent: true },
    { key: 'making', label: 'Being made', statuses: ['reviewing', 'planning', 'building'] },
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
    if (state.videos.some((v) => v.status === 'reviewing' || v.status === 'planning' || v.status === 'building' || (v.status === 'built' && v.postRenderStatus === 'pending'))) state.pollTimer = setTimeout(load, POLL_MS);
  }

  function updateBadge() {
    const waits = (v) => v.status === 'planned' || v.status === 'reviewed';
    const n = state.videos.filter(waits).length;
    // The page's "Needs you" strip counts the same storyboards (assistants.js _renderNeedsYou 'videos').
    window._setNeedsYouCount?.(n);
    // The compact header's Needs-you card names the storyboards waiting (each opens its video).
    window._setNeedsYouItems?.(state.videos.filter(waits).slice(0, 4)
      .map((v) => ({ id: v.id, label: v.title || 'Untitled video', sub: v.status === 'reviewed' ? 'suggested edits to tick' : 'storyboard to check' })));
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

  // ── Your own footage ───────────────────────────────────────────────────────────
  // The form lists the workspace's own uploads (footage.ts ?list=1); new files can be added here and go
  // to the library like any upload. Prefill comes from a chat card (openFootage).
  function openFootageForm(prefill) {
    const p = prefill || {};
    state.form = false;
    state.footage = {
      videos: null, error: null, picked: new Set((p.assetIds || []).map(Number).filter(Boolean)), files: new Map(),
      progress: '', busy: false, message: p.message || '', lengthS: p.lengthS ? String(p.lengthS) : null,
      voiceover: p.voiceover === true, cta: p.cta || '',
    };
    render();
    host()?.querySelector('[data-vid-footage-form]')?.scrollIntoView({ block: 'nearest' });
    loadFootageList();
    window.VoicePicker?.load().then(paintFormVoice).catch(() => {});
  }

  async function loadFootageList() {
    const f = state.footage;
    if (!f) return;
    try {
      const r = await fetch(`${FOOTAGE_API}?list=1`, { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || j.error || `HTTP ${r.status}`);
      f.videos = j.videos || [];
      // A chat card may name a video that isn't an own upload: it simply isn't ticked.
      const own = new Set(f.videos.map((v) => v.id));
      f.picked = new Set([...f.picked].filter((id) => own.has(id)));
    } catch (err) { f.error = err.message; }
    if (state.footage === f) paintFootageList();
  }

  function footageListHtml() {
    const f = state.footage;
    if (f.error) return `<p class="text-sm text-red-600">Your videos couldn’t be loaded: ${esc(f.error)}</p>`;
    if (!f.videos) return '<p class="text-sm text-gray-500">Loading your videos…</p>';
    if (!f.videos.length) return '<p class="text-sm text-gray-500">No videos of your own yet. Add one above.</p>';
    return `<ul class="grid gap-2" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">${f.videos.map((v) => {
      const on = f.picked.has(v.id);
      const why = v.tooBig ? 'Over 500 MB' : (v.durationS > 300 ? 'Over 5 minutes' : '');
      return `<li><label class="block border ${on ? 'border-indigo-500 ring-2 ring-indigo-200' : 'border-gray-200'} rounded-lg overflow-hidden ${why ? 'opacity-60' : 'cursor-pointer'}">
        ${v.url ? `<video src="${esc(v.url)}#t=0.5" muted playsinline preload="metadata" class="w-full h-24 object-cover bg-gray-900"></video>` : '<div class="w-full h-24 bg-gray-100"></div>'}
        <span class="flex items-start gap-1.5 p-1.5 text-xs text-gray-800">
          <input type="checkbox" data-vid-footage-pick="${v.id}" ${on ? 'checked' : ''} ${why ? 'disabled' : ''} class="mt-0.5">
          <span class="min-w-0"><span class="block truncate font-bold">${esc(v.name)}</span>
          <span class="block text-gray-500">${v.durationS ? mmss(v.durationS) : ''}${why ? ` · ${esc(why)}` : (v.reviewedBefore ? ' · already reviewed' : '')}</span></span>
        </span></label></li>`;
    }).join('')}</ul>`;
  }
  function paintFootageList() {
    const el = host()?.querySelector('[data-vid-footage-list]');
    if (el && state.footage) el.innerHTML = footageListHtml();
    paintFootageCost();
  }
  /** "Review my footage — uses 2 tasks", or free when every ticked video was reviewed before. */
  function paintFootageCost() {
    const f = state.footage;
    const btn = host()?.querySelector('[data-vid-footage-go]');
    if (!f || !btn) return;
    const picked = [...f.picked];
    const known = new Map((f.videos || []).map((v) => [v.id, v]));
    const fresh = picked.some((id) => !(known.get(id) && known.get(id).reviewedBefore));
    btn.textContent = `Review my footage${picked.length ? (fresh ? ` — uses ${REVIEW_TASKS} tasks` : ' — free') : ''}`;
    btn.disabled = f.busy || !picked.length;
  }

  function footageFormHtml() {
    const f = state.footage;
    if (!f) return '';
    const d = setupDefaults();
    const len = f.lengthS || d.lengthS;
    return `
      <form data-vid-footage-form class="bg-white border border-gray-200 rounded-xl p-4 mb-4 space-y-3">
        <p class="text-sm font-bold text-gray-900">Make a video from your own footage</p>
        <p class="text-xs text-gray-600">${who()} watches your videos, tells you what it sees, and suggests edits for the video you want. You tick the ones you like, then check the storyboard before anything is made. Videos up to 5 minutes and 500 MB, up to ${MAX_FOOTAGE} at a time.</p>
        <div class="flex flex-wrap items-center gap-2">
          <label class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer">Add a video
            <input type="file" accept="video/mp4,video/quicktime,video/webm" multiple hidden data-vid-footage-file></label>
          <span class="text-xs text-gray-500">or tick videos already in your library:</span>
        </div>
        <div data-vid-footage-list>${footageListHtml()}</div>
        <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">What video do you want?</span>
          <textarea name="message" rows="3" maxlength="1200" required class="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" placeholder="e.g. A 30-second Reel announcing our autumn menu. End on the booking link.">${esc(f.message)}</textarea></label>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Length</span>
            <select name="lengthS" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2">${['15', '30', '60'].map((n) => `<option value="${n}"${sel(len === n)}>${n} seconds</option>`).join('')}</select></label>
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Call to action (optional)</span>
            <input name="cta" maxlength="200" value="${esc(f.cta || d.cta)}" class="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" placeholder="e.g. Book online"></label>
        </div>
        <fieldset><legend class="text-xs font-bold text-gray-600 mb-1">Sound</legend>
          <label class="flex items-start gap-1.5 text-sm text-gray-700"><input type="radio" name="sound" value="own" ${f.voiceover ? '' : 'checked'} class="mt-1"> Keep the sound in my videos <span class="text-xs text-gray-500 mt-0.5">— what people say is captioned</span></label>
          <label class="flex items-start gap-1.5 text-sm text-gray-700 ml-5 mt-1"><input type="checkbox" name="tighten" checked class="mt-1"> Tighten my clips <span class="text-xs text-gray-500 mt-0.5">— cut pauses, “um”s and repeated takes. You can keep any scene as filmed.</span></label>
          <label class="flex items-start gap-1.5 text-sm text-gray-700 mt-1"><input type="radio" name="sound" value="voice" ${f.voiceover ? 'checked' : ''} class="mt-1"> Add a voiceover instead</label>
          <div class="flex items-center gap-2 border border-gray-300 rounded-lg px-2 py-2 mt-1 ml-5">
            <input type="hidden" name="voice" value="${esc(d.voice)}">
            <span data-vid-voice-name class="flex-1 min-w-0 text-sm text-gray-800 truncate">${esc(window.VoicePicker?.describe(d.voice) || d.voice)}</span>
            <button type="button" data-vid-act="voice-listen" class="shrink-0 text-xs font-bold text-gray-600 hover:text-gray-900 cursor-pointer">&#9654; Listen</button>
            <button type="button" data-vid-act="voice-choose" class="shrink-0 text-xs font-bold text-indigo-700 hover:underline cursor-pointer">Change</button>
          </div>
        </fieldset>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label class="inline-flex items-center gap-1.5 text-sm text-gray-700"><input type="checkbox" name="captions"${d.captions ? ' checked' : ''}> Captions</label>
          <span data-vid-cap-desc class="text-xs text-gray-500">${esc(window.CaptionStyle?.describe(d.captionStyle) || '')}</span>
          <button type="button" data-vid-act="caption-style" class="text-xs font-bold text-indigo-700 hover:underline cursor-pointer">Change the look</button>
          <input type="hidden" name="captionStyle" value="${esc(d.captionStyle ? JSON.stringify(d.captionStyle) : '')}">
        </div>
        <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Where it can't use your footage</span>
          <select name="allowAi" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2"><option value="stock_only"${sel(d.allowAi === 'stock_only')}>Stock footage and branded cards</option><option value="stock_and_ai"${sel(d.allowAi !== 'stock_only')}>Stock, branded cards, or AI where it fits</option></select></label>
        <fieldset><legend class="text-xs font-bold text-gray-600 mb-1">Post it as</legend>
          <div class="flex flex-wrap gap-3 text-sm text-gray-700">
            <label class="inline-flex items-center gap-1.5"><input type="checkbox" name="platforms" value="instagram" checked> Instagram Reel</label>
            <label class="inline-flex items-center gap-1.5"><input type="checkbox" name="platforms" value="youtube"> YouTube Short</label>
            <label class="inline-flex items-center gap-1.5"><input type="checkbox" name="platforms" value="facebook"> Facebook Reel</label>
          </div></fieldset>
        <label class="flex items-start gap-1.5 text-sm text-gray-700"><input type="checkbox" name="consent" required class="mt-1"> I have permission to use the people and music in these videos.</label>
        <p class="text-xs text-gray-500">Reviewing a video ${who()} hasn’t seen before uses ${REVIEW_TASKS} tasks; videos it has already reviewed are free. Your videos are never changed — edits only go into the new video.</p>
        <p data-vid-footage-progress class="text-xs font-semibold text-gray-700" role="status">${esc(f.progress)}</p>
        <div class="flex flex-wrap gap-2">
          <button type="submit" data-vid-footage-go class="btn-primary px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">Review my footage</button>
          <button type="button" data-vid-act="close-footage" class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg">Cancel</button>
        </div>
        <p data-vid-form-msg class="hidden text-xs font-semibold text-red-600"></p>
      </form>`;
  }

  async function addFootageFiles(files) {
    const f = state.footage;
    if (!f) return;
    const msg = host()?.querySelector('[data-vid-footage-form] [data-vid-form-msg]');
    for (const file of files) {
      if (f.picked.size >= MAX_FOOTAGE) break;
      f.progress = `Uploading ${file.name}…`; paintProgress();
      try {
        const a = await window.FootageReader.upload(file);
        f.files.set(a.id, file);       // read from the file itself — no download needed
        f.picked.add(a.id);
        (f.videos = f.videos || []).unshift({ id: a.id, name: a.name, durationS: null, url: URL.createObjectURL(file), needsReading: true, analysed: false });
      } catch (err) {
        if (msg) { msg.textContent = err.message; msg.classList.remove('hidden'); }
      }
    }
    f.progress = '';
    paintProgress(); paintFootageList();
  }
  function paintProgress() {
    const el = host()?.querySelector('[data-vid-footage-progress]');
    if (el && state.footage) el.textContent = state.footage.progress;
  }

  async function submitFootage(form) {
    const f = state.footage;
    const fd = new FormData(form);
    const msg = form.querySelector('[data-vid-form-msg]');
    const fail = (text) => { msg.textContent = text; msg.classList.remove('hidden'); f.busy = false; f.progress = ''; paintProgress(); paintFootageCost(); };
    msg.classList.add('hidden');
    const ids = [...f.picked];
    if (!ids.length) return fail('Tick at least one video, or add one.');
    if (!fd.get('consent')) return fail('Tick that you have permission to use the people and music in these videos.');
    f.busy = true; paintFootageCost();
    try {
      // Each video new to the Video Producer is read here first (footage-reader.js), once.
      const st = await fetch(`${FOOTAGE_API}?ids=${ids.join(',')}`, { credentials: 'same-origin' }).then((r) => r.json());
      const need = (st.status || []).filter((x) => x.needsReading).map((x) => x.assetId);
      for (let i = 0; i < need.length; i++) {
        const id = need[i];
        const v = (f.videos || []).find((x) => x.id === id);
        const label = need.length > 1 ? `Video ${i + 1} of ${need.length}: ` : '';
        await window.FootageReader.prepare(id, f.files.get(id) || (v && v.url), { onProgress: (t) => { f.progress = label + t; paintProgress(); } });
      }
      f.progress = 'Sending it to be reviewed…'; paintProgress();
      const voice = fd.get('sound') === 'voice' ? String(fd.get('voice') || '') : '';
      let captionStyle;
      try { captionStyle = JSON.parse(String(fd.get('captionStyle') || 'null')) || undefined; } catch { captionStyle = undefined; }
      const brief = {
        message: String(fd.get('message') || ''), lengthS: Number(fd.get('lengthS')), cta: String(fd.get('cta') || ''),
        voiceover: !!voice, voice: voice || undefined, allowAi: String(fd.get('allowAi') || 'stock_only'),
        captions: !!fd.get('captions'), ...(captionStyle ? { captionStyle } : {}),
        platforms: fd.getAll('platforms').map(String), footageAssetIds: ids, footageConsent: true,
        tighten: !!fd.get('tighten'),
      };
      await call('POST', { action: 'create', assistantId: state.assistantId, brief });
      state.footage = null;
      state.stage = 'making'; state.userStage = true;
      await load();
    } catch (err) {
      fail(err.message);
    }
  }

  /** What was seen and the suggested edits, with the owner's ticks (a footage video). */
  function reviewHtml(v) {
    const r = v.footageReview;
    if (!r) return '';
    const editable = v.status === 'reviewed' || v.status === 'planned' || v.status === 'failed';
    const fresh = v.status === 'reviewed';
    const seen = (r.seen || []).map((x) => `<li><span class="font-bold">${esc(x.name)}:</span> ${esc(x.summary)}${x.problems && x.problems.length ? ` <span class="text-amber-800">Problems: ${esc(x.problems.join(', '))}.</span>` : ''}</li>`).join('');
    const sugg = (r.suggestions || []).map((x) => `
      <li><label class="flex items-start gap-2 text-sm text-gray-800">
        <input type="checkbox" data-vid-tick="${esc(x.id)}" ${x.ticked ? 'checked' : ''} ${editable ? '' : 'disabled'} class="mt-1">
        <span class="min-w-0"><span class="text-[11px] font-bold text-gray-500 mr-1">${esc(KIND[x.kind] || 'Edit')}</span>${esc(x.text)}${x.assetId && x.inS != null ? ` <span class="text-xs text-gray-500">(${mmss(x.inS)}–${mmss(x.outS)})</span>` : ''}
        ${x.reason ? `<span class="block text-xs text-gray-500">${esc(x.reason)}</span>` : ''}</span></label></li>`).join('');
    const body = `
      <div class="mt-3 space-y-3" data-vid-review="${v.id}">
        ${seen ? `<div><p class="text-xs font-bold text-gray-700 mb-1">What ${who()} saw</p><ul class="list-disc ml-5 space-y-1 text-xs text-gray-700">${seen}</ul></div>` : ''}
        ${sugg ? `<div><p class="text-xs font-bold text-gray-700 mb-1">Suggested edits${editable ? ' — untick any you don’t want' : ''}</p><ul class="space-y-2">${sugg}</ul></div>`
          : '<p class="text-xs text-gray-600">No edits suggested — the storyboard will use your footage as it is.</p>'}
        ${editable ? `
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Anything else? (optional)</span>
            <textarea data-vid-review-notes rows="2" maxlength="600" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" placeholder="e.g. Keep the bit where I laugh"></textarea></label>
          <button type="button" data-vid-act="plan-review" data-id="${v.id}" ${state.busy.has(v.id) ? 'disabled' : ''} class="${fresh ? 'btn-primary' : 'btn-secondary border'} px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">${fresh ? 'Make the storyboard' : 'Plan the storyboard again with these edits'} — free</button>` : ''}
      </div>`;
    return fresh ? body : `<details class="mt-2"><summary class="text-xs text-gray-500 cursor-pointer">Your footage: what ${who()} saw and the edits you chose</summary>${body}</details>`;
  }

  function sceneHtml(v, s, i) {
    const editable = v.status === 'planned' || v.status === 'failed';
    const thumb = v.sceneThumbs && v.sceneThumbs[s.id];
    const isVideo = s.source === 'stock_video' || s.source === 'ai_video' || s.source === 'own_video';
    const at = s.source === 'own_video' && s.inS != null ? `#t=${Number(s.inS)}` : '';
    const media = thumb
      ? (isVideo ? `<video src="${esc(thumb)}${at}" muted playsinline preload="metadata" class="w-14 h-24 object-cover rounded-md bg-gray-100 shrink-0"></video>` : `<img src="${esc(thumb)}" alt="" class="w-14 h-24 object-cover rounded-md bg-gray-100 shrink-0">`)
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
                <select name="source" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5">${Object.entries(SOURCE).filter(([k]) => (k !== 'product_photo' || s.source === 'product_photo') && (k !== 'own_video' || s.source === 'own_video')).map(([k, l]) => `<option value="${k}" ${k === s.source ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
              <label class="block"><span class="block text-[11px] font-bold text-gray-600">Search words / what to picture</span>
                <input name="keywords" maxlength="120" value="${esc(s.keywords || s.prompt || '')}" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5"></label>
            </div>
            ${s.source === 'own_video' ? `<div class="grid grid-cols-2 gap-2">
              <label class="block"><span class="block text-[11px] font-bold text-gray-600">From (seconds into your video)</span>
                <input name="inS" type="number" min="0" step="0.1" value="${esc(s.inS)}" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5"></label>
              <label class="block"><span class="block text-[11px] font-bold text-gray-600">To</span>
                <input name="outS" type="number" min="0" step="0.1" value="${esc(s.outS)}" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5"></label></div>` : ''}
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
          <p class="text-[11px] font-bold text-gray-500">Scene ${i + 1} · ${esc(BEAT[s.beat] || s.beat)} · about ${esc(s.targetS)}s · ${esc(SOURCE[s.source] || s.source)}${s.source === 'own_video' && s.inS != null ? ` ${esc(ownName(v, s.assetId))} ${mmss(s.inS)}–${mmss(s.outS)}` : ''}</p>
          ${s.voiceover ? `<p class="text-sm text-gray-900 mt-0.5 break-words">“${esc(s.voiceover)}”</p>` : ''}
          ${s.onScreenText ? `<p class="text-xs text-gray-600 mt-0.5 break-words"><span class="font-bold">On screen:</span> ${esc(s.onScreenText)}</p>` : ''}
          ${tightenHtml(v, s, editable)}
          ${editable && chatPaneAvailable() ? `<button type="button" data-vid-act="select-scene" data-id="${v.id}" data-index="${i}" title="Ask ${who()} about this scene" class="mt-1 mr-3 text-xs font-bold text-indigo-700 hover:underline">🎯 Select</button>` : ''}
          ${editable ? `<button type="button" data-vid-act="edit-scene" data-id="${v.id}" data-scene="${esc(s.id)}" class="mt-1 text-xs font-bold text-indigo-700 hover:underline cursor-pointer">Change</button>` : ''}
        </div>
      </li>`;
  }

  /** "✂ 2 pauses, 1 “um” cut — 3.1 s shorter" and the switch back (own footage in its own sound). */
  function tightenHtml(v, s, editable) {
    const b = v.brief || {};
    if (s.source !== 'own_video' || b.voiceover || b.tighten === false) return '';
    const t = s.tightened;
    if (t) {
      const parts = [t.pauses ? `${t.pauses} pause${t.pauses === 1 ? '' : 's'}` : '', t.fillers ? `${t.fillers} “um”${t.fillers === 1 ? '' : 's'}` : '', t.retakes ? `${t.retakes} repeated take${t.retakes === 1 ? '' : 's'}` : ''].filter(Boolean);
      return `<p class="text-xs text-gray-600 mt-0.5">✂ ${esc(parts.length ? parts.join(', ') : 'Dead air')} cut — ${esc(Number(t.savedS).toFixed(1))} s shorter
        ${editable ? `<button type="button" data-vid-act="tighten" data-id="${v.id}" data-scene="${esc(s.id)}" data-on="0" class="ml-1 font-bold text-indigo-700 hover:underline cursor-pointer">Keep as filmed</button>` : ''}</p>`;
    }
    if (s.tighten === false) {
      return `<p class="text-xs text-gray-600 mt-0.5">Kept as filmed
        ${editable ? `<button type="button" data-vid-act="tighten" data-id="${v.id}" data-scene="${esc(s.id)}" data-on="1" class="ml-1 font-bold text-indigo-700 hover:underline cursor-pointer">Tighten it</button>` : ''}</p>`;
    }
    return '';
  }

  /** The name of one of the owner's videos, from what the review saw. */
  function ownName(v, assetId) {
    const x = v.footageReview && (v.footageReview.seen || []).find((y) => y.assetId === assetId);
    return x ? `“${x.name}”` : '';
  }

  function videoHtml(v) {
    const sb = v.storyboard;
    const busy = state.busy.has(v.id);
    // One scene is a video when it's the owner's own take (storyboard.ts minScenesFor); three otherwise.
    const minScenes = v.brief && v.brief.footageAssetIds && v.brief.footageAssetIds.length ? 1 : 3;
    const canMake = (v.status === 'planned' || v.status === 'failed') && sb && sb.scenes && sb.scenes.length >= minScenes;
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
            <p class="text-xs text-gray-600 mt-0.5">${ORIGIN[v.origin] ? `${esc(ORIGIN[v.origin])} · ` : ''}${esc((v.brief && v.brief.lengthS) || '')}s · ${esc(WAITING[v.status === 'built' && v.postRenderStatus === 'failed' ? 'render_failed' : v.status === 'built' && v.postRenderStatus === 'pending' ? 'rendering' : v.status] || v.status)}</p>
            ${v.note ? `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mt-1.5">${esc(v.note)}</p>` : ''}
            ${note ? `<p class="text-xs font-semibold mt-1.5 ${note.error ? 'text-red-600' : 'text-gray-700'}">${esc(note.text)}</p>` : ''}
          </div>
          ${chatPaneAvailable() ? `<button type="button" data-vid-act="talk" data-id="${v.id}" class="text-xs font-bold text-indigo-700 hover:underline shrink-0 whitespace-nowrap">Talk it through</button>` : ''}
          ${v.status === 'built' ? `<button type="button" data-vid-act="open-review" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg shrink-0">Open the Review Queue</button>` : ''}
        </div>
        ${folded ? '' : `<div data-vid-body>
        ${Array.isArray(v.changes) && v.changes.length && (v.status === 'planned' || v.status === 'failed')
          ? `<details class="mt-2"><summary class="text-xs text-gray-500 cursor-pointer">What ${who()} adjusted (${v.changes.length})</summary><ul class="list-disc ml-5 mt-1 text-xs text-gray-600">${v.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details>` : ''}
        ${reviewHtml(v)}
        ${sb && sb.scenes && sb.scenes.length ? `<ol class="mt-3 space-y-2">${sb.scenes.map((s, i) => sceneHtml(v, s, i)).join('')}</ol>` : ''}
        ${sb && sb.caption ? `<p class="text-xs text-gray-600 mt-2"><span class="font-bold">Caption:</span> ${esc(sb.caption)}</p>` : ''}
        ${replanning ? `
          <form data-vid-replan-form data-id="${v.id}" class="mt-3 space-y-2">
            <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">What should be different? (optional)</span>
              <textarea name="feedback" rows="2" maxlength="600" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" placeholder="e.g. More energy, and show the cinnamon buns first"></textarea></label>
            <div class="flex gap-2"><button type="submit" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg">Plan it again</button>
              <button type="button" data-vid-act="cancel-replan" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">Cancel</button></div>
          </form>` : ''}
        ${v.status !== 'cancelled' && v.status !== 'built' && v.status !== 'planning' && v.status !== 'building' && v.status !== 'reviewing' ? `
          <div class="flex flex-wrap gap-2 mt-3">
            ${canMake ? `<button type="button" data-vid-act="build" data-id="${v.id}" ${busy ? 'disabled' : ''} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">Make the video${esc(cost)}</button>` : ''}
            ${!replanning && v.status !== 'reviewed' ? `<button type="button" data-vid-act="replan" data-id="${v.id}" ${busy ? 'disabled' : ''} class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">Plan it again</button>` : ''}
            <button type="button" data-vid-act="cancel" data-id="${v.id}" ${busy ? 'disabled' : ''} class="btn-utility px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">Cancel</button>
          </div>` : ''}
        </div>`}
      </article>`;
  }

  /** The form's voice row, once the catalogue has loaded (its names come from there). */
  function paintFormVoice() {
    const f = host()?.querySelector('[data-vid-form]') || host()?.querySelector('[data-vid-footage-form]');
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
      ${window._tabHead({ title: 'Videos', explain: 'video-videos', right: `${full}${state.footage ? '' : `<button type="button" data-vid-act="footage" class="btn-secondary border min-h-[44px] sm:min-h-0 px-3 py-2 text-sm font-bold rounded-lg whitespace-nowrap">Use my own footage</button>`}${state.form ? '' : window._tabNewBtn('New video', 'data-vid-act="new"')}` })}
      ${formHtml()}
      ${footageFormHtml()}
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
      case 'footage': openFootageForm(); break;
      case 'close-footage': state.footage = null; render(); break;
      case 'plan-review': {
        const box = host()?.querySelector(`[data-vid-review="${id}"]`);
        const ticks = {};
        box?.querySelectorAll('[data-vid-tick]').forEach((c) => { ticks[c.dataset.vidTick] = c.checked; });
        const notes = box?.querySelector('[data-vid-review-notes]')?.value || '';
        state.opened.add(id); saveFolded();
        act(id, { action: 'plan_from_review', id, ticks, notes }, 'Writing the storyboard from the edits you ticked — about a minute.');
        break;
      }
      case 'new': state.form = true; state.footage = null; render(); window.VoicePicker?.load().then(paintFormVoice).catch(() => {}); break;
      case 'voice-listen': window.VoicePicker?.play(b.closest('form')?.elements.voice?.value, b); break;
      case 'voice-choose': {
        const f = b.closest('form');
        window.VoicePicker?.open({ value: f?.elements.voice?.value, title: 'Choose the voice for this video', onSelect: (vid) => {
          if (!f) return;
          f.elements.voice.value = vid;
          if (f.elements.noVoice) f.elements.noVoice.checked = false;
          const voiceRadio = f.querySelector('input[name="sound"][value="voice"]');
          if (voiceRadio) voiceRadio.checked = true;
          paintFormVoice();
        } });
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
      case 'tighten': {
        const on = b.dataset.on === '1';
        act(id, { action: 'edit_scene', id, sceneId: b.dataset.scene, patch: { tighten: on } }, on ? 'Scene tightened.' : 'Scene kept as filmed.');
        break;
      }
      case 'cancel-edit': state.editing = null; render(); break;
      case 'replan': state.replanning = id; render(); break;
      case 'cancel-replan': state.replanning = null; render(); break;
      case 'build': act(id, { action: 'build', id }, 'Making the video — it lands in the Review Queue when it’s done.'); break;
      case 'cancel': act(id, { action: 'cancel', id }, null); break;
      case 'open-review': document.querySelector('[data-maintab="review-queue"]')?.click(); break;
    }
  });

  // Ticking a video in the footage form; adding files to it.
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!host() || !host().contains(t) || !state.footage) return;
    if (t.matches('[data-vid-footage-pick]')) {
      const id = Number(t.dataset.vidFootagePick);
      if (t.checked && state.footage.picked.size >= MAX_FOOTAGE) { t.checked = false; return; }
      if (t.checked) state.footage.picked.add(id); else state.footage.picked.delete(id);
      paintFootageList();
    } else if (t.matches('[data-vid-footage-file]')) {
      const files = [...(t.files || [])];
      t.value = '';
      if (files.length) addFootageFiles(files);
    }
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (!host() || !host().contains(f)) return;
    if (f.matches('[data-vid-footage-form]')) {
      e.preventDefault();
      if (!state.footage || state.footage.busy) return;
      submitFootage(f);
      return;
    }
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
        ...(fd.has('inS') && source === 'own_video' ? { inS: Number(fd.get('inS')), outS: Number(fd.get('outS')) } : {}),
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
      state.rendered = false; state.form = false; state.footage = null; state.editing = null; state.replanning = null; state.notes = {};
      state.stage = null; state.userStage = false;
      loadFolded();
      load();   // eager: the planned count is the tab badge
    },
    /**
     * "Use my own footage", optionally filled in — the chat's footage card and the post editor's
     * "Suggest edits" open it here, because only the browser can read the videos (footage-reader.js).
     * prefill: { assetIds, message, lengthS, voiceover, cta }
     */
    openFootage(prefill) {
      if (!state.rendered) { state.rendered = true; }
      openFootageForm(prefill);
    },
    /** The assistant was renamed: this tab says the new name (assistants.js _assistantRenamed). */
    rename(name) { state.assistantName = name || state.assistantName; if (state.rendered) render(); },
    activate() {
      // A footage card approved in the standalone chat left its prefill for this tab.
      let prefill = null;
      try { prefill = JSON.parse(sessionStorage.getItem('bms-footage-prefill') || 'null'); sessionStorage.removeItem('bms-footage-prefill'); } catch { prefill = null; }
      if (state.rendered) { if (prefill) openFootageForm(prefill); return; }
      state.rendered = true;
      if (prefill) openFootageForm(prefill); else render();
      const dock = getChatDock();
      if (dock && dock.wanted()) dock.setOn(true, false);
    },
  };
})();
