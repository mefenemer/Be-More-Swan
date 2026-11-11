// What work costs comes from Admin → Money → Task costs (/task-costs.js); this keeps a page that didn't load it working.
window.taskCost = window.taskCost || ((kind, fallback) => fallback || '1 task');
/**
 * src/components/assistant-videos.js
 * The Video Producer's Videos tab — docs/video-producer-plan.md §5.2–5.8.
 *
 * A video goes: brief → storyboard (planned in the background, free) → the owner checks every scene,
 * changes any, or plans it again with notes → "Make the video" (states the tasks first) → a finished
 * video in My Content (docs/video-producer-studio-plan.md) — played and downloaded here. Videos made
 * before 2026-11-09 ('built') are posts in the Review Queue and stay that way.
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
  /** What one footage review costs when a video is new to it: the live figure from Admin → Money → Task costs
   *  (/task-costs.js), with the default as the fallback on a page that didn't load it. */
  const reviewCost = () => (window.taskCost ? window.taskCost('footage_review', '2 tasks') : '2 tasks');
  const MAX_FOOTAGE = 10;
  const KIND = { cut: 'Cut', trim: 'Trim', reorder: 'Order', fill: 'Fill a gap', text: 'Words', sound: 'Sound', frame: 'Frame', other: 'Edit' };
  const mmss = (n) => { const t = Math.max(0, Math.floor(Number(n) || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const BEAT = { hook: 'Hook', problem: 'Problem', value: 'Value', proof: 'Proof', cta: 'Call to action' };
  // The same choices the server reads (src/lib/video-music.ts, video-look.ts, lower-third.ts).
  // 'mine' = a track of the owner's own from My Content (one made for an earlier video, or uploaded).
  const MUSIC = [['auto', 'Made to suit the video'], ['upbeat', 'Upbeat'], ['chill', 'Chilled'], ['inspiring', 'Inspiring'], ['ambient', 'Calm, in the background'], ['mine', 'A track from My Content'], ['none', 'No music']];
  const LOOKS = [['natural', 'Natural (no grade)'], ['brand', 'Your brand colours'], ['warm', 'Warm'], ['cool', 'Cool'], ['punchy', 'Bright and punchy'], ['mono', 'Black and white']];
  const LOWER_THIRDS = [['bar', 'Brand-colour bar, left'], ['clean', 'Plain white words, left'], ['boxed', 'White box, centred']];
  // How loud the music sits (src/lib/video-music.ts MUSIC_LEVELS) — three words, as every video is levelled.
  const MUSIC_LEVELS = [['normal', 'Normal'], ['quiet', 'Quiet'], ['loud', 'Loud']];
  // The words on a scene (src/lib/scene-text.ts — the same keys and labels the build reads). One line per
  // scene; the font is the brand's when the render has it, otherwise Impact (owner decisions, 2026-11-10).
  const TEXT_POS = [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']];
  const TEXT_WHEN = [['scene', 'The whole scene'], ['first', 'The first 3 seconds'], ['last', 'The last 3 seconds'], ['words', 'While its words are said']];
  const TEXT_STYLE = [['dark', 'Dark box'], ['plain', 'Plain (light backing)'], ['brand', 'Brand-colour box']];
  const TEXT_ANIM = [['rise', 'Rise'], ['fade', 'Fade'], ['pop', 'Pop'], ['none', 'Cut']];
  const TEXT_Y = { top: 20, middle: 50, bottom: 70 };
  const MOVING = ['stock_video', 'ai_video', 'own_video'];
  // An AI clip on its own (src/lib/ai-clip.ts — the same keys and labels).
  const CLIP_STYLES = [['realistic', 'Realistic', 'People, places and everyday scenes — made-up people only'], ['cinematic', 'Cinematic', 'Landscapes, atmosphere, openers'], ['animated3d', '3D animated', 'Friendly explainers and mascots'], ['cartoon2d', '2D cartoon', 'Playful, illustrated brands'], ['product', 'Product close-up', 'Textures, food and materials — never your own product']];
  const labelOf = (list, v) => (list.find((x) => x[0] === v) || list[0])[1];
  const options = (list, v) => list.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  // Voices come from src/public/voice-catalogue.json through voice-picker.js — the list the server
  // speaks from — and are chosen by ear there. This is the default when setup named none.
  const DEFAULT_VOICE = 'british_woman';
  const WAITING = {
    reviewing: 'Watching your footage — a minute or two. You can leave this page.',
    rendering: 'Made — rendering the finished video, a few minutes. You can leave this page.',
    ready: 'Ready. It’s in My Content — play it here, or download it.',
    render_failed: 'Made, but the finished video failed to render.',
    reviewed: 'Footage reviewed. Tick the edits you want, then press “Make the storyboard”.',
    planning: 'Writing the storyboard — about a minute.',
    planned: 'Storyboard ready. Approve the words, check the pictures beside them, then press “Make the video”.',
    building: 'Making the video — a few minutes. You can leave this page.',
    built: 'Made. Its post is on the Review page, waiting for your approval.',
    // Not a project status: built, and its finished file is still rendering (video-producer.ts renderFinishedVideo).
    post_rendering: 'Made — the finished video is rendering, a few minutes. Watch it on the Review page once it’s done.',
    // Not a project status: a built project whose post then failed its final render (postRenderStatus).
    post_render_failed: 'Made, but the final render failed. Open it on the Review page to try the render again.',
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
    rendered: false, form: false, editing: null, replanning: null, rewriting: null, noting: null, renamingChapter: null, yt: {}, captionLanguages: {}, notes: {}, busy: new Set(), pollTimer: null,
    stage: null, userStage: false, opened: new Set(), full: false,
    // "Use my own footage": the form, the library's own videos, what is ticked, and files just added.
    footage: null,
    // The workspace's own tracks for "A track from My Content" (GET ?tracks=1), and the videos whose
    // Music picker is showing that list before a track is chosen.
    tracks: null, mineOpen: new Set(),
    // Videos ticked for the bulk bar (Archive / Restore / Delete), cleared when the stage changes.
    selected: new Set(), bulkBusy: false, bulkNote: null,
    // The brand colour and render font for the scene text preview (GET returns it with the videos).
    brand: { accent: null, font: 'Impact' },
    // Which clip styles can have sound with today's model (GET returns it with the videos).
    clipSound: {},
    // "Your recording says something different from this line" — `${videoId}:${sceneId|'whole'}` → true.
    voiceWarn: {},
    // Which line the hidden file input is for (Upload on a line, or the whole script).
    voicePick: null,
    // The "New AI clip" form is open.
    clipForm: false,
  };

  // Stages as pills, like the Brand Designer's Briefs (owner, 2026-11-06: the Briefs tab's patterns on
  // every assistant's work tab). "To check" is what waits for the owner, so the tab opens there.
  const STAGES = [
    { key: 'check', label: 'To check', statuses: ['reviewed', 'planned', 'failed', 'render_failed'], urgent: true },
    { key: 'making', label: 'Being made', statuses: ['reviewing', 'planning', 'building', 'rendering'] },
    // 'built' = made the old way, before 2026-11-09: its post is in the Review Queue.
    { key: 'made', label: 'Ready', statuses: ['ready', 'built'] },
    { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
    // Archived by the owner (video_projects.archived_at), whatever its status. Restore puts it back.
    { key: 'archived', label: 'Archived', statuses: [] },
  ];
  // A video being made can't be archived or deleted: a hold and a worker are on it (video-projects.ts BULK_BUSY).
  const MAKING = ['reviewing', 'planning', 'building', 'rendering'];
  const inStage = (key) => {
    const st = STAGES.find((x) => x.key === key) || STAGES[0];
    if (st.key === 'archived') return state.videos.filter((v) => v.archivedAt);
    return state.videos.filter((v) => !v.archivedAt && st.statuses.includes(v.status));
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

  async function loadTracks() {
    try {
      const r = await fetch(`${API}?tracks=1`, { credentials: 'same-origin' });
      state.tracks = r.ok ? ((await r.json()).tracks || []) : [];
    } catch { state.tracks = []; }
    if (state.rendered) render();
  }

  /** The owner's tracks as <option>s; a note instead when there are none yet. */
  function trackOptions(selected) {
    const list = state.tracks || [];
    return `<option value="">Choose a track…</option>` + list.map((t) => `<option value="${t.assetId}"${sel(Number(selected) === t.assetId)}>${esc(t.title)}${t.durationS ? ` · ${Math.round(t.durationS)}s` : ''}</option>`).join('');
  }
  const NO_TRACKS = 'No tracks in My Content yet. Upload one to My Content, or choose a mood and a track is made for this video.';

  async function load() {
    if (!state.tracks) loadTracks();
    try {
      const data = await call('GET', null, `?assistantId=${encodeURIComponent(state.assistantId)}`);
      state.videos = (data.projects || []).filter((p) => p.aiAssistantId == null || p.aiAssistantId === state.assistantId);
      if (data.brand) state.brand = data.brand;
      if (data.clipSound) state.clipSound = data.clipSound;
      if (data.captionLanguages) state.captionLanguages = data.captionLanguages;
      state.loadError = null;
      // A note about work in progress ("Making the video…") is stale once the video has finished,
      // one way or the other; errors stay until the next action.
      for (const v of state.videos) {
        if (['ready', 'built', 'render_failed', 'failed', 'cancelled'].includes(v.status) && state.notes[v.id] && !state.notes[v.id].error) delete state.notes[v.id];
      }
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
    if (state.videos.some((v) => v.status === 'reviewing' || v.status === 'planning' || v.status === 'building' || v.status === 'rendering' || (v.status === 'built' && (v.postRenderStatus === 'pending' || v.postRenderStatus === 'rendering')))) state.pollTimer = setTimeout(load, POLL_MS);
  }

  function updateBadge() {
    const waits = (v) => !v.archivedAt && (v.status === 'planned' || v.status === 'reviewed');
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
      audience: typeof s.defaultAudience === 'string' ? s.defaultAudience : '',
      goal: typeof s.defaultGoal === 'string' ? s.defaultGoal : '',
      musicMood: MUSIC.some((x) => x[0] === s.defaultMusic) ? s.defaultMusic : 'auto',
      look: LOOKS.some((x) => x[0] === s.defaultLook) ? s.defaultLook : 'natural',
      lowerThird: LOWER_THIRDS.some((x) => x[0] === s.defaultLowerThird) ? s.defaultLowerThird : 'bar',
    };
  }

  /** "Who it's for", "What should they do?", music, look and name captions — both brief forms. */
  function briefExtrasHtml(d, f) {
    const v = f || {};
    return `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Who it’s for (optional)</span>
            <input name="audience" maxlength="200" value="${esc(v.audience || d.audience)}" class="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" placeholder="e.g. Busy parents in Leeds"></label>
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">What should they do? (optional)</span>
            <input name="goal" maxlength="200" value="${esc(v.goal || d.goal)}" class="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" placeholder="e.g. Book a free taster class"></label>
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Music</span>
            <select name="musicMood" data-vid-music-mood class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2">${options(MUSIC, d.musicMood)}</select>
            <span data-vid-mine-pick ${d.musicMood === 'mine' ? '' : 'hidden'} class="block mt-1">${(state.tracks || []).length
              ? `<select name="musicAssetId" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2">${trackOptions(d.musicAssetId)}</select>`
              : `<span class="block text-[11px] text-amber-800">${esc(NO_TRACKS)}</span>`}</span>
            <span class="block text-[11px] text-gray-500 mt-0.5">Made for each video with AI (its cost is on “Make the video”), or a track of your own. It goes quiet whenever someone speaks.</span></label>
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Colour look</span>
            <select name="look" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2">${options(LOOKS, d.look)}</select></label>
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Name captions</span>
            <select name="lowerThird" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2">${options(LOWER_THIRDS, d.lowerThird)}</select>
            <span class="block text-[11px] text-gray-500 mt-0.5">How a name and job title look when someone is on screen.</span></label>
        </div>`;
  }
  /** The extras from a submitted brief form. */
  function briefExtras(fd) {
    return {
      audience: String(fd.get('audience') || ''), goal: String(fd.get('goal') || ''),
      musicMood: String(fd.get('musicMood') || 'auto'),
      ...(fd.get('musicMood') === 'mine' && Number(fd.get('musicAssetId')) > 0 ? { musicAssetId: Number(fd.get('musicAssetId')) } : {}),
      look: String(fd.get('look') || 'natural'), lowerThird: String(fd.get('lowerThird') || 'bar'),
    };
  }
  const sel = (on) => (on ? ' selected' : '');

  // The finished video's shape (docs/video-producer-studio-plan.md, D-S2). The Video Producer makes a
  // video for anywhere and saves it to My Content. It never posts or hands a video on (owner, 2026-11-10).
  const SHAPES = [['9:16', 'Vertical 9:16', 'Reels, Shorts, Stories'], ['1:1', 'Square 1:1', 'feeds'], ['16:9', 'Wide 16:9', 'YouTube, websites']];
  function shapeHtml() {
    const d = ['9:16', '1:1', '16:9'].includes(String((state.setup || {}).defaultShape)) ? String(state.setup.defaultShape) : '9:16';
    return `<fieldset><legend class="text-xs font-bold text-gray-600 mb-1">Shape</legend>
          <div class="flex flex-wrap gap-3 text-sm text-gray-700">${SHAPES.map(([v, l, h]) => `
            <label class="inline-flex items-center gap-1.5"><input type="radio" name="shape" value="${v}"${v === d ? ' checked' : ''}> ${esc(l)} <span class="text-xs text-gray-500">${esc(h)}</span></label>`).join('')}
          </div>
          <p class="text-[11px] text-gray-500 mt-1">The finished video is saved to My Content. Download it, or use it from My Content.</p></fieldset>`;
  }

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
            <label class="mt-0.5 flex items-start gap-1.5 text-xs text-gray-600"><input type="checkbox" name="ownVoice" class="mt-0.5"> <span>I’ll record it in my own voice <span class="text-gray-500">— you record each line once the script is approved, and no voiceover is charged</span></span></label>
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
        ${briefExtrasHtml(d)}
        ${shapeHtml()}
        <p class="text-xs text-gray-500">Planning the storyboard is free. You check the words first, then every scene, before anything is made.</p>
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
      voiceover: p.voiceover === true || p.ownVoice === true, ownVoice: p.ownVoice === true, cta: p.cta || '',
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
    btn.textContent = `Review my footage${picked.length ? (fresh ? ` — uses ${reviewCost()}` : ' — free') : ''}`;
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
          ${/* Film it here (video-recorder.js), into the library like any upload (owner, 2026-11-10). */ ''}
          <button type="button" data-vid-act="record-video" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">● Record a video</button>
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
          <label class="flex items-start gap-1.5 text-sm text-gray-700 mt-1"><input type="radio" name="sound" value="voice" ${f.voiceover && !f.ownVoice ? 'checked' : ''} class="mt-1"> Add a voiceover instead</label>
          <div class="flex items-center gap-2 border border-gray-300 rounded-lg px-2 py-2 mt-1 ml-5">
            <input type="hidden" name="voice" value="${esc(d.voice)}">
            <span data-vid-voice-name class="flex-1 min-w-0 text-sm text-gray-800 truncate">${esc(window.VoicePicker?.describe(d.voice) || d.voice)}</span>
            <button type="button" data-vid-act="voice-listen" class="shrink-0 text-xs font-bold text-gray-600 hover:text-gray-900 cursor-pointer">&#9654; Listen</button>
            <button type="button" data-vid-act="voice-choose" class="shrink-0 text-xs font-bold text-indigo-700 hover:underline cursor-pointer">Change</button>
          </div>
          ${/* Your own voice over your footage (own-voice.ts): recorded line by line once the script is approved. */ ''}
          <label class="flex items-start gap-1.5 text-sm text-gray-700 mt-1"><input type="radio" name="sound" value="myvoice" ${f.ownVoice ? 'checked' : ''} class="mt-1"> Add a voiceover in my own voice <span class="text-xs text-gray-500 mt-0.5">— you record each line once the script is approved; no voiceover is charged</span></label>
        </fieldset>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label class="inline-flex items-center gap-1.5 text-sm text-gray-700"><input type="checkbox" name="captions"${d.captions ? ' checked' : ''}> Captions</label>
          <span data-vid-cap-desc class="text-xs text-gray-500">${esc(window.CaptionStyle?.describe(d.captionStyle) || '')}</span>
          <button type="button" data-vid-act="caption-style" class="text-xs font-bold text-indigo-700 hover:underline cursor-pointer">Change the look</button>
          <input type="hidden" name="captionStyle" value="${esc(d.captionStyle ? JSON.stringify(d.captionStyle) : '')}">
        </div>
        <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Where it can't use your footage</span>
          <select name="allowAi" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2"><option value="stock_only"${sel(d.allowAi === 'stock_only')}>Stock footage and branded cards</option><option value="stock_and_ai"${sel(d.allowAi !== 'stock_only')}>Stock, branded cards, or AI where it fits</option></select></label>
        ${briefExtrasHtml(d, f)}
        ${shapeHtml()}
        <label class="flex items-start gap-1.5 text-sm text-gray-700"><input type="checkbox" name="consent" required class="mt-1"> I have permission to use the people and music in these videos.</label>
        <p class="text-xs text-gray-500">Reviewing a video ${who()} hasn’t seen before uses ${reviewCost()}; videos it has already reviewed are free. Your videos are never changed — edits only go into the new video.</p>
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
      // 'myvoice': a voiceover in the owner's own voice. The chosen voice still sets the script's language.
      const ownVoice = fd.get('sound') === 'myvoice';
      const voice = fd.get('sound') === 'voice' || ownVoice ? String(fd.get('voice') || '') : '';
      let captionStyle;
      try { captionStyle = JSON.parse(String(fd.get('captionStyle') || 'null')) || undefined; } catch { captionStyle = undefined; }
      const brief = {
        message: String(fd.get('message') || ''), lengthS: Number(fd.get('lengthS')), cta: String(fd.get('cta') || ''),
        voiceover: !!voice, voice: voice || undefined, allowAi: String(fd.get('allowAi') || 'stock_only'),
        ...(ownVoice && voice ? { ownVoice: true } : {}),
        captions: !!fd.get('captions'), ...(captionStyle ? { captionStyle } : {}),
        shape: String(fd.get('shape') || '9:16'), footageAssetIds: ids, footageConsent: true,
        tighten: !!fd.get('tighten'), ...briefExtras(fd),
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

  /** Where the captions sit on this video, and whether it has any (the words keep clear of them). */
  function captionsOf(v) {
    const b = v.brief || {};
    return { on: b.captions !== false, pos: (b.captionStyle && b.captionStyle.position) || 'bottom' };
  }
  const textPosOf = (v, s) => s.textPos || (captionsOf(v).pos === 'top' ? 'bottom' : 'top');
  const textWhenOf = (s) => s.textWhen || (s.source === 'own_video' ? 'first' : 'scene');

  /** " · top · first 3 s · brand box" — only what differs from the plain default. */
  function textSummary(v, s) {
    if (s.source === 'brand_card') return '';
    const bits = [];
    if (s.textPos) bits.push(labelOf(TEXT_POS, s.textPos).toLowerCase());
    if (s.textWhen) bits.push(labelOf(TEXT_WHEN, s.textWhen).toLowerCase());
    if (s.textStyle && s.textStyle !== 'dark') bits.push(labelOf(TEXT_STYLE, s.textStyle).toLowerCase());
    if (s.textAnim && s.textAnim !== 'rise') bits.push(labelOf(TEXT_ANIM, s.textAnim).toLowerCase());
    return bits.length ? ` <span class="text-gray-500">· ${esc(bits.join(' · '))}</span>` : '';
  }

  /** The look of the words in the preview — the same choices as scene-text.ts textLook (a guide, not the render). */
  function previewBoxCss(style) {
    const accent = /^#?[0-9a-f]{6}$/i.test(String(state.brand.accent || '')) ? (String(state.brand.accent).startsWith('#') ? state.brand.accent : `#${state.brand.accent}`) : null;
    if (style === 'plain') return 'background:rgba(0,0,0,0.25);color:#fff';
    if (style === 'brand' && accent) {
      const n = parseInt(accent.slice(1), 16);
      const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
      return `background:${accent};color:${lum > 0.6 ? '#000' : '#fff'}`;
    }
    return 'background:rgba(0,0,0,0.55);color:#fff';
  }

  /** The scene's picture with the words drawn where and how they'll be. Repainted as the form changes. */
  function textPreviewHtml(v, s, thumb, isVideo, o) {
    const shape = (v.brief && v.brief.shape) || '9:16';
    const ratio = shape === '16:9' ? '16 / 9' : shape === '1:1' ? '1 / 1' : '9 / 16';
    const width = shape === '16:9' ? 224 : shape === '1:1' ? 144 : 112;   // px: the prebuilt CSS has no w-56 / w-36
    const bg = thumb ? (isVideo ? `<video src="${esc(thumb)}" muted playsinline loop autoplay preload="metadata" class="absolute inset-0 w-full h-full object-cover"></video>` : `<img src="${esc(thumb)}" alt="" class="absolute inset-0 w-full h-full object-cover">`) : '';
    const cap = captionsOf(v);
    const words = (o.text || '').trim();
    const font = state.brand.font === 'Impact' ? `'Anton', Impact, 'Arial Narrow Bold', sans-serif` : `${state.brand.font}, sans-serif`;
    return `<div data-vid-text-preview class="relative shrink-0 rounded-md overflow-hidden bg-gray-800" style="width:${width}px;aspect-ratio:${ratio}">
        ${bg}
        ${cap.on ? `<span class="absolute text-center font-bold" style="left:4px;right:4px;font-size:7px;color:#fef08a;top:${TEXT_Y[cap.pos] || 70}%;transform:translateY(-50%)">captions</span>` : ''}
        ${words ? `<span class="absolute left-1/2 px-1 rounded leading-tight text-center" style="font-size:9px;top:${TEXT_Y[o.pos]}%;transform:translate(-50%,-50%);max-width:90%;font-family:${font};${previewBoxCss(o.style)}">${esc(words)}</span>` : ''}
      </div>`;
  }

  /** The Text group on a scene's Change form: the words, then where / when / look / appears, beside a preview. */
  function textGroupHtml(v, s, thumb, isVideo) {
    const card = s.source === 'brand_card';
    const input = `<label class="block"><span class="block text-[11px] font-bold text-gray-600">On-screen text (optional)</span>
        <input name="onScreenText" maxlength="60" value="${esc(s.onScreenText || '')}" data-vid-text-input class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5"></label>`;
    if (card) return `${input}<p class="text-[11px] text-gray-500">On a branded card the words are the card’s headline, drawn into the picture.</p>`;
    const o = { text: s.onScreenText || '', pos: textPosOf(v, s), style: s.textStyle || 'dark' };
    const sel = (name, list, val) => `<select name="${name}" data-vid-text-opt class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5">${options(list, val)}</select>`;
    return `
      <fieldset class="border border-gray-200 rounded-lg p-2 bg-white">
        <legend class="px-1 text-[11px] font-bold text-gray-600">Text on the video</legend>
        <div class="flex flex-col sm:flex-row gap-3">
          <div class="flex-1 min-w-0 space-y-2">
            ${input}
            <div class="grid grid-cols-2 gap-2">
              <label class="block"><span class="block text-[11px] font-bold text-gray-600">Where</span>${sel('textPos', TEXT_POS, o.pos)}</label>
              <label class="block"><span class="block text-[11px] font-bold text-gray-600">When</span>${sel('textWhen', TEXT_WHEN, textWhenOf(s))}</label>
              <label class="block"><span class="block text-[11px] font-bold text-gray-600">Look</span>${sel('textStyle', TEXT_STYLE, o.style)}</label>
              <label class="block"><span class="block text-[11px] font-bold text-gray-600">Appears</span>${sel('textAnim', TEXT_ANIM, s.textAnim || 'rise')}</label>
            </div>
            <p data-vid-text-clash class="${captionsOf(v).on && o.pos === captionsOf(v).pos ? '' : 'hidden'} text-[11px] font-semibold text-amber-800">That’s where the captions are — the two would overlap. Choose another place.</p>
            <p class="text-[11px] text-gray-500">The preview is a guide. “While its words are said” needs a voiceover line in this scene.</p>
          </div>
          ${textPreviewHtml(v, s, thumb, isVideo, o)}
        </div>
      </fieldset>`;
  }

  /**
   * The text choices that differ from what the scene would get anyway. Saving a scene untouched must not
   * pin today's defaults onto it (moving the captions later should still move the words).
   */
  function textPatch(f, fd) {
    if (!fd.has('textPos')) return {};
    const v = state.videos.find((x) => x.id === Number(f.dataset.id));
    const s = v && v.storyboard && v.storyboard.scenes.find((x) => x.id === f.dataset.scene);
    if (!s) return {};
    const shown = { textPos: textPosOf(v, s), textWhen: textWhenOf(s), textStyle: s.textStyle || 'dark', textAnim: s.textAnim || 'rise' };
    const out = {};
    Object.keys(shown).forEach((k) => { const val = String(fd.get(k)); if (val !== shown[k] || s[k]) out[k] = val; });
    return out;
  }

  /** Repaint a Change form's preview and overlap warning from what's chosen now. */
  function paintTextPreview(f) {
    const v = state.videos.find((x) => x.id === Number(f.dataset.id));
    const s = v && v.storyboard && v.storyboard.scenes.find((x) => x.id === f.dataset.scene);
    const old = f.querySelector('[data-vid-text-preview]');
    if (!v || !s || !old || !f.elements.textPos) return;
    const thumb = v.sceneThumbs && v.sceneThumbs[s.id];
    const o = { text: f.elements.onScreenText.value, pos: f.elements.textPos.value, style: f.elements.textStyle.value };
    old.outerHTML = textPreviewHtml(v, s, thumb, MOVING.includes(s.source), o);
    const cap = captionsOf(v);
    f.querySelector('[data-vid-text-clash]')?.classList.toggle('hidden', !(cap.on && o.pos === cap.pos));
  }

  function sceneHtml(v, s, i) {
    const editable = v.status === 'planned' || v.status === 'failed';
    const thumb = v.sceneThumbs && v.sceneThumbs[s.id];
    const isVideo = s.source === 'stock_video' || s.source === 'ai_video' || s.source === 'own_video';
    const at = s.source === 'own_video' && s.inS != null ? `#t=${Number(s.inS)}` : '';
    const media = thumb
      ? (isVideo ? `<video src="${esc(thumb)}${at}" muted playsinline loop preload="metadata" data-vid-hoverplay title="Moving footage — point at it, or tap, to play" class="w-14 h-24 object-cover rounded-md bg-gray-100 shrink-0 cursor-pointer"></video>` : `<img src="${esc(thumb)}" alt="" class="w-14 h-24 object-cover rounded-md bg-gray-100 shrink-0">`)
      : `<div class="w-14 h-24 rounded-md bg-gray-100 shrink-0 flex items-center justify-center text-[10px] text-gray-400 text-center px-1">${esc(SOURCE[s.source] || s.source)}</div>`;
    const editing = state.editing && state.editing.id === v.id && state.editing.sceneId === s.id;
    if (editing) {
      return `
        <li class="border border-indigo-200 bg-indigo-50/40 rounded-lg p-3">
          <form data-vid-scene-form data-id="${v.id}" data-scene="${esc(s.id)}" class="space-y-2">
            <p class="text-xs font-bold text-gray-700">Scene ${i + 1} · ${esc(BEAT[s.beat] || s.beat)}</p>
            <label class="block"><span class="block text-[11px] font-bold text-gray-600">Voiceover</span>
              <textarea name="voiceover" rows="2" maxlength="240" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5">${esc(s.voiceover)}</textarea></label>
            ${textGroupHtml(v, s, thumb, isVideo)}
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
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label class="block"><span class="block text-[11px] font-bold text-gray-600">Name caption (optional)</span>
                <input name="ncName" maxlength="40" value="${esc((s.nameCaption && s.nameCaption.name) || '')}" placeholder="e.g. Sarah Jones" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5"></label>
              <label class="block"><span class="block text-[11px] font-bold text-gray-600">Their role</span>
                <input name="ncRole" maxlength="50" value="${esc((s.nameCaption && s.nameCaption.role) || '')}" placeholder="e.g. Owner" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5"></label>
            </div>
            <p class="text-[11px] text-gray-500">Changing a voiceover line keeps the picture; the voiceover is recorded again when the video is made.</p>
            <div class="flex gap-2"><button type="submit" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg">Save scene</button>
              <button type="button" data-vid-act="cancel-edit" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">Cancel</button></div>
          </form>
        </li>`;
    }
    // Words and pictures side by side (script first, 2026-11-10): the words on the left, what is seen
    // on the right. Stacked on a phone.
    const notes = (v.momentNotes || []).filter((n) => n.sceneId === s.id);
    return `
      <li class="border border-gray-200 rounded-lg p-2.5 bg-white" data-vid-scene-row="${esc(s.id)}">
        <p class="text-[11px] font-bold text-gray-500">Scene ${i + 1} · ${esc(BEAT[s.beat] || s.beat)} · about ${esc(s.targetS)}s</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
          <div class="min-w-0">
            <p class="text-[10px] font-bold uppercase tracking-wide text-gray-400">Words</p>
            ${s.voiceover ? `<p class="text-sm text-gray-900 mt-0.5 break-words">“${esc(s.voiceover)}”</p>` : '<p class="text-xs text-gray-500 mt-0.5">No voiceover in this scene.</p>'}
            ${s.onScreenText ? `<p class="text-xs text-gray-600 mt-0.5 break-words"><span class="font-bold">On screen:</span> ${esc(s.onScreenText)}${textSummary(v, s)}</p>` : ''}
            ${s.nameCaption ? `<p class="text-xs text-gray-600 mt-0.5 break-words"><span class="font-bold">Name caption:</span> ${esc(s.nameCaption.name)}${s.nameCaption.role ? ` · ${esc(s.nameCaption.role)}` : ''}</p>` : ''}
          </div>
          <div class="flex gap-2 min-w-0">
            ${media}
            <div class="min-w-0">
              <p class="text-[10px] font-bold uppercase tracking-wide text-gray-400">Picture</p>
              <p class="text-xs text-gray-700 mt-0.5">${esc(SOURCE[s.source] || s.source)}${s.source === 'own_video' && s.inS != null ? ` ${esc(ownName(v, s.assetId))} ${mmss(s.inS)}–${mmss(s.outS)}` : ''}</p>
              ${/* Moving or still — a paused first frame looked exactly like a picture (owner, 2026-11-10). */ ''}
              <span class="inline-block mt-0.5 text-[10px] font-bold rounded px-1.5 py-0.5 ${MOVING.includes(s.source) ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-100 text-gray-600'}">${MOVING.includes(s.source) ? '▶ Moving' : 'Still'}</span>
              ${s.keywords || s.prompt ? `<p class="text-xs text-gray-500 mt-0.5 break-words">${esc(s.keywords || s.prompt)}</p>` : ''}
              ${tightenHtml(v, s, editable)}
            </div>
          </div>
        </div>
        ${notes.length ? `<ul class="mt-1.5 space-y-0.5">${notes.map((n) => `<li class="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">📝 ${mmss(n.atS)} — ${esc(n.text)}</li>`).join('')}</ul>` : ''}
        ${editable && chatPaneAvailable() ? `<button type="button" data-vid-act="select-scene" data-id="${v.id}" data-index="${i}" title="Ask ${who()} about this scene" class="mt-1 mr-3 text-xs font-bold text-indigo-700 hover:underline">🎯 Select</button>` : ''}
        ${editable ? `<button type="button" data-vid-act="edit-scene" data-id="${v.id}" data-scene="${esc(s.id)}" class="mt-1 text-xs font-bold text-indigo-700 hover:underline cursor-pointer">Change</button>` : ''}
      </li>`;
  }

  /**
   * Script first: a voiceover video's words are checked and approved on their own — free — before
   * "Make the video" sources a single picture. "Rewrite the words" changes words only; every scene
   * keeps its picture (video-projects 'rewrite_script').
   */
  // ── An AI clip on its own (src/lib/ai-clip.ts; plan §5.1) ─────────────────────────────────────────
  function clipFormHtml() {
    if (!state.clipForm) return '';
    return `
      <form data-vid-clip-form class="tab-card p-4 mb-3 space-y-3">
        <div class="flex items-center justify-between"><p class="text-sm font-bold text-gray-900">New AI clip</p>
          <button type="button" data-vid-act="clip-close" class="text-xs font-bold text-gray-500 hover:text-gray-800">Close</button></div>
        <p class="text-xs text-gray-600">A short clip made with AI, saved to My Content. You see its first frame (${window.taskCost('ai_image')}) before the clip is made, and the button says what the clip uses. Made-up people only.</p>
        <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">What should it show?</span>
          <textarea name="description" rows="3" maxlength="400" required class="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" placeholder="e.g. Steam rising from a fresh cup of coffee on a sunny café table, slow push in"></textarea></label>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Style</span>
            <select name="style" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2">${CLIP_STYLES.map(([k, l, h]) => `<option value="${k}" title="${esc(h)}">${esc(l)}</option>`).join('')}</select></label>
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Length</span>
            <select name="lengthS" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2"><option value="5">5 seconds</option><option value="10">10 seconds</option></select></label>
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Shape</span>
            <select name="shape" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2"><option value="9:16">Vertical 9:16</option><option value="1:1">Square 1:1</option><option value="16:9">Wide 16:9</option></select></label>
        </div>
        ${/* Ambient sound made with the picture, where the model can (ai-clip.ts CLIP_SOUND_PRICE). Shown per style. */ ''}
        <label data-vid-clip-sound class="${state.clipSound.realistic ? 'flex' : 'hidden'} items-start gap-1.5 text-sm text-gray-700"><input type="checkbox" name="sound" class="mt-1"> <span>With sound <span class="text-xs text-gray-500">— natural background sound, no speech or music. Uses 1.5× the clip’s tasks. Leave it off if a voiceover or music will go over it.</span></span></label>
        <p data-vid-clip-msg class="hidden text-xs font-semibold text-red-600"></p>
        <button type="submit" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">Save the clip — free</button>
      </form>`;
  }

  /** What a clip is waiting for, in its own words (a clip has no storyboard or script to approve). */
  function clipStatus(v) {
    if (v.status === 'planned' || v.status === 'failed') return v.clipFrameUrl ? 'First frame ready — make the clip from it, or try another.' : 'Saved. See its first frame before the clip is made.';
    if (v.status === 'building') return 'Making the clip — a few minutes. You can leave this page.';
    return WAITING[v.status] || v.status;
  }

  /** The clip's card: what it shows, its first frame, and the two presses that spend (each says what it uses). */
  function clipHtml(v) {
    const c = v.brief.clip;
    const busy = state.busy.has(v.id) ? 'disabled' : '';
    const style = (CLIP_STYLES.find((x) => x[0] === c.style) || CLIP_STYLES[0])[1];
    const unit = v.unit === 'credits' ? 'credit' : 'task';
    const cost = v.estimate == null ? '' : ` — uses ${v.estimate} ${unit}${v.estimate === 1 ? '' : 's'}`;
    const ratio = (v.brief.shape || '9:16') === '16:9' ? '16 / 9' : v.brief.shape === '1:1' ? '1 / 1' : '9 / 16';
    const open = v.status === 'planned' || v.status === 'failed';
    return `
      <div class="mt-3 flex flex-col sm:flex-row gap-3">
        <div class="shrink-0 rounded-md overflow-hidden bg-gray-100 flex items-center justify-center text-[11px] text-gray-500 text-center" style="width:${ratio === '16 / 9' ? 224 : ratio === '1 / 1' ? 144 : 112}px;aspect-ratio:${ratio}">
          ${v.clipFrameUrl ? `<img src="${esc(v.clipFrameUrl)}" alt="The clip’s first frame" class="w-full h-full object-cover">` : 'No first frame yet'}
        </div>
        <div class="min-w-0 space-y-1.5">
          <p class="text-sm text-gray-900 break-words">“${esc(c.description)}”</p>
          <p class="text-xs text-gray-600">${esc(style)} · ${esc(c.lengthS)} seconds · ${c.sound ? 'with sound' : 'no sound'} · AI clip</p>
          ${open ? `<div class="flex flex-wrap gap-2 pt-1">
            <button type="button" data-vid-act="clip-frame" data-id="${v.id}" ${busy} class="${v.clipFrameUrl ? 'btn-secondary border' : 'btn-primary'} px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50">${v.clipFrameUrl ? 'Try another frame' : 'See the first frame'} — ${window.taskCost('ai_image')}</button>
            ${v.clipFrameUrl ? `<button type="button" data-vid-act="build" data-id="${v.id}" ${busy} class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50">Make the clip${esc(cost)}</button>` : ''}
            <button type="button" data-vid-act="cancel" data-id="${v.id}" ${busy} class="btn-utility px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50">Cancel</button>
          </div>
          <p class="text-[11px] text-gray-500">${v.clipFrameUrl ? 'The clip starts from this picture and moves from there. Not right? Try another frame first.' : 'See the first frame before paying for the clip — if it looks wrong, try again or make a new clip with other words.'}</p>` : ''}
        </div>
      </div>`;
  }

  function scriptStepHtml(v) {
    const sb = v.storyboard;
    if (!sb || !(v.status === 'planned' || v.status === 'failed') || !(v.brief && v.brief.voiceover)) return '';
    const busy = state.busy.has(v.id);
    const rewriting = state.rewriting === v.id;
    if (sb.scriptApprovedAt) {
      return `${voiceLineHtml(v)}<p class="mt-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1">✓ Script approved. ${isOwn(v) ? 'Record each line below, check the pictures, then press “Make the video”.' : 'Check the pictures beside each line, then press “Make the video”.'}
        <button type="button" data-vid-act="rewrite" data-id="${v.id}" class="ml-1 font-bold text-indigo-700 hover:underline">Rewrite the words</button></p>
        ${rewriting ? rewriteFormHtml(v) : ''}
        ${isOwn(v) ? recordPanelHtml(v) : ''}`;
    }
    const words = (sb.scenes || []).map((x) => x.voiceover).filter(Boolean).join(' ');
    const n = words.split(/\s+/).filter(Boolean).length;
    return `
      <div class="mt-3 border border-indigo-200 bg-indigo-50/40 rounded-lg p-3">
        <p class="text-xs font-bold text-indigo-800">Step 1 of 2 — the words${isOwn(v) ? ' (you’ll record them next)' : ''}</p>
        <p class="text-sm text-gray-900 mt-1 whitespace-pre-line break-words">${esc(words)}</p>
        <p class="text-[11px] text-gray-500 mt-1">${n} words · about ${Math.round(n / 2.5)} seconds spoken. Approving is free and makes nothing yet — the pictures come next.</p>
        <div class="flex flex-wrap gap-2 mt-2">
          <button type="button" data-vid-act="approve-script" data-id="${v.id}" ${busy ? 'disabled' : ''} class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50">Approve the script — free</button>
          ${rewriting ? '' : `<button type="button" data-vid-act="rewrite" data-id="${v.id}" ${busy ? 'disabled' : ''} class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50">Rewrite the words</button>`}
        </div>
        ${rewriting ? rewriteFormHtml(v) : ''}
      </div>
      ${voiceLineHtml(v)}`;
  }

  // ── Your own voice (src/utils/own-voice.ts; plan Phase 3) ─────────────────────────────────────────
  const isOwn = (v) => !!(v.brief && v.brief.voiceover !== false && v.brief.ownVoice === true);
  /** Lines still to record — none when one recording covers the whole script. */
  const unrecorded = (v) => (v.voiceoverAssetId ? [] : ((v.storyboard && v.storyboard.scenes) || []).filter((s) => (s.voiceover || '').trim() && !s.voiceAssetId));

  /** Who speaks, and the switch to the other (never both in one video). */
  function voiceLineHtml(v) {
    if (!(v.brief && v.brief.voiceover)) return '';
    const busy = state.busy.has(v.id) ? 'disabled' : '';
    return isOwn(v)
      ? `<p class="mt-2 text-xs text-gray-600"><span class="font-bold">Voice:</span> your own. <button type="button" data-vid-act="voice-mode" data-mode="ai" data-id="${v.id}" ${busy} class="font-bold text-indigo-700 hover:underline disabled:opacity-50">Use an AI voice instead</button></p>`
      : `<p class="mt-2 text-xs text-gray-600"><span class="font-bold">Voice:</span> ${esc(window.VoicePicker?.describe(v.brief.voice) || 'AI voice')}. <button type="button" data-vid-act="voice-mode" data-mode="own" data-id="${v.id}" ${busy} class="font-bold text-indigo-700 hover:underline disabled:opacity-50">Record it in my own voice instead</button></p>`;
  }

  /** Each line with Record / Upload, or its recording with Play / Redo / Remove; or one whole-script recording. */
  function recordPanelHtml(v) {
    const sb = v.storyboard;
    const urls = v.voiceUrls || {};
    const busy = state.busy.has(v.id) ? 'disabled' : '';
    const warn = (key) => (state.voiceWarn[key] ? `<p class="text-[11px] font-semibold text-amber-800 mt-0.5">Your recording says something different from this line. Keep it if that’s what you meant, or record it again.</p>` : '');
    const btn = 'btn-secondary border px-2.5 py-1 text-[11px] font-bold rounded-lg disabled:opacity-50';
    if (v.voiceoverAssetId) {
      return `<div class="mt-2 border border-indigo-200 bg-white rounded-lg p-3" data-vid-record="${v.id}">
          <p class="text-xs font-bold text-gray-800">Your voice — one recording of the whole script</p>
          ${urls.whole ? `<audio controls preload="none" src="${esc(urls.whole)}" class="w-full mt-1.5" style="height:32px"></audio>` : ''}
          ${warn(`${v.id}:whole`)}
          <p class="text-[11px] text-gray-500 mt-1">Scenes change where its words reach each line. Recording lines one by one times them exactly.</p>
          <button type="button" data-vid-act="voice-whole-remove" data-id="${v.id}" ${busy} class="${btn} mt-1.5">Remove it and record line by line</button>
        </div>`;
    }
    const left = unrecorded(v).length;
    const rows = sb.scenes.map((s, i) => {
      if (!(s.voiceover || '').trim()) return '';
      const key = `${v.id}:${s.id}`;
      const done = !!s.voiceAssetId;
      return `<li class="border border-gray-200 rounded-lg p-2">
          <p class="text-[11px] font-bold text-gray-500">Scene ${i + 1}${done ? ` · <span class="text-emerald-700">✓ recorded${s.voiceS ? `, ${esc(Number(s.voiceS).toFixed(1))}s` : ''}</span>` : ''}</p>
          <p class="text-sm text-gray-900 break-words">“${esc(s.voiceover)}”</p>
          ${done && urls[s.id] ? `<audio controls preload="none" src="${esc(urls[s.id])}" class="w-full mt-1" style="height:32px"></audio>` : ''}
          ${warn(key)}
          <div class="flex flex-wrap gap-2 mt-1.5">
            <button type="button" data-vid-act="voice-record" data-id="${v.id}" data-scene="${esc(s.id)}" ${busy} class="${done ? btn : 'btn-primary px-2.5 py-1 text-[11px] font-bold rounded-lg disabled:opacity-50'}">${done ? 'Record again' : '● Record'}</button>
            <button type="button" data-vid-act="voice-upload" data-id="${v.id}" data-scene="${esc(s.id)}" ${busy} class="${btn}">Upload</button>
            ${done ? `<button type="button" data-vid-act="voice-remove" data-id="${v.id}" data-scene="${esc(s.id)}" ${busy} class="text-[11px] font-bold text-gray-500 hover:text-red-700 disabled:opacity-50">Remove</button>` : ''}
          </div>
        </li>`;
    }).join('');
    return `<div class="mt-2 border border-indigo-200 bg-white rounded-lg p-3" data-vid-record="${v.id}">
        <p class="text-xs font-bold text-gray-800">Your voice — ${left ? `${left} line${left === 1 ? '' : 's'} to record` : 'every line recorded'}</p>
        <p class="text-[11px] text-gray-500 mt-0.5">Each scene lasts as long as your recording of its line. Free — no voiceover is made.</p>
        <ol class="mt-2 space-y-2">${rows}</ol>
        <p class="text-[11px] text-gray-500 mt-2">Recorded it somewhere else? <button type="button" data-vid-act="voice-whole-upload" data-id="${v.id}" ${busy} class="font-bold text-indigo-700 hover:underline disabled:opacity-50">Upload one recording of the whole script</button></p>
        <input type="file" accept="audio/*" data-vid-voice-file data-id="${v.id}" hidden>
      </div>`;
  }

  /**
   * A recording as a small mono WAV (24 kHz, 16-bit): the server can level it like the AI voice (it reads
   * WAV and MP3 only) and the transcriber takes it whole. Browsers record WebM or MP4, and uploads vary.
   */
  async function toWav(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    let decoded;
    try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close?.().catch(() => {}); }
    const rate = 24000;
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const src = off.createBufferSource();
    src.buffer = decoded; src.connect(off.destination); src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const dv = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return { file: new File([buf], 'voice.wav', { type: 'audio/wav' }), durationS: decoded.duration };
  }

  /** Into My Content as audio — the same path as any upload (content-upload-url → PUT → content-assets). */
  async function uploadVoice(blob, name) {
    let wav;
    try { wav = await toWav(blob); } catch { throw new Error('That file couldn’t be read as audio. Try an MP3, M4A or WAV.'); }
    const file = new File([wav.file], `${name}.wav`.replace(/[^\w .·()-]/g, '').slice(0, 100) || 'voice.wav', { type: 'audio/wav' });
    const r = await fetch('/.netlify/functions/content-upload-url', {
      credentials: 'same-origin', method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, mimeType: file.type, fileSize: file.size }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Could not start the upload.');
    if (!j.mock) {
      const put = await fetch(j.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!put.ok) throw new Error('The upload failed. Please try again.');
    }
    const c = await fetch('/.netlify/functions/content-assets', {
      credentials: 'same-origin', method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, assetType: 'audio', mimeType: file.type, fileSize: file.size, storageKey: j.storageKey, storageUrl: j.storageUrl, durationS: Math.round(wav.durationS * 100) / 100 }),
    });
    const d = await c.json().catch(() => ({}));
    if (!c.ok) throw new Error(d.error || 'The upload failed. Please try again.');
    if (d.rejected) throw new Error((d.asset && d.asset.rejectionReason) || 'That recording was flagged and can’t be used.');
    return d.asset.id;
  }

  /** Upload a recording and attach it: one scene's line, or (sceneId null) the whole script. */
  async function attachVoice(id, sceneId, blob) {
    const v = state.videos.find((x) => x.id === id);
    const s = sceneId && v && v.storyboard.scenes.find((x) => x.id === sceneId);
    state.busy.add(id);
    state.notes[id] = { text: 'Saving your recording…' };
    render();
    try {
      const assetId = await uploadVoice(blob, s ? `Your voice · ${v.title} · scene ${v.storyboard.scenes.indexOf(s) + 1}` : `Your voice · ${v.title}`);
      const data = await call('POST', sceneId ? { action: 'set_line_voice', id, sceneId, assetId } : { action: 'set_voice_file', id, assetId });
      state.voiceWarn[`${(data.project && data.project.id) || id}:${sceneId || 'whole'}`] = !!data.differs;
      state.notes[id] = { text: 'Recording saved.' };
    } catch (err) {
      state.notes[id] = { text: err.message, error: true };
    }
    state.busy.delete(id);
    await load();
  }

  function rewriteFormHtml(v) {
    return `<form data-vid-rewrite-form data-id="${v.id}" class="mt-2 space-y-2">
        <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">How should the words change? (optional)</span>
          <textarea name="feedback" rows="2" maxlength="600" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" placeholder="e.g. Warmer, and mention free parking"></textarea></label>
        <p class="text-[11px] text-gray-500">Only the words change — every scene keeps its picture. Free.</p>
        <div class="flex gap-2"><button type="submit" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg">Rewrite the words</button>
          <button type="button" data-vid-act="cancel-rewrite" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">Cancel</button></div>
      </form>`;
  }

  /** Music, colour look and name captions on a storyboard — changed here without planning it again. */
  function optionsHtml(v) {
    const b = v.brief || {};
    const sb = v.storyboard;
    if (!sb || !(v.status === 'planned' || v.status === 'failed' || v.status === 'render_failed')) {
      if (v.status !== 'ready') return '';
      const mix = v.mix || {};
      const music = b.musicMood === 'none' ? 'No music'
        : mix.musicNote ? 'none in this version'
        : b.musicMood === 'mine' ? (mix.musicTitle ? `“${mix.musicTitle}” (your track)` : 'Your track')
        : (sb && sb.music ? `“${sb.music.title}” (${labelOf(MUSIC, sb.music.mood).toLowerCase()})` : labelOf(MUSIC, b.musicMood || 'auto'));
      const retry = mix.musicNote && b.musicMood && !['none', 'mine'].includes(b.musicMood)
        ? ` <button type="button" data-vid-act="another-track" data-id="${v.id}" class="font-bold text-indigo-700 hover:underline">Try the music again</button>` : '';
      return `${mix.musicNote ? `<p class="text-xs text-amber-800 mt-2">${esc(mix.musicNote)}${retry}</p>` : ''}<p class="text-xs text-gray-600 mt-2"><span class="font-bold">Music:</span> ${esc(music)}${b.musicLevel && b.musicLevel !== 'normal' && b.musicMood !== 'none' ? ` (${esc(labelOf(MUSIC_LEVELS, b.musicLevel).toLowerCase())})` : ''} · <span class="font-bold">Look:</span> ${esc(labelOf(LOOKS, b.look || 'natural'))}${b.audience ? ` · <span class="font-bold">For:</span> ${esc(b.audience)}` : ''}${b.goal ? ` · <span class="font-bold">They should:</span> ${esc(b.goal)}` : ''}</p>`;
    }
    const mine = b.musicMood === 'mine' || state.mineOpen.has(v.id);
    const mood = mine ? 'mine' : (MUSIC.some((x) => x[0] === b.musicMood) ? b.musicMood : 'auto');
    const minePick = !mine ? '' : (state.tracks || []).length
      ? `<select data-vid-opt="musicAssetId" data-id="${v.id}" class="mt-1 w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" aria-label="Your track">${trackOptions(b.musicMood === 'mine' ? b.musicAssetId : null)}</select>`
      : `<span class="block mt-1 text-[11px] text-amber-800">${esc(NO_TRACKS)}</span>`;
    return `
      <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2" data-vid-options="${v.id}">
        <label class="block"><span class="block text-[11px] font-bold text-gray-600">Music${sb.music && mood !== 'none' && mood !== 'mine' ? ` — “${esc(sb.music.title)}”` : ''}</span>
          <select data-vid-opt="musicMood" data-id="${v.id}" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5">${options(MUSIC, mood)}</select>
          ${minePick}
          ${sb.music && mood !== 'none' && mood !== 'mine' ? `<button type="button" data-vid-act="another-track" data-id="${v.id}" class="text-[11px] font-bold text-indigo-700 hover:underline">Another track</button>` : ''}</label>
        <label class="block"><span class="block text-[11px] font-bold text-gray-600">Music volume</span>
          <select data-vid-opt="musicLevel" data-id="${v.id}" ${mood === 'none' ? 'disabled title="No music on this video"' : ''} class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5 disabled:opacity-50">${options(MUSIC_LEVELS, b.musicLevel || 'normal')}</select>
          <span class="block text-[11px] text-gray-500">It still goes quiet whenever someone speaks.</span></label>
        <label class="block"><span class="block text-[11px] font-bold text-gray-600">Colour look</span>
          <select data-vid-opt="look" data-id="${v.id}" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5">${options(LOOKS, b.look || 'natural')}</select></label>
        <label class="block"><span class="block text-[11px] font-bold text-gray-600">Name captions</span>
          <select data-vid-opt="lowerThird" data-id="${v.id}" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5">${options(LOWER_THIRDS, b.lowerThird || 'bar')}</select></label>
      </div>
      ${b.audience || b.goal ? `<p class="text-xs text-gray-600 mt-1">${b.audience ? `<span class="font-bold">For:</span> ${esc(b.audience)}` : ''}${b.audience && b.goal ? ' · ' : ''}${b.goal ? `<span class="font-bold">They should:</span> ${esc(b.goal)}` : ''}</p>` : ''}`;
  }

  /** A finished studio video: the player, its length and shape, Download, "Contains AI"; or the retry. */
  function readyHtml(v) {
    if (v.status === 'render_failed') {
      return `<div class="mt-3"><button type="button" data-vid-act="rerender" data-id="${v.id}" ${state.busy.has(v.id) ? 'disabled' : ''} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">Try the render again — free</button></div>`;
    }
    if (v.status !== 'ready' || !v.outputUrl) return '';
    const shape = (v.brief && v.brief.shape) || '9:16';
    const wide = shape === '16:9';
    const ai = v.storyboard && (v.storyboard.scenes || []).some((s) => s.source === 'ai_video' || s.source === 'ai_image');
    const times = v.sceneTimes || [];
    const total = v.outputDurationS || (times.length ? times[times.length - 1].endS : 0);
    // The scene strip under the player: click any point to jump there and leave a note on that moment.
    const strip = times.length && total ? `<div class="mt-1 flex h-5 rounded overflow-hidden border border-gray-200 cursor-crosshair" data-vid-strip="${v.id}" title="Click a moment to leave a note on it" role="group" aria-label="Scenes — click a moment to leave a note">
        ${times.map((t, k) => `<span class="h-full ${k % 2 ? 'bg-indigo-100' : 'bg-indigo-200'} relative" style="width:${((t.endS - t.startS) / total) * 100}%"><span class="absolute inset-0 text-[9px] text-indigo-900 leading-5 pl-0.5 select-none">${k + 1}</span></span>`).join('')}
      </div>` : '';
    const notes = v.momentNotes || [];
    const noting = state.noting && state.noting.id === v.id ? state.noting : null;
    const shapesLeft = SHAPES.map((x) => x[0]).filter((x) => x !== shape && !familyShapes(v).has(x));
    return `
      <div class="mt-3 flex flex-col sm:flex-row gap-3 items-start">
        <div class="${wide ? 'w-full sm:w-96' : shape === '1:1' ? 'w-56' : 'w-44'} shrink-0">
          <video src="${esc(v.outputUrl)}" controls playsinline preload="metadata" data-vid-player="${v.id}" class="w-full rounded-lg bg-black"></video>
          <div class="mt-1 flex items-center gap-1" role="group" aria-label="Skip back or forward">
            <button type="button" data-vid-act="skip" data-id="${v.id}" data-by="-10" aria-label="Back 10 seconds" title="Back 10 seconds" class="btn-secondary border px-2 py-0.5 text-xs font-bold rounded-md">⏪ 10s</button>
            <button type="button" data-vid-act="skip" data-id="${v.id}" data-by="-5" aria-label="Back 5 seconds" title="Back 5 seconds" class="btn-secondary border px-2 py-0.5 text-xs font-bold rounded-md">⏪ 5s</button>
            <button type="button" data-vid-act="skip" data-id="${v.id}" data-by="5" aria-label="Forward 5 seconds" title="Forward 5 seconds" class="btn-secondary border px-2 py-0.5 text-xs font-bold rounded-md">5s ⏩</button>
            <button type="button" data-vid-act="skip" data-id="${v.id}" data-by="10" aria-label="Forward 10 seconds" title="Forward 10 seconds" class="btn-secondary border px-2 py-0.5 text-xs font-bold rounded-md">10s ⏩</button>
          </div>
          ${strip}
          <button type="button" data-vid-act="note-here" data-id="${v.id}" class="mt-1 text-xs font-bold text-indigo-700 hover:underline">📝 Note on this moment</button>
          ${noting ? `<form data-vid-note-form data-id="${v.id}" class="mt-1 space-y-1">
              <p class="text-[11px] font-bold text-gray-600">At ${mmss(noting.atS)}${noting.scene ? ` · scene ${esc(noting.scene)}` : ''}</p>
              <textarea name="text" rows="2" maxlength="300" required class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" placeholder="e.g. Too fast here — show the cake for longer"></textarea>
              <div class="flex gap-2"><button type="submit" class="btn-primary px-3 py-1 text-xs font-bold rounded-lg">Save note</button>
                <button type="button" data-vid-act="cancel-note" class="btn-secondary border px-3 py-1 text-xs font-bold rounded-lg">Cancel</button></div>
            </form>` : ''}
        </div>
        <div class="min-w-0 w-full sm:w-auto space-y-2">
          <p class="text-xs text-gray-600">${v.outputDurationS ? `${Math.round(v.outputDurationS)} s · ` : ''}${esc(SHAPES.find((x) => x[0] === shape)?.[1] || shape)}${v.version > 1 ? ` · version ${esc(v.version)}` : ''}${ai ? ' · <span class="font-semibold text-amber-800">Contains AI</span>' : ''}</p>
          <div class="flex flex-wrap gap-2">
            <a href="/.netlify/functions/content-asset-download?assetId=${encodeURIComponent(v.outputAssetId)}" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg">Download</a>
            <button type="button" data-vid-act="change" data-id="${v.id}" ${state.busy.has(v.id) ? 'disabled' : ''} title="Make a new version. This one stays in My Content." class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">Change it</button>
          </div>
          <p class="text-[11px] text-gray-500">Saved in My Content. Download it, or pick it from My Content wherever you want to use it.</p>
          ${shapesLeft.length ? `<button type="button" data-vid-act="reshape" data-id="${v.id}" ${state.busy.has(v.id) ? 'disabled' : ''} title="Keeps the voiceover and every clip and picture, cropped to the new shape; branded cards are drawn again." class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50">Make it ${esc(shapesLeft.map((x) => (SHAPES.find((y) => y[0] === x) || [x, x])[1].toLowerCase()).join(' and '))} too — free</button>` : ''}
          ${chaptersHtml(v)}
          ${captionsHtml(v)}
          ${youtubeHtml(v)}
          ${notes.length ? `<div class="border border-amber-200 bg-amber-50 rounded-lg p-2">
              <p class="text-xs font-bold text-amber-900">Your notes (${notes.length})</p>
              <ul class="mt-1 space-y-0.5">${notes.map((n) => `<li class="text-xs text-amber-900 flex items-start gap-1"><button type="button" data-vid-act="seek" data-id="${v.id}" data-at="${esc(n.atS)}" class="font-bold hover:underline shrink-0">${mmss(n.atS)}</button><span class="min-w-0 break-words">${n.sceneId ? `scene ${esc(n.sceneId.slice(1))}: ` : ''}${esc(n.text)}</span><button type="button" data-vid-act="delete-note" data-id="${v.id}" data-note="${esc(n.id)}" aria-label="Delete this note" class="ml-auto shrink-0 text-amber-700 hover:text-red-700">×</button></li>`).join('')}</ul>
              <button type="button" data-vid-act="notes-version" data-id="${v.id}" ${state.busy.has(v.id) ? 'disabled' : ''} class="btn-primary mt-2 px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50">Make a new version from my notes — free</button>
              <p class="text-[11px] text-amber-900/80 mt-1">Only the scenes you noted change; everything else is kept. You check it before it’s made.</p>
            </div>` : ''}
          ${(v.sourceFiles || []).length ? `<details><summary class="text-xs text-gray-500 cursor-pointer">Source files for this version (${v.sourceFiles.length})</summary>
              <ul class="mt-1 space-y-0.5">${v.sourceFiles.map((f) => `<li class="text-xs text-gray-700 flex gap-2"><span class="text-gray-500 shrink-0">${esc(f.kind)}</span><span class="truncate">${esc(f.name)}</span><a href="/.netlify/functions/content-asset-download?assetId=${encodeURIComponent(f.id)}" class="ml-auto shrink-0 font-bold text-indigo-700 hover:underline">Download</a></li>`).join('')}</ul></details>` : ''}
        </div>
      </div>`;
  }

  /** The shapes already made (or being made) from the same original video. */
  function familyShapes(v) {
    const root = (v.brief && v.brief.shapeOf) || v.id;
    return new Set(state.videos.filter((x) => (x.id === root || (x.brief && x.brief.shapeOf === root)) && !['cancelled', 'failed'].includes(x.status)).map((x) => (x.brief && x.brief.shape) || '9:16'));
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
    // Script first: a voiceover video's words are approved before anything is made.
    const needsScript = !!(v.brief && v.brief.voiceover) && sb && !sb.scriptApprovedAt;
    // Your own voice: every line recorded first (own-voice.ts linesToRecord; the server checks it too).
    const needsRecording = isOwn(v) && !!sb && unrecorded(v).length > 0;
    const canMake = (v.status === 'planned' || v.status === 'failed') && sb && sb.scenes && sb.scenes.length >= minScenes && !needsScript && !needsRecording;
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
          ${/* Ticked for Archive / Restore / Delete (the bar above the list). Not while it is being made: a hold and a worker are on it. */ ''}
          <input type="checkbox" data-vid-pick="${v.id}" ${state.selected.has(v.id) ? 'checked' : ''} ${MAKING.includes(v.status) ? 'disabled title="Being made — cancel it or wait until it’s done"' : ''}
            aria-label="Select “${esc(v.title)}”" class="mt-1 w-4 h-4 shrink-0 rounded border-gray-300 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40">
          <div class="min-w-0 flex-1">
            <button type="button" data-vid-act="fold" data-id="${v.id}" aria-expanded="${folded ? 'false' : 'true'}" title="${folded ? 'Show this video' : 'Hide this video'}"
              class="flex items-start gap-1.5 text-left text-sm font-bold text-gray-900 break-words cursor-pointer hover:text-gray-700">
              <svg class="w-4 h-4 mt-0.5 shrink-0 text-gray-400 transition-transform ${folded ? '-rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
              <span>${esc(v.title)}</span></button>
            ${v.brief && v.brief.clip ? `<p class="text-xs text-gray-600 mt-0.5">AI clip · ${esc(v.brief.clip.lengthS)}s · ${esc(clipStatus(v))}</p>` : ''}
            <p class="text-xs text-gray-600 mt-0.5${v.brief && v.brief.clip ? ' hidden' : ''}">${v.version > 1 ? `Version ${esc(v.version)} · ` : ''}${v.brief && v.brief.shapeOf ? `${esc((SHAPES.find((x) => x[0] === v.brief.shape) || ['', ''])[1])} copy · ` : ''}${ORIGIN[v.origin] ? `${esc(ORIGIN[v.origin])} · ` : ''}${esc((v.brief && v.brief.lengthS) || '')}s · ${esc(WAITING[v.status === 'built' && v.postRenderStatus === 'failed' ? 'post_render_failed' : v.status === 'built' && (v.postRenderStatus === 'pending' || v.postRenderStatus === 'rendering') ? 'post_rendering' : v.status] || v.status)}</p>
            ${v.note ? `<p class="text-xs ${v.status === 'ready' ? 'text-emerald-800 bg-emerald-50 border-emerald-200' : 'text-amber-800 bg-amber-50 border-amber-200'} border rounded-md px-2 py-1 mt-1.5 break-words" style="overflow-wrap:anywhere">${esc(v.note)}</p>` : ''}
            ${note ? `<p class="text-xs font-semibold mt-1.5 ${note.error ? 'text-red-600' : 'text-gray-700'}">${esc(note.text)}</p>` : ''}
          </div>
          ${/* "🎯 Select", as on every assistant's items (Campaigns, Briefs, Mentor plan, this tab's scenes) — owner 2026-11-10: "Talk it through" was this tab's own wording. */
            chatPaneAvailable() ? `<button type="button" data-vid-act="talk" data-id="${v.id}" title="Ask ${who()} about this video" class="text-xs font-bold text-indigo-700 hover:underline shrink-0 whitespace-nowrap">🎯 Select</button>` : ''}
          ${v.status === 'built' ? `<button type="button" data-vid-act="open-review" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg shrink-0">Open Review</button>` : ''}
        </div>
        ${folded ? '' : v.brief && v.brief.clip ? `<div data-vid-body>${clipHtml(v)}${readyHtml(v)}</div>` : `<div data-vid-body>
        ${Array.isArray(v.changes) && v.changes.length && (v.status === 'planned' || v.status === 'failed')
          ? `<details class="mt-2"><summary class="text-xs text-gray-500 cursor-pointer">What ${who()} adjusted (${v.changes.length})</summary><ul class="list-disc ml-5 mt-1 text-xs text-gray-600">${v.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details>` : ''}
        ${readyHtml(v)}
        ${reviewHtml(v)}
        ${scriptStepHtml(v)}
        ${optionsHtml(v)}
        ${sb && sb.scenes && sb.scenes.length ? `<ol class="mt-3 space-y-2">${sb.scenes.map((s, i) => sceneHtml(v, s, i)).join('')}</ol>` : ''}
        ${replanning ? `
          <form data-vid-replan-form data-id="${v.id}" class="mt-3 space-y-2">
            <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">What should be different? (optional)</span>
              <textarea name="feedback" rows="2" maxlength="600" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" placeholder="e.g. More energy, and show the cinnamon buns first"></textarea></label>
            <div class="flex gap-2"><button type="submit" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg">Plan it again</button>
              <button type="button" data-vid-act="cancel-replan" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">Cancel</button></div>
          </form>` : ''}
        ${!['cancelled', 'built', 'planning', 'building', 'reviewing', 'rendering', 'ready'].includes(v.status) ? `
          <div class="flex flex-wrap gap-2 mt-3">
            ${canMake ? `<button type="button" data-vid-act="build" data-id="${v.id}" ${busy ? 'disabled' : ''} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">Make the video${esc(cost)}</button>` : ''}
            ${needsScript && (v.status === 'planned' || v.status === 'failed') ? '<span class="self-center text-xs text-gray-500">Approve the script above, then “Make the video”.</span>' : ''}
            ${!needsScript && needsRecording && (v.status === 'planned' || v.status === 'failed') ? '<span class="self-center text-xs text-gray-500">Record every line above, then “Make the video”.</span>' : ''}
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

  /** The bar over the list once anything is ticked: Archive (or Restore on Archived) and Delete. */
  function bulkBarHtml(picked) {
    const n = picked.length;
    const note = state.bulkNote ? `<p class="text-xs font-semibold px-4 pt-2 ${state.bulkNote.error ? 'text-red-600' : 'text-gray-700'}" role="status">${esc(state.bulkNote.text)}</p>` : '';
    if (!n) return note;
    const dis = state.bulkBusy ? 'disabled' : '';
    const archived = state.stage === 'archived';
    return `${note}
      <div data-vid-bulkbar class="mx-4 mt-2 flex flex-wrap items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
        <span class="text-sm font-bold text-gray-800 mr-auto">${n} selected</span>
        <button type="button" data-vid-act="${archived ? 'bulk-restore' : 'bulk-archive'}" ${dis} class="btn-secondary border min-h-[44px] sm:min-h-0 px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50">${archived ? 'Restore' : 'Archive'} ${n}</button>
        <button type="button" data-vid-act="bulk-delete" ${dis} class="btn-destructive border min-h-[44px] sm:min-h-0 px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50">Delete ${n}</button>
        <button type="button" data-vid-act="pick-none" ${dis} class="tab-link">Clear</button>
      </div>`;
  }

  /** Archive, restore or delete the ticked videos — video-projects.ts, the same action as the chat card. */
  async function bulk(action) {
    const ids = inStage(state.stage).filter((v) => state.selected.has(v.id) && !MAKING.includes(v.status)).map((v) => v.id);
    if (!ids.length) return;
    const n = ids.length, them = n === 1 ? 'this video' : `these ${n} videos`;
    if (action === 'delete') {
      const ok = await window.confirmModal(`${n === 1 ? 'It is' : 'They are'} removed from the Videos tab for good, with ${n === 1 ? 'its' : 'their'} storyboard, notes and versions list. This can’t be undone. Any finished video file stays in My Content until you delete it there.`, {
        title: `Delete ${them}?`, confirmLabel: `Delete ${n}`, cancelLabel: 'Keep them',
      });
      if (!ok) return;
    }
    state.bulkBusy = true; state.bulkNote = { text: 'Working…' }; render();
    try {
      const data = await call('POST', { action, ids });
      const done = (data.done || []).length, skipped = data.skipped || [];
      const verb = action === 'archive' ? 'Archived' : action === 'restore' ? 'Restored' : 'Deleted';
      state.bulkNote = { text: `${verb} ${done} ${done === 1 ? 'video' : 'videos'}.${skipped.length ? ` ${skipped.length} left as ${skipped.length === 1 ? 'it was' : 'they were'}: ${skipped[0].reason}` : ''}`, error: !done && skipped.length > 0 };
      state.selected.clear();
    } catch (err) {
      state.bulkNote = { text: err.message, error: true };
    }
    state.bulkBusy = false;
    await load();
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
    // Only what is on this stage counts as selected (a video can move stage while ticked).
    const pickable = visible.filter((v) => !MAKING.includes(v.status));
    const picked = pickable.filter((v) => state.selected.has(v.id));
    const allPicked = pickable.length > 0 && picked.length === pickable.length;
    const pills = STAGES.map((st) => {
      const n = inStage(st.key).length;
      const on = st.key === state.stage;
      return `<button type="button" role="tab" aria-selected="${on ? 'true' : 'false'}" tabindex="${on ? 0 : -1}" data-vid-stage="${st.key}"
        class="flex-shrink-0 min-h-[44px] sm:min-h-0 text-sm whitespace-nowrap">${esc(st.label)}${window._tabPillCount(n, !!st.urgent)}</button>`;
    }).join('');
    const empty = state.stage === 'check'
      ? `No videos to check. Press “New video”, or tell ${who()} in chat what you’d like a video about.`
      : state.stage === 'archived' ? 'Nothing archived. Tick videos on any stage, then press “Archive”.'
      : `No videos ${esc(stageLabel.toLowerCase())}.`;
    // The standard tab header and card (owner, 2026-11-07). Full screen, then "+ New video" right beside
    // it (e2e/full-screen-buttons.spec.ts), then "Use my own footage".
    const full = `<button type="button" data-vid-act="full" aria-pressed="${state.full ? 'true' : 'false'}" title="${state.full ? 'Back to the page (Esc)' : 'Use the whole screen for your videos and the chat'}" class="btn-secondary border min-h-[44px] sm:min-h-0 px-3 py-2 text-sm font-bold rounded-lg whitespace-nowrap">${state.full ? 'Exit full screen' : 'Full screen'}</button>`;
    el.innerHTML = `
      ${window._tabHead({ title: 'Videos', explain: 'video-videos', right: `${full}${state.form ? '' : window._tabNewBtn('New video', 'data-vid-act="new"')}${state.footage ? '' : `<button type="button" data-vid-act="footage" class="btn-secondary border min-h-[44px] sm:min-h-0 px-3 py-2 text-sm font-bold rounded-lg whitespace-nowrap">Use my own footage</button>`}${state.clipForm ? '' : `<button type="button" data-vid-act="clip-new" class="btn-secondary border min-h-[44px] sm:min-h-0 px-3 py-2 text-sm font-bold rounded-lg whitespace-nowrap">New AI clip</button>`}` })}
      ${formHtml()}
      ${clipFormHtml()}
      ${footageFormHtml()}
      <div class="tab-card">
        <div class="tab-pillbar">
          <div role="tablist" aria-label="Videos by stage" class="stage-pills tab-scroller">${pills}</div>
          <div class="tab-pillbar-actions">${pickable.length > 1 ? `<button type="button" data-vid-act="pick-all" class="tab-link">${allPicked ? 'Clear selection' : 'Select all'}</button>` : ''}${visible.length > 1 ? `<button type="button" data-vid-act="fold-all" class="tab-link">${anyOpen ? 'Hide all' : 'Show all'}</button>` : ''}</div>
        </div>
        ${bulkBarHtml(picked)}
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

  /**
   * "Change it": a new version of a finished video (video-projects 'change'). It opens on "To check"
   * with everything already made kept — only what's changed is made again. This one stays Ready.
   */
  async function changeVideo(id) {
    state.busy.add(id); render();
    try {
      const data = await call('POST', { action: 'change', id });
      const nv = data.project;
      state.stage = 'check'; state.userStage = true;
      if (nv && nv.id) { state.opened.add(nv.id); saveFolded(); state.notes[nv.id] = { text: 'A new version. Change any scene, then press “Make the video” — only what you change is made again.' }; }
    } catch (err) {
      state.notes[id] = { text: err.message, error: true };
    }
    state.busy.delete(id);
    await load();
    if (state.stage === 'check') host()?.querySelector('[data-video]')?.scrollIntoView({ block: 'start' });
  }

  /** Open the note box for a moment of a ready video (the scene playing then is named). */
  function openNote(id, atS) {
    const v = state.videos.find((x) => x.id === id);
    if (!v) return;
    const times = v.sceneTimes || [];
    const at = Math.round((Number(atS) || 0) * 10) / 10;
    const hit = times.find((t) => at >= t.startS && at < t.endS) || times[times.length - 1];
    state.noting = { id, atS: at, scene: hit ? String(times.indexOf(hit) + 1) : '' };
    render();
    host()?.querySelector('[data-vid-note-form] textarea')?.focus();
  }

  /** "Make a new version from my notes": opens on "Being made" while the noted scenes are rewritten. */
  async function versionFromNotes(id) {
    state.busy.add(id); render();
    try {
      const data = await call('POST', { action: 'notes_to_version', id });
      const nv = data.project;
      if (nv && nv.id) { state.opened.add(nv.id); saveFolded(); state.notes[nv.id] = { text: 'Turning your notes into changes to those scenes — about a minute. You check it before it’s made.' }; }
      state.stage = 'making'; state.userStage = true;
    } catch (err) {
      state.notes[id] = { text: err.message, error: true };
    }
    state.busy.delete(id);
    await load();
  }

  /**
   * A finished video's chapters (video-chapters.ts): runs of scenes with one story beat. Click one to
   * jump there; ✎ renames it. When YouTube would show them, they go in the description when it's posted
   * there, and "Copy for YouTube" puts the same lines on the clipboard for anywhere else.
   */
  function chaptersHtml(v) {
    const list = v.chapters || [];
    if (list.length < 2) return '';
    const renaming = state.renamingChapter && state.renamingChapter.id === v.id ? state.renamingChapter.sceneId : null;
    return `<div class="border border-gray-200 rounded-lg p-2" data-vid-chapters="${v.id}">
        <div class="flex items-center gap-2"><p class="text-xs font-bold text-gray-800">Chapters (${list.length})</p>
          ${v.youtubeChapters ? `<button type="button" data-vid-act="copy-chapters" data-id="${v.id}" class="ml-auto text-[11px] font-bold text-indigo-700 hover:underline">Copy for YouTube</button>` : ''}</div>
        <ol class="mt-1 space-y-0.5">${list.map((c, i) => renaming === c.sceneId
          ? `<li><form data-vid-chapter-form data-id="${v.id}" data-scene="${esc(c.sceneId)}" class="flex items-center gap-1">
              <span class="text-xs font-bold text-gray-500 shrink-0">${mmss(c.startS)}</span>
              <input name="title" value="${esc(c.named ? c.title : '')}" placeholder="${esc(c.title)}" maxlength="60" aria-label="Chapter name" class="min-w-0 flex-1 text-xs border border-gray-300 rounded px-1.5 py-0.5">
              <button type="submit" class="btn-primary px-2 py-0.5 text-[11px] font-bold rounded">Save</button>
              <button type="button" data-vid-act="cancel-chapter" class="text-[11px] font-bold text-gray-500 hover:underline">Cancel</button>
            </form></li>`
          : `<li class="flex items-center gap-1 rounded px-1" data-vid-chapter data-start="${esc(c.startS)}" data-end="${esc(c.endS)}">
              <button type="button" data-vid-act="seek" data-id="${v.id}" data-at="${esc(c.startS)}" class="flex items-baseline gap-1.5 min-w-0 text-left hover:underline" title="Play from here">
                <span class="text-xs font-bold text-indigo-700 shrink-0">${mmss(c.startS)}</span><span class="text-xs text-gray-800 truncate">${esc(c.title)}</span></button>
              <span class="text-[10px] text-gray-400 shrink-0">${c.scenes.length > 1 ? `scenes ${c.scenes[0]}–${c.scenes[c.scenes.length - 1]}` : `scene ${c.scenes[0]}`}</span>
              <button type="button" data-vid-act="rename-chapter" data-id="${v.id}" data-scene="${esc(c.sceneId)}" aria-label="Rename chapter ${i + 1}" title="Rename" class="ml-auto shrink-0 text-xs text-gray-400 hover:text-indigo-700">✎</button>
            </li>`).join('')}</ol>
        <p class="text-[11px] text-gray-500 mt-1">${v.youtubeChapters ? 'Added to the description when this video is posted to YouTube, so viewers can jump between them.' : v.chaptersWhyNot === 'not_wide' ? 'Shown here only — YouTube makes a vertical or square video a Short, and Shorts have no chapters. A wide version gets them.' : 'Shown here only — YouTube needs at least 3 chapters of 10 seconds or more.'}</p>
      </div>`;
  }

  /**
   * Caption files (youtube-extras.ts): the words as spoken, free to download, and translations at
   * 1 task a language (caption-translate.ts). They go on YouTube as caption tracks when it's posted
   * there, once that permission is granted; the captions burned into the video stay as they are.
   */
  function captionsHtml(v) {
    if (!v.hasSpokenCaptions) return '';
    const langs = state.captionLanguages || {};
    const done = (v.captionTranslations || []).filter((c) => langs[c]);
    const left = Object.keys(langs).filter((c) => !done.includes(c));
    const file = (code, fmt) => `${API}?id=${encodeURIComponent(v.id)}&captions=${encodeURIComponent(code)}&format=${fmt}`;
    const links = (code) => `<a href="${file(code, 'srt')}" class="font-bold text-indigo-700 hover:underline">SRT</a> · <a href="${file(code, 'vtt')}" class="font-bold text-indigo-700 hover:underline">VTT</a>`;
    const cost = window.taskCost ? window.taskCost('caption_translation', '1 task') : '1 task';
    return `<div class="border border-gray-200 rounded-lg p-2" data-vid-captions="${v.id}">
        <p class="text-xs font-bold text-gray-800">Caption files</p>
        <ul class="mt-1 space-y-0.5 text-xs text-gray-800">
          <li class="flex items-center gap-2"><span>English (as spoken)</span><span class="ml-auto shrink-0">${links('en')}</span></li>
          ${done.map((c) => `<li class="flex items-center gap-2"><span>${esc(langs[c])}</span><span class="ml-auto shrink-0">${links(c)}</span>
            <button type="button" data-vid-act="remove-translation" data-id="${v.id}" data-lang="${esc(c)}" aria-label="Remove the ${esc(langs[c])} captions" class="shrink-0 text-gray-400 hover:text-red-700">×</button></li>`).join('')}
        </ul>
        ${left.length && done.length < 10 ? `<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
            <label class="sr-only" for="vid-lang-${v.id}">Language</label>
            <select id="vid-lang-${v.id}" data-vid-lang="${v.id}" class="text-xs border border-gray-300 rounded-md px-1.5 py-1">${left.map((c) => `<option value="${esc(c)}">${esc(langs[c])}</option>`).join('')}</select>
            <button type="button" data-vid-act="translate" data-id="${v.id}" ${state.busy.has(v.id) ? 'disabled' : ''} class="btn-secondary border px-2 py-1 text-xs font-bold rounded-md disabled:opacity-50">Translate — ${esc(cost)}</button>
          </div>` : ''}
        <p class="text-[11px] text-gray-500 mt-1">For YouTube, Vimeo or your own site. When this video is posted to YouTube, these are added as caption tracks${state.yt[v.id]?.data?.retentionNote === 'needs_permission' || !state.yt[v.id] ? ' once YouTube is reconnected with caption access' : ''}. The captions in the video itself stay in the language spoken.</p>
      </div>`;
  }

  /** How it's doing on YouTube (youtube-video.ts): loaded once per visit, refreshable. */
  function loadYouTube(id, fresh) {
    const cur = state.yt[id];
    if (cur && cur.loading) return;
    state.yt[id] = { ...(cur || {}), loading: true };
    call('GET', null, `?id=${encodeURIComponent(id)}&youtube=1${fresh ? '&fresh=1' : ''}`)
      .then((d) => { state.yt[id] = { data: d.youtube || null, canAsk: !!d.canAskPermission, loaded: true }; })
      .catch((err) => { state.yt[id] = { error: err.message, loaded: true }; })
      .finally(() => { if (state.rendered) render(); });
  }

  /** The drop-off curve as a small line, with chapter starts marked. */
  function retentionSvg(points, chapters, durationS) {
    if (!points || points.length < 2) return '';
    const W = 260, H = 60, top = Math.max(1, ...points.map((p) => p.watching));
    const xy = points.map((p) => `${(p.at * W).toFixed(1)},${(H - (Math.min(p.watching, top) / top) * (H - 4) - 2).toFixed(1)}`).join(' ');
    const ticks = durationS > 0 ? (chapters || []).slice(1).map((c) => { const x = ((c.startS / durationS) * W).toFixed(1); return `<line x1="${x}" x2="${x}" y1="0" y2="${H}" stroke="currentColor" stroke-opacity="0.25" stroke-dasharray="2 2"/>`; }).join('') : '';
    return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-14 text-gray-500 mt-1" role="img" aria-label="Share of viewers still watching across the video">${ticks}<polyline points="${xy}" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linejoin="round"/></svg>`;
  }

  function youtubeHtml(v) {
    const st = state.yt[v.id];
    if (!st) { setTimeout(() => loadYouTube(v.id, false), 0); return ''; }
    const d = st.data;
    if (!d) return '';   // not posted to YouTube (or it couldn't be read and there's nothing saved)
    const n = (x) => (x == null ? '—' : Number(x).toLocaleString('en-GB'));
    const dur = v.outputDurationS || 0;
    const chapterAt = (s) => (v.chapters || []).filter((c) => c.startS <= s).pop();
    const drop = d.drop ? (() => { const c = chapterAt(d.drop.atS); return `Most viewers leave at ${mmss(d.drop.atS)}${c ? `, in “${esc(c.title)}”` : ''} (${d.drop.lostPct}% of those still watching).`; })() : '';
    const note = d.retentionNote === 'needs_permission'
      ? (st.canAsk ? 'To see where viewers stop watching, reconnect YouTube on the Connections page and allow analytics.' : 'Where viewers stop watching needs a YouTube permission we’ve asked Google for. It appears here once it’s approved.')
      : d.retentionNote === 'too_new' ? 'Where viewers stop watching shows once YouTube has enough views, usually a day or two after posting.' : '';
    return `<div class="border border-gray-200 rounded-lg p-2" data-vid-youtube="${v.id}">
        <div class="flex items-center gap-2"><p class="text-xs font-bold text-gray-800">On YouTube</p>
          <button type="button" data-vid-act="yt-refresh" data-id="${v.id}" class="ml-auto text-[11px] font-bold text-indigo-700 hover:underline" ${st.loading ? 'disabled' : ''}>${st.loading ? 'Checking…' : 'Check again'}</button></div>
        <p class="text-xs text-gray-800 mt-1"><b>${n(d.totals.views)}</b> views · <b>${n(d.totals.likes)}</b> likes · <b>${n(d.totals.comments)}</b> comments${d.averageViewS != null && dur ? ` · watched for ${Math.round(d.averageViewS)} s on average (${Math.min(100, Math.round((d.averageViewS / dur) * 100))}%)` : ''}</p>
        ${d.retention ? retentionSvg(d.retention, v.chapters, dur) : ''}
        ${drop ? `<p class="text-xs text-gray-800">${drop}${d.toEndPct != null ? ` ${d.toEndPct}% watch to the end.` : ''}</p>` : ''}
        ${note ? `<p class="text-[11px] text-gray-500 mt-1">${note}</p>` : ''}
        <p class="text-[11px] text-gray-500 mt-1">${d.posts.length > 1 ? `Across ${d.posts.length} posts. ` : ''}${d.posts[0]?.url ? `<a href="${esc(d.posts[0].url)}" target="_blank" rel="noopener" class="font-bold text-indigo-700 hover:underline">Open on YouTube</a> · ` : ''}checked ${esc(new Date(d.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</p>
      </div>`;
  }

  // The chapter playing is marked as the video plays (timeupdate doesn't bubble, so it's caught on the way down).
  document.addEventListener('timeupdate', (e) => {
    const p = e.target;
    if (!p || !p.matches || !p.matches('video[data-vid-player]') || !host() || !host().contains(p)) return;
    const box = host().querySelector(`[data-vid-chapters="${p.dataset.vidPlayer}"]`);
    if (!box) return;
    const t = p.currentTime;
    box.querySelectorAll('[data-vid-chapter]').forEach((li, k, all) => {
      const on = t >= Number(li.dataset.start) && (t < Number(li.dataset.end) || k === all.length - 1);
      li.classList.toggle('bg-indigo-50', on);
      if (on) li.setAttribute('aria-current', 'true'); else li.removeAttribute('aria-current');
    });
  }, true);

  document.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-vid-stage]');
    if (pill && host() && host().contains(pill)) {
      state.stage = pill.dataset.vidStage; state.userStage = true; state.selected.clear(); state.bulkNote = null; render();
      host()?.querySelector(`[data-vid-stage="${state.stage}"]`)?.focus();
      return;
    }
    const strip = e.target.closest('[data-vid-strip]');
    if (strip && host() && host().contains(strip)) {
      const v = state.videos.find((x) => x.id === Number(strip.dataset.vidStrip));
      if (!v) return;
      const times = (v && v.sceneTimes) || [];
      const total = (v && v.outputDurationS) || (times.length ? times[times.length - 1].endS : 0);
      const r = strip.getBoundingClientRect();
      const at = Math.max(0, Math.min(total, ((e.clientX - r.left) / Math.max(1, r.width)) * total));
      const p = host()?.querySelector(`[data-vid-player="${v.id}"]`);
      if (p) { try { p.pause(); p.currentTime = at; } catch { /* not loaded yet */ } }
      openNote(v.id, at);
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
      case 'pick-all': {
        const pickable = inStage(state.stage).filter((v) => !MAKING.includes(v.status));
        const all = pickable.every((v) => state.selected.has(v.id));
        state.selected.clear();
        if (!all) pickable.forEach((v) => state.selected.add(v.id));
        state.bulkNote = null; render();
        break;
      }
      case 'pick-none': state.selected.clear(); state.bulkNote = null; render(); break;
      case 'clip-new': state.clipForm = true; state.form = false; state.footage = null; render(); host()?.querySelector('[data-vid-clip-form] textarea')?.focus(); break;
      case 'clip-close': state.clipForm = false; render(); break;
      case 'clip-frame': state.opened.add(id); saveFolded(); act(id, { action: 'clip_frame', id }, 'Here’s the first frame. Make the clip from it, or try another.'); break;
      case 'record-video': {
        if (!window.VideoRecorder) break;
        const shape = host()?.querySelector('[data-vid-footage-form] [name="shape"]:checked, [data-vid-footage-form] select[name="shape"]')?.value || '9:16';
        window.VideoRecorder.open({ shape, onDone: (file) => { if (file) addFootageFiles([file]); } });
        break;
      }
      case 'voice-mode': {
        const own = b.dataset.mode === 'own';
        act(id, { action: 'set_options', id, voiceMode: own ? 'own' : 'ai' }, own ? 'Your own voice. Approve the script, then record each line.' : 'An AI voice reads it — made when you press “Make the video”, which shows what it uses.');
        break;
      }
      case 'voice-record': {
        const v = state.videos.find((x) => x.id === id);
        const s = v && v.storyboard.scenes.find((x) => x.id === b.dataset.scene);
        if (!s) break;
        if (!window.AudioRecorder) { state.notes[id] = { text: 'The recorder didn’t load. Upload a recording instead.', error: true }; render(); break; }
        window.AudioRecorder.open({ title: `Scene ${v.storyboard.scenes.indexOf(s) + 1} — read this line`, script: s.voiceover, onDone: (file) => { if (file) attachVoice(id, s.id, file); } });
        break;
      }
      case 'voice-upload': case 'voice-whole-upload': {
        state.voicePick = { id, sceneId: b.dataset.vidAct === 'voice-upload' ? b.dataset.scene : null };
        host()?.querySelector(`[data-vid-voice-file][data-id="${id}"]`)?.click();
        break;
      }
      case 'voice-remove': act(id, { action: 'set_line_voice', id, sceneId: b.dataset.scene, assetId: null }, 'Recording removed — it stays in My Content.'); break;
      case 'voice-whole-remove': act(id, { action: 'set_voice_file', id, assetId: null }, 'Removed. Record each line below.'); break;
      case 'bulk-archive': bulk('archive'); break;
      case 'bulk-restore': bulk('restore'); break;
      case 'bulk-delete': bulk('delete'); break;
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
      case 'build': act(id, { action: 'build', id }, 'Making the video — it’s saved to My Content when it’s done.'); break;
      case 'rerender': act(id, { action: 'rerender', id }, 'Rendering the finished video again — a few minutes.'); break;
      case 'change': changeVideo(id); break;
      case 'cancel': act(id, { action: 'cancel', id }, null); break;
      case 'approve-script': act(id, { action: 'approve_script', id }, 'Script approved. Now check the pictures, then press “Make the video”.'); break;
      case 'rewrite': state.rewriting = id; render(); host()?.querySelector('[data-vid-rewrite-form] textarea')?.focus(); break;
      case 'cancel-rewrite': state.rewriting = null; render(); break;
      case 'another-track': act(id, { action: 'set_options', id, anotherTrack: true }, 'A new track will be made when you press “Make the video” — it shows what it uses.'); break;
      case 'note-here': {
        const p = host()?.querySelector(`[data-vid-player="${id}"]`);
        openNote(id, p ? p.currentTime : 0);
        break;
      }
      case 'cancel-note': state.noting = null; render(); break;
      case 'seek': {
        const p = host()?.querySelector(`[data-vid-player="${id}"]`);
        if (p) { p.currentTime = Number(b.dataset.at) || 0; p.focus(); }
        break;
      }
      case 'skip': {
        const p = host()?.querySelector(`[data-vid-player="${id}"]`);
        if (p) {
          const end = Number.isFinite(p.duration) ? p.duration : Infinity;
          try { p.currentTime = Math.max(0, Math.min(end, p.currentTime + (Number(b.dataset.by) || 0))); } catch { /* not loaded yet */ }
        }
        break;
      }
      case 'rename-chapter':
        state.renamingChapter = { id, sceneId: b.dataset.scene }; render();
        host()?.querySelector('[data-vid-chapter-form] input')?.focus();
        break;
      case 'cancel-chapter': state.renamingChapter = null; render(); break;
      case 'translate': {
        const sel = host()?.querySelector(`[data-vid-lang="${id}"]`);
        const code = sel ? sel.value : '';
        const name = (state.captionLanguages || {})[code] || code;
        if (code) act(id, { action: 'translate_captions', id, language: code }, `${name} captions are ready to download.`);
        break;
      }
      case 'remove-translation': act(id, { action: 'remove_translation', id, language: b.dataset.lang }, null); break;
      case 'yt-refresh': loadYouTube(id, true); render(); break;
      case 'copy-chapters': {
        const v = state.videos.find((x) => x.id === id);
        if (!v || !v.youtubeChapters) break;
        const done = (ok) => { state.notes[id] = { text: ok ? 'Chapters copied — paste them at the end of a YouTube description.' : 'Couldn’t copy. Select the chapters and copy them yourself.', error: !ok }; render(); };
        (navigator.clipboard ? navigator.clipboard.writeText(v.youtubeChapters) : Promise.reject()).then(() => done(true), () => done(false));
        break;
      }
      case 'delete-note': act(id, { action: 'delete_note', id, noteId: b.dataset.note }, null); break;
      case 'notes-version': versionFromNotes(id); break;
      case 'reshape': act(id, { action: 'reshape', id }, 'Making it in the other shapes — they appear under “Being made”, and in My Content when they’re done.'); break;
      // This page has no Review Queue tab since 2026-11-10: an old-way video's post is approved on
      // the workspace Review page, which lists every assistant's waiting work.
      case 'open-review': window.loadView?.('review-queue'); break;
    }
  });

  // Ticking a video in the footage form; adding files to it.
  // The scene text preview follows the form as it's typed and chosen.
  document.addEventListener('input', (e) => {
    const f = e.target.closest && e.target.closest('[data-vid-scene-form]');
    if (f && host() && host().contains(f) && (e.target.matches('[data-vid-text-input]') || e.target.matches('[data-vid-text-opt]'))) paintTextPreview(f);
  });
  // Moving scenes play while pointed at (and on a tap), so they don't read as still pictures.
  document.addEventListener('mouseover', (e) => {
    const vid = e.target.closest && e.target.closest('video[data-vid-hoverplay]');
    if (vid && host() && host().contains(vid)) vid.play().catch(() => {});
  });
  document.addEventListener('mouseout', (e) => {
    const vid = e.target.closest && e.target.closest('video[data-vid-hoverplay]');
    if (vid && host() && host().contains(vid) && !vid.contains(e.relatedTarget)) vid.pause();
  });
  document.addEventListener('click', (e) => {
    const vid = e.target.closest && e.target.closest('video[data-vid-hoverplay]');
    if (vid && host() && host().contains(vid)) { if (vid.paused) vid.play().catch(() => {}); else vid.pause(); }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    // The clip form: "With sound" only for styles whose model can make it.
    if (host() && host().contains(t) && t.matches('[data-vid-clip-form] select[name="style"]')) {
      const row = t.form.querySelector('[data-vid-clip-sound]');
      const can = !!state.clipSound[t.value];
      if (row) { row.classList.toggle('hidden', !can); row.classList.toggle('flex', can); if (!can) row.querySelector('input').checked = false; }
      return;
    }
    if (host() && host().contains(t) && t.matches('[data-vid-voice-file]')) {
      const file = t.files && t.files[0];
      const pick = state.voicePick;
      t.value = '';
      if (file && pick) attachVoice(pick.id, pick.sceneId, file);
      return;
    }
    if (host() && host().contains(t) && t.matches('[data-vid-pick]')) {
      const id = Number(t.dataset.vidPick);
      if (t.checked) state.selected.add(id); else state.selected.delete(id);
      state.bulkNote = null; render();
      host()?.querySelector(`[data-vid-pick="${id}"]`)?.focus();
      return;
    }
    if (host() && host().contains(t) && t.matches('[data-vid-music-mood]')) {
      // The brief form: the track list shows only for "A track from My Content".
      const pick = t.closest('label')?.querySelector('[data-vid-mine-pick]');
      if (pick) pick.hidden = t.value !== 'mine';
      return;
    }
    if (host() && host().contains(t) && t.matches('[data-vid-opt]')) {
      const id = Number(t.dataset.id);
      // "A track from My Content" needs a track before anything is saved: show the list first.
      if (t.dataset.vidOpt === 'musicMood' && t.value === 'mine') { state.mineOpen.add(id); render(); return; }
      if (t.dataset.vidOpt === 'musicMood') state.mineOpen.delete(id);
      if (t.dataset.vidOpt === 'musicAssetId' && !t.value) return;
      const value = t.dataset.vidOpt === 'musicAssetId' ? Number(t.value) : t.value;
      const v = state.videos.find((x) => x.id === id);
      act(id, { action: 'set_options', id, [t.dataset.vidOpt]: value }, v && v.status === 'render_failed'
        ? 'Saved. Press “Make the video” — it’s free, as everything is already made.'
        : 'Saved — it’s used when the video is made.');
      return;
    }
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
        ...(voice && fd.get('ownVoice') ? { ownVoice: true } : {}),
        captions: !!fd.get('captions'), ...(captionStyle ? { captionStyle } : {}),
        shape: String(fd.get('shape') || '9:16'), ...briefExtras(fd),
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
    } else if (f.matches('[data-vid-clip-form]')) {
      e.preventDefault();
      const fd = new FormData(f);
      const msg = f.querySelector('[data-vid-clip-msg]');
      f.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      try {
        const data = await call('POST', { action: 'clip_create', assistantId: state.assistantId, description: String(fd.get('description') || ''), style: String(fd.get('style')), lengthS: Number(fd.get('lengthS')), shape: String(fd.get('shape')), sound: !!fd.get('sound') && !!state.clipSound[String(fd.get('style'))] });
        state.clipForm = false;
        if (data.project && data.project.id) { state.opened.add(data.project.id); saveFolded(); }
        state.stage = 'check'; state.userStage = true;
        await load();
      } catch (err) {
        if (msg) { msg.textContent = err.message; msg.classList.remove('hidden'); }
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
        nameCaption: String(fd.get('ncName') || '').trim() ? { name: String(fd.get('ncName')), role: String(fd.get('ncRole') || '') } : null,
        // A branded card draws its words into the picture: only the words apply there.
        ...textPatch(f, fd),
      };
      const id = Number(f.dataset.id);
      state.editing = null;
      act(id, { action: 'edit_scene', id, sceneId: f.dataset.scene, patch }, 'Scene saved.');
    } else if (f.matches('[data-vid-rewrite-form]')) {
      e.preventDefault();
      const id = Number(f.dataset.id);
      state.rewriting = null;
      act(id, { action: 'rewrite_script', id, feedback: String(new FormData(f).get('feedback') || '') }, 'Rewriting the words — about a minute. Every scene keeps its picture.');
    } else if (f.matches('[data-vid-note-form]')) {
      e.preventDefault();
      const id = Number(f.dataset.id);
      const n = state.noting;
      state.noting = null;
      act(id, { action: 'add_note', id, atS: n ? n.atS : 0, text: String(new FormData(f).get('text') || '') }, 'Note saved. Add more, then press “Make a new version from my notes”.');
    } else if (f.matches('[data-vid-chapter-form]')) {
      e.preventDefault();
      const id = Number(f.dataset.id);
      state.renamingChapter = null;
      act(id, { action: 'rename_chapter', id, sceneId: f.dataset.scene, title: String(new FormData(f).get('title') || '') }, 'Chapter renamed.');
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
      state.rendered = false; state.form = false; state.footage = null; state.editing = null; state.replanning = null; state.rewriting = null; state.noting = null; state.notes = {};
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
