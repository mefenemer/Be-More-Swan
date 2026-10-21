/**
 * src/components/assistant-site-audit.js
 * The Mystery Shopper's Website tab — docs/mystery-shopper-plan.md §4.
 *
 * Six sub-tabs, following a suggestion from check to done (owner, 2026-10-21): Checks (score and its
 * three parts, what the last check said, why the score isn't higher, competitors, past checks,
 * settings) · To review · In progress · Done · Needs attention · Archived. "Check my site
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
 * ── Briefs and History ────────────────────────────────────────────────────────
 * A "Brief <name>" click opens that assistant's chat with the brief typed in AND records the brief
 * (site-audits.ts `brief` → site_audit_briefs): the idea leaves "Ideas for your other assistants" (To review)
 * for In progress, and after 30 days Done. Fixes that went live are in Done, dismissed ones and
 * earlier checks' unactioned ideas in Archived. "Undo" puts a brief back.
 *
 * Handlers are bound to `document` once, at load, never from render. Every server value is escaped.
 * ⚠️ The button and section names are quoted to the chat (chat-orchestrator.ts mysteryShopperSurfaces);
 * tests/mystery-shopper-wiring.test.ts fails if they drift apart.
 */
(function () {
  const API = '/.netlify/functions/site-audits';
  const POLL_MS = 5000;
  const HISTORY_PAGE = 20;

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
    tab: 'checks',         // the sub-tab: checks | review | progress | done | attention | archived
    historyShown: 20,      // client-paged: "Show more" adds HISTORY_PAGE
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
  // site_audit_briefs holds briefs sent AND ideas the user rejected (source 'rejected_idea'): both take
  // an idea off To review. Only real briefs are "with your other assistants".
  const allBriefs = () => state.data?.briefs || [];
  const briefs = () => allBriefs().filter((b) => b.source !== 'rejected_idea');
  /** The recorded brief for one of a check's ideas, or for a fix's "say it meanwhile" nudge. */
  const ideaBrief = (runId, i) => allBriefs().find((b) => (b.source === 'idea' || b.source === 'rejected_idea') && b.runId === runId && b.handoffIndex === i) || null;
  const fixBrief = (fixId) => briefs().find((b) => b.source === 'stalled_fix' && b.fixId === fixId) || null;
  /** Same words as src/utils/site-audit-briefs.ts stalledFixBrief — what History records as briefed. */
  const stalledFixBrief = (afterText) => `Please draft a post that leads with this message: "${afterText}". It is how we now describe what we do, and our website will say the same soon. Keep any [placeholders] for me to fill in.`;
  const ideaDraft = (h) => `From ${state.assistantName || 'my Mystery Shopper'}'s check of ${pageName(state.data.audit.url)}: ${h.brief}`;

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
      <div class="border border-gray-200 rounded-xl p-4" data-sa-fix-card="${esc(f.id)}">
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
            ? `<span class="text-xs font-semibold text-green-700">You said you'll make this change. Made it? Tell us here, or the next check will spot it.</span>
               <button type="button" data-sa-fix="${esc(f.id)}" data-status="done" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50">I've made this change</button>
               <button type="button" data-sa-fix="${esc(f.id)}" data-status="open" class="text-xs text-gray-500 underline">Undo</button>`
            : `<button type="button" data-sa-fix="${esc(f.id)}" data-status="accepted" class="btn-primary px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50">I'll make this change</button>
               <button type="button" data-sa-reject-fix="${esc(f.id)}" class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition disabled:opacity-50">Reject</button>`}
          <button type="button" data-sa-copy="${esc(f.id)}" class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Copy</button>
        </div>
      </div>`;
  }

  /** A week after "I'll make this change" and it is still not on the site: say it elsewhere meanwhile. */
  function stalledNudge(f) {
    const done = fixBrief(f.id);
    if (done) {
      return `<p class="mt-3 text-xs text-indigo-700">You briefed ${esc(done.targetName || 'your Social Media Assistant')} on ${esc(when(done.createdAt))} to post the new wording while this waits — it's in In progress.</p>`;
    }
    const social = teamFor('social_media_manager');
    return `
      <div class="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
        <p class="text-xs text-amber-800">It has been over a week and this isn't on your site yet. Until it is, ${social ? esc(social.name) : 'a Social Media Assistant'} could put the new wording in front of people in a post.</p>
        ${social
          ? `<button type="button" data-sa-stalled="${esc(f.id)}" class="mt-2 btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Brief ${esc(social.name)}</button>`
          : '<p class="text-xs text-gray-500 mt-1">You don\'t have a Social Media Assistant yet.</p>'}
      </div>`;
  }

  /** One idea for another assistant, with its Brief button (or why there isn't one). */
  function ideaCard(h, runId, i) {
    const who = teamFor(h.target);
    return `
      <div class="border border-gray-200 rounded-xl p-4">
        <p class="text-xs font-bold text-gray-900">${esc(h.title)}</p>
        <p class="text-xs text-gray-700 mt-1">${esc(h.brief)}</p>
        ${who
          ? `<button type="button" data-sa-handoff="${i}" data-run="${esc(runId)}" class="mt-2 btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Brief ${esc(who.name)}</button>`
          : `<p class="text-xs text-gray-500 mt-2">For a ${esc(roleLabel(h.target))} — you don't have one yet.</p>`}
        <button type="button" data-sa-reject-idea="${i}" data-run="${esc(runId)}" class="mt-2 btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Reject</button>
      </div>`;
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

  /**
   * "Why your score isn't higher" (was "What the score is missing", which listed the checks the page
   * failed and left the owner with nothing to do — owner, 2026-10-21). Each line now says how much it
   * matters and where to go: the suggested fix for that part of the score, or this assistant's chat
   * with the question typed in.
   */
  const WEIGHT_WORDS = { 3: IMPACT.high, 2: IMPACT.medium, 1: IMPACT.low };
  function missingBlock(latest) {
    const failed = (latest?.scores?.outcomes || []).filter((o) => o.result === 'fail').sort((a, b) => b.weight - a.weight);
    if (!failed.length) return '';
    const fixes = state.data?.fixes || [];
    const fixFor = (lens) => fixes.find((f) => f.lens === lens && (f.status === 'open' || f.status === 'accepted'));
    return `
      <h3 class="text-sm font-black text-gray-900">Why your score isn't higher</h3>
      <p class="text-xs text-gray-500 mt-1">What a buyer's eye looks for and didn't find, most important first. This list is worked out afresh at every check: there's nothing to tick off — once your page passes one, it simply drops off the list at the next check and the score goes up. The suggested fixes are what move through In progress to Done.</p>
      <ul class="mt-3 space-y-2">${failed.slice(0, 10).map((o, i) => {
        const [w, cls] = WEIGHT_WORDS[o.weight] || IMPACT.medium;
        const lens = (LENSES.find((l) => l[0] === o.lens) || [null, ''])[1];
        const fx = fixFor(o.lens);
        return `<li class="border border-gray-200 rounded-xl p-3">
          <div class="flex flex-wrap items-center gap-2"><span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${cls}">${esc(w)}</span><span class="text-[10px] text-gray-500">${esc(lens)}</span></div>
          <p class="text-xs text-gray-800 mt-1">${esc(o.label)}</p>
          ${fx
            ? `<button type="button" data-sa-goto-fix="${esc(fx.id)}" class="mt-2 btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">See the suggested fix</button>`
            : `<button type="button" data-sa-ask="${i}" class="mt-2 btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Ask ${esc(state.assistantName || 'your Mystery Shopper')} how to fix this</button>`}
        </li>`;
      }).join('')}</ul>`;
  }

  function competitorsBlock(audit, latest) {
    const comps = audit.competitorUrls || [];
    // The addresses are edited in Settings; the card says so with a button that opens it at them
    // (owner, 2026-10-21: "we need to be able to edit the competitor urls" — it was possible, but
    // nothing on this card led there).
    const edit = `<button type="button" data-sa-edit-competitors class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">${comps.length ? 'Edit competitors' : 'Add competitors'}</button>`;
    const head = `<div class="flex flex-wrap items-center justify-between gap-2"><h3 class="text-sm font-black text-gray-900">Competitors</h3>${edit}</div>`;
    if (!comps.length) {
      return `${head}<p class="text-xs text-gray-500 mt-1">Add up to three and every check compares you side by side — and tells you when they change their headline, prices or offer.</p>`;
    }
    const changes = (latest?.report?.competitorChanges || []);
    const unread = (latest?.report?.competitorsUnread || []);
    return `
      ${head}
      <ul class="mt-2 space-y-2">${comps.map((u) => {
        const c = changes.find((x) => x.url === u);
        const miss = unread.find((x) => x.url === u);
        return `<li class="text-xs text-gray-700"><span class="font-bold">${esc(host(u))}</span>
          ${miss ? `<span class="text-amber-700"> — not read last time: ${esc(miss.message)}</span>`
            : c && c.changes && c.changes.length ? `<ul class="list-disc pl-5 mt-1">${c.changes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
            : '<span class="text-gray-500"> — no change spotted at the last check</span>'}</li>`;
      }).join('')}</ul>`;
  }

  const SOURCE_WORDS = { idea: 'An idea from a check', stalled_fix: 'To post the new wording while your website change waits', chat: 'From your chat' };

  function historyItem(e) {
    const pill = (text, cls) => `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${cls}">${esc(text)}</span>`;
    if (e.kind === 'fix') {
      const f = e.f;
      const live = f.status === 'done';
      // Done by a check (verifiedRunId) or by the user's "I've made this change" — which the next
      // check that can see the change confirms.
      const confirmed = live && f.verifiedRunId != null;
      return `
        <li class="border border-gray-200 rounded-xl p-4">
          <div class="flex flex-wrap items-center gap-2">
            ${confirmed ? pill('Live on your site', 'bg-green-50 text-green-700') : live ? pill('You marked this done', 'bg-green-50 text-green-700') : pill('Rejected', 'bg-gray-100 text-gray-600')}
            <span class="text-xs font-bold text-gray-900">${esc(f.location || 'Page')}</span>
            <span class="text-[10px] text-gray-500">${confirmed ? `Confirmed by a check ${esc(when(f.updatedAt))}` : live ? `Marked done ${esc(when(f.updatedAt))}` : `Rejected ${esc(when(f.updatedAt))}`} · suggested ${esc(when(f.createdAt))}</span>
          </div>
          <div class="grid gap-2 mt-2 md:grid-cols-2">
            <div class="bg-gray-50 rounded-lg p-2"><p class="text-[10px] font-bold text-gray-500 uppercase">${live ? 'Was' : 'On your site'}</p><p class="text-xs text-gray-700 mt-0.5 break-words">${esc(f.beforeText)}</p></div>
            <div class="bg-indigo-50/60 rounded-lg p-2"><p class="text-[10px] font-bold text-indigo-700 uppercase">${live ? 'Now' : 'Suggested'}</p><p class="text-xs text-gray-900 mt-0.5 break-words">${esc(f.afterText)}</p></div>
          </div>
          ${confirmed ? '' : live
            ? `<button type="button" data-sa-fix="${esc(f.id)}" data-status="accepted" class="mt-2 text-xs text-gray-500 underline">Not done after all</button>`
            : `<button type="button" data-sa-fix="${esc(f.id)}" data-status="open" class="mt-2 text-xs text-gray-500 underline">Bring back</button>`}
        </li>`;
    }
    if (e.kind === 'rejected') {
      const b = e.b;
      return `
        <li class="border border-gray-200 rounded-xl p-4">
          <div class="flex flex-wrap items-center gap-2">
            ${pill('Rejected', 'bg-gray-100 text-gray-600')}
            ${b.title ? `<span class="text-xs font-bold text-gray-900">${esc(b.title)}</span>` : ''}
            <span class="text-[10px] text-gray-500">Idea for a ${esc(roleLabel(b.targetRole))} · rejected ${esc(when(b.createdAt))}</span>
          </div>
          <p class="text-xs text-gray-700 mt-2">${esc(b.brief)}</p>
          <button type="button" data-sa-unbrief="${esc(b.id)}" class="mt-2 text-xs text-gray-500 underline">Bring back</button>
        </li>`;
    }
    if (e.kind === 'brief') {
      const b = e.b;
      return `
        <li class="border border-gray-200 rounded-xl p-4">
          <div class="flex flex-wrap items-center gap-2">
            ${pill(`Briefed ${b.targetName || roleLabel(b.targetRole)}`, 'bg-indigo-50 text-indigo-700')}
            ${b.title ? `<span class="text-xs font-bold text-gray-900">${esc(b.title)}</span>` : ''}
            <span class="text-[10px] text-gray-500">${esc(when(b.createdAt))} · ${esc(SOURCE_WORDS[b.source] || '')}</span>
          </div>
          <p class="text-xs text-gray-700 mt-2">${esc(b.brief)}</p>
          <button type="button" data-sa-unbrief="${esc(b.id)}" class="mt-2 text-xs text-gray-500 underline">Undo — not briefed after all</button>
        </li>`;
    }
    const who = teamFor(e.h.target);
    return `
      <li class="border border-gray-200 rounded-xl p-4">
        <div class="flex flex-wrap items-center gap-2">
          ${pill('Not actioned', 'bg-gray-100 text-gray-600')}
          <span class="text-xs font-bold text-gray-900">${esc(e.h.title)}</span>
          <span class="text-[10px] text-gray-500">Idea from the ${esc(when(e.at))} check, for a ${esc(roleLabel(e.h.target))}</span>
        </div>
        <p class="text-xs text-gray-700 mt-2">${esc(e.h.brief)}</p>
        ${who ? `<button type="button" data-sa-handoff="${e.i}" data-run="${esc(e.runId)}" class="mt-2 btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Brief ${esc(who.name)}</button>` : ''}
      </li>`;
  }

  // ── Sub-tabs (owner, 2026-10-21) ─────────────────────────────────────────────
  // The tab was one long stack: score, summary, fixes, ideas, what's missing, competitors, History,
  // past checks. Now six sub-tabs that follow a suggestion from check to done, left to right, and
  // History is split into the tabs it belongs to. Arrow keys move between them (assistants.js).
  const SUBTABS = [['checks', 'Checks'], ['review', 'To review'], ['progress', 'In progress'], ['done', 'Done'], ['attention', 'Needs attention'], ['archived', 'Archived']];
  const BRIEF_SETTLE_DAYS = 30;   // a brief is "in progress" while the other assistant works on it

  /** Every suggestion, sorted into the sub-tab it belongs in. */
  function buckets() {
    const fixes = state.data?.fixes || [];
    const stalled = new Set(state.data?.stalled || []);
    const latest = state.data?.latest;
    const settled = (b) => Date.now() - new Date(b.createdAt).getTime() > BRIEF_SETTLE_DAYS * 864e5;
    const newest = (state.data?.runs || [])[0];
    const pastIdeas = [];
    for (const r of state.data?.pastIdeas || []) {
      if (r.runId === latest?.id) continue;
      (r.handoffs || []).forEach((h, i) => { if (!ideaBrief(r.runId, i)) pastIdeas.push({ kind: 'idea', at: r.at, h, runId: r.runId, i }); });
    }
    const byNew = (a, b) => new Date(b.at) - new Date(a.at);
    return {
      review: {
        fixes: fixes.filter((f) => f.status === 'open'),
        ideas: (latest?.report?.handoffs || []).map((h, i) => [h, i]).filter(([, i]) => !ideaBrief(latest.id, i)),
      },
      progress: {
        fixes: fixes.filter((f) => f.status === 'accepted' && !stalled.has(f.id)),
        briefs: briefs().filter((b) => !settled(b)).map((b) => ({ kind: 'brief', at: b.createdAt, b })).sort(byNew),
      },
      done: [
        ...fixes.filter((f) => f.status === 'done').map((f) => ({ kind: 'fix', at: f.updatedAt, f })),
        ...briefs().filter(settled).map((b) => ({ kind: 'brief', at: b.createdAt, b })),
      ].sort(byNew),
      attention: {
        fixes: fixes.filter((f) => f.status === 'accepted' && stalled.has(f.id)),
        run: newest && (newest.status === 'failed' || newest.status === 'unreadable') ? newest : null,
        comps: latest?.report?.competitorsUnread || [],
      },
      archived: [
        ...fixes.filter((f) => f.status === 'dismissed').map((f) => ({ kind: 'fix', at: f.updatedAt, f })),
        ...allBriefs().filter((x) => x.source === 'rejected_idea').map((x) => ({ kind: 'rejected', at: x.createdAt, b: x })),
        ...pastIdeas,
      ].sort(byNew),
    };
  }

  function counts(b) {
    return {
      review: b.review.fixes.length + b.review.ideas.length,
      progress: b.progress.fixes.length + b.progress.briefs.length,
      done: b.done.length,
      attention: b.attention.fixes.length + (b.attention.run ? 1 : 0) + b.attention.comps.length,
      archived: b.archived.length,
    };
  }

  function subtabsHtml(n) {
    const tone = { review: 'bg-amber-100 text-amber-800', attention: 'bg-red-100 text-red-700' };
    return `<div class="tab-scroller border-b border-gray-200 overflow-x-auto overflow-y-hidden">
      <div class="flex gap-1" role="tablist" aria-label="Your website check">${SUBTABS.map(([k, l]) => {
        const on = state.tab === k;
        const c = n[k] || 0;
        return `<button type="button" role="tab" id="sa-subtab-${k}" data-sa-subtab="${k}" aria-selected="${on}" tabindex="${on ? 0 : -1}"
          class="site-subtab px-3 py-2 text-sm whitespace-nowrap border-b-2 ${on ? 'font-bold text-emerald-800' : 'font-medium text-gray-500 hover:text-gray-700 border-transparent'}">${esc(l)}${c ? ` <span class="ml-1 text-[10px] font-black px-1.5 py-0.5 rounded-full ${tone[k] || 'bg-gray-100 text-gray-600'}">${c}</span>` : ''}</button>`;
      }).join('')}</div></div>`;
  }

  const empty = (text) => `<p class="text-sm text-gray-500">${text}</p>`;
  const list = (items) => `<ul class="space-y-3 mt-3">${items.map(historyItem).join('')}</ul>`;

  function reviewPanel(b) {
    const latest = state.data?.latest;
    return `
      ${card(`
        <h3 class="text-sm font-black text-gray-900">Suggested fixes</h3>
        <p class="text-xs text-gray-500 mt-1">Every "on your site now" quote was read from your page. Say you'll make the change and it moves to In progress; a later check confirms it and it moves to Done.</p>
        <div class="space-y-3 mt-3">${b.review.fixes.length ? b.review.fixes.map(fixCard).join('') : empty('Nothing waiting — the next check will look again.')}</div>`)}
      ${card(`
        <h3 class="text-sm font-black text-gray-900">Ideas for your other assistants</h3>
        <p class="text-xs text-gray-500 mt-1">While your website is being changed, these help in the meantime. Each opens that assistant's chat with the brief typed in — nothing is sent until you send it. Once you've briefed one it moves to In progress.</p>
        <div class="space-y-3 mt-3">${b.review.ideas.length
          ? b.review.ideas.map(([h, i]) => ideaCard(h, latest.id, i)).join('')
          : empty(latest?.report?.handoffs?.length ? 'You’ve briefed every idea from the last check.' : 'No new ideas from the last check — what would help is already covered by your other assistants.')}</div>`)}`;
  }

  function progressPanel(b) {
    return `
      ${card(`
        <h3 class="text-sm font-black text-gray-900">Changes you're making</h3>
        <p class="text-xs text-gray-500 mt-1">The next check looks for the new wording on your site. When it's there, the fix moves to Done; if it's still missing after a week, to Needs attention.</p>
        <div class="space-y-3 mt-3">${b.progress.fixes.length ? b.progress.fixes.map(fixCard).join('') : empty('None — say “I’ll make this change” on a fix in To review.')}</div>`)}
      ${card(`
        <h3 class="text-sm font-black text-gray-900">Briefs with your other assistants</h3>
        <p class="text-xs text-gray-500 mt-1">Sent in the last ${BRIEF_SETTLE_DAYS} days. Older ones are in Done.</p>
        ${state.data?.briefsAvailable === false ? '<p class="text-xs text-amber-700 mt-2">Briefs to your other assistants aren’t being recorded yet, so they don’t appear here.</p>' : ''}
        ${b.progress.briefs.length ? list(b.progress.briefs) : `<div class="mt-3">${empty('None yet.')}</div>`}`)}`;
  }

  function donePanel(b) {
    return card(`
      <h3 class="text-sm font-black text-gray-900">Done</h3>
      <p class="text-xs text-gray-500 mt-1">Fixes a check confirmed are live on your site, and briefs sent over ${BRIEF_SETTLE_DAYS} days ago.</p>
      ${b.done.length ? list(b.done.slice(0, state.historyShown)) : `<div class="mt-3">${empty('Nothing yet — a fix lands here when a check finds the new wording on your site.')}</div>`}
      ${b.done.length > state.historyShown ? `<button type="button" data-sa-history-more class="mt-3 text-xs text-gray-500 underline">Show more (${b.done.length - state.historyShown} older)</button>` : ''}`);
  }

  function attentionPanel(b) {
    const a = b.attention;
    const why = a.run && (a.run.status === 'unreadable'
      ? 'Your page shows almost no text until JavaScript runs, so there was nothing to read — and many AI crawlers see the same blank page. Ask whoever built the site about server-side rendering.'
      : (a.run.error || 'The check did not complete.'));
    const parts = [
      a.run ? card(`<h3 class="text-sm font-black text-gray-900">The last check didn't finish</h3><p class="text-xs text-gray-700 mt-1">${esc(when(a.run.createdAt))}: ${esc(why)}</p><p class="text-xs text-gray-500 mt-1">Nothing was charged. Try again from Checks.</p>`) : '',
      a.fixes.length ? card(`<h3 class="text-sm font-black text-gray-900">Promised, but not on your site yet</h3><p class="text-xs text-gray-500 mt-1">Over a week since you said you'd make these changes, and the last check didn't find them.</p><div class="space-y-3 mt-3">${a.fixes.map(fixCard).join('')}</div>`) : '',
      a.comps.length ? card(`<h3 class="text-sm font-black text-gray-900">Competitors that couldn't be read</h3><ul class="mt-2 space-y-1">${a.comps.map((c) => `<li class="text-xs text-gray-700"><span class="font-bold">${esc(host(c.url))}</span> — ${esc(c.message)}</li>`).join('')}</ul><div class="mt-3"><button type="button" data-sa-edit-competitors class="btn-secondary px-3 py-1.5 border text-xs font-bold rounded-lg transition">Edit competitors</button></div>`) : '',
    ].filter(Boolean);
    return parts.length ? parts.join('') : card(empty('Nothing needs you right now.'));
  }

  function archivedPanel(b) {
    return card(`
      <h3 class="text-sm font-black text-gray-900">Archived</h3>
      <p class="text-xs text-gray-500 mt-1">Fixes and ideas you rejected ("Bring back" returns one to To review), and ideas from earlier checks that nobody acted on. ${esc(state.assistantName || 'Your Mystery Shopper')} doesn't suggest what you rejected again.</p>
      ${b.archived.length ? list(b.archived.slice(0, state.historyShown)) : `<div class="mt-3">${empty('Nothing archived.')}</div>`}
      ${b.archived.length > state.historyShown ? `<button type="button" data-sa-history-more class="mt-3 text-xs text-gray-500 underline">Show more (${b.archived.length - state.historyShown} older)</button>` : ''}`);
  }

  function checksPanel(audit, latest) {
    const run = inFlight();
    const runs = state.data?.runs || [];
    return `
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
        <p class="text-xs text-gray-400 mt-2">A check that re-scores uses 1 task. If nothing on your site or your competitors' sites has changed, the score stands and nothing is used.</p>`)}
      ${goalBlock(audit)}
      ${state.settingsOpen ? card(`<h3 class="text-sm font-black text-gray-900 mb-3">Settings</h3>${settingsForm(audit)}`) : ''}
      ${latest?.report?.summary ? card(`
        <h3 class="text-sm font-black text-gray-900">What the last check said</h3>
        <p class="text-sm text-gray-700 mt-2">${esc(latest.report.summary)}</p>
        ${(latest.report.partialLenses || []).length ? `<p class="text-xs text-amber-700 mt-2">The ${esc(latest.report.partialLenses.map((k) => (LENSES.find((l) => l[0] === k) || [k, k])[1]).join(' and '))} part didn't come back from the AI in a usable form this time, so it was scored on the automatic checks alone (the ones that don't need AI) and may read lower than it should. Nothing extra was charged, and the next check tries it again.</p>` : ''}`) : ''}
      ${latest ? card(missingBlock(latest) || '<p class="text-xs text-gray-500">Every check passed at the last look.</p>') : ''}
      ${card(competitorsBlock(audit, latest))}
      ${runs.length ? card(`<h3 class="text-sm font-black text-gray-900">Past checks</h3><ul class="mt-2 space-y-1">${runs.map((r) => `
        <li class="text-xs text-gray-600">${esc(when(r.createdAt))} · ${esc(KIND_WORDS[r.kind] || r.kind)} · ${esc(RUN_WORDS[r.status] || r.status)}${r.overallScore !== null && r.overallScore !== undefined ? ` · ${esc(r.overallScore)}/100` : ''}${r.error ? ` — ${esc(r.error)}` : ''}</li>`).join('')}</ul>`) : ''}`;
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
    const b = buckets();
    const panel = { checks: () => checksPanel(audit, latest), review: () => reviewPanel(b), progress: () => progressPanel(b), done: () => donePanel(b), attention: () => attentionPanel(b), archived: () => archivedPanel(b) }[state.tab] || (() => checksPanel(audit, latest));
    el.innerHTML = `
      <div class="space-y-4">
        ${subtabsHtml(counts(b))}
        ${noteHtml()}
        <div role="tabpanel" aria-labelledby="sa-subtab-${state.tab}" class="space-y-4">${panel()}</div>
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

    const sub = t('[data-sa-subtab]');
    if (sub) { state.tab = sub.dataset.saSubtab; state.historyShown = HISTORY_PAGE; render(); return; }
    const goFix = t('[data-sa-goto-fix]');
    if (goFix) {
      // The fix is in To review (undecided) or In progress / Needs attention (accepted).
      const f = (state.data?.fixes || []).find((x) => x.id === Number(goFix.dataset.saGotoFix));
      const stalled = (state.data?.stalled || []).includes(f?.id);
      state.tab = !f || f.status === 'open' ? 'review' : stalled ? 'attention' : 'progress';
      render();
      document.querySelector(`[data-sa-fix-card="${CSS.escape(String(f?.id))}"]`)?.scrollIntoView({ block: 'center' });
      return;
    }
    const ask = t('[data-sa-ask]');
    if (ask) {
      const o = (state.data?.latest?.scores?.outcomes || []).filter((x) => x.result === 'fail').sort((a, z) => z.weight - a.weight)[Number(ask.dataset.saAsk)];
      if (o) openChatWithBrief({ id: state.assistantId }, `My last website check says: "${o.label}". How do I fix that on my site?`);
      return;
    }
    if (t('[data-sa-settings-open]')) { state.settingsOpen = !state.settingsOpen; if (state.settingsOpen) state.tab = 'checks'; render(); return; }
    if (t('[data-sa-edit-competitors]')) {
      state.settingsOpen = true;
      state.tab = 'checks';
      render();
      const first = document.querySelector('[data-sa-settings] input[name="competitor"]');
      first?.scrollIntoView({ block: 'center' });
      first?.focus({ preventScroll: true });
      return;
    }
    if (t('[data-sa-settings-close]')) { state.settingsOpen = false; render(); return; }
    if (t('[data-sa-history-more]')) { state.historyShown += HISTORY_PAGE; render(); return; }

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

    const rejectFix = t('[data-sa-reject-fix]');
    if (rejectFix) {
      // Why, optionally: a reason becomes one of this assistant's Rules, which every check reads —
      // so "we never show prices on the homepage" stops the whole kind of suggestion, not just this one.
      const reason = typeof window.promptModal === 'function'
        ? await window.promptModal(`${esc(state.assistantName || 'Your Mystery Shopper')} won't suggest this change again. If you say why, it keeps that in mind for every future check too (it's added to its Rules, where you can change it).`, { title: 'Reject this suggestion?', confirmLabel: 'Reject', cancelLabel: 'Keep it', multiline: true, placeholder: 'Why not? (optional) e.g. we never show prices on the homepage' })
        : '';
      if (reason === null) return;   // "Keep it"
      rejectFix.disabled = true;
      try {
        const res = await post({ action: 'fix', fixId: Number(rejectFix.dataset.saRejectFix), status: 'dismissed', reason: String(reason || '').trim() });
        say(res.ruleId ? 'Rejected — it\'s in Archived, and your reason is now one of its Rules.' : 'Rejected — it\'s in Archived.');
      } catch (err) { say(err.message, 'error'); }
      await load();
      return;
    }
    const rejectIdea = t('[data-sa-reject-idea]');
    if (rejectIdea) {
      rejectIdea.disabled = true;
      try {
        await post({ action: 'brief', assistantId: state.assistantId, source: 'rejected_idea', runId: Number(rejectIdea.dataset.run), handoffIndex: Number(rejectIdea.dataset.saRejectIdea) });
        say('Rejected — it\'s in Archived, and won\'t be suggested again.');
      } catch (err) { say(err.message, 'error'); }
      await load();
      return;
    }

    const handoff = t('[data-sa-handoff]');
    if (handoff) {
      const i = Number(handoff.dataset.saHandoff);
      const runId = Number(handoff.dataset.run);
      const run = runId === state.data?.latest?.id
        ? { handoffs: state.data.latest.report?.handoffs }
        : (state.data?.pastIdeas || []).find((r) => r.runId === runId);
      const h = (run?.handoffs || [])[i];
      const who = h && teamFor(h.target);
      if (who) {
        handoff.disabled = true;
        await briefAndOpen(who, ideaDraft(h), { source: 'idea', runId, handoffIndex: i });
      }
      return;
    }

    const stalled = t('[data-sa-stalled]');
    if (stalled) {
      const f = (state.data?.fixes || []).find((x) => x.id === Number(stalled.dataset.saStalled));
      const who = teamFor('social_media_manager');
      if (f && who) {
        stalled.disabled = true;
        await briefAndOpen(who, stalledFixBrief(f.afterText), { source: 'stalled_fix', fixId: f.id });
      }
      return;
    }

    const unbrief = t('[data-sa-unbrief]');
    if (unbrief) {
      unbrief.disabled = true;
      try {
        await post({ action: 'unbrief', briefId: Number(unbrief.dataset.saUnbrief) });
        say(null);
      } catch (err) { say(err.message, 'error'); }
      await load();
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
   * A "Brief <name>" click: open their chat with the brief typed in, and record the brief so the
   * suggestion counts as actioned and moves to History. Where the chat opens in a modal it opens at
   * once and the record follows; where opening means leaving the page, the record is written first.
   * A failed record never stops the chat opening.
   */
  async function briefAndOpen(who, draft, what) {
    const record = post({ action: 'brief', assistantId: state.assistantId, ...what })
      .then(() => say(`Briefed ${who.name} — it's in In progress.`))
      .catch((err) => say(err.message, 'error'));
    if (typeof window.openAssistantChat === 'function') {
      openChatWithBrief(who, draft);
      await record;
      await load();
      return;
    }
    await record;
    openChatWithBrief(who, draft);
  }

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
      state.tab = 'checks';
      state.historyShown = HISTORY_PAGE;
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
