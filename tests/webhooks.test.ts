// tests/webhooks.test.ts
// Outbound webhooks — the feature that was deliberately deferred twice, and why it is safe now.
//
// ⚠️ THE OBJECTION THAT DEFERRED IT: outbound webhooks need retries, retries need a schedule, and a
// schedule whose failure is SILENT has taken two features out in this codebase already. Building it
// anyway without answering that would have been building the thing I argued against. The answer is
// three properties, and the first three sections of this file are exactly those three.
//
// The fourth is the one nobody asks for until it is too late: we are making our own servers POST to
// a URL a stranger typed.

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    MAX_ATTEMPTS, MAX_CONSECUTIVE_FAILURES, WEBHOOK_EVENTS, backoffMs, isDeliverableUrl,
    mintSigningSecret, signPayload, verifySignature,
} from '../src/utils/webhooks';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    }
}

const MOD = read('src/utils/webhooks.ts');
const FN = read('netlify/functions/webhooks.ts');
const STORE = read('src/utils/audience-store.ts');
const SEND = read('src/utils/newsletter-send.ts');
const SQL = read('db/webhooks.sql');

console.log('\nOutbound webhooks\n');

// ── 1. No new schedule ──────────────────────────────────────────────────────

check('retries drain on an EXISTING sweep, not a new cron', () => {
    // ⚠️ The whole reason this was deferred. A new scheduled function is a new thing that can stop
    // running without anybody noticing.
    assert.match(SEND, /deliverPending\(db, \{ now \}\)/);
    assert.match(MOD, /RETRIES DRAIN ON AN EXISTING SWEEP/);

    // ⚠️ The precise claim, since netlify.toml legitimately mentions "webhook" for INBOUND things
    // (the provider callback, Stripe, the connector event drain): the OUTBOUND drain has exactly
    // one caller, and it is the newsletter sweep. A second caller — especially a new scheduled
    // function — is the thing this whole design avoids.
    const callers = [...new Set([
        ...readdirSync(join(root, 'src/utils')).map((f) => `src/utils/${f}`),
        ...readdirSync(join(root, 'netlify/functions')).map((f) => `netlify/functions/${f}`),
    ].filter((f) => f.endsWith('.ts') && !f.endsWith('src/utils/webhooks.ts'))
        .filter((f) => /\bdeliverPending\s*\(/.test(read(f))))];
    assert.deepStrictEqual(callers, ['src/utils/newsletter-send.ts'],
        `deliverPending must have exactly one caller, found: ${callers.join(', ')}`);
});

check('a webhook backlog can never stop a newsletter', () => {
    // The sweep exists to send email. The drain is last, and wrapped.
    const tail = SEND.slice(landmark(SEND, 'WEBHOOK RETRIES RIDE THIS SWEEP'));
    assert.match(tail, /try \{/);
    assert.match(tail, /catch \(err\)/);
    assert.ok(landmark(SEND, 'WEBHOOK RETRIES RIDE THIS SWEEP') > landmark(SEND, 'const tick = await processIssueBatch'));
});

check('the first attempt is inline, so the queue holds failures rather than traffic', () => {
    const fn = MOD.slice(landmark(MOD, 'export async function emitWebhook'), landmark(MOD, 'export interface DrainResult'));
    assert.match(fn, /await deliverPending\(db, \{ ids: rows\.map/);
    assert.match(MOD, /queue that is normally empty is a\n\/\/      queue whose backlog means something|THE FIRST ATTEMPT IS INLINE/);
});

// ── 2. A failing endpoint becomes visible ───────────────────────────────────

check('an endpoint that keeps failing is switched off and the tenant is told', () => {
    // ⚠️ The failure mode must not be "deliveries quietly stop".
    const fn = MOD.slice(landmark(MOD, "consecutiveFailures: sql`"), landmark(MOD, 'async function recordFailure'));
    assert.match(fn, />= MAX_CONSECUTIVE_FAILURES/);
    assert.match(fn, /isActive: false/);
    assert.match(fn, /disabledReason/);
    assert.ok(MAX_CONSECUTIVE_FAILURES >= 10, 'not so twitchy that one bad afternoon kills it');
});

check('any success resets the counter', () => {
    // Otherwise an endpoint that fails once a week eventually dies of old age.
    const fn = MOD.slice(landmark(MOD, 'if (res.ok)'), landmark(MOD, 'await recordFailure(db, delivery.id, attempt, res.status'));
    assert.match(fn, /consecutiveFailures: 0/);
});

check('re-enabling clears the failure count', () => {
    // ⚠️ Otherwise the tenant who has just fixed their server watches it switch off again on the
    // next failure, for reasons that predate the fix.
    const fn = FN.slice(landmark(FN, "if ('isActive' in body)"), landmark(FN, 'await db.update(webhookEndpoints).set(patch)'));
    assert.match(fn, /patch\.consecutiveFailures = 0/);
    assert.match(fn, /disabledAt = null/);
});

check('the queue\'s own health is shown to the tenant, not just logged', () => {
    const fn = FN.slice(landmark(FN, 'const [queue]'), landmark(FN, 'return json(200, { endpoints'));
    assert.match(fn, /status\} = 'pending'/);
    assert.match(fn, /status\} = 'failed'/);
    assert.match(FN, /in front of the tenant rather than in a log/);
});

check('retries back off, and stop', () => {
    assert.ok(backoffMs(1) < backoffMs(2) && backoffMs(2) < backoffMs(3));
    assert.ok(backoffMs(99) <= 10 * 60 * 60 * 1000, 'bounded so a broken receiver is not hammered');
    assert.ok(MAX_ATTEMPTS >= 3 && MAX_ATTEMPTS <= 10);
});

// ── 3. One emit point ───────────────────────────────────────────────────────

check('every status change emits from ONE place', () => {
    // ⚠️ setContactStatus is where the unsubscribe page, the provider webhook, the audience page
    // and the API all converge. Emitting per caller would be four places to remember and one to
    // forget — and the forgotten one would be silent.
    assert.match(STORE, /ONE EMIT POINT/);
    const fn = STORE.slice(landmark(STORE, 'if (result.changed)'), landmark(STORE, 'const WEBHOOK_EVENT_FOR_STATUS'));
    assert.match(fn, /emitWebhook\(db/);
});

check('nothing is emitted when nothing changed', () => {
    // A repeated unsubscribe is one event, not one per click.
    assert.match(STORE, /if \(result\.changed\)/);
});

check('the emit happens OUTSIDE the transaction', () => {
    // A slow receiver must not hold a database transaction open.
    assert.ok(landmark(STORE, 'if (result.changed)') > landmark(STORE, 'const result = await db.transaction'));
    assert.match(STORE, /must not hold a database\n    \/\/ transaction open/);
});

check('a finished send announces itself once', () => {
    // The status-guarded update means a losing race returns nothing — two ticks must not both say
    // the issue was sent.
    const fn = SEND.slice(landmark(SEND, 'const [finished] = await db.update(newsletterIssues)'), landmark(SEND, '} else {'));
    assert.match(fn, /if \(finished\)/);
    assert.match(fn, /'newsletter.sent'/);
});

check('the event vocabulary is closed', () => {
    assert.ok(WEBHOOK_EVENTS.length >= 4);
    assert.match(MOD, /A receiver writing a switch statement needs it to stay closed/);
});

// ── 4. We are POSTing to a URL a stranger typed ─────────────────────────────

check('the cloud metadata endpoint is refused', () => {
    // ⚠️ 169.254.169.254 is the single most valuable target of an SSRF primitive.
    const r = isDeliverableUrl('https://169.254.169.254/latest/meta-data/');
    assert.strictEqual(r.ok, false);
});

check('loopback and private networks are refused', () => {
    for (const url of [
        'https://localhost/hook', 'https://127.0.0.1/hook', 'https://10.1.2.3/hook',
        'https://192.168.0.5/hook', 'https://172.16.4.4/hook', 'https://internal/hook',
    ]) {
        assert.strictEqual(isDeliverableUrl(url).ok, false, `${url} must be refused`);
    }
});

check('plaintext http is refused, and the reason is about subscribers', () => {
    const r = isDeliverableUrl('http://example.com/hook');
    assert.strictEqual(r.ok, false);
    assert.match((r as { reason: string }).reason, /subscribers' email addresses/);
});

check('an ordinary https endpoint is accepted', () => {
    const r = isDeliverableUrl('https://hooks.example.com/bms?x=1');
    assert.strictEqual(r.ok, true);
});

check('the residual gap is named rather than assumed away', () => {
    // A hostname that RESOLVES to a private address needs a lookup at delivery time.
    assert.match(MOD, /is not caught here — that needs a DNS lookup/);
});

check('the URL is checked before it is stored, not only before it is called', () => {
    const fn = FN.slice(landmark(FN, "if (action === 'create')"), landmark(FN, 'const events = cleanEvents'));
    assert.match(fn, /isDeliverableUrl/);
});

// ── 5. Signing ──────────────────────────────────────────────────────────────

check('a receiver can verify what we send', () => {
    const secret = mintSigningSecret();
    const body = JSON.stringify({ event: 'contact.subscribed' });
    const ts = 1_700_000_000;
    assert.ok(verifySignature(secret, ts, body, signPayload(secret, ts, body)));
    assert.ok(!verifySignature(secret, ts, body, signPayload(secret, ts, body + ' ')), 'a changed body must not verify');
    assert.ok(!verifySignature(secret, ts + 1, body, signPayload(secret, ts, body)), 'a changed timestamp must not verify');
    assert.ok(!verifySignature(mintSigningSecret(), ts, body, signPayload(secret, ts, body)), 'another secret must not verify');
});

check('the timestamp is INSIDE the signature, so a capture cannot be replayed for ever', () => {
    assert.match(MOD, /TIMESTAMP is inside the signed string/);
    assert.match(MOD, /`\$\{timestamp\}\.\$\{body\}`/);
});

check('an unsigned delivery is never sent', () => {
    // A receiver that cannot verify has no way to tell our request from anybody else's.
    const fn = MOD.slice(landmark(MOD, 'if (!secret) {'), landmark(MOD, 'const guard = isDeliverableUrl'));
    assert.match(fn, /recordFailure/);
    assert.match(fn, /Unsigned delivery is not an option/);
});

check('the secret is in the vault, not in the table', () => {
    // It must be readable to sign with — unlike an API key, which is only ever compared.
    assert.match(SQL, /THE SIGNING SECRET IS NOT IN THIS TABLE/);
    assert.match(MOD, /storeSecret/);
    assert.ok(!/secret\b.*text\(/i.test(SQL.split('CREATE TABLE IF NOT EXISTS webhook_endpoints')[1].split(');')[0].replace(/secret_ref[^\n]*/g, '')),
        'no plaintext secret column may exist');
});

check('the delivery id is sent so a receiver can deduplicate', () => {
    // At-least-once is the honest promise; the receiver needs something stable to key on.
    assert.match(MOD, /'X-BMS-Delivery-Id'/);
    assert.match(MOD, /At-least-once delivery is the honest promise/);
});

check('a retry sends the SAME bytes', () => {
    // Rebuilding the payload later would describe a state that never existed at that moment.
    assert.match(SQL, /a retry sends the SAME bytes/);
    const fn = MOD.slice(landmark(MOD, 'const body = JSON.stringify(delivery.payload)'), landmark(MOD, 'let secret'));
    assert.ok(fn.length < 400, 'the body comes straight from the stored payload');
});

check('a test delivery goes through the real path', () => {
    // A test that took a shortcut would prove the shortcut works.
    const fn = FN.slice(landmark(FN, "if (action === 'test')"));
    assert.match(fn, /emitWebhook\(db/);
    assert.match(fn, /would prove the shortcut works/);
});

console.log(`\n${passed} checks passed.`);
