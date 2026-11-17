/**
 * src/components/presenter-picker.js — choose an AI presenter by watching them.
 *
 * ONE picker for every place a presenter is chosen (docs/video-producer-screen-walkthrough-plan.md §11.3, Phase
 * A1). The list is src/public/presenter-catalogue.json — the same file src/lib/presenters.ts reads, so a
 * presenter offered here is always one the server knows. Built like voice-picker.js.
 *
 *   PresenterPicker.open({ value, title, onSelect(presenterId) })  → a modal: Female / Male, a card per presenter
 *   PresenterPicker.load()                                         → Promise<catalogue>
 *   PresenterPicker.describe(id)                                   → "Amara · 30s, woman"
 *   PresenterPicker.fieldHtml({ attrs, value })  → a form field: a hidden input (carrying `attrs`) and a
 *        "thumbnail · name · Change" row. Choosing sets the input and dispatches a bubbling `change`.
 *
 * Watching is free: each presenter's sample is a static file (presenters/<id>.mp4, made once by
 * scripts/make-presenters.mjs), never a fresh clip. Only one sample plays at a time. Every presenter is made
 * up, and the modal says so.
 */
(function () {
  const URL = '/src/public/presenter-catalogue.json';
  let catalogue = null;
  let loading = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const file = (id, kind) => `/presenters/${encodeURIComponent(id)}${kind === 'thumb' ? '-thumb.jpg' : kind === 'face' ? '.jpg' : '.mp4'}`;

  function load() {
    if (catalogue) return Promise.resolve(catalogue);
    if (!loading) {
      loading = fetch(URL).then((r) => (r.ok ? r.json() : Promise.reject(new Error('presenters'))))
        .then((c) => { catalogue = c; return c; })
        .catch((e) => { loading = null; throw e; });
    }
    return loading;
  }

  const all = () => (catalogue?.presenters || []);
  const presenterOf = (id) => all().find((p) => p.id === id) || null;

  function describe(id) {
    const p = presenterOf(id);
    if (!p) return id ? String(id) : 'No presenter chosen';
    return `${p.name} · ${p.age}, ${p.gender === 'female' ? 'woman' : 'man'}`;
  }

  /** Stop every sample in the modal, and show each card's still again. */
  function stopAll(root) {
    root.querySelectorAll('video[data-pp-video]').forEach((v) => { try { v.pause(); } catch { /* stopped */ } v.currentTime = 0; v.classList.add('hidden'); });
    root.querySelectorAll('img[data-pp-still]').forEach((i) => i.classList.remove('hidden'));
    root.querySelectorAll('[data-pp-play]').forEach((b) => { b.textContent = '▶ Watch'; b.setAttribute('aria-pressed', 'false'); });
  }

  async function open(opts = {}) {
    try { await load(); } catch { window.showToast?.('The presenters could not be loaded. Please try again.'); return; }
    document.querySelector('[data-pp-modal]')?.remove();
    let selected = opts.value || null;
    let gender = 'all';

    const back = document.createElement('div');
    back.setAttribute('data-pp-modal', '');
    back.className = 'fixed inset-0 bg-gray-900/60 z-[70] flex items-center justify-center p-4 backdrop-blur-sm';
    back.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="pp-title" class="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div class="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-gray-100">
          <div>
            <h2 id="pp-title" class="text-lg font-bold text-gray-900">${esc(opts.title || 'Choose a presenter')}</h2>
            <p class="text-xs text-gray-500 mt-0.5">Press Watch to see and hear each one. Watching is free.</p>
          </div>
          <button type="button" data-pp-close class="text-gray-400 hover:text-gray-700 text-2xl leading-none cursor-pointer" aria-label="Close">&times;</button>
        </div>
        <div class="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-gray-100">
          <div class="flex rounded-lg border border-gray-300 overflow-hidden" role="group" aria-label="Show">
            ${[['all', 'All'], ['female', 'Female'], ['male', 'Male']].map(([k, l]) => `<button type="button" data-pp-gender="${k}" class="px-3 py-1.5 text-xs font-bold cursor-pointer">${l}</button>`).join('')}
          </div>
        </div>
        <div data-pp-list class="overflow-y-auto min-h-0 flex-1 px-5 py-4 grid gap-3 grid-cols-1 sm:grid-cols-2 md:grid-cols-3" style="grid-auto-rows:max-content"></div>
        <p class="px-5 pb-4 pt-1 text-[11px] text-gray-500">Every presenter is made by AI and isn't a real person. Videos with an AI presenter are labelled as made with AI. Each one can speak any language your voices cover.</p>
      </div>`;
    document.body.appendChild(back);
    const $ = (s) => back.querySelector(s);

    function paint() {
      back.querySelectorAll('[data-pp-gender]').forEach((b) => {
        const on = b.dataset.ppGender === gender;
        b.className = `px-3 py-1.5 text-xs font-bold cursor-pointer ${on ? 'bg-emerald-700 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      const list = all().filter((p) => gender === 'all' || p.gender === gender);
      $('[data-pp-list]').innerHTML = list.map((p) => {
        const on = p.id === selected;
        return `<div class="border rounded-xl overflow-hidden flex flex-col shrink-0 ${on ? 'border-emerald-600 ring-2 ring-emerald-600/30' : 'border-gray-200'}">
          <div class="relative bg-gray-100" style="aspect-ratio:16/9">
            <img data-pp-still="${esc(p.id)}" src="${esc(file(p.id, 'thumb'))}" alt="${esc(p.look)}" loading="lazy" class="absolute inset-0 w-full h-full object-cover">
            <video data-pp-video="${esc(p.id)}" src="${esc(file(p.id, 'sample'))}" preload="none" playsinline class="hidden absolute inset-0 w-full h-full object-cover"></video>
          </div>
          <div class="p-3 flex flex-col gap-2">
            <p class="text-sm font-bold text-gray-900">${esc(p.name)} <span class="text-[10px] font-semibold uppercase tracking-wide text-gray-400 ml-1">${p.gender === 'female' ? 'Female' : 'Male'} · ${esc(p.age)}</span></p>
            <div class="flex gap-2">
              <button type="button" data-pp-play="${esc(p.id)}" class="flex-1 px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-bold text-gray-700 hover:bg-gray-50 cursor-pointer" aria-pressed="false">▶ Watch</button>
              <button type="button" data-pp-use="${esc(p.id)}" class="flex-1 px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${on ? 'bg-emerald-700 text-white' : 'btn-assistant'}">${on ? '✓ Chosen' : 'Use'}</button>
            </div>
          </div>
        </div>`;
      }).join('');
    }

    function close() {
      stopAll(back);
      document.removeEventListener('keydown', onKey);
      back.remove();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.closest('[data-pp-close]')) { close(); return; }
      const g = e.target.closest('[data-pp-gender]');
      if (g) { stopAll(back); gender = g.dataset.ppGender; paint(); return; }
      const p = e.target.closest('[data-pp-play]');
      if (p) {
        const id = p.dataset.ppPlay;
        const video = back.querySelector(`video[data-pp-video="${CSS.escape(id)}"]`);
        const playing = p.getAttribute('aria-pressed') === 'true';
        stopAll(back);
        if (playing || !video) return;
        back.querySelector(`img[data-pp-still="${CSS.escape(id)}"]`)?.classList.add('hidden');
        video.classList.remove('hidden');
        p.textContent = '■ Stop'; p.setAttribute('aria-pressed', 'true');
        video.onended = () => stopAll(back);
        video.play().catch(() => { stopAll(back); window.showToast?.('The browser blocked the sample — press Watch again.'); });
        return;
      }
      const u = e.target.closest('[data-pp-use]');
      if (u) {
        selected = u.dataset.ppUse;
        close();
        try { opts.onSelect?.(selected); } catch (err) { console.error('[PresenterPicker] onSelect failed', err); }
      }
    });
    paint();
    $('[data-pp-close]').focus();
  }

  function fieldHtml({ attrs = '', value = '' } = {}) {
    return `<div data-ppf class="flex items-center gap-2 border border-gray-300 rounded-lg bg-white px-2 py-1.5">
      <input type="hidden" ${attrs} value="${esc(value)}">
      <img data-ppf-thumb src="${value ? esc(file(value, 'thumb')) : ''}" alt="" class="${value ? '' : 'hidden '}w-12 h-[27px] object-cover rounded shrink-0">
      <span data-ppf-name class="flex-1 min-w-0 text-sm text-gray-800 truncate">${esc(value ? describe(value) : 'No presenter chosen')}</span>
      <button type="button" data-ppf-act="choose" class="shrink-0 text-xs font-bold text-emerald-700 hover:text-emerald-900 cursor-pointer">${value ? 'Change' : 'Choose'}</button>
    </div>`;
  }

  // Field rows anywhere on the page — bound once, on document (rows are re-rendered under us).
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ppf-act]');
    const row = b && b.closest('[data-ppf]');
    if (!row) return;
    e.preventDefault();
    const input = row.querySelector('input[type="hidden"]');
    open({
      value: input.value, title: 'Choose a presenter',
      onSelect: (id) => {
        input.value = id;
        const name = row.querySelector('[data-ppf-name]');
        if (name) name.textContent = describe(id);
        const thumb = row.querySelector('[data-ppf-thumb]');
        if (thumb) { thumb.src = file(id, 'thumb'); thumb.classList.remove('hidden'); }
        b.textContent = 'Change';
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });
  });

  // The names come from the catalogue: fetch it at once (a few KB) and repaint any field row drawn before it
  // arrived, so a pre-filled field reads "Amara · 30s, woman", not "amara".
  load().then(() => {
    document.querySelectorAll('[data-ppf]').forEach((row) => {
      const v = row.querySelector('input[type="hidden"]')?.value;
      const name = row.querySelector('[data-ppf-name]');
      if (v && name) name.textContent = describe(v);
    });
  }).catch(() => {});

  window.PresenterPicker = { load, open, describe, fieldHtml, presenter: (id) => presenterOf(id), files: (id) => ({ face: file(id, 'face'), thumb: file(id, 'thumb'), sample: file(id, 'sample') }) };
})();
