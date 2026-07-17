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

  // Split Markdown into blocks on blank lines, but keep fenced code blocks intact.
  function splitBlocks(md) {
    const lines = String(md == null ? '' : md).replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let buf = [];
    let inFence = false;
    const flush = () => {
      const raw = buf.join('\n').trim();
      if (raw) blocks.push(raw);
      buf = [];
    };
    for (const line of lines) {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (!inFence && line.trim() === '') { flush(); continue; }
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
      .bmsme-block { padding: 2px 4px; border-radius: 4px; }
      .bmsme-block:hover { background: rgba(0,0,0,0.02); }
      /* Click-to-edit: the block swaps its rendered HTML for a textarea over its raw Markdown. */
      .bmsme-editing { background: rgba(236,72,153,.04); box-shadow: inset 0 0 0 1px #fbcfe8; }
      .bmsme-input { display:block; width:100%; border:0; outline:0; padding:0; margin:0;
        font: inherit; color: inherit; background: transparent; resize: none; overflow: hidden;
        line-height: 1.6; }
      .bmsme-placeholder { color:#9ca3af; margin:0; }
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
    `;
    const el = document.createElement('style');
    el.id = STYLE_ID; el.textContent = css;
    document.head.appendChild(el);
  }

  function mount(opts) {
    const { container, blogPostId, initialMarkdown = '', onChange } = opts || {};
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
        el.innerHTML = blockHtml(b);
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
      if (b && el) { el.classList.remove('bmsme-editing'); el.innerHTML = blockHtml(b); }
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
      });
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      autosize(ta);
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
      if (rawStart === -1) { rawStart = 0; rawEnd = block.raw.length; rawSelected = block.raw; }
      else { rawEnd = rawStart + sel.text.length; rawSelected = sel.text; }

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

    // Insert media as its own block. The stable asset ref is the source of truth; `url` is only
    // for immediate preview. Inserts after the last-selected block when known.
    //
    // A plain image with no caption stays plain `![alt](asset://N)` Markdown — the `:::media`
    // directive is for what Markdown CANNOT express (video, audio, a caption), so existing drafts
    // need no migration and stay byte-identical (plan §3.1).
    //
    //   media: { assetId, type?: 'image'|'video'|'audio', url?, alt?, caption?, align? }
    function insertMediaImpl(media) {
      if (!media || media.assetId == null) return;
      commitEdit();   // fold any in-progress typing in before splicing the media block
      if (media.url != null) assetUrls[media.assetId] = media.url;

      const type = media.type === 'video' || media.type === 'audio' ? media.type : 'image';
      const alt = String(media.alt || '').replace(/[[\]]/g, '');
      // The attribute grammar is `key="value"` — a quote, brace or newline in author text would
      // break out of it, so drop those rather than emit a directive that won't re-parse.
      const clean = (v) => String(v || '').replace(/["}\r\n]/g, '').trim();
      const caption = clean(media.caption);

      let raw;
      if (type === 'image' && !caption) {
        raw = '![' + alt + '](asset://' + media.assetId + ')';
      } else {
        raw = ':::media{asset=' + media.assetId + ' type=' + type
          + (alt ? ' alt="' + clean(alt) + '"' : '')
          + (caption ? ' caption="' + caption + '"' : '')
          + (media.align ? ' align=' + clean(media.align) : '')
          + '}';
      }

      const block = { id: uid(), raw };
      const anchorId = currentSel && currentSel.blockId;
      const at = anchorId ? blocks.findIndex((b) => b.id === anchorId) : -1;
      if (at >= 0) blocks.splice(at + 1, 0, block); else blocks.push(block);
      currentSel = null;
      renderAll();
      scheduleSave();
    }

    // Wire events.
    const onMouseUp = () => setTimeout(onSelect, 0);
    const onDocMouseDown = (e) => { if (!root.contains(e.target)) hideChrome(); };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onDocMouseDown);
    root.addEventListener('click', onRootClick);

    renderAll();

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
        container.innerHTML = '';
      },
    };
  }

  window.MarkdownEditor = { mount };
})();
