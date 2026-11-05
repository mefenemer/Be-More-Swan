/**
 * src/components/design-studio.js — the Brand Designer's editor (owner, 2026-11-05): the design on the left, the chat on
 * the right, and everything on it can be clicked and changed, "very much like in Canva". Tabs track where a brief is;
 * making it happens here.
 *
 * Works on a Design (src/utils/design-doc.ts). Positions are fractions of the page and type sizes a fraction of its
 * height, as in src/lib/design-render.ts, so what is dragged here is what prints. It saves itself. Nothing here spends:
 * "More options" on the brief is the only way to a new round, and its button says what that costs.
 *
 *   const s = DesignStudio.mount(host, { brief, options, optionId, assistantName, post, onClose, onApprove, onRefer, chatAvailable });
 *   s.setDesign(optionId, design, photoUrl); s.destroy();
 */
(function () {
  'use strict';

  const BOX_PAD_RATIO = 0.35;   // src/utils/design-doc.ts
  const LINE_HEIGHT = 1.25;
  const SAVE_MS = 700;
  const UNDO_MAX = 50;
  const ROLE_LABEL = {
    headline: 'the headline', subheading: 'the subheading', points: 'the points', offer: 'the offer', callToAction: 'the call to action',
    dateLine: 'the date line', contact: 'the contact details', wordmark: 'the business name', qr: 'the QR code', logo: 'the logo', circle: 'the circle', text: 'the text box',
  };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const rgba = (hex, a) => { const m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || ''); return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : 'transparent'; };
  const fontStack = (f) => (f ? `'${f}', system-ui, sans-serif` : "'Plus Jakarta Sans', system-ui, sans-serif");

  function ensureCss() {
    if (document.getElementById('design-studio-css')) return;
    const css = document.createElement('style');
    css.id = 'design-studio-css';
    css.textContent = `
      .ds-stage-wrap { display: flex; justify-content: center; background: #eceae6; border-radius: 12px; padding: 20px; overflow: auto; }
      .ds-page { position: relative; overflow: hidden; flex-shrink: 0; box-shadow: 0 4px 18px rgba(0,0,0,.18); touch-action: none; user-select: none; }
      .ds-photo { position: absolute; background-size: cover; background-position: center; cursor: move; }
      .ds-layer { position: absolute; cursor: move; box-sizing: border-box; }
      .ds-layer[data-kind="text"] { white-space: pre-wrap; overflow-wrap: anywhere; }
      .ds-layer img { width: 100%; height: 100%; object-fit: contain; display: block; pointer-events: none; }
      .ds-page .ds-sel { outline: 2px solid #ff007f; outline-offset: 1px; }
      .ds-page.ds-picking .ds-layer:hover, .ds-page.ds-picking .ds-photo:hover { outline: 3px dashed #ff007f; outline-offset: 1px; cursor: pointer; }
      .ds-handle { position: absolute; width: 14px; height: 14px; background: #fff; border: 2px solid #ff007f; border-radius: 50%; z-index: 5; touch-action: none; }
      .ds-handle[data-h="e"] { right: -8px; top: calc(50% - 7px); cursor: ew-resize; }
      .ds-handle[data-h="se"] { right: -8px; bottom: -8px; cursor: nwse-resize; }
      .ds-editing { cursor: text !important; user-select: text; outline: 2px solid #ff007f; }
      .ds-tool { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: #374151; }
      .ds-tool input[type=color] { width: 32px; height: 32px; padding: 2px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; cursor: pointer; }
      .ds-tool input[type=number], .ds-tool select { height: 32px; border: 1px solid #d1d5db; border-radius: 6px; padding: 0 6px; font-size: 13px; background: #fff; }
      .ds-tool input[type=range] { width: 90px; }
      .ds-btn { min-height: 32px; min-width: 32px; padding: 0 10px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; font-size: 13px; font-weight: 700; color: #1f2937; cursor: pointer; }
      .ds-btn[aria-pressed="true"] { background: #1f2937; color: #fff; border-color: #1f2937; }
      .ds-btn:disabled { opacity: .45; cursor: default; }
      .ds-font { position: relative; width: 190px; }
      .ds-font [data-fp-toggle] { padding: 4px 8px; }
      .ds-font [data-fp-current] { font-size: 13px; }
      .ds-font [data-fp-panel] { width: 260px; z-index: 40; }
      .ds-thumb { width: 56px; border: 2px solid transparent; border-radius: 6px; overflow: hidden; cursor: pointer; background: #fff; flex-shrink: 0; padding: 0; }
      .ds-thumb[aria-current="true"] { border-color: #ff007f; }
      .ds-thumb img { width: 100%; display: block; }
      .chatpane-dock[data-ds-full] { position: fixed; inset: 0; z-index: 10500; background: #fff; overflow: auto; padding: 12px; }
      .chatpane-dock[data-ds-full].is-on > .chatpane-dock-col { top: 12px; height: calc(100vh - 24px); }
      .chatpane-dock[data-ds-full] .ds-stage-wrap { max-height: none; }`;
    document.head.appendChild(css);
  }

  /** White behind dark words, black behind light ones. */
  function contrastFor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '#ffffff';
    const n = parseInt(m[1], 16);
    const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    return lum < 0.5 ? '#ffffff' : '#000000';
  }

  function mount(host, opts) {
    ensureCss();
    const o = opts;
    const st = {
      optionId: o.optionId, design: null, photoUrl: null, selected: null, picking: false, editing: null,
      undo: [], redo: [], saveTimer: null, saving: false, savedText: '', pageW: 0, pageH: 0, error: '', loading: true, full: false,
    };
    let fontPicker = null;
    let destroyed = false;

    const ratio = () => st.design.pageW / st.design.pageH;
    const selectedLayer = () => st.design && st.design.layers.find((l) => l.id === st.selected);
    const labelOf = (id) => {
      if (id === 'photo') return 'the picture';
      const l = st.design.layers.find((x) => x.id === id);
      return l ? (ROLE_LABEL[l.role] || 'the text box') : 'this part';
    };

    host.innerHTML = `
      <div data-design-studio>
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <button type="button" data-ds-back class="ds-btn">← Briefs</button>
          <p class="text-sm font-bold text-gray-900 truncate mr-auto min-w-0">${esc(o.brief.title)}</p>
          <span data-ds-saved class="text-xs font-semibold text-gray-500" aria-live="polite"></span>
          <button type="button" data-ds-undo class="ds-btn" aria-label="Undo" title="Undo">↶</button>
          <button type="button" data-ds-redo class="ds-btn" aria-label="Redo" title="Redo">↷</button>
          ${o.chatAvailable ? '<button type="button" data-ds-pick class="ds-btn" aria-pressed="false" title="Click a part of the design to talk about it">🎯 Select</button>' : ''}
          <button type="button" data-ds-full class="ds-btn" aria-pressed="false">Full screen</button>
          <button type="button" data-ds-more class="ds-btn">More options</button>
          <button type="button" data-ds-approve class="btn-golive px-4 min-h-[32px] text-sm font-bold rounded-lg">Use this design</button>
        </div>
        <div data-ds-tools class="flex flex-wrap items-center gap-3 bg-white border border-gray-200 rounded-xl px-3 py-2 mb-3 min-h-[50px]"></div>
        <p data-ds-error role="alert" class="hidden text-sm font-semibold text-red-600 mb-2"></p>
        <div class="ds-stage-wrap" data-ds-wrap><div class="ds-page" data-ds-page role="application" aria-label="Your design. Click a part to change it." tabindex="0"></div></div>
        <div data-ds-thumbs class="flex gap-2 mt-3 overflow-x-auto"></div>
        <p class="text-xs text-gray-600 mt-2">Click anything to change it, drag to move it, double-click words to type. Or ask in the chat.</p>
      </div>`;
    const q = (sel) => host.querySelector(sel);
    const page = q('[data-ds-page]');

    // ── Saving ───────────────────────────────────────────────────────────────
    function showSaved(text) { const el = q('[data-ds-saved]'); if (el) el.textContent = text; }
    function showError(msg) { const el = q('[data-ds-error]'); if (!el) return; el.textContent = msg || ''; el.classList.toggle('hidden', !msg); }
    async function saveNow(finish) {
      clearTimeout(st.saveTimer);
      st.saveTimer = null;
      if (!st.design) return;
      const optionId = st.optionId;
      showSaved('Saving…');
      try {
        await o.post({ action: 'save_design', optionId, design: st.design, finish: !!finish });
        if (!destroyed) { showSaved('Saved'); showError(''); }
      } catch (err) {
        if (!destroyed) { showSaved(''); showError(err.message || 'That could not be saved. Your changes are still here, so please try again.'); }
        throw err;
      }
    }
    function scheduleSave() {
      showSaved('Saving…');
      clearTimeout(st.saveTimer);
      st.saveTimer = setTimeout(() => { saveNow(false).catch(() => {}); }, SAVE_MS);
    }

    /** Before a change: what Undo goes back to. */
    function remember() {
      st.undo.push(JSON.stringify(st.design));
      if (st.undo.length > UNDO_MAX) st.undo.shift();
      st.redo = [];
      paintUndo();
    }
    function paintUndo() {
      const u = q('[data-ds-undo]'); const r = q('[data-ds-redo]');
      if (u) u.disabled = !st.undo.length;
      if (r) r.disabled = !st.redo.length;
    }
    function restore(from, to) {
      if (!from.length) return;
      to.push(JSON.stringify(st.design));
      st.design = JSON.parse(from.pop());
      if (st.selected && st.selected !== 'photo' && !selectedLayer()) st.selected = null;
      paint();
      scheduleSave();
    }

    // ── Painting ─────────────────────────────────────────────────────────────
    function sizePage() {
      const wrap = q('[data-ds-wrap]');
      if (!wrap || !st.design) return;
      const room = wrap.clientWidth - 40;
      const top = wrap.getBoundingClientRect().top;
      const maxH = Math.max(320, (st.full ? window.innerHeight - 180 : window.innerHeight - Math.max(top, 120) - 40));
      let w = room;
      let h = w / ratio();
      if (h > maxH) { h = maxH; w = h * ratio(); }
      st.pageW = Math.round(w);
      st.pageH = Math.round(h);
      page.style.width = `${st.pageW}px`;
      page.style.height = `${st.pageH}px`;
    }
    function layerStyle(l) {
      const pos = `left:${l.x * 100}%;top:${l.y * 100}%;width:${l.w * 100}%;`;
      if (l.kind === 'shape') return `${pos}height:${l.h * 100}%;background:${l.color};opacity:${l.opacity};border-radius:${l.round ? '50%' : '0'};`;
      if (l.kind !== 'text') return `${pos}height:${l.h * 100}%;`;
      const size = l.fontSizePct * st.pageH;
      return `${pos}font-family:${esc(fontStack(l.fontFamily))};font-size:${size}px;line-height:${LINE_HEIGHT};font-weight:${l.bold ? 800 : 400};text-align:${l.align};color:${l.color};`
        + (l.boxFill ? `background:${rgba(l.boxFill, l.boxOpacity)};padding:${size * BOX_PAD_RATIO}px;border-radius:${size * 0.25}px;` : '');
    }
    function paintPage() {
      const d = st.design;
      page.style.background = d.pageColor;
      page.classList.toggle('ds-picking', st.picking);
      const handles = '<span class="ds-handle" data-h="e"></span><span class="ds-handle" data-h="se"></span>';
      const photo = d.photo ? `<div class="ds-photo ${st.selected === 'photo' ? 'ds-sel' : ''}" data-ds-id="photo" style="left:${d.photo.x * 100}%;top:${d.photo.y * 100}%;width:${d.photo.w * 100}%;height:${d.photo.h * 100}%;opacity:${d.photo.opacity};background-image:url('${esc(st.photoUrl || '')}')">${st.selected === 'photo' ? handles : ''}</div>` : '';
      page.innerHTML = photo + d.layers.map((l) => {
        if (l.fontFamily) window.FontPicker?.loadFamily(l.fontFamily);
        const inner = l.kind === 'text' ? esc(l.text) : l.kind === 'shape' ? '' : `<img src="${esc(l.src)}" alt="${esc(ROLE_LABEL[l.role] || '')}">`;
        return `<div class="ds-layer ${st.selected === l.id ? 'ds-sel' : ''}" data-ds-id="${esc(l.id)}" data-kind="${l.kind}" style="${layerStyle(l)}">${inner}${st.selected === l.id ? handles : ''}</div>`;
      }).join('');
    }
    function paintThumbs() {
      const el = q('[data-ds-thumbs]');
      if (!el) return;
      const list = o.options();
      el.innerHTML = list.length > 1 ? list.map((x, i) => `<button type="button" class="ds-thumb" data-ds-thumb="${x.id}" aria-current="${x.id === st.optionId}" aria-label="Design ${i + 1}"><img src="${esc(x.url || '')}" alt=""></button>`).join('') : '';
    }
    function paintTools() {
      const el = q('[data-ds-tools]');
      if (!el || !st.design) return;
      const prevSearchOpen = el.querySelector('[data-fp-panel]:not([hidden])');
      if (prevSearchOpen) return;
      fontPicker?.destroy();
      fontPicker = null;
      const d = st.design;
      const l = selectedLayer();
      const pct = (v) => Math.round((1 - v) * 100);
      const ask = o.chatAvailable ? '<button type="button" data-ds-ask class="ds-btn">Ask about this</button>' : '';
      if (l && l.kind === 'text') {
        el.innerHTML = `
          <span class="ds-font" data-ds-font></span>
          <label class="ds-tool">Size <input type="number" data-ds-size min="4" max="200" value="${Math.round(l.fontSizePct * 1000) / 10 * 2}" style="width:60px"></label>
          <button type="button" class="ds-btn" data-ds-bold aria-pressed="${l.bold}" aria-label="Bold"><b>B</b></button>
          <label class="ds-tool"><span class="sr-only">Line up</span><select data-ds-align aria-label="Line up">${[['left', 'Left'], ['center', 'Centre'], ['right', 'Right']].map(([k, t]) => `<option value="${k}" ${l.align === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="ds-tool">Words <input type="color" data-ds-color value="${esc(l.color)}"></label>
          <label class="ds-tool">Background <input type="checkbox" data-ds-boxon ${l.boxFill ? 'checked' : ''}><input type="color" data-ds-box value="${esc(l.boxFill || contrastFor(l.color))}" ${l.boxFill ? '' : 'disabled'}></label>
          <label class="ds-tool">Transparency <input type="range" data-ds-boxop min="0" max="100" value="${pct(l.boxOpacity)}" ${l.boxFill ? '' : 'disabled'}></label>
          ${ask}<button type="button" class="ds-btn" data-ds-delete>Delete</button>`;
        fontPicker = window.FontPicker?.mount(el.querySelector('[data-ds-font]'), {
          value: l.fontFamily, label: 'Font', sample: false,
          onChange: (family) => { remember(); l.fontFamily = family; paint(); scheduleSave(); },
        }) || null;
        return;
      }
      if (st.selected === 'photo' && d.photo) {
        el.innerHTML = `
          <label class="ds-tool">Transparency <input type="range" data-ds-photoop min="0" max="100" value="${pct(d.photo.opacity)}"></label>
          ${o.options().filter((x) => x.id !== st.optionId && x.hasPhoto).length ? '<button type="button" class="ds-btn" data-ds-photo-next>Use another picture</button>' : ''}
          ${ask}<button type="button" class="ds-btn" data-ds-delete>Remove picture</button>`;
        return;
      }
      if (l) {
        el.innerHTML = `${l.kind === 'shape' ? `<label class="ds-tool">Colour <input type="color" data-ds-shape value="${esc(l.color)}"></label><label class="ds-tool">Transparency <input type="range" data-ds-shapeop min="0" max="100" value="${pct(l.opacity)}"></label>` : ''}${ask}<button type="button" class="ds-btn" data-ds-delete>Delete</button>`;
        return;
      }
      el.innerHTML = `
        <label class="ds-tool">Page colour <input type="color" data-ds-page-color value="${esc(d.pageColor)}"></label>
        <button type="button" class="ds-btn" data-ds-add>+ Add words</button>
        <span class="text-xs text-gray-600">Click a part of the design to change it.</span>`;
    }
    function paint() {
      if (!st.design) return;
      sizePage();
      paintPage();
      paintTools();
      paintUndo();
      paintThumbs();
      const pick = q('[data-ds-pick]');
      if (pick) pick.setAttribute('aria-pressed', String(st.picking));
    }

    // ── Dragging ─────────────────────────────────────────────────────────────
    let drag = null;
    page.addEventListener('pointerdown', (e) => {
      if (st.editing || !st.design) return;
      const handle = e.target.closest('.ds-handle');
      const part = e.target.closest('[data-ds-id]');
      if (st.picking) return;
      if (!part) { if (st.selected) { st.selected = null; paint(); } return; }
      const id = part.dataset.dsId;
      if (st.selected !== id) { st.selected = id; paint(); }
      const target = id === 'photo' ? st.design.photo : st.design.layers.find((l) => l.id === id);
      if (!target) return;
      drag = { id, target, mode: handle ? handle.dataset.h : 'move', sx: e.clientX, sy: e.clientY, x: target.x, y: target.y, w: target.w, h: target.h, size: target.fontSizePct, moved: false };
      page.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    page.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = (e.clientX - drag.sx) / st.pageW;
      const dy = (e.clientY - drag.sy) / st.pageH;
      if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 3) return;
      if (!drag.moved) { drag.moved = true; remember(); }
      const t = drag.target;
      if (drag.mode === 'move') { t.x = clamp(drag.x + dx, -0.5, 1.2); t.y = clamp(drag.y + dy, -0.5, 1.2); }
      else if (drag.mode === 'e') t.w = clamp(drag.w + dx, 0.05, 1.5);
      else {
        // The corner scales: a text box's words grow with it, a picture or shape keeps its shape.
        const scale = clamp((drag.w + dx) / drag.w, 0.1, 6);
        t.w = drag.w * scale;
        if (drag.size != null) t.fontSizePct = clamp(drag.size * scale, 0.006, 0.3);
        if (drag.h != null) t.h = drag.h * scale;
      }
      const el = page.querySelector(`[data-ds-id="${CSS.escape(drag.id)}"]`);
      if (el && drag.id !== 'photo') { const keep = el.innerHTML; el.setAttribute('style', layerStyle(t)); el.innerHTML = keep; }
      else if (el) { el.style.left = `${t.x * 100}%`; el.style.top = `${t.y * 100}%`; el.style.width = `${t.w * 100}%`; el.style.height = `${t.h * 100}%`; }
    });
    function endDrag() {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (moved) { paintTools(); scheduleSave(); }
    }
    page.addEventListener('pointerup', endDrag);
    page.addEventListener('pointercancel', endDrag);

    // Double-click: type on the design itself.
    page.addEventListener('dblclick', (e) => {
      const part = e.target.closest('[data-kind="text"]');
      if (!part || st.picking) return;
      const l = st.design.layers.find((x) => x.id === part.dataset.dsId);
      if (!l) return;
      st.editing = l.id;
      part.querySelectorAll('.ds-handle').forEach((h) => h.remove());
      part.classList.add('ds-editing');
      part.textContent = l.text;
      part.contentEditable = 'plaintext-only';
      part.focus();
      const finish = () => {
        part.removeEventListener('blur', finish);
        const next = part.innerText.replace(/\n$/, '');
        st.editing = null;
        if (next !== l.text) { remember(); l.text = next; scheduleSave(); }
        paint();
      };
      part.addEventListener('blur', finish);
      part.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); part.blur(); } });
    });

    // ── The tools ────────────────────────────────────────────────────────────
    function change(fn) { remember(); fn(); paint(); scheduleSave(); }
    host.addEventListener('input', (e) => {
      const t = e.target;
      const l = selectedLayer();
      // Live, on the page, while a colour or slider moves: remembered once, when it starts.
      if (t.matches('[data-ds-boxop],[data-ds-photoop],[data-ds-shapeop],[data-ds-color],[data-ds-box],[data-ds-page-color],[data-ds-shape]')) {
        if (!st.liveChange) { remember(); st.liveChange = true; }
        const op = 1 - Number(t.value) / 100;
        if (t.matches('[data-ds-boxop]') && l) l.boxOpacity = op;
        else if (t.matches('[data-ds-photoop]') && st.design.photo) st.design.photo.opacity = op;
        else if (t.matches('[data-ds-shapeop]') && l) l.opacity = op;
        else if (t.matches('[data-ds-color]') && l) l.color = t.value;
        else if (t.matches('[data-ds-box]') && l) l.boxFill = t.value;
        else if (t.matches('[data-ds-page-color]')) st.design.pageColor = t.value;
        else if (t.matches('[data-ds-shape]') && l) l.color = t.value;
        paintPage();
        scheduleSave();
      }
    });
    host.addEventListener('change', (e) => {
      const t = e.target;
      st.liveChange = false;
      const l = selectedLayer();
      if (t.matches('[data-ds-size]') && l) change(() => { l.fontSizePct = clamp(Number(t.value) / 2 / 100, 0.006, 0.3); });
      else if (t.matches('[data-ds-align]') && l) change(() => { l.align = t.value; });
      // A box in the page's own colour would be invisible: it starts behind the words in their opposite.
      else if (t.matches('[data-ds-boxon]') && l) change(() => { l.boxFill = t.checked ? contrastFor(l.color) : null; l.boxOpacity = 1; });
    });
    host.addEventListener('click', async (e) => {
      const t = (sel) => e.target.closest(sel);
      // "Select": this click says what to talk about.
      if (st.picking) {
        const part = t('[data-ds-page] [data-ds-id]');
        if (part) {
          e.preventDefault();
          refer(part.dataset.dsId);
          st.picking = false;
          paint();
          return;
        }
      }
      if (t('[data-ds-back]')) { await close(); return; }
      if (t('[data-ds-undo]')) { restore(st.undo, st.redo); return; }
      if (t('[data-ds-redo]')) { restore(st.redo, st.undo); return; }
      if (t('[data-ds-pick]')) { st.picking = !st.picking; st.selected = null; paint(); return; }
      if (t('[data-ds-full]')) { setFull(!st.full); return; }
      if (t('[data-ds-ask]')) { refer(st.selected); return; }
      if (t('[data-ds-bold]')) { const l = selectedLayer(); if (l) change(() => { l.bold = !l.bold; }); return; }
      if (t('[data-ds-add]')) {
        change(() => {
          const id = `t${Date.now().toString(36)}`;
          st.design.layers.push({ id, kind: 'text', role: 'text', text: 'Your words', x: 0.1, y: 0.45, w: 0.8, fontFamily: null, fontSizePct: 0.04, bold: true, align: 'center', color: '#1f1e1b', boxFill: null, boxOpacity: 1 });
          st.selected = id;
        });
        return;
      }
      if (t('[data-ds-delete]')) {
        change(() => {
          if (st.selected === 'photo') st.design.photo = null;
          else st.design.layers = st.design.layers.filter((l) => l.id !== st.selected);
          st.selected = null;
        });
        return;
      }
      if (t('[data-ds-photo-next]')) { await nextPhoto(); return; }
      const thumb = t('[data-ds-thumb]');
      if (thumb) { await openOption(Number(thumb.dataset.dsThumb)); return; }
      if (t('[data-ds-more]')) { await close(); o.onMore?.(); return; }
      if (t('[data-ds-approve]')) {
        const btn = t('[data-ds-approve]');
        btn.disabled = true;
        try {
          await saveNow(true);
          await o.onApprove(st.optionId);
          setFull(false);
        } catch (err) { showError(err.message || 'That could not be done. Please try again.'); btn.disabled = false; }
      }
    });
    function refer(id) {
      if (!o.chatAvailable || !id) return;
      const what = labelOf(id);
      const l = st.design.layers.find((x) => x.id === id);
      const shown = l && l.kind === 'text' ? `, which says “${l.text.replace(/\s+/g, ' ').slice(0, 80)}”` : '';
      o.onRefer({
        label: `${what.charAt(0).toUpperCase()}${what.slice(1)}`,
        message: `About ${what} (layer "${l ? l.id : 'photo'}"${shown}) on option ${st.optionId} of my brief ${o.brief.id} “${o.brief.title}”.`,
      });
    }
    async function nextPhoto() {
      const others = o.options().filter((x) => x.id !== st.optionId && x.hasPhoto);
      if (!others.length) return;
      st.photoAt = ((st.photoAt || 0) + 1) % others.length;
      try {
        remember();
        const r = await o.post({ action: 'save_design', optionId: st.optionId, design: st.design, usePhotoFromOption: others[st.photoAt].id });
        st.design = r.design;
        st.photoUrl = r.photoUrl;
        paint();
      } catch (err) { showError(err.message); }
    }

    // ── Moving around ────────────────────────────────────────────────────────
    function setFull(on) {
      st.full = !!on;
      const layout = host.closest('.chatpane-dock');
      if (layout) layout.toggleAttribute('data-ds-full', st.full);
      if (window.ScrollLock) { if (st.full) window.ScrollLock.lock('design-studio-full'); else window.ScrollLock.release('design-studio-full'); }
      const b = q('[data-ds-full]');
      if (b) { b.setAttribute('aria-pressed', String(st.full)); b.textContent = st.full ? 'Exit full screen' : 'Full screen'; }
      paint();
    }
    async function openOption(optionId) {
      if (st.saveTimer || st.design) await saveNow(true).catch(() => {});
      st.loading = true;
      st.optionId = optionId;
      st.selected = null;
      st.undo = [];
      st.redo = [];
      showSaved('Opening…');
      try {
        const r = await o.post({ action: 'open_design', optionId });
        if (destroyed) return;
        st.design = r.design;
        st.photoUrl = r.photoUrl;
        showSaved('');
        showError('');
        paint();
      } catch (err) { showSaved(''); showError(err.message); }
      st.loading = false;
    }
    async function close() {
      setFull(false);
      try { await saveNow(true); } catch { /* still here; o.onClose goes back regardless of a failed preview */ }
      o.onClose();
    }

    function onKey(e) {
      if (destroyed || st.editing) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if (e.key === 'Escape') {
        if (typing) return;
        if (st.picking) { st.picking = false; paint(); return; }
        if (st.full) { setFull(false); return; }
        if (st.selected) { st.selected = null; paint(); }
        return;
      }
      if (typing || !host.contains(e.target) && e.target !== document.body) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) restore(st.redo, st.undo); else restore(st.undo, st.redo); return; }
      const target = st.selected === 'photo' ? st.design?.photo : selectedLayer();
      if (!target) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); q('[data-ds-delete]')?.click(); return; }
      const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (nudge) {
        e.preventDefault();
        remember();
        const step = e.shiftKey ? 0.02 : 0.004;
        target.x += nudge[0] * step;
        target.y += nudge[1] * step;
        paintPage();
        scheduleSave();
      }
    }
    document.addEventListener('keydown', onKey);
    const onResize = () => { if (st.design) { sizePage(); paintPage(); } };
    window.addEventListener('resize', onResize);
    const ro = window.ResizeObserver ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe(q('[data-ds-wrap]'));

    openOption(o.optionId);

    return {
      get optionId() { return st.optionId; },
      /** A change saved from the chat's card: shown here, and Undo goes back past it. */
      setDesign(optionId, design, photoUrl) {
        if (optionId !== st.optionId) return;
        clearTimeout(st.saveTimer);
        st.saveTimer = null;
        remember();
        st.design = design;
        if (photoUrl !== undefined) st.photoUrl = photoUrl;
        if (st.selected && st.selected !== 'photo' && !selectedLayer()) st.selected = null;
        paint();
        scheduleSave();
      },
      refreshThumbs: paintThumbs,
      destroy() {
        destroyed = true;
        clearTimeout(st.saveTimer);
        setFull(false);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', onResize);
        ro?.disconnect();
        fontPicker?.destroy();
        host.innerHTML = '';
      },
    };
  }

  window.DesignStudio = { mount };
})();
