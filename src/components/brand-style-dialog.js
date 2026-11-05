/**
 * src/components/brand-style-dialog.js — see and change the brand style without leaving the Brand Designer
 * (owner, 2026-11-05: "Edit" used to navigate away to Business Information ▸ Brand Assets).
 *
 * The same two saves as that page, on netlify/functions/brand-kit.ts: PATCH for the colours and font,
 * `save_guidelines` for the picture guidelines. Each is sent only when it changed, because a PATCH marks the
 * kit as chosen by a person, and fixing a typo in "Never show" must not do that to colours nobody picked.
 *
 *   window.BrandStyleDialog.open({ assistantName, onSaved(), onAskChat() });
 */
(function () {
  'use strict';

  const API = '/.netlify/functions/brand-kit';
  const LOCK = 'brand-style-dialog';
  const MAX_EXTRA = 4;
  const COLOURS = [
    ['primaryColor', 'Main colour', 'Headlines, and the background of bolder designs'],
    ['backgroundColor', 'Background', 'The page behind lighter designs'],
    ['textColor', 'Text', 'Ordinary words'],
  ];
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HEX = /^#[0-9a-f]{6}$/i;

  async function call(method, body) {
    const res = await fetch(API, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `That could not be done (HTTP ${res.status}).`);
    return data;
  }

  function open(opts) {
    const o = opts || {};
    if (document.getElementById('brand-style-dialog')) return;
    const opener = document.activeElement;
    const who = o.assistantName || 'your Brand Designer';
    const wrap = document.createElement('div');
    wrap.id = 'brand-style-dialog';
    wrap.className = 'fixed inset-0 z-[60] bg-black/50 flex items-start justify-center p-4 overflow-y-auto';
    wrap.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="bsd-title" tabindex="-1" data-bsd-box class="bg-white rounded-2xl shadow-xl w-full max-w-3xl my-4 outline-none">
        <div class="flex items-start justify-between gap-3 p-5 border-b border-gray-200">
          <div>
            <h2 id="bsd-title" class="text-lg font-extrabold text-gray-900">Your brand style</h2>
            <p class="text-xs text-gray-600 mt-0.5">Everything your assistants design starts from this.</p>
          </div>
          <button type="button" data-bsd-close aria-label="Close" class="btn-utility min-w-[44px] min-h-[44px] rounded-lg text-lg">✕</button>
        </div>
        <div data-bsd-body class="p-5"><p class="text-sm text-gray-600">Loading your brand style…</p></div>
      </div>`;
    document.body.appendChild(wrap);
    window.ScrollLock?.lock(LOCK);

    const box = wrap.querySelector('[data-bsd-box]');
    const bodyEl = wrap.querySelector('[data-bsd-body]');
    let picker = null;
    let saved = null;
    let previewTimer = null;
    let previewToken = 0;
    let extras = [];

    function close() {
      clearTimeout(previewTimer);
      previewToken++;
      picker?.destroy();
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      window.ScrollLock?.release(LOCK);
      if (opener && opener.isConnected && opener.focus) opener.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab') return;
      const items = Array.from(wrap.querySelectorAll('button, input, textarea, select, a[href]')).filter((n) => !n.disabled && n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    wrap.querySelector('[data-bsd-close]').addEventListener('click', close);
    box.focus();

    const q = (sel) => bodyEl.querySelector(sel);

    function colourValues() {
      const out = {};
      COLOURS.forEach(([k]) => { out[k] = q(`[data-bsd-hex="${k}"]`).value.trim().toLowerCase(); });
      return out;
    }

    function paintExtras() {
      q('[data-bsd-extras]').innerHTML = `${extras.map((c, i) => `
        <span class="inline-flex items-center gap-1 border border-gray-300 rounded-lg p-1">
          <input type="color" value="${esc(c)}" data-bsd-extra="${i}" aria-label="Extra colour ${i + 1}" class="h-8 w-8 rounded cursor-pointer bg-white">
          <button type="button" data-bsd-extra-remove="${i}" aria-label="Remove extra colour ${i + 1}" class="btn-utility min-w-[32px] min-h-[32px] rounded text-xs">✕</button>
        </span>`).join('')}
        ${extras.length < MAX_EXTRA ? '<button type="button" data-bsd-extra-add class="btn-secondary border px-3 py-2 text-xs font-bold rounded-lg">Add a colour</button>' : ''}`;
    }

    function schedulePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(refreshPreview, 400);
    }
    async function refreshPreview() {
      const token = ++previewToken;
      const overrides = { ...colourValues(), fontFamily: picker ? picker.getValue() : null };
      if (Object.values(overrides).some((v) => typeof v === 'string' && v.startsWith('#') && !HEX.test(v))) return;
      try {
        const shots = await Promise.all(['light', 'bold'].map((variant) => call('POST', { action: 'preview', variant, overrides }).then((d) => [variant, d.dataUrl])));
        if (token !== previewToken) return;
        shots.forEach(([variant, url]) => { const img = q(`[data-bsd-preview="${variant}"]`); if (img && url) img.src = url; });
      } catch { /* the preview is a help, not the save */ }
    }

    function paint(kit, g) {
      extras = (g.secondaryColors || []).slice(0, MAX_EXTRA);
      const unset = kit.source !== 'manual' && kit.source !== 'website';
      const field = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none';
      bodyEl.innerHTML = `
        ${unset ? `<p class="text-sm font-semibold text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">You have not chosen brand colours yet. The black and white below are only what we use until you do.</p>` : ''}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="space-y-5 min-w-0">
            <fieldset>
              <legend class="text-sm font-bold text-gray-900">Colours</legend>
              <div class="mt-2 space-y-3">${COLOURS.map(([k, label, hint]) => `
                <div class="flex items-center gap-3">
                  <input type="color" data-bsd-colour="${k}" value="${esc(kit[k])}" aria-label="${esc(label)}" class="h-11 w-12 rounded border border-gray-300 cursor-pointer bg-white p-1 flex-shrink-0">
                  <div class="flex-1 min-w-0"><label for="bsd-hex-${k}" class="block text-xs font-bold text-gray-700">${esc(label)}</label><p class="text-[11px] text-gray-500">${esc(hint)}</p></div>
                  <input type="text" id="bsd-hex-${k}" data-bsd-hex="${k}" value="${esc(kit[k])}" maxlength="7" spellcheck="false" class="w-24 px-2 py-2 text-sm rounded-lg border border-gray-300 font-mono">
                </div>`).join('')}
              </div>
              <p class="text-xs font-bold text-gray-700 mt-4">Extra colours (optional)</p>
              <div data-bsd-extras class="flex flex-wrap items-center gap-2 mt-1"></div>
            </fieldset>
            <div>
              <p class="text-sm font-bold text-gray-900 mb-2">Font</p>
              <div data-bsd-font></div>
            </div>
          </div>
          <div class="min-w-0">
            <p class="text-sm font-bold text-gray-900 mb-2">How it looks</p>
            <div class="grid grid-cols-2 gap-3">
              <img data-bsd-preview="light" alt="Example design on your background colour" class="w-full aspect-square rounded-xl border border-gray-200 bg-gray-50 object-cover">
              <img data-bsd-preview="bold" alt="Example design on your main colour" class="w-full aspect-square rounded-xl border border-gray-200 bg-gray-50 object-cover">
            </div>
            ${o.onAskChat ? `<button type="button" data-bsd-ask class="btn-secondary border w-full mt-4 px-3 py-2 text-sm font-bold rounded-lg">Not sure? Talk it through with ${esc(who)}</button>` : ''}
          </div>
        </div>
        <div class="border-t border-gray-200 mt-5 pt-5 space-y-3">
          <p class="text-sm font-bold text-gray-900">Pictures</p>
          <label class="block"><span class="text-xs font-bold text-gray-700">What should your pictures look like?</span>
            <textarea data-bsd-g="photoStyle" maxlength="500" rows="2" placeholder="e.g. Bright and natural, real people at work, never posed." class="${field} mt-1">${esc(g.photoStyle || '')}</textarea></label>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label class="block"><span class="text-xs font-bold text-gray-700">Include where it fits</span>
              <input type="text" data-bsd-g="mustInclude" maxlength="300" value="${esc(g.mustInclude || '')}" placeholder="e.g. our pink, a laptop" class="${field} mt-1"></label>
            <label class="block"><span class="text-xs font-bold text-gray-700">Never show</span>
              <input type="text" data-bsd-g="mustAvoid" maxlength="300" value="${esc(g.mustAvoid || '')}" placeholder="e.g. handshakes, suits" class="${field} mt-1"></label>
          </div>
          <p class="text-[11px] text-gray-500">Every AI image your assistants make reads these. Stock photo search cannot filter by them.</p>
        </div>
        <p data-bsd-error class="hidden mt-3 text-sm font-semibold text-red-600" role="alert"></p>
        <div class="flex flex-wrap items-center justify-end gap-2 mt-5">
          <button type="button" data-bsd-cancel class="btn-utility px-4 py-2 min-h-[44px] sm:min-h-0 text-sm font-bold rounded-lg">Cancel</button>
          <button type="button" data-bsd-save class="btn-primary px-4 py-2 min-h-[44px] sm:min-h-0 text-sm font-bold rounded-lg disabled:opacity-50">Save</button>
        </div>`;
      paintExtras();
      picker = window.FontPicker?.mount(q('[data-bsd-font]'), { value: kit.fontFamily, label: 'Font', onChange: schedulePreview }) || null;
      refreshPreview();
    }

    bodyEl.addEventListener('input', (e) => {
      const c = e.target.dataset.bsdColour;
      if (c) { q(`[data-bsd-hex="${c}"]`).value = e.target.value; schedulePreview(); return; }
      const h = e.target.dataset.bsdHex;
      if (h) {
        if (HEX.test(e.target.value.trim())) q(`[data-bsd-colour="${h}"]`).value = e.target.value.trim();
        schedulePreview();
        return;
      }
      if (e.target.dataset.bsdExtra != null) extras[Number(e.target.dataset.bsdExtra)] = e.target.value;
    });
    bodyEl.addEventListener('click', async (e) => {
      if (e.target.closest('[data-bsd-extra-add]')) { extras.push(colourValues().primaryColor || '#888888'); paintExtras(); return; }
      const rm = e.target.closest('[data-bsd-extra-remove]');
      if (rm) { extras.splice(Number(rm.dataset.bsdExtraRemove), 1); paintExtras(); return; }
      if (e.target.closest('[data-bsd-cancel]')) { close(); return; }
      if (e.target.closest('[data-bsd-ask]')) { close(); o.onAskChat(); return; }
      const save = e.target.closest('[data-bsd-save]');
      if (!save) return;

      const err = q('[data-bsd-error]');
      err.classList.add('hidden');
      const colours = colourValues();
      const bad = COLOURS.find(([k]) => !HEX.test(colours[k]));
      if (bad) { err.textContent = `${bad[1]} needs to be a colour code like #ff007f.`; err.classList.remove('hidden'); return; }

      // Only what changed, so a guidelines edit never marks unchosen colours as chosen (see the top of this file).
      const kitPatch = {};
      COLOURS.forEach(([k]) => { if (colours[k] !== saved.kit[k]) kitPatch[k] = colours[k]; });
      const font = picker ? picker.getValue() : saved.kit.fontFamily;
      if ((font || null) !== (saved.kit.fontFamily || null)) kitPatch.fontFamily = font;
      const g = { secondaryColors: extras.slice() };
      ['photoStyle', 'mustInclude', 'mustAvoid'].forEach((k) => { g[k] = q(`[data-bsd-g="${k}"]`).value.trim() || null; });
      const gChanged = ['photoStyle', 'mustInclude', 'mustAvoid'].some((k) => (g[k] || null) !== (saved.g[k] || null))
        || JSON.stringify(g.secondaryColors) !== JSON.stringify(saved.g.secondaryColors || []);

      save.disabled = true;
      save.textContent = 'Saving…';
      try {
        if (Object.keys(kitPatch).length) await call('PATCH', kitPatch);
        if (gChanged) await call('POST', { action: 'save_guidelines', guidelines: g });
        close();
        if (o.onSaved) o.onSaved();
      } catch (ex) {
        save.disabled = false;
        save.textContent = 'Save';
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    });

    call('GET').then((d) => {
      if (!wrap.isConnected) return;
      saved = { kit: d.brandKit, g: d.guidelines || {} };
      paint(saved.kit, saved.g);
    }).catch((ex) => {
      if (wrap.isConnected) bodyEl.innerHTML = `<p class="text-sm font-semibold text-red-600" role="alert">${esc(ex.message)}</p>`;
    });
  }

  window.BrandStyleDialog = { open };
})();
