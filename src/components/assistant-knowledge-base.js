/**
 * src/components/assistant-knowledge-base.js
 *
 * Knowledge Base tab (KB phase) — manage the support articles that ground the
 * Tier 1 Support Agent's "Resolved" answers. Articles live in kb_articles
 * (netlify/functions/kb-articles.ts); on save the server chunks + embeds them
 * (Voyage → pgvector) so chat-orchestrator.ts can retrieve them per turn.
 * Answers with no supporting article are escalated instead of guessed at.
 *
 *   • add/edit via an inline editor (title + content); .txt/.md files are read
 *     client-side into the editor, so uploads need no server file machinery
 *   • each article shows an indexing badge: Indexed (embedded), Keyword search
 *     (no embedding provider configured), Indexing failed, or Pending
 *   • delete removes the article, its chunks and its GDPR vector-map rows
 *
 * Usage (assistants.js → _applyDashboardRegistry):
 *   window.AssistantKnowledgeBase.init({ kb, assistantId });
 *
 * Article titles/previews are user-authored: treat as untrusted, escape
 * everything interpolated into HTML.
 */
(function () {
  'use strict';

  const API = '/.netlify/functions/kb-articles';
  // Matches MAX_CONTENT_CHARS in kb-articles.ts.
  const MAX_CONTENT_CHARS = 50000;
  // Client-side ceiling for .txt/.md uploads — reading more than this into the
  // editor would only be rejected by the server anyway.
  const MAX_FILE_BYTES = 200 * 1024;

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtDate(value) {
    const d = value ? new Date(value) : null;
    return d && !isNaN(d) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  }

  const STATUS_BADGES = {
    embedded: { label: 'Indexed', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
    keyword_only: { label: 'Keyword search', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
    failed: { label: 'Indexing failed', cls: 'bg-red-50 text-red-700 border-red-200' },
    pending: { label: 'Pending', cls: 'bg-gray-50 text-gray-600 border-gray-200' },
  };

  const state = { kb: null, assistantId: null, articles: [], embeddingsConfigured: false, editingId: null };

  async function api(method, body) {
    const res = await fetch(API, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  async function fetchArticles() {
    const res = await fetch(`${API}?assistantId=${state.assistantId}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load the knowledge base.');
    state.articles = data.articles || [];
    state.embeddingsConfigured = !!data.embeddingsConfigured;
  }

  // ── Inline editor (add + edit share it) ─────────────────────────────────────

  function closeEditor() {
    state.editingId = null;
    const host = document.getElementById('kb-editor-host');
    if (host) host.innerHTML = '';
  }

  function openEditor(article) {
    const host = document.getElementById('kb-editor-host');
    if (!host) return;
    state.editingId = article ? article.id : null;
    const inputCls = 'w-full border border-gray-300 rounded-lg p-3 text-sm bg-white focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700 transition shadow-sm';

    host.innerHTML = `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 mb-6">
        <div class="flex items-start justify-between gap-3 mb-4">
          <div>
            <h4 class="font-bold text-gray-900">${article ? 'Edit article' : 'New article'}</h4>
            <p class="text-xs text-gray-500 mt-0.5">Write it the way you'd explain it to a customer — your assistant answers with exactly what's in here.</p>
          </div>
          <button type="button" data-kb-upload-trigger
            class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition whitespace-nowrap">
            Load from .txt / .md file
          </button>
          <input type="file" accept=".txt,.md,text/plain,text/markdown" class="hidden" data-kb-file>
        </div>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-bold text-gray-700 mb-1" for="kb-editor-title">Title</label>
            <input type="text" id="kb-editor-title" maxlength="300" class="${inputCls}"
              placeholder="e.g. Returns &amp; refunds policy" value="${esc(article ? article.title : '')}">
          </div>
          <div>
            <label class="block text-sm font-bold text-gray-700 mb-1" for="kb-editor-content">Article content</label>
            <textarea id="kb-editor-content" rows="10" maxlength="${MAX_CONTENT_CHARS}" class="${inputCls} resize-y"
              placeholder="The full answer material: policies, steps, pricing, product details…">${esc(article ? article.content : '')}</textarea>
          </div>
        </div>
        <p class="hidden mt-3 text-xs font-semibold" data-kb-editor-status></p>
        <div class="flex items-center gap-2 mt-4">
          <button type="button" data-kb-save
            class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">
            ${article ? 'Save changes' : 'Add to Knowledge Base'}
          </button>
          <button type="button" data-kb-cancel
            class="px-4 py-2 bg-white border border-gray-200 text-gray-700 hover:border-gray-300 text-sm font-bold rounded-lg transition">
            Cancel
          </button>
        </div>
      </div>`;

    const titleEl = host.querySelector('#kb-editor-title');
    const contentEl = host.querySelector('#kb-editor-content');
    const status = host.querySelector('[data-kb-editor-status]');
    const saveBtn = host.querySelector('[data-kb-save]');
    const fileInput = host.querySelector('[data-kb-file]');

    const showStatus = (msg, ok) => {
      status.textContent = msg;
      status.className = `block mt-3 text-xs font-semibold ${ok ? 'text-emerald-700' : 'text-red-600'}`;
    };

    // Records whether the content came from a .txt/.md file (kb_articles.source).
    let loadedFromFile = false;

    host.querySelector('[data-kb-upload-trigger]').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) { showStatus('That file is too large — paste the relevant sections instead.', false); return; }
      const text = await file.text();
      contentEl.value = text.slice(0, MAX_CONTENT_CHARS);
      if (!titleEl.value.trim()) titleEl.value = file.name.replace(/\.(txt|md)$/i, '').replace(/[_-]+/g, ' ').trim();
      loadedFromFile = true;
      showStatus(`Loaded "${file.name}" — review, then save.`, true);
    });

    host.querySelector('[data-kb-cancel]').addEventListener('click', closeEditor);
    saveBtn.addEventListener('click', async () => {
      const title = titleEl.value.trim();
      const content = contentEl.value.trim();
      if (!title) { showStatus('Give the article a title.', false); return; }
      if (!content) { showStatus('The article needs some content.', false); return; }
      saveBtn.disabled = true;
      showStatus('Saving and indexing…', true);
      try {
        if (state.editingId) {
          await api('PUT', { id: state.editingId, title, content });
        } else {
          await api('POST', { assistantId: state.assistantId, title, content, source: loadedFromFile ? 'file_upload' : 'manual' });
        }
        closeEditor();
        await fetchArticles();
        renderList();
      } catch (err) {
        saveBtn.disabled = false;
        showStatus(err.message, false);
      }
    });
  }

  async function editArticle(id) {
    const res = await fetch(`${API}?id=${id}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load the article.');
    openEditor(data.article);
    document.getElementById('kb-editor-host')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Article list ────────────────────────────────────────────────────────────

  function renderList() {
    const host = document.getElementById('kb-list-host');
    if (!host) return;

    if (state.articles.length === 0) {
      host.innerHTML = `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 text-center">
          <p class="text-4xl mb-3">📚</p>
          <p class="font-bold text-gray-900 mb-1">No Knowledge Base articles yet</p>
          <p class="text-sm text-gray-500 max-w-md mx-auto">Until you add some, your assistant escalates business-specific questions to you rather than guessing. Start with your returns policy, pricing, and most-asked questions.</p>
        </div>`;
      return;
    }

    host.innerHTML = `
      <div class="space-y-3">
        ${state.articles.map((a) => {
          const badge = STATUS_BADGES[a.embeddingStatus] || STATUS_BADGES.pending;
          return `
          <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5" data-kb-article="${a.id}">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="font-bold text-gray-900 truncate">${esc(a.title)}</p>
                <p class="text-sm text-gray-500 mt-1">${esc(a.preview)}</p>
                <p class="text-xs text-gray-400 mt-2">
                  ${esc(String(a.chunkCount))} section${a.chunkCount === 1 ? '' : 's'} indexed
                  · ${a.source === 'file_upload' ? 'from file' : 'written here'}
                  · updated ${esc(fmtDate(a.updatedAt))}
                </p>
              </div>
              <span class="text-xs font-bold px-2 py-0.5 rounded-full border shrink-0 whitespace-nowrap ${badge.cls}">${badge.label}</span>
            </div>
            <p class="hidden mt-3 text-xs font-semibold" data-kb-row-status></p>
            <div class="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
              <button type="button" data-kb-edit="${a.id}"
                class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition">
                Edit
              </button>
              <button type="button" data-kb-delete="${a.id}"
                class="px-3 py-1.5 bg-white border border-gray-200 text-red-600 hover:border-red-300 hover:bg-red-50 text-xs font-bold rounded-lg transition ml-auto">
                Delete
              </button>
            </div>
          </div>`;
        }).join('')}
      </div>`;

    host.querySelectorAll('[data-kb-edit]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await editArticle(Number(btn.getAttribute('data-kb-edit'))); }
        catch (err) { rowStatus(btn, err.message); }
        finally { btn.disabled = false; }
      });
    });

    host.querySelectorAll('[data-kb-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.getAttribute('data-kb-delete'));
        if (btn.getAttribute('data-confirm') !== '1') {
          btn.setAttribute('data-confirm', '1');
          btn.textContent = 'Really delete?';
          setTimeout(() => { btn.removeAttribute('data-confirm'); btn.textContent = 'Delete'; }, 4000);
          return;
        }
        btn.disabled = true;
        try {
          await api('DELETE', { id });
          state.articles = state.articles.filter((a) => a.id !== id);
          if (state.editingId === id) closeEditor();
          renderList();
        } catch (err) {
          btn.disabled = false;
          rowStatus(btn, err.message);
        }
      });
    });
  }

  function rowStatus(btn, message) {
    const status = btn.closest('[data-kb-article]')?.querySelector('[data-kb-row-status]');
    if (!status) return;
    status.textContent = message || 'Something went wrong.';
    status.className = 'block mt-3 text-xs font-semibold text-red-600';
  }

  function renderToolbar() {
    const host = document.getElementById('kb-toolbar');
    if (!host) return;
    host.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
        <div class="min-w-0">
          <h3 class="text-lg font-bold text-gray-900">${esc(state.kb.label)}</h3>
          <p class="text-sm text-gray-500 mt-1 max-w-2xl">${esc(state.kb.description)}</p>
        </div>
        <button type="button" data-kb-add
          class="inline-flex items-center gap-2 px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition whitespace-nowrap shrink-0">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          Add article
        </button>
      </div>
      ${state.embeddingsConfigured ? '' : `
      <p class="-mt-3 mb-5 text-xs text-gray-400">Semantic search isn't configured on this workspace yet, so articles are matched by keyword — answers still come only from your Knowledge Base.</p>`}
    `;
    host.querySelector('[data-kb-add]').addEventListener('click', () => {
      openEditor(null);
      document.getElementById('kb-editor-host')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function init({ kb, assistantId }) {
    if (!kb || !assistantId) return;
    state.kb = kb;
    state.assistantId = assistantId;
    state.articles = [];
    state.editingId = null;
    closeEditor();
    const host = document.getElementById('kb-list-host');
    if (host) host.innerHTML = '<p class="text-sm text-gray-400">Loading…</p>';
    try {
      await fetchArticles();
      renderToolbar();
      renderList();
    } catch (err) {
      renderToolbar();
      if (host) host.innerHTML = `<div class="bg-red-50 border border-red-200 rounded-2xl p-6 text-sm font-semibold text-red-700">${esc(err.message)}</div>`;
    }
  }

  window.AssistantKnowledgeBase = { init };
})();
