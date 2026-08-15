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

  const state = {
    hub: null, assistantId: null, records: [], pendingFocusId: null,
    // How the table is being READ right now — the filter/sort/group controls. Kept out of the
    // record list so a refetch (which happens every time the tab is opened) leaves the user's
    // view alone: coming back to a tab you had filtered to "Awaiting you" and finding it reset is
    // the tab losing your place.
    // `page` rides with the rest of the view for the same reason: coming back to a tab you had
    // paged into and landing on page one is the tab losing your place. It is reset by anything that
    // changes WHICH rows are on screen (search, filter, group, sort, Clear) — staying on page 4 of a
    // list that just became eleven rows shows an empty table under a full-looking filter strip.
    view: { search: '', filters: {}, sortKey: null, sortDir: 'asc', groupKey: null, page: 1 },
    // Ids ticked for a bulk action. A Set of record ids rather than DOM state, because rows are
    // re-rendered on every filter keystroke and after every PATCH.
    selected: new Set(),
  };

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

  // ── Clearing out a selection ────────────────────────────────────────────────
  //
  // Deleting one lead at a time is fine when there is one bad lead. A search that came back aimed
  // at the wrong market returns forty, and the only way to clear them was to open, delete, and
  // find your place again, forty times — which is how the Leads tab silently became somewhere
  // people stopped tidying, and how storage kept growing on rows nobody wanted.
  //
  // ⚠️ The reason is asked ONCE, for the whole selection, and it is asked BEFORE anything is
  // deleted — the same ordering rule and the same reason as deleteReasonStrip above
  // (`discovered_leads.assistant_record_id` is ON DELETE SET NULL, so a reason collected after the
  // fact can never find the lead it was about). One reason for forty leads is also the honest
  // shape of the act: a user clearing a bad search is making ONE judgement about all of them, and
  // that judgement is exactly what the targeting feedback wants to hear.

  /** Delete a set of records in one pass, banking the reason against every one of them. */
  async function deleteRecords(ids, reason) {
    // Chunked to the server's MAX_BULK_DELETE. Going over is a 400 there rather than a silent
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
    renderTable();
    return { deleted, notFound };
  }

  /** The confirmation for a bulk delete: what is about to go, and the chance to say why. */
  function bulkDeleteStrip(ids) {
    const RC = window.RevenueConstants;
    const isLead = state.hub.recordType === 'lead';
    const n = ids.length;
    const noun = n === 1 ? 'record' : 'records';
    const strip = document.createElement('div');
    strip.className = 'mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2';
    const reasons = (isLead && RC && Array.isArray(RC.leadRejectReasons)) ? RC.leadRejectReasons : [];
    const chip = 'px-2 py-1 text-[11px] font-bold rounded-lg bg-white border border-gray-200 text-gray-700 hover:border-red-300 hover:text-red-800 transition cursor-pointer';

    strip.innerHTML = `
      <p class="text-xs font-bold text-gray-800">Delete ${n} ${esc(noun)}?</p>
      <p class="text-[11px] text-gray-600 mb-2">This removes them for good.${isLead
        ? ' If the problem is that the search shouldn’t have found them, <strong>Reject</strong> keeps the records and tells future searches what to avoid.'
        : ''}</p>
      ${reasons.length ? `<div class="flex flex-wrap gap-1.5">
        ${reasons.map((r) => `<button type="button" class="${chip}" data-hub-bulk-reason="${esc(r)}">${esc(RC.leadRejectReasonLabel(r))}</button>`).join('')}
      </div>
      <p class="text-[11px] text-gray-500 mt-1.5">Pick one reason for all ${n} — it is recorded against every one of them, and it is what teaches the search.</p>` : ''}
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
        window.showToast?.(`Deleted ${deleted} ${deleted === 1 ? 'record' : 'records'}.`
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
  function nextStepGuidance(record) {
    if (state.hub.recordType !== 'lead') return null;
    const d = record.data || {};

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
      return { owner: 'assistant', action: { key: 'record-outcome', label: 'Record outcome' },
        note: 'The outreach email has gone and the follow-ups are handled for you. Anything else in that step — a call, a meeting, a look at their site — is yours.' };
    }

    if (!contactEmailOf(record)) {
      return { owner: 'you', action: { key: 'add-address', label: 'Add an address' },
        note: 'There is no email address on this lead, so nothing can be sent for you until you add one.' };
    }

    if (record.approvalStatus === 'approved') {
      // Only offered when the tab switcher is actually there. assistant-data-hub also renders
      // inside a modal from the Searches tab, where the page around it is the same one — but a
      // button that silently does nothing is worse than no button, so it is gated on the function.
      const canOpenReview = typeof window._activateMainTab === 'function';
      return { owner: 'you', action: canOpenReview ? { key: 'open-review', label: 'Open Review' } : null,
        note: 'Approved — but nothing has been sent yet. The drafted email is waiting for you in the Review tab.' };
    }

    return { owner: 'you', action: { key: 'approve', label: 'Approve' },
      note: 'Approving clears this lead for outreach. The email itself goes out when you approve it in the Review tab.' };
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
      // The Contact chip has been telling users to "add an address by hand" for a while, and the
      // only place to do it was an Email field three items down a modal called "Edit lead" — a
      // remedy nobody would find from the sentence offering it. On a lead with no address this is
      // the only action that unblocks anything, so it leads the row and says what it does.
      if (!contactEmailOf(record)) {
        buttons.push({ label: 'Add an address', key: 'add-address', async run(btn) {
          btn.disabled = false;
          openEditLeadModal(record, { focus: 'contactEmail' });
        }});
      }
      // "Look again" is offered ONLY on a lead we have actually looked at and found nothing on
      // (state 'none'). On every other no-address state the stamp it clears is already absent, so
      // the button would be a no-op dressed as an action: 'missed' and 'checking' are unstamped by
      // definition, and 'unchecked' is a cold lead the scraper skips on rating.
      if (contactState(record) === 'none') {
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
      buttons.push({ label: 'Edit', key: 'edit', async run(btn) {
        btn.disabled = false;           // opening a modal shouldn't leave the button stuck disabled
        openEditLeadModal(record);
      }});
      // The only way anything in this product records a won/lost deal. Offered on every lead, not
      // just contacted ones: disqualifying a lead you never emailed is a real, useful outcome —
      // `not_icp` on an untouched lead is the cleanest targeting signal there is.
      buttons.push({
        label: record.data?.dealOutcome?.outcome ? 'Change outcome' : 'Record outcome',
        key: 'record-outcome',
        async run(btn) {
          btn.disabled = false;
          openOutcomeModal(record);
        },
      });
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
      // Offered for anything not already approved. Not hidden for rejected leads: reversing a
      // rejection is a legitimate correction, and the Approval cell states the result either way.
      if (record.approvalStatus !== 'approved') {
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

      // Reject — see the block comment above rejectReasonStrip for why this is a different act
      // from "Record outcome → Disqualified", and why it needed to exist on this tab: users read a
      // lead in full HERE, and had to go and find it again in Review to turn it down.
      //
      // Hidden once already rejected. Not hidden for approved/scheduled leads: an approved lead
      // whose outreach has already gone out can still be the wrong kind of company to have found,
      // and that is exactly the fact the targeting feedback wants.
      if (record.approvalStatus !== 'rejected') {
        buttons.push({ label: 'Reject', key: 'reject', async run(btn, status) {
          const res = await fetch(API, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: record.id, approvalStatus: 'rejected' }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Could not reject that lead.');
          record.approvalStatus = 'rejected';
          // Same reasoning as Approve above: a decision already taken is a state, not an offer.
          btn.textContent = 'Rejected ✓';
          btn.disabled = true;
          // Both places the state is stated: the row's Approval cell, and the banner above the
          // open record. refreshRow rewrites the cells in place rather than re-rendering the
          // table, which would collapse the panel the user is still reading.
          refreshRow(record);
          const chip = btn.closest('[data-hub-detail]')?.querySelector('[data-hub-approval]');
          if (chip) chip.innerHTML = `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${APPROVAL_CHIP.rejected.cls}">${esc(APPROVAL_CHIP.rejected.label)}</span>`;
          syncNextStepFooter(btn.closest('[data-hub-detail]'), record);
          // Asked AFTER the rejection commits, never as a gate on it: the reason is an annotation
          // on a decision the user has already made, and blocking the reject behind it would only
          // buy worse answers from someone with nineteen more leads to get through.
          status.parentElement?.appendChild(rejectReasonStrip(record));
        }});
      }
    }

    // Deleting a LEAD asks why first — see deleteReasonStrip for why this one confirms up front
    // while Reject deliberately asks afterwards. Every other record type deletes as before.
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

    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      // The handle nextStepGuidance()'s action button presses. Set here rather than per-push so a
      // button that gains a key never has to remember to render it.
      if (b.key) btn.setAttribute('data-hub-action', b.key);
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
    panel.appendChild(body || keyValueFallback(record.data));
    panel.appendChild(detailActions(record));
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
    approvalStatus: ['Awaiting you', 'Approved', 'Chase set', 'Rejected'],
    // Contact: most reachable first — that is what the column is asked.
    contact: ['Role inbox', 'Named person', 'Checking…', 'Not attempted', 'Not checked', 'None found'],
  };

  /** A comparable for one cell: number where the column is numeric, rank where it is a vocabulary. */
  function sortValue(record, key) {
    if (key === 'updatedAt') {
      const t = new Date(record.updatedAt).getTime();
      return Number.isNaN(t) ? -Infinity : t;
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

  function filterableColumns() {
    return state.hub.columns.filter((c) => {
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
        cell = `<span class="text-xs font-bold px-2 py-0.5 rounded-full border bg-gray-50 text-gray-600 border-gray-200 whitespace-nowrap${ratingHelp ? ' cursor-help' : ''}"${ratingHelp ? ` title="${esc(ratingHelp)}"` : ''}>${esc(cellValue(record, c.key))}</span>`;
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
        // The address when there is one, otherwise the reason there is not — plus, on a lead with
        // no address, the fact that there IS something to open. Without this line the profiles are
        // only discoverable by opening every red chip in the table one at a time, which is the same
        // dead end the chip had before, one click further in.
        const tip = email || [s.why, socialHint(record)].filter(Boolean).join(' ') || '';
        cell = `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${s.cls} whitespace-nowrap"${tip ? ` title="${esc(tip)}"` : ''}>${esc(s.short)}</span>`;
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
    const el = document.getElementById('datahub-tab-label');
    if (!el || !state.hub || state.hub.kind === 'content_library') return;
    const n = state.records.length;
    el.textContent = n ? `${state.hub.label} (${n})` : state.hub.label;
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
        <button type="button" data-hub-bulkdelete
          class="ml-auto px-3 py-1.5 bg-white border border-red-200 text-red-700 hover:bg-red-100 text-xs font-bold rounded-lg transition cursor-pointer"></button>
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
    if (group) group.addEventListener('change', () => { state.view.groupKey = group.value || null; resetPage(); paintRows(); });

    host.querySelector('[data-hub-clear]')?.addEventListener('click', () => {
      state.view.search = '';
      state.view.filters = {};
      state.view.groupKey = null;
      state.view.sortKey = null;
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
    host.querySelector('[data-hub-selectall]')?.addEventListener('click', () => {
      for (const r of visibleRecords()) state.selected.add(r.id);
      paintRows();
    });
    host.querySelector('[data-hub-selectnone]')?.addEventListener('click', () => {
      state.selected.clear();
      paintRows();
    });
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
      if (group.label !== null) {
        const head = document.createElement('tr');
        head.className = 'bg-gray-50';
        head.innerHTML = `<td colspan="${span}" class="px-4 py-2 text-xs font-bold text-gray-600 uppercase tracking-wide">
          ${esc(group.label)} <span class="text-gray-400 normal-case">· ${group.records.length}</span>
        </td>`;
        tbody.appendChild(head);
      }
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
    const bar = host && host.querySelector('[data-hub-bulkbar]');
    if (!bar) return;
    const n = state.selected.size;
    // `hidden` loses to a class that sets display, and this bar is a flex row — pin both.
    bar.classList.toggle('hidden', n === 0);
    bar.style.display = n === 0 ? 'none' : 'flex';
    if (n === 0) return;

    const matching = visibleRecords().length;
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
      host.innerHTML = `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 text-center">
          <p class="text-4xl mb-3">🗂️</p>
          <p class="font-bold text-gray-900 mb-1">Nothing in ${esc(hub.label)} yet</p>
          <p class="text-sm text-gray-500 max-w-md mx-auto">${emptyMsg}</p>
        </div>`;
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
                ${selectable() ? '<th class="pl-4 pr-1 py-3 w-8"></th>' : ''}
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
      </div>`;

    wireControls(host);
    paintRows();
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
    state.view = { search: '', filters: {}, sortKey: null, sortDir: 'asc', groupKey: null, page: 1 };
    state.selected.clear();
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
