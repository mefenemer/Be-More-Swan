// tests/audience-send-history.test.ts
// "What have we actually sent this person?" — the contact drawer's Newsletters section.
//
// The data has existed in newsletter_sends since the first send: one row per (issue, recipient),
// with the skip reason, the first open and the first click on it. Nothing read it back. A tenant
// asking what somebody had received got `last_sent_at` — one date, no subjects, and no answer at
// all for the person who was deliberately NOT sent to.
//
// Four ways a per-person history is worse than no history:
//
//   1. ⚠️ IT REPORTS "NOT OPENED" WHERE IT MEANS "WE COULD NOT SEE". An issue sent through a
//      connected mailbox embeds no pixel and rewrites no links, so every recipient of it looks
//      ignored. That is a statement about our instrumentation printed as a statement about the
//      reader — and it is the number a tenant would use to delete a subscriber.
//   2. IT LOSES THE HISTORY OF ANYONE RE-ADDED. contact_id is ON DELETE SET NULL, so a removed and
//      re-imported subscriber matches on nothing but their address.
//   3. IT SHOWS A SKIP WITH NO REASON. "Not sent" on its own sends the tenant to support; "Has not
//      confirmed their subscription" sends them to the confirmation reminder.
//   4. IT SHOWS THE WRONG SUBJECT LINE. Under an A/B test half the list received subject_b, and
//      naming the issue's own subject tells the tenant this person got an email they never saw.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { SKIP_REASON_LABEL } from '../src/utils/audience-consent';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    }
}

const FN = read('netlify/functions/audience-contacts.ts');
const UI = read('audience.js');
const QUERY = FN.slice(landmark(FN, 'async function sendHistory('), landmark(FN, 'export default withLambda'));
const RENDER = UI.slice(landmark(UI, 'function renderSendHistory('), landmark(UI, 'async function setStatus('));

check('the history is org-scoped inside its own WHERE, not by the caller', () => {
    // The only cross-tenant read that could hide here. newsletter_sends carries its own
    // organisation_id precisely so this does not depend on the join.
    assert.match(QUERY, /eq\(newsletterSends\.organisationId, orgId\)/);
});

check('it matches on the contact id OR the address', () => {
    // ON DELETE SET NULL: a removed-and-re-added subscriber has history under the email alone.
    assert.match(QUERY, /or\(eq\(newsletterSends\.contactId, contactId\), eq\(newsletterSends\.email, email\)\)/);
});

check('a missing newsletter table OR column degrades, rather than breaking the drawer', () => {
    // ⚠️ 42703 as well as 42P01. This is the first REQUEST path to name newsletter_sends.variant
    // and .due_at — until now only the send worker touched them, and a cron fails invisibly. A DB
    // without db/newsletter-ab-subjects.sql answers with 42703, and an unguarded one takes the
    // consent history and the custom fields down with it.
    assert.match(QUERY, /42P01/);
    assert.match(QUERY, /42703/);
    assert.match(QUERY, /rows: \[\], unavailable: true/);
    // ⚠️ Its own try/catch. Sharing the handler's would take the consent timeline down with it.
    assert.ok(landmark(QUERY, 'try {') < landmark(QUERY, 'newsletterSends.id'),
        'the query must sit inside the guard');
});

check('an unavailable history is never reported as "nothing sent"', () => {
    // The confident falsehood. "No newsletters sent to them yet" about a database that has never
    // been asked is worse than an error — it is an answer to the question the section exists for.
    assert.match(FN, /newslettersUnavailable: history\.unavailable/);
    assert.ok(landmark(RENDER, 'if (unavailable)') < landmark(RENDER, 'No newsletters sent to them yet'),
        'the unavailable branch must come first');
});

check('the row count is bounded', () => {
    assert.match(QUERY, /limit\(SEND_HISTORY_LIMIT\)/);
    assert.match(FN, /const SEND_HISTORY_LIMIT = \d+/);
});

check('the subject shown is the one THEY were sent', () => {
    assert.match(QUERY, /r\.variant === 'B' && subjectB \? subjectB : r\.subject/);
});

check('the skip reason is turned into words on the server', () => {
    assert.match(QUERY, /SKIP_REASON_LABEL\[r\.skipReason as AudienceSkipReason\]/);
    // ⚠️ And the renderer must not grow a second copy of that vocabulary — it is not in the
    // generated client mirror, so a hand copy would drift the day a reason is added.
    //
    // Scoped to the renderer rather than the whole file on purpose: audience.js legitimately says
    // "Unsubscribed" and "Bounced" about a CONTACT's status (the STATUS map), which are different
    // facts that happen to share a word. A file-wide scan flags those and teaches the next person
    // to delete the check.
    for (const label of Object.values(SKIP_REASON_LABEL)) {
        assert.ok(!RENDER.includes(label), `renderSendHistory has its own copy of a skip reason: "${label}"`);
    }
});

check('engagement is reported only when the issue could measure it', () => {
    // THE ORDERING ONE. "Not opened" must sit behind the engagementTracked check, or every
    // mailbox-sent issue reports its whole audience as having ignored it.
    assert.match(QUERY, /engagementTracked: newsletterIssues\.engagementTracked/);
    assert.ok(landmark(RENDER, '!r.engagementTracked') < landmark(RENDER, "'Not opened'"),
        'the untracked branch must come first');
    assert.match(RENDER, /were not measurable on this send/);
});

check('a skipped row always says why, and a failed one says what happened', () => {
    assert.match(RENDER, /r\.status === 'skipped'/);
    assert.match(RENDER, /r\.skipLabel/);
    assert.match(RENDER, /r\.status === 'failed'/);
    assert.match(RENDER, /r\.error/);
});

check('every status the ledger can hold has copy', () => {
    // Mirrors newsletter_sends.status: the worker writes queued/sent/skipped/failed, the webhook
    // writes delivered/bounced/complained. A status with no entry renders its raw key.
    const vocab = UI.slice(landmark(UI, 'const SEND_STATUS = {'), landmark(UI, 'const EVENT_LABEL = {'));
    for (const status of ['queued', 'sent', 'skipped', 'failed', 'delivered', 'bounced', 'complained']) {
        assert.ok(vocab.includes(`${status}:`), `SEND_STATUS has no entry for '${status}'`);
    }
});

check('the drawer asks for the history and renders it', () => {
    assert.match(UI, /const \{ contact, segments, timeline, newsletters, newslettersUnavailable \} = await api\(/);
    assert.match(UI, /\$\{renderSendHistory\(newsletters, newslettersUnavailable\)\}/);
});

console.log(`\n${passed} checks passed.`);
