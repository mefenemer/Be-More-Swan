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
    mediaTarget: 'feature', postStatus: null,
    // undefined = not fetched yet; null = fetched and the business has no URL on file.
    // The two must stay distinguishable or loadOrgWebsite() refetches on every open.
    orgWebsite: undefined };

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
    + '.bs-btn{padding:8px 14px;border-radius:8px;border:0;cursor:pointer;font-size:14px;}'
    + '.bs-btn-primary{background:#ec4899;color:#fff;}'
    + '.bs-btn-ghost{background:#f3f4f6;color:#111827;}'
    + '.bs-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}'
    + '.bs-title-input{width:100%;font-size:26px;font-weight:700;border:0;outline:0;padding:8px 0;background:transparent;}'
    + '.bs-editor{min-height:320px;border:1px solid #e5e7eb;border-radius:12px;padding:16px;background:#fff;}'
    + '.bs-snippet{font-family:ui-monospace,monospace;font-size:12px;background:#111827;color:#e5e7eb;'
    + 'padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-all;}'
    + '.bs-status{font-size:12px;color:#6b7280;}'
    + '.bs-hidden{display:none !important;}'
    + '.bs-feature-empty{font-size:12px;color:#6b7280;border:1px dashed #d1d5db;border-radius:8px;padding:20px;text-align:center;}'
    + '.bs-feature-preview img{width:100%;border-radius:8px;display:block;}'
    + '.bs-media-picker{margin-top:12px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-height:260px;overflow:auto;}'
    + '.bs-media-picker img,.bs-media-picker video{width:100%;height:72px;object-fit:cover;border-radius:6px;cursor:pointer;border:2px solid transparent;background:#000;}'
    + '.bs-media-picker img:hover,.bs-media-picker video:hover{border-color:#ec4899;}'
    + '.bs-media-empty{grid-column:1 / -1;font-size:12px;color:#6b7280;text-align:center;padding:12px;}'
    // Audio has no thumbnail — a labelled tile stands in, sized to match the image/video ones.
    + '.bs-media-audio{height:72px;border-radius:6px;cursor:pointer;border:2px solid #e5e7eb;'
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
    + '          <input id="bs-site-base" type="url" placeholder="https://acme.com"></div>'
    + '        <div class="bs-field"><label>Post URL pattern</label>'
    + '          <input id="bs-site-path" placeholder="/blog/{slug}">'
    + '          <span class="bs-status" style="font-size:11px;">Must start with / and contain {slug}. Needed for canonical URLs to point at your site.</span></div>'
    + '        <button id="bs-save-theme" class="bs-btn bs-btn-ghost">Save settings</button>'
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
    + '      <div class="bs-panel">'
    + '        <h3>Feature image</h3>'
    + '        <div id="bs-feature-preview" class="bs-feature-empty">No feature image yet.</div>'
    + '        <div class="bs-row" style="margin-top:12px;">'
    + '          <button id="bs-feature-library" class="bs-btn bs-btn-ghost">Choose from Library</button>'
    + '          <button id="bs-feature-upload" class="bs-btn bs-btn-ghost">Upload</button>'
    + '          <button id="bs-feature-pexels" class="bs-btn bs-btn-ghost">Stock photo</button>'
    + '          <button id="bs-feature-canva" class="bs-btn bs-btn-ghost">Canva</button>'
    + '          <button id="bs-feature-ai" class="bs-btn bs-btn-ghost">AI generate</button>'
    + '          <button id="bs-feature-remove" class="bs-btn bs-btn-ghost bs-hidden">Remove</button>'
    + '          <input type="file" id="bs-feature-upload-input" class="bs-hidden" accept="image/png,image/jpeg,image/gif,image/webp">'
    + '        </div>'
    + '        <div style="margin-top:14px;font-size:12px;color:#6b7280;">Inline body media</div>'
    + '        <div class="bs-row" style="margin-top:6px;">'
    + '          <button id="bs-inline-library" class="bs-btn bs-btn-ghost">Library</button>'
    + '          <button id="bs-inline-upload" class="bs-btn bs-btn-ghost">Upload</button>'
    + '          <button id="bs-inline-pexels" class="bs-btn bs-btn-ghost">Stock</button>'
    + '          <button id="bs-inline-canva" class="bs-btn bs-btn-ghost">Canva</button>'
    + '          <button id="bs-inline-ai" class="bs-btn bs-btn-ghost">AI</button>'
    // Video and audio are body-only: the hero input above stays images-only. Audio is upload-only
    // by decision (plan §7.4) — there is no stock provider and no AI generation, which is why the
    // Stock and AI buttons beside this one stay image/video. MIME list mirrors
    // content-upload-url.ts's ALLOWED_MIME_TYPES — widening it here without widening that would
    // just move the rejection to a worse place.
    + '          <input type="file" id="bs-inline-upload-input" class="bs-hidden" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/mp4,audio/wav,audio/webm,audio/ogg">'
    + '        </div>'
    + '        <div id="bs-ai-form" class="bs-field bs-hidden" style="margin-top:12px;">'
    + '          <input id="bs-ai-prompt" placeholder="Describe the image…">'
    + '          <button id="bs-ai-go" class="bs-btn bs-btn-ghost" style="margin-top:8px;">Generate</button></div>'
    + '        <div id="bs-pexels-form" class="bs-field bs-hidden" style="margin-top:12px;">'
    + '          <input id="bs-pexels-query" placeholder="Search stock photos…">'
    + '          <button id="bs-pexels-go" class="bs-btn bs-btn-ghost" style="margin-top:8px;">Search</button></div>'
    + '        <div id="bs-media-picker" class="bs-media-picker bs-hidden"></div>'
    + '        <span id="bs-media-status" class="bs-status"></span>'
    // Column layouts. Media can then be dragged into either side; the row stacks on a phone.
    + '        <div style="margin-top:14px;font-size:12px;color:#6b7280;">Layout</div>'
    + '        <div class="bs-row" style="margin-top:6px;">'
    + '          <button id="bs-cols-2" class="bs-btn bs-btn-ghost">2 columns</button>'
    + '          <button id="bs-cols-3" class="bs-btn bs-btn-ghost">3 columns</button>'
    + '        </div>'
    + '      </div>'
    // Syndication connectors moved to the assistant Connections tab; posts now auto-publish to
    // every connected blog on publish (no per-post panel here). See integrations.js / connection-map.
    + '      <div class="bs-panel" style="margin-top:16px;">'
    + '        <h3>Search performance</h3>'
    + '        <div id="bs-gsc-status" class="bs-status">Checking&hellip;</div>'
    + '        <div class="bs-row" style="margin-top:10px;">'
    + '          <button id="bs-gsc-connect" class="bs-btn bs-btn-ghost bs-hidden" type="button">Connect Google Search Console</button>'
    + '          <button id="bs-gsc-disconnect" class="bs-linkbtn bs-hidden" type="button">Disconnect</button>'
    + '        </div>'
    + '        <div class="bs-status" style="font-size:11px;margin-top:4px;">Lets your Blog Writer spot posts losing search traffic and flag them for a refresh.</div>'
    + '      </div>'
    + '    </div>'
    + '    <div>'
    + '      <div class="bs-row" style="justify-content:space-between;margin-bottom:4px;">'
    + '        <span id="bs-readout" class="bs-chip">0 words · under a minute read</span>'
    + '        <div class="bs-row" style="gap:12px;">'
    + '          <button type="button" id="bs-ai-draft" class="bs-swan"'
    + '            title="Draft this post from a topic with AI">'
    + '            <img src="/images/BeMoreSwan_SwanAI.png" alt=""><span>AI draft</span></button>'
    + '          <button type="button" id="bs-swan-improve" class="bs-swan bs-hidden"'
    + '            title="Ask your assistant to suggest improvements to this draft">'
    + '            <img src="/images/BeMoreSwan_SwanAI.png" alt=""><span>Ask Swan to improve</span></button>'
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
    // Scheduling mirrors the Create Post sheet: one guided question, not three loose button rows.
    + '      <div class="bs-panel" style="margin-top:16px;">'
    + '        <p class="bs-ready-q">Your post is ready. How should it go out?</p>'
    + '        <div class="bs-stack">'
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
    var a = selectedAssistant();
    el('bs-approve-name').textContent = a && a.name ? a.name : 'your assistant';
    loadWidget();
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
      if (post.status === 'published') el('bs-unpublish').classList.remove('bs-hidden');
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
  // These are SUGGESTIONS painted into the inputs on OPEN, never a silent write: the user still
  // presses "Save settings" to persist them, and a stored value always wins. Suggestions are
  // deliberately not re-applied after a save (applyWidget's `suggest` flag) — clearing a field,
  // saving, and watching it refill itself reads as the clear having been ignored.
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

  function loadWidget() {
    // Both in flight together: the config read is the slow one, and the org profile must be in hand
    // before applyWidget paints or the suggestion lands after the user has started typing.
    Promise.all([
      api('save-widget-config', { method: 'GET' }),
      loadOrgWebsite(),
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

  function applyWidget(cfg, opts) {
    var suggest = !!(opts && opts.suggest);
    renderSnippet(cfg.publicKey);
    populateFontPicker();
    var theme = cfg.theme || {};
    if (theme.accent) el('bs-accent').value = theme.accent;
    if (theme.fontFamily) { el('bs-font').value = theme.fontFamily; previewFont(theme.fontFamily); }
    el('bs-badge').checked = cfg.badgeEnabled !== false;
    el('bs-site-base').value = cfg.siteBaseUrl || (suggest ? (state.orgWebsite || '') : '');
    el('bs-site-path').value = cfg.sitePostPath || (suggest ? DEFAULT_SITE_POST_PATH : '');
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
      mediaEls.preview.textContent = 'No feature image yet.';
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
  function hidePicker() {
    mediaEls.picker.classList.add('bs-hidden');
    mediaEls.picker.innerHTML = '';
    mediaEls.aiForm.classList.add('bs-hidden');
    mediaEls.pexelsForm.classList.add('bs-hidden');
  }
  function attachFeature(assetId) {
    setStatus('bs-media-status', 'Attaching…');
    api('blog-media', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId, action: 'attach', role: 'feature', assetId: assetId }) })
      .then(function (res) {
        if (res.ok) { renderFeature(res.body.feature); hidePicker(); setStatus('bs-media-status', ''); }
        else setStatus('bs-media-status', (res.body && res.body.error) || 'Failed');
      });
  }
  function attachFeatureCandidate(candidate) {
    setStatus('bs-media-status', 'Attaching…');
    api('blog-media', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId, action: 'attach', role: 'feature', pexelsCandidate: candidate }) })
      .then(function (res) {
        if (res.ok) { renderFeature(res.body.feature); hidePicker(); setStatus('bs-media-status', ''); }
        else setStatus('bs-media-status', (res.body && res.body.error) || 'Failed');
      });
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
      state.editor.insertMedia(media);
      hidePicker(); setStatus('bs-media-status', '');
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
    // EVERY tile is draggable, whichever picker it came from. The gate used to be
    // `state.mediaTarget !== 'inline'`, which made the tiles under the "Stock photo" / "Choose from
    // Library" buttons (the FEATURE row) silently inert — two near-identical buttons, only the
    // smaller inline one draggable, and no feedback on the wrong one. That reads as "dragging is
    // broken", not "wrong button".
    //
    // A drop is unambiguous regardless of which picker opened: the hero is a single slot filled by
    // clicking, and the body is the only drop target, so onEditorDropMedia always attaches inline.
    // Clicking a tile still routes by state.mediaTarget, so the feature picker keeps its own job.
    tile.draggable = true;
    tile.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData(window.MarkdownEditor.MEDIA_MIME, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'copy';
    });
  }
  function routeMedia(body) {
    if (state.mediaTarget === 'inline') return attachInline(body);
    if (body.pexelsCandidate) return attachFeatureCandidate(body.pexelsCandidate);
    return attachFeature(body.assetId);
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
      setStatus('bs-media-status', '');
      routeMedia({ assetId: asset.id });
    }).catch(function (err) {
      setStatus('bs-media-status', err.message || 'Upload failed. Please try again.');
    });
  }
  function openLibrary() {
    if (!state.postId) return;
    mediaEls.aiForm.classList.add('bs-hidden');
    mediaEls.pexelsForm.classList.add('bs-hidden');
    mediaEls.picker.classList.remove('bs-hidden');
    mediaEls.picker.innerHTML = '<div class="bs-media-empty">Loading…</div>';
    api('content-assets', { method: 'GET' }).then(function (res) {
      if (!res.ok) { mediaEls.picker.innerHTML = '<div class="bs-media-empty">Could not load library.</div>'; return; }
      var groups = res.body.assets || {};
      var all = [].concat(groups.pending || [], groups.scheduled || [], groups.posted || []);
      // The hero must be an image (blog-media rejects anything else for the feature role), but the
      // body can carry video too — so the inline picker offers both.
      var inline = state.mediaTarget === 'inline';
      var items = all.filter(function (a) {
        if (!(a.storageUrl || a.externalUrl)) return false;
        return a.assetType === 'image'
          || (inline && (a.assetType === 'video' || a.assetType === 'audio'));
      });
      if (!items.length) {
        mediaEls.picker.innerHTML = '<div class="bs-media-empty">'
          + (inline ? 'No images, videos or audio in your library yet.' : 'No images in your library yet.')
          + '</div>';
        return;
      }
      mediaEls.picker.innerHTML = '';
      items.forEach(function (a) {
        // A <video> with preload=metadata shows its first frame, which is a usable thumbnail —
        // content_assets has no separate poster to fall back on.
        var isVideo = a.assetType === 'video';
        var isAudio = a.assetType === 'audio';
        // Audio has no frame to show, so it gets a labelled tile rather than a broken thumbnail.
        // A real <audio> element here would be a player the author has to avoid clicking to pick.
        var tile = document.createElement(isAudio ? 'div' : (isVideo ? 'video' : 'img'));
        if (isAudio) {
          tile.className = 'bs-media-audio';
          tile.textContent = '♪ ' + (a.name || 'Audio');
        } else {
          tile.src = a.storageUrl || a.externalUrl;
          if (isVideo) { tile.preload = 'metadata'; tile.muted = true; }
          else { tile.alt = a.name || ''; }
        }
        tile.title = a.name || '';
        tile.addEventListener('click', function () { routeMedia({ assetId: a.id }); });
        makeTileDraggable(tile, { source: 'library', assetId: a.id, type: a.assetType || 'image' });
        mediaEls.picker.appendChild(tile);
      });
    });
  }
  // Canva imports land in content_assets like any other source, so once the picker reports back
  // there is nothing Canva-specific left to do — routeMedia attaches the asset exactly as the
  // Library and Upload paths do. assetType 'image' keeps video designs out: a feature or inline
  // image can't be an mp4.
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
        // A multi-page design yields several assets; attach the first and leave the rest in the
        // library rather than stuffing every page into the post.
        routeMedia({ assetId: assetIds[0] });
      },
    });
  }
  function openAiForm() {
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

    el('bs-publish').addEventListener('click', function () {
      if (!state.postId || blockedAsEmpty()) return;
      setBanner('bs-action-status', 'Publishing…');
      flushDraft().then(function () {
        return api('publish-blog', { method: 'POST', body: JSON.stringify({ id: state.postId }) });
      }).then(function (res) {
        if (res.ok) {
          setBanner('bs-action-status', 'Published ✓ (' + res.body.post.slug + ')');
          el('bs-unschedule').classList.add('bs-hidden');
          el('bs-unpublish').classList.remove('bs-hidden');
        } else setBanner('bs-action-status', (res.body && res.body.error) || 'Could not publish — please try again.', 'error');
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
    el('bs-discard').addEventListener('click', function () {
      if (!state.postId) return;
      if (!window.confirm('Archive this draft? You can find it again in the Archive tab.')) return;
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
        } else setBanner('bs-action-status', (res.body && res.body.error) || 'Could not clear the schedule.', 'error');
      });
    });

    // Unpublish — takes the post off the org's own site only. Syndicated copies stay live (no
    // adapter can retract them), so name the ones that do in the confirm AND in the result banner.
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

    // Preview as soon as a family is picked, not only after Save — otherwise the author is choosing
    // from a list of names rendered in a font they cannot see.
    el('bs-font').addEventListener('change', function () { previewFont(el('bs-font').value); });

    el('bs-save-theme').addEventListener('click', function () {
      // fontUrl travels WITH the stack. widget.js and the /b/:key/:slug permalink both need the
      // stylesheet, and neither carries the catalogue — resolving it here is what turns a font
      // choice into a font that actually loads. null for a system stack that needs no download.
      var stack = el('bs-font').value;
      var theme = {
        accent: el('bs-accent').value,
        fontFamily: stack,
        fontUrl: (window.BlogFonts && window.BlogFonts.urlFor(stack)) || null,
      };
      api('save-widget-config', { method: 'POST', body: JSON.stringify({
        action: 'update', theme: theme, badgeEnabled: el('bs-badge').checked,
        siteBaseUrl: el('bs-site-base').value.trim(), sitePostPath: el('bs-site-path').value.trim(),
      }) }).then(function (res) {
        if (res.ok) { setBanner('bs-action-status', 'Settings saved.'); applyWidget(res.body.config); }
        else setBanner('bs-action-status', (res.body && res.body.error) || 'Could not save settings.', 'error');
      });
    });

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
      preview: el('bs-feature-preview'), library: el('bs-feature-library'), pexels: el('bs-feature-pexels'),
      ai: el('bs-feature-ai'), remove: el('bs-feature-remove'),
      upload: el('bs-feature-upload'), uploadInput: el('bs-feature-upload-input'),
      aiForm: el('bs-ai-form'), aiPrompt: el('bs-ai-prompt'), aiGo: el('bs-ai-go'),
      pexelsForm: el('bs-pexels-form'), pexelsQuery: el('bs-pexels-query'), pexelsGo: el('bs-pexels-go'),
      picker: el('bs-media-picker'), canva: el('bs-feature-canva'),
      inlineLibrary: el('bs-inline-library'), inlinePexels: el('bs-inline-pexels'), inlineAi: el('bs-inline-ai'),
      inlineUpload: el('bs-inline-upload'), inlineUploadInput: el('bs-inline-upload-input'),
      inlineCanva: el('bs-inline-canva'),
      cols2: el('bs-cols-2'), cols3: el('bs-cols-3'),
    };

    mediaEls.remove.addEventListener('click', function () {
      if (!state.postId) return;
      api('blog-media', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId, action: 'detach', role: 'feature' }) })
        .then(function (res) { if (res.ok) renderFeature(res.body.feature); });
    });
    // A column layout is body structure, not media, so it doesn't route through mediaTarget or the
    // picker — it goes straight into the draft, after whichever block the author last touched.
    function insertColumns(n) {
      if (!state.editor) return;
      state.editor.insertColumns(n);
      setStatus('bs-media-status', 'Column layout added — drag media into a column, or click to edit the text.');
    }
    mediaEls.cols2.addEventListener('click', function () { insertColumns(2); });
    mediaEls.cols3.addEventListener('click', function () { insertColumns(3); });
    mediaEls.library.addEventListener('click', function () { state.mediaTarget = 'feature'; openLibrary(); });
    mediaEls.inlineLibrary.addEventListener('click', function () { state.mediaTarget = 'inline'; openLibrary(); });
    mediaEls.ai.addEventListener('click', function () { state.mediaTarget = 'feature'; openAiForm(); });
    mediaEls.inlineAi.addEventListener('click', function () { state.mediaTarget = 'inline'; openAiForm(); });
    mediaEls.pexels.addEventListener('click', function () { state.mediaTarget = 'feature'; openPexelsForm(); });
    mediaEls.inlinePexels.addEventListener('click', function () { state.mediaTarget = 'inline'; openPexelsForm(); });
    mediaEls.canva.addEventListener('click', function () { state.mediaTarget = 'feature'; openCanva(); });
    mediaEls.inlineCanva.addEventListener('click', function () { state.mediaTarget = 'inline'; openCanva(); });
    mediaEls.upload.addEventListener('click', function () { state.mediaTarget = 'feature'; mediaEls.uploadInput.click(); });
    mediaEls.inlineUpload.addEventListener('click', function () { state.mediaTarget = 'inline'; mediaEls.inlineUploadInput.click(); });
    mediaEls.uploadInput.addEventListener('change', handleUploadInput);
    mediaEls.inlineUploadInput.addEventListener('change', handleUploadInput);

    mediaEls.aiGo.addEventListener('click', function () {
      var prompt = mediaEls.aiPrompt.value.trim();
      if (!prompt || !state.postId) return;
      setStatus('bs-media-status', 'Generating…');
      mediaEls.picker.classList.remove('bs-hidden');
      mediaEls.picker.innerHTML = '<div class="bs-media-empty">Generating…</div>';
      api('generate-ai-image', { method: 'POST', body: JSON.stringify({ prompt: prompt, aspectRatio: '16:9' }) })
        .then(function (res) {
          if (!res.ok) { setStatus('bs-media-status', (res.body && res.body.error) || 'Generation failed'); mediaEls.picker.innerHTML = ''; return; }
          setStatus('bs-media-status', 'Pick a variation');
          var jobId = res.body.jobId;
          mediaEls.picker.innerHTML = '';
          (res.body.images || []).forEach(function (im) {
            var img = document.createElement('img');
            img.src = im.url;
            img.addEventListener('click', function () {
              setStatus('bs-media-status', 'Saving…');
              api('generate-ai-image', { method: 'POST', body: JSON.stringify({ action: 'select', jobId: jobId, index: im.index }) })
                .then(function (sel) {
                  if (sel.ok && sel.body.assetId) routeMedia({ assetId: sel.body.assetId });
                  else setStatus('bs-media-status', (sel.body && sel.body.error) || 'Could not save image');
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
          if (!candidates.length) { mediaEls.picker.innerHTML = '<div class="bs-media-empty">No matches — try a different search.</div>'; setStatus('bs-media-status', ''); return; }
          setStatus('bs-media-status', 'Pick a photo');
          mediaEls.picker.innerHTML = '';
          candidates.forEach(function (c) {
            var img = document.createElement('img');
            img.src = c.url;
            img.alt = c.title || '';
            img.title = c.photographer ? ('Photo by ' + c.photographer + ' on Pexels') : '';
            img.addEventListener('click', function () { routeMedia({ pexelsCandidate: c }); });
            makeTileDraggable(img, { source: 'pexels', pexelsCandidate: c, type: 'image' });
            mediaEls.picker.appendChild(img);
          });
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
    ['bs-save-status', 'bs-media-status', 'bs-ai-draft-status'].forEach(function (id) { setStatus(id, ''); });
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
  function notifyChanged() {
    try { window._onBlogStudioChanged && window._onBlogStudioChanged(); }
    catch (e) { /* the host page is optional — the modal must still close */ }
  }

  function closeBlogStudio() {
    if (!state.injected) return;
    if (state.editor && state.editor.destroy) { state.editor.destroy(); state.editor = null; }
    el('bms-blog-backdrop').classList.remove('bs-open');
    window.ScrollLock.release('blog-studio');
  }

  window.openBlogStudio = openBlogStudio;
  window.closeBlogStudio = closeBlogStudio;
  window.blogStudioAvailable = blogStudioAvailable;
  window.resolveBlogWriter = resolveBlogWriter;
})();
