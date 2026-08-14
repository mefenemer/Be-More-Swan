// tests/autopilot-silent-skip.test.ts
// An assistant that will never draft again must not be a number in a cron response nobody reads.
//
// Run:  npx tsx tests/autopilot-silent-skip.test.ts
//
// enqueueScheduleGapFill returned reason:'on_demand' for EVERY empty slot list, which merged two
// opposite situations: a user who deliberately switched scheduling off, and a user whose stored
// posting_frequency we simply could not parse. draft-horizon-fill counted them into the same
// bucket and threw it away. There was no other symptom — the Review Queue just stayed empty and
// the Autopilot card said ACTIVE — so prod org 40's assistant went from hire to a month later
// having drafted nothing, and only a human asking "am I supposed to get posts?" surfaced it.
//
// The behavioural half (which cadence string lands in which bucket) is exercised for real against
// the shared parser. The wiring half is source-scanned, because the notification path needs a DB.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { readCadence } from '../src/config/posting-cadence';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const gapFill = read('../src/utils/schedule-gap-fill.ts');
const cron = read('../netlify/functions/draft-horizon-fill.ts');
const actions = read('../src/utils/notification-actions.ts');
const catalog = read('../src/utils/notification-templates-catalog.ts');

// ── Which values are a problem, and which are a choice ───────────────────────
check('the value that broke prod is classed as unreadable, not as "off"', () => {
    // The literal stored value for org 40, assistant 4.
    assert.equal(readCadence('Every Monday, Tuesday, Wednesday, and Thursday at 8 am.').kind, 'unrecognised');
});

check('deliberately switching autopilot off is NOT an alert', () => {
    // These users chose this. Alerting them hourly would be the bug in the other direction.
    for (const off of ['on_demand', 'On demand', 'as needed', 'ad-hoc', 'manual only']) {
        assert.equal(readCadence(off).kind, 'on_demand', off);
    }
});

check('a working cadence is neither', () => {
    for (const ok of ['daily', '3 times a week', '4 times a week', '4x per week and at different times']) {
        assert.equal(readCadence(ok).kind, 'scheduled', ok);
    }
});

check('an unset frequency is a default, not a failure to understand', () => {
    // resolvePostingSchedule substitutes the default, so blank must not raise an alert either.
    for (const blank of ['', '   ', null, undefined]) {
        assert.equal(readCadence(blank).kind, 'scheduled', JSON.stringify(blank));
    }
});

// ── The bail actually distinguishes them ─────────────────────────────────────
check('the gap-fill asks readCadence why there are no slots', () => {
    assert.ok(
        /readCadence\(schedule\.frequency\)/.test(gapFill),
        'schedule-gap-fill no longer consults the cadence parser — every empty slot list would be ' +
        'reported as on_demand again, which is what hid the original failure.',
    );
    for (const reason of ['unrecognised_cadence', 'no_slot_in_horizon', 'on_demand']) {
        assert.ok(gapFill.includes(`'${reason}'`), `${reason} is gone from schedule-gap-fill`);
    }
});

check('only the unreadable case notifies', () => {
    const bail = gapFill.slice(landmark(gapFill, 'const slots = computeScheduleSlots'));
    const block = bail.slice(0, landmark(bail, '// Resolve the latest blueprint'));
    const notifyLine = block.split('\n').find(l => l.includes('notifyUnreadableCadence'));
    assert.ok(notifyLine, 'the unreadable-cadence notification is no longer sent');
    // It must sit inside the `kind === 'unrecognised'` branch, not before it.
    assert.ok(
        landmark(block, "kind === 'unrecognised'") < landmark(block, 'notifyUnreadableCadence('),
        'notifyUnreadableCadence is called outside the unrecognised branch — an on_demand user ' +
        'would be told their schedule is broken when they switched it off on purpose.',
    );
});

check('the notification is deduped, because the cron is hourly', () => {
    const fn = gapFill.slice(landmark(gapFill, 'async function notifyUnreadableCadence'));
    const body = fn.slice(0, landmark(fn, '\n}'));
    assert.ok(
        /interval '3 days'/.test(body) && /autopilot_schedule_unreadable/.test(body),
        'the dedup window is gone — a broken cadence does not self-heal, so the user would be ' +
        'notified 24 times a day for as long as it stays broken.',
    );
});

// ── The cron reports it ──────────────────────────────────────────────────────
check('every reason the helper can return has a counter', () => {
    // The tally ignores unknown reasons (`skipped[result.reason] !== undefined`), so a reason
    // missing here is silently discarded and the counter reads healthy.
    const union = gapFill.slice(landmark(gapFill, 'reason?:'), landmark(gapFill, '}', landmark(gapFill, 'reason?:')));
    const reasons = [...union.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).filter(r => r !== 'ok');
    assert.ok(reasons.length >= 7, `expected the full reason union, parsed ${reasons.length}`);
    const counters = cron.slice(landmark(cron, 'const skipped'), landmark(cron, 'const needsAttention'));
    for (const r of reasons) {
        assert.ok(counters.includes(`${r}: 0`), `draft-horizon-fill has no counter for '${r}'`);
    }
});

check('the cron surfaces which assistants are stuck', () => {
    assert.ok(/needsAttention/.test(cron), 'needsAttention is gone from the cron response');
    assert.ok(/GAP_FILL_ATTENTION_REASONS/.test(cron), 'the cron no longer flags attention reasons');
    assert.ok(/console\.warn\(/.test(cron), 'the stuck assistant is no longer logged');
});

// ── The notification is routed as an action, not an update ───────────────────
check('both alerts land in "Action required"', () => {
    for (const type of ['autopilot_schedule_unreadable', 'autopilot_setup_blocked']) {
        assert.ok(
            new RegExp(`${type}:\\s*'suggested_action'`).test(actions),
            `${type} is uncategorised, so netlify/functions/notifications.ts computes categoryOf() ` +
            "= 'informational' and files a do-something alert under Updates.",
        );
        assert.ok(
            catalog.includes(`templateKey: '${type}'`),
            `${type} has no catalog entry — createNotification would render nothing.`,
        );
    }
});

// ── The other two ways an assistant silently stops ───────────────────────────
// Same failure shape, different cause: a blueprint with blocking gaps refuses to generate on every
// tick, and a failed auto-compile leaves no blueprint at all. Both were counted and discarded.

check('every permanent stop is an attention reason', () => {
    const set = gapFill.slice(landmark(gapFill, 'GAP_FILL_ATTENTION_REASONS'));
    const block = set.slice(0, landmark(set, ']'));
    for (const r of ['unrecognised_cadence', 'blocking_gaps', 'no_blueprint']) {
        assert.ok(block.includes(`'${r}'`), `${r} is not flagged for attention — it stops the ` +
            'assistant permanently and re-running the cron changes nothing.');
    }
    // Healthy states must NOT be in there, or every tick reports a false alarm.
    for (const ok of ['fully_covered', 'no_slot_in_horizon']) {
        assert.ok(!block.includes(`'${ok}'`), `${ok} is a healthy state and must not raise attention`);
    }
});

check('blocking gaps notify the user', () => {
    const i = landmark(gapFill, 'const blockingGaps');
    const block = gapFill.slice(i, i + 400);
    assert.ok(
        /notifyBlockedSetup\(/.test(block),
        'a blueprint with blocking gaps refuses to generate hourly and tells the user nothing.',
    );
});

check('internal-owned gaps do not nag the user', () => {
    // 'Re-provision the assistant — hire-time brief never compiled' is ours. A notification the
    // user cannot act on is worse than none, so the notifier must bail when nothing is theirs.
    const fn = gapFill.slice(landmark(gapFill, 'async function notifyBlockedSetup'));
    const body = fn.slice(0, landmark(fn, '\n}\n'));
    assert.ok(
        /owner !== 'internal'/.test(body),
        'notifyBlockedSetup no longer filters out internal-owned gaps.',
    );
    assert.ok(
        /if \(!actionable\.length\) return;/.test(body),
        'with every blocking gap internal, the user is still notified about something only we can fix.',
    );
    assert.ok(/interval '3 days'/.test(body), 'the dedup window is gone and the cron is hourly.');
});

check('a failed compile stays operator-only', () => {
    // no_blueprint means the auto-compile threw — ours, not theirs. It must be visible in the log
    // and in needsAttention, but must NOT produce a user notification.
    assert.ok(/no_blueprint:/.test(cron), 'no_blueprint has no operator hint, so it has no signal at all');
    const i = gapFill.indexOf("return { enqueued: 0, reason: 'no_blueprint' }");
    const before = gapFill.slice(Math.max(0, i - 400), i);
    assert.ok(
        !/createNotification|notify[A-Z]/.test(before),
        'a failed blueprint compile now notifies the user about a problem only we can fix.',
    );
    assert.ok(/console\.error\(/.test(before), 'the compile failure is no longer logged');
});

check('the copy exists and names the offending value', () => {
    const i = catalog.indexOf("templateKey: 'autopilot_schedule_unreadable'");
    assert.ok(i > 0, 'no catalog entry — createNotification would render nothing');
    const entry = catalog.slice(i, i + 900);
    assert.ok(
        entry.includes('{{schedule.frequency}}'),
        '"we cannot read your schedule" is not actionable without quoting the value we mean.',
    );
    assert.ok(
        /variables:[\s\S]*schedule\.frequency/.test(entry),
        'the merge variable must be declared, or admin save-time validation rejects it.',
    );
});

console.log(`\n${passed} checks passed`);
