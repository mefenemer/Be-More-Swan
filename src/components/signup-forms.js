// src/components/signup-forms.js — the list of sign-up forms.
//
//   window.SignupForms.open()
//
// ONE dialog, opened IN PLACE from wherever the person is — the Audience page and the Email Studio
// both call it. It used to live inside audience.html, so the Studio's button had to navigate to the
// Audience page to show it, and closing it left the person somewhere they never asked to go.
//
// It is a LIST, deliberately. Everything about one form — its questions, its look, the code for a
// website, its own page, the consent wording, confirm-by-email, which segment, which email campaign —
// belongs to THAT form and lives in its builder (form-builder.js). The previous dialog showed one
// form's settings under the list as though they applied to the whole page.
//
// Attached to <body> and bound once by delegation, for the same reasons as the builder.
(function () {
  'use strict';

  const FORMS_API = '/.netlify/functions/audience-forms';
  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const $ = (id) => document.getElementById(id);
  let forms = [];

  function show(el, d) { if (el) { el.classList.remove('hidden'); el.style.display = d || 'block'; } }
  function hide(el) { if (el) { el.classList.add('hidden'); el.style.display = 'none'; } }

  /** The page we host for a form — its chosen address if it has one, its permanent key otherwise. */
  function pageUrl(f) {
    const slug = f.definition && f.definition.delivery && f.definition.delivery.hosted && f.definition.delivery.hosted.slug;
    return slug ? `${location.origin}/f/${slug}` : `${location.origin}/s/${f.publicKey}`;
  }
  function websiteCode(f) {
    return `<div id="bms-subscribe"></div>\n<script async src="${location.origin}/subscribe.js"\n        data-bms-form="${f.publicKey}" data-bms-mount="#bms-subscribe"><\/script>`;
  }

  function ensureModal() {
    if ($('sf-modal')) return;
    const m = document.createElement('div');
    m.id = 'sf-modal';
    m.className = 'hidden fixed inset-0 z-50 items-center justify-center p-4';
    m.style.display = 'none';
    m.innerHTML = `
      <div class="absolute inset-0 bg-black/40" data-sf-close></div>
      <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-6 max-h-[90vh] overflow-auto">
        <div class="flex items-start justify-between mb-1">
          <h2 class="text-lg font-extrabold text-gray-900">Sign-up forms</h2>
          <button type="button" data-sf-close aria-label="Close" class="p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 cursor-pointer">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <p class="text-sm text-gray-500 mb-5">The forms people fill in to join your audience. Each one can sit on your website, have its own page to share from a bio or a QR code, or both — and it can start an email campaign. Open a form to change its questions, its look, where it appears and what happens after someone signs up.</p>
        <div id="sf-list"></div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', onClick);
    document.addEventListener('keydown', (e) => {
      // The builder sits on top of this list and owns Escape while it is open.
      const builder = $('fb-modal');
      if (e.key === 'Escape' && !m.classList.contains('hidden') && (!builder || builder.classList.contains('hidden'))) hide(m);
    });
  }

  async function open() {
    ensureModal();
    show($('sf-modal'), 'flex');
    await load();
  }

  async function load() {
    const host = $('sf-list');
    host.innerHTML = '<p class="text-sm text-gray-500">Loading…</p>';
    try {
      const res = await fetch(FORMS_API, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not load your forms (HTTP ${res.status}).`);
      if (data.needsSetup) {
        host.innerHTML = '<p class="text-sm text-gray-600">Sign-up forms are not set up on this environment yet.</p>';
        return;
      }
      forms = data.forms || [];
      render();
    } catch (err) {
      host.innerHTML = `<p class="text-sm text-red-600">${esc(err.message)}</p>`;
    }
  }

  function render() {
    const host = $('sf-list');
    if (!forms.length) {
      host.innerHTML = `
        <div class="text-center py-8">
          <p class="text-sm text-gray-600 mb-4">You do not have a sign-up form yet.</p>
          <button type="button" data-sf-new class="px-4 py-2 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Create a sign-up form</button>
        </div>`;
      return;
    }
    host.innerHTML = forms.map((f) => {
      const d = f.definition || {};
      const embed = !d.delivery || !d.delivery.embed || d.delivery.embed.enabled !== false;
      const hosted = !!(d.delivery && d.delivery.hosted && d.delivery.hosted.enabled);
      const live = f.status === 'active';
      const where = [embed ? 'On your website' : '', hosted ? 'Its own page' : ''].filter(Boolean).join(' · ') || 'Nowhere yet';
      const st = f.stats || { submissions: 0, subscribed: 0, last30: 0 };
      return `
      <div class="rounded-xl border border-gray-200 p-4 mb-2">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-bold text-gray-900 truncate">${esc(f.name)}
              <span class="ml-1 inline-flex px-2 py-0.5 text-[11px] font-bold rounded-full border ${live ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 'bg-gray-100 text-gray-600 border-gray-200'}">${live ? 'Live' : 'Off'}</span></p>
            <p class="text-[11px] text-gray-500">${esc(where)} · ${esc(String((d.fields || []).length || 1))} question${(d.fields || []).length === 1 ? '' : 's'}</p>
            <p class="text-[11px] text-gray-500">${esc(String(st.submissions))} sign-up${st.submissions === 1 ? '' : 's'} · ${esc(String(st.subscribed))} subscribed now · ${esc(String(st.last30))} in the last 30 days</p>
          </div>
          <button type="button" data-sf-open="${f.id}" class="shrink-0 px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer">Open</button>
        </div>
        <div class="flex flex-wrap gap-2 mt-3">
          ${hosted ? `<button type="button" data-sf-copy="page" data-id="${f.id}" class="px-3 py-1.5 text-xs font-bold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 cursor-pointer">Copy page link</button>
                     <a href="${esc(pageUrl(f))}" target="_blank" rel="noopener" class="px-3 py-1.5 text-xs font-bold text-emerald-700 hover:text-emerald-800">Open page ↗</a>` : ''}
          ${embed ? `<button type="button" data-sf-copy="code" data-id="${f.id}" title="Paste it into your website where the form should appear" class="px-3 py-1.5 text-xs font-bold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 cursor-pointer">Copy website code</button>` : ''}
        </div>
      </div>`;
    }).join('') + '<button type="button" data-sf-new class="mt-2 text-xs font-bold text-emerald-700 hover:underline cursor-pointer">+ New form</button>';
  }

  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); window.showToast?.(`${what} copied.`); }
    catch { window.prompt(`Copy the ${what.toLowerCase()}:`, text); }
  }

  function openBuilder(form) {
    if (!window.FormBuilder) { window.showToast?.('The form builder did not load — refresh the page and try again.'); return; }
    window.FormBuilder.open({ form, onSaved: () => load() });
  }

  function onClick(e) {
    const t = e.target;
    if (t.closest('[data-sf-close]')) { hide($('sf-modal')); return; }
    if (t.closest('[data-sf-new]')) { openBuilder(null); return; }
    const o = t.closest('[data-sf-open]');
    if (o) { openBuilder(forms.find((f) => String(f.id) === o.getAttribute('data-sf-open')) || null); return; }
    const c = t.closest('[data-sf-copy]');
    if (c) {
      const f = forms.find((x) => String(x.id) === c.getAttribute('data-id'));
      if (!f) return;
      if (c.getAttribute('data-sf-copy') === 'page') copy(pageUrl(f), 'Page link');
      else copy(websiteCode(f), 'Website code');
    }
  }

  window.SignupForms = { open };
})();
