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

  // Resolve a hubTab column key against a record: envelope fields first, then a
  // dot-path into record.data. Arrays read as counts.
  function cellValue(record, key) {
    if (key === 'title') return record.title;
    if (key === 'status') return record.status ?? '—';
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

  const state = { hub: null, assistantId: null, records: [] };

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
      const draft = record.data?.outreachDraft;
      if (draft && draft.body) {
        buttons.push({ label: 'Copy outreach draft', async run(btn) {
          await navigator.clipboard.writeText(`Subject: ${draft.subject || ''}\n\n${draft.body}`);
          btn.textContent = 'Copied ✓';
        }});
      }
    }

    buttons.push({ label: 'Delete', danger: true, async run(btn, status, row) {
      const res = await fetch(API, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: record.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not delete the record.');
      state.records = state.records.filter((r) => r.id !== record.id);
      renderTable();
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

  // Content Library row detail — the post content, read-only. Approval/scheduling actions
  // deliberately live in the Review Queue / Calendar, so this stays a browse-only view.
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
    return wrap;
  }

  function detailPanel(record) {
    const panel = document.createElement('div');
    panel.className = 'px-5 py-4 bg-gray-50/70';

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
    panel.appendChild(body || keyValueFallback(record.data));
    panel.appendChild(detailActions(record));
    return panel;
  }

  // ── Table ───────────────────────────────────────────────────────────────────

  function rowHtml(record) {
    const cols = state.hub.columns.map((c, i) => `
      <td class="px-4 py-3 ${i === 0 ? 'font-semibold text-gray-900' : 'text-gray-700'}">${
        c.key === 'status'
          ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full border bg-gray-50 text-gray-600 border-gray-200 whitespace-nowrap">${esc(cellValue(record, c.key))}</span>`
          : esc(cellValue(record, c.key))
      }</td>`).join('');
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

  function renderTable() {
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
        <div class="flex items-center gap-2 shrink-0">
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

  window.AssistantDataHub = { init, refresh };
})();
