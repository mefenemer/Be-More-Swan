/**
 * src/components/brand-style-card.js — "Your brand style" in every assistant's "Your brand" section (owner,
 * 2026-11-05: in the profile, not above the briefs; 2026-11-06: every assistant, beside the files and links).
 *
 * Shows the colours, font and picture guidelines from netlify/functions/brand-kit.ts (GET), and "View or change"
 * opens the same pop-up the chat's style card uses (brand-style-dialog.js), so there is one place that saves.
 *
 *   window.BrandStyleCard.mount(el, { assistantName })
 */
(function () {
  'use strict';

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** The card's inside, from the kit and guidelines as brand-kit.ts returns them. */
  function html(kit, g) {
    const button = '<button type="button" data-brand-style-edit class="btn-secondary border min-h-[44px] sm:min-h-0 px-3 py-1.5 text-xs font-bold rounded-lg flex-shrink-0">View or change</button>';
    const head = '<h3 class="text-lg font-bold text-gray-900">Your brand style</h3><p class="text-sm text-gray-500 mt-1">The colours, font and picture guidelines every design starts from.</p>';
    if (!kit) return `<div class="flex flex-wrap items-start justify-between gap-3"><div>${head}<p class="text-sm text-gray-600 mt-3">Your brand style could not be read just now.</p></div>${button}</div>`;
    const guide = g || {};
    const unset = kit.source !== 'manual' && kit.source !== 'website';
    const swatch = (c, label) => `<span title="${esc(label)}: ${esc(c)}" class="inline-block w-7 h-7 rounded-full border border-gray-300" style="background:${esc(c)}"></span>`;
    const parts = [
      guide.photoStyle ? `<span class="font-bold">Style:</span> ${esc(guide.photoStyle)}` : '',
      guide.mustInclude ? `<span class="font-bold">Include:</span> ${esc(guide.mustInclude)}` : '',
      guide.mustAvoid ? `<span class="font-bold">Never show:</span> ${esc(guide.mustAvoid)}` : '',
    ].filter(Boolean);
    if (kit.fontFamily) window.FontPicker?.loadFamily(kit.fontFamily);
    return `
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">${head}</div>
        ${button}
      </div>
      <div class="flex flex-wrap items-center gap-3 mt-4">
        <span class="inline-flex items-center gap-1">${unset ? '' : `${swatch(kit.primaryColor, 'Main colour')}${swatch(kit.backgroundColor, 'Background')}${swatch(kit.textColor, 'Text')}`}${(guide.secondaryColors || []).map((c) => swatch(c, 'Extra colour')).join('')}</span>
        ${unset ? '<span class="text-xs font-semibold text-amber-900">No brand colours chosen yet, so designs use our black and white until you choose</span>' : ''}
        <span class="text-base text-gray-900" ${kit.fontFamily ? `style="font-family:'${esc(kit.fontFamily)}', system-ui, sans-serif"` : ''}>${esc(kit.fontFamily || 'Our standard font')}</span>
      </div>
      <p class="text-sm text-gray-600 mt-3">${parts.length ? parts.join(' · ') : 'No picture guidelines yet. Add a photo style and anything pictures must never show.'}</p>`;
  }

  async function read() {
    const res = await fetch('/.netlify/functions/brand-kit', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'brand-kit');
    return { kit: data.brandKit || null, g: data.guidelines || {} };
  }

  function mount(el, opts) {
    if (!el) return;
    const o = opts || {};
    const paint = () => read()
      .then(({ kit, g }) => { if (el.isConnected) el.innerHTML = html(kit, g); })
      .catch(() => { if (el.isConnected) el.innerHTML = html(null, null); });
    el.innerHTML = '<p class="text-sm text-gray-500">Loading your brand style…</p>';
    if (!el.dataset.brandStyleBound) {
      el.dataset.brandStyleBound = '1';
      el.addEventListener('click', (e) => {
        if (!e.target.closest('[data-brand-style-edit]')) return;
        if (window.BrandStyleDialog && window.FontPicker) {
          window.BrandStyleDialog.open({ assistantName: el.dataset.assistantName || null, onSaved: () => el._brandStylePaint?.() });
          return;
        }
        window._bizinfoInitialTab = 'assets';
        if (window.loadView) window.loadView('assets');
      });
      // A style saved from the chat's card, or anywhere else, shows here too.
      // brief:changed is what chat-session.js sends when the chat's brand style card is saved.
      document.addEventListener('brief:changed', () => { if (el.isConnected) el._brandStylePaint?.(); });
    }
    el.dataset.assistantName = o.assistantName || '';
    el._brandStylePaint = paint;
    paint();
  }

  window.BrandStyleCard = { mount, html };
})();
