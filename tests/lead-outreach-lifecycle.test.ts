// tests/lead-outreach-lifecycle.test.ts
// What happens to a lead — and to its email — after "Approve & send email".
//
// The complaint this came from: approving a lead made it vanish. The lead left the Review column
// (correct), and then appeared in NEITHER of the two columns the user was looking at, because a
// successful send leaves the record `scheduled` — that state is the chase reminder, not a pending
// send — while the Approved column filtered on `approved` alone. And when no inbox was connected,
// the whole thing ended in a toast: nothing sent, no offer to connect one, and no route to the
// drafted email that had just been written and abandoned.
//
// So there are four facts to pin, and every one of them was a silent wrong answer before:
//   1. an approved lead lands in Approved WHETHER OR NOT its email sent;
//   2. a SENT lead also appears under Scheduled, which is its chase reminder;
//   3. "did the email go?" is a state of its own, from ONE definition, on every surface;
//   4. no inbox → offer to connect one → and if they decline, hand them the draft to send.
//
// Run:  npx tsx tests/lead-outreach-lifecycle.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { LEAD_OUTREACH_CHIPS, leadOutreachState } from '../src/config/lead-outreach-state';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const SHELL = read('assistants.js');
const HUB = read('src/components/assistant-data-hub.js');
const RECORDS = read('netlify/functions/assistant-records.ts');
const LEADGEN = read('netlify/functions/lead-generation.ts');
const CONSTANTS = read('src/generated/platform-constants.js');
const DIALOGS = read('dialogs.js');

console.log('\n──── "did the email go?" has exactly one definition ────');

check('the send stamp outranks the drafted stamp', () => {
    // A lead can legitimately carry both: declined the connect prompt on Monday, connected an inbox
    // and sent on Tuesday. Reading them the other way round would chip a delivered email
    // "Email Drafted" — the one state the user must never be misled about.
    assert.strictEqual(leadOutreachState({ outreachSentAt: '2026-08-15T09:00:00Z' }), 'sent');
    assert.strictEqual(leadOutreachState({ outreachDraftedAt: '2026-08-15T09:00:00Z' }), 'drafted');
    assert.strictEqual(
        leadOutreachState({ outreachSentAt: '2026-08-15T09:00:00Z', outreachDraftedAt: '2026-08-14T09:00:00Z' }),
        'sent',
    );
});

check('nothing having happened reads as null, never as "drafted"', () => {
    // Null is the honest answer for a lead still awaiting review and for one approved before these
    // stamps existed. "Drafted" would claim a hand-off to the user that never took place.
    assert.strictEqual(leadOutreachState({}), null);
    assert.strictEqual(leadOutreachState(null), null);
    assert.strictEqual(leadOutreachState('outreachSentAt'), null);
    assert.strictEqual(leadOutreachState([]), null, 'an array is not a record');
    assert.strictEqual(leadOutreachState({ outreachSentAt: '   ' }), null, 'a blank stamp is not a send');
});

check('the labels are the user’s words, and they are generated not retyped', () => {
    assert.strictEqual(LEAD_OUTREACH_CHIPS.sent.label, 'Email Sent');
    assert.strictEqual(LEAD_OUTREACH_CHIPS.drafted.label, 'Email Drafted');
    // ⚠️ The browser copy must come from the generator. Three surfaces read it — the Review card
    // chip, the Leads-tab Approval cell, the banner on an open lead — and a hand-typed fourth
    // wording is how the same lead ends up described two ways in two tabs.
    assert.match(CONSTANTS, /window\.LeadOutreach = \{/, 'run `npm run gen:constants`');
    assert.match(CONSTANTS, /var leadOutreachState = function/, 'the predicate itself must be mirrored, not re-implemented');
    for (const label of ['Email Sent', 'Email Drafted']) {
        assert.ok(CONSTANTS.includes(label), `the mirror lost "${label}"`);
        assert.ok(!SHELL.includes(`'${label}'`), `assistants.js retypes "${label}" instead of reading window.LeadOutreach`);
    }
    // The Leads tab names both labels exactly once each, in ORDERED_VALUES — where it must, because
    // that vocabulary ranks the RENDERED cell text. Anywhere else is a hand copy.
    for (const label of ['Email Sent', 'Email Drafted']) {
        assert.strictEqual((HUB.match(new RegExp(`'${label}'`, 'g')) || []).length, 1,
            `the Leads tab should name "${label}" only in ORDERED_VALUES — everywhere else reads window.LeadOutreach`);
    }
});

console.log('\n──── an approved lead is in Approved, sent or not ────');

check('the lead Approved column asks for BOTH approval states', () => {
    // The bug: a successful send sets approvalStatus='scheduled' server-side, so filtering Approved
    // to 'approved' emptied it the instant an approval succeeded — the user pressed the button and
    // the lead disappeared from the column they were watching.
    assert.match(SHELL, /const approvalQuery = \(recordType === 'lead' && statusKey === 'approved'\) \? 'approved,scheduled' : approval;/,
        'the Approved column must request approved AND scheduled for leads');
    assert.match(SHELL, /approvalStatus=\$\{approvalQuery\}/,
        'and the fetch must actually use it, not the single-state value');
});

check('the server accepts the list, without a raw array in SQL', () => {
    const filter = RECORDS.slice(landmark(RECORDS, 'const APPROVAL_STATES = new Set(')).slice(0, 700);
    assert.match(filter, /\.split\(','\)/, 'approvalStatus must accept a comma-separated list');
    assert.match(filter, /APPROVAL_STATES\.has\(s\)/, 'and drop anything not a real state rather than trusting it');
    // ⚠️ drizzle renders an interpolated JS array inside sql`` as a ROW constructor, and
    // `= ANY((a,b))` is a 42809 at runtime — invisible to typecheck, fatal to the column.
    assert.match(RECORDS, /inArray\(assistantRecords\.approvalStatus, approvalFilter\)/,
        'the multi-state filter must go through inArray');
});

check('the buttons key off the RECORD, not the column it is in', () => {
    // Two approval states now share one column, so "which buttons" cannot be answered by the column
    // any more: a sent lead and an unsent one sit side by side in Approved.
    const approved = SHELL.slice(landmark(SHELL, "} else if (statusKey === 'approved') {"));
    const body = approved.slice(0, landmark(approved, "} else if (statusKey === 'scheduled') {"));
    assert.match(body, /const out = _rqOutreachState\(r\);/,
        'the Approved column must read each record’s own outreach state');
    assert.match(body, /btn\('Send email now', 'sendNow', primary\)/,
        'an approved-but-unsent lead needs a way to send — otherwise connecting an inbox afterwards '
        + 'finishes nothing');
    assert.match(body, /btn\('Copy draft', 'copyEmail', secondary\)/,
        'and a way to take the draft away by hand');
    const sent = body.slice(0, landmark(body, '} else {'));
    assert.ok(!/'outreachSent'/.test(sent),
        'a lead whose email has gone must not still offer "Mark outreach sent"');
    assert.ok(!/'review'/.test(sent),
        'nor offer to send an already-delivered email back for re-approval');
});

console.log('\n──── a sent lead also has a reminder, and says so ────');

check('Scheduled states that it is a chase reminder, not a pending send', () => {
    const sched = SHELL.slice(landmark(SHELL, "} else if (statusKey === 'scheduled') {")).slice(0, 900);
    assert.match(sched, /The outreach email has gone/,
        'the column is called "Scheduled" everywhere else in the app, where it DOES mean "waiting to '
        + 'go out" — for a lead it must say otherwise on the card');
    assert.match(sched, /nothing is sent automatically/i, 'and rule out a second send');
});

check('a successful send is what books the reminder, server-side', () => {
    const send = LEADGEN.slice(landmark(LEADGEN, "if (action === 'send_outreach') {"));
    const body = send.slice(0, landmark(send, 'return json(200, { sent: true'));
    assert.match(body, /approvalStatus: 'scheduled', scheduledFor: chase/,
        'the chase reminder is set by the SEND, never by the approval — a lead nobody emailed must '
        + 'not appear in the reminders');
    assert.match(body, /outreachSentAt: new Date\(\)\.toISOString\(\)/, 'and the send must stamp itself');
    // ⚠️ The drafted stamp is dropped rather than merged through, or a lead that was drafted first
    // and sent later would keep reading "Email Drafted" beside a delivered email.
    assert.match(body, /const \{ outreachDraftedAt: _wasDrafted, \.\.\.rest \} = data;/,
        'the send must clear the "yours to send" stamp');
});

check('logging outreach sent by hand stamps it the same way', () => {
    // ⚠️ Bounded by the NEXT branch, not by a character count. This read `.slice(0, 1200)`, which
    // silently made the test a limit on how much prose the branch may carry: adding a comment
    // above the stamp pushed the stamp out of the window and failed a check about code that had
    // not changed. The next `else if` is where the branch actually ends.
    const outreachSent = SHELL.slice(landmark(SHELL, "else if (action === 'outreachSent') {"));
    const branch = outreachSent.slice(0, landmark(outreachSent, "else if (action === 'reject') {"));
    assert.match(branch, /outreachSentAt: new Date\(\)\.toISOString\(\)/,
        '"Mark outreach sent" must stamp the record, or the card keeps claiming the email is still '
        + 'waiting and the sales-cycle clock never starts');
    assert.match(branch, /outreachDraftedAt: _dropped/, 'and clear the drafted stamp for the same reason the send does');
    assert.match(branch, /outreachSentVia: 'manual'/,
        'and mark WHO sent it. This writes the same stamp a real send writes, so without the marker '
        + 'the Approved column reports a hand-sent lead as "Sent from your connected inbox" — our '
        + 'system taking credit for a send it never performed, naming a connection that may not exist');
});

check('a real send records the provider, so the two are told apart', () => {
    const stamp = LEADGEN.slice(landmark(LEADGEN, 'const { outreachDraftedAt: _wasDrafted, ...rest } = data;'));
    const branch = stamp.slice(0, landmark(stamp, "await recordEvent(db, 'outreach_sent'"));
    assert.match(branch, /outreachSentVia: provider/,
        'the send path must stamp the provider it actually sent through. `outreachSentAt` alone '
        + 'cannot answer "did WE send this?", and every sentence the Approved column and the draft '
        + 'preview write about a sent lead depends on the answer');
});

console.log('\n──── no inbox: offer one, and hand back the draft ────');

check('both "no inbox" reasons get the same offer', () => {
    const branch = SHELL.slice(landmark(SHELL, '// ── No inbox to send from ─')).slice(0, 1400);
    assert.match(branch, /sdata\.reason === 'no_provider' \|\| sdata\.reason === 'not_connected'/,
        'never chose a provider, and chose one but never authorised it, are the same fact to the '
        + 'person looking at the screen: nothing was emailed');
    assert.match(branch, /_rqOfferOutreachConnect\(\)/, 'and both must be offered the connection');
});

check('declining the offer drafts the email and hands it over', () => {
    const branch = SHELL.slice(landmark(SHELL, '// ── No inbox to send from ─')).slice(0, 1600);
    assert.match(branch, /await _rqStampOutreachDrafted\(recordId\)/,
        'declining must record the state, or the lead reads as a bare "Approved" and nobody can '
        + 'tell it from one that was emailed');
    assert.match(branch, /await _rqOfferCopyDraft\(recordId\)/,
        'and must offer the text — a toast saying "nothing was sent" with no route to the draft is '
        + 'where this flow used to end');
});

check('accepting the offer does NOT pretend the email was drafted for them', () => {
    const branch = SHELL.slice(landmark(SHELL, '// ── No inbox to send from ─')).slice(0, 1600);
    const connecting = branch.slice(landmark(branch, 'if (outcome.connecting)')).slice(0, 400);
    assert.ok(!/_rqStampOutreachDrafted/.test(connecting),
        'a user who has gone off to connect an inbox has not taken the email away to send — the '
        + 'lead is waiting on a connection, and the card must not say otherwise');
    assert.match(connecting, /Send email now/, 'it must name the button that finishes the job');
});

check('the connect offer is a real choice, and it saves the setup answer', () => {
    const fn = SHELL.slice(landmark(SHELL, 'async function _rqOfferOutreachConnect('));
    const body = fn.slice(0, landmark(fn, '\n/**'));
    // ⚠️ Three answers (Gmail / Outlook / neither) cannot be a confirm: one of the two real choices
    // would become the CANCEL button, which Escape and a backdrop click also pick.
    assert.match(body, /window\.choiceModal\(/, 'the provider choice must be a choiceModal');
    assert.match(DIALOGS, /window\.choiceModal = function/, 'which has to exist in the one dialog module');
    // Connecting the OAuth account is only half of it: send_outreach gates on the ONBOARDING
    // ANSWER, so an account connected while the answer still reads "I'll send outreach myself"
    // would never auto-send, and nothing on screen would explain why.
    assert.match(body, /_rqSetOutreachProvider\(choice\)/, 'choosing a provider must store the setup answer');
    assert.match(LEADGEN, /if \(action === 'set_outreach_provider'\)/, 'and the server must accept it');
    // An already-connected account means the question is not "connect?" but "switch it on?".
    assert.match(body, /\/api\/oauth\/status/, 'it must check what is already connected before asking');
    assert.match(body, /return \{ retry: true \}/, 'and send straight away when the answer is yes');
});

check('the retry cannot loop', () => {
    // If the provider answer fails to save, the retry comes back 'no_provider' and would re-open
    // the same dialog for ever.
    assert.match(SHELL, /_rqSendLeadOutreach\(recordId, \{ approving, allowConnect: false \}\)/,
        'the retried send must not be allowed to re-open the connect offer');
});

check('set_outreach_provider merges one key instead of replacing the context', () => {
    const action = LEADGEN.slice(landmark(LEADGEN, "if (action === 'set_outreach_provider') {")).slice(0, 900);
    assert.match(action, /onboardingContext: \{ \.\.\.onboarding, outreachEmailProvider: wanted \}/,
        'a partial write from this screen would blank every other setup answer the assistant has');
    assert.match(action, /wanted !== 'google' && wanted !== 'microsoft' && wanted !== 'none'/,
        'and the value must be one the send path actually understands');
});

console.log('\n──── one send path, so the gates cannot fork ────');

check('approve and "Send email now" go through the same function', () => {
    // The compliance gates (do-not-contact, suppression, personal inbox) are answered in the
    // browser. A second copy of this flow is a second set of answers to get wrong.
    assert.match(SHELL, /async function _rqSendLeadOutreach\(recordId, opts\)/);
    assert.match(SHELL, /window\.showToast\?\.\(await _rqSendLeadOutreach\(patch\.id\)\);/, 'approve calls it');
    assert.match(SHELL, /window\.showToast\?\.\(await _rqSendLeadOutreach\(id, \{ approving: false \}\)\);/,
        '"Send email now" calls it too');
    const posts = [...SHELL.matchAll(/action: 'send_outreach'/g)];
    assert.strictEqual(posts.length, 1, `send_outreach is POSTed from ${posts.length} places; it must be exactly one`);
});

check('the gates are still asked, and still styled dialogs', () => {
    const fn = SHELL.slice(landmark(SHELL, 'async function _rqSendLeadOutreach('));
    const body = fn.slice(0, landmark(fn, '\n// Approve / reject / schedule a record'));
    assert.match(body, /sdata\.reason === 'do_not_contact'/, 'the do-not-contact override must survive the move');
    assert.match(body, /sdata\.reason === 'personal_inbox_unconfirmed'/, 'and the personal-inbox gate');
    assert.match(body, /at least 10 characters/, 'the override reason is the authorisation — keep the floor');
    // The native grey boxes were removed from this product in 2026-08; these two were the last
    // survivors in this flow and would have sat directly beside the new styled ones.
    assert.ok(!/window\.confirm\(/.test(body), 'no native confirm() in the send flow');
    assert.ok(!/window\.prompt\(/.test(body), 'no native prompt() in the send flow');
});

console.log('\n──── the two tabs describe the lead the same way ────');

check('the Review card shows the outreach state instead of "Email ready"', () => {
    const chips = SHELL.slice(landmark(SHELL, 'function _rqCardChips(r) {'));
    const body = chips.slice(0, landmark(chips, "\n/**\n * One record, collapsed to its company name."));
    assert.match(body, /const outreach = _rqOutreachChip\(r\);/);
    assert.match(body, /if \(outreach\) \{\s*\n\s*chips\.push\(outreach\);\s*\n\s*\} else if/,
        '⚠️ INSTEAD of the readiness chip, not beside it: "Email ready" on a lead that has already '
        + 'been emailed reads as still-to-do');
});

check('the Leads tab Approval column resolves through the same rule', () => {
    assert.match(HUB, /function approvalChip\(record\) \{/, 'one resolver for the cell and the banner');
    assert.match(HUB, /if \(key === 'approvalStatus'\) return approvalChip\(record\)\?\.short/, 'the cell uses it');
    assert.match(HUB, /const s = approvalChip\(record\);/, 'the banner and the row chip use it');
    assert.match(HUB, /window\.LeadOutreach/, 'and it reads the generated definition');
    assert.match(HUB, /if \(record\.recordType !== 'lead'\) return base;/,
        'other record types keep the plain approval vocabulary — "Email Sent" means nothing on an invoice');
});

check('the new labels are ranked, or every touched lead sorts last', () => {
    // ⚠️ ORDERED_VALUES names the RENDERED cell. A label it does not know ranks `vocab.length` —
    // so without this every lead that has been through an approval would sort into one lump.
    const vocab = HUB.slice(landmark(HUB, 'approvalStatus: ['), landmark(HUB, "contact: ['Role inbox'"));
    for (const label of ['Awaiting you', 'Approved', 'Email Drafted', 'Email Sent', 'Chase set', 'Rejected']) {
        assert.ok(vocab.includes(`'${label}'`), `ORDERED_VALUES.approvalStatus is missing "${label}"`);
    }
    assert.ok(vocab.indexOf("'Email Drafted'") < vocab.indexOf("'Email Sent'"),
        'what still wants the user sorts first — a drafted email is theirs to send, a sent one is not');
});

console.log('\n──── grouped rows fold ────');

check('a group heading is a control, and the fold is state not markup', () => {
    const paint = HUB.slice(landmark(HUB, 'function paintRows() {'));
    const body = paint.slice(0, landmark(paint, 'const count = host.querySelector'));
    assert.match(body, /data-hub-group-toggle/, 'the heading must be pressable');
    assert.match(body, /aria-expanded="\$\{collapsed \? 'false' : 'true'\}"/, 'and say so to a screen reader');
    // ⚠️ paintRows() rewrites every row on each keystroke, so a fold recorded in the DOM would
    // spring open as the user typed in the search box — the same reason `selected` is a Set.
    assert.match(body, /state\.view\.collapsed\.has\(group\.label\)/, 'the fold lives in the view state');
    assert.match(HUB, /collapsed: new Set\(\)/g, 'and is initialised with the rest of the view');
    assert.strictEqual((HUB.match(/collapsed: new Set\(\)/g) || []).length, 2,
        'both view initialisers (first paint and init()) must create the Set, or a fold throws');
});

check('folded rows are not drawn, and nothing else changes', () => {
    const paint = HUB.slice(landmark(HUB, 'function paintRows() {'));
    const body = paint.slice(0, landmark(paint, 'const count = host.querySelector'));
    assert.match(body, /if \(collapsed\) continue;/, 'a folded group renders no rows');
    // The counts above and below the table have never counted the DOM, and must not start: folding
    // a group is not filtering it out.
    assert.match(body, /· \$\{group\.records\.length\}/, 'the heading still counts its own rows');
});

check('changing the grouping opens everything again', () => {
    const handler = HUB.slice(landmark(HUB, "const group = host.querySelector('[data-hub-group]');")).slice(0, 900);
    assert.match(handler, /state\.view\.collapsed\.clear\(\)/,
        'labels belong to the column they were made in — "Rejected" folded under Approval must not '
        + 'fold a Rating group that happens to share the word');
    const clear = HUB.slice(landmark(HUB, "host.querySelector('[data-hub-clear]')?.addEventListener")).slice(0, 500);
    assert.match(clear, /state\.view\.collapsed\.clear\(\)/, 'and Clear must clear the folds too');
});

// ── The tab and its columns are named for what they DO ───────────────────────
//
// "Review" understated a tab whose approve button sends a cold email, and "Scheduled" said the
// opposite of what that column means for a lead: the email has already gone, and what is scheduled
// is the reminder to chase. Both are role overrides, because both words are correct elsewhere.

console.log('\n──── the tab and its columns say what they are ────');

const REGISTRY = read('src/components/assistant-dashboard-registry.js');
const DETAIL_HTML = read('assistant-detail.html');
const leadRegistry = REGISTRY.slice(landmark(REGISTRY, 'lead_qualifier: {'), landmark(REGISTRY, 'accounts_receivable_clerk: {'));

check('the Lead Generator renames the tab, and the chat prompt agrees', () => {
    const rq = leadRegistry.slice(landmark(leadRegistry, 'reviewQueue: {'));
    const label = /label:\s*'([^']+)'/.exec(rq.slice(0, 1400));
    assert.ok(label, 'lead_qualifier no longer overrides the review-queue tab label');
    // Derived, never a literal: tests/lead-prompt-surfaces.test.ts already fails if the prompt
    // omits a labelled surface, and pinning the word here as well would just be a third copy.
    const prompt = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(prompt.includes(`"${label[1]}" tab`),
        `the chat prompt must name the "${label[1]}" tab — an assistant that has not been told a `
        + 'tab exists invents an explanation for it');
});

check('the Scheduled column is renamed for leads, and only for leads', () => {
    const rq = leadRegistry.slice(landmark(leadRegistry, 'reviewQueue: {'));
    assert.match(rq.slice(0, 2400), /columnLabels:\s*\{[^}]*scheduled:\s*'[^']+'/,
        'lead_qualifier must override the Scheduled column — for a lead that state means the email '
        + 'has ALREADY gone, and the shared word promises the opposite');
    // The markup keeps "Scheduled": post queues genuinely do hold pending sends there. An edit to
    // the HTML instead of an override would have renamed it for every role.
    assert.match(DETAIL_HTML, /data-status="scheduled"[^>]*>Scheduled/,
        'the shared markup must still ship the default label');
});

check('a column label is always assigned, so a rename cannot leak between roles', () => {
    // The page persists across assistant switches (workspace.html loadView reuses the view), so a
    // label applied only when an override exists would stick when the user opens a role without one.
    const apply = SHELL.slice(landmark(SHELL, 'const rqColumnLabels ='), landmark(SHELL, 'const rqIsBlog'));
    assert.match(apply, /_RQ_COLUMN_LABELS/,
        'the loop must iterate the DEFAULTS, not the overrides — otherwise nothing resets');
    assert.match(apply, /rqColumnLabels\[status\] \|\| fallback/,
        'every column must be assigned its override or its default on every apply');
    // textContent would delete the count badge that shares the button.
    assert.match(apply, /nodeType === 3/,
        'only the leading text node may be rewritten — the badge span lives in the same button');
});

check('every column in the markup has a default label to reset to', () => {
    const statuses = [...DETAIL_HTML.matchAll(/class="detail-rq-col[^"]*"[\s\S]{0,200}?data-status="([a-z]+)"/g)]
        .map((m) => m[1]);
    assert.ok(statuses.length >= 5, `expected the lifecycle columns, found ${statuses.length}`);
    const defaults = SHELL.slice(landmark(SHELL, 'const _RQ_COLUMN_LABELS = {'), landmark(SHELL, '\n};', landmark(SHELL, 'const _RQ_COLUMN_LABELS = {')));
    const missing = [...new Set(statuses)].filter((s) => !new RegExp(`\\b${s}:`).test(defaults));
    assert.deepStrictEqual(missing, [],
        `_RQ_COLUMN_LABELS has no default for: ${missing.join(', ')} — a column missing from it keeps `
        + 'whatever label the previously-viewed role left on it');
});

check('card copy names the column as the role labels it', () => {
    // "it's in the Scheduled tab" was hardcoded next to a column the Lead Generator renames.
    assert.match(SHELL, /function _rqColumnLabel\(/, 'the label resolver must exist');
    assert.ok(!/in the Scheduled tab|the Approved and Scheduled columns/.test(SHELL),
        'card copy still hardcodes a column name — it must read _rqColumnLabel(), or it points '
        + 'users at a column that is not on their screen');
});

console.log(`\n${passed} checks passed.`);
