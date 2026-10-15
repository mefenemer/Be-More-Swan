/**
 * src/components/media-picker.js — "Choose picture": one window to upload a picture (button, drag and
 * drop, or paste) or pick one already in the workspace's library.
 *
 *   window.MediaPicker.open({ title?, onPick(asset) })   asset = { id, url, name }
 *   window.MediaPicker.open({ title?, multiple: true, onPickMany(assets) })   several at once (a gallery):
 *     library tiles toggle, uploads are added to the choice, and "Add N pictures" hands them over.
 *
 * Used by the Website Assistant's editor (assistant-site-editor.js) for every picture on a site. The
 * library is content_assets (the same one Email Studio and the post editor use), so a picture
 * uploaded once can be used anywhere. Uploads go through the workspace's own uploader
 * (window.gpUploadContentAsset), which handles moderation — a flagged picture is refused here with
 * the reason, and never reaches a site.
 *
 * Handlers are bound to the window's own elements when it opens (it is created per open and removed
 * on close), never to the page. Values from the server are escaped.
 */
(function () {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAX_BYTES = 20 * 1024 * 1024;

  async function upload(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error('That isn\'t a picture. Choose a JPG, PNG, WebP or GIF.');
    if (file.size > MAX_BYTES) throw new Error('That picture is too large (the limit is 20 MB).');
    if (typeof window.gpUploadContentAsset === 'function') {
      const a = await window.gpUploadContentAsset(file);
      if (a && a.status === 'rejected') throw new Error(a.rejectionReason || 'That picture was flagged and can\'t be used.');
      return { id: a.id, url: a.storageUrl || a.externalUrl || '', name: a.name || file.name };
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
      body: JSON.stringify({ name: file.name, assetType: 'image', mimeType: file.type, fileSize: file.size, storageKey: j.storageKey, storageUrl: j.storageUrl }),
    });
    const d = await c.json().catch(() => ({}));
    if (!c.ok) throw new Error(d.error || 'The upload failed. Please try again.');
    if (d.rejected) throw new Error((d.asset && d.asset.rejectionReason) || 'That picture was flagged and can\'t be used.');
    return { id: d.asset.id, url: d.asset.storageUrl || d.asset.externalUrl || '', name: d.asset.name || file.name };
  }

  function open(opts) {
    const onPick = (opts && opts.onPick) || function () {};
    const multiple = !!(opts && opts.multiple);
    const chosen = [];   // multiple: the assets ticked or uploaded, in order
    document.getElementById('bms-media-picker')?.remove();
    const back = document.createElement('div');
    back.id = 'bms-media-picker';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-label', (opts && opts.title) || 'Choose a picture');
    back.style.cssText = 'position:fixed;inset:0;z-index:11000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:1rem;';
    back.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full" style="max-width:720px;max-height:88vh;display:flex;flex-direction:column">
        <div class="flex items-center justify-between gap-2 px-5 py-4 border-b border-gray-100">
          <p class="text-sm font-black text-gray-900">${esc((opts && opts.title) || 'Choose a picture')}</p>
          <button type="button" data-mp-close class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">Close</button>
        </div>
        <div class="px-5 pt-4">
          <label data-mp-drop class="block border-2 border-dashed border-gray-300 rounded-xl p-5 text-center cursor-pointer">
            <input type="file" accept="image/*" hidden data-mp-file ${multiple ? 'multiple' : ''}>
            <span class="block text-sm font-bold text-gray-800">${multiple ? 'Upload pictures' : 'Upload a picture'}</span>
            <span class="block text-xs text-gray-500 mt-1">Click to choose one, drag it here, or paste it. It's saved to your library too.</span>
          </label>
          <p data-mp-msg class="text-xs font-semibold mt-2" role="status"></p>
        </div>
        <div class="px-5 pb-5 pt-2 overflow-y-auto" style="min-height:0">
          <p class="text-xs font-bold text-gray-700 mb-2">Or choose from your library</p>
          <div data-mp-grid class="grid gap-2" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))"><p class="text-xs text-gray-500">Loading your library…</p></div>
        </div>
        ${multiple ? `<div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100">
          <button type="button" data-mp-done class="btn-primary px-4 py-2 text-xs font-bold rounded-lg" disabled>Add pictures</button></div>` : ''}
      </div>`;
    document.body.appendChild(back);

    const msg = back.querySelector('[data-mp-msg]');
    const say = (text, bad) => { msg.textContent = text || ''; msg.className = `text-xs font-semibold mt-2 ${bad ? 'text-red-600' : 'text-gray-600'}`; };
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); document.removeEventListener('paste', onPaste); };
    const done = back.querySelector('[data-mp-done]');
    const refreshDone = () => {
      if (!done) return;
      done.disabled = !chosen.length;
      done.textContent = chosen.length ? `Add ${chosen.length} picture${chosen.length === 1 ? '' : 's'}` : 'Add pictures';
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
    };
    if (done) done.addEventListener('click', () => { const list = chosen.slice(); close(); ((opts && opts.onPickMany) || function () {})(list); });
    const doUpload = async (file) => {
      say('Uploading…');
      try { pick(await upload(file)); say(multiple ? 'Uploaded — added to your choice.' : ''); } catch (err) { say(err.message || 'The upload failed.', true); }
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
    back.querySelector('[data-mp-close]').addEventListener('click', close);
    back.querySelector('[data-mp-file]').addEventListener('change', (e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; if (fs.length) doUploads(multiple ? fs : fs.slice(0, 1)); });
    const drop = back.querySelector('[data-mp-drop]');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.style.borderColor = '#db2777'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.style.borderColor = ''; const fs = [...((e.dataTransfer && e.dataTransfer.files) || [])]; if (fs.length) doUploads(multiple ? fs : fs.slice(0, 1)); });

    const grid = back.querySelector('[data-mp-grid]');
    fetch('/.netlify/functions/content-assets', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load your library.'))))
      .then((d) => {
        const groups = d.assets || {};
        const images = [].concat(groups.pending || [], groups.scheduled || [], groups.posted || [])
          .filter((a) => a.assetType === 'image' && a.status !== 'rejected' && (a.storageUrl || a.externalUrl));
        if (!images.length) { grid.innerHTML = '<p class="text-xs text-gray-500">Nothing in your library yet — upload a picture above.</p>'; return; }
        grid.innerHTML = images.map((a) => `
          <button type="button" data-mp-asset="${esc(a.id)}" class="text-left border border-gray-200 rounded-lg overflow-hidden hover:border-gray-400">
            <img src="${esc(a.storageUrl || a.externalUrl)}" alt="" loading="lazy" style="width:100%;height:90px;object-fit:cover;display:block">
            <span class="block text-xs text-gray-600 px-2 py-1 truncate">${esc(a.name || 'Untitled')}</span>
          </button>`).join('');
        grid.querySelectorAll('[data-mp-asset]').forEach((el) => el.addEventListener('click', () => {
          const a = images.find((x) => String(x.id) === el.dataset.mpAsset);
          pick({ id: a.id, url: a.storageUrl || a.externalUrl || '', name: a.name || '' });
        }));
        refreshDone();
      })
      .catch((err) => { grid.innerHTML = `<p class="text-xs text-red-600">${esc(err.message)}</p>`; });
  }

  window.MediaPicker = { open, upload };
})();
