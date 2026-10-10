// tests/dashboard-improvements.test.ts
// The dashboard improvements of 2026-10-09 — what the dashboard review found missing, given what the
// team can now do: a "Needs you" strip, an honest hours label, every assistant's work (not just
// social), Campaign / Brand Designer card summaries, a capacity widget, an outage banner, an
// actionable "Off Track", and a 7-day agenda.
//
// Run:  npx tsx tests/dashboard-improvements.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformIssuesFrom, areaOf } from '../src/utils/platform-status';
import { MAX_AGE_HOURS } from '../src/utils/monitor-heartbeat';

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
/** The text between a UNIQUE start marker and the next end marker — throws on a stale marker. */
function slice(text: string, start: string, end: string): string {
    const i = text.indexOf(start);
    assert.ok(i >= 0, `marker not found: ${start}`);
    assert.strictEqual(text.indexOf(start, i + 1), -1, `marker not unique: ${start}`);
    const j = text.indexOf(end, i + start.length);
    assert.ok(j > i, `end marker not found after ${start}: ${end}`);
    return text.slice(i, j);
}

const dash = read('dashboard-content.html');
const cards = read('assistants.js');
const getAssistants = read('netlify/functions/get-assistants.ts');
const toml = read('netlify.toml');

console.log('\nPlatform outage banner');
const NOW = new Date('2026-10-09T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

check('a fresh drafting outage becomes one customer sentence — never the operator text', () => {
    const issues = platformIssuesFrom({ content_generation: { at: hoursAgo(1), problems: ['org 37: 40 jobs failed — Anthropic credit is EXHAUSTED'], warnings: [] } } as any, NOW);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].area, 'writing');
    assert.ok(!/anthropic|credit|org 37/i.test(issues[0].message), `leaked supplier/billing wording: ${issues[0].message}`);
});
check('provider problems map to the area the customer sees', () => {
    assert.strictEqual(areaOf('provider_balances', 'fal balance is EMPTY'), 'images');
    assert.strictEqual(areaOf('provider_balances', 'Stability credit EXHAUSTED'), 'music');
    assert.strictEqual(areaOf('provider_balances', 'Anthropic credit is EXHAUSTED'), 'writing');
    assert.strictEqual(areaOf('provider_balances', 'something unrelated'), null);
});
check('a STALE heartbeat says nothing — a monitor that stopped proves nothing about now', () => {
    const stale = MAX_AGE_HOURS.provider_balances + 1;
    assert.deepStrictEqual(platformIssuesFrom({ provider_balances: { at: hoursAgo(stale), problems: ['fal balance is EMPTY'], warnings: [] } } as any, NOW), []);
});
check('warnings ("balance is low") are never shown; same area twice is shown once', () => {
    assert.deepStrictEqual(platformIssuesFrom({ provider_balances: { at: hoursAgo(1), problems: [], warnings: ['fal balance is low'] } } as any, NOW), []);
    const twice = platformIssuesFrom({
        content_generation: { at: hoursAgo(1), problems: ['jobs failing'], warnings: [] },
        provider_balances: { at: hoursAgo(1), problems: ['Anthropic credit is EXHAUSTED'], warnings: [] },
    } as any, NOW);
    assert.strictEqual(twice.length, 1);
});
check('no heartbeat at all → no banner', () => {
    assert.deepStrictEqual(platformIssuesFrom(null, NOW), []);
});
check('the dashboard fetches platform-status and renders message text escaped', () => {
    assert.ok(dash.includes("/.netlify/functions/platform-status"), 'banner never fetched');
    assert.ok(dash.includes('id="platform-status-banner"'));
    assert.ok(dash.includes('issues.map((i) => esc(i.message))'), 'banner message rendered unescaped');
});

console.log('\n"Needs you" strip');
check('reads the SAME pendingReview the cards read, and is counts + links only (no item list)', () => {
    const s = slice(dash, 'id="needs-you"', '</section>');
    assert.ok(!/<li|<ul/i.test(s), 'the strip must not re-grow into the removed attention list');
    assert.ok(/opSignals[^\n]*pendingReview/.test(dash), 'strip does not read opSignals.pendingReview');
});
check('a briefs-tab role (Brand Designer) opens Briefs, everyone else the Review Queue', () => {
    assert.ok(/briefsTab[\s\S]{0,200}'briefs'[\s\S]{0,200}'review-queue'|hideReviewQueue[\s\S]{0,200}'briefs'/.test(dash), 'chip tab routing missing');
});

console.log('\nEstimated hours');
check('the hours tile and the Value widget both say it is an estimate', () => {
    assert.ok(dash.includes('Estimated Hours Saved'));
    assert.ok(dash.includes('hrs (est.)'));
    assert.ok(!/>\s*Hours Saved\s*</.test(dash), 'an unqualified "Hours Saved" label remains');
});

console.log('\nCard summaries for Campaign + Brand Designer');
check('get-assistants returns summaryMetrics and the card renders them', () => {
    assert.ok(getAssistants.includes('summaryMetrics: summaryMetrics.get(a.id) ?? null'));
    assert.ok(/summaryMetrics[\s\S]{0,400}items/.test(cards), 'card never reads summaryMetrics.items');
    assert.ok(cards.includes('summaryCountsHtml'));
});
check('summary queries run ONLY when someone has the role (one-connection pool)', () => {
    assert.ok(getAssistants.includes('if (campIds.length || brandIds.length)'));
    assert.ok((getAssistants.match(/!campIds\.length \? none/g) || []).length === 3);
    assert.ok((getAssistants.match(/!brandIds\.length \? none/g) || []).length === 2);
});
check('Brand Designer briefs waiting count toward "waiting for you"; campaign decisions are NOT double-counted', () => {
    const s = slice(getAssistants, 'if (campIds.length || brandIds.length)', 'Hourly rate');
    assert.ok(/pendingReviewCount/.test(s), 'brand waiting never added to pendingReview');
    assert.ok(!/pendingReviewCount[^\n]*dec/.test(s), 'campaign decisions added on top of their mirrors');
});
check('get-assistants has a raised timeout', () => {
    assert.ok(/\[functions\.get-assistants\]\s*\n\s*timeout = 26/.test(toml));
});

console.log('\nActionable Off Track');
const fnSrc = slice(cards, 'function _goalNextStep(', '\nwindow._buildAssistantCardGoals');
// eslint-disable-next-line no-new-func
const goalNextStep = new Function('_escapeHtml', '_fmtGoalValue', `${fnSrc}; return _goalNextStep;`)(
    (s: unknown) => String(s), (n: number, unit: string) => `${n}${unit === '%' ? '%' : ''}`,
) as (h: unknown, latest: number | null, target: number, tab: string) => string;
check('off track, increase goal → "N to go" and opens the goals tab', () => {
    const html = goalNextStep({ status: 'off_track', direction: 'increase' }, 4, 10, 'GOALS()');
    assert.ok(html.includes('6 to go'), html);
    assert.ok(html.includes('GOALS()'));
});
check('decrease goal → "N above target" (not "to go")', () => {
    const html = goalNextStep({ status: 'at_risk', direction: 'decrease' }, 15, 10, 'X');
    assert.ok(html.includes('5 above target'), html);
});
check('on track, unmeasured, or already past target → nothing', () => {
    assert.strictEqual(goalNextStep({ status: 'on_track' }, 4, 10, 'X'), '');
    assert.strictEqual(goalNextStep({ status: 'off_track' }, null, 10, 'X'), '');
    assert.strictEqual(goalNextStep({ status: 'off_track', direction: 'increase' }, 12, 10, 'X'), '');
});
check('get-assistants sends the goal direction the card relies on', () => {
    assert.ok(getAssistants.includes("direction: metric?.direction ?? 'increase'"));
});

console.log('\nWidgets: recent work, agenda, capacity');
const catalog = slice(dash, 'const CATALOG = {', '};');
check('all three are in the catalog, the order and DEFAULT_ON', () => {
    for (const k of ['recent-work', 'agenda', 'capacity']) {
        assert.ok(catalog.includes(`'${k}'`), `${k} not in CATALOG`);
        assert.ok(new RegExp(`'${k}':\\s*true`).test(dash), `${k} not default-on`);
        assert.ok(new RegExp(`const ORDER = \\[[^\\]]*'${k}'`).test(dash), `${k} not in ORDER`);
    }
});
check('a SAVED layout gets new widgets in their default state, not switched off', () => {
    const merge = slice(dash, 'function mergeCatalog(l) {', 'function save()');
    assert.ok(merge.includes('enabled: !!DEFAULT_ON[k]'), 'new widgets still arrive disabled for returning customers');
    assert.ok(!merge.includes('enabled: false'));
});
check('recent work reads every assistant (not notifications) and escapes what it shows', () => {
    const r = slice(dash, 'async function renderRecentWork(el)', 'async function renderAgenda');
    assert.ok(r.includes('/.netlify/functions/dashboard-recent-work'));
    assert.ok(r.includes('esc(x.description)') && r.includes('esc(x.assistantName)'), 'unescaped lead/web text');
});
check('agenda shows only BOOKED items — status scheduled in every source', () => {
    // The reading moved to src/utils/team-activity.ts (loadBooked) so chat shares it.
    assert.ok(read('netlify/functions/dashboard-agenda.ts').includes('loadBooked('));
    const fn = slice(read('src/utils/team-activity.ts'), 'export async function loadBooked(', '// ── The chat block');
    assert.strictEqual((fn.match(/\.status, 'scheduled'\)/g) || []).length, 3, 'a source not limited to scheduled rows');
    assert.ok(!/pending_approval|'draft'/.test(fn.replace(/\/\/.*$/gm, '')), 'agenda reads unbooked rows');
    const r = slice(dash, 'async function renderAgenda(el)', 'async function renderCapacity');
    assert.ok(r.includes('esc(x.label)'));
});
check('capacity reads the task cap and the credit balance', () => {
    const r = slice(dash, 'async function renderCapacity(el)', 'function renderTips');
    assert.ok(r.includes('check-capacity') && r.includes('get-ai-credit-balance'));
    assert.ok(r.includes('taskLimit') && r.includes('balance'));
});
check('the new endpoints have timeouts', () => {
    assert.ok(/\[functions\.dashboard-recent-work\]\s*\n\s*timeout = 26/.test(toml));
    assert.ok(/\[functions\.dashboard-agenda\]\s*\n\s*timeout = 26/.test(toml));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with FAILURES above' : ''}`);
