/**
 * src/components/fold.js — every item in every tab of an assistant's page opens and closes, and starts closed
 * (owner, 2026-11-06).
 *
 * The tabs are twenty-odd modules that repaint with innerHTML, so this works on what they paint rather than
 * asking each to wrap its cards: anything card-shaped inside a .main-tab-content with a heading and something
 * under it becomes a <details>, the heading row its <summary> and the rest its body. A new card in any tab
 * gets it without doing anything. The nodes only move, so their ids, data- attributes and every document-level
 * click handler carry on working. A <details> needs no handler, and keyboards and screen readers get it for free.
 *
 * What is open is kept here by key and put back after a repaint, so a card the user opened stays open while the
 * tab redraws. Nothing is remembered past a reload or another assistant (Fold.reset): every visit starts closed.
 *
 * Mark markup with:
 *   data-no-fold    — never fold this, or anything inside it (a set-up step, the thing the tab is for)
 *   data-fold-section — a block with no card look that folds all the same
 *   data-fold-open  — open the card holding this (a form the user just asked for; an error to read)
 *   data-fold-key   — on a card: its key, for items whose titles can repeat
 *
 * Tabs that already fold their items their own way (Briefs, Videos, the Review tab's cards) mark themselves
 * data-no-fold and start closed by themselves.
 */
(function () {
  'use strict';
  const openKeys = new Set();

  const CARD = '.bg-white.rounded-2xl, .bg-white.rounded-xl, article.rounded-xl, section.rounded-2xl, [data-fold-section]';
  const HEADING = 'h1, h2, h3, h4, p.font-black, p.font-extrabold, p.font-bold';
  // A pop-up, the chat and the live preview are never folded. An iframe also reloads if it is moved.
  const NEVER = '[data-no-fold], details, .fixed, [role="dialog"], [data-chatpane], .chatpane-dock-col, [data-sb-preview-col]';

  if (!document.getElementById('fold-css')) {
    const css = document.createElement('style');
    css.id = 'fold-css';
    css.textContent = `
      details[data-fold] > summary { list-style: none; cursor: pointer; display: flex; align-items: flex-start; gap: .5rem; }
      details[data-fold] > summary::-webkit-details-marker { display: none; }
      details[data-fold] > summary:focus-visible { outline: 2px solid #ff007f; outline-offset: 2px; border-radius: 4px; }
      .fold-chev { width: 1rem; height: 1rem; margin-top: .2rem; flex-shrink: 0; color: #9ca3af; transition: transform .15s ease; transform: rotate(-90deg); }
      details[data-fold][open] > summary > .fold-chev { transform: none; }
      details[data-fold]:not([open]) > summary:hover > .fold-chev { color: #4b5563; }
      .fold-head { flex: 1 1 auto; min-width: 0; }
      .fold-head > *:last-child { margin-bottom: 0 !important; }
      details[data-fold][open] > .fold-body { margin-top: .75rem; }
      /* Cards stacked with nothing between them once closed. Zero specificity: a parent's own spacing wins. */
      :where(:not(.grid, .flex)) > :where([data-fold-card]) + :where([data-fold-card]) { margin-top: 1rem; }`;
    document.head.appendChild(css);
  }
  const CHEVRON = '<svg class="fold-chev" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>';

  const words = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

  /** The heading row of a card: its first child, if that is a heading or holds one before anything else. */
  function headerOf(card) {
    let parent = card;
    // A card whose only child is a wrapper: look inside it.
    while (parent.children.length === 1 && !parent.firstElementChild.matches(HEADING)) parent = parent.firstElementChild;
    const first = parent.firstElementChild;
    if (!first || first.tagName === 'FORM' || first.tagName === 'UL' || first.tagName === 'TABLE') return null;
    if (first.matches(HEADING) || first.querySelector(HEADING)) return { parent, first };
    return null;
  }
  /** Nothing worth hiding: a line or two of text with nothing to press, like an empty state. */
  function trivial(rest) {
    if (!rest.length) return true;
    if (rest.some((el) => el.matches('input, select, textarea, button, a, ul, ol, table, img, svg') || el.querySelector('input, select, textarea, button, a, ul, ol, table, img'))) return false;
    return rest.map(words).join(' ').length < 160;
  }
  /** An empty state says what to do next, and there's nothing in it to hide. */
  const EMPTY_TITLE = /^(no|nothing)\b/i;

  function foldCard(card, panel, seen) {
    if (card.dataset.foldCard !== undefined || card.closest(NEVER) || card.parentElement.closest('[data-fold-card]') || card.querySelector('iframe')) return;
    // A form on screen is one the user just asked for.
    if (card.matches('form') || card.querySelector(':scope > form')) return;
    const h = headerOf(card);
    if (!h) return;
    const rest = [...h.parent.children].filter((el) => el !== h.first);
    if (trivial(rest)) return;
    const heading = words(h.first.matches(HEADING) ? h.first : h.first.querySelector(HEADING));
    if (EMPTY_TITLE.test(heading)) return;
    const title = heading.replace(/[\d,.]+/g, '').slice(0, 80);
    let key = card.dataset.foldKey || `${panel.id}|${title}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) key += `|${n}`;

    const details = document.createElement('details');
    details.dataset.fold = key;
    const summary = document.createElement('summary');
    summary.innerHTML = CHEVRON;
    const head = document.createElement('div');
    head.className = 'fold-head';
    const body = document.createElement('div');
    body.className = 'fold-body';
    // Spacing that came from the parent has to reach the children's new parent.
    const spacing = String(h.parent.className).match(/\bspace-y-\S+/);
    if (spacing) body.classList.add(spacing[0]);
    h.parent.insertBefore(details, h.first);
    head.appendChild(h.first);
    summary.appendChild(head);
    rest.forEach((el) => body.appendChild(el));
    details.append(summary, body);
    card.dataset.foldCard = '';
    if (openKeys.has(key) || body.querySelector('[data-fold-open], [data-site-section-form]')) details.open = true;
  }

  function enhance(panel) {
    const active = document.activeElement;
    const inPanel = active && active !== document.body && panel.contains(active);
    let caret = null;
    if (inPanel) { try { if (typeof active.selectionStart === 'number') caret = [active.selectionStart, active.selectionEnd]; } catch { /* a number box */ } }
    const seen = new Map();
    panel.querySelectorAll(CARD).forEach((card) => foldCard(card, panel, seen));
    // Moving a node drops focus, and a repaint may just have put the caret back: keep it where it was.
    if (inPanel && active.isConnected && document.activeElement !== active) {
      const around = active.closest('details[data-fold]');
      if (around) around.open = true;
      active.focus({ preventScroll: true });
      if (caret) { try { active.setSelectionRange(caret[0], caret[1]); } catch { /* not a text box */ } }
    }
  }

  // `toggle` doesn't bubble, so this listens in the capture phase.
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || !d.matches || !d.matches('details[data-fold]')) return;
    if (d.open) openKeys.add(d.dataset.fold); else openKeys.delete(d.dataset.fold);
    // Boxes sized to their text measured nothing while they were closed.
    if (d.open) window.dispatchEvent(new Event('resize'));
  }, true);

  // A button in a card's heading row ("Add New Goal", "Check now") usually shows its result in that card.
  document.addEventListener('click', (e) => {
    const control = e.target.closest && e.target.closest('details[data-fold] > summary button, details[data-fold] > summary a');
    if (control) control.closest('details[data-fold]').open = true;
  }, true);

  // Before the browser paints, so nothing flashes open first. The chat changes constantly and is never folded.
  const observer = new MutationObserver((records) => {
    const panels = new Set();
    for (const r of records) {
      if (!r.addedNodes.length || !r.target.closest) continue;
      if (r.target.closest('[data-chatpane]')) continue;
      const panel = r.target.closest('.main-tab-content');
      if (panel) panels.add(panel);
      else r.addedNodes.forEach((n) => { if (n.nodeType === 1) (n.matches('.main-tab-content') ? [n] : n.querySelectorAll('.main-tab-content')).forEach((p) => panels.add(p)); });
    }
    panels.forEach(enhance);
    observer.takeRecords();   // what was just moved here is not news
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.Fold = {
    /** Open every fold around an element, so a link to something inside one can land on it. */
    reveal(el) {
      for (let d = el && el.closest && el.closest('details[data-fold]'); d; d = d.parentElement && d.parentElement.closest('details[data-fold]')) {
        openKeys.add(d.dataset.fold);
        d.open = true;
      }
    },
    /** Another assistant's page: everything starts closed again. */
    reset() { openKeys.clear(); },
  };
})();
