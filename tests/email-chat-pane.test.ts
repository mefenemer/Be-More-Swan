// tests/email-chat-pane.test.ts — the Email Studio's docked chat (owner 2026-11-05). The browser side is
// e2e/email-studio-chat.spec.ts, with the model and every function stubbed, so what only the server does
// is checked here.
//
// Run:  npx tsx tests/email-chat-pane.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { emailPartCardFromUiElement, isEmailPartType } from '../src/utils/chat-email-parts';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
const check = (n: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${n}`); } catch (e) { console.log(`  ✗ ${n}\n    ${(e as Error).message}`); process.exitCode = 1; } };

const chat = read('netlify/functions/chat-orchestrator.ts');

check('a change to one part is rebuilt: only its own fields, nothing without the part and the new words', () => {
    assert.deepStrictEqual(
        emailPartCardFromUiElement({ type: 'email_edit', issueId: '#31', part: 'subject', find: ' Old ', replace: ' New ', summary: ' Why ', extra: 'dropped' }),
        { type: 'email_edit', issueId: 31, part: 'subject', find: 'Old', replace: 'New', summary: 'Why' });
    assert.strictEqual((emailPartCardFromUiElement({ type: 'email_edit', issueId: 31, part: 'anything', find: 'a', replace: 'b' }) as { part: string }).part, 'block');
    assert.strictEqual(emailPartCardFromUiElement({ type: 'email_edit', issueId: 31, find: 'a', replace: '  ' }), null);
    assert.strictEqual(emailPartCardFromUiElement({ type: 'email_edit', issueId: 0, find: 'a', replace: 'b' }), null);
});

check('a subject stays subject-sized, whatever the model writes', () => {
    const card = emailPartCardFromUiElement({ type: 'email_edit', issueId: 31, part: 'subject', find: 'a', replace: 'x'.repeat(500) }) as { replace: string };
    assert.strictEqual(card.replace.length, 200);
});

check('a new block carries words only: never a link, whatever the model sends', () => {
    assert.deepStrictEqual(
        emailPartCardFromUiElement({ type: 'email_block_add', issueId: 31, kind: 'button', text: 'Order now', href: 'https://invented.example', summary: '' }),
        { type: 'email_block_add', issueId: 31, kind: 'button', text: 'Order now', summary: null });
    assert.strictEqual(emailPartCardFromUiElement({ type: 'email_block_add', issueId: 31, kind: 'image', text: 'x' }), null);
    assert.strictEqual(emailPartCardFromUiElement({ type: 'email_block_add', issueId: 31, kind: 'text', text: ' ' }), null);
});

check('the picture and whole-email cards', () => {
    assert.deepStrictEqual(emailPartCardFromUiElement({ type: 'email_picture', issueId: 31, url: 'x' }), { type: 'email_picture', issueId: 31 });
    assert.strictEqual(emailPartCardFromUiElement({ type: 'email_refine', issueId: 31, instruction: ' ' }), null);
    assert.ok(emailPartCardFromUiElement({ type: 'email_refine', issueId: 31, instruction: 'Shorter' }));
    assert.ok(isEmailPartType('email_refine') && !isEmailPartType('email_action_proposal'));
});

check('the cards reach the user: the email route rebuilds uiElement from a fixed list', () => {
    assert.ok(chat.includes('emailAction ?? emailPartCard ?? audienceCard'), 'the card is thrown away before it reaches the user');
    assert.ok(chat.includes('req && emailTarget && req.issueId === emailTarget.id ? req : null'), 'a card for an email that isn\'t the one open');
    assert.ok(chat.includes('eq(newsletterIssues.id, forIssueId), eq(newsletterIssues.organisationId, orgId)'), 'another workspace\'s email read into the prompt');
    assert.ok(chat.includes("!['sending', 'sent'].includes(issueRow.status ?? '')"), 'an email that has gone out treated as editable');
});

check('the words beside the cards stay honest', () => {
    assert.ok(chat.includes('!emailAction && !emailPartCard && !audienceCard'), 'the reply beside the card is replaced by an apology');
    assert.ok(chat.includes('(!!emailPartCard && uiElement === emailPartCard)'), 'the reply can claim the change is made');
    assert.ok(chat.includes('emailPartCard?.type === EMAIL_PICTURE_TYPE && replyClaimsPicture(content)'), 'the reply can say it is making a picture');
});

check('the model sees the email and is told to change it, not to write a new one', () => {
    assert.ok(chat.includes('THE EMAIL AS SAVED:'));
    assert.ok(chat.includes('a newsletter_issue_draft is only for when they ask for a separate new one'));
    assert.ok(chat.includes('never invent a URL'));
});

check('an action from a card can\'t approve the version before what is on screen', () => {
    assert.ok(read('src/components/chat-session.js').includes("'email:actionStarting'"));
    const studio = read('newsletter.js');
    assert.ok(studio.includes('if (chatFor(d)) d.ready = flushPending();'), 'unsaved words are left behind');
    assert.ok(studio.includes('if (chatFor(d)) { refreshList(); openIssue(d.issueId); }'), 'the page keeps showing the old status');
});

console.log(`\n${passed}/8 passed`);
