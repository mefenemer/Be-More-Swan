// tests/site-audit-schedule.test.ts
// The Mystery Shopper's weekly loop (docs/mystery-shopper-plan.md step 4): which audits are due
// (src/utils/site-audit-schedule.ts), that the job is actually scheduled on prod AND staging, and the
// pipeline rules that arrived with it — fixes verified only against their own page, a mid-run page
// change never overwriting the new page's score, the goal reached once, and the alerts.
//
// Run:  npx tsx tests/site-audit-schedule.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asUtcDate, CATCH_UP_DAYS, isDue, nextCheckDate, ukDay } from '../src/utils/site-audit-schedule';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// 2026-10-19 is a Monday. 06:30 UTC = 07:30 BST.
const MON_0630 = new Date('2026-10-19T06:30:00Z');
const MONDAY = 1;
const daysBefore = (d: Date, n: number) => new Date(d.getTime() - n * 86_400_000);

console.log('\nWhich audits are due');

check('UK day, not UTC day: 23:30 UTC on Sunday in BST is already Monday', () => {
    assert.deepStrictEqual(ukDay(new Date('2026-10-18T23:30:00Z')), { weekday: 1, date: '2026-10-19' });
    assert.deepStrictEqual(ukDay(new Date('2026-12-20T23:30:00Z')), { weekday: 0, date: '2026-12-20' }, 'GMT: still Sunday');
});

check('due on its check day; not on another day within the week', () => {
    assert.ok(isDue({ checkWeekday: MONDAY, lastCheckAt: daysBefore(MON_0630, 7) }, MON_0630));
    assert.ok(!isDue({ checkWeekday: 3, lastCheckAt: daysBefore(MON_0630, 2) }, MON_0630));
});

check('never twice in one UK day — a same-day re-poke queues nothing', () => {
    assert.ok(!isDue({ checkWeekday: MONDAY, lastCheckAt: new Date('2026-10-19T05:00:00Z') }, MON_0630));
});

check(`a missed or failed week is caught up after ${CATCH_UP_DAYS} days, whatever the day`, () => {
    const tue = new Date('2026-10-20T06:30:00Z');
    assert.ok(isDue({ checkWeekday: MONDAY, lastCheckAt: daysBefore(tue, CATCH_UP_DAYS) }, tue));
    assert.ok(!isDue({ checkWeekday: MONDAY, lastCheckAt: daysBefore(tue, CATCH_UP_DAYS - 1) }, tue));
});

check('set up but never checked: due today', () => {
    assert.ok(isDue({ checkWeekday: 5, lastCheckAt: null }, MON_0630));
});

check('next check date: today if not yet checked, else next week; otherwise the coming check day', () => {
    assert.strictEqual(nextCheckDate({ checkWeekday: MONDAY, lastCheckAt: daysBefore(MON_0630, 7) }, MON_0630), '2026-10-19');
    assert.strictEqual(nextCheckDate({ checkWeekday: MONDAY, lastCheckAt: new Date('2026-10-19T06:31:00Z') }, new Date('2026-10-19T09:00:00Z')), '2026-10-26');
    assert.strictEqual(nextCheckDate({ checkWeekday: 5, lastCheckAt: null }, MON_0630), '2026-10-23');
});

check('a raw-SQL timestamp is read as UTC whether it arrives as a Date or text', () => {
    const d = new Date('2026-10-19T06:30:00Z');
    assert.strictEqual(asUtcDate(d)?.toISOString(), d.toISOString());
    assert.strictEqual(asUtcDate('2026-10-19 06:30:00')?.toISOString(), d.toISOString());
    assert.strictEqual(asUtcDate('2026-10-19T07:30:00+01:00')?.toISOString(), d.toISOString());
    assert.strictEqual(asUtcDate(null), null);
    assert.strictEqual(asUtcDate('nonsense'), null);
});

console.log('\nIt actually runs (prod and staging)');

const schedule = read('src/utils/site-audit-schedule.ts');
const toml = read('netlify.toml');
const crons = read('.github/workflows/staging-crons.yml');
const wrapper = read('netlify/functions/run-site-audit-dispatch.ts');

check('prod: a Netlify schedule entry for the dispatcher, daily', () => {
    assert.match(toml, /\[functions\.dispatch-site-audits\]\s*\n\s*schedule = "30 6 \* \* \*"/);
});

check('staging: the cron workflow pokes the wrapper (it never fires Netlify schedules)', () => {
    assert.match(crons, /^\s+run-site-audit-dispatch\s+\d+\s+\d+$/m);
});

check('the wrapper fails CLOSED without its secret, and reports a check it could not start as a failure', () => {
    assert.match(wrapper, /if \(!secret\)[\s\S]{0,200}statusCode: 503/);
    assert.match(wrapper, /statusCode: result\.failedToStart \? 500 : 200/);
});

check('only working assistants and unpaused audits are checked', () => {
    assert.match(schedule, /inArray\(siteAudits\.status, \['active', 'goal_met'\]\)/);
    assert.match(schedule, /eq\(aiAssistants\.isActive, true\)/);
    assert.match(schedule, /inArray\(aiAssistants\.lifecycleStatus, WORKING_STATES\)/);
    assert.match(schedule, /const WORKING_STATES = \['ready_for_work', 'working'\];/);
});

check('a failed check does not count as "checked" — it is retried', () => {
    assert.match(schedule, /r\.status <> 'failed'/);
});

check('no Date is bound into raw SQL (memory: raw-sql-date-param-trap)', () => {
    for (const f of ['src/utils/site-audit-schedule.ts', 'netlify/functions/site-audits.ts', 'src/utils/site-audit.ts']) {
        const src = read(f);
        for (const m of src.matchAll(/sql`[^`]*`/g)) {
            assert.ok(!/\$\{(from|to|now|cutoff|date|at)\}/.test(m[0]), `${f}: ${m[0].slice(0, 80)}`);
        }
    }
});

console.log('\nPipeline rules that came with the loop');

const pipeline = read('src/utils/site-audit.ts');
const setup = read('src/utils/site-audit-setup.ts');

check('a fix is only verified against ITS page', () => {
    assert.match(pipeline, /\(\$\{siteAuditFixes\.pageUrl\} IS NULL OR \$\{siteAuditFixes\.pageUrl\} = \$\{audit\.url\}\)/);
    assert.match(pipeline, /impact: p\.impact, pageUrl: audit\.url,/);
});

check('a run never writes its score onto a page it did not read', () => {
    const guards = pipeline.match(/\.where\(and\(eq\(siteAudits\.id, audit\.id\), eq\(siteAudits\.url, audit\.url\)\)\)/g) || [];
    assert.strictEqual(guards.length, 2, 'both audit updates are guarded by the url');
});

check('changing the page starts the scores again and runs a fresh first check', () => {
    assert.match(setup, /pageChanged \? \{ baselineScore: null, currentScore: null, lastHashes: \{\}, lastRunId: null, status: 'active' \}/);
    assert.match(setup, /if \(!opts\.pageChanged && await hasAnyRun/);
});

check('the goal is reached once (active → goal_met), and its notification is sent then', () => {
    assert.match(pipeline, /const reachedGoal = audit\.status === 'active' && outcome\.score\.overall !== null && outcome\.score\.overall >= audit\.targetScore;/);
    assert.match(pipeline, /if \(reachedGoal\) \{\s*await notify\('site_audit_goal_met'/);
});

check('a competitor change gets its own alert; a weekly check where only a competitor moved does not also send "ready"', () => {
    assert.match(pipeline, /if \(moved\.length\) \{[\s\S]{0,200}notify\('site_audit_competitor_change'/);
    assert.match(pipeline, /if \(!reachedGoal && \(kind !== 'weekly' \|\| ownSiteChanged\)\)/);
});

check('both new notifications are registered in all five places', () => {
    for (const type of ['site_audit_competitor_change', 'site_audit_goal_met']) {
        assert.ok(read('src/utils/notification-prefs.ts').includes(`'${type}'`), `prefs: ${type}`);
        assert.ok(read('src/utils/notification-actions.ts').includes(`${type}: 'state_change'`), `actions: ${type}`);
        assert.ok(read('src/utils/notification-templates-catalog.ts').includes(`templateKey: '${type}'`), `catalog: ${type}`);
        assert.ok(read('db/notifications-categorization.sql').includes(`WHEN '${type}' THEN 'state_change'`), `sql: ${type}`);
        assert.ok(pipeline.includes(`'${type}'`), `call site: ${type}`);
    }
    assert.match(pipeline, /category: 'state_change',\s*context: \{ assistant: \{ name: assistant\.name \}, \.\.\.context \},\s*metadata: \{ assistantId: assistant\.id/);
});

check('the page_url column is in the schema mirror and its migration', () => {
    assert.match(read('db/schema.ts'), /pageUrl: text\("page_url"\)/);
    assert.match(read('db/z-mystery-shopper-weekly.sql'), /ADD COLUMN IF NOT EXISTS page_url TEXT/);
});

console.log(`\n${passed}/${total} passed`);
