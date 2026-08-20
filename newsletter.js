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

  const state = { issues: [], segments: [], customFields: [], sendTimezone: '', current: null, dirty: false };

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

  /**
   * The built-ins plus the org's own columns, which only the server knows.
   *
   * ⚠️ A custom tag is offered WITH a fallback already written in. The server strips a bare one and
   * warns, because there is no honest default for a field called "City" and an empty render is
   * "our new shop in ." in every inbox where we hold no value.
   */
  function allVars() {
    return VARS.concat((state.customFields || []).map((f) => ({
      key: `contact.custom.${f.key}`,
      label: f.label,
      fallback: '…',
    })));
  }

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
      const { issues, segments, customFields } = await api(ISSUES_API);
      state.issues = issues || [];
      state.segments = segments || [];
      state.customFields = customFields || [];
      renderList();
      fillSegments();
      renderVarChips();
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
      const { issues, segments, customFields } = await api(ISSUES_API);
      state.issues = issues || [];
      state.segments = segments || [];
      state.customFields = customFields || [];
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
          ${i.generationReason === 'blog_post_handoff'
            ? '<p class="text-[11px] font-bold text-sky-700 mt-0.5">From your blog</p>' : ''}
          ${i.resendOfIssueId
            ? '<p class="text-[11px] font-bold text-emerald-700 mt-0.5">Resend to non-openers</p>' : ''}
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
    // Grouped, because a tag and a segment are the same thing to the send but not to the person
    // choosing: an audience built to be sent to should not be buried among forty descriptive
    // labels. Both remain selectable — a tag IS a valid audience.
    const opt = (s) => `<option value="${s.id}">${esc(s.name)}</option>`;
    const segs = state.segments.filter((s) => s.kind !== 'tag');
    const tags = state.segments.filter((s) => s.kind === 'tag');
    sel.innerHTML = '<option value="">Everyone subscribed</option>'
      + (segs.length ? `<optgroup label="Segments">${segs.map(opt).join('')}</optgroup>` : '')
      + (tags.length ? `<optgroup label="Tags">${tags.map(opt).join('')}</optgroup>` : '');
  }

  function renderVarChips() {
    const host = $('nl-vars');
    if (!host) return;
    host.innerHTML = allVars().map((v) => `<button type="button" data-var="${esc(v.key)}"
      class="px-2 py-1 text-[11px] font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer">+ ${esc(v.label)}</button>`).join('');
  }

  function insertVar(key) {
    const ta = $('nl-body');
    const v = allVars().find((x) => x.key === key);
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
      const { issue, audienceEstimate, sourcePost, resend, links, sendTimezone, scheduledForLocal, deliverability } = await api(`${ISSUES_API}?id=${encodeURIComponent(id)}`);
      state.current = issue;
      state.dirty = false;
      hide($('nl-empty'));
      show($('nl-editor'), 'block');

      $('nl-subject').value = issue.subject || '';
      $('nl-preheader').value = issue.preheader || '';
      $('nl-body').value = issue.bodyMarkdown || '';
      $('nl-segment').value = issue.segmentId ? String(issue.segmentId) : '';
      // ⚠️ The wall-clock the SERVER worked out, in the business's zone — not this browser's idea of
      // it. Somebody editing from another country would otherwise see (and re-save) a different
      // time from the one the issue goes out at.
      state.sendTimezone = sendTimezone || '';
      $('nl-schedule').value = scheduledForLocal || '';
      renderScheduleZone();

      const st = STATUS[issue.status] || { label: issue.status, cls: 'bg-gray-100 text-gray-600 border-gray-200' };
      const badge = $('nl-status');
      badge.textContent = st.label;
      badge.className = `inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full border ${st.cls}`;

      renderAudience(audienceEstimate);
      renderSource(issue, sourcePost);
      renderResend(issue, resend);
      renderAb(issue);
      renderSendMode(issue);
      renderDeliverability(issue, deliverability);
      renderLinks(issue, links);
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

  function renderSource(issue, sourcePost) {
    const el = $('nl-source');
    if (!el) return;
    if (issue.generationReason !== 'blog_post_handoff') { hide(el); return; }
    // Named, and linked. "Drafted automatically" on its own invites the reader to hunt for what it
    // was drafted FROM, and the answer is one click away.
    const title = sourcePost && sourcePost.title ? sourcePost.title : 'a post you published';
    const link = sourcePost && sourcePost.canonicalUrl
      ? ` <a href="${esc(sourcePost.canonicalUrl)}" target="_blank" rel="noopener" class="font-bold underline">Read it</a>.`
      : '';
    el.innerHTML = `<p>Drafted from your blog post <span class="font-bold">${esc(title)}</span>.${link}</p>
      <p class="text-[11px] text-sky-700 mt-1">The link at the end of the email points there. Nothing is sent until you approve it.</p>`;
    show(el, 'block');
  }

  function renderFailure(issue) {
    const el = $('nl-failure');
    if (!el) return;
    if (issue.status !== 'failed' || !issue.failureReason) { hide(el); return; }
    // The reason verbatim: it is written for the tenant and usually names the fix.
    el.innerHTML = `<p class="font-bold mb-1">This issue did not send</p><p>${esc(issue.failureReason)}</p>`;
    show(el, 'block');
  }

  // The cheapest reach increase in email, and the easiest to turn into spam — so the panel states
  // who it would go to before it offers the button, and every refusal says what would make it
  // possible instead of hiding.
  function renderResend(issue, verdict) {
    const el = $('nl-resend');
    if (!el) return;
    if (!verdict || issue.status !== 'sent') { hide(el); return; }

    if (!verdict.canResend) {
      // 'not_sent' on a sent issue cannot happen; the rest are worth explaining. A resend of a
      // resend says nothing at all — the panel would just be noise on every second issue.
      if (verdict.reason === 'is_resend') { hide(el); return; }
      el.className = 'mt-3 px-4 py-3 rounded-xl border text-sm bg-gray-50 border-gray-200 text-gray-600';
      const when = verdict.availableAt
        ? `<p class="text-[11px] text-gray-500 mt-1">Available from ${esc(fmtDate(verdict.availableAt))}.</p>` : '';
      el.innerHTML = `<p class="font-bold mb-1 text-gray-700">Resend to people who didn't open it</p>
        <p>${esc(verdict.message || '')}</p>${when}`;
      show(el, 'block');
      return;
    }

    const n = Number(verdict.unopened || 0);
    el.className = 'mt-3 px-4 py-3 rounded-xl border text-sm bg-emerald-50 border-emerald-200 text-emerald-900';
    el.innerHTML = `<p class="font-bold mb-1">Resend to people who didn't open it</p>
      <p>${n.toLocaleString()} ${n === 1 ? 'person was' : 'people were'} sent this and never opened it.
      The email stays exactly as it was approved — only the subject line changes.</p>
      <div class="flex flex-wrap items-end gap-2 mt-3">
        <div class="flex-1 min-w-[14rem]">
          <label class="block text-[11px] font-bold text-emerald-800 uppercase tracking-wide mb-1">New subject line</label>
          <input type="text" id="nl-resend-subject" maxlength="200" value="${esc(issue.subject || '')}"
            class="w-full px-3 py-2 rounded-lg border border-emerald-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm">
        </div>
        <button type="button" id="nl-resend-go"
          class="px-4 py-2 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Resend</button>
      </div>
      <p class="text-[11px] text-emerald-700 mt-2">A different subject line is the whole point — the same one arriving twice reads as a mistake.</p>`;
    show(el, 'block');

    $('nl-resend-go')?.addEventListener('click', async () => {
      const subject = $('nl-resend-subject').value.trim();
      if (!subject) { window.showToast('Give the resend a subject line.'); return; }
      const ok = await window.confirmModal(
        `This sends to ${n.toLocaleString()} ${n === 1 ? 'person' : 'people'} who did not open the original. It goes out straight away, and an issue can only be resent once.`,
        { title: 'Resend this issue?', confirmLabel: 'Resend now', confirmColor: '#059669' });
      if (!ok) return;
      const btn = $('nl-resend-go');
      btn.disabled = true;
      try {
        const res = await api(ISSUES_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'resend', id: issue.id, subject }),
        });
        window.showToast(`Resending to ${Number(res.recipients || 0).toLocaleString()} people.`);
        // Open the RESEND, not the original: the thing that is now sending is the thing the user
        // should be looking at.
        await loadIssues(res.issue.id);
      } catch (err) {
        btn.disabled = false;
        window.showToast(err.message);
      }
    });
  }

  // ── A/B subject test ───────────────────────────────────────────────────────

  function renderSendMode(issue) {
    const el = $('nl-sendmode');
    if (!el) return;
    if (['sending', 'sent'].includes(issue.status)) {
      // After the fact this is a statement about what happened, not a control.
      el.innerHTML = issue.sendMode === 'recipient_local'
        ? `<p class="text-[11px] text-gray-500">Sent at ${esc(issue.sendLocalTime || '')} in each subscriber's own timezone, where we knew it.</p>`
        : '';
      return;
    }

    const local = issue.sendMode === 'recipient_local';
    el.innerHTML = `<div class="px-4 py-3 rounded-xl border ${local ? 'bg-sky-50 border-sky-200' : 'bg-gray-50 border-gray-200'} text-sm">
      <label class="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" id="nl-local-on" ${local ? 'checked' : ''} class="mt-0.5">
        <span>
          <span class="font-bold text-gray-900">Send at each subscriber's local time</span>
          <span class="block text-[11px] text-gray-500">Instead of everyone at once. We only know a timezone for people who signed up through a form — everyone else gets it at your time.</span>
        </span>
      </label>
      ${local ? `
        <div class="flex items-center gap-2 mt-3">
          <label class="text-xs text-gray-700">Their local time
            <input type="time" id="nl-local-time" value="${esc(issue.sendLocalTime || '09:00')}"
              class="ml-1 px-2 py-1.5 rounded-lg border border-sky-300 text-sm">
          </label>
          <button type="button" id="nl-local-save"
            class="ml-auto px-3 py-1.5 text-xs font-bold text-white bg-sky-600 hover:bg-sky-700 rounded-lg cursor-pointer">Save</button>
        </div>
        <p id="nl-local-known" class="text-[11px] text-sky-700 mt-2"></p>` : ''}
    </div>`;

    $('nl-local-on')?.addEventListener('change', async (e) => {
      if (!e.target.checked) {
        try {
          await api(ISSUES_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sendTime', id: issue.id, mode: 'at_once' }),
          });
          await openIssue(issue.id);
        } catch (err) { window.showToast(err.message); }
        return;
      }
      await saveSendMode(issue, '09:00');
    });
    $('nl-local-save')?.addEventListener('click', () => saveSendMode(issue, $('nl-local-time').value));
  }

  async function saveSendMode(issue, localTime) {
    try {
      const res = await api(ISSUES_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sendTime', id: issue.id, mode: 'recipient_local', localTime }),
      });
      await openIssue(issue.id);
      // ⚠️ The honest number, shown after saving rather than promised before it: on most lists we
      // know a timezone for a minority, and everyone else is sent at the sender's own time.
      const known = Number(res.knownTimezones || 0), total = Number(res.subscribers || 0);
      const el = $('nl-local-known');
      if (el) {
        el.textContent = total
          ? `We know a timezone for ${known.toLocaleString()} of your ${total.toLocaleString()} subscribers. The other ${(total - known).toLocaleString()} will get it at ${localTime} your time.`
          : '';
      }
    } catch (err) { window.showToast(err.message); }
  }

  function renderScheduleZone() {
    const el = $('nl-schedule-zone');
    if (!el) return;
    // Named, always. "9:00" with no zone beside it is the ambiguity this whole feature exists to
    // remove, and a label costs nothing.
    el.textContent = state.sendTimezone ? `Times are ${state.sendTimezone.replace(/_/g, ' ')}.` : '';
  }

  function renderAb(issue) {
    const el = $('nl-ab');
    if (!el) return;
    const locked = ['sending', 'sent'].includes(issue.status);

    // A finished test shows what it found, in the words the server wrote — including "too close to
    // call", which is often the honest answer and which a bare winner would hide.
    if (issue.abState === 'decided' || (locked && issue.abState === 'testing')) {
      const waiting = issue.abState === 'testing';
      el.innerHTML = `<div class="px-4 py-3 rounded-xl bg-gray-50 border border-gray-200 text-sm text-gray-700">
        <p class="font-bold mb-1">Subject line test</p>
        <p class="text-gray-600"><span class="font-bold">A:</span> ${esc(issue.subject || '')}</p>
        <p class="text-gray-600"><span class="font-bold">B:</span> ${esc(issue.subjectB || '')}</p>
        ${waiting
          ? `<p class="mt-2 text-gray-500">The sample has gone out. The winner goes to everyone else about ${Number(issue.abDecideAfterHours || 4)} hours later.</p>`
          : `<p class="mt-2">${esc(issue.abNote || '')}</p>`}
      </div>`;
      return;
    }
    if (locked) { el.innerHTML = ''; return; }

    if (issue.abState !== 'testing') {
      el.innerHTML = `<button type="button" id="nl-ab-on"
        class="text-xs font-bold text-emerald-700 hover:text-emerald-800 cursor-pointer">+ Test a second subject line</button>`;
      $('nl-ab-on')?.addEventListener('click', () => {
        // Rendered as though it were already on, so the form appears without a round trip. Nothing
        // is saved until they press Save, and the issue's own state is what the next load reads.
        renderAbForm({ ...issue, abState: 'testing' });
      });
      return;
    }
    renderAbForm(issue);
  }

  function renderAbForm(issue) {
    const el = $('nl-ab');
    el.innerHTML = `<div class="px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm">
      <div class="flex items-center justify-between mb-2">
        <p class="font-bold text-emerald-900">Test a second subject line</p>
        <button type="button" id="nl-ab-off" class="text-xs font-bold text-emerald-800 hover:text-emerald-900 cursor-pointer">Remove</button>
      </div>
      <input type="text" id="nl-ab-subject" maxlength="200" value="${esc(issue.subjectB || '')}"
        placeholder="The other subject line"
        class="w-full px-3 py-2.5 rounded-lg border border-emerald-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm mb-2">
      <div class="flex flex-wrap items-end gap-3">
        <label class="text-xs text-emerald-900">Send to
          <select id="nl-ab-percent" class="ml-1 px-2 py-1.5 rounded-lg border border-emerald-300 text-sm">
            ${[10, 20, 30, 40, 50].map((p) => `<option value="${p}" ${Number(issue.abSamplePercent || 30) === p ? 'selected' : ''}>${p}%</option>`).join('')}
          </select>
        </label>
        <label class="text-xs text-emerald-900">Decide after
          <select id="nl-ab-hours" class="ml-1 px-2 py-1.5 rounded-lg border border-emerald-300 text-sm">
            ${[1, 2, 4, 8, 24, 48].map((h) => `<option value="${h}" ${Number(issue.abDecideAfterHours || 4) === h ? 'selected' : ''}>${h} ${h === 1 ? 'hour' : 'hours'}</option>`).join('')}
          </select>
        </label>
        <button type="button" id="nl-ab-save"
          class="ml-auto px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Save test</button>
      </div>
      <p class="text-[11px] text-emerald-700 mt-2">Half the sample gets each subject. Whichever more people OPEN is sent to everyone held back — and if the difference is too small to mean anything, we say so and send the first one.</p>
    </div>`;

    $('nl-ab-off')?.addEventListener('click', async () => {
      try {
        await api(ISSUES_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'abTest', id: issue.id, enabled: false }),
        });
        await openIssue(issue.id);
      } catch (err) { window.showToast(err.message); }
    });

    $('nl-ab-save')?.addEventListener('click', async () => {
      try {
        const res = await api(ISSUES_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'abTest',
            id: issue.id,
            subjectB: $('nl-ab-subject').value,
            samplePercent: Number($('nl-ab-percent').value),
            decideAfterHours: Number($('nl-ab-hours').value),
          }),
        });
        // The warning is the whole reason this returns anything: without a verified domain the test
        // cannot be decided, and that is worth knowing now rather than in four hours.
        if (res.warning) window.showToast(res.warning, { duration: 9000 });
        else window.showToast('Test saved.');
        await openIssue(issue.id);
      } catch (err) { window.showToast(err.message); }
    });
  }

  function renderDeliverability(issue, findings) {
    const el = $('nl-deliver');
    if (!el) return;
    const list = findings || [];
    // Nothing to say is worth saying nothing about — an always-present empty panel trains people to
    // ignore the place the real warnings appear.
    if (!list.length || ['sending', 'sent'].includes(issue.status)) { hide(el); return; }

    const worst = list[0].severity;
    const cls = worst === 'blocker' ? 'bg-red-50 border-red-200 text-red-900'
      : worst === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-900'
      : 'bg-gray-50 border-gray-200 text-gray-700';
    el.className = `mt-3 px-4 py-3 rounded-xl border text-sm ${cls}`;
    el.innerHTML = `<p class="font-bold mb-1">Before you send</p>
      <ul class="list-disc pl-5 space-y-1">
        ${list.map((f) => `<li>${esc(f.message)}</li>`).join('')}
      </ul>
      <p class="text-[11px] opacity-70 mt-2">These are specific things we can see, not a spam score — there is no number here because nobody can honestly give you one.</p>`;
    show(el, 'block');
  }

  function renderLinks(issue, links) {
    const el = $('nl-links');
    if (!el) return;
    if (!issue.sentAt) { hide(el); return; }

    if (!issue.engagementTracked) {
      // The same distinction the numbers above make: no clicks recorded and no clicks MEASURABLE
      // are different facts, and only one of them is about the reader.
      el.innerHTML = '<p class="font-bold mb-1">Which link worked</p>'
        + '<p class="text-gray-500">This issue was sent from your connected mailbox, which does not rewrite links — so clicks could not be measured.</p>';
      show(el, 'block');
      return;
    }
    if (!links || !links.length) {
      // ⚠️ TWO DIFFERENT FACTS, and the issue's own click count is what tells them apart. An issue
      // sent before per-link recording existed has clicks but no links, and saying "nobody clicked"
      // there would be the same lie as reporting 0% opens on a mailbox send — a statement about our
      // instrumentation dressed up as one about the reader.
      const clicked = Number(issue.clickedCount || 0);
      el.innerHTML = '<p class="font-bold mb-1">Which link worked</p>'
        + (clicked
          ? `<p class="text-gray-500">${clicked.toLocaleString()} ${clicked === 1 ? 'person' : 'people'} clicked something in this issue, but it was sent before we started recording which link. Issues from now on will show it.</p>`
          : '<p class="text-gray-500">Nobody has clicked a link in this issue.</p>');
      show(el, 'block');
      return;
    }

    const rows = links.map((l) => {
      const label = l.isUnsubscribe ? 'Unsubscribe link' : l.url;
      return `<tr class="border-t border-gray-200">
        <td class="py-1.5 pr-3 ${l.isUnsubscribe ? 'text-gray-500 italic' : ''}">
          ${l.isUnsubscribe ? esc(label) : `<a href="${esc(l.url)}" target="_blank" rel="noopener" class="text-emerald-700 hover:underline break-all">${esc(l.url)}</a>`}
        </td>
        <td class="py-1.5 pr-3 text-right font-bold whitespace-nowrap">${Number(l.people).toLocaleString()}</td>
        <td class="py-1.5 text-right text-gray-500 whitespace-nowrap">${Number(l.clicks).toLocaleString()}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `<p class="font-bold mb-1">Which link worked</p>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-[11px] uppercase tracking-wide text-gray-500">
            <th class="pb-1 font-bold">Link</th>
            <th class="pb-1 font-bold text-right">People</th>
            <th class="pb-1 font-bold text-right">Clicks</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="text-[11px] text-gray-400 mt-2">“People” counts each subscriber once, however many times they clicked.</p>`;
    show(el, 'block');
  }

  function renderStats(issue) {
    const el = $('nl-stats');
    if (!el) return;
    if (!issue.sentAt && !issue.recipientCount) { hide(el); return; }
    const n = (v) => Number(v || 0).toLocaleString();
    // Bounces, complaints and unsubscribes shown alongside the good numbers, always. A dashboard
    // that reports only deliveries is how a list quietly degrades for months.
    // Opens and clicks are shown only when the issue could report them. An issue sent from a
    // connected mailbox rewrites no links and embeds no pixel, so "0 opened" there would be a
    // statement about our instrumentation dressed up as a statement about the reader.
    const engagement = issue.engagementTracked
      ? ` · ${n(issue.openedCount)} opened · ${n(issue.clickedCount)} clicked`
      : '';
    el.innerHTML = `<p class="font-bold mb-1">Results</p>
      <p>${n(issue.recipientCount)} sent · ${n(issue.deliveredCount)} delivered${engagement} · ${n(issue.bouncedCount)} bounced ·
      ${n(issue.complainedCount)} marked as spam · ${n(issue.unsubscribedCount)} unsubscribed</p>
      ${issue.engagementTracked
        ? '<p class="text-[11px] text-gray-400 mt-1">Opens are indicative — Apple Mail loads the tracking image whether or not anyone reads it.</p>'
        : issue.sentAt ? '<p class="text-[11px] text-gray-400 mt-1">Opens and clicks were not measurable on this send.</p>' : ''}`;
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
      // Sent as typed. The server reads it in the issue's own zone — converting here would use
      // this browser's clock, which is the bug rather than the fix.
      scheduledFor: $('nl-schedule').value || null,
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
      // Loaded after the panel is on screen: the DMARC lookup is a DNS round trip, and holding the
      // whole modal for it would make setup feel broken.
      loadDeliverabilityHealth();
    } catch (err) {
      body.innerHTML = `<p class="text-sm text-red-600">${esc(err.message)}</p>`;
    }
  }

  async function loadDeliverabilityHealth() {
    const host = $('nl-sending-body');
    if (!host) return;
    const slot = document.createElement('div');
    slot.className = 'mt-5 pt-4 border-t border-gray-100';
    slot.innerHTML = '<p class="text-sm text-gray-400">Checking how your sending is doing…</p>';
    host.appendChild(slot);

    try {
      // A GET: it is a report, and any role in the org may read it.
      const res = await api(`${DOMAIN_API}?action=health`);
      const rows = [];
      for (const f of res.listHealth || []) rows.push({ severity: f.severity, message: f.message });
      if (res.dmarc && res.dmarc.advice) rows.push({ severity: res.dmarc.advice.severity, message: res.dmarc.advice.message });
      if (res.warmupLimit) {
        rows.push({
          severity: 'note',
          message: `This domain is still new, so around ${Number(res.warmupLimit).toLocaleString()} emails a day is a sensible ceiling for now. It rises on its own as the domain ages.`,
        });
      }

      const colour = (sev) => sev === 'blocker' ? 'text-red-700' : sev === 'warning' ? 'text-amber-700' : 'text-gray-600';
      slot.innerHTML = `<p class="text-sm font-bold text-gray-900 mb-2">How your sending is doing</p>
        <ul class="space-y-1.5">
          ${rows.map((r) => `<li class="text-sm ${colour(r.severity)}">${esc(r.message)}</li>`).join('')}
        </ul>
        <p class="text-[11px] text-gray-400 mt-2">Rates cover ${esc(res.window || 'recent sends')}.</p>`;
    } catch {
      // A failed health check must not make the sending setup look broken — the setup above it is
      // what the tenant came here for.
      slot.remove();
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

  // ── Welcome sequence ───────────────────────────────────────────────────────

  const SEQ_API = '/.netlify/functions/newsletter-sequences';
  let seqState = { sequence: null, steps: [], enrolments: {} };

  async function openWelcomeModal() {
    const modal = $('nl-welcome-modal');
    const body = $('nl-welcome-body');
    if (!modal || !body) return;
    show(modal, 'flex');
    body.innerHTML = '<p class="text-sm text-gray-500">Loading…</p>';
    try {
      const data = await api(SEQ_API);
      if (data.needsSetup) {
        body.innerHTML = '<p class="text-sm text-gray-600">Welcome sequences are not set up on this environment yet — the database migration has not been applied.</p>';
        return;
      }
      seqState = { sequence: data.sequence, steps: data.steps || [], enrolments: data.enrolments || {} };
      renderWelcome();
    } catch (err) {
      body.innerHTML = `<p class="text-sm text-red-600">${esc(err.message)}</p>`;
    }
  }

  function renderWelcome() {
    const body = $('nl-welcome-body');
    const seq = seqState.sequence;

    if (!seq) {
      body.innerHTML = `
        <div class="text-center py-8">
          <p class="text-sm text-gray-600 mb-1">You do not have a welcome sequence yet.</p>
          <p class="text-xs text-gray-400 mb-4">Right now a new subscriber hears nothing until your next issue.</p>
          <button type="button" id="nl-seq-create"
            class="px-4 py-2 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Create a welcome sequence</button>
        </div>`;
      $('nl-seq-create')?.addEventListener('click', async () => {
        try {
          const { sequence } = await api(SEQ_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'create' }),
          });
          seqState.sequence = sequence;
          renderWelcome();
        } catch (err) { window.showToast(err.message); }
      });
      return;
    }

    const active = Number(seqState.enrolments.active || 0);
    const completed = Number(seqState.enrolments.completed || 0);

    body.innerHTML = `
      <div class="flex items-center justify-between rounded-xl border border-gray-200 p-4 mb-4">
        <div>
          <span class="inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full border ${seq.isEnabled
            ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
            : 'bg-gray-100 text-gray-600 border-gray-200'}">${seq.isEnabled ? 'On' : 'Off'}</span>
          <p class="text-sm text-gray-600 mt-2">${seq.isEnabled
            ? `${active.toLocaleString()} part way through · ${completed.toLocaleString()} finished`
            : 'Nothing is sent while this is off. New subscribers are not enrolled either.'}</p>
        </div>
        <button type="button" id="nl-seq-toggle"
          class="px-4 py-2 text-sm font-bold rounded-lg cursor-pointer ${seq.isEnabled
            ? 'text-gray-700 bg-white border border-gray-300 hover:bg-gray-50'
            : 'text-white bg-emerald-600 hover:bg-emerald-700'}">${seq.isEnabled ? 'Switch off' : 'Switch on'}</button>
      </div>

      <div class="space-y-2 mb-4">
        ${seqState.steps.length ? seqState.steps.map((st) => `
          <div class="flex items-start gap-3 rounded-xl border border-gray-200 p-3">
            <div class="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-600 shrink-0">${st.stepNumber}</div>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-bold text-gray-900 truncate">${esc(st.subject)}</p>
              <p class="text-[11px] text-gray-500">${st.delayDays === 0 ? 'Straight away' : `${st.delayDays} day${st.delayDays === 1 ? '' : 's'} after the previous email`}</p>
            </div>
            <button type="button" data-seq-edit="${st.stepNumber}" class="text-xs font-bold text-emerald-700 hover:text-emerald-800 cursor-pointer">Edit</button>
            <button type="button" data-seq-delete="${st.stepNumber}" class="text-xs font-bold text-red-600 hover:text-red-700 cursor-pointer">Delete</button>
          </div>`).join('')
          : '<p class="text-sm text-gray-400 py-4 text-center">No emails yet. Add the first one below.</p>'}
      </div>

      <div class="rounded-xl border border-gray-200 p-4">
        <p class="text-sm font-bold text-gray-900 mb-3" id="nl-seq-form-title">Add an email</p>
        <input type="hidden" id="nl-seq-step-number" value="${seqState.steps.length + 1}">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div class="sm:col-span-2">
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Subject</label>
            <input type="text" id="nl-seq-subject" class="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm">
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Send after</label>
            <select id="nl-seq-delay" class="w-full px-3 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-700 focus:ring-2 focus:ring-emerald-600 outline-none cursor-pointer">
              <option value="0">Straight away</option>
              <option value="1">1 day</option>
              <option value="2">2 days</option>
              <option value="3">3 days</option>
              <option value="7">1 week</option>
              <option value="14">2 weeks</option>
            </select>
          </div>
        </div>
        <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Email</label>
        <textarea id="nl-seq-body" rows="8" class="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm font-mono"></textarea>
        <p class="text-[11px] text-gray-400 mt-1">Markdown. The unsubscribe line and your address are added automatically. Use {{contact.first_name | "there"}} to greet them by name.</p>
        <div class="flex justify-end gap-2 mt-3">
          <button type="button" id="nl-seq-cancel" class="hidden px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 cursor-pointer" style="display:none">Cancel</button>
          <button type="button" id="nl-seq-save" class="px-4 py-2 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Save email</button>
        </div>
      </div>`;

    body.querySelectorAll('[data-seq-edit]').forEach((btn) => btn.addEventListener('click', () => {
      const n = Number(btn.getAttribute('data-seq-edit'));
      const st = seqState.steps.find((x) => x.stepNumber === n);
      if (!st) return;
      $('nl-seq-form-title').textContent = `Edit email ${n}`;
      $('nl-seq-step-number').value = String(n);
      $('nl-seq-subject').value = st.subject || '';
      $('nl-seq-body').value = st.bodyMarkdown || '';
      $('nl-seq-delay').value = String(st.delayDays ?? 0);
      show($('nl-seq-cancel'), 'inline-flex');
      $('nl-seq-subject').focus();
    }));

    body.querySelectorAll('[data-seq-delete]').forEach((btn) => btn.addEventListener('click', async () => {
      const n = Number(btn.getAttribute('data-seq-delete'));
      const ok = await window.confirmModal(
        'Delete this email from the sequence? Anyone who has already received it keeps it — this only affects people who have not reached it yet.',
        { title: `Delete email ${n}?`, confirmLabel: 'Delete' });
      if (!ok) return;
      try {
        await api(SEQ_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'deleteStep', stepNumber: n }),
        });
        await openWelcomeModal();
      } catch (err) { window.showToast(err.message); }
    }));

    $('nl-seq-cancel')?.addEventListener('click', () => renderWelcome());

    $('nl-seq-save')?.addEventListener('click', async () => {
      try {
        await api(SEQ_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'saveStep',
            stepNumber: Number($('nl-seq-step-number').value || 1),
            subject: $('nl-seq-subject').value,
            bodyMarkdown: $('nl-seq-body').value,
            delayDays: Number($('nl-seq-delay').value || 0),
          }),
        });
        window.showToast('Saved.');
        await openWelcomeModal();
      } catch (err) { window.showToast(err.message); }
    });

    $('nl-seq-toggle')?.addEventListener('click', async () => {
      const turningOn = !seq.isEnabled;
      const ok = await window.confirmModal(
        turningOn
          ? 'From now on, everyone who confirms their subscription will receive these emails automatically, without anyone reading them again first.'
          : `Switch off the welcome sequence? ${active.toLocaleString()} ${active === 1 ? 'person is' : 'people are'} part way through and will not receive the rest.`,
        {
          title: turningOn ? 'Switch on the welcome sequence?' : 'Switch it off?',
          confirmLabel: turningOn ? 'Switch on' : 'Switch off',
          confirmColor: turningOn ? '#059669' : '#dc2626',
        });
      if (!ok) return;
      try {
        const res = await api(SEQ_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'enable', enabled: turningOn }),
        });
        if (res.note) window.showToast(res.note, { duration: 7000 });
        await openWelcomeModal();
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
    $('nl-welcome')?.addEventListener('click', openWelcomeModal);
    document.querySelectorAll('[data-nl-welcome-close]').forEach((el) => el.addEventListener('click', () => hide($('nl-welcome-modal'))));
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
