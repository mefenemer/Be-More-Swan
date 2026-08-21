/**
 * src/components/blog-studio-modal.js
 *
 * Autonomous Content Engine — Blog Studio as a native in-SPA modal.
 *
 * Blog is authored like a social post: from an assistant context, surfaced as a popup from the
 * Review Queue / Calendar / Assistant Detail surfaces, never a sidebar page. This module owns the
 * whole surface — it injects its own markup + styles on first open, mounts the shared
 * window.MarkdownEditor, and drives the existing blog-* Netlify functions (no backend changes).
 *
 * The author is ALWAYS the user; the assistant only *supports* (tone/voice, and — Phase B —
 * scheduling cadence). There is no "Written by" picker: the supporting assistant is passed in by
 * whichever surface opened the modal.
 *
 * Public API (attached to window):
 *   openBlogStudio({ assistantId?, postId? })  — open the modal; postId loads an existing draft.
 *   closeBlogStudio()                          — close + tear down the editor.
 *   blogStudioAvailable(assistants)            — gate helper: true iff an active Blog Writer exists.
 *
 * Reuses: marked@12 + dompurify@3 (already loaded by the host page), src/components/markdown-editor.js.
 */
(function () {
  'use strict';

  var BLOG_WRITER_ROLE = 'blog_writer';

  var api = function (path, opts) {
    return fetch('/.netlify/functions/' + path, Object.assign({
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    }, opts)).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); });
  };

  var state = { injected: false, postId: null, editor: null, assistants: {}, assistantId: null,
    // Resolved lazily when no assistantId was passed in (the standalone page, the Calendar) so the
    // "Ask <name> to…" buttons can still name somebody. '' = looked and found none.
    assistantName: null, postStatus: null,
    // undefined = not fetched yet; null = fetched and the business has no URL on file.
    // The two must stay distinguishable or loadOrgWebsite() refetches on every open.
    orgWebsite: undefined,
    // Same undefined/null contract as orgWebsite. null = no kit, or the neutral default one.
    brandKit: undefined,
    // Whether this org's assistants may generate AI images. Admin-managed per assistant TYPE
    // (assistant_features), so it is re-resolved on every open and never assumed. false until
    // get-ai-credit-balance says otherwise — see loadMediaCapabilities().
    canImage: false };

  function el(id) { return document.getElementById(id); }
  function setStatus(id, msg) { var e = el(id); if (e) e.textContent = msg; }

  // Coloured success/error banner — the Create Post sheet's gpSetPanelStatus, ported. Replaces the
  // grey one-liners and alert()s so a failure actually reads as one.
  function setBanner(id, msg, type) {
    var e = el(id);
    if (!e) return;
    if (!msg) { e.className = 'bs-banner bs-hidden'; e.textContent = ''; return; }
    e.className = 'bs-banner ' + (type === 'error' ? 'bs-banner-error' : 'bs-banner-ok');
    e.textContent = msg;
  }

  var BUSY_BUTTONS = ['bs-approve', 'bs-pick-time', 'bs-publish', 'bs-schedule',
    'bs-unschedule', 'bs-unpublish', 'bs-repush', 'bs-discard'];

  // Whole-modal busy state for the long-running lifecycle actions (publish). Shows the OS wait
  // cursor and disables every button in the footer, so a second click cannot fire a second publish
  // while the first is still in flight — publish-blog is not idempotent from the author's point of
  // view (it re-renders the payload and re-runs syndication).
  function setBusy(on) {
    var root = el('bms-blog-backdrop');
    if (root) root.classList.toggle('bs-busy', !!on);
    // An explicit list, not a container sweep: the lifecycle row has no wrapper id, and the ones
    // that were ALREADY disabled (Unschedule/Unpublish are hidden+idle on a draft) must come back
    // disabled — hence the marker attribute rather than a blanket re-enable.
    BUSY_BUTTONS.forEach(function (id) {
      var b = el(id);
      if (!b) return;
      if (on) { if (!b.disabled) { b.dataset.bsBusyDisabled = '1'; b.disabled = true; } }
      else if (b.dataset.bsBusyDisabled) { delete b.dataset.bsBusyDisabled; b.disabled = false; }
    });
  }

  // ── Where a published post actually landed ─────────────────────────────────────────────────────
  // publish-blog and publish-blog-destinations both return `syndication`: one entry per connected
  // destination that was attempted, already labelled. An EMPTY array is the meaningful case and the
  // one that used to be invisible — it means nothing else is connected, so the post went to the
  // org's own site alone. That is a perfectly normal outcome, and it is also exactly what a
  // workspace that MEANT to syndicate looks like, so it has to be said out loud either way.
  function syndicationFailures(entries) {
    return (entries || []).filter(function (d) { return d.status === 'error' || d.status === 'not_connected'; });
  }

  // "The Swan Index (for review), Dev.to" — the destination plus, where it differs from what the
  // author just pressed, what state it arrived in over there.
  function syndicationNames(entries) {
    return (entries || []).map(function (d) {
      return d.label + (d.status === 'draft' ? ' (as a draft for review)' : '');
    }).join(', ');
  }

  // Live length readout for the body — the long-form equivalent of Create Post's per-platform
  // counter chips. Thin posts are the blog failure mode, so the chip warns under 300 words.
  function refreshReadout(md) {
    var out = el('bs-readout');
    if (!out) return;
    var words = (md || '').replace(/[#*_`>\-\[\]()!]/g, ' ').split(/\s+/).filter(Boolean).length;
    var mins = Math.max(1, Math.round(words / 200));
    out.textContent = words + (words === 1 ? ' word · ' : ' words · ') + (words < 200 ? 'under a minute read' : '~' + mins + ' min read');
    out.className = 'bs-chip' + (words > 0 && words < 300 ? ' bs-chip-warn' : '');
  }

  // ── Gate helpers ─────────────────────────────────────────────────────────────────────────────
  // "Active" mirrors the social gate in workspace.html (get-assistants filter): not pending/failed/
  // blocked, and not archived.
  function isActive(a) {
    return !!a && a.status !== 'pending' && a.status !== 'failed' && a.status !== 'blocked'
      && a.lifecycleStatus !== 'archived';
  }
  function activeBlogWriters(assistants) {
    if (!Array.isArray(assistants)) return [];
    return assistants.filter(function (a) { return isActive(a) && a.roleKey === BLOG_WRITER_ROLE; });
  }
  // Synchronous gate over an assistants array the caller already has.
  function blogStudioAvailable(assistants) { return activeBlogWriters(assistants).length > 0; }
  // Async convenience for the entry points: resolve the org's first active Blog Writer (or null).
  function resolveBlogWriter() {
    return fetch('/.netlify/functions/get-assistants', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { assistants: [] }; })
      .then(function (d) { return activeBlogWriters(d && d.assistants) [0] || null; })
      .catch(function () { return null; });
  }

  var STYLES = ''
    + '#bms-blog-backdrop{position:fixed;inset:0;z-index:85;background:rgba(17,24,39,.6);'
    + '-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);display:none;overflow-y:auto;}'
    + '#bms-blog-backdrop.bs-open{display:block;}'
    + '.bms-blog-panel{max-width:1100px;margin:24px auto;background:#f9fafb;border-radius:16px;'
    + 'box-shadow:0 24px 70px rgba(0,0,0,.35);padding:24px;position:relative;}'
    + '.bms-blog-close{position:absolute;top:16px;right:16px;background:#f3f4f6;border:0;border-radius:8px;'
    + 'width:32px;height:32px;font-size:18px;line-height:1;cursor:pointer;color:#374151;}'
    + '.bms-blog-close:hover{background:#e5e7eb;}'
    + '.bs-grid{display:grid;grid-template-columns:260px 1fr;gap:24px;}'
    + '.bs-panel{border:1px solid #e5e7eb;border-radius:12px;padding:16px;background:#fff;}'
    + '.bs-panel h3{margin:0 0 12px;font-size:14px;font-weight:600;}'
    + '.bs-field{margin-bottom:12px;}'
    + '.bs-field label{display:block;font-size:12px;color:#6b7280;margin-bottom:4px;}'
    + '.bs-field input,.bs-field select,.bs-field textarea{width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font:inherit;}'
    // ...but a checkbox is not a text field: the rule above stretched it across the row and pushed
    // its label away. Keep it intrinsic and sit it next to the text it labels.
    + '.bs-field input[type="checkbox"]{width:auto;padding:0;margin:0 6px 0 0;vertical-align:middle;accent-color:#ec4899;}'
    // A flat grey rectangle with no border, no shadow and no hover reads as a label, not a control —
    // which is exactly how every media/layout/connect button in here was being read. Give the
    // secondary style a real edge, a lift on hover and a press state, and let each button carry a
    // leading glyph so the row scans as a set of actions.
    + '.bs-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;'
    + 'border:1px solid transparent;cursor:pointer;font-size:14px;font-weight:600;line-height:1.2;'
    + 'transition:background .12s ease,border-color .12s ease,box-shadow .12s ease,transform .06s ease;}'
    + '.bs-btn:active:not(:disabled){transform:translateY(1px);}'
    + '.bs-btn:focus-visible{outline:2px solid #ec4899;outline-offset:2px;}'
    + '.bs-btn-primary{background:#ec4899;color:#fff;border-color:#ec4899;box-shadow:0 1px 2px rgba(17,24,39,.12);}'
    + '.bs-btn-primary:hover:not(:disabled){background:#db2777;border-color:#db2777;}'
    + '.bs-btn-ghost{background:#fff;color:#374151;border-color:#d1d5db;box-shadow:0 1px 2px rgba(17,24,39,.06);}'
    + '.bs-btn-ghost:hover:not(:disabled){background:#fdf2f8;border-color:#f9a8d4;color:#9d174d;}'
    // The compact variant for the dense media row, so five actions still fit on one line.
    + '.bs-btn-sm{padding:6px 10px;font-size:13px;}'
    + '.bs-btn-ico{font-size:14px;line-height:1;}'
    + '.bs-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}'
    + '.bs-title-input{width:100%;font-size:26px;font-weight:700;border:0;outline:0;padding:8px 0;background:transparent;}'
    + '.bs-editor{min-height:320px;border:1px solid #e5e7eb;border-radius:12px;padding:16px;background:#fff;}'
    + '.bs-snippet{font-family:ui-monospace,monospace;font-size:12px;background:#111827;color:#e5e7eb;'
    + 'padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-all;}'
    + '.bs-status{font-size:12px;color:#6b7280;}'
    // Amber, not red: the value is not wrong, it is not finished. Same colour the SEO counters use
    // when they overrun.
    + '.bs-pending{display:block;font-size:11px;color:#b45309;margin-top:4px;}'
    + '.bs-hidden{display:none !important;}'
    // Explanatory prose. Used wherever a control's job isn't self-evident from its label — the
    // feature-image slot being the case that prompted it.
    + '.bs-help{font-size:12px;color:#6b7280;line-height:1.5;margin:0 0 10px;}'
    + '.bs-help strong{color:#374151;font-weight:600;}'
    + '.bs-subhead{font-size:12px;font-weight:600;color:#374151;margin-top:16px;}'
    // The feature slot is a DROP TARGET, so it has to look like one whether or not it is filled.
    + '.bs-feature-drop{position:relative;border-radius:10px;}'
    + '.bs-feature-drop.bs-drop-hot{outline:2px dashed #ec4899;outline-offset:3px;background:#fdf2f8;}'
    + '.bs-feature-empty{font-size:12px;color:#6b7280;border:2px dashed #d1d5db;border-radius:10px;'
    + 'padding:22px 14px;text-align:center;line-height:1.5;background:#fafafa;}'
    + '.bs-feature-preview{position:relative;}'
    + '.bs-feature-preview img{width:100%;border-radius:10px;display:block;}'
    // Removing the hero used to be a grey word in a row of five other grey words. As a labelled
    // control sitting ON the image there is no question what it removes.
    + '.bs-feature-remove{position:absolute;top:8px;right:8px;display:inline-flex;align-items:center;gap:4px;'
    + 'background:rgba(17,24,39,.78);color:#fff;border:0;border-radius:8px;padding:5px 10px;font-size:12px;'
    + 'font-weight:600;cursor:pointer;line-height:1;}'
    + '.bs-feature-remove:hover{background:#b91c1c;}'
    // Two columns, not three. The panel lives in a 260px rail, so a 3-up grid gave ~48px tiles —
    // too small to judge a photo by, and far too narrow for the "Feature" chip to sit on.
    + '.bs-media-picker{margin-top:12px;display:grid;grid-template-columns:repeat(2,1fr);gap:8px;max-height:320px;overflow:auto;}'
    // One tile = one piece of media + the two things you can do with it. Both actions are on the
    // tile because "click to add, drag to feature" leaves the feature slot unreachable without a
    // pointer drag — and a drag is not an accessible-only path.
    + '.bs-tile{position:relative;border-radius:6px;overflow:hidden;}'
    + '.bs-media-picker img,.bs-media-picker video{width:100%;height:84px;object-fit:cover;border-radius:6px;cursor:pointer;border:2px solid transparent;background:#000;display:block;}'
    + '.bs-media-picker img:hover,.bs-media-picker video:hover{border-color:#ec4899;}'
    // Always visible, never hover-only. A destination you can only discover by hovering is the
    // same class of problem as the Remove button nobody could find.
    + '.bs-tile-feature{position:absolute;left:4px;bottom:4px;background:rgba(17,24,39,.8);color:#fff;'
    + 'border:0;border-radius:6px;padding:2px 7px;font-size:11px;font-weight:600;cursor:pointer;'
    + 'transition:background .12s ease;}'
    + '.bs-tile-feature:hover,.bs-tile-feature:focus{background:#ec4899;}'
    + '.bs-media-empty{grid-column:1 / -1;font-size:12px;color:#6b7280;text-align:center;padding:12px;}'
    // Distribution checkboxes — one row per connected platform.
    + '.bs-dest{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid #e5e7eb;'
    + 'border-radius:10px;background:#fff;cursor:pointer;}'
    + '.bs-dest:hover{border-color:#f9a8d4;background:#fdf2f8;}'
    + '.bs-dest input{margin:2px 0 0;accent-color:#ec4899;}'
    + '.bs-dest-name{font-size:13px;font-weight:600;color:#111827;}'
    + '.bs-dest-note{display:block;font-size:11px;color:#6b7280;font-weight:400;margin-top:1px;}'
    // Audio has no thumbnail — a labelled tile stands in, sized to match the image/video ones.
    + '.bs-media-audio{height:84px;border-radius:6px;cursor:pointer;border:2px solid #e5e7eb;'
      + 'display:flex;align-items:center;justify-content:center;text-align:center;padding:4px;'
      + 'font-size:11px;color:#374151;background:#f9fafb;overflow:hidden;word-break:break-word;}'
    + '.bs-media-audio:hover{border-color:#ec4899;}'
    + '.bs-hook{border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin-bottom:8px;}'
    + '.bs-hook:last-child{margin-bottom:0;}'
    + '.bs-hook-win{border-color:#ec4899;background:#fdf2f8;}'
    + '.bs-hook-tag{display:inline-block;font-size:11px;font-weight:700;color:#6b7280;'
      + 'background:#f3f4f6;border-radius:999px;padding:1px 8px;margin-bottom:6px;}'
    + '.bs-hook-win .bs-hook-tag{background:#ec4899;color:#fff;}'
    + '.bs-hook-h1{font-size:15px;font-weight:700;color:#111827;margin:0 0 4px;}'
    + '.bs-hook-intro{font-size:13px;color:#4b5563;margin:0;line-height:1.5;}'
    + '.bs-linkbtn{background:none;border:0;color:#6b7280;font-size:12px;cursor:pointer;text-decoration:underline;padding:0;}'
    + '.bs-linkbtn:hover{color:#ec4899;}'
    // Feedback + composer affordances brought over from the Create Post sheet.
    + '.bs-banner{font-size:13px;border-radius:10px;padding:10px 12px;border:1px solid;margin-top:12px;}'
    + '.bs-banner-ok{background:#fdf2f8;color:#9d174d;border-color:#fbcfe8;}'
    + '.bs-banner-error{background:#fef2f2;color:#991b1b;border-color:#fecaca;}'
    + '.bs-textarea-wrap{position:relative;}'
    + '.bs-mic{position:absolute;bottom:8px;right:8px;background:none;border:0;padding:0;cursor:pointer;'
    + 'color:#9ca3af;line-height:0;}'
    + '.bs-mic:hover{color:#ec4899;}'
    + '.bs-mic.bs-recording{color:#ef4444;}'
    + '.bs-textarea-wrap textarea{padding-right:34px;}'
    + '.bs-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;font-size:12px;border-radius:8px;'
    + 'border:1px solid #e5e7eb;color:#4b5563;background:#f9fafb;}'
    + '.bs-chip-warn{border-color:#fcd34d;color:#b45309;background:#fffbeb;}'
    + '.bs-swan{display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:0;cursor:pointer;'
    + 'font-size:12px;font-weight:600;color:#be185d;}'
    + '.bs-swan:hover{color:#9d174d;}'
    + '.bs-swan img{width:16px;height:16px;object-fit:contain;}'
    + '.bs-btn-danger{background:#fff;color:#b91c1c;border:1px solid #fecaca;}'
    + '.bs-btn-danger:hover{background:#fef2f2;}'
    + '.bs-btn-outline{background:#fff;color:#be185d;border:1px solid #f9a8d4;}'
    + '.bs-btn-outline:hover{background:#fdf2f8;}'
    + '.bs-btn:disabled{opacity:.5;cursor:not-allowed;}'
    // Publishing is the one action here that runs long enough for the author to wonder whether
    // the click landed, and the banner alone sits below the fold on a long post. `cursor:progress`
    // over the WHOLE modal is the signal they already expect from the OS. !important because
    // .bs-btn:disabled (set on the buttons for the same beat) otherwise wins on the buttons.
    + '#bms-blog-backdrop.bs-busy,#bms-blog-backdrop.bs-busy *{cursor:progress !important;}'
    + '.bs-ready-q{font-size:14px;font-weight:600;color:#1f2937;margin:0 0 8px;}'
    + '.bs-stack{display:flex;flex-direction:column;gap:8px;}';

  // Blog Studio opens straight into the editor; AI drafting from a topic is an inline action there.
  var MARKUP = ''
    + '<div class="bms-blog-panel">'
    + '  <button type="button" class="bms-blog-close" id="bs-close" aria-label="Close">&times;</button>'
    + '  <div class="bs-row" style="justify-content:space-between;margin-bottom:16px;padding-right:40px;">'
    + '    <h1 style="font-size:20px;font-weight:700;">Blog Studio</h1>'
    + '    <span id="bs-save-status" class="bs-status"></span>'
    + '  </div>'
    // The old "Start a new post" brief screen is gone: opening Blog Studio drops straight into the
    // editor on a fresh draft. AI drafting from a topic now lives inline in the editor (bs-ai-draft).
    + '  <div id="bs-workspace" class="bs-grid bs-hidden">'
    + '    <div>'
    + '      <div class="bs-panel" style="margin-bottom:16px;">'
    + '        <h3>Widget</h3>'
    + '        <div class="bs-field"><label>Accent colour</label><input id="bs-accent" type="color" value="#ec4899"></div>'
    // Options are injected by populateFontPicker() from window.BlogFonts (generated from
    // src/config/blog-fonts.ts). Hand-writing them here is what left the picker at three choices —
    // two of which rendered identically, because nothing ever downloaded the font.
    + '        <div class="bs-field"><label>Font family</label><select id="bs-font"></select></div>'
    + '        <div class="bs-field"><label><input id="bs-badge" type="checkbox" checked> Show AI transparency badge</label></div>'
    // Where you republish the widget on your own site. Both fields let a post\'s canonical URL credit
    // YOUR domain instead of our permalink — leave blank to use the Be More Swan permalink.
    + '        <div class="bs-field"><label>Your site URL <span class="bs-status" style="font-weight:400;">(optional)</span></label>'
    + '          <input id="bs-site-base" type="url" placeholder="https://acme.com">'
    + '          <span id="bs-site-base-hint" class="bs-pending bs-hidden">Not saved yet \u2014 needs the full address, e.g. https://acme.com</span></div>'
    + '        <div class="bs-field"><label>Post URL pattern</label>'
    + '          <input id="bs-site-path" placeholder="/blog/{slug}">'
    + '          <span id="bs-site-path-hint" class="bs-pending bs-hidden">Not saved yet \u2014 must start with / and contain {slug}.</span>'
    + '          <span class="bs-status" style="font-size:11px;">Must start with / and contain {slug}. Needed for canonical URLs to point at your site.</span></div>'
    // These settings autosave like everything else in the Studio. The status line is the whole
    // feedback surface, so it has to say "Saving…"/"Saved" where the button used to be — a panel
    // that saves silently and shows nothing reads as a panel that has stopped saving.
    + '        <span id="bs-widget-status" class="bs-status"></span>'
    // The snippet is a two-line <script> tag nobody should have to select by hand — a copy
    // button is the difference between "paste this into your site" and a transcription bug
    // in a key that fails silently (widget-api 404s and the blog renders "Unable to load posts").
    + '        <div style="margin-top:12px;">'
    + '          <div class="bs-row" style="justify-content:space-between;">'
    + '            <label class="bs-status">Embed snippet</label>'
    + '            <button id="bs-snippet-copy" class="bs-linkbtn" type="button">Copy</button></div>'
    + '          <div id="bs-snippet" class="bs-snippet">Create a widget to get your embed code.</div>'
    + '          <span class="bs-status" style="font-size:11px;">Paste this into any page on your site, alongside a &lt;div id="bms-blog"&gt;&lt;/div&gt; for it to render into.</span></div>'
    // The RSS feed of published posts. Anything that reads a feed (Mailchimp, Zapier, an aggregator,
    // a reader) can pull the blog without a dedicated connector — see widget-rss.ts.
    + '        <div style="margin-top:12px;">'
    + '          <div class="bs-row" style="justify-content:space-between;">'
    + '            <label class="bs-status">RSS feed</label>'
    + '            <button id="bs-rss-copy" class="bs-linkbtn" type="button">Copy</button></div>'
    + '          <div id="bs-rss" class="bs-snippet">Create a widget to get your feed URL.</div>'
    + '          <span class="bs-status" style="font-size:11px;">Published posts only. Media is left out and AI-assisted posts carry the disclosure notice.</span></div>'
    + '      </div>'
    // ONE media panel, not two. There used to be a "Feature image" row of five buttons and an
    // "Inline body media" row of the same five, differing only in where the result landed — so the
    // author had to decide the destination BEFORE seeing the media, and the same five sources were
    // on screen twice. Now there is a single set of sources; every result lands in one picker, and
    // each tile carries the two destinations it can go to (click → into the post, "Feature" → the
    // hero). The hero slot is also a drop target, so a drag does the same job.
    + '      <div class="bs-panel">'
    + '        <h3>Images &amp; media</h3>'
    + '        <p class="bs-help">Find something below, then <strong>click it to drop it into your post</strong>'
    + ' — or drag it onto the feature image, or press <strong>Feature</strong> on the tile.</p>'
    + '        <div class="bs-row">'
    + '          <button id="bs-media-library" class="bs-btn bs-btn-ghost bs-btn-sm"><span class="bs-btn-ico">\uD83D\uDDC2</span>Library</button>'
    + '          <button id="bs-media-upload" class="bs-btn bs-btn-ghost bs-btn-sm"><span class="bs-btn-ico">\u2B06\uFE0F</span>Upload</button>'
    + '          <button id="bs-media-canva" class="bs-btn bs-btn-ghost bs-btn-sm"><span class="bs-btn-ico">\uD83C\uDFA8</span>Canva</button>'
    // These two are the assistant doing the work, not an anonymous "AI" — the label is rewritten
    // with the assistant's real name by applyAssistantNaming() as soon as one resolves.
    + '          <button id="bs-media-pexels" class="bs-btn bs-btn-ghost bs-btn-sm"><span class="bs-btn-ico">\uD83D\uDD0D</span>'
    + '<span data-bs-assistant-label="stock">Ask your assistant to search stock</span></button>'
    + '          <button id="bs-media-ai" class="bs-btn bs-btn-ghost bs-btn-sm">'
    + '<img src="/images/BeMoreSwan_SwanAI.png" alt="" style="width:15px;height:15px;object-fit:contain;">'
    + '<span data-bs-assistant-label="generate">Ask your assistant to generate</span></button>'
    // Images, video and audio all land in the body; the hero stays images-only (blog-media rejects
    // anything else for the feature role). Audio is upload-only by decision (plan §7.4) — there is
    // no stock provider and no AI generation for it. MIME list mirrors content-upload-url.ts's
    // ALLOWED_MIME_TYPES — widening it here without widening that would just move the rejection to
    // a worse place.
    + '          <input type="file" id="bs-media-upload-input" class="bs-hidden" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/mp4,audio/wav,audio/webm,audio/ogg">'
    + '        </div>'
    // AI image generation is a capability an org may simply not have. The button above is
    // disabled on open in that case and this line says why, so nobody writes a prompt only to
    // meet generate-ai-image's 403 — see applyMediaCapabilities().
    + '        <p id="bs-ai-unavailable" class="bs-help bs-hidden" style="margin-top:10px;"></p>'
    + '        <div id="bs-ai-form" class="bs-field bs-hidden" style="margin-top:12px;">'
    + '          <input id="bs-ai-prompt" placeholder="Describe the image\u2026">'
    + '          <button id="bs-ai-go" class="bs-btn bs-btn-ghost bs-btn-sm" style="margin-top:8px;">Generate</button></div>'
    + '        <div id="bs-pexels-form" class="bs-field bs-hidden" style="margin-top:12px;">'
    + '          <input id="bs-pexels-query" placeholder="Search stock photos\u2026">'
    + '          <button id="bs-pexels-go" class="bs-btn bs-btn-ghost bs-btn-sm" style="margin-top:8px;">Search</button></div>'
    + '        <div id="bs-media-picker" class="bs-media-picker bs-hidden"></div>'
    + '        <span id="bs-media-status" class="bs-status"></span>'
    // The hero. It was previously an unexplained empty box above a row of buttons, with no hint
    // that it was fillable, and a "Remove" that hid among five identical grey buttons.
    + '        <div class="bs-subhead">Feature image</div>'
    + '        <p class="bs-help">The banner shown at the top of the published post and on your blog'
    + ' index. Drag an image onto the box below, or press <strong>Feature</strong> on any tile above.</p>'
    + '        <div id="bs-feature-drop" class="bs-feature-drop">'
    + '          <div id="bs-feature-preview" class="bs-feature-empty">Drop an image here to make it the feature image.</div>'
    + '          <button type="button" id="bs-feature-remove" class="bs-feature-remove bs-hidden">\u2715 Remove feature image</button>'
    + '        </div>'
    // Column layouts. Media and text blocks are then dragged in by their handles; the row stacks
    // on a phone.
    + '        <div class="bs-subhead">Side-by-side layout</div>'
    + '        <p class="bs-help">Adds an empty row of columns after the section you last clicked in.'
    + ' Fill it by dragging paragraphs or images into a column using the <strong>\u22EE\u22EE</strong> handle'
    + ' that appears to the left of each section. To take a row out again, hover it in the draft and'
    + ' press the <strong>\u2715</strong> on its right.</p>'
    + '        <div class="bs-row">'
    + '          <button id="bs-cols-2" class="bs-btn bs-btn-ghost bs-btn-sm"><span class="bs-btn-ico">\u25A5</span>Add 2 columns</button>'
    + '          <button id="bs-cols-3" class="bs-btn bs-btn-ghost bs-btn-sm"><span class="bs-btn-ico">\u25A4</span>Add 3 columns</button>'
    + '        </div>'
    + '      </div>'
    // Syndication connectors moved to the assistant Connections tab; posts now auto-publish to
    // every connected blog on publish (no per-post panel here). See integrations.js / connection-map.
    + '      <div class="bs-panel" style="margin-top:16px;">'
    + '        <h3>Search performance</h3>'
    + '        <div id="bs-gsc-status" class="bs-status">Checking&hellip;</div>'
    + '        <div class="bs-row" style="margin-top:10px;">'
    + '          <button id="bs-gsc-connect" class="bs-btn bs-btn-ghost bs-btn-sm bs-hidden" type="button">'
    + '<span class="bs-btn-ico">\uD83D\uDD17</span>Connect Google Search Console</button>'
    + '          <button id="bs-gsc-disconnect" class="bs-linkbtn bs-hidden" type="button">Disconnect</button>'
    + '        </div>'
    + '        <div class="bs-status" style="font-size:11px;margin-top:4px;">Lets your Blog Writer spot posts losing search traffic and flag them for a refresh.</div>'
    + '      </div>'
    + '    </div>'
    + '    <div>'
    + '      <div class="bs-row" style="justify-content:space-between;margin-bottom:4px;">'
    + '        <span id="bs-readout" class="bs-chip">0 words · under a minute read</span>'
    + '        <div class="bs-row" style="gap:12px;">'
    // "AI draft" and "Ask Swan to improve" named nobody. The work is done by the workspace's own
    // Blog Writer, who has a name the user chose — so the buttons say so. The <span>s carry
    // data-bs-assistant-label and are rewritten by applyAssistantNaming(); the wording here is the
    // fallback for the case where no assistant can be resolved at all.
    + '          <button type="button" id="bs-ai-draft" class="bs-swan"'
    + '            title="Draft this post from a topic">'
    + '            <img src="/images/BeMoreSwan_SwanAI.png" alt="">'
    + '<span data-bs-assistant-label="draft">Ask your assistant to draft</span></button>'
    + '          <button type="button" id="bs-swan-improve" class="bs-swan bs-hidden"'
    + '            title="Ask your assistant to suggest improvements to this draft">'
    + '            <img src="/images/BeMoreSwan_SwanAI.png" alt="">'
    + '<span data-bs-assistant-label="improve">Ask your assistant to improve</span></button>'
    + '        </div>'
    + '      </div>'
    + '      <input id="bs-title" class="bs-title-input" placeholder="Post title">'
    // Inline AI-draft prompt (hidden until "AI draft" is clicked). Replaces the old brief screen —
    // collects a topic/keywords and drafts straight into the open editor via generate-blog.
    + '      <div id="bs-ai-draft-form" class="bs-panel bs-hidden" style="margin-bottom:12px;">'
    + '        <div class="bs-field"><label>Topic</label><input id="bs-ai-topic" placeholder="e.g. AI for small teams"></div>'
    + '        <div class="bs-field"><label>Keywords (optional)</label><input id="bs-ai-keywords" placeholder="comma,separated"></div>'
    + '        <div class="bs-row" style="margin-top:8px;">'
    + '          <button type="button" id="bs-ai-draft-go" class="bs-btn bs-btn-primary">Draft it</button>'
    + '          <button type="button" id="bs-ai-draft-cancel" class="bs-btn bs-btn-ghost">Cancel</button>'
    + '        </div>'
    + '        <div id="bs-ai-draft-status" class="bs-status" style="margin-top:6px;"></div>'
    + '      </div>'
    + '      <div id="bs-editor" class="bs-editor"></div>'
    + '      <div class="bs-row" style="margin-top:16px;">'
    // "Generate A/B hooks" told the author nothing about what would happen, and the only trace the
    // feature left was a toast reading "3 hook variants ready" — three of WHAT, ready for what.
    + '        <button id="bs-generate-hooks" class="bs-btn bs-btn-ghost"'
    + '          title="Write three alternative headlines and openings, then let your readers pick the winner">Test 3 headlines</button>'
    + '        <button id="bs-generate-seo" class="bs-btn bs-btn-ghost">Generate SEO</button>'
    + '      </div>'
    // The A/B test, made visible. It was running invisibly: the variants were never shown, no state
    // was reported, and the winner was promoted by a cron the author had no way of observing.
    + '      <div id="bs-hooks-panel" class="bs-panel bs-hidden" style="margin-top:16px;">'
    + '        <h3>Headline test</h3>'
    + '        <p id="bs-hooks-explainer" class="bs-status" style="line-height:1.5;margin-bottom:10px;"></p>'
    + '        <div id="bs-hooks-list"></div>'
    + '      </div>'
    // Crawler-facing metadata (US 1.3). Generate SEO fills these in; the author can override before
    // publishing. Saved via save-blog-draft; emitted server-side by the /b/:key/:slug permalink.
    + '      <div class="bs-panel" style="margin-top:16px;">'
    + '        <h3>SEO &amp; social preview</h3>'
    + '        <div class="bs-field"><label>Search title <span id="bs-meta-title-count" class="bs-status" style="font-weight:400;"></span></label>'
    + '          <input id="bs-meta-title" maxlength="120" placeholder="Shown as the clickable headline in Google"></div>'
    + '        <div class="bs-field"><label>Search description <span id="bs-meta-desc-count" class="bs-status" style="font-weight:400;"></span></label>'
    + '          <textarea id="bs-meta-desc" maxlength="320" rows="3" placeholder="The summary beneath the title in search results"></textarea></div>'
    + '        <div class="bs-field"><label>Search visibility</label>'
    + '          <select id="bs-robots">'
    + '            <option value="index,follow">Indexed — show in search results (default)</option>'
    + '            <option value="noindex,follow">Hidden from search — live but not indexed</option>'
    + '            <option value="index,nofollow">Indexed, don\'t follow links</option>'
    + '            <option value="noindex,nofollow">Fully hidden from search engines</option>'
    + '          </select></div>'
    + '        <div class="bs-field"><label>Canonical URL</label>'
    + '          <div id="bs-canonical" class="bs-status" style="word-break:break-all;">Set when the post is published.</div></div>'
    + '        <span id="bs-seo-status" class="bs-status"></span>'
    + '      </div>'
    // Where the post is published, as a per-post choice. Connecting a blog in the assistant's
    // Connections tab used to opt it in permanently and silently — every published post went to
    // every connected platform with nothing on screen saying so, and no way to hold one back.
    + '      <div class="bs-panel" style="margin-top:16px;">'
    + '        <h3>Where this post gets published</h3>'
    + '        <p class="bs-help">Your own blog always gets it. Tick any other connected platform'
    + ' you want this post sent to when it goes live.</p>'
    + '        <label class="bs-dest" style="border-color:#fbcfe8;background:#fdf2f8;cursor:default;">'
    + '          <input type="checkbox" checked disabled>'
    + '          <span class="bs-dest-name">Your blog<span class="bs-dest-note">Your embedded widget and its public permalink \u2014 always included.</span></span>'
    + '        </label>'
    + '        <div id="bs-dist-list" class="bs-stack" style="margin-top:8px;"></div>'
    + '        <div id="bs-dist-status" class="bs-status" style="margin-top:8px;">Checking connected platforms\u2026</div>'
    + '      </div>'
    // Scheduling mirrors the Create Post sheet: one guided question, not three loose button rows.
    + '      <div class="bs-panel" style="margin-top:16px;">'
    + '        <p class="bs-ready-q">Your post is ready. How should it go out?</p>'
    // bs-row, NOT bs-stack. A column stack stretches its children to the panel width, so these
    // three ran edge-to-edge while "Archive draft" — the one button that lives in a row below —
    // sat at its natural size. Four buttons doing the same job at two different widths reads as
    // two different kinds of control. All four are now natural-width in wrapping rows.
    + '        <div class="bs-row">'
    + '          <button id="bs-approve" class="bs-btn bs-btn-outline">Let <span id="bs-approve-name">your assistant</span> schedule it</button>'
    + '          <button id="bs-pick-time" class="bs-btn bs-btn-ghost">Pick a time myself</button>'
    + '          <button id="bs-publish" class="bs-btn bs-btn-primary">Publish now</button>'
    + '        </div>'
    + '        <div id="bs-schedule-picker" class="bs-hidden" style="margin-top:12px;">'
    + '          <div class="bs-field"><label>Scheduled date &amp; time</label>'
    + '            <input id="bs-schedule-at" type="datetime-local"></div>'
    + '          <div class="bs-row">'
    + '            <button id="bs-schedule" class="bs-btn bs-btn-primary">Confirm schedule</button>'
    + '            <button id="bs-schedule-back" class="bs-btn bs-btn-ghost">Back</button>'
    + '          </div>'
    + '        </div>'
    + '        <div class="bs-row" style="margin-top:12px;">'
    + '          <button id="bs-unschedule" class="bs-btn bs-btn-ghost bs-hidden">Unschedule</button>'
    + '          <button id="bs-repush" class="bs-btn bs-btn-ghost bs-hidden">Send to connected platforms</button>'
    + '          <button id="bs-unpublish" class="bs-btn bs-btn-ghost bs-hidden">Unpublish</button>'
    + '          <button id="bs-discard" class="bs-btn bs-btn-danger">Archive draft</button>'
    + '        </div>'
    + '        <div id="bs-action-status" class="bs-banner bs-hidden"></div>'
    + '      </div>'
    + '    </div>'
    + '  </div>'
    + '</div>';

  // ── Voice / tone: sourced from the supporting assistant's profile, else author-supplied ────────
  function selectedAssistant() {
    return state.assistantId != null ? state.assistants[state.assistantId] : null;
  }

  // Tone for AI drafting: the assistant's saved profile tone, or empty (the generator picks a default).
  function assistantTone() {
    var a = selectedAssistant();
    return (a && a.tone) ? a.tone : '';
  }

  // ── Naming the assistant on every button that asks it to do something ─────────────────────────
  // "AI draft", "Ask Swan to improve", "Stock photo", "AI generate" — four labels for work done by
  // ONE named colleague the user hired and named themselves. Each button's text node carries
  // data-bs-assistant-label; this is the single place that writes them.
  var ASSISTANT_LABELS = {
    draft: function (n) { return 'Ask ' + n + ' to draft'; },
    improve: function (n) { return 'Ask ' + n + ' to improve'; },
    stock: function (n) { return 'Ask ' + n + ' to search stock'; },
    generate: function (n) { return 'Ask ' + n + ' to generate'; },
  };

  function assistantName() {
    var a = selectedAssistant();
    if (a && a.name) return a.name;
    return state.assistantName || '';
  }

  function applyAssistantNaming() {
    var name = assistantName() || 'your assistant';
    var root = el('bms-blog-backdrop');
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-bs-assistant-label]'), function (n) {
      var make = ASSISTANT_LABELS[n.getAttribute('data-bs-assistant-label')];
      if (make) n.textContent = make(name);
    });
    var approve = el('bs-approve-name');
    if (approve) approve.textContent = name;
  }

  // Some entry points pass an assistantId (Assistant Detail, Review Queue); the Calendar and the
  // standalone page pass only a postId, or nothing at all. Fall back to the org's first active
  // Blog Writer so the buttons still name somebody real. Resolved once per session: '' records
  // "looked and found none" so a workspace without a Blog Writer doesn't refetch on every open.
  function ensureAssistantIdentity() {
    if (assistantName()) { applyAssistantNaming(); return Promise.resolve(); }
    if (state.assistantName === '') { applyAssistantNaming(); return Promise.resolve(); }
    return resolveBlogWriter().then(function (a) {
      state.assistantName = (a && a.name) || '';
      applyAssistantNaming();
    });
  }

  // ── "Ask Swan to improve": hand the draft to the assistant in chat ────────────────────────────
  // Same affordance as the Create Post sheet's gpAskSwanImprove. The chat modal lives in
  // workspace.html, so on the standalone blog-studio.html page the button stays hidden.
  function swanAvailable() {
    return typeof window.openAssistantChatModal === 'function' && state.assistantId != null;
  }
  function syncSwanButton() {
    var btn = el('bs-swan-improve');
    if (btn) btn.classList.toggle('bs-hidden', !swanAvailable());
  }
  // blog-tone returns only { id, name, tone }; the chat modal also wants role/roleKey for its header
  // and prompt, so resolve those from get-assistants (cached per id).
  var metaCache = {};
  function resolveAssistantMeta(id) {
    if (metaCache[id]) return Promise.resolve(metaCache[id]);
    var fallback = { name: 'Your assistant', role: 'Digital Assistant', roleKey: null };
    return fetch('/.netlify/functions/get-assistants', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { assistants: [] }; })
      .then(function (d) {
        var a = (d.assistants || []).filter(function (x) { return Number(x.id) === Number(id); })[0];
        var meta = a ? { name: a.name || fallback.name, role: a.role || fallback.role, roleKey: a.roleKey || null } : fallback;
        metaCache[id] = meta;
        return meta;
      })
      .catch(function () { return fallback; });
  }
  function askSwanImprove() {
    if (!swanAvailable()) return;
    var title = el('bs-title').value.trim();
    var md = state.editor ? state.editor.getMarkdown().trim() : '';
    resolveAssistantMeta(state.assistantId).then(function (meta) {
      var session = window.openAssistantChatModal(state.assistantId, meta.name, meta.role, meta.roleKey);
      if (!md && !title) return;   // nothing to critique yet — just open the chat
      // The body normally opens with the title as its own H1, so only prepend the title when it
      // isn't already the first heading — otherwise the draft reads as if it were titled twice.
      var firstHeading = (md.match(/^#\s+(.*)$/m) || [])[1];
      var needsTitle = title && (!firstHeading || firstHeading.trim() !== title);
      var parts = ['Here’s a draft blog post I’m working on. Please suggest improvements and give me a stronger version I can use.', ''];
      if (needsTitle) parts.push('# ' + title, '');
      parts.push(md || '(no body yet)');
      var seed = parts.join('\n');
      setTimeout(function () { try { if (session) session.sendMessage(seed); } catch (_) {} }, 60);
    });
  }

  function loadAssistants() {
    return api('blog-tone', { method: 'GET' }).then(function (res) {
      if (res.ok && Array.isArray(res.body.assistants)) {
        res.body.assistants.forEach(function (a) { state.assistants[a.id] = a; });
      }
    }).catch(function () { /* tone is best-effort */ });
  }

  // Reveal the editor workspace for a post (new or existing): mount the editor + side panels.
  function openWorkspace(postId, title, md, post) {
    state.postId = postId;
    el('bs-workspace').classList.remove('bs-hidden');
    el('bs-title').value = title;
    if (state.editor && state.editor.destroy) state.editor.destroy();  // re-open safety: no leaked listeners
    state.editor = window.MarkdownEditor.mount({
      container: el('bs-editor'),
      blogPostId: postId,
      initialMarkdown: md,
      title: title,
      placeholder: 'Write your post here… (Markdown supported — or ask your assistant to draft it)',
      onChange: function (nextMd) {
        refreshReadout(nextMd);
        setStatus('bs-save-status', 'Saving…');
        setTimeout(function () { setStatus('bs-save-status', 'Saved'); }, 1400);
      },
      onDropMedia: onEditorDropMedia,
    });
    refreshReadout(md);
    syncSwanButton();
    ensureAssistantIdentity();
    loadWidget();
    loadDistribution(post);
    loadFeature();
    loadSearchConsole();
    populateSeo(post);
    // Remembered because the headline-test copy differs before and after publication: a draft's test
    // has not started yet, and saying it is live would be a plain lie about what readers are seeing.
    state.postStatus = (post && post.status) || null;
    renderHooks(post);
    return state.editor;
  }

  // Open Blog Studio straight onto a fresh, empty draft (no brief screen). The editor takes the
  // caret so the author can just start typing — or use the inline "AI draft" action.
  function startBlankPost() {
    // A blank post starts with a clean workspace: no stale schedule/publish affordances.
    el('bs-unschedule').classList.add('bs-hidden');
    el('bs-unpublish').classList.add('bs-hidden');
    el('bs-repush').classList.add('bs-hidden');
    el('bs-schedule-picker').classList.add('bs-hidden');
    el('bs-schedule-at').value = '';
    setStatus('bs-save-status', 'Creating…');
    api('blog-posts', { method: 'POST', body: JSON.stringify({ title: 'Untitled draft', assistantId: state.assistantId }) }).then(function (res) {
      if (!res.ok) { setBanner('bs-action-status', 'Could not create a draft: ' + ((res.body && res.body.error) || 'please try again.'), 'error'); return; }
      setStatus('bs-save-status', '');
      var editor = openWorkspace(res.body.post.id, 'Untitled draft', '');
      if (editor && editor.focus) editor.focus();   // drop straight into typing
    });
  }

  // Inline "AI draft": collect a topic/keywords in the editor and draft straight into the open post
  // via generate-blog — the capability the old brief screen used to host.
  function runAiDraft() {
    if (!state.postId) return;
    var topic = el('bs-ai-topic').value.trim();
    if (!topic) { setStatus('bs-ai-draft-status', 'Add a topic to draft from.'); return; }
    setStatus('bs-ai-draft-status', 'Drafting…');
    api('generate-blog', { method: 'POST', body: JSON.stringify({
      blogPostId: state.postId,
      topic: topic,
      keywords: el('bs-ai-keywords').value.trim(),
      notes: '',
      tone: assistantTone(),
    }) }).then(function (gen) {
      if (gen.ok && gen.body.bodyMarkdown) {
        if (!el('bs-title').value.trim() || el('bs-title').value.trim() === 'Untitled draft') el('bs-title').value = topic;
        state.editor.setMarkdown(gen.body.bodyMarkdown);
        refreshReadout(gen.body.bodyMarkdown);   // setMarkdown doesn't fire onChange
        setStatus('bs-ai-draft-status', '');
        el('bs-ai-draft-form').classList.add('bs-hidden');
      } else {
        setStatus('bs-ai-draft-status', (gen.body && gen.body.error) || 'Draft failed — try again.');
      }
    });
  }

  function loadExistingPost(id) {
    setStatus('bs-save-status', 'Loading…');
    api('blog-posts?id=' + encodeURIComponent(id), { method: 'GET' }).then(function (res) {
      if (!res.ok || !res.body.post) { setStatus('bs-save-status', ''); return; }
      var post = res.body.post;
      if (post.assistantId != null) state.assistantId = post.assistantId;
      openWorkspace(post.id, post.title || 'Untitled draft', post.bodyMarkdown || '', post);
      setStatus('bs-save-status', 'Saved');
      if (post.status) setBanner('bs-action-status', 'Status: ' + post.status);
      // A post already on the calendar can be pulled back off it.
      if (post.status === 'scheduled') el('bs-unschedule').classList.remove('bs-hidden');
      // A live post can be taken back off the site.
      if (post.status === 'published') {
        el('bs-unpublish').classList.remove('bs-hidden');
        el('bs-repush').classList.remove('bs-hidden');
      }
    }).catch(function () { setStatus('bs-save-status', ''); });
  }

  // ── Widget config / theming ────────────────────────────────────────────────────────────────────
  function renderSnippet(key) {
    el('bs-snippet').textContent =
      '<script async src="' + location.origin + '/widget.js"\n        data-bms-key="' + key + '" data-bms-mount="#bms-blog"><\/script>';
    el('bs-rss').textContent = location.origin + '/api/widget/' + key + '/rss';
  }
  // Where the customer publishes. Both fields were left blank until someone typed them in, which
  // meant every canonical URL quietly credited OUR permalink instead of their domain — the opposite
  // of the point. The business URL is already on file (Business Information → organisations.
  // website_url), so asking a second time is asking for a value we hold.
  //
  // These are SUGGESTIONS painted into the inputs on OPEN, never a silent write, and the autosave
  // does not change that: applyWidget assigns .value directly, which fires neither `input` nor
  // `change`, so a suggestion sits there until the author touches it and a stored value always
  // wins. Suggestions are deliberately not re-applied after a save (applyWidget's `suggest` flag)
  // — clearing a field, saving, and watching it refill itself reads as the clear being ignored.
  var DEFAULT_SITE_POST_PATH = '/blog/{slug}';

  // save-widget-config demands a full http(s) URL; Business Information accepts a bare host
  // ("acme.com"). Normalise here rather than let a perfectly good default fail validation on save.
  function normaliseSiteBase(raw) {
    var v = String(raw || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(v)) return '';
    return v.replace(/\/+$/, '');
  }

  // Fetched once per session. A failure is non-fatal — the field simply stays empty, exactly as it
  // behaved before, so a business-profile outage can never block the Widget panel from painting.
  function loadOrgWebsite() {
    if (state.orgWebsite !== undefined) return Promise.resolve(state.orgWebsite);
    return api('organisation-profile', { method: 'GET' })
      .then(function (res) {
        var profile = (res.ok && res.body && res.body.profile) || null;
        state.orgWebsite = normaliseSiteBase(profile && profile.websiteUrl) || null;
        return state.orgWebsite;
      })
      .catch(function () { state.orgWebsite = null; return null; });
  }

  // The org's own colours and typeface, extracted from their website (organisations.brand_kit).
  // Only a REAL kit is kept: source 'default' is the neutral monochrome placeholder, and treating
  // it as a brand choice would paint every unconfigured blog near-black on purpose.
  function loadBrandKit() {
    if (state.brandKit !== undefined) return Promise.resolve(state.brandKit);
    return api('brand-kit', { method: 'GET' })
      .then(function (res) {
        var kit = (res.ok && res.body && res.body.brandKit) || null;
        state.brandKit = (kit && kit.source && kit.source !== 'default') ? kit : null;
        return state.brandKit;
      })
      .catch(function () { state.brandKit = null; return null; });
  }

  // The theme this org's blog should start on, from their brand kit — the client-side twin of
  // brandSeedTheme() in save-widget-config.ts, which seeds it for widgets created from now on.
  // This covers the ones created BEFORE that, whose theme is still {}.
  function brandTheme() {
    var kit = state.brandKit;
    if (!kit) return null;
    var theme = {};
    if (kit.primaryColor) theme.accent = kit.primaryColor;
    var font = window.BlogFonts && window.BlogFonts.matchFamily
      ? window.BlogFonts.matchFamily(kit.fontFamily) : null;
    if (font) theme.fontFamily = font.stack;
    return (theme.accent || theme.fontFamily) ? theme : null;
  }

  function loadWidget() {
    // Both in flight together: the config read is the slow one, and the org profile must be in hand
    // before applyWidget paints or the suggestion lands after the user has started typing.
    Promise.all([
      api('save-widget-config', { method: 'GET' }),
      loadOrgWebsite(),
      loadBrandKit(),
    ]).then(function (out) {
      var res = out[0];
      var cfg = res.body.config;
      if (!cfg) {
        return api('save-widget-config', { method: 'POST', body: JSON.stringify({ action: 'create' }) })
          .then(function (r) { if (r.ok) applyWidget(r.body.config, { suggest: true }); });
      }
      applyWidget(cfg, { suggest: true });
    });
  }
  // Fill the Font family picker from the generated catalogue, grouped by category. Called before
  // every applyWidget so the stored value has an option to select — assigning select.value to a
  // family with no matching <option> silently selects NOTHING, which reads as the setting being lost.
  function populateFontPicker() {
    var sel = el('bs-font');
    if (!sel || sel.dataset.populated === '1') return;
    var catalogue = window.BlogFonts;
    if (!catalogue) return;   // generated file not loaded — leave the select alone rather than empty it
    catalogue.categories.forEach(function (category) {
      var fonts = catalogue.inCategory(category);
      if (!fonts.length) return;
      var group = document.createElement('optgroup');
      group.label = category;
      fonts.forEach(function (f) {
        var opt = document.createElement('option');
        opt.value = f.stack;
        opt.textContent = f.label;
        // Preview each family in its own face. Only meaningful once the sheet is loaded, which is
        // what previewFont() below arranges as soon as one is selected.
        opt.style.fontFamily = f.stack;
        group.appendChild(opt);
      });
      sel.appendChild(group);
    });
    sel.dataset.populated = '1';
  }

  // Load the chosen font into the STUDIO so the picker isn't a blind choice — the author sees the
  // face they are about to publish. One <link> per family, kept and reused: re-adding on every
  // change would leave a growing pile of stylesheets in the modal's host page.
  function previewFont(stack) {
    var url = window.BlogFonts && window.BlogFonts.urlFor(stack);
    if (!url || document.querySelector('link[data-bms-font="' + CSS.escape(url) + '"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.setAttribute('data-bms-font', url);
    document.head.appendChild(link);
  }

  // Put the chosen family on the DRAFT. previewFont only downloads the stylesheet; nothing ever
  // applied the face to the editor, so changing "Font family" moved a setting and changed nothing
  // the author could see — a picker of 53 names rendered in a font none of them was.
  function applyFontToEditor(stack) {
    previewFont(stack);
    if (state.editor && state.editor.setFontFamily) state.editor.setFontFamily(stack || '');
  }

  function applyWidget(cfg, opts) {
    var suggest = !!(opts && opts.suggest);
    renderSnippet(cfg.publicKey);
    populateFontPicker();
    var theme = cfg.theme || {};
    // ⚠️ An unset accent is NOT neutral. widget.js and the /b/:key/:slug permalink both fall back
    // to #ec4899 — Be More Swan's pink — so a workspace that never opened this panel was publishing
    // a blog on its OWN domain in our brand colour. When nothing has been chosen, the org's own
    // brand kit is the honest default, and it is WRITTEN BACK rather than only shown: a suggestion
    // sitting unsaved in the picker would leave the panel disagreeing with the live blog.
    // Only an untouched theme is seeded — a stored accent is a decision and is never overwritten.
    var seed = (!theme.accent && !theme.fontFamily) ? brandTheme() : null;
    if (seed) {
      theme = seed;
      // Best effort. A non-admin gets a 403 here (theming is owner/admin), and that is fine —
      // the picker still shows their brand, and saving is their admin's to do.
      api('save-widget-config', {
        method: 'POST',
        body: JSON.stringify({ action: 'update', theme: seed }),
      }).catch(function () {});
    }
    // The merge base for saveWidgetSettings — see the ⚠️ there. Held because the theme column is
    // replaced wholesale on write, so anything this panel cannot re-derive from its own inputs has
    // to be carried forward from what was last read.
    state.widgetTheme = theme;
    if (theme.accent) el('bs-accent').value = theme.accent;
    if (theme.fontFamily) { el('bs-font').value = theme.fontFamily; applyFontToEditor(theme.fontFamily); }
    el('bs-badge').checked = cfg.badgeEnabled !== false;
    el('bs-site-base').value = cfg.siteBaseUrl || (suggest ? (state.orgWebsite || '') : '');
    el('bs-site-path').value = cfg.sitePostPath || (suggest ? DEFAULT_SITE_POST_PATH : '');
    // Autosave is armed only once the panel is showing the org's own settings rather than the
    // markup's defaults. Before this the accent input reads #ec4899 — OUR pink — and the font
    // select is empty, and save-widget-config treats an empty fontFamily as "reset to default".
    // A save fired in that window would quietly overwrite a stored brand with placeholders.
    state.widgetReady = true;
  }

  // ── SEO metadata panel ─────────────────────────────────────────────────────────────────────────
  // Google truncates around 60 chars (title) / 155 (description); show a live count that turns amber
  // past those so the author can see when they overrun without a hard block.
  function refreshSeoCounts() {
    var t = el('bs-meta-title').value.length, d = el('bs-meta-desc').value.length;
    var tc = el('bs-meta-title-count'), dc = el('bs-meta-desc-count');
    tc.textContent = t + '/60'; tc.style.color = t > 60 ? '#b45309' : '';
    dc.textContent = d + '/155'; dc.style.color = d > 155 ? '#b45309' : '';
  }
  function populateSeo(post) {
    el('bs-meta-title').value = (post && post.metaTitle) || '';
    el('bs-meta-desc').value = (post && post.metaDescription) || '';
    el('bs-robots').value = (post && post.robots) || 'index,follow';
    el('bs-canonical').textContent = (post && post.canonicalUrl) || 'Set when the post is published.';
    refreshSeoCounts();
    syncSeoButton();
  }

  // Autopilot drafts now arrive WITH metadata (process-blog-jobs calls generateBlogSeo as soon as
  // the body is written), so for most posts this button is no longer the thing that produces SEO —
  // it is the thing that refreshes it after an edit. Label it for what it does, or it reads as an
  // unfinished step on a draft that is already complete.
  function syncSeoButton() {
    var btn = el('bs-generate-seo');
    if (!btn) return;
    var has = !!(el('bs-meta-title').value || '').trim() || !!(el('bs-meta-desc').value || '').trim();
    btn.textContent = has ? 'Regenerate SEO' : 'Generate SEO';
    btn.title = has
      ? 'Rewrite the search title, description and tags from the current draft.'
      : 'Write a search title, description, slug and tags from this draft.';
  }

  // ── Headline A/B test (US 5.2) ────────────────────────────────────────────────────────────────
  // What the feature actually does, in plain terms, because none of it was on screen: generate-hooks
  // writes three alternative H1 + opening-paragraph pairs to blog_posts.hook_variants and flips
  // ab_state to 'testing'. The embedded widget then serves ONE variant per visitor at random, sticky
  // in localStorage so that reader's dwell time and scroll depth are attributed to one version. Once
  // the variants total 200 impressions, the resolve-ab-tests cron scores them (60% engaged rate, 25%
  // dwell, 15% scroll), stamps winning_variant and flips ab_state to 'decided' — after which every
  // reader gets the winner.
  //
  // Until now the author saw a toast reading "3 hook variants ready" and nothing else: not the three
  // headlines, not that a test was running, not which one won. The work was real and entirely
  // invisible, which is indistinguishable from it not happening.
  function bsEscape(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function hooksExplainer(state_, winner, isPublished) {
    if (state_ === 'decided' && winner) {
      return 'Version ' + bsEscape(winner) + ' won and is now the headline every reader sees. '
        + 'The others are kept for reference.';
    }
    if (!isPublished) {
      return 'These three openings are ready. The test starts when the post is published: readers '
        + 'each see one version at random, and the one that holds attention longest becomes the '
        + 'permanent headline.';
    }
    return 'Live test. Each reader sees one of these three at random — the same one on every visit, '
      + 'so their reading time counts for that version. After around 200 readers in total, whichever '
      + 'keeps people reading longest becomes the permanent headline. Only the headline and opening '
      + 'paragraph change; the rest of the post is identical.';
  }

  function renderHooks(post) {
    var panel = el('bs-hooks-panel');
    var list = el('bs-hooks-list');
    if (!panel || !list) return;
    var variants = (post && post.hookVariants) || [];
    if (!Array.isArray(variants) || !variants.length) {
      panel.classList.add('bs-hidden');
      list.innerHTML = '';
      return;
    }
    var abState = post.abState || 'testing';
    var winner = post.winningVariant || null;
    panel.classList.remove('bs-hidden');
    el('bs-hooks-explainer').innerHTML = hooksExplainer(abState, winner, post.status === 'published');
    list.innerHTML = variants.map(function (v) {
      var won = abState === 'decided' && winner && v.id === winner;
      return '<div class="bs-hook' + (won ? ' bs-hook-win' : '') + '">'
        + '<span class="bs-hook-tag">Version ' + bsEscape(v.id) + (won ? ' · winner' : '') + '</span>'
        + '<p class="bs-hook-h1">' + bsEscape(v.h1) + '</p>'
        + '<p class="bs-hook-intro">' + bsEscape(v.intro) + '</p>'
        + '</div>';
    }).join('');
  }

  // ── Feature / inline media (reuses content-assets + generate-ai-image + pexels-search) ─────────
  var mediaEls;
  function renderFeature(feature) {
    if (feature && feature.url) {
      mediaEls.preview.className = 'bs-feature-preview';
      mediaEls.preview.innerHTML = '<img src="' + feature.url + '" alt="">';
      mediaEls.remove.classList.remove('bs-hidden');
    } else {
      mediaEls.preview.className = 'bs-feature-empty';
      // Say what the box is FOR. "No feature image yet." reported a state and offered no way out
      // of it, which is why the slot read as something the system fills, not something you can.
      mediaEls.preview.textContent = 'Drop an image here to make it the feature image.';
      mediaEls.remove.classList.add('bs-hidden');
    }
  }
  function loadFeature() {
    if (!state.postId) return;
    api('blog-media?blogPostId=' + state.postId, { method: 'GET' }).then(function (res) {
      if (!res.ok) return;
      renderFeature(res.body.feature);
      var map = {};
      (res.body.inline || []).forEach(function (m) { if (m.url) map[m.assetId] = m.url; });
      if (state.editor && state.editor.setAssetUrls) state.editor.setAssetUrls(map);
    });
  }
  // The picker deliberately STAYS open after a placement. A post takes several images, and closing
  // the grid on each one turned the second image into a fresh search.
  function featureAttached(res) {
    if (res.ok) { renderFeature(res.body.feature); setStatus('bs-media-status', 'Set as the feature image.'); }
    else setStatus('bs-media-status', (res.body && res.body.error) || 'Failed');
  }
  function attachFeature(assetId) {
    setStatus('bs-media-status', 'Attaching…');
    api('blog-media', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId, action: 'attach', role: 'feature', assetId: assetId }) })
      .then(featureAttached);
  }
  function attachFeatureCandidate(candidate) {
    setStatus('bs-media-status', 'Attaching…');
    api('blog-media', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId, action: 'attach', role: 'feature', pexelsCandidate: candidate }) })
      .then(featureAttached);
  }
  // Attach media as inline body media, then insert a block for it. `body` is { assetId } or
  // { pexelsCandidate }. Inline attach appends, so the new asset is the last inline[] item.
  //
  // The server's inline[] carries the asset's real assetType, so we hand that to insertMedia rather
  // than assuming an image: a video needs a `:::media{type=video}` directive, and inserting it as
  // `![](asset://N)` is exactly the bug that made attached videos render as nothing.
  // Attach to the inline role and RESOLVE to an insertMedia descriptor — without inserting it.
  // Split out of attachInline because a drop needs the assetId in hand before anything is written
  // to the Markdown (plan §4.3.3), and it places the media at the dropped gap, not at the caret.
  // Resolves null on failure; every caller treats that as "write nothing".
  function attachInlineAsset(body) {
    if (!state.postId) return Promise.resolve(null);
    return api('blog-media', { method: 'POST', body: JSON.stringify(Object.assign({ blogPostId: state.postId, action: 'attach', role: 'inline' }, body)) })
      .then(function (res) {
        if (!res.ok) { setStatus('bs-media-status', (res.body && res.body.error) || 'Failed'); return null; }
        var inline = (res.body && res.body.inline) || [];
        var item = body.assetId != null
          ? (inline.filter(function (m) { return m.assetId === body.assetId; })[0] || inline[inline.length - 1])
          : inline[inline.length - 1];
        if (!item) return null;
        return { assetId: item.assetId, url: item.url, alt: item.name || '', type: item.assetType || 'image' };
      });
  }

  function attachInline(body) {
    if (!state.postId || !state.editor) return;
    setStatus('bs-media-status', 'Adding…');
    attachInlineAsset(body).then(function (media) {
      if (!media) return;
      var blockId = state.editor.insertMedia(media);
      // Show where it landed. An insert anchored to the last-touched block can easily be off
      // screen, and an image you can't see is an image you assume didn't arrive.
      if (blockId && state.editor.revealBlock) state.editor.revealBlock(blockId);
      setStatus('bs-media-status', 'Added to your post.');
    });
  }

  // The editor's drop hook: turn whatever was dropped into an ATTACHED asset and hand back the
  // descriptor(s). The editor owns placement — this owns only "how does this become an assetId".
  function onEditorDropMedia(payload) {
    if (!state.postId) return Promise.resolve(null);

    if (payload.kind === 'files') {
      // Mirrors content-upload-url's ALLOWED_MIME_TYPES families; anything else has no assetType we
      // can file it under, so reject it here rather than upload something the body can't render.
      var files = payload.files.filter(function (f) { return /^(image|video|audio)\//.test(f.type || ''); });
      if (!files.length) {
        setStatus('bs-media-status', 'Only images, videos and audio can be dropped into a post.');
        return Promise.resolve(null);
      }
      setStatus('bs-media-status', 'Uploading…');
      return Promise.all(files.map(function (f) {
        return uploadContentAsset(f)
          .then(function (asset) { return attachInlineAsset({ assetId: asset.id }); })
          .catch(function (err) { setStatus('bs-media-status', err.message || 'Upload failed.'); return null; });
      })).then(function (list) {
        var ok = list.filter(Boolean);
        setStatus('bs-media-status', ok.length ? '' : 'Nothing could be added.');
        return ok;
      });
    }

    var d = payload.data || {};
    setStatus('bs-media-status', 'Adding…');
    return attachInlineAsset(d.pexelsCandidate ? { pexelsCandidate: d.pexelsCandidate } : { assetId: d.assetId })
      .then(function (media) { setStatus('bs-media-status', media ? '' : 'Failed'); return media; });
  }

  // Make a picker tile draggable into the body. The payload carries only what identifies the item;
  // onEditorDropMedia attaches it and the editor places it. Uses the editor's own exported MIME so
  // the two can't drift — a mismatched string would present as "dragging just does nothing".
  function makeTileDraggable(tile, payload) {
    // EVERY tile is draggable, whichever source produced it. The gate used to be
    // `state.mediaTarget !== 'inline'`, which made the tiles under the FEATURE row's buttons
    // silently inert — two near-identical button rows, only the smaller inline one draggable, and
    // no feedback on the wrong one. That reads as "dragging is broken", not "wrong button".
    // The mode flag is gone entirely now: a tile carries its own destinations.
    tile.draggable = true;
    tile.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData(window.MarkdownEditor.MEDIA_MIME, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'copy';
    });
  }

  // The hero. Split out of the old routeMedia(), which decided the destination from a mode flag
  // set by whichever of the two duplicate button rows had been pressed — the thing that forced the
  // author to choose a destination before they could see the media.
  function routeFeature(body) {
    if (body.pexelsCandidate) return attachFeatureCandidate(body.pexelsCandidate);
    return attachFeature(body.assetId);
  }
  // A picker/editor drag payload → the body blog-media wants. Both sources use the same shape.
  function attachBodyFor(d) {
    return (d && d.pexelsCandidate) ? { pexelsCandidate: d.pexelsCandidate } : { assetId: d && d.assetId };
  }
  // content_assets.assetType is the thing that decides how the body renders the media, so derive it
  // from the file rather than assuming 'image' — an mp4 filed as an image renders as a broken <img>.
  function assetTypeOf(mimeType) {
    var m = String(mimeType || '');
    if (/^video\//.test(m)) return 'video';
    if (/^audio\//.test(m)) return 'audio';
    return 'image';
  }

  // Upload a new file straight into the content library, then attach it (issue #184 — the Blog
  // Writer's media picker needs its own upload entry point now that My Content isn't a nav item).
  function uploadContentAsset(file) {
    return fetch('/.netlify/functions/content-upload-url', {
      credentials: 'same-origin', method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, mimeType: file.type, fileSize: file.size }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.body && res.body.error) || 'Could not get an upload URL.');
        var uploadUrl = res.body.uploadUrl, storageKey = res.body.storageKey, storageUrl = res.body.storageUrl, mock = res.body.mock;
        var putPromise = mock ? Promise.resolve() : fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
          .then(function (r) { if (!r.ok) throw new Error('Upload failed.'); });
        return putPromise.then(function () {
          return api('content-assets', { method: 'POST', body: JSON.stringify({
            name: file.name, assetType: assetTypeOf(file.type), mimeType: file.type,
            fileSize: file.size, storageKey: storageKey, storageUrl: storageUrl,
          }) });
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error((res.body && res.body.error) || 'Could not save the upload.');
        if (res.body.rejected) throw new Error((res.body.asset && res.body.asset.rejectionReason) || 'That image was flagged and could not be used.');
        return res.body.asset;
      });
  }
  function handleUploadInput(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || !state.postId) return;
    mediaEls.picker.classList.add('bs-hidden');
    setStatus('bs-media-status', 'Uploading…');
    uploadContentAsset(file).then(function (asset) {
      // Show it rather than place it. Where an upload belongs is a decision the author can only
      // really make once they can see it, and it is the same decision as for anything else in the
      // grid — so it gets the same tile with the same two actions.
      openLibrary({ only: [asset.id] });
      setStatus('bs-media-status', 'Uploaded — click it to add it to your post, or press Feature.');
    }).catch(function (err) {
      setStatus('bs-media-status', err.message || 'Upload failed. Please try again.');
    });
  }

  // Canva imports land in content_assets like any other source, so once the picker reports back
  // there is nothing Canva-specific left to do — the import shows up as a tile exactly as the
  // Library, Upload, stock and AI paths do. assetType 'image' keeps video designs out: a feature
  // or inline image can't be an mp4.
  function openCanva() {
    if (!state.postId || !window.CanvaBrowser) return;
    mediaEls.picker.classList.add('bs-hidden');
    mediaEls.aiForm.classList.add('bs-hidden');
    mediaEls.pexelsForm.classList.add('bs-hidden');
    window.CanvaBrowser.open({
      assetType: 'image',
      multiple: false,
      onImported: function (assetIds) {
        if (!assetIds || !assetIds.length) return;
        // A multi-page design yields several assets; show them all and let the author place the
        // one they want rather than stuffing every page into the post.
        openLibrary({ only: assetIds });
        setStatus('bs-media-status', 'Imported from Canva — click to add it to your post, or press Feature.');
      },
    });
  }
  // ── The picker: one grid, one tile shape, two destinations per tile ───────────────────────────
  // Every source (Library, Upload, Canva, stock search, AI generation) now ends here rather than
  // dropping its result straight into a destination the author chose beforehand. An `item` is:
  //   { type, url, name, title, body }  where `body` is the blog-media attach body.
  function mediaNodeFor(item) {
    var isVideo = item.type === 'video';
    var isAudio = item.type === 'audio';
    // A <video> with preload=metadata shows its first frame, which is a usable thumbnail —
    // content_assets has no separate poster to fall back on. Audio has no frame at all, so it gets
    // a labelled tile; a real <audio> here would be a player the author has to avoid clicking.
    var node = document.createElement(isAudio ? 'div' : (isVideo ? 'video' : 'img'));
    if (isAudio) {
      node.className = 'bs-media-audio';
      node.textContent = '\u266A ' + (item.name || 'Audio');
    } else {
      node.src = item.url;
      if (isVideo) { node.preload = 'metadata'; node.muted = true; }
      else { node.alt = item.name || ''; }
    }
    return node;
  }

  function renderTiles(items, emptyMessage) {
    mediaEls.picker.classList.remove('bs-hidden');
    mediaEls.picker.innerHTML = '';
    if (!items.length) {
      mediaEls.picker.innerHTML = '<div class="bs-media-empty">' + (emptyMessage || 'Nothing to show.') + '</div>';
      return;
    }
    items.forEach(function (item) {
      var tile = document.createElement('div');
      tile.className = 'bs-tile';
      var node = mediaNodeFor(item);
      node.title = (item.title || item.name || '') + (item.title || item.name ? ' \u2014 ' : '') + 'Click to add to your post';
      node.addEventListener('click', function () { attachInline(item.body); });
      makeTileDraggable(node, Object.assign({ source: item.source || 'library', type: item.type || 'image' }, item.body));
      tile.appendChild(node);
      // The hero must be an image — blog-media refuses any other assetType for the feature role,
      // so offering "Feature" on a video would be offering an action that always fails.
      if ((item.type || 'image') === 'image') {
        var feature = document.createElement('button');
        feature.type = 'button';
        feature.className = 'bs-tile-feature';
        feature.textContent = 'Feature';
        feature.title = 'Use this as the feature image';
        feature.addEventListener('click', function (e) {
          e.stopPropagation();          // the tile's own click adds to the post — not both
          routeFeature(item.body);
        });
        tile.appendChild(feature);
      }
      mediaEls.picker.appendChild(tile);
    });
  }

  // `opts.only` narrows the grid to specific asset ids — how a fresh upload, Canva import or saved
  // AI image is presented: the same tile with the same two actions, rather than a silent insert
  // into a destination that was chosen before the author had seen the image.
  function openLibrary(opts) {
    if (!state.postId) return;
    var only = (opts && opts.only) || null;
    mediaEls.aiForm.classList.add('bs-hidden');
    mediaEls.pexelsForm.classList.add('bs-hidden');
    mediaEls.picker.classList.remove('bs-hidden');
    mediaEls.picker.innerHTML = '<div class="bs-media-empty">Loading\u2026</div>';
    api('content-assets', { method: 'GET' }).then(function (res) {
      if (!res.ok) { mediaEls.picker.innerHTML = '<div class="bs-media-empty">Could not load library.</div>'; return; }
      var groups = res.body.assets || {};
      var all = [].concat(groups.pending || [], groups.scheduled || [], groups.posted || []);
      var items = all.filter(function (a) {
        if (!(a.storageUrl || a.externalUrl)) return false;
        if (only && only.indexOf(a.id) < 0) return false;
        return a.assetType === 'image' || a.assetType === 'video' || a.assetType === 'audio';
      }).map(function (a) {
        return {
          type: a.assetType || 'image', url: a.storageUrl || a.externalUrl,
          name: a.name || '', title: a.name || '', body: { assetId: a.id },
        };
      });
      renderTiles(items, only
        ? 'That upload is still processing \u2014 open Library in a moment to place it.'
        : 'No images, videos or audio in your library yet.');
    });
  }

  // ── AI image generation: resolve the capability BEFORE offering it ───────────────────────────
  // Generating images is an admin-managed capability of an assistant TYPE (assistant_features), so
  // an org can have an active Blog Writer and still not be allowed to generate. My Content already
  // preflights this on modal-open and hides its AI tab (_mcLoadCapabilities / _mcApplyTabVisibility
  // in my-content.js); the Studio offered a live-looking button either way, and the author found
  // out from generate-ai-image's raw 403 sentence after writing a prompt.
  //
  // The button is DISABLED rather than removed: unlike My Content's tab strip, this row is the
  // author's map of where images come from, and a source that silently isn't there reads as a bug.
  var AI_UNAVAILABLE = 'None of your assistants can generate images \u2014 use Library, Upload, '
    + 'Canva or stock search instead, or ask an admin to enable AI image generation.';

  function loadMediaCapabilities() {
    return api('get-ai-credit-balance', { method: 'GET' })
      .then(function (res) { state.canImage = !!(res.ok && res.body && res.body.canImage); })
      // Failed lookup means "not offered", never "offered": generate-ai-image is the real gate,
      // and a hopeful button here would only move the 403 later.
      .catch(function () { state.canImage = false; })
      .then(applyMediaCapabilities);
  }

  function applyMediaCapabilities() {
    var can = !!state.canImage;
    var btn = el('bs-media-ai');
    if (btn) {
      btn.disabled = !can;                     // .bs-btn:disabled already dims it and kills the cursor
      if (can) btn.removeAttribute('title'); else btn.setAttribute('title', AI_UNAVAILABLE);
    }
    var note = el('bs-ai-unavailable');
    if (note) {
      note.textContent = can ? '' : AI_UNAVAILABLE;
      note.classList.toggle('bs-hidden', can);
    }
    // A capability lost mid-session must not leave a live prompt box open behind the explanation.
    if (!can && mediaEls && mediaEls.aiForm) mediaEls.aiForm.classList.add('bs-hidden');
  }

  function openAiForm() {
    // A disabled button fires no click, so this only catches a programmatic call — but the panel
    // must never be reachable when the server would refuse the generate.
    if (!state.canImage) { setStatus('bs-media-status', AI_UNAVAILABLE); return; }
    mediaEls.picker.classList.add('bs-hidden');
    mediaEls.pexelsForm.classList.add('bs-hidden');
    mediaEls.aiForm.classList.remove('bs-hidden');
    mediaEls.aiPrompt.focus();
  }
  function openPexelsForm() {
    mediaEls.picker.classList.add('bs-hidden');
    mediaEls.aiForm.classList.add('bs-hidden');
    mediaEls.pexelsForm.classList.remove('bs-hidden');
    if (!mediaEls.pexelsQuery.value.trim()) mediaEls.pexelsQuery.value = (el('bs-title').value || '').trim();
    mediaEls.pexelsQuery.focus();
  }

  function localToISO(v) {
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Push what's on screen to the server before any action that validates the *stored* body.
  // Typing autosaves on a debounce and neither mount() nor setMarkdown() persists at all, so a body
  // the author can plainly see (notes carried in by "Improve draft", or a sentence typed a moment
  // ago) may not have landed yet. publish-blog and schedule-blog both reject on the stored
  // bodyMarkdown, which surfaced as "Cannot publish an empty post." over visible text.
  // publish-blog / schedule-blog both refuse an empty body. Catch it here so the author gets a
  // useful nudge instead of the server's "Cannot publish an empty post." after a round trip.
  function blockedAsEmpty() {
    if (state.editor && state.editor.getMarkdown().trim()) return false;
    setBanner('bs-action-status', 'This draft is empty — write something before publishing.', 'error');
    return true;
  }

  function flushDraft() {
    if (!state.postId || !state.editor) return Promise.resolve();
    return api('save-blog-draft', { method: 'POST', body: JSON.stringify({
      id: state.postId,
      title: el('bs-title').value,
      bodyMarkdown: state.editor.getMarkdown(),
    }) }).catch(function () { /* the action below reports its own failure */ });
  }

  // Syndication connectors + push now live in the assistant Connections tab (integrations.js): posts
  // auto-publish to every connected blog on publish. No per-post syndication UI here any more.

  // ── Where this post gets published (per-post syndication targets) ──────────────────────────────
  // Connecting a blog in the assistant's Connections tab opted it in permanently: every published
  // post went to every connected platform, with nothing on screen saying so and no way to hold one
  // post back. The choice is stored as the reserved `selected` key inside blog_posts.destinations
  // and honoured by syndicatePublishedPost().
  //
  // ABSENT (not empty) means "everything connected" — that is what posts written before this panel
  // existed carry, and it is the behaviour they were published under. So the first time a post is
  // opened here, every connected destination is ticked; unticking one is a real, saved decision.
  function selectedDestinations(post) {
    var d = (post && post.destinations) || {};
    return Array.isArray(d.selected) ? d.selected.map(String) : null;
  }

  function saveDistribution() {
    if (!state.postId) return;
    var boxes = el('bs-dist-list').querySelectorAll('input[type="checkbox"]');
    var chosen = Array.prototype.filter.call(boxes, function (b) { return b.checked; })
      .map(function (b) { return b.value; });
    setStatus('bs-dist-status', 'Saving…');
    api('save-blog-draft', { method: 'POST', body: JSON.stringify({ id: state.postId, distribution: chosen }) })
      .then(function (res) {
        setStatus('bs-dist-status', res.ok
          ? (chosen.length ? 'Saved — also publishing to ' + chosen.length + ' other platform'
              + (chosen.length === 1 ? '.' : 's.') : 'Saved — your blog only.')
          : ((res.body && res.body.error) || 'Could not save that choice.'));
      });
  }

  function loadDistribution(post) {
    var list = el('bs-dist-list');
    if (!list) return;
    list.innerHTML = '';
    setStatus('bs-dist-status', 'Checking connected platforms…');
    var selected = selectedDestinations(post);
    api('connect-blog-destination', { method: 'GET' }).then(function (res) {
      var connected = ((res.ok && res.body.destinations) || []).filter(function (d) { return d.connected; });
      if (!connected.length) {
        setStatus('bs-dist-status', 'No other platforms connected yet. Connect WordPress, Ghost, '
          + 'Dev.to or Hashnode from your assistant\u2019s Connections tab and they\u2019ll appear here.');
        return;
      }
      connected.forEach(function (d) {
        var label = document.createElement('label');
        label.className = 'bs-dest';
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.value = d.id;
        box.checked = selected === null || selected.indexOf(d.id) >= 0;
        box.addEventListener('change', saveDistribution);
        var text = document.createElement('span');
        text.className = 'bs-dest-name';
        // Say which way it lands over there. "draft" vs "live" is the difference between a post
        // appearing on someone's public blog and waiting for them there.
        text.innerHTML = bsEscape(d.label + (d.accountLabel ? ' \u00b7 ' + d.accountLabel : ''))
          + '<span class="bs-dest-note">'
          + (d.publishMode === 'live' ? 'Published live as soon as this post goes out.'
                                      : 'Sent as a draft for you to release over there.')
          + '</span>';
        label.appendChild(box);
        label.appendChild(text);
        list.appendChild(label);
      });
      setStatus('bs-dist-status', selected === null
        ? 'All connected platforms are selected. Untick any you want to skip for this post.'
        : '');
    }).catch(function () { setStatus('bs-dist-status', 'Could not check connected platforms.'); });
  }

  // ── Search Console (US 5.1 content-decay loop) — connect status ────────────────────────────────
  function loadSearchConsole() {
    var statusEl = el('bs-gsc-status');
    if (!statusEl) return;
    statusEl.textContent = 'Checking…';
    el('bs-gsc-connect').classList.add('bs-hidden');
    el('bs-gsc-disconnect').classList.add('bs-hidden');
    api('oauth-integrations?action=status', { method: 'GET' }).then(function (res) {
      var p = res.ok && res.body.providers ? res.body.providers.searchconsole : null;
      if (p && p.connected) {
        statusEl.textContent = 'Connected' + (p.accountName ? ' · ' + p.accountName : '');
        el('bs-gsc-disconnect').classList.remove('bs-hidden');
      } else {
        statusEl.textContent = 'Not connected.';
        el('bs-gsc-connect').classList.remove('bs-hidden');
      }
    }).catch(function () { statusEl.textContent = 'Could not check status.'; });
  }

  // ── Wire all events once, after markup injection ───────────────────────────────────────────────
  function wireEvents() {
    el('bs-close').addEventListener('click', closeBlogStudio);
    el('bms-blog-backdrop').addEventListener('mousedown', function (e) {
      if (e.target === el('bms-blog-backdrop')) closeBlogStudio();  // click the dimmed area to dismiss
    });
    document.addEventListener('keydown', function (e) {
      // Esc dismisses, unless the chat modal opened on top of us — it owns the key then.
      if (e.key !== 'Escape' || !el('bms-blog-backdrop').classList.contains('bs-open')) return;
      var chat = document.getElementById('chat-modal');
      if (chat && !chat.classList.contains('hidden')) return;
      closeBlogStudio();
    });

    el('bs-title').addEventListener('blur', function () {
      if (!state.postId) return;
      api('save-blog-draft', { method: 'POST', body: JSON.stringify({ id: state.postId, title: this.value }) });
    });

    el('bs-swan-improve').addEventListener('click', askSwanImprove);

    // Inline AI draft: reveal the topic form, draft into the editor, or cancel.
    el('bs-ai-draft').addEventListener('click', function () {
      var form = el('bs-ai-draft-form');
      var showing = !form.classList.contains('bs-hidden');
      form.classList.toggle('bs-hidden', showing);
      if (!showing) { setStatus('bs-ai-draft-status', ''); el('bs-ai-topic').focus(); }
    });
    el('bs-ai-draft-go').addEventListener('click', runAiDraft);
    el('bs-ai-draft-cancel').addEventListener('click', function () { el('bs-ai-draft-form').classList.add('bs-hidden'); });

    // Publish now. The slowest action in the Studio — it re-renders the payload, stamps provenance
    // and awaits syndication to every connected destination — so it runs behind the wait cursor and
    // a disabled button row rather than leaving the author staring at a click that appears to have
    // done nothing.
    //
    // On success the modal CLOSES and hands the host the Published column to open: the post has left
    // every state this screen can still act on, so keeping it up (as it used to, with a green banner
    // and a live Unpublish button) invited the author to undo the thing they had just asked for. The
    // toast carries the confirmation the banner used to.
    el('bs-publish').addEventListener('click', function () {
      if (!state.postId || blockedAsEmpty()) return;
      setBanner('bs-action-status', 'Publishing…');
      setBusy(true);
      flushDraft().then(function () {
        return api('publish-blog', { method: 'POST', body: JSON.stringify({ id: state.postId }) });
      }).then(function (res) {
        setBusy(false);
        if (!res.ok) {
          setBanner('bs-action-status', (res.body && res.body.error) || 'Could not publish — please try again.', 'error');
          return;
        }
        var slug = (res.body.post && res.body.post.slug) || '';
        var sent = res.body.syndication || [];
        var failed = syndicationFailures(sent);
        // Refresh the list underneath either way — the post IS published, so the counts behind have
        // moved whether or not every destination took it.
        notifyChanged({ focusStatus: 'posted' });
        if (failed.length) {
          // A destination that refused is not a transient thing to flash in a toast on a screen the
          // author is being navigated away from: the post is live on their own site and NOT where
          // they expected it. Stay put and name what happened, with the server's own reason.
          setBanner('bs-action-status', 'Published to your site ✓ — but ' + failed.map(function (d) {
            return d.label + ' (' + (d.error || 'not connected') + ')';
          }).join('; '), 'error');
          el('bs-unschedule').classList.add('bs-hidden');
          el('bs-unpublish').classList.remove('bs-hidden');
          el('bs-repush').classList.remove('bs-hidden');   // retry the leg that failed, without republishing
          return;
        }
        closeBlogStudio();
        window.showToast && window.showToast(sent.length
          ? 'Published ✓ — also sent to ' + syndicationNames(sent) + '.'
          : 'Published ✓ — on your own site only. No other platforms are connected.');
      }).catch(function () {
        setBusy(false);
        setBanner('bs-action-status', 'Could not publish — please try again.', 'error');
      });
    });

    // Reveal / hide the manual date-time picker ("Pick a time myself").
    el('bs-pick-time').addEventListener('click', function () {
      el('bs-schedule-picker').classList.remove('bs-hidden');
      el('bs-schedule-at').focus();
    });
    el('bs-schedule-back').addEventListener('click', function () {
      el('bs-schedule-picker').classList.add('bs-hidden');
    });

    // Archive — drafts only; blog-posts DELETE refuses a published post. That endpoint no longer
    // destroys the row (it sets status='archived'), so this must not warn about permanence.
    el('bs-discard').addEventListener('click', async function () {
      if (!state.postId) return;
      // window.confirm() is the browser's own grey box: wrong typeface, wrong buttons, and it names
      // the site rather than the product. Every other dialog in the app goes through /dialogs.js.
      if (!(await window.confirmModal(
        'The draft is kept — you can find it again in the Archive tab and bring it back.',
        { title: 'Archive this draft?', confirmLabel: 'Yes, archive it', cancelLabel: 'Keep editing' },
      ))) return;
      setBanner('bs-action-status', 'Archiving…');
      api('blog-posts?id=' + encodeURIComponent(state.postId), { method: 'DELETE' }).then(function (res) {
        if (res.ok) { notifyChanged(); closeBlogStudio(); }
        else setBanner('bs-action-status', (res.body && res.body.error) || 'Could not archive this draft.', 'error');
      });
    });

    // Search Console connect (OAuth redirect) / disconnect for the content-decay loop.
    el('bs-gsc-connect').addEventListener('click', function () {
      window.location.href = '/.netlify/functions/oauth-integrations?provider=searchconsole&action=connect';
    });
    el('bs-gsc-disconnect').addEventListener('click', function () {
      api('oauth-integrations?provider=searchconsole&action=disconnect', { method: 'POST' }).then(function () { loadSearchConsole(); });
    });

    // Approve & schedule — the assistant picks the next free cadence slot (no manual date).
    el('bs-approve').addEventListener('click', function () {
      if (!state.postId || blockedAsEmpty()) return;
      setBanner('bs-action-status', 'Scheduling…');
      flushDraft().then(function () {
        return api('schedule-blog', { method: 'POST', body: JSON.stringify({ id: state.postId, action: 'approve' }) });
      }).then(function (res) {
        if (res.ok && res.body.post) {
          setBanner('bs-action-status', 'Approved — scheduled for ' + new Date(res.body.post.publishDate).toLocaleString());
          el('bs-unschedule').classList.remove('bs-hidden');
          notifyChanged();   // leaves Review for Scheduled — both counts move
        } else setBanner('bs-action-status', (res.body && res.body.error) || 'Could not schedule this post.', 'error');
      });
    });

    el('bs-schedule').addEventListener('click', function () {
      if (!state.postId || blockedAsEmpty()) return;
      var iso = localToISO(el('bs-schedule-at').value);
      if (!iso) { setBanner('bs-action-status', 'Pick a date & time.', 'error'); return; }
      setBanner('bs-action-status', 'Scheduling…');
      flushDraft().then(function () {
        return api('schedule-blog', { method: 'POST', body: JSON.stringify({ id: state.postId, publishDate: iso }) });
      }).then(function (res) {
        if (res.ok) {
          setBanner('bs-action-status', 'Scheduled for ' + new Date(res.body.post.publishDate).toLocaleString());
          el('bs-schedule-picker').classList.add('bs-hidden');
          el('bs-unschedule').classList.remove('bs-hidden');
          notifyChanged();   // manual date — same lifecycle move as approve
        } else setBanner('bs-action-status', (res.body && res.body.error) || 'Could not schedule this post.', 'error');
      });
    });
    el('bs-unschedule').addEventListener('click', function () {
      if (!state.postId) return;
      api('schedule-blog', { method: 'POST', body: JSON.stringify({ id: state.postId, action: 'unschedule' }) }).then(function (res) {
        if (res.ok) {
          setBanner('bs-action-status', 'Schedule cleared — back to draft.');
          el('bs-unschedule').classList.add('bs-hidden');
          notifyChanged();   // Scheduled → Review: two counts move, same as approve/schedule
        } else setBanner('bs-action-status', (res.body && res.body.error) || 'Could not clear the schedule.', 'error');
      });
    });

    // Unpublish — takes the post off the org's own site only. Syndicated copies stay live (no
    // adapter can retract them), so name the ones that do in the confirm AND in the result banner.
    // Re-push to the connected blogs, without republishing. Idempotent server-side (each
    // destination is edited through its stored externalId), so this is safe to press twice — and it
    // is the only way to syndicate a post to a destination connected AFTER the post went live.
    el('bs-repush').addEventListener('click', function () {
      if (!state.postId) return;
      setBanner('bs-action-status', 'Sending…');
      setBusy(true);
      api('publish-blog-destinations', { method: 'POST', body: JSON.stringify({ postId: state.postId }) })
        .then(function (res) {
          setBusy(false);
          if (!res.ok) {
            setBanner('bs-action-status', (res.body && res.body.error) || 'Could not send this post.', 'error');
            return;
          }
          var sent = res.body.syndication || [];
          var failed = syndicationFailures(sent);
          if (failed.length) {
            setBanner('bs-action-status', failed.map(function (d) {
              return d.label + ': ' + (d.error || 'not connected');
            }).join('; '), 'error');
          } else if (!sent.length) {
            setBanner('bs-action-status', 'No other platforms are connected — connect one from your '
              + 'assistant\u2019s Connections tab first.', 'error');
          } else {
            setBanner('bs-action-status', 'Sent to ' + syndicationNames(sent) + '.');
          }
        })
        .catch(function () { setBusy(false); setBanner('bs-action-status', 'Could not send this post.', 'error'); });
    });

    el('bs-unpublish').addEventListener('click', async function () {
      if (!state.postId) return;
      if (!(await window.confirmModal(
        'It goes back to a draft — the URL and its content are kept, so you can publish it again later.'
        + '<br><br>Copies on other platforms stay live.',
        { title: 'Take this post off your site?', confirmLabel: 'Yes, unpublish', cancelLabel: 'Leave it live' },
      ))) return;
      setBanner('bs-action-status', 'Unpublishing…');
      api('unpublish-blog', { method: 'POST', body: JSON.stringify({ id: state.postId }) }).then(function (res) {
        if (!res.ok) {
          setBanner('bs-action-status', (res.body && res.body.error) || 'Could not unpublish this post.', 'error');
          return;
        }
        var live = (res.body.stillLive || []).map(function (d) { return d.target; });
        setBanner('bs-action-status', live.length
          ? 'Off your site — back to draft. Still live on ' + live.join(', ') + ' — remove there separately.'
          : 'Off your site — back to draft.');
        el('bs-unpublish').classList.add('bs-hidden');
    el('bs-repush').classList.add('bs-hidden');
        notifyChanged();   // Published → Review: same lifecycle move, same stale counts without it
      });
    });

    el('bs-generate-hooks').addEventListener('click', function () {
      if (!state.postId) return;
      setBanner('bs-action-status', 'Writing three headlines\u2026');
      api('generate-hooks', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId }) }).then(function (res) {
        if (!res.ok) { setBanner('bs-action-status', (res.body && res.body.error) || 'Could not write the headlines.', 'error'); return; }
        // generate-hooks returns the variants but not the post, and it has just set ab_state to
        // 'testing' server-side — so hand renderHooks that state rather than re-reading the row.
        renderHooks({ hookVariants: res.body.hookVariants, abState: 'testing', winningVariant: null, status: state.postStatus });
        setBanner('bs-action-status', 'Three headlines ready \u2014 see "Headline test" below.');
        var panel = el('bs-hooks-panel');
        if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
    el('bs-generate-seo').addEventListener('click', function () {
      if (!state.postId) return;
      setBanner('bs-action-status', 'Generating SEO…');
      api('generate-seo', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId }) }).then(function (res) {
        if (!res.ok) { setBanner('bs-action-status', (res.body && res.body.error) || 'Could not generate SEO.', 'error'); return; }
        var slugPart = res.body.urlSlug ? ('/' + res.body.urlSlug + ' · ') : '';
        setBanner('bs-action-status', 'SEO ready — ' + slugPart + res.body.tags.length + ' tags');
        // Surface the freshly generated meta in the editable panel so the author can tweak it.
        if (res.body.metaTitle) el('bs-meta-title').value = res.body.metaTitle;
        if (res.body.metaDescription) el('bs-meta-desc').value = res.body.metaDescription;
        refreshSeoCounts();
        // After the fields are populated, never before — the label is derived from their values.
        syncSeoButton();
      });
    });

    // ── Copy-to-clipboard for the embed snippet / feed URL ────────────────────────────────────
    // navigator.clipboard needs a secure context; it is absent over plain http and rejects when the
    // document is not focused. Falling back to execCommand('copy') via a throwaway textarea keeps
    // the button working there instead of failing silently, which is the whole point of adding it.
    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
      return new Promise(function (resolve, reject) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('copy failed'));
      });
    }

    // srcId's text is the source of truth, so the button can never copy something stale — it reads
    // whatever renderSnippet() last wrote. Guarded on both elements: the RSS pair may not exist.
    function wireCopy(btnId, srcId) {
      var btn = document.getElementById(btnId), src = document.getElementById(srcId);
      if (!btn || !src) return;
      btn.addEventListener('click', function () {
        var text = src.textContent || '';
        // Before a widget exists the box holds placeholder prose, not a snippet. Copying that would
        // hand the user something broken to paste into their site.
        if (!/wgt_/.test(text)) { btn.textContent = 'Not ready yet'; }
        else { copyText(text).then(function () { btn.textContent = 'Copied'; })
                             .catch(function () { btn.textContent = 'Press Ctrl+C'; }); }
        setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
      });
    }
    wireCopy('bs-snippet-copy', 'bs-snippet');
    wireCopy('bs-rss-copy', 'bs-rss');

    // Preview as soon as a family is picked — otherwise the author is choosing from a list of
    // names rendered in a font they cannot see.
    el('bs-font').addEventListener('change', function () { applyFontToEditor(el('bs-font').value); });

    // ── Widget settings — debounced autosave, mirroring the body and SEO contract ────────────────
    //
    // This panel was the one thing in the Studio kept behind a Save button, and the reason was
    // real: save-widget-config validates both site fields and answers a half-typed address with a
    // 400, so sending every keystroke would throw "must be a full http(s) URL" at someone who is
    // still typing it. That reason survives as the HOLD-BACK rule rather than as a button — a
    // field is sent only once it is something the server will accept, and until then it says so
    // beneath itself. Silence there would be the worst of both: a URL typed halfway, abandoned,
    // and never persisted, with nothing on screen admitting it.
    //
    // '' is a decision, not an in-progress value: it clears the field server-side, so it sends.
    function siteBaseState() {
      var v = el('bs-site-base').value.trim();
      if (!v) return { send: true, value: '' };
      return /^https?:\/\/[^\s/]+/i.test(v) ? { send: true, value: v } : { send: false, value: null };
    }
    function sitePathState() {
      var v = el('bs-site-path').value.trim();
      if (!v) return { send: true, value: '' };
      return (v.charAt(0) === '/' && v.indexOf('{slug}') >= 0)
        ? { send: true, value: v } : { send: false, value: null };
    }
    function toggleHint(id, show) {
      var e = el(id);
      if (e) e.classList.toggle('bs-hidden', !show);
    }

    var widgetTimer = null;
    function saveWidgetSettings() {
      clearTimeout(widgetTimer);
      widgetTimer = null;
      if (!state.widgetReady) return Promise.resolve();
      var base = siteBaseState(), path = sitePathState();
      toggleHint('bs-site-base-hint', !base.send);
      toggleHint('bs-site-path-hint', !path.send);

      // ⚠️ `theme` is ONE json column and save-widget-config REPLACES it wholesale
      // (`updates.theme = checked.theme`). The omit-don't-blank rule used on the site fields below
      // is therefore exactly wrong here: inside the theme, an omitted key is a DELETED key. Every
      // value the panel is not changing has to be re-sent, which is what state.widgetTheme — the
      // last config applyWidget painted from, refreshed from each save's response — is for.
      //
      // The picker reads '' whenever the stored stack has no matching <option>, which happens two
      // ways and they need opposite answers:
      //   • the catalogue never loaded (platform-constants.js missing) — the stored face is fine,
      //     carry it forward, or changing the accent silently strips the author's typeface;
      //   • the family was RETIRED from src/config/blog-fonts.ts — findBlogFont refuses it, so
      //     re-sending it 400s the WHOLE save and the accent the author just picked is refused
      //     along with it, from a panel whose picker cannot show them the offending value either.
      // BlogFonts.get() is the difference: it recognises a stack the catalogue still offers.
      var stored = state.widgetTheme || {};
      var catalogue = window.BlogFonts;
      var stack = el('bs-font').value;
      if (!stack && stored.fontFamily) {
        stack = (!catalogue || catalogue.get(stored.fontFamily)) ? stored.fontFamily : '';
      }
      var payload = {
        action: 'update',
        // fontUrl travels WITH the stack. widget.js and the /b/:key/:slug permalink both need the
        // stylesheet, and neither carries the catalogue. The server derives its own from
        // fontFamily and ignores this — it is sent so the two stay visibly in step.
        theme: {
          accent: el('bs-accent').value,
          fontUrl: (catalogue && catalogue.urlFor(stack)) || null,
        },
        badgeEnabled: el('bs-badge').checked,
      };
      // Still guarded: '' is a RESET to the default stack server-side, so a workspace that has
      // genuinely never chosen a face must send nothing rather than record a choice nobody made.
      if (stack) payload.theme.fontFamily = stack;
      // Omitted, not blanked — and here it really does preserve, because these are TOP-LEVEL keys
      // and the update branch only assigns the ones present in the body.
      if (base.send) payload.siteBaseUrl = base.value;
      if (path.send) payload.sitePostPath = path.value;

      setStatus('bs-widget-status', 'Saving\u2026');
      return api('save-widget-config', { method: 'POST', body: JSON.stringify(payload) })
        .then(function (res) {
          // Deliberately NOT applyWidget(): it repaints the inputs from the stored config, which
          // would yank a half-typed URL out from under the person still typing it.
          if (!res.ok) { setStatus('bs-widget-status', (res.body && res.body.error) || 'Not saved'); return; }
          // Keep the merge base honest: the server normalises what it stored (accent lower-cased,
          // fontUrl derived), and the NEXT save re-sends this theme's untouched keys.
          if (res.body && res.body.config) state.widgetTheme = res.body.config.theme || {};
          setStatus('bs-widget-status', (base.send && path.send) ? 'Saved' : 'Saved \u2014 one field is still waiting');
        })
        .catch(function () { setStatus('bs-widget-status', 'Not saved'); });
    }

    // Only USER edits schedule a save. applyWidget assigns .value directly and that fires neither
    // `input` nor `change`, so painting the panel on open — including the site-URL suggestions,
    // which are still suggestions and not decisions — never writes anything by itself.
    function widgetChanged() {
      if (!state.widgetReady) return;
      clearTimeout(widgetTimer);
      widgetTimer = setTimeout(saveWidgetSettings, 900);
    }
    // `input` on the colour picker fires continuously while the swatch is dragged; the debounce is
    // what keeps that from becoming a request per frame.
    el('bs-accent').addEventListener('input', widgetChanged);
    el('bs-font').addEventListener('change', widgetChanged);
    el('bs-badge').addEventListener('change', widgetChanged);
    el('bs-site-base').addEventListener('input', widgetChanged);
    el('bs-site-path').addEventListener('input', widgetChanged);
    // Leaving a field is the author saying they are done with it — don't sit on the debounce.
    el('bs-site-base').addEventListener('blur', function () { if (widgetTimer) saveWidgetSettings(); });
    el('bs-site-path').addEventListener('blur', function () { if (widgetTimer) saveWidgetSettings(); });

    // Closing the modal inside the debounce window must not drop the edit. Exposed on `state`
    // because closeBlogStudio lives outside this closure.
    state.flushWidgetSettings = function () { if (widgetTimer) saveWidgetSettings(); };

    // ── SEO metadata overrides (US 1.3) — debounced autosave, mirrors the body autosave contract ──
    function saveSeo() {
      if (!state.postId) return;
      setStatus('bs-seo-status', 'Saving…');
      api('save-blog-draft', { method: 'POST', body: JSON.stringify({
        id: state.postId,
        metaTitle: el('bs-meta-title').value,
        metaDescription: el('bs-meta-desc').value,
        robots: el('bs-robots').value,
      }) }).then(function (res) {
        setStatus('bs-seo-status', res.ok ? 'Saved' : ((res.body && res.body.error) || 'Not saved'));
      });
    }
    var seoTimer;
    function seoChanged() {
      refreshSeoCounts();
      clearTimeout(seoTimer);
      seoTimer = setTimeout(saveSeo, 900);
    }
    el('bs-meta-title').addEventListener('input', seoChanged);
    el('bs-meta-desc').addEventListener('input', seoChanged);
    el('bs-robots').addEventListener('change', saveSeo);

    mediaEls = {
      preview: el('bs-feature-preview'), drop: el('bs-feature-drop'), remove: el('bs-feature-remove'),
      library: el('bs-media-library'), upload: el('bs-media-upload'), uploadInput: el('bs-media-upload-input'),
      pexels: el('bs-media-pexels'), ai: el('bs-media-ai'), canva: el('bs-media-canva'),
      aiForm: el('bs-ai-form'), aiPrompt: el('bs-ai-prompt'), aiGo: el('bs-ai-go'),
      pexelsForm: el('bs-pexels-form'), pexelsQuery: el('bs-pexels-query'), pexelsGo: el('bs-pexels-go'),
      picker: el('bs-media-picker'),
      cols2: el('bs-cols-2'), cols3: el('bs-cols-3'),
    };

    mediaEls.remove.addEventListener('click', function () {
      if (!state.postId) return;
      setStatus('bs-media-status', 'Removing…');
      api('blog-media', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId, action: 'detach', role: 'feature' }) })
        .then(function (res) {
          if (res.ok) { renderFeature(res.body.feature); setStatus('bs-media-status', 'Feature image removed.'); }
          else setStatus('bs-media-status', (res.body && res.body.error) || 'Could not remove it.');
        });
    });

    // ── The feature slot as a drop target ────────────────────────────────────────────────────────
    // The body was already the only place anything could be dropped, which is what made the hero
    // feel like a box the system owns. It now accepts the same picker payloads as the editor, plus
    // files straight off the desktop.
    function featureDragKind(dt) {
      if (!dt) return null;
      var types = Array.prototype.slice.call(dt.types || []);
      if (types.indexOf(window.MarkdownEditor.MEDIA_MIME) >= 0) return 'media';
      if (types.indexOf('Files') >= 0) return 'files';
      return null;
    }
    mediaEls.drop.addEventListener('dragover', function (e) {
      if (!state.postId || !featureDragKind(e.dataTransfer)) return;
      e.preventDefault();                       // required, or the browser refuses to fire `drop`
      e.dataTransfer.dropEffect = 'copy';
      mediaEls.drop.classList.add('bs-drop-hot');
    });
    mediaEls.drop.addEventListener('dragleave', function (e) {
      // Only when the pointer has actually left the box — dragleave also fires crossing into a child.
      if (!mediaEls.drop.contains(e.relatedTarget)) mediaEls.drop.classList.remove('bs-drop-hot');
    });
    mediaEls.drop.addEventListener('drop', function (e) {
      var kind = featureDragKind(e.dataTransfer);
      if (!state.postId || !kind) return;
      e.preventDefault();
      mediaEls.drop.classList.remove('bs-drop-hot');
      if (kind === 'media') {
        var payload;
        try { payload = JSON.parse(e.dataTransfer.getData(window.MarkdownEditor.MEDIA_MIME)); }
        catch (_) { return; }                   // malformed — never guess at what was dropped
        // The hero is images-only. Say so rather than letting blog-media reject it downstream.
        if (payload && payload.type && payload.type !== 'image') {
          setStatus('bs-media-status', 'The feature image has to be an image — video and audio go in the post body.');
          return;
        }
        routeFeature(attachBodyFor(payload));
        return;
      }
      var file = (e.dataTransfer.files || [])[0];
      if (!file) return;
      if (!/^image\//.test(file.type || '')) {
        setStatus('bs-media-status', 'The feature image has to be an image.');
        return;
      }
      setStatus('bs-media-status', 'Uploading…');
      uploadContentAsset(file)
        .then(function (asset) { routeFeature({ assetId: asset.id }); })
        .catch(function (err) { setStatus('bs-media-status', err.message || 'Upload failed. Please try again.'); });
    });

    // A column layout is body structure, not media, so it doesn't go through the picker — it goes
    // straight into the draft, after whichever block the author last touched, and the editor
    // scrolls it into view and flashes it so "nothing happened" is never the reading.
    function insertColumns(n) {
      if (!state.editor) return;
      state.editor.insertColumns(n);
      setStatus('bs-media-status', n + '-column row added. Drag a paragraph or image into a column '
        + 'using the \u22EE\u22EE handle on its left.');
    }
    mediaEls.cols2.addEventListener('click', function () { insertColumns(2); });
    mediaEls.cols3.addEventListener('click', function () { insertColumns(3); });
    mediaEls.library.addEventListener('click', function () { openLibrary(); });
    mediaEls.ai.addEventListener('click', openAiForm);
    mediaEls.pexels.addEventListener('click', openPexelsForm);
    mediaEls.canva.addEventListener('click', openCanva);
    mediaEls.upload.addEventListener('click', function () { mediaEls.uploadInput.click(); });
    mediaEls.uploadInput.addEventListener('change', handleUploadInput);

    // AI generation is a two-stage flow of its own: the variations are not assets yet, so they get
    // a bare grid, and only the CHOSEN one becomes an asset — which then appears as an ordinary
    // tile with the ordinary two actions.
    mediaEls.aiGo.addEventListener('click', function () {
      var prompt = mediaEls.aiPrompt.value.trim();
      if (!prompt || !state.postId) return;
      setStatus('bs-media-status', 'Generating…');
      mediaEls.picker.classList.remove('bs-hidden');
      mediaEls.picker.innerHTML = '<div class="bs-media-empty">Generating…</div>';
      api('generate-ai-image', { method: 'POST', body: JSON.stringify({ prompt: prompt, aspectRatio: '16:9' }) })
        .then(function (res) {
          if (!res.ok) {
            mediaEls.picker.innerHTML = '';
            mediaEls.picker.classList.add('bs-hidden');
            // The capability went away since this modal opened (or the tab predates the preflight).
            // Retire the control and explain, rather than printing the server's raw sentence.
            if (res.body && res.body.code === 'feature_unavailable') {
              state.canImage = false;
              applyMediaCapabilities();
              setStatus('bs-media-status', AI_UNAVAILABLE);
              return;
            }
            // 402 carries the machine code 'insufficient_credits' in `error` — showing that verbatim
            // is the same fault in a different branch. Wording mirrors my-content.html's warning.
            if (res.body && res.body.error === 'insufficient_credits') {
              setStatus('bs-media-status', 'You don\u2019t have enough credits to generate an image. '
                + 'Upgrade your plan for more.');
              return;
            }
            setStatus('bs-media-status', (res.body && res.body.error) || 'Generation failed');
            return;
          }
          setStatus('bs-media-status', 'Pick a variation');
          var jobId = res.body.jobId;
          mediaEls.picker.innerHTML = '';
          (res.body.images || []).forEach(function (im) {
            var img = document.createElement('img');
            img.src = im.url;
            img.title = 'Keep this variation';
            img.addEventListener('click', function () {
              setStatus('bs-media-status', 'Saving…');
              api('generate-ai-image', { method: 'POST', body: JSON.stringify({ action: 'select', jobId: jobId, index: im.index }) })
                .then(function (sel) {
                  if (!sel.ok || !sel.body.assetId) {
                    setStatus('bs-media-status', (sel.body && sel.body.error) || 'Could not save image');
                    return;
                  }
                  // The variation URL is already in hand, so the tile can be built without a
                  // library round-trip — no waiting to find out where the image can go.
                  renderTiles([{ type: 'image', url: im.url, name: prompt, title: prompt,
                    source: 'ai', body: { assetId: sel.body.assetId } }]);
                  setStatus('bs-media-status', 'Saved — click it to add it to your post, or press Feature.');
                });
            });
            mediaEls.picker.appendChild(img);
          });
        });
    });

    mediaEls.pexelsGo.addEventListener('click', function () {
      var topic = mediaEls.pexelsQuery.value.trim();
      if (!topic || !state.postId) return;
      setStatus('bs-media-status', 'Searching…');
      mediaEls.picker.classList.remove('bs-hidden');
      mediaEls.picker.innerHTML = '<div class="bs-media-empty">Searching…</div>';
      api('pexels-search', { method: 'POST', body: JSON.stringify({ topic: topic, dedup: false }) })
        .then(function (res) {
          if (!res.ok) { setStatus('bs-media-status', (res.body && res.body.error) || 'Search failed'); mediaEls.picker.innerHTML = ''; return; }
          var candidates = (res.body && res.body.candidates) || [];
          renderTiles(candidates.map(function (c) {
            return {
              type: 'image', url: c.url, name: c.title || '', source: 'pexels',
              title: c.photographer ? ('Photo by ' + c.photographer + ' on Pexels') : (c.title || ''),
              body: { pexelsCandidate: c },
            };
          }), 'No matches — try a different search.');
          setStatus('bs-media-status', candidates.length ? 'Pick a photo' : '');
        });
    });
  }

  function inject() {
    if (state.injected) return;
    var style = document.createElement('style');
    style.id = 'bms-blog-studio-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);

    var backdrop = document.createElement('div');
    backdrop.id = 'bms-blog-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.innerHTML = MARKUP;
    document.body.appendChild(backdrop);

    wireEvents();
    state.injected = true;
  }

  // Clear transient editor state before (re)opening onto a post — the modal is injected once and
  // reused, so status lines and the AI-draft form must not carry over between opens.
  function clearWorkspaceState() {
    // Disarm the widget autosave until loadWidget has repainted the panel. The DOM survives between
    // opens, so without this a change made during the reload would save the PREVIOUS session's
    // values back over whatever this one just fetched.
    state.widgetReady = false;
    state.widgetTheme = null;
    ['bs-save-status', 'bs-media-status', 'bs-ai-draft-status', 'bs-dist-status', 'bs-widget-status'].forEach(function (id) { setStatus(id, ''); });
    var dist = el('bs-dist-list'); if (dist) dist.innerHTML = '';
    var picker = el('bs-media-picker');
    if (picker) { picker.innerHTML = ''; picker.classList.add('bs-hidden'); }
    ['bs-ai-form', 'bs-pexels-form'].forEach(function (id) { var e = el(id); if (e) e.classList.add('bs-hidden'); });
    ['bs-action-status'].forEach(function (id) { setBanner(id, ''); });
    var f = el('bs-ai-draft-form'); if (f) f.classList.add('bs-hidden');
    ['bs-ai-topic', 'bs-ai-keywords'].forEach(function (id) { var e = el(id); if (e) e.value = ''; });
  }

  // ── Public API ─────────────────────────────────────────────────────────────────────────────────
  function openBlogStudio(opts) {
    opts = opts || {};
    inject();
    state.assistantId = opts.assistantId != null ? opts.assistantId : null;
    el('bms-blog-backdrop').classList.add('bs-open');
    window.ScrollLock.lock('blog-studio');

    clearWorkspaceState();
    // Resolve AI image generation before the author can reach for it. Reset to "no" first and paint
    // that, so a previous org's capability can never leave the button live for a beat.
    state.canImage = false;
    applyMediaCapabilities();
    loadMediaCapabilities();
    // Paint the fallback wording immediately so no button is briefly blank, then correct it once
    // the assistant list is in.
    applyAssistantNaming();
    loadAssistants().then(function () {
      // Opening onto an existing post loads it; opening fresh drops straight into a blank draft in
      // the editor (the old "Start a new post" brief screen is gone).
      if (opts.postId) {
        loadExistingPost(Number(opts.postId));   // sets assistantId from the post itself
      } else {
        startBlankPost();
      }
    });
  }

  // Tell the host page a post changed lifecycle, so the Blogs list and its tab badge reload.
  //
  // Both come from the SAME call (_detailRqRenderBlog sets the list, the column badge, the tab badge,
  // the pending-review count and the op signals), so without this the count keeps its pre-action
  // value until the user switches tabs or reloads. The list card's own Archive button always
  // refreshed; the modal never did, which is why archiving from inside Blog Studio left the Review
  // count one too high.
  //
  // `opts.focusStatus` names a lifecycle column for the host to OPEN as it refreshes (Publish sends
  // 'posted'). Optional, and an older host that ignores the argument still refreshes in place.
  function notifyChanged(opts) {
    try { window._onBlogStudioChanged && window._onBlogStudioChanged(opts || {}); }
    catch (e) { /* the host page is optional — the modal must still close */ }
  }

  function closeBlogStudio() {
    if (!state.injected) return;
    // Widget settings autosave on a debounce; close inside that window and the last edit would be
    // lost. The editor's own destroy() flushes the body for the same reason.
    if (state.flushWidgetSettings) state.flushWidgetSettings();
    if (state.editor && state.editor.destroy) { state.editor.destroy(); state.editor = null; }
    el('bms-blog-backdrop').classList.remove('bs-open');
    window.ScrollLock.release('blog-studio');
  }

  window.openBlogStudio = openBlogStudio;
  window.closeBlogStudio = closeBlogStudio;
  window.blogStudioAvailable = blogStudioAvailable;
  window.resolveBlogWriter = resolveBlogWriter;
})();
