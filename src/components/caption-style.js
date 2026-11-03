/**
 * src/components/caption-style.js — how a video's captions look, with a live sample.
 *
 * ONE editor for every place captions are styled: the post editor (a voiceover clip's settings,
 * inline), the Video Producer's "New video" brief and its setup (a pop-up). The choices mirror
 * src/lib/captions.ts (CaptionStyle / DEFAULT_CAPTION_STYLE); the server normalises whatever is saved,
 * so a value this editor doesn't know falls back rather than breaking a render.
 *
 *   CaptionStyle.mount(host, { value, onChange(style) })  → inline editor; returns { set(style) }
 *   CaptionStyle.open({ value, title, onSave(style) })    → the same editor in a pop-up
 *   CaptionStyle.describe(style)                          → "Spoken word coloured · bottom · medium"
 *   CaptionStyle.fieldHtml({ attrs, value })              → a form field: a hidden input holding the
 *        style as JSON (carrying `attrs`) and a "look · Change the look" row; saving dispatches a
 *        bubbling `change`. Used by the setup wizard and the profile's Operational Setup.
 */
(function () {
  const DEFAULT = { mode: 'highlight', position: 'bottom', size: 'medium', font: 'Impact', textColor: '#FFFFFF', highlight: 'brand', box: false };
  const MODES = [['highlight', 'Spoken word coloured'], ['phrase', 'Whole phrase'], ['word', 'One word at a time']];
  const POSITIONS = [['bottom', 'Bottom'], ['middle', 'Middle'], ['top', 'Top']];
  const SIZES = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']];
  const FONTS = [['Impact', 'Bold (Impact)'], ['Arial', 'Clean (Arial)'], ['Georgia', 'Classic (Georgia)'], ['Trebuchet MS', 'Friendly (Trebuchet)'], ['Verdana', 'Wide (Verdana)'], ['Comic Sans MS', 'Playful (Comic)']];
  // The faces the render uses for each (src/lib/overlay-fonts.ts), so the sample matches the video.
  const FACE = { Impact: "'Anton', Impact, sans-serif", Arial: "'Arimo', Arial, sans-serif", Georgia: "'Gelasio', Georgia, serif", 'Trebuchet MS': "'Cabin', 'Trebuchet MS', sans-serif", Verdana: "'Open Sans', Verdana, sans-serif", 'Comic Sans MS': "'Comic Neue', 'Comic Sans MS', cursive" };
  const HEX = /^#[0-9a-f]{6}$/i;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const opts = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('');

  function normalise(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const pick = (v, list, d) => (list.some(([k]) => k === v) ? v : d);
    return {
      mode: pick(o.mode, MODES, DEFAULT.mode),
      position: pick(o.position, POSITIONS, DEFAULT.position),
      size: pick(o.size, SIZES, DEFAULT.size),
      font: pick(o.font, FONTS, DEFAULT.font),
      textColor: HEX.test(o.textColor || '') ? o.textColor.toUpperCase() : DEFAULT.textColor,
      highlight: o.highlight === 'brand' ? 'brand' : HEX.test(o.highlight || '') ? o.highlight.toUpperCase() : DEFAULT.highlight,
      box: o.box === true,
    };
  }

  function describe(raw) {
    const s = normalise(raw);
    const label = (list, v) => (list.find(([k]) => k === v) || [, v])[1];
    return `${label(MODES, s.mode)} · ${label(POSITIONS, s.position).toLowerCase()} · ${label(SIZES, s.size).toLowerCase()}${s.box ? ' · dark band' : ''}`;
  }

  function sampleHtml(s) {
    // "Brand colour" is resolved at render (a brand colour too dark to read becomes yellow,
    // captions.ts captionAccent); the sample shows yellow rather than guess.
    const accent = s.highlight === 'brand' ? '#FFD400' : s.highlight;
    const px = { small: 13, medium: 16, large: 20 }[s.size] * (s.mode === 'word' ? 1.3 : 1);
    const words = s.mode === 'word' ? ['Hello'] : s.mode === 'phrase' ? ['Your', 'words', 'appear', 'just', 'like', 'this'] : ['Your', 'words', 'like', 'this'];
    const where = s.position === 'top' ? 'top:12%' : s.position === 'middle' ? 'top:50%;transform:translateY(-50%)' : 'bottom:14%';
    const look = s.box
      ? 'background:rgba(0,0,0,.6);padding:1px 6px;border-radius:4px;'
      : '-webkit-text-stroke:1px rgba(0,0,0,.85);paint-order:stroke fill;text-shadow:0 1px 3px rgba(0,0,0,.55);';
    return `<div style="position:absolute;left:8px;right:8px;text-align:center;${where}"><span style="font-family:${FACE[s.font]};font-size:${Math.round(px)}px;line-height:1.15;color:${s.textColor};${look}">${words.map((w, i) => `<span style="color:${s.mode === 'highlight' && i === 1 ? accent : s.textColor}">${w}</span>`).join(' ')}</span></div>`;
  }

  function mount(host, { value, onChange } = {}) {
    let s = normalise(value);
    const field = (k) => host.querySelector(`[data-cs="${k}"]`);
    host.innerHTML = `
      <div data-cs-sample class="relative rounded-md overflow-hidden mb-2" style="height:96px;background:linear-gradient(135deg,#3b4a5a,#7a8b74)" aria-hidden="true"></div>
      <div class="grid grid-cols-2 gap-2">
        <label class="block"><span class="block text-[10px] font-bold text-gray-500 mb-0.5">Style</span>
          <select data-cs="mode" class="w-full text-xs border border-gray-300 rounded-lg px-1.5 py-1">${opts(MODES, s.mode)}</select></label>
        <label class="block"><span class="block text-[10px] font-bold text-gray-500 mb-0.5">Where</span>
          <select data-cs="position" class="w-full text-xs border border-gray-300 rounded-lg px-1.5 py-1">${opts(POSITIONS, s.position)}</select></label>
        <label class="block"><span class="block text-[10px] font-bold text-gray-500 mb-0.5">Size</span>
          <select data-cs="size" class="w-full text-xs border border-gray-300 rounded-lg px-1.5 py-1">${opts(SIZES, s.size)}</select></label>
        <label class="block"><span class="block text-[10px] font-bold text-gray-500 mb-0.5">Font</span>
          <select data-cs="font" class="w-full text-xs border border-gray-300 rounded-lg px-1.5 py-1">${opts(FONTS, s.font)}</select></label>
        <label class="block"><span class="block text-[10px] font-bold text-gray-500 mb-0.5">Text colour</span>
          <input data-cs="textColor" type="color" class="w-full h-7 border border-gray-300 rounded-lg cursor-pointer"></label>
        <label class="block"><span class="block text-[10px] font-bold text-gray-500 mb-0.5">Spoken word</span>
          <span class="flex gap-1">
            <select data-cs="highlightMode" class="flex-1 min-w-0 text-xs border border-gray-300 rounded-lg px-1.5 py-1"><option value="brand">Brand colour</option><option value="own">Choose a colour</option></select>
            <input data-cs="highlight" type="color" class="w-8 h-7 border border-gray-300 rounded-lg cursor-pointer" aria-label="Spoken word colour">
          </span></label>
      </div>
      <label class="mt-2 flex items-center gap-2 text-[11px] text-gray-700 cursor-pointer">
        <input data-cs="box" type="checkbox" class="cursor-pointer"> Dark band behind the words (easier to read on busy footage)
      </label>
      <p data-cs-where-note class="hidden mt-1.5 text-[11px] text-amber-700"></p>`;
    function paint() {
      field('textColor').value = s.textColor.toLowerCase();
      field('box').checked = s.box;
      field('highlightMode').value = s.highlight === 'brand' ? 'brand' : 'own';
      field('highlightMode').disabled = s.mode !== 'highlight';
      if (s.highlight !== 'brand') field('highlight').value = s.highlight.toLowerCase();
      else if (!HEX.test(field('highlight').value || '')) field('highlight').value = '#ffd400';
      field('highlight').style.visibility = s.highlight === 'brand' || s.mode !== 'highlight' ? 'hidden' : 'visible';
      host.querySelector('[data-cs-sample]').innerHTML = sampleHtml(s);
      // Text boxes are not moved for the captions — say so where they might now overlap.
      const note = host.querySelector('[data-cs-where-note]');
      note.textContent = s.position === 'top' ? 'Text boxes near the top of the video will sit under the captions. Move them lower in the post editor.'
        : s.position === 'middle' ? 'Text boxes in the middle of the video will sit under the captions. Move them up or down in the post editor.' : '';
      note.classList.toggle('hidden', !note.textContent);
    }
    function read() {
      return normalise({
        mode: field('mode').value, position: field('position').value, size: field('size').value, font: field('font').value,
        textColor: field('textColor').value,
        highlight: field('highlightMode').value === 'own' ? field('highlight').value : 'brand',
        box: field('box').checked,
      });
    }
    host.addEventListener('input', (e) => { if (e.target.closest('[data-cs]')) { s = read(); paint(); } });
    host.addEventListener('change', (e) => { if (e.target.closest('[data-cs]')) { s = read(); paint(); onChange?.(s); } });
    paint();
    return {
      get: () => ({ ...s }),
      set(v) { s = normalise(v); ['mode', 'position', 'size', 'font'].forEach((k) => { field(k).value = s[k]; }); paint(); },
    };
  }

  function open({ value, title, onSave } = {}) {
    document.querySelector('[data-cs-modal]')?.remove();
    const back = document.createElement('div');
    back.setAttribute('data-cs-modal', '');
    back.className = 'fixed inset-0 bg-gray-900/60 z-[70] flex items-center justify-center p-4 backdrop-blur-sm';
    back.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="cs-title" class="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto p-5">
        <div class="flex items-start justify-between gap-3 mb-3">
          <h2 id="cs-title" class="text-lg font-bold text-gray-900">${esc(title || 'How the captions look')}</h2>
          <button type="button" data-cs-close class="text-gray-400 hover:text-gray-700 text-2xl leading-none cursor-pointer" aria-label="Close">&times;</button>
        </div>
        <div data-cs-host></div>
        <div class="flex gap-2 mt-4">
          <button type="button" data-cs-save class="btn-primary px-4 py-2 text-sm font-bold rounded-lg">Use this look</button>
          <button type="button" data-cs-close class="btn-secondary border px-4 py-2 text-sm font-bold rounded-lg">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const ed = mount(back.querySelector('[data-cs-host]'), { value });
    const close = () => { document.removeEventListener('keydown', onKey); back.remove(); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.closest('[data-cs-close]')) { close(); return; }
      if (e.target.closest('[data-cs-save]')) { const v = ed.get(); close(); onSave?.(v); }
    });
    back.querySelector('[data-cs-close]').focus();
  }

  function fieldHtml({ attrs = '', value = null } = {}) {
    const v = value && typeof value === 'object' ? value : (() => { try { return JSON.parse(value || 'null'); } catch { return null; } })();
    return `<div data-csf class="flex items-center gap-2 border border-gray-300 rounded-lg bg-white px-3 py-2">
      <input type="hidden" ${attrs} value="${esc(v ? JSON.stringify(normalise(v)) : '')}">
      <span data-csf-desc class="flex-1 min-w-0 text-sm text-gray-800 truncate">${esc(describe(v))}</span>
      <button type="button" data-csf-act="choose" class="shrink-0 text-xs font-bold text-emerald-700 hover:text-emerald-900 cursor-pointer">Change the look</button>
    </div>`;
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-csf-act]');
    const row = b && b.closest('[data-csf]');
    if (!row) return;
    e.preventDefault();
    const input = row.querySelector('input[type="hidden"]');
    let cur = null;
    try { cur = JSON.parse(input.value || 'null'); } catch { cur = null; }
    open({
      value: cur,
      onSave: (style) => {
        input.value = JSON.stringify(style);
        const d = row.querySelector('[data-csf-desc]');
        if (d) d.textContent = describe(style);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });
  });

  window.CaptionStyle = { mount, open, describe, normalise, fieldHtml, DEFAULT };
})();
