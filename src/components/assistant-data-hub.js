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

  /**
   * The chip a record's approval state should actually render — which, for a lead, is not always
   * its approval state.
   *
   * `approved` and `scheduled` both mean "cleared", and neither answers the question a user asks
   * of an approved lead: did the email go? Both outcomes are legitimate — sent from a connected
   * inbox, or handed back as a draft when there isn't one — and until this existed they were the
   * same two words on screen, so a lead nobody had emailed looked exactly like one that had.
   *
   * The states and their wording come from window.LeadOutreach (generated from
   * src/config/lead-outreach-state.ts), which is the SAME source the Review tab's card chip reads.
   * Retyping "Email Sent" here would be the drift this table already learned about the hard way
   * with the rating bands.
   *
   * ⚠️ Anything added here must also be added to ORDERED_VALUES.approvalStatus — that vocabulary
   * ranks the RENDERED label, so a label it doesn't know sorts every such row last.
   */
  function approvalChip(record) {
    const base = APPROVAL_CHIP[record.approvalStatus];
    if (!base) return null;
    if (record.recordType !== 'lead') return base;
    const OUT = window.LeadOutreach;
    const out = (OUT && typeof OUT.state === 'function') ? OUT.state(record.data || {}) : null;
    if (!out) return base;
    const chip = OUT.chips[out];
    // `label` is the banner's long form and `short` the cell's; here the state is already two words
    // and reads correctly in both, so it is deliberately the same string rather than an invented
    // longer one that would say the same thing differently in two places.
    return { label: chip.label, short: chip.label, cls: chip.cls };
  }

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
  // `why` is the tooltip when there is no address to show instead. A chip reading "Not attempted"
  // with no explanation invites the reading "the product is broken"; the reason is what turns it
  // into a next action.
  const CONTACT_CHIP = {
    role: { short: 'Role inbox', cls: 'bg-green-50 text-green-700 border-green-100' },
    personal: { short: 'Named person', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    none: { short: 'None found', cls: 'bg-red-50 text-red-700 border-red-200',
      why: 'We read this company’s website and it publishes no contact address. Add one by hand to email them.' },
    checking: { short: 'Checking…', cls: 'bg-blue-50 text-blue-800 border-blue-200',
      why: 'A search is running now and this lead is queued for a contact lookup.' },
    unchecked: { short: 'Not checked', cls: 'bg-gray-100 text-gray-500 border-gray-200',
      why: 'This lead scored cold, and only hot and warm leads are looked up. The fix is targeting, not the lookup.' },
    // Phase 2 item 11: hot/warm, never attempted, and nothing is running to attempt it.
    missed: { short: 'Not attempted', cls: 'bg-amber-50 text-amber-700 border-amber-200',
      why: 'The last search finished without looking this one up. Nothing is queued for it — run the search again or add an address by hand.' },
  };

  /** The address on a lead, or null. Same precedence the Review Queue's recipient line uses. */
  function contactEmailOf(record) {
    const v = record.data && record.data.contactEmail;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  /**
   * Has this lead been erased at the request of the person it named?
   *
   * ⚠️ The stamp is all that is left to read. Erasing strips the address, the name and the research
   * out of `data`, so an erased lead is otherwise indistinguishable from one nobody has looked at —
   * which is precisely the shape "Look again" and "Research this lead" are offered ON. Without this
   * check the tab that erases a person also offers, two inches away, to go and find them again.
   */
  function isErasedLead(record) {
    const v = record.data && record.data.erasedAt;
    return typeof v === 'string' && !!v.trim();
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
   * ⚠️ "Checking…" used to cover a run that had FINISHED or DIED before enriching, where nothing
   * was in progress at all — it was a documented accepted edge, and it was a lie the column told
   * indefinitely. `enrichmentInFlight` (stamped per record by assistant-records.ts) closes it:
   * enrichment only ever runs inside a live job, so with every job on this lead's campaign
   * terminal, an unstamped hot/warm lead is not queued for anything. It reads "Not attempted",
   * which is both true and actionable, instead of "Checking…" forever.
   *
   * ⚠️ Absent `enrichmentInFlight` resolves to "Not attempted", not "Checking…". A record from a
   * surface that does not supply the flag should understate what the pipeline is doing rather than
   * promise work; "Checking…" is the claim that needs evidence.
   */
  function contactState(record) {
    const d = record.data || {};
    if (contactEmailOf(record)) return d.emailKind === 'personal' ? 'personal' : 'role';
    if (d.enrichAttemptedAt) return 'none';
    if (record.status === 'cold') return 'unchecked';
    return record.enrichmentInFlight ? 'checking' : 'missed';
  }

  // Resolve a hubTab column key against a record: envelope fields first, then a
  // dot-path into record.data. Arrays read as counts.
  /**
   * The retention countdown for one lead: how long before the sweep moves it to Deleted.
   *
   * ── Which leads are on a clock, and why the others read "—" ─────────────────
   * Only the two states the sweep collects: `pending_approval` and `rejected`. An approved lead is
   * being worked and a `scheduled` one has had its email SENT (that state is the chase reminder on
   * this role, not a queued send) — neither is ever swept, so a countdown beside them would be a
   * threat the system does not carry out. An em-dash, never a guess and never a blank.
   *
   * ⚠️ Every number and every word here comes from window.LeadRetention, which is generated from
   * src/config/lead-retention.ts — the same source the nightly sweep runs. Computing "30 days from
   * updatedAt" locally would be four lines and would be the one place this could drift, on a
   * countdown whose whole job is to be trusted.
   */
  const RETENTION_URGENCY_CLS = {
    urgent: 'bg-red-50 text-red-700 border-red-200',
    soon: 'bg-amber-50 text-amber-800 border-amber-200',
    low: 'bg-gray-100 text-gray-600 border-gray-200',
  };

  function retentionCell(record) {
    const R = window.LeadRetention;
    const swept = record.approvalStatus === 'pending_approval' || record.approvalStatus === 'rejected';
    if (!R || !swept || R.isDeleted(record.data)) return { text: '—', html: '<span class="text-gray-400">—</span>' };
    const days = R.daysRemaining(record.updatedAt);
    const text = R.countdownLabel(days);
    if (!text) return { text: '—', html: '<span class="text-gray-400">—</span>' };
    const cls = RETENTION_URGENCY_CLS[R.urgency(days)] || RETENTION_URGENCY_CLS.low;
    return {
      text,
      html: `<span class="text-xs font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${cls}">${esc(text)}</span>`,
    };
  }

  function cellValue(record, key) {
    if (key === 'title') return record.title;
    if (key === 'status') return record.status ?? '—';
    // Records predating the approval gate carry no status at all — an em-dash, never a guess.
    if (key === 'approvalStatus') return approvalChip(record)?.short ?? '—';
    if (key === 'contact') return CONTACT_CHIP[contactState(record)].short;
    if (key === 'retention') return retentionCell(record).text;
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

  const state = {
    hub: null, assistantId: null, records: [], pendingFocusId: null, pendingFocusTone: null,
    // Leads the 30-day retention sweep has moved (src/config/lead-retention.ts). A SEPARATE array
    // from `records`, deliberately — see fetchDeletedRecords for why the two populations are never
    // merged. Empty on every hub but the Lead Generator's.
    deletedRecords: [],
    // Is the Deleted section folded open? Collapsed by default: it is a graveyard, and a user
    // arriving at the Enrichment tab is there for live leads. Part of the view state rather than
    // the DOM for the same reason `collapsed` below is — the section is re-rendered on every
    // refresh and a fold recorded in the markup would spring open.
    deletedOpen: false,
    // What the last "Send back for enrichment" actually achieved, kept as STATE so it survives the
    // repaint that follows it: { title, message, enriched }.
    //
    // ⚠️ This exists because writing the outcome into the row was silently useless. Sending a lead
    // back removes it from this section, so the refresh that follows re-renders the section
    // WITHOUT that row — taking the sentence with it. The sentence is the entire point of the
    // action: it is the only thing that says whether the enrichment pass found an address or
    // found nothing, and "it vanished from the list" cannot distinguish those.
    returnedNotice: null,
    // How the table is being READ right now — the filter/sort/group controls. Kept out of the
    // record list so a refetch (which happens every time the tab is opened) leaves the user's
    // view alone: coming back to a tab you had filtered to "Awaiting you" and finding it reset is
    // the tab losing your place.
    // `page` rides with the rest of the view for the same reason: coming back to a tab you had
    // paged into and landing on page one is the tab losing your place. It is reset by anything that
    // changes WHICH rows are on screen (search, filter, group, sort, Clear) — staying on page 4 of a
    // list that just became eleven rows shows an empty table under a full-looking filter strip.
    // `collapsed` holds the group headings the user has folded shut. A Set, and part of the
    // view rather than the DOM, for the same reason `selected` is: paintRows() rewrites every
    // row on each keystroke, so a fold recorded in the markup would spring open as you typed.
    view: { search: '', filters: {}, sortKey: null, sortDir: 'asc', groupKey: null, page: 1, collapsed: new Set() },
    // Ids ticked for a bulk action. A Set of record ids rather than DOM state, because rows are
    // re-rendered on every filter keystroke and after every PATCH.
    selected: new Set(),
  };

  async function fetchRecords() {
    // Content Library (social/blog Data Hub) reads posts, not assistant_records.
    if (state.hub.kind === 'content_library') { state.records = await fetchContentLibrary(); return; }
    const type = encodeURIComponent(state.hub.recordType);
    const res = await fetch(`${API}?assistantId=${state.assistantId}&recordType=${type}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load records.');
    // ⚠️ LIVE records only. The endpoint defaults to ?retention=live, so leads the 30-day sweep
    // has moved are NOT in here — they are fetched separately below and rendered in their own
    // section. Keeping them out of `state.records` is what stops them appearing in the table, the
    // filters, the group-by counts, the bulk-selection set and the tab count, all of which read
    // this array and all of which describe leads the user can still act on.
    state.records = data.records || [];
    await fetchDeletedRecords();
  }

  /**
   * The Deleted section's rows: leads the retention sweep has moved (src/config/lead-retention.ts).
   *
   * Leads only, and fetched separately rather than filtered out of one big response, for two
   * reasons. The graveyard grows without bound while the live list does not, so folding them into
   * the same fetch would make every Enrichment tab load pay for every lead ever dropped. And
   * `state.records` is read by nine other things (table, filters, groups, counts, selection,
   * paging, CSV, deep-link focus); a single array holding two populations would need each of them
   * to remember which one it meant.
   *
   * Never throws. The Deleted section is supplementary — a failure here must not take down the
   * table of live leads beside it.
   */
  async function fetchDeletedRecords() {
    state.deletedRecords = [];
    if (state.hub.recordType !== 'lead') return;
    try {
      const type = encodeURIComponent(state.hub.recordType);
      const res = await fetch(`${API}?assistantId=${state.assistantId}&recordType=${type}&retention=deleted`);
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      state.deletedRecords = data.records || [];
    } catch {
      // Leave it empty; the section renders nothing rather than an error over live data.
    }
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
    const s = approvalChip(record);
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

  // ── Social profiles (Phase 2 item 7) ────────────────────────────────────────
  //
  // Captured by discovery-enrich.ts from the lead's own footer, at no extra fetch cost, and stored
  // at `data.socialHandles`. The point of showing them is the "None found" lead: two thirds of SMB
  // sites publish no address, and until now that verdict was a dead end. A LinkedIn is not an
  // address, but it is somewhere a human can go next.
  //
  // ⚠️ THE COPY IS THE FEATURE. Nothing in this platform can send a DM — `send_outreach` is
  // email-only and `lead-threads.ts` declares `channel?: 'email' | 'dm'` with nothing anywhere
  // setting 'dm'. A row of social icons next to an outreach product implies an outbound channel
  // that does not exist, so the label says "open" and the note says who does the work.

  // Mirrors SocialPlatformKey in src/lib/discovery-enrich.ts. A key missing here is not a bug that
  // breaks anything — an unrecognised platform is simply not rendered — but it does mean a captured
  // profile silently never reaches the user, so keep the two in step.
  const SOCIAL_LABELS = {
    linkedin: 'LinkedIn', instagram: 'Instagram', facebook: 'Facebook', x: 'X',
    tiktok: 'TikTok', youtube: 'YouTube', pinterest: 'Pinterest', threads: 'Threads',
  };

  /** The valid profile URLs on a lead, keyed by platform. Empty object when there are none. */
  function socialLinksOf(record) {
    const raw = record.data && record.data.socialHandles;
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (SOCIAL_LABELS[k] && typeof v === 'string' && /^https?:\/\//i.test(v.trim())) out[k] = v.trim();
    }
    return out;
  }

  /** One sentence for the Contact tooltip naming what a row has, or '' — table rows carry no links. */
  function socialHint(record) {
    const names = Object.keys(socialLinksOf(record)).map((k) => SOCIAL_LABELS[k]);
    if (names.length === 0) return '';
    // "Instagram, Facebook and TikTok" — a comma-joined list reads as a machine dump in a sentence
    // a person is meant to act on.
    const list = names.length === 1 ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `Open the row for their ${list} profile${names.length > 1 ? 's' : ''}.`;
  }

  /**
   * The profile links on a lead, or null when it has none.
   *
   * ⚠️ Every URL here began as an `href` on a stranger's website — attacker-influenceable input that
   * we are about to put back into an `href`. The scraper only ever stores http/https, but this
   * re-checks rather than trusting it: the value has since been through a jsonb column and the
   * records PATCH endpoint, so the render is the last place that can be sure. Anything else is
   * dropped silently — a `javascript:` URL is not a profile, and there is nothing to tell the user.
   */
  function socialBanner(record) {
    const links = Object.entries(socialLinksOf(record))
      .map(([k, v]) => `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer nofollow"
           class="text-xs font-bold px-2 py-0.5 rounded-full border bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100 cursor-pointer">${esc(SOCIAL_LABELS[k])} &#8599;</a>`);
    if (links.length === 0) return null;

    // Which sentence depends on whether the email search succeeded, because that decides what the
    // user is looking at this for: a fallback route, or extra background on a lead they can already
    // write to. Both say plainly that opening these is a human's job.
    const note = contactEmailOf(record)
      ? 'Background on this lead. Opening a profile is a manual step — nothing here posts or messages.'
      : 'No published email address was found. These are the profiles this company links from its own site — open one to make contact yourself. Nothing here sends a message.';

    const wrap = document.createElement('div');
    wrap.className = 'mb-4';
    wrap.innerHTML = `
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs font-bold text-gray-400 uppercase tracking-wide">Profiles</span>
        ${links.join('')}
      </div>
      <p class="text-xs text-gray-500 mt-1.5">${esc(note)}</p>`;
    return wrap;
  }

  // ── What deep enrichment found ─────────────────────────────────────────────
  //
  // Everything the research pass turned up, on the lead it turned up about: what changed and why,
  // the signals with their sources, and who was named on the company's own pages.
  //
  // ── The rule this panel is built around ────────────────────────────────────
  // EVERY CLAIM CARRIES ITS SOURCE LINK. A model summarising a headline is doing a useful job and
  // is also the single most likely thing on this screen to be subtly wrong, so a user must always
  // be one click from the article it read. Signals arrive pre-filtered to evidence URLs we actually
  // supplied (discovery-scoring.ts) and people are dropped unless their name appears verbatim in
  // the page text (lead-enrichment.ts `verifyPeople`) — this renderer is the last of three gates,
  // not the only one, and it still refuses to draw a signal with no link.
  const SIGNAL_DIRECTION = {
    positive: { icon: '▲', cls: 'text-emerald-700' },
    negative: { icon: '▼', cls: 'text-red-600' },
    neutral: { icon: '•', cls: 'text-gray-500' },
  };

  /**
   * The user's own notes about this lead.
   *
   * ⚠️ Nothing rendered `data.notes` before this. The Edit lead form has written the field since it
   * shipped, so the product invited people to record what they knew about a lead and then never
   * showed it back to them — on any screen, at any stage. A field that can only be written into is
   * indistinguishable from one that discards what you type.
   *
   * Rendered ABOVE the scoring card with the other banners, not inside the field list: these are
   * the one part of a lead record a human wrote, and burying them among scraped values is what
   * would make them easy to miss again.
   */
  // Always returns a node, EMPTY AND HIDDEN when there are no notes yet, rather than returning null
  // the way the other banners do. Saving the first note then has somewhere to put it — it fills and
  // reveals this node in place, instead of working out where among the banners a new element should
  // be inserted into a panel that must not be re-rendered underneath the reader.
  function notesBanner(record) {
    const notes = typeof (record.data || {}).notes === 'string' ? record.data.notes.trim() : '';
    const wrap = document.createElement('div');
    wrap.className = 'mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3';
    wrap.setAttribute('data-lead-notes-banner', '');
    wrap.innerHTML = `
      <p class="text-xs font-bold text-amber-700 uppercase tracking-wide mb-1">Your notes</p>
      <p class="text-xs text-amber-900 whitespace-pre-line" data-lead-notes>${esc(notes)}</p>`;
    // `hidden` loses to any class that sets display; pin the inline style too, as everywhere else.
    if (!notes) { wrap.classList.add('hidden'); wrap.style.display = 'none'; }
    return wrap;
  }

  function intelBanner(record) {
    const d = record.data || {};
    const intel = d.intel && typeof d.intel === 'object' ? d.intel : null;
    if (!intel) return null;

    const signals = (Array.isArray(intel.signals) ? intel.signals : []).filter((s) => s && s.summary && s.url);
    const people = (Array.isArray(intel.people) ? intel.people : []).filter((p) => p && p.name);
    const hooks = (Array.isArray(intel.hooks) ? intel.hooks : []).filter((h) => typeof h === 'string' && h.trim());
    const platforms = Array.isArray(intel.platforms) ? intel.platforms : [];
    const moved = intel.changeSummary && intel.previousRating;

    // "We looked and found nothing" is a RESULT, and a useful one — it is the difference between a
    // lead nobody has researched and one there is genuinely nothing to say about. Rendering nothing
    // here would make the two look identical, which is the same mistake `enrichAttemptedAt` exists
    // to correct on the Contact column.
    if (!signals.length && !people.length && !hooks.length && !platforms.length) {
      const wrap = document.createElement('div');
      wrap.className = 'mb-4 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2';
      wrap.innerHTML = `<p class="text-xs text-gray-600">Researched ${esc(fmtDate(intel.gatheredAt))} — nothing published about this company that would change its rating.</p>`;
      return wrap;
    }

    const wrap = document.createElement('div');
    wrap.className = 'mb-4 rounded-xl border border-gray-200 bg-white p-3';
    wrap.innerHTML = `
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <span class="text-xs font-bold text-gray-400 uppercase tracking-wide">Research</span>
        <span class="text-xs text-gray-400">${esc(fmtDate(intel.gatheredAt))}</span>
        ${moved
          ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-800 border-emerald-200">${esc(intel.changeSummary)}</span>`
          : ''}
      </div>

      ${signals.length ? `
        <ul class="space-y-1.5 mb-3">
          ${signals.map((s) => {
            const dir = SIGNAL_DIRECTION[s.direction] || SIGNAL_DIRECTION.neutral;
            return `<li class="flex items-start gap-2 text-sm">
              <span class="${dir.cls} font-bold shrink-0 mt-0.5">${dir.icon}</span>
              <span class="text-gray-700 min-w-0">${esc(s.summary)}
                <a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer nofollow"
                   class="text-emerald-700 hover:underline font-semibold whitespace-nowrap">source &#8599;</a>
              </span>
            </li>`;
          }).join('')}
        </ul>` : ''}

      ${people.length ? `
        <p class="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">Named on their site</p>
        <ul class="space-y-1 mb-3">
          ${people.map((p) => `<li class="text-sm text-gray-700">
            <span class="font-semibold">${esc(p.name)}</span>${p.title ? ` — ${esc(p.title)}` : ''}
            ${p.sourceUrl ? `<a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener noreferrer nofollow"
                 class="text-emerald-700 hover:underline font-semibold text-xs whitespace-nowrap">page &#8599;</a>` : ''}
          </li>`).join('')}
        </ul>
        <p class="text-xs text-gray-500 mb-3">Taken from the company's own pages. We have no email address for these people, and nothing here contacts them.</p>` : ''}

      ${hooks.length ? `
        <p class="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">Openers</p>
        <ul class="list-disc pl-4 space-y-0.5 mb-3">
          ${hooks.map((h) => `<li class="text-sm text-gray-700">${esc(h)}</li>`).join('')}
        </ul>` : ''}

      ${platforms.length || intel.hasCareersPage ? `
        <div class="flex flex-wrap items-center gap-1.5">
          ${platforms.map((p) => `<span class="text-xs font-semibold px-2 py-0.5 rounded-full border bg-gray-50 text-gray-600 border-gray-200">${esc(p)}</span>`).join('')}
          ${intel.hasCareersPage ? '<span class="text-xs font-semibold px-2 py-0.5 rounded-full border bg-gray-50 text-gray-600 border-gray-200">Careers page</span>' : ''}
        </div>` : ''}`;
    return wrap;
  }

  /**
   * Record (or correct) a lead's deal outcome.
   *
   * ⚠️ The form itself lives in src/components/lead-outcome-modal.js, because the Conversations
   * tab opens the SAME form on the thread a deal happened in. Two implementations of a form whose
   * rules exist to keep revenue aggregates meaningful (a loss needs a reason, only a win takes a
   * value, correcting one appends a second terminal row) is exactly the drift this codebase keeps
   * paying for. This function is now only the Data Hub's half: which record, and what to repaint.
   *
   * This entry point is NOT redundant now that the thread has one. A lead with no address, or one
   * worked entirely offline, has no conversation at all — if outcome capture only lived on the
   * thread, those deals could never be closed off.
   */
  function openOutcomeModal(record) {
    window.LeadOutcomeModal?.open({
      assistantId: state.assistantId,
      recordId: record.id,
      title: record.title,
      existing: (record.data && record.data.dealOutcome) || null,
      onSaved: (dealOutcome) => {
        record.data = { ...(record.data || {}), dealOutcome };
        renderTable();
      },
    });
  }

  /**
   * Delete one record and drop it from the table. Shared by the plain and lead delete paths.
   *
   * `defer` leaves the repaint to the caller. The lead path needs it: the server may come back
   * with a domain worth excluding, that offer is drawn INSIDE the row's own detail panel, and
   * renderTable() rebuilds the table — destroying the panel and the offer with it. So the lead
   * path asks the follow-up first and repaints when the user is done with it.
   */
  async function deleteRecord(id, reason, { defer = false } = {}) {
    const res = await fetch(API, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(reason ? { id, reason } : { id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not delete the record.');
    state.records = state.records.filter((r) => r.id !== id);
    state.selected.delete(id);
    if (!defer) await finishDelete();
    return data;
  }

  /**
   * Repaint after a delete.
   *
   * ⚠️ A REFETCH, not just a render. A deleted LEAD is not gone — it is now in the Deleted
   * section (see the DELETE branch of assistant-records.ts), and that section is fed by a separate
   * `?retention=deleted` fetch. Re-rendering alone would remove the row from the table and put it
   * nowhere, which is precisely the "where did my lead go?" this change exists to answer.
   *
   * Falls back to a plain render if the refetch fails: the row really has gone from the live list,
   * and leaving it on screen would be the worse lie.
   */
  async function finishDelete() {
    try {
      await fetchDeletedRecords();
    } catch { /* the section renders what it last knew; the table below is still correct */ }
    renderTable();
  }

  // ── Deleting a lead: what it does, and why it is the only button here ───────
  //
  // Delete IS the rejection now (2026-08-15). It used to sit beside a separate Reject, and a user
  // opening a lead was asked to choose between two words for what felt like one act — with the
  // consequential difference (Reject kept the record and taught the search; Delete destroyed both)
  // legible only to whoever had read the handler. That is a choice no user should be made to make,
  // so the server was changed instead: deleting a lead marks it rejected, banks the reason, and
  // moves it into the Deleted section rather than dropping the row. One button, and it is the one
  // that does the careful thing.
  //
  // ⚠️ The reason is still asked BEFORE, even though the ordering constraint that forced it has
  // gone (the record survives now, so provenance is resolvable either way). It stays up front
  // because this is the moment the user knows WHY — and because the confirmation is where the copy
  // gets to say the lead is kept, which is the fact that makes pressing it safe.
  function deleteReasonStrip(record) {
    const RC = window.RevenueConstants;
    const strip = document.createElement('div');
    strip.className = 'w-full mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2';
    const reasons = (RC && Array.isArray(RC.leadRejectReasons)) ? RC.leadRejectReasons : [];
    const chip = 'px-2 py-1 text-[11px] font-bold rounded-lg bg-white border border-gray-200 text-gray-700 hover:border-red-300 hover:text-red-700 transition cursor-pointer';

    strip.innerHTML = `
      <p class="text-[11px] font-bold text-gray-800">Delete ${esc(record.title || 'this lead')}?</p>
      <p class="text-[11px] text-gray-600 mb-2">It leaves your list and moves to <strong>Deleted</strong> at the bottom of this tab, marked rejected. Nothing is emailed. It is kept so a later search that finds the same company again leaves it rejected instead of putting it back in front of you — and you can send it back for enrichment from there.</p>
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
        // Deferred: the follow-up below is drawn inside this strip, which the repaint destroys.
        const data = await deleteRecord(record.id, reason, { defer: true });
        // The one follow-up that changes what the NEXT run finds. `canExcludeDomain` is the
        // SERVER's verdict — it needs the reason vocabulary and the discovery provenance, and the
        // browser has neither. This used to hang off Reject; it moved here with the merge, because
        // otherwise removing Reject would have quietly removed the exclusion offer too.
        if (data.canExcludeDomain) {
          offerDomainExclusion(strip, data.domain, data.campaignId, finishDelete);
          return;
        }
        await finishDelete();
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

  // ── Rejecting a lead — REMOVED from this tab 2026-08-15 ────────────────────
  //
  // `rejectReasonStrip` and the Reject button that opened it are gone. Delete now performs the
  // rejection (see deleteReasonStrip above and the DELETE branch of assistant-records.ts), so the
  // two buttons had become two names for one act, differing only in where the row ended up.
  //
  // ⚠️ Two things that are NOT the same as this, and both still exist:
  //   • The Outreach tab's Approve / Reject. That gate is real and load-bearing — approving there
  //     SENDS the drafted email, and rejecting is how you decline to send it. Untouched.
  //   • "Record outcome → Disqualified", which answers "we pursued this and it went nowhere" — a
  //     fault in the DEAL, not in the TARGETING. Using it for a bad discovery hit puts a dead deal
  //     in the revenue numbers for a company nobody ever contacted.
  //
  // The reason capture itself did not go: it moved into the delete confirmation, and the domain
  // exclusion below is still offered from there.

  /**
   * The one follow-up that changes what the next run finds: block this company's domain.
   *
   * A DOMAIN rather than a keyword, for the same reason the Review Queue's copy of this does it:
   * negative keywords are a substring match over title and snippet, so a well-meant "agency" also
   * deletes every prospect whose page happens to mention one. A domain match is exact.
   *
   * `onDone` runs when the user is finished with the offer, either way. It carries the repaint the
   * delete deferred — this strip lives in the row's detail panel, and repainting before the user
   * has answered would take the question off the screen mid-thought. Every exit calls it: yes, no
   * thanks, and the failure path, or a failed exclusion would strand the table showing a lead that
   * is no longer in it.
   */
  function offerDomainExclusion(strip, domain, campaignId, onDone) {
    const done = () => { if (typeof onDone === 'function') onDone(); };
    strip.innerHTML = `
      <p class="text-[11px] font-bold text-gray-700">Noted. Stop this search finding <span class="font-mono">${esc(domain)}</span>?</p>
      <p class="text-[11px] text-gray-500 mb-2">Adds the domain to this search’s exclusions. You can remove it later by editing the search.</p>
      <div class="flex flex-wrap gap-1.5">
        <button type="button" class="px-2 py-1 text-[11px] font-bold rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white transition cursor-pointer" data-hub-exclude>Yes, exclude it</button>
        <button type="button" class="px-2 py-1 text-[11px] font-bold rounded-lg text-gray-400 hover:text-gray-600 transition cursor-pointer" data-hub-exclude-skip>No thanks</button>
      </div>
      <p class="hidden text-[11px] font-semibold mt-1.5" data-hub-exclude-status></p>`;

    const status = strip.querySelector('[data-hub-exclude-status]');
    strip.querySelector('[data-hub-exclude-skip]').addEventListener('click', () => { strip.remove(); done(); });
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
        // A toast, not text in the strip: `done()` below repaints the table, which takes this
        // strip with it. Written into the strip the confirmation would flash and vanish, and the
        // user would never learn whether the exclusion took.
        window.showToast?.(`${domain} won’t come back in this search.`);
      } catch (err) {
        strip.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        status.textContent = err.message || 'Could not exclude that domain.';
        status.className = 'text-[11px] font-semibold text-red-600 mt-1.5';
        // ⚠️ The DELETE already committed. Failing to exclude the domain must not leave the caller
        // waiting on a repaint that never comes — the lead is gone from the live list either way.
        done();
        return;
      }
      done();
    });
  }

  // ── Clearing out a selection ────────────────────────────────────────────────
  //
  // Deleting one lead at a time is fine when there is one bad lead. A search that came back aimed
  // at the wrong market returns forty, and the only way to clear them was to open, delete, and
  // find your place again, forty times — which is how the Leads tab silently became somewhere
  // people stopped tidying, and how storage kept growing on rows nobody wanted.
  //
  // ⚠️ The reason is asked ONCE, for the whole selection, and BEFORE anything is deleted. One
  // reason for forty leads is the honest shape of the act: a user clearing a bad search is making
  // ONE judgement about all of them, and that judgement is exactly what the targeting feedback
  // wants to hear. Asking per lead would buy forty worse answers, or forty skips.
  //
  // The bulk path offers no domain-exclusion follow-up, and should not: one reason across forty
  // leads spans forty domains, and there is no single search to narrow.

  /** Delete a set of records in one pass, banking the reason against every one of them. */
  async function deleteRecords(ids, reason) {
    // Chunked to the server's MAX_BULK. Going over is a 400 there rather than a silent
    // truncation, so the split has to happen here — and it is sequential, because each chunk is
    // already several round trips per id and firing them together would race the same tables.
    const CHUNK = 100;
    let deleted = 0;
    let notFound = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const res = await fetch(API, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(reason ? { ids: slice, reason } : { ids: slice }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Report the partial truthfully. Rows in earlier chunks really are gone, and telling the
        // user "delete failed" would have them press it again on a list that has already changed.
        state.records = state.records.filter((r) => !ids.slice(0, i).includes(r.id));
        throw new Error(deleted
          ? `${deleted} deleted, then it stopped: ${data.error || 'the rest could not be deleted.'}`
          : (data.error || 'Could not delete those records.'));
      }
      deleted += Number(data.count) || 0;
      notFound += Number(data.notFound) || 0;
    }
    const gone = new Set(ids);
    state.records = state.records.filter((r) => !gone.has(r.id));
    for (const id of ids) state.selected.delete(id);
    // Refetches the Deleted section rather than just re-rendering: for leads these rows have MOVED
    // there, and a repaint alone would show them leaving the table and arriving nowhere.
    await finishDelete();
    return { deleted, notFound };
  }

  // Bulk REJECT was here (built 2026-08-15, removed the same day). It is not a capability loss:
  // bulk DELETE now does exactly what it did — marks every selected lead rejected, banks one
  // reason against all of them, and leaves a re-found company rejected rather than re-queued —
  // and additionally files them in the Deleted section. Two buttons on one bar, one of them
  // labelled with the scarier word while being the *safer* act, was the confusion this removes.
  // The server's bulk-reject PATCH branch is untouched and still tested; nothing on this screen
  // calls it any more.

  /** The confirmation for a bulk delete: what is about to go, and the chance to say why. */
  function bulkDeleteStrip(ids) {
    const RC = window.RevenueConstants;
    const isLead = state.hub.recordType === 'lead';
    const n = ids.length;
    const noun = n === 1 ? 'record' : 'records';
    const strip = document.createElement('div');
    strip.className = 'mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2';
    const reasons = (isLead && RC && Array.isArray(RC.leadRejectReasons)) ? RC.leadRejectReasons : [];
    const chip = 'px-2 py-1 text-[11px] font-bold rounded-lg bg-white border border-gray-200 text-gray-700 hover:border-red-300 hover:text-red-700 transition cursor-pointer';

    strip.innerHTML = `
      <p class="text-xs font-bold text-gray-800">Delete ${n} ${esc(noun)}?</p>
      <p class="text-[11px] text-gray-600 mb-2">${isLead
        ? 'They leave your list and move to <strong>Deleted</strong> at the bottom of this tab, marked rejected. Nothing is emailed. They are kept so a later search that finds the same companies again leaves them rejected instead of putting them back in front of you.'
        : 'This removes them for good.'}</p>
      ${reasons.length ? `<div class="flex flex-wrap gap-1.5">
        ${reasons.map((r) => `<button type="button" class="${chip}" data-hub-bulk-reason="${esc(r)}">${esc(RC.leadRejectReasonLabel(r))}</button>`).join('')}
      </div>
      <p class="text-[11px] text-gray-500 mt-1.5">Pick one reason for all ${n} — it is recorded against every one of them, and it is what teaches the search. Clearing leads nobody could contact? <strong>${esc(RC.leadRejectReasonLabel('bad_contact'))}</strong> — it records the problem without telling the search to look somewhere else.</p>` : ''}
      <div class="flex flex-wrap items-center gap-2 mt-2">
        <button type="button" class="px-2 py-1 text-[11px] font-bold rounded-lg bg-white border border-red-200 text-red-700 hover:bg-red-100 transition cursor-pointer" data-hub-bulk-plain>Delete without a reason</button>
        <button type="button" class="px-2 py-1 text-[11px] font-bold rounded-lg text-gray-500 hover:text-gray-700 transition cursor-pointer" data-hub-bulk-cancel>Cancel</button>
      </div>
      <p class="hidden text-[11px] font-semibold mt-1.5" data-hub-bulk-status></p>`;

    const status = strip.querySelector('[data-hub-bulk-status]');
    strip.querySelector('[data-hub-bulk-cancel]').addEventListener('click', () => strip.remove());

    const go = async (reason) => {
      strip.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      status.classList.remove('hidden');
      status.className = 'text-[11px] font-semibold text-gray-500 mt-1.5';
      status.textContent = `Deleting ${n} ${noun}…`;
      try {
        const { deleted, notFound } = await deleteRecords(ids, reason);
        // renderTable() has already replaced this strip's parent; the toast is what survives.
        // For leads it names the destination — a row vanishing from a table it was just filtered
        // in is exactly the moment "where did that go?" gets asked.
        window.showToast?.(`Deleted ${deleted} ${deleted === 1 ? 'record' : 'records'}.`
          + (isLead ? ' They’re in Deleted at the bottom of this tab.' : '')
          + (notFound ? ` ${notFound} had already gone.` : '')
          + (reason && isLead ? ' The reason was recorded against each one.' : ''));
      } catch (err) {
        strip.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        status.className = 'text-[11px] font-semibold text-red-600 mt-1.5';
        status.textContent = err.message || 'Could not delete those records.';
      }
    };

    strip.addEventListener('click', (e) => {
      const chosen = e.target.closest('[data-hub-bulk-reason]');
      if (chosen) { go(chosen.getAttribute('data-hub-bulk-reason')); return; }
      if (e.target.closest('[data-hub-bulk-plain]')) go(undefined);
    });
    return strip;
  }

  // ── Who performs the suggested next step ────────────────────────────────────
  //
  // The lead card's "Suggested next step" is a sentence the model wrote — "Email the head of ops",
  // "Call them this week", "Check whether they still do this in-house". It rendered as an
  // instruction with no subject, and a user could not tell whether it described work the assistant
  // was about to do or work waiting on them. Both readings are true of different leads: an emailed
  // lead really is chased for you, and everything else on that list is yours alone.
  //
  // ⚠️ Decided from the lead's STATE, never from the sentence. Regex-matching model prose to guess
  // "is this an email step?" is a coin flip that reads as a rule, and getting it wrong here tells
  // someone their assistant is handling a call it cannot make. The four facts below are the ones
  // the platform actually acts on:
  //
  //   • `data.outreachSentAt`  — stamped by lead-generation.ts `send_outreach` on a CONFIRMED send,
  //     alongside the follow-up enrolment. This is the only marker that means mail has left; the
  //     'scheduled' approval status rides with it (it is the chase reminder) but is written in the
  //     same statement, so the stamp is the honest thing to read.
  //   • an address at all     — outreach is email-only, so a lead without one is inert whatever
  //     else is true of it.
  //   • the approval gate     — approving HERE records a targeting decision and sends nothing (see
  //     the Approve handler below). The send lives in the Review tab.
  //   • a recorded outcome    — a decided lead has no next step worth chasing.
  //
  // `action.key` is matched to a button in detailActions() by `data-hub-action`, so the next-step
  // button and the action bar can never drift into doing two different things — it presses the
  // real control. 'open-review' is the one exception: there is no such button, it switches tabs.
  /** The Outreach/Review tab as THIS role names it — a sentence must never send someone to a tab
   *  they cannot see. `_detailReviewQueue` is the same registry config that labelled the button. */
  function reviewTabLabel() {
    return (window._detailReviewQueue || {}).label || 'Review';
  }

  /** Ditto for Conversations. The span carries setTabCount's " (12)"; a badge is not a tab name. */
  function conversationsTabLabel() {
    const el = document.getElementById('conversations-tab-label');
    const raw = el ? el.textContent.trim() : '';
    return raw.replace(/\s*\(\d+\)\s*$/, '') || 'Conversations';
  }

  /** Whether the Conversations tab is actually on screen and reachable. Lead roles only, and
   *  `_activateMainTab` is absent when this hub renders inside the Searches tab's modal. */
  function conversationsTabAvailable() {
    const btn = document.querySelector('.main-tab-btn[data-maintab="conversations"]');
    return !!(btn && !btn.classList.contains('hidden') && typeof window._activateMainTab === 'function');
  }

  /**
   * Has this lead already been through the approval gate?
   *
   * ⚠️ `approvalStatus === 'approved'` is NOT the whole answer, and testing it alone put an Approve
   * button on leads whose email had already been sent. A successful send leaves the record
   * 'scheduled' — that state is the CHASE REMINDER, not a pending send (lead-generation.ts
   * `send_outreach`, and "Mark outreach sent" does the same) — so every contacted lead read as
   * un-approved and was offered a button to clear it for outreach that had already gone out.
   *
   * The two states together are what "approved" means for a lead, exactly as the Outreach tab's
   * Approved column asks for both (`approvalStatus=approved,scheduled`). `outreachSentAt` is the
   * third arm for the same reason it is the honest marker everywhere else: whatever the column
   * says, an email that has left cannot be un-sent by approving it.
   *
   * ⚠️ Rejected is deliberately NOT past the gate. Reversing a rejection is a legitimate
   * correction, and the Approval cell states the result either way.
   *
   * ⚠️ Read by nextStepGuidance() AND detailActions(), and it must stay that way. The footer
   * PRESSES the bar's button, so a rule that hides Approve in one and promotes it in the other
   * leaves a button that does nothing — see [[next-step-footer-owns-the-button]].
   */
  function isPastApprovalGate(record) {
    const s = record.approvalStatus;
    if (s === 'approved' || s === 'scheduled') return true;
    return !!(record.data || {}).outreachSentAt;
  }

  /**
   * Does this lead have a conversation thread to record its outcome against?
   *
   * A thread is minted by lead-generation.ts `openLeadThread`, immediately before a real send —
   * so a lead WE emailed always has one, and it is the surface that owns the outcome (the same
   * shared modal, on the screen that also holds the reply). Everything else does not:
   *
   *   • never contacted        — no send, no thread. Disqualifying it is still a real outcome, and
   *     `not_icp` on an untouched lead is the cleanest targeting signal there is.
   *   • "Mark outreach sent"   — the user contacted them some other way. That path stamps
   *     `outreachSentVia: 'manual'` and mints NOTHING, so the lead never reaches Conversations.
   *   • stamped before `outreachSentVia` existed — genuinely ambiguous. Treated as thread-less on
   *     purpose: a duplicate button is a nuisance, a lead whose outcome can be recorded NOWHERE is
   *     a dead end, and only one of those is worth risking.
   */
  function hasConversationThread(record) {
    const via = (record.data || {}).outreachSentVia;
    return via === 'google' || via === 'microsoft';
  }

  function nextStepGuidance(record) {
    if (state.hub.recordType !== 'lead') return null;
    const d = record.data || {};

    // ⚠️ FIRST, ahead of every other terminal state. An erased lead has no address, so without this
    // it falls through to "add an address" — and the footer OWNS that button, which the bar no
    // longer draws for an erased lead, leaving a promoted control that does nothing when pressed.
    // It is also the truest thing to say: erased outranks rejected or approved as a description of
    // where this lead stands.
    if (isErasedLead(record)) {
      return { owner: 'closed', action: null,
        note: 'This lead was erased at the request of the person it named. Their details are gone, their address stays on your do-not-contact list, and nothing here can look them up again.' };
    }

    const outcome = d.dealOutcome && d.dealOutcome.outcome;
    if (outcome) {
      const RC = window.RevenueConstants;
      const label = RC ? RC.outcomeLabel(outcome) : String(outcome);
      return { owner: 'closed', action: null,
        note: `This lead is marked ${label}. Nothing further is sent, and any follow-ups have stopped.` };
    }

    if (record.approvalStatus === 'rejected') {
      return { owner: 'closed', action: null,
        note: 'This lead is rejected, so nothing will be sent. Approve it below if you want to pursue it after all.' };
    }

    if (d.outreachSentAt) {
      // A lead we emailed has a thread, and the thread owns its outcome — that screen holds the
      // reply the outcome is a judgement about, where this one holds the company record. So the
      // next step here is to GO there, not to record it in a second place.
      if (hasConversationThread(record) && conversationsTabAvailable()) {
        const conv = conversationsTabLabel();
        return { owner: 'assistant', action: { key: 'open-conversations', label: `Open ${conv}` },
          note: `The outreach email has gone and the follow-ups are handled for you. Anything else in that step — a call, a meeting, a look at their site — is yours, and you record how it ends on the conversation in ${conv}.` };
      }
      // No thread means we did not send it — see hasConversationThread. On the "Mark outreach sent"
      // path that is literally true of the follow-ups too: `enrolInSequence` runs only on a
      // confirmed send, so telling this user their chases are handled would promise a cadence that
      // was never enrolled. The owner chip goes with it: nothing here is the assistant's to do.
      if (d.outreachSentVia === 'manual') {
        return { owner: 'you', action: { key: 'record-outcome', label: 'Record outcome' },
          note: 'You marked this lead as contacted yourself. Nothing was emailed from here and no follow-ups are scheduled, so chasing it is yours — record how it ends when you know.' };
      }
      return { owner: 'assistant', action: { key: 'record-outcome', label: 'Record outcome' },
        note: 'The outreach email has gone and the follow-ups are handled for you. Anything else in that step — a call, a meeting, a look at their site — is yours.' };
    }

    if (!contactEmailOf(record)) {
      return { owner: 'you', action: { key: 'add-address', label: 'Add an address' },
        note: 'There is no email address on this lead, so nothing can be sent for you until you add one.' };
    }

    if (isPastApprovalGate(record)) {
      // Only offered when the tab switcher is actually there. assistant-data-hub also renders
      // inside a modal from the Searches tab, where the page around it is the same one — but a
      // button that silently does nothing is worse than no button, so it is gated on the function.
      const canOpenReview = typeof window._activateMainTab === 'function';
      const rq = reviewTabLabel();
      return { owner: 'you', action: canOpenReview ? { key: 'open-review', label: `Open ${rq}` } : null,
        note: `Approved — but nothing has been sent yet. The drafted email is waiting for you in the ${rq} tab.` };
    }

    // Research before approving. This is the one control on this tab that can change a lead's
    // RATING — it reads their site and recent news and re-scores against what it finds — so on a
    // lead nobody has looked at yet it is genuinely the next step, and the approve decision below
    // is better for having waited for it. Offered only while there is no `intel`: once the research
    // has run, re-running it is a tool on the bar, not the thing to do next.
    if (!d.intel) {
      return { owner: 'you', action: { key: 'enrich', label: 'Research this lead' },
        note: 'Nothing has been researched on this company yet. Researching reads their site and recent news and re-scores the lead, so your approve decision rests on more than the first pass.' };
    }

    return { owner: 'you', action: { key: 'approve', label: 'Approve' },
      note: `Approving clears this lead for outreach. The email itself goes out when you approve it in the ${reviewTabLabel()} tab.` };
  }

  /**
   * Wire the card's next-step button to the control that already does the job.
   *
   * It PRESSES the action-bar button rather than repeating its fetch: the bar's handlers own the
   * status line, the disabled state, the approval chip refresh and the reject/delete strips, and a
   * second copy of any of that is a second place for them to disagree. The bar sits below the card
   * in the same panel, so the click is also scrolled into view — the effect of pressing the
   * next-step button is a sentence appearing further down the page.
   */
  /**
   * Re-state who owns the next step, after a decision has changed the answer.
   *
   * Approving a lead makes "Approving clears this lead for outreach" false, and the panel around
   * it is deliberately not rebuilt (that would collapse the record the user is reading and throw
   * away the reject-reason strip that Reject appends underneath). So this swaps the one node whose
   * sentence has gone stale — the same fix, and the same reason, as the approval chip beside it.
   */
  function syncNextStepFooter(panel, record) {
    const host = panel && panel.querySelector('[data-next-step-footer]');
    const build = window.DisruptiveUIRegistry && window.DisruptiveUIRegistry.nextStepFooterHtml;
    if (!host || !build) return;
    const html = build(nextStepGuidance(record));
    if (html) host.outerHTML = html; else host.remove();
  }

  function wireNextStepAction(panel) {
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-lead-next-step]');
      if (!btn) return;
      const key = btn.getAttribute('data-lead-next-step');
      if (key === 'open-review') {
        window._activateMainTab?.('review-queue');
        return;
      }
      if (key === 'open-conversations') {
        window._activateMainTab?.('conversations');
        return;
      }
      const target = panel.querySelector(`[data-hub-action="${key}"]`);
      if (!target) return;                       // the state moved on — do nothing rather than lie
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.click();
      btn.disabled = true;
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
  //
  // `opts.hasNextStepFooter` — whether the card above actually drew a next-step footer. It decides
  // whether this bar may hide the button that footer promotes; see the loop at the bottom.
  function detailActions(record, opts) {
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
      // The Contact chip has been telling users to "add an address by hand" for a while, and the
      // only place to do it was an Email field three items down a modal called "Edit lead" — a
      // remedy nobody would find from the sentence offering it. On a lead with no address this is
      // the only action that unblocks anything, so it leads the row and says what it does.
      // ⚠️ Every button in this block goes and COLLECTS the person again, so all three are gated on
      // the erasure. The server refuses them too (lead-generation.ts `isErasedLead`) — this is the
      // half that stops the tab from offering an action it will then refuse.
      const erased = isErasedLead(record);
      if (!erased && !contactEmailOf(record)) {
        buttons.push({ label: 'Add an address', key: 'add-address', async run(btn) {
          btn.disabled = false;
          openEditLeadModal(record, { focus: 'contactEmail' });
        }});
      }
      // "Look again" is offered ONLY on a lead we have actually looked at and found nothing on
      // (state 'none'). On every other no-address state the stamp it clears is already absent, so
      // the button would be a no-op dressed as an action: 'missed' and 'checking' are unstamped by
      // definition, and 'unchecked' is a cold lead the scraper skips on rating.
      if (!erased && contactState(record) === 'none') {
        buttons.push({ label: 'Look again', key: 'look-again', async run(btn, status) {
          const res = await fetch('/.netlify/functions/lead-generation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ action: 'look_again', assistantId: state.assistantId, recordId: record.id }),
          });
          const data = await res.json().catch(() => ({}));
          // The server refuses for reasons the browser cannot evaluate — whether the lead came from
          // a search at all, whether a domain is on file, what the discovery-side rating is. Show
          // its sentence rather than a generic failure.
          if (!res.ok) throw new Error(data.error || 'Could not re-queue this lead.');
          delete record.data.enrichAttemptedAt;
          btn.textContent = 'Queued ✓'; btn.disabled = true;
          // ⚠️ Says what actually happens, and no more. Clearing the stamp does not scrape anything:
          // enrichment only runs inside a live discovery job on this lead's own campaign. Promising
          // a lookup that nothing has been scheduled to perform is the same lie "Checking…" used to
          // tell, and item 11 exists because of it.
          status.textContent = 'Queued. This company’s site will be read again the next time this search runs — start one from the Searches tab.';
          // Reset the class: a previous failure in this row leaves `status` red, and a success
          // message in red reads as another error.
          status.className = 'text-xs font-semibold text-gray-600 w-full';
          refreshRow(record);
        }});
      }
      // ── Research this lead ──
      // The one control on this tab that can change a lead's RATING, and the reason the tab is
      // called Enrichment. It researches the company — recent funding, hiring, expansion, press,
      // who is named on their site, what their site is built with — and re-reads the score against
      // what it finds (lead-generation.ts `enrich_lead`).
      //
      // ⚠️ Deliberately per-lead, and deliberately not offered in bulk. Every press spends real
      // money on searches and a model call; a "research all" button would be one click costing a
      // few hundred searches. The nightly cadence is the batched path and it has an operator cap.
      //
      // Offered on every lead including rejected ones: "was I wrong to turn this down?" is exactly
      // the question this answers, and the evidence is what makes the answer worth anything.
      if (!erased) buttons.push({
        label: record.data?.intel ? 'Research again' : 'Research this lead',
        key: 'enrich',
        async run(btn, status) {
          btn.textContent = 'Researching…';
          status.textContent = 'Reading their site and searching for recent news — this takes a few seconds.';
          status.className = 'text-xs font-semibold text-gray-600 w-full';
          const res = await fetch('/.netlify/functions/lead-generation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ action: 'enrich_lead', assistantId: state.assistantId, recordId: record.id }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            btn.textContent = 'Research this lead';
            throw new Error(data.error || 'Could not research that lead.');
          }
          btn.textContent = 'Researched ✓';
          // The server's own sentence. It is the only thing that knows whether the rating actually
          // moved, and a generic "Done" over a lead that came back unchanged would imply progress
          // that did not happen — the same failure the send-back message exists to avoid.
          status.textContent = data.message || 'Done.';
          status.className = `text-xs font-semibold w-full ${data.changed ? 'text-emerald-700' : 'text-gray-600'}`;
          // Refresh so the new rating, reasons, draft and the Research panel all appear. The panel
          // is rebuilt from the server rather than patched: this pass rewrites four fields on the
          // record and patching them one by one is four chances to miss one.
          //
          // ⚠️ Re-open the row afterwards. The refresh re-renders the table, which COLLAPSES the
          // panel the user is reading and takes the status line above with it — so without this the
          // whole visible result of pressing the button is a row quietly changing colour somewhere
          // in a list. The re-opened panel carries the same news in a durable form: the Research
          // banner's "cold 41 → hot 88" chip is stored on the record, where the status line was not.
          state.pendingFocusId = record.id;
          state.pendingFocusTone = 'neutral';
          await refresh();
        },
      });
      buttons.push({ label: 'Edit', key: 'edit', async run(btn) {
        btn.disabled = false;           // opening a modal shouldn't leave the button stuck disabled
        openEditLeadModal(record);
      }});
      // Notes — offered on EVERY lead in EVERY state, with no gate at all. That is the point: the
      // thing a user wants to write down ("they said call back in March", "wrong contact, ask for
      // Dave") arrives at whatever stage the lead happens to be at, and a note you can only take
      // while a lead sits in one particular column is a note you will not take.
      buttons.push({
        label: record.data?.notes ? 'Notes' : 'Add a note',
        key: 'notes',
        async run(btn) {
          btn.disabled = false;
          window.LeadNotesModal?.open({
            assistantId: state.assistantId,
            recordId: record.id,
            title: record.title,
            existing: record.data?.notes || '',
            onSaved(notes) {
              // Patch the ONE node that has gone stale rather than re-rendering: the panel around
              // this is deliberately not rebuilt (that would collapse the record the user is
              // reading), the same reason the approval chip and next-step footer are swapped in
              // place after a decision.
              record.data = { ...(record.data || {}), notes };
              const panel = btn.closest('[data-hub-detail]');
              const banner = panel && panel.querySelector('[data-lead-notes-banner]');
              if (banner) {
                banner.querySelector('[data-lead-notes]').textContent = notes;
                banner.classList.remove('hidden');
                banner.style.display = '';
              }
              btn.textContent = 'Notes';
              refreshRow(record);
            },
          });
        },
      });
      // Recording a won/lost deal belongs to the CONVERSATION once there is one: that screen shows
      // the reply the verdict is a judgement about, and this one shows the company record. Both
      // wrote through the same shared modal, so the button here was a second door onto a decision
      // that has an obvious home — on a tab whose whole job is enriching and triaging leads.
      //
      // Kept for leads with no thread, which Conversations never shows and which would otherwise
      // have no way to record an outcome at all: leads never contacted, and leads the user
      // contacted by hand. See hasConversationThread.
      if (!hasConversationThread(record) || !conversationsTabAvailable()) {
        buttons.push({
          label: record.data?.dealOutcome?.outcome ? 'Change outcome' : 'Record outcome',
          key: 'record-outcome',
          async run(btn) {
            btn.disabled = false;
            openOutcomeModal(record);
          },
        });
      }
      // ⚠️ No outreach-email actions on this tab, deliberately. "Copy outreach draft" used to sit
      // here, beside "Draft Outreach in Gmail" inside the card above it — two ways to take the
      // drafted email somewhere, on a screen that never showed the email's text. Reading, editing,
      // copying, drafting into Gmail and sending all live in the REVIEW tab, on one card with the
      // message in front of you. This tab is for the lead record: read it, progress its next step,
      // enrich it, decide on it, delete it.
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
      // Offered for anything not already through the gate — which includes SENT leads, whose
      // record rests at 'scheduled' rather than 'approved'. Testing 'approved' alone put an
      // "Approve" button on every lead whose email had already gone out, offering to clear it for
      // an outreach the recipient had already received. Not hidden for rejected leads: reversing a
      // rejection is a legitimate correction, and the Approval cell states the result either way.
      // See isPastApprovalGate — nextStepGuidance reads the SAME rule, or the footer promotes a
      // button this bar no longer draws.
      if (!isPastApprovalGate(record)) {
        // `primary`: the one decision this panel exists to take. Everything else here is a tool
        // (edit it, copy the draft, log an outcome) — those are reached deliberately, this is the
        // thing the reader arrived to do.
        buttons.push({ label: 'Approve', primary: true, key: 'approve', async run(btn, status) {
          const res = await fetch(API, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: record.id, approvalStatus: 'approved' }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Could not approve that lead.');
          record.approvalStatus = 'approved';
          // Becomes a STATE, not a button that still looks pressable. It stayed enabled reading
          // "Approved", so the obvious next thing to do with it was press it again — which re-sent
          // the same approval. The chip below and the row's Approval cell carry the state; this
          // just stops offering an action that has already been taken.
          btn.textContent = 'Approved ✓';
          btn.disabled = true;
          // Same two surfaces the reject path updates: the row's Approval cell and the banner on
          // the open record. refreshRow rewrites cells in place rather than re-rendering the
          // table, which would collapse the panel the user is still reading.
          refreshRow(record);
          const chip = btn.closest('[data-hub-detail]')?.querySelector('[data-hub-approval]');
          if (chip) chip.innerHTML = `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${APPROVAL_CHIP.approved.cls}">${esc(APPROVAL_CHIP.approved.label)}</span>`;
          // Third surface stating the same fact: the next-step footer, whose sentence was about
          // what approving WOULD do.
          syncNextStepFooter(btn.closest('[data-hub-detail]'), record);
          // Say what did and did not happen. A user who has used the Review Queue has learned that
          // approving sends — leaving that unsaid here would let them believe mail went out.
          const LR = window.LeadRecipient;
          const reachable = LR && typeof LR.isDeliverable === 'function' && LR.isDeliverable(record.data);
          status.textContent = reachable
            ? 'Approved. Nothing has been sent — the drafted email is waiting for you in the Review tab.'
            : 'Approved. Nothing has been sent: there’s no contact address for this lead yet.';
        }});
      }

      // A Reject button stood here until 2026-08-15. It is gone, not moved: Delete below performs
      // the rejection — same approval_status, same banked reason, same domain-exclusion follow-up —
      // and additionally files the lead under Deleted. Offering both meant asking the reader of one
      // lead to choose between two words for one act, where the real difference (Reject kept the
      // record, Delete destroyed it) was invisible from the screen.
      //
      // ⚠️ This did NOT touch the Outreach tab's Approve / Reject. That reject declines to SEND a
      // drafted email and has no substitute here.
    }

    // Deleting a LEAD asks why first — see deleteReasonStrip. Every other record type deletes as
    // before, and for them "delete" still means the row is gone.
    buttons.push({ label: 'Delete', danger: true, key: 'delete', async run(btn, status) {
      if (state.hub.recordType === 'lead') {
        btn.disabled = false;   // the strip owns the action now; leave the button usable
        status.parentElement?.appendChild(deleteReasonStrip(record));
        return;
      }
      await deleteRecord(record.id);
    }});

    const status = document.createElement('p');
    status.className = 'text-xs text-gray-400 w-full';

    // ── Exactly one button per action ───────────────────────────────────────────
    //
    // The next-step footer PRESSES a button in this bar rather than repeating its fetch, which is
    // what keeps the status line, the disabled state and the approval-chip refresh in one place.
    // The side effect was two identical buttons in one panel: an emerald "Approve" in the footer
    // and an emerald "Approve" here, four inches apart, doing the same thing. A reader cannot tell
    // two same-labelled buttons apart except by pressing one, and the whole point of the footer is
    // to say which single thing to do next.
    //
    // So the footer OWNS the promoted action's button and this bar hides its copy. The handler and
    // its status line still live here — the hidden button is what the footer clicks — so nothing
    // about the flow moves, only which copy is on screen. Everything the footer did not promote
    // stays visible here as a tool.
    //
    // ⚠️ `hidden` alone loses to any class that sets display, and these are flex children — pin the
    // inline style too, the same fix the tab badges carry.
    //
    // ⚠️ ONLY when the footer was actually drawn. The card above is not guaranteed to exist: a lead
    // whose `data` carries no recognised uiElement type falls back to a plain key/value list, which
    // has no footer at all. Hiding the promoted button on one of those would leave the action with
    // no button anywhere in the panel — Approve, on a tab whose whole job is approving leads.
    const promoted = (opts && opts.hasNextStepFooter) ? nextStepGuidance(record) : null;
    const promotedKey = promoted && promoted.action ? promoted.action.key : null;

    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      // The handle nextStepGuidance()'s action button presses. Set here rather than per-push so a
      // button that gains a key never has to remember to render it.
      if (b.key) btn.setAttribute('data-hub-action', b.key);
      if (b.key && b.key === promotedKey) {
        btn.classList.add('hidden');
        btn.style.display = 'none';
      }
      // Three weights, matching the rest of the app: the emerald fill for the one decision this
      // panel exists to take, the white ghost for everything else, and the red ghost for Delete.
      // Every button here was the same ghost, so a row reading "Edit · Record outcome · Copy
      // outreach draft · Approve · Reject" offered five equal-looking choices and no way in.
      btn.className = b.danger
        ? 'px-3 py-1.5 bg-white border border-gray-200 text-red-600 hover:border-red-300 hover:bg-red-50 text-xs font-bold rounded-lg transition disabled:opacity-60 ml-auto'
        : b.primary
          ? 'px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed'
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
  /**
   * "They asked me to delete their data" — the same act as the one on a conversation
   * (assistant-lead-threads.js), offered here because this is where a lead is read when there is no
   * conversation to read it from: a request that arrived by phone, by post, or through a colleague.
   *
   * ⚠️ NOT a button in the action bar, and deliberately not beside Delete. Delete is the rejection
   * (see deleteReasonStrip) and its whole promise is that the lead is KEPT — the confirmation says
   * so, because that is the fact that makes pressing it safe. Erasing is the opposite promise. Two
   * red buttons an inch apart, one keeping the record and one destroying it, is exactly the
   * two-words-for-one-act trap that had Reject removed from this tab; so this gets its own strip at
   * the foot of the panel, in grey, with the difference written out.
   *
   * ⚠️ Offered on a lead with NO address too, which is most of them — enrichment finds one for
   * roughly a lead in three. The other two still hold a person: a name, a job title, the colleagues
   * found on their site, a paragraph of research quoting them. Those are the leads whose subject
   * never gave us anything and has the least reason to expect us to hold it, and the erasure is
   * keyed on the record instead. What changes is the BLOCK — with no address there is no
   * do-not-contact grain, so the company's domain is excluded from every search instead, and the
   * copy has to say so before the button is pressed rather than after.
   */
  function erasureStrip(record) {
    if (state.hub.recordType !== 'lead') return null;

    const strip = document.createElement('div');
    strip.className = 'mt-3 pt-3 border-t border-gray-100';

    if (isErasedLead(record)) {
      // Says WHEN, because "did we action that request?" is the question this record now exists to
      // answer, and the date is the whole answer.
      strip.innerHTML = `<p class="text-[11px] text-gray-500">
        Erased at this person&rsquo;s request on ${esc(fmtDate(record.data.erasedAt))}. What is left is the shape of the
        lead with nothing identifying them in it. Their address stays on your do-not-contact list, and this lead
        cannot be looked up again.</p>`;
      return strip;
    }

    const email = contactEmailOf(record);

    strip.innerHTML = `
      <div class="flex items-start gap-3 flex-wrap">
        <p class="text-[11px] text-gray-500 flex-1 min-w-[12rem]">
          Asked you to delete their details? Erasing removes ${email ? 'their address, ' : ''}their messages and everything
          researched about them &mdash; and ${email
            ? 'keeps them on your do-not-contact list, so no future search can find them and start this again.'
            : 'blocks this company from every search, so nobody there is found again. There is no address on this lead to block instead.'}
          Your own funnel history stays, carrying nothing that identifies them.</p>
        <button type="button" data-hub-erase
          class="px-2 py-1 text-[11px] font-bold rounded-lg bg-white border border-gray-200 text-gray-500 hover:border-red-300 hover:text-red-700 transition cursor-pointer">Erase their data</button>
      </div>
      <p class="hidden text-[11px] font-semibold mt-1.5" data-hub-erase-status></p>`;

    const btn = strip.querySelector('[data-hub-erase]');
    const status = strip.querySelector('[data-hub-erase-status]');
    btn.addEventListener('click', () => eraseLeadProspect(record, btn, status));
    return strip;
  }

  /**
   * Run the erasure, after asking the two questions that cannot be skipped.
   *
   * Scope first (only a human can tell a limited company from a sole trader whose company IS their
   * name), then the irreversible-act confirmation. ⚠️ A missing dialog ABORTS rather than falling
   * through: elsewhere in this file a modal is a convenience, here it is the safeguard.
   */
  async function eraseLeadProspect(record, btn, status) {
    const email = contactEmailOf(record);

    const say = (text, cls) => {
      status.classList.remove('hidden');
      status.className = `text-[11px] font-semibold mt-1.5 ${cls}`;
      status.textContent = text;
    };

    if (!window.choiceModal || !window.confirmModal) {
      say('The confirmation dialog could not be opened, so nothing was erased. Reload the page and try again.', 'text-red-600');
      return;
    }

    const scope = await window.choiceModal(
      `Everything held about ${email ? `<span class="font-semibold">${esc(email)}</span>` : 'this person'} is removed: `
      + `${email ? 'their address, the emails sent to them, ' : ''}the research gathered on them and anything your `
      + 'assistant drafted. Your own funnel history stays &mdash; that this lead was found, approached and closed '
      + '&mdash; carrying nothing that identifies them.',
      [
        { value: 'contact', label: 'Their personal details',
          description: 'The right answer for a company. Removes the person; the company name and website stay on the record.' },
        { value: 'full', label: 'Their details and the company&rsquo;s',
          description: 'For a sole trader or a one-person business, where the company name or domain IS the person.' },
      ],
      { title: 'Erase this person&rsquo;s data', cancelLabel: 'Not now' },
    );
    if (!scope) return;

    // ⚠️ States the block that will ACTUALLY be taken. With no address the erasure excludes the
    // company's domain from every search — a bigger consequence than the request asked for, taken
    // because there is nothing finer to take, and not something to discover afterwards by noticing
    // a company has stopped appearing in the pipeline.
    const ok = await window.confirmModal(
      'This cannot be undone, and there is no copy to restore from. '
      + (email
        ? 'They stay on your do-not-contact list afterwards, so no future search can bring them back into your pipeline.'
        : 'There is no address on this lead to block, so this company is excluded from every one of your searches instead — nobody there will be found again.'),
      {
        title: email ? 'Erase and keep them blocked?' : 'Erase and block this company?',
        confirmLabel: 'Erase their data', cancelLabel: 'Cancel', confirmColor: '#b91c1c',
      },
    );
    if (!ok) return;

    btn.disabled = true;
    say('Erasing…', 'text-gray-500');
    try {
      const res = await fetch('/.netlify/functions/lead-generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'erase_prospect',
          assistantId: state.assistantId,
          recordId: record.id,
          email: email || undefined,
          eraseScope: scope,
          confirmErase: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not erase that lead.');
      // A full refetch, not a patch. The erasure rewrote `data` server-side — the address, the
      // intel, the hooks, the draft and (on a full erasure) the title — and patching the four
      // fields this browser happens to know about would leave the panel showing the rest.
      //
      // Re-opened afterwards for the same reason the research button does it: the refresh collapses
      // the row the user is reading, and the outcome would otherwise be a row quietly changing in a
      // list. The re-opened panel carries the durable version of this message.
      state.pendingFocusId = record.id;
      state.pendingFocusTone = 'neutral';
      await refresh();
    } catch (err) {
      btn.disabled = false;
      say(err.message || 'Could not erase that lead.', 'text-red-600');
    }
  }

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
      //
      // ⚠️ Both flags describe THIS TAB, and both are false for the same reason: the Leads tab is
      // for the lead record — read it, progress its next step, enrich it, delete it — and every act
      // on the outreach EMAIL belongs to the Review tab, where the full message is on screen.
      //
      //   sendsOnApproval: false — the Approve button below records the decision and sends nothing
      //     (its own status line says so). The card's default is the chat/Review wording, which
      //     told users approving would email a named individual automatically, above a button that
      //     would not.
      //   outreachActions: false — drops "Draft Outreach in Gmail". Pushing the draft into Gmail
      //     from a screen that never shows the draft's text is a send-shaped action taken blind.
      //   nextStep: who performs the model's suggested next step, and the button that starts it.
      //     Supplied only HERE — chat and the Review Queue render the same stored card and neither
      //     holds the action bar the button presses, so neither may show one.
      body = window.DisruptiveUIRegistry.render(record.data, {
        sendsOnApproval: false,
        outreachActions: false,
        nextStep: nextStepGuidance(record),
      });
    }
    // A lead leads with where it stands: first the approval gate (pending / approved / rejected),
    // then a recorded deal outcome if there is one. Both above the card, so they read as facts
    // about the lead rather than more fields buried inside it.
    if (state.hub.recordType === 'lead') panel.appendChild(approvalBanner(record));
    const outcome = state.hub.recordType === 'lead' ? outcomeBanner(record) : null;
    if (outcome) panel.appendChild(outcome);
    // Above the card for the same reason as the two banners: on a lead with no address these links
    // are the only thing on the record a user can act on, and inside the field list they would read
    // as one more stored value.
    const social = state.hub.recordType === 'lead' ? socialBanner(record) : null;
    if (social) panel.appendChild(social);
    // What the research pass found, above the scoring card rather than inside it. The card states
    // the verdict; this states the evidence the verdict was reached from, and evidence that sits
    // below the conclusion it produced is evidence nobody reads.
    const intel = state.hub.recordType === 'lead' ? intelBanner(record) : null;
    if (intel) panel.appendChild(intel);
    // Last of the banners, so it sits closest to the card: what a human wrote about this lead
    // outranks what was scraped about it, and the Notes button below writes here. Appended even
    // when empty — see notesBanner.
    if (state.hub.recordType === 'lead') panel.appendChild(notesBanner(record));
    const rendered = body || keyValueFallback(record.data);
    panel.appendChild(rendered);
    // Asked of the DOM that was actually produced, not of the guidance that was passed in: the card
    // may have declined to render, or fallen back to the key/value list, and only the result knows.
    panel.appendChild(detailActions(record, {
      hasNextStepFooter: !!rendered.querySelector?.('[data-next-step-footer]'),
    }));
    // Last thing in the panel, below the action bar — see erasureStrip for why it is not IN it.
    const erasure = state.hub.recordType === 'lead' ? erasureStrip(record) : null;
    if (erasure) panel.appendChild(erasure);
    // Delegated, and attached after the bar exists: the next-step button presses a control in it.
    if (state.hub.recordType === 'lead') wireNextStepAction(panel);
    return panel;
  }

  // ── Working the table: filter, sort, group, select ──────────────────────────
  //
  // The table rendered every record, in whatever order the API returned them, with no way to
  // narrow it. That is fine at twelve rows and unusable at four hundred — and four hundred is what
  // a couple of discovery runs produce. The three questions a user actually arrives with are
  // "which ones need me?", "which are the best?" and "which are junk?", and all three are answers
  // to filter / sort / group over the columns already on screen.
  //
  // ── Everything here works off the RENDERED value ────────────────────────────
  // Filters, grouping and the search box all compare `cellValue(record, key)` — the exact string
  // in the cell. It is the only definition that can't surprise anyone: a filter offering "Awaiting
  // you" selects the rows that say "Awaiting you", and a column whose renderer changes takes its
  // filter with it. Sorting is the one place that departs from it, and only where the rendered
  // order would be wrong — see ORDERED_VALUES.
  //
  // ⚠️ Generic over hub.columns, not written for leads. The Ledger and the ticket hubs get the
  // same controls from the same code, which is why nothing below names a lead-specific column.

  /** Column display values that have a natural order the alphabet does not agree with. */
  const ORDERED_VALUES = {
    // Rating: the whole point of the column is that hot beats warm beats cold.
    status: ['hot', 'warm', 'cold'],
    // Approval: the order of the gate itself, so "sort by Approval" puts what needs you on top.
    // ⚠️ These are the RENDERED labels, and for a lead `approvalChip()` can substitute the outreach
    // state for the approval state — so "Email Drafted" and "Email Sent" have to be ranked here or
    // every lead that has been through an approval sorts last, in a lump, whatever it did.
    // Ranked by what still wants the user: a drafted email is theirs to send, a sent one is not.
    approvalStatus: ['Awaiting you', 'Approved', 'Email Drafted', 'Email Sent', 'Chase set', 'Rejected'],
    // Contact: most reachable first — that is what the column is asked.
    contact: ['Role inbox', 'Named person', 'Checking…', 'Not attempted', 'Not checked', 'None found'],
  };

  /** A comparable for one cell: number where the column is numeric, rank where it is a vocabulary. */
  function sortValue(record, key) {
    if (key === 'updatedAt') {
      const t = new Date(record.updatedAt).getTime();
      return Number.isNaN(t) ? -Infinity : t;
    }
    // The retention countdown sorts by DAYS, never by its label. "10 days left" and "2 days left"
    // compare as strings to 10 < 2 even under numeric collation, because the collator sees "1"
    // before "2" at the first differing character of two multi-token strings — so ascending order
    // would have buried the leads about to be deleted in the middle of the column. Ascending is
    // the useful direction here (most urgent first), and leads that are not on a clock at all sort
    // last rather than first: they are not "safe for ∞ days", they are simply not in this race.
    if (key === 'retention') {
      const R = window.LeadRetention;
      const swept = record.approvalStatus === 'pending_approval' || record.approvalStatus === 'rejected';
      if (!R || !swept || R.isDeleted(record.data)) return Infinity;
      const days = R.daysRemaining(record.updatedAt);
      return days === null ? Infinity : days;
    }
    const shown = cellValue(record, key);
    const ordered = ORDERED_VALUES[key];
    if (ordered) {
      const i = ordered.findIndex((v) => v.toLowerCase() === String(shown).toLowerCase());
      return i === -1 ? ordered.length : i;          // anything unrecognised sorts last, not first
    }
    // A column of numbers must sort 9 before 10. Only when EVERY value parses cleanly — a mixed
    // column ("42", "n/a") would otherwise sort the words into one silent lump at the bottom.
    const n = Number(shown);
    if (shown !== '—' && shown !== '' && Number.isFinite(n)) return n;
    return String(shown).toLowerCase();
  }

  function compareRecords(a, b, key, dir) {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    let out;
    if (typeof av === 'number' && typeof bv === 'number') out = av - bv;
    else out = String(av).localeCompare(String(bv), undefined, { numeric: true });
    return dir === 'desc' ? -out : out;
  }

  /** Every distinct rendered value in a column, in sort order. Drives the per-column dropdowns. */
  function distinctValues(key) {
    const seen = new Set();
    for (const r of state.records) seen.add(String(cellValue(r, key)));
    return [...seen].sort((x, y) => {
      const ordered = ORDERED_VALUES[key];
      if (!ordered) return x.localeCompare(y, undefined, { numeric: true });
      const rank = (v) => {
        const i = ordered.findIndex((o) => o.toLowerCase() === v.toLowerCase());
        return i === -1 ? ordered.length : i;
      };
      return rank(x) - rank(y) || x.localeCompare(y);
    });
  }

  /**
   * Which columns get a dropdown.
   *
   * A `<select>` is only an improvement over the search box while the list is short enough to read.
   * "Lead" holds one distinct value per row and "Updated" nearly so — a four-hundred-option menu is
   * a worse search box. Those columns are covered by the free-text box instead, which is why it
   * exists alongside these. The ceiling is deliberately generous: a vocabulary of twenty is still
   * a menu, and being able to pick one industry out of eighteen is exactly the ask.
   */
  const MAX_FILTER_OPTIONS = 20;

  /**
   * Columns that never get a dropdown, whatever their cardinality.
   *
   * `retention` is a CONTINUOUS quantity wearing a label. Its distinct values are "1 day left",
   * "2 days left" … up to thirty, so the generic rule below would offer a menu of consecutive
   * countdowns and ask the user to pick exactly one of them — a filter nobody wants, which then
   * silently vanishes as soon as the account holds more than twenty leads spread across more than
   * twenty days. Sorting is the control that actually serves this column (most urgent first), and
   * it is wired above.
   */
  const NEVER_FILTERABLE = new Set(['retention']);

  function filterableColumns() {
    return state.hub.columns.filter((c) => {
      if (NEVER_FILTERABLE.has(c.key)) return false;
      // A column the user is CURRENTLY filtering on always keeps its dropdown, whatever the data
      // has since become. Otherwise deleting the last row of a kind takes the control away and
      // leaves the filter running invisibly, with no way to turn it off but Clear.
      if (state.view.filters[c.key]) return true;
      const n = distinctValues(c.key).length;
      return n >= 2 && n <= MAX_FILTER_OPTIONS;
    });
  }

  /** Does this record survive the search box and every per-column dropdown? */
  function matchesView(record) {
    const v = state.view;
    const q = v.search.trim().toLowerCase();
    if (q) {
      const hay = state.hub.columns.map((c) => String(cellValue(record, c.key))).join('  ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    for (const [key, wanted] of Object.entries(v.filters)) {
      if (!wanted) continue;
      if (String(cellValue(record, key)) !== wanted) return false;
    }
    return true;
  }

  /** The records the table is currently showing, filtered then sorted. */
  function visibleRecords() {
    const list = state.records.filter(matchesView);
    if (state.view.sortKey) {
      list.sort((a, b) => compareRecords(a, b, state.view.sortKey, state.view.sortDir));
    }
    return list;
  }

  /**
   * Group the visible rows, or return one unlabelled group.
   *
   * Grouping is offered on EVERY column, including the ones with no dropdown. Grouping by "Lead"
   * gives one row per group, which is useless but harmless, and refusing it would mean explaining
   * a rule nobody asked about. Group ORDER follows the current sort where one is set, so "group by
   * Rating, sort by Score" reads the way it sounds.
   */
  function groupVisible(list) {
    const key = state.view.groupKey;
    if (!key) return [{ label: null, records: list }];
    const groups = new Map();
    for (const r of list) {
      const label = String(cellValue(r, key));
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(r);
    }
    const ordered = [...groups.keys()].sort((x, y) => {
      const vocab = ORDERED_VALUES[key];
      if (!vocab) return x.localeCompare(y, undefined, { numeric: true });
      const rank = (v) => {
        const i = vocab.findIndex((o) => o.toLowerCase() === v.toLowerCase());
        return i === -1 ? vocab.length : i;
      };
      return rank(x) - rank(y) || x.localeCompare(y);
    });
    return ordered.map((label) => ({ label, records: groups.get(label) }));
  }

  /** Selection is offered wherever DELETE works — that is every records hub, but not the library. */
  function selectable() {
    return state.hub.kind !== 'content_library';
  }

  /**
   * How many rows are on a page.
   *
   * Twenty-five rather than the ten the Review Queue uses: a table row is one line, and the whole
   * point of this tab is scanning a column of chips for the ones that need work. Small enough that
   * the browser is not laying out four hundred rows and four hundred (lazily built) detail panels,
   * large enough that a normal week's leads are one page.
   */
  const ROWS_PER_PAGE = 25;

  /**
   * The page of `visibleRecords()` on screen.
   *
   * ⚠️ Paged in the BROWSER, over the already-filtered list — not by the server. Every control on
   * this table (search, the per-column dropdowns, sort, group, "select all matching") compares the
   * rendered cell across every record the hub holds; a server LIMIT would quietly redefine all of
   * them as "…on this page", which is the failure mode where a filter says 3 and the truth is 40.
   */
  function pagedRecords(list) {
    return window.ListPager
      ? window.ListPager.page(list, state.view.page, ROWS_PER_PAGE)
      : { items: list, page: 1, pages: 1, total: list.length, first: list.length ? 1 : 0, last: list.length };
  }

  /** Any change to WHICH rows are shown puts the reader back at the top of the new list. */
  function resetPage() { state.view.page = 1; }

  /** Drop ids that are no longer on screen. Called after any refetch or filter change. */
  function pruneSelection() {
    if (!state.selected.size) return;
    const live = new Set(visibleRecords().map((r) => r.id));
    for (const id of [...state.selected]) if (!live.has(id)) state.selected.delete(id);
  }

  // ── Table ───────────────────────────────────────────────────────────────────

  function rowHtml(record) {
    // Rendered from state.selected rather than left in the DOM, because refreshRow() rewrites a
    // row's innerHTML after a PATCH — a checkbox that only existed as DOM state would silently
    // clear itself the moment the user approved something.
    const pick = selectable()
      ? `<td class="pl-4 pr-1 py-3 w-8">
           <input type="checkbox" data-hub-select="${record.id}" ${state.selected.has(record.id) ? 'checked' : ''}
             aria-label="Select this row"
             class="w-4 h-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-700 cursor-pointer align-middle">
         </td>`
      : '';
    const cols = state.hub.columns.map((c, i) => {
      let cell;
      if (c.key === 'status') {
        // For a lead this column is the hot/warm/cold rating, and "warm" says nothing about how it
        // was decided. The tooltip comes from the GENERATED mirror of the scoring rubric
        // (window.LeadRating, built from RATING_BANDS in src/config/icp-profile.ts) so it states the
        // same bands the model was given — never a hand-typed threshold, which is how three prompt
        // copies drifted before that constant existed. Absent mirror → no tooltip, never a guess.
        const ratingHelp = (window.LeadRating && typeof window.LeadRating.help === 'function')
          ? window.LeadRating.help(record.status) : '';
        // ⚠️ This chip used to be pinned NEUTRAL grey, so that the coloured Approval chip beside it
        // was the only thing to scan for. It is coloured now — orange hot, yellow warm, blue cold,
        // from the same generated mirror the tooltip comes from (window.LeadRating.chips) — because
        // the rating was the one lead fact rendered differently on every tab it appeared on.
        // The cost is real and known: a lead row can now carry three coloured chips (Approval,
        // Contact, Rating) and blue means "cold" here, "Email Drafted" one column left and
        // "Checking…" one column right. Each column has a heading; do not add a fourth colour axis.
        // A record with no rating keeps the neutral chip — unrated is not cold.
        const ratingCls = (window.LeadRating && typeof window.LeadRating.chipFor === 'function')
          ? window.LeadRating.chipFor(record.status).cls
          : 'bg-gray-100 text-gray-500 border-gray-200';
        cell = `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${ratingCls} whitespace-nowrap${ratingHelp ? ' cursor-help' : ''}"${ratingHelp ? ` title="${esc(ratingHelp)}"` : ''}>${esc(cellValue(record, c.key))}</span>`;
      } else if (c.key === 'approvalStatus') {
        // Coloured, unlike the neutral Rating chip beside it: this column exists to be SCANNED for
        // the amber ones. A record with no approval status renders the bare em-dash — a grey chip
        // reading "—" would look like a fourth state.
        const s = approvalChip(record);
        cell = s
          ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${s.cls} whitespace-nowrap">${esc(s.short)}</span>`
          : '<span class="text-gray-400">—</span>';
      } else if (c.key === 'contact') {
        // The chip carries the STATE; the address itself rides in the tooltip. A column of raw
        // addresses would be unscannable, and would put a hundred people's contact details on
        // screen to answer a question that is really just "can I send to this one?".
        const s = CONTACT_CHIP[contactState(record)];
        const email = contactEmailOf(record);
        // The address when there is one, otherwise the reason there is not — plus, on a lead with
        // no address, the fact that there IS something to open. Without this line the profiles are
        // only discoverable by opening every red chip in the table one at a time, which is the same
        // dead end the chip had before, one click further in.
        const tip = email || [s.why, socialHint(record)].filter(Boolean).join(' ') || '';
        cell = `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${s.cls} whitespace-nowrap"${tip ? ` title="${esc(tip)}"` : ''}>${esc(s.short)}</span>`;
      } else if (c.key === 'retention') {
        // The 30-day countdown. Coloured by urgency rather than by state — this is the one column
        // whose job is to be noticed BEFORE it matters, because what it counts down to cannot be
        // undone. retentionCell() already escaped its own text.
        const r = retentionCell(record);
        const tip = r.text === '—'
          ? 'Only leads awaiting a decision or turned down are on the clock. This one is not.'
          : (window.LeadRetention ? window.LeadRetention.NOTICE : '');
        cell = tip ? `<span title="${esc(tip)}">${r.html}</span>` : r.html;
      } else {
        cell = esc(cellValue(record, c.key));
      }
      return `<td class="px-4 py-3 ${i === 0 ? 'font-semibold text-gray-900' : 'text-gray-700'}">${cell}</td>`;
    }).join('');
    return `${pick}${cols}
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
    if (!state.hub || state.hub.kind === 'content_library') return;
    // Shared formatter so this tab and the other three in the lead funnel print the count
    // identically — see setTabCount in assistant-dashboard-registry.js.
    //
    // ⚠️ Counts LIVE records only. `state.records` is what the table holds, and the table no
    // longer holds leads the retention sweep has moved (the API defaults to ?retention=live), so
    // the Deleted section's rows are deliberately outside this number. A tab reading
    // "Enrichment (61)" over a table showing 48 rows plus a collapsed graveyard would be a count
    // that describes nothing the user can see.
    window.AssistantDashboardRegistry?.setTabCount(
      'datahub-tab-label', state.hub.label, state.records.length,
    );
  }

  /**
   * The filter / sort / group strip, plus the selection bar.
   *
   * ⚠️ Rendered ONCE per record set, by renderTable(), and never from paintRows(). The search box
   * lives in here: rebuilding this markup on every keystroke would blow away the input the user is
   * typing into and take the caret with it. Changing a control repaints the ROWS
   * (paintRows()), and the strip updates itself in place through the handles below.
   */
  function controlsHtml() {
    const hub = state.hub;
    const v = state.view;
    const selectCls = 'px-2 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg bg-white text-gray-700 cursor-pointer focus:outline-none focus:border-emerald-400';
    // ⚠️ The chosen value is unioned in even when NOTHING has it any more. Filter to "hot", delete
    // every hot lead, and its option disappears from the list — the select then falls back to
    // showing "All" while `state.view.filters` is still filtering on it, so the control reads
    // "All" above a table reading "0 of 22". Keeping the dead option means the strip always says
    // what the table is actually doing, and Clear is right there.
    const filters = filterableColumns().map((c) => {
      const chosen = v.filters[c.key];
      const options = distinctValues(c.key);
      if (chosen && !options.includes(chosen)) options.push(chosen);
      return `
      <label class="inline-flex items-center gap-1.5">
        <span class="text-xs font-bold text-gray-400 uppercase tracking-wide">${esc(c.label)}</span>
        <select data-hub-filter="${esc(c.key)}" class="${selectCls}">
          <option value="">All</option>
          ${options.map((val) => `<option value="${esc(val)}"${chosen === val ? ' selected' : ''}>${esc(val)}</option>`).join('')}
        </select>
      </label>`;
    }).join('');

    return `
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <input type="search" data-hub-search value="${esc(v.search)}"
          placeholder="Search ${esc(hub.label.toLowerCase())}…"
          class="px-3 py-1.5 text-sm border border-gray-200 rounded-lg w-full sm:w-64 focus:outline-none focus:border-emerald-400">
        ${filters}
        <label class="inline-flex items-center gap-1.5">
          <span class="text-xs font-bold text-gray-400 uppercase tracking-wide">Group by</span>
          <select data-hub-group class="${selectCls}">
            <option value="">Nothing</option>
            ${hub.columns.map((c) => `<option value="${esc(c.key)}"${v.groupKey === c.key ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}
          </select>
        </label>
        <span class="text-xs text-gray-500 ml-auto" data-hub-count></span>
        <button type="button" data-hub-clear
          class="text-xs font-bold text-gray-500 hover:text-gray-800 underline cursor-pointer">Clear</button>
      </div>
      <!-- Sorting has no control of its own: the column headings ARE the control, which is where
           everyone reaches for it first. No backticks in this comment — it sits in a template
           literal. -->
      <div class="hidden mb-3 flex-wrap items-center gap-3 px-3 py-2 rounded-lg border border-emerald-200 bg-emerald-50"
           data-hub-bulkbar>
        <span class="text-xs font-bold text-emerald-900" data-hub-bulkcount></span>
        <button type="button" data-hub-selectall
          class="text-xs font-bold text-emerald-800 hover:text-emerald-900 underline cursor-pointer"></button>
        <button type="button" data-hub-selectnone
          class="text-xs font-bold text-gray-500 hover:text-gray-800 underline cursor-pointer">Clear selection</button>
        <!-- One action, not two. A separate Reject stood beside Delete until 2026-08-15; Delete now
             performs the rejection itself — keeping the record, banking the evidence, filing it
             under Deleted — so the bar no longer asks the user to choose between two words for what
             is one act. ml-auto stays on the WRAPPER rather than the button, which is what keeps
             this correct if a second action is ever put back beside it. -->
        <div class="ml-auto flex items-center gap-2">
          <button type="button" data-hub-bulkdelete
            class="px-3 py-1.5 bg-white border border-red-200 text-red-700 hover:bg-red-100 text-xs font-bold rounded-lg transition cursor-pointer"></button>
        </div>
      </div>
      <div data-hub-bulkstrip></div>`;
  }

  function wireControls(host) {
    const repaint = () => { resetPage(); pruneSelection(); paintRows(); };

    const search = host.querySelector('[data-hub-search]');
    if (search) {
      search.addEventListener('input', () => { state.view.search = search.value; repaint(); });
    }
    host.querySelectorAll('[data-hub-filter]').forEach((sel) => {
      sel.addEventListener('change', () => {
        state.view.filters[sel.getAttribute('data-hub-filter')] = sel.value;
        repaint();
      });
    });
    const group = host.querySelector('[data-hub-group]');
    if (group) group.addEventListener('change', () => {
      state.view.groupKey = group.value || null;
      // Folds belong to the column they were made in: "Rejected" folded under Approval must not
      // silently fold a Rating group that happens to share a label. A different grouping is a
      // different set of headings, so it starts open.
      state.view.collapsed.clear();
      resetPage();
      paintRows();
    });

    host.querySelector('[data-hub-clear]')?.addEventListener('click', () => {
      state.view.search = '';
      state.view.filters = {};
      state.view.groupKey = null;
      state.view.sortKey = null;
      state.view.collapsed.clear();
      resetPage();
      state.selected.clear();
      renderTable();                                  // the controls themselves have to reset too
    });

    // Paging. Delegated on the wrapper because paintRows rewrites its innerHTML on every keystroke;
    // the wrapper itself is only rebuilt by renderTable, which re-runs this.
    const pager = host.querySelector('[data-hub-pager]');
    if (pager) {
      window.ListPager?.bind(pager, 'data-hub-page', (n) => {
        state.view.page = n;
        paintRows();
        host.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    // Sort: the headings. A second click flips the direction, a third clears it and puts the table
    // back in the order the server sent — which is the only way back to "newest work first"
    // without knowing that that is what the default was.
    host.querySelectorAll('[data-hub-sort]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-hub-sort');
        const v = state.view;
        if (v.sortKey !== key) { v.sortKey = key; v.sortDir = 'asc'; }
        else if (v.sortDir === 'asc') v.sortDir = 'desc';
        else { v.sortKey = null; v.sortDir = 'asc'; }
        resetPage();                                  // a re-sorted list makes "page 4" meaningless
        renderTable();                                // the arrow lives in the heading
      });
    });

    // ── Selection ──────────────────────────────────────────────────────────────
    // The heading checkbox. Ticking it takes in every row matching the filters (see the markup);
    // un-ticking it clears the selection outright rather than "deselecting the matching ones",
    // because the two only differ when something off-filter is selected — and pruneSelection()
    // makes sure nothing ever is.
    host.querySelector('[data-hub-selectall-head]')?.addEventListener('change', (e) => {
      if (e.target.checked) for (const r of visibleRecords()) state.selected.add(r.id);
      else state.selected.clear();
      // Repaint rather than trusting the DOM: every row's tick is drawn from state.selected, and
      // the bulk bar below has to appear (or go) in the same frame.
      paintRows();
    });
    host.querySelector('[data-hub-selectall]')?.addEventListener('click', () => {
      for (const r of visibleRecords()) state.selected.add(r.id);
      paintRows();
    });
    host.querySelector('[data-hub-selectnone]')?.addEventListener('click', () => {
      state.selected.clear();
      paintRows();
    });
    // Clears the strip host before drawing: pressing Delete twice must re-ask, not stack a second
    // confirmation under the first. (It also guarded against a Reject confirmation and a Delete
    // confirmation being open together — that pair is gone, but the rule outlives it.)
    host.querySelector('[data-hub-bulkdelete]')?.addEventListener('click', () => {
      const strip = host.querySelector('[data-hub-bulkstrip]');
      if (!strip) return;
      strip.innerHTML = '';
      strip.appendChild(bulkDeleteStrip([...state.selected]));
      strip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  /**
   * Repaint the rows for the current view. Cheap enough to run on every keystroke, and deliberately
   * does NOT touch the controls above it (see controlsHtml).
   */
  function paintRows() {
    const host = document.getElementById('datahub-table-host');
    const tbody = host && host.querySelector('[data-hub-tbody]');
    if (!tbody) return;
    const hub = state.hub;
    const list = visibleRecords();
    const span = hub.columns.length + 1 + (selectable() ? 1 : 0);

    tbody.innerHTML = '';
    if (list.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="${span}" class="px-4 py-8 text-center text-sm text-gray-500">
        Nothing matches these filters. <button type="button" data-hub-clear-inline class="font-bold text-emerald-700 underline cursor-pointer">Clear them</button> to see all ${state.records.length}.
      </td>`;
      tr.querySelector('[data-hub-clear-inline]').addEventListener('click', () => {
        host.querySelector('[data-hub-clear]')?.click();
      });
      tbody.appendChild(tr);
    }

    // One page of the filtered list, then grouped — never the reverse. Grouping the page keeps the
    // headings honest ("Hot · 12" counts the twelve on screen); paging each group separately would
    // give every group its own page and no way to say which page you are on.
    const pg = pagedRecords(list);
    for (const group of groupVisible(pg.items)) {
      // A group is FOLDED by its label, not its index. Grouping by Approval and folding "Rejected"
      // has to keep that group shut when the sort order moves it, when a filter shrinks it, and
      // when the tab refetches — all of which reorder the array underneath it.
      const collapsed = group.label !== null && state.view.collapsed.has(group.label);
      if (group.label !== null) {
        const head = document.createElement('tr');
        head.className = 'bg-gray-50';
        // The whole heading is the control, not a small chevron beside it: the heading is already
        // the thing the eye lands on, and a 14px target in a table row is a miss waiting to happen.
        // The chevron SWAPS PATH rather than rotating — the compiled stylesheet has `rotate-90` but
        // no `-rotate-90`, and a chevron that turned the wrong way would point at the row above.
        const chevron = collapsed ? 'M9 5l7 7-7 7' : 'M19 9l-7 7-7-7';
        head.innerHTML = `<td colspan="${span}" class="p-0">
          <button type="button" data-hub-group-toggle aria-expanded="${collapsed ? 'false' : 'true'}"
            class="w-full flex items-center gap-2 px-4 py-2 text-left cursor-pointer hover:bg-gray-100 transition-colors">
            <svg class="w-3.5 h-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${chevron}"/></svg>
            <span class="text-xs font-bold text-gray-600 uppercase tracking-wide">${esc(group.label)} <span class="text-gray-400 normal-case">· ${group.records.length}</span></span>
          </button>
        </td>`;
        head.querySelector('[data-hub-group-toggle]').addEventListener('click', () => {
          if (state.view.collapsed.has(group.label)) state.view.collapsed.delete(group.label);
          else state.view.collapsed.add(group.label);
          // Repaint rather than hide the rows in place: each row carries a sibling <tr> holding its
          // (lazily built) detail panel, and toggling two <tr>s per row by hand is how one of them
          // ends up visible on its own.
          paintRows();
        });
        tbody.appendChild(head);
      }
      // ⚠️ Folded rows are not rendered at all, and that is deliberate: the count in the heading
      // and everything above the table ("137 of 400", "Select all N matching") keeps counting the
      // whole filtered set, because none of them has ever counted the DOM. Folding changes what is
      // drawn, never what is selected, filtered or paged.
      if (collapsed) continue;
      for (const record of group.records) {
        const tr = document.createElement('tr');
        tr.className = 'cursor-pointer hover:bg-gray-50 transition-colors';
        tr.setAttribute('data-record-id', record.id);
        tr.innerHTML = rowHtml(record);

        const detailTr = document.createElement('tr');
        detailTr.className = 'hidden';
        const td = document.createElement('td');
        td.colSpan = span;
        td.className = 'p-0 border-t border-gray-100';
        detailTr.appendChild(td);

        tr.addEventListener('click', (e) => {
          // Ticking a row is not opening it. Without this the checkbox expands the record too,
          // and selecting twelve rows leaves twelve detail panels unfurled down the page.
          const box = e.target.closest('[data-hub-select]');
          if (box) {
            if (box.checked) state.selected.add(record.id); else state.selected.delete(record.id);
            paintSelectionBar();
            return;
          }
          const open = !detailTr.classList.contains('hidden');
          if (!open && !td.hasChildNodes()) td.appendChild(detailPanel(record));
          detailTr.classList.toggle('hidden', open);
          const chevron = tr.querySelector('[data-row-chevron]');
          if (chevron) chevron.classList.toggle('rotate-180', !open);
        });

        tbody.appendChild(tr);
        tbody.appendChild(detailTr);
      }
    }

    const count = host.querySelector('[data-hub-count]');
    if (count) {
      // Still the FILTER's number, not the page's — "25 of 400" beside a filter that matched 137
      // would read as the filter having matched 25.
      count.textContent = list.length === state.records.length
        ? `${state.records.length} ${state.records.length === 1 ? 'record' : 'records'}`
        : `${list.length} of ${state.records.length}`;
    }
    // The pager sits below the table and is repainted with the rows; its clicks are bound once, in
    // wireControls, on the wrapper — which survives this rewrite.
    const pager = host.querySelector('[data-hub-pager]');
    if (pager) {
      state.view.page = pg.page || 1;                 // clamped: the list may have shrunk under us
      pager.innerHTML = window.ListPager
        ? window.ListPager.controlsHtml(pg, { attr: 'data-hub-page', noun: state.hub.label.toLowerCase() })
        : '';
    }
    paintSelectionBar();
    applyPendingFocus();
  }

  /**
   * The selection bar, in place.
   *
   * ⚠️ "Select all" means all the rows matching the current filters, and the button SAYS the
   * number — a "select all" that quietly took in four hundred rows behind a filter showing twelve
   * is how someone deletes their pipeline. The count on the delete button is the same number, so
   * the last thing read before pressing it is how many records are about to go.
   */
  function paintSelectionBar() {
    const host = document.getElementById('datahub-table-host');
    if (!host) return;
    const n = state.selected.size;
    const matching = visibleRecords().length;

    // The heading checkbox, kept honest against the selection rather than left as DOM state:
    // ticked only when EVERY matching row is in, indeterminate while some are. Without the
    // indeterminate leg it reads "all selected" over a table with three rows ticked.
    // Its label carries the live number — the same number the Delete button will carry — because
    // a bare tick in a heading gives no clue whether it means this page or all 137.
    const head = host.querySelector('[data-hub-selectall-head]');
    if (head) {
      head.checked = matching > 0 && n >= matching;
      head.indeterminate = n > 0 && n < matching;
      head.title = matching
        ? `Select all ${matching} ${matching === 1 ? 'row' : 'rows'} matching the current filters`
        : 'Nothing to select';
      head.disabled = matching === 0;
    }

    const bar = host.querySelector('[data-hub-bulkbar]');
    if (!bar) return;
    // `hidden` loses to a class that sets display, and this bar is a flex row — pin both.
    bar.classList.toggle('hidden', n === 0);
    bar.style.display = n === 0 ? 'none' : 'flex';
    if (n === 0) return;

    bar.querySelector('[data-hub-bulkcount]').textContent = `${n} selected`;
    const all = bar.querySelector('[data-hub-selectall]');
    all.textContent = `Select all ${matching} matching`;
    all.style.display = n >= matching ? 'none' : '';
    bar.querySelector('[data-hub-bulkdelete]').textContent = `Delete ${n}`;
  }

  function renderTable() {
    updateTabCount();
    const host = document.getElementById('datahub-table-host');
    if (!host) return;
    const hub = state.hub;

    if (state.records.length === 0) {
      state.selected.clear();
      const emptyMsg = hub.kind === 'content_library'
        ? 'Posts this assistant drafts will appear here across their whole lifecycle — from draft through scheduled to published. Click Create Post above to write one yourself or generate one with AI.'
        : `Work your assistant produces in chat lands here automatically — or import a CSV to get started. ${esc(hub.importHint)}`;
      // ⚠️ The Deleted section is appended here too. An account whose every live lead has aged out
      // has an EMPTY table and a full graveyard, and that is exactly the moment the section has to
      // be reachable — leaving it off this branch would mean the only way to recover those leads
      // disappeared at the moment they all needed recovering.
      host.innerHTML = `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 text-center">
          <p class="text-4xl mb-3">🗂️</p>
          <p class="font-bold text-gray-900 mb-1">Nothing in ${esc(hub.label)} yet</p>
          <p class="text-sm text-gray-500 max-w-md mx-auto">${emptyMsg}</p>
        </div>
        ${deletedSectionHtml()}`;
      wireDeletedSection(host);
      return;
    }

    pruneSelection();
    const v = state.view;
    const arrow = (key) => (v.sortKey === key ? (v.sortDir === 'asc' ? ' ↑' : ' ↓') : '');
    host.innerHTML = `
      ${controlsHtml()}
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs font-bold text-gray-500 uppercase tracking-wider border-b border-gray-100">
                ${selectable() ? `<th class="pl-4 pr-1 py-3 w-8">
                  <!-- ⚠️ Selects every row matching the CURRENT FILTERS, not the current page.
                       "Filter to cold, then clear them" is the job this table is worked with, and a
                       select-all that stopped at 25 of 137 would silently leave the rest behind.
                       The count is spelled out in the tooltip and again on the Delete button, so
                       the number is stated twice before anything destructive is pressed.

                       It lives HERE, in the heading, because until now the only "Select all" was
                       inside the bulk bar — and that bar is hidden until a row is already ticked.
                       A select-all you can only reach by first selecting one by hand is the exact
                       complaint this fixes. -->
                  <input type="checkbox" data-hub-selectall-head
                    aria-label="Select all rows matching the current filters"
                    class="w-4 h-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-700 cursor-pointer align-middle">
                </th>` : ''}
                ${hub.columns.map((c) => `<th class="px-4 py-3">
                  <button type="button" data-hub-sort="${esc(c.key)}"
                    title="Sort by ${esc(c.label)}"
                    class="uppercase tracking-wider font-bold ${v.sortKey === c.key ? 'text-emerald-700' : 'text-gray-500 hover:text-gray-800'} cursor-pointer">${esc(c.label)}${arrow(c.key)}</button>
                </th>`).join('')}
                <th class="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100" data-hub-tbody></tbody>
          </table>
        </div>
        <!-- Filled by paintRows; empty (and therefore invisible) while everything fits on one page. -->
        <div data-hub-pager class="px-4"></div>
      </div>
      ${deletedSectionHtml()}`;

    wireControls(host);
    wireDeletedSection(host);
    paintRows();
  }

  // ── The Deleted section ────────────────────────────────────────────────────
  //
  // Leads the 30-day sweep has moved out of Outreach (netlify/functions/lead-retention-sweep.ts).
  //
  // ── Why they are kept at all ────────────────────────────────────────────────
  // A hard delete destroys the only record of the VERDICT. The discovery row survives at
  // 'discarded' so the SAME saved search will not re-find the company — but the dedupe index is
  // per campaign (campaign_id, domain), so a SECOND search finds it, scores it and drafts to it
  // again, with nothing anywhere saying "we looked at this company and it cannot, or must not, be
  // contacted". Keeping the row is what stops the product re-discovering its own rejects.
  //
  // ── Why it is a section here and not a tab ──────────────────────────────────
  // It is not a stage of the funnel and nobody works it daily. It belongs where a user goes when
  // they think "where did that lead go?", which is the tab that holds the leads. Collapsed by
  // default for the same reason.

  function deletedSectionHtml() {
    const rows = state.deletedRecords || [];
    const R = window.LeadRetention;
    if (state.hub.recordType !== 'lead' || !R) return '';
    // The outcome of the last send-back outlives the row it came from — and outlives an empty
    // list, which is the state a user reaches by rescuing the last lead in here. Rendering the
    // section for the notice alone is the difference between "it worked, here is what we found"
    // and the section silently disappearing.
    const notice = state.returnedNotice;
    if (!rows.length && !notice) return '';
    // The send-back handler sets `deletedOpen` itself, so a reported outcome is always on screen
    // without this having to force the fold open on every later render.
    const open = state.deletedOpen;
    const noticeHtml = notice
      ? `<div class="mx-4 mb-3 rounded-xl border px-3 py-2 ${notice.enriched
            ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50'}">
           <p class="text-xs font-bold ${notice.enriched ? 'text-emerald-800' : 'text-gray-700'}">${esc(notice.title)}</p>
           <p class="text-xs ${notice.enriched ? 'text-emerald-800' : 'text-gray-600'} mt-0.5">${esc(notice.message)}</p>
         </div>`
      : '';

    const body = rows.map((r) => {
      const reason = R.reasonOf(r.data) || 'unreviewed';
      const label = R.REASON_LABELS[reason] || 'Dropped';
      const note = R.REASON_NOTES[reason] || '';
      // A do-not-contact lead is the one case where sending it back is close to pointless — the
      // flag survives and the send seam will still refuse. The button stays (enrichment can still
      // correct the record, and the flag has its own audited override elsewhere) but it must not
      // be the confident emerald primary that the other rows carry.
      const dnc = reason === 'do_not_contact';
      return `
        <div class="px-4 py-3 border-t border-gray-100 flex flex-wrap items-start gap-3" data-deleted-row="${r.id}">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="font-semibold text-gray-900 truncate">${esc(r.title || 'Unnamed lead')}</p>
              <span class="text-xs font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${
                dnc ? 'bg-red-50 text-red-700 border-red-200' : 'bg-gray-100 text-gray-600 border-gray-200'
              }">${esc(label)}</span>
            </div>
            <p class="text-xs text-gray-500 mt-1">${esc(note)}</p>
            <p class="hidden mt-2 text-xs font-semibold" data-deleted-status></p>
          </div>
          <button type="button" data-deleted-return="${r.id}"
            class="px-3 py-1.5 ${dnc
              ? 'bg-white border border-gray-200 text-gray-700 hover:border-emerald-300'
              : 'bg-emerald-700 hover:bg-emerald-800 text-white'} text-xs font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed shrink-0">
            Send back for enrichment
          </button>
        </div>`;
    }).join('');

    return `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm mt-6 overflow-hidden">
        <button type="button" data-deleted-toggle
          class="w-full flex items-center gap-2 px-4 py-3 text-left cursor-pointer group">
          <svg class="w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
          <span class="text-sm font-bold text-gray-900 group-hover:text-emerald-700">Deleted</span>
          <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">${rows.length}</span>
        </button>
        <div class="${open ? '' : 'hidden'}" data-deleted-body>
          <p class="px-4 pb-3 text-xs text-gray-500">${esc(R.DELETED_NOTICE)}</p>
          ${noticeHtml}
          ${rows.length ? body : '<p class="px-4 pb-4 text-xs text-gray-400">Nothing else has been dropped.</p>'}
        </div>
      </div>`;
  }

  function wireDeletedSection(host) {
    const toggle = host.querySelector('[data-deleted-toggle]');
    if (toggle) {
      toggle.addEventListener('click', () => {
        state.deletedOpen = !state.deletedOpen;
        // Folding the section shut is the user saying they are done with the last outcome. Without
        // this the notice would sit there for the rest of the session, re-appearing every time the
        // section was re-opened, long after it stopped being news.
        if (!state.deletedOpen) state.returnedNotice = null;
        const body = host.querySelector('[data-deleted-body]');
        // `hidden` loses to any class that sets display, and this body holds flex rows — pin the
        // inline style too. Same trap the tab badges and the Review Queue cards carry.
        if (body) {
          body.classList.toggle('hidden', !state.deletedOpen);
          body.style.display = state.deletedOpen ? '' : 'none';
        }
        toggle.querySelector('svg')?.classList.toggle('rotate-90', state.deletedOpen);
      });
    }

    host.querySelectorAll('[data-deleted-return]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.getAttribute('data-deleted-return'));
        const row = btn.closest('[data-deleted-row]');
        const status = row?.querySelector('[data-deleted-status]');
        btn.disabled = true;
        btn.textContent = 'Enriching…';
        try {
          const res = await fetch('/.netlify/functions/lead-generation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              action: 'send_back_for_enrichment',
              assistantId: state.assistantId,
              recordId: id,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Could not send that lead back.');
          // The server's own sentence, not a generic success: it is the only thing that knows
          // whether an address was actually found, and "Done ✓" over a lead that is still
          // uncontactable is the lie this whole action exists to stop telling.
          //
          // Held as STATE, not written into the row. The refresh below re-renders this section
          // without this lead in it — a message written into the row would be destroyed by the
          // very repaint that proves the action worked.
          state.returnedNotice = {
            title: row?.querySelector('p.font-semibold')?.textContent?.trim() || 'Lead sent back for enrichment',
            message: data.message || 'Back in your pipeline.',
            enriched: !!data.enriched,
          };
          state.deletedOpen = true;      // the outcome must be on screen, not behind a fold
          // Refetch rather than splicing the row out locally: the lead has re-entered the live
          // table (un-rejected, possibly now carrying an address), so the table, the filters, the
          // counts and the tab number all have to show it.
          await refresh();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Send back for enrichment';
          if (status) {
            status.textContent = err.message || 'Something went wrong.';
            status.className = 'mt-2 text-xs font-semibold text-red-600';
            status.classList.remove('hidden');
          }
        }
      });
    });
  }

  // Deep link (Request 6): a "post failed to publish" notification names the post, so open its
  // row expanded, scroll it into view and flash a highlight — otherwise the user lands on a
  // library of dozens of rows and has to hunt for the one that failed. One-shot: consumed on
  // the first render that actually contains the row, so a later refresh doesn't re-scroll.
  function applyPendingFocus() {
    const id = state.pendingFocusId;
    if (id == null) return;
    const tr = document.querySelector(`#datahub-table-host tr[data-record-id="${id}"]`);
    if (!tr) {
      // The row may simply be on another page — a "post failed to publish" notification names a
      // record, not a page, and landing on page one with no highlight looks like the deep link
      // failed. Jump to whichever page holds it and let the repaint run this again; if it is not in
      // this hub at all the focus stays pending, exactly as before.
      const at = visibleRecords().findIndex((r) => Number(r.id) === Number(id));
      if (at === -1) return;
      const wanted = Math.floor(at / ROWS_PER_PAGE) + 1;
      if (wanted !== state.view.page) { state.view.page = wanted; paintRows(); }
      return;
    }
    const tone = state.pendingFocusTone;
    state.pendingFocusId = null;
    state.pendingFocusTone = null;
    tr.click();                            // expands the detail panel (failure banner + actions)
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // ⚠️ Two tones, because this is now used for two opposite things. The RED ring belongs to the
    // notification it was built for ("this post failed to publish"). Re-opening a row after the
    // user researched it is a success, and a red flash on a lead that just went from cold to hot
    // reads as an error report.
    const ring = tone === 'neutral'
      ? ['ring-2', 'ring-inset', 'ring-emerald-400', 'bg-emerald-50']
      : ['ring-2', 'ring-inset', 'ring-red-400', 'bg-red-50'];
    tr.classList.add(...ring);
    setTimeout(() => tr.classList.remove(...ring), 4000);
  }

  // Called before/after the Data Hub tab is opened. If the table is already on screen the focus
  // applies immediately; otherwise it's picked up by the next renderTable().
  //
  // `tone: 'neutral'` for a focus that is reporting success rather than a problem.
  function focusRecord(recordId, opts) {
    state.pendingFocusId = recordId == null ? null : Number(recordId);
    state.pendingFocusTone = (opts && opts.tone) || null;
    applyPendingFocus();
  }

  /**
   * One record, in a modal — the entry point for surfaces that hold a record id but not the table.
   * The Searches tab uses it: clicking a company in a search's results opens that lead here.
   *
   * Deliberately NOT focusRecord(): that expands the row in place, scrolls to it and flashes a RED
   * ring, which is right for the notification it was built for ("this post failed to publish") and
   * wrong as a general "show me this record" — a red highlight on a healthy lead reads as an error.
   *
   * The body is `detailPanel(record)`, the same node the expanded row builds, so the banners, the
   * scoring card and every action button are the ones the Leads tab already renders. A second
   * lead-detail renderer is how the two would come to disagree about what a lead can do.
   */
  async function openRecordModal(recordId) {
    const id = Number(recordId);
    if (!id || !state.hub) return;
    // The tab may never have been opened, so the record cache can be empty or stale.
    if (!state.records.some((r) => Number(r.id) === id)) {
      try { await fetchRecords(); renderTable(); } catch { /* fall through to the not-found note */ }
    }
    const record = state.records.find((r) => Number(r.id) === id);

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100 shrink-0">
          <div class="min-w-0">
            <h3 class="text-lg font-bold text-gray-900">${esc(record ? record.title : 'Record')}</h3>
            <p class="text-sm text-gray-500 mt-0.5">${esc(state.hub.label || '')}</p>
          </div>
          <button type="button" data-record-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer shrink-0">&times;</button>
        </div>
        <div class="overflow-y-auto" data-record-body></div>
      </div>`;
    const close = () => {
      overlay.remove();
      // The row underneath carries the same approval chip, and the panel's buttons only refresh a
      // row that is rendered. Re-read once on close so a decision taken in here is visible in the
      // list the user lands back on.
      renderTable();
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-record-close]').addEventListener('click', close);

    const body = overlay.querySelector('[data-record-body]');
    if (record) {
      body.appendChild(detailPanel(record));
    } else {
      body.innerHTML = '<p class="p-6 text-sm text-gray-500">That lead is no longer in this tab — it may have been deleted.</p>';
    }
    document.body.appendChild(overlay);
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
      <!-- Two paragraphs of instructions used to sit here, under the toolbar: how to shape a CSV for
           import, and how to get leads into a CRM. Both were permanent page furniture explaining
           buttons most users press rarely, and the CRM one carried its own controls inline. Each has
           moved inside the modal for the button it describes (openImportModal / openExportModal), so
           the instructions arrive when the user is actually doing the thing. Only the status line
           stays, because it reports on work in progress. No backticks in this comment — it is inside
           a template literal. -->
      <p class="hidden -mt-3 mb-5 text-xs font-semibold" data-hub-status></p>
    `;

    const fileInput = host.querySelector('[data-hub-file]');
    const importBtn = host.querySelector('[data-hub-import]');
    const status = host.querySelector('[data-hub-status]');

    // The file input still lives in the toolbar (one hidden input, reused) but is now driven from
    // inside the modal — the picker used to open on the very first click, before the user had been
    // told what shape the file should be, which is precisely backwards for the one action here that
    // cannot be undone by pressing something else.
    importBtn.addEventListener('click', () => openImportModal(fileInput, importBtn, status));

    host.querySelector('[data-hub-export]').addEventListener('click', () => {
      // Leads get the modal: their export has three shapes and a live alternative (push straight to
      // a CRM). Every other hub has exactly one CSV, and a modal in front of a single download is
      // a click that asks a question with one answer.
      if (hub.recordType === 'lead') { openExportModal(); return; }
      downloadCsv(null);
    });

    const addBtn = host.querySelector('[data-hub-add]');
    if (addBtn) addBtn.addEventListener('click', () => openAddLeadModal(status));
  }

  // ── Import / Export modals ──────────────────────────────────────────────────
  //
  // Both exist because their instructions do. The toolbar carried two permanent paragraphs of grey
  // text — how to shape a CSV, and how to get leads into a CRM — explaining buttons that are pressed
  // rarely, to every user, on every visit. Moving each into the modal for the button it describes
  // puts the explanation where the decision is made, and lets the CRM half carry the thing it was
  // really asking for: a live connection, not a download.

  /** One CSV download. `crm` shapes the headers for that importer; null is the generic export. */
  function downloadCsv(crm) {
    // Same-origin function URL, so the server's Content-Disposition drives the save. Assigning
    // location rather than clicking a `download` link on purpose — see the cross-origin note in the
    // project conventions.
    window.location.href = `${API}?assistantId=${state.assistantId}`
      + `&recordType=${encodeURIComponent(state.hub.recordType)}&format=csv`
      + (crm ? `&crm=${encodeURIComponent(crm)}` : '');
  }

  /** A standalone modal, matching openAddLeadModal's shell. Returns the parts callers wire up. */
  function hubModal({ title, subtitle, bodyHtml, maxWidth }) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full ${maxWidth || 'max-w-lg'} max-h-[90vh] flex flex-col">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100 shrink-0">
          <div class="min-w-0">
            <h3 class="text-lg font-bold text-gray-900">${esc(title)}</h3>
            ${subtitle ? `<p class="text-sm text-gray-500 mt-0.5">${esc(subtitle)}</p>` : ''}
          </div>
          <button type="button" data-hubmodal-close class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer shrink-0">&times;</button>
        </div>
        <div class="p-5 overflow-y-auto space-y-4" data-hubmodal-body>${bodyHtml}</div>
      </div>`;
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-hubmodal-close]').forEach((b) => b.addEventListener('click', close));
    document.body.appendChild(overlay);
    return { overlay, body: overlay.querySelector('[data-hubmodal-body]'), close };
  }

  /**
   * Import CSV — the instructions first, the file picker second.
   *
   * `importHint` and `importColumns` come from the role registry, so this serves every data-hub role
   * (leads, invoices, tickets, accounts) with its own wording rather than lead-specific copy.
   */
  function openImportModal(fileInput, importBtn, toolbarStatus) {
    const hub = state.hub;
    const { body, close } = hubModal({
      title: 'Import from a CSV',
      subtitle: 'Bring a list you already have into this tab.',
      bodyHtml: `
        <p class="text-sm text-gray-700">${esc(hub.importHint)}</p>
        <div>
          <p class="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">Suggested columns</p>
          <div class="flex flex-wrap gap-1.5">
            ${hub.importColumns.map((c) => `<span class="text-xs font-semibold px-2 py-1 rounded-lg border bg-gray-50 text-gray-600 border-gray-200">${esc(c)}</span>`).join('')}
          </div>
          <p class="text-[11px] text-gray-500 mt-1.5">Extra columns are kept on the record; missing ones are simply left blank. Nothing is invented to fill a gap.</p>
        </div>
        <p class="text-xs font-semibold hidden" data-import-status></p>
        <div class="flex items-center justify-end gap-2 pt-1">
          <button type="button" data-hubmodal-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 rounded-lg cursor-pointer">Cancel</button>
          <button type="button" data-import-choose class="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Choose a CSV file</button>
        </div>`,
    });
    body.querySelectorAll('[data-hubmodal-close]').forEach((b) => b.addEventListener('click', close));

    const modalStatus = body.querySelector('[data-import-status]');
    const chooseBtn = body.querySelector('[data-import-choose]');
    const say = (text, tone) => {
      modalStatus.textContent = text;
      modalStatus.className = `text-xs font-semibold ${tone === 'error' ? 'text-red-600' : tone === 'done' ? 'text-emerald-700' : 'text-gray-500'}`;
    };

    chooseBtn.addEventListener('click', () => fileInput.click());
    // Assigned, never addEventListener: the input lives in the toolbar and outlives this modal, so
    // a listener added per open would stack and re-import the same file once per modal ever opened.
    fileInput.onchange = async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      chooseBtn.disabled = true;
      importBtn.disabled = true;
      say('Reading the file…');
      try {
        // importCsv writes its progress straight onto this element's textContent; say() has
        // already put the neutral tone on it, and the class survives a textContent write.
        const result = await importCsv(file, modalStatus);
        await fetchRecords();
        renderTable();
        const done = `Imported ${result.inserted} new record${result.inserted === 1 ? '' : 's'}`
          + `${result.updated ? ` and refreshed ${result.updated} existing` : ''}.`;
        say(done, 'done');
        chooseBtn.textContent = 'Import another file';
        chooseBtn.disabled = false;
        // Mirrored to the toolbar so the result survives closing the modal — the table has just
        // changed underneath, and a user who closes on the toast is otherwise left guessing which
        // rows are new.
        toolbarStatus.textContent = done;
        toolbarStatus.className = 'block -mt-3 mb-5 text-xs font-semibold text-emerald-700';
      } catch (err) {
        say(err.message || 'Import failed.', 'error');
        chooseBtn.disabled = false;
      } finally {
        importBtn.disabled = false;
      }
    };
  }

  // ── Export / CRM ────────────────────────────────────────────────────────────

  const INTEGRATIONS_API = '/api/integrations';

  /**
   * The lead-push recipes, from the same library the Connections tab renders
   * (netlify/functions/integration-scenarios.ts). Filtered to `handoff_push` — the recipes that
   * send a lead OUT to a CRM, which is the question this modal is answering — plus anything already
   * active, so a recipe the user has switched on is never invisible here.
   */
  async function loadCrmRecipes() {
    const res = await fetch(`${INTEGRATIONS_API}/scenarios?assistantId=${state.assistantId}`, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not read your connections.');
    return (data.scenarios || []).filter((s) => s.scenarioType === 'handoff_push'
      && (s.active || (s.tier !== 3 && s.status === 'available')));
  }

  function recipeRow(s, last) {
    const on = s.active && s.active.isEnabled;
    // Three states, three different next steps. Only the toggle acts inline: activating a recipe
    // takes a field mapping, and that form already exists on the Connections tab
    // (assistant-integrations.js). A second copy of it here would be two config surfaces over one
    // active_scenarios row.
    const cta = s.active
      ? `<button type="button" data-recipe-toggle="${s.active.id}" data-enabled="${on ? '1' : '0'}"
           class="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-bold text-gray-700 cursor-pointer whitespace-nowrap">
           <span class="w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-600' : 'bg-gray-400'}"></span>${on ? 'On' : 'Off'}</button>`
      : (s.tier !== 2 && !s.connection && !s.connectionOptional)
        ? `<a href="/api/oauth/${esc(s.providerKey)}/connect"
             class="px-3 py-1.5 bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50 text-xs font-bold rounded-lg transition whitespace-nowrap">Connect ${esc(s.providerName)}</a>`
        : `<button type="button" data-recipe-setup class="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition whitespace-nowrap">Set it up</button>`;
    return `
      <div class="flex items-start gap-3 py-3 ${last ? '' : 'border-b border-gray-100'}">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-gray-900">${esc(s.title)}</p>
          <p class="text-xs text-gray-500 mt-0.5">${esc(s.description)}</p>
          ${s.active && !on ? '<p class="text-xs text-amber-700 mt-1">Switched off — nothing is being pushed.</p>' : ''}
        </div>
        <div class="shrink-0">${cta}</div>
      </div>`;
  }

  function openExportModal() {
    const { body, close } = hubModal({
      title: 'Export your leads',
      subtitle: 'Take them somewhere else, once or continuously.',
      maxWidth: 'max-w-xl',
      bodyHtml: `
        <div class="border border-gray-200 rounded-xl p-4">
          <p class="text-sm font-bold text-gray-900">As a spreadsheet</p>
          <p class="text-xs text-gray-500 mt-0.5">Every lead in this tab, with its score, contact details and outreach draft.</p>
          <button type="button" data-export-plain
            class="mt-3 px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition">Download CSV</button>
        </div>

        <div class="border border-gray-200 rounded-xl p-4">
          <p class="text-sm font-bold text-gray-900">Shaped for your CRM</p>
          <p class="text-xs text-gray-500 mt-0.5">The same leads, with column headers that match each importer&rsquo;s template, so the fields map themselves.</p>
          <div class="flex flex-wrap items-center gap-2 mt-3">
            <button type="button" data-export-crm="hubspot"
              class="px-4 py-2 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-sm font-bold rounded-lg transition">HubSpot CSV</button>
            <button type="button" data-export-crm="salesforce"
              class="px-4 py-2 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-sm font-bold rounded-lg transition">Salesforce CSV</button>
          </div>
          <p class="text-xs text-gray-500 mt-2">Leads found by a search usually have a company inbox rather than a named person, so the name columns are often empty. Salesforce needs a last name to import a row as a Lead &mdash; those rows are companies, not people, and nothing invents a surname to get them through.</p>
        </div>

        <div class="border border-gray-200 rounded-xl p-4">
          <p class="text-sm font-bold text-gray-900">Or send them across automatically</p>
          <p class="text-xs text-gray-500 mt-0.5">Connect your CRM once and every lead you approve is pushed over with its score, summary and where it came from &mdash; no file, no re-import.</p>
          <div class="mt-2" data-recipes><p class="text-xs text-gray-400 py-3">Checking your connections…</p></div>
        </div>`,
    });

    body.querySelector('[data-export-plain]').addEventListener('click', () => downloadCsv(null));
    body.querySelectorAll('[data-export-crm]').forEach((b) => {
      b.addEventListener('click', () => downloadCsv(b.getAttribute('data-export-crm')));
    });

    const recipes = body.querySelector('[data-recipes]');
    const wireRecipes = () => {
      recipes.querySelectorAll('[data-recipe-setup]').forEach((b) => b.addEventListener('click', () => {
        close();
        // The Connections drawer owns activation (mapping fields, picking the connection). Opening
        // it directly beats naming it in prose and leaving the user to find it.
        window._openBriefDrawer?.('platforms');
      }));
      recipes.querySelectorAll('[data-recipe-toggle]').forEach((b) => b.addEventListener('click', async () => {
        const next = b.getAttribute('data-enabled') !== '1';
        b.disabled = true;
        try {
          const res = await fetch(`${INTEGRATIONS_API}/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ activeScenarioId: Number(b.getAttribute('data-recipe-toggle')), isEnabled: next }),
          });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not change that.');
          await renderRecipes();
          // The Connections tab shows these same rows; re-read it so the two cannot disagree.
          window.AssistantIntegrations?.refresh?.();
        } catch (err) {
          b.disabled = false;
          window.showToast?.(err.message || 'Could not change that.', 'error');
        }
      }));
    };
    const renderRecipes = async () => {
      try {
        const list = await loadCrmRecipes();
        recipes.innerHTML = list.length
          ? list.map((s, i) => recipeRow(s, i === list.length - 1)).join('')
          // The recipe catalogue is seeded by db:seed-catalog, a manual step per environment. An
          // empty box would read as "your CRM is not supported"; this says which it is.
          : '<p class="text-xs text-gray-500 py-3">No CRM push recipes are set up on this workspace yet. The CSV exports above work regardless.</p>';
        wireRecipes();
      } catch (err) {
        recipes.innerHTML = `<p class="text-xs text-red-600 py-3">${esc(err.message)}</p>`;
      }
    };
    renderRecipes();
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

  /**
   * Keep an address's provenance in step with the address itself (Phase 2 item 9).
   *
   * ── Why this is not optional ────────────────────────────────────────────────
   * `contactState()` above reads `emailKind === 'personal' ? 'personal' : 'role'`. An address with
   * NO kind therefore renders as "Role inbox" — the green, safe-looking chip — even when it is
   * plainly a named individual. The Edit lead form has always been able to write `contactEmail`,
   * and it has never written a kind, so every hand-typed address in the product has been labelled a
   * generic company inbox. That is the wrong direction to be wrong in: a named individual is the
   * weakest GDPR footing here, and the chip is what a user checks before approving an email.
   *
   * ⚠️ ONLY ON A REAL CHANGE. Re-stamping an untouched address would rewrite a SCRAPED or PURCHASED
   * one's source to 'manual', and 'manual' is precisely what the Review Queue's personal-inbox
   * confirmation exempts — `needsPersonalInboxConfirmation` (src/config/lead-email-kind.ts) reads
   * "personal AND not typed by the user". Opening this form and pressing Save on an unrelated field
   * would then silently disarm that gate for the rest of the lead's life. Comparing against the
   * address as loaded is what prevents it.
   *
   * The 'manual' source itself is deliberate and unchanged: a user-supplied address is not
   * harvested, so it is correctly exempt from a gate that exists to catch harvesting.
   */
  function stampContactProvenance(prevData, nextData) {
    const before = String(prevData.contactEmail || '').trim().toLowerCase();
    const after = String(nextData.contactEmail || '').trim().toLowerCase();
    if (before === after) return;                       // untouched — leave its provenance alone

    if (!after) {                                       // cleared: the provenance describes nothing
      delete nextData.emailKind;
      delete nextData.emailSource;
      delete nextData.emailFoundOn;
      return;
    }
    nextData.emailSource = 'manual';
    // Same classifier the scraper runs, generated from src/config/lead-email-kind.ts. The fallback
    // is 'personal' because it is the cautious one: it over-warns rather than quietly promoting an
    // unclassifiable address to a role inbox.
    nextData.emailKind = (window.LeadEmailKind && window.LeadEmailKind.classify(after)) || 'personal';
    // Provenance for the Review Queue, which otherwise shows a bare address with no account of
    // where it came from. `emailFoundOn` is a URL on the scrape path, so it is dropped rather than
    // stuffed with prose.
    delete nextData.emailFoundOn;
    nextData.emailEnteredAt = new Date().toISOString();
  }

  function openEditLeadModal(record, opts) {
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
      stampContactProvenance(data, nextData);
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
    // Arriving from "Add an address" lands the cursor in the Email field rather than on Company:
    // the button named one job, and the form should not ask the user to find it again.
    const wanted = opts && opts.focus ? overlay.querySelector(`[name="${opts.focus}"]`) : null;
    (wanted || overlay.querySelector('input[name="title"]'))?.focus();
  }

  async function init({ hub, assistantId }) {
    if (!hub || !assistantId) return;
    state.hub = hub;
    state.assistantId = assistantId;
    state.records = [];
    // A different assistant is a different table: its columns, its vocabularies, and any row the
    // user had ticked all belong to the one being left. refresh() deliberately does NOT do this —
    // returning to a tab you had filtered should find it as you left it.
    state.view = { search: '', filters: {}, sortKey: null, sortDir: 'asc', groupKey: null, page: 1, collapsed: new Set() };
    state.selected.clear();
    // Same reasoning as the view reset above: a different assistant is a different table, and both
    // the graveyard and the last send-back outcome belong to the one being left.
    state.deletedRecords = [];
    state.deletedOpen = false;
    state.returnedNotice = null;
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

  window.AssistantDataHub = { init, refresh, focusRecord, openRecordModal };
})();
