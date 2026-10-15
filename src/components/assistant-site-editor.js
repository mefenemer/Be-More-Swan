/**
 * src/components/assistant-site-editor.js
 * The Website Assistant's Website tab — docs/website-assistant-plan.md §5.3, §5.5.
 *
 * Left: the site — Pages (each page's sections: edit, move, remove, add), Design (colours, font,
 * corners, logo) and Details (business details, footer, menu). Right: the live preview, rendered by
 * the real renderer (site-preview.ts) in desktop or phone width. "Draft my whole site" asks the
 * assistant for a complete first draft (1 task).
 *
 * Backed by netlify/functions/sites.ts — the SAME actions the chat cards call (chat-session.js →
 * site:apply / site:draft). Every change is a typed operation that the server passes through the one
 * gate (site-definition.ts normaliseSiteDefinition); this file never builds HTML for the site itself.
 *
 * The Publish card (step 3a): choose the address (<name>.bemoreswan.site), Publish, take the site
 * offline, and copy an earlier version back into the draft. The live site is a frozen copy — edits
 * here change only the draft until Publish. These are clicks on this card ONLY; the chat cards never
 * send them (sites.ts address / publish / unpublish / restore).
 *
 * ── What this tab may not do ─────────────────────────────────────────────────
 * Publish without a click, or with [placeholders] left (the server refuses those too).
 * Spend without a click: only "Draft my whole site" uses a task, and it says so first.
 *
 * Handlers are bound to `document` once, at load, never from render. Server values are escaped.
 */
(function () {
  const API = '/.netlify/functions/sites';
  const POLL_MS = 5000;

  const TYPE_LABEL = { hero: 'Hero', features: 'Features', steps: 'Steps', text: 'Text', faq: 'Questions', testimonials: 'Testimonials', cta: 'Call to action', contact: 'Contact form', signup: 'Sign-up form', products: 'Products for sale' };
  /** The edit form for each section type — the props the gate accepts (site-definition.ts cleanSection). */
  const FORMS = {
    hero: [
      { k: 'layout', kind: 'select', label: 'Layout', options: [['centered', 'Centred'], ['split', 'Text beside picture'], ['banner', 'Coloured banner']] },
      { k: 'eyebrow', kind: 'text', label: 'Small label above the headline' },
      { k: 'headline', kind: 'text', label: 'Headline', required: true },
      { k: 'subheadline', kind: 'textarea', label: 'Line under the headline' },
      { k: 'primaryCta', kind: 'link', label: 'Main button' },
      { k: 'secondaryCta', kind: 'link', label: 'Second button' },
      { k: 'image', kind: 'image', label: 'Picture' },
    ],
    features: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'items', kind: 'items', label: 'Features', fields: [['title', 'text', 'Title'], ['body', 'textarea', 'Text']] }],
    steps: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'items', kind: 'items', label: 'Steps', fields: [['title', 'text', 'Step'], ['body', 'textarea', 'Text']] }],
    text: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'body', kind: 'textarea', label: 'Text (a blank line starts a new paragraph)', rows: 8, required: true }],
    faq: [{ k: 'heading', kind: 'text', label: 'Heading' },
      { k: 'items', kind: 'items', label: 'Questions', fields: [['q', 'text', 'Question'], ['a', 'textarea', 'Answer']] }],
    testimonials: [{ k: 'heading', kind: 'text', label: 'Heading' },
      { k: 'items', kind: 'items', label: 'Testimonials', fields: [['quote', 'textarea', 'What they said'], ['name', 'text', 'Their name'], ['detail', 'text', 'Business or town']] }],
    cta: [{ k: 'heading', kind: 'text', label: 'Heading', required: true }, { k: 'body', kind: 'textarea', label: 'Text' }, { k: 'button', kind: 'link', label: 'Button', required: true }],
    // Enquiries land on the Enquiries tab and in the owner's email — never in the Audience.
    contact: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'askPhone', kind: 'checkbox', label: 'Ask for a phone number (optional for the visitor)' }, { k: 'buttonLabel', kind: 'text', label: 'Button text' }],
    // One of the workspace's Form Builder forms; its questions, consent and double opt-in come from it.
    signup: [{ k: 'formId', kind: 'formpick', label: 'Sign-up form', required: true }, { k: 'heading', kind: 'text', label: 'Heading (leave empty to use the form\'s own)' },
      { k: 'intro', kind: 'textarea', label: 'Introduction (leave empty to use the form\'s own)' }],
    // Things for sale (step 3c). Prices are typed here in pounds and stored in pence; checkout reads
    // them from the PUBLISHED site. Buy buttons appear once Stripe is connected on the Orders tab.
    products: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'items', kind: 'productItems', label: 'Items' },
      { k: 'collectAddress', kind: 'checkbox', label: 'Ask buyers for a UK delivery address' },
      { k: 'buyLabel', kind: 'text', label: 'Buy button text' }],
  };
  const BLANK = {
    hero: { layout: 'centered', headline: '' }, features: { items: [{ title: '', body: '' }] }, steps: { items: [{ title: '', body: '' }, { title: '', body: '' }] },
    text: { body: '' }, faq: { items: [{ q: '', a: '' }] }, testimonials: { items: [{ quote: '', name: '', detail: '' }] }, cta: { heading: '', button: { label: '', href: '/' } },
    contact: { heading: 'Get in touch', intro: '', askPhone: false, buttonLabel: 'Send message' }, signup: { formId: null },
    products: { heading: 'Shop', items: [{ name: '', description: '', price: null, image: null }], collectAddress: false, buyLabel: 'Buy now' },
  };
  /** Pence → "12.50" for the price box; "" when there is no price. */
  const poundsText = (pence) => (Number.isFinite(pence) && pence !== null ? (pence / 100).toFixed(2).replace(/\.00$/, '') : '');
  /** What was typed ("£12.50", "12", "1,200") → pence, or null when empty or not a number. */
  const toPence = (txt) => {
    const t = String(txt || '').replace(/[£,\s]/g, '');
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };

  const state = {
    assistantId: null, assistantName: null, data: null, loaded: false, loadError: null, rendered: false,
    panel: 'pages', pageId: null, editing: null, device: 'desktop', previewPath: '/', note: null, pollTimer: null, version: 0,
    editingAddress: false, slugTyped: null, versions: null, publishNote: null,
    enquiries: null, enquiryShown: 20, orders: null, orderShown: 20, refreshedPayments: false,
  };

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm';
  const def = () => state.data && state.data.definition;
  const page = () => (def() ? def().pages.find((p) => p.id === state.pageId) || def().pages[0] : null);
  const pathOf = (p) => (p && p.slug ? `/${p.slug}` : '/');

  // ── Server ─────────────────────────────────────────────────────────────────
  async function post(payload) {
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
    return data;
  }

  async function load() {
    if (!state.assistantId) return;
    try {
      state.data = await post({ action: 'get', assistantId: state.assistantId });
      state.loadError = null;
      // Back from Stripe's onboarding (or part-way through it): ask Stripe once for the latest.
      if (state.data.payments && state.data.payments.connected && !state.data.payments.chargesEnabled && !state.refreshedPayments) {
        state.refreshedPayments = true;
        try { state.data = await post({ action: 'payments_refresh', assistantId: state.assistantId }); } catch { /* shown as not finished */ }
      }
      if (!state.pageId || !def().pages.some((p) => p.id === state.pageId)) state.pageId = def().pages[0].id;
    } catch (err) {
      state.loadError = err.message;
    }
    state.loaded = true;
    state.version++;
    rerender();
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (state.data && state.data.site.drafting) state.pollTimer = setTimeout(load, POLL_MS);
  }

  async function apply(ops, done) {
    try {
      state.data = await post({ action: 'apply', assistantId: state.assistantId, ops });
      state.version++;
      state.publishNote = null;
      state.note = (state.data.warnings || []).length ? { text: state.data.warnings.join(' '), tone: 'warn' } : { text: 'Saved.', tone: 'ok' };
      if (done) done();
    } catch (err) {
      state.note = { text: err.message, tone: 'error' };
    }
    rerender();
  }

  /** Publish-card actions: same response shape as get/apply, so the whole tab refreshes from it. */
  async function publishAction(payload, okText, done) {
    try {
      state.data = await post({ ...payload, assistantId: state.assistantId });
      state.version++;
      state.publishNote = { text: okText, tone: 'ok' };
      if (done) done();
    } catch (err) {
      state.publishNote = { text: err.message, tone: 'error' };
    }
    rerender();
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function card(inner, extra = '') { return `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 ${extra}">${inner}</div>`; }
  const btn = (attrs, label, primary) => `<button type="button" ${attrs} class="${primary ? 'btn-primary' : 'btn-secondary border'} px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50">${label}</button>`;

  function noteHtml() {
    if (!state.note) return '';
    const cls = state.note.tone === 'error' ? 'text-red-600' : state.note.tone === 'warn' ? 'text-amber-800' : 'text-green-700';
    return `<p class="text-xs font-semibold ${cls} mt-3">${esc(state.note.text)}</p>`;
  }

  function sectionSummary(s) {
    const p = s.props;
    return p.headline || p.heading || (p.items && p.items[0] && (p.items[0].title || p.items[0].q || p.items[0].name)) || (p.body || '').slice(0, 60) || '';
  }

  function fieldHtml(f, value) {
    const name = `f-${f.k}`;
    const req = f.required ? ' <span class="text-red-500">*</span>' : '';
    if (f.kind === 'text') return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}${req}</label><input name="${name}" class="${inputCls}" value="${esc(value || '')}">`;
    if (f.kind === 'textarea') return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}${req}</label><textarea name="${name}" rows="${f.rows || 3}" class="${inputCls}">${esc(value || '')}</textarea>`;
    if (f.kind === 'select') return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</label><select name="${name}" class="${inputCls}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    if (f.kind === 'checkbox') return `<label class="flex items-center gap-2 text-xs font-bold text-gray-700 mt-3"><input type="checkbox" name="${name}" ${value ? 'checked' : ''}> ${esc(f.label)}</label>`;
    if (f.kind === 'formpick') {
      const forms = state.data.forms || [];
      if (!forms.length) return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}${req}</p><p class="text-xs text-gray-500">You have no sign-up forms yet. Make one with your Email Marketing Assistant or in Audience → Forms, then come back.</p><input type="hidden" name="${name}" value="">`;
      return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}${req}</label><select name="${name}" class="${inputCls}"><option value="">Choose a form…</option>${forms.map((x) => `<option value="${esc(x.id)}" ${Number(value) === x.id ? 'selected' : ''}>${esc(x.name)}${x.active ? '' : ' (switched off)'}</option>`).join('')}</select>
        <p class="text-xs text-gray-500 mt-1">The form's questions, consent wording and confirmation email are used. People who sign up join your Audience, as they would from any of your forms.</p>`;
    }
    if (f.kind === 'link') {
      const v = value || {};
      const pages = def().pages.map((p) => [pathOf(p), p.title]);
      return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}${req}</label>
        <div class="grid gap-2 md:grid-cols-2"><input name="${name}-label" class="${inputCls}" placeholder="Button text" value="${esc(v.label || '')}">
        <input name="${name}-href" class="${inputCls}" list="site-pages-list" placeholder="/contact or https://…" value="${esc(v.href || '')}"></div>
        <datalist id="site-pages-list">${pages.map(([path, t]) => `<option value="${esc(path)}">${esc(t)}</option>`).join('')}</datalist>`;
    }
    if (f.kind === 'image') {
      const v = value || {};
      return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</label>
        <div class="grid gap-2 md:grid-cols-2"><input name="${name}-url" class="${inputCls}" placeholder="https://… picture address" value="${esc(v.url || '')}">
        <input name="${name}-alt" class="${inputCls}" placeholder="What the picture shows (required)" value="${esc(v.alt || '')}"></div>`;
    }
    if (f.kind === 'productItems') {
      const list = Array.isArray(value) && value.length ? value : [{}];
      return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p>
        <div data-items="${esc(f.k)}" class="space-y-2">${list.map((it, i) => `
          <div class="border border-gray-200 rounded-lg p-3" data-item>
            <input data-item-field="name" class="${inputCls} mt-1" placeholder="Name (required)" value="${esc(it.name || '')}">
            <textarea data-item-field="description" rows="2" class="${inputCls} mt-1" placeholder="Description">${esc(it.description || '')}</textarea>
            <div class="grid gap-2 md:grid-cols-3 mt-1">
              <input data-item-field="price" class="${inputCls}" inputmode="decimal" placeholder="Price in £, e.g. 12.50" value="${esc(it.price !== undefined ? poundsText(it.price) : (it.priceText || ''))}">
              <input data-item-field="imageUrl" class="${inputCls}" placeholder="Picture (https address)" value="${esc((it.image && it.image.url) || it.imageUrl || '')}">
              <input data-item-field="imageAlt" class="${inputCls}" placeholder="What the picture shows" value="${esc((it.image && it.image.alt) || it.imageAlt || '')}">
            </div>
            <button type="button" data-item-remove="${i}" class="text-xs text-gray-500 underline mt-1">Remove</button>
          </div>`).join('')}</div>
        <button type="button" data-item-add="${esc(f.k)}" class="text-xs text-gray-600 underline mt-2">+ Add another</button>
        <p class="text-xs text-gray-500 mt-1">Leave the price empty to show an item without a Buy button. Prices are in pounds; buyers pay you directly through Stripe.</p>`;
    }
    if (f.kind === 'items') {
      const list = Array.isArray(value) && value.length ? value : [{}];
      return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p>
        <div data-items="${esc(f.k)}" class="space-y-2">${list.map((it, i) => `
          <div class="border border-gray-200 rounded-lg p-3" data-item>
            ${f.fields.map(([k, kind, label]) => kind === 'textarea'
              ? `<textarea data-item-field="${esc(k)}" rows="2" class="${inputCls} mt-1" placeholder="${esc(label)}">${esc(it[k] || '')}</textarea>`
              : `<input data-item-field="${esc(k)}" class="${inputCls} mt-1" placeholder="${esc(label)}" value="${esc(it[k] || '')}">`).join('')}
            <button type="button" data-item-remove="${i}" class="text-xs text-gray-500 underline mt-1">Remove</button>
          </div>`).join('')}</div>
        <button type="button" data-item-add="${esc(f.k)}" class="text-xs text-gray-600 underline mt-2">+ Add another</button>`;
    }
    return '';
  }

  function readForm(form, type) {
    const props = {};
    for (const f of FORMS[type]) {
      const n = `f-${f.k}`;
      if (f.kind === 'text' || f.kind === 'textarea' || f.kind === 'select') props[f.k] = form.querySelector(`[name="${n}"]`).value;
      else if (f.kind === 'checkbox') props[f.k] = form.querySelector(`[name="${n}"]`).checked;
      else if (f.kind === 'formpick') props[f.k] = Number(form.querySelector(`[name="${n}"]`).value) || null;
      else if (f.kind === 'link') {
        const label = form.querySelector(`[name="${n}-label"]`).value.trim();
        const href = form.querySelector(`[name="${n}-href"]`).value.trim();
        props[f.k] = label || href ? { label, href } : null;
      } else if (f.kind === 'image') {
        const url = form.querySelector(`[name="${n}-url"]`).value.trim();
        const alt = form.querySelector(`[name="${n}-alt"]`).value.trim();
        props[f.k] = url ? { url, alt } : null;
      } else if (f.kind === 'productItems') {
        props[f.k] = [...form.querySelectorAll(`[data-items="${f.k}"] [data-item]`)].map((row) => {
          const g = (k) => row.querySelector(`[data-item-field="${k}"]`).value.trim();
          const url = g('imageUrl');
          return { name: g('name'), description: g('description'), price: toPence(g('price')), image: url ? { url, alt: g('imageAlt') } : null };
        });
      } else if (f.kind === 'items') {
        props[f.k] = [...form.querySelectorAll(`[data-items="${f.k}"] [data-item]`)].map((row) => {
          const o = {};
          row.querySelectorAll('[data-item-field]').forEach((el) => { o[el.dataset.itemField] = el.value; });
          return o;
        });
      }
    }
    return props;
  }

  function editorHtml() {
    const e = state.editing;
    return card(`
      <form data-site-section-form>
        <div class="flex items-center justify-between"><p class="text-sm font-black text-gray-900">${e.sectionId ? 'Edit' : 'Add'} ${esc(TYPE_LABEL[e.type])}</p>
          <button type="button" data-site-edit-cancel class="text-xs text-gray-500 underline">Cancel</button></div>
        ${FORMS[e.type].map((f) => fieldHtml(f, e.props[f.k])).join('')}
        <div class="mt-4">${btn('data-site-section-save type="submit"', e.sectionId ? 'Save section' : 'Add section', true).replace('type="button" ', '')}</div>
      </form>`);
  }

  function pagesPanel() {
    const d = def();
    const p = page();
    const pageTabs = d.pages.map((x) => `<button type="button" data-site-page="${esc(x.id)}" class="px-3 py-1.5 text-xs font-bold rounded-lg border ${x.id === p.id ? 'btn-primary' : 'btn-secondary'}">${esc(x.title)}</button>`).join(' ');
    const sections = p.sections.map((s, i) => `
      <li class="border border-gray-200 rounded-lg p-3 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0"><p class="text-xs font-bold text-gray-900">${esc(TYPE_LABEL[s.type])}</p><p class="text-xs text-gray-500 truncate">${esc(sectionSummary(s))}</p></div>
        <div class="flex flex-wrap gap-1">
          ${btn(`data-site-edit="${esc(s.id)}"`, 'Edit')}
          ${i > 0 ? btn(`data-site-move="${esc(s.id)}" data-to="${i - 1}" aria-label="Move up"`, '↑') : ''}
          ${i < p.sections.length - 1 ? btn(`data-site-move="${esc(s.id)}" data-to="${i + 1}" aria-label="Move down"`, '↓') : ''}
          ${btn(`data-site-remove-section="${esc(s.id)}"`, 'Remove')}
        </div>
      </li>`).join('');
    return `
      ${card(`
        <div class="flex flex-wrap gap-2 items-center">${pageTabs}
          ${d.pages.length < state.data.maxPages ? btn('data-site-add-page', '+ Page') : `<span class="text-xs text-gray-500">${esc(state.data.maxPages)} of ${esc(state.data.maxPages)} pages on your plan</span>`}</div>
        <div class="grid gap-2 md:grid-cols-2 mt-4">
          <div><label class="block text-xs font-bold text-gray-700">Page title</label><input data-site-page-title class="${inputCls}" value="${esc(p.title)}"></div>
          <div><label class="block text-xs font-bold text-gray-700">Address</label><input data-site-page-slug class="${inputCls}" value="${p.slug ? '/' + esc(p.slug) : '/ (home page)'}" ${p.slug ? '' : 'disabled'}></div>
          <div><label class="block text-xs font-bold text-gray-700">Search title</label><input data-site-seo-title class="${inputCls}" value="${esc(p.seo.title || '')}" placeholder="Shown in search results"></div>
          <div><label class="block text-xs font-bold text-gray-700">Search description</label><input data-site-seo-desc class="${inputCls}" value="${esc(p.seo.description || '')}" placeholder="One or two sentences"></div>
        </div>
        <div class="flex flex-wrap gap-2 mt-3">${btn('data-site-page-save', 'Save page details', true)}${p.slug ? btn('data-site-remove-page', 'Remove this page') : ''}</div>`)}
      ${state.editing ? editorHtml() : ''}
      ${card(`
        <p class="text-sm font-black text-gray-900 mb-3">Sections on this page</p>
        <ul class="space-y-2">${sections || '<li class="text-xs text-gray-500">No sections yet.</li>'}</ul>
        <div class="flex flex-wrap gap-2 items-center mt-4"><select data-site-new-type class="${inputCls}" style="max-width:220px">${state.data.vocab.sectionTypes.map((t) => `<option value="${esc(t)}">${esc(TYPE_LABEL[t] || t)}</option>`).join('')}</select>${btn('data-site-new-section', 'Add a section')}</div>`)}`;
  }

  function designPanel() {
    const t = def().theme;
    const colour = (k, label) => `<div><label class="block text-xs font-bold text-gray-700">${esc(label)}</label><input type="color" data-theme="${k}" value="${esc(t[k])}" class="w-full h-10 border border-gray-300 rounded-lg"></div>`;
    return card(`
      <p class="text-sm font-black text-gray-900">Design</p>
      <p class="text-xs text-gray-500 mb-3">Started from your brand kit. Text that would be hard to read on the background is refused.</p>
      <div class="grid gap-3 md:grid-cols-2">${colour('primaryColor', 'Main colour (buttons, links)')}${colour('textColor', 'Text colour')}${colour('backgroundColor', 'Background colour')}
        <div><label class="block text-xs font-bold text-gray-700">Lettering</label><select data-theme="font" class="${inputCls}">${[['sans', 'Clean (sans-serif)'], ['serif', 'Classic (serif)'], ['rounded', 'Friendly (rounded)'], ['system', 'Device default']].map(([v, l]) => `<option value="${v}" ${t.font === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label class="block text-xs font-bold text-gray-700">Corners</label><select data-theme="radius" class="${inputCls}">${[['none', 'Square'], ['small', 'Slightly rounded'], ['medium', 'Rounded'], ['large', 'Very rounded']].map(([v, l]) => `<option value="${v}" ${t.radius === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label class="block text-xs font-bold text-gray-700">Logo (https address)</label><input data-theme="logoUrl" class="${inputCls}" value="${esc(t.logoUrl || '')}"></div>
      </div>
      <div class="mt-4">${btn('data-site-theme-save', 'Save design', true)}</div>`);
  }

  function detailsPanel() {
    const s = def().settings;
    const f = (k, label, v) => `<div><label class="block text-xs font-bold text-gray-700">${esc(label)}</label><input data-setting="${k}" class="${inputCls}" value="${esc(v || '')}"></div>`;
    return card(`
      <p class="text-sm font-black text-gray-900 mb-3">Business details</p>
      <p class="text-xs text-gray-500 mb-3">Shown in your footer and given to search engines and AI assistants so they know who you are and where you work.</p>
      <div class="grid gap-3 md:grid-cols-2">${f('siteName', 'Business name', s.siteName)}${f('locality', 'Town or city', s.locality)}${f('email', 'Email', s.email)}${f('phone', 'Phone', s.phone)}
        <div><label class="block text-xs font-bold text-gray-700">Kind of business</label><select data-setting="businessType" class="${inputCls}">${[['Organization', 'Business'], ['LocalBusiness', 'Local business'], ['ProfessionalService', 'Professional service'], ['Store', 'Shop']].map(([v, l]) => `<option value="${v}" ${s.businessType === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <label class="block text-xs font-bold text-gray-700 mt-3">Site description (search results)</label><textarea data-setting="description" rows="2" class="${inputCls}">${esc(s.description || '')}</textarea>
      <label class="block text-xs font-bold text-gray-700 mt-3">Footer text</label><textarea data-site-footer rows="2" class="${inputCls}">${esc(def().footer.text || '')}</textarea>
      <div class="mt-4">${btn('data-site-details-save', 'Save details', true)}</div>`);
  }

  function enquiriesPanel() {
    const list = state.enquiries;
    if (!list) return card('<p class="text-sm text-gray-400 text-center">Loading enquiries…</p>');
    if (!list.length) return card(`<p class="text-sm font-black text-gray-900">Enquiries</p><p class="text-xs text-gray-500 mt-1">Messages people send from a contact form on your site appear here, and in your email. Add a "Contact form" section to a page to start receiving them.</p>`);
    const shown = list.slice(0, state.enquiryShown);
    return card(`
      <p class="text-sm font-black text-gray-900">Enquiries</p>
      <p class="text-xs text-gray-500 mt-1 mb-3">Sent from the contact forms on your site. Each one was also emailed to you — reply to them directly. They are not added to your Audience.</p>
      <ul class="space-y-2">${shown.map((q) => `
        <li class="border ${q.status === 'new' ? 'border-indigo-200' : 'border-gray-200'} rounded-lg p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs font-bold text-gray-900">${esc(q.name)} ${q.status === 'new' ? '<span class="text-xs font-bold text-indigo-700">· New</span>' : ''}</p>
            <p class="text-xs text-gray-500">${esc(new Date(q.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}${q.pagePath ? ` · ${esc(q.pagePath)}` : ''}</p>
          </div>
          <p class="text-xs text-gray-600 mt-1"><a class="underline" href="mailto:${esc(q.email)}">${esc(q.email)}</a>${q.phone ? ` · <a class="underline" href="tel:${esc(q.phone)}">${esc(q.phone)}</a>` : ''}</p>
          <p class="text-xs text-gray-800 mt-2" style="white-space:pre-wrap">${esc(q.message)}</p>
          <div class="mt-2">${btn(`data-site-enquiry="${esc(q.id)}" data-done="${q.status === 'new' ? '1' : '0'}"`, q.status === 'new' ? 'Mark as dealt with' : 'Mark as new')}</div>
        </li>`).join('')}</ul>
      ${list.length > shown.length ? `<div class="mt-3">${btn('data-site-enquiries-more', `Show more (${list.length - shown.length})`)}</div>` : ''}`);
  }

  // ── Orders (step 3c) ───────────────────────────────────────────────────────
  const money = (pence, cur) => (String(cur || 'gbp').toLowerCase() === 'gbp' ? `£${(pence / 100).toFixed(2).replace(/\.00$/, '')}` : `${(pence / 100).toFixed(2)} ${String(cur).toUpperCase()}`);

  function paymentsCard() {
    const p = state.data.payments || {};
    if (p.chargesEnabled) {
      return card(`<p class="text-sm font-black text-gray-900">Payments: connected</p>
        <p class="text-xs text-gray-500 mt-1">Your Stripe account is connected, so Buy buttons on your products show on your live site. Buyers pay you directly — Be More Swan takes no fee. Refunds, payouts and receipts are in your <a class="underline" href="https://dashboard.stripe.com" target="_blank" rel="noopener">Stripe dashboard</a>.</p>`, 'border-green-200');
    }
    const action = p.canConnect
      ? btn('data-site-connect', p.connected ? 'Finish setting up Stripe' : 'Connect Stripe', true)
      : '<p class="text-xs font-semibold text-gray-700 mt-2">Ask your workspace owner or an admin to connect Stripe.</p>';
    return card(`<p class="text-sm font-black text-gray-900">Take payments on your site</p>
      <p class="text-xs text-gray-500 mt-1">${p.connected
        ? 'Stripe still needs a few details before you can take payments. Pick up where you left off — it takes a few minutes.'
        : 'Connect a Stripe account to show Buy buttons on the products on your site. You are the seller: the money goes straight to your Stripe account, and Be More Swan takes no fee. Stripe charges its usual card fees. Prices are in pounds.'}</p>
      <div class="mt-3">${action}</div>`);
  }

  function ordersPanel() {
    const list = state.orders;
    const top = paymentsCard();
    if (!list) return top + card('<p class="text-sm text-gray-400 text-center">Loading orders…</p>');
    if (!list.length) return top + card('<p class="text-sm font-black text-gray-900">Orders</p><p class="text-xs text-gray-500 mt-1">When someone buys from your site, the order appears here and in your email.</p>');
    const shown = list.slice(0, state.orderShown);
    return top + card(`
      <p class="text-sm font-black text-gray-900">Orders</p>
      <ul class="space-y-2 mt-3">${shown.map((o) => {
        const a = o.shippingAddress && o.shippingAddress.address;
        const addr = a ? [o.shippingAddress.name, a.line1, a.line2, a.city, a.postal_code].filter(Boolean).join(', ') : '';
        return `<li class="border ${o.status === 'paid' ? 'border-indigo-200' : 'border-gray-200'} rounded-lg p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs font-bold text-gray-900">${esc(o.quantity)} × ${esc(o.itemName)} · ${esc(money(o.amountTotal, o.currency))} ${o.status === 'paid' ? '<span class="text-xs font-bold text-indigo-700">· New</span>' : ''}</p>
            <p class="text-xs text-gray-500">${esc(new Date(o.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</p>
          </div>
          <p class="text-xs text-gray-600 mt-1">${esc(o.customerName || '')}${o.customerEmail ? ` · <a class="underline" href="mailto:${esc(o.customerEmail)}">${esc(o.customerEmail)}</a>` : ''}</p>
          ${addr ? `<p class="text-xs text-gray-600 mt-1">Deliver to: ${esc(addr)}</p>` : ''}
          <div class="mt-2">${btn(`data-site-order="${esc(o.id)}" data-done="${o.status === 'paid' ? '1' : '0'}"`, o.status === 'paid' ? 'Mark as dealt with' : 'Mark as new')}</div>
        </li>`;
      }).join('')}</ul>
      ${list.length > shown.length ? `<div class="mt-3">${btn('data-site-orders-more', `Show more (${list.length - shown.length})`)}</div>` : ''}`);
  }

  async function loadOrders() {
    try { state.orders = (await post({ action: 'orders', assistantId: state.assistantId })).orders || []; }
    catch (err) { state.orders = []; state.note = { text: err.message, tone: 'error' }; }
    rerender();
  }

  async function loadEnquiries() {
    try { state.enquiries = (await post({ action: 'enquiries', assistantId: state.assistantId })).enquiries || []; }
    catch (err) { state.enquiries = []; state.note = { text: err.message, tone: 'error' }; }
    rerender();
  }

  function previewHtml() {
    const src = `/.netlify/functions/site-preview?assistantId=${encodeURIComponent(state.assistantId)}&path=${encodeURIComponent(state.previewPath)}&v=${state.version}`;
    const width = state.device === 'mobile' ? '390px' : '100%';
    return card(`
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p class="text-sm font-black text-gray-900">Preview <span class="text-xs font-semibold text-gray-500">— ${state.data.site.status === 'published' ? 'your draft' : 'not live yet'}</span></p>
        <div class="flex gap-1">${btn(`data-site-device="desktop"`, 'Desktop', state.device === 'desktop')}${btn(`data-site-device="mobile"`, 'Phone', state.device === 'mobile')}</div>
      </div>
      <div class="bg-gray-100 rounded-lg p-2" style="overflow:auto"><iframe title="Preview of your website" src="${esc(src)}" style="display:block;margin:0 auto;width:${width};height:720px;border:0;background:#fff;border-radius:8px"></iframe></div>`);
  }

  function draftCard() {
    const s = state.data.site;
    if (s.drafting) return card('<p class="text-sm font-semibold text-indigo-700">Drafting your whole site — this takes a minute or two. You can leave this page; you\'ll be notified when it\'s ready.</p>');
    return card(`
      <p class="text-sm font-black text-gray-900">Draft my whole site</p>
      <p class="text-xs text-gray-500 mt-1">${esc(state.assistantName || 'Your Website Assistant')} writes every page from your business details, products and set-up answers. It replaces the current draft (${s.status === 'published' ? 'your live site doesn\'t change until you publish' : 'nothing is live yet'}) and uses 1 task.</p>
      <textarea data-site-draft-request rows="2" class="${inputCls} mt-3" placeholder="Anything to include? e.g. a page for each service, a friendly tone, mention free delivery"></textarea>
      <div class="mt-3">${btn('data-site-draft', 'Draft my whole site', true)}</div>
      ${s.draftNote ? `<p class="text-xs font-semibold text-amber-800 mt-2">${esc(s.draftNote)}</p>` : ''}`);
  }

  // ── Publish ────────────────────────────────────────────────────────────────
  function publishCard() {
    const s = state.data.site;
    const pnote = state.publishNote ? `<p class="text-xs font-semibold ${state.publishNote.tone === 'error' ? 'text-red-600' : 'text-green-700'} mt-3">${esc(state.publishNote.text)}</p>` : '';
    if (s.status === 'suspended') {
      return `<div class="bg-red-50 border border-red-200 rounded-2xl p-4">
        <p class="text-sm font-bold text-red-700">Your site has been taken offline by Be More Swan</p>
        <p class="text-xs text-red-700 mt-1">${esc(s.suspendedReason)}</p>
        <p class="text-xs text-red-700 mt-2">You can keep editing your draft, but it can't be published. If you think this is a mistake, <a href="/contact.html" class="underline">contact us</a>.</p></div>`;
    }
    const live = s.status === 'published';
    const address = (!s.slug || state.editingAddress)
      ? `<label class="block text-xs font-bold text-gray-700 mt-3" for="sitebuilder-slug">Your site's address</label>
         <div class="flex flex-wrap items-center gap-2 mt-1">
           <span class="flex items-center gap-1 min-w-0"><input id="sitebuilder-slug" data-site-slug class="${inputCls}" style="max-width:220px" value="${esc(state.slugTyped != null ? state.slugTyped : (s.slug || s.suggestedSlug || ''))}" autocomplete="off" spellcheck="false"><span class="text-xs text-gray-500">.${esc(s.domain)}</span></span>
           ${btn('data-site-address-save', 'Save address', true)}${s.slug ? btn('data-site-address-cancel', 'Cancel') : ''}
         </div>
         <p class="text-xs text-gray-500 mt-1">Lower-case letters, numbers and hyphens. You can connect your own domain name later.</p>`
      : `<p class="text-xs text-gray-600 mt-2">Address: <a href="${esc(s.url)}" target="_blank" rel="noopener" class="font-semibold underline">${esc(s.url.replace('https://', ''))}</a> ${btn('data-site-address-edit', 'Change')}</p>`;
    const status = live
      ? `<p class="text-sm font-black text-gray-900">Your site is live</p>
         <p class="text-xs text-gray-500 mt-1">${s.unpublishedChanges ? 'You have changes that aren\'t live yet — visitors see the version you last published until you press Publish.' : 'Visitors see exactly what is in the preview.'}</p>`
      : `<p class="text-sm font-black text-gray-900">Publish your site</p>
         <p class="text-xs text-gray-500 mt-1">${s.publishedVersion ? 'Your site is offline. Publish to put it back.' : 'Nothing is live yet. When you publish, anyone can visit your site and search engines can find it.'}</p>`;
    const canPublish = !s.publishBlocker && (!live || s.unpublishedChanges);
    const actions = `<div class="flex flex-wrap gap-2 mt-3">
        ${btn(`data-site-publish ${canPublish ? '' : 'disabled'}`, live ? 'Publish changes' : 'Publish', true)}
        ${live ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">View live site</a>${btn('data-site-unpublish', 'Take offline')}` : ''}
        ${s.publishedVersion ? btn('data-site-versions', state.versions ? 'Hide earlier versions' : 'Earlier versions') : ''}
      </div>
      ${s.publishBlocker && s.slug ? `<p class="text-xs font-semibold text-amber-800 mt-2">${esc(s.publishBlocker)}</p>` : ''}`;
    const versions = state.versions ? `<ul class="mt-3 space-y-1">${state.versions.length ? state.versions.map((v) => `
        <li class="flex flex-wrap items-center justify-between gap-2 text-xs border border-gray-200 rounded-lg px-3 py-2">
          <span>Version ${esc(v.version)} · ${esc(new Date(v.publishedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))} · ${esc(v.pages)} page${v.pages === 1 ? '' : 's'}${v.version === s.publishedVersion && live ? ' · <strong>live</strong>' : ''}</span>
          ${btn(`data-site-restore="${esc(v.version)}"`, 'Copy into my draft')}
        </li>`).join('') : '<li class="text-xs text-gray-500">No earlier versions.</li>'}</ul>
        <p class="text-xs text-gray-500 mt-1">Copying a version replaces your draft with it. Your live site only changes when you publish.</p>` : '';
    return card(`${status}${address}${actions}${versions}${pnote}`, live ? 'border-green-200' : '');
  }

  function placeholdersCard() {
    const list = state.data.placeholders || [];
    if (!list.length) return '';
    return `<div class="bg-amber-50 border border-amber-200 rounded-2xl p-4">
      <p class="text-sm font-bold text-amber-800">${list.length} part${list.length === 1 ? '' : 's'} in [square brackets] to fill in with your real details before you publish</p>
      <ul class="mt-2 space-y-1 list-disc pl-5">${list.slice(0, 8).map((x) => `<li class="text-xs text-amber-800">${esc(x.pageTitle)}: ${esc(x.text)}</li>`).join('')}</ul></div>`;
  }

  function render() {
    const host = document.getElementById('site-editor-host');
    if (!host) return;
    if (!state.loaded) { host.innerHTML = card('<p class="text-sm text-gray-400 text-center">Loading your website…</p>'); return; }
    if (state.loadError && !state.data) { host.innerHTML = card(`<p class="text-sm font-bold text-gray-700 text-center">Could not load your website</p><p class="text-xs text-gray-500 mt-2 text-center">${esc(state.loadError)}</p>`); return; }
    const newCount = state.data.newEnquiries || 0;
    const newOrders = state.data.newOrders || 0;
    const tabs = [['pages', 'Pages'], ['design', 'Design'], ['details', 'Details'], ['enquiries', newCount ? `Enquiries (${newCount} new)` : 'Enquiries'], ['orders', newOrders ? `Orders (${newOrders} new)` : 'Orders']].map(([k, l]) => btn(`data-site-panel="${k}"`, esc(l), state.panel === k)).join(' ');
    host.innerHTML = `
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="space-y-4 min-w-0">
          ${publishCard()}
          ${placeholdersCard()}
          <div class="flex flex-wrap gap-2">${tabs}</div>
          ${noteHtml()}
          ${state.panel === 'pages' ? pagesPanel() : state.panel === 'design' ? designPanel() : state.panel === 'enquiries' ? enquiriesPanel() : state.panel === 'orders' ? ordersPanel() : detailsPanel()}
          ${draftCard()}
        </div>
        <div class="min-w-0">${previewHtml()}</div>
      </div>`;
  }

  function rerender() { if (state.rendered) render(); }
  const say = (text, tone) => { state.note = text ? { text, tone } : null; rerender(); };
  const hostOf = (e) => e.target.closest && e.target.closest('#site-editor-host');

  // ── Events (bound once) ────────────────────────────────────────────────────
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest && e.target.closest('[data-site-section-form]');
    if (!form || !state.assistantId) return;
    e.preventDefault();
    const ed = state.editing;
    const props = readForm(form, ed.type);
    const op = ed.sectionId
      ? { op: 'update_section', pageId: ed.pageId, sectionId: ed.sectionId, props }
      : { op: 'add_section', pageId: ed.pageId, section: { type: ed.type, props } };
    await apply([op], () => { state.editing = null; });
  });

  document.addEventListener('click', async (e) => {
    if (!state.assistantId || !hostOf(e)) return;
    const t = (sel) => e.target.closest(sel);
    const p = page();

    const panel = t('[data-site-panel]');
    if (panel) {
      state.panel = panel.dataset.sitePanel; state.editing = null;
      if (state.panel === 'enquiries') { state.enquiries = null; state.enquiryShown = 20; loadEnquiries(); }
      if (state.panel === 'orders') { state.orders = null; state.orderShown = 20; loadOrders(); }
      render();
      return;
    }
    const enq = t('[data-site-enquiry]');
    if (enq) {
      try {
        await post({ action: 'enquiry_done', assistantId: state.assistantId, id: Number(enq.dataset.siteEnquiry), done: enq.dataset.done === '1' });
        state.data = await post({ action: 'get', assistantId: state.assistantId });
      } catch (err) { state.note = { text: err.message, tone: 'error' }; }
      await loadEnquiries();
      return;
    }
    if (t('[data-site-enquiries-more]')) { state.enquiryShown += 20; render(); return; }
    const ord = t('[data-site-order]');
    if (ord) {
      try {
        await post({ action: 'order_done', assistantId: state.assistantId, id: Number(ord.dataset.siteOrder), done: ord.dataset.done === '1' });
        state.data = await post({ action: 'get', assistantId: state.assistantId });
      } catch (err) { state.note = { text: err.message, tone: 'error' }; }
      await loadOrders();
      return;
    }
    if (t('[data-site-orders-more]')) { state.orderShown += 20; render(); return; }
    if (t('[data-site-connect]')) {
      // Stripe's own onboarding, in this tab; Stripe sends them back to this Website tab.
      try { window.location.href = (await post({ action: 'payments_connect', assistantId: state.assistantId })).url; }
      catch (err) { state.note = { text: err.message, tone: 'error' }; render(); }
      return;
    }
    const pg = t('[data-site-page]');
    if (pg) { state.pageId = pg.dataset.sitePage; state.editing = null; state.previewPath = pathOf(page()); render(); return; }
    const dev = t('[data-site-device]');
    if (dev) { state.device = dev.dataset.siteDevice; render(); return; }
    if (t('[data-site-edit-cancel]')) { state.editing = null; render(); return; }

    const edit = t('[data-site-edit]');
    if (edit) { const s = p.sections.find((x) => x.id === edit.dataset.siteEdit); state.editing = { pageId: p.id, sectionId: s.id, type: s.type, props: JSON.parse(JSON.stringify(s.props)) }; render(); return; }
    if (t('[data-site-new-section]')) {
      const type = document.querySelector('[data-site-new-type]').value;
      state.editing = { pageId: p.id, sectionId: null, type, props: JSON.parse(JSON.stringify(BLANK[type] || {})) };
      render();
      return;
    }
    const addItem = t('[data-item-add]');
    if (addItem) {
      const form = addItem.closest('form');
      state.editing.props = readForm(form, state.editing.type);
      state.editing.props[addItem.dataset.itemAdd] = [...(state.editing.props[addItem.dataset.itemAdd] || []), {}];
      render();
      return;
    }
    const rmItem = t('[data-item-remove]');
    if (rmItem) {
      const form = rmItem.closest('form');
      const key = rmItem.closest('[data-items]').dataset.items;
      state.editing.props = readForm(form, state.editing.type);
      state.editing.props[key].splice(Number(rmItem.dataset.itemRemove), 1);
      render();
      return;
    }

    const mv = t('[data-site-move]');
    if (mv) { await apply([{ op: 'move_section', pageId: p.id, sectionId: mv.dataset.siteMove, toIndex: Number(mv.dataset.to) }]); return; }
    const rs = t('[data-site-remove-section]');
    if (rs) {
      const ok = typeof window.confirmModal === 'function' ? await window.confirmModal('This section is removed from your draft.', { title: 'Remove this section?', confirmLabel: 'Remove', cancelLabel: 'Keep it' }) : true;
      if (ok) await apply([{ op: 'remove_section', pageId: p.id, sectionId: rs.dataset.siteRemoveSection }]);
      return;
    }
    if (t('[data-site-add-page]')) {
      // dialogs.js owns every dialog (never window.prompt).
      const title = typeof window.promptModal === 'function'
        ? await window.promptModal('What is the new page called?', { title: 'Add a page', confirmLabel: 'Add page', placeholder: 'e.g. Services' })
        : null;
      if (title && title.trim()) await apply([{ op: 'add_page', title: title.trim() }]);
      return;
    }
    if (t('[data-site-remove-page]')) {
      const ok = typeof window.confirmModal === 'function' ? await window.confirmModal(`"${p.title}" and its sections are removed from your draft.`, { title: 'Remove this page?', confirmLabel: 'Remove page', cancelLabel: 'Keep it' }) : true;
      if (ok) { await apply([{ op: 'remove_page', pageId: p.id }]); state.pageId = null; state.previewPath = '/'; render(); }
      return;
    }
    if (t('[data-site-page-save]')) {
      const host = hostOf(e);
      const op = { op: 'update_page', pageId: p.id, title: host.querySelector('[data-site-page-title]').value,
        seo: { title: host.querySelector('[data-site-seo-title]').value || null, description: host.querySelector('[data-site-seo-desc]').value || null } };
      if (p.slug) op.slug = host.querySelector('[data-site-page-slug]').value.replace(/^\//, '');
      await apply([op], () => { state.previewPath = pathOf(page()); });
      return;
    }
    if (t('[data-site-theme-save]')) {
      const theme = {};
      hostOf(e).querySelectorAll('[data-theme]').forEach((el) => { theme[el.dataset.theme] = el.value || (el.dataset.theme === 'logoUrl' ? null : el.value); });
      await apply([{ op: 'set_theme', theme }]);
      return;
    }
    if (t('[data-site-details-save]')) {
      const settings = {};
      hostOf(e).querySelectorAll('[data-setting]').forEach((el) => { settings[el.dataset.setting] = el.value; });
      await apply([{ op: 'set_settings', settings }, { op: 'set_footer', text: hostOf(e).querySelector('[data-site-footer]').value || null }]);
      return;
    }
    if (t('[data-site-address-edit]')) { state.editingAddress = true; state.publishNote = null; render(); return; }
    if (t('[data-site-address-cancel]')) { state.editingAddress = false; state.slugTyped = null; render(); return; }
    if (t('[data-site-address-save]')) {
      const slug = hostOf(e).querySelector('[data-site-slug]').value;
      state.slugTyped = slug;   // kept if the address is refused, so what they typed isn't lost
      const s = state.data.site;
      if (s.status === 'published' && s.slug && slug.trim().toLowerCase() !== s.slug) {
        const ok = await window.confirmModal(`${s.url.replace('https://', '')} stops working straight away and your site moves to the new address. Anyone with the old link will not find it.`, { title: 'Change your site\'s address?', confirmLabel: 'Change address', cancelLabel: 'Keep it' });
        if (!ok) return;
      }
      await publishAction({ action: 'address', slug }, 'Address saved.', () => { state.editingAddress = false; state.slugTyped = null; });
      return;
    }
    if (t('[data-site-publish]')) {
      const s = state.data.site;
      const where = s.url ? s.url.replace('https://', '') : 'your address';
      const ok = await window.confirmModal(s.status === 'published'
        ? `Visitors to ${where} will see your draft as it is now.`
        : `Your site goes live at ${where}. Anyone can visit it and search engines can find it.`, { title: s.status === 'published' ? 'Publish your changes?' : 'Publish your site?', confirmLabel: 'Publish', cancelLabel: 'Not yet' });
      if (!ok) return;
      await publishAction({ action: 'publish' }, 'Published — your site is live. It can take a minute to show everywhere.', () => { state.versions = null; });
      return;
    }
    if (t('[data-site-unpublish]')) {
      const ok = await window.confirmModal('Visitors will see "There\'s no website here yet" until you publish again. Your pages and earlier versions are kept.', { title: 'Take your site offline?', confirmLabel: 'Take offline', cancelLabel: 'Keep it live' });
      if (!ok) return;
      await publishAction({ action: 'unpublish' }, 'Your site is offline.');
      return;
    }
    if (t('[data-site-versions]')) {
      if (state.versions) { state.versions = null; render(); return; }
      try { state.versions = (await post({ action: 'versions', assistantId: state.assistantId })).versions || []; } catch (err) { state.publishNote = { text: err.message, tone: 'error' }; }
      render();
      return;
    }
    const rv = t('[data-site-restore]');
    if (rv) {
      const ok = await window.confirmModal(`Your current draft is replaced with version ${rv.dataset.siteRestore}. Your live site doesn't change until you publish.`, { title: 'Copy this version into your draft?', confirmLabel: 'Copy into draft', cancelLabel: 'Not now' });
      if (!ok) return;
      await publishAction({ action: 'restore', version: Number(rv.dataset.siteRestore) }, `Version ${rv.dataset.siteRestore} is now your draft. Publish to make it live.`);
      return;
    }
    if (t('[data-site-draft]')) {
      const ok = typeof window.confirmModal === 'function'
        ? await window.confirmModal(`Your Website Assistant writes every page again, replacing your current draft. ${state.data.site.status === 'published' ? 'Your live site doesn\'t change until you publish.' : 'Nothing is live yet.'} This uses 1 task.`, { title: 'Draft your whole site?', confirmLabel: 'Draft my site', cancelLabel: 'Not now' })
        : true;
      if (!ok) return;
      try {
        state.data = await post({ action: 'draft', assistantId: state.assistantId, request: hostOf(e).querySelector('[data-site-draft-request]').value });
        say(null);
      } catch (err) { say(err.message, 'error'); }
      schedulePoll();
      rerender();
    }
  });

  document.addEventListener('site:changed', (e) => {
    const id = e.detail && e.detail.assistantId;
    if (!state.assistantId || Number(id) !== Number(state.assistantId)) return;
    load();
  });

  window.AssistantSiteEditor = {
    init({ assistantId, assistantName }) {
      clearTimeout(state.pollTimer);
      Object.assign(state, { assistantId, assistantName: assistantName || null, data: null, loaded: false, rendered: false, editing: null, pageId: null, previewPath: '/', note: null, editingAddress: false, slugTyped: null, versions: null, publishNote: null, enquiries: null, enquiryShown: 20, orders: null, orderShown: 20, refreshedPayments: false });
      load();
    },
    activate() {
      if (state.rendered) return;
      state.rendered = true;
      render();
    },
  };
})();
