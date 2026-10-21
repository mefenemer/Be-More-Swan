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
 * Spend without a click: only "Draft my whole site" and "Import my current site" use a task, and say so first.
 *
 * "Import my current site" (site-import.ts, sites.ts import / import_accept / import_discard — the same
 * actions as the chat's site_import_request and site_import_decision cards): reads their old site into
 * a DRAFT shown beside the current one; it replaces the draft only on "Use this as my draft".
 *
 * Handlers are bound to `document` once, at load, never from render. Server values are escaped.
 */
(function () {
  const API = '/.netlify/functions/sites';
  const POLL_MS = 5000;

  const TYPE_LABEL = { hero: 'Hero', features: 'Features', steps: 'Steps', text: 'Text', faq: 'Questions', testimonials: 'Testimonials', cta: 'Call to action', contact: 'Contact form', signup: 'Sign-up form', products: 'Products for sale', booking: 'Bookings', hours: 'Opening hours & contact', menu: 'Menu / price list', gallery: 'Gallery', reviews: 'Reviews', social_feed: 'Latest social posts' };
  /** The edit form for each section type — the props the gate accepts (site-definition.ts cleanSection). */
  const FORMS = {
    hero: [
      { k: 'layout', kind: 'select', label: 'Layout', options: [['centered', 'Centred'], ['split', 'Text beside picture'], ['banner', 'Coloured banner'], ['cover', 'Picture behind the words (full width)']] },
      { k: 'eyebrow', kind: 'text', label: 'Small label above the headline' },
      { k: 'headline', kind: 'text', label: 'Headline', required: true },
      { k: 'subheadline', kind: 'textarea', label: 'Line under the headline' },
      { k: 'primaryCta', kind: 'link', label: 'Main button' },
      { k: 'secondaryCta', kind: 'link', label: 'Second button' },
      { k: 'image', kind: 'image', label: 'Picture or video', video: true },
    ],
    features: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'items', kind: 'items', label: 'Features', fields: [['title', 'text', 'Title'], ['body', 'textarea', 'Text']] }],
    steps: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'items', kind: 'items', label: 'Steps', fields: [['title', 'text', 'Step'], ['body', 'textarea', 'Text']] }],
    text: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'body', kind: 'textarea', label: 'Text (a blank line starts a new paragraph)', rows: 8, required: true },
      { k: 'image', kind: 'image', label: 'Picture or video beside the text (optional)', video: true },
      { k: 'imageSide', kind: 'select', label: 'Picture on the', options: [['right', 'Right'], ['left', 'Left']] }],
    faq: [{ k: 'heading', kind: 'text', label: 'Heading' },
      { k: 'items', kind: 'items', label: 'Questions', fields: [['q', 'text', 'Question'], ['a', 'textarea', 'Answer']] }],
    testimonials: [{ k: 'heading', kind: 'text', label: 'Heading' },
      { k: 'items', kind: 'items', label: 'Testimonials', fields: [['quote', 'textarea', 'What they said'], ['name', 'text', 'Their name'], ['detail', 'text', 'Business or town']] }],
    cta: [{ k: 'heading', kind: 'text', label: 'Heading', required: true }, { k: 'body', kind: 'textarea', label: 'Text' }, { k: 'button', kind: 'link', label: 'Button', required: true }],
    // Enquiries land on the Enquiries tab and in the owner's email — never in the Audience.
    contact: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'askPhone', kind: 'checkbox', label: 'Ask for a phone number (optional for the visitor)' },
      { k: 'offerUpdates', kind: 'checkbox', label: 'Offer "Send me news and offers by email" (unticked) — if they tick it, they join your Audience' },
      { k: 'buttonLabel', kind: 'text', label: 'Button text' }],
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
    // Reviews: quoted from Audience ▸ Reviews (the customers' words, never typed here).
    reviews: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'reviewIds', kind: 'reviewPick', label: 'Which reviews to quote' },
      { k: 'limit', kind: 'select', label: 'When none are ticked, show the newest', options: [[3, '3 reviews'], [6, '6 reviews'], [9, '9 reviews'], [12, '12 reviews']] },
      { k: 'showSummary', kind: 'checkbox', label: 'Show your average rating (counts every review, including hidden ones)' }],
    // Latest social posts (owner 2026-10-20): ONLY posts published through Be More Swan, read when the
    // page is drawn. The section chooses platforms, how many, whether it is on, and which page it is on.
    social_feed: [{ k: 'enabled', kind: 'checkbox', label: 'Show this on my website (untick to switch it off without losing it)' },
      { k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'platforms', kind: 'platformPick', label: 'Which platforms' },
      { k: 'count', kind: 'select', label: 'How many posts', options: [[3, '3 posts'], [4, '4 posts'], [6, '6 posts'], [8, '8 posts'], [9, '9 posts'], [12, '12 posts']] },
      { k: '_page', kind: 'pagePick', label: 'Show it on' }],
    // Gallery: the owner's own pictures, each with what it shows (needed) and an optional caption.
    gallery: [{ k: 'heading', kind: 'text', label: 'Heading' }, { k: 'intro', kind: 'textarea', label: 'Introduction' },
      { k: 'layout', kind: 'select', label: 'Layout', options: [['square', 'Even squares (pictures are cropped to fit)'], ['natural', 'Each picture at its own shape']] },
      { k: 'images', kind: 'gallery', label: 'Pictures and videos' }],
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
    contact: { heading: 'Get in touch', intro: '', askPhone: false, buttonLabel: 'Send message', offerUpdates: true }, signup: { formId: null },
    products: { heading: 'Shop', productIds: [], collectAddress: false, buyLabel: 'Buy now' },
    booking: { kind: 'appointment', heading: 'Book an appointment', serviceIds: [], askStaff: false, buttonLabel: '' },
    hours: { heading: 'Opening hours', intro: '', showHours: true, showAddress: true, showContact: true },
    reviews: { heading: 'What our customers say', intro: '', reviewIds: [], limit: 6, showSummary: true },
    social_feed: { enabled: true, heading: 'Latest from us', intro: '', platforms: [], count: 6 },
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
  /** A small preview of a picture, or of a video (silent, its first frame). */
  const thumbHtml = (src, video, w, h) => (video
    ? `<video src="${esc(src)}" muted playsinline preload="metadata" style="width:${w}px;height:${h}px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;background:#111;flex-shrink:0"></video>`
    : `<img src="${esc(src)}" alt="" style="width:${w}px;height:${h}px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;flex-shrink:0">`);
  /** Picture field: thumbnail, Choose/Change, Remove — the web address tucked away behind a link. */
  function pictureHtml(img, attrs, allowVideo) {
    const v = img || {};
    const src = v.assetId ? thumbOf(v.assetId) : (v.url || '');
    const what = v.video ? 'video' : 'picture';
    return `<div class="flex flex-wrap items-center gap-3 mt-1">
        ${src ? thumbHtml(src, v.video, 96, 64)
          : `<span class="inline-flex items-center justify-center text-xs text-gray-400 border border-dashed border-gray-300 rounded-lg" style="width:96px;height:64px">No ${allowVideo ? 'picture or video' : 'picture'}</span>`}
        ${btn(`${attrs.pick}`, src ? `Change ${what}` : (allowVideo ? 'Choose picture or video' : 'Choose picture'), !src)}
        ${src ? btn(`${attrs.clear}`, 'Remove') : ''}
      </div>`;
  }
  /** What a picture is for, to start a stock search or an AI prompt from: its section's heading. */
  function topicOf(props) {
    const p = props || {};
    return String(p.headline || p.heading || (def() && def().settings.siteName) || '').slice(0, 120);
  }

  const state = {
    assistantId: null, assistantName: null, data: null, loaded: false, loadError: null, rendered: false,
    surface: 'website', panel: 'pages', pageId: null, editing: null, device: 'desktop', previewPath: '/', note: null, pollTimer: null, version: 0,
    editingAddress: false, slugTyped: null, versions: null, publishNote: null,
    enquiries: null, enquiryShown: 20, orders: null, orderShown: 20, refreshedPayments: false,
    thumbs: {}, bookings: null, timetable: null,
    words: { open: false, busy: false, file: null, error: null, proposal: null, pageId: null, text: '', note: '' },
    importForm: { url: null, own: false, pictures: null, error: null }, previewImport: false,
    dataSig: null, noteShown: null, focusSection: null,
  };

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm';
  const def = () => state.data && state.data.definition;
  const page = () => (def() ? def().pages.find((p) => p.id === state.pageId) || def().pages[0] : null);
  const pathOf = (p) => (p && p.slug ? `/${p.slug}` : '/');
  // What the website does (Details ▸ What your website does): null = never chosen, everything offered.
  const featuresOn = () => (def() && def().settings.features) || null;
  const featureOn = (key) => !featuresOn() || featuresOn().includes(key);
  const typeAllowed = (type) => {
    const f = ((state.data && state.data.vocab.features) || []).find((x) => x.sections.includes(type));
    return !f || featureOn(f.key);
  };

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
      const backFromStripe = window._sitePaymentsReturn === true;
      window._sitePaymentsReturn = false;
      if (state.data.payments && state.data.payments.connected && (backFromStripe || !state.data.payments.chargesEnabled) && !state.refreshedPayments) {
        state.refreshedPayments = true;
        try { state.data = await post({ action: 'payments_refresh', assistantId: state.assistantId }); } catch { /* shown as not finished */ }
      }
      if (backFromStripe) {
        // Say how it went, where they'll look: the Orders tab (the deep link opens it).
        const ok = state.data.payments && state.data.payments.chargesEnabled;
        state.paymentsNotice = ok
          ? { tone: 'ok', text: 'Stripe is connected. Buy buttons and any booking deposits are now live on your website.' }
          : { tone: 'warn', text: 'Stripe still needs a few details before you can take payments. Click "Finish setting up Stripe" to carry on.' };
        if (ok && typeof window.showToast === 'function') window.showToast('Stripe connected — your website can take payments.', { icon: '✅' });
      }
      if (!state.pageId || !def().pages.some((p) => p.id === state.pageId)) state.pageId = def().pages[0].id;
      // A domain still connecting: check it once on opening, so "Check now" is rarely needed.
      const cd = state.data.site.customDomain;
      if (cd && (cd.status === 'pending_dns' || cd.status === 'securing') && !state.domainChecked && (state.data.payments || {}).canConnect) {
        state.domainChecked = true;
        post({ action: 'domain_check', assistantId: state.assistantId }).then((d) => { state.data = d; rerender(); }).catch(() => {});
      }
    } catch (err) {
      state.loadError = err.message;
    }
    // The drafting poll re-reads every 5s: repaint (and reload the preview) only when something changed.
    const sig = state.loadError || JSON.stringify(state.data);
    const same = state.loaded && sig === state.dataSig;
    state.dataSig = sig;
    state.loaded = true;
    if (!same) { state.version++; rerender(); }
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
  const btn = (attrs, label, primary) => `<button type="button" ${attrs} class="${primary ? 'btn-primary' : 'btn-secondary border'} sb-tap px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50">${label}</button>`;
  // At phone width every button here is at least 44px square to tap (WCAG 2.5.5). The prebuilt
  // style.css has no min-h-[44px] or sm: variant of it, so the one rule is added here, once.
  if (!document.getElementById('sb-tap-style')) {
    const st = document.createElement('style');
    st.id = 'sb-tap-style';
    st.textContent = '@media (max-width: 639px) { .sb-tap { min-height: 44px; min-width: 44px; } }';
    document.head.appendChild(st);
  }

  function noteHtml() {
    if (!state.note) return '';
    const cls = state.note.tone === 'error' ? 'text-red-600' : state.note.tone === 'warn' ? 'text-amber-800' : 'text-green-700';
    return `<p class="text-xs font-semibold ${cls}">${esc(state.note.text)}</p>`;
  }

  function sectionSummary(s) {
    const p = s.props;
    if (s.type === 'social_feed') return `${p.enabled === false ? 'Switched off · ' : ''}${p.heading || 'Latest posts'} · ${p.count} post${p.count === 1 ? '' : 's'}`;
    return p.headline || p.heading || (p.items && p.items[0] && (p.items[0].title || p.items[0].q || p.items[0].name)) || (p.body || '').slice(0, 60) || '';
  }

  /** The longest a text box may be (sites.ts sends EDITOR_LIMITS), as attributes plus the note it fills. */
  function limitAttr(max) { return max ? ` data-max="${max}"` : ''; }
  function limitNote(max) { return max ? '<p data-len-note class="text-xs mt-1" hidden></p>' : ''; }
  function fieldLimit(k) {
    const l = (state.data && state.data.vocab.limits) || null;
    if (!l) return 0;
    const type = state.editing && state.editing.type;
    return ((l.sectionFields || {})[type] || {})[k] || (l.fields || {})[k] || 0;
  }
  /** "250 / 300" near the limit; over it, a plain warning — the server would shorten it on save. */
  function updateLenNote(input) {
    const max = Number(input.dataset.max);
    const note = input.nextElementSibling;
    if (!max || !note || !note.hasAttribute('data-len-note')) return;
    const n = input.value.trim().length;
    note.hidden = n < max * 0.85;
    note.className = `text-xs mt-1 ${n > max ? 'text-amber-800 font-bold' : 'text-gray-500'}`;
    note.textContent = n > max ? `Too long by ${n - max} character${n - max === 1 ? '' : 's'} — it would be shortened to fit. Trim it here so it ends where you want.` : `${n} / ${max} characters`;
  }

  function fieldHtml(f, value) {
    const name = `f-${f.k}`;
    const req = f.required ? ' <span class="text-red-500">*</span>' : '';
    const max = fieldLimit(f.k);
    if (f.kind === 'text') return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}${req}</label><input name="${name}" class="${inputCls}"${limitAttr(max)} value="${esc(value || '')}">${limitNote(max)}`;
    if (f.kind === 'textarea') return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}${req}</label><textarea name="${name}" rows="${f.rows || 3}" class="${inputCls}"${limitAttr(max)}>${esc(value || '')}</textarea>${limitNote(max)}`;
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
      const lmax = ((state.data && state.data.vocab.limits) || {}).linkLabel || 0;
      return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}${req}</label>
        <div class="grid gap-2 md:grid-cols-2"><div><input name="${name}-label" class="${inputCls}" placeholder="Button text"${limitAttr(lmax)} value="${esc(v.label || '')}">${limitNote(lmax)}</div>
        <input name="${name}-href" class="${inputCls}" list="site-pages-list" placeholder="/contact or https://…" value="${esc(v.href || '')}"></div>
        <datalist id="site-pages-list">${pages.map(([path, t]) => `<option value="${esc(path)}">${esc(t)}</option>`).join('')}</datalist>`;
    }
    if (f.kind === 'image') {
      const v = value || {};
      const has = !!(v.assetId || v.url);
      return `<p class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p>
        ${pictureHtml(v, { pick: `data-site-pick="${esc(f.k)}"`, clear: `data-site-pick-clear="${esc(f.k)}"` }, !!f.video)}
        <input type="hidden" name="${name}-asset" value="${esc(v.assetId || '')}"><input type="hidden" name="${name}-video" value="${v.video ? '1' : ''}">
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
        <p class="text-xs text-gray-500 mt-1">Change them once and every page updates. ${btn('data-site-open-hours', 'Hours & location')}</p>`;
    }
    if (f.kind === 'servicePick' && state.editing && state.editing.props.kind === 'class') {
      // Classes and events: any Business Information product can be a class; dates are on the timetable.
      const chosen = new Set((Array.isArray(value) ? value : []).map(Number));
      const list = state.data.catalogue || [];
      return `<p class="text-xs font-bold text-gray-700 mt-3">Which classes or events to show</p>
        ${list.length ? `<div class="space-y-1 mt-1">${list.map((x) => `<label class="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 text-xs cursor-pointer">
          <input type="checkbox" data-service-pick value="${esc(x.id)}" ${chosen.has(x.id) ? 'checked' : ''}> <span class="font-bold text-gray-900">${esc(x.name)}</span>${x.price ? `<span class="text-gray-500">${esc(x.price)}</span>` : ''}</label>`).join('')}</div>
          <p class="text-xs text-gray-500 mt-1">Tick none to show them all.</p>` : ''}
        <p class="text-xs text-gray-500 mt-2">Add the dates and places on the Bookings tab, under Availability. ${btn('data-site-panel="bookings"', 'Open availability')}</p>`;
    }
    if (f.kind === 'servicePick') {
      const b = state.data.booking || {};
      const chosen = new Set((Array.isArray(value) ? value : []).map(Number));
      const hoursNote = `<p class="text-xs ${b.ready ? 'text-gray-500' : 'text-amber-800 font-semibold'} mt-2">${b.ready ? `Opening hours: ${esc(b.hours)}.` : 'Set your opening hours first — booking only shows on your site once they are set.'} ${btn('data-site-open-hours', 'Hours & location')}</p>`;
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
    if (f.kind === 'platformPick') {
      // Every platform; the count beside each is what has been published through Be More Swan —
      // the only posts this section can show. None ticked = all of them.
      const so = state.data.social || { platforms: [], published: [] };
      const chosen = new Set(Array.isArray(value) ? value : []);
      const countOf = (k) => { const x = so.published.find((p) => p.platform === k); return x ? x.posts : 0; };
      return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p>
        <div class="flex flex-wrap gap-2 mt-1">${so.platforms.map((p) => `
          <label class="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 text-xs cursor-pointer">
            <input type="checkbox" data-platform-pick value="${esc(p.key)}" ${chosen.has(p.key) ? 'checked' : ''}>
            <span class="font-bold text-gray-900">${esc(p.label)}</span><span class="text-gray-500">${esc(countOf(p.key))} published</span>
          </label>`).join('')}</div>
        <p class="text-xs text-gray-500 mt-1">Tick none to show posts from every platform. Only posts published through Be More Swan appear — newest first, each linking to the post itself.</p>
        ${so.published.length ? '' : '<p class="text-xs text-amber-800 mt-1">Nothing has been published through Be More Swan yet, so this section stays off your live site until something is.</p>'}`;
    }
    if (f.kind === 'pagePick') {
      // Which page the section is on. Saving moves it there (move_section with toPageId).
      const pages = def().pages;
      if (pages.length < 2) return '';
      const current = state.editing.toPageId || state.editing.pageId;
      return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</label><select name="${name}" class="${inputCls}">${pages.map((pg) => `<option value="${esc(pg.id)}" ${pg.id === current ? 'selected' : ''}>${esc(pg.title)}</option>`).join('')}</select>`;
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
        <p class="text-xs text-gray-500 mt-2">Add, edit or hide reviews in ${btn('data-site-open-reviews', 'Audience ▸ Reviews')} — or paste them into this chat.</p>`;
    }
    if (f.kind === 'gallery') {
      const list = Array.isArray(value) ? value : [];
      return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)} <span class="font-normal text-gray-500">(${list.length} of 24)</span></p>
        <div data-gallery class="space-y-2 mt-1">${list.map((im, i) => {
          const src = im.assetId ? thumbOf(im.assetId) : (im.url || '');
          return `<div class="flex gap-3 border border-gray-200 rounded-lg p-2" data-gallery-item>
            <input type="hidden" data-g-asset value="${esc(im.assetId || '')}"><input type="hidden" data-g-url value="${esc(im.assetId ? '' : (im.url || ''))}"><input type="hidden" data-g-video value="${im.video ? '1' : ''}">
            ${src ? thumbHtml(src, im.video, 72, 72) : '<span style="width:72px;height:72px;flex-shrink:0" class="bg-gray-100 rounded-lg"></span>'}
            <div class="flex-1 min-w-0">
              <input data-g-alt aria-label="Picture ${i + 1}: what it shows (needed)" class="${inputCls} ${im.alt ? '' : 'border-amber-500'}" placeholder="What the picture shows (needed)" value="${esc(im.alt || '')}">
              <input data-g-caption aria-label="Picture ${i + 1}: caption (optional)" class="${inputCls} mt-1" placeholder="Caption under it (optional)" value="${esc(im.caption || '')}">
              <div class="flex flex-wrap gap-1 mt-1">
                ${i > 0 ? btn(`data-gallery-move="${i}" data-to="${i - 1}"`, 'Move up') : ''}
                ${i < list.length - 1 ? btn(`data-gallery-move="${i}" data-to="${i + 1}"`, 'Move down') : ''}
                ${btn(`data-gallery-remove="${i}"`, 'Remove')}
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
              ${groups.length > 1 ? btn(`data-menu-group-remove="${gi}"`, '<span class="whitespace-nowrap">Remove group</span>') : ''}</div>
            <div class="grid gap-1 mt-2 sm:grid-cols-2">${list.map((p) => {
              const mine = owner[p.id] === gi;
              const elsewhere = p.id in owner && !mine;
              return `<label class="flex items-center gap-2 text-xs ${elsewhere ? 'text-gray-400' : 'text-gray-800'} cursor-pointer">
                <input type="checkbox" data-menu-pick value="${esc(p.id)}" ${mine ? 'checked' : ''} ${elsewhere ? 'disabled' : ''}>
                <span class="font-bold">${esc(p.name)}</span><span class="text-gray-500">${esc(p.price || 'No price shown')}</span>${elsewhere ? '<span>(in another group)</span>' : ''}</label>`;
            }).join('')}</div>
          </div>`).join('')}</div>
        <div class="mt-2">${btn('data-menu-group-add', '+ Add a group')}</div>
        <p class="text-xs text-gray-500 mt-2">Items appear in Business Information order. Change a name, price or description in ${btn('data-site-open-products', 'Business Information ▸ Products & Services')} — the menu follows. Nothing on a menu is bought online; use a Products for sale section for that.</p>`;
    }
    if (f.kind === 'items') {
      const list = Array.isArray(value) && value.length ? value : [{}];
      const itemMax = (k) => (((state.data && state.data.vocab.limits) || {}).itemFields || {})[k] || 0;
      return `<p class="text-xs font-bold text-gray-700 mt-3">${esc(f.label)}</p>
        <div data-items="${esc(f.k)}" class="space-y-2">${list.map((it, i) => `
          <div class="border border-gray-200 rounded-lg p-3" data-item>
            ${f.fields.map(([k, kind, label]) => kind === 'textarea'
              ? `<textarea data-item-field="${esc(k)}" aria-label="${esc(f.label)} ${i + 1}: ${esc(label)}" rows="2" class="${inputCls} mt-1" placeholder="${esc(label)}"${limitAttr(itemMax(k))}>${esc(it[k] || '')}</textarea>${limitNote(itemMax(k))}`
              : `<input data-item-field="${esc(k)}" aria-label="${esc(f.label)} ${i + 1}: ${esc(label)}" class="${inputCls} mt-1" placeholder="${esc(label)}"${limitAttr(itemMax(k))} value="${esc(it[k] || '')}">${limitNote(itemMax(k))}`).join('')}
            <div class="mt-1">${btn(`data-item-remove="${i}"`, 'Remove')}</div>
          </div>`).join('')}</div>
        <div class="mt-2">${btn(`data-item-add="${esc(f.k)}"`, '+ Add another')}</div>`;
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
        const video = form.querySelector(`[name="${n}-video"]`)?.value === '1';
        props[f.k] = assetId ? { assetId, url: '', alt, ...(video ? { video: true } : {}) } : url ? { url, alt } : null;
      } else if (f.kind === 'servicePick') {
        props[f.k] = [...form.querySelectorAll('[data-service-pick]:checked')].map((el) => Number(el.value));
      } else if (f.kind === 'reviewPick') {
        props[f.k] = [...form.querySelectorAll('[data-review-pick]:checked')].map((el) => Number(el.value));
      } else if (f.kind === 'platformPick') {
        props[f.k] = [...form.querySelectorAll('[data-platform-pick]:checked')].map((el) => el.value);
      } else if (f.kind === 'gallery') {
        props[f.k] = [...form.querySelectorAll('[data-gallery-item]')].map((row) => {
          const assetId = Number(row.querySelector('[data-g-asset]').value) || null;
          const base = { alt: row.querySelector('[data-g-alt]').value.trim(), caption: row.querySelector('[data-g-caption]').value.trim() };
          const video = row.querySelector('[data-g-video]')?.value === '1';
          return assetId ? { ...base, assetId, url: '', ...(video ? { video: true } : {}) } : { ...base, url: row.querySelector('[data-g-url]').value };
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
  const GRID_TYPES = ['features', 'steps', 'testimonials', 'products', 'menu', 'gallery', 'reviews', 'social_feed'];
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
  /** The "Show it on" page choice — not a prop: saving moves the section there. */
  function readPagePick(form) {
    const el = form.querySelector('[name="f-_page"]');
    return el ? el.value : null;
  }
  function syncEditing(form) {
    state.editing.props = readForm(form, state.editing.type);
    const to = readPagePick(form);
    if (to) state.editing.toPageId = to;
    state.editing.look = { ...(state.editing.look || LOOK_DEFAULT), ...readLook(form) };
  }

  function editorHtml() {
    const e = state.editing;
    return card(`
      <form data-site-section-form>
        <div class="flex items-center justify-between"><p class="text-sm font-black text-gray-900">${e.sectionId ? 'Edit' : 'Add'} ${esc(TYPE_LABEL[e.type])}</p>
          ${btn('data-site-edit-cancel', 'Cancel')}</div>
        ${FORMS[e.type].map((f) => fieldHtml(f, e.props[f.k])).join('')}
        ${lookHtml(e)}
        <div class="mt-4">${btn('data-site-section-save type="submit"', e.sectionId ? 'Save section' : 'Add section', true).replace('type="button" ', '')}</div>
      </form>`);
  }

  // "Ask for a change": the swan beside every section (and on it, in the preview). The request goes
  // to the assistant's chat as the user's own message; the chat proposes the change as a card they
  // approve — the same path as asking there, so nothing changes without a click (owner, 2026-10-16).
  const SWAN = '/images/BeMoreSwan_SwanAI.png';
  function swanBtn(pageId, sectionId) {
    return `<button type="button" data-site-ask="${esc(sectionId)}" data-page="${esc(pageId)}" title="Ask ${esc(state.assistantName || 'your assistant')} to change this" aria-label="Ask for a change to this section"
      class="btn-secondary border sb-tap px-2 py-1 rounded-lg inline-flex items-center justify-center"><img src="${SWAN}" alt="" style="width:18px;height:18px;object-fit:contain"></button>`;
  }
  async function askForChange(pageId, sectionId) {
    const pg = def().pages.find((x) => x.id === pageId);
    const sec = pg && pg.sections.find((x) => x.id === sectionId);
    if (!sec) return;
    const label = TYPE_LABEL[sec.type] || sec.type;
    const text = await window.promptModal(`What would you like to change in the <strong>${esc(label)}</strong> section${def().pages.length > 1 ? ` on ${esc(pg.title)}` : ''}?<br><span style="color:#6b7280">“${esc(String(sectionSummary(sec)).slice(0, 120))}”</span>`,
      { title: `Ask ${esc(state.assistantName || 'your assistant')}`, multiline: true, required: true, confirmLabel: 'Ask', placeholder: 'e.g. make the heading warmer, add our free delivery, use a darker background' });
    if (!text || !text.trim()) return;
    window.openAssistantChat?.({ assistantId: state.assistantId,
      send: `Please change the "${label}" section on the ${pg.title} page (section ${sectionId}): ${text.trim()}` });
  }
  // The same swan on each section of the preview — same-origin, so the frame's own sections get one.
  function swanThePreview(frame) {
    let doc;
    try { doc = frame.contentDocument; } catch { return; }
    // The page the preview is showing, which may not be the one open in the list.
    const pg = def() && (def().pages.find((x) => pathOf(x) === state.previewPath.split('#')[0]) || page());
    if (!doc || !pg) return;
    for (const sec of pg.sections) {
      const el = doc.getElementById(sec.id);
      if (!el || el.querySelector('[data-bms-ask]')) continue;
      if (doc.defaultView.getComputedStyle(el).position === 'static') el.style.position = 'relative';
      const b = doc.createElement('button');
      b.type = 'button';
      b.setAttribute('data-bms-ask', sec.id);
      b.title = `Ask ${state.assistantName || 'your assistant'} to change this`;
      b.style.cssText = 'position:absolute;top:8px;right:8px;z-index:50;width:34px;height:34px;border-radius:9999px;border:1px solid #e5e7eb;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0';
      b.innerHTML = `<img src="${SWAN}" alt="Ask for a change" style="width:22px;height:22px;object-fit:contain">`;
      b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); askForChange(pg.id, sec.id); });
      el.appendChild(b);
    }
  }

  function pagesPanel() {
    const d = def();
    const p = page();
    const pageTabs = d.pages.map((x) => `<button type="button" data-site-page="${esc(x.id)}" class="sb-tap px-3 py-1.5 text-xs font-bold rounded-lg border ${x.id === p.id ? 'btn-primary' : 'btn-secondary'}">${esc(x.title)}</button>`).join(' ');
    const sections = p.sections.map((s, i) => `
      <li class="border border-gray-200 rounded-lg p-3 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0"><p class="text-xs font-bold text-gray-900">${esc(TYPE_LABEL[s.type])}${s.look && s.look.menuLabel && d.structure === 'one_page' ? ` <span class="font-semibold text-indigo-700">· In the menu as “${esc(s.look.menuLabel)}”</span>` : ''}</p><p class="text-xs text-gray-500 truncate">${esc(sectionSummary(s))}</p></div>
        <div class="flex flex-wrap gap-1">
          ${swanBtn(p.id, s.id)}
          ${btn(`data-site-edit="${esc(s.id)}"`, 'Edit')}
          ${i > 0 ? btn(`data-site-move="${esc(s.id)}" data-to="${i - 1}" aria-label="Move up"`, '↑') : ''}
          ${i < p.sections.length - 1 ? btn(`data-site-move="${esc(s.id)}" data-to="${i + 1}" aria-label="Move down"`, '↓') : ''}
          ${btn(`data-site-remove-section="${esc(s.id)}"`, 'Remove')}
        </div>
      </li>`).join('');
    // Order (owner, 2026-10-17): which page, and what is on it, first — that is what you came to
    // change. The page's own title, address and search details below. What the website does, the
    // first draft and the layout are not here: the first two lead the tab on a new site (render),
    // the layout is part of Design.
    return `
      ${card(`
        <div class="flex flex-wrap gap-2 items-center">${pageTabs}
          ${d.pages.length < state.data.maxPages ? btn('data-site-add-page', '+ Page') : `<span class="text-xs text-gray-500">${esc(state.data.maxPages)} of ${esc(state.data.maxPages)} pages on your plan</span>`}</div>
        <p class="text-sm font-black text-gray-900 mt-4 mb-3">Sections on ${esc(p.title)}</p>
        <ul class="space-y-2">${sections || '<li class="text-xs text-gray-500">No sections yet.</li>'}</ul>
        <div class="flex flex-wrap gap-2 items-center mt-4"><select data-site-new-type aria-label="Kind of section to add" class="${inputCls}" style="max-width:220px">${state.data.vocab.sectionTypes.filter(typeAllowed).map((t) => `<option value="${esc(t)}">${esc(TYPE_LABEL[t] || t)}</option>`).join('')}</select>${btn('data-site-new-section', 'Add a section')}</div>`)}
      ${state.editing ? editorHtml() : ''}
      ${wordsCard(p)}
      ${card(`
        <p class="text-sm font-black text-gray-900 mb-1">Page details</p>
        <div class="grid gap-2 md:grid-cols-2 mt-2">
          <div><label class="block text-xs font-bold text-gray-700">Page title</label><input data-site-page-title class="${inputCls}" value="${esc(p.title)}"></div>
          <div><label class="block text-xs font-bold text-gray-700">Address</label><input data-site-page-slug class="${inputCls}" value="${p.slug ? '/' + esc(p.slug) : '/ (home page)'}" ${p.slug ? '' : 'disabled'}></div>
          <div><label class="block text-xs font-bold text-gray-700">Search title</label><input data-site-seo-title class="${inputCls}" value="${esc(p.seo.title || '')}" placeholder="Shown in search results"></div>
          <div><label class="block text-xs font-bold text-gray-700">Search description</label><input data-site-seo-desc class="${inputCls}" value="${esc(p.seo.description || '')}" placeholder="One or two sentences"></div>
        </div>
        ${p.slug ? `<label class="flex items-center gap-2 text-xs font-bold text-gray-700 mt-3"><input type="checkbox" data-site-page-hidden ${p.hideFromMenu ? 'checked' : ''}> Hide from the menu <span class="font-normal text-gray-500">— still there for anyone with its address, e.g. a page for an ad or an offer</span></label>` : ''}
        <div class="flex flex-wrap gap-2 mt-3">${btn('data-site-page-save', 'Save page details', true)}${p.slug ? btn('data-site-remove-page', 'Remove this page') : ''}</div>`)}`;
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
      ${!one && state.data.site.canSplit ? `<div class="mt-3">${btn('data-site-split', 'Spread your home page across pages')}<p class="text-xs text-gray-500 mt-1">Your home page holds things visitors usually find on their own page — the shop, bookings, contact. See which pages it would make before anything changes.</p></div>` : ''}
      ${d.pages.length > 1 ? `<div class="mt-3">${btn('data-site-combine', 'Combine everything into one page')}<p class="text-xs text-gray-500 mt-1">Moves every page's sections onto the home page, in order, and puts each page in the menu. Earlier versions are kept if you change your mind.</p></div>` : ''}`);
  }

  // One page → several: switching the menu style alone changes nothing a visitor sees once the pages
  // were combined, so propose the pages split_pages would make and apply them only on approval.
  async function backToPages() {
    let plan;
    try { plan = await post({ action: 'split_preview', assistantId: state.assistantId }); }
    catch (err) { state.note = { text: err.message, tone: 'error' }; rerender(); return; }
    if (!plan.pages) {
      // Nothing on the home page belongs elsewhere: say so, and switch only if there ARE other pages
      // for the menu to list — never silently.
      const others = def().pages.length > 1;
      const ok = others
        ? await window.confirmModal(`${esc(plan.reason || 'There is nothing to split.')}<br><br>Your menu will list the pages you already have.`, { title: 'Show your pages in the menu?', confirmLabel: 'Use several pages', cancelLabel: 'Keep one page' })
        : (await window.alertModal(esc(plan.reason || 'There is nothing to split.'), { title: 'Your site is still one page' }), false);
      if (ok) { await apply([{ op: 'set_structure', structure: 'pages' }]); return; }
      rerender();   // the radio goes back to "One page"
      return;
    }
    const had = new Set(def().pages.map((p) => (p.slug ? `/${p.slug}` : '/')));
    const list = plan.pages.map((p) => `• <strong>${esc(p.title)}</strong> <span style="color:#6b7280">${esc(p.path)} · ${p.sections} section${p.sections === 1 ? '' : 's'}${had.has(p.path) ? '' : ' · new'}</span>`).join('<br>');
    const ok = await window.confirmModal(`These are the pages your site would have, with what's on your home page moved to where visitors look for it:<br><br>${list}<br><br>Buttons that jumped down the page go to the new pages. You can move sections between pages afterwards. Nothing changes on your live site until you publish.`,
      { title: `Split into ${plan.pages.length} pages?`, confirmLabel: 'Use these pages', cancelLabel: 'Keep one page' });
    if (!ok) { rerender(); return; }
    await apply([{ op: 'split_pages' }], () => { state.pageId = def().pages[0].id; state.previewPath = '/'; });
  }

  function designPanel() {
    return structureCard() + designCard();
  }

  // ── Templates (src/config/site-templates.ts) ───────────────────────────────────────────────
  // A gallery of real previews — this site's own name, town and features, rendered by site-preview
  // with ?template= — never a screenshot that could drift from what the template really does.
  const TPL_W = 1280;
  const TPL_H = 860;
  function tplSrc(id, opts = {}) {
    return `/.netlify/functions/site-preview?assistantId=${encodeURIComponent(state.assistantId)}&template=${encodeURIComponent(id)}${opts.mode === 'design' ? '&mode=design' : ''}${opts.keepColours ? '&keepColours=1' : ''}&path=${encodeURIComponent(opts.path || '/')}`;
  }
  function tplCard(t, width) {
    const scale = width / TPL_W;
    return `<button type="button" data-tpl-open="${esc(t.id)}" class="text-left bg-white border border-gray-200 rounded-xl overflow-hidden hover:shadow-md" style="width:${width}px;max-width:100%">
      <span style="display:block;position:relative;width:100%;height:${Math.round(TPL_H * scale)}px;overflow:hidden;background:#f3f4f6">
        <iframe src="${esc(tplSrc(t.id))}" loading="lazy" tabindex="-1" aria-hidden="true" title="" style="position:absolute;top:0;left:0;width:${TPL_W}px;height:${TPL_H}px;border:0;transform:scale(${scale});transform-origin:0 0;pointer-events:none"></iframe></span>
      <span class="block p-3">
        <span class="flex items-center justify-between gap-2"><span class="text-sm font-black text-gray-900">${esc(t.name)}</span>
          <span class="flex gap-1">${t.colours.map((c) => `<span style="width:12px;height:12px;border-radius:9999px;background:${esc(c)};border:1px solid rgba(0,0,0,.15)"></span>`).join('')}</span></span>
        <span class="block text-xs text-gray-600 mt-1">${esc(t.tagline)}</span>
        <span class="block text-[11px] text-gray-500 mt-1">${esc(t.bestFor.join(' · '))}</span>
      </span></button>`;
  }
  function templatesCard(first) {
    const list = state.data.templates || [];
    if (!list.length) return '';
    const current = def().settings.template;
    // The Templates tab: the same gallery, with a word on which one this site started from. It is a
    // tab of its own because, tucked inside Design, nobody with a site already found it.
    if (!first) {
      const cur = list.find((x) => x.id === current);
      return card(`<p class="text-sm font-black text-gray-900">Templates</p>
        <p class="text-xs text-gray-500 mt-1">${cur ? `Started from <strong>${esc(cur.name)}</strong>. ` : ''}Each one is shown with your name. Open one to try it — keep your words and pictures and change only the look, or start again from the template. Nothing changes on your live site until you publish.</p>
        <div class="flex flex-wrap gap-3 mt-3">${list.map((t) => tplCard(t, 260)).join('')}</div>`);
    }
    return card(`<p class="text-sm font-black text-gray-900">Choose a template</p>
      <p class="text-xs text-gray-500 mt-1">Each one is shown with your name. Pick one to start from — you can change everything afterwards, or try another later.</p>
      <div class="flex flex-wrap gap-3 mt-3">${list.map((t) => tplCard(t, 260)).join('')}</div>`, 'border-indigo-200');
  }

  /** The full-size look at one template, and the choice to use it. Built per open; its handlers live on it. */
  function openTemplate(id) {
    const list = state.data.templates || [];
    const t = list.find((x) => x.id === id);
    if (!t) return;
    const fresh = isFresh();
    const view = { device: 'desktop', mode: fresh ? 'full' : 'design', keepColours: false };
    document.getElementById('bms-tpl')?.remove();
    const back = document.createElement('div');
    back.id = 'bms-tpl';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-label', `${t.name} template`);
    back.style.cssText = 'position:fixed;inset:0;z-index:11000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:1rem;';
    const paint = () => {
      back.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full" style="max-width:1200px;height:92vh;display:flex;flex-direction:column">
        <div class="flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-b border-gray-100">
          <div><p class="text-sm font-black text-gray-900">${esc(t.name)}</p><p class="text-xs text-gray-500">${esc(t.tagline)} · Lettering: ${esc(t.lettering)}</p></div>
          <div class="flex flex-wrap items-center gap-2">
            ${list.map((x) => `<button type="button" data-tpl-switch="${esc(x.id)}" class="px-2 py-1 text-xs font-bold rounded-lg border ${x.id === t.id ? 'btn-primary' : 'btn-secondary'}">${esc(x.name)}</button>`).join('')}
            <button type="button" data-tpl-close class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">Close</button></div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 px-5 py-2 bg-gray-50 border-b border-gray-100 text-xs">
          <div class="flex flex-wrap items-center gap-3">
            ${fresh ? '' : `<label class="flex items-center gap-1"><input type="radio" name="tpl-mode" value="design" ${view.mode === 'design' ? 'checked' : ''}> My words and pictures, this design</label>
              <label class="flex items-center gap-1"><input type="radio" name="tpl-mode" value="full" ${view.mode === 'full' ? 'checked' : ''}> Start again from this template</label>`}
            <label class="flex items-center gap-1"><input type="checkbox" data-tpl-keep ${view.keepColours ? 'checked' : ''}> Keep my own colours</label>
          </div>
          <div class="flex gap-1">${['desktop', 'mobile'].map((d) => `<button type="button" data-tpl-device="${d}" class="px-2 py-1 text-xs font-bold rounded-lg border ${view.device === d ? 'btn-primary' : 'btn-secondary'}">${d === 'desktop' ? 'Desktop' : 'Phone'}</button>`).join('')}</div>
        </div>
        <div class="flex-1 bg-gray-100 p-3" style="min-height:0;overflow:auto"><iframe title="Preview of the ${esc(t.name)} template" src="${esc(tplSrc(t.id, view))}" style="display:block;margin:0 auto;width:${view.device === 'mobile' ? '390px' : '100%'};height:100%;border:0;background:#fff;border-radius:8px"></iframe></div>
        <div class="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-gray-100">
          <p class="text-xs text-gray-500 mr-auto">${view.mode === 'full' ? 'Pictures are free stock photos to swap for your own. Words in [square brackets] are for you to fill in before you publish.' : 'Your pages, words and pictures stay exactly as they are; only the look changes.'}</p>
          <button type="button" data-tpl-use class="btn-primary px-4 py-2 text-sm font-bold rounded-lg">${view.mode === 'full' ? `Use ${esc(t.name)}` : `Use this design`}</button>
        </div></div>`;
    };
    paint();
    document.body.appendChild(back);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', async (e) => {
      if (e.target === back || e.target.closest('[data-tpl-close]')) { close(); return; }
      const sw = e.target.closest('[data-tpl-switch]');
      if (sw) { close(); openTemplate(sw.dataset.tplSwitch); return; }
      const dv = e.target.closest('[data-tpl-device]');
      if (dv) { view.device = dv.dataset.tplDevice; paint(); return; }
      if (e.target.closest('[data-tpl-use]')) {
        if (view.mode === 'full' && !fresh) {
          const ok = await window.confirmModal(`Your pages are replaced with the <strong>${esc(t.name)}</strong> template's layout. Your live site doesn't change until you publish, and earlier published versions are kept.`, { title: 'Start again from this template?', confirmLabel: 'Start again', cancelLabel: 'Keep my pages' });
          if (!ok) return;
        }
        close();
        await apply([{ op: 'apply_template', templateId: t.id, mode: view.mode, keepColours: view.keepColours }], () => {
          state.panel = 'pages'; state.pageId = def().pages[0].id; state.previewPath = '/';
          state.note = { text: view.mode === 'full' ? `${t.name} is in place. Now let ${state.assistantName || 'your assistant'} write the words for your business — or edit any section yourself.` : `${t.name}'s design is in place.`, tone: 'ok' };
        });
      }
    });
    back.addEventListener('change', (e) => {
      if (e.target.name === 'tpl-mode') { view.mode = e.target.value; paint(); }
      if (e.target.matches('[data-tpl-keep]')) { view.keepColours = e.target.checked; paint(); }
    });
  }
  function openTemplateGallery() {
    const list = state.data.templates || [];
    document.getElementById('bms-tpl')?.remove();
    const back = document.createElement('div');
    back.id = 'bms-tpl';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-label', 'Templates');
    back.style.cssText = 'position:fixed;inset:0;z-index:11000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:1rem;';
    back.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full" style="max-width:1200px;max-height:92vh;display:flex;flex-direction:column">
      <div class="flex items-center justify-between gap-2 px-5 py-3 border-b border-gray-100"><div><p class="text-sm font-black text-gray-900">Templates</p><p class="text-xs text-gray-500">Shown with your name. Open one to see it full size.</p></div>
        <button type="button" data-tpl-close class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg">Close</button></div>
      <div class="p-5 overflow-y-auto" style="min-height:0"><div class="flex flex-wrap gap-4 justify-center">${list.map((t) => tplCard(t, 270)).join('')}</div></div></div>`;
    document.body.appendChild(back);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.closest('[data-tpl-close]')) { close(); return; }
      const o = e.target.closest('[data-tpl-open]');
      if (o) { close(); openTemplate(o.dataset.tplOpen); }
    });
  }
  function designCard() {
    const t = def().theme;
    const colour = (k, label) => `<div><label class="block text-xs font-bold text-gray-700">${esc(label)}</label><input type="color" data-theme="${k}" value="${esc(t[k])}" class="w-full h-10 border border-gray-300 rounded-lg"></div>`;
    return card(`
      <p class="text-sm font-black text-gray-900">Design</p>
      <p class="text-xs text-gray-500 mb-3">Started from your brand kit. Text that would be hard to read on the background is refused.</p>
      <div class="grid gap-3 md:grid-cols-2">${colour('primaryColor', 'Main colour (buttons, links)')}${colour('textColor', 'Text colour')}${colour('backgroundColor', 'Background colour')}
        <div><label class="block text-xs font-bold text-gray-700">Lettering</label><select data-theme="font" class="${inputCls}">${(state.data.vocab.fonts || []).map(({ key, label }) => `<option value="${esc(key)}" ${t.font === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div>
        <div><label class="block text-xs font-bold text-gray-700">Spacing</label><select data-theme="spacing" class="${inputCls}">${[['compact', 'Compact'], ['regular', 'Regular'], ['airy', 'Airy — lots of room']].map(([v, l]) => `<option value="${v}" ${(t.spacing || 'regular') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label class="block text-xs font-bold text-gray-700">Header</label><select data-theme="header" class="${inputCls}">${[['standard', 'Name on the left, menu on the right'], ['centered', 'Name centred above the menu']].map(([v, l]) => `<option value="${v}" ${(t.header || 'standard') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label class="block text-xs font-bold text-gray-700">Tint for alternate sections</label><div class="flex items-center gap-2"><input type="color" data-theme="accentColor" value="${esc(t.accentColor || '#e5e7eb')}" class="h-10 border border-gray-300 rounded-lg" style="width:64px">
          <label class="flex items-center gap-1 text-xs text-gray-600"><input type="checkbox" data-theme-accent-off ${t.accentColor ? '' : 'checked'}> Plain grey</label></div></div>
        <div><label class="block text-xs font-bold text-gray-700">Corners</label><select data-theme="radius" class="${inputCls}">${[['none', 'Square'], ['small', 'Slightly rounded'], ['medium', 'Rounded'], ['large', 'Very rounded']].map(([v, l]) => `<option value="${v}" ${t.radius === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="md:col-span-2"><p class="block text-xs font-bold text-gray-700">Logo</p>
          ${pictureHtml(t.logoAssetId ? { assetId: t.logoAssetId, url: '' } : (t.logoUrl ? { url: t.logoUrl } : null), { pick: 'data-site-logo-pick', clear: 'data-site-logo-clear' })}
          <details class="mt-1" ${!t.logoAssetId && t.logoUrl ? 'open' : ''}><summary class="text-xs text-gray-500 cursor-pointer">Use a web address instead</summary>
            <input data-theme="logoUrl" class="${inputCls} mt-1" placeholder="https://… logo address" value="${esc(t.logoAssetId ? '' : (t.logoUrl || ''))}"></details></div>
      </div>
      <div class="mt-4">${btn('data-site-theme-save', 'Save design', true)}</div>`);
  }

  function featuresCard(first) {
    const list = (state.data.vocab.features || []);
    return card(`
      <p class="text-sm font-black text-gray-900">${first ? 'First, choose what your website does' : 'What your website does'}</p>
      <p class="text-xs text-gray-500 mt-1">Untick what you don't need: it's hidden here, ${esc(state.assistantName || 'your assistant')} won't suggest it, and its tab disappears. You can switch it back on any time.</p>
      <div class="grid gap-2 sm:grid-cols-2 mt-3">${list.map((f) => `<label class="flex items-center gap-2 text-xs text-gray-800"><input type="checkbox" data-site-feature="${esc(f.key)}" ${featureOn(f.key) ? 'checked' : ''}> ${esc(f.label)}</label>`).join('')}</div>
      <div class="mt-3">${btn('data-site-features-save', first ? 'Use these' : 'Save', true)}</div>`, first ? 'border-indigo-200' : '');
  }

  function detailsPanel() {
    const s = def().settings;
    const f = (k, label, v) => `<div><label class="block text-xs font-bold text-gray-700">${esc(label)}</label><input data-setting="${k}" class="${inputCls}" value="${esc(v || '')}"></div>`;
    return featuresCard(false) + card(`
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
      <p class="text-xs text-gray-500 mt-1 mb-3">Sent from the contact forms on your site. Each one was also emailed to you — reply to them directly. Anyone who ticked "Send me news and offers" is added to your Audience; anyone else only if they tell you they'd like your emails.</p>
      <ul class="space-y-2">${shown.map((q) => `
        <li class="border ${q.status === 'new' ? 'border-indigo-200' : 'border-gray-200'} rounded-lg p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs font-bold text-gray-900">${esc(q.name)} ${q.status === 'new' ? '<span class="text-xs font-bold text-indigo-700">· New</span>' : ''}</p>
            <p class="text-xs text-gray-500">${esc(new Date(q.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}${q.pagePath ? ` · ${esc(q.pagePath)}` : ''}</p>
          </div>
          <p class="text-xs text-gray-600 mt-1"><a class="underline" href="mailto:${esc(q.email)}">${esc(q.email)}</a>${q.phone ? ` · <a class="underline" href="tel:${esc(q.phone)}">${esc(q.phone)}</a>` : ''}</p>
          <p class="text-xs text-gray-800 mt-2" style="white-space:pre-wrap">${esc(q.message)}</p>
          <div class="mt-2 flex flex-wrap items-center gap-2">${btn(`data-site-enquiry="${esc(q.id)}" data-done="${q.status === 'new' ? '1' : '0'}"`, q.status === 'new' ? 'Mark as dealt with' : 'Mark as new')}
            ${q.audienceStatus === 'subscribed' ? '<span class="text-xs font-bold text-green-700">In your Audience</span>'
              : q.audienceStatus ? `<span class="text-xs text-gray-500">In your Audience · ${esc(q.audienceStatus)}</span>`
              : btn(`data-site-enquiry-audience="${esc(q.id)}"`, 'Add to Audience')}</div>
        </li>`).join('')}</ul>
      ${list.length > shown.length ? `<div class="mt-3">${btn('data-site-enquiries-more', `Show more (${list.length - shown.length})`)}</div>` : ''}`);
  }

  // ── Orders (step 3c) ───────────────────────────────────────────────────────
  const money = (pence, cur) => (String(cur || 'gbp').toLowerCase() === 'gbp' ? `£${(pence / 100).toFixed(2).replace(/\.00$/, '')}` : `${(pence / 100).toFixed(2)} ${String(cur).toUpperCase()}`);

  function paymentsCard() {
    const p = state.data.payments || {};
    if (p.chargesEnabled) {
      return card(`${state.paymentsNotice && state.paymentsNotice.tone === 'ok' ? `<p class="text-xs font-semibold text-green-700 mb-2" role="status">✓ ${esc(state.paymentsNotice.text)}</p>` : ''}<p class="text-sm font-black text-gray-900">Payments: connected</p>
        <p class="text-xs text-gray-500 mt-1">Your Stripe account is connected, so Buy buttons on your products show on your live site. Buyers pay you directly — Be More Swan takes no fee. Refunds, payouts and receipts are in your <a class="underline" href="https://dashboard.stripe.com" target="_blank" rel="noopener">Stripe dashboard</a>.</p>`, 'border-green-200');
    }
    const action = p.canConnect
      ? btn('data-site-connect', p.connected ? 'Finish setting up Stripe' : 'Connect Stripe', true)
      : '<p class="text-xs font-semibold text-gray-700 mt-2">Ask your workspace owner or an admin to connect Stripe.</p>';
    return card(`<p class="text-sm font-black text-gray-900">Take payments on your site</p>
      <p class="text-xs text-gray-500 mt-1">${p.connected
        ? 'Stripe still needs a few details before you can take payments. Pick up where you left off — it takes a few minutes.'
        : 'Connect a Stripe account to show Buy buttons on the products on your site. You are the seller: the money goes straight to your Stripe account, and Be More Swan takes no fee. Stripe charges its usual card fees. Prices are in pounds.'}</p>
      ${p.canConnect ? (() => {
        // Stripe asks for the business's website during sign-up — have it ready (2026-10-16 feedback).
        const site = state.data.site || {};
        return site.status === 'published' && site.url
          ? `<p class="text-xs text-gray-700 mt-2"><strong>Have this ready:</strong> Stripe asks for your website. Give it <span class="font-semibold">${esc(site.url)}</span>.</p>`
          : '<p class="text-xs text-amber-800 mt-2"><strong>Before you start:</strong> Stripe asks for your website. Publish your site first (above) so you have its address, or use another website you already have.</p>';
      })() : ''}
      <div class="mt-3">${action}</div>
      ${state.paymentsError ? `<p class="text-xs font-semibold text-red-600 mt-2" role="alert">${esc(state.paymentsError)}</p>` : ''}
      ${state.paymentsNotice && state.paymentsNotice.tone !== 'ok' ? `<p class="text-xs font-semibold text-amber-800 mt-2" role="status">${esc(state.paymentsNotice.text)}</p>` : ''}`);
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
      <p class="text-xs text-gray-500 mt-1">${b.ready ? `Opening hours: ${esc(b.hours)}. ${b.mode === 'instant' ? 'Bookings are confirmed straight away.' : 'You confirm each booking.'}` : 'Set your opening hours to take bookings on your site.'} ${btn('data-site-open-hours', 'Hours & location')}</p>
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
        <label class="text-xs font-bold text-gray-700">What's on <span class="font-normal text-gray-500">(class, event, workshop, tour…)</span><select data-sf="serviceId" class="${inputCls} mt-1">${classes.map((c) => opt(c.id, `${c.name}${c.price ? ` · ${c.price}` : ''}`, f.serviceId)).join('')}</select></label>
        <label class="text-xs font-bold text-gray-700">Teacher or room <span class="font-normal text-gray-500">(optional)</span><select data-sf="resourceId" class="${inputCls} mt-1">${opt('', 'None', f.resourceId)}${people.map((r) => opt(r.id, r.name, f.resourceId)).join('')}</select></label>
        <label class="text-xs font-bold text-gray-700">Date<input type="date" data-sf="date" class="${inputCls} mt-1" value="${esc(f.date || '')}"></label>
        <div class="grid grid-cols-2 gap-2"><label class="text-xs font-bold text-gray-700">Starts<input type="time" data-sf="start" class="${inputCls} mt-1" value="${esc(f.start || '18:00')}"></label>
          <label class="text-xs font-bold text-gray-700">Ends<input type="time" data-sf="end" class="${inputCls} mt-1" value="${esc(f.end || '19:00')}"></label></div>
        <label class="text-xs font-bold text-gray-700">Places<input type="number" min="1" max="500" data-sf="capacity" class="${inputCls} mt-1" value="${esc(f.capacity || 12)}"></label>
        <label class="text-xs font-bold text-gray-700">Repeat<select data-sf="repeatWeeks" class="${inputCls} mt-1">${[[0, 'Just this date (an event)'], [3, 'Weekly for 4 weeks'], [7, 'Weekly for 8 weeks'], [11, 'Weekly for 12 weeks'], [25, 'Weekly for 26 weeks']].map(([v, l]) => opt(v, l, f.repeatWeeks ?? 0)).join('')}</select></label>
        <label class="text-xs font-bold text-gray-700 md:col-span-2">Note for customers <span class="font-normal text-gray-500">(optional — e.g. bring a mat)</span><input data-sf="notes" maxlength="300" class="${inputCls} mt-1" value="${esc(f.notes || '')}"></label>
        <div class="md:col-span-2">${btn('data-session-add', 'Add these dates', true)}</div></div>`
      : `<p class="text-xs text-gray-500 mt-2">First add your classes or events (with their prices) in ${btn('data-site-open-products', 'Business Information ▸ Products & Services')}.</p>`;
    const now = Date.now();
    const rows = !tt ? '<p class="text-xs text-gray-400 mt-3">Loading…</p>'
      : !tt.length ? '<p class="text-xs text-gray-500 mt-3">No dates added yet.</p>'
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
    return card(`<p class="text-sm font-black text-gray-900">Availability</p>
      <p class="text-xs text-gray-500 mt-1">Appointments and tables are booked within your opening hours (Business Information ▸ Hours &amp; Location). Here, add dates with a number of places — classes, events, workshops, tours, open days. Show them with a Bookings section set to "Classes and events"; people book places, and join a waitlist when it's full. Your Calendar tab shows all of it together.</p>${form}${rows}`);
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

  // The preview card is painted once and then kept: its header is rewritten and the frame's width
  // set on each render, but the frame reloads only when its address changes (the draft changed, or
  // another page / the import is shown) — not on every click.
  function previewHeadHtml(showImport) {
    return `<div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p class="text-sm font-black text-gray-900">Preview <span class="text-xs font-semibold text-gray-500">— ${showImport ? 'your imported site (not your draft yet)' : state.data.site.status === 'published' ? 'your draft' : 'not live yet'}</span></p>
        <div class="flex gap-1">${btn(`data-site-device="desktop"`, 'Desktop', state.device === 'desktop')}${btn(`data-site-device="mobile"`, 'Phone', state.device === 'mobile')}</div>
      </div>`;
  }
  function paintPreview(slot) {
    const showImport = state.previewImport && state.data.import && state.data.import.status === 'ready';
    const src = `/.netlify/functions/site-preview?assistantId=${encodeURIComponent(state.assistantId)}${showImport ? '&import=1' : ''}&path=${encodeURIComponent(state.previewPath)}&v=${state.version}`;
    let frame = slot.querySelector('iframe[data-site-preview]');
    if (!frame) {
      slot.innerHTML = card(`<div data-site-preview-head></div>
      <div class="bg-gray-100 rounded-lg p-2" style="overflow:auto"><iframe data-site-preview title="Preview of your website" style="display:block;margin:0 auto;height:720px;border:0;background:#fff;border-radius:8px"></iframe></div>`);
      frame = slot.querySelector('iframe[data-site-preview]');
    }
    const head = slot.querySelector('[data-site-preview-head]');
    const headHtml = previewHeadHtml(showImport);
    if (head._html !== headHtml) { head.innerHTML = headHtml; head._html = headHtml; }
    frame.style.width = state.device === 'mobile' ? '390px' : '100%';
    if (frame.dataset.src !== src) { frame.dataset.src = src; frame.src = src; }
  }

  // A new site: nothing written yet beyond the starter (never published, two sections at most).
  const isFresh = () => !state.data.site.publishedVersion && def().pages.reduce((n, p) => n + p.sections.length, 0) <= 2;

  // The AI writing every page from the business's details. Up front on a new site (Pages); on a site
  // that has been worked on it is "Start again", folded away at the end of Details — it replaces the
  // whole draft, so it should never sit under every panel looking like a next step (owner, 2026-10-16).
  function draftCard(where) {
    const s = state.data.site;
    if (s.drafting && state.data.import && state.data.import.status === 'reading') return '';
    if (s.drafting) return card('<p class="text-sm font-semibold text-indigo-700">Drafting your whole site — this takes a minute or two. You can leave this page; you\'ll be notified when it\'s ready.</p>');
    const who = esc(state.assistantName || 'Your Website Assistant');
    const form = `
      <textarea data-site-draft-request rows="2" class="${inputCls} mt-3" placeholder="Anything to include? e.g. a page for each service, a friendly tone, mention free delivery"></textarea>
      ${s.draftNote ? `<p class="text-xs font-semibold text-amber-800 mt-2">${esc(s.draftNote)}</p>` : ''}`;
    if (where === 'start') {
      return card(`
        ${def().settings.template ? `<p class="text-sm font-black text-gray-900">Let ${who} write the words</p>
        <p class="text-xs text-gray-500 mt-1">It rewrites every section of your template for your business, from your details, products and set-up answers — the layout, pictures and design stay as they are. Anything it doesn't know stays in [square brackets] for you. Uses 1 task.</p>`
        : `<p class="text-sm font-black text-gray-900">Let ${who} write your site</p>
        <p class="text-xs text-gray-500 mt-1">It writes every page from your business details, products and set-up answers, using only the things you ticked above. You then change anything you like. Uses 1 task.</p>`}
        ${form}
        <div class="mt-3">${btn('data-site-draft', def().settings.template ? 'Write the words' : 'Write my site', true)}</div>`, 'border-indigo-200');
    }
    return `<details class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <summary class="text-sm font-black text-gray-900 cursor-pointer">Start again from scratch</summary>
      <p class="text-xs text-gray-500 mt-2">${who} rewrites every page from your business details. <strong>It replaces everything in your draft</strong>, including your own changes (${s.status === 'published' ? 'your live site doesn\'t change until you publish' : 'nothing is live yet'}). Earlier published versions are kept. Uses 1 task.</p>
      ${form}
      <div class="mt-3">${btn('data-site-draft', 'Replace my draft', false)}</div>
    </details>`;
  }

  // ── Import my current site (site-import.ts) ───────────────────────────────
  // Their old site, read into a DRAFT they review here before it replaces anything. Their words are
  // carried over unchanged; prices stay in Business Information; pictures only if they say so.
  function importCard(where) {
    const imp = state.data.import;
    const s = state.data.site;
    const who = esc(state.assistantName || 'Your Website Assistant');
    if (imp && imp.status === 'reading' && s.drafting) {
      return card(`<p class="text-sm font-semibold text-indigo-700">Reading your site at ${esc(imp.sourceUrl)} — this takes a minute or two. You can leave this page; you'll be notified when the imported draft is ready to look at.</p>`, 'border-indigo-200');
    }
    if (imp && imp.status === 'ready') return importReviewCard(imp);
    const f = state.importForm;
    const url = f.url != null ? f.url : (imp && imp.sourceUrl) || state.data.importSuggestUrl || '';
    const failed = imp && imp.status === 'failed' ? `<div class="bg-amber-50 border border-amber-200 rounded-lg p-3 mt-3">
        <p class="text-xs font-semibold text-amber-800">${esc(imp.message || 'The import didn\'t work.')}</p>
        ${importPagesList(imp.report)}
        <div class="flex flex-wrap gap-2 mt-2">${btn('data-site-import-words', 'Add your own words instead')}${btn('data-site-import-discard', 'Dismiss')}</div></div>` : '';
    const form = `
      ${failed}
      <label class="block text-xs font-bold text-gray-700 mt-3">Your current website's address
        <input data-site-import-url class="${inputCls} mt-1" inputmode="url" autocomplete="url" placeholder="e.g. yourbusiness.co.uk" value="${esc(url)}"></label>
      <fieldset class="mt-3"><legend class="text-xs font-bold text-gray-700">Its pictures</legend>
        <label class="flex items-start gap-2 text-xs text-gray-700 mt-1"><input type="radio" name="site-import-pictures" value="copy" ${f.pictures === 'copy' ? 'checked' : ''}> <span>Copy them into my picture library and use them on my new site</span></label>
        <label class="flex items-start gap-2 text-xs text-gray-700 mt-1"><input type="radio" name="site-import-pictures" value="skip" ${f.pictures === 'skip' ? 'checked' : ''}> <span>Leave them out — I'll choose pictures myself</span></label>
      </fieldset>
      <label class="flex items-start gap-2 text-xs text-gray-700 mt-3"><input type="checkbox" data-site-import-own ${f.own ? 'checked' : ''}> <span>This website belongs to my business, and I have the right to use its words and pictures.</span></label>
      ${f.error ? `<p class="text-xs font-semibold text-red-600 mt-2">${esc(f.error)}</p>` : ''}
      <div class="mt-3">${btn('data-site-import-go', 'Read my site', where === 'start')}</div>
      <p class="text-xs text-gray-500 mt-2">${who} reads your home page and the pages in its menu (up to ${esc(state.data.maxPages)} on your plan) and lays your own words out as your new site. Nothing is reworded or made up — anything missing is left in [square brackets] for you. Prices aren't copied; they belong in Business Information. You see the result before it replaces anything. Uses 1 task, only if a draft is made.</p>`;
    if (where === 'start') {
      return card(`<p class="text-sm font-black text-gray-900">Already have a website?</p>
        <p class="text-xs text-gray-500 mt-1">Bring it over from Wix, Squarespace, WordPress or anywhere else.</p>${form}`, 'border-indigo-200');
    }
    return `<details class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <summary class="text-sm font-black text-gray-900 cursor-pointer">Import my current site</summary>${form}</details>`;
  }

  function importPagesList(report) {
    if (!report || !report.pages || !report.pages.length) return '';
    return `<ul class="mt-2 space-y-1">${report.pages.map((p) => `<li class="text-xs text-gray-700">${esc(p.title)} — ${p.read ? `${esc(p.words)} words read` : `<span class="text-amber-800">${esc(p.note || 'not read')}</span>`}</li>`).join('')}</ul>`;
  }

  function importReviewCard(imp) {
    const r = imp.report || {};
    const pics = r.pictures || {};
    const list = (title, items, tone) => (items && items.length ? `<details class="mt-2"><summary class="text-xs font-bold ${tone || 'text-gray-800'} cursor-pointer">${title}</summary><ul class="mt-1 space-y-1 list-disc pl-5">${items.slice(0, 30).map((x) => `<li class="text-xs text-gray-700">${esc(typeof x === 'string' ? x : x.title)}</li>`).join('')}</ul></details>` : '');
    const contact = r.contact || {};
    return card(`
      <p class="text-sm font-black text-gray-900">Your imported site is ready to look at</p>
      <p class="text-xs text-gray-500 mt-1">From ${esc(imp.sourceUrl)}: ${esc(imp.pages.length)} page${imp.pages.length === 1 ? '' : 's'}, ${esc(r.wordsRead || 0)} words of yours, laid out as sections — unchanged. Your current draft hasn't changed.</p>
      ${importPagesList(r)}
      <p class="text-xs text-gray-700 mt-2">${pics.choice === 'copy' ? `Pictures: ${esc(pics.copied || 0)} copied into your library${pics.failed ? `, ${esc(pics.failed)} couldn't be copied` : ''}.` : 'Pictures: left out, as you chose — add your own with "Choose picture".'}</p>
      ${pics.undescribed ? `<p class="text-xs font-semibold text-amber-800 mt-1">${esc(pics.undescribed)} picture${pics.undescribed === 1 ? '' : 's'} had no description on your old site, so each is described by the heading near it — check them, for people using screen readers.</p>` : ''}
      ${contact.email || contact.phone ? `<p class="text-xs text-gray-700 mt-1">Contact details found: ${esc([contact.email, contact.phone].filter(Boolean).join(' · '))}.</p>` : ''}
      ${r.placeholders ? `<p class="text-xs font-semibold text-amber-800 mt-1">${esc(r.placeholders)} part${r.placeholders === 1 ? '' : 's'} in [square brackets] to fill in before you publish.</p>` : ''}
      ${list(`Prices we found (${(r.prices || []).length}) — not copied: add them in Business Information ▸ Products & Services`, r.prices, 'text-amber-800')}
      ${list(`Left out as menus or notices (${(r.leftOut || []).length}) — check nothing important is here`, r.leftOut)}
      ${list(`Didn't fit on its page (${(r.notCarried || []).length})`, r.notCarried, 'text-amber-800')}
      ${list(`Pages in your menu not imported — your plan has ${esc(state.data.maxPages)} pages (${(r.notImported || []).length})`, r.notImported)}
      ${r.hadForm ? '<p class="text-xs text-gray-500 mt-2">Your old site had a form. Enquiries from the new contact form come to you on the Enquiries tab; for an email sign-up, add a sign-up section with one of your forms.</p>' : ''}
      <div class="flex flex-wrap gap-2 mt-3">
        ${btn('data-site-import-preview', state.previewImport ? 'Show my current draft' : 'Preview the imported site', !state.previewImport)}
        ${btn('data-site-import-use', 'Use this as my draft', state.previewImport)}
        ${btn('data-site-import-discard', 'Discard')}
      </div>
      <p class="text-xs text-gray-500 mt-2">"Use this as my draft" replaces your current draft with the imported pages, keeping your design. ${state.data.site.status === 'published' ? 'Your live site doesn\'t change until you publish.' : 'Nothing goes live until you publish.'}</p>`, 'border-indigo-200');
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
    return card(`${status}${address}${actions}${versions}${pnote}${s.slug ? domainBlock() : ''}`, live ? 'border-green-200' : '');
  }

  // ── Their own domain (site-domains.ts) ─────────────────────────────────────────────────────
  // Owners and admins connect it (sites.ts gates it too); the steps are the records to add where
  // the domain was bought, then "Check now" until it is live.
  function domainBlock() {
    const d = state.data.site.customDomain || {};
    const canEdit = (state.data.payments || {}).canConnect !== false;
    const head = '<p class="text-sm font-black text-gray-900 mt-5 pt-4 border-t border-gray-100">Your own domain</p>';
    if (!d.available && !d.domain) return `${head}<p class="text-xs text-gray-500 mt-1">Using a domain you own (like yourbusiness.co.uk) is coming soon.</p>`;
    if (!d.domain) {
      if (!canEdit) return `${head}<p class="text-xs text-gray-500 mt-1">The workspace owner or an admin can connect a domain you own.</p>`;
      return `${head}
        <p class="text-xs text-gray-500 mt-1">Already own a domain, like yourbusiness.co.uk? Use it for this site. You'll add one or two settings where you bought it (GoDaddy, 123 Reg, IONOS, Namecheap…) — we show you exactly what. Your ${esc(state.data.site.domain)} address keeps working and sends visitors to it.</p>
        <div class="flex flex-wrap items-center gap-2 mt-2"><input data-site-domain-input class="${inputCls}" style="max-width:260px" placeholder="yourbusiness.co.uk" value="${esc(state.domainTyped || '')}" autocomplete="off" spellcheck="false">${btn('data-site-domain-add', 'Connect', true)}</div>`;
    }
    const tone = d.status === 'live' ? 'text-green-700' : 'text-amber-800';
    const label = d.status === 'live' ? 'Live' : d.status === 'securing' ? 'Securing (https)' : 'Waiting for your DNS settings';
    const records = d.status === 'pending_dns' || (d.status === 'live' && d.altDomain && /without www/.test(d.detail || ''))
      ? `<p class="text-xs text-gray-700 mt-3">Where you bought <strong>${esc(d.altDomain || d.domain)}</strong>, open its <strong>DNS</strong> settings and add:</p>
         <div class="overflow-x-auto mt-1"><table class="text-xs w-full border border-gray-200 rounded-lg" style="border-collapse:separate">
           <tr class="bg-gray-50 text-gray-600"><th class="text-left px-2 py-1">Type</th><th class="text-left px-2 py-1">Name / Host</th><th class="text-left px-2 py-1">Value / Points to</th></tr>
           ${(d.records || []).map((r) => `<tr><td class="px-2 py-1 font-bold">${esc(r.type)}</td><td class="px-2 py-1 font-mono">${esc(r.name)}</td><td class="px-2 py-1 font-mono">${esc(r.value)} <span class="ml-1">${btn(`data-site-copy="${esc(r.value)}"`, 'Copy')}</span></td></tr>
             <tr><td></td><td colspan="2" class="px-2 pb-1 text-gray-500">${esc(r.note)}</td></tr>`).join('')}
         </table></div>
         <p class="text-xs text-gray-500 mt-1">Some providers call Name "Host" and want it left blank or "@" for the bare domain. Changes can take from a few minutes to a few hours.</p>`
      : '';
    return `${head}
      <p class="text-xs mt-1"><strong>${esc(d.domain)}</strong>${d.altDomain ? ` <span class="text-gray-500">(and ${esc(d.altDomain)})</span>` : ''} · <span class="font-bold ${tone}">${esc(label)}</span></p>
      ${d.detail ? `<p class="text-xs text-gray-600 mt-1">${esc(d.detail)}</p>` : ''}
      ${records}
      ${canEdit ? `<div class="flex flex-wrap gap-2 mt-3">${d.status !== 'live' ? btn('data-site-domain-check', 'Check now', true) : ''}${btn('data-site-domain-remove', 'Remove domain')}</div>` : ''}`;
  }

  function placeholdersCard() {
    const list = state.data.placeholders || [];
    if (!list.length) return '';
    return `<div class="bg-amber-50 border border-amber-200 rounded-2xl p-4">
      <p class="text-sm font-bold text-amber-800">${list.length} part${list.length === 1 ? '' : 's'} in [square brackets] to fill in with your real details before you publish</p>
      <ul class="mt-2 space-y-1 list-disc pl-5">${list.slice(0, 8).map((x) => `<li class="text-xs text-amber-800">${esc(x.pageTitle)}: ${esc(x.text)}</li>`).join('')}</ul></div>`;
  }

  // ── Painting ───────────────────────────────────────────────────────────────
  // render() builds the tab as named blocks and paints them into wrappers that stay. A `keep` block
  // (the template galleries, full of live previews) is rewritten only when its HTML changed; the rest
  // are rewritten each time, keeping what was typed into a box the server hasn't changed since — so a
  // click, a save or the drafting poll no longer wipes a half-typed page title or draft request.
  // The section form is left out: syncEditing keeps it in state.editing, by position.
  const KEEP_TYPED = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]),textarea,select';
  function fieldKey(el) {
    if (el.closest('[data-site-section-form]')) return null;
    if (el.name) return `name=${el.name}`;
    const a = [...el.attributes].find((x) => x.name.startsWith('data-') && x.name !== 'data-max');
    return a ? `${a.name}=${a.value}` : null;
  }
  const defaultOf = (el) => (el.tagName === 'SELECT' ? ([...el.options].find((o) => o.defaultSelected) || el.options[0] || { value: '' }).value : el.defaultValue);
  function writeKeepingTyped(el, html) {
    const typed = new Map();
    const count = new Map();
    let focus = null;
    el.querySelectorAll(KEEP_TYPED).forEach((c) => {
      const k = fieldKey(c);
      if (!k) return;
      count.set(k, (count.get(k) || 0) + 1);
      if (c.value !== defaultOf(c)) typed.set(k, { value: c.value, was: defaultOf(c) });
      if (c === document.activeElement) focus = { k, from: c.selectionStart, to: c.selectionEnd };
    });
    el.innerHTML = html;
    el.querySelectorAll(KEEP_TYPED).forEach((c) => {
      const k = fieldKey(c);
      if (!k || count.get(k) !== 1) return;
      const t = typed.get(k);
      if (t && defaultOf(c) === t.was) { c.value = t.value; if (c.dataset.max) updateLenNote(c); }
      if (focus && focus.k === k) {
        c.focus({ preventScroll: true });
        try { if (focus.from != null) c.setSelectionRange(focus.from, focus.to); } catch { /* a select or colour box */ }
      }
    });
  }
  /** blocks: [key, html, { keep, live }] in order. An empty block is hidden; a `live` one (the note)
   *  stays in the page, empty and zero-height, so screen readers announce what is said in it. */
  function paintBlocks(parent, blocks) {
    const want = new Set(blocks.map(([key]) => key));
    [...parent.children].forEach((el) => { if (!want.has(el.dataset.siteBlock)) el.remove(); });
    let prev = null;
    for (const [key, html, opts = {}] of blocks) {
      let el = [...parent.children].find((x) => x.dataset.siteBlock === key);
      if (!el) {
        el = document.createElement('div');
        el.dataset.siteBlock = key;
        if (opts.live) { el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); }
      }
      const at = prev ? prev.nextSibling : parent.firstChild;
      if (el !== at) parent.insertBefore(el, at);
      if (!opts.keep || el._html !== html) { writeKeepingTyped(el, html); el._html = html; }
      if (opts.live) el.style.marginTop = html ? '' : '0';
      else el.hidden = !html;
      prev = el;
    }
  }
  /** Ties each label to the box after it (for/id) and names boxes that have only a placeholder, so a
   *  screen reader says what each box is for. One pass after painting covers every field helper. */
  let fieldSeq = 0;
  function nameFields(root) {
    root.querySelectorAll('label:not([for])').forEach((l) => {
      if (l.querySelector('input,select,textarea')) return;
      const n = l.nextElementSibling;
      const box = n && (n.matches('input,select,textarea') ? n : n.querySelector('input:not([type=hidden]),select,textarea'));
      if (!box) return;
      if (!box.id) box.id = `sb-field-${++fieldSeq}`;
      l.htmlFor = box.id;
    });
    root.querySelectorAll('input[placeholder]:not([aria-label]),textarea[placeholder]:not([aria-label])').forEach((c) => {
      if (!c.labels || !c.labels.length) c.setAttribute('aria-label', c.placeholder);
    });
  }
  /** After painting: the saved section back in view, and a new note where it can be seen — the note
   *  sits above the tabs, far from a Save at the bottom of a long form. */
  function afterPaint(host) {
    nameFields(host);
    if (state.focusSection) {
      const row = host.querySelector(`[data-site-edit="${CSS.escape(state.focusSection)}"]`);
      state.focusSection = null;
      if (row) { row.scrollIntoView({ block: 'center' }); row.focus({ preventScroll: true }); }
    }
    if (state.note && state.note !== state.noteShown) {
      const n = host.querySelector('[data-site-block="note"]');
      const r = n && n.getBoundingClientRect();
      if (r && (r.top < 0 || r.bottom > window.innerHeight)) {
        if (typeof window.showToast === 'function') window.showToast(state.note.text, { icon: state.note.tone === 'ok' ? '✅' : '⚠️' });
        else n.scrollIntoView({ block: 'center' });
      }
    }
    state.noteShown = state.note;
  }

  function render() {
    const host = document.querySelector(`[data-site-host="${state.surface}"]`);
    if (!host) return;
    if (!state.loaded) { host.innerHTML = card('<p class="text-sm text-gray-400 text-center">Loading your website…</p>'); return; }
    if (state.loadError && !state.data) { host.innerHTML = card(`<p class="text-sm font-bold text-gray-700 text-center">Could not load your website</p><p class="text-xs text-gray-500 mt-2 text-center">${esc(state.loadError)}</p>`); return; }
    paintTabBadges();
    if (state.surface !== 'website') {
      const body = state.surface === 'enquiries' ? enquiriesPanel() : state.surface === 'orders' ? ordersPanel() : bookingsPanel();
      if (!host.querySelector(':scope > [data-site-surface]')) host.innerHTML = '<div data-site-surface class="max-w-4xl space-y-4"></div>';
      paintBlocks(host.firstElementChild, [['note', noteHtml(), { live: true }], ['body', body]]);
      afterPaint(host);
      return;
    }
    const tabs = [['pages', 'Pages'], ['design', 'Design'], ['templates', 'Templates'], ['details', 'Details']].map(([k, l]) => btn(`data-site-panel="${k}"`, esc(l), state.panel === k)).join(' ');
    if (!host.querySelector(':scope > [data-site-layout]')) {
      host.innerHTML = '<div data-site-layout class="grid gap-4 lg:grid-cols-2"><div class="space-y-4 min-w-0"></div><div class="min-w-0"></div></div>';
    }
    const layout = host.firstElementChild;
    paintBlocks(layout.firstElementChild, [
      ['features', featuresOn() ? '' : featuresCard(true)],
      ['import', state.data.import || isFresh() ? importCard('start') : ''],
      ['templates', isFresh() && !def().settings.template ? templatesCard(true) : '', { keep: true }],
      ['draft', isFresh() || state.data.site.drafting || (def().settings.template && !state.data.site.publishedVersion) ? draftCard('start') : ''],
      ['publish', publishCard()],
      ['placeholders', placeholdersCard()],
      ['tabs', `<div class="flex flex-wrap gap-2">${tabs}</div>`],
      ['note', noteHtml(), { live: true }],
      [`panel-${state.panel}`, state.panel === 'pages' ? pagesPanel() : state.panel === 'design' ? designPanel() : state.panel === 'templates' ? templatesCard(false) : detailsPanel() + draftCard('again') + (state.data.import || isFresh() ? '' : importCard('again')), { keep: state.panel === 'templates' }],
    ]);
    paintPreview(layout.lastElementChild);
    afterPaint(host);
  }

  // The counts on the Enquiries / Orders / Bookings tabs — visible from every tab.
  function paintTabBadges() {
    const set = (id, n) => {
      const b = document.getElementById(id);
      if (!b) return;
      b.textContent = n ? String(n) : '';
      b.style.display = n ? '' : 'none';
      b.classList.toggle('hidden', !n);
    };
    const d = state.data || {};
    // Orders and Bookings tabs follow what the website does.
    const show = (id, on) => { const b = document.getElementById(id); if (b) { b.classList.toggle('hidden', !on); b.style.display = on ? '' : 'none'; } };
    if (state.data) { show('maintab-btn-siteorders', featureOn('shop')); show('maintab-btn-sitebookings', featureOn('bookings')); }
    set('site-enquiries-badge', d.newEnquiries || 0);
    set('site-orders-badge', d.newOrders || 0);
    set('site-bookings-badge', (d.booking && d.booking.waiting) || 0);
  }

  function rerender() { if (state.rendered) render(); }
  const say = (text, tone) => { state.note = text ? { text, tone } : null; rerender(); };
  const hostOf = (e) => e.target.closest && e.target.closest('[data-site-host]');

  // ── Events (bound once) ────────────────────────────────────────────────────
  // The preview's swans: `load` does not bubble, so listen in the capture phase.
  document.addEventListener('load', (e) => {
    if (e.target && e.target.matches && e.target.matches('iframe[data-site-preview]')) swanThePreview(e.target);
  }, true);
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest && e.target.closest('[data-site-section-form]');
    if (!form || !state.assistantId) return;
    e.preventDefault();
    const ed = state.editing;
    const props = readForm(form, ed.type);
    const look = readLook(form);
    const toPageId = readPagePick(form);
    const moving = toPageId && toPageId !== ed.pageId;
    const ops = ed.sectionId
      ? [{ op: 'update_section', pageId: ed.pageId, sectionId: ed.sectionId, props, look },
        ...(moving ? [{ op: 'move_section', pageId: ed.pageId, sectionId: ed.sectionId, toPageId, toIndex: 99 }] : [])]
      : [{ op: 'add_section', pageId: moving ? toPageId : ed.pageId, section: { type: ed.type, props, look } }];
    await apply(ops, () => {
      state.editing = null;
      if (moving) state.pageId = toPageId;
      const sections = (page() || { sections: [] }).sections;
      state.focusSection = ed.sectionId || (sections[sections.length - 1] || {}).id || null;
    });
  });

  document.addEventListener('click', async (e) => {
    if (!state.assistantId || !hostOf(e)) return;
    const t = (sel) => e.target.closest(sel);
    const p = page();

    const panel = t('[data-site-panel]');
    if (panel) {
      const want = panel.dataset.sitePanel;
      // Enquiries, Orders and Bookings are tabs of their own now.
      if (want === 'enquiries' || want === 'orders' || want === 'bookings') { window._activateMainTab?.(`site${want}`); return; }
      state.panel = want; state.editing = null;
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
    const toAud = t('[data-site-enquiry-audience]');
    if (toAud) {
      const q = (state.enquiries || []).find((x) => String(x.id) === toAud.dataset.siteEnquiryAudience);
      if (!q) return;
      const ok = await window.confirmModal(`Add <strong>${esc(q.name)}</strong> (${esc(q.email)}) to your Audience? Only do this if they've told you they'd like your emails — your Email Marketing Assistant will be able to send them news and offers.`, { title: 'Add to your Audience?', confirmLabel: 'They agreed — add them', cancelLabel: 'Not now' });
      if (!ok) return;
      try {
        const r = await post({ action: 'enquiry_to_audience', assistantId: state.assistantId, id: q.id, agreed: true });
        state.note = { text: r.note || 'Added to your Audience.', tone: 'ok' };
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
      const k = pickField.dataset.sitePick;
      const field = (FORMS[state.editing.type] || []).find((x) => x.k === k) || {};
      syncEditing(form);
      window.MediaPicker.open({
        title: field.video ? 'Choose a picture or video' : 'Choose a picture',
        video: !!field.video, topic: topicOf(state.editing.props), assistantName: state.assistantName,
        onPick: (asset) => {
          state.thumbs[asset.id] = asset.url;
          syncEditing(form);
          const prev = state.editing.props[k] || {};
          state.editing.props[k] = { assetId: asset.id, url: '', alt: prev.alt || altFromName(asset.name), ...(asset.video ? { video: true } : {}) };
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
    if (t('[data-site-open-reviews]')) { window._audienceInitialTab = 'reviews'; if (typeof window.loadView === 'function') window.loadView('audience'); return; }
    if (t('[data-site-open-hours]')) { window._bizinfoInitialTab = 'hours'; if (typeof window.loadView === 'function') window.loadView('assets'); return; }
    const sAdd = t('[data-session-add]');
    if (sAdd) {
      const draft = readSessionForm(sAdd.closest('[data-session-form]'));
      state.sessionDraft = draft;
      try {
        const r = await post({ action: 'session_add', assistantId: state.assistantId, session: { ...draft, serviceId: Number(draft.serviceId), capacity: Number(draft.capacity), repeatWeeks: Number(draft.repeatWeeks), resourceId: draft.resourceId ? Number(draft.resourceId) : null } });
        state.timetable = r.sessions || state.timetable;
        state.sessionDraft = { ...draft, date: '' };
        state.note = { text: r.added === 1 ? 'Date added.' : `${r.added} dates added.`, tone: 'ok' };
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
      window.MediaPicker.open({ title: 'Choose your logo', assistantName: state.assistantName, topic: `${def().settings.siteName} logo`, onPick: (asset) => { state.thumbs[asset.id] = asset.url; apply([{ op: 'set_theme', theme: { logoAssetId: asset.id } }]); } });
      return;
    }
    if (t('[data-site-logo-clear]')) { await apply([{ op: 'set_theme', theme: { logoAssetId: null, logoUrl: null } }]); return; }

    const gAdd = t('[data-gallery-add]');
    if (gAdd && window.MediaPicker) {
      const form = gAdd.closest('form');
      window.MediaPicker.open({
        title: 'Choose pictures and videos for your gallery', multiple: true, video: true,
        topic: topicOf(state.editing.props), assistantName: state.assistantName,
        onPickMany: (assets) => {
          syncEditing(form);
          const have = state.editing.props.images || [];
          const fresh = assets.filter((a) => !have.some((im) => im.assetId === a.id));
          fresh.forEach((a) => { state.thumbs[a.id] = a.url; });
          state.editing.props.images = [...have, ...fresh.map((a) => ({ assetId: a.id, url: '', alt: altFromName(a.name), caption: '', ...(a.video ? { video: true } : {}) }))].slice(0, 24);
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
    if (structure) {
      if (structure.value === def().structure) return;
      if (structure.value === 'pages') { await backToPages(); return; }
      await apply([{ op: 'set_structure', structure: structure.value }]);
      return;
    }
    const ask = t('[data-site-ask]');
    if (ask) { await askForChange(ask.dataset.page, ask.dataset.siteAsk); return; }
    if (t('[data-tpl-browse]')) { openTemplateGallery(); return; }
    const tplOpen = t('[data-tpl-open]');
    if (tplOpen) { openTemplate(tplOpen.dataset.tplOpen); return; }
    if (t('[data-site-split]')) { await backToPages(); return; }
    if (t('[data-site-features-save]')) {
      const host = hostOf(e);
      const features = [...host.querySelectorAll('[data-site-feature]:checked')].map((x) => x.dataset.siteFeature);
      // Switching off something already on the site: say what stays, rather than deleting their work.
      const off = (state.data.vocab.features || []).filter((f) => !features.includes(f.key));
      const inUse = off.filter((f) => def().pages.some((pg) => pg.sections.some((x) => f.sections.includes(x.type))));
      if (inUse.length) {
        const ok = await window.confirmModal(`Your site already has: ${inUse.map((f) => `<strong>${esc(f.label)}</strong>`).join(', ')}. Those sections stay where they are until you remove them — switching off only stops new ones being added or suggested.`, { title: 'Switch these off?', confirmLabel: 'Switch off', cancelLabel: 'Keep them on' });
        if (!ok) { rerender(); return; }
      }
      await apply([{ op: 'set_settings', settings: { features } }]);
      return;
    }
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
      if (hostOf(e).querySelector('[data-theme-accent-off]')?.checked) theme.accentColor = null;
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
    if (t('[data-site-domain-add]')) {
      const v = hostOf(e).querySelector('[data-site-domain-input]').value;
      state.domainTyped = v;
      await publishAction({ action: 'domain_add', domain: v }, 'Saved. Now add the settings below where you bought your domain.', () => { state.domainTyped = null; });
      return;
    }
    if (t('[data-site-domain-check]')) {
      await publishAction({ action: 'domain_check' }, 'Checked.');
      return;
    }
    if (t('[data-site-domain-remove]')) {
      const d = state.data.site.customDomain || {};
      const ok = await window.confirmModal(`${esc(d.domain)} stops showing your site${d.status === 'live' ? ` straight away, and visitors go back to ${esc((state.data.site.freeUrl || '').replace('https://', ''))}` : ''}. You can connect it again later.`, { title: 'Remove your domain?', confirmLabel: 'Remove', cancelLabel: 'Keep it' });
      if (!ok) return;
      await publishAction({ action: 'domain_remove' }, 'Domain removed.');
      return;
    }
    const copy = t('[data-site-copy]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.siteCopy); window.showToast?.('Copied.', { icon: '✅' }); } catch { /* the value is on screen to copy by hand */ }
      return;
    }
    if (t('[data-site-address-save]')) {
      const slug = hostOf(e).querySelector('[data-site-slug]').value;
      state.slugTyped = slug;   // kept if the address is refused, so what they typed isn't lost
      const s = state.data.site;
      if (s.status === 'published' && s.slug && slug.trim().toLowerCase() !== s.slug) {
        const ok = await window.confirmModal(`${(s.freeUrl || s.url).replace('https://', '')} stops working straight away and your site moves to the new address. Anyone with the old link will not find it.`, { title: 'Change your site\'s address?', confirmLabel: 'Change address', cancelLabel: 'Keep it' });
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
    // ── Import my current site ──
    if (t('[data-site-import-go]')) {
      keepImportForm(hostOf(e));
      const f = state.importForm;
      f.error = !String(f.url || '').trim() ? 'Type your website\'s address.' : !f.pictures ? 'Choose what happens to your pictures.' : !f.own ? 'Tick the box to say this website is yours — only import your own site.' : null;
      if (f.error) { render(); return; }
      try {
        state.data = await post({ action: 'import', assistantId: state.assistantId, url: f.url, ownSite: true, pictures: f.pictures });
        state.previewImport = false;
        say(null);
      } catch (err) { f.error = err.message; }
      schedulePoll();
      rerender();
      return;
    }
    if (t('[data-site-import-preview]')) { state.previewImport = !state.previewImport; state.previewPath = '/'; state.version++; render(); return; }
    if (t('[data-site-import-words]')) {
      Object.assign(state.words, { open: true, pageId: page().id, error: null, proposal: null });
      state.panel = 'pages';
      render();
      return;
    }
    if (t('[data-site-import-use]')) {
      const ok = typeof window.confirmModal === 'function'
        ? await window.confirmModal(`Your current draft is replaced with the ${state.data.import.pages.length} imported page${state.data.import.pages.length === 1 ? '' : 's'}. Your design stays. ${state.data.site.status === 'published' ? 'Your live site doesn\'t change until you publish.' : 'Nothing goes live until you publish.'}`, { title: 'Use the imported site as your draft?', confirmLabel: 'Use this as my draft', cancelLabel: 'Not now' })
        : true;
      if (!ok) return;
      try {
        state.data = await post({ action: 'import_accept', assistantId: state.assistantId });
        state.previewImport = false; state.previewPath = '/'; state.version++;
        state.pageId = def().pages[0].id;
        state.note = { text: (state.data.warnings || []).join(' ') || 'Your imported site is now your draft.', tone: 'ok' };
      } catch (err) { say(err.message, 'error'); }
      rerender();
      return;
    }
    if (t('[data-site-import-discard]')) {
      if (state.data.import && state.data.import.status === 'ready' && typeof window.confirmModal === 'function'
        && !(await window.confirmModal('The imported pages are thrown away. Your current draft stays as it is, and any pictures that were copied stay in your library.', { title: 'Discard the imported site?', confirmLabel: 'Discard', cancelLabel: 'Keep it' }))) return;
      try {
        state.data = await post({ action: 'import_discard', assistantId: state.assistantId });
        state.previewImport = false; state.version++;
        state.importForm = { url: null, own: false, pictures: null, error: null };
      } catch (err) { say(err.message, 'error'); }
      rerender();
      return;
    }
    if (t('[data-site-draft]')) {
      const ok = typeof window.confirmModal === 'function'
        ? await window.confirmModal(def().settings.template
            ? `Your Website Assistant rewrites the words in every section for your business. The layout, pictures and design stay. ${state.data.site.status === 'published' ? 'Your live site doesn\'t change until you publish.' : 'Nothing is live yet.'} This uses 1 task.`
            : `Your Website Assistant writes every page again, replacing your current draft. ${state.data.site.status === 'published' ? 'Your live site doesn\'t change until you publish.' : 'Nothing is live yet.'} This uses 1 task.`,
          { title: def().settings.template ? 'Write the words?' : 'Draft your whole site?', confirmLabel: def().settings.template ? 'Write the words' : 'Draft my site', cancelLabel: 'Not now' })
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

  /** What they typed in the import form, kept across re-renders (a poll redraws the tab). */
  function keepImportForm(host) {
    if (!host) return;
    const u = host.querySelector('[data-site-import-url]');
    const o = host.querySelector('[data-site-import-own]');
    const p = host.querySelector('input[name="site-import-pictures"]:checked');
    if (u) state.importForm.url = u.value;
    if (o) state.importForm.own = o.checked;
    if (p) state.importForm.pictures = p.value;
  }
  document.addEventListener('input', (e) => { if (e.target.closest && e.target.closest('[data-site-import-url]')) keepImportForm(hostOf(e)); });
  document.addEventListener('change', (e) => { if (e.target.closest && e.target.closest('[data-site-import-own], input[name="site-import-pictures"]')) keepImportForm(hostOf(e)); });

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
  document.addEventListener('input', (e) => {
    if (e.target.matches && e.target.matches('[data-max]')) updateLenNote(e.target);
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
      Object.assign(state, { assistantId, assistantName: assistantName || null, data: null, loaded: false, rendered: false, editing: null, pageId: null, previewPath: '/', note: null, editingAddress: false, slugTyped: null, versions: null, publishNote: null, enquiries: null, enquiryShown: 20, orders: null, orderShown: 20, refreshedPayments: false, domainChecked: false, domainTyped: null,
        words: { open: false, busy: false, file: null, error: null, proposal: null, pageId: null, text: '', note: '' },
        importForm: { url: null, own: false, pictures: null, error: null }, previewImport: false, dataSig: null, noteShown: null, focusSection: null });
      load();
    },
    // surface: 'website' (pages, design, details, preview) or 'enquiries' | 'orders' | 'bookings',
    // each its own tab. A list re-reads every time its tab is opened.
    activate(surface) {
      // A note ("Saved.") belongs to the tab it was said on.
      if ((surface || 'website') !== state.surface) state.note = null;
      state.surface = surface || 'website';
      state.rendered = true;
      state.editing = null;
      if (state.surface === 'enquiries') { state.enquiries = null; state.enquiryShown = 20; loadEnquiries(); }
      if (state.surface === 'orders') { state.orders = null; state.orderShown = 20; loadOrders(); }
      if (state.surface === 'bookings') { state.bookings = null; loadBookings(); }
      render();
    },
  };
})();
