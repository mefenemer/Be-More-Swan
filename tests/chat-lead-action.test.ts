// tests/chat-lead-action.test.ts
// The Lead Generation chat can send a lead's outreach email, move a lead to Outreach, turn one down
// and record how a deal ended — by proposing a card the user confirms, which calls the tabs' own
// endpoints.
//
// WHY THIS EXISTS. Every capability is meant to be reachable from the GUI and from chat through one
// server action; every decision on a lead was page-only. Sending reaches a stranger, and the owner
// allowed it from chat on one condition (2026-10-22): the card shows the email in full, and the
// follow-ups, before the click. These pin what makes that true — the card is rebuilt from the row
// with the STORED draft verbatim; only a stored draft can be sent; the draft's fingerprint travels
// with the click and send_outreach refuses a changed one; every gate runs before the lead is
// approved; and the click goes through the same endpoints the tabs use.
//
// Run:  npx tsx tests/chat-lead-action.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    leadActionFromUiElement, outreachDraftFingerprint, refreshLeadActionCards, resolveLeadActionProposal, sendableDraft,
} from '../src/utils/chat-lead-action';
import { DEFAULT_SEQUENCE_STEPS } from '../src/config/outreach-sequences';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

/** A db whose successive select() calls answer with the given row lists, in order. Writes throw. */
function fakeDb(...answers: unknown[][]) {
    const queue = [...answers];
    return {
        select: () => {
            const rows = queue.shift() ?? [];
            const chain: any = {
                from: () => chain,
                where: () => chain,
                orderBy: () => chain,
                limit: () => Promise.resolve(rows),
                then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
            };
            return chain;
        },
        insert: () => { throw new Error('the card must not write'); },
        update: () => { throw new Error('the card must not write'); },
    } as any;
}

const DRAFT = { to: 'hello@acme.test', subject: 'A quick idea for Acme', body: 'Hi team,\n\nWe help bakeries like yours…\n\nBest, Swan Co' };
const lead = (approvalStatus: string, data: Record<string, unknown> = {}) => ({
    id: 12, title: '  Acme   Bakery ', status: 'Hot', approvalStatus,
    data: { outreachDraft: DRAFT, outreachStage: 'review', ...data },
});
const ASSISTANT = [{ onboardingContext: { outreachEmailProvider: 'google', outreachSignature: 'Sam\nSwan Co' } }];
const ORG = [{ name: 'Swan Co', postalAddress: '1 High Street, Bath BA1 1AA' }];
const send = { action: 'send' as const, recordId: 12, outcome: null, lossReason: null, valueGbp: null };

async function main() {
    console.log('\nThe model\'s proposal is shape-checked');

    await check('a well-formed proposal is read, "#12" included', () => {
        assert.deepStrictEqual(leadActionFromUiElement({ type: 'lead_action_proposal', action: 'send', recordId: '#12' }), send);
    });
    await check('an outcome must be a real one; a value belongs to a win only', () => {
        assert.strictEqual(leadActionFromUiElement({ type: 'lead_action_proposal', action: 'set_outcome', recordId: 12, outcome: 'great' }), null);
        const lost = leadActionFromUiElement({ type: 'lead_action_proposal', action: 'set_outcome', recordId: 12, outcome: 'lost', lossReason: 'price', valueGbp: 500 });
        assert.strictEqual(lost?.valueGbp, null);
        assert.strictEqual(lost?.lossReason, 'price');
        assert.strictEqual(leadActionFromUiElement({ type: 'lead_action_proposal', action: 'delete', recordId: 12 }), null);
    });

    console.log('\nThe send card shows the stored email, from the row');

    await check('a lead that is not this assistant\'s gives no card', async () => {
        assert.strictEqual(await resolveLeadActionProposal(fakeDb([]), 1, 2, send), null);
    });
    await check('the card carries the stored draft verbatim, the signature, the footer and the follow-ups', async () => {
        const card = await resolveLeadActionProposal(fakeDb([lead('pending_approval')], ASSISTANT, ORG, [{ onboardingContext: {} }], []), 1, 2, send);
        assert.strictEqual(card?.blocked, null);
        assert.strictEqual(card?.title, 'Acme Bakery');
        assert.strictEqual(card?.to, DRAFT.to);
        assert.strictEqual(card?.subject, DRAFT.subject);
        assert.strictEqual(card?.body, DRAFT.body);
        assert.strictEqual(card?.signature, 'Sam\nSwan Co');
        assert.strictEqual(card?.footerAddress, ORG[0].postalAddress);
        assert.strictEqual(card?.approveFirst, true);
        assert.strictEqual(card?.draftHash, outreachDraftFingerprint(DRAFT.to, DRAFT.subject, DRAFT.body));
        // No sequence yet → the default one the first send would provision, as cumulative days.
        assert.deepStrictEqual(card?.followUps?.steps.map((s) => s.daysAfterOpener), [3, 10, 17]);
        assert.strictEqual(card?.followUps?.steps[0].brief, DEFAULT_SEQUENCE_STEPS[0].bodyPrompt);
    });
    await check('one-email-only assistants are told no follow-ups will follow', async () => {
        const card = await resolveLeadActionProposal(fakeDb([lead('approved')], ASSISTANT, ORG, [{ onboardingContext: { outreachFollowUps: 'none' } }]), 1, 2, send);
        assert.deepStrictEqual(card?.followUps, { enabled: false, steps: [] });
        assert.strictEqual(card?.approveFirst, false);
    });
    await check('no stored draft: refused — the server would write one nobody has read', async () => {
        const card = await resolveLeadActionProposal(fakeDb([lead('pending_approval', { outreachDraft: null, contactEmail: 'a@b.test', outreachStage: 'review' })]), 1, 2, send);
        assert.match(String(card?.blocked), /No email has been written/);
    });
    await check('do-not-contact, already sent, still in Found leads and turned down are all blocked', async () => {
        const dnc = await resolveLeadActionProposal(fakeDb([lead('pending_approval', { doNotContact: true, doNotContactReason: 'An existing customer' })]), 1, 2, send);
        assert.match(String(dnc?.blocked), /do-not-contact/);
        const sent = await resolveLeadActionProposal(fakeDb([lead('scheduled', { outreachSentAt: '2026-10-20T09:00:00Z' })]), 1, 2, send);
        assert.match(String(sent?.blocked), /already gone/);
        const triage = await resolveLeadActionProposal(fakeDb([lead('pending_approval', { outreachStage: 'triage' })]), 1, 2, send);
        assert.match(String(triage?.blocked), /still in Found leads/);
        const rejected = await resolveLeadActionProposal(fakeDb([lead('rejected')]), 1, 2, send);
        assert.ok(rejected?.blocked);
    });
    await check('no inbox, or no postal address, blocks the send before the click', async () => {
        const noInbox = await resolveLeadActionProposal(fakeDb([lead('approved')], [{ onboardingContext: {} }], ORG, [{ onboardingContext: {} }], []), 1, 2, send);
        assert.match(String(noInbox?.blocked), /No inbox/);
        const noAddress = await resolveLeadActionProposal(fakeDb([lead('approved')], ASSISTANT, [{ name: 'Swan Co', postalAddress: '' }], [{ onboardingContext: {} }], []), 1, 2, send);
        assert.match(String(noAddress?.blocked), /postal address/);
    });
    await check('a personal inbox is flagged on the card, so the click is the confirmation', async () => {
        const card = await resolveLeadActionProposal(fakeDb([lead('approved', { emailKind: 'personal', emailSource: 'scrape' })], ASSISTANT, ORG, [{ onboardingContext: {} }], []), 1, 2, send);
        assert.strictEqual(card?.personalInbox, true);
    });

    console.log('\nThe other three actions');

    await check('move to Outreach: only for a lead not already there or past it', async () => {
        const move = { ...send, action: 'move_to_outreach' as const };
        const ok = await resolveLeadActionProposal(fakeDb([lead('pending_approval', { outreachStage: 'triage' })]), 1, 2, move);
        assert.strictEqual(ok?.blocked, null);
        assert.strictEqual(ok?.hasEmail, true);
        const already = await resolveLeadActionProposal(fakeDb([lead('pending_approval')]), 1, 2, move);
        assert.match(String(already?.blocked), /already in Outreach/);
    });
    await check('turn down: not once its email has gone', async () => {
        const card = await resolveLeadActionProposal(fakeDb([lead('scheduled', { outreachSentAt: '2026-10-20T09:00:00Z' })]), 1, 2, { ...send, action: 'reject' });
        assert.ok(card?.blocked);
    });
    await check('lost needs a reason before there is a card to press; a correction says what it replaces', async () => {
        const noWhy = await resolveLeadActionProposal(fakeDb([lead('scheduled')]), 1, 2, { ...send, action: 'set_outcome', outcome: 'lost' });
        assert.match(String(noWhy?.blocked), /Say why/);
        const fix = await resolveLeadActionProposal(fakeDb([lead('scheduled', { dealOutcome: { outcome: 'lost' } })]), 1, 2, { ...send, action: 'set_outcome', outcome: 'won', valueGbp: 1200 });
        assert.strictEqual(fix?.blocked, null);
        assert.strictEqual(fix?.currentOutcome, 'lost');
        assert.strictEqual(fix?.valueGbp, 1200);
    });

    console.log('\nA stored card is re-checked when the conversation reopens');

    await check('a sent email closes its card; an edited draft closes it too', async () => {
        const ui = { type: 'lead_action_proposal', action: 'send', recordId: 12, draftHash: outreachDraftFingerprint(DRAFT.to, DRAFT.subject, DRAFT.body) };
        const [a] = await refreshLeadActionCards(fakeDb([lead('scheduled', { outreachSentAt: '2026-10-22T09:00:00Z' })]), 1, 2, [{ uiElement: ui }]);
        assert.match(String((a.uiElement as Record<string, unknown>).blocked), /^Already dealt with/);
        const [b] = await refreshLeadActionCards(fakeDb([lead('approved', { outreachDraft: { ...DRAFT, body: 'Something else entirely' } })]), 1, 2, [{ uiElement: ui }]);
        assert.match(String((b.uiElement as Record<string, unknown>).blocked), /edited since/);
        const [c] = await refreshLeadActionCards(fakeDb([lead('approved')]), 1, 2, [{ uiElement: ui }]);
        assert.strictEqual((c.uiElement as Record<string, unknown>).settled, undefined);
    });

    console.log('\nThe send gate on the server');

    await check('sendableDraft resolves the recipient and truncates exactly as send_outreach does', () => {
        const d = sendableDraft({ outreachDraft: { subject: '', body: '  Hi  ' }, contactEmail: ' x@y.test ' }, 'Acme');
        assert.deepStrictEqual(d, { to: 'x@y.test', subject: 'Quick note for Acme', body: 'Hi' });
    });
    await check('send_outreach refuses a changed draft, and a check-only call sends nothing', () => {
        const lg = read('netlify/functions/lead-generation.ts');
        const fn = lg.slice(lg.indexOf("if (action === 'send_outreach')"), lg.indexOf("if (action === 'outreach_readiness')"));
        assert.match(fn, /outreachDraftFingerprint\(recipient, storedSubject, storedBody\) !== body\.expectDraftHash/);
        assert.match(fn, /reason: 'draft_changed'/);
        const checkOnly = fn.indexOf('if (body.checkOnly === true)');
        assert.ok(checkOnly > fn.indexOf("reason: 'task_limit'"), 'check-only must come after every gate');
        assert.ok(checkOnly < fn.indexOf('openLeadThread('), 'check-only must return before anything is minted or sent');
        assert.ok(checkOnly < fn.indexOf('anthropic.messages.create'), 'check-only must return before a draft is generated');
    });

    console.log('\nWiring');

    await check('the lead route resolves the proposal from the session\'s own assistant', () => {
        const o = read('netlify/functions/chat-orchestrator.ts');
        assert.match(o, /leadAction = await resolveLeadActionProposal\(db, orgId, session\.aiAssistantId, leadActionReq\);/);
        assert.match(o, /route === ROUTES\.lead_qualifier \? leadActionFromUiElement\(uiElement\)/);
        assert.match(o, /"type": "lead_action_proposal"/);
        assert.match(o, /Do NOT restate, summarise or rewrite the email in your reply/);
    });
    await check('the lead list the chat reads names each lead by its id', () => {
        assert.match(read('netlify/functions/chat-orchestrator.ts'), /return `- #\$\{n\.id\} \$\{n\.title\}/);
    });
    await check('the click checks every gate first, then approves through assistant-records, then sends with the fingerprint', () => {
        const session = read('src/components/chat-session.js');
        const handler = session.slice(session.indexOf('async function onLeadAction('), session.indexOf('// Mystery Shopper cards'));
        const checkAt = handler.indexOf('checkOnly: true');
        const approveAt = handler.indexOf("approvalStatus: 'approved'");
        const sendAt = handler.indexOf("postActionCall('lead-generation', sendBody)");
        assert.ok(checkAt > 0 && approveAt > checkAt && sendAt > approveAt, 'order must be: check, approve, send');
        assert.match(handler, /expectDraftHash: d\.draftHash/);
        assert.match(handler, /dataMerge: \{ outreachStage: 'review' \}/);
        assert.ok(!/override_do_not_contact/.test(handler), 'the do-not-contact override stays on the Outreach tab');
        assert.match(read('src/components/disruptive-ui-registry.js'), /register\('lead_action_proposal', renderLeadActionProposalCard\);/);
    });
    await check('assistant-records merges dataMerge onto the stored data, never replacing it', () => {
        const ar = read('netlify/functions/assistant-records.ts');
        assert.match(ar, /const merged = \{ \.\.\.base, \.\.\.\(body\.dataMerge as Record<string, unknown>\) \};/);
    });
    await check('reopening a conversation re-checks lead cards too', () => {
        assert.match(read('netlify/functions/get-chat-session.ts'), /messages: await refreshSettingsCards\(db, orgId, session\.aiAssistantId, session\.roleKey, await refreshAudienceCards\(db, orgId,\s*await refreshLeadActionCards\(db, orgId, session\.aiAssistantId,/);
    });

    console.log(`\n${passed}/${total} checks passed`);
    if (passed !== total) process.exit(1);
}

main();
