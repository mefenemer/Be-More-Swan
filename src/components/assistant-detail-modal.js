/**
 * src/components/assistant-detail-modal.js
 *
 * Shared "assistant detail" modal — shows the marketing copy (tagline, description, key features,
 * integrations) for a roleKey, plus a configurable CTA.
 *
 * Copy comes from window.AssistantContent (src/config/assistant-content.js), which reads
 * master_assistants via the API. Callers must prime or load it first — the catalogue pages already
 * fetch that list, so they pass it to AssistantContent.prime() rather than re-fetching.
 *
 * Used by:
 *   - assistants.html (public library; CTA → setup wizard or pricing)
 *   - assistant-catalogue.html via workspace.html (CTA → window._catHire)
 *
 * Usage:
 *   window.AssistantDetailModal.open('lead_qualifier', {
 *     ctaLabel: 'Hire Role',
 *     ctaHref: 'assistant-setup.html?roleKey=lead_qualifier',  // anchor CTA…
 *     onCta: () => {},                                         // …or button CTA
 *   });
 */
(function () {
  'use strict';

  // Same icon set as assistant-catalogue.html / assistants.html
  const ICONS = {
    document: `<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
    smile:    `<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
    megaphone:`<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>`,
    globe:    `<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg>`,
    chart:    `<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>`,
    lightning:`<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
    mail:     `<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>`,
    cog:      `<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><circle cx="12" cy="12" r="3"/></svg>`,
  };

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Branded backdrop for the video slot when no poster image is provided —
  // keyed to the role's accent so each assistant's video reads on-brand.
  const VIDEO_GRADIENTS = {
    blue:   ['#2563eb', '#1e3a8a'], purple: ['#7c3aed', '#4c1d95'],
    orange: ['#ea580c', '#7c2d12'], teal:   ['#0d9488', '#134e4a'],
    pink:   ['#db2777', '#7c3aed'], green:  ['#16a34a', '#14532d'],
    yellow: ['#ca8a04', '#713f12'], red:    ['#dc2626', '#7f1d1d'],
  };

  const PLAY_ICON = `<svg class="w-7 h-7" style="margin-left:3px" fill="#111827" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;

  // The 16:9 capability-video slot. Returns '' for roles without a `video`.
  // When `video.url` is unset it renders a production-ready placeholder; once a
  // url exists the slot becomes click-to-load (see loadVideo / playerHtml).
  function buildVideo(c) {
    const v = c.video;
    if (!v) return '';
    const hasUrl = !!v.url;
    const title = escHtml(v.title || `See ${c.name} in action`);

    let backdrop;
    if (v.poster) {
      backdrop = `<div class="adm-layer" style="background:url('${escHtml(v.poster)}') center/cover"></div>`
               + `<div class="adm-layer" style="background:rgba(0,0,0,0.35)"></div>`;
    } else {
      const g = VIDEO_GRADIENTS[c.iconColor] || VIDEO_GRADIENTS.blue;
      backdrop = `<div class="adm-layer" style="background:linear-gradient(135deg,${g[0]} 0%,${g[1]} 100%)"></div>`;
    }

    const urlAttr = hasUrl ? ` data-video-url="${escHtml(v.url)}"` : '';
    const badge = hasUrl ? '' : `<span class="adm-badge">Coming soon</span>`;

    return `
      <div class="mb-6">
        <div class="adm-video" data-detail-video${urlAttr}
             role="button" tabindex="0" aria-label="${title}">
          ${backdrop}
          <div class="adm-layer adm-cta">
            <div class="adm-play">${PLAY_ICON}</div>
            <span class="adm-title">${title}</span>
          </div>
          ${badge}
        </div>
      </div>`;
  }

  // Swaps the placeholder poster for a live player. Picks a native <video> for
  // self-hosted files and an autoplay <iframe> for YouTube/Vimeo embed URLs.
  function playerHtml(url, title) {
    const isFile = /\.(mp4|webm|ogg)(\?.*)?$/i.test(url);
    if (isFile) {
      return `<video src="${escHtml(url)}" controls autoplay playsinline preload="metadata"></video>`;
    }
    const src = url + (url.includes('?') ? '&' : '?') + 'autoplay=1';
    return `<iframe src="${escHtml(src)}" title="${escHtml(title || 'Capability video')}"
              allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  }

  function loadVideo(el) {
    if (el.dataset.loaded) return;
    el.dataset.loaded = '1';
    el.style.cursor = 'default';
    el.innerHTML = playerHtml(el.dataset.videoUrl, el.getAttribute('aria-label'));
  }

  // Builds the modal shell on first use. Icon tile colours are injected here too
  // so the modal renders the same in pages that don't define .icon-* themselves.
  function ensureModal() {
    let modal = document.getElementById('assistant-detail-modal');
    if (modal) return modal;

    const style = document.createElement('style');
    style.textContent = `
      #assistant-detail-modal .icon-blue   { background: #eff6ff; color: #2563eb; }
      #assistant-detail-modal .icon-purple { background: #f5f3ff; color: #7c3aed; }
      #assistant-detail-modal .icon-orange { background: #fff7ed; color: #ea580c; }
      #assistant-detail-modal .icon-teal   { background: #f0fdfa; color: #0d9488; }
      #assistant-detail-modal .icon-pink   { background: #fdf2f8; color: #db2777; }
      #assistant-detail-modal .icon-green  { background: #f0fdf4; color: #16a34a; }
      #assistant-detail-modal .icon-yellow { background: #fefce8; color: #ca8a04; }
      #assistant-detail-modal .icon-red    { background: #fef2f2; color: #dc2626; }
      #assistant-detail-modal .adm-video { position:relative; width:100%; padding-bottom:56.25%; border-radius:0.75rem; overflow:hidden; background:#111827; }
      #assistant-detail-modal .adm-layer { position:absolute; inset:0; }
      #assistant-detail-modal .adm-video video, #assistant-detail-modal .adm-video iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
      #assistant-detail-modal .adm-cta { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:0.75rem; }
      #assistant-detail-modal .adm-play { width:4rem; height:4rem; border-radius:9999px; background:rgba(255,255,255,0.96); box-shadow:0 10px 30px rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:center; transition:transform .15s ease; }
      #assistant-detail-modal [data-detail-video][data-video-url] { cursor:pointer; }
      #assistant-detail-modal [data-detail-video][data-video-url]:hover .adm-play { transform:scale(1.06); }
      #assistant-detail-modal .adm-title { color:#fff; font-weight:600; font-size:0.9rem; text-align:center; padding:0 1rem; text-shadow:0 1px 4px rgba(0,0,0,0.5); }
      #assistant-detail-modal .adm-badge { position:absolute; top:0.75rem; right:0.75rem; padding:2px 8px; border-radius:9999px; background:rgba(0,0,0,0.5); color:#fff; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; }`;
    document.head.appendChild(style);

    modal = document.createElement('div');
    modal.id = 'assistant-detail-modal';
    modal.className = 'fixed inset-0 hidden flex items-center justify-center p-4';
    modal.style.cssText = 'background:rgba(0,0,0,0.4);z-index:9500';
    modal.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg relative max-h-[85vh] overflow-y-auto">
        <button type="button" data-detail-close aria-label="Close" class="absolute top-4 right-4 text-gray-400 hover:text-gray-600 cursor-pointer">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div id="assistant-detail-body"></div>
      </div>`;
    document.body.appendChild(modal);

    modal.addEventListener('click', e => {
      const vid = e.target.closest('[data-detail-video][data-video-url]');
      if (vid) { loadVideo(vid); return; }
      if (e.target === modal || e.target.closest('[data-detail-close]')) close();
    });
    // Keyboard activation for the video slot (it is role="button").
    modal.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const vid = e.target.closest && e.target.closest('[data-detail-video][data-video-url]');
      if (vid) { e.preventDefault(); loadVideo(vid); }
    });
    return modal;
  }

  // Lock/unlock background page scroll so the site behind the modal can't be
  // interacted with while it's open. Delegated to the shared refcounted manager
  // (src/components/scroll-lock.js), which locks <html> and <body> both — the
  // scroll container is <html> on these pages (body is a flex column) — and
  // keeps the lock up if another overlay is also holding it.
  function lockScroll() { window.ScrollLock.lock('assistant-detail'); }
  function unlockScroll() { window.ScrollLock.release('assistant-detail'); }

  function close() {
    const modal = document.getElementById('assistant-detail-modal');
    if (modal) modal.classList.add('hidden');
    unlockScroll();
  }

  function open(roleKey, opts) {
    const c = window.AssistantContent && window.AssistantContent.get(roleKey);
    if (!c) return;
    opts = opts || {};

    const modal = ensureModal();
    const iconSvg = ICONS[c.iconKey] || ICONS.document;
    const iconClass = `icon-${c.iconColor || 'blue'}`;

    const features = (c.keyFeatures || []).map(f => `
      <li class="flex items-start gap-2 text-sm text-gray-600">
        <svg class="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
        <span>${escHtml(f)}</span>
      </li>`).join('');

    const apps = (c.integrations || []).map(app => `
      <span class="inline-flex items-center gap-1.5 bg-white border border-gray-200 rounded-full px-2.5 py-1 text-[11px] font-semibold text-gray-600">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>${escHtml(app)}
      </span>`).join('');

    const ctaLabel = escHtml(opts.ctaLabel || 'Hire Role');
    const cta = opts.ctaHref
      ? `<a href="${escHtml(opts.ctaHref)}" class="bg-emerald-700 text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-emerald-800 transition">${ctaLabel}</a>`
      : `<button type="button" data-detail-cta class="bg-emerald-700 text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-emerald-800 transition cursor-pointer">${ctaLabel}</button>`;

    const body = document.getElementById('assistant-detail-body');
    body.innerHTML = `
      <div class="p-8">
        <div class="flex items-start justify-between gap-4 pr-8">
          <div class="w-12 h-12 rounded-xl ${iconClass} flex items-center justify-center mb-4">${iconSvg}</div>
          <span class="inline-block px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold uppercase tracking-wider">Available Now</span>
        </div>
        <p class="text-sm text-gray-500 font-medium mb-1">${escHtml(c.category || '')}</p>
        <h2 class="text-2xl font-extrabold text-gray-900 leading-tight mb-2">${escHtml(c.name)}</h2>
        ${c.tagline ? `<p class="text-base font-bold text-emerald-700 mb-4">${escHtml(c.tagline)}</p>` : ''}

        ${buildVideo(c)}

        ${c.description ? `<p class="text-sm text-gray-600 leading-relaxed mb-6">${escHtml(c.description)}</p>` : ''}

        ${features ? `<h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Key Features</h3>
        <ul class="space-y-1.5 mb-6">${features}</ul>` : ''}

        ${apps ? `<h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Integrations</h3>
        <div class="flex flex-wrap gap-1.5 items-center">
          <span class="text-[10px] font-bold uppercase tracking-wider text-gray-400 mr-0.5">Works with</span>${apps}
        </div>` : ''}
      </div>
      <div class="p-4 bg-gray-50 border-t border-gray-100 flex justify-between items-center gap-3 rounded-b-2xl">
        <span class="text-xs font-bold text-gray-500 uppercase tracking-wider">Included in Plan</span>
        ${cta}
      </div>`;

    if (!opts.ctaHref && typeof opts.onCta === 'function') {
      body.querySelector('[data-detail-cta]').addEventListener('click', () => {
        close();
        opts.onCta(roleKey);
      });
    }

    modal.classList.remove('hidden');
    lockScroll();
  }

  window.AssistantDetailModal = { open, close };
})();
