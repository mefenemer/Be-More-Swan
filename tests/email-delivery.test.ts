// tests/email-delivery.test.ts
// "Why isn't this person getting our email?" — Resend's verdict on transactional mail.
//
// 2026-10-20: a user received no login links or notifications for weeks. Resend had the address on
// its suppression list; it ACCEPTS a send to a suppressed address and drops it, so every send call
// succeeded and nothing was logged. These checks pin the four ways the fix could quietly undo itself:
//
//   1. A suppression / hard bounce / complaint is not recorded as a problem.
//   2. A soft bounce (a full mailbox) is reported as a dead address.
//   3. An old problem stays red after the admin fixed it and mail is delivering again.
//   4. The webhook or the user panel breaks where the table has not been migrated yet.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    classifyResendEvent, summariseDelivery, recordDeliveryEvent, loadDeliveryReport, listDeliveryProblems,
} from '../src/utils/email-delivery';

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

const ev = (type: string, data: Record<string, unknown> = {}) => ({
    type,
    created_at: '2026-10-19T23:51:13.000Z',
    data: { email_id: 'msg_1', to: ['  Sarah@Example.ORG '], subject: 'Your Be More Swan login link', ...data },
});

const missingTable = () => Object.assign(new Error('relation "email_delivery_events" does not exist'), { code: '42P01' });

/** A select chain that resolves to `rows` (or rejects), whatever builder methods are called on it. */
function selectChain(result: () => Promise<unknown[]>) {
    const chain: any = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') return (res: any, rej: any) => result().then(res, rej);
            return () => chain;
        },
    });
    return chain;
}

async function main() {
console.log('\nemail-delivery');

await check('a suppressed send is recorded as a problem, with a normalised address', () => {
    const c = classifyResendEvent(ev('email.suppressed', { suppressed: { type: 'OnAccountSuppressionList', message: 'Previously bounced' } }));
    assert.ok(c);
    assert.equal(c!.eventType, 'suppressed');
    assert.equal(c!.email, 'sarah@example.org');
    assert.equal(c!.providerMessageId, 'msg_1');
    assert.match(c!.reason!, /Previously bounced/);
    assert.equal(c!.occurredAt.toISOString(), '2026-10-19T23:51:13.000Z');
});

await check('a suppression with no detail still says why', () => {
    assert.match(classifyResendEvent(ev('email.suppressed'))!.reason!, /suppression list/);
});

await check('a hard bounce is a problem; a soft bounce is not', () => {
    assert.equal(classifyResendEvent(ev('email.bounced', { bounce: { type: 'Permanent', message: 'No such user' } }))!.eventType, 'bounced');
    assert.equal(classifyResendEvent(ev('email.bounced', { bounce: { type: 'Undetermined' } }))!.eventType, 'bounced');
    assert.equal(classifyResendEvent(ev('email.bounced', { bounce: { type: 'Transient', message: 'Mailbox full' } }))!.eventType, 'soft_bounced');
    const soft = summariseDelivery([{ eventType: 'soft_bounced', subject: null, reason: null, occurredAt: '2026-10-19' }]);
    assert.equal(soft.status, 'ok', 'a full mailbox must not read as a dead address');
});

await check('complaints, failures and deliveries are classified; opens and clicks are ignored', () => {
    assert.equal(classifyResendEvent(ev('email.complained'))!.eventType, 'complained');
    assert.equal(classifyResendEvent(ev('email.failed', { failed: { reason: 'Domain not verified' } }))!.reason, 'Domain not verified');
    assert.equal(classifyResendEvent(ev('email.delivered'))!.eventType, 'delivered');
    assert.equal(classifyResendEvent(ev('email.opened')), null);
    assert.equal(classifyResendEvent(ev('email.clicked')), null);
    assert.equal(classifyResendEvent(ev('email.delivery_delayed')), null);
});

await check('an event without a message id or recipient is not recorded', () => {
    assert.equal(classifyResendEvent({ type: 'email.suppressed', data: { to: ['a@b.com'] } }), null);
    assert.equal(classifyResendEvent({ type: 'email.suppressed', data: { email_id: 'x' } }), null);
});

await check('the newest of problem vs delivery wins, whatever the input order', () => {
    const problemThenDelivered = [
        { eventType: 'delivered', subject: 'later', reason: null, occurredAt: '2026-10-21T10:00:00Z' },
        { eventType: 'suppressed', subject: 'earlier', reason: 'x', occurredAt: '2026-10-19T10:00:00Z' },
    ];
    const cleared = summariseDelivery(problemThenDelivered);
    assert.equal(cleared.status, 'ok');
    assert.equal(cleared.advice, null);
    assert.equal(cleared.problem!.eventType, 'suppressed', 'the cleared problem is still shown as history');

    const deliveredThenProblem = summariseDelivery([...problemThenDelivered].reverse().map((e, i) => ({
        ...e, occurredAt: i === 0 ? '2026-10-22T10:00:00Z' : '2026-10-20T10:00:00Z',
    })));
    assert.equal(deliveredThenProblem.status, 'suppressed');
    assert.match(deliveredThenProblem.advice!, /Resend → Suppressions/);
});

await check('no events reads as no data, not as fine', () => {
    assert.equal(summariseDelivery([]).status, 'no_data');
});

await check('recording never throws — a missing table or a DB error returns false', async () => {
    const c = classifyResendEvent(ev('email.suppressed'))!;
    let inserted: any = null;
    const ok = { insert: () => ({ values: (v: any) => { inserted = v; return { onConflictDoNothing: () => Promise.resolve() }; } }) };
    assert.equal(await recordDeliveryEvent(ok, c), true);
    assert.equal(inserted.email, 'sarah@example.org');
    const missing = { insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.reject(missingTable()) }) }) };
    assert.equal(await recordDeliveryEvent(missing, c), false);
    const broken = { insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.reject(new Error('boom')) }) }) };
    const err = console.error; console.error = () => {};
    try { assert.equal(await recordDeliveryEvent(broken, c), false); } finally { console.error = err; }
});

await check('the user panel still opens on an unmigrated DB, and says it is not tracked', async () => {
    const db = { select: () => selectChain(() => Promise.reject(missingTable())) };
    const r = await loadDeliveryReport(db, 'sarah@example.org');
    assert.equal(r.tracked, false);
    assert.equal(r.status, 'no_data');
    assert.equal((await listDeliveryProblems(db)).tracked, false);
});

await check('the problem list keeps only addresses whose newest event is a problem, accounts first', async () => {
    const events = [
        { email: 'stranger@x.com', eventType: 'bounced', subject: 's', reason: null, occurredAt: new Date('2026-10-20T09:00:00Z') },
        { email: 'fixed@x.com', eventType: 'delivered', subject: 's', reason: null, occurredAt: new Date('2026-10-20T08:00:00Z') },
        { email: 'sarah@x.org', eventType: 'suppressed', subject: 'Login', reason: null, occurredAt: new Date('2026-10-19T23:51:00Z') },
        { email: 'fixed@x.com', eventType: 'suppressed', subject: 's', reason: null, occurredAt: new Date('2026-10-19T08:00:00Z') },
    ];
    let call = 0;
    const db = { select: () => selectChain(() => Promise.resolve(call++ === 0 ? events : [{ id: 44, email: 'sarah@x.org', firstName: 'Sarah', lastName: null }])) };
    const { problems } = await listDeliveryProblems(db);
    assert.deepEqual(problems.map((p) => p.email), ['sarah@x.org', 'stranger@x.com']);
    assert.equal(problems[0].userId, 44);
    assert.equal(problems[0].userName, 'Sarah');
    assert.equal(problems[1].userId, null);
});

// ── Wiring ──────────────────────────────────────────────────────────────────────
const HOOK = read('netlify/functions/newsletter-webhook.ts');
const API = read('netlify/functions/admin-api.ts');
const UI = read('admin.html');
const SQL = read('db/z-email-delivery-events.sql');
const SCHEMA = read('db/schema.ts');

await check('the webhook records events that match no newsletter or campaign send', () => {
    const branch = HOOK.slice(landmark(HOOK, '// No newsletter or campaign row → our own transactional mail'));
    assert.ok(landmark(branch, 'recordDeliveryEvent(db, ev)') < landmark(branch, "body: 'unmatched'"),
        'recording must happen before the unmatched return, or transactional events are thrown away');
    assert.ok(landmark(HOOK, 'handleSequenceEvent(db') < landmark(HOOK, '// No newsletter or campaign row'),
        'campaign sends are matched first — only truly unmatched events are transactional');
});

await check('the admin user endpoint returns the delivery report; the problem list has its own resource', () => {
    const userGet = API.slice(landmark(API, "resource === 'user') {"), landmark(API, "resource === 'email-delivery-problems'"));
    assert.match(userGet, /loadDeliveryReport\(db, row\.email\)/);
    assert.match(userGet, /emailDelivery \}/);
    assert.match(API, /listDeliveryProblems\(db, \{ days \}\)/);
});

await check('the admin page shows it in the user panel and on the Users view', () => {
    assert.match(UI, /\$\{renderEmailDelivery\(d\.emailDelivery\)\}/);
    assert.match(UI, /if \(view === 'users'\)\s+\{ loadUsers\(\); loadEmailDeliveryProblems\(\); \}/);
    assert.ok(landmark(UI, 'id="email-delivery-problems"') > -1);
    assert.match(UI, /https:\/\/resend\.com\/suppressions/);
});

await check('the migration matches the Drizzle mirror and is idempotent per message+event', () => {
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS email_delivery_events/);
    assert.match(SQL, /UNIQUE INDEX IF NOT EXISTS email_delivery_events_message_event_unique\s+ON email_delivery_events \(provider_message_id, event_type\)/);
    for (const t of ['delivered', 'bounced', 'soft_bounced', 'complained', 'suppressed', 'failed']) assert.ok(SQL.includes(`'${t}'`), t);
    assert.match(SCHEMA, /pgTable\("email_delivery_events"/);
});

await check('the admin "Send Login Link" stores the hash and links to a page that exists', () => {
    const branch = API.slice(landmark(API, "resource === 'send-login-link'"), landmark(API, "resource === 'lock-account'"));
    assert.match(branch, /verificationToken: hashedToken/, 'verify.ts hashes the token it receives — storing the plain one can never match');
    assert.match(branch, /\/verify-account\.html\?token=\$\{token\}/);
    assert.ok(!branch.includes('}/verify.html'), 'there is no verify.html page');
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
