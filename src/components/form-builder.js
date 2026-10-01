// src/components/form-builder.js — the visual sign-up form builder (Mode B of docs/form-builder-plan.md).
//
//   window.FormBuilder.open({ form, assistantId, onSaved })
//     form: an audience_forms row from GET /audience-forms (it always carries a resolved
//           `definition`), or null for a new form.
//
// It edits ONE FormDefinition (src/utils/form-definition.ts) — the same JSON the chat writes and the
// renderer draws — and saves the whole thing through audience-forms `save` / `create`, where it is
// normalised and checked again. The live preview is window.BmsForm (subscribe.js): the SAME renderer
// the customer's website and the hosted page use, so the preview cannot disagree with them.
//
// ⚠️ THREE RULES, each from an incident elsewhere in this app:
//  • The dialog is attached to <body>, not inside a view section — a modal whose ancestor is
//    display:none "opens" and shows nothing.
//  • Handlers are bound ONCE, on the dialog, by delegation. Nothing binds from a render function; a
//    render path with an early return is how a button renders and does nothing.
//  • Typing never repaints the panel (that would steal focus mid-word) — inputs write straight into
//    the definition and only the PREVIEW redraws. Structural changes (add, remove, reorder, retype)
//    repaint the panel, and never while a drag is in progress.
(function () {
  'use strict';

  const FORMS_API = '/.netlify/functions/audience-forms';
  const SEG_API = '/.netlify/functions/audience-segments';
  const SEQ_API = '/.netlify/functions/newsletter-sequences';
  const ASSETS_API = '/.netlify/functions/content-assets';
  const MAX_FIELDS = 12;

  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const $ = (id) => document.getElementById(id);
  const uid = () => 'f_' + Math.random().toString(36).slice(2, 12);

  const PALETTE = [
    { key: 'first_name', label: 'First name', make: () => ({ type: 'text', label: 'First name', target: { kind: 'contact', column: 'first_name' } }) },
    { key: 'last_name', label: 'Last name', make: () => ({ type: 'text', label: 'Last name', target: { kind: 'contact', column: 'last_name' } }) },
    { key: 'company', label: 'Company', make: () => ({ type: 'text', label: 'Company', target: { kind: 'contact', column: 'company' } }) },
    { key: 'phone', label: 'Phone', make: () => ({ type: 'phone', label: 'Phone', target: { kind: 'contact', column: 'phone' } }) },
    { key: 'text', label: 'Short answer', make: () => ({ type: 'text', label: 'Your question', target: { kind: 'custom', key: '' } }) },
    { key: 'textarea', label: 'Long answer', make: () => ({ type: 'textarea', label: 'Your question', target: { kind: 'custom', key: '' } }) },
    { key: 'select', label: 'Dropdown', make: () => ({ type: 'select', label: 'Your question', options: opts(['Option 1', 'Option 2']), target: { kind: 'custom', key: '' } }) },
    { key: 'radio', label: 'Multiple choice', make: () => ({ type: 'radio', label: 'Your question', options: opts(['Option 1', 'Option 2']), target: { kind: 'custom', key: '' } }) },
    { key: 'checkbox', label: 'Checkboxes', make: () => ({ type: 'checkbox', label: 'Your question', options: opts(['Option 1', 'Option 2']), target: { kind: 'tag' } }) },
  ];
  const TYPE_LABELS = { email: 'Email', text: 'Short answer', textarea: 'Long answer', phone: 'Phone', select: 'Dropdown', radio: 'Multiple choice', checkbox: 'Checkboxes' };
  const CONTACT_LABELS = { first_name: 'First name', last_name: 'Last name', company: 'Company', phone: 'Phone' };
  function opts(labels) { return labels.map((l) => ({ value: l, label: l })); }

  /** A short snake_case key from a label — the server re-checks it against the DB constraint. */
  function keyFrom(label) {
    const k = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return /^[a-z]/.test(k) ? k : (k ? 'q_' + k : '');
  }

  let S = null;   // the open builder's state

  function blankDefinition() {
    return {
      version: 1, name: 'New sign-up form', purpose: 'newsletter',
      content: { headline: '', intro: '', buttonLabel: 'Subscribe', successMessage: '', redirectUrl: null },
      fields: [{ id: 'f_email', type: 'email', label: 'Email', placeholder: '', help: '', required: true, options: [], target: { kind: 'contact', column: 'email' } }],
      consent: { text: 'By subscribing you agree to receive email updates. You can unsubscribe at any time.', requireCheckbox: false },
      style: { accent: '#059669', background: '#ffffff', text: '#111827', pageBackground: '#f9fafb', font: 'system', radius: 'small', layout: 'stacked', logo: null, useBrandKit: true },
      delivery: { embed: { enabled: true, allowedOrigins: null }, hosted: { enabled: false, slug: null } },
      audience: { doubleOptIn: true, segmentId: null, tags: [] },
      campaign: { sequenceId: null, skipWelcome: false },
    };
  }

  // ── Opening ────────────────────────────────────────────────────────────────

  function open(opts) {
    opts = opts || {};
    ensureModal();
    const form = opts.form || null;
    S = {
      formId: form ? form.id : null,
      publicKey: form ? form.publicKey : null,
      // A brand-new form is live on first save; one saved from a chat card arrives switched off and
      // goes live only when somebody ticks this, having seen it.
      status: form ? form.status : 'active',
      def: JSON.parse(JSON.stringify((form && form.definition) || blankDefinition())),
      assistantId: opts.assistantId || null,
      onSaved: opts.onSaved || null,
      tab: 'questions',
      openField: null,
      previewAs: 'hosted',
      segments: [], sequences: [], images: [],
      slugState: null,
      dragFrom: null,
      dirty: false,
    };
    $('fb-name').value = S.def.name || '';
    $('fb-live').checked = S.status === 'active';
    $('fb-warnings').innerHTML = '';
    show($('fb-modal'), 'flex');
    renderPanel();
    renderPreview();
    loadLists();
  }

  async function loadLists() {
    const get = (url) => fetch(url, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    const [seg, seq, assets] = await Promise.all([get(SEG_API), get(SEQ_API), get(ASSETS_API)]);
    if (!S) return;
    S.segments = (seg.segments || []).filter((x) => x.kind !== 'tag' && x.kind !== 'dynamic');
    S.sequences = (seq.sequences || []).filter((x) => x.triggerEvent === 'form');
    const groups = assets.assets || {};
    S.images = [].concat(groups.pending || [], groups.scheduled || [], groups.posted || [])
      .filter((a) => a.assetType === 'image' && (a.storageUrl || a.externalUrl))
      .map((a) => ({ id: a.id, url: a.storageUrl || a.externalUrl, name: a.name || '' }));
    if (S.tab === 'after' || S.tab === 'look') renderPanel();
    renderPreview();
  }

  function close(force) {
    if (!force && S && S.dirty && !window.confirm('Close without saving your changes?')) return;
    hide($('fb-modal'));
    S = null;
  }

  // ── The dialog (built once) ────────────────────────────────────────────────

  function show(el, d) { if (el) { el.classList.remove('hidden'); el.style.display = d || 'block'; } }
  function hide(el) { if (el) { el.classList.add('hidden'); el.style.display = 'none'; } }

  function ensureModal() {
    if ($('fb-modal')) return;
    const m = document.createElement('div');
    m.id = 'fb-modal';
    m.className = 'hidden fixed inset-0 z-50 items-center justify-center p-4';
    m.style.display = 'none';
    m.innerHTML = `
      <div class="absolute inset-0 bg-black/40" data-fb-close></div>
      <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden">
        <div class="flex items-center gap-3 px-6 py-4 border-b border-gray-200">
          <input id="fb-name" maxlength="80" aria-label="Form name"
            class="flex-1 min-w-0 text-lg font-extrabold text-gray-900 px-2 py-1 rounded-lg border border-transparent hover:border-gray-200 focus:border-gray-300 outline-none">
          <label class="flex items-center gap-2 text-sm font-bold text-gray-700 cursor-pointer" title="A form that is off shows nothing on your website or its page">
            <input type="checkbox" id="fb-live"> <span data-explain="form-live">Live</span>
          </label>
          <button type="button" data-fb-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 cursor-pointer">Cancel</button>
          <button type="button" id="fb-save" class="px-4 py-2 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Save form</button>
          <button type="button" data-fb-close aria-label="Close" class="p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 cursor-pointer">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div id="fb-warnings"></div>
        <div class="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2">
          <div class="min-h-0 overflow-auto border-r border-gray-100">
            <div class="flex gap-1 px-6 pt-4 border-b border-gray-100" role="tablist" id="fb-tabs"></div>
            <div id="fb-panel" class="p-6"></div>
          </div>
          <div class="min-h-0 overflow-auto bg-gray-50 p-6">
            <div class="flex items-center justify-between mb-3">
              <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">Preview</p>
              <div class="flex gap-1" id="fb-preview-as"></div>
            </div>
            <!-- The form IN CONTEXT, so the two previews look as different as the two places are: our
                 hosted page in a browser window, or the form sitting inside a page of their website. -->
            <div class="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
              <div id="fb-preview-bar" class="flex items-center gap-2 px-3 py-2 bg-gray-100 border-b border-gray-200"></div>
              <div id="fb-preview-frame" class="p-6">
                <div id="fb-preview-above"></div>
                <div id="fb-preview"></div>
                <div id="fb-preview-below"></div>
              </div>
            </div>
            <p id="fb-preview-note" class="text-[11px] text-gray-400 mt-3"></p>
          </div>
        </div>
      </div>`;
    document.body.appendChild(m);

    // ── Delegated handlers, bound once ──
    m.addEventListener('click', onClick);
    m.addEventListener('input', onInput);
    m.addEventListener('change', onInput);
    m.addEventListener('dragstart', onDragStart);
    m.addEventListener('dragover', (e) => { if (S && S.dragFrom != null && e.target.closest('[data-fb-row]')) e.preventDefault(); });
    m.addEventListener('drop', onDrop);
    m.addEventListener('dragend', () => { if (S) S.dragFrom = null; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S) close(false); });
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  const TABS = [['questions', 'Questions'], ['look', 'Look'], ['words', 'Words'], ['share', 'Sharing'], ['after', 'After sign-up']];

  function renderPanel() {
    if (!S) return;
    $('fb-tabs').innerHTML = TABS.map(([k, l]) => `<button type="button" role="tab" data-fb-tab="${k}" aria-selected="${S.tab === k}"
      class="px-3 py-2 text-sm font-bold border-b-2 cursor-pointer ${S.tab === k ? 'border-emerald-600 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800'}">${l}</button>`).join('');
    $('fb-preview-as').innerHTML = [['hosted', 'Sign-up page'], ['embed', 'On your website']].map(([k, l]) =>
      `<button type="button" data-fb-preview-as="${k}" class="px-2.5 py-1 text-xs font-bold rounded-lg cursor-pointer ${S.previewAs === k ? 'bg-white border border-gray-300 text-gray-900' : 'text-gray-500 hover:text-gray-800'}">${l}</button>`).join('');
    const p = $('fb-panel');
    p.innerHTML = S.tab === 'questions' ? panelQuestions()
      : S.tab === 'look' ? panelLook()
      : S.tab === 'words' ? panelWords()
      : S.tab === 'share' ? panelShare()
      : panelAfter();
  }

  // `slug` = an explainers.js glossary key: the 🦢 info icon beside the label, with plain-English help
  // on hover or tap. Every setting in the builder carries one.
  const label = (t, slug) => `<label class="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1"${slug ? ` data-explain="${slug}"` : ''}>${t}</label>`;
  const input = (attrs, value) => `<input ${attrs} value="${esc(value ?? '')}" class="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm mb-4">`;

  function targetLabel(f) {
    const t = f.target || {};
    if (t.kind === 'contact') return t.column === 'email' ? 'Contact email' : `Contact · ${CONTACT_LABELS[t.column] || t.column}`;
    if (t.kind === 'tag') return 'Tags the contact';
    return `Your field · ${t.key || keyFrom(f.label) || '—'}`;
  }

  function panelQuestions() {
    const d = S.def;
    const usedCols = new Set(d.fields.filter((f) => f.target && f.target.kind === 'contact').map((f) => f.target.column));
    const full = d.fields.length >= MAX_FIELDS;
    const rows = d.fields.map((f, i) => {
      const openRow = S.openField === f.id;
      return `
      <div data-fb-row="${i}" class="rounded-xl border ${openRow ? 'border-emerald-400' : 'border-gray-200'} bg-white mb-2">
        <div class="flex items-center gap-2 px-3 py-2">
          <span draggable="true" data-fb-drag="${i}" title="Drag to reorder" class="cursor-move text-gray-400 select-none px-1" aria-hidden="true">⋮⋮</span>
          <button type="button" data-fb-open="${esc(f.id)}" class="flex-1 min-w-0 text-left cursor-pointer">
            <span class="block text-sm font-bold text-gray-900 truncate">${esc(f.label)}${f.required ? ' <span class="text-red-600">*</span>' : ''}</span>
            <span class="block text-[11px] text-gray-500">${esc(TYPE_LABELS[f.type] || f.type)} · ${esc(targetLabel(f))}</span>
          </button>
          <button type="button" data-fb-move="${i}" data-dir="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''} class="p-1 text-gray-400 hover:text-gray-800 cursor-pointer disabled:opacity-30">↑</button>
          <button type="button" data-fb-move="${i}" data-dir="1" aria-label="Move down" ${i === d.fields.length - 1 ? 'disabled' : ''} class="p-1 text-gray-400 hover:text-gray-800 cursor-pointer disabled:opacity-30">↓</button>
          ${f.type === 'email' ? '<span class="w-6"></span>' : `<button type="button" data-fb-remove="${i}" aria-label="Remove question" class="p-1 text-gray-400 hover:text-red-600 cursor-pointer">✕</button>`}
        </div>
        ${openRow ? inspector(f, i) : ''}
      </div>`;
    }).join('');
    return `
      <p class="text-sm text-gray-500 mb-4">Ask only what you need — every extra question costs sign-ups. Email is always included.</p>
      <div id="fb-rows">${rows}</div>
      <p class="text-xs font-bold text-gray-500 uppercase tracking-wide mt-5 mb-2"><span data-explain="form-add-question">Add a question</span> ${full ? `<span class="normal-case font-normal">— a form holds at most ${MAX_FIELDS}</span>` : ''}</p>
      <div class="flex flex-wrap gap-2">${PALETTE.map((p) => {
        const off = full || (CONTACT_LABELS[p.key] && usedCols.has(p.key));
        return `<button type="button" data-fb-add="${p.key}" ${off ? 'disabled' : ''} class="px-3 py-1.5 text-xs font-bold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">+ ${p.label}</button>`;
      }).join('')}</div>`;
  }

  function inspector(f, i) {
    const isChoice = f.type === 'select' || f.type === 'radio' || f.type === 'checkbox';
    const t = f.target || {};
    const where = t.kind === 'contact' ? 'contact' : t.kind === 'tag' ? 'tag' : 'custom';
    return `
      <div class="px-3 pb-3 pt-1 border-t border-gray-100">
        ${label('Question', 'form-q-label')}${input(`data-fb-f="${i}" data-k="label" maxlength="80"`, f.label)}
        ${f.type === 'checkbox' && (f.options || []).length <= 1 ? '' : `${label('Placeholder', 'form-q-placeholder')}${input(`data-fb-f="${i}" data-k="placeholder" maxlength="120"`, f.placeholder)}`}
        ${label('Help text', 'form-q-help')}${input(`data-fb-f="${i}" data-k="help" maxlength="200"`, f.help)}
        ${f.type === 'email' ? '' : `<label class="flex items-center gap-2 text-sm text-gray-700 mb-4 cursor-pointer"><input type="checkbox" data-fb-f="${i}" data-k="required" ${f.required ? 'checked' : ''}> <span data-explain="form-q-required">Required</span></label>`}
        ${isChoice ? `${label('Choices — one per line', 'form-q-choices')}<textarea data-fb-f="${i}" data-k="options" rows="4" class="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm mb-4">${esc((f.options || []).map((o) => o.label).join('\n'))}</textarea>` : ''}
        ${f.type === 'email' || where === 'contact' ? '' : `
          ${label('Save the answer as', 'form-q-saves-to')}
          <select data-fb-f="${i}" data-k="where" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm mb-2">
            <option value="custom" ${where === 'custom' ? 'selected' : ''}>A field on the contact</option>
            ${isChoice ? `<option value="tag" ${where === 'tag' ? 'selected' : ''}>Tags on the contact (each choice becomes a tag)</option>` : ''}
          </select>
          ${where === 'custom' ? `<p class="text-[11px] text-gray-400 mb-2">Saved as <span class="font-mono">${esc(t.key || keyFrom(f.label) || '—')}</span> — you can filter and personalise on it.</p>` : ''}`}
      </div>`;
  }

  function colour(k, v, title) {
    const slug = { accent: 'form-colour-button', text: 'form-colour-text', background: 'form-colour-background', pageBackground: 'form-colour-page' }[k];
    return `<label class="flex items-center gap-2 text-sm text-gray-700 mb-3"><input type="color" data-fb-style="${k}" value="${esc(v)}" class="w-9 h-9 rounded border border-gray-300 cursor-pointer"> <span${slug ? ` data-explain="${slug}"` : ''}>${title}</span></label>`;
  }
  function choice(k, value, options) {
    return `<select data-fb-style="${k}" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm mb-4">${options.map(([v, l]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  }

  function panelLook() {
    const s = S.def.style;
    const logo = s.logo && S.images.find((x) => Number(x.id) === Number(s.logo.assetId));
    return `
      <label class="flex items-start gap-2 text-sm text-gray-700 mb-4 cursor-pointer">
        <input type="checkbox" data-fb-style="useBrandKit" ${s.useBrandKit ? 'checked' : ''} class="mt-0.5">
        <span><span class="font-bold" data-explain="form-match-brand">Match my brand</span><span class="block text-[11px] text-gray-500">The button colour follows your brand kit. Pick a colour below to override it.</span></span>
      </label>
      <div class="grid grid-cols-2 gap-x-4">
        ${colour('accent', s.accent, 'Button')}
        ${colour('text', s.text, 'Text')}
        ${colour('background', s.background, 'Form background')}
        ${colour('pageBackground', s.pageBackground, 'Page background')}
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-x-3 mt-2">
        <div>${label('Font', 'form-font')}${choice('font', s.font, [['system', 'Clean'], ['serif', 'Classic'], ['rounded', 'Rounded'], ['mono', 'Typewriter'], ['inherit', 'My website\'s font']])}</div>
        <div>${label('Corners', 'form-corners')}${choice('radius', s.radius, [['none', 'Square'], ['small', 'Rounded'], ['large', 'Very rounded']])}</div>
        <div>${label('Layout', 'form-layout')}${choice('layout', s.layout, [['stacked', 'Stacked'], ['inline', 'One line (email only)']])}</div>
      </div>
      ${label('Logo', 'form-logo')}
      ${logo ? `<div class="flex items-center gap-3 mb-3"><img src="${esc(logo.url)}" alt="" class="h-10 max-w-[10rem] object-contain rounded border border-gray-200 bg-white"><button type="button" data-fb-logo="" class="text-xs font-bold text-red-600 cursor-pointer">Remove</button></div>`
        : s.logo ? '<p class="text-xs text-gray-500 mb-3">Logo chosen. <button type="button" data-fb-logo="" class="font-bold text-red-600 cursor-pointer">Remove</button></p>' : ''}
      ${S.images.length
        ? `<p class="text-[11px] text-gray-500 mb-2">From your library:</p><div class="flex flex-wrap gap-2">${S.images.slice(0, 24).map((x) => `<button type="button" data-fb-logo="${x.id}" title="${esc(x.name)}" class="w-14 h-14 rounded-lg border ${s.logo && Number(s.logo.assetId) === Number(x.id) ? 'border-emerald-500' : 'border-gray-200'} bg-white overflow-hidden cursor-pointer"><img src="${esc(x.url)}" alt="" class="w-full h-full object-contain"></button>`).join('')}</div>`
        : '<p class="text-[11px] text-gray-400">Upload your logo on the Assets page and it will appear here.</p>'}`;
  }

  function panelWords() {
    const c = S.def.content;
    return `
      ${label('Headline', 'form-headline')}${input('data-fb-content="headline" maxlength="120" placeholder="Get the monthly guide"', c.headline)}
      ${label('A line or two about what people get', 'form-intro')}<textarea data-fb-content="intro" rows="3" maxlength="600" class="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm mb-4">${esc(c.intro)}</textarea>
      ${label('Button', 'form-button-label')}${input('data-fb-content="buttonLabel" maxlength="40"', c.buttonLabel)}
      ${label('Consent sentence', 'form-consent')}<textarea data-fb-consent="text" rows="2" maxlength="500" class="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm mb-2">${esc(S.def.consent.text)}</textarea>
      <p class="text-[11px] text-gray-400 -mt-1 mb-2">Shown beside the button, and kept with every sign-up as the record of what they agreed to.</p>
      <label class="flex items-center gap-2 text-sm text-gray-700 mb-4 cursor-pointer"><input type="checkbox" data-fb-consent="requireCheckbox" ${S.def.consent.requireCheckbox ? 'checked' : ''}> <span data-explain="form-consent-checkbox">They must tick a box to agree</span></label>
      ${label('Message after signing up', 'form-success')}${input('data-fb-content="successMessage" maxlength="300" placeholder="Leave blank for the standard message"', c.successMessage)}
      ${label('Or send them to a page (optional)', 'form-redirect')}${input('data-fb-content="redirectUrl" maxlength="500" placeholder="https://…"', c.redirectUrl || '')}`;
  }

  function panelShare() {
    const d = S.def.delivery;
    const origin = location.origin;
    const snippet = S.publicKey
      ? `<div id="bms-subscribe"></div>\n<script async src="${origin}/subscribe.js"\n        data-bms-form="${S.publicKey}" data-bms-mount="#bms-subscribe"><\/script>`
      : '';
    const slugNote = `<p id="fb-slug-note" class="text-[11px] mb-3 ${S.slugState && S.slugState.available ? 'text-emerald-700' : 'text-red-600'}">${S.slugState ? esc(S.slugState.available ? 'That address is free.' : S.slugState.reason) : ''}</p>`;
    return `
      <label class="flex items-start gap-2 text-sm text-gray-700 mb-2 cursor-pointer">
        <input type="checkbox" data-fb-delivery="embed" ${d.embed.enabled ? 'checked' : ''} class="mt-0.5">
        <span><span class="font-bold" data-explain="form-on-website">On my website</span><span class="block text-[11px] text-gray-500">You get a short piece of code to paste into your website (Squarespace, WordPress, Wix or any site that accepts an embed code) — the form appears wherever you paste it.</span></span>
      </label>
      ${d.embed.enabled ? (snippet
        ? `<textarea readonly rows="3" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-xs font-mono bg-gray-50 mb-2">${esc(snippet)}</textarea>
           <button type="button" data-fb-copy="snippet" class="px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer mb-3">Copy website code</button>`
        : '<p class="text-[11px] text-gray-500 mb-3">Save the form to get the code for your website.</p>')
        + `${label('Only these websites may use it (one per line — blank for any)', 'form-allowed-websites')}<textarea data-fb-origins rows="2" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm mb-5" placeholder="https://www.example.com">${esc((d.embed.allowedOrigins || []).join('\n'))}</textarea>` : '<div class="mb-5"></div>'}
      <label class="flex items-start gap-2 text-sm text-gray-700 mb-2 cursor-pointer">
        <input type="checkbox" data-fb-delivery="hosted" ${d.hosted.enabled ? 'checked' : ''} class="mt-0.5">
        <span><span class="font-bold" data-explain="form-own-page">Its own page on Be More Swan</span><span class="block text-[11px] text-gray-500">For when you have no website, or want a link to share: we host a page with just this form on it. Put the link in your Instagram bio, a link tree, an email signature, or behind a QR code on a poster.</span></span>
      </label>
      ${d.hosted.enabled ? `
        ${label('Page address', 'form-page-address')}
        <div class="flex items-center gap-1 mb-1"><span class="text-sm text-gray-500 shrink-0">${esc(location.host)}/f/</span>
          <input data-fb-slug maxlength="48" value="${esc(d.hosted.slug || '')}" placeholder="your-form" class="flex-1 min-w-0 px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none text-sm"></div>
        ${slugNote}
        ${S.publicKey ? (() => {
          const link = d.hosted.slug ? `${origin}/f/${d.hosted.slug}` : `${origin}/s/${S.publicKey}`;
          return `<div class="flex items-center gap-2 mb-3">
              <input readonly value="${esc(link)}" class="flex-1 min-w-0 px-3 py-2 rounded-lg border border-gray-300 text-xs font-mono bg-gray-50">
              <button type="button" data-fb-copy="link" data-link="${esc(link)}" class="px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Copy link</button>
              <a href="${esc(link)}" target="_blank" rel="noopener" class="px-2 py-1.5 text-xs font-bold text-emerald-700 hover:text-emerald-800">Open ↗</a>
            </div>
            ${S.status !== 'active' ? '<p class="text-[11px] text-amber-700 mb-3">The page shows nothing until the form is Live (top right).</p>' : ''}`;
        })() : '<p class="text-[11px] text-gray-500 mb-3">Save the form to get its link.</p>'}` : ''}`;
  }

  function panelAfter() {
    const a = S.def.audience, c = S.def.campaign;
    return `
      <label class="flex items-start gap-2 text-sm text-gray-700 mb-4 cursor-pointer">
        <input type="checkbox" data-fb-aud="doubleOptIn" ${a.doubleOptIn ? 'checked' : ''} class="mt-0.5">
        <span><span class="font-bold" data-explain="form-double-opt-in">Ask them to confirm by email</span><span class="block text-[11px] text-gray-500">Recommended. Only people who click the link are subscribed — it keeps typos and fake sign-ups off your list.</span></span>
      </label>
      ${label('Add them to a segment', 'form-segment')}
      <select data-fb-aud="segmentId" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm mb-4">
        <option value="">None</option>
        ${S.segments.map((x) => `<option value="${x.id}" ${Number(a.segmentId) === Number(x.id) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select>
      ${label('Tag everyone who signs up (comma-separated)', 'form-tags')}${input('data-fb-aud="tags" maxlength="400" placeholder="e.g. pricing-guide, spring-event"', (a.tags || []).join(', '))}
      ${label('Start an email campaign', 'form-campaign')}
      <select data-fb-campaign="sequenceId" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm mb-2">
        <option value="">None — new sign-ups get your welcome sequence</option>
        ${S.sequences.map((x) => `<option value="${x.id}" ${Number(c.sequenceId) === Number(x.id) ? 'selected' : ''}>${esc(x.name)}${x.isEnabled ? '' : ' (switched off)'}</option>`).join('')}
      </select>
      ${c.sequenceId ? `<label class="flex items-center gap-2 text-sm text-gray-700 mb-2 cursor-pointer"><input type="checkbox" data-fb-campaign="skipWelcome" ${c.skipWelcome ? 'checked' : ''}> <span data-explain="form-skip-welcome">Send this INSTEAD of the welcome sequence</span></label>` : ''}
      <p class="text-[11px] text-gray-400">${S.sequences.length
        ? 'Campaigns listed here start when someone fills in a form. Create one in the Email Studio with “New email campaign” → “People who fill in a form”.'
        : 'No form campaigns yet. Create one in the Email Studio: “New email campaign” → “People who fill in a form”.'}</p>`;
  }

  // ── Preview ────────────────────────────────────────────────────────────────

  let previewTimer = null;
  function renderPreview() {
    if (!S || !window.BmsForm) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (!S) return;
      const d = S.def;
      const img = d.style.logo && S.images.find((x) => Number(x.id) === Number(d.style.logo.assetId));
      const frame = $('fb-preview-frame');
      const hosted = S.previewAs === 'hosted';
      frame.style.background = hosted ? (/^#[0-9a-f]{6}$/i.test(d.style.pageBackground) ? d.style.pageBackground : '#f9fafb') : '#ffffff';
      const dot = (c) => `<span class="w-2.5 h-2.5 rounded-full" style="background:${c}"></span>`;
      const dots = dot('#fca5a5') + dot('#fcd34d') + dot('#86efac');
      const pageAddr = d.delivery.hosted.slug ? `${location.host}/f/${d.delivery.hosted.slug}` : (S.publicKey ? `${location.host}/s/${S.publicKey}` : `${location.host}/f/your-form`);
      $('fb-preview-bar').innerHTML = dots + `<span class="flex-1 min-w-0 truncate text-[11px] text-gray-500 bg-white border border-gray-200 rounded px-2 py-0.5">${esc(hosted ? pageAddr : 'www.your-website.com')}</span>`;
      // On a website the form is one block among others — grey stand-ins for their own page show that.
      const lines = (n) => Array.from({ length: n }, (_, i) => `<div class="h-2 rounded bg-gray-100 mb-2" style="width:${[92, 78, 85, 60][i % 4]}%"></div>`).join('');
      $('fb-preview-above').innerHTML = hosted ? '' : `<div class="h-4 w-1/3 rounded bg-gray-200 mb-3"></div>${lines(3)}<div class="mb-4"></div>`;
      $('fb-preview-below').innerHTML = hosted ? '' : `<div class="mt-4">${lines(2)}</div>`;
      $('fb-preview-note').textContent = hosted
        ? 'Your sign-up page — the page we host for this form, with its own address. Submitting here sends nothing.'
        : 'On your website — the form appears wherever you paste the code, in your page\'s own font if you choose "My website\'s font". Submitting here sends nothing.';
      window.BmsForm.render({
        content: d.content, fields: d.fields, consent: d.consent,
        style: { ...d.style, logoUrl: null }, senderName: 'Your business',
      }, $('fb-preview'), {
        surface: 'preview', previewAs: S.previewAs, preview: true,
        // The library thumbnail stands in for the logo: an unsaved logo has no signed path yet.
        previewLogoUrl: img ? img.url : null,
      });
    }, 120);
  }

  // ── Editing ────────────────────────────────────────────────────────────────

  function touched() { S.dirty = true; }

  function onClick(e) {
    if (!S) return;
    const t = e.target;
    if (t.closest('[data-fb-close]')) { close(false); return; }
    const tab = t.closest('[data-fb-tab]');
    if (tab) { S.tab = tab.getAttribute('data-fb-tab'); renderPanel(); return; }
    const pa = t.closest('[data-fb-preview-as]');
    if (pa) { S.previewAs = pa.getAttribute('data-fb-preview-as'); renderPanel(); renderPreview(); return; }
    const add = t.closest('[data-fb-add]');
    if (add && !add.disabled) {
      const p = PALETTE.find((x) => x.key === add.getAttribute('data-fb-add'));
      if (!p || S.def.fields.length >= MAX_FIELDS) return;
      const f = Object.assign({ id: uid(), placeholder: '', help: '', required: false, options: [] }, p.make());
      if (f.target.kind === 'custom') f.target.key = '';
      S.def.fields.push(f);
      S.openField = f.id;
      touched(); renderPanel(); renderPreview();
      return;
    }
    const openBtn = t.closest('[data-fb-open]');
    if (openBtn) { const id = openBtn.getAttribute('data-fb-open'); S.openField = S.openField === id ? null : id; renderPanel(); return; }
    const mv = t.closest('[data-fb-move]');
    if (mv && !mv.disabled) { move(Number(mv.getAttribute('data-fb-move')), Number(mv.getAttribute('data-dir'))); return; }
    const rm = t.closest('[data-fb-remove]');
    if (rm) { S.def.fields.splice(Number(rm.getAttribute('data-fb-remove')), 1); touched(); renderPanel(); renderPreview(); return; }
    const logo = t.closest('[data-fb-logo]');
    if (logo) {
      const id = Number(logo.getAttribute('data-fb-logo'));
      S.def.style.logo = id ? { assetId: id } : null;
      touched(); renderPanel(); renderPreview();
      return;
    }
    const cp = t.closest('[data-fb-copy]');
    if (cp) {
      const isLink = cp.getAttribute('data-fb-copy') === 'link';
      const text = isLink ? cp.getAttribute('data-link') : ($('fb-panel').querySelector('textarea[readonly]') || {}).value;
      if (text) navigator.clipboard?.writeText(text).then(() => window.showToast?.(isLink ? 'Link copied.' : 'Website code copied.'))
        .catch(() => window.prompt('Copy this:', text));
      return;
    }
    if (t.closest('#fb-save')) save();
  }

  function move(i, dir) {
    const j = i + dir;
    const f = S.def.fields;
    if (j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j], f[i]];
    touched(); renderPanel(); renderPreview();
  }

  function onDragStart(e) {
    const h = e.target.closest && e.target.closest('[data-fb-drag]');
    if (!h || !S) return;
    S.dragFrom = Number(h.getAttribute('data-fb-drag'));
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(S.dragFrom)); } catch (err) { /* old browsers */ }
  }

  function onDrop(e) {
    const row = e.target.closest && e.target.closest('[data-fb-row]');
    if (!row || !S || S.dragFrom == null) return;
    e.preventDefault();
    const from = S.dragFrom, to = Number(row.getAttribute('data-fb-row'));
    S.dragFrom = null;
    if (from === to) return;
    const [f] = S.def.fields.splice(from, 1);
    S.def.fields.splice(to, 0, f);
    // ⚠️ Repainted only on DROP. Repainting mid-drag detaches the node under the pointer.
    touched(); renderPanel(); renderPreview();
  }

  let slugTimer = null;
  function onInput(e) {
    if (!S) return;
    const t = e.target;
    const d = S.def;
    if (t.id === 'fb-name') { d.name = t.value; touched(); return; }
    if (t.id === 'fb-live') { S.status = t.checked ? 'active' : 'disabled'; touched(); return; }

    if (t.hasAttribute('data-fb-f')) {
      const f = d.fields[Number(t.getAttribute('data-fb-f'))];
      const k = t.getAttribute('data-k');
      if (!f) return;
      if (k === 'required') f.required = t.checked;
      else if (k === 'options') f.options = opts(t.value.split('\n').map((x) => x.trim()).filter(Boolean)).slice(0, 20);
      else if (k === 'where') { f.target = t.value === 'tag' ? { kind: 'tag' } : { kind: 'custom', key: keyFrom(f.label) }; touched(); renderPanel(); renderPreview(); return; }
      else f[k] = t.value;
      // A custom field's key follows the label until the form is saved once — renaming the
      // question should not leave it saving to "your_question".
      if (k === 'label' && f.target && f.target.kind === 'custom' && !S.formId) f.target.key = keyFrom(t.value);
      touched(); renderPreview();
      if (e.type === 'change' && (k === 'label' || k === 'required')) renderPanel();
      return;
    }
    if (t.hasAttribute('data-fb-style')) {
      const k = t.getAttribute('data-fb-style');
      if (k === 'useBrandKit') d.style.useBrandKit = t.checked;
      else {
        d.style[k] = t.value;
        // Picking a button colour IS overriding the brand kit — say so by unticking it.
        if (k === 'accent' && d.style.useBrandKit) { d.style.useBrandKit = false; renderPanel(); }
      }
      touched(); renderPreview();
      return;
    }
    if (t.hasAttribute('data-fb-content')) { const k = t.getAttribute('data-fb-content'); d.content[k] = k === 'redirectUrl' ? (t.value.trim() || null) : t.value; touched(); renderPreview(); return; }
    if (t.hasAttribute('data-fb-consent')) { const k = t.getAttribute('data-fb-consent'); d.consent[k] = k === 'requireCheckbox' ? t.checked : t.value; touched(); renderPreview(); return; }
    if (t.hasAttribute('data-fb-delivery')) { d.delivery[t.getAttribute('data-fb-delivery')].enabled = t.checked; touched(); renderPanel(); return; }
    if (t.hasAttribute('data-fb-origins')) {
      const list = t.value.split('\n').map((x) => x.trim()).filter(Boolean);
      d.delivery.embed.allowedOrigins = list.length ? list : null;
      touched(); return;
    }
    if (t.hasAttribute('data-fb-slug')) {
      const v = t.value.trim().toLowerCase();
      d.delivery.hosted.slug = v || null;
      touched();
      clearTimeout(slugTimer);
      if (!v) { S.slugState = null; return; }
      slugTimer = setTimeout(() => checkSlug(v), 400);
      return;
    }
    if (t.hasAttribute('data-fb-aud')) {
      const k = t.getAttribute('data-fb-aud');
      if (k === 'doubleOptIn') d.audience.doubleOptIn = t.checked;
      else if (k === 'segmentId') d.audience.segmentId = Number(t.value) || null;
      else if (k === 'tags') d.audience.tags = t.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10);
      touched(); return;
    }
    if (t.hasAttribute('data-fb-campaign')) {
      const k = t.getAttribute('data-fb-campaign');
      if (k === 'sequenceId') {
        d.campaign.sequenceId = Number(t.value) || null;
        // Linking a campaign REPLACES the welcome sequence by default — two series on day one reads as spam.
        d.campaign.skipWelcome = !!d.campaign.sequenceId;
        touched(); renderPanel(); return;
      }
      d.campaign.skipWelcome = t.checked; touched(); return;
    }
  }

  async function checkSlug(slug) {
    try {
      const res = await fetch(FORMS_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ action: 'checkSlug', slug, formId: S && S.formId }),
      });
      const data = await res.json();
      if (!S || (S.def.delivery.hosted.slug || '') !== slug) return;   // they kept typing
      S.slugState = data;
      // Only the note — the input the person is typing in must not be repainted under them.
      const note = $('fb-slug-note');
      if (note) {
        note.className = `text-[11px] mb-3 ${data.available ? 'text-emerald-700' : 'text-red-600'}`;
        note.textContent = data.available ? 'That address is free.' : data.reason;
      }
    } catch { /* the save will say it if the address is taken */ }
  }

  async function save() {
    const btn = $('fb-save');
    btn.disabled = true;
    try {
      const res = await fetch(FORMS_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(S.formId
          ? { action: 'save', id: S.formId, definition: S.def, status: S.status }
          : { action: 'create', definition: S.def, strictSlug: true, assistantId: S.assistantId, status: S.status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not save (HTTP ${res.status}).`);
      const form = data.form;
      S.formId = form.id;
      S.publicKey = form.publicKey;
      S.status = form.status;
      // What the SERVER stored is the truth — it may have changed a colour, a key or the address.
      if (form.definition) S.def = JSON.parse(JSON.stringify(form.definition));
      S.dirty = false;
      const warnings = data.warnings || [];
      $('fb-warnings').innerHTML = warnings.length
        ? `<div class="mx-6 mt-3 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900"><p class="font-bold mb-1">Saved — with a few changes</p><ul class="list-disc pl-5">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
        : '';
      window.showToast?.('Form saved.');
      renderPanel(); renderPreview();
      if (S.onSaved) S.onSaved(form);
    } catch (err) {
      window.showToast?.(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  window.FormBuilder = { open };
})();
