// tests/mailbox-push.test.ts
// The Email Assistant, Phase 3b (docs/email-assistant-plan.md §4.2–4.3): new mail by push. Holds together:
//   · a Gmail push is accepted only with a Google-signed token for OUR audience AND our service account
//   · an Outlook notification is accepted only with the mailbox's own clientState (constant-time)
//   · bad bodies are acknowledged and ignored; the Gmail webhook answers 200 with a body, never 204
//   · push is off on a site without its settings; polling then stays at 10 minutes
//   · watched mailboxes are polled every 30 minutes; a push mid-run causes exactly one more run
//   · disconnect stops the watch first; the poll run starts and renews watches
//
// Run:  npx tsx tests/mailbox-push.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
    clientStateMatches, graphClientState, parseGraphNotifications, parsePubSubPush, pushConfigured, verifyPubSubToken,
} from '../src/utils/mailbox-push';
import { graphExpiry, GRAPH_SUBSCRIPTION_MINUTES, GRAPH_INBOX_RESOURCE } from '../src/utils/mail-reader/watch';
import { validationReply } from '../netlify/functions/mail-push-graph';
import { pushedDuringRun } from '../netlify/functions/mailbox-sync-background';

let passed = 0;
const pendingChecks: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>): void {
    const fail = (err: unknown) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; };
    try {
        const r = fn();
        if (r && typeof (r as Promise<void>).then === 'function') { pendingChecks.push((r as Promise<void>).then(() => { passed++; console.log(`  ✓ ${name}`); }, fail)); return; }
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) { fail(err); }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── Gmail: Pub/Sub OIDC token ─────────────────────────────────────────────────────────────────────

const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const googlePem = google.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const certs = async () => ({ 'kid-1': googlePem });
const AUD = 'https://staging--bemoreswan.netlify.app/.netlify/functions/mail-push-gmail';
const SA = 'gmail-push@bms-mail.iam.gserviceaccount.com';
function token(claims: Record<string, unknown>, opts: { key?: typeof google.privateKey; kid?: string; expiresIn?: number } = {}) {
    return 'Bearer ' + jwt.sign(
        { iss: 'https://accounts.google.com', aud: AUD, email: SA, email_verified: true, ...claims },
        opts.key ?? google.privateKey,
        { algorithm: 'RS256', keyid: opts.kid ?? 'kid-1', expiresIn: opts.expiresIn ?? 300 },
    );
}
const verify = (h: string | undefined) => verifyPubSubToken(h, { audience: AUD, serviceAccount: SA, certs });

console.log('Gmail push: who may call');

check('a token from our subscription is accepted', async () => {
    assert.strictEqual(await verify(token({})), true);
    assert.strictEqual(await verify(token({ iss: 'accounts.google.com', email: SA.toUpperCase() })), true);
});
check('another Google Cloud account minting a token for our URL is refused (the email check)', async () => {
    assert.strictEqual(await verify(token({ email: 'attacker@evil-project.iam.gserviceaccount.com' })), false);
    assert.strictEqual(await verify(token({ email_verified: false })), false);
});
check('wrong audience, wrong issuer, expired, wrong key, unknown kid, no token → refused', async () => {
    assert.strictEqual(await verify(token({ aud: 'https://example.com/other' })), false);
    assert.strictEqual(await verify(token({ iss: 'https://evil.example' })), false);
    assert.strictEqual(await verify(token({}, { expiresIn: -10 })), false);
    assert.strictEqual(await verify(token({}, { key: other.privateKey })), false);
    assert.strictEqual(await verify(token({}, { kid: 'kid-unknown' })), false);
    assert.strictEqual(await verify(undefined), false);
    assert.strictEqual(await verify('Bearer not-a-jwt'), false);
});
check('unset audience or service account fails CLOSED', async () => {
    assert.strictEqual(await verifyPubSubToken(token({}), { audience: '', serviceAccount: SA, certs }), false);
    assert.strictEqual(await verifyPubSubToken(token({}), { audience: AUD, serviceAccount: '', certs }), false);
});
check('an HS256 token signed with the public key as a secret is refused (algorithm pinned)', async () => {
    const forged = 'Bearer ' + jwt.sign({ iss: 'https://accounts.google.com', aud: AUD, email: SA, email_verified: true }, 'secret', { algorithm: 'HS256', keyid: 'kid-1' });
    assert.strictEqual(await verify(forged), false);
});

console.log('Gmail push: the body');

check('Pub/Sub body → address (lower-cased) and historyId', () => {
    const data = Buffer.from(JSON.stringify({ emailAddress: 'Jo@Example.com', historyId: 12345 })).toString('base64');
    assert.deepStrictEqual(parsePubSubPush({ message: { data, messageId: '1' }, subscription: 's' }), { emailAddress: 'jo@example.com', historyId: '12345' });
});
check('bad bodies give null (acknowledged and ignored, never thrown)', () => {
    assert.strictEqual(parsePubSubPush(null), null);
    assert.strictEqual(parsePubSubPush({}), null);
    assert.strictEqual(parsePubSubPush({ message: { data: 'not base64 json' } }), null);
    assert.strictEqual(parsePubSubPush({ message: { data: Buffer.from('{"emailAddress":"nope"}').toString('base64') } }), null);
    assert.strictEqual(parsePubSubPush({ message: { data: 'x'.repeat(5000) } }), null);
});

// ── Outlook: Graph clientState ────────────────────────────────────────────────────────────────────

console.log('Outlook push: who may call');

const SECRET = 'test-graph-secret';
check('clientState is per mailbox and checked exactly', () => {
    const s7 = graphClientState(7, SECRET);
    assert.ok(s7.length <= 128, 'Graph allows up to 128 characters');
    assert.notStrictEqual(s7, graphClientState(8, SECRET));
    assert.strictEqual(clientStateMatches(7, s7, SECRET), true);
    assert.strictEqual(clientStateMatches(8, s7, SECRET), false, "one mailbox's state never wakes another");
    assert.strictEqual(clientStateMatches(7, s7.slice(0, -1), SECRET), false);
    assert.strictEqual(clientStateMatches(7, null, SECRET), false);
    assert.strictEqual(clientStateMatches(7, s7, undefined), false, 'no secret → nothing accepted');
    assert.notStrictEqual(graphClientState(7, 'other-secret'), s7);
});
check('Graph notifications are parsed; entries without a subscription id are dropped; capped at 100', () => {
    const n = parseGraphNotifications({ value: [
        { subscriptionId: 'sub-1', clientState: 'x', changeType: 'created' },
        { subscriptionId: 'sub-2', clientState: 'y', lifecycleEvent: 'subscriptionRemoved' },
        { clientState: 'z' },
    ] });
    assert.strictEqual(JSON.stringify(n), JSON.stringify([
        { subscriptionId: 'sub-1', clientState: 'x', lifecycleEvent: null },
        { subscriptionId: 'sub-2', clientState: 'y', lifecycleEvent: 'subscriptionRemoved' },
    ]));
    assert.strictEqual(parseGraphNotifications({ value: Array.from({ length: 150 }, (_, i) => ({ subscriptionId: `s${i}` })) }).length, 100);
    assert.deepStrictEqual(parseGraphNotifications(null), []);
    assert.deepStrictEqual(parseGraphNotifications({ value: 'x' }), []);
});
check('the validation handshake echoes the token as text/plain, and refuses markup', () => {
    const r = validationReply('Validation: Testing client application reachability for subscription Request-Id: abc');
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.headers['Content-Type'], 'text/plain');
    assert.strictEqual(r.body, 'Validation: Testing client application reachability for subscription Request-Id: abc');
    assert.strictEqual(validationReply('<script>alert(1)</script>').statusCode, 400);
    assert.strictEqual(validationReply('x'.repeat(2000)).statusCode, 400);
});
check('subscription: the Inbox, new mail only, 6 days (inside Graph\'s 7-day limit for mail)', () => {
    assert.strictEqual(GRAPH_INBOX_RESOURCE, "me/mailFolders('inbox')/messages");
    assert.ok(GRAPH_SUBSCRIPTION_MINUTES < 10080);
    const now = new Date('2026-11-26T10:00:00Z');
    assert.strictEqual(graphExpiry(now), '2026-12-02T10:00:00.000Z');
    assert.ok(/changeType: 'created',/.test(code('src/utils/mail-reader/watch.ts')));
});

// ── Off unless set up ─────────────────────────────────────────────────────────────────────────────

console.log('Push is off unless set up');

check('Gmail push needs topic, audience AND service account; Outlook needs the notify secret', () => {
    const full = { GMAIL_PUBSUB_TOPIC: 'projects/p/topics/t', GMAIL_PUSH_AUDIENCE: AUD, GMAIL_PUSH_SERVICE_ACCOUNT: SA } as NodeJS.ProcessEnv;
    assert.strictEqual(pushConfigured('gmail', full), true);
    assert.strictEqual(pushConfigured('gmail', { ...full, GMAIL_PUSH_SERVICE_ACCOUNT: '' }), false);
    assert.strictEqual(pushConfigured('gmail', { ...full, GMAIL_PUBSUB_TOPIC: undefined }), false);
    assert.strictEqual(pushConfigured('outlook', {} as NodeJS.ProcessEnv), false);
    assert.strictEqual(pushConfigured('outlook', { GRAPH_NOTIFY_SECRET: 's' } as NodeJS.ProcessEnv), true);
    assert.strictEqual(pushConfigured('imap', full), false);
});

// ── Wiring ────────────────────────────────────────────────────────────────────────────────────────

console.log('Wiring');

check('Gmail webhook: POST only, token checked before the body is read, 200 with a body (never 204)', () => {
    const c = code('netlify/functions/mail-push-gmail.ts');
    assert.ok(c.indexOf('verifyPubSubToken(auth)') > -1 && c.indexOf('verifyPubSubToken(auth)') < c.indexOf('JSON.parse(event.body'));
    assert.ok(!/statusCode: 204/.test(c));
    assert.ok(/statusCode: 200, headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify/.test(c));
    assert.ok(!/emailAddress[^)]*console|console[^;]*emailAddress/.test(c), 'the address is never logged');
});
check('Graph webhook: validation answered first; every notification checked against its own mailbox', () => {
    const c = code('netlify/functions/mail-push-graph.ts');
    assert.ok(c.indexOf('validationToken') < c.indexOf("event.httpMethod !== 'POST'"));
    assert.ok(/if \(!box \|\| !clientStateMatches\(box\.id, n\.clientState\)\) continue;/.test(c));
});
check('30-minute poll only when push is proven (watch AND a push in the last day); otherwise 10', () => {
    const c = code('src/utils/mailbox-sync.ts');
    assert.ok(/WHEN \$\{mailboxes\.watchExpiresAt\} > now\(\) AND \$\{mailboxes\.lastPushAt\} > now\(\) - interval '1 day'\s*THEN interval '29 minutes' ELSE interval '9 minutes' END/.test(c));
});
check('a failing watch or a flag-off workspace waits 6 hours, so it never blocks the per-run places (review of #906)', () => {
    const c = code('src/utils/mailbox-push.ts');
    assert.ok(/await retryWatchLater\(db, box\.id\);\s*return 'failed';/.test(c));
    assert.ok(/out\.off\+\+; await retryWatchLater\(db, box\.id\); continue;/.test(c));
});
check("disconnect never calls Gmail's users.stop (it would end push for every connection of that address)", () => {
    const c = code('src/utils/mailbox-push.ts');
    assert.ok(!/stopGmailWatch/.test(c));
    assert.ok(/if \(box\.provider !== 'outlook' \|\| !box\.watchId\) return;/.test(c));
});
check('Graph: dispatches run in parallel; reauthorization renews only with the flag on', () => {
    assert.ok(/await Promise\.all\(free\.map\(\(r\) => triggerMailboxSync\(r\.id\)\)\)/.test(code('src/utils/mailbox-push.ts')));
    assert.ok(/isFeatureEnabled\(row\.organisationId, EMAIL_ASSISTANT_FLAG\)[^\n]*ensureWatch\(db, row\)/.test(code('netlify/functions/mail-push-graph.ts')));
});
check('a push during a run causes one more run, only after a run that worked', () => {
    const start = new Date('2026-11-26T10:00:00Z');
    assert.strictEqual(pushedDuringRun(start, new Date('2026-11-26T10:00:05Z')), true);
    assert.strictEqual(pushedDuringRun(start, new Date('2026-11-26T09:59:00Z')), false);
    assert.strictEqual(pushedDuringRun(start, null), false);
    const c = code('netlify/functions/mailbox-sync-background.ts');
    assert.ok(/if \(outcome\.ran && !outcome\.error\) \{/.test(c));
    // recordPush skips a mailbox mid-run (no function call per push during a long first read).
    assert.ok(/!\(r\.lockedUntil && r\.lockedUntil\.getTime\(\) > Date\.now\(\)\)/.test(code('src/utils/mailbox-push.ts')));
});
check('disconnect stops the watch before the token is deleted; the poll run starts and renews watches', () => {
    const m = code('netlify/functions/mailboxes.ts');
    const stop = m.indexOf('await stopWatch(db, box);');
    assert.ok(stop > -1 && stop < m.indexOf('await disconnectMailbox(db, ctx.organisationId'));
    assert.ok(/const watches = await ensureWatches\(getDb\(\)\);/.test(code('netlify/functions/poll-mailboxes.ts')));
    // A workspace without the Email Assistant flag gets no watch.
    assert.ok(/isFeatureEnabled\(box\.organisationId, EMAIL_ASSISTANT_FLAG\)/.test(code('src/utils/mailbox-push.ts')));
});
check('reconnecting clears the watch expiry, so push starts again at the next poll', () => {
    const c = code('netlify/functions/mailbox-oauth.ts');
    assert.ok(/status: 'active', lastError: null,[\s\S]{0,300}watchExpiresAt: null,/.test(c));
});
check('schema mirrors db/z-mailbox-push.sql', () => {
    const s = code('db/schema.ts');
    const sqlFile = readFileSync(join(root, 'db/z-mailbox-push.sql'), 'utf8');
    for (const [col, prop] of [['watch_expires_at', 'watchExpiresAt'], ['watch_id', 'watchId'], ['last_push_at', 'lastPushAt']]) {
        assert.ok(new RegExp(`${prop}: \\w+\\("${col}"\\)`).test(s), prop);
        assert.ok(sqlFile.includes(`ADD COLUMN IF NOT EXISTS ${col}`), col);
    }
});

void Promise.all(pendingChecks).then(() => console.log(`\n${passed} checks passed${process.exitCode ? ' — with FAILURES above' : ''}`));
