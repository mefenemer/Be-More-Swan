/**
 * text-format-bar.js — the Word-style formatting buttons above a website text box (2026-11-10).
 *
 * Owner: "if the user wants to add bullet points, how do they do that, and if I want something in
 * bold … it would be handy to have a formatting part like you get in Word."
 *
 * The site's text stays plain text with a few marks (src/utils/site-rich-text.ts), so nothing unsafe is
 * ever saved and the AI drafter and the chat write the same thing. These buttons just type the marks:
 *   B → **bold**   I → *italics*   • List → "- " lines   1. List → "1. " lines
 *   Link → [words](/page)   Subheading → a "### " line (text sections only)
 * Pressing one again on formatted words takes the format off. Ctrl/⌘+B and Ctrl/⌘+I work in the box.
 *
 * Use: put TextFormatBar.html({ heading }) straight BEFORE the <textarea> (the box after the bar is the
 * one it formats; the length note keeps its place after the box). One document-level listener serves
 * every bar, so a repaint needs no re-binding. Changes go through insertText where the browser has it,
 * so Ctrl+Z undoes a button press, and fire an `input` event so length notes and "unsaved" checks see it.
 */
(function () {
  'use strict';

  const btnCls = 'px-2 py-0.5 rounded text-xs text-gray-700 hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

  /** The bar. `heading: true` adds the Subheading button (only a text section's body draws subheadings). */
  function html(opts) {
    const o = opts || {};
    const b = (fmt, label, title, inner) => `<button type="button" class="${btnCls}" data-fmt="${fmt}" aria-label="${label}" title="${title}">${inner}</button>`;
    return `<div class="flex flex-wrap items-center gap-0.5 mt-1 px-1 py-0.5 border border-gray-200 rounded-md bg-gray-50" role="toolbar" aria-label="Formatting" data-fmt-bar>`
      + b('bold', 'Bold', 'Bold (Ctrl+B / ⌘B)', '<strong>B</strong>')
      + b('italic', 'Italics', 'Italics (Ctrl+I / ⌘I)', '<em class="font-serif">I</em>')
      + '<span class="w-px h-4 bg-gray-300 mx-1" aria-hidden="true"></span>'
      + b('bullets', 'Bullet list', 'Bullet list', '• List')
      + b('numbers', 'Numbered list', 'Numbered list', '1. List')
      + '<span class="w-px h-4 bg-gray-300 mx-1" aria-hidden="true"></span>'
      + b('link', 'Link', 'Link: choose the words, press Link, then type the page (e.g. /contact) or web address', 'Link')
      + (o.heading ? b('heading', 'Subheading', 'Subheading: a line of its own', 'Subheading') : '')
      + '</div>';
  }

  /** Replace [from, to) with `text`, keeping Ctrl+Z history where the browser can; then select [selA, selB). */
  function replaceRange(ta, from, to, text, selA, selB) {
    ta.focus();
    ta.setSelectionRange(from, to);
    let done = false;
    try { done = document.execCommand && document.execCommand('insertText', false, text); } catch (_) { done = false; }
    if (!done || ta.value.slice(from, from + text.length) !== text) ta.setRangeText(text, from, to, 'end');
    ta.setSelectionRange(selA, selB);
    if (!done) ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** **bold** / *italics*: wrap the chosen words, or unwrap them if already wrapped. */
  function wrap(ta, mark, placeholder) {
    let a = ta.selectionStart;
    let z = ta.selectionEnd;
    const v = ta.value;
    // Keep spaces outside the marks ("**word **" is not bold).
    while (a < z && /\s/.test(v[a])) a++;
    while (z > a && /\s/.test(v[z - 1])) z--;
    const n = mark.length;
    const inner = v.slice(a, z);
    // Already wrapped just outside the selection, or the selection includes the marks: take them off.
    const around = v.slice(a - n, a) === mark && v.slice(z, z + n) === mark
      && !(n === 1 && (v[a - n - 1] === '*' || v[z + n] === '*'));
    if (around) { replaceRange(ta, a - n, z + n, inner, a - n, z - n); return; }
    if (inner.length > 2 * n && inner.startsWith(mark) && inner.endsWith(mark)
      && !(n === 1 && (inner.startsWith('**') || inner.endsWith('**')))) {
      const bare = inner.slice(n, -n);
      replaceRange(ta, a, z, bare, a, a + bare.length);
      return;
    }
    const words = inner || placeholder;
    // A mark can't cross a line, so each line of a longer selection gets its own.
    const out = words.split('\n').map((l) => (l.trim() ? `${mark}${l}${mark}` : l)).join('\n');
    if (inner) replaceRange(ta, a, z, out, a, a + out.length);
    else replaceRange(ta, a, z, out, a + n, a + n + words.length);
  }

  /** The whole lines the selection touches. */
  function lineRange(ta) {
    const v = ta.value;
    const a = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let z = v.indexOf('\n', Math.max(ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === '\n' ? 1 : 0), a));
    if (z < 0) z = v.length;
    return [a, z];
  }

  const BULLET = /^[ \t]*[-*•][ \t]+/;
  const NUMBER = /^[ \t]*\d{1,3}[.)][ \t]+/;

  /** "- " or "1. " at the start of every chosen line; pressing it again on a list takes it off. */
  function list(ta, kind) {
    const [a, z] = lineRange(ta);
    const lines = ta.value.slice(a, z).split('\n');
    const mine = kind === 'bullets' ? BULLET : NUMBER;
    const filled = lines.filter((l) => l.trim());
    const already = filled.length > 0 && filled.every((l) => mine.test(l));
    let i = 0;
    const out = lines.map((l) => {
      const bare = l.replace(BULLET, '').replace(NUMBER, '');
      if (already || !l.trim()) return already ? bare : l;
      i += 1;
      return kind === 'bullets' ? `- ${bare}` : `${i}. ${bare}`;
    }).join('\n');
    // A list needs a line to itself: start it on a new line if the box has words just before it.
    const v = ta.value;
    const lead = !already && a > 0 && v[a - 1] !== '\n' ? '\n' : '';
    replaceRange(ta, a, z, lead + out, a + lead.length + out.length, a + lead.length + out.length);
  }

  /** "### " subheading line, with a blank line either side (that is what makes it a subheading). */
  function heading(ta) {
    const [a, z] = lineRange(ta);
    const v = ta.value;
    const line = v.slice(a, z);
    if (/^###\s+/.test(line)) { const bare = line.replace(/^###\s+/, ''); replaceRange(ta, a, z, bare, a, a + bare.length); return; }
    const words = line.replace(BULLET, '').replace(NUMBER, '').trim() || 'Subheading';
    const before = a === 0 ? '' : v.slice(Math.max(0, a - 2), a) === '\n\n' ? '' : v[a - 1] === '\n' ? '\n' : '\n\n';
    const after = z >= v.length ? '' : v.slice(z, z + 2) === '\n\n' ? '' : '\n';
    const text = `${before}### ${words}${after}`;
    const start = a + before.length + 4;
    replaceRange(ta, a, z, text, start, start + words.length);
  }

  /** [words](/) with the address selected, ready to type the page or web address over it. */
  function link(ta) {
    let a = ta.selectionStart;
    let z = ta.selectionEnd;
    const v = ta.value;
    while (a < z && /\s/.test(v[a])) a++;
    while (z > a && /\s/.test(v[z - 1])) z--;
    const words = (v.slice(a, z) || 'link words').replace(/[[\]\n]/g, ' ').slice(0, 80);
    const text = `[${words}](/)`;
    const at = a + words.length + 3;
    replaceRange(ta, a, z, text, at, at + 1);
  }

  function run(ta, fmt) {
    if (!ta || ta.disabled || ta.readOnly) return;
    if (fmt === 'bold') wrap(ta, '**', 'bold words');
    else if (fmt === 'italic') wrap(ta, '*', 'words in italics');
    else if (fmt === 'bullets' || fmt === 'numbers') list(ta, fmt);
    else if (fmt === 'heading') heading(ta);
    else if (fmt === 'link') link(ta);
  }

  const boxOf = (bar) => {
    const next = bar && bar.nextElementSibling;
    return next && next.tagName === 'TEXTAREA' ? next : null;
  };

  // Keep the box's selection when a button is pressed with the mouse.
  document.addEventListener('mousedown', (e) => { if (e.target.closest && e.target.closest('[data-fmt]')) e.preventDefault(); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-fmt]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    run(boxOf(b.closest('[data-fmt-bar]')), b.dataset.fmt);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'b' && k !== 'i') return;
    const ta = e.target;
    if (!ta || ta.tagName !== 'TEXTAREA') return;
    const prev = ta.previousElementSibling;
    if (!prev || !prev.hasAttribute('data-fmt-bar')) return;
    e.preventDefault();
    run(ta, k === 'b' ? 'bold' : 'italic');
  });

  window.TextFormatBar = { html, run };
})();
