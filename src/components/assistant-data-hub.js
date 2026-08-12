/**
 * src/components/assistant-data-hub.js
 *
 * Internal Data Hub (Golden Rule 2) — the role-specific "lightweight local
 * database" tab on assistant-detail.html. Reads the hubTab config from
 * assistant-dashboard-registry.js and renders assistant_records
 * (netlify/functions/assistant-records.ts) as a browsable table:
 *
 *   • columns come from hubTab.columns; keys resolve against the record
 *     envelope (title/status/updatedAt) or dot-paths into record.data
 *     (arrays render as counts, e.g. 'fields' → "4")
 *   • expanding a row re-renders the record's stored uiElement with the SAME
 *     DisruptiveUIRegistry renderer the chat transcript used — CSV-imported
 *     rows (no uiElement shape) fall back to a key/value list
 *   • per-type extras: meetings get a check-off-able action-item list,
 *     invoices get "Mark chased" (both persisted via PATCH), tickets get
 *     "Copy drafted reply"
 *   • Import CSV (SpreadsheetImport → bulk POST) and Export CSV (?format=csv)
 *     make the tab the Spreadsheet Fallback for users without an integration.
 *
 * Usage (assistants.js → _applyDashboardRegistry):
 *   window.AssistantDataHub.init({ hub, assistantId });
 *
 * Every record value is stored data from LLM output or a user CSV: treat as
 * untrusted, escape everything interpolated into HTML.
 */
(function () {
  'use strict';

  const API = '/.netlify/functions/assistant-records';

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

  // ── Where a record stands in the approval gate ──────────────────────────────
  // `label` is the banner above an open record; `short` is the table cell, where the full sentence
  // would push every other column off a laptop screen. Both name the same state — a cell that says
  // "Awaiting you" and a banner that says "Awaiting your approval" must never be able to disagree
  // about WHICH state, which is why they share one table.
  //
  // ⚠️ The copy is lead-flavoured ("Chase set" is the chase reminder a lead gets after its outreach
  // goes out). Only the Leads hub lists this column today; a role adding it would want its own
  // wording for `scheduled`, which means something different everywhere else.
  const APPROVAL_CHIP = {
    pending_approval: { label: 'Awaiting your approval', short: 'Awaiting you', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    approved: { label: 'Approved', short: 'Approved', cls: 'bg-green-50 text-green-700 border-green-100' },
    scheduled: { label: 'Approved · chase reminder set', short: 'Chase set', cls: 'bg-green-50 text-green-700 border-green-100' },
    rejected: { label: 'Rejected', short: 'Rejected', cls: 'bg-gray-100 text-gray-500 border-gray-200' },
  };

  // ── Can this lead actually be reached? ──────────────────────────────────────
  // Outreach is email-only, so a lead with no address cannot be worked at all — and until now it
  // sat in the list looking exactly like one that could. Measured reality: tier-1 enrichment hits
  // roughly 3 in 10 UK SMB sites, and most rows are never attempted, so this is the majority state
  // of the table rather than an edge case.
  //
  // ⚠️ Deliberately NOT a yes/no. "We looked and the site publishes nothing" and "nobody has
  // looked" are different facts with different remedies — the first sends you off to find an
  // address by hand, the second says the lead scored cold and the problem is TARGETING, not
  // scraping. Collapsing them to "No" would hide the more useful of the two.
  const CONTACT_CHIP = {
    role: { short: 'Role inbox', cls: 'bg-green-50 text-green-700 border-green-100' },
    personal: { short: 'Named person', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    none: { short: 'None found', cls: 'bg-red-50 text-red-700 border-red-200' },
    checking: { short: 'Checking…', cls: 'bg-blue-50 text-blue-800 border-blue-200' },
    unchecked: { short: 'Not checked', cls: 'bg-gray-100 text-gray-500 border-gray-200' },
  };

  /** The address on a lead, or null. Same precedence the Review Queue's recipient line uses. */
  function contactEmailOf(record) {
    const v = record.data && record.data.contactEmail;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  /**
   * Which of the five states a lead is in, derived entirely from what the record already carries.
   *
   * `enrichAttemptedAt` is the load-bearing key: `recordEnrichment` (process-discovery-jobs.ts)
   * mirrors it across on a MISS as well as a hit, so a blank address plus a stamp means the site
   * was read and publishes nothing — "go and find one by hand" — while a blank address with no
   * stamp means nobody has looked.
   *
   * Which of the two no-stamp readings applies comes from the RATING, because that is exactly the
   * rule the pipeline runs: `enrichBatch` scrapes `rating IN ('hot','warm')` only. A cold lead is
   * therefore never going to be attempted (the fix is TARGETING, not scraping); a hot/warm one is
   * queued for it.
   *
   * ⚠️ `enrichAttemptedAt` reaches older records only via db/backfill-enrich-attempted.sql. Until
   * that has run, an already-enriched lead that came back empty reads "Checking…" instead of
   * "None found" — which is why the SQL applies BEFORE this ships.
   *
   * ⚠️ "Checking…" also covers a run that DIED before its enrichment stage, where nothing is
   * actually in progress. Accepted: the Searches tab is the surface that owns run health and says
   * "Last run failed" with a Run again button, so the truth is one tab away rather than absent.
   */
  function contactState(record) {
    const d = record.data || {};
    if (contactEmailOf(record)) return d.emailKind === 'personal' ? 'personal' : 'role';
    if (d.enrichAttemptedAt) return 'none';
    return record.status === 'cold' ? 'unchecked' : 'checking';
  }

  // Resolve a hubTab column key against a record: envelope fields first, then a
  // dot-path into record.data. Arrays read as counts.
  function cellValue(record, key) {
    if (key === 'title') return record.title;
    if (key === 'status') return record.status ?? '—';
    // Records predating the approval gate carry no status at all — an em-dash, never a guess.
    if (key === 'approvalStatus') return APPROVAL_CHIP[record.approvalStatus]?.short ?? '—';
    if (key === 'contact') return CONTACT_CHIP[contactState(record)].short;
    if (key === 'updatedAt') return fmtDate(record.updatedAt);
    let v = record.data;
    for (const part of String(key).split('.')) {
      if (v === null || v === undefined || typeof v !== 'object') { v = undefined; break; }
      v = v[part];
    }
    if (key.toLowerCase().endsWith('at')) return fmtDate(v);
    if (Array.isArray(v)) return String(v.length);
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
  }

  const state = { hub: null, assistantId: null, records: [], pendingFocusId: null };

  async function fetchRecords() {
    // Content Library (social/blog Data Hub) reads posts, not assistant_records.
    if (state.hub.kind === 'content_library') { state.records = await fetchContentLibrary(); return; }
    const res = await fetch(`${API}?assistantId=${state.assistantId}&recordType=${encodeURIComponent(state.hub.recordType)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load records.');
    state.records = data.records || [];
  }

  // ── Content Library (kind: 'content_library') ───────────────────────────────
  // The social/blog Data Hub: every post this assistant has produced, across the whole
  // lifecycle. Mapped into the same record envelope the table renders, so no table changes
  // are needed. Approval/scheduling are NOT done here — they live in the Review Queue / Calendar.
  const LIBRARY_STATUSES = ['draft', 'pending_approval', 'approved', 'scheduled', 'published', 'failed', 'rejected'];

  function postToRecord(p) {
    return {
      id: p.id,
      title: String(p.caption || '').trim().slice(0, 80) || '(untitled post)',
      status: p.status,
      updatedAt: p.publishedAt || p.publishDate || p.generatedAt,
      // cellValue resolves the 'platform' column via record.data.platform.
      data: { ...p },
    };
  }

  function blogToRecord(b) {
    return {
      id: b.id,
      title: b.title || '(untitled post)',
      status: b.status,
      updatedAt: b.updatedAt || b.scheduledFor || b.publishedAt || b.createdAt,
      data: { ...b },
    };
  }

  async function fetchContentLibrary() {
    if (state.hub.source === 'blog_posts') {
      // blog-posts.ts now scopes the list by assistantId server-side.
      const res = await fetch(`/.netlify/functions/blog-posts?assistantId=${state.assistantId}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not load posts.');
      return (data.posts || []).map(blogToRecord);
    }
    // social_drafts: get-social-drafts filters by a single status, so fetch the lifecycle set
    // in parallel and merge (dedupe by id — a post is only ever in one status).
    const batches = await Promise.all(LIBRARY_STATUSES.map(async (s) => {
      try {
        const res = await fetch(`/.netlify/functions/get-social-drafts?status=${s}&assistantId=${state.assistantId}`);
        if (!res.ok) return [];
        return (await res.json()).drafts || [];
      } catch { return []; }
    }));
    const byId = new Map();
    for (const arr of batches) for (const p of arr) byId.set(p.id, p);
    return [...byId.values()]
      .sort((a, b) => new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0))
      .map(postToRecord);
  }

  async function patchRecord(id, patch) {
    const res = await fetch(API, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not update the record.');
    return data;
  }

  // ── Import (Spreadsheet Fallback) ───────────────────────────────────────────
  // Which CSV column becomes the record title, per row: first match against the
  // usual naming suspects, else the first column.
  const TITLE_HEADERS = ['title', 'name', 'lead', 'lead name', 'company', 'client', 'client name', 'clientname', 'subject', 'record', 'meeting title', 'meeting', 'customer'];

  function pickTitleHeader(headers) {
    const lower = headers.map((h) => h.toLowerCase());
    for (const candidate of TITLE_HEADERS) {
      const i = lower.indexOf(candidate);
      if (i !== -1) return headers[i];
    }
    return headers[0];
  }

  async function importCsv(file, statusEl) {
    const { headers, rows } = await window.SpreadsheetImport.fromFile(file);
    const titleHeader = pickTitleHeader(headers);
    const records = rows
      .map((row) => ({ title: row[titleHeader], status: 'imported', data: row }))
      .filter((r) => r.title);
    if (records.length === 0) throw new Error(`No usable rows — the "${titleHeader}" column is empty.`);

    statusEl.textContent = `Importing ${records.length} row${records.length === 1 ? '' : 's'}…`;
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: state.assistantId,
        recordType: state.hub.recordType,
        source: 'csv_import',
        records,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Import failed.');
    return data;
  }

  // ── Expanded-row rendering ──────────────────────────────────────────────────

  function keyValueFallback(data) {
    const entries = Object.entries(data && typeof data === 'object' ? data : {})
      .filter(([k, v]) => k !== 'type' && (v === null || typeof v !== 'object') && String(v ?? '').trim() !== '');
    const dl = document.createElement('dl');
    dl.className = 'grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3';
    dl.innerHTML = entries.map(([k, v]) => `
      <div>
        <dt class="text-xs font-bold text-gray-400 uppercase tracking-wide">${esc(k)}</dt>
        <dd class="text-sm text-gray-900 mt-0.5 whitespace-pre-line">${esc(v)}</dd>
      </div>`).join('') || '<p class="text-sm text-gray-500">No details stored for this record.</p>';
    return dl;
  }

  // ── Deal outcome (Phase 4.5) ────────────────────────────────────────────────
  // Marking a lead won/lost is what gives the revenue ledger its terminal events — the only rows
  // carrying `outcome`, and the entire input to the Strategy Agent's win-rate aggregate. Before
  // this control existed nothing in the product could produce one.
  //
  // The vocabularies come from window.RevenueConstants (generated from src/config/revenue-events.ts
  // by scripts/gen-client-constants.ts) rather than being retyped here: they are CHECK-constrained
  // server-side, and recordEvent() swallows its errors, so a drifted copy would fail invisibly.

  // Why the approval state is stated twice — in the list AND on the open record. Until 2026-08-06
  // the Leads table showed Lead / Score / Rating / Next step / Updated, so a pending lead, an
  // approved one and a rejected one were pixel-identical in the list. That is what made the Review
  // tab look like a duplicate of this one: it shows the SAME rows, filtered to the one state the
  // list could not express. The column answers "which of these still need me?" at a glance; the
  // banner answers "what am I looking at?" once a record is open, and is what gives the Reject
  // button below a visible effect without a full re-render.

  /** The approval chip for a lead. `data-hub-approval` so a reject can swap it without a re-render. */
  function approvalBanner(record) {
    const s = APPROVAL_CHIP[record.approvalStatus];
    const wrap = document.createElement('div');
    wrap.className = 'mb-3';
    wrap.setAttribute('data-hub-approval', '');
    if (s) {
      wrap.innerHTML = `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${s.cls}">${esc(s.label)}</span>`;
    }
    return wrap;
  }

  /** Colour + label for a recorded outcome. Only classes already compiled into style.css. */
  function outcomeChipClass(outcome) {
    if (outcome === 'won') return 'bg-green-50 text-green-700 border-gray-200';
    if (outcome === 'lost') return 'bg-red-50 text-red-700 border-red-200';
    return 'bg-amber-50 text-amber-700 border-amber-200';   // disqualified
  }

  /** The banner shown above a decided lead's detail. Returns null when no outcome is recorded. */
  function outcomeBanner(record) {
    const d = record.data && record.data.dealOutcome;
    if (!d || !d.outcome) return null;
    const RC = window.RevenueConstants;
    const label = RC ? RC.outcomeLabel(d.outcome) : String(d.outcome);
    const reason = d.lossReason ? (RC ? RC.lossReasonLabel(d.lossReason) : String(d.lossReason)) : '';
    const bits = [];
    if (reason) bits.push(esc(reason));
    if (d.valueGbp != null) bits.push('£' + esc(Number(d.valueGbp).toLocaleString('en-GB')));
    // A null cycle time is normal, not missing data: it means nothing was ever sent to this lead,
    // so there is no sales cycle to measure. Say that rather than showing "0 days".
    if (d.cycleDays != null) bits.push(esc(d.cycleDays) + (Number(d.cycleDays) === 1 ? ' day' : ' days') + ' to close');
    else bits.push('never contacted');
    if (d.at) bits.push('recorded ' + esc(fmtDate(d.at)));

    const wrap = document.createElement('div');
    wrap.className = 'mb-4 flex flex-wrap items-center gap-2';
    wrap.innerHTML = `
      <span class="text-xs font-bold px-2 py-0.5 rounded-full border ${outcomeChipClass(d.outcome)}">${esc(label)}</span>
      <span class="text-xs text-gray-500">${bits.join(' · ')}</span>`;
    return wrap;
  }

  /**
   * Record (or correct) a lead's deal outcome.
   *
   * Two server rules are mirrored here so the form cannot submit something the server will refuse:
   * lost/disqualified need a reason, and only a win takes a value. The server enforces both
   * regardless — this only decides which fields are shown.
   */
  function openOutcomeModal(record) {
    const RC = window.RevenueConstants;
    if (!RC) { window.showToast?.('Outcome options failed to load — refresh the page.'); return; }
    const existing = (record.data && record.data.dealOutcome) || null;

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100">
          <div>
            <h3 class="text-lg font-bold text-gray-900">Record outcome</h3>
            <p class="text-xs text-gray-500 mt-0.5">${esc(record.title || 'This lead')}</p>
          </div>
          <button type="button" data-oc-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer">&times;</button>
        </div>
        <form data-oc-form class="p-5 space-y-4">
          ${existing && existing.outcome ? `
            <div class="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p class="text-xs font-bold text-amber-700">Already marked ${esc(RC.outcomeLabel(existing.outcome))}</p>
              <p class="text-xs text-amber-700 mt-1">Recording a different outcome keeps both in the history — the most recent one counts.</p>
            </div>` : ''}

          <div>
            <span class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">What happened?</span>
            <div class="flex flex-wrap gap-2" data-oc-outcomes>
              ${RC.outcomes.map((o) => `
                <button type="button" data-oc-outcome="${esc(o)}"
                  class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 text-xs font-bold rounded-lg transition">${esc(RC.outcomeLabel(o))}</button>`).join('')}
            </div>
          </div>

          <label class="block" data-oc-reason-wrap hidden>
            <span class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Why?</span>
            <select name="lossReason" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-400">
              <option value="">Choose a reason…</option>
              ${RC.lossReasons.map((r) => `<option value="${esc(r)}">${esc(RC.lossReasonLabel(r))}</option>`).join('')}
            </select>
            <span class="block text-xs text-gray-400 mt-1">Fixed list on purpose — it's what makes "why are we losing?" answerable.</span>
          </label>

          <label class="block" data-oc-value-wrap hidden>
            <span class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Deal value (optional)</span>
            <input type="number" name="valueGbp" min="0" step="0.01" placeholder="e.g. 4800"
              class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-400">
            <span class="block text-xs text-gray-400 mt-1">In £. Leave blank if you'd rather not say.</span>
          </label>

          <p class="hidden text-xs font-semibold" data-oc-status></p>
          <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" data-oc-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 rounded-lg cursor-pointer">Cancel</button>
            <button type="submit" data-oc-submit disabled
              class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Save outcome</button>
          </div>
        </form>
      </div>`;

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-oc-close]').forEach((b) => b.addEventListener('click', close));

    const form = overlay.querySelector('[data-oc-form]');
    const status = overlay.querySelector('[data-oc-status]');
    const submit = overlay.querySelector('[data-oc-submit]');
    const reasonWrap = overlay.querySelector('[data-oc-reason-wrap]');
    const valueWrap = overlay.querySelector('[data-oc-value-wrap]');
    let chosen = null;

    // `hidden` loses to a class that sets display (these wrappers are `block`), so pin
    // style.display as well — the same trap that left an empty badge dot on the Review Queue tab.
    const setShown = (el, on) => { el.hidden = !on; el.style.display = on ? 'block' : 'none'; };
    setShown(reasonWrap, false);
    setShown(valueWrap, false);

    overlay.querySelector('[data-oc-outcomes]').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-oc-outcome]');
      if (!btn) return;
      chosen = btn.getAttribute('data-oc-outcome');
      overlay.querySelectorAll('[data-oc-outcome]').forEach((b) => {
        const on = b === btn;
        b.className = on
          ? 'px-3 py-1.5 bg-emerald-700 border border-emerald-700 text-white text-xs font-bold rounded-lg transition'
          : 'px-3 py-1.5 bg-white border border-gray-200 text-gray-700 text-xs font-bold rounded-lg transition';
      });
      setShown(reasonWrap, RC.needsLossReason(chosen));
      setShown(valueWrap, chosen === 'won');
      if (!RC.needsLossReason(chosen)) form.elements.lossReason.value = '';
      if (chosen !== 'won') form.elements.valueGbp.value = '';
      submit.disabled = false;
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!chosen) return;
      const lossReason = form.elements.lossReason.value || '';
      if (RC.needsLossReason(chosen) && !lossReason) {
        status.textContent = 'Pick a reason so this counts toward "why are we losing?".';
        status.className = 'block text-xs font-semibold text-red-600';
        return;
      }
      const rawValue = form.elements.valueGbp.value;
      submit.disabled = true;
      status.textContent = 'Saving…';
      status.className = 'block text-xs font-semibold text-gray-500';

      const post = (confirmChange) => fetch('/.netlify/functions/lead-generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set_outcome',
          assistantId: state.assistantId,
          recordId: record.id,
          outcome: chosen,
          ...(lossReason ? { lossReason } : {}),
          ...(chosen === 'won' && rawValue !== '' ? { valueGbp: Number(rawValue) } : {}),
          ...(confirmChange ? { confirmChange: true } : {}),
        }),
      });

      try {
        let res = await post(false);
        let data = await res.json().catch(() => ({}));

        // 409: an outcome is already recorded. The server refuses by default so a double-click
        // cannot leave one lead counted as both won and lost — confirming is a deliberate act.
        if (res.status === 409 && data.needsConfirmation) {
          const RCl = RC.outcomeLabel(data.currentOutcome);
          const ok = window.confirm(
            `This lead is already marked ${RCl}.\n\n`
            + `Recording "${RC.outcomeLabel(chosen)}" instead keeps both in the history — the most recent one is what counts.\n\n`
            + 'Change it?'
          );
          if (!ok) { close(); return; }
          res = await post(true);
          data = await res.json().catch(() => ({}));
        }
        if (!res.ok) throw new Error(data.error || 'Could not record the outcome.');

        record.data = { ...(record.data || {}), dealOutcome: data.dealOutcome };
        close();
        renderTable();
        const halted = Number(data.sequencesHalted) || 0;
        window.showToast?.(
          `Outcome recorded: ${RC.outcomeLabel(chosen)}.`
          + (halted ? ` Follow-up emails stopped.` : '')
        );
      } catch (err) {
        submit.disabled = false;
        status.textContent = err.message || 'Could not record the outcome.';
        status.className = 'block text-xs font-semibold text-red-600';
      }
    });

    document.body.appendChild(overlay);
  }

  /** Delete one record and drop it from the table. Shared by the plain and lead delete paths. */
  async function deleteRecord(id, reason) {
    const res = await fetch(API, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(reason ? { id, reason } : { id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not delete the record.');
    state.records = state.records.filter((r) => r.id !== id);
    renderTable();
    return data;
  }

  // ── Deleting a lead, and not throwing away what it taught us ────────────────
  //
  // ⚠️ This strip asks BEFORE the delete, which is the opposite of rejectReasonStrip below, and
  // the difference is forced rather than stylistic. `discovered_leads.assistant_record_id` is
  // ON DELETE SET NULL, and recordLeadRejection() resolves the lead, campaign and domain BY that
  // id — so a reason collected after the row is gone can never be attributed to anything.
  //
  // Why it matters: on a prod assistant, 21 of 35 discovered leads had been deleted by hand. Every
  // one of them was a junk hit (podcasts, news articles, job boards) — which is to say every one
  // was evidence that the search was aimed wrong, and all of it was discarded by the button that
  // makes the mess disappear fastest. Reject captures that evidence; Delete captured nothing. The
  // fix is not to remove Delete but to stop it being the silent option.
  function deleteReasonStrip(record) {
    const RC = window.RevenueConstants;
    const strip = document.createElement('div');
    strip.className = 'w-full mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2';
    const reasons = (RC && Array.isArray(RC.leadRejectReasons)) ? RC.leadRejectReasons : [];
    const chip = 'px-2 py-1 text-[11px] font-bold rounded-lg bg-white border border-gray-200 text-gray-700 hover:border-red-300 hover:text-red-800 transition cursor-pointer';

    strip.innerHTML = `
      <p class="text-[11px] font-bold text-gray-800">Delete ${esc(record.title || 'this lead')}?</p>
      <p class="text-[11px] text-gray-600 mb-2">This removes it for good. If the problem is that the search shouldn’t have found it, <strong>Reject</strong> keeps the record and tells future searches what to avoid.</p>
      ${reasons.length ? `<div class="flex flex-wrap gap-1.5">
        ${reasons.map((r) => `<button type="button" class="${chip}" data-hub-del-reason="${esc(r)}">${esc(RC.leadRejectReasonLabel(r))}</button>`).join('')}
      </div>
      <p class="text-[11px] text-gray-500 mt-1.5">Pick a reason to delete it and record what the search got wrong.</p>` : ''}
      <div class="flex flex-wrap items-center gap-2 mt-2">
        <button type="button" class="px-2 py-1 text-[11px] font-bold rounded-lg bg-white border border-red-200 text-red-700 hover:bg-red-100 transition cursor-pointer" data-hub-del-plain>Delete without a reason</button>
        <button type="button" class="px-2 py-1 text-[11px] font-bold rounded-lg text-gray-500 hover:text-gray-700 transition cursor-pointer" data-hub-del-cancel>Cancel</button>
      </div>
      <p class="hidden text-[11px] font-semibold mt-1.5" data-hub-del-status></p>`;

    const status = strip.querySelector('[data-hub-del-status]');
    strip.querySelector('[data-hub-del-cancel]').addEventListener('click', () => strip.remove());

    const go = async (reason) => {
      strip.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      status.classList.remove('hidden');
      status.className = 'text-[11px] font-semibold text-gray-500 mt-1.5';
      status.textContent = 'Deleting…';
      try {
        await deleteRecord(record.id, reason);
      } catch (err) {
        strip.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        status.className = 'text-[11px] font-semibold text-red-600 mt-1.5';
        status.textContent = err.message || 'Could not delete that lead.';
      }
    };

    strip.addEventListener('click', (e) => {
      const chosen = e.target.closest('[data-hub-del-reason]');
      if (chosen) { go(chosen.getAttribute('data-hub-del-reason')); return; }
      if (e.target.closest('[data-hub-del-plain]')) go(undefined);
    });
    return strip;
  }

  // ── Rejecting a lead, and saying why ────────────────────────────────────────
  //
  // ⚠️ Reject and "Record outcome → Disqualified" are NOT the same act, and offering only the
  // latter here was the reason they got confused:
  //
  //   • Reject answers "this should never have been found" — a fault in the TARGETING. It clears
  //     the approval gate (nothing is emailed) and its reason feeds lead_reject_feedback, which
  //     the rejection-cluster proposer reads to argue the search is aimed wrong.
  //   • Disqualified answers "we pursued this and it went nowhere" — a fault in the DEAL. It is a
  //     revenue outcome sitting alongside won/lost, and its reason is a LOSS reason.
  //
  // Using Disqualified for a bad discovery hit puts a dead deal in the revenue numbers for a
  // company nobody ever contacted, and files the complaint where no targeting change can read it.
  //
  // The strip below is the same capture the Review Queue offers (_rqShowRejectReasonStrip in
  // assistants.js), deliberately duplicated rather than shared: that one lives in the Review
  // Queue's own render cycle and anchors to an `[data-rq-record]` card that does not exist on this
  // screen. Both post the same `record_reject_feedback` action, which is where the rule lives.
  function rejectReasonStrip(record) {
    const RC = window.RevenueConstants;
    const strip = document.createElement('div');
    strip.className = 'w-full mt-2 rounded-lg border border-gray-200 bg-white px-3 py-2';
    if (!RC || !Array.isArray(RC.leadRejectReasons)) {
      // Constants failed to load. The REJECTION already committed, so say what did and didn't
      // happen rather than implying the whole action failed.
      strip.innerHTML = '<p class="text-[11px] font-semibold text-gray-500">Rejected. The reason options couldn’t load — refresh the page to add one.</p>';
      return strip;
    }

    const chip = 'px-2 py-1 text-[11px] font-bold rounded-lg bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 transition cursor-pointer';
    strip.innerHTML = `
      <p class="text-[11px] font-bold text-gray-700">Why wasn’t ${esc(record.title || 'this lead')} a fit?</p>
      <p class="text-[11px] text-gray-500 mb-2">Optional. It’s already rejected — this records what the search got wrong.</p>
      <div class="flex flex-wrap gap-1.5">
        ${RC.leadRejectReasons.map((r) => `<button type="button" class="${chip}" data-hub-reason="${esc(r)}">${esc(RC.leadRejectReasonLabel(r))}</button>`).join('')}
        <button type="button" class="px-2 py-1 text-[11px] font-bold rounded-lg text-gray-400 hover:text-gray-600 transition cursor-pointer" data-hub-reason-skip>Skip</button>
      </div>
      <p class="hidden text-[11px] font-semibold mt-1.5" data-hub-reason-status></p>`;

    const status = strip.querySelector('[data-hub-reason-status]');
    strip.querySelector('[data-hub-reason-skip]').addEventListener('click', () => strip.remove());
    strip.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-hub-reason]');
      if (!btn) return;
      strip.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      status.classList.remove('hidden');
      status.textContent = 'Saving…';
      status.className = 'text-[11px] font-semibold text-gray-500 mt-1.5';
      try {
        const res = await fetch('/.netlify/functions/lead-generation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            action: 'record_reject_feedback',
            assistantId: state.assistantId,
            recordId: record.id,
            reason: btn.getAttribute('data-hub-reason'),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not save that.');
        // canExcludeDomain is the SERVER's verdict — it needs both the reason vocabulary and the
        // discovery provenance, and the browser has neither. A hand-added lead has no search to
        // exclude it from, which is why this is not simply "was the reason 'competitor'".
        if (data.canExcludeDomain) offerDomainExclusion(strip, data.domain, data.campaignId);
        else strip.innerHTML = data.recorded
          ? '<p class="text-[11px] font-semibold text-gray-600">Noted — thanks.</p>'
          : '<p class="text-[11px] font-semibold text-gray-500">The lead is rejected. The note couldn’t be recorded.</p>';
      } catch (err) {
        strip.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        status.textContent = err.message || 'Could not save that.';
        status.className = 'text-[11px] font-semibold text-red-600 mt-1.5';
      }
    });
    return strip;
  }

  /**
   * The one follow-up that changes what the next run finds: block this company's domain.
   *
   * A DOMAIN rather than a keyword, for the same reason the Review Queue's copy of this does it:
   * negative keywords are a substring match over title and snippet, so a well-meant "agency" also
   * deletes every prospect whose page happens to mention one. A domain match is exact.
   */
  function offerDomainExclusion(strip, domain, campaignId) {
    strip.innerHTML = `
      <p class="text-[11px] font-bold text-gray-700">Noted. Stop this search finding <span class="font-mono">${esc(domain)}</span>?</p>
      <p class="text-[11px] text-gray-500 mb-2">Adds the domain to this search’s exclusions. You can remove it later by editing the search.</p>
      <div class="flex flex-wrap gap-1.5">
        <button type="button" class="px-2 py-1 text-[11px] font-bold rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white transition cursor-pointer" data-hub-exclude>Yes, exclude it</button>
        <button type="button" class="px-2 py-1 text-[11px] font-bold rounded-lg text-gray-400 hover:text-gray-600 transition cursor-pointer" data-hub-exclude-skip>No thanks</button>
      </div>
      <p class="hidden text-[11px] font-semibold mt-1.5" data-hub-exclude-status></p>`;

    const status = strip.querySelector('[data-hub-exclude-status]');
    strip.querySelector('[data-hub-exclude-skip]').addEventListener('click', () => strip.remove());
    strip.querySelector('[data-hub-exclude]').addEventListener('click', async () => {
      strip.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      status.classList.remove('hidden');
      status.textContent = 'Excluding…';
      status.className = 'text-[11px] font-semibold text-gray-500 mt-1.5';
      try {
        const res = await fetch('/.netlify/functions/discovery-campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'exclude_domain', campaignId, domain }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not exclude that domain.');
        strip.innerHTML = `<p class="text-[11px] font-semibold text-gray-600">${esc(domain)} won’t come back in this search.</p>`;
      } catch (err) {
        strip.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        status.textContent = err.message || 'Could not exclude that domain.';
        status.className = 'text-[11px] font-semibold text-red-600 mt-1.5';
      }
    });
  }

  // Meetings: summary + a check-off-able action-item list persisted via PATCH
  // (data.tasks[i].done), instead of the read-only chat card.
  function meetingDetail(record) {
    const wrap = document.createElement('div');
    const data = record.data || {};
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    wrap.innerHTML = `
      ${data.meetingSummary ? `<p class="text-sm text-gray-700 whitespace-pre-line mb-4">${esc(data.meetingSummary)}</p>` : ''}
      ${tasks.length ? `
        <p class="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Action items</p>
        <ul class="space-y-2">
          ${tasks.map((t, i) => `
            <li class="flex items-start gap-2.5">
              <input type="checkbox" data-task-check="${i}" ${t.done ? 'checked' : ''}
                class="mt-0.5 w-4 h-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-700 cursor-pointer">
              <span class="text-sm ${t.done ? 'text-gray-400 line-through' : 'text-gray-900'}" data-task-label="${i}">
                ${esc(t.description)}
                <span class="text-gray-500">— ${esc(t.assignee) || 'Unassigned'}${t.dueDate ? `, due ${esc(t.dueDate)}` : ''}</span>
              </span>
            </li>`).join('')}
        </ul>` : '<p class="text-sm text-gray-500">No action items were extracted from this meeting.</p>'}
      <p class="hidden mt-3 text-xs font-semibold" data-detail-status></p>
    `;
    wrap.addEventListener('change', async (e) => {
      const box = e.target.closest('[data-task-check]');
      if (!box) return;
      const i = Number(box.getAttribute('data-task-check'));
      const status = wrap.querySelector('[data-detail-status]');
      const label = wrap.querySelector(`[data-task-label="${i}"]`);
      tasks[i].done = box.checked;
      const open = tasks.filter((t) => !t.done).length;
      try {
        await patchRecord(record.id, { status: open === 0 ? 'done' : `${open} open`, data: { ...data, tasks } });
        record.status = open === 0 ? 'done' : `${open} open`;
        label.className = `text-sm ${box.checked ? 'text-gray-400 line-through' : 'text-gray-900'}`;
        status.classList.add('hidden');
        refreshRow(record);
      } catch (err) {
        tasks[i].done = !box.checked;
        box.checked = !box.checked;
        status.textContent = err.message;
        status.className = 'mt-3 text-xs font-semibold text-red-600';
      }
    });
    return wrap;
  }

  // Per-type action row under the expanded detail.
  function detailActions(record) {
    const bar = document.createElement('div');
    bar.className = 'flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-gray-100';
    const btnCls = 'px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed';
    const buttons = [];

    // Ledger: track who has been emailed and when (the AR chase history).
    if (state.hub.recordType === 'invoice') {
      buttons.push({ label: 'Mark chased today', async run(btn, status) {
        const data = { ...(record.data || {}), lastChasedAt: new Date().toISOString() };
        await patchRecord(record.id, { status: 'chased', data });
        record.data = data; record.status = 'chased';
        btn.textContent = 'Chased ✓'; btn.disabled = true;
        status.textContent = 'Chase logged — the Ledger now shows today as the last chase date.';
        refreshRow(record);
      }});
      const draft = record.data?.invoices?.[0]?.emailDraft;
      if (draft && draft.body) {
        buttons.push({ label: 'Copy chasing email', async run(btn) {
          await navigator.clipboard.writeText(`Subject: ${draft.subject || ''}\n\n${draft.body}`);
          btn.textContent = 'Copied ✓';
        }});
      }
    }

    // Tickets: the drafted customer reply, ready to paste into any inbox.
    if (state.hub.recordType === 'ticket' && typeof record.data?.draftReply === 'string' && record.data.draftReply.trim()) {
      buttons.push({ label: 'Copy drafted reply', async run(btn) {
        await navigator.clipboard.writeText(record.data.draftReply);
        btn.textContent = 'Copied ✓';
      }});
    }

    // Leads: edit the lead's details, and copy the outreach draft without re-opening the chat.
    if (state.hub.recordType === 'lead') {
      buttons.push({ label: 'Edit', async run(btn) {
        btn.disabled = false;           // opening a modal shouldn't leave the button stuck disabled
        openEditLeadModal(record);
      }});
      // The only way anything in this product records a won/lost deal. Offered on every lead, not
      // just contacted ones: disqualifying a lead you never emailed is a real, useful outcome —
      // `not_icp` on an untouched lead is the cleanest targeting signal there is.
      buttons.push({
        label: record.data?.dealOutcome?.outcome ? 'Change outcome' : 'Record outcome',
        async run(btn) {
          btn.disabled = false;
          openOutcomeModal(record);
        },
      });
      const draft = record.data?.outreachDraft;
      if (draft && draft.body) {
        buttons.push({ label: 'Copy outreach draft', async run(btn) {
          await navigator.clipboard.writeText(`Subject: ${draft.subject || ''}\n\n${draft.body}`);
          btn.textContent = 'Copied ✓';
        }});
      }
      // Approve — the TRIAGE decision: "this company is worth pursuing." It lives here because
      // this tab is where every lead is, in every state, with the Approval and Contact columns
      // beside it — the two facts the decision needs.
      //
      // ⚠️ This does NOT send anything, and must not. Approving in the Review Queue sends the
      // drafted email (the button there says "Approve & send email"); approving HERE only records
      // the targeting decision, because most leads on this tab have no address to send to —
      // enrichment attempts hot/warm leads only and hits roughly one in three. Keeping the two
      // acts apart is the whole point of the split: judging a company is fast and high-volume,
      // judging an email is slow and low-volume, and one button cannot be both.
      //
      // Offered for anything not already approved. Not hidden for rejected leads: reversing a
      // rejection is a legitimate correction, and the Approval cell states the result either way.
      if (record.approvalStatus !== 'approved') {
        buttons.push({ label: 'Approve', async run(btn, status) {
          const res = await fetch(API, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: record.id, approvalStatus: 'approved' }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Could not approve that lead.');
          record.approvalStatus = 'approved';
          btn.textContent = 'Approved';
          // Same two surfaces the reject path updates: the row's Approval cell and the banner on
          // the open record. refreshRow rewrites cells in place rather than re-rendering the
          // table, which would collapse the panel the user is still reading.
          refreshRow(record);
          const chip = btn.closest('[data-hub-detail]')?.querySelector('[data-hub-approval]');
          if (chip) chip.innerHTML = `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${APPROVAL_CHIP.approved.cls}">${esc(APPROVAL_CHIP.approved.label)}</span>`;
          // Say what did and did not happen. A user who has used the Review Queue has learned that
          // approving sends — leaving that unsaid here would let them believe mail went out.
          const LR = window.LeadRecipient;
          const reachable = LR && typeof LR.isDeliverable === 'function' && LR.isDeliverable(record.data);
          status.textContent = reachable
            ? 'Approved. Nothing has been sent — the drafted email is waiting for you in the Review tab.'
            : 'Approved. Nothing has been sent: there’s no contact address for this lead yet.';
        }});
      }

      // Reject — see the block comment above rejectReasonStrip for why this is a different act
      // from "Record outcome → Disqualified", and why it needed to exist on this tab: users read a
      // lead in full HERE, and had to go and find it again in Review to turn it down.
      //
      // Hidden once already rejected. Not hidden for approved/scheduled leads: an approved lead
      // whose outreach has already gone out can still be the wrong kind of company to have found,
      // and that is exactly the fact the targeting feedback wants.
      if (record.approvalStatus !== 'rejected') {
        buttons.push({ label: 'Reject', async run(btn, status) {
          const res = await fetch(API, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: record.id, approvalStatus: 'rejected' }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Could not reject that lead.');
          record.approvalStatus = 'rejected';
          btn.textContent = 'Rejected';
          // Both places the state is stated: the row's Approval cell, and the banner above the
          // open record. refreshRow rewrites the cells in place rather than re-rendering the
          // table, which would collapse the panel the user is still reading.
          refreshRow(record);
          const chip = btn.closest('[data-hub-detail]')?.querySelector('[data-hub-approval]');
          if (chip) chip.innerHTML = `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${APPROVAL_CHIP.rejected.cls}">${esc(APPROVAL_CHIP.rejected.label)}</span>`;
          // Asked AFTER the rejection commits, never as a gate on it: the reason is an annotation
          // on a decision the user has already made, and blocking the reject behind it would only
          // buy worse answers from someone with nineteen more leads to get through.
          status.parentElement?.appendChild(rejectReasonStrip(record));
        }});
      }
    }

    // Deleting a LEAD asks why first — see deleteReasonStrip for why this one confirms up front
    // while Reject deliberately asks afterwards. Every other record type deletes as before.
    buttons.push({ label: 'Delete', danger: true, async run(btn, status) {
      if (state.hub.recordType === 'lead') {
        btn.disabled = false;   // the strip owns the action now; leave the button usable
        status.parentElement?.appendChild(deleteReasonStrip(record));
        return;
      }
      await deleteRecord(record.id);
    }});

    const status = document.createElement('p');
    status.className = 'text-xs text-gray-400 w-full';

    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      btn.className = b.danger
        ? 'px-3 py-1.5 bg-white border border-gray-200 text-red-600 hover:border-red-300 hover:bg-red-50 text-xs font-bold rounded-lg transition disabled:opacity-60 ml-auto'
        : btnCls;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await b.run(btn, status); }
        catch (err) {
          btn.disabled = false;
          status.textContent = err.message || 'Something went wrong.';
          status.className = 'text-xs font-semibold text-red-600 w-full';
        }
      });
      bar.appendChild(btn);
    }
    bar.appendChild(status);
    return bar;
  }

  // A post that failed to publish is explained in two places — the Review Queue's Needs-attention
  // panel and this row — so the words come from ONE place: get-social-drafts runs the post's
  // failure_reason through diagnosePostFailure (src/utils/post-failure-diagnosis.ts) and returns
  // the result as `failure`. This banner leads with that plain-English cause and remedy; the
  // platform's own sentence ("(#352) Format unsupported") is kept, but folded away, because it is
  // written for a developer and reading it is never the next step.
  //
  // Three ways out, all always offered whatever the diagnosis said — a classification we got wrong
  // must not be able to remove the option the user actually needed. See _rqFailureRecoveryHtml in
  // workspace.html, which offers the same set plus reconnect/reject.
  function failureBanner(record) {
    const p = record.data || {};
    // Older payloads (and any surface that hasn't been through get-social-drafts) arrive without a
    // diagnosis — fall back to the raw message rather than rendering an empty red box.
    const f = p.failure || {
      title: 'This post didn’t publish.',
      remedy: 'Publish it again, or reschedule it for later.',
      raw: p.failureMessage || null,
    };
    const wrap = document.createElement('div');
    wrap.className = 'mb-4 rounded-xl border border-red-200 bg-red-50 p-4';
    const attempts = Number(p.attemptCount) || 0;
    wrap.innerHTML = `
      <p class="text-xs font-bold text-red-700 uppercase tracking-wide">Failed to publish</p>
      <p class="text-sm font-semibold text-red-900 mt-1">${esc(f.title)}</p>
      <p class="text-sm text-red-800 mt-1">${esc(f.remedy)}</p>
      ${attempts ? `<p class="text-xs text-red-600 mt-1">After ${attempts} attempt${attempts === 1 ? '' : 's'}.</p>` : ''}
      ${f.raw ? `<details class="mt-2">
        <summary class="cursor-pointer text-xs text-red-500 hover:text-red-700 select-none">What the platform said</summary>
        <p class="mt-1 font-mono text-[11px] text-red-800 bg-white/70 rounded px-2 py-1.5 border border-red-200 break-words whitespace-pre-line">${esc(f.raw)}</p>
      </details>` : ''}
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-retry-now
          class="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Try again now</button>
        <button type="button" data-retry-edit
          class="px-3 py-1.5 bg-white border border-red-200 text-red-700 hover:bg-red-100 text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Fix the post</button>
        <input type="datetime-local" data-retry-at
          class="px-2 py-1.5 bg-white border border-red-200 text-xs text-gray-700 rounded-lg">
        <button type="button" data-retry-schedule
          class="px-3 py-1.5 bg-white border border-red-200 text-red-700 hover:bg-red-100 text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Reschedule</button>
      </div>
      <p class="hidden text-xs font-semibold mt-2" data-retry-status></p>
    `;

    const status = wrap.querySelector('[data-retry-status]');
    const buttons = [
      wrap.querySelector('[data-retry-now]'),
      wrap.querySelector('[data-retry-edit]'),
      wrap.querySelector('[data-retry-schedule]'),
    ];

    // mode 'edit' sends the post back to pending_approval instead of re-queueing it: 'failed' is a
    // non-editable status, so a media or wording problem can only be fixed by moving it first.
    async function requeue(publishDate, mode) {
      buttons.forEach((b) => { b.disabled = true; });
      status.className = 'text-xs font-semibold mt-2 text-gray-500';
      status.textContent = mode === 'edit' ? 'Reopening the post for editing…' : 'Re-queueing…';
      try {
        const res = await fetch('/.netlify/functions/retry-failed-post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            postId: record.id,
            ...(mode ? { mode } : {}),
            ...(publishDate ? { publishDate } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not re-queue this post.');
        status.className = 'text-xs font-semibold mt-2 text-emerald-700';
        status.textContent = mode === 'edit'
          ? 'Reopened for editing — it’s waiting in Review; approve it when you’re happy and it goes back out.'
          : publishDate
            ? `Rescheduled for ${new Date(data.publishDate).toLocaleString()}.`
            : 'Back in the queue — it will publish on the next run.';
        // Reflect the new status in the library without the user re-opening the tab.
        refresh();
      } catch (err) {
        buttons.forEach((b) => { b.disabled = false; });
        status.className = 'text-xs font-semibold mt-2 text-red-700';
        status.textContent = err.message;
      }
    }

    buttons[0].addEventListener('click', () => requeue(null, null));
    buttons[1].addEventListener('click', () => requeue(null, 'edit'));
    buttons[2].addEventListener('click', () => {
      const when = wrap.querySelector('[data-retry-at]').value;
      if (!when) {
        status.className = 'text-xs font-semibold mt-2 text-red-700';
        status.textContent = 'Pick a date and time to reschedule to.';
        return;
      }
      requeue(new Date(when).toISOString(), null);
    });

    return wrap;
  }

  // Content Library row detail — the post content, read-only. Approval/scheduling actions
  // deliberately live in the Review Queue / Calendar, so this stays a browse-only view —
  // except for a failed post, which has nowhere else to be recovered from.
  function libraryDetail(record) {
    const p = record.data || {};
    const wrap = document.createElement('div');
    const body = p.caption || p.excerpt || p.summary || p.subtitle || '';
    const tags = Array.isArray(p.hashtags) ? p.hashtags.join(' ') : (p.hashtags || '');
    wrap.innerHTML = `
      ${body ? `<p class="text-sm text-gray-800 whitespace-pre-line">${esc(body)}</p>` : '<p class="text-sm text-gray-500">No content yet.</p>'}
      ${tags ? `<p class="text-xs text-emerald-700 mt-3">${esc(tags)}</p>` : ''}
      <p class="text-xs text-gray-400 mt-4 pt-3 border-t border-gray-100">Approve or reject this in <span class="font-semibold text-gray-600">Review</span>; scheduled posts appear on the <span class="font-semibold text-gray-600">Calendar</span>.</p>
    `;
    if (record.status === 'failed') wrap.insertBefore(failureBanner(record), wrap.firstChild);
    return wrap;
  }

  function detailPanel(record) {
    const panel = document.createElement('div');
    panel.className = 'px-5 py-4 bg-gray-50/70';
    panel.setAttribute('data-hub-detail', '');

    // Content Library: read-only post view, no record actions.
    if (state.hub.kind === 'content_library') {
      panel.appendChild(libraryDetail(record));
      return panel;
    }

    let body = null;
    if (state.hub.recordType === 'meeting') {
      body = meetingDetail(record);
    } else if (window.DisruptiveUIRegistry) {
      // Chat-produced records store the exact uiElement wire shape — re-render it
      // with the same card the transcript used.
      body = window.DisruptiveUIRegistry.render(record.data);
    }
    // A lead leads with where it stands: first the approval gate (pending / approved / rejected),
    // then a recorded deal outcome if there is one. Both above the card, so they read as facts
    // about the lead rather than more fields buried inside it.
    if (state.hub.recordType === 'lead') panel.appendChild(approvalBanner(record));
    const outcome = state.hub.recordType === 'lead' ? outcomeBanner(record) : null;
    if (outcome) panel.appendChild(outcome);
    panel.appendChild(body || keyValueFallback(record.data));
    panel.appendChild(detailActions(record));
    return panel;
  }

  // ── Table ───────────────────────────────────────────────────────────────────

  function rowHtml(record) {
    const cols = state.hub.columns.map((c, i) => {
      let cell;
      if (c.key === 'status') {
        cell = `<span class="text-xs font-bold px-2 py-0.5 rounded-full border bg-gray-50 text-gray-600 border-gray-200 whitespace-nowrap">${esc(cellValue(record, c.key))}</span>`;
      } else if (c.key === 'approvalStatus') {
        // Coloured, unlike the neutral Rating chip beside it: this column exists to be SCANNED for
        // the amber ones. A record with no approval status renders the bare em-dash — a grey chip
        // reading "—" would look like a fourth state.
        const s = APPROVAL_CHIP[record.approvalStatus];
        cell = s
          ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${s.cls} whitespace-nowrap">${esc(s.short)}</span>`
          : '<span class="text-gray-400">—</span>';
      } else if (c.key === 'contact') {
        // The chip carries the STATE; the address itself rides in the tooltip. A column of raw
        // addresses would be unscannable, and would put a hundred people's contact details on
        // screen to answer a question that is really just "can I send to this one?".
        const s = CONTACT_CHIP[contactState(record)];
        const email = contactEmailOf(record);
        cell = `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${s.cls} whitespace-nowrap"${email ? ` title="${esc(email)}"` : ''}>${esc(s.short)}</span>`;
      } else {
        cell = esc(cellValue(record, c.key));
      }
      return `<td class="px-4 py-3 ${i === 0 ? 'font-semibold text-gray-900' : 'text-gray-700'}">${cell}</td>`;
    }).join('');
    return `${cols}
      <td class="px-4 py-3 text-right">
        <svg class="w-4 h-4 text-gray-400 inline transition-transform" data-row-chevron fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
      </td>`;
  }

  // Refresh a single row's cells after a PATCH without collapsing the detail panel.
  function refreshRow(record) {
    const tr = document.querySelector(`#datahub-table-host tr[data-record-id="${record.id}"]`);
    if (tr) tr.innerHTML = rowHtml(record);
  }

  /**
   * How many records this hub holds, on the tab button itself — "Leads (48)", "Ledger (12)".
   *
   * Records-kind hubs only. The Content Library reads the posts endpoint, whose result is a
   * lifecycle slice rather than a complete count, so a number there would be confidently wrong.
   *
   * assistants.js sets the plain label from the registry at apply time and init() runs straight
   * after, so this always lands second and wins. `(0)` is suppressed on purpose: an empty hub
   * already says so in the table body, and a zero on the tab reads as a broken counter.
   */
  function updateTabCount() {
    const el = document.getElementById('datahub-tab-label');
    if (!el || !state.hub || state.hub.kind === 'content_library') return;
    const n = state.records.length;
    el.textContent = n ? `${state.hub.label} (${n})` : state.hub.label;
  }

  function renderTable() {
    updateTabCount();
    const host = document.getElementById('datahub-table-host');
    if (!host) return;
    const hub = state.hub;

    if (state.records.length === 0) {
      const emptyMsg = hub.kind === 'content_library'
        ? 'Posts this assistant drafts will appear here across their whole lifecycle — from draft through scheduled to published. Click Create Post above to write one yourself or generate one with AI.'
        : `Work your assistant produces in chat lands here automatically — or import a CSV to get started. ${esc(hub.importHint)}`;
      host.innerHTML = `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 text-center">
          <p class="text-4xl mb-3">🗂️</p>
          <p class="font-bold text-gray-900 mb-1">Nothing in ${esc(hub.label)} yet</p>
          <p class="text-sm text-gray-500 max-w-md mx-auto">${emptyMsg}</p>
        </div>`;
      return;
    }

    host.innerHTML = `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs font-bold text-gray-500 uppercase tracking-wider border-b border-gray-100">
                ${hub.columns.map((c) => `<th class="px-4 py-3">${esc(c.label)}</th>`).join('')}
                <th class="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100" data-hub-tbody></tbody>
          </table>
        </div>
      </div>`;

    const tbody = host.querySelector('[data-hub-tbody]');
    for (const record of state.records) {
      const tr = document.createElement('tr');
      tr.className = 'cursor-pointer hover:bg-gray-50 transition-colors';
      tr.setAttribute('data-record-id', record.id);
      tr.innerHTML = rowHtml(record);

      const detailTr = document.createElement('tr');
      detailTr.className = 'hidden';
      const td = document.createElement('td');
      td.colSpan = hub.columns.length + 1;
      td.className = 'p-0 border-t border-gray-100';
      detailTr.appendChild(td);

      tr.addEventListener('click', () => {
        const open = !detailTr.classList.contains('hidden');
        if (!open && !td.hasChildNodes()) td.appendChild(detailPanel(record));
        detailTr.classList.toggle('hidden', open);
        const chevron = tr.querySelector('[data-row-chevron]');
        if (chevron) chevron.classList.toggle('rotate-180', !open);
      });

      tbody.appendChild(tr);
      tbody.appendChild(detailTr);
    }

    applyPendingFocus();
  }

  // Deep link (Request 6): a "post failed to publish" notification names the post, so open its
  // row expanded, scroll it into view and flash a highlight — otherwise the user lands on a
  // library of dozens of rows and has to hunt for the one that failed. One-shot: consumed on
  // the first render that actually contains the row, so a later refresh doesn't re-scroll.
  function applyPendingFocus() {
    const id = state.pendingFocusId;
    if (id == null) return;
    const tr = document.querySelector(`#datahub-table-host tr[data-record-id="${id}"]`);
    if (!tr) return;                       // not in this hub's records — leave it pending
    state.pendingFocusId = null;
    tr.click();                            // expands the detail panel (failure banner + actions)
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    tr.classList.add('ring-2', 'ring-inset', 'ring-red-400', 'bg-red-50');
    setTimeout(() => tr.classList.remove('ring-2', 'ring-inset', 'ring-red-400', 'bg-red-50'), 4000);
  }

  // Called before/after the Data Hub tab is opened. If the table is already on screen the focus
  // applies immediately; otherwise it's picked up by the next renderTable().
  function focusRecord(recordId) {
    state.pendingFocusId = recordId == null ? null : Number(recordId);
    applyPendingFocus();
  }

  // Content Library toolbar — a "Create Post" button opens the same post-creation surface as
  // Assign Task / Blog Studio (write it yourself, suggest an idea, or work with AI), so the
  // library isn't just a read-only history: approval still happens in the Review Queue.
  function renderLibraryToolbar() {
    const host = document.getElementById('datahub-toolbar');
    if (!host) return;
    const hub = state.hub;
    const isBlog = hub.source === 'blog_posts';
    host.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
        <div class="min-w-0">
          <h3 class="text-lg font-bold text-gray-900">${esc(hub.label)}</h3>
          <p class="text-sm text-gray-500 mt-1 max-w-2xl">${esc(hub.description)}</p>
        </div>
        <button type="button" id="datahub-create-post"
          class="inline-flex items-center gap-2 px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap shrink-0">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          Create Post
        </button>
      </div>`;
    const btn = document.getElementById('datahub-create-post');
    if (btn) {
      btn.addEventListener('click', () => {
        if (isBlog) window.openBlogStudio?.({ assistantId: state.assistantId });
        else window.openGeneratePostSheet?.();
      });
    }
  }

  function renderToolbar() {
    if (state.hub.kind === 'content_library') { renderLibraryToolbar(); return; }
    const host = document.getElementById('datahub-toolbar');
    if (!host) return;
    const hub = state.hub;
    host.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
        <div class="min-w-0">
          <h3 class="text-lg font-bold text-gray-900">${esc(hub.label)}</h3>
          <p class="text-sm text-gray-500 mt-1 max-w-2xl">${esc(hub.description)}</p>
        </div>
        <!-- flex-wrap, not nowrap: every button is whitespace-nowrap, so without it the row's
             min-content width is the SUM of all three (~425px on a 375px phone) and, since a flex
             item can't shrink below that, the whole PAGE scrolled sideways with Export CSV clipped
             off-screen. Wrapping lets the buttons stack on a narrow viewport. shrink-0 stays: it
             only bites at sm+, where the row is a flex-row item beside the heading and must keep
             all three on one line (on mobile the parent is flex-col, so shrink is the vertical
             axis and this does nothing). No backticks in here — this comment is inside a template
             literal. -->
        <div class="flex flex-wrap items-center gap-2 shrink-0">
          ${hub.manualAdd ? `
          <button type="button" data-hub-add
            class="inline-flex items-center gap-2 px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
            Add Lead
          </button>` : ''}
          <input type="file" accept=".csv" class="hidden" data-hub-file>
          <button type="button" data-hub-import
            class="inline-flex items-center gap-2 px-4 py-2 ${hub.manualAdd
              ? 'bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800'
              : 'bg-emerald-700 hover:bg-emerald-800 text-white'} text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0-12l-4 4m4-4l4 4"/></svg>
            Import CSV
          </button>
          <button type="button" data-hub-export
            class="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-sm font-bold rounded-lg transition whitespace-nowrap">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 16V4m0 12l-4-4m4 4l4-4"/></svg>
            Export CSV
          </button>
        </div>
      </div>
      <p class="hidden -mt-3 mb-5 text-xs font-semibold" data-hub-status></p>
      <p class="-mt-3 mb-5 text-xs text-gray-400">${esc(hub.importHint)} Suggested columns: ${hub.importColumns.map((c) => `<span class="font-semibold text-gray-500">${esc(c)}</span>`).join(', ')}.</p>
    `;

    const fileInput = host.querySelector('[data-hub-file]');
    const importBtn = host.querySelector('[data-hub-import]');
    const status = host.querySelector('[data-hub-status]');

    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      importBtn.disabled = true;
      status.className = 'block -mt-3 mb-5 text-xs font-semibold text-gray-500';
      status.textContent = 'Reading the file…';
      try {
        const result = await importCsv(file, status);
        await fetchRecords();
        renderTable();
        status.textContent = `Imported ${result.inserted} new record${result.inserted === 1 ? '' : 's'}${result.updated ? ` and refreshed ${result.updated} existing` : ''}.`;
        status.className = 'block -mt-3 mb-5 text-xs font-semibold text-emerald-700';
      } catch (err) {
        status.textContent = err.message || 'Import failed.';
        status.className = 'block -mt-3 mb-5 text-xs font-semibold text-red-600';
      } finally {
        importBtn.disabled = false;
      }
    });

    host.querySelector('[data-hub-export]').addEventListener('click', () => {
      window.location.href = `${API}?assistantId=${state.assistantId}&recordType=${encodeURIComponent(hub.recordType)}&format=csv`;
    });

    const addBtn = host.querySelector('[data-hub-add]');
    if (addBtn) addBtn.addEventListener('click', () => openAddLeadModal(status));
  }

  // ── Manual "Add Lead" (lead hubs only) ──────────────────────────────────────
  // A single hand-typed lead, scored on submit by netlify/functions/lead-generation.ts
  // (score_lead) so it lands in the Leads tab exactly like a chat-produced lead.
  const ADD_LEAD_FIELDS = [
    { key: 'name', label: 'Contact name', ph: 'Jane Doe' },
    { key: 'company', label: 'Company', ph: 'Acme Ltd' },
    { key: 'email', label: 'Email', ph: 'jane@acme.com', type: 'email' },
    { key: 'website', label: 'Website', ph: 'acme.com' },
    { key: 'industry', label: 'Industry', ph: 'SaaS' },
    { key: 'headcount', label: 'Headcount', ph: '50' },
    { key: 'notes', label: 'Notes', ph: 'Where they came from, what they want…', textarea: true },
  ];

  function openAddLeadModal(toolbarStatus) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100">
          <div>
            <h3 class="text-lg font-bold text-gray-900">Add a lead</h3>
            <p class="text-sm text-gray-500 mt-0.5">The Lead Generation Assistant scores it against your ideal customer profile as it's saved.</p>
          </div>
          <button type="button" data-add-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer">&times;</button>
        </div>
        <form data-add-form class="p-5 space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            ${ADD_LEAD_FIELDS.map((f) => `
              <label class="block ${f.textarea ? 'sm:col-span-2' : ''}">
                <span class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">${esc(f.label)}</span>
                ${f.textarea
                  ? `<textarea name="${f.key}" rows="2" placeholder="${esc(f.ph)}" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-400"></textarea>`
                  : `<input type="${f.type || 'text'}" name="${f.key}" placeholder="${esc(f.ph)}" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-400">`}
              </label>`).join('')}
          </div>
          <p class="hidden text-xs font-semibold" data-add-status></p>
          <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" data-add-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 rounded-lg cursor-pointer">Cancel</button>
            <button type="submit" data-add-submit
              class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Add &amp; score lead</button>
          </div>
        </form>
      </div>`;

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-add-close]').forEach((b) => b.addEventListener('click', close));

    const form = overlay.querySelector('[data-add-form]');
    const status = overlay.querySelector('[data-add-status]');
    const submit = overlay.querySelector('[data-add-submit]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const lead = {};
      for (const f of ADD_LEAD_FIELDS) {
        const v = form.elements[f.key]?.value?.trim();
        if (v) lead[f.key] = v;
      }
      if (!lead.name && !lead.company) {
        status.textContent = 'Enter at least a contact name or a company.';
        status.className = 'block text-xs font-semibold text-red-600';
        return;
      }
      submit.disabled = true;
      status.textContent = 'Scoring the lead…';
      status.className = 'block text-xs font-semibold text-gray-500';
      try {
        const res = await fetch('/.netlify/functions/lead-generation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'score_lead', assistantId: state.assistantId, lead }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not score the lead.');
        close();
        await fetchRecords();
        renderTable();
        const card = data.record?.data || {};
        window.showToast?.(`Lead scored ${card.score ?? ''}/100 — ${card.rating || 'added'}. It's in your Leads tab.`);
        if (toolbarStatus) {
          toolbarStatus.textContent = `Added and scored “${data.record?.title || 'lead'}”.`;
          toolbarStatus.className = 'block -mt-3 mb-5 text-xs font-semibold text-emerald-700';
        }
      } catch (err) {
        submit.disabled = false;
        status.textContent = err.message || 'Something went wrong.';
        status.className = 'block text-xs font-semibold text-red-600';
      }
    });

    document.body.appendChild(overlay);
    overlay.querySelector('input[name="name"]')?.focus();
  }

  // ── Edit an existing lead (lead hubs) ───────────────────────────────────────
  // In-place editing of a filed lead's core details, PATCHed back to assistant_records.
  const EDIT_LEAD_FIELDS = [
    { key: 'title', label: 'Company', envelope: true, ph: 'Acme Ltd' },
    { key: 'contactName', label: 'Contact name', ph: 'Jane Doe' },
    { key: 'contactEmail', label: 'Email', ph: 'jane@acme.com', type: 'email' },
    { key: 'status', label: 'Status', envelope: true, ph: 'hot / warm / cold' },
    { key: 'notes', label: 'Notes', ph: 'Context, next step…', textarea: true },
  ];

  function openEditLeadModal(record) {
    const data = record.data && typeof record.data === 'object' ? record.data : {};
    const cur = (f) => f.key === 'title' ? (record.title ?? '') : f.key === 'status' ? (record.status ?? '') : (data[f.key] ?? '');
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100">
          <h3 class="text-lg font-bold text-gray-900">Edit lead</h3>
          <button type="button" data-edit-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer">&times;</button>
        </div>
        <form data-edit-form class="p-5 space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            ${EDIT_LEAD_FIELDS.map((f) => `
              <label class="block ${f.textarea ? 'sm:col-span-2' : ''}">
                <span class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">${esc(f.label)}</span>
                ${f.textarea
                  ? `<textarea name="${f.key}" rows="2" placeholder="${esc(f.ph)}" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-400">${esc(cur(f))}</textarea>`
                  : `<input type="${f.type || 'text'}" name="${f.key}" value="${esc(cur(f))}" placeholder="${esc(f.ph)}" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-400">`}
              </label>`).join('')}
          </div>
          <p class="hidden text-xs font-semibold" data-edit-status></p>
          <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" data-edit-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 rounded-lg cursor-pointer">Cancel</button>
            <button type="submit" data-edit-submit class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Save changes</button>
          </div>
        </form>
      </div>`;

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-edit-close]').forEach((b) => b.addEventListener('click', close));

    const form = overlay.querySelector('[data-edit-form]');
    const status = overlay.querySelector('[data-edit-status]');
    const submit = overlay.querySelector('[data-edit-submit]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = form.elements.title?.value?.trim();
      if (!title) {
        status.textContent = 'Company (the lead title) can’t be empty.';
        status.className = 'block text-xs font-semibold text-red-600';
        return;
      }
      const nextData = { ...data };
      for (const f of EDIT_LEAD_FIELDS) {
        if (f.envelope) continue;
        const v = form.elements[f.key]?.value?.trim();
        if (v) nextData[f.key] = v; else delete nextData[f.key];
      }
      const nextStatus = form.elements.status?.value?.trim() || null;
      submit.disabled = true;
      status.textContent = 'Saving…';
      status.className = 'block text-xs font-semibold text-gray-500';
      try {
        await patchRecord(record.id, { title, status: nextStatus, data: nextData });
        record.title = title;
        record.status = nextStatus;
        record.data = nextData;
        close();
        renderTable();
        window.showToast?.('Lead updated.');
      } catch (err) {
        submit.disabled = false;
        status.textContent = err.message || 'Could not update the lead.';
        status.className = 'block text-xs font-semibold text-red-600';
      }
    });

    document.body.appendChild(overlay);
    overlay.querySelector('input[name="title"]')?.focus();
  }

  async function init({ hub, assistantId }) {
    if (!hub || !assistantId) return;
    state.hub = hub;
    state.assistantId = assistantId;
    state.records = [];
    renderToolbar();
    const host = document.getElementById('datahub-table-host');
    if (host) host.innerHTML = '<p class="text-sm text-gray-400">Loading…</p>';
    try {
      await fetchRecords();
      renderTable();
    } catch (err) {
      if (host) host.innerHTML = `<div class="bg-red-50 border border-red-200 rounded-2xl p-6 text-sm font-semibold text-red-700">${esc(err.message)}</div>`;
    }
  }

  // Re-read records without rebuilding the toolbar — called each time the Data Hub tab is
  // opened (assistants.js _activateMainTab) so records produced after page-load appear without a
  // reload. Records land here from background flows the hub itself doesn't drive: discovery
  // promotion (pending_approval leads), chat, integrations, and Review-Queue approvals. Silent
  // (no loading flash) since the existing table stays visible until the fresh data swaps in.
  async function refresh() {
    if (!state.hub || !state.assistantId) return; // init() hasn't run yet — nothing to refresh
    try {
      await fetchRecords();
      renderTable();
    } catch (err) {
      const host = document.getElementById('datahub-table-host');
      if (host) host.innerHTML = `<div class="bg-red-50 border border-red-200 rounded-2xl p-6 text-sm font-semibold text-red-700">${esc(err.message)}</div>`;
    }
  }

  window.AssistantDataHub = { init, refresh, focusRecord };
})();
