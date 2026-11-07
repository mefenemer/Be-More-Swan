/**
 * One tab header for every assistant (owner, 2026-11-07).
 *
 *   Row 1  title + ⓘ (+ a status chip) on the left; any other buttons, then Full screen, then one pink "+ New …".
 *   Then   one white card (.tab-card): its pill row first (.tab-pillbar: pills left, small pink list links right),
 *          an optional help line, then the list.
 *   Pills  status pills show a plain grey count, 0 included; amber only on the pill waiting for you. Section pills
 *          (Preview, Design, Blog setup) show no count, and sit after a thin .pill-divider in a row of status pills.
 *
 * Its own file, loaded before assistants.js and the tab components, so a bare test page that mounts one tab gets the
 * same header. Carries its own CSS for the same reason. Full screen stays window._tabFullBtn (assistants.js).
 */
(function () {
  if (window._tabHead) return;
  const CSS = `
.stage-pills:not(.hidden) { display: inline-flex !important; }
.stage-pills { max-width: calc(100% - 2rem); gap: .25rem; padding: .25rem !important;
margin: .75rem 1rem .25rem; border-radius: .75rem; background: #f3f4f6; border-bottom: 0 !important; overflow-x: auto; overflow-y: hidden; }
.stage-pills > [role="tab"] { border-bottom: 0 !important; border-radius: .5rem !important; padding: .375rem .75rem !important;
font-weight: 700 !important; color: #4b5563 !important; background: transparent; transition: background .15s ease, color .15s ease; }
.stage-pills > [role="tab"]:hover { color: #111827 !important; }
.stage-pills > [role="tab"][aria-selected="true"] { background: #fff; color: #111827 !important; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.tab-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: 1rem; min-height: 2.5rem; }
.tab-head-left { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; min-width: 0; }
.tab-head-title { font-size: 1.125rem; line-height: 1.75rem; font-weight: 800; color: #111827; margin: 0; }
.tab-head-chip { display: inline-flex; align-items: center; padding: .125rem .625rem; font-size: .75rem; font-weight: 600; border-radius: 9999px; background: #f3f4f6; color: #374151; white-space: nowrap; }
button.tab-head-chip { cursor: pointer; } button.tab-head-chip:hover { background: #e5e7eb; }
.tab-head-right { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: .5rem; margin-left: auto; }
.tab-card { background: #fff; border: 1px solid #e5e7eb; border-radius: .75rem; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
.tab-pillbar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .75rem; padding: .75rem 1rem .25rem; }
.tab-pillbar > .stage-pills { margin: 0 !important; max-width: 100%; flex-wrap: wrap; }
.tab-pillbar:has(> .stage-pills.hidden) { padding: .5rem 1rem 0; }
.tab-pillbar-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin-left: auto; }
.tab-link { font-size: .75rem; font-weight: 700; color: #d6006b; background: none; border: 0; padding: .25rem 0; cursor: pointer; white-space: nowrap; }
.tab-link:hover { text-decoration: underline; }
.tab-help { font-size: .75rem; color: #4b5563; padding: .25rem 1rem 0; margin: 0; }
.pill-n { margin-left: .25rem; font-size: .75rem; font-weight: 600; color: #6b7280; }
.pill-wait { margin-left: .25rem; background: #fef3c7; color: #b45309; font-size: .75rem; font-weight: 700; padding: .0625rem .375rem; border-radius: 9999px; }
.pill-alert { margin-left: .25rem; background: #fee2e2; color: #b91c1c; font-size: .75rem; font-weight: 700; padding: .0625rem .375rem; border-radius: 9999px; }
.stage-pills > .pill-divider { width: 1px; align-self: stretch; background: #d1d5db; margin: .25rem .125rem; flex-shrink: 0; }
@media (max-width: 639px) { .tab-head-right { margin-left: 0; justify-content: flex-start; } }
`;
  function addCss() {
    if (document.getElementById('tab-head-css')) return;
    const st = document.createElement('style');
    st.id = 'tab-head-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  addCss();

  // ── One tab header for every assistant (owner, 2026-11-07) ──
  // Title + ⓘ (+ an optional status chip) on the left; on the right any other buttons, then Full screen, then one
  // "+ New …". CSS above (.tab-head …). `explain` names a glossary entry; `about` (optional)
  // registers one on the fly for a tab that has none, so every title carries its ⓘ.
  const _TAB_PLUS = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>';
  const _tabEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window._tabHead = function({ title, explain = '', about = '', emoji = 'ℹ️', chip = '', right = '', attrs = '' } = {}) {
      const G = window.BMSExplainers?.GLOSSARY;
      if (explain && about && G && !G[explain]) G[explain] = { term: title, emoji, plain: about };
      return `<div class="tab-head" ${attrs}><div class="tab-head-left"><h2 class="tab-head-title"${explain ? ` data-explain="${_tabEsc(explain)}"` : ''}>${_tabEsc(title)}</h2>${chip}</div><div class="tab-head-right">${right}</div></div>`;
  };
  /** The one main button: pink, "+", sentence case ("New post"). `attrs` carries the tab's own data- hook. */
  window._tabNewBtn = function(label, attrs = '') {
      return `<button type="button" ${attrs} class="tab-head-new btn-primary min-h-[44px] sm:min-h-0 px-4 py-2 text-sm font-bold rounded-lg transition cursor-pointer inline-flex items-center gap-1.5 whitespace-nowrap">${_TAB_PLUS}<span>${_tabEsc(label)}</span></button>`;
  };
  /** A secondary header button (Review lead ideas, Blog setup …). */
  window._tabSecBtn = function(label, attrs = '') {
      return `<button type="button" ${attrs} class="btn-secondary border min-h-[44px] sm:min-h-0 px-3 py-2 text-sm font-bold rounded-lg transition cursor-pointer whitespace-nowrap">${_tabEsc(label)}</button>`;
  };
  /** A pill's count: amber when it is the pill waiting for you and above 0, else a plain grey number (0 shown). */
  window._tabPillCount = function(n, waiting = false) {
      const v = Number(n) || 0;
      return waiting && v > 0 ? ` <span class="pill-wait">${v}</span>` : ` <span class="pill-n">${v}</span>`;
  };
})();
