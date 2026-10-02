/**
 * src/components/assistant-onboarding-shell.js
 *
 * Schema-driven onboarding wizard for Digital Assistants — one shell renders any
 * assistant's setup flow from a JSON configurationSchema instead of a hand-built
 * page per role (the Social Media Manager wizard, onboarding-social-media.html, is
 * the visual reference this mirrors).
 *
 * Usage:
 *   const shell = window.AssistantOnboardingShell.mount({
 *     container,              // HTMLElement to render into
 *     assistantId,            // number — the aiAssistants row to save context onto
 *     configurationSchema,    // JSON array — see shape below
 *     onComplete,             // optional (answers) => void, fires after a successful save
 *     assistantName,          // the instance's current name — prefills the naming step
 *     roleLabel,              // the role title (master_assistants.name) — steers name suggestions
 *     askName,                // default true: open with a "Name your assistant" step
 *   });
 *   shell.getFormState()      // current answers object
 *   shell.destroy()
 *
 * configurationSchema — an array of steps:
 *   [{ title, description?, fields: [field, ...] }, ...]
 * or a flat array of fields (auto-wrapped into a single step). Each field:
 *   { key,                    // property name in the saved onboardingContext
 *     label,
 *     type,                   // 'text' | 'textarea' | 'number' | 'dropdown' | 'toggle' | 'radio'
 *     required?,              // boolean (toggles are never required — off is an answer)
 *     helpText?, placeholder?, defaultValue?,
 *     min?, max?,             // number fields only
 *     options? }              // dropdown/radio: [{ value, label, description? }]
 *
 * "Complete Setup" saves the collected answers to aiAssistants.onboardingContext via
 * the existing PUT /.netlify/functions/update-assistant-context pattern (audit-logged,
 * tenant-scoped server side) — the same JSON the chat orchestrator injects into every
 * conversation's system prompt.
 */
(function () {
  'use strict';

  const SAVE_URL = '/.netlify/functions/update-assistant-context';
  const NAMES_URL = '/.netlify/functions/generate-names';
  const CHECK_NAME_URL = '/.netlify/functions/check-assistant-name';
  const NAME_KEY = '__assistant_name';
  const SWAN_IMG = '/images/BeMoreSwan_SwanAI.png';
  // Used when the AI name generator is unavailable, so the swan always suggests something.
  const FALLBACK_NAMES = ['Aria', 'Nova', 'Echo', 'Sage', 'Luna', 'Atlas', 'Ember', 'Orion', 'Lyra', 'Zara',
    'Finn', 'Cleo', 'Mira', 'Axel', 'Skye', 'Juno', 'Ivy', 'Stella', 'Felix', 'Wren', 'Dex', 'Pip'];
  const NAME_THEMES = ['Greek Mythology', 'Famous Poets', 'Space', 'Nature'];

  // The swan "casts" while suggestions load — same animation as the detail page's name button.
  function injectStyles() {
    if (document.getElementById('aos-styles')) return;
    const st = document.createElement('style');
    st.id = 'aos-styles';
    st.textContent = `
      .aos-swan-btn { position:absolute; right:8px; top:50%; transform:translateY(-50%); display:inline-flex; align-items:center; gap:6px;
        padding:4px 10px 4px 6px; border-radius:9999px; border:1px solid #e5e7eb; background:#fff; font-size:12px; font-weight:700; color:#374151; cursor:pointer; }
      .aos-swan-btn:hover { border-color:#f472b6; background:#fdf2f8; }
      .aos-swan-btn img { height:22px; width:auto; transform-origin:bottom center; }
      .aos-swan-btn.is-casting img { animation: aosSwanCast 0.7s ease-in-out infinite; }
      @keyframes aosSwanCast { 0% { transform: rotate(-9deg); } 50% { transform: rotate(9deg) scale(1.12); } 100% { transform: rotate(-9deg); } }
      @media (prefers-reduced-motion: reduce) { .aos-swan-btn.is-casting img { animation: none; opacity: .5; } }`;
    document.head.appendChild(st);
  }

  // Schema copy may name a role as {role:<roleKey>} — filled from master data (role-labels.js), so
  // an admin rename of a role reaches the setup wizard too.
  function roleText(value) {
    return window.RoleLabels ? window.RoleLabels.fill(value) : String(value ?? '');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Accept either an array of steps ({ fields: [...] }) or a flat array of fields. */
  function normaliseSchema(configurationSchema) {
    if (!Array.isArray(configurationSchema) || configurationSchema.length === 0) return [];
    const isSteps = configurationSchema.every((entry) => Array.isArray(entry?.fields));
    const steps = isSteps
      ? configurationSchema
      : [{ title: 'Set up your assistant', fields: configurationSchema }];
    return steps
      .map((step) => ({
        title: step.title || 'Set up your assistant',
        description: step.description || '',
        fields: (step.fields || []).filter((f) => f && f.key && f.type),
      }))
      .filter((step) => step.fields.length > 0);
  }

  // ── Field renderers ───────────────────────────────────────────────────────────
  // One <div data-field-key> block per field; readers below pull values back out by key.

  function inputClasses() {
    return 'w-full border border-gray-300 rounded-lg p-3 focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700 transition shadow-sm bg-white';
  }

  function fieldHeader(field) {
    return `
      <label class="block text-sm font-bold text-gray-700 mb-1">
        ${escapeHtml(roleText(field.label || field.key))}
        ${field.required ? '<span class="text-red-500">*</span>' : ''}
      </label>
      ${field.helpText ? `<p class="text-xs text-gray-500 mb-3">${escapeHtml(roleText(field.helpText))}</p>` : ''}`;
  }

  function renderField(field, value) {
    const name = `aos_${field.key}`;
    switch (field.type) {
      case 'assistant_name':
        return `${fieldHeader(field)}
          <div style="position:relative;">
            <input type="text" name="${escapeHtml(name)}" value="${escapeHtml(value ?? '')}" maxlength="50" autocomplete="off"
              placeholder="e.g. Nova" class="${inputClasses()}" style="padding-right:150px;">
            <button type="button" data-aos-suggest-name class="aos-swan-btn" title="Let Be More Swan suggest a name" aria-label="Suggest a name">
              <img src="${SWAN_IMG}" alt=""> Suggest a name
            </button>
          </div>
          <div class="flex flex-wrap items-center gap-2 mt-3">
            <span class="text-xs text-gray-500">Or pick a theme:</span>
            ${NAME_THEMES.map((t) => `<button type="button" data-aos-name-theme="${escapeHtml(t)}" class="text-xs px-2 py-1 bg-white border border-gray-200 rounded hover:bg-gray-100 transition">${escapeHtml(t)}</button>`).join('')}
          </div>
          <div data-aos-name-results class="hidden flex flex-wrap gap-2 mt-3"></div>
          <span data-aos-name-taken class="hidden text-red-500 text-xs font-bold mt-2 block">You already have an assistant with this name — please choose another.</span>`;

      case 'text':
        return `${fieldHeader(field)}
          <input type="text" name="${escapeHtml(name)}" value="${escapeHtml(value ?? '')}"
            placeholder="${escapeHtml(field.placeholder || '')}" class="${inputClasses()}">`;

      case 'number':
        return `${fieldHeader(field)}
          <input type="number" name="${escapeHtml(name)}" value="${escapeHtml(value ?? '')}"
            placeholder="${escapeHtml(field.placeholder || '')}"
            ${field.min !== undefined ? `min="${escapeHtml(field.min)}"` : ''}
            ${field.max !== undefined ? `max="${escapeHtml(field.max)}"` : ''} class="${inputClasses()}">`;

      case 'textarea':
        return `${fieldHeader(field)}
          <textarea name="${escapeHtml(name)}" rows="4" placeholder="${escapeHtml(field.placeholder || '')}"
            class="${inputClasses()} resize-y">${escapeHtml(value ?? '')}</textarea>`;

      case 'dropdown':
        return `${fieldHeader(field)}
          <select name="${escapeHtml(name)}" class="${inputClasses()}">
            <option value="">${escapeHtml(field.placeholder || 'Please select…')}</option>
            ${(field.options || []).map((opt) => `
              <option value="${escapeHtml(opt.value)}" ${String(opt.value) === String(value) ? 'selected' : ''}>${escapeHtml(opt.label ?? opt.value)}</option>`).join('')}
          </select>`;

      case 'toggle':
        return `
          <label class="flex items-start justify-between gap-4 p-4 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 hover:border-emerald-300 transition">
            <span>
              <span class="block font-bold text-gray-900 text-sm">${escapeHtml(roleText(field.label || field.key))}</span>
              ${field.helpText ? `<span class="block text-xs text-gray-500 mt-0.5">${escapeHtml(roleText(field.helpText))}</span>` : ''}
            </span>
            <span class="relative inline-flex shrink-0 mt-0.5">
              <input type="checkbox" name="${escapeHtml(name)}" class="sr-only peer" ${value ? 'checked' : ''}>
              <span class="w-11 h-6 bg-gray-200 rounded-full peer-checked:bg-emerald-700 peer-focus:ring-2 peer-focus:ring-emerald-700 peer-focus:ring-offset-1 transition
                after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:bg-white after:rounded-full after:shadow after:transition-all peer-checked:after:translate-x-5"></span>
            </span>
          </label>`;

      case 'radio':
        return `${fieldHeader(field)}
          <div class="space-y-3">
            ${(field.options || []).map((opt) => `
              <label class="flex items-start p-4 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 hover:border-emerald-300 transition has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50">
                <input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(opt.value)}"
                  class="mt-1 h-5 w-5 text-emerald-700 focus:ring-emerald-700 border-gray-300" ${String(opt.value) === String(value) ? 'checked' : ''}>
                <div class="ml-4">
                  <span class="block font-bold text-gray-900">${escapeHtml(opt.label ?? opt.value)}</span>
                  ${opt.description ? `<span class="block text-sm text-gray-500 mt-0.5">${escapeHtml(roleText(opt.description))}</span>` : ''}
                </div>
              </label>`).join('')}
          </div>`;

      default:
        console.warn(`[AssistantOnboardingShell] unknown field type "${field.type}" for "${field.key}" — skipped.`);
        return '';
    }
  }

  function readFieldValue(container, field) {
    const name = `aos_${field.key}`;
    switch (field.type) {
      case 'toggle': {
        const el = container.querySelector(`input[name="${CSS.escape(name)}"]`);
        return !!el?.checked;
      }
      case 'radio': {
        const el = container.querySelector(`input[name="${CSS.escape(name)}"]:checked`);
        return el ? el.value : null;
      }
      case 'number': {
        const el = container.querySelector(`[name="${CSS.escape(name)}"]`);
        if (!el || el.value.trim() === '') return null;
        const n = Number(el.value);
        return Number.isFinite(n) ? n : null;
      }
      default: {
        const el = container.querySelector(`[name="${CSS.escape(name)}"]`);
        return el ? el.value.trim() : null;
      }
    }
  }

  function isAnswered(value, field) {
    if (field.type === 'toggle') return true; // off is a valid answer
    return value !== null && value !== '';
  }

  // ── Shell ─────────────────────────────────────────────────────────────────────

  function mount(props) {
    const { container, assistantId, onComplete, roleKey, roleLabel } = props || {};
    let assistantName = props?.assistantName || '';
    const originalName = assistantName;
    if (!(container instanceof HTMLElement)) {
      throw new Error('[AssistantOnboardingShell] mount() requires a container element.');
    }
    const steps = normaliseSchema(props.configurationSchema);
    if (steps.length === 0) {
      throw new Error('[AssistantOnboardingShell] configurationSchema has no renderable fields.');
    }
    // Every hire opens by naming the assistant (the Social Media wizard has always done this). The
    // name is saved with the rest of the setup, never into onboardingContext.
    if (props.askName !== false) {
      injectStyles();
      steps.unshift({
        title: 'Name your assistant',
        description: 'Give your new assistant a name your team will recognise — or tap the swan for ideas. You can change it later.',
        fields: [{
          key: NAME_KEY,
          type: 'assistant_name',
          label: 'Assistant name',
          required: true,
          requiredMessage: 'Please give your assistant a name.',
          defaultValue: assistantName,
        }],
      });
    }

    let currentStep = 0;
    let saving = false;
    const answers = {};
    steps.forEach((step) => step.fields.forEach((f) => {
      answers[f.key] = f.defaultValue ?? (f.type === 'toggle' ? false : null);
    }));

    container.innerHTML = `
      <div class="bg-white rounded-2xl shadow-lg border border-gray-100 w-full max-w-2xl overflow-hidden" data-aos-root>
        <div class="bg-gray-100 h-2 w-full">
          <div class="bg-emerald-700 h-2 transition-all duration-500 ease-out" data-aos-progress style="width: 0%;"></div>
        </div>
        <div class="p-8 sm:p-12">
          <form data-aos-form novalidate></form>
        </div>
      </div>`;

    const progressEl = container.querySelector('[data-aos-progress]');
    const formEl = container.querySelector('[data-aos-form]');

    // ── Naming step helpers ──────────────────────────────────────────────────────
    let fallbackIdx = Math.floor(Math.random() * FALLBACK_NAMES.length);
    function nameInput() { return formEl.querySelector(`[name="aos_${NAME_KEY}"]`); }
    function applyName(n) {
      const input = nameInput();
      if (!input) return;
      input.value = n;
      formEl.querySelector('[data-aos-name-taken]')?.classList.add('hidden');
      formEl.querySelector(`[data-aos-error="${NAME_KEY}"]`)?.classList.add('hidden');
    }
    function renderNameChips(names) {
      const box = formEl.querySelector('[data-aos-name-results]');
      if (!box) return;
      box.innerHTML = names.map((n) => `<button type="button" data-aos-pick-name="${escapeHtml(n)}" class="px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 rounded-md text-sm font-bold transition shadow-sm">${escapeHtml(n)}</button>`).join('');
      box.classList.toggle('hidden', names.length === 0);
    }
    let suggesting = false;
    async function suggestNames(theme) {
      if (suggesting) return;
      suggesting = true;
      const btn = formEl.querySelector('[data-aos-suggest-name]');
      btn?.classList.add('is-casting');
      let names = [];
      try {
        const res = await fetch(NAMES_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme: theme || 'friendly, memorable and professional', role: roleLabel || 'Digital Assistant' }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(data.names)) names = data.names.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().slice(0, 50));
      } catch { /* fall through to the local list */ }
      if (names.length === 0) {
        names = Array.from({ length: 4 }, () => FALLBACK_NAMES[(fallbackIdx = (fallbackIdx + 1) % FALLBACK_NAMES.length)]);
      }
      btn?.classList.remove('is-casting');
      suggesting = false;
      if (!nameInput()) return; // user moved on while it loaded
      applyName(names[0]);
      renderNameChips(names);
    }
    /** Unique per organisation — checked before leaving the naming step, not at the final save. */
    async function nameIsAvailable(n) {
      if (originalName && n.toLowerCase() === originalName.toLowerCase()) return true;
      try {
        const res = await fetch(`${CHECK_NAME_URL}?name=${encodeURIComponent(n)}`);
        if (!res.ok) return true; // can't tell — the save still guards it (409 NAME_TAKEN)
        const data = await res.json().catch(() => ({}));
        return data.isUnique !== false;
      } catch { return true; }
    }

    /** Persist the visible step's inputs into `answers` before navigating away. */
    function captureCurrentStep() {
      steps[currentStep].fields.forEach((field) => {
        answers[field.key] = readFieldValue(formEl, field);
      });
    }

    function validateCurrentStep() {
      let firstInvalid = null;
      steps[currentStep].fields.forEach((field) => {
        const errEl = formEl.querySelector(`[data-aos-error="${CSS.escape(field.key)}"]`);
        const missing = field.required && !isAnswered(readFieldValue(formEl, field), field);
        errEl?.classList.toggle('hidden', !missing);
        if (missing && !firstInvalid) firstInvalid = errEl;
      });
      firstInvalid?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return !firstInvalid;
    }

    function renderStep() {
      const step = steps[currentStep];
      const isLast = currentStep === steps.length - 1;
      progressEl.style.width = `${Math.round(((currentStep + 1) / steps.length) * 100)}%`;

      formEl.innerHTML = `
        <div class="step-active">
          <span class="text-emerald-700 font-bold text-sm tracking-wider uppercase mb-2 block">Step ${currentStep + 1} of ${steps.length}</span>
          <h2 class="text-3xl font-extrabold text-gray-900 mb-2">${escapeHtml(roleText(step.title))}</h2>
          ${step.description ? `<p class="text-gray-500 mb-6">${escapeHtml(roleText(step.description))}</p>` : '<div class="mb-6"></div>'}

          <div class="space-y-8">
            ${step.fields.map((field) => `
              <div data-field-key="${escapeHtml(field.key)}">
                ${renderField(field, answers[field.key])}
                <span data-aos-error="${escapeHtml(field.key)}" class="hidden text-red-500 text-xs font-bold mt-2 block">
                  ${escapeHtml(field.requiredMessage || `Please ${field.type === 'radio' || field.type === 'dropdown' ? 'select' : 'provide'} ${(field.label || field.key).toLowerCase()}.`)}
                </span>
              </div>`).join('')}
          </div>

          <div class="hidden mt-6 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 font-semibold" data-aos-save-error role="alert"></div>

          <div class="flex justify-between items-center mt-10 pt-6 border-t border-gray-200">
            <button type="button" data-aos-back class="text-gray-500 font-semibold hover:text-gray-900 transition ${currentStep === 0 ? 'invisible' : ''}">
              &larr; Back
            </button>
            ${isLast
              ? `<button type="submit" data-aos-next class="px-8 py-3 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-lg shadow transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Complete Setup</button>`
              : `<button type="submit" data-aos-next class="px-8 py-3 bg-green-600 hover:bg-green-700 text-white font-bold rounded-lg shadow transition cursor-pointer">Continue &rarr;</button>`}
          </div>
        </div>`;
      container.querySelector('[data-aos-root]').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // draftsQueued comes back from update-assistant-context, which now tops up the draft queue on
    // save instead of leaving the first drafts to the next cron tick. Say the number: "everything it
    // needs to get to work" is a promise with no evidence, and the user's next screen is an empty
    // queue that looks identical whether the assistant started or silently didn't.
    function renderSuccess(draftsQueued) {
      progressEl.style.width = '100%';

      // Preferred: an in-character welcome from the assistant itself — says hi, introduces its
      // role, states what it is ALREADY doing, and points at the Chat button so the user knows
      // what to do next (the old terse "Setup complete!" left them guessing). buildCardHtml
      // carries its own Chat + Workspace buttons, so this screen is now a deliberate hand-off
      // the user acts on rather than an auto-redirect that pre-empts the message.
      if (window.AssistantWelcomeMessages && assistantId != null) {
        formEl.innerHTML = `<div class="step-active py-2">${window.AssistantWelcomeMessages.buildCardHtml({
          assistantId,
          roleKey,
          roleLabel,
          assistantName,
          draftsQueued,
        })}</div>`;
        return;
      }

      // Fallback (welcome module not loaded): the original confirmation copy.
      const n = Number(draftsQueued) || 0;
      const started = n > 0
        ? `It's already drafting — ${n} post${n === 1 ? '' : 's'} queued for your approval.`
        : 'Your assistant now has everything it needs to get to work.';
      formEl.innerHTML = `
        <div class="step-active text-center py-4">
          <div class="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg class="w-8 h-8 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>
          </div>
          <h2 class="text-3xl font-extrabold text-gray-900 mb-2">Setup complete!</h2>
          <p class="text-gray-500">${started}</p>
        </div>`;
    }

    async function completeSetup() {
      if (saving) return;
      saving = true;
      const nextBtn = formEl.querySelector('[data-aos-next]');
      const saveErrEl = formEl.querySelector('[data-aos-save-error]');
      nextBtn.disabled = true;
      nextBtn.textContent = 'Saving…';
      saveErrEl.classList.add('hidden');

      try {
        const { [NAME_KEY]: chosenName, ...contextAnswers } = answers;
        const newName = typeof chosenName === 'string' ? chosenName.trim() : '';
        const res = await fetch(SAVE_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assistantId,
            newContext: { ...contextAnswers, completedAt: new Date().toISOString() },
            ...(newName && newName !== originalName ? { newName } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && data.code === 'NAME_TAKEN') {
          const err = new Error(data.error);
          err.userMessage = data.error;
          throw err;
        }
        if (!res.ok || !data.success) throw new Error(data.error || `Save failed (${res.status})`);

        if (newName) assistantName = newName;
        renderSuccess(data.draftsQueued);
        if (typeof onComplete === 'function') onComplete({ ...contextAnswers, assistantName, draftsQueued: data.draftsQueued || 0 });
      } catch (err) {
        console.error('[AssistantOnboardingShell] save failed:', err);
        saveErrEl.textContent = err?.userMessage || "We couldn't save your setup — please check your connection and try again.";
        saveErrEl.classList.remove('hidden');
        nextBtn.disabled = false;
        nextBtn.textContent = 'Complete Setup';
      } finally {
        saving = false;
      }
    }

    let checkingName = false;
    async function onSubmit(e) {
      e.preventDefault();
      if (!validateCurrentStep() || checkingName) return;
      const input = nameInput();
      if (input) {
        checkingName = true;
        const ok = await nameIsAvailable(input.value.trim());
        checkingName = false;
        formEl.querySelector('[data-aos-name-taken]')?.classList.toggle('hidden', ok);
        if (!ok) { input.focus(); return; }
      }
      captureCurrentStep();
      if (currentStep === steps.length - 1) {
        completeSetup();
      } else {
        currentStep++;
        renderStep();
      }
    }

    function onClick(e) {
      if (e.target.closest('[data-aos-suggest-name]')) { suggestNames(); return; }
      const theme = e.target.closest('[data-aos-name-theme]');
      if (theme) { suggestNames(theme.getAttribute('data-aos-name-theme')); return; }
      const pick = e.target.closest('[data-aos-pick-name]');
      if (pick) { applyName(pick.getAttribute('data-aos-pick-name')); return; }
      if (e.target.closest('[data-aos-back]') && currentStep > 0 && !saving) {
        captureCurrentStep();
        currentStep--;
        renderStep();
      }
    }

    formEl.addEventListener('submit', onSubmit);
    formEl.addEventListener('click', onClick);
    renderStep();

    return {
      getFormState() {
        captureCurrentStep();
        return { ...answers };
      },
      destroy() {
        formEl.removeEventListener('submit', onSubmit);
        formEl.removeEventListener('click', onClick);
        container.innerHTML = '';
      },
    };
  }

  window.AssistantOnboardingShell = { mount };
})();
