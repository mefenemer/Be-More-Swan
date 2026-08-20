// tests/newsletter-welcome-sequence.test.ts
// The welcome series: mail that goes out on a timer, to strangers, with nobody watching.
//
// That description is the whole risk. An issue is read by a human before it sends; a sequence step
// is written once and then sent for ever. Five failures follow from it:
//
//   1. SENDING WHAT NOBODY APPROVED. Steps must be off until a person switches them on, and the
//      worker must re-read that switch — turning it off has to stop mail already queued, or the
//      control is decorative for everyone mid-series.
//   2. MAILING SOMEBODY WHO LEFT ON DAY TWO. Consent is re-checked per step, through the shared
//      resolver, not read once at enrolment.
//   3. A DEAD UNSUBSCRIBE LINK. A sequence step has no newsletter_sends row, so its footer token
//      has nowhere obvious to live — and a link that answers "we couldn't find that subscription"
//      reads as a company refusing to let you leave.
//   4. RESTARTING THE SERIES. Someone who unsubscribes and re-subscribes must not get it twice.
//   5. AN ENROLMENT THAT BREAKS THE THING THAT TRIGGERED IT. It hangs off a confirmation click.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { mintUnsubscribeToken } from '../src/utils/newsletter-send';

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

const ENGINE = read('src/utils/newsletter-sequence.ts');
const API = read('netlify/functions/newsletter-sequences.ts');
const SQL = read('db/newsletter-sequences.sql');
const UNSUB = read('netlify/functions/newsletter-unsubscribe.ts');
const PUBLIC = read('netlify/functions/audience-public.ts');
const HOOK = read('netlify/functions/newsletter-webhook.ts');
const CRON = read('netlify/functions/process-newsletter-sequences.ts');

async function main() {

// ── 1. Nothing sends until a human says so ──────────────────────────────────

await check('a new sequence is OFF, and the schema is what enforces it', () => {
    assert.match(SQL, /is_enabled\s+BOOLEAN NOT NULL DEFAULT false/,
        'a sequence that defaulted to on would send unreviewed copy the moment its steps were written');
});

await check('the worker re-reads the switch on EVERY send, not just at enrolment', () => {
    // Otherwise switching it off is decorative for everyone already mid-series.
    const loop = ENGINE.slice(landmark(ENGINE, 'for (const row of due)'));
    assert.ok(loop.indexOf('isEnabled: newsletterSequences.isEnabled') > -1, 'the flag is re-read inside the loop');
    assert.match(loop, /if \(!seq\?\.isEnabled\) \{ await halt\(row\.id, 'sequence_disabled'\); continue; \}/);
});

await check('an empty sequence cannot be switched on', () => {
    // It would enrol every new subscriber into nothing and complete them immediately — a switch
    // that looks on and does nothing at all.
    const enable = API.slice(landmark(API, "if (action === 'enable')"));
    assert.match(enable, /Write at least one email before switching this on/);
});

await check('switching on is owner/admin only, and says what it commits to', () => {
    assert.match(API, /const ENABLE_ROLES = \['owner', 'admin'\]/);
    const enable = API.slice(landmark(API, "if (action === 'enable')"));
    assert.match(enable, /ENABLE_ROLES\.includes\(ctx\.role\)/, 'the gate has to be IN the branch');
    const ui = read('newsletter.js');
    assert.match(ui, /without anyone reading them again first/,
        'the confirm dialog must say what enabling actually means');
});

// ── 2. Consent, per step ────────────────────────────────────────────────────

await check('every step asks the shared consent resolver', () => {
    const loop = ENGINE.slice(landmark(ENGINE, 'for (const row of due)'));
    assert.match(loop, /checkAudienceConsentBulk/,
        'reading the audience status alone would miss an opt-out recorded by the Lead Generator');
    assert.ok(loop.indexOf('checkAudienceConsentBulk') < loop.indexOf('await deliverStep('),
        'consent must be resolved before the step is delivered');
});

await check('a refused verdict halts with the reason it was refused for', () => {
    const loop = ENGINE.slice(landmark(ENGINE, 'for (const row of due)'));
    const branch = loop.slice(landmark(loop, 'if (!verdict?.sendable)'), landmark(loop, 'const [org]'));
    for (const reason of ['unsubscribed', 'bounced', 'complained', 'suppressed', 'consent_check_failed']) {
        assert.ok(branch.includes(`'${reason}'`), `${reason} must map to a halt reason, not a generic one`);
    }
});

await check('unsubscribing, bouncing and complaining all halt the series', () => {
    // The consent check would catch them at the next step anyway; halting now makes the reason
    // readable from the row rather than inferable from an absence.
    assert.match(UNSUB, /haltEnrolmentsForContact/);
    const bounce = HOOK.slice(landmark(HOOK, "if (type === 'email.bounced')"), landmark(HOOK, "if (type === 'email.complained')"));
    assert.match(bounce, /haltEnrolmentsForContact/);
    const complaint = HOOK.slice(landmark(HOOK, "if (type === 'email.complained')"));
    assert.match(complaint, /haltEnrolmentsForContact/);
});

// ── 3. The way out actually works ───────────────────────────────────────────

await check('the enrolment carries its own unsubscribe token', () => {
    // A sequence step has no newsletter_sends row to hang one on. Without this the footer link
    // would resolve to nothing on every welcome email in the product.
    assert.match(SQL, /unsubscribe_token TEXT/);
    assert.match(ENGINE, /unsubscribeToken: mintUnsubscribeToken\(\)/);
});

await check('a minted token survives the unsubscribe endpoint\'s format check', () => {
    // ⚠️ The endpoint format-checks BEFORE it looks anything up, so a token minted to a different
    // shape here would be rejected as malformed and never reach the enrolment row at all — the
    // same dead link, arrived at from the other end. One minter is what keeps the two in step.
    const re = new RegExp(String(UNSUB.match(/const TOKEN_RE = \/(.+?)\/;/)?.[1]));
    for (let i = 0; i < 200; i++) {
        const token = mintUnsubscribeToken();
        assert.ok(re.test(token), `the endpoint would reject a token it minted: ${token}`);
    }
});

await check('the token is stable across the whole series, not minted per send', () => {
    // Somebody who keeps the first email and clicks its link three weeks later must still be able
    // to leave.
    const loop = ENGINE.slice(landmark(ENGINE, 'for (const row of due)'));
    assert.match(loop, /let token = row\.unsubscribeToken;/);
    assert.match(loop, /if \(!token\)/, 'and an enrolment predating the column is backfilled, not sent a dead link');
});

await check('the unsubscribe endpoint resolves a sequence token', () => {
    assert.match(UNSUB, /newsletterSequenceEnrolments\.unsubscribeToken, token/);
    // Issue sends first — the common case by volume — then sequences.
    assert.ok(landmark(UNSUB, 'newsletterSends.unsubscribeToken, token') < landmark(UNSUB, 'newsletterSequenceEnrolments.unsubscribeToken, token'));
    // A sequence step belongs to no issue, so there is no per-issue counter to move for one.
    assert.match(UNSUB, /if \(row\.issueId\) \{/);
});

// ── 4. One series per person, ever ──────────────────────────────────────────

await check('a contact cannot be enrolled twice', () => {
    assert.match(SQL, /newsletter_sequence_enrolments_contact_uidx[\s\S]{0,120}\(sequence_id, contact_id\)/,
        'someone who unsubscribes and re-subscribes must not restart the series');
    assert.match(ENGINE, /onConflictDoNothing\(\)/);
});

await check('an org cannot end up with two welcome sequences', () => {
    // Not a visible duplicate — every resolver reads the org's sequence with LIMIT 1 and no
    // ordering, so a second row is a coin toss over which one the tenant's steps attach to and
    // which one enrols new subscribers. A double-clicked button was enough to create it.
    // ⚠️ Bounded by the NEXT action, not by a `db.select()` line — that phrasing appears in the
    // GET branch further up, so the slice would have run backwards and matched nothing.
    const create = API.slice(landmark(API, "if (action === 'create')"), landmark(API, "if (action === 'saveStep')"));
    assert.match(create, /if \(existing\) return json\(200, \{ sequence: existing \}\)/,
        'creating twice must return the sequence that exists, not insert a second');
    assert.match(SQL, /newsletter_sequences_org_trigger_uidx[\s\S]{0,120}\(organisation_id, trigger_event\)/,
        'and the index is what makes it true under a retry or a race');
});

await check('a manual "mark as subscribed" does NOT enrol', () => {
    // A person an admin ticked has not just raised their hand, and "welcome, thanks for
    // subscribing" arriving because somebody tidied a spreadsheet is a message nobody asked for.
    const contacts = read('netlify/functions/audience-contacts.ts');
    const status = contacts.slice(landmark(contacts, "if (action === 'status')"), landmark(contacts, "if (action === 'segment')"));
    assert.ok(!status.includes('enrolInWelcomeSequence'));
    assert.match(status, /haltEnrolmentsForContact/, 'but unsubscribing there must still halt');
});

await check('enrolment happens on CONFIRMATION — the moment they raised their hand', () => {
    const confirm = PUBLIC.slice(landmark(PUBLIC, "if (path.includes('/api/audience/confirm')"));
    assert.match(confirm, /enrolInWelcomeSequence/);
});

// ── 5. It never breaks what triggered it ────────────────────────────────────

await check('enrolment swallows every failure', () => {
    // It hangs off a confirmation click. A 500 here would leave somebody who just confirmed
    // believing they had failed to subscribe.
    const fn = ENGINE.slice(landmark(ENGINE, 'export async function enrolInWelcomeSequence'), landmark(ENGINE, 'export async function haltEnrolmentsForContact'));
    assert.match(fn, /catch \(err\)/);
    assert.ok(!/throw/.test(fn), 'it must never throw into the confirmation handler');
    assert.match(fn, /return \{ enrolled: false, reason: 'error' \}/);
});

await check('a disabled sequence enrols nobody', () => {
    // An enrolment carries a next_send_at. Creating one against a sequence nobody has switched on
    // would fire the moment they did — a "welcome" to somebody who subscribed weeks earlier.
    const fn = ENGINE.slice(landmark(ENGINE, 'export async function enrolInWelcomeSequence'), landmark(ENGINE, 'export async function haltEnrolmentsForContact'));
    assert.match(fn, /if \(!seq\.isEnabled\) return \{ enrolled: false, reason: 'sequence_disabled' \}/);
});

// ── 6. The worker's mechanics ───────────────────────────────────────────────

await check('the claim is status-guarded and re-asserts the timestamp it read', () => {
    // Without both, two overlapping ticks send the same person the same step.
    const claim = ENGINE.slice(landmark(ENGINE, 'const [claimed] = await db.update'), landmark(ENGINE, 'if (!claimed) continue;'));
    assert.match(claim, /eq\(newsletterSequenceEnrolments\.state, 'active'\)/);
    assert.match(claim, /eq\(newsletterSequenceEnrolments\.nextSendAt, row\.nextSendAt\)/);
});

await check('a step is never re-rendered at send time', () => {
    // An edit made while somebody is mid-series must change what they get from the NEXT step on,
    // never rewrite one already sent.
    assert.match(API, /renderIssueSnapshot/, 'the snapshot is built at SAVE');
    const loop = ENGINE.slice(landmark(ENGINE, 'for (const row of due)'));
    assert.match(loop, /step\.renderedPayload as IssueSnapshot \| null/);
    assert.ok(!loop.includes('renderIssueSnapshot'), 'the worker must not render');
});

await check('a failing step gives up rather than retrying for ever', () => {
    assert.match(ENGINE, /MAX_ATTEMPTS/);
    const fail = ENGINE.slice(landmark(ENGINE, "haltReason: 'send_failed'"));
    assert.ok(fail.length > 0);
});

await check('deleting a step does not renumber the others', () => {
    // last_step_sent is a NUMBER. Shuffling the numbering under somebody mid-series would re-send
    // a step or skip one.
    const del = API.slice(landmark(API, "if (action === 'deleteStep')"), landmark(API, "if (action === 'enable')"));
    assert.match(del, /NOT renumbering/i);
    // And the worker asks for the next step GREATER than the last sent, so gaps are harmless.
    assert.match(ENGINE, /stepNumber\} > \$\{row\.lastStepSent\}/);
});

await check('an un-migrated environment degrades instead of erroring the cron', () => {
    assert.match(CRON, /42P01/);
    assert.match(CRON, /needsSetup: true/);
    assert.match(CRON, /console\.log\('\[process-newsletter-sequences\]'/, 'one line per tick, or a dead schedule is invisible');
    const toml = read('netlify.toml');
    const block = toml.slice(landmark(toml, '[functions.process-newsletter-sequences]'));
    assert.match(block.slice(0, 120), /schedule = "\*\/15 \* \* \* \*"/);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
