/**
 * src/components/assistant-shop.js — the Shopkeeper Assistant's "Shop" tab (docs/online-shop-review-plan.md §10).
 *
 *   window.AssistantShop.init({ hub, assistantId, assistantName })   (assistants.js, hubTab kind 'shop')
 *   window.AssistantShop.refresh()                                     (each time the tab opens)
 *
 * Reads netlify/functions/shop.ts — workspace-level, so it works with or without a Be More Swan website:
 * 1. Take payments: connect the business's own Stripe account (0% fee to us).
 * 2. Delivery & returns: what UK law asks a buyer to see (shop-settings.ts). Same server action as the
 *    chat's shop_settings card. Buy buttons stay hidden until the required fields are filled in.
 * 3. Stock (Phase 1): how many of each product are left. Empty = not tracked; 0 = Sold out on the site.
 *    Same server action as the chat's product_stock card (shop.ts product_stock, shop-stock.ts).
 *    Options (Phase 1): under each product, one group of choices ("Size": Small / Large), each with its own
 *    price and stock. Same server action as the chat's product_options card (shop.ts product_options).
 * 4. Orders: every paid order in the workspace, Mark as dealt with, refunds shown (made in Stripe).
 * Renders into the Data Hub's own hosts (#datahub-toolbar, #datahub-table-host), which this tab owns.
 */
(function () {
  'use strict';
  const API = '/.netlify/functions/shop';
  const state = { assistantId: null, assistantName: '', data: null, shopOpen: false, shopSaved: null, shopError: null, paymentsError: null, paymentsNotice: null, stockSaved: null, stockError: null, optOpen: null, shown: 20, refreshed: false, bound: false };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const host = () => document.getElementById('datahub-table-host');
  const bar = () => document.getElementById('datahub-toolbar');
  const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm';
  const card = (inner, extra = '') => `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-4 ${extra}">${inner}</div>`;
  const btn = (attrs, label, primary) => `<button type="button" ${attrs} class="${primary ? 'btn-primary' : 'btn-secondary border'} px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50" style="min-height:44px">${label}</button>`;
  const money = (pence, cur) => (String(cur || 'gbp').toLowerCase() === 'gbp' ? `£${(pence / 100).toFixed(2).replace(/\.00$/, '')}` : `${(pence / 100).toFixed(2)} ${String(cur).toUpperCase()}`);

  async function post(body) {
    const r = await fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assistantId: state.assistantId, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
    return j;
  }

  /** Where the shop stands, one line each — the same order the owner works through. */
  function steps(d) {
    const p = d.payments || {};
    return [
      { key: 'stripe', label: 'Take payments with Stripe', done: !!p.chargesEnabled },
      { key: 'terms', label: 'Delivery & returns details', done: !(d.shopMissing || []).length },
    ];
  }

  function checklist(d) {
    const s = steps(d);
    const ready = s.every((x) => x.done);
    return card(`<p class="text-sm font-black text-gray-900">${ready ? '✓ Your shop can take orders' : 'Get your shop ready to sell'}</p>
      <p class="text-xs text-gray-500 mt-1">${ready
        ? 'Buy buttons show on your products. Buyers pay you directly through Stripe; Be More Swan takes no fee.'
        : 'Two steps. Buy buttons show on your products once both are done.'}</p>
      <ol class="mt-3 space-y-1">${s.map((x, i) => `<li class="text-xs ${x.done ? 'text-green-700' : 'text-gray-800'} font-semibold">${x.done ? '✓' : `${i + 1}.`} ${esc(x.label)}${x.done ? '' : ' — not done yet'}</li>`).join('')}</ol>`, ready ? 'border-green-200' : 'border-amber-200');
  }

  function paymentsCard(d) {
    const p = d.payments || {};
    const notice = state.paymentsNotice ? `<p class="text-xs font-semibold ${state.paymentsNotice.tone === 'ok' ? 'text-green-700' : 'text-amber-800'} mt-2" role="status">${esc(state.paymentsNotice.text)}</p>` : '';
    if (p.chargesEnabled) {
      return card(`<p class="text-sm font-black text-gray-900">Payments: connected</p>
        <p class="text-xs text-gray-500 mt-1">Your Stripe account is connected. Buyers pay you directly — Be More Swan takes no fee; Stripe charges its usual card fees. Refunds, payouts and receipts are in your <a class="underline" href="https://dashboard.stripe.com" target="_blank" rel="noopener">Stripe dashboard</a>.</p>${notice}`);
    }
    const action = p.canConnect
      ? btn('data-shop-connect', p.connected ? 'Finish setting up Stripe' : 'Connect Stripe', true)
      : '<p class="text-xs font-semibold text-gray-700 mt-2">Ask your workspace owner or an admin to connect Stripe.</p>';
    return card(`<p class="text-sm font-black text-gray-900">1. Take payments</p>
      <p class="text-xs text-gray-500 mt-1">${p.connected
        ? 'Stripe still needs a few details before you can take payments. Pick up where you left off — it takes a few minutes.'
        : 'Connect a Stripe account. You are the seller: the money goes straight to your Stripe account and Be More Swan takes no fee. Stripe charges its usual card fees. Prices are in pounds.'}</p>
      ${p.canConnect ? '<p class="text-xs text-gray-700 mt-2"><strong>Have this ready:</strong> Stripe asks for your website. Use your Be More Swan website\'s address, or another website you already have.</p>' : ''}
      <div class="mt-3">${action}</div>
      ${state.paymentsError ? `<p class="text-xs font-semibold text-red-600 mt-2" role="alert">${esc(state.paymentsError)}</p>` : ''}${notice}`);
  }

  function shopSettingsCard(d) {
    const s = d.shop || {};
    const missing = d.shopMissing || [];
    const ex = d.exceptions || {};
    const canEdit = !!d.canEdit;
    const ro = canEdit ? '' : 'disabled';
    const field = (key, label, value, opts = {}) => {
      const common = `data-shop-field="${key}" ${ro} class="${inputCls} mt-1" ${opts.max ? `maxlength="${opts.max}"` : ''} ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''}`;
      return `<label class="block text-xs font-bold text-gray-700 mt-3">${esc(label)}${opts.required ? ' <span class="text-red-600" aria-hidden="true">*</span>' : ''}${opts.hint ? `<span class="block font-normal text-gray-500">${esc(opts.hint)}</span>` : ''}
        ${opts.area ? `<textarea ${common} rows="${opts.rows || 3}">${esc(value || '')}</textarea>` : `<input ${common} type="${opts.type || 'text'}" value="${esc(value == null ? '' : value)}">`}</label>`;
    };
    const ready = !missing.length;
    const body = `
      ${field('traderName', 'Business or trading name', s.traderName, { required: true, max: 120 })}
      ${field('traderAddress', 'Business address', s.traderAddress, { required: true, area: true, max: 400, hint: 'A real address buyers can write to — the law asks for it. A PO box is not enough.' })}
      ${field('contactEmail', 'Email for customers', s.contactEmail, { required: true, type: 'email', max: 200 })}
      ${field('contactPhone', 'Phone (optional)', s.contactPhone, { max: 40 })}
      ${field('deliveryText', 'How and when you deliver', s.deliveryText, { required: true, area: true, max: 600, placeholder: 'e.g. Royal Mail Tracked 48, usually 2–3 working days after you order. Free collection from our shop by arrangement.' })}
      ${field('vatNumber', 'VAT number (only if you are VAT registered)', s.vatNumber, { max: 20 })}
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
        ${field('returnsDays', 'Days buyers have to cancel', s.returnsDays || 14, { type: 'number', hint: 'At least 14 — the law\'s minimum.' })}
        <label class="block text-xs font-bold text-gray-700 mt-3">Who pays return postage<span class="block font-normal text-gray-500">When a buyer changes their mind.</span>
          <select data-shop-field="returnPostage" ${ro} class="${inputCls} mt-1"><option value="buyer" ${s.returnPostage !== 'seller' ? 'selected' : ''}>The buyer</option><option value="seller" ${s.returnPostage === 'seller' ? 'selected' : ''}>We do</option></select></label>
      </div>
      <fieldset class="mt-3"><legend class="text-xs font-bold text-gray-700">Things that can't be returned for a change of mind <span class="font-normal text-gray-500">(tick any you sell)</span></legend>
        ${Object.keys(ex).map((k) => `<label class="flex items-start gap-2 text-xs text-gray-700 mt-1"><input type="checkbox" data-shop-ex="${esc(k)}" ${ro} ${(s.exceptions || []).includes(k) ? 'checked' : ''} class="mt-0.5"> ${esc(ex[k])}</label>`).join('')}
        <p class="text-xs text-gray-500 mt-1">Faulty items can always be returned.</p></fieldset>
      ${field('extraTerms', 'Anything else buyers should know (optional)', s.extraTerms, { area: true, max: 2000 })}
      ${canEdit ? `<div class="mt-4 flex flex-wrap items-center gap-2">${btn('data-shop-save', 'Save details', true)}${state.shopSaved ? `<span class="text-xs font-semibold text-green-700" role="status">${esc(state.shopSaved)}</span>` : ''}</div>` : '<p class="text-xs font-semibold text-gray-700 mt-3">Only the workspace owner or an admin can change these.</p>'}
      ${state.shopError ? `<p class="text-xs font-semibold text-red-600 mt-2" role="alert">${esc(state.shopError)}</p>` : ''}`;
    const head = `<p class="text-sm font-black text-gray-900">2. Delivery &amp; returns</p>
      <p class="text-xs text-gray-500 mt-1">${ready
        ? 'Buyers see these on your <strong>Delivery &amp; returns</strong> page, beside the Pay button, and in the email we send them after they buy.'
        : `<span class="text-amber-800 font-semibold">Buy buttons stay hidden until these are filled in:</span> ${esc(missing.join(', '))}. The law says buyers must see who they're buying from and their right to cancel before they pay.`}</p>`;
    return card(ready
      ? `<details ${state.shopOpen ? 'open' : ''} data-shop-details><summary class="cursor-pointer">${head}<span class="text-xs font-bold text-gray-700 underline">Change details</span></summary>${body}</details>`
      : `${head}${body}`, ready ? '' : 'border-amber-200');
  }

  const STOCK_PILL = {
    untracked: ['Not tracked', 'bg-gray-100 text-gray-700'],
    in_stock: ['In stock', 'bg-emerald-100 text-emerald-800'],
    low: ['Low', 'bg-amber-100 text-amber-800'],
    sold_out: ['Sold out', 'bg-red-100 text-red-700'],
  };

  const majorOf = (minor) => (minor == null ? '' : (minor / 100).toFixed(2).replace(/\.00$/, ''));
  function optionRow(o) {
    const v = (x) => (x == null ? '' : esc(x));
    return `<div class="flex flex-wrap items-end gap-2 mt-2" data-opt-row data-opt-id="${o && o.id ? esc(o.id) : ''}">
      <label class="block text-[11px] font-bold text-gray-600">Option<input type="text" maxlength="60" data-opt-label value="${v(o && o.label)}" placeholder="e.g. Large" class="${inputCls} mt-1" style="max-width:10rem"></label>
      <label class="block text-[11px] font-bold text-gray-600">Price<input type="text" inputmode="decimal" data-opt-price value="${v(o ? majorOf(o.priceAmount) : '')}" placeholder="Same" class="${inputCls} mt-1" style="max-width:6rem"></label>
      <label class="block text-[11px] font-bold text-gray-600">In stock<input type="number" min="0" max="100000" step="1" data-opt-stock value="${v(o && o.stock)}" placeholder="Not tracked" class="${inputCls} mt-1" style="max-width:7rem"></label>
      ${btn('data-opt-remove aria-label="Remove this option"', 'Remove')}
    </div>`;
  }
  /** The Options editor under a product: one group name and its rows; saving replaces the list. */
  function optionsEditor(it, po) {
    const list = po ? po.options : [];
    const summary = po ? `${esc(po.group)}: ${list.map((o) => esc(o.label) + (o.stock === 0 ? ' (sold out)' : '')).join(', ')}` : 'No options. Add sizes, colours or other choices, each with its own price and stock.';
    return `<details class="mt-2" data-opt-editor="${esc(it.id)}" ${state.optOpen === it.id ? 'open' : ''}>
      <summary class="cursor-pointer text-xs font-bold text-gray-700 underline">Options</summary>
      <p class="text-xs text-gray-500 mt-1">${summary}</p>
      <label class="block text-[11px] font-bold text-gray-600 mt-2">The choice<input type="text" maxlength="40" data-opt-group value="${esc(po ? po.group : 'Size')}" class="${inputCls} mt-1" style="max-width:10rem"></label>
      <div data-opt-rows>${list.map(optionRow).join('')}</div>
      <p class="text-xs text-gray-500 mt-2">Leave a price empty to use the product's price (${esc(it.price)}). With options, buyers choose one on the product's page and stock is kept per option.</p>
      <div class="flex flex-wrap gap-2 mt-2">${btn('data-opt-add', '+ Add option')}${btn(`data-opt-save="${esc(it.id)}"`, 'Save options', true)}</div>
    </details>`;
  }

  /** Stock: one row per product that can be bought online (a fixed price in Business Information). */
  function stockCard(d) {
    const st = d.stock || { ready: false, items: [] };
    const head = '<p class="text-sm font-black text-gray-900">Stock</p>';
    if (!st.ready) return card(`${head}<p class="text-xs text-gray-500 mt-1">Stock levels are being switched on. Until then every product can be bought, as now.</p>`);
    if (!st.items.length) return card(`${head}<p class="text-xs text-gray-500 mt-1">No products can be bought online yet. Give a product a fixed price in <strong>Business Information ▸ Products &amp; Services</strong> and it appears here.</p>`);
    const num = (attr, value, label) => `<label class="block text-[11px] font-bold text-gray-600">${esc(label)}<input type="number" min="0" max="100000" step="1" inputmode="numeric" ${attr} value="${value == null ? '' : esc(value)}" class="${inputCls} mt-1" style="max-width:7rem"></label>`;
    return card(`${head}
      <p class="text-xs text-gray-500 mt-1">How many of each you have. Leave it empty to not track it (always buyable). At 0 your website shows <strong>Sold out</strong>, and buyers can never pick more than you have. Stock goes down by itself when an order is paid.</p>
      <ul class="space-y-2 mt-3">${st.items.map((it) => {
        const [label, cls] = STOCK_PILL[it.state] || STOCK_PILL.untracked;
        const po = (d.options || {})[it.id];
        return `<li class="border border-gray-200 rounded-lg p-3" data-stock-row="${esc(it.id)}">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs font-bold text-gray-900">${esc(it.name)} <span class="font-normal text-gray-500">· ${esc(it.price)}</span></p>
            ${po ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-800">Stock per option</span>' : `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full ${cls}" data-stock-state="${esc(it.state)}">${esc(it.state === 'low' ? `Low: ${it.stock} left` : label)}</span>`}
          </div>
          ${po ? '' : `<div class="flex flex-wrap items-end gap-3 mt-2">
            ${num('data-stock-count', it.stock, 'In stock')}
            ${num('data-stock-low', it.lowStockAt, 'Warn me at')}
            ${btn(`data-stock-save="${esc(it.id)}"`, 'Save')}
          </div>`}
          ${optionsEditor(it, po)}
        </li>`;
      }).join('')}</ul>
      ${state.stockSaved ? `<p class="text-xs font-semibold text-green-700 mt-2" role="status">${esc(state.stockSaved)}</p>` : ''}
      ${state.stockError ? `<p class="text-xs font-semibold text-red-600 mt-2" role="alert">${esc(state.stockError)}</p>` : ''}`);
  }

  function ordersCard(d) {
    const list = d.orders || [];
    if (!list.length) return card(`<p class="text-sm font-black text-gray-900">Orders</p><p class="text-xs text-gray-500 mt-1">No orders yet. When someone buys, the order appears here and in your email, and ${esc(state.assistantName || 'your Shopkeeper')} can tell you about it in the chat.</p>`);
    const shown = list.slice(0, state.shown);
    return card(`<p class="text-sm font-black text-gray-900">Orders${d.stats && d.stats.newOrders ? ` <span class="text-xs font-bold text-emerald-800">· ${esc(d.stats.newOrders)} new</span>` : ''}</p>
      <ul class="space-y-2 mt-3">${shown.map((o) => {
        const a = o.shippingAddress && o.shippingAddress.address;
        const addr = a ? [o.shippingAddress.name, a.line1, a.line2, a.city, a.postal_code].filter(Boolean).join(', ') : '';
        const refundNote = o.status === 'refunded' ? '<span class="text-xs font-bold text-gray-600">· Refunded</span>'
          : o.refundedAmount > 0 ? `<span class="text-xs font-bold text-gray-600">· ${esc(money(o.refundedAmount, o.currency))} refunded</span>` : '';
        return `<li class="border ${o.status === 'paid' ? 'border-emerald-200' : 'border-gray-200'} rounded-lg p-3 ${o.status === 'done' ? 'opacity-80' : ''}">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs font-bold text-gray-900">${esc(o.quantity)} × ${esc(o.itemName)} · ${esc(money(o.amountTotal, o.currency))} ${o.status === 'paid' ? '<span class="text-xs font-bold text-emerald-800">· New</span>' : ''} ${refundNote}</p>
            <p class="text-xs text-gray-500">${esc(new Date(o.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</p>
          </div>
          <p class="text-xs text-gray-600 mt-1">${esc(o.customerName || '')}${o.customerEmail ? ` · <a class="underline" href="mailto:${esc(o.customerEmail)}">${esc(o.customerEmail)}</a>` : ''}</p>
          ${((d.orderLines || {})[o.id] || []).length ? `<ul class="text-xs text-gray-700 mt-1 list-disc pl-5" data-order-lines>${d.orderLines[o.id].map((l) => `<li>${esc(l.qty)} × ${esc(l.name)} · ${esc(money(l.unit * l.qty, o.currency))}</li>`).join('')}</ul>` : ''}
          ${addr ? `<p class="text-xs text-gray-600 mt-1">Deliver to: ${esc(addr)}</p>` : ''}
          ${o.status === 'refunded' ? '' : `<div class="mt-2">${btn(`data-shop-order="${esc(o.id)}" data-done="${o.status === 'paid' ? '1' : '0'}"`, o.status === 'paid' ? 'Mark as dealt with' : 'Mark as new')}</div>`}
        </li>`;
      }).join('')}</ul>
      ${list.length > shown.length ? `<div class="mt-3">${btn('data-shop-more', `Show more (${list.length - shown.length})`)}</div>` : ''}
      <p class="text-xs text-gray-500 mt-3">Refunds are made in your <a class="underline" href="https://dashboard.stripe.com" target="_blank" rel="noopener">Stripe dashboard</a> and show here once Stripe tells us.</p>`);
  }

  function render() {
    const h = host();
    if (!h || !state.data) return;
    if (bar()) bar().innerHTML = '';
    h.innerHTML = `<div class="max-w-3xl">${checklist(state.data)}${paymentsCard(state.data)}${shopSettingsCard(state.data)}${stockCard(state.data)}${ordersCard(state.data)}</div>`;
  }

  async function load() {
    state.data = await post({ action: 'get' });
    // Back from Stripe's onboarding (or part-way through it): ask Stripe once for the latest.
    const backFromStripe = window._sitePaymentsReturn === true;
    window._sitePaymentsReturn = false;
    const p = state.data.payments || {};
    if (p.connected && (backFromStripe || !p.chargesEnabled) && !state.refreshed) {
      state.refreshed = true;
      try { state.data = await post({ action: 'payments_refresh' }); } catch { /* shown as not finished */ }
    }
    if (backFromStripe) {
      const ok = state.data.payments && state.data.payments.chargesEnabled;
      state.paymentsNotice = ok
        ? { tone: 'ok', text: 'Stripe is connected. You can take payments.' }
        : { tone: 'warn', text: 'Stripe still needs a few details before you can take payments. Click "Finish setting up Stripe" to carry on.' };
    }
  }

  async function refresh() {
    if (!state.assistantId || !host()) return;
    // Single-page app: after leaving the Shopkeeper for another assistant, never paint over its tab.
    const current = window._detailCurrentData;
    if (current && Number(current.id) !== Number(state.assistantId)) { state.assistantId = null; return; }
    try { await load(); render(); }
    catch (err) { host().innerHTML = `<div class="bg-red-50 border border-red-200 rounded-2xl p-6 text-sm font-semibold text-red-700">${esc(err.message)}</div>`; }
  }

  async function onClick(e) {
    if (!state.assistantId) return;
    const t = (sel) => e.target.closest && e.target.closest(sel);
    if (!t('#datahub-table-host')) return;
    if (t('[data-shop-details] > summary')) { state.shopOpen = !t('[data-shop-details]').open; return; }
    if (t('[data-shop-more]')) { state.shown += 20; render(); return; }
    const save = t('[data-shop-save]');
    if (save) {
      const root = save.closest('.rounded-2xl') || document;
      const settings = {};
      root.querySelectorAll('[data-shop-field]').forEach((el) => { settings[el.dataset.shopField] = el.dataset.shopField === 'returnsDays' ? Number(el.value) : el.value; });
      settings.exceptions = [...root.querySelectorAll('[data-shop-ex]')].filter((el) => el.checked).map((el) => el.dataset.shopEx);
      state.shopError = null; state.shopSaved = null; save.disabled = true;
      try {
        state.data = await post({ action: 'shop_settings', settings });
        const gaps = state.data.shopMissing || [];
        state.shopSaved = gaps.length ? `Saved. Still needed: ${gaps.join(', ')}.` : 'Saved — your Delivery & returns page is ready.';
        state.shopOpen = false;
      } catch (err) { state.shopError = err.message; state.shopOpen = true; }
      render();
      return;
    }
    if (t('[data-opt-editor] > summary')) { const ed = t('[data-opt-editor]'); state.optOpen = ed.open ? null : Number(ed.dataset.optEditor); return; }
    if (t('[data-opt-add]')) { const ed = t('[data-opt-editor]'); ed.querySelector('[data-opt-rows]').insertAdjacentHTML('beforeend', optionRow(null)); return; }
    if (t('[data-opt-remove]')) { t('[data-opt-row]').remove(); return; }
    const optSave = t('[data-opt-save]');
    if (optSave) {
      const ed = optSave.closest('[data-opt-editor]');
      const options = [...ed.querySelectorAll('[data-opt-row]')].map((row) => ({
        ...(row.dataset.optId ? { id: Number(row.dataset.optId) } : {}),
        label: row.querySelector('[data-opt-label]').value,
        price: row.querySelector('[data-opt-price]').value,
        stock: row.querySelector('[data-opt-stock]').value,
      })).filter((o) => o.id || o.label.trim() || o.price.trim() || o.stock.trim());
      state.stockSaved = null; state.stockError = null; optSave.disabled = true;
      state.optOpen = Number(optSave.dataset.optSave);
      try {
        state.data = await post({ action: 'product_options', productId: Number(optSave.dataset.optSave), group: ed.querySelector('[data-opt-group]').value, options });
        state.stockSaved = (state.data.warnings || [])[0] || 'Saved.';
      } catch (err) { state.stockError = err.message; }
      render();
      return;
    }
    const stockSave = t('[data-stock-save]');
    if (stockSave) {
      const row = stockSave.closest('[data-stock-row]');
      state.stockSaved = null; state.stockError = null; stockSave.disabled = true;
      try {
        state.data = await post({
          action: 'product_stock', productId: Number(stockSave.dataset.stockSave),
          stock: row.querySelector('[data-stock-count]').value, lowStockAt: row.querySelector('[data-stock-low]').value,
        });
        state.stockSaved = (state.data.warnings || [])[0] || 'Saved.';
      } catch (err) { state.stockError = err.message; }
      render();
      return;
    }
    const connect = t('[data-shop-connect]');
    if (connect) {
      state.paymentsError = null; connect.disabled = true;
      try {
        const r = await post({ action: 'payments_connect' });
        if (!r.url) throw new Error('Stripe didn\'t send a link to continue. Try again in a minute.');
        window.location.href = r.url;
      } catch (err) { state.paymentsError = err.message; render(); }
      return;
    }
    const order = t('[data-shop-order]');
    if (order) {
      order.disabled = true;
      try { state.data = await post({ action: 'order_done', id: Number(order.dataset.shopOrder), done: order.dataset.done === '1' }); render(); }
      catch (err) { order.disabled = false; if (window.alertModal) window.alertModal(err.message); }
    }
  }

  // The chat's shop_settings card saved: show the new details here too.
  document.addEventListener('shop:changed', () => { if (state.assistantId) refresh(); });

  async function init({ assistantId, assistantName }) {
    if (!assistantId) return;
    state.assistantId = assistantId;
    state.assistantName = assistantName || '';
    state.shown = 20; state.shopSaved = null; state.shopError = null; state.stockSaved = null; state.stockError = null; state.paymentsError = null; state.paymentsNotice = null; state.refreshed = false;
    if (host()) host().innerHTML = '<p class="text-sm text-gray-500">Loading…</p>';
    // Bound once, on the document (the tab is re-rendered; never bind from render).
    if (!state.bound) { document.addEventListener('click', onClick); state.bound = true; }
    await refresh();
  }

  window.AssistantShop = { init, refresh, _test: { steps, esc, money, stockCard } };
})();
