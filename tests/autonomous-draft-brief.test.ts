// tests/autonomous-draft-brief.test.ts
// The daily autonomous drafter (autonomous-media-suggestions.ts) — src/utils/autonomous-draft-brief.ts.
//
// WHY THIS EXISTS. On prod org 43 the drafter wrote from the business NAME alone and filled every
// empty day. A coaching practice called "DMV Vital Roots" got 21 near-identical posts about a
// wellness shop that does not exist ("Your roots run deeper than you know. 🌿 … Stop by"), on
// weekends her weekdays-only schedule never asked for, with no pillar recorded. What can break
// again without anything failing:
//
//   · the slot drifts off the owner's posting days / time / timezone
//   · an on-demand assistant gets drafts anyway
//   · the brief stops carrying the owner's words, or a name-only workspace gets a draft
//   · the cron stops calling the guard, or stops recording the pillar
//
// Run:  npx tsx tests/autonomous-draft-brief.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    pickAutonomousSlot, pickPillar, hasUsableBrief, briefLines, buildAutonomousDraftSystem, localDateKey,
} from '../src/utils/autonomous-draft-brief';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}`);
        throw err;
    }
}

// The shape of org 43's real settings.
const CTX = {
    posting_frequency: 'Daily',
    posting_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    posting_times: ['09:00'],
    posting_timezone: 'America/New_York',
    content_pillars: ['Upgrading your thoughts', 'Becoming clear on what you desire', "dont let your current circumstances dictate your future"],
    core_message: "What you experience in life isn't random — it's a reflection of your dominant thoughts and emotional state.",
    tone_of_voice: 'Honest, nurturing, professional, supportive',
    cta: 'Book a 1:1 session',
};
const ORG = {
    name: 'DMV Vital Roots',
    industry: 'Healthcare',
    businessDescription: 'This business helps people understand and shift their emotional and mental state using a framework that ranks emotions.',
    targetAudience: 'women and men in their 30s-50s into personal development',
    websiteUrl: 'Www.dmvvitalroots.com',
};

// Friday 2026-10-16 12:00 UTC — the next seven days include a weekend.
const NOW = new Date('2026-10-16T12:00:00Z');
const weekday = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);

(async () => {
    console.log('autonomous-draft-brief');

    await check('the slot is one of the owner\'s posting days — never a weekend for a weekdays-only schedule', () => {
        const slot = pickAutonomousSlot({ onboardingContext: CTX, horizonDays: 7, plannedDates: [], now: NOW });
        assert.ok(slot);
        assert.ok(!['Sat', 'Sun'].includes(weekday(slot!)), `got ${weekday(slot!)}`);
    });

    await check('the slot is at the owner\'s posting time in the owner\'s timezone', () => {
        const slot = pickAutonomousSlot({ onboardingContext: CTX, horizonDays: 7, plannedDates: [], now: NOW })!;
        const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }).format(slot);
        assert.strictEqual(hm, '09:00');
    });

    await check('covered slot days are skipped, and a fully covered week yields nothing', () => {
        const first = pickAutonomousSlot({ onboardingContext: CTX, horizonDays: 7, plannedDates: [], now: NOW })!;
        const second = pickAutonomousSlot({ onboardingContext: CTX, horizonDays: 7, plannedDates: [first], now: NOW })!;
        assert.notStrictEqual(localDateKey(second, 'America/New_York'), localDateKey(first, 'America/New_York'));
        // Cover every weekday in the window: the empty Saturday and Sunday must NOT be offered.
        const weekdays: Date[] = [];
        for (let i = 0; i <= 8; i++) weekdays.push(new Date(NOW.getTime() + i * 86_400_000));
        assert.strictEqual(pickAutonomousSlot({ onboardingContext: CTX, horizonDays: 7, plannedDates: weekdays, now: NOW }), null);
    });

    await check('an on-demand assistant is never drafted for', () => {
        const slot = pickAutonomousSlot({ onboardingContext: { ...CTX, posting_frequency: 'on_demand' }, horizonDays: 7, plannedDates: [], now: NOW });
        assert.strictEqual(slot, null);
    });

    await check('a workspace with only a name has no usable brief; any real description is enough', () => {
        assert.strictEqual(hasUsableBrief({ name: 'DMV Vital Roots' }, {}), false);
        assert.strictEqual(hasUsableBrief({ name: 'X', industry: 'Healthcare', websiteUrl: 'x.com' }, { cta: 'Call us' }), false);
        assert.strictEqual(hasUsableBrief({ name: 'X', businessDescription: 'We coach people.' }, {}), true);
        assert.strictEqual(hasUsableBrief({ name: 'X' }, { content_pillars: ['Mindset'] }), true);
    });

    await check('the least-used pillar is chosen', () => {
        const usage = { 'Upgrading your thoughts': 4, 'Becoming clear on what you desire': 4 };
        assert.strictEqual(pickPillar(CTX, usage, NOW), "dont let your current circumstances dictate your future");
        assert.strictEqual(pickPillar({}, {}, NOW), null);
    });

    await check('the system prompt carries the owner\'s own words, the pillar, the voice and the date', () => {
        const s = buildAutonomousDraftSystem({
            org: ORG, assistantName: 'DMV Vital Roots assistant', platformLabel: 'Instagram',
            onboardingContext: CTX, pillar: 'Upgrading your thoughts', slot: new Date('2026-10-19T13:00:00Z'),
        });
        assert.ok(s.includes(ORG.businessDescription), 'business description');
        assert.ok(s.includes(CTX.core_message), 'core message');
        assert.ok(s.includes('Book a 1:1 session'), 'call to action');
        assert.ok(s.includes('"Upgrading your thoughts"'), 'pillar');
        assert.ok(/Never guess what the business does from its name/.test(s), 'no-guessing rule');
        assert.ok(/VOICE/.test(s), 'voice block');
        assert.ok(/2026/.test(s), 'date block');
        assert.ok(s.includes('"imagePrompt"'), 'JSON contract');
    });

    await check('the audience falls back from the setup answer to the workspace profile', () => {
        assert.ok(briefLines(ORG, {}).some((l) => l.includes(ORG.targetAudience)));
        assert.ok(briefLines(ORG, { target_audience: 'Owners stuck in a rut' }).some((l) => l.includes('Owners stuck in a rut')));
    });

    await check('the cron uses the guard, the real slot and records the pillar', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const src = readFileSync(join(here, '../netlify/functions/autonomous-media-suggestions.ts'), 'utf8');
        assert.ok(src.includes('hasUsableBrief('), 'brief guard');
        assert.ok(src.includes('pickAutonomousSlot('), 'posting-slot choice');
        assert.ok(src.includes('buildAutonomousDraftSystem('), 'shared brief');
        assert.ok(/triggerType: 'scheduled', pillar,/.test(src), 'pillar persisted');
        assert.ok(!src.includes('firstGapDay'), 'the any-empty-day picker is gone');
    });

    console.log(`\n${passed} passed`);
})().catch(() => process.exit(1));
