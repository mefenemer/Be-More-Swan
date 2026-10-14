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
 * ── What this tab may not do ─────────────────────────────────────────────────
 * Publish. Nothing here is live; publishing is step 3 and will be its own click.
 * Spend without a click: only "Draft my whole site" uses a task, and it says so first.
 *
 * Handlers are bound to `document` once, at load, never from render. Server values are escaped.
 */
(function () {
  const API = '/.netlify/functions/sites';
  const POLL_MS = 5000;

  const TYPE_LABEL = { hero: 'Hero', features: 'Features', steps: 'Steps', text: 'Text', faq: 'Questions', testimonials: 'Testimonials', cta: 'Call to action' };
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
  };
  const BLANK = {
    hero: { layout: 'centered', headline: '' }, features: { items: [{ title: '', body: '' }] }, steps: { items: [{ title: '', body: '' }, { title: '', body: '' }] },
    text: { body: '' }, faq: { items: [{ q: '', a: '' }] }, testimonials: { items: [{ quote: '', name: '', detail: '' }] }, cta: { heading: '', button: { label: '', href: '/' } },
  };

  const state = {
    assistantId: null, assistantName: null, data: null, loaded: false, loadError: null, rendered: false,
    panel: 'pages', pageId: null, editing: null, device: 'desktop', previewPath: '/', note: null, pollTimer: null, version: 0,
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
      state.note = (state.data.warnings || []).length ? { text: state.data.warnings.join(' '), tone: 'warn' } : { text: 'Saved.', tone: 'ok' };
      if (done) done();
    } catch (err) {
      state.note = { text: err.message, tone: 'error' };
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
      else if (f.kind === 'link') {
        const label = form.querySelector(`[name="${n}-label"]`).value.trim();
        const href = form.querySelector(`[name="${n}-href"]`).value.trim();
        props[f.k] = label || href ? { label, href } : null;
      } else if (f.kind === 'image') {
        const url = form.querySelector(`[name="${n}-url"]`).value.trim();
        const alt = form.querySelector(`[name="${n}-alt"]`).value.trim();
        props[f.k] = url ? { url, alt } : null;
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

  function previewHtml() {
    const src = `/.netlify/functions/site-preview?assistantId=${encodeURIComponent(state.assistantId)}&path=${encodeURIComponent(state.previewPath)}&v=${state.version}`;
    const width = state.device === 'mobile' ? '390px' : '100%';
    return card(`
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p class="text-sm font-black text-gray-900">Preview <span class="text-xs font-semibold text-gray-500">— not live yet</span></p>
        <div class="flex gap-1">${btn(`data-site-device="desktop"`, 'Desktop', state.device === 'desktop')}${btn(`data-site-device="mobile"`, 'Phone', state.device === 'mobile')}</div>
      </div>
      <div class="bg-gray-100 rounded-lg p-2" style="overflow:auto"><iframe title="Preview of your website" src="${esc(src)}" style="display:block;margin:0 auto;width:${width};height:720px;border:0;background:#fff;border-radius:8px"></iframe></div>`);
  }

  function draftCard() {
    const s = state.data.site;
    if (s.drafting) return card('<p class="text-sm font-semibold text-indigo-700">Drafting your whole site — this takes a minute or two. You can leave this page; you\'ll be notified when it\'s ready.</p>');
    return card(`
      <p class="text-sm font-black text-gray-900">Draft my whole site</p>
      <p class="text-xs text-gray-500 mt-1">${esc(state.assistantName || 'Your Website Assistant')} writes every page from your business details, products and set-up answers. It replaces the current draft (nothing is live yet) and uses 1 task.</p>
      <textarea data-site-draft-request rows="2" class="${inputCls} mt-3" placeholder="Anything to include? e.g. a page for each service, a friendly tone, mention free delivery"></textarea>
      <div class="mt-3">${btn('data-site-draft', 'Draft my whole site', true)}</div>
      ${s.draftNote ? `<p class="text-xs font-semibold text-amber-800 mt-2">${esc(s.draftNote)}</p>` : ''}`);
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
    const tabs = [['pages', 'Pages'], ['design', 'Design'], ['details', 'Details']].map(([k, l]) => btn(`data-site-panel="${k}"`, l, state.panel === k)).join(' ');
    host.innerHTML = `
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="space-y-4 min-w-0">
          ${placeholdersCard()}
          <div class="flex flex-wrap gap-2">${tabs}</div>
          ${noteHtml()}
          ${state.panel === 'pages' ? pagesPanel() : state.panel === 'design' ? designPanel() : detailsPanel()}
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
    if (panel) { state.panel = panel.dataset.sitePanel; state.editing = null; render(); return; }
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
    if (t('[data-site-draft]')) {
      const ok = typeof window.confirmModal === 'function'
        ? await window.confirmModal('Your Website Assistant writes every page again, replacing your current draft. Nothing is live yet. This uses 1 task.', { title: 'Draft your whole site?', confirmLabel: 'Draft my site', cancelLabel: 'Not now' })
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
      Object.assign(state, { assistantId, assistantName: assistantName || null, data: null, loaded: false, rendered: false, editing: null, pageId: null, previewPath: '/', note: null });
      load();
    },
    activate() {
      if (state.rendered) return;
      state.rendered = true;
      render();
    },
  };
})();
