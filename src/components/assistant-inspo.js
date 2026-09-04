/**
 * src/components/assistant-inspo.js
 *
 * Inspo tab — the styles, tones and ideas the content assistants
 * (social_media_manager, blog_writer) study and keep applying, so the user stops
 * re-explaining their taste on every draft. Items live in inspo_items
 * (netlify/functions/inspo-items.ts); on save the server chunks + embeds them
 * (Voyage → pgvector).
 *
 * The item's NOTE ("what I like about this") is the point — it's a far stronger
 * signal than the material itself, so the composer asks for it every time.
 *
 *   • quick capture: type a note, or dictate one with the mic (AC4)
 *   • each item shows an indexing badge, mirroring the Knowledge Base tab
 *   • Active/Paused toggle + delete — both stop the assistant considering the
 *     item on its very next draft (AC6)
 *
 * PHASE 2 SCOPE: typed + dictated notes only. Adding links (AC2) and files (AC3)
 * needs the extraction worker — see docs/inspo-tab-plan.md phase 3. Nothing here
 * advertises those affordances yet; dead UI would just lie about what works.
 *
 * Usage (assistants.js → _applyDashboardRegistry):
 *   window.AssistantInspo.init({ inspo, assistantId });
 *
 * Titles/notes/bodies are user-authored: treat as untrusted, escape everything
 * interpolated into HTML.
 */
(function () {
  'use strict';

  const API = '/.netlify/functions/inspo-items';
  // Matches MAX_BODY_CHARS / MAX_NOTE_CHARS in inspo-items.ts.
  const MAX_BODY_CHARS = 50000;
  const MAX_NOTE_CHARS = 2000;
  // Web Speech keeps listening indefinitely; stop it before it runs the mic flat.
  const DICTATION_LIMIT_MS = 60000;

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

  const KIND_LABELS = { text: 'Note', voice: 'Voice note', url: 'Link', file: 'File' };

  const state = {
    inspo: null, assistantId: null, roleKey: null, assistantName: null, assistantRole: null,
    items: [], embeddingsConfigured: false, editingId: null,
  };

  // ── "Draft one from this": hand an inspo item to the assistant in chat ───────────────────────
  // The tab collected taste and then did nothing with it on demand: inspo steered the NEXT
  // scheduled draft, whenever that was, and there was no way to say "this one — now". This button
  // is that. It seeds the assistant's chat with the item and asks for a draft, so the work happens
  // through the assistant's own drafting path (a social post is saved to the Review Queue for real;
  // a blog comes back as a Save/Discard card that opens in Blog Studio) rather than through a
  // second generator that would drift from it.
  //
  // The chat modal lives in workspace.html, so on any standalone page the button hides itself
  // rather than failing on click — the same rule blog-studio-modal.js applies to "Ask Swan".
  function swanAvailable() {
    return typeof window.openAssistantChatModal === 'function' && state.assistantId != null;
  }

  // What this assistant makes, in the user's words. Keyed on roleKey rather than assumed, because
  // the Inspo tab is registry-driven: a role that gains one later must not be told to write a
  // "post" when it writes something else. The fallback is the neutral noun, never a social one.
  const DRAFT_NOUNS = {
    blog_writer: { noun: 'blog post', button: 'Write a blog from this' },
    social_media_manager: { noun: 'social post', button: 'Write a post from this' },
  };
  function draftNoun(roleKey) {
    return DRAFT_NOUNS[roleKey !== undefined ? roleKey : state.roleKey]
      || { noun: 'post', button: 'Write a post from this' };
  }

  // Long inspo (a pasted article, a transcript) is trimmed for the chat turn only — the full item
  // stays indexed and keeps steering drafts as it always did. Sending 50k characters would spend
  // the turn's context on material the assistant already has through retrieval.
  const SEED_BODY_CHARS = 4000;

  function buildSeed(item, roleKey) {
    const { noun } = draftNoun(roleKey);
    const parts = [
      `Please write a ${noun} based on this idea from my Inspo. Use it as the starting point — `
      + `match what I liked about it, and give me something I can actually use.`,
      '',
      `Inspo: ${item.title || 'Untitled'}`,
    ];
    // The note is "what I like about this", and it is the strongest signal on the item — it is why
    // the composer asks for it every time. Only ever included when the user actually wrote one.
    if (item.userNote) parts.push('', `What I like about it: ${item.userNote}`);
    const body = String(item.body || '').trim();
    if (body) {
      parts.push('', body.length > SEED_BODY_CHARS
        ? body.slice(0, SEED_BODY_CHARS) + '\n\n(…trimmed — the full item is in my Inspo.)'
        : body);
    }
    return parts.join('\n');
  }

  async function draftFromItem(id) {
    // The list carries PREVIEWS only (bodyPreview / notePreview are truncated server-side), so the
    // full item is re-read here. Seeding from a preview would hand the assistant an idea cut off
    // mid-sentence and it would draft from the fragment without ever saying so.
    const res = await fetch(`${API}?id=${id}`, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load that item.');

    const session = window.openAssistantChatModal(
      state.assistantId,
      state.assistantName || 'Your assistant',
      state.assistantRole || 'Digital Assistant',
      state.roleKey,
    );
    const seed = buildSeed(data.item || {});
    // sendMessage is exposed by ChatSession.mount(); give the fresh mount a tick to settle.
    // Same handshake as blog-studio-modal.js's askSwanImprove and workspace.html's
    // askSwanAboutDraft — the modal returns its session synchronously for exactly this.
    setTimeout(() => { try { if (session) session.sendMessage(seed); } catch (_) { /* ignore */ } }, 60);
  }

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

  async function fetchItems() {
    const res = await fetch(`${API}?assistantId=${state.assistantId}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load your Inspo.');
    state.items = data.items || [];
    state.embeddingsConfigured = !!data.embeddingsConfigured;
  }

  // ── Dictation (AC4) ─────────────────────────────────────────────────────────
  // Same Web Speech approach as src/components/voice-feedback.js, but that one is a
  // class welded to its own #vf-* markup, so it can't be called from here without
  // refactoring it. Kept deliberately small; if a third caller ever appears, extract
  // a shared recogniser rather than copying this a third time.

  function speechSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /**
   * Streams dictation into `textarea`. Returns a stop() handle.
   * onEnd(errorMessage|null) fires once, whether stopped by the user, the timeout,
   * an error, or the recogniser giving up on its own.
   */
  function startDictation(textarea, onEnd) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-GB';
    recognition.maxAlternatives = 1;

    // Anything already typed stays put; dictation appends to it.
    const existing = textarea.value ? `${textarea.value.trimEnd()} ` : '';
    let finalTranscript = '';
    let finished = false;
    let timeoutId = null;

    const finish = (message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      try { recognition.stop(); } catch { /* already stopped */ }
      onEnd(message || null);
    };

    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalTranscript += `${e.results[i][0].transcript} `;
        else interim += e.results[i][0].transcript;
      }
      textarea.value = (existing + finalTranscript + interim).slice(0, MAX_BODY_CHARS);
    };
    recognition.onerror = (e) => {
      finish(e.error === 'not-allowed'
        ? 'Microphone access is blocked. Allow it in your browser settings, or just type instead.'
        : 'Dictation stopped unexpectedly — your words so far are saved below.');
    };
    recognition.onend = () => finish(null);

    timeoutId = setTimeout(() => finish(null), DICTATION_LIMIT_MS);
    recognition.start();

    return { stop: () => finish(null) };
  }

  // ── Composer (add + edit share it) ──────────────────────────────────────────

  function closeComposer() {
    state.editingId = null;
    const host = document.getElementById('inspo-composer-host');
    if (host) host.innerHTML = '';
  }

  function openComposer(item) {
    const host = document.getElementById('inspo-composer-host');
    if (!host) return;
    state.editingId = item ? item.id : null;
    const inputCls = 'w-full border border-gray-300 rounded-lg p-3 text-sm bg-white focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700 transition shadow-sm';

    host.innerHTML = `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 mb-6">
        <div class="mb-4">
          <h4 class="font-bold text-gray-900">${item ? 'Edit inspo' : 'Add inspo'}</h4>
          <p class="text-xs text-gray-500 mt-0.5">Anything that captures how you want to sound — a turn of phrase, an idea, a rule of thumb.</p>
        </div>
        <div class="space-y-4">
          <div>
            <div class="flex items-center justify-between gap-3 mb-1">
              <label class="block text-sm font-bold text-gray-700" for="inspo-composer-body">The inspo</label>
              ${speechSupported() ? `
              <button type="button" data-inspo-mic
                class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-14 0m7 7v4m0-4a7 7 0 007-7m-7 7a7 7 0 01-7-7m7-9a3 3 0 013 3v5a3 3 0 11-6 0V5a3 3 0 013-3z"/></svg>
                <span data-inspo-mic-label>Dictate</span>
              </button>` : ''}
            </div>
            <textarea id="inspo-composer-body" rows="5" maxlength="${MAX_BODY_CHARS}" class="${inputCls} resize-y"
              placeholder="e.g. Short punchy openers. No corporate waffle. Get to the point in the first line.">${esc(item ? item.body : '')}</textarea>
            ${speechSupported() ? '' : `
            <p class="text-xs text-gray-400 mt-1">Dictation isn't supported in this browser — typing works everywhere.</p>`}
          </div>
          <div>
            <label class="block text-sm font-bold text-gray-700 mb-1" for="inspo-composer-note">What do you like about it? <span class="font-normal text-gray-400">(optional)</span></label>
            <textarea id="inspo-composer-note" rows="2" maxlength="${MAX_NOTE_CHARS}" class="${inputCls} resize-y"
              placeholder="e.g. Use this sarcastic tone, but keep it warm — never mean.">${esc(item ? item.userNote : '')}</textarea>
          </div>
        </div>
        <p class="hidden mt-3 text-xs font-semibold" data-inspo-composer-status></p>
        <div class="flex items-center gap-2 mt-4">
          <button type="button" data-inspo-save
            class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">
            ${item ? 'Save changes' : 'Add to Inspo'}
          </button>
          <button type="button" data-inspo-cancel
            class="px-4 py-2 bg-white border border-gray-200 text-gray-700 hover:border-gray-300 text-sm font-bold rounded-lg transition">
            Cancel
          </button>
        </div>
      </div>`;

    const bodyEl = host.querySelector('#inspo-composer-body');
    const noteEl = host.querySelector('#inspo-composer-note');
    const status = host.querySelector('[data-inspo-composer-status]');
    const saveBtn = host.querySelector('[data-inspo-save]');
    const micBtn = host.querySelector('[data-inspo-mic]');

    const showStatus = (msg, ok) => {
      status.textContent = msg;
      status.className = `block mt-3 text-xs font-semibold ${ok ? 'text-emerald-700' : 'text-red-600'}`;
    };

    // Dictated items are tagged kind:'voice' so the card can say where it came from.
    let dictated = item ? item.kind === 'voice' : false;
    let session = null;

    const resetMic = () => {
      session = null;
      if (!micBtn) return;
      micBtn.querySelector('[data-inspo-mic-label]').textContent = 'Dictate';
      micBtn.classList.remove('border-red-300', 'text-red-600');
    };

    micBtn?.addEventListener('click', () => {
      if (session) { session.stop(); return; }
      micBtn.querySelector('[data-inspo-mic-label]').textContent = 'Stop';
      micBtn.classList.add('border-red-300', 'text-red-600');
      showStatus('Listening… speak your idea, then hit Stop.', true);
      dictated = true;
      session = startDictation(bodyEl, (err) => {
        resetMic();
        if (err) showStatus(err, false);
        else showStatus('Got it — review the text, then save.', true);
      });
    });

    host.querySelector('[data-inspo-cancel]').addEventListener('click', () => {
      session?.stop();
      closeComposer();
    });

    saveBtn.addEventListener('click', async () => {
      session?.stop();
      const body = bodyEl.value.trim();
      const userNote = noteEl.value.trim();
      if (!body) { showStatus('Add some text before saving.', false); return; }
      saveBtn.disabled = true;
      showStatus('Saving and indexing…', true);
      try {
        if (state.editingId) {
          await api('PUT', { id: state.editingId, body, userNote });
        } else {
          await api('POST', { assistantId: state.assistantId, kind: dictated ? 'voice' : 'text', body, userNote });
        }
        closeComposer();
        await fetchItems();
        renderList();
      } catch (err) {
        saveBtn.disabled = false;
        showStatus(err.message, false);
      }
    });
  }

  async function editItem(id) {
    const res = await fetch(`${API}?id=${id}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load that item.');
    openComposer(data.item);
    document.getElementById('inspo-composer-host')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Item list ───────────────────────────────────────────────────────────────

  function renderList() {
    const host = document.getElementById('inspo-list-host');
    if (!host) return;

    if (state.items.length === 0) {
      host.innerHTML = `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 text-center">
          <p class="text-4xl mb-3">✨</p>
          <p class="font-bold text-gray-900 mb-1">No inspo yet</p>
          <p class="text-sm text-gray-500 max-w-md mx-auto">Add the first thing that captures how you want to sound and your assistant will start working it into every draft — no more repeating yourself in the brief.</p>
        </div>`;
      return;
    }

    // Paused items deliberately have NO draft button. Pausing means "stop considering this on my
    // drafts", and a button on a card badged Paused would offer the exact thing the badge says is
    // switched off. Reactivate is right there next to it.
    const canDraft = swanAvailable();
    const draftLabel = draftNoun().button;

    host.innerHTML = `
      <div class="space-y-3">
        ${state.items.map((i) => {
          const badge = STATUS_BADGES[i.embeddingStatus] || STATUS_BADGES.pending;
          const kind = KIND_LABELS[i.kind] || 'Note';
          return `
          <div class="bg-white rounded-2xl border shadow-sm p-5 ${i.isActive ? 'border-gray-200' : 'border-gray-200 bg-gray-50/60'}" data-inspo-item="${i.id}">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="font-bold text-gray-900 truncate ${i.isActive ? '' : 'text-gray-500'}">${esc(i.title)}</p>
                ${i.notePreview ? `<p class="text-sm text-emerald-800 mt-1 italic">“${esc(i.notePreview)}”</p>` : ''}
                <p class="text-sm text-gray-500 mt-1">${esc(i.bodyPreview)}</p>
                <p class="text-xs text-gray-400 mt-2">
                  ${esc(kind)}
                  · ${esc(String(i.chunkCount))} section${i.chunkCount === 1 ? '' : 's'} indexed
                  · added ${esc(fmtDate(i.createdAt))}
                </p>
              </div>
              <div class="flex flex-col items-end gap-1.5 shrink-0">
                <span class="text-xs font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${badge.cls}">${badge.label}</span>
                ${i.isActive ? '' : '<span class="text-xs font-bold px-2 py-0.5 rounded-full border whitespace-nowrap bg-gray-100 text-gray-600 border-gray-300">Paused</span>'}
              </div>
            </div>
            <p class="hidden mt-3 text-xs font-semibold" data-inspo-row-status></p>
            <div class="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100 flex-wrap">
              ${canDraft && i.isActive ? `
              <button type="button" data-inspo-draft="${i.id}"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                ${esc(draftLabel)}
              </button>` : ''}
              <button type="button" data-inspo-edit="${i.id}"
                class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition">
                Edit
              </button>
              <button type="button" data-inspo-toggle="${i.id}" data-active="${i.isActive ? '1' : '0'}"
                class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition">
                ${i.isActive ? 'Pause' : 'Reactivate'}
              </button>
              <button type="button" data-inspo-delete="${i.id}"
                class="px-3 py-1.5 bg-white border border-gray-200 text-red-600 hover:border-red-300 hover:bg-red-50 text-xs font-bold rounded-lg transition ml-auto">
                Delete
              </button>
            </div>
          </div>`;
        }).join('')}
      </div>`;

    host.querySelectorAll('[data-inspo-draft]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await draftFromItem(Number(btn.getAttribute('data-inspo-draft'))); }
        catch (err) { rowStatus(btn, err.message); }
        finally { btn.disabled = false; }
      });
    });

    host.querySelectorAll('[data-inspo-edit]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await editItem(Number(btn.getAttribute('data-inspo-edit'))); }
        catch (err) { rowStatus(btn, err.message); }
        finally { btn.disabled = false; }
      });
    });

    // AC6: pausing is the reversible half of "stop considering this item". The server
    // drops the cached style profile on the toggle, so the very next draft is clean.
    host.querySelectorAll('[data-inspo-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.getAttribute('data-inspo-toggle'));
        const nextActive = btn.getAttribute('data-active') !== '1';
        btn.disabled = true;
        try {
          await api('PUT', { id, isActive: nextActive });
          const row = state.items.find((i) => i.id === id);
          if (row) row.isActive = nextActive;
          renderList();
        } catch (err) {
          btn.disabled = false;
          rowStatus(btn, err.message);
        }
      });
    });

    host.querySelectorAll('[data-inspo-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.getAttribute('data-inspo-delete'));
        if (btn.getAttribute('data-confirm') !== '1') {
          btn.setAttribute('data-confirm', '1');
          btn.textContent = 'Really delete?';
          setTimeout(() => { btn.removeAttribute('data-confirm'); btn.textContent = 'Delete'; }, 4000);
          return;
        }
        btn.disabled = true;
        try {
          await api('DELETE', { id });
          state.items = state.items.filter((i) => i.id !== id);
          if (state.editingId === id) closeComposer();
          renderList();
        } catch (err) {
          btn.disabled = false;
          rowStatus(btn, err.message);
        }
      });
    });
  }

  function rowStatus(btn, message) {
    const status = btn.closest('[data-inspo-item]')?.querySelector('[data-inspo-row-status]');
    if (!status) return;
    status.textContent = message || 'Something went wrong.';
    status.className = 'block mt-3 text-xs font-semibold text-red-600';
  }

  function renderToolbar() {
    const host = document.getElementById('inspo-toolbar');
    if (!host) return;
    host.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
        <div class="min-w-0">
          <h3 class="text-lg font-bold text-gray-900">${esc(state.inspo.label)}</h3>
          <p class="text-sm text-gray-500 mt-1 max-w-2xl">${esc(state.inspo.description)}</p>
        </div>
        <button type="button" data-inspo-add
          class="inline-flex items-center gap-2 px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition whitespace-nowrap shrink-0">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          Add inspo
        </button>
      </div>
      ${state.embeddingsConfigured ? '' : `
      <p class="-mt-3 mb-5 text-xs text-gray-400">Semantic matching isn't configured on this workspace yet, so your inspo is matched by keyword — your assistant still studies all of it.</p>`}
    `;
    host.querySelector('[data-inspo-add]').addEventListener('click', () => {
      openComposer(null);
      document.getElementById('inspo-composer-host')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function init({ inspo, assistantId, roleKey, assistantName, assistantRole }) {
    if (!inspo || !assistantId) return;
    state.inspo = inspo;
    state.assistantId = assistantId;
    // Used only by the seeded chat (see swanAvailable / draftFromItem). All three are optional:
    // an older caller that passes neither still gets a working tab, with the neutral wording.
    state.roleKey = roleKey || null;
    state.assistantName = assistantName || null;
    state.assistantRole = assistantRole || null;
    state.items = [];
    state.editingId = null;
    closeComposer();
    const host = document.getElementById('inspo-list-host');
    if (host) host.innerHTML = '<p class="text-sm text-gray-400">Loading…</p>';
    try {
      await fetchItems();
      renderToolbar();
      renderList();
    } catch (err) {
      renderToolbar();
      if (host) host.innerHTML = `<div class="bg-red-50 border border-red-200 rounded-2xl p-6 text-sm font-semibold text-red-700">${esc(err.message)}</div>`;
    }
  }

  // `_test` exposes the two pure functions behind the "Write a … from this" button.
  // tests/inspo-draft-from-item.test.ts calls them directly: the wording is role-dependent, and a
  // Blog Writer being asked for a "social post" is a bug no source scan would catch.
  window.AssistantInspo = { init, _test: { buildSeed, draftNoun } };
})();
