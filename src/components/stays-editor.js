// src/components/stays-editor.js — Business Information ▸ Stays: the owner's holiday lets and B&B room
// types (docs/holiday-lets-plan.md). One editor that can open anywhere
// (docs/website-business-info-inline-plan.md §3): assets.html's Stays panel mounts it, and so does the
// Website Assistant's side drawer (site-facts-drawer.js). Talks to /.netlify/functions/stays (stays.ts),
// which checks everything again (stay-clean.ts) — the same checks the chat card uses.
//
// window.BizInfoEditors.stays.mount(rootEl, { compact, stayId, newType, onSaved })
//   stayId — opens that stay once loaded; newType 'whole' | 'room' — opens a blank one
//   onSaved() — after any save, archive, restore, delete or closed-dates change (also 'bizinfo:stays')
//
// One list, one editor. The editor is saved whole (details, photos, prices, extra charges, payment,
// rules, rooms); closed dates save on their own, once the stay exists. Money is typed in pounds /
// euros ("95.50") and the server stores minor units — nothing here does arithmetic on money.
(function () {
  const API = '/.netlify/functions/stays';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
  const CURRENCIES = [['GBP', 'Pounds (£)'], ['EUR', 'Euros (€)'], ['USD', 'US dollars ($)'], ['AUD', 'Australian dollars (A$)'], ['CAD', 'Canadian dollars (C$)']];
  const SYMBOL = { GBP: '£', EUR: '€', USD: '$', AUD: 'A$', CAD: 'C$' };
  const FEE_KINDS = [['cleaning', 'Cleaning'], ['pet', 'Pet (guest chooses)'], ['extra_guest', 'Extra guest'], ['breakfast', 'Breakfast (guest chooses)'], ['other', 'Something else']];
  const FEE_PER = [['stay', 'per stay'], ['night', 'per night'], ['guest_night', 'per guest per night']];
  const input = 'w-full px-3 py-2 rounded-lg border border-gray-300 text-sm';
  const small = 'w-20 px-3 py-2 rounded-lg border border-gray-300 text-sm';
  const label = 'block text-sm font-semibold text-gray-700 mb-1';

  async function call(method, body, query) {
    const res = await fetch(API + (query || ''), { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(d.error || 'Something went wrong. Please try again.'); e.data = d; throw e; }
    return d;
  }

  const major = (minor) => (minor == null || minor === '' ? '' : String(Number(minor) / 100).replace(/\.0+$/, ''));

  /** A stay from the server → the editor's form (money as typed, in major units). */
  function toForm(s) {
    return {
      id: s.id, stayType: s.stayType, name: s.name, summary: s.summary || '', description: s.description || '',
      maxGuests: s.maxGuests, bedrooms: s.bedrooms ?? '', bathrooms: s.bathrooms ?? '', beds: s.beds || '', address: s.address || '', licenceNumber: s.licenceNumber || '',
      checkInTime: s.checkInTime, checkOutTime: s.checkOutTime, breakfast: s.breakfast, mode: s.mode,
      amenities: (s.amenities || []).slice(), images: (s.images || []).map((im) => ({ assetId: im.assetId, alt: im.alt, url: im.url })),
      currency: s.currency, singleDiscount: major(s.singleDiscount),
      rates: (s.rates || []).map((r) => ({ name: r.name, startsOn: r.startsOn || '', endsOn: r.endsOn || '', nightly: major(r.nightly), weekendNightly: major(r.weekendNightly), weeklyNightly: major(r.weeklyNightly), minNights: r.minNights, changeoverDays: r.changeoverDays || [] })),
      fees: (s.fees || []).map((f) => ({ kind: f.kind, label: f.label, amount: major(f.amount), per: f.per, afterGuests: f.afterGuests ?? '' })),
      depositPercent: s.depositPercent, balanceDays: s.balanceDays, balanceCollection: s.balanceCollection,
      damageDeposit: major(s.damageDeposit), damageDepositReturnDays: s.damageDepositReturnDays,
      cancellation: (s.cancellation || []).map((c) => ({ days: c.days, refund: c.refund })),
      minNoticeDays: s.minNoticeDays, maxAdvanceDays: s.maxAdvanceDays, gapNights: s.gapNights,
      houseRules: s.houseRules || '', arrivalDetails: s.arrivalDetails || '', arrivalDetailsDays: s.arrivalDetailsDays,
      rooms: (s.units || []).map((u) => u.name), units: s.units || [], blocks: s.blocks || [], status: s.status,
    };
  }

  function blankForm(stayType) {
    return toForm({
      id: null, stayType, name: '', maxGuests: stayType === 'room' ? 2 : 4, checkInTime: '16:00', checkOutTime: '10:00', breakfast: stayType === 'room' ? 'included' : 'none', mode: 'request',
      amenities: [], images: [], currency: 'GBP', rates: [{ name: 'Standard', nightly: null, minNights: stayType === 'room' ? 1 : 2 }], fees: stayType === 'whole' ? [{ kind: 'cleaning', label: 'Cleaning', amount: null, per: 'stay' }] : [],
      depositPercent: stayType === 'whole' ? 25 : 0, balanceDays: 28, balanceCollection: 'link', damageDepositReturnDays: 7,
      cancellation: [{ days: 28, refund: 100 }, { days: 14, refund: 50 }], minNoticeDays: 1, maxAdvanceDays: 540, gapNights: 0, arrivalDetailsDays: 3,
      units: [{ name: 'Room 1' }], status: 'active',
    });
  }

  function mount(root, opts) {
    opts = opts || {};
    let state = { loaded: false, stays: [], amenities: [], takesCards: false, editing: null, error: '', saving: false, notice: '' };
    let opened = false;
    // Tell whoever mounted this, and anything else on the page that shows stays, that they changed.
    const changed = () => {
      try { if (typeof opts.onSaved === 'function') opts.onSaved(); } catch { /* the caller's problem, not the save's */ }
      document.dispatchEvent(new CustomEvent('bizinfo:stays', { detail: { from: root } }));
    };

    // ── Reading what's typed back into the form (before any re-render, so nothing typed is lost) ──
    function sync() {
      const f = state.editing;
      if (!f) return;
      root.querySelectorAll('[data-f]').forEach((el) => {
        const k = el.dataset.f;
        if (el.type === 'radio') { if (el.checked) f[k] = el.value; } else f[k] = el.value;
      });
      f.amenities = [...root.querySelectorAll('[data-am]:checked')].map((el) => el.value);
      root.querySelectorAll('[data-photo-alt]').forEach((el) => { const im = f.images[Number(el.dataset.photoAlt)]; if (im) im.alt = el.value; });
      const rows = (attr, list) => root.querySelectorAll(`[${attr}]`).forEach((el) => {
        const row = list[Number(el.getAttribute(attr))];
        if (!row) return;
        if (el.dataset.k === 'day') return;
        row[el.dataset.k] = el.value;
      });
      rows('data-rate', f.rates);
      f.rates.forEach((r, i) => { r.changeoverDays = [...root.querySelectorAll(`[data-rate="${i}"][data-k="day"]:checked`)].map((el) => el.value); });
      rows('data-fee', f.fees);
      rows('data-cx', f.cancellation);
      const rooms = root.querySelector('[data-f-rooms]');
      if (rooms) f.rooms = rooms.value.split('\n').map((s) => s.trim()).filter(Boolean);
    }

    // ── Drawing ───────────────────────────────────────────────────────────────────────────────
    function render() {
      if (!state.loaded) { root.innerHTML = '<p class="text-sm text-gray-400">Loading…</p>'; return; }
      root.innerHTML = state.editing ? editorHtml(state.editing) : listHtml();
    }

    function listHtml() {
      const notice = state.notice ? `<p class="text-sm text-emerald-700 font-semibold mb-3">${esc(state.notice)}</p>` : '';
      const err = state.error ? `<p class="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3 mb-3">${esc(state.error)}</p>` : '';
      const add = `<div class="flex flex-wrap gap-2"><button type="button" class="btn-primary text-sm font-bold px-3 py-1.5 rounded-md" data-act="new" data-type="whole">+ Add a holiday let</button><button type="button" class="btn-secondary border text-sm font-bold px-3 py-1.5 rounded-md" data-act="new" data-type="room">+ Add a room type</button></div>`;
      const cards = state.stays.map((s) => {
        const rooms = s.stayType === 'room' ? ` · ${s.units.length} room${s.units.length === 1 ? '' : 's'}` : '';
        const warn = !s.rates.some((r) => !r.startsOn) ? '<p class="text-xs text-amber-700 mt-1">No standard price yet — guests can only book dates a season covers.</p>' : '';
        const thumb = s.images[0]?.url ? `<img src="${esc(s.images[0].url)}" alt="" class="w-20 h-14 object-cover rounded-lg flex-shrink-0">` : '<div class="w-20 h-14 rounded-lg bg-gray-100 flex-shrink-0"></div>';
        return `<div class="flex items-start gap-4 border border-gray-200 rounded-xl p-4 ${s.status === 'archived' ? 'opacity-60' : ''}">${thumb}
          <div class="min-w-0 flex-1"><p class="font-bold text-gray-900">${esc(s.name)}${s.status === 'archived' ? ' <span class="text-xs font-semibold text-gray-500">(archived)</span>' : ''}</p>
          <p class="text-sm text-gray-500">${s.stayType === 'room' ? 'Room type' : 'Whole property'} · sleeps ${s.maxGuests}${s.stayType === 'room' ? ' per room' : ''}${rooms}${s.fromPrice ? ` · ${esc(s.fromPrice.replace('From ', 'from '))}` : ''}</p>${warn}</div>
          <div class="flex flex-wrap gap-2 justify-end"><button type="button" class="btn-secondary border text-xs font-bold px-3 py-1.5 rounded-md" data-act="edit" data-id="${s.id}">Edit</button>
          <button type="button" class="btn-utility text-xs font-bold px-3 py-1.5 rounded-md" data-act="${s.status === 'archived' ? 'restore' : 'archive'}" data-id="${s.id}">${s.status === 'archived' ? 'Restore' : 'Archive'}</button></div></div>`;
      }).join('');
      const empty = '<div class="border border-dashed border-gray-300 rounded-xl p-6 text-center text-sm text-gray-500">Nothing here yet. Add a holiday let (a cottage, flat or villa guests have to themselves) or a room type (for a B&amp;B or guest house — one type with as many rooms as you have).</div>';
      const cards2 = state.takesCards ? '' : '<p class="text-xs text-gray-500 mt-4">Guests can book now, and you arrange payment with them yourself. To take card payments on your website, connect Stripe on your Website Assistant\'s Shop settings.</p>';
      // In the drawer its title already says what this is: no second heading.
      return `${notice}${err}<div class="flex flex-wrap items-start justify-between gap-3 mb-4"><div>${opts.compact ? '' : '<h2 class="text-lg font-bold text-gray-900">Your holiday lets and rooms</h2>'}
        <p class="text-sm text-gray-500 mt-0.5 max-w-2xl">What guests book by the night on your website. Add a "Stays" section to your website to show them — each gets its own page with a calendar.</p></div>${add}</div>
        <div class="space-y-3">${state.stays.length ? cards : empty}</div>${cards2}`;
    }

    // Every input sits INSIDE its label, so it has a name for screen readers and a bigger tap target.
    const help = (h) => (h ? `<span class="block text-xs text-gray-500 mt-1 font-normal">${h}</span>` : '');
    const field = (k, text, val, attrs = '', h = '') => `<label class="block"><span class="${label}">${text}</span><input data-f="${k}" value="${esc(val)}" class="${input}" ${attrs}>${help(h)}</label>`;
    const area = (k, text, val, rows, attrs = '', h = '') => `<label class="block sm:col-span-2"><span class="${label}">${text}</span><textarea data-f="${k}" rows="${rows}" class="${input}" ${attrs}>${esc(val)}</textarea>${help(h)}</label>`;
    const select = (k, text, val, opts) => `<label class="block"><span class="${label}">${text}</span><select data-f="${k}" class="${input} bg-white">${opts.map(([v, l]) => `<option value="${esc(v)}"${String(val) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    const cell = (text, control, cls = '') => `<label class="block ${cls}"><span class="${label}">${text}</span>${control}</label>`;
    const radio = (k, val, opts) => opts.map(([v, l]) => `<label class="flex items-start gap-2 text-sm mb-1"><input type="radio" name="st-${k}" data-f="${k}" value="${esc(v)}"${val === v ? ' checked' : ''} class="mt-1"> <span>${l}</span></label>`).join('');
    const card = (title, sub, body) => `<div class="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-5"><h3 class="text-base font-bold text-gray-900">${title}</h3>${sub ? `<p class="text-sm text-gray-500 mt-0.5 max-w-2xl">${sub}</p>` : ''}<div class="mt-4">${body}</div></div>`;

    function editorHtml(f) {
      const room = f.stayType === 'room';
      const sym = SYMBOL[f.currency] || '£';
      const err = state.error ? `<p class="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3 mb-4" role="alert">${esc(state.error)}</p>` : '';

      const basics = card(room ? 'The room type' : 'The property', room ? 'One type of room, for example "Double with sea view". List each room of this type at the bottom.' : 'A place guests have to themselves.', `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div class="sm:col-span-2">${field('name', 'Name', f.name, `maxlength="120" required placeholder="${room ? 'Double with sea view' : 'Seaview Cottage'}"`)}</div>
          <div class="sm:col-span-2">${field('summary', 'One line about it', f.summary, `maxlength="300" placeholder="${room ? 'Our biggest room, with a bay window over the harbour.' : 'A stone cottage above the harbour, two minutes from the beach.'}"`)}</div>
          ${area('description', 'Description', f.description, 4, 'maxlength="5000"', 'In your own words. Shown on its page.')}
          ${field('maxGuests', room ? 'Guests per room' : 'Sleeps', f.maxGuests, 'type="number" min="1" max="50"')}
          ${field('beds', 'Beds', f.beds, 'maxlength="200" placeholder="1 king, 2 singles"')}
          ${room ? '' : field('bedrooms', 'Bedrooms', f.bedrooms, 'type="number" min="0" max="50"')}
          ${room ? '' : field('bathrooms', 'Bathrooms', f.bathrooms, 'type="number" min="0" max="50"')}
          ${field('checkInTime', 'Check-in from', f.checkInTime, 'type="time"')}
          ${field('checkOutTime', 'Check-out by', f.checkOutTime, 'type="time"')}
          ${room ? select('breakfast', 'Breakfast', f.breakfast, [['none', 'Not offered'], ['included', 'Included in the price'], ['optional', 'Guests can add it (set its price under Extra charges)']]) : ''}
          <div class="sm:col-span-2">${field('address', 'Address', f.address, 'maxlength="300"', 'Shown on its page with the town; leave the door number off if you prefer.')}</div>
          <div class="sm:col-span-2">${field('licenceNumber', 'Licence or registration number (if your area needs one)', f.licenceNumber, 'maxlength="80"', 'For example a Scottish short-term let licence or a Greek AMA number. Shown on its page.')}</div>
        </div>`);

      const photos = card('Photos', 'The first photo is the main one. Every photo needs a short description for people who can\'t see it.', `
        <div class="space-y-2">${f.images.map((im, i) => `<div class="flex items-center gap-3">${im.url ? `<img src="${esc(im.url)}" alt="" class="w-16 h-12 object-cover rounded-lg flex-shrink-0">` : '<div class="w-16 h-12 rounded-lg bg-gray-100 flex-shrink-0"></div>'}
          <input data-photo-alt="${i}" value="${esc(im.alt)}" maxlength="200" placeholder="What the photo shows" class="${input}" aria-label="Description of photo ${i + 1}">
          <button type="button" class="btn-utility text-xs font-bold px-2 py-1 rounded" data-act="photo-up" data-i="${i}" ${i ? '' : 'disabled'} aria-label="Move photo up">↑</button>
          <button type="button" class="btn-utility text-xs font-bold px-2 py-1 rounded" data-act="photo-remove" data-i="${i}" aria-label="Remove photo">✕</button></div>`).join('')}</div>
        <button type="button" class="btn-secondary border text-xs font-bold px-3 py-1.5 rounded-md mt-3" data-act="photo-add">+ Add photos</button>`);

      const amen = card('What\'s there', '', `<div class="grid grid-cols-2 sm:grid-cols-3 gap-1">${state.amenities.map((a) => `<label class="flex items-center gap-2 text-sm"><input type="checkbox" data-am value="${esc(a.key)}"${f.amenities.includes(a.key) ? ' checked' : ''}> ${esc(a.label)}</label>`).join('')}</div>`);

      const rateRow = (r, i) => `<div class="border border-gray-200 rounded-xl p-3">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          ${cell('Name', `<input data-rate="${i}" data-k="name" value="${esc(r.name)}" maxlength="60" class="${input}">`, 'col-span-2')}
          ${cell('First night', `<input type="date" data-rate="${i}" data-k="startsOn" value="${esc(r.startsOn)}" class="${input}">`)}
          ${cell('Last night', `<input type="date" data-rate="${i}" data-k="endsOn" value="${esc(r.endsOn)}" class="${input}">`)}
          ${cell(`A night (${sym})`, `<input inputmode="decimal" data-rate="${i}" data-k="nightly" value="${esc(r.nightly)}" class="${input}" placeholder="120">`)}
          ${cell(`Fri &amp; Sat (${sym})`, `<input inputmode="decimal" data-rate="${i}" data-k="weekendNightly" value="${esc(r.weekendNightly)}" class="${input}" placeholder="same">`)}
          ${cell(`7+ nights (${sym})`, `<input inputmode="decimal" data-rate="${i}" data-k="weeklyNightly" value="${esc(r.weeklyNightly)}" class="${input}" placeholder="same">`)}
          ${cell('Minimum nights', `<input type="number" min="1" max="60" data-rate="${i}" data-k="minNights" value="${esc(r.minNights)}" class="${input}">`)}
        </div>
        <div class="mt-2 text-sm"><span class="font-semibold text-gray-700">Stays start on</span> <span class="text-xs text-gray-500">(leave all unticked for any day)</span>
          <div class="flex flex-wrap gap-3 mt-1">${DAYS.map(([d, l]) => `<label class="flex items-center gap-1"><input type="checkbox" data-rate="${i}" data-k="day" value="${d}"${(r.changeoverDays || []).includes(d) ? ' checked' : ''}> ${l}</label>`).join('')}</div></div>
        ${f.rates.length > 1 ? `<button type="button" class="link text-xs font-bold mt-2" data-act="rate-remove" data-i="${i}">Remove this price</button>` : ''}</div>`;
      const prices = card('Prices', `Leave the dates empty on one price — that's your standard price. Add seasons with their first and last night; a season wins over the standard price for the nights it covers. Prices are per ${room ? 'room' : 'night for the whole place'}.`, `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">${select('currency', 'Currency', f.currency, CURRENCIES)}${room ? field('singleDiscount', `Off each night for one guest (${sym})`, f.singleDiscount, 'inputmode="decimal" placeholder="0"', 'Optional — a single-use discount.') : ''}</div>
        <div class="space-y-3">${f.rates.map(rateRow).join('')}</div>
        <button type="button" class="btn-secondary border text-xs font-bold px-3 py-1.5 rounded-md mt-3" data-act="rate-add">+ Add a season</button>`);

      const feeRow = (x, i) => `<div class="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end border border-gray-200 rounded-xl p-3">
        <label class="block"><span class="${label}">For</span><select data-fee="${i}" data-k="kind" class="${input} bg-white">${FEE_KINDS.map(([v, l]) => `<option value="${v}"${x.kind === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        ${cell('Name guests see', `<input data-fee="${i}" data-k="label" value="${esc(x.label)}" maxlength="60" class="${input}">`)}
        ${cell(`Amount (${sym})`, `<input inputmode="decimal" data-fee="${i}" data-k="amount" value="${esc(x.amount)}" class="${input}">`)}
        <label class="block"><span class="${label}">Charged</span><select data-fee="${i}" data-k="per" class="${input} bg-white">${FEE_PER.map(([v, l]) => `<option value="${v}"${x.per === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="flex items-end gap-2">${x.kind === 'extra_guest' ? `${cell('Included guests', `<input type="number" min="0" max="50" data-fee="${i}" data-k="afterGuests" value="${esc(x.afterGuests)}" class="${input}">`, 'flex-1')}` : '<div class="flex-1"></div>'}<button type="button" class="btn-utility text-xs font-bold px-2 py-2 rounded" data-act="fee-remove" data-i="${i}" aria-label="Remove this charge">✕</button></div></div>`;
      const fees = card('Extra charges', 'Cleaning, pets, extra guests, breakfast. Pets and breakfast are the guest\'s choice when they book; the others are always added.', `
        <div class="space-y-2">${f.fees.map(feeRow).join('') || '<p class="text-sm text-gray-500">None.</p>'}</div>
        <button type="button" class="btn-secondary border text-xs font-bold px-3 py-1.5 rounded-md mt-3" data-act="fee-add">+ Add a charge</button>`);

      const cxRow = (c, i) => `<div class="flex items-start justify-between gap-2 border border-gray-200 rounded-xl p-3 text-sm"><div class="flex flex-wrap items-center gap-x-2 gap-y-2 min-w-0">
        <span class="whitespace-nowrap"><input type="number" min="0" max="100" data-cx="${i}" data-k="refund" value="${esc(c.refund)}" class="${small}" aria-label="Percent refunded"> % back</span>
        <span>if they cancel <input type="number" min="0" max="365" data-cx="${i}" data-k="days" value="${esc(c.days)}" class="${small}" aria-label="Days before arrival"> or more days before</span></div>
        <button type="button" class="btn-utility text-xs font-bold px-2 py-1 rounded" data-act="cx-remove" data-i="${i}" aria-label="Remove this step">✕</button></div>`;
      const payment = card('Payment and cancellation', state.takesCards ? 'Guests pay by card on your website, into your own Stripe account. We take no fee.' : 'Card payments start once Stripe is connected (Website Assistant ▸ Shop). Until then guests book and you arrange payment yourself.', `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${field('depositPercent', 'Deposit when they book (%)', f.depositPercent, 'type="number" min="0" max="100"', '0 = they pay in full when they book.')}
          ${field('balanceDays', 'The rest is due (days before arrival)', f.balanceDays, 'type="number" min="0" max="365"', 'Booking closer than this? They pay in full.')}
          <div class="sm:col-span-2"><span class="${label}">How the rest is collected</span>${radio('balanceCollection', f.balanceCollection, [['link', 'Email the guest a link to pay <span class="text-gray-500">(they\'re reminded; you\'re told if it isn\'t paid)</span>'], ['auto', 'Charge their card automatically on the due date <span class="text-gray-500">(their card is saved when they pay the deposit, and they\'re told)</span>']])}</div>
          ${field('damageDeposit', `Refundable damage deposit (${sym})`, f.damageDeposit, 'inputmode="decimal" placeholder="none"', 'Charged with the balance. You return it after check-out, or keep part with a reason; if you do nothing it goes back automatically.')}
          ${field('damageDepositReturnDays', 'Returned automatically after (days)', f.damageDepositReturnDays, 'type="number" min="1" max="30"')}
        </div>
        <h4 class="text-sm font-bold text-gray-900 mt-5">Cancellation</h4><p class="text-xs text-gray-500 mb-2">What a guest gets back of what they've paid. Cancelling later than every step = nothing back. A damage deposit taken already always goes back.</p>
        <div class="space-y-2">${f.cancellation.map(cxRow).join('') || '<p class="text-sm text-gray-500">No refund if they cancel.</p>'}</div>
        <button type="button" class="btn-secondary border text-xs font-bold px-3 py-1.5 rounded-md mt-2" data-act="cx-add">+ Add a step</button>`);

      const rules = card('Booking rules and arrival', '', `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div class="sm:col-span-2"><span class="${label}">When someone books</span>${radio('mode', f.mode, [['request', 'I confirm each booking'], ['instant', 'Confirm it straight away']])}</div>
          ${field('minNoticeDays', 'Book at least (days before arrival)', f.minNoticeDays, 'type="number" min="0" max="60"')}
          ${field('maxAdvanceDays', 'Book up to (days ahead)', f.maxAdvanceDays, 'type="number" min="1" max="1095"')}
          ${field('gapNights', 'Nights kept free after each stay', f.gapNights, 'type="number" min="0" max="7"', 'For cleaning or a changeover. 0 = the next guest can arrive the day the last one leaves.')}
          <div></div>
          ${area('houseRules', 'House rules', f.houseRules, 3, 'maxlength="3000"', 'Guests tick that they agree before booking.')}
          ${area('arrivalDetails', 'Arrival details (private)', f.arrivalDetails, 3, 'maxlength="3000" placeholder="Key safe code, Wi-Fi name and password, parking, directions"', 'Never shown on your website. Emailed to the guest with the check-in times and address this many days before they arrive — once any balance is paid.')}
          ${field('arrivalDetailsDays', 'Email them (days before arrival)', f.arrivalDetailsDays, 'type="number" min="0" max="30"')}
        </div>`);

      const roomsCard = room ? card('The rooms of this type', 'One per line, for example "Room 3". A guest keeps one room for their whole stay; how many rooms you list is how many can be booked on the same night.', `
        <textarea data-f-rooms aria-label="Rooms of this type, one per line" rows="${Math.max(3, f.rooms.length + 1)}" class="${input}">${esc(f.rooms.join('\n'))}</textarea>`) : '';

      const blocks = f.id ? card('Closed dates', 'Nights nobody can book — your own use, repairs. Nights already booked can\'t be closed.', `
        <div class="space-y-2">${f.blocks.map((b) => `<div class="flex items-center justify-between gap-3 text-sm border border-gray-200 rounded-lg px-3 py-2"><span>${esc(b.startsOn)} → ${esc(b.endsOn)}${room ? ` · ${esc((f.units.find((u) => u.id === b.unitId) || {}).name || '')}` : ''}${b.note ? ` · ${esc(b.note)}` : ''}</span><button type="button" class="link text-xs font-bold" data-act="block-remove" data-id="${b.id}">Open again</button></div>`).join('') || '<p class="text-sm text-gray-500">None.</p>'}</div>
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end mt-3">
          ${room ? `<label class="block"><span class="${label}">Room</span><select data-block="unitId" class="${input} bg-white">${f.units.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>` : `<input type="hidden" data-block="unitId" value="${f.units[0] ? f.units[0].id : ''}">`}
          ${cell('First night closed', `<input type="date" data-block="startsOn" class="${input}">`)}
          ${cell('Open again on', `<input type="date" data-block="endsOn" class="${input}">`)}
          ${cell('Note', `<input data-block="note" maxlength="120" class="${input}" placeholder="Our own week">`)}
          <button type="button" class="btn-secondary border text-xs font-bold px-3 py-2 rounded-md" data-act="block-add">Close these dates</button>
        </div>`) : '';

      return `${err}<div class="flex items-center justify-between gap-3 mb-4"><h2 class="text-lg font-bold text-gray-900">${f.id ? esc(f.name || 'Edit') : room ? 'New room type' : 'New holiday let'}</h2><button type="button" class="link text-sm font-bold" data-act="cancel">← Back to the list</button></div>
        ${basics}${roomsCard}${photos}${amen}${prices}${fees}${payment}${rules}${blocks}
        <div class="sticky bottom-0 bg-white/95 border-t border-gray-200 py-3 flex flex-wrap items-center justify-end gap-3">
          ${f.id ? '<button type="button" class="btn-utility text-sm font-bold px-3 py-2 rounded-md mr-auto" data-act="delete">Delete</button>' : ''}
          <button type="button" class="btn-secondary border text-sm font-bold px-4 py-2 rounded-md" data-act="cancel">Cancel</button>
          <button type="button" class="btn-primary text-sm font-bold px-4 py-2 rounded-md" data-act="save" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save'}</button></div>`;
    }

    // ── Actions ───────────────────────────────────────────────────────────────────────────────
    async function load() {
      try {
        const d = await call('GET');
        state = { ...state, loaded: true, stays: d.stays || [], amenities: d.amenities || [], takesCards: !!d.takesCards, error: '' };
      } catch (err) {
        state = { ...state, loaded: true, error: err.message };
      }
      // Opened for one stay, or to add one (the Website Assistant's drawer): straight into the editor.
      if (!opened && !state.editing) {
        const s = opts.stayId ? state.stays.find((x) => x.id === Number(opts.stayId)) : null;
        if (s) state.editing = toForm(s);
        else if (opts.newType === 'whole' || opts.newType === 'room') state.editing = blankForm(opts.newType);
        opened = true;
      }
      render();
    }

    function payload(f) {
      return {
        ...(f.id ? { id: f.id } : {}),
        stayType: f.stayType, name: f.name, summary: f.summary, description: f.description, maxGuests: f.maxGuests, bedrooms: f.bedrooms, bathrooms: f.bathrooms,
        beds: f.beds, address: f.address, licenceNumber: f.licenceNumber, checkInTime: f.checkInTime, checkOutTime: f.checkOutTime, breakfast: f.breakfast, mode: f.mode,
        amenities: f.amenities, images: f.images.map((im) => ({ assetId: im.assetId, alt: im.alt })), currency: f.currency, singleDiscount: f.singleDiscount,
        rates: f.rates.map((r) => ({ ...r, startsOn: r.startsOn || null, endsOn: r.endsOn || null })),
        fees: f.fees, depositPercent: f.depositPercent, balanceDays: f.balanceDays, balanceCollection: f.balanceCollection,
        damageDeposit: f.damageDeposit, damageDepositReturnDays: f.damageDepositReturnDays,
        cancellation: f.cancellation.filter((c) => String(c.days) !== '' && String(c.refund) !== '').map((c) => ({ days: Number(c.days), refund: Number(c.refund) })),
        minNoticeDays: f.minNoticeDays, maxAdvanceDays: f.maxAdvanceDays, gapNights: f.gapNights,
        houseRules: f.houseRules, arrivalDetails: f.arrivalDetails, arrivalDetailsDays: f.arrivalDetailsDays,
        ...(f.stayType === 'room' ? { rooms: f.rooms } : {}),
      };
    }

    function replaceStay(s) {
      if (!s) return;
      const i = state.stays.findIndex((x) => x.id === s.id);
      if (i >= 0) state.stays[i] = s; else state.stays.push(s);
    }

    async function save() {
      sync();
      const f = state.editing;
      state.saving = true; state.error = ''; render();
      try {
        const d = await call(f.id ? 'PUT' : 'POST', payload(f));
        replaceStay(d.stay);
        state.editing = null;
        state.notice = `Saved ${d.stay ? d.stay.name : ''}.`;
        window.showToast?.('Saved', { icon: '✅' });
        changed();
      } catch (err) {
        // Saved, but a room with guests couldn't be removed: keep the editor on the saved version.
        if (err.data && err.data.stay) { replaceStay(err.data.stay); state.editing = toForm(err.data.stay); changed(); }
        state.error = err.message;
      }
      state.saving = false;
      render();
      if (!state.editing) root.scrollIntoView({ block: 'start', behavior: 'smooth' });
      else if (state.error) root.querySelector('[role="alert"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    root.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const act = t.dataset.act;
      const i = Number(t.dataset.i);
      state.notice = '';
      if (act === 'new') { state.error = ''; state.editing = blankForm(t.dataset.type); render(); return; }
      if (act === 'edit') { const s = state.stays.find((x) => x.id === Number(t.dataset.id)); if (s) { state.error = ''; state.editing = toForm(s); render(); root.scrollIntoView({ block: 'start' }); } return; }
      if (act === 'cancel') { state.editing = null; state.error = ''; render(); return; }
      if (act === 'archive' || act === 'restore') {
        try { const d = await call('PATCH', { id: Number(t.dataset.id), status: act === 'archive' ? 'archived' : 'active' }); replaceStay(d.stay); state.error = ''; changed(); }
        catch (err) { state.error = err.message; }
        render(); return;
      }
      if (act === 'save') return save();
      // Everything below changes the open form: keep what's typed first.
      sync();
      const f = state.editing;
      if (!f) return;
      if (act === 'delete') {
        if (!(await window.confirmModal('It disappears from your website. Past bookings keep their details. This can\'t be undone — Archive keeps it instead.', { title: 'Delete for good?', confirmLabel: 'Delete', cancelLabel: 'Keep' }))) return;
        try { await call('DELETE', null, `?id=${f.id}`); state.stays = state.stays.filter((x) => x.id !== f.id); state.editing = null; state.error = ''; changed(); }
        catch (err) { state.error = err.message; }
        render(); return;
      }
      if (act === 'photo-add') {
        if (!window.MediaPicker) return;
        window.MediaPicker.open({ title: 'Choose photos', multiple: true, onPickMany: (assets) => {
          sync();
          for (const a of assets || []) if (a && a.id && !a.video && !state.editing.images.some((im) => im.assetId === a.id)) state.editing.images.push({ assetId: a.id, alt: '', url: a.url });
          render();
        } });
        return;
      }
      if (act === 'photo-remove') f.images.splice(i, 1);
      if (act === 'photo-up' && i > 0) [f.images[i - 1], f.images[i]] = [f.images[i], f.images[i - 1]];
      if (act === 'rate-add') f.rates.push({ name: 'Summer', startsOn: '', endsOn: '', nightly: '', weekendNightly: '', weeklyNightly: '', minNights: 1, changeoverDays: [] });
      if (act === 'rate-remove') f.rates.splice(i, 1);
      if (act === 'fee-add') f.fees.push({ kind: 'cleaning', label: '', amount: '', per: 'stay', afterGuests: '' });
      if (act === 'fee-remove') f.fees.splice(i, 1);
      if (act === 'cx-add') f.cancellation.push({ days: 7, refund: 0 });
      if (act === 'cx-remove') f.cancellation.splice(i, 1);
      if (act === 'block-add') {
        const v = (k) => (root.querySelector(`[data-block="${k}"]`) || {}).value || '';
        try {
          const d = await call('POST', { block: { unitId: Number(v('unitId')), startsOn: v('startsOn'), endsOn: v('endsOn'), note: v('note') } });
          f.blocks.push(d.block); f.blocks.sort((a, b) => a.startsOn.localeCompare(b.startsOn));
          const s = state.stays.find((x) => x.id === f.id); if (s) s.blocks = f.blocks.slice();
          state.error = ''; changed();
        } catch (err) { state.error = err.message; }
      }
      if (act === 'block-remove') {
        try {
          await call('DELETE', null, `?block=${Number(t.dataset.id)}`);
          f.blocks = f.blocks.filter((b) => b.id !== Number(t.dataset.id));
          const s = state.stays.find((x) => x.id === f.id); if (s) s.blocks = f.blocks.slice();
          state.error = ''; changed();
        } catch (err) { state.error = err.message; }
      }
      render();
    });
    // A charge's kind changes which fields it has (extra guests: "after guests").
    root.addEventListener('change', (e) => {
      if (!e.target.matches('[data-fee][data-k="kind"], [data-f="currency"]')) return;
      sync();
      // A new kind of charge starts with how that kind is usually charged.
      if (e.target.matches('[data-fee]')) {
        const fee = state.editing.fees[Number(e.target.dataset.fee)];
        if (fee) fee.per = { breakfast: 'guest_night', extra_guest: 'night' }[fee.kind] || 'stay';
      }
      render();
    });

    // Saved somewhere else (the other editor, a chat card): show the new list, unless one is open.
    document.addEventListener('bizinfo:stays', (e) => { if (root.isConnected && e.detail?.from !== root && !state.editing) load(); });

    render();
    load();
    return { reload: load };
  }

  window.BizInfoEditors = window.BizInfoEditors || {};
  window.BizInfoEditors.stays = { mount };

  // Business Information's own Stays tab: mounted the first time the tab is opened. (This file is
  // re-run each time that view loads; the drawer loads it once and calls mount itself.)
  const panel = document.querySelector('.bizinfo-tab-panel[data-panel="stays"]');
  const host = document.getElementById('stays-root');
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
