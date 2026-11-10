// src/components/site-facts-drawer.js — a side drawer that opens a Business Information editor beside
// the Website Assistant, so the facts a site needs (products, stays) are entered without leaving it
// (docs/website-business-info-inline-plan.md §4). The editor is the SAME one the Business Information
// page shows (products-editor.js, stays-editor.js), saving through the same endpoint — nothing is
// stored twice.
//
// window.SiteFactsDrawer.open({ kind: 'products' | 'stays', title, options, onSaved })
//   options — passed to that editor's mount() (openNew, productId, stayId, newType); compact is added
//   onSaved — after anything is saved in it (the site editor reloads its data and the preview)
// window.SiteFactsDrawer.close()
//
// Sits above the page and the docked chat (z 10500), below the media picker (11000) and dialogs
// (11000+), which open from inside it.
(function () {
  if (window.SiteFactsDrawer) return;

  const EDITORS = {
    products: { src: '/src/components/products-editor.js?v=20261109', title: 'Products & services', bizTab: 'products' },
    stays: { src: '/src/components/stays-editor.js?v=20261109', title: 'Holiday lets and rooms', bizTab: 'stays' },
  };
  const loading = {};
  function loadEditor(kind) {
    if (window.BizInfoEditors && window.BizInfoEditors[kind]) return Promise.resolve(window.BizInfoEditors[kind]);
    if (!loading[kind]) {
      loading[kind] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = EDITORS[kind].src;
        s.onload = () => (window.BizInfoEditors && window.BizInfoEditors[kind] ? resolve(window.BizInfoEditors[kind]) : reject(new Error('missing')));
        s.onerror = () => { s.remove(); reject(new Error('missing')); };
        document.head.appendChild(s);
      }).catch((err) => { delete loading[kind]; throw err; });
    }
    return loading[kind];
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let el = null;
  let returnFocus = null;
  let returnSelector = '';
  let current = null;

  function close() {
    if (!el) return;
    el.remove();
    el = null;
    current = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', close);
    document.documentElement.style.overflow = '';
    // A save redraws the page behind, replacing the button that opened the drawer: find its new copy.
    const back = returnFocus && returnFocus.isConnected ? returnFocus : (returnSelector && document.querySelector(returnSelector));
    if (back) back.focus();
    returnFocus = null; returnSelector = '';
  }

  // The workspace keeps many closed dialogs in the page (display:none, zero size, or slid off-screen
  // and inert), so only one actually on screen counts as open.
  function onScreen(x) {
    if (x.closest('[inert], [aria-hidden="true"]') || getComputedStyle(x).visibility === 'hidden') return false;
    const r = x.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  }

  function onKey(e) {
    if (!el) return;
    // A picker or dialog opened from inside the drawer is on top: its keys are its own.
    if ([...document.querySelectorAll('[aria-modal="true"]')].some((x) => !el.contains(x) && onScreen(x))) return;
    // Esc closes the drawer.
    if (e.key === 'Escape') {
      // An open editor form keeps its own Esc (the Products editor closes the form first).
      if (e.target && e.target.closest && e.target.closest('#op-editor')) return;
      e.preventDefault();
      close();
    }
    // Keep Tab inside the drawer while it is open.
    if (e.key === 'Tab') {
      const items = [...el.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  async function open(o) {
    const kind = o && o.kind;
    const ed = EDITORS[kind];
    if (!ed) return;
    close();
    returnFocus = document.activeElement;
    const attr = returnFocus && [...returnFocus.attributes].find((a) => a.name.startsWith('data-site-open-'));
    returnSelector = attr ? `[${attr.name}="${CSS.escape(attr.value)}"]` : '';
    const title = (o && o.title) || ed.title;
    el = document.createElement('div');
    el.setAttribute('data-site-facts-drawer', kind);
    el.style.cssText = 'position:fixed;inset:0;z-index:10500;display:flex;justify-content:flex-end';
    el.innerHTML = `
      <div data-sfd-backdrop style="position:absolute;inset:0;background:rgba(17,24,39,.35)"></div>
      <aside role="dialog" aria-modal="true" aria-labelledby="sfd-title" class="bg-white shadow-2xl"
        style="position:relative;width:min(600px,100vw);height:100%;display:flex;flex-direction:column">
        <div class="flex items-center justify-between gap-3 border-b border-gray-200 px-4 sm:px-5 py-3">
          <h2 id="sfd-title" class="text-base font-black text-gray-900 truncate">${esc(title)}</h2>
          <button type="button" data-sfd-close class="btn-utility text-sm font-bold px-2.5 py-1 rounded-md" aria-label="Close">✕</button>
        </div>
        <div data-sfd-body class="flex-1 px-4 sm:px-5 py-4" style="overflow-y:auto;min-height:0">
          <p class="text-sm text-gray-400">Loading…</p>
        </div>
        <div class="border-t border-gray-200 px-4 sm:px-5 py-2.5 flex flex-wrap items-center justify-between gap-2 bg-gray-50">
          <p class="text-xs text-gray-500">Saved to your Business Information, so your other assistants use it too.</p>
          <button type="button" data-sfd-full class="link text-xs font-bold">Open in Business Information</button>
        </div>
      </aside>`;
    document.body.appendChild(el);
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('popstate', close);
    el.querySelector('[data-sfd-close]').focus();
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-sfd-close]') || e.target.matches('[data-sfd-backdrop]')) { close(); return; }
      if (e.target.closest('[data-sfd-full]')) {
        close();
        window._bizinfoInitialTab = ed.bizTab;
        if (typeof window.loadView === 'function') window.loadView('assets');
      }
    });
    const mine = el;
    current = kind;
    const body = el.querySelector('[data-sfd-body]');
    try {
      const editor = await loadEditor(kind);
      if (el !== mine) return; // closed, or another opened, while it loaded
      body.innerHTML = '';
      const host = document.createElement('div');
      body.appendChild(host);
      editor.mount(host, { ...((o && o.options) || {}), compact: true, onSaved: o && o.onSaved });
    } catch {
      if (el !== mine) return;
      body.innerHTML = '<p class="text-sm text-gray-700">This didn\'t load. Close it and try again, or open it in Business Information.</p>';
    }
  }

  window.SiteFactsDrawer = { open, close, isOpen: () => !!el, kind: () => current };
})();
