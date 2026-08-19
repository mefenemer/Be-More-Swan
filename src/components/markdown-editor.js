/**
 * src/components/markdown-editor.js
 *
 * Autonomous Content Engine — US 1.2: block-segmented Markdown editor with sectional AI rewrite.
 *
 * The draft is split into ordered BLOCKS (paragraph/heading/list/quote/code) separated by blank
 * lines. Each block keeps its raw Markdown as the source of truth and is rendered with
 * marked + DOMPurify (the workspace.html pattern; a minimal escape-first fallback is used when
 * those globals are absent).
 *
 * AUTHORING: clicking a block opens a textarea over its raw Markdown — typing writes straight to
 * `raw`, so the author's own words, AI rewrites and inserted images all share one source of truth.
 * The block re-renders on blur (or Esc to revert / Cmd-Enter to commit); a blank line splits the
 * text into separate blocks, and clicking the space below the draft appends a new one.
 *
 * Highlighting text inside a rendered block opens a contextual toolbar
 * (Expand / Condense / Change Tone / Rewrite…). The chosen action calls
 * /.netlify/functions/rewrite-section for a replacement fragment, which is shown as a word-level
 * diff (Accept / Reject). Accepting splices the fragment into that block's raw Markdown and
 * re-renders ONLY that block — the rest of the document is untouched (AC3). Edits autosave via
 * /.netlify/functions/save-blog-draft.
 *
 * Usage:
 *   const ed = window.MarkdownEditor.mount({
 *     container,          // HTMLElement
 *     blogPostId,         // number — for rewrite + autosave
 *     initialMarkdown,    // string
 *     onChange,           // optional (markdown) => void — fires as the author types
 *     placeholder,        // optional string shown in an empty block
 *   });
 *   ed.getMarkdown();  ed.setMarkdown(md);  ed.focus();  ed.destroy();
 *
 * See docs/content-engine-epic-plan.md §10.
 */
(function () {
  'use strict';

  const REWRITE_URL = '/.netlify/functions/rewrite-section';
  const SAVE_URL = '/.netlify/functions/save-blog-draft';
  const AUTOSAVE_MS = 1200;

  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // DOMPurify's defaults already cover HTML5 media, but the blog directives depend on these
  // surviving, so name them rather than rely on a library default we don't control.
  // This is the editor's PREVIEW gate only — the security-critical gate is the server's
  // sanitize-html allowlist in markdown-render.ts, which is what freezes published_payload.
  const PURIFY_OPTS = {
    ADD_TAGS: ['video', 'audio', 'source'],
    ADD_ATTR: ['controls', 'preload', 'data-bms-asset', 'data-cols'],
  };

  // Render one block's Markdown to sanitised HTML. Prefer marked + DOMPurify when the host page
  // has loaded them (workspace.html does); otherwise fall back to escaped plain text.
  // `inst` is the directive-aware marked instance built in mount() — see makeMarked.
  function renderBlock(md, inst) {
    try {
      if (inst && window.DOMPurify) {
        const html = inst.parse(md, { gfm: true, breaks: false });
        return window.DOMPurify.sanitize(html, PURIFY_OPTS);
      }
    } catch (_) { /* fall through */ }
    return '<p>' + escapeHtml(md).replace(/\n/g, '<br>') + '</p>';
  }

  // An ISOLATED marked instance carrying the :::media / ::::columns extensions, so the preview is
  // parsed by the SAME tokenizer that renders the published snapshot (see
  // src/lib/marked-bms-directives.js and docs/blog-media-composition-plan.md §3.2). Registering on
  // the page-wide `marked` instead would leak blog directives into every other consumer.
  //
  // `resolveUrl` is passed HERE and nowhere on the server: the author needs a real src to see their
  // video, while the published payload must stay src-less so widget-api can resolve a fresh
  // presigned URL per read. The URL is preview state — it never reaches body_markdown.
  //
  // Returning null degrades the WHOLE editor to escaped plain text, not just media — so a host page
  // that forgets a <script> presents as "the features never shipped" rather than as a broken page,
  // which sends you hunting in the wrong half of the stack. Still degrade rather than throw, but
  // name the missing global so the next reader gets the answer from the console, not a bisect.
  function makeMarked(resolveUrl) {
    const missing = [];
    if (!window.marked) missing.push('marked');
    if (!window.BmsDirectives) missing.push('BmsDirectives (src/lib/marked-bms-directives.js)');
    if (missing.length) {
      console.warn('[MarkdownEditor] rendering as plain text — this page is missing: '
        + missing.join(', ') + '. Add the script tag(s); see workspace.html.');
      return null;
    }
    const Ctor = window.marked.Marked;
    if (!Ctor) {
      console.warn('[MarkdownEditor] rendering as plain text — window.marked has no Marked ctor.');
      return null;
    }
    try {
      return window.BmsDirectives.install(new Ctor(), { resolveUrl: resolveUrl });
    } catch (err) {
      // Fall back to escaped plain text rather than break the editor.
      console.error('[MarkdownEditor] directive install failed; rendering as plain text:', err);
      return null;
    }
  }

  // dataTransfer MIMEs. Module-scope and exported so a host wiring up a draggable picker uses the
  // same string the drop handler looks for — a typo'd MIME fails silently as "drag does nothing".
  const MEDIA_MIME = 'application/x-bms-media';   // a picker item    → JSON payload
  const BLOCK_MIME = 'application/x-bms-block';   // an existing block → its id (reorder)

  // Is this block nothing but media? Both shapes insertMedia can emit count: the `:::media`
  // directive, and the plain `![alt](asset://N)` it still uses for a captionless image (§3.1).
  //
  // Only these blocks become draggable. Text blocks must NOT be: `draggable=true` makes the browser
  // start a drag instead of a text selection, and drag-select is exactly the gesture the AI-rewrite
  // toolbar is built on — making every block draggable would silently disable it.
  // (Written as an alternation of two anchored patterns rather than one `(?:…)` group: the
  // directive's own leading `:::` reads as part of the group opener otherwise.)
  const MEDIA_BLOCK_RE = /^:::media\{|^!\[[^\]]*\]\(asset:\/\/\d+\)$/;
  function isMediaBlock(raw) {
    return MEDIA_BLOCK_RE.test(String(raw == null ? '' : raw).trim());
  }

  // A `::::columns` row is ONE block, however many blank lines its columns contain.
  const COLUMNS_OPEN_RE = /^::::columns\{/;
  const COLUMNS_CLOSE_RE = /^::::[ \t]*$/;
  const COLUMNS_BLOCK_RE = /^::::columns\{/;
  function isColumnsBlock(raw) {
    return COLUMNS_BLOCK_RE.test(String(raw == null ? '' : raw).trim());
  }

  // ── Formatting primitives ─────────────────────────────────────────────────────────────────────
  // Pure string→string, so the format bar's behaviour is locked by tests rather than by clicking
  // around a browser. Every one of these takes and returns raw MARKDOWN: the block's `raw` stays
  // the single source of truth, exactly as typing and AI rewrites do — a formatting button is just
  // another way to write the same characters the author could type by hand.

  // Italic is `_`, NOT `*`. With `*`, toggling italic on a selection sitting inside `**bold**`
  // matches the bold marker one character in, strips a single star, and silently turns bold into a
  // broken half-emphasis. `_` cannot collide with `**`, so the two toggles stay independent.
  //
  // Underline and highlight have NO Markdown syntax, so they are raw HTML pairs rather than a
  // symmetric marker. Both tags are on the server's sanitize-html allowlist in markdown-render.ts —
  // WITHOUT that they would render here and be stripped from published_payload, so the Studio would
  // show the author formatting their live post does not have. Never add an inline mark here without
  // checking that allowlist first.
  const INLINE_MARKS = {
    bold: '**', italic: '_', code: '`',
    underline: ['<u>', '</u>'],
    highlight: ['<mark>', '</mark>'],
  };
  const LINK_PLACEHOLDER = 'https://';

  // Clamp + order a (start,end) pair against the text. A textarea can hand back end < start after a
  // backwards drag-select, and every helper below indexes with these.
  function selRange(text, start, end) {
    const s = String(text == null ? '' : text);
    let a = Math.max(0, Math.min(s.length, start | 0));
    let b = Math.max(0, Math.min(s.length, end | 0));
    if (a > b) { const t = a; a = b; b = t; }
    return { s, a, b };
  }

  /**
   * Toggle an inline marker around the selection.
   *   → { text, selStart, selEnd }
   *
   * Three cases, in order: the selection sits INSIDE an existing pair (unwrap), the selection
   * INCLUDES the pair (strip), otherwise wrap. A collapsed caret wraps nothing and lands between
   * the two markers, so pressing B and typing gives bold text — the behaviour every editor has.
   */
  function toggleInlineMark(text, start, end, marker) {
    const { s, a, b } = selRange(text, start, end);
    // A plain string is a SYMMETRIC marker ('**'); an array is an asymmetric pair for the HTML
    // marks, whose closing tag differs from its opening one. Accepting both keeps every existing
    // caller — and the tests that pass INLINE_MARKS.bold straight in — working unchanged.
    const open = Array.isArray(marker) ? marker[0] : marker;
    const close = Array.isArray(marker) ? marker[1] : marker;
    const oLen = open.length;
    const cLen = close.length;

    if (a >= oLen && b + cLen <= s.length
        && s.slice(a - oLen, a) === open && s.slice(b, b + cLen) === close) {
      return {
        text: s.slice(0, a - oLen) + s.slice(a, b) + s.slice(b + cLen),
        selStart: a - oLen, selEnd: b - oLen,
      };
    }
    if (b - a >= oLen + cLen && s.slice(a, a + oLen) === open && s.slice(b - cLen, b) === close) {
      return {
        text: s.slice(0, a) + s.slice(a + oLen, b - cLen) + s.slice(b),
        selStart: a, selEnd: b - oLen - cLen,
      };
    }
    return {
      text: s.slice(0, a) + open + s.slice(a, b) + close + s.slice(b),
      selStart: a + oLen, selEnd: b + oLen,
    };
  }

  /**
   * Wrap the selection as a link, leaving the URL selected so it can be typed straight over.
   * An empty selection gets placeholder label text rather than `[](https://)`, which renders as
   * nothing at all and looks like the button did nothing.
   */
  function insertLink(text, start, end) {
    const { s, a, b } = selRange(text, start, end);
    const label = s.slice(a, b) || 'link text';
    const urlStart = a + 1 + label.length + 2;   // '[' + label + '](' 
    return {
      text: s.slice(0, a) + '[' + label + '](' + LINK_PLACEHOLDER + ')' + s.slice(b),
      selStart: urlStart, selEnd: urlStart + LINK_PLACEHOLDER.length,
    };
  }

  // Every line prefix the block-type control owns. Anchored and applied per line, so switching type
  // REPLACES the old prefix instead of stacking (`> - ## text` is what naive prepending produces).
  const BLOCK_PREFIX_RE = /^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/;
  function stripBlockPrefix(line) { return String(line).replace(BLOCK_PREFIX_RE, ''); }

  /** The type currently in force, read off the FIRST line — what the select should show. */
  function detectBlockType(raw) {
    const first = String(raw == null ? '' : raw).split('\n')[0] || '';
    const h = first.match(/^(#{1,6})\s/);
    if (h) return 'h' + h[1].length;
    if (/^>\s?/.test(first)) return 'quote';
    if (/^[-*+]\s/.test(first)) return 'ul';
    if (/^\d+[.)]\s/.test(first)) return 'ol';
    return 'p';
  }

  /**
   * Rewrite a block's raw Markdown as `type` ('p' | 'h1'..'h6' | 'quote' | 'ul' | 'ol').
   * Never call this on a media or columns block — their raw is a directive, and stripping "prefixes"
   * off it would corrupt the layout. The bar disables the control for those instead.
   */
  function setBlockType(raw, type) {
    const bare = String(raw == null ? '' : raw).split('\n').map(stripBlockPrefix);
    if (type === 'quote') return bare.map((l) => '> ' + l).join('\n');
    if (type === 'ul') return bare.map((l) => '- ' + l).join('\n');
    if (type === 'ol') return bare.map((l, i) => (i + 1) + '. ' + l).join('\n');
    const h = /^h([1-6])$/.exec(String(type));
    // A heading is one line by definition — a three-line block becomes ONE heading, not three.
    if (h) return '#'.repeat(Number(h[1])) + ' ' + bare.join(' ').trim();
    return bare.join('\n');
  }

  // Build the Markdown for one media item.
  //
  // A plain image with no caption stays plain `![alt](asset://N)` — the `:::media` directive is for
  // what Markdown CANNOT express (video, audio, a caption), so existing drafts need no migration
  // and stay byte-identical (plan §3.1).
  //
  //   media: { assetId, type?: 'image'|'video'|'audio', url?, alt?, caption?, align? }
  function mediaRaw(media) {
    const type = media.type === 'video' || media.type === 'audio' ? media.type : 'image';
    const alt = String(media.alt || '').replace(/[[\]]/g, '');
    // The attribute grammar is `key="value"` — a quote, brace or newline in author text would
    // break out of it, so drop those rather than emit a directive that won't re-parse.
    const clean = (v) => String(v || '').replace(/["}\r\n]/g, '').trim();
    const caption = clean(media.caption);

    if (type === 'image' && !caption) return '![' + alt + '](asset://' + media.assetId + ')';
    return ':::media{asset=' + media.assetId + ' type=' + type
      + (alt ? ' alt="' + clean(alt) + '"' : '')
      + (caption ? ' caption="' + caption + '"' : '')
      + (media.align ? ' align=' + clean(media.align) : '')
      + '}';
  }

  // Append Markdown to the end of the Nth column's body within a `::::columns` raw string.
  // Returns the new raw, or null if there is no such column (never a half-edited string).
  //
  // A columns row is one opaque block, so a drop into a column is a text edit rather than a tree
  // operation. The pattern deliberately mirrors the tokenizer's own (marked-bms-directives.js) —
  // if the two drift, the editor writes something the server won't parse back and the preview
  // starts lying about what publishes.
  const COLUMN_BODY_RE = /(:::column[ \t]*\n)([\s\S]*?)(\n:::[ \t]*)(?=\n|$)/g;

  // The prose a brand-new column is seeded with. An empty `.bms-column` has no height, so a blank
  // grid renders as nothing at all and the buttons read as broken — but the seed must then get out
  // of the way the moment real content lands, or every filled column keeps a stray instruction
  // line above it. isColumnSeed() is the test for "still untouched".
  const COLUMN_SEED = 'Drop text or an image here.';
  function isColumnSeed(body) { return body.trim() === COLUMN_SEED; }

  function spliceColumnRaw(raw, colIndex, md) {
    let i = 0;
    let hit = false;
    const next = String(raw).replace(COLUMN_BODY_RE, function (m, open, body, close) {
      if (i++ !== colIndex) return m;
      hit = true;
      // Replace the seed rather than append below it; keep real content and append after it.
      const keep = body.trim() && !isColumnSeed(body) ? body + '\n\n' : '';
      return open + keep + md + close;
    });
    return hit ? next : null;
  }

  // Split Markdown into blocks on blank lines, but keep fenced code blocks — and column
  // containers — intact.
  //
  // Blank lines are the block separator, and a column holds ordinary Markdown, which means it holds
  // blank lines. Without the depth counter a two-paragraph column gets shredded into loose
  // top-level blocks and the `::::columns` fence is stranded on its own — the layout is destroyed
  // just by loading the draft (plan §3.6). Only `::::` counts: the tokenizer is deliberately
  // non-recursive, so the inner `:::column` markers never nest.
  function splitBlocks(md) {
    const lines = String(md == null ? '' : md).replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let buf = [];
    let inFence = false;
    let depth = 0;
    const flush = () => {
      const raw = buf.join('\n').trim();
      if (raw) blocks.push(raw);
      buf = [];
    };
    for (const line of lines) {
      if (/^\s*```/.test(line)) inFence = !inFence;
      else if (!inFence) {
        if (COLUMNS_OPEN_RE.test(line)) depth++;
        else if (COLUMNS_CLOSE_RE.test(line) && depth > 0) depth--;
      }
      if (!inFence && !depth && line.trim() === '') { flush(); continue; }
      buf.push(line);
    }
    flush();
    return blocks.length ? blocks : [''];
  }

  let uidCounter = 0;
  const uid = () => 'blk_' + (++uidCounter);

  // --- Minimal word-level diff (LCS) for the accept/reject preview -----------------------------
  function wordDiff(oldStr, newStr) {
    const a = oldStr.split(/(\s+)/), b = newStr.split(/(\s+)/);
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ t: 'same', v: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', v: a[i] }); i++; }
      else { out.push({ t: 'add', v: b[j] }); j++; }
    }
    while (i < n) out.push({ t: 'del', v: a[i++] });
    while (j < m) out.push({ t: 'add', v: b[j++] });
    return out;
  }

  function diffHtml(oldStr, newStr) {
    return wordDiff(oldStr, newStr).map((p) => {
      const safe = escapeHtml(p.v);
      if (p.t === 'add') return '<ins class="bmsme-add">' + safe + '</ins>';
      if (p.t === 'del') return '<del class="bmsme-del">' + safe + '</del>';
      return safe;
    }).join('');
  }

  const STYLE_ID = 'bms-markdown-editor-styles';
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      .bmsme-root { position: relative; min-height: 120px; cursor: text; }
      /* Every block reserves a left gutter for its drag handle. Without the gutter the handle
         would either overlap the first word or hang outside the editor's padding box. */
      .bmsme-block { position: relative; padding: 2px 4px 2px 26px; border-radius: 4px; }
      .bmsme-block:hover { background: rgba(0,0,0,0.02); }
      /* The typeface the reader will actually get. Applied by setFontFamily() from the Studio's
         Font family picker, so choosing a font reformats the draft instead of only changing a
         setting nobody can see. Scoped to blocks: the format bar is chrome and stays system-UI. */
      .bmsme-block, .bmsme-block .bmsme-input { font-family: var(--bmsme-font, inherit); }
      /* Drag handle. EVERY block gets one, not just media: dragging a paragraph into a column is
         the only way to fill a column layout, and a block with no visible grip reads as immovable.
         The handle carries draggable=true rather than the block itself — draggable on the block
         kills text selection inside it, which the AI-rewrite toolbar depends on. */
      .bmsme-handle { position:absolute; left:2px; top:3px; width:18px; height:18px; display:flex;
        align-items:center; justify-content:center; border-radius:4px; cursor:grab;
        color:#9ca3af; font-size:13px; line-height:1; letter-spacing:-2px; user-select:none;
        opacity:0; transition:opacity .12s ease; background:#fff; border:1px solid #e5e7eb; }
      .bmsme-block:hover .bmsme-handle, .bmsme-handle:focus { opacity:1; }
      .bmsme-handle:hover { color:#ec4899; border-color:#f9a8d4; }
      .bmsme-handle:active { cursor:grabbing; }
      /* Click-to-edit: the block swaps its rendered HTML for a textarea over its raw Markdown. */
      .bmsme-editing { background: rgba(236,72,153,.04); box-shadow: inset 0 0 0 1px #fbcfe8; }
      .bmsme-input { display:block; width:100%; border:0; outline:0; padding:0; margin:0;
        font: inherit; color: inherit; background: transparent; resize: none; overflow: hidden;
        line-height: 1.6; }
      .bmsme-placeholder { color:#9ca3af; margin:0; }
      /* Typography for RENDERED blocks.
         ⚠️ Not cosmetic. The editor is mounted inside pages that load a Tailwind build, and its
         preflight reset flattens headings to the body size and weight — measured: an <h1> in a
         block computed to 16px/400, identical to the <p> beside it. So picking "Heading 2" in the
         format bar changed the Markdown correctly and changed NOTHING on screen, which reads as
         the control being broken.
         These rules are scoped to .bmsme-block so they cannot leak into the host page, and they
         mirror the shapes widget.js and blog-seo.ts publish — the preview should not lie about
         what the reader will get. Sized in em so everything tracks the host's base size.
         (No backticks in this comment — the whole block is a JS template literal.) */
      .bmsme-block h1, .bmsme-block h2, .bmsme-block h3,
      .bmsme-block h4, .bmsme-block h5, .bmsme-block h6 {
        font-weight:700; line-height:1.25; margin:.6em 0 .3em; color:#111827; }
      .bmsme-block h1 { font-size:1.75em; }
      .bmsme-block h2 { font-size:1.4em; }
      .bmsme-block h3 { font-size:1.2em; }
      .bmsme-block h4 { font-size:1.05em; }
      .bmsme-block h5, .bmsme-block h6 { font-size:1em; }
      .bmsme-block p { margin:.5em 0; }
      .bmsme-block strong, .bmsme-block b { font-weight:700; }
      .bmsme-block em, .bmsme-block i { font-style:italic; }
      .bmsme-block u { text-decoration:underline; }
      .bmsme-block mark { background:#fef08a; color:inherit; padding:0 2px; border-radius:2px; }
      .bmsme-block a { color:#ec4899; text-decoration:underline; }
      .bmsme-block blockquote { margin:.5em 0; padding-left:12px; border-left:3px solid #e5e7eb;
        color:#4b5563; font-style:italic; }
      /* list-style-type as well as position: preflight sets list-style:none on ul/ol, so padding
         alone would indent the items and still show no bullets. */
      .bmsme-block ul { list-style:disc outside; padding-left:1.4em; margin:.5em 0; }
      .bmsme-block ol { list-style:decimal outside; padding-left:1.6em; margin:.5em 0; }
      .bmsme-block li { margin:.15em 0; }
      .bmsme-block code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em;
        background:#f3f4f6; padding:1px 4px; border-radius:4px; }
      .bmsme-block pre { background:#111827; color:#e5e7eb; padding:12px; border-radius:8px;
        overflow-x:auto; margin:.5em 0; }
      .bmsme-block pre code { background:transparent; color:inherit; padding:0; }
      .bmsme-block hr { border:0; border-top:1px solid #e5e7eb; margin:1em 0; }
      /* Inline media preview. Mirrors widget.js's rules so the author sees roughly the shape they
         will publish — same reasoning as sharing the tokenizer: the preview shouldn't lie. */
      .bmsme-block img, .bmsme-block video { max-width:100%; height:auto; border-radius:8px; display:block; }
      .bmsme-block audio { width:100%; display:block; margin:8px 0; }
      .bmsme-block figure { margin:12px 0; }
      .bmsme-block figcaption { font-size:13px; color:#6b7280; margin-top:6px; }
      .bmsme-block .bms-columns { display:grid; gap:16px; margin:12px 0;
        grid-template-columns:repeat(2,minmax(0,1fr)); }
      .bmsme-block .bms-columns[data-cols="3"] { grid-template-columns:repeat(3,minmax(0,1fr)); }
      @media (max-width:640px) { .bmsme-block .bms-columns,
        .bmsme-block .bms-columns[data-cols="3"] { grid-template-columns:minmax(0,1fr); } }
      /* Formatting bar — light, in normal flow at the top of the draft, so it is visible before
         the author does anything. Deliberately NOT the dark floating pill: that one is the AI
         toolbar, and the two doing different jobs should not look like the same control. */
      .bmsme-formatbar { display:flex; align-items:center; gap:4px; flex-wrap:wrap;
        padding:6px; margin:0 0 10px; border:1px solid #e5e7eb; border-radius:10px;
        background:#fff; }
      .bmsme-fb-select { font:inherit; font-size:13px; padding:4px 6px; border:1px solid #d1d5db;
        border-radius:6px; background:#fff; color:#111827; cursor:pointer; }
      .bmsme-fb-btn { font:inherit; font-size:13px; min-width:30px; padding:4px 8px; border:0;
        border-radius:6px; background:transparent; color:#374151; cursor:pointer; }
      .bmsme-fb-btn:hover { background:#f3f4f6; }
      .bmsme-fb-bold { font-weight:800; }
      .bmsme-fb-italic { font-style:italic; }
      .bmsme-fb-underline { text-decoration:underline; }
      .bmsme-fb-highlight { background:#fef08a; }
      .bmsme-fb-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
      .bmsme-fb-sep { width:1px; height:18px; background:#e5e7eb; margin:0 2px; }
      .bmsme-formatbar [disabled] { opacity:.4; cursor:not-allowed; }
      .bmsme-formatbar [disabled]:hover { background:transparent; }
      .bmsme-toolbar { position: absolute; z-index: 40; display: flex; gap: 4px;
        background: #111827; color: #fff; padding: 4px; border-radius: 8px;
        box-shadow: 0 6px 24px rgba(0,0,0,.25); font-size: 13px; }
      .bmsme-toolbar button { background: transparent; color: #fff; border: 0; padding: 4px 8px;
        border-radius: 6px; cursor: pointer; white-space: nowrap; }
      .bmsme-toolbar button:hover { background: rgba(255,255,255,.15); }
      .bmsme-menu { position: absolute; z-index: 41; background: #111827; color:#fff;
        border-radius: 8px; padding: 4px; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
      .bmsme-menu button { display:block; width:100%; text-align:left; background:transparent;
        color:#fff; border:0; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:13px; }
      .bmsme-menu button:hover { background: rgba(255,255,255,.15); }
      .bmsme-diff { border:1px solid #e5e7eb; border-radius:8px; padding:12px; margin-top:6px; background:#fff; }
      .bmsme-add { background:#dcfce7; text-decoration:none; }
      .bmsme-del { background:#fee2e2; }
      .bmsme-diff-actions { margin-top:8px; display:flex; gap:8px; }
      .bmsme-diff-actions button { padding:6px 12px; border-radius:6px; border:0; cursor:pointer; font-size:13px; }
      .bmsme-accept { background:#ec4899; color:#fff; }
      .bmsme-reject { background:#e5e7eb; color:#111827; }
      .bmsme-busy { opacity:.6; pointer-events:none; }
      .bmsme-skeleton { color:#6b7280; font-style:italic; padding:8px 4px; }
      /* Drag-and-drop (plan §4 Phase 3). The insertion point is drawn as a floating line rather
         than by rendering real drop-zone nodes between blocks: permanent nodes would sit in the
         click/selection path and change layout even when nobody is dragging. */
      .bmsme-dropline { position:absolute; left:0; right:0; height:2px; background:#ec4899;
        border-radius:2px; pointer-events:none; display:none; z-index:42; }
      .bmsme-dropline::before { content:''; position:absolute; left:-3px; top:-3px; width:8px;
        height:8px; border-radius:50%; background:#ec4899; }
      .bmsme-droppending { position:absolute; left:8px; z-index:43; background:#111827; color:#fff;
        font-size:12px; padding:3px 10px; border-radius:10px; pointer-events:none; display:none; }
      /* Media blocks stay draggable by their whole body (there is no text to select in them);
         everything else is dragged by its handle. */
      .bmsme-block[draggable="true"] { cursor:grab; }
      .bmsme-block[draggable="true"]:active { cursor:grabbing; }
      .bmsme-dragging { opacity:.4; }
      /* A freshly inserted column layout, flashed so the author can see WHERE it landed — the
         complaint about the Columns buttons was never that they did nothing, it was that the new
         row appeared below the fold with no indication it was the thing that had just appeared. */
      .bmsme-flash { animation: bmsme-flash 1.1s ease-out 1; }
      @keyframes bmsme-flash {
        0% { box-shadow: 0 0 0 3px rgba(236,72,153,.45); background: rgba(236,72,153,.08); }
        100% { box-shadow: 0 0 0 3px rgba(236,72,153,0); background: transparent; }
      }
      /* A drop aimed inside a column targets that column, not a gap between blocks — so it gets an
         outline instead of the insertion line. */
      .bmsme-colhint { outline:2px dashed #ec4899; outline-offset:3px; border-radius:4px; }
    `;
    const el = document.createElement('style');
    el.id = STYLE_ID; el.textContent = css;
    document.head.appendChild(el);
  }

  function mount(opts) {
    // `onDropMedia(payload) → media | media[] | null` turns something the author dropped into an
    // ATTACHED asset. It is a host hook rather than editor code on purpose: attaching means
    // blog-media / uploadContentAsset, which are Blog Studio concerns — this component stays a
    // generic Markdown editor and never learns the blog's endpoints.
    const { container, blogPostId, initialMarkdown = '', onChange, onDropMedia } = opts || {};
    const placeholder = (opts && opts.placeholder) || 'Write your post… (Markdown supported)';
    if (!container) throw new Error('MarkdownEditor.mount: container is required');
    injectStyles();

    let blocks = splitBlocks(initialMarkdown).map((raw) => ({ id: uid(), raw }));
    let saveTimer = null;
    let destroyed = false;
    // assetId → display URL, for previewing inline images stored as ![alt](asset://N). The raw
    // Markdown keeps the stable asset:// ref (the source of truth); widget-api resolves a fresh
    // URL at publish/read time. Here we swap in the known URL so the author sees the real image.
    const assetUrls = Object.create(null);
    Object.assign(assetUrls, opts.assetUrls || {});
    const applyAssetUrls = (raw) =>
        String(raw).replace(/asset:\/\/(\d+)/g, (m, id) => (assetUrls[id] != null ? assetUrls[id] : m));

    // Directive media (`:::media{asset=N}`) carries a bare id, not an `asset://N` URL, so
    // applyAssetUrls can't reach it — the renderer asks for the preview URL through this instead.
    const mdInst = makeMarked((assetId) => assetUrls[assetId] || null);

    const root = document.createElement('div');
    root.className = 'bmsme-root';
    container.innerHTML = '';
    container.appendChild(root);

    const toolbar = document.createElement('div');
    toolbar.className = 'bmsme-toolbar';
    toolbar.style.display = 'none';
    root.appendChild(toolbar);

    // ── Formatting bar ───────────────────────────────────────────────────────────────────────────
    // Always visible, sitting above the draft. The Studio previously offered NO way to format text:
    // the only toolbar was the AI one (Expand / Condense / Tone / Rewrite…), which appears on a
    // selection and REWRITES words rather than marking them up. Bold, headings, quotes and lists
    // were reachable only by typing raw Markdown — which the placeholder mentions and nobody reads.
    //
    // It writes Markdown into the block's `raw`, the same place typing and AI rewrites write, so
    // there is still exactly one source of truth and nothing new to serialise.
    //
    // Actions target the block open for editing, or the last one that was (`formatTargetId`). With
    // no target at all, a click starts a fresh block at the end — so no button is ever inert.
    const BLOCK_TYPES = [
      ['p', 'Paragraph'],
      ['h1', 'Heading 1'],
      ['h2', 'Heading 2'],
      ['h3', 'Heading 3'],
      ['h4', 'Heading 4'],
      ['quote', 'Quote'],
      ['ul', 'Bulleted list'],
      ['ol', 'Numbered list'],
    ];
    const BLOCK_TYPE_KEYS = new Set(BLOCK_TYPES.map((t) => t[0]));
    let formatTargetId = null;

    const formatBar = document.createElement('div');
    formatBar.className = 'bmsme-formatbar';
    formatBar.setAttribute('role', 'toolbar');
    formatBar.setAttribute('aria-label', 'Text formatting');

    const typeSel = document.createElement('select');
    typeSel.className = 'bmsme-fb-select';
    typeSel.setAttribute('aria-label', 'Paragraph style');
    BLOCK_TYPES.forEach(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      typeSel.appendChild(o);
    });
    formatBar.appendChild(typeSel);

    const fbButtons = [];
    function fbButton(label, title, run, extraClass) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bmsme-fb-btn' + (extraClass ? ' ' + extraClass : '');
      btn.textContent = label;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      // mousedown + preventDefault, NOT click: a click blurs the textarea first, blur commits the
      // edit and destroys the selection, so the mark would land on nothing at all.
      btn.addEventListener('mousedown', (e) => { e.preventDefault(); run(); });
      formatBar.appendChild(btn);
      fbButtons.push(btn);
      return btn;
    }
    function fbSeparator() {
      const sep = document.createElement('span');
      sep.className = 'bmsme-fb-sep';
      sep.setAttribute('aria-hidden', 'true');
      formatBar.appendChild(sep);
    }

    fbSeparator();
    fbButton('B', 'Bold (Ctrl/Cmd+B)', () => applyInlineMark(INLINE_MARKS.bold), 'bmsme-fb-bold');
    fbButton('I', 'Italic (Ctrl/Cmd+I)', () => applyInlineMark(INLINE_MARKS.italic), 'bmsme-fb-italic');
    fbButton('U', 'Underline (Ctrl/Cmd+U)', () => applyInlineMark(INLINE_MARKS.underline), 'bmsme-fb-underline');
    fbButton('H', 'Highlight', () => applyInlineMark(INLINE_MARKS.highlight), 'bmsme-fb-highlight');
    fbButton('Link', 'Insert link (Ctrl/Cmd+K)', () => applyInline(insertLink));
    fbButton('Code', 'Inline code', () => applyInlineMark(INLINE_MARKS.code), 'bmsme-fb-code');
    root.appendChild(formatBar);

    // The textarea every inline action needs. Opens one if the author hasn't clicked into the draft
    // yet, or has clicked away since, so B / I / Link always do something visible.
    function ensureEditing() {
      if (editing) return editing;
      if (formatTargetId) {
        const el = root.querySelector('.bmsme-block[data-block-id="' + formatTargetId + '"]');
        if (el) {
          enterEdit(el, formatTargetId);
          if (editing) return editing;
        }
      }
      appendBlockAndEdit();
      return editing;
    }

    /** Run a (text, start, end) → { text, selStart, selEnd } transform against the open textarea. */
    function applyInline(transform) {
      const target = ensureEditing();
      if (!target) return;
      const b = blocks.find((x) => x.id === target.blockId);
      // A media/columns block's raw is a directive, not prose — marking it up would corrupt it.
      if (!b || isMediaBlock(b.raw) || isColumnsBlock(b.raw)) return;
      const ta = target.textarea;
      const out = transform(ta.value, ta.selectionStart, ta.selectionEnd);
      ta.value = out.text;
      ta.setSelectionRange(out.selStart, out.selEnd);
      // Assigning .value fires NO `input` event, so mirror what that handler does by hand. Without
      // this the block keeps its pre-format raw and the whole edit is discarded on blur.
      b.raw = ta.value;
      autosize(ta);
      ta.focus();
      scheduleSave();
    }
    function applyInlineMark(marker) {
      applyInline((text, a, b) => toggleInlineMark(text, a, b, marker));
    }

    typeSel.addEventListener('change', () => {
      const type = typeSel.value;
      const id = (editing && editing.blockId) || formatTargetId;
      // A <select> takes focus, which blurs the textarea and commits the edit — so by the time
      // `change` fires there is no open editor to work through. commitEdit may also SPLIT or drop
      // the block, so the target is resolved after it, never before.
      commitEdit();
      let b = id ? blocks.find((x) => x.id === id) : null;
      if (!b) { b = { id: uid(), raw: '' }; blocks.push(b); }
      if (isMediaBlock(b.raw) || isColumnsBlock(b.raw)) { syncFormatBar(); return; }
      b.raw = setBlockType(b.raw, type);
      formatTargetId = b.id;
      renderAll();
      scheduleSave();
      const el = root.querySelector('.bmsme-block[data-block-id="' + b.id + '"]');
      if (el) enterEdit(el, b.id);
    });

    // Reflect what the bar would act on, and lock it while a media/columns block is open.
    // h5/h6 aren't offered (a blog body that deep is pathological); such a block simply shows
    // Paragraph until the author picks something, and picking is what rewrites it — never this.
    function syncFormatBar() {
      const active = editing ? blocks.find((x) => x.id === editing.blockId) : null;
      const locked = !!(active && (isMediaBlock(active.raw) || isColumnsBlock(active.raw)));
      formatBar.classList.toggle('bmsme-fb-locked', locked);
      typeSel.disabled = locked;
      fbButtons.forEach((btn) => { btn.disabled = locked; });
      if (active && !locked) formatTargetId = active.id;

      const shown = (active && !locked) ? active : blocks.find((x) => x.id === formatTargetId);
      const type = (shown && !isMediaBlock(shown.raw) && !isColumnsBlock(shown.raw))
        ? detectBlockType(shown.raw) : 'p';
      typeSel.value = BLOCK_TYPE_KEYS.has(type) ? type : 'p';
    }

    let activeMenu = null;
    let currentSel = null; // { blockId, text }
    let editing = null;    // { blockId, textarea, prevRaw } while a block is open for typing

    function getMarkdown() { return blocks.map((b) => b.raw).join('\n\n'); }

    // An empty block still needs something clickable, or an empty draft would be a dead surface
    // with no way in. The placeholder is chrome, never content — it is not part of the Markdown.
    function blockHtml(b) {
      return b.raw.trim()
        ? renderBlock(applyAssetUrls(b.raw), mdInst)
        : '<p class="bmsme-placeholder">' + escapeHtml(placeholder) + '</p>';
    }

    // Fill a block node with its rendered HTML AND its drag handle. Every path that rewrites a
    // block's innerHTML must come through here: renderOneBlock used to assign innerHTML directly,
    // which silently ate the handle and left that one block ungrabbable until the next full render.
    function paintBlock(el, b) {
      el.innerHTML = blockHtml(b);
      const handle = document.createElement('span');
      handle.className = 'bmsme-handle';
      handle.setAttribute('draggable', 'true');
      handle.setAttribute('aria-hidden', 'true');
      handle.title = 'Drag to move this section — including into a column';
      handle.textContent = '\u22EE\u22EE';   // a two-column grip
      el.appendChild(handle);
      if (isMediaBlock(b.raw)) {
        el.setAttribute('draggable', 'true');
        // img/video are draggable by default, and that native drag would win over the wrapper's —
        // handing the drop a URL/file payload instead of our block id, so a reorder would read as
        // an external insert and duplicate the media.
        el.querySelectorAll('img, video, audio, a').forEach((n) => { n.draggable = false; });
      } else if (isColumnsBlock(b.raw)) {
        // Media inside a column isn't a block of its own, so there's nothing to reorder — stop
        // its native image drag from starting a drag the drop handler would only ignore.
        el.querySelectorAll('img, video, audio').forEach((n) => { n.draggable = false; });
      }
    }

    function renderAll() {
      // A re-render mid-edit (setAssetUrls, an image insert) must not orphan the open textarea:
      // leaving `editing` pointing at a detached node wedges enterEdit's same-block guard shut and
      // the draft silently stops accepting clicks. Carry the edit across the render instead.
      const open = editing ? {
        id: editing.blockId, value: editing.textarea.value,
        start: editing.textarea.selectionStart, end: editing.textarea.selectionEnd,
      } : null;
      editing = null;

      // Remove existing block nodes (keep toolbar).
      Array.from(root.querySelectorAll('.bmsme-block')).forEach((n) => n.remove());
      for (const b of blocks) {
        const el = document.createElement('div');
        el.className = 'bmsme-block';
        el.setAttribute('data-block-id', b.id);
        paintBlock(el, b);
        root.appendChild(el);
      }

      if (open && blocks.some((b) => b.id === open.id)) {
        const el = root.querySelector('.bmsme-block[data-block-id="' + open.id + '"]');
        if (el) {
          enterEdit(el, open.id);
          if (editing) {
            editing.textarea.value = open.value;
            editing.textarea.setSelectionRange(open.start, open.end);
            autosize(editing.textarea);
          }
        }
      }
    }

    function renderOneBlock(blockId) {
      const b = blocks.find((x) => x.id === blockId);
      const el = root.querySelector('.bmsme-block[data-block-id="' + blockId + '"]');
      if (b && el) { el.classList.remove('bmsme-editing'); paintBlock(el, b); }
    }

    function scheduleSave() {
      if (typeof onChange === 'function') { try { onChange(getMarkdown()); } catch (_) {} }
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(save, AUTOSAVE_MS);
    }

    async function save() {
      if (destroyed || !blogPostId) return;
      try {
        await fetch(SAVE_URL, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: blogPostId, bodyMarkdown: getMarkdown() }),
        });
      } catch (_) { /* transient; next edit retries */ }
    }

    function hideChrome() {
      toolbar.style.display = 'none';
      if (activeMenu) { activeMenu.remove(); activeMenu = null; }
    }

    // ── Authoring: click a block to type into its raw Markdown ───────────────────────────────────
    // The block's `raw` stays the source of truth, so typing, AI rewrites and image inserts all
    // write to the same place. Typing updates `raw` live (so onChange/autosave fire as you go) and
    // the block re-renders on blur.
    function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

    function commitEdit() {
      if (!editing) return;
      const { blockId, textarea } = editing;
      editing = null;                       // clear first: blur handlers must not re-enter
      const b = blocks.find((x) => x.id === blockId);
      if (!b) { renderAll(); return; }
      b.raw = textarea.value.trim();

      // A blank line means the author started a new paragraph — re-split so each becomes its own
      // block (blocks are the unit the AI rewrite works on).
      const parts = splitBlocks(b.raw).filter((p) => p.trim());
      const at = blocks.findIndex((x) => x.id === blockId);
      if (parts.length > 1) {
        blocks.splice(at, 1, ...parts.map((raw) => ({ id: uid(), raw })));
      } else if (!parts.length && blocks.length > 1) {
        blocks.splice(at, 1);               // emptied — drop it, unless it's the only block left
      }
      renderAll();
      scheduleSave();
      syncFormatBar();
    }

    function enterEdit(blockEl, blockId) {
      if (editing && editing.blockId === blockId) return;
      commitEdit();
      const b = blocks.find((x) => x.id === blockId);
      if (!b) return;
      // Re-resolve the node: commitEdit above may have re-rendered every block.
      const el = root.querySelector('.bmsme-block[data-block-id="' + blockId + '"]') || blockEl;
      if (!el) return;
      hideChrome();

      const ta = document.createElement('textarea');
      ta.className = 'bmsme-input';
      ta.value = b.raw;
      ta.setAttribute('aria-label', 'Edit section');
      el.innerHTML = '';
      el.classList.add('bmsme-editing');
      el.appendChild(ta);
      editing = { blockId, textarea: ta, prevRaw: b.raw };

      ta.addEventListener('input', () => {
        autosize(ta);
        b.raw = ta.value;   // keep getMarkdown() live so onChange (word count) tracks typing
        scheduleSave();
      });
      ta.addEventListener('blur', commitEdit);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); b.raw = editing ? editing.prevRaw : b.raw; ta.value = b.raw; ta.blur(); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.blur(); }
        // The shortcuts every writer already has in their fingers. Alt is excluded so this can't
        // swallow an OS-level combination the browser owns.
        else if ((e.metaKey || e.ctrlKey) && !e.altKey) {
          const k = String(e.key).toLowerCase();
          if (k === 'b') { e.preventDefault(); applyInlineMark(INLINE_MARKS.bold); }
          else if (k === 'i') { e.preventDefault(); applyInlineMark(INLINE_MARKS.italic); }
          // preventDefault matters here beyond consistency: the browser's own Ctrl+U is
          // "view source" in some builds, and in a contenteditable it inserts its own <u>.
          else if (k === 'u') { e.preventDefault(); applyInlineMark(INLINE_MARKS.underline); }
          else if (k === 'k') { e.preventDefault(); applyInline(insertLink); }
        }
      });
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      autosize(ta);
      syncFormatBar();
    }

    function appendBlockAndEdit() {
      commitEdit();
      const last = blocks[blocks.length - 1];
      // Reuse a trailing empty block rather than stacking up more of them.
      if (last && !last.raw.trim()) {
        const el = root.querySelector('.bmsme-block[data-block-id="' + last.id + '"]');
        if (el) return enterEdit(el, last.id);
      }
      const block = { id: uid(), raw: '' };
      blocks.push(block);
      renderAll();
      const el = root.querySelector('.bmsme-block[data-block-id="' + block.id + '"]');
      if (el) enterEdit(el, block.id);
    }

    function onRootClick(e) {
      // A drag-select fires a click too — let the AI-rewrite toolbar have it instead of swallowing
      // the selection by dropping into edit mode.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && String(sel).trim()) return;
      if (e.target.closest && e.target.closest('.bmsme-diff, .bmsme-toolbar, .bmsme-menu')) return;
      // The handle is a grip. Clicking it must not open the block for typing, or a mis-aimed drag
      // would dump the author into a textarea instead of moving anything.
      if (e.target.closest && e.target.closest('.bmsme-handle')) return;
      const blockEl = e.target.closest && e.target.closest('.bmsme-block');
      if (blockEl) {
        if (blockEl.querySelector('.bmsme-diff')) return;   // a rewrite is awaiting Accept/Reject
        enterEdit(blockEl, blockEl.getAttribute('data-block-id'));
        return;
      }
      if (e.target === root) appendBlockAndEdit();           // clicking the empty space below
    }

    function onSelect() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { hideChrome(); return; }
      const text = sel.toString().trim();
      if (!text) { hideChrome(); return; }
      // Which block does the selection anchor sit in?
      let node = sel.getRangeAt(0).startContainer;
      let blockEl = node.nodeType === 1 ? node : node.parentElement;
      blockEl = blockEl && blockEl.closest ? blockEl.closest('.bmsme-block') : null;
      if (!blockEl || !root.contains(blockEl)) { hideChrome(); return; }

      currentSel = { blockId: blockEl.getAttribute('data-block-id'), text };

      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      toolbar.innerHTML = '';
      [['Expand', 'expand'], ['Condense', 'condense'], ['Change Tone', 'tone'], ['Rewrite…', 'custom']]
        .forEach(([label, action]) => {
          const btn = document.createElement('button');
          btn.textContent = label;
          btn.addEventListener('mousedown', (e) => { e.preventDefault(); onAction(action, btn); });
          toolbar.appendChild(btn);
        });
      toolbar.style.display = 'flex';
      toolbar.style.top = (rect.top - rootRect.top - 40) + 'px';
      toolbar.style.left = Math.max(0, rect.left - rootRect.left) + 'px';
    }

    function onAction(action, anchorBtn) {
      if (action === 'tone') return openToneMenu(anchorBtn);
      if (action === 'custom') {
        const instruction = window.prompt('How should the AI rewrite the selection?');
        if (!instruction) return;
        return runRewrite('custom', { instruction });
      }
      return runRewrite(action, {});
    }

    function openToneMenu(anchorBtn) {
      if (activeMenu) activeMenu.remove();
      const menu = document.createElement('div');
      menu.className = 'bmsme-menu';
      ['Professional', 'Casual', 'Confident', 'Friendly'].forEach((tone) => {
        const btn = document.createElement('button');
        btn.textContent = tone;
        btn.addEventListener('mousedown', (e) => { e.preventDefault(); runRewrite('tone', { tone: tone.toLowerCase() }); });
        menu.appendChild(btn);
      });
      root.appendChild(menu);
      const bRect = anchorBtn.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      menu.style.top = (bRect.bottom - rootRect.top + 4) + 'px';
      menu.style.left = (bRect.left - rootRect.left) + 'px';
      activeMenu = menu;
    }

    async function runRewrite(action, extra) {
      if (!currentSel) return;
      const sel = currentSel;
      const block = blocks.find((b) => b.id === sel.blockId);
      if (!block) return;

      // Map the selected rendered text to a range in the block's RAW Markdown. Verbatim match
      // covers plain prose; when the selection falls inside Markdown syntax (no verbatim match)
      // we fall back to rewriting the whole block. (See §10 risk note.)
      let rawStart = block.raw.indexOf(sel.text);
      let rawEnd;
      let rawSelected;
      if (rawStart === -1) {
        // The whole-block fallback is fine for prose, but on a column layout it would hand the AI
        // the raw `::::columns{…}` fence as its text and splice the reply back over the whole
        // thing — the structure is gone and the author's other column with it. Prose INSIDE a
        // column still rewrites normally: it matches verbatim, so it never reaches this branch.
        if (isColumnsBlock(block.raw)) {
          hideChrome();
          window.alert('Select the words inside a column to rewrite them — a whole column layout can’t be rewritten at once.');
          return;
        }
        rawStart = 0; rawEnd = block.raw.length; rawSelected = block.raw;
      } else { rawEnd = rawStart + sel.text.length; rawSelected = sel.text; }

      hideChrome();
      const blockEl = root.querySelector('.bmsme-block[data-block-id="' + sel.blockId + '"]');
      const prevHtml = blockEl ? blockEl.innerHTML : '';
      if (blockEl) { blockEl.classList.add('bmsme-busy'); blockEl.innerHTML = '<div class="bmsme-skeleton">Rewriting…</div>'; }

      let rewrittenText;
      try {
        const res = await fetch(REWRITE_URL, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            blogPostId, action, tone: extra.tone, instruction: extra.instruction,
            selectedText: rawSelected, blockContext: block.raw,
            docContext: { title: (opts.title || '') },
          }),
        });
        if (!res.ok) throw new Error('rewrite failed');
        rewrittenText = (await res.json()).rewrittenText;
      } catch (_) {
        if (blockEl) { blockEl.classList.remove('bmsme-busy'); blockEl.innerHTML = prevHtml; }
        window.alert('The rewrite could not be completed. Please try again.');
        return;
      }

      // Show the diff with Accept / Reject before committing.
      if (blockEl) {
        blockEl.classList.remove('bmsme-busy');
        blockEl.innerHTML = renderBlock(applyAssetUrls(block.raw), mdInst);
        const diff = document.createElement('div');
        diff.className = 'bmsme-diff';
        diff.innerHTML = diffHtml(rawSelected, rewrittenText) +
          '<div class="bmsme-diff-actions">' +
          '<button class="bmsme-accept">Accept</button>' +
          '<button class="bmsme-reject">Reject</button></div>';
        blockEl.appendChild(diff);
        diff.querySelector('.bmsme-accept').addEventListener('click', () => {
          block.raw = block.raw.slice(0, rawStart) + rewrittenText + block.raw.slice(rawEnd);
          renderOneBlock(sel.blockId);
          scheduleSave();
        });
        diff.querySelector('.bmsme-reject').addEventListener('click', () => renderOneBlock(sel.blockId));
      }
    }

    // Insert media at a GAP index: 0 puts it above the first block, blocks.length appends.
    //
    // The gap is anchored to the id of the block that should follow it, and re-resolved after
    // commitEdit(), because committing an open edit rewrites the block list underneath us — it
    // splits one block into several (each with a FRESH id) or drops an emptied one. A raw index
    // captured beforehand would land somewhere else entirely.
    function insertMediaAt(index, media) {
      if (!media || media.assetId == null) return null;
      const beforeId = (index >= 0 && index < blocks.length) ? blocks[index].id : null;
      commitEdit();   // fold any in-progress typing in before splicing the media block
      if (media.url != null) assetUrls[media.assetId] = media.url;

      let at = beforeId != null ? blocks.findIndex((b) => b.id === beforeId) : blocks.length;
      if (at < 0) at = blocks.length;   // the anchor was split or emptied away — land at the end
      const block = { id: uid(), raw: mediaRaw(media) };
      blocks.splice(at, 0, block);
      currentSel = null;
      renderAll();
      scheduleSave();
      return block.id;
    }

    // Scroll a block into view and flash it. A layout inserted below the fold is indistinguishable
    // from nothing having happened, which is exactly how the Columns buttons read.
    function revealBlock(blockId) {
      const el = root.querySelector('.bmsme-block[data-block-id="' + blockId + '"]');
      if (!el) return;
      if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('bmsme-flash');
      void el.offsetWidth;              // restart the animation if the same block is hit twice
      el.classList.add('bmsme-flash');
      setTimeout(() => el.classList.remove('bmsme-flash'), 1300);
    }

    // Insert an empty column layout at a gap index. Columns carry seed prose rather than being
    // left empty: an empty `.bms-column` has no height, so a blank grid renders as nothing at all
    // and the author sees the button do nothing. The seed doubles as the instruction for what to
    // do next, and spliceColumnRaw replaces it as soon as anything is dropped in.
    function insertColumnsAt(index, cols) {
      const n = cols === 3 ? 3 : 2;
      const beforeId = (index >= 0 && index < blocks.length) ? blocks[index].id : null;
      commitEdit();
      let body = '';
      for (let i = 0; i < n; i++) body += ':::column\n' + COLUMN_SEED + '\n:::\n';
      const raw = '::::columns{cols=' + n + '}\n' + body + '::::';

      let at = beforeId != null ? blocks.findIndex((b) => b.id === beforeId) : blocks.length;
      if (at < 0) at = blocks.length;
      const block = { id: uid(), raw };
      blocks.splice(at, 0, block);
      currentSel = null;
      renderAll();
      revealBlock(block.id);
      scheduleSave();
      return block.id;
    }

    // Mutating wrapper over the pure spliceColumnRaw: leaves the block untouched on a miss.
    function spliceIntoColumn(block, colIndex, md) {
      const next = spliceColumnRaw(block.raw, colIndex, md);
      if (next == null) return false;
      block.raw = next;
      return true;
    }

    // Caret-anchored insert: media lands after the block the author last touched (the picker's
    // behaviour, unchanged). Resolve the anchor AFTER commitEdit for the reason above.
    function insertMediaImpl(media) {
      if (!media || media.assetId == null) return null;
      commitEdit();
      const anchorId = currentSel && currentSel.blockId;
      const at = anchorId ? blocks.findIndex((b) => b.id === anchorId) : -1;
      return insertMediaAt(at >= 0 ? at + 1 : blocks.length, media);
    }

    // Move an existing block to a gap index (drag-reorder, plan §4.3.4).
    function moveBlockTo(blockId, index) {
      if (!blockId) return;
      const beforeId = (index >= 0 && index < blocks.length) ? blocks[index].id : null;
      if (beforeId === blockId) return;                  // dropped back on its own gap — a no-op
      commitEdit();
      const from = blocks.findIndex((b) => b.id === blockId);
      if (from < 0) return;
      const [moved] = blocks.splice(from, 1);
      // Re-resolve the destination AFTER the removal: taking the block out shifts every index
      // below it up by one, so the raw gap index would land one place too far down.
      let at = beforeId != null ? blocks.findIndex((b) => b.id === beforeId) : blocks.length;
      if (at < 0) at = blocks.length;
      blocks.splice(at, 0, moved);
      renderAll();
      scheduleSave();
    }

    // ── Drag and drop ───────────────────────────────────────────────────────────────────────────
    // Media arrives three ways — dragged from a Studio picker, dragged from elsewhere in the draft
    // (reorder), or dropped straight off the desktop. All three resolve to one gap index, so they
    // share one indicator and one insert path.
    const dropline = document.createElement('div');
    dropline.className = 'bmsme-dropline';
    root.appendChild(dropline);
    const pendingPill = document.createElement('div');
    pendingPill.className = 'bmsme-droppending';
    pendingPill.textContent = 'Adding media…';
    root.appendChild(pendingPill);

    const blockEls = () => Array.from(root.querySelectorAll('.bmsme-block'));

    // Which gap is the pointer nearest? Compares against block midpoints, so the line snaps to
    // whichever side of a block you are hovering.
    function gapIndexAt(clientY) {
      const els = blockEls();
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return i;
      }
      return els.length;
    }

    function droplineY(index) {
      const els = blockEls();
      const rootTop = root.getBoundingClientRect().top;
      if (!els.length) return 0;
      if (index >= els.length) return els[els.length - 1].getBoundingClientRect().bottom - rootTop;
      return els[index].getBoundingClientRect().top - rootTop;
    }
    function showDropline(index) {
      dropline.style.top = (droplineY(index) - 1) + 'px';
      dropline.style.display = 'block';
    }
    function hideDropline() { dropline.style.display = 'none'; }

    // Is the pointer inside a rendered column? If so the drop targets that column rather than a
    // gap between top-level blocks.
    function columnTargetAt(node) {
      const colEl = node && node.closest ? node.closest('.bms-column') : null;
      if (!colEl || !root.contains(colEl)) return null;
      const blockEl = colEl.closest('.bmsme-block');
      if (!blockEl) return null;
      const cols = Array.from(blockEl.querySelectorAll('.bms-column'));
      return { blockId: blockEl.getAttribute('data-block-id'), colIndex: cols.indexOf(colEl), el: colEl };
    }
    let colHint = null;
    function highlightColumn(el) {
      if (colHint === el) return;
      clearColumnHint();
      colHint = el;
      if (colHint) colHint.classList.add('bmsme-colhint');
    }
    function clearColumnHint() {
      if (colHint) colHint.classList.remove('bmsme-colhint');
      colHint = null;
    }

    // dragenter/dragleave fire once per descendant, so a plain dragleave would hide the line while
    // the pointer is still inside the editor. Count depth instead.
    let dragDepth = 0;

    // `types` is readable during dragover; `getData` is not (the browser withholds the payload
    // until drop), so the kind has to be decided from the MIME list alone.
    function dragKind(dt) {
      if (!dt) return null;
      const types = Array.from(dt.types || []);
      if (types.indexOf(BLOCK_MIME) >= 0) return 'block';
      if (types.indexOf(MEDIA_MIME) >= 0) return 'media';
      if (types.indexOf('Files') >= 0) return 'files';
      return null;
    }
    // An external drop is only offered if the host gave us a way to attach it.
    function accepts(kind) { return kind === 'block' || typeof onDropMedia === 'function'; }

    function onDragStart(e) {
      const blockEl = e.target.closest && e.target.closest('.bmsme-block');
      if (!blockEl) return;
      // Two ways in: the handle (any block, incl. prose) or the block body (media only, where
      // there is no text selection to protect). Anything else dragging inside a block is ignored.
      const fromHandle = !!(e.target.closest && e.target.closest('.bmsme-handle'));
      if (!fromHandle && blockEl.getAttribute('draggable') !== 'true') return;
      e.dataTransfer.setData(BLOCK_MIME, blockEl.getAttribute('data-block-id'));
      e.dataTransfer.effectAllowed = 'move';
      blockEl.classList.add('bmsme-dragging');
    }
    function onDragEnd() {
      Array.from(root.querySelectorAll('.bmsme-dragging')).forEach((n) => n.classList.remove('bmsme-dragging'));
      hideDropline();
      clearColumnHint();
      dragDepth = 0;
    }
    function onDragEnter(e) {
      const kind = dragKind(e.dataTransfer);
      if (kind && accepts(kind)) dragDepth++;
    }
    function onDragLeave(e) {
      const kind = dragKind(e.dataTransfer);
      if (!kind || !accepts(kind)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) { hideDropline(); clearColumnHint(); }
    }
    function onDragOver(e) {
      const kind = dragKind(e.dataTransfer);
      if (!kind || !accepts(kind)) return;   // not ours — leave the page's own handling alone
      e.preventDefault();                    // required, or the browser refuses to fire `drop`
      e.dataTransfer.dropEffect = kind === 'block' ? 'move' : 'copy';
      const col = columnTargetAt(e.target);
      if (col) { hideDropline(); highlightColumn(col.el); }
      else { clearColumnHint(); showDropline(gapIndexAt(e.clientY)); }
    }

    async function onDrop(e) {
      const kind = dragKind(e.dataTransfer);
      if (!kind || !accepts(kind)) return;
      e.preventDefault();
      const col = columnTargetAt(e.target);
      onDragEnd();
      const index = gapIndexAt(e.clientY);

      if (kind === 'block') {
        const movingId = e.dataTransfer.getData(BLOCK_MIME);
        if (col) moveBlockIntoColumn(movingId, col);
        else moveBlockTo(movingId, index);
        return;
      }

      let payload;
      if (kind === 'media') {
        try { payload = { kind: 'picker', data: JSON.parse(e.dataTransfer.getData(MEDIA_MIME)) }; }
        catch (_) { return; }               // malformed payload — never guess at what was dropped
      } else {
        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        payload = { kind: 'files', files };
      }

      // Anchor across the await: attaching is a network round-trip and the author can keep typing
      // (and re-splitting blocks) while it runs. For a column drop the anchor is the columns block
      // itself; for a gap drop it's the block that should follow the media.
      const beforeId = col ? col.blockId
        : ((index >= 0 && index < blocks.length) ? blocks[index].id : null);
      if (!col) showDropline(index);
      pendingPill.style.top = ((col ? col.el.getBoundingClientRect().top - root.getBoundingClientRect().top : droplineY(index)) + 4) + 'px';
      pendingPill.style.display = 'block';
      let media = null;
      try {
        media = await onDropMedia(payload);
      } catch (err) {
        console.error('[MarkdownEditor] media drop failed:', err);
      }
      pendingPill.style.display = 'none';
      hideDropline();
      // A drop must never write a directive pointing at an unattached asset (plan §4.3.3): if the
      // attach failed there is no assetId, so nothing goes into the Markdown at all.
      if (!media) return;
      const list = (Array.isArray(media) ? media : [media]).filter(Boolean);
      if (!list.length) return;

      if (col) {
        commitEdit();
        const target = blocks.find((b) => b.id === col.blockId);
        // The columns block can be gone by now — the author may have deleted it while the upload
        // ran. Dropping the media at the end beats discarding what they just uploaded.
        if (!target) { list.forEach((m) => insertMediaAt(blocks.length, m)); return; }
        list.forEach((m) => {
          if (m.url != null) assetUrls[m.assetId] = m.url;
          spliceIntoColumn(target, col.colIndex, mediaRaw(m));
        });
        renderAll();
        scheduleSave();
        return;
      }

      let at = beforeId != null ? blocks.findIndex((b) => b.id === beforeId) : blocks.length;
      if (at < 0) at = blocks.length;
      list.forEach((m, k) => insertMediaAt(at + k, m));
    }

    // Drag an existing top-level media block into a column: splice its raw in, then drop the
    // original block. Media already inside a column is not a block of its own, so it cannot be
    // dragged back out — the opaque-block trade-off (see isColumnsBlock).
    function moveBlockIntoColumn(blockId, col) {
      if (!blockId || blockId === col.blockId) return;
      commitEdit();
      const from = blocks.findIndex((b) => b.id === blockId);
      const target = blocks.find((b) => b.id === col.blockId);
      if (from < 0 || !target) return;
      const raw = blocks[from].raw;
      if (!spliceIntoColumn(target, col.colIndex, raw)) return;   // leave the block where it is
      blocks.splice(blocks.findIndex((b) => b.id === blockId), 1);
      renderAll();
      scheduleSave();
    }

    // Wire events.
    const onMouseUp = () => setTimeout(onSelect, 0);
    const onDocMouseDown = (e) => { if (!root.contains(e.target)) hideChrome(); };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onDocMouseDown);
    root.addEventListener('click', onRootClick);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragend', onDragEnd);
    root.addEventListener('dragenter', onDragEnter);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDrop);

    renderAll();
    syncFormatBar();   // paint the bar's initial state before the author touches anything

    return {
      getMarkdown,
      setMarkdown(md) {
        editing = null;   // whatever was open refers to blocks that no longer exist
        blocks = splitBlocks(md).map((raw) => ({ id: uid(), raw }));
        renderAll();
      },
      // Put the caret in the draft so an empty post has an obvious way in.
      focus() {
        const last = blocks[blocks.length - 1];
        const el = last && root.querySelector('.bmsme-block[data-block-id="' + last.id + '"]');
        if (el) enterEdit(el, last.id); else appendBlockAndEdit();
      },
      // Register/refresh display URLs for inline asset:// refs (e.g. after loading an existing post).
      setAssetUrls(map) {
        if (!map) return;
        // loadFeature() calls this on every open, usually with nothing in it — don't re-render
        // (and disturb the caret) for a no-op.
        let changed = false;
        Object.keys(map).forEach((id) => {
          if (assetUrls[id] !== map[id]) { assetUrls[id] = map[id]; changed = true; }
        });
        if (changed) renderAll();
      },
      insertMedia: insertMediaImpl,
      // Positional insert. Exposed so a host can place media without a drag (the accessible path —
      // drag-and-drop is a pointer gesture and can't be the only way to position media).
      insertMediaAt,
      // Set the typeface the draft renders in — the face the published post will use, so the Font
      // family picker reformats what the author is looking at instead of only changing a stored
      // setting. Empty/absent restores the host page's own font.
      setFontFamily(stack) {
        if (stack) root.style.setProperty('--bmsme-font', stack);
        else root.style.removeProperty('--bmsme-font');
      },
      // Insert a 2- or 3-column layout after the block the author last touched.
      //
      // `currentSel` alone was too narrow an anchor: it is only set by a text SELECTION, so simply
      // clicking into a paragraph and pressing the button appended the layout to the very end of
      // the draft — the "it adds the columns underneath" complaint. Prefer the block that is open
      // for editing, then a selection, then the last block the format bar acted on.
      insertColumns(cols) {
        const anchorId = (editing && editing.blockId)
          || (currentSel && currentSel.blockId)
          || formatTargetId;
        const at = anchorId ? blocks.findIndex((b) => b.id === anchorId) : -1;
        return insertColumnsAt(at >= 0 ? at + 1 : blocks.length, cols);
      },
      insertColumnsAt,
      revealBlock,
      // Back-compat wrapper: insertImage predates video/audio and is still what existing callers
      // reach for. Kept thin rather than duplicated so there's one insert path to maintain.
      insertImage(img) {
        if (!img) return;
        insertMediaImpl({ ...img, type: 'image' });
      },
      destroy() {
        // Fold in any open edit and flush it synchronously — closing the modal mid-sentence must
        // not silently drop the last thing typed (the autosave debounce may still be pending).
        commitEdit();
        const pending = saveTimer != null;
        destroyed = true;
        if (saveTimer) clearTimeout(saveTimer);
        if (pending && blogPostId) {
          const body = JSON.stringify({ id: blogPostId, bodyMarkdown: getMarkdown() });
          if (navigator.sendBeacon) navigator.sendBeacon(SAVE_URL, new Blob([body], { type: 'application/json' }));
          else fetch(SAVE_URL, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
        }
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('mousedown', onDocMouseDown);
        root.removeEventListener('click', onRootClick);
        root.removeEventListener('dragstart', onDragStart);
        root.removeEventListener('dragend', onDragEnd);
        root.removeEventListener('dragenter', onDragEnter);
        root.removeEventListener('dragover', onDragOver);
        root.removeEventListener('dragleave', onDragLeave);
        root.removeEventListener('drop', onDrop);
        container.innerHTML = '';
      },
    };
  }

  if (typeof window !== 'undefined') window.MarkdownEditor = { mount, MEDIA_MIME };

  // The document model — how Markdown becomes blocks, and what the editor writes back — is pure
  // and worth locking down, but mount() needs a DOM and this repo's tests are plain node scripts.
  // Export the pure half so tests/markdown-editor-blocks.test.ts can reach it directly; the drag
  // and click-to-edit halves stay browser-only by nature. Mirrors marked-bms-directives.js's
  // dual export rather than inventing a second convention.
  if (typeof module === 'object' && module.exports) {
    module.exports = {
      splitBlocks, isMediaBlock, isColumnsBlock, mediaRaw, spliceColumnRaw, MEDIA_MIME,
      toggleInlineMark, insertLink, detectBlockType, setBlockType, INLINE_MARKS,
    };
  }
})();
