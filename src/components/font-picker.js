/**
 * src/components/font-picker.js — choose a font by looking at it (owner, 2026-11-05).
 *
 * A pick list where every font is written in itself, a search, and a sample of the chosen font written out
 * below. Used by the Brand Designer's brand style pop-up and Business Information ▸ Brand Assets, which both
 * save to the same brand kit field.
 *
 * The list is window.BlogFonts (src/config/blog-fonts.ts, generated): the one list of fonts we offer. Only
 * Google families are shown, because those are what the card and flyer renderers can fetch
 * (src/lib/brand-card-webfont.ts). Any other Google Fonts family can still be typed into the search: a
 * website's font is often not on our list, and it must not read as "nothing chosen".
 *
 *   const p = window.FontPicker.mount(hostEl, { value, onChange(family|null), label? });
 *   p.setValue(family|null); p.getValue(); p.destroy();
 */
(function () {
  'use strict';

  const FONT_NAME = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;   // the rule brand-kit.ts cleanFontFamily enforces
  const CSS_HOST = 'https://fonts.googleapis.com/css2';
  const SAMPLE_HEADLINE = 'Your words, in this font';
  const SAMPLE_BODY = 'A short sentence and some numbers: open 9 to 5, from £20.';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // The browser's copy carries each font's stylesheet address rather than its family name, so the name is read
  // from that. A font with no address needs no download (Georgia, say): the renderers could not fetch it.
  const familyOf = (url) => { const m = /[?&]family=([^:&]+)/.exec(url || ''); return m ? decodeURIComponent(m[1]).replace(/\+/g, ' ') : null; };
  const fonts = () => ((window.BlogFonts && window.BlogFonts.all) || [])
    .map((f) => ({ ...f, google: familyOf(f.url) })).filter((f) => f.google);
  const familyParam = (name) => encodeURIComponent(name).replace(/%20/g, '+');

  const linked = new Set();
  function addSheet(href) {
    if (linked.has(href)) return;
    linked.add(href);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  /** The whole font, for a sample. A family off our list has unknown weights, so none are named. */
  function loadFamily(name) {
    if (!name || !FONT_NAME.test(name)) return;
    const known = fonts().find((f) => f.google === name);
    addSheet(known ? known.url : `${CSS_HOST}?family=${familyParam(name)}&display=swap`);
  }

  /** Each listed font, cut down to the letters of its own name, so opening the list stays cheap. */
  function loadListPreviews() {
    fonts().forEach((f) => addSheet(`${CSS_HOST}?family=${familyParam(f.google)}&display=swap&text=${encodeURIComponent(f.label)}`));
  }

  function mount(host, opts) {
    const o = opts || {};
    let value = o.value && FONT_NAME.test(o.value) ? o.value : null;
    let open = false;
    let query = '';
    let active = -1;
    const id = `fp-${Math.random().toString(36).slice(2, 8)}`;

    host.innerHTML = `
      <div class="relative" data-fp>
        <button type="button" data-fp-toggle aria-haspopup="listbox" aria-expanded="false" ${o.label ? `aria-label="${esc(o.label)}"` : ''}
          class="w-full flex items-center justify-between gap-2 px-3 py-2 text-left bg-white border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-600 outline-none">
          <span data-fp-current class="truncate text-base"></span><span aria-hidden="true" class="text-gray-500 text-xs">▼</span>
        </button>
        <div data-fp-panel hidden class="absolute z-30 left-0 right-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg">
          <input type="text" data-fp-search maxlength="48" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="${id}" aria-label="Search fonts"
            placeholder="Search, or type any Google font" class="w-full px-3 py-2 text-sm border-b border-gray-200 rounded-t-lg outline-none">
          <ul id="${id}" role="listbox" aria-label="Fonts" data-fp-list class="max-h-64 overflow-y-auto py-1"></ul>
        </div>
        ${o.sample === false ? '' : '<div data-fp-sample class="mt-2 px-3 py-3 bg-gray-50 border border-gray-200 rounded-lg" aria-live="polite"></div>'}
      </div>`;
    const q = (sel) => host.querySelector(sel);
    const panel = q('[data-fp-panel]');
    const toggle = q('[data-fp-toggle]');
    const search = q('[data-fp-search]');
    const list = q('[data-fp-list]');

    const stack = (name) => (name ? `'${name}', system-ui, sans-serif` : 'inherit');

    function paintValue() {
      const cur = q('[data-fp-current]');
      cur.textContent = value || 'Our standard font';
      cur.style.fontFamily = stack(value);
      loadFamily(value);
      const sample = q('[data-fp-sample]');
      if (sample) sample.innerHTML = `
        <p class="text-xs font-bold text-gray-500">Example</p>
        <div style="font-family:${esc(stack(value))}">
          <p class="text-xl font-bold text-gray-900 mt-1 break-words">${esc(SAMPLE_HEADLINE)}</p>
          <p class="text-sm text-gray-700 mt-1 break-words">${esc(SAMPLE_BODY)}</p>
        </div>`;
    }

    /** What the list shows right now: { family, label, group }, with family null for "Our standard font". */
    function rows() {
      const t = query.trim().toLowerCase();
      const out = [];
      if (!t) out.push({ family: null, label: 'Our standard font', group: '' });
      fonts().filter((f) => !t || f.label.toLowerCase().includes(t))
        .forEach((f) => out.push({ family: f.google, label: f.label, group: f.category }));
      const typed = query.trim().replace(/\s+/g, ' ');
      if (typed && FONT_NAME.test(typed) && !out.some((r) => r.family && r.family.toLowerCase() === typed.toLowerCase())) {
        out.push({ family: typed, label: `Use “${typed}” from Google Fonts`, group: 'Typed', typed: true });
      }
      return out;
    }

    function paintList() {
      const all = rows();
      if (active >= all.length) active = all.length - 1;
      let group = null;
      let html = '';
      all.forEach((r, i) => {
        if (r.group && r.group !== group) {
          group = r.group;
          html += `<li role="presentation" class="px-3 pt-2 pb-1 text-[11px] font-bold text-gray-500 uppercase tracking-wider">${esc(group)}</li>`;
        }
        const on = r.family === value;
        html += `<li role="option" id="${id}-${i}" aria-selected="${on}" data-fp-opt="${i}"
          class="px-3 py-1.5 cursor-pointer text-base ${i === active ? 'bg-emerald-50' : ''} ${on ? 'font-bold' : ''}"
          ${r.family && !r.typed ? `style="font-family:${esc(stack(r.family))}"` : ''}>${esc(r.label)}${on ? ' <span aria-hidden="true">✓</span>' : ''}</li>`;
      });
      list.innerHTML = html || '<li class="px-3 py-2 text-sm text-gray-500">No font by that name. Check the spelling on fonts.google.com.</li>';
      if (active >= 0) {
        search.setAttribute('aria-activedescendant', `${id}-${active}`);
        list.querySelector(`[data-fp-opt="${active}"]`)?.scrollIntoView({ block: 'nearest' });
      } else search.removeAttribute('aria-activedescendant');
    }

    function setOpen(next) {
      open = next;
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (!open) return;
      loadListPreviews();
      query = '';
      search.value = '';
      active = rows().findIndex((r) => r.family === value);
      paintList();
      search.focus();
    }

    function choose(row) {
      value = row.family;
      setOpen(false);
      paintValue();
      toggle.focus();
      if (o.onChange) o.onChange(value);
    }

    const onDocClick = (e) => { if (open && !host.contains(e.target)) setOpen(false); };
    document.addEventListener('click', onDocClick);
    toggle.addEventListener('click', () => setOpen(!open));
    search.addEventListener('input', () => { query = search.value; active = query.trim() ? 0 : -1; paintList(); });
    list.addEventListener('click', (e) => {
      const li = e.target.closest('[data-fp-opt]');
      if (li) choose(rows()[Number(li.dataset.fpOpt)]);
    });
    search.addEventListener('keydown', (e) => {
      const all = rows();
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(all.length - 1, active + 1); paintList(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paintList(); return; }
      if (e.key === 'Enter') { e.preventDefault(); if (all[active]) choose(all[active]); return; }
      // Only the list closes: a pop-up holding this picker stays open.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); toggle.focus(); }
    });

    paintValue();
    return {
      getValue: () => value,
      setValue(next) { value = next && FONT_NAME.test(next) ? next : null; paintValue(); },
      destroy() { document.removeEventListener('click', onDocClick); host.innerHTML = ''; },
    };
  }

  window.FontPicker = { mount, loadFamily };
})();
