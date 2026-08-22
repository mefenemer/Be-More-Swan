/**
 * src/components/newsletter-designer.js
 *
 * The Newsletter Design Studio's editing surface — the block canvas, the inspector and the media
 * picker. Mounted by newsletter.js into the Studio's editor column, and by the welcome-sequence
 * editor into its step form, because a welcome email is an email and had no business being the one
 * email in the product that could not carry a picture.
 *
 *   window.NewsletterDesigner.mount({ host, design, assistantName, onChange })
 *     → { getDesign(), setDesign(design), destroy() }
 *
 * `onChange(design)` fires on every edit. The HOST owns persistence — this component never talks to
 * newsletter-issues, so the same canvas serves an issue and a sequence step without knowing which.
 *
 * ── Two things worth knowing before changing anything in here ───────────────────────────────────
 *
 * 1. THE CANVAS IS AN APPROXIMATION AND THE PREVIEW IS THE TRUTH. What renders below is ordinary
 *    HTML in a 600px column; what gets sent is table-based email HTML built on the server by
 *    src/utils/newsletter-design.ts. They are deliberately two renderers, because the thing that
 *    makes email HTML correct — nested tables, inline styles, Outlook conditionals — is exactly
 *    what makes it impossible to edit in place. So the canvas stays close enough to design against,
 *    and "Preview email" (which renders through the real path, with the real image URLs) stays one
 *    click away and is what anybody should check before approving.
 *
 * 2. TEXT AND STICKERS ON AN IMAGE ARE BAKED INTO A NEW PICTURE, not positioned in the markup.
 *    Email cannot position anything over anything: Outlook ignores absolute positioning, and the
 *    large minority whose client blocks images would see the words floating over grey. So we reuse
 *    the social composer's canvas baker (image-overlay-editor.js) exactly as the post editor does,
 *    keep the CLEAN original in `baseAssetId`, and write the flattened result to a new asset. A
 *    second edit always composites onto the clean original — never onto a picture that already has
 *    words on it.
 */
(function () {
  'use strict';

  var MAX_BLOCKS = 120;

  var FONT_STACKS = [
    "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif",
    "Georgia,'Times New Roman',serif",
    "'Trebuchet MS',Verdana,sans-serif",
    "'Courier New',Courier,monospace",
  ];
  var FONT_LABELS = ['System sans', 'Serif', 'Rounded sans', 'Typewriter'];

  // ⚠️ LAST RESORT ONLY. The colours a new design actually gets are the ORGANISATION's, resolved
  // by src/utils/brand-theme.ts from its brand kit and handed to mount() as `defaultTheme` (the
  // newsletter list GET returns it as `brandTheme`). This object is what an org that has never set
  // a brand keeps, and what remains if the payload is missing — it must stay identical to
  // DEFAULT_THEME in src/utils/newsletter-design.ts. It used to be the only answer, which is why
  // every customer's newsletter went out in this green.
  var DEFAULT_THEME = {
    accent: '#059669',
    background: '#f6f7f9',
    cardBackground: '#ffffff',
    text: '#111827',
    fontFamily: FONT_STACKS[0],
    rounded: true,
  };

  // The shared colour maths — the SAME artifact src/utils/brand-theme.ts imports on the server, so a
  // button added here and a button built from a template there get the identical label colour.
  // Script-loaded by workspace.html; the fallback keeps the canvas working if it ever is not.
  var CONTRAST = (typeof window !== 'undefined' && window.BrandContrast) || {
    readableInkOn: function () { return '#ffffff'; },
  };

  var uid = function () { return 'b_' + Math.random().toString(36).slice(2, 10); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var toast = function (m) { if (window.showToast) window.showToast(m); };

  // ── Styles ──────────────────────────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById('nld-styles')) return;
    var el = document.createElement('style');
    el.id = 'nld-styles';
    el.textContent = [
      '.nld{display:flex;flex-direction:column;gap:12px}',
      '.nld-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px}',
      '.nld-bar .nld-sep{flex:1}',
      '.nld-btn{display:inline-flex;align-items:center;gap:4px;padding:5px 9px;font-size:12px;font-weight:700;color:#374151;background:#fff;border:1px solid #d1d5db;border-radius:8px;cursor:pointer}',
      '.nld-btn:hover{background:#f3f4f6}',
      '.nld-btn[disabled]{opacity:.45;cursor:not-allowed}',
      '.nld-btn-danger{color:#b91c1c;border-color:#fecaca}',
      '.nld-btn-danger:hover{background:#fef2f2}',
      '.nld-main{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:14px;align-items:start}',
      '@media(max-width:900px){.nld-main{grid-template-columns:minmax(0,1fr)}}',
      '.nld-stage{padding:20px 12px;border-radius:12px;border:1px solid #e5e7eb;overflow:auto;max-height:62vh}',
      '.nld-card{max-width:600px;margin:0 auto;padding:24px;border:1px solid #e5e7eb}',
      '.nld-block{position:relative;padding:4px;border:1px dashed transparent;border-radius:6px;cursor:pointer}',
      '.nld-block:hover{border-color:#c7d2fe}',
      '.nld-block.is-selected{border-color:#059669;box-shadow:0 0 0 2px rgba(5,150,105,.12)}',
      '.nld-block + .nld-block{margin-top:14px}',
      '.nld-tools{position:absolute;top:-11px;right:4px;display:none;gap:2px;background:#fff;border:1px solid #e5e7eb;border-radius:7px;padding:2px;box-shadow:0 2px 8px rgba(0,0,0,.08);z-index:2}',
      '.nld-block.is-selected > .nld-tools,.nld-block:hover > .nld-tools{display:flex}',
      '.nld-tools button{width:22px;height:20px;font-size:11px;line-height:1;border:0;background:none;border-radius:4px;cursor:pointer;color:#4b5563}',
      '.nld-tools button:hover{background:#f3f4f6;color:#111827}',
      '.nld-tools button.nld-del:hover{background:#fef2f2;color:#b91c1c}',
      '.nld-cols{display:flex;gap:12px}',
      '.nld-col{flex:1;min-width:0;border:1px dashed #e5e7eb;border-radius:8px;padding:6px}',
      '.nld-col-empty{font-size:11px;color:#9ca3af;text-align:center;padding:14px 4px}',
      '.nld-ph{color:#9ca3af;font-style:italic}',
      '.nld-imgslot{display:flex;align-items:center;justify-content:center;min-height:110px;background:#f3f4f6;border:1px dashed #d1d5db;border-radius:8px;color:#6b7280;font-size:12px;font-weight:600;text-align:center;padding:12px}',
      '.nld-side{border:1px solid #e5e7eb;border-radius:12px;background:#fff;padding:12px;position:sticky;top:8px}',
      '.nld-side h4{margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#6b7280}',
      '.nld-f{margin-bottom:10px}',
      '.nld-f label{display:block;font-size:11px;font-weight:700;color:#6b7280;margin-bottom:3px}',
      '.nld-f input[type=text],.nld-f input[type=url],.nld-f select,.nld-f textarea{width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:8px;font:inherit;font-size:13px;background:#fff;color:#111827}',
      '.nld-f textarea{min-height:120px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.5}',
      '.nld-f input[type=color]{width:36px;height:26px;padding:0;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;vertical-align:middle}',
      '.nld-f input[type=range]{width:100%}',
      '.nld-row{display:flex;gap:6px;align-items:center}',
      '.nld-seg{display:inline-flex;border:1px solid #d1d5db;border-radius:8px;overflow:hidden}',
      '.nld-seg button{padding:4px 9px;font-size:11px;font-weight:700;background:#fff;border:0;border-right:1px solid #e5e7eb;cursor:pointer;color:#4b5563}',
      '.nld-seg button:last-child{border-right:0}',
      '.nld-seg button.on{background:#059669;color:#fff}',
      '.nld-fmt{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px}',
      '.nld-fmt button{padding:2px 7px;font-size:11px;font-weight:700;border:1px solid #e5e7eb;background:#fff;border-radius:6px;cursor:pointer;color:#4b5563}',
      '.nld-fmt button:hover{background:#f3f4f6}',
      '.nld-empty{padding:34px 16px;text-align:center;color:#6b7280;font-size:13px}',
      '.nld-hint{font-size:11px;color:#9ca3af;line-height:1.45;margin-top:6px}',
      // Media picker
      '.nld-pick{position:fixed;inset:0;z-index:9998;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;padding:16px}',
      '.nld-pick-box{background:#fff;border-radius:16px;width:min(760px,96vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden}',
      '.nld-pick-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #eef2f7}',
      '.nld-pick-body{padding:14px 16px;overflow:auto}',
      '.nld-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}',
      '.nld-tile{border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;cursor:pointer;background:#f9fafb;padding:0}',
      '.nld-tile:hover{border-color:#059669}',
      '.nld-tile img{display:block;width:100%;height:88px;object-fit:cover}',
      '.nld-tile span{display:block;padding:5px 6px;font-size:11px;color:#4b5563;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    ].join('\n');
    document.head.appendChild(el);
  }

  // ── Block factories ─────────────────────────────────────────────────────────
  var FACTORY = {
    heading: function () { return { id: uid(), type: 'heading', text: 'A heading', level: 2, align: 'left' }; },
    text: function () { return { id: uid(), type: 'text', markdown: 'Write something here.', align: 'left' }; },
    image: function () {
      return { id: uid(), type: 'image', assetId: null, baseAssetId: null, alt: '', href: '', align: 'center', width: 100, caption: '', overlays: [] };
    },
    // ⚠️ Takes the live theme. Every button in the product used to be born in the default green
    // with a white label — wrong colour on a branded email, and unreadable on a pale accent.
    button: function (theme) {
      var accent = (theme && theme.accent) || DEFAULT_THEME.accent;
      return {
        id: uid(), type: 'button', label: 'Read more', href: '', align: 'center',
        background: accent, color: CONTRAST.readableInkOn(accent),
      };
    },
    divider: function () { return { id: uid(), type: 'divider' }; },
    spacer: function () { return { id: uid(), type: 'spacer', size: 24 }; },
    columns: function (theme) {
      return { id: uid(), type: 'columns', columns: [[FACTORY.image(theme)], [FACTORY.heading(theme), FACTORY.text(theme)]] };
    },
  };

  var ADDABLE = [
    ['text', 'Text'], ['heading', 'Heading'], ['image', 'Image'], ['button', 'Button'],
    ['divider', 'Divider'], ['spacer', 'Space'], ['columns', 'Two columns'],
  ];

  // ── Tiny Markdown → HTML, for the CANVAS ONLY ───────────────────────────────
  //
  // ⚠️ Not a Markdown implementation and must never be mistaken for one. The sent email is rendered
  // by the real parser on the server (marked + sanitize-html). This exists so the author can see
  // bold text as bold while they drag blocks around, and covers exactly the marks the formatting
  // buttons produce. Anything it does not understand is shown as the literal text the author typed,
  // which is honest: they can still see their words.
  function miniMarkdown(md) {
    var lines = String(md || '').split('\n');
    var out = [];
    var list = null;
    var inline = function (t) {
      return esc(t)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="#" onclick="return false" style="color:inherit;text-decoration:underline">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
        .replace(/_([^_]+)_/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    };
    var closeList = function () { if (list) { out.push('</' + list + '>'); list = null; } };
    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      var ul = line.match(/^\s*[-*]\s+(.*)$/);
      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      var q = line.match(/^\s*>\s?(.*)$/);
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      // ⚠️ list-style stated inline. The host page is Tailwind, whose preflight strips markers from
      // every ul/ol — so a bulleted list in the canvas rendered as unindented plain lines while the
      // sent email (rendered by the server, into an inbox with no preflight) had bullets.
      if (ul) { if (list !== 'ul') { closeList(); out.push('<ul style="margin:0 0 0 18px;padding:0;list-style:disc">'); list = 'ul'; } out.push('<li style="list-style:disc">' + inline(ul[1]) + '</li>'); return; }
      if (ol) { if (list !== 'ol') { closeList(); out.push('<ol style="margin:0 0 0 18px;padding:0;list-style:decimal">'); list = 'ol'; } out.push('<li style="list-style:decimal">' + inline(ol[1]) + '</li>'); return; }
      closeList();
      if (h) { out.push('<strong style="display:block;font-size:' + (20 - h[1].length) + 'px">' + inline(h[2]) + '</strong>'); return; }
      if (q) { out.push('<blockquote style="margin:0;padding-left:10px;border-left:3px solid #e5e7eb;color:#4b5563">' + inline(q[1]) + '</blockquote>'); return; }
      if (!line.trim()) { out.push('<div style="height:8px"></div>'); return; }
      out.push('<p style="margin:0 0 6px">' + inline(line) + '</p>');
    });
    closeList();
    return out.join('');
  }

  // ── Mount ───────────────────────────────────────────────────────────────────
  function mount(opts) {
    ensureStyles();
    var host = opts.host;
    if (!host) return null;

    var state = {
      design: normalise(opts.design),
      selected: null,          // { blockId, col: null|0|1 } — col names the column a nested block is in
      assistantName: opts.assistantName || '',
      urls: {},                // assetId → display url, filled lazily
      showTheme: false,
    };

    function normalise(d) {
      var design = d && typeof d === 'object' ? d : null;
      return {
        version: 1,
        template: (design && design.template) || 'custom',
        // ⚠️ The stored theme still wins field by field. A design somebody has restyled by hand
        // must not be repainted in the brand the next time it is opened — the brand is the base a
        // NEW design starts from, not a rule applied to old ones.
        theme: Object.assign({}, DEFAULT_THEME, opts.defaultTheme || {}, (design && design.theme) || {}),
        blocks: (design && Array.isArray(design.blocks)) ? design.blocks.slice(0, MAX_BLOCKS) : [],
      };
    }

    function changed() {
      if (typeof opts.onChange === 'function') opts.onChange(state.design);
      render();
    }

    // Every block, flattened, with the column it lives in. One walker so nothing has to remember
    // that a block might be nested.
    function walk() {
      var out = [];
      state.design.blocks.forEach(function (b, i) {
        out.push({ block: b, index: i, col: null });
        if (b.type === 'columns') {
          [0, 1].forEach(function (c) {
            (b.columns[c] || []).forEach(function (sub, j) { out.push({ block: sub, index: j, col: c, parent: b }); });
          });
        }
      });
      return out;
    }
    function find(id) {
      var hit = walk().filter(function (e) { return e.block.id === id; })[0];
      return hit || null;
    }
    function listFor(entry) {
      return entry.col == null ? state.design.blocks : entry.parent.columns[entry.col];
    }

    // ── Mutations ─────────────────────────────────────────────────────────────
    function addBlock(kind) {
      if (state.design.blocks.length >= MAX_BLOCKS) { toast('That is as many blocks as one email can hold.'); return; }
      var block = FACTORY[kind] ? FACTORY[kind](state.design.theme) : null;
      if (!block) return;
      // Inserted AFTER the selection rather than at the end. Adding to the bottom of a long email
      // and then dragging it fifteen places up is the interaction everybody complains about.
      // ⚠️ A block selected INSIDE a column inserts after the column PAIR, not into it: the two
      // columns are a deliberate layout, and silently making one of them three blocks tall is not
      // what "add a heading" meant. (Adding into a column is the two buttons in its own inspector.)
      var sel = state.selected && find(state.selected.blockId);
      var anchor = sel && sel.col != null ? find(sel.parent.id) : sel;
      if (anchor && anchor.col == null) state.design.blocks.splice(anchor.index + 1, 0, block);
      else state.design.blocks.push(block);
      state.selected = { blockId: block.id };
      changed();
    }
    function move(id, delta) {
      var e = find(id);
      if (!e) return;
      var list = listFor(e);
      var to = e.index + delta;
      if (to < 0 || to >= list.length) return;
      list.splice(to, 0, list.splice(e.index, 1)[0]);
      changed();
    }
    function remove(id) {
      var e = find(id);
      if (!e) return;
      listFor(e).splice(e.index, 1);
      if (state.selected && state.selected.blockId === id) state.selected = null;
      changed();
    }
    function duplicate(id) {
      var e = find(id);
      if (!e) return;
      var copy = JSON.parse(JSON.stringify(e.block));
      var reid = function (b) { b.id = uid(); if (b.type === 'columns') { b.columns[0].forEach(reid); b.columns[1].forEach(reid); } };
      reid(copy);
      listFor(e).splice(e.index + 1, 0, copy);
      state.selected = { blockId: copy.id };
      changed();
    }
    function patch(id, fields) {
      var e = find(id);
      if (!e) return;
      Object.keys(fields).forEach(function (k) { e.block[k] = fields[k]; });
      changed();
    }

    // ── Canvas ────────────────────────────────────────────────────────────────
    function imgUrl(block) {
      if (!block.assetId) return null;
      return state.urls[block.assetId] || null;
    }

    function blockHtml(b) {
      var t = state.design.theme;
      var al = 'text-align:' + (b.align || 'left') + ';';
      switch (b.type) {
        case 'heading':
          return '<div style="' + al + 'font-family:' + t.fontFamily + ';color:' + t.text + ';font-weight:700;line-height:1.3;font-size:'
            + (b.level === 1 ? 26 : b.level === 2 ? 21 : 17) + 'px">' + esc(b.text) + '</div>';
        case 'text':
          return '<div style="' + al + 'font-family:' + t.fontFamily + ';color:' + t.text + ';font-size:15px;line-height:1.6">' + miniMarkdown(b.markdown) + '</div>';
        case 'image': {
          var url = imgUrl(b);
          // ⚠️ A <div>, not a bare <br>: .nld-imgslot is a flex container, so the two text runs became
          // one line reading "No picture chosen yetSelect this block…".
          if (!url) return '<div class="nld-imgslot"><div>No picture chosen yet<div style="font-weight:500;margin-top:2px">Select this block and press Choose image</div></div></div>';
          var m = b.align === 'center' ? '0 auto' : b.align === 'right' ? '0 0 0 auto' : '0';
          var cap = b.caption ? '<div style="' + al + 'font-size:12px;color:#6b7280;margin-top:4px">' + esc(b.caption) + '</div>' : '';
          return '<div style="' + al + '"><img src="' + esc(url) + '" alt="" style="display:block;width:' + b.width + '%;max-width:100%;height:auto;margin:' + m + ';border-radius:' + (t.rounded ? '8px' : '0') + '">' + cap + '</div>';
        }
        case 'button': {
          var bm = b.align === 'center' ? '0 auto' : b.align === 'right' ? '0 0 0 auto' : '0';
          return '<div style="' + al + '"><span style="display:inline-block;margin:' + bm + ';padding:11px 24px;border-radius:8px;font-family:' + t.fontFamily + ';font-weight:700;font-size:15px;background:' + b.background + ';color:' + b.color + '">' + esc(b.label) + '</span>'
            + (b.href ? '' : '<div class="nld-ph" style="font-size:11px;margin-top:4px">No link yet — it will not be clickable.</div>') + '</div>';
        }
        case 'divider':
          return '<hr style="border:0;border-top:1px solid #e5e7eb;margin:0">';
        case 'spacer':
          return '<div style="height:' + b.size + 'px;background:repeating-linear-gradient(45deg,#f8fafc,#f8fafc 6px,#f1f5f9 6px,#f1f5f9 12px);border-radius:4px"></div>';
        default:
          return '';
      }
    }

    function tools(id, canUp, canDown, allowDuplicate) {
      return '<div class="nld-tools">'
        + '<button type="button" title="Move up" data-nld-up="' + id + '"' + (canUp ? '' : ' disabled') + '>&#9650;</button>'
        + '<button type="button" title="Move down" data-nld-down="' + id + '"' + (canDown ? '' : ' disabled') + '>&#9660;</button>'
        + (allowDuplicate ? '<button type="button" title="Duplicate" data-nld-dup="' + id + '">&#10697;</button>' : '')
        + '<button type="button" class="nld-del" title="Delete" data-nld-del="' + id + '">&#10005;</button>'
        + '</div>';
    }

    function wrap(b, canUp, canDown, allowDuplicate) {
      var sel = state.selected && state.selected.blockId === b.id ? ' is-selected' : '';
      return '<div class="nld-block' + sel + '" data-nld-block="' + b.id + '">'
        + tools(b.id, canUp, canDown, allowDuplicate) + blockHtml(b) + '</div>';
    }

    function canvasHtml() {
      var t = state.design.theme;
      if (!state.design.blocks.length) {
        return '<div class="nld-empty"><p style="font-weight:700;color:#374151">Nothing in this email yet.</p>'
          + '<p>Add a block above, or pick a template.</p></div>';
      }
      var body = state.design.blocks.map(function (b, i) {
        if (b.type !== 'columns') return wrap(b, i > 0, i < state.design.blocks.length - 1, true);
        var col = function (c) {
          var items = b.columns[c] || [];
          if (!items.length) return '<div class="nld-col"><div class="nld-col-empty">Empty column<br>Select it and add a block</div></div>';
          return '<div class="nld-col">' + items.map(function (sub, j) {
            return wrap(sub, j > 0, j < items.length - 1, false);
          }).join('') + '</div>';
        };
        var sel = state.selected && state.selected.blockId === b.id ? ' is-selected' : '';
        return '<div class="nld-block' + sel + '" data-nld-block="' + b.id + '">'
          + tools(b.id, i > 0, i < state.design.blocks.length - 1, true)
          + '<div class="nld-cols">' + col(0) + col(1) + '</div></div>';
      }).join('');

      return '<div class="nld-stage" style="background:' + t.background + '">'
        + '<div class="nld-card" style="background:' + t.cardBackground + ';border-radius:' + (t.rounded ? '12px' : '0') + '">'
        + body + '</div></div>';
    }

    // ── Inspector ─────────────────────────────────────────────────────────────
    function field(label, inner) {
      return '<div class="nld-f"><label>' + esc(label) + '</label>' + inner + '</div>';
    }
    function seg(name, value, options) {
      return '<div class="nld-seg">' + options.map(function (o) {
        return '<button type="button" data-nld-seg="' + name + '" data-v="' + o[0] + '" class="' + (value === o[0] ? 'on' : '') + '">' + esc(o[1]) + '</button>';
      }).join('') + '</div>';
    }
    var ALIGN = [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']];

    function themePanel() {
      var t = state.design.theme;
      return '<h4>Style</h4>'
        + field('Links and buttons', '<input type="color" data-nld-theme="accent" value="' + t.accent + '"> <span style="font-size:11px;color:#6b7280">' + t.accent + '</span>')
        + field('Text', '<input type="color" data-nld-theme="text" value="' + t.text + '">')
        + field('Card', '<input type="color" data-nld-theme="cardBackground" value="' + t.cardBackground + '">')
        + field('Behind the card', '<input type="color" data-nld-theme="background" value="' + t.background + '">')
        + field('Font', '<select data-nld-theme="fontFamily">' + FONT_STACKS.map(function (f, i) {
          return '<option value="' + esc(f) + '"' + (t.fontFamily === f ? ' selected' : '') + '>' + FONT_LABELS[i] + '</option>';
        }).join('') + '</select>')
        + field('Corners', seg('rounded', t.rounded ? 'r' : 's', [['r', 'Rounded'], ['s', 'Square']]))
        + brandResetHtml()
        + '<p class="nld-hint">Most email clients honour these. A few — Outlook especially — will '
        + 'ignore rounded corners and background colours, so the email must still read as an email '
        + 'in black on white. It always will: nothing here changes the words.</p>';
    }

    /**
     * "Back to my brand colours", offered only when it would change something.
     *
     * ⚠️ Deliberately a button rather than automatic. A design keeps whatever colours it was saved
     * with (see normalise) — repainting an issue somebody styled by hand, because their brand kit
     * changed last week, is not a thing software should do on its own. This is how they ask.
     */
    function brandResetHtml() {
      var brand = opts.defaultTheme;
      if (!brand) return '';
      var t = state.design.theme;
      var same = ['accent', 'text', 'cardBackground', 'background'].every(function (k) {
        return String(t[k]).toLowerCase() === String(brand[k]).toLowerCase();
      });
      if (same) {
        return '<p class="nld-hint" style="margin-top:10px">These are your brand colours, from your '
          + 'brand kit in Settings.</p>';
      }
      return '<div style="margin-top:10px"><button type="button" class="nld-btn" data-nld-brandreset>'
        + 'Back to my brand colours</button></div>';
    }

    function inspectorHtml() {
      if (state.showTheme) return themePanel();
      var e = state.selected && find(state.selected.blockId);
      if (!e) {
        return '<h4>Nothing selected</h4><p style="font-size:12px;color:#6b7280;line-height:1.5">'
          + 'Click a block in the email to edit it, or add one from the bar above.</p>';
      }
      var b = e.block;
      switch (b.type) {
        case 'heading':
          return '<h4>Heading</h4>'
            + field('Text', '<input type="text" data-nld-in="text" value="' + esc(b.text) + '">')
            + field('Size', seg('level', String(b.level), [['1', 'Big'], ['2', 'Medium'], ['3', 'Small']]))
            + field('Align', seg('align', b.align, ALIGN));
        case 'text':
          return '<h4>Text</h4>'
            + '<div class="nld-fmt">'
            + '<button type="button" data-nld-fmt="bold"><b>B</b></button>'
            + '<button type="button" data-nld-fmt="italic"><i>I</i></button>'
            + '<button type="button" data-nld-fmt="link">Link</button>'
            + '<button type="button" data-nld-fmt="bullet">List</button>'
            + '<button type="button" data-nld-fmt="quote">Quote</button>'
            + '</div>'
            + '<textarea data-nld-in="markdown" spellcheck="true">' + esc(b.markdown) + '</textarea>'
            + field('Align', seg('align', b.align, ALIGN))
            + '<p class="nld-hint">Markdown. Personalisation tags such as '
            + '{{contact.first_name | "there"}} work in here exactly as they do in a plain issue.</p>';
        case 'image':
          return '<h4>Image</h4>'
            + '<div class="nld-row" style="margin-bottom:8px">'
            + '<button type="button" class="nld-btn" data-nld-pick="' + b.id + '">' + (b.assetId ? 'Change image' : 'Choose image') + '</button>'
            + (b.assetId ? '<button type="button" class="nld-btn" data-nld-overlay="' + b.id + '">Text &amp; stickers</button>' : '')
            + '</div>'
            + (b.overlays && b.overlays.length
              ? '<p class="nld-hint" style="color:#059669;font-weight:600">' + b.overlays.length + ' overlay'
                + (b.overlays.length === 1 ? '' : 's') + ' baked into this picture. Edit them with the button above.</p>'
              : '')
            + field('Describe it (alt text)', '<input type="text" data-nld-in="alt" value="' + esc(b.alt) + '">')
            + '<p class="nld-hint" style="margin-top:-6px">⚠️ Roughly a third of people will never see '
            + 'this picture — their client blocks images. This sentence is what they get instead, so '
            + 'if the picture carries words, put those words here too.</p>'
            + field('Caption (optional)', '<input type="text" data-nld-in="caption" value="' + esc(b.caption) + '">')
            + field('Link to (optional)', '<input type="url" data-nld-in="href" placeholder="https://…" value="' + esc(b.href) + '">')
            + field('Width — ' + b.width + '%', '<input type="range" min="25" max="100" step="5" data-nld-in="width" value="' + b.width + '">')
            + field('Align', seg('align', b.align, ALIGN));
        case 'button':
          return '<h4>Button</h4>'
            + field('Label', '<input type="text" data-nld-in="label" value="' + esc(b.label) + '">')
            + field('Goes to', '<input type="url" data-nld-in="href" placeholder="https://…" value="' + esc(b.href) + '">')
            + field('Colour', '<span class="nld-row"><input type="color" data-nld-in="background" value="' + b.background + '"> <input type="color" data-nld-in="color" value="' + b.color + '"> <span style="font-size:11px;color:#6b7280">button / text</span></span>')
            + field('Align', seg('align', b.align, ALIGN))
            + '<p class="nld-hint">A button with no link is still shown, but nothing happens when it '
            + 'is pressed — which readers report as a broken email rather than a missing link.</p>';
        case 'spacer':
          return '<h4>Space</h4>' + field('Height — ' + b.size + 'px', '<input type="range" min="4" max="96" step="4" data-nld-in="size" value="' + b.size + '">');
        case 'divider':
          return '<h4>Divider</h4><p style="font-size:12px;color:#6b7280">A horizontal line. Nothing to set.</p>';
        case 'columns':
          return '<h4>Two columns</h4>'
            + '<p style="font-size:12px;color:#6b7280;line-height:1.5">Click a block inside a column to edit it.</p>'
            + '<div class="nld-row" style="margin-top:8px">'
            + '<button type="button" class="nld-btn" data-nld-coladd="0" data-nld-colid="' + b.id + '">+ Left</button>'
            + '<button type="button" class="nld-btn" data-nld-coladd="1" data-nld-colid="' + b.id + '">+ Right</button>'
            + '</div>'
            + '<p class="nld-hint">On a phone the two columns stack, left first. Most clients honour '
            + 'that; the few that do not show two narrow columns instead, which still reads.</p>';
        default:
          return '';
      }
    }

    // ── Render ────────────────────────────────────────────────────────────────
    function render() {
      var addButtons = ADDABLE.map(function (a) {
        return '<button type="button" class="nld-btn" data-nld-add="' + a[0] + '">+ ' + a[1] + '</button>';
      }).join('');

      host.innerHTML = '<div class="nld">'
        + '<div class="nld-bar">' + addButtons
        + '<span class="nld-sep"></span>'
        + '<button type="button" class="nld-btn" data-nld-styletoggle>' + (state.showTheme ? 'Done styling' : 'Style') + '</button>'
        + '</div>'
        + '<div class="nld-main">'
        + '<div>' + canvasHtml() + '</div>'
        + '<aside class="nld-side">' + inspectorHtml() + '</aside>'
        + '</div></div>';
      wire();
      resolveUrls();
    }

    // Fill in display URLs for any image whose asset we have not resolved yet, then repaint once.
    // Batched deliberately: a design with six pictures should be one request, not six.
    var resolving = false;
    function resolveUrls() {
      var missing = [];
      walk().forEach(function (e) {
        if (e.block.type === 'image' && e.block.assetId && !state.urls[e.block.assetId]) missing.push(e.block.assetId);
      });
      if (!missing.length || resolving) return;
      resolving = true;
      fetch('/.netlify/functions/content-assets', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : { assets: {} }; })
        .then(function (d) {
          var groups = d.assets || {};
          [].concat(groups.pending || [], groups.scheduled || [], groups.posted || []).forEach(function (a) {
            if (a.storageUrl || a.externalUrl) state.urls[a.id] = a.storageUrl || a.externalUrl;
          });
        })
        .catch(function () { /* a picture that will not resolve shows its empty slot, not an error */ })
        .then(function () { resolving = false; render(); });
    }

    function wire() {
      host.querySelectorAll('[data-nld-add]').forEach(function (el) {
        el.addEventListener('click', function () { addBlock(el.getAttribute('data-nld-add')); });
      });
      var styleBtn = host.querySelector('[data-nld-styletoggle]');
      if (styleBtn) styleBtn.addEventListener('click', function () { state.showTheme = !state.showTheme; render(); });

      host.querySelectorAll('[data-nld-block]').forEach(function (el) {
        el.addEventListener('click', function (ev) {
          // Stop at the innermost block: a click inside a column must select the sub-block, not the
          // column that contains it.
          ev.stopPropagation();
          state.showTheme = false;
          state.selected = { blockId: el.getAttribute('data-nld-block') };
          render();
        });
      });
      host.querySelectorAll('[data-nld-up]').forEach(function (el) {
        el.addEventListener('click', function (ev) { ev.stopPropagation(); move(el.getAttribute('data-nld-up'), -1); });
      });
      host.querySelectorAll('[data-nld-down]').forEach(function (el) {
        el.addEventListener('click', function (ev) { ev.stopPropagation(); move(el.getAttribute('data-nld-down'), 1); });
      });
      host.querySelectorAll('[data-nld-dup]').forEach(function (el) {
        el.addEventListener('click', function (ev) { ev.stopPropagation(); duplicate(el.getAttribute('data-nld-dup')); });
      });
      host.querySelectorAll('[data-nld-del]').forEach(function (el) {
        el.addEventListener('click', function (ev) { ev.stopPropagation(); remove(el.getAttribute('data-nld-del')); });
      });

      // Inspector inputs. `input` for text and ranges so the canvas tracks typing; the repaint
      // restores focus and the caret, or every keystroke would jump the cursor to the end.
      host.querySelectorAll('[data-nld-in]').forEach(function (el) {
        var key = el.getAttribute('data-nld-in');
        var handler = function () {
          if (!state.selected) return;
          var value = el.type === 'range' ? Number(el.value) : el.value;
          var caret = (el.selectionStart != null) ? [el.selectionStart, el.selectionEnd] : null;
          var fields = {};
          fields[key] = value;
          patch(state.selected.blockId, fields);
          var again = host.querySelector('[data-nld-in="' + key + '"]');
          if (again) {
            again.focus();
            if (caret && again.setSelectionRange) { try { again.setSelectionRange(caret[0], caret[1]); } catch (_) { /* colour inputs */ } }
          }
        };
        el.addEventListener(el.type === 'color' ? 'change' : 'input', handler);
      });

      host.querySelectorAll('[data-nld-seg]').forEach(function (el) {
        el.addEventListener('click', function () {
          var name = el.getAttribute('data-nld-seg');
          var v = el.getAttribute('data-v');
          if (name === 'rounded') { state.design.theme.rounded = v === 'r'; changed(); return; }
          if (!state.selected) return;
          var fields = {};
          fields[name] = name === 'level' ? Number(v) : v;
          patch(state.selected.blockId, fields);
        });
      });

      host.querySelectorAll('[data-nld-theme]').forEach(function (el) {
        el.addEventListener('change', function () {
          state.design.theme[el.getAttribute('data-nld-theme')] = el.value;
          changed();
        });
      });

      var brandReset = host.querySelector('[data-nld-brandreset]');
      if (brandReset) {
        brandReset.addEventListener('click', function () {
          // ⚠️ Colours only. The font and the corners are layout choices the author made about THIS
          // email, and the brand kit has no opinion about either (a webfont does not survive the
          // trip into an inbox — see src/utils/brand-theme.ts).
          ['accent', 'text', 'cardBackground', 'background'].forEach(function (k) {
            if (opts.defaultTheme && opts.defaultTheme[k]) state.design.theme[k] = opts.defaultTheme[k];
          });
          changed();
        });
      }

      host.querySelectorAll('[data-nld-fmt]').forEach(function (el) {
        el.addEventListener('click', function () { applyFormat(el.getAttribute('data-nld-fmt')); });
      });

      host.querySelectorAll('[data-nld-pick]').forEach(function (el) {
        el.addEventListener('click', function () { openPicker(el.getAttribute('data-nld-pick')); });
      });
      host.querySelectorAll('[data-nld-overlay]').forEach(function (el) {
        el.addEventListener('click', function () { openOverlays(el.getAttribute('data-nld-overlay')); });
      });
      host.querySelectorAll('[data-nld-coladd]').forEach(function (el) {
        el.addEventListener('click', function () {
          var e = find(el.getAttribute('data-nld-colid'));
          if (!e) return;
          var side = Number(el.getAttribute('data-nld-coladd'));
          var block = FACTORY.text();
          e.block.columns[side].push(block);
          state.selected = { blockId: block.id };
          changed();
        });
      });
    }

    // Wrap the selection in a Markdown mark. Nothing clever: it operates on the textarea the author
    // is looking at, and leaves the caret where they can carry on typing.
    function applyFormat(kind) {
      var ta = host.querySelector('textarea[data-nld-in="markdown"]');
      if (!ta || !state.selected) return;
      var s = ta.selectionStart, e2 = ta.selectionEnd;
      var sel = ta.value.slice(s, e2);
      var before = ta.value.slice(0, s), after = ta.value.slice(e2);
      var out, caret;
      if (kind === 'bold') { out = '**' + (sel || 'bold text') + '**'; caret = s + out.length; }
      else if (kind === 'italic') { out = '_' + (sel || 'italic text') + '_'; caret = s + out.length; }
      else if (kind === 'link') { out = '[' + (sel || 'link text') + '](https://)'; caret = s + out.length - 1; }
      else if (kind === 'bullet') {
        out = (sel || 'First thing').split('\n').map(function (l) { return l.trim() ? '- ' + l.replace(/^-\s*/, '') : l; }).join('\n');
        caret = s + out.length;
      } else if (kind === 'quote') {
        out = (sel || 'Quoted line').split('\n').map(function (l) { return l.trim() ? '> ' + l.replace(/^>\s*/, '') : l; }).join('\n');
        caret = s + out.length;
      } else return;
      ta.value = before + out + after;
      patch(state.selected.blockId, { markdown: ta.value });
      var again = host.querySelector('textarea[data-nld-in="markdown"]');
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (_) {} }
    }

    // ── Media picker ──────────────────────────────────────────────────────────
    function openPicker(blockId) {
      var back = document.createElement('div');
      back.className = 'nld-pick';
      back.innerHTML = '<div class="nld-pick-box">'
        + '<div class="nld-pick-head"><strong style="font-size:14px">Choose a picture</strong>'
        + '<span><label class="nld-btn" style="margin-right:6px">Upload<input type="file" accept="image/*" hidden data-nld-upload></label>'
        + '<button type="button" class="nld-btn" data-nld-pickclose>Close</button></span></div>'
        + '<div class="nld-pick-body"><p style="font-size:13px;color:#6b7280">Loading your library…</p></div></div>';
      document.body.appendChild(back);

      var body = back.querySelector('.nld-pick-body');
      var close = function () { back.remove(); };
      back.addEventListener('click', function (ev) { if (ev.target === back) close(); });
      back.querySelector('[data-nld-pickclose]').addEventListener('click', close);

      back.querySelector('[data-nld-upload]').addEventListener('change', function (ev) {
        var file = ev.target.files && ev.target.files[0];
        ev.target.value = '';
        if (!file) return;
        body.innerHTML = '<p style="font-size:13px;color:#6b7280">Uploading…</p>';
        uploadAsset(file).then(function (asset) {
          state.urls[asset.id] = asset.storageUrl || asset.externalUrl || '';
          // ⚠️ A fresh upload REPLACES the picture and clears the overlays: the text somebody
          // positioned was positioned on a different photograph, and re-applying it blind would put
          // a caption across a face.
          patch(blockId, { assetId: asset.id, baseAssetId: asset.id, overlays: [] });
          close();
        }).catch(function (err) {
          body.innerHTML = '<p style="font-size:13px;color:#b91c1c">' + esc(err.message || 'Upload failed.') + '</p>';
        });
      });

      fetch('/.netlify/functions/content-assets', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('Could not load your library.')); })
        .then(function (d) {
          var groups = d.assets || {};
          var images = [].concat(groups.pending || [], groups.scheduled || [], groups.posted || [])
            .filter(function (a) { return a.assetType === 'image' && (a.storageUrl || a.externalUrl); });
          if (!images.length) {
            body.innerHTML = '<p style="font-size:13px;color:#6b7280">Nothing in your library yet — upload a picture with the button above.</p>';
            return;
          }
          body.innerHTML = '<div class="nld-grid">' + images.map(function (a) {
            var u = a.storageUrl || a.externalUrl;
            state.urls[a.id] = u;
            return '<button type="button" class="nld-tile" data-nld-asset="' + a.id + '"><img src="' + esc(u) + '" alt=""><span>' + esc(a.name || 'Untitled') + '</span></button>';
          }).join('') + '</div>';
          body.querySelectorAll('[data-nld-asset]').forEach(function (el) {
            el.addEventListener('click', function () {
              var aid = Number(el.getAttribute('data-nld-asset'));
              patch(blockId, { assetId: aid, baseAssetId: aid, overlays: [] });
              close();
            });
          });
        })
        .catch(function (err) {
          body.innerHTML = '<p style="font-size:13px;color:#b91c1c">' + esc(err.message) + '</p>';
        });
    }

    function uploadAsset(file) {
      // The workspace's own uploader when we are inside it — one code path for library writes, one
      // place where the moderation rejection is handled. The fallback keeps this component usable
      // on a page that does not load workspace.html.
      if (typeof window.gpUploadContentAsset === 'function') return window.gpUploadContentAsset(file);
      return fetch('/.netlify/functions/content-upload-url', {
        credentials: 'same-origin', method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, mimeType: file.type, fileSize: file.size }),
      }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not get an upload URL.'); return j; }); })
        .then(function (j) {
          var put = j.mock ? Promise.resolve() : fetch(j.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
            .then(function (r) { if (!r.ok) throw new Error('Upload failed.'); });
          return put.then(function () {
            return fetch('/.netlify/functions/content-assets', {
              credentials: 'same-origin', method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: file.name, assetType: 'image', mimeType: file.type, fileSize: file.size, storageKey: j.storageKey, storageUrl: j.storageUrl }),
            });
          });
        })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.rejected) throw new Error((d.asset && d.asset.rejectionReason) || 'That picture was flagged and could not be used.');
          return d.asset;
        });
    }

    // ── Text and stickers over a picture ──────────────────────────────────────
    //
    // ⚠️ Baked, not overlaid — see this file's header. The clean original is `baseAssetId`, and the
    // bake always starts from it, so editing the wording twice does not stack two copies of it.
    function openOverlays(blockId) {
      var e = find(blockId);
      if (!e || e.block.type !== 'image' || !e.block.assetId) return;
      if (!window.ImageOverlayEditor) { toast('The overlay editor is not available on this page.'); return; }

      var base = e.block.baseAssetId || e.block.assetId;
      toast('Opening the picture…');
      fetch('/.netlify/functions/get-post-image?assetId=' + encodeURIComponent(base), { credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not open that picture.'); return j; }); })
        .then(function (data) {
          // A data: URL, deliberately: canvas.toBlob() throws SecurityError on a cross-origin image,
          // and R2 presigned URLs are cross-origin. get-post-image fetches the bytes server-side for
          // exactly this reason.
          var dataUrl = data.dataUrl;
          if (!dataUrl) throw new Error('That file cannot have text added to it.');
          window.ImageOverlayEditor.open({
            imageUrl: dataUrl,
            overlays: e.block.overlays || [],
            onDone: function (overlays) {
              if (overlays == null) return;                       // cancelled
              if (!overlays.length) {
                // Everything removed: go back to the clean original rather than keeping a baked
                // copy that now looks identical but is a second, larger file.
                patch(blockId, { assetId: base, overlays: [] });
                return;
              }
              toast('Adding the text to the picture…');
              window.ImageOverlayEditor.bake(dataUrl, overlays)
                .then(function (blob) {
                  var file = new File([blob], 'newsletter-image.png', { type: 'image/png' });
                  return uploadAsset(file);
                })
                .then(function (asset) {
                  state.urls[asset.id] = asset.storageUrl || asset.externalUrl || '';
                  patch(blockId, { assetId: asset.id, baseAssetId: base, overlays: overlays });
                  toast('Added. Remember the alt text — a third of readers will only see that.');
                })
                .catch(function (err) { toast(err.message || 'Could not add the text to the picture.'); });
            },
          });
        })
        .catch(function (err) { toast(err.message || 'Could not open that picture.'); });
    }

    render();

    return {
      getDesign: function () { return state.design; },
      setDesign: function (d) { state.design = normalise(d); state.selected = null; render(); },
      setAssistantName: function (n) { state.assistantName = n || ''; },
      destroy: function () { host.innerHTML = ''; },
    };
  }

  window.NewsletterDesigner = { mount: mount, DEFAULT_THEME: DEFAULT_THEME, FONT_STACKS: FONT_STACKS };
})();
