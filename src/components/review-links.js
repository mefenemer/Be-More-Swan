// src/components/review-links.js
// The subscriber's side of a guest review link (docs/review-link-plan.md, src/utils/review-links.ts):
//   • ReviewLinks.paint(postId, el)  the "Share for review" panel in the post review pop-up
//   • [data-review-status] chips     "Sarah approved" on the Review Queue's cards
//   • ReviewLinks.shareCard(...)     the chat card's click, on the same endpoint
//
// Handlers are bound once on `document`, never from a render path. A guest's name and comment are
// untrusted, so they are always escaped. Responses never act on a post: Use these comments only
// fills the subscriber's own "What should I change?" box, and they press Regenerate themselves. The
// comment stays (on the redraft too) until they choose Mark as done or Ignore.
(function () {
  'use strict';

  const FN = '/.netlify/functions/review-link';
  const esc = (s) => (window.escapeHtml ? window.escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));
  const toast = (msg, warn) => window.showToast?.(msg, warn ? { icon: '⚠️' } : undefined);
  /** The feedback box's own limit (maxlength on #post-review-feedback). */
  const FEEDBACK_MAX = 500;
  const DECISION_WORDS = { approved: 'approved', changes: 'asked for changes', comment: 'left a comment' };

  let paintedPostId = null;
  let paintedEl = null;
  let lastCreated = null; // { postId, url, emailed }
  const commentsById = new Map();

  async function postJson(body) {
    const res = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'That did not work. Please try again.');
    return data;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Link copied.'); return true; }
    catch { toast('Could not copy. Select the link and copy it yourself.', true); return false; }
  }

  function createdHtml(created) {
    return `<div class="rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2">
      <p class="font-semibold text-gray-900">${created.emailed ? 'Email sent. You can also share this link.' : 'Your link is ready. This is the only time it is shown.'}</p>
      <input type="text" readonly value="${esc(created.url)}" aria-label="Review link" class="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs">
      <button type="button" data-rl-copy="${esc(created.url)}" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg">Copy link</button>
    </div>`;
  }

  function formHtml() {
    return `<div data-rl-form class="hidden rounded-lg border border-gray-200 p-3 space-y-2">
      <p class="text-gray-600">Anyone with the link can see this post and respond, with no account. Their response is only a sign-off: nothing is posted until you approve it. The link lasts 30 days.</p>
      <label class="block font-semibold text-gray-700">Who's it for? <span class="font-normal text-gray-500">(optional, only you see this)</span>
        <input type="text" data-rl-label maxlength="80" class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-xs font-normal">
      </label>
      <label class="block font-semibold text-gray-700">Email it to <span class="font-normal text-gray-500">(optional)</span>
        <input type="email" data-rl-email maxlength="200" class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-xs font-normal">
      </label>
      <button type="button" data-rl-create class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg">Create link</button>
    </div>`;
  }

  const RESOLVED_WORDS = { done: 'Marked as done', ignored: 'Ignored' };

  // A comment stays here after it is used to redraft (the redraft follows it, src/utils/review-links.ts
  // revisionAncestors): only the subscriber's own Mark as done or Ignore puts it away, and Undo brings it back.
  function responseHtml(r) {
    if (r.body) commentsById.set(String(r.id), r.body);
    const head = `<p><span class="font-semibold text-gray-900">${esc(r.guestName)}</span> ${esc(DECISION_WORDS[r.decision] || 'responded')}${r.changedSince ? ' <span class="text-amber-800 font-semibold">· Changed since this response</span>' : ''}</p>`;
    if (r.resolution && RESOLVED_WORDS[r.resolution]) {
      return `<div class="mt-2 border-l-2 border-gray-200 pl-2 text-gray-500" data-rl-response="${esc(r.id)}">
        ${head}
        ${r.body ? `<p class="whitespace-pre-wrap break-words line-through decoration-gray-300">${esc(r.body)}</p>` : ''}
        <p class="mt-1 text-xs">${RESOLVED_WORDS[r.resolution]} · <button type="button" data-rl-resolve="${esc(r.id)}" data-rl-resolution="" class="font-semibold underline cursor-pointer">Undo</button></p>
      </div>`;
    }
    return `<div class="mt-2 border-l-2 border-gray-200 pl-2" data-rl-response="${esc(r.id)}">
      ${head}
      ${r.body ? `<p class="text-gray-700 whitespace-pre-wrap break-words">${esc(r.body)}</p>` : ''}
      <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
        ${r.body ? `<button type="button" data-rl-use="${esc(r.id)}" class="font-semibold underline cursor-pointer">Use these comments</button>` : ''}
        <button type="button" data-rl-resolve="${esc(r.id)}" data-rl-resolution="done" class="font-semibold underline cursor-pointer">Mark as done</button>
        <button type="button" data-rl-resolve="${esc(r.id)}" data-rl-resolution="ignored" class="font-semibold text-gray-500 underline cursor-pointer">Ignore</button>
      </div>
    </div>`;
  }

  function linkHtml(l) {
    const state = l.state === 'revoked' ? 'Revoked' : l.state === 'expired' ? 'Expired' : l.viewed ? 'Viewed' : 'Shared';
    return `<div class="rounded-lg border border-gray-200 p-2">
      <div class="flex items-center justify-between gap-2">
        <p class="min-w-0 truncate"><span class="font-semibold text-gray-900">${esc(l.label || 'Review link')}</span> <span class="text-gray-500">· ${state}</span></p>
        ${l.state === 'live' ? `<button type="button" data-rl-revoke="${esc(l.id)}" class="shrink-0 text-xs font-semibold text-red-700 underline cursor-pointer">Revoke</button>` : ''}
      </div>
      ${l.responses.map(responseHtml).join('')}
    </div>`;
  }

  async function paint(postId, el) {
    if (!el) return;
    paintedPostId = postId;
    paintedEl = el;
    let links = [];
    try {
      const res = await fetch(`${FN}?postId=${encodeURIComponent(postId)}`);
      if (res.ok) links = (await res.json()).links || [];
    } catch { /* The panel still offers sharing without its list. */ }
    if (paintedPostId !== postId) return; // They moved to another post while this loaded.
    const created = lastCreated && lastCreated.postId === postId ? lastCreated : null;
    el.innerHTML = `<div class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <p class="font-bold text-gray-900">Get someone's thoughts</p>
        <button type="button" data-rl-open class="btn-secondary px-3 py-1.5 text-xs font-bold rounded-lg">Share for review</button>
      </div>
      ${created ? createdHtml(created) : ''}
      ${formHtml()}
      ${links.map(linkHtml).join('')}
    </div>`;
    el.classList.remove('hidden');
  }

  async function create(btn) {
    const form = btn.closest('[data-rl-form]');
    const postId = paintedPostId;
    btn.disabled = true;
    try {
      const data = await postJson({
        action: 'create', postId,
        label: form.querySelector('[data-rl-label]').value,
        email: form.querySelector('[data-rl-email]').value,
      });
      lastCreated = { postId, url: data.url, emailed: !!data.emailed };
      await paint(postId, paintedEl);
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
  }

  function useComments(id) {
    const text = commentsById.get(String(id)) || '';
    document.getElementById('post-review-actions')?.classList.remove('hidden');
    window.rqReviewToggle?.('changes');
    const box = document.getElementById('post-review-feedback');
    if (!box) return;
    box.value = text.slice(0, FEEDBACK_MAX);
    box.focus();
    box.scrollIntoView({ block: 'nearest' });
  }

  /** The chat card's button: the same endpoint as the panel, and only on the user's click. */
  // `target` is a post id, or { videoProjectId } for a finished Video Producer video (video-review-links.ts).
  async function shareCard(target, wrap) {
    const btn = wrap.querySelector('[data-rl-card-create]');
    btn.disabled = true;
    try {
      const data = await postJson({
        action: 'create', ...(target && typeof target === 'object' ? { videoProjectId: Number(target.videoProjectId) } : { postId: target }),
        label: wrap.querySelector('[data-rl-label]').value,
        email: wrap.querySelector('[data-rl-email]').value,
      });
      wrap.querySelector('[data-rl-card-form]').classList.add('hidden');
      const out = wrap.querySelector('[data-rl-card-result]');
      out.innerHTML = createdHtml({ url: data.url, emailed: !!data.emailed });
      out.classList.remove('hidden');
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
  }

  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest('[data-rl-open]')) {
      t.closest('[data-rl-open]').parentElement.parentElement.querySelector('[data-rl-form]')?.classList.toggle('hidden');
    } else if (t.closest('[data-rl-create]')) {
      create(t.closest('[data-rl-create]'));
    } else if (t.closest('[data-rl-copy]')) {
      copy(t.closest('[data-rl-copy]').getAttribute('data-rl-copy'));
    } else if (t.closest('[data-rl-use]')) {
      useComments(t.closest('[data-rl-use]').getAttribute('data-rl-use'));
    } else if (t.closest('[data-rl-resolve]')) {
      const btn = t.closest('[data-rl-resolve]');
      btn.disabled = true;
      postJson({ action: 'resolve', responseId: Number(btn.getAttribute('data-rl-resolve')), resolution: btn.getAttribute('data-rl-resolution') || null })
        .then(() => paint(paintedPostId, paintedEl))
        .catch((err) => { btn.disabled = false; toast(err.message, true); });
    } else if (t.closest('[data-rl-revoke]')) {
      const id = Number(t.closest('[data-rl-revoke]').getAttribute('data-rl-revoke'));
      window.confirmModal?.('Revoke this link? Anyone who has it will no longer be able to open it.', { danger: true }).then((ok) => {
        if (!ok) return;
        postJson({ action: 'revoke', linkId: id })
          .then(() => paint(paintedPostId, paintedEl))
          .catch((err) => toast(err.message, true));
      });
    }
  });

  // ── Chips on the Review Queue's cards ──────────────────────────────────────
  // Cards are repainted by many paths, so this watches for chips that have not been filled yet rather
  // than asking every render path to remember to call it.
  let chipTimer = null;
  async function fillChips() {
    const chips = [...document.querySelectorAll('[data-review-status]:not([data-rl-done])')];
    if (!chips.length) return;
    chips.forEach((c) => c.setAttribute('data-rl-done', '1'));
    const idsOf = (c) => c.getAttribute('data-review-status').split(',').map(Number).filter(Boolean);
    const ids = [...new Set(chips.flatMap(idsOf))].slice(0, 200);
    if (!ids.length) return;
    let statuses = {};
    try {
      const res = await fetch(`${FN}?postIds=${ids.join(',')}`);
      if (res.ok) statuses = (await res.json()).statuses || {};
    } catch { return; }
    chips.forEach((chip) => {
      const found = idsOf(chip).map((id) => statuses[id]).filter(Boolean)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
      if (!found) return;
      chip.textContent = found.label;
      chip.classList.remove('hidden');
    });
  }
  function watchChips() {
    new MutationObserver(() => {
      clearTimeout(chipTimer);
      chipTimer = setTimeout(fillChips, 150);
    }).observe(document.body, { childList: true, subtree: true });
    fillChips();
  }
  if (document.body) watchChips();
  else document.addEventListener('DOMContentLoaded', watchChips);

  window.ReviewLinks = { paint, shareCard };
})();
