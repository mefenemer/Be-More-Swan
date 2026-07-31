// netlify/functions/set-post-platforms.ts
// Change which platforms a draft goes out on, from the post editor's left pane.
//
// POST { postId, platforms: ['instagram','linkedin'] } → { anchorId, posts: [{ id, platform }] }
//   Auth: aura_session (requireTenant). Every row touched must belong to the caller's org.
//
// ── Why this is not a checkbox ──────────────────────────────────────────────────────────────────
// A "post" that goes to three platforms is THREE scheduled_posts rows sharing a crosspost_group_id —
// each with its own caption, format, media and overlays, because each platform's rules differ. So
// ticking LinkedIn genuinely has to CREATE a row (seeded from the one you are editing), and unticking
// it has to DELETE one. There is no field to toggle.
//
// ── What it refuses to do ───────────────────────────────────────────────────────────────────────
// Only rows still being worked on ('draft', 'pending_approval', 'in_review') are ever created or
// destroyed. Unticking a platform whose post is already approved, scheduled or published does NOT
// delete it — that post is a commitment, and silently removing it from the editor's platform picker
// would be a way to lose scheduled work with no warning and no undo. Those platforms are reported
// back as `locked` so the editor can show them as unchangeable rather than pretend the change stuck.

import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, scheduledPostAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { collectPostAssetIds, releaseAssets } from '../../src/utils/release-post-media';
import { SOCIAL_PLATFORMS, platformFormat } from '../../src/config/platform-formats';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** Statuses whose rows may still be created or destroyed by editing the platform list. */
const MUTABLE = ['draft', 'pending_approval', 'in_review'];

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    let body: { postId?: number; platforms?: unknown };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return json(400, { error: 'postId required.' });

    const wanted = Array.isArray(body.platforms)
        ? [...new Set(body.platforms.filter((p): p is string => typeof p === 'string'))]
        : [];
    if (!wanted.length) return json(400, { error: 'Pick at least one platform.' });
    const unknown = wanted.filter(p => !(SOCIAL_PLATFORMS as string[]).includes(p));
    if (unknown.length) return json(422, { error: `Unsupported platform: ${unknown.join(', ')}.` });

    const [anchor] = await db.select().from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!anchor) return json(404, { error: 'Post not found.' });

    // The whole sibling set. A post that has never been cross-posted has no group id, so it is its
    // own group of one — and gains a group id the moment a second platform is added.
    const groupId = anchor.crosspostGroupId;
    const siblings = groupId
        ? await db.select().from(scheduledPosts)
            .where(and(eq(scheduledPosts.crosspostGroupId, groupId), eq(scheduledPosts.organisationId, orgId)))
        : [anchor];

    const byPlatform = new Map(siblings.map(s => [s.platform, s]));
    const locked: string[] = [];

    // ── Remove ──────────────────────────────────────────────────────────────────────────────────
    const toDelete = siblings.filter(s => s.platform && !wanted.includes(s.platform));
    const deletable = toDelete.filter(s => MUTABLE.includes(s.status));
    for (const s of toDelete) if (!MUTABLE.includes(s.status)) locked.push(s.platform!);
    // Media of the rows about to go. Collected BEFORE the delete because scheduled_post_assets is
    // destroyed with them (explicitly on the next line, and by cascade anyway), and afterwards there
    // is no way left to discover which assets they held. Released at the very END of this handler —
    // see the release step below for why it cannot happen here.
    const deletedPostIds = deletable.map(s => s.id);
    let orphanedAssetIds: number[] = [];
    if (deletedPostIds.length) {
        try {
            orphanedAssetIds = await collectPostAssetIds(db, deletedPostIds);
        } catch (err) {
            console.error('[set-post-platforms] could not collect media of removed siblings (their R2 objects may leak):', err);
        }
    }

    if (deletable.length) {
        const ids = deletable.map(s => s.id);
        await db.delete(scheduledPostAssets).where(inArray(scheduledPostAssets.scheduledPostId, ids));
        await db.delete(scheduledPosts).where(inArray(scheduledPosts.id, ids));
    }

    // ── Add ─────────────────────────────────────────────────────────────────────────────────────
    // A new sibling is a COPY of the post being edited: same words, same media, same design. That is
    // what "also post this to LinkedIn" means — starting it blank would throw away the work the user
    // did before they decided to cross-post.
    const toAdd = wanted.filter(p => !byPlatform.has(p));
    const survivors = siblings.filter(s => s.platform && wanted.includes(s.platform) );
    const willSpanMany = survivors.length + toAdd.length > 1;
    const sharedGroupId = groupId ?? (willSpanMany ? randomUUID() : null);

    for (const platform of toAdd) {
        // The format is per-platform, so a copied post cannot keep the anchor's format key — an
        // ig_reel key on a LinkedIn row names a format that platform does not have.
        const [made] = await db.insert(scheduledPosts).values({
            userId,
            organisationId: orgId,
            assistantId: anchor.assistantId,
            platform,
            postFormat: anchor.postFormat ?? platformFormat(platform).defaultPostFormat,
            formatKey: null,
            publishDate: anchor.publishDate,
            caption: anchor.caption,
            hashtags: anchor.hashtags,
            contentAssetIds: anchor.contentAssetIds,
            imageOverlays: anchor.imageOverlays,
            audioOverlays: anchor.audioOverlays,
            status: anchor.status,
            triggerType: anchor.triggerType ?? 'manual',
            isAutonomous: false,
            ownerId: anchor.ownerId ?? userId,
            ownerLabel: anchor.ownerLabel,
            generatedAt: anchor.generatedAt ?? new Date(),
            crosspostGroupId: sharedGroupId,
        }).returning({ id: scheduledPosts.id });

        // Mirror the junction rows too — scheduled_post_assets is the source of truth for newer
        // queries, and a sibling with media in the legacy column but no junction rows renders
        // correctly in the editor and then resolves nothing at publish time.
        const assetIds = Array.isArray(anchor.contentAssetIds) ? anchor.contentAssetIds as number[] : [];
        if (assetIds.length) {
            await db.insert(scheduledPostAssets)
                .values(assetIds.map((contentAssetId, position) => ({
                    scheduledPostId: made.id, contentAssetId, position,
                })))
                .onConflictDoNothing();
        }
    }

    // Keep the surviving rows in the same group — including the anchor, which may have had no group
    // id until this call added a second platform.
    if (sharedGroupId && sharedGroupId !== groupId) {
        const ids = survivors.map(s => s.id);
        if (ids.length) {
            await db.update(scheduledPosts)
                .set({ crosspostGroupId: sharedGroupId, updatedAt: new Date() })
                .where(inArray(scheduledPosts.id, ids));
        }
    }

    // ── Release the media of the rows we removed ────────────────────────────────────────────────
    // Deliberately the LAST thing this handler does, and deliberately not releasePostMedia().
    //
    // Unticking a platform normally takes away a row whose picture the other siblings still use, and
    // releaseAssets skips anything a surviving post references — so in the common case this releases
    // nothing, which is correct. What it does catch is media only the removed row held: save-post-
    // overlays bakes its flattened image as a NEW asset attached to that ONE post, so deleting the
    // sibling used to strand those bytes in R2 forever.
    //
    // It has to run here rather than next to the delete because the additions above COPY the anchor's
    // contentAssetIds. Released before they exist, a shared asset would look unreferenced and get a
    // 7-day purge clock while a live post depended on it — deleting the user's picture out from under
    // a scheduled post, which is worse than the leak. By now the new rows are in place and count as
    // surviving references. The deleted posts are already gone, so no exclusion list is needed.
    //
    // Best-effort and logged, never swallowed: the platform change is already committed and must
    // stand, but a silent catch is exactly how this class of bug stayed invisible for so long.
    if (orphanedAssetIds.length) {
        try {
            const released = await releaseAssets(db, orphanedAssetIds);
            if (released) console.log(`[set-post-platforms] released ${released} asset(s) held only by removed sibling(s)`);
        } catch (err) {
            console.error('[set-post-platforms] media release failed (platform change still stands):', err);
        }
    }

    const finalRows = sharedGroupId
        ? await db.select({ id: scheduledPosts.id, platform: scheduledPosts.platform })
            .from(scheduledPosts)
            .where(and(eq(scheduledPosts.crosspostGroupId, sharedGroupId), eq(scheduledPosts.organisationId, orgId)))
        : await db.select({ id: scheduledPosts.id, platform: scheduledPosts.platform })
            .from(scheduledPosts)
            .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)));

    // The anchor may itself have been deleted (the user unticked the platform they were looking at),
    // so tell the client which post to open now rather than leaving it pointing at a dead id.
    const anchorStillThere = finalRows.some(r => r.id === postId);
    return json(200, {
        ok: true,
        anchorId: anchorStillThere ? postId : (finalRows[0]?.id ?? null),
        posts: finalRows,
        ...(locked.length ? { locked } : {}),
    });
});
