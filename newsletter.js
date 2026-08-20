// newsletter.js — the Newsletter Studio view controller (newsletter.html).
// IIFE like every other view controller: the router re-runs inline scripts on each view swap.
//
// The editor is deliberately plain Markdown rather than a mirror of the Blog Studio's rich editor.
// An email is not a web page — half the clients strip the styling a rich editor produces, so the
// thing worth investing in here is the PREVIEW (what actually lands in an inbox), not the input.
(function () {

  const ISSUES_API = '/.netlify/functions/newsletter-issues';

  const esc = (s) => window.escapeHtml ? window.escapeHtml(s) : String(s ?? '');
  const $ = (id) => document.getElementById(id);

  // `hidden` loses to any utility that sets display, so every toggle touches both.
  function show(el, display = 'flex') { if (el) { el.classList.remove('hidden'); el.style.display = display; } }
  function hide(el) { if (el) { el.classList.add('hidden'); el.style.display = 'none'; } }

  const state = { issues: [], segments: [], current: null, dirty: false };

  const STATUS = {
    draft:            { label: 'Draft',            cls: 'bg-gray-100 text-gray-600 border-gray-200' },
    pending_approval: { label: 'Awaiting approval', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
    in_review:        { label: 'In review',        cls: 'bg-amber-100 text-amber-700 border-amber-200' },
    approved:         { label: 'Approved',         cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    scheduled:        { label: 'Scheduled',        cls: 'bg-blue-100 text-blue-700 border-blue-200' },
    sending:          { label: 'Sending',          cls: 'bg-blue-100 text-blue-700 border-blue-200' },
    sent:             { label: 'Sent',             cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    paused:           { label: 'Paused',           cls: 'bg-gray-100 text-gray-600 border-gray-200' },
    failed:           { label: 'Failed',           cls: 'bg-red-100 text-red-700 border-red-200' },
    rejected:         { label: 'Sent back',        cls: 'bg-red-100 text-red-700 border-red-200' },
    archived:         { label: 'Archived',         cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  };

  // Mirrors src/config/newsletter-merge-vars.ts. ⚠️ If you add one there, add it here — the whole
  // point of that module is that the editor, the prompt and the send worker agree.
  const VARS = [
    { key: 'contact.first_name', label: 'First name', fallback: 'there' },
    { key: 'contact.company', label: 'Company', fallback: 'your team' },
    { key: 'sender.name', label: 'Your name', fallback: '' },
  ];

  const fmtDate = (v) => {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };

  async function api(url, opts) {
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* a non-JSON error page is still an error */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data || {};
  }

  // ── Load and render ────────────────────────────────────────────────────────

  async function loadIssues(selectId) {
    try {
      const { issues, segments } = await api(ISSUES_API);
      state.issues = issues || [];
      state.segments = segments || [];
      renderList();
      fillSegments();
      const pick = selectId || (state.current && state.current.id);
      if (pick && state.issues.some((i) => i.id === pick)) await openIssue(pick);
      else if (!state.issues.length) { hide($('nl-editor')); show($('nl-empty'), 'block'); }
    } catch (err) {
      const list = $('nl-list');
      if (list) list.innerHTML = `<li class="p-6 text-center text-sm text-red-600">${esc(err.message)}</li>`;
    }
  }

  /**
   * Repaint the sidebar without touching the editor.
   *
   * ⚠️ Why this exists: calling loadIssues() after an action re-opens the issue from the server and
   * overwrites whatever is on screen. After a draft that is actively harmful — the generated copy
   * and the "we tidied this" warnings both vanish in the same tick they appear, and the author
   * never learns a tag was removed.
   */
  async function refreshList() {
    try {
      const { issues, segments } = await api(ISSUES_API);
      state.issues = issues || [];
      state.segments = segments || [];
      renderList();
    } catch { /* the list is context, not the work — a failure here must not disturb the editor */ }
  }

  function renderList() {
    const list = $('nl-list');
    if (!list) return;
    const live = state.issues.filter((i) => i.status !== 'archived');
    if (!live.length) {
      list.innerHTML = '<li class="p-6 text-center text-sm text-gray-500">No issues yet. Start one and the assistant can draft it for you.</li>';
      return;
    }
    list.innerHTML = live.map((i) => {
      const st = STATUS[i.status] || { label: i.status, cls: 'bg-gray-100 text-gray-600 border-gray-200' };
      const active = state.current && state.current.id === i.id;
      return `<li>
        <button type="button" data-issue="${i.id}" class="w-full text-left px-4 py-3 hover:bg-gray-50 cursor-pointer ${active ? 'bg-emerald-50' : ''}">
          <div class="flex items-start justify-between gap-2">
            <p class="text-sm font-bold text-gray-900 truncate">${esc(i.subject || 'Untitled issue')}</p>
            <span class="shrink-0 inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full border ${st.cls}">${esc(st.label)}</span>
          </div>
          <p class="text-xs text-gray-500 mt-0.5">
            ${i.sentAt ? `Sent ${esc(fmtDate(i.sentAt))} · ${Number(i.recipientCount || 0).toLocaleString()} recipients`
              : i.scheduledFor ? `Scheduled ${esc(fmtDate(i.scheduledFor))}`
              : `Edited ${esc(fmtDate(i.updatedAt))}`}
          </p>
        </button>
      </li>`;
    }).join('');
  }

  function fillSegments() {
    const sel = $('nl-segment');
    if (!sel) return;
    sel.innerHTML = '<option value="">Everyone subscribed</option>'
      + state.segments.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  }

  function renderVarChips() {
    const host = $('nl-vars');
    if (!host) return;
    host.innerHTML = VARS.map((v) => `<button type="button" data-var="${esc(v.key)}"
      class="px-2 py-1 text-[11px] font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer">+ ${esc(v.label)}</button>`).join('');
  }

  function insertVar(key) {
    const ta = $('nl-body');
    const v = VARS.find((x) => x.key === key);
    if (!ta || !v) return;
    // Written WITH the fallback, so the author can see what a subscriber with no name on file
    // will actually read. A bare tag would render as nothing for them.
    const tag = v.fallback ? `{{${v.key} | "${v.fallback}"}}` : `{{${v.key}}}`;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    ta.value = ta.value.slice(0, start) + tag + ta.value.slice(end);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + tag.length;
    state.dirty = true;
  }

  async function openIssue(id) {
    try {
      const { issue, audienceEstimate } = await api(`${ISSUES_API}?id=${encodeURIComponent(id)}`);
      state.current = issue;
      state.dirty = false;
      hide($('nl-empty'));
      show($('nl-editor'), 'block');

      $('nl-subject').value = issue.subject || '';
      $('nl-preheader').value = issue.preheader || '';
      $('nl-body').value = issue.bodyMarkdown || '';
      $('nl-segment').value = issue.segmentId ? String(issue.segmentId) : '';
      $('nl-schedule').value = issue.scheduledFor ? new Date(issue.scheduledFor).toISOString().slice(0, 16) : '';

      const st = STATUS[issue.status] || { label: issue.status, cls: 'bg-gray-100 text-gray-600 border-gray-200' };
      const badge = $('nl-status');
      badge.textContent = st.label;
      badge.className = `inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full border ${st.cls}`;

      renderAudience(audienceEstimate);
      hide($('nl-warnings'));
      renderFailure(issue);
      renderStats(issue);

      // "Send now" only exists once a human has approved. The worker is what actually sends, so
      // this button only makes the issue due — there is one send path, scheduled or not.
      const sendable = ['approved', 'scheduled'].includes(issue.status) && !!issue.renderedPayload;
      if (sendable) show($('nl-send'), 'inline-flex'); else hide($('nl-send'));

      // A sent issue is a record of what people received, not a document. Lock the inputs rather
      // than letting someone type into a thing the server will refuse to save.
      const locked = ['sending', 'sent'].includes(issue.status);
      ['nl-subject', 'nl-preheader', 'nl-body', 'nl-segment', 'nl-schedule'].forEach((k) => { $(k).disabled = locked; });
      ['nl-generate', 'nl-save', 'nl-approve', 'nl-send'].forEach((k) => { const el = $(k); if (el) el.disabled = locked; });
      $('nl-saved').textContent = locked ? 'This issue has been sent and can no longer be edited.' : '';

      renderList();
    } catch (err) {
      window.showToast(err.message);
    }
  }

  function renderAudience(n) {
    const el = $('nl-audience');
    if (!el) return;
    if (n == null) { el.textContent = ''; return; }
    // "About", always. The per-address opt-out and suppression checks run at send time, so the
    // real number can only be lower — promising an exact figure creates a support conversation.
    el.textContent = `About ${Number(n).toLocaleString()} ${n === 1 ? 'person' : 'people'} will receive this.`;
  }

  function renderFailure(issue) {
    const el = $('nl-failure');
    if (!el) return;
    if (issue.status !== 'failed' || !issue.failureReason) { hide(el); return; }
    // The reason verbatim: it is written for the tenant and usually names the fix.
    el.innerHTML = `<p class="font-bold mb-1">This issue did not send</p><p>${esc(issue.failureReason)}</p>`;
    show(el, 'block');
  }

  function renderStats(issue) {
    const el = $('nl-stats');
    if (!el) return;
    if (!issue.sentAt && !issue.recipientCount) { hide(el); return; }
    const n = (v) => Number(v || 0).toLocaleString();
    // Bounces, complaints and unsubscribes shown alongside the good numbers, always. A dashboard
    // that reports only deliveries is how a list quietly degrades for months.
    el.innerHTML = `<p class="font-bold mb-1">Results</p>
      <p>${n(issue.recipientCount)} sent · ${n(issue.deliveredCount)} delivered · ${n(issue.bouncedCount)} bounced ·
      ${n(issue.complainedCount)} marked as spam · ${n(issue.unsubscribedCount)} unsubscribed</p>`;
    show(el, 'block');
  }

  function renderWarnings(warnings) {
    const el = $('nl-warnings');
    if (!el) return;
    if (!warnings || !warnings.length) { hide(el); return; }
    el.innerHTML = `<p class="font-bold mb-1">We tidied the draft before showing it to you</p><ul class="list-disc pl-5 space-y-0.5">${
      warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
    show(el, 'block');
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  function payload() {
    return {
      id: state.current.id,
      subject: $('nl-subject').value,
      preheader: $('nl-preheader').value,
      bodyMarkdown: $('nl-body').value,
      segmentId: Number($('nl-segment').value || '') || null,
      scheduledFor: $('nl-schedule').value ? new Date($('nl-schedule').value).toISOString() : null,
    };
  }

  async function save(quiet) {
    if (!state.current) return null;
    const res = await api(ISSUES_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', ...payload() }),
    });
    state.dirty = false;
    $('nl-saved').textContent = 'Saved';
    setTimeout(() => { if ($('nl-saved')) $('nl-saved').textContent = ''; }, 2000);
    // The server drops approval when the words change. Say so — an issue that quietly went back
    // to draft would sit unsent while the tenant believed it was approved.
    if (res.approvalCleared) window.showToast('Edited after approval, so this needs approving again.');
    if (!quiet) await refreshList();
    return res;
  }

  async function generate(topic, notes) {
    const go = $('nl-brief-go');
    if (go) { go.disabled = true; go.textContent = 'Writing…'; }
    try {
      // Save first: the server drafts from the stored row, so an unsaved subject would be ignored.
      await save(true);
      const res = await api(ISSUES_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate', id: state.current.id, topic, notes }),
      });
      $('nl-subject').value = res.subject || '';
      $('nl-preheader').value = res.preheader || '';
      $('nl-body').value = res.bodyMarkdown || '';
      renderWarnings(res.warnings);
      hide($('nl-brief-modal'));
      window.showToast('Draft ready — read it before you approve it.');
      // List only. Re-opening the issue here would replace the draft that was just written into
      // the fields, and would hide the warnings the author has not read yet.
      state.dirty = false;
      await refreshList();
    } catch (err) {
      window.showToast(err.message);
    } finally {
      if (go) { go.disabled = false; go.textContent = 'Write the draft'; }
    }
  }

  async function preview() {
    if (!state.current) return;
    try {
      await save(true);
      const res = await api(ISSUES_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', id: state.current.id }),
      });
      const frame = $('nl-preview-frame');
      // srcdoc into a sandboxed iframe: the preview is a full HTML document and must not be able
      // to restyle or script the app around it.
      if (frame) frame.srcdoc = res.html || '';
      show($('nl-preview-modal'), 'flex');
    } catch (err) { window.showToast(err.message); }
  }

  async function approve() {
    if (!state.current) return;
    const when = $('nl-schedule').value;
    const audience = $('nl-audience').textContent || '';
    const ok = await window.confirmModal(
      `${audience ? esc(audience) + ' ' : ''}${when ? 'It will send at the time you set.' : 'It will be ready to send.'} Approving records that you have read it.`,
      { title: when ? 'Approve and schedule?' : 'Approve this issue?', confirmLabel: 'Approve', confirmColor: '#059669' },
    );
    if (!ok) return;
    try {
      await save(true);
      const res = await api(ISSUES_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approve',
          id: state.current.id,
          scheduledFor: when ? new Date(when).toISOString() : null,
        }),
      });
      window.showToast(res.issue && res.issue.status === 'scheduled' ? 'Approved and scheduled.' : 'Approved.');
      await loadIssues(state.current.id);
    } catch (err) { window.showToast(err.message); }
  }

  async function sendNow() {
    if (!state.current) return;
    const audience = $('nl-audience').textContent || '';
    const ok = await window.confirmModal(
      `${audience ? esc(audience) + ' ' : ''}This cannot be undone once it starts — emails that have gone out cannot be recalled.`,
      { title: 'Send this issue now?', confirmLabel: 'Send now', confirmColor: '#059669' },
    );
    if (!ok) return;
    try {
      const res = await api(ISSUES_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', id: state.current.id }),
      });
      // Honest about the delay: the worker picks it up on its next tick rather than sending here.
      window.showToast(res.queued ? 'Queued — sending starts within a few minutes.' : 'Queued.');
      await openIssue(state.current.id);
      await refreshList();
    } catch (err) { window.showToast(err.message); }
  }

  // ── Sending setup ──────────────────────────────────────────────────────────

  const DOMAIN_API = '/.netlify/functions/newsletter-sending-domain';

  async function openSendingModal() {
    const modal = $('nl-sending-modal');
    const body = $('nl-sending-body');
    if (!modal || !body) return;
    show(modal, 'flex');
    body.innerHTML = '<p class="text-sm text-gray-500">Loading…</p>';
    try {
      const { domains, needsSetup } = await api(DOMAIN_API);
      if (needsSetup) {
        body.innerHTML = '<p class="text-sm text-gray-600">Sending setup is not available on this environment yet — the database migration has not been applied.</p>';
        return;
      }
      renderSending(domains || []);
    } catch (err) {
      body.innerHTML = `<p class="text-sm text-red-600">${esc(err.message)}</p>`;
    }
  }

  function renderSending(domains) {
    const body = $('nl-sending-body');
    const domain = domains[0] || null;

    if (!domain) {
      body.innerHTML = `
        <div class="rounded-xl border border-gray-200 p-4 mb-4">
          <p class="text-sm font-bold text-gray-900 mb-1">Right now: your connected mailbox</p>
          <p class="text-sm text-gray-600">Issues send from the mailbox you connected, and are capped at a small list — a personal mailbox has daily limits and gives no delivery feedback.</p>
        </div>
        <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Send from your own domain</label>
        <input type="text" id="nl-domain-input" placeholder="mail.yourbusiness.com"
          class="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm">
        <p class="text-[11px] text-gray-400 mt-1">Use a subdomain such as <span class="font-mono">mail.</span> — it keeps your marketing separate from your everyday business email.</p>
        <div class="flex justify-end mt-4">
          <button type="button" id="nl-domain-create" class="px-4 py-2 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Get my DNS records</button>
        </div>`;
      $('nl-domain-create')?.addEventListener('click', async () => {
        const value = ($('nl-domain-input')?.value || '').trim();
        if (!value) { window.showToast('Enter the domain you want to send from.'); return; }
        try {
          const res = await api(DOMAIN_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'create', domain: value }),
          });
          if (res.warning) window.showToast(res.warning, { duration: 8000 });
          renderSending([res.domain]);
        } catch (err) { window.showToast(err.message); }
      });
      return;
    }

    const verified = domain.status === 'verified';
    const records = Array.isArray(domain.dnsRecords) ? domain.dnsRecords : [];

    body.innerHTML = `
      <div class="flex items-center gap-2 mb-4">
        <span class="inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full border ${verified
          ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
          : 'bg-amber-100 text-amber-700 border-amber-200'}">${verified ? 'Verified' : 'Waiting for DNS'}</span>
        <span class="text-sm font-bold text-gray-900 font-mono">${esc(domain.domain)}</span>
      </div>

      ${verified ? '' : `
        <p class="text-sm text-gray-600 mb-3">Add these records at whoever manages your DNS, then check again. It usually takes a few minutes, occasionally a few hours.</p>
        <div class="overflow-x-auto rounded-xl border border-gray-200 mb-4">
          <table class="min-w-full text-xs">
            <thead class="bg-gray-50 border-b border-gray-200"><tr>
              <th class="px-3 py-2 text-left font-bold text-gray-500 uppercase">Type</th>
              <th class="px-3 py-2 text-left font-bold text-gray-500 uppercase">Name</th>
              <th class="px-3 py-2 text-left font-bold text-gray-500 uppercase">Value</th>
            </tr></thead>
            <tbody class="divide-y divide-gray-100">
              ${records.length ? records.map((r) => `<tr>
                <td class="px-3 py-2 font-mono">${esc(r.type || '')}</td>
                <td class="px-3 py-2 font-mono break-all">${esc(r.name || '')}</td>
                <td class="px-3 py-2 font-mono break-all">${esc(r.value || '')}</td>
              </tr>`).join('') : '<tr><td colspan="3" class="px-3 py-4 text-center text-gray-500">No records returned yet — check again in a moment.</td></tr>'}
            </tbody>
          </table>
        </div>`}

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">From name</label>
          <input type="text" id="nl-from-name" value="${esc(domain.fromName || '')}"
            class="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm">
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">From address</label>
          <div class="flex items-center gap-1">
            <input type="text" id="nl-from-local" value="${esc(domain.fromLocalPart || 'hello')}"
              class="w-28 px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm">
            <span class="text-sm text-gray-500 font-mono">@${esc(domain.domain)}</span>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap justify-end gap-2 mt-6">
        <button type="button" id="nl-domain-remove" class="px-3 py-2 text-xs font-bold text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer">Remove</button>
        <div class="flex-1"></div>
        <button type="button" id="nl-domain-save" class="px-4 py-2 text-sm font-bold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 cursor-pointer">Save</button>
        ${verified ? '' : '<button type="button" id="nl-domain-check" class="px-4 py-2 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Check DNS</button>'}
      </div>`;

    $('nl-domain-check')?.addEventListener('click', async () => {
      const btn = $('nl-domain-check');
      if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
      try {
        const res = await api(DOMAIN_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'check', id: domain.id }),
        });
        window.showToast(res.verified
          ? 'Verified — your newsletter now sends from your own domain.'
          : 'Not visible yet. DNS can take a few hours to spread.');
        renderSending([res.domain]);
      } catch (err) { window.showToast(err.message); }
      finally { if (btn) { btn.disabled = false; btn.textContent = 'Check DNS'; } }
    });

    $('nl-domain-save')?.addEventListener('click', async () => {
      try {
        const res = await api(DOMAIN_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update', id: domain.id,
            fromName: $('nl-from-name')?.value, fromLocalPart: $('nl-from-local')?.value,
          }),
        });
        window.showToast('Saved.');
        renderSending([res.domain]);
      } catch (err) { window.showToast(err.message); }
    });

    $('nl-domain-remove')?.addEventListener('click', async () => {
      const ok = await window.confirmModal(
        'Remove this sending domain? New issues will fall back to your connected mailbox, which is capped at a small list.',
        { title: 'Remove the domain?', confirmLabel: 'Remove' });
      if (!ok) return;
      try {
        const res = await api(DOMAIN_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove', id: domain.id }),
        });
        if (res.note) window.showToast(res.note, { duration: 7000 });
        renderSending([]);
      } catch (err) { window.showToast(err.message); }
    });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  function wire() {
    $('nl-new')?.addEventListener('click', async () => {
      const subject = await window.promptModal('Give this issue a working subject line — the assistant can rewrite it.',
        { title: 'New issue', placeholder: 'This month at…', confirmLabel: 'Create' });
      if (!subject) return;
      try {
        const { issue } = await api(ISSUES_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create', subject }),
        });
        await loadIssues(issue.id);
      } catch (err) { window.showToast(err.message); }
    });

    $('nl-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-issue]');
      if (btn) openIssue(Number(btn.getAttribute('data-issue')));
    });

    $('nl-vars')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-var]');
      if (btn) insertVar(btn.getAttribute('data-var'));
    });

    ['nl-subject', 'nl-preheader', 'nl-body', 'nl-segment', 'nl-schedule'].forEach((k) => {
      $(k)?.addEventListener('input', () => { state.dirty = true; });
    });

    $('nl-segment')?.addEventListener('change', async () => {
      // Re-ask the server rather than counting locally: the number depends on contact status,
      // which this page does not hold.
      try {
        await save(true);
        const { audienceEstimate } = await api(`${ISSUES_API}?id=${encodeURIComponent(state.current.id)}`);
        renderAudience(audienceEstimate);
      } catch { /* the estimate is a nicety; a failure here must not block editing */ }
    });

    $('nl-save')?.addEventListener('click', async () => {
      try { await save(false); } catch (err) { window.showToast(err.message); }
    });
    $('nl-preview')?.addEventListener('click', preview);
    $('nl-send')?.addEventListener('click', sendNow);
    $('nl-sending')?.addEventListener('click', openSendingModal);
    document.querySelectorAll('[data-nl-sending-close]').forEach((el) => el.addEventListener('click', () => hide($('nl-sending-modal'))));
    $('nl-approve')?.addEventListener('click', approve);

    $('nl-generate')?.addEventListener('click', () => {
      $('nl-brief-topic').value = '';
      $('nl-brief-notes').value = '';
      show($('nl-brief-modal'), 'flex');
    });
    document.querySelectorAll('[data-nl-brief-close]').forEach((el) => el.addEventListener('click', () => hide($('nl-brief-modal'))));
    $('nl-brief-go')?.addEventListener('click', () => generate($('nl-brief-topic').value, $('nl-brief-notes').value));

    document.querySelectorAll('[data-nl-preview-close]').forEach((el) => el.addEventListener('click', () => hide($('nl-preview-modal'))));
  }

  window.initNewsletter = async function initNewsletter() {
    state.current = null;
    state.dirty = false;
    wire();
    renderVarChips();
    // Deep link from the Review Queue ("Open in Studio"). Consumed on read so a later visit to the
    // Studio does not silently reopen an issue the user has moved on from.
    const wanted = window._newsletterInitialIssueId;
    window._newsletterInitialIssueId = null;
    await loadIssues(wanted || undefined);
  };
})();
