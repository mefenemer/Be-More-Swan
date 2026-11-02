/**
 * src/components/voice-picker.js — choose a voiceover voice by ear.
 *
 * ONE picker for every place a voice is chosen: the post editor's "Add a voiceover", the Video
 * Producer's brief and setup, and the Voice builder's "Read aloud" on the assistant profile. The list
 * is src/public/voice-catalogue.json — the same file src/lib/tts.ts speaks from, so a voice offered
 * here is always one the server can speak.
 *
 *   VoicePicker.open({ value, language, title, onSelect(voiceId, language) })  → a modal
 *   VoicePicker.load()                                                          → Promise<catalogue>
 *   VoicePicker.describe(voiceId)                                               → "Pepper · British, warm (woman)"
 *   VoicePicker.play(voiceId, button?) / VoicePicker.stop()                     → the voice's sample
 *   VoicePicker.fieldHtml({ attrs, value })  → a form field: a hidden input (carrying `attrs` — name,
 *        id, data-*) and a "voice · ▶ Listen · Change" row. Choosing sets the input and dispatches a
 *        bubbling `change`, so any form or autosave reading inputs picks it up. Used by the setup
 *        wizard (assistant-onboarding-shell.js) and the profile's Operational Setup (assistants.js).
 *
 * Listening is free: each voice's sample is a static file (audio/voices/<id>.mp3, made once by
 * scripts/make-voice-samples.mjs), never a fresh voiceover. One <audio> for the whole page, so
 * starting one sample stops the last. Legacy voices are not offered but still describe themselves,
 * so a setting saved before 2026-11-02 reads correctly.
 */
(function () {
  const URL = '/src/public/voice-catalogue.json';
  let catalogue = null;
  let loading = null;
  let audio = null;
  let playingId = null;
  let playingBtn = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function load() {
    if (catalogue) return Promise.resolve(catalogue);
    if (!loading) {
      loading = fetch(URL).then((r) => (r.ok ? r.json() : Promise.reject(new Error('voices'))))
        .then((c) => { catalogue = c; return c; })
        .catch((e) => { loading = null; throw e; });
    }
    return loading;
  }

  const voiceOf = (id) => (catalogue?.voices || []).find((v) => v.id === id) || null;
  const offered = () => (catalogue?.voices || []).filter((v) => !v.legacy);
  const langLabel = (code) => (catalogue?.languages || []).find((l) => l.code === code)?.label || code;

  function describe(id) {
    const v = voiceOf(id);
    if (!v) return id ? String(id) : 'No voice chosen';
    return v.legacy ? v.label : `${v.name} · ${v.label}`;
  }

  function paintButton(btn, on) {
    if (!btn) return;
    btn.textContent = on ? '■ Stop' : '▶ Listen';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function stop() {
    if (audio) { try { audio.pause(); } catch { /* already stopped */ } }
    paintButton(playingBtn, false);
    playingId = null; playingBtn = null;
  }

  function play(id, btn) {
    if (playingId === id) { stop(); return; }
    stop();
    const v = voiceOf(id);
    if (!v) return;
    if (v.legacy) { window.showToast?.('This is one of the older voices, with no sample. Press Change to hear and choose one of the new voices.'); return; }
    if (!audio) {
      audio = new Audio();
      audio.addEventListener('ended', stop);
      audio.addEventListener('error', () => { stop(); window.showToast?.('That sample would not play.'); });
    }
    audio.src = `/audio/voices/${encodeURIComponent(id)}.mp3`;
    playingId = id; playingBtn = btn || null;
    paintButton(playingBtn, true);
    audio.play().catch(() => { stop(); window.showToast?.('The browser blocked the sample — press Listen again.'); });
  }

  /** A language that has voices, else English. */
  function pickLanguage(want, current) {
    const langs = new Set(offered().map((v) => v.lang));
    if (want && langs.has(want)) return want;
    const cur = voiceOf(current);
    if (cur && langs.has(cur.lang)) return cur.lang;
    return 'en';
  }

  async function open(opts = {}) {
    try { await load(); } catch { window.showToast?.('The voices could not be loaded. Please try again.'); return; }
    document.querySelector('[data-vp-modal]')?.remove();
    let selected = opts.value || null;
    let lang = pickLanguage(opts.language, selected);
    let gender = 'all';

    const back = document.createElement('div');
    back.setAttribute('data-vp-modal', '');
    back.className = 'fixed inset-0 bg-gray-900/60 z-[70] flex items-center justify-center p-4 backdrop-blur-sm';
    back.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="vp-title" class="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div class="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-gray-100">
          <div>
            <h2 id="vp-title" class="text-lg font-bold text-gray-900">${esc(opts.title || 'Choose a voice')}</h2>
            <p class="text-xs text-gray-500 mt-0.5">Press Listen to hear each one. Listening is free.</p>
          </div>
          <button type="button" data-vp-close class="text-gray-400 hover:text-gray-700 text-2xl leading-none cursor-pointer" aria-label="Close">&times;</button>
        </div>
        <div class="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-gray-100">
          <label class="text-xs font-bold text-gray-600" for="vp-lang">Language</label>
          <select id="vp-lang" data-vp-lang class="text-sm border border-gray-300 rounded-lg px-2 py-1.5">
            ${(catalogue.languages || []).filter((l) => offered().some((v) => v.lang === l.code)).map((l) => `<option value="${esc(l.code)}">${esc(l.label)}</option>`).join('')}
          </select>
          <div class="flex rounded-lg border border-gray-300 overflow-hidden ml-auto" role="group" aria-label="Show">
            ${[['all', 'All'], ['female', 'Female'], ['male', 'Male']].map(([k, l]) => `<button type="button" data-vp-gender="${k}" class="px-3 py-1.5 text-xs font-bold cursor-pointer">${l}</button>`).join('')}
          </div>
        </div>
        <div data-vp-list class="overflow-y-auto px-5 py-4 grid gap-2 sm:grid-cols-2"></div>
        <p class="px-5 pb-4 pt-1 text-[11px] text-gray-500">Each voice reads your script in the language it's written in, and sounds most natural in its own.</p>
      </div>`;
    document.body.appendChild(back);
    const $ = (s) => back.querySelector(s);
    $('[data-vp-lang]').value = lang;

    function paint() {
      back.querySelectorAll('[data-vp-gender]').forEach((b) => {
        const on = b.dataset.vpGender === gender;
        b.className = `px-3 py-1.5 text-xs font-bold cursor-pointer ${on ? 'bg-emerald-700 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      const list = offered().filter((v) => v.lang === lang && (gender === 'all' || v.gender === gender));
      $('[data-vp-list]').innerHTML = list.length ? list.map((v) => {
        const on = v.id === selected;
        return `<div class="border rounded-xl p-3 flex flex-col gap-2 ${on ? 'border-emerald-600 bg-emerald-50' : 'border-gray-200'}">
          <div>
            <p class="text-sm font-bold text-gray-900">${esc(v.name)} <span class="text-[10px] font-semibold uppercase tracking-wide text-gray-400 ml-1">${v.gender === 'female' ? 'Female' : 'Male'}</span></p>
            <p class="text-xs text-gray-600">${esc(v.label)}</p>
          </div>
          <div class="flex gap-2">
            <button type="button" data-vp-play="${esc(v.id)}" class="flex-1 px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-bold text-gray-700 hover:bg-gray-50 cursor-pointer" aria-pressed="false">${playingId === v.id ? '■ Stop' : '▶ Listen'}</button>
            <button type="button" data-vp-use="${esc(v.id)}" class="flex-1 px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${on ? 'bg-emerald-700 text-white' : 'btn-assistant'}">${on ? '✓ Chosen' : 'Use this voice'}</button>
          </div>
        </div>`;
      }).join('') : `<p class="text-sm text-gray-500">No ${gender === 'all' ? '' : gender + ' '}voices in ${esc(langLabel(lang))} yet.</p>`;
      if (playingId) playingBtn = back.querySelector(`[data-vp-play="${CSS.escape(playingId)}"]`);
    }

    function close() {
      stop();
      document.removeEventListener('keydown', onKey);
      back.remove();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.closest('[data-vp-close]')) { close(); return; }
      const g = e.target.closest('[data-vp-gender]');
      if (g) { gender = g.dataset.vpGender; paint(); return; }
      const p = e.target.closest('[data-vp-play]');
      if (p) { play(p.dataset.vpPlay, p); return; }
      const u = e.target.closest('[data-vp-use]');
      if (u) {
        selected = u.dataset.vpUse;
        const v = voiceOf(selected);
        close();
        try { opts.onSelect?.(selected, v?.lang || lang); } catch (err) { console.error('[VoicePicker] onSelect failed', err); }
      }
    });
    $('[data-vp-lang]').addEventListener('change', (e) => { lang = e.target.value; stop(); paint(); });
    paint();
    $('[data-vp-close]').focus();
  }

  function fieldHtml({ attrs = '', value = '' } = {}) {
    return `<div data-vpf class="flex items-center gap-2 border border-gray-300 rounded-lg bg-white px-3 py-2">
      <input type="hidden" ${attrs} value="${esc(value)}">
      <span data-vpf-name class="flex-1 min-w-0 text-sm text-gray-800 truncate">${esc(value ? describe(value) : 'No voice chosen')}</span>
      <button type="button" data-vpf-act="listen" class="shrink-0 text-xs font-bold text-gray-600 hover:text-gray-900 cursor-pointer" aria-pressed="false">&#9654; Listen</button>
      <button type="button" data-vpf-act="choose" class="shrink-0 text-xs font-bold text-emerald-700 hover:text-emerald-900 cursor-pointer">Choose</button>
    </div>`;
  }

  // Field rows anywhere on the page — bound once, on document (rows are re-rendered under us).
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-vpf-act]');
    const row = b && b.closest('[data-vpf]');
    if (!row) return;
    e.preventDefault();
    const input = row.querySelector('input[type="hidden"]');
    if (b.dataset.vpfAct === 'listen') {
      load().then(() => { if (input.value) play(input.value, b); else window.showToast?.('Choose a voice first.'); }).catch(() => {});
      return;
    }
    open({
      value: input.value, title: 'Choose a voice',
      onSelect: (id) => {
        input.value = id;
        const name = row.querySelector('[data-vpf-name]');
        if (name) name.textContent = describe(id);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });
  });

  // The names come from the catalogue: fetch it at once (a few KB) and repaint anything drawn before
  // it arrived — field rows, and any element marked data-voice-name-of="<voice id>".
  load().then(() => {
    document.querySelectorAll('[data-vpf]').forEach((row) => {
      const v = row.querySelector('input[type="hidden"]')?.value;
      const name = row.querySelector('[data-vpf-name]');
      if (v && name) name.textContent = describe(v);
    });
    document.querySelectorAll('[data-voice-name-of]').forEach((el) => { el.textContent = describe(el.dataset.voiceNameOf); });
  }).catch(() => {});

  window.VoicePicker = { load, open, describe, play, stop, fieldHtml, voice: (id) => voiceOf(id), languageLabel: langLabel };
})();
