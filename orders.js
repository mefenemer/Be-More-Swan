// orders.js — the workspace's Orders page (orders.html), from the side menu.
// Reads the same list as the Website tab's Orders card (sites.ts `orders`, `order_done`) for each
// Website Assistant the workspace has (normally one). Nothing here moves money: refunds and payouts
// are in the business's own Stripe dashboard.
(function () {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (pence, cur) => (String(cur || 'gbp').toLowerCase() === 'gbp' ? `£${(pence / 100).toFixed(2).replace(/\.00$/, '')}` : `${(pence / 100).toFixed(2)} ${String(cur).toUpperCase()}`);
  const when = (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  async function post(body) {
    const r = await fetch('/.netlify/functions/sites', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
    return j;
  }
  let sellers = [];   // [{ assistant, site, payments, orders }]

  function addressOf(a) {
    const x = a && a.address;
    return x ? [x.line1, x.line2, x.city, x.postal_code, x.country].filter(Boolean).join(', ') : '';
  }
  function openWebsiteTab(assistantId) {
    window._assistantDetailInitialTab = 'sitebuilder';
    if (typeof window.routeToAssistantDetail === 'function') window.routeToAssistantDetail(String(assistantId));
  }

  function render() {
    const root = document.getElementById('orders-root');
    if (!root) return;
    if (!sellers.length) { root.innerHTML = '<p class="text-sm text-gray-500">Hire a Website Assistant to sell from your website.</p>'; return; }
    root.innerHTML = sellers.map((s) => {
      const p = s.payments || {};
      const banner = p.chargesEnabled ? '' : `<div class="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
        <p class="text-sm font-bold text-amber-900">${p.connected ? 'Stripe still needs a few details' : 'Connect Stripe to take payments'}</p>
        <p class="text-xs text-amber-900 mt-1">Buy buttons and deposits appear on your website once Stripe is connected. Stripe will ask for your website's address.</p>
        <button type="button" data-orders-open="${esc(s.assistant.id)}" class="btn-primary mt-2 px-3 py-1.5 text-xs font-bold rounded-lg">Go to ${esc(s.assistant.name)}'s Website tab</button></div>`;
      const list = s.orders || [];
      const rows = list.length ? `<ul class="space-y-2">${list.map((o) => `
        <li class="bg-white border ${o.status === 'paid' ? 'border-indigo-200' : 'border-gray-200'} rounded-xl p-4 ${o.status === 'done' ? 'opacity-70' : ''}">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm font-bold text-gray-900">${esc(o.itemName)}${o.quantity > 1 ? ` ×${esc(o.quantity)}` : ''} · ${esc(money(o.amountTotal, o.currency))}</p>
            <span class="text-xs font-bold ${o.status === 'done' ? 'text-gray-500' : 'text-indigo-700'}">${o.status === 'done' ? 'Done' : 'New'} · ${esc(when(o.createdAt))}</span>
          </div>
          <p class="text-xs text-gray-700 mt-1">${esc(o.customerName || 'Customer')}${o.customerEmail ? ` · <a class="underline" href="mailto:${esc(o.customerEmail)}">${esc(o.customerEmail)}</a>` : ''}</p>
          ${addressOf(o.shippingAddress) ? `<p class="text-xs text-gray-600 mt-1">Deliver to: ${esc(addressOf(o.shippingAddress))}</p>` : ''}
          <div class="mt-2"><button type="button" data-order-done="${esc(o.id)}" data-assistant="${esc(s.assistant.id)}" data-done="${o.status === 'done' ? '0' : '1'}" class="btn-utility text-xs font-bold px-2.5 py-1 rounded">${o.status === 'done' ? 'Mark as new' : 'Mark as done'}</button></div>
        </li>`).join('')}</ul>`
        : '<p class="text-sm text-gray-500 bg-white border border-dashed border-gray-200 rounded-xl px-4 py-6 text-center">No orders yet. When someone buys from your website, it appears here and in your email.</p>';
      const heading = sellers.length > 1 ? `<h2 class="text-sm font-bold text-gray-900 mb-2">${esc(s.assistant.name)}${s.site && s.site.url ? ` — ${esc(s.site.url.replace('https://', ''))}` : ''}</h2>` : '';
      return `<section class="mb-8">${heading}${banner}${rows}</section>`;
    }).join('');
  }

  async function load() {
    const res = await (window.bmsCachedFetch ? window.bmsCachedFetch.assistants() : fetch('/.netlify/functions/get-assistants', { credentials: 'same-origin' }));
    const d = await res.clone().json();
    const assistants = (d.assistants || []).filter((a) => a.roleKey === 'website_assistant' && a.lifecycleStatus !== 'archived');
    sellers = await Promise.all(assistants.map(async (a) => {
      const [view, ord] = await Promise.all([post({ action: 'get', assistantId: a.id }), post({ action: 'orders', assistantId: a.id })]);
      return { assistant: a, site: view.site, payments: view.payments, orders: ord.orders || [] };
    }));
    render();
  }

  // Bound once, on the document (the view is re-rendered by the router; never bind from render).
  document.addEventListener('click', async (e) => {
    const open = e.target.closest && e.target.closest('[data-orders-open]');
    if (open) { openWebsiteTab(open.dataset.ordersOpen); return; }
    const btn = e.target.closest && e.target.closest('[data-order-done]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await post({ action: 'order_done', assistantId: Number(btn.dataset.assistant), id: Number(btn.dataset.orderDone), done: btn.dataset.done === '1' });
      await load();
    } catch (err) { btn.disabled = false; if (window.alertModal) window.alertModal(err.message); }
  });

  window.initOrders = async function initOrders() {
    try { await load(); }
    catch (err) {
      const root = document.getElementById('orders-root');
      if (root) root.innerHTML = `<p class="text-sm text-red-600">${esc(err.message || 'Orders could not be loaded.')}</p>`;
    }
  };
})();
