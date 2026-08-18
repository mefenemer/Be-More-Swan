// tests/lead-reply-loop.test.ts
// The half of the Lead Generator that happens AFTER the email goes out.
//
// Everything up to the send was built and guarded; the return leg was not. A prospect's reply was
// recorded perfectly, halted the cadence, wrote its ledger row — and told nobody, on any channel.
// There was also no way to answer it: the mail helpers are send-only, the Conversations API was
// read-only, so the warmest lead in the pipeline had to be replied to from the tenant's own inbox,
// outside the thread, where nothing recorded it and the next chaser could not see it.
//
// Related: approving ONE email quietly authorised up to four, because every confirmed send enrolled
// the lead in a three-step cadence with no question asked and no switch to turn it off.
//
// Every regression here is silent — an email still sends, a reply is still stored, and the failure
// only shows up as a prospect who was ignored for a week or a tenant who sent four emails they did
// not know about. So this mixes behavioural tests with source assertions on the paths that cannot be
// exercised without a database and a mail provider.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREF_CATEGORIES, pushRule } from '../src/utils/notification-prefs';
import { getNotificationDefault } from '../src/utils/notification-templates-catalog';
import { categoryOf } from '../src/utils/notification-actions';
import { isEventType } from '../src/utils/../config/revenue-events';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const INBOUND = read('netlify/functions/inbound-email.ts');
const THREADS_API = read('netlify/functions/lead-threads.ts');
const THREADS_UI = read('src/components/assistant-lead-threads.js');
const THREADS_OWNER = read('src/utils/lead-threads.ts');
const SEQUENCES = read('src/utils/outreach-sequences.ts');
const LEAD_GEN = read('netlify/functions/lead-generation.ts');
const SHELL = read('assistants.js');
const NOTIFICATIONS_UI = read('notifications.js');
const SCHEMAS = read('src/public/assistant-onboarding-schemas.js');
const RETENTION_SWEEP = read('netlify/functions/lead-retention-sweep.ts');

console.log('\n──── 1. a reply reaches the human ────');

check('the scan found the reply branch (a broken scan must fail, not silently pass)', () => {
    // Every source assertion below slices from these landmarks. If one is renamed the slices go
    // empty and the file would report all-clear over code it never read.
    assert.ok(INBOUND.includes('Lead-reply branch'), 'inbound-email.ts lead-reply branch marker moved');
    assert.ok(INBOUND.includes('recordInboundMessage'), 'the inbound recorder call moved');
    assert.ok(THREADS_API.includes("action === 'reply'"), 'the reply action moved');
});

check('a recorded reply notifies the tenant', () => {
    const branch = INBOUND.slice(landmark(INBOUND, 'Lead-reply branch'), landmark(INBOUND, 'Lead reply recorded.'));
    assert.match(branch, /createNotification\(db, 'lead_reply_received'/,
        'the reply branch must raise a notification — recording it and telling nobody is where this '
        + 'loop used to end');
});

check('the notification is attributed to the assistant, or its toggle has no home', () => {
    // `approvals` is scope:'assistant', so the row renders its toggle in the Assistant Profile drawer
    // and keys the override on notifications.assistant_id — stamped by the trigger from metadata.
    // Without the id the row falls back to the workspace-wide value, which has NO UI, and the alert
    // becomes permanently on.
    const call = INBOUND.slice(landmark(INBOUND, "createNotification(db, 'lead_reply_received'"));
    assert.match(call.slice(0, 900), /metadata:\s*\{[^}]*assistantId/,
        'metadata.assistantId is what the per-assistant preference override reads');
});

check('an opt-out reply does NOT invite the user to go and answer it', () => {
    const branch = INBOUND.slice(landmark(INBOUND, 'Lead-reply branch'), landmark(INBOUND, 'Lead reply recorded.'));
    const notifyAt = branch.indexOf("createNotification(db, 'lead_reply_received'");
    const guardAt = branch.lastIndexOf('optOut.optedOut', notifyAt);
    assert.ok(guardAt > 0 && guardAt < notifyAt,
        'the notification must sit inside an "unless they opted out" guard — pushing a lock-screen '
        + 'alert to answer someone who just asked to be left alone is worse than no alert');
});

check('the type is wired end to end: template, routing category, and a preference row', () => {
    const tpl = getNotificationDefault('lead_reply_received');
    assert.ok(tpl, 'a type with no catalog entry renders no copy at all');
    assert.equal(tpl!.type, 'lead_reply_received', 'the catalog owns the stamped type');
    // Through the exported reader, which is what the app calls — TYPE_CATEGORY itself is private,
    // and an unmapped type resolves to 'informational' here rather than throwing.
    assert.equal(categoryOf('lead_reply_received'), 'suggested_action',
        'a reply is parked work that decays — not a state change, and not critical');

    const cat = PREF_CATEGORIES.find((c) => c.types.includes('lead_reply_received'));
    assert.ok(cat, 'an unmapped type falls through to the product_updates fallback, so anyone who '
        + 'muted product news would silently stop hearing that prospects had replied');
    assert.equal(cat!.scope, 'assistant', 'this is work an assistant produced');
    assert.equal(pushRule(cat!).default, true,
        'of everything this assistant produces, a live prospect reply is the one worth a phone buzz');
});

check('the notification does not carry the prospect’s address', () => {
    // A notification is the least contained surface in the product: it renders in the bell, is
    // emailed by the fallback worker, and is pushed to a lock screen. The company name is enough to
    // recognise the thread; the address is third-party personal data.
    const tpl = getNotificationDefault('lead_reply_received')!;
    const copy = `${tpl.title} ${tpl.message}`;
    assert.ok(!/\{\{[^}]*email[^}]*\}\}/i.test(copy), 'no email merge variable in the copy');
    const call = INBOUND.slice(landmark(INBOUND, "createNotification(db, 'lead_reply_received'"));
    assert.ok(!/senderEmail\s*[,}]/.test(call.slice(0, 700)),
        'the sender address must not be passed into the notification context');
});

check('the notification links to the conversation, not to the dashboard', () => {
    const handler = NOTIFICATIONS_UI.slice(landmark(NOTIFICATIONS_UI, "notif.type === 'lead_reply_received'"));
    assert.match(handler.slice(0, 600), /_assistantDetailInitialTab = 'conversations'/,
        'the reply lives on one screen and no global page can show it');
    assert.match(handler.slice(0, 600), /threadId/, 'and it should open the right thread');
});

console.log('\n──── 2. the human can answer ────');

check('the Conversations API can send a reply from the tenant’s mailbox', () => {
    const reply = THREADS_API.slice(landmark(THREADS_API, "action === 'reply'"));
    assert.match(reply, /sendGmailMessage|sendOutlookMessage/, 'it has to actually send');
    assert.match(reply, /recordOutboundMessage/,
        'and record what went out, or the transcript stops at the prospect’s message and the next '
        + 'chaser is written blind');
});

check('the reply applies the gates that are about the RECIPIENT', () => {
    const reply = THREADS_API.slice(landmark(THREADS_API, "action === 'reply'"));
    assert.match(reply, /checkSuppression/,
        'someone who asked to be left alone must not receive a reply either');
    assert.match(reply, /isUsablePostalAddress/,
        'a reply is still a commercial email and still needs the postal address');
    // Ordering: both gates precede the send, or they are decoration.
    assert.ok(landmark(reply, 'checkSuppression') < landmark(reply, 'sendGmailMessage'),
        'the suppression check must run BEFORE the send');
    assert.ok(landmark(reply, 'isUsablePostalAddress') < landmark(reply, 'sendGmailMessage'),
        'the postal-address gate must run BEFORE the send');
});

/** Strip comments: naming the credential in a comment is documentation, holding it is the bug. */
function codeOnly(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

check('the reply token never enters the function or the UI', () => {
    // The token is a bearer credential: whoever holds it can post into the conversation through the
    // public Parse webhook. The reply needs the Reply-To alias and the unsubscribe link DERIVED from
    // it, so the envelope is built inside the module that owns the table.
    assert.ok(!/replyToken|reply_token/.test(codeOnly(THREADS_API)),
        'lead-threads.ts (function) must not hold the token — ask the owner for a finished envelope');
    assert.ok(!/replyToken|reply_token/.test(codeOnly(THREADS_UI)), 'and the UI must never see one');
    assert.match(THREADS_OWNER, /export async function buildThreadReplyEnvelope/,
        'the envelope builder lives with the table it reads');
});

check('the stored transcript keeps the un-footered text the human wrote', () => {
    const reply = THREADS_API.slice(landmark(THREADS_API, "action === 'reply'"));
    const record = reply.slice(landmark(reply, 'recordOutboundMessage'));
    assert.match(record.slice(0, 400), /body:\s*replyBody/,
        'the transcript is what was written, not the boilerplate wrapped around it — the footered '
        + 'copy only ever goes on the wire');
    assert.match(record.slice(0, 400), /generatedBody:\s*null/,
        'there was no agent draft, so the "edited before sending" flag must stay off');
});

check('a human reply is NOT counted as outreach', () => {
    // Reply rate is replies ÷ leads WE emailed. Counting a tenant's own answers in the denominator
    // would let them improve their reply rate by replying, and would file a human's words in the
    // Activity feed as something the assistant did.
    const reply = THREADS_API.slice(landmark(THREADS_API, "action === 'reply'"));
    assert.match(reply, /recordEvent\(db, 'manual_reply_sent'/, 'its own event type');
    assert.ok(!/recordEvent\(db, 'outreach_sent'/.test(reply),
        'never outreach_sent — that is the reply-rate denominator');
    assert.ok(isEventType('manual_reply_sent'), 'and the type must be in the closed vocabulary');
});

check('the UI keeps a failed reply’s text and says why', () => {
    const send = THREADS_UI.slice(landmark(THREADS_UI, 'async function sendReply'));
    assert.match(send.slice(0, 1600), /data\.sent/, 'it must read the server’s outcome, not assume one');
    const notSent = send.slice(landmark(send, '} else {'));
    assert.match(notSent.slice(0, 400), /replyError/,
        'a non-send must surface its reason');
    assert.ok(!/delete state\.replyDraft/.test(notSent.slice(0, 400)),
        'and must NOT clear the draft — the user’s words are the expensive part');
});

/**
 * The whole `record_direct_reply` branch.
 *
 * ⚠️ Bounded by the next action, not by a character count. A 4000-char window over this branch
 * already lost the payload assertion once — the branch is long, and a window that stops short reports
 * a missing behaviour that is present three lines further down.
 */
function directReplyBranch(): string {
    return THREADS_API.slice(
        landmark(THREADS_API, "action === 'record_direct_reply'"),
        landmark(THREADS_API, 'return json(400, { error: `Unknown action'),
    );
}

console.log('\n──── 2b. a reply that never reached us ────');

check('the tenant can record a reply that bypassed Reply-To', () => {
    // Reply-To is a request, not a guarantee: Reply-All, a forwarded thread, or a client that
    // favours the From header all land the answer in the TENANT's inbox, where we never see it.
    // Nothing reads their mailbox — that needs a mail-scope consent this product does not ask for.
    assert.ok(THREADS_API.includes("action === 'record_direct_reply'"),
        'there must be a way to tell the product what it could not observe');
});

check('recording it STOPS the cadence — that is the whole point', () => {
    const act = directReplyBranch();
    assert.match(act, /haltEnrolment/,
        'the damage is not the missing transcript line, it is that the cadence keeps chasing someone '
        + 'who already answered');
    // The halt must come before the bookkeeping: a failure further down must not leave the cadence
    // running, because that is the part that emails a real person.
    assert.ok(landmark(act, 'haltEnrolment') < landmark(act, 'recordInboundMessage'),
        'stop the sending first, record second');
});

check('it flips the thread state through the owner, not by hand', () => {
    const act = directReplyBranch();
    assert.match(act, /recordInboundMessage/,
        'the state flip to replied is what every other surface reads — the Conversations filter, the '
        + 'worker pre-send check, the reply-rate aggregate — and it belongs to the table owner');
});

check('a hand-recorded reply is counted, but marked as hand-recorded', () => {
    const act = directReplyBranch();
    assert.match(act, /recordEvent\(db, 'reply_received'/,
        'it IS a reply — excluding it would understate reply rate and make the copy look worse than it is');
    assert.match(act, /actor: 'user'/,
        "actor 'user' is what separates it from one the system actually received (inbound-email uses 'system')");
    assert.match(act, /source: 'direct_to_sender'/,
        'and the payload should say how we learned of it');
});

check('nothing is emailed by recording it', () => {
    const act = directReplyBranch();
    for (const send of ['sendGmailMessage', 'sendOutlookMessage']) {
        assert.ok(!act.includes(send), `${send} must not appear — this records what already happened`);
    }
});

check('the empty-note path is not blocked, and cancel is distinguishable', () => {
    // The urgent half is stopping the cadence. Requiring pasted text before we stop chasing would put
    // a copy-and-paste chore in front of the safety fix.
    const fn = THREADS_UI.slice(landmark(THREADS_UI, 'async function recordDirectReply'));
    assert.match(fn.slice(0, 2200), /required:\s*false/,
        'the note must be optional');
    assert.match(fn.slice(0, 2200), /note === null \|\| note === undefined/,
        'null is CANCEL and empty string is "record it with no text" — collapsing the two either '
        + 'loses the cancel or blocks the path that matters');
});

check('the UI says where the blind spot is, next to the button', () => {
    const banner = THREADS_UI.slice(landmark(THREADS_UI, 'function cadenceBanner'), landmark(THREADS_UI, 'function actionBar'));
    assert.match(banner, /data-lt-direct/, 'the control belongs where the pending chasers are described');
    assert.match(banner, /tracked address/i,
        'and the copy has to explain that chasers stop on their own ONLY for replies we can see — '
        + 'otherwise the button looks redundant and nobody presses it');
});

console.log('\n──── 3. approving one email cannot authorise four silently ────');

check('the cadence is gated on a setup answer', () => {
    assert.match(SCHEMAS, /key: 'outreachFollowUps'/,
        'the assistant that emails strangers must ask, as the AR Clerk already does for its own '
        + 'customers');
    const enrol = SEQUENCES.slice(landmark(SEQUENCES, 'export async function enrolInSequence'));
    assert.match(enrol.slice(0, 1200), /followUpsEnabled/,
        'the send path must honour the answer');
    assert.ok(landmark(enrol, 'followUpsEnabled') < landmark(enrol, 'ensureDefaultSequence'),
        'checked BEFORE a sequence is provisioned — a tenant who said no should have no cadence at '
        + 'all, not a halted one implying chasers were meant');
});

check('a blank answer still chases, so live cadences are not halted by a deploy', () => {
    const fn = SEQUENCES.slice(landmark(SEQUENCES, 'async function followUpsEnabled'));
    assert.match(fn.slice(0, 900), /!==\s*'none'/,
        'only the explicit opt-out turns chasing off — every assistant hired before the question '
        + 'existed has no answer and a running cadence');
});

check('the post-send message states whether a sequence started', () => {
    assert.match(LEAD_GEN, /followUps: enrolmentId \? 'started' : 'none'/,
        'the server reports the enrolment it actually made, so the toast cannot claim a cadence that '
        + 'was skipped or hide one that was not');
    const toast = SHELL.slice(landmark(SHELL, 'if (sdata.sent)'));
    assert.match(toast.slice(0, 1400), /followUps === 'started'/,
        'and the toast must read it');
});

check('every non-send reason is spoken aloud', () => {
    // suppression_check_failed shipped with no branch, so the one outcome caused by OUR
    // infrastructure fell through to a bare "Lead approved." beside an email that never left.
    const fn = SHELL.slice(landmark(SHELL, 'async function _rqSendLeadOutreach'), landmark(SHELL, 'window._detailRqRecordAct'));
    for (const reason of ['suppressed', 'suppression_check_failed', 'no_postal_address', 'no_recipient', 'do_not_contact']) {
        assert.ok(fn.includes(`'${reason}'`), `no sentence for the "${reason}" outcome`);
    }
    assert.match(fn, /if \(sdata\.reason\) \{/,
        'and an unrecognised reason must still be reported rather than swallowed — that silence is '
        + 'exactly how suppression_check_failed hid');
});

console.log('\n──── 4. the retention clock warns before it acts ────');

check('the sweep warns before it moves anything', () => {
    assert.match(RETENTION_SWEEP, /createNotification\(db, 'leads_expiring_soon'/,
        'the sweep was silent in both directions — nothing before it moved a lead and nothing after');
    assert.ok(landmark(RETENTION_SWEEP, 'warnBeforeSweep(db, now)') < landmark(RETENTION_SWEEP, 'collect(db, cutoff)'),
        'the warning has to run before the move, and unconditionally: "nothing expired tonight" and '
        + '"nothing is about to" are different facts, and the second is the one worth sending');
});

check('the warning is one digest per assistant, not one per lead', () => {
    const fn = RETENTION_SWEEP.slice(landmark(RETENTION_SWEEP, 'async function warnBeforeSweep'));
    assert.match(fn.slice(0, 2600), /groupBy\(assistantRecords\.aiAssistantId\)/,
        'a tenant back from a fortnight away must not be handed forty notifications');
    const tpl = getNotificationDefault('leads_expiring_soon');
    assert.ok(tpl, 'the digest needs catalog copy');
    assert.match(`${tpl!.title} ${tpl!.message}`, /\{\{lead\.count\}\}/, 'and it should state how many');
});

check('the expiry digest is mutable, and does not buzz a phone', () => {
    const cat = PREF_CATEGORIES.find((c) => c.types.includes('leads_expiring_soon'));
    assert.ok(cat, 'an unmapped type is unreachable from the preferences matrix');
    assert.equal(pushRule(cat!).default, false,
        'a nudge about a three-day deadline is a summary, not an interruption');
});

console.log(`\n${passed} checks passed.\n`);
