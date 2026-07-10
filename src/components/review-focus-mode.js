/**
 * Review Focus Mode — one-at-a-time card stack over the Review column's social drafts.
 *
 *   window.ReviewFocusMode.open()
 *
 * Scoped to social posts (status = pending_approval) because they are the only Review-column
 * item type with a straight binary approve/reject decision. Ideas and blog drafts have their
 * own actions and stay on the list view.
 *
 * Three behaviours worth knowing about:
 *
 *  - Approve is deferred, not undone. The fetch fires 5s after the card flies away; Undo just
 *    cancels the pending timer. There is no server-side revert for an approved post, so a
 *    real undo has to happen before the commit rather than after it.
 *  - Reject never flies away on click. It expands a required reason field in place — that
 *    reason is what feeds the tuning / learned-directives loop, so it can't be skipped.
 *  - approve-post can 422 with PLATFORM_NOT_CONNECTED. Because the commit is deferred, a
 *    failure lands after the card is already gone, so the card is pushed back onto the stack.
 *
 * Styling is self-contained (injected <style>, inline colours) — it deliberately avoids new
 * Tailwind classes so style.css does not need rebuilding, and avoids `emerald-*`, which
 * input.css remaps to the pink brand accent.
 */
(function () {
  'use strict';

  // Mirrors netlify/functions/get-review-queue.ts so focus mode bands posts the same way the
  // list view does.
  var URGENCY_RED_HOURS = 12;
  var URGENCY_AMBER_HOURS = 48;

  var COMMIT_DELAY_MS = 5000; // undo window before an approve is actually sent

  var GREEN = '#16a34a';
  var RED = '#dc2626';
  var AMBER = '#d97706';

  var _stack = [];        // undecided posts, top of stack = index 0
  var _skipped = [];      // posts sent to the back with `j`, newest last
  var _pending = {};      // postId -> { timer, post, toast }
  var _decided = 0;       // approved + rejected this session, for the progress ring
  var _total = 0;
  var _root = null;
  var _busy = false;      // guards against double-firing during a fly-away animation

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function urgencyOf(post) {
    if (!post.publishDate) return { band: 'none' };
    var hours = (new Date(post.publishDate).getTime() - Date.now()) / 36e5;
    if (hours < 0) return { band: 'red', label: 'Overdue', color: RED };
    if (hours < URGENCY_RED_HOURS) return { band: 'red', label: 'Due in ' + Math.round(hours) + 'h', color: RED };
    if (hours < URGENCY_AMBER_HOURS) return { band: 'amber', label: 'Due in ' + Math.round(hours) + 'h', color: AMBER };
    return { band: 'green', label: 'Due in ' + Math.round(hours / 24) + 'd', color: GREEN };
  }

  // Red first, then soonest publishDate — the same ordering get-review-queue.ts applies.
  function sortByUrgency(posts) {
    return posts.slice().sort(function (a, b) {
      var ar = urgencyOf(a).band === 'red';
      var br = urgencyOf(b).band === 'red';
      if (ar && !br) return -1;
      if (!ar && br) return 1;
      var at = a.publishDate ? new Date(a.publishDate).getTime() : Infinity;
      var bt = b.publishDate ? new Date(b.publishDate).getTime() : Infinity;
      return at - bt;
    });
  }

  function injectStyles() {
    if (document.getElementById('rfm-styles')) return;
    var s = document.createElement('style');
    s.id = 'rfm-styles';
    s.textContent = [
      '#rfm-overlay{position:fixed;inset:0;z-index:10500;background:rgba(17,24,39,.72);',
      '  backdrop-filter:blur(3px);display:flex;flex-direction:column;}',
      '#rfm-head{display:flex;align-items:center;gap:1rem;padding:1rem 1.5rem;color:#fff;}',
      '#rfm-head h2{font-size:1.125rem;font-weight:800;margin:0;}',
      '#rfm-head p{font-size:.8125rem;opacity:.7;margin:.125rem 0 0;}',
      '#rfm-close{margin-left:auto;background:transparent;border:0;color:#fff;opacity:.7;',
      '  cursor:pointer;font-size:1.5rem;line-height:1;padding:.25rem .5rem;}',
      '#rfm-close:hover{opacity:1;}',
      '#rfm-body{flex:1;display:flex;align-items:center;justify-content:center;gap:3rem;',
      '  padding:0 1.5rem 1.5rem;min-height:0;flex-wrap:wrap;}',
      '#rfm-stack{position:relative;width:100%;max-width:28rem;height:100%;max-height:34rem;}',
      // Every card is the same height. Letting cards hug their own content means a short post
      // behind a tall one sits above its bottom edge and the stack stops looking stacked.
      '.rfm-card{position:absolute;top:0;left:0;right:0;height:100%;display:flex;flex-direction:column;',
      '  border-radius:.75rem;overflow:hidden;',
      '  transition:transform .28s cubic-bezier(.2,.7,.3,1),opacity .28s ease,box-shadow .28s ease;}',
      '.rfm-face{flex:1;overflow-y:auto;min-height:0;}',
      '.rfm-card[data-depth="0"]{z-index:3;box-shadow:0 24px 50px rgba(0,0,0,.35);}',
      // scaleX only (not scale): narrowing reads as depth while the full translateY still peeks
      // out below the card in front, which a uniform scale would eat.
      '.rfm-card[data-depth="1"]{z-index:2;transform:translateY(18px) scaleX(.955);opacity:.75;pointer-events:none;}',
      '.rfm-card[data-depth="2"]{z-index:1;transform:translateY(34px) scaleX(.91);opacity:.45;pointer-events:none;}',
      '.rfm-card[data-depth="3"]{z-index:0;opacity:0;pointer-events:none;}',
      // fly-away: tilt + slide + fade, tinted by the decision
      '.rfm-card.rfm-approve{transform:translateX(140%) rotate(14deg);opacity:0;',
      '  box-shadow:0 0 0 4px ' + GREEN + ', 0 24px 50px rgba(22,163,74,.4);}',
      '.rfm-card.rfm-reject{transform:translateX(-140%) rotate(-14deg);opacity:0;',
      '  box-shadow:0 0 0 4px #9ca3af;}',
      '.rfm-urgency{display:flex;align-items:center;gap:.4rem;padding:.4rem .875rem;',
      '  font-size:.75rem;font-weight:700;color:#fff;border-radius:.75rem .75rem 0 0;}',
      '.rfm-reason{padding:.875rem;background:#fef2f2;border-top:1px solid #fecaca;}',
      '.rfm-reason label{display:block;font-size:.75rem;font-weight:700;color:#991b1b;margin-bottom:.375rem;}',
      '.rfm-reason textarea{width:100%;border:1px solid #fca5a5;border-radius:.5rem;padding:.5rem .625rem;',
      '  font-size:.8125rem;font-family:inherit;resize:vertical;min-height:4.25rem;}',
      '.rfm-reason textarea:focus{outline:2px solid #fca5a5;outline-offset:1px;}',
      '.rfm-reason .rfm-hint{font-size:.6875rem;color:#b91c1c;margin:.375rem 0 .5rem;}',
      '#rfm-side{display:flex;flex-direction:column;align-items:center;gap:1.25rem;color:#fff;}',
      '#rfm-ring{position:relative;width:8.5rem;height:8.5rem;flex:none;}',
      // width/height 100% (not the SVG's intrinsic 136px) so the narrow-viewport rule below can
      // shrink the ring without it spilling over the buttons.
      '#rfm-ring svg{display:block;width:100%;height:100%;transform:rotate(-90deg);}',
      '#rfm-ring div{position:absolute;inset:0;display:flex;flex-direction:column;',
      '  align-items:center;justify-content:center;text-align:center;}',
      '#rfm-ring .rfm-n{font-size:1.875rem;font-weight:800;line-height:1;}',
      '#rfm-ring .rfm-l{font-size:.6875rem;opacity:.7;margin-top:.25rem;}',
      '.rfm-btn{width:13rem;padding:.75rem 1rem;border-radius:9999px;font-weight:700;font-size:.875rem;',
      '  cursor:pointer;display:flex;align-items:center;justify-content:center;gap:.5rem;',
      '  border:0;transition:filter .15s ease;}',
      '.rfm-btn:hover:not(:disabled){filter:brightness(1.08);}',
      '.rfm-btn:disabled{opacity:.45;cursor:not-allowed;}',
      '.rfm-approve-btn{background:' + GREEN + ';color:#fff;}',
      '.rfm-reject-btn{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.45);}',
      '.rfm-skip-btn{background:transparent;color:rgba(255,255,255,.65);border:0;width:auto;',
      '  font-size:.8125rem;text-decoration:underline;padding:.25rem;}',
      '.rfm-keys{font-size:.6875rem;opacity:.55;text-align:center;line-height:1.7;}',
      '.rfm-keys kbd{background:rgba(255,255,255,.16);border-radius:.25rem;padding:.0625rem .3125rem;',
      '  font-family:ui-monospace,monospace;}',
      '#rfm-empty{color:#fff;text-align:center;}',
      '#rfm-empty .rfm-tick{font-size:3rem;}',
      '.rfm-undo{display:flex;align-items:center;gap:.75rem;background:#1f2937;color:#fff;',
      '  padding:.75rem 1rem;border-radius:.75rem;box-shadow:0 10px 25px rgba(0,0,0,.25);font-size:.875rem;}',
      '.rfm-undo button{background:transparent;border:0;color:#f9a8d4;font-weight:700;cursor:pointer;',
      '  text-decoration:underline;font-size:.875rem;}',
      '@media (max-width:820px){#rfm-body{flex-direction:column-reverse;gap:1.25rem;}',
      '  #rfm-stack{max-height:24rem;}#rfm-ring{width:5rem;height:5rem;}',
      '  #rfm-ring .rfm-n{font-size:1.25rem;}.rfm-keys{display:none;}}',
      '@media (prefers-reduced-motion:reduce){.rfm-card{transition:opacity .15s ease;}',
      '  .rfm-card.rfm-approve,.rfm-card.rfm-reject{transform:none;}}',
    ].join('');
    document.head.appendChild(s);
  }

  // ── Undo toast ────────────────────────────────────────────────────────────
  // window.showToast has no action slot, so focus mode renders its own.
  function undoToast(post, onUndo) {
    var host = document.getElementById('rfm-undo-host');
    if (!host) return null;
    var el = document.createElement('div');
    el.className = 'rfm-undo';
    el.setAttribute('role', 'status');
    var label = document.createElement('span');
    label.textContent = 'Approved · ' + (post.platform || 'post');
    var btn = document.createElement('button');
    btn.textContent = 'Undo';
    btn.onclick = function () { el.remove(); onUndo(); };
    el.append(label, btn);
    host.appendChild(el);
    return el;
  }

  // ── Commit ────────────────────────────────────────────────────────────────
  async function commitApprove(post) {
    delete _pending[post.id];
    try {
      var res = await fetch('/.netlify/functions/approve-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, action: 'approve' }),
      });
      var d = await res.json().catch(function () { return {}; });

      // 422 PLATFORM_NOT_CONNECTED lands after the card has already flown away. Put it back
      // rather than silently dropping the decision, then hand off to the existing handler,
      // which offers to jump to Connections.
      if (typeof window.rqHandleNotConnected === 'function' &&
          window.rqHandleNotConnected(res.status, d, post.assistantId)) {
        restore(post);
        return;
      }
      if (!res.ok) {
        restore(post);
        window.showToast?.(d.error || 'Could not approve that post — it is back in the stack.', { icon: '⚠️' });
      }
    } catch (e) {
      restore(post);
      window.showToast?.('Network error — that post is back in the stack.', { icon: '⚠️' });
    }
  }

  async function commitReject(post, reason) {
    try {
      var res = await fetch('/.netlify/functions/approve-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, action: 'reject', rejectionReason: reason }),
      });
      var d = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        restore(post);
        window.showToast?.(d.error || 'Could not reject that post — it is back in the stack.', { icon: '⚠️' });
      }
    } catch (e) {
      restore(post);
      window.showToast?.('Network error — that post is back in the stack.', { icon: '⚠️' });
    }
  }

  // A restore lands ~5s after the card flew away, by which time the user is already working the
  // next card. Slotting the post back at index 1 rather than index 0 means the card under their
  // cursor never changes; they get the failed one next instead.
  function restore(post) {
    _stack.splice(_stack.length ? 1 : 0, 0, post);
    _decided = Math.max(0, _decided - 1);
    render();
  }

  // Leaving with approvals still inside their undo window: commit them now rather than lose them.
  function flushPending() {
    Object.keys(_pending).forEach(function (id) {
      var p = _pending[id];
      clearTimeout(p.timer);
      if (p.toast) p.toast.remove();
      commitApprove(p.post);
    });
  }

  // ── Decisions ─────────────────────────────────────────────────────────────
  function approve() {
    if (_busy || !_stack.length) return;
    var post = _stack[0];
    _busy = true;
    flyOut('rfm-approve', function () {
      _stack.shift();
      refillFromSkipped();
      _decided++;
      render();
      _busy = false;

      var entry = { post: post, toast: null, timer: null };
      entry.timer = setTimeout(function () {
        if (entry.toast) entry.toast.remove();
        commitApprove(post);
      }, COMMIT_DELAY_MS);
      entry.toast = undoToast(post, function () {
        clearTimeout(entry.timer);
        delete _pending[post.id];
        restore(post);
      });
      _pending[post.id] = entry;
    });
  }

  // Reject opens the reason field in place — the card stays put until a reason is submitted.
  function toggleReject() {
    if (_busy || !_stack.length) return;
    var box = document.getElementById('rfm-reason-box');
    if (!box) return;
    var open = box.style.display !== 'none';
    box.style.display = open ? 'none' : 'block';
    if (!open) box.querySelector('textarea').focus();
  }

  function submitReject() {
    if (_busy || !_stack.length) return;
    var box = document.getElementById('rfm-reason-box');
    var ta = box && box.querySelector('textarea');
    var reason = (ta && ta.value || '').trim();
    if (!reason) {
      window.showToast?.('A rejection reason is required — it is what the assistant learns from.', { icon: '✍️' });
      ta && ta.focus();
      return;
    }
    // Belt and braces: never submit a reason against a post other than the one it was written for.
    if (!box || box.getAttribute('data-post-id') !== String(_stack[0].id)) {
      window.showToast?.('That post changed — please review this one again.', { icon: '⚠️' });
      return;
    }
    var post = _stack[0];
    _busy = true;
    flyOut('rfm-reject', function () {
      _stack.shift();
      refillFromSkipped();
      _decided++;
      render();
      _busy = false;
      commitReject(post, reason);
    });
  }

  function flyOut(cls, done) {
    var card = document.querySelector('.rfm-card[data-depth="0"]');
    if (!card) { done(); return; }
    card.classList.add(cls);
    var finished = false;
    var finish = function () { if (finished) return; finished = true; done(); };
    card.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 400); // fallback if transitionend never fires (reduced motion, bg tab)
  }

  // Skipped posts are undecided, not done. Once the live stack runs dry they come back around
  // rather than the queue reporting itself clear with decisions still outstanding.
  function refillFromSkipped() {
    if (!_stack.length && _skipped.length) {
      _stack = _skipped;
      _skipped = [];
    }
  }

  function undecidedCount() {
    return _stack.length + _skipped.length;
  }

  function skip() {
    if (_busy || !_stack.length) return;
    if (undecidedCount() < 2) return;   // nothing else to move on to
    _skipped.push(_stack.shift());
    refillFromSkipped();
    render();
  }

  function unskip() {
    if (_busy || !_skipped.length) return;
    _stack.unshift(_skipped.pop());
    render();
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function ringSvg() {
    var done = _decided;
    var total = _total || 1;
    var r = 58, circ = 2 * Math.PI * r;
    var pct = Math.min(1, done / total);
    return '<svg width="136" height="136" viewBox="0 0 136 136">' +
      '<circle cx="68" cy="68" r="' + r + '" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="8"/>' +
      '<circle cx="68" cy="68" r="' + r + '" fill="none" stroke="' + GREEN + '" stroke-width="8"' +
      ' stroke-linecap="round" stroke-dasharray="' + circ + '"' +
      ' stroke-dashoffset="' + (circ * (1 - pct)) + '"' +
      ' style="transition:stroke-dashoffset .4s ease"/></svg>';
  }

  function cardHtml(post, depth) {
    var u = urgencyOf(post);
    var ribbon = u.band === 'none' ? '' :
      '<div class="rfm-urgency" style="background:' + u.color + '">' +
      '<span>' + esc(u.label) + '</span>' +
      '<span style="margin-left:auto;opacity:.85">' + esc(post.assistantName || 'AI Assistant') + '</span></div>';

    // The card face is the real per-platform mock-up the list view's modal uses, so a post is
    // never approved from a summary.
    var face = typeof window.renderPlatformMockup === 'function'
      ? window.renderPlatformMockup(post)
      : '<div style="padding:2rem;background:#fff">' + esc(post.caption || '') + '</div>';

    // The reason box carries the id of the post it was opened against, so a reason can never be
    // submitted against a card that swapped in underneath it.
    var reason = depth === 0
      ? '<div id="rfm-reason-box" class="rfm-reason" data-post-id="' + post.id + '" style="display:none">' +
        '<label for="rfm-reason">Why is this being rejected?</label>' +
        '<textarea id="rfm-reason" placeholder="e.g. tone is too formal for Instagram"></textarea>' +
        '<p class="rfm-hint">Required. This is fed back to the assistant as a learned directive.</p>' +
        '<button class="rfm-btn rfm-approve-btn" style="width:100%;background:' + RED + '"' +
        ' onclick="ReviewFocusMode._submitReject()">Confirm rejection</button></div>'
      : '';

    return '<div class="rfm-card" data-depth="' + depth + '" style="background:#fff">' +
      ribbon + '<div class="rfm-face">' + face + '</div>' + reason + '</div>';
  }

  function render() {
    if (!_root) return;
    var stackEl = _root.querySelector('#rfm-stack');
    var sideEl = _root.querySelector('#rfm-side');

    if (!undecidedCount()) {
      stackEl.innerHTML =
        '<div id="rfm-empty" style="display:flex;flex-direction:column;align-items:center;' +
        'justify-content:center;height:100%"><div class="rfm-tick">✓</div>' +
        '<p style="font-weight:700;margin:.5rem 0 .25rem">Queue clear</p>' +
        '<p style="font-size:.8125rem;opacity:.7">' + _decided + ' post' + (_decided === 1 ? '' : 's') +
        ' reviewed.</p></div>';
      sideEl.innerHTML =
        '<div id="rfm-ring">' + ringSvg() +
        '<div><span class="rfm-n">0</span><span class="rfm-l">remaining</span></div></div>' +
        '<button class="rfm-btn rfm-approve-btn" onclick="ReviewFocusMode.close()">Done</button>';
      return;
    }

    // render() rebuilds the stack's markup, so carry any half-written rejection reason across —
    // a restore() can re-render while the user is mid-sentence.
    var oldBox = _root.querySelector('#rfm-reason-box');
    var carried = oldBox && oldBox.style.display !== 'none'
      ? { postId: oldBox.getAttribute('data-post-id'), text: oldBox.querySelector('textarea').value }
      : null;

    stackEl.innerHTML = _stack.slice(0, 3).map(function (p, i) { return cardHtml(p, i); }).join('');

    if (carried && String(_stack[0].id) === carried.postId) {
      var box = _root.querySelector('#rfm-reason-box');
      box.style.display = 'block';
      box.querySelector('textarea').value = carried.text;
    }

    sideEl.innerHTML =
      '<div id="rfm-ring">' + ringSvg() +
      '<div><span class="rfm-n">' + undecidedCount() + '</span><span class="rfm-l">remaining</span></div></div>' +
      '<button class="rfm-btn rfm-approve-btn" onclick="ReviewFocusMode._approve()">✓ Approve</button>' +
      '<button class="rfm-btn rfm-reject-btn" onclick="ReviewFocusMode._toggleReject()">✕ Reject</button>' +
      (undecidedCount() > 1
        ? '<button class="rfm-btn rfm-skip-btn" onclick="ReviewFocusMode._skip()">Skip for now</button>'
        : '') +
      '<div class="rfm-keys"><kbd>a</kbd> approve · <kbd>r</kbd> reject<br>' +
      '<kbd>j</kbd> skip · <kbd>k</kbd> back · <kbd>esc</kbd> close</div>';
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  function onKey(e) {
    if (!_root) return;
    // Never steal keys while the reason field has focus.
    var t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) {
      if (e.key === 'Escape') { toggleReject(); e.preventDefault(); }
      return;
    }
    var k = e.key.toLowerCase();
    if (k === 'a') { approve(); e.preventDefault(); }
    else if (k === 'r') { toggleReject(); e.preventDefault(); }
    else if (k === 'j') { skip(); e.preventDefault(); }
    else if (k === 'k') { unskip(); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
  }

  // ── Open / close ──────────────────────────────────────────────────────────
  async function open() {
    if (_root) return;
    injectStyles();

    var posts = [];
    try {
      var res = await fetch('/.netlify/functions/get-social-drafts?status=pending_approval');
      if (res.ok) posts = (await res.json()).drafts || [];
    } catch (e) {
      window.showToast?.('Could not load the review queue.', { icon: '⚠️' });
      return;
    }
    if (!posts.length) {
      window.showToast?.('Nothing is waiting for review.', { icon: '✓' });
      return;
    }

    _stack = sortByUrgency(posts);
    _skipped = [];
    _pending = {};
    _decided = 0;
    _total = posts.length;
    _busy = false;

    _root = document.createElement('div');
    _root.id = 'rfm-overlay';
    _root.setAttribute('role', 'dialog');
    _root.setAttribute('aria-modal', 'true');
    _root.setAttribute('aria-label', 'Review posts one at a time');
    _root.innerHTML =
      '<div id="rfm-head"><div><h2>Focus review</h2>' +
      '<p>One post at a time, most urgent first.</p></div>' +
      '<button id="rfm-close" aria-label="Close focus review" onclick="ReviewFocusMode.close()">×</button></div>' +
      '<div id="rfm-body"><div id="rfm-stack"></div><div id="rfm-side"></div></div>' +
      '<div id="rfm-undo-host" style="position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);' +
      'z-index:11000;display:flex;flex-direction:column;gap:.5rem;align-items:center"></div>';

    document.body.appendChild(_root);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    render();
  }

  function close() {
    if (!_root) return;
    flushPending();
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
    _root.remove();
    _root = null;
    // Pull the list view back in sync with whatever was decided in here.
    if (typeof window.rqLoadItems === 'function') window.rqLoadItems();
    if (typeof window.detailRqRefresh === 'function') { try { window.detailRqRefresh(); } catch (e) { /* ignore */ } }
  }

  window.ReviewFocusMode = {
    open: open,
    close: close,
    _approve: approve,
    _toggleReject: toggleReject,
    _submitReject: submitReject,
    _skip: skip,
  };
})();
