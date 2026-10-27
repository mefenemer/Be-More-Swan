/**
 * src/components/assistant-follow-up-plan.js
 * The Lead Generator's Follow-up plan — the chasers that go after a first email, editable.
 * docs/lead-outreach-restructure-plan.md, Phase 3.
 *
 * Opened from the "Follow-up plan" button on the Outreach stage strip (assistant-lead-outreach.js),
 * drawn just under the strip (#lead-follow-up-plan, its own element) like the offer strip’s editor — no modal. Reads and saves through
 * lead-generation.ts `get_follow_up_plan` / `save_follow_up_plan`, the same actions as the chat's
 * follow_up_plan card. The rules (1–5 steps, 1–30 days, no reordering, numbers never reused) are
 * src/config/follow-up-plan.ts; the server returns the limits, so none are typed here.
 *
 * ⚠️ The draft lives in `state`, not the DOM, and every handler is bound once on `document` — the
 * strip repaints on every count change, and a handler bound from a render path, or text kept only in
 * an input, would be lost under the user's fingers.
 *
 * Styling reuses classes already compiled into style.css (no Tailwind rebuild).
 */
(function () {
  const API = '/.netlify/functions/lead-generation';

  let state = {
    assistantId: null,
    plan: null,          // the saved plan, from the server
    draft: null,         // { enabled, steps: [{ stepNumber|null, delayDays, brief }], stopRunning }
    open: false,
    saving: false,
    error: '',
    notice: '',
    loadError: '',
    // Phase 4 — "Preview": which emailed lead to preview with, and step index → { loading, result, error }.
    previewThreadId: null,
    previews: {},
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const host = () => document.getElementById('lead-follow-up-plan');

  async function call(action, extra) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action, assistantId: state.assistantId, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function draftFrom(plan) {
    return {
      enabled: !!plan.enabled,
      steps: plan.steps.map((s) => ({ stepNumber: s.stepNumber, delayDays: s.delayDays, brief: s.brief })),
      stopRunning: false,
    };
  }

  /** Tell the stage strip (and anything else listening) what the plan now is. */
  function announce() {
    document.dispatchEvent(new CustomEvent('lead:followUpPlanChanged', { detail: { plan: state.plan } }));
  }

  async function load() {
    try {
      state.plan = await call('get_follow_up_plan');
      state.loadError = '';
      if (!state.open) state.draft = draftFrom(state.plan);
    } catch (err) {
      state.loadError = err.message || 'The follow-up plan couldn’t be read.';
    }
    announce();
    paint();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  function stepHtml(s, i, n, limits) {
    const after = i === 0 ? 'the first email' : 'the follow-up before';
    const isLast = i === n - 1;
    return `
      <div class="rounded-lg border border-gray-200 bg-white p-3" data-fp-step="${i}">
        <div class="flex items-center justify-between gap-2">
          <p class="text-xs font-bold text-gray-900">Follow-up ${i + 1}${isLast ? ' · the last one' : ''}</p>
          <button type="button" data-fp-remove="${i}" ${n <= 1 ? 'disabled' : ''}
            class="text-xs font-bold text-gray-500 hover:text-red-700 underline disabled:opacity-50">Remove</button>
        </div>
        <label class="block text-xs text-gray-700 mt-2">Wait
          <input type="number" inputmode="numeric" min="${limits.minDelayDays}" max="${limits.maxDelayDays}" step="1"
            data-fp-delay="${i}" value="${esc(s.delayDays)}"
            class="ml-1 mr-1 w-16 px-2 py-1 rounded-lg border border-gray-300 text-sm bg-white">
          days after ${after}</label>
        <label class="block text-xs font-semibold text-gray-700 mt-2">What it should say
          <textarea rows="3" maxlength="${limits.maxBriefChars}" data-fp-brief="${i}"
            class="mt-1 w-full px-2 py-1.5 rounded-lg border border-gray-300 text-sm bg-white font-normal">${esc(s.brief)}</textarea></label>
        ${isLast ? '<p class="text-[11px] text-gray-500 mt-1">Whatever this one says, it also tells them it is the last email — that is added for you.</p>' : ''}
        ${previewControlsHtml(i)}
      </div>`;
  }

  /** The emailed leads a preview can be written for (the conversations list holds them). */
  function previewLeads() {
    return (window.AssistantLeadThreads && window.AssistantLeadThreads.previewableLeads
      && window.AssistantLeadThreads.previewableLeads()) || [];
  }

  /**
   * "Preview with [lead]" above the steps. A preview needs a real conversation to write into — the
   * worker drafts from the transcript — so with no emailed lead there is nothing to preview with, and
   * the line says so instead of offering a button that can only fail.
   */
  function previewPickerHtml() {
    const leads = previewLeads();
    if (!leads.length) {
      return '<p class="text-[11px] text-gray-500 mt-3">Preview becomes available once you have emailed a lead who hasn’t replied yet.</p>';
    }
    if (!leads.some((l) => l.threadId === state.previewThreadId)) state.previewThreadId = leads[0].threadId;
    return `
      <label class="flex flex-wrap items-center gap-2 text-xs text-gray-700 mt-3">Preview with
        <select data-fp-preview-lead class="px-2 py-1 rounded-lg border border-gray-300 text-sm bg-white">
          ${leads.map((l) => `<option value="${esc(l.threadId)}" ${l.threadId === state.previewThreadId ? 'selected' : ''}>${esc(l.title)}</option>`).join('')}
        </select>
        <span class="text-[11px] text-gray-500">— see what a follow-up would say to them. Nothing is sent.</span>
      </label>`;
  }

  function previewControlsHtml(i) {
    if (!previewLeads().length) return '';
    const p = state.previews[i] || {};
    const result = p.result ? `
      <div class="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Preview for ${esc(p.result.lead && p.result.lead.title)} · not sent</p>
        <p class="text-sm font-semibold text-gray-900 mt-1">${esc(p.result.subject)}</p>
        <p class="text-sm text-gray-700 mt-1 whitespace-pre-wrap">${esc(p.result.body)}</p>
        <p class="text-[11px] text-gray-500 mt-2">${esc(p.result.note || '')}</p>
      </div>` : '';
    return `
      <button type="button" data-fp-preview="${i}" ${p.loading ? 'disabled' : ''}
        class="mt-2 text-xs font-bold text-gray-700 underline hover:text-gray-900 disabled:opacity-50">${p.loading ? 'Writing a preview…' : 'Preview this one'}</button>
      ${p.error ? `<p class="text-xs font-bold text-amber-700 mt-1">${esc(p.error)}</p>` : ''}
      ${result}`;
  }

  function editorHtml() {
    const p = state.plan;
    const d = state.draft;
    if (!p || !d) return '';
    const L = p.limits;
    if (p.lockedOff) {
      return `<p class="text-xs text-amber-800">Follow-ups are switched off for this assistant by support, so nothing here can send. Contact us if that’s unexpected.</p>`;
    }
    const running = Number(p.running) || 0;
    const stopChoice = !d.enabled && p.enabled && running
      ? `<label class="flex items-start gap-2 mt-2 text-xs text-gray-700">
           <input type="checkbox" data-fp-stop ${d.stopRunning ? 'checked' : ''} class="mt-0.5 rounded border-gray-300">
           <span>Also stop the ${running} lead${running === 1 ? '' : 's'} being followed up now. Otherwise switching off only affects leads you approve from here on.</span>
         </label>`
      : '';
    const steps = d.enabled ? `
      ${previewPickerHtml()}
      <div class="flex flex-col gap-2 mt-3">${d.steps.map((s, i) => stepHtml(s, i, d.steps.length, L)).join('')}</div>
      <div class="flex flex-wrap items-center gap-3 mt-2">
        <button type="button" data-fp-add ${d.steps.length >= L.maxSteps ? 'disabled' : ''}
          class="text-xs font-bold text-gray-700 underline hover:text-gray-900 disabled:opacity-50">+ Add a follow-up</button>
        <button type="button" data-fp-reset class="text-xs font-bold text-gray-500 underline hover:text-gray-900">Reset to default</button>
        <span class="text-[11px] text-gray-500">Up to ${L.maxSteps}. Each one stops the moment they reply.</span>
      </div>` : '';
    return `
      <label class="flex items-start gap-2 text-xs text-gray-800">
        <input type="checkbox" data-fp-enabled ${d.enabled ? 'checked' : ''} class="mt-0.5 rounded border-gray-300">
        <span><span class="font-bold">Chase leads who don’t reply.</span> Each follow-up is written in the context of the conversation and sent from your own mailbox.</span>
      </label>
      ${stopChoice}
      ${steps}
      <p class="text-[11px] text-gray-500 mt-3">New wording applies to every follow-up not yet sent. A new wait applies from each lead’s next follow-up to be booked; one already booked keeps its date.</p>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" data-fp-save ${state.saving ? 'disabled' : ''} class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50">${state.saving ? 'Saving…' : 'Save plan'}</button>
        <button type="button" data-fp-cancel ${state.saving ? 'disabled' : ''} class="btn-secondary px-3 py-1.5 text-xs font-bold rounded-lg border disabled:opacity-50">Cancel</button>
      </div>
      ${state.error ? `<p class="text-xs font-bold text-red-700 mt-2" role="alert">${esc(state.error)}</p>` : ''}`;
  }

  function paint() {
    const h = host();
    if (!h) return;
    if (!state.open) {
      h.innerHTML = state.notice ? `<p class="text-xs font-bold text-green-700 mb-3" role="status">${esc(state.notice)}</p>` : '';
      return;
    }
    const body = state.loadError
      ? `<p class="text-xs text-amber-800">${esc(state.loadError)}</p>`
      : (state.plan ? editorHtml() : '<p class="text-xs text-gray-500">Loading your follow-up plan…</p>');
    h.innerHTML = `
      <div class="bg-gray-50 rounded-xl border border-gray-200 shadow-sm px-4 py-3 mb-4" role="region" aria-label="Follow-up plan">
        <p class="text-sm font-bold text-gray-900">Follow-up plan</p>
        <p class="text-xs text-gray-600 mt-0.5 mb-2">What happens after a first email when the prospect doesn’t reply.</p>
        ${body}
      </div>`;
  }

  // ── Edits (delegated once) ────────────────────────────────────────────────

  function inPanel(el) {
    const h = host();
    return h && el && h.contains(el);
  }

  document.addEventListener('input', (e) => {
    if (!inPanel(e.target) || !state.draft) return;
    const delay = e.target.getAttribute('data-fp-delay');
    if (delay != null) { state.draft.steps[Number(delay)].delayDays = Number(e.target.value); return; }
    const brief = e.target.getAttribute('data-fp-brief');
    if (brief != null) state.draft.steps[Number(brief)].brief = e.target.value;
  });

  document.addEventListener('change', (e) => {
    if (!inPanel(e.target) || !state.draft) return;
    if (e.target.matches('[data-fp-enabled]')) {
      state.draft.enabled = e.target.checked;
      // Switching back on with no steps left (an unusual path) starts from the defaults.
      if (state.draft.enabled && !state.draft.steps.length) resetToDefault();
      paint();
    } else if (e.target.matches('[data-fp-stop]')) {
      state.draft.stopRunning = e.target.checked;
    } else if (e.target.matches('[data-fp-preview-lead]')) {
      state.previewThreadId = Number(e.target.value);
      state.previews = {};                         // previews were for the previous lead
      paint();
    }
  });

  /**
   * "Reset to default" without renumbering: the default wording and waits are laid onto the steps the
   * plan already has, in order — so a lead part-way through gets the default's NEXT step, not a
   * second first nudge. Extra steps are removed; missing ones are added as new.
   */
  function resetToDefault() {
    const defaults = (state.plan && state.plan.defaults) || [];
    const existing = state.draft.steps;
    state.draft.steps = defaults.map((d, i) => ({
      stepNumber: existing[i] ? existing[i].stepNumber : null,
      delayDays: d.delayDays,
      brief: d.brief,
    }));
  }

  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (!inPanel(t) || !state.draft) return;

    const remove = t.closest('[data-fp-remove]');
    if (remove) {
      state.draft.steps.splice(Number(remove.getAttribute('data-fp-remove')), 1);
      state.error = '';
      state.previews = {};                         // keyed by position, which just moved
      paint();
      return;
    }
    if (t.closest('[data-fp-add]')) {
      const last = state.draft.steps[state.draft.steps.length - 1];
      state.draft.steps.push({ stepNumber: null, delayDays: last ? last.delayDays : 7, brief: '' });
      paint();
      host()?.querySelector(`[data-fp-brief="${state.draft.steps.length - 1}"]`)?.focus();
      return;
    }
    if (t.closest('[data-fp-reset]')) { resetToDefault(); state.error = ''; state.previews = {}; paint(); return; }
    const previewBtn = t.closest('[data-fp-preview]');
    if (previewBtn) { await preview(Number(previewBtn.getAttribute('data-fp-preview'))); return; }
    if (t.closest('[data-fp-cancel]')) {
      state.open = false;
      state.error = '';
      state.draft = state.plan ? draftFrom(state.plan) : null;
      state.previews = {};
      paint();
      document.dispatchEvent(new CustomEvent('lead:followUpPlanToggled', { detail: { open: false } }));
      return;
    }
    if (t.closest('[data-fp-save]')) await save();
  });

  /**
   * Draft step i for the chosen lead WITH THE WORDING ON SCREEN, saved or not — previewing before
   * saving is the point. lead-generation.ts preview_follow_up; nothing is sent or stored.
   */
  async function preview(i) {
    const s = state.draft && state.draft.steps[i];
    if (!s || !state.previewThreadId) return;
    state.previews[i] = { loading: true };
    paint();
    try {
      const result = await call('preview_follow_up', {
        threadId: state.previewThreadId, position: i + 1, brief: s.brief, planLength: state.draft.steps.length,
      });
      state.previews[i] = { result };
    } catch (err) {
      state.previews[i] = { error: err.message || 'The preview couldn’t be written.' };
    }
    paint();
  }

  async function save() {
    if (state.saving) return;
    const d = state.draft;
    state.saving = true;
    state.error = '';
    paint();
    try {
      const payload = { enabled: d.enabled, stopRunning: !!d.stopRunning };
      // Steps are only sent while chasing is on — switching off must not need a valid plan, and the
      // plan's steps are kept for switching back on.
      if (d.enabled) payload.steps = d.steps.map((s) => ({ stepNumber: s.stepNumber, delayDays: s.delayDays, brief: s.brief }));
      const saved = await call('save_follow_up_plan', payload);
      state.plan = saved;
      state.draft = draftFrom(saved);
      state.open = false;
      // Mid-sentence, so "No follow-ups — …" reads as "no follow-ups — …".
      const summary = String(saved.summary || '').replace(/^No /, 'no ');
      state.notice = saved.stopped
        ? `Saved — ${summary}. Stopped follow-ups for ${saved.stopped} lead${saved.stopped === 1 ? '' : 's'}.`
        : `Saved — ${summary}.`;
      announce();
      document.dispatchEvent(new CustomEvent('lead:followUpPlanToggled', { detail: { open: false } }));
    } catch (err) {
      state.error = err.message || 'The plan couldn’t be saved.';
    } finally {
      state.saving = false;
      paint();
    }
  }

  // The chat's follow_up_plan card saved through the same action — re-read rather than guess.
  document.addEventListener('lead:followUpPlanSaved', () => { if (state.assistantId) load(); });

  // ── Public API ────────────────────────────────────────────────────────────

  window.LeadFollowUpPlan = {
    /** Called by the stage strip's init. Loads at once: the To approve note quotes the plan. */
    init({ assistantId }) {
      state = { assistantId, plan: null, draft: null, open: false, saving: false, error: '', notice: '', loadError: '', previewThreadId: null, previews: {} };
      load();
    },
    /** Open or close the panel. Opening discards nothing typed earlier in the same visit. */
    toggle() {
      state.open = !state.open;
      state.notice = '';
      if (state.open && state.plan && !state.draft) state.draft = draftFrom(state.plan);
      paint();
      return state.open;
    },
    isOpen() { return state.open; },
    /** Repaint into the strip's host after the strip itself was redrawn. */
    paint,
    /** The saved plan, or null while loading. */
    plan() { return state.plan; },
  };
})();
