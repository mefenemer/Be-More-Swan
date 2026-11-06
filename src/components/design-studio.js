/**
 * src/components/design-studio.js — the Brand Designer's editor (owner, 2026-11-05): the design on the left, the chat on
 * the right, and everything on it can be clicked and changed, "very much like in Canva". Tabs track where a brief is;
 * making it happens here.
 *
 * Works on a Design (src/utils/design-doc.ts). Positions are fractions of the page and type sizes a fraction of its
 * height, as in src/lib/design-render.ts, so what is dragged here is what prints. It saves itself. Nothing here spends:
 * the round button on the brief is the only way to a new round, and it says what that costs. "Back to brief" goes there.
 *
 *   const s = DesignStudio.mount(host, { brief, options, optionId, assistantName, post, onClose, onApprove, onRefer, chatAvailable });
 *   s.setDesign(optionId, design, photoUrl); s.destroy();
 */
(function () {
  'use strict';

  const BOX_PAD_RATIO = 0.35;   // src/utils/design-doc.ts
  const LINE_HEIGHT = 1.25;
  const MAX_PICTURES = 6;       // DESIGN_LIMITS in src/utils/design-doc.ts
  const MAX_ZOOM = 5;
  const SNAP_PX = 6;
  const SAVE_MS = 700;
  const UNDO_MAX = 50;
  const ROLE_LABEL = {
    headline: 'the headline', subheading: 'the subheading', points: 'the points', offer: 'the offer', callToAction: 'the call to action',
    dateLine: 'the date line', contact: 'the contact details', wordmark: 'the business name', qr: 'the QR code', logo: 'the logo', circle: 'the circle', shape: 'the shape', line: 'the line', picture: 'the added picture', text: 'the text box',
  };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const rgba = (hex, a) => { const m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || ''); return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : 'transparent'; };
  const fontStack = (f) => (f ? `'${f}', system-ui, sans-serif` : "'Plus Jakarta Sans', system-ui, sans-serif");
  /** The page colour at its strength, on white paper: pageFill in src/utils/design-doc.ts, so the screen matches the print. */
  const pageFill = (d) => {
    const m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(d.pageColor || '');
    const a = d.pageOpacity == null ? 1 : d.pageOpacity;
    if (!m || a >= 1) return d.pageColor;
    return `#${[m[1], m[2], m[3]].map((h) => Math.round(parseInt(h, 16) * a + 255 * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
  };
  /** A picture filling a frame `crop` zoomed and placed: the same sum as cropRect in src/utils/design-doc.ts. */
  const cropStyle = (crop) => {
    const c = crop || { zoom: 1, x: 0.5, y: 0.5 };
    return `width:${c.zoom * 100}%;height:${c.zoom * 100}%;left:${-(c.zoom - 1) * c.x * 100}%;top:${-(c.zoom - 1) * c.y * 100}%;object-position:${c.x * 100}% ${c.y * 100}%;`;
  };
  // The tallest the text tools can be, to measure the room they need.
  const SAMPLE_WORDS = { kind: 'text', text: '', bold: false, align: 'left', color: '#000000', boxFill: null, boxOpacity: 1, fontSizePct: 0.03 };
  const RESERVE_MIN_WIDTH = 560;   // below this (a phone) the room would take the page's place

  function ensureCss() {
    if (document.getElementById('design-studio-css')) return;
    const css = document.createElement('style');
    css.id = 'design-studio-css';
    css.textContent = `
      .ds-stage-wrap { display: flex; justify-content: center; background: #eceae6; border-radius: 12px; padding: 20px; overflow: auto; }
      .ds-page { position: relative; overflow: hidden; flex-shrink: 0; box-shadow: 0 4px 18px rgba(0,0,0,.18); touch-action: none; user-select: none; }
      .ds-photo { position: absolute; cursor: move; }
      .ds-clip { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
      .ds-clip img { position: absolute; display: block; max-width: none; object-fit: cover; pointer-events: none; }
      .ds-cropping { cursor: grab !important; outline: 2px dashed #ff007f !important; outline-offset: 1px; }
      .ds-guide { position: absolute; background: #ff007f; pointer-events: none; z-index: 6; }
      .ds-guide[data-axis="x"] { top: 0; bottom: 0; width: 1px; }
      .ds-guide[data-axis="y"] { left: 0; right: 0; height: 1px; }
      .ds-layer { position: absolute; cursor: move; box-sizing: border-box; }
      .ds-layer[data-kind="text"] { white-space: pre-wrap; overflow-wrap: anywhere; min-height: 1em; }
      .ds-layer img { width: 100%; height: 100%; object-fit: contain; display: block; pointer-events: none; }
      .ds-page .ds-sel { outline: 2px solid #ff007f; outline-offset: 1px; }
      .ds-page.ds-picking .ds-layer:hover, .ds-page.ds-picking .ds-photo:hover { outline: 3px dashed #ff007f; outline-offset: 1px; cursor: pointer; }
      .ds-handle { position: absolute; width: 14px; height: 14px; background: #fff; border: 2px solid #ff007f; border-radius: 50%; z-index: 5; touch-action: none; }
      .ds-handle[data-h="e"] { right: -8px; top: calc(50% - 7px); cursor: ew-resize; }
      .ds-handle[data-h="s"] { bottom: -8px; left: calc(50% - 7px); cursor: ns-resize; }
      .ds-handle[data-h="se"] { right: -8px; bottom: -8px; cursor: nwse-resize; }
      .ds-editing { cursor: text !important; user-select: text; outline: 2px solid #ff007f; }
      .ds-tool { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: #374151; }
      .ds-tool input[type=color] { width: 32px; height: 32px; padding: 2px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; cursor: pointer; }
      .ds-tool input[type=number], .ds-tool select { height: 32px; border: 1px solid #d1d5db; border-radius: 6px; padding: 0 6px; font-size: 13px; background: #fff; }
      .ds-tool input[type=range] { width: 90px; }
      [data-ds-tools] { align-content: flex-start; }
      .ds-group-box { position: absolute; border: 2px solid #ff007f; pointer-events: none; z-index: 5; box-sizing: border-box; }
      .ds-group-box .ds-handle { pointer-events: auto; right: -8px; bottom: -8px; cursor: nwse-resize; }
      .ds-marquee { position: absolute; border: 1px solid #ff007f; background: rgba(255,0,127,.12); pointer-events: none; z-index: 6; }
      .ds-page .ds-sel-member { outline: 1px dashed #ff007f; outline-offset: 1px; }
      .ds-btn { min-height: 32px; min-width: 32px; padding: 0 10px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; font-size: 13px; font-weight: 700; color: #1f2937; cursor: pointer; }
      .ds-btn[aria-pressed="true"] { background: #1f2937; color: #fff; border-color: #1f2937; }
      .ds-btn:disabled { opacity: .45; cursor: default; }
      .ds-font { position: relative; width: 190px; min-height: 40px; }
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
      pictureUrls: {}, cropping: false, multi: [],
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
          <button type="button" data-ds-back class="ds-btn" title="Save and open this brief, where you can ask for different designs">← Back to brief</button>
          <p class="text-sm font-bold text-gray-900 truncate mr-auto min-w-0">${esc(o.brief.title)}</p>
          <span data-ds-saved class="text-xs font-semibold text-gray-500" aria-live="polite"></span>
          <span data-ds-sides class="inline-flex items-center gap-1"></span>
          <button type="button" data-ds-undo class="ds-btn" aria-label="Undo" title="Undo">↶</button>
          <button type="button" data-ds-redo class="ds-btn" aria-label="Redo" title="Redo">↷</button>
          ${o.chatAvailable ? '<button type="button" data-ds-pick class="ds-btn" aria-pressed="false" title="Click a part of the design to talk about it">🎯 Select</button>' : ''}
          <button type="button" data-ds-full class="ds-btn" aria-pressed="false">Full screen</button>
          <button type="button" data-ds-approve class="btn-golive px-4 min-h-[32px] text-sm font-bold rounded-lg">Use this design</button>
        </div>
        <div data-ds-tools class="flex flex-wrap items-center gap-3 bg-white border border-gray-200 rounded-xl px-3 py-2 mb-3 min-h-[50px]"></div>
        <p data-ds-error role="alert" class="hidden text-sm font-semibold text-red-600 mb-2"></p>
        <div class="ds-stage-wrap" data-ds-wrap><div class="ds-page" data-ds-page role="application" aria-label="Your design. Click a part to change it." tabindex="0"></div></div>
        <div data-ds-thumbs class="flex gap-2 mt-3 overflow-x-auto"></div>
        <p class="text-xs text-gray-600 mt-2">Click anything to change it, drag to move it, and click selected words to type. Shift-click or drag across the page to select several. Hold Alt while dragging to turn off the guides. Or ask in the chat.</p>
      </div>`;
    const q = (sel) => host.querySelector(sel);
    const page = q('[data-ds-page]');

    // ── The two sides of a flyer ─────────────────────────────────────────────
    // Everything here works on st.design, so showing the back swaps the two sides round in it and marks `side`. Undo
    // comes along for free. What goes to the server is always the design the right way round: wire().
    const SIDE_FIELDS = ['pageColor', 'pageOpacity', 'photo', 'layers', 'removed'];
    function flipped(d) {
      const out = { ...d, back: { ...d.back }, side: d.side === 'back' ? 'front' : 'back' };
      SIDE_FIELDS.forEach((k) => { out[k] = d.back[k]; out.back[k] = d[k]; });
      return out;
    }
    const onBackSide = () => st.design && st.design.side === 'back';
    const wire = () => (onBackSide() ? flipped(st.design) : st.design);
    const sideParam = () => (onBackSide() ? { side: 'back' } : {});
    function showSide(side) {
      if ((side === 'back') === !!onBackSide() || (side === 'back' && !st.design.back)) return;
      st.design = flipped(st.design);
      st.selected = null;
      st.multi = [];
      st.cropping = false;
      paint();
    }
    function paintSides() {
      const el = q('[data-ds-sides]');
      if (!el || !st.design) return;
      if (st.design.kind !== 'flyer') { el.innerHTML = ''; return; }
      const on = onBackSide();
      el.innerHTML = st.design.back
        ? `<button type="button" class="ds-btn" data-ds-side="front" aria-pressed="${!on}">Front</button><button type="button" class="ds-btn" data-ds-side="back" aria-pressed="${!!on}">Back</button><button type="button" class="ds-btn" data-ds-remove-back title="Make this flyer one-sided. Undo brings the back back.">Remove back</button>`
        : '<button type="button" class="ds-btn" data-ds-add-back>+ Add a back</button>';
    }
    /** Through the server, which offers the logo and QR code on the new side. */
    async function addBack() {
      remember();
      const d = st.design;
      const front = onBackSide() ? flipped(d) : d;
      const withNew = { ...front, back: { pageColor: front.pageColor, pageOpacity: front.pageOpacity, photo: null, layers: [], removed: { layers: [], photo: null } } };
      st.design = flipped(withNew);
      st.selected = null;
      st.multi = [];
      paint();
      try {
        const r = await o.post({ action: 'save_design', optionId: st.optionId, design: wire() });
        // Only what the server adds to the new side: the user may already have changed it while this was on its way.
        const offered = r.design && r.design.back && r.design.back.removed ? r.design.back.removed.layers : [];
        const page = onBackSide() ? st.design : st.design.back;
        if (page) {
          const shelf = page.removed || (page.removed = { layers: [], photo: null });
          offered.forEach((l) => { if (!shelf.layers.some((x) => x.id === l.id) && !page.layers.some((x) => x.id === l.id)) shelf.layers.push(l); });
          paintTools();
        }
      } catch (err) { showError(err.message || 'That could not be saved. Your changes are still here, so please try again.'); }
    }
    /**
     * For a change the server makes and sends back whole: the design holds still until it has, or anything done
     * meanwhile would be overwritten by the reply.
     */
    async function holdingStill(work) {
      const parts = [q('[data-ds-page]'), q('[data-ds-tools]')];
      st.busy = true;
      parts.forEach((el) => { if (el) el.style.pointerEvents = 'none'; });
      try { return await work(); } finally {
        st.busy = false;
        parts.forEach((el) => { if (el) el.style.pointerEvents = ''; });
      }
    }
    function removeBack() {
      change(() => {
        const front = onBackSide() ? flipped(st.design) : st.design;
        st.design = { ...front, back: null, side: 'front' };
        st.selected = null;
        st.multi = [];
      });
    }

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
        await o.post({ action: 'save_design', optionId, design: wire(), finish: !!finish });
        if (!destroyed) { showSaved('Saved'); showError(''); }
      } catch (err) {
        if (!destroyed) { showSaved(''); showError(err.message || 'That could not be saved. Your changes are still here, so please try again.'); }
        throw err;
      }
    }
    function scheduleSave() {
      st.leaveUnsaved = false; // A new change: leaving tries to save it again first.
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
      setMulti(st.multi);
      paint();
      scheduleSave();
    }

    // ── Several at once ──────────────────────────────────────────────────────
    const layerById = (id) => st.design.layers.find((l) => l.id === id);
    const groupOf = (l) => (l && l.group ? st.design.layers.filter((x) => x.group === l.group).map((x) => x.id) : l ? [l.id] : []);
    /** Several selected, or one if that is all it comes to. The background is never one of several: it stays behind them. */
    function setMulti(ids) {
      const live = [...new Set(ids)].filter((id) => layerById(id));
      st.multi = live.length > 1 ? live : [];
      if (live.length === 1) st.selected = live[0];
      else if (live.length > 1) st.selected = null;
    }
    const selectedIds = () => (st.multi.length ? st.multi : st.selected && st.selected !== 'photo' ? [st.selected] : []);
    /** Which parts of the page these cover, measured: a text box's height is what its words make it. */
    function boxOf(ids) {
      const page_ = page.getBoundingClientRect();
      let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
      ids.forEach((id) => {
        const el = page.querySelector(`[data-ds-id="${CSS.escape(id)}"]`);
        if (!el) return;
        const r = el.getBoundingClientRect();
        left = Math.min(left, r.left); top = Math.min(top, r.top); right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
      });
      if (left === Infinity) return null;
      return { x: (left - page_.left) / page_.width, y: (top - page_.top) / page_.height, w: (right - left) / page_.width, h: (bottom - top) / page_.height };
    }
    function paintGroupBox() {
      let el = page.querySelector('.ds-group-box');
      const box = st.multi.length ? boxOf(st.multi) : null;
      if (!box) { if (el) el.remove(); return; }
      if (!el) { el = document.createElement('div'); el.className = 'ds-group-box'; el.innerHTML = '<span class="ds-handle" data-h="group"></span>'; page.appendChild(el); }
      el.style.cssText = `left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%;`;
    }
    function paintLayerEl(t) {
      const el = page.querySelector(`[data-ds-id="${CSS.escape(t.id)}"]`);
      if (!el) return;
      const keep = el.innerHTML;
      el.setAttribute('style', layerStyle(t));
      el.innerHTML = keep;
    }
    function reorder(ids, order) {
      const list = st.design.layers;
      const first = list.findIndex((l) => ids.includes(l.id));
      if (first < 0) return;
      const members = list.filter((l) => ids.includes(l.id));
      const rest = list.filter((l) => !ids.includes(l.id));
      const below = list.slice(0, first).filter((l) => !ids.includes(l.id)).length;
      const at = order === 'front' ? rest.length : order === 'back' ? 0 : order === 'forward' ? Math.min(rest.length, below + 1) : Math.max(0, below - 1);
      st.design.layers = [...rest.slice(0, at), ...members, ...rest.slice(at)];
    }
    function groupSelected() {
      if (st.multi.length < 2) return;
      change(() => {
        const group = `g${Date.now().toString(36)}`;
        // Side by side in the stack, where the topmost was, so moving the group never slides anything between them.
        const members = st.design.layers.filter((l) => st.multi.includes(l.id));
        members.forEach((l) => { l.group = group; });
        const list = st.design.layers;
        const top = list.lastIndexOf(members[members.length - 1]);
        const above = list.slice(top + 1);
        st.design.layers = [...list.slice(0, top + 1).filter((l) => !members.includes(l)), ...members, ...above];
      });
    }
    function ungroupSelected() {
      const groups = new Set(selectedIds().map((id) => layerById(id)?.group).filter(Boolean));
      if (!groups.size) return;
      change(() => { st.design.layers.forEach((l) => { if (groups.has(l.group)) delete l.group; }); });
    }

    // ── Painting ─────────────────────────────────────────────────────────────
    /**
     * Room for the tallest tools, always. Clicking words brings up their tools: if that made the bar taller it would push
     * the design down under the pointer, and the second click of a double-click would miss the words (owner 2026-11-06).
     */
    function reserveTools() {
      const el = q('[data-ds-tools]');
      const width = el ? el.offsetWidth : 0;
      if (!width || width === st.toolsWidth) return;
      st.toolsWidth = width;
      if (width < RESERVE_MIN_WIDTH) { el.style.minHeight = ''; return; }
      const probe = document.createElement('div');
      probe.className = el.className;
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = `position:absolute;visibility:hidden;min-height:0;width:${width}px;align-content:flex-start`;
      el.parentNode.appendChild(probe);
      // Whichever is taller: the words' tools, or the page's own with nothing selected.
      probe.innerHTML = textTools(SAMPLE_WORDS);
      const forWords = probe.offsetHeight;
      probe.innerHTML = st.design ? pageTools() : '';
      el.style.minHeight = `${Math.max(forWords, probe.offsetHeight)}px`;
      probe.remove();
    }
    function sizePage() {
      const wrap = q('[data-ds-wrap]');
      if (!wrap || !st.design) return;
      reserveTools();
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
      if (l.kind === 'picture') return `${pos}height:${l.h * 100}%;opacity:${l.opacity};`;
      if (l.kind !== 'text') return `${pos}height:${l.h * 100}%;`;
      const size = l.fontSizePct * st.pageH;
      return `${pos}font-family:${esc(fontStack(l.fontFamily))};font-size:${size}px;line-height:${l.lineHeight || LINE_HEIGHT};font-weight:${l.bold ? 800 : 400};font-style:${l.italic ? 'italic' : 'normal'};text-decoration:${l.underline ? 'underline' : 'none'};text-align:${l.align};color:${l.color};`
        + (l.boxFill ? `background:${rgba(l.boxFill, l.boxOpacity)};padding:${size * BOX_PAD_RATIO}px;border-radius:${size * 0.25}px;` : '');
    }
    function paintPage() {
      const d = st.design;
      page.style.background = pageFill(d);
      page.classList.toggle('ds-picking', st.picking);
      const handle = (h) => `<span class="ds-handle" data-h="${h}"></span>`;
      const handlesFor = (id, kind) => {
        if (st.selected !== id || st.cropping) return '';
        if (kind === 'text') return handle('e') + handle('se');
        if (kind === 'qr' || kind === 'logo') return handle('se');
        return handle('e') + handle('s') + handle('se');   // a frame: changing its shape shows more or less of the picture
      };
      const cropClass = (id) => (st.cropping && st.selected === id ? 'ds-cropping' : st.multi.includes(id) ? 'ds-sel-member' : '');
      const clip = (url, crop) => `<div class="ds-clip"><img src="${esc(url || '')}" alt="" draggable="false" style="${cropStyle(crop)}"></div>`;
      const photo = d.photo ? `<div class="ds-photo ${st.selected === 'photo' ? 'ds-sel' : ''} ${cropClass('photo')}" data-ds-id="photo" style="left:${d.photo.x * 100}%;top:${d.photo.y * 100}%;width:${d.photo.w * 100}%;height:${d.photo.h * 100}%;opacity:${d.photo.opacity};">${clip(st.pictureUrls[d.photo.id || 'photo0'] || st.photoUrl, d.photo.crop)}${handlesFor('photo', 'picture')}</div>` : '';
      page.innerHTML = photo + d.layers.map((l) => {
        if (l.fontFamily) window.FontPicker?.loadFamily(l.fontFamily);
        const inner = l.kind === 'text' ? esc(l.text) : l.kind === 'shape' ? '' : l.kind === 'picture' ? clip(st.pictureUrls[l.id], l.crop) : `<img src="${esc(l.src)}" alt="${esc(ROLE_LABEL[l.role] || '')}">`;
        return `<div class="ds-layer ${st.selected === l.id ? 'ds-sel' : ''} ${cropClass(l.id)}" data-ds-id="${esc(l.id)}" data-kind="${l.kind}" style="${layerStyle(l)}">${inner}${handlesFor(l.id, l.kind)}</div>`;
      }).join('');
      paintGroupBox();
    }
    function paintThumbs() {
      const el = q('[data-ds-thumbs]');
      if (!el) return;
      const list = o.options();
      el.innerHTML = list.length > 1 ? list.map((x, i) => `<button type="button" class="ds-thumb" data-ds-thumb="${x.id}" aria-current="${x.id === st.optionId}" aria-label="Design ${i + 1}"><img src="${esc(x.url || '')}" alt=""></button>`).join('') : '';
    }
    const pct = (v) => Math.round((1 - v) * 100);
    const askButton = () => (o.chatAvailable ? '<button type="button" data-ds-ask class="ds-btn">Ask about this</button>' : '');
    const orderTool = () => `<label class="ds-tool"><span class="sr-only">Layer order</span><select data-ds-order aria-label="Layer order"><option value="">Layer order</option><option value="front">Bring to front</option><option value="forward">Bring forward</option><option value="backward">Send backward</option><option value="back">Send to back</option></select></label>`;
    const duplicateButton = () => '<button type="button" class="ds-btn" data-ds-duplicate>Duplicate</button>';
    const canPick = () => !!window.MediaPicker;
    const ungroupButton = (l) => (l && l.group ? '<button type="button" class="ds-btn" data-ds-ungroup>Ungroup</button>' : '');
    function textTools(l) {
      return `
          <span class="ds-font" data-ds-font></span>
          <label class="ds-tool">Size <input type="number" data-ds-size min="4" max="200" value="${Math.round(l.fontSizePct * 1000) / 10 * 2}" style="width:60px"></label>
          <button type="button" class="ds-btn" data-ds-bold aria-pressed="${!!l.bold}" aria-label="Bold"><b>B</b></button>
          <button type="button" class="ds-btn" data-ds-italic aria-pressed="${!!l.italic}" aria-label="Italic"><i>I</i></button>
          <button type="button" class="ds-btn" data-ds-underline aria-pressed="${!!l.underline}" aria-label="Underline"><u>U</u></button>
          <label class="ds-tool">Line spacing <input type="number" data-ds-lh min="0.8" max="3" step="0.05" value="${l.lineHeight || LINE_HEIGHT}" style="width:64px"></label>
          <label class="ds-tool"><span class="sr-only">Line up</span><select data-ds-align aria-label="Line up">${[['left', 'Left'], ['center', 'Centre'], ['right', 'Right']].map(([k, t]) => `<option value="${k}" ${l.align === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="ds-tool">Text colour <input type="color" data-ds-color value="${esc(l.color)}"></label>
          <label class="ds-tool">Background <input type="checkbox" data-ds-boxon ${l.boxFill ? 'checked' : ''}><input type="color" data-ds-box value="${esc(l.boxFill || contrastFor(l.color))}"></label>
          <label class="ds-tool">Transparency <input type="range" data-ds-boxop min="0" max="100" value="${pct(l.boxOpacity)}"></label>
          ${orderTool()}${duplicateButton()}${ungroupButton(l)}${askButton()}<button type="button" class="ds-btn" data-ds-delete>Delete</button>`;
    }
    /** Moving a picture about inside its frame: drag it, and this says how far in. */
    function cropTools(crop) {
      return `
        <label class="ds-tool">Zoom <input type="range" data-ds-crop-zoom min="100" max="${MAX_ZOOM * 100}" value="${Math.round((crop ? crop.zoom : 1) * 100)}"></label>
        <span class="text-xs text-gray-600">Drag the picture to choose what shows.</span>
        <button type="button" class="ds-btn" data-ds-crop-reset>Reset</button>
        <button type="button" class="ds-btn" data-ds-crop-done aria-pressed="true">Done</button>`;
    }
    function pictureTools(isMain, target) {
      const replace = canPick() ? '<button type="button" class="ds-btn" data-ds-replace>Replace picture</button>' : '';
      return `
        <button type="button" class="ds-btn" data-ds-crop>Crop</button>
        ${replace}
        <button type="button" class="ds-btn" data-ds-cutout title="Uses 1 task from your monthly allowance, only once the background is removed">Remove background (1 task)</button>
        <label class="ds-tool">Transparency <input type="range" ${isMain ? 'data-ds-photoop' : 'data-ds-picop'} min="0" max="100" value="${pct(target.opacity)}"></label>
        ${isMain ? '<button type="button" class="ds-btn" data-ds-unbg>Make a normal picture</button>' : '<button type="button" class="ds-btn" data-ds-bg>Set as background</button>'}
        ${isMain ? '' : orderTool()}${duplicateButton()}${isMain ? '' : ungroupButton(target)}
        ${isMain && !onBackSide() && o.options().filter((x) => x.id !== st.optionId && x.hasPhoto).length ? '<button type="button" class="ds-btn" data-ds-photo-next>Use another picture</button>' : ''}
        ${askButton()}<button type="button" class="ds-btn" data-ds-delete>${isMain ? 'Remove picture' : 'Delete'}</button>
        ${isMain ? '<span class="text-xs text-gray-600">This is the page background, behind everything else.</span>' : ''}`;
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
      const ask = askButton();
      if (st.multi.length) {
        const members = st.multi.map(layerById);
        const oneGroup = members[0]?.group && members.every((x) => x?.group === members[0].group);
        el.innerHTML = `
          <span class="ds-tool">${st.multi.length} parts selected</span>
          ${oneGroup ? '<button type="button" class="ds-btn" data-ds-ungroup>Ungroup</button>' : '<button type="button" class="ds-btn" data-ds-group>Group</button>'}
          ${orderTool()}${duplicateButton()}<button type="button" class="ds-btn" data-ds-delete>Delete</button>
          <span class="text-xs text-gray-600">Drag to move them together, or drag the corner to resize them.</span>`;
        return;
      }
      if (l && l.kind === 'text') {
        el.innerHTML = textTools(l);
        fontPicker = window.FontPicker?.mount(el.querySelector('[data-ds-font]'), {
          value: l.fontFamily, label: 'Font', sample: false,
          onChange: (family) => { remember(); l.fontFamily = family; paint(); scheduleSave(); },
        }) || null;
        return;
      }
      const pictureTarget = st.selected === 'photo' ? d.photo : l && l.kind === 'picture' ? l : null;
      if (pictureTarget) {
        el.innerHTML = st.cropping ? cropTools(pictureTarget.crop) : pictureTools(st.selected === 'photo', pictureTarget);
        return;
      }
      if (l) {
        el.innerHTML = `${l.kind === 'shape' ? `<label class="ds-tool">Colour <input type="color" data-ds-shape value="${esc(l.color)}"></label><label class="ds-tool">Transparency <input type="range" data-ds-shapeop min="0" max="100" value="${pct(l.opacity)}"></label>` : ''}${orderTool()}${duplicateButton()}${ungroupButton(l)}${ask}<button type="button" class="ds-btn" data-ds-delete>Delete</button>`;
        return;
      }
      el.innerHTML = pageTools();
    }
    /** The tools for the page, with nothing selected. */
    function pageTools() {
      const d = st.design;
      return `
        <label class="ds-tool">Page colour <input type="color" data-ds-page-color value="${esc(d.pageColor)}"></label>
        <label class="ds-tool">Transparency <input type="range" data-ds-page-op min="0" max="100" value="${pct(d.pageOpacity == null ? 1 : d.pageOpacity)}"></label>
        <button type="button" class="ds-btn" data-ds-add>+ Add words</button>
        ${canPick() ? '<button type="button" class="ds-btn" data-ds-add-picture>+ Add picture</button>' : ''}
        <label class="ds-tool"><span class="sr-only">Add a shape</span><select data-ds-add-shape aria-label="Add a shape"><option value="">+ Add shape</option><option value="rectangle">Rectangle</option><option value="circle">Circle</option><option value="line">Line</option></select></label>
        <label class="ds-tool"><span class="sr-only">Resize a copy</span><select data-ds-resize aria-label="Resize a copy"><option value="">Resize a copy</option>${d.kind === 'flyer' ? '<option value="A4">A4 print</option><option value="A5">A5 print</option><option value="A6">A6 print</option><option value="DL">DL print</option>' : ''}<option value="1:1">Square post</option><option value="4:5">Portrait post</option><option value="9:16">Story</option><option value="16:9">Landscape</option></select></label>
        <label class="ds-tool"><span class="sr-only">Download</span><select data-ds-download aria-label="Download"><option value="">Download</option><option value="page">PNG</option><option value="clear">PNG, see-through background</option><option value="pdf">PDF</option>${d.kind === 'flyer' ? '<option value="shop">PDF for a print shop (with bleed)</option>' : ''}</select></label>
        <label class="ds-tool"><span class="sr-only">Templates</span><select data-ds-templates aria-label="Templates"><option value="">Templates</option><option value="save">Save this as a template…</option>${(st.templates || []).length ? `<optgroup label="Use a template">${st.templates.map((x) => `<option value="use:${x.id}">${esc(x.name)}</option>`).join('')}</optgroup><optgroup label="Delete a template">${st.templates.map((x) => `<option value="del:${x.id}">${esc(x.name)}</option>`).join('')}</optgroup>` : ''}</select></label>
        ${shelfButtons()}`;
    }
    /** What came off and can go back on, and a QR code or logo this design could have. */
    function shelfButtons() {
      const r = st.design.removed || {};
      const names = { qr: 'QR code', logo: 'Logo', picture: 'Removed picture' };
      const layers = (r.layers || []).map((x) => `<button type="button" class="ds-btn" data-ds-putback="${esc(x.id)}">+ ${names[x.kind]}</button>`);
      if (r.photo) layers.push('<button type="button" class="ds-btn" data-ds-putback="photo">+ Main picture</button>');
      return layers.join('');
    }
    function paint() {
      if (!st.design) return;
      if (st.cropping && !(st.selected === 'photo' ? st.design.photo : selectedLayer()?.kind === 'picture')) st.cropping = false;
      sizePage();
      paintPage();
      paintTools();
      paintUndo();
      paintThumbs();
      paintSides();
      const pick = q('[data-ds-pick]');
      if (pick) pick.setAttribute('aria-pressed', String(st.picking));
    }

    // ── Dragging ─────────────────────────────────────────────────────────────
    let drag = null;
    page.addEventListener('pointerdown', (e) => {
      if (st.editing || !st.design) return;
      // Finish what is being typed in the tools first: repainting them would lose its change event.
      const active = document.activeElement;
      if (active && active !== page && q('[data-ds-tools]')?.contains(active)) active.blur();
      const handle = e.target.closest('.ds-handle');
      const part = e.target.closest('[data-ds-id]');
      if (st.picking) return;
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      const startPress = (next) => { drag = { sx: e.clientX, sy: e.clientY, moved: false, ...next }; page.setPointerCapture(e.pointerId); e.preventDefault(); };
      const items = (ids) => ids.map(layerById).filter(Boolean).map((t) => ({ t, x: t.x, y: t.y, w: t.w, h: t.h, size: t.fontSizePct }));
      if (handle && handle.dataset.h === 'group') { startPress({ mode: 'group-scale', items: items(st.multi), box: boxOf(st.multi) }); return; }
      // The bare page, or a held Shift over the background: draw a box round what to select.
      if (!part || (additive && part.dataset.dsId === 'photo')) {
        if (!additive && (st.selected || st.multi.length)) { st.selected = null; st.multi = []; st.cropping = false; paint(); }
        startPress({ mode: 'marquee', adding: additive ? selectedIds() : [] });
        return;
      }
      const id = part.dataset.dsId;
      if (additive) {
        const ids = groupOf(layerById(id));
        const now = selectedIds();
        const on = ids.every((x) => now.includes(x));
        st.cropping = false;
        st.selected = null;
        setMulti(on ? now.filter((x) => !ids.includes(x)) : [...now, ...ids]);
        paint();
        e.preventDefault();
        return;
      }
      // Pressing what is already one of several: drag them together. A click with no drag narrows it to that one.
      if (st.multi.includes(id)) {
        startPress({ mode: 'group-move', clicked: id, items: items(st.multi), box: boxOf(st.multi), snap: null });
        return;
      }
      const layer = id === 'photo' ? null : layerById(id);
      const wasSelected = st.selected === id;
      // A group selects whole, unless a part of it is already selected: then the other parts are one click away too.
      if (!wasSelected && layer?.group && selectedLayer()?.group !== layer.group) {
        st.selected = null;
        st.cropping = false;
        setMulti(groupOf(layer));
        if (st.multi.length) {
          paint();
          startPress({ mode: 'group-move', clicked: null, items: items(st.multi), box: boxOf(st.multi), snap: null });
          return;
        }
      }
      if (st.multi.length || !wasSelected) { st.multi = []; st.selected = id; st.cropping = false; paint(); }
      const target = id === 'photo' ? st.design.photo : layer;
      if (!target) return;
      startPress({ id, target, wasSelected, mode: st.cropping ? 'pan' : handle ? handle.dataset.h : 'move', x: target.x, y: target.y, w: target.w, h: target.h, size: target.fontSizePct, crop: target.crop ? { ...target.crop } : { zoom: 1, x: 0.5, y: 0.5 } });
    });
    page.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = (e.clientX - drag.sx) / st.pageW;
      const dy = (e.clientY - drag.sy) / st.pageH;
      if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 3) return;
      if (!drag.moved) {
        drag.moved = true;
        if (drag.mode !== 'marquee') remember();
        if (drag.mode === 'move') drag.snap = snapTargets(drag.id);
        if (drag.mode === 'group-move') drag.snap = snapTargets(drag.items.map((i) => i.t.id));
      }
      if (drag.mode === 'marquee') { paintMarquee(e); return; }
      if (drag.mode === 'group-move') {
        const box = { x: drag.box.x + dx, y: drag.box.y + dy };
        let sx = null; let sy = null;
        if (!(e.altKey || e.metaKey || e.ctrlKey)) {
          sx = nearestSnap(box.x, drag.box.w, drag.snap.xs, SNAP_PX / st.pageW);
          sy = nearestSnap(box.y, drag.box.h, drag.snap.ys, SNAP_PX / st.pageH);
        }
        showGuides(sx ? sx.line : null, sy ? sy.line : null);
        drag.items.forEach((i) => {
          i.t.x = i.x + dx + (sx ? sx.shift : 0);
          i.t.y = i.y + dy + (sy ? sy.shift : 0);
          paintLayerEl(i.t);
        });
        paintGroupBox();
        return;
      }
      if (drag.mode === 'group-scale') {
        const s = clamp((drag.box.w + dx) / drag.box.w, 0.1, 6);
        drag.items.forEach((i) => {
          i.t.x = drag.box.x + (i.x - drag.box.x) * s;
          i.t.y = drag.box.y + (i.y - drag.box.y) * s;
          i.t.w = i.w * s;
          if (i.h != null) i.t.h = i.h * s;
          if (i.size != null) i.t.fontSizePct = clamp(i.size * s, 0.006, 0.3);
          paintLayerEl(i.t);
        });
        paintGroupBox();
        return;
      }
      const t = drag.target;
      if (drag.mode === 'pan') { panCrop(t, e.clientX - drag.sx, e.clientY - drag.sy); return; }
      if (drag.mode === 'move') {
        t.x = clamp(drag.x + dx, -0.5, 1.2);
        t.y = clamp(drag.y + dy, -0.5, 1.2);
        // Alt or Cmd moves it freely, as in most design tools.
        if (e.altKey || e.metaKey || e.ctrlKey) showGuides(null, null); else applySnap(t, drag);
      } else if (drag.mode === 'e') t.w = clamp(drag.w + dx, drag.h != null ? 0.002 : 0.05, 1.5);
      else if (drag.mode === 's') t.h = clamp(drag.h + dy, 0.002, 1.5);
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
    function paintMarquee(e) {
      const box = page.getBoundingClientRect();
      let el = page.querySelector('.ds-marquee');
      if (!el) { el = document.createElement('div'); el.className = 'ds-marquee'; page.appendChild(el); }
      const x1 = clamp(drag.sx - box.left, 0, box.width); const x2 = clamp(e.clientX - box.left, 0, box.width);
      const y1 = clamp(drag.sy - box.top, 0, box.height); const y2 = clamp(e.clientY - box.top, 0, box.height);
      el.style.cssText = `left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${Math.abs(x2 - x1)}px;height:${Math.abs(y2 - y1)}px;`;
    }
    /** Everything the box touches, and the rest of any group it touches. */
    function endMarquee(adding) {
      const el = page.querySelector('.ds-marquee');
      if (!el) return;
      const m = el.getBoundingClientRect();
      el.remove();
      const hit = [];
      page.querySelectorAll('.ds-layer[data-ds-id]').forEach((part) => {
        const r = part.getBoundingClientRect();
        if (r.left < m.right && r.right > m.left && r.top < m.bottom && r.bottom > m.top) hit.push(...groupOf(layerById(part.dataset.dsId)));
      });
      st.selected = null;
      setMulti([...adding, ...hit]);
      paint();
    }
    function endDrag(e) {
      if (!drag) return;
      const d = drag;
      drag = null;
      showGuides(null, null);
      if (d.mode === 'marquee') { if (d.moved) endMarquee(d.adding); return; }
      if (d.moved) { paintTools(); scheduleSave(); return; }
      if (e && e.type !== 'pointerup') return;
      // A click with no drag. On one of several: that one alone. On words already selected: type in them.
      if (d.mode === 'group-move') {
        if (d.clicked) { st.multi = []; st.selected = d.clicked; paint(); }
        return;
      }
      if (d.mode === 'move' && d.wasSelected && d.target.kind === 'text') startEditing(d.id, e);
    }
    // ── Snapping: the page's edges and middle, and the edges and middle of everything else on it. ──
    function snapTargets(ownIds) {
      const own_ = [].concat(ownIds);
      const box = page.getBoundingClientRect();
      const xs = [0, 0.5, 1];
      const ys = [0, 0.5, 1];
      let own = { w: 0, h: 0 };
      page.querySelectorAll('[data-ds-id]').forEach((el) => {
        const r = el.getBoundingClientRect();
        const f = { x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height };
        if (own_.includes(el.dataset.dsId)) { own = f; return; }
        xs.push(f.x, f.x + f.w / 2, f.x + f.w);
        ys.push(f.y, f.y + f.h / 2, f.y + f.h);
      });
      return { xs, ys, w: own.w, h: own.h };
    }
    /** The nearest line within reach, as how far to move and which line it was. */
    function nearestSnap(start, size, lines, reach) {
      let best = null;
      [start, start + size / 2, start + size].forEach((edge) => lines.forEach((line) => {
        const shift = line - edge;
        if (Math.abs(shift) <= reach && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, line };
      }));
      return best;
    }
    function applySnap(t, d) {
      if (!d.snap) return;
      const sx = nearestSnap(t.x, d.snap.w, d.snap.xs, SNAP_PX / st.pageW);
      const sy = nearestSnap(t.y, d.snap.h, d.snap.ys, SNAP_PX / st.pageH);
      if (sx) t.x += sx.shift;
      if (sy) t.y += sy.shift;
      showGuides(sx ? sx.line : null, sy ? sy.line : null);
    }
    function showGuides(x, y) {
      [['x', x], ['y', y]].forEach(([axis, at]) => {
        let g = page.querySelector(`.ds-guide[data-axis="${axis}"]`);
        if (at == null) { if (g) g.remove(); return; }
        if (!g) { g = document.createElement('div'); g.className = 'ds-guide'; g.dataset.axis = axis; page.appendChild(g); }
        g.style[axis === 'x' ? 'left' : 'top'] = `${at * 100}%`;
      });
    }
    /** Dragging a picture inside its frame, by how far the pointer moved. A picture that only just covers one way cannot move that way. */
    function panCrop(t, px, py) {
      const el = page.querySelector(`[data-ds-id="${CSS.escape(drag.id)}"]`);
      const img = el && el.querySelector('img');
      if (!img || !img.naturalWidth) return;
      const bw = el.clientWidth;
      const bh = el.clientHeight;
      const scale = Math.max(bw / img.naturalWidth, bh / img.naturalHeight) * drag.crop.zoom;
      const spareX = bw - img.naturalWidth * scale;
      const spareY = bh - img.naturalHeight * scale;
      t.crop = {
        zoom: drag.crop.zoom,
        x: spareX < -0.5 ? clamp(drag.crop.x + px / spareX, 0, 1) : drag.crop.x,
        y: spareY < -0.5 ? clamp(drag.crop.y + py / spareY, 0, 1) : drag.crop.y,
      };
      img.setAttribute('style', cropStyle(t.crop));
    }
    page.addEventListener('pointerup', endDrag);
    page.addEventListener('pointercancel', endDrag);

    // Double-click: type on the design itself.
    page.addEventListener('dblclick', (e) => {
      if (st.editing || st.picking) return;
      // Not e.target: the press captured the pointer for a drag, so this event is aimed at the page, not the words.
      const part = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-ds-page] [data-kind="text"]');
      if (part) startEditing(part.dataset.dsId, e);
    });
    /**
     * Type in the words where they are on the design (owner 2026-11-06). `at` is the click that started it, to put the
     * caret where it landed; 'all' selects the words, ready to be typed over.
     */
    function startEditing(id, at) {
      const l = st.design.layers.find((x) => x.id === id);
      if (!l || l.kind !== 'text') return;
      if (st.selected !== id || st.multi.length) { st.multi = []; st.selected = id; paint(); }
      const part = page.querySelector(`[data-ds-id="${CSS.escape(id)}"]`);
      if (!part) return;
      st.editing = l.id;
      part.querySelectorAll('.ds-handle').forEach((h) => h.remove());
      part.classList.add('ds-editing');
      part.textContent = l.text;
      part.contentEditable = 'plaintext-only';
      part.focus();
      const caret = document.createRange();
      caret.selectNodeContents(part);
      if (at !== 'all') {
        const spot = at && document.caretRangeFromPoint ? document.caretRangeFromPoint(at.clientX, at.clientY) : null;
        if (spot && part.contains(spot.startContainer)) { caret.setStart(spot.startContainer, spot.startOffset); caret.collapse(true); } else caret.collapse(false);
      }
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(caret);
      const finish = () => {
        part.removeEventListener('blur', finish);
        const next = part.innerText.replace(/\n$/, '');
        st.editing = null;
        if (next !== l.text) { remember(); l.text = next; scheduleSave(); }
        // The page only: a click that ended the typing may be on a tool, and repainting the tools would swallow it.
        paintPage();
      };
      part.addEventListener('blur', finish);
      part.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); part.blur(); } });
    }

    // ── The tools ────────────────────────────────────────────────────────────
    function change(fn) { remember(); fn(); paint(); scheduleSave(); }
    host.addEventListener('input', (e) => {
      const t = e.target;
      const l = selectedLayer();
      // Live, on the page, while a colour or slider moves: remembered once, when it starts.
      if (t.matches('[data-ds-boxop],[data-ds-photoop],[data-ds-picop],[data-ds-crop-zoom],[data-ds-shapeop],[data-ds-color],[data-ds-box],[data-ds-page-color],[data-ds-page-op],[data-ds-shape]')) {
        if (!st.liveChange) { remember(); st.liveChange = true; }
        const op = 1 - Number(t.value) / 100;
        // Moving the slider or choosing a colour is asking for a background: it never sits there greyed out.
        if (t.matches('[data-ds-boxop]') && l) { l.boxOpacity = op; if (!l.boxFill) l.boxFill = contrastFor(l.color); }
        else if (t.matches('[data-ds-photoop]') && st.design.photo) st.design.photo.opacity = op;
        else if (t.matches('[data-ds-picop],[data-ds-shapeop]') && l) l.opacity = op;
        else if (t.matches('[data-ds-crop-zoom]')) {
          const target = st.selected === 'photo' ? st.design.photo : l;
          if (target) target.crop = { x: 0.5, y: 0.5, ...(target.crop || {}), zoom: clamp(Number(t.value) / 100, 1, MAX_ZOOM) };
        }
        else if (t.matches('[data-ds-color]') && l) l.color = t.value;
        else if (t.matches('[data-ds-box]') && l) l.boxFill = t.value;
        else if (t.matches('[data-ds-page-color]')) st.design.pageColor = t.value;
        else if (t.matches('[data-ds-page-op]')) st.design.pageOpacity = op;
        else if (t.matches('[data-ds-shape]') && l) l.color = t.value;
        paintPage();
        scheduleSave();
      }
    });
    host.addEventListener('change', (e) => {
      const t = e.target;
      st.liveChange = false;
      const l = selectedLayer();
      if (t.matches('[data-ds-order]') && t.value && selectedIds().length) {
        const order = t.value;
        const ids = selectedIds();
        change(() => { reorder(ids, order); });
      } else if (t.matches('[data-ds-resize]') && t.value) {
        resizeCopy(t.value, t);
      } else if (t.matches('[data-ds-templates]') && t.value) {
        templateChoice(t.value);
        t.value = '';
      } else if (t.matches('[data-ds-download]') && t.value) {
        downloadFile(t.value, t);
      } else if (t.matches('[data-ds-add-shape]') && t.value) {
        const shape = t.value;
        const across = ratio();
        change(() => {
          const id = `s${Date.now().toString(36)}`;
          const size = shape === 'line' ? { x: 0.2, y: 0.5, w: 0.6, h: 0.006 } : shape === 'circle' ? { x: 0.35, y: 0.5 - 0.15 * across, w: 0.3, h: 0.3 * across } : { x: 0.3, y: 0.4, w: 0.4, h: 0.2 };
          st.design.layers.push({ id, kind: 'shape', role: shape === 'line' ? 'line' : shape === 'circle' ? 'circle' : 'shape', ...size, color: contrastFor(st.design.pageColor) === '#ffffff' ? '#ffffff' : '#1f1e1b', round: shape === 'circle', opacity: 1 });
          st.selected = id;
        });
      } else if (t.matches('[data-ds-lh]') && l) change(() => { l.lineHeight = clamp(Number(t.value) || LINE_HEIGHT, 0.8, 3); });
      else if (t.matches('[data-ds-size]') && l) change(() => { l.fontSizePct = clamp(Number(t.value) / 2 / 100, 0.006, 0.3); });
      else if (t.matches('[data-ds-align]') && l) change(() => { l.align = t.value; });
      // A box in the page's own colour would be invisible: it starts behind the words in their opposite.
      else if (t.matches('[data-ds-boxon]') && l) change(() => { l.boxFill = t.checked ? contrastFor(l.color) : null; l.boxOpacity = 1; });
      else if (t.matches('[data-ds-box],[data-ds-boxop]') && l) paintTools();   // the tick follows
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
      // The button, not just the attribute: in full screen the layout around this editor carries data-ds-full too.
      if (t('button[data-ds-full]')) { setFull(!st.full); return; }
      if (t('[data-ds-ask]')) { refer(st.selected); return; }
      if (t('[data-ds-bold]')) { const l = selectedLayer(); if (l) change(() => { l.bold = !l.bold; }); return; }
      if (t('[data-ds-italic]')) { const l = selectedLayer(); if (l) change(() => { l.italic = !l.italic; }); return; }
      if (t('[data-ds-underline]')) { const l = selectedLayer(); if (l) change(() => { l.underline = !l.underline; }); return; }
      if (t('[data-ds-crop]')) { st.cropping = true; paint(); return; }
      if (t('[data-ds-crop-done]')) { st.cropping = false; paint(); return; }
      if (t('[data-ds-crop-reset]')) {
        const target = st.selected === 'photo' ? st.design.photo : selectedLayer();
        if (target) change(() => { delete target.crop; });
        return;
      }
      if (t('[data-ds-duplicate]')) { duplicateSelected(); return; }
      const sideBtn = t('[data-ds-side]');
      if (sideBtn) { showSide(sideBtn.dataset.dsSide); return; }
      if (t('[data-ds-add-back]')) { await addBack(); return; }
      if (t('[data-ds-remove-back]')) { removeBack(); return; }
      if (t('[data-ds-cutout]')) { removeBackground(t('[data-ds-cutout]')); return; }
      if (t('[data-ds-group]')) { groupSelected(); return; }
      if (t('[data-ds-ungroup]')) { ungroupSelected(); return; }
      if (t('[data-ds-bg]')) { setAsBackground(); return; }
      if (t('[data-ds-unbg]')) { detachBackground(); return; }
      if (t('[data-ds-add-picture]')) { pickPicture((asset) => pictureFromLibrary({ addPicture: asset.id }), 'Add a picture'); return; }
      if (t('[data-ds-replace]')) { const target = st.selected; pickPicture((asset) => pictureFromLibrary({ replacePicture: { assetId: asset.id, target } }), 'Replace this picture'); return; }
      const back = t('[data-ds-putback]');
      if (back) { putBack(back.dataset.dsPutback); return; }
      if (t('[data-ds-add]')) {
        change(() => {
          const id = `t${Date.now().toString(36)}`;
          st.design.layers.push({ id, kind: 'text', role: 'text', text: 'Your words', x: 0.1, y: 0.45, w: 0.8, fontFamily: null, fontSizePct: 0.04, bold: true, align: 'center', color: contrastFor(pageFill(st.design)) === '#ffffff' ? '#ffffff' : '#1f1e1b', boxFill: null, boxOpacity: 1 });
          st.selected = id;
        });
        startEditing(st.selected, 'all');
        return;
      }
      if (t('[data-ds-delete]')) {
        change(() => {
          const shelf = st.design.removed || (st.design.removed = { layers: [], photo: null });
          if (st.selected === 'photo') { shelf.photo = st.design.photo; st.design.photo = null; }
          else {
            const ids = selectedIds();
            ids.map(layerById).forEach((gone) => { if (gone && ['qr', 'logo', 'picture'].includes(gone.kind)) shelf.layers.push(gone); });
            st.design.layers = st.design.layers.filter((l) => !ids.includes(l.id));
          }
          st.selected = null;
          st.multi = [];
        });
        return;
      }
      if (t('[data-ds-photo-next]')) { await nextPhoto(); return; }
      const thumb = t('[data-ds-thumb]');
      if (thumb) { await openOption(Number(thumb.dataset.dsThumb)); return; }
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
    const pictureCount = () => st.design.layers.filter((l) => l.kind === 'picture').length;
    /** The picture fills the page behind everything; what was the background goes on the shelf, to put back. */
    function setAsBackground() {
      const l = selectedLayer();
      if (!l || l.kind !== 'picture') return;
      change(() => {
        const old = st.design.photo;
        if (old) {
          const oldId = old.id || 'photo0';
          st.pictureUrls[oldId] = st.pictureUrls[oldId] || st.photoUrl;
          const shelf = st.design.removed || (st.design.removed = { layers: [], photo: null });
          shelf.layers.push({ id: oldId, kind: 'picture', role: 'picture', x: old.x, y: old.y, w: old.w, h: old.h, opacity: old.opacity, ref: old.ref, ...(old.crop ? { crop: old.crop } : {}) });
        }
        st.design.photo = { id: l.id, x: 0, y: 0, w: 1, h: 1, opacity: l.opacity, ref: l.ref };
        st.design.layers = st.design.layers.filter((x) => x !== l);
        st.selected = 'photo';
      });
    }
    /** The background as an ordinary picture, at the back to start with, which can then be moved and put in front. */
    function detachBackground() {
      const p = st.design.photo;
      if (!p) return;
      if (pictureCount() >= MAX_PICTURES) { showError(`A design can hold ${MAX_PICTURES} added pictures. Remove one to do this.`); return; }
      change(() => {
        const id = p.id || 'photo0';
        st.pictureUrls[id] = st.pictureUrls[id] || st.photoUrl;
        st.design.layers.unshift({ id, kind: 'picture', role: 'picture', x: p.x, y: p.y, w: p.w, h: p.h, opacity: p.opacity, ref: p.ref, ...(p.crop ? { crop: p.crop } : {}) });
        st.design.photo = null;
        st.selected = id;
      });
    }
    // ── Templates ────────────────────────────────────────────────────────────
    async function loadTemplates() {
      try {
        const r = await o.post({ action: 'list_design_templates' });
        st.templates = Array.isArray(r.templates) ? r.templates : [];
        if (st.design && !selectedLayer() && st.selected !== 'photo' && !st.multi.length) paintTools();
      } catch { st.templates = []; }
    }
    async function templateChoice(choice) {
      clearTimeout(st.saveTimer);
      st.saveTimer = null;
      try {
        if (choice === 'save') {
          const typed = await window.promptModal('Any design in your workspace can start from it. Using the same name again replaces that template.', { title: 'Save as a template', confirmLabel: 'Save template', placeholder: 'Summer events', required: true });
          const name = (typed || '').trim();
          if (!name) return;
          showSaved('Saving…');
          const r = await o.post({ action: 'save_template', optionId: st.optionId, design: wire(), name });
          st.templates = r.templates || st.templates;
          showSaved(`Saved as the template “${name}”`);
          showError('');
          paintTools();
          return;
        }
        const id = Number(choice.split(':')[1]);
        if (choice.startsWith('del:')) {
          const gone = (st.templates || []).find((t) => t.id === id);
          const sure = await window.confirmModal(`Delete the template “${esc(gone ? gone.name : '')}”? Designs already made from it stay as they are.`, { title: 'Delete this template?', confirmLabel: 'Delete template' });
          if (!sure) return;
          const r = await o.post({ action: 'delete_design_template', templateId: id });
          st.templates = r.templates || st.templates.filter((x) => x.id !== id);
          showSaved('Template deleted');
          paintTools();
          return;
        }
        showSaved('Using the template…');
        const before = JSON.stringify(st.design);
        const r = await holdingStill(() => o.post({ action: 'use_template', optionId: st.optionId, design: wire(), templateId: id }));
        st.undo.push(before);
        st.redo = [];
        st.selected = null;
        st.multi = [];
        adopt(r);
        showSaved('Template on the page. Undo takes it back.');
        showError('');
        paint();
      } catch (err) {
        showSaved('');
        showError(err.message || 'That could not be done. Please try again.');
      }
    }
    /** The server takes the background out and keeps the old picture to come back to, so Undo works as ever. */
    async function removeBackground(btn) {
      const target = st.selected;
      btn.disabled = true;
      btn.textContent = 'Removing…';
      clearTimeout(st.saveTimer);
      st.saveTimer = null;
      showSaved('Removing the background…');
      try {
        const before = JSON.stringify(st.design);
        const r = await holdingStill(() => o.post({ action: 'remove_background', optionId: st.optionId, design: wire(), ...sideParam(), target }));
        st.undo.push(before);
        st.redo = [];
        adopt(r);
        if (r.addedId && target !== 'photo') st.selected = r.addedId;
        showSaved('Saved');
        showError('');
        paint();
      } catch (err) {
        showSaved('');
        showError(err.message || 'The background could not be removed. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Remove background (1 task)';
      }
    }
    async function downloadFile(choice, select) {
      const isPdf = choice === 'pdf' || choice === 'shop';
      select.disabled = true;
      clearTimeout(st.saveTimer);
      st.saveTimer = null;
      showSaved(`Getting your ${isPdf ? 'PDF' : 'PNG'} ready…`);
      try {
        const r = await o.post(isPdf
          ? { action: 'download_pdf', optionId: st.optionId, design: wire(), printShop: choice === 'shop', title: o.brief.title }
          : { action: 'download_png', optionId: st.optionId, design: wire(), ...sideParam(), seeThrough: choice === 'clear' });
        const a = document.createElement('a');
        a.href = r.url;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        showSaved('Saved');
        showError('');
      } catch (err) {
        showSaved('');
        showError(err.message || 'That file could not be made. Please try again.');
      }
      select.disabled = false;
      select.value = '';
    }
    /** A copy at another size, as a new option: the server makes it, so what is on screen is saved first. */
    async function resizeCopy(size, select) {
      select.disabled = true;
      clearTimeout(st.saveTimer);
      st.saveTimer = null;
      showSaved('Making a copy…');
      try {
        const r = await o.post({ action: 'resize_design', optionId: st.optionId, design: wire(), size });
        await o.onOptionsChanged?.();
        if (destroyed) return;
        await openOption(r.optionId);
        showSaved('Your copy is open. The original is still there, below.');
      } catch (err) {
        showSaved('');
        showError(err.message || 'The copy could not be made. Please try again.');
        select.disabled = false;
        select.value = '';
      }
    }
    function duplicateSelected() {
      if (st.multi.length) { duplicateSeveral(); return; }
      const isPhoto = st.selected === 'photo';
      const from = isPhoto ? st.design.photo : selectedLayer();
      if (!from) return;
      if ((isPhoto || from.kind === 'picture') && pictureCount() >= MAX_PICTURES) { showError(`A design can hold ${MAX_PICTURES} added pictures. Remove one to add another.`); return; }
      change(() => {
        const id = `c${Date.now().toString(36)}`;
        const copy = isPhoto
          ? { id, kind: 'picture', role: 'picture', x: from.x, y: from.y, w: from.w, h: from.h, opacity: from.opacity, ...(from.crop ? { crop: { ...from.crop } } : {}), copyOf: 'photo' }
          : { ...JSON.parse(JSON.stringify(from)), id, ...(['qr', 'logo', 'picture'].includes(from.kind) ? { copyOf: from.id } : {}) };
        copy.x += 0.03;
        copy.y += 0.03;
        if (copy.kind === 'picture') st.pictureUrls[id] = isPhoto ? st.photoUrl : st.pictureUrls[from.id];
        // Straight above what it copies; the main picture's copy goes behind everything else on the page.
        const at = isPhoto ? 0 : st.design.layers.indexOf(from) + 1;
        st.design.layers.splice(at, 0, copy);
        st.selected = id;
      });
    }
    function duplicateSeveral() {
      const from = st.multi.map(layerById).filter(Boolean);
      if (pictureCount() + from.filter((l) => l.kind === 'picture').length > MAX_PICTURES) { showError(`A design can hold ${MAX_PICTURES} added pictures. Remove one to add another.`); return; }
      change(() => {
        const stamp = Date.now().toString(36);
        const group = from[0].group && from.every((l) => l.group === from[0].group) ? `g${stamp}` : null;
        const copies = from.map((l, i) => {
          const id = `c${stamp}${i}`;
          const { group: _old, ...rest } = JSON.parse(JSON.stringify(l));
          if (l.kind === 'picture') st.pictureUrls[id] = st.pictureUrls[l.id];
          return { ...rest, id, x: l.x + 0.03, y: l.y + 0.03, ...(group ? { group } : {}), ...(['qr', 'logo', 'picture'].includes(l.kind) ? { copyOf: l.id } : {}) };
        });
        st.design.layers.push(...copies);
        st.multi = copies.map((c) => c.id);
      });
    }
    function putBack(id) {
      const shelf = st.design.removed;
      if (!shelf) return;
      if (id !== 'photo') {
        const item = shelf.layers.find((x) => x.id === id);
        if (item && item.kind === 'picture' && pictureCount() >= MAX_PICTURES) { showError(`A design can hold ${MAX_PICTURES} added pictures. Remove one to put this back.`); return; }
      }
      change(() => {
        if (id === 'photo') { st.design.photo = shelf.photo; shelf.photo = null; st.selected = 'photo'; return; }
        const at = shelf.layers.findIndex((x) => x.id === id);
        if (at < 0) return;
        st.design.layers.push(shelf.layers.splice(at, 1)[0]);
        st.selected = id;
      });
    }
    /** Every way a picture reaches this workspace: upload, library, stock or AI, each with its own cost and checks. */
    function pickPicture(onPick, title, shows) {
      if (!canPick()) return;
      window.MediaPicker.open({ title, onPick, topic: shows || o.brief.title, findNow: !!shows, assistantName: o.assistantName });
    }
    /**
     * The chat's "Choose a picture". The card can only guess which picture is meant when nothing was selected, so a name
     * that is not on the design falls back to what is selected, then the main picture, then an only picture, then adding one.
     */
    function findPictureNow(target, shows) {
      const isPicture = (id) => (id === 'photo' ? !!st.design.photo : st.design.layers.some((l) => l.id === id && l.kind === 'picture'));
      const pictures = st.design.layers.filter((l) => l.kind === 'picture');
      const aim = target === 'new' ? null
        : isPicture(target) ? target
          : isPicture(st.selected) ? st.selected
            : st.design.photo ? 'photo'
              : pictures.length === 1 ? pictures[0].id : null;
      if (!aim && pictures.length >= MAX_PICTURES) { showError(`A design can hold ${MAX_PICTURES} added pictures. Remove one to add another.`); return; }
      pickPicture(
        (asset) => pictureFromLibrary(aim ? { replacePicture: { assetId: asset.id, target: aim } } : { addPicture: asset.id }),
        aim ? 'Replace this picture' : 'Add a picture',
        shows,
      );
    }
    /** The server adds it, as only the server may name a file, so this also saves what is on screen first. */
    async function pictureFromLibrary(request) {
      clearTimeout(st.saveTimer);
      st.saveTimer = null;
      showSaved('Saving…');
      try {
        const before = JSON.stringify(st.design);
        const r = await holdingStill(() => o.post({ action: 'save_design', optionId: st.optionId, design: wire(), ...sideParam(), ...request }));
        st.undo.push(before);
        st.redo = [];
        adopt(r);
        if (r.addedId) st.selected = r.addedId;
        showSaved('Saved');
        showError('');
        paint();
      } catch (err) { showSaved(''); showError(err.message || 'That picture could not be added. Please try again.'); }
    }
    /** What the server sent, which is always the right way round, on the side that was open. */
    function adopt(r, opening) {
      const stayOnBack = !opening && onBackSide();
      st.design = r.design;
      if (stayOnBack && st.design.back) st.design = flipped(st.design);
      if (r.photoUrl !== undefined) st.photoUrl = r.photoUrl;
      if (r.photoUrl && r.design.photo) st.pictureUrls[r.design.photo.id || 'photo0'] = r.photoUrl;
      if (r.pictureUrls) Object.assign(st.pictureUrls, r.pictureUrls);
    }
    async function nextPhoto() {
      const others = o.options().filter((x) => x.id !== st.optionId && x.hasPhoto);
      if (!others.length) return;
      st.photoAt = ((st.photoAt || 0) + 1) % others.length;
      try {
        remember();
        const r = await holdingStill(() => o.post({ action: 'save_design', optionId: st.optionId, design: wire(), usePhotoFromOption: others[st.photoAt].id }));
        adopt(r);
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
      st.multi = [];
      st.cropping = false;
      st.pictureUrls = {};
      st.undo = [];
      st.redo = [];
      showSaved('Opening…');
      try {
        const r = await o.post({ action: 'open_design', optionId });
        if (destroyed) return;
        adopt(r, true);
        showSaved('');
        showError('');
        paint();
      } catch (err) { showSaved(''); showError(err.message); }
      st.loading = false;
      const waiting = st.pendingFind;
      st.pendingFind = null;
      if (waiting && st.design && !destroyed) findPictureNow(waiting.target, waiting.shows);
    }
    /**
     * Save, then leave. A failed save stays here with the error, because leaving would lose the changes since the last
     * autosave and the error with them. A second press leaves anyway, or a design that can no longer be saved (say it
     * was approved from the chat) would have no way out.
     */
    async function close() {
      if (st.leaving) return;
      st.leaving = true;
      try {
        if (!st.leaveUnsaved) {
          try {
            await saveNow(true);
            st.leaveUnsaved = false;
          } catch (err) {
            st.leaveUnsaved = true;
            showError(`${err.message || 'That could not be saved.'} Your latest changes are still here. Press again to leave without them.`);
            return;
          }
        }
        setFull(false);
        o.onClose();
      } finally {
        st.leaving = false;
      }
    }

    function onKey(e) {
      if (destroyed || st.editing || st.busy) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if (e.key === 'Escape') {
        if (typing) return;
        if (st.picking) { st.picking = false; paint(); return; }
        if (st.cropping) { st.cropping = false; paint(); return; }
        if (st.full) { setFull(false); return; }
        if (st.selected || st.multi.length) { st.selected = null; st.multi = []; paint(); }
        return;
      }
      if (typing || !host.contains(e.target) && e.target !== document.body) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) restore(st.redo, st.undo); else restore(st.undo, st.redo); return; }
      if (st.multi.length || selectedLayer()) {
        if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); if (e.shiftKey) ungroupSelected(); else groupSelected(); return; }
      }
      if (st.multi.length) {
        if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSeveral(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); q('[data-ds-delete]')?.click(); return; }
        const shift = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (shift) {
          e.preventDefault();
          remember();
          const step = e.shiftKey ? 0.02 : 0.004;
          st.multi.map(layerById).forEach((l) => { if (l) { l.x += shift[0] * step; l.y += shift[1] * step; } });
          paintPage();
          scheduleSave();
        }
        return;
      }
      const target = st.selected === 'photo' ? st.design?.photo : selectedLayer();
      if (!target) return;
      // Enter on selected words starts typing in them, as a second click does.
      if (e.key === 'Enter' && target.kind === 'text') { e.preventDefault(); startEditing(target.id, null); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
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
    // Never under a drag or typing: a repaint replaces what is being held (see the memory note on drags).
    const onResize = () => { if (st.design && !st.editing && !drag) { sizePage(); paintPage(); } };
    window.addEventListener('resize', onResize);
    // Width only, on the next frame: sizing the page from inside the callback changes what is observed, and the
    // browser then raises "ResizeObserver loop completed", which the page shows as "Something went wrong"
    // (owner 2026-11-05, adding words). Same rule as the post editor's stage in workspace.html.
    let roWidth = 0;
    const ro = window.ResizeObserver ? new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (!w || w === roWidth) return;
      roWidth = w;
      requestAnimationFrame(onResize);
    }) : null;
    if (ro) ro.observe(q('[data-ds-wrap]'));

    openOption(o.optionId);
    loadTemplates();

    return {
      get optionId() { return st.optionId; },
      /** The chat's "Choose a picture", waiting for the design if it has only just been opened. */
      findPicture(target, shows) {
        if (st.loading || !st.design) { st.pendingFind = { target, shows }; return; }
        findPictureNow(target, shows);
      },
      /** A change saved from the chat's card: shown here, and Undo goes back past it. */
      setDesign(optionId, design, photoUrl) {
        if (optionId !== st.optionId) return;
        clearTimeout(st.saveTimer);
        st.saveTimer = null;
        remember();
        const stayOnBack = onBackSide();
        st.design = stayOnBack && design.back ? flipped(design) : design;
        if (photoUrl !== undefined) st.photoUrl = photoUrl;
        if (photoUrl && design.photo) st.pictureUrls[design.photo.id || 'photo0'] = photoUrl;
        if (st.selected && st.selected !== 'photo' && !selectedLayer()) st.selected = null;
        setMulti(st.multi);
        paint();
        scheduleSave();
        // The chat can duplicate or put back a picture: the signed address to show it comes from the server.
        const unseen = [...design.layers, ...(design.back ? design.back.layers : [])].some((l) => l.kind === 'picture' && !st.pictureUrls[l.id]);
        if (unseen) {
          o.post({ action: 'open_design', optionId }).then((r) => {
            if (destroyed || optionId !== st.optionId) return;
            Object.assign(st.pictureUrls, r.pictureUrls || {});
            paintPage();
          }).catch(() => {});
        }
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
