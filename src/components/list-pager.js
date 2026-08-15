/**
 * src/components/list-pager.js
 * One pager, shared by every long list in the assistant detail view.
 *
 * Three surfaces grew past the height anyone will scroll — Searches, the records Review Queue and
 * the Data Hub table — and each was about to grow its own page control. This is the shared half:
 * the arithmetic (which slice of the list is on screen) and the markup (the buttons and the line
 * that says what you are looking at). Wiring the clicks stays with the caller, because each surface
 * repaints differently: the inbox re-renders its panel, the Review Queue repaints its cards from an
 * already-fetched array, and the hub repaints a tbody without touching the controls above it.
 *
 * ⚠️ This pages a list the browser ALREADY HAS. It is not a substitute for a server LIMIT, and the
 * three callers use it deliberately: all three read a whole record set for other reasons (the hub
 * filters, sorts and groups over every row; the Review Queue's badge counts the whole column;
 * Searches derives every "View results (N)" from one unfiltered read), so paging the fetch would
 * make those numbers describe one page. What this fixes is RENDER cost and scroll length. If a
 * tenant ever arrives with tens of thousands of records the fetch itself becomes the problem, and
 * that is a server-side change, not a bigger version of this.
 *
 * Every class used here is already compiled into style.css — no Tailwind rebuild.
 */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /**
   * The slice on screen, with the page number CLAMPED rather than trusted.
   *
   * Clamping is the load-bearing part. Every caller keeps its page number across a reload — that is
   * the point, so acting on a card on page four does not throw you back to page one — and the list
   * underneath shrinks constantly: approve a lead and it leaves the Review column, filter the hub
   * and forty rows become three. An unclamped page then renders an empty list with no explanation,
   * which reads as "your leads are gone".
   */
  function page(list, wanted, size) {
    const all = Array.isArray(list) ? list : [];
    const perPage = Math.max(1, Number(size) || 10);
    const pages = Math.max(1, Math.ceil(all.length / perPage));
    const current = Math.min(Math.max(1, Number(wanted) || 1), pages);
    const from = (current - 1) * perPage;
    const items = all.slice(from, from + perPage);
    return {
      items,
      page: current,
      pages,
      size: perPage,
      total: all.length,
      // 1-based and inclusive, for "showing 11–20 of 63". Both are 0 on an empty list, which the
      // caller never renders — controlsHtml returns '' for a single page.
      first: all.length ? from + 1 : 0,
      last: all.length ? from + items.length : 0,
    };
  }

  /**
   * Which page numbers get a button: always the first and last, plus the current one and its
   * neighbours, with an ellipsis across whatever that skips. Anything more on a hub with forty
   * pages is a wall of numbers; anything less and there is no way to reach the end in one click.
   */
  function pageNumbers(current, pages) {
    const want = new Set([1, pages, current - 1, current, current + 1]);
    const shown = [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    for (const n of shown) {
      if (prev && n - prev > 1) out.push(null);   // null renders as the ellipsis
      out.push(n);
      prev = n;
    }
    return out;
  }

  /**
   * The control itself. `attr` is the data attribute the caller binds to — each button carries the
   * page number it goes to, so a caller only ever reads one number off the click and repaints.
   *
   * Returns '' when everything fits on one page: a pager under a list of six is furniture that says
   * nothing. `noun` names what is being counted ("leads", "searches") so the line reads as a fact
   * about the data rather than about the widget.
   */
  function controlsHtml(info, opts) {
    if (!info || info.pages <= 1) return '';
    const attr = (opts && opts.attr) || 'data-pager-page';
    const noun = (opts && opts.noun) || 'items';
    const btn = 'px-2.5 py-1 text-xs font-bold rounded-lg border bg-white transition cursor-pointer';
    const idle = `${btn} border-gray-200 text-gray-700 hover:border-gray-300`;
    const here = `${btn} border-emerald-600 bg-emerald-700 text-white`;
    const step = `${idle} disabled:opacity-40 disabled:cursor-not-allowed`;

    const numbers = pageNumbers(info.page, info.pages).map((n) => (
      n === null
        ? '<span class="text-xs font-bold text-gray-400 px-1">…</span>'
        : `<button type="button" ${attr}="${n}" class="${n === info.page ? here : idle}"${n === info.page ? ' aria-current="page"' : ''}>${n}</button>`
    )).join('');

    return `
      <div class="flex flex-wrap items-center justify-center gap-1.5 py-3 border-t border-gray-100">
        <button type="button" ${attr}="${info.page - 1}" class="${step}"${info.page === 1 ? ' disabled' : ''}>Previous</button>
        ${numbers}
        <button type="button" ${attr}="${info.page + 1}" class="${step}"${info.page === info.pages ? ' disabled' : ''}>Next</button>
        <p class="w-full text-center text-[11px] text-gray-400 mt-1">Showing ${info.first}–${info.last} of ${info.total} ${esc(noun)}</p>
      </div>`;
  }

  /**
   * Bind every page button under `host` in one delegated listener, so a caller that rewrites its
   * own innerHTML does not have to re-bind. Safe to call repeatedly on the same node: the listener
   * is attached once and remembered on the element.
   */
  function bind(host, attr, onPage) {
    if (!host || host.dataset.pagerBound === attr) return;
    host.dataset.pagerBound = attr;
    host.addEventListener('click', (e) => {
      const btn = e.target.closest(`[${attr}]`);
      if (!btn || btn.disabled || !host.contains(btn)) return;
      const n = Number(btn.getAttribute(attr));
      if (Number.isFinite(n) && n >= 1) onPage(n);
    });
  }

  window.ListPager = { page, controlsHtml, bind, pageNumbers };
})();
