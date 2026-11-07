// tests/restore-post.test.ts
// "Bring back" a removed or rejected post (src/utils/restore-post.ts).
//
// WHY THIS EXISTS. Removing and rejecting both send a post to Archived, and nothing could bring it
// out again: the editor showed it read-only and the chat refused (reported 2026-11-07, "I can't
// uncancel a cancelled post"). These pin: only archived rows come back, to Review (never straight to
// Scheduled); the whole cross-post comes back but a published sibling is left alone; someone else's
// post is not found; the media deletion clock that rejecting started is stopped; and the editor and
// the chat both reach the same endpoint.
//
// Run:  npx tsx tests/restore-post.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { restorePosts, RESTORED_STATUS } from '../src/utils/restore-post';
import { postActionFromUiElement, resolvePostActionProposal } from '../src/utils/chat-post-action';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

/**
 * A db whose select() calls answer in order, and which records every update(): the values set and
 * the ids it was aimed at (the restore's id list is the only inArray it is given for posts).
 */
function fakeDb(selects: unknown[][], updateReturns: unknown[][] = []) {
    const queue = [...selects];
    const returns = [...updateReturns];
    const updates: { set: Record<string, unknown> }[] = [];
    const chainOf = (rows: unknown) => {
        const chain: any = {
            from: () => chain, where: () => chain, limit: () => Promise.resolve(rows),
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
        };
        return chain;
    };
    const db: any = {
        select: () => chainOf(queue.shift() ?? []),
        update: () => ({
            set: (set: Record<string, unknown>) => {
                updates.push({ set });
                const rows = returns.shift() ?? [];
                const w: any = { where: () => w, returning: () => Promise.resolve(rows), then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
                return w;
            },
        }),
    };
    return { db, updates };
}

const post = (over: Record<string, unknown> = {}) => ({
    id: 7, status: 'cancelled', organisationId: 1, userId: 3, assistantId: 9, crosspostGroupId: null, ...over,
});

async function main() {
    console.log('\nWhat can be brought back');

    await check('a removed post goes back to Review — not to Scheduled — with its archive stamps cleared', async () => {
        // post, assistant, (no group), junction assets, legacy asset column
        const { db, updates } = fakeDb([[post()], [{ lifecycleStatus: 'active' }], [], [{ ids: [] }]], [[{ id: 7 }]]);
        const r = await restorePosts(db, { postId: 7, organisationId: 1, userId: 3 });
        assert.deepStrictEqual(r, { ok: true, restoredIds: [7], mediaGone: false });
        assert.strictEqual(RESTORED_STATUS, 'pending_approval');
        assert.strictEqual(updates[0].set.status, 'pending_approval');
        assert.strictEqual(updates[0].set.cancelledAt, null);
        assert.strictEqual(updates[0].set.rejectedAt, null);
    });

    await check('a post that is live, scheduled or waiting is refused', async () => {
        for (const status of ['published', 'scheduled', 'pending_approval', 'publishing']) {
            const { db, updates } = fakeDb([[post({ status })]]);
            const r = await restorePosts(db, { postId: 7, organisationId: 1, userId: 3 });
            assert.ok(!r.ok && r.status === 409, status);
            assert.strictEqual(updates.length, 0);
        }
    });

    await check('another workspace’s post is not found, and nothing is written', async () => {
        const { db, updates } = fakeDb([[post({ organisationId: 2, userId: 99 })]]);
        const r = await restorePosts(db, { postId: 7, organisationId: 1, userId: 3 });
        assert.ok(!r.ok && r.status === 404);
        assert.strictEqual(updates.length, 0);
    });

    await check('an archived assistant’s post is refused with the way forward', async () => {
        const { db } = fakeDb([[post()], [{ lifecycleStatus: 'archived' }]]);
        const r = await restorePosts(db, { postId: 7, organisationId: 1, userId: 3 });
        assert.ok(!r.ok && /Bring the assistant back first/.test(r.error));
    });

    console.log('\nThe whole cross-post, and its media');

    await check('the group’s archived rows come back together; a published sibling is not touched', async () => {
        const grouped = post({ status: 'rejected', crosspostGroupId: 'g1' });
        const { db } = fakeDb(
            [[grouped], [{ lifecycleStatus: 'active' }],
             [{ id: 7, status: 'rejected' }, { id: 8, status: 'rejected' }, { id: 10, status: 'published' }],
             [], [{ ids: [] }]],
            [[{ id: 7 }, { id: 8 }]],
        );
        const r = await restorePosts(db, { postId: 7, organisationId: 1, userId: 3 });
        assert.ok(r.ok);
        assert.deepStrictEqual(r.ok && r.restoredIds, [7, 8]);
    });

    await check('rejecting’s media deletion clock is stopped; bytes already gone flag the post', async () => {
        const { db, updates } = fakeDb(
            [[post({ status: 'rejected' })], [{ lifecycleStatus: 'active' }],
             [{ assetId: 50 }], [{ ids: [51] }],   // junction + legacy column
             [{ id: 51 }]],                         // 51's bytes were purged
            [[{ id: 7 }]],
        );
        const r = await restorePosts(db, { postId: 7, organisationId: 1, userId: 3 });
        assert.deepStrictEqual(r, { ok: true, restoredIds: [7], mediaGone: true });
        const assetUpdate = updates[1].set;
        assert.strictEqual(assetUpdate.status, 'pending');
        assert.strictEqual(assetUpdate.retentionDeleteAfter, null);
        assert.strictEqual(updates[2].set.mediaMissing, true);
    });

    await check('only assets the release started are un-released — never a moderation reject', () => {
        const src = read('src/utils/restore-post.ts');
        assert.ok(src.includes('isNull(contentAssets.rejectionReason)'));
        assert.ok(src.includes('isNull(contentAssets.purgedAt)'));
    });

    console.log('\nGUI and chat reach the same endpoint');

    await check('the post editor offers Bring back on removed and rejected posts', () => {
        const html = read('workspace.html');
        assert.ok(html.includes(`if (post.status === 'rejected' || post.status === 'cancelled') {`));
        assert.ok(html.includes('onclick="rqReviewRestorePost()"'));
        assert.ok(/async function rqReviewRestorePost\(\)[\s\S]{0,800}\/\.netlify\/functions\/restore-post/.test(html));
        // The cached rows are updated, not dropped: a cold reopen fetches only the newest 50 waiting
        // posts, so an old post brought back couldn't be reopened (staging #26, 2026-11-07).
        const fn = html.slice(html.indexOf('async function rqReviewRestorePost()'), html.indexOf('window.rqReviewRestorePost = rqReviewRestorePost;'));
        assert.ok(fn.includes(`Object.assign(row, { status: 'pending_approval'`));
        assert.ok(!fn.includes('delete _rqPostCache'));
        // Remove no longer says it can't be undone.
        assert.ok(!html.includes('This cannot be undone from here.'));
    });

    await check('the chat can propose restore, only for an archived post', async () => {
        const req = postActionFromUiElement({ type: 'post_action_proposal', action: 'restore', postId: '#7' });
        assert.deepStrictEqual(req, { action: 'restore', postId: 7, reason: null, when: null });
        const row = { id: 7, status: 'cancelled', platform: 'instagram', publishDate: new Date(), caption: 'Hello', crosspostGroupId: null, audioOverlays: [], imageOverlays: [] };
        const { db } = fakeDb([[row]]);
        const card = await resolvePostActionProposal(db, 1, 9, req!);
        assert.ok(card && !card.blocked && card.postIds[0] === 7);
        const live = fakeDb([[{ ...row, status: 'scheduled' }]]).db;
        const refused = await resolvePostActionProposal(live, 1, 9, req!);
        assert.ok(refused && refused.blocked && refused.postIds.length === 0);
    });

    await check('the chat card, its click and the prompt are wired to restore-post', () => {
        assert.ok(read('src/components/disruptive-ui-registry.js').includes(`restore: { head: 'Bring this post back'`));
        assert.ok(read('src/components/chat-session.js').includes(`postActionCall('restore-post', { postId: d.postId })`));
        const orch = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(orch.includes('(action "restore"'));
        assert.ok(orch.includes('"remove" | "restore" |'));
        // The chat can see what it can bring back.
        assert.ok(read('src/utils/content-snapshot.ts').includes('In the "Archived" column — removed or rejected'));
    });

    console.log(`\n${passed} of ${total} passed\n`);
    if (passed !== total) process.exit(1);
}

main();
