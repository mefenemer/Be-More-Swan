// BMS favicon cursor — pointer stays standard on hover, only flashes to the
// BMS favicon for the duration of a click on a link or button.
(function () {
  const CURSOR_VALUE = 'url("/favicon/favicon-32x32.png") 16 16, pointer';
  const SELECTOR = 'button, [type="button"], [type="submit"], [role="button"], a[href]';

  function showFavicon(el) {
    el.style.cursor = CURSOR_VALUE;
  }

  function hideFavicon(el) {
    el.style.cursor = '';
  }

  function attachSwanCursor(btn) {
    btn.addEventListener('mousedown', () => showFavicon(btn));
    btn.addEventListener('mouseup', () => hideFavicon(btn));
    btn.addEventListener('mouseleave', () => hideFavicon(btn));
  }

  function initSwanCursor() {
    document.querySelectorAll(SELECTOR).forEach(attachSwanCursor);

    // Watch for dynamically added buttons/links (modals etc.)
    new MutationObserver(mutations => {
      mutations.forEach(m => m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.matches(SELECTOR)) {
          attachSwanCursor(node);
        }
        node.querySelectorAll && node.querySelectorAll(SELECTOR).forEach(attachSwanCursor);
      }));
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSwanCursor);
  } else {
    initSwanCursor();
  }
})();
