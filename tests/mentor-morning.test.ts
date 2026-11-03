// tests/mentor-morning.test.ts
// The Business Mentor's morning summary (docs/morning-summary-plan.md; src/utils/mentor-morning.ts).
//
//   - Due 07:00–11:59 in the workspace's own time zone, once a day, never in Quiet mode or when off.
//   - "Yesterday" and "today" are the workspace's calendar days, across a clock change.
//   - Every section is left out when empty; with nothing at all, nothing is sent.
//   - Built by rules: no model is imported, no task is spent; it never claims to see phone calls.
//   - Wired: notification type in all four places, email off by default, hourly prod schedule + staging
//     poke, chat reads its settings, the 09:00 digest skips whoever was emailed it.
//
// Run:  npx tsx tests/mentor-morning.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    buildMorningSummary, captionStart, dayWindows, isMorningDue, localNow, money, morningEmailVars, morningMessage, morningSettings,
    renderMorningSettingsForMentor, safeTimeZone, type MorningInputs,
} from '../src/utils/mentor-morning';
import { buildDefaults, categoryForType } from '../src/utils/notification-prefs';
import { categoryOf } from '../src/utils/notification-actions';
import { getTemplateDefault } from '../src/utils/email-templates-catalog';
import { changeableSetupFields } from '../src/utils/setup-field';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const none = (over: Partial<MorningInputs> = {}): MorningInputs => ({
    sales: [], deposits: { count: 0, totalPence: 0 }, won: null, bookingsToday: 0, bookingRequests: 0,
    enquiriesOpen: 0, enquiriesYesterday: 0, postsAwaitingReview: 0, actionsAwaiting: 0, openSuggestions: 0, bestPost: null, ...over,
});

console.log('\nmentor-morning');

test('settings: on unless switched off; Quiet mode stops it', () => {
    assert.deepStrictEqual(morningSettings(undefined), { on: true, quiet: false });
    assert.deepStrictEqual(morningSettings({ morningSummary: 'off' }), { on: false, quiet: false });
    assert.deepStrictEqual(morningSettings({ quietMode: 'on' }), { on: true, quiet: true });
});

test('due from 07:00 to 11:59 local, never twice, never off or quiet', () => {
    const on = { on: true, quiet: false };
    assert.strictEqual(isMorningDue(on, 6, false), false);
    assert.strictEqual(isMorningDue(on, 7, false), true);
    assert.strictEqual(isMorningDue(on, 11, false), true);
    assert.strictEqual(isMorningDue(on, 12, false), false, 'never an afternoon "morning" summary');
    assert.strictEqual(isMorningDue(on, 8, true), false);
    assert.strictEqual(isMorningDue({ on: false, quiet: false }, 8, false), false);
    assert.strictEqual(isMorningDue({ on: true, quiet: true }, 8, false), false);
});

test('local time: London in BST, New York, and a bad zone falls back to London', () => {
    const at = new Date('2026-07-01T06:30:00Z');
    assert.deepStrictEqual(localNow(at, 'Europe/London'), { date: '2026-07-01', hour: 7 });
    assert.deepStrictEqual(localNow(at, 'America/New_York'), { date: '2026-07-01', hour: 2 });
    assert.strictEqual(safeTimeZone('Not/AZone'), 'Europe/London');
    assert.strictEqual(safeTimeZone(null), 'Europe/London');
    assert.strictEqual(safeTimeZone('Asia/Tokyo'), 'Asia/Tokyo');
});

test('yesterday across the October clock change is 25 hours long', () => {
    const w = dayWindows('2026-10-26', 'Europe/London');
    assert.strictEqual(w.yesterdayStart.toISOString(), '2026-10-24T23:00:00.000Z');
    assert.strictEqual(w.todayStart.toISOString(), '2026-10-26T00:00:00.000Z');
    assert.strictEqual(w.tomorrowStart.toISOString(), '2026-10-27T00:00:00.000Z');
});

test('nothing to say → no sections (nothing is sent)', () => {
    assert.strictEqual(buildMorningSummary(none(), '2026-11-02').sections.length, 0);
    // A won-deal source with 0 wins is still nothing.
    assert.strictEqual(buildMorningSummary(none({ won: { count: 0, valueGbp: 0 } }), '2026-11-02').sections.length, 0);
});

test('a full morning: every section, in order, with a short headline', () => {
    const s = buildMorningSummary(none({
        sales: [{ currency: 'gbp', count: 2, total: 8500 }], deposits: { count: 1, totalPence: 1000 }, won: { count: 1, valueGbp: 1200 },
        bookingsToday: 3, bookingRequests: 1, enquiriesOpen: 2, enquiriesYesterday: 1, postsAwaitingReview: 4, actionsAwaiting: 1, openSuggestions: 1,
        bestPost: { assistantId: 7, assistantName: 'Sam', platform: 'instagram', interactions: 42, caption: 'Our autumn grooming offer is back for one week only, book now' },
    }), '2026-11-02');
    assert.deepStrictEqual(s.sections.map((x) => x.key), ['money', 'today', 'enquiries', 'needs_you', 'next']);
    assert.strictEqual(s.headline, '2 sales · 1 deal won · 3 bookings today · 2 enquiries');
    assert.deepStrictEqual(s.sections[0].lines, ['2 website sales, £85', '1 booking deposit paid, £10', '1 deal marked won, £1,200']);
    assert.match(s.sections[3].lines.join('|'), /4 posts to review.*1 action waiting for your approval.*1 suggestion from me/);
    assert.match(s.sections[4].lines[0], /42 interactions on Instagram\. Ask Sam for another like it\./);
    const msg = morningMessage(s);
    assert.match(msg, /^Your morning summary — Monday 2 November/);
    assert.match(msg, /\n• 3 bookings today/);
});

test('only things waiting → the headline says so', () => {
    const s = buildMorningSummary(none({ postsAwaitingReview: 2, openSuggestions: 1 }), '2026-11-02');
    assert.strictEqual(s.headline, '3 things waiting for you');
});

test('money and captions format plainly', () => {
    assert.strictEqual(money(8550), '£85.50');
    assert.strictEqual(money(1200, 'eur'), '€12');
    assert.strictEqual(captionStart('short'), 'short');
    assert.ok(captionStart('word '.repeat(40)).endsWith('…'));
});

test('email slots: one plain line per section, empty when absent', () => {
    const v = morningEmailVars(buildMorningSummary(none({ enquiriesOpen: 1 }), '2026-11-02'));
    assert.strictEqual(v.enquiries, 'Enquiries: 1 website enquiry to answer (Website ▸ Enquiries)');
    assert.strictEqual(v.money, '');
    const t = getTemplateDefault('mentor_morning_summary')!;
    for (const k of ['money', 'today', 'enquiries', 'needs_you', 'next']) assert.ok(t.bodyHtml.includes(`{{morning.${k}}}`), k);
});

test('built by rules: no model, no task, never claims phone calls', () => {
    const src = read('src/utils/mentor-morning.ts');
    assert.ok(!/@anthropic-ai|openai|recordCompletedWork|consumeTaskCredit/.test(src), 'no model and no task spend');
    const all = JSON.stringify(buildMorningSummary(none({ sales: [{ currency: 'gbp', count: 1, total: 100 }] }), '2026-11-02'));
    assert.ok(!/call/i.test(all));
    assert.match(renderMorningSettingsForMentor(5, {}), /cannot see phone calls/);
    assert.match(renderMorningSettingsForMentor(5, {}), /key "morningSummary"/);
});

test('notification type: same category in TS, SQL and prefs; email off by default', () => {
    assert.strictEqual(categoryOf('mentor_morning_summary'), 'state_change');
    assert.match(read('db/notifications-categorization.sql'), /WHEN 'mentor_morning_summary' THEN 'state_change'/);
    assert.strictEqual(categoryForType('mentor_morning_summary').key, 'mentor_morning_summary');
    assert.strictEqual(buildDefaults('email').mentor_morning_summary, false);
    assert.strictEqual(buildDefaults('inApp').mentor_morning_summary, true);
    assert.match(read('src/utils/notification-templates-catalog.ts'), /templateKey: 'mentor_morning_summary'/);
    assert.match(read('notifications.js'), /notif\.type === 'mentor_morning_summary'[\s\S]{0,300}openAssistantChat/);
});

test('the set-up card can switch it, and the chat reads it', () => {
    assert.ok(changeableSetupFields('business_mentor').map((f) => f.key).includes('morningSummary'));
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.match(orch, /renderMorningSettingsForMentor\(session\.aiAssistantId/);
    assert.match(orch, /latestMorningForMentor\(db, orgId\)/);
});

test('scheduled hourly on prod, poked on staging; the digest skips whoever was emailed', () => {
    assert.match(read('netlify.toml'), /\[functions\.dispatch-mentor-mornings\]\n\s+schedule = "7 \* \* \* \*"/);
    assert.match(read('.github/workflows/staging-crons.yml'), /run-mentor-morning-dispatch 3600/);
    const digest = read('netlify/functions/pending-actions-digest.ts');
    assert.match(digest, /emailedMorningUserIds\(db/);
    assert.match(digest, /hadMorning\.has\(Number\(row\.userId\)\)\) continue/);
});

test('an archived assistant\'s waiting work is left out; its sales and confirmed bookings stay', () => {
    // 2026-11-03: "1 website enquiry to answer (Website ▸ Enquiries)" for an archived Website Assistant.
    const m = read('src/utils/mentor-morning.ts');
    assert.match(m, /eq\(siteEnquiries\.organisationId, orgId\), notFromArchivedSite\(siteEnquiries\.siteId\)/);
    assert.match(m, /\$\{bookings\.status\} = 'pending'[^`]*notFromArchivedSite\(bookings\.siteId\)/);
    assert.match(m, /awaitingReview\(\), notFromArchivedAssistant\(\)/);
    assert.match(m, /eq\(pendingActions\.status, 'pending'\), actionNotFromArchivedAssistant\(\)/);
    assert.doesNotMatch(m, /\$\{bookings\.status\} = 'confirmed'[^`]*notFromArchived/);
    assert.doesNotMatch(m, /from\(siteOrders\)[^;]*notFromArchived/);
    // The site predicate reaches the assistant through sites.ai_assistant_id.
    assert.match(read('src/utils/archived-assistant-drafts.ts'), /FROM sites archived_s JOIN ai_assistants archived_sa ON archived_sa\.id = archived_s\.ai_assistant_id/);
    // Held actions are hidden the same way wherever "waiting for you" lists them.
    assert.match(read('netlify/functions/get-pending-actions.ts'), /statusFilter === 'pending' \? \[actionNotFromArchivedAssistant\(\)\]/);
    assert.match(read('netlify/functions/pending-actions-digest.ts'), /lt\(pendingActions\.createdAt, cutoff\),\s+actionNotFromArchivedAssistant\(\)/);
    const stream = read('netlify/functions/dashboard-action-stream.ts');
    assert.match(stream, /'pending_approval'\), notFromArchivedAssistant\(\)/);
    assert.match(stream, /eq\(pendingActions\.status, 'pending'\), actionNotFromArchivedAssistant\(\)/);
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
