// src/components/redraft-upcoming.js — "Redraft upcoming posts" (src/utils/redraft-upcoming.ts).
//
// A Social Media assistant drafts weeks ahead, so a change to its pillars, core message or audience
// only reached posts drafted after it — three weeks later for Love Cat Studio (2026-11-02), which read
// as "What I post about doesn't work". After such a change this offers, in a small panel that doesn't
// block the page, to redraft the upcoming drafts nobody has approved — with the count, the dates and the
// tasks it uses stated before the click. Nothing happens without "Redraft".
//
// Offered from three places, all through window.offerRedraftUpcoming:
//   · the profile's autosave (assistants.js persistChanges) when a topic answer changed;
//   · a set-up answer card applied from any chat, the Mentor's included (assistant:settingsChanged);
//   · the Social Media chat's redraft_upcoming card (disruptive-ui-registry.js), at once, no delay.
// One server path: netlify/functions/redraft-upcoming-posts.ts.
(function () {
  const API = '/.netlify/functions/redraft-upcoming-posts';
  // Mirrors TOPIC_SETUP_KEYS in src/utils/redraft-upcoming.ts.
  const TOPIC_KEYS = ['content_pillars', 'core_message', 'target_audience', 'primary_objective', 'problem_statement', 'sales_objections'];
  // The profile autosaves 1.2 s after typing stops; wait a little longer so one edit makes one offer.
  const SETTLE_MS = 2500;
  let timer = null;
  let panel = null;

  async function post(body) {
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `That didn't work (HTTP ${res.status}).`), { status: res.status });
    return data;
  }

  const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function close() { if (panel) { panel.remove(); panel = null; } }

  function keptLine(k) {
    const parts = [
      k.approved ? `${plural(k.approved, 'approved post', 'approved posts')}` : '',
      k.soon ? `${plural(k.soon, 'post', 'posts')} going out in the next 2 hours` : '',
      k.handWritten ? `${plural(k.handWritten, 'post', 'posts')} you wrote, asked for or changed` : '',
    ].filter(Boolean);
    return parts.length ? `Left as they are: ${parts.join(', ')}.` : 'Posts you have approved, and any going out in the next 2 hours, stay as they are.';
  }

  function show(assistantId, p) {
    close();
    panel = document.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Redraft upcoming posts');
    panel.className = 'bg-white border-2 border-emerald-200 rounded-xl shadow-lg p-4';
    // Positioned inline: the built style.css has no bottom-4 / sm:w-96 / z-[95] (classes only exist once
    // the Tailwind build has seen them). 16 px gutters on a phone, a 24 rem card on wider screens.
    Object.assign(panel.style, { position: 'fixed', bottom: '16px', right: '16px', left: window.innerWidth < 640 ? '16px' : 'auto', width: window.innerWidth < 640 ? 'auto' : '24rem', zIndex: '95' });
    const range = p.first && p.last && day(p.first) !== day(p.last) ? ` (${day(p.first)} – ${day(p.last)})` : p.first ? ` (${day(p.first)})` : '';
    const cost = p.tasksLeft == null
      ? `It uses ${plural(p.tasks, 'task', 'tasks')}.`
      : `It uses ${plural(p.tasks, 'task', 'tasks')} (${p.tasksLeft >= 1000000 ? 'no limit on your plan' : `${p.tasksLeft} left this month`}).`;
    panel.innerHTML = `
      <p class="text-sm font-bold text-gray-900">Use this change on your upcoming posts?</p>
      <p class="text-xs text-gray-700 mt-1">Your next ${plural(p.slots, 'post was', 'posts were')} drafted before this change${range}, so ${p.slots === 1 ? 'it doesn’t' : 'they don’t'} use it yet. Redraft ${p.slots === 1 ? 'it' : 'them'} now? ${cost}</p>
      <p class="text-[11px] text-gray-500 mt-1">${keptLine(p.kept || {})}</p>
      <p class="hidden text-xs font-semibold mt-2" data-ru-status></p>
      <div class="flex flex-wrap gap-2 mt-3">
        <button type="button" data-ru-go class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50">Redraft ${plural(p.slots, 'post', 'posts')}</button>
        <button type="button" data-ru-close class="btn-secondary border px-3 py-1.5 text-xs font-bold rounded-lg transition">Keep them</button>
      </div>`;
    const status = panel.querySelector('[data-ru-status]');
    const say = (t, err) => { status.textContent = t; status.className = `text-xs font-semibold mt-2 ${err ? 'text-red-600' : 'text-emerald-800'}`; };
    panel.querySelector('[data-ru-close]').addEventListener('click', close);
    panel.querySelector('[data-ru-go]').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      say('Redrafting…');
      try {
        const r = await post({ action: 'apply', assistantId });
        say(r.queued
          ? `Done — ${plural(r.queued, 'new draft is', 'new drafts are')} being written. They appear in Review over the next few minutes.`
          : 'There was nothing left to redraft.');
        document.dispatchEvent(new CustomEvent('assistant:postsRedrafted', { detail: { assistantId, ...r } }));
        panel.querySelector('[data-ru-close]').textContent = 'Close';
      } catch (err) {
        say(err.message, true);
        e.currentTarget.disabled = false;
      }
    });
    document.body.appendChild(panel);
  }

  /** Preview, and show the panel when there is something to redraft. `now` skips the settle delay. */
  async function offer(assistantId, opts) {
    const id = Number(assistantId);
    if (!Number.isInteger(id) || id <= 0) return;
    clearTimeout(timer);
    const run = async () => {
      try {
        const p = await post({ action: 'preview', assistantId: id });
        if (p.slots > 0) show(id, p);
        else if (opts && opts.now) window.showToast?.('No upcoming drafts need redrafting — the next ones will use your change.', 'info');
      } catch (err) {
        // Not a Social Media assistant (404): nothing to offer, say nothing. Anything else, only when asked.
        if (opts && opts.now && err.status !== 404) window.showToast?.(err.message, 'error');
      }
    };
    if (opts && opts.now) return run();
    timer = setTimeout(run, SETTLE_MS);
  }

  window.offerRedraftUpcoming = offer;
  window.REDRAFT_TOPIC_KEYS = TOPIC_KEYS;

  // A set-up answer saved from a chat card (mentor-apply.js setupAnswer) — the Mentor's included.
  document.addEventListener('assistant:settingsChanged', (e) => {
    const d = e.detail || {};
    if (TOPIC_KEYS.includes(d.setting)) offer(d.assistantId);
  });
})();
