// netlify/functions/music-library.ts
// The curated music library, as the Sound layer sees it.
//
//   POST { action: 'list', q?, tag? }            → the tracks this workspace may use, with previews
//   POST { action: 'select', postId, trackId }   → an audio asset for this workspace, ready to time
//
// ── Why a track is not simply "an asset" ────────────────────────────────────────────────────────
// One object in R2, licensed once, shared by every workspace. But audio_overlays point at
// content_assets.id, and resolveAudioTracks (src/lib/post-render.ts) selects those rows scoped to
// the organisation — a hard tenant check, deliberately, because the renderer runs with full R2
// credentials and no tenant context.
//
// So 'select' gives the workspace its OWN content_assets row pointing at the shared object. The
// bytes are not copied; the row is the workspace's permission to reference them. That keeps the
// renderer's tenant check honest and means a library track times, fades and renders exactly like an
// uploaded voice note, through code that knows nothing about the library.
//
// ── Attribution ─────────────────────────────────────────────────────────────────────────────────
// ⚠️ A track whose licence demands a credit is NOT offered, because nothing here surfaces a credit
// in a caption yet. Offering it and hoping is how a licence gets breached on a customer's account —
// and unlike a Pexels credit, which this product offers as a courtesy, that one is a condition of
// use. When credit-surfacing exists, this is the one line that changes.

import { HandlerEvent } from '@netlify/functions';
import { and, eq, desc } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { musicTracks, contentAssets, scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { presignR2Get } from '../../src/utils/social-publish';
import { toTrack, usableTracks, offerableTo, type MusicTrack } from '../../src/lib/music-library';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/**
 * Long enough to browse and audition, short enough that a copied link is not a distribution channel
 * for a file we paid to licence. The renderer presigns for an hour because it streams across a whole
 * encode; a person clicking about in a picker does not.
 */
const PREVIEW_TTL_SEC = 900;

/** The provider name on a content_assets row that points at the library. */
const LIBRARY_PROVIDER = 'library';

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const tenant = await requireTenant(event, db);
    if ('error' in tenant) return tenant.error;

    let body: { action?: string; q?: string; tag?: string; postId?: number; trackId?: number };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    try {
        if (body.action === 'select') return await select(db, tenant.organisationId, tenant.userId, body);
        return await list(db, body);
    } catch (err: any) {
        console.error('[music-library] error:', err);
        return json(500, { error: 'The music library is unavailable right now.' });
    }
});

/**
 * What this workspace may use, newest first.
 *
 * The whole library is read and then filtered in the module rather than in SQL. That is deliberate
 * while the library is a curated few dozen: the rules about expiry and attribution live in one pure,
 * tested place, and a WHERE clause that duplicated them would be a second answer to "may we offer
 * this" — which is exactly how a licence gets breached quietly. If it ever grows past a few hundred,
 * the offerable index is already there for a SQL-side filter.
 */
async function list(db: ReturnType<typeof getDb>, body: { q?: string; tag?: string }) {
    const rows = await db.select().from(musicTracks).orderBy(desc(musicTracks.createdAt));

    const tracks = rows
        .map((r) => toTrack({
            id: r.id, title: r.title, artist: r.artist, storageKey: r.storageKey,
            durationS: r.durationS, tags: r.tags, isActive: r.isActive,
            licence: {
                name: r.licenceName, termsUrl: r.licenceTermsUrl ?? undefined,
                attributionRequired: r.attributionRequired,
                attributionText: r.attributionText ?? undefined,
                expiresAt: r.licenceExpiresAt ?? undefined,
            },
        }))
        .filter((t): t is MusicTrack => t !== null);

    // ⚠️ creditsEnabled: false — see the header. Nothing surfaces a required credit in a caption yet,
    // so a track that demands one is not offered rather than offered with a warning.
    const usable = offerableTo(usableTracks(tracks, new Date()), { creditsEnabled: false });

    const q = (body.q || '').trim().toLowerCase();
    const tag = (body.tag || '').trim().toLowerCase();
    const matched = usable.filter((t) => {
        if (tag && !t.tags.includes(tag)) return false;
        if (!q) return true;
        return t.title.toLowerCase().includes(q)
            || t.artist.toLowerCase().includes(q)
            || t.tags.some((x) => x.includes(q));
    });

    // Every mood in the OFFERABLE set, so the filter chips can never show a tag that yields nothing.
    const tags = [...new Set(usable.flatMap((t) => t.tags))].sort();

    const out = await Promise.all(matched.map(async (t) => ({
        id: t.id, title: t.title, artist: t.artist, durationS: t.durationS, tags: t.tags,
        // A failed presign loses the audition, not the track — the picker shows it without a preview
        // rather than hiding a bed the workspace is entitled to use.
        previewUrl: await presignR2Get(t.storageKey, PREVIEW_TTL_SEC).catch(() => null),
    })));

    return json(200, { tracks: out, tags });
}

/**
 * Give this workspace an asset row for a track, and hand back what the Sound layer needs.
 *
 * ⚠️ Find-or-create, keyed on (organisation, provider, providerAssetId). Using the same bed on four
 * posts must not make four content_assets rows: they would all point at one object, and deleting any
 * one of them would look like it should remove the file.
 */
async function select(
    db: ReturnType<typeof getDb>, organisationId: number, userId: number,
    body: { postId?: number; trackId?: number },
) {
    const trackId = Number(body.trackId);
    const postId = Number(body.postId);
    if (!Number.isInteger(trackId) || trackId <= 0) return json(400, { error: 'trackId required.' });

    // The post is checked even though nothing is written to it: a caller that cannot name a post in
    // this workspace has no business minting an asset in it.
    if (Number.isInteger(postId) && postId > 0) {
        const [post] = await db.select({ id: scheduledPosts.id })
            .from(scheduledPosts)
            .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, organisationId)))
            .limit(1);
        if (!post) return json(404, { error: 'Post not found.' });
    }

    const [row] = await db.select().from(musicTracks).where(eq(musicTracks.id, trackId)).limit(1);
    const track = row && toTrack({
        id: row.id, title: row.title, artist: row.artist, storageKey: row.storageKey,
        durationS: row.durationS, tags: row.tags, isActive: row.isActive,
        licence: {
            name: row.licenceName, termsUrl: row.licenceTermsUrl ?? undefined,
            attributionRequired: row.attributionRequired,
            attributionText: row.attributionText ?? undefined,
            expiresAt: row.licenceExpiresAt ?? undefined,
        },
    });
    if (!track) return json(404, { error: 'That track is not in the library.' });

    // ⚠️ Re-checked HERE, not just in `list`. The picker's list may be minutes old, and a licence that
    // lapsed or a track we withdrew in between must not be attachable because it was on screen when
    // the page loaded.
    const [ok] = offerableTo(usableTracks([track], new Date()), { creditsEnabled: false });
    if (!ok) return json(409, { error: 'That track is no longer available. Refresh the list and pick another.' });

    const [existing] = await db.select({ id: contentAssets.id, name: contentAssets.name })
        .from(contentAssets)
        .where(and(
            eq(contentAssets.organisationId, organisationId),
            eq(contentAssets.provider, LIBRARY_PROVIDER),
            eq(contentAssets.providerAssetId, String(track.id)),
        ))
        .limit(1);

    let assetId = existing?.id ?? null;
    if (!assetId) {
        const [made] = await db.insert(contentAssets).values({
            userId,
            organisationId,
            name: `${track.title} — ${track.artist}`,
            assetType: 'audio',
            durationS: track.durationS,
            // The shared object. NOT copied per workspace: this row is the workspace's permission to
            // reference it, which is what keeps the renderer's tenant check meaningful.
            storageKey: track.storageKey,
            provider: LIBRARY_PROVIDER,
            providerAssetId: String(track.id),
            attributionName: track.artist,
            status: 'pending',
        }).returning({ id: contentAssets.id });
        assetId = made.id;
    }

    return json(200, {
        assetId,
        name: `${track.title} — ${track.artist}`,
        label: track.title,
        durationS: track.durationS,
        url: await presignR2Get(track.storageKey, PREVIEW_TTL_SEC).catch(() => null),
    });
}
