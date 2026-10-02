// Shared UI dialogs: the toast, the styled stand-ins for the browser's alert(), confirm() and
// prompt(), and `choiceModal` for a question with more than two answers.
// Every page that reports an error or asks a question loads this — before it existed
// these lived inside workspace.html, so any other page calling window.showToast?.() reported
// NOTHING, and anything that had to ask fell back to the browser's own grey box.
//
// Inline styles on purpose: arbitrary Tailwind classes aren't in the prebuilt style.css, so a
// class added here would silently no-op.

/**
 * Escape text for the dialog bodies below, which are written as HTML.
 *
 * Shipped here because the dialogs are: workspace.html has its own `_rqEsc`, but every other page
 * that loads this file has nothing, and "no escape function to hand" is how a server-supplied
 * error message ends up interpreted as markup.
 */
window.escapeHtml = function (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

// Lightweight, dependency-free toast. Inline styles on purpose: arbitrary
// Tailwind classes aren't in the prebuilt style.css, so they'd no-op here.
window.showToast = function (message, opts = {}) {
  let container = document.getElementById('aura-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'aura-toast-container';
    container.style.cssText = 'position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);z-index:11000;display:flex;flex-direction:column;gap:.5rem;align-items:center;pointer-events:none;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.setAttribute('role', 'status');
  toast.style.cssText = 'pointer-events:auto;max-width:90vw;background:#1f2937;color:#fff;padding:.75rem 1rem;border-radius:.75rem;box-shadow:0 10px 25px rgba(0,0,0,.18);font-size:.875rem;font-weight:500;display:flex;align-items:center;gap:.5rem;opacity:0;transform:translateY(.5rem);transition:opacity .2s ease,transform .2s ease;';
  const icon = document.createElement('span');
  icon.textContent = opts.icon || '🔒';
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(icon, text);
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(.5rem)';
    setTimeout(() => toast.remove(), 250);
  }, opts.duration || 4000);
};

// ── US3: destructive confirm modal + draft cancellation ──────────────
// Generic confirm modal (inline styles — arbitrary Tailwind classes aren't in the prebuilt CSS).
window.showConfirmModal = function(message, onConfirm, opts = {}) {
  document.getElementById('aura-confirm-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'aura-confirm-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:11500;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:1rem;';
  // Neutral defaults. They used to read "Cancel setup?" / "Yes, delete draft" / "Keep editing",
  // from the one flow this was written for — so every later caller that passed no labels offered
  // to delete a draft regardless of what it was actually asking. Callers name their own verbs.
  const title   = opts.title   || 'Are you sure?';
  const confirm = opts.confirmLabel || 'Confirm';
  const cancel  = opts.cancelLabel  || 'Cancel';
  const confirmBg = opts.confirmColor || '#dc2626';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:1rem;max-width:24rem;width:100%;padding:1.5rem;box-shadow:0 20px 50px rgba(0,0,0,.25);">
      <h3 style="font-size:1.05rem;font-weight:700;color:#111827;margin:0 0 ${message ? '.5rem' : '1.25rem'};">${title}</h3>
      ${message ? `<p style="font-size:.875rem;color:#4b5563;margin:0 0 1.25rem;line-height:1.5;">${message}</p>` : ''}
      <div style="display:flex;gap:.5rem;justify-content:flex-end;">
        ${opts.hideCancel ? '' : `<button id="acm-cancel" style="cursor:pointer;font-size:.875rem;font-weight:600;color:#374151;background:#fff;border:1px solid #d1d5db;padding:.5rem .9rem;border-radius:.6rem;">${cancel}</button>`}
        <button id="acm-confirm" style="cursor:pointer;font-size:.875rem;font-weight:600;color:#fff;background:${confirmBg};border:none;padding:.5rem .9rem;border-radius:.6rem;">${confirm}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  // Escape cancels and the cancel button holds focus. This stands in for a browser confirm(),
  // so the keyboard has to behave like one. Captured and stopped so the Escape that dismisses
  // this dialog cannot also reach whatever it is sitting on top of.
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
  const close = (cancelled) => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (cancelled && opts.onCancel) opts.onCancel();
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(true); });
  overlay.querySelector('#acm-cancel')?.addEventListener('click', () => close(true));
  overlay.querySelector('#acm-confirm').addEventListener('click', async () => { close(false); await onConfirm(); });
  // Cancel holds focus where there is one — on a destructive question the safe answer should be
  // the one under the return key. A single-button dialog has only the one place to put it.
  (overlay.querySelector('#acm-cancel') || overlay.querySelector('#acm-confirm')).focus();
};

/**
 * showConfirmModal as a promise, for async flows that need the answer inline — exactly where a
 * browser confirm() used to sit. Resolves false on cancel, Escape or a click on the backdrop.
 * `message` is written as HTML (it is innerHTML'd), so escape anything user- or data-derived.
 */
window.confirmModal = function(message, opts = {}) {
  return new Promise((resolve) => {
    window.showConfirmModal(message, () => resolve(true), { ...opts, onCancel: () => resolve(false) });
  });
};

/**
 * One-button dialog — the styled stand-in for alert(), for a message with too much in it to fit
 * a toast (several sentences, or a paragraph break). A one-line error is still a toast.
 */
window.alertModal = function(message, opts = {}) {
  return new Promise((resolve) => {
    window.showConfirmModal(message, () => resolve(), {
      confirmLabel: 'OK',
      confirmColor: '#059669',
      ...opts,
      hideCancel: true,
      onCancel: () => resolve(),
    });
  });
};

/**
 * A question with more than two answers — the dialog `confirmModal` cannot be.
 *
 * `options` is `[{ value, label, description? }, …]`, rendered as a stacked list of buttons, and
 * the promise resolves the chosen `value`. Backing out — the cancel button, Escape, or the
 * backdrop — resolves null, so a caller reads it exactly like `confirmModal` returning false.
 *
 * Why it exists: "connect Gmail or Outlook, or neither?" is three answers, and squeezing it into a
 * confirm makes one of the two real choices the CANCEL button — which Escape and a stray backdrop
 * click would then pick on the user's behalf. `message`, labels and descriptions are innerHTML'd,
 * so escape anything data-derived.
 */
window.choiceModal = function(message, options, opts = {}) {
  return new Promise((resolve) => {
    document.getElementById('aura-confirm-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'aura-confirm-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:11500;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:1rem;';
    const title = opts.title || 'Choose one';
    const cancel = opts.cancelLabel || 'Cancel';
    const btnCss = 'display:block;width:100%;box-sizing:border-box;text-align:left;cursor:pointer;background:#fff;border:1px solid #d1d5db;border-radius:.6rem;padding:.7rem .9rem;margin:0 0 .5rem;font-family:inherit;';
    overlay.innerHTML = `
    <div style="background:#fff;border-radius:1rem;max-width:26rem;width:100%;padding:1.5rem;box-shadow:0 20px 50px rgba(0,0,0,.25);">
      <h3 style="font-size:1.05rem;font-weight:700;color:#111827;margin:0 0 .5rem;">${title}</h3>
      ${message ? `<p style="font-size:.875rem;color:#4b5563;margin:0 0 .85rem;line-height:1.5;">${message}</p>` : ''}
      <div id="achm-options">
        ${(options || []).map((o, i) => `
          <button type="button" data-achm-index="${i}" style="${btnCss}">
            <span style="display:block;font-size:.875rem;font-weight:700;color:#111827;">${o.label}</span>
            ${o.description ? `<span style="display:block;font-size:.8125rem;color:#6b7280;margin-top:.15rem;">${o.description}</span>` : ''}
          </button>`).join('')}
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:.75rem;">
        <button id="achm-cancel" style="cursor:pointer;font-size:.875rem;font-weight:600;color:#374151;background:#fff;border:1px solid #d1d5db;padding:.5rem .9rem;border-radius:.6rem;">${cancel}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    const done = (value) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    overlay.querySelector('#achm-cancel').addEventListener('click', () => done(null));
    overlay.querySelector('#achm-options').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-achm-index]');
      if (btn) done((options[Number(btn.getAttribute('data-achm-index'))] || {}).value ?? null);
    });
    // Cancel holds focus for the same reason it does on the confirm dialog: the answer under the
    // return key should be the one that changes nothing.
    overlay.querySelector('#achm-cancel').focus();
  });
};

/**
 * The same dialog with a text box in it — the styled stand-in for prompt().
 *
 * Resolves the text that was entered, or null when the user backs out, so a call site that
 * tested `=== null` for "cancelled" reads exactly as it did against the browser's own prompt.
 * With `required`, the confirm button stays disabled until something is typed; `multiline`
 * swaps the input for a textarea. `message` is innerHTML'd — escape data-derived text.
 */
window.promptModal = function(message, opts = {}) {
  return new Promise((resolve) => {
    document.getElementById('aura-confirm-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'aura-confirm-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:11500;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:1rem;';
    const title   = opts.title || 'Add a note';
    const confirm = opts.confirmLabel || 'Save';
    const cancel  = opts.cancelLabel  || 'Cancel';
    const fieldCss = 'width:100%;box-sizing:border-box;font-size:.875rem;color:#111827;background:#fff;border:1px solid #d1d5db;border-radius:.6rem;padding:.5rem .7rem;margin:0 0 1.25rem;font-family:inherit;';
    const field = opts.multiline
      ? `<textarea id="apm-input" rows="3" placeholder="${String(opts.placeholder || '').replace(/"/g, '&quot;')}" style="${fieldCss}resize:vertical;"></textarea>`
      : `<input id="apm-input" type="text" placeholder="${String(opts.placeholder || '').replace(/"/g, '&quot;')}" style="${fieldCss}">`;
    overlay.innerHTML = `
    <div style="background:#fff;border-radius:1rem;max-width:26rem;width:100%;padding:1.5rem;box-shadow:0 20px 50px rgba(0,0,0,.25);">
      <h3 style="font-size:1.05rem;font-weight:700;color:#111827;margin:0 0 .5rem;">${title}</h3>
      <p style="font-size:.875rem;color:#4b5563;margin:0 0 .85rem;line-height:1.5;">${message}</p>
      ${field}
      <div style="display:flex;gap:.5rem;justify-content:flex-end;">
        <button id="apm-cancel" style="cursor:pointer;font-size:.875rem;font-weight:600;color:#374151;background:#fff;border:1px solid #d1d5db;padding:.5rem .9rem;border-radius:.6rem;">${cancel}</button>
        <button id="apm-confirm" style="cursor:pointer;font-size:.875rem;font-weight:600;color:#fff;background:#059669;border:none;padding:.5rem .9rem;border-radius:.6rem;">${confirm}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#apm-input');
    const okBtn = overlay.querySelector('#apm-confirm');
    input.value = opts.value || '';
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    const done = (value) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    // Required means the button is unavailable rather than available-and-then-scolding.
    const sync = () => {
      const empty = opts.required && !input.value.trim();
      okBtn.disabled = !!empty;
      okBtn.style.opacity = empty ? '.45' : '';
      okBtn.style.cursor = empty ? 'not-allowed' : 'pointer';
    };
    input.addEventListener('input', sync);
    sync();

    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    overlay.querySelector('#apm-cancel').addEventListener('click', () => done(null));
    okBtn.addEventListener('click', () => { if (!okBtn.disabled) done(input.value); });
    // Enter submits a single-line box, as it would in a browser prompt. A textarea keeps Enter
    // for new lines — the note fields here are the reason it is a textarea in the first place.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !opts.multiline && !okBtn.disabled) { e.preventDefault(); done(input.value); }
    });
    input.focus();
  });
};

// ── The busy indicator ───────────────────────────────────────────────────────────────────────
// ONE "this is working, wait" signal for the whole product: the pink rotating circle the detail
// page's cards show while they load (.card-loading-spinner in assistant-detail.html). It replaces
// the browser's wait/progress mouse cursor, which was easy to miss, invisible on touch screens and
// not part of the brand.
//
// `window.bmsBusy(true|false)` is refcounted — two overlapping operations must not have the first
// to finish clear the indicator out from under the second — and shows nothing for the first 150ms,
// so a quick action doesn't flash it. `window.bmsWithBusy(fn)` wraps an async fn and clears it in a
// `finally`, so an error cannot strand it on screen. `window.bmsSpinnerHtml(px)` is the same circle
// inline, for a button or a panel. `pointer-events:none`: it signals, it never blocks a click.
(function () {
  var STYLE_ID = 'bms-busy-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent =
      '.bms-spinner{display:inline-block;box-sizing:border-box;border-radius:9999px;border:3px solid #eae4d7;border-top-color:#ff007f;animation:bmsSpin .7s linear infinite;vertical-align:middle;flex-shrink:0;}'
      + '@keyframes bmsSpin{to{transform:rotate(360deg);}}'
      + '@media (prefers-reduced-motion: reduce){.bms-spinner{animation-duration:1.6s;}}'
      + '#bms-busy-indicator{position:fixed;left:50%;top:50%;z-index:12000;pointer-events:none;display:flex;align-items:center;justify-content:center;'
      + 'width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:9999px;background:rgba(255,255,255,.92);box-shadow:0 10px 30px rgba(0,0,0,.12);'
      + 'opacity:0;transition:opacity .15s ease;}'
      + '#bms-busy-indicator.is-on{opacity:1;}';
    (document.head || document.documentElement).appendChild(st);
  }

  window.bmsSpinnerHtml = function (px) {
    ensureStyles();
    var s = Number(px) || 16;
    var b = s <= 16 ? 2 : 3;
    return '<span class="bms-spinner" role="status" aria-label="Loading" style="width:' + s + 'px;height:' + s + 'px;border-width:' + b + 'px;"></span>';
  };

  var depth = 0;
  var showTimer = null;
  function indicator() {
    var el = document.getElementById('bms-busy-indicator');
    if (!el && document.body) {
      ensureStyles();
      el = document.createElement('div');
      el.id = 'bms-busy-indicator';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.innerHTML = '<span class="bms-spinner" style="width:30px;height:30px;"></span><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);">Loading…</span>';
      document.body.appendChild(el);
    }
    return el;
  }

  window.bmsBusy = function (on) {
    depth = Math.max(0, depth + (on ? 1 : -1));
    if (depth > 0) {
      if (showTimer || indicator()?.classList.contains('is-on')) return;
      showTimer = setTimeout(function () {
        showTimer = null;
        if (depth > 0) indicator()?.classList.add('is-on');
      }, 150);
    } else {
      if (showTimer) { clearTimeout(showTimer); showTimer = null; }
      var el = document.getElementById('bms-busy-indicator');
      if (el) el.classList.remove('is-on');
    }
  };

  window.bmsWithBusy = async function (fn) {
    window.bmsBusy(true);
    try { return await fn(); }
    finally { window.bmsBusy(false); }
  };

  // ── "Loading…" placeholders get the spinner too ────────────────────────────────────────────
  // ~150 panels, tables and lists across the product say "Loading…" (or "Loading assistants…")
  // while they fetch, as bare grey text. Rather than hand-edit each, any element whose ONLY content
  // is such a phrase gets the pink circle in front of it — including ones rendered later through
  // innerHTML, via the observer. Leaf elements only (never a control: an <option>, a button's
  // "Checking…"), marked so a re-check never adds a second circle; when the content arrives the
  // placeholder is replaced wholesale and the circle goes with it.
  var LOADING_RE = /^(loading|fetching)\b[^<>]{0,50}(…|\.\.\.)$/i;
  var SKIP = { OPTION: 1, SELECT: 1, BUTTON: 1, TEXTAREA: 1, INPUT: 1, SCRIPT: 1, STYLE: 1, TITLE: 1, A: 1, LABEL: 1 };
  function decorate(el) {
    if (!el || el.nodeType !== 1 || SKIP[el.tagName]) return;
    if (el.hasAttribute('data-bms-spun')) {
      if (el.firstElementChild && el.firstElementChild.classList.contains('bms-spinner')) return;
      el.removeAttribute('data-bms-spun'); // its content was rewritten since — judge it afresh
    }
    if (el.childElementCount !== 0) return;
    var t = (el.textContent || '').trim();
    if (!t || !LOADING_RE.test(t)) return;
    if (el.closest('button, a, select, [data-no-spinner]')) return;
    el.setAttribute('data-bms-spun', '');
    var sp = document.createElement('span');
    sp.className = 'bms-spinner';
    sp.setAttribute('aria-hidden', 'true');
    sp.style.cssText = 'width:16px;height:16px;border-width:2px;margin-right:8px;';
    el.insertBefore(sp, el.firstChild);
  }
  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    decorate(root);
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) decorate(all[i]);
  }
  function startPlaceholderSpinners() {
    if (!document.body) return;
    ensureStyles();
    scan(document.body);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        // A textContent write ("Loading…") replaces the text node: the target is the element.
        if (r.target && r.target.nodeType === 1) decorate(r.target);
        else if (r.target && r.target.parentElement) decorate(r.target.parentElement);
        for (var j = 0; j < r.addedNodes.length; j++) {
          var n = r.addedNodes[j];
          if (n.nodeType === 1) scan(n);
        }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startPlaceholderSpinners);
  else startPlaceholderSpinners();
})();
