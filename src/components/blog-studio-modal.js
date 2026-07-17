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

  var state = { injected: false, postId: null, editor: null, assistants: {}, assistantId: null, mediaTarget: 'feature' };

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

  // Voice dictation into a text field (mirrors gpStartVoice in workspace.html — the Blog Studio is
  // loaded standalone too, so it can't borrow that page-scoped copy).
  function startVoice(targetId, micId) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var mic = el(micId);
    if (!SR) { setBanner('bs-brief-status', 'Voice input is not supported in this browser. Try Chrome or Safari.', 'error'); return; }
    var rec = new SR();
    rec.lang = 'en-GB';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    if (mic) mic.classList.add('bs-recording');
    rec.onresult = function (e) {
      var field = el(targetId);
      if (!field) return;
      var transcript = e.results[0][0].transcript;
      field.value = (field.value ? field.value + ' ' : '') + transcript;
    };
    rec.onend = function () { if (mic) mic.classList.remove('bs-recording'); };
    rec.onerror = function () { if (mic) mic.classList.remove('bs-recording'); };
    rec.start();
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
    + '.bs-media-picker img{width:100%;height:72px;object-fit:cover;border-radius:6px;cursor:pointer;border:2px solid transparent;}'
    + '.bs-media-picker img:hover{border-color:#ec4899;}'
    + '.bs-media-empty{grid-column:1 / -1;font-size:12px;color:#6b7280;text-align:center;padding:12px;}'
    + '.bs-synd-row{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;}'
    + '.bs-synd-form{flex-basis:100%;margin-top:8px;}'
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

  var MIC_SVG = '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">'
    + '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M12 3a4 4 0 014 4v4a4 4 0 01-8 0V7a4 4 0 014-4z"/></svg>';

  // Author is always the user (no "Written by"); the brief is Topic + Keywords + Voice + Notes.
  var MARKUP = ''
    + '<div class="bms-blog-panel">'
    + '  <button type="button" class="bms-blog-close" id="bs-close" aria-label="Close">&times;</button>'
    + '  <div class="bs-row" style="justify-content:space-between;margin-bottom:16px;padding-right:40px;">'
    + '    <h1 style="font-size:20px;font-weight:700;">Blog Studio</h1>'
    + '    <span id="bs-save-status" class="bs-status"></span>'
    + '  </div>'
    + '  <div id="bs-brief" class="bs-panel" style="margin-bottom:24px;">'
    + '    <h3>Start a new post</h3>'
    + '    <div class="bs-grid" style="grid-template-columns:1fr 1fr;">'
    + '      <div class="bs-field"><label>Topic</label><input id="bs-topic" placeholder="e.g. AI for small teams"></div>'
    + '      <div class="bs-field"><label>Keywords</label><input id="bs-keywords" placeholder="comma,separated"></div>'
    + '    </div>'
    + '    <div class="bs-field bs-hidden" id="bs-voice-from"><label>Voice (from your assistant)</label>'
    + '      <div id="bs-voice-display" class="bs-status"></div></div>'
    + '    <div class="bs-field" id="bs-voice-manual"><label>Tone</label>'
    + '      <input id="bs-tone" list="bs-tone-presets" placeholder="e.g. friendly and professional">'
    + '      <datalist id="bs-tone-presets"><option>Professional</option><option>Casual</option><option>Confident</option><option>Friendly</option></datalist>'
    + '      <label id="bs-save-tone-wrap" class="bs-status bs-hidden" style="margin-top:6px;">'
    + '        <input id="bs-save-tone" type="checkbox"> Save this as <span id="bs-save-tone-name"></span>&rsquo;s voice</label>'
    + '    </div>'
    + '    <div class="bs-field"><label>Rough notes / transcript (optional)</label>'
    + '      <div class="bs-textarea-wrap"><textarea id="bs-notes" rows="3" placeholder="Dictate or paste your notes…"></textarea>'
    + '        <button type="button" id="bs-notes-mic" class="bs-mic" title="Dictate notes" aria-label="Dictate notes">' + MIC_SVG + '</button>'
    + '      </div>'
    + '    </div>'
    + '    <div class="bs-row">'
    + '      <button class="bs-btn bs-btn-ghost" data-path="blank">Start blank</button>'
    + '      <button class="bs-btn bs-btn-ghost" data-path="improve">Improve draft</button>'
    + '      <button class="bs-btn bs-btn-primary" data-path="generate">AI generate</button>'
    + '    </div>'
    + '    <div id="bs-brief-status" class="bs-banner bs-hidden"></div>'
    + '  </div>'
    + '  <div id="bs-workspace" class="bs-grid bs-hidden">'
    + '    <div>'
    + '      <div class="bs-panel" style="margin-bottom:16px;">'
    + '        <h3>Widget</h3>'
    + '        <div class="bs-field"><label>Accent colour</label><input id="bs-accent" type="color" value="#ec4899"></div>'
    + '        <div class="bs-field"><label>Font family</label><select id="bs-font">'
    + '          <option value="system-ui, sans-serif">System</option>'
    + '          <option value="Georgia, serif">Serif</option>'
    + '          <option value="\'Inter\', sans-serif">Inter</option></select></div>'
    + '        <div class="bs-field"><label><input id="bs-badge" type="checkbox" checked> Show AI transparency badge</label></div>'
    + '        <button id="bs-save-theme" class="bs-btn bs-btn-ghost">Save theme</button>'
    + '        <div style="margin-top:12px;"><label class="bs-status">Embed snippet</label>'
    + '          <div id="bs-snippet" class="bs-snippet">Create a widget to get your embed code.</div></div>'
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
    + '        <div style="margin-top:14px;font-size:12px;color:#6b7280;">Inline body image</div>'
    + '        <div class="bs-row" style="margin-top:6px;">'
    + '          <button id="bs-inline-library" class="bs-btn bs-btn-ghost">Library</button>'
    + '          <button id="bs-inline-upload" class="bs-btn bs-btn-ghost">Upload</button>'
    + '          <button id="bs-inline-pexels" class="bs-btn bs-btn-ghost">Stock</button>'
    + '          <button id="bs-inline-canva" class="bs-btn bs-btn-ghost">Canva</button>'
    + '          <button id="bs-inline-ai" class="bs-btn bs-btn-ghost">AI</button>'
    + '          <input type="file" id="bs-inline-upload-input" class="bs-hidden" accept="image/png,image/jpeg,image/gif,image/webp">'
    + '        </div>'
    + '        <div id="bs-ai-form" class="bs-field bs-hidden" style="margin-top:12px;">'
    + '          <input id="bs-ai-prompt" placeholder="Describe the image…">'
    + '          <button id="bs-ai-go" class="bs-btn bs-btn-ghost" style="margin-top:8px;">Generate</button></div>'
    + '        <div id="bs-pexels-form" class="bs-field bs-hidden" style="margin-top:12px;">'
    + '          <input id="bs-pexels-query" placeholder="Search stock photos…">'
    + '          <button id="bs-pexels-go" class="bs-btn bs-btn-ghost" style="margin-top:8px;">Search</button></div>'
    + '        <div id="bs-media-picker" class="bs-media-picker bs-hidden"></div>'
    + '        <span id="bs-media-status" class="bs-status"></span>'
    + '      </div>'
    + '      <div class="bs-panel" style="margin-top:16px;">'
    + '        <h3>Syndicate</h3>'
    + '        <div id="bs-synd-list" class="bs-status">Loading destinations…</div>'
    + '        <button id="bs-synd-publish" class="bs-btn bs-btn-ghost bs-hidden" style="margin-top:10px;">Publish to selected</button>'
    + '        <span id="bs-synd-status" class="bs-status" style="display:block;margin-top:6px;"></span>'
    + '        <div class="bs-status" style="font-size:11px;margin-top:4px;">Publish to your site first, then push to connected blogs.</div>'
    + '      </div>'
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
    + '        <button type="button" id="bs-swan-improve" class="bs-swan bs-hidden"'
    + '          title="Ask your assistant to suggest improvements to this draft">'
    + '          <img src="/images/BeMoreSwan_SwanAI.png" alt=""><span>Ask Swan to improve</span></button>'
    + '      </div>'
    + '      <input id="bs-title" class="bs-title-input" placeholder="Post title">'
    + '      <div id="bs-editor" class="bs-editor"></div>'
    + '      <div class="bs-row" style="margin-top:16px;">'
    + '        <button id="bs-generate-hooks" class="bs-btn bs-btn-ghost">Generate A/B hooks</button>'
    + '        <button id="bs-generate-seo" class="bs-btn bs-btn-ghost">Generate SEO</button>'
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
    + '          <button id="bs-discard" class="bs-btn bs-btn-danger">Discard draft</button>'
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

  function syncVoiceControls() {
    var a = selectedAssistant();
    var hasProfileTone = a && a.tone;
    el('bs-voice-from').classList.toggle('bs-hidden', !hasProfileTone);
    el('bs-voice-manual').classList.toggle('bs-hidden', !!hasProfileTone);
    if (hasProfileTone) {
      el('bs-voice-display').textContent = '“' + a.tone + '” — from ' + a.name + '’s profile';
    }
    var offerSave = !!a && !hasProfileTone;
    el('bs-save-tone-wrap').classList.toggle('bs-hidden', !offerSave);
    if (offerSave) el('bs-save-tone-name').textContent = a.name;
  }

  // Voice for this post: { assistantId, tone, saveToProfile }.
  function resolveVoice() {
    var a = selectedAssistant();
    if (a && a.tone) return { assistantId: a.id, tone: a.tone, saveToProfile: false };
    var manual = el('bs-tone').value.trim();
    return {
      assistantId: a ? a.id : null,
      tone: manual,
      saveToProfile: !!(a && manual && el('bs-save-tone').checked),
    };
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

  function seedMarkdown(path, tone) {
    var topic = el('bs-topic').value.trim();
    var notes = el('bs-notes').value.trim();
    if (path === 'improve' && notes) return notes;
    if (path === 'generate') {
      var voice = tone ? ' in a ' + tone + ' tone' : '';
      return '# ' + (topic || 'New post') + '\n\n_Drafting' + voice + '…_\n\n' + (notes || '');
    }
    return '# ' + (topic || 'New post') + '\n\nStart writing here.';
  }

  // Reveal the editor workspace for a post (new or existing): mount the editor + side panels.
  function openWorkspace(postId, title, md) {
    state.postId = postId;
    el('bs-brief').classList.add('bs-hidden');
    el('bs-workspace').classList.remove('bs-hidden');
    el('bs-title').value = title;
    if (state.editor && state.editor.destroy) state.editor.destroy();  // re-open safety: no leaked listeners
    state.editor = window.MarkdownEditor.mount({
      container: el('bs-editor'),
      blogPostId: postId,
      initialMarkdown: md,
      title: title,
      onChange: function (nextMd) {
        refreshReadout(nextMd);
        setStatus('bs-save-status', 'Saving…');
        setTimeout(function () { setStatus('bs-save-status', 'Saved'); }, 1400);
      },
    });
    refreshReadout(md);
    syncSwanButton();
    var a = selectedAssistant();
    el('bs-approve-name').textContent = a && a.name ? a.name : 'your assistant';
    loadWidget();
    loadFeature();
    loadSyndication();
    loadSearchConsole();
    return state.editor;
  }

  function startPost(path) {
    var title = el('bs-topic').value.trim() || 'Untitled draft';
    var voice = resolveVoice();
    if (voice.saveToProfile) {
      api('blog-tone', { method: 'POST', body: JSON.stringify({ assistantId: voice.assistantId, tone: voice.tone }) });
    }
    setBanner('bs-brief-status', '');
    api('blog-posts', { method: 'POST', body: JSON.stringify({ title: title, assistantId: voice.assistantId }) }).then(function (res) {
      if (!res.ok) { setBanner('bs-brief-status', 'Could not create post: ' + (res.body.error || 'please try again.'), 'error'); return; }
      openWorkspace(res.body.post.id, title, seedMarkdown(path, voice.tone));
      if (path === 'generate') {
        setStatus('bs-save-status', 'Drafting…');
        api('generate-blog', { method: 'POST', body: JSON.stringify({
          blogPostId: state.postId,
          topic: el('bs-topic').value.trim(),
          keywords: el('bs-keywords').value.trim(),
          notes: el('bs-notes').value.trim(),
          tone: voice.tone,
        }) }).then(function (gen) {
          if (gen.ok && gen.body.bodyMarkdown) {
            state.editor.setMarkdown(gen.body.bodyMarkdown);
            refreshReadout(gen.body.bodyMarkdown);   // setMarkdown doesn't fire onChange
            setStatus('bs-save-status', 'Draft ready');
          } else {
            setStatus('bs-save-status', (gen.body && gen.body.error) || 'Draft failed');
          }
        });
      }
    });
  }

  function loadExistingPost(id) {
    setStatus('bs-save-status', 'Loading…');
    api('blog-posts?id=' + encodeURIComponent(id), { method: 'GET' }).then(function (res) {
      if (!res.ok || !res.body.post) { setStatus('bs-save-status', ''); return; }
      var post = res.body.post;
      if (post.assistantId != null) state.assistantId = post.assistantId;
      openWorkspace(post.id, post.title || 'Untitled draft', post.bodyMarkdown || '');
      setStatus('bs-save-status', 'Saved');
      if (post.status) setBanner('bs-action-status', 'Status: ' + post.status);
      // A post already on the calendar can be pulled back off it.
      if (post.status === 'scheduled') el('bs-unschedule').classList.remove('bs-hidden');
    }).catch(function () { setStatus('bs-save-status', ''); });
  }

  // ── Widget config / theming ────────────────────────────────────────────────────────────────────
  function renderSnippet(key) {
    el('bs-snippet').textContent =
      '<script async src="' + location.origin + '/widget.js"\n        data-bms-key="' + key + '" data-bms-mount="#bms-blog"><\/script>';
  }
  function loadWidget() {
    api('save-widget-config', { method: 'GET' }).then(function (res) {
      var cfg = res.body.config;
      if (!cfg) {
        return api('save-widget-config', { method: 'POST', body: JSON.stringify({ action: 'create' }) })
          .then(function (r) { if (r.ok) applyWidget(r.body.config); });
      }
      applyWidget(cfg);
    });
  }
  function applyWidget(cfg) {
    renderSnippet(cfg.publicKey);
    var theme = cfg.theme || {};
    if (theme.accent) el('bs-accent').value = theme.accent;
    if (theme.fontFamily) el('bs-font').value = theme.fontFamily;
    el('bs-badge').checked = cfg.badgeEnabled !== false;
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
  // Attach an image as inline body media, then insert an asset:// block. `body` is { assetId } or
  // { pexelsCandidate }. Inline attach appends, so the new asset is the last inline[] item.
  function attachInline(body) {
    if (!state.postId || !state.editor) return;
    setStatus('bs-media-status', 'Adding…');
    api('blog-media', { method: 'POST', body: JSON.stringify(Object.assign({ blogPostId: state.postId, action: 'attach', role: 'inline' }, body)) })
      .then(function (res) {
        if (!res.ok) { setStatus('bs-media-status', (res.body && res.body.error) || 'Failed'); return; }
        var inline = (res.body && res.body.inline) || [];
        var item = body.assetId != null
          ? (inline.filter(function (m) { return m.assetId === body.assetId; })[0] || inline[inline.length - 1])
          : inline[inline.length - 1];
        if (item) state.editor.insertImage({ assetId: item.assetId, url: item.url, alt: item.name || '' });
        hidePicker(); setStatus('bs-media-status', '');
      });
  }
  function routeImage(body) {
    if (state.mediaTarget === 'inline') return attachInline(body);
    if (body.pexelsCandidate) return attachFeatureCandidate(body.pexelsCandidate);
    return attachFeature(body.assetId);
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
            name: file.name, assetType: 'image', mimeType: file.type, fileSize: file.size, storageKey: storageKey, storageUrl: storageUrl,
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
      routeImage({ assetId: asset.id });
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
      var images = all.filter(function (a) { return a.assetType === 'image' && (a.storageUrl || a.externalUrl); });
      if (!images.length) { mediaEls.picker.innerHTML = '<div class="bs-media-empty">No images in your library yet.</div>'; return; }
      mediaEls.picker.innerHTML = '';
      images.forEach(function (a) {
        var img = document.createElement('img');
        img.src = a.storageUrl || a.externalUrl;
        img.alt = a.name || '';
        img.addEventListener('click', function () { routeImage({ assetId: a.id }); });
        mediaEls.picker.appendChild(img);
      });
    });
  }
  // Canva imports land in content_assets like any other source, so once the picker reports back
  // there is nothing Canva-specific left to do — routeImage attaches the asset exactly as the
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
        routeImage({ assetId: assetIds[0] });
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

  // ── Syndication: external blog connectors (US 3.2 — Dev.to, Hashnode) ──────────────────────────
  function loadSyndication() {
    var listEl = el('bs-synd-list');
    if (!listEl) return;
    listEl.textContent = 'Loading destinations…';
    setStatus('bs-synd-status', '');
    api('connect-blog-destination', { method: 'GET' }).then(function (res) {
      if (!res.ok) { listEl.textContent = 'Could not load destinations.'; return; }
      renderSyndication(res.body.destinations || []);
    }).catch(function () { listEl.textContent = 'Could not load destinations.'; });
  }

  function renderSyndication(destinations) {
    var listEl = el('bs-synd-list');
    listEl.innerHTML = '';
    if (!destinations.length) { listEl.textContent = 'No destinations available.'; el('bs-synd-publish').classList.add('bs-hidden'); return; }
    var anyConnected = false;
    destinations.forEach(function (d) {
      var row = document.createElement('div');
      row.className = 'bs-synd-row';
      if (d.connected) {
        anyConnected = true;
        var lbl = document.createElement('label');
        lbl.style.display = 'flex'; lbl.style.alignItems = 'center'; lbl.style.gap = '6px';
        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.className = 'bs-synd-check'; cb.value = d.id; cb.checked = true;
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(d.label + (d.accountLabel ? ' (' + d.accountLabel + ')' : '')));
        row.appendChild(lbl);
        var disc = document.createElement('button');
        disc.type = 'button'; disc.className = 'bs-linkbtn'; disc.textContent = 'Disconnect';
        disc.addEventListener('click', function () { disconnectDest(d.id); });
        row.appendChild(disc);
      } else {
        var connectBtn = document.createElement('button');
        connectBtn.type = 'button'; connectBtn.className = 'bs-btn bs-btn-ghost'; connectBtn.textContent = 'Connect ' + d.label;
        if (d.oauth) {
          // OAuth destinations (e.g. WordPress.com) connect via a full-page redirect, not a paste form.
          connectBtn.addEventListener('click', function () { if (d.connectUrl) window.location.href = d.connectUrl; });
        } else {
          connectBtn.addEventListener('click', function () { toggleConnectForm(row, d); });
        }
        row.appendChild(connectBtn);
      }
      listEl.appendChild(row);
    });
    el('bs-synd-publish').classList.toggle('bs-hidden', !anyConnected);
  }

  function toggleConnectForm(row, d) {
    var open = row.querySelector('.bs-synd-form');
    if (open) { open.parentNode.removeChild(open); return; }
    var form = document.createElement('div');
    form.className = 'bs-synd-form';
    var inputs = {};
    d.credFields.forEach(function (f) {
      var wrap = document.createElement('div'); wrap.className = 'bs-field';
      var lab = document.createElement('label'); lab.textContent = f.label + (f.help ? ' — ' + f.help : '');
      var inp = document.createElement('input'); inp.type = f.secret ? 'password' : 'text';
      inputs[f.key] = inp;
      wrap.appendChild(lab); wrap.appendChild(inp); form.appendChild(wrap);
    });
    var save = document.createElement('button');
    save.type = 'button'; save.className = 'bs-btn bs-btn-primary'; save.textContent = 'Connect';
    var msg = document.createElement('span'); msg.className = 'bs-status'; msg.style.marginLeft = '8px';
    save.addEventListener('click', function () {
      var creds = {};
      Object.keys(inputs).forEach(function (k) { creds[k] = inputs[k].value.trim(); });
      msg.textContent = 'Connecting…';
      api('connect-blog-destination', { method: 'POST', body: JSON.stringify({ action: 'connect', provider: d.id, creds: creds }) })
        .then(function (res) {
          if (res.ok) loadSyndication();
          else msg.textContent = (res.body && res.body.error) || 'Connection failed.';
        }).catch(function () { msg.textContent = 'Connection failed.'; });
    });
    form.appendChild(save); form.appendChild(msg);
    row.appendChild(form);
  }

  function disconnectDest(id) {
    api('connect-blog-destination', { method: 'POST', body: JSON.stringify({ action: 'disconnect', provider: id }) })
      .then(function () { loadSyndication(); });
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
    Array.prototype.forEach.call(document.querySelectorAll('#bs-brief [data-path]'), function (btn) {
      btn.addEventListener('click', function () { startPost(btn.getAttribute('data-path')); });
    });

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

    el('bs-notes-mic').addEventListener('click', function () { startVoice('bs-notes', 'bs-notes-mic'); });
    el('bs-swan-improve').addEventListener('click', askSwanImprove);

    el('bs-publish').addEventListener('click', function () {
      if (!state.postId) return;
      setBanner('bs-action-status', 'Publishing…');
      api('publish-blog', { method: 'POST', body: JSON.stringify({ id: state.postId }) }).then(function (res) {
        if (res.ok) setBanner('bs-action-status', 'Published ✓ (' + res.body.post.slug + ')');
        else setBanner('bs-action-status', (res.body && res.body.error) || 'Could not publish — please try again.', 'error');
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

    // Discard — drafts only; blog-posts DELETE refuses a published post.
    el('bs-discard').addEventListener('click', function () {
      if (!state.postId) return;
      if (!window.confirm('Discard this draft? This cannot be undone.')) return;
      setBanner('bs-action-status', 'Discarding…');
      api('blog-posts?id=' + encodeURIComponent(state.postId), { method: 'DELETE' }).then(function (res) {
        if (res.ok) closeBlogStudio();
        else setBanner('bs-action-status', (res.body && res.body.error) || 'Could not discard this draft.', 'error');
      });
    });

    // Search Console connect (OAuth redirect) / disconnect for the content-decay loop.
    el('bs-gsc-connect').addEventListener('click', function () {
      window.location.href = '/.netlify/functions/oauth-integrations?provider=searchconsole&action=connect';
    });
    el('bs-gsc-disconnect').addEventListener('click', function () {
      api('oauth-integrations?provider=searchconsole&action=disconnect', { method: 'POST' }).then(function () { loadSearchConsole(); });
    });

    // Syndicate the published post to the selected external blogs (Dev.to, Hashnode).
    el('bs-synd-publish').addEventListener('click', function () {
      if (!state.postId) return;
      var targets = Array.prototype.map.call(document.querySelectorAll('.bs-synd-check:checked'), function (c) { return c.value; });
      if (!targets.length) { setStatus('bs-synd-status', 'Select at least one destination.'); return; }
      setStatus('bs-synd-status', 'Publishing…');
      api('publish-blog-destinations', { method: 'POST', body: JSON.stringify({ postId: state.postId, targets: targets }) }).then(function (res) {
        if (!res.ok) { setStatus('bs-synd-status', (res.body && res.body.error) || 'Failed'); return; }
        var results = res.body.results || {};
        var parts = Object.keys(results).map(function (k) {
          var r = results[k];
          if (r.status === 'published' || r.status === 'draft') return k + ' ✓';
          if (r.status === 'not_connected') return k + ' (not connected)';
          return k + ' ✗';
        });
        setStatus('bs-synd-status', parts.join(' · '));
      });
    });

    // Approve & schedule — the assistant picks the next free cadence slot (no manual date).
    el('bs-approve').addEventListener('click', function () {
      if (!state.postId) return;
      setBanner('bs-action-status', 'Scheduling…');
      api('schedule-blog', { method: 'POST', body: JSON.stringify({ id: state.postId, action: 'approve' }) }).then(function (res) {
        if (res.ok && res.body.post) {
          setBanner('bs-action-status', 'Approved — scheduled for ' + new Date(res.body.post.publishDate).toLocaleString());
          el('bs-unschedule').classList.remove('bs-hidden');
        } else setBanner('bs-action-status', (res.body && res.body.error) || 'Could not schedule this post.', 'error');
      });
    });

    el('bs-schedule').addEventListener('click', function () {
      if (!state.postId) return;
      var iso = localToISO(el('bs-schedule-at').value);
      if (!iso) { setBanner('bs-action-status', 'Pick a date & time.', 'error'); return; }
      setBanner('bs-action-status', 'Scheduling…');
      api('schedule-blog', { method: 'POST', body: JSON.stringify({ id: state.postId, publishDate: iso }) }).then(function (res) {
        if (res.ok) {
          setBanner('bs-action-status', 'Scheduled for ' + new Date(res.body.post.publishDate).toLocaleString());
          el('bs-schedule-picker').classList.add('bs-hidden');
          el('bs-unschedule').classList.remove('bs-hidden');
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

    el('bs-generate-hooks').addEventListener('click', function () {
      if (!state.postId) return;
      setBanner('bs-action-status', 'Generating hooks…');
      api('generate-hooks', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId }) }).then(function (res) {
        if (res.ok) setBanner('bs-action-status', res.body.hookVariants.length + ' hook variants ready');
        else setBanner('bs-action-status', (res.body && res.body.error) || 'Could not generate hooks.', 'error');
      });
    });
    el('bs-generate-seo').addEventListener('click', function () {
      if (!state.postId) return;
      setBanner('bs-action-status', 'Generating SEO…');
      api('generate-seo', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId }) }).then(function (res) {
        if (!res.ok) { setBanner('bs-action-status', (res.body && res.body.error) || 'Could not generate SEO.', 'error'); return; }
        var slugPart = res.body.urlSlug ? ('/' + res.body.urlSlug + ' · ') : '';
        setBanner('bs-action-status', 'SEO ready — ' + slugPart + res.body.tags.length + ' tags');
      });
    });

    el('bs-save-theme').addEventListener('click', function () {
      var theme = { accent: el('bs-accent').value, fontFamily: el('bs-font').value };
      api('save-widget-config', { method: 'POST', body: JSON.stringify({
        action: 'update', theme: theme, badgeEnabled: el('bs-badge').checked,
      }) }).then(function (res) {
        if (res.ok) setBanner('bs-action-status', 'Theme saved.');
        else setBanner('bs-action-status', (res.body && res.body.error) || 'Could not save the theme.', 'error');
      });
    });

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
    };

    mediaEls.remove.addEventListener('click', function () {
      if (!state.postId) return;
      api('blog-media', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId, action: 'detach', role: 'feature' }) })
        .then(function (res) { if (res.ok) renderFeature(res.body.feature); });
    });
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
                  if (sel.ok && sel.body.assetId) routeImage({ assetId: sel.body.assetId });
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
            img.addEventListener('click', function () { routeImage({ pexelsCandidate: c }); });
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

  // Reset the modal to the empty "start a new post" brief (used on each fresh open).
  function resetToBrief() {
    if (state.editor && state.editor.destroy) { state.editor.destroy(); state.editor = null; }
    state.postId = null;
    ['bs-topic', 'bs-keywords', 'bs-notes', 'bs-tone'].forEach(function (id) { var e = el(id); if (e) e.value = ''; });
    var st = el('bs-save-tone'); if (st) st.checked = false;
    ['bs-save-status', 'bs-media-status', 'bs-synd-status'].forEach(function (id) { setStatus(id, ''); });
    ['bs-action-status', 'bs-brief-status'].forEach(function (id) { setBanner(id, ''); });
    el('bs-workspace').classList.add('bs-hidden');
    el('bs-brief').classList.remove('bs-hidden');
    el('bs-unschedule').classList.add('bs-hidden');
    el('bs-schedule-picker').classList.add('bs-hidden');
    el('bs-schedule-at').value = '';
  }

  // ── Public API ─────────────────────────────────────────────────────────────────────────────────
  function openBlogStudio(opts) {
    opts = opts || {};
    inject();
    state.assistantId = opts.assistantId != null ? opts.assistantId : null;
    el('bms-blog-backdrop').classList.add('bs-open');
    document.body.style.overflow = 'hidden';

    loadAssistants().then(function () {
      if (opts.postId) {
        loadExistingPost(Number(opts.postId));   // sets assistantId from the post itself
      } else {
        resetToBrief();
        syncVoiceControls();
      }
    });
  }

  function closeBlogStudio() {
    if (!state.injected) return;
    if (state.editor && state.editor.destroy) { state.editor.destroy(); state.editor = null; }
    el('bms-blog-backdrop').classList.remove('bs-open');
    document.body.style.overflow = '';
  }

  window.openBlogStudio = openBlogStudio;
  window.closeBlogStudio = closeBlogStudio;
  window.blogStudioAvailable = blogStudioAvailable;
  window.resolveBlogWriter = resolveBlogWriter;
})();
