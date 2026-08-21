// tests/audience-objection.test.ts
// An unsubscribe, or a 90-day pause, must stop COLD OUTREACH too.
//
// Owner's decision, 2026-08-21: leads and the Audience stay separate POPULATIONS — a speculative
// prospect is never promoted into a mailing list — but a refusal crosses. Somebody who asks for
// quiet through the preference centre must not be cold-emailed the following month.
//
// ⚠️ THE ONE THAT WOULD TAKE DOWN THE PIPELINE. The obvious implementation is to call
// checkAudienceConsent from the outreach path. That resolver is a POSITIVE gate — no contact row
// means `not_in_audience` means refuse — and a cold prospect is BY DEFINITION not in the audience,
// so it would block every cold email in the product. This module asks the opposite-shaped
// question, and absence must mean "no opinion". The first check below is that regression.
//
// Three more ways this goes wrong quietly:
//   1. A PAUSE HALTS A CADENCE. Nothing resumes a halted enrolment, so treating a 30-day pause as
//      a stop ends the sequence for ever over a request for quiet.
//   2. 'pending' READS AS A REFUSAL. A half-finished newsletter signup is not the person saying no
//      — it would silently delete prospects from the pipeline.
//   3. A MISSING audience_contacts FAILS CLOSED. On an environment without the audience layer
//      there is no refusal to violate, and blocking every send protects nobody.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { audienceContacts, leadOptOuts, suppressionList } from '../db/schema';
import { audienceObjection } from '../src/utils/audience-objection';
import { checkSuppression } from '../src/utils/suppression';

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

// Same fake-drizzle shape as tests/audience-consent.test.ts.
const TABLES = new Map<unknown, string>([
    [audienceContacts, 'audience_contacts'],
    [leadOptOuts, 'lead_opt_outs'],
    [suppressionList, 'suppression_list'],
]);

function fakeDb(opts: { rows?: Record<string, unknown[]>; throwOn?: string; throwCode?: string } = {}) {
    const calls: string[] = [];
    const chain = (op: string) => {
        let table = '';
        const key = () => `${op}:${table}`;
        const record = (args: unknown[]) => {
            for (const a of args) { const named = TABLES.get(a); if (named) table = named; }
            return proxy;
        };
        const proxy: any = new Proxy(function () { /* builder stand-in */ } as never, {
            apply(_t, _this, args: unknown[]) { return record(args); },
            get(_t, prop) {
                if (prop === 'then') {
                    return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
                        calls.push(key());
                        if (opts.throwOn === key()) {
                            const err: Error & { code?: string } = new Error(`boom: ${key()}`);
                            if (opts.throwCode) err.code = opts.throwCode;
                            return Promise.reject(err).then(res, rej);
                        }
                        return Promise.resolve(opts.rows?.[key()] ?? []).then(res, rej);
                    };
                }
                return (...args: unknown[]) => record(args);
            },
        });
        return proxy;
    };
    return { db: { select: (cols: unknown) => chain('select')(cols) } as never, calls };
}

async function main() {

const contact = (over: Record<string, unknown>) => ({
    'select:audience_contacts': [{ status: 'subscribed', pausedUntil: null, ...over }],
});
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

await check('a cold prospect who is not in the audience raises NO objection', async () => {
    // ⚠️ THE PIPELINE-KILLER. If this ever returns an objection, every cold email stops.
    const { db } = fakeDb({ rows: { 'select:audience_contacts': [] } });
    assert.strictEqual(await audienceObjection(db, 1, 'stranger@prospect.com'), null);
});

await check('an unconfirmed newsletter signup is not a refusal', async () => {
    const { db } = fakeDb({ rows: contact({ status: 'pending' }) });
    assert.strictEqual(await audienceObjection(db, 1, 'jane@acme.com'), null);
});

await check('a subscriber raises no objection either', async () => {
    const { db } = fakeDb({ rows: contact({}) });
    assert.strictEqual(await audienceObjection(db, 1, 'jane@acme.com'), null);
});

await check('an unsubscribe objects, permanently', async () => {
    const { db } = fakeDb({ rows: contact({ status: 'unsubscribed' }) });
    const o = await audienceObjection(db, 1, 'jane@acme.com');
    assert.strictEqual(o?.reason, 'opted_out');
    assert.strictEqual(o?.retryAfter, null, 'an unsubscribe must never look retryable');
});

await check('a live pause objects TEMPORARILY, carrying the date', async () => {
    const until = inDays(90);
    const { db } = fakeDb({ rows: contact({ pausedUntil: until }) });
    const o = await audienceObjection(db, 1, 'jane@acme.com');
    assert.strictEqual(o?.reason, 'paused');
    assert.strictEqual(o?.retryAfter?.getTime(), until.getTime());
});

await check('a pause that has run out lifts itself', async () => {
    // Compared against the clock, never a flag plus a sweep — a sweep that stops running would
    // mute somebody for ever.
    const { db } = fakeDb({ rows: contact({ pausedUntil: inDays(-1) }) });
    assert.strictEqual(await audienceObjection(db, 1, 'jane@acme.com'), null);
});

await check('a permanent refusal outranks a pause on the same contact', async () => {
    const { db } = fakeDb({ rows: contact({ status: 'unsubscribed', pausedUntil: inDays(30) }) });
    const o = await audienceObjection(db, 1, 'jane@acme.com');
    assert.strictEqual(o?.reason, 'opted_out');
    assert.strictEqual(o?.retryAfter, null, 'reporting a pause here would tell the caller to retry in 30 days');
});

await check('a bounce and a complaint both object', async () => {
    for (const [status, reason] of [['bounced', 'bounced_previously'], ['complained', 'complained_previously']]) {
        const { db } = fakeDb({ rows: contact({ status }) });
        assert.strictEqual((await audienceObjection(db, 1, 'jane@acme.com'))?.reason, reason);
    }
});

await check('an unrecognised status fails CLOSED', async () => {
    const { db } = fakeDb({ rows: contact({ status: 'whatever' }) });
    const o = await audienceObjection(db, 1, 'jane@acme.com');
    assert.strictEqual(o?.unknown, true);
});

await check('a MISSING audience_contacts is no objection, not an outage', async () => {
    // ⚠️ The asymmetry with the fail-closed rule, and it is deliberate: no audience means no
    // refusal to violate, and failing closed would block every cold email to protect nobody.
    const { db } = fakeDb({ throwOn: 'select:audience_contacts', throwCode: '42P01' });
    assert.strictEqual(await audienceObjection(db, 1, 'jane@acme.com'), null);
});

await check('any OTHER lookup failure fails closed', async () => {
    const { db } = fakeDb({ throwOn: 'select:audience_contacts', throwCode: '08006' });
    const o = await audienceObjection(db, 1, 'jane@acme.com');
    assert.strictEqual(o?.unknown, true);
});

await check('checkSuppression carries the audience refusal to every outreach path', async () => {
    // The wiring: clean lead side, unsubscribed on the audience side.
    const { db, calls } = fakeDb({ rows: contact({ status: 'unsubscribed' }) });
    const v = await checkSuppression(db, 1, 'jane@acme.com');
    assert.strictEqual(v.suppressed, true);
    assert.strictEqual(v.source, 'audience');
    assert.ok(calls.includes('select:audience_contacts'), 'the audience must actually be READ');
});

await check('the lead-side lists still win, and still say so', async () => {
    const { db } = fakeDb({ rows: { 'select:lead_opt_outs': [{ reason: 'reply_opt_out' }] } });
    const v = await checkSuppression(db, 1, 'jane@acme.com');
    assert.strictEqual(v.source, 'lead_opt_out', 'a lead opt-out must not be reported as an audience refusal');
});

await check('a clean address on both sides still sends', async () => {
    const { db } = fakeDb();
    assert.strictEqual((await checkSuppression(db, 1, 'stranger@prospect.com')).suppressed, false);
});

// ── Wiring, by source scan ──────────────────────────────────────────────────
const SUP = read('src/utils/suppression.ts');
const WORKER = read('netlify/functions/process-sequence-sends.ts');

await check('every outreach send path inherits this through ONE call', () => {
    // ⚠️ Folded into checkSuppression rather than added at the three send sites, so a fourth site
    // cannot miss it. If this ever moves to the call sites, that is what the count guards.
    const callers = ['netlify/functions/process-sequence-sends.ts', 'netlify/functions/lead-threads.ts',
        'netlify/functions/lead-generation.ts']
        .filter((f) => read(f).includes('audienceObjection'));
    assert.deepStrictEqual(callers, [], 'the send sites must ask checkSuppression, never audienceObjection directly');
    assert.match(SUP, /import \{ audienceObjection \} from '\.\/audience-objection'/);
});

await check('the audience is asked LAST, after both lead-side lists', () => {
    assert.ok(landmark(SUP, 'suppressionList.domain') < landmark(SUP, 'return audienceRefusal('),
        'a pause reported over a permanent suppression would tell the caller to retry on something it must never retry');
});

await check('the cadence DEFERS on a pause instead of halting', () => {
    // ⚠️ The one that ends a customer's sequence for ever. Nothing resumes a halted enrolment.
    const gate = WORKER.slice(landmark(WORKER, 'const suppression = await checkSuppression('),
        landmark(WORKER, 'const templateVersion ='));
    assert.ok(landmark(gate, 'suppression.retryAfter') < landmark(gate, 'haltEnrolment'),
        'the retryAfter branch must return before the halt');
    assert.match(gate, /nextSendAt: suppression\.retryAfter/);
});

await check('an audience refusal halts as do_not_contact, a list hit as suppressed', () => {
    // Both keys are already in sequence_enrolments_halt_reason_check — inventing one would make the
    // halt UPDATE fail and leave the enrolment ACTIVE and still sending.
    assert.match(WORKER, /suppression\.source === 'audience' \? 'do_not_contact' : 'suppressed'/);
    const ddl = read('db/sequence-halt-do-not-contact.sql');
    for (const key of ['do_not_contact', 'suppressed']) assert.ok(ddl.includes(`'${key}'`), `${key} must be in the CHECK`);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
