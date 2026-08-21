// tests/posting-cadence.test.ts
// Locks postsPerWeekFor() — the parser the periodic conversion-post scheduler relies on to turn a
// stored posting_frequency (canonical label/key OR legacy free text) into posts-per-week.
// Run:  npx tsx tests/posting-cadence.test.ts

import assert from 'node:assert';
import {
    POSTING_CADENCES, postsPerWeekFor, intervalHoursFor, readCadence, DEFAULT_POSTING_FREQUENCY,
    selectWeeklySlots, computeScheduleSlots, resolvePostingSchedule,
    type WeekdayKey, type PostingSchedule,
} from '../src/config/posting-cadence';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

check('canonical labels resolve to their declared rate', () => {
    for (const c of POSTING_CADENCES) assert.equal(postsPerWeekFor(c.label), c.postsPerWeek, c.label);
});

check('canonical keys resolve too', () => {
    assert.equal(postsPerWeekFor('daily'), 7);
    assert.equal(postsPerWeekFor('3x_week'), 3);
    assert.equal(postsPerWeekFor('on_demand'), 0);
});

check('free-text per-week phrasing', () => {
    assert.equal(postsPerWeekFor('3 times a week'), 3);
    assert.equal(postsPerWeekFor('4x week'), 4);
    assert.equal(postsPerWeekFor('post 2 times per week'), 2);
    assert.equal(postsPerWeekFor('three times a week'), 3);
});

check('free-text per-day phrasing multiplies by 7', () => {
    assert.equal(postsPerWeekFor('twice a day'), 14);
    assert.equal(postsPerWeekFor('2 times a day'), 14);
    assert.equal(postsPerWeekFor('every day'), 7);
});

check('on-demand / fortnightly / unknown', () => {
    assert.equal(postsPerWeekFor('on demand'), 0);
    assert.equal(postsPerWeekFor('as needed'), 0);
    assert.equal(postsPerWeekFor('fortnightly'), 0.5);
    assert.equal(postsPerWeekFor('every two weeks'), 0.5);
    assert.equal(postsPerWeekFor(''), 0);
    assert.equal(postsPerWeekFor(undefined), 0);
    assert.equal(postsPerWeekFor('whenever I feel like it'), 0);
});

check('bare number treated as per week', () => {
    assert.equal(postsPerWeekFor('5'), 5);
});

check('intervalHoursFor spaces posts evenly; null when not periodic', () => {
    assert.equal(intervalHoursFor('weekly'), 168);
    assert.equal(intervalHoursFor('daily'), 24);
    assert.equal(intervalHoursFor('3 times a week'), 56);
    assert.equal(intervalHoursFor('on demand'), null);
});

// ── readCadence: telling "off on purpose" apart from "we didn't understand you" ────────────────
// The bug this locks: a prod tenant's posting_frequency was the sentence below. postsPerWeekFor
// returned 0, so draft-horizon-fill skipped them on every hourly tick and NOTHING was ever drafted
// — while the Autopilot card, which tested the text with its own regex for the words "on demand"/
// "manual", reported autopilot as Active. Weeks of silence with a green light on the dashboard.
//
// A rate of 0 alone cannot distinguish the two, which is why readCadence exists. Any surface that
// tells a human about the schedule must branch on `kind`, never on the rate.
check('readCadence separates a real cadence, a deliberate on-demand, and an unreadable one', () => {
    assert.deepEqual(readCadence('3 times a week'), { postsPerWeek: 3, kind: 'scheduled' });
    assert.deepEqual(readCadence('Daily'), { postsPerWeek: 7, kind: 'scheduled' });
    assert.deepEqual(readCadence('4x per week and at different times'), { postsPerWeek: 4, kind: 'scheduled' });

    // Chosen from the picker, and free text that plainly says the same thing.
    assert.deepEqual(readCadence('On demand'), { postsPerWeek: 0, kind: 'on_demand' });
    assert.deepEqual(readCadence('on_demand'), { postsPerWeek: 0, kind: 'on_demand' });
    assert.deepEqual(readCadence('as needed'), { postsPerWeek: 0, kind: 'on_demand' });

    // THE regression. A schedule, unmistakably — and we cannot read it. Never report as on_demand.
    const theSentence = 'Every Monday, Tuesday, Wednesday, and Thursday at 8 am.';
    assert.equal(postsPerWeekFor(theSentence), 0, 'precondition: the parser still cannot read it');
    assert.deepEqual(readCadence(theSentence), { postsPerWeek: 0, kind: 'unrecognised' });
    assert.deepEqual(readCadence('whenever I feel like it'), { postsPerWeek: 0, kind: 'unrecognised' });
});

// ── Monthly ───────────────────────────────────────────────────────────────────────────────────
// The Newsletter Assistant's drafting-cadence dropdown offers Weekly / Twice a week / MONTHLY /
// On demand (src/public/assistant-onboarding-schemas.js). "Monthly" is not in POSTING_CADENCES —
// that array feeds the social and blog pickers, which have never offered it — so the parser has to
// read it as free text. It did not, and the consequences were both halves of the same bug:
// draft-newsletter-issues saw rate 0 and treated a monthly newsletter as "on demand" (never drafted
// an issue), while readCadence called it 'unrecognised' and fired the autopilot_schedule_unreadable
// alert, telling the user to pick a frequency from a list their own answer was already on.
check('a monthly cadence is a real schedule, not an unreadable one', () => {
    const monthly = 12 / 52;
    assert.equal(postsPerWeekFor('Monthly'), monthly);
    assert.equal(postsPerWeekFor('monthly'), monthly);
    assert.equal(postsPerWeekFor('once a month'), monthly);
    assert.equal(postsPerWeekFor('every month'), monthly);
    assert.equal(postsPerWeekFor('2 times a month'), (2 * 12) / 52);
    assert.deepEqual(readCadence('Monthly'), { postsPerWeek: monthly, kind: 'scheduled' });

    // The period draft-newsletter-issues derives from the rate has to be about a month.
    const periodDays = 7 / monthly;
    assert.ok(periodDays > 30 && periodDays < 31, `monthly period was ${periodDays} days`);
});

check('an unset frequency is the default cadence, not a failure to parse', () => {
    // resolvePostingSchedule substitutes DEFAULT_POSTING_FREQUENCY, so the reading must agree —
    // an assistant with no frequency set does draft, and must not be flagged as broken.
    for (const empty of ['', '   ', null, undefined]) {
        const r = readCadence(empty);
        assert.equal(r.kind, 'scheduled', JSON.stringify(empty));
        assert.equal(r.postsPerWeek, postsPerWeekFor(DEFAULT_POSTING_FREQUENCY), JSON.stringify(empty));
    }
});

check('every catalogue entry reads back as the kind its rate implies', () => {
    for (const c of POSTING_CADENCES) {
        const r = readCadence(c.label);
        assert.equal(r.postsPerWeek, c.postsPerWeek, c.label);
        assert.equal(r.kind, c.postsPerWeek > 0 ? 'scheduled' : 'on_demand', c.label);
    }
});

// ── The weekly pattern: which days a cadence actually lands on, and that it STAYS there ─────────
// posting_days says which days are ELIGIBLE; the frequency decides how many of them get a post.
// Mon–Fri at 3× a week uses three of the five — and it must be the SAME three every time we ask.
//
// The bug this locks: the three were picked downstream, from the rolling list of candidate instants
// inside (now, now + horizon], so the answer moved with the hour the gap-fill cron happened to run.
// Over one week that produced Tue/Thu/Mon, then Wed/Fri/Tue, then Thu/Mon/Wed — never the same
// three days twice, and no pattern the user could name. Coverage was tallied per calendar day, so
// whichever day won a job first kept it and the others were left bare.

/** Weekday + wall-clock time of an instant, as the schedule's own timezone sees it. */
function localSlot(d: Date, timeZone: string): string {
    const p: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat('en-GB', {
        timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d)) p[part.type] = part.value;
    return `${p.weekday.slice(0, 3).toLowerCase()} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

function scheduleOf(over: Partial<PostingSchedule> = {}): PostingSchedule {
    return resolvePostingSchedule({
        posting_frequency: '3 times a week',
        posting_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        posting_times: ['09:00'],
        posting_timezone: 'Europe/London',
        ...Object.fromEntries(Object.entries(over).map(([k, v]) => [`posting_${k}`, v])),
    });
}

check('the weekly pattern is a pure function of days × times × rate', () => {
    const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'] as WeekdayKey[];
    const at9 = (s: ReturnType<typeof selectWeeklySlots>) => s.map(x => x.day);

    // Three of five, spread across the week rather than clustered at the front.
    assert.deepEqual(at9(selectWeeklySlots(weekdays, ['09:00'], 3)), ['mon', 'wed', 'fri']);
    assert.deepEqual(at9(selectWeeklySlots(weekdays, ['09:00'], 2)), ['tue', 'thu']);
    assert.deepEqual(at9(selectWeeklySlots(weekdays, ['09:00'], 1)), ['wed']);
    assert.deepEqual(at9(selectWeeklySlots(weekdays, ['09:00'], 5)), weekdays);

    // Asking for more than the eligible days can hold is capped BY the days, not by the rate:
    // "daily" with only Mon and Wed ticked means two posts a week, not seven.
    assert.deepEqual(at9(selectWeeklySlots(['mon', 'wed'], ['09:00'], 7)), ['mon', 'wed']);

    // Two times a day doubles the grid, so 4× a week fits inside Mon/Wed.
    assert.deepEqual(selectWeeklySlots(['mon', 'wed'], ['09:00', '17:00'], 4), [
        { day: 'mon', time: '09:00' }, { day: 'mon', time: '17:00' },
        { day: 'wed', time: '09:00' }, { day: 'wed', time: '17:00' },
    ]);

    // On demand schedules nothing.
    assert.deepEqual(selectWeeklySlots(weekdays, ['09:00'], 0), []);
});

check('THE regression: the days do not drift with the hour you ask', () => {
    const schedule = scheduleOf();
    const seen = new Map<string, string>();   // pattern → the first `now` that produced it

    // Every hour of a fortnight — comfortably more variation than an hourly cron sees, and it
    // crosses a month boundary. The pattern must be identical at every single one of them.
    for (let h = 0; h < 24 * 14; h++) {
        const now = new Date(Date.UTC(2026, 7, 1, 0, 30) + h * 3600_000);
        const slots = computeScheduleSlots({ schedule, horizonDays: 7, now });
        const pattern = slots.map(s => localSlot(s, schedule.timezone)).sort().join(', ');
        if (!seen.has(pattern)) seen.set(pattern, now.toISOString());
    }

    assert.deepEqual(
        [...seen.keys()],
        ['fri 09:00, mon 09:00, wed 09:00'],   // alphabetical — the sort above is for comparability
        `pattern moved between calls: ${JSON.stringify([...seen.entries()], null, 2)}`,
    );
});

check('a 7-day horizon holds exactly the cadence, whenever it is asked', () => {
    // autoPublishWeeklyCeiling() and describeAutoPublishVolume() both read this count as "posts a
    // week", so it has to be the cadence itself and not one more or one fewer depending on the hour.
    for (const [frequency, expected] of [['3 times a week', 3], ['5 times a week', 5], ['weekly', 1]] as const) {
        const schedule = scheduleOf({ frequency });
        for (let h = 0; h < 24 * 9; h++) {
            const now = new Date(Date.UTC(2026, 7, 1, 0, 30) + h * 3600_000);
            const n = computeScheduleSlots({ schedule, horizonDays: 7, now }).length;
            assert.equal(n, expected, `${frequency} at ${now.toISOString()} gave ${n}`);
        }
    }
});

check('slots land on the chosen days only, in order, inside the window', () => {
    const schedule = scheduleOf({ days: ['tue', 'thu'] as WeekdayKey[], frequency: '2 times a week' });
    const now = new Date('2026-08-14T10:00:00Z');           // a Friday
    const slots = computeScheduleSlots({ schedule, horizonDays: 14, now });

    assert.equal(slots.length, 4, 'two a week over a fortnight');
    for (const s of slots) {
        assert.ok(['tue', 'thu'].includes(localSlot(s, schedule.timezone).slice(0, 3)), localSlot(s, schedule.timezone));
        assert.ok(s.getTime() > now.getTime(), 'never in the past');
        assert.ok(s.getTime() <= now.getTime() + 14 * 86_400_000, 'never past the horizon');
    }
    assert.deepEqual(slots.map(s => s.getTime()), [...slots.map(s => s.getTime())].sort((a, b) => a - b), 'ordered');
});

check('fortnightly publishes on the pattern day every other week', () => {
    const schedule = scheduleOf({ frequency: 'fortnightly' });
    const now = new Date('2026-08-14T10:00:00Z');
    const slots = computeScheduleSlots({ schedule, horizonDays: 28, now });

    // Roughly two in four weeks, all on the one pattern day, never two in the same week.
    assert.ok(slots.length >= 1 && slots.length <= 2, `expected 1–2 over 28 days, got ${slots.length}`);
    for (const s of slots) assert.equal(localSlot(s, schedule.timezone), 'wed 09:00');
    for (let i = 1; i < slots.length; i++) {
        const gapDays = (slots[i].getTime() - slots[i - 1].getTime()) / 86_400_000;
        assert.equal(gapDays, 14, `fortnightly gap was ${gapDays} days`);
    }
});

check('monthly publishes on the pattern day in every fourth week', () => {
    // Sub-weekly cadences are thinned by a WEEK STRIDE, generalised from the fortnightly one:
    // 0.5 → every 2nd week, 12/52 → every 4th. Anything else would silently publish a monthly
    // newsletter fortnightly.
    const schedule = scheduleOf({ frequency: 'Monthly' });
    const slots = computeScheduleSlots({ schedule, horizonDays: 30, now: new Date('2026-08-14T10:00:00Z') });

    assert.ok(slots.length <= 2, `expected at most 2 in 30 days, got ${slots.length}`);
    for (const s of slots) assert.equal(localSlot(s, schedule.timezone), 'wed 09:00');
    for (let i = 1; i < slots.length; i++) {
        const gapDays = (slots[i].getTime() - slots[i - 1].getTime()) / 86_400_000;
        assert.equal(gapDays, 28, `monthly gap was ${gapDays} days`);
    }
    // Fortnightly must be untouched by the generalisation — its own check above still holds.
    assert.equal(Math.round(1 / postsPerWeekFor('fortnightly')), 2);
});

check('the wall-clock time survives a DST change', () => {
    // Europe/London leaves BST on 25 Oct 2026. A 09:00 post is 08:00 UTC before and 09:00 UTC after
    // — the user asked for 9am, not for a fixed UTC offset.
    const schedule = scheduleOf({ frequency: 'daily', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as WeekdayKey[] });
    const slots = computeScheduleSlots({ schedule, horizonDays: 10, now: new Date('2026-10-20T12:00:00Z') });

    assert.ok(slots.length >= 7, `expected a slot a day, got ${slots.length}`);
    for (const s of slots) assert.ok(localSlot(s, schedule.timezone).endsWith(' 09:00'), localSlot(s, schedule.timezone));
    const utcHours = new Set(slots.map(s => s.getUTCHours()));
    assert.deepEqual([...utcHours].sort(), [8, 9], 'the UTC hour must shift across the boundary, not the local one');
});

check('on demand pre-generates nothing', () => {
    assert.deepEqual(computeScheduleSlots({ schedule: scheduleOf({ frequency: 'On demand' }), horizonDays: 7 }), []);
});

console.log(`\n${passed} checks passed.`);
