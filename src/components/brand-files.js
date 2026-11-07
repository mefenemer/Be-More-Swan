/**
 * src/components/brand-files.js — "Files and links" in an assistant's "Your brand" section (owner, 2026-11-06:
 * everything in Brand Assets should be reachable from the assistant, and a change there keeps My Account the same).
 *
 * The workspace library, not a copy: the same functions as Business Information ▸ Brand Assets (assets.js) —
 *   list    GET  get-workspace-assets
 *   file    POST storage-request-upload → PUT to R2 → POST storage-confirm-upload   (10 MB max, as there)
 *   link    POST upload-asset  (FormData: category, url)
 *   remove  DELETE delete-workspace-asset?assetId=
 * so whatever is added or removed here is what Brand Assets shows and what every assistant reads. If one of
 * those calls changes in assets.js, change it here too.
 *
 *   window.BrandFiles.mount(el)
 */
(function () {
  'use strict';

  const FN = '/.netlify/functions/';
  const MAX_BYTES = 10 * 1024 * 1024;
  // Mirror of the upload dropdown in assets.html.
  const CATEGORIES = [
    ['logo', 'Brand Logo / Visuals'],
    ['tone_of_voice', 'Tone of Voice / Style'],
    ['product_info', 'Product Knowledge'],
    ['general', 'General Context'],
  ];
  const catLabel = (c) => (CATEGORIES.find(([k]) => k === c) || [null, 'General Context'])[1];
  // Only these feed the assistants (assemble-blueprint § 11 in src/utils/blueprint.ts).
  const APPLIED = ['ready', 'confirmed'];
  const NOT_APPLIED_HINT = {
    processing: 'Still processing — it will be used once it is ready.',
    pending: "The upload didn't finish, so it isn't used. Remove it and try again.",
    failed: "The upload failed, so it isn't used. Remove it and try again.",
  };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function listAssets() {
    const res = await fetch(FN + 'get-workspace-assets', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('list');
    return (await res.json()).assets || [];
  }

  async function uploadFile(file, category) {
    const mimeType = file.type || 'application/octet-stream';
    const assetType = mimeType.startsWith('image/') ? 'brand_logo' : 'brand_document';
    const reqRes = await fetch(FN + 'storage-request-upload', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetType, category, filename: file.name, mimeType, fileSizeBytes: file.size }),
    });
    if (!reqRes.ok) {
      const err = await reqRes.json().catch(() => ({}));
      throw new Error(err.error === 'storage_quota_exceeded'
        ? 'Your storage is full. Remove a file or move to a bigger plan.'
        : (err.error || 'The upload could not start.'));
    }
    const { uploadUrl, assetId } = await reqRes.json();
    const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: file });
    if (!putRes.ok) throw new Error('The upload failed. Please try again.');
    const confRes = await fetch(FN + 'storage-confirm-upload', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId }),
    });
    if (!confRes.ok) {
      const err = await confRes.json().catch(() => ({}));
      throw new Error(err.error || 'The upload could not be finished.');
    }
  }

  async function addLink(url, category) {
    const payload = new FormData();
    payload.append('category', category);
    payload.append('url', url);
    const res = await fetch(FN + 'upload-asset', { method: 'POST', credentials: 'same-origin', body: payload });
    if (!res.ok) throw new Error('The link could not be saved.');
  }

  async function removeAsset(id) {
    const res = await fetch(`${FN}delete-workspace-asset?assetId=${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
    if (!res.ok) throw new Error('remove');
  }

  function row(a, applied) {
    const kind = a.isFile ? 'File' : 'Link';
    const open = !a.isFile && a.externalUrl
      ? `<a href="${esc(a.externalUrl)}" target="_blank" rel="noopener" class="text-xs font-bold text-emerald-800 hover:underline">Open</a>` : '';
    const state = applied ? '' : `<span class="text-xs font-medium text-gray-600" title="${esc(NOT_APPLIED_HINT[a.status] || 'Not used yet.')}">${esc(NOT_APPLIED_HINT[a.status] ? a.status : 'not used yet')}</span>`;
    return `
      <li class="flex items-center justify-between gap-3 px-4 py-3 ${applied ? '' : 'bg-gray-50/50'}">
        <div class="min-w-0">
          <p class="text-sm font-semibold ${applied ? 'text-gray-800' : 'text-gray-600'} truncate">${esc(a.name)}</p>
          <p class="text-xs text-gray-500 mt-0.5">${kind} · ${esc(catLabel(a.category))}</p>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          ${open}${state}
          <button type="button" data-bf-remove="${esc(a.id)}" data-name="${esc(a.name)}" class="text-xs font-semibold text-gray-600 hover:text-red-700 min-h-[44px] sm:min-h-0 px-1">Remove</button>
        </div>
      </li>`;
  }

  function listHtml(assets) {
    const applied = assets.filter((a) => APPLIED.includes(a.status));
    const pending = assets.filter((a) => !APPLIED.includes(a.status));
    if (!assets.length) return '<p class="text-sm text-gray-600 py-2">Nothing here yet. Add your logo, brand guidelines or a link below.</p>';
    return (applied.length ? `<ul class="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">${applied.map((a) => row(a, true)).join('')}</ul>` : '')
      + (pending.length ? `
        <p class="text-xs font-bold text-gray-600 uppercase tracking-wide mt-4 mb-2">Not used yet</p>
        <ul class="divide-y divide-gray-100 border border-dashed border-gray-300 rounded-xl overflow-hidden">${pending.map((a) => row(a, false)).join('')}</ul>` : '');
  }

  const ADD_FORM = `
    <div class="mt-5 pt-5 border-t border-gray-100">
      <p class="text-sm font-bold text-gray-900 mb-2">Add a file or link</p>
      <div class="flex flex-col sm:flex-row gap-2">
        <label class="sr-only" for="bf-category">What it is</label>
        <select id="bf-category" class="sm:w-56 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
          ${CATEGORIES.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}
        </select>
        <button type="button" data-bf-pick class="btn-secondary border rounded-lg px-3 py-2 text-sm font-bold min-h-[44px] sm:min-h-0">Choose a file…</button>
        <input type="file" data-bf-file class="sr-only" tabindex="-1" aria-hidden="true">
      </div>
      <form data-bf-link-form class="flex flex-col sm:flex-row gap-2 mt-2">
        <label class="sr-only" for="bf-url">A link</label>
        <input id="bf-url" type="url" inputmode="url" placeholder="Or paste a link, e.g. https://yourbrand.com/guidelines" class="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm">
        <button type="submit" class="btn-secondary border rounded-lg px-3 py-2 text-sm font-bold min-h-[44px] sm:min-h-0">Add link</button>
      </form>
      <p data-bf-msg class="text-xs font-semibold mt-2 hidden" role="status" aria-live="polite"></p>
      <p class="text-xs text-gray-500 mt-2">Up to 10 MB a file.</p>
    </div>`;

  function mount(el) {
    if (!el) return;
    el.innerHTML = `<div data-bf-list><p class="text-sm text-gray-500">Loading your files and links…</p></div>${ADD_FORM}`;
    const listEl = el.querySelector('[data-bf-list]');
    const msgEl = el.querySelector('[data-bf-msg]');
    const fileEl = el.querySelector('[data-bf-file]');
    const catEl = el.querySelector('#bf-category');
    let busy = false;

    const say = (text, kind) => {
      if (!text) { msgEl.classList.add('hidden'); return; }
      msgEl.textContent = text;
      msgEl.classList.remove('hidden', 'text-red-700', 'text-emerald-800', 'text-gray-600');
      msgEl.classList.add(kind === 'error' ? 'text-red-700' : kind === 'done' ? 'text-emerald-800' : 'text-gray-600');
    };
    const paint = () => listAssets()
      .then((assets) => { if (el.isConnected) listEl.innerHTML = listHtml(assets); })
      .catch(() => { if (el.isConnected) listEl.innerHTML = '<p class="text-sm text-gray-600">Your files and links could not be read just now.</p>'; });

    async function run(label, job) {
      if (busy) { say('Wait a moment, the last one is still saving.', 'pending'); return; }
      busy = true;
      say(`${label}…`, 'pending');
      try {
        await job();
        await paint();
        say('Added ✓ Your assistants will use it from now on.', 'done');
        document.dispatchEvent(new CustomEvent('brand-assets:changed'));
      } catch (e) {
        say(e.message || 'That could not be saved. Please try again.', 'error');
      } finally { busy = false; }
    }

    el.querySelector('[data-bf-pick]').addEventListener('click', () => fileEl.click());
    fileEl.addEventListener('change', () => {
      const file = fileEl.files && fileEl.files[0];
      fileEl.value = '';
      if (!file) return;
      if (file.size > MAX_BYTES) { say(`${file.name} is bigger than 10 MB.`, 'error'); return; }
      const category = catEl.value;
      run(`Uploading ${file.name}`, () => uploadFile(file, category));
    });
    el.querySelector('[data-bf-link-form]').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = el.querySelector('#bf-url');
      const url = input.value.trim();
      if (!/^https?:\/\/\S+\.\S+/i.test(url)) { say('Paste a whole link, starting with https://', 'error'); return; }
      const category = catEl.value;
      run('Adding the link', async () => { await addLink(url, category); input.value = ''; });
    });
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bf-remove]');
      if (!btn) return;
      const id = btn.dataset.bfRemove;
      const name = btn.dataset.name || 'this';
      const doRemove = async () => {
        btn.disabled = true;
        try {
          await removeAsset(id);
          await paint();
          say(`Removed ${name}.`, 'done');
          document.dispatchEvent(new CustomEvent('brand-assets:changed'));
        } catch {
          btn.disabled = false;
          say(`${name} could not be removed. Please try again.`, 'error');
        }
      };
      const message = `Remove “${name}” from your brand files? Every assistant stops using it, and it goes from Business Information ▸ Brand Assets too. This can't be undone.`;
      if (window.showConfirmModal) window.showConfirmModal(message, doRemove, { title: 'Remove this file?', confirmLabel: 'Remove', cancelLabel: 'Keep it' });
      else if (window.confirm(message)) doRemove();
    });

    paint();
  }

  window.BrandFiles = { mount, listHtml };
})();
