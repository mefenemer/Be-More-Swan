/**
 * src/components/lead-notes-modal.js
 * "Notes" — whatever the user needs to remember about a lead, at any stage of its life.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `data.notes` was WRITE-ONLY. The Edit lead form has offered a Notes textarea since it shipped,
 * and nothing in the product has ever rendered what it saved — not the lead record, not the
 * Outreach card, not the conversation, not the chat context. A user could type a note about a
 * phone call, press Save, and never see it again.
 *
 * ── Why it is a shared component ─────────────────────────────────────────────
 * The same reasoning as lead-outcome-modal.js, which this deliberately mirrors: the surfaces that
 * need it are the ones a lead passes THROUGH, and a note is worth least on the one screen the user
 * happens to be on when they learn something.
 *
 *   • the Enrichment tab (assistant-data-hub.js) — every lead, in every state, including the ones
 *     with no address and no conversation.
 *   • the Outreach tab (assistants.js `_rqRecordActions`) — the card holding the email, where
 *     "they replied by phone instead" is learned.
 *
 * ── Append, never overwrite ──────────────────────────────────────────────────
 * The server (lead-generation.ts `add_note`) prepends each note with a dated header and keeps what
 * was already there. That is why this form shows a box for a NEW note above the existing ones read
 * only, rather than one editable blob: notes are contemporaneous, and a textarea prefilled with
 * yesterday's note is a textarea that will eventually be saved over it. Editing the whole thing is
 * still possible through Edit lead, which writes the same field.
 *
 * Usage:
 *   window.LeadNotesModal.open({
 *     assistantId, recordId, title,
 *     existing,           // the record's current data.notes string, or ''
 *     onSaved(notes),     // the full, updated notes string as the server stored it
 *   });
 *
 * All server values are escaped on render; treat them as untrusted.
 */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function open(opts) {
    const existing = typeof opts.existing === 'string' ? opts.existing.trim() : '';

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100">
          <div>
            <h3 class="text-lg font-bold text-gray-900">Notes</h3>
            <p class="text-xs text-gray-500 mt-0.5">${esc(opts.title || 'This lead')}</p>
          </div>
          <button type="button" data-nt-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer">&times;</button>
        </div>
        <form data-nt-form class="p-5 space-y-4">
          <label class="block">
            <span class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Add a note</span>
            <textarea name="note" rows="4" autofocus
              placeholder="Spoke to their ops manager — revisiting this in the new year."
              class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-400"></textarea>
            <span class="block text-xs text-gray-400 mt-1">Dated and kept. Nothing here is sent to the lead or shown to them.</span>
          </label>

          ${existing ? `
            <div>
              <span class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Earlier notes</span>
              <div class="rounded-lg border border-gray-200 bg-gray-50 p-3 max-h-48 overflow-y-auto">
                <p class="text-xs text-gray-700 whitespace-pre-line">${esc(existing)}</p>
              </div>
            </div>` : ''}

          <p class="hidden text-xs font-semibold" data-nt-status></p>
          <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" data-nt-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 rounded-lg cursor-pointer">Cancel</button>
            <button type="submit" data-nt-submit
              class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Save note</button>
          </div>
        </form>
      </div>`;

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-nt-close]').forEach((b) => b.addEventListener('click', close));

    const form = overlay.querySelector('[data-nt-form]');
    const status = overlay.querySelector('[data-nt-status]');
    const submit = overlay.querySelector('[data-nt-submit]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const note = (form.elements.note.value || '').trim();
      if (!note) {
        status.textContent = 'Type something first.';
        status.className = 'block text-xs font-semibold text-red-600';
        return;
      }
      submit.disabled = true;
      status.textContent = 'Saving…';
      status.className = 'block text-xs font-semibold text-gray-500';
      try {
        const res = await fetch('/.netlify/functions/lead-generation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            action: 'add_note',
            assistantId: opts.assistantId,
            recordId: opts.recordId,
            note,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not save that note.');
        close();
        // The server's stored string, not a locally-assembled one — it owns the dated header and
        // the ordering, and a second copy of that formatting here is a second thing to drift.
        opts.onSaved?.(typeof data.notes === 'string' ? data.notes : '');
        window.showToast?.('Note saved.');
      } catch (err) {
        submit.disabled = false;
        status.textContent = err.message || 'Could not save that note.';
        status.className = 'block text-xs font-semibold text-red-600';
      }
    });

    document.body.appendChild(overlay);
  }

  window.LeadNotesModal = { open };
})();
