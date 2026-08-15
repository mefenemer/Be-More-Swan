// tests/lead-approve-surface.test.ts
// "Approving sends the email" is TRUE in one place and FALSE in another, and the same card renders
// in both.
//
// The Review Queue's approve calls send_outreach and the mail goes out (assistants.js). The Leads
// tab's approve records the decision and sends nothing — its own status line says so. The lead
// scoring card was written for the first case and rendered unchanged in the second, so a lead
// opened in the Leads tab carried "Approving sends the outreach email automatically" in an amber
// box directly above an Approve button that would not send. That is a compliance warning pointed at
// the wrong control, on the one class of lead (a named individual's inbox) where it matters most.
//
// Run:  npx tsx tests/lead-approve-surface.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const CARD = read('src/components/disruptive-ui-registry.js');
const HUB = read('src/components/assistant-data-hub.js');
const SHELL = read('assistants.js');

console.log('\n──── the two approve paths really are different ────');

check('the Review Queue approve sends; the Leads tab approve does not', () => {
    // Pin the premise. If these ever converge, the surface-aware copy below becomes unnecessary
    // rather than wrong — but the two must be reasoned about together.
    // ⚠️ Re-anchored: the send flow moved out of the approve handler into _rqSendLeadOutreach, so
    // that "Send email now" on an already-approved lead takes the identical path (same
    // do-not-contact, suppression and personal-inbox gates). Both halves are asserted — the
    // approve handler must still call it, and it must still be the thing that POSTs.
    assert.match(SHELL, /action === 'approve' && \(window\._detailReviewQueue \|\| \{\}\)\.recordType === 'lead'/,
        'the Review Queue approve must still branch on a lead');
    assert.match(SHELL, /await _rqSendLeadOutreach\(patch\.id\)/,
        'and it must still send that lead’s outreach');
    assert.match(SHELL, /action: 'send_outreach', assistantId: window\._currentAssistantId, recordId,/,
        'which is the one place that POSTs send_outreach');
    // ⚠️ Anchored on the PUSH, not on the bare label. "label: 'Approve'" also occurs in
    // nextStepGuidance(), which offers Approve as the next-step button — a slice starting there
    // runs through half the file and stops asserting anything about this handler.
    const hubApprove = HUB.slice(landmark(HUB, "buttons.push({ label: 'Approve'"));
    const body = hubApprove.slice(0, landmark(hubApprove, '}});'));
    assert.ok(!/send_outreach/.test(body),
        'the Leads tab approve must not send — the split is deliberate: judging a company is fast '
        + 'and high-volume, judging an email is slow and low-volume');
    assert.match(body, /Nothing has been sent/,
        'and it must say so, because a user who has used the Review Queue has learned that '
        + 'approving sends');
});

console.log('\n──── the card says what THIS surface does ────');

check('the card takes a surface flag rather than assuming', () => {
    assert.match(CARD, /function renderLeadScoringCard\(ui, esc, opts\)/,
        'the renderer must accept surface options');
    assert.match(CARD, /const sendsOnApproval = !opts \|\| opts\.sendsOnApproval !== false;/,
        'default TRUE: chat and the Review Queue are where this card came from, and the surface '
        + 'that really does send must never be the one that forgets to say so');
});

check('the Leads tab renders it with sending switched off', () => {
    // ⚠️ slice(start) then take a window — `slice(start, 0)` returns EMPTY, which asserts nothing
    // and passes nothing, and is the standard way these source scans quietly stop testing.
    const call = HUB.slice(landmark(HUB, 'DisruptiveUIRegistry.render(record.data')).slice(0, 200);
    assert.match(call, /sendsOnApproval: false/,
        'the detail panel must tell the card that approving here sends nothing');
});

check('the personal-inbox warning still warns, either way', () => {
    // The warning itself is load-bearing — a scraped address belonging to a named individual is the
    // weakest footing for cold B2B outreach. Only the CONSEQUENCE sentence changes.
    const block = CARD.slice(landmark(CARD, 'Personal inbox — check before approving'));
    const warning = block.slice(0, 700);
    assert.match(warning, /named individual rather than a general contact address/,
        'the warning must survive on both surfaces');
    assert.match(warning, /Approving sends the outreach email automatically/,
        'the sending surface must still say it sends');
    assert.match(warning, /records your decision only/,
        'the non-sending surface must say what it actually does instead');
});

check('the chat transcript is untouched', () => {
    // chat-session.js calls render() with no options, so it keeps the original wording. If it ever
    // starts passing the flag, that is a decision to review, not a refactor.
    const chat = read('src/components/chat-session.js');
    assert.ok(!/sendsOnApproval/.test(chat),
        'chat must keep the default — its cards describe the Review Queue flow');
});

console.log('\n──── the email belongs to Review, the record to Leads ────');

check('the Leads tab offers nothing that acts on the outreach email', () => {
    // The tab's job: read a lead, progress its next step, enrich it, decide on it, delete it.
    // Copying a draft from a screen that never shows the draft is a blind action, and a second
    // "push it into Gmail" button is how a user ends up with two drafts and no idea which is which.
    const hub = HUB.slice(landmark(HUB, "function detailActions("), landmark(HUB, '\n  // A post that failed to publish'));
    // ⚠️ Matched on the BUTTON, not the phrase: the comment recording why this moved necessarily
    // quotes the label it removed, and a bare phrase search would fail on the fix's own docs.
    assert.ok(!/label: 'Copy outreach draft'/.test(hub),
        'the Leads tab must not copy the outreach draft — that lives in the Review tab, on the card '
        + 'that actually shows the email');
    assert.ok(!/gmail_create_draft/.test(HUB),
        'the Leads tab must not push drafts into Gmail');
    // What it keeps: the lead-record actions.
    for (const kept of ['Add an address', 'Look again', 'Record outcome', 'Approve', 'Reject', 'Delete']) {
        assert.ok(hub.includes(`'${kept}'`) || hub.includes(`: '${kept}'`) || new RegExp(`'${kept}`).test(hub),
            `the Leads tab lost "${kept}", which is a lead-record action and belongs here`);
    }
});

check('the card hides its Gmail button on a record surface', () => {
    assert.match(CARD, /const outreachActions = !opts \|\| opts\.outreachActions !== false;/,
        'the card must take a flag for whether this surface acts on the email');
    assert.match(CARD, /const draft = \(outreachActions &&/,
        'the Gmail action must be gated on it — the draft variable is what renders that button');
    assert.match(HUB, /outreachActions: false/, 'the Leads tab must switch it off');
});

check('the Review tab gained the two routes the Leads tab gave up', () => {
    // Moving a capability without a destination is a regression dressed as tidying.
    assert.match(SHELL, /btn\('Copy draft', 'copyEmail', secondary\)/, 'Review must offer Copy draft');
    assert.match(SHELL, /btn\('Draft in Gmail', 'draftGmail', secondary\)/, 'Review must offer Draft in Gmail');
    assert.match(SHELL, /action === 'copyEmail' \|\| action === 'draftGmail'/, 'and handle both');
    // Leads only: a ticket has no outreach email, and a meeting's mail is built at send time.
    assert.match(SHELL, /const selfSend = \(isLead && hasDraft\)/,
        'these two must be gated on a LEAD that actually has a draft');
});

check('the copy and the send read the same stored draft', () => {
    // A copy taken after an edit must be the edited text — otherwise the user pastes one email into
    // their inbox while Approve would have sent another.
    const branch = SHELL.slice(landmark(SHELL, "action === 'copyEmail' || action === 'draftGmail'"));
    const body = branch.slice(0, 1600);
    assert.match(body, /_rqDraft\(rec\)/,
        'both must read the stored draft through _rqDraft, the same accessor saveEmail writes and '
        + 'send_outreach sends');
});

console.log('\n──── a decision already taken is not an offer ────');

check('Approve and Reject stop being pressable once pressed', () => {
    for (const label of ['Approve', 'Reject']) {
        const branch = HUB.slice(landmark(HUB, `label: '${label}'`));
        const body = branch.slice(0, landmark(branch, '}});'));
        assert.match(body, /btn\.disabled = true;/,
            `the ${label} button stayed enabled after succeeding, so the obvious next thing to do `
            + 'with it was press it again — which re-sent the same decision');
    }
});

check('the panel has exactly one emphasised action', () => {
    // Five identical ghost buttons ("Edit · Record outcome · Copy outreach draft · Approve ·
    // Reject") gave a reader no way in. Approve is the decision the panel exists for; everything
    // else is a tool.
    const primaries = [...HUB.matchAll(/buttons\.push\(\{ label: '([^']+)', primary: true/g)].map((m) => m[1]);
    assert.deepStrictEqual(primaries, ['Approve'],
        `exactly one primary action is expected, found: ${primaries.join(', ') || 'none'}`);
    assert.match(HUB, /b\.primary\s*\n?\s*\? 'px-3 py-1\.5 bg-emerald-700/,
        'primary must render in the house emerald fill, not a fourth bespoke style');
});

console.log(`\n${passed} checks passed.`);
