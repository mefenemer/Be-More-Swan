/**
 * src/components/meeting-bots.js
 * The Note Taker joins a call itself (docs/note-taker-bot-plan.md §4, step 3): the Inbox tab's "Send to a call"
 * button, its dialog, and the "Live & upcoming" strip above the Inbox. Everything goes through ONE server action
 * (netlify/functions/meeting-bots.ts → sendMeetingBot), the same one the chat card uses.
 *
 * Shown only while the meeting_bot flag is on for the workspace (the GET says `available`). Mounted by assistants.js
 * for the meeting_note_taker role; every other role calls unmount().
 *
 *   window.MeetingBots.mount({ assistantId, assistantName })
 *   window.MeetingBots.unmount()
 *   window.MeetingBots.openDialog()
 */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const OPEN = ['scheduled', 'joining', 'waiting_room', 'in_call', 'ended'];
  const LIVE = ['joining', 'waiting_room', 'in_call'];
  const REFRESH_MS = 20000;
  /** Plan §3: say which thing stopped it, never leave it silent. */
  const REASON_WORDS = {
    recording_permission_denied: 'The host didn’t allow recording.',
    timeout_exceeded_waiting_room: 'Nobody let it in within 10 minutes.',
    bot_kicked_from_waiting_room: 'It was turned away from the waiting room.',
    timeout_exceeded_noone_joined: 'Nobody joined the call.',
    cancelled_by_user: 'You cancelled it.',
    assistant_or_workspace_removed: 'The assistant was archived.',
    not_sent: 'It couldn’t reach the meeting service.',
  };
  /** A finished call whose minutes didn't reach the Inbox says why (staging test 2026-11-21: it used to vanish). */
  const WRITE_UP_WORDS = {
    no_meeting: 'No minutes: too little was said in the call to write them.',
    no_transcript: 'No minutes: there was no transcript for this call.',
    blocked: 'No minutes: the transcript couldn’t be used.',
    assistant_gone: 'No minutes: the assistant was archived.',
    task_limit: 'No minutes: your monthly task allowance was used up.',
    waiting_for_tasks: 'Minutes waiting: your monthly task allowance is used up. Add tasks, or wait for the reset on the 1st: the call is kept for 7 days.',
  };
  const STATUS_HINT = {
    not_admitted: 'Nobody let it in.',
    failed: 'The meeting service blocked the Note Taker, or the link didn’t work.',
    removed: 'It was removed from the call.',
  };

  let st = { assistantId: null, assistantName: '', timer: null, data: null };

  const el = (id) => document.getElementById(id);
  const show = (node, on) => { if (node) { node.classList.toggle('hidden', !on); node.style.display = on ? '' : 'none'; } };

  function whenWords(bot, now) {
    const t = new Date(bot.joinAt);
    if (Number.isNaN(t.getTime())) return '';
    if (bot.status === 'scheduled') {
      return t.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
    const mins = Math.round((now - t.getTime()) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    return t.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  /**
   * One strip row. Pure (tests read it through window.MeetingBots._rowHtml). The buttons' 44px touch size is inline:
   * the compiled style.css has no min-h-[44px] (e2e/meeting-bots.spec.ts measured 30px with the class).
   */
  function rowHtml(bot, now = Date.now()) {
    const live = LIVE.includes(bot.status);
    let reason = (bot.statusReason && REASON_WORDS[bot.statusReason]) || STATUS_HINT[bot.status] || '';
    if (bot.status === 'done') {
      // The minutes, not the call, are what the user is waiting for.
      if (bot.writeUp === 'writing') reason = 'Writing the minutes…';
      else if (bot.writeUp === 'waiting_for_tasks') reason = WRITE_UP_WORDS.waiting_for_tasks;
      else if (bot.writeUp === 'no_meeting' || bot.writeUp === 'not_written') reason = WRITE_UP_WORDS[bot.writeUpReason] || 'The minutes couldn’t be written.';
      else reason = '';
    }
    let action = '';
    if (bot.status === 'scheduled') action = `<button type="button" data-mb-remove="${bot.id}" style="min-height:44px" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer whitespace-nowrap">Cancel</button>`;
    else if (live) action = `<button type="button" data-mb-remove="${bot.id}" style="min-height:44px" class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer whitespace-nowrap">Remove from call</button>`;
    else if (bot.status === 'done' && (bot.recordId || bot.writeUp === 'written')) action = '<span class="text-xs font-bold text-gray-700 whitespace-nowrap">Minutes in your Inbox</span>';
    const dot = live ? '<span class="inline-block w-2 h-2 rounded-full bg-emerald-600 mr-1.5 align-middle" aria-hidden="true"></span>' : '';
    return `<li class="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 border-t border-gray-100 first:border-t-0" data-mb-bot="${bot.id}">
      <span class="inline-block rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] font-bold text-gray-700">${esc(bot.platformLabel)}</span>
      <span class="min-w-0 flex-1 text-sm">
        <span class="font-bold text-gray-900 break-words">${esc(bot.title || 'Meeting')}</span>
        <span class="text-gray-500"> · ${esc(whenWords(bot, now))}</span>
        <span class="block text-xs text-gray-700">${dot}${esc(bot.statusWords)}${reason ? ` · ${esc(reason)}` : ''}</span>
      </span>
      ${action}
    </li>`;
  }

  /**
   * The bots worth showing: open ones, anything that ended badly in the last day (so the "why" is seen), and finished calls
   * from the last day whatever happened to their minutes (written, still being written, or not written and why). A
   * finished call with no minutes used to vanish silently.
   */
  const recent = (b, now = Date.now()) => now - new Date(b.leftAt || b.joinAt).getTime() < 24 * 3600 * 1000;
  function visibleBots(bots, now = Date.now()) {
    return (bots || []).filter((b) => OPEN.includes(b.status)
      || (['not_admitted', 'failed', 'removed'].includes(b.status) && recent(b, now))
      || (b.status === 'done' && recent(b, now)));
  }

  function stripHtml(bots, now = Date.now()) {
    const rows = visibleBots(bots, now);
    if (!rows.length) return '';
    return `<section class="mb-4 rounded-xl border border-gray-200 bg-white px-4 py-2" aria-label="Note Taker in calls">
      <h4 class="pt-1 text-xs font-bold uppercase tracking-wide text-gray-500">Live &amp; upcoming</h4>
      <ul class="mt-1">${rows.map((b) => rowHtml(b, now)).join('')}</ul>
    </section>`;
  }

  async function load() {
    const res = await fetch(`/.netlify/functions/meeting-bots?assistantId=${encodeURIComponent(st.assistantId)}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('load');
    return res.json();
  }

  function render() {
    const btn = el('detail-rq-bot-btn');
    const strip = el('meeting-bots-strip');
    const d = st.data;
    if (!d || !d.available) { show(btn, false); show(strip, false); return; }
    show(btn, true);
    if (btn) btn.onclick = () => openDialog();
    const html = stripHtml(d.bots);
    if (strip) {
      strip.innerHTML = html;
      show(strip, !!html);
      strip.querySelectorAll('[data-mb-remove]').forEach((b) => b.addEventListener('click', () => removeBot(Number(b.getAttribute('data-mb-remove')))));
    }
  }

  function schedule() {
    clearTimeout(st.timer);
    // Keep refreshing while a call is open OR its minutes are still being written, so "Writing…" turns into the result.
    const anyOpen = (st.data?.bots || []).some((b) => OPEN.includes(b.status) || (b.status === 'done' && b.writeUp === 'writing' && recent(b)));
    if (anyOpen) st.timer = setTimeout(refresh, REFRESH_MS);
  }

  async function refresh() {
    const forId = st.assistantId;
    if (!forId) return;
    let data = null;
    try { data = await load(); } catch { /* keep what is shown; the next refresh tries again */ }
    // Another Note Taker was opened while this was loading: its own refresh is on the way (review of #774).
    if (st.assistantId !== forId) return;
    if (data) st.data = data;
    render();
    schedule();
  }

  function mount(opts) {
    if (st.assistantId !== opts.assistantId) st.data = null;
    st.assistantId = opts.assistantId;
    st.assistantName = opts.assistantName || '';
    render();
    refresh();
  }

  function unmount() {
    clearTimeout(st.timer);
    st = { assistantId: null, assistantName: '', timer: null, data: null };
    show(el('detail-rq-bot-btn'), false);
    show(el('meeting-bots-strip'), false);
  }

  async function removeBot(botId) {
    const bot = (st.data?.bots || []).find((b) => b.id === botId);
    const live = bot && LIVE.includes(bot.status);
    const ok = await (window.confirmModal
      ? window.confirmModal(live ? 'The Note Taker will leave the call. What it heard so far is still written up.' : 'The Note Taker won’t join this meeting.',
          { title: live ? 'Remove it from the call?' : 'Cancel this booking?', confirmLabel: live ? 'Remove from call' : 'Cancel booking', cancelLabel: 'Keep it' })
      : Promise.resolve(window.confirm(live ? 'Remove the Note Taker from the call?' : 'Cancel this booking?')));
    if (!ok) return;
    try {
      const res = await fetch('/.netlify/functions/meeting-bots', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ action: 'remove', botId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'That didn’t work. Try again.');
      window.showToast?.(live ? 'The Note Taker is leaving the call.' : 'Booking cancelled.', { icon: '✓' });
    } catch (err) {
      window.showToast?.(err.message, { icon: '⚠️' });
    }
    refresh();
  }

  function costWords(d) {
    const w = Number(d?.tasksPer5Min) || 0;
    if (w <= 0) return 'Nothing is charged for this yet.';
    return `Uses ${w} task${w === 1 ? '' : 's'} for each started 5 minutes it’s in the call (about ${w * 12} an hour). Nothing if it isn’t let in.`;
  }

  function openDialog() {
    const d = st.data || {};
    const name = st.assistantName || 'Your Note Taker';
    const needsDpa = d.dpaAccepted === false;
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm';
    overlay.setAttribute('data-meeting-bot-dialog', '');
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="mb-title">
        <div class="flex items-start justify-between gap-4 p-5 border-b border-gray-100">
          <div>
            <h3 id="mb-title" class="text-lg font-bold text-gray-900">Send to a call</h3>
            <p class="text-sm text-gray-500 mt-0.5">${esc(name)} joins the call, makes a transcript and writes the minutes. They wait in your Inbox until you approve.</p>
          </div>
          <button type="button" data-mb-close aria-label="Close" class="text-gray-400 hover:text-gray-600 text-2xl leading-none cursor-pointer">&times;</button>
        </div>
        <form data-mb-form class="p-5 space-y-4" novalidate>
          ${needsDpa ? '<p class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-mb-dpa>Your workspace owner needs to accept the updated Data Processing Agreement (version 1.2) before the Note Taker can join calls.</p>' : ''}
          <label class="block">
            <span class="block text-sm font-bold text-gray-700 mb-1">Meeting link</span>
            <input name="meetingUrl" type="url" inputmode="url" autocomplete="off" required maxlength="500"
              placeholder="https://meet.google.com/abc-defg-hij"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700">
            <span class="block text-xs text-gray-500 mt-1">Google Meet or Microsoft Teams. Copy it from the meeting invite.</span>
          </label>
          <label class="block">
            <span class="block text-sm font-bold text-gray-700 mb-1">Name <span class="font-normal text-gray-500">(optional)</span></span>
            <input name="title" type="text" maxlength="200" placeholder="Weekly team call"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700">
          </label>
          <fieldset>
            <legend class="block text-sm font-bold text-gray-700 mb-1">When</legend>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <label class="inline-flex items-center gap-2 min-h-[44px] sm:min-h-0 cursor-pointer"><input type="radio" name="when" value="now" checked> Now</label>
              <label class="inline-flex items-center gap-2 min-h-[44px] sm:min-h-0 cursor-pointer"><input type="radio" name="when" value="later"> Later</label>
              <input name="joinAt" type="datetime-local" disabled aria-label="Join at"
                class="px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-emerald-700">
            </div>
          </fieldset>
          <label class="block">
            <span class="block text-sm font-bold text-gray-700 mb-1">Leave after at most</span>
            <select name="lengthLimitMinutes" class="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700">
              <option value="60">1 hour</option><option value="120" selected>2 hours</option><option value="180">3 hours</option><option value="240">4 hours</option>
            </select>
          </label>
          <p class="text-xs text-gray-600" data-mb-cost>${esc(costWords(d))}</p>
          <p class="text-xs text-gray-600"><strong>Tell everyone in the meeting</strong> that the Note Taker is recording. In some places you need their consent.</p>
          <p class="hidden text-sm font-semibold" data-mb-status role="status"></p>
          <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" data-mb-close class="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-800 rounded-lg cursor-pointer">Cancel</button>
            <button type="submit" data-mb-submit ${needsDpa ? 'disabled' : ''}
              class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed">Send the Note Taker</button>
          </div>
        </form>
      </div>`;

    let busy = false;
    const close = () => { if (!busy) { overlay.remove(); document.removeEventListener('keydown', onKey); } };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-mb-close]').forEach((b) => b.addEventListener('click', close));
    document.addEventListener('keydown', onKey);

    const form = overlay.querySelector('[data-mb-form]');
    const status = overlay.querySelector('[data-mb-status]');
    const submit = overlay.querySelector('[data-mb-submit]');
    const say = (msg, tone) => {
      status.textContent = msg;
      status.className = `block text-sm font-semibold ${tone === 'error' ? 'text-red-600' : 'text-gray-600'}`;
    };
    form.querySelectorAll('input[name="when"]').forEach((r) => r.addEventListener('change', () => {
      form.elements.joinAt.disabled = form.elements.when.value !== 'later';
      if (!form.elements.joinAt.disabled) form.elements.joinAt.focus();
    }));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy || needsDpa) return;
      const meetingUrl = (form.elements.meetingUrl.value || '').trim();
      if (!meetingUrl) { say('Paste the meeting link first.', 'error'); return; }
      let joinAt = null;
      if (form.elements.when.value === 'later') {
        const t = new Date(form.elements.joinAt.value);
        if (!form.elements.joinAt.value || Number.isNaN(t.getTime())) { say('Choose the time to join.', 'error'); return; }
        joinAt = t.toISOString();
      }
      busy = true;
      submit.disabled = true;
      submit.textContent = 'Sending…';
      say('Sending the Note Taker…');
      try {
        const res = await fetch('/.netlify/functions/meeting-bots', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({
            action: 'send', assistantId: st.assistantId, meetingUrl, title: form.elements.title.value || '', joinAt,
            lengthLimitMinutes: Number(form.elements.lengthLimitMinutes.value), source: 'link',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'The Note Taker couldn’t be sent. Try again.');
        busy = false;
        close();
        window.showToast?.(data.alreadySent ? 'The Note Taker is already on its way to that meeting.'
          : data.bot?.status === 'scheduled' ? 'Booked. The Note Taker will join at that time.' : 'On its way. Let it in when it asks to join.', { icon: '🎙️' });
        refresh();
      } catch (err) {
        busy = false;
        submit.disabled = false;
        submit.textContent = 'Send the Note Taker';
        say(err.message, 'error');
      }
    });

    document.body.appendChild(overlay);
    form.elements.meetingUrl.focus();
  }

  window.MeetingBots = { mount, unmount, openDialog, refresh, _rowHtml: rowHtml, _stripHtml: stripHtml, _visibleBots: visibleBots, _costWords: costWords };
})();
