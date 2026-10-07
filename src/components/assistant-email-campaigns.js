// src/components/assistant-email-campaigns.js
// Email Marketing Assistant ▸ Campaigns tab — every automatic email campaign (the welcome sequence
// and each campaign a sign-up form starts), with what it is doing and how it is performing.
//
// Why (2026-10-06): campaigns lived only inside the Email Studio's dialog, so the assistant's own
// page — where every other assistant shows its work moving through a lifecycle — had no sign of
// them at all. This lists them with status and the headline numbers, and each row opens that
// campaign in the Studio (window._newsletterInitialSequenceId, consumed by newsletter.js).
//
//   window.AssistantEmailCampaigns.init({ assistantId })  — fetch (counts feed the tab badge)
//   window.AssistantEmailCampaigns.activate()             — paint the panel
//
// Data: GET newsletter-sequences?summary=1 (campaignSummaries in newsletter-sequences.ts).
// Handlers are delegated on document, bound once — the panel re-renders on every load.
(function () {
  'use strict';
  const API = '/.netlify/functions/newsletter-sequences?summary=1';
  const state = { assistantId: null, campaigns: null, error: null };

  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pct = (v) => (v == null ? '—' : `${v}%`);
  const host = () => document.getElementById('email-campaigns-host');

  function setBadge() {
    // How many campaigns, on the label — the same "Name (n)" every other tab uses.
    window.AssistantDashboardRegistry?.setTabCount('email-campaigns-tab-label', 'Campaigns', (state.campaigns || []).length);
    // Amber count = campaigns that are written but switched off — the ones waiting on the owner.
    const b = document.getElementById('email-campaigns-badge');
    if (!b) return;
    const n = (state.campaigns || []).filter((c) => !c.isEnabled && c.steps > 0).length;
    b.textContent = n ? String(n) : '';
    b.classList.toggle('hidden', !n);
    b.style.display = n ? '' : 'none';
  }

  async function load() {
    try {
      const res = await fetch(API);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not load campaigns.');
      state.campaigns = d.campaigns || [];
      state.error = null;
    } catch (e) {
      state.campaigns = null;
      state.error = e.message;
    }
    setBadge();
  }

  function row(c) {
    const status = c.isEnabled
      ? '<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">On</span>'
      : c.steps > 0
        ? '<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">Off — ready to switch on</span>'
        : '<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">Off — no emails yet</span>';
    const kind = c.triggerEvent === 'subscribed' ? 'Everyone who subscribes' : 'People who fill in a linked sign-up form';
    const stat = (label, value) => `<div><p class="text-[11px] text-gray-500">${label}</p><p class="text-sm font-bold text-gray-900">${value}</p></div>`;
    return `<div class="p-4 sm:p-5">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap"><p class="font-bold text-gray-900">${esc(c.name)}</p>${status}</div>
          <p class="text-xs text-gray-500 mt-0.5">${kind} · ${c.steps} email${c.steps === 1 ? '' : 's'}</p>
        </div>
        <button type="button" data-email-campaign-open="${c.id}" class="btn-secondary shrink-0 px-3 py-1.5 text-xs font-bold border rounded-lg cursor-pointer">Open</button>
      </div>
      <div class="grid grid-cols-3 sm:grid-cols-6 gap-3 mt-3">
        ${stat('Enrolled', c.enrolled.toLocaleString())}
        ${stat('In progress', c.inProgress.toLocaleString())}
        ${stat('Emails sent', c.sent.toLocaleString())}
        ${stat('Open rate', pct(c.openRate))}
        ${stat('Click rate', pct(c.clickRate))}
        ${stat('Unsubscribed', `${c.unsubscribed.toLocaleString()}${c.unsubscribeRate != null ? ` · ${c.unsubscribeRate}%` : ''}`)}
      </div>
    </div>`;
  }

  function paint() {
    const h = host();
    if (!h) return;
    const head = `<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h2 class="text-lg font-extrabold text-gray-900">Email campaigns</h2>
          <p class="text-sm text-gray-500 mt-1">Series of emails that send by themselves when someone subscribes or fills in a sign-up form.</p>
        </div>
        <button type="button" data-email-campaign-new class="btn-assistant px-4 py-2 text-sm font-bold rounded-lg cursor-pointer">+ New email campaign</button>
      </div>`;
    if (state.error) { h.innerHTML = head + `<p class="text-sm text-red-600">${esc(state.error)}</p>`; return; }
    if (!state.campaigns) { h.innerHTML = head + '<p class="text-sm text-gray-400 py-10 text-center">Loading…</p>'; return; }
    h.innerHTML = head + (state.campaigns.length
      ? `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm divide-y divide-gray-100">${state.campaigns.map(row).join('')}</div>
         <p class="text-[11px] text-gray-500 mt-2">Open and click rates count emails sent through a verified sending domain; a connected mailbox cannot report them.</p>`
      : '<div class="bg-white rounded-2xl border border-gray-200 p-10 text-center text-sm text-gray-500">No campaigns yet. A welcome campaign for everyone who subscribes is the best first one — it greets everyone who joins your list.</div>');
  }

  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-email-campaign-open]');
    if (open) {
      window._newsletterInitialSequenceId = Number(open.getAttribute('data-email-campaign-open'));
      window._newsletterAssistantId = state.assistantId;
      window.loadView?.('newsletter');
      return;
    }
    if (e.target.closest('[data-email-campaign-new]')) {
      window._newsletterOpenNewCampaign = true;
      window._newsletterAssistantId = state.assistantId;
      window.loadView?.('newsletter');
    }
  });

  window.AssistantEmailCampaigns = {
    async init({ assistantId } = {}) {
      state.assistantId = assistantId || null;
      state.campaigns = null;
      await load();
      // The panel may already be open (a deep link straight to the tab).
      if (!document.getElementById('maintab-email-campaigns')?.classList.contains('hidden')) paint();
      // The Review column (this role's landing tab) may have drawn before this list arrived — and
      // it carries the "written but switched off" note. Redraw it once, only when there is a note.
      const reviewOpen = !document.getElementById('maintab-review-queue')?.classList.contains('hidden');
      if (this.waiting().length && reviewOpen && typeof window.detailRqOpenStatus === 'function'
          && document.querySelector('.detail-rq-col[data-status="review"]')?.classList.contains('border-emerald-600')) {
        window.detailRqOpenStatus('review');
      }
    },
    async activate() {
      paint();
      await load();
      paint();
    },
    /** For the Review column's "written but switched off" note. */
    waiting() { return (state.campaigns || []).filter((c) => !c.isEnabled && c.steps > 0); },
  };
})();
