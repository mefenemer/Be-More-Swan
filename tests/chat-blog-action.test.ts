// tests/chat-blog-action.test.ts
// The Blog Writer chat can approve, book, unschedule and reject an EXISTING article — by proposing a
// card the user confirms, which calls the same endpoints as Blog Studio.
//
// WHY THIS EXISTS. Every capability is meant to be reachable from the GUI and from chat through one
// server action. The blog chat could write drafts and read its list, but was told "you cannot
// schedule or publish from this chat". These pin what makes the chat path safe: the proposal is
// checked against the database and rebuilt from rows (only this assistant's articles, only for an
// action the article's state allows); a spoken time is turned into an exact instant BEFORE the card
// is shown; the card acts only on a click; and the click goes through Blog Studio's endpoints.
//
// Run:  npx tsx tests/chat-blog-action.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { blogActionFromUiElement, refreshBlogActionCards, resolveBlogActionProposal } from '../src/utils/chat-blog-action';

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
const FRIDAY = new Date('2026-10-23T08:00:00Z');
const parseTo = (d: Date | null) => async () => d;
const neverParse = async () => { throw new Error('the parser must not be called'); };
const article = (status: string, extra: Record<string, unknown> = {}) => ({ id: 7, status, title: '  Five ways   to cut admin ', publishDate: null, ...extra });

async function main() {
    console.log('\nThe model\'s proposal is shape-checked');

    await check('a well-formed proposal is read, "#7" included', () => {
        assert.deepStrictEqual(
            blogActionFromUiElement({ type: 'blog_action_proposal', action: 'approve', postId: '#7' }),
            { action: 'approve', postId: 7, reason: null, when: null });
    });
    await check('publishing at once is not an action the chat has, and a schedule needs a time', () => {
        assert.strictEqual(blogActionFromUiElement({ type: 'blog_action_proposal', action: 'publish', postId: 7 }), null);
        assert.strictEqual(blogActionFromUiElement({ type: 'blog_action_proposal', action: 'schedule', postId: 7 }), null);
        assert.strictEqual(blogActionFromUiElement({ type: 'blog_action_proposal', action: 'approve' }), null);
        assert.strictEqual(blogActionFromUiElement({ type: 'post_action_proposal', action: 'approve', postId: 7 }), null);
    });
    await check('reason and time only ride on the action that uses them', () => {
        const r = blogActionFromUiElement({ type: 'blog_action_proposal', action: 'approve', postId: 7, reason: 'meh', when: 'Friday' });
        assert.strictEqual(r?.reason, null);
        assert.strictEqual(r?.when, null);
    });

    console.log('\nThe card is built from the row, not the model');

    await check('an article that is not this assistant\'s gives no card at all', async () => {
        assert.strictEqual(await resolveBlogActionProposal(fakeDb([]), 1, 2, { action: 'approve', postId: 7, reason: null, when: null }, null, neverParse, NOW), null);
    });
    await check('approve: the title comes from the row, tidied', async () => {
        const card = await resolveBlogActionProposal(fakeDb([article('pending_approval')]), 1, 2,
            { action: 'approve', postId: 7, reason: null, when: null }, 'Europe/London', neverParse, NOW);
        assert.strictEqual(card?.title, 'Five ways to cut admin');
        assert.strictEqual(card?.blocked, null);
        assert.strictEqual(card?.timezone, 'Europe/London');
    });
    await check('an action the article\'s state does not allow says so and offers nothing', async () => {
        const live = await resolveBlogActionProposal(fakeDb([article('published')]), 1, 2,
            { action: 'reject', postId: 7, reason: 'x', when: null }, null, neverParse, NOW);
        assert.match(String(live?.blocked), /already gone out/);
        const draft = await resolveBlogActionProposal(fakeDb([article('draft')]), 1, 2,
            { action: 'unschedule', postId: 7, reason: null, when: null }, null, neverParse, NOW);
        assert.match(String(draft?.blocked), /isn’t booked/);
    });
    await check('schedule: the spoken time becomes an exact instant on the card, before any click', async () => {
        const card = await resolveBlogActionProposal(fakeDb([article('draft')]), 1, 2,
            { action: 'schedule', postId: 7, reason: null, when: 'Friday at 9am' }, 'Europe/London', parseTo(FRIDAY), NOW);
        assert.strictEqual(card?.scheduleAt, FRIDAY.toISOString());
        assert.strictEqual(card?.blocked, null);
    });
    await check('schedule: a time that cannot be read, or has passed, blocks the card', async () => {
        const vague = await resolveBlogActionProposal(fakeDb([article('draft')]), 1, 2,
            { action: 'schedule', postId: 7, reason: null, when: 'soonish' }, null, parseTo(null), NOW);
        assert.match(String(vague?.blocked), /couldn’t work out a time/);
        assert.strictEqual(vague?.scheduleAt, null);
        const past = await resolveBlogActionProposal(fakeDb([article('draft')]), 1, 2,
            { action: 'schedule', postId: 7, reason: null, when: 'yesterday' }, null, parseTo(new Date('2026-10-20T09:00:00Z')), NOW);
        assert.match(String(past?.blocked), /already passed/);
    });
    await check('schedule on an article that cannot move never asks the parser', async () => {
        const card = await resolveBlogActionProposal(fakeDb([article('publishing')]), 1, 2,
            { action: 'schedule', postId: 7, reason: null, when: 'Friday' }, null, neverParse, NOW);
        assert.ok(card?.blocked);
    });

    console.log('\nA stored card is re-checked when the conversation reopens');

    await check('one already acted on says what happened instead of offering a button', async () => {
        const [m] = await refreshBlogActionCards(fakeDb([{ id: 7, status: 'scheduled' }]), 1, 2, [
            { uiElement: { type: 'blog_action_proposal', action: 'approve', postId: 7 } },
        ], NOW);
        const ui = m.uiElement as Record<string, unknown>;
        assert.strictEqual(ui.settled, true);
        assert.match(String(ui.blocked), /booked to publish/);
    });
    await check('a booked time that has since passed is closed, never silently moved', async () => {
        const [m] = await refreshBlogActionCards(fakeDb([{ id: 7, status: 'draft' }]), 1, 2, [
            { uiElement: { type: 'blog_action_proposal', action: 'schedule', postId: 7, when: 'Friday', scheduleAt: '2026-10-20T09:00:00Z' } },
        ], NOW);
        assert.strictEqual((m.uiElement as Record<string, unknown>).settled, true);
    });
    await check('other messages pass through untouched', async () => {
        const plain = { uiElement: null, content: 'hi' };
        const [m] = await refreshBlogActionCards(fakeDb(), 1, 2, [plain], NOW);
        assert.strictEqual(m, plain);
    });

    console.log('\nWiring');

    const o = read('netlify/functions/chat-orchestrator.ts');
    await check('the blog route resolves the proposal with the real time parser, and keeps the card', () => {
        assert.match(o, /blogAction = await resolveBlogActionProposal\(db, orgId, session\.aiAssistantId, blogActionReq, snapshotTz, parseScheduleInstruction\);/);
        assert.match(o, /uiElement = blogDraft \? \{ type: BLOG_POST_DRAFT_TYPE, \.\.\.blogDraft \} : blogAction \?\? settingsCard;/);
        assert.match(o, /"type": "blog_action_proposal"/);
        assert.ok(!o.includes('you cannot schedule or publish from this chat'), 'the old refusal is still in the blog prompt');
    });
    await check('the blog list the chat reads names each article by its id', () => {
        const snap = read('src/utils/content-snapshot.ts');
        assert.match(snap, /const map = \(r: Row\): SnapshotItem => \(\{ ref: r\.id, when: r\.publishedAt \?\? r\.publishDate/);
    });
    await check('the card acts only on a click, through Blog Studio\'s endpoints', () => {
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.match(reg, /register\('blog_action_proposal', renderBlogActionProposalCard\);/);
        const card = reg.slice(reg.indexOf('function renderBlogActionProposalCard('), reg.indexOf("register('blog_action_proposal'"));
        assert.match(card, /new CustomEvent\('blog:action'/);
        const session = read('src/components/chat-session.js');
        const handler = session.slice(session.indexOf('async function onBlogAction('), session.indexOf('// Mystery Shopper cards'));
        assert.match(handler, /postActionCall\('schedule-blog', \{ id: d\.postId, action: 'approve' \}\)/);
        assert.match(handler, /postActionCall\('schedule-blog', \{ id: d\.postId, publishDate: d\.scheduleAt \}\)/);
        assert.match(handler, /postActionCall\('schedule-blog', \{ id: d\.postId, action: 'unschedule' \}\)/);
        assert.match(handler, /postActionCall\('reject-blog-post', \{ id: d\.postId, feedbackText: d\.reason/);
        assert.ok(!/publish-blog'/.test(handler), 'the chat must never publish an article immediately');
        assert.match(session, /container\.addEventListener\('blog:action', onBlogAction\);/);
    });
    await check('reopening a conversation re-checks blog cards too', () => {
        assert.match(read('netlify/functions/get-chat-session.ts'), /await refreshBlogActionCards\(db, orgId, session\.aiAssistantId,/);
    });

    console.log(`\n${passed}/${total} checks passed`);
    if (passed !== total) process.exit(1);
}

main();
