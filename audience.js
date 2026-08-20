// audience.js — the shared Audience view controller (audience.html).
// IIFE, like every other view controller here: the router re-runs inline scripts on each view swap,
// so anything at top-level scope would redeclare on the second visit.
//
// ⚠️ ORG-WIDE. Nothing in this file reads window._currentAssistantId. The audience belongs to the
// organisation — the server resolves it from the session — and a view that inherited an assistant
// id would show a different list depending on which workspace was opened first.
(function () {

  const CONTACTS_API = '/.netlify/functions/audience-contacts';
  const SEGMENTS_API = '/.netlify/functions/audience-segments';
  const PAGE_SIZE = 25;
  /** Rows per request during an import. Matches IMPORT_CHUNK_MAX on the server. */
  const IMPORT_CHUNK = 500;

  const esc = (s) => window.escapeHtml ? window.escapeHtml(s) : String(s ?? '');
  const $ = (id) => document.getElementById(id);

  const state = {
    contacts: [],
    segments: [],
    counts: {},
    total: 0,
    truncated: false,
    page: 1,
    selected: new Set(),
    filters: { q: '', status: '', segmentId: '' },
    customFields: [],
    searchTimer: null,
    needsSetup: false,
  };

  // ── Status vocabulary ──────────────────────────────────────────────────────
  // Mirrors audience_contacts.status. The wording matters more than it looks: "Unsubscribed" and
  // "Marked as spam" are things the PERSON did, "Suppressed" is something we did, and a tenant
  // reading the list has to be able to tell those apart before they go asking why a send was small.
  const STATUS = {
    subscribed:   { label: 'Subscribed',   cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    pending:      { label: 'Awaiting confirmation', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
    unsubscribed: { label: 'Unsubscribed', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
    bounced:      { label: 'Bounced',      cls: 'bg-red-100 text-red-700 border-red-200' },
    complained:   { label: 'Marked as spam', cls: 'bg-red-100 text-red-700 border-red-200' },
    suppressed:   { label: 'Suppressed',   cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  };

  const SOURCE_LABEL = {
    web_form: 'Sign-up form',
    csv_import: 'Imported',
    manual: 'Added by hand',
    lead_promotion: 'From a lead',
    api: 'API',
  };

  const EVENT_LABEL = {
    subscribe_requested: 'Signed up',
    confirmed: 'Confirmed their subscription',
    unsubscribed: 'Unsubscribed',
    resubscribed: 'Re-subscribed',
    bounced: 'Email bounced',
    complained: 'Marked an email as spam',
    imported: 'Imported from a file',
    promoted: 'Promoted from a lead',
    manual_added: 'Added by hand',
    erased: 'Removed from the audience',
  };

  const fmtDate = (v) => {
    if (!v) return '—';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const fmtDateTime = (v) => {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  // `hidden` loses to any utility that sets display (flex/inline-flex), so every show/hide here
  // touches BOTH. Getting this wrong leaves modals stuck open with no visible cause.
  function show(el, display = 'flex') {
    if (!el) return;
    el.classList.remove('hidden');
    el.style.display = display;
  }
  function hide(el) {
    if (!el) return;
    el.classList.add('hidden');
    el.style.display = 'none';
  }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* a non-JSON error page is still an error */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data || {};
  }

  // ── Load ───────────────────────────────────────────────────────────────────

  async function loadSegments() {
    try {
      const { segments } = await api(SEGMENTS_API);
      state.segments = segments || [];
    } catch (err) {
      console.error('[audience] segments failed to load', err);
      state.segments = [];
    }
    renderSegments();
    fillSegmentSelects();
  }

  async function loadContacts() {
    const params = new URLSearchParams();
    if (state.filters.q) params.set('q', state.filters.q);
    if (state.filters.status) params.set('status', state.filters.status);
    if (state.filters.segmentId) params.set('segmentId', state.filters.segmentId);

    try {
      const data = await api(`${CONTACTS_API}?${params.toString()}`);
      state.contacts = data.contacts || [];
      state.counts = data.counts || {};
      state.total = data.total || 0;
      state.truncated = !!data.truncated;
      state.selected.clear();
      // The environment has the code but not the tables (db/audience.sql not applied here). Say
      // that, rather than rendering a confident empty audience — "you have no contacts" and "this
      // feature is not installed" must never look the same.
      state.needsSetup = !!data.needsSetup;
      renderKpis();
      renderTruncation(data.cap);
      renderRows();
      renderBulk();
    } catch (err) {
      console.error('[audience] contacts failed to load', err);
      const tbody = $('aud-rows');
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-red-600 text-sm">${esc(err.message)}</td></tr>`;
      }
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function renderKpis() {
    const host = $('aud-kpis');
    if (!host) return;
    const map = {
      subscribed: state.counts.subscribed || 0,
      pending: state.counts.pending || 0,
      unsubscribed: (state.counts.unsubscribed || 0) + (state.counts.complained || 0) + (state.counts.bounced || 0),
      total: state.total,
    };
    host.querySelectorAll('[data-kpi]').forEach((el) => {
      el.textContent = Number(map[el.getAttribute('data-kpi')] || 0).toLocaleString();
    });
  }

  function renderTruncation(cap) {
    const el = $('aud-truncated');
    if (!el) return;
    if (!state.truncated) { hide(el); return; }
    el.textContent = `Showing the ${Number(cap || 0).toLocaleString()} most recent contacts of ${state.total.toLocaleString()}. Use search or a filter to narrow this down — the counts above still cover everyone.`;
    show(el, 'block');
  }

  // ── Rule-based segments ────────────────────────────────────────────────────
  // The field list mirrors RULE_FIELDS in src/utils/audience-segment-rules.ts. The SERVER is the
  // authority — it validates every rule and refuses ones it cannot read — so a mismatch here shows
  // up as a refusal with a reason rather than as a segment that quietly means something else.
  const RULE_FIELDS = {
    source:       { label: 'How they joined',    ops: { is: 'is', is_not: 'is not' }, value: 'source' },
    joined:       { label: 'Joined',             ops: { within: 'in the last', not_within: 'more than' }, value: 'days' },
    opened:       { label: 'Opened an email',    ops: { within: 'in the last', not_within: 'not in the last' }, value: 'days' },
    emailed:      { label: 'Has been emailed',   ops: { never: 'never', ever: 'at least once' }, value: null },
    form:         { label: 'Signed up through',  ops: { is: 'is' }, value: 'form' },
    tag:          { label: 'Tagged',             ops: { in: 'is', not_in: 'is not' }, value: 'tag' },
    custom:       { label: 'Custom field',       ops: { is: 'is', is_not: 'is not', contains: 'contains', is_set: 'has any value', is_not_set: 'is empty' }, value: 'custom' },
    email_domain: { label: 'Email domain',       ops: { is: 'is', is_not: 'is not' }, value: 'domain' },
  };
  const SOURCE_OPTS = {
    web_form: 'a sign-up form', csv_import: 'an import', manual: 'being added by hand',
    lead_promotion: 'the Lead Generator', api: 'the API',
  };

  let ruleState = { id: null, name: '', match: 'all', conditions: [{ field: 'opened', op: 'within', value: 90 }] };
  // Loaded when the builder opens: without the form list there is nothing to choose between, so
  // the "signed up through" condition is only offered once a tenant actually has a form.
  let ruleForms = [];

  function openRuleModal(segment) {
    const modal = $('aud-rule-modal');
    if (!modal) return;
    ruleState = segment
      ? {
          id: segment.id,
          name: segment.name,
          match: (segment.rules && segment.rules.match) === 'any' ? 'any' : 'all',
          conditions: (segment.rules && Array.isArray(segment.rules.conditions) && segment.rules.conditions.length)
            ? JSON.parse(JSON.stringify(segment.rules.conditions))
            : [{ field: 'opened', op: 'within', value: 90 }],
        }
      : { id: null, name: '', match: 'all', conditions: [{ field: 'opened', op: 'within', value: 90 }] };
    $('aud-rule-title').textContent = segment ? `Rule for “${segment.name}”` : 'New rule-based segment';
    show(modal, 'flex');
    renderRuleBuilder();
    previewRule();
    // Repaint once the forms arrive; the builder is usable in the meantime.
    fetch(FORMS_API).then((r) => (r.ok ? r.json() : { forms: [] })).then((d) => {
      ruleForms = d.forms || [];
      if (ruleForms.length) renderRuleBuilder();
    }).catch(() => { /* the condition is simply not offered */ });
  }

  function renderRuleBuilder() {
    const body = $('aud-rule-body');
    if (!body) return;
    const rows = ruleState.conditions.map((c, i) => {
      const spec = RULE_FIELDS[c.field] || RULE_FIELDS.source;
      const ops = Object.entries(spec.ops)
        .map(([k, lbl]) => `<option value="${k}" ${c.op === k ? 'selected' : ''}>${esc(lbl)}</option>`).join('');
      let valueInput = '';
      if (spec.value === 'source') {
        valueInput = `<select data-rule-value="${i}" class="px-2 py-2 rounded-lg border border-gray-300 text-sm">
          ${Object.entries(SOURCE_OPTS).map(([k, lbl]) => `<option value="${k}" ${c.value === k ? 'selected' : ''}>${esc(lbl)}</option>`).join('')}
        </select>`;
      } else if (spec.value === 'days') {
        valueInput = `<input type="number" min="1" max="3650" data-rule-value="${i}" value="${Number(c.value) || 30}"
          class="w-24 px-2 py-2 rounded-lg border border-gray-300 text-sm"><span class="text-sm text-gray-500">days</span>`;
      } else if (spec.value === 'custom') {
        // Two inputs, because a custom condition has two parts: WHICH field, and what it says. The
        // presence ops take no value at all — "we hold a city for this person" is a whole question.
        const picker = `<select data-rule-key="${i}" class="px-2 py-2 rounded-lg border border-gray-300 text-sm">
          ${state.customFields.map((f) => `<option value="${esc(f.key)}" ${c.key === f.key ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
        </select>`;
        const needsValue = c.op !== 'is_set' && c.op !== 'is_not_set';
        valueInput = picker + (needsValue
          ? `<input type="text" data-rule-value="${i}" value="${esc(c.value || '')}" placeholder="Bristol"
              class="px-2 py-2 rounded-lg border border-gray-300 text-sm">`
          : '');
      } else if (spec.value === 'tag') {
        // Tags and manual segments only — a rule built on another rule is a cycle, and the server
        // refuses it with a sentence naming the segment.
        const targets = state.segments.filter((x) => x.kind !== 'dynamic');
        valueInput = `<select data-rule-value="${i}" class="px-2 py-2 rounded-lg border border-gray-300 text-sm">
          ${targets.map((t) => `<option value="${t.id}" ${String(c.value) === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>`;
      } else if (spec.value === 'form') {
        valueInput = `<select data-rule-value="${i}" class="px-2 py-2 rounded-lg border border-gray-300 text-sm">
          ${ruleForms.map((f) => `<option value="${f.id}" ${String(c.value) === String(f.id) ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
        </select>`;
      } else if (spec.value === 'domain') {
        valueInput = `<input type="text" data-rule-value="${i}" value="${esc(c.value || '')}" placeholder="gmail.com"
          class="px-2 py-2 rounded-lg border border-gray-300 text-sm">`;
      }
      return `<div class="flex flex-wrap items-center gap-2 py-2">
        <select data-rule-field="${i}" class="px-2 py-2 rounded-lg border border-gray-300 text-sm">
          ${Object.entries(RULE_FIELDS)
            .filter(([k]) => (k !== 'form' || ruleForms.length)
              && (k !== 'tag' || state.segments.some((x) => x.kind !== 'dynamic'))
              && (k !== 'custom' || state.customFields.length))
            .map(([k, f]) => `<option value="${k}" ${c.field === k ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
        </select>
        <select data-rule-op="${i}" class="px-2 py-2 rounded-lg border border-gray-300 text-sm">${ops}</select>
        ${valueInput}
        <button type="button" data-rule-remove="${i}" class="ml-auto text-xs font-bold text-gray-400 hover:text-red-600 cursor-pointer">Remove</button>
      </div>`;
    }).join('');

    body.innerHTML = `
      <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Name</label>
      <input type="text" id="aud-rule-name" maxlength="80" value="${esc(ruleState.name)}" placeholder="Recently engaged"
        class="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm mb-4"
        ${ruleState.id ? 'disabled' : ''}>

      <div class="flex items-center gap-2 mb-1">
        <span class="text-sm text-gray-700">Match</span>
        <select id="aud-rule-match" class="px-2 py-1.5 rounded-lg border border-gray-300 text-sm">
          <option value="all" ${ruleState.match === 'all' ? 'selected' : ''}>all of these</option>
          <option value="any" ${ruleState.match === 'any' ? 'selected' : ''}>any of these</option>
        </select>
      </div>
      <div class="divide-y divide-gray-100">${rows}</div>
      <button type="button" id="aud-rule-add" class="mt-2 text-xs font-bold text-emerald-700 hover:text-emerald-800 cursor-pointer">+ Add a condition</button>

      <div id="aud-rule-preview" class="mt-5 px-4 py-3 rounded-xl bg-gray-50 border border-gray-200 text-sm text-gray-700">Working it out…</div>

      <div class="flex justify-end gap-2 mt-4">
        <button type="button" data-aud-rule-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 cursor-pointer">Cancel</button>
        <button type="button" id="aud-rule-save" class="px-4 py-2 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Save segment</button>
      </div>`;

    body.querySelectorAll('[data-rule-field]').forEach((el) => el.addEventListener('change', () => {
      const i = Number(el.getAttribute('data-rule-field'));
      const field = el.value;
      // Changing the field changes which comparisons exist, so the row is rebuilt from the new
      // field's first op rather than keeping one that no longer applies.
      const spec = RULE_FIELDS[field];
      ruleState.conditions[i] = {
        field,
        op: Object.keys(spec.ops)[0],
        ...(spec.value === 'custom' ? { key: (state.customFields[0] || {}).key } : {}),
        value: spec.value === 'days' ? 30
          : spec.value === 'source' ? 'web_form'
          : spec.value === 'form' ? (ruleForms[0] && ruleForms[0].id)
          : spec.value === 'tag' ? (state.segments.find((x) => x.kind !== 'dynamic') || {}).id
          : spec.value === 'domain' ? '' : undefined,
      };
      renderRuleBuilder(); previewRule();
    }));
    body.querySelectorAll('[data-rule-op]').forEach((el) => el.addEventListener('change', () => {
      const i = Number(el.getAttribute('data-rule-op'));
      ruleState.conditions[i].op = el.value;
      // A custom condition changes SHAPE with its comparison — "is empty" has no value box — so the
      // row is repainted rather than left showing an input the rule will ignore.
      if (ruleState.conditions[i].field === 'custom') renderRuleBuilder();
      previewRule();
    }));
    body.querySelectorAll('[data-rule-key]').forEach((el) => el.addEventListener('change', () => {
      ruleState.conditions[Number(el.getAttribute('data-rule-key'))].key = el.value;
      previewRule();
    }));
    body.querySelectorAll('[data-rule-value]').forEach((el) => el.addEventListener('change', () => {
      const i = Number(el.getAttribute('data-rule-value'));
      ruleState.conditions[i].value = el.type === 'number' ? Number(el.value) : el.value;
      previewRule();
    }));
    body.querySelectorAll('[data-rule-remove]').forEach((el) => el.addEventListener('click', () => {
      ruleState.conditions.splice(Number(el.getAttribute('data-rule-remove')), 1);
      renderRuleBuilder(); previewRule();
    }));
    $('aud-rule-match')?.addEventListener('change', (e) => { ruleState.match = e.target.value; previewRule(); });
    $('aud-rule-name')?.addEventListener('input', (e) => { ruleState.name = e.target.value; });
    $('aud-rule-add')?.addEventListener('click', () => {
      ruleState.conditions.push({ field: 'source', op: 'is', value: 'web_form' });
      renderRuleBuilder(); previewRule();
    });
    body.querySelectorAll('[data-aud-rule-close]').forEach((el) => el.addEventListener('click', () => hide($('aud-rule-modal'))));
    $('aud-rule-save')?.addEventListener('click', saveRuleSegment);
  }

  // ⚠️ The preview asks the SERVER, which counts through the same compiler the send uses. A count
  // worked out in the browser would be a second implementation of "who is in this segment", and
  // the one that drifts is the one that emails people.
  async function previewRule() {
    const host = $('aud-rule-preview');
    if (!host) return;
    try {
      const { matches, description } = await api(SEGMENTS_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', rules: { match: ruleState.match, conditions: ruleState.conditions } }),
      });
      host.className = 'mt-5 px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-900';
      host.innerHTML = `<p class="font-bold">${Number(matches).toLocaleString()} ${matches === 1 ? 'person matches' : 'people match'} right now.</p>
        <p class="text-[12px] mt-1">${esc(description || '')}</p>
        <p class="text-[11px] text-emerald-700 mt-1">This is worked out again every time — the number will move as your audience does.</p>`;
    } catch (err) {
      // The refusal, verbatim. It names the condition it could not read.
      host.className = 'mt-5 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900';
      host.textContent = err.message;
    }
  }

  async function saveRuleSegment() {
    const rules = { match: ruleState.match, conditions: ruleState.conditions };
    try {
      if (ruleState.id) {
        await api(SEGMENTS_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'setRules', id: ruleState.id, rules }),
        });
      } else {
        if (!ruleState.name.trim()) { window.showToast('Give the segment a name.'); return; }
        await api(SEGMENTS_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create', name: ruleState.name.trim(), kind: 'dynamic', rules }),
        });
      }
      hide($('aud-rule-modal'));
      await loadSegments();
      await loadContacts();
    } catch (err) { window.showToast(err.message); }
  }

  // ── Custom fields ──────────────────────────────────────────────────────────

  const FIELDS_API = '/.netlify/functions/audience-custom-fields';

  async function loadCustomFields() {
    try {
      const { fields } = await api(FIELDS_API);
      state.customFields = fields || [];
    } catch { state.customFields = []; }
    renderCustomFields();
  }

  function renderCustomFields() {
    const host = $('aud-fields');
    if (!host) return;
    if (!state.customFields.length) {
      host.innerHTML = '<p class="text-sm text-gray-400">No custom fields yet. Add one to store your own details — a city, a plan, where you met.</p>';
      return;
    }
    host.innerHTML = state.customFields.map((f) => `
      <span class="inline-flex items-center rounded-full border bg-white border-gray-300" title="Use {{contact.custom.${esc(f.key)}}} in an email">
        <span class="px-3 py-1.5 text-xs font-bold text-gray-700">${esc(f.label)}
          <span class="text-gray-400 font-mono">${esc(f.key)}</span>
        </span>
        <button type="button" data-field-delete="${f.id}" title="Delete field"
          class="pr-3 pl-1 text-xs text-gray-300 hover:text-red-500 cursor-pointer">&times;</button>
      </span>`).join('');

    host.querySelectorAll('[data-field-delete]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = Number(btn.getAttribute('data-field-delete'));
      const f = state.customFields.find((x) => x.id === id);
      let held = null;
      try { held = (await api(FIELDS_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'usage', id }),
      })).contacts; } catch { /* the count is a courtesy, not a gate */ }
      // ⚠️ Says what is NOT deleted. The values stay on the contacts, so re-creating the field with
      // the same name brings them back — which is worth knowing before deciding.
      const ok = await window.confirmModal(
        `Delete the field “${f ? f.label : ''}”?`
        + (held ? ` ${held.toLocaleString()} ${held === 1 ? 'contact holds' : 'contacts hold'} a value for it.` : '')
        + ' The values stay on your contacts and come back if you add the field again — but anything using it, like a segment rule or an email, will stop finding it.',
        { title: 'Delete custom field?', confirmLabel: 'Delete field' });
      if (!ok) return;
      try {
        await api(FIELDS_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id }),
        });
        await loadCustomFields();
      } catch (err) { window.showToast(err.message); }
    }));
  }

  function renderSegments() {
    // Same data, two rows: a tag IS a manual segment (db/audience-tags.sql), and the split is
    // presentational so forty labels do not bury four sendable audiences.
    renderChips($('aud-segments'), state.segments.filter((s) => s.kind !== 'tag'), true,
      'No segments yet. Create one to target a newsletter at part of your audience.');
    renderChips($('aud-tags'), state.segments.filter((s) => s.kind === 'tag'), false,
      'No tags yet. Tag people to describe them, then build a segment from the tag.');
  }

  function renderChips(host, list, withEveryone, emptyText) {
    if (!host) return;
    if (!list.length) {
      host.innerHTML = `<p class="text-sm text-gray-400">${esc(emptyText)}</p>`;
      return;
    }
    const all = withEveryone
      ? `<button type="button" data-segment="" class="px-3 py-1.5 text-xs font-bold rounded-full border transition cursor-pointer ${!state.filters.segmentId ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'}">Everyone</button>`
      : '';
    host.innerHTML = all + list.map((s) => {
      const active = String(state.filters.segmentId) === String(s.id);
      const dyn = s.kind === 'dynamic';
      // The rule in words, on hover. A count alone is not checkable — "412" looks equally right
      // whatever the rule says.
      const title = dyn ? ` title="${esc(s.rulesError || s.description || '')}"` : '';
      return `<span class="inline-flex items-center rounded-full border ${s.rulesError ? 'bg-red-50 border-red-300' : active ? 'bg-emerald-600 border-emerald-600' : 'bg-white border-gray-300'}"${title}>
        <button type="button" data-segment="${s.id}" class="px-3 py-1.5 text-xs font-bold rounded-full cursor-pointer ${active ? 'text-white' : 'text-gray-700'}">
          ${dyn ? `<span class="${active ? 'text-emerald-100' : 'text-emerald-600'}">◆</span> ` : ''}${esc(s.name)}
          ${s.rulesError
            ? '<span class="text-red-600">rules broken</span>'
            : `<span class="${active ? 'text-emerald-100' : 'text-gray-400'}">${Number(s.subscribedCount || 0).toLocaleString()}</span>`}
        </button>
        ${dyn ? `<button type="button" data-segment-rules="${s.id}" title="Edit the rule"
          class="px-1 text-xs ${active ? 'text-emerald-100 hover:text-white' : 'text-gray-400 hover:text-emerald-700'} cursor-pointer">edit</button>` : ''}
        <button type="button" data-segment-delete="${s.id}" title="Delete segment"
          class="pr-3 pl-1 text-xs ${active ? 'text-emerald-100 hover:text-white' : 'text-gray-300 hover:text-red-500'} cursor-pointer">&times;</button>
      </span>`;
    }).join('');
  }

  function fillSegmentSelects() {
    const opts = '<option value="">No segment</option>' + state.segments
      .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    const add = $('aud-add-segment');
    const imp = $('aud-import-segment');
    if (add) add.innerHTML = opts;
    if (imp) imp.innerHTML = '<option value="">Add to no segment</option>' + state.segments
      .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  }

  function renderRows() {
    const tbody = $('aud-rows');
    if (!tbody) return;

    if (!state.contacts.length) {
      if (state.needsSetup) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-10 text-center">
          <p class="text-sm font-bold text-gray-900">Audience is not set up on this environment yet</p>
          <p class="text-sm text-gray-500 mt-1">The database migration has not been applied here. Nothing is lost — apply <span class="font-mono text-xs bg-gray-100 px-1 rounded">db/audience.sql</span> and reload.</p>
        </td></tr>`;
        const pagerEl = $('aud-pager');
        if (pagerEl) pagerEl.innerHTML = '';
        return;
      }
      const filtered = state.filters.q || state.filters.status || state.filters.segmentId;
      tbody.innerHTML = `<tr><td colspan="6" class="p-10 text-center">
        <p class="text-sm font-bold text-gray-900">${filtered ? 'No contacts match those filters' : 'No contacts yet'}</p>
        <p class="text-sm text-gray-500 mt-1">${filtered
          ? 'Try clearing the search or choosing a different status.'
          : 'Add someone by hand, import a CSV, or put your sign-up form on your website.'}</p>
      </td></tr>`;
      const pager = $('aud-pager');
      if (pager) pager.innerHTML = '';
      return;
    }

    const info = window.ListPager.page(state.contacts, state.page, PAGE_SIZE);
    state.page = info.page;

    tbody.innerHTML = info.items.map((c) => {
      const st = STATUS[c.status] || { label: c.status, cls: 'bg-gray-100 text-gray-600 border-gray-200' };
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
      return `<tr class="hover:bg-gray-50">
        <td class="px-4 py-3"><input type="checkbox" data-select="${c.id}" data-email="${esc(c.email)}" ${state.selected.has(c.id) ? 'checked' : ''}
          class="rounded border-gray-300 text-emerald-600 focus:ring-emerald-600 cursor-pointer"></td>
        <td class="px-4 py-3">
          <p class="font-bold text-gray-900">${esc(name || c.email)}</p>
          ${name ? `<p class="text-xs text-gray-500">${esc(c.email)}</p>` : ''}
          ${c.company ? `<p class="text-xs text-gray-400">${esc(c.company)}</p>` : ''}
        </td>
        <td class="px-4 py-3"><span class="inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full border ${st.cls}">${esc(st.label)}</span></td>
        <td class="px-4 py-3 text-gray-600">${esc(SOURCE_LABEL[c.source] || c.source || '—')}</td>
        <td class="px-4 py-3 text-gray-500">${esc(fmtDate(c.createdAt))}</td>
        <td class="px-4 py-3 text-right">
          <button type="button" data-open="${c.id}" class="text-xs font-bold text-emerald-700 hover:text-emerald-800 cursor-pointer">View</button>
        </td>
      </tr>`;
    }).join('');

    const pager = $('aud-pager');
    if (pager) pager.innerHTML = window.ListPager.controlsHtml(info, { attr: 'data-aud-page', noun: 'contacts' });
  }

  function renderBulk() {
    const bar = $('aud-bulk');
    const count = $('aud-bulk-count');
    if (!bar) return;
    if (count) count.textContent = String(state.selected.size);
    if (state.selected.size) show(bar, 'flex'); else hide(bar);
  }

  // ── Contact detail ─────────────────────────────────────────────────────────

  async function openDetail(id) {
    const panel = $('aud-detail');
    const body = $('aud-detail-body');
    const title = $('aud-detail-title');
    if (!panel || !body) return;
    show(panel, 'block');
    body.innerHTML = '<p class="text-sm text-gray-500">Loading…</p>';

    try {
      const { contact, segments, timeline } = await api(`${CONTACTS_API}?id=${encodeURIComponent(id)}`);
      // Held for the custom-field save, which is bound on the panel rather than on each input.
      state.detailId = contact.id;
      const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email;
      if (title) title.textContent = name;
      const st = STATUS[contact.status] || { label: contact.status, cls: 'bg-gray-100 text-gray-600 border-gray-200' };

      // A pause is not a status — the contact is still subscribed — so it sits beside the badge
      // rather than replacing it. Without this a tenant sees "Subscribed" next to somebody the
      // send worker is correctly skipping, and reports it as a bug.
      const paused = contact.pausedUntil && new Date(contact.pausedUntil) > new Date()
        ? `<span class="inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full border bg-amber-100 text-amber-800 border-amber-200 ml-1">Paused until ${esc(fmtDate(contact.pausedUntil))}</span>`
        : '';
      const capped = contact.emailFrequency === 'monthly'
        ? '<span class="inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full border bg-sky-100 text-sky-800 border-sky-200 ml-1">Monthly at most</span>'
        : '';

      body.innerHTML = `
        <div>
          <span class="inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full border ${st.cls}">${esc(st.label)}</span>${paused}${capped}
          <p class="text-sm text-gray-900 font-bold mt-3">${esc(contact.email)}</p>
          ${contact.company ? `<p class="text-sm text-gray-500">${esc(contact.company)}</p>` : ''}
          ${contact.phone ? `<p class="text-sm text-gray-500">${esc(contact.phone)}</p>` : ''}
        </div>

        <div class="grid grid-cols-2 gap-3 text-sm">
          <div><p class="text-xs font-bold text-gray-500 uppercase">Source</p><p class="text-gray-800">${esc(SOURCE_LABEL[contact.source] || contact.source || '—')}</p></div>
          <div><p class="text-xs font-bold text-gray-500 uppercase">Added</p><p class="text-gray-800">${esc(fmtDate(contact.createdAt))}</p></div>
          <div><p class="text-xs font-bold text-gray-500 uppercase">Confirmed</p><p class="text-gray-800">${esc(fmtDate(contact.confirmedAt))}</p></div>
          <div><p class="text-xs font-bold text-gray-500 uppercase">Last emailed</p><p class="text-gray-800">${esc(fmtDate(contact.lastSentAt))}</p></div>
        </div>

        ${state.customFields.length ? `
        <div>
          <p class="text-xs font-bold text-gray-500 uppercase mb-2">Your fields</p>
          <div class="space-y-2">
            ${state.customFields.map((f) => `
              <div class="flex items-center gap-2">
                <label class="text-xs text-gray-500 w-28 shrink-0 truncate" title="${esc(f.label)}">${esc(f.label)}</label>
                <input type="text" data-custom-key="${esc(f.key)}" value="${esc((contact.customFields || {})[f.key] || '')}"
                  class="flex-1 px-2 py-1.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm">
              </div>`).join('')}
          </div>
          <button type="button" id="aud-save-custom"
            class="mt-2 text-xs font-bold text-emerald-700 hover:text-emerald-800 cursor-pointer">Save fields</button>
        </div>` : ''}

        <div>
          <p class="text-xs font-bold text-gray-500 uppercase mb-2">Segments</p>
          <div class="flex flex-wrap gap-1.5">
            ${(segments || []).length
              ? segments.map((s) => `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-gray-100 text-gray-700">${esc(s.name)}</span>`).join('')
              : '<p class="text-sm text-gray-400">Not in any segment.</p>'}
          </div>
        </div>

        <div>
          <!-- The consent timeline is the answer to "why is this person on my list?", and it is the
               only place that answer exists — the contact row gets overwritten, these events do not. -->
          <p class="text-xs font-bold text-gray-500 uppercase mb-2">Consent history</p>
          <ol class="space-y-3">
            ${(timeline || []).map((t) => `
              <li class="text-sm">
                <p class="font-bold text-gray-800">${esc(EVENT_LABEL[t.event] || t.event)}</p>
                <p class="text-xs text-gray-500">${esc(fmtDateTime(t.createdAt))}${t.channel ? ` · ${esc(t.channel)}` : ''}</p>
                ${t.sourceUrl ? `<p class="text-xs text-gray-400 truncate">${esc(t.sourceUrl)}</p>` : ''}
                ${t.evidence ? `<p class="text-xs text-gray-500 mt-0.5">${esc(t.evidence)}</p>` : ''}
              </li>`).join('') || '<li class="text-sm text-gray-400">No recorded events.</li>'}
          </ol>
        </div>

        <div class="pt-4 border-t border-gray-100 flex flex-wrap gap-2">
          ${contact.status === 'subscribed'
            ? `<button type="button" data-aud-unsub="${esc(contact.email)}" class="px-3 py-2 text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 cursor-pointer">Unsubscribe</button>`
            : contact.status === 'pending' || contact.status === 'unsubscribed'
              ? `<button type="button" data-aud-resub="${esc(contact.email)}" class="px-3 py-2 text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 cursor-pointer">Mark as subscribed</button>`
              : ''}
          <div class="flex-1"></div>
          <button type="button" data-aud-delete="${contact.id}" class="px-3 py-2 text-xs font-bold text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer">Remove</button>
        </div>`;
    } catch (err) {
      body.innerHTML = `<p class="text-sm text-red-600">${esc(err.message)}</p>`;
    }
  }

  async function setStatus(emails, status) {
    await api(CONTACTS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', emails, status }),
    });
    window.showToast(status === 'unsubscribed'
      ? `Unsubscribed ${emails.length} ${emails.length === 1 ? 'contact' : 'contacts'}.`
      : 'Marked as subscribed.');
    hide($('aud-detail'));
    await loadContacts();
    await loadSegments();
  }

  async function deleteContact(id) {
    const data = await api(`${CONTACTS_API}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    // Saying so matters: the tenant asked to remove a row and we also kept a block. Silence here
    // reads as "they're gone", and the next capture-form submission would surprise them.
    window.showToast(data.optOutRetained
      ? 'Contact removed. Their unsubscribe is still on record, so they cannot be re-added by a form.'
      : 'Contact removed.');
    hide($('aud-detail'));
    await loadContacts();
    await loadSegments();
  }

  // ── CSV parsing (client side) ──────────────────────────────────────────────
  // A real parser, not a split(','): exported lists routinely carry quoted commas ("Acme, Inc"),
  // embedded newlines and a BOM, and a naive split shifts every column after the first quote —
  // silently importing company names as email addresses.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const src = text.replace(/^﻿/, '');

    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') { quoted = true; continue; }
      if (ch === ',') { row.push(field); field = ''; continue; }
      if (ch === '\r') continue;
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  const HEADER_ALIASES = {
    email: ['email', 'email address', 'e-mail', 'mail'],
    firstName: ['first name', 'firstname', 'first', 'given name', 'name'],
    lastName: ['last name', 'lastname', 'last', 'surname', 'family name'],
    company: ['company', 'organisation', 'organization', 'business', 'account'],
    // ⚠️ The column that stops us emailing somebody who already left. A Mailchimp or Kit export
    // lists the people who unsubscribed alongside everyone else; without reading this, importing
    // that file re-subscribes them and we mail people who opted out, from the tenant's own domain.
    //
    // This side only decides WHICH COLUMN to read. What the values MEAN is decided on the server
    // (src/config/audience-import-status.ts) — "cleaned" is Mailchimp for a hard bounce, and a
    // second copy of that table in the browser is the one that would drift. Picking the wrong
    // column here is safe: the server refuses values it does not recognise rather than guessing.
    status: ['status', 'state', 'subscription status', 'subscriber status', 'member status',
      'unsubscribed', 'opted out', 'opt out', 'do not email', 'email marketing consent'],
  };

  function mapHeaders(header) {
    const norm = header.map((h) => String(h || '').trim().toLowerCase());
    const idx = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      idx[field] = norm.findIndex((h) => aliases.includes(h));
    }
    return idx;
  }

  let importRows = [];

  function readImportFile(file) {
    const preview = $('aud-import-preview');
    const start = $('aud-import-start');
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseCsv(String(reader.result || ''));
      if (rows.length < 2) {
        importRows = [];
        if (preview) { preview.innerHTML = '<p class="text-red-600">That file has no data rows.</p>'; show(preview, 'block'); }
        if (start) start.disabled = true;
        return;
      }
      const idx = mapHeaders(rows[0]);
      if (idx.email < 0) {
        importRows = [];
        if (preview) { preview.innerHTML = '<p class="text-red-600">No <strong>email</strong> column found in the header row.</p>'; show(preview, 'block'); }
        if (start) start.disabled = true;
        return;
      }
      // A column whose header matches one of the tenant's own fields, by label or by key. Matched
      // here only to decide WHICH column; the server keeps a value only for a key it has defined,
      // so a wrong guess writes nothing rather than something invisible.
      const norm = rows[0].map((h) => String(h || '').trim().toLowerCase());
      const customIdx = {};
      for (const f of state.customFields) {
        const at = norm.findIndex((h) => h === f.label.toLowerCase() || h === f.key);
        if (at >= 0) customIdx[f.key] = at;
      }

      importRows = rows.slice(1).map((r) => ({
        email: (r[idx.email] || '').trim(),
        firstName: idx.firstName >= 0 ? (r[idx.firstName] || '').trim() : '',
        lastName: idx.lastName >= 0 ? (r[idx.lastName] || '').trim() : '',
        company: idx.company >= 0 ? (r[idx.company] || '').trim() : '',
        // Raw, verbatim. The server maps it — see HEADER_ALIASES.status.
        status: idx.status >= 0 ? (r[idx.status] || '').trim() : '',
        custom: Object.fromEntries(Object.entries(customIdx)
          .map(([key, at]) => [key, (r[at] || '').trim()])
          .filter(([, v]) => v)),
      })).filter((r) => r.email);

      if (preview) {
        // Deliberately does NOT say "valid addresses". The server is the only validator — a second
        // copy of that rule in the browser is the drift trap that lets a form go green on something
        // the server then refuses. Anything undeliverable comes back in the import's own report.
        const hasStatus = idx.status >= 0;
        const matchedCustom = Object.keys(customIdx);
        preview.innerHTML = `<p><strong>${importRows.length.toLocaleString()}</strong> rows to import.
          Columns matched: ${Object.entries(idx).filter(([, v]) => v >= 0).map(([k]) => `<span class="font-mono text-xs bg-gray-100 px-1 rounded">${k}</span>`).join(' ')}
          ${matchedCustom.map((k) => `<span class="font-mono text-xs bg-emerald-100 text-emerald-800 px-1 rounded">${esc(k)}</span>`).join(' ')}</p>`
          // Named, because a column that was NOT matched is silently dropped and the tenant would
          // otherwise find out weeks later when a personalised send prints nothing.
          + (state.customFields.length && !matchedCustom.length
            ? '<p class="mt-1 text-gray-600">None of your custom fields matched a column in this file. A column is matched by its exact name — rename the column to match the field, or the values will not be imported.</p>'
            : '')
          // Said BEFORE they press the button, not after. Somebody migrating a list needs to know
          // their unsubscribes are being carried over — and, if there is no such column, that they
          // are NOT, because that is the case where importing quietly re-subscribes people.
          + (hasStatus
            ? '<p class="mt-1 text-emerald-800">Anyone marked as unsubscribed, bounced or spam in this file will be brought over that way and will not be emailed.</p>'
            : '<p class="mt-1 text-amber-800">No status column found, so every row will be imported as subscribed. If this file came from another email tool, re-export it with the subscription status included — otherwise people who unsubscribed there will be emailed again from here.</p>');
        show(preview, 'block');
      }
      updateImportButton();
    };
    reader.readAsText(file);
  }

  function updateImportButton() {
    const start = $('aud-import-start');
    const consent = $('aud-import-consent');
    if (start) start.disabled = !(importRows.length && consent && consent.checked);
  }

  async function runImport() {
    const start = $('aud-import-start');
    const progress = $('aud-import-progress');
    const segmentId = Number($('aud-import-segment')?.value || '') || undefined;
    const file = $('aud-import-file')?.files?.[0];
    if (start) start.disabled = true;

    let jobId;
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let optedOut = 0;
    const unreadable = new Set();

    try {
      for (let i = 0; i < importRows.length; i += IMPORT_CHUNK) {
        const chunk = importRows.slice(i, i + IMPORT_CHUNK);
        const isLast = i + IMPORT_CHUNK >= importRows.length;
        if (progress) {
          progress.textContent = `Importing ${Math.min(i + chunk.length, importRows.length).toLocaleString()} of ${importRows.length.toLocaleString()}…`;
          show(progress, 'block');
        }
        const res = await api(CONTACTS_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'import',
            rows: chunk,
            declaredConsent: true,
            importJobId: jobId,
            segmentId,
            filename: file ? file.name : undefined,
            final: isLast,
          }),
        });
        jobId = res.importJobId;
        imported += res.imported || 0;
        skipped += res.skipped || 0;
        failed += res.failed || 0;
        optedOut += res.unsubscribedFromFile || 0;
        (res.unreadableStatuses || []).forEach((v) => unreadable.add(v));
      }

      // Report all three numbers, always. "Imported 4,000" while 600 were skipped is the kind of
      // half-truth that turns into "why did only 4,000 people get it?" a week later.
      const parts = [`${imported.toLocaleString()} imported`];
      // Carried-over opt-outs get their own number rather than being folded into "skipped" — a
      // tenant migrating a list needs to SEE that their unsubscribes came across, or they will
      // reasonably assume they did not.
      if (optedOut) parts.push(`${optedOut.toLocaleString()} kept as unsubscribed`);
      if (skipped) parts.push(`${skipped.toLocaleString()} already unsubscribed here`);
      if (failed) parts.push(`${failed.toLocaleString()} rejected`);
      window.showToast(parts.join(' · '), { duration: 8000 });
      if (unreadable.size) {
        await window.alertModal(
          `Some rows had a subscription status we could not read, so they were not imported: ${[...unreadable].map(esc).join(', ')}. `
          + 'Fix those values in the file and import it again — we do not guess whether somebody has agreed to be emailed.',
          { title: 'Some rows were not imported' },
        );
      }
      hide($('aud-import-modal'));
      await loadContacts();
      await loadSegments();
    } catch (err) {
      if (progress) { progress.innerHTML = `<span class="text-red-600">${esc(err.message)}</span>`; show(progress, 'block'); }
    } finally {
      if (start) start.disabled = false;
    }
  }

  // ── Sign-up form settings ──────────────────────────────────────────────────

  const FORMS_API = '/.netlify/functions/audience-forms';
  let currentForm = null;

  // Built from the browser's own origin rather than a stored base url: the page is served from
  // wherever this app is, and a hardcoded domain is the thing that breaks on a preview deploy.
  function hostedUrlFor(form) {
    return `${location.origin}/s/${form.publicKey}`;
  }

  function snippetFor(form) {
    const origin = location.origin;
    return `<div id="bms-subscribe"></div>\n<script async src="${origin}/subscribe.js"\n        data-bms-form="${form.publicKey}" data-bms-mount="#bms-subscribe"><\/script>`;
  }

  async function openFormModal() {
    const modal = $('aud-form-modal');
    const body = $('aud-form-body');
    if (!modal || !body) return;
    show(modal, 'flex');
    body.innerHTML = '<p class="text-sm text-gray-500">Loading…</p>';

    try {
      const data = await api(FORMS_API);
      if (data.needsSetup) {
        // Not "create your first form" — that button would post into tables that do not exist and
        // fail with something far less helpful.
        body.innerHTML = `<p class="text-sm text-gray-600">Audience is not set up on this environment yet. Apply <span class="font-mono text-xs bg-gray-100 px-1 rounded">db/audience.sql</span>, then reload this page.</p>`;
        return;
      }
      const forms = data.forms || [];
      currentForm = forms.find((f) => f.status === 'active') || forms[0] || null;
    } catch (err) {
      body.innerHTML = `<p class="text-sm text-red-600">${esc(err.message)}</p>`;
      return;
    }

    if (!currentForm) {
      body.innerHTML = `
        <div class="text-center py-8">
          <p class="text-sm text-gray-600 mb-4">You do not have a sign-up form yet.</p>
          <button type="button" id="aud-form-create"
            class="px-4 py-2 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Create a sign-up form</button>
        </div>`;
      $('aud-form-create')?.addEventListener('click', async () => {
        try {
          const { form } = await api(FORMS_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'create' }),
          });
          currentForm = form;
          renderFormSettings();
        } catch (err) { window.showToast(err.message); }
      });
      return;
    }
    renderFormSettings();
  }

  function renderFormSettings() {
    const body = $('aud-form-body');
    const f = currentForm;
    if (!body || !f) return;
    // null = any origin; [] = nothing allowed. The checkbox below IS that distinction, made
    // visible — see originAllowed() in src/utils/audience-forms.ts.
    const locked = Array.isArray(f.allowedOrigins);
    const origins = locked ? f.allowedOrigins.join('\n') : '';

    body.innerHTML = `
      <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Your snippet</label>
      <textarea id="aud-form-snippet" readonly rows="3"
        class="w-full px-3 py-2.5 rounded-lg border border-gray-300 text-xs font-mono text-gray-800 bg-gray-50">${esc(snippetFor(f))}</textarea>
      <div class="flex items-center gap-2 mt-2 mb-6">
        <button type="button" id="aud-form-copy" class="px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Copy snippet</button>
        <button type="button" id="aud-form-rotate" class="px-3 py-1.5 text-xs font-bold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 cursor-pointer">Rotate key</button>
        <span class="text-[11px] text-gray-400">Rotating stops the snippet already on your site until you paste the new one.</span>
      </div>

      <!-- The page WE host, for a business with no website to paste the snippet into. Off until
           they switch it on: a public url on our domain carrying their name is a deliberate act. -->
      <div class="mb-6 px-4 py-3 rounded-xl border ${f.hostedEnabled ? 'bg-emerald-50 border-emerald-200' : 'bg-gray-50 border-gray-200'}">
        <label class="flex items-start gap-2 cursor-pointer">
          <input type="checkbox" id="aud-form-hosted" ${f.hostedEnabled ? 'checked' : ''} class="mt-0.5">
          <span>
            <span class="text-sm font-bold text-gray-900">Give me a sign-up page</span>
            <span class="block text-[11px] text-gray-500">No website needed — share the link in a bio, on a poster, or behind a QR code.</span>
          </span>
        </label>
        ${f.hostedEnabled ? `
          <div class="flex items-center gap-2 mt-3">
            <input type="text" id="aud-form-hosted-url" readonly value="${esc(hostedUrlFor(f))}"
              class="flex-1 px-3 py-2 rounded-lg border border-emerald-300 text-xs font-mono text-gray-800 bg-white">
            <button type="button" id="aud-form-hosted-copy"
              class="px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Copy link</button>
            <a href="${esc(hostedUrlFor(f))}" target="_blank" rel="noopener"
              class="px-3 py-1.5 text-xs font-bold text-emerald-700 hover:text-emerald-800">Open</a>
          </div>
          <div class="grid grid-cols-1 gap-2 mt-3">
            <input type="text" id="aud-form-hosted-headline" maxlength="120" value="${esc(f.hostedHeadline || '')}"
              placeholder="Headline (defaults to the form's name)"
              class="w-full px-3 py-2 rounded-lg border border-emerald-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm">
            <textarea id="aud-form-hosted-intro" rows="2" maxlength="600" placeholder="A line or two about what people are signing up to"
              class="w-full px-3 py-2 rounded-lg border border-emerald-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm">${esc(f.hostedIntro || '')}</textarea>
          </div>
          <p class="text-[11px] text-emerald-700 mt-2">The page uses the same consent wording and double opt-in setting as the snippet — it is the same form, reached another way.</p>`
        : ''}
      </div>

      <div class="space-y-4">
        <div>
          <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Form name</label>
          <input type="text" id="aud-form-name" value="${esc(f.name || '')}"
            class="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm">
        </div>

        <div>
          <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Add sign-ups to</label>
          <select id="aud-form-segment"
            class="w-full px-3 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-700 focus:ring-2 focus:ring-emerald-600 outline-none cursor-pointer">
            <option value="">No segment</option>
            ${state.segments.map((sg) => `<option value="${sg.id}" ${String(sg.id) === String(f.segmentId) ? 'selected' : ''}>${esc(sg.name)}</option>`).join('')}
          </select>
        </div>

        <div>
          <label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Wording beside the button</label>
          <textarea id="aud-form-consent" rows="2"
            class="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm">${esc(f.consentText || '')}</textarea>
          <!-- Stored per form, not read from a template at send time: "what did the form say when
               they agreed" is a question that gets asked later, and it has to have one answer. -->
          <p class="text-[11px] text-gray-400 mt-1">Kept with every sign-up as the record of what they agreed to.</p>
        </div>

        <label class="flex items-start gap-2 text-sm text-gray-700 cursor-pointer select-none">
          <input type="checkbox" id="aud-form-doi" ${f.doubleOptIn !== false ? 'checked' : ''}
            class="mt-0.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-600">
          <span><strong>Ask people to confirm by email</strong> (double opt-in). Strongly recommended — nothing is sent to an address until the person clicks the link, and it is the proof that they asked.</span>
        </label>

        <div>
          <label class="flex items-start gap-2 text-sm text-gray-700 cursor-pointer select-none">
            <input type="checkbox" id="aud-form-locked" ${locked ? 'checked' : ''}
              class="mt-0.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-600">
            <span><strong>Only accept sign-ups from these websites</strong></span>
          </label>
          <textarea id="aud-form-origins" rows="3" placeholder="https://example.com" ${locked ? '' : 'disabled'}
            class="w-full mt-2 px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm disabled:opacity-50">${esc(origins)}</textarea>
          <p id="aud-form-origins-warn" class="hidden text-[11px] text-amber-700 mt-1" style="display:none">With this ticked and no websites listed, nobody can sign up at all.</p>
        </div>
      </div>

      <div class="flex justify-end gap-2 mt-6">
        <button type="button" data-aud-form-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 cursor-pointer">Close</button>
        <button type="button" id="aud-form-save" class="px-4 py-2 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Save changes</button>
      </div>`;

    body.querySelectorAll('[data-aud-form-close]').forEach((el) => el.addEventListener('click', () => hide($('aud-form-modal'))));

    $('aud-form-copy')?.addEventListener('click', async () => {
      const text = $('aud-form-snippet')?.value || '';
      try {
        await navigator.clipboard.writeText(text);
        window.showToast('Snippet copied — paste it into your website.');
      } catch {
        // Clipboard access can be refused outright (permissions, an insecure context). Select the
        // text so the user can copy it by hand rather than being told it worked when it did not.
        const el = $('aud-form-snippet');
        if (el) { el.focus(); el.select(); }
        window.showToast('Press Ctrl/Cmd+C to copy the selected snippet.');
      }
    });

    const lockedBox = $('aud-form-locked');
    const originsBox = $('aud-form-origins');
    const warn = $('aud-form-origins-warn');
    const syncOrigins = () => {
      if (!lockedBox || !originsBox) return;
      originsBox.disabled = !lockedBox.checked;
      const empty = lockedBox.checked && !originsBox.value.trim();
      if (empty) show(warn, 'block'); else hide(warn);
    };
    lockedBox?.addEventListener('change', syncOrigins);
    originsBox?.addEventListener('input', syncOrigins);
    syncOrigins();

    $('aud-form-rotate')?.addEventListener('click', async () => {
      const ok = await window.confirmModal(
        'Rotate this form\u2019s key? The snippet already on your website will stop working until you paste the new one.',
        { title: 'Rotate the key?', confirmLabel: 'Rotate key' },
      );
      if (!ok) return;
      try {
        const res = await api(FORMS_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rotate', id: currentForm.id }),
        });
        currentForm.publicKey = res.publicKey;
        renderFormSettings();
        window.showToast('New key generated. Paste the new snippet into your website.');
      } catch (err) { window.showToast(err.message); }
    });

    $('aud-form-save')?.addEventListener('click', async () => {
      const lockedNow = !!$('aud-form-locked')?.checked;
      const list = ($('aud-form-origins')?.value || '').split('\n').map((v) => v.trim()).filter(Boolean);
      try {
        const { form } = await api(FORMS_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update',
            id: currentForm.id,
            name: $('aud-form-name')?.value,
            consentText: $('aud-form-consent')?.value,
            doubleOptIn: !!$('aud-form-doi')?.checked,
            segmentId: Number($('aud-form-segment')?.value || '') || null,
            allowedOrigins: lockedNow ? list : null,
            hostedEnabled: !!$('aud-form-hosted')?.checked,
            // Only sent when the panel is showing them — the inputs do not exist while the page is
            // off, and sending undefined would blank a headline the tenant wrote earlier.
            ...($('aud-form-hosted-headline') ? { hostedHeadline: $('aud-form-hosted-headline').value } : {}),
            ...($('aud-form-hosted-intro') ? { hostedIntro: $('aud-form-hosted-intro').value } : {}),
          }),
        });
        currentForm = form;
        window.showToast('Sign-up form saved.');
        renderFormSettings();
      } catch (err) { window.showToast(err.message); }
    });

    // Delegated: the hosted-link controls only exist while the page is switched on, and the panel
    // is re-rendered whenever that changes.
    body.addEventListener('click', async (e) => {
      if (!e.target.closest('#aud-form-hosted-copy')) return;
      const input = $('aud-form-hosted-url');
      if (!input) return;
      try {
        await navigator.clipboard.writeText(input.value);
        window.showToast('Link copied.');
      } catch {
        // Clipboard access is refused in some browsers and every insecure context. Selecting the
        // text is the fallback that always works.
        input.select();
        window.showToast('Press Ctrl/Cmd+C to copy the link.');
      }
    });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  function wire() {
    const search = $('aud-search');
    if (search) {
      search.addEventListener('input', () => {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => {
          state.filters.q = search.value.trim();
          state.page = 1;
          loadContacts();
        }, 300);
      });
    }

    const status = $('aud-status');
    if (status) {
      status.addEventListener('change', () => {
        state.filters.status = status.value;
        state.page = 1;
        loadContacts();
      });
    }

    // Both chip rows share one handler: they render the same markup and mean the same thing.
    [$('aud-segments'), $('aud-tags')].filter(Boolean).forEach((segHost) => {
      segHost.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-segment-delete]');
        if (del) {
          const id = Number(del.getAttribute('data-segment-delete'));
          const seg = state.segments.find((s) => s.id === id);
          const ok = await window.confirmModal(
            `Delete the segment “${seg ? seg.name : ''}”? The contacts in it stay in your audience — only the grouping goes.`,
            { title: 'Delete segment?', confirmLabel: 'Delete segment' },
          );
          if (!ok) return;
          await api(SEGMENTS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', id }),
          });
          if (String(state.filters.segmentId) === String(id)) state.filters.segmentId = '';
          await loadSegments();
          await loadContacts();
          return;
        }
        const edit = e.target.closest('[data-segment-rules]');
        if (edit) {
          const seg = state.segments.find((x) => x.id === Number(edit.getAttribute('data-segment-rules')));
          if (seg) openRuleModal(seg);
          return;
        }
        const pick = e.target.closest('[data-segment]');
        if (!pick) return;
        state.filters.segmentId = pick.getAttribute('data-segment') || '';
        state.page = 1;
        renderSegments();
        loadContacts();
      });
    });

    $('aud-new-field')?.addEventListener('click', async () => {
      const label = await window.promptModal('What is this field called?', {
        title: 'New custom field', placeholder: 'City', confirmLabel: 'Add field',
      });
      if (!label) return;
      try {
        const { field } = await api(FIELDS_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create', label }),
        });
        // ⚠️ The key is shown once, on creation, because it is the thing they will type inside
        // {{contact.custom.…}} and the one thing they cannot change afterwards.
        window.showToast(`Added. Use {{contact.custom.${field.key}}} in an email.`, { duration: 7000 });
        await loadCustomFields();
      } catch (err) { window.showToast(err.message); }
    });

    $('aud-new-rule-segment')?.addEventListener('click', () => openRuleModal(null));

    $('aud-new-tag')?.addEventListener('click', async () => {
      const name = await window.promptModal('Name this tag', {
        title: 'New tag', placeholder: 'Bought something', confirmLabel: 'Create tag',
      });
      if (!name) return;
      try {
        await api(SEGMENTS_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create', name, kind: 'tag' }),
        });
        await loadSegments();
      } catch (err) { window.showToast(err.message); }
    });

    $('aud-bulk-tag')?.addEventListener('click', async () => {
      const tags = state.segments.filter((s) => s.kind === 'tag');
      if (!tags.length) { window.showToast('Create a tag first.'); return; }
      const choice = await window.choiceModal('Tag the selected contacts as…',
        tags.map((t) => ({ label: t.name, value: String(t.id) })));
      if (!choice) return;
      try {
        await api(CONTACTS_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'segment', segmentId: Number(choice), contactIds: [...state.selected] }),
        });
        window.showToast('Tagged.');
        await loadSegments();
        await loadContacts();
      } catch (err) { window.showToast(err.message); }
    });
    document.querySelectorAll('[data-aud-rule-close]').forEach((el) => el.addEventListener('click', () => hide($('aud-rule-modal'))));

    const newSeg = $('aud-new-segment');
    if (newSeg) {
      newSeg.addEventListener('click', async () => {
        const name = await window.promptModal('Name this segment', { title: 'New segment', placeholder: 'Weekly newsletter', confirmLabel: 'Create' });
        if (!name) return;
        try {
          await api(SEGMENTS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'create', name }),
          });
          await loadSegments();
        } catch (err) { window.showToast(err.message); }
      });
    }

    const tbody = $('aud-rows');
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        const open = e.target.closest('[data-open]');
        if (open) { openDetail(Number(open.getAttribute('data-open'))); return; }
      });
      tbody.addEventListener('change', (e) => {
        const box = e.target.closest('[data-select]');
        if (!box) return;
        const id = Number(box.getAttribute('data-select'));
        if (box.checked) state.selected.add(id); else state.selected.delete(id);
        renderBulk();
      });
    }

    const selectAll = $('aud-select-all');
    if (selectAll) {
      selectAll.addEventListener('change', () => {
        // Selects the VISIBLE page only. A checkbox that silently selected 2,000 unseen rows and
        // then unsubscribed them is not a convenience.
        const boxes = document.querySelectorAll('#aud-rows [data-select]');
        boxes.forEach((b) => {
          const id = Number(b.getAttribute('data-select'));
          b.checked = selectAll.checked;
          if (selectAll.checked) state.selected.add(id); else state.selected.delete(id);
        });
        renderBulk();
      });
    }

    const pager = $('aud-pager');
    if (pager && window.ListPager) {
      window.ListPager.bind(pager, 'data-aud-page', (n) => { state.page = n; renderRows(); });
    }

    const bulkUnsub = $('aud-bulk-unsub');
    if (bulkUnsub) {
      bulkUnsub.addEventListener('click', async () => {
        const emails = selectedEmails();
        if (!emails.length) return;
        const ok = await window.confirmModal(
          `Unsubscribe ${emails.length} ${emails.length === 1 ? 'contact' : 'contacts'}? They will not receive anything from any of your assistants again.`,
          { title: 'Unsubscribe these contacts?', confirmLabel: 'Unsubscribe' },
        );
        if (!ok) return;
        await setStatus(emails, 'unsubscribed');
      });
    }

    const bulkSegment = $('aud-bulk-segment');
    if (bulkSegment) {
      bulkSegment.addEventListener('click', async () => {
        // Manual segments only: a dynamic one works its members out for itself, and a tag has its
        // own button. Offering either here would be a control that reports success and does nothing.
        const targets = state.segments.filter((s) => s.kind !== 'dynamic' && s.kind !== 'tag');
        if (!targets.length) { window.showToast('Create a segment first.'); return; }
        const choice = await window.choiceModal('Add the selected contacts to…',
          targets.map((s) => ({ label: s.name, value: String(s.id) })));
        if (!choice) return;
        await api(CONTACTS_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'segment', segmentId: Number(choice), contactIds: [...state.selected] }),
        });
        window.showToast('Added to the segment.');
        await loadSegments();
        await loadContacts();
      });
    }

    // Detail panel — delegated so the buttons rendered into it need no re-binding.
    const detail = $('aud-detail');
    if (detail) {
      detail.addEventListener('click', async (e) => {
        if (e.target.closest('[data-aud-close]')) { hide(detail); return; }
        if (e.target.closest('#aud-save-custom')) {
          const custom = {};
          // Blank IS a value here: it means "clear this field", which the server handles as a
          // removal. Sending only the filled ones would make clearing a field impossible.
          detail.querySelectorAll('[data-custom-key]').forEach((el) => {
            custom[el.getAttribute('data-custom-key')] = el.value.trim();
          });
          try {
            await api(CONTACTS_API, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'update', id: state.detailId, custom }),
            });
            window.showToast('Saved.');
          } catch (err) { window.showToast(err.message); }
          return;
        }
        const unsub = e.target.closest('[data-aud-unsub]');
        if (unsub) { await setStatus([unsub.getAttribute('data-aud-unsub')], 'unsubscribed'); return; }
        const resub = e.target.closest('[data-aud-resub]');
        if (resub) {
          const ok = await window.confirmModal(
            'Mark this person as subscribed? Only do this if they have asked to hear from you again — it is recorded against your account.',
            // Green, not the default red: this one is not destructive.
            { title: 'Mark as subscribed?', confirmLabel: 'Mark as subscribed', confirmColor: '#059669' },
          );
          if (ok) await setStatus([resub.getAttribute('data-aud-resub')], 'subscribed');
          return;
        }
        const del = e.target.closest('[data-aud-delete]');
        if (del) {
          const ok = await window.confirmModal(
            'Remove this contact from your audience? If they had unsubscribed, we keep that on record so they cannot be re-added by a sign-up form.',
            { title: 'Remove this contact?', confirmLabel: 'Remove' },
          );
          if (ok) await deleteContact(Number(del.getAttribute('data-aud-delete')));
        }
      });
    }

    $('aud-form-btn')?.addEventListener('click', openFormModal);
    document.querySelectorAll('[data-aud-form-close]').forEach((el) => el.addEventListener('click', () => hide($('aud-form-modal'))));

    // Add-contact modal
    $('aud-add-btn')?.addEventListener('click', () => {
      ['aud-add-email', 'aud-add-first', 'aud-add-last', 'aud-add-company'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
      show($('aud-add-modal'), 'flex');
    });
    document.querySelectorAll('[data-aud-add-close]').forEach((el) => el.addEventListener('click', () => hide($('aud-add-modal'))));
    $('aud-add-save')?.addEventListener('click', async () => {
      const email = ($('aud-add-email')?.value || '').trim();
      if (!email) { window.showToast('Enter an email address.'); return; }
      try {
        await api(CONTACTS_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            email,
            firstName: $('aud-add-first')?.value,
            lastName: $('aud-add-last')?.value,
            company: $('aud-add-company')?.value,
            segmentId: Number($('aud-add-segment')?.value || '') || undefined,
          }),
        });
        hide($('aud-add-modal'));
        window.showToast('Contact added.');
        await loadContacts();
        await loadSegments();
      } catch (err) { window.showToast(err.message); }
    });

    // Import modal
    $('aud-import-btn')?.addEventListener('click', () => {
      importRows = [];
      const file = $('aud-import-file'); if (file) file.value = '';
      const consent = $('aud-import-consent'); if (consent) consent.checked = false;
      hide($('aud-import-preview'));
      hide($('aud-import-progress'));
      updateImportButton();
      show($('aud-import-modal'), 'flex');
    });
    document.querySelectorAll('[data-aud-import-close]').forEach((el) => el.addEventListener('click', () => hide($('aud-import-modal'))));
    $('aud-import-file')?.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) readImportFile(f);
    });
    $('aud-import-consent')?.addEventListener('change', updateImportButton);
    $('aud-import-start')?.addEventListener('click', runImport);
  }

  function selectedEmails() {
    const byId = new Map(state.contacts.map((c) => [c.id, c.email]));
    return [...state.selected].map((id) => byId.get(id)).filter(Boolean);
  }

  window.initAudience = async function initAudience() {
    state.page = 1;
    state.selected.clear();
    state.filters = { q: '', status: '', segmentId: '' };
    wire();
    await loadCustomFields();
    await loadSegments();
    await loadContacts();
  };
})();
