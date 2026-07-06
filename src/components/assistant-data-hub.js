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
    const res = await fetch(`${API}?assistantId=${state.assistantId}&recordType=${encodeURIComponent(state.hub.recordType)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load records.');
    state.records = data.records || [];
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

    // Leads: the outreach draft, without re-opening the chat.
    if (state.hub.recordType === 'lead') {
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

  function detailPanel(record) {
    const panel = document.createElement('div');
    panel.className = 'px-5 py-4 bg-gray-50/70';

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
      host.innerHTML = `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 text-center">
          <p class="text-4xl mb-3">🗂️</p>
          <p class="font-bold text-gray-900 mb-1">Nothing in ${esc(hub.label)} yet</p>
          <p class="text-sm text-gray-500 max-w-md mx-auto">Work your assistant produces in chat lands here automatically — or import a CSV to get started. ${esc(hub.importHint)}</p>
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

  function renderToolbar() {
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
          <input type="file" accept=".csv" class="hidden" data-hub-file>
          <button type="button" data-hub-import
            class="inline-flex items-center gap-2 px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap">
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

  window.AssistantDataHub = { init };
})();
