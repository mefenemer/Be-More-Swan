/**
 * src/components/assistant-site-audit.js
 * The Mystery Shopper's Website tab — docs/mystery-shopper-plan.md §4.
 *
 * Shows the site's score out of 100 and its three parts, what the last check said, the suggested
 * fixes (before → after), what competitors changed, past checks, and the settings. "Check my site
 * now" queues a check; checks run in the background (site-audit.ts) and this tab polls until one ends.
 *
 * Backed by netlify/functions/site-audits.ts — the SAME actions the chat cards call
 * (chat-session.js → siteaudit:check / siteaudit:save / siteaudit:fix), so the two surfaces can never
 * disagree. Writes made from the chat dispatch `siteaudit:changed`, which reloads this tab.
 *
 * ── What this tab may not do ─────────────────────────────────────────────────
 * Spend without a click. "Check my site now" is the only button that can use a task, and it says so.
 * Mark a fix done: only a later check can, when the old wording has gone from the page.
 *
 * Handlers are bound to `document` once, at load, never from render. Every server value is escaped.
 * ⚠️ The button and section names are quoted to the chat (chat-orchestrator.ts mysteryShopperSurfaces);
 * tests/mystery-shopper-wiring.test.ts fails if they drift apart.
 */
(function () {
  const API = '/.netlify/functions/site-audits';
  const POLL_MS = 5000;

  const LENSES = [
    ['clarity', 'First impression', 'A sceptical first-time visitor with five seconds to spare.'],
    ['compete', 'Against competitors', 'A buyer with your competitors open in the next tabs.'],
    ['ai', 'AI search readiness', 'How an AI assistant is likely to read the page — a simulation, not a live search.'],
  ];
  const RUN_WORDS = {
    queued: 'Waiting to start', running: 'Checking now', done: 'Scored', unchanged: 'Nothing had changed — score kept',
    unreadable: 'Could not read the page', failed: 'Did not complete',
  };
  const KIND_WORDS = { baseline: 'First check', weekly: 'Weekly check', manual: 'You asked', public_taster: 'Taster' };
  const IMPACT = { high: ['High impact', 'bg-red-50 text-red-700'], medium: ['Medium impact', 'bg-amber-50 text-amber-700'], low: ['Low impact', 'bg-gray-100 text-gray-600'] };

  const state = {
    assistantId: null,
    assistantName: null,
    data: null,
    loaded: false,
    loadError: null,
    rendered: false,
    settingsOpen: false,
    showHistory: false,
    showClosed: false,
    note: null,          // { text, tone }
    pollTimer: null,
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u || ''; } };
  /** "northgate.example/pricing" — host plus path, for naming a page rather than a site. */
  const pageName = (u) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname === '/' ? '' : x.pathname.replace(/\/$/, '')}`; } catch { return u || ''; } };
  const dayName = (ymd) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
  const ROLE_FALLBACK = { social_media_manager: 'Social Media Assistant', blog_writer: 'Blog Writing Assistant', campaign_orchestrator: 'Campaign Assistant' };
  const roleLabel = (k) => (window.RoleLabels && window.RoleLabels.get && window.RoleLabels.get(k)) || ROLE_FALLBACK[k] || 'assistant';
  const teamFor = (roleKey) => (state.data?.team || []).find((a) => a.roleKey === roleKey) || null;

  // ── Server ─────────────────────────────────────────────────────────────────
  async function post(payload) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || `Request failed (HTTP ${res.status}).`);
    return data;
  }

  async function load() {
    if (!state.assistantId) return;
    try {
      state.data = await post({ action: 'get', assistantId: state.assistantId });
      state.loadError = null;
    } catch (err) {
      console.error('[AssistantSiteAudit] load failed:', err);
      state.loadError = err.message;
    }
    state.loaded = true;
    rerender();
    schedulePoll();
  }

  const inFlight = () => (state.data?.runs || []).find((r) => r.status === 'queued' || r.status === 'running') || null;

  /** Poll only while a check is in flight. The server ends a stuck one, so this always stops. */
  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (inFlight()) state.pollTimer = setTimeout(load, POLL_MS);
  }

  // ── Tab badge: suggested fixes nobody has decided on ───────────────────────
  function updateBadge() {
    const el = document.getElementById('site-audit-badge');
    if (!el) return;
    const n = (state.data?.fixes || []).filter((f) => f.status === 'open').length;
    el.textContent = n ? String(n) : '';
    // `hidden` loses to inline-flex in style.css — set style.display too.
    el.classList.toggle('hidden', !n);
    el.style.display = n ? '' : 'none';
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function card(inner, extra = '') {
    return `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 ${extra}">${inner}</div>`;
  }

  function noteHtml() {
    if (!state.note) return '';
    return `<p class="text-xs font-semibold ${state.note.tone === 'error' ? 'text-red-600' : 'text-indigo-700'} mt-3">${esc(state.note.text)}</p>`;
  }

  function settingsForm(audit) {
    const v = state.data?.vocab || { conversionGoals: [], weekdays: [], maxCompetitors: 3 };
    const comps = audit?.competitorUrls || [];
    const goal = audit?.conversionGoal || '';
    const goals = v.conversionGoals.includes(goal) || !goal ? v.conversionGoals : [goal, ...v.conversionGoals];
    const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm';
    return `
      <form data-sa-settings class="space-y-4">
        <div>
          <label class="block text-xs font-bold text-gray-700 mb-1">Your website <span class="text-red-500">*</span></label>
          <input name="url" type="text" required class="${inputCls}" placeholder="yourbusiness.co.uk" value="${esc(audit?.url || '')}">
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-700 mb-1">Who is it for?</label>
          <textarea name="icp" rows="2" class="${inputCls}" placeholder="e.g. Owners of 10–50 person service firms who are drowning in admin">${esc(audit?.icp || '')}</textarea>
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-700 mb-1">What should a visitor do?</label>
          <select name="conversionGoal" class="${inputCls}">
            <option value="">Choose…</option>
            ${goals.map((g) => `<option value="${esc(g)}" ${g === goal ? 'selected' : ''}>${esc(g)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-700 mb-1">Competitors (up to ${esc(v.maxCompetitors)})</label>
          <div class="space-y-2">
            ${Array.from({ length: v.maxCompetitors }, (_, i) => `<input name="competitor" type="text" class="${inputCls}" placeholder="competitor${i + 1}.co.uk" value="${esc(comps[i] || '')}">`).join('')}
          </div>
          <p class="text-xs text-gray-500 mt-1">We read their homepage and up to two more pages (pricing, about), and respect any site that asks crawlers to stay out.</p>
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-700 mb-1">Weekly check day</label>
          <select name="checkWeekday" class="${inputCls}">
            ${v.weekdays.map((d, i) => `<option value="${i}" ${i === (audit ? audit.checkWeekday : 1) ? 'selected' : ''}>${esc(d)}</option>`).join('')}
          </select>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button type="submit" class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50">${audit ? 'Save settings' : 'Save and check my site'}</button>
          ${audit ? '<button type="button" data-sa-settings-close class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition">Cancel</button>' : ''}
        </div>
        ${audit ? '' : '<p class="text-xs text-gray-500">Saving starts your first check straight away. It uses 1 task from your monthly allowance.</p>'}
      </form>`;
  }

  function scoreBlock(audit, latest) {
    const score = audit.currentScore;
    const lenses = latest?.scores?.lenses || {};
    const delta = (score !== null && audit.baselineScore !== null && score !== audit.baselineScore)
      ? `${score > audit.baselineScore ? '+' : ''}${score - audit.baselineScore} since your first check` : '';
    const bars = LENSES.map(([k, label, help]) => {
      const l = lenses[k];
      const v = l && l.score !== null && l.score !== undefined ? l.score : null;
      return `
        <div title="${esc(help)}">
          <div class="flex justify-between text-xs"><span class="font-bold text-gray-700">${esc(label)}</span><span class="text-gray-600">${v === null ? 'not scored' : esc(v)}${l && l.partial ? ' · partly checked' : ''}</span></div>
          <div class="h-2 bg-gray-100 rounded-full mt-1"><div class="h-2 rounded-full bg-indigo-500" style="width:${v === null ? 0 : Math.max(2, Math.min(100, v))}%"></div></div>
        </div>`;
    }).join('');
    return `
      <div class="flex flex-wrap items-end gap-6">
        <div>
          <p class="text-xs font-bold text-gray-500 uppercase tracking-wider">Website score</p>
          <p class="text-4xl font-black text-gray-900 mt-1">${score === null ? '—' : esc(score)}<span class="text-base font-bold text-gray-400">/100</span></p>
          <p class="text-xs text-gray-500 mt-1">Target ${esc(audit.targetScore)}${delta ? ` · ${esc(delta)}` : ''}</p>
        </div>
        <div class="flex-1 min-w-[160px] space-y-3">${bars}</div>
      </div>`;
  }

  function statusLine(audit, latest) {
    const run = inFlight();
    if (run) return `<p class="text-sm font-semibold text-indigo-700">Checking ${esc(host(audit.url))} now — this takes a minute or two. You can leave this page.</p>`;
    const newest = (state.data?.runs || [])[0];
    if (!newest) return '<p class="text-sm text-gray-600">No check has run yet.</p>';
    if (newest.status === 'failed' || newest.status === 'unreadable') {
      const why = newest.status === 'unreadable'
        ? 'Your page shows almost no text until JavaScript runs, so there was nothing to read — and many AI crawlers see the same blank page. Ask whoever built the site about server-side rendering.'
        : (newest.error || 'The check did not complete.');
      return `<p class="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">${esc(when(newest.createdAt))}: ${esc(why)}</p>`;
    }
    const last = (latest ? `Last scored ${esc(when(latest.finishedAt || latest.createdAt))}.` : '')
      + (state.data?.nextCheck ? ` Next weekly check: ${esc(dayName(state.data.nextCheck))}.` : '');
    const unchanged = newest.status === 'unchanged' ? ` Checked again ${esc(when(newest.finishedAt || newest.createdAt))} — nothing had changed, so the score stands.` : '';
    return `<p class="text-xs text-gray-500">${last}${unchanged}</p>`;
  }

  function fixCard(f) {
    const [impactLabel, impactCls] = IMPACT[f.impact] || IMPACT.medium;
    const lens = (LENSES.find((l) => l[0] === f.lens) || [null, ''])[1];
    const accepted = f.status === 'accepted';
    return `
      <div class="border border-gray-200 rounded-xl p-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-bold text-gray-900">${esc(f.location || 'Page')}</span>
          <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${impactCls}">${esc(impactLabel)}</span>
          <span class="text-[10px] text-gray-500">${esc(lens)}</span>
        </div>
        <p class="text-xs text-gray-700 mt-2">${esc(f.whyItMatters || f.problem)}</p>
        <div class="grid gap-2 mt-3 md:grid-cols-2">
          <div class="bg-gray-50 rounded-lg p-3"><p class="text-[10px] font-bold text-gray-500 uppercase">On your site now</p><p class="text-sm text-gray-700 mt-1 break-words">${esc(f.beforeText)}</p></div>
          <div class="bg-indigo-50/60 rounded-lg p-3"><p class="text-[10px] font-bold text-indigo-700 uppercase">Suggested</p><p class="text-sm text-gray-900 mt-1 break-words">${esc(f.afterText)}</p></div>
        </div>
        ${/\[[^\]]+\]/.test(f.afterText || '') ? '<p class="text-xs text-amber-700 mt-2">Fill in the parts in [square brackets] with your own real details before you use it.</p>' : ''}
        ${(state.data?.stalled || []).includes(f.id) ? stalledNudge(f) : ''}
        <div class="flex flex-wrap items-center gap-2 mt-3">
          ${accepted
            ? `<span class="text-xs font-semibold text-green-700">You said you'll make this change — the next check confirms it.</span>
               <button type="button" data-sa-fix="${esc(f.id)}" data-status="open" class="text-xs text-gray-500 underline">Undo</button>`
            : `<button type="button" data-sa-fix="${esc(f.id)}" data-status="accepted" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50">I'll make this change</button>
               <button type="button" data-sa-fix="${esc(f.id)}" data-status="dismissed" class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition disabled:opacity-50">Not for us</button>`}
          <button type="button" data-sa-copy="${esc(f.id)}" class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Copy</button>
        </div>
      </div>`;
  }

  /** A week after "I'll make this change" and it is still not on the site: say it elsewhere meanwhile. */
  function stalledNudge(f) {
    const social = teamFor('social_media_manager');
    return `
      <div class="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
        <p class="text-xs text-amber-800">It has been over a week and this isn't on your site yet. Until it is, ${social ? esc(social.name) : 'a Social Media Assistant'} could put the new wording in front of people in a post.</p>
        ${social
          ? `<button type="button" data-sa-stalled="${esc(f.id)}" class="mt-2 btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Brief ${esc(social.name)}</button>`
          : '<p class="text-xs text-gray-500 mt-1">You don\'t have a Social Media Assistant yet.</p>'}
      </div>`;
  }

  /** The last check's ideas for the other assistants. Each opens their chat with the brief typed in. */
  function handoffsBlock(latest) {
    const handoffs = latest?.report?.handoffs || [];
    if (!handoffs.length) return '';
    return `
      <h3 class="text-sm font-black text-gray-900">Ideas for your other assistants</h3>
      <p class="text-xs text-gray-500 mt-1">While your website is being changed, these help in the meantime. Each opens that assistant's chat with the brief typed in — nothing is sent until you send it.</p>
      <div class="space-y-3 mt-3">${handoffs.map((h, i) => {
        const who = teamFor(h.target);
        return `
          <div class="border border-gray-200 rounded-xl p-4">
            <p class="text-xs font-bold text-gray-900">${esc(h.title)}</p>
            <p class="text-xs text-gray-700 mt-1">${esc(h.brief)}</p>
            ${who
              ? `<button type="button" data-sa-handoff="${i}" class="mt-2 btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Brief ${esc(who.name)}</button>`
              : `<p class="text-xs text-gray-500 mt-2">For a ${esc(roleLabel(h.target))} — you don't have one yet.</p>`}
          </div>`;
      }).join('')}</div>`;
  }

  /** Target reached: the weekly checks carry on; offer the next page worth working on. */
  function goalBlock(audit) {
    if (audit.status !== 'goal_met') return '';
    const next = state.data?.nextPages || [];
    return `
      <div class="bg-green-50 border border-green-300 rounded-2xl p-5">
        <p class="text-sm font-black text-green-700">Target reached — ${esc(audit.currentScore)}/100</p>
        <p class="text-xs text-green-700 mt-1">${esc(state.assistantName || 'Your Mystery Shopper')} keeps checking ${esc(pageName(audit.url))} every week and will tell you if a competitor's change puts it at risk.</p>
        ${next.length ? `
          <p class="text-xs text-gray-700 mt-3">Ready for the next page? Moving on starts a fresh score for that page (its first check uses 1 task), and this page stops being checked.</p>
          <div class="flex flex-wrap gap-2 mt-2">${next.map((u) => `<button type="button" data-sa-next-page="${esc(u)}" class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Work on ${esc(pageName(u))}</button>`).join('')}</div>` : ''}
      </div>`;
  }

  function fixesBlock() {
    const fixes = state.data?.fixes || [];
    const waiting = fixes.filter((f) => f.status === 'open' || f.status === 'accepted');
    const done = fixes.filter((f) => f.status === 'done');
    const dismissed = fixes.filter((f) => f.status === 'dismissed');
    const closed = [...done, ...dismissed];
    return `
      <h3 class="text-sm font-black text-gray-900">Suggested fixes</h3>
      <p class="text-xs text-gray-500 mt-1">Every "on your site now" quote was read from your page. A fix is marked done when a later check no longer finds the old wording.</p>
      <div class="space-y-3 mt-3">${waiting.length ? waiting.map(fixCard).join('') : '<p class="text-sm text-gray-500">Nothing waiting — the next check will look again.</p>'}</div>
      ${closed.length ? `
        <button type="button" data-sa-toggle-closed class="mt-3 text-xs text-gray-500 underline">${state.showClosed ? 'Hide' : 'Show'} done and dismissed (${closed.length})</button>
        ${state.showClosed ? `<ul class="mt-2 space-y-1">${closed.map((f) => `
          <li class="text-xs text-gray-600">${f.status === 'done' ? '<span class="font-bold text-green-700">Live</span>' : '<span class="font-bold text-gray-500">Dismissed</span>'}
            — ${esc(f.location || 'Page')}: "${esc(f.afterText)}"
            ${f.status === 'dismissed' ? `<button type="button" data-sa-fix="${esc(f.id)}" data-status="open" class="ml-1 underline">Bring back</button>` : ''}</li>`).join('')}</ul>` : ''}` : ''}`;
  }

  function missingBlock(latest) {
    const failed = (latest?.scores?.outcomes || []).filter((o) => o.result === 'fail').sort((a, b) => b.weight - a.weight);
    if (!failed.length) return '';
    return `
      <h3 class="text-sm font-black text-gray-900">What the score is missing</h3>
      <ul class="mt-2 space-y-1 list-disc pl-5">${failed.slice(0, 10).map((o) => `<li class="text-xs text-gray-700">${esc(o.label)}</li>`).join('')}</ul>`;
  }

  function competitorsBlock(audit, latest) {
    const comps = audit.competitorUrls || [];
    if (!comps.length) {
      return `<h3 class="text-sm font-black text-gray-900">Competitors</h3><p class="text-xs text-gray-500 mt-1">Add up to three in Settings and every check compares you side by side — and tells you when they change their headline, prices or offer.</p>`;
    }
    const changes = (latest?.report?.competitorChanges || []);
    const unread = (latest?.report?.competitorsUnread || []);
    return `
      <h3 class="text-sm font-black text-gray-900">Competitors</h3>
      <ul class="mt-2 space-y-2">${comps.map((u) => {
        const c = changes.find((x) => x.url === u);
        const miss = unread.find((x) => x.url === u);
        return `<li class="text-xs text-gray-700"><span class="font-bold">${esc(host(u))}</span>
          ${miss ? `<span class="text-amber-700"> — not read last time: ${esc(miss.message)}</span>`
            : c && c.changes && c.changes.length ? `<ul class="list-disc pl-5 mt-1">${c.changes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
            : '<span class="text-gray-500"> — no change spotted at the last check</span>'}</li>`;
      }).join('')}</ul>`;
  }

  function historyBlock() {
    const runs = state.data?.runs || [];
    if (!runs.length) return '';
    return `
      <button type="button" data-sa-toggle-history class="text-xs text-gray-500 underline">${state.showHistory ? 'Hide' : 'Show'} past checks (${runs.length})</button>
      ${state.showHistory ? `<ul class="mt-2 space-y-1">${runs.map((r) => `
        <li class="text-xs text-gray-600">${esc(when(r.createdAt))} · ${esc(KIND_WORDS[r.kind] || r.kind)} · ${esc(RUN_WORDS[r.status] || r.status)}${r.overallScore !== null && r.overallScore !== undefined ? ` · ${esc(r.overallScore)}/100` : ''}${r.error ? ` — ${esc(r.error)}` : ''}</li>`).join('')}</ul>` : ''}`;
  }

  function render() {
    const el = document.getElementById('site-audit-host');
    if (!el) return;
    if (state.loadError && !state.data) {
      el.innerHTML = card(`<p class="text-sm font-bold text-gray-700 text-center">Could not load your website check</p><p class="text-xs text-gray-500 mt-2 text-center">${esc(state.loadError)}</p>`);
      return;
    }
    if (!state.loaded) { el.innerHTML = card('<p class="text-sm text-gray-400 text-center">Loading…</p>'); return; }

    // Keep what the user has typed across a re-render — an error message, a poll tick or a reload
    // from chat must never wipe a half-filled settings form. Restored by position, field by field.
    const typed = [...el.querySelectorAll('[data-sa-settings] [name]')].map((f) => f.value);

    const audit = state.data?.audit;
    if (!audit) {
      el.innerHTML = card(`
        <h3 class="text-base font-black text-gray-900">Which website should ${esc(state.assistantName || 'your Mystery Shopper')} check?</h3>
        <p class="text-xs text-gray-600 mt-1 mb-4">It reads your homepage the way a buyer would and tells you what is costing you customers. You can also just tell it in chat.</p>
        ${settingsForm(null)}${noteHtml()}`);
      restoreTyped(el, typed);
      return;
    }

    const latest = state.data.latest;
    const run = inFlight();
    el.innerHTML = `
      <div class="space-y-4">
        ${card(`
          <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <p class="text-sm font-black text-gray-900 break-all">${esc(host(audit.url))}</p>
              ${audit.conversionGoal ? `<p class="text-xs text-gray-500">Visitors should: ${esc(audit.conversionGoal)}</p>` : ''}
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" data-sa-run ${run ? 'disabled' : ''} class="btn-primary px-4 py-2 text-sm font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Check my site now</button>
              <button type="button" data-sa-settings-open class="btn-secondary px-4 py-2 border text-sm font-bold rounded-lg transition">Settings</button>
            </div>
          </div>
          ${scoreBlock(audit, latest)}
          <div class="mt-4">${statusLine(audit, latest)}</div>
          <p class="text-xs text-gray-400 mt-2">A check that re-scores uses 1 task. If nothing on your site or your competitors' sites has changed, the score stands and nothing is used.</p>
          ${noteHtml()}`)}
        ${goalBlock(audit)}
        ${state.settingsOpen ? card(`<h3 class="text-sm font-black text-gray-900 mb-3">Settings</h3>${settingsForm(audit)}`) : ''}
        ${latest?.report?.summary ? card(`
          <h3 class="text-sm font-black text-gray-900">What the last check said</h3>
          <p class="text-sm text-gray-700 mt-2">${esc(latest.report.summary)}</p>
          ${(latest.report.partialLenses || []).length ? `<p class="text-xs text-amber-700 mt-2">Part of this check couldn't be completed (${esc(latest.report.partialLenses.map((k) => (LENSES.find((l) => l[0] === k) || [k, k])[1]).join(', '))}), so that part was scored on the automatic checks only.</p>` : ''}`) : ''}
        ${card(fixesBlock())}
        ${latest?.report?.handoffs?.length ? card(handoffsBlock(latest)) : ''}
        ${latest ? card(missingBlock(latest) || '<p class="text-xs text-gray-500">Every check passed at the last look.</p>') : ''}
        ${card(competitorsBlock(audit, latest))}
        ${(state.data.runs || []).length ? card(historyBlock()) : ''}
      </div>`;
    restoreTyped(el, typed);
  }

  function restoreTyped(el, typed) {
    if (!typed || !typed.length) return;
    const fields = [...el.querySelectorAll('[data-sa-settings] [name]')];
    if (fields.length !== typed.length) return;   // a different form (e.g. first-time vs settings)
    fields.forEach((f, i) => { f.value = typed[i]; });
  }

  function rerender() {
    updateBadge();
    if (state.rendered) render();
  }

  function say(text, tone) { state.note = text ? { text, tone } : null; rerender(); }

  function readSettings(form) {
    const fd = new FormData(form);
    return {
      url: String(fd.get('url') || ''),
      icp: String(fd.get('icp') || ''),
      conversionGoal: String(fd.get('conversionGoal') || ''),
      competitorUrls: fd.getAll('competitor').map(String).filter((x) => x.trim()),
      checkWeekday: Number(fd.get('checkWeekday') ?? 1),
    };
  }

  // ── Events (bound once) ────────────────────────────────────────────────────
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest && e.target.closest('[data-sa-settings]');
    if (!form || !state.assistantId) return;
    e.preventDefault();
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const data = await post({ action: 'save', assistantId: state.assistantId, ...readSettings(form) });
      state.settingsOpen = false;
      form.reset();
      say(data.started ? 'Saved. Your first check has started.' : 'Saved.');
    } catch (err) {
      say(err.message, 'error');
      form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      return;
    }
    await load();
  });

  document.addEventListener('click', async (e) => {
    if (!state.assistantId || !e.target.closest('#site-audit-host')) return;
    const t = (sel) => e.target.closest(sel);

    if (t('[data-sa-settings-open]')) { state.settingsOpen = !state.settingsOpen; render(); return; }
    if (t('[data-sa-settings-close]')) { state.settingsOpen = false; render(); return; }
    if (t('[data-sa-toggle-history]')) { state.showHistory = !state.showHistory; render(); return; }
    if (t('[data-sa-toggle-closed]')) { state.showClosed = !state.showClosed; render(); return; }

    const run = t('[data-sa-run]');
    if (run) {
      run.disabled = true;
      try {
        const data = await post({ action: 'run', assistantId: state.assistantId });
        say(data.alreadyRunning ? 'A check is already running.' : 'Checking your site…');
      } catch (err) { say(err.message, 'error'); }
      await load();
      return;
    }

    const fix = t('[data-sa-fix]');
    if (fix) {
      fix.disabled = true;
      try {
        await post({ action: 'fix', fixId: Number(fix.dataset.saFix), status: fix.dataset.status });
        say(null);
      } catch (err) { say(err.message, 'error'); }
      await load();
      return;
    }

    const handoff = t('[data-sa-handoff]');
    if (handoff) {
      const h = (state.data?.latest?.report?.handoffs || [])[Number(handoff.dataset.saHandoff)];
      const who = h && teamFor(h.target);
      if (who) openChatWithBrief(who, `From ${state.assistantName || 'my Mystery Shopper'}'s check of ${pageName(state.data.audit.url)}: ${h.brief}`);
      return;
    }

    const stalled = t('[data-sa-stalled]');
    if (stalled) {
      const f = (state.data?.fixes || []).find((x) => x.id === Number(stalled.dataset.saStalled));
      const who = teamFor('social_media_manager');
      if (f && who) {
        openChatWithBrief(who, `Please draft a post that leads with this message: "${f.afterText}". It is how we now describe what we do, and our website will say the same soon. Keep any [placeholders] for me to fill in.`);
      }
      return;
    }

    const nextPage = t('[data-sa-next-page]');
    if (nextPage) {
      const url = nextPage.dataset.saNextPage;
      const ok = typeof window.confirmModal === 'function'
        ? await window.confirmModal(`${pageName(url)} gets its own score from scratch, starting with a first check now (1 task). ${pageName(state.data.audit.url)} stops being checked — you can switch back in Settings.`, { title: `Work on ${pageName(url)}?`, confirmLabel: 'Start', cancelLabel: 'Not yet' })
        : true;
      if (!ok) return;
      try {
        const data = await post({ action: 'save', assistantId: state.assistantId, url });
        say(data.started ? `Now working on ${pageName(url)} — its first check has started.` : `Now working on ${pageName(url)}.`);
      } catch (err) { say(err.message, 'error'); }
      await load();
      return;
    }

    const copy = t('[data-sa-copy]');
    if (copy) {
      const f = (state.data?.fixes || []).find((x) => x.id === Number(copy.dataset.saCopy));
      if (!f) return;
      try {
        await navigator.clipboard.writeText(f.afterText);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      } catch { say('Your browser blocked copying — select the suggested text and copy it by hand.', 'error'); }
    }
  });

  /**
   * Open another assistant's chat with a brief typed in (never sent — the user reads and sends it).
   * Where the chat modal is not on the page, the brief goes to the clipboard and the chat page opens.
   */
  async function openChatWithBrief(who, draft) {
    if (typeof window.openAssistantChat === 'function') { window.openAssistantChat({ assistantId: who.id, draft }); return; }
    try { await navigator.clipboard.writeText(draft); } catch { /* best effort */ }
    window.location.href = `assistant-chat.html?assistantId=${encodeURIComponent(who.id)}`;
  }

  document.addEventListener('siteaudit:changed', (e) => {
    const id = e.detail && e.detail.assistantId;
    if (!state.assistantId || Number(id) !== Number(state.assistantId)) return;
    load();
  });

  window.AssistantSiteAudit = {
    init({ assistantId, assistantName }) {
      clearTimeout(state.pollTimer);
      state.assistantId = assistantId;
      state.assistantName = assistantName || null;
      state.data = null;
      state.loaded = false;
      state.rendered = false;
      state.settingsOpen = false;
      state.note = null;
      // Eager: the count of undecided fixes drives the tab badge, visible from every tab.
      load();
    },
    /** Called on first activation of the tab. */
    activate() {
      if (state.rendered) return;
      state.rendered = true;
      render();
    },
  };
})();
