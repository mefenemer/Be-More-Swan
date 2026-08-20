// tests/newsletter-resend.test.ts
// Resending an issue to the people who never opened it.
//
// The feature is one sentence — same email, new subject, only the non-openers — and every word of
// it is a way to mail people who did not ask for it again:
//
//   1. ⚠️ "NON-OPENERS" IS ONLY MEANINGFUL IF OPENS WERE MEASURABLE. An issue sent from a tenant's
//      own mailbox rewrites no links and embeds no pixel, so everyone looks unopened. Resending
//      that is a second unrequested email to the WHOLE list, sent in the belief nobody read it.
//   2. TOO SOON IS THE SAME MISTAKE. Opens arrive over days; somebody who reads on Sunday has not
//      declined it on Friday.
//   3. TWICE IS SPAM. One resend per issue, and a resend can never itself be resent.
//   4. THE COUNT ON THE BUTTON AND THE ROWS THAT GET SENT MUST BE THE SAME QUESTION. A preview that
//      disagrees with the send is only ever discovered by the recipients.
//   5. A SKIPPED OR FAILED RECIPIENT IS NOT A NON-OPENER. They never received it. Sweeping them in
//      turns this into "retry the addresses that bounced".

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { MIN_RESEND_WAIT_HOURS, resendEligibility } from '../src/utils/newsletter-resend';

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

const RESEND = read('src/utils/newsletter-resend.ts');
const SEND = read('src/utils/newsletter-send.ts');
const API = read('netlify/functions/newsletter-issues.ts');
const SQL = read('db/newsletter-resend.sql');
const UI = read('newsletter.js');

/**
 * A db that answers each query in turn from `results`. Enough for the eligibility ladder, whose
 * queries run in this order: (1) has this account ever recorded an open, (2) has this issue already
 * been resent, (3) how many non-openers are there.
 */
function fakeDb(results: unknown[][]) {
    let i = 0;
    const chain: any = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') {
                const rows = results[i++] ?? [];
                return (resolve: (r: unknown) => void) => resolve(rows);
            }
            return () => chain;
        },
    });
    return { select: () => chain } as any;
}

const HOUR = 60 * 60 * 1000;
const sentIssue = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 10,
    organisationId: 1,
    status: 'sent',
    sentAt: new Date(Date.now() - (MIN_RESEND_WAIT_HOURS + 1) * HOUR),
    engagementTracked: true,
    resendOfIssueId: null,
    ...over,
}) as any;

async function main() {

// ── 1. The guard that matters most ──────────────────────────────────────────

await check('an issue that could not report opens is never resendable', async () => {
    // Everyone looks unopened when there is no pixel and no link rewriting. This is the difference
    // between the feature and an incident.
    const v = await resendEligibility(fakeDb([]), sentIssue({ engagementTracked: false }));
    assert.strictEqual(v.canResend, false);
    assert.strictEqual(v.reason, 'not_tracked');
    assert.match(v.message!, /would email everyone who received it a second time/);
    assert.match(v.message!, /Verify a sending domain/, 'and it says what would make it possible');
});

await check('the tracking check happens before anything is counted', async () => {
    // A db that would throw if queried: the untracked refusal must not reach it.
    const exploding = { select: () => { throw new Error('must not query'); } } as any;
    const v = await resendEligibility(exploding, sentIssue({ engagementTracked: false }));
    assert.strictEqual(v.reason, 'not_tracked');
});

await check('tracking switched on is not the same as opens arriving', async () => {
    // ⚠️ engagement_tracked records that we ASKED the provider to track. Subscribing the webhook to
    // email.opened is a separate, manual step — miss it and every recipient of every issue reads as
    // a non-opener, which is the whole-list resend the flag above is supposed to prevent.
    const v = await resendEligibility(fakeDb([[]]), sentIssue());
    assert.strictEqual(v.reason, 'no_opens_recorded');
    assert.match(v.message!, /never recorded an open on this account/);
    assert.match(v.message!, /Get in touch/,
        'the fix is ours, not theirs — the copy must not send them hunting through settings they cannot see');
    assert.ok(!/webhook/i.test(v.message!), 'and must not name our provider configuration to a tenant');
});

await check('an account with any open history passes that check', async () => {
    const v = await resendEligibility(fakeDb([[{ id: 1 }], [], [{ n: 12 }]]), sentIssue());
    assert.strictEqual(v.canResend, true);
});

await check('a brand-new account is told to wait, not shown the instrumentation warning', async () => {
    // Zero opens two hours after a first send is normal. Ordering the ladder the other way would
    // alarm every new tenant with a message about something they cannot see.
    const v = await resendEligibility(fakeDb([[]]), sentIssue({ sentAt: new Date(Date.now() - 2 * HOUR) }));
    assert.strictEqual(v.reason, 'too_soon');
});

// ── 2. Too soon ─────────────────────────────────────────────────────────────

await check('a resend waits for opens to arrive', async () => {
    const v = await resendEligibility(fakeDb([]), sentIssue({ sentAt: new Date(Date.now() - 2 * HOUR) }));
    assert.strictEqual(v.reason, 'too_soon');
    assert.ok(v.availableAt, 'and it says when it becomes available');
    assert.ok(new Date(v.availableAt!).getTime() > Date.now());
});

await check('the wait is measured in days, not minutes', () => {
    assert.ok(MIN_RESEND_WAIT_HOURS >= 24,
        'anything under a day mails people who simply have not read it yet');
});

// ── 3. Once, and never a chain ──────────────────────────────────────────────

await check('a resend cannot itself be resent', async () => {
    const v = await resendEligibility(fakeDb([]), sentIssue({ resendOfIssueId: 9 }));
    assert.strictEqual(v.reason, 'is_resend');
});

await check('an issue already resent is refused, and the index says so too', async () => {
    const v = await resendEligibility(fakeDb([[{ id: 1 }], [{ id: 44 }]]), sentIssue());
    assert.strictEqual(v.reason, 'already_resent');
    // ⚠️ The check above is a race; the index is the guarantee.
    assert.match(SQL, /newsletter_issues_resend_of_uidx[\s\S]{0,160}\(resend_of_issue_id\)/);
    assert.match(SQL, /WHERE resend_of_issue_id IS NOT NULL/);
    assert.match(API, /already been resent once/, 'and a lost race is answered, not 500d');
});

await check('nobody left to send to is a refusal, not an empty send', async () => {
    const v = await resendEligibility(fakeDb([[{ id: 1 }], [], [{ n: 0 }]]), sentIssue());
    assert.strictEqual(v.reason, 'nobody_left');
});

await check('an eligible issue reports how many people it would reach', async () => {
    const v = await resendEligibility(fakeDb([[{ id: 1 }], [], [{ n: 417 }]]), sentIssue());
    assert.strictEqual(v.canResend, true);
    assert.strictEqual(v.unopened, 417);
});

// ── 4. One definition of "did not open" ─────────────────────────────────────

await check('the count and the send share one filter', () => {
    // A preview that disagrees with the send is only ever found by the recipients.
    assert.match(RESEND, /function unopenedFilter/);
    const count = RESEND.slice(landmark(RESEND, 'export async function countUnopened'), landmark(RESEND, 'export async function unopenedRecipientPage'));
    const page = RESEND.slice(landmark(RESEND, 'export async function unopenedRecipientPage'), landmark(RESEND, 'export async function resendEligibility'));
    assert.match(count, /unopenedFilter\(/);
    assert.match(page, /unopenedFilter\(/);
});

await check('only recipients we actually SENT to count as non-openers', () => {
    const fn = RESEND.slice(landmark(RESEND, 'function unopenedFilter'), landmark(RESEND, 'export async function countUnopened'));
    assert.match(fn, /eq\(newsletterSends\.status, 'sent'\)/,
        'a skipped or failed recipient never received it — including them retries bad addresses');
    assert.match(fn, /isNull\(newsletterSends\.openedAt\)/);
    assert.match(fn, /isNull\(newsletterSends\.clickedAt\)/,
        'a click without a recorded open is still someone who read it');
    assert.match(fn, /eq\(audienceContacts\.status, 'subscribed'\)/);
});

await check('a resend targets the non-openers, not the segment', () => {
    const fn = SEND.slice(landmark(SEND, 'export async function materialiseRecipients'), landmark(SEND, 'async function materialiseFromAudience'));
    assert.match(fn, /issue\.resendOfIssueId\s*\n?\s*\? await unopenedRecipientPage/);
    // The segment join lives in the ordinary path only. "Who did not open" is already the
    // intersection of the segment and the people we actually reached, and re-applying a segment
    // that someone has edited since would silently drop recipients the original did reach.
    assert.ok(!fn.includes('audienceContactSegments'), 'the segment must not narrow it a second time');
    assert.match(SEND.slice(landmark(SEND, 'async function materialiseFromAudience')), /audienceContactSegments/);
});

// ── 5. It is a new issue, with the old words ────────────────────────────────

await check('the approved snapshot is copied, never re-rendered', () => {
    const fn = API.slice(landmark(API, "if (action === 'resend')"), landmark(API, "if (action === 'update')"));
    assert.match(fn, /renderedPayload: issue\.renderedPayload/);
    assert.ok(!fn.includes('renderIssueSnapshot'),
        're-rendering here would let an edit made since approval change what the non-openers get');
    assert.match(fn, /resendOfIssueId: issue\.id/);
});

await check('resending is owner/admin only and re-checks eligibility server-side', () => {
    const fn = API.slice(landmark(API, "if (action === 'resend')"), landmark(API, "if (action === 'update')"));
    assert.match(fn, /APPROVE_ROLES\.includes\(ctx\.role\)/);
    assert.ok(landmark(fn, 'resendEligibility') < landmark(fn, 'db.insert(newsletterIssues)'),
        'the verdict must be resolved before anything is created');
});

await check('the sent-issue lock lets a resend through, and says why', () => {
    const gate = API.slice(landmark(API, "const LOCKED = ['sending', 'sent']"), landmark(API, "if (action === 'resend')"));
    assert.match(gate, /action !== 'resend'/);
    assert.match(gate, /CHANGES NOTHING about the sent issue/i);
});

await check('an empty resend fails with its own reason, not "nobody is subscribed"', () => {
    // Telling a tenant their list is empty when it is fine sends them hunting for a problem that
    // is not there.
    assert.match(SEND, /nobody left to resend to/);
    assert.match(SEND, /claimed\.resendOfIssueId\s*\n?\s*\?/);
});

// ── 6. What the tenant sees ─────────────────────────────────────────────────

await check('the panel is drawn from the server verdict, not guessed in the browser', () => {
    assert.match(UI, /function renderResend/);
    assert.match(UI, /if \(!verdict\.canResend\)/);
    assert.match(UI, /esc\(verdict\.message \|\| ''\)/, 'every refusal is shown, not hidden');
});

await check('the confirm names the number of people and the one-resend rule', () => {
    const fn = UI.slice(landmark(UI, 'function renderResend'), landmark(UI, 'function renderStats'));
    assert.match(fn, /who did not open the original/);
    assert.match(fn, /can only be resent once/);
    assert.match(fn, /A different subject line is the whole point/);
});

// ── 7. The migration ────────────────────────────────────────────────────────

await check('the migration refuses to run before the engagement columns exist', () => {
    // Without opened_at there is no such thing as "did not open".
    assert.match(SQL, /column_name = 'opened_at'/);
    assert.match(SQL, /newsletter-engagement/);
    assert.match(SQL, /APPLY BEFORE DEPLOYING THE CODE/);
});

await check('the unopened lookup has its own partial index', () => {
    assert.match(SQL, /newsletter_sends_unopened_idx[\s\S]{0,200}WHERE status = 'sent' AND opened_at IS NULL AND clicked_at IS NULL/);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
