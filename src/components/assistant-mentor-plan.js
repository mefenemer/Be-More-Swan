/**
 * src/components/assistant-mentor-plan.js
 * The Business Mentor's Plan tab — docs/business-mentor-plan.md §4 and §14. The screen twins of what the
 * Mentor does in chat, through the SAME server actions (netlify/functions/mentor.ts):
 *
 *   Your plans              — "Idea check", "Business plan" and "Marketing plan" (strategy-documents.ts)
 *     Idea check            — the eight interview questions one step at a time ("Back" / "Next" saves),
 *                             the "Lean Canvas" (nine editable boxes) and "Riskiest assumptions"
 *     Business / Marketing  — each section editable; "Save draft", "Approve" (owner or admin), "Changes"
 *                             since the approved version, "Earlier versions"; pre-filled from the
 *                             workspace when nothing is saved yet (§13.2), never saved until "Save draft"
 *     Draft it for me       — the Mentor drafts the whole document in the background (1 task); the result
 *                             waits under "Your Mentor's draft" with "Use this draft"
 *   Break-even calculator   — worked out in code (break-even.ts); every input shown, guesses labelled
 *   Look this up / Research — a sourced answer in about two minutes (1 task), and every past answer
 *   The playbook I'm using  — the reviewed playbook for this kind of business, or that there isn't one
 *
 * A chat card saved or approved dispatches `mentor:planChanged`, which reloads this tab; a break-even card's
 * "Open in the calculator" dispatches `mentor:openCalculator`. Handlers are bound to `document` once, at
 * load, never from render. Server values are escaped.
 */
(function () {
  const API = '/.netlify/functions/mentor';
  const KINDS = ['idea_check', 'business_plan', 'marketing_plan'];
  const POLL_MS = 8000;
  const fresh = () => ({
    assistantId: null, assistantName: 'Your Mentor', data: null, error: null, loading: false,
    kind: null, edits: {}, notes: {}, busy: {}, ideaStep: 0, showChanges: false, dismissedDrafts: {},
    calc: { inputs: {}, result: null, error: null, busy: false },
    research: { question: '', busy: false, error: null },
  });
  let state = fresh();
  let pollTimer = null;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const host = () => document.getElementById('mentor-plan-host');
  const ukDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
  const card = (inner, attrs = '') => `<section class="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 sm:p-5 min-w-0" ${attrs}>${inner}</section>`;
  const note = (key) => state.notes[key] ? `<p class="text-xs font-semibold mt-2 ${state.notes[key].error ? 'text-red-600' : 'text-pink-700'}" role="status" aria-live="polite">${esc(state.notes[key].text)}</p>` : '';

  async function call(body) {
    const res = await fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `That didn’t work (HTTP ${res.status}).`);
    return data;
  }

  async function load() {
    if (!host()) return;
    state.loading = true;
    try {
      const res = await fetch(`${API}?plan=1`, { credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn’t load (HTTP ${res.status}).`);
      state.data = body; state.error = null;
      if (!state.kind) state.kind = body.stage === 'new_idea' ? 'idea_check' : 'business_plan';
    } catch (err) {
      state.error = err.message || 'Couldn’t load your plans.';
    }
    state.loading = false;
    render();
    schedulePoll();
  }

  // While research or a draft is running, re-read every few seconds; stop when nothing is.
  function schedulePoll() {
    clearTimeout(pollTimer);
    const d = state.data;
    if (!d || !host()) return;
    const running = [...(d.research || []), ...(d.drafting || [])].some((j) => j.status === 'queued' || j.status === 'running');
    if (running) pollTimer = setTimeout(() => { if (host() && !host().closest('.hidden')) load(); else schedulePoll(); }, POLL_MS);
  }

  // ── Documents ─────────────────────────────────────────────────────────────
  function docOf(kind) { return (state.data && state.data.docs && state.data.docs[kind]) || {}; }
  function defOf(kind) { return (state.data && state.data.kinds && state.data.kinds[kind]) || { label: kind, sections: [] }; }
  /** What the page shows for a document: unsaved edits over the draft, else the approved text, else the pre-fill. */
  function working(kind) {
    const d = docOf(kind);
    const base = (d.draft && d.draft.body) || (d.approved && d.approved.body) || d.prefill || { sections: {}, assumptions: [] };
    const e = state.edits[kind] || {};
    return {
      sections: { ...(base.sections || {}), ...(e.sections || {}) },
      assumptions: e.assumptions || base.assumptions || [],
    };
  }
  const dirty = (kind) => { const e = state.edits[kind]; return !!e && (Object.keys(e.sections || {}).length > 0 || !!e.assumptions); };
  function setEdit(kind, key, value) {
    const e = state.edits[kind] || (state.edits[kind] = {});
    if (key === 'assumptions') e.assumptions = value;
    else (e.sections || (e.sections = {}))[key] = value;
  }

  function statusLine(kind) {
    const d = docOf(kind);
    const bits = [];
    if (d.approved) bits.push(`<span class="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-green-50 text-green-800 border border-green-200">Approved v${Number(d.approved.version)} · ${esc(ukDate(d.approved.approvedAt))}</span>`);
    if (d.draft) bits.push(`<span class="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-amber-50 text-amber-800 border border-amber-200">Draft v${Number(d.draft.version)} · not approved</span>`);
    if (!d.draft && !d.approved) bits.push(d.prefill
      ? '<span class="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-blue-50 text-blue-800 border border-blue-200">Pre-filled from your workspace · not saved yet</span>'
      : '<span class="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-gray-100 text-gray-600">Not started</span>');
    if (dirty(kind)) bits.push('<span class="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-pink-50 text-pink-800 border border-pink-200">Unsaved changes</span>');
    return `<div class="flex flex-wrap gap-1.5 mt-2">${bits.join('')}</div>`;
  }

  function diffHtml(diff) {
    if (!diff || !diff.length) return '<p class="text-sm text-gray-500 mt-2">No changes since the approved version.</p>';
    return `<ul class="mt-2 space-y-3">${diff.map((s) => `
      <li><p class="text-xs font-bold text-gray-700">${esc(s.label)} <span class="font-normal text-gray-500">(${esc(s.change)})</span></p>
        <p class="text-sm text-gray-800 mt-1 whitespace-pre-line break-words">${(s.parts || []).map((p) => p.op === 'same' ? esc(p.text)
          : p.op === 'add' ? `<ins class="bg-green-100 text-green-900 no-underline">${esc(p.text)}</ins>`
            : `<del class="bg-red-100 text-red-900">${esc(p.text)}</del>`).join('')}</p></li>`).join('')}</ul>`;
  }

  function actionsHtml(kind) {
    const d = docOf(kind);
    const canApprove = state.data.canApprove && d.draft && (d.diff || []).length && !dirty(kind) && !openQuestions(kind);
    const busy = state.busy[kind];
    return `
      <div class="flex flex-wrap items-center gap-2 mt-4">
        <button type="button" data-mplan-save="${kind}" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy || !dirty(kind) && (d.draft || !d.prefill) ? 'disabled' : ''}>Save draft</button>
        ${state.data.canApprove
          ? `<button type="button" data-mplan-approve="${kind}" class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition disabled:opacity-50" ${busy || !canApprove ? 'disabled' : ''} title="${dirty(kind) ? 'Save your changes first' : ''}">Approve</button>`
          : '<span class="text-xs text-gray-500">Only the owner or an admin can approve.</span>'}
        <button type="button" data-mplan-draft="${kind}" class="btn-secondary px-3 py-2 border text-xs font-bold rounded-lg transition disabled:opacity-50" ${busy || draftJob(kind, true) ? 'disabled' : ''}>${kind === 'idea_check' ? 'Draft my canvas' : 'Draft it for me'} · 1 task</button>
        ${d.draft ? `<button type="button" data-mplan-changes aria-expanded="${state.showChanges ? 'true' : 'false'}" class="btn-swan-link px-1 py-2 text-xs font-bold">Changes (${(d.diff || []).length})</button>` : ''}
      </div>
      ${openQuestions(kind) ? '<p class="text-[11px] text-amber-800 mt-1">Answer or remove the parts in [square brackets] before approving.</p>' : ''}
      <p class="text-[11px] text-gray-500 mt-1">${kind === 'idea_check' ? 'Approving keeps this as your record of the idea; it doesn’t change what your other assistants write.' : 'Approving makes this the plan every assistant writes from.'} Earlier versions are kept.</p>
      ${note(kind)}
      ${state.showChanges && d.draft ? `<div class="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3" data-mplan-panel="changes"><p class="text-xs font-bold uppercase tracking-wide text-gray-500">Changes since ${d.approved ? `approved v${Number(d.approved.version)}` : 'nothing approved yet'}</p>${diffHtml(d.diff)}</div>` : ''}`;
  }

  // Approval refuses while a [question] is left (strategy-documents.ts sectionsWithOpenQuestions).
  const openQuestions = (kind) => { const w = working(kind); return [...Object.values(w.sections || {}), ...(w.assumptions || []).flatMap((a) => [a.assumption, a.test])].some((t) => /\[[^\]\n]{3,}\]/.test(t || '')); };

  /** The newest drafting job for a kind: running (busy=true) or done and not yet used/dismissed. */
  function draftJob(kind, runningOnly) {
    const j = (state.data.drafting || []).find((x) => x.strategyKind === kind);
    if (!j) return null;
    if (j.status === 'queued' || j.status === 'running') return j;
    if (runningOnly) return null;
    if (state.dismissedDrafts[j.id]) return null;
    // Only fresh results: a draft older than the saved draft has already been used or overtaken.
    const d = docOf(kind);
    const saved = d.draft && d.draft.updatedAt;
    if (j.status === 'done' && saved && j.finishedAt && new Date(saved) > new Date(j.finishedAt)) return null;
    return j;
  }

  function mentorDraftHtml(kind) {
    const j = draftJob(kind);
    if (!j) return '';
    if (j.status === 'queued' || j.status === 'running') {
      return `<div class="mt-3 rounded-lg border border-pink-200 bg-pink-50 p-3" data-mplan-panel="mentor-draft"><p class="text-sm text-pink-900"><span class="animate-pulse">●</span> ${esc(state.assistantName)} is drafting this — about a minute. You can leave this page; you’ll get a notification.</p></div>`;
    }
    if (j.status === 'failed') {
      return `<div class="mt-3 rounded-lg border border-red-200 bg-red-50 p-3" data-mplan-panel="mentor-draft"><p class="text-sm text-red-800">${esc(j.error || 'The draft couldn’t be finished. Nothing was charged.')}</p>
        <button type="button" data-mplan-dismiss-draft="${Number(j.id)}" class="btn-secondary mt-2 px-3 py-1.5 border text-xs font-bold rounded-lg">OK</button></div>`;
    }
    const r = j.result || {};
    const def = defOf(kind);
    const rows = def.sections.filter((s) => r.sections && r.sections[s.key]).map((s) => `
      <li class="py-1.5"><p class="text-xs font-bold text-gray-700">${esc(s.label)}</p><p class="text-sm text-gray-800 whitespace-pre-line break-words">${esc(r.sections[s.key])}</p></li>`).join('');
    const ass = (r.assumptions || []).map((a) => `<li class="text-sm text-gray-800 break-words">${esc(a.assumption)}${a.test ? ` <span class="text-gray-500">→ ${esc(a.test)}</span>` : ''}</li>`).join('');
    return `<div class="mt-3 rounded-lg border-2 border-pink-200 bg-white p-3" data-mplan-panel="mentor-draft">
      <p class="text-xs font-bold uppercase tracking-wide text-pink-700">${esc(state.assistantName)}’s draft · ${esc(ukDate(j.finishedAt || j.createdAt))}</p>
      <p class="text-xs text-gray-600 mt-1">Read it and correct anything that’s wrong. Nothing is saved until you choose “Use this draft”; then it’s your draft to edit and approve.</p>
      <ul class="mt-2 divide-y divide-gray-100">${rows}</ul>
      ${ass ? `<p class="text-xs font-bold text-gray-700 mt-2">Riskiest assumptions</p><ul class="mt-1 space-y-1 list-disc pl-5">${ass}</ul>` : ''}
      <div class="flex flex-wrap gap-2 mt-3">
        <button type="button" data-mplan-use-draft="${Number(j.id)}" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">Use this draft</button>
        <button type="button" data-mplan-dismiss-draft="${Number(j.id)}" class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition">Not this one</button>
      </div></div>`;
  }

  function sectionField(kind, s, value, opts = {}) {
    const id = `mplan-${kind}-${s.key}`;
    return `<div class="${opts.compact ? '' : 'py-3 border-b border-gray-100 last:border-0'} min-w-0">
      <div class="flex items-baseline justify-between gap-2 flex-wrap">
        <label for="${id}" class="text-sm font-bold text-gray-900">${esc(s.label)}</label>
        ${opts.noLookup ? '' : `<button type="button" data-mplan-lookup="${esc(kind)}:${esc(s.key)}" class="btn-swan-link px-0 py-0.5 text-[11px] font-bold">Look this up</button>`}
      </div>
      <p class="text-[11px] text-gray-500">${esc(s.hint)}</p>
      <textarea id="${id}" data-mplan-field="${esc(kind)}:${esc(s.key)}" rows="${opts.rows || 3}" maxlength="${Number(s.max)}" class="mt-1 w-full rounded-lg border border-gray-300 p-2 text-sm">${esc(value || '')}</textarea>
    </div>`;
  }

  function earlierHtml(kind) {
    const list = docOf(kind).earlier || [];
    if (!list.length) return '';
    const def = defOf(kind);
    return `<details class="mt-3" data-mplan-panel="earlier"><summary class="cursor-pointer text-xs font-bold text-gray-700">Earlier versions (${list.length})</summary>
      <ul class="mt-2 space-y-2">${list.map((v) => `<li class="rounded-lg border border-gray-200 p-2">
        <details><summary class="cursor-pointer text-xs text-gray-700">v${Number(v.version)}${v.approvedAt ? ` · approved ${esc(ukDate(v.approvedAt))}` : ''}</summary>
          <dl class="mt-1 space-y-1">${def.sections.filter((s) => v.body.sections[s.key]).map((s) => `<div><dt class="text-[11px] font-bold text-gray-600">${esc(s.label)}</dt><dd class="text-xs text-gray-800 whitespace-pre-line break-words">${esc(v.body.sections[s.key])}</dd></div>`).join('')}</dl>
        </details></li>`).join('')}</ul></details>`;
  }

  function planDocHtml(kind) {
    const def = defOf(kind);
    const w = working(kind);
    const d = docOf(kind);
    return `${!d.draft && !d.approved && d.prefill ? `<p class="mt-3 text-xs rounded-lg border border-blue-200 bg-blue-50 text-blue-900 px-2.5 py-1.5">Pre-filled from your Business Information and assistants — nothing invented. Check it, fill the gaps, then “Save draft”.</p>` : ''}
      ${mentorDraftHtml(kind)}
      <div class="mt-2">${def.sections.map((s) => sectionField(kind, s, w.sections[s.key])).join('')}</div>
      ${actionsHtml(kind)}${earlierHtml(kind)}`;
  }

  function ideaCheckHtml() {
    const kind = 'idea_check';
    const def = defOf(kind);
    const w = working(kind);
    const interview = def.sections.filter((s) => s.group === 'interview');
    const canvas = def.sections.filter((s) => s.group === 'canvas');
    const step = Math.min(Math.max(0, state.ideaStep), interview.length - 1);
    const q = interview[step];
    const answered = interview.filter((s) => (w.sections[s.key] || '').trim()).length;
    const assumptions = w.assumptions || [];
    return `
      ${mentorDraftHtml(kind)}
      <div class="mt-3 rounded-xl border border-gray-200 p-3 sm:p-4" data-mplan-panel="interview">
        <div class="flex items-baseline justify-between gap-2 flex-wrap">
          <h3 class="text-sm font-bold text-gray-900">The questions</h3>
          <span class="text-xs font-semibold text-gray-500">Step ${step + 1} of ${interview.length} · ${answered} answered</span>
        </div>
        <p class="text-[11px] text-gray-500 mt-0.5">The same questions ${esc(state.assistantName)} asks in chat — answer here or there; both save to the same draft.</p>
        <div class="mt-2">${sectionField(kind, q, w.sections[q.key], { compact: true, rows: 4, noLookup: true })}</div>
        <div class="flex flex-wrap gap-2 mt-2">
          <button type="button" data-mplan-step="-1" class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg disabled:opacity-50" ${step === 0 ? 'disabled' : ''}>Back</button>
          <button type="button" data-mplan-step="1" class="btn-primary px-4 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50" ${state.busy[kind] ? 'disabled' : ''}>${step === interview.length - 1 ? 'Save' : 'Next'}</button>
        </div>
      </div>
      <div class="mt-4" data-mplan-panel="canvas">
        <h3 class="text-sm font-bold text-gray-900">Lean Canvas</h3>
        <p class="text-[11px] text-gray-500">The nine standard boxes. Fill them yourself, or “Draft my canvas” once the questions are answered.</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-2">${canvas.map((s) => `<div class="rounded-lg border border-gray-200 p-2 min-w-0">${sectionField(kind, s, w.sections[s.key], { compact: true, rows: 4, noLookup: true })}</div>`).join('')}</div>
      </div>
      <div class="mt-4" data-mplan-panel="assumptions">
        <h3 class="text-sm font-bold text-gray-900">Riskiest assumptions</h3>
        <p class="text-[11px] text-gray-500">What has to be true, riskiest first, each with a cheap test you could run this month. Not validated until a test has run.</p>
        <ul class="mt-2 space-y-2">${assumptions.map((a, i) => `
          <li class="rounded-lg border border-gray-200 p-2 grid grid-cols-1 sm:grid-cols-2 gap-2 min-w-0">
            <label class="text-[11px] font-semibold text-gray-600 min-w-0">Assumption<input type="text" maxlength="400" data-mplan-assumption="${i}:assumption" value="${esc(a.assumption)}" class="mt-0.5 w-full rounded-md border border-gray-300 p-1.5 text-sm"></label>
            <label class="text-[11px] font-semibold text-gray-600 min-w-0">Cheap test this month<input type="text" maxlength="400" data-mplan-assumption="${i}:test" value="${esc(a.test)}" class="mt-0.5 w-full rounded-md border border-gray-300 p-1.5 text-sm"></label>
            <button type="button" data-mplan-remove-assumption="${i}" class="btn-swan-link justify-self-start px-0 text-[11px] font-bold">Remove</button>
          </li>`).join('') || '<li class="text-sm text-gray-500">None yet.</li>'}</ul>
        ${assumptions.length < 6 ? '<button type="button" data-mplan-add-assumption class="btn-secondary mt-2 px-3 py-1.5 border text-xs font-bold rounded-lg">+ Add an assumption</button>' : ''}
      </div>
      ${actionsHtml(kind)}${earlierHtml(kind)}`;
  }

  function plansHtml() {
    const d = state.data;
    if (!d.ready) return card('<h2 class="text-base font-bold text-gray-900">Your plans</h2><p class="text-sm text-gray-600 mt-1">Your plans aren’t switched on for this workspace yet. Your Mentor can still talk them through with you in chat.</p>', 'data-mplan-panel="plans"');
    const tabs = KINDS.map((k) => `<button type="button" role="tab" aria-selected="${state.kind === k}" data-mplan-kind="${k}" class="px-3 py-1.5 text-xs font-bold rounded-full border transition ${state.kind === k ? 'bg-pink-600 text-white border-pink-600' : 'bg-white text-gray-700 border-gray-300 hover:border-pink-300'}">${esc(defOf(k).label)}</button>`).join('');
    return card(`
      <h2 class="text-base font-bold text-gray-900">Your plans</h2>
      <p class="text-xs text-gray-500 mt-1">Write them with ${esc(state.assistantName)}. Once you approve a plan, every assistant writes from it.</p>
      <div class="flex flex-wrap gap-2 mt-3" role="tablist" aria-label="Your plans">${tabs}</div>
      ${statusLine(state.kind)}
      ${state.kind === 'idea_check' ? ideaCheckHtml() : planDocHtml(state.kind)}`, 'data-mplan-panel="plans"');
  }

  // ── Break-even calculator ────────────────────────────────────────────────
  function calcHtml() {
    const defs = state.data.breakEvenInputs || {};
    const c = state.calc;
    const rows = Object.keys(defs).map((k) => {
      const i = c.inputs[k] || {};
      const src = i.source === 'plan' ? 'From your plan' : i.source === 'assumption' ? 'Assumption' : 'You';
      return `<div class="py-1.5 min-w-0">
        <label for="mplan-calc-${k}" class="text-xs font-semibold text-gray-700">${esc(defs[k].label)} <span class="text-gray-400">(${esc(defs[k].unit)})</span></label>
        <div class="flex items-center gap-2 mt-0.5">
          <input id="mplan-calc-${k}" type="number" inputmode="decimal" step="any" min="${Number(defs[k].min)}" data-mplan-calc="${k}" value="${i.value == null ? '' : esc(i.value)}" class="w-full min-w-0 rounded-md border border-gray-300 p-1.5 text-sm">
          <label class="shrink-0 text-[11px] text-gray-600 flex items-center gap-1"><input type="checkbox" data-mplan-calc-guess="${k}" ${i.source === 'assumption' ? 'checked' : ''}> A guess</label>
        </div>
        ${i.value != null && i.value !== '' ? `<p class="text-[11px] ${i.source === 'assumption' ? 'text-amber-700' : 'text-gray-500'}">${esc(src)}${i.note ? ` — ${esc(i.note)}` : ''}${i.sourceUrl ? ` · <a href="${esc(i.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="underline">source</a>` : ''}</p>` : ''}
      </div>`;
    }).join('');
    const r = c.result;
    const fmt = (n) => Number(n).toLocaleString('en-GB');
    return card(`
      <h2 class="text-base font-bold text-gray-900">Break-even calculator</h2>
      <p class="text-xs text-gray-500 mt-1">“If I spend £500 on ads, how many sales do I need?” Worked out exactly, not by AI. Tick “A guess” for anything you’re not sure of.</p>
      <div class="mt-2">${rows}</div>
      <button type="button" data-mplan-calc-go class="btn-primary mt-2 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${c.busy ? 'disabled' : ''}>${c.busy ? 'Working…' : 'Work it out'}</button>
      ${c.error ? `<p class="mt-2 text-xs font-semibold text-red-600" role="alert">${esc(c.error)}</p>` : ''}
      ${r ? `<div class="mt-3 rounded-lg border border-pink-200 bg-pink-50 p-3" data-mplan-calc-result role="status" aria-live="polite">
        <dl class="grid grid-cols-2 gap-2 text-sm">
          <div><dt class="text-[11px] text-gray-600">Each sale brings in</dt><dd class="font-bold text-gray-900">£${fmt(r.marginPerSale)}</dd></div>
          <div><dt class="text-[11px] text-gray-600">Sales to break even</dt><dd class="font-bold text-gray-900">${fmt(r.salesToBreakEven)}</dd></div>
          ${r.salesToCoverSpend ? `<div><dt class="text-[11px] text-gray-600">Sales to cover the spend</dt><dd class="font-bold text-gray-900">${fmt(r.salesToCoverSpend)}</dd></div>` : ''}
          ${r.leadsToBreakEven != null ? `<div><dt class="text-[11px] text-gray-600">Leads to break even</dt><dd class="font-bold text-gray-900">${fmt(r.leadsToBreakEven)}</dd></div>` : ''}
        </dl>
        <p class="text-xs text-gray-700 mt-2">${esc(r.sentence)}</p>
      </div>` : ''}`, 'data-mplan-panel="calculator"');
  }

  async function workItOut() {
    const c = state.calc;
    c.busy = true; c.error = null; render();
    try {
      const body = await call({ action: 'break_even', inputs: c.inputs });
      c.result = body.result;
    } catch (err) { c.error = err.message; c.result = null; }
    c.busy = false; render();
  }

  // ── Research ─────────────────────────────────────────────────────────────
  function researchHtml() {
    const d = state.data;
    const r = state.research;
    const list = (d.research || []).map((j) => {
      const res = j.result || {};
      const body = j.status === 'queued' || j.status === 'running'
        ? '<p class="text-xs text-pink-700 mt-1"><span class="animate-pulse">●</span> Looking it up — about two minutes.</p>'
        : j.status === 'failed' ? `<p class="text-xs text-red-600 mt-1">${esc(j.error || 'It couldn’t be finished. Nothing was charged.')}</p>`
          : `<p class="text-sm text-gray-800 mt-1 whitespace-pre-line break-words">${esc(res.answer || '')}</p>
             ${(res.sources || []).length ? `<ul class="mt-1 space-y-0.5">${res.sources.map((s) => `<li class="text-xs break-words"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="text-pink-700 underline">${esc(s.title || s.url)}</a></li>`).join('')}</ul>` : ''}`;
      return `<li class="py-2 border-b border-gray-100 last:border-0">
        <p class="text-sm font-semibold text-gray-900 break-words">${esc(j.question || '')}</p>
        <p class="text-[11px] text-gray-500">${esc(ukDate(j.createdAt))}</p>${body}</li>`;
    }).join('');
    return card(`
      <h2 class="text-base font-bold text-gray-900">Look this up</h2>
      <p class="text-xs text-gray-500 mt-1">${esc(state.assistantName)} searches the web and answers with its sources — about two minutes, 1 task. If it can’t find a source, it says so rather than guess.</p>
      <label for="mplan-research-q" class="sr-only">Your question</label>
      <textarea id="mplan-research-q" data-mplan-research-q rows="2" maxlength="600" class="mt-2 w-full rounded-lg border border-gray-300 p-2 text-sm" placeholder="e.g. What do dog groomers in Leeds usually charge for a full groom?" ${r.busy || !d.researchReady ? 'disabled' : ''}>${esc(r.question)}</textarea>
      <button type="button" data-mplan-research-go class="btn-primary mt-2 px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50" ${r.busy || !d.researchReady ? 'disabled' : ''}>${r.busy ? 'Starting…' : 'Look this up · 1 task'}</button>
      ${r.error ? `<p class="mt-2 text-xs font-semibold text-red-600" role="alert">${esc(r.error)}</p>` : ''}
      <h3 class="text-xs font-bold uppercase tracking-wide text-gray-500 mt-4">Research</h3>
      ${list ? `<ul class="mt-1">${list}</ul>` : `<p class="text-sm text-gray-500 mt-1">${d.researchReady ? 'Nothing looked up yet. Answers from chat are listed here too.' : 'Research isn’t switched on for this workspace yet.'}</p>`}`, 'data-mplan-panel="research"');
  }

  async function lookUp(question) {
    const r = state.research;
    if (r.busy) return;
    r.busy = true; r.error = null; render();
    try {
      await call({ action: 'research', question: question != null ? question : r.question });
      r.question = '';
      await load();
    } catch (err) { r.error = err.message; }
    r.busy = false; render();
  }

  // ── Playbook ─────────────────────────────────────────────────────────────
  function playbookHtml() {
    const p = state.data.playbook || {};
    const b = p.inUse;
    if (!b) {
      return card(`<h2 class="text-base font-bold text-gray-900">The playbook I’m using</h2>
        <p class="text-sm text-gray-600 mt-1">None yet for your kind of business. ${esc(state.assistantName)} only coaches from a playbook once a person at Be More Swan has reviewed it${(p.awaitingReview || []).length ? ' — one for your kind of business is being reviewed' : ''}. Until then, general advice is labelled as its own judgement.</p>`, 'data-mplan-panel="playbook"');
    }
    const list = (title, pts) => pts && pts.length ? `<h3 class="text-xs font-bold uppercase tracking-wide text-gray-500 mt-3">${esc(title)}</h3><ul class="mt-1 space-y-1">${pts.map((x) => `<li class="text-sm text-gray-800 break-words">${esc(x.text)}${x.judgement ? ' <span class="text-[11px] text-gray-500">(reviewer’s judgement)</span>' : ''}${(x.sources || []).map((s) => ` <a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="text-[11px] text-pink-700 underline">${esc(s.title)}</a>`).join('')}</li>`).join('')}</ul>` : '';
    return card(`<details><summary class="cursor-pointer text-base font-bold text-gray-900">The playbook I’m using</summary>
      <p class="text-sm font-semibold text-gray-900 mt-2">${esc(b.title)}</p>
      <p class="text-[11px] text-gray-500">Reviewed by ${esc(b.reviewed.by)} on ${esc(ukDate(b.reviewed.on))}</p>
      ${list('What good looks like', b.whatGoodLooksLike)}${list('The usual first 90 days', b.first90Days)}${list('Common mistakes', b.commonMistakes)}${list('The measures that matter', b.measures)}
    </details>`, 'data-mplan-panel="playbook"');
  }

  function render() {
    const el = host();
    if (!el) return;
    if (state.error && !state.data) {
      el.innerHTML = card(`<p class="text-sm text-red-600">${esc(state.error)}</p><button type="button" data-mplan-retry class="btn-secondary mt-3 px-3 py-1.5 border text-xs font-bold rounded-lg">Try again</button>`);
      return;
    }
    if (!state.data) { el.innerHTML = card('<p class="text-sm text-gray-400 animate-pulse">Loading…</p>'); return; }
    // Keep the caret where the user was typing across a repaint.
    const active = document.activeElement;
    const focusKey = active && el.contains(active) ? (active.getAttribute('data-mplan-field') || active.getAttribute('data-mplan-assumption') || active.getAttribute('data-mplan-calc') || (active.hasAttribute('data-mplan-research-q') ? 'research' : null)) : null;
    el.innerHTML = `
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-3 items-start">
        <div class="space-y-4 min-w-0 lg:col-span-2">${plansHtml()}${researchHtml()}</div>
        <div class="space-y-4 min-w-0">${calcHtml()}${playbookHtml()}
          ${card(`<p class="text-xs text-gray-600">Prefer to talk it through? Ask ${esc(state.assistantName)} in chat — it fills in the same plans, and nothing is saved without your click.</p>`)}
        </div>
      </div>`;
    if (focusKey) {
      const sel = focusKey === 'research' ? '[data-mplan-research-q]' : `[data-mplan-field="${focusKey}"],[data-mplan-assumption="${focusKey}"],[data-mplan-calc="${focusKey}"]`;
      const again = el.querySelector(sel);
      if (again) { again.focus(); try { const n = again.value.length; again.setSelectionRange(n, n); } catch (e) { /* number inputs */ } }
    }
  }

  // ── Saving ───────────────────────────────────────────────────────────────
  async function save(kind, patch, okText) {
    state.busy[kind] = true; state.notes[kind] = { text: 'Saving…' }; render();
    try {
      await call({ action: 'strategy_save', kind, ...patch });
      delete state.edits[kind];
      state.notes[kind] = { text: okText || 'Draft saved. Nothing changes for your assistants until it’s approved.' };
      await load();
    } catch (err) {
      state.notes[kind] = { text: err.message, error: true };
    }
    state.busy[kind] = false; render();
  }

  function saveEdits(kind) {
    const e = state.edits[kind];
    const d = docOf(kind);
    // A pre-fill nobody has touched is saved as it is shown.
    const patch = e ? { sections: e.sections || {}, ...(e.assumptions ? { assumptions: e.assumptions } : {}) }
      : (!d.draft && !d.approved && d.prefill) ? { sections: d.prefill.sections || {} } : null;
    if (!patch) return;
    if (!d.draft && !d.approved && d.prefill && e) patch.sections = { ...(d.prefill.sections || {}), ...patch.sections };
    save(kind, patch);
  }

  async function approve(kind) {
    const d = docOf(kind);
    if (!d.draft) return;
    // /dialogs.js owns every dialog.
    const ok = await window.confirmModal(`${kind === 'idea_check' ? 'It’s kept as your record of the idea.' : 'Every assistant will write from it from their next draft.'} The version it replaces is kept under Earlier versions.`,
      { title: `Approve your ${esc(defOf(kind).label.toLowerCase())}?`, confirmLabel: 'Approve', tone: 'golive' });
    if (!ok) return;
    state.busy[kind] = true; state.notes[kind] = { text: 'Approving…' }; render();
    try {
      await call({ action: 'strategy_approve', kind, draftId: d.draft.id, updatedAt: d.draft.updatedAt });
      state.notes[kind] = { text: kind === 'idea_check' ? 'Approved.' : 'Approved — your assistants write from it from their next draft.' };
      state.showChanges = false;
      await load();
    } catch (err) { state.notes[kind] = { text: err.message, error: true }; }
    state.busy[kind] = false; render();
  }

  async function draftForMe(kind) {
    state.busy[kind] = true; state.notes[kind] = { text: 'Starting…' }; render();
    try {
      await call({ action: 'strategy_draft', kind });
      state.notes[kind] = { text: 'Drafting — about a minute. It will appear here; nothing is saved until you choose.' };
      await load();
    } catch (err) { state.notes[kind] = { text: err.message, error: true }; }
    state.busy[kind] = false; render();
  }

  function useDraft(jobId) {
    const j = (state.data.drafting || []).find((x) => x.id === jobId);
    if (!j || !j.result) return;
    const kind = j.strategyKind;
    save(kind, { sections: j.result.sections || {}, ...(j.result.assumptions ? { assumptions: j.result.assumptions } : {}) }, 'Saved as your draft — edit anything, then approve it when it’s right.');
  }

  // ── Handlers: bound once, to document ────────────────────────────────────
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !host()?.contains(t)) return;
    const k = t.closest('[data-mplan-kind]');
    if (k) { state.kind = k.getAttribute('data-mplan-kind'); state.showChanges = false; render(); return; }
    const sv = t.closest('[data-mplan-save]'); if (sv) { saveEdits(sv.getAttribute('data-mplan-save')); return; }
    const ap = t.closest('[data-mplan-approve]'); if (ap) { approve(ap.getAttribute('data-mplan-approve')); return; }
    const dr = t.closest('[data-mplan-draft]'); if (dr) { draftForMe(dr.getAttribute('data-mplan-draft')); return; }
    if (t.closest('[data-mplan-changes]')) { state.showChanges = !state.showChanges; render(); return; }
    const use = t.closest('[data-mplan-use-draft]'); if (use) { useDraft(Number(use.getAttribute('data-mplan-use-draft'))); return; }
    const dis = t.closest('[data-mplan-dismiss-draft]'); if (dis) { state.dismissedDrafts[Number(dis.getAttribute('data-mplan-dismiss-draft'))] = true; render(); return; }
    const st = t.closest('[data-mplan-step]');
    if (st) {
      const dir = Number(st.getAttribute('data-mplan-step'));
      const interview = defOf('idea_check').sections.filter((s) => s.group === 'interview');
      const q = interview[state.ideaStep];
      const typed = state.edits.idea_check?.sections?.[q.key];
      if (dir > 0 && typed !== undefined) {
        // "Next" saves this one answer to the same draft the chat writes to.
        if (state.ideaStep < interview.length - 1) state.ideaStep++;
        save('idea_check', { sections: { [q.key]: typed } }, 'Answer saved.');
        return;
      }
      state.ideaStep = Math.min(Math.max(0, state.ideaStep + dir), interview.length - 1);
      render(); return;
    }
    if (t.closest('[data-mplan-add-assumption]')) {
      const list = [...(working('idea_check').assumptions || []), { assumption: '', test: '' }];
      setEdit('idea_check', 'assumptions', list); render(); return;
    }
    const rm = t.closest('[data-mplan-remove-assumption]');
    if (rm) {
      const list = [...(working('idea_check').assumptions || [])];
      list.splice(Number(rm.getAttribute('data-mplan-remove-assumption')), 1);
      setEdit('idea_check', 'assumptions', list); render(); return;
    }
    const lk = t.closest('[data-mplan-lookup]');
    if (lk) {
      const [kind, key] = lk.getAttribute('data-mplan-lookup').split(':');
      const s = defOf(kind).sections.find((x) => x.key === key);
      const text = (working(kind).sections[key] || '').trim();
      state.research.question = text ? `Check this for my business plan (${s ? s.label : key}): ${text.slice(0, 400)}` : '';
      render();
      const box = host().querySelector('[data-mplan-research-q]');
      if (box) { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); box.focus(); }
      return;
    }
    if (t.closest('[data-mplan-research-go]')) { lookUp(); return; }
    if (t.closest('[data-mplan-calc-go]')) { workItOut(); return; }
    if (t.closest('[data-mplan-retry]')) load();
  });
  // Typing is kept in state (never lost to a repaint from a chat card or a poll).
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !host()?.contains(t)) return;
    const f = t.getAttribute('data-mplan-field');
    if (f) { const [kind, key] = f.split(':'); setEdit(kind, key, t.value); return; }
    const a = t.getAttribute('data-mplan-assumption');
    if (a) {
      const [i, field] = a.split(':');
      const list = (working('idea_check').assumptions || []).map((x) => ({ ...x }));
      if (list[Number(i)]) { list[Number(i)][field] = t.value; setEdit('idea_check', 'assumptions', list); }
      return;
    }
    const c = t.getAttribute('data-mplan-calc');
    if (c) {
      const prev = state.calc.inputs[c] || {};
      state.calc.inputs[c] = t.value === '' ? undefined : { ...prev, value: t.value, source: prev.source === 'assumption' ? 'assumption' : 'you', note: undefined, sourceUrl: prev.sourceUrl };
      return;
    }
    if (t.matches('[data-mplan-research-q]')) state.research.question = t.value;
  });
  // Status pills and buttons follow the edits once the field is left (a full repaint on every key would be noisy).
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !host()?.contains(t)) return;
    const g = t.getAttribute('data-mplan-calc-guess');
    if (g) {
      const prev = state.calc.inputs[g] || {};
      state.calc.inputs[g] = { ...prev, source: t.checked ? 'assumption' : 'you' };
      render(); return;
    }
    if (t.matches('[data-mplan-field],[data-mplan-assumption]')) render();
  });
  // A chat card saved or approved a plan, or a job finished: repaint from the server.
  document.addEventListener('mentor:planChanged', () => { if (state.assistantId && host()) load(); });
  // A break-even card's "Open in the calculator": fill the inputs and show this tab.
  document.addEventListener('mentor:openCalculator', (e) => {
    const inputs = (e.detail && e.detail.inputs) || {};
    state.calc.inputs = Object.fromEntries(Object.entries(inputs).filter(([, v]) => v && v.value != null));
    state.calc.result = null; state.calc.error = null;
    window.closeAssistantChat?.();
    window._activateMainTab?.('mentorplan');
    if (state.data) { render(); workItOut(); }
  });

  window.AssistantMentorPlan = {
    init({ assistantId, assistantName }) {
      clearTimeout(pollTimer);
      const keepCalc = state.assistantId === assistantId ? state.calc : null;
      state = fresh();
      state.assistantId = assistantId;
      state.assistantName = assistantName || 'Your Mentor';
      if (keepCalc) state.calc = keepCalc;
      render();
      load();
    },
    activate() { if (!state.data && !state.loading) load(); else { render(); schedulePoll(); } },
  };
})();
