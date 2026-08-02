// tests/opt-out-handling.test.ts
// "Stop emailing me" in a reply must actually stop the emails.
//
// Before this, a reply saying "unsubscribe" halted that one cadence only because it was a reply at
// all — nothing was recorded, so re-scoring or re-adding the same person resumed outreach.
// suppression_list is written solely by the CRM sync and is DOMAIN-grained, which is the wrong
// grain: one person opting out must not suppress their whole employer.
//
// Detection is a regex over the reply's NEW text, and the risk sits almost entirely in two places:
// missing a real opt-out (recoverable — they replied, so the cadence halted anyway) and firing on
// quoted history (not recoverable — the prospect is silently never emailed again). The quoted-text
// cases below are the ones that matter.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectOptOut, newTextOnly } from '../src/config/opt-out';
import { EVENT_TYPES } from '../src/config/revenue-events';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nReply opt-out handling\n');

// ── Detection: true positives ──────────────────────────────────────────────────────────────────

check('plain opt-out instructions are caught', () => {
    for (const s of [
        'Unsubscribe',
        'Please remove me from your list.',
        'Take me off this mailing list.',
        'Stop emailing me.',
        'Please stop contacting me about this.',
        'Do not email me again.',
        "Don't contact me.",
        'I no longer wish to receive these.',
        'Opt me out please.',
        'Remove me from your database.',
        'Not interested, please remove.',
    ]) {
        assert.strictEqual(detectOptOut(s).optedOut, true, `should detect: ${s}`);
    }
});

check('an opt-out in the subject is caught', () => {
    // Some clients put a one-word reply entirely in the subject.
    assert.strictEqual(detectOptOut('', 'unsubscribe').optedOut, true);
    assert.strictEqual(detectOptOut('(no message body)', 'Re: unsubscribe').optedOut, true);
});

check('the matched rule and evidence are recorded', () => {
    // A suppression that cannot be explained looks to the tenant like a hole in their pipeline.
    const v = detectOptOut('Thanks but no. Please remove me from your list. Regards, Sam');
    assert.strictEqual(v.optedOut, true);
    assert.ok(v.matched, 'a rule label must be recorded');
    assert.match(v.evidence ?? '', /remove me/i, 'the matching sentence must be captured');
});

// ── Detection: the dangerous false positives ───────────────────────────────────────────────────

check('"unsubscribe" in QUOTED history does not opt anyone out', () => {
    // The single most likely false positive: a reply carrying a prior newsletter or footer.
    const body = [
        'Sure, happy to chat next week.',
        '',
        'On Mon, 3 Aug 2026 at 09:14, Acme <hi@acme.com> wrote:',
        '> Thanks for subscribing to our newsletter.',
        '> To unsubscribe, click here.',
    ].join('\n');
    assert.strictEqual(detectOptOut(body).optedOut, false, 'quoted text must be ignored');
});

check('Outlook-style quoted headers are stripped', () => {
    const body = [
        'Interested - can you send pricing?',
        '',
        '-----Original Message-----',
        'From: Sales <sales@x.com>',
        'Sent: 01 August 2026 10:00',
        'If you would like to unsubscribe, reply STOP.',
    ].join('\n');
    assert.strictEqual(detectOptOut(body).optedOut, false);
});

check('a signature footer below "-- " does not opt anyone out', () => {
    const body = [
        'Sounds good, let us set something up.',
        '',
        '-- ',
        'Jane Bloggs | Acme Ltd',
        'To unsubscribe from Acme communications, click here.',
    ].join('\n');
    assert.strictEqual(detectOptOut(body).optedOut, false);
});

check('ordinary positive replies are never opt-outs', () => {
    for (const s of [
        'Thanks for reaching out - could you send over pricing?',
        'Interested. What does onboarding look like?',
        'Can you remove the second attachment and resend?',   // "remove" without the opt-out framing
        'We are not interested right now, try us next quarter.',
        'Please contact me on 07700 900000.',
        'Stop by the office any time.',
        '',
    ]) {
        assert.strictEqual(detectOptOut(s).optedOut, false, `should NOT detect: ${s}`);
    }
});

check('a real opt-out ABOVE quoted history is still caught', () => {
    // The stripping must not be so aggressive that it eats the actual reply.
    const body = [
        'Please remove me from your list.',
        '',
        'On Mon, 3 Aug 2026 at 09:14, Sales <s@x.com> wrote:',
        '> Just following up on my note below.',
    ].join('\n');
    assert.strictEqual(detectOptOut(body).optedOut, true);
});

check('newTextOnly keeps the reply and drops the quote', () => {
    const t = newTextOnly('Yes please.\n\nOn Mon someone wrote:\n> old text here');
    assert.strictEqual(t, 'Yes please.');
});

// ── Grain: the reason this is not suppression_list ─────────────────────────────────────────────

check('opt-outs are stored at ADDRESS grain, in their own table', () => {
    const sql = read('db/lead-opt-outs.sql');
    assert.match(sql, /email\s+text NOT NULL/, 'must store the address, not just a domain');
    assert.match(sql, /UNIQUE \(organisation_id, email\)/, 'one opt-out per address per tenant');
    assert.doesNotMatch(sql, /\bdomain\b\s+text NOT NULL/, 'must NOT be domain-grained');
});

check('the schema mirror exists so drizzle-kit push cannot revert it', () => {
    const s = read('db/schema.ts');
    assert.match(s, /export const leadOptOuts = pgTable\("lead_opt_outs"/);
    assert.match(s, /lead_opt_outs_org_email_unique/);
});

check('deleting a thread does not delete the opt-out evidence', () => {
    assert.match(read('db/lead-opt-outs.sql'), /lead_thread_id\s+integer REFERENCES lead_threads\(id\) ON DELETE SET NULL/);
});

// ── Enforcement ────────────────────────────────────────────────────────────────────────────────

check('checkSuppression consults opt-outs BEFORE the domain list', () => {
    // Both send paths already call checkSuppression, so wiring it here is what makes the opt-out
    // enforced everywhere without touching either caller.
    const src = read('src/utils/suppression.ts');
    const optIdx = src.indexOf('leadOptOuts');
    const domIdx = src.indexOf('suppressionList.domain');
    assert.ok(optIdx > 0, 'suppression.ts must query lead_opt_outs');
    assert.ok(optIdx < domIdx, 'the address check must run before the domain check');
});

check('the opt-out lookup fails CLOSED, except on a missing table', () => {
    const src = read('src/utils/suppression.ts');
    assert.match(src, /if \(code !== '42P01'\)/, 'only a missing table may fall through');
    assert.match(src, /suppressed: true, reason: null, unknown: true/, 'any other error must fail closed');
});

check('the inbound webhook records the opt-out and closes the thread', () => {
    const src = read('netlify/functions/inbound-email.ts');
    assert.match(src, /detectOptOut\(messageBody, subject\)/, 'the reply branch must run detection');
    assert.match(src, /insert\(leadOptOuts\)/, 'it must write the opt-out');
    assert.match(src, /onConflictDoNothing\(\)/, 'a repeated opt-out must not error');
    assert.match(src, /state: 'closed'/, "the thread must close, not just sit at 'replied'");
});

check('a failed opt-out write never 500s the webhook', () => {
    // A 500 makes SendGrid retry and eventually bounce a real prospect's reply.
    const src = read('netlify/functions/inbound-email.ts');
    const i = src.indexOf('detectOptOut(messageBody, subject)');
    assert.match(src.slice(i, i + 2400), /catch \(err\)/, 'the opt-out write must be wrapped');
    assert.match(src.slice(i, i + 2400), /OPT-OUT NOT RECORDED/, 'a swallowed failure must be logged loudly');
});

check('opt_out_received is its own ledger event', () => {
    assert.ok((EVENT_TYPES as readonly string[]).includes('opt_out_received'));
    assert.match(read('netlify/functions/inbound-email.ts'), /recordEvent\(db, 'opt_out_received'/);
});

console.log(`\n${passed} checks passed\n`);
