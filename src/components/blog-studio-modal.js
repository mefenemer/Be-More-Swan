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
    + '.bs-media-empty{grid-column:1 / -1;font-size:12px;color:#6b7280;text-align:center;padding:12px;}';

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
    + '    <div class="bs-field"><label>Rough notes / transcript (optional)</label><textarea id="bs-notes" rows="3"></textarea></div>'
    + '    <div class="bs-row">'
    + '      <button class="bs-btn bs-btn-ghost" data-path="blank">Start blank</button>'
    + '      <button class="bs-btn bs-btn-ghost" data-path="improve">Improve draft</button>'
    + '      <button class="bs-btn bs-btn-primary" data-path="generate">AI generate</button>'
    + '    </div>'
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
    + '          <button id="bs-feature-pexels" class="bs-btn bs-btn-ghost">Stock photo</button>'
    + '          <button id="bs-feature-ai" class="bs-btn bs-btn-ghost">AI generate</button>'
    + '          <button id="bs-feature-remove" class="bs-btn bs-btn-ghost bs-hidden">Remove</button>'
    + '        </div>'
    + '        <div style="margin-top:14px;font-size:12px;color:#6b7280;">Inline body image</div>'
    + '        <div class="bs-row" style="margin-top:6px;">'
    + '          <button id="bs-inline-library" class="bs-btn bs-btn-ghost">Library</button>'
    + '          <button id="bs-inline-pexels" class="bs-btn bs-btn-ghost">Stock</button>'
    + '          <button id="bs-inline-ai" class="bs-btn bs-btn-ghost">AI</button>'
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
    + '    </div>'
    + '    <div>'
    + '      <input id="bs-title" class="bs-title-input" placeholder="Post title">'
    + '      <div id="bs-editor" class="bs-editor"></div>'
    + '      <div class="bs-row" style="margin-top:16px;">'
    + '        <button id="bs-generate-hooks" class="bs-btn bs-btn-ghost">Generate A/B hooks</button>'
    + '        <button id="bs-generate-seo" class="bs-btn bs-btn-ghost">Generate SEO</button>'
    + '        <button id="bs-publish" class="bs-btn bs-btn-primary">Publish</button>'
    + '        <span id="bs-publish-status" class="bs-status"></span>'
    + '      </div>'
    + '      <div class="bs-row" style="margin-top:8px;">'
    + '        <input id="bs-schedule-at" type="datetime-local" style="width:auto;">'
    + '        <button id="bs-schedule" class="bs-btn bs-btn-ghost">Schedule</button>'
    + '        <button id="bs-unschedule" class="bs-btn bs-btn-ghost bs-hidden">Unschedule</button>'
    + '        <span id="bs-schedule-status" class="bs-status"></span>'
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
      onChange: function () { setStatus('bs-save-status', 'Saving…'); setTimeout(function () { setStatus('bs-save-status', 'Saved'); }, 1400); },
    });
    loadWidget();
    loadFeature();
    return state.editor;
  }

  function startPost(path) {
    var title = el('bs-topic').value.trim() || 'Untitled draft';
    var voice = resolveVoice();
    if (voice.saveToProfile) {
      api('blog-tone', { method: 'POST', body: JSON.stringify({ assistantId: voice.assistantId, tone: voice.tone }) });
    }
    api('blog-posts', { method: 'POST', body: JSON.stringify({ title: title, assistantId: voice.assistantId }) }).then(function (res) {
      if (!res.ok) { alert('Could not create post: ' + (res.body.error || '')); return; }
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
      if (post.status) setStatus('bs-publish-status', 'Status: ' + post.status);
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

  // ── Wire all events once, after markup injection ───────────────────────────────────────────────
  function wireEvents() {
    Array.prototype.forEach.call(document.querySelectorAll('#bs-brief [data-path]'), function (btn) {
      btn.addEventListener('click', function () { startPost(btn.getAttribute('data-path')); });
    });

    el('bs-close').addEventListener('click', closeBlogStudio);
    el('bms-blog-backdrop').addEventListener('mousedown', function (e) {
      if (e.target === el('bms-blog-backdrop')) closeBlogStudio();  // click the dimmed area to dismiss
    });

    el('bs-title').addEventListener('blur', function () {
      if (!state.postId) return;
      api('save-blog-draft', { method: 'POST', body: JSON.stringify({ id: state.postId, title: this.value }) });
    });

    el('bs-publish').addEventListener('click', function () {
      if (!state.postId) return;
      setStatus('bs-publish-status', 'Publishing…');
      api('publish-blog', { method: 'POST', body: JSON.stringify({ id: state.postId }) }).then(function (res) {
        setStatus('bs-publish-status', res.ok ? 'Published ✓ (' + res.body.post.slug + ')' : (res.body.error || 'Failed'));
      });
    });

    el('bs-schedule').addEventListener('click', function () {
      if (!state.postId) return;
      var iso = localToISO(el('bs-schedule-at').value);
      if (!iso) { setStatus('bs-schedule-status', 'Pick a date & time.'); return; }
      setStatus('bs-schedule-status', 'Scheduling…');
      api('schedule-blog', { method: 'POST', body: JSON.stringify({ id: state.postId, publishDate: iso }) }).then(function (res) {
        if (res.ok) {
          setStatus('bs-schedule-status', 'Scheduled for ' + new Date(res.body.post.publishDate).toLocaleString());
          el('bs-unschedule').classList.remove('bs-hidden');
        } else setStatus('bs-schedule-status', (res.body && res.body.error) || 'Failed');
      });
    });
    el('bs-unschedule').addEventListener('click', function () {
      if (!state.postId) return;
      api('schedule-blog', { method: 'POST', body: JSON.stringify({ id: state.postId, action: 'unschedule' }) }).then(function (res) {
        if (res.ok) {
          setStatus('bs-schedule-status', 'Schedule cleared — back to draft.');
          el('bs-unschedule').classList.add('bs-hidden');
        } else setStatus('bs-schedule-status', (res.body && res.body.error) || 'Failed');
      });
    });

    el('bs-generate-hooks').addEventListener('click', function () {
      if (!state.postId) return;
      setStatus('bs-publish-status', 'Generating hooks…');
      api('generate-hooks', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId }) }).then(function (res) {
        setStatus('bs-publish-status', res.ok ? (res.body.hookVariants.length + ' hook variants ready') : (res.body.error || 'Failed'));
      });
    });
    el('bs-generate-seo').addEventListener('click', function () {
      if (!state.postId) return;
      setStatus('bs-publish-status', 'Generating SEO…');
      api('generate-seo', { method: 'POST', body: JSON.stringify({ blogPostId: state.postId }) }).then(function (res) {
        if (!res.ok) { setStatus('bs-publish-status', res.body.error || 'Failed'); return; }
        var slugPart = res.body.urlSlug ? ('/' + res.body.urlSlug + ' · ') : '';
        setStatus('bs-publish-status', 'SEO ready — ' + slugPart + res.body.tags.length + ' tags');
      });
    });

    el('bs-save-theme').addEventListener('click', function () {
      var theme = { accent: el('bs-accent').value, fontFamily: el('bs-font').value };
      api('save-widget-config', { method: 'POST', body: JSON.stringify({
        action: 'update', theme: theme, badgeEnabled: el('bs-badge').checked,
      }) }).then(function (res) { alert(res.ok ? 'Theme saved.' : (res.body.error || 'Failed')); });
    });

    mediaEls = {
      preview: el('bs-feature-preview'), library: el('bs-feature-library'), pexels: el('bs-feature-pexels'),
      ai: el('bs-feature-ai'), remove: el('bs-feature-remove'),
      aiForm: el('bs-ai-form'), aiPrompt: el('bs-ai-prompt'), aiGo: el('bs-ai-go'),
      pexelsForm: el('bs-pexels-form'), pexelsQuery: el('bs-pexels-query'), pexelsGo: el('bs-pexels-go'),
      picker: el('bs-media-picker'),
      inlineLibrary: el('bs-inline-library'), inlinePexels: el('bs-inline-pexels'), inlineAi: el('bs-inline-ai'),
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
    ['bs-save-status', 'bs-publish-status', 'bs-schedule-status', 'bs-media-status'].forEach(function (id) { setStatus(id, ''); });
    el('bs-workspace').classList.add('bs-hidden');
    el('bs-brief').classList.remove('bs-hidden');
    el('bs-unschedule').classList.add('bs-hidden');
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
