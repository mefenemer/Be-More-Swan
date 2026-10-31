/**
 * src/components/assistant-videos.js
 * The Video Producer's Videos tab — docs/video-producer-plan.md §5.2–5.8.
 *
 * A video goes: brief → storyboard (planned in the background, free) → the owner checks every scene,
 * changes any, or plans it again with notes → "Make the video" (states the credits first) → a finished
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
  const VOICES = [
    ['coral', 'Warm and friendly'], ['sage', 'Calm and clear'], ['verse', 'Bright and upbeat'],
    ['alloy', 'Neutral and steady'], ['onyx', 'Deep and confident'], ['shimmer', 'Light and lively'],
  ];
  const WAITING = {
    planning: 'Writing the storyboard — about a minute.',
    planned: 'Storyboard ready. Check the scenes, then press “Make the video”.',
    building: 'Making the video — a few minutes. You can leave this page.',
    built: 'Made. It’s in the Review Queue waiting for your approval.',
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
  };

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
        ? (data.unit === 'tasks' ? 'Your monthly tasks are used up — they reset on the 1st.' : `You need ${data.cost} credits for this video and have ${data.balance}.`)
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
    const el = document.getElementById('videos-review-badge');
    if (!el) return;
    const n = state.videos.filter((v) => v.status === 'planned').length;
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
      voice: VOICES.some(([id]) => id === s.defaultVoice) ? s.defaultVoice : VOICES[0][0],
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
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Voice</span>
            <select name="voice" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2">${VOICES.map(([id, l]) => `<option value="${id}"${sel(d.voice === id)}>${esc(l)}</option>`).join('')}<option value="">No voiceover — on-screen text only</option></select></label>
          <label class="block"><span class="block text-xs font-bold text-gray-600 mb-1">Pictures from</span>
            <select name="allowAi" class="w-full text-sm border border-gray-300 rounded-lg px-2 py-2"><option value="stock_and_ai"${sel(d.allowAi === 'stock_and_ai')}>Stock first, AI where it fits</option><option value="stock_only"${sel(d.allowAi === 'stock_only')}>Stock and my own pictures only</option><option value="ai_first"${sel(d.allowAi === 'ai_first')}>Lean on AI</option></select></label>
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
          ${editable ? `<button type="button" data-vid-act="edit-scene" data-id="${v.id}" data-scene="${esc(s.id)}" class="mt-1 text-xs font-bold text-indigo-700 hover:underline cursor-pointer">Change</button>` : ''}
        </div>
      </li>`;
  }

  function videoHtml(v) {
    const sb = v.storyboard;
    const busy = state.busy.has(v.id);
    const canMake = (v.status === 'planned' || v.status === 'failed') && sb && sb.scenes && sb.scenes.length >= 3;
    const cost = v.estimate == null ? '' : (v.estimate === 0 ? ' — free' : ` — uses ${v.estimate} credit${v.estimate === 1 ? '' : 's'}`);
    const replanning = state.replanning === v.id;
    const note = state.notes[v.id];
    return `
      <article class="bg-white border border-gray-200 rounded-xl p-4" data-video="${v.id}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-bold text-gray-900 break-words">${esc(v.title)}</p>
            <p class="text-xs text-gray-600 mt-0.5">${ORIGIN[v.origin] ? `${esc(ORIGIN[v.origin])} · ` : ''}${esc((v.brief && v.brief.lengthS) || '')}s · ${esc(WAITING[v.status] || v.status)}</p>
            ${v.note ? `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mt-1.5">${esc(v.note)}</p>` : ''}
            ${note ? `<p class="text-xs font-semibold mt-1.5 ${note.error ? 'text-red-600' : 'text-gray-700'}">${esc(note.text)}</p>` : ''}
          </div>
          ${v.status === 'built' ? `<button type="button" data-vid-act="open-review" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg shrink-0">Open the Review Queue</button>` : ''}
        </div>
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
      </article>`;
  }

  function render() {
    const el = host();
    if (!el) return;
    const visible = state.videos.filter((v) => v.status !== 'cancelled');
    el.innerHTML = `
      <div class="flex items-center justify-between gap-3 mb-4">
        <p class="text-sm text-gray-600">Short vertical videos for Reels, Shorts and Facebook — planned, voiced and captioned by ${who()}.</p>
        ${state.form ? '' : '<button type="button" data-vid-act="new" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg shrink-0">New video</button>'}
      </div>
      ${formHtml()}
      ${!state.loaded ? '<p class="text-sm text-gray-500">Loading your videos…</p>'
        : state.loadError ? `<p class="text-sm text-red-600">Your videos couldn’t be loaded: ${esc(state.loadError)}</p>`
        : visible.length ? `<div class="space-y-4">${visible.map(videoHtml).join('')}</div>`
        : `<div class="text-center py-10 text-sm text-gray-500">No videos yet. Press “New video”, or tell ${who()} in chat what you’d like a video about.</div>`}`;
  }

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
    const b = e.target.closest('[data-vid-act]');
    if (!b || !host() || !host().contains(b)) return;
    const id = Number(b.dataset.id);
    switch (b.dataset.vidAct) {
      case 'new': state.form = true; render(); break;
      case 'close-form': state.form = false; render(); break;
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
      const voice = String(fd.get('voice') || '');
      const brief = {
        message: String(fd.get('message') || ''), lengthS: Number(fd.get('lengthS')), cta: String(fd.get('cta') || ''),
        voiceover: !!voice, voice: voice || undefined, allowAi: String(fd.get('allowAi') || 'stock_and_ai'),
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

  window.AssistantVideos = {
    init({ assistantId, assistantName, setup }) {
      state.assistantId = assistantId;
      state.assistantName = assistantName || null;
      state.setup = setup && typeof setup === 'object' ? setup : {};
      state.rendered = false; state.form = false; state.editing = null; state.replanning = null; state.notes = {};
      load();   // eager: the planned count is the tab badge
    },
    activate() {
      if (state.rendered) return;
      state.rendered = true;
      render();
    },
  };
})();
