/**
 * src/components/meeting-minutes-form.js
 * "New meeting" — the Meeting Note Taker's write-up without the chat (docs/meeting-note-taker-finish-plan.md
 * step 5). Paste notes and/or attach one transcript file; netlify/functions/meeting-minutes.ts writes the
 * minutes with the SAME prompt and parsing as the chat (src/utils/meeting-minutes.ts) and files the meeting
 * in the Inbox, waiting for approval. Nothing is sent from here.
 *
 * Opened by the Inbox tab's "New meeting" button and the Overview's primary button (assistants.js).
 *
 * Usage:
 *   window.MeetingMinutesForm.open({ assistantId, assistantName, onSaved({ recordId, title }) });
 */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  // The same files and limit as a transcript attached in chat (chat-session.js ATTACH_ROLES.meeting_note_taker).
  const FILE_TYPES = /\.(txt|docx|pdf|vtt|srt|md)$/i;
  const FILE_ACCEPT = '.txt,.docx,.pdf,.vtt,.srt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/vtt';
  const FILE_MAX_BYTES = 4 * 1024 * 1024;
  const TEXT_MAX_CHARS = 120000;

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.onerror = () => reject(new Error(`"${file.name}" couldn't be read.`));
      r.readAsDataURL(file);
    });
  }

  function open(opts) {
    const name = opts.assistantName || 'Your assistant';
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.setAttribute('data-meeting-form', '');
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="mm-title">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100">
          <div>
            <h3 id="mm-title" class="text-lg font-bold text-gray-900">New meeting</h3>
            <p class="text-sm text-gray-500 mt-0.5">${esc(name)} writes the minutes, the action items and a follow-up email. They wait in your Inbox — nothing is sent until you approve.</p>
          </div>
          <button type="button" data-mm-close aria-label="Close" class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer">&times;</button>
        </div>
        <form data-mm-form class="p-5 space-y-4">
          <label class="block">
            <span class="block text-sm font-bold text-gray-700 mb-1">Paste your notes or transcript</span>
            <textarea name="text" rows="9" maxlength="${TEXT_MAX_CHARS}"
              placeholder="Sarah: Morning all. We're going with vendor A…"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700"></textarea>
          </label>
          <div>
            <span class="block text-sm font-bold text-gray-700 mb-1">Or attach the transcript</span>
            <label class="btn-secondary border inline-flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-sm font-bold">
              <span aria-hidden="true">📎</span> Choose a file
              <input type="file" hidden data-mm-file accept="${FILE_ACCEPT}">
            </label>
            <span class="ml-2 text-sm text-gray-700" data-mm-file-name></span>
            <button type="button" data-mm-file-clear class="hidden ml-1 text-sm text-gray-500 hover:text-gray-900 underline cursor-pointer">Remove</button>
            <p class="text-xs text-gray-500 mt-1">.txt, .docx, .pdf, or a .vtt/.srt file from Zoom, Teams or Google Meet. Up to about 2 hours of talk.</p>
          </div>
          <p class="hidden text-sm font-semibold" data-mm-status role="status"></p>
          <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" data-mm-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 rounded-lg cursor-pointer">Cancel</button>
            <button type="submit" data-mm-submit
              class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Write up the meeting</button>
          </div>
        </form>
      </div>`;

    let file = null;
    let busy = false;
    const close = () => { if (!busy) { overlay.remove(); document.removeEventListener('keydown', onKey); } };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-mm-close]').forEach((b) => b.addEventListener('click', close));
    document.addEventListener('keydown', onKey);

    const form = overlay.querySelector('[data-mm-form]');
    const status = overlay.querySelector('[data-mm-status]');
    const submit = overlay.querySelector('[data-mm-submit]');
    const fileInput = overlay.querySelector('[data-mm-file]');
    const fileName = overlay.querySelector('[data-mm-file-name]');
    const fileClear = overlay.querySelector('[data-mm-file-clear]');
    const say = (msg, tone) => {
      status.textContent = msg;
      status.className = `block text-sm font-semibold ${tone === 'error' ? 'text-red-600' : 'text-gray-600'}`;
    };
    const showFile = () => {
      fileName.textContent = file ? file.name : '';
      fileClear.classList.toggle('hidden', !file);
    };

    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      if (!FILE_TYPES.test(f.name) && f.type !== 'application/pdf') { say(`"${f.name}" can't be read as a transcript — use .txt, .docx, .pdf, .vtt or .srt.`, 'error'); return; }
      if (f.size > FILE_MAX_BYTES) { say(`"${f.name}" is too large (the limit is 4 MB).`, 'error'); return; }
      file = f;
      status.className = 'hidden';
      showFile();
    });
    fileClear.addEventListener('click', () => { file = null; showFile(); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const text = (form.elements.text.value || '').trim();
      if (!text && !file) { say('Paste the meeting notes or attach the transcript first.', 'error'); return; }
      busy = true;
      submit.disabled = true;
      submit.textContent = 'Writing up…';
      say('Writing up the meeting. A long transcript can take up to 20 seconds.');
      try {
        const body = { assistantId: opts.assistantId, text };
        if (file) body.attachment = { name: file.name, type: file.type, data: await readAsBase64(file) };
        const res = await fetch('/.netlify/functions/meeting-minutes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'The write-up didn’t finish. Nothing was saved — try again.');
        busy = false;
        close();
        window.showToast?.('Added to your Inbox — review and approve it there.', { icon: '📝' });
        opts.onSaved?.({ recordId: data.recordId, title: data.title });
      } catch (err) {
        busy = false;
        submit.disabled = false;
        submit.textContent = 'Write up the meeting';
        say(err.message || 'The write-up didn’t finish. Nothing was saved — try again.', 'error');
      }
    });

    document.body.appendChild(overlay);
    form.elements.text.focus();
  }

  window.MeetingMinutesForm = { open };
})();
