/**
 * src/components/email-assistant-cards.js — the Email Assistant's chat cards (docs/email-assistant-plan.md §5.2, Phase 2b).
 *
 * The chat route (chat-orchestrator.ts, email_assistant) PROPOSES one of these; nothing happens until the
 * owner presses the card's button, and anything that sends, moves or unsubscribes asks again first.
 * Every button calls the SAME netlify/functions/mailboxes.ts action as the Emails tab (GUI = chat), which
 * checks the mailbox is the caller's own. A card never claims something happened before the server says so.
 *
 *   email_reply_proposal       { mailboxId, messageId, note?, summary }   → draft, edit, Send / Save to drafts
 *   email_cleanup_proposal     { mailboxId, batchKey, summary }           → archive / trash a suggested batch
 *   email_undo_proposal        { mailboxId, actionId, summary }           → put a clean-up back
 *   email_rule_proposal        { mailboxId, match, afterDays, summary }   → archive a sender after N days
 *   email_unsubscribe_proposal { mailboxId, messageId, summary }          → one-click unsubscribe
 *
 * Loaded after disruptive-ui-registry.js on workspace.html and assistant-chat.html.
 */
(function () {
  'use strict';
  const R = window.DisruptiveUIRegistry;
  if (!R || !R.register) return;
  const API = '/.netlify/functions/mailboxes';
  const GAP_RE = /\[check:[^\]]*\]/gi;

  async function post(body) {
    const res = await fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.manual) throw new Error(data.error || 'That didn\'t work — nothing was changed.');
    return data;
  }
  async function getActions(mailboxId) {
    const res = await fetch(`${API}?mailboxId=${encodeURIComponent(mailboxId)}&actions=1`, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not read your mailbox right now.');
    return data;
  }
  async function confirmIt(message, opts) {
    if (window.confirmModal) return window.confirmModal(message, opts);
    return window.confirm(message);
  }

  /** The shared card frame: heading, summary, a body slot, buttons, a status line. */
  function frame(esc, heading, summary) {
    const el = document.createElement('div');
    el.className = 'bg-indigo-50/60 border-2 border-indigo-200 rounded-xl shadow-sm p-5 max-w-md';
    el.innerHTML = `
      <p class="text-xs font-bold text-indigo-700 tracking-wider uppercase">${esc(heading)} · Approval needed</p>
      ${summary ? `<p class="text-sm font-bold text-gray-900 mt-2">${esc(String(summary).slice(0, 300))}</p>` : ''}
      <div data-ea-body class="mt-2"></div>
      <div data-ea-buttons class="flex flex-wrap items-center gap-2 mt-3"></div>
      <p class="hidden mt-2 text-xs font-semibold text-indigo-700" data-ea-status></p>`;
    const status = el.querySelector('[data-ea-status]');
    return {
      el,
      body: el.querySelector('[data-ea-body]'),
      buttons: el.querySelector('[data-ea-buttons]'),
      say(text, tone) { status.textContent = text; status.className = `mt-2 text-xs font-semibold ${tone === 'error' ? 'text-red-600' : 'text-indigo-700'}`; },
      busy(b) { el.querySelectorAll('button, textarea').forEach((x) => { x.disabled = b; }); },
    };
  }
  const btn = (label, attr, primary) => `<button type="button" ${attr} class="${primary ? 'btn-primary' : 'btn-secondary border'} px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">${label}</button>`;
  const ids = (ui) => ({ mailboxId: Number(ui.mailboxId), messageId: Number(ui.messageId), actionId: Number(ui.actionId) });

  // ── 1. Reply ───────────────────────────────────────────────────────────────────────────────────
  function renderReply(ui, esc) {
    const f = frame(esc, 'Reply to an email', ui.summary);
    const { mailboxId, messageId } = ids(ui);
    let draft = null; // { actionId, to, subject, body }
    const showDraft = () => {
      const gaps = (draft.body.match(GAP_RE) || []).length;
      f.body.innerHTML = `
        <p class="text-xs text-gray-600"><span class="font-semibold">To:</span> ${esc(draft.to)} · <span class="font-semibold">Subject:</span> ${esc(draft.subject)}</p>
        <label class="sr-only" for="ea-draft-${draft.actionId}">Your reply</label>
        <textarea id="ea-draft-${draft.actionId}" data-ea-text rows="7" class="w-full mt-1 text-sm border border-gray-200 rounded-lg p-2 bg-white">${esc(draft.body)}</textarea>
        <p data-ea-gaps class="text-xs ${gaps ? 'text-amber-700' : 'text-gray-500'}">${gaps ? 'Fill in the parts marked [check: …] before sending — only you know them.' : 'Nothing is sent until you press Send.'}</p>`;
      f.buttons.innerHTML = btn('Send', 'data-ea-send', true) + btn('Save to drafts', 'data-ea-drafts') + btn('Throw away', 'data-ea-dismiss');
      f.el.querySelector('[data-ea-send]').disabled = gaps > 0;
    };
    f.body.innerHTML = ui.note ? `<p class="text-xs text-gray-700">What it should say: ${esc(String(ui.note).slice(0, 400))}</p>` : '';
    f.buttons.innerHTML = btn('Draft the reply', 'data-ea-draft', true) + btn('Not now', 'data-ea-cancel');
    f.el.addEventListener('input', (e) => {
      if (!e.target.closest('[data-ea-text]') || !draft) return;
      draft.body = e.target.value;
      const gaps = (draft.body.match(GAP_RE) || []).length;
      const send = f.el.querySelector('[data-ea-send]'); if (send) send.disabled = gaps > 0;
      const note = f.el.querySelector('[data-ea-gaps]');
      if (note) { note.className = `text-xs ${gaps ? 'text-amber-700' : 'text-gray-500'}`; note.textContent = gaps ? 'Fill in the parts marked [check: …] before sending — only you know them.' : 'Nothing is sent until you press Send.'; }
    });
    f.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-ea-cancel]')) { f.busy(true); f.say('No reply drafted.'); return; }
      if (e.target.closest('[data-ea-draft]')) {
        f.busy(true); f.say('Writing a draft…');
        try {
          // An open draft for this email is reopened, never overwritten.
          const a = await getActions(mailboxId);
          const open = (a.actions || []).find((x) => x.kind === 'reply' && x.status === 'waiting' && x.messageId === messageId);
          if (open) draft = { actionId: open.id, to: open.to, subject: open.subject, body: open.body || '' };
          else {
            const out = await post({ action: 'draft_reply', mailboxId, messageId, mode: 'new', ...(ui.note ? { note: String(ui.note).slice(0, 600) } : {}) });
            draft = { actionId: out.actionId, to: out.to, subject: out.subject, body: out.body };
          }
          f.busy(false); showDraft(); f.say(open ? 'Your open draft.' : 'Here is the draft. Edit it, then send it or save it to your drafts.');
        } catch (err) { f.busy(false); f.say(err.message, 'error'); }
        return;
      }
      if (!draft) return;
      if (e.target.closest('[data-ea-dismiss]')) {
        f.busy(true);
        try { const out = await post({ action: 'dismiss_reply', mailboxId, actionId: draft.actionId }); f.say(out.message || 'Draft thrown away.'); }
        catch (err) { f.busy(false); f.say(err.message, 'error'); }
        return;
      }
      const how = e.target.closest('[data-ea-send]') ? 'send' : e.target.closest('[data-ea-drafts]') ? 'drafts' : null;
      if (!how) return;
      if (how === 'send') {
        if ((draft.body.match(GAP_RE) || []).length) { f.say('Fill in the parts marked [check: …] first.', 'error'); return; }
        if (!(await confirmIt(`Send this reply to ${draft.to}? It goes from your own mailbox, in the same conversation.`, { title: 'Send reply', confirmLabel: 'Send', tone: 'primary' }))) return;
      }
      f.busy(true); f.say(how === 'send' ? 'Sending…' : 'Saving…');
      try { const out = await post({ action: 'send_reply', mailboxId, actionId: draft.actionId, body: draft.body, how }); f.say(out.message); }
      catch (err) { f.busy(false); f.say(err.message, 'error'); }
    });
    return f.el;
  }

  // ── 2. Clean-up ────────────────────────────────────────────────────────────────────────────────
  function renderCleanup(ui, esc) {
    const f = frame(esc, 'Clean up', ui.summary);
    const { mailboxId } = ids(ui);
    f.buttons.innerHTML = btn('See what it covers', 'data-ea-load', true) + btn('Not now', 'data-ea-cancel');
    let batch = null; let chunk = 25; let undoDays = 30;
    f.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-ea-cancel]')) { f.busy(true); f.say('Nothing cleared.'); return; }
      if (e.target.closest('[data-ea-load]')) {
        f.busy(true);
        try {
          const a = await getActions(mailboxId);
          chunk = a.cleanupChunk || 25; undoDays = a.undoDays || 30;
          batch = (a.cleanup || []).find((b) => b.key === ui.batchKey) || null;
          f.busy(false);
          if (!batch) { f.body.innerHTML = '<p class="text-xs text-gray-700">That batch is already clear. 🎉</p>'; f.buttons.innerHTML = ''; return; }
          const n = batch.messageIds.length;
          f.body.innerHTML = `<p class="text-xs text-gray-700">${esc(batch.label)}: ${n} email${n === 1 ? '' : 's'}, ${batch.op === 'trash' ? 'moved to trash (your provider empties it later)' : 'archived (kept, out of your inbox)'}. You can undo it for ${undoDays} days. To untick some, use the Clean-up pill on the Emails tab.</p>`;
          f.buttons.innerHTML = btn(batch.op === 'trash' ? `Move ${n} to trash` : `Archive ${n}`, 'data-ea-go', batch.op !== 'trash') + btn('Not now', 'data-ea-cancel');
        } catch (err) { f.busy(false); f.say(err.message, 'error'); }
        return;
      }
      if (!e.target.closest('[data-ea-go]') || !batch) return;
      const n = batch.messageIds.length;
      if (!(await confirmIt(`${batch.op === 'trash' ? 'Move' : 'Archive'} ${n} email${n === 1 ? '' : 's'}? You can undo this for ${undoDays} days.`,
        { title: batch.op === 'trash' ? 'Move to trash' : 'Archive', confirmLabel: batch.op === 'trash' ? 'Move to trash' : 'Archive', tone: batch.op === 'trash' ? 'destructive' : 'primary' }))) return;
      f.busy(true); f.say('Working…');
      let moved = 0; let failed = 0;
      try {
        for (let i = 0; i < batch.messageIds.length; i += chunk) {
          const out = await post({ action: 'cleanup', mailboxId, op: batch.op, label: batch.label, messageIds: batch.messageIds.slice(i, i + chunk) });
          moved += out.moved || 0; failed += out.failed || 0;
        }
        f.say(`${batch.op === 'trash' ? 'Moved to trash' : 'Archived'}: ${moved}.${failed ? ` ${failed} could not be moved.` : ''} Undo from the Emails tab ▸ Done.`, failed ? 'error' : undefined);
      } catch (err) { f.busy(false); f.say(`${moved ? `${moved} done, then: ` : ''}${err.message}`, 'error'); }
    });
    return f.el;
  }

  // ── 3. Undo ────────────────────────────────────────────────────────────────────────────────────
  function renderUndo(ui, esc) {
    const f = frame(esc, 'Undo a clean-up', ui.summary);
    const { mailboxId, actionId } = ids(ui);
    f.buttons.innerHTML = btn('Put them back', 'data-ea-go', true) + btn('Not now', 'data-ea-cancel');
    f.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-ea-cancel]')) { f.busy(true); f.say('Left as it is.'); return; }
      if (!e.target.closest('[data-ea-go]')) return;
      f.busy(true); f.say('Putting them back…');
      try { const out = await post({ action: 'undo_cleanup', mailboxId, actionId }); f.say(out.message); }
      catch (err) { f.busy(false); f.say(err.message, 'error'); }
    });
    return f.el;
  }

  // ── 4. Archive rule ────────────────────────────────────────────────────────────────────────────
  function renderRule(ui, esc) {
    const f = frame(esc, 'Archive rule', ui.summary);
    const { mailboxId } = ids(ui);
    const days = Math.max(0, Math.min(365, Math.round(Number(ui.afterDays) || 0)));
    f.body.innerHTML = `<p class="text-xs text-gray-700">Email from <span class="font-semibold">${esc(String(ui.match || ''))}</span> is archived ${days === 0 ? 'as it arrives' : `once it is ${days} day${days === 1 ? '' : 's'} old`} — out of your inbox, never deleted. Anything that needs you stays. Each run can be undone.</p>`;
    f.buttons.innerHTML = btn('Save the rule', 'data-ea-go', true) + btn('Not now', 'data-ea-cancel');
    f.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-ea-cancel]')) { f.busy(true); f.say('No rule saved.'); return; }
      if (!e.target.closest('[data-ea-go]')) return;
      f.busy(true); f.say('Saving…');
      try { const out = await post({ action: 'add_rule', mailboxId, match: String(ui.match || ''), afterDays: days }); f.say(out.message); }
      catch (err) { f.busy(false); f.say(err.message, 'error'); }
    });
    return f.el;
  }

  // ── 5. Unsubscribe ─────────────────────────────────────────────────────────────────────────────
  function renderUnsubscribe(ui, esc) {
    const f = frame(esc, 'Unsubscribe', ui.summary);
    const { mailboxId, messageId } = ids(ui);
    f.buttons.innerHTML = btn('Unsubscribe', 'data-ea-go', true) + btn('Not now', 'data-ea-cancel');
    f.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-ea-cancel]')) { f.busy(true); f.say('Still subscribed.'); return; }
      if (!e.target.closest('[data-ea-go]')) return;
      if (!(await confirmIt('Unsubscribe from this sender? This tells them to stop sending — it can\'t be undone from here.', { title: 'Unsubscribe', confirmLabel: 'Unsubscribe', tone: 'primary' }))) return;
      f.busy(true); f.say('Unsubscribing…');
      try {
        const out = await post({ action: 'unsubscribe', mailboxId, messageId });
        if (out.manual) {
          const link = out.webUrl && /^https:\/\//i.test(out.webUrl) ? out.webUrl : out.mailto && /^mailto:/i.test(out.mailto) ? out.mailto : null;
          f.body.innerHTML = link ? `<a class="text-xs font-bold underline text-indigo-700" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open the sender's own unsubscribe link</a>` : '';
          f.say(out.message, 'error');
        } else f.say(out.message);
      } catch (err) { f.busy(false); f.say(err.message, 'error'); }
    });
    return f.el;
  }

  R.register('email_reply_proposal', renderReply);
  R.register('email_cleanup_proposal', renderCleanup);
  R.register('email_undo_proposal', renderUndo);
  R.register('email_rule_proposal', renderRule);
  R.register('email_unsubscribe_proposal', renderUnsubscribe);
})();
