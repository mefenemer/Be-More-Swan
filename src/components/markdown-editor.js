/**
 * src/components/markdown-editor.js
 *
 * Autonomous Content Engine — US 1.2: block-segmented Markdown editor with sectional AI rewrite.
 *
 * The draft is split into ordered BLOCKS (paragraph/heading/list/quote/code) separated by blank
 * lines. Each block keeps its raw Markdown as the source of truth and is rendered with
 * marked + DOMPurify (the workspace.html pattern; a minimal escape-first fallback is used when
 * those globals are absent). Highlighting text inside a rendered block opens a contextual toolbar
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
 *     onChange,           // optional (markdown) => void
 *   });
 *   ed.getMarkdown();  ed.setMarkdown(md);  ed.destroy();
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

  // Render one block's Markdown to sanitised HTML. Prefer marked + DOMPurify when the host page
  // has loaded them (workspace.html does); otherwise fall back to escaped plain text.
  function renderBlock(md) {
    try {
      if (window.marked && window.DOMPurify) {
        const html = window.marked.parse(md, { gfm: true, breaks: false });
        return window.DOMPurify.sanitize(html);
      }
    } catch (_) { /* fall through */ }
    return '<p>' + escapeHtml(md).replace(/\n/g, '<br>') + '</p>';
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
      .bmsme-root { position: relative; }
      .bmsme-block { padding: 2px 4px; border-radius: 4px; }
      .bmsme-block:hover { background: rgba(0,0,0,0.02); }
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

    function getMarkdown() { return blocks.map((b) => b.raw).join('\n\n'); }

    function renderAll() {
      // Remove existing block nodes (keep toolbar).
      Array.from(root.querySelectorAll('.bmsme-block')).forEach((n) => n.remove());
      for (const b of blocks) {
        const el = document.createElement('div');
        el.className = 'bmsme-block';
        el.setAttribute('data-block-id', b.id);
        el.innerHTML = renderBlock(applyAssetUrls(b.raw));
        root.appendChild(el);
      }
    }

    function renderOneBlock(blockId) {
      const b = blocks.find((x) => x.id === blockId);
      const el = root.querySelector('.bmsme-block[data-block-id="' + blockId + '"]');
      if (b && el) el.innerHTML = renderBlock(applyAssetUrls(b.raw));
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
        blockEl.innerHTML = renderBlock(applyAssetUrls(block.raw));
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

    // Wire events.
    const onMouseUp = () => setTimeout(onSelect, 0);
    const onDocMouseDown = (e) => { if (!root.contains(e.target)) hideChrome(); };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onDocMouseDown);

    renderAll();

    return {
      getMarkdown,
      setMarkdown(md) { blocks = splitBlocks(md).map((raw) => ({ id: uid(), raw })); renderAll(); },
      // Register/refresh display URLs for inline asset:// refs (e.g. after loading an existing post).
      setAssetUrls(map) {
        if (!map) return;
        Object.keys(map).forEach((id) => { assetUrls[id] = map[id]; });
        renderAll();
      },
      // Append an inline image as its own block. The stable asset:// ref is the source of truth;
      // `url` is only for immediate preview. Inserts after the last-selected block when known.
      insertImage(img) {
        if (!img || img.assetId == null) return;
        if (img.url != null) assetUrls[img.assetId] = img.url;
        const alt = String(img.alt || '').replace(/[[\]]/g, '');
        const block = { id: uid(), raw: '![' + alt + '](asset://' + img.assetId + ')' };
        const anchorId = currentSel && currentSel.blockId;
        const at = anchorId ? blocks.findIndex((b) => b.id === anchorId) : -1;
        if (at >= 0) blocks.splice(at + 1, 0, block); else blocks.push(block);
        currentSel = null;
        renderAll();
        scheduleSave();
      },
      destroy() {
        destroyed = true;
        if (saveTimer) clearTimeout(saveTimer);
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('mousedown', onDocMouseDown);
        container.innerHTML = '';
      },
    };
  }

  window.MarkdownEditor = { mount };
})();
