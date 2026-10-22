// tests/chat-reviews.test.ts
// The Email Marketing chat gets the Website Assistant's two review cards — reviews_add (save reviews
// the owner pasted, word for word) and review_decisions (approve or decline customer-sent ones).
//
// WHY THIS EXISTS. Reviews live on the Audience page both assistants share, but only the Website
// chat could add or approve them. The newsletter route keeps only cards it has rebuilt, so these pin
// the rebuild: pasted reviews go through org-reviews.ts's own rule (which refuses the WHOLE batch if
// one fails), so a bad one is left out and named rather than breaking the button; a decision survives
// only for a review waiting in this workspace; and the words are never changed.
//
// Run:  npx tsx tests/chat-reviews.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildReviewsBlock, checkReviewDecisions, checkReviewsAdd, resolveReviewsCard } from '../src/utils/chat-reviews';
import { REVIEW_LIMITS } from '../src/utils/reviews';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

/** Each select answers the next queued rows. */
function fakeDb(...answers: unknown[][]) {
    const queue = [...answers];
    return {
        select: () => {
            const rows = queue.shift() ?? [];
            const chain: any = {
                from: () => chain, where: () => chain, orderBy: () => chain, limit: () => Promise.resolve(rows),
                then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
            };
            return chain;
        },
    } as any;
}

const TODAY = new Date('2026-10-22T12:00:00Z');

async function main() {
    console.log('\nPasted reviews');

    await check('words are kept exactly; only spacing is tidied', () => {
        const card = checkReviewsAdd({ summary: 'Two from Google.', reviews: [
            { authorName: ' Sarah  K. ', rating: 5, body: 'Brilliant service!!  Would come back.\n\n\n\nThanks', source: 'google', reviewedOn: '2026-10-01' },
            { authorName: 'Tom', rating: null, body: 'ok i guess', source: 'facebook' },
        ] }, 10, TODAY);
        assert.strictEqual(card.reviews.length, 2);
        assert.strictEqual(card.reviews[0].authorName, 'Sarah K.');
        assert.strictEqual(card.reviews[0].body, 'Brilliant service!!  Would come back.\n\nThanks');
        assert.strictEqual(card.reviews[1].body, 'ok i guess', 'never corrected');
        assert.strictEqual(card.summary, 'Two from Google.');
    });

    await check('a review the endpoint would refuse is left out and named, so the button works', () => {
        const card = checkReviewsAdd({ summary: 'Three.', reviews: [
            { authorName: 'Ann', rating: 4, body: 'Lovely', source: 'google' },
            { authorName: '', rating: 5, body: 'No name', source: 'google' },
            { authorName: 'Bob', rating: 9, body: 'Too many stars', source: 'google' },
            { authorName: 'Cat', rating: 5, body: 'From the future', source: 'google', reviewedOn: '2027-01-01' },
        ] }, 0, TODAY);
        assert.deepStrictEqual(card.reviews.map((r) => r.authorName), ['Ann']);
        assert.ok(/Left out: review 2 .*review 3 .*review 4 /.test(card.summary), card.summary);
    });

    await check('the batch and workspace limits are the endpoint’s', () => {
        const many = Array.from({ length: REVIEW_LIMITS.batch + 5 }, (_, i) => ({ authorName: `P${i}`, body: 'Good', source: 'google' }));
        assert.strictEqual(checkReviewsAdd({ reviews: many }, 0, TODAY).reviews.length, REVIEW_LIMITS.batch);
        const nearlyFull = checkReviewsAdd({ reviews: many.slice(0, 3) }, REVIEW_LIMITS.perWorkspace - 1, TODAY);
        assert.strictEqual(nearlyFull.reviews.length, 1);
        assert.ok(nearlyFull.summary.includes('more than can be kept'));
    });

    console.log('\nWaiting reviews');

    await check('only reviews waiting in this workspace, and a decline only with a reason', () => {
        const card = checkReviewDecisions({ summary: 'Sort these.', decisions: [
            { reviewId: 1, decision: 'approve' },
            { reviewId: 2, decision: 'decline', reason: 'offensive' },
            { reviewId: 3, decision: 'decline', reason: null },
            { reviewId: 99, decision: 'approve' },
            { reviewId: 1, decision: 'decline', reason: 'offensive' },
        ] }, new Set([1, 2, 3]));
        assert.deepStrictEqual(card.decisions, [{ reviewId: 1, decision: 'approve', reason: null }, { reviewId: 2, decision: 'decline', reason: 'offensive' }]);
        assert.ok(card.summary.includes('3 left out'), card.summary);
    });

    await check('the card is rebuilt against the database', async () => {
        const card = await resolveReviewsCard(fakeDb([{ id: 7 }]), 1, { type: 'review_decisions', decisions: [{ reviewId: 7, decision: 'approve' }, { reviewId: 8, decision: 'approve' }] });
        assert.deepStrictEqual((card as any).decisions.map((d: any) => d.reviewId), [7]);
        assert.strictEqual(await resolveReviewsCard(fakeDb(), 1, { type: 'site_changes' }), null);
    });

    console.log('\nWhich chat, and the wiring');

    await check('the Email Marketing chat gets the block, worded for email; others do not', async () => {
        const block = (await buildReviewsBlock(fakeDb([], []), 1, 'newsletter_editor'))!;
        assert.ok(block.includes('"type":"reviews_add"') && block.includes('"type":"review_decisions"'));
        assert.ok(block.includes('there is none to quote') && !block.includes('reviews section needs them'), block);
        assert.ok(block.includes('WORD FOR WORD') && block.includes('UK law'));
        assert.strictEqual(await buildReviewsBlock(fakeDb(), 1, 'social_media_manager'), null);
    });

    await check('the newsletter route keeps a checked review card, and the clicks already exist', () => {
        const orch = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(orch.includes('emailAction ?? audienceCard ?? reviewsCard ?? profileCard'));
        assert.ok(orch.includes('resolveReviewsCard(db, orgId, uiElement)'));
        const session = read('src/components/chat-session.js');
        assert.ok(session.includes("addEventListener('site:reviewsAdd', onReviewsAdd)") && session.includes("addEventListener('site:reviewDecisions', onReviewDecisions)"));
        assert.ok(!read('src/components/disruptive-ui-registry.js').includes("'show it on your website'"), 'the decisions card must read right outside the Website chat');
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
