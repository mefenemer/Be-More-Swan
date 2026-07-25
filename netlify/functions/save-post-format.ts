// netlify/functions/save-post-format.ts
// Record which POST FORMAT a draft is being written for — 'ig_reel', 'li_document', 'x_poll'…
// Catalogue and rules: src/config/post-formats.ts.
//
// POST { postId, formatKey } → { ok, formatKey, schedulable, blockedReason }
//   Auth: aura_session (requireTenant). The post must belong to the caller's org.
//
// An unavailable format is SAVED, not refused. The user is allowed to plan a carousel before we can
// publish one — the editor lays itself out for it and says plainly that it can't go out yet. The
// gate lives at approval (approve-post's FORMAT_NOT_SCHEDULABLE), which is the last point before a
// post enters the queue and therefore the only one that has to be right. Refusing the save instead
// would mean the picker silently discarded a choice the user could see themselves making.
//
// The format must belong to the post's own platform: 'ig_reel' on a LinkedIn post would misconfigure
// the editor and mean nothing to the publisher.

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { postFormatSpec, formatBlockedReason } from '../../src/config/post-formats';
import { withLambda } from '@netlify/aws-lambda-compat';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    let body: { postId?: number; formatKey?: string | null };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return json(400, { error: 'postId required.' });

    const [post] = await db
        .select({ id: scheduledPosts.id, platform: scheduledPosts.platform })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return json(404, { error: 'Post not found.' });

    // Clearing the format is legitimate — it returns the post to legacy behaviour.
    const key = body.formatKey ? String(body.formatKey) : null;
    if (key) {
        const spec = postFormatSpec(key);
        if (!spec) return json(422, { error: 'Unknown post format.' });
        const platform = post.platform === 'twitter' ? 'x' : post.platform;
        if (spec.platform !== platform) {
            return json(422, { error: `“${spec.label}” is a ${spec.platform} format — this post goes to ${platform}.` });
        }
    }

    await db.update(scheduledPosts)
        .set({ formatKey: key, updatedAt: new Date() })
        .where(eq(scheduledPosts.id, postId));

    return json(200, {
        ok: true,
        formatKey: key,
        schedulable: !formatBlockedReason(key),
        blockedReason: formatBlockedReason(key),
    });
});
