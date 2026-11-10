// src/components/products-editor.js — Business Information ▸ Products & Services, as one editor that
// can open anywhere (docs/website-business-info-inline-plan.md §3). assets.html mounts it into its
// Products panel; the Website Assistant mounts it in its side drawer (site-facts-drawer.js) with
// { compact: true }, so a product is added beside the site instead of on another page.
//
// Talks to /.netlify/functions/org-products — the one place products and prices are saved. Every lookup
// is inside the root it was mounted in. Element ids are kept from when this lived in assets.html (tests
// and e2e/product-currency.spec.ts use them); only one copy is ever on a page, since workspace views
// replace each other.
//
// window.BizInfoEditors.products.mount(rootEl, { compact, openNew, productId, onSaved })
//   compact   — the drawer: no "What does your business offer?", intro offer or calls to action
//   openNew   — opens a blank product once loaded; productId — opens that product once loaded
//   onSaved() — after any add, change, archive, restore, reorder or delete (also fires 'bizinfo:products')
(function () {
    const API = '/.netlify/functions/org-products';
    // What the business offers, for any tab that shows fields by it (the Hours tab). get() resolves
    // once — from this tab's own load when it ran first, else from its own GET of the same endpoint.
    window.BizOffer = window.BizOffer || (() => {
      let value = null; let pending = null;
      return {
        get() {
          if (value) return Promise.resolve(value);
          return pending || (pending = fetch(API).then((r) => r.ok ? r.json() : {}).then((d) => d.offer || null).catch(() => null)
            .then((o) => { if (o && !value) value = o; return value; }));
        },
        set(o) { value = o; document.dispatchEvent(new CustomEvent('bizinfo:offer', { detail: o })); },
      };
    })();

  const TOP = `
<section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 mb-8">
  <div class="flex items-start justify-between gap-4 flex-wrap mb-5">
    <div>
      <h2 class="text-lg font-extrabold text-gray-900">Products &amp; services</h2>
      <p class="text-sm text-gray-500 mt-0.5 max-w-2xl">Everything you sell. Every one of your assistants reads this list, so posts, articles, emails and outreach name your products correctly and quote only the prices you give here.</p>
    </div>
    <button type="button" id="op-add" class="btn-primary text-sm font-bold flex items-center gap-1 px-3 py-1.5 rounded-md transition-colors shrink-0">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>Add Product or Service</button>
  </div>
`;
  // The drawer already has a frame and a title: no card around it, no second heading.
  const TOP_COMPACT = `
<section>
  <div class="flex items-start justify-between gap-3 flex-wrap mb-4">
    <div>
      <p class="text-sm text-gray-500 max-w-md">Everything you sell. Prices live here only — your website and checkout follow them.</p>
    </div>
    <button type="button" id="op-add" class="btn-primary text-sm font-bold flex items-center gap-1 px-3 py-1.5 rounded-md transition-colors shrink-0">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>Add Product or Service</button>
  </div>
`;
  const SETTINGS = `
  <!-- "What does your business offer?" (src/utils/offer-profile.ts) — decides which fields the
       editor below and the Hours tab show. Saved straight away; also settable from the Website
       Assistant's chat (offer_profile card), through the same PATCH. -->
  <div id="op-offer" class="hidden mb-5 border border-gray-200 bg-gray-50 rounded-xl px-4 py-3">
    <p class="text-sm font-bold text-gray-900">What does your business offer?</p>
    <p class="text-xs text-gray-500 mt-0.5">Tick all that apply. We only show the fields and tabs that fit, and your assistants work from it.</p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 mt-2">
      <label class="inline-flex items-start gap-2 text-sm"><input type="checkbox" data-op-offer value="products" class="mt-1"> We sell products (physical or digital)</label>
      <label class="inline-flex items-start gap-2 text-sm"><input type="checkbox" data-op-offer value="services" class="mt-1"> We provide services (consulting, trades, coaching, agencies)</label>
      <label class="inline-flex items-start gap-2 text-sm"><input type="checkbox" data-op-offer value="subscriptions" class="mt-1"> We sell software or subscriptions</label>
      <label class="inline-flex items-start gap-2 text-sm"><input type="checkbox" data-op-offer value="bookings" class="mt-1"> People book time with us (appointments, classes, tables or events)</label>
      <label class="inline-flex items-start gap-2 text-sm"><input type="checkbox" data-op-offer value="visits" class="mt-1"> Customers visit us (a shop, venue or studio)</label>
      <label class="inline-flex items-start gap-2 text-sm"><input type="checkbox" data-op-offer value="menu" class="mt-1"> We serve food or drink</label>
      <label class="inline-flex items-start gap-2 text-sm"><input type="checkbox" data-op-offer value="stays" class="mt-1"> Guests stay with us (holiday lets, B&amp;B or guest house rooms)</label>
    </div>
    <p id="op-offer-note" class="text-xs mt-1.5"></p>
  </div>
  <!-- "Do you offer a free trial or an introductory offer?" (src/utils/intro-offer.ts) — every
       assistant uses the answer (org-products.ts loadProductsBlock). The question and the order of
       kinds follow the ticks above. "No" saves at once; "Yes" opens the terms and a Save button.
       Also settable from any assistant's chat (intro_offer card), through the same PATCH. -->
  <div id="op-intro" class="hidden mb-5 border border-gray-200 bg-gray-50 rounded-xl px-4 py-3">
    <p id="op-intro-q" class="text-sm font-bold text-gray-900">Do you offer new customers a free trial or an introductory offer?</p>
    <p class="text-xs text-gray-500 mt-0.5">Every assistant uses your answer. Outreach, emails, posts and your website mention only this offer, on exactly these terms, and none at all if you say no.</p>
    <div class="flex flex-wrap gap-x-6 gap-y-1.5 mt-2">
      <label class="inline-flex items-center gap-2 text-sm cursor-pointer"><input type="radio" name="op-intro-has" value="yes"> Yes</label>
      <label class="inline-flex items-center gap-2 text-sm cursor-pointer"><input type="radio" name="op-intro-has" value="no"> No, we don't</label>
    </div>
    <div id="op-intro-form" class="hidden mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
      <label class="block text-xs font-semibold text-gray-700">What is it?
        <select id="op-intro-kind" class="mt-1 w-full px-3 py-2 rounded-lg border border-gray-300 text-sm bg-white font-normal"></select></label>
      <label id="op-intro-days-row" class="block text-xs font-semibold text-gray-700">How many days?
        <input id="op-intro-days" type="number" min="1" max="365" step="1" placeholder="e.g. 14" class="mt-1 w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-normal"></label>
      <fieldset id="op-intro-card-row" class="text-xs">
        <legend class="font-semibold text-gray-700">Card details to start?</legend>
        <div class="flex flex-wrap gap-x-6 gap-y-1.5 mt-1 text-sm">
          <label class="inline-flex items-center gap-1.5 cursor-pointer"><input type="radio" name="op-intro-card" value="no"> No card needed</label>
          <label class="inline-flex items-center gap-1.5 cursor-pointer"><input type="radio" name="op-intro-card" value="yes"> Card taken at sign-up</label>
        </div>
      </fieldset>
      <fieldset id="op-intro-after-row" class="text-xs">
        <legend class="font-semibold text-gray-700">When the trial ends</legend>
        <div class="flex flex-wrap gap-x-6 gap-y-1.5 mt-1 text-sm">
          <label class="inline-flex items-center gap-1.5 cursor-pointer"><input type="radio" name="op-intro-after" value="stops"> It just stops</label>
          <label class="inline-flex items-center gap-1.5 cursor-pointer"><input type="radio" name="op-intro-after" value="auto_charge"> The paid plan starts</label>
        </div>
      </fieldset>
      <label id="op-intro-terms-row" class="block text-xs font-semibold text-gray-700 sm:col-span-2">The offer in a few words <span id="op-intro-terms-opt" class="font-normal text-gray-400">(optional)</span>
        <input id="op-intro-terms" type="text" maxlength="300" placeholder="e.g. 20% off your first visit" class="mt-1 w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-normal"></label>
      <label class="block text-xs font-semibold text-gray-700">Who can have it <span class="font-normal text-gray-400">(optional)</span>
        <input id="op-intro-who" type="text" maxlength="200" placeholder="e.g. new customers only" class="mt-1 w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-normal"></label>
      <label class="block text-xs font-semibold text-gray-700">Which products or plans <span class="font-normal text-gray-400">(optional)</span>
        <input id="op-intro-applies" type="text" maxlength="200" placeholder="e.g. every plan" class="mt-1 w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-normal"></label>
      <label class="block text-xs font-semibold text-gray-700 sm:col-span-2">Where people start it <span class="font-normal text-gray-400">(optional link)</span>
        <input id="op-intro-url" type="url" maxlength="500" placeholder="https://" class="mt-1 w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-normal"></label>
      <div class="sm:col-span-2"><button type="button" id="op-intro-save" class="btn-primary text-sm font-bold px-3 py-1.5 rounded-md transition-colors">Save offer</button></div>
    </div>
    <p id="op-intro-note" class="text-xs mt-1.5"></p>
  </div>
  <!-- Calls to action (src/config/call-to-action.ts) — what each Social, Blog and Email assistant's
       work invites people to do: its own words, the offer above, or a sign-up form's free download.
       Saved per assistant on change; also settable from that assistant's chat (call_to_action card). -->
  <div id="op-cta" class="hidden mb-5 border border-gray-200 bg-gray-50 rounded-xl px-4 py-3">
    <p class="text-sm font-bold text-gray-900">Calls to action</p>
    <p class="text-xs text-gray-500 mt-0.5">What each assistant’s posts, articles and emails invite people to do. Social posts only ask now and then; most of them simply give.</p>
    <div id="op-cta-list" class="mt-2 space-y-2"></div>
  </div>
`;
  const BOTTOM = `
  <div id="op-error" class="hidden mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3"></div>
  <div id="op-editor-slot"></div>
  <div id="op-list" class="space-y-3">
    <div class="h-10 bg-gray-50 rounded-lg border border-dashed border-gray-200 flex items-center justify-center text-sm text-gray-400">Loading…</div>
  </div>
  <details id="op-archived-wrap" class="mt-6 hidden">
    <summary class="text-sm font-semibold text-gray-600 cursor-pointer select-none">Archived <span id="op-archived-count"></span> — not used by your assistants</summary>
    <div id="op-archived" class="space-y-3 mt-3"></div>
  </details>
</section>`;

  function mount(root, opts) {
    opts = opts || {};
    root.innerHTML = (opts.compact ? TOP_COMPACT : TOP + SETTINGS) + BOTTOM;
    const byId = (id) => root.querySelector('#' + id);
    let opened = false;
    // Tell whoever mounted this, and anything else on the page that shows products, that they changed.
    const changed = () => {
      try { if (typeof opts.onSaved === 'function') opts.onSaved(); } catch { /* the caller's problem, not the save's */ }
      document.dispatchEvent(new CustomEvent('bizinfo:products', { detail: { from: root } }));
    };
    // Saved somewhere else (another editor, a chat card): show the new list.
    document.addEventListener('bizinfo:products', (e) => { if (root.isConnected && e.detail?.from !== root && !byId('op-editor')) load(); });
    const listEl = byId('op-list');
    if (!listEl) return null;
    const slot = byId('op-editor-slot');
    const errEl = byId('op-error');
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let products = [];
    // { offers: ['bookings'|'menu'], answered } — null until loaded. Shared with the Hours tab
    // through window.BizOffer and a 'bizinfo:offer' event.
    let offer = null;

    const showError = (msg) => { errEl.textContent = msg || ''; errEl.classList.toggle('hidden', !msg); };
    const offers = (k) => !!offer && offer.offers.includes(k);

    function renderOffer() {
      const box = byId('op-offer');
      if (!box || !offer) return;
      box.classList.remove('hidden');
      box.querySelectorAll('[data-op-offer]').forEach((c) => { c.checked = offers(c.value); });
      const note = byId('op-offer-note');
      note.className = `text-xs mt-1.5 ${offer.answered ? 'text-gray-500' : 'text-amber-700'}`;
      note.textContent = offer.answered ? '' : 'We guessed this from your business details. Tick what\'s true and it\'s saved.';
      window.BizOffer.set(offer);
      refreshIntroChoices();
    }

    // ── Free trial / introductory offer (src/utils/intro-offer.ts) ────────────────────────────
    // undefined until loaded; null = not answered; { has: false } = no; { has: true, kind, … }.
    let introOffer;
    // Same wording and order as intro-offer.ts INTRO_OFFER_LABELS, suggestedIntroKinds and introOfferQuestion.
    const INTRO_LABELS = {
      free_trial: 'A free trial',
      freemium: 'A free plan',
      free_consultation: 'A free consultation or discovery call',
      first_visit: 'A first-visit or first-booking offer',
      intro_discount: 'An introductory discount',
      free_sample: 'A free sample or taster',
      money_back: 'A money-back guarantee',
      other: 'Something else',
    };
    const INTRO_DAYS = ['free_trial', 'money_back'];
    const INTRO_TERMS = ['freemium', 'first_visit', 'intro_discount', 'other'];
    const radioVal = (name) => (root.querySelector(`input[name="${name}"]:checked`) || {}).value || '';
    const setRadio = (name, v) => root.querySelectorAll(`input[name="${name}"]`).forEach((r) => { r.checked = r.value === v; });
    function introKinds() {
      const first = [];
      if (offers('subscriptions')) first.push('free_trial', 'freemium', 'money_back');
      if (offers('services')) first.push('free_consultation', 'intro_discount');
      if (offers('bookings') || offers('visits')) first.push('first_visit', 'intro_discount');
      if (offers('products') || offers('menu')) first.push('free_sample', 'intro_discount', 'money_back');
      return [...new Set([...first, ...Object.keys(INTRO_LABELS)])];
    }
    function introQuestion() {
      if (offers('subscriptions')) return 'Do you offer a free trial?';
      if (offers('services') || offers('bookings')) return 'Do you offer a free consultation or an introductory offer?';
      return 'Do you offer new customers a free trial or an introductory offer?';
    }
    // The question and the order of kinds follow the ticks above; a kind already chosen is kept.
    function refreshIntroChoices() {
      const sel = byId('op-intro-kind');
      if (!sel || introOffer === undefined) return;
      byId('op-intro-q').textContent = introQuestion();
      const keep = sel.value;
      sel.innerHTML = introKinds().map((k) => `<option value="${k}">${esc(INTRO_LABELS[k])}</option>`).join('');
      if (keep) sel.value = keep;
    }
    function introFields() {
      const k = byId('op-intro-kind').value;
      byId('op-intro-days-row').classList.toggle('hidden', !INTRO_DAYS.includes(k));
      byId('op-intro-card-row').classList.toggle('hidden', k !== 'free_trial');
      byId('op-intro-after-row').classList.toggle('hidden', k !== 'free_trial');
      byId('op-intro-terms-opt').classList.toggle('hidden', INTRO_TERMS.includes(k));
    }
    function introNote(text, tone) {
      const n = byId('op-intro-note');
      n.className = `text-xs mt-1.5 ${tone === 'error' ? 'text-red-600' : tone === 'warn' ? 'text-amber-700' : 'text-gray-500'}`;
      n.textContent = text || '';
    }
    function renderIntro() {
      const box = byId('op-intro');
      if (!box || introOffer === undefined) return;
      box.classList.remove('hidden');
      refreshIntroChoices();
      const o = introOffer;
      const yes = !!(o && o.has);
      setRadio('op-intro-has', o ? (yes ? 'yes' : 'no') : '');
      byId('op-intro-form').classList.toggle('hidden', !yes);
      byId('op-intro-kind').value = yes ? o.kind : introKinds()[0];
      byId('op-intro-days').value = yes && o.days ? o.days : '';
      setRadio('op-intro-card', yes && o.cardUpFront != null ? (o.cardUpFront ? 'yes' : 'no') : '');
      setRadio('op-intro-after', yes && o.afterwards ? o.afterwards : '');
      byId('op-intro-terms').value = yes ? o.terms || '' : '';
      byId('op-intro-who').value = yes ? o.whoFor || '' : '';
      byId('op-intro-applies').value = yes ? o.appliesTo || '' : '';
      byId('op-intro-url').value = yes ? o.url || '' : '';
      introFields();
      if (!o) introNote('Not answered yet. Until you answer, your assistants won\'t mention any free trial or offer.', 'warn');
      else introNote(yes ? 'Saved. Every assistant uses this offer, on exactly these terms.' : 'Saved. Your assistants won\'t offer a free trial or discount.');
    }
    async function saveIntro(payload) {
      introNote('Saving…');
      try {
        introOffer = (await call('PATCH', { introOffer: payload })).introOffer;
        renderIntro();
        refreshCtas();
      } catch (err) {
        introNote(err.message, 'error');
      }
    }
    function introFromForm() {
      const card = radioVal('op-intro-card');
      const days = byId('op-intro-days').value;
      return {
        has: true, kind: byId('op-intro-kind').value,
        days: days ? Number(days) : null,
        cardUpFront: card ? card === 'yes' : null,
        afterwards: radioVal('op-intro-after') || null,
        terms: byId('op-intro-terms').value, whoFor: byId('op-intro-who').value,
        appliesTo: byId('op-intro-applies').value, url: byId('op-intro-url').value,
      };
    }
    // The chat's intro_offer card saves through the same PATCH, then tells this tab (chat-session.js).
    document.addEventListener('bizinfo:introOffer', (e) => { if (!root.isConnected) return; introOffer = e.detail ?? null; renderIntro(); refreshCtas(); });

    // ── Calls to action (src/config/call-to-action.ts) ────────────────────────────────────────
    // { assistants: [{ id, name, roleKey, choice, resolved }], giftForms } — null until loaded.
    let ctas = null;
    const ctaNotes = {};
    // Same wording as src/config/call-to-action.ts CTA_LABELS.
    const CTA_LABELS = {
      own: 'Its own call to action',
      intro_offer: 'Your free trial or introductory offer',
      gift: 'A free download from a sign-up form',
    };
    const CTA_ROLE_NAMES = { social_media_manager: 'Social posts', blog_writer: 'Blog articles', newsletter_editor: 'Emails' };
    function ctaDescribe(r) {
      if (r.kind === 'intro_offer') return `Invites people to your offer${r.url ? '' : ' (no link — add one to your offer above)'}.`;
      if (r.kind === 'gift') return `Invites people to get the free “${r.giftLabel}”${r.url ? '' : ' (that form has no page of its own yet, so there’s no link)'}.`;
      return r.unusable ? `${r.unusable} Until then it uses its own.` : 'Uses the call to action in its own brief.';
    }
    function renderCtas() {
      const box = byId('op-cta');
      if (!box || !ctas) return;
      const list = ctas.assistants || [];
      box.classList.toggle('hidden', !list.length);
      const forms = ctas.giftForms || [];
      byId('op-cta-list').innerHTML = list.map((a) => {
        const kind = a.choice.kind;
        const formId = a.resolved.kind === 'gift' ? a.resolved.formId : a.choice.formId;
        const note = ctaNotes[a.id];
        return `<div class="bg-white border border-gray-200 rounded-lg px-3 py-2" data-cta-row="${a.id}">
          <div class="flex flex-col sm:flex-row sm:items-center gap-2">
            <p class="text-sm font-semibold text-gray-800 sm:w-64 min-w-0 truncate">${esc(a.name)} <span class="text-xs font-normal text-gray-500">· ${esc(CTA_ROLE_NAMES[a.roleKey] || '')}</span></p>
            <select data-cta-kind class="w-full sm:w-64 px-2 py-1.5 rounded-lg border border-gray-300 text-sm bg-white">
              ${Object.keys(CTA_LABELS).map((k) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${esc(CTA_LABELS[k])}</option>`).join('')}
            </select>
            <select data-cta-form class="w-full sm:w-64 px-2 py-1.5 rounded-lg border border-gray-300 text-sm bg-white ${kind === 'gift' ? '' : 'hidden'}">
              ${forms.length ? forms.map((f) => `<option value="${f.id}" ${f.id === formId ? 'selected' : ''}>${esc(f.name)} — ${esc(f.giftLabel)}</option>`).join('') : '<option value="">No form sends a free download yet</option>'}
            </select>
          </div>
          <p class="text-xs mt-1 ${note && note.error ? 'text-red-600' : 'text-gray-500'}">${esc(note ? note.text : ctaDescribe(a.resolved))}</p>
        </div>`;
      }).join('');
    }
    async function saveCtaRow(row) {
      const id = Number(row.dataset.ctaRow);
      const kind = row.querySelector('[data-cta-kind]').value;
      const formId = kind === 'gift' ? Number(row.querySelector('[data-cta-form]').value) || null : null;
      ctaNotes[id] = { text: 'Saving…' };
      renderCtas();
      try {
        const { assistant } = await call('PATCH', { callToAction: { assistantId: id, kind, formId } });
        ctas.assistants = ctas.assistants.map((a) => (a.id === id ? assistant : a));
        ctaNotes[id] = { text: `Saved. ${ctaDescribe(assistant.resolved)}` };
      } catch (err) {
        ctaNotes[id] = { text: err.message, error: true };
      }
      renderCtas();
    }
    // After the offer above changes, what each call to action resolves to may change too.
    async function refreshCtas() {
      try { const d = await call('GET'); ctas = d.callsToAction || null; renderCtas(); } catch { /* keep what is shown */ }
    }
    // The chat's call_to_action card saved (chat-session.js).
    document.addEventListener('bizinfo:callToAction', () => { if (root.isConnected) refreshCtas(); });

    /**
     * Which optional groups of fields this product shows. A group the business doesn't use stays in
     * the form, only hidden — so saving never clears a value — and a product that already HAS a
     * value in it (an allergen, a deposit) shows the group anyway, so nothing typed in disappears.
     */
    function applyGroups(f) {
      if (!f) return;
      const kind = (f.querySelector('input[name="op-kind"]:checked') || {}).value;
      const val = (id) => (f.querySelector('#' + id) || {}).value || '';
      const bookings = offers('bookings') || !!val('op-duration') || !!val('op-deposit-type');
      const menu = offers('menu') || !!val('op-allergens') || !!f.querySelector('[data-op-diet]:checked');
      f.querySelector('#op-duration-row').classList.toggle('hidden', !(bookings && kind === 'service'));
      f.querySelector('[data-op-group="bookings"]').classList.toggle('hidden', !bookings);
      f.querySelector('[data-op-group="menu"]').classList.toggle('hidden', !menu);
    }
    async function call(method, body, query) {
      const res = await fetch(API + (query || ''), {
        method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      return data;
    }

    function card(p, i, active) {
      const meta = [p.price ? `<span class="font-semibold text-gray-800">${esc(p.price)}</span>` : '',
        p.durationMinutes ? `${esc(p.durationMinutes)} min` : '',
        p.durationMinutes && p.meetingLocation === 'video' ? 'Video call' : p.durationMinutes && p.meetingLocation === 'phone' ? 'Phone call' : '',
        Array.isArray(p.dietary) && p.dietary.length ? esc(p.dietary.map(d => ({ vegetarian: 'V', vegan: 'VG', gluten_free: 'GF', dairy_free: 'DF', contains_nuts: 'N', spicy: '🌶' }[d] || '')).filter(Boolean).join(' · ')) : '',
        p.depositType === 'fixed' && p.depositAmount ? `£${esc((p.depositAmount / 100).toFixed(2).replace(/\.00$/, ''))} deposit` : p.depositType === 'percent' && p.depositAmount ? `${esc(p.depositAmount)}% deposit` : '',
        p.audience ? `For ${esc(p.audience)}` : ''].filter(Boolean).join(' · ');
      return `<div class="op-card border border-gray-200 rounded-xl p-4" data-id="${p.id}">
        <div class="flex items-start justify-between gap-3">
          ${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" class="shrink-0" style="width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb">` : ''}
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="text-sm font-bold text-gray-900">${esc(p.name)}</h3>
              <span class="text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">${p.kind === 'service' ? 'Service' : 'Product'}</span>
            </div>
            ${meta ? `<p class="text-xs text-gray-500 mt-1">${meta}</p>` : ''}
            ${p.description ? `<p class="text-sm text-gray-600 mt-2 whitespace-pre-line">${esc(p.description)}</p>` : ''}
            ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" class="link text-xs mt-1 inline-block break-all">${esc(p.url)}</a>` : ''}
          </div>
          <div class="flex items-center gap-1 shrink-0">
            ${active ? `<button type="button" class="op-up btn-utility text-xs px-2 py-1 rounded" title="Move up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="op-down btn-utility text-xs px-2 py-1 rounded" title="Move down" aria-label="Move down">↓</button>
            <button type="button" class="op-edit btn-utility text-xs font-bold px-2.5 py-1 rounded">Edit</button>
            <button type="button" class="op-archive btn-utility text-xs font-bold px-2.5 py-1 rounded">Archive</button>`
            : `<button type="button" class="op-restore btn-utility text-xs font-bold px-2.5 py-1 rounded">Restore</button>
            <button type="button" class="op-delete btn-destructive text-xs font-bold px-2.5 py-1 rounded">Delete</button>`}
          </div>
        </div>
      </div>`;
    }

    function render() {
      const active = products.filter(p => p.status === 'active');
      const archived = products.filter(p => p.status !== 'active');
      listEl.innerHTML = active.length
        ? active.map((p, i) => card(p, i, true)).join('')
        : `<div class="text-sm text-gray-500 bg-gray-50 border border-dashed border-gray-200 rounded-xl px-4 py-6 text-center">No products or services yet — click “Add Product or Service” to add your first. Until you do, your assistants only know what the Business Profile says you do.</div>`;
      const lastDown = listEl.querySelectorAll('.op-down');
      if (lastDown.length) lastDown[lastDown.length - 1].disabled = true;
      const wrap = byId('op-archived-wrap');
      wrap.classList.toggle('hidden', !archived.length);
      byId('op-archived-count').textContent = archived.length ? `(${archived.length})` : '';
      byId('op-archived').innerHTML = archived.map((p, i) => card(p, i, false)).join('');
    }

    async function load() {
      try {
        const data = await call('GET');
        products = data.products || [];
        offer = data.offer || null;
        introOffer = data.introOffer ?? null;
        ctas = data.callsToAction || null;
        showError('');
        render();
        renderOffer();
        renderIntro();
        renderCtas();
        if (!opened && opts.productId) { opened = true; const p = products.find((x) => x.id === Number(opts.productId)); if (p) openEditor(p); }
        if (!opened && opts.openNew) { opened = true; openEditor(null); }
      } catch (e) {
        listEl.innerHTML = '';
        showError('Your products could not be loaded right now. Please refresh and try again.');
      }
    }

    // One editor at a time: a new product opens at the top, an edit replaces that card in place.
    function openEditor(p) {
      closeEditor();
      // Looked up AFTER closeEditor(): it re-renders the list, so a card found before it is detached.
      const anchor = p ? listEl.querySelector(`.op-card[data-id="${p.id}"]`) : null;
      const f = document.createElement('div');
      f.id = 'op-editor';
      f.className = 'border-2 border-emerald-200 bg-emerald-50/30 rounded-xl p-4 mb-3';
      // A new item starts as what this business mostly sells: a service when it ticked services but
      // not products, and priced "a month" when it sells subscriptions (offer-profile.ts).
      // …and in the currency its other prices are in (the most recently saved one), so a business that
      // sells in dollars picks it once.
      const lastCurrency = (products.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || {}).priceCurrency;
      const v = p || { kind: offers('services') && !offers('products') ? 'service' : 'product', priceCurrency: lastCurrency || 'GBP',
        ...(offers('subscriptions') ? { priceType: 'fixed', priceUnit: 'a month' } : {}) };
      const field = (id, label, value, opts) => `<div class="${opts && opts.wide ? 'sm:col-span-2' : ''}">
          <label for="${id}"${opts && opts.explain ? ` data-explain="${opts.explain}"` : ''} class="block text-sm font-semibold text-gray-700 mb-1">${label}</label>
          ${opts && opts.area
            ? `<textarea id="${id}" rows="${opts.rows || 3}" maxlength="${opts.max}" placeholder="${esc(opts.ph || '')}" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:ring-2 focus:ring-emerald-600 outline-none">${esc(value || '')}</textarea>`
            : `<input id="${id}" type="text" maxlength="${opts.max}" value="${esc(value || '')}" placeholder="${esc(opts.ph || '')}" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:ring-2 focus:ring-emerald-600 outline-none">`}
        </div>`;
      f.innerHTML = `
        <div class="flex items-center gap-4 mb-3 text-sm">
          <span class="font-semibold text-gray-700" data-explain="acct-product-kind">Type</span>
          <label class="inline-flex items-center gap-1.5 cursor-pointer"><input type="radio" name="op-kind" value="product" ${v.kind !== 'service' ? 'checked' : ''}> Product</label>
          <label class="inline-flex items-center gap-1.5 cursor-pointer"><input type="radio" name="op-kind" value="service" ${v.kind === 'service' ? 'checked' : ''}> Service</label>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${field('op-name', 'Name <span class="text-red-500">*</span>', v.name, { max: 120, ph: 'e.g. Sourdough Starter Kit', explain: 'acct-product-name' })}
          ${priceFieldsHtml(v)}
          ${field('op-description', 'What it is', v.description, { area: true, max: 1200, wide: true, ph: 'What the customer gets, in a sentence or two.', explain: 'acct-product-description' })}
          ${field('op-benefits', 'Key benefits', v.benefits, { area: true, rows: 2, max: 1200, wide: true, ph: 'Why people buy it — the results or features you want mentioned.', explain: 'acct-product-benefits' })}
          ${field('op-audience', 'Who it’s for', v.audience, { max: 400, ph: 'e.g. home bakers starting out', explain: 'acct-product-audience' })}
          ${field('op-url', 'Link', v.url, { max: 500, ph: 'https://yourbusiness.com/product', explain: 'acct-product-url' })}
        </div>
        <div class="mt-3">
          <p class="block text-sm font-semibold text-gray-700 mb-1">Picture</p>
          <div class="flex flex-wrap items-center gap-3">
            <span data-op-thumb>${v.imageUrl ? `<img src="${esc(v.imageUrl)}" alt="" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb">` : '<span class="inline-flex items-center justify-center text-xs text-gray-400 border border-dashed border-gray-300 rounded-lg" style="width:72px;height:72px">None</span>'}</span>
            <input type="hidden" id="op-image" value="${esc(v.imageAssetId || '')}">
            <button type="button" id="op-pick" class="btn-secondary text-sm font-bold px-3 py-1.5 rounded-md border">${v.imageAssetId ? 'Change picture' : 'Choose picture'}</button>
            <button type="button" id="op-pick-clear" class="btn-utility text-xs font-bold px-2.5 py-1 rounded ${v.imageAssetId ? '' : 'hidden'}">Remove</button>
          </div>
          <p class="text-xs text-gray-500 mt-1">Shown with it on your website and at checkout.</p>
        </div>
        <p class="text-xs text-gray-500 mt-3">This is the one place prices live. Your assistants, your website and checkout all use the price exactly as set here — and never state one you leave off.</p>
        <div class="flex items-center justify-end gap-2 mt-3">
          <button type="button" id="op-cancel" class="btn-secondary text-sm font-bold px-3 py-1.5 rounded-md border">Cancel</button>
          <button type="button" id="op-save" class="btn-primary text-sm font-bold px-3 py-1.5 rounded-md">${p ? 'Save Changes' : 'Add'}</button>
        </div>`;
      if (anchor) anchor.replaceWith(f); else slot.appendChild(f);
      f.dataset.id = p ? String(p.id) : '';
      applyGroups(f);
      f.querySelector('#op-name').focus();
    }
    // The price, structured (src/utils/product-price.ts): how it is shown, the amount, an optional unit.
    // Only a fixed price can be bought online from your website. Services also get how long they take.
    // The currencies a price can be in — mirrors src/utils/product-price.ts PRICE_CURRENCIES.
    const PRICE_CURRENCIES = { GBP: { symbol: '£', label: 'Pounds (GBP)' }, USD: { symbol: '$', label: 'US dollars (USD)' }, EUR: { symbol: '€', label: 'Euros (EUR)' }, AUD: { symbol: 'A$', label: 'Australian dollars (AUD)' }, CAD: { symbol: 'C$', label: 'Canadian dollars (CAD)' } };
    function priceFieldsHtml(v) {
      const t = v.priceType || '';
      const pounds = v.priceAmount != null ? (v.priceAmount / 100).toFixed(2).replace(/\.00$/, '') : '';
      const opt = (val, label) => `<option value="${val}" ${t === val ? 'selected' : ''}>${label}</option>`;
      const cur = PRICE_CURRENCIES[v.priceCurrency] ? v.priceCurrency : 'GBP';
      return `<div data-explain="acct-product-price">
          <label for="op-price-type" class="block text-sm font-semibold text-gray-700 mb-1">Price</label>
          <select id="op-price-type" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm bg-white">
            ${opt('', 'No price shown')}${opt('fixed', 'A fixed price')}${opt('from', 'From a price')}${opt('on_request', 'Price on request')}${opt('text', 'I\'ll write it myself')}
          </select>
          <div id="op-price-amount-row" class="mt-2 ${t === 'fixed' || t === 'from' ? '' : 'hidden'}">
            <select id="op-price-currency" aria-label="Currency" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm bg-white mb-2">
              ${Object.entries(PRICE_CURRENCIES).map(([code, c]) => `<option value="${code}" ${cur === code ? 'selected' : ''}>${c.symbol} ${c.label}</option>`).join('')}
            </select>
            <div class="grid grid-cols-2 gap-2">
              <div class="flex items-center gap-1"><span id="op-price-symbol" class="text-sm font-semibold text-gray-600">${PRICE_CURRENCIES[cur].symbol}</span>
                <input id="op-price-amount" type="text" inputmode="decimal" value="${esc(pounds)}" placeholder="24.50" aria-label="Price" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm"></div>
              <input id="op-price-unit" type="text" maxlength="30" value="${esc(v.priceUnit || '')}" placeholder="per hour (optional)" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm">
            </div>
          </div>
          <input id="op-price-text" type="text" maxlength="120" value="${esc(t === 'text' ? (v.price || '') : '')}" placeholder="e.g. £15 a month, first month free" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm mt-2 ${t === 'text' ? '' : 'hidden'}">
          ${offers('products') || !offer ? '<p class="text-xs text-gray-500 mt-1">Only a fixed price can be bought online from your website.</p>' : ''}
        </div>
        <div id="op-duration-row" class="${v.kind === 'service' ? '' : 'hidden'}">
          <label for="op-duration" class="block text-sm font-semibold text-gray-700 mb-1">How long it takes (minutes)</label>
          <input id="op-duration" type="number" min="5" max="1440" step="5" value="${esc(v.durationMinutes || '')}" placeholder="e.g. 45" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm">
          <p class="text-xs text-gray-500 mt-1">Used when people book it.</p>
          <label for="op-meeting" class="block text-sm font-semibold text-gray-700 mb-1 mt-3">Where it happens</label>
          <select id="op-meeting" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm bg-white">
            <option value="in_person" ${!v.meetingLocation || v.meetingLocation === 'in_person' ? 'selected' : ''}>In person</option>
            <option value="video" ${v.meetingLocation === 'video' ? 'selected' : ''}>Video call</option>
            <option value="phone" ${v.meetingLocation === 'phone' ? 'selected' : ''}>Phone call (you call them)</option>
          </select>
          <p class="text-xs text-gray-500 mt-1">Video calls use your meeting link from the Bookings tab, sent once a booking is confirmed. Phone calls ask for their number.</p>
        </div>
        <div class="sm:col-span-2" data-op-group="menu">
          <p class="block text-sm font-semibold text-gray-700 mb-1">Dietary (for food — optional)</p>
          <div class="flex flex-wrap gap-x-4 gap-y-1">${[['vegetarian', 'Vegetarian (V)'], ['vegan', 'Vegan (VG)'], ['gluten_free', 'Gluten-free (GF)'], ['dairy_free', 'Dairy-free (DF)'], ['contains_nuts', 'Contains nuts (N)'], ['spicy', 'Spicy (🌶)']].map(([k, l]) => `<label class="inline-flex items-center gap-1.5 text-sm"><input type="checkbox" data-op-diet value="${k}" ${Array.isArray(v.dietary) && v.dietary.includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
          <input id="op-allergens" type="text" maxlength="200" value="${esc(v.allergens || '')}" placeholder="Allergens, in your words — e.g. Contains: milk, egg, sesame" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm mt-2">
          <p class="text-xs text-gray-500 mt-1">Shown on your website's menus with a key, and "ask us about allergens". Only tick what's true — your assistants repeat it as you state it.</p>
        </div>
        <div data-op-group="bookings">
          <label for="op-deposit-type" class="block text-sm font-semibold text-gray-700 mb-1">Deposit when booked online (optional)</label>
          <select id="op-deposit-type" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm bg-white">
            <option value="" ${!v.depositType ? 'selected' : ''}>No deposit</option>
            <option value="fixed" ${v.depositType === 'fixed' ? 'selected' : ''}>A fixed amount</option>
            <option value="percent" ${v.depositType === 'percent' ? 'selected' : ''}>A percentage of the price</option>
          </select>
          <p id="op-deposit-currency-note" class="text-xs text-amber-700 mt-1 ${cur === 'GBP' || !(t === 'fixed' || t === 'from') ? 'hidden' : ''}">Deposits can only be taken in pounds for now, so this price can't take one.</p>
          <div id="op-deposit-amount-row" class="flex items-center gap-1 mt-2 ${v.depositType ? '' : 'hidden'}">
            <span id="op-deposit-pound" class="text-sm font-semibold text-gray-600 ${v.depositType === 'percent' ? 'hidden' : ''}">£</span>
            <input id="op-deposit-amount" type="text" inputmode="decimal" value="${esc(v.depositType === 'fixed' && v.depositAmount != null ? (v.depositAmount / 100).toFixed(2).replace(/\.00$/, '') : v.depositType === 'percent' ? String(v.depositAmount || '') : '')}" placeholder="${v.depositType === 'percent' ? '20' : '10'}" aria-label="Deposit amount" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm">
            <span id="op-deposit-pct" class="text-sm font-semibold text-gray-600 ${v.depositType === 'percent' ? '' : 'hidden'}">%</span>
          </div>
          <p class="text-xs text-gray-500 mt-1">Paid to your own Stripe account when someone books it from your website (per place for a class). Refunded automatically if they cancel online in time, or if you cancel or decline. Needs Stripe connected on the Website tab's Orders.</p>
        </div>`;
    }

    function closeEditor() {
      const open = byId('op-editor');
      if (!open) return;
      open.remove();
      render(); // puts back the card an in-place edit replaced
    }

    // A tick saves at once — there's no Save button for one question.
    async function saveOffer() {
      const ticked = [...root.querySelectorAll('[data-op-offer]:checked')].map((c) => c.value);
      try {
        offer = (await call('PATCH', { offer: ticked })).offer;
        showError('');
      } catch (err) {
        showError(err.message);
      }
      renderOffer();
      applyGroups(byId('op-editor'));
    }

    async function save() {
      const f = byId('op-editor');
      if (!f) return;
      const get = id => f.querySelector('#' + id).value;
      const body = {
        kind: (f.querySelector('input[name="op-kind"]:checked') || {}).value || 'product',
        name: get('op-name'), description: get('op-description'),
        benefits: get('op-benefits'), audience: get('op-audience'), url: get('op-url'),
        priceType: get('op-price-type') || null, priceAmount: get('op-price-amount'), priceUnit: get('op-price-unit'), priceCurrency: get('op-price-currency'),
        price: get('op-price-text'),
        durationMinutes: get('op-duration') ? Number(get('op-duration')) : null,
        meetingLocation: get('op-meeting') || 'in_person',
        depositType: get('op-deposit-type') || null, depositAmount: get('op-deposit-amount'),
        dietary: [...f.querySelectorAll('[data-op-diet]:checked')].map(x => x.value), allergens: get('op-allergens'),
        imageAssetId: get('op-image') ? Number(get('op-image')) : null,
      };
      if (!body.name.trim()) { showError('Give the product or service a name.'); f.querySelector('#op-name').focus(); return; }
      const btn = f.querySelector('#op-save');
      btn.disabled = true;
      try {
        if (f.dataset.id) {
          const { product } = await call('PATCH', { id: Number(f.dataset.id), ...body });
          products = products.map(x => x.id === product.id ? product : x);
        } else {
          const { product } = await call('POST', body);
          products.push(product);
          // The setup wizard's "Products & services" step ticks on the first active product.
          window.SetupWizard?.refresh?.();
        }
        showError('');
        f.remove();
        render();
        changed();
      } catch (e) { showError(e.message); btn.disabled = false; }
    }

    async function setStatus(id, status) {
      try {
        const { product } = await call('PATCH', { id, status });
        products = products.map(x => x.id === product.id ? product : x);
        showError(''); render(); changed();
      } catch (e) { showError(e.message); }
    }

    async function move(id, dir) {
      const active = products.filter(p => p.status === 'active');
      const i = active.findIndex(p => p.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= active.length) return;
      [active[i], active[j]] = [active[j], active[i]];
      active.forEach((p, n) => { p.sortOrder = n; });
      products = [...active, ...products.filter(p => p.status !== 'active')];
      render();
      try {
        await Promise.all([active[i], active[j]].map(p => call('PATCH', { id: p.id, sortOrder: p.sortOrder })));
        changed();
      } catch (e) { showError(e.message); load(); }
    }

    // Bound on the section, which this script owns for the life of the page (never re-rendered).
    const section = listEl.closest('section');
    // Show the price boxes that fit the choice; services also ask how long they take.
    section.addEventListener('change', async (e) => {
      if (e.target.matches('[data-op-offer]')) return saveOffer();
      // "No" is the whole answer, so it saves at once; "Yes" opens the terms and waits for Save.
      if (e.target.name === 'op-intro-has') {
        if (e.target.value === 'no') return saveIntro({ has: false });
        byId('op-intro-form').classList.remove('hidden');
        introFields();
        return introNote('Fill in the terms, then Save offer.');
      }
      if (e.target.id === 'op-intro-kind') return introFields();
      // A call to action saves on change; choosing "free download" shows the form picker first
      // and saves with the form it shows.
      const ctaRow = e.target.closest('[data-cta-row]');
      if (ctaRow) {
        if (e.target.matches('[data-cta-kind]')) ctaRow.querySelector('[data-cta-form]').classList.toggle('hidden', e.target.value !== 'gift');
        return saveCtaRow(ctaRow);
      }
      const f = byId('op-editor');
      if (!f) return;
      if (e.target.id === 'op-price-type') {
        const t = e.target.value;
        f.querySelector('#op-price-amount-row').classList.toggle('hidden', !(t === 'fixed' || t === 'from'));
        f.querySelector('#op-price-text').classList.toggle('hidden', t !== 'text');
      }
      if (e.target.id === 'op-price-type' || e.target.id === 'op-price-currency') {
        const c = f.querySelector('#op-price-currency').value;
        const t = f.querySelector('#op-price-type').value;
        f.querySelector('#op-price-symbol').textContent = (PRICE_CURRENCIES[c] || PRICE_CURRENCIES.GBP).symbol;
        f.querySelector('#op-deposit-currency-note').classList.toggle('hidden', c === 'GBP' || !(t === 'fixed' || t === 'from'));
      }
      if (e.target.name === 'op-kind') applyGroups(f);
      if (e.target.id === 'op-deposit-type') {
        const t = e.target.value;
        f.querySelector('#op-deposit-amount-row').classList.toggle('hidden', !t);
        f.querySelector('#op-deposit-pound').classList.toggle('hidden', t !== 'fixed');
        f.querySelector('#op-deposit-pct').classList.toggle('hidden', t !== 'percent');
      }
    });
    section.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const id = Number(t.closest('.op-card')?.dataset.id);
      if (t.id === 'op-add') return openEditor(null);
      if (t.id === 'op-intro-save') return saveIntro(introFromForm());
      if (t.id === 'op-cancel') return closeEditor();
      if (t.id === 'op-save') return save();
      if (t.id === 'op-pick' && window.MediaPicker) {
        return window.MediaPicker.open({ title: 'Choose a picture', onPick: (asset) => {
          const f = byId('op-editor');
          if (!f) return;
          f.querySelector('#op-image').value = String(asset.id);
          f.querySelector('[data-op-thumb]').innerHTML = `<img src="${esc(asset.url)}" alt="" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb">`;
          f.querySelector('#op-pick').textContent = 'Change picture';
          f.querySelector('#op-pick-clear').classList.remove('hidden');
        } });
      }
      if (t.id === 'op-pick-clear') {
        const f = byId('op-editor');
        f.querySelector('#op-image').value = '';
        f.querySelector('[data-op-thumb]').innerHTML = '<span class="inline-flex items-center justify-center text-xs text-gray-400 border border-dashed border-gray-300 rounded-lg" style="width:72px;height:72px">None</span>';
        f.querySelector('#op-pick').textContent = 'Choose picture';
        t.classList.add('hidden');
        return;
      }
      if (t.classList.contains('op-edit')) return openEditor(products.find(p => p.id === id));
      if (t.classList.contains('op-archive')) return setStatus(id, 'archived');
      if (t.classList.contains('op-restore')) return setStatus(id, 'active');
      if (t.classList.contains('op-up')) return move(id, -1);
      if (t.classList.contains('op-down')) return move(id, 1);
      if (t.classList.contains('op-delete')) {
        const p = products.find(x => x.id === id);
        const ok = window.confirmModal
          ? await window.confirmModal(`“${p ? p.name : 'This product'}” will be removed for good. Archive keeps it without your assistants using it.`, { title: 'Delete this product?', confirmLabel: 'Yes, delete', cancelLabel: 'Keep it' })
          : false;
        if (!ok) return;
        try { await call('DELETE', null, '?id=' + id); products = products.filter(x => x.id !== id); showError(''); render(); changed(); }
        catch (err) { showError(err.message); }
      }
    });
    section.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('#op-editor input[type="text"]')) { e.preventDefault(); save(); }
      if (e.key === 'Escape' && e.target.closest('#op-editor')) closeEditor();
    });

    load();
    return { reload: load, openNew: () => openEditor(null) };
  }

  window.BizInfoEditors = window.BizInfoEditors || {};
  window.BizInfoEditors.products = { mount };

  // Business Information's own Products tab: mounted the first time the tab is shown, like Brand
  // Assets — most visits never open it. (This file is re-run each time that view loads.)
  const panel = document.querySelector('.bizinfo-tab-panel[data-panel="products"]');
  const host = document.getElementById('products-root');
  if (panel && host) {
    let started = false;
    const maybeMount = () => {
      if (started || panel.classList.contains('hidden')) return;
      started = true;
      mount(host, {});
    };
    new MutationObserver(maybeMount).observe(panel, { attributes: true, attributeFilter: ['class'] });
    maybeMount();
  }
})();
