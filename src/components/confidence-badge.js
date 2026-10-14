/**
 * src/components/confidence-badge.js
 *
 * US-AUD-2.1.1: AI Confidence Indicator — client-side badge renderer.
 *
 * Include this script on any page that displays assistant outputs.
 * Call window.renderConfidenceBadge(container, level, verifyHint) to inject the badge.
 *
 * SC1:  3 badge levels — green / amber / red
 * SC2:  AMBER includes a verify hint (generated server-side by the LLM)
 * SC3:  RED shows a non-dismissable warning; Copy/Approve buttons require confirmation
 * SC4:  GREEN — no additional UI
 * SC6:  Informational only — never blocks the user from using the output
 */
(function () {
  /**
   * Render a confidence badge into `container`.
   *
   * @param {HTMLElement} container  - Element to inject the badge into
   * @param {'green'|'amber'|'red'} level
   * @param {string|null} verifyHint - AMBER/RED: what to verify
   */
  window.renderConfidenceBadge = function (container, level, verifyHint) {
    if (!container) return;

    let html = '';

    if (level === 'green') {
      // SC4: no extra prompt
      html = `
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"
              title="AI self-assessed: high confidence">
          ✅ Looks good
        </span>`;

    } else if (level === 'amber') {
      // SC2: include verifyHint
      const hint = verifyHint
        ? `<p class="mt-1 text-xs text-amber-700"><strong>You should verify:</strong> ${verifyHint}</p>`
        : '';
      html = `
        <div class="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 mb-2">
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 border border-amber-200">
            ⚠️ Review recommended
          </span>
          ${hint}
        </div>`;

    } else if (level === 'red') {
      // SC3: non-dismissable warning; Copy/Approve require click-through
      const hint = verifyHint
        ? `<p class="text-xs text-red-700 mt-1"><strong>You should verify:</strong> ${verifyHint}</p>`
        : '';
      html = `
        <div id="confidence-red-warning" class="rounded-lg bg-red-50 border border-red-300 px-3 py-3 mb-2">
          <div class="flex items-center gap-2 mb-1">
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 border border-red-200">
              ❌ Verify before using
            </span>
          </div>
          <p class="text-xs text-red-800 font-semibold">
            This output has low confidence. We strongly recommend fact-checking before use.
          </p>
          ${hint}
        </div>`;
    }

    container.innerHTML = html;

    // SC3: Wire up click-through confirmation on Copy / Approve buttons if RED
    if (level === 'red') {
      _hookRedConfirmation();
    }
  };

  /**
   * SC3: Intercept Copy / Approve button clicks when badge is RED.
   * Requires the user to acknowledge low confidence before the action fires.
   */
  function _hookRedConfirmation() {
    document.querySelectorAll('[data-action="copy-output"], [data-action="approve-output"]').forEach(btn => {
      if (btn.dataset.confidenceHooked) return;
      btn.dataset.confidenceHooked = '1';
      btn.addEventListener('click', function (e) {
        // A styled dialog cannot answer synchronously, so the original click is held and, on a
        // yes, replayed with a one-shot pass so this capture listener lets it through.
        if (btn.dataset.confidencePass === '1') { delete btn.dataset.confidencePass; return; }
        e.stopImmediatePropagation();
        e.preventDefault();
        window.confirmModal(
          'I understand this output may be inaccurate — proceed anyway?',
          { title: 'This output has low AI confidence', confirmLabel: 'Proceed anyway', tone: 'primary' },
        ).then((ok) => {
          if (!ok) return;
          btn.dataset.confidencePass = '1';
          btn.click();
        });
      }, true);
    });
  }

  /**
   * Helper: given a task_run metadata object from the API, render the badge.
   * Usage: window.renderConfidenceBadgeFromMeta(container, taskRun.metadata)
   */
  window.renderConfidenceBadgeFromMeta = function (container, meta) {
    const level = meta?.confidenceLevel || 'amber';
    const hint  = meta?.verifyHint      || null;
    window.renderConfidenceBadge(container, level, hint);
  };
})();
