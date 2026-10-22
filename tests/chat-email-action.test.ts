// tests/chat-email-action.test.ts
// The Email Marketing chat can approve, approve-for-a-time and send back an EXISTING single email —
// by proposing a card the user confirms, which calls the Email Studio's own endpoint.
//
// WHY THIS EXISTS. Every capability is meant to be reachable from the GUI and from chat through one
// server action. The email chat could write emails and read its list, but was told it could not
// approve or schedule any. These pin what makes the chat path safe: the proposal is rebuilt from the
// newsletter_issues row (only this assistant's emails, only for an action the state allows); a
// spoken time becomes an exact instant BEFORE the card is shown; and the click goes through
// newsletter-issues — never its `send`.
//
// Run:  npx tsx tests/chat-email-action.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { emailActionFromUiElement, refreshEmailActionCards, resolveEmailActionProposal } from '../src/utils/chat-email-action';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

/** A db whose successive select() calls answer with the given row lists, in order. */
function fakeDb(...answers: unknown[][]) {
    const queue = [...answers];
    return {
        select: () => {
            const rows = queue.shift() ?? [];
            const chain: any = {
                from: () => chain,
                where: () => chain,
                limit: () => Promise.resolve(rows),
                then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
            };
            return chain;
        },
    } as any;
}

const NOW = new Date('2026-10-21T10:00:00Z');
const TUESDAY = new Date('2026-10-27T10:00:00Z');
const parseTo = (d: Date | null) => async () => d;
const neverParse = async () => { throw new Error('the parser must not be called'); };
const email = (status: string) => ({ id: 9, status, subject: ' October   offers ', scheduledFor: null });

async function main() {
    console.log('\nThe model\'s proposal is shape-checked');

    await check('a well-formed proposal is read, "#9" included', () => {
        assert.deepStrictEqual(emailActionFromUiElement({ type: 'email_action_proposal', action: 'approve', issueId: '#9' }),
            { action: 'approve', issueId: 9, when: null });
    });
    await check('sending now is not an action the chat has, and a schedule needs a time', () => {
        assert.strictEqual(emailActionFromUiElement({ type: 'email_action_proposal', action: 'send', issueId: 9 }), null);
        assert.strictEqual(emailActionFromUiElement({ type: 'email_action_proposal', action: 'schedule', issueId: 9 }), null);
        assert.strictEqual(emailActionFromUiElement({ type: 'blog_action_proposal', action: 'approve', postId: 9 }), null);
    });

    console.log('\nThe card is built from the row, not the model');

    await check('an email that is not this assistant\'s gives no card', async () => {
        assert.strictEqual(await resolveEmailActionProposal(fakeDb([]), 1, 2, { action: 'approve', issueId: 9, when: null }, null, neverParse, NOW), null);
    });
    await check('approve: the subject comes from the row, tidied; a sent email is blocked', async () => {
        const ok = await resolveEmailActionProposal(fakeDb([email('pending_approval')]), 1, 2, { action: 'approve', issueId: 9, when: null }, null, neverParse, NOW);
        assert.strictEqual(ok?.subject, 'October offers');
        assert.strictEqual(ok?.blocked, null);
        const sent = await resolveEmailActionProposal(fakeDb([email('sent')]), 1, 2, { action: 'schedule', issueId: 9, when: 'Tuesday' }, null, neverParse, NOW);
        assert.ok(sent?.blocked);
    });
    await check('a failed send can\'t be re-booked from chat (it may have reached part of the list)', async () => {
        const card = await resolveEmailActionProposal(fakeDb([email('failed')]), 1, 2, { action: 'schedule', issueId: 9, when: 'Tuesday' }, null, neverParse, NOW);
        assert.ok(card?.blocked);
    });
    await check('schedule: the spoken time becomes an exact instant before any click', async () => {
        const card = await resolveEmailActionProposal(fakeDb([email('approved')]), 1, 2, { action: 'schedule', issueId: 9, when: 'Tuesday at 10am' }, 'Europe/London', parseTo(TUESDAY), NOW);
        assert.strictEqual(card?.scheduleAt, TUESDAY.toISOString());
    });
    await check('schedule: an unreadable or past time blocks the card', async () => {
        const vague = await resolveEmailActionProposal(fakeDb([email('draft')]), 1, 2, { action: 'schedule', issueId: 9, when: 'whenever' }, null, parseTo(null), NOW);
        assert.match(String(vague?.blocked), /couldn’t work out a time/);
        const past = await resolveEmailActionProposal(fakeDb([email('draft')]), 1, 2, { action: 'schedule', issueId: 9, when: 'yesterday' }, null, parseTo(new Date('2026-10-20T10:00:00Z')), NOW);
        assert.match(String(past?.blocked), /already passed/);
    });
    await check('send back: nothing to send back from a draft', async () => {
        const card = await resolveEmailActionProposal(fakeDb([email('draft')]), 1, 2, { action: 'reject', issueId: 9, when: null }, null, neverParse, NOW);
        assert.ok(card?.blocked);
    });

    console.log('\nA stored card is re-checked when the conversation reopens');

    await check('one already acted on says so; a passed time closes the card', async () => {
        const [a] = await refreshEmailActionCards(fakeDb([{ id: 9, status: 'sent' }]), 1, 2, [
            { uiElement: { type: 'email_action_proposal', action: 'approve', issueId: 9 } }], NOW);
        assert.strictEqual((a.uiElement as Record<string, unknown>).settled, true);
        const [b] = await refreshEmailActionCards(fakeDb([{ id: 9, status: 'approved' }]), 1, 2, [
            { uiElement: { type: 'email_action_proposal', action: 'schedule', issueId: 9, when: 'x', scheduleAt: '2026-10-20T09:00:00Z' } }], NOW);
        assert.strictEqual((b.uiElement as Record<string, unknown>).settled, true);
    });

    console.log('\nWiring');

    await check('the email route resolves the proposal with the real parser, and keeps the card', () => {
        const o = read('netlify/functions/chat-orchestrator.ts');
        assert.match(o, /emailAction = await resolveEmailActionProposal\(db, orgId, session\.aiAssistantId, emailActionReq, snapshotTz, parseScheduleInstruction\);/);
        assert.match(o, /: formDraft \? \{ type: AUDIENCE_FORM_DRAFT_TYPE, \.\.\.formDraft \}\s*\/\/[^\n]*\n\s*: emailAction;/);
        assert.match(o, /"type": "email_action_proposal"/);
    });
    await check('the email list the chat reads names each email by its id', () => {
        assert.match(read('src/utils/content-snapshot.ts'), /ref: r\.id, when: r\.sentAt \?\? r\.scheduledFor/);
    });
    await check('the click goes through newsletter-issues approve / reject — never send', () => {
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.match(reg, /register\('email_action_proposal', renderEmailActionProposalCard\);/);
        const session = read('src/components/chat-session.js');
        const handler = session.slice(session.indexOf('async function onEmailAction('), session.indexOf('// Lead action cards'));
        assert.match(handler, /postActionCall\('newsletter-issues', \{ action: 'approve', id: d\.issueId \}\)/);
        assert.match(handler, /postActionCall\('newsletter-issues', \{ action: 'approve', id: d\.issueId, scheduledFor: d\.scheduleAt \}\)/);
        assert.match(handler, /postActionCall\('newsletter-issues', \{ action: 'reject', id: d\.issueId \}\)/);
        assert.ok(!/action: 'send'/.test(handler), 'the chat must never send an email immediately');
    });
    await check('reopening a conversation re-checks email cards too', () => {
        assert.match(read('netlify/functions/get-chat-session.ts'), /await refreshEmailActionCards\(db, orgId, session\.aiAssistantId,/);
    });

    console.log(`\n${passed}/${total} checks passed`);
    if (passed !== total) process.exit(1);
}

main();
