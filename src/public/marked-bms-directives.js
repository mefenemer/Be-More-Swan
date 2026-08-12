/**
 * src/lib/marked-bms-directives.js
 *
 * Blog Media Composition — the `:::media` / `::::columns` Markdown directives.
 * See docs/blog-media-composition-plan.md §3.
 *
 * WHY THIS FILE IS PLAIN .js AND UMD-ISH
 * --------------------------------------
 * The blog body is rendered in TWO places and they MUST agree, or the Studio's preview lies about
 * what actually gets published:
 *   · browser — markdown-editor.js, via the global `window.marked` (+ DOMPurify)
 *   · server  — src/utils/markdown-render.ts, via the imported `marked` (+ sanitize-html), which
 *               produces the immutable published_payload snapshot
 * So the tokenizer is ONE artifact consumed both ways: it attaches to window.BmsDirectives for a
 * <script> tag and sets module.exports for the esbuild-bundled functions. Types live alongside in
 * marked-bms-directives.d.ts.
 *
 * ⚠️ The two runtimes are not the same marked build (browser CDN marked@12, server marked@18), so
 * this file sticks to the long-stable extension API (`use({ extensions })`, `lexer`, `parser`) and
 * avoids anything version-specific.
 *
 * THE ONE DELIBERATE DIVERGENCE: `resolveUrl`.
 * The published snapshot must NEVER contain a media `src` — presigned R2 URLs expire and the
 * snapshot is immutable + CDN-cached, so a baked-in src yields posts whose media dies hours after
 * publish. Media is emitted src-less as `data-bms-asset="N"` and widget-api injects a fresh URL at
 * read time. The editor, however, needs a real src to show the author their video. So:
 *   · server passes NO resolveUrl  → src-less output (the safe default)
 *   · editor passes resolveUrl     → src injected for preview only, never persisted
 *
 * SYNTAX
 *   :::media{asset=42 type=video caption="Our Q3 walkthrough" align=wide}
 *
 *   ::::columns{cols=2}
 *   :::column
 *   Ordinary **Markdown**.
 *   :::
 *   :::column
 *   :::media{asset=42 type=image}
 *   :::
 *   ::::
 *
 * Plain images stay plain `![alt](asset://N)` — they are NOT migrated to `:::media` (plan §3.1).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BmsDirectives = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MEDIA_TYPES = { image: 1, video: 1, audio: 1 };
  var ALIGNS = { left: 1, right: 1, wide: 1, full: 1 };
  var MIN_COLS = 2;
  var MAX_COLS = 3;

  // Escape for an HTML double-quoted attribute value / text node. The server re-sanitises with an
  // allowlist afterwards, but a renderer that emits unescaped author text is a bug on its own terms
  // — the editor's DOMPurify pass is not a licence to be sloppy here.
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Parse a directive attribute string: `asset=42 type=video caption="a b" align=wide`.
   * Unknown keys are dropped rather than passed through — the emitted attribute set is a closed
   * allowlist (below), so an attacker can't smuggle `onerror=` in via a directive attribute.
   */
  function parseAttrs(src) {
    var out = {};
    var re = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g;
    var m;
    while ((m = re.exec(String(src || '')))) {
      out[m[1].toLowerCase()] = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
    }
    return out;
  }

  // Normalise a :::media{...} attribute bag into exactly what the renderer may emit.
  // Returns null when the directive is unusable — the caller then drops it, because rendering
  // nothing is correct but leaking literal `:::media{...}` onto a customer's published page is not.
  function normaliseMedia(attrs) {
    // digits only — this value lands in an HTML attribute and is looked up as an integer PK.
    if (!/^\d+$/.test(String(attrs.asset || ''))) return null;
    var type = String(attrs.type || 'image').toLowerCase();
    if (!MEDIA_TYPES[type]) type = 'image';
    var align = String(attrs.align || '').toLowerCase();
    return {
      assetId: attrs.asset,
      // NOT `type`: marked reserves token.type for extension dispatch, so a media `type` here would
      // clobber 'bmsMedia' and the renderer would never be found.
      mediaType: type,
      caption: attrs.caption ? String(attrs.caption) : '',
      alt: attrs.alt ? String(attrs.alt) : '',
      align: ALIGNS[align] ? align : '',
    };
  }

  function renderMediaToken(t, resolveUrl) {
    var tag = t.mediaType === 'image' ? 'img' : t.mediaType;   // img | video | audio
    var url = typeof resolveUrl === 'function' ? resolveUrl(t.assetId, t.mediaType) : null;

    var attrs = ['data-bms-asset="' + esc(t.assetId) + '"'];
    // Preview only. The server passes no resolver, so the persisted snapshot stays src-less and
    // widget-api resolves a fresh URL per read. See the header note.
    if (url) attrs.push('src="' + esc(url) + '"');

    var cls = 'bms-media bms-media-' + t.mediaType + (t.align ? ' bms-align-' + t.align : '');
    attrs.push('class="' + esc(cls) + '"');

    if (t.mediaType === 'image') {
      attrs.push('alt="' + esc(t.alt || t.caption) + '"');
      attrs.push('loading="lazy"');
    } else {
      // No autoplay, ever: an autoplaying video on a customer's page is a hostile default, and the
      // sanitiser refuses the attribute anyway. `preload=metadata` keeps the page cheap to load.
      attrs.push('controls');
      attrs.push('preload="metadata"');
    }

    var media = '<' + tag + ' ' + attrs.join(' ') +
      (t.mediaType === 'image' ? '>' : '></' + t.mediaType + '>');
    if (!t.caption) return media;
    return '<figure class="bms-media-figure">' + media +
      '<figcaption>' + esc(t.caption) + '</figcaption></figure>';
  }

  // --- Tokenizers ------------------------------------------------------------------------------
  // Both are block-level. `start` lets marked skip ahead cheaply to a possible directive.

  function mediaExtension(resolveUrl) {
    return {
      name: 'bmsMedia',
      level: 'block',
      start: function (src) { var i = src.indexOf(':::media'); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        var m = /^:::media\{([^}\n]*)\}[ \t]*(?:\n+|$)/.exec(src);
        if (!m) return;
        var spec = normaliseMedia(parseAttrs(m[1]));
        // Unusable directive: still CONSUME the raw text so it can't fall through to the paragraph
        // tokenizer and get published as literal `:::media{...}` on a customer's site (plan §5).
        return Object.assign({ type: 'bmsMedia', raw: m[0], valid: !!spec }, spec || {});
      },
      renderer: function (t) { return t.valid ? renderMediaToken(t, resolveUrl) : ''; },
    };
  }

  // ::::columns{cols=2} … :::column … ::: … ::::
  // Deliberately NOT recursive: a column may not contain another columns block. Nesting buys
  // nothing for a blog body and turns the editor's block model into a tree with no bottom.
  function columnsExtension() {
    return {
      name: 'bmsColumns',
      level: 'block',
      start: function (src) { var i = src.indexOf('::::columns'); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        var m = /^::::columns\{([^}\n]*)\}[ \t]*\n([\s\S]*?)\n::::[ \t]*(?:\n+|$)/.exec(src);
        if (!m) return;

        var cols = parseInt(parseAttrs(m[1]).cols, 10);
        if (!(cols >= MIN_COLS && cols <= MAX_COLS)) cols = MIN_COLS;

        // Pull out each :::column … ::: body.
        var bodies = [];
        var re = /:::column[ \t]*\n([\s\S]*?)\n:::[ \t]*(?=\n|$)/g;
        var c;
        while ((c = re.exec(m[2]))) bodies.push(c[1]);
        // No columns parsed → emit nothing rather than an empty grid, but still consume the raw so
        // the `::::columns` fence can't reach a customer's page as literal text.
        if (!bodies.length) return { type: 'bmsColumns', raw: m[0], cols: cols, columns: [] };

        var self = this;
        return {
          type: 'bmsColumns',
          raw: m[0],
          cols: cols,
          // Each column's inner Markdown is lexed as normal block content, so ordinary prose,
          // headings and :::media all work inside a column.
          columns: bodies.map(function (b) { return self.lexer.blockTokens(b.trim() + '\n', []); }),
        };
      },
      renderer: function (t) {
        if (!t.columns.length) return '';
        var self = this;
        var inner = t.columns.map(function (toks) {
          return '<div class="bms-column">' + self.parser.parse(toks) + '</div>';
        }).join('');
        return '<div class="bms-columns" data-cols="' + esc(t.cols) + '">' + inner + '</div>';
      },
    };
  }

  /**
   * Register the directives on a marked instance.
   * Pass an ISOLATED instance (`new marked.Marked()`), not the global singleton — workspace.html
   * renders other things with the page-wide `marked` and shouldn't inherit blog directives.
   *
   * @param {object} inst   a marked instance exposing .use()
   * @param {object} [opts] { resolveUrl?: (assetId, mediaType) => string|null } — preview src only
   */
  function install(inst, opts) {
    var resolveUrl = opts && opts.resolveUrl;
    inst.use({ extensions: [mediaExtension(resolveUrl), columnsExtension()] });
    return inst;
  }

  // --- Syndication strip -----------------------------------------------------------------------

  // Rebuild a paragraph's Markdown with any asset:// image dropped. Inline tokens carry `raw`, so
  // concatenating them minus the image tokens is exact — no regex over the raw source, which is
  // what keeps a near-miss from leaving a half-eaten `![alt](` behind.
  function stripAssetImagesFromInline(tokens) {
    var out = '';
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.type === 'image' && /^asset:\/\/\d+$/.test(String(t.href || '').trim())) continue;
      if (t.tokens && t.tokens.length && t.type !== 'image') {
        // A link/emphasis wrapping an asset image — recurse, but keep the wrapper's own raw when
        // nothing inside changed, so ordinary text survives byte-identical.
        var innerStripped = stripAssetImagesFromInline(t.tokens);
        var innerRaw = t.tokens.map(function (x) { return x.raw; }).join('');
        if (innerStripped !== innerRaw) { out += innerStripped; continue; }
      }
      out += t.raw;
    }
    return out;
  }

  function tokensToMarkdown(tokens) {
    var parts = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];

      if (t.type === 'bmsMedia') continue;                       // drop media entirely

      if (t.type === 'bmsColumns') {
        // UNWRAP, don't drop: a column holds the author's PROSE as well as their media. Dropping
        // the container would silently delete their words. Columns stack in source order.
        for (var c = 0; c < t.columns.length; c++) {
          var inner = tokensToMarkdown(t.columns[c]);
          if (inner.trim()) parts.push(inner.trim());
        }
        continue;
      }

      if (t.type === 'paragraph' && t.tokens) {
        var stripped = stripAssetImagesFromInline(t.tokens).trim();
        if (stripped) parts.push(stripped);                      // a paragraph that was ONLY an image disappears
        continue;
      }

      if (t.type === 'space') continue;
      parts.push(String(t.raw == null ? '' : t.raw).replace(/\n+$/, ''));
    }
    return parts.join('\n\n');
  }

  /**
   * Project a blog body for external destinations: TEXT ONLY (plan §3.5, decided).
   *
   * Our media URLs are presigned + expiring, and Pexels is hotlink-only under its ToS, so we hand
   * external platforms no media at all rather than links that 404 or breach a licence. This also
   * closes a live bug: bodyMarkdown was previously syndicated raw, so `![alt](asset://42)` shipped
   * to Dev.to as a literal unresolvable ref (plan §2.4).
   *
   *   ![alt](asset://N)   → removed        ![alt](https://…) → KEPT (a real public URL still works)
   *   :::media{…}         → removed        ::::columns       → unwrapped, stacked, prose preserved
   *
   * @param {object} markedMod  the marked module (needs .Marked or .lexer)
   * @param {string} md         body_markdown
   * @returns {string} markdown with no BMS media
   */
  function stripMediaForSyndication(markedMod, md) {
    if (!md || !String(md).trim()) return '';
    var inst = markedMod.Marked ? new markedMod.Marked() : markedMod;
    install(inst, {});   // no resolveUrl — we only need the token tree, never HTML
    return tokensToMarkdown(inst.lexer(String(md))).trim();
  }

  return {
    install: install,
    stripMediaForSyndication: stripMediaForSyndication,
    // exported for tests
    _parseAttrs: parseAttrs,
    _normaliseMedia: normaliseMedia,
  };
});
