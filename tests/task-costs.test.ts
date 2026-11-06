// tests/task-costs.test.ts
// Task costs are set in Admin → Revenue → Task costs, not in code (owner, 2026-11-06). What goes wrong
// silently if these drift:
//   · a charge reading a number out of code, so the admin screen changes nothing
//   · applying the migration quietly changing what customers pay
//   · a future or draft change charging early, or a rise going out without its 30 days' notice
//   · chat's "messages per charge" treated backwards, so a rise looks like a cut
//   · a team member, or an admin impersonating, accepting for the workspace
// No network, no database.
//
// Run:  npx tsx tests/task-costs.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    COST_KEYS, DEFAULT_TASK_COSTS, DEFAULT_TASK_WEIGHTS, costValue, formatCost, isCostRise, type CostKey,
} from '../src/config/task-weights';
import { resolveTaskCosts, type CostRow } from '../src/utils/task-costs';
import { changeSummary, costInUse, earliestStart, noticeContext, noticeKey, validateChange } from '../src/utils/task-cost-changes';
import { NOTIFICATION_DEFAULTS } from '../src/utils/notification-templates-catalog';
import { TEMPLATE_DEFAULTS } from '../src/utils/email-templates-catalog';
import { hasPermission } from '../src/utils/rbac';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

const NOW = new Date('2026-11-06T12:00:00Z');
const row = (key: string, units: number, from: string, changeId = 2): CostRow => ({ key, units, changeId, effectiveFrom: new Date(`${from}T00:00:00Z`) });

// ── The migration changes nobody's charges ──────────────────────────────────────────────────────────

check('the starting costs in the migration equal the fallback, for every key', () => {
    const sql = read('db/z-task-costs.sql');
    const seeded = new Map([...sql.matchAll(/\(1, '([a-z_]+)', (\d+)\)/g)].map((m) => [m[1], Number(m[2])]));
    assert.strictEqual(seeded.size, COST_KEYS.length, 'one starting row per cost');
    for (const key of COST_KEYS) assert.strictEqual(seeded.get(key), costValue(DEFAULT_TASK_COSTS, key), key);
});

check('every kind of work is a cost that can be set', () => {
    for (const k of Object.keys(DEFAULT_TASK_WEIGHTS)) assert.ok(COST_KEYS.includes(k as CostKey), k);
});

// ── Which number applies when ───────────────────────────────────────────────────────────────────────

check('no rows at all means the fallback', () => {
    assert.deepStrictEqual(resolveTaskCosts([], NOW), DEFAULT_TASK_COSTS);
});

check('a change takes effect on its date, not before', () => {
    const rows = [row('ai_music', 20, '2026-10-17', 1), row('ai_music', 25, '2026-12-10')];
    assert.strictEqual(resolveTaskCosts(rows, NOW).weights.ai_music, 20, 'before');
    assert.strictEqual(resolveTaskCosts(rows, new Date('2026-12-09T23:59:59Z')).weights.ai_music, 20, 'the second before');
    assert.strictEqual(resolveTaskCosts(rows, new Date('2026-12-10T00:00:00Z')).weights.ai_music, 25, 'at midnight UTC');
});

check('the newest change in force wins, whatever order the rows come in', () => {
    const rows = [row('ai_music', 30, '2026-11-01', 3), row('ai_music', 20, '2026-10-17', 1), row('ai_music', 25, '2026-10-20', 2)];
    assert.strictEqual(resolveTaskCosts(rows, NOW).weights.ai_music, 30);
});

check('the two rates and a free cost resolve; rubbish in the table is ignored', () => {
    const c = resolveTaskCosts([
        row('ai_video_per_second', 5, '2026-11-01'), row('chat_messages_per_task', 5, '2026-11-01'), row('site_audit', 0, '2026-11-01'),
        row('nonsense', 9, '2026-11-01'), row('blog_article', -3, '2026-11-01'),
    ], NOW);
    assert.strictEqual(c.videoTasksPerSecond, 5);
    assert.strictEqual(c.chatMessagesPerTask, 5);
    assert.strictEqual(c.weights.site_audit, 0, 'zero is a real answer: free');
    assert.strictEqual(c.weights.blog_article, DEFAULT_TASK_WEIGHTS.blog_article);
});

check('zero messages per charge cannot reach the chat tally, which divides by it', () => {
    assert.strictEqual(resolveTaskCosts([row('chat_messages_per_task', 0, '2026-11-01')], NOW).chatMessagesPerTask, 1);
});

check('only baseline and announced changes count: a draft or cancelled change charges nobody', () => {
    assert.match(read('src/utils/task-costs.ts'), /WHERE c\.status IN \('baseline', 'announced'\)/);
});

// ── What a change must satisfy ──────────────────────────────────────────────────────────────────────

const reason = 'The AI music model costs us more to run.';
const good = { items: { ai_music: 25 }, effectiveDate: '2026-12-06', reason };

check('a rise needs 30 days: the 30th day is fine, the 29th is refused', () => {
    assert.strictEqual(earliestStart(true, NOW), '2026-12-06');
    assert.strictEqual(validateChange(good, DEFAULT_TASK_COSTS, NOW).ok, true);
    const early = validateChange({ ...good, effectiveDate: '2026-12-05' }, DEFAULT_TASK_COSTS, NOW);
    assert.ok(!early.ok && /30 days/.test(early.error));
});

check('a reduction can start tomorrow, but not today', () => {
    const cut = { items: { ai_music: 10 }, reason };
    assert.strictEqual(validateChange({ ...cut, effectiveDate: '2026-11-07' }, DEFAULT_TASK_COSTS, NOW).ok, true);
    assert.strictEqual(validateChange({ ...cut, effectiveDate: '2026-11-06' }, DEFAULT_TASK_COSTS, NOW).ok, false);
});

check('one rise among cuts means the whole change needs 30 days', () => {
    const r = validateChange({ items: { ai_music: 10, ai_image: 2 }, effectiveDate: '2026-11-20', reason }, DEFAULT_TASK_COSTS, NOW);
    assert.strictEqual(r.ok, false);
});

check('fewer messages per chat charge is a RISE; more is a cut', () => {
    assert.strictEqual(isCostRise('chat_messages_per_task', 10, 5), true);
    assert.strictEqual(isCostRise('chat_messages_per_task', 10, 20), false);
    assert.strictEqual(isCostRise('ai_music', 20, 25), true);
    assert.strictEqual(isCostRise('ai_music', 20, 10), false);
});

check('refuses: no change, unknown cost, fractions, negatives, too high, no reason, no date', () => {
    const bad = [
        { ...good, items: {} }, { ...good, items: { ai_music: 20 } }, { ...good, items: { nonsense: 1 } },
        { ...good, items: { ai_music: 1.5 } }, { ...good, items: { ai_music: -1 } }, { ...good, items: { ai_music: 1001 } },
        { ...good, reason: 'short' }, { ...good, reason: 'x'.repeat(601) }, { ...good, effectiveDate: 'soon' }, { ...good, effectiveDate: undefined },
    ];
    for (const input of bad) assert.strictEqual(validateChange(input, DEFAULT_TASK_COSTS, NOW).ok, false, JSON.stringify(input));
});

check('old figures come from today\'s costs, never from what the browser sent', () => {
    const r = validateChange({ ...good, oldUnits: 1 } as any, { ...DEFAULT_TASK_COSTS, weights: { ...DEFAULT_TASK_COSTS.weights, ai_music: 22 } }, NOW);
    assert.ok(r.ok && r.items[0].oldUnits === 22);
});

check('a cost nobody is charged needs no notice; a dated switch counts as told', () => {
    const had = { b: process.env.BASIC_WORK_CHARGED_FROM, v: process.env.AI_VIDEO_PRICED_BY_SECOND };
    try {
        delete process.env.BASIC_WORK_CHARGED_FROM;
        delete process.env.AI_VIDEO_PRICED_BY_SECOND;
        assert.strictEqual(costInUse('chat_messages', NOW), false);
        assert.strictEqual(costInUse('ai_video_per_second', NOW), false);
        assert.strictEqual(costInUse('ai_video', NOW), true, 'flat video is what is charged');
        assert.strictEqual(costInUse('social_post', NOW), true);
        const r = validateChange({ ...good, items: { chat_messages: 2 } }, DEFAULT_TASK_COSTS, NOW);
        assert.ok(!r.ok && /Nobody is charged/.test(r.error));

        process.env.BASIC_WORK_CHARGED_FROM = '2027-01-01';
        assert.strictEqual(costInUse('chat_messages', NOW), true, 'a date in the future: that notice has gone out');
        process.env.AI_VIDEO_PRICED_BY_SECOND = '2026-12-03';
        assert.strictEqual(costInUse('ai_video_per_second', NOW), true);
        assert.strictEqual(costInUse('ai_video', NOW), true, 'flat video is still charged until the 3rd');
        process.env.AI_VIDEO_PRICED_BY_SECOND = 'on';
        assert.strictEqual(costInUse('ai_video', NOW), false, 'flat video no longer charged');
    } finally {
        if (had.b === undefined) delete process.env.BASIC_WORK_CHARGED_FROM; else process.env.BASIC_WORK_CHARGED_FROM = had.b;
        if (had.v === undefined) delete process.env.AI_VIDEO_PRICED_BY_SECOND; else process.env.AI_VIDEO_PRICED_BY_SECOND = had.v;
    }
});

// ── The words customers read ────────────────────────────────────────────────────────────────────────

check('costs read as customers would say them', () => {
    assert.strictEqual(formatCost('ai_image', 1), '1 task');
    assert.strictEqual(formatCost('ai_music', 20), '20 tasks');
    assert.strictEqual(formatCost('ai_music', 0), 'no tasks');
    assert.strictEqual(formatCost('ai_video_per_second', 4), '4 tasks a second');
    assert.strictEqual(formatCost('chat_messages_per_task', 10), 'every 10 messages');
    assert.strictEqual(changeSummary([{ key: 'ai_music', oldUnits: 20, newUnits: 25 }]), 'AI music: 20 tasks → 25 tasks.');
});

check('the notice has an in-app and an email template, carrying the date, figures, reason and a way to accept', () => {
    const inApp = NOTIFICATION_DEFAULTS.find((t) => t.templateKey === 'task_cost_change')!;
    const email = TEMPLATE_DEFAULTS.find((t) => t.triggerKey === 'task_cost_change')!;
    assert.ok(inApp && email, 'both exist');
    assert.strictEqual(email.transactional, true, 'a notice is not marketing');
    for (const v of ['{{change.date}}', '{{change.summary}}', '{{change.reason}}']) {
        assert.ok(inApp.message.includes(v), `in-app: ${v}`);
        assert.ok(email.bodyHtml.includes(v), `email: ${v}`);
    }
    assert.match(email.bodyHtml, /review and accept/i);
    assert.match(email.bodyHtml, /cancel/i, 'terms 20.3: the remedy is to cancel');
    assert.ok(email.bodyHtml.includes('change.review_url'));
    assert.ok(NOTIFICATION_DEFAULTS.some((t) => t.templateKey === 'task_cost_change_cancelled'));
    assert.ok(TEMPLATE_DEFAULTS.some((t) => t.triggerKey === 'task_cost_change_cancelled'));
});

check('each change has its own once-each mark, and the link opens the review', () => {
    assert.notStrictEqual(noticeKey(2), noticeKey(3));
    const c = noticeContext({ id: 2, effectiveDate: '2026-12-06', reason, items: [{ key: 'ai_music', oldUnits: 20, newUnits: 25 }] }, 'https://bemoreswan.com');
    assert.strictEqual(c.change.date, '6 December 2026');
    assert.strictEqual(c.change.review_url, 'https://bemoreswan.com/workspace.html?review=task-costs');
    assert.match(read('notifications.js'), /task_cost_change_\\d\+\$/);
});

// ── Who can do what ─────────────────────────────────────────────────────────────────────────────────

check('only a super admin can change costs, never during impersonation, never on sandbox', () => {
    assert.strictEqual(hasPermission('super_admin', 'manage_task_costs'), true);
    for (const r of ['platform_admin', 'billing_admin', 'support_agent', 'member']) assert.strictEqual(hasPermission(r, 'manage_task_costs'), false, r);
    const fn = read('netlify/functions/admin-task-costs.ts');
    assert.match(fn, /requirePermission\(admin\.role, 'manage_task_costs'\)/);
    assert.match(fn, /tok\.scope === 'impersonate'/);
    assert.match(fn, /resolveEnvironment\(.*\) !== 'live'/s);
});

check('announcing re-checks the rules and the count, and a failed start leaves it a draft', () => {
    const fn = read('netlify/functions/admin-task-costs.ts');
    const announce = fn.slice(fn.indexOf("resource === 'announce'"), fn.indexOf("resource === 'resend'"));
    assert.match(announce, /body\.expected !== waiting/);
    assert.match(announce, /validateChange\(/);
    assert.match(announce, /status = 'draft', announced_at = NULL/);
});

check('only the workspace owner accepts; a team member or impersonating admin gets no prompt', () => {
    const fn = read('netlify/functions/task-cost-review.ts');
    assert.match(fn, /requireTenant\(event, db, \{ roles: \['owner'\], mutates: true \}\)/);
    assert.match(fn, /ctx\.impersonation \|\| ctx\.role !== 'owner'/);
});

check('a prompt that has started cannot be dismissed, but Billing stays reachable', () => {
    const ws = read('workspace.html');
    const part = ws.slice(ws.indexOf('id="modal-task-cost-review"'), ws.indexOf('<!-- US-GOV-1.2.1'));
    assert.match(part, /tcr-later'\)\.style\.display = state\.mustAccept \? 'none'/);
    assert.match(part, /window\._currentViewKey !== 'billing'/);
    assert.match(part, /window\.loadView\?\.\('billing'\)/);
});

// ── Nothing reads a cost out of code ────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(join(root, dir))) {
        const p = `${dir}/${name}`;
        if (statSync(join(root, p)).isDirectory()) walk(p, out);
        else if (/\.(ts|js)$/.test(name)) out.push(p);
    }
    return out;
}

check('outside the fallback, no server code reads DEFAULT_TASK_* to charge or quote', () => {
    const offenders = [...walk('src'), ...walk('netlify/functions')]
        .filter((p) => !['src/config/task-weights.ts', 'src/utils/task-costs.ts'].includes(p))
        .filter((p) => /DEFAULT_TASK_(WEIGHTS|COSTS)/.test(read(p)));
    assert.deepStrictEqual(offenders, []);
});

check('public pages show live figures, keep readable text, and load the script', () => {
    for (const page of ['pricing.html', 'faq.html']) {
        const html = read(page);
        assert.match(html, /<script src="\/task-costs\.js"/, page);
        assert.match(html, /data-task-cost="ai_video">20 tasks</, page);
        assert.match(html, /data-task-cost="x_link_post">10 tasks</, page);
    }
    assert.match(read('netlify/functions/task-costs.ts'), /getTaskCosts\(\)/);
});

check('the admin page is reachable: section, nav and loader', () => {
    const html = read('admin.html');
    assert.match(html, /id="view-task-costs"/);
    assert.match(html, /view: 'task-costs'.*perm: 'manage_task_costs'/);
    assert.match(html, /view === 'task-costs'\)\s+loadTaskCostsAdmin\(\)/);
});

console.log(`\n✓ task-costs: ${passed} checks passed`);
