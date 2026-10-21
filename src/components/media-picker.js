/**
 * src/components/media-picker.js — "Choose picture": one window with every way a picture (or video)
 * reaches a website, the same four the other assistants offer (owner, 2026-10-17):
 *
 *   Your files — upload one (button, drag and drop, or paste), or pick one already in the library
 *   Stock      — "Ask <assistant> to find stock": Pexels photos and videos (pexels-search.ts, save)
 *   Create     — "Ask <assistant> to create one": AI pictures (four to choose from) and AI videos
 *                (generate-ai-image.ts / generate-ai-video.ts — they charge, gate and moderate)
 *
 *   window.MediaPicker.open({ title?, onPick(asset), video?, topic?, assistantName? })
 *   window.MediaPicker.open({ title?, multiple: true, onPickMany(assets), video?, … })   a gallery
 *     asset = { id, url, name, video }  — every source ends as a content_asset in the library, so a
 *     site only ever uses the workspace's own pictures (site-store.ts verifySiteAssets).
 *   video: true lets videos be chosen too (hero, text and gallery pictures; never a logo).
 *   topic: what the picture is for — the stock search and the AI prompt start from it.
 *
 * Used by the Website Assistant's editor (assistant-site-editor.js). Uploads go through the
 * workspace's own uploader (window.gpUploadContentAsset), which handles moderation — a flagged
 * picture is refused here with the reason. Handlers are bound to the window's own elements when it
 * opens (it is created per open and removed on close), never to the page. Server values are escaped.
 */
(function () {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAX_BYTES = 20 * 1024 * 1024;
  const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
  const VIDEO_POLL_MS = 5000;

  async function api(name, init) {
    const r = await fetch(`/.netlify/functions/${name}`, { credentials: 'same-origin', ...(init || {}), headers: { 'Content-Type': 'application/json', ...((init && init.headers) || {}) } });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  }

  async function upload(file, allowVideo) {
    const isVideo = !!file && /^video\//.test(file.type);
    if (!file || !(/^image\//.test(file.type) || (allowVideo && isVideo))) throw new Error(allowVideo ? 'That isn\'t a picture or a video. Choose a JPG, PNG, WebP, GIF or MP4.' : 'That isn\'t a picture. Choose a JPG, PNG, WebP or GIF.');
    if (file.size > (isVideo ? MAX_VIDEO_BYTES : MAX_BYTES)) throw new Error(isVideo ? 'That video is too large (the limit is 200 MB).' : 'That picture is too large (the limit is 20 MB).');
    if (typeof window.gpUploadContentAsset === 'function') {
      const a = await window.gpUploadContentAsset(file);
      if (a && a.status === 'rejected') throw new Error(a.rejectionReason || 'That file was flagged and can\'t be used.');
      return { id: a.id, url: a.storageUrl || a.externalUrl || '', name: a.name || file.name, video: isVideo };
    }
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
      body: JSON.stringify({ name: file.name, assetType: isVideo ? 'video' : 'image', mimeType: file.type, fileSize: file.size, storageKey: j.storageKey, storageUrl: j.storageUrl }),
    });
    const d = await c.json().catch(() => ({}));
    if (!c.ok) throw new Error(d.error || 'The upload failed. Please try again.');
    if (d.rejected) throw new Error((d.asset && d.asset.rejectionReason) || 'That file was flagged and can\'t be used.');
    return { id: d.asset.id, url: d.asset.storageUrl || d.asset.externalUrl || '', name: d.asset.name || file.name, video: isVideo };
  }

  // A tile: a picture, or a video that plays silently on hover.
  const tileMedia = (url, video) => (video
    ? `<span style="position:relative;display:block"><video src="${esc(url)}" muted loop playsinline preload="metadata" style="width:100%;height:90px;object-fit:cover;display:block;background:#111"></video><span style="position:absolute;left:6px;bottom:6px;background:rgba(0,0,0,.65);color:#fff;font-size:10px;font-weight:700;border-radius:4px;padding:1px 5px">▶ Video</span></span>`
    : `<img src="${esc(url)}" alt="" loading="lazy" style="width:100%;height:90px;object-fit:cover;display:block">`);

  function open(opts) {
    opts = opts || {};
    const onPick = opts.onPick || function () {};
    const multiple = !!opts.multiple;
    const allowVideo = !!opts.video;
    const who = opts.assistantName || 'your assistant';
    const noun = allowVideo ? 'picture or video' : 'picture';
    const chosen = [];   // multiple: the assets ticked or uploaded, in order
    document.getElementById('bms-media-picker')?.remove();
    const back = document.createElement('div');
    back.id = 'bms-media-picker';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-label', opts.title || `Choose a ${noun}`);
    back.style.cssText = 'position:fixed;inset:0;z-index:11000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:1rem;';
    const tabBtn = (k, label) => `<button type="button" data-mp-tab="${k}" class="px-3 py-1.5 text-xs font-bold rounded-lg border">${esc(label)}</button>`;
    const kindToggle = (name) => (allowVideo ? `<div class="inline-flex gap-1" role="group">
        <button type="button" data-mp-kind="${name}" data-value="image" class="px-2.5 py-1 text-xs font-bold rounded-lg border">Pictures</button>
        <button type="button" data-mp-kind="${name}" data-value="video" class="px-2.5 py-1 text-xs font-bold rounded-lg border">Videos</button></div>` : '');
    back.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full" style="max-width:760px;max-height:90vh;display:flex;flex-direction:column">
        <div class="flex items-center justify-between gap-2 px-5 py-4 border-b border-gray-100">
          <p class="text-sm font-black text-gray-900">${esc(opts.title || `Choose a ${noun}`)}</p>
          <button type="button" data-mp-close class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">Close</button>
        </div>
        <div class="flex flex-wrap gap-2 px-5 pt-4">${tabBtn('files', 'Upload or library')}${tabBtn('stock', `Ask ${who} to find stock`)}${tabBtn('ai', `Ask ${who} to create one`)}</div>
        <p data-mp-msg class="text-xs font-semibold px-5 mt-2" role="status"></p>
        <div class="px-5 pb-5 pt-2 overflow-y-auto" style="min-height:0">
          <div data-mp-pane="files">
            <label data-mp-drop class="block border-2 border-dashed border-gray-300 rounded-xl p-5 text-center cursor-pointer">
              <input type="file" accept="${allowVideo ? 'image/*,video/mp4,video/webm,video/quicktime' : 'image/*'}" hidden data-mp-file ${multiple ? 'multiple' : ''}>
              <span class="block text-sm font-bold text-gray-800">Upload your own ${multiple ? (allowVideo ? 'pictures or videos' : 'pictures') : noun}</span>
              <span class="block text-xs text-gray-500 mt-1">Click to choose, drag it here, or paste it. It's saved to your library too.</span>
            </label>
            <p class="text-xs font-bold text-gray-700 mt-4 mb-2">Or choose from your library</p>
            <div data-mp-grid class="grid gap-2" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))"><p class="text-xs text-gray-500">Loading your library…</p></div>
          </div>
          <div data-mp-pane="stock" hidden>
            <p class="text-xs text-gray-500">Free-to-use photos${allowVideo ? ' and videos' : ''} from Pexels. The one you choose is saved to your library.</p>
            <div class="flex flex-wrap items-center gap-2 mt-2">
              <input data-mp-stock-q class="flex-1 min-w-0 text-sm border border-gray-300 rounded-lg px-3 py-2" placeholder="What should it show? e.g. a calm hair salon" value="${esc(opts.topic || '')}">
              ${kindToggle('stock')}
              <button type="button" data-mp-stock-go class="btn-primary px-3 py-2 text-xs font-bold rounded-lg">Search</button>
            </div>
            <div data-mp-stock-grid class="grid gap-2 mt-3" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))"></div>
            <div class="mt-2"><button type="button" data-mp-stock-more hidden class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">Show different ones</button></div>
          </div>
          <div data-mp-pane="ai" hidden>
            <p data-mp-ai-note class="text-xs text-gray-500">Checking what you can create…</p>
            <div data-mp-ai-form hidden>
              <textarea data-mp-ai-prompt rows="3" maxlength="900" class="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 mt-2" placeholder="Describe it, e.g. warm morning light over a tidy salon chair, no people">${esc(opts.topic || '')}</textarea>
              <div class="flex flex-wrap items-center gap-2 mt-2">
                ${kindToggle('ai')}
                <select data-mp-ai-shape class="text-xs border border-gray-300 rounded-lg px-2 py-1.5">
                  <option value="16:9">Wide (16:9)</option><option value="1:1">Square</option><option value="4:5">Portrait (4:5)</option><option value="9:16">Tall (9:16)</option>
                </select>
                <button type="button" data-mp-ai-go class="btn-primary px-3 py-2 text-xs font-bold rounded-lg">Create</button>
                <span data-mp-ai-cost class="text-xs text-gray-500"></span>
              </div>
            </div>
            <div data-mp-ai-grid class="grid gap-2 mt-3" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))"></div>
          </div>
        </div>
        ${multiple ? `<div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100">
          <button type="button" data-mp-done class="btn-primary px-4 py-2 text-xs font-bold rounded-lg" disabled>Add pictures</button></div>` : ''}
      </div>`;
    document.body.appendChild(back);
    const $ = (sel) => back.querySelector(sel);

    let closed = false;
    const msg = $('[data-mp-msg]');
    const say = (text, bad) => { msg.textContent = text || ''; msg.className = `text-xs font-semibold px-5 mt-2 ${bad ? 'text-red-600' : 'text-gray-600'}`; };
    // Focus goes into the picker and comes back to the button that opened it (dialogs.js holdDialogFocus).
    const release = window.holdDialogFocus ? window.holdDialogFocus(back, $('[data-mp-close]')) : () => {};
    const close = () => { closed = true; back.remove(); document.removeEventListener('keydown', onKey); document.removeEventListener('paste', onPaste); release(); };
    const done = $('[data-mp-done]');
    const refreshDone = () => {
      if (!done) return;
      done.disabled = !chosen.length;
      done.textContent = chosen.length ? `Add ${chosen.length}` : 'Add pictures';
      back.querySelectorAll('[data-mp-asset]').forEach((el) => {
        const on = chosen.some((a) => String(a.id) === el.dataset.mpAsset);
        el.style.outline = on ? '3px solid #db2777' : '';
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    };
    const pick = (asset) => {
      if (!multiple) { close(); onPick(asset); return; }
      const i = chosen.findIndex((a) => a.id === asset.id);
      if (i >= 0) chosen.splice(i, 1); else chosen.push(asset);
      refreshDone();
      say(`${chosen.length} chosen — press "Add ${chosen.length}" when you're ready.`);
    };
    if (done) done.addEventListener('click', () => { const list = chosen.slice(); close(); (opts.onPickMany || function () {})(list); });

    // ── Tabs and the picture/video switches ──
    const kinds = { stock: 'image', ai: 'image' };
    const paintKinds = () => back.querySelectorAll('[data-mp-kind]').forEach((b) => {
      const on = kinds[b.dataset.mpKind] === b.dataset.value;
      b.className = `px-2.5 py-1 text-xs font-bold rounded-lg border ${on ? 'btn-primary' : 'btn-secondary'}`;
    });
    let aiCaps = null;
    const showTab = (k) => {
      back.querySelectorAll('[data-mp-tab]').forEach((b) => { b.className = `px-3 py-1.5 text-xs font-bold rounded-lg border ${b.dataset.mpTab === k ? 'btn-primary' : 'btn-secondary'}`; });
      back.querySelectorAll('[data-mp-pane]').forEach((p) => { p.hidden = p.dataset.mpPane !== k; });
      say('');
      if (k === 'ai' && !aiCaps) loadAiCaps();
    };
    back.querySelectorAll('[data-mp-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.mpTab)));
    back.querySelectorAll('[data-mp-kind]').forEach((b) => b.addEventListener('click', () => { kinds[b.dataset.mpKind] = b.dataset.value; paintKinds(); if (b.dataset.mpKind === 'ai') paintAi(); }));
    paintKinds();
    showTab('files');

    // ── Your files ──
    const doUpload = async (file) => {
      say('Uploading…');
      try { pick(await upload(file, allowVideo)); if (!multiple) return; } catch (err) { say(err.message || 'The upload failed.', true); }
    };
    const doUploads = async (files) => { for (const f of files) await doUpload(f); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const onPaste = (e) => {
      const item = [...((e.clipboardData && e.clipboardData.items) || [])].find((i) => i.kind === 'file' && /^image\//.test(i.type));
      if (item) { e.preventDefault(); doUpload(item.getAsFile()); }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('paste', onPaste);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    $('[data-mp-close]').addEventListener('click', close);
    $('[data-mp-file]').addEventListener('change', (e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; if (fs.length) doUploads(multiple ? fs : fs.slice(0, 1)); });
    const drop = $('[data-mp-drop]');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.style.borderColor = '#db2777'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.style.borderColor = ''; const fs = [...((e.dataTransfer && e.dataTransfer.files) || [])]; if (fs.length) doUploads(multiple ? fs : fs.slice(0, 1)); });

    const grid = $('[data-mp-grid]');
    fetch('/.netlify/functions/content-assets', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load your library.'))))
      .then((d) => {
        const groups = d.assets || {};
        const usable = [].concat(groups.pending || [], groups.scheduled || [], groups.posted || [])
          .filter((a) => (a.assetType === 'image' || (allowVideo && a.assetType === 'video')) && a.status !== 'rejected' && (a.storageUrl || a.externalUrl));
        if (!usable.length) { grid.innerHTML = `<p class="text-xs text-gray-500">Nothing in your library yet — upload one above, or ask ${esc(who)} to find or create one.</p>`; return; }
        grid.innerHTML = usable.map((a) => `
          <button type="button" data-mp-asset="${esc(a.id)}" class="text-left border border-gray-200 rounded-lg overflow-hidden hover:border-gray-400">
            ${tileMedia(a.storageUrl || a.externalUrl, a.assetType === 'video')}
            <span class="block text-xs text-gray-600 px-2 py-1 truncate">${esc(a.name || 'Untitled')}</span>
          </button>`).join('');
        grid.querySelectorAll('[data-mp-asset]').forEach((el) => el.addEventListener('click', () => {
          const a = usable.find((x) => String(x.id) === el.dataset.mpAsset);
          pick({ id: a.id, url: a.storageUrl || a.externalUrl || '', name: a.name || '', video: a.assetType === 'video' });
        }));
        refreshDone();
      })
      .catch((err) => { grid.innerHTML = `<p class="text-xs text-red-600">${esc(err.message)}</p>`; });
    back.addEventListener('mouseover', (e) => { const v = e.target.closest && e.target.closest('video'); if (v) v.play().catch(() => {}); });
    back.addEventListener('mouseout', (e) => { const v = e.target.closest && e.target.closest('video'); if (v) v.pause(); });

    // ── Stock (pexels-search.ts) ──
    const stock = { keywords: '', shown: [], candidates: [] };
    const stockGrid = $('[data-mp-stock-grid]');
    const more = $('[data-mp-stock-more]');
    async function searchStock(again) {
      const topic = $('[data-mp-stock-q]').value.trim();
      if (!topic) { say('Say what it should show first.', true); return; }
      const mediaType = kinds.stock;
      say(`${who} is looking…`);
      stockGrid.innerHTML = '';
      const res = await api('pexels-search', { method: 'POST', body: JSON.stringify(again && stock.keywords
        ? { topic, mediaType, dedup: false, keywords: stock.keywords, exclude: stock.shown }
        : { topic, mediaType, dedup: false }) });
      if (closed) return;
      if (!res.ok) { say((res.body && res.body.error) || 'The search didn\'t work. Please try again.', true); return; }
      stock.keywords = res.body.keywords || '';
      stock.candidates = res.body.candidates || [];
      stock.shown = [...new Set([...(again ? stock.shown : []), ...stock.candidates.map((c) => c.providerAssetId)])];
      more.hidden = !stock.candidates.length;
      if (!stock.candidates.length) { say('Nothing matched — try different words.'); return; }
      say(`Choose one. ${mediaType === 'video' ? 'Videos' : 'Photos'} by Pexels creators.`);
      stockGrid.innerHTML = stock.candidates.map((c, i) => `
        <button type="button" data-mp-stock-pick="${i}" class="text-left border border-gray-200 rounded-lg overflow-hidden hover:border-gray-400" title="${esc(c.photographer ? `By ${c.photographer} on Pexels` : c.title)}">
          ${tileMedia(c.url, mediaType === 'video')}
          <span class="block text-xs text-gray-600 px-2 py-1 truncate">${esc(c.photographer ? `By ${c.photographer}` : (c.title || ''))}</span>
        </button>`).join('');
    }
    $('[data-mp-stock-go]').addEventListener('click', () => searchStock(false));
    $('[data-mp-stock-q]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchStock(false); } });
    more.addEventListener('click', () => searchStock(true));
    stockGrid.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-mp-stock-pick]');
      if (!b) return;
      const c = stock.candidates[Number(b.dataset.mpStockPick)];
      const mediaType = kinds.stock;
      say('Saving it to your library…');
      const res = await api('pexels-search', { method: 'POST', body: JSON.stringify({ action: 'save', candidate: c, mediaType }) });
      if (closed) return;
      if (!res.ok || !res.body.assetId) { say((res.body && res.body.error) || 'It couldn\'t be saved. Please try again.', true); return; }
      pick({ id: res.body.assetId, url: c.url, name: c.title || '', video: mediaType === 'video' });
    });

    // ── Create with AI (generate-ai-image.ts / generate-ai-video.ts) ──
    const aiNote = $('[data-mp-ai-note]');
    const aiForm = $('[data-mp-ai-form]');
    const aiGrid = $('[data-mp-ai-grid]');
    const unitWord = (n, unit) => `${n} ${unit === 'tasks' ? (n === 1 ? 'task' : 'tasks') : (n === 1 ? 'credit' : 'credits')}`;
    async function loadAiCaps() {
      const res = await api('get-ai-credit-balance', { method: 'GET' });
      // A failed lookup means "not offered": the generate endpoints are the real gate.
      aiCaps = res.ok ? res.body : { canImage: false };
      if (!closed) paintAi();
    }
    function paintAi() {
      if (!aiCaps) return;
      const video = kinds.ai === 'video';
      const can = video ? !!(aiCaps.assistantCanVideo && aiCaps.tierCanVideo) : !!aiCaps.canImage;
      aiForm.hidden = !(aiCaps.canImage || aiCaps.assistantCanVideo);
      $('[data-mp-ai-shape]').hidden = video;
      $('[data-mp-ai-go]').disabled = !can;
      const cost = video ? aiCaps.videoCost : aiCaps.imageCost;
      $('[data-mp-ai-cost]').textContent = can && cost ? `Uses ${unitWord(cost, aiCaps.unit)}${video ? ' · a 6-second clip, ready in a few minutes' : ' · four to choose from'}` : '';
      aiNote.textContent = can ? `Describe what you want and ${who} creates it. It's checked before it's made, and saved to your library.`
        : video && aiCaps.assistantCanVideo && !aiCaps.tierCanVideo ? 'AI video is on the Busywork Buster and Digital Employee plans. You can still create pictures, or find a stock video.'
        : video ? 'None of your assistants can create videos. Find a stock video instead, or upload your own.'
        : 'None of your assistants can create pictures. Find a stock photo instead, or upload your own.';
    }
    const creditMessage = (b) => (b && b.unit === 'tasks'
      ? 'Your monthly tasks are used up — they reset on the 1st. Upgrade your plan for more.'
      : 'You don\'t have enough credits to create this. Upgrade your plan for more.');
    $('[data-mp-ai-go]').addEventListener('click', async () => {
      const prompt = $('[data-mp-ai-prompt]').value.trim();
      if (!prompt) { say('Describe what it should show first.', true); return; }
      const go = $('[data-mp-ai-go]');
      go.disabled = true;
      aiGrid.innerHTML = '';
      try {
        if (kinds.ai === 'video') await createVideo(prompt);
        else await createImage(prompt);
      } finally { if (!closed) { go.disabled = false; paintAi(); } }
    });
    async function createImage(prompt) {
      say(`${who} is creating four for you to choose from…`);
      const res = await api('generate-ai-image', { method: 'POST', body: JSON.stringify({ prompt, aspectRatio: $('[data-mp-ai-shape]').value }) });
      if (closed) return;
      if (!res.ok) { say(res.body && res.body.error === 'insufficient_credits' ? creditMessage(res.body) : (res.body && (res.body.message || res.body.error)) || 'It couldn\'t be created. Please try again.', true); return; }
      say('Choose the one you like — it\'s saved to your library.');
      const jobId = res.body.jobId;
      aiGrid.innerHTML = (res.body.images || []).map((im) => `
        <button type="button" data-mp-ai-pick="${esc(im.index)}" data-job="${esc(jobId)}" data-url="${esc(im.url)}" class="border border-gray-200 rounded-lg overflow-hidden hover:border-gray-400">
          <img src="${esc(im.url)}" alt="" style="width:100%;height:120px;object-fit:cover;display:block"></button>`).join('');
    }
    aiGrid.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-mp-ai-pick]');
      if (!b) return;
      say('Saving it to your library…');
      const res = await api('generate-ai-image', { method: 'POST', body: JSON.stringify({ action: 'select', jobId: Number(b.dataset.job), index: Number(b.dataset.mpAiPick) }) });
      if (closed) return;
      if (!res.ok || !res.body.assetId) { say((res.body && res.body.error) || 'It couldn\'t be saved. Please try again.', true); return; }
      pick({ id: res.body.assetId, url: b.dataset.url, name: $('[data-mp-ai-prompt]').value.trim().slice(0, 80), video: false });
    });
    async function createVideo(prompt) {
      say(`${who} has started your video — this takes a few minutes. You can keep this open.`);
      const res = await api('generate-ai-video', { method: 'POST', body: JSON.stringify({ prompt, aspectRatio: '16:9', durationSeconds: 6 }) });
      if (closed) return;
      if (!res.ok) { say(res.body && res.body.error === 'insufficient_credits' ? creditMessage(res.body) : (res.body && (res.body.message || res.body.error)) || 'It couldn\'t be started. Please try again.', true); return; }
      const jobId = res.body.jobId;
      for (;;) {
        await new Promise((r) => setTimeout(r, VIDEO_POLL_MS));
        if (closed) return;   // it carries on; it lands in the library when done
        const st = await api(`generate-ai-video?jobId=${encodeURIComponent(jobId)}`, { method: 'GET' });
        if (closed) return;
        if (!st.ok) { say((st.body && st.body.error) || 'Lost track of the video — it will be in your library when it\'s ready.', true); return; }
        if (st.body.status === 'completed' && st.body.assetId) {
          say('Ready. Choose it to use it — it\'s in your library too.');
          aiGrid.innerHTML = `<button type="button" data-mp-ai-video="${esc(st.body.assetId)}" class="border border-gray-200 rounded-lg overflow-hidden hover:border-gray-400">${tileMedia(st.body.videoUrl || '', true)}</button>`;
          aiGrid.querySelector('[data-mp-ai-video]').addEventListener('click', () => pick({ id: st.body.assetId, url: st.body.videoUrl || '', name: prompt.slice(0, 80), video: true }));
          return;
        }
        if (st.body.status === 'failed' || st.body.status === 'flagged') { say(st.body.errorMessage || 'The video couldn\'t be made. Nothing was charged.', true); return; }
      }
    }
  }

  window.MediaPicker = { open, upload };
})();
