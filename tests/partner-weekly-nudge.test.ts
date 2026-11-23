// tests/partner-weekly-nudge.test.ts
// The Monday summary from a partner's Partner Assistant + the "In free trial" count
// (docs/partner-onboarding-plan.md §3.5–3.6, Phase 3).
//
// WHY THIS EXISTS (2026-11-23). It emails real partners every week, so it must be: once per week (even
// if two runs overlap), never after they turn it off, quiet after 8 weeks unless something happened,
// built from their numbers (no model call), and its button may only open the chat with a question WE
// wrote. These tests pin those rules.
//
// Run:  npx tsx tests/partner-weekly-nudge.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASK_PROMPTS, NUDGE_WEEKS, buildNudge, hadActivity, isoWeek, nudgeDecision, weeklyAction } from '../src/utils/partner-weekly-nudge';
import { buildChecklist } from '../src/utils/partner-onboarding';
import { getNotificationDefault } from '../src/utils/notification-templates-catalog';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const now = new Date('2026-11-23T08:10:00Z');   // a Monday
const quiet = { clicks_7d: 0, signups_7d: 0, paying_7d: 0, earned_7d_pence: 0 };
const base = { status: 'approved', userId: 59, marks: {}, stats: quiet, now };

console.log('who gets one');

check('ISO weeks: Monday 23 Nov 2026 is W48; Sunday 3 Jan 2027 still belongs to 2026-W53', () => {
    assert.strictEqual(isoWeek(now), '2026-W48');
    assert.strictEqual(isoWeek(new Date('2026-11-29T23:00:00Z')), '2026-W48');
    assert.strictEqual(isoWeek(new Date('2026-11-30T00:00:00Z')), '2026-W49');
    assert.strictEqual(isoWeek(new Date('2027-01-03T12:00:00Z')), '2026-W53');
});

check('first weeks: sent even when quiet', () => {
    assert.deepStrictEqual(nudgeDecision(base), { send: true });
    assert.deepStrictEqual(nudgeDecision({ ...base, marks: { nudge_started_at: '2026-10-20T08:00:00Z' } }), { send: true });
});

check(`after ${NUDGE_WEEKS} weeks: only in a week with activity`, () => {
    const old = { nudge_started_at: '2026-09-01T08:00:00Z' };
    assert.deepStrictEqual(nudgeDecision({ ...base, marks: old }), { send: false, reason: 'quiet_after_first_weeks' });
    assert.deepStrictEqual(nudgeDecision({ ...base, marks: old, stats: { ...quiet, clicks_7d: 3 } }), { send: true });
    assert.ok(hadActivity({ earned_7d_pence: 1 }) && !hadActivity(quiet));
});

check('never when off, already sent this week, not approved, or no account', () => {
    assert.deepStrictEqual(nudgeDecision({ ...base, marks: { weekly_nudge_off_at: 'x' } }), { send: false, reason: 'turned_off' });
    assert.deepStrictEqual(nudgeDecision({ ...base, marks: { last_nudge_week: '2026-W48' } }), { send: false, reason: 'already_sent' });
    assert.deepStrictEqual(nudgeDecision({ ...base, marks: { last_nudge_week: '2026-W47' } }), { send: true });
    for (const status of ['suspended', 'ended', 'applied']) assert.deepStrictEqual(nudgeDecision({ ...base, status }), { send: false, reason: 'not_approved' });
    assert.deepStrictEqual(nudgeDecision({ ...base, userId: null }), { send: false, reason: 'no_account' });
});

console.log('what it says');

check('the numbers, plainly, with earnings only when there are some', () => {
    const steps = buildChecklist({ termsAccepted: true, payoutSet: true, invitePageLive: true, marks: { first_draft_at: 'x', link_copied_at: 'y' }, stats: { clicks_all: 20, signups: 3, paying: 1 } });
    const n = buildNudge({ firstName: 'Angela', steps, stats: { clicks_7d: 12, signups_7d: 2, in_trial: 1, paying_7d: 1, earned_7d_pence: 3160, clicks_all: 20, signups: 3, paying: 1 } });
    assert.strictEqual(n.summary, 'Last 7 days: 12 visits, 2 sign-ups, 1 in a free trial now, 1 new paying customer, and £31.60 earned.');
    assert.strictEqual(n.title, 'Your week as a partner: 12 visits, 2 sign-ups');
    const q = buildNudge({ firstName: null, steps, stats: { ...quiet, in_trial: 0 } });
    assert.ok(q.summary.endsWith('0 new paying customers.') && !q.summary.includes('earned'));
    assert.strictEqual(q.title, 'Your week as a partner: one thing to try');
});

check('one action, in order: Terms → people in trial → invite page → first post → no sign-ups → next', () => {
    const at = (o: Parameters<typeof buildChecklist>[0], stats: Record<string, number>) => weeklyAction(buildChecklist(o), stats).key;
    const marks = { first_draft_at: 'x', link_copied_at: 'y' };
    assert.strictEqual(at({ termsAccepted: false, payoutSet: false, marks: {}, stats: null }, {}), 'terms');
    assert.strictEqual(at({ termsAccepted: true, payoutSet: true, marks, stats: null }, { in_trial: 2 }), 'trial');
    assert.strictEqual(at({ termsAccepted: true, payoutSet: true, marks, stats: null }, {}), 'invite_page');
    assert.strictEqual(at({ termsAccepted: true, payoutSet: true, invitePageLive: true, marks: {}, stats: null }, {}), 'first_post');
    assert.strictEqual(at({ termsAccepted: true, payoutSet: true, invitePageLive: true, marks, stats: null }, { clicks_all: 9 }), 'no_signups');
    assert.strictEqual(at({ termsAccepted: true, payoutSet: true, invitePageLive: true, marks, stats: null }, { clicks_all: 9, signups: 2, paying: 1 }), 'next');
    assert.ok(weeklyAction(buildChecklist({ termsAccepted: true, payoutSet: true, marks, stats: null }), { in_trial: 1 }).line.startsWith('1 person is in their free trial'));
});

check('every action key has a question we wrote (the button can open nothing else)', () => {
    for (const k of ['terms', 'trial', 'invite_page', 'first_post', 'no_signups', 'next']) assert.ok(ASK_PROMPTS[k], k);
});

console.log('wiring');

check('the run claims the week BEFORE sending (overlapping runs send once)', () => {
    const fn = read('netlify/functions/partner-weekly-nudge.ts');
    const claim = fn.indexOf("jsonb_build_object('last_nudge_week'");
    assert.ok(claim > 0 && claim < fn.indexOf("createNotification(db, 'partner_weekly_summary'"));
    assert.ok(fn.includes("IS DISTINCT FROM ${week}"));
    assert.ok(fn.includes("COALESCE(${partners.onboarding}->>'nudge_started_at'"), 'the 8 weeks start at the first summary, once');
    assert.ok(!/anthropic|messages\.create/i.test(fn), 'no model call');
});

check('scheduled on prod; staging poked weekly; trigger fails closed', () => {
    assert.match(read('netlify.toml'), /\[functions\.partner-weekly-nudge\]\s+schedule = "10 8 \* \* 1"/);
    assert.match(read('.github/workflows/staging-crons.yml'), /^\s+run-partner-weekly-nudge\s+604800\s+\d+$/m);
    const run = read('netlify/functions/run-partner-weekly-nudge.ts');
    assert.ok(run.includes("if (!secret)") && run.includes("token !== secret"));
});

check('one-click off on the Partner page; the email says so and can be unsubscribed', () => {
    const hub = read('netlify/functions/partner-hub.ts');
    assert.ok(hub.includes("body.action === 'weekly_nudge'") && hub.includes("'weekly_nudge_off_at'"));
    const page = read('partner-content.html');
    assert.ok(page.includes("post({ action: 'weekly_nudge', on: box.checked })"));
    const email = read('src/utils/email-templates-catalog.ts');
    const block = email.slice(email.indexOf("triggerKey: 'partner_weekly_summary'"), email.indexOf("triggerKey: 'partner_approved_create_account'"));
    assert.ok(block.includes('transactional: false'), 'carries the unsubscribe link');
    assert.ok(block.includes('You can turn it off on your Partner page'));
    assert.ok(getNotificationDefault('partner_weekly_summary'));
});

check('?ask= only fills a whitelisted question from the server — never text from the URL', () => {
    const ws = read('workspace.html');
    assert.ok(ws.includes("askParam && /^[a-z_]{2,20}$/.test(askParam)) window._partnerAsk = askParam;"));
    const page = read('partner-content.html');
    assert.ok(page.includes('const askText = askKey && data.onboarding?.askPrompts?.[askKey];'));
    assert.ok(!page.includes('input.value = askKey'), 'the key is never shown');
    assert.ok(page.includes("if (!input.disabled) { input.value = askText;"), 'filled, never sent');
});

check('"In free trial" is a count of their own invitees in an open trial, never names', () => {
    const ops = read('src/utils/partner-ops.ts');
    const q = ops.slice(ops.indexOf('who is in the free trial right now'), ops.indexOf('AS in_trial'));
    assert.ok(q.includes('JOIN trials t ON t.user_id = ur.referred_user_id'));
    assert.ok(q.includes('t.ended_at IS NULL AND t.converted_at IS NULL AND t.ends_at > now()'));
    assert.ok(q.includes('COUNT(*)') && !/email|first_name/.test(q));
    assert.ok(read('partner-content.html').includes('id="pt-trial"'));
});

console.log(`\n${passed} passed`);
