/**
 * src/components/image-overlay-editor.js
 *
 * Text-overlay editor + baker for post images.
 *
 *   window.ImageOverlayEditor.open({ imageUrl, overlays, onDone })
 *     Opens a full-screen editor over `imageUrl`. Lets the user add one or more draggable text
 *     overlays, style each (font, colour, size, box outline, box fill + transparency), add emoji,
 *     and delete them. Calls onDone(overlays[]) when the user saves, or onDone(null) on cancel.
 *
 *   window.ImageOverlayEditor.bake(imageUrl, overlays) → Promise<Blob>   // PNG
 *     Flattens the overlays into the image at its NATIVE resolution and returns a PNG blob.
 *
 * WYSIWYG guarantee: the on-screen preview (DOM) and the bake (canvas) use the SAME geometry —
 * positions are stored as 0..1 fractions of width/height, font size as a fraction of image height,
 * and box padding / border / line-height are the same ratios in both. So what the user drags is
 * exactly what gets published, at any resolution.
 *
 * An overlay:
 *   { id, text, x, y, fontFamily, fontSizePct, color, boxStroke|null, boxFill|null, boxOpacity }
 *   x, y         — centre of the text box, 0..1 of image width/height
 *   fontSizePct  — font size as a fraction of image height (0..1)
 *   boxStroke    — outline colour hex, or null for no outline
 *   boxFill      — background colour hex, or null for no background
 *   boxOpacity   — background alpha 0..1 (1 = solid). Slider shows transparency = 1 - opacity.
 */
(function () {
  'use strict';

  // ── Shared geometry (identical in preview and bake) ──────────────────────────
  const PAD_RATIO    = 0.30;  // box padding    = fontSize * PAD_RATIO
  const LINE_HEIGHT  = 1.25;  // line height    = fontSize * LINE_HEIGHT
  const BORDER_RATIO = 0.07;  // border width   = fontSize * BORDER_RATIO (min 1px)
  const RADIUS_RATIO = 0.15;  // corner radius  = fontSize * RADIUS_RATIO

  const FONTS = [
    'Arial', 'Helvetica', 'Verdana', 'Trebuchet MS', 'Georgia',
    'Times New Roman', 'Courier New', 'Impact', 'Comic Sans MS',
  ];
  const EMOJIS = ['😀','😍','🎉','🔥','✨','💯','👍','❤️','🙌','😎','🥳','💪','☕','🌟','📣','✅','👉','🎁','😂','🤩'];

  const DEFAULTS = {
    fontFamily: 'Arial',
    fontSizePct: 0.07,
    color: '#ffffff',
    boxStroke: null,
    boxFill: '#000000',
    boxOpacity: 0.5,
  };

  const uid = () => 'ov_' + Math.random().toString(36).slice(2, 9);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return `rgba(0,0,0,${alpha})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
  }

  // Split on explicit newlines only (no auto-wrap) so DOM and canvas agree line-for-line.
  const lines = (text) => String(text == null ? '' : text).split('\n');

  // ── Load an image, resolving with its natural dimensions ─────────────────────
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // Harmless for data: URLs (same-origin); lets a CORS-clean remote image bake too.
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image failed to load.'));
      img.src = src;
    });
  }

  // ── Roundrect helper (older Safari lacks ctx.roundRect) ──────────────────────
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ── Draw one overlay onto a canvas context at a given render scale ────────────
  // `H` is the reference height (natural for bake) used to turn fontSizePct into pixels.
  function drawOverlay(ctx, ov, W, H) {
    const fontSize = clamp(ov.fontSizePct || DEFAULTS.fontSizePct, 0.005, 0.5) * H;
    const pad    = fontSize * PAD_RATIO;
    const lh     = fontSize * LINE_HEIGHT;
    const border = Math.max(1, fontSize * BORDER_RATIO);
    const radius = fontSize * RADIUS_RATIO;
    const family = ov.fontFamily || DEFAULTS.fontFamily;

    ctx.font = `${fontSize}px ${family}`;
    ctx.textBaseline = 'top';

    const ls = lines(ov.text);
    let maxW = 0;
    for (const l of ls) maxW = Math.max(maxW, ctx.measureText(l || ' ').width);

    const boxW = maxW + pad * 2;
    const boxH = ls.length * lh + pad * 2;
    const cx = clamp(ov.x, 0, 1) * W;
    const cy = clamp(ov.y, 0, 1) * H;
    const x = cx - boxW / 2;
    const y = cy - boxH / 2;

    // Background fill (with transparency).
    if (ov.boxFill) {
      ctx.fillStyle = hexToRgba(ov.boxFill, ov.boxOpacity == null ? 1 : ov.boxOpacity);
      roundRectPath(ctx, x, y, boxW, boxH, radius);
      ctx.fill();
    }
    // Outline.
    if (ov.boxStroke) {
      ctx.lineWidth = border;
      ctx.strokeStyle = ov.boxStroke;
      roundRectPath(ctx, x, y, boxW, boxH, radius);
      ctx.stroke();
    }
    // Text.
    ctx.fillStyle = ov.color || DEFAULTS.color;
    for (let i = 0; i < ls.length; i++) {
      ctx.fillText(ls[i], x + pad, y + pad + i * lh);
    }
  }

  // ── Style a DOM node as an overlay, sized against a reference height (px) ─────
  // Shared by the interactive editor preview and the read-only canvas renderer, so a text box
  // looks the same wherever it is drawn — and the same as the bake, which uses the ratios above.
  // Defaults are applied defensively here because the read-only renderer receives raw stored
  // overlays that were never merged with DEFAULTS (the editor's state always is).
  function styleOverlayNode(node, ov, refHeightPx) {
    const fontSize = clamp(ov.fontSizePct == null ? DEFAULTS.fontSizePct : ov.fontSizePct, 0.005, 0.5) * refHeightPx;
    node.style.left = (clamp(ov.x, 0, 1) * 100) + '%';
    node.style.top = (clamp(ov.y, 0, 1) * 100) + '%';
    node.style.fontFamily = ov.fontFamily || DEFAULTS.fontFamily;
    node.style.fontSize = fontSize + 'px';
    node.style.color = ov.color || DEFAULTS.color;
    node.style.padding = (fontSize * PAD_RATIO) + 'px';
    node.style.borderRadius = (fontSize * RADIUS_RATIO) + 'px';
    node.style.border = ov.boxStroke ? `${Math.max(1, fontSize * BORDER_RATIO)}px solid ${ov.boxStroke}` : 'none';
    node.style.background = ov.boxFill ? hexToRgba(ov.boxFill, ov.boxOpacity == null ? 1 : ov.boxOpacity) : 'transparent';
    node.textContent = ov.text || ' ';
  }

  // ── Public: paint read-only overlay nodes over an image, for a live preview ───
  // Used on the Review-Queue canvas so the post shows its real overlaid text without baking a flat
  // image first. `container` must be a positioned element covering the image; `refEl` (default: the
  // container's own <img>) supplies the pixel height that fontSizePct is measured against. Returns
  // the created nodes, each tagged data-id, so the caller can wire click/drag — this only paints.
  // Safe to call repeatedly; it removes the nodes it made. Returns [] if the image is not laid out
  // yet, so the caller should re-run on the image's load event and on resize.
  function render(container, overlays, opts) {
    opts = opts || {};
    ensureStyles();
    container.querySelectorAll('.ioe-ov').forEach((n) => n.remove());
    const refEl = opts.refEl || container.querySelector('img') || container;
    const h = refEl.getBoundingClientRect().height;
    if (!h) return [];
    const nodes = [];
    for (const ov of (overlays || [])) {
      if (!ov || !String(ov.text || '').trim()) continue;
      const node = document.createElement('div');
      node.className = 'ioe-ov';
      node.dataset.id = ov.id || '';
      node.style.cursor = opts.cursor || 'pointer';
      // The layer that hosts these is click-through so the bare image stays selectable; each text
      // box opts itself back in so it can be clicked to select the overlays layer.
      node.style.pointerEvents = 'auto';
      styleOverlayNode(node, ov, h);
      container.appendChild(node);
      nodes.push(node);
    }
    return nodes;
  }

  // ── Public: bake overlays into the image at native resolution ────────────────
  async function bake(imageUrl, overlays) {
    const img = await loadImage(imageUrl);
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);
    for (const ov of (overlays || [])) {
      if (!ov || !String(ov.text || '').trim()) continue;
      drawOverlay(ctx, ov, W, H);
    }
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not render the image.')), 'image/png');
    });
  }

  // ── Styles (injected once) ───────────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById('ioe-styles')) return;
    const el = document.createElement('style');
    el.id = 'ioe-styles';
    el.textContent = `
      .ioe-backdrop{position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.75);display:flex;align-items:center;justify-content:center;padding:16px}
      .ioe-modal{background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.35);width:min(1000px,96vw);max-height:94vh;display:flex;flex-direction:column;overflow:hidden}
      .ioe-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #eef2f7}
      .ioe-head h3{font-size:15px;font-weight:800;color:#0f172a;margin:0}
      .ioe-body{display:flex;gap:16px;padding:16px;overflow:auto}
      .ioe-stagewrap{flex:1 1 auto;min-width:0;display:flex;align-items:center;justify-content:center;background:#0f172a;border-radius:12px;overflow:hidden}
      .ioe-stage{position:relative;display:inline-block;max-width:100%;max-height:64vh;line-height:0;user-select:none;touch-action:none}
      .ioe-stage img{display:block;max-width:100%;max-height:64vh;pointer-events:none}
      .ioe-ov{position:absolute;line-height:${LINE_HEIGHT};white-space:pre;cursor:move;box-sizing:border-box;transform:translate(-50%,-50%);overflow:visible}
      .ioe-ov.sel{outline:2px dashed #ec4899;outline-offset:3px}
      .ioe-side{flex:0 0 300px;display:flex;flex-direction:column;gap:12px}
      .ioe-side.empty{align-items:stretch}
      .ioe-row{display:flex;flex-direction:column;gap:5px}
      .ioe-row label{font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.03em}
      .ioe-inline{display:flex;align-items:center;gap:8px}
      .ioe-modal textarea,.ioe-modal select,.ioe-modal input[type=text]{width:100%;font-size:13px;border:1px solid #cbd5e1;border-radius:9px;padding:8px 10px;box-sizing:border-box;font-family:inherit}
      .ioe-modal textarea{resize:vertical;min-height:56px}
      .ioe-modal input[type=color]{width:38px;height:32px;padding:0;border:1px solid #cbd5e1;border-radius:8px;background:#fff;cursor:pointer}
      .ioe-modal input[type=range]{width:100%}
      .ioe-btn{font-size:13px;font-weight:700;border-radius:9px;padding:9px 14px;cursor:pointer;border:1px solid transparent;transition:.15s}
      .ioe-btn.primary{background:#059669;color:#fff}.ioe-btn.primary:hover{background:#047857}
      .ioe-btn.ghost{background:#fff;color:#334155;border-color:#cbd5e1}.ioe-btn.ghost:hover{background:#f8fafc}
      .ioe-btn.danger{background:#fff;color:#dc2626;border-color:#fecaca}.ioe-btn.danger:hover{background:#fef2f2}
      .ioe-btn.block{width:100%}
      .ioe-btn:disabled{opacity:.5;cursor:not-allowed}
      .ioe-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;border-top:1px solid #eef2f7}
      .ioe-emojis{display:flex;flex-wrap:wrap;gap:2px}
      .ioe-emojis button{font-size:18px;line-height:1;background:none;border:0;padding:3px;cursor:pointer;border-radius:6px}
      .ioe-emojis button:hover{background:#f1f5f9}
      .ioe-hint{font-size:12px;color:#64748b;text-align:center;padding:20px 8px}
      .ioe-count{font-size:12px;color:#64748b}
      .ioe-none{display:flex;align-items:center;gap:6px;font-size:12px;color:#475569}
      .ioe-swatchoff{opacity:.35;pointer-events:none}
    `;
    document.head.appendChild(el);
  }

  // ── The interactive editor ───────────────────────────────────────────────────
  function open({ imageUrl, overlays, onDone }) {
    ensureStyles();
    const state = (overlays || []).map((o) => ({ ...DEFAULTS, ...o, id: o.id || uid() }));
    let selectedId = state.length ? state[state.length - 1].id : null;

    const backdrop = document.createElement('div');
    backdrop.className = 'ioe-backdrop';
    backdrop.innerHTML = `
      <div class="ioe-modal" role="dialog" aria-modal="true" aria-label="Add text to image">
        <div class="ioe-head">
          <h3>Add text to your image</h3>
          <button class="ioe-btn ghost" data-act="cancel" aria-label="Close">Cancel</button>
        </div>
        <div class="ioe-body">
          <div class="ioe-stagewrap">
            <div class="ioe-stage" data-stage><img alt="Post image" data-img></div>
          </div>
          <div class="ioe-side" data-side></div>
        </div>
        <div class="ioe-foot">
          <span class="ioe-count" data-count></span>
          <div class="ioe-inline">
            <button class="ioe-btn ghost" data-act="add">+ Add text</button>
            <button class="ioe-btn primary" data-act="save">Save overlays</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const stage = backdrop.querySelector('[data-stage]');
    const imgEl = backdrop.querySelector('[data-img]');
    const side = backdrop.querySelector('[data-side]');
    const countEl = backdrop.querySelector('[data-count]');
    imgEl.src = imageUrl;

    function close(result) {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      if (onDone) onDone(result);
    }
    function onKey(e) { if (e.key === 'Escape') close(null); }
    document.addEventListener('keydown', onKey);

    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(null); });

    // ── Render the overlay DOM nodes over the image ────────────────────────────
    function stageMetrics() {
      const r = imgEl.getBoundingClientRect();
      return { w: r.width, h: r.height, left: r.left, top: r.top };
    }

    function renderOverlays() {
      // Clear existing nodes (keep the <img>).
      stage.querySelectorAll('.ioe-ov').forEach((n) => n.remove());
      const { h } = stageMetrics();
      for (const ov of state) {
        const node = document.createElement('div');
        node.className = 'ioe-ov' + (ov.id === selectedId ? ' sel' : '');
        node.dataset.id = ov.id;
        styleOverlayNode(node, ov, h);
        stage.appendChild(node);
        attachDrag(node, ov);
      }
      countEl.textContent = state.length ? `${state.length} text overlay${state.length > 1 ? 's' : ''}` : 'No overlays yet';
    }

    // ── Drag to reposition (pointer events) ────────────────────────────────────
    function attachDrag(node, ov) {
      node.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        selectedId = ov.id;
        renderSide();
        markSelected();
        const m = stageMetrics();
        node.setPointerCapture(e.pointerId);
        const move = (ev) => {
          ov.x = clamp((ev.clientX - m.left) / m.w, 0, 1);
          ov.y = clamp((ev.clientY - m.top) / m.h, 0, 1);
          node.style.left = (ov.x * 100) + '%';
          node.style.top = (ov.y * 100) + '%';
        };
        const up = () => {
          node.removeEventListener('pointermove', move);
          node.removeEventListener('pointerup', up);
        };
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
      });
    }

    function markSelected() {
      stage.querySelectorAll('.ioe-ov').forEach((n) => n.classList.toggle('sel', n.dataset.id === selectedId));
    }

    // ── Side panel: controls for the selected overlay ──────────────────────────
    function renderSide() {
      const ov = state.find((o) => o.id === selectedId);
      if (!ov) {
        side.classList.add('empty');
        side.innerHTML = `<div class="ioe-hint">Click <b>+ Add text</b> to place a text box on the image, then drag it into position and style it here.</div>`;
        return;
      }
      side.classList.remove('empty');
      const transparencyPct = Math.round((1 - (ov.boxOpacity == null ? 1 : ov.boxOpacity)) * 100);
      side.innerHTML = `
        <div class="ioe-row">
          <label>Text</label>
          <textarea data-f="text" maxlength="500" placeholder="Type your text…">${esc(ov.text || '')}</textarea>
          <div class="ioe-emojis" data-emojis>${EMOJIS.map((em) => `<button type="button" data-em="${em}">${em}</button>`).join('')}</div>
        </div>
        <div class="ioe-row">
          <label>Font</label>
          <select data-f="fontFamily">${FONTS.map((f) => `<option value="${f}"${f === ov.fontFamily ? ' selected' : ''} style="font-family:${f}">${f}</option>`).join('')}</select>
        </div>
        <div class="ioe-row">
          <label>Font size — ${Math.round(ov.fontSizePct * 100)}%</label>
          <input type="range" data-f="fontSizePct" min="2" max="25" step="1" value="${Math.round(ov.fontSizePct * 100)}">
        </div>
        <div class="ioe-row">
          <label>Font colour</label>
          <div class="ioe-inline"><input type="color" data-f="color" value="${ov.color || '#ffffff'}"><span class="ioe-count">${ov.color}</span></div>
        </div>
        <div class="ioe-row">
          <label>Box outline</label>
          <div class="ioe-inline">
            <label class="ioe-none"><input type="checkbox" data-f="strokeOn" ${ov.boxStroke ? 'checked' : ''}> Show</label>
            <input type="color" data-f="boxStroke" value="${ov.boxStroke || '#ec4899'}" class="${ov.boxStroke ? '' : 'ioe-swatchoff'}">
          </div>
        </div>
        <div class="ioe-row">
          <label>Box background</label>
          <div class="ioe-inline">
            <label class="ioe-none"><input type="checkbox" data-f="fillOn" ${ov.boxFill ? 'checked' : ''}> Show</label>
            <input type="color" data-f="boxFill" value="${ov.boxFill || '#000000'}" class="${ov.boxFill ? '' : 'ioe-swatchoff'}">
          </div>
        </div>
        <div class="ioe-row">
          <label>Background transparency — ${transparencyPct}%</label>
          <input type="range" data-f="transparency" min="0" max="100" step="1" value="${transparencyPct}" ${ov.boxFill ? '' : 'disabled'}>
        </div>
        <button class="ioe-btn danger block" data-act="delete">Delete this overlay</button>
      `;
      wireSide(ov);
    }

    function wireSide(ov) {
      const q = (sel) => side.querySelector(sel);
      const rerender = () => { renderOverlays(); markSelected(); };

      q('[data-f="text"]').addEventListener('input', (e) => { ov.text = e.target.value; rerender(); });
      q('[data-f="fontFamily"]').addEventListener('change', (e) => { ov.fontFamily = e.target.value; rerender(); });
      q('[data-f="fontSizePct"]').addEventListener('input', (e) => {
        ov.fontSizePct = clamp(Number(e.target.value) / 100, 0.02, 0.25);
        side.querySelector('[data-f="fontSizePct"]').previousElementSibling.textContent = `Font size — ${Math.round(ov.fontSizePct * 100)}%`;
        rerender();
      });
      q('[data-f="color"]').addEventListener('input', (e) => {
        ov.color = e.target.value;
        e.target.nextElementSibling.textContent = ov.color;
        rerender();
      });
      q('[data-f="strokeOn"]').addEventListener('change', (e) => {
        ov.boxStroke = e.target.checked ? (side.querySelector('[data-f="boxStroke"]').value || '#ec4899') : null;
        renderSide(); rerender();
      });
      q('[data-f="boxStroke"]').addEventListener('input', (e) => { if (ov.boxStroke) { ov.boxStroke = e.target.value; rerender(); } });
      q('[data-f="fillOn"]').addEventListener('change', (e) => {
        ov.boxFill = e.target.checked ? (side.querySelector('[data-f="boxFill"]').value || '#000000') : null;
        renderSide(); rerender();
      });
      q('[data-f="boxFill"]').addEventListener('input', (e) => { if (ov.boxFill) { ov.boxFill = e.target.value; rerender(); } });
      q('[data-f="transparency"]').addEventListener('input', (e) => {
        ov.boxOpacity = clamp(1 - Number(e.target.value) / 100, 0, 1);
        side.querySelector('[data-f="transparency"]').previousElementSibling.textContent = `Background transparency — ${e.target.value}%`;
        rerender();
      });
      // Emoji insert at cursor.
      side.querySelectorAll('[data-emojis] button').forEach((b) => {
        b.addEventListener('click', () => {
          const ta = q('[data-f="text"]');
          const s = ta.selectionStart || ta.value.length;
          const em = b.dataset.em;
          ta.value = ta.value.slice(0, s) + em + ta.value.slice(ta.selectionEnd || s);
          ov.text = ta.value;
          ta.focus();
          ta.selectionStart = ta.selectionEnd = s + em.length;
          rerender();
        });
      });
      q('[data-act="delete"]').addEventListener('click', () => {
        const i = state.findIndex((o) => o.id === ov.id);
        if (i >= 0) state.splice(i, 1);
        selectedId = state.length ? state[state.length - 1].id : null;
        renderOverlays(); renderSide();
      });
    }

    // ── Footer actions ─────────────────────────────────────────────────────────
    backdrop.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
    backdrop.querySelector('[data-act="add"]').addEventListener('click', () => {
      const ov = { ...DEFAULTS, id: uid(), text: 'Your text', x: 0.5, y: 0.5 };
      state.push(ov);
      selectedId = ov.id;
      renderOverlays(); renderSide();
      // Focus the text field so the user can type immediately.
      const ta = side.querySelector('[data-f="text"]');
      if (ta) { ta.focus(); ta.select(); }
    });
    backdrop.querySelector('[data-act="save"]').addEventListener('click', () => {
      // Drop blank overlays so an empty box never bakes into the image.
      const clean = state.filter((o) => String(o.text || '').trim().length > 0)
        .map((o) => ({
          id: o.id, text: o.text, x: o.x, y: o.y,
          fontFamily: o.fontFamily, fontSizePct: o.fontSizePct, color: o.color,
          boxStroke: o.boxStroke, boxFill: o.boxFill, boxOpacity: o.boxOpacity,
        }));
      close(clean);
    });

    // The image must be laid out before we can size overlays against it.
    if (imgEl.complete && imgEl.naturalWidth) { renderOverlays(); renderSide(); }
    else imgEl.addEventListener('load', () => { renderOverlays(); renderSide(); }, { once: true });
    // Keep overlay sizing correct if the modal/image resizes.
    window.addEventListener('resize', renderOverlays);
  }

  window.ImageOverlayEditor = { open, bake, render };
})();
