// tests/newsletter-dispatch.test.ts
// Actually sending the thing — the phase where a mistake reaches strangers' inboxes and cannot be
// recalled. Five failures worth more than the code that prevents them:
//
//   1. SENDING TWICE. A claim that is not status-guarded lets two overlapping cron ticks both take
//      the same issue. Five blog jobs once became nine published posts exactly this way, and a blog
//      post can be deleted — an email cannot.
//   2. SENDING TO SOMEONE WHO LEFT. Approval and delivery can be days apart. Consent has to be
//      re-checked per recipient at send time, against the shared resolver, or an unsubscribe
//      recorded in between is ignored.
//   3. HALF-SENDING. A mailbox hits its daily cap partway through and the tenant cannot tell who
//      received it. The size check therefore runs BEFORE the first email, not at the send site.
//   4. LOSING A COMPLAINT. A spam complaint is the strongest "stop emailing me" there is. It has to
//      bind the Lead Generator too, or the person who pressed the spam button gets cold-emailed.
//   5. TRUSTING AN UNSIGNED WEBHOOK. Anyone could otherwise mark a tenant's whole list as bounced.

import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audienceContacts, leadOptOuts, newsletterIssues, newsletterSendingDomains, newsletterSends, organisations, suppressionList, workspaceIntegrations } from '../db/schema';
import { MAILBOX_MAX_RECIPIENTS, mintUnsubscribeToken, processIssueBatch, resolveSendRoute } from '../src/utils/newsletter-send';
import { buildFromAddress, normaliseSendingDomain, isSubdomain } from '../src/utils/sending-domain';
import { verifySvixSignature } from '../src/utils/webhook-verify';
import { renderIssueSnapshot } from '../src/utils/newsletter-render';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).then(ok, bad);
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

const SEND = read('src/utils/newsletter-send.ts');
const HOOK = read('netlify/functions/newsletter-webhook.ts');
const UNSUB = read('netlify/functions/newsletter-unsubscribe.ts');
const CRON = read('netlify/functions/process-newsletter-sends.ts');

// ── fake db ─────────────────────────────────────────────────────────────────
const TABLES = new Map<unknown, string>([
    [audienceContacts, 'audience_contacts'], [leadOptOuts, 'lead_opt_outs'],
    [suppressionList, 'suppression_list'], [newsletterIssues, 'newsletter_issues'],
    [newsletterSends, 'newsletter_sends'], [newsletterSendingDomains, 'newsletter_sending_domains'],
    [organisations, 'organisations'], [workspaceIntegrations, 'workspace_integrations'],
]);

function fakeDb(opts: { rows?: Record<string, unknown[]> } = {}) {
    const calls: string[] = [];
    const writes: { key: string; set: Record<string, unknown> }[] = [];
    const chain = (op: string) => {
        let table = '';
        let lastSet: Record<string, unknown> = {};
        const key = () => `${op}:${table}`;
        const record = (args: unknown[]) => {
            for (const a of args) { const n = TABLES.get(a); if (n) table = n; }
            return proxy;
        };
        const proxy: any = new Proxy(function () { /* builder */ } as never, {
            apply(_t, _this, args: unknown[]) { return record(args); },
            get(_t, prop) {
                if (prop === 'then') {
                    return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
                        calls.push(key());
                        if (op !== 'select') writes.push({ key: key(), set: lastSet });
                        return Promise.resolve(opts.rows?.[key()] ?? []).then(res, rej);
                    };
                }
                return (...args: unknown[]) => {
                    if (prop === 'set' || prop === 'values') lastSet = (args[0] || {}) as Record<string, unknown>;
                    return record(args);
                };
            },
        });
        return proxy;
    };
    const db = {
        select: (c: unknown) => chain('select')(c),
        insert: (t: unknown) => chain('insert')(t),
        update: (t: unknown) => chain('update')(t),
        delete: (t: unknown) => chain('delete')(t),
    };
    return { db: db as never, calls, writes };
}

async function main() {

// ── 1. Which route may this org send on ─────────────────────────────────────

await check('a verified domain is used, and the From line is the tenant\'s own', async () => {
    const { db } = fakeDb({ rows: { 'select:newsletter_sending_domains': [
        { domain: 'mail.acme.com', fromName: 'Acme Ltd', fromLocalPart: 'hello', replyTo: null, verifiedAt: new Date() },
    ] } });
    const res = await resolveSendRoute(db, 7, { recipientCount: 5000, senderName: 'Acme Ltd' });
    assert.ok('route' in res);
    assert.equal(res.route.provider, 'resend');
    assert.equal(res.route.from, 'Acme Ltd <hello@mail.acme.com>');
});

await check('with no domain, a connected mailbox sends a SMALL list', async () => {
    const { db } = fakeDb({ rows: {
        'select:newsletter_sending_domains': [],
        'select:workspace_integrations': [{ provider: 'gmail' }],
    } });
    const res = await resolveSendRoute(db, 7, { recipientCount: 50, senderName: 'Acme Ltd' });
    assert.ok('route' in res);
    assert.equal(res.route.provider, 'gmail');
    assert.equal(res.route.from, null, 'the mailbox IS the from address');
});

await check('the mailbox route is refused ABOVE the cap, before a single email goes out', async () => {
    // Half-sending is the worst outcome available: the tenant cannot tell who received it, and the
    // cap that stopped it also suspends the mailbox they run their business from.
    const { db } = fakeDb({ rows: {
        'select:newsletter_sending_domains': [],
        'select:workspace_integrations': [{ provider: 'gmail' }],
    } });
    const res = await resolveSendRoute(db, 7, { recipientCount: MAILBOX_MAX_RECIPIENTS + 1, senderName: 'Acme Ltd' });
    assert.ok('error' in res);
    assert.match(res.error, new RegExp(String(MAILBOX_MAX_RECIPIENTS)), 'name the cap');
    assert.match(res.error, /sending domain/i, 'and name the fix');
});

await check('no domain and no mailbox is an error, never a silent no-op', async () => {
    const { db } = fakeDb({ rows: { 'select:newsletter_sending_domains': [], 'select:workspace_integrations': [] } });
    const res = await resolveSendRoute(db, 7, { recipientCount: 10, senderName: 'Acme Ltd' });
    assert.ok('error' in res);
});

await check('the size check happens in the ROUTE resolver, not at the send site', () => {
    const fn = SEND.slice(landmark(SEND, 'export async function resolveSendRoute'), landmark(SEND, 'export function mintUnsubscribeToken'));
    assert.ok(fn.includes('MAILBOX_MAX_RECIPIENTS'), 'checked before anything is sent');
    const sweep = SEND.slice(landmark(SEND, 'export async function sendDueIssues'));
    assert.ok(sweep.indexOf('resolveSendRoute') < sweep.indexOf('processIssueBatch'),
        'the route (and its cap) must be resolved before the first batch');
});

// ── 2. Consent is re-checked at send time ───────────────────────────────────

await check('a recipient who unsubscribed after approval is SKIPPED, with the reason recorded', async () => {
    const snapshot = await renderIssueSnapshot({ bodyMarkdown: 'Hi {{contact.first_name | "there"}}.', senderName: 'Acme Ltd' });
    const { db, writes } = fakeDb({ rows: {
        'select:newsletter_sends': [{ id: 11, email: 'gone@acme.com', contactId: 3, token: 'tok_aaaaaaaaaaaaaaaa' }],
        // The audience says unsubscribed — approved days ago, left yesterday.
        'select:audience_contacts': [{ email: 'gone@acme.com', status: 'unsubscribed', unsubscribedAt: new Date() }],
    } });
    const res = await processIssueBatch(db,
        { id: 5, organisationId: 7, subject: 'Hello', renderedPayload: snapshot, fromAddress: null, sendProvider: null },
        { route: { provider: 'resend', from: 'Acme <hello@mail.acme.com>', replyTo: null }, senderName: 'Acme Ltd', postalAddress: null, baseUrl: 'https://bemoreswan.com' });

    assert.equal(res.sent, 0, 'nothing may be sent to them');
    assert.equal(res.skipped, 1);
    const skip = writes.find((w) => w.key === 'update:newsletter_sends');
    assert.equal(skip?.set.status, 'skipped');
    assert.equal(skip?.set.skipReason, 'opted_out', 'a skip with no reason is the shape of a silent bug');
});

await check('the send path asks the SHARED resolver, so a Lead Generator opt-out blocks a newsletter', () => {
    assert.match(SEND, /checkAudienceConsentBulk/,
        'audience-consent.ts is the only thing allowed to answer "may we email this person"');
    const batch = SEND.slice(landmark(SEND, 'export async function processIssueBatch'));
    assert.ok(batch.indexOf('checkAudienceConsentBulk') < batch.indexOf('await deliver('),
        'consent must be resolved before anything is delivered');
});

await check('a missing verdict is treated as unsendable', () => {
    const batch = SEND.slice(landmark(SEND, 'export async function processIssueBatch'));
    assert.match(batch, /verdicts\.get\(row\.email\) \?\? \{ sendable: false/,
        'an address the resolver could not key is one we cannot vouch for');
});

// ── 3. Nobody is emailed twice ──────────────────────────────────────────────

await check('the issue claim is status-guarded AND checked', () => {
    // The exact failure from the blog pipeline: an unguarded claim, or one whose result is not
    // inspected, lets two ticks both proceed.
    const sweep = SEND.slice(landmark(SEND, 'export async function sendDueIssues'));
    const claim = sweep.slice(landmark(sweep, 'const [claimed] = await db'), landmark(sweep, 'out.claimed++'));
    assert.match(claim, /eq\(newsletterIssues\.status, status\)/, 'the WHERE must re-assert the status it read');
    assert.match(claim, /if \(!claimed\) continue;/, 'and a lost race must bail, not carry on');
});

await check('recipients are materialised once, idempotently', () => {
    const fn = SEND.slice(landmark(SEND, 'export async function materialiseRecipients'), landmark(SEND, 'async function deliver'));
    assert.match(fn, /onConflictDoNothing/, 'UNIQUE (issue_id, email) plus this is what makes a re-run safe');
    assert.ok(fn.includes('unsubscribeToken: mintUnsubscribeToken()'), 'every recipient gets their own token');
});

await check('a ledger row is only written when it is still queued', () => {
    const batch = SEND.slice(landmark(SEND, 'export async function processIssueBatch'));
    const updates = batch.match(/eq\(newsletterSends\.status, 'queued'\)/g) || [];
    assert.ok(updates.length >= 3,
        'skip, sent and failed must each re-assert queued — otherwise a second worker overwrites a finished row');
});

await check('one bad address does not strand the rest of the list', () => {
    const batch = SEND.slice(landmark(SEND, 'export async function processIssueBatch'));
    const fail = batch.slice(landmark(batch, '} catch (err) {'));
    assert.match(fail.slice(0, 600), /status: 'failed'/);
    assert.ok(!/throw/.test(fail.slice(0, 400)), 'the loop must continue past a failed recipient');
});

await check('tokens are unguessable and unique per recipient', () => {
    const a = mintUnsubscribeToken();
    const b = mintUnsubscribeToken();
    assert.notEqual(a, b);
    assert.ok(a.length >= 20, 'a guessable token lets anyone unsubscribe anyone');
    assert.match(a, /^[A-Za-z0-9_-]+$/, 'must survive a URL without escaping');
});

// ── 4. Delivery events ──────────────────────────────────────────────────────

await check('an unsigned webhook is rejected with 401, and never retried into a storm', () => {
    const guard = HOOK.slice(landmark(HOOK, 'const ok = verifySvixSignature'), landmark(HOOK, 'let payload'));
    assert.match(guard, /401/);
    assert.ok(!guard.includes('500'), 'a 5xx would make a misconfigured secret retry forever');
    assert.match(HOOK, /rawBody/, 'the signature must be checked against the RAW body, never a re-serialised copy');
});

await check('svix signatures verify, and fail closed on the ways they can be wrong', () => {
    const secret = 'whsec_' + Buffer.from('super-secret-key').toString('base64');
    const id = 'msg_123';
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"email.delivered"}';
    const sig = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
        .update(`${id}.${ts}.${body}`).digest('base64');

    assert.equal(verifySvixSignature({ secret, id, timestamp: ts, signature: `v1,${sig}`, rawBody: body }), true);
    // Rotation: two signatures in the header, only the second valid.
    assert.equal(verifySvixSignature({ secret, id, timestamp: ts, signature: `v1,ZmFrZQ== v1,${sig}`, rawBody: body }), true,
        'a secret being rotated means two valid signatures for a window');
    assert.equal(verifySvixSignature({ secret, id, timestamp: ts, signature: `v1,${sig}`, rawBody: body + ' ' }), false,
        'a changed body must not verify');
    assert.equal(verifySvixSignature({ secret: 'whsec_' + Buffer.from('other').toString('base64'), id, timestamp: ts, signature: `v1,${sig}`, rawBody: body }), false);
    assert.equal(verifySvixSignature({ secret, id, timestamp: String(Number(ts) - 4000), signature: `v1,${sig}`, rawBody: body }), false,
        'a replayed old event must be refused');
    assert.equal(verifySvixSignature({ secret: undefined, id, timestamp: ts, signature: `v1,${sig}`, rawBody: body }), false,
        'no configured secret must never mean "accept everything"');
});

await check('a spam complaint binds the Lead Generator too', () => {
    // The whole cross-assistant promise, at its most consequential point.
    const branch = HOOK.slice(landmark(HOOK, "if (type === 'email.complained')"));
    assert.match(branch, /setContactStatus/, 'the audience is blocked');
    assert.match(branch, /insert\(leadOptOuts\)/, 'and so is cold outreach');
    assert.ok(branch.indexOf('setContactStatus') < branch.indexOf('insert(leadOptOuts)'),
        'the audience write comes first — if only one lands, it should be the one covering the list they complained about');
});

await check('a SOFT bounce does not condemn the address', () => {
    // A full mailbox is not a dead address. Treating every bounce as permanent quietly erodes a
    // tenant's list every time a mail server has a bad day.
    const branch = HOOK.slice(landmark(HOOK, "if (type === 'email.bounced')"), landmark(HOOK, "if (type === 'email.complained')"));
    assert.match(branch, /if \(hard\)/);
    assert.ok(branch.indexOf('HARD_BOUNCE_TYPES') > -1 || SEND.includes('HARD_BOUNCE_TYPES') || HOOK.includes('HARD_BOUNCE_TYPES'));
});

await check('a webhook failure returns 500 so the provider retries', () => {
    const tail = HOOK.slice(landmark(HOOK, '} catch (err) {'));
    assert.match(tail, /500/, 'a dropped bounce is a subscriber we keep emailing');
});

// ── 5. The way out ──────────────────────────────────────────────────────────

await check('HEAD on the unsubscribe route records nothing', () => {
    const head = UNSUB.slice(landmark(UNSUB, "if (method === 'HEAD')"), landmark(UNSUB, "if (method !== 'GET'"));
    assert.match(head, /statusCode: 200/);
    assert.ok(!head.includes('setContactStatus'));
    assert.ok(landmark(UNSUB, "if (method === 'HEAD')") < landmark(UNSUB, 'const db = getDb()'),
        'answered before any database work');
});

await check('one-click POST works without a human, and the page POSTs too', () => {
    // RFC 8058: Gmail and Yahoo fire this with no interaction. Unlike the CONFIRM link, actioning
    // it automatically is the safe direction — a false positive costs one subscriber, not consent
    // manufactured on a stranger's behalf.
    assert.match(UNSUB, /oneClick/);
    assert.match(UNSUB, /method="POST"/, 'the human-facing page needs a form, not a bare link');
    const post = UNSUB.slice(landmark(UNSUB, 'await setContactStatus'));
    assert.match(post.slice(0, 500), /status: 'unsubscribed'/);
});

await check('the newsletter unsubscribe writes the AUDIENCE, not one of the other two tables', () => {
    // Three unsubscribe routes now exist for three different kinds of person. Reaching for the
    // wrong table is the collision this codebase has already had twice.
    assert.ok(!UNSUB.includes('winBackOptOuts'), 'that one is Be More Swan mailing its own users');
    assert.ok(!UNSUB.includes('leadThreads'), 'that one is a prospect leaving cold outreach');
    assert.match(UNSUB, /setContactStatus/);
});

await check('an unsubscribe that cannot be recorded is loud, and never shown as a stack trace', () => {
    const tail = UNSUB.slice(landmark(UNSUB, '} catch (err) {'));
    assert.match(tail, /console\.error/);
    assert.ok(!tail.includes('throw'), 'a person clicking unsubscribe must never see an error page they cannot act on');
});

// ── 6. Sending identity ─────────────────────────────────────────────────────

await check('a crafted business name cannot restructure the From header', () => {
    const from = buildFromAddress(
        { fromName: 'Acme" <evil@attacker.com>\r\nBcc: victim@x.com', fromLocalPart: 'hello', domain: 'mail.acme.com' },
        'Acme');
    assert.ok(!from.includes('\r') && !from.includes('\n'), 'no header injection');
    assert.equal((from.match(/</g) || []).length, 1, 'exactly one address in the header');
});

await check('the sending domain must look like a domain', () => {
    assert.equal(normaliseSendingDomain('https://mail.acme.com/path'), 'mail.acme.com');
    assert.equal(normaliseSendingDomain('  MAIL.Acme.com '), 'mail.acme.com');
    for (const bad of ['jane@acme.com', 'localhost', 'acme', 'mail acme.com', '']) {
        assert.equal(normaliseSendingDomain(bad), null, `${bad} must be refused`);
    }
    assert.equal(isSubdomain('mail.acme.com'), true);
    assert.equal(isSubdomain('acme.com'), false, 'the root-domain warning depends on this');
});

await check('the restricted-key trap is reported as OUR problem, not the tenant\'s DNS', () => {
    const dom = read('src/utils/sending-domain.ts');
    assert.match(dom, /restricted_api_key/);
    assert.match(dom, /RESEND_DOMAINS_API_KEY/);
    const classify = dom.slice(landmark(dom, 'function classify'), landmark(dom, 'export function normaliseSendingDomain'));
    assert.match(classify, /operatorError: true/, 'a tenant can do nothing about our API key');
});

// ── 7. The cron ─────────────────────────────────────────────────────────────

await check('the worker refuses to send without a base URL', () => {
    // Every footer needs an absolute unsubscribe link; guessing a host would ship dead links.
    assert.match(CRON, /resolveBaseUrl/);
    const guard = CRON.slice(landmark(CRON, 'if (!baseUrl)'), landmark(CRON, 'const db = getDb()'));
    assert.match(guard, /return \{ statusCode: 500/);
});

await check('the cron logs one line per tick, so a dead schedule is visible', () => {
    // Two nightly sweeps in this codebase ran for months doing nothing and nobody could tell.
    assert.match(CRON, /console\.log\('\[process-newsletter-sends\]'/);
    const toml = read('netlify.toml');
    const block = toml.slice(landmark(toml, '[functions.process-newsletter-sends]'));
    assert.match(block.slice(0, 120), /schedule = "\*\/5 \* \* \* \*"/);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
