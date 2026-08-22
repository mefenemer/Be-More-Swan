// newsletter.js — the Newsletter Studio view controller (newsletter.html).
// IIFE like every other view controller: the router re-runs inline scripts on each view swap.
//
// TWO editors, one at a time, and plain Markdown is still the default. An email is not a web page:
// half the clients strip the styling a rich editor produces, so the thing worth investing in is the
// PREVIEW (what actually lands in an inbox). What changed is that "no layout at all" was not a
// choice either — a business that wants a picture and a button in its newsletter is not asking for
// much. So the Markdown box remains, and the Design Studio (src/components/newsletter-designer.js)
// is opted into per issue and can be left again without losing the words.
//
// ⚠️ The "before you send" findings are computed HERE, live, by the SAME module the server uses
// (src/public/newsletter-findings.js). They used to arrive only with the issue, so "there are only
// 0 words of text" sat under a finished draft until somebody reloaded the page.
(function () {

  const ISSUES_API = '/.netlify/functions/newsletter-issues';

  const esc = (s) => window.escapeHtml ? window.escapeHtml(s) : String(s ?? '');
  const $ = (id) => document.getElementById(id);

  // `hidden` loses to any utility that sets display, so every toggle touches both.
  function show(el, display = 'flex') { if (el) { el.classList.remove('hidden'); el.style.display = display; } }
  function hide(el) { if (el) { el.classList.add('hidden'); el.style.display = 'none'; } }

  const state = {
    issues: [], segments: [], customFields: [], sendTimezone: '', current: null, dirty: false,
    // Config the server owns — purposes and templates are not duplicated in the browser.
    purposes: [], templates: [],
    // The organisation's colours, resolved server-side from its brand kit (src/utils/brand-theme.ts)
    // and returned by the list GET. Null until the first load; the designer falls back to its own
    // default, which is what an org that has never set a brand gets anyway.
    brandTheme: null,
    // Who this Studio speaks for. ⚠️ Resolved once; '' records "we looked and there is no
    // Newsletter Assistant", so an org without one does not refetch on every issue.
    assistant: { id: null, name: null },
    // The design currently mounted, and its controller. Null = this issue is plain Markdown.
    designer: null,
    // A revision the assistant has offered and nobody has accepted. Never written to the server.
    revision: null,
  };

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

  // ── Naming the assistant on every button that asks it to do something ──────
  //
  // ⚠️ "The assistant" is nobody. The user hired this colleague, named it, and sees that name on
  // its detail page, in chat and on its calendar — and then the one surface where it does the
  // actual work called it "the assistant". Every label that refers to it carries
  // data-nl-assistant, and this is the only place that writes them.
  const ASSISTANT_LABELS = {
    draft: (n) => `Ask ${n} to draft`,
    improve: (n) => `Ask ${n} to improve`,
    name: (n) => n,
  };

  function assistantName() {
    return state.assistant.name || 'your assistant';
  }

  function applyAssistantNaming() {
    const name = assistantName();
    document.querySelectorAll('[data-nl-assistant]').forEach((el) => {
      const make = ASSISTANT_LABELS[el.getAttribute('data-nl-assistant')];
      if (make) el.textContent = make(name);
    });
  }

  /**
   * Who is writing. The Studio is a VIEW, so unlike Blog Studio it is not handed an assistant when
   * it opens — the detail page sets window._newsletterAssistantId on its way here, and a direct
   * visit to ?view=newsletter has nothing at all. Falling back to the org's first live Newsletter
   * Assistant means the buttons still name somebody real.
   *
   * ⚠️ It also decides who OWNS the issues this Studio creates. Without an assistantId a new issue
   * is invisible on the assistant's own Issues tab, which filters by it.
   */
  async function resolveAssistant() {
    const hinted = Number(window._newsletterAssistantId || 0) || null;
    if (state.assistant.name != null && state.assistant.id === hinted) { applyAssistantNaming(); return; }
    try {
      const res = await fetch('/.netlify/functions/get-assistants', { credentials: 'same-origin' });
      const data = res.ok ? await res.json() : { assistants: [] };
      const all = data.assistants || [];
      const pick = (hinted && all.find((a) => Number(a.id) === hinted))
        || all.find((a) => a.roleKey === 'newsletter_editor' && a.status !== 'archived')
        || null;
      state.assistant = { id: pick ? Number(pick.id) : null, name: pick ? (pick.name || '') : '' };
    } catch {
      // A failed lookup must not stop anybody writing a newsletter. '' means "asked, found none",
      // and every label falls back to "your assistant".
      state.assistant = { id: null, name: '' };
    }
    applyAssistantNaming();
  }

  // ── Load and render ────────────────────────────────────────────────────────

  async function loadIssues(selectId) {
    try {
      const { issues, segments, customFields, purposes, templates, brandTheme } = await api(ISSUES_API);
      state.issues = issues || [];
      state.segments = segments || [];
      state.customFields = customFields || [];
      state.purposes = purposes || [];
      state.templates = templates || [];
      // ⚠️ The organisation's colours, resolved by the server from its brand kit — the same answer
      // the server uses when IT mints a design. The browser must not compute its own: it used to
      // fall back to the designer's hardcoded default green, so a layout started here and a layout
      // started by the server disagreed about what colour the customer's newsletter is.
      if (brandTheme) state.brandTheme = brandTheme;
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
      const { issues, segments, customFields, purposes, templates, brandTheme } = await api(ISSUES_API);
      state.issues = issues || [];
      state.segments = segments || [];
      state.customFields = customFields || [];
      if (purposes) state.purposes = purposes;
      if (templates) state.templates = templates;
      if (brandTheme) state.brandTheme = brandTheme;
      renderList();
    } catch { /* the list is context, not the work — a failure here must not disturb the editor */ }
  }

  const findPurpose = (key) => state.purposes.find((p) => p.key === key)
    || state.purposes.find((p) => p.key === 'newsletter')
    || null;

  /** The kind-of-email chip. Nothing at all for an ordinary newsletter — that is the default, and a
   *  chip on every row that says "Newsletter" in a list of newsletters is noise. */
  function purposeChip(key) {
    const p = findPurpose(key);
    if (!p || p.key === 'newsletter') return '';
    return `<p class="mt-1"><span class="inline-flex px-1.5 py-0.5 text-[10px] font-bold rounded-full border ${esc(p.chipClass)}">${esc(p.label)}</span></p>`;
  }

  function renderList() {
    const list = $('nl-list');
    if (!list) return;
    const live = state.issues.filter((i) => i.status !== 'archived');
    if (!live.length) {
      list.innerHTML = `<li class="p-6 text-center text-sm text-gray-500">No issues yet. Start one and ${esc(assistantName())} can draft it for you.</li>`;
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
          ${purposeChip(i.purpose)}
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

  function insertVar(key) { insertVarInto($('nl-body'), key); scheduleSave(); }

  /** ⚠️ Takes the textarea: the sequence step editor has its own, and there must be one insert. */
  function insertVarInto(ta, key) {
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
    // ⚠️ Deliberately does NOT mark anything dirty: the sequence step editor shares this and has
    // its own Save. Each caller says which editor changed.
  }

  async function openIssue(id) {
    try {
      const { issue, audienceEstimate, sourcePost, resend, links, sendTimezone, scheduledForLocal, deliverability } = await api(`${ISSUES_API}?id=${encodeURIComponent(id)}`);
      state.current = issue;
      // ⚠️ Whatever was queued belonged to the issue being closed, and payload() reads
      // state.current — leaving the timer armed would write the old subject onto this issue.
      // The caller flushes BEFORE getting here; anything still pending is already stale.
      cancelPending();
      state.dirty = false;
      hide($('nl-empty'));
      show($('nl-editor'), 'block');

      $('nl-subject').value = issue.subject || '';
      $('nl-preheader').value = issue.preheader || '';
      $('nl-body').value = issue.bodyMarkdown || '';
      $('nl-segment').value = issue.segmentId ? String(issue.segmentId) : '';
      state.revision = null;
      hide($('nl-revision'));
      renderPurpose(issue);
      mountDesign(issue);
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
      // The server's findings are the starting point; every keystroke after this recomputes them
      // locally from the same module, so the panel never describes a draft that has moved on.
      renderDeliverability(issue, deliverability);
      renderWordCount();
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
      ['nl-generate', 'nl-improve', 'nl-approve', 'nl-send', 'nl-purpose',
        'nl-design-on', 'nl-design-off', 'nl-design-template'].forEach((k) => { const el = $(k); if (el) el.disabled = locked; });
      // ⚠️ The canvas is interactive HTML, so `disabled` means nothing to it. A sent issue's design
      // is unmounted entirely and shown as the plain prose it produced — a record, not an editor.
      if (locked && state.designer) { state.designer.destroy(); state.designer = null; hide($('nl-design-host')); show($('nl-body'), 'block'); $('nl-body').disabled = true; }
      // The same line carries both answers to "is my work safe?" — it cannot be edited, or it is
      // saved. Blank while nothing has been typed yet: "Saved" on an untouched issue is noise.
      if (locked) setSavedNote('This issue has been sent and can no longer be edited.');
      else setSavedNote('');

      renderList();
    } catch (err) {
      window.showToast(err.message);
    }
  }

  // ── Purpose ────────────────────────────────────────────────────────────────

  function renderPurpose(issue) {
    const btn = $('nl-purpose');
    if (!btn) return;
    const p = findPurpose(issue.purpose);
    if (!p) { hide(btn); return; }
    btn.textContent = p.label;
    btn.className = `inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full border cursor-pointer hover:brightness-95 ${p.chipClass}`;
    btn.title = `${p.description} Click to change what kind of email this is.`;
    show(btn, 'inline-flex');
  }

  async function changePurpose() {
    if (!state.current || !state.purposes.length) return;
    const chosen = await window.promptModal
      ? await pickFromList('What kind of email is this?', state.purposes.map((p) => ({
        value: p.key, label: p.label, description: p.description,
      })), state.current.purpose)
      : null;
    if (!chosen || chosen === state.current.purpose) return;
    try {
      const res = await api(ISSUES_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id: state.current.id, purpose: chosen }),
      });
      state.current = res.issue;
      renderPurpose(res.issue);
      await refreshList();
      // Said out loud, because it is the whole point of the setting and is otherwise invisible: the
      // purpose does not change a word of what is already written, only what happens next.
      window.showToast(`Saved. ${assistantName()} will write the next draft as ${findPurpose(chosen).label.toLowerCase()}.`);
    } catch (err) { window.showToast(err.message); }
  }

  /** A tiny radio-list dialog. Built here rather than in dialogs.js: it is the only caller. */
  function pickFromList(title, options, current) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'fixed inset-0 z-[60] flex items-center justify-center p-4';
      back.innerHTML = `<div class="absolute inset-0 bg-black/40"></div>
        <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 max-h-[85vh] overflow-auto">
          <h2 class="text-lg font-extrabold text-gray-900 mb-4">${esc(title)}</h2>
          <div class="space-y-2">${options.map((o) => `
            <button type="button" data-pick="${esc(o.value)}"
              class="w-full text-left px-3 py-2.5 rounded-xl border ${o.value === current ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 hover:bg-gray-50'} cursor-pointer">
              <p class="text-sm font-bold text-gray-900">${esc(o.label)}</p>
              <p class="text-xs text-gray-500 mt-0.5">${esc(o.description || '')}</p>
            </button>`).join('')}</div>
          <div class="flex justify-end mt-5">
            <button type="button" data-cancel class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 cursor-pointer">Cancel</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      const done = (v) => { back.remove(); resolve(v); };
      back.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      back.firstElementChild.addEventListener('click', () => done(null));
      back.querySelectorAll('[data-pick]').forEach((el) =>
        el.addEventListener('click', () => done(el.getAttribute('data-pick'))));
    });
  }

  // ── The design canvas ──────────────────────────────────────────────────────

  function mountDesign(issue) {
    const host = $('nl-design-host');
    const body = $('nl-body');
    if (state.designer) { state.designer.destroy(); state.designer = null; }

    const design = issue.design && Array.isArray(issue.design.blocks) && issue.design.blocks.length
      ? issue.design : null;

    if (!design || !window.NewsletterDesigner) {
      hide(host);
      show(body, 'block');
      show($('nl-design-on'), 'inline-flex');
      hide($('nl-design-off'));
      hide($('nl-design-template'));
      const note = $('nl-body-note');
      if (note) note.textContent = "Markdown. The unsubscribe line and your address are added automatically — don't write them here.";
      return;
    }

    hide(body);
    show(host, 'block');
    hide($('nl-design-on'));
    show($('nl-design-off'), 'inline-flex');
    show($('nl-design-template'), 'inline-flex');
    const note = $('nl-body-note');
    if (note) note.textContent = 'Click a block to edit it. What you see here is close — press Preview email to see exactly what will arrive.';

    state.designer = window.NewsletterDesigner.mount({
      host,
      design,
      defaultTheme: state.brandTheme || null,
      assistantName: assistantName(),
      onChange: () => {
        scheduleSave();
        // ⚠️ The word count and the findings read the DESIGN's prose now, not the textarea, or a
        // designed issue would report zero words while being full of them.
        renderWordCount();
        recomputeFindings();
      },
    });
  }

  /** The prose inside a design, mirroring designToMarkdown on the server closely enough to count. */
  function designProse(design) {
    if (!design || !Array.isArray(design.blocks)) return '';
    const one = (b) => {
      if (b.type === 'heading') return b.text || '';
      if (b.type === 'text') return b.markdown || '';
      if (b.type === 'button') return b.label || '';
      if (b.type === 'image') return b.caption || b.alt || '';
      if (b.type === 'columns') return [].concat(b.columns[0] || [], b.columns[1] || []).map(one).join('\n\n');
      return '';
    };
    return design.blocks.map(one).filter((t) => String(t).trim()).join('\n\n');
  }

  /** The counts the image-heavy and link-dense findings read, built the same way the server does. */
  function designHtmlHint(design) {
    if (!design || !Array.isArray(design.blocks)) return '';
    let images = 0, links = 0;
    const walk = (blocks) => blocks.forEach((b) => {
      if (b.type === 'columns') { walk(b.columns[0] || []); walk(b.columns[1] || []); return; }
      if (b.type === 'image') { if (b.assetId) images++; if (b.href) links++; return; }
      if (b.type === 'button') { if (b.href) links++; return; }
      if (b.type === 'text') links += (String(b.markdown || '').match(/\]\(\s*(https?:|mailto:)/gi) || []).length;
    });
    walk(design.blocks);
    return '<img>'.repeat(images) + '<a href="#"></a>'.repeat(links);
  }

  /** What the reader actually gets, whichever editor is in use. */
  function currentProse() {
    return state.designer ? designProse(state.designer.getDesign()) : ($('nl-body') ? $('nl-body').value : '');
  }

  function renderWordCount() {
    const el = $('nl-wordcount');
    if (!el) return;
    const n = window.NewsletterFindings
      ? window.NewsletterFindings.countWords(currentProse())
      : (currentProse().trim().match(/\S+/g) || []).length;
    el.textContent = `${n.toLocaleString()} ${n === 1 ? 'word' : 'words'}`;
  }

  /**
   * Re-run the structural findings against what is on screen right now.
   *
   * ⚠️ Only the STRUCTURAL ones. The warm-up finding depends on the size of the audience and the
   * age of the sending domain, neither of which this page can recompute — so it is carried over
   * from the last server answer rather than dropped, which would make a real warning flicker away
   * the moment somebody typed.
   */
  let serverOnlyFindings = [];
  function recomputeFindings() {
    if (!state.current || !window.NewsletterFindings) return;
    if (['sending', 'sent'].includes(state.current.status)) return;
    const design = state.designer ? state.designer.getDesign() : null;
    const findings = window.NewsletterFindings.contentFindings({
      subject: $('nl-subject') ? $('nl-subject').value : '',
      text: currentProse(),
      html: design ? designHtmlHint(design) : '',
    });
    paintDeliverability(window.NewsletterFindings.sortFindings(findings.concat(serverOnlyFindings)));
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
    localTimeSaver?.cancel();
    localTimeSaver = null;
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
          <span id="nl-local-status" class="ml-auto"></span>
        </div>
        <p id="nl-local-known" class="text-[11px] text-sky-700 mt-2"></p>` : ''}
    </div>`;

    // Turning the mode on or off changes the SHAPE of this panel, so those two re-render it. The
    // time itself does not, and must not — see saveSendMode.
    $('nl-local-on')?.addEventListener('change', async (e) => {
      localTimeSaver?.cancel();
      try {
        if (!e.target.checked) {
          await api(ISSUES_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sendTime', id: issue.id, mode: 'at_once' }),
          });
          await openIssue(issue.id);
          return;
        }
        await saveSendMode(issue, '09:00', true);
      } catch (err) { window.showToast(err.message); }
    });

    localTimeSaver = makeAutosaver({
      note: panelNote('nl-local-status'),
      write: () => {
        const t = $('nl-local-time') ? $('nl-local-time').value : '';
        if (!isWallClock(t)) return null;
        return saveSendMode(issue, t, false);
      },
    });
    $('nl-local-time')?.addEventListener('input', () => localTimeSaver.schedule());
    $('nl-local-time')?.addEventListener('change', () => localTimeSaver.now());
    $('nl-local-time')?.addEventListener('blur', () => localTimeSaver.flush());
  }

  /**
   * ⚠️ THROWS. The caller decides whether that is a toast (the checkbox) or the panel's own status
   * line (the time field) — swallowing it here is how a refused write becomes an invisible one.
   */
  async function saveSendMode(issue, localTime, reopen) {
    const res = await api(ISSUES_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sendTime', id: issue.id, mode: 'recipient_local', localTime }),
    });
    // ⚠️ ONLY when the panel changes shape. Re-opening the issue after a time change would replace
    // the input somebody is still typing into — which is exactly what the Save button used to make
    // safe, and what has to be handled some other way now there isn't one.
    if (reopen) await openIssue(issue.id);
    else if (state.current) {
      state.current.sendMode = 'recipient_local';
      state.current.sendLocalTime = localTime;
    }
    // ⚠️ The honest number, shown after saving rather than promised before it: on most lists we
    // know a timezone for a minority, and everyone else is sent at the sender's own time.
    const known = Number(res.knownTimezones || 0), total = Number(res.subscribers || 0);
    const el = $('nl-local-known');
    if (el) {
      el.textContent = total
        ? `We know a timezone for ${known.toLocaleString()} of your ${total.toLocaleString()} subscribers. The other ${(total - known).toLocaleString()} will get it at ${localTime} your time.`
        : '';
    }
    return res;
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
    abSaver?.cancel();
    abSaver = null;
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
        // is saved until there is a second subject line to save, and the issue's own state is what
        // the next load reads — so abandoning a half-opened form leaves no test behind.
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
        <span id="nl-ab-status" class="ml-auto"></span>
      </div>
      <p class="text-[11px] text-emerald-700 mt-2">Half the sample gets each subject. Whichever more people OPEN is sent to everyone held back — and if the difference is too small to mean anything, we say so and send the first one.</p>
      <!-- ⚠️ Painted, never toasted. With no Save button this writes while somebody types, and one
           toast per keystroke would bury the one thing worth reading here. -->
      <p id="nl-ab-warn" class="hidden text-[11px] font-bold text-amber-800 mt-2" style="display:none"></p>
    </div>`;

    $('nl-ab-off')?.addEventListener('click', async () => {
      abSaver?.cancel();
      try {
        await api(ISSUES_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'abTest', id: issue.id, enabled: false }),
        });
        await openIssue(issue.id);
      } catch (err) { window.showToast(err.message); }
    });

    abSaver = makeAutosaver({
      note: panelNote('nl-ab-status'),
      write: async () => {
        const subjectB = ($('nl-ab-subject') ? $('nl-ab-subject').value : '').trim();
        // ⚠️ Nothing is written until there IS a second subject line. The server refuses an empty
        // one, and a red refusal under a field nobody has filled in yet is not a message, it is
        // nagging somebody for not having finished typing.
        if (!subjectB) return null;
        const res = await api(ISSUES_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'abTest',
            id: issue.id,
            subjectB,
            samplePercent: Number($('nl-ab-percent').value),
            decideAfterHours: Number($('nl-ab-hours').value),
          }),
        });
        // The warning is the whole reason this returns anything: without a verified domain the test
        // cannot be decided, and that is worth knowing now rather than in four hours.
        const warn = $('nl-ab-warn');
        if (warn) {
          warn.textContent = res.warning || '';
          if (res.warning) show(warn, 'block'); else hide(warn);
        }
        // ⚠️ Patched in place, NOT re-opened. openIssue() re-runs renderAb, which replaces the
        // field being typed into — the reason this panel had a Save button.
        if (state.current) {
          state.current.abState = 'testing';
          state.current.subjectB = subjectB;
          state.current.abSamplePercent = Number($('nl-ab-percent').value);
          state.current.abDecideAfterHours = Number($('nl-ab-hours').value);
        }
        return res;
      },
    });
    $('nl-ab-subject')?.addEventListener('input', () => abSaver.schedule());
    $('nl-ab-subject')?.addEventListener('blur', () => abSaver.flush());
    // A picked value is a decision, not a burst of typing — there is nothing to debounce.
    ['nl-ab-percent', 'nl-ab-hours'].forEach((k) => $(k)?.addEventListener('change', () => abSaver.now()));
  }

  /**
   * Seed the panel from the server's answer, and remember the findings the browser cannot recompute.
   *
   * ⚠️ THE SPLIT MATTERS. Everything structural — the word count, the subject, how many pictures —
   * is recomputed here on every keystroke by the same module the server ran. The warm-up warning is
   * not: it depends on the audience size and how old the sending domain is, which this page does
   * not know. Dropping it on the first keystroke would make a real warning vanish as soon as
   * somebody started typing, which is precisely when they would stop believing the panel.
   */
  const STRUCTURAL_CODES = new Set([
    'subject_shouting', 'subject_punctuation', 'subject_long', 'subject_missing',
    'thin_text', 'image_heavy', 'link_dense',
  ]);

  function renderDeliverability(issue, findings) {
    const list = findings || [];
    serverOnlyFindings = list.filter((f) => !STRUCTURAL_CODES.has(f.code));
    if (['sending', 'sent'].includes(issue.status)) { hide($('nl-deliver')); return; }
    // Recomputed rather than painted as received: the fields on screen have already been filled in
    // by openIssue, so this is the same answer plus anything the server's copy was stale about.
    recomputeFindings();
  }

  function paintDeliverability(list) {
    const el = $('nl-deliver');
    if (!el) return;
    // Nothing to say is worth saying nothing about — an always-present empty panel trains people to
    // ignore the place the real warnings appear.
    if (!list || !list.length) { hide(el); return; }

    const worst = list[0].severity;
    const cls = worst === 'blocker' ? 'bg-red-50 border-red-200 text-red-900'
      : worst === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-900'
      : 'bg-gray-50 border-gray-200 text-gray-700';
    el.className = `mt-3 px-4 py-3 rounded-xl border text-sm ${cls}`;
    // ⚠️ NO FOOTNOTE UNDER THE LIST, and do not reinstate one. It used to end with a paragraph
    // explaining what these findings are not, and why no number is offered. All true — and an
    // answer to a question the reader had not asked: somebody looking at "your subject line is all
    // capitals" wants to fix the subject line, not to be told what we have decided not to build.
    // That reasoning belongs where it stops the next developer adding one, which is
    // src/public/newsletter-findings.js, and it is written out in full there.
    el.innerHTML = `<p class="font-bold mb-1">Before you send</p>
      <ul class="list-disc pl-5 space-y-1">
        ${list.map((f) => `<li>${esc(f.message)}</li>`).join('')}
      </ul>`;
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
    // ⚠️ EITHER a design OR body markdown, never both. When a design is mounted it is authoritative
    // and the server derives body_markdown from it (src/utils/newsletter-design.ts); sending the
    // stale textarea alongside it would overwrite the prose the blocks just produced.
    const design = state.designer ? state.designer.getDesign() : null;
    return {
      id: state.current.id,
      subject: $('nl-subject').value,
      preheader: $('nl-preheader').value,
      ...(design ? { design } : { bodyMarkdown: $('nl-body').value }),
      segmentId: Number($('nl-segment').value || '') || null,
      // Sent as typed. The server reads it in the issue's own zone — converting here would use
      // this browser's clock, which is the bug rather than the fix.
      scheduledFor: $('nl-schedule').value || null,
    };
  }

  /** The one write. Everything that saves goes through here — never `api(update)` directly. */
  async function save() {
    if (!state.current) return null;
    const res = await api(ISSUES_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', ...payload() }),
    });
    // The sidebar reads the stored row. It comes back with this response, so keep the list in step
    // from the answer we already have rather than a second GET per burst of typing — refreshList()
    // on every autosave would be one round trip a second while somebody writes a subject line.
    if (res.issue) {
      state.current = { ...state.current, ...res.issue };
      const i = state.issues.findIndex((x) => x.id === res.issue.id);
      if (i >= 0) state.issues[i] = { ...state.issues[i], ...res.issue };
      renderList();
    }
    setSavedNote('Saved');
    // The server drops approval when the words change. ⚠️ With no Save button this happens while
    // somebody types, so it is not enough to say it — the badge and the Send button have to STOP
    // describing an approved issue in the same tick, or the page keeps offering to send something
    // the server has already put back into draft.
    if (res.approvalCleared) {
      if (res.issue) renderStatusBadge(res.issue);
      hide($('nl-send'));
      window.showToast('Edited after approval, so this needs approving again.');
    }
    return res;
  }

  // ── Auto-save ──────────────────────────────────────────────────────────────
  //
  // ⚠️ THERE IS NO SAVE BUTTON. Every field in the editor writes itself back, which moves a job
  // that used to be the author's — press Save before you preview, before you approve, before you
  // click another issue — onto the code. Three rules make that safe:
  //
  //   · A short debounce, so a burst of typing is one write and not one per keystroke.
  //   · ONE write in flight at a time. Two overlapping updates can land out of order and leave
  //     the older text on the server, which is the failure nobody notices until it is sent.
  //   · flushPending() before anything that reads the STORED row — preview, approve, drafting,
  //     refining, sending, opening another issue. The server works from the row, not the screen,
  //     so "the debounce has not fired yet" would mean previewing the paragraph before last.
  //
  // A failed write leaves the issue dirty and SAYS SO. Clearing dirty on failure would mean the
  // next keystroke saves happily and the missing sentence never comes back.

  const AUTOSAVE_DELAY = 900;
  let autosaveTimer = null;
  let saving = null;
  let leaveWired = false;

  function setSavedNote(text, cls) {
    const el = $('nl-saved');
    if (!el) return;
    el.textContent = text;
    el.className = `text-xs ${cls || 'text-gray-400'}`;
  }

  /** An issue is open and the server would accept a write for it. A sent issue is a record. */
  function editable() {
    return !!state.current && !['sending', 'sent'].includes(state.current.status);
  }

  function cancelPending() { clearTimeout(autosaveTimer); autosaveTimer = null; }

  /** Something changed on screen. Called by every input, the designer, and the merge-tag chips. */
  function scheduleSave() {
    if (!editable()) return;
    state.dirty = true;
    setSavedNote('Saving…');
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => { autosaveTimer = null; runSave(); }, AUTOSAVE_DELAY);
  }

  /** The background writer. Never rejects — it reports failure in the note and a toast. */
  function runSave() {
    if (saving) return saving;
    saving = (async () => {
      try {
        // Loops rather than fires once: a keystroke landing mid-write sets dirty again, and that
        // edit must not sit until the next debounce.
        while (state.dirty && editable()) {
          state.dirty = false;
          try {
            await save();
          } catch (err) {
            state.dirty = true;
            setSavedNote('Not saved — we will try again.', 'text-amber-700 font-bold');
            window.showToast(err.message);
            return;
          }
        }
      } finally { saving = null; }
    })();
    return saving;
  }

  /**
   * Write anything outstanding, now, and let the caller know if it failed.
   *
   * ⚠️ This one THROWS. Preview, approve, draft and send all read the stored row, and running any
   * of them on top of a write that did not land is how somebody approves the previous draft.
   */
  async function flushPending() {
    cancelPending();
    if (saving) await saving;
    if (!state.dirty || !editable()) return;
    state.dirty = false;
    try {
      await save();
    } catch (err) {
      state.dirty = true;
      setSavedNote('Not saved — we will try again.', 'text-amber-700 font-bold');
      throw err;
    }
  }

  /** Flushing where nobody is waiting on the result — leaving a field, hiding the tab. */
  const backgroundFlush = () => flushPending().catch((err) => window.showToast(err.message));

  // ── Auto-save for the panels that write through their own action ───────────
  //
  // The issue editor above is one row and one payload, so it has one saver. The A/B test, the
  // send-time mode, the sending domain and a sequence step each POST a DIFFERENT server action with
  // its own validation, so each gets its own — but they all need the same three things: a debounce,
  // one write in flight, and somewhere to say what happened.
  //
  // ⚠️ Each keeps its OWN status line rather than sharing #nl-saved. A failure here is about that
  // panel ("the two subject lines are the same"), not about whether the issue is safe, and putting
  // the two in one place makes both unreadable.
  //
  // ⚠️ And none of them re-open the issue or re-render their own panel on a successful write, which
  // is the thing the Save buttons used to make safe: re-rendering replaces the input somebody is
  // still typing into. Only a change that alters the SHAPE of a panel re-renders it.

  /**
   * @param opts.write  Does the write and returns the response, or `null` for "not enough typed
   *                    yet" — a quiet state, not an error. Nothing else may call the endpoint.
   * @param opts.note   Paints the panel's status line.
   */
  function makeAutosaver(opts) {
    const delay = opts.delay || AUTOSAVE_DELAY;
    let timer = null;
    let inFlight = null;
    let dirty = false;
    const say = (text, tone) => { if (opts.note) opts.note(text, tone); };

    function run() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          // Loops for the same reason the issue editor's does: an edit landing mid-write must not
          // wait out another debounce.
          while (dirty) {
            dirty = false;
            let res;
            try {
              res = await opts.write();
            } catch (err) {
              // ⚠️ Left dirty so the next edit retries, and the message is the SERVER'S. On these
              // panels the refusal is the useful part — "the two subject lines are the same, so
              // there would be nothing to compare" is the whole feature talking.
              dirty = true;
              say(err.message, 'error');
              return;
            }
            if (res === null) say('', 'idle');
            else say(opts.savedNote ? opts.savedNote(res) : 'Saved', 'ok');
          }
        } finally { inFlight = null; }
      })();
      return inFlight;
    }

    return {
      schedule() {
        dirty = true;
        say('Saving…', 'busy');
        clearTimeout(timer);
        timer = setTimeout(() => { timer = null; run(); }, delay);
      },
      /**
       * Write NOW, whether or not a keystroke marked this dirty.
       *
       * ⚠️ For controls where the change IS the decision — a select, a time picker. `flush()` only
       * writes what is already outstanding, and a `change` event does not always arrive behind an
       * `input` one, so binding a select to flush() silently dropped the value it was picked for.
       */
      now() {
        dirty = true;
        clearTimeout(timer);
        timer = null;
        say('Saving…', 'busy');
        return run();
      },
      /** Write anything OUTSTANDING — leaving a field, closing the modal, hiding the tab. */
      flush() {
        clearTimeout(timer);
        timer = null;
        if (!dirty && !inFlight) return Promise.resolve();
        return run();
      },
      cancel() { clearTimeout(timer); timer = null; dirty = false; },
    };
  }

  /** The status line inside a panel. Three states everywhere: busy, saved, what went wrong. */
  function panelNote(id, cls) {
    return (text, tone) => {
      const el = $(id);
      if (!el) return;
      el.textContent = text || '';
      el.className = `text-[11px] ${cls || ''} ${tone === 'error' ? 'text-red-700 font-bold' : 'text-gray-500'}`;
    };
  }

  /** ⚠️ Cancelled when their panel re-renders, or a stale timer writes over the fresh form. */
  let abSaver = null;
  let localTimeSaver = null;
  let domainSaver = null;
  let seqSaver = null;

  /** Type=time reports '' until both halves are set — an unfinished time is not a value. */
  const isWallClock = (v) => /^\d{2}:\d{2}$/.test(String(v || ''));

  async function generate(topic, notes) {
    const go = $('nl-brief-go');
    if (go) { go.disabled = true; go.textContent = 'Writing…'; }
    try {
      // Save first: the server drafts from the stored row, so an unsaved subject would be ignored.
      await flushPending();
      const res = await api(ISSUES_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate', id: state.current.id, topic, notes,
          // The issue already carries its purpose; sending it makes the brief dialog's choice
          // authoritative for THIS run without a second round trip to save it first.
          purpose: state.current.purpose,
        }),
      });
      $('nl-subject').value = res.subject || '';
      $('nl-preheader').value = res.preheader || '';
      $('nl-body').value = res.bodyMarkdown || '';
      // Two different things arrive as `design`, and they need different handling:
      //  · the issue already HAD a layout — the server re-flowed the new copy into it, keeping the
      //    pictures and buttons where they were, so take its version rather than the one on screen;
      //  · the issue had none and the assistant DESIGNED one (src/utils/layout-ir.ts) — there is no
      //    canvas mounted yet, so mounting it is what makes the layout visible at all. Without this
      //    the author gets the derived Markdown in the textarea and never sees the layout they were
      //    just written.
      if (res.design) {
        if (state.current) state.current.design = res.design;
        if (state.designer) state.designer.setDesign(res.design);
        else if (state.current) mountDesign(state.current);
      }
      renderWarnings(res.warnings);
      renderWordCount();
      recomputeFindings();
      hide($('nl-brief-modal'));
      window.showToast(`Draft ready — read it before you approve it.`);
      // List only. Re-opening the issue here would replace the draft that was just written into
      // the fields, and would hide the warnings the author has not read yet.
      // ⚠️ The server wrote these words, so the fields already match the stored row — cancel the
      // debounce rather than letting it fire and write the same thing back.
      cancelPending();
      state.dirty = false;
      setSavedNote('Saved');
      await refreshList();
    } catch (err) {
      window.showToast(err.message);
    } finally {
      if (go) { go.disabled = false; go.textContent = 'Write the draft'; }
    }
  }

  // ── "Ask <name> to improve" ────────────────────────────────────────────────
  //
  // ⚠️ THE REVISION IS OFFERED, NOT APPLIED. The draft on screen is copy a person has read and
  // usually edited; a rewrite written straight over it is a change they cannot see and cannot undo,
  // and nobody re-reads a draft they have already read. So the server returns and this shows.

  const REFINE_MODES = [
    ['shorter', 'Make it shorter'],
    ['warmer', 'Make it warmer'],
    ['sharper', 'Make it clearer'],
    ['subject', 'Better subject line'],
    ['cta', 'Add a clear next step'],
  ];

  function openImprove() {
    if (!state.current) return;
    if (!currentProse().trim()) {
      window.showToast(`There is nothing written yet — ask ${assistantName()} to draft it first.`);
      return;
    }
    const title = $('nl-improve-title');
    if (title) title.textContent = `What should ${assistantName()} change?`;
    const host = $('nl-improve-modes');
    if (host) {
      host.innerHTML = REFINE_MODES.map(([key, label]) =>
        `<button type="button" data-nl-mode="${key}" class="px-3 py-1.5 text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 cursor-pointer">${esc(label)}</button>`).join('');
      host.querySelectorAll('[data-nl-mode]').forEach((el) =>
        el.addEventListener('click', () => refine(el.getAttribute('data-nl-mode'), '')));
    }
    $('nl-improve-text').value = '';
    show($('nl-improve-modal'), 'flex');
  }

  async function refine(mode, instruction) {
    if (!state.current) return;
    const go = $('nl-improve-go');
    if (go) { go.disabled = true; go.textContent = 'Thinking…'; }
    try {
      // Saved first, for the same reason drafting is: the server rewrites the STORED copy, so an
      // unsaved edit would be revised out of existence.
      await flushPending();
      const res = await api(ISSUES_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refine', id: state.current.id, mode, instruction }),
      });
      hide($('nl-improve-modal'));
      state.revision = res;
      renderRevision();
    } catch (err) {
      window.showToast(err.message);
    } finally {
      if (go) { go.disabled = false; go.textContent = 'Ask for the change'; }
    }
  }

  function renderRevision() {
    const el = $('nl-revision');
    if (!el) return;
    const r = state.revision;
    if (!r) { hide(el); return; }

    const subjectChanged = (r.subject || '') !== ($('nl-subject').value || '');
    el.innerHTML = `<div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-bold mb-1">${esc(assistantName())} suggests a change</p>
          <p>${esc(r.summary || 'Revised.')}</p>
        </div>
      </div>
      ${subjectChanged ? `<p class="mt-2 text-[12px]"><span class="font-bold">New subject:</span> ${esc(r.subject)}</p>` : ''}
      <details class="mt-2">
        <summary class="text-xs font-bold cursor-pointer">Read the whole thing first</summary>
        <pre class="mt-2 p-3 rounded-lg bg-white/70 border border-sky-200 text-[12px] whitespace-pre-wrap font-mono max-h-64 overflow-auto">${esc(r.bodyMarkdown || '')}</pre>
      </details>
      ${r.warnings && r.warnings.length
        ? `<ul class="list-disc pl-5 mt-2 text-[11px] space-y-0.5">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <div class="flex flex-wrap gap-2 mt-3">
        <button type="button" id="nl-rev-keep" class="px-3 py-1.5 text-xs font-bold text-white bg-sky-600 hover:bg-sky-700 rounded-lg cursor-pointer">Use this version</button>
        <button type="button" id="nl-rev-drop" class="px-3 py-1.5 text-xs font-bold text-sky-800 bg-white border border-sky-300 rounded-lg hover:bg-sky-50 cursor-pointer">Keep mine</button>
      </div>
      ${state.designer
        ? '<p class="text-[11px] text-sky-700 mt-2">Your pictures, buttons and spacing stay exactly where they are — only the words change.</p>' : ''}`;
    show(el, 'block');

    $('nl-rev-keep')?.addEventListener('click', async () => {
      const r2 = state.revision;
      if (!r2) return;
      $('nl-subject').value = r2.subject || $('nl-subject').value;
      $('nl-preheader').value = r2.preheader || $('nl-preheader').value;
      $('nl-body').value = r2.bodyMarkdown || '';
      try {
        // ⚠️ Sent as bodyMarkdown even when a design is mounted. The server re-flows it into the
        // layout (applyProseToDesign) — the browser must not attempt that itself, or the two would
        // disagree about where a paragraph belongs.
        const res = await api(ISSUES_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update', id: state.current.id,
            subject: $('nl-subject').value, preheader: $('nl-preheader').value,
            bodyMarkdown: r2.bodyMarkdown,
          }),
        });
        state.revision = null;
        hide($('nl-revision'));
        if (res.issue && res.issue.design && state.designer) state.designer.setDesign(res.issue.design);
        cancelPending();
        state.dirty = false;
        setSavedNote('Saved');
        renderWordCount();
        recomputeFindings();
        if (res.approvalCleared) window.showToast('Edited after approval, so this needs approving again.');
        else window.showToast('Applied.');
        await refreshList();
      } catch (err) { window.showToast(err.message); }
    });
    $('nl-rev-drop')?.addEventListener('click', () => { state.revision = null; hide($('nl-revision')); });
  }

  // ── Turning the layout on and off ──────────────────────────────────────────

  async function setDesign(mode, template) {
    if (!state.current) return;
    try {
      // Saved first so "convert" builds blocks from what is on screen, not from what was last saved.
      await flushPending();
      const res = await api(ISSUES_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'design', id: state.current.id, mode, template }),
      });
      state.current = res.issue;
      mountDesign(res.issue);
      $('nl-body').value = res.issue.bodyMarkdown || '';
      renderWordCount();
      recomputeFindings();
      if (res.issue.status === 'draft') renderStatusBadge(res.issue);
      window.showToast(mode === 'off' ? 'Back to plain text — your words are all still here.' : 'Ready to design.');
      await refreshList();
    } catch (err) { window.showToast(err.message); }
  }

  function renderStatusBadge(issue) {
    const st = STATUS[issue.status] || { label: issue.status, cls: 'bg-gray-100 text-gray-600 border-gray-200' };
    const badge = $('nl-status');
    if (!badge) return;
    badge.textContent = st.label;
    badge.className = `inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full border ${st.cls}`;
  }

  function openTemplateModal() {
    const host = $('nl-template-list');
    if (!host) return;
    host.innerHTML = state.templates.map((t) => `
      <button type="button" data-nl-tpl="${esc(t.key)}"
        class="text-left px-3 py-2.5 rounded-xl border border-gray-200 hover:border-emerald-400 hover:bg-emerald-50 cursor-pointer">
        <p class="text-sm font-bold text-gray-900">${esc(t.label)}</p>
        <p class="text-xs text-gray-500 mt-0.5">${esc(t.description)}</p>
      </button>`).join('');
    host.querySelectorAll('[data-nl-tpl]').forEach((el) => el.addEventListener('click', async () => {
      const ok = await window.confirmModal(
        'Everything currently in this email is replaced by the template. Your subject line and preview line are kept.',
        { title: 'Start again from this template?', confirmLabel: 'Replace it' });
      if (!ok) return;
      hide($('nl-template-modal'));
      await setDesign('template', el.getAttribute('data-nl-tpl'));
    }));
    show($('nl-template-modal'), 'flex');
  }

  // ── New issue ──────────────────────────────────────────────────────────────

  let newIssueChoice = { purpose: 'newsletter', template: '' };

  function openNewIssue() {
    newIssueChoice = { purpose: 'newsletter', template: '' };
    $('nl-new-subject').value = '';
    renderNewIssueChoices();
    show($('nl-newissue-modal'), 'flex');
    $('nl-new-subject').focus();
  }

  function renderNewIssueChoices() {
    const pHost = $('nl-new-purposes');
    const tHost = $('nl-new-templates');
    const tile = (active, title, sub, attr) => `
      <button type="button" ${attr}
        class="text-left px-3 py-2.5 rounded-xl border cursor-pointer ${active ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 hover:bg-gray-50'}">
        <p class="text-sm font-bold text-gray-900">${esc(title)}</p>
        <p class="text-xs text-gray-500 mt-0.5">${esc(sub)}</p>
      </button>`;

    if (pHost) {
      pHost.innerHTML = state.purposes.map((p) =>
        tile(newIssueChoice.purpose === p.key, p.label, p.description, `data-np="${esc(p.key)}"`)).join('');
      pHost.querySelectorAll('[data-np]').forEach((el) => el.addEventListener('click', () => {
        newIssueChoice.purpose = el.getAttribute('data-np');
        // The purpose SUGGESTS a layout rather than imposing one — a notice starts plain, an
        // announcement starts with a picture — and the author can override it in the row below.
        const p = state.purposes.find((x) => x.key === newIssueChoice.purpose);
        if (p && newIssueChoice.template) newIssueChoice.template = p.defaultTemplate;
        renderNewIssueChoices();
      }));
    }
    if (tHost) {
      const suggested = (state.purposes.find((x) => x.key === newIssueChoice.purpose) || {}).defaultTemplate;
      tHost.innerHTML = tile(!newIssueChoice.template, 'Plain text',
        'Just words, in Markdown. What the assistant writes, and what most newsletters should be.', 'data-nt=""')
        + state.templates.map((t) =>
          tile(newIssueChoice.template === t.key, t.label + (t.key === suggested ? ' · suggested' : ''), t.description, `data-nt="${esc(t.key)}"`)).join('');
      tHost.querySelectorAll('[data-nt]').forEach((el) => el.addEventListener('click', () => {
        newIssueChoice.template = el.getAttribute('data-nt');
        renderNewIssueChoices();
      }));
    }
  }

  async function createIssue() {
    const subject = ($('nl-new-subject').value || '').trim();
    if (!subject) { window.showToast('Give this issue a working subject line — it can be rewritten later.'); return; }
    const go = $('nl-new-go');
    if (go) { go.disabled = true; go.textContent = 'Creating…'; }
    try {
      const { issue } = await api(ISSUES_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          subject,
          purpose: newIssueChoice.purpose,
          template: newIssueChoice.template || undefined,
          // ⚠️ Without this the issue belongs to no assistant, and the Issues tab on the very page
          // the user came from — which filters by assistantId — would not show it.
          assistantId: state.assistant.id || undefined,
        }),
      });
      hide($('nl-newissue-modal'));
      await loadIssues(issue.id);
    } catch (err) {
      window.showToast(err.message);
    } finally {
      if (go) { go.disabled = false; go.textContent = 'Create'; }
    }
  }

  /**
   * Put a rendered email in the preview modal.
   *
   * ⚠️ A `data:` URL, NOT `srcdoc`, and do not change it back. The frame is fully sandboxed
   * (`sandbox` with no value — no scripts, no forms, no top-level navigation), and a sandboxed
   * frame is exactly the case where `srcdoc` is not reliably honoured: in Edge it left the iframe
   * laid out at the right size with no document in it, so the modal opened onto a white box. A
   * `data:` URL is an ordinary navigation to an always-opaque origin, so the isolation is the same
   * or stronger, and every browser loads it.
   *
   * It is also the more honest preview. `srcdoc` inherits the app's own URL as its base, so a
   * relative image src would quietly resolve here and break in the inbox — which is the one thing
   * this modal exists to catch. A `data:` URL has no base, so a relative src breaks in BOTH places.
   */
  function showPreview(html) {
    const frame = $('nl-preview-frame');
    if (frame) {
      // Nothing rendered is a real answer, not a blank screen to interpret: an issue whose blocks
      // are all still empty has nothing to show, and the modal should say so.
      const doc = (html && html.trim())
        ? html
        : `<!DOCTYPE html><html><body style="margin:0;padding:32px;font:15px/1.6 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#6b7280;background:#f6f7f9;text-align:center;">There is nothing to preview yet \u2014 this issue has no words in it.</body></html>`;
      frame.src = `data:text/html;charset=utf-8,${encodeURIComponent(doc)}`;
    }
    show($('nl-preview-modal'), 'flex');
  }

  async function preview() {
    if (!state.current) return;
    try {
      await flushPending();
      const res = await api(ISSUES_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', id: state.current.id }),
      });
      showPreview(res.html);
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
      await flushPending();
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
    domainSaver?.cancel();
    domainSaver = null;

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

      <div class="flex flex-wrap items-center justify-end gap-2 mt-6">
        <button type="button" id="nl-domain-remove" class="px-3 py-2 text-xs font-bold text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer">Remove</button>
        <span id="nl-domain-status" class="flex-1"></span>
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

    domainSaver = makeAutosaver({
      note: panelNote('nl-domain-status'),
      write: async () => {
        // The server strips everything but letters, numbers, dots, dashes and underscores, then
        // refuses what is left if it is empty. Mid-word that is a real state, not a mistake.
        const local = ($('nl-from-local') ? $('nl-from-local').value : '').replace(/[^a-z0-9._-]/gi, '');
        if (!local) return null;
        const res = await api(DOMAIN_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update', id: domain.id,
            fromName: $('nl-from-name') ? $('nl-from-name').value : '',
            fromLocalPart: local,
          }),
        });
        // ⚠️ NOT renderSending(res.domain) — that rebuilds this whole panel, including the field
        // being typed into. Keep the local copy in step instead; the next open reads the server.
        if (res.domain) { domain.fromName = res.domain.fromName; domain.fromLocalPart = res.domain.fromLocalPart; }
        return res;
      },
    });
    ['nl-from-name', 'nl-from-local'].forEach((k) => {
      $(k)?.addEventListener('input', () => domainSaver.schedule());
      $(k)?.addEventListener('blur', () => domainSaver.flush());
      $(k)?.addEventListener('change', () => domainSaver.flush());
    });

    $('nl-domain-remove')?.addEventListener('click', async () => {
      domainSaver?.cancel();
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
  // `editing` is the step form's own working copy — the design, and the revision waiting to be
  // accepted, live here rather than in the DOM so switching between steps cannot leak one into
  // the other.
  let seqState = {
    sequence: null, steps: [], enrolments: {},
    editing: { stepNumber: 1, design: null, revision: null },
    designer: null,
  };

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
      // ⚠️ Assign the fields rather than replacing the object: `editing` and `designer` carry the
      // step form's working copy, and a fresh literal here silently dropped a design somebody had
      // just built (openWelcomeModal is also how the modal reloads after every save).
      if (seqState.designer) { seqState.designer.destroy(); seqState.designer = null; }
      seqState.sequence = data.sequence;
      seqState.steps = data.steps || [];
      seqState.enrolments = data.enrolments || {};
      if (!seqState.editing) seqState.editing = { stepNumber: 1, design: null, revision: null };
      seqState.editing.stepNumber = seqState.steps.length + 1;
      seqState.editing.design = null;
      seqState.editing.revision = null;
      renderWelcome();
    } catch (err) {
      body.innerHTML = `<p class="text-sm text-red-600">${esc(err.message)}</p>`;
    }
  }

  /**
   * The list of emails in the sequence, on its own.
   *
   * ⚠️ Separate from renderWelcome() because the step editor autosaves: adding an email has to show
   * up in the list WITHOUT repainting the form underneath the person still writing it. Nothing here
   * may touch #nl-seq-step-number either — that is what decides whether the next write updates this
   * email or creates another one.
   */
  function renderSeqList() {
    const host = $('nl-seq-list');
    if (!host) return;
    host.innerHTML = seqState.steps.length ? seqState.steps.map((st) => `
      <div class="flex items-start gap-3 rounded-xl border border-gray-200 p-3">
        <div class="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-600 shrink-0">${st.stepNumber}</div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-bold text-gray-900 truncate">${esc(st.subject)}</p>
          <p class="text-[11px] text-gray-500">${st.delayDays === 0 ? 'Straight away' : `${st.delayDays} day${st.delayDays === 1 ? '' : 's'} after the previous email`}</p>
        </div>
        <button type="button" data-seq-edit="${st.stepNumber}" class="text-xs font-bold text-emerald-700 hover:text-emerald-800 cursor-pointer">Edit</button>
        <button type="button" data-seq-delete="${st.stepNumber}" class="text-xs font-bold text-red-600 hover:text-red-700 cursor-pointer">Delete</button>
      </div>`).join('')
      : '<p class="text-sm text-gray-400 py-4 text-center">No emails yet. Add the first one below.</p>';

    host.querySelectorAll('[data-seq-edit]').forEach((btn) => btn.addEventListener('click', async () => {
      const n = Number(btn.getAttribute('data-seq-edit'));
      // ⚠️ Flush BEFORE loading another step: the form is the only copy of what is typed into it,
      // and #nl-seq-step-number is about to point somewhere else.
      if (seqSaver) await seqSaver.flush();
      const st = seqState.steps.find((x) => x.stepNumber === n);
      if (!st) return;
      $('nl-seq-form-title').textContent = `Edit email ${n}`;
      $('nl-seq-step-number').value = String(n);
      $('nl-seq-subject').value = st.subject || '';
      $('nl-seq-preheader').value = st.preheader || '';
      $('nl-seq-body').value = st.bodyMarkdown || '';
      $('nl-seq-delay').value = String(st.delayDays ?? 0);
      seqState.editing = { stepNumber: n, design: st.design || null, revision: null };
      hide($('nl-seq-revision'));
      mountSeqDesign(st.design || null);
      renderSeqWordCount();
      recomputeSeqFindings();
      show($('nl-seq-cancel'), 'inline-flex');
      $('nl-seq-subject').focus();
    }));

    host.querySelectorAll('[data-seq-delete]').forEach((btn) => btn.addEventListener('click', async () => {
      const n = Number(btn.getAttribute('data-seq-delete'));
      const ok = await window.confirmModal(
        'Delete this email from the sequence? Anyone who has already received it keeps it — this only affects people who have not reached it yet.',
        { title: `Delete email ${n}?`, confirmLabel: 'Delete' });
      if (!ok) return;
      // ⚠️ Deleting the email that is open in the form: a queued write would recreate it a second
      // later. Any OTHER step's pending edit is still owed a save.
      if (seqSaver) {
        if (Number($('nl-seq-step-number').value || 0) === n) seqSaver.cancel();
        else await seqSaver.flush();
      }
      try {
        await api(SEQ_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'deleteStep', stepNumber: n }),
        });
        await openWelcomeModal();
      } catch (err) { window.showToast(err.message); }
    }));

  }

  function renderWelcome() {
    const body = $('nl-welcome-body');
    const seq = seqState.sequence;
    seqSaver?.cancel();
    seqSaver = null;

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
            // ⚠️ The assistant is recorded on the sequence, not looked up at send time: these
            // emails are drafted in its voice, and the org may hire a second one later.
            body: JSON.stringify({ action: 'create', assistantId: state.assistant.id || undefined }),
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

      <div class="space-y-2 mb-4" id="nl-seq-list"></div>

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

        <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Preview line</label>
        <input type="text" id="nl-seq-preheader" maxlength="200" placeholder="The line the inbox shows next to the subject"
          class="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm mb-3">

        <div class="flex items-center justify-between gap-2 mb-1">
          <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide">Email</label>
          <div class="flex items-center gap-1 flex-wrap justify-end" id="nl-seq-vars"></div>
        </div>
        <textarea id="nl-seq-body" rows="8" class="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm font-mono"></textarea>
        <div id="nl-seq-design-host" class="hidden" style="display:none"></div>

        <div class="flex items-center justify-between gap-3 mt-1 flex-wrap">
          <p class="text-[11px] text-gray-400">Markdown. The unsubscribe line and your address are added automatically.</p>
          <p id="nl-seq-wordcount" class="text-[11px] text-gray-400 shrink-0"></p>
        </div>

        <!-- ⚠️ The same findings an issue gets, on the email nobody will be watching when it sends. -->
        <div id="nl-seq-deliver" class="hidden mt-3 px-4 py-3 rounded-xl border text-sm" style="display:none"></div>
        <div id="nl-seq-revision" class="hidden mt-3 px-4 py-3 rounded-xl bg-sky-50 border border-sky-200 text-sm text-sky-900" style="display:none"></div>

        <div class="flex flex-wrap items-center gap-2 mt-3">
          <button type="button" id="nl-seq-generate" data-nl-assistant="draft"
            class="px-3 py-1.5 text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 cursor-pointer">Ask your assistant to draft</button>
          <button type="button" id="nl-seq-improve" data-nl-assistant="improve"
            class="px-3 py-1.5 text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 cursor-pointer">Ask your assistant to improve</button>
          <button type="button" id="nl-seq-design-on"
            class="px-3 py-1.5 text-xs font-bold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 cursor-pointer">Design this email</button>
          <button type="button" id="nl-seq-design-off"
            class="hidden px-3 py-1.5 text-xs font-bold text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 cursor-pointer" style="display:none">Back to plain text</button>
          <button type="button" id="nl-seq-preview"
            class="px-3 py-1.5 text-xs font-bold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 cursor-pointer">Preview email</button>
        </div>

        <div class="flex items-center justify-end gap-3 mt-3">
          <!-- ⚠️ Was "Cancel", and it cannot be any more: this form saves itself, so by the time
               somebody reaches this button the email is already in the sequence. It means "leave
               this one alone and start a new one", and it says that. Deleting is the row above. -->
          <span id="nl-seq-status" class="mr-auto"></span>
          <button type="button" id="nl-seq-cancel" class="hidden px-4 py-2 text-sm font-bold text-emerald-700 hover:text-emerald-800 cursor-pointer" style="display:none">Add another email</button>
        </div>
      </div>`;

    // Every label that names the assistant, including the two just rendered into this modal.
    applyAssistantNaming();
    renderSeqList();
    renderSeqVarChips();
    mountSeqDesign(seqState.editing.design);
    renderSeqWordCount();
    recomputeSeqFindings();

    $('nl-seq-cancel')?.addEventListener('click', async () => {
      if (seqSaver) await seqSaver.flush();
      seqState.editing = { stepNumber: seqState.steps.length + 1, design: null, revision: null };
      renderWelcome();
    });

    ['nl-seq-subject', 'nl-seq-body'].forEach((k) => {
      $(k)?.addEventListener('input', () => { renderSeqWordCount(); recomputeSeqFindings(); });
    });
    $('nl-seq-vars')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-var]');
      if (!btn) return;
      insertVarInto($('nl-seq-body'), btn.getAttribute('data-var'));
      seqSaver?.schedule();
    });

    $('nl-seq-generate')?.addEventListener('click', seqGenerate);
    $('nl-seq-improve')?.addEventListener('click', seqImprove);
    $('nl-seq-preview')?.addEventListener('click', seqPreview);
    $('nl-seq-design-on')?.addEventListener('click', () => {
      // Converts what is written, exactly as the issue editor does — nobody's words are discarded
      // to gain a layout.
      const md = $('nl-seq-body').value || '';
      const design = {
        version: 1, template: 'custom',
        // ⚠️ The org's colours, exactly as the server would build them for an issue converted the
        // same way. The designer's own DEFAULT_THEME is the last resort behind it, not the answer.
        theme: state.brandTheme
          || (window.NewsletterDesigner && window.NewsletterDesigner.DEFAULT_THEME)
          || {},
        blocks: blocksFromMarkdownClient(md),
      };
      seqState.editing.design = design;
      mountSeqDesign(design);
      seqSaver?.schedule();
      renderSeqWordCount();
      recomputeSeqFindings();
    });
    $('nl-seq-design-off')?.addEventListener('click', async () => {
      const ok = await window.confirmModal(
        'Your words are kept — the pictures, buttons and spacing are not.',
        { title: 'Go back to plain text?', confirmLabel: 'Back to plain text' });
      if (!ok) return;
      $('nl-seq-body').value = seqProse();
      seqState.editing.design = null;
      mountSeqDesign(null);
      seqSaver?.schedule();
      renderSeqWordCount();
      recomputeSeqFindings();
    });

    // ⚠️ This form CREATES as well as edits, so its autosave has a threshold rather than a
    // debounce alone: the server needs a subject and a body, and half a subject line typed into a
    // blank form is not an email somebody meant to add to a live welcome sequence. Below the
    // threshold nothing is written and nothing is complained about — walk away and there is no
    // step. Above it, the step exists from that moment on and the list says so.
    seqSaver = makeAutosaver({
      note: panelNote('nl-seq-status'),
      write: async () => {
        const subject = ($('nl-seq-subject') ? $('nl-seq-subject').value : '').trim();
        if (!subject || !seqProse().trim()) return null;
        const design = seqState.designer ? seqState.designer.getDesign() : null;
        const stepNumber = Number($('nl-seq-step-number').value || 1);
        const { step } = await api(SEQ_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'saveStep',
            stepNumber,
            subject,
            preheader: $('nl-seq-preheader').value,
            // Either/or, for the same reason an issue sends one or the other: the design is
            // authoritative when it exists, and the server derives the prose from it.
            ...(design ? { design } : { bodyMarkdown: $('nl-seq-body').value }),
            delayDays: Number($('nl-seq-delay').value || 0),
          }),
        });
        // ⚠️ The LIST only. openWelcomeModal() rebuilds the form, which would take the words out
        // from under whoever is writing them — and it would also renumber #nl-seq-step-number,
        // so the next keystroke would add a SECOND email instead of updating this one.
        if (step) {
          const i = seqState.steps.findIndex((x) => x.stepNumber === step.stepNumber);
          if (i >= 0) seqState.steps[i] = step; else seqState.steps.push(step);
          seqState.steps.sort((x, y) => x.stepNumber - y.stepNumber);
          renderSeqList();
        }
        // Now that this email exists, there is somewhere to go from here.
        show($('nl-seq-cancel'), 'inline-flex');
        return step || {};
      },
    });

    ['nl-seq-subject', 'nl-seq-preheader', 'nl-seq-body'].forEach((k) => {
      $(k)?.addEventListener('input', () => seqSaver.schedule());
      $(k)?.addEventListener('blur', () => seqSaver.flush());
    });
    $('nl-seq-delay')?.addEventListener('change', () => seqSaver.now());

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

  // ── The step editor's own copies of what the issue editor does ─────────────
  //
  // ⚠️ Same modules, same behaviour, deliberately. A welcome email is an email; the only real
  // difference is that nobody is watching when it sends, which argues for MORE of this, not less.

  function renderSeqVarChips() {
    const host = $('nl-seq-vars');
    if (!host) return;
    host.innerHTML = allVars().map((v) => `<button type="button" data-var="${esc(v.key)}"
      class="px-2 py-1 text-[11px] font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer">+ ${esc(v.label)}</button>`).join('');
  }

  function seqProse() {
    return seqState.designer ? designProse(seqState.designer.getDesign()) : ($('nl-seq-body') ? $('nl-seq-body').value : '');
  }

  function renderSeqWordCount() {
    const el = $('nl-seq-wordcount');
    if (!el) return;
    const n = window.NewsletterFindings
      ? window.NewsletterFindings.countWords(seqProse())
      : (seqProse().trim().match(/\S+/g) || []).length;
    el.textContent = `${n.toLocaleString()} ${n === 1 ? 'word' : 'words'}`;
  }

  function recomputeSeqFindings() {
    const el = $('nl-seq-deliver');
    if (!el || !window.NewsletterFindings) return;
    const design = seqState.designer ? seqState.designer.getDesign() : null;
    const list = window.NewsletterFindings.sortFindings(window.NewsletterFindings.contentFindings({
      subject: $('nl-seq-subject') ? $('nl-seq-subject').value : '',
      text: seqProse(),
      html: design ? designHtmlHint(design) : '',
    }));
    if (!list.length) { hide(el); return; }
    const worst = list[0].severity;
    el.className = `mt-3 px-4 py-3 rounded-xl border text-sm ${worst === 'blocker' ? 'bg-red-50 border-red-200 text-red-900'
      : worst === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-900'
      : 'bg-gray-50 border-gray-200 text-gray-700'}`;
    el.innerHTML = `<p class="font-bold mb-1">Before you switch this on</p>
      <ul class="list-disc pl-5 space-y-1">${list.map((f) => `<li>${esc(f.message)}</li>`).join('')}</ul>`;
    show(el, 'block');
  }

  function mountSeqDesign(design) {
    const host = $('nl-seq-design-host');
    const body = $('nl-seq-body');
    if (seqState.designer) { seqState.designer.destroy(); seqState.designer = null; }
    if (!host || !body) return;

    const live = design && Array.isArray(design.blocks) && design.blocks.length ? design : null;
    if (!live || !window.NewsletterDesigner) {
      hide(host); show(body, 'block');
      show($('nl-seq-design-on'), 'inline-flex'); hide($('nl-seq-design-off'));
      return;
    }
    hide(body); show(host, 'block');
    hide($('nl-seq-design-on')); show($('nl-seq-design-off'), 'inline-flex');
    seqState.editing.design = live;
    seqState.designer = window.NewsletterDesigner.mount({
      host, design: live, defaultTheme: state.brandTheme || null, assistantName: assistantName(),
      onChange: () => { seqSaver?.schedule(); renderSeqWordCount(); recomputeSeqFindings(); },
    });
  }

  /**
   * Markdown → blocks, in the browser.
   *
   * ⚠️ A knowing duplicate of blocksFromMarkdown in src/utils/newsletter-design.ts, and the ONLY
   * one: an issue converts on the server (it has a row to update), a sequence step has no row until
   * it is saved, so the conversion has to happen here. Kept to the same three rules — headings,
   * rules, paragraph groups — because a step designed here and re-opened after a save must not
   * rearrange itself.
   */
  function blocksFromMarkdownClient(markdown) {
    const src = String(markdown || '').replace(/\r\n/g, '\n');
    const out = [];
    let buffer = [];
    const bid = () => `b_${Math.random().toString(36).slice(2, 10)}`;
    const flush = () => {
      const text = buffer.join('\n').trim();
      buffer = [];
      if (text) out.push({ id: bid(), type: 'text', markdown: text, align: 'left' });
    };
    src.split('\n').forEach((line) => {
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) { flush(); out.push({ id: bid(), type: 'heading', text: h[2].trim(), level: h[1].length, align: 'left' }); return; }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flush(); out.push({ id: bid(), type: 'divider' }); return; }
      if (!line.trim() && buffer.length) { flush(); return; }
      if (line.trim() || buffer.length) buffer.push(line);
    });
    flush();
    // An empty step still needs something to click on, or "Design this email" produces a blank box.
    return out.length ? out : [{ id: bid(), type: 'text', markdown: 'Start writing.', align: 'left' }];
  }

  async function seqGenerate() {
    const btn = $('nl-seq-generate');
    if (btn) { btn.disabled = true; btn.textContent = 'Writing…'; }
    try {
      const res = await api(SEQ_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate',
          stepNumber: Number($('nl-seq-step-number').value || 1),
          delayDays: Number($('nl-seq-delay').value || 0),
          notes: $('nl-seq-body').value,
          // ⚠️ A step being written has no row yet, so the server cannot read its layout from
          // anywhere but here. With it, the new copy flows INTO the layout (pictures and buttons
          // stay put); without it, the assistant is free to design one.
          design: (seqState.designer && seqState.designer.getDesign()) || seqState.editing.design || null,
        }),
      });
      // The subject is only overwritten when the author has not written one — they usually have,
      // and it is the field they are most attached to.
      if (!($('nl-seq-subject').value || '').trim()) $('nl-seq-subject').value = res.subject || '';
      if (!($('nl-seq-preheader').value || '').trim()) $('nl-seq-preheader').value = res.preheader || '';
      $('nl-seq-body').value = res.bodyMarkdown || '';
      // Two things arrive as `design`, exactly as on the issue editor: the layout this step already
      // had with the new copy re-flowed into it, or a layout the assistant designed for a step that
      // had none. The second needs a canvas mounting — without it the author gets the derived
      // Markdown in the textarea and never sees the email they were just written.
      //
      // ⚠️ What used to be here rebuilt the blocks from the Markdown in the BROWSER, which deleted
      // every picture and button in the step. The server re-flows now (applyProseToDesign), so take
      // its answer rather than making our own.
      if (res.design) {
        seqState.editing.design = res.design;
        if (seqState.designer) seqState.designer.setDesign(res.design);
        else mountSeqDesign(res.design);
      }
      if (res.warnings && res.warnings.length) window.showToast(res.warnings[0], { duration: 8000 });
      seqSaver?.schedule();
      renderSeqWordCount();
      recomputeSeqFindings();
      window.showToast('Drafted — read it before you switch the sequence on.');
    } catch (err) {
      window.showToast(err.message);
    } finally {
      if (btn) { btn.disabled = false; applyAssistantNaming(); }
    }
  }

  async function seqImprove() {
    if (!seqProse().trim()) { window.showToast(`There is nothing written yet — ask ${assistantName()} to draft it first.`); return; }
    const instruction = await window.promptModal(
      `What should ${assistantName()} change? For example: make it shorter, warmer, or add a clear next step.`,
      { title: 'Ask for a change', placeholder: 'Make it shorter and warmer', confirmLabel: 'Ask' });
    if (!instruction) return;
    const btn = $('nl-seq-improve');
    if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
    try {
      const res = await api(SEQ_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'refine',
          mode: 'custom',
          instruction,
          subject: $('nl-seq-subject').value,
          preheader: $('nl-seq-preheader').value,
          bodyMarkdown: seqProse(),
          // So the server can flow the revision into the layout instead of the browser rebuilding
          // it — see the draft path above.
          design: (seqState.designer && seqState.designer.getDesign()) || seqState.editing.design || null,
        }),
      });
      seqState.editing.revision = res;
      renderSeqRevision();
    } catch (err) {
      window.showToast(err.message);
    } finally {
      if (btn) { btn.disabled = false; applyAssistantNaming(); }
    }
  }

  function renderSeqRevision() {
    const el = $('nl-seq-revision');
    const r = seqState.editing.revision;
    if (!el) return;
    if (!r) { hide(el); return; }
    el.innerHTML = `<p class="font-bold mb-1">${esc(assistantName())} suggests a change</p>
      <p>${esc(r.summary || 'Revised.')}</p>
      <details class="mt-2"><summary class="text-xs font-bold cursor-pointer">Read the whole thing first</summary>
        <pre class="mt-2 p-3 rounded-lg bg-white/70 border border-sky-200 text-[12px] whitespace-pre-wrap font-mono max-h-64 overflow-auto">${esc(r.bodyMarkdown || '')}</pre>
      </details>
      <div class="flex flex-wrap gap-2 mt-3">
        <button type="button" id="nl-seq-rev-keep" class="px-3 py-1.5 text-xs font-bold text-white bg-sky-600 hover:bg-sky-700 rounded-lg cursor-pointer">Use this version</button>
        <button type="button" id="nl-seq-rev-drop" class="px-3 py-1.5 text-xs font-bold text-sky-800 bg-white border border-sky-300 rounded-lg hover:bg-sky-50 cursor-pointer">Keep mine</button>
      </div>
      <p class="text-[11px] text-sky-700 mt-2">Choosing a version saves it. Keeping yours changes nothing.</p>`;
    show(el, 'block');

    $('nl-seq-rev-keep')?.addEventListener('click', () => {
      $('nl-seq-subject').value = r.subject || $('nl-seq-subject').value;
      $('nl-seq-preheader').value = r.preheader || $('nl-seq-preheader').value;
      $('nl-seq-body').value = r.bodyMarkdown || '';
      // ⚠️ The server flowed the revision into the layout, keeping the pictures and buttons where
      // the author put them. Rebuilding the blocks from the Markdown here — which is what this used
      // to do — deleted every one of them.
      if (r.design) {
        seqState.editing.design = r.design;
        if (seqState.designer) seqState.designer.setDesign(r.design);
      }
      seqState.editing.revision = null;
      hide(el);
      seqSaver?.schedule();
      renderSeqWordCount();
      recomputeSeqFindings();
    });
    $('nl-seq-rev-drop')?.addEventListener('click', () => { seqState.editing.revision = null; hide(el); });
  }

  async function seqPreview() {
    try {
      const design = seqState.designer ? seqState.designer.getDesign() : null;
      const res = await api(SEQ_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'preview',
          preheader: $('nl-seq-preheader').value,
          ...(design ? { design } : { bodyMarkdown: $('nl-seq-body').value }),
        }),
      });
      showPreview(res.html);
    } catch (err) { window.showToast(err.message); }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  function wire() {
    // ⚠️ A dialog rather than a one-line prompt. Two decisions belong at creation because both get
    // harder afterwards: what KIND of email this is (it changes how the assistant is briefed) and
    // whether it has a layout (adding one later means re-flowing the copy).
    $('nl-new')?.addEventListener('click', openNewIssue);
    $('nl-new-go')?.addEventListener('click', createIssue);
    document.querySelectorAll('[data-nl-newissue-close]').forEach((el) => el.addEventListener('click', () => hide($('nl-newissue-modal'))));
    $('nl-new-subject')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') createIssue(); });

    $('nl-list')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-issue]');
      if (!btn) return;
      // ⚠️ Flush BEFORE switching, and do not switch if the flush failed. payload() reads
      // state.current, so a pending write has to land against the issue it was typed into — and
      // moving off an issue whose last edit never reached the server loses it silently.
      try { await flushPending(); }
      catch (err) { window.showToast(err.message); return; }
      openIssue(Number(btn.getAttribute('data-issue')));
    });

    $('nl-vars')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-var]');
      if (btn) insertVar(btn.getAttribute('data-var'));
    });

    // Every field that payload() sends. Typing debounces; leaving a field writes immediately,
    // because clicking from the subject line straight into Preview must not outrun the timer.
    ['nl-subject', 'nl-preheader', 'nl-body', 'nl-segment', 'nl-schedule'].forEach((k) => {
      $(k)?.addEventListener('input', scheduleSave);
      // nl-segment has its own change handler (it re-asks for the audience estimate) and flushes
      // there — a second listener would write the same row twice.
      // ⚠️ scheduleSave() first: a `change` does not always arrive behind an `input`, and
      // flushPending() only writes what is already outstanding — binding a picker straight to it
      // drops the value it was picked for.
      if (k !== 'nl-segment') $(k)?.addEventListener('change', () => { scheduleSave(); backgroundFlush(); });
      $(k)?.addEventListener('blur', () => { backgroundFlush(); });
    });
    // The two inputs the findings actually read. Recomputed on every keystroke — see
    // recomputeFindings for why the warm-up warning is carried over rather than recomputed.
    ['nl-subject', 'nl-body'].forEach((k) => {
      $(k)?.addEventListener('input', () => { renderWordCount(); recomputeFindings(); });
    });

    $('nl-purpose')?.addEventListener('click', changePurpose);
    // "Design this email" CONVERTS: it keeps every word and adds structure around it. Starting from
    // a template is the other button, and it says out loud that it replaces things.
    $('nl-design-on')?.addEventListener('click', () => setDesign('convert'));
    $('nl-design-template')?.addEventListener('click', openTemplateModal);
    $('nl-design-off')?.addEventListener('click', async () => {
      const ok = await window.confirmModal(
        'Your words are kept — the pictures, buttons and spacing are not. You can design it again afterwards, but the layout will have to be rebuilt.',
        { title: 'Go back to plain text?', confirmLabel: 'Back to plain text' });
      if (ok) await setDesign('off');
    });
    document.querySelectorAll('[data-nl-template-close]').forEach((el) => el.addEventListener('click', () => hide($('nl-template-modal'))));

    $('nl-improve')?.addEventListener('click', openImprove);
    $('nl-improve-go')?.addEventListener('click', () => {
      const text = ($('nl-improve-text').value || '').trim();
      if (!text) { window.showToast('Say what you would like changed, or pick one of the buttons.'); return; }
      refine('custom', text);
    });
    document.querySelectorAll('[data-nl-improve-close]').forEach((el) => el.addEventListener('click', () => hide($('nl-improve-modal'))));

    $('nl-segment')?.addEventListener('change', async () => {
      // Re-ask the server rather than counting locally: the number depends on contact status,
      // which this page does not hold.
      try {
        state.dirty = true;
        await flushPending();
        const { audienceEstimate } = await api(`${ISSUES_API}?id=${encodeURIComponent(state.current.id)}`);
        renderAudience(audienceEstimate);
      } catch { /* the estimate is a nicety; a failure here must not block editing */ }
    });

    $('nl-preview')?.addEventListener('click', preview);
    $('nl-send')?.addEventListener('click', sendNow);
    $('nl-sending')?.addEventListener('click', openSendingModal);
    $('nl-welcome')?.addEventListener('click', openWelcomeModal);
    // ⚠️ Flush on the way out. Closing a modal is the one moment these forms lose their only copy
    // of what was typed, and there is no Save button left to have caught it on the way past.
    document.querySelectorAll('[data-nl-welcome-close]').forEach((el) => el.addEventListener('click', () => {
      if (seqSaver) seqSaver.flush();
      hide($('nl-welcome-modal'));
    }));
    document.querySelectorAll('[data-nl-sending-close]').forEach((el) => el.addEventListener('click', () => {
      if (domainSaver) domainSaver.flush();
      hide($('nl-sending-modal'));
    }));
    $('nl-approve')?.addEventListener('click', approve);

    $('nl-generate')?.addEventListener('click', () => {
      $('nl-brief-topic').value = '';
      $('nl-brief-notes').value = '';
      show($('nl-brief-modal'), 'flex');
    });
    document.querySelectorAll('[data-nl-brief-close]').forEach((el) => el.addEventListener('click', () => hide($('nl-brief-modal'))));
    $('nl-brief-go')?.addEventListener('click', () => generate($('nl-brief-topic').value, $('nl-brief-notes').value));

    document.querySelectorAll('[data-nl-preview-close]').forEach((el) => el.addEventListener('click', () => hide($('nl-preview-modal'))));

    // ── Leaving before the debounce fires ────────────────────────────────────
    //
    // ⚠️ Registered ONCE, not per wire(). wire() runs on every view swap, and a listener added
    // each time would send the same write four times over on the fourth visit.
    //
    // Hiding the tab is an ordinary flush — there is time for a response. Closing the page is not,
    // so that one rides `keepalive`: the request outlives the document and nobody reads the answer.
    if (!leaveWired) {
      leaveWired = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden') return;
        backgroundFlush();
        [abSaver, localTimeSaver, domainSaver, seqSaver].forEach((sv) => { if (sv) sv.flush(); });
      });
      window.addEventListener('pagehide', () => {
        [abSaver, localTimeSaver, domainSaver, seqSaver].forEach((sv) => { if (sv) sv.flush(); });
        if (!state.dirty || !editable()) return;
        cancelPending();
        state.dirty = false;
        fetch(ISSUES_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update', ...payload() }),
          keepalive: true,
        }).catch(() => { /* the page is going; there is nowhere to report this */ });
      });
    }
  }

  window.initNewsletter = async function initNewsletter() {
    state.current = null;
    // The view was swapped out and back: nothing on the new page belongs to the old issue.
    cancelPending();
    state.dirty = false;
    state.revision = null;
    if (state.designer) { state.designer.destroy(); state.designer = null; }
    wire();
    renderVarChips();
    // Not awaited before the list loads — the labels read "your assistant" for a fraction of a
    // second rather than the whole page waiting on a lookup that only changes wording.
    resolveAssistant();
    // Deep link from the Review Queue ("Open in Studio"). Consumed on read so a later visit to the
    // Studio does not silently reopen an issue the user has moved on from.
    const wanted = window._newsletterInitialIssueId;
    window._newsletterInitialIssueId = null;
    await loadIssues(wanted || undefined);
  };
})();
