// netlify/functions/publish-blog-posts.ts
// Autonomous Content Engine — US 4.1: publish due scheduled blog posts.
//
// Runs on a schedule (netlify.toml, every 5 min). Claims posts whose publish_date has passed,
// flips each to 'publishing', then delegates to the shared publishBlogPost core. A crashed tick
// can strand a row in 'publishing'; those are self-healed back to 'scheduled' on the next run.
// No external APIs — publishing a blog is a local DB snapshot, so no per-platform retry/backoff.

import { Handler } from '@netlify/functions';
import { and, eq, lte, lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { publishBlogPost } from '../../src/utils/blog-publish';

const BATCH = 50;
const STALE_PUBLISHING_MINS = 15;

export const handler: Handler = async () => {
    const db = getDb();
    const now = new Date();
    let claimed = 0, published = 0, failed = 0;

    // Self-heal: reclaim posts stranded in 'publishing' by an earlier crashed/timed-out tick.
    const staleBefore = new Date(now.getTime() - STALE_PUBLISHING_MINS * 60 * 1000);
    await db.update(blogPosts)
        .set({ status: 'scheduled', updatedAt: now })
        .where(and(eq(blogPosts.status, 'publishing'), lt(blogPosts.updatedAt, staleBefore)));

    // Find due posts. Each is then claimed with a status-guarded update so overlapping ticks
    // (or a manual publish landing at the same moment) can't double-publish.
    const due = await db
        .select({ id: blogPosts.id })
        .from(blogPosts)
        .where(and(eq(blogPosts.status, 'scheduled'), lte(blogPosts.publishDate, now)))
        .limit(BATCH);

    for (const { id } of due) {
        const [post] = await db
            .update(blogPosts)
            .set({ status: 'publishing', updatedAt: new Date() })
            .where(and(eq(blogPosts.id, id), eq(blogPosts.status, 'scheduled')))
            .returning();
        if (!post) continue; // another tick claimed it first
        claimed++;

        try {
            if (!post.bodyMarkdown || !post.bodyMarkdown.trim()) {
                // An empty scheduled post can't be rendered — park it as failed rather than loop.
                await db.update(blogPosts).set({ status: 'failed', updatedAt: new Date() }).where(eq(blogPosts.id, id));
                failed++;
                continue;
            }
            await publishBlogPost(db, post, post.organisationId);
            published++;
        } catch (err) {
            console.error(`[publish-blog-posts] post ${id} failed:`, err);
            await db.update(blogPosts).set({ status: 'failed', updatedAt: new Date() }).where(eq(blogPosts.id, id));
            failed++;
        }
    }

    return { statusCode: 200, body: JSON.stringify({ due: due.length, claimed, published, failed }) };
};
