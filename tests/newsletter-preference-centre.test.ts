// tests/newsletter-preference-centre.test.ts
// Something to press other than "unsubscribe".
//
// A preference centre is the one feature where doing it badly is worse than not doing it. Five
// ways, each of which this file guards:
//
//   1. ⚠️ IT BECOMES A WALL. If leaving is harder than it was, the reader presses "report spam"
//      instead — which costs the sending domain far more than one lost subscriber.
//   2. ⚠️ IT ANSWERS THE ONE-CLICK POST WITH A MENU. RFC 8058 says that request must unsubscribe
//      immediately; mail clients fire it from a button labelled "unsubscribe".
//   3. THE PAUSE IS COSMETIC. If only the newsletter honours it, a welcome-sequence email arrives
//      two days after somebody asked for quiet.
//   4. THE PAUSE NEVER ENDS, or ends only if some sweep runs. Two nightly sweeps in this codebase
//      never ran once.
//   5. WIDENING A VOCABULARY DROPS A VALUE. Both CHECK constraints are re-created, not appended to,
//      so a lost value turns an ordinary unsubscribe into a 23514.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    applyPreference, parseChoice, PREFERENCE_OPTIONS, MONTHLY_GAP_DAYS,
} from '../src/utils/audience-preferences';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).then(ok, bad);
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

const SQL = read('db/newsletter-preferences.sql');
const AUDIENCE_SQL = read('db/audience.sql');
const NEWSLETTER_SQL = read('db/newsletter.sql');
const CONSENT = read('src/utils/audience-consent.ts');
const SEQ = read('src/utils/newsletter-sequence.ts');
const SEND = read('src/utils/newsletter-send.ts');
const PAGE = read('netlify/functions/newsletter-unsubscribe.ts');
const PREFS = read('src/utils/audience-preferences.ts');

/** Records the patch and the consent event; `contact` decides whether a row was found. */
function fakeDb(opts: { contact?: boolean; consentThrows?: boolean } = {}) {
    const calls: { patch?: Record<string, unknown>; event?: Record<string, unknown> } = {};
    const db: any = {
        update: () => {
            const chain: any = {
                set: (v: Record<string, unknown>) => { calls.patch = v; return chain; },
                where: () => chain,
                returning: () => Promise.resolve(opts.contact === false ? [] : [{ id: 7 }]),
            };
            return chain;
        },
        insert: () => ({
            values: (v: Record<string, unknown>) => {
                if (opts.consentThrows) return Promise.reject(new Error('consent table missing'));
                calls.event = v;
                return Promise.resolve([]);
            },
        }),
    };
    return { db, calls };
}

const DAY = 24 * 60 * 60 * 1000;
const base = { organisationId: 1, email: 'reader@example.com', contactId: 7 };

async function main() {

// ── 1. The exit stays where it was ──────────────────────────────────────────

await check('"stop all emails" is one of the options, in plain words', () => {
    const exit = PREFERENCE_OPTIONS.find((o) => o.choice === 'unsubscribe');
    assert.ok(exit, 'a preference centre without an unsubscribe is a wall');
    assert.match(exit!.label, /Stop all emails/);
    assert.match(exit!.detail, /permanent/i, 'and it says plainly what it does');
});

await check('every option is on one page, none behind a second click', () => {
    const get = PAGE.slice(landmark(PAGE, "if (method === 'GET')"), landmark(PAGE, 'ONE-CLICK IS NEVER A PREFERENCE'));
    assert.match(get, /PREFERENCE_OPTIONS\.map/);
    assert.match(get, /NOT a wall between the reader and the exit/);
});

// ── 2. One-click is not a preference ────────────────────────────────────────

await check('the one-click POST always unsubscribes, whatever the form says', () => {
    // RFC 8058: no further interaction. A menu here would be a spec violation and a dark pattern.
    assert.match(PAGE, /const choice = oneClick \? 'unsubscribe'/);
    const header = PAGE.slice(0, landmark(PAGE, 'import'));
    assert.match(header, /RFC 8058/);
});

await check('an unrecognised choice unsubscribes rather than being ignored', () => {
    // Fail towards the reader's likeliest intent: they arrived from an unsubscribe link.
    assert.strictEqual(parseChoice('pause_forever'), null);
    assert.strictEqual(parseChoice(''), null);
    assert.strictEqual(parseChoice('pause_30'), 'pause_30');
    assert.match(PAGE, /parseChoice\(new URLSearchParams\(event\.body \|\| ''\)\.get\('choice'\)\) \?\? 'unsubscribe'/);
});

// ── 3. The preferences themselves ───────────────────────────────────────────

await check('a 30-day pause sets a date, and records it as consent evidence', async () => {
    const { db, calls } = fakeDb();
    const res = await applyPreference(db, { ...base, choice: 'pause_30' });
    const until = calls.patch!.pausedUntil as Date;
    const days = Math.round((until.getTime() - Date.now()) / DAY);
    assert.strictEqual(days, 30);
    assert.strictEqual(calls.event!.event, 'paused');
    assert.match(res!.message, /You will not hear from us until/);
});

await check('three months is three months', async () => {
    const { db, calls } = fakeDb();
    await applyPreference(db, { ...base, choice: 'pause_90' });
    assert.strictEqual(Math.round(((calls.patch!.pausedUntil as Date).getTime() - Date.now()) / DAY), 90);
});

await check('choosing a frequency LIFTS an existing pause', async () => {
    // They have just said what they want instead of silence. Leaving them muted underneath the
    // choice would make it a lie.
    const { db, calls } = fakeDb();
    await applyPreference(db, { ...base, choice: 'monthly' });
    assert.strictEqual(calls.patch!.emailFrequency, 'monthly');
    assert.strictEqual(calls.patch!.pausedUntil, null);
    assert.strictEqual(calls.event!.event, 'frequency_changed');
});

await check('asking for everything again clears both', async () => {
    const { db, calls } = fakeDb();
    await applyPreference(db, { ...base, choice: 'all' });
    assert.strictEqual(calls.patch!.emailFrequency, 'all');
    assert.strictEqual(calls.patch!.pausedUntil, null);
    assert.strictEqual(calls.event!.event, 'resumed');
});

await check('an erased contact is not an error', async () => {
    const { db } = fakeDb({ contact: false });
    assert.strictEqual(await applyPreference(db, { ...base, choice: 'pause_30' }), null);
});

await check('a lost audit line does not lose the preference', async () => {
    // The preference is what the reader asked for. Refusing it because the evidence write failed
    // would send them to the unsubscribe button instead.
    const { db, calls } = fakeDb({ consentThrows: true });
    const res = await applyPreference(db, { ...base, choice: 'pause_30' });
    assert.ok(res, 'the pause still applies');
    assert.ok(calls.patch!.pausedUntil, 'and was written');
});

// ── 4. A pause that is real, and ends by itself ─────────────────────────────

await check('a pause binds EVERY assistant, not just the newsletter', () => {
    // The shared resolver is what every assistant asks, so this is the only place that can bind
    // them all at once.
    assert.match(CONSENT, /\| 'paused'/);
    assert.match(CONSENT, /A PAUSE BINDS EVERY ASSISTANT/);
    assert.match(CONSENT, /reason: 'paused'/);
});

await check('a permanent refusal outranks a temporary one', () => {
    // Recording 'paused' for somebody who actually opted out would misreport a consent decision.
    const loop = CONSENT.slice(landmark(CONSENT, 'for (const email of valid)'));
    assert.ok(landmark(loop, "reason: 'opted_out'") < landmark(loop, "reason: 'paused'"));
    assert.ok(landmark(loop, "reason: 'suppressed'") < landmark(loop, "reason: 'paused'"));
});

await check('the verdict carries WHEN the pause lifts', () => {
    assert.match(CONSENT, /retryAfter\?: Date \| null/);
    assert.match(CONSENT, /retryAfter: contact\.pausedUntil/);
});

await check('a welcome sequence DEFERS on a pause instead of halting for ever', () => {
    // A halted enrolment is never resumed by anything, so halting here would end somebody's
    // welcome series because they asked for thirty days of quiet.
    const branch = SEQ.slice(landmark(SEQ, 'if (!verdict?.sendable)'), landmark(SEQ, 'const [org]'));
    assert.match(branch, /reason === 'paused' && verdict\?\.retryAfter/);
    assert.match(branch, /nextSendAt: verdict\.retryAfter/);
    assert.ok(landmark(branch, "reason === 'paused'") < landmark(branch, 'await halt('),
        'the deferral must come before the halt, or it never runs');
});

await check('the pause ends without anything having to run', () => {
    // A boolean flag would need a sweep to clear it, and this codebase has already had two nightly
    // sweeps that never ran once.
    assert.match(SQL, /paused_until TIMESTAMP/);
    assert.match(SEND, /pausedUntil\} IS NULL OR \$\{audienceContacts\.pausedUntil\} <= /);
    assert.match(CONSENT, /contact\.pausedUntil\.getTime\(\) > Date\.now\(\)/);
});

await check('a paused or capped subscriber is never counted as a recipient', () => {
    // recipient_count is what the tenant is told this send reached.
    const fn = SEND.slice(landmark(SEND, 'async function materialiseFromAudience'), landmark(SEND, 'async function deliver'));
    assert.match(fn, /preferenceFilter/);
    assert.match(fn, /emailFrequency\} <> 'monthly'/);
    assert.match(fn, /lastSentAt\} IS NULL/, 'someone never emailed is due by definition');
    assert.ok(MONTHLY_GAP_DAYS >= 28);
});

// ── 5. Widening a vocabulary must not drop a value ──────────────────────────

const valuesIn = (src: string, marker: string) => {
    const from = landmark(src, marker);
    const slice = src.slice(from, from + 900);
    const open = slice.indexOf('(', slice.indexOf('IN'));
    return [...slice.slice(open, slice.indexOf(')', open)).matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
};

await check('every consent event that was legal before is still legal', () => {
    const before = valuesIn(AUDIENCE_SQL, 'audience_consent_events_event_check');
    const after = valuesIn(SQL, 'ADD CONSTRAINT audience_consent_events_event_check');
    assert.ok(before.length >= 10, 'the old list was found');
    for (const v of before) assert.ok(after.includes(v), `widening dropped '${v}' — every unsubscribe would 23514`);
    for (const v of ['paused', 'resumed', 'frequency_changed']) assert.ok(after.includes(v));
});

await check('every skip reason that was legal before is still legal', () => {
    const before = valuesIn(NEWSLETTER_SQL, 'newsletter_sends_skip_reason_check');
    const after = valuesIn(SQL, 'ADD CONSTRAINT newsletter_sends_skip_reason_check');
    assert.ok(before.length >= 9, 'the old list was found');
    for (const v of before) assert.ok(after.includes(v), `widening dropped '${v}'`);
    assert.ok(after.includes('paused'), 'or every paused recipient is a failed write, not a recorded skip');
});

await check('the constraints are re-created, not added-if-missing', () => {
    // They already exist with the narrower list, so IF NOT EXISTS would silently do nothing.
    assert.match(SQL, /DROP CONSTRAINT IF EXISTS audience_consent_events_event_check/);
    assert.match(SQL, /DROP CONSTRAINT IF EXISTS newsletter_sends_skip_reason_check/);
    assert.match(SQL, /FRESH-INSTALL ORDER/, 'and the ordering hazard that creates is named');
});

await check('every skip reason has UI copy', () => {
    // A verdict with no label shows a blank cell on the send report.
    const labels = CONSENT.slice(landmark(CONSENT, 'export const SKIP_REASON_LABEL'), landmark(CONSENT, 'const SENDABLE'));
    assert.match(labels, /paused:\s+'Paused their emails'/);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
