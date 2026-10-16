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

  const TYPE_LABEL = { hero: 'Hero', features: 'Features', steps: 'Steps', text: 'Text', faq: 'Questions', testimonials: 'Testimonials', cta: 'Call to action', contact: 'Contact form', signup: 'Sign-up form', products: 'Products for sale', booking: 'Bookings', hours: 'Opening hours & contact', menu: 'Menu / price list', gallery: 'Gallery', reviews: 'Reviews' };
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
    text: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'body', kind: 'textarea', label: 'Text (a blank line starts a new paragraph)', rows: 8, required: true },
      { k: 'image', kind: 'image', label: 'Picture beside the text (optional)' },
      { k: 'imageSide', kind: 'select', label: 'Picture on the', options: [['right', 'Right'], ['left', 'Left']] }],
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
      { k: 'intro', kind: 'textarea', label: 'Introduction (leave empty to use the form\'s own)' },
      { k: 'image', kind: 'image', label: 'Cover picture beside the form (optional — e.g. your free guide\'s front page)' }],
    // Things for sale: chosen from Business Information ▸ Products & Services — the ONE place names,
    // prices and pictures live (the page and checkout read them from there). Buy buttons appear on
    // fixed-price products once Stripe is connected on the Orders tab.
    products: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'productIds', kind: 'productPick', label: 'Which of your products to show' },
      { k: 'collectAddress', kind: 'checkbox', label: 'Ask buyers for a UK delivery address' },
      { k: 'buyLabel', kind: 'text', label: 'Buy button text' }],
    // Bookings (docs/booking-plan.md): the services are Products & Services with a length; hours and
    // rules are Business Information ▸ Opening hours & bookings. This section only chooses what to offer.
    booking: [{ k: 'kind', kind: 'select', label: 'What people book', options: [['appointment', 'Appointments (a service with you or your team)'], ['consultation', 'Consultations or calls'], ['table', 'Tables (restaurants, cafés, bars)'], ['class', 'Classes and events (dates you set, with places)']] },
      { k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'serviceIds', kind: 'servicePick', label: 'Which services can be booked' },
      { k: 'askStaff', kind: 'checkbox', label: 'Let people choose who they book with (or "anyone available")' },
      { k: 'buttonLabel', kind: 'text', label: 'Button text' }],
    // Reviews: quoted from Business Information ▸ Reviews (the customers' words, never typed here).
    reviews: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'reviewIds', kind: 'reviewPick', label: 'Which reviews to quote' },
      { k: 'limit', kind: 'select', label: 'When none are ticked, show the newest', options: [[3, '3 reviews'], [6, '6 reviews'], [9, '9 reviews'], [12, '12 reviews']] },
      { k: 'showSummary', kind: 'checkbox', label: 'Show your average rating (counts every review, including hidden ones)' }],
    // Gallery: the owner's own pictures, each with what it shows (needed) and an optional caption.
    gallery: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'layout', kind: 'select', label: 'Layout', options: [['square', 'Even squares (pictures are cropped to fit)'], ['natural', 'Each picture at its own shape']] },
      { k: 'images', kind: 'gallery', label: 'Pictures' }],
    // Menu / price list: groups the owner names, filled with Business Information products. Names,
    // prices, descriptions and lengths are read from there — never typed here.
    menu: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'groups', kind: 'menuGroups', label: 'Groups and what is in each' },
      { k: 'showDescriptions', kind: 'checkbox', label: 'Show each description' },
      { k: 'showDurations', kind: 'checkbox', label: 'Show how long each service takes' },
      { k: 'note', kind: 'textarea', label: 'Note under the list (e.g. allergies, "prices include VAT")', rows: 2 }],
    // Opening hours & contact: everything shown comes from Business Information (hours, where to find
    // you) and Site settings (phone, email) — this section only chooses which parts to show.
    hours: [{ k: '_info', kind: 'hoursInfo', label: 'What this shows' },
      { k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'showHours', kind: 'checkbox', label: 'Show the opening hours and an "Open now" badge' },
      { k: 'showAddress', kind: 'checkbox', label: 'Show the address' },
      { k: 'showContact', kind: 'checkbox', label: 'Show Call, WhatsApp, Email and Get directions buttons' }],
  };
  const BLANK = {
    hero: { layout: 'centered', headline: '' }, features: { items: [{ title: '', body: '' }] }, steps: { items: [{ title: '', body: '' }, { title: '', body: '' }] },
    text: { body: '' }, faq: { items: [{ q: '', a: '' }] }, testimonials: { items: [{ quote: '', name: '', detail: '' }] }, cta: { heading: '', button: { label: '', href: '/' } },
    contact: { heading: 'Get in touch', intro: '', askPhone: false, buttonLabel: 'Send message' }, signup: { formId: null },
    products: { heading: 'Shop', productIds: [], collectAddress: false, buyLabel: 'Buy now' },
    booking: { kind: 'appointment', heading: 'Book an appointment', serviceIds: [], askStaff: false, buttonLabel: '' },
    hours: { heading: 'Opening hours', intro: '', showHours: true, showAddress: true, showContact: true },
    reviews: { heading: 'What our customers say', intro: '', reviewIds: [], limit: 6, showSummary: true },
    gallery: { heading: 'Gallery', intro: '', layout: 'square', images: [] },
    menu: { heading: 'Prices', intro: '', groups: [{ title: '', productIds: [] }], showDescriptions: true, showDurations: false, note: '' },
  };
  /** A library picture's thumbnail: picked this session, or the link the server sent with the site. */
  const thumbOf = (assetId) => (assetId && (state.thumbs[assetId] || (state.data && state.data.assetUrls && state.data.assetUrls[assetId]))) || '';
  /** A starting description from a file name ("cafe-front.jpg" → "Cafe front"); none for camera names. */
  const altFromName = (name) => {
    const base = String(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
    if (!base || /^(img|dsc|dscn|pxl|photo|image|screenshot)[\s\d]/i.test(base) || /^\d[\d\s]*$/.test(base)) return '';
    return base.charAt(0).toUpperCase() + base.slice(1);
  };
  /** Picture field: thumbnail, Choose/Change, Remove — the web address tucked away behind a link. */
  function pictureHtml(img, attrs) {
    const v = img || {};
    const src = v.assetId ? thumbOf(v.assetId) : (v.url || '');
    return `<div class="flex flex-wrap items-center gap-3 mt-1">
        ${src ? `<img src="${esc(src)}" alt="" style="width:96px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb">`
          : '<span class="inline-flex items-center justify-center text-xs text-gray-400 border border-dashed border-gray-300 rounded-lg" style="width:96px;height:64px">No picture</span>'}
        ${btn(`${attrs.pick}`, src ? 'Change picture' : 'Choose picture', !src)}
        ${src ? btn(`${attrs.clear}`, 'Remove') : ''}
      </div>`;
  }

  const state = {
    assistantId: null, assistantName: null, data: null, loaded: false, loadError: null, rendered: false,
    panel: 'pages', pageId: null, editing: null, device: 'desktop', previewPath: '/', note: null, pollTimer: null, version: 0,
    editingAddress: false, slugTyped: null, versions: null, publishNote: null,
    enquiries: null, enquiryShown: 20, orders: null, orderShown: 20, refreshedPayments: false,
    thumbs: {}, bookings: null, timetable: null,
    words: { open: false, busy: false, file: null, error: null, proposal: null, pageId: null, text: '', note: '' },
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
    if (f.kind === 'select') return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</label><select name="${name}" class="${inputCls}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    if (f.kind === 'checkbox') return `<label class="flex items-center gap-2 text-xs font-bold text-gray-700 mt-3"><input type="checkbox" name="${name}" ${value ? 'checked' : ''}> ${esc(f.label)}</label>`;
    if (f.kind === 'formpick') {
      const forms = state.data.forms || [];
      if (!forms.length) return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}${req}</p><p class="text-xs text-gray-500">You have no sign-up forms yet. Make one with your Email Marketing Assistant or in Audience → Forms, then come back.</p><input type="hidden" name="${name}" value="">`;
      return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}${req}</label><select name="${name}" class="${inputCls}"><option value="">Choose a form…</option>${forms.map((x) => `<option value="${esc(x.id)}" ${Number(value) === x.id ? 'selected' : ''}>${esc(x.name)}${x.download ? ` — sends “${esc(x.download)}”` : ''}${x.active ? '' : ' (switched off)'}</option>`).join('')}</select>
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
      const has = !!(v.assetId || v.url);
      return `<p class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p>
        ${pictureHtml(v, { pick: `data-site-pick="${esc(f.k)}"`, clear: `data-site-pick-clear="${esc(f.k)}"` })}
        <input type="hidden" name="${name}-asset" value="${esc(v.assetId || '')}">
        <input name="${name}-alt" class="${inputCls} mt-2 ${has && !v.alt ? 'border-amber-500' : ''}" placeholder="What the picture shows — e.g. Our roastery in Leeds (needed)" value="${esc(v.alt || '')}">
        <details class="mt-1" ${!v.assetId && v.url ? 'open' : ''}><summary class="text-xs text-gray-500 cursor-pointer">Use a web address instead</summary>
          <input name="${name}-url" class="${inputCls} mt-1" placeholder="https://… picture address" value="${esc(v.assetId ? '' : (v.url || ''))}"></details>`;
    }
    if (f.kind === 'hoursInfo') {
      const b = state.data.booking || {};
      const st = (state.data.definition && state.data.definition.settings) || {};
      const line = (ok, text) => `<li class="${ok ? 'text-gray-700' : 'text-amber-800'}">${ok ? '✓' : '○'} ${text}</li>`;
      return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p><ul class="text-xs space-y-0.5 mt-1">
        ${line(b.ready, b.ready ? `Hours: ${esc(b.hours)}` : 'No opening hours yet')}
        ${line(!!b.visitAddress, b.visitAddress ? `Address: ${esc(b.visitAddress.split('\n').join(', '))}` : 'No address yet (no directions button)')}
        ${line(!!(st.phone || st.email || b.whatsapp), [st.phone && `Phone ${esc(st.phone)}`, b.whatsapp && `WhatsApp ${esc(b.whatsapp)}`, st.email && `Email ${esc(st.email)}`].filter(Boolean).join(' · ') || 'No phone, WhatsApp or email yet')}</ul>
        <p class="text-xs text-gray-500 mt-1">Change them once and every page updates. ${btn('data-site-open-hours', 'Hours, location & bookings')}</p>`;
    }
    if (f.kind === 'servicePick' && state.editing && state.editing.props.kind === 'class') {
      // Classes and events: any Business Information product can be a class; dates are on the timetable.
      const chosen = new Set((Array.isArray(value) ? value : []).map(Number));
      const list = state.data.catalogue || [];
      return `<p class="text-xs font-bold text-gray-700 mt-3">Which classes or events to show</p>
        ${list.length ? `<div class="space-y-1 mt-1">${list.map((x) => `<label class="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 text-xs cursor-pointer">
          <input type="checkbox" data-service-pick value="${esc(x.id)}" ${chosen.has(x.id) ? 'checked' : ''}> <span class="font-bold text-gray-900">${esc(x.name)}</span>${x.price ? `<span class="text-gray-500">${esc(x.price)}</span>` : ''}</label>`).join('')}</div>
          <p class="text-xs text-gray-500 mt-1">Tick none to show them all.</p>` : ''}
        <p class="text-xs text-gray-500 mt-2">Add the dates and places on the Website tab, under Bookings ▸ Timetable. ${btn('data-site-panel="bookings"', 'Open the timetable')}</p>`;
    }
    if (f.kind === 'servicePick') {
      const b = state.data.booking || {};
      const chosen = new Set((Array.isArray(value) ? value : []).map(Number));
      const hoursNote = `<p class="text-xs ${b.ready ? 'text-gray-500' : 'text-amber-800 font-semibold'} mt-2">${b.ready ? `Opening hours: ${esc(b.hours)}.` : 'Set your opening hours first — booking only shows on your site once they are set.'} ${btn('data-site-open-hours', 'Hours, location & bookings')}</p>`;
      if (!(b.services || []).length) return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p><p class="text-xs text-gray-500">None of your Products &amp; Services has a length yet. Give a service a length (e.g. 45 minutes) in ${btn('data-site-open-products', 'Business Information ▸ Products & Services')} to offer it here. (Tables don't need one.)</p>${hoursNote}`;
      return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p>
        <div class="space-y-1 mt-1">${b.services.map((x) => `<label class="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 text-xs cursor-pointer">
          <input type="checkbox" data-service-pick value="${esc(x.id)}" ${chosen.has(x.id) ? 'checked' : ''}> <span class="font-bold text-gray-900">${esc(x.name)}</span>
          <span class="text-gray-500">${esc(x.durationMinutes)} min${x.price ? ` · ${esc(x.price)}` : ''}</span></label>`).join('')}</div>
        <p class="text-xs text-gray-500 mt-1">Tick none to offer all of them.</p>${hoursNote}`;
    }
    if (f.kind === 'productPick') {
      // Business Information products, in their own order. Prices are changed THERE, never here.
      const chosen = new Set((Array.isArray(value) ? value : []).map(Number));
      const list = (state.data.catalogue || []);
      const legacy = state.editing && Array.isArray(state.editing.props.items) && state.editing.props.items.length && !chosen.size;
      return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p>
        ${legacy ? `<div class="bg-amber-50 border border-amber-200 rounded-lg p-3 mt-1"><p class="text-xs text-amber-800">This section has ${esc(state.editing.props.items.length)} item${state.editing.props.items.length === 1 ? '' : 's'} typed in here. Products and prices now live in Business Information, so they're kept in one place.</p>
          <div class="mt-2">${btn('data-site-products-import', 'Move them into Business Information', true)}</div></div>` : ''}
        ${list.length ? `<div class="space-y-1 mt-1">${list.map((p) => `
          <label class="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 text-xs cursor-pointer">
            <input type="checkbox" data-product-pick value="${esc(p.id)}" ${chosen.has(p.id) ? 'checked' : ''}>
            ${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" style="width:32px;height:32px;object-fit:cover;border-radius:6px">` : ''}
            <span class="font-bold text-gray-900">${esc(p.name)}</span>
            <span class="text-gray-500">${esc(p.price || 'No price shown')}</span>
            ${p.buyable ? '<span class="ml-auto text-green-700 font-bold">Can be bought online</span>' : ''}
          </label>`).join('')}</div>`
          : '<p class="text-xs text-gray-500 mt-1">You haven\'t added any products or services yet.</p>'}
        <p class="text-xs text-gray-500 mt-2">Add products, or change a name, price or picture, in ${btn('data-site-open-products', 'Business Information ▸ Products & Services')} — every page and checkout follows. Only fixed prices can be bought online.</p>`;
    }
    if (f.kind === 'reviewPick') {
      const rv = state.data.reviews || { list: [], summary: null };
      const chosen = (Array.isArray(value) ? value : []).map(Number);
      const starsOf = (n) => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : 'No stars');
      // Ticked ones first, in the order they will appear; then the rest, newest first.
      const ordered = [...chosen.map((id) => rv.list.find((r) => r.id === id)).filter(Boolean), ...rv.list.filter((r) => !chosen.includes(r.id))];
      return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p>
        ${rv.summary ? `<p class="text-xs text-gray-600 mt-1">Your average: <strong>${esc(rv.summary.average.toFixed(1))}</strong> from ${esc(rv.summary.rated)} rated review${rv.summary.rated === 1 ? '' : 's'}.</p>` : ''}
        ${rv.list.length ? `<div class="space-y-1 mt-1 max-h-72 overflow-y-auto">${ordered.map((r) => `
          <label class="flex items-start gap-2 border border-gray-200 rounded-lg px-3 py-2 text-xs cursor-pointer">
            <input type="checkbox" data-review-pick value="${esc(r.id)}" ${chosen.includes(r.id) ? 'checked' : ''} class="mt-0.5">
            <span class="min-w-0"><span class="text-amber-500">${esc(starsOf(r.rating))}</span> <span class="font-bold text-gray-900">${esc(r.authorName)}</span>
              <span class="block text-gray-600 truncate">${esc(r.body)}</span></span></label>`).join('')}</div>
          <p class="text-xs text-gray-500 mt-1">Tick none to show your newest reviews automatically.</p>`
          : '<p class="text-xs text-gray-500 mt-1">You haven\'t added any reviews yet.</p>'}
        <p class="text-xs text-gray-500 mt-2">Add, edit or hide reviews in ${btn('data-site-open-reviews', 'Business Information ▸ Reviews')} — or paste them into this chat.</p>`;
    }
    if (f.kind === 'gallery') {
      const list = Array.isArray(value) ? value : [];
      return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)} <span class="font-normal text-gray-500">(${list.length} of 24)</span></p>
        <div data-gallery class="space-y-2 mt-1">${list.map((im, i) => {
          const src = im.assetId ? thumbOf(im.assetId) : (im.url || '');
          return `<div class="flex gap-3 border border-gray-200 rounded-lg p-2" data-gallery-item>
            <input type="hidden" data-g-asset value="${esc(im.assetId || '')}"><input type="hidden" data-g-url value="${esc(im.assetId ? '' : (im.url || ''))}">
            ${src ? `<img src="${esc(src)}" alt="" style="width:72px;height:72px;object-fit:cover;border-radius:8px;flex-shrink:0">` : '<span style="width:72px;height:72px;flex-shrink:0" class="bg-gray-100 rounded-lg"></span>'}
            <div class="flex-1 min-w-0">
              <input data-g-alt class="${inputCls} ${im.alt ? '' : 'border-amber-500'}" placeholder="What the picture shows (needed)" value="${esc(im.alt || '')}">
              <input data-g-caption class="${inputCls} mt-1" placeholder="Caption under it (optional)" value="${esc(im.caption || '')}">
              <div class="flex gap-3 mt-1 text-xs">
                ${i > 0 ? `<button type="button" data-gallery-move="${i}" data-to="${i - 1}" class="text-gray-600 underline">Move up</button>` : ''}
                ${i < list.length - 1 ? `<button type="button" data-gallery-move="${i}" data-to="${i + 1}" class="text-gray-600 underline">Move down</button>` : ''}
                <button type="button" data-gallery-remove="${i}" class="text-gray-500 underline">Remove</button>
              </div>
            </div>
          </div>`;
        }).join('')}</div>
        ${list.length < 24 ? `<div class="mt-2">${btn('data-gallery-add', list.length ? 'Add more pictures' : 'Choose pictures', !list.length)}</div>` : ''}
        <p class="text-xs text-gray-500 mt-1">Each picture needs a few words on what it shows — for people using screen readers, and for search engines. Visitors can tap a picture to see it full size.</p>`;
    }
    if (f.kind === 'menuGroups') {
      // One box per group: its name, then a tick for each Business Information product. A product
      // ticked in one group is greyed out in the others (each appears once on the menu).
      const groups = Array.isArray(value) && value.length ? value : [{ title: '', productIds: [] }];
      const list = state.data.catalogue || [];
      const owner = {};
      groups.forEach((g, gi) => (g.productIds || []).forEach((id) => { if (!(id in owner)) owner[id] = gi; }));
      if (!list.length) return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p><p class="text-xs text-gray-500">You haven't added any products or services yet. Add them, with their prices, in ${btn('data-site-open-products', 'Business Information ▸ Products & Services')}.</p>`;
      return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p>
        <div data-menu-groups class="space-y-2 mt-1">${groups.map((g, gi) => `
          <div class="border border-gray-200 rounded-lg p-3" data-menu-group>
            <div class="flex items-center gap-2"><input data-menu-title class="${inputCls}" placeholder="Group name — e.g. Starters, Cuts & colour (optional)" value="${esc(g.title || '')}">
              ${groups.length > 1 ? `<button type="button" data-menu-group-remove="${gi}" class="text-xs text-gray-500 underline whitespace-nowrap">Remove group</button>` : ''}</div>
            <div class="grid gap-1 mt-2 sm:grid-cols-2">${list.map((p) => {
              const mine = owner[p.id] === gi;
              const elsewhere = p.id in owner && !mine;
              return `<label class="flex items-center gap-2 text-xs ${elsewhere ? 'text-gray-400' : 'text-gray-800'} cursor-pointer">
                <input type="checkbox" data-menu-pick value="${esc(p.id)}" ${mine ? 'checked' : ''} ${elsewhere ? 'disabled' : ''}>
                <span class="font-bold">${esc(p.name)}</span><span class="text-gray-500">${esc(p.price || 'No price shown')}</span>${elsewhere ? '<span>(in another group)</span>' : ''}</label>`;
            }).join('')}</div>
          </div>`).join('')}</div>
        <button type="button" data-menu-group-add class="text-xs text-gray-600 underline mt-2">+ Add a group</button>
        <p class="text-xs text-gray-500 mt-2">Items appear in Business Information order. Change a name, price or description in ${btn('data-site-open-products', 'Business Information ▸ Products & Services')} — the menu follows. Nothing on a menu is bought online; use a Products for sale section for that.</p>`;
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
        const assetId = Number(form.querySelector(`[name="${n}-asset"]`).value) || null;
        const url = form.querySelector(`[name="${n}-url"]`).value.trim();
        const alt = form.querySelector(`[name="${n}-alt"]`).value.trim();
        props[f.k] = assetId ? { assetId, url: '', alt } : url ? { url, alt } : null;
      } else if (f.kind === 'servicePick') {
        props[f.k] = [...form.querySelectorAll('[data-service-pick]:checked')].map((el) => Number(el.value));
      } else if (f.kind === 'reviewPick') {
        props[f.k] = [...form.querySelectorAll('[data-review-pick]:checked')].map((el) => Number(el.value));
      } else if (f.kind === 'gallery') {
        props[f.k] = [...form.querySelectorAll('[data-gallery-item]')].map((row) => {
          const assetId = Number(row.querySelector('[data-g-asset]').value) || null;
          const base = { alt: row.querySelector('[data-g-alt]').value.trim(), caption: row.querySelector('[data-g-caption]').value.trim() };
          return assetId ? { ...base, assetId, url: '' } : { ...base, url: row.querySelector('[data-g-url]').value };
        });
      } else if (f.kind === 'menuGroups') {
        props[f.k] = [...form.querySelectorAll('[data-menu-group]')].map((g) => ({
          title: g.querySelector('[data-menu-title]').value,
          productIds: [...g.querySelectorAll('[data-menu-pick]:checked')].map((el) => Number(el.value)),
        }));
      } else if (f.kind === 'productPick') {
        props[f.k] = [...form.querySelectorAll('[data-product-pick]:checked')].map((el) => Number(el.value));
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

  // ── How a section looks (site-definition.ts SectionLook — a closed set of choices) ──────────
  const LOOK_DEFAULT = { background: 'auto', columns: 'auto', menuLabel: null };
  const GRID_TYPES = ['features', 'steps', 'testimonials', 'products', 'menu', 'gallery', 'reviews'];
  function lookHtml(e) {
    const l = e.look || LOOK_DEFAULT;
    const onePage = def().structure === 'one_page';
    const sel = (name, options, value) => `<select name="${name}" class="${inputCls}">${options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    const bg = e.type === 'hero' ? '' : `<div><label class="block text-xs font-bold text-gray-700">Background</label>${sel('look-background', [['auto', 'Automatic'], ['plain', 'Plain'], ['soft', 'Soft tint'], ['brand', 'Your main colour']], l.background)}</div>`;
    const cols = GRID_TYPES.includes(e.type) ? `<div><label class="block text-xs font-bold text-gray-700">Columns on a wide screen</label>${sel('look-columns', [['auto', 'Automatic'], ['2', 'Two'], ['3', 'Three']], l.columns)}</div>` : '';
    const menu = onePage || l.menuLabel ? `<div><label class="block text-xs font-bold text-gray-700">Menu label${onePage ? '' : ' (one-page sites)'}</label><input name="look-menu" class="${inputCls}" maxlength="30" value="${esc(l.menuLabel || '')}" placeholder="e.g. Prices — leave empty to keep it out of the menu"></div>` : '';
    if (!bg && !cols && !menu) return '';
    return `<details class="mt-4 border border-gray-200 rounded-lg p-3" ${l.background !== 'auto' || l.columns !== 'auto' || l.menuLabel ? 'open' : ''}>
      <summary class="text-xs font-bold text-gray-700 cursor-pointer">Look${onePage ? ' & menu' : ''}</summary>
      <div class="grid gap-3 md:grid-cols-2 mt-2">${bg}${cols}${menu}</div></details>`;
  }
  function readLook(form) {
    const v = (n) => { const el = form.querySelector(`[name="${n}"]`); return el ? el.value : undefined; };
    const out = {};
    if (v('look-background') !== undefined) out.background = v('look-background');
    if (v('look-columns') !== undefined) out.columns = v('look-columns') === 'auto' ? 'auto' : Number(v('look-columns'));
    if (v('look-menu') !== undefined) out.menuLabel = v('look-menu').trim() || null;
    return out;
  }
  /** Keep what is typed in the open form (props AND look) across a re-render. */
  function syncEditing(form) {
    state.editing.props = readForm(form, state.editing.type);
    state.editing.look = { ...(state.editing.look || LOOK_DEFAULT), ...readLook(form) };
  }

  function editorHtml() {
    const e = state.editing;
    return card(`
      <form data-site-section-form>
        <div class="flex items-center justify-between"><p class="text-sm font-black text-gray-900">${e.sectionId ? 'Edit' : 'Add'} ${esc(TYPE_LABEL[e.type])}</p>
          <button type="button" data-site-edit-cancel class="text-xs text-gray-500 underline">Cancel</button></div>
        ${FORMS[e.type].map((f) => fieldHtml(f, e.props[f.k])).join('')}
        ${lookHtml(e)}
        <div class="mt-4">${btn('data-site-section-save type="submit"', e.sectionId ? 'Save section' : 'Add section', true).replace('type="button" ', '')}</div>
      </form>`);
  }

  function pagesPanel() {
    const d = def();
    const p = page();
    const pageTabs = d.pages.map((x) => `<button type="button" data-site-page="${esc(x.id)}" class="px-3 py-1.5 text-xs font-bold rounded-lg border ${x.id === p.id ? 'btn-primary' : 'btn-secondary'}">${esc(x.title)}</button>`).join(' ');
    const sections = p.sections.map((s, i) => `
      <li class="border border-gray-200 rounded-lg p-3 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0"><p class="text-xs font-bold text-gray-900">${esc(TYPE_LABEL[s.type])}${s.look && s.look.menuLabel && d.structure === 'one_page' ? ` <span class="font-semibold text-indigo-700">· In the menu as “${esc(s.look.menuLabel)}”</span>` : ''}</p><p class="text-xs text-gray-500 truncate">${esc(sectionSummary(s))}</p></div>
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
        ${p.slug ? `<label class="flex items-center gap-2 text-xs font-bold text-gray-700 mt-3"><input type="checkbox" data-site-page-hidden ${p.hideFromMenu ? 'checked' : ''}> Hide from the menu <span class="font-normal text-gray-500">— still there for anyone with its address, e.g. a page for an ad or an offer</span></label>` : ''}
        <div class="flex flex-wrap gap-2 mt-3">${btn('data-site-page-save', 'Save page details', true)}${p.slug ? btn('data-site-remove-page', 'Remove this page') : ''}</div>`)}
      ${structureCard()}
      ${wordsCard(p)}
      ${state.editing ? editorHtml() : ''}
      ${card(`
        <p class="text-sm font-black text-gray-900 mb-3">Sections on this page</p>
        <ul class="space-y-2">${sections || '<li class="text-xs text-gray-500">No sections yet.</li>'}</ul>
        <div class="flex flex-wrap gap-2 items-center mt-4"><select data-site-new-type class="${inputCls}" style="max-width:220px">${state.data.vocab.sectionTypes.map((t) => `<option value="${esc(t)}">${esc(TYPE_LABEL[t] || t)}</option>`).join('')}</select>${btn('data-site-new-section', 'Add a section')}</div>`)}`;
  }

  // ── "Add your own words" (site-words.ts — the owner's wording is used unchanged) ──────────
  function wordsCard(p) {
    const w = state.words;
    if (w.proposal && w.pageId === p.id) {
      const pr = w.proposal;
      return card(`
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-black text-gray-900">Here's where your words would go</p>
          <span class="text-xs font-bold text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">Your wording, unchanged</span>
        </div>
        <p class="text-xs text-gray-600 mt-1">${esc(pr.summary)}</p>
        <ul class="space-y-2 mt-3">${pr.preview.map((x) => `
          <li class="border border-gray-200 rounded-lg p-3">
            <p class="text-xs font-bold text-gray-900">${esc(x.label)}</p>
            ${x.text ? `<p class="text-xs text-gray-700 mt-1" style="white-space:pre-wrap">${esc(x.text)}</p>` : ''}
          </li>`).join('')}</ul>
        <div class="flex flex-wrap gap-2 mt-3">${btn('data-site-words-apply', 'Apply to my page', true)}${btn('data-site-words-discard', 'Discard')}</div>
        <p class="text-xs text-gray-500 mt-2">Nothing has changed yet. After you apply, you can still edit any section.</p>`, 'border-green-200');
    }
    if (!w.open || w.pageId !== p.id) {
      return card(`<div class="flex flex-wrap items-center justify-between gap-2">
        <div><p class="text-sm font-black text-gray-900">Have your own words for this page?</p>
        <p class="text-xs text-gray-500 mt-1">Paste them in or drop in a Word document or PDF — they're placed on the page exactly as you wrote them.</p></div>
        ${btn('data-site-words-open', 'Add your own words', true)}</div>`);
    }
    return card(`
      <p class="text-sm font-black text-gray-900">Add your own words to "${esc(p.title)}"</p>
      <p class="text-xs text-gray-500 mt-1">They're split into headings and paragraphs and placed on the page word for word — nothing is reworded. You'll see where everything goes before anything changes.</p>
      <textarea data-site-words-text rows="7" class="${inputCls} mt-3" placeholder="Paste your words here">${esc(w.text)}</textarea>
      <label data-site-words-drop class="block border-2 border-dashed border-gray-300 rounded-xl p-3 text-center cursor-pointer mt-2">
        <input type="file" hidden data-site-words-file accept=".docx,.pdf,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain">
        <span class="block text-xs font-bold text-gray-800">${w.file ? `📄 ${esc(w.file.name)} — choose a different file` : 'Or choose a file — Word (.docx), PDF or text'}</span>
        <span class="block text-xs text-gray-500">Click, or drag it here</span>
      </label>
      <input data-site-words-note class="${inputCls} mt-2" placeholder="Anything to know? e.g. this replaces the text about us" value="${esc(w.note)}">
      ${w.error ? `<p class="text-xs font-semibold text-red-600 mt-2">${esc(w.error)}</p>` : ''}
      <div class="flex flex-wrap gap-2 items-center mt-3">
        ${btn(`data-site-words-place ${w.busy ? 'disabled' : ''}`, w.busy ? 'Placing your words…' : 'Place my words', true)}
        ${btn('data-site-words-cancel', 'Cancel')}
        <span class="text-xs text-gray-500">Uses 1 task.</span>
      </div>`);
  }

  /** A chosen file → { name, type, data(base64) } for the `words` action (4 MB limit, as the server). */
  function readWordsFile(file) {
    return new Promise((resolve, reject) => {
      if (file.size > 4 * 1024 * 1024) { reject(new Error('That file is too large (the limit is 4 MB). Paste the words in instead.')); return; }
      const r = new FileReader();
      r.onload = () => resolve({ name: file.name, type: file.type, data: String(r.result).replace(/^data:[^,]*,/, '') });
      r.onerror = () => reject(new Error('That file couldn\'t be read.'));
      r.readAsDataURL(file);
    });
  }
  async function chooseWordsFile(file) {
    try { state.words.file = await readWordsFile(file); state.words.error = null; } catch (err) { state.words.error = err.message; }
    render();
  }
  const keepWordsDraft = (host) => {
    const t = host.querySelector('[data-site-words-text]'); const n = host.querySelector('[data-site-words-note]');
    if (t) state.words.text = t.value;
    if (n) state.words.note = n.value;
  };

  // ── One page or several (site-definition.ts structure / combine_pages) ─────────────────────
  function structureCard() {
    const d = def();
    const one = d.structure === 'one_page';
    return card(`
      <p class="text-sm font-black text-gray-900">How your site is laid out</p>
      <div class="flex flex-wrap gap-4 mt-2 text-xs">
        <label class="flex items-center gap-2"><input type="radio" name="site-structure" value="pages" data-site-structure ${one ? '' : 'checked'}> <span><strong>Several pages</strong> — the menu lists your pages</span></label>
        <label class="flex items-center gap-2"><input type="radio" name="site-structure" value="one_page" data-site-structure ${one ? 'checked' : ''}> <span><strong>One page</strong> — everything on one page; the menu jumps down it</span></label>
      </div>
      ${one ? '<p class="text-xs text-gray-500 mt-2">Give a section a <strong>Menu label</strong> (Edit ▸ Look &amp; menu) to put it in the menu. Other pages stay reachable by their address.</p>' : ''}
      ${d.pages.length > 1 ? `<div class="mt-3">${btn('data-site-combine', 'Combine everything into one page')}<p class="text-xs text-gray-500 mt-1">Moves every page's sections onto the home page, in order, and puts each page in the menu. Earlier versions are kept if you change your mind.</p></div>` : ''}`);
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
        <div class="md:col-span-2"><p class="block text-xs font-bold text-gray-700">Logo</p>
          ${pictureHtml(t.logoAssetId ? { assetId: t.logoAssetId, url: '' } : (t.logoUrl ? { url: t.logoUrl } : null), { pick: 'data-site-logo-pick', clear: 'data-site-logo-clear' })}
          <details class="mt-1" ${!t.logoAssetId && t.logoUrl ? 'open' : ''}><summary class="text-xs text-gray-500 cursor-pointer">Use a web address instead</summary>
            <input data-theme="logoUrl" class="${inputCls} mt-1" placeholder="https://… logo address" value="${esc(t.logoAssetId ? '' : (t.logoUrl || ''))}"></details></div>
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
      <div class="mt-3">${action}</div>
      ${state.paymentsError ? `<p class="text-xs font-semibold text-red-600 mt-2" role="alert">${esc(state.paymentsError)}</p>` : ''}`);
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

  // ── Bookings (bookings.ts) ─────────────────────────────────────────────────
  const BOOKING_TONE = { awaiting_payment: ['Paying the deposit…', 'text-gray-500'], pending: ['Waiting for you', 'text-indigo-700'], confirmed: ['Confirmed', 'text-green-700'], declined: ['Declined', 'text-gray-500'], cancelled: ['Cancelled', 'text-gray-500'] };
  function bookingsPanel() {
    const b = state.data.booking || {};
    const head = card(`<p class="text-sm font-black text-gray-900">Bookings</p>
      <p class="text-xs text-gray-500 mt-1">${b.ready ? `Opening hours: ${esc(b.hours)}. ${b.mode === 'instant' ? 'Bookings are confirmed straight away.' : 'You confirm each booking.'}` : 'Set your opening hours to take bookings on your site.'} ${btn('data-site-open-hours', 'Hours, location & bookings')}</p>
      <p class="text-xs text-gray-500 mt-1">Add a "Bookings" section to a page to show it on your website.</p>`);
    const list = state.bookings;
    const tt = timetableCard();
    if (!list) return head + tt + card('<p class="text-sm text-gray-400 text-center">Loading bookings…</p>');
    if (!list.length) return head + tt + card('<p class="text-xs text-gray-500">No bookings yet. They appear here, and in your email, as they come in.</p>');
    const now = Date.now();
    const order = (x) => (x.status === 'pending' ? 0 : 1);
    const sorted = list.slice().sort((a, c) => order(a) - order(c) || new Date(a.startsAt) - new Date(c.startsAt));
    return head + tt + card(`<ul class="space-y-2">${sorted.map((x) => {
      let [label, tone] = BOOKING_TONE[x.status] || [x.status, 'text-gray-500'];
      if (x.status === 'cancelled') label = x.cancelledBy === 'customer' ? 'Cancelled by them' : 'Cancelled by you';
      if (x.moved && x.status !== 'cancelled') label += ' · moved by them';
      const past = new Date(x.startsAt).getTime() < now;
      return `<li class="border ${x.status === 'pending' ? 'border-indigo-200' : 'border-gray-200'} rounded-lg p-3 ${past ? 'opacity-70' : ''}">
        <div class="flex flex-wrap items-center justify-between gap-2"><p class="text-xs font-bold text-gray-900">${esc(x.when)}</p><span class="text-xs font-bold ${tone}">${esc(label)}</span></div>
        <p class="text-xs text-gray-800 mt-1">${esc(x.what)} · ${esc(x.customerName)}${x.reminded ? ' <span class="text-gray-500">· reminder sent</span>' : ''}</p>
        <p class="text-xs text-gray-600 mt-1"><a class="underline" href="mailto:${esc(x.customerEmail)}">${esc(x.customerEmail)}</a>${x.customerPhone ? ` · <a class="underline" href="tel:${esc(x.customerPhone)}">${esc(x.customerPhone)}</a>` : ''}</p>
        ${x.notes ? `<p class="text-xs text-gray-700 mt-1" style="white-space:pre-wrap">${esc(x.notes)}</p>` : ''}
        ${x.deposit ? `<p class="text-xs font-semibold ${/failed/.test(x.deposit) ? 'text-red-600' : 'text-gray-700'} mt-1">${esc(x.deposit)}</p>` : ''}
        ${!past && (x.status === 'pending' || x.status === 'confirmed') ? `<div class="flex flex-wrap gap-2 mt-2">
          ${x.status === 'pending' ? btn(`data-site-booking="${esc(x.id)}" data-decision="confirm"`, 'Confirm', true) + btn(`data-site-booking="${esc(x.id)}" data-decision="decline"`, 'Decline') : ''}
          ${x.status === 'confirmed' ? btn(`data-site-booking="${esc(x.id)}" data-decision="cancel"`, 'Cancel booking') : ''}</div>` : ''}
      </li>`;
    }).join('')}</ul>`);
  }
  async function loadBookings() {
    try {
      const [bk, tt] = await Promise.all([post({ action: 'bookings', assistantId: state.assistantId }), post({ action: 'timetable', assistantId: state.assistantId })]);
      state.bookings = bk.bookings || [];
      state.timetable = tt.sessions || [];
    } catch (err) { state.bookings = state.bookings || []; state.timetable = state.timetable || []; state.note = { text: err.message, tone: 'error' }; }
    rerender();
  }

  // ── Classes and events (class-sessions.ts): dated sessions with places ──────────────────────
  // The class itself is a Business Information product (its name, price, description); a session is
  // when and how many. Shown on the site by a Bookings section set to "Classes and events".
  function timetableCard() {
    const tt = state.timetable;
    const classes = (state.data.catalogue || []);
    const people = ((state.data.booking || {}).resources || []).filter((r) => r.kind !== 'table');
    const f = state.sessionDraft || {};
    const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
    const form = classes.length ? `<div class="grid gap-2 md:grid-cols-2 mt-3" data-session-form>
        <label class="text-xs font-bold text-gray-700">Class or event<select data-sf="serviceId" class="${inputCls} mt-1">${classes.map((c) => opt(c.id, `${c.name}${c.price ? ` · ${c.price}` : ''}`, f.serviceId)).join('')}</select></label>
        <label class="text-xs font-bold text-gray-700">Teacher or room <span class="font-normal text-gray-500">(optional)</span><select data-sf="resourceId" class="${inputCls} mt-1">${opt('', 'None', f.resourceId)}${people.map((r) => opt(r.id, r.name, f.resourceId)).join('')}</select></label>
        <label class="text-xs font-bold text-gray-700">Date<input type="date" data-sf="date" class="${inputCls} mt-1" value="${esc(f.date || '')}"></label>
        <div class="grid grid-cols-2 gap-2"><label class="text-xs font-bold text-gray-700">Starts<input type="time" data-sf="start" class="${inputCls} mt-1" value="${esc(f.start || '18:00')}"></label>
          <label class="text-xs font-bold text-gray-700">Ends<input type="time" data-sf="end" class="${inputCls} mt-1" value="${esc(f.end || '19:00')}"></label></div>
        <label class="text-xs font-bold text-gray-700">Places<input type="number" min="1" max="500" data-sf="capacity" class="${inputCls} mt-1" value="${esc(f.capacity || 12)}"></label>
        <label class="text-xs font-bold text-gray-700">Repeat<select data-sf="repeatWeeks" class="${inputCls} mt-1">${[[0, 'Just this date (an event)'], [3, 'Weekly for 4 weeks'], [7, 'Weekly for 8 weeks'], [11, 'Weekly for 12 weeks'], [25, 'Weekly for 26 weeks']].map(([v, l]) => opt(v, l, f.repeatWeeks ?? 0)).join('')}</select></label>
        <label class="text-xs font-bold text-gray-700 md:col-span-2">Note for customers <span class="font-normal text-gray-500">(optional — e.g. bring a mat)</span><input data-sf="notes" maxlength="300" class="${inputCls} mt-1" value="${esc(f.notes || '')}"></label>
        <div class="md:col-span-2">${btn('data-session-add', 'Add to the timetable', true)}</div></div>`
      : `<p class="text-xs text-gray-500 mt-2">First add your classes or events (with their prices) in ${btn('data-site-open-products', 'Business Information ▸ Products & Services')}.</p>`;
    const now = Date.now();
    const rows = !tt ? '<p class="text-xs text-gray-400 mt-3">Loading…</p>'
      : !tt.length ? '<p class="text-xs text-gray-500 mt-3">Nothing on the timetable yet.</p>'
        : `<ul class="space-y-2 mt-3">${tt.map((x) => {
          const past = new Date(x.endsAt).getTime() < now;
          const off = x.status === 'cancelled';
          return `<li class="border border-gray-200 rounded-lg p-3 ${past || off ? 'opacity-60' : ''}">
            <div class="flex flex-wrap items-center justify-between gap-2"><p class="text-xs font-bold text-gray-900">${esc(x.dateText)}, ${esc(x.timeText)} · ${esc(x.title)}${x.resourceName ? ` with ${esc(x.resourceName)}` : ''}</p>
              <span class="text-xs font-bold ${off ? 'text-gray-500' : x.left === 0 ? 'text-amber-700' : 'text-green-700'}">${off ? 'Cancelled' : `${esc(x.taken)} of ${esc(x.capacity)} booked${x.waiting ? ` · ${esc(x.waiting)} waiting` : ''}`}</span></div>
            ${x.people.length ? `<p class="text-xs text-gray-600 mt-1">${x.people.map((p) => `${esc(p.name)}${p.places > 1 ? ` ×${esc(p.places)}` : ''}${p.status === 'pending' ? ' (to confirm)' : ''}`).join(', ')}</p>` : ''}
            ${!past && !off ? `<div class="flex flex-wrap gap-2 mt-2">${btn(`data-session-cancel="${esc(x.id)}"`, 'Cancel this date')}${x.seriesKey ? btn(`data-session-cancel="${esc(x.id)}" data-series="1"`, 'Cancel this and later dates') : ''}</div>` : ''}
          </li>`;
        }).join('')}</ul>`;
    return card(`<p class="text-sm font-black text-gray-900">Timetable — classes &amp; events</p>
      <p class="text-xs text-gray-500 mt-1">Dated sessions with a number of places. Show them on your site with a Bookings section set to "Classes and events"; people book places, and join a waitlist when it's full.</p>${form}${rows}`);
  }
  function readSessionForm(scope) {
    const o = {};
    scope.querySelectorAll('[data-sf]').forEach((el) => { o[el.dataset.sf] = el.value; });
    return o;
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
    const waiting = (state.data.booking && state.data.booking.waiting) || 0;
    const tabs = [['pages', 'Pages'], ['design', 'Design'], ['details', 'Details'], ['enquiries', newCount ? `Enquiries (${newCount} new)` : 'Enquiries'], ['orders', newOrders ? `Orders (${newOrders} new)` : 'Orders'], ['bookings', waiting ? `Bookings (${waiting} waiting)` : 'Bookings']].map(([k, l]) => btn(`data-site-panel="${k}"`, esc(l), state.panel === k)).join(' ');
    host.innerHTML = `
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="space-y-4 min-w-0">
          ${publishCard()}
          ${placeholdersCard()}
          <div class="flex flex-wrap gap-2">${tabs}</div>
          ${noteHtml()}
          ${state.panel === 'pages' ? pagesPanel() : state.panel === 'design' ? designPanel() : state.panel === 'enquiries' ? enquiriesPanel() : state.panel === 'orders' ? ordersPanel() : state.panel === 'bookings' ? bookingsPanel() : detailsPanel()}
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
    const look = readLook(form);
    const op = ed.sectionId
      ? { op: 'update_section', pageId: ed.pageId, sectionId: ed.sectionId, props, look }
      : { op: 'add_section', pageId: ed.pageId, section: { type: ed.type, props, look } };
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
      if (state.panel === 'bookings') { state.bookings = null; loadBookings(); }
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
      // The message goes beside the button: the page-level note sits above the tabs, out of sight down
      // here, so a failure used to look like nothing happening but a preview refresh.
      state.paymentsError = null;
      try {
        const r = await post({ action: 'payments_connect', assistantId: state.assistantId });
        if (!r.url) throw new Error('Stripe didn\'t send a link to continue. Try again in a minute.');
        window.location.href = r.url;
      } catch (err) { state.paymentsError = err.message; render(); }
      return;
    }
    const pg = t('[data-site-page]');
    if (pg) { state.pageId = pg.dataset.sitePage; state.editing = null; state.previewPath = pathOf(page()); render(); return; }
    const dev = t('[data-site-device]');
    if (dev) { state.device = dev.dataset.siteDevice; render(); return; }
    if (t('[data-site-edit-cancel]')) { state.editing = null; render(); return; }

    const edit = t('[data-site-edit]');
    if (edit) { const s = p.sections.find((x) => x.id === edit.dataset.siteEdit); state.editing = { pageId: p.id, sectionId: s.id, type: s.type, props: JSON.parse(JSON.stringify(s.props)), look: { ...LOOK_DEFAULT, ...(s.look || {}) } }; render(); return; }
    if (t('[data-site-new-section]')) {
      const type = document.querySelector('[data-site-new-type]').value;
      if (!FORMS[type]) return;   // a type this editor has no form for — nothing to open
      state.editing = { pageId: p.id, sectionId: null, type, props: JSON.parse(JSON.stringify(BLANK[type] || {})), look: { ...LOOK_DEFAULT } };
      render();
      return;
    }
    // ── Add your own words ──
    if (t('[data-site-words-open]')) { Object.assign(state.words, { open: true, pageId: p.id, error: null, proposal: null }); render(); return; }
    if (t('[data-site-words-cancel]')) { Object.assign(state.words, { open: false, file: null, error: null, text: '', note: '' }); render(); return; }
    if (t('[data-site-words-discard]')) { Object.assign(state.words, { proposal: null, open: true }); render(); return; }
    if (t('[data-site-words-place]')) {
      keepWordsDraft(hostOf(e));
      const w = state.words;
      if (!w.text.trim() && !w.file) { w.error = 'Paste your words in, or choose a file.'; render(); return; }
      w.busy = true; w.error = null; render();
      try {
        const r = await post({ action: 'words', assistantId: state.assistantId, pageId: p.id, text: w.text, note: w.note, ...(w.file ? { file: w.file } : {}) });
        w.proposal = r.proposal;
      } catch (err) { w.error = err.message; }
      w.busy = false;
      render();
      return;
    }
    if (t('[data-site-words-apply]')) {
      const ops = state.words.proposal ? state.words.proposal.ops : [];
      await apply(ops, () => { Object.assign(state.words, { open: false, proposal: null, file: null, text: '', note: '', error: null }); });
      return;
    }

    // ── Pictures (media-picker.js) ──
    const pickField = t('[data-site-pick]');
    if (pickField && window.MediaPicker) {
      const form = pickField.closest('form');
      window.MediaPicker.open({
        title: 'Choose a picture',
        onPick: (asset) => {
          state.thumbs[asset.id] = asset.url;
          syncEditing(form);
          const k = pickField.dataset.sitePick;
          const prev = state.editing.props[k] || {};
          state.editing.props[k] = { assetId: asset.id, url: '', alt: prev.alt || altFromName(asset.name) };
          render();
        },
      });
      return;
    }
    const clearField = t('[data-site-pick-clear]');
    if (clearField) { const form = clearField.closest('form'); syncEditing(form); state.editing.props[clearField.dataset.sitePickClear] = null; render(); return; }
    if (t('[data-site-products-import]')) {
      // An older products section: its typed-in items become Business Information products.
      const ed = state.editing;
      const ok = await window.confirmModal('Each item becomes a product in Business Information ▸ Products & Services, with its price. From then on you change names and prices there, and every page and checkout follows.', { title: 'Move these items into Business Information?', confirmLabel: 'Move them', cancelLabel: 'Not now' });
      if (!ok || !ed) return;
      await publishAction({ action: 'products_import', sectionId: ed.sectionId }, 'Moved into Business Information.', () => { state.editing = null; });
      return;
    }
    if (t('[data-site-open-products]')) { window._bizinfoInitialTab = 'products'; if (typeof window.loadView === 'function') window.loadView('assets'); return; }
    if (t('[data-site-open-reviews]')) { window._bizinfoInitialTab = 'reviews'; if (typeof window.loadView === 'function') window.loadView('assets'); return; }
    if (t('[data-site-open-hours]')) { window._bizinfoInitialTab = 'hours'; if (typeof window.loadView === 'function') window.loadView('assets'); return; }
    const sAdd = t('[data-session-add]');
    if (sAdd) {
      const draft = readSessionForm(sAdd.closest('[data-session-form]'));
      state.sessionDraft = draft;
      try {
        const r = await post({ action: 'session_add', assistantId: state.assistantId, session: { ...draft, serviceId: Number(draft.serviceId), capacity: Number(draft.capacity), repeatWeeks: Number(draft.repeatWeeks), resourceId: draft.resourceId ? Number(draft.resourceId) : null } });
        state.timetable = r.sessions || state.timetable;
        state.sessionDraft = { ...draft, date: '' };
        state.note = { text: r.added === 1 ? 'Added to the timetable.' : `${r.added} dates added to the timetable.`, tone: 'ok' };
      } catch (err) { state.note = { text: err.message, tone: 'error' }; }
      rerender();
      return;
    }
    const sCancel = t('[data-session-cancel]');
    if (sCancel) {
      const series = sCancel.dataset.series === '1';
      const x = (state.timetable || []).find((s) => s.id === Number(sCancel.dataset.sessionCancel));
      const booked = x ? x.taken : 0;
      const ok = await window.confirmModal(`${series ? 'This date and every later one in the series are' : 'This date is'} cancelled.${booked ? ` Everyone booked is emailed to say so.` : ''}`, { title: series ? 'Cancel this and later dates?' : 'Cancel this date?', confirmLabel: 'Cancel it', cancelLabel: 'Keep it' });
      if (!ok) return;
      try {
        const r = await post({ action: 'session_cancel', assistantId: state.assistantId, id: Number(sCancel.dataset.sessionCancel), wholeSeries: series });
        state.timetable = r.sessions || state.timetable;
        state.note = { text: `${r.cancelled === 1 ? 'Cancelled' : `${r.cancelled} dates cancelled`}${r.told ? ` — ${r.told} booking${r.told === 1 ? '' : 's'} cancelled and emailed` : ''}.`, tone: 'ok' };
      } catch (err) { state.note = { text: err.message, tone: 'error' }; }
      await loadBookings();
      return;
    }
    const dec = t('[data-site-booking]');
    if (dec) {
      const decision = dec.dataset.decision;
      if (decision !== 'confirm') {
        const ok = await window.confirmModal(decision === 'decline' ? 'They\'ll get an email saying you can\'t take it, and the time is freed up.' : 'They\'ll get an email saying it\'s cancelled, and the time is freed up.', { title: decision === 'decline' ? 'Decline this booking?' : 'Cancel this booking?', confirmLabel: decision === 'decline' ? 'Decline' : 'Cancel booking', cancelLabel: 'Keep it' });
        if (!ok) return;
      }
      try {
        await post({ action: 'booking_decide', assistantId: state.assistantId, id: Number(dec.dataset.siteBooking), decision });
        state.data = await post({ action: 'get', assistantId: state.assistantId });
      } catch (err) { state.note = { text: err.message, tone: 'error' }; }
      await loadBookings();
      return;
    }
    if (t('[data-site-logo-pick]') && window.MediaPicker) {
      window.MediaPicker.open({ title: 'Choose your logo', onPick: (asset) => { state.thumbs[asset.id] = asset.url; apply([{ op: 'set_theme', theme: { logoAssetId: asset.id } }]); } });
      return;
    }
    if (t('[data-site-logo-clear]')) { await apply([{ op: 'set_theme', theme: { logoAssetId: null, logoUrl: null } }]); return; }

    const gAdd = t('[data-gallery-add]');
    if (gAdd && window.MediaPicker) {
      const form = gAdd.closest('form');
      window.MediaPicker.open({
        title: 'Choose pictures for your gallery', multiple: true,
        onPickMany: (assets) => {
          syncEditing(form);
          const have = state.editing.props.images || [];
          const fresh = assets.filter((a) => !have.some((im) => im.assetId === a.id));
          fresh.forEach((a) => { state.thumbs[a.id] = a.url; });
          state.editing.props.images = [...have, ...fresh.map((a) => ({ assetId: a.id, url: '', alt: altFromName(a.name), caption: '' }))].slice(0, 24);
          render();
        },
      });
      return;
    }
    const gMove = t('[data-gallery-move]');
    if (gMove) {
      syncEditing(gMove.closest('form'));
      const list = state.editing.props.images;
      const [it] = list.splice(Number(gMove.dataset.galleryMove), 1);
      list.splice(Number(gMove.dataset.to), 0, it);
      render();
      return;
    }
    const gRm = t('[data-gallery-remove]');
    if (gRm) {
      syncEditing(gRm.closest('form'));
      state.editing.props.images.splice(Number(gRm.dataset.galleryRemove), 1);
      render();
      return;
    }
    const addGroup = t('[data-menu-group-add]');
    if (addGroup) {
      syncEditing(addGroup.closest('form'));
      state.editing.props.groups = [...(state.editing.props.groups || []), { title: '', productIds: [] }];
      render();
      return;
    }
    const rmGroup = t('[data-menu-group-remove]');
    if (rmGroup) {
      syncEditing(rmGroup.closest('form'));
      state.editing.props.groups.splice(Number(rmGroup.dataset.menuGroupRemove), 1);
      render();
      return;
    }
    const addItem = t('[data-item-add]');
    if (addItem) {
      const form = addItem.closest('form');
      syncEditing(form);
      state.editing.props[addItem.dataset.itemAdd] = [...(state.editing.props[addItem.dataset.itemAdd] || []), {}];
      render();
      return;
    }
    const rmItem = t('[data-item-remove]');
    if (rmItem) {
      const form = rmItem.closest('form');
      const key = rmItem.closest('[data-items]').dataset.items;
      syncEditing(form);
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
      const hidden = host.querySelector('[data-site-page-hidden]');
      if (hidden) op.hideFromMenu = hidden.checked;
      await apply([op], () => { state.previewPath = pathOf(page()); });
      return;
    }
    const structure = t('[data-site-structure]');
    if (structure) { if (structure.value !== def().structure) await apply([{ op: 'set_structure', structure: structure.value }]); return; }
    if (t('[data-site-combine]')) {
      const n = def().pages.length;
      const ok = await window.confirmModal(`All ${n} pages become one: their sections are moved onto the home page in order, the other pages are removed, and the menu jumps down the page. Buttons that linked to those pages now jump to their part of the page. If your site is live, publish again to show it — earlier published versions are kept.`, { title: 'Combine into one page?', confirmLabel: 'Combine', cancelLabel: 'Keep my pages' });
      if (ok) await apply([{ op: 'combine_pages' }], () => { state.pageId = def().pages[0].id; state.previewPath = '/'; });
      return;
    }
    if (t('[data-site-theme-save]')) {
      const theme = {};
      hostOf(e).querySelectorAll('[data-theme]').forEach((el) => { theme[el.dataset.theme] = el.value || (el.dataset.theme === 'logoUrl' ? null : el.value); });
      // A web address typed for the logo replaces a library logo; left empty, the library logo stays.
      if (theme.logoUrl) theme.logoAssetId = null; else delete theme.logoUrl;
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

  // The words file: picked, or dropped on the box (bound once, like every handler here).
  document.addEventListener('change', (e) => {
    const input = e.target.closest && e.target.closest('[data-site-words-file]');
    if (!input || !state.assistantId) return;
    keepWordsDraft(hostOf(e) || document);
    const f = input.files && input.files[0];
    input.value = '';
    if (f) chooseWordsFile(f);
  });
  // A product ticked in one menu group is greyed out in the others: redraw the form on each tick.
  document.addEventListener('change', (e) => {
    // A booking section switching to or from "Classes and events" offers a different service list.
    const kindSel = e.target.closest && e.target.closest('select[name="f-kind"]');
    if (kindSel && state.editing && state.editing.type === 'booking') { syncEditing(kindSel.closest('form')); render(); return; }
    const pick = e.target.closest && e.target.closest('[data-menu-pick]');
    if (!pick || !state.editing) return;
    syncEditing(pick.closest('form'));
    render();
  });
  document.addEventListener('dragover', (e) => { if (e.target.closest && e.target.closest('[data-site-words-drop]')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    const box = e.target.closest && e.target.closest('[data-site-words-drop]');
    if (!box || !state.assistantId) return;
    e.preventDefault();
    keepWordsDraft(hostOf(e) || document);
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) chooseWordsFile(f);
  });

  document.addEventListener('site:changed', (e) => {
    const id = e.detail && e.detail.assistantId;
    if (!state.assistantId || Number(id) !== Number(state.assistantId)) return;
    load();
  });

  window.AssistantSiteEditor = {
    init({ assistantId, assistantName }) {
      clearTimeout(state.pollTimer);
      Object.assign(state, { assistantId, assistantName: assistantName || null, data: null, loaded: false, rendered: false, editing: null, pageId: null, previewPath: '/', note: null, editingAddress: false, slugTyped: null, versions: null, publishNote: null, enquiries: null, enquiryShown: 20, orders: null, orderShown: 20, refreshedPayments: false,
        words: { open: false, busy: false, file: null, error: null, proposal: null, pageId: null, text: '', note: '' } });
      load();
    },
    activate() {
      if (state.rendered) return;
      state.rendered = true;
      render();
    },
  };
})();
