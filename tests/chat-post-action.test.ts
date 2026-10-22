// tests/chat-post-action.test.ts
// The Social Media chat can approve, reject, retry and reschedule an EXISTING post — by proposing a
// card the user confirms, which calls the same endpoints as the Posts tab.
//
// WHY THIS EXISTS. Every capability is meant to be reachable from the GUI and from chat through one
// server action. The chat could draft posts and read its queue, but refused to act on any of it, so
// "approve Thursday's post" got directions to the Posts tab. These pin the three things that make
// the chat path safe: the model's proposal is checked against the database and rebuilt from rows
// (it can only name this assistant's posts, and only for an action that post's state allows); the
// card acts only on a click; and the click goes through the Posts tab's own endpoints.
//
// Run:  npx tsx tests/chat-post-action.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { postActionFromUiElement, refreshPostActionCards, resolvePostActionProposal } from '../src/utils/chat-post-action';
import { renderContentSnapshot } from '../src/utils/content-snapshot';

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

async function main() {
    console.log('\nThe model\'s proposal is shape-checked');

    await check('a well-formed proposal is read, "#" and all', () => {
        const r = postActionFromUiElement({ type: 'post_action_proposal', action: 'approve', postId: '#42' });
        assert.deepStrictEqual(r, { action: 'approve', postId: 42, reason: null, when: null });
    });

    await check('an unknown action, a missing id, or a reschedule with no time is not a proposal', () => {
        assert.strictEqual(postActionFromUiElement({ type: 'post_action_proposal', action: 'publish_now', postId: 1 }), null);
        assert.strictEqual(postActionFromUiElement({ type: 'post_action_proposal', action: 'approve' }), null);
        assert.strictEqual(postActionFromUiElement({ type: 'post_action_proposal', action: 'reschedule', postId: 1 }), null);
        assert.strictEqual(postActionFromUiElement({ type: 'social_post_draft', caption: 'x' }), null);
    });

    await check('reason rides only on reject, and the time only on reschedule', () => {
        const r = postActionFromUiElement({ type: 'post_action_proposal', action: 'approve', postId: 3, reason: 'meh', when: 'tomorrow' });
        assert.strictEqual(r?.reason, null);
        assert.strictEqual(r?.when, null);
        const m = postActionFromUiElement({ type: 'post_action_proposal', action: 'reschedule', postId: 3, when: 'next Friday at 3pm' });
        assert.strictEqual(m?.when, 'next Friday at 3pm');
    });

    console.log('\nThe card is rebuilt from rows, never from the model');

    await check('a post that is not this assistant\'s gives no card at all', async () => {
        const card = await resolvePostActionProposal(fakeDb([]), 1, 2, { action: 'approve', postId: 9, reason: null, when: null });
        assert.strictEqual(card, null);
    });

    await check('a cross-post is acted on as one post: every row the action applies to, named row first', async () => {
        const post = { id: 11, status: 'pending_approval', platform: 'linkedin', publishDate: new Date('2026-10-23T09:00:00Z'), caption: 'Real caption', crosspostGroupId: 'g1' };
        const group = [
            { id: 10, status: 'pending_approval', platform: 'facebook' },
            { id: 11, status: 'pending_approval', platform: 'linkedin' },
            { id: 12, status: 'published', platform: 'instagram' },
        ];
        const card = await resolvePostActionProposal(fakeDb([post], group), 1, 2, { action: 'approve', postId: 11, reason: null, when: null }, 'Europe/London');
        assert.ok(card);
        assert.deepStrictEqual(card!.postIds, [11, 10], 'a published sibling cannot be approved and must not be sent');
        assert.strictEqual(card!.postId, 11);
        assert.strictEqual(card!.text, 'Real caption', 'the wording comes from the row');
        assert.strictEqual(card!.blocked, null);
    });

    await check('an action the post\'s state does not allow is shown as blocked, with no rows to act on', async () => {
        const post = { id: 5, status: 'scheduled', platform: 'linkedin', publishDate: new Date(), caption: 'x', crosspostGroupId: null };
        const card = await resolvePostActionProposal(fakeDb([post]), 1, 2, { action: 'retry', postId: 5, reason: null, when: null });
        assert.ok(card?.blocked, 'retry on a scheduled post must be refused on the card');
        assert.deepStrictEqual(card!.postIds, []);
    });

    await check('a database failure gives no card rather than a guess', async () => {
        const db = { select: () => { throw new Error('boom'); } } as any;
        assert.strictEqual(await resolvePostActionProposal(db, 1, 2, { action: 'approve', postId: 1, reason: null, when: null }), null);
    });

    console.log('\nThe chat can name the post');

    await check('the post list shows each post\'s number', () => {
        const text = renderContentSnapshot({
            noun: 'posts', tab: 'Posts', stateWords: {},
            sections: [{ title: 'Review', total: 1, items: [{ ref: 77, when: null, where: 'LinkedIn', status: 'pending_approval', text: 'Hello' }] }],
        });
        assert.match(text, /- #77 · no date yet · LinkedIn/);
        assert.match(read('src/utils/content-snapshot.ts'), /ref: r\.id, when: r\.publishDate/, 'buildPostsSnapshot must pass the id through');
    });

    console.log('\nOnly the user\'s click acts, through the Posts tab\'s own endpoints');

    await check('the orchestrator resolves the proposal and the prompt describes it', () => {
        const o = read('netlify/functions/chat-orchestrator.ts');
        assert.match(o, /postAction = await resolvePostActionProposal\(db, orgId, session\.aiAssistantId, postActionReq, snapshotTz\);\s*uiElement = postAction;/);
        assert.match(o, /"type": "post_action_proposal"/);
        assert.match(o, /route === ROUTES\.social_media_manager && !postActionReq && !profileCard && replyClaimsPostSaved\(content\)/,
            'a post-action reply describes a card; the unbacked-draft guard must not replace it');
    });

    await check('the card is registered and acts only on a click', () => {
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.match(reg, /register\('post_action_proposal', renderPostActionProposalCard\);/);
        const card = reg.slice(reg.indexOf('function renderPostActionProposalCard('), reg.indexOf("register('post_action_proposal'"));
        assert.match(card, /el\.addEventListener\('click'/);
        assert.match(card, /new CustomEvent\('post:action'/);
        assert.doesNotMatch(card, /fetch\(/, 'the card dispatches; it never calls a server itself');
    });

    await check('the handler calls the endpoints the Posts tab calls', () => {
        const cs = read('src/components/chat-session.js');
        assert.match(cs, /container\.addEventListener\('post:action', onPostAction\);/);
        const h = cs.slice(cs.indexOf('async function onPostAction('), cs.indexOf('// Mystery Shopper cards'));
        for (const fn of ['approve-post', 'reject-post', 'retry-failed-post', 'reschedule-post-chat']) {
            assert.ok(h.includes(`'${fn}'`), `${fn} must be the endpoint used`);
        }
        assert.doesNotMatch(h, /acknowledgeWarnings/, 'compliance warnings are settled on the post, never waved through from chat');
        assert.doesNotMatch(h, /publish_now/, 'chat never publishes immediately');
    });

    console.log('\nReopening a conversation');

    await check('a stored card whose post was dealt with says so, with no button', async () => {
        const post = { id: 5, status: 'scheduled', platform: 'linkedin', publishDate: new Date(), caption: 'x', crosspostGroupId: null };
        const [m] = await refreshPostActionCards(fakeDb([post]), 1, 2, [
            { uiElement: { type: 'post_action_proposal', action: 'approve', postId: 5, postIds: [5] } },
        ]);
        const ui = m.uiElement as Record<string, unknown>;
        assert.strictEqual(ui.settled, true);
        assert.match(String(ui.blocked), /Already dealt with — this post is now booked to publish\./);
        assert.deepStrictEqual(ui.postIds, []);
    });

    await check('a stored card that still applies stays live, and other messages pass through untouched', async () => {
        const post = { id: 5, status: 'pending_approval', platform: 'linkedin', publishDate: new Date(), caption: 'x', crosspostGroupId: null };
        const plain = { uiElement: null, content: 'hi' };
        const out = await refreshPostActionCards(fakeDb([post]), 1, 2, [
            plain, { uiElement: { type: 'post_action_proposal', action: 'approve', postId: 5 } },
        ]);
        assert.strictEqual(out[0], plain);
        assert.strictEqual((out[1].uiElement as any).blocked, null);
        assert.ok(read('src/utils/chat-card-refresh.ts').includes('await refreshPostActionCards(db, organisationId, aiAssistantId, messages)'));
        assert.ok(read('netlify/functions/get-chat-session.ts').includes('refreshStoredCards(db, orgId, session.aiAssistantId, session.roleKey, messages)'));
    });

    console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
    if (passed !== total) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
