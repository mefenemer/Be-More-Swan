/**
 * Shared page-scroll lock.
 *
 * Overlays (modals, drawers) need to stop the page behind them from scrolling. Doing that
 * by writing `document.body.style.overflow` directly breaks in two ways once more than one
 * overlay exists:
 *
 *   1. Two overlays open at once — the first to close unlocks scroll while the second is
 *      still up, and the page scrolls behind it.
 *   2. An overlay is destroyed without its close handler running — workspace.html's loadView
 *      swaps #workspace-content's innerHTML, so any overlay rendered *inside* a view is
 *      removed without unlocking, stranding the lock and leaving the next view unscrollable.
 *
 * This manager fixes (1) by refcounting locks under a caller-supplied key: scroll is restored
 * only when the last holder releases. It fixes (2) via releaseScoped(), which lets a view
 * teardown drop the locks belonging to overlays that live inside that view — without touching
 * locks held by body-level modals that legitimately survive the navigation.
 *
 * Keys are strings. A key registered with `{ scoped: true }` is view-scoped and gets dropped
 * by releaseScoped(); anything else is body-level and survives.
 */
(function () {
  if (window.ScrollLock) return;

  var held = Object.create(null); // key -> { scoped: boolean }

  function anyHeld() {
    for (var k in held) return true;
    return false;
  }

  function apply() {
    // The previous value is deliberately not preserved/restored: the app never sets a
    // meaningful overflow on <html>/<body> outside of these locks, and restoring a stale
    // captured value is precisely how the original stranded-lock bug reappears.
    var locked = anyHeld();
    document.documentElement.style.overflow = locked ? 'hidden' : '';
    document.body.style.overflow = locked ? 'hidden' : '';
  }

  window.ScrollLock = {
    /**
     * Lock page scroll under `key`. Idempotent — locking the same key twice still needs
     * only one release, so a re-opened overlay can't leak a phantom refcount.
     * @param {string} key
     * @param {{scoped?: boolean}} [opts] scoped:true marks the lock as belonging to an
     *        overlay rendered inside a swappable view.
     */
    lock: function (key, opts) {
      if (!key) return;
      held[key] = { scoped: !!(opts && opts.scoped) };
      apply();
    },

    /** Release `key`. Safe to call when the key isn't held. */
    release: function (key) {
      if (!key) return;
      delete held[key];
      apply();
    },

    /**
     * Release every view-scoped lock. Called when a view is torn down, so overlays that
     * were destroyed with the view can't strand their lock. Body-level locks are untouched.
     */
    releaseScoped: function () {
      for (var k in held) if (held[k].scoped) delete held[k];
      apply();
    },

    /** @returns {boolean} whether scroll is currently locked by anyone. */
    isLocked: anyHeld,
  };
})();
