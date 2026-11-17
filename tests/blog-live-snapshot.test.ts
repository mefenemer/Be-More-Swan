// tests/blog-live-snapshot.test.ts
// An edit to a LIVE blog article reaches the blog (src/utils/blog-publish.ts refreshLiveSnapshot).
//
// The bug (2026-11-17, kudzucollab.com): every reader-facing surface serves blog_posts.published_payload,
// and only publishBlogPost wrote it. A customer changed the pictures on published articles; the Studio
// said "Saved", chat said "live on your blog now", and the blog kept the old pictures for ever.
// Before the fix refreshLiveSnapshot did not exist and nothing in save-blog-draft / blog-media touched
// the live copy — every check below fails on that code.
// Run:  npx tsx tests/blog-live-snapshot.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { refreshLiveSnapshot } from '../src/utils/blog-publish';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
}

// drizzle-shaped stub. Each select…limit() takes the next queued result (post row, then asset row);
// update…returning() records the .set() payload and yields `updateRows`.
function stubDb(selects: unknown[][], updateRows = 1) {
    const queue = [...selects];
    const calls: { sets: Record<string, unknown>[] } = { sets: [] };
    const db = {
        select() {
            const q = {
                from() { return q; },
                where() { return q; },
                limit() { return Promise.resolve(queue.shift() ?? []); },
            };
            return q;
        },
        update() {
            const u = {
                set(values: Record<string, unknown>) { calls.sets.push(values); return u; },
                where() { return u; },
                returning() { return Promise.resolve(Array.from({ length: updateRows }, () => ({ id: 5 }))); },
            };
            return u;
        },
    };
    return { db, calls };
}

const livePost = {
    title: 'Spring planting', bodyMarkdown: 'Hello **garden**.\n\n![A new bed](asset://902)',
    metaTitle: null, metaDescription: null, tags: ['garden'], featureAssetId: 901,
};
const newPicture = { id: 901, name: 'New hero', attributionName: null };

async function run() {
    await check('a live post gets a rebuilt copy carrying the NEW feature picture and body', async () => {
        const { db, calls } = stubDb([[livePost], [newPicture]]);
        assert.equal(await refreshLiveSnapshot(db, 7, 5), true);
        assert.equal(calls.sets.length, 1);
        const payload = calls.sets[0].publishedPayload as Record<string, any>;
        assert.equal(payload.featureImage.assetId, 901);
        assert.equal(payload.title, 'Spring planting');
        assert.match(payload.html, /garden/);
        assert.deepEqual(payload.tags, ['garden']);
    });

    await check('the list thumbnail follows the new copy (card image columns written)', async () => {
        const { db, calls } = stubDb([[livePost], [newPicture]]);
        await refreshLiveSnapshot(db, 7, 5);
        const keys = Object.keys(calls.sets[0]).filter((k) => k !== 'publishedPayload');
        assert.ok(keys.length >= 1, 'cardImageColumns must be written beside the payload');
    });

    await check('a removed feature picture is removed from the live copy too', async () => {
        const { db, calls } = stubDb([[{ ...livePost, featureAssetId: null }]]);
        await refreshLiveSnapshot(db, 7, 5);
        assert.equal((calls.sets[0].publishedPayload as Record<string, any>).featureImage, null);
    });

    await check('not a republish: status, slug, publishedAt, destinations and provenance untouched', async () => {
        const { db, calls } = stubDb([[livePost], [newPicture]]);
        await refreshLiveSnapshot(db, 7, 5);
        for (const field of ['status', 'slug', 'publishedAt', 'destinations', 'provenanceContentId', 'canonicalUrl']) {
            assert.ok(!(field in calls.sets[0]), `refresh must not write ${field}`);
        }
    });

    await check('a post that is not live is left alone and reports false', async () => {
        const { db, calls } = stubDb([[]]);
        assert.equal(await refreshLiveSnapshot(db, 7, 5), false);
        assert.equal(calls.sets.length, 0);
    });

    await check('unpublished between read and write → false (the guarded update moved nothing)', async () => {
        const { db } = stubDb([[livePost], [newPicture]], 0);
        assert.equal(await refreshLiveSnapshot(db, 7, 5), false);
    });

    // The two endpoints that change a live article from the Studio.
    const save = readFileSync('netlify/functions/save-blog-draft.ts', 'utf8');
    const media = readFileSync('netlify/functions/blog-media.ts', 'utf8');
    const studio = readFileSync('src/components/blog-studio-modal.js', 'utf8');

    await check('save-blog-draft rebuilds the live copy for body/title/keywords/SEO edits and says so', () => {
        assert.ok(save.includes('refreshLiveSnapshot(db, ctx.organisationId, updated.id)'));
        assert.match(save, /LIVE_FIELDS = \['title', 'bodyMarkdown', 'tags', 'metaTitle', 'metaDescription'\]/);
        assert.ok(save.includes('ok: true, live,'), 'response must carry live');
    });

    await check('blog-media rebuilds the live copy on feature attach AND detach', () => {
        const hits = media.split("role === 'feature' ? await refreshLive(db, orgId, blogPostId) : false").length - 1;
        assert.equal(hits, 2);
    });

    await check('the publish module is loaded lazily (no cold-start cost on every autosave)', () => {
        for (const src of [save, media]) {
            assert.ok(!/^import .*blog-publish/m.test(src), 'no static import of blog-publish');
            assert.ok(src.includes("await import('../../src/utils/blog-publish')"));
        }
    });

    await check('the Studio tells the author a live change reaches readers', () => {
        assert.ok(studio.includes("state.postStatus === 'published' ? LIVE_SAVED : 'Saved'"));
        assert.ok(studio.includes("res.body.live ? 'Set as the feature image. ' + LIVE_DELAY"));
        assert.ok(!studio.includes('and live on your blog now'), 'old over-promise gone');
    });

    console.log(`\n${passed} passed`);
}

run().catch((err) => { console.error(err); process.exit(1); });
