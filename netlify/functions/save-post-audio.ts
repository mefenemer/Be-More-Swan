// netlify/functions/save-post-audio.ts
// Persist the timed-audio arrangement for a post — voice notes and sound, placed like text.
//
// POST { postId, audio: [{ id, assetId, label?, startS?, endS?, volume, fadeInS?, fadeOutS? }] }
//   → { ok, count, needsRender }
//   Auth: aura_session (requireTenant). The post AND every audio asset must belong to the caller's org.
//
// Stores the design only — nothing is mixed here. The audio is combined with the media by Remotion
// at approval time, exactly as text overlays are, which is what keeps the browser preview and the
// published file in step.
//
// `needsRender` tells the client that approving this post will now go through a server-side render
// even if it is a PHOTO post: no platform accepts a still image with sound, so the only way to
// publish one is to render the image and audio together into an mp4. Worth surfacing in the editor
// rather than surprising someone at approval.

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, contentAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { sanitiseAudioOverlays, needsVideoRender } from '../../src/lib/audio-overlays';
import { renderableOverlays } from '../../src/lib/post-render';
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

    let body: { postId?: number; audio?: unknown };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return json(400, { error: 'postId required.' });

    const audio = sanitiseAudioOverlays(body.audio);
    if (audio === null) return json(422, { error: 'Invalid audio payload.' });

    const [post] = await db
        .select({
            id: scheduledPosts.id,
            imageOverlays: scheduledPosts.imageOverlays,
            contentAssetIds: scheduledPosts.contentAssetIds,
        })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return json(404, { error: 'Post not found.' });

    // Every referenced asset must be this org's, and must actually be audio. Without this check a
    // caller could point a post at another tenant's asset id and have the renderer — which runs with
    // full R2 credentials and no tenant context — happily fetch and publish it.
    const ids = [...new Set(audio.map(a => a.assetId))];
    if (ids.length) {
        const rows = await db
            .select({ id: contentAssets.id, assetType: contentAssets.assetType })
            .from(contentAssets)
            .where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, orgId)));
        const usable = new Set(rows.filter(r => (r.assetType ?? '').toLowerCase() === 'audio').map(r => r.id));
        const bad = ids.filter(id => !usable.has(id));
        if (bad.length) return json(422, { error: 'One of those audio clips isn’t available on this workspace.' });
    }

    await db.update(scheduledPosts)
        .set({ audioOverlays: audio, updatedAt: new Date() })
        .where(eq(scheduledPosts.id, postId));

    // Does approving this now require a render? Text alone only forces one on a video; audio forces
    // one on anything. The client uses this to warn before the reviewer commits.
    const assetIds = Array.isArray(post.contentAssetIds) ? (post.contentAssetIds as number[]) : [];
    let hasVideo = false;
    if (assetIds.length) {
        const rows = await db
            .select({ assetType: contentAssets.assetType })
            .from(contentAssets)
            .where(inArray(contentAssets.id, assetIds));
        hasVideo = rows.some(r => (r.assetType ?? '').toLowerCase() === 'video');
    }

    return json(200, {
        ok: true,
        count: audio.length,
        needsRender: needsVideoRender({
            hasVideo,
            textOverlays: renderableOverlays(post.imageOverlays).length,
            audioOverlays: audio.length,
        }),
    });
});
