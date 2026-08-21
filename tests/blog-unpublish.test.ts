// tests/blog-unpublish.test.ts
// Locks the unpublish transition (netlify/functions/unpublish-blog.ts + unpublishBlogPost).
//
// The contract that matters: unpublish takes the NATIVE copy off the site WITHOUT destroying the
// state republish depends on. If a future edit starts clearing slug/publishedPayload/publishedAt,
// republishing silently changes the post's URL or back-dates it — these tests fail first.
// Run:  npx tsx tests/blog-unpublish.test.ts

import assert from 'node:assert';
import { unpublishBlogPost } from '../src/utils/blog-publish';
import { stillLiveTargets } from '../netlify/functions/unpublish-blog';

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const done = () => { console.log(`  ✓ ${name}`); passed++; };
    const out = fn();
    return out instanceof Promise ? out.then(done) : Promise.resolve().then(done);
}

// Minimal drizzle-shaped stub: captures the .set() payload and hands back a row from .returning().
//
// unpublishBlogPost now issues TWO updates — the Swan Index withdrawal first, then blog_posts — so
// `calls.set` is the blog_posts payload only because it is the LAST one written. `rowsPerUpdate`
// controls what .returning() yields, which is how withdrawFromSwanIndex reports whether it actually
// moved a row; 0 models a post that was never syndicated to the magazine.
function stubDb(rowsPerUpdate = 1) {
    const calls: { set?: Record<string, unknown>; sets: Record<string, unknown>[] } = { sets: [] };
    const db = {
        update() { return this; },
        set(values: Record<string, unknown>) { calls.set = values; calls.sets.push(values); return this; },
        where() { return this; },
        returning() {
            return Promise.resolve(rowsPerUpdate ? [{ ...calls.set, id: 1 }] : []);
        },
    };
    return { db, calls };
}

const publishedPost = {
    id: 1,
    status: 'published',
    slug: 'my-live-post',
    publishedPayload: { html: '<p>hi</p>' },
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    destinations: { widget: 'published', devto: { status: 'published', url: 'https://dev.to/x' } },
} as never;

async function run() {
    await check('flips status to draft and marks the widget copy unpublished', async () => {
        const { db, calls } = stubDb();
        await unpublishBlogPost(db, publishedPost, 7);
        assert.equal(calls.set!.status, 'draft');
        assert.deepEqual(
            (calls.set!.destinations as Record<string, unknown>).widget,
            'unpublished',
        );
    });

    await check('preserves the external targets already recorded in destinations', async () => {
        const { db, calls } = stubDb();
        await unpublishBlogPost(db, publishedPost, 7);
        const dests = calls.set!.destinations as Record<string, unknown>;
        assert.deepEqual(dests.devto, { status: 'published', url: 'https://dev.to/x' });
    });

    // The republish-losslessness guarantee: these fields must be left ALONE, not rewritten.
    await check('never touches slug, publishedPayload or publishedAt', async () => {
        const { db, calls } = stubDb();
        await unpublishBlogPost(db, publishedPost, 7);
        for (const field of ['slug', 'publishedPayload', 'publishedAt']) {
            assert.ok(!(field in calls.set!), `unpublish must not write ${field}`);
        }
    });

    // The Swan Index is FIRST-PARTY, so unlike Dev.to or Ghost it is actually retracted — and the
    // retraction has to be recorded in `destinations`, or stillLiveTargets tells the author their
    // article is still on a masthead we just took it off.
    await check('withdraws the Swan Index copy and records that in destinations', async () => {
        const { db, calls } = stubDb();
        await unpublishBlogPost(db, publishedPost, 7);

        const withdrawal = calls.sets.find((v) => v.status === 'withdrawn');
        assert.ok(withdrawal, 'the magazine row is set to withdrawn');
        assert.equal(withdrawal!.featuredRank, null, 'and gives up its front-page slot');

        const dests = calls.set!.destinations as Record<string, unknown>;
        assert.equal((dests.swanindex as { status: string }).status, 'withdrawn');
        assert.deepEqual(stillLiveTargets(dests), [{ target: 'devto', url: 'https://dev.to/x' }],
            'the magazine must not be reported as still live');
    });

    await check('a post that was never syndicated gets no swanindex entry invented for it', async () => {
        const { db, calls } = stubDb(0);
        await unpublishBlogPost(db, publishedPost, 7);
        assert.ok(!('swanindex' in (calls.set!.destinations as Record<string, unknown>)));
    });

    await check('the blog_posts write is LAST, so a failed withdrawal cannot strand a live copy', async () => {
        const { db, calls } = stubDb();
        await unpublishBlogPost(db, publishedPost, 7);
        assert.equal(calls.sets.length, 2);
        assert.equal(calls.sets[0].status, 'withdrawn', 'magazine first');
        assert.equal(calls.sets[1].status, 'draft', 'blog_posts second');
    });

    await check('stillLive reports external published copies with their url', () => {
        assert.deepEqual(
            stillLiveTargets({ widget: 'published', devto: { status: 'published', url: 'https://dev.to/x' } }),
            [{ target: 'devto', url: 'https://dev.to/x' }],
        );
    });

    await check('stillLive never reports the widget (that IS the native copy being retracted)', () => {
        assert.deepEqual(stillLiveTargets({ widget: 'published' }), []);
    });

    await check('stillLive ignores targets that are not live', () => {
        assert.deepEqual(stillLiveTargets({
            devto: { status: 'draft', url: 'https://dev.to/d' },
            ghost: { status: 'error', error: 'nope' },
            hashnode: { status: 'not_connected' },
        }), []);
    });

    await check('stillLive tolerates an empty/absent destinations blob', () => {
        assert.deepEqual(stillLiveTargets({}), []);
        assert.deepEqual(stillLiveTargets(null), []);
        assert.deepEqual(stillLiveTargets(undefined), []);
    });

    await check('stillLive omits url when the adapter never recorded one', () => {
        assert.deepEqual(stillLiveTargets({ devto: { status: 'published' } }), [{ target: 'devto' }]);
    });

    console.log(`\n${passed} checks passed`);
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
