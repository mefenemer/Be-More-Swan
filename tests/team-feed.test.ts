// tests/team-feed.test.ts
// The Team feed (docs/campaign-orchestrator-flow.md §4) and a campaign's effect on usual posting.
// Owner, 2026-10-14: assistants and the person tell each other things and ask questions; it lives
// in the side menu; the bell counts it; and a campaign can make usual Autopilot posting give way.
//
// Run:  npx tsx tests/team-feed.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_USUAL_POSTING, normaliseUsualPosting } from '../src/utils/campaign-usual-posting';
import { buildCampaignDirective } from '../src/utils/campaign-directive';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const team = read('src/utils/team-messages.ts');
const ddl = read('db/z-team-feed.sql');

console.log('team feed');

// ── The feed ────────────────────────────────────────────────────────────────

check('the DDL is idempotent, and the kinds match what the writer uses', () => {
    assert.ok(/CREATE TABLE IF NOT EXISTS team_messages/.test(ddl) && /CREATE TABLE IF NOT EXISTS team_reads/.test(ddl));
    assert.ok(/ADD COLUMN IF NOT EXISTS usual_posting jsonb NOT NULL/.test(ddl));
    const kinds = (ddl.match(/CHECK \(kind IN \(([^)]+)\)\)/) || [])[1] || '';
    const written = (team.match(/export type TeamKind = ([^;]+);/) || [])[1] || '';
    for (const k of written.split('|').map((x) => x.trim().replace(/'/g, ''))) assert.ok(kinds.includes(`'${k}'`), `kind ${k} would violate the CHECK`);
});

check('team-messages.ts is the only writer of team_messages', () => {
    const offenders = ['netlify/functions/team.ts', 'src/utils/campaign-orders.ts', 'src/utils/campaign-reconciler.ts', 'netlify/functions/process-content-jobs.ts']
        .filter((f) => read(f).includes('insert(teamMessages)'));
    assert.deepStrictEqual(offenders, []);
});

check('the feed never fails the work it describes', () => {
    const post = team.slice(team.indexOf('export async function postTeamMessage('), team.indexOf('async function postOncePerOrder('));
    assert.ok(post.includes('} catch (err) {') && post.includes('return null;'), 'a failed write can throw into the order path');
});

check('orders speak at the moments their state changes — and once per outcome', () => {
    const orders = read('src/utils/campaign-orders.ts');
    assert.ok(orders.includes('await noteOrderPlaced(db, {'), 'placing is silent');
    assert.ok(orders.includes('await noteOrderIssued(db, {'), 'issuing is silent');
    assert.ok(read('src/utils/campaign-reconciler.ts').includes('await noteOrderSettled(db, {'), 'outcomes are silent');
    assert.ok(read('netlify/functions/process-content-jobs.ts').includes('await noteJobRowFinished(db, job.id);'), 'social drafting finishing is silent');
    assert.ok(read('netlify/functions/process-blog-jobs.ts').includes('await noteJobRowFinished(db, job.id);'), 'article drafting finishing is silent');
    assert.ok(/eq\(teamMessages\.campaignOrderId, orderId\), eq\(teamMessages\.kind, m\.kind\)/.test(team), 'no once-per-outcome guard');
});

check('a half-chosen picture brief is not announced as ready, and a rejection is not announced at all', () => {
    const r = read('src/utils/campaign-reconciler.ts');
    assert.ok(r.includes("verdict.kind === 'in_review' && order.action !== 'commission_visuals' ? 'ready' : null"));
});

check('questions are real: each key has a handler, answers are claimed once', () => {
    const keys = ((team.match(/export type QuestionKey = ([^;]+);/) || [])[1] || '').split('|').map((x) => x.trim().replace(/'/g, ''));
    assert.ok(keys.length >= 2);
    const handlers = team.slice(team.indexOf('const QUESTION_HANDLERS'));
    for (const k of keys) assert.ok(handlers.includes(`${k}: async`), `no handler for ${k}`);
    assert.ok(team.includes('.where(and(eq(teamMessages.id, m.id), isNull(teamMessages.answeredAt)))'), 'two clicks could answer twice');
    assert.ok(handlers.includes("await import('./campaign-reconciler')") && handlers.includes('releaseBlockedOrder(db, o)'), '"Start now" does not use the shared release');
});

check('a person\'s campaign note reaches drafting, and every chat reads its thread', () => {
    assert.ok(read('src/utils/blueprint.ts').includes('await ownerNotesFor(db, liveCampaign.id, assistantId)'), 'blueprint section 13 ignores notes');
    assert.ok(read('src/utils/campaign-job-directive.ts').includes('await ownerNotesFor(db, row.id, row.targetAssistantId)'), 'the per-job directive ignores notes');
    const d = buildCampaignDirective({ id: 1, objective: 'Win 10 leads', outcomeMetric: 'leads', pace: 'unknown', ownerNotes: ['Keep it under 100 words'] });
    assert.ok(d && d.directive.includes('"Keep it under 100 words"'), 'notes do not render');
    assert.ok(d && /where it conflicts with your content rules, the rules win/.test(d.directive), 'a note could override the rules');
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('await teamThreadPromptBlock(db, orgId, session.aiAssistantId)'), 'the chat cannot see its Team thread');
    assert.ok(team.includes("await import('./campaign-orders')") && team.includes("recompileAssistantForCampaign(a.id, 'team-note')"), 'a note waits for the next recompile');
});

check('the endpoint is tenant-scoped and moderates what reaches a prompt', () => {
    const fn = read('netlify/functions/team.ts');
    assert.ok(fn.includes('await requireTenant(event, db)'));
    assert.ok(fn.includes("enforcePromptModeration({ text, userId, organisationId: orgId, source: 'team' })"));
    assert.ok(team.includes('eq(aiAssistants.organisationId, args.orgId)') && team.includes('eq(campaigns.organisationId, args.orgId)'), 'could write to another workspace\'s assistant or campaign');
});

check('Team is in the side menu with its own badge, and the bell adds it in', () => {
    const side = read('components/sidebar.html');
    assert.ok(side.includes('id="nav-team"') && side.includes('id="nav-team-badge"'));
    const ws = read('workspace.html');
    assert.ok(ws.includes("'team': { file: 'team.html'") && ws.includes("'team': document.getElementById('nav-team')") && ws.includes('<script src="/src/components/team-feed.js"></script>'));
    const n = read('notifications.js');
    assert.ok(n.includes('count += teamUnread;'), 'the bell does not count Team');
    assert.ok(n.indexOf('setInboxNavBadge(count);') < n.indexOf('count += teamUnread;'), 'the Inbox item would count Team messages it cannot show');
});

check('the feed is in every assistant\'s chat (Team switch) and every campaign; not on the assistant page', () => {
    const m = read('src/components/assistant-chat-modal.js');
    assert.ok(m.includes("window.TeamFeed.mount(el('bms-chat-team-host'), { mode: 'assistant', assistantId: state.assistantId })"));
    assert.ok(m.includes('id="bms-chat-mode-team"') && m.includes("closeAssistantChat();\n      if (typeof window.loadView === 'function') window.loadView('team');"));
    assert.ok(!read('assistant-detail.html').includes('id="team-panel-host"'), 'the duplicate card is back');
    assert.ok(!read('assistants.js').includes("getElementById('team-panel-host')"));
    assert.ok(read('src/components/assistant-campaigns.js').includes("window.TeamFeed?.mount(el, { mode: 'campaign'"));
});

check('each assistant message and thread carries its avatar (own letter and colour)', () => {
    const f = read('src/components/team-feed.js');
    assert.ok(f.includes('AC?.colorFor(a.id, a.avatarColor)') && f.includes('AC?.letterFor(a.id, a.name, a.avatarLetter)'));
    assert.ok(f.includes("avatarHtml(inst, m.from.id, 32)") && f.includes("avatarHtml(inst, a.id, 24)"));
    assert.ok(read('netlify/functions/team.ts').includes("avatarColor: sql<string | null>`${aiAssistants.configuration} ->> 'avatarColor'`"));
});

// ── Usual posting ────────────────────────────────────────────────────────────

check('usual posting defaults to make way, and junk falls back to it', () => {
    assert.deepStrictEqual(DEFAULT_USUAL_POSTING, { social: 'make_way', blog: 'make_way' });
    assert.deepStrictEqual(normaliseUsualPosting({ social: 'pause', blog: 'nonsense' }), { social: 'pause', blog: 'make_way' });
    assert.deepStrictEqual(normaliseUsualPosting(null), DEFAULT_USUAL_POSTING);
});

check('only LIVE campaigns are read, so usual posting restarts by itself', () => {
    const u = read('src/utils/campaign-usual-posting.ts');
    assert.ok(u.includes("inArray(campaigns.status, ['active', 'throttled'])"));
});

check('Autopilot obeys it: social gap-fill, articles and the standing sales post', () => {
    const g = read('src/utils/schedule-gap-fill.ts');
    assert.ok(g.includes("if (usual.mode === 'pause') return { enqueued: 0, reason: 'campaign_paused' };") && g.includes('if (campaignDays.has(key)) continue;'));
    const b = read('src/utils/blog-gap-fill.ts');
    assert.ok(b.includes("reason: 'campaign_paused'") && b.includes("reason: 'campaign_articles_first'"));
    assert.ok(read('netlify/functions/schedule-conversion-posts.ts').includes("(await usualPostingFor(db, assistant.organisationId, 'social')).mode !== 'normal'"));
});

check('set from the form, the chat and stated on the card', () => {
    const fn = read('netlify/functions/campaigns.ts');
    assert.ok(fn.includes('usualPosting: normaliseUsualPosting(body.usualPosting),'), 'create ignores it');
    assert.ok(fn.includes('patch.usualPosting = normaliseUsualPosting('), 'edit ignores it');
    const tab = read('src/components/assistant-campaigns.js');
    assert.ok(tab.includes('${usualPostingFields(c)}') && tab.includes('${usualPostingLine(c)}'));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('YOUR USUAL POSTS.'));
    assert.ok(read('src/components/chat-session.js').includes('usualPosting: c.usualPosting,'), 'chat edits drop it');
});



// ── Owner's changes, 2026-10-14 ──────────────────────────────────────────────
check('it is called Team Chat everywhere the person reads it', () => {
    assert.ok(read('components/sidebar.html').includes('<span class="nav-label">Team Chat</span>'));
    assert.ok(read('team.html').includes('>Team Chat</span></h1>'));
    assert.ok(read('notifications.html').includes('Open Team Chat'));
});

check('newest first by default, either order on request, remembered per browser', () => {
    const f = read('src/components/team-feed.js');
    assert.ok(f.includes("return localStorage.getItem(SORT_KEY) !== 'oldest';") && f.includes('catch (_) { return true; }'), 'default is not newest first');
    assert.ok(f.includes('data-team-sort=') && f.includes('inst.sortNewest = !inst.sortNewest;'));
    assert.ok(f.includes('scroll.scrollTop = inst.sortNewest ? 0 : scroll.scrollHeight;'), 'opens away from the newest message');
});

check('"Me" is the person\'s own thread: to them, or sent by them', () => {
    assert.ok(read('src/components/team-feed.js').includes("${item('me', null, 'Me',"));
    assert.ok(team.includes('if (filter.mine) conds.push(or(eq(teamMessages.toUser, true), sql`${teamMessages.fromUserId} IS NOT NULL`)!);'));
    assert.ok(read('netlify/functions/team.ts').includes('mine: body.mine === true'));
});
check('an assistant\'s Team tab can write to anyone, and shows the thread with whoever "To" names', () => {
    const f = read('src/components/team-feed.js');
    assert.ok(f.includes("const fixed = inst.mode === 'page' && inst.thread.type === 'assistant' ? inst.thread.id : null;"), 'the Team tab is locked to one assistant again');
    assert.ok(f.includes("inst.mode === 'assistant' ? { assistantId: Number(inst.to) || inst.assistantId }"), 'picking someone else would not show their reply');
    assert.ok(f.includes("document.addEventListener('change'") && f.includes("if (!inst || inst.mode !== 'assistant') return;"));
});

check('assistant chat opens on a NEW chat, with New Chat in the header (not in History)', () => {
    const m = read('src/components/assistant-chat-modal.js');
    assert.ok(m.includes('id="bms-chat-new-btn"') && m.includes('+ New Chat'), 'no New Chat in the popup header');
    assert.ok(!m.includes('list-chat-sessions?limit=1'), 'the popup resumes the last chat again');
    assert.ok(!read('src/components/chat-history-panel.js').includes('data-ch-new'), 'History has its own new button again');
    const page = read('assistant-chat.html');
    assert.ok(page.includes('id="chat-new-btn"') && !page.includes('list-chat-sessions?limit=1'), 'assistant-chat.html resumes the last chat again');
    const ws = read('workspace.html');
    assert.ok(ws.includes('id="chat-modal-new-btn"') && ws.includes('return Promise.resolve(mount(null, null));'), 'the roster chat resumes the last chat again');
});
console.log(`
${passed} passed`);
